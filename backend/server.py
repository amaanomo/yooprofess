"""
Minimal Orbit backend for local testing.

    export ANTHROPIC_API_KEY=sk-ant-...   # for Claude (default)
    export ORBIT_PROVIDER=gemini          # switch to Gemini
    export GOOGLE_API_KEY=...             # required when using Gemini
    python3 backend/server.py

Endpoints (see the "Backend contract" in extension/content.js):
  POST /lectures  store the full caption list for a lecture
  POST /ask       answer the question, then say which part of the lecture to watch
"""
import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROVIDER = os.environ.get("ORBIT_PROVIDER", "anthropic")  # provider for /ask

# Whiteboard lessons (/explain). Uses Gemini's free tier when a Gemini key is available, otherwise Claude Haiku.
# Force one with ORBIT_EXPLAIN_PROVIDER=gemini|anthropic.
EXPLAIN_MODEL = os.environ.get("ORBIT_EXPLAIN_MODEL", "claude-haiku-5-5")  # cheap Claude model for whiteboard plans
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
GEMINI_FALLBACK_MODEL = os.environ.get("GEMINI_FALLBACK_MODEL", "gemini-3.5-flash")  # tried if the first fails
GEMINI_KEY = os.environ.get("GEMINI_API_KEY") or (os.environ.get("GOOGLE_API_KEY") if PROVIDER == "gemini" else None)
EXPLAIN_PROVIDER = os.environ.get("ORBIT_EXPLAIN_PROVIDER") or ("gemini" if GEMINI_KEY else "anthropic")
PORT = int(os.environ.get("PORT", "8000"))

if PROVIDER == "gemini":
    import google.generativeai as genai
    genai.configure(api_key=os.environ.get("GOOGLE_API_KEY"))
    MODEL = os.environ.get("ORBIT_MODEL", "gemini-2.0-flash")
else:
    import anthropic
    client = anthropic.Anthropic()
    MODEL = os.environ.get("ORBIT_MODEL", "claude-sonnet-4-6")

LECTURES = {}  # lecture_id -> {"title": str, "captions": [...]}

SYSTEM = """You are Orbit, an expert tutor following along with a recorded lecture. Answer like a professor who knows the field thoroughly.

Format rules:
- Use **In this lecture:** and **More broadly:** as bold section labels
- Bold and italicize key terms like ***chain of thought*** or ***few-shot prompting***
- Keep each section to 1-2 sentences — be concise and direct

Structure every answer as:
**In this lecture:** [what the professor covered, grounded in the transcript]
**More broadly:** [deeper knowledge, context, or examples beyond the lecture]

End with a line starting "Watch:" as a time range in M:SS (or H:MM:SS) from the transcript, plus a short description, e.g. "Watch: 12:33-14:08, where the professor explains CoT."
If the transcript does not cover the question, skip "In this lecture:" and answer from your full knowledge, omitting the Watch line.
Never invent timestamps that are not in the transcript."""


def fmt(t):
    t = int(t)
    h, m, s = t // 3600, t % 3600 // 60, t % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def transcript_text(captions):
    # Merge cues into ~15s lines to keep the prompt compact.
    lines, cur_start, cur = [], None, []
    for c in captions:
        if cur_start is None:
            cur_start = c["start"]
        cur.append(c["text"].strip())
        if c["end"] - cur_start >= 15:
            lines.append(f"[{fmt(cur_start)}] {' '.join(cur)}")
            cur_start, cur = None, []
    if cur:
        lines.append(f"[{fmt(cur_start)}] {' '.join(cur)}")
    return "\n".join(lines)


