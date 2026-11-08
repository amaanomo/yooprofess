/*
 * Nova: lecture content script.
 *
 * Runs in every Panopto Viewer.aspx / Embed.aspx frame (including Canvas iframes),
 * but only does anything in a frame whose URL has a lecture "id". It:
 *   1. reads the lecture ID and title, and mounts the overlay (overlay.js)
 *   2. fetches the captions with the student's Panopto session, parses them (srt.js),
 *      caches them, and sends them to the backend through background.js
 *   3. follows the <video> element's playback time
 *   4. sends questions (typed or spoken), the last 90 seconds of captions, the
 *      recent conversation and a frame of the video (so Nova can read slides)
 *   5. translated subtitles (translator.js + subtitles.js) and spoken translation (voice.js)
 *   6. voice: "Hey Nova" (spotter.js + voice-client.js); video commands
 *      ("pause", "go back 30 seconds") run locally, everything else is asked
 *
 * Runs at document_start only so the keyboard guard is registered before
 * Panopto's own key handlers; everything else waits for the DOM.
 */
(() => {
  "use strict";

  // ===========================================================================
  // Config
  // ===========================================================================

  /**
   * Where the captions come from. {origin} is the current Panopto host
   * (e.g. https://buffalo.hosted.panopto.com) and {id} is the lecture ID.
   * Paste a different pattern here if Panopto changes it.
   */
  const CAPTION_URL = "{origin}/Panopto/Pages/Transcription/GenerateSRT.ashx?id={id}&language=0";

  /** How much recent transcript goes with each question. */
  // Each question also sends one frame of the video so Nova can see the slide. Set false to send text only.
  const SEND_FRAME = true;
  const FRAME_MAX_WIDTH = 1024;
  const FRAME_QUALITY = 0.7;
  // Each question also saves a small slide thumbnail so "Export notes" can show it. Kept apart from the
  // chat history and capped, so it can't fill the browser's storage. Set false for text-only notes.
  const SAVE_SHOTS = true;
  /** Deep Dive uses a fresh frame if the video is still within this many seconds of the question. */
  const DEEP_DIVE_FRAME_WINDOW_S = 15;
  const SHOT_MAX_WIDTH = 480;
  const SHOT_QUALITY = 0.6;
  const MAX_SHOTS_PER_LECTURE = 30;
  const CAPTION_WINDOW_SECONDS = 90;

  /** Static suggestion chips. Replaced by `chips` from /ask when the backend sends them. */
  const SUMMARY_PROMPT = "Summarize this lecture"; // the chip and the student message; sent to /summary, not /ask
  const DEFAULT_CHIPS = ["Explain what was just said", "Give me an example", "Quiz me on this", SUMMARY_PROMPT];

  /** Tried in order for the lecture title; falls back to document.title. */
  const TITLE_SELECTORS = [
    "#deliveryTitle",
    ".deliveryTitle",
    "[id*='deliveryTitle']",
    "#title",
    ".viewer-title",
    "meta[property='og:title']",
    "meta[name='title']",
  ];

  const MAX_SAVED_MESSAGES = 200;
  const MAX_SESSIONS = 30; // chats kept per lecture

  /** Languages offered for translated subtitles. code is sent to /translate; speechLang picks a voice. */
  const SUBTITLE_LANGUAGES = [
    { code: "es", label: "Español", english: "Spanish", speechLang: "es-ES" },
    { code: "zh-Hans", label: "中文 (简体)", english: "Simplified Chinese", speechLang: "zh-CN" },
    { code: "hi", label: "हिन्दी", english: "Hindi", speechLang: "hi-IN" },
    { code: "ko", label: "한국어", english: "Korean", speechLang: "ko-KR" },
    { code: "ar", label: "العربية", english: "Arabic", speechLang: "ar-SA" },
    { code: "fr", label: "Français", english: "French", speechLang: "fr-FR" },
    { code: "pt", label: "Português", english: "Portuguese", speechLang: "pt-BR" },
    { code: "vi", label: "Tiếng Việt", english: "Vietnamese", speechLang: "vi-VN" },
    { code: "ja", label: "日本語", english: "Japanese", speechLang: "ja-JP" },
  ];

  /**
   * TODO (unverified): Panopto's caption language numbers for the `language=` parameter
   * of CAPTION_URL, e.g. { es: 1 }. When a lecture has a professor-uploaded translation
   * in that language, Nova uses it instead of machine translation. Empty = always use /translate.
   */
  const PANOPTO_LANGUAGE_IDS = {};

  /** How many earlier chat turns go with each question (conversation memory). */
  const HISTORY_TURNS = 10;

  // ===========================================================================
  // Backend contract. This is a PROPOSAL for Person 2 to confirm.
  // Every request/response shape lives here so it's easy to change.
  // ===========================================================================

  /** POST <BACKEND_URL>/lectures (also the "Download JSON" file). */
  function buildLecturePayload({ lectureId, title, captions }) {
    return {
      lecture_id: lectureId,
      platform: "panopto",
      title,
      captions: captions.map((c) => ({ start: c.start, end: c.end, text: c.text })),
    };
  }

  /** POST <BACKEND_URL>/ask */
  function buildAskPayload({ lectureId, currentTime, question, context, history, voice, language, frame, source, title }) {
    const payload = {
      lecture_id: lectureId,
      current_time: Math.round(currentTime * 10) / 10,
      question,
      context: context.map((c) => ({ start: c.start, end: c.end, text: c.text })),
      history: buildHistory(history),
      voice: Boolean(voice),
      // "typed" or "chip". Hot topics counts every real question (typed or spoken), never chip taps.
      source: source === "chip" ? "chip" : "typed",
      title,
    };
    // Only when translated subtitles are on, e.g. "Spanish (Español)". The reply comes back in it.
    if (language) payload.language = language;
    // A JPEG of the video as the student sees it (base64, no data: prefix), so Nova can read slides.
    if (frame) payload.image = frame;
    return payload;
  }

  /** Last few turns as [{ role: "student" | "nova", text }]. Error replies are left out. */
  function buildHistory(history) {
    return (history || [])
      .filter((m) => m && !m.error && !m.local && typeof m.text === "string" && m.text.trim())
      .slice(-HISTORY_TURNS)
      .map((m) => ({ role: m.role === "student" ? "student" : "nova", text: m.text }));
  }

  /** POST <BACKEND_URL>/topics. refresh: rebuild if new questions came in since the last build. */
  function buildTopicsPayload({ lectureId, refresh }) {
    return { lecture_id: lectureId, refresh: Boolean(refresh) };
  }

  /**
   * Expected /topics response:
   * { "status": "ok"|"empty", "total_questions": 12, "updated_at": <epoch s>,
   *   "topics": [{ "title", "summary", "count", "time", "examples": ["..."] }] }
   */
  function readTopicsResponse(data) {
    const topics = (data && Array.isArray(data.topics) ? data.topics : [])
      .filter((t) => t && typeof t.title === "string" && Number(t.count) > 0)
      .map((t) => ({
        title: t.title,
        summary: typeof t.summary === "string" ? t.summary : "",
        count: Math.floor(Number(t.count)),
        time: Number.isFinite(Number(t.time)) ? Number(t.time) : 0,
        examples: Array.isArray(t.examples) ? t.examples.filter((e) => typeof e === "string").slice(0, 3) : [],
      }));
    const total = data && Number.isFinite(Number(data.total_questions)) ? Number(data.total_questions) : 0;
    const times = data && Array.isArray(data.question_times) ? data.question_times.map(Number).filter((x) => Number.isFinite(x) && x >= 0) : [];
    return { status: data && data.status === "empty" ? "empty" : "ok", topics, total, times, updatedAt: data && data.updated_at };
  }

  /** Expected /ask response: { "reply": "...", "chips": ["...", ...] }  (chips optional). */
  function readAskResponse(data) {
    if (typeof data === "string") return { reply: data, chips: null };
    const reply = data && (data.reply ?? data.answer ?? data.message);
    const chips = data && Array.isArray(data.chips) && data.chips.length ? data.chips : null;
    return { reply: typeof reply === "string" && reply.trim() ? reply : null, chips };
  }

  /**
   * POST <BACKEND_URL>/translate
   * cues: [{ i, start, end, text }] where i is the cue's index in the full caption list.
   */
  function buildTranslatePayload({ lectureId, title, targetLanguage, cues }) {
    return {
      lecture_id: lectureId,
      target_language: targetLanguage,
      title,
      cues: cues.map((c) => ({ i: c.i, start: c.start, end: c.end, text: c.text })),
    };
  }

  /** Expected /translate response: { "translations": [{ "i": 120, "text": "...", "fallback"?: true }] } */
  function readTranslateResponse(data) {
    const list = data && Array.isArray(data.translations) ? data.translations : [];
    const out = {};
    for (const t of list) {
      // Fallback entries are the untranslated original; leave those cues untranslated so they can be retried.
      if (t && Number.isInteger(t.i) && typeof t.text === "string" && t.text.trim() && !t.fallback) out[t.i] = t.text.trim();
    }
    return out;
  }

  // ===========================================================================
  // Startup
  // ===========================================================================

  // After the extension is reloaded, the old copy of this script is still on the
  // page but disconnected. Only skip loading if a *live* copy is already here.
  const alive = window.__novaContentLoaded;
  if (typeof alive === "function" && alive()) return;
  window.__novaContentLoaded = () => {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  };
  if (alive) document.querySelectorAll("nova-overlay").forEach((el) => el.remove()); // the dead copy's card

  const log = (...args) => console.log("[Nova]", ...args);
  const warn = (...args) => console.warn("[Nova]", ...args);
  const { parseSRT, captionWindow, formatTime, parseTimestamp } = globalThis.NovaSRT;

  function getLectureId() {
    for (const [key, value] of new URLSearchParams(location.search)) {
      if (key.toLowerCase() === "id" && value.trim()) return value.trim();
    }
    return null;
  }

  const initialId = getLectureId();
  if (!initialId) return; // not a lecture frame: do nothing at all

  NovaOverlay.installKeyGuard();

  const state = {
    lectureId: initialId,
    title: "",
    captions: [],
    history: [],
    sessions: { activeId: null, list: [] }, // chat sessions for this lecture; history is the active one's messages
    busy: false,
    video: null,
    lastTime: 0,
    loadToken: 0,
  };
  let overlay = null;
  let voice = null;

  // Translated subtitles: language/mode/voice are the student's saved choices; the rest is runtime state.
  const subs = {
    language: null,
    mode: "translated",
    voice: false,
    originalAudio: "muted", // professor's audio while voice is on: "muted" or "lowered"
    lastLanguage: null,
    translator: null,
    ui: null,
    voiceEngine: null,
    token: 0,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }

  async function start() {
    overlay = NovaOverlay.create({
      cssUrl: chrome.runtime.getURL("overlay.css"),
      mascotUrl: chrome.runtime.getURL("icons/nova.png"),
      windowSeconds: CAPTION_WINDOW_SECONDS,
      onSend: (text, source) => (text === SUMMARY_PROMPT ? summarize() : handleInput(text, { voice: false, source })),
      onSummarize: () => summarize(),
      onExportNotes: exportNotes,
      onDownload: downloadJson,
      onReloadCaptions: () => loadCaptions({ force: true }),
      onClearChat: clearChat,
      onNewChat: newChat,
      onSwitchChat: switchChat,
      onSeek: seekTo,
      onExplain: explainInDepth,
      subtitleLanguages: SUBTITLE_LANGUAGES,
      onSubtitleLanguage: (code) => setSubtitleLanguage(code, { announce: true }),
      onSubtitleMode: setSubtitleMode,
      onVoiceToggle: setVoice,
      onOriginalAudio: setOriginalAudio,
      onRetryTranslation: () => subs.translator && subs.translator.retryFailed(),
      onLayoutChange: () => subs.ui && subs.ui.relayout(),
      onOpenTopics: () => loadTopics(),
      onRefreshTopics: () => loadTopics({ refresh: true }),
      onInstructorUnlock: unlockInstructor,
      onOpenDashboard: openDashboard,
      onExitInstructor: exitInstructor,
      onToggleVoice: (on) => voice.setVoiceReplies(on),
      onMic: () => voice.listen(),
      onStopSpeaking: () => voice.stopSpeaking(),
    });

    voice = NovaVoiceClient.attach({
      getOverlay: () => overlay,
      onWake,
      onTranscript: onVoiceQuestion,
      onNoTranscript: ({ reason, error }) => {
        if (reason === "error") overlay.setNotice({ kind: "warn", text: "I couldn't hear that clearly.", detail: error });
      },
    });

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === "NOVA_TOGGLE") {
        const visible = overlay.toggleVisible();
        log(visible ? "Overlay shown" : "Overlay hidden");
        sendResponse({ ok: true, visible, lectureId: state.lectureId });
      }
    });
    // Tell background this frame is the lecture, so "Hey Nova" and the toolbar land here.
    sendToBackground({ type: "NOVA_REGISTER_LECTURE_FRAME" });

    await overlay.mount();
    await initInstructor();
    voice.sync();
    overlay.setChips(DEFAULT_CHIPS);
    await initSubtitles();
    watchVideo();
    watchForLectureChange();
    await openLecture(state.lectureId);
  }

  /** (Re)initialise everything for one lecture. Also used if the URL's id changes. */
  async function openLecture(lectureId) {
    state.lectureId = lectureId;
    state.captions = [];
    stopTranslation();
    if (overlay.isTopicsOpen()) loadTopics(); // the Hot topics view follows the lecture
    state.title = resolveTitle();
    log("Lecture detected", { id: lectureId, title: state.title, frame: window === window.top ? "top" : "iframe" });
    overlay.setLecture({ id: lectureId, title: state.title });
    overlay.setDownloadEnabled(false);
    overlay.setContextLabel(`Using the last ${CAPTION_WINDOW_SECONDS} seconds of captions`);
    overlay.setChips(DEFAULT_CHIPS);
    refineTitleLater(lectureId);

    await loadSessions(lectureId);
    if (lectureId !== state.lectureId) return;
    overlay.setHistory(state.history);
    refreshSessionList();
    if (subs.offerVoice && subs.language && !subs.voice) offerVoiceResume();
    await loadCaptions();
  }

  function watchForLectureChange() {
    // Panopto can switch sessions (playlists, "next") without a full page load.
    setInterval(() => {
      const id = getLectureId();
      if (id && id !== state.lectureId) {
        log("Lecture changed in the URL", id);
        openLecture(id);
      }
    }, 1000);
  }

  // ===========================================================================
  // Title
  // ===========================================================================

  function cleanTitle(raw) {
    const t = String(raw || "")
      .replace(/\s+/g, " ")
      .replace(/\s*[-–—|]\s*Panopto\s*$/i, "")
      .trim();
    return /^panopto$/i.test(t) ? "" : t;
  }

  function titleFromSelectors() {
    for (const selector of TITLE_SELECTORS) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const t = cleanTitle(el.tagName === "META" ? el.getAttribute("content") : el.textContent);
      if (t) return t;
    }
    return "";
  }

  function resolveTitle() {
    return titleFromSelectors() || cleanTitle(document.title) || "Untitled lecture";
  }

  /** Panopto fills the title in with JS after load, so look again for a few seconds. */
  function refineTitleLater(lectureId) {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (lectureId !== state.lectureId) return clearInterval(timer);
      const fromDom = titleFromSelectors();
      const next = fromDom || resolveTitle();
      if (next !== state.title) {
        state.title = next;
        overlay.setLecture({ id: lectureId, title: next });
        log("Lecture title", next);
      }
      if (fromDom || tries >= 10) clearInterval(timer);
    }, 1000);
  }

  // ===========================================================================
  // Part 2: captions
  // ===========================================================================

  function buildCaptionUrl(lectureId) {
    return CAPTION_URL.replace("{origin}", location.origin).replace("{id}", encodeURIComponent(lectureId));
  }

  const LOGIN_URL_RE = /login|signin|sign-in|auth|sso|saml|shibboleth/i;

  /** Returns { kind: "ok", cues } or { kind: "login" | "empty" | "error", detail }. */
  async function fetchCaptions(lectureId) {
    const url = buildCaptionUrl(lectureId);
    log("Fetching captions", url);
    let res;
    try {
      res = await fetch(url, { credentials: "include" });
    } catch (err) {
      // A redirect to a sign-in page on another domain fails CORS and lands here.
      // Ask again without following redirects to tell that apart from a network error.
      try {
        const probe = await fetch(url, { credentials: "include", redirect: "manual" });
        if (probe.type === "opaqueredirect") return { kind: "login", detail: "Redirected to a sign-in page" };
      } catch (_) {
        /* fall through */
      }
      return { kind: "error", detail: `Network error: ${err.message}` };
    }

    if (res.status === 401 || res.status === 403) return { kind: "login", detail: `HTTP ${res.status}` };
    if (res.redirected && LOGIN_URL_RE.test(new URL(res.url).pathname)) {
      return { kind: "login", detail: "Redirected to a sign-in page" };
    }
    if (res.status === 404) return { kind: "empty", detail: "HTTP 404" };
    if (!res.ok) return { kind: "error", detail: `HTTP ${res.status}` };

    const text = await res.text();
    const contentType = res.headers.get("content-type") || "";
    if (/text\/html/i.test(contentType) || /^\s*<(!doctype|html|head|body)/i.test(text)) {
      return { kind: "login", detail: "Got an HTML page instead of captions" };
    }
    const cues = parseSRT(text);
    if (!cues.length) return { kind: "empty", detail: text.trim() ? "No caption lines in the file" : "Empty caption file" };
    return { kind: "ok", cues };
  }

  async function loadCaptions({ force = false } = {}) {
    const lectureId = state.lectureId;
    const token = ++state.loadToken;
    const stale = () => token !== state.loadToken || lectureId !== state.lectureId;

    overlay.setNotice({ kind: "loading", text: "Loading captions…" });

    let cues = null;
    let fromCache = false;
    if (!force) {
      const cached = await storageGet(captionsKey(lectureId));
      if (stale()) return;
      if (cached && Array.isArray(cached.captions) && cached.captions.length) {
        cues = cached.captions;
        fromCache = true;
      }
    }

    if (!cues) {
      const result = await fetchCaptions(lectureId);
      if (stale()) return;
      if (result.kind !== "ok") return showCaptionProblem(result);
      cues = result.cues;
      await storageSet(captionsKey(lectureId), {
        lecture_id: lectureId,
        title: state.title,
        captions: cues,
        fetched_at: new Date().toISOString(),
      });
    }

    state.captions = cues;
    startTranslation();
    overlay.setDownloadEnabled(true);
    overlay.setContextLabel(`Using the last ${CAPTION_WINDOW_SECONDS} seconds of captions`);
    log(`Loaded ${cues.length} caption lines${fromCache ? " (from cache)" : ""}`);
    await uploadCaptions(lectureId, stale);
  }

  function showCaptionProblem({ kind, detail }) {
    warn("Captions not loaded:", kind, detail);
    overlay.setDownloadEnabled(false);
    const retry = { actionLabel: "Retry", onAction: () => loadCaptions({ force: true }) };
    if (kind === "login") {
      overlay.setContextLabel("Captions unavailable: not signed in to Panopto");
      overlay.setNotice({
        kind: "warn",
        text: "You're not signed in to Panopto, so Nova can't read the captions. Sign in to Panopto in this browser, then retry.",
        detail,
        ...retry,
      });
    } else if (kind === "empty") {
      overlay.setContextLabel("No captions on this lecture");
      overlay.setNotice({
        kind: "info",
        text: "This lecture doesn't have captions yet, so Nova can't see what was said. You can still ask general questions.",
        detail,
        ...retry,
      });
    } else {
      overlay.setContextLabel("Captions unavailable");
      overlay.setNotice({ kind: "error", text: "Couldn't load the captions from Panopto.", detail, ...retry });
    }
  }

  async function uploadCaptions(lectureId, stale) {
    const count = state.captions.length.toLocaleString();
    overlay.setNotice({ kind: "loading", text: `Loaded ${count} caption lines. Sending them to Nova…` });
    const payload = buildLecturePayload({ lectureId, title: state.title, captions: state.captions });
    const res = await sendToBackground({ type: "NOVA_UPLOAD_LECTURE", payload });
    if (stale()) return;

    if (res.ok) {
      log(res.stub ? "STUB_MODE: captions not sent to the backend" : "Captions sent to the backend");
      overlay.setNotice({
        kind: "success",
        text: `Loaded ${count} caption lines`,
        detail: res.stub ? "Stub mode: not sent to the server." : null,
      });
      return;
    }
    warn("Could not send captions to the backend:", res.error, res.status || "", res.detail || "");
    overlay.setNotice({
      kind: "warn",
      text: `Loaded ${count} caption lines, but the Nova server isn't reachable, so answers may not work yet. You can still download the captions from the ⋯ menu.`,
      detail: res.status ? `Server returned HTTP ${res.status}` : backendErrorText(res),
      actionLabel: "Retry",
      onAction: () => uploadCaptions(state.lectureId, () => lectureId !== state.lectureId),
    });
  }

  function downloadJson() {
    if (!state.captions.length) return;
    const payload = buildLecturePayload({ lectureId: state.lectureId, title: state.title, captions: state.captions });
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${state.lectureId.replace(/[^\w.-]+/g, "_")}.json`;
    a.style.display = "none";
    overlay.host.shadowRoot.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    log(`Downloaded ${a.download} (${payload.captions.length} captions)`);
  }

  /** Part 3: caption cues between currentTime - seconds and currentTime. */
  function getCaptionWindow(currentTime, seconds = CAPTION_WINDOW_SECONDS) {
    return captionWindow(state.captions, currentTime, seconds);
  }

  // ===========================================================================
  // Part 3: follow the video
  // ===========================================================================

  const VIDEO_EVENTS = [
    "timeupdate",
    "seeked",
    "seeking",
    "play",
    "playing",
    "pause",
    "ended",
    "loadedmetadata",
    "durationchange",
    "emptied",
  ];

  function pickVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    if (!videos.length) return null;
    const current = state.video;
    const primary = document.querySelector("video#primaryVideo");
    // Keep the video we're on unless it left the page or Panopto's primary stream showed up.
    if (current && current.isConnected && (!primary || primary === current)) return current;
    if (primary) return primary;
    const area = (v) => {
      const r = v.getBoundingClientRect();
      return r.width * r.height;
    };
    return videos.sort((a, b) => b.readyState - a.readyState || area(b) - area(a))[0];
  }

  function attachVideo() {
    const next = pickVideo();
    if (next === state.video) return;
    if (state.video) {
      for (const type of VIDEO_EVENTS) state.video.removeEventListener(type, onVideoEvent);
    }
    state.video = next;
    if (next) {
      for (const type of VIDEO_EVENTS) next.addEventListener(type, onVideoEvent);
      log("Following video element", next.id ? `#${next.id}` : next);
    }
    if (subs.voiceEngine) subs.voiceEngine.refreshDucking();
    if (subs.ui) subs.ui.relayout();
    updatePlayback();
  }

  function onVideoEvent(event) {
    if (event.type === "seeking") {
      if (subs.translator) subs.translator.seek(getCurrentTime()); // translate where the student jumped to
      if (subs.voiceEngine) subs.voiceEngine.reset();
    } else if (subs.voice && subs.voiceEngine) {
      if (event.type === "pause") subs.voiceEngine.pause();
      else if (event.type === "play" || event.type === "playing") subs.voiceEngine.resume();
      else if (event.type === "emptied") subs.voiceEngine.reset();
    }
    updatePlayback();
  }

  function updatePlayback() {
    const v = state.video;
    if (!v) {
      overlay.setPlayback({ state: "waiting" });
      return;
    }
    if (Number.isFinite(v.currentTime)) state.lastTime = v.currentTime;
    overlay.setPlayback({ state: v.paused || v.ended ? "paused" : "playing", time: state.lastTime });
    refreshSubtitle();
  }

  function watchVideo() {
    attachVideo();
    // Panopto may create the <video> late or swap it out; re-check after DOM changes.
    let pending = false;
    const observer = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        attachVideo();
      }, 200);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function getCurrentTime() {
    const v = state.video;
    return v && v.isConnected && Number.isFinite(v.currentTime) ? v.currentTime : state.lastTime;
  }

  // ===========================================================================
  // Part 4: chat
  // ===========================================================================

  /**
   * Jump the lecture AND the slides recording (#primaryVideo + #secondaryVideo)
   * to the same moment. A secondary stream that's deliberately offset from the
   * primary keeps its offset; small drift (< 2s) is snapped back into sync.
   */
  function seekTo(seconds) {
    const v = state.video;
    if (!v || !v.isConnected || !Number.isFinite(seconds)) {
      warn("Jump ignored:", !v ? "no video" : !v.isConnected ? "video left the page" : `bad time ${seconds}`);
      return;
    }
    const target = Math.max(0, Number.isFinite(v.duration) ? Math.min(seconds, v.duration) : seconds);
    const from = v.currentTime;
    // A refresh still running means the student is really "paused" (it's just the blip).
    const paused = Boolean(refreshMute) || !isPlaying();
    if (refreshMute) cancelRefresh(); // the newer jump wins
    // While paused, Panopto doesn't redraw: start a hair early so the refresh blip ends on target.
    setVideoTime(paused ? Math.max(0, target - REFRESH_BLIP_MS / 1000) : target);
    if (paused) refreshWhilePaused(target);
    guardSeek(from, target);
    traceSeek(from, target, paused);
    return target;
  }

  /** Diagnostics: log where every recording is right after a jump and a few seconds later. */
  function traceSeek(from, target, paused) {
    const snap = () =>
      allVideos()
        .map((x) => `${x.id ? "#" + x.id : "video"}=${formatTime(x.currentTime)}${x.paused ? " (paused)" : ""}${x.seeking ? " (seeking)" : ""}`)
        .join(", ");
    log(`Jump ${formatTime(from)} -> ${formatTime(target)} (${paused ? "paused" : "playing"}); now: ${snap()}`);
    for (const ms of [500, 1500, 4000, 8000]) setTimeout(() => log(`Jump +${ms / 1000}s: ${snap()}`), ms);
  }

  /**
   * Panopto's player keeps its own idea of the position, and right after we set
   * video.currentTime it can pull the video back to where the student was
   * (seen on jumps backwards). For a few seconds after a jump, if the video
   * lands back near the old spot, re-apply the jump. Only that snap-back is
   * corrected, so a seek the student makes themselves is never fought.
   */
  const SEEK_GUARD_MS = 3000;
  const SEEK_GUARD_RETRIES = 4;
  let seekGuardRequest = 0;

  function guardSeek(from, target) {
    const v = state.video;
    if (!v || !Number.isFinite(from) || Math.abs(from - target) < 3) return; // too close to tell apart
    const request = ++seekGuardRequest;
    const startedAt = Date.now();
    let retries = 0;
    const check = () => {
      if (request !== seekGuardRequest || state.video !== v) return stop();
      if (Date.now() - startedAt > SEEK_GUARD_MS) return stop();
      const now = v.currentTime;
      // Snapped back: at the old spot again (Panopto may have kept playing from it), not near the target.
      const elapsed = (Date.now() - startedAt) / 1000;
      const nearOld = now >= from - 1.5 && now <= from + elapsed + 1.5;
      if (nearOld && Math.abs(now - target) > elapsed + 2) {
        if (retries++ >= SEEK_GUARD_RETRIES) {
          warn(`Panopto keeps moving the video back to ${formatTime(now)}; jump to ${formatTime(target)} didn't stick`);
          return stop();
        }
        log(`Panopto moved the video back to ${formatTime(now)}; re-applying jump to ${formatTime(target)}`);
        setVideoTime(v.paused ? target : target + elapsed);
      }
    };
    const timer = setInterval(check, 150);
    const events = ["seeked", "timeupdate", "playing"];
    for (const type of events) v.addEventListener(type, check);
    function stop() {
      clearInterval(timer);
      for (const type of events) v.removeEventListener(type, check);
    }
  }

  /** Set both recordings' position (no redraw while paused; see refreshWhilePaused). */
  function setVideoTime(target) {
    const v = state.video;
    for (const x of allVideos()) {
      if (x === v) continue;
      const offset = x.currentTime - v.currentTime;
      const t = target + (Math.abs(offset) < 2 ? 0 : offset);
      x.currentTime = Math.max(0, Number.isFinite(x.duration) ? Math.min(t, x.duration) : t);
    }
    v.currentTime = target;
  }

  /**
   * Panopto only redraws the picture, the slides and its seek bar while playing,
   * so a jump made while paused looked like nothing happened. Fix: silently press
   * play for a moment, then pause again. The video ends paused at the new spot.
   */
  const REFRESH_BLIP_MS = 250;
  let refreshRequest = 0;
  let refreshMute = null; // { video, wasMuted } while a refresh has the lecture muted

  /** Stop a refresh in progress (a newer command wins) and give the sound back. */
  function cancelRefresh() {
    refreshRequest++;
    if (refreshMute) {
      refreshMute.video.muted = refreshMute.wasMuted;
      refreshMute = null;
    }
  }

  function refreshWhilePaused(target) {
    const v = state.video;
    if (refreshMute) cancelRefresh(); // back-to-back jumps
    const request = ++refreshRequest;
    const wasMuted = v.muted;
    refreshMute = { video: v, wasMuted };
    v.muted = true; // no audio blip
    const finish = () => {
      if (request !== refreshRequest) return; // a newer jump took over
      setPlaying(false);
      setTimeout(() => {
        if (request !== refreshRequest) return;
        v.muted = wasMuted;
        refreshMute = null;
        if (Math.abs(v.currentTime - target) > 1.5) setVideoTime(target); // keep it exact
      }, 150);
    };
    let started = false;
    const onPlaying = () => {
      if (started) return;
      started = true;
      v.removeEventListener("playing", onPlaying);
      setTimeout(finish, REFRESH_BLIP_MS);
    };
    if (!v.paused) {
      onPlaying(); // already playing (a previous blip): just play a moment, then pause
    } else {
      v.addEventListener("playing", onPlaying);
      setPlaying(true);
    }
    // If the video never starts (still buffering), stop waiting after 2.5s.
    setTimeout(() => {
      v.removeEventListener("playing", onPlaying);
      if (!started) {
        started = true;
        finish();
      }
    }, 2500);
  }

  /**
   * The current video frame as a base64 JPEG (max FRAME_MAX_WIDTH wide), or null when the browser
   * won't let us read it (cross-origin or DRM video taints the canvas) or nothing is playing yet.
   */
  function captureFrame() {
    return SEND_FRAME ? grabFrame(FRAME_MAX_WIDTH, FRAME_QUALITY) : null;
  }

  function grabFrame(maxWidth, quality) {
    const v = state.video;
    if (!v || !v.videoWidth || !v.videoHeight || v.readyState < 2) return null;
    try {
      const scale = Math.min(1, maxWidth / v.videoWidth);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(v.videoWidth * scale);
      canvas.height = Math.round(v.videoHeight * scale);
      canvas.getContext("2d").drawImage(v, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", quality).split(",")[1] || null;
    } catch (err) {
      warn("Couldn't capture the video frame", err && err.name);
      return null;
    }
  }

  // ---- Panopto's own controls ------------------------------------------------
  // Panopto keeps the lecture and slides recordings in sync when its own buttons
  // are used. Pausing the <video> elements directly makes Panopto's player fight
  // back (it still thinks it's playing), so play/pause/mute go through its buttons.

  const PANOPTO_PLAY_BUTTON = "#playButton"; // title "Pause" while playing, "Play" while paused
  const PANOPTO_MUTE_BUTTON = "#muteButton"; // title "Mute" / "Unmute"

  function panoptoButton(selector) {
    const b = document.querySelector(selector);
    return b && b.isConnected ? b : null;
  }

  function buttonLabel(b) {
    return b ? String(b.title || b.getAttribute("aria-label") || "").trim() : "";
  }

  function isPlaying() {
    const label = buttonLabel(panoptoButton(PANOPTO_PLAY_BUTTON));
    if (/^pause/i.test(label)) return true;
    if (/^play/i.test(label)) return false;
    return Boolean(state.video && !state.video.paused);
  }

  function press(b) {
    b.click();
  }

  let playRequest = 0; // newest play/pause request; older checks stand down

  /** Play or pause BOTH recordings. Uses Panopto's button; falls back to the videos. */
  function setPlaying(want) {
    const request = ++playRequest;
    if (isPlaying() === want) return;
    const b = panoptoButton(PANOPTO_PLAY_BUTTON);
    const direct = () => allVideos().forEach((x) => (want ? x.play().catch(() => {}) : x.pause()));
    if (!b) return direct();
    press(b);
    setTimeout(() => {
      if (request === playRequest && isPlaying() !== want) {
        warn("Panopto's play button didn't respond; controlling both videos directly");
        direct();
      }
    }, 600);
  }

  function isMuted() {
    const label = buttonLabel(panoptoButton(PANOPTO_MUTE_BUTTON));
    if (/^unmute/i.test(label)) return true;
    if (/^mute/i.test(label)) return false;
    return Boolean(state.video && state.video.muted);
  }

  /** Mute/unmute through Panopto's button (the lecture has the sound; slides are always muted). */
  function setMuted(want) {
    if (isMuted() === want) return;
    const b = panoptoButton(PANOPTO_MUTE_BUTTON);
    if (b) press(b);
    else if (state.video) state.video.muted = want;
  }

  /**
   * Pull every "Watch: M:SS-M:SS, description" line out of a Nova reply (the
   * backend sends up to 3, most relevant first, for "where did they cover X?").
   * Returns { clean: text without the watch lines, watch: [{ start, end, label }] | null }.
   */
  function parseWatch(text) {
    const watch = [];
    const clean = text
      .replace(/^[ \t]*Watch:[ \t]*([^\n]+)\n?/gim, (line, body) => {
        const m = body.trim().match(/^(\d{1,2}(?::\d{2}){1,2})(?:\s*[-–]\s*(\d{1,2}(?::\d{2}){1,2}))?(?:[,.:;]?\s*(.+))?/);
        const start = m ? parseTimestamp(m[1]) : NaN;
        if (!Number.isFinite(start)) return line; // not a timestamp: leave the text alone
        const end = m[2] ? parseTimestamp(m[2]) : start;
        watch.push({ start, end: Number.isFinite(end) ? end : start, label: m[3] ? m[3].trim() : "" });
        return "";
      })
      .trim();
    return watch.length ? { clean, watch } : { clean: text, watch: null };
  }

  // ===========================================================================
  // Voice
  // ===========================================================================

  async function onWake() {
    overlay.show();
    if (voice.settings.pauseVideoOnWake && state.video && isPlaying()) {
      setPlaying(false); // both recordings; so the lecture audio doesn't drown out the question
    }
  }

  async function onVoiceQuestion(text, alternatives = []) {
    overlay.show();
    await handleInput(text, { voice: true, alternatives });
  }

  /**
   * Typed or spoken input. Video commands we understand locally run instantly
   * ("can you pause the video", "go back 30 seconds and play", "1.5x"); anything
   * else goes to the AI, which may answer or send back commands (e.g. "go to
   * where he talks about recursion").
   */
  async function handleInput(text, { voice: spoken, alternatives = [], source }) {
    // Speech recognition gives several guesses ("pause the video" / "paws the video"):
    // run the first one that is a valid video command.
    for (const guess of [text, ...alternatives]) {
      const actions = NovaCommands.parse(guess);
      if (actions) {
        if (guess !== text) log(`Using alternative "${guess}" (top guess was "${text}")`);
        return runCommand(guess, actions, { spoken });
      }
    }
    await ask(text, { voice: spoken, source });
  }

  function allVideos() {
    // Panopto can show two synced streams (slides + camera): control them together.
    const list = Array.from(document.querySelectorAll("video"));
    if (state.video && !list.includes(state.video)) list.unshift(state.video);
    return list;
  }

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  /** Run actions on the lecture video. Returns per-action results for describe(). */
  function applyActions(actions) {
    const v = state.video;
    if (!v || !v.isConnected) return [{ ok: false, error: "I can't find the video on this page" }];
    const videos = allVideos();
    const results = [];
    for (const a of actions) {
      switch (a.type) {
        case "pause":
        case "play":
          cancelRefresh(); // a "redraw after jump" in progress stands down
          setPlaying(a.type === "play"); // lecture + slides together, via Panopto's button
          results.push({ type: a.type, ok: true });
          break;
        case "seek_to":
        case "seek_by": {
          const target = a.type === "seek_to" ? a.seconds : Math.round(getCurrentTime()) + a.seconds;
          const landed = seekTo(target); // both recordings
          results.push({ type: a.type, ok: true, time: Number.isFinite(landed) ? landed : getCurrentTime() });
          break;
        }
        case "speed":
        case "speed_by": {
          const rate = clamp(Math.round((a.type === "speed" ? a.rate : v.playbackRate + a.delta) * 100) / 100, 0.25, 3);
          videos.forEach((x) => (x.playbackRate = rate)); // both recordings at the same speed
          results.push({ type: a.type, ok: true, rate });
          break;
        }
        case "volume":
        case "volume_by": {
          // Only the lecture (#primaryVideo) has sound; the slides stream stays muted.
          let level;
          if (a.type === "volume_by" && a.delta > 0 && isMuted()) level = v.volume || 0.5; // "turn it up" while muted = unmute
          else level = clamp(a.type === "volume" ? a.level : (isMuted() ? 0 : v.volume) + a.delta, 0, 1);
          if (level > 0) {
            v.volume = level;
            setMuted(false);
          } else {
            setMuted(true);
          }
          results.push({ type: a.type, ok: true, level });
          break;
        }
        case "mute":
        case "unmute":
          setMuted(a.type === "mute");
          results.push({ type: a.type, ok: true });
          break;
      }
    }
    log("Video command", actions, "->", results);
    return results;
  }

  /** A command handled locally: run it, then confirm in the chat (and out loud if spoken). */
  function runCommand(text, actions, { spoken }) {
    const reply = NovaCommands.describe(applyActions(actions)) || "Done.";
    saveMessage({ role: "student", text, at: Date.now(), local: true });
    overlay.addMessage({ role: "student", text });
    const msg = { role: "nova", text: reply, at: Date.now(), local: true };
    saveMessage(msg);
    overlay.addMessage(msg);
    if (spoken) voice.speak(reply);
  }

  // ===========================================================================
  // Ask
  // ===========================================================================

  async function ask(question, { voice: spoken = false, source = "input" } = {}) {
    if (overlay.isTopicsOpen()) overlay.showChat(); // answers (typed or spoken) appear in the chat
    if (state.busy) return;
    const lectureId = state.lectureId;
    const currentTime = getCurrentTime();
    const context = getCaptionWindow(currentTime);
    const lang = currentLanguage();
    const language = lang ? `${lang.english} (${lang.label})` : null;
    const frame = captureFrame();
    const history = state.history.slice(); // before this question is added
    const payload = buildAskPayload({ lectureId, currentTime, question, context, history, voice: spoken, language, frame, source, title: state.title });

    log(
      `/ask at ${formatTime(currentTime)} with ${context.length} caption lines` +
        (context.length ? ` (${formatTime(context[0].start)}–${formatTime(context[context.length - 1].end)})` : "")
    );
    log("/ask payload", frame ? { ...payload, image: `<${Math.round(frame.length / 1024)} KB jpeg>` } : payload);

    const at = Date.now();
    saveMessage({ role: "student", text: question, time: payload.current_time, at });
    saveShot(lectureId, at);
    overlay.addMessage({ role: "student", text: question });
    setBusy(true);
    overlay.showTyping(true);

    const res = await sendToBackground({ type: "NOVA_ASK", payload });
    if (lectureId !== state.lectureId) return setBusy(false);
    overlay.showTyping(false);
    setBusy(false);

    const { reply, chips } = res.ok ? readAskResponse(res.data) : { reply: null, chips: null };
    if (!reply) {
      warn("/ask failed", res);
      overlay.addMessage({
        role: "nova",
        error: true,
        text: res.ok
          ? "I got an empty answer from the Nova server. Try asking again."
          : `I can't reach the Nova server right now (${backendErrorText(res)}). Try again in a moment.`,
      });
      return;
    }
    // The AI may answer a playback request with commands, e.g. "go to where he
    // talks about recursion" -> "Command: seek_to 7:48" + "Say: Jumping to 7:48 ...".
    const fromAI = NovaCommands.parseReply(reply);
    let body = reply;
    let commandMsg = false;
    if (fromAI.actions.length) {
      const done = NovaCommands.describe(applyActions(fromAI.actions));
      body = [fromAI.say || done, fromAI.rest].filter(Boolean).join("\n");
      commandMsg = true;
    }
    const { clean, watch } = parseWatch(body);
    // questionAt: the student message's time, which keys the slide thumbnail saved for it (Deep Dive uses it).
    const msg = { role: "nova", text: clean, watch, question, time: payload.current_time, questionAt: at, at: Date.now() };
    if (commandMsg) msg.local = true; // no "Deep Dive" on "Jumping to 7:48"
    if (res.stub) msg.stub = true;
    saveMessage(msg);
    overlay.addMessage(msg);
    if (chips) overlay.setChips(chips);
    // Spoken questions get spoken answers (unless the header toggle is set to text only),
    // in the subtitle language when one is picked (the answer is written in it).
    const replyLang = currentLanguage();
    if (spoken) voice.speak(clean, replyLang ? replyLang.speechLang : "");
  }

  // ---- Export notes ------------------------------------------------------------

  /** Keeps a thumbnail of the slide for the question asked at `at`, for the notes export. */
  async function saveShot(lectureId, at) {
    if (!SAVE_SHOTS) return;
    const shot = grabFrame(SHOT_MAX_WIDTH, SHOT_QUALITY);
    if (!shot) return;
    const shots = (await storageGet(shotsKey(lectureId))) || {};
    shots[at] = shot;
    const keys = Object.keys(shots).sort((a, b) => Number(a) - Number(b));
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SHOTS_PER_LECTURE))) delete shots[k]; // oldest go first
    await storageSet(shotsKey(lectureId), shots);
  }

  /** "Export notes": the chat you're in, as a Markdown file or a web page that prints to PDF. */
  async function exportNotes(format) {
    const lectureId = state.lectureId;
    const shots = (await storageGet(shotsKey(lectureId))) || {};
    const model = {
      title: state.title,
      url: location.href.split("#")[0],
      exportedAt: new Date(),
      messages: state.history,
      shots,
    };
    const notes = NovaNotes.build(model);
    if (!notes.counts.qa && !notes.counts.summary) {
      overlay.setNotice({ key: "notes", kind: "info", text: "Nothing to export yet. Ask Nova a question or summarize the lecture first." });
      return;
    }
    const html = format === "html";
    const blob = new Blob([html ? notes.html : notes.markdown], { type: html ? "text/html" : "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = NovaNotes.fileName(state.title || lectureId, html ? "html" : "md");
    a.style.display = "none";
    overlay.host.shadowRoot.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    log(`Exported ${a.download} (${notes.counts.qa} answers, ${notes.counts.shots} screenshots${notes.counts.summary ? ", summary" : ""})`);
    overlay.setNotice({
      key: "notes",
      kind: "success",
      text: html ? "Notes downloaded. Open the file and choose Print, then Save as PDF." : "Notes downloaded as Markdown.",
    });
  }

  /** "Summarize this lecture": one /summary call, shown as a message with clickable chapters. */
  async function summarize() {
    if (state.busy) return;
    if (!state.captions.length) {
      overlay.setNotice({ key: "summary", kind: "warn", text: "Captions aren't loaded yet, so there's nothing to summarize. Try again in a moment." });
      return;
    }
    const lectureId = state.lectureId;
    const lang = currentLanguage();
    const payload = {
      lecture_id: lectureId,
      title: state.title,
      captions: state.captions.map((c) => ({ start: c.start, end: c.end, text: c.text })), // in case the server restarted
    };
    if (lang) payload.language = `${lang.english} (${lang.label})`; // summary and chapter titles come back in it
    log(`/summary with ${payload.captions.length} caption lines${payload.language ? ` in ${payload.language}` : ""}`);

    overlay.clearNotice("summary");
    saveMessage({ role: "student", text: SUMMARY_PROMPT, time: getCurrentTime(), at: Date.now() });
    overlay.addMessage({ role: "student", text: SUMMARY_PROMPT });
    setBusy(true);
    overlay.showTyping(true);

    const res = await sendToBackground({ type: "NOVA_SUMMARY", payload });
    if (lectureId !== state.lectureId) return setBusy(false);
    overlay.showTyping(false);
    setBusy(false);

    const data = res.ok ? res.data : null;
    if (!data || typeof data.summary !== "string" || !data.summary.trim()) {
      warn("/summary failed", res);
      overlay.addMessage({
        role: "nova",
        error: true,
        text: res.ok
          ? "I couldn't put a summary together. Try again in a moment."
          : `I can't reach the Nova server right now (${backendErrorText(res)}). Try again in a moment.`,
      });
      return;
    }
    const points = Array.isArray(data.key_points) ? data.key_points.filter((p) => typeof p === "string" && p.trim()) : [];
    const chapters = Array.isArray(data.chapters)
      ? data.chapters.filter((c) => c && Number.isFinite(c.start) && typeof c.title === "string" && c.title.trim())
      : [];
    const text = `**Summary:** ${data.summary.trim()}` + (points.length ? `\n**Key points:**\n${points.map((p) => `• ${p}`).join("\n")}` : "");
    const msg = { role: "nova", text, summary: data.summary.trim(), key_points: points, chapters, at: Date.now() };
    if (res.stub) msg.stub = true;
    saveMessage(msg);
    overlay.addMessage(msg);
  }

  /** The whiteboard teaches in the subtitle language when one is picked. */
  function lessonLanguage() {
    const lang = currentLanguage();
    return lang ? { language: `${lang.english} (${lang.label})`, speech_lang: lang.speechLang } : {};
  }

  // Opens the whiteboard tab (explain.html) for an Nova reply.
  /**
   * The slide for a Deep Dive: a fresh, full-size frame if the video is still near the moment of the
   * question (so code on screen is readable), otherwise the thumbnail saved when the question was asked.
   */
  async function explainFrame(msg) {
    const v = state.video;
    if (v && Number.isFinite(msg.time) && Math.abs(v.currentTime - msg.time) <= DEEP_DIVE_FRAME_WINDOW_S) {
      const fresh = grabFrame(FRAME_MAX_WIDTH, FRAME_QUALITY);
      if (fresh) return fresh;
    }
    const shots = (await storageGet(shotsKey(state.lectureId))) || {};
    return (msg.questionAt && shots[msg.questionAt]) || null;
  }

  async function explainInDepth(msg) {
    const image = SEND_FRAME ? await explainFrame(msg) : null;
    sendToBackground({
      type: "NOVA_EXPLAIN_OPEN",
      payload: {
        lecture_id: state.lectureId,
        question: msg.question || "",
        reply: msg.text,
        current_time: msg.time || 0,
        image, // lets Deep Dive find code on the professor's screen
        ...lessonLanguage(),
      },
    });
  }

  function setBusy(value) {
    state.busy = value;
    overlay.setBusy(value);
  }

  // ---- Chat sessions ---------------------------------------------------------
  // Each lecture keeps a list of chats. Opening the page starts a fresh one (an empty chat
  // is reused, never piled up); older chats stay in the menu so the student can reopen them.

  const newSessionId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const activeSession = () => state.sessions.list.find((x) => x.id === state.sessions.activeId);

  function startSession() {
    const empty = state.sessions.list.find((x) => !x.messages.length);
    const session = empty || { id: newSessionId(), title: "", at: Date.now(), messages: [] };
    if (!empty) state.sessions.list.unshift(session);
    state.sessions.activeId = session.id;
    state.history = session.messages;
  }

  async function loadSessions(lectureId) {
    let saved = await storageGet(sessionsKey(lectureId));
    if (!saved || !Array.isArray(saved.list)) {
      saved = { activeId: null, list: [] };
      const legacy = await storageGet(chatKey(lectureId)); // the single chat saved before sessions existed
      if (Array.isArray(legacy) && legacy.length) {
        const first = legacy.find((m) => m.role === "student");
        saved.list.push({ id: newSessionId(), title: first ? first.text : "Earlier chat", at: legacy[legacy.length - 1].at || Date.now(), messages: legacy });
      }
    }
    state.sessions = saved;
    startSession();
    persistSessions();
  }

  function persistSessions() {
    const list = state.sessions.list.filter((x) => x.messages.length || x.id === state.sessions.activeId).slice(0, MAX_SESSIONS);
    state.sessions.list = list;
    storageSet(sessionsKey(state.lectureId), state.sessions);
  }

  function refreshSessionList() {
    overlay.setSessions({
      activeId: state.sessions.activeId,
      list: state.sessions.list.filter((x) => x.messages.length).map((x) => ({ id: x.id, title: x.title || "New chat", at: x.at })),
    });
  }

  function showSession() {
    overlay.setHistory(state.history);
    overlay.setChips(DEFAULT_CHIPS);
    refreshSessionList();
  }

  function newChat() {
    if (state.busy) return;
    if (state.history.length) {
      const session = { id: newSessionId(), title: "", at: Date.now(), messages: [] };
      state.sessions.list.unshift(session);
      state.sessions.activeId = session.id;
      state.history = session.messages;
    }
    persistSessions();
    showSession();
    log("New chat for", state.lectureId);
  }

  function switchChat(id) {
    const target = state.sessions.list.find((x) => x.id === id);
    if (state.busy || !target || id === state.sessions.activeId) return;
    state.sessions.activeId = id;
    state.history = target.messages;
    persistSessions();
    showSession();
  }

  function saveMessage(msg) {
    const session = activeSession();
    if (!session) return;
    state.history.push(msg);
    if (state.history.length > MAX_SAVED_MESSAGES) state.history.splice(0, state.history.length - MAX_SAVED_MESSAGES);
    if (!session.title && msg.role === "student") session.title = String(msg.text || "").slice(0, 60);
    session.at = Date.now();
    persistSessions();
    refreshSessionList();
  }

  /** "Clear chat": deletes the chat you're in. */
  async function clearChat() {
    state.sessions.list = state.sessions.list.filter((x) => x.id !== state.sessions.activeId);
    startSession();
    persistSessions();
    showSession();
    log("Chat cleared for", state.lectureId);
  }

  // ===========================================================================
  // Part 5: translated subtitles + spoken translation
  // ===========================================================================

  const SUBTITLE_SETTINGS_KEY = "nova:subtitles";
  const translationsKey = (id, code) => `nova:translations:${id}:${code}`;
  const shortCode = (code) => String(code).split("-")[0].toUpperCase();

  const currentLanguage = () => SUBTITLE_LANGUAGES.find((l) => l.code === subs.language) || null;

  async function initSubtitles() {
    if (typeof NovaSubtitles === "undefined" || typeof NovaVoice === "undefined") return;
    subs.ui = NovaSubtitles.create({ cssUrl: chrome.runtime.getURL("subtitles.css"), mascotUrl: chrome.runtime.getURL("icons/nova.png"), getCardRect: () => overlay.getCardRect() });
    await subs.ui.mount();
    subs.voiceEngine = NovaVoice.create({
      getVideos: () => document.querySelectorAll("video"),
      onSpeaking: (on) => subs.ui.setSpeaking(on),
    });
    if (typeof speechSynthesis !== "undefined") speechSynthesis.addEventListener("voiceschanged", renderSubtitleControls);

    const saved = (await storageGet(SUBTITLE_SETTINGS_KEY)) || {};
    subs.mode = saved.mode === "dual" ? "dual" : "translated";
    subs.originalAudio = saved.originalAudio === "lowered" ? "lowered" : "muted";
    subs.voiceEngine.setOriginalAudio(subs.originalAudio);
    subs.lastLanguage = saved.lastLanguage || null;
    const lang = SUBTITLE_LANGUAGES.find((l) => l.code === saved.language);
    if (lang) {
      subs.language = lang.code;
      subs.ui.setEnabled(true);
      subs.voiceEngine.setLanguage(lang);
      // Browsers only allow audio after a click, so voice waits for one tap after a reload
      // (the notice is shown once the chat is loaded, in openLecture).
      subs.offerVoice = Boolean(saved.voice);
    }
    renderSubtitleControls();
  }

  function saveSubtitleSettings() {
    storageSet(SUBTITLE_SETTINGS_KEY, {
      language: subs.language,
      mode: subs.mode,
      voice: subs.voice,
      originalAudio: subs.originalAudio,
      lastLanguage: subs.lastLanguage,
    });
  }

  function voiceNote() {
    const engine = subs.voiceEngine;
    const lang = currentLanguage();
    if (!engine || !engine.available()) return { voiceNote: "This browser can't speak.", voiceWarn: true, canVoice: false };
    if (!lang) return { voiceNote: "Pick a language first.", voiceWarn: false, canVoice: true };
    if (!subs.voice) return { voiceNote: "Reads the translation aloud in sync with the video.", voiceWarn: false, canVoice: true };
    const v = engine.voiceFor(lang.speechLang);
    const audio =
      subs.originalAudio === "lowered"
        ? `Professor's audio lowered to ${Math.round(NovaVoice.DUCK_VOLUME * 100)}%.`
        : "Professor's audio is muted.";
    return v
      ? { voiceNote: `Speaking with ${v.name}. ${audio}`, voiceWarn: false, canVoice: true }
      : {
          voiceNote: `No ${lang.label} voice on this computer, so the default voice is used. Install one in system settings.`,
          voiceWarn: true,
          canVoice: true,
        };
  }

  function renderSubtitleControls() {
    overlay.setSubtitles({
      language: subs.language,
      mode: subs.mode,
      voice: subs.voice,
      originalAudio: subs.originalAudio,
      progress: subs.translator && state.captions.length ? subs.translator.info() : null,
      ...voiceNote(),
    });
  }

  /** "Ready" / "NN%" next to each language in the popover, from what's cached for this lecture. */
  async function refreshLanguageStates() {
    if (!state.captions.length) return;
    const keys = SUBTITLE_LANGUAGES.map((l) => translationsKey(state.lectureId, l.code));
    let stored = {};
    try {
      stored = await chrome.storage.local.get(keys);
    } catch (_) {
      return;
    }
    const states = {};
    for (const l of SUBTITLE_LANGUAGES) {
      const n = Object.keys(stored[translationsKey(state.lectureId, l.code)] || {}).length;
      if (n >= state.captions.length) states[l.code] = "Ready";
      else if (n > 0) states[l.code] = `${Math.floor((n / state.captions.length) * 100)}%`;
    }
    overlay.setSubtitles({ states });
  }

  function setSubtitleLanguage(code, { announce = false } = {}) {
    const lang = SUBTITLE_LANGUAGES.find((l) => l.code === code) || null;
    if ((lang && lang.code) === subs.language) return;
    subs.language = lang ? lang.code : null;
    if (lang) subs.lastLanguage = lang.code;
    saveSubtitleSettings();
    subs.voiceEngine.setLanguage(lang);
    if (!lang) {
      setVoice(false);
      stopTranslation();
      subs.ui.setEnabled(false);
      overlay.clearNotice("subtitles");
      overlay.clearNotice("voice");
      renderSubtitleControls();
      log("Subtitles off");
      return;
    }
    subs.ui.setEnabled(true);
    startTranslation();
    if (announce) {
      const info = subs.translator ? subs.translator.info() : null;
      const needsWork = !info || info.done < info.total;
      overlay.setNotice({
        key: "subtitles",
        kind: "success",
        text: `Subtitles on in ${lang.label}.${needsWork && state.captions.length ? " Translating from where you are…" : ""}`,
      });
    }
    log("Subtitles on:", lang.code);
  }

  function setSubtitleMode(mode) {
    subs.mode = mode === "dual" ? "dual" : "translated";
    saveSubtitleSettings();
    renderSubtitleControls();
    refreshSubtitle();
  }

  /** Called inside the switch's click handler, which is what lets the browser play speech. */
  function setVoice(on) {
    on = Boolean(on && subs.language);
    if (on) subs.voiceEngine.prime();
    subs.voice = on;
    subs.voiceEngine.setEnabled(on);
    subs.ui.setVoice(on);
    overlay.clearNotice("voice");
    subs.offerVoice = false;
    saveSubtitleSettings();
    renderSubtitleControls();
    log(on ? "Spoken translation on" : "Spoken translation off");
  }

  function setOriginalAudio(mode) {
    subs.originalAudio = mode === "lowered" ? "lowered" : "muted";
    subs.voiceEngine.setOriginalAudio(subs.originalAudio);
    saveSubtitleSettings();
    renderSubtitleControls();
    log(`Professor's audio while speaking: ${subs.originalAudio}`);
  }

  function offerVoiceResume() {
    overlay.setNotice({
      key: "voice",
      kind: "info",
      text: "Spoken translation was on. Tap to turn the voice back on.",
      actionLabel: "Resume voice",
      onAction: () => setVoice(true),
    });
  }

  function stopTranslation() {
    subs.token++;
    if (subs.translator) subs.translator.stop();
    subs.translator = null;
    if (subs.voiceEngine) subs.voiceEngine.reset();
    if (subs.ui) subs.ui.render(null);
  }

  async function startTranslation() {
    stopTranslation();
    const lang = currentLanguage();
    if (!lang || !state.captions.length) {
      renderSubtitleControls();
      return;
    }
    const token = subs.token;
    const lectureId = state.lectureId;
    const cues = state.captions;
    const key = translationsKey(lectureId, lang.code);
    let cache = (await storageGet(key)) || {};
    if (token !== subs.token) return;

    if (!Object.keys(cache).length && PANOPTO_LANGUAGE_IDS[lang.code] != null) {
      const native = await fetchPanoptoTranslation(lectureId, lang.code, cues);
      if (token !== subs.token) return;
      if (native) {
        cache = native;
        await storageSet(key, cache);
        log(`Using Panopto's own ${lang.code} captions`);
      }
    }
    log(`Translations: ${Object.keys(cache).length}/${cues.length} cached (${lang.code})`);

    subs.translator = NovaTranslator.create({
      cues,
      cache,
      getTime: getCurrentTime,
      translateBatch: async (batch) => {
        const payload = buildTranslatePayload({ lectureId, title: state.title, targetLanguage: lang.code, cues: batch });
        const res = await sendToBackground({ type: "NOVA_TRANSLATE", payload });
        if (!res.ok) {
          warn("/translate failed", res.error, res.status || "", res.detail || "");
          return { ok: false };
        }
        return { ok: true, map: readTranslateResponse(res.data) };
      },
      onSave: (snapshot) => token === subs.token && storageSet(key, snapshot),
      onChange: (info) => {
        if (token !== subs.token) return;
        renderSubtitleControls();
        refreshSubtitle();
        if (!info.active) refreshLanguageStates();
      },
    });
    subs.translator.start();
    renderSubtitleControls();
    refreshSubtitle();
    refreshLanguageStates();
  }

  /** Professor-uploaded captions in another language, matched to our cues by timing. */
  async function fetchPanoptoTranslation(lectureId, code, cues) {
    const url = buildCaptionUrl(lectureId).replace(/language=\d+/, `language=${PANOPTO_LANGUAGE_IDS[code]}`);
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return null;
      const other = parseSRT(await res.text());
      if (other.length !== cues.length) return null;
      const map = {};
      for (let i = 0; i < cues.length; i++) {
        if (Math.abs(other[i].start - cues[i].start) > 0.5) return null; // timings don't line up
        map[i] = other[i].text;
      }
      return map;
    } catch (_) {
      return null;
    }
  }

  /** Show the line at the current time, and speak it if voice is on. */
  function refreshSubtitle() {
    if (!subs.ui) return;
    const lang = currentLanguage();
    if (!lang || !state.captions.length) {
      subs.ui.render(null);
      return;
    }
    const t = getCurrentTime();
    const index = NovaTranslator.cueIndexAt(state.captions, t);
    if (index < 0) {
      subs.ui.render(null);
      return;
    }
    const cue = state.captions[index];
    const tr = subs.translator;
    const translation = tr ? tr.get(index) : null;
    const failed = Boolean(!translation && tr && tr.isFailed(index));
    subs.ui.render({
      key: index,
      langCode: shortCode(lang.code),
      mode: subs.mode,
      original: cue.text,
      translation: translation || "",
      pending: !translation && !failed,
      failed,
    });
    const v = state.video;
    subs.voiceEngine.lineAt({
      index,
      start: cue.start,
      end: cue.end,
      text: translation || null,
      t,
      playbackRate: v ? v.playbackRate : 1,
      playing: Boolean(v && !v.paused && !v.ended),
    });
  }

  // ===========================================================================
  // Part 6: hot topics (what students ask about most in this lecture)
  // ===========================================================================

  let topicsToken = 0;

  // Hot topics is instructor-only: the key is entered once (⋯ → Instructor view…) and kept in
  // chrome.storage.local for this browser. The background sends it as X-Instructor-Key.
  const INSTRUCTOR_KEY_STORAGE = "nova:instructorKey";

  async function initInstructor() {
    const key = await storageGet(INSTRUCTOR_KEY_STORAGE);
    overlay.setInstructor(Boolean(key));
    // Unlocking or exiting in another tab applies here too.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[INSTRUCTOR_KEY_STORAGE]) return;
      overlay.setInstructor(Boolean(changes[INSTRUCTOR_KEY_STORAGE].newValue));
    });
  }

  function refusedText(res) {
    if (res.status === 403) return "Instructor view is turned off on the server (NOVA_INSTRUCTOR_KEY isn't set).";
    if (res.status === 401) return "That key didn't work. Check it and try again.";
    return `The Nova server isn't reachable right now (${backendErrorText(res)}).`;
  }

  async function unlockInstructor(key) {
    const lectureId = state.lectureId;
    const res = await sendToBackground({ type: "NOVA_INSTRUCTOR_CHECK", key, payload: buildTopicsPayload({ lectureId }) });
    if (!res.ok) {
      warn("Instructor key refused", res.status || res.error);
      overlay.setInstructorLogin({ error: refusedText(res) });
      return;
    }
    await storageSet(INSTRUCTOR_KEY_STORAGE, key);
    overlay.setInstructorLogin({});
    overlay.setInstructor(true);
    log("Instructor view on");
    overlay.showChat();
    openDashboard(); // straight to the dashboard for this lecture
  }

  /** Hot topics lives on the instructor dashboard (new tab), opened on this lecture. */
  function openDashboard() {
    return sendToBackground({ type: "NOVA_OPEN_DASHBOARD", lectureId: state.lectureId });
  }

  async function exitInstructor() {
    await storageRemove(INSTRUCTOR_KEY_STORAGE);
    overlay.setInstructor(false);
    overlay.showChat();
    log("Instructor view off");
  }

  async function loadTopics({ refresh = false } = {}) {
    const lectureId = state.lectureId;
    const token = ++topicsToken;
    overlay.setTopics({ state: "loading" });
    const res = await sendToBackground({ type: "NOVA_TOPICS", payload: buildTopicsPayload({ lectureId, refresh }) });
    if (token !== topicsToken || lectureId !== state.lectureId) return;
    if (!res.ok) {
      warn("/topics failed", res.error, res.status || "", res.detail || "");
      if (res.status === 401) {
        // The key was changed on the server: leave instructor view and ask for the new one.
        await storageRemove(INSTRUCTOR_KEY_STORAGE);
        overlay.setInstructor(false);
        overlay.showInstructorLogin();
        overlay.setInstructorLogin({ error: "Your instructor key no longer works. Enter the new one." });
        return;
      }
      overlay.setTopics({ state: "error", error: refusedText(res) });
      return;
    }
    const { status, topics, total, times, updatedAt } = readTopicsResponse(res.data);
    log(`Hot topics: ${topics.length} themes from ${total} questions`);
    overlay.setTopics(status === "empty" || !topics.length ? { state: "empty" } : { state: "ready", topics, total, updatedAt, times, duration: state.video && Number.isFinite(state.video.duration) ? state.video.duration : 0 });
  }

  // ===========================================================================
  // Helpers: background messaging + storage
  // ===========================================================================

  function backendErrorText(res) {
    if (res.status) return `HTTP ${res.status}`;
    if (res.error === "timeout") return "the request timed out";
    if (res.error === "extension-reloaded") return "Nova was updated, reload this page";
    return "server unreachable";
  }

  async function sendToBackground(message) {
    try {
      const res = await chrome.runtime.sendMessage(message);
      return res || { ok: false, error: "no-response" };
    } catch (err) {
      if (/context invalidated/i.test(String(err && err.message))) {
        overlay.setNotice({ kind: "warn", text: "Nova was updated. Reload this page to keep using it." });
        return { ok: false, error: "extension-reloaded" };
      }
      return { ok: false, error: "unreachable", detail: String(err && err.message) };
    }
  }

  const captionsKey = (id) => `nova:captions:${id}`;
  const chatKey = (id) => `nova:chat:${id}`; // legacy single chat, migrated into a session
  const sessionsKey = (id) => `nova:sessions:${id}`;
  const shotsKey = (id) => `nova:shots:${id}`; // { [question time "at"]: base64 slide thumbnail }

  async function storageGet(key) {
    try {
      return (await chrome.storage.local.get(key))[key];
    } catch (err) {
      warn("storage read failed", key, err);
      return undefined;
    }
  }

  async function storageSet(key, value) {
    try {
      await chrome.storage.local.set({ [key]: value });
    } catch (err) {
      warn("storage write failed (quota?)", key, err);
    }
  }

  async function storageRemove(key) {
    try {
      await chrome.storage.local.remove(key);
    } catch (err) {
      warn("storage remove failed", key, err);
    }
  }
})();
