"""
Minimal Nova backend.

Uses Gemini or Claude. Pick with NOVA_PROVIDER=gemini|anthropic; if unset, it uses
Gemini when GEMINI_API_KEY (or GOOGLE_API_KEY) is set, otherwise Claude when ANTHROPIC_API_KEY is set.
/ask and /translate use that provider. /explain (whiteboard lessons) has its own settings below.

    export GEMINI_API_KEY=...            # or ANTHROPIC_API_KEY=sk-ant-...
    export ELEVENLABS_API_KEY=...        # Nova's voice (falls back to free Chrome voices without it)
    python3 backend/server.py

Models: GEMINI_MODEL (default gemini-3.5-flash-lite), NOVA_MODEL for Claude (default claude-sonnet-5-5).

Endpoints (see the "Backend contract" in extension/content.js):
  POST /lectures   store the full caption list for a lecture
  POST /ask        answer the question, then say which part of the lecture to watch
  POST /translate  translate a batch of caption cues for the subtitle overlay
  POST /summary    summary, key points and timestamped chapters for a lecture
  POST /explain    whiteboard lesson plan
  GET  /instructor instructor dashboard (needs NOVA_INSTRUCTOR_KEY): lectures, themes, question timeline
  POST /instructor/api/recitation  build a 50-minute recitation plan and email it (see recitation.py for NOVA_SMTP_* and NOVA_RECITATION_EMAIL)
                   POST /topics needs the same key (X-Instructor-Key header): Hot topics is instructor-only
  POST /topics     hot topics: the lecture's most-asked themes (see topics.py; set NOVA_DB_PATH on Railway)
  GET  /voices     built-in ElevenLabs voices (the ones every plan can use)
  POST /tts        {text, voice_id?, language_code?} -> audio/mpeg (ElevenLabs, English only)
  POST /tts/stream same body -> audio/mpeg streamed as it's generated (lower latency)
  POST /transcribe raw audio body -> {text} (ElevenLabs Scribe v2)

ElevenLabs speaks English only (other languages use Chrome voices in the extension).
Settings: ELEVENLABS_TTS_MODEL (default eleven_flash_v2_5), ELEVENLABS_STT_MODEL (default scribe_v2),
ELEVENLABS_DEFAULT_VOICE (default Brian, a built-in voice). A local .env file is loaded if python-dotenv is installed.

/ask also takes "history" (recent chat turns, for follow-ups) and "voice" (the question
was spoken: answer briefly for text-to-speech). The extension uses ElevenLabs when the
server has a key ("auto" engine) and falls back to free Chrome voices otherwise.
"""
import base64
import hmac
import json
import os
import re
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:  # local dev: read keys from .env (Railway sets real env vars)
    from dotenv import load_dotenv

    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))
except ImportError:
    pass

import recitation
import topics as hot_topics

PORT = int(os.environ.get("PORT", "8000"))
# /ask and /translate. (GEMINI_MODEL below is the whiteboard's model.)
CHAT_GEMINI_MODEL = os.environ.get("NOVA_GEMINI_MODEL", "gemini-3.5-flash-lite")
ANTHROPIC_MODEL = os.environ.get("NOVA_MODEL", "claude-sonnet-5-5")


def _pick_provider():
    chosen = os.environ.get("NOVA_PROVIDER", "").strip().lower()
    if chosen in ("gemini", "anthropic"):
        return chosen
    if os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"):
        return "gemini"
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    return "gemini"


PROVIDER = _pick_provider()
MODEL = CHAT_GEMINI_MODEL if PROVIDER == "gemini" else ANTHROPIC_MODEL

# Whiteboard lessons (/explain). Uses Gemini when a Gemini key is available, otherwise Claude Haiku.
# Force one with NOVA_EXPLAIN_PROVIDER=gemini|anthropic.
EXPLAIN_MODEL = os.environ.get("NOVA_EXPLAIN_MODEL", "claude-haiku-5-5")  # cheap Claude model for whiteboard plans
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
GEMINI_FALLBACK_MODEL = os.environ.get("GEMINI_FALLBACK_MODEL", "gemini-3.5-flash")  # tried if the first fails
GEMINI_KEY = os.environ.get("GEMINI_API_KEY") or (os.environ.get("GOOGLE_API_KEY") if PROVIDER == "gemini" else None)
EXPLAIN_PROVIDER = os.environ.get("NOVA_EXPLAIN_PROVIDER") or ("gemini" if GEMINI_KEY else "anthropic")
_chat_client = None


