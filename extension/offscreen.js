/*
 * Nova: offscreen document (voice engine).
 *
 * One hidden extension page owns the microphone and the speaker, so no website
 * ever has to grant mic access and page autoplay rules don't block Nova's voice.
 *
 *   1. Wake word status. "Hey Nova" itself is heard by the lecture tab
 *      (spotter.js, Chrome speech recognition); this page only reports that.
 *   2. Capture: after the wake word (or a mic-button press), turns the question
 *      into text. Free engine (default): Chrome's built-in speech recognition.
 *      ElevenLabs engine: records until silence, POSTs to <backend>/transcribe.
 *   3. Speech (ElevenLabs engine only): streams <backend>/tts/stream audio (eleven-audio.js). The free engine
 *      speaks with chrome.tts from background.js. "Hey Nova" mid-reply stops either.
 *
 * The same file also runs in listener.html, a pinned tab that background.js opens
 * if Chrome won't run speech recognition in the hidden offscreen document.
 *
 * Offscreen documents can only use chrome.runtime, so settings arrive from
 * background.js as NOVA_OFFSCREEN_CONFIG messages, and everything we want to tell
 * the page goes back through background.js.
 */
(() => {
  "use strict";

  const cfg = globalThis.NovaConfig;
  const log = (...args) => console.log("[Nova voice]", ...args);
  const warn = (...args) => console.warn("[Nova voice]", ...args);

  const FRAME_LENGTH = 512; // mic frame at 16 kHz (32 ms), for silence detection
  const CAPTURE = {
    maxMs: 15000, // hard stop
    noSpeechMs: 6000, // give up if the student never starts talking
    silenceMs: 1300, // stop this long after the student stops talking
    minSpeechMs: 250,
  };

  const state = {
    settings: { ...cfg.DEFAULT_SETTINGS },
    stream: null,
    ctx: null,
    source: null,
    node: null,
    noiseFloor: 0.01,
    capture: null, // { recorder, chunks, startedAt, speechMs, lastVoiceAt, heardSpeech, timer }
    player: null, // NovaElevenAudio player currently speaking
    ttsToken: 0,
    ttsPending: false, // waiting for the first /tts/stream audio
    status: { wake: "off", detail: "" },
    spot: {
      // Chrome speech-recognition wake-word spotter
      wanted: false,
      running: false,
      rec: null,
      backoff: 300,
      consumed: 0, // results before this index are already handled
      length: 0, // results.length in the latest event
      mode: "wake", // "wake" | "question"
      qFrom: null, // { index, wake: bool } where the question starts
      qTimer: null,
      qSource: "wake",
      blockedErrors: 0,
    },
  };

  const IS_TAB = /listener\.html$/.test(location.pathname);

  const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});

  function setStatus(wake, detail = "") {
    if (state.status.wake === wake && state.status.detail === detail) return;
    state.status = { wake, detail };
    log("wake status:", wake, detail);
    send("NOVA_OFFSCREEN_STATUS", { status: state.status });
  }

  function voiceState(value, extra = {}) {
    send("NOVA_VOICE_STATE", { state: value, ...extra });
  }

  // ===========================================================================
  // Messages from background.js
  // ===========================================================================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== "offscreen") return;
    switch (msg.type) {
      case "NOVA_OFFSCREEN_CONFIG":
        applyConfig(msg.settings);
        sendResponse({ ok: true });
        break;
      case "NOVA_START_CAPTURE":
        stopSpeaking();
        startCapture("button").then((ok) => sendResponse({ ok }));
        return true;
      case "NOVA_CANCEL_CAPTURE":
        cancelCapture();
        sendResponse({ ok: true });
        break;
      case "NOVA_PLAY_TTS":
        speak(msg.text, msg.voiceId || state.settings.voiceId).then((res) => sendResponse(res));
        return true;
      case "NOVA_STOP_TTS":
        stopSpeaking();
        sendResponse({ ok: true });
        break;
      case "NOVA_GET_STATUS":
        sendResponse({ ok: true, status: state.status });
        break;
    }
  });

  function applyConfig(settings) {
    state.settings = { ...cfg.DEFAULT_SETTINGS, ...(settings || {}) };
    syncWakeWord();
  }

  // ===========================================================================
  // Microphone + frame pipeline
  // ===========================================================================

  let watchingPermission = false;

  /**
   * The hidden offscreen page can't show Chrome's mic prompt, and every refused
   * request there counts as a "dismissal"; after a few, Chrome auto-blocks the
   * mic for Nova. So the offscreen page only uses the mic once it's already
   * granted (from Nova's settings page), and starts by itself when it becomes
   * granted. The listener tab is visible, so it may show the prompt itself.
   */
  async function micPermission() {
    try {
      const perm = await navigator.permissions.query({ name: "microphone" });
      if (!watchingPermission) {
        watchingPermission = true;
        perm.onchange = () => {
          log("Microphone permission is now", perm.state);
          if (perm.state === "granted") syncWakeWord();
        };
      }
      return perm.state; // "granted" | "prompt" | "denied"
    } catch (_) {
      return "unknown";
    }
  }

  /** false (and a status explaining what to do) if we must not touch the mic yet. */
  async function micAllowed() {
    const perm = await micPermission();
    if (perm === "denied") {
      setStatus("mic-blocked", 'Chrome is blocking the microphone for Nova. In Nova settings click "Fix in Chrome settings" and set Microphone to Allow.');
      return false;
    }
    if (perm === "prompt" && !IS_TAB) {
      setStatus("mic-needed", 'Open Nova settings and click "Enable microphone".');
      return false;
    }
    return true;
  }

  async function ensureMic() {
    if (state.stream && state.stream.active) return true;
    if (!(await micAllowed())) return false;
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (err) {
      warn("getUserMedia failed", err.name, err.message);
      setStatus("mic-denied", "Open Nova settings and click \"Enable microphone\".");
      return false;
    }
    state.ctx = new AudioContext();
    await state.ctx.audioWorklet.addModule("audio-processor.js");
    state.source = state.ctx.createMediaStreamSource(state.stream);
    state.node = new AudioWorkletNode(state.ctx, "nova-frame-processor", {
      processorOptions: { frameLength: FRAME_LENGTH, targetRate: 16000 },
    });
    state.node.port.onmessage = (event) => onFrame(event.data);
    // A muted path to the destination keeps the worklet being pulled.
    const sink = state.ctx.createGain();
    sink.gain.value = 0;
    state.source.connect(state.node).connect(sink).connect(state.ctx.destination);
    if (state.ctx.state === "suspended") {
      await Promise.race([state.ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
    }
    if (state.ctx.state !== "running") {
      warn("AudioContext is", state.ctx.state);
      setStatus("error", `Audio engine is ${state.ctx.state}. Reload the extension; if it persists, open Nova settings once.`);
    }
    log("Microphone open, context rate", state.ctx.sampleRate);
    return true;
  }

  function releaseMicIfIdle() {
    if (state.capture || state.spot.wanted) return;
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    if (state.ctx) state.ctx.close().catch(() => {});
    state.stream = state.ctx = state.source = state.node = null;
    log("Microphone released");
  }

  function rms(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) {
      const s = frame[i] / 32768;
      sum += s * s;
    }
    return Math.sqrt(sum / frame.length);
  }

  function onFrame(frame) {
    const level = rms(frame);
    if (state.capture) {
      trackSpeech(level);
    } else {
      // Slowly follow background noise while idle.
      state.noiseFloor = state.noiseFloor * 0.98 + Math.min(level, 0.2) * 0.02;
    }
  }

  // ===========================================================================
  // Wake word
  // ===========================================================================

  function syncWakeWord() {
    // "Hey Nova" is heard by the lecture tab itself (spotter.js): Chrome's speech
    // recognition is unreliable in hidden pages like this one.
    stopSpotter();
    if (!state.settings.wakeWordEnabled) setStatus("off");
    else setStatus("page", "Nova listens on your Panopto lecture tab while it's open and visible.");
  }

  // ---- Chrome speech-recognition wake word ----------------------------------

  // What Chrome tends to hear for "Hey Nova".
  const WAKE_RE = /\b(?:hey|hi|hay|heh|ok|okay|yo|yoh|you|yeah)[\s,.!-]*(?:nova|novah|nover|nava|innova|noah)\b[\s,.!?-]*/i;
  // Chrome may rewrite "hey nova" ("hangover") or split it ("hey" + "Nova"): strip
  // leftover wake words from the question, never wake on them (same as spotter.js).
  const WAKE_WORDS = new Set(
    "hey hi hay heh ok okay yo yoh you yeah nova novah nover nava innova noah hangover hang hand and over a no va vah nov nove novo nora heynova hennova".split(" ")
  );
  const QUESTION_WAIT_MS = 10000; // after "Hey Nova" with nothing else, wait this long for the question

  function stripWake(t) {
    const m = WAKE_RE.exec(t);
    if (m) return t.slice(m.index + m[0].length);
    return t.trim().split(/\s+/).length <= 2 ? "" : t;
  }

  function stripLeadingWake(text) {
    const words = text.split(" ");
    let k = 0;
    while (k < words.length && k < 4 && WAKE_WORDS.has(words[k].toLowerCase().replace(/[^a-z]/g, ""))) k++;
    return words.slice(k).join(" ");
  }

  function startSpotter() {
    const spot = state.spot;
    spot.wanted = true;
    if (spot.running || spot.rec) return;
    const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
    if (!SR) {
      setStatus("error", "This Chrome has no built-in speech recognition.");
      return;
    }
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = state.settings.language || navigator.language || "en-US";
    spot.rec = rec;
    spot.consumed = 0;
    spot.length = 0;
    rec.onstart = () => {
      clearTimeout(spot.startTimer);
      spot.running = true;
      spot.everStarted = true;
      spot.backoff = 300;
      setStatus("listening", IS_TAB ? 'Say "Hey Nova" (Chrome speech recognition, listener tab).' : 'Say "Hey Nova" (Chrome speech recognition).');
    };
    rec.onresult = (event) => {
      spot.blockedErrors = 0;
      onSpotResult(event.results);
    };
    rec.onerror = (event) => {
      const err = event.error;
      if (err === "no-speech" || err === "aborted") return; // normal; onend restarts
      warn("spotter error", err, event.message || "");
      if (err === "not-allowed" || err === "service-not-allowed" || err === "audio-capture") {
        spot.blockedErrors++;
        if (!IS_TAB && spot.blockedErrors >= 2) {
          // Chrome won't run recognition in a hidden document: ask background for a listener tab.
          spot.wanted = false;
          setStatus("recognition-blocked", "Chrome blocked speech recognition in the background page. Switching to a pinned listener tab…");
        } else if (IS_TAB && err !== "audio-capture") {
          spot.wanted = false;
          setStatus("mic-denied", "Allow the microphone for this tab (click the mic icon in the address bar), then reload it.");
        }
      } else if (err === "network") {
        spot.backoff = Math.min(spot.backoff * 2, 15000);
        setStatus("error", "Speech recognition needs internet. Retrying…");
      }
    };
    rec.onend = () => {
      spot.running = false;
      spot.rec = null;
      if (spot.mode === "question") {
        // Session ended mid-question: keep waiting for it in the next session.
        spot.qFrom = { index: 0, wake: false };
      }
      spot.consumed = 0;
      spot.length = 0;
      if (spot.wanted) setTimeout(() => spot.wanted && startSpotter(), spot.backoff);
    };
    rec.onaudiostart = () => log("Speech recognition is hearing the mic");
    if (!spot.everStarted) setStatus("starting", "Starting Chrome speech recognition…");
    try {
      rec.start();
    } catch (err) {
      spot.rec = null;
      warn("spotter start failed", err);
      setStatus("error", `Speech recognition failed to start: ${err.message || err}`);
      setTimeout(() => spot.wanted && startSpotter(), 1000);
      return;
    }
    // Chrome sometimes never starts recognition in a hidden page, and reports no
    // error either. Don't wait forever: fall back to the visible listener tab.
    clearTimeout(spot.startTimer);
    spot.startTimer = setTimeout(() => {
      if (spot.running || spot.rec !== rec) return;
      warn("Speech recognition never started (no onstart after 5s)");
      if (!IS_TAB) {
        spot.wanted = false;
        rec.abort();
        setStatus("recognition-blocked", "Chrome didn't start speech recognition in the background page. Switching to a pinned listener tab…");
      } else {
        setStatus("error", "Chrome didn't start speech recognition in this tab. Check that the microphone is allowed here, then reload the tab.");
      }
    }, 5000);
  }

  function stopSpotter() {
    const spot = state.spot;
    spot.wanted = false;
    clearTimeout(spot.startTimer);
    endQuestion();
    if (spot.rec) spot.rec.abort();
  }

  function onSpotResult(results) {
    const spot = state.spot;
    spot.length = results.length;
    if (spot.mode === "wake") {
      for (let i = spot.consumed; i < results.length; i++) {
        if (WAKE_RE.test(results[i][0].transcript)) {
          log("Wake phrase heard:", results[i][0].transcript.trim());
          stopSpeaking(); // barge-in
          chime();
          send("NOVA_WAKE");
          beginQuestion({ index: i, wake: true }, "wake");
          break;
        }
        if (results[i].isFinal) spot.consumed = i + 1; // ordinary speech, not for us
      }
      if (spot.mode !== "question") return;
    }

    // Question mode: everything after the wake phrase.
    let text = "";
    let allFinal = true;
    for (let i = spot.qFrom.index; i < results.length; i++) {
      let t = results[i][0].transcript;
      if (i === spot.qFrom.index && spot.qFrom.wake) t = stripWake(t);
      text += " " + t;
      if (!results[i].isFinal) allFinal = false;
    }
    text = text.replace(/\s+/g, " ").trim();
    if (spot.qFrom.wake) text = stripLeadingWake(text);
    if (text) send("NOVA_INTERIM", { text });
    if (allFinal && text) {
      // Chrome finalizes a result after a short pause: that's the end of the question.
      spot.consumed = results.length;
      endQuestion();
      voiceState("idle");
      log("Transcript:", text);
      send("NOVA_TRANSCRIPT", { text, reason: "ok" });
    }
  }

  function beginQuestion(from, source) {
    const spot = state.spot;
    spot.mode = "question";
    spot.qFrom = from;
    spot.qSource = source;
    clearTimeout(spot.qTimer);
    spot.qTimer = setTimeout(() => {
      // Nothing asked: go back to waiting for "Hey Nova".
      if (spot.mode !== "question") return;
      spot.consumed = spot.length;
      endQuestion();
      voiceState("idle");
      send("NOVA_TRANSCRIPT", { text: "", reason: "no-speech" });
    }, QUESTION_WAIT_MS);
    voiceState("listening", { source });
  }

  function endQuestion() {
    const spot = state.spot;
    clearTimeout(spot.qTimer);
    spot.mode = "wake";
    spot.qFrom = null;
  }

  let chimeCtx = null;

  function chime() {
    let ctx = state.ctx;
    if (!ctx) {
      try {
        chimeCtx = chimeCtx || new AudioContext();
        if (chimeCtx.state === "suspended") chimeCtx.resume().catch(() => {});
        ctx = chimeCtx;
      } catch (_) {
        return;
      }
    }
    const t = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    for (const [freq, at] of [
      [880, 0],
      [1320, 0.09],
    ]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(t + at);
      osc.stop(t + 0.3);
    }
  }

  // ===========================================================================
  // Capture one question
  // ===========================================================================

  function pickMime() {
    for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return "";
  }

  async function startCapture(source) {
    if (state.capture) return true;
    if (state.spot.wanted && (state.spot.running || state.spot.rec)) {
      // The spotter already owns speech recognition (Chrome allows one session): use it.
      if (state.spot.mode !== "question") beginQuestion({ index: state.spot.length, wake: false }, source);
      return true;
    }
    if (!(await ensureMic())) {
      voiceState("error", { error: "mic-denied" });
      return false;
    }
    if (state.settings.voiceEngine !== "elevenlabs") return startRecognition(source);
    const mimeType = pickMime();
    const recorder = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
    const now = performance.now();
    const cap = {
      source,
      recorder,
      chunks: [],
      startedAt: now,
      lastVoiceAt: now,
      speechMs: 0,
      heardSpeech: false,
      cancelled: false,
      threshold: Math.max(0.02, state.noiseFloor * 3),
    };
    state.capture = cap;
    recorder.ondataavailable = (e) => e.data && e.data.size && cap.chunks.push(e.data);
    recorder.onstop = () => finishCapture(cap);
    recorder.start(250);
    cap.timer = setTimeout(() => stopCapture(cap), CAPTURE.maxMs);
    voiceState("listening", { source });
    log(`Capturing (${source}), threshold ${cap.threshold.toFixed(3)}`);
    return true;
  }

  // ---- Free engine: Chrome's built-in speech recognition -------------------

  const RECOGNITION_ERRORS = {
    "not-allowed": "Chrome blocked speech recognition. Open Nova settings and click \"Enable microphone\".",
    "service-not-allowed": "Chrome's speech service isn't available here. Try the ElevenLabs engine in Nova settings.",
    network: "Speech recognition needs an internet connection.",
    "audio-capture": "No microphone found.",
    "language-not-supported": "That language isn't supported for speech recognition.",
  };

  function startRecognition(source) {
    const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
    if (!SR) {
      send("NOVA_TRANSCRIPT", { text: "", reason: "error", error: "This Chrome has no built-in speech recognition." });
      return false;
    }
    const rec = new SR();
    rec.lang = state.settings.language || navigator.language || "en-US";
    rec.interimResults = true; // live words in the overlay while the student talks
    rec.continuous = false; // Chrome ends the session when the student pauses
    rec.maxAlternatives = 1;
    const cap = { kind: "web", source, rec, final: "", interim: "", error: null, cancelled: false };
    state.capture = cap;
    rec.onresult = (event) => {
      let fin = "";
      let interim = "";
      for (let i = 0; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) fin += r[0].transcript;
        else interim += r[0].transcript;
      }
      cap.final = fin;
      cap.interim = interim;
      send("NOVA_INTERIM", { text: (fin + interim).trim() });
    };
    rec.onerror = (event) => {
      cap.error = event.error;
      if (event.error !== "no-speech" && event.error !== "aborted") warn("recognition error", event.error, event.message);
    };
    rec.onend = () => finishRecognition(cap);
    try {
      rec.start();
    } catch (err) {
      state.capture = null;
      send("NOVA_TRANSCRIPT", { text: "", reason: "error", error: String(err.message || err) });
      return false;
    }
    cap.timer = setTimeout(() => rec.stop(), CAPTURE.maxMs);
    voiceState("listening", { source });
    log(`Listening with Chrome speech recognition (${rec.lang}, ${source})`);
    return true;
  }

  function finishRecognition(cap) {
    clearTimeout(cap.timer);
    if (state.capture === cap) state.capture = null;
    voiceState("idle");
    releaseMicIfIdle();
    if (cap.cancelled) return;
    const text = (cap.final || cap.interim).trim();
    if (text) {
      log("Transcript:", text);
      send("NOVA_TRANSCRIPT", { text, reason: "ok" });
    } else if (cap.error && cap.error !== "no-speech" && cap.error !== "aborted") {
      send("NOVA_TRANSCRIPT", { text: "", reason: "error", error: RECOGNITION_ERRORS[cap.error] || `Speech recognition error: ${cap.error}` });
    } else {
      log("No speech heard");
      send("NOVA_TRANSCRIPT", { text: "", reason: "no-speech" });
    }
  }

  // ---- ElevenLabs engine: record, detect silence, upload --------------------

  function trackSpeech(level) {
    const cap = state.capture;
    if (!cap || cap.kind === "web" || cap.recorder.state !== "recording") return;
    const now = performance.now();
    if (level > cap.threshold) {
      cap.speechMs += 32;
      cap.lastVoiceAt = now;
      if (cap.speechMs >= CAPTURE.minSpeechMs) cap.heardSpeech = true;
    }
    if (cap.heardSpeech && now - cap.lastVoiceAt > CAPTURE.silenceMs) stopCapture(cap);
    else if (!cap.heardSpeech && now - cap.startedAt > CAPTURE.noSpeechMs) stopCapture(cap);
  }

  function stopCapture(cap) {
    clearTimeout(cap.timer);
    if (cap.recorder.state !== "inactive") cap.recorder.stop();
  }

  function cancelCapture() {
    if (state.spot.mode === "question") {
      state.spot.consumed = state.spot.length;
      endQuestion();
      voiceState("idle");
      return;
    }
    const cap = state.capture;
    if (!cap) return;
    cap.cancelled = true;
    if (cap.kind === "web") cap.rec.abort();
    else stopCapture(cap);
  }

  async function finishCapture(cap) {
    if (state.capture === cap) state.capture = null;
    if (cap.cancelled) {
      voiceState("idle");
      return releaseMicIfIdle();
    }
    if (!cap.heardSpeech) {
      log("No speech heard");
      voiceState("idle");
      send("NOVA_TRANSCRIPT", { text: "", reason: "no-speech" });
      return releaseMicIfIdle();
    }
    voiceState("transcribing");
    const blob = new Blob(cap.chunks, { type: cap.recorder.mimeType || "audio/webm" });
    releaseMicIfIdle();
    try {
      const res = await fetch(backend("/transcribe"), {
        method: "POST",
        headers: { "Content-Type": blob.type.split(";")[0] },
        body: blob,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const text = String(data.text || "").trim();
      log("Transcript:", text);
      voiceState("idle");
      send("NOVA_TRANSCRIPT", { text, reason: text ? "ok" : "empty" });
    } catch (err) {
      warn("transcribe failed", err);
      voiceState("idle");
      send("NOVA_ELEVEN_FAILED"); // background switches to Chrome speech recognition for a while
      send("NOVA_TRANSCRIPT", {
        text: "",
        reason: "error",
        error: "ElevenLabs couldn't transcribe that, so Nova switched to Chrome's speech recognition. Please ask again.",
      });
    }
  }

  // ===========================================================================
  // Speech
  // ===========================================================================

  function backend(path) {
    return cfg.BACKEND_URL.replace(/\/+$/, "") + path;
  }

  /**
   * Speak an English answer through ElevenLabs, streamed so it starts with the first audio chunk.
   * Resolves once playback starts (or fails), so background.js can fall back to Chrome's voice.
   */
  async function speak(text, voiceId) {
    stopSpeaking();
    const clean = String(text || "").trim();
    if (!clean) return { ok: false, error: "empty" };
    const token = ++state.ttsToken;
    state.ttsPending = true;
    voiceState("speaking", { loading: true });
    const player = globalThis.NovaElevenAudio.play({
      url: backend("/tts/stream"),
      body: { text: clean, voice_id: voiceId || "", language_code: "en" }, // ElevenLabs is English only
    });
    state.player = player;
    const res = await player.started;
    if (token !== state.ttsToken) return { ok: false, error: "superseded" };
    state.ttsPending = false;
    if (!res.ok) {
      warn("tts failed", res.error);
      state.player = null;
      voiceState("idle"); // background.js falls back to Chrome's voice
      return res;
    }
    voiceState("speaking");
    player.done.then(() => {
      if (state.player === player) {
        state.player = null;
        voiceState("idle");
      }
    });
    return { ok: true };
  }

  function stopSpeaking() {
    const wasSpeaking = Boolean(state.player) || state.ttsPending;
    state.ttsPending = false;
    state.ttsToken++;
    if (state.player) state.player.stop();
    state.player = null;
    if (wasSpeaking) voiceState("idle");
  }

  // Report in right away, then ask background for settings.
  setStatus("starting", "Voice engine loaded. Waiting for settings…");
  send("NOVA_OFFSCREEN_READY");
})();
