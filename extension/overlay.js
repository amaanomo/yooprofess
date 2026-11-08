/*
 * Nova: the on-page overlay (UI only).
 *
 * Renders the "Ask Nova" card inside a Shadow DOM root so Panopto's CSS can't
 * reach it and ours can't leak out. It knows nothing about captions, video or the
 * backend; content.js drives it through the API returned by NovaOverlay.create().
 *
 * Everything is built with DOM APIs (no innerHTML), and all text from captions,
 * the student or the backend is set with textContent.
 */
(function (root) {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";

  // Icon paths (24x24, stroked).
  const ICONS = {
    minimize: ["M6 12h12"],
    more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
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
   * @param {(id: string) => void} opts.onSwitchChat
   * @param {(msg: object) => void} opts.onExplain  "Explain in depth" clicked on an Nova reply
   * @param {{code:string,label:string}[]} opts.subtitleLanguages
   * @param {(code: string|null) => void} opts.onSubtitleLanguage
   * @param {(mode: "translated"|"dual") => void} opts.onSubtitleMode
   * @param {(on: boolean) => void} opts.onVoiceToggle  called inside the click (needed to unlock audio)
   * @param {(mode: "muted"|"lowered") => void} opts.onOriginalAudio  professor's audio while voice is on
   * @param {() => void} opts.onRetryTranslation
   * @param {() => void} opts.onLayoutChange  card shown/hidden/minimized/restored
   */
  function create(opts) {
    const o = Object.assign(
      {
        windowSeconds: 90,
        welcome: "Hey! I'm Nova. I'm following along with this lecture. Ask me anything about what was just said.",
        placeholder: "Ask about what was just said...",
        footer: "Nova can make mistakes. Check important details.",
        onSend() {},
        onDownload() {},
        onReloadCaptions() {},
        onClearChat() {},
        onNewChat() {},
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
    const avatar = (size) => h("span", { class: `avatar avatar--${size}`, "aria-hidden": "true" });

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

    const header = h(
      "header",
      { class: "header" },
      avatar("lg"),
      h("div", { class: "heading" }, title, status),
      h("div", { class: "header-actions" }, menuBtn, minBtn),
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
      for (const [k, v] of Object.entries({ cx: 12, cy: 12, r: 4.6, fill: "#2e6b57" })) body.setAttribute(k, v);
      const ring = document.createElementNS(SVG_NS, "g");
      ring.setAttribute("class", "ring");
      const ellipse = document.createElementNS(SVG_NS, "ellipse");
      for (const [k, v] of Object.entries({ cx: 12, cy: 12, rx: 10, ry: 3.6, fill: "none", stroke: "#2e6b57", "stroke-width": 1.6, transform: "rotate(-24 12 12)" }))
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
      for (const [stroke, offset] of [["rgba(255,255,255,.3)", 0], ["#c6e86b", c * (1 - pct / 100)]]) {
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
    const contextStrip = h("div", { class: "context" }, h("span", { class: "ctx-text" }), subBtn, pop);

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
    const composer = h("form", { class: "composer" }, input, sendBtn);
    const footer = h("p", { class: "footer", text: o.footer });

    const card = h(
      "section",
      { class: "card", role: "dialog", "aria-label": "Ask Nova" },
      header,
      contextStrip,
      messages,
      chips,
      composer,
      footer
    );
    const launcher = h("button", { class: "launcher", type: "button", "aria-label": "Open Nova", title: "Ask Nova" }, avatar("launch"));
    const app = h("div", { class: "nova", "data-minimized": "false" }, card, launcher);
    shadow.append(app);

    // ---- State + behaviour ---------------------------------------------------
    let busy = false;
    const notices = new Map(); // key -> notice element (caption status, subtitle status, ...)
    let typingEl = null;
    let lastStatus = "";

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

    minBtn.addEventListener("click", () => api.minimize());
    launcher.addEventListener("click", () => api.restore());

    // ---- Markdown parser (***bold-italic***, **bold**, *italic*) -------------
    function parseMd(text) {
      const frag = document.createDocumentFragment();
      const re = /(\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*]+)\*)/g;
      let last = 0, m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) frag.append(document.createTextNode(text.slice(last, m.index)));
        if (m[2] !== undefined) {
          const strong = document.createElement("strong");
          const em = document.createElement("em");
          em.textContent = m[2];
          strong.append(em);
          frag.append(strong);
        } else if (m[3] !== undefined) {
          const strong = document.createElement("strong");
          strong.textContent = m[3];
          frag.append(strong);
        } else if (m[4] !== undefined) {
          const em = document.createElement("em");
          em.textContent = m[4];
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
      if (msg.watch) {
        const { start, end, label } = msg.watch;
        const fmt = root.NovaSRT ? root.NovaSRT.formatTime : (t) => String(Math.floor(t));
        const timeStr = end && end !== start ? `${fmt(start)} – ${fmt(end)}` : fmt(start);
        const watchBtn = h(
          "button",
          { class: "watch-btn", type: "button", onclick: () => o.onSeek(start) },
          h("span", { class: "watch-btn-time", text: `▶ ${timeStr}` }),
          label ? h("span", { class: "watch-btn-label", text: label }) : null
        );
        bubble.append(watchBtn);
      }
      if (role === "nova" && !msg.error && msg.at) {
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

    function onKey(event) {
      if (event.key !== "Escape") return;
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
        if (text === lastStatus && status.dataset.state === state) return;
        lastStatus = text;
        status.dataset.state = state;
        statusText.textContent = text;
      },

      setContextLabel(text) {
        contextText.textContent = text;
      },

      setDownloadEnabled(enabled) {
        downloadItem.disabled = !enabled;
        downloadItem.title = enabled ? "" : "No captions loaded yet";
      },

      /** The chats saved for this lecture: { activeId, list: [{ id, title, at }] }, newest first. */
      setSessions({ activeId, list }) {
        const rows = (list || []).slice(0, 8).map((c) => {
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
            { class: "msg msg--nova msg--typing", "aria-label": "Nova is typing" },
            avatar("sm"),
            h("div", { class: "bubble typing" }, h("span"), h("span"), h("span"))
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