def chat_client():
    """The provider's SDK client, created on first use so the module imports without a key or SDK."""
    global _chat_client
    if _chat_client is None:
        if PROVIDER == "gemini":
            from google import genai  # pip install google-genai; reads GEMINI_API_KEY

            _chat_client = genai.Client()
        else:
            import anthropic  # pip install anthropic; reads ANTHROPIC_API_KEY

            _chat_client = anthropic.Anthropic()
    return _chat_client


def complete(system, user, max_tokens, json_output=False, image_b64=None, history=None, temperature=None, effort=None):
    """One model call, same shape for both providers. Returns the reply text ("" if none).
    history: earlier turns as [("user"|"assistant", text), ...], oldest first.
    temperature applies to Gemini only (current Claude models reject sampling params);
    effort ("low"|"medium"|"high") applies to Claude only."""
    history = history or []
    if PROVIDER == "gemini":
        from google.genai import types

        config = types.GenerateContentConfig(
            system_instruction=system,
            max_output_tokens=max_tokens,
            response_mime_type="application/json" if json_output else None,
            temperature=temperature,
        )
        contents = user
        if image_b64:
            contents = [types.Part.from_bytes(data=base64.b64decode(image_b64), mime_type="image/jpeg"), user]
        if history:
            last = contents if isinstance(contents, list) else [contents]
            contents = [
                types.Content(role="model" if r == "assistant" else "user", parts=[types.Part.from_text(text=t)]) for r, t in history
            ] + [
                types.Content(
                    role="user", parts=[p if isinstance(p, types.Part) else types.Part.from_text(text=p) for p in last]
                )
            ]
        resp = chat_client().models.generate_content(model=CHAT_GEMINI_MODEL, contents=contents, config=config)
        return (resp.text or "").strip()
    content = user
    if image_b64:
        content = [
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": image_b64}},
            {"type": "text", "text": user},
        ]
    extra = {"output_config": {"effort": effort}} if effort else {}
    msg = chat_client().messages.create(
        model=ANTHROPIC_MODEL,
        max_tokens=max_tokens,
        system=[{"type": "text", "text": system}],
        messages=[{"role": r, "content": t} for r, t in history] + [{"role": "user", "content": content}],
        **extra,
    )
    return "".join(b.text for b in msg.content if b.type == "text").strip()


INSTRUCTOR_KEY = os.environ.get("NOVA_INSTRUCTOR_KEY", "")  # unset = the instructor dashboard is off
INSTRUCTOR_PAGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "instructor.html")
RECITATION_STATE = {"plans": {}, "sent": {}}  # cached plans + per-lecture send times (in memory)
LECTURES = {}  # lecture_id -> {"title": str, "captions": [...]}
STORE = hot_topics.QuestionStore()  # anonymous question log for Hot topics (SQLite at NOVA_DB_PATH)
TRANSLATIONS = {}  # (lecture_id, language_code, cue_index) -> translated text. In memory: lost on restart.
MAX_TRANSLATE_CUES = 100

LANGUAGE_NAMES = {
    "es": "Spanish", "zh-Hans": "Simplified Chinese", "hi": "Hindi", "ko": "Korean", "ar": "Arabic",
    "fr": "French", "pt": "Portuguese (Brazil)", "vi": "Vietnamese", "ja": "Japanese",
}

