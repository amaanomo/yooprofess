"""
Minimal Orbit backend for local testing.

    export ANTHROPIC_API_KEY=sk-ant-...
    python3 backend/server.py

Endpoints (see the "Backend contract" in extension/content.js):
  POST /lectures   store the full caption list for a lecture
  POST /ask        answer the question, then say which part of the lecture to watch
  POST /translate  translate a batch of caption cues for the subtitle overlay
"""
import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import anthropic

MODEL = os.environ.get("ORBIT_MODEL", "claude-sonnet-5-5")
PORT = int(os.environ.get("PORT", "8000"))
_client = None


def client():
    """Created on first use (reads ANTHROPIC_API_KEY), so the module imports without a key."""
    global _client
    if _client is None:
        _client = anthropic.Anthropic()
    return _client


LECTURES = {}  # lecture_id -> {"title": str, "captions": [...]}
TRANSLATIONS = {}  # (lecture_id, language_code, cue_index) -> translated text. In memory: lost on restart.
MAX_TRANSLATE_CUES = 100

LANGUAGE_NAMES = {
    "es": "Spanish", "zh-Hans": "Simplified Chinese", "hi": "Hindi", "ko": "Korean", "ar": "Arabic",
    "fr": "French", "pt": "Portuguese (Brazil)", "vi": "Vietnamese", "ja": "Japanese",
}

SYSTEM = """You are Orbit, an expert tutor following along with a recorded lecture. You have deep knowledge of the subject — answer like a professor who knows the field thoroughly, not just what appears in this transcript.

When answering:
- Use the lecture transcript to stay grounded in how the professor taught it and to cite exact timestamps.
- Draw freely on your full subject knowledge to give a complete, accurate answer beyond what the lecture alone covers.
- Keep the answer concise (3-6 sentences total), plain text, no markdown.
- When something comes directly from the lecture, note it naturally (e.g. "In this lecture..." or "As the professor explained...").
- When you add knowledge beyond the lecture, note it briefly (e.g. "More broadly..." or "In practice...").

Then end with a line starting "Watch:" naming the specific part of the lecture to look at, as a time range in M:SS (or H:MM:SS) taken from the transcript timestamps, plus a few words on what is covered there, e.g. "Watch: 12:33-14:08, where the professor lists the use cases of CoT."
If the transcript does not cover the question, answer from your full knowledge and omit the Watch line.
Never invent timestamps that are not supported by the transcript."""

TRANSLATE_SYSTEM = """You translate captions from a recorded university lecture into {language} for a student watching it.

You receive a JSON array of caption cues, each {{"i": <index>, "text": <English caption>}}, in playback order.
Return JSON only, no prose and no code fence: {{"translations": [{{"i": <index>, "text": <translation>}}, ...]}}
with exactly one entry per input cue and the same "i" values.

Rules:
- Captions are split mid-sentence. Read the neighbouring cues (and the lecture title) for context so each piece reads naturally,
  but translate each cue's own words into that cue. Never move words from one cue into another, never merge or drop cues.
- Keep each line short enough to read as a subtitle.
- Keep code, identifiers, math, Big-O notation, numbers and proper nouns exactly as written.
- Keep the course's technical terms; the first time a key term appears you may add the English term in parentheses.
- If a cue is only a noise tag like [music] or [inaudible], translate the tag."""


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
    system = SYSTEM
    language = str(body.get("language") or "").strip()
    if language:
        # The extension parses the Watch line, so it must keep its exact English format.
        system += (
            f"\n\nReply in {language}. Keep the final line exactly in the form "
            '"Watch: M:SS-M:SS, <description>" with the word "Watch:" in English; '
            "the description may be in the reply language."
        )
    msg = client().messages.create(
        model=MODEL,
        max_tokens=600,
        system=[{"type": "text", "text": system}],
        messages=[
            {
                "role": "user",
                "content": f"Lecture: {title}\n\nTranscript:\n{transcript}\n\n"
                f"The student is paused at {now}.\nQuestion: {body.get('question', '')}",
            }
        ],
    )
    return "".join(b.text for b in msg.content if b.type == "text").strip()


def _parse_translations(text):
    """Pull {"translations": [...]} out of the model's reply (tolerates a code fence or stray prose)."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return {}
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return {}
    out = {}
    for item in data.get("translations", []) if isinstance(data, dict) else []:
        if isinstance(item, dict) and isinstance(item.get("i"), int) and isinstance(item.get("text"), str):
            out[item["i"]] = item["text"].strip()
    return out


def _model_translate(language, title, cues):
    msg = client().messages.create(
        model=MODEL,
        max_tokens=8000,
        system=[{"type": "text", "text": TRANSLATE_SYSTEM.format(language=language)}],
        messages=[
            {
                "role": "user",
                "content": f"Lecture title: {title or '(unknown)'}\n\nCues:\n"
                + json.dumps([{"i": c["i"], "text": c["text"]} for c in cues], ensure_ascii=False),
            }
        ],
    )
    return _parse_translations("".join(b.text for b in msg.content if b.type == "text"))


class BadRequest(Exception):
    pass


def translate(body, model_translate=_model_translate):
    lecture_id = str(body.get("lecture_id") or "")
    code = str(body.get("target_language") or "")
    cues = body.get("cues") or []
    if not lecture_id or not code or not isinstance(cues, list) or not cues:
        raise BadRequest("lecture_id, target_language and a non-empty cues list are required")
    if len(cues) > MAX_TRANSLATE_CUES:
        raise BadRequest(f"at most {MAX_TRANSLATE_CUES} cues per request")
    if not all(isinstance(c, dict) and isinstance(c.get("i"), int) and isinstance(c.get("text"), str) for c in cues):
        raise BadRequest('each cue needs an integer "i" and a string "text"')

    language = LANGUAGE_NAMES.get(code, code)
    done = {c["i"]: TRANSLATIONS[(lecture_id, code, c["i"])] for c in cues if (lecture_id, code, c["i"]) in TRANSLATIONS}
    todo = [c for c in cues if c["i"] not in done]
    for _attempt in range(2):  # one call, plus one retry for anything the model skipped
        if not todo:
            break
        got = model_translate(language, body.get("title", ""), todo)
        for c in todo:
            if got.get(c["i"]):
                done[c["i"]] = got[c["i"]]
                TRANSLATIONS[(lecture_id, code, c["i"])] = got[c["i"]]
        todo = [c for c in todo if c["i"] not in done]

    out = []
    for c in cues:
        if c["i"] in done:
            out.append({"i": c["i"], "text": done[c["i"]]})
        else:  # still missing after the retry: send the original so the timing stays intact
            out.append({"i": c["i"], "text": c["text"], "fallback": True})
    print(f"translated {lecture_id} -> {code}: {len(cues)} cues ({len(todo)} fallback)")
    return {"translations": out}


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
            if self.path == "/translate":
                return self._send(200, translate(body))
            self._send(404, {"error": "not found"})
        except BadRequest as e:
            self._send(400, {"error": str(e)})
        except Exception as e:  # surface errors to the extension
            print("error:", e)
            self._send(500, {"error": str(e)})


if __name__ == "__main__":
    print(f"Orbit backend on http://localhost:{PORT} using {MODEL}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
