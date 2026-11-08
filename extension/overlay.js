/*
 * Nova: the on-page overlay (UI only).
 *
 * Renders the "Ask Nova" card inside a Shadow DOM root so Panopto's CSS can't
 * reach it and ours can't leak out. It knows nothing about captions, video, voice
 * or the backend; content.js drives it through the API returned by
 * NovaOverlay.create().
 *
 * Everything is built with DOM APIs (no innerHTML), and all text from captions,
 * the student or the backend is set with textContent.
 */
(function (root) {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";

  // Cute alien SVG for Nova's avatar (static markup, no user content).
  function alienSvg() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 60 60");
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = "width:100%;height:100%;display:block;";
    // Static alien face — safe to use innerHTML here (no user data).
    svg.innerHTML =
      '<ellipse cx="30" cy="36" rx="19" ry="20" fill="#7ee8a2"/>' +
      '<line x1="22" y1="17" x2="17" y2="7" stroke="#7ee8a2" stroke-width="2.5" stroke-linecap="round"/>' +
      '<circle cx="16" cy="5.5" r="3.5" fill="#c084fc"/>' +
      '<circle cx="16" cy="5.5" r="1.5" fill="#f0e6ff"/>' +
      '<line x1="38" y1="17" x2="43" y2="7" stroke="#7ee8a2" stroke-width="2.5" stroke-linecap="round"/>' +
      '<circle cx="44" cy="5.5" r="3.5" fill="#c084fc"/>' +
      '<circle cx="44" cy="5.5" r="1.5" fill="#f0e6ff"/>' +
      '<ellipse cx="22" cy="34" rx="6.5" ry="7.5" fill="white"/>' +
      '<ellipse cx="38" cy="34" rx="6.5" ry="7.5" fill="white"/>' +
      '<circle cx="23" cy="35" r="4" fill="#1a0533"/>' +
      '<circle cx="39" cy="35" r="4" fill="#1a0533"/>' +
      '<circle cx="24.5" cy="33" r="1.4" fill="white"/>' +
      '<circle cx="40.5" cy="33" r="1.4" fill="white"/>' +
      '<path d="M23 44 Q30 50 37 44" stroke="#2d6a4f" stroke-width="2.2" stroke-linecap="round" fill="none"/>' +
      '<ellipse cx="16" cy="41" rx="3.2" ry="1.9" fill="rgba(192,132,252,0.45)"/>' +
      '<ellipse cx="44" cy="41" rx="3.2" ry="1.9" fill="rgba(192,132,252,0.45)"/>';
    return svg;
  }

  // Icon paths (24x24, stroked).
  const ICONS = {
    list: ["M8 6h12", "M8 12h12", "M8 18h12", "M4 6h.01", "M4 12h.01", "M4 18h.01"],
    minimize: ["M6 12h12"],
    more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
    play: ["M6 4l14 8-14 8z"],
    captions: [
      "M3 7a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z",
      "M7 12h3",
      "M13 12h4",
      "M7 15.5h6",
      "M16 15.5h1",
    ],
    send: ["M21 3 10 14", "M21 3l-7 18-4-7-7-4z"],
    download: ["M12 4v11", "M7 10l5 5 5-5", "M5 20h14"],
    refresh: ["M20 11a8 8 0 1 0-2.3 5.7", "M20 4v7h-7"],
    plus: ["M12 5v14", "M5 12h14"],
    chat: ["M4 5h16v11H9l-5 4z"],
    trash: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"],
    info: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 16v-5", "M12 8h.01"],
    check: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M8 12.5l2.5 2.5L16 9.5"],
    warn: ["M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z", "M12 10v4", "M12 17h.01"],
    mic: ["M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z", "M5 11a7 7 0 0 0 14 0", "M12 18v3"],
    speaker: ["M4 9v6h4l5 4V5L8 9z", "M16.5 8.5a5 5 0 0 1 0 7", "M19 6a8.5 8.5 0 0 1 0 12"],
    mute: ["M4 9v6h4l5 4V5L8 9z", "M17 9.5l5 5", "M22 9.5l-5 5"],
    stop: ["M7 7h10v10H7z"],
  };

  // The overlay currently on the page; used by the keyboard guard.
  let active = null;

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value == null || value === false) continue;
        if (key === "class") el.className = value;
        else if (key === "text") el.textContent = value;
        else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
        else el.setAttribute(key, value === true ? "" : String(value));
      }
    }
    for (const child of children.flat()) {
      if (child != null && child !== false) el.append(child);
    }
    return el;
  }

  function icon(name, cls) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", name === "more" ? "3" : "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    if (cls) svg.setAttribute("class", cls);
    for (const d of ICONS[name]) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  }

  /**
   * Panopto binds keyboard shortcuts (space = play/pause, arrows = seek, ...).
   * Key events from inside a shadow root reach the page retargeted to our host
   * element, so Panopto can't tell the student is typing. This capture listener
   * on window must be installed before Panopto's own listeners (content.js runs
   * at document_start), and it stops key events that start inside Nova from
   * reaching the page. Stopping propagation doesn't cancel default actions, so
   * typing still works and Enter still submits the form.
   */
  function installKeyGuard() {
    if (root.__novaKeyGuardInstalled) return;
    root.__novaKeyGuardInstalled = true;
    const guard = (event) => {
      if (!active || !event.composedPath().includes(active.host)) return;
      event.stopImmediatePropagation();
      if (event.type === "keydown") active.onKey(event);
    };
    for (const type of ["keydown", "keypress", "keyup"]) {
      window.addEventListener(type, guard, true);
    }
  }

  async function loadStyles(shadow, cssUrl) {
    let css = "";
    try {
      css = await (await fetch(cssUrl)).text();
    } catch (err) {
      console.warn("[Nova] Could not load overlay.css", err);
      return;
    }
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet];
    } catch (_) {
      shadow.prepend(h("style", { text: css }));
    }
  }

  /**
   * @param {object} opts
   * @param {string} opts.cssUrl     chrome.runtime.getURL("overlay.css")
   * @param {string} opts.mascotUrl  chrome.runtime.getURL("icons/nova.png")
   * @param {number} opts.windowSeconds  caption window shown in the strip
   * @param {(text: string, source: "input"|"chip") => void} opts.onSend
   * @param {() => void} opts.onDownload
   * @param {() => void} opts.onReloadCaptions
   * @param {() => void} opts.onClearChat
   * @param {() => void} opts.onNewChat
   * @param {() => void} opts.onSummarize  "Summarize lecture" picked in the menu
   * @param {(format: "md"|"html") => void} opts.onExportNotes  "Export notes" picked in the menu
   * @param {(id: string) => void} opts.onSwitchChat
   * @param {(msg: object) => void} opts.onExplain  "Explain in depth" clicked on an Nova reply
   * @param {{code:string,label:string}[]} opts.subtitleLanguages
   * @param {(code: string|null) => void} opts.onSubtitleLanguage
   * @param {(mode: "translated"|"dual") => void} opts.onSubtitleMode
   * @param {(on: boolean) => void} opts.onVoiceToggle  called inside the click (needed to unlock audio)
   * @param {(mode: "muted"|"lowered") => void} opts.onOriginalAudio  professor's audio while voice is on
   * @param {() => void} opts.onRetryTranslation
   * @param {() => void} opts.onLayoutChange  card shown/hidden/minimized/restored
   * @param {(seconds: number) => void} opts.onSeek
   * @param {(on: boolean) => void} opts.onToggleVoice  header speaker button
   * @param {() => void} opts.onMic  composer mic button (push-to-talk)
   * @param {() => void} opts.onStopSpeaking
   * @param {() => void} opts.onOpenTopics  the Hot topics view was opened
   * @param {() => void} opts.onRefreshTopics  "Refresh" pressed in the Hot topics view
   */
  function create(opts) {
    const o = Object.assign(
      {
        windowSeconds: 90,
        welcome: "Hey! I'm Nova. I'm following along with this lecture. Ask me anything about what was just said, or say \"Hey Nova\".",
        placeholder: "Ask about what was just said...",
        footer: "Nova can make mistakes. Check important details.",
        onToggleVoice() {},
        onMic() {},
        onStopSpeaking() {},
        onSend() {},
        onDownload() {},
        onReloadCaptions() {},
        onClearChat() {},
        onNewChat() {},
        onSummarize() {},
        onExportNotes() {},
        onSwitchChat() {},
        onSeek() {},
        onExplain() {},
        subtitleLanguages: [],
        onSubtitleLanguage() {},
        onSubtitleMode() {},
        onVoiceToggle() {},
        onOriginalAudio() {},
        onRetryTranslation() {},
        onLayoutChange() {},
        onOpenTopics() {},
        onRefreshTopics() {},
      },
      opts
    );

    // A custom tag name so no page selector like "div { ... }" matches the host.
    const host = document.createElement("nova-overlay");
    host.style.cssText =
      "all: initial !important; display: block !important; position: fixed !important;" +
      "left: 0 !important; bottom: 0 !important; width: 0 !important; height: 0 !important;" +
      "z-index: 2147483647 !important; visibility: hidden !important;";
    const shadow = host.attachShadow({ mode: "open" });

    // ---- Build the DOM -------------------------------------------------------
    const avatar = (size) => {
      const el = h("span", { class: `avatar avatar--${size}`, "aria-hidden": "true" });
      el.append(alienSvg());
      return el;
    };

    const statusText = h("span", { class: "status-text", text: "Looking for the video…" });
    const status = h("div", { class: "status", "data-state": "waiting" }, h("span", { class: "dot" }), statusText);
    const title = h("h2", { class: "title", text: "Ask Nova" });

    const menuTitle = h("div", { class: "menu-title", text: "—" });
    const menuId = h("div", { class: "menu-id", text: "—" });
    const menuItem = (iconName, label, action) =>
      h("button", { class: "menu-item", type: "button", role: "menuitem", "data-action": action }, icon(iconName), h("span", { text: label }));
    const downloadItem = menuItem("download", "Download captions JSON", "download");
    const reloadItem = menuItem("refresh", "Reload captions", "reload");
    const newChatItem = menuItem("plus", "New chat", "newchat");
    const summarizeItem = menuItem("list", "Summarize lecture", "summarize");
    summarizeItem.disabled = true;
    const notesMdItem = menuItem("download", "Export notes (Markdown)", "notes-md");
    const notesHtmlItem = menuItem("download", "Export notes (web page / PDF)", "notes-html");
    const clearItem = menuItem("trash", "Delete this chat", "clear");
    const chatList = h("div", { class: "menu-chats" });
    const subtitlesItem = menuItem("captions", "Subtitles…", "subtitles");
    downloadItem.disabled = true;
    const menu = h(
      "div",
      { class: "menu", role: "menu", hidden: true },
      h("div", { class: "menu-info" }, h("div", { class: "menu-label", text: "This lecture" }), menuTitle, menuId),
      newChatItem,
      chatList,
      summarizeItem,
      notesMdItem,
      notesHtmlItem,
      subtitlesItem,
      downloadItem,
      reloadItem,
      clearItem
    );
    const menuBtn = h(
      "button",
      { class: "icon-btn", type: "button", "aria-label": "More options", "aria-haspopup": "menu", "aria-expanded": "false", title: "More" },
      icon("more")
    );
    const minBtn = h("button", { class: "icon-btn", type: "button", "aria-label": "Minimize Nova", title: "Minimize" }, icon("minimize"));
    const voiceBtn = h(
      "button",
      { class: "icon-btn voice-toggle", type: "button", "aria-pressed": "true", "data-on": "true", "aria-label": "Voice replies on", title: "Voice replies on (click for text only)" },
      icon("speaker", "icon-on"),
      icon("mute", "icon-off")
    );

    const header = h(
      "header",
      { class: "header" },
      avatar("lg"),
      h("div", { class: "heading" }, title, status),
      h("div", { class: "header-actions" }, voiceBtn, menuBtn, minBtn),
      menu
    );

    const contextText = h("span", { class: "ctx-text", text: `Using the last ${o.windowSeconds} seconds of captions` });

    // ---- Translated subtitles: strip button + popover ------------------------
    const shortCode = (code) => String(code).split("-")[0].toUpperCase();
    function planet() {
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      const body = document.createElementNS(SVG_NS, "circle");
      for (const [k, v] of Object.entries({ cx: 12, cy: 12, r: 4.6, fill: "#a78bfa" })) body.setAttribute(k, v);
      const ring = document.createElementNS(SVG_NS, "g");
      ring.setAttribute("class", "ring");
      const ellipse = document.createElementNS(SVG_NS, "ellipse");
      for (const [k, v] of Object.entries({ cx: 12, cy: 12, rx: 10, ry: 3.6, fill: "none", stroke: "#a78bfa", "stroke-width": 1.6, transform: "rotate(-24 12 12)" }))
        ellipse.setAttribute(k, v);
      ring.append(ellipse);
      svg.append(body, ring);
      return h("span", { class: "mini-planet" }, svg);
    }
    function progressRing(pct) {
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("viewBox", "0 0 16 16");
      svg.setAttribute("class", "prog-ring");
      svg.setAttribute("aria-hidden", "true");
      const c = 2 * Math.PI * 6;
      for (const [stroke, offset] of [["rgba(167,139,250,.25)", 0], ["#67e8f9", c * (1 - pct / 100)]]) {
        const circle = document.createElementNS(SVG_NS, "circle");
        for (const [k, v] of Object.entries({ cx: 8, cy: 8, r: 6, stroke, "stroke-dasharray": c, "stroke-dashoffset": offset }))
          circle.setAttribute(k, v);
        svg.append(circle);
      }
      return svg;
    }

    const sub = { language: null, mode: "translated", voice: false, originalAudio: "muted", progress: null, states: {}, voiceNote: "", voiceWarn: false, canVoice: true };
    const subBtn = h("button", { class: "sub-btn off", type: "button", "aria-haspopup": "dialog", "aria-expanded": "false" });
    const langList = h("div", { class: "sub-langs", role: "radiogroup", "aria-label": "Subtitle language" });
    const modeTranslated = h("button", { type: "button", "data-mode": "translated", text: "Translated" });
    const modeDual = h("button", { type: "button", "data-mode": "dual", text: "Dual", title: "The professor's original line above the translation" });
    const modes = h("div", { class: "sub-modes", role: "group", "aria-label": "Subtitle mode" }, modeTranslated, modeDual);
    const voiceSwitch = h("button", { class: "switch", type: "button", role: "switch", "aria-checked": "false", "aria-label": "Spoken translation" });
    const voiceNote = h("span", { class: "voice-note" });
    const audioMuted = h("button", { type: "button", "data-audio": "muted", text: "Muted", title: "Only Nova's voice is heard" });
    const audioLowered = h("button", { type: "button", "data-audio": "lowered", text: "Lowered", title: "The professor stays audible, quietly" });
    const audioModes = h("div", { class: "audio-modes", role: "group", "aria-label": "Professor's audio" }, audioMuted, audioLowered);
    const audioRow = h("div", { class: "audio-row", hidden: true }, h("span", { text: "Professor's audio" }), audioModes);
    const voiceRow = h(
      "div",
      { class: "voice-row" },
      h(
        "div",
        { class: "voice-main" },
        h("div", { class: "voice-text" }, h("b", { text: "🔊 Spoken translation" }), voiceNote),
        voiceSwitch
      ),
      audioRow
    );
    const progressText = h("span", { class: "sub-progress-text" });
    const progressFill = h("i");
    const retryBtn = h("button", { class: "sub-retry", type: "button", text: "Retry", hidden: true });
    const progress = h(
      "div",
      { class: "sub-progress" },
      h("div", { class: "sub-progress-row" }, progressText, retryBtn),
      h("div", { class: "sub-bar" }, progressFill)
    );
    const pop = h(
      "div",
      { class: "sub-pop", role: "dialog", "aria-label": "Translated subtitles", hidden: true },
      h("h4", { text: "Translated subtitles" }),
      h("p", { class: "sub-intro", text: "Nova translates the captions and shows them over the video." }),
      langList,
      h("div", { class: "sub-divider" }),
      modes,
      voiceRow,
      progress,
      h("p", { class: "sub-foot", text: "Panopto's own captions stay as they are; use its CC button." })
    );
    // The banner text is gone, but the strip stays: it holds the subtitles button and popover.
    // ---- Hot topics: strip pill + a view that swaps in for the chat ----------------
    const topicsBtn = h(
      "button",
      { class: "topics-btn", type: "button", "aria-label": "Hot topics in this lecture", title: "What students ask about most" },
      h("span", { class: "topics-flame", "aria-hidden": "true", text: "🔥" }),
      h("span", { text: "Hot topics" })
    );
    const contextStrip = h("div", { class: "context" }, topicsBtn, h("span", { class: "ctx-text" }), subBtn, pop);

    const topicsBack = h("button", { class: "topics-back", type: "button", text: "← Back to chat" });
    const topicsSub = h("p", { class: "topics-sub" });
    const topicsBody = h("div", { class: "topics-body" });
    const topicsUpdated = h("span", { class: "topics-updated" });
    const topicsRefresh = h("button", { class: "topics-refresh", type: "button", text: "↻ Refresh" });
    const topicsView = h(
      "section",
      { class: "topics", "aria-label": "Hot topics in this lecture" },
      h(
        "div",
        { class: "topics-head" },
        topicsBack,
        h("h3", { class: "topics-title" }, h("span", { "aria-hidden": "true", text: "🔥 " }), "Hot topics in this lecture"),
        topicsSub
      ),
      topicsBody,
      h("div", { class: "topics-foot" }, topicsUpdated, topicsRefresh)
    );

    function setPopOpen(open) {
      pop.hidden = !open;
      subBtn.setAttribute("aria-expanded", String(open));
    }

    function renderSubtitleControls() {
      const lang = o.subtitleLanguages.find((l) => l.code === sub.language) || null;
      const p = sub.progress;
      const pct = p && p.total ? Math.floor((p.done / p.total) * 100) : 0;
      const translating = Boolean(lang && p && p.active);

      subBtn.className = `sub-btn ${lang ? "on" : "off"}${translating ? " busy" : ""}`;
      const parts = [planet()];
      if (!lang) parts.push(h("span", { text: "Subtitles: Off" }));
      else if (translating) parts.push(h("span", { text: shortCode(lang.code) }), progressRing(pct), h("span", { text: `${pct}%` }));
      else parts.push(h("span", { text: `${shortCode(lang.code)} · ${sub.voice ? "🔊 Voice" : sub.mode === "dual" ? "Dual" : "Translated"}` }));
      parts.push(h("span", { class: "chev", "aria-hidden": "true", text: "▾" }));
      subBtn.replaceChildren(...parts);
      subBtn.setAttribute("aria-label", lang ? `Translated subtitles: ${lang.label}` : "Translated subtitles: off");

      langList.replaceChildren(
        ...[{ code: null, label: "Off" }, ...o.subtitleLanguages].map((l) => {
          const checked = (l.code || null) === (sub.language || null);
          const state = !l.code ? "" : checked ? (translating ? `${pct}%` : "On") : sub.states[l.code] || "";
          return h(
            "button",
            { class: "sub-opt", type: "button", role: "radio", "aria-checked": String(checked), "data-code": l.code || "" },
            h("span", { class: "sub-code", text: l.code ? shortCode(l.code) : "" }),
            h("span", { class: "sub-label", text: l.label }),
            h("span", { class: "sub-state", text: state })
          );
        })
      );
      for (const b of [modeTranslated, modeDual]) {
        b.setAttribute("aria-pressed", String(b.dataset.mode === sub.mode));
        b.disabled = !lang;
      }
      voiceSwitch.disabled = !lang || !sub.canVoice;
      voiceSwitch.setAttribute("aria-checked", String(Boolean(lang && sub.voice)));
      audioRow.hidden = !(lang && sub.voice);
      for (const b of [audioMuted, audioLowered]) b.setAttribute("aria-pressed", String(b.dataset.audio === sub.originalAudio));
      voiceNote.textContent = sub.voiceNote;
      voiceNote.classList.toggle("warn", Boolean(sub.voiceWarn));

      progress.hidden = !lang || !p;
      if (lang && p) {
        progressText.textContent =
          p.done >= p.total
            ? "Whole lecture translated"
            : translating
              ? `Translating… ${pct}% of this lecture`
              : p.failed
                ? `${pct}% translated · ${p.failed} line${p.failed === 1 ? "" : "s"} couldn't be translated`
                : `${pct}% translated`;
        progressFill.style.width = `${pct}%`;
        retryBtn.hidden = !(p.failed && !translating);
      }
    }

    subBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      setMenuOpen(false);
      setPopOpen(pop.hidden);
    });
    langList.addEventListener("click", (event) => {
      const opt = event.target.closest(".sub-opt");
      if (opt) o.onSubtitleLanguage(opt.dataset.code || null);
    });
    modes.addEventListener("click", (event) => {
      const b = event.target.closest("button[data-mode]");
      if (b && !b.disabled) o.onSubtitleMode(b.dataset.mode);
    });
    audioModes.addEventListener("click", (event) => {
      const b = event.target.closest("button[data-audio]");
      if (b) o.onOriginalAudio(b.dataset.audio);
    });
    voiceSwitch.addEventListener("click", () => {
      if (!voiceSwitch.disabled) o.onVoiceToggle(!sub.voice);
    });
    retryBtn.addEventListener("click", () => o.onRetryTranslation());

    const messages = h("div", { class: "messages", role: "log", "aria-live": "polite", "aria-label": "Conversation with Nova" });
    const chips = h("div", { class: "chips", role: "group", "aria-label": "Suggested questions" });

    const input = h("input", {
      class: "input",
      type: "text",
      placeholder: o.placeholder,
      "aria-label": "Ask Nova a question",
      maxlength: "1000",
      autocomplete: "off",
      spellcheck: "true",
    });
    const sendBtn = h("button", { class: "send", type: "submit", "aria-label": "Send", title: "Send" }, icon("send"));
    const micBtn = h("button", { class: "mic", type: "button", "aria-label": "Ask by voice", title: "Ask by voice (or say \"Hey Nova\")" }, icon("mic"));
    const composer = h("form", { class: "composer" }, input, micBtn, sendBtn);

    const voiceBarText = h("span", { class: "voice-bar-text", text: "" });
    const voiceBarLabel = h("span", { text: "Stop" });
    const voiceBarBtn = h("button", { class: "voice-bar-btn", type: "button" }, icon("stop"), voiceBarLabel);
    const voiceBar = h(
      "div",
      { class: "voice-bar", hidden: true, role: "status" },
      h("span", { class: "voice-wave", "aria-hidden": "true" }, h("i"), h("i"), h("i"), h("i")),
      voiceBarText,
      voiceBarBtn
    );
    const footer = h("p", { class: "footer", text: o.footer });

    const card = h(
      "section",
      { class: "card", role: "dialog", "aria-label": "Ask Nova" },
      header,
      contextStrip,
      topicsView,
      messages,
      chips,
      voiceBar,
      composer,
      footer
    );
    const launcher = h("button", { class: "launcher", type: "button", "aria-label": "Open Nova", title: "Ask Nova" }, avatar("launch"));
    card.dataset.view = "chat";
    const app = h("div", { class: "nova", "data-minimized": "false" }, card, launcher);
    shadow.append(app);

    // ---- State + behaviour ---------------------------------------------------
    let busy = false;
    const notices = new Map(); // key -> notice element (caption status, subtitle status, ...)
    let typingEl = null;
    let lastStatus = "";
    let baseStatus = { state: "waiting", text: "Looking for the video…" };
    let voiceEnabled = true;
    let voiceState = "idle";

    const VOICE_STATUS = {
      listening: "Listening…",
      transcribing: "Got it, thinking…",
      speaking: "Speaking…",
    };

    /** The status line shows the voice state while there is one, else playback/page status. */
    function renderStatus() {
      const voiceText = VOICE_STATUS[voiceState];
      const next = voiceText ? { state: `voice-${voiceState}`, text: voiceText } : baseStatus;
      if (next.text === lastStatus && status.dataset.state === next.state) return;
      lastStatus = next.text;
      status.dataset.state = next.state;
      statusText.textContent = next.text;
      // Cascade flip (raise from split-flap challenger).
      statusText.classList.remove("flip");
      requestAnimationFrame(() => statusText.classList.add("flip"));
    }

    function renderVoiceBar() {
      app.dataset.voice = voiceState;
      micBtn.dataset.active = String(voiceState === "listening");
      micBtn.setAttribute("aria-label", voiceState === "listening" ? "Stop listening" : "Ask by voice");
      const bar = {
        listening: ["Listening… ask your question", "Cancel"],
        transcribing: ["Transcribing…", null],
        speaking: ["Nova is speaking", "Stop"],
      }[voiceState];
      voiceBar.hidden = !bar;
      if (!bar) return;
      voiceBarText.textContent = bar[0];
      voiceBarBtn.hidden = !bar[1];
      if (bar[1]) voiceBarLabel.textContent = bar[1];
    }

    function scrollToBottom() {
      requestAnimationFrame(() => {
        messages.scrollTop = messages.scrollHeight;
      });
    }

    function updateSendState() {
      const ready = input.value.trim().length > 0 && !busy;
      sendBtn.dataset.ready = String(ready);
      sendBtn.disabled = busy;
    }

    function setMenuOpen(open) {
      menu.hidden = !open;
      menuBtn.setAttribute("aria-expanded", String(open));
    }

    function submit(text, source) {
      const value = String(text || "").trim();
      if (!value || busy) return;
      o.onSend(value, source);
    }

    composer.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = input.value;
      if (!value.trim() || busy) return;
      if (card.dataset.view === "topics") setView("chat"); // asking from Hot topics goes back to the chat
      input.value = "";
      updateSendState();
      submit(value, "input");
    });
    input.addEventListener("input", updateSendState);

    chips.addEventListener("click", (event) => {
      const chip = event.target.closest(".chip");
      if (chip && !chip.disabled) submit(chip.dataset.question, "chip");
    });
    // Let a normal (vertical) mouse wheel scroll the chip row sideways.
    chips.addEventListener(
      "wheel",
      (event) => {
        if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && chips.scrollWidth > chips.clientWidth) {
          chips.scrollLeft += event.deltaY;
          event.preventDefault();
        }
      },
      { passive: false }
    );

    menuBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      setMenuOpen(menu.hidden);
    });
    menu.addEventListener("click", (event) => {
      const item = event.target.closest(".menu-item");
      if (!item || item.disabled) return;
      setMenuOpen(false);
      if (item.dataset.action === "download") o.onDownload();
      if (item.dataset.action === "reload") o.onReloadCaptions();
      if (item.dataset.action === "clear") o.onClearChat();
      if (item.dataset.action === "newchat") o.onNewChat();
      if (item.dataset.action === "summarize") o.onSummarize();
      if (item.dataset.action === "notes-md") o.onExportNotes("md");
      if (item.dataset.action === "notes-html") o.onExportNotes("html");
      if (item.dataset.action === "chat") o.onSwitchChat(item.dataset.id);
      if (item.dataset.action === "subtitles") setPopOpen(true);
    });
    // Close the menu / subtitles popover on any click outside them (inside or outside the overlay).
    shadow.addEventListener("click", (event) => {
      const path = event.composedPath();
      if (!menu.hidden && !path.includes(menu)) setMenuOpen(false);
      if (!pop.hidden && !path.includes(pop) && !path.includes(subBtn) && !path.includes(subtitlesItem)) setPopOpen(false);
    });
    document.addEventListener("click", (event) => {
      if (event.composedPath().includes(host)) return;
      if (!menu.hidden) setMenuOpen(false);
      if (!pop.hidden) setPopOpen(false);
    });

    voiceBtn.addEventListener("click", () => o.onToggleVoice(!voiceEnabled));
    micBtn.addEventListener("click", () => o.onMic());
    voiceBarBtn.addEventListener("click", () => {
      if (voiceState === "listening") o.onMic(); // toggles listening off
      else o.onStopSpeaking();
    });

    minBtn.addEventListener("click", () => api.minimize());
    launcher.addEventListener("click", () => api.restore());

    // ---- Markdown parser ------------------------------------------------------
    // Blocks: "- " / "• " bullets → <ul>, "1." lines → <ol>, other lines → <p>.
    // Inline: ***bold-italic***, **bold**, *italic*, `code`. DOM-built, no innerHTML.
    const BULLET_RE = /^\s*[-•]\s+(.*)$/;
    const NUMBERED_RE = /^\s*\d+[.)]\s+(.*)$/;

    function parseMd(text) {
      const lines = String(text || "").split("\n");
      // Plain text (no list lines) keeps the old pre-wrap inline rendering.
      if (!lines.some((l) => BULLET_RE.test(l) || NUMBERED_RE.test(l))) return parseInline(text);
      const frag = document.createDocumentFragment();
      let list = null; // { kind: "ul"|"ol", el }
      for (const line of lines) {
        const b = BULLET_RE.exec(line);
        const n = b ? null : NUMBERED_RE.exec(line);
        const kind = b ? "ul" : n ? "ol" : null;
        if (kind) {
          if (!list || list.kind !== kind) {
            list = { kind, el: document.createElement(kind) };
            list.el.className = "md-list";
            frag.append(list.el);
          }
          const li = document.createElement("li");
          li.append(parseInline((b || n)[1]));
          list.el.append(li);
          continue;
        }
        list = null;
        if (!line.trim()) continue;
        const p = document.createElement("p");
        p.className = "md-p";
        p.append(parseInline(line));
        frag.append(p);
      }
      return frag;
    }

    function parseInline(text) {
      const frag = document.createDocumentFragment();
      const re = /(`([^`]+)`|\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*]+)\*)/g;
      let last = 0, m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) frag.append(document.createTextNode(text.slice(last, m.index)));
        if (m[2] !== undefined) {
          const code = document.createElement("code");
          code.className = "md-code";
          code.textContent = m[2];
          frag.append(code);
        } else if (m[3] !== undefined) {
          const strong = document.createElement("strong");
          const em = document.createElement("em");
          em.textContent = m[3];
          strong.append(em);
          frag.append(strong);
        } else if (m[4] !== undefined) {
          const strong = document.createElement("strong");
          strong.textContent = m[4];
          frag.append(strong);
        } else if (m[5] !== undefined) {
          const em = document.createElement("em");
          em.textContent = m[5];
          frag.append(em);
        }
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
      return frag;
    }

    // ---- Message rendering ---------------------------------------------------
    function messageRow(msg) {
      const role = msg.role === "student" ? "student" : "nova";
      const bubbleText = h("span", { class: "bubble-text" });
      bubbleText.append(parseMd(msg.text));
      const bubble = h("div", { class: "bubble" }, bubbleText);
      if (msg.stub) bubble.append(h("span", { class: "tag", text: "Demo reply (stub mode)" }));
      // msg.watch: one { start, end, label } (older saved chats) or a ranked array.
      const watches = Array.isArray(msg.watch) ? msg.watch : msg.watch ? [msg.watch] : [];
      const fmt = root.NovaSRT ? root.NovaSRT.formatTime : (t) => String(Math.floor(t));
      watches.forEach(({ start, end, label }, i) => {
        const timeStr = end && end !== start ? `${fmt(start)} – ${fmt(end)}` : fmt(start);
        const top = watches.length > 1 && i === 0;
        bubble.append(
          h(
            "button",
            {
              class: `watch-btn${top ? " watch-btn--top" : ""}`,
              type: "button",
              title: `Jump to ${fmt(start)}`,
              "aria-label": `Jump to ${timeStr}${label ? `, ${label}` : ""}`,
              onclick: () => o.onSeek(start),
            },
            icon("play", "watch-play-icon"),
            h("span", { class: "watch-btn-time", text: timeStr }),
            label ? h("span", { class: "watch-btn-label", text: label }) : null,
            top ? h("span", { class: "watch-btn-badge", text: "Most relevant" }) : null
          )
        );
      });
      if (Array.isArray(msg.chapters) && msg.chapters.length) {
        bubble.append(
          h(
            "div",
            { class: "chapters", role: "list", "aria-label": "Chapters" },
            h("div", { class: "chapters-label", text: "Chapters" }),
            ...msg.chapters.map((c) =>
              h(
                "button",
                { class: "chapter-btn", type: "button", role: "listitem", onclick: () => o.onSeek(c.start) },
                h("span", { class: "chapter-time", text: fmt(c.start) }),
                h("span", { class: "chapter-title", text: c.title })
              )
            )
          )
        );
      } else if (role === "nova" && !msg.error && !msg.local && msg.at) {
        // Opens the whiteboard lesson tab (onExplain is wired up in content.js).
        bubble.append(
          h("button", { class: "deep-dive-btn", type: "button", onclick: () => o.onExplain(msg) }, "Deep Dive")
        );
      }
      const row = h("div", { class: `msg msg--${role}${msg.error ? " msg--error" : ""}` });
      if (role === "nova") row.append(avatar("sm"));
      row.append(bubble);
      return row;
    }

    function appendRow(row) {
      // Keep the typing indicator as the last row while it is visible.
      if (typingEl && typingEl.isConnected) messages.insertBefore(row, typingEl);
      else messages.append(row);
      scrollToBottom();
    }

    function renderChips(list) {
      chips.replaceChildren(
        ...list.map((q) => h("button", { class: "chip", type: "button", "data-question": q, text: q, disabled: busy }))
      );
      chips.hidden = list.length === 0;
    }

    // ---- Hot topics view --------------------------------------------------------
    function setView(view) {
      card.dataset.view = view;
      topicsBtn.setAttribute("aria-pressed", String(view === "topics"));
      if (view === "chat") scrollToBottom();
    }

    function ago(epochSeconds) {
      const mins = Math.max(0, Math.round((Date.now() / 1000 - epochSeconds) / 60));
      if (mins < 1) return "just now";
      if (mins < 60) return `${mins} min ago`;
      const hours = Math.round(mins / 60);
      return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
    }

    function topicCard(t, i, maxCount) {
      const fmt = root.NovaSRT ? root.NovaSRT.formatTime : (x) => String(Math.floor(x));
      const heat = h("div", { class: "topic-heat" }, h("i"));
      heat.firstChild.style.width = `${Math.max(8, Math.round((t.count / maxCount) * 100))}%`;
      const item = h(
        "article",
        { class: "topic" },
        h(
          "div",
          { class: "topic-head" },
          h("span", { class: "topic-rank", text: String(i + 1) }),
          h("h4", { class: "topic-name", text: t.title }),
          h("span", { class: "topic-count", text: `${t.count} question${t.count === 1 ? "" : "s"}` })
        ),
        heat,
        t.summary ? h("p", { class: "topic-summary", text: t.summary }) : null,
        h(
          "div",
          { class: "topic-actions" },
          h("button", { class: "topic-seek", type: "button", title: "Jump to this part of the lecture", onclick: () => o.onSeek(t.time) }, `▶ ${fmt(t.time)}`),
          // Opens the whiteboard lesson on this theme (same path as Deep Dive on a reply).
          h(
            "button",
            {
              class: "topic-teach",
              type: "button",
              title: "Open a whiteboard lesson on this topic",
              onclick: () => o.onExplain({ question: `Teach me: ${t.title}`, text: t.summary || t.title, time: t.time }),
            },
            "🎓 Teach me this"
          )
        )
      );
      if (t.examples && t.examples.length) {
        item.append(h("ul", { class: "topic-examples" }, t.examples.map((e) => h("li", { text: e }))));
      }
      return item;
    }

    topicsBtn.addEventListener("click", () => {
      setMenuOpen(false);
      setPopOpen(false);
      if (card.dataset.view === "topics") return setView("chat");
      setView("topics");
      topicsBack.focus({ preventScroll: true }); // keyboard focus moves into the view (Escape goes back)
      o.onOpenTopics();
    });
    /** Count question times into equal slices of the lecture. Pure, so it's easy to reason about. */
    function bucketTimes(times, duration, maxBars = 24) {
      const end = Math.max(Number(duration) || 0, ...times.map((x) => x + 1), 60);
      const bars = Math.min(maxBars, Math.max(6, Math.ceil(end / 60)));
      const size = end / bars;
      const counts = new Array(bars).fill(0);
      for (const x of times) counts[Math.min(bars - 1, Math.floor(x / size))]++;
      return { counts, size, end };
    }

    /** "Where students get stuck": questions per slice of the lecture. Click a bar to jump there. */
    function timelineCard(times, duration) {
      const fmt = root.NovaSRT ? root.NovaSRT.formatTime : (x) => String(Math.floor(x));
      const { counts, size, end } = bucketTimes(times, duration);
      const peak = Math.max(...counts);
      const bars = counts.map((n, i) => {
        const from = i * size;
        const bar = h("button", {
          class: "tl-bar" + (n === peak && n > 0 ? " peak" : ""),
          type: "button",
          title: `${fmt(from)}–${fmt(Math.min(end, from + size))}: ${n} question${n === 1 ? "" : "s"}`,
          "aria-label": `${fmt(from)}, ${n} question${n === 1 ? "" : "s"}. Jump here`,
          onclick: () => o.onSeek(from),
        }, h("i"));
        bar.firstChild.style.height = n ? `${Math.max(8, Math.round((n / peak) * 100))}%` : "3px";
        return bar;
      });
      const at = counts.indexOf(peak);
      return h(
        "section",
        { class: "timeline", "aria-label": "Questions across the lecture" },
        h("h4", { class: "tl-title", text: "Where students get stuck" }),
        h("p", { class: "tl-peak", text: `Most questions: ${fmt(at * size)}–${fmt(Math.min(end, (at + 1) * size))} (${peak})` }),
        h("div", { class: "tl-bars" }, bars),
        h("div", { class: "tl-axis" }, h("span", { text: fmt(0) }), h("span", { text: fmt(end / 2) }), h("span", { text: fmt(end) }))
      );
    }

    topicsBack.addEventListener("click", () => setView("chat"));
    topicsRefresh.addEventListener("click", () => o.onRefreshTopics());

    function onKey(event) {
      if (event.key !== "Escape") return;
      if (card.dataset.view === "topics" && pop.hidden && menu.hidden) {
        setView("chat");
        topicsBtn.focus();
        return;
      }
      if (!pop.hidden) {
        setPopOpen(false);
        subBtn.focus();
      } else if (!menu.hidden) {
        setMenuOpen(false);
        menuBtn.focus();
      }
    }

    // ---- Public API ----------------------------------------------------------
    const api = {
      host,

      /** Attach to the page and load styles. Resolves once the card is styled. */
      async mount() {
        (document.documentElement || document.body).appendChild(host);
        active = { host, onKey };
        await loadStyles(shadow, o.cssUrl);
        host.style.setProperty("visibility", "visible", "important");
        this.probeMascot();
        updateSendState();
        renderSubtitleControls();
      },

      /** Use icons/nova.png if it exists; otherwise avatars stay plain green circles. */
      probeMascot() {
        if (!o.mascotUrl) return;
        const img = new Image();
        img.onload = () => {
          app.style.setProperty("--nova-mascot", `url("${o.mascotUrl}")`);
          app.classList.add("has-mascot");
        };
        img.onerror = () => console.info("[Nova] icons/nova.png not found, using a plain avatar");
        img.src = o.mascotUrl;
      },

      // Visibility (toolbar button) is separate from minimized (the card's own button).
      isVisible: () => !app.hidden,
      show() {
        app.hidden = false;
        api.restore();
      },
      hide() {
        setMenuOpen(false);
        setPopOpen(false);
        app.hidden = true;
        o.onLayoutChange();
      },
      toggleVisible() {
        if (app.hidden) api.show();
        else api.hide();
        return !app.hidden;
      },
      minimize() {
        setMenuOpen(false);
        setPopOpen(false);
        app.dataset.minimized = "true";
        launcher.focus({ preventScroll: true });
        o.onLayoutChange();
      },
      restore() {
        app.dataset.minimized = "false";
        scrollToBottom();
        o.onLayoutChange();
      },

      /** The open card's rectangle on screen, or null when it's minimized or hidden. */
      getCardRect() {
        if (app.hidden || app.dataset.minimized === "true" || !card.isConnected) return null;
        const r = card.getBoundingClientRect();
        return r.width ? r : null;
      },

      /** Update the subtitle controls. Pass any of: language, mode, voice, progress, states, voiceNote, voiceWarn, canVoice. */
      setSubtitles(partial) {
        Object.assign(sub, partial);
        renderSubtitleControls();
      },

      showChat: () => setView("chat"),
      showTopics() {
        api.restore();
        setView("topics");
        o.onOpenTopics();
      },
      isTopicsOpen: () => card.dataset.view === "topics",

      /**
       * Fill the Hot topics view.
       * state: "loading" | "ready" | "empty" | "error"
       * topics: [{ title, summary, count, time, examples }], total: questions asked, updatedAt: epoch seconds
       * times: video seconds of every question (draws the timeline), duration: lecture length in seconds
       */
      setTopics({ state, topics = [], total = 0, updatedAt = null, error = "", times = [], duration = 0 } = {}) {
        topicsRefresh.disabled = state === "loading";
        topicsUpdated.textContent = updatedAt && state === "ready" ? `Updated ${ago(updatedAt)}` : "";
        if (state === "loading") {
          topicsSub.textContent = "";
          topicsBody.replaceChildren(h("div", { class: "topics-state" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { text: "Finding what students ask about most…" })));
        } else if (state === "empty") {
          topicsSub.textContent = "";
          topicsBody.replaceChildren(
            h(
              "div",
              { class: "topics-state topics-empty" },
              h("b", { text: "No questions yet" }),
              h("span", { text: "When students ask Nova about this lecture, the most common topics show up here." })
            )
          );
        } else if (state === "error") {
          topicsSub.textContent = "";
          topicsBody.replaceChildren(
            h(
              "div",
              { class: "topics-state topics-error" },
              h("b", { text: "Couldn't load hot topics" }),
              h("span", { text: error || "The Nova server isn't reachable right now." }),
              h("button", { class: "notice-action", type: "button", text: "Retry", onclick: () => o.onRefreshTopics() })
            )
          );
        } else {
          topicsSub.textContent = `From ${total} question${total === 1 ? "" : "s"} students asked Nova. Example questions are reworded.`;
          const maxCount = Math.max(1, ...topics.map((t) => t.count));
          topicsBody.replaceChildren(...(times.length ? [timelineCard(times, duration)] : []), ...topics.map((t, i) => topicCard(t, i, maxCount)));
        }
      },

      openSubtitles() {
        api.restore();
        setPopOpen(true);
      },

      setLecture({ id, title: lectureTitle }) {
        menuTitle.textContent = lectureTitle || "Untitled lecture";
        menuId.textContent = `ID: ${id}`;
        header.title = `Lecture: ${lectureTitle || "Untitled lecture"}\nID: ${id}`;
      },

      /** state: "waiting" | "playing" | "paused". */
      setPlayback({ state, time }) {
        const fmt = root.NovaSRT ? root.NovaSRT.formatTime : (t) => String(Math.floor(t));
        const text =
          state === "waiting" ? "Looking for the video…" : `${state === "paused" ? "Paused" : "Following"} at ${fmt(time)}`;
        baseStatus = { state, text };
        renderStatus();
      },

      /** Header speaker toggle: true = Nova speaks replies, false = text only. */
      setVoiceEnabled(on) {
        voiceEnabled = Boolean(on);
        voiceBtn.setAttribute("aria-pressed", String(voiceEnabled));
        voiceBtn.dataset.on = String(voiceEnabled);
        voiceBtn.setAttribute("aria-label", voiceEnabled ? "Voice replies on" : "Voice replies off");
        voiceBtn.title = voiceEnabled ? "Voice replies on (click for text only)" : "Text only (click to turn voice on)";
      },

      /** Live words while the student is talking (free speech engine). */
      setVoiceTranscript(text) {
        if (voiceState !== "listening" || !String(text || "").trim()) return;
        voiceBarText.textContent = `“${String(text).trim()}”`;
      },

      /** "idle" | "listening" | "transcribing" | "speaking" */
      setVoiceState(value) {
        voiceState = VOICE_STATUS[value] ? value : "idle";
        renderStatus();
        renderVoiceBar();
      },

      setContextLabel(text) {
        contextText.textContent = text;
      },

      setDownloadEnabled(enabled) {
        downloadItem.disabled = !enabled;
        summarizeItem.disabled = !enabled;
        summarizeItem.title = enabled ? "" : "No captions loaded yet";
        downloadItem.title = enabled ? "" : "No captions loaded yet";
      },

      /** The chats saved for this lecture: { activeId, list: [{ id, title, at }] }, newest first. */
      setSessions({ activeId, list }) {
        const rows = (list || []).slice(0, 5).map((c) => {
          const row = h("button", { class: `menu-item menu-chat${c.id === activeId ? " active" : ""}`, type: "button", role: "menuitem", "data-action": "chat", "data-id": c.id }, icon("chat"), h("span", { text: c.title }));
          row.title = new Date(c.at).toLocaleString();
          return row;
        });
        chatList.replaceChildren(...(rows.length ? [h("div", { class: "menu-label chats-label", text: "Chats" }), ...rows] : []));
      },

      /** Replace the whole conversation (welcome + saved history). Clears any notice. */
      setHistory(history) {
        typingEl = null;
        notices.clear();
        messages.replaceChildren(messageRow({ role: "nova", text: o.welcome }));
        for (const msg of history || []) messages.append(messageRow(msg));
        scrollToBottom();
      },

      /** msg: { role: "student" | "nova", text, stub?, error? } */
      addMessage(msg) {
        appendRow(messageRow(msg));
      },

      /**
       * A status line in the chat (caption loading, errors, ...). Not part of the
       * saved history. kind: "loading" | "info" | "success" | "warn" | "error".
       * key: notices with different keys coexist (e.g. "captions" and "subtitles").
       */
      setNotice({ key = "main", kind = "info", text, detail, actionLabel, onAction } = {}) {
        if (notices.has(key)) notices.get(key).remove();
        const iconName = { success: "check", warn: "warn", error: "warn" }[kind] || "info";
        const lead = kind === "loading" ? h("span", { class: "spinner", "aria-hidden": "true" }) : icon(iconName, "notice-icon");
        const body = h("div", { class: "notice-body" }, h("div", { text }), detail ? h("div", { class: "notice-detail", text: detail }) : null);
        const el = h("div", { class: `notice notice--${kind}`, role: kind === "error" || kind === "warn" ? "alert" : "status" }, lead, body);
        if (actionLabel && onAction) {
          el.append(h("button", { class: "notice-action", type: "button", text: actionLabel, onclick: onAction }));
        }
        notices.set(key, el);
        appendRow(el);
      },

      clearNotice(key = "main") {
        if (notices.has(key)) notices.get(key).remove();
        notices.delete(key);
      },

      showTyping(on) {
        if (on && !typingEl) {
          typingEl = h(
            "div",
            { class: "msg msg--nova msg--typing", "aria-label": "Nova is thinking" },
            avatar("sm"),
            h("div", { class: "bubble typing" }, h("span"), h("span"), h("span"), h("span"), h("span"), h("span"), h("span"))
          );
          messages.append(typingEl);
          scrollToBottom();
        } else if (!on && typingEl) {
          typingEl.remove();
          typingEl = null;
        }
      },

      /** Replace the suggestion chips. Person 2 can call this with chips from /ask. */
      setChips(list) {
        renderChips((Array.isArray(list) ? list : []).map(String).filter((s) => s.trim()));
      },

      setBusy(value) {
        busy = Boolean(value);
        for (const chip of chips.querySelectorAll(".chip")) chip.disabled = busy;
        updateSendState();
      },

      focusInput() {
        input.focus({ preventScroll: true });
      },
    };
    return api;
  }

  root.NovaOverlay = { create, installKeyGuard };
})(globalThis);
