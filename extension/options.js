/*
 * Nova: settings page. Grants mic access to the extension (the offscreen doc
 * can't show a permission prompt itself), shows the wake word status, and picks
 * the voice.
 */
(() => {
  "use strict";

  const cfg = globalThis.NovaConfig;
  const $ = (id) => document.getElementById(id);

  const els = {
    micBtn: $("mic-btn"),
    micFix: $("mic-fix"),
    micHelp: $("mic-help"),
    micStatus: $("mic-status"),
    wakeEnabled: $("wake-enabled"),
    wakeStatus: $("wake-status"),
    wakeDetail: $("wake-detail"),
    voiceReplies: $("voice-replies"),
    engineSelect: $("engine-select"),
    engineHint: $("engine-hint"),
    rateField: $("rate-field"),
    rate: $("rate"),
    rateValue: $("rate-value"),
    voiceSelect: $("voice-select"),
    voicePreview: $("voice-preview"),
    voiceHint: $("voice-hint"),
    pauseVideo: $("pause-video"),
  };

  let settings = { ...cfg.DEFAULT_SETTINGS };

  function pill(el, text, kind = "ok") {
    el.textContent = text;
    el.dataset.kind = kind;
  }

  async function loadSettings() {
    const stored = (await chrome.storage.sync.get(cfg.SETTINGS_KEY))[cfg.SETTINGS_KEY];
    settings = { ...cfg.DEFAULT_SETTINGS, ...(cfg.migrateSettings(stored) || {}) };
    els.wakeEnabled.checked = settings.wakeWordEnabled;
    els.voiceReplies.checked = settings.voiceReplies;
    els.pauseVideo.checked = settings.pauseVideoOnWake;
  }

  async function saveSettings(patch) {
    settings = { ...settings, ...patch };
    await chrome.storage.sync.set({ [cfg.SETTINGS_KEY]: settings });
    setTimeout(refreshStatus, 600);
  }

  // ---- Microphone -----------------------------------------------------------

  function showMicBlocked(blocked) {
    els.micFix.hidden = !blocked;
    els.micHelp.hidden = !blocked;
  }

  async function refreshMic() {
    try {
      const perm = await navigator.permissions.query({ name: "microphone" });
      const show = () => {
        if (perm.state === "granted") pill(els.micStatus, "Allowed");
        else if (perm.state === "denied") pill(els.micStatus, "Blocked", "error");
        else pill(els.micStatus, "Not enabled yet", "warn");
        els.micBtn.hidden = perm.state === "granted";
        showMicBlocked(perm.state === "denied");
      };
      perm.onchange = () => {
        show();
        setTimeout(refreshStatus, 800); // the voice engine starts by itself once granted
      };
      show();
    } catch (_) {
      pill(els.micStatus, "Unknown", "warn");
    }
  }

  els.micBtn.addEventListener("click", async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      pill(els.micStatus, "Allowed");
      els.micBtn.hidden = true;
      showMicBlocked(false);
      setTimeout(refreshStatus, 800);
    } catch (err) {
      // "Permission dismissed" with no prompt on screen = Chrome's temporary auto-block.
      pill(els.micStatus, /dismiss/i.test(err.message) ? "Prompt dismissed or auto-blocked" : `Not allowed (${err.name})`, "error");
      showMicBlocked(true);
    }
  });

  els.micFix.addEventListener("click", () => {
    const site = encodeURIComponent(`chrome-extension://${chrome.runtime.id}/`);
    chrome.tabs.create({ url: `chrome://settings/content/siteDetails?site=${site}` });
  });

  // ---- Wake word ------------------------------------------------------------

  const WAKE_TEXT = {
    listening: ["Listening for \"Hey Nova\"", "ok"],
    page: ["Ready: listens on your lecture tab", "ok"],
    starting: ["Starting…", "warn"],
    off: ["Off", "warn"],
    "recognition-blocked": ["Switching to a listener tab…", "warn"],
    "mic-denied": ["Needs microphone access", "error"],
    "mic-needed": ["Needs microphone access", "warn"],
    "mic-blocked": ["Microphone blocked by Chrome", "error"],
    error: ["Error", "error"],
    unknown: ["Voice engine not responding", "error"],
  };

  async function refreshStatus(peek = false) {
    let status = { wake: "unknown" };
    try {
      status = (await chrome.runtime.sendMessage({ type: peek === true ? "NOVA_PEEK_STATUS" : "NOVA_GET_STATUS" })) || status;
    } catch (_) {
      /* background asleep */
    }
    const [text, kind] = WAKE_TEXT[status.wake] || [status.wake, "warn"];
    pill(els.wakeStatus, text, kind);
    els.wakeDetail.textContent =
      status.detail || (status.wake === "unknown" ? "The hidden voice page hasn't reported in. Reload Nova on chrome://extensions." : "");
  }

  // Keep the status fresh while this page is open (the engine may fall back to a tab).
  setInterval(() => refreshStatus(true), 3000);

  // Live status pushes from the offscreen doc.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "NOVA_OFFSCREEN_STATUS" && msg.status) {
      const [text, kind] = WAKE_TEXT[msg.status.wake] || [msg.status.wake, "warn"];
      pill(els.wakeStatus, text, kind);
      els.wakeDetail.textContent = msg.status.detail || "";
    }
  });

  els.wakeEnabled.addEventListener("change", () => saveSettings({ wakeWordEnabled: els.wakeEnabled.checked }));

  // ---- Voice ----------------------------------------------------------------

  const PREVIEW_TEXT = "Hi, I'm Nova. Ask me anything about your lecture, or the page you're reading.";
  let elevenVoices = null; // loaded lazily from the server

  function option(value, text) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    return opt;
  }

  /** Free voices from chrome.tts, the browser's language first, Google voices first. */
  async function chromeVoices() {
    const voices = await new Promise((resolve) => chrome.tts.getVoices(resolve));
    const lang = (navigator.language || "en").slice(0, 2).toLowerCase();
    const score = (v) => ((v.lang || "").toLowerCase().startsWith(lang) ? 0 : 2) + (/google/i.test(v.voiceName) ? 0 : 1);
    return voices.filter((v) => v.voiceName).sort((a, b) => score(a) - score(b) || a.voiceName.localeCompare(b.voiceName));
  }

  async function loadElevenVoices() {
    if (elevenVoices) return elevenVoices;
    let res = null;
    try {
      res = await chrome.runtime.sendMessage({ type: "NOVA_GET_VOICES" });
    } catch (_) {
      /* ignore */
    }
    if (res && res.ok && res.data && Array.isArray(res.data.voices)) elevenVoices = res.data.voices;
    else {
      const why = res && res.data && res.data.error ? res.data.error : "server unreachable";
      throw new Error(why);
    }
    return elevenVoices;
  }

  /** The engine actually in use: "auto" becomes ElevenLabs when the server has a key. */
  let activeEngine = "chrome";
  async function effectiveEngine() {
    const chosen = ["auto", "chrome", "elevenlabs"].includes(settings.voiceEngine) ? settings.voiceEngine : "auto";
    if (chosen !== "auto") return { chosen, engine: chosen };
    let res = null;
    try {
      res = await chrome.runtime.sendMessage({ type: "NOVA_GET_VOICE_ENGINE" });
    } catch (_) {
      /* ignore */
    }
    return { chosen, engine: res && res.engine === "elevenlabs" ? "elevenlabs" : "chrome" };
  }

  async function renderVoices() {
    const { chosen, engine } = await effectiveEngine();
    activeEngine = engine;
    els.engineSelect.value = chosen;
    els.voiceSelect.replaceChildren();
    els.rateField.hidden = engine !== "chrome";
    els.rate.value = settings.voiceRate;
    els.rateValue.textContent = `${Number(settings.voiceRate).toFixed(2)}×`;

    if (engine === "chrome") {
      els.engineHint.textContent =
        chosen === "auto"
          ? "The Nova server doesn't have ElevenLabs set up, so Nova is using Chrome's free voices and speech recognition."
          : "Free. Uses Chrome's voices and Chrome's speech recognition.";
      els.voiceSelect.append(option("", "Chrome default"));
      const voices = await chromeVoices();
      for (const v of voices) els.voiceSelect.append(option(v.voiceName, `${v.voiceName}${v.lang ? ` (${v.lang})` : ""}${v.remote ? "" : " · offline"}`));
      els.voiceSelect.value = voices.some((v) => v.voiceName === settings.voiceName) ? settings.voiceName : "";
      els.voiceHint.textContent = `${voices.length} free voices. "Google" voices sound best; "offline" ones work without internet.`;
      return;
    }

    els.engineHint.textContent =
      "ElevenLabs is Nova's English voice (answers and whiteboard lessons) and transcribes your questions. Other languages use Chrome's voices." +
      (chosen === "auto" ? " If it's unavailable, Nova switches to Chrome's voices automatically." : "");
    els.voiceSelect.append(option("", "Server default"));
    try {
      const voices = await loadElevenVoices();
      for (const v of voices) {
        const labels = v.labels ? Object.values(v.labels).filter(Boolean).join(", ") : "";
        els.voiceSelect.append(option(v.voice_id, labels ? `${v.name} (${labels})` : v.name));
      }
      els.voiceSelect.value = voices.some((v) => v.voice_id === settings.voiceId) ? settings.voiceId : "";
      els.voiceHint.textContent = `${voices.length} built-in ElevenLabs voices for English. Other languages use Chrome's voices.`;
    } catch (err) {
      els.voiceHint.textContent = `Couldn't load ElevenLabs voices (${err.message}). Set ELEVENLABS_API_KEY on the server, or use the free engine.`;
    }
  }

  els.engineSelect.addEventListener("change", async () => {
    await saveSettings({ voiceEngine: els.engineSelect.value });
    renderVoices();
  });
  els.voiceSelect.addEventListener("change", () =>
    saveSettings(activeEngine === "elevenlabs" ? { voiceId: els.voiceSelect.value } : { voiceName: els.voiceSelect.value })
  );
  els.rate.addEventListener("input", () => (els.rateValue.textContent = `${Number(els.rate.value).toFixed(2)}×`));
  els.rate.addEventListener("change", () => saveSettings({ voiceRate: Number(els.rate.value) }));
  els.voicePreview.addEventListener("click", async () => {
    els.voicePreview.disabled = true;
    try {
      const eleven = activeEngine === "elevenlabs";
      const res = await chrome.runtime.sendMessage({
        type: "NOVA_PREVIEW_VOICE",
        text: PREVIEW_TEXT,
        voiceEngine: settings.voiceEngine,
        ...(eleven ? { voiceId: els.voiceSelect.value } : { voiceName: els.voiceSelect.value, voiceRate: Number(els.rate.value) }),
      });
      if (!res || !res.ok) els.voiceHint.textContent = `Preview failed: ${(res && res.error) || "unknown error"}`;
    } finally {
      els.voicePreview.disabled = false;
    }
  });

  els.voiceReplies.addEventListener("change", () => saveSettings({ voiceReplies: els.voiceReplies.checked }));
  els.pauseVideo.addEventListener("change", () => saveSettings({ pauseVideoOnWake: els.pauseVideo.checked }));

  // ---- Start ----------------------------------------------------------------

  (async () => {
    await loadSettings();
    refreshMic();
    refreshStatus();
    renderVoices();
  })();
})();
