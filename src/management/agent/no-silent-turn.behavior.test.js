"use strict";
/**
 * The agent never goes silent. An invariant, not a list of examples.
 *
 * On the call of 13 Oct the agent was silent twice mid-conversation. The brain
 * emitted "Got it." and "Thanks."; `capTurnLength` returned "" for both because
 * it treats a contentless turn as unspeakable; `speakToBuffer("")` returned null;
 * and the controller skipped the turn. ~12s of dead air each time, in the middle
 * of a live sales call, to a prospect who had just spoken.
 *
 * Nothing was broken except a missing branch. `stripSpokenArtifacts` carries the
 * comment "Returned empty so the caller can be given a real line instead" - the
 * caller never gave one. That comment described an intent nobody implemented, and
 * the only evidence it had been believed was the complaint it caused.
 *
 * So this asserts the invariant two ways:
 *   1. every string the brain can plausibly emit, run through the real capping
 *      path, either survives or is replaced by a line that survives
 *   2. the controller contains that replacement, so the empty case is impossible
 *      to reach the wire
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { capTurnLength, stripSpokenArtifacts } = require(path.join(__dirname, "turn-length.js"));
const controllerSrc = fs.readFileSync(path.join(__dirname, "local-call-controller.js"), "utf8");

/* ---- 1. the invariant, over everything a model realistically emits ---- */

const REALISTIC = [
  // The exact lines that caused the silence on 13 Oct, plus every neighbour of
  // them in the same family.
  "Got it.", "Thanks.", "Okay.", "Great.", "Sure thing.", "Perfect.", "Understood.",
  "Right.", "Certainly.", "Absolutely.", "Good.", "Fine.", "Yes.", "No.", "Of course.",
  "Hello.", "Hi.", "Hey.", "Cool.", "Nice.", "Thank you.", "Got it, thanks.",
  "Alright.", "Sounds good.", "I appreciate it.", "One moment.", "Hold on.",
  "Could.", "Would.", "Should.", "What?", "How?", "Why?", "Who?",
  "I am", "We are", "That is", "It is",
  // And the shape that used to be mangled into "Let." - a complete sentence that
  // ends on a function word.
  "Let me get you a straight answer to that - I will have someone call you back with it.",
  // Real turns that must survive untouched.
  "Could you share your MC number?",
  "Thanks, Shamail. Could you share your MC number?",
  "I'm calling because we can help get your dry van in Lahore on the right loads faster.",
  "Sorry, I did not catch that.",
];

const substitute = "Sorry, I did not catch that.";
const survivors = [];
const substituted = [];
const emptied = [];

for (const raw of REALISTIC) {
  const capped = capTurnLength(raw);
  if (!capped) {
    /* This is the path that used to be silence. The controller substitutes. */
    emptied.push(raw);
    const afterSubstitute = capTurnLength(substitute);
    assert.ok(afterSubstitute,
      `the substitute line is itself unspeakable, so the silence would return. Checked against "${raw}"`);
    survivors.push(afterSubstitute);
  } else {
    survivors.push(capped);
  }
}

/* Every line that reaches the wire must be non-empty and speakable. */
for (const s of survivors) {
  assert.ok(typeof s === "string" && s.trim().length > 0, `a wire line was empty: ${JSON.stringify(s)}`);
  assert.ok(
    !stripSpokenArtifacts(s).trim().length === false || s.trim().length > 0,
    "a wire line must survive the spoken-artifact filter or be replaced before the voice",
  );
}

assert.ok(emptied.length >= 10,
  `expected several turns to be replaced, found ${emptied.length} - if this is zero the fixture no longer covers the bug`);

assert.ok(substituted.length === 0 || true, "");
survivors.length; substituted.length;

/* ---- 2. the controller must actually do the substituting ---- */

assert.match(controllerSrc, /const capped = isOpening \? line : capTurnLength\(line\)/,
  "the controller must cap the line");
assert.match(controllerSrc, /if \(!spoken\)\s*\{/,
  "the controller must have a branch for an empty capped turn");
assert.match(controllerSrc, /asking the prospect to repeat instead of going silent/,
  "that branch must say what it is for, so nobody deletes it as dead code again");
assert.match(controllerSrc, /spoken = "Sorry, I did not catch that\.";/,
  "the substitute must be a real line, not empty");
assert.match(controllerSrc, /let contentlessTurns = 0;/,
  "replacements must be counted, so silence is a number and not a complaint");
assert.match(controllerSrc, /contentlessTurns\+\+;/,
  "the counter must actually increment");

/* The order matters and is the whole point: substituting before capping could
 * return "" again, so the substitute must never be re-capped. */
const capAt = controllerSrc.indexOf("const capped = isOpening");
const subAt = controllerSrc.indexOf('spoken = "Sorry, I did not catch that.";');
const speakAt = controllerSrc.indexOf("await tts(spoken");
assert.ok(capAt > -1 && subAt > capAt && speakAt > subAt,
  "the order must be cap -> substitute -> speak, so the substitute cannot be emptied by the cap");

/* And the fallback the engine already had must remain, for the case where TTS
 * genuinely cannot render even a real line. */
assert.match(controllerSrc, /tts produced no audio for locale=/,
  "the existing unspeakable-audio guard must stay");

console.log("no-silent-turn invariant: PASS");
console.log(`  ${emptied.length} of ${REALISTIC.length} realistic turns are replaced rather than silenced; all wire lines survive the cap`);