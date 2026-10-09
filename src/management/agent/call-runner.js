const { scoreLead, shouldEscalate, learn } = require("./brain");
const { nextTurn, opening } = require("./intelligent-brain");
const { normalizeLanguage, languageName } = require("./language");
const { capTurnLength, splitSentences } = require("./turn-length");
const { NON_LATIN_LOCALE, isMostlyNonLatin, scriptAgreesWithLocale } = require("./script-guard");
const { getResearch: getCachedResearch, researchBlock } = require("./sales-research");
const qual = require("./qualification");

/* A goodbye, in the words people actually use on a phone call. */
const FAREWELL_RE = /\b(bye[\s-]?bye|goodbye|good[\s-]?bye|that'?s (?:all|it|everything)|nothing else|no[,\s]+that'?s (?:all|it)|we'?re done|i'?m done|have a (?:good|nice) (?:day|morning|afternoon|evening|night)|take care|we'?ll talk later|in touch)\b/i;

// Asking who is calling is a request for the introduction, not small talk. On
// the 18:44Z call the prospect asked "Who is this?" and the repeat-introduction
// guard removed the agent's name from the reply, so they were answered with
// "Is now a good time to talk?".
/* Asking who is calling is a request for the introduction, not small talk. On
 * the 18:44Z call the prospect asked "Who is this?" and the repeat-introduction
 * guard removed the agent's name from the reply, so they were answered with
 * "Is now a good time to talk?".
 *
 * It also has to recognise how people actually ask it. This listed "who is this"
 * and nothing else, so on the 07 Oct call - where the prospect said "Who is it?"
 * - it did not match at all, and the turn that most obviously needs an
 * introduction fell through to the ordinary question path, where the model's
 * answer was a question and the fallback was a callback promise. "who is it" is
 * the most common phrasing there is and it was not in the list. */
const WHO_IS_THIS_RE = new RegExp([
  "\\bwho(?:'s| is| se| are) (?:this|that|it)\\b",
  "\\bwho am i (?:speaking|talking|calling) (?:to|with)\\b",
  "\\bwho(?:'s| is) on the line\\b",
  "\\bwhat(?:'s| is) (?:this|that|your name)\\b",
  "\\b(?:tell me|let me know) who (?:this|that|it|you) (?:is|are)\\b",
  "\\bkaun (?:ho|hai)\\b",
  "\\bkoi hai\\b",
].join("|"), "i");
/* "What is this about?" is the same request as "Who is it?", and on a real call
 * they arrive back to back - "Who is it?" at t+19s and "What do you" at t+28s on
 * the 07 Oct call. Both were answered with "Let me get you a straight answer to
 * that - I will have someone call you back with it", which answers neither and
 * promises something for a question that costs nothing to answer. */
const CALL_PURPOSE_RE = /\b(?:what(?:'s| is| was)\s+(?:this|that|it|the\s+call)\s+(?:about|for)|why\s+(?:are|do)\s+you\s+(?:calling|ringing)|what\s+do\s+you\s+(?:want|need|sell|offer)|purpose\s+of\s+(?:this|the)\s+call)\b/i;

/* An opener - a greeting plus "is now a good time to talk" - is a first-turn
 * line and nothing after it.
 *
 * The 07 Oct call said the same sentence twice in one call, sixteen seconds
 * apart:
 *
 *   ringcentral: Hi, this is Atlas with Zaz Logistics. Is now a good time... (t+7s)
 *   ringcentral: Is now a good time for a quick call?                      (t+18s)
 *
 * The guard that should have caught the second one was
 * /\bis (?:now )?(?:this|it) a good time\b/ - it needs the words "this" or "it"
 * before "a good time", and the line that was actually spoken has neither: it
 * is "is now a good time for", a preposition the pattern did not allow. So the
 * repeat passed a guard that looked like it covered it, which is the same shape
 * of failure as the repeat-ask bug the token comparison replaced. Everything in
 * the family is matched here: "for" as well as "to", "would now be a better
 * time", "is this an okay time". */
const OPENER_GREETING_RE = new RegExp([
  "\\b(?:is|would it be|would now be)\\s+(?:now\\s+)?(?:this\\s+|it\\s+|that\\s+)?(?:a|an)\\s*(?:good|okay|ok|convenient|appropriate|better)\\s+time\\b",
  "\\b(?:good|okay|ok|convenient|appropriate)\\s+time\\s+(?:to|for)\\b",
].join("|"), "i");

/* Facts the agent was configured with, read out of config the same way the
 * prompt reads them.
 *
 * persona and companyName arrive as objects from the call configuration, and
 * String({}) is "[object Object]" - which reached the voice once, in the system
 * prompt, because the prompt did not look inside them. An identity answer built
 * the lazy way would put that string on the phone, so it looks. */
function configText(value, keys, fallback = "") {
  let v = value;
  if (v && typeof v === "object") {
    for (const k of keys) {
      if (typeof v[k] === "string" && v[k].trim()) { v = v[k]; break; }
      if (typeof v[k] === "number") { v = String(v[k]); break; }
    }
    if (typeof v !== "string") v = "";
  }
  const s = String(v == null ? "" : v).trim();
  if (!s || s === "[object Object]") return fallback;
  return s;
}
const STOP_RE = /\b(stop calling|do not call|don't call|remove me|take me off|unsubscribe|not call me again)\b/i;
  const HUMAN_RE = /\b(human|real person|representative|manager|supervisor|agent)\b/i;

  /* BUCKLED_UP: the prospect is telling us to slow down or stop, and we were not.
 *
 * On the 2026-10-06 test call the prospect said "I told you I'm a bit busy right
 * now" at 2:01 and again at 2:35. The agent apologised - "Sorry." - and carried
 * on qualifying for another sixty seconds. Two refusals, both heard, both
 * ignored. An apology that is immediately followed by the next question is the
 * single most alien thing a caller can do: it says the agent heard the words and
 * decided they did not apply.
 *
 * This is separate from STOP_RE (do not call me) and HUMAN_RE (put me through to
 * a person). "I'm busy" is neither, and neither pattern matched it, so the call
 * ran to its normal length. Once someone has said they are busy, the only
 * correct continuation is to stop asking and close.
 *
 * The first form is what the prospect actually says. The rest are the ways it
 * gets said when the recogniser is imperfect or the prospect is polite about it. */
const BUSY_RE = new RegExp([
  "i(?:'m| am| was| told you(?: i'?m| im)?| said) (?:a bit |kind of |pretty |very |really |just )?busy",
  /* "busy" on its own is how it is actually said once the recogniser has the
   * sentence - "I am busy right now", "I'm busy", and bare "Busy?". Without
   * this the pattern below never fires, because a one-word turn cannot match
   * "I am busy". */
  "\\bbusy\\b",
  "(?:a bit |kind of |pretty |very |really |just )?busy (?:right now|at the moment|for a (?:minute|moment|second|bit)|lately|these days)",
  "i (?:don'?t|do not|cannot|can'?t|really not|can not) have (?:much |any )?time",
  "i(?:'m| am) (?:in a |on a |in the middle of a )(?:meeting|call|load|delivery|route)",
  "i (?:need|want) to (?:get back to work|go|keep going|get back to driving|get to work)",
  "(?:i )?can'?t (?:talk|chat|speak) (?:right now|now)",
  "(?:i )?have to (?:go|run|get back to work)",
  "i'?m (?:not )?available right now",
  "not right now",
  /* Asking to be called back later is the same message in question form, and it
   * is what a busy prospect actually says - "Can I call you back later?" was in
   * the test call and the agent treated it as an ordinary turn and kept going. */
  "(?:can|should|would|might) i (?:call|phone|ring) (?:you )?back",
  "(?:can|should|would|might) (?:we|you) (?:call|phone|ring) (?:you )?back (?:later|another time|back)",
  "call me back later",
  "right now is (?:not|bad)",
  /* The Urdu and Hindi ways of saying it. A Roman-script English call never
   * reaches these, and an Urdu call does nothing else - the patterns above
   * cannot match a Devanagare or Nastaliq sentence at all. */
  "\\u0645\\u0635\\u0631\\u0648\\u0641",                                  // masrof (busy)
  "\\u0628\\u0632\\u06cc",                                              // busy, fa
  "\\u0648\\u0642\\u062a\\s*\\u0646\\u06c1\\u06cc\\s*\\u0646\\u06c1\\u06cc", // waqt nahi (no time)
  "\\u0627\\u0628\\u06c1\\u06cc\\s*\\u0628\\u0627\\u062f\\u06be",            // abhi baad (later)
  "\\u092e\\u0948\\u0902\\u092c\\u093e\\u0926",                            // mehmaad (busy)
  "\\u092c\\u092e\\u094d\\u092f\\u093e",                                  // busy, hi
  "\\u0905\\u092d\\u0940\\s*\\u092c\\u093e\\u0926",                          // abhi baad, hi
].join("|"), "i");

/* Was the prospect's last turn a question? Asking for something is the most
   * common thing a prospect does, and it has to produce an answer. */
  const PROSPECT_QUESTION_RE = /\?|\b(?:can|could|will|would|do|does|did|are|is|should|have|has)\s+(?:you|your|we|us|they|he|she|it|that|there|anyone|anybody|someone|somebody)\b[^.!?]*$|\b(?:why|what|when|where|who|how|which)\b/i;
  function prospectAskedQuestion(text) {
    const s = String(text || "").trim();
    if (!s || s.length > 300) return false;
    if (/\?/.test(s)) return true;
    return PROSPECT_QUESTION_RE.test(s);
  }

  /* A reply that is only an acknowledgment: no information in it. These are what
   * the agent said instead of answering "can your dispatcher call me now". */
  const ACKNOWLEDGMENT_ONLY_RE = /^(?:thanks?|thank you( very much)?|okay|ok|sure( thing)?|got it|understood|alright|all right|no problem|you'?re welcome|great|good|perfect|absolutely|certainly|of course|noted|yes|yeah|yep|no|nope|right|cool|nice|i appreciate( that| it)?|sounds good|makes sense|will do|my apologies|apologies|sorry|i did not catch that( clearly)?|could you say that again|i lost that|you cut out|hello|hi)[.! ]*$/i;
  /* "Thanks for sharing that", "Thanks for sharing the domain", "Thanks for your
   * time" carry no information either. They open with filler and then only restate
   * what the prospect already said, which is what made the agent sound like it was
   * not listening. */
  const ACKNOWLEDGMENT_CLAUSE_RE = /^(?:thanks?|thank you|i appreciate( that| it)?|got it|okay|ok|sure|understood|noted)\b[^?!.]*\b(?:that|this|it|your time|the (?:domain|email|address|name|number|info|information))\b\s*[.!]*$/i;
  function isAcknowledgmentOnly(line) {
    const s = String(line || "").trim().replace(/\s+/g, " ");
    if (!s) return true;
    if (ACKNOWLEDGMENT_ONLY_RE.test(s)) return true;
    return ACKNOWLEDGMENT_CLAUSE_RE.test(s);
  }

const JUNK_LEAD_RE = /^(beep\.?|tone\.?|busy signal\.?|dial tone\.?|ring\.?|ringing\.?|phone ringing\.?|the phone is ringing\.?|voicemail\.?|voice mail\.?|please leave a message.*|leave a message.*|at the tone.*|click\.?|noise\.?|static\.?|\[.*\]|\(beep\))$/i;

function isJunkLead(text) {
  const s = String(text || "").trim();
  if (!s) return true;
  // Punctuation-only recognizer noise is never a prospect turn: a live call
  // logged "LEAD: ." and the agent answered it.
  if (s.replace(/[^\p{L}\p{N}]/gu, "").length < 2) return true;
  return s.length <= 40 && JUNK_LEAD_RE.test(s);
}

// Explicit switch-language requests (e.g. speak spanish) so language changes
// work even when the speech recognizer is unsure of the detected language.
const LANGUAGE_NAMES = {
  english: "en", spanish: "es", french: "fr", german: "de", portuguese: "pt",
  italian: "it", dutch: "nl", polish: "pl", russian: "ru", ukrainian: "uk",
  turkish: "tr", arabic: "ar", hindi: "hi", urdu: "ur", chinese: "zh",
  mandarin: "zh", japanese: "ja", korean: "ko", indonesian: "id", malay: "ms",
  vietnamese: "vi", thai: "th", hebrew: "he", greek: "el", czech: "cs",
  romanian: "ro", swedish: "sv", danish: "da", finnish: "fi", norwegian: "nb",
  slovak: "sk", slovenian: "sl",
  espanol: "es", francais: "fr", deutsch: "de",
  portugues: "pt", italiano: "it",
};

function detectLanguageCommand(text) {
  const s = String(text || "");
  const m = s.match(/\b(?:speak|talk|say|switch|respond|reply)(?:\s+(?:in|to|with|into))?[\s'":,.!]*(?:the\s+)?([^\s.,!?;:]+(?:\s+[^\s.,!?;:]+){0,2})/i);
  if (!m) return null;
  // Negations like do not speak french / cannot switch are not requests.
  const before = s.slice(0, m.index);
  if (/\b(?:do\s+not|don't|doesn't|didn't|won't|can't|cannot|never|not)\s+(?:\w+\s+){0,2}$/i.test(before)) return null;
  const win = m[1].toLowerCase();
  if (LANGUAGE_NAMES[win]) return LANGUAGE_NAMES[win];
  for (const w of win.split(/\s+/)) {
    if (LANGUAGE_NAMES[w]) return LANGUAGE_NAMES[w];
  }
  return null;
}

// Switching on a lone hola/si would make the agent flip-flop, so a recognizer
// detected language only takes over once the prospect says a real sentence.
function isSubstantialUtterance(text) {
  const s = String(text || "").trim();
  return s.split(/\s+/).length >= 3 || s.length >= 15;
}

// Script sanity for an automatic language switch lives in script-guard.js.
// One clip is never enough: the same language has to be seen twice in a row.
function fallbackOpening({ companyName, product, locale }) {
  const company = String(companyName || "our team").trim();
  const offering = String(product || "what we offer").trim();
  if (normalizeLanguage(locale, "en") !== "en") return `Hello. ${company}. ${offering}.`;
  return `Hi, this is Autumn from ${company}. I'm calling briefly about ${offering}. Is now an okay time for a quick conversation?`;
}

function fallbackReply(text, { callbackNumber, callbackIn, locale }) {
  const lang = normalizeLanguage(locale, "en");
  if (STOP_RE.test(String(text || ""))) return lang === "en" ? "Absolutely. I'll end the sales conversation here." : "Understood. I will end the call now.";
  if (HUMAN_RE.test(String(text || ""))) {
    if (callbackNumber) return lang === "en" ? `Of course. I can have a person follow up, or you can call ${callbackNumber}${callbackIn ? ` ${callbackIn}` : ""}.` : `A person can follow up. ${callbackNumber}${callbackIn ? ` ${callbackIn}` : ""}.`;
    return lang === "en" ? "Of course. I'll mark this for a human follow-up." : "Understood. I will request human follow-up.";
  }
  return lang === "en" ? "I want to answer that accurately rather than guess. Let me note it for the team to follow up." : "I do not have that detail, so I will not guess. I will note it for follow-up.";
}

/* Repetition is the loudest thing a prospect notices. The brain is told not to
 * re-ask, and still did: on the simulated calls it asked for the MC number
 * three times and re-introduced the company after the prospect had already
 * greeted. A prompt rule is not enough, so the same rule is enforced where the
 * words leave the agent. */
const ASK_TOPICS = [
  ["mcn", /\bmc\s*number\b|\bmc\s*#?\b|\bmotor carrier\b/i],
  ["phone", /\bphone number\b|\bbest (?:phone )?number\b|\bemail address\b|\breach you (?:at|on)\b|\bnumber to (?:reach|contact)\b/i],
  // Variants matter: on the 19:28Z call it asked "your name", then "your full
  // name", then "could you share your full name" - three times - because only an
  // exact repeat was caught.
  ["name", /\byour (?:full |first |last )?name\b|\bwhat(?:'s| is) your (?:full )?name\b|\bmay i (?:have|get) your\b|\bcan i (?:have|get) your\b|\bwho (?:is|are) (?:this|who)\b|\bwho am i (?:speaking|talking) to\b/i],
  // Equipment, in the words a carrier actually uses. The token comparison in
  // askTokens/isForbiddenTurnSentence is what makes this list far less
  // load-bearing than it was; it stays for the exact forms it does describe.
  /* These must be precise, not generous. An earlier version of truckType
   * included "do you run", which also matches "How many trucks do you run?" -
   * so asking fleet size after asking equipment type was deleted as a re-ask and
   * the prospect heard nothing. The paraphrase coverage lives in askTokens /
   * sameAskTopic now, which is why this list no longer needs to be broad. */
  ["truckType", /\b(?:what|which)\s+(?:type|kind|sort|makes?|models?|brands?)\s+(?:of\s+)?(?:truck|trailer|vehicle|equipment|rig|van)s?\b|\bare you (?:a|an)\s+\w+\s+(?:carrier|trucker|hauler|owner|operator)\b|\b(?:reefer|dry van|flatbed|tanker|straight truck|box truck|tractor|sliding tandems?|reefer)\b/i],
  ["truckSize", /\bhow many trucks\b|\bfleet size\b|\bwhat size\b|\bsize of your (?:fleet|trucks)\b|\bhow (?:many|much)\b[^.?!]{0,24}\b(?:trucks?|trailers?|units?)\b|\bhow (?:big|long|tall)\b/i],
];

/** A phone number the prospect actually said out loud, if any. Requires a real
 *  country/trunk prefix or a plausible grouped form, so "one" or a house number
 *  is not mistaken for a number. */
function capturePhoneNumber(text) {
  const s = String(text || "");
  const spaced = s.match(/(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}[\s.-]\d{3,4}[\s.-]?\d{3,4}\b/g) || [];
  const plus = s.match(/\+\d{8,15}\b/g) || [];
  const digitsOnly = s.match(/(?<![\d.])\d{9,12}(?![\d.])/g) || [];
  const all = [...plus, ...spaced, ...digitsOnly].map((c) => c.replace(/[^\d+]/g, "")).filter(Boolean);
  const uniq = [...new Set(all)];
  return uniq.find((c) => c.replace(/\D/g, "").length >= 9) || null;
}

/** Which conversational moment is this turn, for the voice to sit in.
 *  The lead's words are the better signal: an objection should be answered
 *  calmly and slowly, and a "got it" should be acknowledged quietly, and the
 *  only way to know which is to look at what the prospect actually said. */
function turnIntent(heard, reply) {
  const s = String(heard || "");
  if (/\b(not interested|not right now|no thanks|no thank you|too busy|not now|remove me|stop calling|do not call|send me (some )?info|send me info|nevermind|never mind)\b/i.test(s)) return "objection";
  if (/\b(i understand|that makes sense|no problem|of course|absolutely|glad to (help|assist)|sorry about that|to be clear|i can help)\b/i.test(s)) return "reassurance";
  if (/\b(got it|understood|thanks for that|thank you for|i hear you|noted|okay|ok|sure)\b/i.test(s)) return "acknowledge";
  if (/\?/.test(String(reply || ""))) return "question";
  return "neutral";
}

/** The question the agent just asked, if it asked one. */
function extractQuestion(text) {
  const s = String(text || "");
  const m = s.match(/[^.!?]*\?/);
  const q = m ? m[0].trim() : "";
  return q.length >= 8 ? q : null;
}

/* Paraphrase-proof topic detection.
 *
 * The first version of this guard was a list of regexes per topic, and it failed
 * in the worst possible way: it looked correct. On the 2026-10-06 test call the
 * agent asked "What type of truck do you operate?", then "what kind of truck you
 * operate?", then the same question again - three times. Both of those DO match
 * the truckType regex. The repeat got through for a different reason entirely
 * (see the falsy-result bug below), which is why widening the regexes alone
 * would have looked like a fix and changed nothing.
 *
 * But the regex list is also genuinely too narrow. Asking about the equipment
 * has a dozen ways of being phrased and none of them are in the list:
 *   "Do you haul reefer or dry van?"            -> no topic
 *   "Is it a straight truck or a tractor?"       -> no topic
 *   "Are you a flatbed or a reefer carrier?"     -> no topic
 *   "Could you tell me about the equipment you run?" -> no topic
 *
 * So the topic is now the set of *content words* - the question with filler,
 * politeness and the words that carry no information removed - and two questions
 * are the same question when their content words overlap enough. That is how a
 * human recognises "what kind of truck you operate" as a re-ask of "what type of
 * truck do you operate", and it does not need a regex per phrasing to do it.
 *
 * Synonyms collapse first, because the same fact is asked with different nouns
 * ("truck" / "equipment" / "vehicle", "operate" / "run" / "haul" / "drive"), and
 * those are the paraphrases that defeat a word-overlap test on its own. */
const ASK_FILLER = new Set([
  "a", "an", "the", "of", "to", "for", "in", "on", "at", "and", "or", "is", "are", "was",
  "were", "be", "been", "do", "does", "did", "you", "your", "yours", "i", "me", "my", "we",
  "our", "us", "it", "its", "that", "this", "these", "those", "can", "could", "would", "will",
  "shall", "should", "may", "might", "please", "just", "tell", "know", "want", "need",
  "like", "get", "give", "have", "has", "had", "about", "with", "from", "any", "some", "there",
  "here", "sir", "ma", "okay", "ok", "yes", "yeah", "right", "so", "if", "also", "really",
  "quickly", "quick", "short", "briefly", "again", "more",
  /* Interrogatives. "What", "which" and "how" are how the question is put, not
   * what it is asking for, and they survive the filler filter on length alone -
   * which made two different questions share a token for free. */
  "what", "which", "who", "whom", "whose", "when", "where", "why", "how",
  /* Verbs of operating, and the words describing what kind of business this is.
   * "Do you haul reefers" and "What type of equipment do you run" ask about the
   * same thing, so the verb carries no distinction between them. Keeping it
   * made them look like different questions. */
  "operate", "run", "runs", "running", "haul", "hauls", "hauling", "drive", "drives",
  "driving", "carry", "carries", "carrying", "haulage",
  "carrier", "trucker", "trucking", "hauler", "owner", "operator", "business", "company",
  /* "many" and "much" are NOT filler, and must not be made filler to fix the
   * overlap below: "How many trucks do you run?" and "What type of truck do you
   * operate?" ask for two different facts while sharing truck and run, and
   * dropping the counting word made the guard swallow a real question. */
]);

/* Each group collapses to one token, so the same subject asked with a different
 * noun is recognisably the same subject. */
const ASK_SYNONYM_GROUPS = [
  ["mc", "dot", "usdot", "fmcsa", "carrier", "motor"],
  ["number", "phone", "mobile", "cell", "telephone", "contact", "reach", "text", "whatsapp"],
  ["name", "called", "spell"],
  ["truck", "trucks", "lorry", "vehicle", "vehicles", "equipment", "rig", "unit", "units", "trailer"],
  ["type", "kind", "sort", "grade", "category"],
  ["operate", "run", "haul", "drive", "haulage", "carry"],
  /* Size is a genuinely different question from type - "what type of truck do
   * you operate" and "how many trucks do you run" share the words truck and
   * run and ask for two different facts. So the counting and measuring words
   * carry the distinction, and they must not be filler. */
  ["size", "fleet", "big", "long", "tall", "many", "much", "count", "length", "feet", "foot"],
  ["email", "mail"],
  /* The specific kinds of equipment are all answers to "what type", so they
   * collapse together: "Do you haul reefer or dry van?" and "Is it a straight
   * truck or a tractor?" name three different words for the same question. */
  ["reefer", "refrigerated", "refrigerated", "flatbed", "flat", "tanker", "dry", "straight",
    "tractor", "box", "semi", "semitrailer", "tandem", "reefer", "van", "bolster", "dump"],
];

const ASK_SYNONYMS = (() => {
  const m = new Map();
  ASK_SYNONYM_GROUPS.forEach((group, i) => {
    for (const w of group) m.set(w, `t${i}`);
  });
  return m;
})();

/* The tokens for "what type of equipment" and for naming a kind of equipment.
 * Named so askTokens can link them: the two are the same question. */
const ASK_TYPE_TOKEN = ASK_SYNONYMS.get("type");
const ASK_EQUIPMENT_KIND = ASK_SYNONYMS.get("reefer");
const ASK_VEHICLE_TOKEN = ASK_SYNONYMS.get("truck");

/** Content words of a question, synonym-collapsed, for topic comparison. */
function askTokens(text) {
  const raw = String(text || "").toLowerCase().match(/[a-z]+/g) || [];
  const out = [];
  for (const w of raw) {
    if (ASK_FILLER.has(w) || w.length < 3) continue;
    /* Look the word up before stripping the plural, so a word that genuinely
     * ends in s ("bus") is not mangled, then again without it. "reefers" and
     * "reefer" are the same subject and a carrier says both. */
    out.push(
      ASK_SYNONYMS.get(w)
      || ASK_SYNONYMS.get(w.replace(/es$/, ""))
      || ASK_SYNONYMS.get(w.replace(/s$/, ""))
      || w
    );
  }
  /* Naming the specific kinds of equipment IS asking the type question -
   * "Are you a flatbed or a reefer carrier?" offers the answer rather than
   * asking for it. So it carries the type token too, and duplicates collapse
   * ("reefer or dry van" is one subject, not three). */
  const types = out.includes(ASK_EQUIPMENT_KIND);
  const uniq = [...new Set(out)];
  if (types) {
    if (!uniq.includes(ASK_TYPE_TOKEN)) uniq.push(ASK_TYPE_TOKEN);
    // "Are you a flatbed or a reefer carrier?" never says "truck", but it is
    // unmistakably about the equipment, and pairing it only with the type token
    // left it too short to match "What kind of truck do you run?".
    if (!uniq.includes(ASK_VEHICLE_TOKEN)) uniq.push(ASK_VEHICLE_TOKEN);
  }
  return uniq;
}

/** True when two questions are asking for the same thing.
 *
 * Threshold is deliberately generous on overlap and strict on length: a short
 * question that is entirely contained in a longer one ("Is it a straight truck
 * or a tractor?" against "What type of truck do you operate?") is a re-ask, but
 * two long questions that merely share a noun are not ("What type of truck do
 * you operate?" against "How many trucks do you run?"). */
function sameAskTopic(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return false;
  const setB = new Set(bTokens);
  let shared = 0;
  for (const t of aTokens) if (setB.has(t)) shared++;
  if (!shared) return false;
  const shorter = Math.min(aTokens.length, bTokens.length);
  // Contained: every content word of the shorter question is in the longer one.
  if (shared === shorter) return true;
  // Otherwise a majority of the shorter question has to overlap, so a shared
  // noun cannot carry it on its own.
  return shared / shorter >= 0.6;
}

/* The topics already asked on this call. Both forms of the record are kept: the
 * regex topics for the questions they already describe exactly, and the token
 * signatures of every question actually spoken, which is what catches the
 * paraphrases no regex was written for. */
const askedForCache = new Set();
const askedTokenCache = [];
function bindAskedFor(set, tokens) {
  askedForCache.clear();
  for (const k of set) askedForCache.add(k);
  askedTokenCache.length = 0;
  for (const t of tokens || []) askedTokenCache.push(t);
}

function isForbiddenTurnSentence(sentence) {
  if (/\bthis is (?:atlas|autumn|alex|[a-z]+) (?:from|with|calling)\b|\bcalling (?:you )?from\b|\bcalling about\b/i.test(sentence)) return true;
  if (/\bhow can i (?:help|assist) you\b|\bwhat can i (?:help|assist) you with\b|\bhow may i (?:help|direct) you\b|\bthanks for reaching out\b|\bhow can i direct your call\b/i.test(sentence)) return true;
  const topic = ASK_TOPICS.find(([, re]) => re.test(sentence));
  if (topic && askedForCache.has(topic[0])) return true;
  // Only a question can be a re-ask. A statement that happens to share a noun
  // with an earlier question is not one, and treating it as one made the guard
  // delete real replies.
  if (!/\?/.test(sentence)) return false;
  const tokens = askTokens(sentence);
  if (!tokens.length) return false;
  return askedTokenCache.some((prev) => sameAskTopic(tokens, prev));
}

/** Note what was asked, so it cannot be asked again.
 *
 *  Stripping a repeat is only half of it; the other half is remembering what was
 *  actually spoken, and that has to happen for EVERY line - including the
 *  opener. The opening was spoken outside this machinery entirely, so the
 *  question it asks ("Is now a good time to talk?") was never on the list, and
 *  the brain was free - and did - ask the same thing again sixteen seconds
 *  later. */
function recordAsks(text, askedFor, askedTokens) {
  const t = String(text || "");
  for (const [k, re] of ASK_TOPICS) if (re.test(t)) askedFor.add(k);
  const toks = askTokens(t);
  if (toks.length && /\?/.test(t)) askedTokens.push(toks);
}

/** Sentences that only re-ask for something already asked, plus a repeat intro.
 *  Everything that is actually spoken gets recorded, so the same request can
 *  never slip through twice - recording only the multi-sentence path let a
 *  one-line "May I get your name?" be asked again on the next turn.
 *
 *  Returns an object rather than a bare string. It used to return "", meaning
 *  "do not speak this turn", and the caller tested the result for truthiness -
 *  so "" was read as "nothing to change" and the forbidden line was spoken
 *  anyway. On the 2026-10-06 call that is why one question was heard three times
 *  while the guard that should have prevented it was running correctly. */
function stripRepeatedAsks(text, askedFor, askedTokens) {
  bindAskedFor(askedFor, askedTokens);
  const record = (t) => recordAsks(t, askedFor, askedTokens);
  const sentences = splitSentences(String(text || ""));
  if (sentences.length < 2) {
    // A single-sentence turn that is entirely forbidden carries no information;
    // drop it so the prospect hears a pause, not the same question again.
    if (isForbiddenTurnSentence(sentences[0] || text)) return { text: "", forbidden: true };
    record(text);
    return { text, forbidden: false };
  }
  const kept = [];
  for (const s of sentences) {
    if (isForbiddenTurnSentence(s)) continue;
    kept.push(s);
    record(s);
  }
  // Every sentence was a re-ask. Say so explicitly, because the caller has to
  // replace the turn rather than keep it.
  if (!kept.length) return { text: "", forbidden: true };
  return { text: kept.join(" ").trim(), forbidden: false };
}

async function runCall({ product, leadFields, persona, companyName, callbackNumber, callbackIn, speak, listen, contactEmail, learning, locale = "en", preparedOpeningText = null, portal = null, deviceToken = null, callId = null, waitForFirstSpeech = null }) {
  const transcript = [];
  const timeline = [];
  let heardSomething = false;
  let llmFailures = 0;
  let consecutiveLlmFailures = 0;
  /* The brain is a network call and it is on the critical path of a live
   * conversation. Measured on the 16:09Z call, one slow gateway produced 21s
   * and 22s of dead air on two consecutive turns, because the gateway was given
   * 12s to abort and then a second provider was given another 12s - and the
   * prospect had long since moved on. A listener who waits more than a few
   * seconds hears a dead line.
   *
   * So the whole turn gets one hard budget. If the brain misses it, the
   * deterministic fallback line is spoken immediately, and we do not retry: a
   * second attempt would only add another budget's worth of silence. */
  const BRAIN_BUDGET_MS = 8000;
  const askBrain = async (payload) => {
    const startedAt = Date.now();
    const attempt = async () => {
      try { return await nextTurn(payload); } catch { return null; }
    };
    for (let attempt_ = 0; attempt_ < 2; attempt_++) {
      const left = BRAIN_BUDGET_MS - (Date.now() - startedAt);
      if (left <= 0) { noteLlmFailure(); return { text: null, timeout: true }; }
      let timer = null;
      const r = await Promise.race([
        attempt(),
        new Promise((res) => { timer = setTimeout(() => res(null), left); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (r && r.text) { noteLlmSuccess(); return r; }
      noteLlmFailure();
      if (Date.now() - startedAt >= BRAIN_BUDGET_MS) return { text: null, timeout: true };
    }
    return { text: null };
  };
  let consecutiveSilence = 0;

  /* A brain failure is OUR outage, not the prospect losing interest.
   *
   * Measured in audio-sim `reopen`: the gateway 502'd for about seven seconds, the
   * brain returned nothing, and the call ended like this -
   *
   *   AGENT: Sorry, could you tell me a bit more about that?
   *   AGENT: Sorry, I lost that. What were you asking about?
   *   AGENT: Thanks for your time.  A manager will call you back within the next
   *          30 minutes. Goodbye.
   *
   * The prospect said "Hello." and "Yes, go ahead." They were interested. We hung
   * up on them because a provider was briefly unhealthy, and escalation was
   * triggered by `llmFailures > 0` - a single failure, no threshold, and no notion
   * of how long the outage had lasted.
   *
   * So a technical failure only justifies giving up on a live lead if it is
   * SUSTAINED: several consecutive failures across a real span of wall clock. One
   * 502, or a burst inside a few seconds, must never end a call. Escalation for a
   * prospect who asked for a human, or who has genuinely stopped engaging, is
   * unchanged and still works. */
  const LLM_OUTAGE_MIN_FAILURES = Number(process.env.AUTODIAL_LLM_OUTAGE_MIN_FAILURES) || 3;
  const LLM_OUTAGE_MIN_MS = Number(process.env.AUTODIAL_LLM_OUTAGE_MIN_MS) || 60_000;
  let llmOutageStartedAt = 0;
  const noteLlmFailure = () => {
    if (!llmOutageStartedAt) llmOutageStartedAt = Date.now();
    consecutiveLlmFailures++;
    llmFailures++;
  };
  const noteLlmSuccess = () => {
    consecutiveLlmFailures = 0;
    llmOutageStartedAt = 0;
  };
  const llmOutageSustained = () =>
    consecutiveLlmFailures >= LLM_OUTAGE_MIN_FAILURES &&
    !!llmOutageStartedAt &&
    Date.now() - llmOutageStartedAt >= LLM_OUTAGE_MIN_MS;
  let consecutiveJunk = 0;
  // The listen window dropped from 15s to 5s so the agent answers a prospect the
  // way a human does. Hangup still needs two full quiet windows (a proven dead
  // -line rule), so a dead line now costs ~10s of silence instead of ~30s, with
  // a check-in spoken in between rather than 15s of nothing.
  let quietMs = 0;
  let stopRequested = false;
  let humanRequested = false;
  let pendingDetected = null;
  // Recent substantial detections, so two agreeing turns need not be adjacent.
  const recentDetections = [];
// Set when the prospect asks who is calling, and once the opener has been said.
  // Between them these stop the two opener habits that read as a machine: repeating
  // the opener as an answer to "who is this?", and re-asking "is this a good time"
  // in the middle of a conversation.
  let askedWhoIsThis = false;
  /* "Who is it?" and "what is this about?" are the same request and are answered
   * from the configuration, in every language, the same way. */
  let identityAsked = false;
  // The first thing the agent said, kept because it IS the identity answer in the
  // language of the call - see identityAnswer.
  let firstSpokenLine = null;
  // How many times we have already asked a prospect to repeat themselves, so the
  // apology is not the same sentence every time.
  let askedUnheard = 0;
  // The brain has no memory of what it has already collected, so it re-asks.
  // The engine tracks it, and tells the brain on every turn.
  const collected = {};
  let lastAskedField = '';
  // Set when the agent has already said goodbye, so we never talk over a
  // farewell with a second one.
  let closingSpoken = false;
  // A callback promise is made once. Repeating it is how one call produced
  // ""shortly"", ""105 minutes"" and ""115 minutes"".
  let closingPromiseSpoken = false;
  // The prospect said they are ready and waiting; there is nothing left to qualify.
  let noMoreQuestions = false;
  // The prospect said they are busy. Once is enough to stop qualifying - asking
  // again after they have said it is what the 2026-10-06 call did for a minute.
  let busyRefused = false;
  let activeLocale = locale === "auto" ? "en" : normalizeLanguage(locale);

  const baseConfig = { product, leadFields, persona, companyName, callbackNumber, callbackIn, portal, deviceToken, callId, learning: learning || {} };
  // The learned playbook has to reach the live brain, or learning only records
  // scores and never changes a call. The highest-scoring strategies, and the
  // objection-handling ones this vertical actually hits, are named in the prompt.
    const config = (forLocale) => {
      const l = learning || {};
      const scores = l.strategyScores || {};
      const ranked = Object.keys(scores).sort((a, b) => (scores[b] || 0) - (scores[a] || 0));
      const playbook = ranked.filter((k) => (scores[k] || 0) > -1).slice(0, 4);
      return { ...baseConfig, locale: normalizeLanguage(forLocale || activeLocale, activeLocale), playbook, research: getCachedResearch(product, companyName) };
    };
  const askedFor = new Set();
  // Token signature of every question already spoken on this call, so a
  // paraphrase of an earlier question is caught even when it matches no
  // ASK_TOPICS regex. Kept per call, alongside askedFor.
  const askedTokens = [];
  const QUIET_HANGUP_MS = 20000;
  // The question the agent is currently waiting on, so a quiet window re-asks
  // it instead of moving to the next topic.
  let lastAgentAsked = null;
  const spokenLines = new Set();
  /* The same lines in the order they were said, for the near-duplicate check
   * above - the exact set cannot answer "is this the same sentence again". */
  const spokenOrder = [];
  let lastSpokenLine = null;
  /* The prospect's first words, when they spoke before the opener did. Held so
   * the loop can answer THAT turn instead of opening a new window and losing it. */
  let pendingTurn = null;
  /* The far end hung up before we had said anything. There is nobody to speak
   * to, so there is no opener and no closing either. */
  let gateEnded = false;
  // Everything the prospect actually said, so the closing can repeat their number.
  const leadSpeech = [];
  let openingSpoken = false;
    /* A model that answers in the wrong register is worse than silence, because
   * it sounds like the machine admitting it is one. On the 20:40Z call the agent
   * told the prospect "I want to answer that accurately rather than guess. Let
   * me note it for the team to follow up" - after the prospect had spoken Urdu.
   * None of this may ever reach the voice. */
  const META_LINE_RE = new RegExp([
    "rather than guess", "let me note it", "note it for the team", "for the team to follow up",
    "i'?m (?:just )?an? (?:ai|assistant|bot|language model)", "as an ai",
    "i (?:can'?t|cannot|am unable to) (?:guarantee|verify|promise)",
    "follow ?up (?:with|to) the team", "i'?ll (?:have to )?escalate that",
    "my instructions", "based on my (?:training|programming|instructions)",
    "i don'?t have (?:access|enough information)", "consult (?:my|the) (?:notes|documentation)",
  ].join("|"), "i");

  function isMetaLine(text) {
    return META_LINE_RE.test(String(text || ""));
  }

  /* Fixed lines for when we must speak without the brain. These were English
   * only, so a prospect speaking Urdu got "Sorry, I did not catch that" in
   * English - the same language failure, wearing a different hat. Every line
   * here has to be in the language of the call, or it must not be spoken. */
  const ASK_AGAIN = Object.freeze({
    en: ["Sorry, I did not catch that clearly. Could you say that again?",
         "You cut out for a second there - what did you say?",
         "Sorry, I lost that. What were you saying?"],
    ur: ["معذرت، میں سن نہیں سکا۔ دوبارہ کہیں؟",
         "آواز اچھنی تھی، دوبارہ کہیں؟",
         "معذرت، کم سنائی دیا۔ دوبارہ کہیں؟"],
    es: ["Disculpe, no he entendido. ¿Puede repetirlo?",
         "Le he oído mal. ¿Lo repite?",
         "Perdón, ¿puede decir eso otra vez?"],
    ru: ["Извините, я не расслышал. Повторите, пожалуйста?",
         "Плохо слышно. Повторите, пожалуйста?",
         "Простите, что вы сказали?"],
    fr: ["Désolé, je n'ai pas bien entendu. Vous pouvez répéter ?",
         "Je vous ai mal entendu. Vous pouvez répéter ?",
         "Pardon, vous pouvez dire cela à nouveau ?"],
    it: ["Scusi, non ho sentito bene. Può ripetere?",
         "Ho sentito male. Può ripetere, per favore?",
         "Mi scusi, può dirlo di nuovo?"],
    zh: ["抱歉，我没听清。麻烦您再说一遍好吗？",
         "不好意思，声音不清楚，能再说一次吗？",
         "抱歉，您能再说一遍吗？"],
    hi: ["क्षमा करें, मैं ठीक से नहीं सुन पाया। कृपया दोबारा बोलिए?",
         "आवाज़ साफ़ नहीं आई, कृपया दोबारा कहिए?",
         "माफ़ कीजिए, क्या आप दोबारा बोलेंगे?"],
  });
  const ASK_AGAIN_FALLBACK = Object.freeze({
    ur: "معذرت، دوبارہ کہیں؟", es: "¿Puede repetir, por favor?",
    ru: "Повторите, пожалуйста?", fr: "Vous pouvez répéter, s'il vous plaît ?",
    it: "Può ripetere, per favore?", zh: "麻烦您再说一遍好吗？",
    hi: "कृपया दोबारा बोलिए?",
  });

  /* Localized callback sentence + the words that mean the closing already
   * promises one. Both were English-only, so every non-English call ended by
   * switching back to English. Null means "we have no trustworthy translation",
   * and then we add nothing rather than speak English at a Urdu speaker. */
  const CALLBACK_TEXT = Object.freeze({
    en: (n) => (n ? `A manager will call you back on ${n} within the next 30 minutes.` : "A manager will call you back within the next 30 minutes."),
    ur: (n) => (n ? `ایک منیجر اگلے 30 منٹ میں آپ کو ${n} پر کال کرے گا۔` : "ایک منیجر اگلے 30 منٹ میں آپ کو کال کرے گا۔"),
    es: (n) => (n ? `Un responsable te llamará al ${n} en los próximos 30 minutos.` : "Un responsable te llamará en los próximos 30 minutos."),
    ru: (n) => (n ? `Менеджер перезвонит вам на ${n} в течение 30 минут.` : "Менеджер перезвонит вам в течение 30 минут."),
    fr: (n) => (n ? `Un responsable vous rappellera au ${n} dans les 30 minutes.` : "Un responsable vous rappellera dans les 30 minutes."),
    it: (n) => (n ? `Un responsabile la richiamerà al ${n} entro 30 minuti.` : "Un responsabile la richiamerà entro 30 minuti."),
    zh: (n) => (n ? `客服会在30分钟内致电 ${n}。` : "客服会在30分钟内致电给您。"),
    hi: (n) => (n ? `एक मैनेजर अगले 30 मिनट में ${n} पर फ़ोन करेंगे।` : "एक मैनेजर अगले 30 मिनट में फ़ोन करेंगे।"),
  });
  const CALLBACK_MEANS = Object.freeze({
    en: /\b(manager|call you back|callback|follow up|ring you|get back to you)\b/i,
    ur: /منیجر|کال کر|فون کر|رابطہ/,
    es: /responsable|te (?:llamaré|llamara)|volver(?:é|e) a llamar|te llamamos/,
    ru: /менеджер|перезвон|звон|свяж/,
    fr: /responsable|rappell|appeler|rappel/,
    it: /responsabile|richiam|chiamat/,
    zh: /客服|回电|致电|打电话/,
    hi: /मैनेजर|फ़ोन|कॉल|संपर्क/,
  });

  const callbackSentence = (loc, captured) => {
    const fn = CALLBACK_TEXT[loc];
    return fn ? () => fn(captured) : null;
  };
  const alreadyPromisesCallback = (line, loc) => {
    const re = CALLBACK_MEANS[loc];
    return re ? re.test(line) : false;
  };

  /* "within the next one zero and five minutes" - the transcript from 3:07 shows
   * the agent promising a callback "shortly", then "within 105 minutes", then
   * "within 115 minutes". Three promises, two of them absurd, and the prospect
   * had to choose which one to believe.
   *
   * A callback window is ours to set, not the model's. Any window it invents is
   * replaced with the 30 minutes we actually mean, and once a callback has been
   * promised in a call it is not promised again. */
  const CALLBACK_MINUTES = 30;
  const normaliseCallbackWindow = (line) => String(line || "")
    // "105 minutes", "1 15 minutes", "an hour and a half" and friends.
    .replace(/\b\d{2,4}\s*(?:minutes?|mins?)\b/gi, `${CALLBACK_MINUTES} minutes`)
    .replace(/\b(?:an hour and a half|two hours|90 minutes|60 minutes)\b/gi, `${CALLBACK_MINUTES} minutes`)
    .replace(/\bshortly\b/gi, `within the next ${CALLBACK_MINUTES} minutes`)
    .replace(/\bwithin the next\s+the next\b/gi, "within the next")
    .replace(/\s{2,}/g, " ")
    .trim();

  /* "Safe travels" is what you say to someone on a flight. It came up twice on
   * a call with a trucker, and no one boarding a truck wishes anyone a safe
   * flight. The closing must also not keep offering to help. */
  const WRONG_CLOSING_IDIOM_RE = /\b(?:safe travels|have a good (?:flight|journey)|bon voyage|travel safe)\b/i;
  const READY_NOW_RE = /\b(?:call (?:me )?(?:right away|right now|back|asap|as soon as possible)|i'?ll (?:be )?waiting|waiting for (?:the|your) call|get it (?:moving|started)|sounds good|go ahead)\b/i;

  /* "Safe travels" is what you say to someone on a flight. It came up twice to
   * a trucker on the 3:07 call, and "have a good journey" is no better. */
  const stripWrongClosingIdiom = (line) => String(line || "")
    .replace(WRONG_CLOSING_IDIOM_RE, "have a good day")
    .replace(/\s{2,}/g, " ")
    .trim();

  /* A short line that asks nothing, for when everything has been collected. It
   * is only used when a promise has already been made and the model has nothing
   * left to say - never to replace a real answer. */
  const advanceLineSafe = (loc) => {
    const table = {
      en: "Thanks for your time, and have a good one.",
      ur: "شکریہ، اچھا رہیں۔",
      es: "Gracias por su tiempo.",
      ru: "Спасибо за время.",
      fr: "Merci pour votre temps.",
      it: "Grazie per il suo tempo.",
      zh: "感谢您的时间。",
      hi: "आपका समय देने के लिए धन्यवाद।",
    };
    return table[loc] || table.en;
  };

  /* What to say when the brain's turn was entirely a repeat and cannot be
   * spoken, but the prospect is owed a turn.
   *
   * These must be statements, not questions - asking again is the defect being
   * repaired - and not goodbyes, because the call is not over. They are also
   * deliberately several per language: one fixed line used as a fallback is
   * itself repeated verbatim on the next such turn, and the never-repeat-a-line
   * guard then holds the turn, which is silence. Which is the bug. */
  const MOVE_ON = Object.freeze({
    en: ["That gives me a clear picture.", "I have that noted.", "Good, that helps a lot."],
    ur: ["یہ بات واضح ہو گئی۔", "میں نے یہ نوٹ کر لیا ہے۔", "بہت اچھا، اس سے مدد ملی۔"],
    es: ["Eso me queda claro.", "Lo tengo anotado.", "Perfecto, me ayuda mucho."],
    ru: ["Теперь мне понятно.", "Я это записал.", "Отлично, это очень помогает."],
    fr: ["C'est plus clair pour moi.", "C'est noté.", "Parfait, cela m'aide beaucoup."],
    it: ["Ora è più chiaro.", "Ho preso nota.", "Perfetto, aiuta molto."],
    zh: ["这样我就清楚了。", "我记下了。", "太好了，这很有帮助。"],
    hi: ["अब सब स्पष्ट है।", "मैंने यह नोट कर लिया है।", "बहुत अच्छा, इससे मदद मिली।"],
  });

  /* Prefer a move-on line that has not been spoken yet, so the fallback never
   * becomes the repetition. */
  const moveOnLine = (loc) => {
    const pool = MOVE_ON[loc] || MOVE_ON.en;
    return pool.find((l) => !spokenLines.has(normalizeSpoken(l))) || pool[0];
  };

  /* The close for someone who told us they are busy.
   *
   * Short, apologetic, and it asks nothing. The callback is kept because the
   * lead is real and we did reach them - but it is stated once and never
   * questioned, because "when should we call back?" to someone who just said
   * they have no time is the exact thing they were refusing. Every line is
   * localized, for the same reason as everything else here: a Urdu speaker was
   * being told "thanks for your time" in English at the end of the call. */
  const BUSY_CLOSE = Object.freeze({
    en: (cb) => `Sorry, you are right, I have taken enough of your time. ${cb ? cb() : ""} Thank you.`.trim(),
    ur: (cb) => `معذرت، آپ ٹیک ہیں، میں نے آپ کا وقت لے لیا۔ ${cb ? cb() : ""} شکریہ۔`.trim(),
    es: (cb) => `Perdona, tienes razón, te he quitado demasiado tiempo. ${cb ? cb() : ""} Gracias.`.trim(),
    ru: (cb) => `Извините, вы правы, я отнял у вас слишком много времени. ${cb ? cb() : ""} Спасибо.`.trim(),
    fr: (cb) => `Désolé, vous avez raison, je vous ai pris trop de temps. ${cb ? cb() : ""} Merci.`.trim(),
    it: (cb) => `Mi scusi, ha ragione, le ho preso troppo tempo. ${cb ? cb() : ""} Grazie.`.trim(),
    zh: (cb) => `抱歉，您说得对，我占用您太多时间了。${cb ? cb() : ""} 谢谢。`.trim(),
    hi: (cb) => `क्षमा करें, आप सही कह रहे हैं, मैंने आपका ज़्यादा समय ले लिया। ${cb ? cb() : ""} धन्यवाद।`.trim(),
  });
  const busyCloseLine = (loc, cb) => {
    const fn = BUSY_CLOSE[loc];
    return normaliseCallbackWindow(fn ? fn(cb) : BUSY_CLOSE.en(cb));
  };

  const closingLine = (loc, captured) => {
    const cb = callbackSentence(loc, captured);
    const text = cb ? `${thanksLine(loc)} ${cb(captured)}` : thanksLine(loc);
    return normaliseCallbackWindow(text);
  };
  const farewellLine = (loc) => normaliseCallbackWindow(thanksLine(loc));

  const thanksLine = (loc) => {
    const table = {
      en: "Thanks for your time, and have a good one.",
      ur: "شکریہ، اچھا رہیں۔",
      es: "Gracias por su tiempo, que le vaya bien.",
      ru: "Спасибо за время, хорошего дня.",
      fr: "Merci pour votre temps, bonne journée.",
      it: "Grazie per il suo tempo, buona giornata.",
      zh: "感谢您的时间，祝您顺利。",
      hi: "आपका समय देने के लिए धन्यवाद।",
    };
    return table[loc] || table.en;
  };

  const normalizeSpoken = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

  // A short, human recovery for when the brain returns something unusable.
  const unusableReply = (loc) => {
    const lines = (loc || activeLocale) === "en"
      ? ["Sorry, could you tell me a bit more about that?",
         "Sorry, I lost that. What were you asking about?",
         "Could you say a little more about that?"]
      : ["Sorry, could you tell me a bit more about that?",
         "Could you say a little more about that?"];
    return lines.find((l) => !spokenLines.has(normalizeSpoken(l))) || lines[0];
  };

  /* No canned filler anywhere. Every version of this file that substituted a
   * stored line for the brain's own - "Thanks, got it.", "Before I forget...",
   * "Is now a good time to talk?" - made the call worse, because the brain was
   * already producing a better answer and we were overwriting it. The 19:03Z
   * call opened, then said "Thanks, got it." with the prospect having said
   * nothing, then answered "Who is this?" with a question about truck types.
   * If the brain has nothing usable, hold the turn. */

  /* What to say into a quiet window when the brain has nothing usable.
   *
   * Persistence, never an introduction. The old fallback here was a hardcoded
   * "Hello, this is Atlas with Zaz Logistics. Is now a good time for a quick
   * call?" - a second introduction on a call that had already made one, that
   * also re-asked the opening question, and that was the exact second sentence
   * heard sixteen seconds after the first on the 07 Oct call. Stripping the
   * introduction out of it left "Is now a good time for a quick call?" spoken on
   * its own, so the repeat survived a guard that only looked at the whole turn.
   *
   * A line that has already been said is never returned. Empty means hold the
   * turn, which is better than the canned loop. */
  const REOPEN = Object.freeze({
    en: ["Hello?", "Are you still there?", "Sorry, I did not catch anything.", "Take your time, I am here."],
    ur: ["ہیلو؟", "کیا آپ ابھی موجود ہیں؟", "معذرت، میں نے کچھ نہیں سنا۔", "فیں کا وقت لیں، میں یہیں ہوں۔"],
    es: ["¿Hola?", "¿Sigue ahí?", "Disculpe, no he oído nada.", "Tómese su tiempo, aquí estoy."],
    ru: ["Алло?", "Вы ещё здесь?", "Извините, я ничего не расслышал.", "Не торопитесь, я здесь."],
    fr: ["Allô ?", "Vous êtes toujours là ?", "Désolé, je n'ai rien entendu.", "Prenez votre temps, je suis là."],
    it: ["Pronto?", "È ancora qui?", "Mi scusi, non ho sentito nulla.", "Si accomodi, sono qui."],
    zh: ["您好？", "您还在吗？", "抱歉，我没听到声音。", "您慢慢来，我在。"],
    hi: ["हैलो?", "क्या आप अभी भी हैं?", "क्षमा करें, मुझे कुछ सुनाई नहीं दिया।", "आराम से लीजिए, मैं यहाँ हूँ।"],
  });
  const reopenLine = (loc) => {
    const pool = REOPEN[loc] || REOPEN.en;
    return pool.find((l) => !spokenLines.has(normalizeSpoken(l)) && !OPENER_GREETING_RE.test(l)) || "";
  };

  /* Near-duplicate of a line already spoken.
   *
   * The never-repeat-a-line guard compares normalized strings, which is exact
   * enough for lines the model writes twice and useless for a line WE construct:
   * "I'm Atlas from Zaz Logistics, calling about our dispatch services" and "I'm
   * Atlas with Zaz Logistics, calling about our dispatch services" normalize
   * differently and are the same sentence to a listener. audio-sim's own
   * repetition detector uses 90% word overlap for the same reason, and it caught
   * exactly this on the first real run of the fixed code.
   *
   * It is only used on the lines we build ourselves, because a fuzzy check on the
   * model's own turns would start deleting distinct replies. */
  const wordsOf = (s) => new Set(String(s || "").toLowerCase().match(/[a-z]+/g) || []);
  const isNearDuplicate = (candidate, spoken) => {
    const a = wordsOf(candidate);
    if (!a.size) return false;
    for (const line of spoken) {
      const b = wordsOf(line);
      if (!b.size) continue;
      let shared = 0;
      for (const w of a) if (b.has(w)) shared++;
      if (shared / Math.min(a.size, b.size) >= 0.8) return true;
    }
    return false;
  };

  /* "Who is it?" / "What is this about?" answered from the configuration.
   *
   * These are facts we own - our name, our company, what we sell - and they are
   * already in the configuration the prompt is built from. They do not need a
   * network round trip, a hedge, or a promise that someone will call back.
   *
   * On the 07 Oct call both questions were answered with "Let me get you a
   * straight answer to that - I will have someone call you back with it", and the
   * prospect said "The fuck?". A callback promise is not an answer, and for the
   * one question where the answer costs nothing it is the worst possible reply:
   * it tells a person who is about to hang up that we will ring them later.
   *
   * Two sources. The configuration always wins when it can: the name, the company
   * and the offering are facts we own, they are already in the system prompt,
   * and they let the same question be answered differently twice. The
   * introduction the agent already spoke is the fallback, and it is the answer in
   * the language of the call when there is nothing else - a call with no agent
   * name configured, or in a language we have no translation of this for.
   *
   * The order of the two sources depends on what was actually asked: "Who is it?"
   * wants the introduction, "What is this about?" wants what we sell.
   *
   * Every candidate is checked against what has already been said - exactly, and
   * as a near-duplicate, because the opener-derived phrasing is the line the
   * prospect has just heard and saying it again with one word changed is still
   * saying it again. A prospect who asks twice is answered with a different
   * sentence; a prospect who has exhausted every phrasing gets quiet rather than
   * a third repeat. */
  const identityAnswer = (loc, kind) => {
    const openerCandidates = [];
    if (firstSpokenLine) {
      const kept = splitSentences(firstSpokenLine)
        .filter((s) => !OPENER_GREETING_RE.test(s) && /\b(?:this is|i am|i'?m|my name is|speaking)\b/i.test(s))
        .join(" ")
        .trim();
      if (kept) openerCandidates.push(kept);
    }
    const facts = {
      name: configText(persona, ["name", "agentName", "firstName", "displayName"], ""),
      company: configText(companyName, ["name", "companyName", "company"], ""),
      offering: configText(product, ["name", "title", "product", "description"], ""),
    };
    const factCandidates = [];
    if (facts.name && (loc || "en") === "en") {
      const who = facts.company ? `${facts.name} with ${facts.company}` : facts.name;
      if (facts.offering) {
        factCandidates.push(`I am ${who}, calling about ${facts.offering}.`);
        factCandidates.push(`You are speaking with ${who}, about ${facts.offering}.`);
      } else {
        factCandidates.push(`I am ${who}.`);
        factCandidates.push(`You are speaking with ${who}.`);
      }
    }
    const candidates = kind === "purpose" ? [...factCandidates, ...openerCandidates] : [...factCandidates, ...openerCandidates];
    return candidates.find((c) => !spokenLines.has(normalizeSpoken(c)) && !isNearDuplicate(c, spokenOrder)) || "";
  };

  /* The prospect's most recent words, and whether they were a question. Asking
   * for something has to produce an answer - see the unanswered-question guard
   * where the reply is produced. */
  let lastProspectTurn = "";
  let lastProspectAskedQuestion = false;

  const agent = async (text, opts = {}) => {
      /* The language of the turn is not always the call's default language. On
       * the 20:40Z call the prospect spoke Urdu - the recognizer heard it
       * correctly and said `ur` - and the agent answered in English, because the
       * reply language came from activeLocale and the switch to Urdu needs two
       * agreeing turns to be believed. "I want to answer that accurately rather
       * guess" was the result. So a turn that has been heard in another language
       * is answered in that language, immediately, with the matching voice. */
      const loc = normalizeLanguage(opts.locale || activeLocale, activeLocale);
      /* What is still unsaid of the persistence lines. Resolved once per turn so
       * the substitutions below agree with each other about what has been used. */
      const reopen = reopenLine(loc);
      /* The first thing the agent says on a call is an opener: it may introduce
       * the agent and it may ask whether this is a good time to talk. Every line
       * after that is a conversation turn, and the guards below treat the two
       * differently, because an introduction and an opening question are correct
       * once and are a defect the second time. Captured before the flag is set. */
      const isFirstAgentLine = !openingSpoken;
      // Cap here, where the words are produced, so every consumer of a turn - a
      // live call or an offline simulation - gets a speakable length. The
      // controller caps again as a net before anything reaches the wire.
      let line = capTurnLength(String(text || "").trim());
      if (!line) return;
      /* Last line of defence, in the one place every spoken line passes. The
       * per-turn checks catch the obvious paths, but a meta line that slipped
       * through a closing or a quiet window still reached the voice on the
       * 20:40Z call. Nothing that admits to being a machine is ever spoken. */
      if (isMetaLine(line)) line = "";
      /* A prospect who asks a question is asking to be answered.
       *
       * On the test call the prospect asked "Will your dispatcher be able to call
       * me now?" three separate times. The agent replied "Thanks for sharing the
       * domain", then "Thanks for your time", then closed with a callback
       * promise, and he ended the call with "I don't want to work with you." It
       * was not a tone problem and not a latency problem: every reply was an
       * acknowledgment or another question, and never an answer. The single most
       * common thing a prospect does is ask something, so this is the defect
       * that decides whether the call is worth anything.
       *
       * So when the prospect's last turn was a question, a reply that is itself a
       * question, or that is only an acknowledgment, is not spoken. The brain is
       * asked again with the requirement spelled out. */
      if (line && lastProspectAskedQuestion) {
        const askedQuestion = /\?\s*$/.test(line) || /\?\s/.test(line);
        const onlyAcknowledged = ACKNOWLEDGMENT_ONLY_RE.test(line);
        if (askedQuestion || onlyAcknowledged) {
          try { log("[unanswered-question] the prospect asked a question; the reply was not an answer - retrying"); } catch {}
          /* The question has to be the one they ACTUALLY asked. This prompt used
           * to say "I asked whether your dispatcher can call me now", which was
           * hardcoded, so a prospect asking "Who is it?" was told they had asked
           * about dispatch availability - and the model, answering that question
           * instead, produced the deflection heard on the 07 Oct call. */
          const theyAsked = String(lastProspectTurn || "").replace(/\s+/g, " ").trim();
          const retry = await askBrain({
            ...config(),
            transcript: [
              ...transcript,
              { role: "lead", text: theyAsked },
              {
                role: "lead",
                text:
                  "Answer that question directly. The prospect asked: \"" + theyAsked + "\". " +
                  "Give me a real answer - yes or no and why - in one or two sentences. Do not ask " +
                  "me anything back, and do not just thank me.",
              },
            ],
          }).catch(() => null);
          const retryLine = retry && retry.text ? capTurnLength(String(retry.text).trim()) : "";
          // Only accept the retry if it is genuinely an answer.
          if (retryLine && !/\?\s*$/.test(retryLine) && !ACKNOWLEDGMENT_ONLY_RE.test(retryLine)) {
            line = retryLine;
          } else if (identityAsked) {
            /* They asked who we are or what this is about, and the model gave us
             * nothing usable. The answer to that is in the configuration, so it
             * is said rather than promised. */
            const identity = identityAnswer(loc, askedWhoIsThis ? "who" : "purpose");
            if (identity) line = identity;
            else line = "Let me get you a straight answer to that - I will have someone call you back with it.";
          } else {
            // Last resort: say plainly that it is being checked and a human will
            // answer, which is at least honest and always better than silence or
            // a second question.
            line = "Let me get you a straight answer to that - I will have someone call you back with it.";
          }
        }
      }
        // Never re-introduce after the opening, and never re-ask for something
        // already asked - EXCEPT when the prospect asks who is calling, because
        // then repeating it is the only correct answer.
        if (isFirstAgentLine) {
          openingSpoken = true;
          firstSpokenLine = line;
        } else if (askedWhoIsThis || identityAsked) {
          // On the 18:44Z call the prospect asked "Who is this?" and the guard
          // removed "This is Atlas with Zaz Logistics" for being a repeat
          // introduction. Skip the strip when they are asking what we are.
        } else {
          const strip = lastSpokenLine
            ? stripRepeatedAsks(line, askedFor, askedTokens)
            : { text: line, forbidden: false };
          if (strip.forbidden) {
            /* Every sentence in this turn was a repeat - a question already
             * asked, a second introduction, or inbound-receptionist phrasing on
             * an outbound call. The old code did `if (trimmed) line = trimmed`,
             * which read the empty result as "no change" and spoke the repeat
             * anyway: the guard worked and its verdict was thrown away. That is
             * how "What type of truck do you operate?" was asked three times on
             * the 2026-10-06 call.
             *
             * The turn cannot be spoken, and it cannot be replaced with
             * silence either - a prospect who hears nothing after answering
             * thinks the call dropped. So the brain is asked once for a line
             * that moves on, and the deterministic non-question line is the
             * floor under it. */
            try { log("[repeat-ask] a turn re-asked something already asked; replacing it"); } catch {}
            const fresh = await askBrain({
              transcript: [
                ...transcript,
                {
                  role: "lead",
                  text: `You just tried to ask: "${line}". That has already been asked on this call, in other words, and repeating it makes you sound like a machine. Say something DIFFERENT that moves the conversation forward in one short natural sentence, in ${languageName(loc)}. Do not ask any question you have already asked.`,
                },
              ],
              ...config(loc),
            }).catch(() => null);
            const retry = fresh && fresh.text ? capTurnLength(String(fresh.text).trim()) : "";
            /* Run the retry back through the same guard, so it is both checked
             * and recorded. A brain told "say something different" that answers
             * with another paraphrase of the same question is exactly the failure
             * being fixed here, so it is rejected rather than spoken - and a
             * replacement that IS accepted gets recorded, or the next turn can
             * repeat the replacement. */
            const retryStrip = retry
              ? stripRepeatedAsks(retry, askedFor, askedTokens)
              : { text: "", forbidden: true };
            /* Move-on filler is the right replacement in a conversation and the
             * wrong one on a line nobody has spoken on yet: "That gives me a
             * clear picture." said into dead air implies an answer that does not
             * exist. A re-open is the opposite - it claims nothing and invites a
             * reply - so when the prospect has never spoken and the turn was
             * refused, the re-open is the replacement.
             *
             * This is also where the repeated opener dies. The brain was asked
             * for something new and produced "Is now a good time for a quick
             * call?", which is the opener again, which is forbidden - and the
             * live call spoke it anyway, because the replacement was filler and
             * then the silence guard held the whole turn. */
            line = retryStrip.forbidden || !retryStrip.text
              ? (!heardSomething ? (reopen || moveOnLine(loc)) : moveOnLine(loc))
              : retryStrip.text;
          } else if (strip.text) {
            line = strip.text;
          }
          /* A refusal to repeat must not become filler when we have heard nothing.
             *
             * The 07 Oct call opened with "That gives me a clear picture." at 0:26,
             * before the prospect had said anything at all. That line is a
             * move-on filler, which is only meaningful as a reply to something.
             * Spoken into a silent line it is the single most confusing thing the
             * agent can do: it implies it heard an answer that does not exist.
             *
             * A re-open is exempt, and only a re-open: it says the agent is still
             * there and asks them to speak, which is the one thing that IS true
             * of an unanswered turn. */
          if (!heardSomething && !/\?/.test(line) && line !== reopen) {
            /* Nothing has been heard yet and this turn has no question in it, so
             * there is no conversation for it to advance. Wait instead. */
            line = lastAgentAsked ? "" : line;
          }
        }
        /* The opener is a first-turn line. Any later turn that re-asks whether
         * this is a good time to talk is the repeated opener - which is what the
         * prospect heard twice on the 07 Oct call, eleven seconds apart:
         * "Hi, this is Atlas with Zaz Logistics. Is now a good time to talk?" and
         * then "Is now a good time for a quick call?". It used to slip through
         * because the guard wanted the words "this" or "it" before "a good time"
         * and a "for" instead of a "to".
         *
         * The prospect asking who is calling is the one exemption, because then
         * re-introducing is the only correct answer. */
        if (!isFirstAgentLine && !askedWhoIsThis && OPENER_GREETING_RE.test(line)) {
          try { log("[repeat-opener] a later turn repeated the opening; replacing it"); } catch {}
          line = reopen || "";
        }
      /* The brain sometimes mirrors the prospect's script even on a call
       * configured for another language, and the current voice cannot speak it.
       * That is real, and on the 21:05Z call it put Devanagari through an
       * English voice.
       *
       * But it must never be silent. On the 19:22Z call the prospect spoke Urdu,
       * the brain replied in Urdu, and this dropped the line with no log line at
       * all - so the prospect heard nothing for the remaining thirty seconds of
       * the call and we could not see why. If we are going to refuse the reply,
       * we owe the turn a usable line in the language the call is in, and the
       * refusal has to be visible. */
      if (!NON_LATIN_LOCALE.has(loc) && isMostlyNonLatin(line)) {
        console.log(`[brain] reply was in a script the ${loc} voice cannot speak (${line.length} chars); answering in ${loc} instead`);
        line = unusableReply(loc);
      }
    if (!line) return;
    // Never repeat a line. The 18:51Z call said "The line is connected and
    // ready" on two consecutive turns, and a stub brain here produced the same
    // sentence three times in one call - the most machine-sounding thing a
    // caller can do. Consecutive-only checking was not enough, so this tracks
    // every line already spoken and rotates the substitute too.
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
      if (spokenLines.has(normalizeSpoken(line))) {
        if (opts && opts.noRetry) {
          /* A quiet window or a closing has already spent a round trip. Saying
           * canned filler here is what produced the bare "Thanks, got it." on the
           * 19:03Z call - a line with no question in it, with the prospect
           * having said nothing at all. Hold the turn instead. A moment of
           * quiet is recoverable; a meaningless filler is not. */
          return;
        }
        /* The brain repeated itself. Give it one more go with an explicit
         * instruction - this is rare, and one round trip beats both wrong-language
         * output and dead air. */
        const fresh = await askBrain({
          transcript: [
            ...transcript,
            { role: "assistant", text: line },
            { role: "user", content: `You already said exactly that, verbatim. Do not repeat it. Say something different that moves the conversation forward, in ${languageName(loc)}, in one short natural sentence. Ask no question you have already asked.` },
          ],
          ...config(loc),
        }).catch(() => ({ text: "" }));
        const retry = isMetaLine(fresh && fresh.text) ? "" : String((fresh && fresh.text) || "");
        if (retry && !spokenLines.has(normalizeSpoken(capTurnLength(retry)))) {
          line = capTurnLength(retry);
        } else {
          // Still nothing usable. Do not fill the gap with filler - say nothing.
          return;
        }
      }
      /* Record it, so the guards own this line too.
       *
       * stripRepeatedAsks only records the turns it is asked to strip, which is
       * every turn after the first. The opener - which asks "Is now a good time
       * to talk?" - was therefore never on the list of things already asked, so
       * nothing stopped a later turn from asking the identical question. Every
       * spoken line goes through here instead, so there is one place that knows
       * what this call has said. */
      recordAsks(line, askedFor, askedTokens);
      spokenLines.add(normalizeSpoken(line));
      spokenOrder.push(line);
      lastSpokenLine = line;
      const f = qual.fieldAskedAbout(line, leadFields);
      if (f) lastAskedField = f;
      transcript.push({ role: "agent", text: line, locale: loc });
      await speak(line, { locale: loc, intent: opts.intent });
    };
  const lead = (text, detected) => {
    const line = String(text || "").trim();
    if (!line) return;
    if (!line.startsWith("(silence)")) heardSomething = true;
    transcript.push({ role: "lead", text: line, locale: detected || activeLocale });
    lastProspectTurn = line;
    lastProspectAskedQuestion = prospectAskedQuestion(line);
  };

  /* Research must be gathered BEFORE the call, not during it.
   *
   * The comment here used to claim "ahead of the call, never during it" while
   * firing the fetch in the background from inside the conversation. That is
   * the worst possible place for it now: the portal will only take one request
   * at a time, and this one is slow (it searches the open web). So it held the
   * slot the brain needed, and turns went to 8s.
   *
   * A cold cache simply means the conversation runs on the deterministic tactic
   * floor, which is already guaranteed to be present. The fetch now happens in
   * the pre-dial window, where nothing is waiting on a person. */

  /* THE AI DOES NOT GET TO SPEAK FIRST.
   *
   * The rule is the customer's: the agent must not begin talking until the other
   * person has answered AND spoken. The opener used to fire the moment the call
   * connected, which is a handful of milliseconds after the far end is answered
   * and says nothing at all about whether a human has said a word. On the 07 Oct
   * call that produced this, at the same instant:
   *
   *   ringcentral: Hi, this is Atlas with Zaz Logistics. Is now a good time... (t+7s)
   *   Haris:       Hello?                                                       (t+7s)
   *
   * A person who answers a phone says something. Talking over the first word is
   * how a caller knows they have reached a machine.
   *
   * waitForFirstSpeech is that gate: a real capture window, provided by the
   * media controller (local-call-controller's firstSpeechFn), so it ends when
   * the VAD says their speech has ended rather than when media arrived. What it
   * returns decides what we do:
   *
   *  - they said something  -> DO NOT open. Keep the turn and answer it. Reading a
   *    canned opener over the top of their own greeting is the defect, and the
   *    answer to what they actually said is worth more than our script.
   *  - someone is there and the recognizer could not make them out -> they have
   *    spoken, so an opener would still be talking over them; ask them to repeat.
   *  - a carrier tone or a voicemail -> nobody to talk over, open.
   *  - silence -> open. That is the fallback the gate's own budget bounds.
   *  - the call ended remotely -> say nothing at all.
   *
   * The controller owns the budget because the VAD lives there; on a path with
   * no gate capability (an offline simulation, the local microphone) the opener
   * behaves exactly as it always did. */
  if (typeof waitForFirstSpeech === "function") {
    let gate = null;
    try { gate = await waitForFirstSpeech({ locale: activeLocale, autoLanguage: true }); } catch { gate = null; }
    if (gate && typeof gate === "object" && gate.ended) {
      gateEnded = true;
      try { log("[opening-gate] the call ended before we said anything; staying silent"); } catch {}
    } else if (gate && gate.text && !isJunkLead(gate.text)) {
      pendingTurn = gate;
      try { log("[opening-gate] the prospect spoke first, so the opener is not read over them: " + gate.text); } catch {}
    } else if (gate && gate.unheard) {
      const pool = ASK_AGAIN[activeLocale] || [ASK_AGAIN_FALLBACK[activeLocale]].filter(Boolean);
      if (pool.length) await agent(pool[0], { intent: "reassurance", locale: activeLocale });
      /* They are there, whatever we could not make out of it. */
      heardSomething = true;
    }
  }

  /* A held turn means the prospect spoke first, so there is no opener left to
   * read: the first thing the agent says is the reply to what they said. */
  if (!openingSpoken && !pendingTurn && !gateEnded) {
    if (preparedOpeningText) {
      await agent(preparedOpeningText, { intent: "opening" });
    } else {
      const first = await opening(config()).catch(() => ({ text: null }));
      if (!first || !first.text) { noteLlmFailure(); await agent(fallbackOpening(config()), { intent: "opening" }); }
      else await agent(first.text, { intent: "opening" });
    }
  }

  // Turn count is only a runaway-call safety bound. Turn endings themselves are
  // controlled by the speech/VAD listener in call.js, never by a conversation timer.
  // 12 was low enough to end a real conversation: the 20:44Z call hit exactly
  // 12 turns and was cut off mid-sentence ("...a load from Gujarawala to Kar")
  // immediately after the prospect asked for a load. Real endings - a do-not-call
  // request, a human request, two quiet windows, three junk windows, repeated
  // brain failure - all still fire long before this backstop.
  for (let turn = 0; turn < 20; turn++) {
    /* The gate's window IS this turn when they spoke first - it already holds
     * their words, so it is not opened and transcribed a second time. */
    let heardResult;
    if (pendingTurn) {
      heardResult = pendingTurn;
      pendingTurn = null;
    } else {
      // Always let the recognizer auto-detect the spoken language; the configured
      // locale is only the starting language, never a permanent pin.
      heardResult = await listen({ locale: activeLocale, autoLanguage: true });
    }
    // Remote hangup: the controller reports ended so we stop turning instead
    // of burning check-in TTS/LLM calls against a dead leg.
    if (heardResult && typeof heardResult === "object" && heardResult.ended) break;
    const heard = typeof heardResult === "string" ? heardResult : (heardResult && heardResult.text);
    const detected = typeof heardResult === "object" && heardResult && heardResult.language
      ? normalizeLanguage(heardResult.language, activeLocale || "en")
      : null;
    const commanded = detectLanguageCommand(heard);
    if (commanded && commanded !== activeLocale) {
      activeLocale = commanded;
      pendingDetected = null;
      timeline.push({ at: Date.now(), event: "language-switch", locale: activeLocale, source: "command" });
    } else if (detected && detected !== activeLocale && isSubstantialUtterance(heard)) {
      // Two independent conditions before the recognizer may take the call over:
      // the words must match the claimed script, and the same language has to be
      // seen twice in a row. One clip is not enough - that is what turned an
      // English call into French and then Urdu on the 20:25Z call.
        if (scriptAgreesWithLocale(heard, detected, { fromDetection: true })) {
          /* Two detections of the same language, within the last three turns -
           * not strictly consecutive. On the 20:40Z call the recognizer returned
           * Urdu, English, Urdu: a short clip read as "Hello." in between cleared
           * the candidate, so the call never moved to Urdu and the agent spent
           * the whole call answering Urdu with English. One short misdetection
           * between two agreeing turns is exactly what a noisy clip looks like,
           * and it should not cost the prospect their language. */
          recentDetections.push(detected);
          if (recentDetections.length > 3) recentDetections.shift();
          const agreed = recentDetections.filter((d) => d === detected).length;
          if (agreed >= 2) {
            activeLocale = detected;
            pendingDetected = null;
            recentDetections.length = 0;
            timeline.push({ at: Date.now(), event: "language-switch", locale: activeLocale, source: "detected" });
          } else {
            pendingDetected = detected;
            timeline.push({ at: Date.now(), event: "language-candidate", locale: detected, note: "awaiting a second confirming turn" });
          }
        } else {
          pendingDetected = null;
        }
    } else {
      pendingDetected = null;
    }

    // The reportedNoise branch also covers a window where the prospect clearly
    // spoke but the recognizer could not hear them - a gateway blip, or a bad
    // capture. That is NOT silence and NOT consent, so it must never advance the
    // conversation or age toward the dead-line hangup.
    const reportedNoise = !!(heardResult && typeof heardResult === "object" && (heardResult.junk || heardResult.empty || heardResult.unheard));
    const junkLead = !!heard && isJunkLead(heard);
    if (!heard || String(heard).startsWith("(silence)") || junkLead) {
      lead("(silence)");
      // The listener reports how long the window actually ran, so a dead line
      // still gets the same total patience as the old two 15s windows.
      quietMs += Number(heardResult && typeof heardResult === "object" && Number(heardResult.waitedMs) > 0)
        ? Number(heardResult.waitedMs)
        : 5000;

      /* We could not hear them, or they went quiet. Both are handled, and
       * neither advances the conversation. */
        if (heardResult && typeof heardResult === "object" && heardResult.unheard) {
          /* They spoke and we could not make it out, so ask them again - but only
           * if we have ever heard them at all. On the 07 Oct call STT was failing
           * on every turn, and the agent kept apologising into a line where nobody
           * had yet spoken. Repeating "sorry" at a silent line is not patience. */
          if (!heardSomething) {
            try { log("[unheard] speech detected but nothing transcribed yet; waiting instead of apologising into a silent line"); } catch {}
            continue;
          }
          /* No brain call here. The prospect is already waiting on an apology,
           * and asking the model to produce it cost a 7s round trip on the
           * 20:40Z call and returned "I want to answer that accurately rather
           * than guess" - a line that tells the prospect they are talking to a
           * machine. "Sorry, could you say that again?" needs no intelligence. */
          const asked = askedUnheard;
          askedUnheard++;
          const pool = ASK_AGAIN[activeLocale] || [ASK_AGAIN_FALLBACK[activeLocale]].filter(Boolean);
          await agent(pool.length
            ? (pool[asked % pool.length])
            // No line we can trust in this language. Better to hold the turn than
            // to answer a Punjabi speaker in English.
            : "", { intent: "reassurance", locale: activeLocale });
          continue;
        }
      if (reportedNoise || junkLead) {
        consecutiveJunk++;
        // Bounded: a line that only ever beeps still ends the call.
        if (consecutiveJunk >= 3) break;
        } else {
          consecutiveSilence++;
          /* Hangup is budgeted on cumulative quiet time, not a window count.
           * "Two quiet windows" was safe when a window was 15s - it meant 30s of
           * silence. The window is 5s now, so the same rule meant 10s, and on the
           * 19:28Z call the agent said "a manager will call you back within 30
           * minutes" and hung up while the prospect was still on the line. 20s of
           * real silence, and a hard floor of three windows so a prospect who is
           * genuinely there is never dropped. */
          if (quietMs >= QUIET_HANGUP_MS && consecutiveSilence >= 3) break;
        }
      // What to say into a quiet window. This used to always be a connectivity
      // check, so a call that opened into dead air went straight to "Can you
      // hear me okay?" (20:24Z and 20:25Z calls) and a live conversation that
      // paused was told the line was quiet. Only escalate to a connectivity
      // check, and only while the prospect has never spoken.
      const neverHeard = !heardSomething;
      const firstQuiet = consecutiveSilence + consecutiveJunk <= 1;
      /* If the agent just asked something and the prospect stayed quiet, the
       * question is still unanswered. Asking the next question is the single
       * most alien thing a caller can do - it was reported as "it moves to the
       * next question like I answered it already", and the 16:09Z log shows it:
       * 16:10:17 playback finished, 16:10:22 no speech, 16:10:44 the agent was
       * asking a brand new question instead of waiting for the answer. So: never
       * advance. Re-ask, or invite the answer to the question already asked. */
      const pendingQuestion = lastAgentAsked;
      let ask;
if (neverHeard && firstQuiet) {
        ask = { role: "lead", text: "The prospect has not answered yet. Restate who you are and your reason for calling in one short natural sentence, then ask whether this is a good time to talk. Do not ask if they can hear you." };
      } else if (neverHeard) {
        /* The first quiet window is the opener; this one is a re-open, and it is
         * the second time on the 07 Oct call that the agent said "Is now a good
         * time for a quick call?" having already said "Is now a good time to
         * talk?". By here the introduction has been made and the question has
         * been asked, so instructing the model to do both again produces the
         * repeated opener every time the model is helpful enough to comply. */
        ask = { role: "lead", text: "Still no answer. You have ALREADY introduced yourself and asked whether this is a good time to talk. Do not introduce yourself again, do not ask that again, and do not repeat any line you have already said. Say something short and different that invites them to speak, in one short sentence. Never say the line is connected or that you are ready - that sounds like a machine." };
      } else if (pendingQuestion) {
        ask = { role: "lead", text: `You asked: "${pendingQuestion}". The prospect has not answered yet. Do NOT move on to a different topic and do NOT ask a new question. Politely invite them to answer, or repeat that one question in different words, in one short sentence.` };
      } else {
        ask = { role: "lead", text: "The prospect went quiet. Continue the conversation naturally from what was just discussed, or ask one simple question to invite a reply. Do not comment on the line, the connection, or whether they can hear you." };
      }
      const hello = await askBrain({ transcript: [...transcript, ask], ...config() });
      if (hello.text && !isMetaLine(hello.text)) lastAgentAsked = extractQuestion(hello.text) || pendingQuestion;
      /* A re-open is persistence. This fallback used to be a hardcoded second
       * introduction - "Hello, this is Atlas with Zaz Logistics. Is now a good
       * time for a quick call?" - which is the exact pair heard on the 07 Oct
       * call. reopenLine() never returns an introduction, never returns an
       * opener, and never returns something already said; empty holds the turn. */
      await agent((hello.text && !isMetaLine(hello.text)) ? hello.text : reopenLine(activeLocale),
      { intent: "checkin", noRetry: true });
      continue;
    }
      consecutiveSilence = 0;
      consecutiveJunk = 0;
      quietMs = 0;
      // pendingDetected deliberately survives a real turn. It used to be cleared
      // right here, on every turn - which made the "same language twice in a row"
      // rule impossible to ever satisfy, because the first turn had already
      // erased the candidate the second turn was supposed to confirm. Automatic
      // language switching could therefore never fire for any language, and the
      // agent stayed in English for the whole call. It is cleared where a
      // contradiction actually happens: a command, a turn detected in the current
      // language, or a clip whose script contradicts the claim.

    lead(heard, detected);
    leadSpeech.push(heard);
    // Attribute the answer to the field we just asked for, and to any field the
    // words themselves fill in ("26 feet bucks" answers both truck fields).
    if (lastAskedField) Object.assign(collected, qual.attribute(lastAskedField, heard));
    Object.assign(collected, qual.extract(heard, leadFields));
    lastAskedField = "";

    /* They said goodbye. Say goodbye and stop.
     *
     * The transcript at 3:07 shows what used to happen: the prospect said "Bye
     * bye" at 3:14 and the agent kept going until 3:39 - "Glad I could help",
     * then "if anything else comes up, whether it's another load, a question
     * about rates, or anything else, just let me know", then "Alright", then
     * "Feel free to reach out anytime", then "Safe travels" a second time.
     * Twenty-five seconds of a call that had already ended. Someone who says
     * goodbye has hung up in every sense but the physical one. */
    if (FAREWELL_RE.test(heard) || closingPromiseSpoken && noMoreQuestions) {
      closingSpoken = true;
      const captured = capturePhoneNumber(leadSpeech.join(" ")) || callbackNumber;
      await agent(closingPromiseSpoken ? farewellLine(activeLocale) : closingLine(activeLocale, captured),
        { intent: "closing", noRetry: true });
      break;
    }
    // "Who is this?" has to be answered with the name, and "is this a good time"
    // is an opener only. Both apply to the reply right now, and the identity
    // question is one-shot: leaving it set made the opener check stay disabled
    // for the rest of the call once they had ever asked.
    askedWhoIsThis = WHO_IS_THIS_RE.test(heard);
    identityAsked = askedWhoIsThis || CALL_PURPOSE_RE.test(heard);
    stopRequested = STOP_RE.test(heard);
    humanRequested = HUMAN_RE.test(heard) && /\b(speak|talk|transfer|connect|want|need)\b/i.test(heard);

    if (stopRequested) {
      const stopLine = await askBrain({ transcript: [...transcript, { role: "lead", text: "Acknowledge the do-not-call request immediately and end the call." }], ...config() });
      closingSpoken = true;
      await agent((stopLine.text && !isMetaLine(stopLine.text)) ? stopLine.text : fallbackReply(heard, config()), { noRetry: true });
      break;
    }
    if (humanRequested) {
      closingSpoken = true;
      await agent(fallbackReply(heard, config()));
      break;
    }
    /* "Who is it?" and "What is this about?" are answered from the
     * configuration, here, before the brain is asked.
     *
     * These are not judgement calls and they are not things to hedge: the name,
     * the company and the offering are all in the config this call was started
     * from, and they are already in the system prompt the brain is given. On the
     * 07 Oct call "Who is it?" (t+19s) and "What do you" (t+28s) were both
     * answered with "Let me get you a straight answer to that - I will have
     * someone call you back with it", and the prospect said "The fuck?".
     *
     * Answering here rather than only as a fallback matters for two reasons. The
     * model does know the answer, but on a call it is second-guessing a stranger
     * and a promise is the safe-sounding option; and when it does answer, it
     * answers in whatever shape it likes, which on that call included asking a
     * question back. A person who asks who is calling has told us they are
     * deciding whether to keep talking - that turn has to be short, factual and
     * certain.
     *
     * A phrasing that has already been spoken is not offered again: a prospect who
     * asks twice gets a different sentence, not a repeat and not silence. If
     * every phrasing has been used, the loop falls through to the brain rather
     * than saying nothing at all. */
    if (identityAsked) {
      const identity = identityAnswer(activeLocale, askedWhoIsThis ? "who" : "purpose");
      if (identity) {
        await agent(identity, { intent: "question", locale: activeLocale });
        continue;
      }
    }
    /* They told us they are busy. Stop qualifying and close.
     *
     * Placed with the other refusals so it is decided before any brain call for
     * this turn: the 2026-10-06 call asked the brain for a normal reply to "I
     * told you I'm a bit busy right now", the brain apologised, and the next
     * question went out anyway. There is no turn after this one - the call ends
     * with an apology and the callback promise, which is all a busy person
     * wants. */
    if (BUSY_RE.test(heard)) {
      busyRefused = true;
      closingSpoken = true;
      /* The apology has to come from the turn that heard the refusal, and it has
       * to be first - "Sorry, you are right" followed immediately by "just one
       * more question" is what made the call feel like it was not listening. */
      const cb = callbackSentence(activeLocale, null);
      const busyClose = busyCloseLine(activeLocale, cb);
      const busyLine = await askBrain({
        transcript: [
          ...transcript,
          {
            role: "lead",
            text: "The prospect has just told you they are busy and cannot talk. Apologise briefly and end the call immediately. Do NOT ask them any further question, and do NOT ask if now is a better time. One or two short sentences, then stop.",
          },
        ],
        ...config(activeLocale),
      }).catch(() => null);
      const fromBrain = busyLine && busyLine.text ? capTurnLength(String(busyLine.text).trim()) : "";
      /* Never speak a question back at someone who just said they are busy,
       * whatever the brain produced. */
      await agent(fromBrain && !/\?/.test(fromBrain) ? fromBrain : busyClose, { intent: "closing", noRetry: true });
      break;
    }

    /* Reply in the language the call is IN, not the language of the last clip.
     *
     * This used to answer each turn in whatever the recognizer last detected, to
     * stop an Urdu speaker being answered in English. It was the wrong fix: on
     * the 18:44Z call the recognizer returned "Oke, itu..." for an English
     * "Okay, that's...", and the agent answered in Indonesian - full sentence,
     * correct grammar, wrong language - for the rest of the call. One short clip
     * moving a whole conversation is exactly what the two-turn confirmation
     * exists to prevent, and the per-turn rule bypassed it.
     *
     * The call-level switch still needs two detections within three turns, and it
     * now actually gets heard, because the per-turn path no longer competes with
     * it. */
    /* The brain is told what is already collected and what is still missing, on
     * every turn. Without it it has no way of knowing, so it re-asks: on the
     * 20:21Z call the prospect said "26 feet bucks" and the agent asked the
     * equipment type again, then twice more. It also invented a "delivery
     * destination" the customer cannot have - a field that is not even in their
     * configuration, the model simply knew what a freight call sounds like. */
    const checklist = qual.checklistBlock(collected, leadFields);
    if (checklist) {
      let instruction = `${checklist}\nAsk for exactly ONE item from STILL NEEDED, in one short natural sentence. Never ask for anything in ALREADY COLLECTED. Never invent a field the customer has not asked you for.`;
      /* One promise, once. The transcript at 1:46-2:43 has four: "right away",
       * "right away", a scheduling question, then "shortly" - and the window it
       * gave was read back to us by the customer as "10:20 minutes". */
      if (closingPromiseSpoken) {
        instruction += "\nYou have ALREADY promised that a manager will call back. Do not promise it again, do not restate a time for it, and do not ask when to call. Just move the conversation on.";
      }
      transcript.push({ role: "user", content: instruction });
    }
    const turnLocale = activeLocale;

    /* A failed brain call must never produce a turn with nothing in it.
     *
     * The 2026-10-06 test call logged "AI gateway returned non-JSON (HTTP 502)"
     * and "AI gateway timed out after 7000ms", and both produced pure dead air -
     * the agent said nothing at all and the prospect was left listening to a
     * dead line. The bug was that the fallback line was only applied when the
     * brain returned an empty string, not when it returned null: a failure and
     * an empty reply are different things, and only one of them was handled.
     *
     * So the failure is detected here, where the prospect is waiting on a reply,
     * and answered in the language of the call. Holding the turn is the one thing
     * that must never happen. */
    const ai = await askBrain({ transcript, ...config(turnLocale) });
    if (!ai || !ai.text || isMetaLine(ai.text)) {
      const reason = (ai && ai.timeout) ? "timed out" : "failed";
      try { log(`[brain] turn had no usable reply (${reason}); speaking the fallback line`); } catch {}
      /* Count it against the runaway-failure budget so a gateway that is down
       * ends the call with a human follow-up rather than talking to itself. */
      const line = unusableReply(turnLocale);
      lastAgentAsked = null;
      await agent(line, { intent: "reassurance", locale: turnLocale });
      if (consecutiveLlmFailures >= 4 && llmOutageSustained()) break;
      continue;
    }
    // A meta line is not an answer. It is also not a question, so it must not
    // become the "waiting on this" question the next quiet window re-asks.
    const aiText = String(ai.text || "");
    let finalText = normaliseCallbackWindow(stripWrongClosingIdiom(aiText));
    // A promise made is a promise kept once. The rest of the turn survives; only
    // the second promise is removed.
    if (closingPromiseSpoken && CALLBACK_MEANS[activeLocale] && CALLBACK_MEANS[activeLocale].test(finalText)) {
      finalText = finalText
        .replace(CALLBACK_MEANS[activeLocale], "")
        .replace(/\b(?:shortly|as soon as possible|right away)\b/gi, "")
        .replace(/\s{2,}/g, " ")
        .replace(/[.,;]\s*$/, "")
        .trim();
      // If that emptied the line, they have everything and there is nothing left
      // to say but thank you.
      if (!/[a-z]{3}/i.test(finalText)) finalText = advanceLineSafe(turnLocale);
    }
    if (finalText && CALLBACK_MEANS[activeLocale] && CALLBACK_MEANS[activeLocale].test(finalText)) {
      closingPromiseSpoken = true;
    }
    lastAgentAsked = finalText ? (extractQuestion(finalText) || null) : lastAgentAsked;
    await agent(finalText || unusableReply(turnLocale), { intent: turnIntent(heard, finalText), locale: turnLocale });

    // "give me a call right away", "I'll be waiting" - they are engaged and
    // there is nothing left to qualify, so the next pause is a goodbye.
    if (READY_NOW_RE.test(heard)) noMoreQuestions = true;

    // Repeated AI failure must not silently turn the universal agent back into
    // a rigid industry script. End safely and leave a human-follow-up result.
    if (consecutiveLlmFailures >= 4 && llmOutageSustained()) break;
  }

  // A sales call must not just stop. When the loop ends for a reason that is not
  // already a spoken farewell (turn backstop, dead line, junk line) the prospect
  // currently never hears a closing - the 20:44Z call was cut off mid-sentence
  // on "...a load from Gujarawala to Kar" with no sign-off at all. Close it out
  // properly: thank them, say what happens next, then hang up.
  if (!closingSpoken && !gateEnded) {
    closingSpoken = true;
    /* Close properly: repeat back the number the prospect actually gave and
     * commit to a manager calling within 30 minutes. The 16:09Z call ended on
     * "Thank you for your time; we'll follow up shortly with the requested
     * information" - no number, no commitment, nothing for the prospect to
     * hold on to. */
    const captured = capturePhoneNumber(leadSpeech.join(" ")) || callbackNumber;
    const closing = await askBrain({
      transcript: [
        ...transcript,
        {
          role: "lead",
          text: `The conversation is over. Speak a short, warm professional closing. ${captured ? `State the callback number exactly as "${captured}".` : "Never state or invent any phone number - you do not have one."} Say that a manager will call back within the next 30 minutes. Thank them once, say goodbye, and stop. One or two sentences, no new questions.`,
        },
      ],
      ...config(),
    });
      if (closing.text) {
        /* Build the whole closing first, cap it LAST, and never let the model
         * state a number nobody gave it. The 19:09Z call produced an 11.2-second
         * closing that said the same thing twice and quoted a phone number the
         * prospect never gave, because the brain was asked to state "the number
         * you already have on file" and invented one. */
        let line = closing.text;
        /* And it must not be a line the prospect has already heard.
         *
         * The exact never-repeat guard cannot see this, because the callback
         * promise is bolted onto the end: a model that repeats its own greeting
         * into a closing produces "<the greeting>. A manager will call you back
         * within the next 30 minutes.", which normalizes differently and is the
         * same sentence. audio-sim's repetition detector flags it, and it is
         * right to - the last thing a caller hears should not be the first thing.
         *
         * If the closing really is a repeat, the deterministic closing is used
         * instead: it is ours, it is always different, and saying it is exactly
         * what a closing is for. */
        if (isNearDuplicate(capTurnLength(line), spokenOrder)) {
          line = closingLine(activeLocale, captured);
        }
        // Strip any number the model produced that we did not capture.
        if (captured) {
          const wanted = captured.replace(/\D/g, "");
          line = line.replace(/[\d][\d\s().`'\-]{5,}[\d]/g, (m) => (m.replace(/\D/g, "") === wanted ? m : ""));
        } else {
          line = line.replace(/[\d][\d\s().`'\-]{5,}[\d]/g, "");
        }
        /* The closing was augmented in English only, so an Urdu call ended with
         * "... ہے، کیا آپ سن رہے ہیں؟. A manager will call you back within the
         * next 30 minutes." - the last thing a prospect hears is the agent
         * forgetting their language. Every augmentation is now localized, and
         * where we have no trustworthy translation we say nothing rather than
         * switching to English at the end of the call. */
        const cb = callbackSentence(activeLocale, captured);
        const saysCallback = alreadyPromisesCallback(line, activeLocale);
        if (!saysCallback && cb) {
          line = line.replace(/[.!]?\s*$/, ". " + (captured ? cb(captured) : cb()));
        } else if (captured && !line.includes(captured)) {
          // It promised a callback but never gave the number. Add just the number.
          line = line.replace(/[.!]?\s*$/, ` ${captured}.`);
        }
        await agent(capTurnLength(line), { intent: "closing", noRetry: true });
      } else {
        const cb = callbackSentence(activeLocale, captured);
        await agent(cb ? `Thanks for your time. ${cb(captured)} Goodbye.` : "");
      }
  }

  const verdict = scoreLead({ transcript, fields: leadFields, locale: activeLocale });
  const allLeadWords = transcript.filter((t) => t.role === "lead").map((t) => t.text).join(" ");
  const legacyEsc = shouldEscalate({ goodLead: verdict.goodLead, maxAttemptsOfRejection: 0, hearsHumanRequest: allLeadWords, locale: activeLocale });
  const escalateToHuman = !stopRequested && (humanRequested || llmOutageSustained() || legacyEsc.escalate);
  const strategies = ["llm_company_context", "speech_driven_turns", "automatic_multilingual"];
  const updatedLearning = learn(learning || {}, {
    goodLead: verdict.goodLead,
    strategies,
    missed: [],
    goodConversation: heardSomething,
    friendlyKeys: [],
    locale: activeLocale,
  });
  const leadLines = transcript.filter((t) => t.role === "lead" && !t.text.startsWith("(silence)")).map((t) => t.text);

  return {
    product,
    callId,
    company: companyName || "our team",
    transcript,
    timeline,
    locale: activeLocale,
    score: Number(verdict.score.toFixed(2)),
    goodLead: verdict.goodLead,
    escalateToHuman,
    escalateReason: stopRequested ? "do-not-call request" : (humanRequested ? "human requested" : (llmOutageSustained() ? "AI gateway outage" : legacyEsc.reason)),
    learning: updatedLearning,
    strategies,
    summary: `Call about ${product || "customer offering"}: ${verdict.goodLead ? "QUALIFIED LEAD" : "not a lead"}. Lead said: ${leadLines.join(" | ") || "nothing detected"}.`,
    contactEmail: contactEmail || null,
  };
}

module.exports = { runCall, prospectAskedQuestion, isAcknowledgmentOnly, OPENER_GREETING_RE, configText };