SYSTEM = """You are Nova, an expert tutor following along with a recorded lecture with a student. Answer like a professor who knows the field thoroughly, and get straight to the point.

How to write every answer:
- Start with the answer itself in one plain sentence. Never open with filler like "In this lecture", "The professor says", "Great question" or a restatement of the question.
- Ground the answer in the transcript when it covers the topic, but weave that in naturally (e.g. "The loss used here is MSE, so ...") instead of labeling sections.
- Scale the length to the question: a simple factual question gets 1-2 sentences; an explanation gets the one-line answer plus 2-4 short bullets (about 120 words at most). Never pad.
- Formatting you may use: "- " bullets, "1." numbered lists, **bold** for at most 1-3 key terms, and `inline code` for code, symbols or identifiers. No headings, tables, code blocks or section labels.
- Never use em dashes (—). Use commas, periods, or colons instead.

Match the shape to what the student asked for:
- Explain (e.g. "explain what was just said", "what does X mean"): the one-line answer, then 2-4 bullets covering the key parts or steps.
- "What was just said" / "that" / "this" with no other referent means the part of the transcript in roughly the 2 minutes before the paused timestamp. Focus there.
- Example: give one fresh, concrete example with real numbers or names, in 2-4 sentences or a short numbered walkthrough. If the professor gave their own example, mention it in one sentence and add a Watch line for it.
- Quiz me: ask exactly ONE question about the recent material, either multiple choice (options on separate lines as "A) ...", "B) ...", "C) ...", "D) ...") or a short-answer question. Do NOT give the answer or hints, and add no Watch line.
- When the student answers a quiz question from the earlier conversation: start with "Correct." or "Not quite." then explain why in 1-2 sentences (give the right answer if they missed it), then ask "Want another one?"
- Any other question: answer directly at the length it needs.

Watch line: only when a specific stretch of the transcript directly covers the answer, end with a line starting "Watch:" as a time range in M:SS (or H:MM:SS) from the transcript, plus a short description, e.g. "Watch: 12:33-14:08, derivation of the update rule". Skip it for quiz turns and for answers that come from general knowledge.
If the student asks WHERE or WHEN something was covered (e.g. "where did he talk about recursion?"), search the whole transcript and instead give a one-sentence answer followed by up to 3 "Watch:" lines, one per line, most relevant first, each with a short description (e.g. "full explanation", "brief mention", "worked example").
If the transcript does not cover the question, answer from your full knowledge and omit the Watch line.
Never invent timestamps that are not in the transcript.
Use the earlier conversation to resolve follow-ups like "explain that again" or "give another example".

Video control: if the student asks you to control the video (pause, play/resume, skip or jump, change speed or volume), including jumping to where a topic is covered (e.g. "go to where he talks about recursion", "take me back to the example"), don't answer as a tutor. Reply ONLY with:
Command: <action>   (one line per step, in order)
Say: <one short confirming sentence, e.g. "Jumping to 7:48, where he defines recursion.">
where <action> is one of: pause | play | seek_to M:SS | seek_by <seconds, negative = back> | speed <rate, e.g. 1.5> | volume <0-100> | mute | unmute
For a topic jump, seek_to the start of the best match from the transcript timestamps, then add up to 2 "Watch:" lines for other places it's covered. Only add "Command: play" if the student asked to play, resume or watch. Never invent timestamps, and never use Command lines for ordinary questions."""

VOICE_ADDENDUM = """

The student asked out loud and your answer will be read aloud by a text-to-speech voice. Use 1-3 short, conversational sentences, with the direct answer first. No markdown, bullets, numbered lists or bold. Don't spell out symbols or code; say formulas in words. For a quiz question, say the question and its options in one flowing sentence (e.g. "Is it A, ..., B, ..., or C, ...?"). (Any "Watch:" or "Command:" lines are handled by the app, not read aloud, so still include them when relevant.)"""

HISTORY_TURNS = 10  # earlier chat turns used for follow-ups
ASK_TEMPERATURE = 0.3  # Gemini: low for consistent, on-format tutor answers
ASK_EFFORT = "low"  # Claude: sampling params are gone; low effort suits quick chat answers


def history_turns(history):
    """Earlier turns as alternating ("user"|"assistant", text), starting with user, ending with assistant."""
    turns = []
    for turn in (history or [])[-HISTORY_TURNS:]:
        text = str((turn or {}).get("text") or "").strip()
        if not text:
            continue
        role = "user" if turn.get("role") == "student" else "assistant"
        if turns and turns[-1][0] == role:
            turns[-1] = (role, turns[-1][1] + "\n\n" + text)
        else:
            turns.append((role, text))
    while turns and turns[0][0] != "user":
        turns.pop(0)
    if turns and turns[-1][0] == "user":  # the new question is the next user turn
        turns.pop()
    return turns

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


