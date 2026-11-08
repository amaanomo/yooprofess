/*
 * Nova: "Hey Nova" listener that runs in the lecture tab itself.
 *
 * Chrome's built-in speech recognition runs continuously while the lecture tab is
 * visible; we look for "hey nova" in what it hears and treat whatever follows as
 * the question ("Hey Nova, can you pause the video" works in one breath). The
 * first time, Chrome asks the student to allow the microphone for the Panopto site.
 *
 * Getting the student's words reliably:
 *   - Clean mic: the mic is opened with echo cancellation, noise suppression and
 *     auto gain, and that track is handed to speech recognition (Chrome versions
 *     that support start(track)). Echo cancellation removes the lecture audio and
 *     Nova's own voice coming out of the speakers.
 *   - Several guesses: Chrome returns up to MAX_ALTERNATIVES hypotheses; the wake
 *     word may be in any of them, and content.js runs the first one that is a
 *     valid video command.
 *   - Settling: a question ends when Chrome marks it final OR when the words stop
 *     changing for SETTLE_MS (background noise can keep Chrome "listening" forever).
 *   - Vocabulary hints ("Nova", "pause", "skip to", ...) where Chrome supports them.
 *
 *   const s = NovaSpotter.create({ onWake, onInterim, onTranscript, onNoSpeech, onStatus });
 *   s.start(); s.stop();
 *   s.listenNow()   // mic button: treat the next thing said as the question
 *   s.cancel()      // stop waiting for a question
 *
 *   onTranscript(text, alternatives)   alternatives: other guesses, best first
 *   onNoSpeech(heard)                  heard: what we got before giving up ("" if nothing)
 */
