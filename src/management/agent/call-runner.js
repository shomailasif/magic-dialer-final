const { scoreLead, shouldEscalate, learn } = require("./brain");
const { nextTurn, opening } = require("./intelligent-brain");
const { normalizeLanguage } = require("./language");

const STOP_RE = /\b(stop calling|do not call|don't call|remove me|take me off|unsubscribe|not call me again)\b/i;
const HUMAN_RE = /\b(human|real person|representative|manager|supervisor|agent)\b/i;

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

async function runCall({ product, leadFields, persona, companyName, callbackNumber, callbackIn, speak, listen, contactEmail, learning, locale = "en", preparedOpeningText = null }) {
  const transcript = [];
  const timeline = [];
  let heardSomething = false;
  let llmFailures = 0;
  let stopRequested = false;
  let humanRequested = false;
  let activeLocale = locale === "auto" ? "en" : normalizeLanguage(locale);

  const baseConfig = { product, leadFields, persona, companyName, callbackNumber, callbackIn };
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
    const first = await opening(config());
    if (!first.text) throw new Error("AI opening unavailable; refusing scripted fallback");
    await agent(first.text);
  }

  // Turn count is only a runaway-call safety bound. Turn endings themselves are
  // controlled by the speech/VAD listener in call.js, never by a conversation timer.
  for (let turn = 0; turn < 12; turn++) {
    const heardResult = await listen({ locale: activeLocale, autoLanguage: locale === "auto" });
    const heard = typeof heardResult === "string" ? heardResult : (heardResult && heardResult.text);
    const detected = typeof heardResult === "object" && heardResult && heardResult.language
      ? normalizeLanguage(heardResult.language, null)
      : null;
    if (detected && detected !== activeLocale) {
      activeLocale = detected;
      timeline.push({ at: Date.now(), event: "language-switch", locale: activeLocale });
    }

    if (!heard || String(heard).startsWith("(silence)")) {
      lead("(silence)");
      if (turn === 0) {
        const hello = await nextTurn({ transcript: [...transcript, { role: "lead", text: "The line is quiet. Briefly check whether the prospect can hear you." }], ...config() });
        if (!hello.text) llmFailures++;
        await agent(hello.text || (activeLocale === "en" ? "Hello? I just want to make sure you can hear me." : "Hello?"));
        continue;
      }
      break;
    }

    lead(heard, detected);
    stopRequested = STOP_RE.test(heard);
    humanRequested = HUMAN_RE.test(heard) && /\b(speak|talk|transfer|connect|want|need)\b/i.test(heard);

    if (stopRequested) {
      const stopLine = await nextTurn({ transcript: [...transcript, { role: "lead", text: "Acknowledge the do-not-call request immediately and end the call." }], ...config() });
      await agent(stopLine.text || fallbackReply(heard, config()));
      break;
    }
    if (humanRequested) {
      await agent(fallbackReply(heard, config()));
      break;
    }

    const ai = await nextTurn({ transcript, ...config() });
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
  });
  const leadLines = transcript.filter((t) => t.role === "lead" && !t.text.startsWith("(silence)")).map((t) => t.text);

  return {
    product,
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
