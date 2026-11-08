/*
 * Nova: video commands ("hey nova, can you pause the video", "go back 30 seconds
 * and play", "skip to 12:30 at 1.5x").
 *
 * Pure functions only (no DOM, no chrome.*), so the same file is used by:
 *   - the content script (globalThis.NovaCommands)
 *   - Node, to run the test cases at the bottom:   node commands.js
 *
 *   parse(text)    -> [action, ...] if EVERY part of the sentence is a command we
 *                     understand locally (instant, no server); otherwise null and
 *                     the sentence goes to the AI, which may answer with commands.
 *   parseReply(t)  -> { actions, say, rest } from an AI reply containing
 *                     "Command: ..." / "Say: ..." lines (see backend SYSTEM prompt).
 *   describe(acts, info) -> "Jumped to 9:30 and playing."
 *
 * Actions:
 *   { type: "pause" } | { type: "play" }
 *   { type: "seek_to", seconds } | { type: "seek_by", seconds }   (negative = back)
 *   { type: "speed", rate } | { type: "speed_by", delta }
 *   { type: "volume", level } (0-1) | { type: "volume_by", delta }
 *   { type: "mute" } | { type: "unmute" }
 */
(function (root) {
  "use strict";

  // --------------------------------------------------------------- numbers ---

  const SMALL = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19, a: 1, an: 1, couple: 2, "a couple": 2, "a couple of": 2, few: 5, "a few": 5,
  };
  const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

  /** "30", "2.5", "thirty", "forty five", "a", "a couple", "half a" -> number, else NaN. */
  function toNumber(raw) {
    const w = String(raw || "").trim().toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ");
    if (!w) return NaN;
    if (/^\d+(\.\d+)?$/.test(w)) return Number(w);
    if (w in SMALL) return SMALL[w];
    if (w in TENS) return TENS[w];
    const parts = w.split(" ");
    if (parts.length === 2 && parts[0] in TENS && parts[1] in SMALL && SMALL[parts[1]] < 10) return TENS[parts[0]] + SMALL[parts[1]];
    if (/^(half|half a|half an)$/.test(w)) return 0.5;
    const pointWords = w.match(/^(\w+) point (\w+)$/); // "one point five"
    if (pointWords) {
      const a = toNumber(pointWords[1]);
      const b = toNumber(pointWords[2]);
      if (Number.isFinite(a) && Number.isFinite(b) && b < 10) return a + b / 10;
    }
    return NaN;
  }

  const NUM = "(?:\\d+(?:\\.\\d+)?|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|a couple of|a couple|a few|an|a)";
  const UNIT = "(?:hours?|hrs?|minutes?|mins?|seconds?|secs?|s)";

  function unitSeconds(unit) {
    if (/^h/.test(unit)) return 3600;
    if (/^m/.test(unit)) return 60;
    return 1;
  }

  /**
   * "30 seconds", "2 minutes", "a minute and a half", "1 minute 30 seconds",
   * "an hour and 5 minutes", "half a minute", "90 secs" -> seconds, else NaN.
   */
  function parseDuration(raw) {
    let t = String(raw || "").trim().toLowerCase();
    if (!t) return NaN;
    let extra = 0;
    // "... and a half"
    const half = t.match(/^(.*?\b(hours?|minutes?|mins?|seconds?|secs?))\s+and\s+a\s+half$/);
    if (half) {
      extra = 0.5 * unitSeconds(half[2]);
      t = half[1];
    }
    const halfOf = t.match(/^half\s+an?\s+(hour|minute)$/);
    if (halfOf) return 0.5 * unitSeconds(halfOf[1]) + extra;
    const re = new RegExp(`^${NUM}\\s*${UNIT}$`);
    const pieces = t.split(/\s*(?:,|\band\b)\s*|\s+(?=(?:\d|a\b|an\b|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty)[^:]*?\s*(?:hours?|minutes?|mins?|seconds?|secs?)\b)/).filter(Boolean);
    let total = 0;
    for (const piece of pieces) {
      if (!re.test(piece)) return NaN;
      const m = piece.match(new RegExp(`^(${NUM})\\s*(${UNIT})$`));
      const n = toNumber(m[1]);
      if (!Number.isFinite(n)) return NaN;
      total += n * unitSeconds(m[2]);
    }
    return total + extra;
  }

  /** "12:30" / "1:02:03" -> seconds. */
  function parseClock(str) {
    const m = String(str).trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/);
    if (!m) return NaN;
    return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }

  /** A point in the video: "12:30", "minute 5", "the 10 minute mark", "12 minutes 30 seconds", "12 30". */
  function parseTimePoint(raw) {
    let t = String(raw || "").trim().toLowerCase();
    t = t.replace(/^(?:the\s+)?/, "").replace(/\s*(?:mark|point|timestamp|time stamp)$/, "").replace(/^(?:time(?:stamp)?)\s+/, "").trim();
    const clock = parseClock(t);
    if (Number.isFinite(clock)) return clock;
    const spaced = t.match(/^(\d{1,2})\s+(\d{2})$/); // recognizer wrote "12 30"
    if (spaced) return Number(spaced[1]) * 60 + Number(spaced[2]);
    const minute = t.match(new RegExp(`^(?:minute|min)\\s+(${NUM})$`));
    if (minute) return toNumber(minute[1]) * 60;
    const dur = parseDuration(t.replace(/\s+in$/, "")); // "12 minutes 30 seconds", "10 minutes in"
    if (Number.isFinite(dur)) return dur;
    const bare = t.match(/^(\d{1,3})$/); // "go to 12" = 12:00
    if (bare) return Number(bare[1]) * 60;
    return NaN;
  }

  // ---------------------------------------------------------------- phrases ---

  const POLITE_PREFIX =
    /^(?:(?:hey|hi|ok(?:ay)?|yo)\s*,?\s*)?(?:nova\s*,?\s*)?(?:(?:can|could|would|will) (?:you|u|ya)(?: please)?|please|i (?:want|need|would like|'d like) (?:you )?to|i wanna|let'?s|go ahead and|just|now|ok(?:ay)?|so)\s+/;
  const POLITE_SUFFIX = /\s+(?:please|for me|now|right now|thanks|thank you|real quick|quickly)$/;
  const OBJ = "(?:\\s+(?:the|this)\\s+(?:video|lecture|recording|playback)|\\s+(?:it|this|that|playback|the video|the lecture))?";

  function normalize(text) {
    let t = String(text || "").toLowerCase().replace(/[?!]+|(?<!\d)\.|\.(?!\d)/g, " ").replace(/[“”"]/g, "").replace(/\s+/g, " ").trim();
    // Peel polite wrappers repeatedly: "hey nova can you please just pause it for me thanks"
    for (let i = 0; i < 4; i++) {
      const before = t;
      t = t.replace(POLITE_PREFIX, "").replace(POLITE_SUFFIX, "").replace(/^,\s*/, "").trim();
      if (t === before) break;
    }
    return t;
  }

  const BACK_VERBS = "(?:go back|going back|rewind|back up|jump back|skip back|move back|scroll back|take (?:me|it) back)";
  const FWD_VERBS = "(?:go forward|skip ahead|skip forward|fast[ -]?forward|jump ahead|jump forward|move ahead|move forward|go ahead|skip|forward)";

  /** One clause -> [actions] or null. */
  function parseClause(raw) {
    const t = normalize(raw);
    if (!t) return null;
    let m;

    // pause / play
    // (paws/pause's/pose/pours: how Chrome often mishears "pause")
    if (new RegExp(`^(?:pause|pause's|pauses|paws|pose|pours|stop|hold on|hold it|wait|freeze)${OBJ}(?: for a (?:second|sec|moment|minute))?$`).test(t)) return [{ type: "pause" }];
    if (new RegExp(`^(?:play|plays|resume|resumes|continue|unpause|un pause|unpaws|keep (?:going|playing)|carry on|go on|start(?: playing)?)${OBJ}(?: again)?$`).test(t)) return [{ type: "play" }];

    // start over
    if (/^(?:start over|restart(?: the (?:video|lecture))?|(?:go|jump|skip|take me) (?:back )?to the (?:beginning|start)|(?:play )?from the (?:beginning|top|start)|rewind to the (?:beginning|start))$/.test(t)) {
      return [{ type: "seek_to", seconds: 0 }];
    }

    // replay the last N  (an explicit request to play)
    if ((m = t.match(new RegExp(`^(?:replay|play back|rewatch|re watch|play again)(?: the)? (?:last|previous|past) (.+)$`)))) {
      const s = parseDuration(m[1]);
      if (Number.isFinite(s) && s > 0) return [{ type: "seek_by", seconds: -s }, { type: "play" }];
    }
    if (/^(?:replay|play that again|say that again|repeat that|rewind that)$/.test(t)) return [{ type: "seek_by", seconds: -10 }, { type: "play" }];

    // relative: "go back 30 seconds", "skip ahead by 2 minutes", "go 30 seconds back"
    if ((m = t.match(new RegExp(`^(${BACK_VERBS}|${FWD_VERBS})(?: by)?(?: about| like)? (.+?)$`)))) {
      const back = new RegExp(`^${BACK_VERBS}$`).test(m[1]);
      const rest = m[2];
      if (/^(?:a (?:bit|little|little bit|tad)|some|a few seconds)$/.test(rest)) return [{ type: "seek_by", seconds: back ? -10 : 10 }];
      const s = parseDuration(rest);
      if (Number.isFinite(s) && s > 0) return [{ type: "seek_by", seconds: back ? -s : s }];
    }
    if ((m = t.match(new RegExp(`^(?:go|jump|skip|move) (.+?) (back|backwards|ahead|forward|forwards)$`)))) {
      const s = parseDuration(m[1]);
      if (Number.isFinite(s) && s > 0) return [{ type: "seek_by", seconds: /back/.test(m[2]) ? -s : s }];
    }
    if (new RegExp(`^${BACK_VERBS}(?: a (?:bit|little|little bit|tad))?$`).test(t)) return [{ type: "seek_by", seconds: -10 }];

    // absolute: "skip to 12:30", "go to minute 5", "jump to 1 hour 2 minutes", "take me to the 10 minute mark"
    if ((m = t.match(/^(?:go|jump|skip|seek|move|take me|bring me|fast[ -]?forward|rewind|play|start|head)(?: (?:back|ahead|forward|over))?(?: to| at| from)(?: about| around)? (.+)$/))) {
      const s = parseTimePoint(m[1]);
      if (Number.isFinite(s)) return [{ type: "seek_to", seconds: s }];
    }

    // speed
    if (/^(?:normal|regular|default|original|1x|one x|1 x|1 times) speed$|^(?:play at |set (?:the )?speed to |speed )?(?:normal|regular|1x|1 x)(?: speed)?$|^reset (?:the )?speed$/.test(t)) return [{ type: "speed", rate: 1 }];
    if (/^(?:play at |go |set (?:it |the speed )?to )?double speed$|^(?:play at |go )?2x(?: speed)?$/.test(t)) return [{ type: "speed", rate: 2 }];
    if (/^(?:play at |go |set (?:it |the speed )?to )?half speed$/.test(t)) return [{ type: "speed", rate: 0.5 }];
    if ((m = t.match(/^(?:(?:play|set (?:the )?speed|change (?:the )?speed|speed(?: it)?(?: up)?|go|watch|make it|put it)(?: (?:to|at|on))? )?(?:at )?([\w. ]+?) ?(?:x|times)(?: (?:speed|faster))?$/))) {
      const word = m[1].trim().replace(/^one and a half$/, "1.5");
      const rate = toNumber(word);
      if (Number.isFinite(rate) && rate >= 0.25 && rate <= 4) {
        // "play at 1.5x" also asks to play; "set the speed to 1.5x" doesn't.
        return /^play\b/.test(t) ? [{ type: "speed", rate }, { type: "play" }] : [{ type: "speed", rate }];
      }
    }
    if (/^(?:speed (?:it |this |the video )?up|faster|go faster|play faster|increase (?:the )?speed)$/.test(t)) return [{ type: "speed_by", delta: 0.25 }];
    if (/^(?:slow (?:it |this |the video )?down|slower|go slower|play slower|decrease (?:the )?speed|reduce (?:the )?speed)$/.test(t)) return [{ type: "speed_by", delta: -0.25 }];

    // volume
    if (/^(?:mute|silence|turn off (?:the )?(?:sound|audio))(?: (?:it|the video|the lecture|the sound|the audio))?$/.test(t)) return [{ type: "mute" }];
    if (/^(?:unmute|un mute|turn on (?:the )?(?:sound|audio)|sound on)(?: (?:it|the video|the lecture))?$/.test(t)) return [{ type: "unmute" }];
    if (/^(?:louder|turn (?:it |the volume |the sound )?up|volume up|increase (?:the )?volume|raise (?:the )?volume)$/.test(t)) return [{ type: "volume_by", delta: 0.2 }];
    if (/^(?:quieter|softer|turn (?:it |the volume |the sound )?down|volume down|decrease (?:the )?volume|lower (?:the )?volume)$/.test(t)) return [{ type: "volume_by", delta: -0.2 }];
    if (/^(?:max(?:imum)?|full) volume$|^turn (?:it|the volume) all the way up$/.test(t)) return [{ type: "volume", level: 1 }];
    if ((m = t.match(/^(?:set |turn |change )?(?:the )?volume (?:to |at )?(.+?)(?: ?percent|%)?$/))) {
      const n = toNumber(m[1].replace(/%$/, ""));
      if (Number.isFinite(n) && n >= 0 && n <= 100) return [{ type: "volume", level: n / 100 }];
    }

    return null;
  }

  /** Split "go back 30 seconds and play" / "skip to 10:00 then 1.5x" into clauses. */
  function splitClauses(text) {
    return String(text || "")
      .split(/\s*(?:,\s*(?:and\s+)?then\b|\band then\b|\bthen\b|\band\b|,|;)\s*/i)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** Whole sentence -> actions, or null if any part isn't a command we know. */
  function parse(text) {
    const whole = normalize(text);
    if (!whole) return null;
    // "a minute and a half" contains "and": try the sentence as one clause first.
    const single = parseClause(whole);
    if (single) return single;
    const clauses = splitClauses(whole);
    if (clauses.length < 2) return null;
    const actions = [];
    for (const clause of clauses) {
      const a = parseClause(clause);
      if (!a) return null;
      actions.push(...a);
    }
    return actions;
  }

  // ------------------------------------------------------- AI reply format ---

  /**
   * The backend answers playback requests it couldn't be sure about (e.g. "go to
   * where he talks about recursion") with lines like:
   *   Command: seek_to 7:48
   *   Command: play
   *   Say: Jumping to 7:48, where he defines recursion.
   * Watch: lines (other matches) are left in `rest` for the normal parser.
   */
  function parseReply(text) {
    const actions = [];
    let say = "";
    const rest = [];
    for (const line of String(text || "").split("\n")) {
      const cmd = line.match(/^\s*\**\s*command\s*\**\s*:\s*(.+)$/i);
      const sayLine = line.match(/^\s*\**\s*say\s*\**\s*:\s*(.+)$/i);
      if (cmd) {
        const a = parseCommandLine(cmd[1]);
        if (a) actions.push(a);
      } else if (sayLine) {
        say = sayLine[1].trim();
      } else {
        rest.push(line);
      }
    }
    return { actions, say, rest: rest.join("\n").trim() };
  }

  function parseCommandLine(raw) {
    const [name, arg = ""] = raw.trim().replace(/[`*]/g, "").split(/\s+/, 2);
    const n = name.toLowerCase();
    if (n === "pause" || n === "play" || n === "mute" || n === "unmute") return { type: n };
    if (n === "seek_to") {
      const s = Number.isFinite(parseClock(arg)) ? parseClock(arg) : Number(arg);
      return Number.isFinite(s) ? { type: "seek_to", seconds: s } : null;
    }
    if (n === "seek_by") return Number.isFinite(Number(arg)) ? { type: "seek_by", seconds: Number(arg) } : null;
    if (n === "speed") {
      const r = Number(String(arg).replace(/x$/i, ""));
      return Number.isFinite(r) ? { type: "speed", rate: r } : null;
    }
    if (n === "volume") {
      const v = Number(String(arg).replace(/%$/, ""));
      return Number.isFinite(v) ? { type: "volume", level: Math.max(0, Math.min(1, v > 1 ? v / 100 : v)) } : null;
    }
    return null;
  }

  // ------------------------------------------------------------ confirming ---

  function fmt(t) {
    t = Math.max(0, Math.floor(t));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = String(t % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }

  /**
   * results: [{ type, time?, rate?, level?, ok }] after running the actions.
   * -> "Jumped to 9:30 and playing."
   */
  function describe(results) {
    const parts = [];
    for (const r of results) {
      if (!r.ok) {
        parts.push(r.error || "couldn't do that");
        continue;
      }
      switch (r.type) {
        case "pause": parts.push("paused"); break;
        case "play": parts.push("playing"); break;
        case "seek_to":
        case "seek_by": parts.push(`jumped to ${fmt(r.time)}`); break;
        case "speed":
        case "speed_by": parts.push(`speed ${String(Math.round(r.rate * 100) / 100)}x`); break;
        case "volume":
        case "volume_by": parts.push(`volume ${Math.round(r.level * 100)}%`); break;
        case "mute": parts.push("muted"); break;
        case "unmute": parts.push("unmuted"); break;
      }
    }
    if (!parts.length) return "";
    const text = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
    return text.charAt(0).toUpperCase() + text.slice(1) + ".";
  }

  root.NovaCommands = { parse, parseReply, describe, parseDuration, parseTimePoint, toNumber };

  // ------------------------------------------------------------------ tests ---
  // node commands.js
  if (typeof module !== "undefined" && require.main === module) {
    const cases = [
      // pause / play
      ["hey nova can you pause the video", [{ type: "pause" }]],
      ["Could you please pause it for me?", [{ type: "pause" }]],
      ["pause", [{ type: "pause" }]],
      ["stop the lecture", [{ type: "pause" }]],
      ["can you paws the video", [{ type: "pause" }]],
      ["pose it", [{ type: "pause" }]],
      ["resumes the video", [{ type: "play" }]],
      ["can you resume", [{ type: "play" }]],
      ["keep going", [{ type: "play" }]],
      ["play the video again", [{ type: "play" }]],
      ["I want to continue the video", [{ type: "play" }]],
      // skip by amount
      ["go back 30 seconds", [{ type: "seek_by", seconds: -30 }]],
      ["can you skip ahead 2 minutes", [{ type: "seek_by", seconds: 120 }]],
      ["rewind a bit", [{ type: "seek_by", seconds: -10 }]],
      ["go back a minute and a half", [{ type: "seek_by", seconds: -90 }]],
      ["skip forward by thirty seconds", [{ type: "seek_by", seconds: 30 }]],
      ["fast forward 1 minute 30 seconds", [{ type: "seek_by", seconds: 90 }]],
      ["go 20 seconds back", [{ type: "seek_by", seconds: -20 }]],
      ["replay the last 10 seconds", [{ type: "seek_by", seconds: -10 }, { type: "play" }]],
      ["go back", [{ type: "seek_by", seconds: -10 }]],
      // jump to a timestamp
      ["skip to 12:30", [{ type: "seek_to", seconds: 750 }]],
      ["can you go to minute 5", [{ type: "seek_to", seconds: 300 }]],
      ["jump to 1 hour 2 minutes", [{ type: "seek_to", seconds: 3720 }]],
      ["take me to the 10 minute mark", [{ type: "seek_to", seconds: 600 }]],
      ["go to 12 minutes and 30 seconds", [{ type: "seek_to", seconds: 750 }]],
      ["start over", [{ type: "seek_to", seconds: 0 }]],
      ["go back to the beginning", [{ type: "seek_to", seconds: 0 }]],
      ["jump to 1:02:03", [{ type: "seek_to", seconds: 3723 }]],
      // speed
      ["play at 1.5x", [{ type: "speed", rate: 1.5 }, { type: "play" }]],
      ["can you set the speed to 2 times", [{ type: "speed", rate: 2 }]],
      ["one point five x", [{ type: "speed", rate: 1.5 }]],
      ["speed up", [{ type: "speed_by", delta: 0.25 }]],
      ["slow down", [{ type: "speed_by", delta: -0.25 }]],
      ["normal speed", [{ type: "speed", rate: 1 }]],
      ["double speed", [{ type: "speed", rate: 2 }]],
      // volume
      ["mute", [{ type: "mute" }]],
      ["unmute the video", [{ type: "unmute" }]],
      ["louder", [{ type: "volume_by", delta: 0.2 }]],
      ["turn it down", [{ type: "volume_by", delta: -0.2 }]],
      ["set the volume to 50 percent", [{ type: "volume", level: 0.5 }]],
      // combined
      ["go back 30 seconds and play", [{ type: "seek_by", seconds: -30 }, { type: "play" }]],
      ["skip to 10:00 then play at 1.5x", [{ type: "seek_to", seconds: 600 }, { type: "speed", rate: 1.5 }, { type: "play" }]],
      ["pause and turn it down", [{ type: "pause" }, { type: "volume_by", delta: -0.2 }]],
      // NOT commands (go to the AI)
      ["what is recursion", null],
      ["can you explain what he just said", null],
      ["go to where he talks about recursion", null],
      ["why did he stop at the base case", null],
      ["what's the difference between play and pause in the example", null],
      ["pause and explain this", null],
    ];
    let pass = 0;
    for (const [input, want] of cases) {
      const got = parse(input);
      const ok = JSON.stringify(got) === JSON.stringify(want);
      if (ok) pass++;
      console.log(`${ok ? "  ok  " : "  FAIL"} ${JSON.stringify(input)} -> ${JSON.stringify(got)}${ok ? "" : `   (want ${JSON.stringify(want)})`}`);
    }
    // AI reply format
    const r = parseReply("Command: seek_to 7:48\nSay: Jumping to 7:48, where he defines recursion.\nWatch: 12:03, brief mention");
    const rOk = JSON.stringify(r.actions) === JSON.stringify([{ type: "seek_to", seconds: 468 }]) && r.say.startsWith("Jumping") && r.rest.startsWith("Watch:");
    if (rOk) pass++;
    console.log(`${rOk ? "  ok  " : "  FAIL"} parseReply -> ${JSON.stringify(r)}`);
    const d = describe([{ type: "seek_by", ok: true, time: 570 }, { type: "play", ok: true }]);
    const dOk = d === "Jumped to 9:30 and playing.";
    if (dOk) pass++;
    console.log(`${dOk ? "  ok  " : "  FAIL"} describe -> ${d}`);
    const total = cases.length + 2;
    console.log(`\n[Nova] commands.js: ${pass}/${total} tests passed`);
    process.exitCode = pass === total ? 0 : 1;
  }
})(globalThis);
