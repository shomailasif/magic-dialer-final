"use strict";
/**
 * Baseline sales tactic library.
 *
 * Web research for sales strategies is a hard requirement, and it is built: the
 * agent searches the open web per topic and mines techniques out of real pages.
 * But free search from a datacenter IP is not dependable, and that was measured
 * rather than assumed - across one session:
 *   - DuckDuckGo Lite answered once, then returned HTTP 202 with an empty body
 *     for everything after
 *   - Bing served ChatGPT pages for "cold call opener script for truck dispatch
 *     services" and WhatsApp pages for a freight-closing query
 *   - Mojeek returns a stub page
 *   - a SearXNG instance worked (45 results across two queries) but then began
 *     answering with nothing under repeated calls
 *   - of sixteen direct sales-blog URLs probed, one returned usable text and the
 *     rest were 404 or 403
 *
 * So a hard requirement cannot rest on that alone. These tactics are the floor:
 * specific, phone-usable techniques drawn from the sources already cited in
 * brain.js (Gong Labs, HubSpot, Sandler, RAIN Group, Cognism, Prospeo). Live
 * research, when it succeeds, is merged on top of this, never instead of it.
 *
 * Every tactic is written to be said in one breath on a phone call. Anything
 * that would need a screen to understand does not belong here.
 */

const LIBRARY = {
  opener: [
    "Give the reason for the call in the first breath, then ask whether it is a good time - a named reason makes the ask tiny and reversible.",
    "Name the specific lane, load or problem you already know about them, then ask one question about it; specificity is the strongest thing you can say early.",
    "Use we-language rather than I-language when describing what you do - winning calls use we and our far more than I and my.",
  ],
  objection: [
    "When they say they are not interested, do not defend. Pause, then ask what they are currently paying per mile, so the problem is theirs to state.",
    "About half of not interested is a reflexive brush-off before any value has landed, so acknowledge it and reframe once instead of arguing.",
    "If they say to send information, ask one qualifying question before you send anything - send me info is usually a polite exit and a question keeps it a conversation.",
  ],
  discovery: [
    "Ask about their current setup before you offer anything: how dispatch works for them today, and who handles it.",
    "Ask where they run empty, and how often, before you say anything about your own service.",
    "Ask what a bad week costs them, in their own words, rather than offering a number.",
  ],
  closing: [
    "Close assumptively - ask about the logistics of the next step, such as whether they have a moment to put it in the diary, rather than asking if they want it.",
    "After two positive signals, ask for one small reversible commitment rather than a big one; small commitments convert.",
    "Offer a single-load comparison against whatever they run now - existing dispatch is the proof that dispatch pays, without attacking what they have.",
  ],
  followup: [
    "After silence, leave one short voicemail that names the reason for the call and stops. Do not stack a second ask on it.",
    "If they say they are busy, do not hang up on the spot; pin a specific callback slot, because unbooked callbacks convert far worse.",
    "Bring up something specific you noticed about their business rather than repeating your pitch.",
  ],
};

/**
 * Flattened and balanced, in a stable order.
 * Round-robin across topics, because taking them in declaration order hands the
 * prompt three openers and nothing else - the agent needs coverage of the whole
 * call, not a good start to it.
 */
function baselineTactics(limit = 8) {
  const topics = Object.keys(LIBRARY);
  const out = [];
  for (let i = 0; out.length < limit; i++) {
    let added = false;
    for (const topic of topics) {
      const list = LIBRARY[topic];
      if (i < list.length) {
        out.push({ topic, tactic: list[i], source: "curated playbooks" });
        added = true;
        if (out.length >= limit) break;
      }
    }
    if (!added) break; // every topic exhausted
  }
  return out;
}

module.exports = { LIBRARY, baselineTactics };
