# Nova Chrome extension (extension layer)

This folder is the Chrome extension half of Nova. It detects a Panopto lecture, pulls its captions with the student's own Panopto session, follows the video's playback time, and shows the "Ask Nova" card on the page. The AI, the backend and the professor dashboard live elsewhere (Person 2).

Plain JavaScript, HTML and CSS. No framework, no build step. **New to this? Follow [INSTALL.md](INSTALL.md) for step-by-step install instructions.**

```
extension/
├── manifest.json    MV3 manifest: permissions, content script matches
├── background.js    toolbar button + all backend calls (BACKEND_URL, STUB_MODE)
├── content.js       lecture detection, captions, video tracking, chat (CAPTION_URL, request formats)
├── srt.js           SRT parser + caption-window helper, with tests (node srt.js)
├── translator.js    translation scheduler: batches, priority, retries, cache (node translator.js)
├── voice.js         spoken translation: speech sync and audio ducking (node voice.js)
├── subtitles.js     translated-subtitle overlay over the video (its own Shadow DOM root)
├── subtitles.css    the subtitle pill's styles
├── overlay.js       the Nova card, built inside a Shadow DOM root
├── overlay.css      the card's styles (only apply inside the shadow root)
└── icons/           toolbar icons; put the mascot here as nova.png
```

## Load it

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this `extension/` folder.
3. Open a Panopto lecture (`https://<school>.hosted.panopto.com/Panopto/Pages/Viewer.aspx?id=...`) or a Canvas page with an embedded Panopto video. The Nova card appears in the bottom-left corner.
4. Click the Nova toolbar icon to hide or show the card. The **–** button on the card minimizes it to the round avatar button, and clicking the avatar brings it back.

After you edit a file, click the reload icon on Nova's card in `chrome://extensions`, then reload the Panopto tab.

**Mascot:** save it as `icons/nova.png` (square, any size, ideally 256px or more). If the file is missing, the avatars show as plain green circles.

## Settings

| Setting | File | Default | What it does |
|---|---|---|---|
| `CAPTION_URL` | `content.js` | `{origin}/Panopto/Pages/Transcription/GenerateSRT.ashx?id={id}&language=0` | Where captions are fetched from. `{origin}` is the current Panopto host and `{id}` is the lecture ID. |
| `CAPTION_WINDOW_SECONDS` | `content.js` | `90` | How much recent transcript goes with each question. |
| `DEFAULT_CHIPS` | `content.js` | Explain what was just said / Give me an example / Quiz me on this | Suggestion chips shown until the backend sends its own. |
| `TITLE_SELECTORS` | `content.js` | `#deliveryTitle`, ... | Where to look for the lecture title before falling back to `document.title`. |
| `SUBTITLE_LANGUAGES` | `content.js` | Spanish, Chinese, Hindi, Korean, Arabic, French, Portuguese, Vietnamese, Japanese | Languages offered for translated subtitles (`code` goes to `/translate`, `speechLang` picks a voice). |
| `PANOPTO_LANGUAGE_IDS` | `content.js` | `{}` | **Unverified.** Panopto's `language=` numbers for professor-uploaded translations. Empty means always use `/translate`. |
| `BATCH_SIZE`, `CONCURRENCY`, `RETRY_DELAYS_MS`, `LEAD_SECONDS` | `translator.js` | 60, 2, 1 s/3 s, 10 s | Lines per `/translate` call, calls at once, retry backoff, how far before the playhead to start. |
| `START_WINDOW_S`, `MAX_RATE`, `DUCK_VOLUME`, `SPEECH_CPS` | `voice.js` | 1.5 s, 1.3×, 0.15, per language | Only speak a line within 1.5 s of its start; never speed up past 1.3×; professor's volume in **Lowered** mode (the default, **Muted**, silences them); characters per second used to fit lines. |
| `PANOPTO_CAPTION_SELECTORS`, `BOTTOM_MARGIN` | `subtitles.js` | guesses, 4% | Nova's pill sits near the bottom edge of the video (Panopto draws its own captions in a band below the video). If a caption box is ever drawn over the video, the pill sits 12px above it. |
| `BACKEND_URL` | `background.js` | `https://yooprofess-production.up.railway.app` | Person 2's server. **If you change it, also update `host_permissions` in `manifest.json`.** |
| `STUB_MODE` | `background.js` | `false` | `true`: no backend calls. Captions aren't uploaded, and questions get a canned reply that guides instead of answering (it names the timestamp and asks the student something back). `false`: real requests to `BACKEND_URL`. |

