"""
Recitation plans: turn a lecture's Hot topics analytics into a 50-minute TA-led session
and email it to a fixed address.

At UB a recitation is a 50-minute class taught by the TAs. The instructor dashboard's
"Export recitation plan" button calls export_plan(); the model drafts the plan from the
lecture's most-asked themes, normalize_plan() makes the minutes add up to exactly 50, and
send_email() mails it over SMTP.

The recipient comes ONLY from the environment (NOVA_RECITATION_EMAIL), never from a request,
so nobody can use this endpoint to mail arbitrary people. Two ways to send, both env vars:

  1. Brevo email API (HTTPS; works on hosts that block SMTP, like Railway's free/Hobby plans).
     Used when NOVA_BREVO_API_KEY is set:
         NOVA_BREVO_API_KEY, NOVA_EMAIL_FROM (a sender address verified in Brevo), NOVA_RECITATION_EMAIL
  2. SMTP (everywhere else):
         NOVA_SMTP_HOST, NOVA_SMTP_PORT (587 = STARTTLS, 465 = SSL), NOVA_SMTP_USER,
         NOVA_SMTP_PASSWORD, NOVA_SMTP_FROM (optional, defaults to the user), NOVA_RECITATION_EMAIL
  NOVA_RECITATION_EMAIL may hold several comma-separated TA addresses.
"""
import html
import json
import os
import re
import smtplib
import time
import urllib.error
import urllib.request
from email.message import EmailMessage

import topics as hot_topics

SESSION_MINUTES = 50
MAX_BLOCKS = 8
MIN_BLOCK = 3
RESEND_AFTER_SECONDS = 60  # one email per lecture per minute: no accidental spamming

RECITATION_SYSTEM = f"""You design a {SESSION_MINUTES}-minute recitation for a university course. Recitations are run by teaching assistants (TAs)
the day after a lecture. You are given what students asked an AI tutor while watching that lecture: the most-asked themes
(with how many students asked, the video time they asked about, and reworded example questions) and when in the lecture
questions clustered.

Reply with ONLY a JSON object, no prose and no code fences:
{{"title": "Recitation: <lecture topic>", "goal": "<one sentence: what students should be able to do afterwards>",
  "blocks": [{{"minutes": <int>, "title": "<short>", "activity": "<what the TA does, e.g. worked example, pair problem, whiteboard walk-through, poll>",
              "details": "<2-4 sentences: the concrete problem or question to use, built from the themes>",
              "lecture_time": <video seconds to rewatch, or null>}}],
  "ta_notes": "<2-3 sentences of advice for the TAs>"}}

Rules:
- The blocks' minutes add up to exactly {SESSION_MINUTES}.
- Start with a ~5 minute opener (recap or warm-up question). End with a ~5 minute exit check (one short question to hand in).
- Spend the middle on the most-asked themes, giving more minutes to themes more students asked about (each 5 to 15 minutes).
  Make each block active (students work something out), not a re-lecture.
- Use the reworded example questions to write concrete problems. Never invent facts about the lecture beyond the themes given.
- "lecture_time" is the theme's video time in seconds, so students can rewatch that part.
- Never include names or any personal details."""


class EmailNotConfigured(Exception):
    """SMTP or the recipient isn't set up in the environment."""


# ---- plan cleanup --------------------------------------------------------------------------


