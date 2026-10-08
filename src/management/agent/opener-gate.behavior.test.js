"use strict";

/* THE OPENER, ON THE 07 OCT 2026 CALL.
 *
 * Verbatim from a real call:
 *
 *   ringcentral: Hi, this is Atlas with Zaz Logistics. Is now a good time...  (t+7s)
 *   Haris:       Hello?                                                       (t+7s)
 *   Haris:       Hello?                                                       (t+14s)
 *   ringcentral: Is now a good time for a quick call?                         (t+18s)
 *
 * Three defects in eleven seconds, and they are three different mechanisms:
 *
 *  1. The opener played at the instant the prospect said "Hello?". The only gate
 *     was inbound RTP, which is true milliseconds after the far end is answered
 *     and says nothing about whether a person has spoken. The product rule is
 *     that the AI does not begin talking until they have answered AND spoken.
 *
 *  2. The second line is the opener again, phrased differently. The re-open after
 *     a quiet window was a hardcoded second introduction, and the guard that was
 *     supposed to catch it wanted the words "this" or "it" before "a good time",
 *     which "is now a good time for a quick call" does not have.
 *
 *  3. The opener also bypassed the repeat-ask machinery entirely, so the question
 *     it asked was never recorded as asked.
 *
 * Each is pinned below, offline and deterministically, with the brain scripted so
 * the outcome is decided by the code and not by whatever the model feels like
 * saying today.
 */
const assert = require("node:assert/strict");
const { runCall } = require("./call-runner");

const prevKey = process.env.GROQ_API_KEY;
const prevFetch = global.fetch;

/** The brain, scripted. Each reply is keyed on how many times it is called. */
function scriptBrain(replies) {
  process.env.GROQ_API_KEY = "opener-gate-test";
  let n = 0;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: replies[Math.min(n, replies.length - 1)] } }] }),
  });
  return () => n;
}

