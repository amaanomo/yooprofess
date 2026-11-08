/*
 * Nova: translation scheduler for the subtitle overlay.
 *
 * Decides which caption cues to translate next (starting at the playhead), sends
 * them in batches through a caller-supplied function, retries failures, keeps a
 * cache of finished lines, and reports progress. No DOM and no chrome.* APIs, so
 * it also runs in Node for the tests at the bottom:   node translator.js
 */
(function (root) {
  "use strict";

  // Tunables
  const BATCH_SIZE = 60; // cues per /translate request
  const CONCURRENCY = 2; // requests in flight at once
  const RETRY_DELAYS_MS = [1000, 3000]; // backoff before retry 1 and retry 2
  const LEAD_SECONDS = 10; // start translating this far before the playhead

  /** Index of the cue playing at time t, or -1. Cues are sorted by start. */
  function cueIndexAt(cues, t) {
    let lo = 0;
    let hi = cues.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found >= 0 && t < cues[found].end ? found : -1;
  }

  /** First cue that is still running at (t - lead): where translation should start. */
  function startIndexFor(cues, t, lead = LEAD_SECONDS) {
    const from = t - lead;
    for (let i = 0; i < cues.length; i++) if (cues[i].end > from) return i;
    return 0;
  }

  /**
   * Pending cue indexes in priority order, split into batches:
   * from startIndex to the end first, then from 0 up to startIndex.
   * skip(i) -> true for cues that are done, failed or already in flight.
   */
  function batchOrder(total, startIndex, batchSize, skip) {
    const order = [];
    for (let i = startIndex; i < total; i++) if (!skip(i)) order.push(i);
    for (let i = 0; i < Math.min(startIndex, total); i++) if (!skip(i)) order.push(i);
    const batches = [];
    for (let k = 0; k < order.length; k += batchSize) batches.push(order.slice(k, k + batchSize));
    return batches;
  }

  /**
   * @param {object} o
   * @param {{start:number,end:number,text:string}[]} o.cues  full caption list
   * @param {Object<number,string>} [o.cache]  already translated lines (i -> text)
   * @param {(batch:{i,start,end,text}[]) => Promise<{ok:boolean, map?:Object<number,string>}>} o.translateBatch
   * @param {() => number} o.getTime  current playhead in seconds
   * @param {(cache:Object<number,string>) => void} [o.onSave]  persist after each batch
   * @param {(info:{done:number,total:number,failed:number,active:boolean}) => void} [o.onChange]
   * @param {(ms:number) => Promise<void>} [o.sleep]  injectable for tests
   */
  function create(o) {
    const cues = o.cues;
    const total = cues.length;
    const done = new Map(Object.entries(o.cache || {}).map(([k, v]) => [Number(k), v]));
    const failed = new Set();
    const inFlight = new Set();
    const batchSize = o.batchSize || BATCH_SIZE;
    const concurrency = o.concurrency || CONCURRENCY;
    const retryDelays = o.retryDelays || RETRY_DELAYS_MS;
    const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    let running = false;
    let generation = 0; // bumps on stop() so late results are ignored
    let batchesInFlight = 0;
    let startIndex = startIndexFor(cues, o.getTime());

    const skip = (i) => done.has(i) || failed.has(i) || inFlight.has(i);
    const info = () => ({ done: done.size, total, failed: failed.size, active: running && batchesInFlight > 0 });
    const isComplete = () => done.size + failed.size >= total;
    const changed = () => o.onChange && o.onChange(info());

    function snapshot() {
      const obj = {};
      for (const [i, text] of done) obj[i] = text;
      return obj;
    }

    async function runBatch(indexes, gen) {
      const batch = indexes.map((i) => ({ i, start: cues[i].start, end: cues[i].end, text: cues[i].text }));
      let result = null;
      for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        if (gen !== generation) return;
        if (attempt > 0) await sleep(retryDelays[attempt - 1]);
        if (gen !== generation) return;
        try {
          result = await o.translateBatch(batch);
        } catch (_) {
          result = { ok: false };
        }
        if (result && result.ok) break;
      }
      if (gen !== generation) return;
      for (const i of indexes) inFlight.delete(i);
      batchesInFlight--;
      if (result && result.ok) {
        const map = result.map || {};
        for (const i of indexes) {
          if (typeof map[i] === "string" && map[i]) done.set(i, map[i]);
          else failed.add(i); // the server couldn't translate it; Retry in the UI clears this
        }
        o.onSave && o.onSave(snapshot());
      } else {
        for (const i of indexes) failed.add(i);
      }
      changed();
      pump();
    }

    function pump() {
      if (!running) return;
      const gen = generation;
      while (batchesInFlight < concurrency) {
        const [next] = batchOrder(total, startIndex, batchSize, skip);
        if (!next) break;
        for (const i of next) inFlight.add(i);
        batchesInFlight++;
        runBatch(next, gen);
      }
      if (!batchesInFlight) {
        running = false; // nothing left to send (everything done or failed)
        changed();
      }
    }

    return {
      start() {
        if (running) return;
        running = !isComplete();
        changed();
        pump();
      },
      /** Student jumped somewhere: translate from there next. */
      seek(t) {
        startIndex = startIndexFor(cues, t);
        pump();
      },
      stop() {
        running = false;
        generation++;
        inFlight.clear();
        batchesInFlight = 0;
      },
      /** Clear failures and try those cues again. */
      retryFailed() {
        failed.clear();
        running = false;
        this.start();
      },
      has: (i) => done.has(i),
      get: (i) => done.get(i),
      isFailed: (i) => failed.has(i),
      info,
    };
  }

  const api = { create, cueIndexAt, startIndexFor, batchOrder, BATCH_SIZE, CONCURRENCY, LEAD_SECONDS };
  root.NovaTranslator = api;

  // ---------------------------------------------------------------------------
  // Tests: `node translator.js`. Never runs in the browser.
  // ---------------------------------------------------------------------------
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    if (typeof require !== "undefined" && require.main === module) runTests();
  }

  async function runTests() {
    const assert = require("node:assert/strict");
    const cues = Array.from({ length: 10 }, (_, i) => ({ start: i * 5, end: i * 5 + 4.5, text: `line ${i}` }));
    const tests = [];
    const test = (name, fn) => tests.push({ name, fn });

    test("cueIndexAt finds the cue playing at t", () => {
      assert.equal(cueIndexAt(cues, 0), 0);
      assert.equal(cueIndexAt(cues, 12), 2);
      assert.equal(cueIndexAt(cues, 14.7), -1); // gap between cues
      assert.equal(cueIndexAt(cues, 49), 9);
      assert.equal(cueIndexAt(cues, 99), -1);
      assert.equal(cueIndexAt([], 1), -1);
    });

    test("startIndexFor leads the playhead by 10 s", () => {
      assert.equal(startIndexFor(cues, 30), 4); // 30 - 10 = 20 -> cue 4 (20..24.5)
      assert.equal(startIndexFor(cues, 3), 0);
    });

    test("batchOrder: playhead forward, then wrap to the start, skipping done", () => {
      const doneSet = new Set([5]);
      const b = batchOrder(10, 4, 3, (i) => doneSet.has(i));
      assert.deepEqual(b, [[4, 6, 7], [8, 9, 0], [1, 2, 3]]);
      assert.deepEqual(batchOrder(3, 0, 60, () => false), [[0, 1, 2]]);
      assert.deepEqual(batchOrder(3, 0, 60, () => true), []);
    });

    test("scheduler translates from the playhead, re-prioritizes on seek, caches", async () => {
      const sent = [];
      let saved = null;
      let t = 30;
      const tr = create({
        cues,
        batchSize: 2,
        concurrency: 1,
        getTime: () => t,
        sleep: async () => {},
        translateBatch: async (batch) => {
          sent.push(batch.map((c) => c.i));
          await new Promise((r) => setImmediate(r));
          if (sent.length === 1) tr.seek(1); // student seeks back while the first batch runs
          return { ok: true, map: Object.fromEntries(batch.map((c) => [c.i, "T" + c.i])) };
        },
        onSave: (c) => (saved = c),
      });
      tr.start();
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(sent[0], [4, 5]); // starts 10 s before t=30
      assert.deepEqual(sent[1], [0, 1]); // after seek to t=1, cue 0 onward goes next
      assert.equal(tr.info().done, 10);
      assert.equal(tr.get(7), "T7");
      assert.equal(Object.keys(saved).length, 10);
      t = 0;
    });

    test("cached cues are not requested again", async () => {
      const sent = [];
      const cache = Object.fromEntries(cues.slice(0, 8).map((c, i) => [i, "C" + i]));
      const tr = create({ cues, cache, getTime: () => 0, sleep: async () => {},
        translateBatch: async (b) => (sent.push(b.map((c) => c.i)), { ok: true, map: Object.fromEntries(b.map((c) => [c.i, "x"])) }) });
      tr.start();
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(sent, [[8, 9]]);
      assert.equal(tr.get(0), "C0");
    });

    test("retries twice, then marks failed; missing lines are failed; retryFailed works", async () => {
      let calls = 0;
      let healthy = false;
      const delays = [];
      const tr = create({ cues: cues.slice(0, 3), getTime: () => 0, sleep: async (ms) => delays.push(ms),
        translateBatch: async (b) => {
          calls++;
          if (!healthy) return { ok: false };
          return { ok: true, map: { 0: "a", 2: "c" } }; // server skipped cue 1
        } });
      tr.start();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(calls, 3); // first try + 2 retries
      assert.deepEqual(delays, [1000, 3000]);
      assert.equal(tr.info().failed, 3);
      healthy = true;
      tr.retryFailed();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(tr.get(0), "a");
      assert.equal(tr.isFailed(1), true);
      assert.equal(tr.info().done, 2);
    });

    test("stop() ignores late results", async () => {
      let release;
      const tr = create({ cues: cues.slice(0, 2), getTime: () => 0, sleep: async () => {},
        translateBatch: () => new Promise((r) => (release = () => r({ ok: true, map: { 0: "a", 1: "b" } }))) });
      tr.start();
      await new Promise((r) => setImmediate(r));
      tr.stop();
      release();
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(tr.info().done, 0);
    });

    let failedCount = 0;
    for (const t of tests) {
      try {
        await t.fn();
        console.log(`  ok   ${t.name}`);
      } catch (err) {
        failedCount++;
        console.log(`  FAIL ${t.name}\n${err.stack}\n`);
      }
    }
    console.log(`\n[Nova] translator.js: ${tests.length - failedCount}/${tests.length} tests passed`);
    if (failedCount) process.exitCode = 1;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
