"use strict";
/**
 * Filler that answers a question by describing the conversation instead of the
 * subject.
 *
 * On the call of 13 Oct the prospect asked what we do and got "just need a couple
 * of quick details". It is the most dangerous reply in the set, because it is a
 * complete, grammatical, polite sentence containing no information at all - and
 * it describes the CALL rather than the BUSINESS. The prospect asked what we do
 * and was told what we are about to ask them. From that moment the call is
 * something to sit through.
 *
 * The unanswered-question guard in call-runner could not catch it. It rejects a
 * reply that is itself a question, and a reply that is only an acknowledgment.
 * This is neither, so it went to the voice and the brain was never asked again.
 *
 * The false-positive cost shapes the whole design. A real answer thrown away
 * costs a second brain call, and a second brain call can be WORSE than the good
 * answer we already had - the 13 Oct call lost good answers to vague ones the
 * other way. So this needs BOTH halves: a vague phrase, AND no concrete claim
 * anywhere in the line. One number, one truck, one place is somebody saying
 * something, even when it opens with "basically".
 */

/* Describing the call rather than making a claim. */
const VAGUE_FILLER_RE = new RegExp([
  "\\bjust (?:a )?(?:couple|few|quick|brief|simple)\\b",
  "\\b(?:a )?couple of (?:quick |brief |simple )?(?:details|questions|things|points)\\b",
  "\\ba few (?:quick |brief )?(?:details|questions|things)\\b",
  "\\bneed (?:a )?(?:couple|few) (?:of )?(?:quick |brief )?(?:details|questions|things)\\b",
  "\\bto get you the best (?:rates?|prices?|deal)\\b",
  "\\bbest (?:rates?|prices?) (?:possible|for you)\\b",
  "\\b(?:it(?:'| i)s|that(?:'| i)s) all about getting you\\b",
  "\\ball about getting you the best\\b",
  "\\bwe help (?:businesses|companies|people|truckers|carriers)\\b",
  "\\bhelping businesses\\b",
  "\\bit depends on (?:what |your )?needs?\\b",
  "\\bdepends on your needs?\\b",
  "\\bwe tailor (?:it|our services?|things|everything) to you\\b",
  "\\b(?:our )?standard (?:package|plan)\\b",
  "\\bcompetitive (?:rates?|prices?)\\b",
  "\\bquality service\\b",
  "\\bwe(?:'| a)?ll take care of (?:everything|it all)\\b",
  "\\ba few more details\\b",
  "\\bjust to make sure i understand\\b",
].join("|"), "i");

/* Filler that stays filler whatever noun you drop into it.
 *
 * "We help businesses with their freight needs" names freight, so the concrete
 * check below sees a fact and keeps it - and it is still a sentence that tells a
 * trucker nothing they did not already suspect. "with their ... needs" and "we
 * help <generic plural>" describe a class of customers rather than a service, so
 * these bypass the concrete check entirely.
 *
 * The noun list is kept small on purpose: a wrong entry here discards a real
 * answer, and that is the expensive direction to be wrong in. */
const VAGUE_STRONG_RE = new RegExp([
  "\\bwe help (?:businesses|companies|people|truckers|carriers|drivers)\\b",
  "\\bhelping (?:businesses|companies|people|truckers|carriers)\\b",
  "\\bwith their (?:\\w+\\s+)?needs\\b",
  "\\bwe(?:'| a)?re here to help\\b",
  "\\bthat is (?:where|what) we come in\\b",
  "\\bmaking (?:freight|shipping|transport) (?:easy|better|simpler)\\b",
  /* "getting you the best rates" - the phrase itself is the non-answer. It names
   * rates, so the concrete check would otherwise read "rates" as a fact and let
   * through the single most common way of describing the call instead of the
   * business. */
  "\\bgetting you the best\\b",
  "\\bbest (?:rates?|prices?|deals?) (?:possible|out there|in the market)\\b",
  "\\b(?:offer|provide) (?:you )?(?:the )?(?:most )?competitive\\b",
  "\\bcompetitive (?:rates?|prices?|pricing)\\b",
  /* "it depends on what you need" - the polite refusal to say anything. */
  "\\bit depends on (?:what|your|their)\\b",
  "\\bthat depends on what\\b",
].join("|"), "i");

/* Anything a listener could check. Present means the line is doing work. */
const CONCRETE_CLAIM_RE = /\d|\b(?:zaz|dispatch|freight|load(?:s|ing|s)?|truck(?:s|ing)?|trailers?|carrier(?:s)?|rate(?:s)?|mc ?number|dot ?number|email|domain|website|fleet|insurance|lahore|karachi|islamabad|rawalpindi|faisalabad|miles?|tons?|tonnage|feet|foot|inches?|percent|guarantee|contract|lanes?|marketplace|broker|cash ?flow|paperwork|invoicing|factoring)\b/i;

/**
 * True only when the line is filler AND says nothing checkable AND is short
 * enough that a retry is worth it.
 */
function isVagueNonAnswer(line) {
  const s = String(line == null ? "" : line).trim().replace(/\s+/g, " ");
  if (!s) return false;
  if (s.length > 160) return false;
  /* The strong list bypasses the concrete check, so it is only trusted on a
   * short line. "We offer competitive rates" is filler at 27 characters;
   * "Our rates are competitive because we have no broker margin" is a real
   * answer and is far longer, and the difference is the whole point. */
  if (s.length <= 90 && VAGUE_STRONG_RE.test(s)) return true;
  if (!VAGUE_FILLER_RE.test(s)) return false;
  /* A long line with filler in it is usually carrying a real answer somewhere in
   * the middle, and the retry would cost more than the vagueness does. */
  return !CONCRETE_CLAIM_RE.test(s);
}

module.exports = { VAGUE_FILLER_RE, VAGUE_STRONG_RE, CONCRETE_CLAIM_RE, isVagueNonAnswer };