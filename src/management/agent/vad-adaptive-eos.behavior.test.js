"use strict";
/**
 * The adaptive end-of-speech guard, and the truncation it must not reintroduce.
 *
 * 700ms used to be a flat wait before the agent believed a prospect had finished.
 * It is now 300-700ms depending on how long they have already been speaking. That
 * is a change to a number that has already broken three real calls once, so it is
 * tested against the exact failure it was introduced to fix rather than against
 * the latency it improves.
 *
 * What must hold:
 *   - a short utterance still waits the full 700ms
 *   - a long utterance is released on a short pause, and never sooner than the
 *     hard floor
 *   - a mid-sentence pause does NOT end the turn (the 20:25Z regression)
 *   - a pause inside a word cannot satisfy any of the steps
 *   - an explicit endSilenceMs is honoured exactly, so existing callers and tests
 *     that pin a value are unaffected
 *   - the schedule is monotonically non-increasing: more speech never needs more
 *     patience
 *
 * Audio is built with the project's own mu-law encoder (build/audio-sim.js) so the
 * frames are what the VAD actually sees on a call, not a convenient approximation.
 */
const assert = require("node:assert/strict");
const path = require("node:path");

const sim = require(path.join(__dirname, "..", "build", "audio-sim.js"));
const vad = require(path.join(__dirname, "vad.js"));
const { createVad, QUIET_FLOOR_MS, QUIET_MAX_MS, PATIENCE_STEPS } = vad;

const FRAME_BYTES = 160;
const FRAME_MS = 20;
const SILENT = Buffer.alloc(FRAME_BYTES, 0xff); // mu-law 0

/** One 20ms frame of voice at roughly `amp`, shaped like speech rather than a tone. */
function voiceFrame(amp, phase) {
  const b = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES; i++) {
    /* Two harmonics with a slow envelope: a pure sine is far too clean, and a
     * detector that only works on synthetic tones proves nothing about a call. */
    const t = (phase + i) / FRAME_BYTES;
    const env = 0.6 + 0.4 * Math.sin(t * Math.PI * 2);
    const s = amp * env * (Math.sin(i * 0.42 + phase * 0.1) + 0.5 * Math.sin(i * 0.93));
    b[i] = sim.mulawEncode(Math.max(-32767, Math.min(32767, s)));
  }
  return b;
}

