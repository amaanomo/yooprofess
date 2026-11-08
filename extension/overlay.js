/*
 * Orbit: the on-page overlay (UI only).
 *
 * Renders the "Ask Orbit" card inside a Shadow DOM root so Panopto's CSS can't
 * reach it and ours can't leak out. It knows nothing about captions, video or the
 * backend; content.js drives it through the API returned by OrbitOverlay.create().
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
   * at document_start), and it stops key events that start inside Orbit from
   * reaching the page. Stopping propagation doesn't cancel default actions, so
   * typing still works and Enter still submits the form.
   */
  function installKeyGuard() {
    if (root.__orbitKeyGuardInstalled) return;
    root.__orbitKeyGuardInstalled = true;
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
      console.warn("[Orbit] Could not load overlay.css", err);
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
   * @param {string} opts.mascotUrl  chrome.runtime.getURL("icons/orbit.png")
   * @param {number} opts.windowSeconds  caption window shown in the strip
   * @param {(text: string, source: "input"|"chip") => void} opts.onSend
   * @param {() => void} opts.onDownload
   * @param {() => void} opts.onReloadCaptions
   * @param {() => void} opts.onClearChat
   * @param {(msg: object) => void} opts.onExplain  "Explain in depth" clicked on an Orbit reply
   */
  function create(opts) {
    const o = Object.assign(
      {
        windowSeconds: 90,
        welcome: "Hey! I'm Orbit. I'm following along with this lecture. Ask me anything about what was just said.",
        placeholder: "Ask about what was just said...",
        footer: "Orbit can make mistakes. Check important details.",
        onSend() {},
        onDownload() {},
        onReloadCaptions() {},
        onClearChat() {},
        onSeek() {},
        onExplain() {},
      },
      opts
    );

    // A custom tag name so no page selector like "div { ... }" matches the host.
    const host = document.createElement("orbit-overlay");
    host.style.cssText =
      "all: initial !important; display: block !important; position: fixed !important;" +
      "left: 0 !important; bottom: 0 !important; width: 0 !important; height: 0 !important;" +
      "z-index: 2147483647 !important; visibility: hidden !important;";
    const shadow = host.attachShadow({ mode: "open" });

    // ---- Build the DOM -------------------------------------------------------
    const avatar = (size) => h("span", { class: `avatar avatar--${size}`, "aria-hidden": "true" });

    const statusText = h("span", { class: "status-text", text: "Looking for the video…" });
    const status = h("div", { class: "status", "data-state": "waiting" }, h("span", { class: "dot" }), statusText);
    const title = h("h2", { class: "title", text: "Ask Orbit" });

    const menuTitle = h("div", { class: "menu-title", text: "—" });
    const menuId = h("div", { class: "menu-id", text: "—" });
    const menuItem = (iconName, label, action) =>
      h("button", { class: "menu-item", type: "button", role: "menuitem", "data-action": action }, icon(iconName), h("span", { text: label }));
    const downloadItem = menuItem("download", "Download captions JSON", "download");
    const reloadItem = menuItem("refresh", "Reload captions", "reload");
    const clearItem = menuItem("trash", "Clear chat", "clear");
    downloadItem.disabled = true;
    const menu = h(
      "div",
      { class: "menu", role: "menu", hidden: true },
      h("div", { class: "menu-info" }, h("div", { class: "menu-label", text: "This lecture" }), menuTitle, menuId),
      downloadItem,
      reloadItem,
      clearItem
    );
    const menuBtn = h(
      "button",
      { class: "icon-btn", type: "button", "aria-label": "More options", "aria-haspopup": "menu", "aria-expanded": "false", title: "More" },
      icon("more")
    );
    const minBtn = h("button", { class: "icon-btn", type: "button", "aria-label": "Minimize Orbit", title: "Minimize" }, icon("minimize"));

    const header = h(
      "header",
      { class: "header" },
      avatar("lg"),
      h("div", { class: "heading" }, title, status),
      h("div", { class: "header-actions" }, menuBtn, minBtn),
      menu
    );

    const contextText = h("span", { text: `Using the last ${o.windowSeconds} seconds of captions` });
    const contextStrip = h("div", { class: "context" }, icon("captions"), contextText);

    const messages = h("div", { class: "messages", role: "log", "aria-live": "polite", "aria-label": "Conversation with Orbit" });
    const chips = h("div", { class: "chips", role: "group", "aria-label": "Suggested questions" });

    const input = h("input", {
      class: "input",
      type: "text",
      placeholder: o.placeholder,
      "aria-label": "Ask Orbit a question",
      maxlength: "1000",
      autocomplete: "off",
      spellcheck: "true",
    });
    const sendBtn = h("button", { class: "send", type: "submit", "aria-label": "Send", title: "Send" }, icon("send"));
    const composer = h("form", { class: "composer" }, input, sendBtn);
    const footer = h("p", { class: "footer", text: o.footer });

    const card = h(
      "section",
      { class: "card", role: "dialog", "aria-label": "Ask Orbit" },
      header,
      contextStrip,
      messages,
      chips,
      composer,
      footer
    );
    const launcher = h("button", { class: "launcher", type: "button", "aria-label": "Open Orbit", title: "Ask Orbit" }, avatar("launch"));
    const app = h("div", { class: "orbit", "data-minimized": "false" }, card, launcher);
    shadow.append(app);

    // ---- State + behaviour ---------------------------------------------------
    let busy = false;
    let noticeEl = null;
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
    });
    // Close the menu on any click outside it (inside or outside the overlay).
    shadow.addEventListener("click", (event) => {
      if (!menu.hidden && !event.composedPath().includes(menu)) setMenuOpen(false);
    });
    document.addEventListener("click", (event) => {
      if (!menu.hidden && !event.composedPath().includes(host)) setMenuOpen(false);
    });

    minBtn.addEventListener("click", () => api.minimize());
    launcher.addEventListener("click", () => api.restore());

    // ---- Message rendering ---------------------------------------------------
    function messageRow(msg) {
      const role = msg.role === "student" ? "student" : "orbit";
      const bubble = h("div", { class: "bubble" }, h("span", { class: "bubble-text", text: msg.text }));
      if (msg.stub) bubble.append(h("span", { class: "tag", text: "Demo reply (stub mode)" }));
      if (msg.watch) {
        const { start, end, label } = msg.watch;
        const fmt = root.OrbitSRT ? root.OrbitSRT.formatTime : (t) => String(Math.floor(t));
        const timeStr = end && end !== start ? `${fmt(start)} – ${fmt(end)}` : fmt(start);
        const watchBtn = h(
          "button",
          { class: "watch-btn", type: "button", onclick: () => o.onSeek(start) },
          h("span", { class: "watch-btn-time", text: `▶ ${timeStr}` }),
          label ? h("span", { class: "watch-btn-label", text: label }) : null
        );
        bubble.append(watchBtn);
      }
      if (role === "orbit" && !msg.error) {
        bubble.append(
          h("button", { class: "explain-btn", type: "button", onclick: () => o.onExplain(msg) }, "✎ Explain in depth")
        );
      }
      const row = h("div", { class: `msg msg--${role}${msg.error ? " msg--error" : ""}` });
      if (role === "orbit") row.append(avatar("sm"));
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
      if (event.key === "Escape" && !menu.hidden) {
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
      },

      /** Use icons/orbit.png if it exists; otherwise avatars stay plain green circles. */
      probeMascot() {
        if (!o.mascotUrl) return;
        const img = new Image();
        img.onload = () => {
          app.style.setProperty("--orbit-mascot", `url("${o.mascotUrl}")`);
          app.classList.add("has-mascot");
        };
        img.onerror = () => console.info("[Orbit] icons/orbit.png not found, using a plain avatar");
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
        app.hidden = true;
      },
      toggleVisible() {
        if (app.hidden) api.show();
        else api.hide();
        return !app.hidden;
      },
      minimize() {
        setMenuOpen(false);
        app.dataset.minimized = "true";
        launcher.focus({ preventScroll: true });
      },
      restore() {
        app.dataset.minimized = "false";
        scrollToBottom();
      },

      setLecture({ id, title: lectureTitle }) {
        menuTitle.textContent = lectureTitle || "Untitled lecture";
        menuId.textContent = `ID: ${id}`;
        header.title = `Lecture: ${lectureTitle || "Untitled lecture"}\nID: ${id}`;
      },

      /** state: "waiting" | "playing" | "paused". */
      setPlayback({ state, time }) {
        const fmt = root.OrbitSRT ? root.OrbitSRT.formatTime : (t) => String(Math.floor(t));
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

      /** Replace the whole conversation (welcome + saved history). Clears any notice. */
      setHistory(history) {
        typingEl = null;
        noticeEl = null;
        messages.replaceChildren(messageRow({ role: "orbit", text: o.welcome }));
        for (const msg of history || []) messages.append(messageRow(msg));
        scrollToBottom();
      },

      /** msg: { role: "student" | "orbit", text, stub?, error? } */
      addMessage(msg) {
        appendRow(messageRow(msg));
      },

      /**
       * A status line in the chat (caption loading, errors, ...). Not part of the
       * saved history. kind: "loading" | "info" | "success" | "warn" | "error".
       */
      setNotice({ kind = "info", text, detail, actionLabel, onAction } = {}) {
        if (noticeEl) noticeEl.remove();
        const iconName = { success: "check", warn: "warn", error: "warn" }[kind] || "info";
        const lead = kind === "loading" ? h("span", { class: "spinner", "aria-hidden": "true" }) : icon(iconName, "notice-icon");
        const body = h("div", { class: "notice-body" }, h("div", { text }), detail ? h("div", { class: "notice-detail", text: detail }) : null);
        noticeEl = h("div", { class: `notice notice--${kind}`, role: kind === "error" || kind === "warn" ? "alert" : "status" }, lead, body);
        if (actionLabel && onAction) {
          noticeEl.append(h("button", { class: "notice-action", type: "button", text: actionLabel, onclick: onAction }));
        }
        appendRow(noticeEl);
      },

      clearNotice() {
        if (noticeEl) noticeEl.remove();
        noticeEl = null;
      },

      showTyping(on) {
        if (on && !typingEl) {
          typingEl = h(
            "div",
            { class: "msg msg--orbit msg--typing", "aria-label": "Orbit is typing" },
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

  root.OrbitOverlay = { create, installKeyGuard };
})(globalThis);
