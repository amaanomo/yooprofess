# Orbit — an AI tutor that follows along with your lecture

Orbit is a study companion that lives on top of recorded lectures (for example, a Panopto recording). While a student watches, Orbit follows the playback position, reads what the professor just said, and answers questions about it. It answers the way the professor taught it, points back to the exact moment in the video, and explains things further when the student needs more.

> "Hey! I'm Orbit. I'm following along with this lecture. Ask me anything about what was just said."

![Orbit open over a CSE 368 lecture recording](docs/screenshot.png)

---

## The problem

Recorded lectures are passive. When a student gets lost at minute 7, their options are to rewind and rewatch, search the web (and get an explanation that doesn't match how their professor taught it), or wait for office hours. Orbit gives them a tutor in the moment, grounded in *their* lecture.

## What it does

### In the current prototype
- **Floating "Ask Orbit" panel** over the lecture player, which can be minimized so it doesn't block the video.
- **Follows the playback position.** The header shows where Orbit is in the lecture ("Following at 7:48") and updates as the video plays or the student scrubs.
- **Context from recent captions.** Each question is answered using a rolling window of the transcript (by default, the last 90 seconds), shown in a banner so the student knows what Orbit is looking at.
- **Suggested questions** generated from what was just said (for example, "Explain what a prompt is", "Why use a local model?", "Give me an example").
- **Chat input** scoped to the current moment: "Ask about what was just said…"
- **Accuracy reminder** under the input: Orbit can make mistakes, so students should check important details.

### On the roadmap
- **Whole-lecture knowledge.** Index the full transcript and slide text so Orbit can answer questions about anything in the course, not just the last 90 seconds.
- **Timestamp citations.** Every lecture-based answer links to the moment it came from ("explained at 12:03"), and clicking it seeks the video.
- **Whiteboard.** Orbit draws diagrams, class hierarchies, and step-by-step worked examples on a shared canvas, and the student can draw back.
- **Voice mode.** Talk to Orbit and hear it answer, with support for interrupting mid-sentence and with drawing synced to speech.
- **Code sandbox** for running and modifying examples during CS lectures.
- **Quizzes and mastery tracking**, generated from lecture content.
- **Professor controls.** Instructors can review what Orbit knows, add notes on common misconceptions, and set rules such as "guide students on homework, don't give answers."

---

## How it works

```
 Lecture recording (Panopto)
        │  playback time + captions
        ▼
 Caption window ──► last N seconds of transcript around the playhead
        │
        ▼
 Orbit tutor (LLM) ◄── student question
        │  answer grounded in the lecture first,
        │  general knowledge clearly labeled as extra
        ▼
 Ask Orbit panel (chat, suggested questions)
```

1. **Playback sync.** Orbit reads the player's current time.
2. **Context window.** It collects caption lines from the last 90 seconds before the playhead.
3. **Answering.** The question and that context go to the model, with instructions to explain using the professor's own framing and examples, and to say clearly when it is going beyond what the lecture covered.
4. **Suggestions.** After the context changes, Orbit proposes a few follow-up questions about the current segment.

### Design principles
- **Lecture first.** Professors teach the same concept in different ways. Orbit should reinforce how *this* professor taught it, not contradict it.
- **Teach, don't just answer.** Check understanding, give an example, and offer a follow-up question.
- **Be transparent.** Always show what context Orbit used and where an answer came from.
- **Stay out of the way.** The video is still the main thing on screen.

---

## Tech stack

- **React + TypeScript** (`src/App.tsx`)
- **CSS** for styling (`src/index.css`)
- **pnpm** for package management
- Initial UI designed and prototyped in **Figma Make**

In this prototype, the Panopto player, captions, and lecture content are mocked inside the app. A production version would connect to the real recording and caption track.

## Getting started

Requirements: Node.js and pnpm.

```bash
pnpm install     # install dependencies
pnpm dev         # start the local dev server
pnpm build       # production build
pnpm format      # format the code
```

## Project structure

```
src/
├── App.tsx      # lecture player mock, transcript, and the Ask Orbit panel
└── index.css    # styles
```

## Configuration

| Setting | Default | What it controls |
|---|---|---|
| Caption window | 90 seconds | How much recent transcript Orbit uses as context |
| Suggested questions | 3 | How many follow-up chips are shown |

---

## Privacy and responsible use

- Lecture recordings and transcripts belong to the instructor and institution. Get permission before processing them.
- Student questions and learning data may be covered by FERPA (in the US) and university data policies. Store as little as possible and never use it to train models without consent.
- Orbit can be wrong. Answers grounded in the lecture should cite where they came from so students can check.
- Any feature that imitates a professor's voice requires that professor's explicit consent.

## Demo context

The screenshots show Orbit over a mock recording of **CSE 368: Artificial Intelligence** at the University at Buffalo, during an in-class activity on building a job description analyzer (input → prompt → structured output). The course content is used for demonstration only.

## License

TBD