def record_question(body, title):
    """Save a typed question for Hot topics. Chip taps ("Explain what was just said") aren't topics."""
    question = str(body.get("question") or "").strip()
    if not question or body.get("source") == "chip" or not body.get("lecture_id"):
        return
    try:
        STORE.add(str(body["lecture_id"]), title, question, body.get("current_time") or 0)
    except Exception as e:  # never let logging break an answer
        print("could not save question:", e)


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
    if body.get("voice"):
        system += VOICE_ADDENDUM
    language = str(body.get("language") or "").strip()
    if language:
        # The extension parses the Watch line, so it must keep its exact English format.
        system += (
            f"\n\nReply in {language}. Keep the final line exactly in the form "
            '"Watch: M:SS-M:SS, <description>" with the word "Watch:" in English; '
            "the description may be in the reply language."
        )
    image = body.get("image") or None
    if image:
        system += (
            "\n\nAn image of the video at the moment the student paused is attached. "
            "If the question is about what is on screen (a slide, diagram, code, or whiteboard), "
            "answer from the image and quote its text. Otherwise rely on the transcript."
        )
    user = (
        f"Lecture: {title}\n\nTranscript:\n{transcript}\n\n"
        f"The student is paused at {now}.\nQuestion: {body.get('question', '')}"
    )
    record_question(body, title if lec else body.get("title", ""))
    return complete(
        system, user, max_tokens=2048, image_b64=image, history=history_turns(body.get("history")), temperature=ASK_TEMPERATURE, effort=ASK_EFFORT
    )


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
    user = f"Lecture title: {title or '(unknown)'}\n\nCues:\n" + json.dumps(
        [{"i": c["i"], "text": c["text"]} for c in cues], ensure_ascii=False
    )
    return _parse_translations(complete(TRANSLATE_SYSTEM.format(language=language), user, max_tokens=8192, json_output=True))


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


SUMMARY_SYSTEM = """You summarize a recorded university lecture for a student, from its timestamped transcript.
Reply with ONLY a JSON object, no prose and no code fences:
{"summary": str, "key_points": [str], "chapters": [{"start": number, "title": str}]}

- "summary": 3-5 plain sentences on what the lecture covers and the main takeaway.
- "key_points": 4-7 short bullet points a student should remember, each under 25 words.
- "chapters": 5-12 entries in time order that split the lecture by topic. "start" is the chapter's start time in SECONDS, taken from the transcript's [M:SS] or [H:MM:SS] stamps (convert them: [12:30] is 750). The first chapter starts at the beginning of the transcript. "title" is a short topic name, at most 6 words.
- Use only what the transcript says. Never invent timestamps or topics.
- Never use em dashes. Use commas, periods, or colons instead."""


def _model_summary(system, title, transcript):
    user = f"Lecture title: {title or '(unknown)'}\n\nTranscript:\n{transcript}"
    return complete(system, user, max_tokens=4096, json_output=True)


SUMMARIES = {}  # (lecture_id, language) -> result. In memory: lost on restart.
MAX_CHAPTERS = 15


def clean_summary(raw, duration):
    """Coerce the model's JSON into {summary, key_points, chapters}, dropping anything malformed."""
    if not isinstance(raw, dict):
        raise ValueError("summary was not a JSON object")
    summary = str(raw.get("summary") or "").strip()
    if not summary:
        raise ValueError("summary was empty")
    points = [str(p).strip() for p in (raw.get("key_points") or []) if str(p).strip()][:8]
    chapters = []
    for c in raw.get("chapters") or []:
        if not isinstance(c, dict):
            continue
        start, title = c.get("start"), str(c.get("title") or "").strip()
        if isinstance(start, bool) or not isinstance(start, (int, float)) or not title:
            continue
        if start < 0 or start > duration + 5:  # a timestamp past the end of the lecture is made up
            continue
        chapters.append({"start": round(float(start), 1), "title": title})
    chapters.sort(key=lambda c: c["start"])
    deduped = []
    for c in chapters:
        if not deduped or c["start"] - deduped[-1]["start"] >= 1:
            deduped.append(c)
    return {"summary": summary, "key_points": points, "chapters": deduped[:MAX_CHAPTERS]}


