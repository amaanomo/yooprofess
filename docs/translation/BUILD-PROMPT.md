# Build prompt: translated subtitles and spoken translation for Orbit

You are adding **translation** to Orbit, the Chrome extension in this repo (`amaanomo/yooprofess`). A student picks a language and gets three things:

1. **Translated subtitles** over the Panopto video, styled so they're clearly Orbit's and not Panopto's auto-captions.
2. Optional **spoken translation**: Orbit reads the translated lines aloud, synced to the video, with the professor's audio turned down.
3. **Orbit's chat answers** in that language.

Translation works from the **captions (text)**. We never translate the audio directly, and we never imitate the professor's voice.

**Design reference:** `docs/translation/subtitles-prototype.html`. Open it in Chrome; it's a working mock of the real UB Panopto viewer with the full design and interactions. Match its look and behaviour. Everything you need is also written out below, so the prompt stands on its own.

---

## 0. How to work

- **Get the code current:** `git pull` on `main`, then branch to `feature/translation`. Open a PR into `main` when done; don't push to `main` directly.
- **Read before writing.** Read the existing extension and backend first, and follow their patterns:
  - Shadow DOM UI
  - every backend call goes through the service worker
  - request/response shapes in one "Backend contract" section
  - `[Orbit]` log prefix
  - no build step

  Don't rewrite working code; extend it.
- **Build in the order in §9.** Commit after each phase, with the extension loading and working at every commit.
- **Write down any call you make** that this prompt doesn't settle, and list them in the PR description.

## 1. What exists today

- `extension/`: a Manifest V3 extension. It's plain JS/CSS with no build step and is loaded with "Load unpacked".
  - **`content.js`** runs in Panopto `Viewer.aspx` / `Embed.aspx` frames (`all_frames`, so it also works inside Canvas iframes), but only when the URL has an `id`. It does the following:
    - fetches captions with the student's session from `CAPTION_URL` (`{origin}/Panopto/Pages/Transcription/GenerateSRT.ashx?id={id}&language=0`)
    - parses them with `srt.js` into `[{start, end, text}]`, in seconds
    - caches them in `chrome.storage.local` (`orbit:captions:<id>`)
    - uploads them to `POST /lectures`
    - follows the `<video>` element (a MutationObserver handles late or replaced videos; it prefers `#primaryVideo`)
    - runs the chat (`POST /ask` with the last 90 s of captions)
    - parses a `Watch: M:SS-M:SS, label` line from replies into a ▶ seek button

    All request/response shapes live in its **"Backend contract"** section.
  - **`background.js`** is the service worker. It runs the toolbar toggle and is the only place that talks to the backend. It holds `BACKEND_URL` (the Railway deployment) and `STUB_MODE` (now `false`).
  - **`overlay.js` / `overlay.css`** contain the "Ask Orbit" card in a Shadow DOM root on `<orbit-overlay>`, fixed bottom-left, 560px wide.
    - Its parts are a header, a mint "Using the last 90 seconds of captions" strip, the chat, the chips, the input and a footer. It minimizes to a round launcher button.
    - A capture-phase keyboard guard installed at `document_start` stops Panopto's shortcuts from firing while the student types in Orbit. Because of that guard, Orbit's own key handling (such as Escape) goes through its `onKey` hook.
  - **`srt.js`** holds pure helpers (`parseSRT`, `captionWindow`, `formatTime`, `parseTimestamp`) with Node tests (`node extension/srt.js`).
- **`backend/server.py`** is a Python `http.server` app on Railway. It calls Claude through the `anthropic` SDK (`ORBIT_MODEL`, default `claude-sonnet-5-5`) and has CORS headers.
  - `POST /lectures` stores captions in memory (lost on restart).
  - `POST /ask` answers from the full transcript plus full subject knowledge, and ends with a `Watch:` line.

**Brand:** green `#2E6B57`, deep green `#14342A`, lime `#C6E86B`, live dot `#9BE36D`, mint `#EBF5F0`, mint line `#D8EAE1`, ink `#1C2924`, muted `#8A9590`, font `system-ui`.

**Panopto's viewer layout:**
- top bar with the course breadcrumb
- **left column:** a small **camera** video (with ⇄ swap and fullscreen buttons), then search and the Captions / Contents / Notes tabs
- **right:** the large **screen/slides** video
- **under it:** a white control bar (±10 s, time, blue progress bar, remaining time, volume, **CC**, settings), then a thumbnail strip

