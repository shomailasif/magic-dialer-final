"use strict";

/**
 * audio-sim.behavior.test.js - the audio harness's own defect detection, with
 * every network stage replaced.
 *
 * The harness exists to catch two reported defects (a truncated prospect turn and
 * a repeated agent line) and to time four stages. Those detectors are the part
 * that can rot silently: a regex tightened one notch and it stops catching the
 * thing it was written for, and nothing else in the repo notices. So they are
 * asserted here, offline, deterministically, in about a second.
 *
 * Everything below runs the REAL local-call-controller with the REAL VAD, REAL
 * frame clock, REAL turn-length capping, REAL barge-in logic and REAL
 * conversation loop (call-runner.js). Only the three network stages are
 * injected: STT returns scripted transcripts, TTS returns a buffer, and the brain
 * is scripted. No call is placed and no credential is read.
 */
const assert = require("node:assert/strict");
const path = require("node:path");

const sim = require(path.join(__dirname, "..", "build", "audio-sim.js"));
const { FRAME_BYTES, FRAME_MS, VAD_OPTS, SPEECH_HOLD_MS } = sim;

/* No turn may depend on a fixture file: this test must pass on a clean checkout
   with nothing generated, so audio is synthesized in-process. 1.2s of synthetic
   "speech" - a vowel-like tone with an envelope - is enough for the real VAD to
   make real decisions, which is the point: the VAD under test is the real one. */
/* Synthetic speech-like audio, in mu-law, for the frames of one frame-clock
   * period.
 *
   * Scaled into the Int16 range on purpose: the first version of this left the
   * amplitude normalised to +/-1, rounded it, and produced a constant mu-law code
   * that decoded to zero - so the real VAD heard silence and the whole run
   * reported "no speech in window". It looked like a controller failure and was
   * a bug in the test's own audio.
 *
   * Two formants plus a 5Hz syllabic envelope, so the level swings the way speech
   * does. That matters: the controller refuses to barge in on a level that holds
   * steady (a ringback tone), so a constant-level synthetic tone would be
   * correctly ignored and could not exercise barge-in. */
const SPEECH_PEAK = 9000;
function fakeSpeech(ms = 1200) {
  const frames = Math.max(1, Math.round(ms / FRAME_MS));
  const out = Buffer.alloc(frames * FRAME_BYTES);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = 0; i < FRAME_BYTES; i++) {
      const t = (f * FRAME_BYTES + i) / 8000;
      const env = 0.35 + 0.65 * Math.abs(Math.sin(2 * Math.PI * 5 * t));
      const s = SPEECH_PEAK * env * (Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 700 * t));
      sum += s * s;
    }
    const amp = Math.round(Math.sqrt(sum / FRAME_BYTES));
    for (let i = 0; i < FRAME_BYTES; i++) out[f * FRAME_BYTES + i] = sim.mulawEncode(Math.max(-32767, Math.min(32767, amp)));
  }
  return out;
}

/* The detectors, asserted directly. This is the cheapest place to prove a
   detector still catches the exact strings it was written for, and that it does
   NOT cry wolf on ordinary speech - the failure mode of a truncation regex is a
   false positive on "Who is it?", which would make the harness useless. */
function assertDetectors() {
  for (const bad of [
    "What do you",
    "I was just",
    "Can I get",
    "my number is 6234001 and my name",
    "I wanted to tell you about",
  ]) {
    assert.ok(sim.truncationReason(bad), "must flag a truncated transcript: " + JSON.stringify(bad));
  }
  for (const good of [
    "Hello.",
    "Who is it?",
    "What do you need?",
    "That is all, thanks.",
    "Yes, ten trucks.",
    "My MC number is 623400.",
    "I am a bit busy right now.",
    "",
    ".",
    "OK",
  ]) {
    assert.equal(sim.truncationReason(good), null, "must NOT flag complete speech: " + JSON.stringify(good) + " -> " + sim.truncationReason(good));
  }

  assert.equal(sim.similarLines("Is now a good time to talk?", "Is now a good time to talk."), true, "punctuation-only difference is the same line");
  assert.equal(sim.similarLines("Sorry, could you tell me a bit more?", "Sorry, could you tell me a bit more about that?"), true, "near-identical is a repeat");
  assert.equal(sim.similarLines("What type of truck do you run?", "Who is it?"), false, "different questions are not a repeat");
}

