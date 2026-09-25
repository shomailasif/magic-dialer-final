const { scoreLead, shouldEscalate, learn } = require("./brain");
const { nextTurn, opening } = require("./intelligent-brain");
const { normalizeLanguage } = require("./language");
const { capTurnLength, splitSentences } = require("./turn-length");
const { NON_LATIN_LOCALE, isMostlyNonLatin, scriptAgreesWithLocale } = require("./script-guard");

const STOP_RE = /\b(stop calling|do not call|don't call|remove me|take me off|unsubscribe|not call me again)\b/i;
const HUMAN_RE = /\b(human|real person|representative|manager|supervisor|agent)\b/i;
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
  ["mcn", /\bmc\s*number\b|\bmc\s*#?\b/i],
  ["phone", /\bphone number\b|\bbest (?:phone )?number\b|\bemail address\b|\breach you (?:at|on)\b/i],
  ["name", /\byour name\b|\bwhat(?:'s| is) your name\b|\bmay i have your name\b|\bcan i get your name\b/i],
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
  /* The brain is a network call. A gateway hiccup used to end a live call after
   * two bad turns, which is indistinguishable from the product breaking in the
   * prospect's ear. Retry once, and only end the call after sustained failure. */
  const askBrain = async (payload) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let r = null;
      try { r = await nextTurn(payload); } catch { r = null; }
      if (r && r.text) { consecutiveLlmFailures = 0; return r; }
      consecutiveLlmFailures++;
      llmFailures++;
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
  // Set when the agent has already said goodbye, so we never talk over a
  // farewell with a second one.
  let closingSpoken = false;
  let activeLocale = locale === "auto" ? "en" : normalizeLanguage(locale);

  const baseConfig = { product, leadFields, persona, companyName, callbackNumber, callbackIn, portal, deviceToken, callId, learning: learning || {} };
  // The learned playbook has to reach the live brain, or learning only records
  // scores and never changes a call. The highest-scoring strategies, and the
  // objection-handling ones this vertical actually hits, are named in the prompt.
  const config = () => {
    const l = learning || {};
    const scores = l.strategyScores || {};
    const ranked = Object.keys(scores).sort((a, b) => (scores[b] || 0) - (scores[a] || 0));
    const playbook = ranked.filter((k) => (scores[k] || 0) > -1).slice(0, 4);
    return { ...baseConfig, locale: activeLocale, playbook };
  };
  const askedFor = new Set();
  let openingSpoken = false;
  const agent = async (text, opts = {}) => {
    // Cap here, where the words are produced, so every consumer of a turn - a
    // live call or an offline simulation - gets a speakable length. The
    // controller caps again as a net before anything reaches the wire.
    let line = capTurnLength(String(text || "").trim());
    if (!line) return;
    // Never re-introduce after the opening, and never re-ask for something
    // already asked.
    if (!openingSpoken) openingSpoken = true;
    else {
      const trimmed = stripRepeatedAsks(line, askedFor);
      if (!trimmed) return; // nothing new to say; hold the line and let them talk
      line = trimmed;
    }
    // The brain likes to mirror whatever script the prospect used, even on a
    // call configured for another language. That put Devanagari and Arabic
    // through an English voice on the 21:05Z call. Do not speak a script we
    // have no voice for; RTP keep-alive holds the line and the next turn is
    // generated in the configured language.
    if (!NON_LATIN_LOCALE.has(String(activeLocale).toLowerCase()) && isMostlyNonLatin(line)) {
      line = "";
    }
    if (!line) return;
    transcript.push({ role: "agent", text: line, locale: activeLocale });
    await speak(line, { locale: activeLocale });
  };
  const lead = (text, detected) => {
    const line = String(text || "").trim();
    if (!line) return;
    if (!line.startsWith("(silence)")) heardSomething = true;
    transcript.push({ role: "lead", text: line, locale: detected || activeLocale });
  };

  if (preparedOpeningText) {
    await agent(preparedOpeningText);
  } else {
    const first = await opening(config()).catch(() => ({ text: null }));
    if (!first || !first.text) { llmFailures++; await agent(fallbackOpening(config())); }
    else await agent(first.text);
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
      if (scriptAgreesWithLocale(heard, detected)) {
        if (pendingDetected === detected) {
          activeLocale = detected;
          pendingDetected = null;
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

    // A window only counts as a *quiet* window when nothing arrived at all.
    // Junk (carrier beep, voicemail tone) and speech the recognizer could not
    // turn into words both prove the far end is transmitting, so they age
    // their own bounded budget instead of the dead-line hangup. Otherwise a
    // prospect who answers after one beep is hung up on as a silent line.
    const reportedNoise = !!(heardResult && typeof heardResult === "object" && (heardResult.junk || heardResult.empty));
    const junkLead = !!heard && isJunkLead(heard);
    if (!heard || String(heard).startsWith("(silence)") || junkLead) {
      lead("(silence)");
      // The listener reports how long the window actually ran, so a dead line
      // still gets the same total patience as the old two 15s windows.
      quietMs += Number(heardResult && typeof heardResult === "object" && Number(heardResult.waitedMs) > 0)
        ? Number(heardResult.waitedMs)
        : 5000;
      if (reportedNoise || junkLead) {
        consecutiveJunk++;
        // Bounded: a line that only ever beeps still ends the call.
        if (consecutiveJunk >= 3) break;
      } else {
        consecutiveSilence++;
        // Two quiet windows in a row = dead line. One window only prompts a check-in.
        if (consecutiveSilence >= 2) break;
      }
      // What to say into a quiet window. This used to always be a connectivity
      // check, so a call that opened into dead air went straight to "Can you
      // hear me okay?" (20:24Z and 20:25Z calls) and a live conversation that
      // paused was told the line was quiet. Only escalate to a connectivity
      // check, and only while the prospect has never spoken.
      const neverHeard = !heardSomething;
      const firstQuiet = consecutiveSilence + consecutiveJunk <= 1;
      let ask;
      if (neverHeard && firstQuiet) {
        ask = { role: "lead", text: "The prospect has not answered yet. Restate who you are and your reason for calling in one short natural sentence, then ask whether this is a good time to talk. Do not ask if they can hear you." };
      } else if (neverHeard) {
        ask = { role: "lead", text: "Still no answer. Briefly check that the line is connected, in one short sentence." };
      } else {
        ask = { role: "lead", text: "The prospect went quiet. Continue the conversation naturally from what was just discussed, or ask one simple question to invite a reply. Do not comment on the line, the connection, or whether they can hear you." };
      }
      const hello = await askBrain({ transcript: [...transcript, ask], ...config() });
      await agent(hello.text || (neverHeard && firstQuiet
        ? (activeLocale === "en" ? "Hello, this is Atlas with Zaz Logistics. Is now a good time for a quick call?" : "Hello.")
        : (activeLocale === "en" ? "Hello? I just want to make sure you can hear me." : "Hello?")));
      continue;
    }
    consecutiveSilence = 0;
    consecutiveJunk = 0;
    quietMs = 0;
    pendingDetected = null;

    lead(heard, detected);
    stopRequested = STOP_RE.test(heard);
    humanRequested = HUMAN_RE.test(heard) && /\b(speak|talk|transfer|connect|want|need)\b/i.test(heard);

    if (stopRequested) {
      const stopLine = await askBrain({ transcript: [...transcript, { role: "lead", text: "Acknowledge the do-not-call request immediately and end the call." }], ...config() });
      closingSpoken = true;
      await agent(stopLine.text || fallbackReply(heard, config()));
      break;
    }
    if (humanRequested) {
      closingSpoken = true;
      await agent(fallbackReply(heard, config()));
      break;
    }

    const ai = await askBrain({ transcript, ...config() });
    await agent(ai.text || fallbackReply(heard, config()));

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
    const closing = await nextTurn({
      transcript: [...transcript, { role: "lead", text: "The conversation is over. Speak a short, warm professional closing: thank them for their time, state the single next step, and say goodbye. One or two sentences only. Do not ask any new questions." }],
      ...config(),
    }).catch(() => ({ text: null }));
    if (closing.text) await agent(closing.text);
    else await agent(activeLocale === "en"
      ? "Thanks for your time today. We'll follow up shortly. Have a great day."
      : "Thank you for your time. Goodbye.");
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

module.exports = { runCall };
