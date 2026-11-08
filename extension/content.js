/*
 * Orbit: content script.
 *
 * Runs in every Panopto Viewer.aspx / Embed.aspx frame (including Canvas iframes),
 * but only does anything in a frame whose URL has a lecture "id". It:
 *   1. reads the lecture ID and title, and mounts the overlay (overlay.js)
 *   2. fetches the captions with the student's Panopto session, parses them (srt.js),
 *      caches them, and sends them to the backend through background.js
 *   3. follows the <video> element's playback time
 *   4. sends questions plus the last 90 seconds of captions to the backend
 *   5. translated subtitles (translator.js + subtitles.js) and spoken translation (voice.js)
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
  const CAPTION_WINDOW_SECONDS = 90;

  /** Static suggestion chips. Replaced by `chips` from /ask when the backend sends them. */
  const DEFAULT_CHIPS = ["Explain what was just said", "Give me an example", "Quiz me on this"];

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
   * in that language, Orbit uses it instead of machine translation. Empty = always use /translate.
   */
  const PANOPTO_LANGUAGE_IDS = {};

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
  function buildAskPayload({ lectureId, currentTime, question, context, language }) {
    const payload = {
      lecture_id: lectureId,
      current_time: Math.round(currentTime * 10) / 10,
      question,
      context: context.map((c) => ({ start: c.start, end: c.end, text: c.text })),
    };
    // Only when translated subtitles are on, e.g. "Spanish (Español)". The reply comes back in it.
    if (language) payload.language = language;
    return payload;
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

  if (window.__orbitContentLoaded) return;
  window.__orbitContentLoaded = true;

  const log = (...args) => console.log("[Orbit]", ...args);
  const warn = (...args) => console.warn("[Orbit]", ...args);
  const { parseSRT, captionWindow, formatTime, parseTimestamp } = globalThis.OrbitSRT;

  function getLectureId() {
    for (const [key, value] of new URLSearchParams(location.search)) {
      if (key.toLowerCase() === "id" && value.trim()) return value.trim();
    }
    return null;
  }

  const initialId = getLectureId();
  if (!initialId) return; // not a lecture frame: do nothing at all

  OrbitOverlay.installKeyGuard();

  const state = {
    lectureId: initialId,
    title: "",
    captions: [],
    history: [],
    busy: false,
    video: null,
    lastTime: 0,
    loadToken: 0,
  };
  let overlay = null;

  // Translated subtitles: language/mode/voice are the student's saved choices; the rest is runtime state.
  const subs = { language: null, mode: "translated", voice: false, lastLanguage: null, translator: null, ui: null, voiceEngine: null, token: 0 };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }

  async function start() {
    overlay = OrbitOverlay.create({
      cssUrl: chrome.runtime.getURL("overlay.css"),
      mascotUrl: chrome.runtime.getURL("icons/orbit.png"),
      windowSeconds: CAPTION_WINDOW_SECONDS,
      onSend: (text) => ask(text),
      onDownload: downloadJson,
      onReloadCaptions: () => loadCaptions({ force: true }),
      onClearChat: clearChat,
      onSeek: seekTo,
      subtitleLanguages: SUBTITLE_LANGUAGES,
      onSubtitleLanguage: (code) => setSubtitleLanguage(code, { announce: true }),
      onSubtitleMode: setSubtitleMode,
      onVoiceToggle: setVoice,
      onRetryTranslation: () => subs.translator && subs.translator.retryFailed(),
      onLayoutChange: () => subs.ui && subs.ui.relayout(),
    });

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === "ORBIT_TOGGLE") {
        const visible = overlay.toggleVisible();
        log(visible ? "Overlay shown" : "Overlay hidden");
        sendResponse({ ok: true, visible, lectureId: state.lectureId });
      }
    });

    await overlay.mount();
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
    state.title = resolveTitle();
    log("Lecture detected", { id: lectureId, title: state.title, frame: window === window.top ? "top" : "iframe" });
    overlay.setLecture({ id: lectureId, title: state.title });
    overlay.setDownloadEnabled(false);
    overlay.setContextLabel(`Using the last ${CAPTION_WINDOW_SECONDS} seconds of captions`);
    overlay.setChips(DEFAULT_CHIPS);
    refineTitleLater(lectureId);

    state.history = (await storageGet(chatKey(lectureId))) || [];
    if (lectureId !== state.lectureId) return;
    overlay.setHistory(state.history);
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
        text: "You're not signed in to Panopto, so Orbit can't read the captions. Sign in to Panopto in this browser, then retry.",
        detail,
        ...retry,
      });
    } else if (kind === "empty") {
      overlay.setContextLabel("No captions on this lecture");
      overlay.setNotice({
        kind: "info",
        text: "This lecture doesn't have captions yet, so Orbit can't see what was said. You can still ask general questions.",
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
    overlay.setNotice({ kind: "loading", text: `Loaded ${count} caption lines. Sending them to Orbit…` });
    const payload = buildLecturePayload({ lectureId, title: state.title, captions: state.captions });
    const res = await sendToBackground({ type: "ORBIT_UPLOAD_LECTURE", payload });
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
      text: `Loaded ${count} caption lines, but the Orbit server isn't reachable, so answers may not work yet. You can still download the captions from the ⋯ menu.`,
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

  function seekTo(seconds) {
    const v = state.video;
    if (v && v.isConnected && Number.isFinite(seconds)) {
      v.currentTime = seconds;
    }
  }

  // Extract "Watch: M:SS-M:SS, description" from an Orbit reply.
  // Returns { clean: text without watch line, watch: { start, end, label } | null }.
  function parseWatch(text) {
    const match = text.match(/\nWatch:\s*([^\n]+)/i) || text.match(/^Watch:\s*([^\n]+)/im);
    if (!match) return { clean: text, watch: null };
    const clean = text.replace(match[0], "").trim();
    const timeMatch = match[1].trim().match(/^([\d:]+)\s*[-–]\s*([\d:]+)(?:[,.]?\s*(.+))?/);
    if (!timeMatch) return { clean: text, watch: null };
    const start = parseTimestamp(timeMatch[1]);
    const end = parseTimestamp(timeMatch[2]);
    if (!Number.isFinite(start)) return { clean: text, watch: null };
    return { clean, watch: { start, end: Number.isFinite(end) ? end : start, label: timeMatch[3] ? timeMatch[3].trim() : "" } };
  }

  async function ask(question) {
    if (state.busy) return;
    const lectureId = state.lectureId;
    const currentTime = getCurrentTime();
    const context = getCaptionWindow(currentTime);
    const lang = currentLanguage();
    const language = lang ? `${lang.english} (${lang.label})` : null;
    const payload = buildAskPayload({ lectureId, currentTime, question, context, language });

    log(
      `/ask at ${formatTime(currentTime)} with ${context.length} caption lines` +
        (context.length ? ` (${formatTime(context[0].start)}–${formatTime(context[context.length - 1].end)})` : "")
    );
    log("/ask payload", payload);

    saveMessage({ role: "student", text: question, time: payload.current_time, at: Date.now() });
    overlay.addMessage({ role: "student", text: question });
    setBusy(true);
    overlay.showTyping(true);

    const res = await sendToBackground({ type: "ORBIT_ASK", payload });
    if (lectureId !== state.lectureId) return setBusy(false);
    overlay.showTyping(false);
    setBusy(false);

    const { reply, chips } = res.ok ? readAskResponse(res.data) : { reply: null, chips: null };
    if (!reply) {
      warn("/ask failed", res);
      overlay.addMessage({
        role: "orbit",
        error: true,
        text: res.ok
          ? "I got an empty answer from the Orbit server. Try asking again."
          : `I can't reach the Orbit server right now (${backendErrorText(res)}). Try again in a moment.`,
      });
      return;
    }
    const { clean, watch } = parseWatch(reply);
    const msg = { role: "orbit", text: clean, watch, at: Date.now() };
    if (res.stub) msg.stub = true;
    saveMessage(msg);
    overlay.addMessage(msg);
    if (chips) overlay.setChips(chips);
  }

  function setBusy(value) {
    state.busy = value;
    overlay.setBusy(value);
  }

  function saveMessage(msg) {
    state.history.push(msg);
    if (state.history.length > MAX_SAVED_MESSAGES) state.history.splice(0, state.history.length - MAX_SAVED_MESSAGES);
    storageSet(chatKey(state.lectureId), state.history);
  }

  async function clearChat() {
    state.history = [];
    await storageRemove(chatKey(state.lectureId));
    overlay.setHistory([]);
    overlay.setChips(DEFAULT_CHIPS);
    log("Chat cleared for", state.lectureId);
  }

  // ===========================================================================
  // Part 5: translated subtitles + spoken translation
  // ===========================================================================

  const SUBTITLE_SETTINGS_KEY = "orbit:subtitles";
  const translationsKey = (id, code) => `orbit:translations:${id}:${code}`;
  const shortCode = (code) => String(code).split("-")[0].toUpperCase();

  const currentLanguage = () => SUBTITLE_LANGUAGES.find((l) => l.code === subs.language) || null;

  async function initSubtitles() {
    subs.ui = OrbitSubtitles.create({ cssUrl: chrome.runtime.getURL("subtitles.css"), getCardRect: () => overlay.getCardRect() });
    await subs.ui.mount();
    subs.voiceEngine = OrbitVoice.create({
      getVideos: () => document.querySelectorAll("video"),
      onSpeaking: (on) => subs.ui.setSpeaking(on),
    });
    if (typeof speechSynthesis !== "undefined") speechSynthesis.addEventListener("voiceschanged", renderSubtitleControls);

    const saved = (await storageGet(SUBTITLE_SETTINGS_KEY)) || {};
    subs.mode = saved.mode === "dual" ? "dual" : "translated";
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
    storageSet(SUBTITLE_SETTINGS_KEY, { language: subs.language, mode: subs.mode, voice: subs.voice, lastLanguage: subs.lastLanguage });
  }

  function voiceNote() {
    const engine = subs.voiceEngine;
    const lang = currentLanguage();
    if (!engine || !engine.available()) return { voiceNote: "This browser can't speak.", voiceWarn: true, canVoice: false };
    if (!lang) return { voiceNote: "Pick a language first.", voiceWarn: false, canVoice: true };
    if (!subs.voice) return { voiceNote: "Reads the translation aloud in sync with the video.", voiceWarn: false, canVoice: true };
    const v = engine.voiceFor(lang.speechLang);
    const duck = Math.round(OrbitVoice.DUCK_VOLUME * 100);
    return v
      ? { voiceNote: `Speaking with ${v.name}. Professor's audio lowered to ${duck}%.`, voiceWarn: false, canVoice: true }
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

    subs.translator = OrbitTranslator.create({
      cues,
      cache,
      getTime: getCurrentTime,
      translateBatch: async (batch) => {
        const payload = buildTranslatePayload({ lectureId, title: state.title, targetLanguage: lang.code, cues: batch });
        const res = await sendToBackground({ type: "ORBIT_TRANSLATE", payload });
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
    const index = OrbitTranslator.cueIndexAt(state.captions, t);
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
  // Helpers: background messaging + storage
  // ===========================================================================

  function backendErrorText(res) {
    if (res.status) return `HTTP ${res.status}`;
    if (res.error === "timeout") return "the request timed out";
    if (res.error === "extension-reloaded") return "Orbit was updated, reload this page";
    return "server unreachable";
  }

  async function sendToBackground(message) {
    try {
      const res = await chrome.runtime.sendMessage(message);
      return res || { ok: false, error: "no-response" };
    } catch (err) {
      if (/context invalidated/i.test(String(err && err.message))) {
        overlay.setNotice({ kind: "warn", text: "Orbit was updated. Reload this page to keep using it." });
        return { ok: false, error: "extension-reloaded" };
      }
      return { ok: false, error: "unreachable", detail: String(err && err.message) };
    }
  }

  const captionsKey = (id) => `orbit:captions:${id}`;
  const chatKey = (id) => `orbit:chat:${id}`;

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
