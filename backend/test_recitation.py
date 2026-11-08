"""Run from the backend folder:  cd backend && python3 -m unittest test_recitation"""
import json
import unittest

import recitation as r

ENV = {"NOVA_SMTP_HOST": "smtp.example.com", "NOVA_SMTP_PORT": "587", "NOVA_SMTP_USER": "nova@example.com",
       "NOVA_SMTP_PASSWORD": "pw", "NOVA_RECITATION_EMAIL": "ta1@buffalo.edu, ta2@buffalo.edu"}
DATA = {"status": "ok", "total_questions": 30, "question_times": [100, 120, 2000, 2010, 2050, 2100, 4000],
        "topics": [{"title": "Backprop", "summary": "s", "count": 14, "time": 2000, "examples": ["why chain rule?"]}]}


def blocks(*minutes):
    return {"title": "T", "blocks": [{"minutes": m, "title": f"b{i}", "activity": "a", "details": "d", "lecture_time": 60} for i, m in enumerate(minutes)]}


class Normalize(unittest.TestCase):
    def total(self, raw):
        return sum(b["minutes"] for b in r.normalize_plan(raw)["blocks"])

    def test_always_50(self):
        for mins in [(5, 10, 10, 10, 10, 5), (5, 5, 5, 5, 5, 5, 3), (20, 20, 20, 20), (1,), (60,), (5, 40, 5, 30), ("7", 10.4, 12.6)]:
            self.assertEqual(self.total(blocks(*mins)), 50, mins)

    def test_garbage_is_rejected_or_cleaned(self):
        with self.assertRaises(ValueError):
            r.normalize_plan({})
        with self.assertRaises(ValueError):
            r.normalize_plan({"blocks": [{"minutes": "x"}, "no", {"minutes": 0}]})
        plan = r.normalize_plan({"blocks": [{"minutes": 50, "title": "x" * 500, "lecture_time": "abc"}]})
        self.assertEqual(len(plan["blocks"][0]["title"]), 100)
        self.assertIsNone(plan["blocks"][0]["lecture_time"])

    def test_html_is_escaped(self):
        plan = r.normalize_plan(blocks(50))
        plan["blocks"][0]["title"] = "<script>alert(1)</script>"
        self.assertNotIn("<script>", r.render_html(plan, "<b>x</b>"))
        self.assertIn("min", r.render_text(plan))


class Slices(unittest.TestCase):
    def test_busiest_first(self):
        s = r.busiest_slices(DATA["question_times"])
        self.assertEqual(s[0][2], max(x[2] for x in s))
        self.assertEqual(r.busiest_slices([]), [])


class FakeSMTP:
    sent = []

    def __init__(self, host, port, timeout=0):
        self.host, self.port = host, port
        self.tls = False

    def __enter__(self): return self
    def __exit__(self, *a): return False
    def starttls(self): self.tls = True
    def login(self, u, p): self.creds = (u, p)
    def send_message(self, msg): FakeSMTP.sent.append((self, msg))


class Email(unittest.TestCase):
    def setUp(self):
        FakeSMTP.sent = []

    def test_sends_only_to_configured_recipients(self):
        masked = r.send_email("Subj\r\nBcc: evil@x.com", "text", "<p>h</p>", env=ENV, smtp=FakeSMTP)
        client, msg = FakeSMTP.sent[0]
        self.assertEqual(masked, ["t***@buffalo.edu", "t***@buffalo.edu"])
        self.assertEqual(msg["To"], "ta1@buffalo.edu, ta2@buffalo.edu")
        self.assertNotIn("\n", msg["Subject"])
        self.assertIsNone(msg["Bcc"])
        self.assertTrue(client.tls)

    def test_missing_config(self):
        with self.assertRaises(r.EmailNotConfigured) as cm:
            r.send_email("s", "t", "h", env={}, smtp=FakeSMTP)
        self.assertIn("NOVA_RECITATION_EMAIL", str(cm.exception))
        self.assertEqual(FakeSMTP.sent, [])

    def test_invalid_recipient(self):
        with self.assertRaises(r.EmailNotConfigured):
            r.smtp_config({**ENV, "NOVA_RECITATION_EMAIL": "not-an-email"})


class FakeResponse:
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def read(self): return b"{}"


