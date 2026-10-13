"use strict";
/**
 * A spoken follow-up refusal must suppress the number.
 *
 * On the call of 13 Oct the prospect said "I don't want you to follow-up". That
 * is the only opt-out in the entire conversation, and it suppressed nothing:
 *
 *   isSpokenOptOut() knew six phrases - stop calling, don't call, do not call,
 *   remove me, take me off, unsubscribe - and none of them match it.
 *
 * So doNotCall stayed false, consentStatus stayed UNKNOWN, the phoneSuppression
 * row was never written, and the agent's correct, polite ending changed nothing.
 * The next campaign called the same person again. Honouring a refusal on the call
 * while persisting none of it is the worst of both worlds: it looks compliant and
 * behaves exactly like an agent that never heard the refusal.
 *
 * The cost of a false positive here is permanent and asymmetric against us, so
 * the other half of this file matters as much as the first: every phrase that
 * must NOT suppress is asserted just as loudly.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const compliance = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", "src", "lib", "call-compliance.ts"),
  "utf8",
);

/* ---- the phrases from the call must appear in the source ---- */
const MUST_SUPPRESS = [
  "I don't want you to follow-up",
  "I don't want you to follow up",
  "I don't want any follow up",
  "No more follow up please",
  "No follow up",
  "Don't follow up with me",
  "No call back",
  "I do not want you to call me",
  "I dont want you to follow up",          // apostrophe dropped by the recogniser
  "please remove me from your list",
  "stop calling me",
];

/* Each of these is a live lead. Suppressing any of them loses revenue AND teaches
 * the team that opt-out detection is noisy, which is how it gets disabled. */
const MUST_NOT_SUPPRESS = [
  "I don't want you to follow up right now, but call me next week",
  "no follow up for now",
  "not right now, maybe this afternoon",
  "Can I call you back later?",
  "Sure, call me back tomorrow",
  "I will call you if I need anything",
  "I'll call you next month",
  "What's your follow up time?",
  "Can you send me the rates and I will call you",
];


/* ---- the structure that makes it work ---- */
/* Hyphen and Unicode dashes are normalised, because "follow-up" and "follow up"
 * are the same sentence and the recogniser emits both. */
assert.match(compliance, /\\u2010-\\u2015/,
  "Unicode dashes must be folded to spaces or the hyphenated half of every refusal is missed");
assert.match(compliance, /replace\(\/\\s\+\/g,\s*"\s*"\)/,
  "spacing must be squashed, because the recogniser splits phrases arbitrarily");

/* Hard and soft must be separate lists. If they were merged, the temporal
 * exemption below could spare a hard "don't call me" that happened to appear in
 * a turn containing the word "now". */
assert.match(compliance, /HARD_OPT_OUT/,
  "unambiguous do-not-call phrases must be their own list");
assert.match(compliance, /SOFT_OPT_OUT/,
  "follow-up refusals must be a separate list so only they can be time-exempt");

/* ---- the dangerous half: things that must NOT suppress ---- */
/* Each of these is a live lead. Suppressing any of them loses revenue AND
 * teaches the team the opt-out detection is noisy, which is how it gets
 * disabled entirely one day. */
for (const phrase of [
  "I don't want you to follow up right now, but call me next week",
  "no follow up for now",
  "not right now, maybe this afternoon",
  "Can I call you back later?",
  "Sure, call me back tomorrow",
  "I will call you if I need anything",
  "I'll call you next month",
  "What's your follow up time?",
  "Can you send me the rates and I will call you",
]) {
  assert.ok(
    !compliance.includes(`"${phrase}"`),
    `"${phrase}" must not be a suppression phrase - it is a live lead`
  );
}

assert.match(compliance, /PROSPECT_WILL_CALL_RE/,
  "the prospect offering to call US is the opposite of an opt-out and must be checked first");
assert.match(compliance, /return !TEMPORAL_EXEMPT\.some\(re=>re\.test\(x\)\);/,
  "a soft refusal suppresses unless it is time-boxed");

const convo = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", "src", "lib", "sip-conversation.ts"),
  "utf8",
);
assert.match(convo, /if \(isSpokenOptOut\(txt\)\) doNotCall = true;/,
  "the transcript must be scanned with this function, or the whole thing is inert");
assert.match(convo, /doNotCall,/,
  "the result must carry the flag that persists the suppression");

/* ===================================================================
 * BEHAVIOUR, not text.
 *
 * Everything above checks that the right words are present in the source. That
 * is not the same as the function being right, and it is not how the original
 * bug was found: the list was present, the calls were present, and "I don't want
 * you to follow-up" still suppressed nothing. The phrase list overlaps with live
 * replies, so the only way to know which wins is to run it.
 *
 * call-compliance.ts is plain TypeScript, so the handful of type annotations are
 * stripped and the functions are evaluated exactly as they ship.
 * =================================================================== */
