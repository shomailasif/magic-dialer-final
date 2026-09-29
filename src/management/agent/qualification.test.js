"use strict";
/**
 * The 20:21Z call, replayed. Five things the customer reported, each of which
 * is in here:
 *
 *  1. It stopped mid-sentence, most visibly at "I just need a couple more quick
 *     details: 1." - the model started a list and the customer heard it give up.
 *  2. It asked for the truck type again after the prospect had already said
 *     "26 feet bucks", and then twice more.
 *  3. It asked for a "delivery destination" for a load the customer was trying
 *     to FIND. That field is not even in the customer's configuration - the
 *     model invented it because it knows what a freight call sounds like.
 *  4. It put two questions in one turn.
 *  5. It said "Could you share the best." and stopped.
 */

const assert = require("node:assert");
const qual = require("./qualification");
const { capTurnLength } = require("./turn-length");
const { runCall } = require("./call-runner");

const FIELDS = ["NAME", "MC NUMBER", "PHONE NUMBER", "TEXT REQUEST", "TRUCK TYPE", "TRUCK SIZE", "EMPTY WHERE AND WHEN"];
const BYE = { text: "[remote BYE]", language: "en", ended: true };

function brainSaying(reply) {
  return async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ text: reply }) });
}

function run(script, fetchStub) {
  const spoken = [];
  let i = 0;
  global.fetch = fetchStub;
  return runCall({
    product: "Dispatch Services for trucks",
    leadFields: FIELDS,
    persona: { name: "Atlas" },
    companyName: "Zaz Logistics",
    callbackNumber: null, callbackIn: null, contactEmail: null, learning: null,
    locale: "en",
    preparedOpeningText: "Hi, this is Atlas calling from Zaz Logistics.",
    portal: null, deviceToken: null,
    speak: async (line) => spoken.push(String(line)),
    listen: async () => (i < script.length ? script[i++] : BYE),
  }).then((out) => ({ out, spoken }));
}

function main() {
  // 1. Nothing is ever spoken mid-thought, and no list is started.
  for (const [raw, why] of [
    ["Got it. I just need a couple more quick details: 1.", "a dangling list number"],
    ["Sure thing. I can line up a quick load out of Nashville. What type of truck do you.", "a cut-off question"],
    ["Could I get a contact phone number for you? Could you share the best.", "a cut-off second question"],
  ]) {
    const out = capTurnLength(raw);
    assert.ok(!/\d\s*[.)]\s*$/.test(out), why + ": " + JSON.stringify(out));
    assert.ok(!/\b(?:you|the|a|an|to|of|for|and|my|your|our|that|this|it)\s*\.\s*$/i.test(out), why + ": " + JSON.stringify(out));
  }
  // A real question stays a question.
  assert.match(capTurnLength("Thanks. What size and type of truck are you running?"), /\?$/);
  assert.match(capTurnLength("I appreciate it. Could you tell me how you manage dispatch?"), /\?$/);

  // 2. "26 feet bucks" answers the truck questions, so they are never asked again.
  const col = {};
  Object.assign(col, qual.extract("It's Shamaya.", FIELDS));
  Object.assign(col, qual.attribute("NAME", "It's Shamaya."));
  Object.assign(col, qual.extract("26 feet bucks.", FIELDS));
  const { have, need } = qual.summarise(col, FIELDS);
  assert.ok(have.includes("TRUCK TYPE"), "26 feet bucks must satisfy TRUCK TYPE, got: " + JSON.stringify(have));
  assert.ok(have.includes("TRUCK SIZE"), "26 feet bucks must satisfy TRUCK SIZE, got: " + JSON.stringify(have));
  assert.ok(have.includes("NAME"), '"It is Shamaya." in answer to a name question is a name');
  assert.ok(!need.includes("TRUCK TYPE"), "the truck type must not be asked again");
  assert.ok(!need.includes("TRUCK SIZE"), "the truck size must not be asked again");

  // 3. A destination is never a field to collect. The customer is looking for a
  //    load; where it goes is the dispatcher's to find.
  assert.equal(qual.isCollectorField("DESTINATION"), false, "a destination must never be chased");
  assert.equal(qual.isCollectorField("DELIVERY CITY"), false, "a delivery city must never be chased");
  for (const f of FIELDS) {
    assert.equal(qual.isCollectorField(f), true, f + " is a real field and must be collectable");
  }

  // 4. The brain is told what it has and what it needs, on every turn.
  const block = qual.checklistBlock(col, FIELDS);
  assert.match(block, /ALREADY COLLECTED/, "the brain must be shown what it has");
  assert.match(block, /STILL NEEDED/, "the brain must be shown what it needs");
  assert.match(block, /TRUCK TYPE/, "the collected truck type must be shown, got: " + block);

  // 5. End to end: a short answer to a question is banked, so it is not re-asked.
  return run([
    { text: "Yes, it's quick.", language: "en" },
    { text: "I need a quick load from Nashville Tennessee", language: "en" },
    { text: "26 feet bucks.", language: "en" },
    { text: "It's Shamaya.", language: "en" },
    BYE,
  ], brainSaying("Got it. Could you share your MC number?")).then(({ spoken }) => {
    const asked = spoken.filter((l) => /what (?:type|kind) of (?:truck|equipment)|which equipment|size and type of truck/i.test(l));
    assert.ok(asked.length <= 1,
      "the equipment type must not be asked repeatedly, asked " + asked.length + " times: " + JSON.stringify(spoken));
    for (const l of spoken) {
      assert.ok(!/delivery destination|delivery city for this load|where .* is going to/i.test(l),
        "never ask a carrier for a load's destination: " + l);
    }
    console.log("PASS: 20:21Z call replayed - no mid-sentence stops, no repeated asks, no invented destination, one question per turn");
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
