// Orbit whiteboard tab: fetches a drawing plan from the backend (POST /explain
// via the background worker) and plays it step by step with narration, a lesson
// outline, follow-up questions and Simpler / Deeper levels.
(function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const BOARD_H = 62; // board viewBox is 100 x 62; plan coordinates are 0-100
  const $ = (id) => document.getElementById(id);

  const layer = $("layer");
  const bubble = $("bubble");
  const avatar = $("avatar");
  const statusEl = $("status");
  const playBtn = $("play");
  const prevBtn = $("prev");
  const nextBtn = $("next");
  const replayBtn = $("replay");
  const voiceBtn = $("voice");
  const simplerBtn = $("simpler");
  const deeperBtn = $("deeper");
  const progress = $("progress");
  const outline = $("outline");
  const askForm = $("ask-form");
  const askInput = $("ask-input");
  const askBtn = $("ask-btn");

  const synth = window.speechSynthesis;
  const hasVoice = !!synth && typeof window.SpeechSynthesisUtterance !== "undefined";

  let ctx = null; // what to explain: lecture_id, question, reply, current_time
  let planKey = ""; // storage key base for cached plans
  let level = "normal"; // "normal" | "simpler" | "deeper"
  let steps = [];
  let index = -1; // step currently shown
  let playing = true;
  let timer = null;
  let narrId = 0; // bumps whenever narration restarts or stops, so stale callbacks do nothing
  let voiceBlocked = false; // Chrome refused speech (no user gesture yet)
  let busy = false;
  let muted = readPref("orbit:muted") === "1";

  // ---- helpers -------------------------------------------------------------
  function readPref(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  function writePref(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* ignore */ }
  }

  function el(name, attrs) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    return node;
  }

  const sx = (v) => Number(v) || 0;
  const sy = (v) => (Number(v) || 0) * (BOARD_H / 100);

  function setStatus(text) {
    statusEl.hidden = !text;
    statusEl.textContent = text || "";
  }

  function sendToBackground(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: "unreachable" });
          else resolve(res || { ok: false, error: "unreachable" });
        });
      } catch (_) {
        resolve({ ok: false, error: "unreachable" });
      }
    });
  }

  const validPlan = (p) => !!p && Array.isArray(p.steps) && p.steps.length > 0;

  // ---- drawing -------------------------------------------------------------
  // cur: shape belongs to the current step (highlighted). animate: draw it on.
  function drawShape(s, cur, animate) {
    const hl = cur ? " hl" : "";
    const anim = cur && animate;
    const lineAttrs = (extra) => ({
      stroke: "#2e6b57",
      "stroke-width": 0.25,
      fill: "none",
      pathLength: 1,
      class: ((anim ? "draw" + (extra || "") : "") + hl).trim(),
    });
    const fillCls = (base) => ((anim ? "draw pop" : "") + hl).trim() || base;
    const label = s.label ? String(s.label) : "";
    // Shrink the font so a label fits inside its shape (avg glyph width ~0.55em).
    const fit = (width, max) => Math.max(0.8, Math.min(max, (width * 0.9) / (0.55 * Math.max(1, label.length))));
    const textAttrs = (extra) => ({
      "text-anchor": "middle",
      "dominant-baseline": "middle",
      "font-size": 1.5,
      fill: "#1d2b27",
      class: ((anim ? "fade" : "") + (cur ? " hl-text" : "")).trim(),
      ...extra,
    });

    const g = el("g");
    switch (s.type) {
      case "box": {
        const w = sx(s.w) || 20;
        const h = sy(s.h) || 8;
        g.append(el("rect", { ...lineAttrs(), class: fillCls(""), fill: "#e8f5ef", x: sx(s.x), y: sy(s.y), width: w, height: h, rx: 1.2 }));
        if (label) {
          const t = el("text", textAttrs({ "font-size": fit(w, 1.8), x: sx(s.x) + w / 2, y: sy(s.y) + h / 2 }));
          t.textContent = label;
          g.append(t);
        }
        break;
      }
      case "circle": {
        const r = (sx(s.w) || 12) / 2;
        g.append(el("circle", { ...lineAttrs(), class: fillCls(""), fill: "#e8f5ef", cx: sx(s.x), cy: sy(s.y), r }));
        if (label) {
          const t = el("text", textAttrs({ "font-size": fit(r * 1.6, 1.8), x: sx(s.x), y: sy(s.y) }));
          t.textContent = label;
          g.append(t);
        }
        break;
      }
      case "arrow":
      case "line": {
        const to = Array.isArray(s.to) ? s.to : [sx(s.x) + 10, s.y];
        const x1 = sx(s.x), y1 = sy(s.y), x2 = sx(to[0]), y2 = sy(to[1]);
        g.append(el("line", { ...lineAttrs(), x1, y1, x2, y2 }));
        if (s.type === "arrow") {
          const a = Math.atan2(y2 - y1, x2 - x1);
          const len = 1.2;
          const p = (ang) => `${x2 - len * Math.cos(a + ang)},${y2 - len * Math.sin(a + ang)}`;
          g.append(el("polyline", { ...lineAttrs(" draw-late"), points: `${p(0.45)} ${x2},${y2} ${p(-0.45)}` }));
        }
        if (label) {
          const t = el("text", textAttrs({ x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 1.2, "font-size": 1.3 }));
          t.textContent = label;
          g.append(t);
        }
        break;
      }
      case "text":
      default: {
        const t = el("text", textAttrs({ x: sx(s.x), y: sy(s.y), "font-size": 1.9 }));
        t.textContent = label;
        g.append(t);
      }
    }
    layer.append(g);
  }

  // Where the pulsing "look here" dot goes for a shape.
  function anchor(s) {
    const w = sx(s.w), h = sy(s.h);
    switch (s.type) {
      case "box": return [sx(s.x) + (w || 20), sy(s.y)];
      case "circle": { const r = (w || 12) / 2; return [sx(s.x) + r * 0.7, sy(s.y) - r * 0.7]; }
      case "arrow":
      case "line": { const to = Array.isArray(s.to) ? s.to : [sx(s.x) + 10, s.y]; return [sx(to[0]), sy(to[1])]; }
      default: return [sx(s.x) + String(s.label || "").length * 0.45 + 1, sy(s.y)];
    }
  }

  function renderUpTo(i, animateLast) {
    layer.replaceChildren();
    // A step with "clear": true starts a fresh board; only draw from the latest one.
    let from = 0;
    for (let n = 0; n <= i; n++) if (steps[n].clear) from = n;
    let last = null;
    for (let n = from; n <= i; n++) {
      for (const s of steps[n].draw || []) {
        drawShape(s, n === i, animateLast && n === i);
        if (n === i) last = s;
      }
    }
    if (last) {
      const [px, py] = anchor(last);
      layer.append(el("circle", { class: "pointer", cx: px, cy: py, r: 0.7 }));
    }
  }

  // ---- narration (browser speech, falls back to a reading-time timer) ------
  function stopSpeech() {
    if (hasVoice) {
      try { synth.cancel(); } catch (_) { /* ignore */ }
    }
    avatar.classList.remove("talking");
  }

  function stopNarration() {
    narrId++;
    clearTimeout(timer);
    stopSpeech();
  }

  const voiceOn = () => hasVoice && !muted && !voiceBlocked;
  const atEnd = () => index >= steps.length - 1;

  function startNarration() {
    stopNarration();
    if (index < 0 || !steps[index]) return;
    const id = narrId;
    const text = steps[index].say || "";

    const advance = (delay) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (id === narrId && playing && !atEnd()) showStep(index + 1, true);
      }, delay);
    };
    // No voice: move the mouth for roughly the reading time, then advance.
    const timed = () => {
      avatar.classList.add("talking");
      const ms = Math.max(3500, text.length * 55);
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (id !== narrId) return;
        avatar.classList.remove("talking");
        if (playing && !atEnd()) showStep(index + 1, true);
      }, ms);
    };

    if (!voiceOn()) {
      if (playing) timed();
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.onstart = () => { if (id === narrId) avatar.classList.add("talking"); };
    u.onend = () => {
      if (id !== narrId) return;
      avatar.classList.remove("talking");
      if (playing) advance(800);
    };
    u.onerror = (e) => {
      if (id !== narrId) return;
      avatar.classList.remove("talking");
      if (e.error === "canceled" || e.error === "interrupted") return;
      if (e.error === "not-allowed") {
        voiceBlocked = true; // needs a click first; the next click retries
        updateProgress();
      }
      if (playing) timed();
    };
    synth.speak(u);
  }

  // ---- playback ------------------------------------------------------------
  function updateProgress() {
    if (!steps.length) { progress.textContent = ""; return; }
    let t = `Step ${index + 1} of ${steps.length}`;
    if (hasVoice && !muted && voiceBlocked) t += " · click Play to hear the voice";
    progress.textContent = t;
  }

  function showStep(i, animate) {
    index = Math.max(0, Math.min(steps.length - 1, i));
    renderUpTo(index, animate);
    bubble.textContent = steps[index].say || "";
    updateProgress();
    prevBtn.disabled = index === 0;
    nextBtn.disabled = atEnd();
    [...outline.children].forEach((li, n) => li.classList.toggle("current", n === index));
    const cur = outline.children[index];
    if (cur) cur.scrollIntoView({ block: "nearest" });
    startNarration();
  }

  function buildOutline() {
    outline.replaceChildren();
    steps.forEach((s, n) => {
      const li = document.createElement("li");
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = `${n + 1}.`;
      const text = document.createElement("span");
      text.textContent = s.head || (s.say || "").slice(0, 30);
      li.append(num, text);
      li.addEventListener("click", () => go(n));
      outline.append(li);
    });
  }

  function setPlaying(value) {
    playing = value;
    playBtn.textContent = playing ? "⏸ Pause" : "▶ Play";
    if (playing) {
      voiceBlocked = false; // a click is a user gesture, so try the voice again
      if (steps.length) startNarration();
    } else {
      stopNarration();
    }
    updateProgress();
  }

  // Manual navigation pauses autoplay; the chosen step is still read aloud.
  function go(i) {
    if (!steps.length || busy) return;
    voiceBlocked = false;
    setPlaying(false);
    showStep(i, i > index);
  }

  playBtn.addEventListener("click", () => !busy && steps.length && setPlaying(!playing));
  nextBtn.addEventListener("click", () => go(index + 1));
  prevBtn.addEventListener("click", () => go(index - 1));
  replayBtn.addEventListener("click", () => {
    if (!steps.length || busy) return;
    voiceBlocked = false;
    playing = true;
    playBtn.textContent = "⏸ Pause";
    showStep(0, true);
  });

  function updateVoiceButton() {
    voiceBtn.textContent = muted ? "🔇 Muted" : "🔊 Voice on";
    voiceBtn.hidden = !hasVoice;
  }
  voiceBtn.addEventListener("click", () => {
    muted = !muted;
    voiceBlocked = false;
    writePref("orbit:muted", muted ? "1" : "0");
    updateVoiceButton();
    if (playing && steps.length) startNarration();
    else stopNarration();
    updateProgress();
  });

  document.addEventListener("keydown", (e) => {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    if (e.key === "ArrowRight") go(index + 1);
    else if (e.key === "ArrowLeft") go(index - 1);
    else if (e.key === " ") {
      e.preventDefault();
      if (steps.length && !busy) setPlaying(!playing);
    }
  });

  // ---- loading, levels, follow-ups -----------------------------------------
  function setBusy(value) {
    busy = value;
    for (const b of [prevBtn, nextBtn, playBtn, replayBtn, simplerBtn, deeperBtn, askBtn]) b.disabled = value;
    askInput.disabled = value;
    if (!value && steps.length) {
      prevBtn.disabled = index === 0;
      nextBtn.disabled = atEnd();
    }
  }

  function updateLevelButtons() {
    simplerBtn.classList.toggle("active", level === "simpler");
    deeperBtn.classList.toggle("active", level === "deeper");
  }

  const cacheKey = () => `${planKey}:${level}`;

  async function persist(plan) {
    try { await chrome.storage.local.set({ [cacheKey()]: plan }); } catch (_) { /* cache is optional */ }
  }

  // Loads the lesson for the current level (from cache, else the backend).
  async function loadPlan(previousLevel) {
    const hadLesson = steps.length > 0;
    stopNarration();
    setBusy(true);
    setStatus(
      level === "simpler" ? "Making it simpler…" : level === "deeper" ? "Going deeper…" : "Orbit is thinking about how to draw this…"
    );

    let plan = null;
    try {
      const cached = await chrome.storage.local.get(cacheKey());
      plan = cached[cacheKey()] || null;
    } catch (_) { /* ignore */ }

    if (!validPlan(plan)) {
      const res = await sendToBackground({ type: "ORBIT_EXPLAIN_PLAN", payload: { ...ctx, level } });
      plan = res.ok ? res.data : null;
      // A single step with no drawing is the server's text-only fallback; don't cache it.
      if (validPlan(plan) && (plan.steps.length > 1 || (plan.steps[0].draw || []).length)) persist(plan);
    }

    setBusy(false);
    if (!validPlan(plan)) {
      if (hadLesson) {
        // Keep the lesson the student already has.
        level = previousLevel || "normal";
        updateLevelButtons();
        setStatus("");
        bubble.textContent = "Sorry, I couldn't do that right now. Try again in a moment.";
      } else {
        setStatus("I couldn't reach the Orbit server to draw this. Close this tab and try again in a moment.");
        bubble.textContent = "Sorry, something went wrong.";
      }
      return;
    }

    steps = plan.steps;
    $("title").textContent = plan.title || "Orbit whiteboard";
    document.title = plan.title ? `${plan.title} · Orbit` : "Orbit whiteboard";
    setStatus("");
    buildOutline();
    playing = true;
    playBtn.textContent = "⏸ Pause";
    showStep(0, true);
  }

  function setLevel(next) {
    if (busy || !ctx) return;
    const previous = level;
    level = level === next ? "normal" : next; // clicking the active level goes back to normal
    updateLevelButtons();
    loadPlan(previous);
  }
  simplerBtn.addEventListener("click", () => setLevel("simpler"));
  deeperBtn.addEventListener("click", () => setLevel("deeper"));

  askForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const question = askInput.value.trim();
    if (!question || !steps.length || busy) return;

    stopNarration();
    setBusy(true);
    bubble.textContent = "Let me think about that…";
    const res = await sendToBackground({
      type: "ORBIT_EXPLAIN_PLAN",
      payload: { ...ctx, level, followup: question, lesson: steps.map(({ head, say }) => ({ head, say })) },
    });
    setBusy(false);

    const plan = res.ok ? res.data : null;
    if (!validPlan(plan)) {
      bubble.textContent = "Sorry, I couldn't answer that right now. Try asking again.";
      return;
    }
    const first = steps.length;
    plan.steps[0].clear = true; // start the answer on a fresh board
    steps = steps.concat(plan.steps);
    askInput.value = "";
    persist({ title: $("title").textContent, steps });
    buildOutline();
    playing = true;
    playBtn.textContent = "⏸ Pause";
    voiceBlocked = false;
    showStep(first, true);
  });

  async function load() {
    updateVoiceButton();
    const key = new URLSearchParams(location.search).get("k");
    const stored = key ? await chrome.storage.local.get(key) : {};
    ctx = stored[key];
    if (!ctx) {
      setStatus("I lost track of what to explain. Go back to the lecture and click “Explain in depth” again.");
      return;
    }
    planKey = "orbit:plan:" + key;
    $("question").textContent = ctx.question ? `You asked: ${ctx.question}` : "";
    updateLevelButtons();
    loadPlan();
  }

  window.addEventListener("beforeunload", stopNarration);
  load();
})();
