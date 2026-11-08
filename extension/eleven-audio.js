/*
 * Nova: ElevenLabs audio player (English voice), shared by the offscreen voice
 * engine (offscreen.js) and the whiteboard (explain-app, bundled via an import).
 *
 * Plays MP3 from the backend's /tts or /tts/stream. With /tts/stream it uses
 * MediaSource so audio starts with the first chunk instead of after the whole
 * clip has downloaded; without MediaSource it falls back to a Blob.
 */
(function (root) {
  "use strict";

  const MIME = "audio/mpeg";
  const canStream = () =>
    typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function" && MediaSource.isTypeSupported(MIME);

  async function errorFrom(res) {
    const data = await res.json().catch(() => ({}));
    return new Error(data.error || `HTTP ${res.status}`);
  }

  /** POST JSON and return the whole MP3 as a Blob (for prefetching). */
  async function fetchBlob(url, body, signal) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    if (!res.ok) throw await errorFrom(res);
    return res.blob();
  }

  /**
   * Play one clip.
   * @param {object} o
   * @param {string} [o.url]    backend endpoint to POST o.body to (/tts/stream streams)
   * @param {object} [o.body]
   * @param {Blob}   [o.blob]   already-fetched audio (skips the request)
   * @param {() => void} [o.onstart]
   * @param {() => void} [o.onend]  played to the end
   * @param {(e: {error: string, message?: string}) => void} [o.onerror]
   *   error: "interrupted" (stop()), "not-allowed" (needs a user gesture), or "eleven"
   * @returns {{ started: Promise<{ok: boolean, error?: string}>, done: Promise<{ok: boolean, error?: string}>,
   *             stop(): void, pause(): void, resume(): void }}
   */
  function play(o) {
    const audio = new Audio();
    const controller = new AbortController();
    let objectUrl = null;
    let started = false;
    let finished = false;
    let resolveStarted;
    let resolveDone;
    const startedP = new Promise((r) => (resolveStarted = r));
    const doneP = new Promise((r) => (resolveDone = r));

    function cleanup() {
      controller.abort();
      audio.pause();
      audio.removeAttribute("src");
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }

    function finish(result, err) {
      if (finished) return;
      finished = true;
      cleanup();
      if (!started) resolveStarted(result);
      resolveDone(result);
      if (result.ok) o.onend && o.onend();
      else o.onerror && o.onerror(err || { error: result.error });
    }

    function fail(err) {
      const name = err && err.name;
      if (name === "AbortError") return finish({ ok: false, error: "interrupted" }, { error: "interrupted" });
      const error = name === "NotAllowedError" ? "not-allowed" : "eleven";
      finish({ ok: false, error }, { error, message: String((err && err.message) || err) });
    }

    audio.addEventListener("playing", () => {
      if (started || finished) return;
      started = true;
      resolveStarted({ ok: true });
      o.onstart && o.onstart();
    });
    audio.addEventListener("ended", () => finish({ ok: true }));
    audio.addEventListener("error", () => fail(new Error("audio playback failed")));

    const startPlayback = () => {
      const p = audio.play();
      if (p && p.catch) p.catch((err) => !finished && fail(err));
    };

    function playBlob(blob) {
      objectUrl = URL.createObjectURL(blob);
      audio.src = objectUrl;
      startPlayback();
    }

    async function playStream(res) {
      const ms = new MediaSource();
      objectUrl = URL.createObjectURL(ms);
      audio.src = objectUrl;
      await new Promise((r) => ms.addEventListener("sourceopen", r, { once: true }));
      const sb = ms.addSourceBuffer(MIME);
      const appended = () => new Promise((r) => sb.addEventListener("updateend", r, { once: true }));
      const reader = res.body.getReader();
      let first = true;
      for (;;) {
        const { value, done } = await reader.read();
        if (finished) return reader.cancel().catch(() => {});
        if (done) break;
        if (!value || !value.length) continue;
        sb.appendBuffer(value);
        await appended();
        if (first) {
          first = false;
          startPlayback();
        }
      }
      if (first) throw new Error("no audio received");
      if (ms.readyState === "open") ms.endOfStream();
    }

    (async () => {
      try {
        if (o.blob) return playBlob(o.blob);
        const res = await fetch(o.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(o.body || {}),
          signal: controller.signal,
        });
        if (!res.ok) throw await errorFrom(res);
        if (/\/stream$/.test(o.url) && res.body && canStream()) await playStream(res);
        else playBlob(await res.blob());
      } catch (err) {
        if (!finished) fail(err);
      }
    })();

    return {
      started: startedP,
      done: doneP,
      stop: () => finish({ ok: false, error: "interrupted" }, { error: "interrupted" }),
      pause: () => audio.pause(),
      resume: () => {
        if (!finished && audio.paused && started) startPlayback();
      },
    };
  }

  root.NovaElevenAudio = { play, fetchBlob, canStream };
})(globalThis);