## Backend contract (proposal for Person 2 to confirm)

All request and response shapes are in one place: the **"Backend contract"** section at the top of `content.js`. `background.js` only sends them.

**`POST <BACKEND_URL>/lectures`**: sent once per page load after the captions load. The **Download JSON** file has the same shape.

```json
{
  "lecture_id": "6f2c...",
  "platform": "panopto",
  "title": "Lecture 7: Prompting basics",
  "captions": [{ "start": 872.4, "end": 875.1, "text": "So the prompt is just instructions." }]
}
```

**`POST <BACKEND_URL>/ask`**: sent when the student sends a message or taps a chip.

```json
{
  "lecture_id": "6f2c...",
  "current_time": 468.2,
  "question": "What is a prompt?",
  "context": [{ "start": 378.0, "end": 380.9, "text": "..." }]
}
```

`context` holds the caption cues that overlap `[current_time - 90, current_time]`, from `getCaptionWindow()`.

**Expected `/ask` response:**

```json
{ "reply": "Good question. Jump back to 6:18...", "chips": ["Why use a local model?", "Give me an example"] }
```

`chips` is optional. When the backend sends it, those chips replace the static ones; otherwise the static ones stay. The reply is shown as plain text: newlines are kept and HTML is not rendered.

Nothing else is ever sent: only the lecture ID, title, captions, playback time and the student's questions.

**`POST <BACKEND_URL>/translate`**: translated subtitles. The extension sends about 60 caption lines at a time, starting near where the student is watching.

```json
{ "lecture_id": "6f2c...", "target_language": "es", "title": "...",
  "cues": [{ "i": 120, "start": 361.0, "end": 363.9, "text": "..." }] }
```

