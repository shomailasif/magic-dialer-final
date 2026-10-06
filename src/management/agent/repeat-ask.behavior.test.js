"use strict";

// Bug 2 from CHECKPOINT.md: the same question asked three times.
//
//   "What type of truck do you operate?"
//   "what kind of truck you operate?"
//   "What type of truck do you operate?"
//
// Two independent defects had to be fixed, and fixing only one of them looks
// like success while the repeat still reaches the prospect:
//
//   1. stripRepeatedAsks returned "" to mean "do not speak this turn", and the
//      caller tested it for truthiness, so "" was read as "no change" and the
//      forbidden line was spoken. Both of those phrasings match the truckType
//      regex, so widening the regexes would have changed nothing.
//   2. The topic regexes do not cover how a carrier actually talks about their
//      equipment, so paraphrases outside the list matched nothing at all.
const assert = require("node:assert/strict");
const { runCall } = require("./call-runner");

const prevKey = process.env.GROQ_API_KEY;
const prevFetch = global.fetch;

/* The brain is scripted so the reply is decided by the test, not by whatever
 * the model happens to feel like saying. Each turn is keyed on how many times
 * the brain has been called. */
function scriptBrain(replies) {
  process.env.GROQ_API_KEY = "repeat-ask-test";
  let n = 0;
  global.fetch = async () => {
    const r = replies[Math.min(n, replies.length - 1)];
    n++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: r } }] }),
    };
  };
  return () => n;
}

