"use strict";

const assert = require("node:assert/strict");
const { runLocalCall } = require("./local-call-controller");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const frame = () => Buffer.alloc(160, 0x7f);
const collector = logs => line => logs.push(String(line));

/* 300ms barge-in was tried and reverted: on the 21:05Z call it guillotined the
 * agent five times in two minutes (3610ms played of 6160ms intended). Pin it so
 * the "rushed, half-finished sentence" delivery cannot come back. */
const controllerSrc = require("node:fs").readFileSync(require.resolve("./local-call-controller"), "utf8");
/* The barge-in yield is verified once, in the barge-in scenario, against the
   * module constant. There is no second check here to drift out of sync with it. */
let bargeYieldInEffect = 0;

/** Opening: 1s protected guard, then sustained *speech-like* levels must
 *  barge in exactly once; then a normal turn with RTP keep-alive. */
async function scenarioSpeechBargeIn(logs) {
  let onAudio, interrupted = 0, sttBytes = 0, closed = 0, sipSeen = null, sttOpts = null;
  let finishPlayback = null, sends = 0, keepAlives = 0, ttsCalls = 0;
  const engine = {
    async connect() {},
    sendAudio() {
      sends++;
      // First utterance (opening) plays until the barge-in interrupt lands;
      // later utterances complete on their own like real playback.
      if (sends === 1) return new Promise(resolve => { finishPlayback = () => resolve(3200); });
      return new Promise(resolve => setTimeout(() => resolve(3200), 20));
    },
    interrupt() { interrupted++; if (finishPlayback) finishPlayback(); },
    keepAlive() { keepAlives++; return Promise.resolve(0); },
    close() { closed++; },
  };

  /* The opening resolves on the barge-in interrupt and on nothing else. That is a
   * fair model of real playback, but it means the scenario hangs - silently, and
   * with exit code 0 - if the interrupt never arrives, which is exactly what
   * happened for as long as this file had been in the suite.
   *
   * So the opening ALSO resolves after a hard ceiling. The ceiling is a hang
   * guard, NOT a timing assertion, and it has to sit far outside any legitimate
   * run: at 6s it raced the scenario on the CI runner, where every `sleep(20)`
   * costs several times its nominal value on a loaded box, so the ceiling won
   * before the speech had accumulated its 400ms and the test failed with
   * "sustained prospect speech must interrupt playback exactly once" - which
   * reads like a barge-in regression and is really a badly chosen timeout. It
   * passed locally and failed in CI, which is the signature of a race.
   *
   * The real bound is the `step()` timeout around this scenario, which is
   * generous and named. This ceiling only exists so that a genuine controller
   * bug fails with a number instead of stalling the gate. */
  let settleOpening = null;
  engine.sendAudio = function sendAudioWithCeiling() {
    sends++;
    if (sends !== 1) return new Promise((resolve) => setTimeout(() => resolve(3200), 20));
    return new Promise((resolve) => {
      let done = false;
      const ceiling = setTimeout(() => { if (!done) { done = true; resolve(0); } }, 30000);
      settleOpening = (ms) => {
        if (done) return;
        done = true;
        clearTimeout(ceiling);
        resolve(ms);
      };
    });
  };
  const originalInterrupt = engine.interrupt;
  engine.interrupt = function interruptWithCeiling() {
    originalInterrupt();
    if (settleOpening) settleOpening(3200);
  };

  let pushes = 0, talking = false;
  const deps = {
    async preflightBrain() { return true; },
    async opening() { return { text: "Hello" }; },
    createLocalRingCentralEngine(opts) {
      sipSeen = opts.sip;
      onAudio = opts.onAudio;
      assert.equal(typeof opts.onSessionGone, "function", "engine must receive onSessionGone for remote BYE");
      /* Built by assignment rather than by spreading `engine`. A spread COPIES
       * sendAudio and interrupt onto a fresh object, so the overrides installed
       * above would live on the original while the controller called the copies -
       * the interrupt would never settle the opening, and the scenario would hang
       * exactly as it did before, while looking correctly wired in the source. */
      return Object.assign(Object.create(Object.getPrototypeOf(engine)), engine, {
        async waitForInboundMedia() { return { gotInbound: true, waitedMs: 5 }; },
      });
    },
    createVad() {
      return { push() {
        pushes++;
        /* Frames 1-50 cover the playback guard, so nothing is voiced yet and the
         * controller resets its barge window on each.
         *
         * After that the prospect is TALKING and keeps talking until the fixture
         * says otherwise - driven by `talking`, not by a frame count. The level
         * SWINGS, because the steady-tone guard samples 12 levels and refuses to
         * barge in on a flat window; that is what stopped a ringback carrier
         * from chopping the opening, and a flat level here would correctly be
         * ignored.
         *
         * It was previously a fixed 51-95 range, which quietly assumed the
         * prospect stops talking at frame 95. When the barge needed more frames
         * than that, the fixture went silent, the counter reset, and the scenario
         * reported zero interrupts - on CI, twice, while passing locally. The
         * conversation has to end when the conversation ends. */
        if (!talking || pushes <= 50) return { voiced: false, speaking: talking, ended: false, level: 0 };
        return { voiced: true, speaking: true, ended: false, level: 500 + ((pushes % 5) * 120) };
      }};
    },    async speakToBuffer() {
      ttsCalls++;
      // Non-opening synthesis is slow in reality; the keep-alive interval
      // (1200ms) must fire inside that window.
      if (ttsCalls >= 2) await sleep(1250);
      return { buffer: Buffer.alloc(3200, 0xff), engine: "test" };
    },
    async transcribeAuto(audio, opts) { sttBytes = audio.length; sttOpts = opts; return { text: "please wait", language: "en" }; },
    async voiceCall({ speakFn, listenFn }) {
      const speaking = speakFn("Hello");
      await sleep(0);
      /* EVERY frame arrives at 20ms intervals, never in a synchronous burst.
       *
       * The controller decides barge-in partly from wall-clock time
       * (`Date.now() - playbackStartedAt`) and deliberately ignores everything in
       * the first second of playback. Pushing frames in one tick advanced the
       * frame counter while the clock stood still, so the guard never elapsed and
       * this scenario hung forever - silently, with exit code 0, because nothing
       * else held the event loop open. That is why an assertion in this file
       * claimed 700ms while the code said 400ms for as long as it sat behind
       * that hang.
       *
       * Then the prospect talks until the interrupt actually lands. Pacing alone
       * was not enough and CI proved it: this passed locally and reported zero
       * interrupts there, twice. The scenario depended on 50 paced frames
       * reliably exceeding the controller's 1000ms guard, and a timer that
       * returns even slightly early makes that a coin flip. A test whose
       * pass/fail turns on how well a sleep overshoots is not testing the
       * controller.
       *
       * What is left to assert is the property that actually matters: sustained
       * speech interrupts playback, exactly once, and not again. */
      const feed = async (n) => { for (let i = 0; i < n; i++) { onAudio(frame()); await sleep(20); } };
      await feed(50);
      talking = true;
      for (let guard = 0; guard < 300 && interrupted === 0; guard++) await feed(1);
      talking = false;
      await feed(10);
      await speaking;
      const heard = await listenFn({ locale: "en" });
      assert.equal(heard.text, "please wait");
      await speakFn("Thanks - one quick question.");
      return { heard: heard.text };
    },
  };

  const result = await runLocalCall({
    config: { voip: { ready: true, username: "u", sipPassword: "p", authId: "auth-7", domain: "sip.example.test", server: "proxy.example.test", port: 5096, number: "1" }, product: "test", portalUrl: "https://portal.example.test", deviceToken: "device-secret" },
    number: "2", deps, onLog: collector(logs)
  });
  assert.equal(interrupted, 1, "sustained prospect speech must interrupt playback exactly once");
  assert.ok(pushes >= 70, `inbound audio must continue through playback and listening, only ${pushes} frames arrived`);
  assert.ok(sttBytes >= 160, "prospect audio must reach STT");
  assert.equal(result.heard, "please wait");
  assert.ok(sttBytes >= 160 * 30, "captured turn must retain speech frames through barge-in");
  assert.equal(closed, 1, "engine must close");
  assert.ok(keepAlives >= 1, "RTP keep-alive must run while non-opening TTS synthesizes");
  assert.equal(sipSeen.authId, "auth-7"); assert.equal(sipSeen.domain, "sip.example.test"); assert.equal(sipSeen.proxy, "proxy.example.test");
  assert.equal(sttOpts.portal, "https://portal.example.test"); assert.equal(sttOpts.deviceToken, "device-secret");
  assert.ok(!logs.some(l => l.includes("steady carrier tone")), "real speech must not be mistaken for a carrier tone");
}

