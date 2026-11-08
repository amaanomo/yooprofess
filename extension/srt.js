/*
 * Nova: SRT parsing and caption-window helpers.
 *
 * Pure functions only (no DOM, no chrome.* APIs), so the same file is used by:
 *   - the content script (exposed as globalThis.NovaSRT)
 *   - the background service worker (via importScripts)
 *   - Node, to run the test cases at the bottom:   node srt.js
 */
(function (root) {
  "use strict";

  // One SRT timestamp: "00:14:32,400". Also tolerates "." for the millisecond
  // separator, a missing hour field ("14:32,400"), and 1-3 millisecond digits.
  const TIME = "(?:(\\d+):)?(\\d{1,2}):(\\d{1,2})(?:[,.](\\d{1,3}))?";
  const TIME_RE = new RegExp("^\\s*" + TIME + "\\s*$");
  const TIMING_LINE_RE = new RegExp("^\\s*" + TIME + "\\s*-->\\s*" + TIME);

  function toSeconds(h, m, s, ms) {
    const fraction = ms ? Number(ms.padEnd(3, "0")) / 1000 : 0;
    const total = Number(h || 0) * 3600 + Number(m) * 60 + Number(s) + fraction;
    return Math.round(total * 1000) / 1000; // 872.4, not 872.4000000000001
  }

  /** "00:14:32,400" -> 872.4. Returns NaN for anything that isn't a timestamp. */
  function parseTimestamp(str) {
    const m = TIME_RE.exec(String(str));
    return m ? toSeconds(m[1], m[2], m[3], m[4]) : NaN;
  }

  const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
      if (code[0] === "#") {
        const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
      }
      const named = ENTITIES[code.toLowerCase()];
      return named !== undefined ? named : whole;
    });
  }

  function cleanText(s) {
    return decodeEntities(
      s
        .replace(/<[^>]*>/g, " ") // <i>, <b>, <font color="...">, stray tags
        .replace(/\{\\[^}]*\}/g, " ") // SSA-style overrides such as {\an8}
    )
      .replace(/\s+/g, " ")
      .trim();
  }

  function nextNonEmpty(lines, from) {
    for (let i = from; i < lines.length; i++) {
      if (lines[i].trim()) return lines[i];
    }
    return "";
  }

  /**
   * Parse SRT text into [{ start, end, text }] with times in seconds (floats).
   * Handles a UTF-8 BOM, \r\n and \r line endings, multi-line cues, extra or
   * missing blank lines, missing cue numbers, and HTML/formatting tags.
   * Cues whose text is empty after cleaning are dropped. Output is sorted by start.
   */
  function parseSRT(input) {
    if (typeof input !== "string" || !input) return [];
    const lines = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
    const cues = [];
    let current = null;
    let afterBlank = true; // start of file counts as "after a blank line"

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const timing = TIMING_LINE_RE.exec(line);
      if (timing) {
        if (current) cues.push(current);
        current = {
          start: toSeconds(timing[1], timing[2], timing[3], timing[4]),
          end: toSeconds(timing[5], timing[6], timing[7], timing[8]),
          lines: [],
        };
        afterBlank = false;
        continue;
      }
      if (!line) {
        afterBlank = true; // blank lines separate cues; tolerate any number of them
        continue;
      }
      // A bare number right before a timing line is the next cue's index, unless it
      // is the first text line directly under its own timing line (caption text "42").
      const isIndex =
        /^\d+$/.test(line) &&
        TIMING_LINE_RE.test(nextNonEmpty(lines, i + 1)) &&
        (afterBlank || !current || current.lines.length > 0);
      afterBlank = false;
      if (isIndex) continue;
      if (current) current.lines.push(line);
    }
    if (current) cues.push(current);

    return cues
      .map((c) => ({ start: c.start, end: Math.max(c.start, c.end), text: cleanText(c.lines.join(" ")) }))
      .filter((c) => c.text)
      .sort((a, b) => a.start - b.start || a.end - b.end);
  }

  /**
   * Cues that overlap the window [currentTime - seconds, currentTime].
   * A cue that started before the window but is still running at its start is
   * included; a cue that starts after currentTime is not.
   */
  function captionWindow(cues, currentTime, seconds = 90) {
    if (!Array.isArray(cues) || !Number.isFinite(currentTime)) return [];
    const from = currentTime - seconds;
    return cues
      .filter((c) => c.end > from && c.start <= currentTime)
      .map((c) => ({ start: c.start, end: c.end, text: c.text }));
  }

  /** 468.2 -> "7:48", 3725 -> "1:02:05". */
  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }

  const api = { parseSRT, parseTimestamp, captionWindow, formatTime };
  root.NovaSRT = api;

  // ---------------------------------------------------------------------------
  // Tests: `node srt.js`. Never runs in the browser.
  // ---------------------------------------------------------------------------
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    if (typeof require !== "undefined" && require.main === module) runTests();
  }

  function runTests() {
    const assert = require("node:assert/strict");
    const tests = [];
    const test = (name, fn) => tests.push({ name, fn });

    test("parseTimestamp converts SRT times to float seconds", () => {
      assert.equal(parseTimestamp("00:14:32,400"), 872.4);
      assert.equal(parseTimestamp("00:00:00,000"), 0);
      assert.equal(parseTimestamp("01:02:03,004"), 3723.004);
      assert.equal(parseTimestamp("00:00:01.5"), 1.5); // "." separator, 1 ms digit = tenths
      assert.equal(parseTimestamp("14:32,400"), 872.4); // no hour field
      assert.ok(Number.isNaN(parseTimestamp("not a time")));
    });

    test("basic SRT with \\r\\n, BOM, multi-line cue, tags and entities", () => {
      const srt =
        "﻿1\r\n00:14:32,400 --> 00:14:35,100\r\nSo the <i>prompt</i> is\r\njust instructions.\r\n\r\n" +
        '2\r\n00:14:35,100 --> 00:14:38,000\r\n<font color="#ffffff">Input &amp; output</font>\r\n';
      assert.deepEqual(parseSRT(srt), [
        { start: 872.4, end: 875.1, text: "So the prompt is just instructions." },
        { start: 875.1, end: 878, text: "Input & output" },
      ]);
    });

    test("extra blank lines, missing indexes, numeric caption text, no trailing newline", () => {
      const srt = [
        "",
        "",
        "1",
        "00:00:01,000 --> 00:00:03,000",
        "First line",
        "",
        "",
        "",
        "2",
        "00:00:03,000 --> 00:00:05,000",
        "42", // caption text that happens to be a number
        "",
        "00:00:05,000 --> 00:00:07,250", // cue with no index line
        "Last cue",
      ].join("\n");
      assert.deepEqual(parseSRT(srt), [
        { start: 1, end: 3, text: "First line" },
        { start: 3, end: 5, text: "42" },
        { start: 5, end: 7.25, text: "Last cue" },
      ]);
    });

    test("lone \\r line endings, stray blank line inside a cue, tag-only cue dropped", () => {
      const srt =
        "1\r00:00:10,000 --> 00:00:12,000\rpart one\r\rpart two\r\r" +
        "2\r00:00:12,000 --> 00:00:13,000\r<b></b>\r\r" +
        "3\r00:00:13,000 --> 00:00:14,000\r{\\an8}top  text&nbsp;here\r";
      assert.deepEqual(parseSRT(srt), [
        { start: 10, end: 12, text: "part one part two" },
        { start: 13, end: 14, text: "top text here" },
      ]);
    });

    test("garbage, HTML and empty input give no cues", () => {
      assert.deepEqual(parseSRT(""), []);
      assert.deepEqual(parseSRT(null), []);
      assert.deepEqual(parseSRT("<!DOCTYPE html><html><body>Sign in</body></html>"), []);
    });

    test("captionWindow returns cues overlapping the last N seconds", () => {
      const cues = [
        { start: 0, end: 5, text: "a" },
        { start: 370, end: 380, text: "b" }, // ends inside the window (378.2..468.2)
        { start: 400, end: 410, text: "c" },
        { start: 465, end: 470, text: "d" }, // still being spoken at currentTime
        { start: 469, end: 472, text: "e" }, // starts after currentTime
      ];
      assert.deepEqual(
        captionWindow(cues, 468.2).map((c) => c.text),
        ["b", "c", "d"]
      );
      assert.deepEqual(
        captionWindow(cues, 10, 90).map((c) => c.text),
        ["a"]
      );
      assert.deepEqual(captionWindow(cues, NaN), []);
      assert.deepEqual(captionWindow(null, 10), []);
    });

    test("formatTime renders M:SS and H:MM:SS", () => {
      assert.equal(formatTime(468.2), "7:48");
      assert.equal(formatTime(0), "0:00");
      assert.equal(formatTime(59.999), "0:59");
      assert.equal(formatTime(3725), "1:02:05");
      assert.equal(formatTime(-3), "0:00");
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
    console.log(`\n[Nova] srt.js: ${tests.length - failed}/${tests.length} tests passed`);
    if (failed) process.exitCode = 1;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
