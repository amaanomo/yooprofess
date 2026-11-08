"""Run from the backend folder:  cd backend && python3 -m unittest test_quiz"""
import json
import unittest

import server

MCQ = {
    "type": "mcq",
    "question": "Which loss is used here?",
    "options": ["MAE", "MSE", "Hinge", "Cross-entropy"],
    "answer": "B",
    "explanation": "The professor squares the errors.",
    "hint": "Think about squaring.",
}


def quiz_line(data):
    return "Quiz: " + json.dumps(data)


class ParseQuiz(unittest.TestCase):
    def test_mcq(self):
        quiz = server.parse_quiz(quiz_line(MCQ))
        self.assertEqual(quiz["type"], "mcq")
        self.assertEqual(quiz["answer"], "B")
        self.assertEqual(quiz["options"], MCQ["options"])
        self.assertEqual(quiz["hint"], "Think about squaring.")

    def test_short(self):
        data = {"type": "short", "question": "What does MSE stand for?", "options": [], "answer": "mean squared error"}
        quiz = server.parse_quiz(quiz_line(data))
        self.assertEqual(quiz["type"], "short")
        self.assertEqual(quiz["options"], [])
        self.assertEqual(quiz["answer"], "mean squared error")

    def test_code_fence_and_prefixes(self):
        data = dict(MCQ, options=["A) MAE", "B) MSE", "C) Hinge", "D) Cross-entropy"], answer="b)")
        quiz = server.parse_quiz("```\n" + quiz_line(data) + "\n```")
        self.assertEqual(quiz["options"], MCQ["options"])
        self.assertEqual(quiz["answer"], "B")

    def test_bad_replies_are_not_quizzes(self):
        self.assertIsNone(server.parse_quiz("The loss is MSE."))
        self.assertIsNone(server.parse_quiz("Quiz: {not json"))
        self.assertIsNone(server.parse_quiz(quiz_line(dict(MCQ, options=["a", "b", "c"]))))
        self.assertIsNone(server.parse_quiz(quiz_line(dict(MCQ, answer="E"))))
        self.assertIsNone(server.parse_quiz(quiz_line(dict(MCQ, type="essay"))))

    def test_quiz_text(self):
        text = server.quiz_text(server.parse_quiz(quiz_line(MCQ)))
        self.assertEqual(text.splitlines(), ["Which loss is used here?", "A) MAE", "B) MSE", "C) Hinge", "D) Cross-entropy"])


class AskResponse(unittest.TestCase):
    def setUp(self):
        self.saved = server.ask

    def tearDown(self):
        server.ask = self.saved

    def test_quiz_reply(self):
        server.ask = lambda body: quiz_line(MCQ)
        out = server.ask_response({"question": "Quiz me on this"})
        self.assertEqual(out["quiz"]["answer"], "B")
        self.assertEqual(out["chips"], ["Hint"])
        self.assertTrue(out["reply"].startswith("Which loss"))

    def test_plain_reply(self):
        server.ask = lambda body: "The loss is MSE."
        self.assertEqual(server.ask_response({"question": "what loss?"}), {"reply": "The loss is MSE."})

    def test_graded_answer_gets_next_chip(self):
        server.ask = lambda body: "Correct. It's MSE."
        out = server.ask_response({"question": "mse", "source": "quiz_answer"})
        self.assertEqual(out, {"reply": "Correct. It's MSE.", "chips": ["Next question"]})


class RecordQuestion(unittest.TestCase):
    def setUp(self):
        self.saved = server.STORE
        self.added = []
        server.STORE = type("S", (), {"add": lambda _, *a: self.added.append(a)})()

    def tearDown(self):
        server.STORE = self.saved

    def test_quiz_answers_and_chips_are_skipped(self):
        server.record_question({"question": "B", "source": "quiz_answer", "lecture_id": "x"}, "t")
        server.record_question({"question": "Quiz me on this", "source": "chip", "lecture_id": "x"}, "t")
        self.assertEqual(self.added, [])
        server.record_question({"question": "what is MSE?", "source": "typed", "lecture_id": "x"}, "t")
        self.assertEqual(len(self.added), 1)


if __name__ == "__main__":
    unittest.main()
