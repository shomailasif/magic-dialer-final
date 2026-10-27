"use strict";
/**
 * The refusal detectors must work in the languages the agent actually speaks.
 *
 * The agent advertises 140+ languages: it can open in Urdu, switch to Hindi
 * mid-call, and answer a Spanish prospect in Spanish. The three refusal
 * patterns, however, were English-only. That is not a cosmetic gap:
 *
 *   STOP_RE        decides "do not call me"  -> the number is suppressed
 *   NO_FOLLOWUP_RE decides "no follow-up"    -> no callback is offered, and
 *                                                the number is suppressed
 *   BUSY_RE        decides "not now"         -> the call is closed politely
 *
 * A prospect who refuses in Urdu, Punjabi, Mandarin or Spanish was heard
 * perfectly, understood by the brain, and then - because the regex did not
 * match - kept being qualified. That is the exact failure the English patterns
 * were written to prevent, just wearing a different language.
 *
 * This test runs the *real* regexes out of call-runner.js, not a copy. It
 * checks both directions: every refusal must be caught, and ordinary live
 * conversation must NOT be caught. The second half matters more - a Spanish
 * "can you call me tomorrow" ending the call is a lost sale.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "call-runner.js"), "utf8");

function loadPattern(marker) {
  const start = src.indexOf(marker);
  assert.ok(start > -1, `${marker} must exist in call-runner.js`);
  const open = src.indexOf("[", start);
  const close = src.indexOf("].join", open);
  assert.ok(open > -1 && close > -1, `${marker} must be a [...].join("|") pattern`);
  const parts = eval(src.slice(open, close + 1));
  assert.ok(Array.isArray(parts) && parts.length > 0, `${marker} must contain patterns`);
  return { re: new RegExp(parts.join("|"), "i"), parts };
}

const stop = loadPattern("const STOP_RE = new RegExp([");
const noFollowUp = loadPattern("const NO_FOLLOWUP_RE = new RegExp([");

/* ---- 1. do-not-call, in every supported language family ---------------- */
const STOP_MUST_CATCH = [
  /* English - the original contract, unchanged */
  "stop calling me",
  "do not call me again",
  "don't call me",
  "remove me from your list",
  "take me off your list",
  "unsubscribe",
  "not call me again",
  /* Roman Urdu / Hindi / Punjabi - how STT often returns them */
  "mujhe call mat karo",
  "dobara call na karein",
  "mera number delete karo",
  "list se hata do",
  /* Urdu */
  "مجھے دوبارہ کال نہ کریں",
  "مجھے کال مت کریں",
  "فہرست سے ہٹا دیں",
  /* Hindi */
  "मुझे कॉल मत करें",
  "दोबारा फोन न करें",
  "सूची से हटा दें",
  /* Punjabi */
  "ਕਾਲ ਨਾ ਕਰੋ",
  "ਦੁਬਾਰਾ ਫੋਨ ਨਾ ਕਰੋ",
  /* Spanish */
  "no me llame más",
  "no vuelvan a llamar",
  "quítenme de la lista",
  /* Mandarin */
  "不要再打电话了",
  "别打了",
  "删除我的号码",
  /* Arabic */
  "لا تتصل بي",
  "احذف رقمي",
  /* French */
  "ne m'appelez plus",
  "retirez-moi de la liste",
  /* German */
  "rufen Sie mich nicht mehr an",
  "nehmen Sie mich von der Liste",
  /* Portuguese */
  "não me ligue mais",
  "me remova da lista",
];
const stopMissed = STOP_MUST_CATCH.filter((u) => !stop.re.test(u));
assert.deepEqual(stopMissed, [],
  `these do-not-call statements are NOT recognised: ${JSON.stringify(stopMissed)}`);

/* ---- 2. do-not-call must not fire on ordinary conversation ------------- */
const STOP_MUST_NOT_CATCH = [
  "call me back tomorrow",
  "I will call you later",
  "Can I call you next week?",
  "You should call the dispatcher",
  "¿Me puede llamar mañana?",
  "llame al número de la oficina",
  "请明天打电话给我",
  "je vais vous appeler demain",
  "ich rufe Sie morgen an",
  "eu vou te ligar amanhã",
];
for (const u of STOP_MUST_NOT_CATCH) {
  assert.ok(!stop.re.test(u), `must NOT treat an ordinary reply as a do-not-call: "${u}"`);
}

