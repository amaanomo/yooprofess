/*
 * Nova: content script.
 *
 * Runs in every Panopto Viewer.aspx / Embed.aspx frame (including Canvas iframes),
 * but only does anything in a frame whose URL has a lecture "id". It:
 *   1. reads the lecture ID and title, and mounts the overlay (overlay.js)
 *   2. fetches the captions with the student's Panopto session, parses them (srt.js),
 *      caches them, and sends them to the backend through background.js
 *   3. follows the <video> element's playback time
 *   4. sends questions plus the last 90 seconds of captions to the backend
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
  function buildAskPayload({ lectureId, currentTime, question, context }) {
    return {
      lecture_id: lectureId,
      current_time: Math.round(currentTime * 10) / 10,
      question,
      context: context.map((c) => ({ start: c.start, end: c.end, text: c.text })),
    };
  }

  /** Expected /ask response: { "reply": "...", "chips": ["...", ...] }  (chips optional). */
  function readAskResponse(data) {
    if (typeof data === "string") return { reply: data, chips: null };
    const reply = data && (data.reply ?? data.answer ?? data.message);
    const chips = data && Array.isArray(data.chips) && data.chips.length ? data.chips : null;
    return { reply: typeof reply === "string" && reply.trim() ? reply : null, chips };
  }

  // ===========================================================================
  // Startup
  // ===========================================================================

  if (window.__novaContentLoaded) return;
  window.__novaContentLoaded = true;

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
    busy: false,
    video: null,
    lastTime: 0,
    loadToken: 0,
  };
  let overlay = null;

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
      onSend: (text) => ask(text),
      onDownload: downloadJson,
      onReloadCaptions: () => loadCaptions({ force: true }),
      onClearChat: clearChat,
      onSeek: seekTo,
      onExplain: explainInDepth,
    });

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === "NOVA_TOGGLE") {
        const visible = overlay.toggleVisible();
        log(visible ? "Overlay shown" : "Overlay hidden");
        sendResponse({ ok: true, visible, lectureId: state.lectureId });
      }
    });

    await overlay.mount();
    overlay.setChips(DEFAULT_CHIPS);
    watchVideo();
    watchForLectureChange();
    await openLecture(state.lectureId);
  }

  /** (Re)initialise everything for one lecture. Also used if the URL's id changes. */
  async function openLecture(lectureId) {
    state.lectureId = lectureId;
    state.captions = [];
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
    updatePlayback();
  }

  function onVideoEvent() {
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

  // Extract "Watch: M:SS-M:SS, description" from an Nova reply.
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
    const payload = buildAskPayload({ lectureId, currentTime, question, context });

    log(
      `/ask at ${formatTime(currentTime)} with ${context.length} caption lines` +
        (context.length ? ` (${formatTime(context[0].start)}–${formatTime(context[context.length - 1].end)})` : "")
    );
    log("/ask payload", payload);

    saveMessage({ role: "student", text: question, time: payload.current_time, at: Date.now() });
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
    const { clean, watch } = parseWatch(reply);
    const msg = { role: "nova", text: clean, watch, question, time: payload.current_time, at: Date.now() };
    if (res.stub) msg.stub = true;
    saveMessage(msg);
    overlay.addMessage(msg);
    if (chips) overlay.setChips(chips);
  }

  // Opens the whiteboard tab (explain.html) for an Nova reply.
  function explainInDepth(msg) {
    sendToBackground({
      type: "NOVA_EXPLAIN_OPEN",
      payload: {
        lecture_id: state.lectureId,
        question: msg.question || "",
        reply: msg.text,
        current_time: msg.time || 0,
      },
    });
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
  const chatKey = (id) => `nova:chat:${id}`;

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