The Orbit card sits bottom-left over the left column and can overlap the left edge of the main video.

## 2. Settings and controls (inside the Orbit card)

All controls live **in the Orbit card**, with no separate floating panel and no new header buttons (the header must keep matching the original mockup).

### 2a. Strip button
In the mint captions strip, right-aligned: a 30px-tall pill whose look follows the state. The strip's own text truncates with an ellipsis; the button never wraps.

| State | Look | Label |
|---|---|---|
| Off | white, green outline, pale mini-planet | `Subtitles: Off ▾` |
| On | filled `#2E6B57`, white text, lime mini-planet | `ES · Translated ▾` / `ES · Dual ▾` / `ES · 🔊 Voice ▾` |
| Translating | filled green, the planet's ring spins, a 16px lime progress ring | `ZH ◔ 22% ▾` |

The **mini-planet** is a lime circle holding a dark-green planet with a tilted ring (same SVG as the prototype).

### 2b. Popover
It opens from the strip button: 286px wide, 14px radius, soft shadow, scaling in from the top right. It's anchored under the strip on the right and sits above the chat. It closes on an outside click or Escape (through the key guard's `onKey`). It contains:

1. **Title** "Translated subtitles", with the line "Orbit translates the captions and shows them over the video."
2. **Language radio list:** Off, then `SUBTITLE_LANGUAGES`.
   - Each row shows a small code (`ES`), the native name, and a right-hand state: **On** (active), **Ready** (fully cached), **NN%** (partly translated) or blank.
   - **Picking a language turns subtitles on immediately** and starts translating from the playhead.
3. **Mode:** a segmented **Translated | Dual** control, disabled when Off. Dual puts the professor's original line small and italic above the translation.
4. **🔊 Spoken translation:** a row with a switch (§6), disabled when Off. Under the title, a one-line note shows the voice status.
5. **Progress:** "Translating… 22% of this lecture" with a thin lime bar, or "Whole lecture translated".
6. **Footnote:** "Panopto's own captions stay as they are; use its CC button."

`SUBTITLE_LANGUAGES`, one constant of `{ code, label, speechLang }`:
- es Español (es-ES)
- zh-Hans 中文 (zh-CN)
- hi हिन्दी (hi-IN)
- ko 한국어 (ko-KR)
- ar العربية (ar-SA)
- fr Français (fr-FR)
- pt Português (pt-BR)
- vi Tiếng Việt (vi-VN)
- ja 日本語 (ja-JP)

The short code shown in the UI is the uppercase base of `code` (`ES`, `ZH`, ...).

### 2c. Other surfaces
- **Chat notices** (status lines, not saved in history): "Subtitles on in Español." When translating, add "Translating from where you are…". After a reload with voice on, show "Tap to resume spoken translation" with a button (§6).
- **`⋯` menu:** add a "Subtitles…" item that opens the same popover.
- **Optional:** add an Orbit pill to **Panopto's control bar**, just left of CC.
  - It shows the mini-planet, the code, and `🔊` and/or progress (`ES 42%`).
  - Clicking it toggles subtitles on and off, keeping the last language, mode and voice.
  - Use its own shadow host, found with `PANOPTO_CONTROLBAR_SELECTORS` (unverified). Re-insert it if Panopto re-renders the bar, and fail quietly if the bar isn't found.

### 2d. Persistence
`chrome.storage.local["orbit:subtitles"] = { language: "es" | null, mode: "translated" | "dual", voice: boolean, lastLanguage }`. It's **global**, so it carries across lectures.

## 3. Getting translations (extension side)

1. **Panopto's own translations first.** Some lectures have professor-uploaded captions in other languages at the same caption URL with a different `language=` number.
   - Keep `PANOPTO_LANGUAGE_IDS` (code → number) in one constant, **marked unverified with a TODO**.
   - Try that URL first. If it parses to cues that line up with the originals, use them (source `"panopto"`). Otherwise fall through quietly.
