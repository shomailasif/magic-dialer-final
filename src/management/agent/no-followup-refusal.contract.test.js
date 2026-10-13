"use strict";
/**
 * "I don't want you to follow-up" must end the call, not start a data grab.
 *
 * On the call of 13 Oct the prospect said exactly that at 0:55 and the agent
 * asked for a phone number. It is the worst exchange in the set, for two
 * reasons that pull in opposite directions and are both true:
 *
 *   - It loses the deal. Somebody who has declined a follow-up has declined.
 *   - It is a consent problem. This codebase stores consent and honours a
 *     do-not-call. Pressing for contact details after an explicit refusal is
 *     how a list of numbers becomes a complaint, and that cost lands on the
 *     whole campaign rather than on this one call.
 *
 * It happened because the refusal was a THIRD shape, and only two were handled:
 *
 *   BUSY_RE  needs "busy".            "I don't want you to follow-up" has none.
 *   STOP_RE  needs "do not call me".  Same problem.
 *
 * Neither matched, the turn was treated as an ordinary one, and the agent did
 * what it always does next: ask for the missing field.
 *
 * This runs the real regex rather than matching English against regex source,
 * because the second thing that matters is what it must NOT catch. A refusal
 * pattern that fires on "call me back when you get a chance" closes a live
 * sale, and every one of those is a lost deal the pattern would have caused.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "call-runner.js"), "utf8");

/* ---- pull the pattern array out and rebuild the real RegExp ---- */
const start = src.indexOf("const NO_FOLLOWUP_RE = new RegExp([");
assert.ok(start > -1, "a follow-up refusal needs its own pattern; BUSY_RE and STOP_RE cannot see it");
const openBracket = src.indexOf("[", start);
const closeBracket = src.indexOf("].join", openBracket);
const body = src.slice(openBracket, closeBracket + 1);

const NO_FOLLOWUP_RE = eval(`(function(){ const parts = ${body}; return new RegExp(parts.join("|"), "i"); })()`);

/* ---- refusals that must be caught ---- */
const MUST_CATCH = [
  "I don't want you to follow-up",              // said at 0:55
  "I don't want any follow up",
  "No follow up please",
  "Don't follow up with me",
  "no need to call me back",
  "I don't want you to call me",
  "don't call me",
  "I will call you if I need anything",
  "Remove me from your list",
  "no thanks I don't need it",
  "I do not want to be contacted again",
];
const missed = MUST_CATCH.filter((u) => !NO_FOLLOWUP_RE.test(u));
assert.deepEqual(missed, [],
  `these refusals are NOT recognised, so the agent would ignore them: ${JSON.stringify(missed)}`);

/* ---- things that must NOT be caught ----
 * Every false positive here ends a call that was going somewhere. */
const MUST_NOT_CATCH = [
  "Sure, call me back",                        // they WANTS a callback
  "Can I call you back later?",
  "Yeah that works for me",
  "Okay",
  "What type of trucks do you run?",
  "I run 26 foot box trucks",
  "Send me the rates and I will call you",
  "My number is 5551234567",
  "No problem, go ahead",
  "Not right now",                             // BUSY_RE owns this, not this one
  "I'm a bit busy right now",                  // BUSY_RE owns this too
];
for (const u of MUST_NOT_CATCH) {
  assert.ok(!NO_FOLLOWUP_RE.test(u), `must NOT treat a live conversation as a refusal: "${u}"`);
}

/* ---- checked before the brain, so no reply can be generated ---- */
const ifIdx = src.indexOf("if (NO_FOLLOWUP_RE.test(heard))");
const busyIdx = src.indexOf("if (BUSY_RE.test(heard))");
assert.ok(ifIdx > -1, "the refusal must be tested in the turn loop");
assert.ok(ifIdx < busyIdx,
  "test it before BUSY so the earliest-matching refusal wins regardless of wording");
assert.match(src.slice(ifIdx, ifIdx + 1400), /Do NOT offer to call them back/,
  "the brain must be told not to offer a callback, or it will offer one anyway");

/* ---- nothing may be asked ---- */
const branch = src.slice(ifIdx, src.indexOf("if (BUSY_RE.test(heard))", ifIdx));
assert.ok(branch.includes("!/\\?/.test(fromNf)"),
  "a closing turn after a refusal must never contain a question");
assert.ok(branch.includes("get your number|your (?:number|phone)|phone number"),
  "the brain output is re-checked for a contact grab, not just for questions");
assert.ok(branch.includes("call (?:you )?back"),
  "and re-checked for a callback offer, so the close cannot undo the refusal");

/* ---- it closes with thanks and NO callback offer ---- */
assert.match(branch, /const noFuClose = farewellLine\(activeLocale\);/,
  "use the no-callback closer");
assert.ok(!/closingLine\(activeLocale,/.test(branch),
  "closingLine() must not be used here - it promises a call back");

/* ---- and it ends the call ---- */
assert.match(branch, /\{ intent: "closing", noRetry: true \}\);\s*\r?\n\s*break;/,
  "after the refusal the call must end - there is no next turn to ask anything");

console.log("follow-up refusal: PASS");
console.log(`  ${MUST_CATCH.length} refusals caught, ${MUST_NOT_CATCH.length} live replies left alone`);
console.log("  closes the call, asks nothing, promises no callback");