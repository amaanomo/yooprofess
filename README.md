# Nova — an AI tutor that follows along with your lecture

> **Status: design stage.** Nova isn't built yet. This README describes what we plan to build. So far there's a design mockup in Figma, shown over a placeholder lecture recording.

Nova is a study companion that will live on top of recorded lectures (for example, a Panopto recording). While a student watches, Nova follows the playback position, reads what the professor just said, and answers questions about it. It draws on the lecture, the professor's framing, and live web knowledge — all at once — and can switch into a full lesson with a whiteboard when the student needs to go deeper.

> "Hey! I'm Nova. I'm following along with this lecture. Ask me anything about what was just said."

![Figma design: Nova open over a CSE 368 lecture recording](docs/screenshot.png)

---

## The problem

Recorded lectures are passive. When a student gets lost at minute 7, their options are to rewind and rewatch, search the web (and get an explanation that doesn't match how their professor taught it), or wait for office hours. Nova gives them a tutor in the moment, grounded in *their* lecture — but with the full knowledge of the subject behind it.

## Planned features

### Ask Nova (quick help while watching)
- **Floating panel** over the lecture player, which can be minimized so it doesn't block the video.
- **Follows the playback position.** The header shows where Nova is in the lecture ("Following at 7:48") and updates as the video plays or the student scrubs.
- **Blended answers.** Every response combines what the professor said with broad subject knowledge and live web research — all clearly labeled. Nova doesn't limit itself to the last 90 seconds; it knows the field the way a good tutor would.
- **Source labels.** Each answer shows where it came from: *"Your professor covered this at 7:48 →"* for lecture content, clearly separated from general or web-sourced knowledge.
- **Suggested questions** generated from what was just said (for example, "Explain what a prompt is", "Why use a local model?", "Give me an example").
- **Chat input** scoped to the current moment: "Ask about what was just said…"
- **Accuracy reminder** under the input: Nova can make mistakes, so students should check important details.

### Timestamp search
Students can ask natural questions like *"where did he talk about recursion?"* and Nova searches the full lecture transcript, finds every mention, and returns a priority list:

> "He covered this in 3 places:
> **→ 7:48** *(most relevant — full explanation)*
> → 12:03 *(brief mention)*
> → 24:15 *(example walkthrough)*"

Each result is a clickable button that seeks the video to that exact moment. The most relevant timestamp is highlighted at the top.

### Explain in depth (teaching dashboard)
Quick answers in the panel are good for "what did she just say?" When a student needs to really understand a concept, they choose **Explain in depth** and Nova opens a **teaching dashboard in a new tab**.

The dashboard is a one-on-one lesson with Professor Nova:

- **Professor Nova** walks through the concept step by step, like a professor at office hours, starting from what the lecture covered and building up from there using full subject knowledge and live web research.
- **Whiteboard.** As Nova explains, it draws: diagrams, flowcharts, labeled examples, and visuals that build up step by step alongside the explanation, so students can *see* the idea, not just read about it.
- **Code walkthrough** ✅ When the question, Nova's answer, or the professor's screen has code in it, Deep Dive asks whether to walk through the code or explain with a diagram. The walkthrough shows the code on the left with the current lines highlighted and builds up one explanation card per step on the right (at most 25 lines, the part the question is about). Code read from the video is marked "may contain small mistakes". You can switch between the two views at any time, and Simpler, Deeper, follow-ups and the lesson language all work in both. Backend: `POST /explain/code` finds the code; `POST /explain` with `mode: "code"` plans the walkthrough.
- **Lecture link.** The concept stays tied to the recording, with a reference back to the moment it came up so the student can return to the video.
- **Keep asking.** Students can interrupt, ask follow-ups, or say "show me another example," and Nova keeps teaching on the same board.

The dashboard opens already knowing the concept, the lecture, and the timestamp the student came from, so there's nothing to re-explain.

### Later
- **Voice mode** ✅ first version: say "Hey Nova" on a lecture (Chrome speech recognition), spoken with an ElevenLabs voice in English (Scribe v2 for speech-to-text, streamed replies) and free Chrome voices for other languages and as the automatic fallback, interrupting mid-sentence, and voice video control ("go back 30 seconds", "where did he cover X?"). Still to come: whiteboard drawing synced to speech.
- **Shared whiteboard.** Students can draw on the board too, so Nova can react to their sketches.
- **Code sandbox** for running and modifying examples during CS lectures.
- **Quizzes and mastery tracking**, generated from lecture content.
- **Professor controls.** Instructors can review what Nova knows, add notes on common misconceptions, and set rules such as "guide students on homework, don't give answers."

---

## How it will work

### Multi-agent architecture

Nova runs five specialized agents that work in parallel, each with a distinct job:

```
 Lecture recording (Panopto)
        │  playback time + captions
        ▼
 ┌─────────────────────────────────────────────────┐
 │  The Listener                                   │
 │  Passive mode: rolling caption window           │
 │  Active mode: full-transcript search            │
 │  → surfaces context + ranked timestamps         │
 └───────────────────┬─────────────────────────────┘
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
 ┌────────────────┐   ┌──────────────────────┐
 │ The Researcher │   │   The Answerer        │
 │ Live web search│   │ Blends lecture +      │
 │ on the topic   │   │ web into one response │
 └────────────────┘   └──────────┬───────────┘
                                 │
                                 ▼
                      ┌──────────────────────┐
                      │  The Fact-Checker     │
                      │ Flags anything that   │
                      │ contradicts the       │
                      │ professor's framing   │
                      └──────────┬───────────┘
                                 │
                    Ask Nova panel (chat, timestamps,
                    suggested questions)
                                 │  "Explain in depth"
                                 ▼
                      ┌──────────────────────┐
                      │    The Teacher        │
                      │ Plans a full lesson,  │
                      │ directs the whiteboard│
                      └──────────────────────┘
```

**The Listener** tracks the playhead and manages two modes:
- *Passive* — rolling caption window following playback in real time
- *Active* — full-transcript search when a student asks "where did he talk about X?", returning a ranked list of timestamps

**The Researcher** runs in parallel the moment a question comes in. It does a live web search on the topic — completely independent from the lecture — so Nova knows the subject as a field, not just what the professor said in the last few minutes.

**The Answerer** receives both feeds simultaneously: the lecture context from the Listener and the web knowledge from the Researcher. It blends them into one response, clearly labeling what came from the lecture (with a timestamp button) versus broader knowledge.

**The Fact-Checker** runs after the Answerer. It compares the response against the actual transcript and flags anything that contradicts how the professor taught it specifically, reinforcing the lecture-first principle without limiting the answer.

**The Teacher** takes over when a student clicks "Explain in depth." It has access to the lecture, the timestamp, and the Researcher's web knowledge — so it can plan a full lesson that starts where the professor left off and builds from there.

### Design principles
- **Lecture first.** Professors teach the same concept in different ways. Nova should reinforce how *this* professor taught it, not contradict it.
- **Full subject knowledge.** Being grounded in the lecture doesn't mean being limited to it. Nova knows the field and uses live web research to give complete answers.
- **Teach, don't just answer.** Check understanding, give an example, and offer a follow-up question.
- **Be transparent.** Always show what context Nova used and where an answer came from — lecture timestamp, general knowledge, or web source.
- **Stay out of the way.** In the panel, the video is still the main thing on screen. The dashboard is where Nova takes center stage.

---

## Current progress

- [x] UI design for the Ask Nova panel over a lecture recording (Figma)
- [ ] UI design for the Explain in depth dashboard
- [ ] Choose the tech stack and model provider
- [ ] Caption sync with a lecture player
- [ ] Ask Nova panel
- [ ] Multi-agent pipeline (Listener, Researcher, Answerer, Fact-Checker, Teacher)
- [ ] Timestamp search with ranked results
- [ ] Teaching dashboard and whiteboard
- [ ] Pilot with a real course

## Privacy and responsible use

- Lecture recordings and transcripts belong to the instructor and institution. Get permission before processing them.
- Student questions and learning data may be covered by FERPA (in the US) and university data policies. Store as little as possible and never use it to train models without consent.
- Nova can be wrong. Answers grounded in the lecture should cite where they came from so students can check.
- Any feature that imitates a professor's voice requires that professor's explicit consent.

## Demo context

The design shows Nova over a mock recording of **CSE 368: Artificial Intelligence** at the University at Buffalo, during an in-class activity on building a job description analyzer (input → prompt → structured output). The course content is used for demonstration only.

## License

TBD
