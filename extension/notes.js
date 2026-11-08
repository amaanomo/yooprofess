/*
 * Nova: study-notes export.
 *
 * Turns one chat (the messages content.js saves) into a Markdown file or a self-contained web page
 * that prints cleanly to PDF. Pure functions only (no DOM, no chrome.* APIs), so the same file is
 * used by:
 *   - the content script (exposed as globalThis.NovaNotes)
 *   - Node, to run the test cases at the bottom:   node notes.js
 *
 * Input model:
 *   { title, url, exportedAt, messages, shots }
 *   messages: the saved chat, oldest first. Student messages carry { text, time, at }; Nova
 *             replies carry { text, watch?, chapters?, summary?, key_points? }.
 *   shots:    { [student message "at"]: base64 JPEG of the slide when the question was asked }.
 */
(function (root) {
  "use strict";

  const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

  function fmt(seconds) {
    const t = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  }

  const oneLine = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

  // ---- Reading the chat -----------------------------------------------------

  /** The summary message's parts. Older saved messages only have the text, so parse it as a fallback. */
  function readSummary(msg) {
    let summary = typeof msg.summary === "string" ? msg.summary.trim() : "";
    let points = Array.isArray(msg.key_points) ? msg.key_points.map(oneLine).filter(Boolean) : [];
    if (!summary) {
      const text = String(msg.text || "");
      const split = text.split(/\*\*Key points:\*\*/);
      summary = split[0].replace(/^\s*\*\*Summary:\*\*\s*/, "").trim();
      if (!points.length && split[1]) {
        points = split[1]
          .split("\n")
          .map((l) => l.replace(/^\s*[•\-*]\s*/, "").trim())
          .filter(Boolean);
      }
    }
    const chapters = (msg.chapters || [])
      .filter((c) => c && Number.isFinite(c.start) && c.title)
      .map((c) => ({ start: c.start, title: oneLine(c.title) }));
    return { summary, points, chapters };
  }

  /**
   * Splits the chat into the latest summary and the question/answer pairs.
   * A student message pairs with the Nova reply right after it. Failed replies are skipped.
   */
  function collect(messages, shots) {
    const list = Array.isArray(messages) ? messages : [];
    const photos = shots && typeof shots === "object" ? shots : {};
    let summary = null;
    const qa = [];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m || m.role !== "student") continue;
      const reply = list[i + 1] && list[i + 1].role === "nova" ? list[i + 1] : null;
      if (!reply || reply.error || !String(reply.text || "").trim()) continue;
      if (Array.isArray(reply.chapters) && reply.chapters.length) {
        summary = readSummary(reply); // a later summary replaces an earlier one
        continue;
      }
      const shot = typeof photos[m.at] === "string" && BASE64.test(photos[m.at]) ? photos[m.at] : null;
      qa.push({
        n: qa.length + 1,
        time: Number.isFinite(m.time) ? m.time : null,
        question: oneLine(m.text),
        answer: String(reply.text).trim(),
        watch: reply.watch && Number.isFinite(reply.watch.start) ? reply.watch : null,
        shot,
      });
    }
    return { summary, qa };
  }

  // ---- Text helpers -----------------------------------------------------------

  /** Nova's replies use "\n" between lines and "•" bullets. Returns blocks: { list: boolean, lines: string[] }. */
  function blocks(text) {
    const out = [];
    for (const raw of String(text).split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const bullet = /^[•\-*]\s+(.*)$/.exec(line);
      const last = out[out.length - 1];
      if (bullet) {
        if (last && last.list) last.lines.push(bullet[1]);
        else out.push({ list: true, lines: [bullet[1]] });
      } else {
        out.push({ list: false, lines: [line] });
      }
    }
    return out;
  }

  function fileName(title, ext) {
    const base = oneLine(title).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
    return `${base || "Lecture"} - notes.${ext}`;
  }

  function dateText(value) {
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  }

  // ---- Markdown -----------------------------------------------------------------

  function toMarkdown(model, data) {
    const out = [`# ${oneLine(model.title) || "Lecture notes"}`, ""];
    const meta = [dateText(model.exportedAt) && `Exported ${dateText(model.exportedAt)}`, model.url && `[Open the lecture](${model.url})`].filter(Boolean);
    if (meta.length) out.push(meta.join(" · "), "");

    const s = data.summary;
    if (s) {
      out.push("## Summary", "", s.summary, "");
      if (s.points.length) out.push("### Key points", "", ...s.points.map((p) => `- ${p}`), "");
      if (s.chapters.length) out.push("### Chapters", "", ...s.chapters.map((c) => `- **${fmt(c.start)}** ${c.title}`), "");
    }
    if (data.qa.length) {
      out.push("## Questions and answers", "");
      for (const q of data.qa) {
        out.push(`### ${q.n}. ${q.question}${q.time != null ? ` (at ${fmt(q.time)})` : ""}`, "");
        for (const b of blocks(q.answer)) out.push(b.list ? b.lines.map((l) => `- ${l}`).join("\n") : b.lines[0], "");
        if (q.watch) {
          const end = q.watch.end && q.watch.end !== q.watch.start ? ` to ${fmt(q.watch.end)}` : "";
          out.push(`> Watch again: ${fmt(q.watch.start)}${end}${q.watch.label ? `, ${oneLine(q.watch.label)}` : ""}`, "");
        }
      }
    }
    out.push("---", "", "Made with Nova. Nova can make mistakes, so check important details.", "");
    return out.join("\n");
  }

  // ---- Printable web page -------------------------------------------------------

  const esc = (s) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  /** Escapes first, then turns Nova's ***bold italic***, **bold** and *italic* into tags. */
  function inline(text) {
    return esc(text)
      .replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  }

  function htmlBlocks(text) {
    return blocks(text)
      .map((b) => (b.list ? `<ul>${b.lines.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>` : `<p>${inline(b.lines[0])}</p>`))
      .join("\n");
  }

  const CSS = `
:root { color-scheme: light; --ink: #1d1b2e; --muted: #6b6880; --accent: #6d3fd6; --line: #e3e0ee; }
* { box-sizing: border-box; }
body { margin: 0; padding: 40px 20px 60px; background: #f6f5fa; color: var(--ink); font: 16px/1.55 -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 40px 48px; background: #fff; border-radius: 14px; box-shadow: 0 2px 18px rgba(30, 20, 60, .08); }
h1 { margin: 0 0 4px; font-size: 28px; line-height: 1.25; }
h2 { margin: 36px 0 10px; padding-bottom: 6px; font-size: 20px; border-bottom: 2px solid var(--line); }
h3 { margin: 0 0 8px; font-size: 16px; }
.meta { margin: 0 0 8px; color: var(--muted); font-size: 14px; }
.meta a { color: var(--accent); }
ul { margin: 6px 0 12px; padding-left: 22px; }
.chapters { list-style: none; padding: 0; }
.chapters li { padding: 4px 0; }
.t { display: inline-block; min-width: 54px; color: var(--accent); font-weight: 600; font-variant-numeric: tabular-nums; }
.qa { margin: 0 0 26px; break-inside: avoid; }
.shot { display: block; max-width: 100%; margin: 8px 0 10px; border: 1px solid var(--line); border-radius: 8px; }
.watch { margin: 8px 0 0; padding: 6px 12px; border-left: 3px solid var(--accent); background: #f3effd; color: #3e2a80; font-size: 14px; }
footer { margin-top: 36px; color: var(--muted); font-size: 13px; }
.print { position: fixed; top: 14px; right: 18px; padding: 8px 16px; border: 0; border-radius: 999px; background: var(--accent); color: #fff; font: 600 14px inherit; cursor: pointer; }
@media print {
  body { padding: 0; background: #fff; }
  main { max-width: none; padding: 0; border-radius: 0; box-shadow: none; }
  .print { display: none; }
  @page { margin: 16mm; }
}`;

  function toHtml(model, data) {
    const title = oneLine(model.title) || "Lecture notes";
    const out = [];
    out.push(`<h1>${esc(title)}</h1>`);
    const link = /^https?:\/\//i.test(model.url || "") ? ` · <a href="${esc(model.url)}">Open the lecture</a>` : "";
    out.push(`<p class="meta">${esc(dateText(model.exportedAt) ? `Exported ${dateText(model.exportedAt)}` : "")}${link}</p>`);

    const s = data.summary;
    if (s) {
      out.push("<h2>Summary</h2>", `<p>${inline(s.summary)}</p>`);
      if (s.points.length) out.push("<h3>Key points</h3>", `<ul>${s.points.map((p) => `<li>${inline(p)}</li>`).join("")}</ul>`);
      if (s.chapters.length) {
        out.push("<h3>Chapters</h3>", `<ul class="chapters">${s.chapters.map((c) => `<li><span class="t">${fmt(c.start)}</span>${esc(c.title)}</li>`).join("")}</ul>`);
      }
    }
    if (data.qa.length) {
      out.push("<h2>Questions and answers</h2>");
      for (const q of data.qa) {
        const when = q.time != null ? ` <span class="meta">(at ${fmt(q.time)})</span>` : "";
        const img = q.shot ? `<img class="shot" alt="${esc(`Slide at ${fmt(q.time)}`)}" src="data:image/jpeg;base64,${q.shot}">` : "";
        let watch = "";
        if (q.watch) {
          const end = q.watch.end && q.watch.end !== q.watch.start ? ` to ${fmt(q.watch.end)}` : "";
          watch = `<p class="watch">Watch again: ${fmt(q.watch.start)}${end}${q.watch.label ? `, ${esc(oneLine(q.watch.label))}` : ""}</p>`;
        }
        out.push(`<section class="qa"><h3>${q.n}. ${esc(q.question)}${when}</h3>${img}${htmlBlocks(q.answer)}${watch}</section>`);
      }
    }
    out.push("<footer>Made with Nova. Nova can make mistakes, so check important details.</footer>");
    return (
      `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
      `<title>${esc(title)} - notes</title>\n<style>${CSS}</style>\n</head>\n<body>\n` +
      `<button class="print" type="button" onclick="window.print()">Print or save as PDF</button>\n<main>\n${out.join("\n")}\n</main>\n</body>\n</html>\n`
    );
  }

  /** Both formats from one chat. counts says what went in, so the caller can tell an empty export. */
  function build(model) {
    const m = model || {};
    const data = collect(m.messages, m.shots);
    return {
      markdown: toMarkdown(m, data),
      html: toHtml(m, data),
      counts: { qa: data.qa.length, summary: Boolean(data.summary), shots: data.qa.filter((q) => q.shot).length },
    };
  }

  const api = { build, collect, fileName, fmt };
  root.NovaNotes = api;

  // ==========================================================================
  // Tests: run with `node notes.js`
  // ==========================================================================
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    if (typeof require !== "undefined" && require.main === module) runTests();
  }

  function runTests() {
    const assert = require("node:assert/strict");
    const tests = [];
    const test = (name, fn) => tests.push({ name, fn });

    const chat = [
      { role: "student", text: "what is a neural network", time: 248, at: 1000 },
      { role: "nova", text: "**In this lecture:** Layers of units.\n**More broadly:** A ***model***.", watch: { start: 236, end: 260, label: "layers and weights" }, at: 1001 },
      { role: "student", text: "Summarize this lecture", time: 250, at: 2000 },
      {
        role: "nova",
        text: "**Summary:** Intro to nets.\n**Key points:**\n• Layers\n• Weights",
        summary: "Intro to nets.",
        key_points: ["Layers", "Weights"],
        chapters: [{ start: 0, title: "Intro" }, { start: 3725, title: "Backprop" }],
        at: 2001,
      },
      { role: "student", text: "broken one", time: 300, at: 3000 },
      { role: "nova", error: true, text: "I can't reach the Nova server right now" },
      { role: "student", text: "unanswered", time: 400, at: 4000 },
    ];

    test("collect pairs questions with replies, pulls out the summary, skips failures", () => {
      const { summary, qa } = collect(chat, { 1000: "QUJD" });
      assert.equal(qa.length, 1);
      assert.equal(qa[0].question, "what is a neural network");
      assert.equal(qa[0].time, 248);
      assert.equal(qa[0].shot, "QUJD");
      assert.deepEqual(summary.points, ["Layers", "Weights"]);
      assert.equal(summary.chapters.length, 2);
    });

    test("a summary saved without structured fields is parsed from its text", () => {
      const old = [
        { role: "student", text: "Summarize this lecture", at: 1 },
        { role: "nova", text: "**Summary:** Old one.\n**Key points:**\n• A\n• B", chapters: [{ start: 5, title: "T" }], at: 2 },
      ];
      const { summary } = collect(old, {});
      assert.equal(summary.summary, "Old one.");
      assert.deepEqual(summary.points, ["A", "B"]);
    });

    test("only the latest summary is kept", () => {
      const two = [];
      for (const [n, label] of [[1, "first"], [2, "second"]]) {
        two.push({ role: "student", text: "Summarize this lecture", at: n * 10 });
        two.push({ role: "nova", text: "x", summary: label, key_points: [], chapters: [{ start: 1, title: "c" }], at: n * 10 + 1 });
      }
      assert.equal(collect(two, {}).summary.summary, "second");
    });

    test("markdown has the headings, bullets, chapters and watch line", () => {
      const { markdown } = build({ title: "Intro: AI/ML", url: "https://x.test/v?id=1", exportedAt: "2026-11-07T10:00:00Z", messages: chat });
      assert.match(markdown, /^# Intro: AI\/ML/);
      assert.match(markdown, /Exported 2026-11-07 · \[Open the lecture\]\(https:\/\/x\.test\/v\?id=1\)/);
      assert.match(markdown, /## Summary\n\nIntro to nets\./);
      assert.match(markdown, /- Layers\n- Weights/);
      assert.match(markdown, /- \*\*0:00\*\* Intro\n- \*\*1:02:05\*\* Backprop/);
      assert.match(markdown, /### 1\. what is a neural network \(at 4:08\)/);
      assert.match(markdown, /> Watch again: 3:56 to 4:20, layers and weights/);
      assert.doesNotMatch(markdown, /broken one|unanswered|can't reach/);
    });

    test("bullets in an answer become a list", () => {
      const m = [
        { role: "student", text: "q", time: 1, at: 1 },
        { role: "nova", text: "Intro line\n• one\n• two\nClosing", at: 2 },
      ];
      assert.match(build({ messages: m }).markdown, /Intro line\n\n- one\n- two\n\nClosing/);
    });

    test("html escapes everything the student or model wrote", () => {
      const evil = [
        { role: "student", text: "<script>alert(1)</script>", time: 1, at: 1 },
        { role: "nova", text: '<img src=x onerror=alert(1)> **bold** "quoted"', watch: { start: 1, end: 2, label: "<b>x</b>" }, at: 2 },
      ];
      const { html } = build({ title: "<i>t</i>", url: 'javascript:alert(1)', messages: evil });
      assert.doesNotMatch(html, /<script>alert|<img src=x|<b>x<\/b>|<i>t<\/i>/);
      assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.match(html, /<strong>bold<\/strong>/);
      assert.doesNotMatch(html, /href="javascript:/, "non-http links are dropped");
    });

    test("html embeds a slide screenshot only when it is valid base64", () => {
      const m = [
        { role: "student", text: "a", time: 5, at: 1 },
        { role: "nova", text: "r", at: 2 },
        { role: "student", text: "b", time: 6, at: 3 },
        { role: "nova", text: "r", at: 4 },
      ];
      const { html, counts } = build({ messages: m, shots: { 1: "QUJD", 3: '"><script>x</script>' } });
      assert.equal(counts.shots, 1);
      assert.match(html, /src="data:image\/jpeg;base64,QUJD"/);
      assert.doesNotMatch(html, /<script>x/);
    });

    test("an empty chat gives zero counts", () => {
      assert.deepEqual(build({ messages: [] }).counts, { qa: 0, summary: false, shots: 0 });
      assert.deepEqual(build({}).counts, { qa: 0, summary: false, shots: 0 });
    });

    test("fileName strips path and reserved characters", () => {
      assert.equal(fileName('Lecture 7: "AI"/ML?', "md"), "Lecture 7 AIML - notes.md");
      assert.equal(fileName("", "html"), "Lecture - notes.html");
      assert.equal(fmt(3725), "1:02:05");
    });

    let failed = 0;
    for (const t of tests) {
      try {
        t.fn();
        console.log(`  ok   ${t.name}`);
      } catch (err) {
        failed++;
        console.log(`  FAIL ${t.name}\n${err.message}\n`);
      }
    }
    console.log(`\n[Nova] notes.js: ${tests.length - failed}/${tests.length} tests passed`);
    if (failed) process.exitCode = 1;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