2. **Otherwise, use Orbit's backend** (`POST /translate`, §4) through the service worker, with a new message type `ORBIT_TRANSLATE`.
3. **Scheduler** (pure logic in `extension/translator.js`, testable in Node):
   - **Batches:** about **60 cues** per batch.
   - **Order:** start ~10 s before the playhead, go forward to the end, then fill in the beginning.
   - **On seek** into an untranslated region, that region jumps to the front of the queue.
   - **Concurrency and retries:** at most **2 requests at once**. Retry a failed batch twice with backoff (1 s, 3 s). After that, mark it failed: those lines show as untranslated, and the popover offers "Retry".
   - **Cache:** `chrome.storage.local["orbit:translations:<lecture_id>:<code>"] = { [i]: text }`. Write it after every batch so progress survives a reload, and translate only missing indexes. Log `[Orbit] Translations: N/M cached` on load.
   - **Progress** is translated cues ÷ total cues.
   - **Switching language or lecture** cancels outstanding work for the old one. Finished batches stay cached.
4. **STUB_MODE** (in `background.js`): `/translate` returns `"[ES] " + text` for each cue after 600 ms, so the whole flow demos offline.

**Contract**, added to "Backend contract" in `content.js` as `buildTranslatePayload` / `readTranslateResponse`, a proposal for the backend owner:

```json
// POST <BACKEND_URL>/translate
{ "lecture_id": "...", "target_language": "es", "title": "...",
  "cues": [{ "i": 120, "start": 361.0, "end": 363.9, "text": "..." }] }

// 200 OK
{ "translations": [{ "i": 120, "text": "...", "fallback": false }] }
```

`i` is the index in the full caption list. Every input `i` comes back exactly once, and timing never changes.

## 4. Backend (`backend/server.py`)

- **`POST /translate`:** next to `/ask`, with the same CORS headers and error handling. Reject more than 100 cues with HTTP 400.
- **Claude call:** system prompt in its own constant. It tells the model to:
  - translate university lecture captions into `<language name>`
  - **return JSON only:** `{"translations":[{"i":...,"text":"..."}]}`, one entry per input cue, same `i`s
  - keep each line subtitle-short
  - use the lecture title and neighbouring lines as context, since sentences are split across cues, but **never move words between cues**
  - keep code, identifiers, math, Big-O notation and proper nouns as they are, and keep the course's technical terms (add the original in parentheses the first time when useful)
- **Validate the reply:** parse it (tolerate a fenced code block), check every requested `i`, and retry once for missing ones. If they're still missing, return the original text with `"fallback": true`.
- **Server cache:** `TRANSLATIONS[(lecture_id, code, i)]`, so repeat requests are free until a restart. Persistent storage is out of scope; note it.
- **`/ask`:** accept an optional `"language"`. When it's present, append to the system prompt: "Reply in <language name>." The `Watch: M:SS-M:SS, ...` line must keep exactly that format, because the extension parses it.

## 5. Subtitle overlay (`extension/subtitles.js` + `extension/subtitles.css`)

### Where it goes
- **Its own Shadow DOM host**, `<orbit-subtitles>`, separate from the card, so subtitles still show when the card is minimized or hidden. It's `pointer-events: none` and never blocks the player.
- **Over the main video:** the visible `<video>` with the largest on-screen area, which is normally the slides stream.
  - Re-pick it on ⇄ swap, resize and DOM changes.
  - This can differ from the video Orbit follows for time; both share the same clock.
- **Positioning:** fixed, using `getBoundingClientRect()`. Update on `resize`, `scroll`, a `ResizeObserver` on the video, and once per animation frame while playing. Touch the DOM only when the rect changes.
- **Clip to the video rect.** The pill never spills onto the control bar or the left column.
- **Clear of the Orbit card:** centre the pill in the part of the video the open card doesn't cover, from `max(video.left, card.right + 16px)` to `video.right`, with `max-width` 90% of that span. Use the full width when the card is minimized or hidden, and recompute when the card changes.
- **Vertical position:** sit **12px above Panopto's caption box** when it's visible (measure its height, so a two-line caption never overlaps). Use `PANOPTO_CAPTION_SELECTORS`, marked unverified. If no caption box is found, sit 15% up from the video's bottom.
- **Fullscreen:** on `fullscreenchange`, move the host into `document.fullscreenElement`, and back out afterwards.

### Look (clearly different from Panopto's white-on-black box)
- **Pill:** 18px radius, padding `10px 20px 11px 10px`.
  - Background `rgba(20,52,42,.86)` with `backdrop-filter: blur(12px) saturate(140%)`.
  - Shadow `0 10px 30px rgba(8,24,18,.35)`, plus inner lime border `inset 0 0 0 1px rgba(198,232,107,.28)`.