def _text(value, limit):
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def normalize_plan(raw, total=SESSION_MINUTES):
    """Make the model's plan safe: clean text, whole minutes, and a total of exactly `total`."""
    data = raw if isinstance(raw, dict) else {}
    blocks = []
    for b in data.get("blocks", []) if isinstance(data.get("blocks"), list) else []:
        if not isinstance(b, dict):
            continue
        try:
            minutes = int(round(float(b.get("minutes"))))
        except (TypeError, ValueError):
            continue
        if minutes < 1:
            continue
        try:
            at = float(b["lecture_time"]) if b.get("lecture_time") is not None else None
        except (TypeError, ValueError):
            at = None
        blocks.append(
            {
                "minutes": minutes,
                "title": _text(b.get("title"), 100) or "Activity",
                "activity": _text(b.get("activity"), 300),
                "details": _text(b.get("details"), 800),
                "lecture_time": round(at, 1) if at is not None and at >= 0 else None,
            }
        )
    blocks = blocks[:MAX_BLOCKS]
    if not blocks:
        raise ValueError("the model didn't return a usable plan")

    # Fix the arithmetic: grow the longest block, or shrink the longest ones, until it is exact.
    while sum(b["minutes"] for b in blocks) != total:
        diff = total - sum(b["minutes"] for b in blocks)
        longest = max(blocks, key=lambda b: b["minutes"])
        if diff > 0:
            longest["minutes"] += diff
        elif longest["minutes"] > MIN_BLOCK:
            longest["minutes"] -= min(longest["minutes"] - MIN_BLOCK, -diff)
        else:
            blocks.pop()  # every block is already at the minimum: drop the last one
            if not blocks:
                raise ValueError("the model didn't return a usable plan")
    return {
        "title": _text(data.get("title"), 140) or "Recitation plan",
        "goal": _text(data.get("goal"), 400),
        "blocks": blocks,
        "ta_notes": _text(data.get("ta_notes"), 600),
    }


# ---- building the plan ----------------------------------------------------------------------


