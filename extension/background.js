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
// Hot topics demo data (themes + a question timeline) when the server has no questions yet.
// Set to false to always show real data only.
const MOCK_TOPICS = true;

const TIMEOUT_MS = { lectures: 20000, ask: 45000, explain: 60000, translate: 60000, summary: 90000, topics: 45000 };

const log = (...args) => console.log("[Nova]", ...args);

// ============================================================================
// Settings
// ============================================================================

async function getSettings() {
  const stored = (await chrome.storage.sync.get(cfg.SETTINGS_KEY))[cfg.SETTINGS_KEY];
  const migrated = cfg.migrateSettings(stored);
  if (migrated !== stored) {
    log("Settings migrated: voice engine", stored.voiceEngine, "->", migrated.voiceEngine);
    await chrome.storage.sync.set({ [cfg.SETTINGS_KEY]: migrated });
  }
  return { ...cfg.DEFAULT_SETTINGS, ...(migrated || {}) };
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes[cfg.SETTINGS_KEY]) pushOffscreenConfig();
});

// ---- Voice engine: "auto" = ElevenLabs when the server has a key, else Chrome ----

const ENGINE_KEY = "elevenStatus"; // session: { ok, at }
const ENGINE_TTL_MS = { ok: 10 * 60 * 1000, down: 2 * 60 * 1000 };

/** Does the backend have ElevenLabs? Asks /health, cached in session storage. */
async function elevenAvailable() {
  const cached = await sessionGet(ENGINE_KEY);
  if (cached && Date.now() - cached.at < (cached.ok ? ENGINE_TTL_MS.ok : ENGINE_TTL_MS.down)) return cached.ok;
  const res = await getJSON("/health", 8000);
  const ok = Boolean(res.ok && res.data && res.data.elevenlabs);
  await sessionSet(ENGINE_KEY, { ok, at: Date.now() });
  return ok;
}

/** "es-ES" / "zh-Hans" -> "es" / "zh"; empty means English. */
const baseLang = (lang) => String(lang || "en").split("-")[0].toLowerCase() || "en";

/** After an ElevenLabs failure, use Chrome's voice for a couple of minutes. */
async function markElevenDown() {
  await sessionSet(ENGINE_KEY, { ok: false, at: Date.now() });
  pushOffscreenConfig(); // the mic capture path switches too
}

/** "chrome" | "elevenlabs" for a voiceEngine setting ("auto" | "chrome" | "elevenlabs"). */
async function resolveEngine(engine) {
  if (engine === "chrome") return "chrome";
  if (engine === "elevenlabs") return "elevenlabs";
  return (await elevenAvailable()) ? "elevenlabs" : "chrome";
}

/** Settings with voiceEngine resolved to the engine actually in use. ElevenLabs only ever speaks English. */
async function getVoiceSettings(overrides = {}) {
  const settings = { ...(await getSettings()), ...overrides };
  return { ...settings, voiceEngine: await resolveEngine(settings.voiceEngine) };
}

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
  return toOffscreen({ type: "NOVA_OFFSCREEN_CONFIG", settings: await getVoiceSettings() });
}

