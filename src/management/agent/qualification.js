"use strict";

/**
 * What the agent already knows, and what it still has to ask.
 *
 * The brain has no memory of the qualification checklist. It is told to "never
 * ask for something already provided" and then, having no way of knowing what
 * has been provided, does exactly that. On the 20:21Z call the prospect said
 * "26 feet bucks" and the agent asked the equipment type again nine seconds
 * later, then twice more. It also invented a "delivery destination" the customer
 * could not possibly have - and that field is not even in the customer's setup;
 * the model simply knew what a logistics call sounds like.
 *
 * So the engine tracks it. Every prospect turn is tested against the customer's
 * own field list, and the brain is told, on every single turn, what is already
 * collected and what is outstanding. That is what stops the repeats, and it is
 * why the agent can say "I still need your MC number" instead of "I just need a
 * couple more details: 1."
 *
 * The field patterns come from the customer's configuration, so this works for any
 * product they sell, not just freight.
 */

const BUILTIN = {
  NAME: /\b(?:my name(?:'s| is)|i am|i'm|this is|name(?:'s| is))\s+([a-z][\s'.-]{1,30})/i,
  "MC NUMBER": /\b(mc|dot|motor carrier|usdot|us dot|fmcsa)\s*(?:number|no\.?|#)?\s*(?:is|:)?\s*([a-z0-9][a-z0-9 -]{1,24})/i,
  "MC/DOT NUMBER": /\b(mc|dot|motor carrier|usdot|us dot|fmcsa)\s*(?:number|no\.?|#)?\s*(?:is|:)?\s*([a-z0-9][a-z0-9 -]{1,24})/i,
  "PHONE NUMBER": /\b(?:phone|mobile|number|reach me|contact)\b[^.?!]{0,20}\b(?:is|:)?\s*(\+?\d[\d\s().-]{6,17}\d)/i,
  "TEXT REQUEST": /\b(?:text|whatsapp|sms|messages?)\b|\byes,?\s*(?:by\s*)?text\b|\bno,?\s*(?:no\s*)?text\b|\btext me\b/i,
  "TRUCK TYPE": /\b(\d{2}\s*(?:ft|feet|foot)|box truck|straight truck|buck(?:s)?\b|semi|rig|van\b|reefer|refrigerated|dry van|flatbed|tanker|box\s*truck)/i,
  "TRUCK SIZE": /\b(\d{2}\s*(?:ft|feet|foot)|\d{2,3}\s*(?:ton|tons)|straight truck|box truck|semi|rig)\b/i,
  "EMPTY WHERE AND WHEN": /\b(empty(?:ing)?|heading|backhaul)\b[^.?!]{0,40}\b(?:to|from|around|in)\b|\bwhere\b[^.?!]{0,20}\bwhen\b/i,
  "WHERE AND WHEN": /\b(empty(?:ing)?|backhaul)\b[^.?!]{0,40}\b(?:to|from|around|in)\b/i,
  DESTINATION: /\b(?:go(?:ing)? to|deliver(?:y|ed)? to|drop(?:ped)? (?:at|in|off)?|destination|to (?:be )?(?:in|at))\b/i,
  EMAIL: /\b[\w.+-]+@[\w-]+\.[\w.]+\b/,
};

/* The carrier is looking for freight. The load's destination is the dispatcher's
 * to find, and asking a carrier where their load is going is the single most
 * confidently wrong thing a freight agent can say - it came up twice on the
 * 20:21Z call. Nothing in the customer's own field list asks for one. */
const DESTINATION_FIELDS = new Set(["DESTINATION", "DELIVERY DESTINATION", "DELIVERY CITY", "DESTINATION CITY", "DROP LOCATION", "DELIVER TO"]);

function normaliseField(name) {
  return String(name || "").trim().toUpperCase();
}

function patternFor(field) {
  const key = normaliseField(field);
  return BUILTIN[key] || null;
}

/** Extract any value the prospect just gave for a configured field. */
function extract(text, fields) {
  const said = String(text || "");
  const out = {};
  if (!said) return out;
  for (const f of fields || []) {
    const key = normaliseField(f);
    const re = patternFor(key);
    if (!re) continue;
    const m = re.exec(said);
    if (m && String(m[1] || "").trim()) out[key] = String(m[1]).trim();
    else if (re.test(said)) out[key] = "given";
  }
  return out;
}

/** True when the customer never asked for this field, so it must never be asked. */
function isCollectorField(field) {
  return !DESTINATION_FIELDS.has(normaliseField(field));
}

function summarise(collected, fields) {
  const asked = (fields || []).map(normaliseField).filter((f) => f && isCollectorField(f));
  const have = asked.filter((f) => Object.prototype.hasOwnProperty.call(collected || {}, f));
  const need = asked.filter((f) => !Object.prototype.hasOwnProperty.call(collected || {}, f));
  return { have, need };
}

/** The line the brain sees every turn. Short, factual, no advice. */
function checklistBlock(collected, fields) {
  const { have, need } = summarise(collected, fields);
  if (!have.length && !need.length) return "";
  const lines = ["ALREADY COLLECTED (never ask for these again):"];
  for (const f of have) lines.push(`  - ${f}: ${String(collected[f] || "given").slice(0, 80)}`);
  lines.push("STILL NEEDED (ask for these, one per turn, then stop):");
  for (const f of need) lines.push(`  - ${f}`);
  return lines.join("\n");
}

/* If we just asked for a field, a short answer IS that field, however it is
 * phrased. "It's Shamaya" in reply to "what's your name?" is a name; no regex
 * over the reply alone can know that, and getting it wrong is why the agent
 * re-asked for a name it had already been given. */
const REFUSAL = /^(?:no|nope|nah|none|not sure|don'?t know|dont know|skip|never ?mind|not right now|maybe later|n\/a)\b/i;

function attribute(askedField, text) {
  const key = normaliseField(askedField);
  const said = String(text || "").trim();
  if (!key || !said) return {};
  if (REFUSAL.test(said)) return {};              // they declined; still need it
  if (said.length > 70) return {};                 // too long to be a bare answer
  if (key === "TRUCK TYPE" || key === "TRUCK SIZE") {
    const m = patternFor(key);
    if (m && m.test(said)) return { [key]: said };
    return {};
  }
  return { [key]: said };
}

/** Which configured field a given agent question is asking for, if any. */
const QUESTION_TOPICS = [
  ["MC NUMBER", /\b(mc|dot|motor carrier|usdot|fmcsa)\b/i],
  ["MC/DOT NUMBER", /\b(mc|dot|motor carrier|usdot|fmcsa)\b/i],
  ["PHONE NUMBER", /\b(phone|mobile|cell|best number|reach you|text (?:you|updates))\b/i],
  ["TEXT REQUEST", /\b(text|whatsapp|sms)\b.*\b(want|would you like|interested|send)\b|\b(do you want|would you like)\b.*\b(text|sms)\b/i],
  ["NAME", /\byour name\b|\bname,? please\b|\bwho am i speaking\b|\bwho is this\b/i],
  ["TRUCK TYPE", /\bwhat (?:type|kind) of (?:truck|equipment|vehicle)\b|\bwhich equipment\b|\bwhat equipment\b|\bsize and type of (?:truck|equipment)\b/i],
  ["TRUCK SIZE", /\bhow (?:many|much)\b[^.?!]{0,24}\b(trucks|trailers|units)\b|\bhow big\b|\bfleet size\b/i],
  ["EMPTY WHERE AND WHEN", /\bempty(?:ing)?\b|\bbackhaul\b|\bwhen and where\b|\bwhere and when\b/i],
];

function fieldAskedAbout(line, fields) {
  const said = String(line || "");
  if (!said) return "";
  for (const [field, re] of QUESTION_TOPICS) {
    if (re.test(said) && (fields || []).some((f) => normaliseField(f) === field)) return field;
  }
  return "";
}

module.exports = {
  extract, summarise, checklistBlock, isCollectorField, attribute, fieldAskedAbout,
  DESTINATION_FIELDS, normaliseField,
};