def busiest_slices(times, slices=6, top=3):
    """[(start_s, end_s, count)] for the busiest slices of the lecture, busiest first."""
    if not times:
        return []
    end = max(max(times) + 1, 60)
    size = end / slices
    counts = [0] * slices
    for t in times:
        counts[min(slices - 1, int(t // size))] += 1
    ranked = sorted(range(slices), key=lambda i: -counts[i])[:top]
    return [(round(i * size), round((i + 1) * size), counts[i]) for i in ranked if counts[i]]


def build_plan(title, data, complete):
    """data: the topics() result for the lecture. Returns a normalized plan dict."""
    themes = [
        {"title": t["title"], "summary": t.get("summary", ""), "students_asked": t["count"], "video_time_s": t["time"], "example_questions": t.get("examples", [])}
        for t in data.get("topics", [])
    ]
    busy = [{"from": hot_topics._fmt(a), "to": hot_topics._fmt(b), "questions": n} for a, b, n in busiest_slices(data.get("question_times", []))]
    user = json.dumps({"lecture": title, "total_questions": data.get("total_questions", 0), "themes": themes, "busiest_parts_of_lecture": busy}, ensure_ascii=False)
    raw = hot_topics._parse_json(complete(RECITATION_SYSTEM, user, max_tokens=3000, json_output=True))
    return normalize_plan(raw)


# ---- rendering ------------------------------------------------------------------------------


def _clock(seconds):
    return hot_topics._fmt(seconds)


def render_text(plan, lecture_title=""):
    lines = [plan["title"], "=" * len(plan["title"])]
    if lecture_title:
        lines.append(f"Based on student questions from: {lecture_title}")
    if plan["goal"]:
        lines += ["", f"Goal: {plan['goal']}"]
    at = 0
    for b in plan["blocks"]:
        lines += ["", f"{at}-{at + b['minutes']} min  {b['title']} ({b['minutes']} min)"]
        if b["activity"]:
            lines.append(f"  Activity: {b['activity']}")
        if b["details"]:
            lines.append(f"  {b['details']}")
        if b["lecture_time"] is not None:
            lines.append(f"  Rewatch the lecture at {_clock(b['lecture_time'])}")
        at += b["minutes"]
    if plan["ta_notes"]:
        lines += ["", f"Notes for TAs: {plan['ta_notes']}"]
    lines += ["", "Generated by Nova from anonymous student questions."]
    return "\n".join(lines)


def render_html(plan, lecture_title=""):
    e = html.escape
    rows, at = [], 0
    for b in plan["blocks"]:
        extra = f"<br><small>Rewatch the lecture at {e(_clock(b['lecture_time']))}</small>" if b["lecture_time"] is not None else ""
        rows.append(
            f"<tr><td style='padding:8px 12px 8px 0;vertical-align:top;white-space:nowrap;color:#6b7280'>{at}&ndash;{at + b['minutes']} min</td>"
            f"<td style='padding:8px 0;border-top:1px solid #e5e7eb'><b>{e(b['title'])}</b> ({b['minutes']} min)"
            f"<br><i>{e(b['activity'])}</i><br>{e(b['details'])}{extra}</td></tr>"
        )
        at += b["minutes"]
    source = f"<p style='color:#6b7280'>Based on student questions from: {e(lecture_title)}</p>" if lecture_title else ""
    goal = f"<p><b>Goal:</b> {e(plan['goal'])}</p>" if plan["goal"] else ""
    notes = f"<p><b>Notes for TAs:</b> {e(plan['ta_notes'])}</p>" if plan["ta_notes"] else ""
    return (
        "<div style='font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:640px'>"
        f"<h2 style='margin:0 0 4px'>{e(plan['title'])}</h2>{source}{goal}"
        f"<table style='border-collapse:collapse;width:100%'>{''.join(rows)}</table>{notes}"
        "<p style='color:#9ca3af;font-size:12px'>Generated by Nova from anonymous student questions.</p></div>"
    )


# ---- email ----------------------------------------------------------------------------------

_ADDRESS = re.compile(r"^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$")


def smtp_config(env=None):
    """Read SMTP settings from the environment, or raise EmailNotConfigured naming what's missing."""
    env = os.environ if env is None else env
    cfg = {
        "host": env.get("NOVA_SMTP_HOST", "").strip(),
        "port": int(env.get("NOVA_SMTP_PORT", "587") or 587),
        "user": env.get("NOVA_SMTP_USER", "").strip(),
        "password": env.get("NOVA_SMTP_PASSWORD", ""),
        "sender": (env.get("NOVA_SMTP_FROM") or env.get("NOVA_SMTP_USER", "")).strip(),
        "to": [a.strip() for a in env.get("NOVA_RECITATION_EMAIL", "").split(",") if a.strip()],
    }
    missing = [name for name, ok in (("NOVA_SMTP_HOST", cfg["host"]), ("NOVA_SMTP_USER", cfg["user"]), ("NOVA_SMTP_PASSWORD", cfg["password"]), ("NOVA_RECITATION_EMAIL", cfg["to"])) if not ok]
    if missing:
        raise EmailNotConfigured("email isn't set up yet: set " + ", ".join(missing))
    bad = [a for a in cfg["to"] if not _ADDRESS.match(a)]
    if bad or not _ADDRESS.match(cfg["sender"]):
        raise EmailNotConfigured("NOVA_RECITATION_EMAIL / NOVA_SMTP_FROM contain an invalid address")
    return cfg


def mask_email(address):
    name, _, domain = address.partition("@")
    return f"{name[:1]}***@{domain}"


BREVO_URL = "https://api.brevo.com/v3/smtp/email"


def brevo_config(env=None):
    """Brevo settings from the environment, or EmailNotConfigured naming what's missing."""
    env = os.environ if env is None else env
    cfg = {
        "key": env.get("NOVA_BREVO_API_KEY", "").strip(),
        "sender": (env.get("NOVA_EMAIL_FROM") or env.get("NOVA_SMTP_FROM", "")).strip(),
        "to": [a.strip() for a in env.get("NOVA_RECITATION_EMAIL", "").split(",") if a.strip()],
    }
    missing = [name for name, ok in (("NOVA_EMAIL_FROM", cfg["sender"]), ("NOVA_RECITATION_EMAIL", cfg["to"])) if not ok]
    if missing:
        raise EmailNotConfigured("email isn't set up yet: set " + ", ".join(missing))
    if not _ADDRESS.match(cfg["sender"]) or [a for a in cfg["to"] if not _ADDRESS.match(a)]:
        raise EmailNotConfigured("NOVA_RECITATION_EMAIL / NOVA_EMAIL_FROM contain an invalid address")
    return cfg


def send_brevo(subject, text, html_body, env=None, opener=urllib.request.urlopen):
    """Send through Brevo's HTTPS API. Returns the masked recipients."""
    cfg = brevo_config(env)
    payload = {
        "sender": {"name": "Nova", "email": cfg["sender"]},
        "to": [{"email": a} for a in cfg["to"]],
        "subject": re.sub(r"[\r\n]+", " ", subject)[:200],
        "textContent": text,
        "htmlContent": html_body,
    }
    req = urllib.request.Request(
        BREVO_URL,
        json.dumps(payload).encode(),
        {"api-key": cfg["key"], "Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with opener(req, timeout=15) as resp:
            resp.read()
    except urllib.error.HTTPError as err:
        print("Brevo rejected the email:", err.code, err.read()[:300])  # the API key is never in this
        raise
    return [mask_email(a) for a in cfg["to"]]


def send_email(subject, text, html_body, env=None, smtp_ssl=smtplib.SMTP_SSL, smtp=smtplib.SMTP):
    """Send one message to the configured recipients. Returns the masked recipients.
    Uses Brevo's HTTPS API when NOVA_BREVO_API_KEY is set, otherwise SMTP."""
    if (os.environ if env is None else env).get("NOVA_BREVO_API_KEY", "").strip():
        return send_brevo(subject, text, html_body, env)
    cfg = smtp_config(env)
    msg = EmailMessage()
    msg["Subject"] = re.sub(r"[\r\n]+", " ", subject)[:200]
    msg["From"] = cfg["sender"]
    msg["To"] = ", ".join(cfg["to"])
    msg.set_content(text)
    msg.add_alternative(html_body, subtype="html")
    if cfg["port"] == 465:
        client = smtp_ssl(cfg["host"], cfg["port"], timeout=15)
    else:
        client = smtp(cfg["host"], cfg["port"], timeout=15)
    with client as s:
        if cfg["port"] != 465 and cfg["host"] not in ("localhost", "127.0.0.1"):
            s.starttls()
        s.login(cfg["user"], cfg["password"])
        s.send_message(msg)
    return [mask_email(a) for a in cfg["to"]]


# ---- the endpoint ---------------------------------------------------------------------------


def export_plan(lecture_id, title, data, complete, state, send=send_email, now=None):
    """
    POST /instructor/api/recitation. Returns (http_status, body).
    `state` is a dict kept by the server: {"plans": {}, "sent": {}} (caches + the send rate limit).
    """
    now = now or time.time()
    total = data.get("total_questions", 0)
    if not total or not data.get("topics"):
        return 400, {"error": "No questions yet for this lecture, so there's nothing to plan from."}
    last = state["sent"].get(lecture_id)
    if last and now - last < RESEND_AFTER_SECONDS:
        return 429, {"error": f"A plan for this lecture was just sent. Try again in {int(RESEND_AFTER_SECONDS - (now - last))} seconds."}

    key = (lecture_id, total)
    plan = state["plans"].get(key)
    if plan is None:
        plan = build_plan(title, data, complete)
        state["plans"][key] = plan

    try:
        to = send(f"{plan['title']} ({title})" if title else plan["title"], render_text(plan, title), render_html(plan, title))
    except EmailNotConfigured as err:
        return 503, {"error": str(err), "sent": False, "plan": plan}
    except (OSError, smtplib.SMTPException) as err:
        print("recitation email failed:", err)
        return 502, {"error": "The email server rejected or couldn't send the message.", "sent": False, "plan": plan}
    state["sent"][lecture_id] = now
    return 200, {"sent": True, "to": to, "plan": plan}
