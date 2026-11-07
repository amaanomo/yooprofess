/*
 * Orbit: background service worker.
 *
 *  - Toolbar button: tells the content script on the current tab to show/hide Orbit.
 *  - Talks to the backend for the content script. Requests from the extension's
 *    service worker aren't subject to the Panopto page's CORS rules, which is why
 *    the content script doesn't call the backend itself.
 *
 * Request/response shapes are built in content.js ("Backend contract" section).
 * This file only knows where the backend is and how to fake it (STUB_MODE).
 */

// ============================================================================
// Config
// ============================================================================

/** Person 2's server. If you change it, update "host_permissions" in manifest.json too. */
const BACKEND_URL = "http://localhost:8000";

/**
 * true: don't call the backend. /lectures is skipped and /ask gets a canned
 * guiding reply, so the UI can be demoed without a server.
 * false: send real requests to BACKEND_URL.
 */
const STUB_MODE = false;

const TIMEOUT_MS = { lectures: 20000, ask: 45000 };

importScripts("srt.js"); // for OrbitSRT.formatTime in stub replies

const log = (...args) => console.log("[Orbit]", ...args);

// ============================================================================
// Toolbar button
// ============================================================================

chrome.action.onClicked.addListener((tab) => {
  if (tab.id != null) toggleOverlay(tab.id);
});

/** Every Orbit frame on the tab gets the message; only lecture frames listen. */
async function toggleOverlay(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "ORBIT_TOGGLE" });
    log("Toggled overlay", res);
    return res;
  } catch (err) {
    log("No Panopto lecture on this tab, nothing to toggle.", err.message);
    return null;
  }
}

// ============================================================================
// Messages from the content script
// ============================================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== "string") return;

  if (msg.type === "ORBIT_UPLOAD_LECTURE") {
    uploadLecture(msg.payload).then(sendResponse);
    return true; // keep the channel open for the async response
  }
  if (msg.type === "ORBIT_ASK") {
    askBackend(msg.payload).then(sendResponse);
    return true;
  }
});

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

/**
 * @returns {Promise<{ok: true, status, data} | {ok: false, status?, error, detail?}>}
 *   error: "http" (non-2xx), "timeout", or "unreachable" (server down, DNS, ...)
 */
async function postJSON(path, body, timeoutMs) {
  const url = BACKEND_URL.replace(/\/+$/, "") + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
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
// STUB_MODE replies: guide, don't answer. They name the timestamp and ask the
// student something back, the way the real tutor is meant to.
// ============================================================================

function stubAskReply(payload) {
  const { formatTime } = self.OrbitSRT;
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