/** A flat ringback/voicemail carrier must NOT barge in, and the STT junk it
 *  produces ("phone ringing.") must not become a lead turn. */
async function scenarioSteadyTone(logs) {
  let onAudio, interrupted = 0, heard = "unset";
  const engine = {
    async connect() {},
    sendAudio() { return new Promise(resolve => setTimeout(() => resolve(3200), 1400)); },
    interrupt() { interrupted++; },
    keepAlive() { return Promise.resolve(0); },
    close() {},
  };
  let pushes = 0;
  const deps = {
    async preflightBrain() { return true; },
    async opening() { return { text: "Hello" }; },
    createLocalRingCentralEngine(opts) { onAudio = opts.onAudio; return { ...engine, async waitForInboundMedia() { return { gotInbound: true, waitedMs: 5 }; } }; },
    createVad() {
      return { push() {
        pushes++;
        if (pushes <= 50) return { voiced: false, speaking: false, ended: false, level: 0 };
        if (pushes <= 110) return { voiced: true, speaking: true, ended: pushes >= 110, level: 600 };
        return { voiced: false, speaking: false, ended: true, level: 0 };
      }};
    },
    async speakToBuffer() { return { buffer: Buffer.alloc(3200, 0xff), engine: "test" }; },
    async transcribeAuto() { return { text: "phone ringing.", language: "en" }; },
    async voiceCall({ speakFn, listenFn }) {
      const speaking = speakFn("Hello");
      await sleep(0);
      for (let i = 0; i < 50; i++) onAudio(frame());
      await sleep(1030);
      for (let i = 51; i <= 110; i++) onAudio(frame());
      await speaking;
      heard = await listenFn({ locale: "en" });
      return { heard };
    },
  };
  await runLocalCall({
    config: { voip: { ready: true, username: "u", sipPassword: "p", number: "1" }, product: "test" },
    number: "2", deps, onLog: collector(logs)
  });
  assert.equal(interrupted, 0, "flat carrier tone must not barge into the opening");
  assert.ok(!heard || !heard.text, "ringback STT junk must not become a lead turn");
  assert.equal(heard && heard.junk, true, "carrier junk must be reported as junk, not as a quiet window");
  assert.ok(logs.some(l => l.includes("steady carrier tone")), "steady-tone guard must be logged once");
  assert.ok(logs.some(l => l.includes("STT junk ignored")), "junk STT must be logged as ignored");
}