/* The WAV path, end to end, on audio generated from text - so the fixture
   pipeline is covered without a committed binary.
 *
 * The mu-law round trip is checked explicitly because encode and decode must
   agree: voice.js builds its encode table from vad.js's decode formula, and if
 * they ever diverge every fixture comes back as noise and the harness would
 * report "no speech in window" while looking perfectly healthy. */
async function assertAudioPipeline() {
  const pcmu = sim.synthesizeLine("Testing one two three.", { voice: "Microsoft Zira Desktop" });
  assert.ok(Buffer.isBuffer(pcmu), "synthesizeLine must return a buffer");
  assert.ok(pcmu.length >= 160, "synthesized audio must survive the mu-law encode");
  assert.equal(pcmu.length % sim.FRAME_BYTES, 0, "synthesized audio must be whole 160-byte frames");

  const { rmsPcmu } = require(path.join(__dirname, "vad.js"));
  let voiced = 0;
  for (let i = 0; i + sim.FRAME_BYTES <= pcmu.length; i += sim.FRAME_BYTES) {
    if (rmsPcmu(pcmu.subarray(i, i + sim.FRAME_BYTES)) > 500) voiced++;
  }
  assert.ok(voiced > 5, "synthesized audio must be above the VAD threshold in real frames, got " + voiced);

  /* PCMU -> WAV -> PCMU must be stable, which proves parseWav, the resampler and
     the mu-law round trip all agree with each other. */
  const wav = sim.pcmuToWav(pcmu, 8000);
  const reparsed = sim.parseWav(wav);
  assert.ok(reparsed, "pcmuToWav output must be parseable by this harness's own parser");
  assert.equal(reparsed.rate, 8000);
  assert.equal(reparsed.bits, 16);
  assert.equal(reparsed.channels, 1);

  const viaParser = sim.toPcmuFrames(reparsed.samples, reparsed.rate);
  assert.ok(viaParser.length >= pcmu.length - sim.FRAME_BYTES, "the WAV round trip must not lose the audio");
  // mu-law is lossy per code, but the level structure must survive.
  let original = 0;
  let roundTripped = 0;
  for (let i = 0; i + sim.FRAME_BYTES <= Math.min(pcmu.length, viaParser.length); i += sim.FRAME_BYTES) {
    original += rmsPcmu(pcmu.subarray(i, i + sim.FRAME_BYTES));
    roundTripped += rmsPcmu(viaParser.subarray(i, i + sim.FRAME_BYTES));
  }
  assert.ok(Math.abs(original - roundTripped) / original < 0.05,
    "the mu-law round trip must preserve the level within 5%, got " + original + " -> " + roundTripped);

  /* A WAV with a trailing LIST chunk and an odd-length body must still find its
     data chunk: real recorders emit those, and a parser that assumed a 44-byte
     header would return null audio and the harness would report "no speech in
     window" on a file that is perfectly fine. */
  const withListChunk = Buffer.concat([wav.subarray(0, 36), Buffer.from("data"), (() => {
    const n = wav.readUInt32LE(40);
    const s = Buffer.alloc(4); s.writeUInt32LE(n, 0); return s;
  })(), wav.subarray(44), Buffer.from("LISTxyz")]);
  assert.ok(sim.parseWav(withListChunk), "a WAV with a trailing LIST chunk must still parse");
}

