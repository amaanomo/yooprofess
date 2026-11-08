/*
 * Nova: translated-subtitle overlay (UI only).
 *
 * Draws Nova's subtitle pill over Panopto's main video in its own Shadow DOM host
 * (<nova-subtitles>), separate from the Ask Nova card, so it keeps showing when
 * the card is minimized. It never takes clicks (pointer-events: none).
 *
 * content.js tells it what to show (render) and which card area to avoid; this
 * file only handles placement and looks.
 */
(function (root) {
  "use strict";

  // Panopto's own caption box. Unverified guesses: Nova's pill sits 12px above
  // whichever of these is visible over the video. Add the real selector here.
  const PANOPTO_CAPTION_SELECTORS = [
    ".captions-display",
    "#captionsOverlay",
    ".caption-overlay",
    "[class*='captionDisplay']",
    "[class*='caption-container']",
    ".vjs-text-track-display",
  ];
  // Panopto draws its captions in a band below the video, so by default the pill sits near
  // the video's bottom edge to cover as little of the slide as possible.
  const BOTTOM_MARGIN = 0.04; // fraction of video height
  const MIN_BOTTOM_PX = 12;
  // If captions are drawn on the video itself (a <track> in "showing" mode), stay above them.
  const NATIVE_CAPTION_BOTTOM = 0.15;
  const GAP_ABOVE_CAPTIONS = 12; // px
  const CARD_GAP = 16; // px between the Nova card and the pill's usable area
  const MIN_PILL_WIDTH = 240; // px
  const VIDEO_REPICK_MS = 500;

  const SVG_NS = "http://www.w3.org/2000/svg";
  const CJK = /[぀-ヿ㐀-鿿가-힯]/;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function planetSvg() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const body = document.createElementNS(SVG_NS, "circle");
    for (const [k, v] of Object.entries({ cx: 12, cy: 12, r: 4.6, fill: "#2e6b57" })) body.setAttribute(k, v);
    const ring = document.createElementNS(SVG_NS, "g");
    ring.setAttribute("class", "ring");
    const ellipse = document.createElementNS(SVG_NS, "ellipse");
    for (const [k, v] of Object.entries({ cx: 12, cy: 12, rx: 10, ry: 3.6, fill: "none", stroke: "#2e6b57", "stroke-width": 1.6, transform: "rotate(-24 12 12)" }))
      ellipse.setAttribute(k, v);
    ring.append(ellipse);
    svg.append(body, ring);
    return svg;
  }

  /** The visible <video> with the largest area on screen (Panopto's main stream). */
  function pickMainVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      const style = getComputedStyle(v);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
      const area = Math.max(0, r.width) * Math.max(0, r.height);
      if (area > bestArea) {
        best = v;
        bestArea = area;
      }
    }
    return bestArea > 2500 ? best : null;
  }

  /** Panopto's caption box if one is visible over the video: its top edge in viewport px. */
  function panoptoCaptionTop(videoRect) {
    for (const sel of PANOPTO_CAPTION_SELECTORS) {
      for (const node of document.querySelectorAll(sel)) {
        if (!node.textContent.trim()) continue;
        const r = node.getBoundingClientRect();
        if (r.height < 4 || r.width < 20) continue;
        const overlaps = r.top < videoRect.bottom && r.bottom > videoRect.top && r.left < videoRect.right && r.right > videoRect.left;
        if (overlaps) return r.top;
      }
    }
    return null;
  }

  async function loadStyles(shadow, cssUrl) {
    try {
      const css = await (await fetch(cssUrl)).text();
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        shadow.adoptedStyleSheets = [sheet];
      } catch (_) {
        shadow.prepend(el("style", null, css));
      }
    } catch (err) {
      console.warn("[Nova] Could not load subtitles.css", err);
    }
  }

  /**
   * @param {object} o
   * @param {string} o.cssUrl
   * @param {string} [o.mascotUrl]  chrome.runtime.getURL("icons/nova.png")
   * @param {() => DOMRect|null} o.getCardRect  the open Nova card, to keep the pill clear of it
   */
  function create(o) {
    const host = document.createElement("nova-subtitles");
    // Not `all: initial !important`: an !important reset would override the position/size we set every frame.
    host.style.cssText = "all: initial;";
    const setHost = (prop, value) => host.style.setProperty(prop, value, "important");
    for (const [k, v] of Object.entries({ position: "fixed", display: "none", "pointer-events": "none", overflow: "hidden", "z-index": "2147483646", margin: "0", padding: "0", border: "0" }))
      setHost(k, v);
    host.setAttribute("aria-live", "off");
    const shadow = host.attachShadow({ mode: "open" });

    const code = el("span", "code");
    const waves = el("span", "waves");
    waves.append(el("i"), el("i"), el("i"));
    const planet = el("span", "planet");
    const face = el("span", "face");
    if (o.mascotUrl) {
      const img = document.createElement("img");
      img.src = o.mascotUrl;
      img.style.cssText = "width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;";
      img.alt = "";
      face.append(img);
    } else {
      face.append(root.NovaOverlay && root.NovaOverlay.alienSvg ? root.NovaOverlay.alienSvg() : planetSvg());
    }
    planet.append(face, el("span", "orbit-ring"));
    const lang = el("span", "lang");
    lang.append(code, waves);
    const badge = el("div", "badge");
    badge.append(planet, lang);
    const original = el("div", "original");
    const translated = el("div", "translated");
    const lines = el("div", "lines");
    lines.append(original, translated);
    const pill = el("div", "pill");
    pill.append(badge, lines);
    pill.hidden = true;
    shadow.append(pill);

    let enabled = false;
    let video = null;
    let lastPick = 0;
    let rafId = 0;
    let lastKey = "";
    let hideTimer = 0;
    let lastHostCss = "";
    let lastPillCss = "";

    function place(now) {
      rafId = requestAnimationFrame(place);
      if (!video || !video.isConnected || now - lastPick > VIDEO_REPICK_MS) {
        video = pickMainVideo();
        lastPick = now;
      }
      if (!video) {
        if (lastHostCss !== "none") setHost("display", "none");
        lastHostCss = "none";
        return;
      }
      const vr = video.getBoundingClientRect();
      const hostCss = `${Math.round(vr.left)},${Math.round(vr.top)},${Math.round(vr.width)},${Math.round(vr.height)}`;
      if (hostCss !== lastHostCss) {
        lastHostCss = hostCss;
        setHost("display", "block");
        setHost("left", `${vr.left}px`);
        setHost("top", `${vr.top}px`);
        setHost("width", `${vr.width}px`);
        setHost("height", `${vr.height}px`);
        host.style.setProperty("--video-w", `${vr.width}px`);
      }

      // Keep clear of the open Nova card (it sits bottom-left and can cover part of the video).
      let left = 0;
      const card = o.getCardRect ? o.getCardRect() : null;
      if (card && card.right > vr.left && card.left < vr.right && card.bottom > vr.top && card.top < vr.bottom) {
        left = Math.min(vr.width - MIN_PILL_WIDTH, Math.max(0, card.right + CARD_GAP - vr.left));
      }
      const span = vr.width - left;
      const center = left + span / 2;
      const maxWidth = Math.max(MIN_PILL_WIDTH, span * 0.9);

      // Sit just above a caption box drawn over the video; otherwise near the bottom edge.
      const capTop = panoptoCaptionTop(vr);
      const nativeShowing = Array.from(video.textTracks || []).some((t) => t.mode === "showing");
      const bottom =
        capTop != null
          ? vr.bottom - capTop + GAP_ABOVE_CAPTIONS
          : nativeShowing
            ? vr.height * NATIVE_CAPTION_BOTTOM
            : Math.max(MIN_BOTTOM_PX, vr.height * BOTTOM_MARGIN);

      const pillCss = `${Math.round(center)},${Math.round(maxWidth)},${Math.round(bottom)}`;
      if (pillCss !== lastPillCss) {
        lastPillCss = pillCss;
        pill.style.left = `${center}px`;
        pill.style.maxWidth = `${maxWidth}px`;
        pill.style.bottom = `${bottom}px`;
      }
    }

    function animateWords(text) {
      translated.replaceChildren();
      const parts = CJK.test(text) ? Array.from(text) : text.split(/(\s+)/);
      const step = CJK.test(text) || parts.length > 60 ? 12 : 28;
      parts.forEach((part, i) => {
        const w = el("span", "w", part);
        w.style.animationDelay = `${i * step}ms`;
        translated.append(w);
      });
    }

    function sweep() {
      pill.classList.remove("arrive");
      void pill.offsetWidth; // restart the animation
      pill.classList.add("arrive");
    }

    function onFullscreen() {
      // Only the fullscreen element and its children are drawn in fullscreen, so move in there.
      const fs = document.fullscreenElement;
      const target = fs && fs.tagName !== "VIDEO" ? fs : document.documentElement;
      if (host.parentNode !== target) target.appendChild(host);
      lastHostCss = "";
    }

    const api = {
      host,
      async mount() {
        // @property rules inside a shadow root are ignored, so register the sweep angle on the page.
        try {
          CSS.registerProperty({ name: "--nova-a", syntax: "<angle>", inherits: false, initialValue: "0deg" });
        } catch (_) {
          /* already registered */
        }
        document.documentElement.appendChild(host);
        await loadStyles(shadow, o.cssUrl);
        document.addEventListener("fullscreenchange", onFullscreen);
      },

      /** Turn the overlay on (positioning loop runs) or off. */
      setEnabled(on) {
        if (on === enabled) return;
        enabled = on;
        cancelAnimationFrame(rafId);
        if (on) {
          lastHostCss = lastPillCss = "";
          rafId = requestAnimationFrame(place);
        } else {
          setHost("display", "none");
          pill.hidden = true;
          lastKey = "";
        }
      },

      /** Re-check placement now (card opened/closed, video swapped, ...). */
      relayout() {
        lastHostCss = lastPillCss = "";
        lastPick = 0;
      },

      /**
       * What to show. null hides the pill (no cue at the current time).
       * line: { key, langCode, mode: "translated"|"dual", original, translation, pending, failed }
       */
      render(line) {
        if (!line) {
          if (pill.hidden || pill.classList.contains("leaving")) return;
          pill.classList.add("leaving");
          clearTimeout(hideTimer);
          hideTimer = setTimeout(() => {
            pill.hidden = true;
            pill.classList.remove("leaving");
          }, 150);
          lastKey = "";
          return;
        }
        clearTimeout(hideTimer);
        pill.classList.remove("leaving");
        pill.hidden = false;
        const key = [line.key, line.langCode, line.mode, line.pending, line.failed, line.translation].join("|");
        if (key === lastKey) return;
        lastKey = key;

        code.textContent = line.langCode;
        original.hidden = line.mode !== "dual" || line.failed;
        original.textContent = line.original;
        pill.classList.toggle("pending", Boolean(line.pending));
        pill.classList.toggle("failed", Boolean(line.failed));

        if (line.pending) {
          const bars = el("div", "bars");
          bars.append(el("i"), el("i"));
          const shimmer = el("div", "shimmer");
          shimmer.append(bars, el("span", null, "Translating…"));
          translated.replaceChildren(shimmer);
          return;
        }
        if (line.failed) {
          // Couldn't be translated: show the professor's words so nothing is lost.
          translated.replaceChildren(el("span", null, line.original));
          return;
        }
        animateWords(line.translation);
        sweep();
      },

      /** Voice mode shows the sound bars; speaking animates them. */
      setVoice(on) {
        pill.classList.toggle("voice", Boolean(on));
        if (!on) pill.classList.remove("speaking");
      },
      setSpeaking(on) {
        pill.classList.toggle("speaking", Boolean(on));
      },
    };
    return api;
  }

  root.NovaSubtitles = { create, pickMainVideo, PANOPTO_CAPTION_SELECTORS };
})(globalThis);
