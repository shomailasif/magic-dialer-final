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
 *
 * THIS IS AN OUTPUT BUDGET AND IT MUST NEVER BE APPLIED TO WHAT THE CALLER
 * SAYS. A prospect's words are transcribed and handed on whole: a length cap on
 * them truncates a person mid-sentence, and "What do you" is what that looks
 * like in a transcript. Every site that calls capTurnLength is on the agent's own
 * side of the conversation - agent(), the controller's speakFn, and call-sim's
 * grading of agent turns - and none of them is on the inbound path.
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
  const s = stripSpokenArtifacts(line);
  // Even a short turn must end as a finished sentence: the model sometimes
  // emits "We help trucking companies streamline" with no terminator at all.
  if (s.length <= MAX_TURN_CHARS) return terminate(s);

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
  if (acc.length >= budget * 0.55) return terminate(acc.trim());
  // What fits is mostly filler ("Sure!", "Thanks, Raj."). Prefer the most
  // substantial whole sentence that still fits the budget.
  const fits = parts.filter(p => p.length <= budget && p.length >= 30);
  if (fits.length) return terminate(fits.reduce((a, b) => (b.length > a.length ? b : a)).trim());
  // Every sentence is either tiny or over budget. Take the most substantial
  // one whole; if even that is over budget, clip it at a clause or word
  // boundary rather than letting a ten-second turn through.
  const best = parts.reduce((a, b) => (b.length > a.length ? b : a), parts[0] || "").trim();
  if (best.length <= budget) return terminate(best);
  const clipped = best.slice(0, budget);
  // Prefer a clause boundary, so the turn still ends on a complete thought
  // ("I hear you - those empty legs can really hurt.") instead of mid-phrase.
  const clause = Math.max(clipped.lastIndexOf(", "), clipped.lastIndexOf("; "), clipped.lastIndexOf(" - "), clipped.lastIndexOf(" — "));
  if (clause > budget * 0.5) return terminate(clipped.slice(0, clause).replace(/[\s,;:–—-]+$/, "").trim());
  const lastSpace = clipped.lastIndexOf(" ");
  return terminate((lastSpace > budget * 0.4 ? clipped.slice(0, lastSpace) : clipped)
    .replace(/[\s,;:–—-]+$/, "")
    .replace(/\b(and|but|or|so|because|which|that|to|for|with|if|when)$/i, "")
    .trim());
}

/** A clipped turn must still be a finished sentence. Stripping the trailing
 *  comma off a clause boundary leaves "Thanks for letting me know" with no
 *  terminator, which is exactly what a dropped line sounds like. */
