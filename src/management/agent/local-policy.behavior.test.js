"use strict";

/* The offline sales policy: the few turns that decide a call, without a sampler.
 *
 * The 1B model is what makes a local call possible on this hardware. It is not
 * what should answer a price question or a brush-off. These tests pin the lines
 * that are spoken instead, and the state that stops the model re-asking what it
 * has already been told.
 */
const assert = require("node:assert/strict");
const { policyReply, conversationState, lastLeadLine, isInstruction, nextQuestionHint } = require("./local-policy");

const CONFIG = {
  companyName: "Zaz Logistics",
  product: "freight dispatch",
  persona: { name: "Alex" },
  leadFields: ["lanes", "equipment", "weekly volume"],
  locale: "en",
};

const money = /\$\s?\d|\b\d+(?:[.,]\d+)?\s*(?:dollars?|bucks|cents?|per\s+(?:load|mile|mileage|stop))\b/i;

function ask(said, history = []) {
  return policyReply(said, { config: CONFIG, history });
}

// 1. The decisive intents are recognised, and answered in one short turn.
const CASES = [
  ["How much do you charge per load?", "price", /lane/i],
  ["What's your rate per mile?", "price", /lane|running/i],
  ["I'm not interested, thanks.", "not-interested", /dispatch|trucks|broker/i],
  ["We already have a dispatcher.", "dispatcher", /loads|busy|room/i],
  ["I'm driving, call me back next week.", "callback", /drive|call back|better time/i],
  ["Where did you get my number?", "source", /file|remove|list/i],
  ["Why do you need my MC number?", "mc", /carrier|MC/i],
  ["Am I talking to a robot?", "ai", /AI assistant/i],
  ["Sounds good, send me an email.", "email", /email|address/i],
  ["We're a freight broker, we don't have any trucks.", "wrong-fit", /carrier|recommend/i],
  ["Let me check with my partner first.", "partner", /time|both|them/i],
  ["We tried a dispatcher before and it didn't work.", "past-dispatcher", /wrong|miss/i],
  ["What's in it for me?", "value", /loaded|paperwork|lanes|loads/i],
  ["What do you need from me?", "needs", /MC|trucks/i],
  ["That's too expensive for us.", "price-objection", /paying|cost/i],
  ["Who are you?", "identity", /Zaz Logistics|dispatch/i],
  ["Where are you based?", "location", /running|where/i],
  ["How does it work?", "how-it-works", /loads|paperwork|lanes/i],
  ["What's the minimum number of trucks?", "minimum", /how many trucks/i],
  ["Am I locked into a contract?", "contract", /time|terms/i],
  ["Can I try it first?", "contract", /time|terms/i],
  ["Let me think about it.", "think", /cleared up|need to know/i],
  ["We're happy with our current setup.", "dispatcher", /loads|busy|room/i],
  ["Are you legit?", "trust", /dispatch service|authority/i],
  ["How do you make money?", "model", /trucks move|book your freight|paid/i],
  ["What's your cut?", "model", /trucks move|book your freight|paid/i],
  ["Do you guarantee loads?", "guarantee", /guarantee|busy/i],
  ["What's the catch?", "catch", /catch|fit/i],
  ["I'm just the driver.", "referral", /who handles|right person/i],
  ["How soon can you start?", "start", /lanes|MC|week/i],
  ["Can you text me the details?", "text", /number/i],
];
for (const [said, intent, shape] of CASES) {
  const r = ask(said);
  assert.ok(r, `"${said}" must be a policy turn`);
  assert.equal(r.intent, intent, `"${said}" was classified as ${r.intent}`);
  assert.match(r.text, shape, `"${said}" must be answered usefully, got: ${r.text}`);
  assert.doesNotMatch(r.text, money, `"${said}" must never invent a figure, got: ${r.text}`);
  assert.doesNotMatch(
    r.text,
    /rather than guess|let me note it|for the team to follow up|as an ai|i don'?t have access/i,
    `"${said}" must never answer with a meta disclaimer, got: ${r.text}`,
  );
  assert.ok(r.text.split(/\s+/).length <= 24, `"${said}" must stay short, got: ${r.text}`);
  assert.ok((r.text.match(/\?/g) || []).length <= 1, `"${said}" must ask at most one question, got: ${r.text}`);
}

