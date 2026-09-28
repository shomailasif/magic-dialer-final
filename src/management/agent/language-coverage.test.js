"use strict";
/**
 * Every supported language must be able to speak and to be recognised on its own.
 *
 * Two real defects motivated this file, both of which were invisible until a
 * live call was read back:
 *
 *  1. "ur" was declared supported but had no voice, so edgeVoiceFor("ur")
 *     returned the English default and the agent read Urdu in an American
 *     accent. A declared language with no voice is worse than an undeclared one.
 *  2. "fi" pointed at "fi-FI-SelmaNeural", which is not a real Edge voice.
 *     Checked against Microsoft's live list, Finnish is only Harri (M) and
 *     Noora (F). An unknown short name is not a bad accent, it is a failed
 *     synthesis - Finnish had no voice at all.
 *
 * The manifest below was verified one-by-one against
 * https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list
 * (322 voices). It is pinned so a typo can never ship again; CI has no network,
 * so this is the offline guard. If a voice is ever retired, update this list
 * deliberately instead of letting the agent fall back to English.
 */

const assert = require("node:assert");
const L = require("./language");
const V = require("./voice");

const PINNED_VOICES = Object.freeze({
  en: "en-US-AvaNeural", es: "es-ES-ElviraNeural", fr: "fr-FR-DeniseNeural",
  de: "de-DE-KatjaNeural", pt: "pt-BR-FranciscaNeural", it: "it-IT-ElsaNeural",
  nl: "nl-NL-ColetteNeural", pl: "pl-PL-ZofiaNeural", ru: "ru-RU-SvetlanaNeural",
  uk: "uk-UA-PolinaNeural", tr: "tr-TR-EmelNeural", ar: "ar-SA-ZariyahNeural",
  hi: "hi-IN-SwaraNeural", ur: "ur-PK-UzmaNeural", zh: "zh-CN-XiaoxiaoNeural",
  ja: "ja-JP-NanamiNeural", ko: "ko-KR-SunHiNeural", id: "id-ID-GadisNeural",
  ms: "ms-MY-YasminNeural", vi: "vi-VN-HoaiMyNeural", th: "th-TH-PremwadeeNeural",
  he: "he-IL-HilaNeural", el: "el-GR-AthinaNeural", cs: "cs-CZ-VlastaNeural",
  ro: "ro-RO-AlinaNeural", sv: "sv-SE-SofieNeural", da: "da-DK-ChristelNeural",
  fi: "fi-FI-NooraNeural", nb: "nb-NO-PernilleNeural", sk: "sk-SK-ViktoriaNeural",
  sl: "sl-SI-PetraNeural",
});

// A phrase a real speaker would use to open. Detection has to work from the
// transcript alone, because the STT language field is absent often enough that
// relying on it means "English unless the STT feels like it".
const SAMPLE_OPENING = Object.freeze({
  en: "Hello there, can I help you?", es: "Hola senor, buenos dias, gracias",
  fr: "Bonjour madame, merci beaucoup", de: "Guten morgen, herr, danke schon",
  pt: "Ola senhor, obrigado", it: "Buongiorno, grazie mille",
  nl: "Goedemorgen, dank je wel", pl: "Dzień dobry, proszę",
  ru: "Здравствуйте, спасибо большое", uk: "Привіт, дякую",
  tr: "Merhaba, tesekkur ederim", ar: "مرحبا، شكرا جزيلا",
  hi: "नमस्ते, धन्यवाद", ur: "السلام علیکم، شکریہ", zh: "你好，谢谢",
  ja: "こんにちは、ありがとう", ko: "안녕하세요, 감사합니다",
  id: "Halo, terima kasih", ms: "Selamat pagi, apa khabar",
  vi: "Xin chào, cảm ơn", th: "สวัสดี ขอบคุณ", he: "שלום, תודה",
  el: "Γεια σας, ευχαριστώ", cs: "Dobrý den, děkuji",
  ro: "Bună ziua, mulțumesc", sv: "Hej, tack för", da: "Hej, tak for det",
  fi: "Hei, kiitos", nb: "Hei, takk", sk: "Dobrý deň, ďakujem",
  sl: "Živjo, hvala",
});