/** Drive one listen window against a stub recognizer and hand back exactly what
 *  call-runner would receive. Shared by the greeting / empty-STT cases. */
async function driveListenWindow({ stt, tts, opening }) {
  let onAudio, heard = "unset", sends = 0, threw = null, ttsTurns = 0;
  const spoken = [];
  const ttsTexts = [];
  const logs = [];
  const engine = {
    async connect() {},
    sendAudio() { sends++; return new Promise(resolve => setTimeout(() => resolve(3200), 1400)); },
    interrupt() {},
    keepAlive() { return Promise.resolve(0); },
    close() {},
  };
  let pushes = 0;
  const deps = {
    async preflightBrain() { return true; },
    async opening() { return { text: "Hello" }; },
    createLocalRingCentralEngine(opts) { onAudio = opts.onAudio; return { ...engine, async waitForInboundMedia() { return { gotInbound: true, waitedMs: 5 }; } }; },
    createVad() {
      return { push() {
        pushes++;
        if (pushes <= 50) return { voiced: false, speaking: false, ended: false, level: 0 };
        if (pushes <= 110) return { voiced: true, speaking: true, ended: pushes >= 110, level: 600 };
        return { voiced: false, speaking: false, ended: true, level: 0 };
      }};
    },
    async speakToBuffer(text) {
      // Preflight + opening must succeed; only the later turn is unspeakable.
      ttsTurns++;
      ttsTexts.push(String(text));
      return tts === undefined || ttsTurns <= 1 ? { buffer: Buffer.alloc(3200, 0xff), engine: "test" } : tts;
    },
    async transcribeAuto() { return stt; },
    async voiceCall({ speakFn, listenFn }) {
      try {
        /* The opening is Latin script on purpose. This scenario exists to prove
         * that an UNSPEAKABLE LATER turn does not end the call, and an unspeakable
         * OPENING would fail the same check for a different reason: the controller
         * refuses to put Devanagari or Arabic through an English voice at all
         * (the 21:05Z call did exactly that), so `sends` stayed at 0 and the
         * "only the opening may reach the wire" assertion could never have held.
         *
         * That assertion has been dead as long as the file has: main() hung in
         * an earlier scenario and exited 0 before reaching here, so it was never
         * run against anything. It is worth being explicit that it was already
         * wrong rather than newly broken. */
        const speaking = speakFn(opening || "Hi, this is Atlas with Zaz Logistics. Is now a good time to talk?");
        await sleep(0);
        for (let i = 0; i < 50; i++) onAudio(frame());
        await sleep(1030);
        for (let i = 51; i <= 110; i++) onAudio(frame());
        await speaking;
        // The second turn is the one that must survive an unspeakable script.
        await speakFn("\u06a9\u06cc\u0627 \u0646\u0627\u0645 \u06c1\u06d2\u061f");
        heard = await listenFn({ locale: "en" });
        return { heard };
      } catch (e) {
        threw = e && e.message ? e.message : String(e);
        return { heard };
      }
    },
  };
  await runLocalCall({
    config: { voip: { ready: true, username: "u", sipPassword: "p", number: "1" }, product: "test" },
    number: "2", deps, onLog: collector(logs),
  });
  return { heard, logs, sends, threw, spoken, ttsTexts };
}

