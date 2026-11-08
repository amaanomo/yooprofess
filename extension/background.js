/*
 * Nova: background service worker.
 *
 *  - Toolbar button: shows/hides Nova on the current Panopto lecture tab.
 *  - Talks to the backend for the content scripts. Requests from the service
 *    worker aren't subject to the page's CORS rules.
 *  - Voice router: keeps the offscreen document (offscreen.js: mic, wake word,
 *    speech) alive and passes messages between it and the tab Nova is talking in.
 *
 * Request/response shapes are built in content.js.
 */

importScripts("config.js", "srt.js"); // NovaConfig; NovaSRT.formatTime for stub replies

const cfg = self.NovaConfig;

/**
 * true: don't call the backend. /lectures is skipped and /ask gets a canned
 * reply, so the UI can be demoed without a server. Voice still needs the server.
 */
const STUB_MODE = false;

const TIMEOUT_MS = { lectures: 20000, ask: 45000, explain: 60000, translate: 60000, summary: 90000, topics: 45000 };

const log = (...args) => console.log("[Nova]", ...args);

// ============================================================================
// Settings
// ============================================================================

async function getSettings() {
  const stored = (await chrome.storage.sync.get(cfg.SETTINGS_KEY))[cfg.SETTINGS_KEY];
  return { ...cfg.DEFAULT_SETTINGS, ...(stored || {}) };
}

async function getAccessKey() {
  return (await chrome.storage.local.get(cfg.PICOVOICE_KEY))[cfg.PICOVOICE_KEY] || "";
}

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === "sync" && changes[cfg.SETTINGS_KEY]) || (area === "local" && changes[cfg.PICOVOICE_KEY])) {
    pushOffscreenConfig();
  }
});

// ============================================================================
// Offscreen document (mic + speaker)
// ============================================================================

const OFFSCREEN_URL = "offscreen.html";
let creatingOffscreen = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
        justification: 'Listen for the "Hey Nova" wake word and speak Nova\'s answers.',
      })
      .catch((err) => {
        if (!/single offscreen/i.test(String(err && err.message))) log("createDocument failed", err.message);
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

// ---- Fallback: a pinned "listener" tab -------------------------------------
// Chrome may refuse speech recognition in a hidden offscreen document. If the
// offscreen doc reports that, the same voice engine runs in listener.html instead.

const LISTENER_URL = "listener.html";
const LISTENER_MODE_KEY = "nova:listenerMode"; // "offscreen" (default) | "tab"

async function getListenerMode() {
  return (await chrome.storage.local.get(LISTENER_MODE_KEY))[LISTENER_MODE_KEY] || "offscreen";
}

async function findListenerTab() {
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL(LISTENER_URL) });
  return tabs[0] || null;
}

let creatingListener = null;

/** Make sure the voice engine is running: offscreen doc, or the pinned listener tab. */
async function ensureVoiceHost() {
  if ((await getListenerMode()) !== "tab") return ensureOffscreen();
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
  if (await findListenerTab()) return;
  if (!creatingListener) {
    creatingListener = chrome.tabs
      .create({ url: LISTENER_URL, pinned: true, active: true }) // must be visible once so Chrome can ask for the mic
      .then((tab) => new Promise((resolve) => {
        // Wait for it to load so the next message reaches it.
        const done = (id, info) => {
          if (id === tab.id && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(done);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(done);
        setTimeout(resolve, 3000);
      }))
      .finally(() => {
        creatingListener = null;
      });
  }
  await creatingListener;
}

/** The mic can only be granted from a visible page: show Nova's settings (once per browser session). */
async function openSettingsOnce() {
  if (await sessionGet("openedSettingsForMic")) return;
  await sessionSet("openedSettingsForMic", true);
  const open = await chrome.tabs.query({ url: chrome.runtime.getURL("options.html") });
  if (open.length) chrome.tabs.update(open[0].id, { active: true });
  else chrome.runtime.openOptionsPage();
}

async function switchToListenerTab() {
  if ((await getListenerMode()) === "tab") return;
  log("Speech recognition blocked in the offscreen doc; switching to a listener tab");
  await chrome.storage.local.set({ [LISTENER_MODE_KEY]: "tab" });
  await pushOffscreenConfig();
}

async function toOffscreen(message) {
  await ensureVoiceHost();
  try {
    return await chrome.runtime.sendMessage({ ...message, target: "offscreen" });
  } catch (err) {
    log("offscreen unreachable", message.type, err.message);
    return { ok: false, error: "offscreen-unreachable" };
  }
}

async function pushOffscreenConfig() {
  const [settings, accessKey] = await Promise.all([getSettings(), getAccessKey()]);
  return toOffscreen({ type: "NOVA_OFFSCREEN_CONFIG", settings, accessKey });
}

chrome.runtime.onStartup.addListener(() => pushOffscreenConfig());
chrome.runtime.onInstalled.addListener(async (details) => {
  // Retry the hidden voice page after every install/reload; fall back to the tab again only if needed.
  await chrome.storage.local.remove("nova:listenerMode");
  pushOffscreenConfig();
  chrome.alarms.create("nova-keepalive", { periodInMinutes: 1 });
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});

// If Chrome ever closes the offscreen doc, bring it back so "Hey Nova" keeps working.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "nova-keepalive") return;
  const tabMode = (await getListenerMode()) === "tab";
  if (tabMode && !(await getSettings()).wakeWordEnabled) return; // don't reopen a tab the user closed for nothing
  if (tabMode ? !(await findListenerTab()) : !(await hasOffscreen())) pushOffscreenConfig();
});

