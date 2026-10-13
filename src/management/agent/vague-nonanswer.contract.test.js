"use strict";
/**
 * "Just need a couple of quick details" is not an answer to "what do you do".
 *
 * On the call of 13 Oct the prospect asked what we do and got that line. It is
 * the most dangerous reply in the set, because it is a complete, grammatical,
 * polite sentence that contains no information at all - and it describes the CALL
 * rather than the BUSINESS. The prospect asked what we do and was told what we
 * are about to ask them. From that moment the call is something to sit through.
 *
 * The existing unanswered-question guard could not catch it. It rejects two
 * shapes: a reply that is itself a question, and a reply that is only an
 * acknowledgment. This is neither, so it passed straight to the voice and the
 * brain was never asked for a real answer.
 *
 * The false-positive cost is what shapes the design. A real answer thrown away
 * means a second brain call, and a second brain call can be WORSE than the good
 * answer we already had. So the test needs both halves: a vague phrase, AND no
 * concrete claim anywhere in the line. One number, one truck, one place is
 * somebody saying something - even if it opens with "basically".
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "call-runner.js"), "utf8");
/* The guard lives in reply-quality.js so it is imported and tested directly, rather than
 * scraped back out of call-runner source text. */
const { isVagueNonAnswer: isVague } = require("./reply-quality");

/* ---- filler that answered nothing, said on the call or in this shape ---- */
for (const line of [
  "Just need a couple of quick details.",
  "Just a few questions and we can get going.",
  "We help businesses with their freight needs.",
  "I just need a couple of things from you first.",
  "It's all about getting you the best rates.",
  "We tailor our service to you.",
  "We offer competitive rates.",
  "It depends on what you need.",
  "Just a few quick details.",
]) {
  assert.ok(isVague(line), `must reject the filler: "${line}"`);
}

/* ---- real answers that MUST survive, however they open ----
 * Every one of these is a line worth paying a second brain call to throw away. */
for (const line of [
  "We find loads for trucks within 30 minutes.",
  "We dispatch dry vans across Pakistan.",
  "Your MC number please.",
  "We help with freight and we cover 26 foot box trucks.",
  "To get you the best rates we need your MC number.",   // filler + a fact
  "Basically we move 40 trucks a month out of Lahore.",  // filler + a fact
  "I just need to know which lanes you run, then rates depend on that.",
  "Our rates are competitive because we have no broker margin.",
]) {
  assert.ok(!isVague(line), `must NOT throw away a real answer: "${line}"`);
}

/* ---- an unrelated non-answer is not this guard's business ---- */
for (const line of [
  "Could you share your MC number?",
  "Sorry, I lost that. What were you saying?",
]) {
  assert.ok(!isVague(line), `"${line}" is handled elsewhere, not by the filler guard`);
}

/* ---- the guard is actually wired into the unanswered-question path ---- */
assert.match(src, /const vague = isVagueNonAnswer\(line\);/,
  "the unanswered-question guard must test for vagueness");
assert.match(src, /if \(askedQuestion \|\| onlyAcknowledged \|\| vague\)/,
  "vagueness must be a third reason to retry, not a fourth unused function");
assert.match(src, /\[unanswered-question\]/,
  "it must be logged, so this shows up in a transcript");

/* ---- and the retry is told the actual question again ---- */
assert.match(src, /Answer that question directly\. The prospect asked:/,
  "the retry must carry the real question, or it produces the same deflection");

console.log("vague-non-answer guard: PASS");
console.log("  filler rejected, concrete answers kept - the guard cannot eat a real answer");