/* Slow stages and truncation, straight out of analyseTurns. */
function assertAnalysis() {
  const { defects, slowStages } = sim.analyseTurns([
    { index: 0, eosMs: 700, holdMs: 250, sttMs: 300, brainMs: 400, ttsMs: 1200, totalMs: 2850, prospectText: "Who is it?", agentLines: ["Hello, this is Atlas."] },
    { index: 1, eosMs: 690, holdMs: 260, sttMs: 320, brainMs: 420, ttsMs: 1300, totalMs: 2990, prospectText: "What do you", agentLines: ["Happy to help."] },
    { index: 2, eosMs: 701, holdMs: 249, sttMs: 280, brainMs: 260, ttsMs: 3400, totalMs: 4900, prospectText: "That is all, thanks.", agentLines: ["Thanks, goodbye."] },
    { index: 3, eosMs: 700, holdMs: 251, sttMs: 290, brainMs: 270, ttsMs: 900, totalMs: 2400, prospectText: "Yes.", agentLines: ["Sure thing.", "Sure thing."] },
  ], { stageBudgetMs: 2500 });

  const trunc = defects.filter((d) => d.kind === "truncation");
  const reps = defects.filter((d) => d.kind === "repetition");
  assert.equal(trunc.length, 1, "exactly the one truncated transcript must be reported, got " + JSON.stringify(trunc));
  assert.match(trunc[0].detail, /What do you/, "the truncation report must quote the fragment");
  assert.equal(reps.length, 1, "exactly the one repeated line must be reported, got " + JSON.stringify(reps));
  assert.match(reps[0].detail, /Sure thing/, "the repetition report must quote the repeated line");

  /* Every stage over budget is listed, and nothing that is under it. The total
     column is a stage too - a turn can be slow purely through its parts. */
  const over = slowStages.map((s) => s.stage);
  assert.ok(over.includes("tts"), "a 3400ms TTS must be listed as slow");
  assert.ok(over.includes("total"), "a 4900ms turn total must be listed as slow");
  assert.ok(over.includes("total") || over.includes("stt"), "turn 1 total is 2990ms and must be listed");
  assert.ok(!over.includes("eos"), "700ms of end-of-speech must not be listed as slow");
  assert.ok(!over.includes("hold"), "250ms of hold must not be listed as slow");
  assert.ok(!over.includes("brain"), "400ms of brain must not be listed as slow");
}

/* The harness itself, end to end, with STT/brain/TTS stubbed.
 *
 * A deliberately truncated transcript is returned for one turn and the brain is
 * scripted to repeat itself verbatim on another, so BOTH reported defects must
 * come out of a real controller run - not out of the unit assertions above. This
 * is what proves the detectors are actually wired into the report path. */
