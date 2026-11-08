"""Run from the backend folder:  cd backend && python3 -m unittest test_store
Also runs against Postgres when TEST_DATABASE_URL is set (it creates and drops its own tables' rows)."""
import os
import tempfile
import unittest

import topics


class StoreContract:
    """Every backend must behave the same."""

    def make(self):
        raise NotImplementedError

    def setUp(self):
        self.s = self.make()

    def test_questions_counts_and_lectures(self):
        for i, t in enumerate([30, 10, 200]):
            self.s.add("L1", "Lecture 1", f"q{i}", t, now=100 + i)
        self.s.add("L2", "Lecture 2", "other", 5, now=500)
        self.assertEqual(self.s.count("L1"), 3)
        self.assertEqual(self.s.count("nope"), 0)
        self.assertEqual([q["question"] for q in self.s.questions("L1")], ["q0", "q1", "q2"])
        self.assertEqual(self.s.times("L1"), [10.0, 30.0, 200.0])
        lectures = self.s.lectures()
        self.assertEqual([l["lecture_id"] for l in lectures], ["L2", "L1"])  # newest activity first
        self.assertEqual((lectures[1]["title"], lectures[1]["questions"]), ("Lecture 1", 3))

    def test_cache_insert_and_overwrite(self):
        self.assertIsNone(self.s.cached("L1"))
        self.s.save_cache("L1", [{"title": "A", "count": 2}], 2, now=1000)
        self.s.save_cache("L1", [{"title": "B", "count": 5}], 5, now=2000)  # replaces, doesn't duplicate
        c = self.s.cached("L1")
        self.assertEqual((c["themes"][0]["title"], c["question_count"], c["built_at"]), ("B", 5, 2000))

    def test_topics_end_to_end(self):
        for i in range(4):
            self.s.add("L1", "Lecture 1", f"why {i}?", 100 * i)
        complete = lambda *a, **k: '{"themes":[{"title":"Why","summary":"s","questions":[0,1,2],"examples":["e"]}]}'
        out = topics.topics({"lecture_id": "L1"}, self.s, complete)
        self.assertEqual((out["status"], out["total_questions"], out["topics"][0]["count"]), ("ok", 4, 3))
        self.assertEqual(out["question_times"], [0.0, 100.0, 200.0, 300.0])


class SqliteStore(StoreContract, unittest.TestCase):
    def make(self):
        return topics.QuestionStore(os.path.join(tempfile.mkdtemp(), "t.db"), dsn="")


@unittest.skipUnless(os.environ.get("TEST_DATABASE_URL"), "set TEST_DATABASE_URL to test Postgres")
class PostgresStore(StoreContract, unittest.TestCase):
    def make(self):
        import psycopg

        with psycopg.connect(os.environ["TEST_DATABASE_URL"]) as c:
            c.execute("DROP TABLE IF EXISTS questions")
            c.execute("DROP TABLE IF EXISTS topics_cache")
        return topics.QuestionStore(dsn=os.environ["TEST_DATABASE_URL"])


class Fallback(unittest.TestCase):
    def test_bad_database_url_falls_back_to_sqlite(self):
        s = topics.QuestionStore(os.path.join(tempfile.mkdtemp(), "t.db"), dsn="postgresql://nobody@127.0.0.1:1/none")
        self.assertEqual(s.dsn, "")
        s.add("L1", "t", "q", 1)
        self.assertEqual(s.count("L1"), 1)


if __name__ == "__main__":
    unittest.main()
