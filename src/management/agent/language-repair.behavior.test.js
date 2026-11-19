"use strict";
/**
 * A call configured for Urdu was answered in English.
 *
 * Naming the language in the system prompt is necessary but not sufficient: the
 * 20b fallback ignored the ACTIVE CONVERSATION LANGUAGE line and replied
 * "A dispatcher can confirm the rate. What lanes do you run?" to an Urdu turn.
 * The offline policy is English-only, so on a machine with no hosted key an
 * Urdu, Arabic or Hindi call was English for its whole length.
 *
 * So the spoken line is checked, and one correction turn is spent before it
 * reaches the voice. What this file pins:
 *
 *   1. The check catches English and lets the right language through - both the
 *      native script (اردو) and the Latin-script form the STT actually returns
 *      (Roman Urdu), because refusing Roman Urdu is what left a real call in
 *      English.
 *   2. One repair turn, with the bad reply in the transcript, and only one.
 *   3. If the model still answers in English, the first answer is spoken. A
 *      wrong-language sentence is bad; a silent line on a live call is worse.
 *   4. English calls never pay for any of this.
 */
const assert = require("node:assert/strict");
const path = require("node:path");

const { replyLanguageOk, looksEnglish, speakInConfiguredLanguage } = require(path.join(__dirname, "intelligent-brain.js"));

const URDU_SCRIPT = "میرے پاس ابھی قیمت نہیں ہے، لیکن میں آپ کو تفصیل بھیج سکتا ہوں۔";
const ROMAN_URDU = "Aap kaise hain? Dispatch ke liye kitna charge karte hain?";
const ENGLISH_REPLY = "A dispatcher can confirm the rate. What lanes do you run?";

/* ---- 1. the check ---- */
assert.equal(looksEnglish(ENGLISH_REPLY), true, "the shipped failure must read as English");
assert.equal(looksEnglish(ROMAN_URDU), false, "Roman Urdu must not read as English: " + ROMAN_URDU);
assert.equal(looksEnglish("Claro, le puedo ayudar con eso."), false, "Spanish must not read as English");

assert.equal(replyLanguageOk(ENGLISH_REPLY, "ur"), false, "English on an Urdu call is the defect");
assert.equal(replyLanguageOk(URDU_SCRIPT, "ur"), true, "native Urdu script is compliant");
assert.equal(replyLanguageOk(ROMAN_URDU, "ur"), true, "Roman Urdu is what the STT returns; it must pass");
assert.equal(replyLanguageOk("Hola, no hablo inglés. ¿En qué puedo ayudarle?", "es"), true, "Spanish on a Spanish call is compliant");
assert.equal(replyLanguageOk("I can have the team call you back tomorrow at three.", "es"), false, "English on a Spanish call is the same defect");
assert.equal(replyLanguageOk("میرے پاس ابھی قیمت نہیں ہے", "ar"), true, "Arabic script must not be repaired away");
assert.equal(replyLanguageOk(ENGLISH_REPLY, "en"), true, "an English call is never checked");
assert.equal(replyLanguageOk("OK", "ur"), true, "two letters are not enough evidence to spend a turn on");

async function main() {
  /* ---- 2. one repair turn, with the bad reply in the transcript ---- */
  {
    const calls = [];
    const ask = async (req) => { calls.push(req); return { text: URDU_SCRIPT, model: "stub" }; };
    const fixed = await speakInConfiguredLanguage(
      [{ role: "user", content: "Mujhe dispatch chahiye. Aap kitna charge karte hain?" }],
      { locale: "ur" },
      { text: ENGLISH_REPLY },
      { ask },
    );
    assert.equal(fixed.text, URDU_SCRIPT, "the repaired reply is the one that is spoken");
    assert.equal(calls.length, 1, "exactly one repair turn");
    const sent = calls[0].history;
    assert.equal(sent[sent.length - 2].role, "assistant", "the model must see what it said");
    assert.equal(sent[sent.length - 2].content, ENGLISH_REPLY);
    assert.match(sent[sent.length - 1].content, /in Urdu only/i, "the correction must name the language: " + sent[sent.length - 1].content);
  }

  /* ---- 3. a model that will not comply does not silence the call ---- */
  {
    const stubborn = async () => ({ text: "Sure, what lanes do you run?" });
    const kept = await speakInConfiguredLanguage([], { locale: "ur" }, { text: ENGLISH_REPLY }, { ask: stubborn });
    assert.equal(kept.text, ENGLISH_REPLY, "the first answer is spoken rather than nothing");
  }

  /* ---- 4. a compliant reply and an English call cost nothing ---- */
  {
    let asked = false;
    const never = async () => { asked = true; return { text: "unused" }; };
    const good = await speakInConfiguredLanguage([], { locale: "ur" }, { text: ROMAN_URDU }, { ask: never });
    assert.equal(good.text, ROMAN_URDU);
    const english = await speakInConfiguredLanguage([], { locale: "en" }, { text: "Kya baat hai" }, { ask: never });
    assert.equal(english.text, "Kya baat hai");
    assert.equal(asked, false, "no repair turn when the reply is already compliant");
  }

  console.log("PASS: a non-English call is repaired once, and never silenced, when the brain answers in English");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
