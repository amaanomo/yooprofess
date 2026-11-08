/*
 * Nova: shared config. Loaded by the service worker (importScripts) and by the
 * extension pages (offscreen.html, options.html) with a <script> tag.
 */
(function (root) {
  "use strict";
  root.NovaConfig = {
    /** The backend. If you change it, update "host_permissions" in manifest.json too. */
    BACKEND_URL: "https://yooprofess-production.up.railway.app",
    // BACKEND_URL: "http://localhost:8000", // when running backend/server.py locally

    /** Settings live in chrome.storage.sync under this key. */
    SETTINGS_KEY: "nova:settings",
    DEFAULT_SETTINGS: {
      wakeWordEnabled: true,
      voiceReplies: true,
      pauseVideoOnWake: true,
      /** "chrome" = free (chrome.tts + Chrome speech recognition); "elevenlabs" = premium, needs the server key. */
      voiceEngine: "chrome",
      voiceName: "", // chrome.tts voice ("" = Chrome default)
      voiceRate: 1.05,
      voiceId: "", // ElevenLabs voice ("" = server default)
      language: "", // speech recognition language ("" = browser language)
    },
  };
})(globalThis);
