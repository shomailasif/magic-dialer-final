"use strict";
/**
 * Regression tests for the 20:40Z call, which is the "brainless, delayed"
 * complaint in one file. Every test here corresponds to a line in that log.
 *
 * What the log actually showed, and why each of these exists:
 *
 *  20:40:48  STT detected language ur
 *  20:40:48  LEAD:  <real Urdu: U+06A9 U+0648 U+0646 U+0020 U+0628 U+0627 U+062A ...>
 *  20:40:56  AGENT: I want to answer that accurately rather than guess.
 *                 Let me note it for the team to follow up.
 *
 *  - The recognizer heard Urdu correctly. The agent answered in English, and
 *    then said a line that admits it is a machine. (test: answers Urdu in Urdu,
 *    and: a meta line is never spoken)
 *  - 20:41:14 -> 20:41:41 STT attempt 1/4 failed ... attempt 4/4 failed, 27s,
 *    then the same again on the next three turns: 45s of silence per turn,
 *    because nothing remembered the gateway was already dead. (test: breaker)
 *  - The agent asked for the name three times running. (test: advanceLine)
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { runCall } = require("./call-runner");
const health = require("./gateway-health");
const brain = require("./intelligent-brain");

const URDU = "کون بات کر رہے ہیں؟";      // "who are you talking to?"
const URDU2 = "میرا نام جسوینڈر ہے";       // "my name is Jaswinder"
const BYE = { text: "[remote BYE]", language: "en", ended: true };

function base(over) {
  return {
    product: "truck dispatch services",
    leadFields: [],
    persona: { name: "Atlas" },
    companyName: "Zaz Logistics",
    callbackNumber: null,
    callbackIn: null,
    contactEmail: null,
    learning: null,
    locale: "en",
    preparedOpeningText: "Hi, this is Atlas with Zaz Logistics.",
    portal: "https://portal.test",
    deviceToken: "tok",
    ...over,
  };
}

function run(script, fetchStub) {
  const spoken = [];
  const listenCalls = [];
  let i = 0;
  if (fetchStub) global.fetch = fetchStub;
  return runCall({
    ...base(),
    speak: async (line, o) => spoken.push({ line: String(line), locale: o && o.locale }),
    listen: async () => {
      const idx = listenCalls.length;
      listenCalls.push(idx);
      return idx < script.length ? script[idx] : BYE;
    },
  }).then((out) => ({ out, spoken, listenCalls }));
}

async function main() {
  health.reset();

  // 1. A turn heard in Urdu is answered in Urdu, once the call has moved there.
  const ur = await run([
    { text: URDU, language: "ur" },
    { text: URDU2, language: "ur" },
    BYE,
  ], async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ text: "میرا نام جسوینڈر ہے، کیا آپ سن رہے ہیں؟" }),
  }));
  const urReplies = ur.spoken.filter((s) => s.locale === "ur");
  assert.ok(urReplies.length > 0,
    "a call that has confirmed Urdu must be answered in Urdu, got: " + JSON.stringify(ur.spoken.map(s => [s.locale, s.line])));
  for (const r of urReplies) {
    // Predominantly non-Latin, not "contains zero ASCII" - a trailing full stop
    // is fine, an English sentence is not.
    const stripped = r.line.replace(/[^\p{L}\p{N}]/gu, "");
    const ascii = (stripped.match(/[\u0000-\u007F]/g) || []).length;
    assert.ok(ascii / Math.max(1, stripped.length) < 0.3,
      "the Urdu reply must be in Urdu, not English: " + r.line);
  }

  // 1b. ONE short clip must never move a whole call. On the 18:44Z call the
  // recognizer returned "Oke, itu..." for an English "Okay, that's...", and the
  // agent spent the rest of the call speaking Indonesian to an English speaker.
  const singleClip = await run([
    { text: "Yes, I can hear you.", language: "en" },
    { text: "Oke, itu...", language: "id" },
    { text: "Yes, ten trucks in the fleet.", language: "en" },
    BYE,
  ], async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ text: "Great, thanks. How many trucks do you run?" }) }));
  assert.equal(singleClip.out.locale, "en",
    "one Indonesian clip must not move an English call to Indonesian");
  assert.ok(
    !singleClip.spoken.some((s) => /Terima kasih|Apakah sekarang|waktu yang tepat/i.test(s.line)),
    "the agent must not speak Indonesian after a single clip: " + JSON.stringify(singleClip.spoken.map(s => s.line))
  );
  assert.ok(
    !singleClip.out.timeline.some((t) => t.event === "language-switch"),
    "a single unconfirmed detection must not emit a language switch"
  );

  // 1c. Non-Latin text on a non-Latin call is CORRECT and must be spoken. The
  // controller's guard fired on any non-Latin text regardless of locale, so a
  // call correctly switched to Urdu had the agent go silent for 25 seconds
  // instead of speaking the Urdu it had been given.
  const ctrl = fs.readFileSync(path.resolve(__dirname, "local-call-controller.js"), "utf8");
  assert.match(ctrl, /isMostlyNonLatin\(spoken\)\s*&&\s*!NON_LATIN_LOCALE\.has\(/,
    "the non-Latin guard must only fire when the current voice cannot speak the script");

  // 2. Urdu, then one short clip misread as English, then Urdu: the call must
  //    still move to Urdu. That is exactly the 20:40Z pattern (ur, en, ur).
  const mixed = await run([
    { text: URDU, language: "ur" },
    { text: "Hello.", language: "en" },
    { text: URDU2, language: "ur" },
    BYE,
  ], async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ text: "اچھا، شکریہ۔" }) }));
  assert.equal(mixed.out.locale, "ur", "ur,en,ur must still reach Urdu");

  // 2. The 18:44Z call, replayed. It is the call that could not sell: asked who
  //    was calling and never told, asked "is this a good time" three times, went
  //    25 seconds silent, and flipped to Indonesian on one short clip.
  const brainSays = async (line) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ text: line }) });
  const asked = await run([
    { text: "Who is this?", language: "en" },
    { text: "Thank you.", language: "en" },
    { text: "Who is this?", language: "en" },
    { text: "Oke, itu...", language: "id" },
    { text: "Yes, ten trucks.", language: "en" },
    BYE,
  ], await brainSays("This is Atlas with Zaz Logistics. Is now a good time to talk?"));
  const said = asked.spoken.map((s) => s.line);
  const introTurn = said.find((l) => /who|Atlas/i.test(l) || l === said[1]);
  assert.ok(
    said.some((l) => /Atlas/i.test(l)),
    "asked \"Who is this?\" - the agent must give its name. Said: " + JSON.stringify(said)
  );
  const openerRepeats = said.filter((l) => /\b(?:is (?:now )?(?:this|it) a good time|good time to talk)\b/i.test(l));
  assert.ok(
    openerRepeats.length <= 1,
    "\"is this a good time to talk\" is an opener, not a mid-call line. Said " + openerRepeats.length + " times: " + JSON.stringify(said)
  );
  assert.ok(
    !said.some((l) => /Terima kasih|Apakah|waktu yang tepat/i.test(l)),
    "one Indonesian clip must not move the call: " + JSON.stringify(said)
  );

  // 3. A meta line is never spoken, whatever the model returns.
  const meta = await run([
    { text: "Okay, go ahead.", language: "en" },
    { text: "Tell me more.", language: "en" },
    BYE,
  ], async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ text: "I want to answer that accurately rather than guess. Let me note it for the team to follow up." }),
  }));
  for (const s of meta.spoken) {
    assert.ok(!/rather than guess|note it for the team|as an ai|i'?m an? (?:ai|bot|assistant)/i.test(s.line),
      "a meta line reached the voice: " + s.line);
  }

  // 4. The same question is never asked twice. The 20:40Z call asked for the
  //    name three times running.
  const nameAgain = await run([
    { text: "Okay, go ahead.", language: "en" },
    { text: "Jaswinder.", language: "en" },
    { text: "Yes, ten trucks.", language: "en" },
    BYE,
  ], async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ text: "Could I get your name to start?" }) }));
  const nameAsks = nameAgain.spoken.filter((s) => /your (?:full )?name/i.test(s.line));
  assert.ok(nameAsks.length <= 1, "the name was asked " + nameAsks.length + " times: " + JSON.stringify(nameAgain.spoken.map(s => s.line)));

  // 5. The breaker: once the STT gateway has failed repeatedly, stop paying.
  health.reset();
  for (let i = 0; i < 3; i++) health.recordFailure("stt");
  assert.equal(health.isOpen("stt"), true, "the breaker must open after repeated failures");
  assert.ok(/fail/i.test(health.reason("stt")), "an open breaker must explain itself");
  const t0 = Date.now();
  assert.equal(health.isOpen("stt"), true, "an open breaker stays open");
  health.recordSuccess("stt");
  assert.equal(health.isOpen("stt"), false, "one success must close the breaker");
  assert.ok(Date.now() - t0 < 50, "failing fast must be instant");

  // 6. A brain request against an open breaker returns instantly, not after
  //    two 5s timeouts. This is the 21s-per-turn delay.
  health.reset();
  for (let i = 0; i < 3; i++) health.recordFailure("brain");
  const t1 = Date.now();
  const dead = await brain.nextTurn({ ...base(), history: [{ role: "user", content: "hello" }] });
  const elapsed = Date.now() - t1;
  assert.ok(elapsed < 250, "a dead gateway must fail fast, took " + elapsed + "ms");
  assert.ok(!/^[^\n]*http/i.test(dead.error || "") || /fail/i.test(dead.error || ""), "the reason must be honest: " + dead.error);
  health.reset();

  // 7. The apology for not hearing must not cost a brain round trip. Four STT
  //    timeouts and then a 7s model call is how "Sorry, I did not catch that"
  //    became a 45s turn.
  const src = require("node:fs").readFileSync(require.resolve("./call-runner"), "utf8");
  const unheardBlock = src.slice(src.indexOf("heardResult.unheard"));
  assert.ok(
    !/askBrain/.test(unheardBlock.slice(0, 900)),
    "the could-not-hear recovery must not call the brain - that is 7s of dead air per turn"
  );

  console.log("PASS: turn-language reply, ur/en/ur switch, no meta lines, no repeated asks, fast-fail breaker");
}

main().catch((e) => { console.error(e); process.exit(1); });