function restore() {
  if (prevKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = prevKey;
  global.fetch = prevFetch;
}

async function converse(replies, leadTurns) {
  scriptBrain(replies);
  const spoken = [];
  let i = 0;
  const listen = async () => {
    if (i >= leadTurns.length) return { ended: true, text: null };
    const t = leadTurns[i++];
    return { text: t, language: "en" };
  };
  const out = await runCall({
    product: "test product",
    leadFields: ["TRUCK TYPE", "MC NUMBER"],
    persona: "test",
    companyName: "Zaz Logistics",
    callbackNumber: null,
    callbackIn: null,
    contactEmail: null,
    learning: null,
    locale: "en",
    preparedOpeningText: "Hi, this is Atlas.",
    portal: null,
    deviceToken: null,
    callId: "repeat-ask-test",
    speak: async (l) => { spoken.push(String(l)); },
    listen,
  });
  return { spoken, out };
}

/** Every distinct question the agent asked, ignoring case and punctuation. */
function questions(spoken) {
  return spoken
    .flatMap((l) => l.split(/(?<=[.?!])\s+/))
    .map((s) => s.trim())
    .filter((s) => s.includes("?"))
    .map((s) => s.toLowerCase().replace(/[^a-z?]/g, "").trim());
}

async function main() {
  try {
    /* ---- 1. The exact reported failure: same question, three phrasings.
     * Every reply is a re-ask. The agent must not speak any of them, and it
     * must not go silent either - it owes the prospect a turn. */
    const repeats = await converse(
      [
        "What type of truck do you operate?",
        "what kind of truck you operate?",
        "What type of truck do you operate?",
        "Thanks, got it.",
      ],
      ["I run reefers.", "Dry van mostly.", "Okay."]
    );
    const asked = questions(repeats.spoken);
    // The first ask is legitimate - the guard stops the second and third, it
    // does not forbid ever asking. So the assertion is "asked at most once",
    // not "never asked".
    const truckQs = asked.filter((q) => /truck|operate|kind|type/.test(q));
    assert.ok(
      truckQs.length <= 1,
      `the same question must not be asked more than once, got ${JSON.stringify(truckQs)}`
    );
    assert.equal(
      new Set(asked).size, asked.length,
      `no question may be spoken twice, got ${JSON.stringify(asked)}`
    );
    assert.ok(
      repeats.spoken.length >= 4,
      `the agent must keep speaking when it refuses a repeat, got ${JSON.stringify(repeats.spoken)}`
    );

    /* ---- 2. Paraphrases that match NO topic regex. Each of these was asked
     * twice on the test call and the regex list matched none of them. */
    const paraphrases = [
      ["Do you haul reefer or dry van?", "Is it a straight truck or a tractor?"],
      ["Are you a flatbed or a reefer carrier?", "What kind of truck do you run?"],
      ["Could you tell me about the equipment you run?", "What type of equipment is it?"],
    ];
    for (const pair of paraphrases) {
      const r = await converse([pair[0], pair[1], "Thanks."], ["Reefer.", "Dry van."]);
      const qs = questions(r.spoken);
      const equipmentQs = qs.filter((q) => /reefer|dry|van|flatbed|straight|tractor|truck|equipment|haul|carry|kind|type/.test(q));
      assert.ok(
        equipmentQs.length <= 1,
        `"${pair[0]}" then "${pair[1]}" is a re-ask; at most the first may be spoken, got ${JSON.stringify(equipmentQs)}`
      );
    }

    /* ---- 3. A re-ask guard must not delete real, distinct questions. This is
     * the failure mode of an over-broad topic match: the guard eats the reply
     * and the prospect hears nothing, which reads as a dropped call. */
    const distinct = await converse(
      [
        "What type of truck do you operate?",
        "How many trucks do you run?",
        "What is your MC number?",
        "Thanks, got it.",
      ],
      ["Reefer.", "Six.", "123456."]
    );
    const distinctQs = questions(distinct.spoken);
    // "How many trucks" is a different fact from "what type of truck", and it
    // shares the words truck and run with it. A guard that cannot tell those
    // apart deletes a legitimate question, and the prospect hears nothing.
    // questions() strips spaces and punctuation, so match the squashed form.
    assert.ok(
      distinctQs.some((q) => /howmanytrucks/.test(q)),
      `fleet size must still be spoken after equipment type, got ${JSON.stringify(distinctQs)}`
    );
    assert.ok(
      distinctQs.some((q) => /mcnumber/.test(q)),
      `the MC number question must still be spoken, got ${JSON.stringify(distinctQs)}`
    );

    /* ---- 4. A statement is not a re-ask. "I run reefers" after asking about
     * truck type shares every content word with the question, and treating that
     * as a repeat made the guard delete a perfectly good answer. */
    const statement = await converse(
      ["What type of truck do you operate?", "I run dry vans out of Ohio.", "Thanks."],
      ["Reefer.", "Okay."]
    );
    assert.ok(
      statement.spoken.some((l) => /ohio/i.test(l)),
      `a statement must never be swallowed by the re-ask guard, got ${JSON.stringify(statement.spoken)}`
    );

    /* ---- 5. An answered question must not be re-asked across many turns. The
     * test call asked three times over 90s; this asserts the guard holds for
     * the whole call, not just for adjacent turns. */
    let nagging = true;
    const nag = await converse(
      [
        // Every reply is a re-ask of the same fact, in a different phrasing.
        // The fallbacks after them must each be distinct: handing the brain the
        // same sentence twice in a row would be testing the never-repeat-a-line
        // guard instead of this one.
        "What type of truck do you operate?",
        "So, what kind of truck is it?",
        "That is helpful, thanks.",
        "Can you tell me what trucks you operate?",
        "Got it, noted on that.",
        "Which type of truck do you drive?",
        "Understood.",
        "Do you run reefers?",
        "That is clear, thank you.",
        "Just to confirm, what type of truck do you operate?",
        "Appreciate that.",
      ],
      ["Reefer.", "Dry van.", "Box truck.", "Okay.", "Sure.", "Fine."]
    );
    const nagQs = questions(nag.spoken).filter((q) => /truck|reefer|operate|drive|run|kind|type|confirm/.test(q));
    assert.ok(
      nagQs.length <= 1,
      `no equipment question may be asked twice anywhere in the call, got ${JSON.stringify(nagQs)}`
    );
    assert.ok(nag.spoken.length >= 7, `the agent must speak on every turn, got ${nag.spoken.length} lines`);

    /* ---- 6. The repeat-introduction guard, which the falsy-check bug had also
     * silently disabled. A second "This is Atlas with Zaz Logistics" after the
     * opening is the same defect class. */
    const twice = await converse(
      [
        // The opening comes from preparedOpeningText, so the first scripted
        // reply is the first real turn - and it is a repeat introduction.
        "This is Atlas with Zaz Logistics calling.",
        "Who is this?",
        "This is Atlas with Zaz Logistics.",
        "That is all I needed, thanks.",
      ],
      ["Hello.", "Who is this?", "Atlas from Zaz."]
    );
    const intros = twice.spoken.filter((l) => /this is atlas/i.test(l));
    /* The opener, plus the turn answering "Who is this?" - repeating the
     * introduction there is the only correct answer. The free-standing second
     * introduction must not be spoken, and with the old falsy check it was. */
    assert.ok(
      intros.length <= 2,
      `the introduction must not repeat freely, got ${JSON.stringify(intros)}`
    );

    /* ---- 7. Inbound-receptionist phrasing on an outbound call. */
    const inbound = await converse(
      ["How can I help you today?", "Thanks."], ["Hello?"]
    );
    assert.ok(
      !inbound.spoken.some((l) => /how can i help you today/i.test(l)),
      `inbound-receptionist phrasing must never be spoken on an outbound call, got ${JSON.stringify(inbound.spoken)}`
    );

    /* ---- 8. The replacement line must not itself repeat. If the agent refuses
     * a repeat and says "Thanks for your time" four times, it has not fixed
     * anything - it has made the call worse. */
    const allRepeats = await converse(
      [
        "What type of truck do you operate?",
        "What kind of truck do you operate?",
        "What type of truck do you run?",
        "What trucks do you drive?",
        "Thanks.",
      ],
      ["Reefer.", "Dry van.", "Box.", "Okay."]
    );
    const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
    const spokenSet = new Set(allRepeats.spoken.map(norm));
    assert.equal(
      spokenSet.size, allRepeats.spoken.length,
      `no line may be spoken twice, got ${JSON.stringify(allRepeats.spoken)}`
    );
  } finally {
    restore();
  }
  console.log("PASS: repeat-ask guard survives paraphrase and never silences the turn");
}

main().catch((e) => { restore(); console.error(e); process.exit(1); });