// ============================================================================
// Speaking: free engine = chrome.tts here; ElevenLabs engine = offscreen audio
// ============================================================================

function speakWithChrome(text, settings, onState) {
  chrome.tts.stop();
  const options = {
    rate: Number(settings.voiceRate) || 1,
    enqueue: false,
    onEvent: (event) => {
      if (event.type === "start") onState("speaking");
      else if (["end", "interrupted", "cancelled", "error"].includes(event.type)) onState("idle");
      if (event.type === "error") log("tts error", event.errorMessage);
    },
  };
  if (settings.voiceName) options.voiceName = settings.voiceName;
  onState("speaking"); // show "Speaking…" right away; "start" confirms it
  chrome.tts.speak(text, options, () => {
    if (chrome.runtime.lastError) {
      log("tts failed", chrome.runtime.lastError.message);
      onState("idle");
    }
  });
  return { ok: true };
}

async function speak(text, overrides = {}) {
  const settings = { ...(await getSettings()), ...overrides };
  const clean = String(text || "").trim();
  if (!clean) return { ok: false, error: "empty" };
  if (settings.voiceEngine === "elevenlabs") {
    chrome.tts.stop();
    return toOffscreen({ type: "NOVA_PLAY_TTS", text: clean, voiceId: settings.voiceId });
  }
  return speakWithChrome(clean, settings, (state) => forwardToVoiceTarget({ type: "NOVA_VOICE_STATE", state }));
}

function stopSpeaking() {
  chrome.tts.stop();
  return toOffscreen({ type: "NOVA_STOP_TTS" });
}

// ============================================================================
// Which tab/frame Nova lives in
// ============================================================================

/** session storage survives service-worker restarts (but not browser restarts). */
async function sessionGet(key) {
  return (await chrome.storage.session.get(key))[key];
}
async function sessionSet(key, value) {
  await chrome.storage.session.set({ [key]: value });
}

async function lectureFrames() {
  return (await sessionGet("lectureFrames")) || {};
}

async function registerLectureFrame(tabId, frameId) {
  const frames = await lectureFrames();
  frames[tabId] = frameId;
  await sessionSet("lectureFrames", frames);
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const frames = await lectureFrames();
  if (tabId in frames) {
    delete frames[tabId];
    await sessionSet("lectureFrames", frames);
  }
});

async function sendToFrame({ tabId, frameId }, message) {
  return chrome.tabs.sendMessage(tabId, message, { frameId });
}

const PANOPTO_LECTURE_URL = /^https:\/\/[^/]*\.panopto\.com\/Panopto\/Pages\/(Viewer|Embed)\.aspx/i;

/** The lecture frame on this tab, or null if the tab has no Panopto lecture. */
async function lectureTarget(tab) {
  if (!tab || tab.id == null) return null;
  const frames = await lectureFrames();
  if (tab.id in frames) return { tabId: tab.id, frameId: frames[tab.id] }; // includes Canvas embeds
  if (PANOPTO_LECTURE_URL.test(tab.url || "")) return { tabId: tab.id, frameId: 0 };
  return null;
}

/**
 * Send a message to Nova on a Panopto lecture tab. If the tab was open before the
 * extension was installed/reloaded, its copy of Nova is disconnected, so inject a
 * fresh one and retry. Other tabs are ignored: Nova only runs on lectures.
 */