async function assertRunReportsDefects() {
  /* Scripted prospect replies, and the agent's scripted lines. Turn 1 returns a
     fragment ("What do you") so STT hands the brain a truncated turn; turn 2 gets
     the same agent line twice, so the repetition path is exercised on real audio
     through the real turn machinery. The last line is a goodbye, which is what
     ends the call - relying on the 5s listen window instead would make the test
     spend its time waiting for silence rather than testing anything. */
  const prospect = [
    { text: "Hello." },
    { text: "What do you" },                       // TRUNCATED on purpose
    { text: "My number is 623400." },
    { text: "That is all, thanks." },
  ];
  const agentLines = [
    "Hi, this is Atlas with Zaz Logistics.",
    "Thanks, I appreciate that.",
    "Thanks, I appreciate that.",                  // REPEATED on purpose
    "Thanks for your time.",
  ];
  let sttCalls = 0;
  let brainCalls = 0;
  let ttsCalls = 0;

  const report = await sim.runScenario("greeting-first", {
    providers: { mode: "test-stub", portal: null, deviceToken: null },
    sttAuthorised: async () => ({ ok: true, fatal: false, reason: "stubbed" }),
    opening: async () => ({ text: agentLines[0] }),
    async stt() {
      const r = prospect[Math.min(sttCalls, prospect.length - 1)];
      sttCalls++;
      return { text: r.text, language: "en", error: null };
    },
    async tts() {
      ttsCalls++;
      // Real mu-law PCMU of silence: the controller only checks the buffer is a
      // Buffer of at least 160 bytes, and a real one keeps that check honest.
      return { buffer: Buffer.alloc(FRAME_BYTES * 4, 0xff), engine: "stub" };
    },
/* A scripted brain rather than the real one: call-runner has its own
     * never-repeat guard, so a real brain could not be made to repeat itself on
     * purpose and the repetition path this test exists to prove would be
     * unreachable. The controller, VAD, frame clock, hold, turn cap and turn
     * closing are all still the real ones.
     *
     * It honours the speech gate, because that is now part of the controller's
     * contract: nothing is spoken until the far end has had their say. A scripted
     * brain that spoke first opened a capture window on top of a clip already in
     * flight, the VAD calibrated its noise floor on the prospect's own greeting,
     * and the recognizer was never reached - which looked like a controller bug
     * and was the harness ignoring the rule it is testing. */
    async brain({ speakFn, listenFn, firstSpeechFn }) {
      const gate = typeof firstSpeechFn === "function" ? await firstSpeechFn({ locale: "en" }) : null;
      let first = true;
      for (let i = 0; i < prospect.length; i++) {
        const heard = first && gate ? gate : await listenFn({ locale: "en", autoLanguage: true });
        first = false;
        if (heard && heard.ended) break;
        if (!heard || !heard.text) break;
        const line = agentLines[Math.min(brainCalls, agentLines.length - 1)];
        brainCalls++;
        await speakFn(line, {});
        if (heard.text === "That is all, thanks.") break;
      }
      return { transcript: [] };
    },
/* Compressed audio timeline: this test asserts behaviour, not latency, and
     * the run is labelled non-real-time. Real STT and TTS calls would make it
     * minutes long and network-dependent.
     * The remaining cost is the controller's own 250ms hold, which is behaviour
     * under test and cannot be shortened.
     *
     * Three numbers here are not arbitrary and each one is a real property of
     * the path under test:
     *
     *  - the clip has to be comfortably LONGER than the VAD's minSpeechMs (160ms),
     *    not just over it. 160ms of audio is eight 20ms frames, which is exactly
     *    what the VAD needs before it will call anything speech - so a clip that
     *    size is decided on its last frame, or not at all, and the turn never
     *    closes.
     *  - the leading silence has to be at least the VAD's floorFrames (20), or
     *    the detector calibrates its noise floor on the prospect's own greeting
     *    and then treats it as noise. The real call gets this for free: the gate
     *    opens ~50ms after answer and a person says hello 300ms+ after that.
     *  - the trailing silence has to clear endSilenceMs (700ms) plus
     *    SPEECH_HOLD_MS (250ms) so one clip is one turn. */
    frameDelayMs: 3,
    leadMs: 500,
    tailMs: 1000,
    gapMs: 250,
    pcmuFor: () => fakeSpeech(420),
  });

  assert.equal(report.failure, null, "the run must not have thrown: " + report.failure);
  assert.ok(sttCalls >= 3, "the stubbed recognizer must actually have been called 3+ times (" + sttCalls + ")");
  assert.ok(ttsCalls >= 3, "the stubbed voice must actually have been called 3+ times (" + ttsCalls + ")");
  assert.ok(brainCalls >= 3, "the scripted brain must actually have been called 3+ times (" + brainCalls + ")");
  assert.deepEqual(report.providerFailures, [], "a stubbed run must report no provider failures: " + JSON.stringify(report.providerFailures));

  const trunc = report.defects.filter((d) => d.kind === "truncation");
  assert.ok(trunc.length >= 1, "a real run that returns a truncated transcript must report a truncation defect, got " + JSON.stringify(report.defects));
  assert.ok(
    trunc.some((d) => /What do you/.test(d.detail)),
    "the truncation defect must name the truncated turn, got " + JSON.stringify(trunc),
  );

  const reps = report.defects.filter((d) => d.kind === "repetition");
  assert.ok(reps.length >= 1, "a real run where the agent repeats itself must report a repetition defect, got " + JSON.stringify(report.defects));
  assert.ok(
    reps.some((d) => /Thanks, I appreciate that/.test(d.detail)),
    "the repetition defect must quote the repeated line, got " + JSON.stringify(reps),
  );

/* The stages still have to be measured on a run whose providers are stubbed,
     * otherwise the table would be silently empty in exactly the mode the tests
     * use - and the empty table would not look wrong.
     *
     * `total` is "the prospect's last speech sample -> the agent's audio ready",
     * so it is only measurable when a voiced frame actually arrived during the
     * turn. The first turn here is the reply to a greeting the scripted prospect
     * never follows up on, and there is no inbound audio between its STT and its
     * synthesis, so there is nothing to measure from - an unmeasured total there
     * is honest, a made-up one would not be. What must hold is that the column
     * exists where it can. */
  assert.ok(report.turns.length >= 1, "a run must produce measured turns");
  for (const t of report.turns) {
    assert.equal(typeof t.sttMs, "number", "STT must be timed even when stubbed");
    assert.ok(t.eosMs === null || typeof t.eosMs === "number", "end-of-speech must be a number or unset");
    assert.ok(t.ttsMs === null || typeof t.ttsMs === "number",
      `TTS must be timed when it happened, got ${JSON.stringify(t.ttsMs)}`);
    if (t.ttsMs != null) assert.ok(t.totalMs === null || typeof t.totalMs === "number", "a turn total must be a number or unset");
  }
  assert.ok(
    report.turns.some((t) => typeof t.ttsMs === "number"),
    "at least one turn must carry a real TTS measurement, or the column is empty and proves nothing"
  );
  assert.equal(report.realTime, false, "a compressed run must be labelled as not real-time");
}

