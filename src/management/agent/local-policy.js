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
  /\b(?:already|have|got|use)\s+(?:a|an|our own|our)\s+(?:dispatcher|dispatch service|dispatch company|dispatch team)\b|\bwe (?:do|handle|run) (?:our own )?dispatch\b|\bsomeone (?:already )?(?:does|handles) (?:our )?dispatch\b|\b(?:happy|satisfied|fine) with (?:our|my|the) (?:current |existing )?(?:dispatcher|dispatch|setup|service)\b/i;
const CALLBACK_REQUEST =
  /\b(?:call|ring|phone)\s+(?:me|us)\s+back\b|\b(?:i'?m|i am)\s+(?:driving|on the road|behind the wheel|in the truck)\b|\bnot a good time\b|\bcan'?t talk (?:right )?now\b/i;
const MC_QUESTION =
  /\b(?:why (?:do )?(?:you|y'?all) (?:need|want)|what(?:'s| is) (?:the )?(?:reason for|need for)|why ask for)\b[^?.!]{0,40}\b(?:mc|dot|authority|number)\b|\bmc number\b[^?.!]{0,30}\b(?:why|needed|need it)\b/i;
/* A broker or a company with no trucks is not a lead. Disqualifying fast is a
 * sales skill: it protects the prospect's time and leaves the door open for a
 * referral instead of arguing. */
const WRONG_FIT =
  /\b(?:we(?:'re| are) (?:a |an )?(?:freight )?broker|we (?:don'?t|do not) (?:have|own) (?:any )?(?:trucks?|equipment)|no trucks|we broker|brokerage)\b/i;
const PARTNER_CHECK =
  /\b(?:talk to|check with|ask|run it by|speak with)\b[^?.!]{0,35}\b(?:partner|boss|wife|husband|manager|owner|team)\b|\b(?:my|our) (?:partner|boss|manager|wife|husband) (?:handles|decides|is)\b/i;
const PAST_DISPATCH =
  /\b(?:tried|used|had)\b[^?.!]{0,25}\b(?:dispatcher|dispatch (?:service|company))\b[^?.!]{0,25}\b(?:before|and it|but)\b|\b(?:last|previous) dispatcher\b|\bdispatcher (?:didn'?t|did not) work\b/i;
const VALUE_QUESTION =
  /\b(?:what'?s in it for me|why should i|what do i get|how (?:does|would) (?:this|that|it) help|what'?s the benefit)\b/i;
/* "What do you need from me?" is the most co-operative thing a prospect says.
 * It deserves the smallest possible next step, not a feature list. */
const NEEDS_QUESTION =
  /\bwhat (?:do|would) you (?:need|want) (?:from (?:me|us)|to know|to get started)\b|\bwhat (?:info|information|details) (?:do you need|are you after)\b|\bwhat do you need\b/i;
const NOT_INTERESTED =
  /\b(?:not interested|no thanks|no thank you|don'?t (?:need|want) (?:it|that|any)|not (?:right )?now|we'?re good|we are good|no need)\b/i;
const EMAIL_REQUEST =
  /\b(?:send|email|e-mail)\b[^?.!]{0,30}\b(?:info|information|details|email|e-mail)\b|\bemail me\b|\bwhat'?s your email\b/i;
/* "Who are you?" is the one answer the 1B model most often gets wrong (it
 * introduces itself as the prospect). The exact "who is this / what's your
 * name" phrasings are answered earlier by call-runner's WHO_IS_THIS_RE, so they
 * are deliberately not repeated here; these are the shapes that reach the
 * brain. */
const IDENTITY_QUESTION =
  /\bwho are you\b|\b(?:which|what) company (?:is (?:this|it)|are you (?:with|from))\b|\bwho do you (?:work for|represent)\b/i;
/* Location is answered honestly without naming a city the model would have to
 * invent; the coverage answer is the one a dispatcher gives. */
const LOCATION_QUESTION =
  /\bwhere (?:are|is) (?:you|your company) (?:based|located|from)\b|\bwhere are you (?:guys )?(?:at|located)\b/i;
/* "How does it work" deserves the three things dispatch actually does, not a
 * feature list and not a rate the model invented. */
const HOW_IT_WORKS =
  /\bhow (?:does|do) (?:it|this|that|you|(?:the |your )?(?:service|process|dispatch)) work\b|\bwhat (?:do|does) (?:you|your (?:service|company)) (?:actually )?do\b/i;
/* An objection is not a price question. "Too expensive" is answered with a
 * question about what they pay now, never with a number of ours. */
const PRICE_OBJECTION =
  /\b(?:too|really|very|so|pretty) (?:expensive|pricey|much|costly)\b|\bthat'?s (?:a lot|steep|too much|pricey|expensive)\b|\bcan'?t afford\b|\bout of (?:my|our) budget\b/i;
const CONTRACT_QUESTION =
  /\b(?:contract|commitment|lock(?:ed)? in|minimum term|cancel anytime|tie me down)\b|\bsign (?:anything|a contract|paperwork)\b|\b(?:free )?trial(?: period)?\b|\btry (?:it|you) (?:out|first)\b/i;
const THINK_ABOUT_IT =
  /\b(?:need to|let me|i'?ll|gonna|going to) think (?:about it|it over|on it)\b|\bthink (?:about it|it over)\b/i;
const FLEET_MINIMUM =
  /\b(?:what'?s the minimum|is there a minimum|minimum (?:fleet|number of trucks|trucks)|smallest fleet|do you (?:guys )?work with (?:owner[- ]operators?|single trucks?|one truck)|how many trucks do you (?:need|require|want))\b/i;
/* Off-book questions are the ones no script anticipated. They still have
 * truthful, useful answers, and answering them here keeps the 1B model from
 * either guessing or deflecting with a question. */
const TRUST_QUESTION =
  /\b(?:are you|is this) (?:a )?(?:legit(?:imate)?|real (?:company|business)|insured|bonded|registered)\b|\bhow do i know (?:you'?re|this is) (?:legit|real|not a scam)\b/i;
/* "How do you make money?" is not a rate request; it is the prospect testing
 * whether there is a hidden cost. Say the model plainly, with no figure. */
const MODEL_QUESTION =
  /\bhow do you (?:make (?:your )?money|get paid|earn)\b|\bwhat'?s your cut\b|\bwhere does your money come from\b|\bdo you charge (?:me|us) (?:upfront|monthly|a monthly)\b/i;
const GUARANTEE_QUESTION =
  /\b(?:do you|can you) guarantee\b|\bguaranteed (?:loads?|freight|work)\b|\bhow do i know (?:i'?ll|we'?ll) (?:get|have) (?:loads?|freight|work)\b/i;
const CATCH_QUESTION =
  /\bwhat'?s the catch\b|\bwhere'?s the catch\b|\btoo good to be true\b|\bwhat'?s the downside\b/i;
/* "I'm just the driver" is a referral, not a brush-off: the useful move is to
 * ask who does decide, which also respects that they cannot. */
const REFERRAL =
  /\bi'?m (?:just|only) (?:the |a )?driver\b|\bnot (?:the )?(?:right|correct) person\b|\bi don'?t (?:handle|deal with|make) (?:that|this|those|dispatch)\b|\b(?:that'?s|it'?s) (?:my|the) (?:boss|owner|partner)'?s? (?:job|call|decision)\b/i;
const START_QUESTION =
  /\b(?:how soon|how quickly|how fast|when) can (?:you|we|the team) (?:start|begin|get started)\b|\bcan (?:you|we) start (?:this|next) week\b/i;
/* Anchored so "don't text me" is a refusal, never a request for a number. */
const TEXT_REQUEST =
  /(?:^|[.!?]\s*)(?:(?:can|could|would) you |please |just |you can )?(?:text me|send (?:me )?a text|shoot me a text)\b/i;
/* A channel refusal is the call runner's to close; policy must not turn it
 * into a qualification question. */
const NO_CONTACT = /\b(?:don'?t|do not|stop) (?:text|texting|message|messaging)\b/i;

const INTENTS = [
  /* Disqualifying beats every other intent: a broker with no trucks must not be
   * qualified or pitched, however the sentence is phrased. */
  { id: "wrong-fit", test: WRONG_FIT },
  { id: "ai", test: AI_QUESTION },
  { id: "trust", test: TRUST_QUESTION },
  { id: "model", test: MODEL_QUESTION },
  { id: "price", test: MONEY_QUESTION },
  { id: "price-objection", test: PRICE_OBJECTION },
  { id: "source", test: SOURCE_QUESTION },
  { id: "identity", test: IDENTITY_QUESTION },
  { id: "location", test: LOCATION_QUESTION },
  { id: "how-it-works", test: HOW_IT_WORKS },
  { id: "value", test: VALUE_QUESTION },
  { id: "guarantee", test: GUARANTEE_QUESTION },
  { id: "catch", test: CATCH_QUESTION },
  { id: "needs", test: NEEDS_QUESTION },
  { id: "start", test: START_QUESTION },
  /* "We used a dispatcher before and it didn't work" is not the same as "we
   * already have one". It is a reason to ask what went wrong, not to concede. */
  { id: "past-dispatcher", test: PAST_DISPATCH },
  { id: "dispatcher", test: DISPATCHER_STATEMENT },
  { id: "partner", test: PARTNER_CHECK },
  { id: "referral", test: REFERRAL },
  { id: "callback", test: CALLBACK_REQUEST },
  { id: "mc", test: MC_QUESTION },
  { id: "minimum", test: FLEET_MINIMUM },
  { id: "contract", test: CONTRACT_QUESTION },
  { id: "think", test: THINK_ABOUT_IT },
  { id: "not-interested", test: NOT_INTERESTED },
  { id: "text", test: TEXT_REQUEST },
  { id: "email", test: EMAIL_REQUEST },
];

function variants(intent, config) {
  const c = config || {};
  const company = String(c.companyName || "our company").trim() || "our company";
  const name = String((c.persona && c.persona.name) || c.agentName || "Alex").trim() || "Alex";
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
    case "price-objection":
      /* "That's too expensive" is an objection, not a request for a rate. The
       * only honest move is to ask what they pay now - never to defend a price
       * or invent one. */
      return [
        "Fair. What are you paying per load now?",
        "I hear you. What does your current dispatch cost you?",
      ];
    case "trust":
      /* A trust question is not an accusation. Say what we are - a dispatch
       * service, not a carrier - because that is the reassurance that is true. */
      return [
        "Fair question. We're a dispatch service, not a carrier, so your authority stays yours. What are you running?",
        "We're a dispatch service, not a carrier - your authority and insurance stay yours. What are you running?",
      ];
    case "model":
      /* No percentage, no monthly figure: the shape of the deal, in one line. */
      return [
        "We only make money when your trucks move. What are you running now?",
        "We get paid when we book your freight, not before. Where are you running?",
      ];
    case "identity":
      return [
        `This is ${name} with ${company}. We handle dispatch for carriers - do you run your own trucks?`,
        `It's ${name} from ${company}. We book freight for carriers. Do you run your own trucks?`,
      ];
    case "location":
      return [
        "We work with carriers wherever they run. Where are you running out of?",
        "We're not tied to one state. Where are you running out of?",
      ];
    case "how-it-works":
      /* Three things dispatch actually does, then the next qualification
       * question. No rate, no promised load count. */
      return [
        "We find the loads, negotiate the rate and handle the paperwork - you just drive. What lanes do you run?",
        "You tell us your lanes and equipment; we book the freight and handle the paperwork. Where are you running?",
      ];
    case "guarantee":
      /* The honest answer is no, and saying it plainly builds more trust than
       * a promise the business cannot keep. */
      return [
        "Nobody can guarantee loads. We work your lanes hard to keep your truck busy. What are you running?",
        "No one honest guarantees freight. We keep your truck busy by working your lanes. What equipment do you run?",
      ];
    case "catch":
      return [
        "No catch. If it's not a fit, we shake hands and part friendly. What are you running?",
        "There's no catch. If it's not a fit, we part friendly. Where are you running?",
      ];
    case "minimum":
      /* Never promise a fleet size this business may not serve; ask for the
       * number and decide from the answer. */
      return [
        "Tell me how many trucks you run and I'll say whether it's a fit. How many are you running?",
        "How many trucks are you running? I'll make sure it's a fit.",
      ];
    case "contract":
      return [
        "That's a fair question for the team. When's a good time to talk it through?",
        "The team can walk you through the terms. What's the best time to call?",
      ];
    case "think":
      /* "Let me think about it" is a soft no. Asking for the one open question
       * is what reopens it; repeating the pitch is what ends the call. */
      return [
        "Of course. What's the one thing you'd want cleared up?",
        "Makes sense. What would you need to know to feel good about it?",
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
    case "text":
      return [
        "Sure - what's the best number to text?",
        "Happy to. What number should I use?",
      ];
    case "email":
      return [
        "Happy to. What's the best address to send it to?",
        "Sure - I'll send it over. What's the best email?",
      ];
    case "wrong-fit":
      /* No trucks means no lead. Ending the pitch quickly and asking for a
       * referral is the honest move, and it is the one a broker remembers. */
      return [
        "Understood - you're on the brokerage side. Is there a carrier you'd point us to?",
        "Got it, no trucks on your side. Anyone you'd recommend we talk to?",
      ];
    case "partner":
      /* The decision-maker is not on the line. Ask for a time instead of
       * pitching the person who cannot say yes. */
      return [
        "Of course. When's a good time to catch you both?",
        "Makes sense. What's the best time to talk it through with them?",
      ];
    case "referral":
      /* They cannot decide. Asking who can is the only useful next step. */
      return [
        "No problem - who handles dispatch there?",
        "Understood. Who's the right person to talk to?",
      ];
    case "past-dispatcher":
      /* A past failure is the most useful thing a prospect can tell us, and one
       * question about it does more than any feature list. */
      return [
        "That's fair. What went wrong with the last one?",
        "I understand. What did they miss that you needed?",
      ];
    case "value":
      /* "What's in it for me" deserves the outcome, not a feature list. */
      return [
        "Your trucks stay loaded and the paperwork is handled. What lanes do you run?",
        "You get more loads without chasing brokers. Where are you running now?",
      ];
    case "needs":
      /* The co-operative question gets the smallest next step, and asking for
       * the MC here is what a rep would do. */
      return [
        "Just your MC and how many trucks you run. What's your MC?",
        "Two things - your MC and your truck count. Can I get your MC?",
      ];
    case "start":
      return [
        "Quickly. The team starts with your lanes and MC. What are you running this week?",
        "As soon as your lanes and MC are in hand. What are you running this week?",
      ];
    case "close":
      /* The checklist is done. A rep asks for the appointment here, not for one
       * more data point - and the line asks for a time rather than promising a
       * callback the dialer cannot guarantee. One phrasing only: asking for the
       * appointment twice sounds like a machine. */
      return ["Great. What's the best time and number to reach you?"];
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

  /* "Don't text me" is a refusal, not a fact to qualify on. The call runner
   * closes the call; falling through here asks nothing. */
  if (NO_CONTACT.test(heard)) return null;

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
  /* A prospect asking us something must be answered by the model, and a
   * two-word "okay" is not a cue to jump to the close. */
  if (!state.lastLead || QUESTION_RE.test(state.lastLead) || SMALL_TALK_RE.test(state.lastLead)) return null;

  if (state.pending.length) {
    const ack = NEGATIVE_RE.test(state.lastLead) ? "I hear you. " : "Got it. ";
    const text = ack + questionFor(state.pending[0]);
    const already = new Set(agentMessages(effective).map((m) => normalise(m.content)));
    if (!already.has(normalise(text))) return { intent: "qualify", text };
    return null;
  }

  /* The checklist is complete and the prospect has actually told us something:
   * ask for the appointment. Without this the local brain either invents a
   * closing line or keeps qualifying somebody who has answered everything.
   * Asked once: repeating it after the prospect answers sounds like a machine,
   * so a second closing turn goes to the model instead. */
  if (!state.evidence) return null;
  const closeAlready = new Set(agentMessages(effective).map((m) => normalise(m.content)));
  const closeLines = variants("close", config);
  if (closeLines.some((line) => closeAlready.has(normalise(line)))) return null;
  return closeLines.length ? { intent: "close", text: closeLines[0] } : null;
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
  /* Fields the lead record already carries, or that cannot be asked in one
   * short sentence. Leaving them in the checklist is how the live config would
   * have asked a prospect "What's your text request?" and never closed. */
  if (key.includes("phone") || key.includes("telephone") || key.includes("mobile")) return "phone";
  if (key.includes("request") || key.includes("note") || key.includes("comment")) return "note";
  if (key.includes("where") || key.includes("location") || key.includes("city") || key.includes("pickup") || key.includes("empty")) return "location";
  return "other";
}

const LEAD_ONLY = new Set(["phone", "note", "location"]);

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
    .filter(Boolean)
    /* Phone, the customer's own note fields and the empty-where column are
     * already in the lead record. They cannot be asked in a phone call, and on
     * the live config they kept the checklist permanently open. */
    .filter((f) => !LEAD_ONLY.has(fieldKind(f)));

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
  /* Somebody has actually answered something, as opposed to the line simply
   * having been silent or small-talked. Only then is a close earned. */
  const evidence = facts.length > 0 || Object.values(answered).some(Boolean);
  return { leads, agents, fields, facts, asked, pending, lastLead, evidence };
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