async function deliver(tab, message) {
  const target = await lectureTarget(tab);
  if (!target) {
    log("No Panopto lecture on this tab:", tab && tab.url);
    return null;
  }
  try {
    return { target, res: await sendToFrame(target, message) };
  } catch (_) {
    /* no live content script there */
  }
  try {
    const frames = await lectureFrames();
    delete frames[tab.id];
    await sessionSet("lectureFrames", frames);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["srt.js", "commands.js", "overlay.js", "spotter.js", "voice-client.js", "content.js"],
    });
    await new Promise((r) => setTimeout(r, 300)); // let the lecture frame register
    const fresh = await lectureTarget(tab);
    return fresh ? { target: fresh, res: await sendToFrame(fresh, message) } : null;
  } catch (err) {
    log("Couldn't reach Nova on this lecture tab (reload the tab)", err.message);
    return null;
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

// ============================================================================
// Toolbar button
// ============================================================================

chrome.action.onClicked.addListener(async (tab) => {
  const out = await deliver(tab, { type: "NOVA_TOGGLE" });
  log("Toggled overlay", out && out.res);
});

// ============================================================================
// Voice routing
// ============================================================================

/**
 * Routing "Hey Nova" to the current tab takes a moment (the overlay may need to
 * mount, or Nova may need injecting into a tab that predates the extension).
 * The question can be transcribed during that time, so anything meant for the
 * voice target waits on this promise; otherwise it would go to the previous tab.
 */
let wakeRouting = Promise.resolve();

function onWake() {
  chrome.tts.stop(); // barge-in: "Hey Nova" interrupts the free voice too
  const routing = (async () => {
    const tab = await activeTab();
    // Point at the new tab right away, before the (slower) delivery.
    const target = await lectureTarget(tab);
    if (target) await sessionSet("voiceTarget", target);
    const out = await deliver(tab, { type: "NOVA_WAKE" });
    if (out) {
      await sessionSet("voiceTarget", out.target);
    } else {
      // Nowhere to show Nova: don't leave the mic recording for nothing.
      await sessionSet("voiceTarget", null);
      toOffscreen({ type: "NOVA_CANCEL_CAPTURE" });
    }
  })().catch((err) => log("wake routing failed", err.message));
  wakeRouting = routing;
  return routing;
}

async function forwardToVoiceTarget(message) {
  await wakeRouting; // a "Hey Nova" on a new tab may still be switching the target
  const target = await sessionGet("voiceTarget");
  if (!target) return;
  try {
    await sendToFrame(target, message);
  } catch (err) {
    log("voice target gone", err.message);
  }
}

// ============================================================================
// Messages
// ============================================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== "string") return;
  if (msg.target === "offscreen") return; // addressed to the offscreen doc, not us

  const fromTab = sender.tab && sender.tab.id != null ? { tabId: sender.tab.id, frameId: sender.frameId || 0 } : null;
  const reply = (promise) => {
    Promise.resolve(promise).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err && err.message) }));
    return true; // keep the channel open for the async response
  };

  switch (msg.type) {
    // ---- content scripts -> backend
    case "NOVA_UPLOAD_LECTURE":
      return reply(uploadLecture(msg.payload));
    case "NOVA_ASK":
      return reply(askBackend(msg.payload));
    case "NOVA_TRANSLATE":
      return reply(translateBackend(msg.payload));
    case "NOVA_SUMMARY":
      return reply(summaryBackend(msg.payload));
    case "NOVA_EXPLAIN_OPEN": {
      // Hand the context to the whiteboard tab through storage, then open it.
      const key = "nova:explain:" + Date.now();
      return reply(
        chrome.storage.local
          .set({ [key]: msg.payload })
          .then(() => chrome.tabs.create({ url: chrome.runtime.getURL("explain.html") + "?k=" + encodeURIComponent(key) }))
          .then(() => ({ ok: true }))
      );
    }
    case "NOVA_EXPLAIN_PLAN":
      return reply(postJSON("/explain", msg.payload, TIMEOUT_MS.explain));

    // ---- content scripts -> voice
    case "NOVA_REGISTER_LECTURE_FRAME":
      if (fromTab) return reply(registerLectureFrame(fromTab.tabId, fromTab.frameId).then(() => ({ ok: true })));
      return;
    case "NOVA_LISTEN":
      return reply(
        (async () => {
          if (fromTab) await sessionSet("voiceTarget", fromTab);
          chrome.tts.stop();
          return toOffscreen({ type: "NOVA_START_CAPTURE" });
        })()
      );
    case "NOVA_CANCEL_LISTEN":
      return reply(toOffscreen({ type: "NOVA_CANCEL_CAPTURE" }));
    case "NOVA_SPEAK":
      return reply(
        (async () => {
          if (fromTab) await sessionSet("voiceTarget", fromTab);
          return speak(msg.text);
        })()
      );
    case "NOVA_STOP_SPEAKING":
      return reply(stopSpeaking());

    // ---- options page
    case "NOVA_GET_STATUS":
      return reply(
        (async () => {
          await pushOffscreenConfig();
          return (await sessionGet("wakeStatus")) || { wake: "unknown" };
        })()
      );
    case "NOVA_PEEK_STATUS": // read-only, for polling
      return reply(sessionGet("wakeStatus").then((s) => s || { wake: "unknown" }));
    case "NOVA_PREVIEW_VOICE": {
      // Preview what's selected on the settings page, even before it's saved.
      const overrides = {};
      for (const k of ["voiceEngine", "voiceName", "voiceRate", "voiceId"]) if (msg[k] !== undefined) overrides[k] = msg[k];
      if ((overrides.voiceEngine || "") !== "elevenlabs") {
        // No tab is listening for state here; just speak.
        return reply(getSettings().then((s) => speakWithChrome(String(msg.text || ""), { ...s, ...overrides }, () => {})));
      }
      return reply(speak(msg.text, overrides));
    }
    case "NOVA_GET_VOICES":
      return reply(getJSON("/voices", 15000));

    // ---- offscreen document
    case "NOVA_PAGE_STATUS": // the lecture tab's "Hey Nova" listener
      sessionSet("wakeStatus", msg.status);
      return;
    case "NOVA_OFFSCREEN_READY":
      pushOffscreenConfig();
      return;
    case "NOVA_OFFSCREEN_STATUS":
      sessionSet("wakeStatus", msg.status);
      if (msg.status && msg.status.wake === "recognition-blocked") switchToListenerTab();
      if (msg.status && (msg.status.wake === "mic-needed" || msg.status.wake === "mic-blocked")) openSettingsOnce();
      return;
    case "NOVA_WAKE":
      onWake();
      return;
    case "NOVA_VOICE_STATE":
      forwardToVoiceTarget({ type: "NOVA_VOICE_STATE", state: msg.state, source: msg.source, error: msg.error, loading: msg.loading });
      return;
    case "NOVA_INTERIM":
      forwardToVoiceTarget({ type: "NOVA_INTERIM", text: msg.text });
      return;
    case "NOVA_TRANSCRIPT":
      forwardToVoiceTarget({ type: "NOVA_TRANSCRIPT", text: msg.text, reason: msg.reason, error: msg.error });
      return;
  }
  if (msg.type === "NOVA_TOPICS") {
    topicsBackend(msg.payload).then(sendResponse);
    return true;
  }
});

