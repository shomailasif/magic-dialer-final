"use strict";

/* Script guard.
 *
 * Whisper auto-detects per 1-2s clip and mislabels constantly, and the brain
 * likes to mirror whatever script the prospect used. On the 21:05Z call that put
 * Devanagari and Arabic text through an English voice, which is what produced
 * "the dumb AI is not understanding what I'm saying" - the audio was simply not
 * speech we could produce.
 *
 * Naming a language is not the mechanism and is not treated as one. What decides
 * the spoken language is script agreement plus two consecutive agreeing turns in
 * call-runner; this module is the last line of defence, refusing to put a script
 * on the wire for which we have no voice.
 */

/** Locales whose normal writing system is not Latin. */
const NON_LATIN_LOCALE = new Set([
  "ur", "ar", "hi", "zh", "ja", "ko", "th", "he", "el", "ru", "uk", "bg", "ka", "hy", "am", "fa", "bn", "ta", "te", "kn", "ml", "gu", "mr", "pa", "ne", "si", "my", "km", "lo",
]);

const NON_LATIN_RE = /\p{Script=Arabic}|\p{Script=Cyrillic}|\p{Script=Devanagari}|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Thai}|\p{Script=Hebrew}|\p{Script=Greek}|\p{Script=Armenian}|\p{Script=Georgian}|\p{Script=Ethiopic}|\p{Script=Khmer}|\p{Script=Myanmar}|\p{Script=Sinhala}|\p{Script=Tamil}|\p{Script=Telugu}|\p{Script=Kannada}|\p{Script=Malayalam}|\p{Script=Gujarati}|\p{Script=Gurmukhi}|\p{Script=Oriya}/gu;

/** Fraction of letters in the text that are written outside the Latin script. */
function nonLatinRatio(text) {
  const letters = String(text || "").replace(/[^\p{L}\p{N}]/gu, "");
  // No minimum length: a two-character Arabic fragment ("بہ") reaching an
  // English voice is just as unspeakable as a paragraph of it.
  if (!letters.length) return 0;
  return (letters.match(NON_LATIN_RE) || []).length / letters.length;
}

/** True when the text is mostly written in a non-Latin script. */
function isMostlyNonLatin(text) {
  return nonLatinRatio(text) > 0.3;
}

/** True when the words plausibly match the script the claimed locale is written
 *  in. Latin text is never a ur/ar/hi/... turn, and non-Latin text is never a
 *  Latin-script voice. Both directions must hold, otherwise a single mislabelled
 *  clip moves the whole call. */
function scriptAgreesWithLocale(text, locale) {
  const letters = String(text || "").replace(/[^\p{L}\p{N}]/gu, "");
  if (letters.length < 2) return false;
  const wantNonLatin = NON_LATIN_LOCALE.has(String(locale || "").toLowerCase());
  return wantNonLatin === isMostlyNonLatin(text);
}

module.exports = { NON_LATIN_LOCALE, nonLatinRatio, isMostlyNonLatin, scriptAgreesWithLocale };