/* ---- 3. the English branch must keep its word boundaries ---------------
 * `\b` is deliberately scoped to the English alternatives. If it is moved
 * around the whole union, \b can never match next to a non-Latin character
 * and every translated pattern becomes dead code while the test above would
 * still pass for English. Assert both the shape and the effect. */
assert.ok(stop.parts[0].startsWith("\\b(?:"),
  "the English alternatives must keep their own word boundaries");
assert.ok(stop.parts[0].endsWith("\\b"),
  "the English word boundary must close on the English branch only");
assert.ok(!stop.parts.slice(1).every((p) => p.startsWith("\\b")),
  "the translated branches must not be wrapped in \\b");

/* ---- 4. no-follow-up, in every supported language family --------------- */
const NOFU_MUST_CATCH = [
  /* English contract (also pinned by no-followup-refusal.contract.test.js) */
  "I don't want you to follow-up",
  "No follow up please",
  "Don't follow up with me",
  "no need to call me back",
  "Remove me from your list",
  "I do not want to be contacted again",
  /* Roman Urdu / Hindi / Punjabi */
  "mujhe aage koi call nahi chahiye",
  "follow up nahi chahiye",
  "mujhe follow up ki zaroorat nahi",
  "mera number hata do",
  /* Urdu */
  "مجھے مزید رابطہ نہیں چاہیے",
  "آگے کال نہیں",
  "فالو اپ نہیں چاہیے",
  /* Hindi */
  "मुझे और संपर्क नहीं चाहिए",
  "फॉलो अप नहीं चाहिए",
  /* Punjabi */
  "ਹੋਰ ਕਾਲ ਨਹੀਂ",
  /* Spanish */
  "no me contacte más",
  "no quiero que me contacten",
  /* Mandarin */
  "不要再联系我",
  "我不需要跟进",
  /* Arabic */
  "لا تتواصل معي",
  /* French */
  "ne me contactez plus",
  /* German */
  "kontaktieren Sie mich nicht mehr",
  /* Portuguese */
  "não me contacte mais",
];
const nofuMissed = NOFU_MUST_CATCH.filter((u) => !noFollowUp.re.test(u));
assert.deepEqual(nofuMissed, [],
  `these follow-up refusals are NOT recognised: ${JSON.stringify(nofuMissed)}`);

/* ---- 5. and it must not fire on a prospect who wants to talk ----------- */
const NOFU_MUST_NOT_CATCH = [
  "Sure, call me back",
  "Can I call you back later?",
  "No problem, go ahead",
  "Not right now",
  "I'm a bit busy right now",
  "sí, me interesa",
  "me interesa, llámeme mañana",
  "aage call karein",
  "请明天打电话给我",
  "je veux que vous me contactiez",
  "Ich habe Interesse",
  "tenho interesse",
];
for (const u of NOFU_MUST_NOT_CATCH) {
  assert.ok(!noFollowUp.re.test(u), `must NOT treat a live conversation as a refusal: "${u}"`);
}

/* ---- 6. the patterns must stay wired into the turn loop ---------------- */
assert.ok(src.includes("stopRequested = STOP_RE.test(heard)"),
  "STOP_RE must decide the do-not-call flag in the turn loop");
assert.ok(src.includes("if (NO_FOLLOWUP_RE.test(heard))"),
  "NO_FOLLOWUP_RE must be tested before the brain produces a reply");
assert.ok(src.indexOf("if (NO_FOLLOWUP_RE.test(heard))") < src.indexOf("if (BUSY_RE.test(heard))"),
  "the follow-up refusal must still win before the busy branch");

console.log("refusal i18n: PASS");
console.log(`  ${STOP_MUST_CATCH.length} do-not-call statements caught in 10 languages`);
console.log(`  ${NOFU_MUST_CATCH.length} follow-up refusals caught in 10 languages`);
console.log(`  ${STOP_MUST_NOT_CATCH.length + NOFU_MUST_NOT_CATCH.length} ordinary replies left alone`);
