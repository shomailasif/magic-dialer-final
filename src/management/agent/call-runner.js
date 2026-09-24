const { scoreLead, shouldEscalate, learn } = require("./brain");
const { nextTurn, opening } = require("./intelligent-brain");
const { normalizeLanguage } = require("./language");

const STOP_RE = /\b(stop calling|do not call|don't call|remove me|take me off|unsubscribe|not call me again)\b/i;
const HUMAN_RE = /\b(human|real person|representative|manager|supervisor|agent)\b/i;
const JUNK_LEAD_RE = /^(beep\.?|tone\.?|busy signal\.?|dial tone\.?|click\.?|noise\.?|static\.?|\[.*\]|\(beep\))$/i;

function isJunkLead(text) {
  const s = String(text || "").trim();
  return !s || (s.length <= 40 && JUNK_LEAD_RE.test(s));
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

async function runCall({ product, leadFields, persona, companyName, callbackNumber, callbackIn, speak, listen, contactEmail, learning, locale = "en", preparedOpeningText = null, portal = null, deviceToken = null, callId = null }) {
  const transcript = [];
  const timeline = [];
  let heardSomething = false;
  let llmFailures = 0;
  let consecutiveSilence = 0;
  let stopRequested = false;
  let humanRequested = false;
  let activeLocale = locale === "auto" ? "en" : normalizeLanguage(locale);

  const baseConfig = { product, leadFields, persona, companyName, callbackNumber, callbackIn, portal, deviceToken, callId };
  const config = () => ({ ...baseConfig, locale: activeLocale });
  const agent = async (text) => {
    const line = String(text || "").trim();
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
  for (let turn = 0; turn < 12; turn++) {
    // Always let the recognizer auto-detect the spoken language; the configured
    // locale is only the starting language, never a permanent pin.
    const heardResult = await listen({ locale: activeLocale, autoLanguage: true });
    const heard = typeof heardResult === "string" ? heardResult : (heardResult && heardResult.text);
    const detected = typeof heardResult === "object" && heardResult && heardResult.language
      ? normalizeLanguage(heardResult.language, activeLocale || "en")
      : null;
    const commanded = detectLanguageCommand(heard);
    if (commanded && commanded !== activeLocale) {
      activeLocale = commanded;
      timeline.push({ at: Date.now(), event: "language-switch", locale: activeLocale, source: "command" });
    } else if (detected && detected !== activeLocale && isSubstantialUtterance(heard)) {
      activeLocale = detected;
      timeline.push({ at: Date.now(), event: "language-switch", locale: activeLocale, source: "detected" });
    }

    if (!heard || String(heard).startsWith("(silence)") || isJunkLead(heard)) {
      lead("(silence)");
      consecutiveSilence++;
      // Two quiet windows in a row = dead line. One window only prompts a check-in.
      if (consecutiveSilence >= 2) break;
      const hello = await nextTurn({ transcript: [...transcript, { role: "lead", text: "The line is quiet. Briefly check whether the prospect can hear you." }], ...config() }).catch(() => ({ text: null }));
      if (!hello.text) llmFailures++;
      await agent(hello.text || (activeLocale === "en" ? "Hello? I just want to make sure you can hear me." : "Hello?"));
      continue;
    }
    consecutiveSilence = 0;

    lead(heard, detected);
    stopRequested = STOP_RE.test(heard);
    humanRequested = HUMAN_RE.test(heard) && /\b(speak|talk|transfer|connect|want|need)\b/i.test(heard);

    if (stopRequested) {
      const stopLine = await nextTurn({ transcript: [...transcript, { role: "lead", text: "Acknowledge the do-not-call request immediately and end the call." }], ...config() }).catch(() => ({ text: null }));
      await agent(stopLine.text || fallbackReply(heard, config()));
      break;
    }
    if (humanRequested) {
      await agent(fallbackReply(heard, config()));
      break;
    }

    const ai = await nextTurn({ transcript, ...config() }).catch(() => ({ text: null }));
    if (!ai.text) llmFailures++;
    await agent(ai.text || fallbackReply(heard, config()));

    // Repeated AI failure must not silently turn the universal agent back into
    // a rigid industry script. End safely and leave a human-follow-up result.
    if (llmFailures >= 2) break;
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