def summarize(body, model_summary=_model_summary):
    lecture_id = str(body.get("lecture_id") or "")
    if not lecture_id:
        raise BadRequest("lecture_id is required")
    lec = LECTURES.get(lecture_id)
    captions = lec["captions"] if lec else body.get("captions") or []  # server restarted: use what the extension sent
    title = lec["title"] if lec else str(body.get("title") or "")
    if not isinstance(captions, list) or not captions or not all(isinstance(c, dict) and "start" in c and "text" in c for c in captions):
        raise BadRequest("no captions for this lecture")
    language = str(body.get("language") or "").strip()
    key = (lecture_id, language)
    if key in SUMMARIES:
        return SUMMARIES[key]

    system = SUMMARY_SYSTEM
    if language:
        system += f"\n\nWrite the summary, key_points and chapter titles in {language}. Keep the JSON keys in English."
    duration = max(float(c.get("end") or c["start"]) for c in captions)
    result = clean_summary(parse_json_loose(model_summary(system, title, transcript_text(captions))), duration)
    SUMMARIES[key] = result
    print(f"summarized {lecture_id} ({language or 'English'}): {len(result['chapters'])} chapters")
    return result


EXPLAIN_SYSTEM = """You are Professor Nova, a patient tutor teaching a concept on a whiteboard to a student who is meeting it for the first time.
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
    """The Anthropic client. It only exists at startup when NOVA_PROVIDER isn't gemini, so create it on demand."""
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
        f"Nova's short answer was: {body.get('reply', '')}\n\n"
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
    language = str(body.get("language") or "").strip()[:60]
    if language:
        system += (
            f"\n\nTeach the whole lesson in {language}: the title, every step's head and say, and all text "
            "drawn on the board. Keep the JSON keys and shape names in English."
        )

    for _ in range(2):  # one retry if the model returns bad JSON
        text = generate_plan_text(system, prompt)
        plan = clean_plan(parse_json_loose(text), max_steps)
        if plan:
            return plan
    # Text-only fallback so the dashboard still shows something.
    fallback = str(body.get("reply", ""))[:300] or "Sorry, I couldn't draw this one."
    return {"title": "Explanation", "steps": [{"head": "Explanation", "say": fallback, "clear": False, "draw": []}]}


# ---------------------------------------------------- ElevenLabs (voice engine) ---
# Uses the official SDK (pip install elevenlabs), which reads ELEVENLABS_API_KEY.

ELEVEN_KEY = os.environ.get("ELEVENLABS_API_KEY", "")
# ElevenLabs speaks English only; every other language uses free Chrome voices in the extension.
# Flash v2.5 is the low-latency model (~75ms) for answers and whiteboard narration.
ELEVEN_TTS_MODEL = os.environ.get("ELEVENLABS_TTS_MODEL", "eleven_flash_v2_5")
ELEVEN_STT_MODEL = os.environ.get("ELEVENLABS_STT_MODEL", "scribe_v2")
# Built-in voices work on every plan; the free plan can't use Voice Library voices through the API.
ELEVEN_DEFAULT_VOICE = os.environ.get("ELEVENLABS_DEFAULT_VOICE", "nPczCjzI2devNBz1zQrb")  # Brian: deep, resonant
ELEVEN_FORMAT = "mp3_44100_128"
MAX_BODY = 25 * 1024 * 1024
_voices_cache = {"at": 0, "data": None}
_eleven_client = None


class VoiceError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def eleven():
    """The ElevenLabs client, created on first use."""
    global _eleven_client
    if not ELEVEN_KEY:
        raise VoiceError(503, "ELEVENLABS_API_KEY is not set on the server (Nova falls back to Chrome voices)")
    if _eleven_client is None:
        from elevenlabs import ElevenLabs

        _eleven_client = ElevenLabs(api_key=ELEVEN_KEY, timeout=45)
    return _eleven_client


