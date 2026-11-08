"""Run from the backend folder:  cd backend && python3 -m unittest test_complete"""
import unittest
from types import SimpleNamespace

import anthropic
import httpx

import server


def bad_request(message):
    resp = httpx.Response(400, request=httpx.Request("POST", "http://x"))
    return anthropic.BadRequestError(message, response=resp, body=None)


class FakeClient:
    def __init__(self, fail_on_effort=False):
        self.calls = []
        self.fail_on_effort = fail_on_effort
        self.messages = SimpleNamespace(create=self.create)

    def create(self, **kw):
        self.calls.append(kw)
        if self.fail_on_effort and "output_config" in kw:
            raise bad_request("This model does not support the effort parameter.")
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=" hi ")])


class Effort(unittest.TestCase):
    def setUp(self):
        self.saved = (server.PROVIDER, server.ANTHROPIC_MODEL, server.chat_client)
        server.PROVIDER = "anthropic"

    def tearDown(self):
        server.PROVIDER, server.ANTHROPIC_MODEL, server.chat_client = self.saved

    def run_complete(self, model, client):
        server.ANTHROPIC_MODEL = model
        server.chat_client = lambda: client
        return server.complete("sys", "user", 100, effort="low")

    def test_haiku_never_gets_effort(self):
        client = FakeClient()
        self.assertEqual(self.run_complete("claude-haiku-4-5-20251001", client), "hi")
        self.assertEqual(len(client.calls), 1)
        self.assertNotIn("output_config", client.calls[0])

    def test_sonnet_gets_effort(self):
        client = FakeClient()
        self.run_complete("claude-sonnet-5-5", client)
        self.assertEqual(client.calls[0]["output_config"], {"effort": "low"})

    def test_unknown_model_that_rejects_effort_is_retried_without_it(self):
        client = FakeClient(fail_on_effort=True)
        self.assertEqual(self.run_complete("claude-future-9", client), "hi")
        self.assertEqual(len(client.calls), 2)
        self.assertNotIn("output_config", client.calls[1])

    def test_other_bad_requests_still_raise(self):
        client = FakeClient()
        client.create = lambda **kw: (_ for _ in ()).throw(bad_request("prompt is too long"))
        client.messages = SimpleNamespace(create=client.create)
        with self.assertRaises(anthropic.BadRequestError):
            self.run_complete("claude-sonnet-5-5", client)


if __name__ == "__main__":
    unittest.main()
