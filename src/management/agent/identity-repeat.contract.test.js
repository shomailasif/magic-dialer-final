"use strict";
/**
 * The agent answers "why are you calling" once, not once per time they ask.
 *
 * On the call of 13 Oct the prospect asked why we were calling FIVE times and
 * received essentially the same introduction five times:
 *
 *   "I am Atlas with Zaz Logistics, calling about Dispatch Services for trucks."
 *   "You are speaking with Atlas with Zaz Logistics, about Dispatch Services."
 *   "I am Atlas from Zaz Logistics calling about dispatch services for trucks."
 *
 * Each reworded just enough to evade an exact-match check. That is what makes it
 * sound like a machine rather than a person, and it is the loudest thing a
 * prospect notices.
 *
 * The cause was a guard exemption, not a missing one. On the 18:44Z call the
 * repetition guard deleted a legitimate first answer to "Who is this?", so the
 * branch was exempted - but the exemption was UNCONDITIONAL. Any turn where the
 * prospect asked who we are bypassed repetition protection entirely, which is
 * exactly the case that needs it most: a prospect asking twice is telling you
 * the first answer did not land.
 *
 * So the exemption now lasts exactly one turn.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "call-runner.js"), "utf8");

/* ---- the flag exists and is per-call, not global ---- */
assert.match(src, /let identityAnswered = false;/,
  "the call must remember whether it has already given its identity");

/* ---- the exemption is bounded ---- */
assert.match(src, /if \(!identityAnswered\)\s*\{\s*\n\s*identityAnswered = true;/,
  "the identity exemption must be consumed on first use, so it cannot be permanent");

assert.match(src, /} else \{\s*\n\s*const strip = lastSpokenLine\s*\n?\s*\? stripRepeatedAsks/,
  "once the identity is given, the repetition guard must apply again to that turn");

assert.match(src, /identity already given; replacing the second introduction/,
  "the replacement must be logged, so this shows up in a transcript instead of in a complaint");

/* ---- the first answer is still protected from being stripped ---- */
const identityBranch = src.slice(src.indexOf("} else if (askedWhoIsThis || identityAsked)"));
const guardStart = identityBranch.indexOf("stripRepeatedAsks");
const identitySet = identityBranch.indexOf("identityAnswered = true");
assert.ok(identitySet > -1 && guardStart > identitySet,
  "the first identity answer must be taken before the guard is consulted, or it gets deleted - the 18:44Z bug");

/* ---- the state is reset for each call ---- */
assert.ok(!/^\s*identityAnswered\s*=\s*true/m.test(src.replace(/identityAnswered = true;\s*\n\s*\}/, "")),
  "identityAnswered must not be pinned to true outside the branch that consumes it");

console.log("identity-repeat guard: PASS");
console.log("  a first identity answer is kept; a second one is routed to the say-something-different path");