// 2. The exact "Who is this?" shape belongs to the call runner, which answers
//    it from the config before the brain is asked. Policy answers the shapes
//    that actually reach the brain ("Who are you?", "Which company is this?")
//    and must not duplicate the call runner's list.
assert.equal(ask("Who is this?"), null, "the call runner owns the exact who-is-this shape");
assert.equal(ask("Which company is this?").intent, "identity", "the brain's identity shapes must still be answered");
assert.equal(ask("Okay, go ahead."), null, "ordinary conversation must reach the model");
assert.equal(ask("Don't text me again."), null, "a do-not-text request must never become a request for a number");

// 2b. A fact-giving turn moves the checklist on with a scripted question: no
//     model load, no chance of "Alex from Zaz Logistics" or "around 50 trucks".
const qualified = ask("We run dry van out of Chicago, about 20 trucks.");
assert.equal(qualified.intent, "qualify", "a fleet answer must qualify");
assert.match(qualified.text, /^Got it\. Which lanes do you run most\?$/, "ask the next missing field: " + qualified.text);
const complaint = ask("Rates are terrible this year.");
assert.equal(complaint.intent, "qualify");
assert.match(complaint.text, /^I hear you\. /, "a complaint is acknowledged before the next question: " + complaint.text);
assert.equal(ask("Do you cover reefer loads?"), null, "an ordinary question must reach the model, not become a checklist");
assert.equal(ask("How does the dispatch work?").intent, "how-it-works", "how-it-works is a decisive policy turn");
// A completed checklist moves to the close instead of asking another
// qualification question the prospect has already answered.
const closed = ask("We run dry van lanes out of Chicago, about 20 loads a week, 20 trucks.");
assert.equal(closed.intent, "close", "a complete checklist must move to the close: " + JSON.stringify(closed));
assert.match(closed.text, /time|number/i, "the close must ask for an appointment: " + closed.text);
assert.doesNotMatch(closed.text, /which lanes|how many|what equipment/i, "the close must not re-qualify: " + closed.text);
assert.doesNotMatch(
  closed.text,
  /(?:\bi'?ll|\bwe'?ll|\bi will|\bwe will)\s+(?:call|ring|phone)\s+(?:you|back)/i,
  "the close must ask for a time, not promise a callback: " + closed.text,
);
// A broker is disqualified before the brush-off is read as an objection.
assert.equal(
  ask("We're a broker and we're not interested.").intent,
  "wrong-fit",
  "disqualification must outrank the brush-off",
);
// A short answer that completes a one-field checklist can close immediately.
const minimal = { ...CONFIG, leadFields: ["lanes"] };
const closedEarly = policyReply("Chicago to Indianapolis", {
  config: minimal,
  history: [{ role: "assistant", content: "Which lanes do you run most?" }],
});
assert.equal(closedEarly.intent, "close", "a completed checklist must close even on a short answer");
// Small talk and questions are never read as a cue to close.
assert.equal(policyReply("Okay, sounds good.", { config: minimal, history: [] }), null, "small talk must reach the model");
assert.equal(
  policyReply("What do you charge per load?", { config: minimal, history: [] }).intent,
  "price",
  "a price question must stay with the price intent, not become a close",
);

// 2c. The live lead sheet has phone, notes and an empty-where column. Those are
//     already in the record and cannot be asked on a call; they must neither be
//     spoken as questions nor keep the checklist open forever.
const LIVE_FIELDS = ["NAME", "MC NUMBER", "PHONE NUMBER", "TEXT REQUEST", "TRUCK TYPE", "TRUCK SIZE", "EMPTY WHERE AND WHEN"];
const live = { ...CONFIG, leadFields: LIVE_FIELDS };
const liveEmpty = conversationState([], live);
assert.match(liveEmpty, /Still needed: NAME, MC NUMBER, TRUCK TYPE, TRUCK SIZE\./, "only askable fields belong in the checklist: " + liveEmpty);
assert.doesNotMatch(liveEmpty, /PHONE|TEXT REQUEST|EMPTY WHERE/i, "lead-only columns must never be asked: " + liveEmpty);
const liveHistory = [
  { role: "assistant", content: "Who am I speaking with?" },
  { role: "user", content: "Mike." },
  { role: "assistant", content: "Thanks Mike. What's your MC number?" },
  { role: "user", content: "MC 123456." },
  { role: "assistant", content: "Got it. What equipment are you running?" },
  { role: "user", content: "Dry van." },
  { role: "assistant", content: "And how many trucks are you running?" },
  { role: "user", content: "Twelve trucks." },
];
const liveClose = policyReply("Twelve trucks.", { config: live, history: liveHistory });
assert.equal(liveClose.intent, "close", "the live checklist must be closable: " + JSON.stringify(liveClose));
assert.match(liveClose.text, /time|number/i, "the live close must ask for an appointment: " + liveClose.text);

// 3. A phrase already spoken is not said twice. The second turn gets the other
//    phrasing; once both are spent the model is asked for something new.
const first = ask("I'm not interested, thanks.");
const second = ask("I'm not interested.", [
  { role: "assistant", content: first.text },
]);
assert.ok(second, "a second brush-off must still be answered");
assert.notEqual(second.text, first.text, "the same line must not be repeated");
const third = ask("Still not interested.", [
  { role: "assistant", content: first.text },
  { role: "assistant", content: second.text },
]);
assert.equal(third, null, "with every variant spent, fall through to the model instead of repeating");

// The close is asked once. If the prospect answers the appointment question,
// the next turn belongs to the conversation, not to a second scripted ask.
const closeOne = ask("We run dry van lanes out of Chicago, about 20 loads a week, 20 trucks.");
assert.equal(closeOne.intent, "close");
assert.equal(
  ask("Tuesday at two works.", [
    { role: "user", content: "We run dry van lanes out of Chicago, about 20 loads a week, 20 trucks." },
    { role: "assistant", content: closeOne.text },
  ]),
  null,
  "the close must not be asked twice",
);

// 4. Our own instructions are not mistaken for something the prospect said.
assert.equal(isInstruction("ALREADY COLLECTED: equipment=dry van"), true);
assert.equal(isInstruction("You just tried to ask: \"What lanes?\""), true);
assert.equal(isInstruction("We run dry van out of Chicago."), false);
assert.equal(
  lastLeadLine([
    { role: "user", content: "How much do you charge per load?" },
    { role: "user", content: "ALREADY COLLECTED: none. STILL NEEDED: lanes. Ask for exactly ONE item." },
  ]),
  "How much do you charge per load?",
  "an injected checklist must not be read as the prospect's line",
);

// 5. The state line tells the model what is known and what is still missing.
const state = conversationState(
  [
    { role: "assistant", content: "Hi, this is Alex from Zaz Logistics. How many lanes do you run?" },
    { role: "user", content: "We run dry van out of Chicago, about 20 trucks." },
  ],
  CONFIG,
);
assert.match(state, /Known: 20 trucks, dry van, out of Chicago/, "the facts must travel: " + state);
assert.match(state, /Already asked: lanes - do not ask again/, "an answered question must not be asked again: " + state);
assert.match(state, /Still needed: weekly volume/, "only the missing field may be asked: " + state);

// A prospect who has answered everything leaves no question to ask.
const complete = conversationState(
  [
    { role: "user", content: "We run dry van lanes out of Chicago to Indianapolis, about 20 loads a week, 20 trucks." },
  ],
  CONFIG,
);
assert.doesNotMatch(complete, /Still needed/, "nothing is still needed when every field is answered: " + complete);
assert.match(complete, /20 loads a week/, "weekly volume must be recognised: " + complete);

// 6. A fact-giving turn gets a direct instruction for the next missing field,
//    because the 1B answered "we run 20 trucks" with its own name otherwise.
assert.equal(
  nextQuestionHint(
    [
      { role: "assistant", content: "Do you have a minute?" },
      { role: "user", content: "We run dry van out of Chicago, about 20 trucks." },
    ],
    CONFIG,
  ),
  "Ask about lanes in one short question.",
  "a fleet answer must move the checklist on",
);
// A question from the prospect must be answered, not deflected into the checklist.
assert.equal(
  nextQuestionHint(
    [
      { role: "assistant", content: "We dispatch freight for carriers." },
      { role: "user", content: "What do you need from me?" },
    ],
    CONFIG,
  ),
  null,
  "a prospect's question must not become our next qualification question",
);
// Nothing left to ask means no instruction.
assert.equal(
  nextQuestionHint(
    [{ role: "user", content: "We run dry van lanes out of Chicago, about 20 loads a week, 20 trucks." }],
    CONFIG,
  ),
  null,
  "a complete checklist must not keep asking",
);

// 7. The state stays small enough to prefill on two cores.
assert.ok(state.length <= 220, "the state line must stay compact, got " + state.length);

console.log("PASS: the offline brain answers the decisive sales turns without inventing a rate or repeating itself");