function restore() {
  if (prevKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = prevKey;
  global.fetch = prevFetch;
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const isOpener = (l) => /\b(?:good|okay|ok)\s+time\s+(?:to|for)\b/i.test(l) || /\b(?:this|it)\s+(?:a|an)\s+(?:good|okay|ok)\s+time\b/i.test(l);
const isIntro = (l) => /\bthis is\s+\w+[\s,]+\w+/i.test(l) || /\bcalling (?:you )?from\b/i.test(l);

/**
 * One call, with the speech gate in place.
 *
 * `gate` is what local-call-controller's firstSpeechFn returns; `list` is the
 * sequence AFTER it, so the gate and the first turn can be told apart.
 */
async function converse({ gate, list, replies, preparedOpeningText = "Hi, this is Atlas with Zaz Logistics. Is now a good time to talk?" }) {
  scriptBrain(replies || []);
  const spoken = [];
  const events = [];
  let i = 0;
  const listen = async (turn) => {
    events.push("listen");
    const r = i < list.length ? list[i++] : { ended: true, text: null };
    return typeof r === "function" ? r() : r;
  };
  const waitForFirstSpeech = async () => {
    events.push("gate");
    return gate;
  };
  const speak = async (line) => { events.push("speak: " + String(line).slice(0, 30)); spoken.push(String(line)); };
  const out = await runCall({
    product: "Dispatch Services for trucks",
    leadFields: ["MC NUMBER"],
    persona: { name: "Atlas" },
    companyName: { name: "Zaz Logistics" },
    callbackNumber: null,
    callbackIn: null,
    contactEmail: null,
    learning: null,
    locale: "en",
    preparedOpeningText,
    portal: null,
    deviceToken: null,
    callId: "opener-gate-test",
    speak,
    listen,
    waitForFirstSpeech,
  });
  return { spoken, events, out };
}

async function main() {
  try {
    /* ---- 1. The opener does not speak before the prospect speaks.
     *
     * The prospect greets us and the gate returns their words. The canned opener
     * must never be spoken: it is on the wire at t+7s over "Hello?" at t+7s on
     * the live call, and that is the whole defect. */
    const greeted = await converse({
      gate: { text: "Hello?", language: "en" },
      list: [{ text: "Who is it?", language: "en" }, { text: "What do you need?", language: "en" }, { ended: true, text: null }],
      replies: [
        "Hi, this is Atlas with Zaz Logistics calling about dispatch services.",
        "It is Atlas with Zaz Logistics, calling about dispatch services.",
        "That is clear, thank you.",
      ],
    });
    assert.ok(
      !greeted.spoken.some((l) => /is now a good time to talk/i.test(l)),
      `the canned opener must not be read over the prospect's greeting, said: ${JSON.stringify(greeted.spoken)}`
    );
    assert.ok(
      greeted.events.indexOf("gate") < greeted.events.findIndex((e) => e.startsWith("speak")),
      `nothing may be spoken before the speech gate has run, got: ${JSON.stringify(greeted.events)}`
    );
    assert.ok(
      greeted.events.indexOf("gate") < greeted.events.indexOf("listen"),
      "the gate must be its own window, not an extra turn",
    );
    assert.ok(
      greeted.spoken.some((l) => /atlas|zaz/i.test(l)),
      `the reply has to answer the greeting with an introduction, got: ${JSON.stringify(greeted.spoken)}`
    );

    /* ---- 2. When the prospect speaks first the agent ANSWERS them, rather than
     * reading the opener. Their words must reach the brain as the turn it is
     * answering - a greeting that is discarded and re-asked is the same defect. */
    const answered = await converse({
      gate: { text: "Hello?", language: "en" },
      list: [{ text: "Yes, go ahead.", language: "en" }, { ended: true, text: null }],
      replies: ["Atlas with Zaz Logistics, what can I do for you?", "Great, tell me about your trucks."],
    });
    assert.ok(
      answered.out.transcript.some((t) => t.role === "lead" && t.text === "Hello?"),
      "the prospect's greeting must reach the transcript exactly once",
    );
    assert.equal(
      answered.out.transcript.filter((t) => t.role === "lead" && t.text === "Hello?").length, 1,
      "the gate's window must not be transcribed a second time as a fresh turn",
    );

    /* ---- 3. A silent prospect still gets the opener, inside the gate's own
     * budget. The gate returning "quiet" means 4000ms of nobody talking, and the
     * opener is what a person who answered in silence is owed. */
    const silent = await converse({
      gate: { text: null, quiet: true, waitedMs: 4000 },
      list: [{ text: "Yes, I can hear you.", language: "en" }, { ended: true, text: null }],
      replies: ["Got it, tell me about your operation.", "Thanks, that is all I needed."],
    });
    assert.equal(silent.spoken[0], "Hi, this is Atlas with Zaz Logistics. Is now a good time to talk?",
      `a silent prospect must still be spoken to, got: ${JSON.stringify(silent.spoken)}`);
    assert.ok(silent.spoken.length >= 2, "and the call must continue afterwards");

    /* A carrier tone or a voicemail is not a person, so the opener is spoken. */
    const voicemail = await converse({
      gate: { text: null, junk: true, waitedMs: 4000 },
      list: [{ text: null, junk: true, waitedMs: 5000 }, { ended: true, text: null }],
      replies: ["Got it, tell me about your operation."],
    });
    assert.ok(
      /is now a good time to talk/i.test(voicemail.spoken[0] || ""),
      `a machine on the line must still be spoken to, got: ${JSON.stringify(voicemail.spoken)}`,
    );

    /* Someone IS speaking and the recognizer cannot make them out. An opener
     * there would still be talking over a person; asking them to repeat is the
     * reply, and it is not the opener. */
    const unintelligible = await converse({
      gate: { text: null, unheard: true, empty: true, junk: false, gatewayFailed: true, waitedMs: 4000 },
      list: [{ ended: true, text: null }],
      replies: ["Thanks, that is all I needed."],
    });
    assert.ok(
      !unintelligible.spoken.some((l) => /is now a good time to talk|this is atlas/i.test(l)),
      `an opener must not be spoken over someone already talking, got: ${JSON.stringify(unintelligible.spoken)}`,
    );
    assert.ok(
      unintelligible.spoken.some((l) => /did not catch|could you say that again|say that again/i.test(l)),
      `that turn is owed a request to repeat, got: ${JSON.stringify(unintelligible.spoken)}`,
    );

    /* A remote hangup before we said anything: silence. */
    const gone = await converse({
      gate: { ended: true, text: null },
      list: [],
      replies: ["Thanks, that is all I needed."],
    });
    assert.ok(gone.spoken.length <= 1, `nothing should be said into a dead line, got: ${JSON.stringify(gone.spoken)}`);

    /* ---- 4. No line is ever spoken twice in one call, opener and re-open
     * included. This is the pair from the live call, verbatim. */
    const repeated = await converse({
      gate: { text: null, quiet: true, waitedMs: 4000 },
      list: [
        { text: "Yes, I can hear you.", language: "en" },
        { text: null, quiet: true, waitedMs: 5000 },
        { text: null, quiet: true, waitedMs: 5000 },
        { text: null, quiet: true, waitedMs: 5000 },
        { ended: true, text: null },
      ],
      // A brain that insists on opening again, which is what the model did.
      replies: ["Is now a good time to talk?", "Is now a good time for a quick call?", "Is this a good time to chat?"],
    });
    assert.equal(
      new Set(repeated.spoken.map(norm)).size, repeated.spoken.length,
      `no line may be spoken twice in one call, got: ${JSON.stringify(repeated.spoken)}`,
    );
    const openersSpoken = repeated.spoken.filter(isOpener);
    assert.ok(openersSpoken.length <= 1,
      `"is now a good time" is an opener and belongs to the first thing said; said ${openersSpoken.length} times: ${JSON.stringify(repeated.spoken)}`);
    const intros = repeated.spoken.filter(isIntro);
    assert.ok(intros.length <= 1,
      `the agent must not re-introduce itself on a call that already did, got: ${JSON.stringify(repeated.spoken)}`);

    /* ---- 5. The re-open is persistence, and the prospect hears it as such. The
     * exact live pairing - "Is now a good time to talk?" then "Is now a good time
     * for a quick call?" - must not be constructible any more. */
    const family = [
      "Is now a good time to talk?",
      "Is now a good time for a quick call?",
      "Is this a good time for us to chat?",
      "Hello, is this a good time to talk?",
      "Is now an okay time for a quick conversation?",
      "Would now be a better time to talk?",
      "Good time to talk?",
      "It is a good time to chat, is it not?",
      "Is now a convenient time for a call?",
      "Would now be a good time for a quick chat?",
      "This is a good time to talk, right?",
    ];
    for (const line of family) {
      assert.ok(openerFamily(line), `the opener family must cover ${JSON.stringify(line)}`);
    }
    // The two live lines are the same opener, so they must not both be spoken.
    const live = await converse({
      gate: { text: null, quiet: true, waitedMs: 4000 },
      list: [{ text: null, quiet: true, waitedMs: 5000 }, { ended: true, text: null }],
      replies: ["Is now a good time to talk?", "Is now a good time for a quick call?"],
    });
    assert.ok(live.spoken.length >= 2, `the prospect must still be spoken to on a quiet line, got: ${JSON.stringify(live.spoken)}`);
    assert.ok(
      !live.spoken.some((l) => /quick call/i.test(l)),
      `"is now a good time for a quick call" is the opener repeated, and must never be spoken: ${JSON.stringify(live.spoken)}`,
    );

    /* ---- 6. Without a gate (an offline simulation, the local microphone) the
     * opener behaves exactly as it always did. The gate is a capability, not a
     * behaviour change to every other caller. */
    scriptBrain(["Got it, tell me about your operation."]);
    const ungated = [];
    let gi = 0;
    const ungatedList = [{ text: "Yes, I can hear you.", language: "en" }, { ended: true, text: null }];
    const ungatedOut = await runCall({
      product: "Dispatch Services for trucks",
      leadFields: ["MC NUMBER"],
      persona: { name: "Atlas" },
      companyName: { name: "Zaz Logistics" },
      callbackNumber: null, callbackIn: null, contactEmail: null, learning: null,
      locale: "en",
      preparedOpeningText: "Hi, this is Atlas with Zaz Logistics. Is now a good time to talk?",
      portal: null, deviceToken: null, callId: "opener-gate-test",
      speak: async (l) => { ungated.push(String(l)); },
      listen: async () => (gi < ungatedList.length ? ungatedList[gi++] : { ended: true, text: null }),
    });
    assert.equal(ungated[0], "Hi, this is Atlas with Zaz Logistics. Is now a good time to talk?",
      "with no gate there is no window to wait in, so the opener goes out immediately");
    assert.ok(ungatedOut.transcript.some((t) => t.role === "agent"));
  } finally {
    restore();
  }
  console.log("PASS: the opener waits for a voice, answers the prospect who spoke first, still fires for silence, and never repeats");
}

/* The whole opener family, read straight out of the module so this file cannot
 * drift from the guard it is testing. */
function openerFamily(line) {
  return require("./call-runner").OPENER_GREETING_RE.test(line);
}

main().catch((e) => { restore(); console.error(e); process.exit(1); });