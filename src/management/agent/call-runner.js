const { scoreLead, shouldEscalate, learn } = require("./brain");
const { nextTurn, opening } = require("./intelligent-brain");
const { normalizeLanguage } = require("./language");
const { capTurnLength, splitSentences } = require("./turn-length");
const { NON_LATIN_LOCALE, isMostlyNonLatin, scriptAgreesWithLocale } = require("./script-guard");
const { getResearch: getCachedResearch, refresh: refreshResearch, researchBlock } = require("./sales-research");

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
    return { ...baseConfig, locale: activeLocale, playbook, research: getCachedResearch(product, companyName) };
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
      // A repeat introduction may only be dropped once the opening has actually
      // been said. On the 19:09Z call the brain was asked to restate the opener,
      // did exactly that, and the guard then deleted the whole line for being a
      // restatement - the agent said nothing for 14 seconds. A guard that makes
      // us go quiet is worse than the repetition it prevents.
      const trimmed = lastSpokenLine ? stripRepeatedAsks(line, askedFor) : line;
      if (trimmed) line = trimmed;
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
    // Never repeat a line. The 18:51Z call said "The line is connected and
    // ready" on two consecutive turns, and a stub brain here produced the same
    // sentence three times in one call - the most machine-sounding thing a
    // caller can do. Consecutive-only checking was not enough, so this tracks
    // every line already spoken and rotates the substitute too.
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    if (spokenLines.has(norm(line))) {
      const subs = activeLocale === "en"
        ? ["Sorry, I did not quite catch that - could you tell me a bit more?",
           "Sorry, you cut out for a second - what did you say?",
           "Could you say that again, a little louder?",
           "Sorry, I missed that. What would you like to ask about?"]
        : ["Sorry, could you repeat that?",
           "Sorry, you cut out for a second.",
           "Could you say that again?"];
      line = subs.find((s) => !spokenLines.has(norm(s))) || subs[0];
    }
    spokenLines.add(norm(line));
    lastSpokenLine = line;
    transcript.push({ role: "agent", text: line, locale: activeLocale });
    await speak(line, { locale: activeLocale, intent: opts.intent });
  };
  const lead = (text, detected) => {
    const line = String(text || "").trim();
    if (!line) return;
    if (!line.startsWith("(silence)")) heardSomething = true;
    transcript.push({ role: "lead", text: line, locale: detected || activeLocale });
  };

  // Research ahead of the call, never during it: the cache is read synchronously
  // per turn and the fetch runs in the background.
  refreshResearch({ portal, deviceToken, callId, product, vertical: companyName }).catch(() => {});

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
        const ask = {
          role: "lead",
          text: "The prospect was speaking but the call could not hear them clearly. Do NOT move on to a new topic and do NOT ask a new question. Apologise in one short sentence and ask them to say that again.",
        };
        const reply = await askBrain({ transcript: [...transcript, ask], ...config() });
        await agent(reply.text || (activeLocale === "en"
          ? "Sorry, I did not catch that clearly. Could you say that again?"
          : "Sorry, could you repeat that?"), { intent: "reassurance" });
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
      if (hello.text) lastAgentAsked = extractQuestion(hello.text) || pendingQuestion;
      await agent(hello.text || (neverHeard && firstQuiet
        ? (activeLocale === "en" ? "Hello, this is Atlas with Zaz Logistics. Is now a good time for a quick call?" : "Hello.")
        : (activeLocale === "en" ? "Hello, is this a good time to talk?" : "Hello?")), neverHeard && firstQuiet ? "opening" : "checkin");
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
    lastAgentAsked = extractQuestion(ai.text) || null;
    await agent(ai.text || fallbackReply(heard, config()), { intent: turnIntent(heard, ai.text) });

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
        const saysCallback = /\b(manager|call you back|callback|follow up|ring you|get back to you)\b/i.test(line);
        if (!saysCallback) {
          line = line.replace(/[.!]?\s*$/, captured
            ? `. We'll call you back on ${captured} within the next 30 minutes.`
            : ". A manager will call you back within the next 30 minutes.");
        } else if (captured && !line.includes(captured)) {
          // It promised a callback but never gave the number. Add just the number.
          line = line.replace(/[.!]?\s*$/, ` on ${captured}.`);
        }
        if (!/\b30 minutes\b/i.test(line)) {
          line = line.replace(/[.!]?\s*$/, ". We'll be in touch within 30 minutes.");
        }
        await agent(capTurnLength(line), { intent: "closing" });
      } else {
      await agent(captured
        ? `Thanks for your time. A manager will call you back on ${captured} within the next 30 minutes. Goodbye.`
        : "Thanks for your time. A manager will call you back within the next 30 minutes. Goodbye.");
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

module.exports = { runCall };