/** Remote BYE: listen reports ended, and no further outbound audio is sent. */
async function scenarioRemoteHangup(logs) {
  let onGone = null, sends = 0, ttsCalls = 0;
  const engine = {
    async connect() {},
    sendAudio() { sends++; return new Promise(resolve => setTimeout(() => resolve(3200), 100)); },
    interrupt() {},
    keepAlive() { return Promise.resolve(0); },
    close() {},
  };
  const deps = {
    async preflightBrain() { return true; },
    async opening() { return { text: "Hello" }; },
    createLocalRingCentralEngine(opts) {
      onGone = opts.onSessionGone;
      return { ...engine, async waitForInboundMedia() { return { gotInbound: true, waitedMs: 5 }; } };
    },
    createVad() { return { push: () => ({ voiced: false, speaking: false, ended: false, level: 0 }) }; },
    async speakToBuffer() { ttsCalls++; return { buffer: Buffer.alloc(3200, 0xff), engine: "test" }; },
    async transcribeAuto() { throw new Error("must not run STT after remote hangup"); },
    async voiceCall({ speakFn, listenFn }) {
        const speaking = speakFn("Hello");
      await sleep(0);
      await speaking;
      onGone();  // remote BYE
      const heard = await listenFn({ locale: "en" });
      const sendsBefore = sends, ttsBefore = ttsCalls;
      await speakFn("this must never reach the network");
      return { heard, sends: sends - sendsBefore, tts: ttsCalls - ttsBefore };
    },
  };
  const out = await runLocalCall({
    config: { voip: { ready: true, username: "u", sipPassword: "p", number: "1" }, product: "test" },
    number: "2", deps, onLog: collector(logs)
  });
  assert.equal(out.heard.ended, true, "listen must report ended after remote hangup");
  assert.equal(out.heard.text, null, "no transcript after remote hangup");
  assert.equal(out.sends, 0, "no outbound audio after remote hangup");
  assert.equal(out.tts, 0, "no TTS synthesis after remote hangup");
  assert.ok(logs.some(l => l.includes("remote hangup")), "remote hangup must be logged");
}

  async function main() {
    const logs = [];

    /* A test that hangs is worse than a test that fails.
     *
     * This file silently exited 0 for a long time. main() awaited
     * scenarioSpeechBargeIn, which awaits `speakFn(...)`; the stub's engine
     * resolves sendAudio only when the barge-in interrupt fires, so if no
     * interrupt ever fires the promise never settles - and because nothing else
     * held the event loop open, node exited with code 0 and printed NOTHING.
     *
     * Every assertion after that point had therefore never run, including the
     * barge-in yield and the VAD end-of-silence checks. The regression runner
     * saw exit 0 and recorded a pass.
     *
     * So a hang is now an explicit failure with a name, not a silent exit.
     *
     * The budget is generous on purpose. This scenario legitimately takes ~10s:
     * the listen window waits out its full 5s of quiet before it will close, and
     * non-opening TTS synthesis is stubbed at 1250ms. A budget that treated that
     * as a hang would be wrong in the other direction. The engine stub also caps
     * its own playback at 6s, so a controller that never interrupts fails an
     * assertion with a number instead of stalling. */
    const step = async (name, fn, ms) => {
      /* Generous on purpose, and generous for BOTH reasons this scenario is slow:
       * the listen window waits out its full 5s of quiet before it will close,
       * and every frame is paced at 20ms so the controller's own wall-clock
       * checks are exercised honestly. On a loaded CI runner each of those
       * sleeps costs several times its nominal value, so a budget that fitted
       * the local machine failed there. A hang guard that fires on a slow
       * machine is indistinguishable from a hang, and only teaches people to
       * ignore it. */
      const budget = Number(ms || process.env.BEHAVIOR_TEST_TIMEOUT_MS) || 120000;
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(fn),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`step "${name}" did not finish within ${budget}ms - the test hung, not the code under test`)), budget); }),
        ]);
      } catch (e) {
        throw new Error(`step "${name}" failed: ${e && e.message}`);
      } finally {
        clearTimeout(timer);
      }
    };

    /* The barge-in yield, read from the code rather than restated. It was
     * asserted as 700ms while the controller declares 400 - and that assertion
     * never ran, so the contradiction went unnoticed. Read the real number and
     * assert the property instead: a yield below 400ms guillotines our own
     * sentences, and 300ms cut five of them on the 21:05Z call. */
    const bargeYield = Number((/const BARGE_YIELD_MS = (\d+);/.exec(controllerSrc) || [])[1]);
    assert.ok(bargeYield >= 400, `barge-in yield is ${bargeYield}ms; below 400ms guillotines our own speech`);
    bargeYieldInEffect = bargeYield;

    await step("opening barge-in", () => scenarioSpeechBargeIn(logs));
    await step("steady-tone barge-in guard", () => scenarioSteadyTone(logs));

    /* The VAD guard, inverted.
     *
     * This asserted `declaredSilence >= 700`, which is precisely the assertion
     * that kept the adaptive schedule unreachable: the controller pinned
     * endSilenceMs at 700, createVad treats any explicit value as an override,
     * and the floor-and-patience schedule in vad.js never ran on a live call.
     * The test passed by documenting the defect rather than failing on it.
     *
     * The controller now passes no endSilenceMs at all, so the assertion is its
     * absence. The schedule itself is range-checked in vad-adaptive-eos and
     * vad-turn-boundary. */
    const pinnedSilence = /makeVad\(\{[^}]*endSilenceMs:\s*(\d+)/.exec(controllerSrc);
    assert.equal(pinnedSilence, null,
      `the controller pins endSilenceMs at ${pinnedSilence && pinnedSilence[1]}ms, which DISABLES the adaptive schedule in vad.js; omit it so the adaptive default applies`);
    {
      const src = require("node:fs").readFileSync(require.resolve("./local-call-controller"), "utf8");
      assert.match(src, /function isUsableOpening\(/, "the opening must be validated before it is spoken");
      assert.match(src, /isUsableOpening\(openingText, config\)/, "a bad opening must be caught where it is fetched");
      assert.match(src, /s\.length < 25/, "a too-short opening must be rejected");
      const i = src.indexOf("function isJunkUtterance");
      const j = src.indexOf("/** Push one voiced level", i);
      // eslint-disable-next-line no-new-func
      const isJunkUtterance = new Function(src.slice(i, j) + "; return isJunkUtterance;")();
      for (const t of ["PHONE RINGS", "phone rings", "phone ringing.", "the phone is ringing", "ringing."]) {
        assert.equal(isJunkUtterance(t), true, JSON.stringify(t) + " is a ringback tone, not a prospect");
      }
      for (const t of ["Yes, ten trucks.", "Hello.", "My name is Jaswinder."]) {
        assert.equal(isJunkUtterance(t), false, JSON.stringify(t) + " is real speech and must be kept");
      }
    }
    /* scenarioSpeechBargeIn already ran under `step` above; running it twice
     * double-counted the pushes and barge-ins it asserts on. */


  let engineAttempted = false;
  await assert.rejects(
    () => runLocalCall({
      config: { voip: { ready: true, username: "u", sipPassword: "p", number: "1" }, product: "test" },
      number: "2",
      deps: {
        async preflightBrain() { return true; },
        async opening() { return { text: "Hello" }; },
        async speakToBuffer() { return null; },
        createLocalRingCentralEngine() { engineAttempted = true; return {}; },
      },
    }),
    /TTS preflight failed/
  );
    assert.equal(engineAttempted, false, "failed TTS preflight must block engine creation and dialing");

    // A gateway blip must not refuse the call. The brain preflight and the
    // opening run in parallel, so one can get a clean READY while the other gets
    // a 502 - and on the 20:10Z call the whole call was refused instead of
    // dialled. Refusing to dial is worse than opening in a plain line.
    let blankOpeningDialed = false;
    let spokenOpening = null;
    try {
      await runLocalCall({
        config: {
          voip: { ready: true, username: "u", sipPassword: "p", number: "1" },
          product: "test",
          persona: { name: "Atlas" },
          companyName: { name: "Zaz Logistics" },
        },
        number: "2",
        deps: {
          async preflightBrain() { return true; },
          async opening() { return { text: "", error: "AI gateway returned non-JSON (HTTP 502)" }; },
          async speakToBuffer(text) { spokenOpening = String(text); return { engine: "test", buffer: Buffer.alloc(320) }; },
          createLocalRingCentralEngine() { blankOpeningDialed = true; return { async connect() { return {}; }, async waitForInboundMedia() { return { gotInbound: false, waitedMs: 1 }; }, send() {}, close() {} }; },
        },
      });
    } catch (e) {
      // The stub does not run a real call; the preflight behaviour is what is
      // under test, so anything past engine creation is acceptable here.
    }
    assert.equal(blankOpeningDialed, true, "an empty opening must not refuse the call");
    assert.ok(/Atlas/.test(spokenOpening || ""), "the local fallback opening must be spoken, got: " + JSON.stringify(spokenOpening));
    assert.ok(!/\[object Object\]/.test(spokenOpening || ""), "the fallback opening must never contain [object Object]");


  let engineCreated = false;
  await assert.rejects(
    () => runLocalCall({
      config: { voip: { ready: true, username: "u", sipPassword: "bad", number: "1" }, product: "test" },
      number: "2",
      deps: {
        async preflightBrain() { return true; },
        async opening() { return { text: "Hello" }; },
        async speakToBuffer() { await sleep(50); return { buffer: Buffer.alloc(3200, 0xff), engine: "test" }; },
        createLocalRingCentralEngine() {
          engineCreated = true;
          return { async connect() { throw new Error("403 Forbidden"); } };
        },
      },
    }),
    /403 Forbidden/
  );
  assert.equal(engineCreated, true, "live engine must own SIP registration attempt");

  const toneLogs = [];
  await scenarioSteadyTone(toneLogs);
  const byeLogs = [];
  await scenarioRemoteHangup(byeLogs);

  // Regression: a prospect who answers with a greeting was being thrown away
  // as junk and then counted as a silent window, so we hung up on them.
  const greet = await driveListenWindow({ stt: { text: "Hello?", language: "en" } });
  assert.equal(greet.heard && greet.heard.text, "Hello?", "a prospect greeting must become a real lead turn");
  assert.ok(!greet.logs.some(l => l.includes("STT junk ignored")), "a greeting must never be dropped as junk");

  const empty = await driveListenWindow({ stt: { text: "", language: "en" } });
  assert.equal(empty.heard && empty.heard.text, null, "untranscribed speech must not become a lead turn");
  assert.equal(empty.heard && empty.heard.empty, true, "untranscribed speech must report captured-but-empty, not a quiet window");
  assert.ok(empty.logs.some(l => l.includes("STT returned empty for captured speech")), "empty-STT retry must be logged");

  // A turn whose text cannot be synthesized must NOT end a live call. The
  // 20:25Z call died 105s in with "TTS produced no valid PCMU/8000 telephone
  // audio" because the agent had switched to a voice that cannot speak the
  // prospect's script.
  const dead = await driveListenWindow({ stt: { text: "Yes, I can hear you.", language: "en" }, tts: null });
  assert.equal(dead.threw, null, "an unspeakable turn must not reject the call");
  assert.equal(dead.heard && dead.heard.text, "Yes, I can hear you.", "the call must keep going after a skipped turn");
  assert.equal(dead.sends, 1, "only the opening may reach the wire; the unspeakable turn must send nothing");
  assert.ok(
    dead.logs.some(l => l.includes("not speaking it") || l.includes("skipping turn")),
    "the skipped turn must be logged"
  );

  // Text the active voice genuinely cannot read must never reach the wire: the
  // 21:05Z call put Devanagari and Arabic through an English voice, which is
  // what produced "the dumb AI is not understanding what I'm saying".
  assert.ok(
    dead.logs.some(l => /mostly non-Latin/.test(l)),
    `a non-Latin turn for an English call must be refused, logs: ${JSON.stringify(dead.logs.filter(l => /non-Latin|tts/.test(l)))}`
  );
  assert.equal(dead.ttsTexts.length, 1, `only the opening may be synthesized, got ${JSON.stringify(dead.ttsTexts)}`);

  // A turn longer than a person would listen to must be trimmed to whole words
  // and whole sentences. The 20:44Z call ran a 229-character / 14.1-second
  // monologue over a prospect who was trying to reply.
  const capped = await driveListenWindow({
    stt: { text: "Yes, I can hear you.", language: "en" },
    opening: "Sure! Zaz Logistics offers dispatch services that help you find loads, handle paperwork, and keep your routes efficient-all coordinated by our team so you can focus on the road. Would you like me to send a brief overview by text?",
  });
  const long = capped.ttsTexts[capped.ttsTexts.length - 1];
  assert.ok(long, `a turn must still be synthesized, got ${JSON.stringify(capped.ttsTexts)}`);
  assert.ok(long.length <= 160, `an over-long turn must be capped, got ${long.length} chars: ${JSON.stringify(long)}`);
  assert.ok(/[.!?]["')\u2019]?$/.test(long.trim()), `the cap must not cut mid-sentence, got: ${JSON.stringify(long)}`);
  assert.ok(!/\bveh$|\btyp$|\bfor$/.test(long.trim()), `the cap must not cut mid-word, got: ${JSON.stringify(long)}`);

  // Barge-in must not guillotine us. 300ms cut five sentences short on the
  // 21:05Z call (3610ms played of 6160ms intended), which is the rushed
  // half-finished delivery being complained about. The real declared value was
  /* The floor is asserted where the value is read, above, against the module
   * constant rather than a literal. This used to be a BARGE_YIELD_CONTRACT
   * object initialised from a hardcoded 700 - a value production no longer has -
   * and then set to `true` immediately after the real assertion had already
   * passed. It could therefore only fail if the line above it had already
   * failed: dead scaffolding that looked like a second, independent guard.
   *
   * All that remains is reporting the value that was actually verified. */
  console.log("  barge-in yield in effect: " + bargeYieldInEffect + "ms");

  // Response latency and truncation pull in opposite directions. Speech that
  // resumes inside the hold must be appended to the SAME window rather than
  // starting a new turn - otherwise raising the timeout to stop truncation is
  // what makes the agent sound slow on every turn.
  assert.ok(/const SPEECH_HOLD_MS = 2\d\d;/.test(controllerSrc), "a short speech hold must be configured");
  assert.ok(/event\.ended && !state\.done && !state\.holdUntil/.test(controllerSrc), "end of utterance must arm a hold, not resolve immediately");
  assert.ok(/if \(event\.voiced\) state\.holdUntil = 0;/.test(controllerSrc), "resumed speech must cancel the hold and stay in the same utterance");

  console.log("PASS: controller opening barge-in, steady-tone guard, junk STT, remote hangup, greeting lead, empty STT, unspeakable turn, turn cap, non-Latin refusal, speech hold");
}
main().catch(e => { console.error(e); process.exit(1); });
