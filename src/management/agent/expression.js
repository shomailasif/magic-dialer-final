"use strict";
/**
 * Voice expression.
 *
 * The agent sounded flat because every turn was synthesised identically:
 * pitch +0Hz, volume +0%, one global rate. A real salesperson's voice moves with
 * the moment - a warm slightly slower opener, a lift on a question, calm and
 * slower when handling an objection, warmth and a small drop on the close.
 *
 * Edge TTS exposes exactly this through SSML prosody (pitch / rate / volume) and,
 * for voices that have them, mstts:express-as styles. This module turns the
 * *intent* of a turn into those settings. Intent comes from the conversation
 * layer, which is the only place that knows what the turn is for.
 *
 * Deliberately conservative:
 *   - the deltas are small. A big pitch or rate jump is the "uncanny valley" of
 *     TTS, and the prospect is on a phone, not listening to a demo.
 *   - every setting is clamped, so no caller can produce an unlistenable turn.
 *   - if a style is not supported by the chosen voice the synthesis still works;
 *     styles are best-effort, prosody is the reliable part.
 */

/* The conversational moments we can recognise, and how the voice should sit. */
const EXPRESSIONS = {
  /* The opener: warm, unhurried, a touch of lift so it sounds like a person
   * rather than a recording. */
  opening: { ratePct: -4, pitchHz: 2, volumePct: 2, style: "friendly" },
  /* Asking something: pitch rises slightly, which reads as genuine curiosity
   * instead of reading a form. */
  question: { ratePct: 0, pitchHz: 4, volumePct: 0, style: "friendly" },
  /* "Not interested" / "too busy" / "send me info": slower and calmer, and
   * deliberately no sales energy. Pushing here is what loses the call. */
  objection: { ratePct: -8, pitchHz: -2, volumePct: -3, style: "empathetic" },
  /* Reassuring, or the prospect is anxious about cost/commitment. */
  reassurance: { ratePct: -6, pitchHz: 0, volumePct: -2, style: "gentle" },
  /* Confirming we understood: short, level, a little quieter - this is where a
   * flat robot reads as not listening. */
  acknowledge: { ratePct: -3, pitchHz: -1, volumePct: -3, style: "gentle" },
  /* Dead air: a check-in should not sound like the same sales pitch again. */
  checkin: { ratePct: -5, pitchHz: 1, volumePct: -1, style: "friendly" },
  /* The close: warm, unhurried, and slightly quieter so it lands as a
   * statement rather than another ask. */
  closing: { ratePct: -6, pitchHz: 1, volumePct: 0, style: "friendly" },
  /* Anything unrecognised: no movement at all. */
  neutral: { ratePct: 0, pitchHz: 0, volumePct: 0, style: null },
};

/* Text patterns that reveal the moment, used when the caller does not say. */
const HINTS = [
  [/\?/, "question"],
  [/\b(not interested|not interested right now|no thanks|no thank you|too busy|not now|remove me|stop calling|do not call|not right now)\b/i, "objection"],
  [/\b(i understand|that makes sense|no problem|of course|absolutely|glad to help|sorry about that|i can help|to be clear)\b/i, "reassurance"],
  [/\b(got it|understood|thanks for that|thank you for|i hear you|noted)\b/i, "acknowledge"],
  [/\b(can you hear me|still there|are you there|just checking the line|hello\?)\b/i, "checkin"],
  [/\b(thanks? for your time|have a (great|good) day|goodbye|we('ll| will) (call|be in touch|follow up)|manager will call)\b/i, "closing"],
];

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));

/** Best guess at the moment from the text, when the caller did not say. */
function inferIntent(text) {
  const s = String(text || "");
  if (!s.trim()) return "neutral";
  for (const [re, intent] of HINTS) if (re.test(s)) return intent;
  return "neutral";
}

/**
 * Prosody for a turn.
 * @param {{intent?:string, text?:string, style?:string, baseRatePct?:number}} opts
 * @returns {{ratePct:number, pitchHz:number, volumePct:number, style:string|null, intent:string}}
 */
function expressionFor({ intent, text, style, baseRatePct = 0 } = {}) {
  const key = EXPRESSIONS[intent] ? intent : inferIntent(text);
  const e = EXPRESSIONS[key] || EXPRESSIONS.neutral;
  // A caller-supplied style wins over the inferred one: the customer configured
  // it, we only supply the movement.
  const configured = String(style || "").toLowerCase().trim();
  const useStyle = configured && configured !== "human" && configured !== "frank" ? null : e.style;
  return {
    intent: key,
    ratePct: clamp((Number(baseRatePct) || 0) + e.ratePct, -25, 25),
    pitchHz: clamp(e.pitchHz, -8, 8),
    volumePct: clamp(e.volumePct, -10, 10),
    style: useStyle,
  };
}

module.exports = { EXPRESSIONS, expressionFor, inferIntent, clamp };
