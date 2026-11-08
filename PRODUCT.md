# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

University students — any discipline — watching recorded lectures on Panopto when they get lost, want to check a concept, or need to go deeper. The video is still the main thing on screen; Nova is a floating companion they can dismiss and return to.

## Product Purpose

Nova is an AI tutor that sits on top of a Panopto recording and follows the playback position in real time. When a student has a question, Nova blends what the professor just said with full subject knowledge and live web research into one answer — grounded in the lecture but not limited to it. It can also jump to any timestamp in the lecture by natural language query, or open a full teaching session (Deep Dive) with step-by-step explanation and whiteboard.

## Positioning

Nova knows *this* lecture — the professor's framing, their examples, the moment in the recording — and answers from there, not from a generic subject summary. No other tool combines playhead-aware lecture context with live web research and an escalation path to a full whiteboard lesson.

## Operating Context

- Students are mid-lecture on a Panopto page, often in a browser tab alongside notes.
- The video is the primary artifact; Nova's panel floats bottom-left and can be minimized.
- Questions are usually short bursts: "what is zero-shot?", "where did he talk about recursion?"
- Deeper understanding triggers the Deep Dive tab, which replaces the panel session with a full lesson.
- Backend: Python server on Railway; model provider switchable (Claude / Gemini) via NOVA_PROVIDER env var.

## Capabilities and Constraints

- Chrome extension (Manifest V3), content script + service worker, Shadow DOM isolation.
- Overlay built in pure DOM (no frameworks); styles are Shadow DOM-isolated from Panopto.
- Multi-agent pipeline: Listener, Researcher, Answerer, Fact-Checker, Teacher.
- Translated subtitles feature: Nova translates captions to other languages, with optional spoken voice.
- Timestamp search: natural language → ranked Watch buttons that seek the video.
- Deep Dive button on every Nova reply opens an explain.html lesson tab.
- No persistent storage of student questions or lecture content beyond the session.

## Brand Commitments

- Name: **Nova**
- Character: Nova is a cute, friendly alien — the tutor mascot. Big expressive eyes, round warm shapes, purple antenna orbs, mint-green body. Pixar-side-character energy: approachable, non-intimidating, curious.
- Visual world: **deep-space cinematic**. Near-black backgrounds (#0d0f1c), vivid nebula purple (#7c3aed / #a78bfa) and aurora cyan (#67e8f9) as primary accents, starfield dot patterns, glowing interactive elements. Dramatic and immersive without losing legibility or warmth.
- Voice: casual, direct, supportive. No em dashes. No hedging preamble.

## Evidence on Hand

- Working Chrome extension with overlay.css + overlay.js (Shadow DOM UI).
- Backend on Railway (server.py) handling /ask and /explain endpoints.
- Figma design mockup (reference screenshot in docs/screenshot.png).
- Demo context: CSE 368 Artificial Intelligence, University at Buffalo.

## Product Principles

1. **Lecture-first.** Answers reinforce how this professor taught it, not a generic summary.
2. **Stay out of the way.** The panel is a companion, not a takeover. Minimizable, unobtrusive.
3. **Transparent sourcing.** Always show whether something came from the lecture, general knowledge, or the web.
4. **Teach, don't just answer.** Check understanding, give examples, offer follow-ups.
5. **Earn trust through restraint.** The accuracy reminder and source labels exist because students need to verify.

## Accessibility & Inclusion

WCAG AA contrast minimum. All interactive elements keyboard-accessible. Focus rings visible. ARIA labels on all controls (already implemented in Shadow DOM). Animation disabled via prefers-reduced-motion.