(function (root) {
  "use strict";

  // Wake phrases = any GREETING followed by any NAME ("Hey Nova", "Yo Nova", ...).
  // Includes the ways Chrome's speech recognition tends to mishear them.
  // To add a phrase, add its first word to GREETINGS (or a new spelling to NAMES).
  const GREETINGS = ["hey", "hi", "hay", "heh", "ok", "okay", "yo", "yoh", "you", "yeah"];
  const NAMES = ["nova", "novah", "nover", "nava", "innova", "noah"];
  const WAKE_RE = new RegExp(`\\b(?:${GREETINGS.join("|")})[\\s,.!-]*(?:${NAMES.join("|")})\\b[\\s,.!?-]*`, "i");

  const QUESTION_WAIT_MS = 8000; // after "Hey Nova" with nothing else, wait this long for the question
  const SETTLE_MS = 1200; // words unchanged this long = the student finished (even if Chrome isn't "final")
  const MAX_ALTERNATIVES = 5;

  // Words we expect, as hints for Chrome's recognizer (only used where supported).
  const HINT_PHRASES = [
    "Hey Nova", "Yo Nova", "Nova", "pause the video", "resume", "play", "skip to", "go back",
    "rewind", "skip ahead", "seconds", "minutes", "speed", "mute", "unmute", "louder", "quieter",
  ];

  const MIC_CONSTRAINTS = {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  };

  const ERROR_TEXT = {
    "not-allowed": "Chrome blocked the microphone for this site. Click the mic icon in the address bar, choose Allow, then reload the page.",
    "service-not-allowed": "Chrome's speech service isn't available in this browser.",
    "audio-capture": "No microphone found.",
    network: "Speech recognition needs an internet connection. Retrying…",
    "language-not-supported": "That language isn't supported for speech recognition.",
  };

  /** Text of every alternative in a SpeechRecognitionResult, best first, de-duplicated. */
  function guesses(result) {
    const out = [];
    for (let k = 0; k < result.length; k++) {
      const t = result[k] && result[k].transcript;
      if (t && !out.includes(t)) out.push(t);
    }
    return out;
  }

  function create(handlers) {
    const h = Object.assign(
      { onWake() {}, onInterim() {}, onTranscript() {}, onNoSpeech() {}, onListening() {}, onStatus() {}, lang: "" },
      handlers
    );
    const SR = root.SpeechRecognition || root.webkitSpeechRecognition;
    const s = {
      wanted: false,
      running: false,
      rec: null,
      backoff: 300,
      consumed: 0, // results before this index are already handled
      length: 0,
      mode: "wake", // "wake" | "question"
      qFrom: null, // { index, wake } where the question starts
      qTimer: null,
      settleTimer: null,
      lastText: "",
      lastAlts: [],
      fatal: null,
      micStream: null, // echo-cancelled mic track for recognition
      micTried: false,
      noPhrases: false, // Chrome rejected vocabulary hints (cloud recognition): stop sending them
    };

    function status(state, detail = "") {
      h.onStatus({ wake: state, detail });
    }

    /** Open the mic with echo cancellation / noise suppression (once). Null if unavailable. */
    async function cleanMicTrack() {
      if (s.micStream && s.micStream.active) return s.micStream.getAudioTracks()[0] || null;
      if (s.micTried) return null;
      s.micTried = true;
      try {
        s.micStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
        const track = s.micStream.getAudioTracks()[0];
        console.log("[Nova] Mic opened with echo cancellation + noise suppression", track && track.getSettings ? track.getSettings() : "");
        return track || null;
      } catch (err) {
        console.warn("[Nova] Couldn't open the processed mic, using Chrome's default input:", err && err.name);
        return null;
      }
    }

    function releaseMic() {
      if (s.micStream) s.micStream.getTracks().forEach((t) => t.stop());
      s.micStream = null;
      s.micTried = false;
    }

    async function start() {
      s.wanted = true;
      if (s.running || s.rec || s.fatal) return;
      if (!SR) {
        s.fatal = "unsupported";
        status("error", "This Chrome has no built-in speech recognition.");
        return;
      }
      const rec = new SR();
      s.rec = rec; // claim the slot before awaiting, so start() can't run twice
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = MAX_ALTERNATIVES;
      rec.lang = h.lang || navigator.language || "en-US";
      try {
        // Contextual biasing (newer Chrome); silently skipped elsewhere.
        if (!s.noPhrases && "phrases" in rec && root.SpeechRecognitionPhrase) {
          rec.phrases = HINT_PHRASES.map((p) => new root.SpeechRecognitionPhrase(p, 5));
        }
      } catch (_) {
        /* not supported */
      }
      s.consumed = 0;
      s.length = 0;
      rec.onstart = () => {
        s.running = true;
        s.backoff = 300;
        status("listening", 'Say "Hey Nova" on your lecture tab.');
      };
      rec.onresult = (event) => onResults(event.results);
      rec.onerror = (event) => {
        const err = event.error;
        if (err === "no-speech" || err === "aborted") return; // normal; onend restarts
        if (err === "phrases-not-supported") {
          // Vocabulary hints only work with on-device recognition. Retry without them.
          s.noPhrases = true;
          console.info("[Nova] Speech hints aren't supported here; listening without them.");
          return;
        }
        console.warn("[Nova] speech recognition error:", err, event.message || "");
        if (err === "not-allowed" || err === "service-not-allowed" || err === "audio-capture" || err === "language-not-supported") {
          s.fatal = err; // don't hammer Chrome with retries; the student has to fix it
          s.wanted = false;
          status(err === "not-allowed" ? "mic-blocked" : "error", ERROR_TEXT[err]);
        } else if (err === "network") {
          s.backoff = Math.min(s.backoff * 2, 15000);
          status("error", ERROR_TEXT.network);
        }
      };
      rec.onend = () => {
        s.running = false;
        s.rec = null;
        // Session ended mid-question: use what we have, or keep waiting in the next session.
        if (s.mode === "question") {
          if (s.lastText) finishQuestion();
          else s.qFrom = { index: 0, wake: false };
        }
        s.consumed = 0;
        s.length = 0;
        if (s.wanted) setTimeout(() => s.wanted && start(), s.backoff);
        else releaseMic();
      };

      const track = await cleanMicTrack();
      if (s.rec !== rec || !s.wanted) {
        s.rec = s.rec === rec ? null : s.rec;
        return; // stopped while the mic was opening
      }
      try {
        // Chrome versions that support it recognize from our echo-cancelled track;
        // older ones ignore the argument and use the default mic.
        if (track && track.readyState === "live") rec.start(track);
        else rec.start();
      } catch (err) {
        try {
          rec.start(); // start(track) rejected: fall back to the default mic
        } catch (err2) {
          s.rec = null;
          console.warn("[Nova] speech recognition didn't start:", err2);
          setTimeout(() => s.wanted && start(), 1000);
        }
      }
    }

    function stop() {
      s.wanted = false;
      endQuestion();
      if (s.rec) s.rec.abort();
      else releaseMic();
    }

    function onResults(results) {
      s.length = results.length;
      if (s.mode === "wake") {
        for (let i = s.consumed; i < results.length; i++) {
          // The wake phrase may only be in a lower-ranked guess ("hey no va" vs "hey nova").
          const alts = guesses(results[i]);
          const hit = alts.find((t) => WAKE_RE.test(t));
          if (hit) {
            console.log("[Nova] Wake phrase heard:", hit.trim());
            beginQuestion({ index: i, wake: true });
            h.onWake();
            break;
          }
          if (results[i].isFinal) s.consumed = i + 1; // ordinary speech, not for us
        }
        if (s.mode !== "question") return;
      }

      // Question mode: everything after the wake phrase, for each guess of the latest segment.
      const from = s.qFrom.index;
      if (from >= results.length) return;
      const strip = (t, i) => {
        if (i === from && s.qFrom.wake) {
          const m = WAKE_RE.exec(t);
          return m ? t.slice(m.index + m[0].length) : t;
        }
        return t;
      };
      // In the segment with the wake phrase, prefer the guesses that actually contain it
      // (the top guess may be "hey no va skip to 2:00" while guess 2 is "hey nova skip to 2:00").
      const ranked = (i) => {
        const g = guesses(results[i]);
        return i === from && s.qFrom.wake ? [...g.filter((t) => WAKE_RE.test(t)), ...g.filter((t) => !WAKE_RE.test(t))] : g;
      };
      let prefix = "";
      let allFinal = true;
      for (let i = from; i < results.length - 1; i++) {
        prefix += " " + strip(ranked(i)[0] || "", i);
        if (!results[i].isFinal) allFinal = false;
      }
      const lastIndex = results.length - 1;
      const last = results[lastIndex];
      if (!last.isFinal) allFinal = false;
      const clean = (t) => t.replace(/\s+/g, " ").trim();
      const alts = ranked(lastIndex).map((t) => clean(prefix + " " + strip(t, lastIndex))).filter(Boolean);
      const text = alts[0] || "";
      if (!text) return;

      h.onInterim(text);
      s.lastText = text;
      s.lastAlts = alts.slice(1);
      if (allFinal) return finishQuestion();
      // Not final yet: finish anyway once the words stop changing (noise can keep Chrome waiting).
      clearTimeout(s.settleTimer);
      s.settleTimer = setTimeout(() => {
        if (s.mode === "question" && s.lastText === text) {
          console.log("[Nova] Question settled (Chrome hadn't finalized it)");
          finishQuestion();
        }
      }, SETTLE_MS);
    }

    function finishQuestion() {
      const text = s.lastText;
      const alternatives = s.lastAlts;
      s.consumed = s.length;
      endQuestion();
      if (!text) return;
      console.log("[Nova] Heard:", text, alternatives.length ? { alternatives } : "");
      h.onTranscript(text, alternatives);
    }

    function beginQuestion(from) {
      s.mode = "question";
      s.qFrom = from;
      s.lastText = "";
      s.lastAlts = [];
      clearTimeout(s.qTimer);
      s.qTimer = setTimeout(() => {
        if (s.mode !== "question") return;
        if (s.lastText) return finishQuestion(); // we did hear something: use it
        s.consumed = s.length;
        endQuestion();
        h.onNoSpeech("");
      }, QUESTION_WAIT_MS);
      h.onListening();
    }

    function endQuestion() {
      clearTimeout(s.qTimer);
      clearTimeout(s.settleTimer);
      s.mode = "wake";
      s.qFrom = null;
      s.lastText = "";
      s.lastAlts = [];
    }

    return {
      start,
      stop,
      get active() {
        return Boolean(s.running || s.rec);
      },
      get blocked() {
        return s.fatal;
      },
      /** Mic button: the next thing said is the question. */
      listenNow() {
        if (!s.wanted) start();
        if (s.fatal) return false;
        if (s.mode !== "question") beginQuestion({ index: s.length, wake: false });
        return true;
      },
      cancel() {
        if (s.mode !== "question") return;
        s.consumed = s.length;
        endQuestion();
      },
      get listening() {
        return s.mode === "question";
      },
    };
  }

  root.NovaSpotter = { create, WAKE_RE };
})(globalThis);