def ask(body):
    lec = LECTURES.get(body.get("lecture_id"))
    if lec:
        transcript = transcript_text(lec["captions"])
        title = lec["title"]
    else:  # server restarted: fall back to the 90s window sent with the question
        transcript = transcript_text(body.get("context") or [])
        title = "(unknown)"
    now = fmt(body.get("current_time") or 0)
    user_msg = (
        f"Lecture: {title}\n\nTranscript:\n{transcript}\n\n"
        f"The student is paused at {now}.\nQuestion: {body.get('question', '')}"
    )
    if PROVIDER == "gemini":
        gmodel = genai.GenerativeModel(MODEL, system_instruction=SYSTEM)
        response = gmodel.generate_content(user_msg)
        return response.text.strip()
    else:
        msg = client.messages.create(
            model=MODEL,
            max_tokens=600,
            system=[{"type": "text", "text": SYSTEM}],
            messages=[{"role": "user", "content": user_msg}],
        )
        return "".join(b.text for b in msg.content if b.type == "text").strip()


EXPLAIN_SYSTEM = """You are Professor Orbit, a patient tutor teaching a concept on a whiteboard to a student who is meeting it for the first time.
Reply with ONLY a JSON object, no prose and no code fences:
{"title": str, "steps": [{"head": str, "say": str, "clear": bool, "draw": [shape, ...]}]}
"head" is a 2-4 word heading for the step (shown in the lesson outline), e.g. "Everyday analogy".

How to teach (this matters most):
- Use plain, friendly language, as if talking to a smart friend. Define any jargon the first time you use it, in a few everyday words.
- Teach ONE idea per step. Never introduce two new terms in the same step.
- Follow this arc: (1) what the concept is in one simple sentence and why it matters; (2) a relatable everyday analogy; (3) the key parts or steps, built up one at a time; (4) a small worked example with concrete, easy numbers or words that the student can follow by hand; (5) a one-line recap, plus a common mistake to avoid if there is one.
- Keep diagrams simple: 2-4 shapes per step, short labels (1-3 words), arrows to show flow. Prefer a concrete picture over abstract boxes. The worked example should be drawn out with the real values.
- Each "say" is 1-3 short sentences, easy to follow when spoken aloud.

Rules:
- 6 to 8 steps. Each step adds 1-4 shapes to the board; earlier shapes stay.
- Build the picture up gradually: shapes from earlier steps STAY on the board, so each step adds to the same diagram. Set "clear": true only when the board is genuinely full or you switch to a completely different diagram, at most twice in a lesson. Most steps must NOT clear. The first step never needs it.
- The board is a 0-100 grid for both x and y (0,0 is top-left). Keep shapes within 5-95.
- Use the whole board so the diagram is big and easy to read. Make boxes large: w=26, h=16.
- NEVER overlap shapes. Lay out on a grid: at most 3 boxes per row, rows at y=20, 45 and 70, columns at x=6, 37 and 68 for boxes of w=26, h=16. Reserve y<12 for a title text. Before adding a shape, make sure that area is empty (account for shapes from earlier steps unless you clear).
- shape = {"type": "box"|"circle"|"arrow"|"line"|"text", "x": n, "y": n, "w": n, "h": n, "to": [x, y], "label": str}
  - box: x,y is top-left, w,h size (typical 22 x 14), label centered inside.
  - circle: x,y is the center, w is the diameter, label centered inside.
  - arrow/line: from x,y to "to"; optional label.
  - text: label placed centered at x,y.
- Keep labels under 25 characters. Draw the concept as a diagram (flow, parts, cycle, comparison), not a wall of text.
- Use the lecture transcript for context when relevant, and connect to what the professor said."""

LEVEL_HINTS = {
    "simpler": (
        "\n\nLEVEL: SIMPLER. The student found the normal explanation too hard. Use even plainer words, lean on "
        "everyday analogies, introduce at most one or two new terms in total, and use smaller steps and smaller numbers."
    ),
    "deeper": (
        "\n\nLEVEL: DEEPER. The student wants more depth. Explain the mechanics (how and why it works), use correct "
        "terminology (defined briefly), cover an edge case or limitation, and make the worked example a bit richer."
    ),
}

