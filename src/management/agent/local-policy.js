"use strict";

/* The sales judgement that must not be left to a one-billion-parameter model.
 *
 * A 1B model is the only thing that keeps a call alive on a two-core laptop
 * after the free hosted tier runs out, and it is fast enough to answer while
 * the prospect is still listening (~1.8s median here). What it does not do
 * reliably is the handful of turns that decide whether the call continues:
 * pricing, "not interested", "where did you get my number", "why do you need my
 * MC". Measured on the installed runtime, it invented "$2 per load" when asked
 * about price and answered a brush-off with a qualification question the
 * prospect had not invited.
 *
 * Those turns are not creative. A dispatcher says the same three or four things
 * every time, and saying them without hesitation is what sounds professional.
 * So they are answered here, deterministically, before the model is started:
 *
 *   - zero latency, because the model never loads for those turns;
 *   - no fabricated money, because there is no sampler involved;
 *   - no repeated question, because every variant already spoken is skipped.
 *
 * Everything else still goes to the model. This layer is deliberately small:
 * a policy line that does not fit the moment would be worse than the model's
 * own sentence, so an intent with no unused variant returns null and the turn
 * falls through to the ordinary path.
 */

/* Our own injected instructions travel in the transcript as user turns. They
 * are not things the prospect said, and feeding them back as CUSTOMER lines is
 * what made the offline model answer its own setup text. */
const INSTRUCTION_RE = /^(?:start this outbound|reply with exactly|answer that question directly|you just tried to ask|the prospect has just told you|already collected|still needed|you have already promised|call so far)/i;

function isInstruction(text) {
  return INSTRUCTION_RE.test(String(text || "").trim());
}

function spokenText(message) {
  const raw = typeof message === "string" ? message : message && message.content;
  return String(raw || "").replace(/\s+/g, " ").trim();
}

/* Real prospect turns, oldest first. `role` is "lead"/"prospect" in the call
 * controller and "user" in the brain's own history; both are the same side. */
function leadMessages(history) {
  return (Array.isArray(history) ? history : []).filter((m) => {
    if (!m || !m.content) return false;
    if (m.role !== "lead" && m.role !== "prospect" && m.role !== "user") return false;
    return !isInstruction(m.content);
  });
}

function agentMessages(history) {
  return (Array.isArray(history) ? history : []).filter(
    (m) => m && m.content && (m.role === "assistant" || m.role === "agent"),
  );
}

function lastLeadLine(history) {
  const rows = leadMessages(history);
  return rows.length ? spokenText(rows[rows.length - 1]) : "";
}

