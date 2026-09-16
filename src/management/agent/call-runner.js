const { scoreLead, shouldEscalate, learn } = require("./brain");
const { nextTurn, opening } = require("./intelligent-brain");

const STOP_RE = /\b(stop calling|do not call|don't call|remove me|take me off|unsubscribe|not call me again)\b/i;
const HUMAN_RE = /\b(human|real person|representative|manager|supervisor|agent)\b/i;

function fallbackOpening({ companyName, product }) {
  const company = String(companyName || "our team").trim();
  const offering = String(product || "what we offer").trim();
  return `Hi, this is Autumn from ${company}. I'm calling briefly about ${offering}. Is now an okay time for a quick conversation?`;
}

function fallbackReply(text, { callbackNumber, callbackIn }) {
  if (STOP_RE.test(String(text || ""))) return "Absolutely. I'll end the sales conversation here.";
  if (HUMAN_RE.test(String(text || ""))) {
    if (callbackNumber) return `Of course. I can have a person follow up, or you can call ${callbackNumber}${callbackIn ? ` ${callbackIn}` : ""}.`;
    return "Of course. I'll mark this for a human follow-up.";
  }
  return "I want to answer that accurately rather than guess. Let me note it for the team to follow up.";
}

async function runCall({ product, leadFields, persona, companyName, callbackNumber, callbackIn, speak, listen, contactEmail, learning, locale = "en" }) {
  const transcript = [];
  const timeline = [];
  let heardSomething = false;
  let llmFailures = 0;
  let stopRequested = false;
  let humanRequested = false;

  const config = { product, leadFields, persona, companyName, callbackNumber, callbackIn, locale };
  const agent = async (text) => {
    const line = String(text || "").trim();
    if (!line) return;
    transcript.push({ role: "agent", text: line });
    await speak(line);
  };
  const lead = (text) => {
    const line = String(text || "").trim();
    if (!line) return;
    if (!line.startsWith("(silence)")) heardSomething = true;
    transcript.push({ role: "lead", text: line });
  };

  let first = await opening(config);
  if (!first.text) llmFailures++;
  await agent(first.text || fallbackOpening(config));

  // Turn count is only a runaway-call safety bound. Turn endings themselves are
  // controlled by the speech/VAD listener in call.js, never by a conversation timer.
  for (let turn = 0; turn < 12; turn++) {
    const heard = await listen();
    if (!heard || String(heard).startsWith("(silence)")) {
      lead("(silence)");
      if (turn === 0) {
        await agent("Hello? I just want to make sure you can hear me.");
        continue;
      }
      break;
    }

    lead(heard);
    stopRequested = STOP_RE.test(heard);
    humanRequested = HUMAN_RE.test(heard) && /\b(speak|talk|transfer|connect|want|need)\b/i.test(heard);

    if (stopRequested) {
      await agent("Absolutely. I'll end the sales conversation here.");
      break;
    }
    if (humanRequested) {
      await agent(fallbackReply(heard, config));
      break;
    }

    const ai = await nextTurn({ transcript, ...config });
    if (!ai.text) llmFailures++;
    await agent(ai.text || fallbackReply(heard, config));

    // Repeated AI failure must not silently turn the universal agent back into
    // a rigid industry script. End safely and leave a human-follow-up result.
    if (llmFailures >= 2) break;
  }

  const verdict = scoreLead({ transcript, fields: leadFields, locale });
  const allLeadWords = transcript.filter((t) => t.role === "lead").map((t) => t.text).join(" ");
  const legacyEsc = shouldEscalate({ goodLead: verdict.goodLead, maxAttemptsOfRejection: 0, hearsHumanRequest: allLeadWords, locale });
  const escalateToHuman = !stopRequested && (humanRequested || llmFailures > 0 || legacyEsc.escalate);
  const strategies = ["llm_company_context", "speech_driven_turns"];
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