FOLLOWUP_SYSTEM = (
    EXPLAIN_SYSTEM
    + """

FOLLOW-UP MODE (overrides the step count and teaching arc above): the student has already seen part of this lesson
and now has a follow-up question. Reply with 2 to 4 NEW steps, in the same JSON format, that answer the question
directly, with exactly 2 to 4 steps in total and no separate recap step. Build on the lesson so far instead of
repeating it. Use a fresh diagram: set "clear": true on the first step only; later steps keep adding to that board.
All the board and shape rules above still apply."""
)

SHAPE_TYPES = {"box", "circle", "arrow", "line", "text"}


def _num(v, default=0.0):
    try:
        return max(0.0, min(100.0, float(v)))
    except (TypeError, ValueError):
        return default


BOARD_H = 62.0  # the client board is 100 x 62 units; plan y/h values are 0-100 and get scaled


def _rect(s):
    """Approximate bounding box (x0, y0, x1, y1) in board units for shapes that can collide, else None."""
    k = BOARD_H / 100.0
    if s["type"] == "box":
        w, h = s["w"] or 20, s["h"] * k or 8
        return (s["x"], s["y"] * k, s["x"] + w, s["y"] * k + h)
    if s["type"] == "circle":
        r = (s["w"] or 12) / 2
        return (s["x"] - r, s["y"] * k - r, s["x"] + r, s["y"] * k + r)
    if s["type"] == "text" and s["label"]:
        hw = len(s["label"]) * 0.52
        return (s["x"] - hw, s["y"] * k - 1.2, s["x"] + hw, s["y"] * k + 1.2)
    return None


def _hits(a, b, pad=0.5):
    return a[0] < b[2] + pad and b[0] < a[2] + pad and a[1] < b[3] + pad and b[1] < a[3] + pad


def clean_plan(raw, max_steps=8):
    """Validate and clamp the model's JSON. Returns a plan dict or None."""
    if not isinstance(raw, dict) or not isinstance(raw.get("steps"), list):
        return None
    steps = []
    board = []  # rects currently on the board (reset whenever a step clears it)
    for st in raw["steps"][:max_steps]:
        if not isinstance(st, dict) or not str(st.get("say", "")).strip():
            continue
        draw = []
        for s in (st.get("draw") or [])[:6]:
            if not isinstance(s, dict) or s.get("type") not in SHAPE_TYPES:
                continue
            shape = {
                "type": s["type"],
                "x": _num(s.get("x"), 50),
                "y": _num(s.get("y"), 50),
                "w": _num(s.get("w"), 0),
                "h": _num(s.get("h"), 0),
                "label": str(s.get("label", ""))[:40],
            }
            to = s.get("to")
            if isinstance(to, list) and len(to) == 2:
                shape["to"] = [_num(to[0]), _num(to[1])]
            draw.append(shape)
        say = str(st["say"]).strip()[:300]
        head = str(st.get("head", "")).strip()[:40] or say[:28].rstrip()
        clear = bool(st.get("clear"))
        new_rects = [r for r in (_rect(s) for s in draw) if r]
        # If this step would draw on top of what is already there, start a fresh board for it.
        if not clear and any(_hits(n, b) for n in new_rects for b in board):
            clear = True
        if clear:
            board = []
        board.extend(new_rects)
        steps.append({"head": head, "say": say, "clear": clear, "draw": draw})
    if not steps:
        return None
    return {"title": str(raw.get("title", ""))[:80], "steps": steps}


def parse_json_loose(text):
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.find("{"):]
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        return None
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None


def get_anthropic():
    """The Anthropic client. It only exists at startup when ORBIT_PROVIDER isn't gemini, so create it on demand."""
    global client
    if "client" not in globals():
        import anthropic

        client = anthropic.Anthropic()
    return client


