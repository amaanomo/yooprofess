# Orbit — an AI tutor that follows along with your lecture

> **Status: design stage.** Orbit isn't built yet. This README describes what we plan to build. So far there's a design mockup in Figma, shown over a placeholder lecture recording.

Orbit is a study companion that will live on top of recorded lectures (for example, a Panopto recording). While a student watches, Orbit follows the playback position, reads what the professor just said, and answers questions about it. It answers the way the professor taught it, points back to the exact moment in the video, and can switch into a full lesson with a whiteboard when the student needs to go deeper.

> "Hey! I'm Orbit. I'm following along with this lecture. Ask me anything about what was just said."

![Figma design: Orbit open over a CSE 368 lecture recording](docs/screenshot.png)

---

## The problem

Recorded lectures are passive. When a student gets lost at minute 7, their options are to rewind and rewatch, search the web (and get an explanation that doesn't match how their professor taught it), or wait for office hours. Orbit gives them a tutor in the moment, grounded in *their* lecture.

## Planned features

### Ask Orbit (quick help while watching)
- **Floating panel** over the lecture player, which can be minimized so it doesn't block the video.
- **Follows the playback position.** The header shows where Orbit is in the lecture ("Following at 7:48") and updates as the video plays or the student scrubs.
- **Context from recent captions.** Each question is answered using a rolling window of the transcript (for example, the last 90 seconds), shown in a banner so the student knows what Orbit is looking at.
- **Suggested questions** generated from what was just said (for example, "Explain what a prompt is", "Why use a local model?", "Give me an example").
- **Chat input** scoped to the current moment: "Ask about what was just said…"
- **Accuracy reminder** under the input: Orbit can make mistakes, so students should check important details.

### Explain in depth (teaching dashboard)
Quick answers in the panel are good for "what did she just say?" When a student needs to really understand a concept, they choose **Explain in depth** and Orbit opens a **teaching dashboard in a new tab**.

The dashboard is a one-on-one lesson with Professor Orbit:

- **Professor Orbit** walks through the concept step by step, like a professor at office hours, starting from what the lecture covered and building up from there.
- **Whiteboard.** As Orbit explains, it draws: diagrams, flowcharts, labeled examples, and visuals that build up step by step alongside the explanation, so students can *see* the idea, not just read about it.
- **Lecture link.** The concept stays tied to the recording, with a reference back to the moment it came up so the student can return to the video.
- **Keep asking.** Students can interrupt, ask follow-ups, or say "show me another example," and Orbit keeps teaching on the same board.

The dashboard opens already knowing the concept, the lecture, and the timestamp the student came from, so there's nothing to re-explain.

### Later
- **Whole-lecture knowledge.** Index the full transcript and slide text so Orbit can answer questions about anything in the course, not just the last few minutes.
- **Timestamp citations.** Every lecture-based answer links to the moment it came from ("explained at 12:03"), and clicking it seeks the video.
- **Voice mode.** Talk to Orbit and hear it answer, with support for interrupting mid-sentence and with whiteboard drawing synced to speech.
- **Shared whiteboard.** Students can draw on the board too, so Orbit can react to their sketches.
- **Code sandbox** for running and modifying examples during CS lectures.
- **Quizzes and mastery tracking**, generated from lecture content.
- **Professor controls.** Instructors can review what Orbit knows, add notes on common misconceptions, and set rules such as "guide students on homework, don't give answers."

---

## How it will work

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
        │  "Explain in depth"
        ▼
 Teaching dashboard (new tab)
   ├── Professor Orbit: step-by-step lesson
   └── Whiteboard: diagrams drawn as Orbit explains
```

1. **Playback sync.** Orbit reads the player's current time.
2. **Context window.** It collects caption lines from the recent stretch before the playhead.
3. **Answering.** The question and that context go to the model, with instructions to explain using the professor's own framing and examples, and to say clearly when it is going beyond what the lecture covered.
4. **Suggestions.** When the context changes, Orbit proposes a few follow-up questions about the current segment.
5. **Going deeper.** Choosing "Explain in depth" opens the teaching dashboard in a new tab, passing along the concept, the lecture, and the timestamp. There, Orbit plans a short lesson and draws on the whiteboard step by step as it explains each part.

### Design principles
- **Lecture first.** Professors teach the same concept in different ways. Orbit should reinforce how *this* professor taught it, not contradict it.
- **Teach, don't just answer.** Check understanding, give an example, and offer a follow-up question.
- **Be transparent.** Always show what context Orbit used and where an answer came from.
- **Stay out of the way.** In the panel, the video is still the main thing on screen. The dashboard is where Orbit takes center stage.

---

## Current progress

- [x] UI design for the Ask Orbit panel over a lecture recording (Figma)
- [ ] UI design for the Explain in depth dashboard
- [ ] Choose the tech stack and model provider
- [ ] Caption sync with a lecture player
- [ ] Ask Orbit panel
- [ ] Teaching dashboard and whiteboard
- [ ] Pilot with a real course

## Privacy and responsible use

- Lecture recordings and transcripts belong to the instructor and institution. Get permission before processing them.
- Student questions and learning data may be covered by FERPA (in the US) and university data policies. Store as little as possible and never use it to train models without consent.
- Orbit can be wrong. Answers grounded in the lecture should cite where they came from so students can check.
- Any feature that imitates a professor's voice requires that professor's explicit consent.

## Demo context

The design shows Orbit over a mock recording of **CSE 368: Artificial Intelligence** at the University at Buffalo, during an in-class activity on building a job description analyzer (input → prompt → structured output). The course content is used for demonstration only.

## License

TBD