function terminate(s) {
  const t = String(s || "").trim();
  if (!t) return t;
  return /[.!?]["')\u2019]?$/.test(t) ? t : t + ".";
}

/**
 * Strip anything that is not speech before it reaches the voice.
 *
 * The model sometimes emits its own scaffolding into the reply, and on the
 * 19:28Z call it was read aloud, verbatim, to a prospect:
 *   "Got it - may I have your full name, please?[Awaiting prospect response][Awaiting]."
 * Bracketed stage directions, stray markdown, and unbalanced quotes are not
 * things a person says out loud, and a phone call is the one place where this
 * is instantly obvious.
 */
function stripSpokenArtifacts(text) {
  let s = String(text || "");
  // [Awaiting ...], [Pause], [Beats], (stage direction), *emphasis*, #heading
  s = s.replace(/\[[^\]]*\]/g, " ");
  s = s.replace(/\([^)]*\)/g, " ");
  s = s.replace(/^\s*[*_#]+\s*/gm, " ");
  s = s.replace(/[*_`]{1,3}/g, "");
  // A label the model left in, e.g. "Agent:" or "Note -"
  s = s.replace(/^\s*(agent|assistant|note|stage direction|output)\s*[:\-]\s*/i, "");
  /* A config object interpolated into the prompt used to reach the voice as
   * "[object Object]" - the system prompt said "Always introduce yourself as
   * [object Object]" and the model said it out loud. Fixed at the source, but a
   * line that still contains it is never spoken. */
  s = s.replace(/\[object [A-Za-z]+\]/g, " ");
  // Unbalanced quote left dangling mid-sentence, e.g. 'services." is now...'
  s = s.replace(/[“”"]\s+(?=(?:is|are|was|were|do|does|did|can|could|will|would|and|so|but)\b)/g, " ");
  /* Repaired text, not only stripped text.
   *
   * Two corruptions reached the voice on the 06 and 07 Oct calls:
   *   "Hi, this is Atlas from Zaz Logistics- is now a good time to talk?"
   *   "Hi, this is Atlas<bad char>"just checking if now is a good time to talk?"
   * Neither is produced anywhere in this file - they arrive that way from the
   * model or from whatever decoded them. The voice cannot tell a mangled
   * sentence from a real one, so it is repaired here, the last point before
   * synthesis, which every spoken line passes.
   *
   * lowercase-dash-capital is a sentence boundary that lost its full stop
   * ("Logistics- Is"). A replacement character is a byte lost in decoding, and
   * everything from it on is unusable, so it becomes a boundary and the residue
   * is dropped. */
  s = s.replace(/([a-z])(\s*)([-‐‑–—])(\s*)([A-Za-z])/g, (m, before, beforeGap, dash, afterGap, after) => {
    /* A dash with whitespace on BOTH sides is one the model meant, and spoken as
     * a dash it is exactly right: "a straight answer to that - I will have
     * someone call you back with it." Rewriting that would change its words.
     *
     * A dash welded to the word before it is the corruption - "Zaz Logistics- is
     * now a good time" - where a sentence boundary lost its full stop. There is
     * no English punctuation written that way, so it is always safe to repair, and
     * the case after it may be upper or lower depending on where it broke. */
    const welded = beforeGap.length === 0;
    if (!welded) return m;
    /* A real full stop starts a sentence, and sentences start capitalised. The
     * source was lowercase because it was mid-thought ("Logistics- is now"), so
     * restoring the capital is part of repairing it. */
    const head = after.toUpperCase();
    return `${before}. ${head}`;
  });
  s = s.replace(/�+["')\u2019]?\s*([a-z])/gi, (m, letter) => `. ${letter.toUpperCase()}`)
       .replace(/�+["')\u2019]?/gi, ". ")
       .replace(/�/g, "");
  s = s.replace(/\s{2,}/g, " ").trim();
  /* The model sometimes starts a list and gets cut off by the turn cap, leaving
   * "I just need a couple more quick details: 1." - which the customer hears as
   * the agent giving up mid-sentence. An opening number is never speech. */
  s = s.replace(/[,:;]\s*\d\s*[.)]?\s*$/, ".").replace(/\.\s*\d\s*[.)]?\s*$/, ".");
  s = s.replace(/\b(?:firstly|secondly|thirdly|1\)|2\)|3\))\b,?\s*/gi, "");
  s = s.replace(/\s{2,}/g, " ").trim();
  /* A turn that stops mid-thought on a function word is cut off, and the customer
   * hears the agent stop talking. "What type of truck do you" is worse than not
   * saying it - drop the fragment and keep what came before.
   *
   * This must only apply to text that is actually incomplete. A finished sentence
   * can legitimately END on one of these words, and treating that as a truncation
   * threw away most of a complete reply:
   *   "Let me get you a straight answer to that - I will have someone call you
   *    back with it."
   * became "Let." - the rule matched from the first "you" to the final "it" and
   * deleted the sentence. It was heard as "Talk." and "Let." on the 07 Oct call,
   * which is what made the agent sound like it had nothing to say.
   *
   * So: apply it only when the text does NOT end on a sentence terminator, and
   * only when there is real content before the fragment. A question is exempt for
   * the same reason - "So, what kind of truck is it?" ends on "it?" legitimately. */
  const isQuestion = /\?\s*["')\u2019]?$/.test(s);
  if (!isQuestion) {
    const usable = (t) => /[a-z]{3}/i.test(t) && t.trim().length >= 12;
    /* The tail after the last sentence boundary. A full stop does NOT make it
     * complete - the model punctuates its own truncations, which is why
     * "What type of truck do you." arrives with a period and is still a fragment.
     * What identifies it is that it OPENS as a question and then stops. */
    const lastStop = Math.max(s.lastIndexOf(". "), s.lastIndexOf("! "), s.lastIndexOf("? "));
    const tail = (lastStop >= 0 ? s.slice(lastStop + 1) : s).trim();
    const opensAsQuestion = /^(?:so|and|ok(?:ay)?|right|well|now|but)?[,\s-]*(?:what|which|who|whom|whose|where|when|why|how|can|could|would|will|should|do|does|did|is|are|was|were|have|has|tell|may|might|must)\b/i.test(tail);
    const endsOnFunctionWord = /\b(?:you|the|a|an|to|of|for|and|or|with|from|at|on|in|is|are|was|were|my|your|our|their|that|this|it)\s*[.?!]?$/i.test(tail);
    const noTerminator = !/[.!?]["')\u2019]?$/.test(s);

    if (opensAsQuestion && endsOnFunctionWord) {
      /* A question that stops mid-sentence. Drop it and keep what came before. */
      if (lastStop > 0) {
        const kept = s.slice(0, lastStop + 1).trim();
        if (usable(kept)) s = kept;
      }
    } else if (noTerminator) {
      /* Shape 2: unterminated text. Either it ends on a function word
       * ("...call you back with it" - the tail is a real sentence, so keep it)
       * or on a content word ("I was going to ask you about" - a promise with no
       * delivery, so cut it). Only the cut is applied when there is a complete
       * earlier sentence to fall back to. */
      const lastStopAny = Math.max(s.lastIndexOf(". "), s.lastIndexOf("! "), s.lastIndexOf("? "));
      if (lastStopAny > 0) {
        const kept = s.slice(0, lastStopAny + 1).trim();
        if (usable(kept)) s = kept;
      }
    }
  }
  /* A run of dots is an ellipsis, which becomes one full stop. That can leave a
   * bare "." stranded after an already-terminated sentence - "That is helpful.
   * ..." became "That is helpful. ." - which the voice reads as a second
   * sentence that says nothing. Drop the orphan. */
  s = s.replace(/\.{2,}/g, ".").replace(/([.!?])\s*\.(?=\s|$)/g, "$1").replace(/\s{2,}/g, " ").trim();
  // Normalise a trailing comma or colon into a full stop, but never touch a
  // question or an exclamation - a question has to stay a question.
  s = s.replace(/[,;:]\s*$/, ".");
  if (s && !/[.?!]$/.test(s)) s += ".";
  /* A turn can be a complete sentence and still say nothing. "Could.", "How?",
   * "Great.", "Sure." - what a model emits when it has nothing to say. A caller
   * hears the agent say the word "could" and hangs up, and it burns a turn, so
   * the prospect's next real sentence lands against a non-question and gets
   * ignored. Returned empty so the caller can be given a real line instead. */
  if (s && isContentlessTurn(s)) return "";
  return s;
}

/** Filler, bare function words and stubs: nothing a caller needs to hear. */
const CONTENTLESS = new Set([
  "hi", "hey", "hello", "oh", "okay", "ok", "sure", "great", "good", "fine",
  "thanks", "thank you", "yes", "yeah", "yep", "no", "nope", "right", "got it",
  "understood", "alright", "bye", "goodbye", "how", "what", "why", "who", "when",
  "where", "could", "would", "should", "can", "do", "did", "is", "are", "was",
  "i", "me", "my", "we", "it", "that", "this", "and", "but", "so", "well",
  "of course", "absolutely", "certainly", "exactly", "totally", "cool", "nice",
  "hello there", "good morning", "good evening", "one moment", "hold on",
  "i appreciate it", "i appreciate that", "sounds good",
]);

function isContentlessTurn(s) {
  const bare = String(s || "").toLowerCase().replace(/[.!?,;:]+$/g, "").trim();
  if (!bare) return true;
  if (CONTENTLESS.has(bare)) return true;
  if (/^(?:could|would|should|can|do|did|will|may|might)\s+(?:you|i|we|they|he|she)?$/i.test(bare)) return true;
  if (/^(?:i am|i'm|we are|we're|you are|you're|that is|that's|it is|it's)$/i.test(bare)) return true;
  return false;
}

module.exports = { MAX_TURN_CHARS, MAX_TURN_OVERSHOOT, splitSentences, capTurnLength, stripSpokenArtifacts };