def generate_plan_text(system, prompt):
    """Ask the whiteboard model for the JSON plan. Gemini (free tier) if configured, else Haiku."""
    if EXPLAIN_PROVIDER == "gemini":
        payload = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "maxOutputTokens": 4000,
                "thinkingConfig": {"thinkingBudget": 0},  # thinking would eat the budget and truncate the JSON
            },
        }
        # Free-tier models sometimes stall or answer 503 "high demand", so try the next model.
        last = "no Gemini model configured"
        for model in dict.fromkeys([GEMINI_MODEL, GEMINI_FALLBACK_MODEL]):
            req = urllib.request.Request(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY or ""},
            )
            try:
                with urllib.request.urlopen(req, timeout=25) as resp:
                    data = json.load(resp)
            except urllib.error.HTTPError as e:
                last = f"{model}: HTTP {e.code} {e.read().decode(errors='replace')[:160]}"
                print("gemini error:", last)
                continue
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                last = f"{model}: {e}"
                print("gemini error:", last)
                continue
            parts = ((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
            text = "".join(p.get("text", "") for p in parts)
            if text.strip():
                return text
            last = f"{model}: empty response"
        raise RuntimeError(f"Gemini unavailable ({last})")

    msg = get_anthropic().messages.create(
        model=EXPLAIN_MODEL,
        max_tokens=3000,
        thinking={"type": "disabled"},  # thinking tokens would eat the budget and truncate the JSON
        system=[{"type": "text", "text": system}],
        messages=[{"role": "user", "content": prompt}],
    )
    return "".join(b.text for b in msg.content if b.type == "text")


def explain(body):
    # Chat replies carry markdown (**bold**, ***terms***); the whiteboard wants plain text.
    body = {**body, "reply": str(body.get("reply") or "").replace("*", "")}
    lec = LECTURES.get(body.get("lecture_id"))
    transcript = transcript_text(lec["captions"]) if lec else "(not available)"
    followup = str(body.get("followup") or "").strip()[:500]
    prompt = (
        f"Lecture: {lec['title'] if lec else '(unknown)'}\n\nTranscript:\n{transcript}\n\n"
        f"The student asked: {body.get('question', '')}\n"
        f"Orbit's short answer was: {body.get('reply', '')}\n\n"
    )
    if followup:
        lesson = body.get("lesson") or []
        done = "\n".join(
            f"{i}. {str(s.get('head', ''))}: {str(s.get('say', ''))}"
            for i, s in enumerate(lesson[:12], 1)
            if isinstance(s, dict)
        )
        prompt += f"Lesson so far:\n{done}\n\nThe student's follow-up question: {followup}\n\nAnswer it on the whiteboard."
        system, max_steps = FOLLOWUP_SYSTEM, 4
    else:
        prompt += "Teach this concept on the whiteboard."
        system, max_steps = EXPLAIN_SYSTEM + LEVEL_HINTS.get(body.get("level"), ""), 8

    for _ in range(2):  # one retry if the model returns bad JSON
        text = generate_plan_text(system, prompt)
        plan = clean_plan(parse_json_loose(text), max_steps)
        if plan:
            return plan
    # Text-only fallback so the dashboard still shows something.
    fallback = str(body.get("reply", ""))[:300] or "Sorry, I couldn't draw this one."
    return {"title": "Explanation", "steps": [{"head": "Explanation", "say": fallback, "clear": False, "draw": []}]}


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        try:
            if self.path == "/lectures":
                LECTURES[body["lecture_id"]] = {
                    "title": body.get("title", ""),
                    "captions": body.get("captions", []),
                }
                print(f"stored {body['lecture_id']} ({len(body.get('captions', []))} cues)")
                return self._send(200, {"ok": True})
            if self.path == "/ask":
                return self._send(200, {"reply": ask(body)})
            if self.path == "/explain":
                return self._send(200, explain(body))
            self._send(404, {"error": "not found"})
        except Exception as e:  # surface errors to the extension
            print("error:", e)
            self._send(500, {"error": str(e)})


if __name__ == "__main__":
    explain_model = GEMINI_MODEL if EXPLAIN_PROVIDER == "gemini" else EXPLAIN_MODEL
    print(
        f"Orbit backend on http://localhost:{PORT} | /ask: {PROVIDER}/{MODEL} | /explain: {EXPLAIN_PROVIDER}/{explain_model}",
        flush=True,
    )
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
