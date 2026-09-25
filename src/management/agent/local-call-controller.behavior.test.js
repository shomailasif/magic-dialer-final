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
const BARGE_YIELD_CONTRACT = { ok: /const BARGE_YIELD_MS = 700;/.test(controllerSrc) };

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

  let pushes = 0;
  const deps = {
    async preflightBrain() { return true; },
    async opening() { return { text: "Hello" }; },
    createLocalRingCentralEngine(opts) {
      sipSeen = opts.sip;
      onAudio = opts.onAudio;
      assert.equal(typeof opts.onSessionGone, "function", "engine must receive onSessionGone for remote BYE");
      return { ...engine, async waitForInboundMedia() { return { gotInbound: true, waitedMs: 5 }; } };
    },
    createVad() {
      return { push() {
        pushes++;
        // Frames 1-50 cover the protected-opening 1s guard. 51-85 are loud
        // speech whose level swings (never flat like a ringback carrier) so
        // the steady-tone barge-in guard must still let real speech through.
        if (pushes <= 50) return { voiced: false, speaking: false, ended: false, level: 0 };
        if (pushes <= 85) return { voiced: true, speaking: pushes >= 58, ended: false, level: 500 + ((pushes % 5) * 120) };
        return { voiced: false, speaking: true, ended: pushes >= 89, level: 0 };
      }};
    },
    async speakToBuffer() {
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
      // 1s guard must elapse in real time before speech is allowed to barge.
      for (let i = 0; i < 50; i++) onAudio(frame());
      await sleep(1030);
      for (let i = 51; i <= 85; i++) onAudio(frame());
      for (let i = 86; i <= 89; i++) onAudio(frame());
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
  assert.equal(pushes, 89, "inbound audio must continue through playback and listening without dropping frames");
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
        const speaking = speakFn(opening || "Hello");
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
  await scenarioSpeechBargeIn(logs);

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
  // half-finished delivery being complained about.
  assert.ok(BARGE_YIELD_CONTRACT.ok, "barge-in yield must stay at 700ms");

  console.log("PASS: controller opening barge-in, steady-tone guard, junk STT, remote hangup, greeting lead, empty STT, unspeakable turn, turn cap, non-Latin refusal");
}
main().catch(e => { console.error(e); process.exit(1); });