def eleven_call(fn):
    """Run an SDK call, turning API failures into VoiceError (502) for the extension."""
    from elevenlabs.core import ApiError

    try:
        return fn()
    except ApiError as e:
        raise VoiceError(502, f"ElevenLabs HTTP {e.status_code}: {str(e.body)[:200]}")


def list_voices():
    if _voices_cache["data"] and time.time() - _voices_cache["at"] < 600:
        return _voices_cache["data"]
    voices = []
    for v in eleven_call(lambda: eleven().voices.get_all().voices):
        if v.category != "premade":
            continue  # only built-in voices (library voices need a paid plan through the API)
        labels = v.labels or {}
        voices.append({
            "voice_id": v.voice_id,
            "name": v.name,
            "labels": {k: labels[k] for k in ("accent", "gender", "age", "description") if labels.get(k)},
            "preview_url": v.preview_url,
        })
    voices.sort(key=lambda v: (v["name"] or "").lower())
    data = {"voices": voices, "default": ELEVEN_DEFAULT_VOICE}
    _voices_cache.update(at=time.time(), data=data)
    return data


def speakable(text):
    """Strip chat markdown (asterisks, backticks, list markers) so the voice doesn't read it."""
    text = str(text or "").replace("*", "").replace("`", "")
    text = re.sub(r"^\s*(?:[-•]|\d+[.)])\s+", "", text, flags=re.M)
    return text.strip()


def tts_request(body):
    """Keyword arguments for text_to_speech.convert/stream from a /tts request body {text, voice_id?, language_code?}.

    English only: any other language_code gets a 409, and the extension uses a Chrome voice for it.
    """
    text = speakable(body.get("text"))[:2500]
    if not text:
        raise VoiceError(400, "text is empty")
    lang = str(body.get("language_code") or "en").split("-")[0].lower()
    if lang != "en":
        raise VoiceError(409, f"ElevenLabs is only used for English, not '{lang}' (use the browser voice)")
    return {
        "voice_id": str(body.get("voice_id") or ELEVEN_DEFAULT_VOICE),
        "text": text,
        "model_id": ELEVEN_TTS_MODEL,
        "output_format": ELEVEN_FORMAT,
        "language_code": "en",
    }


def tts(body):
    """The whole clip as MP3 bytes."""
    args = tts_request(body)
    return eleven_call(lambda: b"".join(eleven().text_to_speech.convert(**args)))


def tts_stream(body):
    """An iterator of MP3 chunks. The first chunk is fetched here so API errors surface before headers go out."""
    args = tts_request(body)
    chunks = eleven_call(lambda: iter(eleven().text_to_speech.stream(**args, optimize_streaming_latency=3)))
    first = eleven_call(lambda: next(chunks, b""))
    return first, chunks