chrome.runtime.onStartup.addListener(() => pushOffscreenConfig());
chrome.runtime.onInstalled.addListener(async (details) => {
  // Retry the hidden voice page after every install/reload; fall back to the tab again only if needed.
  // "nova:picovoiceKey": left over from the removed Picovoice wake word.
  await chrome.storage.local.remove(["nova:listenerMode", "nova:picovoiceKey"]);
  await getSettings(); // migrates old saved settings (voice engine "chrome" -> "auto")
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
// Speaking: English with ElevenLabs = streamed offscreen audio (default when the server has a key);
// other languages, the Chrome engine and the fallback = chrome.tts here
// ============================================================================

function speakWithChrome(text, settings, onState, lang = "") {
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
  const english = baseLang(lang) === "en";
  if (settings.voiceName && english) options.voiceName = settings.voiceName; // the chosen voice is for English
  if (lang && !english) options.lang = lang; // Chrome picks a voice for that language
  onState("speaking"); // show "Speaking…" right away; "start" confirms it
  chrome.tts.speak(text, options, () => {
    if (chrome.runtime.lastError) {
      log("tts failed", chrome.runtime.lastError.message);
      onState("idle");
    }
  });
  return { ok: true };
}

/** lang: BCP-47 language of the text ("es-ES"); empty = English. */
async function speak(text, overrides = {}, lang = "") {
  const settings = await getVoiceSettings(overrides);
  const clean = String(text || "").trim();
  if (!clean) return { ok: false, error: "empty" };
  const onState = (state) => forwardToVoiceTarget({ type: "NOVA_VOICE_STATE", state });
  // ElevenLabs for English; other languages (answers in the subtitle language) use Chrome's voice for that language.
  if (settings.voiceEngine === "elevenlabs" && baseLang(lang) === "en") {
    chrome.tts.stop();
    const res = await toOffscreen({ type: "NOVA_PLAY_TTS", text: clean, voiceId: settings.voiceId });
    if (res && (res.ok || res.error === "superseded")) return res;
    log("ElevenLabs voice failed, using Chrome's", res && res.error);
    await markElevenDown();
    return { ...speakWithChrome(clean, settings, onState, lang), fallback: true };
  }
  return speakWithChrome(clean, settings, onState, lang);
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
        pruneExplainContexts()
          .then(() => chrome.storage.local.set({ [key]: msg.payload }))
          .then(() => chrome.tabs.create({ url: chrome.runtime.getURL("explain.html") + "?k=" + encodeURIComponent(key) }))
          .then(() => ({ ok: true }))
      );
    }
    case "NOVA_EXPLAIN_PLAN":
      return reply(postJSON("/explain", msg.payload, TIMEOUT_MS.explain));
    case "NOVA_EXPLAIN_CODE":
      // Is there code to walk through (in the question, the answer or the video frame)?
      return reply(STUB_MODE ? Promise.resolve(stubFindCode(msg.payload)) : postJSON("/explain/code", msg.payload, TIMEOUT_MS.explain));

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
          return speak(msg.text, {}, msg.lang || "");
        })()
      );
    case "NOVA_STOP_SPEAKING":
      return reply(stopSpeaking());
    case "NOVA_GET_VOICE_ENGINE": // whiteboard: which voice to use for English lessons
      return reply(
        getVoiceSettings().then((s) => ({
          ok: true,
          engine: s.voiceEngine,
          voiceId: s.voiceId || "",
          backendUrl: cfg.BACKEND_URL,
        }))
      );
    case "NOVA_ELEVEN_FAILED": // a page's ElevenLabs playback failed: Chrome voices for a while
      return reply(markElevenDown().then(() => ({ ok: true })));

    // ---- options page
    case "NOVA_GET_STATUS":
      return reply(
        (async () => {
          await sessionSet(ENGINE_KEY, null); // the settings page re-checks the server
          await pushOffscreenConfig();
          const status = (await sessionGet("wakeStatus")) || { wake: "unknown" };
          return { ...status, elevenlabs: await elevenAvailable() };
        })()
      );
    case "NOVA_PEEK_STATUS": // read-only, for polling
      return reply(sessionGet("wakeStatus").then((s) => s || { wake: "unknown" }));
    case "NOVA_PREVIEW_VOICE": {
      // Preview what's selected on the settings page, even before it's saved.
      const overrides = {};
      for (const k of ["voiceEngine", "voiceName", "voiceRate", "voiceId"]) if (msg[k] !== undefined) overrides[k] = msg[k];
      return reply(
        getVoiceSettings(overrides).then((s) => {
          // No tab is listening for state here; just speak.
          if (s.voiceEngine !== "elevenlabs") return speakWithChrome(String(msg.text || ""), s, () => {});
          return speak(msg.text, { ...overrides, voiceEngine: "elevenlabs" });
        })
      );
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
  if (msg.type === "NOVA_INSTRUCTOR_CHECK") {
    // Try a key before saving it: the server answers 401 for a wrong key, 403 if instructor view is off.
    topicsBackend(msg.payload, msg.key).then(sendResponse);
    return true;
  }
  if (msg.type === "NOVA_OPEN_DASHBOARD") {
    openInstructorDashboard(msg.lectureId).then(sendResponse);
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

// ---- Instructor view --------------------------------------------------------------
// Hot topics is instructor-only. The key lives in chrome.storage.local (this browser only)
// and goes to the server in the X-Instructor-Key header.
const INSTRUCTOR_KEY_STORAGE = "nova:instructorKey";

async function getInstructorKey() {
  return (await chrome.storage.local.get(INSTRUCTOR_KEY_STORAGE))[INSTRUCTOR_KEY_STORAGE] || "";
}

async function openInstructorDashboard(lectureId) {
  const key = await getInstructorKey();
  // The key rides in the #fragment, which browsers never send to the server; the page removes it at once.
  // lecture= opens the dashboard on the lecture the instructor was watching.
  const hash = new URLSearchParams();
  if (key) hash.set("key", key);
  if (lectureId) hash.set("lecture", lectureId);
  const url = cfg.BACKEND_URL.replace(/\/+$/, "") + "/instructor" + (hash.toString() ? "#" + hash.toString() : "");
  await chrome.tabs.create({ url });
  return { ok: true };
}

/** Deep Dive contexts now carry a video frame; keep only the newest few so storage doesn't fill up. */
async function pruneExplainContexts(keep = 8) {
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => /^nova:explain:\d+$/.test(k)).sort();
    const old = keys.slice(0, Math.max(0, keys.length - keep));
    if (old.length) await chrome.storage.local.remove(old);
  } catch (_) {
    /* best effort */
  }
}