// ============================================================================
// Backend
// ============================================================================

async function uploadLecture(payload) {
  const count = payload && Array.isArray(payload.captions) ? payload.captions.length : 0;
  if (STUB_MODE) {
    log(`STUB_MODE: skipping POST /lectures for ${payload.lecture_id} (${count} captions)`);
    return { ok: true, stub: true, data: null };
  }
  log(`POST /lectures ${payload.lecture_id} (${count} captions)`);
  return postJSON("/lectures", payload, TIMEOUT_MS.lectures);
}

async function askBackend(payload) {
  log("POST /ask", payload);
  if (STUB_MODE) {
    await new Promise((resolve) => setTimeout(resolve, 900)); // let the typing indicator show
    return { ok: true, stub: true, data: stubAskReply(payload) };
  }
  return postJSON("/ask", payload, TIMEOUT_MS.ask);
}

async function summaryBackend(payload) {
  const count = Array.isArray(payload.captions) ? payload.captions.length : 0;
  log(`POST /summary ${payload.lecture_id} (${count} captions${payload.language ? ", " + payload.language : ""})`);
  if (STUB_MODE) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    const first = (payload.captions && payload.captions[0] && payload.captions[0].start) || 0;
    return {
      ok: true,
      stub: true,
      data: {
        summary: "This is a demo summary (stub mode). Turn STUB_MODE off to get a real one.",
        key_points: ["Real summaries cover the main ideas of the lecture."],
        chapters: [{ start: first, title: "Start of lecture" }],
      },
    };
  }
  return postJSON("/summary", payload, TIMEOUT_MS.summary);
}

