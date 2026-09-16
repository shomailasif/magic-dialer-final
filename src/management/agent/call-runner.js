const { makeBrain, scoreLead, shouldEscalate, learn } = require("./brain");
const I18N = require("./brain-i18n");

const NAME_BORN = /\b(my name is|this is|it's|thats)\s+([a-z]+)/i;
const NAME_TOKEN = /\b(hi|hello|hey|yes|yeah|no|sure|okay|ok|fine|thanks|good|great|correct|right)\b/i;
const HURRY_WORDS = /\b(hurry|quick|fast|short on time|rushed|in a rush|no time|busy|got to go|make it quick|wrap it up|get to the point)\b/i;

async function runCall({ product, leadFields, persona, companyName, callbackNumber, callbackIn, speak, listen, contactEmail, learning, locale = "en" }) {
  const requested = I18N.normalizeLocale(locale);
  let loc = requested === "auto" ? "en" : requested;
  let brain = makeBrain({ product, leadFields, persona, companyName, learning, locale: loc });
  const transcript = [];
  const timeline = [];
  let lastAgentText = "";
  let heardSomething = false;
  let leadName = null;
  let rejectionCount = 0;
  let interestLevel = 5;
  let turnCount = 0;
  let hurryMode = false;

  const isNegative = (t) => (I18N.NEGATIVE_BY_LOCALE[loc] || I18N.NEGATIVE_BY_LOCALE.en).test(String(t || ""));
  const isSoft = (t) => (I18N.SOFT_BY_LOCALE[loc] || I18N.SOFT_BY_LOCALE.en).test(String(t || ""));
  const retuneFor = (text) => {
    if (requested !== "auto") return;
    const d = I18N.detectLanguage(String(text || "").toLowerCase(), "en");
    if (d !== loc) { loc = d; brain = makeBrain({ product, leadFields, persona, companyName, learning, locale: loc }); }
  };

  const agent = async (text) => {
    lastAgentText = text;
    transcript.push({ role: "agent", text });
    await speak(text);
  };
  const lead = (text) => {
    if (!String(text).startsWith("(silence)")) heardSomething = true;
    transcript.push({ role: "lead", text });
  };
  const listenForLead = async () => {
    try {
      const heard = await listen();
      if (!heard || heard.startsWith("(silence)")) return heard;
      const t = String(heard).toLowerCase();
      const a = lastAgentText.toLowerCase();
      if (t && a.includes(t)) return null;
      if (t.length > 3) {
        const words = t.split(/\s+/); const agentWords = a.split(/\s+/);
        const overlap = words.filter((w) => agentWords.includes(w)).length;
        if (overlap >= Math.ceil(words.length * 0.5)) return null;
      }
      return heard;
    } catch { return null; }
  };

  const finish = (verdict) => {
    const allLeadWords = transcript.filter((t) => t.role === "lead").map((t) => t.text).filter((t) => !t.startsWith("(silence)")).join(" ");
    const esc = shouldEscalate({ goodLead: verdict.goodLead, maxAttemptsOfRejection: verdict.maxAttemptsOfRejection, hearsHumanRequest: allLeadWords, locale: loc });
    const goodConversation = verdict.goodLead || heardSomething || transcript.filter((t) => t.role === "lead" && !t.text.startsWith("(silence)")).length >= 2;
    return { product, company: brain.company, transcript, timeline, score: Number(verdict.score.toFixed(2)), goodLead: verdict.goodLead,
      escalateToHuman: esc.escalate, escalateReason: esc.reason,
      learning: learn(learning || {}, { goodLead: verdict.goodLead, strategies: brain.used, missed: brain.missed, goodConversation, friendlyKeys: brain.usedFriendly }),
      strategies: Array.from(new Set(brain.used)), summary: summarize(transcript, verdict.goodLead, product), contactEmail: contactEmail || null };
  };

  const captureName = (answer) => {
    const t = String(answer || "").toLowerCase(); const m = t.match(NAME_BORN);
    if (m) return m[2].charAt(0).toUpperCase() + m[2].slice(1);
    const words = t.replace(/[^a-z ]/g, "").trim().split(/\s+/).filter(Boolean);
    if (words.length === 1 && words[0].length >= 2 && words[0].length <= 12 && !NAME_TOKEN.test(words[0]) && !/not|n a|unknown|none/.test(words[0])) return words[0].charAt(0).toUpperCase() + words[0].slice(1);
    return null;
  };
  const updateInterest = (answer) => {
    const t = String(answer || "").toLowerCase();
    if (t.length > 20) interestLevel += 1; else if (t.length > 10) interestLevel += 0.5; else if (t.length < 4) interestLevel -= 1;
    if (brain.isQuestion(answer)) interestLevel += 2;
    if (HURRY_WORDS.test(t)) { hurryMode = true; interestLevel -= 2; }
    interestLevel = Math.max(0, Math.min(10, interestLevel)); turnCount++;
  };
  const shouldWrapUp = () => (hurryMode && turnCount >= 2) || (interestLevel <= 2 && turnCount >= 2) || turnCount >= 5;
  const pick = (arr, seed) => arr[Math.abs(seed || 0) % arr.length];
  const reactToAnswer = (answer, context) => {
    const t = String(answer || "").toLowerCase(); if (!t || t.startsWith("(silence)")) return null;
    if (brain.isQuestion(answer)) return brain.answerQuestion(answer);
    if (/\b(driving|on the road|rolling|busy|shutting down|parked)\b/.test(t)) return pick(["Totally understand - I'll keep this real quick then.", "Got it, won't keep you long. Let me ask one thing fast.", "Makes sense, I know your time is money."], t.length);
    if (/\b(yes|yeah|yep|sure|okay|ok|sounds good|that works|interested)\b/.test(t)) return pick(["Awesome, that's what I like to hear.", "Great - let me tell you how this works.", "Perfect, you're gonna like this."], t.length);
    if (/\b(no|nah|not really|don't think so)\b/.test(t)) return pick(["Fair enough - let me ask you something else.", "No problem at all, let me just check one thing.", "That's okay, different angle here."], t.length);
    if (context === "name" && leadName) return pick([`Nice to meet you, ${leadName}.`, `${leadName} - got it. Good to know you.`, `Great, ${leadName}. Let me keep going.`], t.length);
    return brain.reflect(answer, t.length);
  };

  await agent(brain.opening(1));
  let reply = await listenForLead();
  if (!reply) {
    await agent(brain.reopenOut()); reply = await listenForLead();
    if (!reply) { lead("(silence)"); await agent(brain.deadAirClose()); return finish(scoreLead({ transcript, fields: leadFields, locale: loc })); }
  }
  lead(reply); retuneFor(reply); updateInterest(reply);
  const esc = shouldEscalate({ goodLead: false, maxAttemptsOfRejection: 0, hearsHumanRequest: reply, locale: loc });
  if (esc.escalate) { await agent(brain.handoff()); return finish(scoreLead({ transcript, fields: leadFields, locale: loc })); }

  if (isNegative(reply)) {
    rejectionCount = 1; await agent(brain.pivotSoft(3, reply)); const second = await listenForLead();
    if (second) { lead(second); updateInterest(second); if (isNegative(second)) { await agent(brain.pivotGraceful()); return finish(scoreLead({ transcript, fields: leadFields, locale: loc })); } }
    else { lead("(silence)"); await agent(brain.pivotGraceful()); return finish(scoreLead({ transcript, fields: leadFields, locale: loc })); }
  }

  const answeredDirectly = captureName(reply) !== null || (/\b(yes|yeah|yep|ok|okay|sure|alright|fine|good|perfect|thanks|thank you|sounds good|that works|cool|right)\b/i.test(String(reply || "")) && String(reply || "").length < 24);
  if (!isNegative(reply) && !answeredDirectly && !isSoft(reply) && (brain.isQuestion(reply) || String(reply || "").length >= 6)) {
    const line = brain.isQuestion(reply) ? brain.answerQuestion(reply) : brain.friendlyFor(reply);
    if (line) { await agent(line); const thenReply = await listenForLead(); if (thenReply && !thenReply.startsWith("(silence)")) { lead(thenReply); reply = thenReply; updateInterest(thenReply); } else lead("(silence)"); }
  }
  if (!isNegative(reply) && isSoft(reply)) {
    await agent(brain.pivotSoft(3, reply)); const then = await listenForLead();
    if (then && !then.startsWith("(silence)")) { lead(then); reply = then; updateInterest(then); } else lead("(silence)");
  }

  await agent(brain.rapport(reply ? 5 : 6));
  const maxQuestions = hurryMode ? 2 : (interestLevel >= 6 ? Math.min(brain.fields.length, 4) : Math.min(brain.fields.length, 3));
  for (let asked = 0; asked < maxQuestions; asked++) {
    if (shouldWrapUp()) break;
    const field = brain.fields[asked]; const fieldName = typeof field === "string" ? field : (field && field.key) || String(field || "");
    const q = brain.question(field, asked); timeline.push(q); await agent(q); let answer = await listenForLead();
    if (answer && !answer.startsWith("(silence)")) {
      lead(answer); updateInterest(answer);
      if (isNegative(answer)) {
        rejectionCount++;
        if (rejectionCount >= 2) { await agent(brain.pivotGraceful()); return finish(scoreLead({ transcript, fields: leadFields, locale: loc })); }
        await agent(brain.pivotSoft(asked + 7, answer)); const again = await listenForLead();
        if (again && !again.startsWith("(silence)")) { lead(again); updateInterest(again); if (isNegative(again)) { await agent(brain.pivotGraceful()); return finish(scoreLead({ transcript, fields: leadFields, locale: loc })); } answer = again; }
        else { lead("(silence)"); continue; }
      }
      if (fieldName.toLowerCase() === "name") leadName = captureName(answer) || leadName;
      const reaction = reactToAnswer(answer, fieldName.toLowerCase()); if (reaction) await agent(reaction);
    } else {
      lead("(silence)"); const retry = brain.retryQuestion(field); timeline.push(retry); await agent(retry); const second = await listenForLead();
      if (second && !second.startsWith("(silence)")) { lead(second); updateInterest(second); if (fieldName.toLowerCase() === "name") leadName = captureName(second) || leadName; }
      else lead("(silence)");
    }
  }
  const verdict = scoreLead({ transcript, fields: leadFields, locale: loc });
  await agent(brain.qualifyingClose(verdict.goodLead, leadName, { callbackNumber: callbackNumber || null, callbackIn: callbackIn || null }));
  return finish(verdict);
}

function summarize(transcript, goodLead, product) {
  const leadLines = transcript.filter((t) => t.role === "lead").map((t) => t.text.replace(/^\((silence)\)$/, "no answer")).filter(Boolean);
  return `Call about ${product}: ${goodLead ? "QUALIFIED LEAD" : "not a lead"}. Lead said: ${leadLines.join(" | ") || "nothing detected"}.`;
}
module.exports = { runCall };
