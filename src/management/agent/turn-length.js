"use strict";

/* Longest agent turn allowed on the wire.
 *
 * Measured on the 20:44Z call, edge-ws PCMU output is 428-623 bytes per
 * character, so ~110 characters is about 6 seconds of speech. The 14.1-second
 * monologue that prompted this was 229 characters. A prospect cannot get a word
 * in against a turn that long, and every extra second of monologue is a second
 * we spend talking over them.
 *
 * Enforced where the text is produced (call-runner) AND where it is put on the
 * wire (local-call-controller), so neither a live call nor an offline
 * simulation can produce an over-long turn.
 */
const MAX_TURN_CHARS = 110;

/* A turn that ends mid-thought ("...but if you ever need help coordinating")
 * sounds like the line dropped, which is the complaint we are fixing. Prefer a
 * complete sentence even if it runs a little long. */
const MAX_TURN_OVERSHOOT = 45;

/** Split into whole sentences (each keeps its terminator). */
function splitSentences(s) {
  const out = [];
  let start = 0;
  for (let i = 0; i < s.length - 1; i++) {
    const c = s[i];
    if ((c === "." || c === "!" || c === "?") && /\s/.test(s[i + 1])) {
      out.push(s.slice(start, i + 1));
      start = i + 1;
    }
  }
  const tail = s.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** Trim an over-long agent turn to whole sentences, so it stays natural speech.
 *
 * A turn that ends mid-thought ("...but if you ever need help coordinating")
 * sounds exactly like the line dropped, which is the complaint being fixed. So
 * the cap prefers a complete sentence over a short one, and never leaves a
 * dangling clause behind when a sentence boundary was available. */
function capTurnLength(line) {
  const s = String(line || "").trim();
  if (s.length <= MAX_TURN_CHARS) return s;

  const parts = splitSentences(s);
  // A trailing fragment with no terminator ("...where we can") is a truncated
  // generation, not something to speak. Drop it when a complete sentence
  // remains; the prospect hears a finished thought instead of a line that cuts
  // off mid-clause.
  if (parts.length > 1 && !/[.!?]["')\u2019]?$/.test(parts[parts.length - 1])) parts.pop();
  const budget = MAX_TURN_CHARS + MAX_TURN_OVERSHOOT;
  // Longest prefix of whole sentences that fits the budget.
  let acc = "";
  for (const p of parts) {
    const next = acc ? acc + " " + p : p;
    if (next.length > budget) break;
    acc = next;
    if (acc.length >= MAX_TURN_CHARS) break;
  }
  if (acc.length >= budget * 0.55) return acc.trim();
  // What fits is mostly filler ("Sure!", "Thanks, Raj."). Prefer the most
  // substantial whole sentence that still fits the budget.
  const fits = parts.filter(p => p.length <= budget && p.length >= 30);
  if (fits.length) return fits.reduce((a, b) => (b.length > a.length ? b : a)).trim();
  // Every sentence is either tiny or over budget. Take the most substantial
  // one whole; if even that is over budget, clip it at a word boundary rather
  // than letting a ten-second turn through.
  const best = parts.reduce((a, b) => (b.length > a.length ? b : a), parts[0] || "").trim();
  if (best.length <= budget) return best;
  const clipped = best.slice(0, budget);
  // Prefer a clause boundary, so the turn still ends on a complete thought
  // ("I hear you - those empty legs can really hurt.") instead of mid-phrase.
  const clause = Math.max(clipped.lastIndexOf(", "), clipped.lastIndexOf("; "), clipped.lastIndexOf(" - "), clipped.lastIndexOf(" — "));
  if (clause > budget * 0.5) return clipped.slice(0, clause).replace(/[\s,;:–—-]+$/, "").trim();
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace > budget * 0.4 ? clipped.slice(0, lastSpace) : clipped)
    .replace(/[\s,;:–—-]+$/, "")
    .replace(/\b(and|but|or|so|because|which|that|to|for|with|if|when)$/i, "")
    .trim();
}

module.exports = { MAX_TURN_CHARS, MAX_TURN_OVERSHOOT, splitSentences, capTurnLength };