function normalise(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

const AI_QUESTION =
  /\b(?:are you|is this|am i (?:talking|speaking) to)\b[^?.!]{0,40}\b(?:ai|a\.i\.|robot|bot|machine|automated|recorded|real person|real human|human)\b|\b(?:real person|real human)\b[^?.!]{0,20}\?/i;
const MONEY_QUESTION =
  /\b(?:how much|what(?:'s| is| are)? (?:your |the )?(?:price|pricing|rate|rates|cost|fee|commission)|what do you (?:charge|get)|what does it cost|per load|per mile|percentage|cut of)\b/i;
const SOURCE_QUESTION =
  /\b(?:where (?:did|do) you (?:get|find)|how did you (?:get|find)|who gave you|where'?d you get)\b[^?.!]{0,40}\b(?:number|info|information|details)\b|\b(?:is this|are you) (?:a )?(?:scam|spam|telemarketer|sales call)\b/i;
const DISPATCHER_STATEMENT =
  /\b(?:already|have|got|use)\s+(?:a|an|our own|our)\s+(?:dispatcher|dispatch service|dispatch company|dispatch team)\b|\bwe (?:do|handle|run) (?:our own )?dispatch\b|\bsomeone (?:already )?(?:does|handles) (?:our )?dispatch\b/i;
const CALLBACK_REQUEST =
  /\b(?:call|ring|phone)\s+(?:me|us)\s+back\b|\b(?:i'?m|i am)\s+(?:driving|on the road|behind the wheel|in the truck)\b|\bnot a good time\b|\bcan'?t talk (?:right )?now\b/i;
const MC_QUESTION =
  /\b(?:why (?:do )?(?:you|y'?all) (?:need|want)|what(?:'s| is) (?:the )?(?:reason for|need for)|why ask for)\b[^?.!]{0,40}\b(?:mc|dot|authority|number)\b|\bmc number\b[^?.!]{0,30}\b(?:why|needed|need it)\b/i;
const NOT_INTERESTED =
  /\b(?:not interested|no thanks|no thank you|don'?t (?:need|want) (?:it|that|any)|not (?:right )?now|we'?re good|we are good|no need)\b/i;
const EMAIL_REQUEST =
  /\b(?:send|email|e-mail)\b[^?.!]{0,30}\b(?:info|information|details|email|e-mail)\b|\bemail me\b|\bwhat'?s your email\b/i;

const INTENTS = [
  { id: "ai", test: AI_QUESTION },
  { id: "price", test: MONEY_QUESTION },
  { id: "source", test: SOURCE_QUESTION },
  { id: "dispatcher", test: DISPATCHER_STATEMENT },
  { id: "callback", test: CALLBACK_REQUEST },
  { id: "mc", test: MC_QUESTION },
  { id: "not-interested", test: NOT_INTERESTED },
  { id: "email", test: EMAIL_REQUEST },
];

function variants(intent, config) {
  const c = config || {};
  const company = String(c.companyName || "our company").trim() || "our company";
  switch (intent) {
    case "ai":
      return [
        `Yes, I'm an AI assistant calling for ${company}. A person from the team can take it from here.`,
        "I am - an AI calling on behalf of the team. I can have a person follow up with you.",
      ];
    case "price":
      /* The number is the one thing this layer must never produce: a fabricated
       * rate is repeated back as a quote. Answer the question honestly by saying
       * what the price depends on, then ask for the input that changes it. */
      return [
        "It depends on the lane and volume. What lanes do you run?",
        "Rates are set per load, so it depends on the lane. Where are you running?",
      ];
    case "source":
      /* Never name a data source the product cannot prove. "On file" is true
       * for every lead this dialer holds, and the removal offer is the part the
       * prospect is actually asking for. */
      return [
        "From the carrier contact details we have on file. If it's wrong, I'll remove you.",
        "It's the number on file for your carrier. Say the word and I'll take you off our list.",
      ];
    case "dispatcher":
      return [
        "Understood. Are you happy with the loads they find, or open to more?",
        "Fair enough. Are they keeping your trucks busy, or is there room for more?",
      ];
    case "callback":
      /* A driver is the one prospect who must not be kept on the line. Let them
       * go immediately and get a time, rather than starting a qualification. */
      return [
        "No problem - drive safe. What's a better time to call?",
        "Understood. I'll let you go - when should I call back?",
      ];
    case "mc":
      return [
        "It confirms you're an authorized carrier before we book anything. What's your MC?",
        "It's how we verify carriers before dispatch. Can you share your MC?",
      ];
    case "not-interested":
      /* A brush-off is usually reflexive, not a decision. Acknowledge it in a
       * few words and ask one question that re-opens the conversation - never
       * argue, and never repeat the pitch. */
      return [
        "Fair enough. Are you the one who handles dispatch there?",
        "No problem. Do you run your own trucks, or broker the freight?",
      ];
    case "email":
      return [
        "Happy to. What's the best address to send it to?",
        "Sure - I'll send it over. What's the best email?",
      ];
    default:
      return [];
  }
}

/* What a good rep asks next, one field at a time. Measured on the 1B model with
 * the state line alone, a fleet answer produced "Alex from Zaz Logistics"; with
 * a hint it asked, but once answered the volume question with "around 50
 * trucks" - a number nobody said. Qualification turns are therefore scripted:
 * the ack and the question are short, and nothing can be invented. */
function questionFor(field) {
  switch (fieldKind(field)) {
    case "lanes": return "Which lanes do you run most?";
    case "equipment": return "What equipment are you running?";
    case "volume": return "How many loads a week are you moving?";
    case "trucks": return "How many trucks are you running?";
    case "mc": return "What's your MC number?";
    case "name": return "Who am I speaking with?";
    case "email": return "What's the best email for you?";
    default: return `What's your ${String(field).toLowerCase()}?`;
  }
}

/* A complaint deserves to be heard before the next question, but it must not
 * turn into a defence of the company or a fabricated number. */
const NEGATIVE_RE = /\b(?:terrible|awful|horrible|worst|bad|low|high|expensive|cheap|slow|struggling|rough|hard)\b/i;

/* Returns { intent, text } when a turn can be answered without the model, or
 * null so the ordinary brain path handles the turn. */
function policyReply(lastLead, { config, history } = {}) {
  const heard = spokenText(lastLead);
  if (heard.length < 2) return null;
  for (const intent of INTENTS) {
    if (!intent.test.test(heard)) continue;
    const options = variants(intent.id, config);
    const already = new Set(agentMessages(history).map((m) => normalise(m.content)));
    const unused = options.find((line) => !already.has(normalise(line)));
    /* Every phrasing already used: let the model say something new rather than
     * repeating a line the prospect has now heard twice. */
    if (!unused) return null;
    return { intent: intent.id, text: unused };
  }

  /* Nothing decisive was asked, and the prospect just told us something while a
   * field is still missing: ask for it here, in a line that cannot invent a
   * number. A question gets answered by the model instead. The current line is
   * added to the analysis when the caller passed it separately from history. */
  const rows = Array.isArray(history) ? history.slice() : [];
  const lastRow = rows.length ? rows[rows.length - 1] : null;
  const sameTurn =
    lastRow &&
    (lastRow.role === "user" || lastRow.role === "lead" || lastRow.role === "prospect") &&
    normalise(lastRow.content) === normalise(heard);
  const effective = sameTurn ? rows : [...rows, { role: "user", content: heard }];
  const state = analyse(effective, config);
  if (state.pending.length && state.lastLead && !QUESTION_RE.test(state.lastLead) && !SMALL_TALK_RE.test(state.lastLead)) {
    const ack = NEGATIVE_RE.test(state.lastLead) ? "I hear you. " : "Got it. ";
    const text = ack + questionFor(state.pending[0]);
    const already = new Set(agentMessages(effective).map((m) => normalise(m.content)));
    if (!already.has(normalise(text))) return { intent: "qualify", text };
  }
  return null;
}

const REFUSAL_RE = /^(?:no|nope|nah|none|not sure|don'?t know|dont know|skip|never ?mind|not right now|maybe later|n\/a)\b/i;
/* A prospect asking us something must be answered, never used as a cue to ask
 * the next qualification question. */
const QUESTION_RE = /(?:^|[.!?]\s*)(?:who|what|when|where|why|how|do|does|did|can|could|would|will|are|is|am|should)\b|\?/i;
/* Turn-openers with no content: the model handles these; a qualification hint
 * would make the agent answer "okay" with a question about freight. */
const SMALL_TALK_RE = /^(?:hi|hello|hey|yeah|yes|yep|no|okay|ok|sure|right|alright|mm+|uh huh|go ahead|sounds good|good)(?:[, ]+(?:go ahead|got it|sounds good|that'?s fine|fine|thanks|thank you))*[.! ]*$/i;

/* The customer names their own fields ("weekly volume", "equipment"), so the
 * state has to understand the label rather than one fixed vocabulary. */
function fieldKind(field) {
  const key = String(field || "").toLowerCase();
  if (key.includes("lane") || key.includes("route")) return "lanes";
  if (key.includes("equipment") || key.includes("trailer") || key.includes("truck type")) return "equipment";
  if (key.includes("volume") || key.includes("load")) return "volume";
  if (key.includes("truck") || key.includes("fleet") || key.includes("unit")) return "trucks";
  if (key.includes("mc") || key.includes("dot") || key.includes("authority")) return "mc";
  if (key.includes("name")) return "name";
  if (key.includes("email")) return "email";
  return "other";
}

function askedByQuestion(field, question) {
  const q = String(question || "").toLowerCase();
  if (!q) return false;
  switch (fieldKind(field)) {
    case "lanes":
      return /\blanes?\b|\bwhere (?:are|do) you (?:run|haul)|\broutes?\b/.test(q);
    case "equipment":
      return /\bequipment\b|\btrailers?\b|what (?:kind|type) of (?:truck|trailer)/.test(q);
    case "volume":
      return /\bvolume\b|\bhow many loads\b|loads?\b[^?.!]{0,20}\b(?:week|month)|weekly\b/.test(q);
    case "trucks":
      return /\bhow many (?:trucks|units|trailers)\b|\bfleet size\b|\bhow big\b/.test(q);
    case "mc":
      return /\bmc\b|\bdot\b|\bauthority\b/.test(q);
    case "name":
      return /\byour name\b|\bwho am i (?:speaking|talking)\b/.test(q);
    case "email":
      return /\bemails?\b|\be-mail\b/.test(q);
    default:
      return false;
  }
}

/* Everything the state line and the qualification hint need, computed once. */
function analyse(history, config) {
  const leads = leadMessages(history);
  const agents = agentMessages(history);
  const told = leads.slice(-8).map(spokenText).join(" ");
  const askedText = agents.slice(-8).map(spokenText).join(" ");
  const fields = (Array.isArray(config && config.leadFields) ? config.leadFields : [])
    .map((f) => (typeof f === "string" ? f : f && (f.label || f.key)))
    .filter(Boolean);

  const facts = [];
  const trucks = told.match(/\b(\d{1,4})\s+(?:trucks?|units?|power units?|rigs?|trailers?)\b/i);
  if (trucks) facts.push(`${trucks[1]} trucks`);
  const equipment = told.match(
    /\b(dry van|reefer|refrigerated|flatbed|flat bed|step ?deck|tanker|box truck|power only|hotshot|hot shot|sprinter|cargo van|conestoga)\b/i,
  );
  if (equipment) facts.push(equipment[1].toLowerCase());
  const origin = told.match(/\b(?:out of|based in|located in)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/);
  if (origin) facts.push(`out of ${origin[1]}`);
  const volume = told.match(/\b(\d{1,4})\s+(?:loads?|hauls?|trips?)\s*(?:a|per|\/)?\s*(?:week|wk|month|mo)\b/i);
  if (volume) facts.push(`${volume[1]} loads a week`);

  const answered = {
    lanes: /\blanes?\b/i.test(told),
    equipment: !!equipment,
    volume: !!volume,
    trucks: !!trucks,
    mc: /\b(?:mc|dot)\s*(?:number|#)?\s*(?:is|:)?\s*\d{4,}/i.test(told),
  };

  /* "About twenty" is a complete answer to "how many loads a week?". No pattern
   * over that reply alone can know it, so a short reply to a question about a
   * field is treated as that field - the same rule qualification.js uses. */
  const lastLead = leads.length ? spokenText(leads[leads.length - 1]) : "";
  const lastAgent = agents.length ? spokenText(agents[agents.length - 1]) : "";
  if (
    lastLead &&
    lastLead.split(/\s+/).length <= 8 &&
    !REFUSAL_RE.test(lastLead) &&
    !QUESTION_RE.test(lastLead) &&
    /\?/.test(lastAgent)
  ) {
    for (const f of fields) if (askedByQuestion(f, lastAgent)) answered[fieldKind(f)] = true;
  }

  const asked = fields.filter((f) => !answered[fieldKind(f)] && askedByQuestion(f, askedText));
  const pending = fields.filter((f) => !answered[fieldKind(f)] && !asked.includes(f));
  return { leads, agents, fields, facts, asked, pending, lastLead };
}

/* What the offline model cannot work out for itself: which facts the prospect
 * has already given, and which questions have already been asked. The hosted
 * prompt gets this from qualification.js; the offline prompt had nothing, which
 * is why it kept re-asking for equipment and weekly volume. */
function conversationState(history, config) {
  const { facts, asked, pending } = analyse(history, config);
  const parts = [];
  if (facts.length) parts.push("Known: " + facts.join(", ") + ".");
  if (asked.length) parts.push("Already asked: " + asked.join(", ") + " - do not ask again.");
  if (pending.length) parts.push("Still needed: " + pending.join(", ") + ".");
  return parts.join(" ").slice(0, 220);
}

/* A trailing instruction, not part of the transcript. Measured on the 1B model:
 * with only the state line it answered a fleet answer with its own name; with
 * one "ask about X" line it asked for X. It is only added when the prospect
 * actually said something answerable - a question gets an answer, not our next
 * qualification question. */
function nextQuestionHint(history, config) {
  const { pending, lastLead } = analyse(history, config);
  if (!pending.length) return null;
  if (!lastLead || QUESTION_RE.test(lastLead) || SMALL_TALK_RE.test(lastLead)) return null;
  return `Ask about ${String(pending[0]).toLowerCase()} in one short question.`;
}

module.exports = { isInstruction, lastLeadLine, policyReply, conversationState, nextQuestionHint };