class Brevo(unittest.TestCase):
    ENV = {"NOVA_BREVO_API_KEY": "k-123", "NOVA_EMAIL_FROM": "me@gmail.com", "NOVA_RECITATION_EMAIL": "ta1@buffalo.edu, ta2@buffalo.edu"}

    def test_posts_to_brevo_with_only_configured_recipients(self):
        seen = {}

        def opener(req, timeout=0):
            seen["req"], seen["timeout"] = req, timeout
            return FakeResponse()

        masked = r.send_brevo("Subj\r\nBcc: evil@x.com", "text", "<p>h</p>", env=self.ENV, opener=opener)
        req = seen["req"]
        body = json.loads(req.data)
        self.assertEqual(req.full_url, "https://api.brevo.com/v3/smtp/email")
        self.assertEqual(req.get_header("Api-key"), "k-123")
        self.assertEqual(body["to"], [{"email": "ta1@buffalo.edu"}, {"email": "ta2@buffalo.edu"}])
        self.assertEqual(body["sender"]["email"], "me@gmail.com")
        self.assertNotIn("\n", body["subject"])
        self.assertEqual(masked, ["t***@buffalo.edu", "t***@buffalo.edu"])

    def test_brevo_is_chosen_when_the_key_is_set_and_smtp_otherwise(self):
        import unittest.mock as m
        with m.patch.object(r, "send_brevo", return_value=["b"]) as b:
            self.assertEqual(r.send_email("s", "t", "h", env=self.ENV), ["b"])
            b.assert_called_once()
        FakeSMTP.sent = []
        r.send_email("s", "t", "h", env=ENV, smtp=FakeSMTP)  # no Brevo key: SMTP
        self.assertEqual(len(FakeSMTP.sent), 1)

    def test_brevo_missing_sender(self):
        with self.assertRaises(r.EmailNotConfigured) as cm:
            r.send_brevo("s", "t", "h", env={"NOVA_BREVO_API_KEY": "k", "NOVA_RECITATION_EMAIL": "ta@buffalo.edu"})
        self.assertIn("NOVA_EMAIL_FROM", str(cm.exception))

    def test_brevo_http_error_becomes_a_502_not_a_crash(self):
        import io
        import urllib.error

        def opener(req, timeout=0):
            raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, io.BytesIO(b'{"message":"Key not found"}'))

        def send(*a): return r.send_brevo(*a, env=self.ENV, opener=opener)
        code, out = r.export_plan("L1", "t", DATA, lambda *a, **k: json.dumps(blocks(50)), {"plans": {}, "sent": {}}, send=send, now=1)
        self.assertEqual((code, out["sent"]), (502, False))
        self.assertNotIn("k-123", json.dumps(out))


class Export(unittest.TestCase):
    def setUp(self):
        self.state = {"plans": {}, "sent": {}}
        self.calls = 0

    def complete(self, system, user, max_tokens=0, json_output=False):
        self.calls += 1
        self.user = user
        return json.dumps(blocks(5, 12, 20, 8))

    def test_happy_path_cache_and_rate_limit(self):
        sent = []
        send = lambda *a: sent.append(a) or ["t***@buffalo.edu"]
        code, out = r.export_plan("L1", "Lecture 7", DATA, self.complete, self.state, send=send, now=1000)
        self.assertEqual((code, out["sent"], out["to"]), (200, True, ["t***@buffalo.edu"]))
        self.assertEqual(sum(b["minutes"] for b in out["plan"]["blocks"]), 50)
        self.assertIn("students_asked", self.user)
        code, out = r.export_plan("L1", "Lecture 7", DATA, self.complete, self.state, send=send, now=1010)
        self.assertEqual(code, 429)
        code, _ = r.export_plan("L1", "Lecture 7", DATA, self.complete, self.state, send=send, now=1100)
        self.assertEqual((code, self.calls, len(sent)), (200, 1, 2))  # plan cached: one model call

    def test_no_questions(self):
        code, _ = r.export_plan("L1", "t", {"total_questions": 0, "topics": []}, self.complete, self.state, send=lambda *a: [])
        self.assertEqual((code, self.calls), (400, 0))

    def test_email_not_configured_still_returns_plan(self):
        def send(*a): raise r.EmailNotConfigured("email isn't set up yet: set NOVA_SMTP_HOST")
        code, out = r.export_plan("L1", "t", DATA, self.complete, self.state, send=send, now=1)
        self.assertEqual((code, out["sent"], "blocks" in out["plan"]), (503, False, True))
        self.assertNotIn("L1", self.state["sent"])  # a failed send doesn't start the cooldown


if __name__ == "__main__":
    unittest.main()