Response (one entry per input `i`; `"fallback": true` means the server couldn't translate that line):

```json
{ "translations": [{ "i": 120, "text": "..." }] }
```

`/ask` also gets an optional `"language"` (e.g. `"Spanish (Español)"`) when subtitles are on; the reply comes back in that language and keeps the `Watch:` line format.

## Translated subtitles and spoken translation

- **Turn on:** click the button on the right of the mint strip (`Subtitles: Off ▾`) and pick a language. Subtitles appear over the main video in a green pill with the Nova planet and the language code, so they never look like Panopto's own captions.
- **Translated / Dual:** Dual shows the professor's original line above the translation.
- **🔊 Spoken translation:** reads each translated line aloud with the computer's built-in voice. Under the switch, **Professor's audio** picks **Muted** (default: you only hear Nova's translation) or **Lowered** (the professor stays audible at 15%). It never imitates the professor. Turning voice off restores the professor's audio exactly. Pausing the video stops the voice right away; when you press play it continues from the next line (console: `[Nova voice] stopped: video paused`). After a page reload, click **Resume voice** in the chat (browsers need a click before playing audio).
- Translation starts where the student is, then fills in the rest. Progress shows on the strip button and in the popover. Lines the server can't translate show the original text, and the popover offers **Retry**.
- The setting is remembered across lectures; translations are cached per lecture and language.

## What gets stored

All of it is in `chrome.storage.local`, keyed by lecture ID:

- `nova:captions:<lecture_id>`: parsed captions, so reloading the page doesn't fetch them again. **⋯ → Reload captions** fetches them fresh.
- `nova:chat:<lecture_id>`: the chat history, the last 200 messages. **⋯ → Clear chat** deletes it.
- `nova:translations:<lecture_id>:<language>`: translated subtitle lines, so a lecture is translated once per language.
- `nova:subtitles`: the chosen language, mode and voice setting (shared across lectures).

To wipe everything, open the extension's service worker console (`chrome://extensions` → Nova → "service worker") and run `chrome.storage.local.clear()`.

## How to test each state

Open DevTools on the lecture page. Every Nova log line starts with `[Nova]`. **Inside Canvas**, Nova runs in the Panopto iframe, so pick that frame (`...panopto.com`) in the Console's context dropdown, the one that says "top" by default.

> Captions are cached after the first successful load. To re-test a caption state, use **⋯ → Reload captions** instead of reloading the page.

| State | How to trigger it | What you should see |
|---|---|---|
| **Success** | Open a lecture that has captions. | Notice: "Loaded N caption lines". In stub mode it adds "Stub mode: not sent to the server." |
| **Not signed in** | Open the lecture, then delete the Panopto cookies in DevTools → Application → Cookies, then **⋯ → Reload captions**. Quick fake: temporarily set `CAPTION_URL` to `{origin}/Panopto/Pages/Home.aspx?id={id}` (that returns an HTML page). | Warning: "You're not signed in to Panopto..." with a Retry button. The strip reads "Captions unavailable: not signed in to Panopto". Triggered by a redirect to a login page, HTTP 401/403, or HTML instead of SRT. |
| **No captions** | Open a lecture that has no captions. | Info: "This lecture doesn't have captions yet...". The strip reads "No captions on this lecture". Download is disabled. |
| **Panopto error** | DevTools → Network → right-click the `GenerateSRT.ashx` request → **Block request URL**, then **⋯ → Reload captions**. | Error: "Couldn't load the captions from Panopto." with a Retry button. |
| **Backend unreachable** | Set `STUB_MODE = false` and don't run a server on `BACKEND_URL`. | Warning: "Loaded N caption lines, but the Nova server isn't reachable...". **⋯ → Download captions JSON** still works. Asking shows a red "I can't reach the Nova server" bubble. |
| **Backend up** | Set `STUB_MODE = false` and run Person 2's server. | "Loaded N caption lines"; replies come from the server, and chips change if the server sends them. |

**Playback sync:** play, pause and seek, and watch the header. It reads "Following at M:SS" while playing and "Paused at M:SS" while paused, and it should match Panopto's own time display.

**The 90-second window:** send a question and check the console:

```
[Nova] /ask at 7:48 with 31 caption lines (6:18–7:50)
[Nova] /ask payload {lecture_id: "...", current_time: 468.2, question: "...", context: Array(31)}
```

Expand the payload to check that `context` is the right stretch of the transcript.

**Download:** **⋯ → Download captions JSON** saves `<lecture_id>.json`. The ⋯ menu also shows the lecture title and ID. Hovering over the header shows them as a tooltip.

**Subtitles:**

| State | How to trigger it | What you should see |
|---|---|---|
| Translating | Pick a language you haven't used on this lecture. | Strip button shows `ES ◔ 22%`; the pill says "Translating…" until the line arrives; console logs `Translations: 0/N cached`. |
| Cached | Reload the page. | Subtitles appear immediately; console logs `Translations: N/N cached`; no new `/translate` calls. |
| Seek to untranslated | Pick a language, then jump far ahead right away. | "Translating…" briefly, then that part is translated next. |
| Backend down | `STUB_MODE = false` with no server. | The pill stays on "Translating…"; after retries the popover shows lines that couldn't be translated and a **Retry** button. |
| Stub mode | `STUB_MODE = true`. | Fake translations like `[ES] original text`. |
| Voice | Turn on 🔊 in the popover and play. | Lines are spoken as the video reaches them (`[Nova voice] ...` in the console); the professor is muted (or at 15% with **Lowered**) and comes back when you turn voice off. |

**Tests:** `node srt.js`, `node translator.js` and `node voice.js` (run from this folder; needs Node 18 or later).

## Check manually on real Panopto

**Translation (new):**

- **Caption placement.** Checked on UB Panopto: its captions sit in a band below the video, so Nova's pill sits at the video's bottom edge. If another Panopto setup draws captions over the video and they overlap, inspect that caption element and add it to `PANOPTO_CAPTION_SELECTORS`.
- **Which video gets subtitles.** Nova puts them on the largest visible video. Check it follows the ⇄ swap button.
- **Which stream has the audio.** Voice mode turns down every video, so it should work either way; check the professor gets quieter.
- **Panopto's own translations.** `PANOPTO_LANGUAGE_IDS` is empty; if your lectures have professor-uploaded translations, find their `language=` numbers and fill it in.
- **Fullscreen and Canvas.** Subtitles move into Panopto's fullscreen element; check this with Panopto's real fullscreen button, and inside Canvas.
- **Voices.** How the built-in voices sound depends on the computer. On a Mac, better voices can be added in System Settings → Accessibility → Spoken Content.
- **Cost.** A 75-minute lecture is about 1,500 lines, so roughly 25 `/translate` calls per language, once per lecture (then cached in the browser and, until a restart, on the server).

**Captions and playback (original):**

These were tested against a fake Panopto and Canvas (a local HTTPS server on a `*.panopto.com` hostname, loading this unpacked extension in Chrome for Testing), not a real Panopto login. Please check them:

1. **Caption URL.** Confirm `GenerateSRT.ashx?id=<id>&language=0` returns SRT for the `id` in the Viewer/Embed URL. Also check `language=0` (English) is right for your courses.
2. **What Panopto returns for a lecture with no captions.** Nova treats an empty file, a file with no cues, or HTTP 404 as "no captions". If Panopto returns an HTML page instead, Nova will wrongly say "not signed in".
3. **What an expired session returns.** Nova handles a redirect to a login path, 401/403, HTML instead of SRT, and a redirect to an SSO login on another domain (detected with a second `redirect: "manual"` request).
4. **Title selectors.** `#deliveryTitle` and the others in `TITLE_SELECTORS` are guesses. Check which title the console prints (`[Nova] Lecture detected` / `[Nova] Lecture title`). If it falls back to `document.title`, add the right selector at the top of the list.
5. **Which `<video>` Nova follows.** Panopto can show several streams (slides, camera). Nova prefers `video#primaryVideo` if it exists, and otherwise the most-loaded, largest video. Check that "Following at" matches Panopto's own clock, especially on lectures with edits (cut sections) or several streams. If they differ, caption times and `video.currentTime` aren't on the same timeline.
6. **Keyboard shortcuts.** Type a sentence with spaces into Nova's input. The video must not pause and seek along with it. Nova blocks key events from its own input before Panopto sees them; this worked in testing but should be confirmed against Panopto's real handlers.
7. **Canvas cookies.** Inside Canvas, the caption request uses the Panopto iframe's cookies. If Chrome blocks third-party cookies, the embed will ask the student to sign in, and Nova will show "not signed in".
8. **Download inside Canvas.** If Canvas sandboxes the Panopto iframe without `allow-downloads`, the download may be blocked inside Canvas. It works when the lecture is opened directly.
9. **Other hosts and URL casing.** Only `https://*.panopto.com/Panopto/Pages/Viewer.aspx*` and `Embed.aspx*` match. Schools on `panopto.eu` or a custom domain, or links using lowercase `viewer.aspx`, need extra entries in `manifest.json` (both `content_scripts.matches` and `host_permissions`).
10. **Fullscreen.** When Panopto's player goes fullscreen, Nova isn't visible. Only the fullscreen element is drawn, which is expected for now.
11. **Switching lectures without a page load** (playlists, "next session"). Nova checks the URL's `id` every second and reloads captions and chat when it changes. This is untested on real Panopto.
12. **Late title.** Captions are uploaded as soon as they load. If Panopto fills in the title later, the backend gets the `document.title` version (usually the same text).
