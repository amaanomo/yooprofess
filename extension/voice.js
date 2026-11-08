/*
 * Orbit: spoken translation.
 *
 * Reads translated caption lines aloud in sync with the video, using the browser's
 * built-in voices (Web Speech API), and turns the professor's audio down while it
 * speaks. It never imitates the professor: it uses a neutral narrator voice only.
 *
 * content.js calls lineStarted() when playback enters a cue; this file decides
 * whether and how fast to speak it. Pure helpers are tested in Node:  node voice.js
 */
(function (root) {
  "use strict";

  // Tunables
  const START_WINDOW_S = 1.5; // only start a line if we're this close to its beginning
  const MAX_RATE = 1.3; // never speed up past this (before playbackRate)
  const SLOT_PADDING_S = 0.4; // leave a little breathing room at the end of each line
  const DUCK_VOLUME = 0.15; // professor's audio while Orbit speaks
  const MAX_BACKLOG = 2; // speaking + queued lines before we drop the backlog
  /** Rough characters spoken per second at rate 1.0, by language (base code). */
  const SPEECH_CPS = { es: 15, fr: 15, pt: 15, vi: 13, hi: 13, ar: 12, ko: 7, ja: 7, zh: 5 };

  /** Speech rate that fits `text` into a cue lasting `duration` seconds. */
  function rateFor(text, duration, langCode, playbackRate = 1) {
    const cps = SPEECH_CPS[String(langCode).split("-")[0].toLowerCase()] || 14;
    const estimate = String(text).length / cps;
    const slot = Math.max(0.5, duration - SLOT_PADDING_S);
    const fit = Math.min(MAX_RATE, Math.max(1, estimate / slot));
    const rate = fit * (Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1);
    return Math.round(Math.min(3, Math.max(0.5, rate)) * 100) / 100;
  }

  /** Should a line that started at cueStart be spoken when the playhead is at t? */
  function shouldStart(t, cueStart) {
    return t >= cueStart - 0.05 && t - cueStart <= START_WINDOW_S;
  }

  /** Best installed voice for a BCP-47 language like "es-ES": a matching language, nicer names first. */
  function pickVoice(voices, speechLang) {
    const base = String(speechLang).split("-")[0].toLowerCase();
    const matches = voices.filter((v) => String(v.lang).toLowerCase().replace("_", "-").split("-")[0] === base);
    const exact = matches.filter((v) => String(v.lang).toLowerCase().replace("_", "-") === speechLang.toLowerCase());
    const nice = (list) => list.find((v) => /premium|enhanced|natural|neural|google/i.test(v.name));
    return nice(exact) || nice(matches) || exact[0] || matches[0] || null;
  }

  /**
   * TTS provider interface. v1 is the browser's speechSynthesis.
   * A cloud provider (e.g. a backend /tts endpoint returning cached audio per cue,
   * played through an <audio> element) can implement the same four methods later.
   */
  const WebSpeechProvider = {
    available: () => typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined",
    voices: () => (WebSpeechProvider.available() ? speechSynthesis.getVoices() : []),
    speak(text, { lang, rate, voice, onstart, onend }) {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      u.rate = rate;
      if (voice) u.voice = voice;
      u.onstart = onstart;
      u.onend = onend;
      u.onerror = onend;
      // Chrome stays paused after cancel(); without this, nothing plays after a pause + seek.
      if (speechSynthesis.paused) speechSynthesis.resume();
      speechSynthesis.speak(u);
    },
    cancel: () => WebSpeechProvider.available() && speechSynthesis.cancel(),
    pause: () => WebSpeechProvider.available() && speechSynthesis.pause(),
    resume: () => WebSpeechProvider.available() && speechSynthesis.resume(),
    /** Must run inside a click handler: browsers only allow speech after a user gesture. */
    prime() {
      if (!WebSpeechProvider.available()) return;
      speechSynthesis.cancel();
      speechSynthesis.speak(new SpeechSynthesisUtterance(""));
    },
  };
  // const CloudProvider = { speak(text, opts) { /* fetch BACKEND_URL/tts, play audio */ }, cancel() {}, pause() {}, resume() {}, prime() {} };

  /**
   * @param {object} o
   * @param {() => Iterable<HTMLVideoElement>} o.getVideos  every <video> to duck
   * @param {(speaking: boolean) => void} [o.onSpeaking]
   * @param {object} [o.provider]  defaults to the Web Speech API
   */
  function create(o) {
    const provider = o.provider || WebSpeechProvider;
    let enabled = false;
    let lang = null; // { code, speechLang }
    let inFlight = 0;
    let lastSpoken = -1;
    let generation = 0;
    const ducked = new Map(); // video -> { prev, expected, managed }

    function setSpeaking(on) {
      o.onSpeaking && o.onSpeaking(on);
    }

    // volumechange fires asynchronously, so compare against the volume we set rather than using a flag.
    function onVolumeChange(event) {
      const entry = ducked.get(event.currentTarget);
      if (entry && Math.abs(event.currentTarget.volume - entry.expected) > 0.001) entry.managed = false; // the student changed it
    }

    function duck() {
      for (const v of o.getVideos()) {
        if (ducked.has(v)) continue;
        const expected = Math.min(v.volume, DUCK_VOLUME);
        ducked.set(v, { prev: v.volume, expected, managed: true });
        v.addEventListener("volumechange", onVolumeChange);
        v.volume = expected;
      }
    }

    function restore() {
      for (const [v, entry] of ducked) {
        v.removeEventListener("volumechange", onVolumeChange);
        if (entry.managed && v.isConnected) v.volume = entry.prev;
      }
      ducked.clear();
    }

    function cancel() {
      generation++;
      provider.cancel();
      inFlight = 0;
      setSpeaking(false);
    }

    const api = {
      available: () => provider.available(),
      prime: () => provider.prime(),
      voiceFor: (speechLang) => pickVoice(provider.voices(), speechLang),

      /** lang: { code: "es", speechLang: "es-ES" } */
      setLanguage(next) {
        if (lang && next && lang.code === next.code) return;
        lang = next;
        cancel();
        lastSpoken = -1;
      },

      setEnabled(on) {
        if (on === enabled) return;
        enabled = on;
        lastSpoken = -1;
        if (on) duck();
        else {
          cancel();
          restore();
        }
      },
      isEnabled: () => enabled,

      /** New videos (Panopto swaps or adds streams) get turned down too. */
      refreshDucking() {
        if (enabled) duck();
      },

      /**
       * Playback is inside cue `index`. Speaks it once, if it just started and is translated.
       * @param {{index:number, start:number, end:number, text:string|null, t:number, playbackRate:number, playing:boolean}} c
       */
      lineAt(c) {
        if (!enabled || !lang || !c.playing || c.index < 0 || c.index === lastSpoken) return;
        if (!c.text || !shouldStart(c.t, c.start)) return; // untranslated, or we joined mid-line: wait for the next one
        lastSpoken = c.index;
        if (inFlight >= MAX_BACKLOG) cancel(); // never fall more than one line behind
        const gen = generation;
        const rate = rateFor(c.text, c.end - c.start, lang.code, c.playbackRate);
        const voice = api.voiceFor(lang.speechLang);
        inFlight++;
        provider.speak(c.text, {
          lang: lang.speechLang,
          rate,
          voice,
          onstart: () => gen === generation && setSpeaking(true),
          onend: () => {
            if (gen !== generation) return;
            inFlight = Math.max(0, inFlight - 1);
            if (!inFlight) setSpeaking(false);
          },
        });
        const fmt = root.OrbitSRT ? root.OrbitSRT.formatTime : String;
        console.log(
          `[Orbit voice] ${fmt(c.start)} ${lang.code.split("-")[0].toUpperCase()} rate ${rate.toFixed(2)} · ${voice ? voice.name : "default voice"}: ${c.text}`
        );
      },

      pause: () => provider.pause(),
      resume: () => provider.resume(),
      /** Seek, language change, lecture change: stop talking and wait for the next line. */
      reset() {
        cancel();
        lastSpoken = -1;
      },
      destroy() {
        api.setEnabled(false);
      },
    };
    root.addEventListener && root.addEventListener("pagehide", () => restore());
    return api;
  }

  const api = { create, rateFor, shouldStart, pickVoice, SPEECH_CPS, DUCK_VOLUME, MAX_RATE };
  root.OrbitVoice = api;

  // ---------------------------------------------------------------------------
  // Tests: `node voice.js`. Never runs in the browser.
  // ---------------------------------------------------------------------------
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    if (typeof require !== "undefined" && require.main === module) runTests();
  }

  function runTests() {
    const assert = require("node:assert/strict");
    const tests = [];
    const test = (name, fn) => tests.push({ name, fn });

    test("rateFor: short line keeps 1.0, long line speeds up, capped at 1.3", () => {
      assert.equal(rateFor("Hola a todos.", 4, "es"), 1); // 13 chars / 15 cps < 3.6 s
      assert.equal(rateFor("x".repeat(60), 4, "es"), 1.11); // 4 s / 3.6 s
      assert.equal(rateFor("x".repeat(300), 4, "es"), 1.3); // capped
      assert.equal(rateFor("x".repeat(300), 4, "es", 1.5), 1.95); // scaled by playback speed
      assert.equal(rateFor("我们先看中间那个", 2, "zh-Hans"), 1); // 8 chars / 5 cps = 1.6 s
    });

    test("shouldStart: only near the start of a line", () => {
      assert.equal(shouldStart(10.2, 10), true);
      assert.equal(shouldStart(11.5, 10), true);
      assert.equal(shouldStart(11.6, 10), false); // joined mid-line after a seek
      assert.equal(shouldStart(9.5, 10), false);
    });

    test("pickVoice prefers exact language and nicer voices", () => {
      const voices = [
        { name: "Jorge", lang: "es-ES" },
        { name: "Paulina (Enhanced)", lang: "es-MX" },
        { name: "Mónica (Premium)", lang: "es-ES" },
        { name: "Samantha", lang: "en-US" },
      ];
      assert.equal(pickVoice(voices, "es-ES").name, "Mónica (Premium)");
      assert.equal(pickVoice(voices.slice(0, 2), "es-ES").name, "Paulina (Enhanced)");
      assert.equal(pickVoice(voices, "ko-KR"), null);
    });

    test("lineAt: speaks once per line, waits for translation, drops backlog, ducks and restores", () => {
      const spoken = [];
      let cancels = 0;
      const ends = [];
      const provider = {
        available: () => true,
        voices: () => [],
        speak: (text, opts) => (spoken.push({ text, rate: opts.rate }), ends.push(opts.onend)),
        cancel: () => cancels++,
        pause() {},
        resume() {},
        prime() {},
      };
      const video = { volume: 0.8, isConnected: true, addEventListener() {}, removeEventListener() {} };
      const v = create({ provider, getVideos: () => [video] });
      v.setLanguage({ code: "es", speechLang: "es-ES" });
      v.setEnabled(true);
      assert.equal(video.volume, 0.15);
      const at = (index, t, text = "uno") => v.lineAt({ index, start: index * 5, end: index * 5 + 4.5, text, t, playbackRate: 1, playing: true });
      at(0, 0.2);
      at(0, 0.4); // same line again: ignored
      at(1, 5.1, null); // not translated yet: silent
      at(2, 12); // joined 2 s late: skipped
      at(3, 15.1);
      assert.deepEqual(spoken.map((s) => s.text), ["uno", "uno"]);
      const before = cancels;
      at(4, 20.1); // two lines still in flight -> drop the backlog first
      assert.equal(cancels, before + 1);
      v.setEnabled(false);
      assert.equal(video.volume, 0.8);
    });

    let failed = 0;
    for (const t of tests) {
      try {
        t.fn();
        console.log(`  ok   ${t.name}`);
      } catch (err) {
        failed++;
        console.log(`  FAIL ${t.name}\n${err.stack}\n`);
      }
    }
    console.log(`\n[Orbit] voice.js: ${tests.length - failed}/${tests.length} tests passed`);
    if (failed) process.exitCode = 1;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
