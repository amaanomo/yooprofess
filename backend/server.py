"""
Minimal Orbit backend for local testing.

    export ANTHROPIC_API_KEY=sk-ant-...
    python3 backend/server.py

Endpoints (see the "Backend contract" in extension/content.js):
  POST /lectures  store the full caption list for a lecture
  POST /ask       answer the question, then say which part of the lecture to watch
"""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import anthropic

MODEL = os.environ.get("ORBIT_MODEL", "claude-sonnet-5-5")
PORT = int(os.environ.get("PORT", "8000"))
client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY

LECTURES = {}  # lecture_id -> {"title": str, "captions": [...]}

SYSTEM = """You are Orbit, a tutor that follows along with a recorded lecture.

Answer the student's question directly and clearly first (2-5 sentences, plain text, no markdown).
Use the lecture transcript as your primary source, and add general subject knowledge when it helps.
Then end with a line starting "Watch:" naming the specific part of the lecture to look at,
as a time range in M:SS (or H:MM:SS) taken from the transcript timestamps, plus a few words on what is covered there,
e.g. "Watch: 12:33-14:08, where the professor lists the use cases of CoT."
If the transcript does not cover the question, say so, answer from general knowledge, and omit the Watch line.
Never invent timestamps that are not supported by the transcript."""


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
    msg = client.messages.create(
        model=MODEL,
        max_tokens=600,
        system=[{"type": "text", "text": SYSTEM}],
        messages=[
            {
                "role": "user",
                "content": f"Lecture: {title}\n\nTranscript:\n{transcript}\n\n"
                f"The student is paused at {now}.\nQuestion: {body.get('question', '')}",
            }
        ],
    )
    return "".join(b.text for b in msg.content if b.type == "text").strip()


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
            self._send(404, {"error": "not found"})
        except Exception as e:  # surface errors to the extension
            print("error:", e)
            self._send(500, {"error": str(e)})


if __name__ == "__main__":
    print(f"Orbit backend on http://localhost:{PORT} using {MODEL}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
