/*
 * Nova: voice glue for content.js (the lecture overlay).
 *
 * "Hey Nova" is heard right here in the lecture tab (spotter.js, Chrome speech
 * recognition) while the tab is visible. Nova's voice is played by background.js
 * (chrome.tts). The optional ElevenLabs engine lives in the offscreen document
 * and reaches this file as NOVA_* messages.
 *
 *   const voice = NovaVoiceClient.attach({ getOverlay, onWake, onTranscript });
 *   voice.speak(text)     // only if voice replies are on
 *   voice.listen()        // push-to-talk (mic button)
 */
(function (root) {
  "use strict";

  const SETTINGS_KEY = "nova:settings";
  // Keep in sync with NovaConfig.DEFAULT_SETTINGS (config.js isn't loaded into pages).
  const DEFAULTS = { wakeWordEnabled: true, voiceReplies: true, pauseVideoOnWake: true, voiceEngine: "chrome" };

  /** False once the extension was reloaded/updated: this copy is disconnected. */
  function alive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function send(message) {
    try {
      return chrome.runtime.sendMessage(message).catch(() => null);
    } catch (_) {
      return Promise.resolve(null); // extension reloaded
    }
  }

  /**
   * @param {object} opts
   * @param {() => object|null} opts.getOverlay  current overlay API (may be created lazily)
   * @param {() => void|Promise<void>} opts.onWake  show the overlay, pause video, ...
   * @param {(text: string) => void} opts.onTranscript  what the student said
   * @param {(info: {reason, error}) => void} [opts.onNoTranscript]
   */
  function attach(opts) {
    let settings = { ...DEFAULTS };
    let voiceState = "idle";
    let spotter = null;
    let lastNotice = "";

    const overlay = () => (opts.getOverlay ? opts.getOverlay() : null);
    const syncOverlay = () => {
      const o = overlay();
      if (!o) return;
      o.setVoiceEnabled(settings.voiceReplies);
      o.setVoiceState(voiceState);
    };

    // Start listening once settings are in (they decide the wake word and its language).
    chrome.storage.sync.get(SETTINGS_KEY).then(
      (res) => {
        settings = { ...DEFAULTS, ...(res[SETTINGS_KEY] || {}) };
        syncOverlay();
        syncSpotter();
      },
      () => syncSpotter()
    );
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync" || !changes[SETTINGS_KEY]) return;
      settings = { ...DEFAULTS, ...(changes[SETTINGS_KEY].newValue || {}) };
      syncOverlay();
      syncSpotter();
    });

    // ---- "Hey Nova" in this tab ---------------------------------------------

    function setVoice(value) {
      voiceState = value;
      syncOverlay();
    }

    function notice(text) {
      const o = overlay();
      if (!o || !text || text === lastNotice) return;
      lastNotice = text;
      o.setNotice({ kind: "warn", text });
    }

    function getSpotter() {
      if (spotter || !root.NovaSpotter) return spotter;
      spotter = root.NovaSpotter.create({
        lang: settings.language,
        onWake: () => {
          send({ type: "NOVA_STOP_SPEAKING" }); // barge-in: interrupt Nova's voice
          Promise.resolve(opts.onWake()).then(() => setVoice("listening"));
        },
        onListening: () => setVoice("listening"),
        onInterim: (text) => {
          const o = overlay();
          if (o) o.setVoiceTranscript(text);
        },
        onTranscript: (text, alternatives) => {
          setVoice("idle");
          if (!alive()) return spotter.stop(); // disconnected copy: don't act on it
          opts.onTranscript(text, alternatives || []);
        },
        onNoSpeech: () => {
          setVoice("idle");
          const o = overlay();
          if (o) o.setNotice({ kind: "info", text: "I didn't catch a question after \"Hey Nova\". Try again a little closer to the mic." });
        },
        onStatus: (status) => {
          send({ type: "NOVA_PAGE_STATUS", status }); // shown on the settings page
          if (status.wake === "mic-blocked" || status.wake === "error") notice(status.detail);
        },
      });
      return spotter;
    }

    /** Listen while this tab is visible and the wake word is on. */
    function syncSpotter() {
      const want = settings.wakeWordEnabled && document.visibilityState === "visible";
      const s = getSpotter();
      if (!s) return;
      if (want) s.start();
      else s.stop();
    }

    // After an extension reload, this (old) copy can't reach the extension anymore.
    // Stop listening so it doesn't run commands twice or throw errors; the fresh
    // copy (after reloading the tab, or injected by background.js) takes over.
    const aliveCheck = setInterval(() => {
      if (alive()) return;
      clearInterval(aliveCheck);
      if (spotter) spotter.stop();
      document.removeEventListener("visibilitychange", syncSpotter);
      console.info("[Nova] Extension was reloaded: this copy stopped listening. Reload the page to get the new one.");
    }, 2000);

    document.addEventListener("visibilitychange", syncSpotter);

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg.type !== "string") return;
      if (msg.type === "NOVA_WAKE") {
        Promise.resolve(opts.onWake()).then(() => {
          voiceState = "listening";
          syncOverlay();
          sendResponse({ ok: true });
        });
        return true;
      }
      if (msg.type === "NOVA_INTERIM") {
        const o = overlay();
        if (o) o.setVoiceTranscript(msg.text);
        return;
      }
      if (msg.type === "NOVA_VOICE_STATE") {
        voiceState = msg.state === "error" ? "idle" : msg.state;
        syncOverlay();
        return;
      }
      if (msg.type === "NOVA_TRANSCRIPT") {
        const text = String(msg.text || "").trim();
        if (text) opts.onTranscript(text);
        else if (opts.onNoTranscript) opts.onNoTranscript({ reason: msg.reason, error: msg.error });
      }
    });

    return {
      get settings() {
        return settings;
      },
      /** Called by the page after it (re)creates its overlay. */
      sync: syncOverlay,

      speak(text) {
        // Replies use **bold**, `code` and list markdown; don't let the voice read the markup.
        const spoken = String(text || "")
          .replace(/[*`]+/g, "")
          .replace(/^\s*(?:[-•]|\d+[.)])\s+/gm, "")
          .trim();
        if (!settings.voiceReplies || !spoken) return;
        send({ type: "NOVA_SPEAK", text: spoken }); // background picks the engine + voice
      },
      stopSpeaking() {
        send({ type: "NOVA_STOP_SPEAKING" });
      },
      async listen() {
        const s = getSpotter();
        if (s && !s.blocked) {
          // Mic button with the in-tab listener: the next thing said is the question.
          if (s.listening) {
            s.cancel();
            setVoice("idle");
            return;
          }
          send({ type: "NOVA_STOP_SPEAKING" });
          if (s.listenNow()) return setVoice("listening");
        }
        if (voiceState === "listening") {
          send({ type: "NOVA_CANCEL_LISTEN" });
          return;
        }
        const res = await send({ type: "NOVA_LISTEN" });
        if (!res || !res.ok) {
          const o = overlay();
          if (o)
            o.setNotice({
              kind: "warn",
              text: "Nova can't use the microphone yet. Open Nova settings (right-click the toolbar icon → Options) and click \"Enable microphone\".",
            });
        }
      },
      /** Header speaker toggle: voice replies on/off, remembered everywhere. */
      async setVoiceReplies(on) {
        settings = { ...settings, voiceReplies: Boolean(on) };
        syncOverlay();
        if (!on) send({ type: "NOVA_STOP_SPEAKING" });
        try {
          await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
        } catch (_) {
          /* ignore */
        }
      },
    };
  }

  root.NovaVoiceClient = { attach }; // not "NovaVoice": voice.js (spoken translation) uses that name
})(globalThis);