function main() {
  const codes = Object.keys(L.SUPPORTED_LANGUAGES);

  assert.equal(codes.length, 31, "the supported language set must not shrink silently");
  assert.deepEqual(
    Object.keys(PINNED_VOICES).sort(), codes.slice().sort(),
    "PINNED_VOICES and SUPPORTED_LANGUAGES have drifted apart - update both together"
  );
  assert.deepEqual(
    Object.keys(SAMPLE_OPENING).sort(), codes.slice().sort(),
    "every supported language needs a sample opening, or it is untested"
  );

  // 1. Every language must resolve to its own verified voice.
  for (const c of codes) {
    const got = V.edgeVoiceFor(c);
    assert.equal(got, PINNED_VOICES[c], `${c} must use ${PINNED_VOICES[c]}, got ${got}`);
    assert.notEqual(
      got, "en-US-JennyNeural",
      `${c} has no voice of its own and would be read by an English voice`
    );
    // Edge short names are <locale>-<Name>Neural. A malformed one is a 404 at
    // synthesis time, which is silence on a live call.
    assert.match(got, /^[a-z]{2}(-[A-Za-z]{2,4})?-[A-Za-z]+Neural$/, `${c}: ${got} is not an Edge voice name`);
    assert.ok(
      got.toLowerCase().startsWith(c + "-") || got.toLowerCase().startsWith(c),
      `${c} is being spoken by a voice for a different language: ${got}`
    );
  }

  // 2. Every language must be recognisable from the transcript alone.
  for (const c of codes) {
    assert.equal(
      L.detectLanguageText(SAMPLE_OPENING[c], "MISS"), c,
      `${c} cannot be self-detected from "${SAMPLE_OPENING[c]}"`
    );
  }

  // 3. Punjabi stays out on purpose: Microsoft publishes 322 Edge voices and none
  // are Punjabi, so there is no spoken output to route to. Registering it would
  // only produce an English voice reading Punjabi.
  assert.equal(L.SUPPORTED_LANGUAGES.pa, undefined, "Punjabi has no Edge voice and must stay unregistered");
  assert.equal(L.normalizeLanguage("punjabi", "en"), "en", "Punjabi must not be claimed as supported");

  // 4. The eight languages the operator actually calls on must all be intact.
  for (const c of ["en", "ur", "es", "ru", "fr", "it", "zh"]) {
    assert.ok(L.SUPPORTED_LANGUAGES[c], `${c} must be supported`);
    assert.equal(V.edgeVoiceFor(c), PINNED_VOICES[c], `${c} voice regressed`);
  }

  // 5. Romanized speech must not be mistaken for the wrong language. The STT
  // returns "assalam, kya aap Urdu mein..." for Urdu audio often enough that a
  // strict script rule refused a correctly detected Urdu turn and the agent
  // stayed in English for the whole call.
  const G = require("./script-guard");
  const romanUrdu = "assalam, kya aap Urdu mein baat kar sakte hain?";
  assert.equal(
    G.scriptAgreesWithLocale(romanUrdu, "ur", { fromDetection: true }), true,
    "romanized Urdu from the STT must be allowed through"
  );
  assert.equal(
    G.scriptAgreesWithLocale(romanUrdu, "ur"), false,
    "romanized text must still be rejected when the label is only a guess"
  );
  assert.equal(
    G.scriptAgreesWithLocale("theek hai, mera naam", "ur"), false,
    "the mislabel guard must keep working without fromDetection"
  );
  // The guard still refuses a genuinely mislabelled clip in both directions.
  assert.equal(
    G.scriptAgreesWithLocale("yes of course", "ru", { fromDetection: true }), false,
    "English text must never be taken as Russian"
  );
  assert.equal(
    G.scriptAgreesWithLocale("Здравствуйте", "en", { fromDetection: true }), false,
    "Cyrillic text must never be taken as English"
  );
  for (const [c, txt] of Object.entries(SAMPLE_OPENING)) {
    assert.equal(
      G.scriptAgreesWithLocale(txt, c, { fromDetection: true }), true,
      `${c} must pass its own script check: "${txt}"`
    );
  }

  console.log("PASS: 31 languages, 31 verified voices, 31 self-detecting");
}

main();
