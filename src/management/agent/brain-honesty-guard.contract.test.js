"use strict";
/* The two answers that must not depend on a sampled token.
 *
 * Measured on 27 Oct against the live provider:
 *   - asked "am I talking to a robot?", the direct model claimed to be a real
 *     person in 8 of 9 samples;
 *   - told "I just drive the truck, I don't own anything", it still asked for
 *     the MC number on all 12 samples.
 * Both now have a deterministic guard in intelligent-brain.nextTurn. The prompt
 * rules help; these tests are about the guarantee.
 */
const assert = require("node:assert/strict");
const { guardReply, trimToCompleteSentence, DEFAULT_ANSWER_TOKENS, MAX_ANSWER_TOKENS } = require("../agent/intelligent-brain");

const cfg = { companyName: "Zaz Logistics" };

// 1. A direct question about being human is answered honestly, whatever the model said.
for (const said of [
  "Wait, am I talking to a robot or a real person?",
  "Are you a human?",
  "Is this an AI?",
  "Am I speaking to a real person?",
]) {
  const out = guardReply("I'm a real person, I promise.", [{ role: "lead", text: said }], cfg);
  assert.match(out, /\bAI assistant\b/i, `"${said}" must be answered as an AI, got: ${out}`);
  assert.doesNotMatch(out, /\breal (?:person|human)\b/i, `"${said}" must not claim to be human, got: ${out}`);
}

// 2. A truthful answer is left alone.
const truthful = "I'm an AI assistant calling for Zaz Logistics.";
assert.equal(guardReply(truthful, [{ role: "lead", text: "Are you a robot?" }], cfg), truthful);

// 3. A non-decision-maker is routed, not qualified.
for (const said of [
  "I just drive the truck, I don't own anything.",
  "I'm only a driver.",
  "I work for someone else.",
  "I'm not the owner.",
]) {
  const out = guardReply("No problem - what is your MC number?", [{ role: "lead", text: said }], cfg);
  assert.match(out, /\b(owner|dispatch|decision)\b/i, `"${said}" must be routed, got: ${out}`);
  assert.doesNotMatch(out, /MC number/i, `"${said}" must not be qualified, got: ${out}`);
}

// 4. Everything else is untouched - the guard is narrow on purpose.
const normal = "Sure, I can help with that. How many trucks are you running?";
assert.equal(guardReply(normal, [{ role: "lead", text: "We have a small fleet." }], cfg), normal);

// 5. Truncated replies keep complete sentences and drop the half-clause.
assert.equal(
  trimToCompleteSentence("We can help with that. I just need your MC num"),
  "We can help with that.",
  "a truncated half-clause must not be spoken"
);
assert.equal(trimToCompleteSentence("I can get you set up and then we can"), "", "a fragment with no terminator is not speech");
assert.equal(trimToCompleteSentence("One. Two! Three?"), "One. Two! Three?", "complete sentences are kept");

// 6. The token budget is the one the measurement proved, not the old 220.
assert.ok(DEFAULT_ANSWER_TOKENS >= 900, "the default answer budget must leave room to finish a sentence");
assert.ok(MAX_ANSWER_TOKENS >= DEFAULT_ANSWER_TOKENS, "the retry budget must not be smaller than the default");

console.log("brain honesty and routing guard: PASS (honest about AI, routes drivers, keeps complete sentences)");