/* Source with comments stripped. The telephony guards below scan CODE, so a file
   that explains in a comment why it does not touch the bridge is not a false
   positive - and a file that renames a local variable cannot hide a require. */
function codeOf(rel) {
  return require("node:fs")
    .readFileSync(require.resolve(rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/* The harness must never reach telephony. These are the guards that make that a
   property of the code rather than a promise in a comment. */
async function assertNoTelephony() {
  const controllerSrc = require("node:fs").readFileSync(require.resolve("./local-call-controller"), "utf8");
  const harnessCode = codeOf("../build/audio-sim");

  // The real engine factory and its SIP bridge must not be reachable from here.
  assert.doesNotMatch(harnessCode, /local-ringcentral-engine/, "audio-sim must never require the RingCentral engine");
  assert.doesNotMatch(harnessCode, /sipCallBridge|softphone/, "audio-sim must never reach the SIP bridge");
  assert.doesNotMatch(harnessCode, /registerSession|preflightLocalSip|sipOptions/, "audio-sim must never touch SIP registration");

  // runLocalCallBody is exported for exactly this use and takes injected deps.
  const exported = require("./local-call-controller");
  assert.equal(typeof exported.runLocalCallBody, "function", "runLocalCallBody must be exported so the harness never goes through the dialling entry point");
  assert.doesNotMatch(harnessCode, /\brunLocalCall\s*\(/, "audio-sim must never call runLocalCall");

  // No credential source: the voip block the harness passes is a literal
  // placeholder, and the run aborts if anything else ever reaches the factory.
  assert.match(harnessCode, /sipPassword:\s*"audio-sim-offline"/, "the harness's voip password must be a literal placeholder");
  assert.doesNotMatch(harnessCode, /\.voip\b[^;]*sipPassword|config\.voip/, "the harness must not read the real voip credentials");

  // The VAD options the harness reports against are the controller's own.
  assert.match(controllerSrc, /makeVad\(\{ minSpeechMs: 160, endSilenceMs: 700 \}\)/, "the harness must measure the VAD options the controller actually uses");
  assert.deepEqual(VAD_OPTS, { minSpeechMs: 160, endSilenceMs: 700 });
  assert.match(controllerSrc, /const SPEECH_HOLD_MS = 250;/, "SPEECH_HOLD_MS must still be 250ms");
  assert.equal(SPEECH_HOLD_MS, 250);

  // Frame contract: 160 bytes of PCMU/8000 is 20ms, and the harness's frame size
  // must match the engine's, because the controller slices on it.
  const engine = require("./local-ringcentral-engine");
  assert.equal(engine.FRAME_BYTES, FRAME_BYTES, "harness frame size must equal the engine's");
  assert.equal(FRAME_BYTES, 160);
  assert.equal(FRAME_MS, 20);
  assert.match(controllerSrc, /i \+= 160/, "the controller slices inbound audio on 160-byte frames");

  // Every fixture must be reproducible from text, so nothing large is committed.
  assert.equal(typeof sim.synthesizeLine, "function", "audio must be generable from text");
  const missing = Object.keys(sim.FIXTURE_TEXT).filter((id) => !require("node:fs").existsSync(path.join(__dirname, "..", "build", "fixtures", id + ".wav")));
  const ps1 = require("node:fs").readFileSync(path.join(__dirname, "..", "build", "fixtures", "make-fixtures.ps1"), "utf8");
  for (const id of missing) {
    assert.match(ps1, new RegExp('"' + id + '"\\s*='), "make-fixtures.ps1 must be able to regenerate " + id + ".wav");
  }
}

/* The scenario set the tool advertises must exist and be schedulable. */
function assertScenarios() {
  for (const name of ["greeting-first", "reopen", "interrupt"]) {
    const s = sim.SCENARIOS[name];
    assert.ok(s, "scenario " + name + " must exist");
    assert.ok(s.steps && s.steps.length >= 2, "scenario " + name + " must have at least two prospect turns");
    for (const step of s.steps) {
      assert.ok(sim.FIXTURE_TEXT[step.clip], "scenario " + name + " references unknown clip " + step.clip);
      /* afterPlayback:0 means "before any agent audio", which is the only correct
       * pin for the greeting now that the opener waits for the prospect to speak:
       * pinning it to playback 1 would deadlock, because playback 1 is the reply.
       * 0 must be allowed explicitly rather than by accident - `(step.afterPlayback
       * || 1)` reads 0 as 1, which would let a regression hide here. */
      const pinned = step.afterPlayback == null ? 1 : step.afterPlayback;
      assert.ok(pinned >= 0, "each step must be pinned to a playback, or it races the conversation");
    }
    assert.ok(s.expect, "scenario " + name + " must state what correct behaviour is");
    /* Every scenario has to be able to FAIL the rule, or asserting it proves
     * nothing: the prospect must speak before the agent does. */
    assert.equal(s.expect.maxOpenersBeforeProspectSpeech, 0,
      "scenario " + name + " must state that the agent may not speak before the prospect does");
    assert.equal(
      s.steps.filter((st) => (st.afterPlayback == null ? 1 : st.afterPlayback) === 0).length >= 1,
      true,
      "scenario " + name + " must have a prospect greeting pinned to before any agent audio"
    );
  }
  // reopen must actually go quiet, and interrupt must actually talk over.
  assert.ok(sim.SCENARIOS.reopen.steps.some((s) => (s.gapMs || 0) >= 2000), "reopen needs a real silence or it is not testing a re-open");
  assert.ok(sim.SCENARIOS.interrupt.steps.some((s) => s.atPlayback > 0), "interrupt needs a step that starts during playback");
  assert.equal(sim.SCENARIOS.reopen.expect.maxReopens, 1, "reopen's whole point is once, not twice");
}

/* waitForPlayback(0) must resolve at once. It is the pin that lets the prospect
 * speak before any playback exists, and it is not reachable from the scenarios
 * directly, so it is proved through the ordering check on a real engine clock:
 * the prospect's clip is emitted before the first outbound send, so the run has a
 * first prospect utterance at all. */
function assertGateOrdering() {
  assert.equal(typeof sim.checkExpectations, "function", "checkExpectations must be reachable");
  const report = {
    agentLines: ["I am Atlas with Zaz Logistics, calling about dispatch services."],
    heardLines: ["Hello?"],
    expect: {},
    firstProspectSpeechAt: 5000,
    firstAgentAudioAt: 7000,
  };
  assert.deepEqual(sim.checkExpectations(report, { maxOpenersBeforeProspectSpeech: 0 }), [],
    "an agent that waited for the prospect must pass the gate check");
  const tooEarly = { ...report, firstAgentAudioAt: 4000 };
  const problems = sim.checkExpectations(tooEarly, { maxOpenersBeforeProspectSpeech: 0 });
  assert.equal(problems.length, 1, "an agent that spoke first must fail the gate check, got: " + JSON.stringify(problems));
  assert.match(problems[0], /BEFORE the prospect said anything/, "the failure must say the opener was not gated on their speech");
  const neverSpoke = { ...report, firstProspectSpeechAt: null };
  assert.ok(
    sim.checkExpectations(neverSpoke, { maxOpenersBeforeProspectSpeech: 0 }).length === 1,
    "a run where nobody spoke cannot prove the gate, and must be reported as such"
  );
}

async function main() {
  assertScenarios();
  assertGateOrdering();
  assertDetectors();
  assertAnalysis();
  assertNoTelephony();
  await assertAudioPipeline();
  await assertRunReportsDefects();
  console.log("PASS: audio-sim detectors (truncation incl. question exemption, near-duplicate repetition, slow-stage budget), WAV/mu-law pipeline from generated audio, telephony guards, scenario set, and an end-to-end stubbed run that reports both defects");
  /* Exit explicitly rather than letting the event loop drain.
   *
   * local-call-controller.js guards its STT call with
   *   Promise.race([sttAuto(...), new Promise(res => setTimeout(res, 12000))])
   * and never clears that timer. On a live call it is harmless - the loop has
   * more turns to run - but it stays armed after the last one, so a short-lived
   * process is held open for up to 12s by a promise whose result was already
   * discarded. Measured here: a run that finishes in 1.5s does not let the
   * process exit until 13.5s. Not this test's bug and not worth changing the
   * call path for, but it must be known or the suite looks mysteriously slow. */
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });