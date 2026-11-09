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
];
for (const [said, intent, shape] of CASES) {
  const r = ask(said);
  assert.ok(r, `"${said}" must be a policy turn`);
  assert.equal(r.intent, intent, `"${said}" was classified as ${r.intent}`);
  assert.match(r.text, shape, `"${said}" must be answered usefully, got: ${r.text}`);
  assert.doesNotMatch(r.text, money, `"${said}" must never invent a figure, got: ${r.text}`);
  assert.ok(r.text.split(/\s+/).length <= 24, `"${said}" must stay short, got: ${r.text}`);
  assert.ok((r.text.match(/\?/g) || []).length <= 1, `"${said}" must ask at most one question, got: ${r.text}`);
}

// 2. "Who is this?" belongs to the call runner, which already answers it from
//    the config before the brain is asked. Policy must not duplicate that.
assert.equal(ask("Who is this?"), null, "the identity question is not a policy turn");
assert.equal(ask("Okay, go ahead."), null, "ordinary conversation must reach the model");

// 2b. A fact-giving turn moves the checklist on with a scripted question: no
//     model load, no chance of "Alex from Zaz Logistics" or "around 50 trucks".
const qualified = ask("We run dry van out of Chicago, about 20 trucks.");
assert.equal(qualified.intent, "qualify", "a fleet answer must qualify");
assert.match(qualified.text, /^Got it\. Which lanes do you run most\?$/, "ask the next missing field: " + qualified.text);
const complaint = ask("Rates are terrible this year.");
assert.equal(complaint.intent, "qualify");
assert.match(complaint.text, /^I hear you\. /, "a complaint is acknowledged before the next question: " + complaint.text);
assert.equal(ask("How does the dispatch work?"), null, "a question must be answered by the model, not turned into a checklist");
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

// The close has two phrasings and is spent the same way, so a long call cannot
// end with the same sentence three times.
const closeOne = ask("We run dry van lanes out of Chicago, about 20 loads a week, 20 trucks.");
const closeTwo = ask("We run dry van lanes out of Chicago, about 20 loads a week, 20 trucks.", [
  { role: "assistant", content: closeOne.text },
]);
assert.ok(closeTwo, "a second completed-checklist turn must still close");
assert.notEqual(closeTwo.text, closeOne.text, "the close must not be repeated verbatim");
assert.equal(
  ask("We run dry van lanes out of Chicago, about 20 loads a week, 20 trucks.", [
    { role: "assistant", content: closeOne.text },
    { role: "assistant", content: closeTwo.text },
  ]),
  null,
  "with both closes spent, fall through to the model",
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