def transcribe(audio, content_type):
    if not audio:
        raise VoiceError(400, "no audio")
    ext = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/mp4": "m4a"}.get(content_type, "webm")
    result = eleven_call(
        lambda: eleven().speech_to_text.convert(
            model_id=ELEVEN_STT_MODEL,
            file=(f"question.{ext}", audio, content_type),
            tag_audio_events=False,
        )
    )
    return (result.text or "").strip()


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Instructor-Key")

    def _send_bytes(self, code, data, content_type):
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_stream(self, first, chunks, content_type):
        """HTTP/1.0-style streaming: no Content-Length, the connection closes when audio ends."""
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            if first:
                self.wfile.write(first)
                self.wfile.flush()
            for chunk in chunks:
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # the student interrupted: the client stopped reading

    def _send(self, code, obj):
        self._send_bytes(code, json.dumps(obj).encode(), "application/json")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _instructor_denied(self):
        """Hot topics and the dashboard are for instructors only: they need the X-Instructor-Key header.
        Sends the 403/401 and returns True when access is refused."""
        if not INSTRUCTOR_KEY:
            self._send(403, {"error": "instructor view is off: set NOVA_INSTRUCTOR_KEY"})
            return True
        given = self.headers.get("X-Instructor-Key", "")
        if not hmac.compare_digest(given.encode(), INSTRUCTOR_KEY.encode()):
            self._send(401, {"error": "wrong or missing instructor key"})
            return True
        return False

    def _instructor(self, url):
        """GET /instructor (page) and /instructor/api/* (JSON, needs NOVA_INSTRUCTOR_KEY)."""
        if url.path == "/instructor":
            with open(INSTRUCTOR_PAGE, "rb") as f:
                return self._send_bytes(200, f.read(), "text/html; charset=utf-8")
        if self._instructor_denied():
            return None
        if url.path == "/instructor/api/lectures":
            return self._send(200, {"lectures": STORE.lectures()})
        if url.path == "/instructor/api/lecture":
            lecture_id = urllib.parse.parse_qs(url.query).get("lecture_id", [""])[0]
            if not lecture_id:
                return self._send(400, {"error": "lecture_id is required"})
            data = hot_topics.topics({"lecture_id": lecture_id}, STORE, complete)
            known = next((l for l in STORE.lectures() if l["lecture_id"] == lecture_id), {})
            data["title"] = known.get("title") or (LECTURES.get(lecture_id) or {}).get("title") or lecture_id
            return self._send(200, data)
        return self._send(404, {"error": "not found"})

    def do_GET(self):
        try:
            url = urllib.parse.urlparse(self.path)
            if url.path == "/instructor" or url.path.startswith("/instructor/"):
                return self._instructor(url)
            if self.path == "/voices":
                return self._send(200, list_voices())
            if self.path in ("/", "/health"):
                return self._send(200, {"ok": True, "provider": PROVIDER, "model": MODEL, "elevenlabs": bool(ELEVEN_KEY), "voice": ELEVEN_DEFAULT_VOICE})
            self._send(404, {"error": "not found"})
        except VoiceError as e:
            self._send(e.status, {"error": str(e)})
        except Exception as e:
            print("error:", e)
            self._send(500, {"error": str(e)})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
            if length > MAX_BODY:
                raise VoiceError(413, "request too large")
            raw = self.rfile.read(length) if length else b""
            if self.path == "/transcribe":
                content_type = (self.headers.get("Content-Type") or "audio/webm").split(";")[0].strip()
                return self._send(200, {"text": transcribe(raw, content_type)})
            body = json.loads(raw or b"{}")
            if self.path == "/instructor/api/recitation":
                if self._instructor_denied():
                    return
                lecture_id = str(body.get("lecture_id") or "")
                if not lecture_id:
                    raise BadRequest("lecture_id is required")
                data = hot_topics.topics({"lecture_id": lecture_id}, STORE, complete)
                known = next((l for l in STORE.lectures() if l["lecture_id"] == lecture_id), {})
                title = known.get("title") or (LECTURES.get(lecture_id) or {}).get("title") or ""
                code, out = recitation.export_plan(lecture_id, title, data, complete, RECITATION_STATE)
                return self._send(code, out)
            if self.path == "/tts":
                return self._send_bytes(200, tts(body), "audio/mpeg")
            if self.path == "/tts/stream":
                first, chunks = tts_stream(body)
                return self._send_stream(first, chunks, "audio/mpeg")
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
            if self.path == "/summary":
                return self._send(200, summarize(body))
            if self.path == "/explain":
                return self._send(200, explain(body))
            if self.path == "/topics":
                if self._instructor_denied():  # Hot topics is instructor-only
                    return None
                return self._send(200, hot_topics.topics(body, STORE, complete))
            self._send(404, {"error": "not found"})
        except (BadRequest, ValueError) as e:
            self._send(400, {"error": str(e)})
        except VoiceError as e:
            print("voice error:", e)
            self._send(e.status, {"error": str(e)})
        except Exception as e:  # surface errors to the extension
            print("error:", e)
            self._send(500, {"error": str(e)})


if __name__ == "__main__":
    explain_model = GEMINI_MODEL if EXPLAIN_PROVIDER == "gemini" else EXPLAIN_MODEL
    print(
        f"Nova backend on http://localhost:{PORT} | /ask + /translate: {PROVIDER}/{MODEL} | /explain: {EXPLAIN_PROVIDER}/{explain_model}",
        flush=True,
    )
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