/** STUB_MODE: treat a question or answer with 2+ code-looking lines as code. */
function stubFindCode(p) {
  const text = [p.question, p.reply].filter(Boolean).join("\n");
  const lines = text.split("\n").filter((l) => /[=(){};:]|^\s*(import|def|class|for|if|return|print)\b/.test(l));
  return { ok: true, stub: true, data: lines.length >= 2 ? { found: true, code_language: "python", source: "question", code: lines.slice(0, 25).join("\n") } : { found: false } };
}

async function topicsBackend(payload, keyOverride) {
  const key = keyOverride != null ? keyOverride : await getInstructorKey();
  if (!key) return { ok: false, status: 401, error: "http", data: { error: "instructor key required" } };
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
  const res = await postJSON("/topics", payload, TIMEOUT_MS.topics, { "X-Instructor-Key": key });
  // Never cover up a refused key with demo data: 401/403 must reach the instructor-view UI.
  const refused = res.status === 401 || res.status === 403;
  if (MOCK_TOPICS && !refused && (!res.ok || !res.data || res.data.status === "empty")) return mockTopics();
  return res;
}

/** Demo Hot topics: a lecture with three rough patches, so the timeline has a story. */
function mockTopics() {
  const bursts = [[420, 6, 90], [1260, 9, 150], [1500, 5, 100], [2700, 14, 200], [3480, 7, 120], [4560, 4, 90]]; // [center s, count, spread s]
  const times = [];
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (const [center, count, spread] of bursts) for (let i = 0; i < count; i++) times.push(Math.max(5, Math.round(center + (rand() - 0.5) * 2 * spread)));
  times.sort((a, b) => a - b);
  return {
    ok: true,
    mock: true,
    data: {
      status: "ok",
      total_questions: times.length,
      updated_at: Date.now() / 1000 - 90,
      question_times: times,
      topics: [
        { title: "Backpropagation and the chain rule", summary: "Students can't see how the loss gradient flows back through the layers.", count: 14, time: 2700, examples: ["Why do we multiply the derivatives layer by layer?", "How does a weight in layer 1 affect the final loss?"] },
        { title: "What a weight and bias do", summary: "Unclear how w and b combine into z = w·x + b.", count: 9, time: 1260, examples: ["What's the difference between a weight and a bias?"] },
        { title: "Choosing an activation function", summary: "Why f(z) is needed and how ReLU differs from sigmoid.", count: 7, time: 3480, examples: ["Why can't the network just use z directly?"] },
        { title: "Learning rate", summary: "Confusion about step size and divergence.", count: 5, time: 1500, examples: ["What happens if the learning rate is too big?"] },
      ],
    },
  };
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

function postJSON(path, body, timeoutMs, headers = {}) {
  return request(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }, timeoutMs);
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

  if (payload.source === "quiz_answer") {
    return { reply: `Not quite. The model answer: ${payload.quiz ? payload.quiz.answer : "see the lecture"}.`, chips: ["Next question"] };
  }
  if (/quiz|test me|next question/.test(q)) {
    // Same shape as the real /ask quiz turn.
    const quiz = {
      type: "mcq",
      question: `What was the professor doing just before ${now}?`,
      options: ["Defining a new term", "Working through an example", "Reviewing last lecture", "Answering a student question"],
      answer: "B",
      explanation: "(Demo) In stub mode the answer is always B.",
      hint: "Think about what was on the board.",
    };
    const reply = [quiz.question, ...quiz.options.map((o, i) => `${"ABCD"[i]}) ${o}`)].join("\n");
    return { reply, quiz, chips: ["Hint"] };
  }
  let reply;
  if (/example/.test(q)) {
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
