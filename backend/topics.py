"""
Hot topics: what students ask about most in a lecture.

Every typed question is saved anonymously (no student identity of any kind). When
someone opens Hot topics, the model groups the lecture's questions into themes;
the server counts them and picks timestamps from the real questions, and caches
the result so opening the view is usually instant.

Storage is a SQLite file. On Railway, attach a Volume and set NOVA_DB_PATH (for
example /data/nova.db); otherwise questions are lost on every redeploy.
"""
import json
import os
import sqlite3
import statistics
import threading
import time

DB_PATH = os.environ.get("NOVA_DB_PATH") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "nova.db")
MAX_QUESTIONS = 300  # newest questions considered per lecture
MAX_THEMES = 6
REBUILD_AFTER_NEW = 3  # rebuild themes once this many new questions came in...
REBUILD_AFTER_SECONDS = 600  # ...or any new question and the themes are this old

TOPICS_SYSTEM = """You group questions that students asked while watching one recorded university lecture.

You get a JSON array of questions, each {"i": <index>, "t": <time in the video>, "q": <question>}.
Return JSON only:
{"themes": [{"title": "...", "summary": "...", "questions": [<i>, ...], "examples": ["...", "..."]}]}

Rules:
- At most 6 themes, about the lecture's content. Group questions that are about the same concept or confusion.
- "title": the concept, 2-6 words (e.g. "Few-shot vs fine-tuning").
- "summary": one sentence on what students find confusing about it.
- "questions": the indexes of every question that belongs to the theme. Each question goes in at most one theme.
  Leave out greetings, tests and questions that aren't about the lecture.
- "examples": 2-3 representative questions REWORDED in your own words, so no student's exact phrasing appears.
  Never include names, emails, grades or other personal details.
- Write titles, summaries and examples in English."""


class QuestionStore:
    """Anonymous question log + cached themes, in one SQLite file."""

    def __init__(self, path=DB_PATH):
        self.path = path
        self.lock = threading.Lock()
        with self._db() as db:
            db.execute(
                """CREATE TABLE IF NOT EXISTS questions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    lecture_id TEXT NOT NULL,
                    title TEXT,
                    question TEXT NOT NULL,
                    video_time REAL,
                    asked_at REAL NOT NULL)"""
            )
            db.execute("CREATE INDEX IF NOT EXISTS questions_lecture ON questions (lecture_id, id)")
            db.execute(
                """CREATE TABLE IF NOT EXISTS topics_cache (
                    lecture_id TEXT PRIMARY KEY,
                    themes TEXT NOT NULL,
                    question_count INTEGER NOT NULL,
                    built_at REAL NOT NULL)"""
            )

    def _db(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    def add(self, lecture_id, title, question, video_time, now=None):
        with self.lock, self._db() as db:
            db.execute(
                "INSERT INTO questions (lecture_id, title, question, video_time, asked_at) VALUES (?, ?, ?, ?, ?)",
                (lecture_id, title or "", question, float(video_time or 0), now or time.time()),
            )

    def count(self, lecture_id):
        with self._db() as db:
            return db.execute("SELECT COUNT(*) FROM questions WHERE lecture_id = ?", (lecture_id,)).fetchone()[0]

    def questions(self, lecture_id, limit=MAX_QUESTIONS):
        with self._db() as db:
            rows = db.execute(
                "SELECT question, video_time, title FROM questions WHERE lecture_id = ? ORDER BY id DESC LIMIT ?",
                (lecture_id, limit),
            ).fetchall()
        return [dict(r) for r in reversed(rows)]

    def cached(self, lecture_id):
        with self._db() as db:
            row = db.execute("SELECT * FROM topics_cache WHERE lecture_id = ?", (lecture_id,)).fetchone()
        if not row:
            return None
        return {"themes": json.loads(row["themes"]), "question_count": row["question_count"], "built_at": row["built_at"]}

    def save_cache(self, lecture_id, themes, question_count, now=None):
        with self.lock, self._db() as db:
            db.execute(
                "INSERT OR REPLACE INTO topics_cache (lecture_id, themes, question_count, built_at) VALUES (?, ?, ?, ?)",
                (lecture_id, json.dumps(themes), question_count, now or time.time()),
            )


def _parse_json(text):
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return {}
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _fmt(t):
    t = int(t or 0)
    h, m, s = t // 3600, t % 3600 // 60, t % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def build_themes(questions, title, complete):
    """Ask the model to group questions; counts and timestamps come from the real questions."""
    items = [{"i": i, "t": _fmt(q["video_time"]), "q": q["question"][:500]} for i, q in enumerate(questions)]
    user = f"Lecture: {title or '(unknown)'}\n\nQuestions:\n" + json.dumps(items, ensure_ascii=False)
    data = _parse_json(complete(TOPICS_SYSTEM, user, max_tokens=4096, json_output=True))
    themes, used = [], set()
    for raw in data.get("themes", []) if isinstance(data.get("themes"), list) else []:
        if not isinstance(raw, dict):
            continue
        idx = []
        for i in raw.get("questions", []) if isinstance(raw.get("questions"), list) else []:
            if isinstance(i, int) and 0 <= i < len(questions) and i not in used:
                idx.append(i)
                used.add(i)
        if not idx:
            continue
        examples = [str(e).strip()[:200] for e in (raw.get("examples") or []) if str(e).strip()][:3]
        themes.append(
            {
                "title": str(raw.get("title") or "Untitled topic").strip()[:80],
                "summary": str(raw.get("summary") or "").strip()[:300],
                "count": len(idx),
                "time": round(statistics.median(questions[i]["video_time"] for i in idx), 1),
                "examples": examples,
            }
        )
    themes.sort(key=lambda t: (-t["count"], t["time"]))
    return themes[:MAX_THEMES]


def topics(body, store, complete, now=None):
    """POST /topics -> {"status": "ok"|"empty", "topics": [...], "total_questions": n, "updated_at": epoch}"""
    now = now or time.time()
    lecture_id = str(body.get("lecture_id") or "")
    if not lecture_id:
        raise ValueError("lecture_id is required")
    total = store.count(lecture_id)
    if total == 0:
        return {"status": "empty", "topics": [], "total_questions": 0, "updated_at": now}

    cache = store.cached(lecture_id)
    fresh = cache and (
        cache["question_count"] == total
        or (total - cache["question_count"] < REBUILD_AFTER_NEW and now - cache["built_at"] < REBUILD_AFTER_SECONDS)
    )
    # Refresh only rebuilds when there's something new, so repeated clicks don't cost model calls.
    if fresh and not (body.get("refresh") and cache["question_count"] != total):
        return {"status": "ok", "topics": cache["themes"], "total_questions": total, "updated_at": cache["built_at"]}

    questions = store.questions(lecture_id)
    title = next((q["title"] for q in reversed(questions) if q["title"]), "")
    themes = build_themes(questions, title, complete)
    store.save_cache(lecture_id, themes, total, now)
    print(f"topics {lecture_id}: {len(themes)} themes from {len(questions)} questions")
    return {"status": "ok", "topics": themes, "total_questions": total, "updated_at": now}