/** Feed speech, then silence. Returns how much silence elapsed before `ended`. */
function run({ speechMs = 0, silenceMs = 2000, opts = {}, amp = 9000, silence = SILENT }) {
  const v = createVad(opts);
  const speechFrames = Math.max(0, Math.round(speechMs / FRAME_MS));
  let endedAfter = -1;
  let requiredAtEnd = 0;
  for (let i = 0; i < speechFrames + Math.round(silenceMs / FRAME_MS); i++) {
    const frame = i < speechFrames ? voiceFrame(amp, i) : silence;
    const e = v.push(frame, FRAME_MS);
    /* The guard that actually governed THIS ending. The peak across the run would
     * be whatever the first frame demanded, which says nothing about what the
     * prospect's speech length earned. */
    if (e.ended && endedAfter < 0) {
      endedAfter = (i - speechFrames + 1) * FRAME_MS;
      requiredAtEnd = e.requiredQuietMs || 0;
    }
  }
  return { endedAfter, required: requiredAtEnd, speechMs, speaking: v.speaking };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("a short utterance still waits the full 700ms", () => {
  /* 200ms of speech is someone who has barely started. Truncating here is exactly
   * the 20:25Z failure. */
  const r = run({ speechMs: 200, silenceMs: 3000 });
  assert.ok(r.endedAfter >= 700, `short utterance ended after only ${r.endedAfter}ms`);
  assert.ok(r.endedAfter <= 800, `short utterance should end near 700ms, ended at ${r.endedAfter}ms`);
});

test("a mid-sentence pause does not end the turn", () => {
  /* 300ms of quiet in the middle of a long sentence is a breath. Under the old
   * flat 700ms this was safe; it must stay safe now that the guard shrinks. */
  const v = createVad({});
  for (let i = 0; i < 150; i++) v.push(voiceFrame(9000, i), FRAME_MS); // 3s of speech
  for (let i = 0; i < 15; i++) v.push(SILENT, FRAME_MS); // 300ms pause
  assert.equal(v.speaking, true, "the VAD must still consider them speaking through a 300ms breath");
  assert.equal(v.requiredQuietMs, QUIET_FLOOR_MS, "a long utterance earns the floor");
});

test("a long utterance is released on a short pause, never under the floor", () => {
  const r = run({ speechMs: 4000, silenceMs: 3000 });
  assert.ok(r.endedAfter >= QUIET_FLOOR_MS, `ended after ${r.endedAfter}ms, under the ${QUIET_FLOOR_MS}ms floor`);
  assert.ok(r.endedAfter <= 380, `a 4s utterance should be released near the floor, ended at ${r.endedAfter}ms`);
  assert.ok(r.endedAfter < run({ speechMs: 400, silenceMs: 3000 }).endedAfter,
    "a long utterance must be answered faster than a short one");
});

test("the guard is monotonically non-increasing in speech duration", () => {
  /* More speech must never need more patience, or a long speaker would be held
   * longer than a short one for no reason. */
  /* Starts at 200ms, not 0: with no speech at all there is no end-of-speech, so
   * there is no guard to compare. Zero-length input is not a case. */
  let previous = Infinity;
  for (const speechMs of [200, 600, 1200, 1800, 2500, 4000, 8000]) {
    const r = run({ speechMs, silenceMs: 3000 });
    assert.ok(r.required <= previous,
      `at ${speechMs}ms of speech the guard rose to ${r.required}ms, above the previous ${previous}ms`);
    previous = r.required;
  }
  assert.equal(previous, QUIET_FLOOR_MS, "a long utterance must reach the floor");
});

test("every step in the schedule is honoured and none is below the floor", () => {
  for (const step of PATIENCE_STEPS) {
    assert.ok(step.quietMs >= QUIET_FLOOR_MS,
      `step ${step.speechMs}ms asks for ${step.quietMs}ms, below the ${QUIET_FLOOR_MS}ms floor`);
  }
  /* Each step must actually be reached by a long enough utterance, or it is dead
   * configuration that looks like a safety margin. */
  for (const step of PATIENCE_STEPS) {
    const r = run({ speechMs: Math.max(step.speechMs + 200, 200), silenceMs: 3000 });
    assert.equal(r.required, step.quietMs,
      `a ${step.speechMs + 200}ms utterance should require ${step.quietMs}ms, required ${r.required}ms`);
  }
  assert.equal(QUIET_MAX_MS, 700, "the worst case must be no worse than the old flat wait");
});

test("an explicit endSilenceMs is honoured exactly", () => {
  /* Callers and existing tests pin a value; they must get that value, not the
   * adaptive schedule. This is what keeps the change opt-in. */
  for (const pin of [250, 350, 700, 1200]) {
    for (const speechMs of [200, 4000]) {
      const r = run({ speechMs, silenceMs: pin * 3 + 800, opts: { endSilenceMs: pin } });
      assert.ok(Math.abs(r.endedAfter - pin) <= FRAME_MS + 1,
        `pinned ${pin}ms with ${speechMs}ms of speech ended at ${r.endedAfter}ms`);
    }
  }
});

test("an utterance with a breath in it is still captured whole", () => {
  /* The realistic case: 2s, a 350ms breath, more speech. The window must not
   * close at the breath. */
  const v = createVad({});
  let endedAt = -1;
  let n = 0;
  for (let i = 0; i < 200; i++) {
    const breathing = i >= 100 && i < 118; // ~360ms pause at 2s in
    const e = v.push(breathing ? SILENT : voiceFrame(9000, n++), FRAME_MS);
    if (e.ended && endedAt < 0) endedAt = i * FRAME_MS;
  }
  assert.equal(endedAt, -1, `the window closed at ${endedAt}ms, inside a 360ms breath`);
});

test("silence never invents an end-of-speech out of nothing", () => {
  /* A quiet line must not produce a turn. */
  const v = createVad({});
  let ended = false;
  for (let i = 0; i < 500; i++) if (v.push(SILENT, FRAME_MS).ended) ended = true;
  assert.equal(ended, false, "a silent line produced an end-of-speech");
});

test("quiet-room noise does not trigger the guard either", () => {
  /* Low-level room noise, well under the speech floor. */
  const v = createVad({});
  let ended = false;
  for (let i = 0; i < 500; i++) if (v.push(voiceFrame(120, i), FRAME_MS).ended) ended = true;
  assert.equal(ended, false, "room noise produced an end-of-speech");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { fn(); console.log(`  ok    ${name}`); }
    catch (e) { failed++; console.log(`  FAIL  ${name}`); console.log(`        ${e && e.message}`); }
  }
  if (failed) {
    console.error(`\n${failed} of ${tests.length} adaptive end-of-speech tests FAILED`);
    process.exit(1);
  }
  const shortU = run({ speechMs: 200, silenceMs: 3000 }).endedAfter;
  const longU = run({ speechMs: 4000, silenceMs: 3000 }).endedAfter;
  console.log(`\nPASS: ${tests.length} adaptive end-of-speech tests`);
  console.log(`  short utterance ${shortU}ms (was 700) · long utterance ${longU}ms (was 700) · floor ${QUIET_FLOOR_MS}ms`);
})();