- **Badge (left):** a 30px lime circle with the planet SVG (glow `0 0 0 3px rgba(198,232,107,.18)`). Under it, the language code in 9.5px/800 lime caps, and, in voice mode, three sound bars next to the code (§6).
- **Text:** white, weight 600, `line-height 1.38`, `text-wrap: balance`. Size it relative to the **video width**, roughly 1.45% of it, clamped to 13–19px.
- **Dual:** the original line above, about 70% size, italic, `rgba(255,255,255,.58)`.

### Motion (all off under `prefers-reduced-motion`)
- **New line, "orbit sweep":** a lime arc runs once around the border. Use a conic gradient driven by `@property --a` animated 0→360deg over 900 ms `cubic-bezier(.4,.1,.2,1)`, masked to a 1.6px ring, fading out at the end.
- **Words fade in:** opacity 0→1, blur 5px→0, translateY 5px→0, 380 ms each, staggered 28 ms per word. For CJK, stagger per character at 12 ms, or 12 ms per word for lines over 30 words.
- **Untranslated line:** two shimmering lime-tinted bars and "Translating…", with the planet ring spinning. In Dual mode the original still shows above.
- **No cue at the current time:** fade out over 150 ms.

### Accessibility
- The subtitle host is `aria-live="off"`.
- The popover controls are real buttons, radios and switches with labels, all usable from the keyboard.

## 6. Spoken translation (`extension/voice.js`)

- **Turning it on:** the switch in the popover. When it's on:
  - the strip button reads `ES · 🔊 Voice`, and the optional control-bar pill shows `🔊`
  - subtitles stay visible
- **Provider interface:** `TTS_PROVIDER` with `speak(text, {lang, rate}) → {onstart, onend}`, `cancel()`, `pause()` and `resume()`.
  - **v1 is the browser's `speechSynthesis`** (from the content script): no server, no cost.
  - Leave a commented stub for a future cloud provider (a backend `/tts` endpoint returning cached audio per cue). Don't build it.
- **Choosing a voice:**
  - Match `speechLang` by language prefix, preferring names with Premium, Enhanced, Natural, Neural or Google. Refresh on `voiceschanged`.
  - **No matching voice:** use the default voice, and show the note "No Español voice on this computer, so the default voice is used. Install one in system settings."
  - **Voice found:** show "Speaking with <name>. Professor's audio lowered to 15%."
- **Never imitate the professor.** Use a neutral narrator voice only.
- **Sync rules:**
  - **When to speak:** a line plays when playback enters its cue, and only if the playhead is within **1.5 s** of the cue start. Otherwise wait for the next cue, so speech never starts mid-sentence after a seek.
  - **Fitting the slot:** `rate = clamp(estimate / (cueDuration − 0.4 s), 1.0, 1.3) × video.playbackRate`. The estimate is characters ÷ characters-per-second, from a per-language constant `SPEECH_CPS`: es 15, fr 15, pt 15, vi 13, hi 13, ar 12, ko 7, ja 7, zh 5. Never slow below 1.0.
  - **Running long:** if a line is still speaking when the next starts, queue the next. If **two or more** are waiting, cancel the backlog and speak the current line, so it's never more than one sentence behind.
  - **Video controls:** video `pause` pauses speech and `play` resumes it. `seeking`, `emptied`, a language or mode change, voice off, or a lecture change all cancel speech.
  - **Untranslated line:** stay silent; never read the English.
  - **Optional improvement:** merge consecutive cues into sentences (split on `.?!。？！`) and speak each sentence over the merged time span.
- **Professor's audio:** while voice is on, set `volume = 0.15` on **every** `<video>`, since the camera stream usually carries the audio.
  - Remember each video's previous volume, and restore it when voice turns off, the language goes Off, or the page unloads (`pagehide`).
  - If the student changes a video's volume themselves, stop managing that video.
  - Apply this to videos added later as well.
- **Visuals:** while speaking, three 2px lime bars next to the language code in the pill animate from 3px to 9px tall, staggered by 0.15 s. They're static under reduced motion.
- **Chrome's click requirement:** call `speechSynthesis.speak()` once, with an empty utterance, **inside the switch's click handler**. After a reload with voice saved as on, show the "Tap to resume spoken translation" notice; its button does the same.
- **Logging:** `[Orbit voice] 7:48 ES rate 1.12 · <voice name>: <text>`.

## 7. Chat in the chosen language

- `/ask` sends `language` (the label, e.g. "Spanish (Español)") whenever subtitles are on.
- The ▶ Watch button must keep working.
- The welcome message, chips, strip text and notices stay in English for now; note it in the README.

## 8. Files and constraints

- **New files:**
  - `extension/translator.js`: the scheduler, cache merge and progress; pure where possible, so it's testable in Node.
  - `extension/subtitles.js` and `extension/subtitles.css`: the overlay and its positioning.
  - `extension/voice.js`: the TTS provider, sync and ducking.
- **Edits:**
  - `content.js`: orchestration and the contract.
  - `overlay.js` / `overlay.css`: strip button, popover, notices, `⋯` item.
  - `background.js`: `ORBIT_TRANSLATE` and its stub.
  - `manifest.json`: script order `srt.js, translator.js, voice.js, subtitles.js, overlay.js, content.js`, and `subtitles.css` in `web_accessible_resources`.
  - `backend/server.py`.
- **Constraints:**
  - Plain JS/CSS, no build step, no new extension dependencies. The backend uses only `anthropic`.
  - Build DOM with DOM APIs, and set every caption, translation or reply with `textContent`.
  - **Send nothing new** beyond the lecture ID, title, caption text with timings, the target language, and the student's questions.
  - All existing behaviour keeps working, and `node extension/srt.js` still passes. Add Node tests for:
    - the batch order given a playhead index, including re-prioritizing after a seek
    - the cue lookup at a given time
    - the speech-rate function
  - Every tunable value (batch size, concurrency, the 1.5 s threshold, the rate cap, duck volume, `SPEECH_CPS`, selectors) is a named constant at the top of its file.

## 9. Build order (commit after each)

1. **Contract and backend:** `/translate` and the `/ask` language field in `server.py`, the contract in `content.js`, and `ORBIT_TRANSLATE` with its stub in `background.js`.
2. **Translator:** `translator.js` scheduler and cache, with Node tests.
3. **Controls:** strip button, popover and persistence in the card.
4. **Overlay:** `subtitles.js` / `.css`, covering positioning, card avoidance, Panopto caption avoidance, fullscreen, the look and the motion.
5. **Voice:** `voice.js`, covering the provider, sync, rate, queueing and ducking.
6. **Extras:** the optional control-bar pill, the README and the PR.

## 10. Done when

- **First lines appear fast:** picking Español in the popover shows the first translated line within a few seconds near the playhead, and progress then climbs to 100% in the background.
- **Seeking:** jumping to an untranslated part shows the "Translating…" pill, and that region is translated next.
- **Reload:** no re-translation; the cache is used and the console shows `Translations: N/N cached`.
- **Placement:**
  - the pill sits over the main video, above Panopto's caption box (even two-line ones), and centred in the part of the video the open card doesn't cover
  - it follows resizes and ⇄ swaps
  - it works in fullscreen and inside Canvas
- **Modes:** Dual shows the original above the translation, and Off removes everything.
- **Strip button:** it correctly shows Off, On, Translating (with the ring) and Voice.
- **Voice:**
  - **Speaking:** turning on 🔊 reads each translated line as the video reaches it, speeding up only up to 1.3×.
  - **Pause and seek:** it pauses with the video and stops on seek.
  - **Untranslated lines:** silent.
  - **Professor's audio:** lowered to 15% and restored exactly when voice is turned off.
- **Chat:** with Español on, a question gets a Spanish answer, and ▶ Watch still seeks.
- **Offline:** with `STUB_MODE = true`, the whole flow works with `[ES] …` fake translations.
- **Tests:** all Node tests pass, and nothing in the existing extension regressed.

## 11. Deliverables

1. The code (extension and backend) on `feature/translation`, with a PR into `main`.
2. `extension/README.md` updates: how to use subtitles and voice, the new constants, the `/translate` contract, and how to test each state:
   - cached
   - translating
   - seek to untranslated
   - backend down
   - stub mode
   - Panopto native translation
   - voice with and without an installed voice
3. A list of what couldn't be verified without real Panopto:
   - Panopto's language IDs
   - the caption-box and control-bar selectors
   - which stream carries the audio
   - fullscreen and Canvas behaviour
   - real `/translate` latency and cost for a 75-minute lecture
   - how the built-in voices sound per language on Mac and Windows
4. A short note to the team. The Railway server has **no authentication**, and `/translate` costs far more per call than `/ask`. Add a shared-secret header or a per-IP rate limit before sharing the extension widely, and move the caches to persistent storage.