async function topicsBackend(payload) {
  if (STUB_MODE) {
    // Sample themes so the Hot topics view can be demoed offline.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const now = Date.now() / 1000;
    return {
      ok: true,
      stub: true,
      data: {
        status: "ok",
        total_questions: 12,
        updated_at: now - 120,
        topics: [
          { title: "Few-shot vs fine-tuning", summary: "Students mix up giving examples in the prompt with retraining the model.", count: 6, time: 750, examples: ["Is few-shot prompting a kind of training?", "When would you fine-tune instead of adding examples?"] },
          { title: "Why run a local model", summary: "Unclear what you gain from running the model on your own machine.", count: 4, time: 1210, examples: ["What's the benefit of a local model over an API?"] },
          { title: "Structured output", summary: "How to make the model return fields reliably.", count: 2, time: 1585, examples: ["How do you force the answer into JSON?"] },
        ],
      },
    };
  }
  log(`POST /topics ${payload.lecture_id}${payload.refresh ? " (refresh)" : ""}`);
  return postJSON("/topics", payload, TIMEOUT_MS.topics);
}

async function translateBackend(payload) {
  const count = Array.isArray(payload.cues) ? payload.cues.length : 0;
  if (STUB_MODE) {
    // Fake translation so the subtitle UI can be demoed offline: "[ES] original text".
    await new Promise((resolve) => setTimeout(resolve, 600));
    const tag = `[${String(payload.target_language).split("-")[0].toUpperCase()}] `;
    return { ok: true, stub: true, data: { translations: payload.cues.map((c) => ({ i: c.i, text: tag + c.text })) } };
  }
  log(`POST /translate ${payload.lecture_id} -> ${payload.target_language} (${count} cues)`);
  return postJSON("/translate", payload, TIMEOUT_MS.translate);
}

function postJSON(path, body, timeoutMs) {
  return request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, timeoutMs);
}

function getJSON(path, timeoutMs) {
  return request(path, { method: "GET" }, timeoutMs);
}

/**
 * @returns {Promise<{ok: true, status, data} | {ok: false, status?, error, detail?}>}
 *   error: "http" (non-2xx), "timeout", or "unreachable" (server down, DNS, ...)
 */
async function request(path, init, timeoutMs) {
  const url = cfg.BACKEND_URL.replace(/\/+$/, "") + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let data = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      /* keep the raw text */
    }
    if (!res.ok) {
      log(`${path} returned HTTP ${res.status}`, data);
      return { ok: false, status: res.status, error: "http", data };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    const error = err.name === "AbortError" ? "timeout" : "unreachable";
    log(`${path} failed: ${error}`, err.message);
    return { ok: false, error, detail: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// STUB_MODE replies: guide, don't answer.
// ============================================================================

function stubAskReply(payload) {
  const { formatTime } = self.NovaSRT;
  const context = Array.isArray(payload.context) ? payload.context : [];
  const now = formatTime(payload.current_time);
  const from = formatTime(context.length ? context[0].start : Math.max(0, payload.current_time - 90));
  const last = context.length ? context[context.length - 1].text : "";
  const quote = last ? ` "${last.length > 90 ? last.slice(0, 87).trimEnd() + "…" : last}"` : "";
  const q = String(payload.question || "").toLowerCase();

  let reply;
  if (/quiz|test me/.test(q)) {
    reply =
      `Let's check. Without rewinding: what was the main point the professor made just before ${now}? ` +
      `Answer in one or two sentences, and I'll point you to the part of the lecture that confirms it.`;
  } else if (/example/.test(q)) {
    reply =
      `Let's build one together. Around ${now} the professor said${quote || " something worth unpacking"}. ` +
      `Can you think of a situation where that idea would apply? Give it a try and I'll help you sharpen it.`;
  } else {
    reply =
      `Good question. Jump back to ${from} and listen up to ${now}` +
      (quote ? `, especially the part ending with${quote}` : "") +
      `. In your own words, what do you think the key idea is there? Tell me and I'll help fill in the gaps.`;
  }
  if (!context.length) reply += " (I don't have captions for this part, so I'm going by the timestamp only.)";
  return { reply, chips: null };
}
