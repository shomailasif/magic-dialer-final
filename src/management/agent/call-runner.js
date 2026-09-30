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
const WHO_IS_THIS_RE = /\b(who(?:'s| is) this|who(?:'s| are) (?:this|you)|what(?:'s| is) (?:this|that)|kaun (?:ho|hai)|koi hai)\b/i;
const STOP_RE = /\b(stop calling|do not call|don't call|remove me|take me off|unsubscribe|not call me again)\b/i;
  const HUMAN_RE = /\b(human|real person|representative|manager|supervisor|agent)\b/i;

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
  ["truckType", /\bwhat (?:type|kind) of (?:truck|vehicle)\b|\bwhich (?:type|kind) of (?:truck|vehicle)\b|\bdo you (?:drive|run|operate)\b/i],
  ["truckSize", /\bhow many trucks\b|\bfleet size\b|\bwhat size\b|\bsize of your (?:fleet|trucks)\b/i],
];

/** Sentences that must never come out of a live outbound call:
 *  - a repeat introduction, after the opening has already been said
 *  - inbound-receptionist phrasing, which is the single most reliable way an
 *    outbound caller sounds broken. The 21:05Z call and a later simulated call
 *    both produced "How can I help you today?" / "What can I help you with
 *    today?" on a call we placed. The prompt forbids it and the model does it
 *    anyway, so it is enforced here.
 *  - a bare re-ask for something already asked. */
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

function isForbiddenTurnSentence(sentence, isOpening) {
  if (/\bthis is (?:atlas|autumn|alex|[a-z]+) (?:from|with|calling)\b|\bcalling (?:you )?from\b|\bcalling about\b/i.test(sentence)) return true;
  if (/\bhow can i (?:help|assist) you\b|\bwhat can i (?:help|assist) you with\b|\bhow may i (?:help|direct) you\b|\bthanks for reaching out\b|\bhow can i direct your call\b/i.test(sentence)) return true;
  const topic = ASK_TOPICS.find(([, re]) => re.test(sentence));
  return !!(topic && askedForCache.has(topic[0]));
}

// The set of topics already asked, rebound per call by bindAskedFor().
let askedForCache = new Set();
function bindAskedFor(set) { askedForCache = set; }

/** Sentences that only re-ask for something already asked, plus a repeat intro.
 *  Everything that is actually spoken gets recorded, so the same request can
 *  never slip through twice - recording only the multi-sentence path let a
 *  one-line "May I get your name?" be asked again on the next turn. */
function stripRepeatedAsks(text, askedFor) {
  bindAskedFor(askedFor);
  const record = (t) => { for (const [k, re] of ASK_TOPICS) if (re.test(t)) askedFor.add(k); };
  const sentences = splitSentences(String(text || ""));
  if (sentences.length < 2) {
    // A single-sentence turn that is entirely forbidden carries no information;
    // drop it so the prospect hears a pause, not the same question again.
    if (isForbiddenTurnSentence(sentences[0] || text)) return "";
    record(text);
    return text;
  }
  const kept = [];
  for (const s of sentences) {
    if (isForbiddenTurnSentence(s)) continue;
    kept.push(s);
    record(s);
  }
  return kept.join(" ").trim();
}

async function runCall({ product, leadFields, persona, companyName, callbackNumber, callbackIn, speak, listen, contactEmail, learning, locale = "en", preparedOpeningText = null, portal = null, deviceToken = null, callId = null }) {
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
      if (left <= 0) { consecutiveLlmFailures++; llmFailures++; return { text: null, timeout: true }; }
      let timer = null;
      const r = await Promise.race([
        attempt(),
        new Promise((res) => { timer = setTimeout(() => res(null), left); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (r && r.text) { consecutiveLlmFailures = 0; return r; }
      consecutiveLlmFailures++;
      llmFailures++;
      if (Date.now() - startedAt >= BRAIN_BUDGET_MS) return { text: null, timeout: true };
    }
    return { text: null };
  };
  let consecutiveSilence = 0;
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
  let openingAsked = false;
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
  const QUIET_HANGUP_MS = 20000;
  // The question the agent is currently waiting on, so a quiet window re-asks
  // it instead of moving to the next topic.
  let lastAgentAsked = null;
  const spokenLines = new Set();
  let lastSpokenLine = null;
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
          const retry = await askBrain({
            ...config(),
            transcript: [
              ...transcript,
              { role: "lead", text: String(lastProspectTurn || "") },
              {
                role: "lead",
                text:
                  "Answer my question directly. I asked whether your dispatcher can call me now. " +
                  "Give me a real answer - yes or no and why - in one or two sentences. Do not ask " +
                  "me anything back, and do not just thank me.",
              },
            ],
          }).catch(() => null);
          const retryLine = retry && retry.text ? capTurnLength(String(retry.text).trim()) : "";
          // Only accept the retry if it is genuinely an answer.
          if (retryLine && !/\?\s*$/.test(retryLine) && !ACKNOWLEDGMENT_ONLY_RE.test(retryLine)) {
            line = retryLine;
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
        if (!openingSpoken) openingSpoken = true;
        else if (askedWhoIsThis) {
          // On the 18:44Z call the prospect asked "Who is this?" and the guard
          // removed "This is Atlas with Zaz Logistics" for being a repeat
          // introduction. Skip the strip when they ask who is calling.
        } else {
          const trimmed = lastSpokenLine ? stripRepeatedAsks(line, askedFor) : line;
          if (trimmed) line = trimmed;
        }
        // "Is this a good time to talk?" is only ever an opener - but the brain
        // is allowed to say it when they have just asked who is calling, and an
        // earlier version of this rule replaced the agent's name with a canned
        // question in exactly that case. Never override a reply to that question.
        if (openingAsked && !askedWhoIsThis
          && /\b(?:is (?:now )?(?:this|it) a good time|good time to (?:talk|chat))\b/i.test(line)) {
          line = unusableReply(loc);
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
      spokenLines.add(normalizeSpoken(line));
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

  if (preparedOpeningText) {
    await agent(preparedOpeningText, { intent: "opening" });
  } else {
    const first = await opening(config()).catch(() => ({ text: null }));
    if (!first || !first.text) { llmFailures++; await agent(fallbackOpening(config()), { intent: "opening" }); }
    else await agent(first.text, { intent: "opening" });
  }

  // Turn count is only a runaway-call safety bound. Turn endings themselves are
  // controlled by the speech/VAD listener in call.js, never by a conversation timer.
  // 12 was low enough to end a real conversation: the 20:44Z call hit exactly
  // 12 turns and was cut off mid-sentence ("...a load from Gujarawala to Kar")
  // immediately after the prospect asked for a load. Real endings - a do-not-call
  // request, a human request, two quiet windows, three junk windows, repeated
  // brain failure - all still fire long before this backstop.
  for (let turn = 0; turn < 20; turn++) {
    // Always let the recognizer auto-detect the spoken language; the configured
    // locale is only the starting language, never a permanent pin.
    const heardResult = await listen({ locale: activeLocale, autoLanguage: true });
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
        ask = { role: "lead", text: "Still no answer. Say hello and ask whether this is a good time to talk, in one short natural sentence. Never say the line is connected or that you are ready - that sounds like a machine." };
      } else if (pendingQuestion) {
        ask = { role: "lead", text: `You asked: "${pendingQuestion}". The prospect has not answered yet. Do NOT move on to a different topic and do NOT ask a new question. Politely invite them to answer, or repeat that one question in different words, in one short sentence.` };
      } else {
        ask = { role: "lead", text: "The prospect went quiet. Continue the conversation naturally from what was just discussed, or ask one simple question to invite a reply. Do not comment on the line, the connection, or whether they can hear you." };
      }
      const hello = await askBrain({ transcript: [...transcript, ask], ...config() });
      if (hello.text && !isMetaLine(hello.text)) lastAgentAsked = extractQuestion(hello.text) || pendingQuestion;
      await agent((hello.text && !isMetaLine(hello.text)) ? hello.text : (neverHeard && firstQuiet
        ? (activeLocale === "en" ? "Hello, this is Atlas with Zaz Logistics. Is now a good time for a quick call?" : "Hello.")
        : (activeLocale === "en" ? "Hello, is this a good time to talk?" : "Hello?")),
      { intent: neverHeard && firstQuiet ? "opening" : "checkin", noRetry: true });
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
    if (openingSpoken) openingAsked = true;
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

    const ai = await askBrain({ transcript, ...config(turnLocale) });
    // A meta line is not an answer. It is also not a question, so it must not
    // become the "waiting on this" question the next quiet window re-asks.
    const aiText = isMetaLine(ai.text) ? "" : String(ai.text || "");
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
    if (consecutiveLlmFailures >= 4) break;
  }

  // A sales call must not just stop. When the loop ends for a reason that is not
  // already a spoken farewell (turn backstop, dead line, junk line) the prospect
  // currently never hears a closing - the 20:44Z call was cut off mid-sentence
  // on "...a load from Gujarawala to Kar" with no sign-off at all. Close it out
  // properly: thank them, say what happens next, then hang up.
  if (!closingSpoken) {
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
  const escalateToHuman = !stopRequested && (humanRequested || llmFailures > 0 || legacyEsc.escalate);
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
    escalateReason: stopRequested ? "do-not-call request" : (humanRequested ? "human requested" : (llmFailures ? "AI fallback required" : legacyEsc.reason)),
    learning: updatedLearning,
    strategies,
    summary: `Call about ${product || "customer offering"}: ${verdict.goodLead ? "QUALIFIED LEAD" : "not a lead"}. Lead said: ${leadLines.join(" | ") || "nothing detected"}.`,
    contactEmail: contactEmail || null,
  };
}

module.exports = { runCall, prospectAskedQuestion, isAcknowledgmentOnly };