/* Only isSpokenOptOut and the tables it reads are needed. Taking the whole file
 * would drag in decideCallCompliance and its type annotations, which is a
 * TypeScript-stripping problem rather than a test of this function. */
const tablesStart = compliance.indexOf("const HARD_OPT_OUT");
assert.ok(tablesStart > -1 && compliance.indexOf("export function isSpokenOptOut") > -1,
  "both the tables and isSpokenOptOut must exist");
const js = compliance.slice(tablesStart, compliance.indexOf("export function normalizePhoneForSuppression"))
  .replace(/^export /gm, "")
  .replace(/const (\w+):readonly\s+(?:string\[\]|RegExp\[\])/g, "const $1")
  .replace(/function normaliseForMatching\(text:\s*string\)/, "function normaliseForMatching(text)")
  .replace(/function isSpokenOptOut\(text:\s*string\)/, "function isSpokenOptOut(text)");
const mod = { exports: {} };
new Function("module", "exports", js + "\nmodule.exports.isSpokenOptOut = isSpokenOptOut;")(mod, mod.exports);
const optOut = mod.exports.isSpokenOptOut;
assert.equal(typeof optOut, "function",
  "isSpokenOptOut must still be callable after the type annotations are stripped");

/* The phrases that must suppress, run for real. */
for (const u of MUST_SUPPRESS) {
  assert.equal(optOut(u), true, `must suppress the number: "${u}"`);
}
/* And the ones that must not - each is a live lead worth money. */
for (const u of MUST_NOT_SUPPRESS) {
  assert.equal(optOut(u), false, `must NOT suppress a live lead: "${u}"`);
}

/* A refusal arriving mid-transcript with other turns around it. This is the real
 * call shape: the function is handed one transcript entry, not the whole call. */
assert.equal(optOut("I don't want you to follow-up."), true,
  "the sentence from the call, with punctuation");
assert.equal(optOut("Don't  want  you  to  follow  up"), true,
  "recogniser spacing must not defeat the match");
assert.equal(optOut("I DO NOT WANT YOU TO FOLLOW UP"), true, "shouting must not defeat it");
assert.equal(optOut(""), false);
assert.equal(optOut("   "), false);
assert.equal(optOut(undefined), false);
assert.equal(optOut("Sure, that works. My MC number is 123456."), false);

/* ===================================================================
 * NON-LATIN REFUSALS.
 *
 * The detector was English-only while the agent answers in nine languages, so a
 * refusal in Urdu or Hindi ended the call politely and suppressed nothing. The
 * caller is left believing it was understood, and the number is dialled again -
 * the identical bug to the English one, and worse because nobody was watching
 * for it in that language.
 *
 * These entries are held to a stricter bar than the English ones, and the test
 * enforces the bar rather than trusting it: a phrase that is merely a refusal of
 * something ("no", "please don't") must NOT suppress, because suppressing a live
 * number permanently is the one failure here with no recovery.
 * =================================================================== */
for (const u of [
  "کال نہ کریں",                 // Urdu: do not call
  "مجھے کال مت کریں",           // do not call me
  "میرا نمبر ہٹا دیں",           // remove my number
  "फॉलोअप नहीं चाहिए",           // Hindi: no follow up
  "कॉल मत करो",                  // do not call
  "मेरा नंबर हटा दो",           // delete my number
  "تماس نگیرید",                 // Persian: do not contact
]) {
  assert.equal(optOut(u), true, `a non-latin refusal must suppress: "${u}"`);
}

/* The near-misses that must NOT suppress. "mat" alone is just "don't" and can
 * refuse anything; a bare "nahi" is just "no". */
for (const u of [
  "मत कीजिए",                   // Hindi: just "please don't"
  "नहीं",                        // Hindi: just "no"
  "مجھے نہیں",                   // Urdu: just "no"
  "میرا نام احمد ہے",            // Urdu: "my name is Ahmed"
  "मेरा नाम अहमद है",            // Hindi: "my name is Ahmed"
]) {
  assert.equal(optOut(u), false, `must NOT suppress on a bare refusal: "${u}"`);
}

/* A non-latin refusal must not be rescued by a time qualifier it cannot parse. */
assert.equal(optOut("कॉल मत करो, बाद में"), true,
  "a non-latin refusal still suppresses; the temporal exemption is English-only");

assert.match(compliance, /NON_LATIN_OPT_OUT/,
  "the non-latin list must exist and be checked");
assert.ok(
  compliance.indexOf("NON_LATIN_OPT_OUT.some") < compliance.indexOf("TEMPORAL_EXEMPT.some"),
  "the non-latin check must come BEFORE the temporal exemption, or 'for now' could rescue a refusal");

console.log("spoken opt-out: PASS");
console.log(`  ${MUST_SUPPRESS.length} refusals suppress the number, ${MUST_NOT_SUPPRESS.length} live replies do not`);
console.log("  7 non-latin refusals suppress; bare 'no'/'don't' in those scripts do not");
