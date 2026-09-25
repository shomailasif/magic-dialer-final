"use strict";

// The conversation loop must make the same hangup decisions whether or not the
// brain is reachable: quiet-line detection is decided here, not by an LLM call.
const assert = require("node:assert/strict");
const { runCall } = require("./call-runner");

const prevKey = process.env.GROQ_API_KEY;
const prevFetch = global.fetch;

const brainPrompts = [];
function goOfflineTurns() {
  process.env.GROQ_API_KEY = "call-runner-behavior-test";
  global.fetch = async (_url, init) => {
    try { brainPrompts.push(JSON.parse(String(init && init.body))); } catch { brainPrompts.push(null); }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "Understood, that makes sense." } }] }),
    };
  };
}
function restore() {
  if (prevKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = prevKey;
  global.fetch = prevFetch;
}

const JUNK = { text: null, junk: true };
const REMOTE_BYE = { ended: true, text: null };

async function run(script) {
  brainPrompts.length = 0;
  const listenCalls = [];
  const spoken = [];
  const listen = async () => {
    const idx = listenCalls.length;
    listenCalls.push(idx);
    // Anything past the script is a remote BYE so the loop cannot run to the
    // 12-turn runaway bound and hide a premature break.
    const r = idx < script.length ? script[idx] : REMOTE_BYE;
    return typeof r === "function" ? r() : r;
  };
  const speak = async (line) => { spoken.push(String(line)); };
  const out = await runCall({
    product: "test product",
    leadFields: [],
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
    callId: "call-under-test",
    speak,
    listen,
  });
  return { listenCalls, spoken, out };
}

async function main() {
  goOfflineTurns();
  try {
    // Carrier beeps must not age the dead-line counter: two beeps used to end
    // the call before the prospect ever had a chance to answer.
    // Three scripted windows (junk, junk, prospect) plus the trailing BYE.
    const junkThenSpeech = await run([JUNK, JUNK, { text: "Yes, I can hear you.", language: "en" }]);
    assert.equal(junkThenSpeech.listenCalls.length, 4, "junk windows must not end the call before the prospect speaks");
    assert.ok(
      junkThenSpeech.out.transcript.some(t => t.role === "lead" && t.text === "Yes, I can hear you."),
      "the prospect turn must reach the transcript"
    );

    // A genuinely quiet line still ends after two empty windows.
    const quiet = await run([null, null, { text: "too late", language: "en" }]);
    assert.equal(quiet.listenCalls.length, 2, "two empty windows must still end the call");
    assert.equal(quiet.spoken.length >= 2, true, "one check-in line per quiet window");

    // A line that only ever beeps is still bounded.
    const beeps = await run([JUNK, JUNK, JUNK, JUNK]);
    assert.equal(beeps.listenCalls.length, 3, "a beep-only line must end on the junk budget");

    // Junk reported as text (portal STT path) draws from the same budget.
    const leadBeeps = await run(["Beep.", "Beep.", "Beep.", "Beep."]);
    assert.equal(leadBeeps.listenCalls.length, 3, "a junk lead string must use the junk budget, not the quiet-line budget");

    // A greeting after a beep is a real turn and resets both counters, so only
    // two *later* quiet windows may end the call.
    const greet = await run([JUNK, { text: "Hello?", language: "en" }, null, null, { text: "too late", language: "en" }]);
    assert.equal(greet.listenCalls.length, 4, "a greeting must reset the counters so only two later quiet windows end the call");
    assert.ok(
      greet.out.transcript.some(t => t.role === "lead" && t.text === "Hello?"),
      "the greeting must be kept as a lead turn"
    );

    // Opening into dead air must NOT produce a connectivity check. The 20:24Z
    // and 20:25Z calls both went straight to "Can you hear me okay?" straight
    // after the greeting, which is what a broken line sounds like.
    const deadAirOpen = await run([{ text: null, quiet: true, waitedMs: 5000 }, { text: "Yes, I can hear you.", language: "en" }, REMOTE_BYE]);
    const checkIns = deadAirOpen.spoken.filter(l => /can you hear me|make sure you can hear/i.test(l));
    assert.equal(checkIns.length, 0, `the first quiet window must not be a connectivity check, got: ${JSON.stringify(checkIns)}`);
    const openPrompt = JSON.stringify(brainPrompts.slice(-3));
    assert.ok(
      /not answered yet/i.test(openPrompt) && /Do not ask if they can hear you/i.test(openPrompt),
      `the first quiet window must instruct a natural opener, not a connectivity check, got: ${openPrompt}`
    );

    // Once the prospect HAS spoken, a later pause must continue the
    // conversation, never comment on the line.
    const midPause = await run([
      { text: "Who is this?", language: "en" },
      { text: null, quiet: true, waitedMs: 5000 },
      REMOTE_BYE,
    ]);
    const afterPause = midPause.spoken[midPause.spoken.length - 1];
    assert.ok(
      !/can you hear|connection|line is quiet|hear me clearly/i.test(afterPause),
      `a mid-conversation pause must not mention the line, got: ${JSON.stringify(afterPause)}`
    );

    // A single misdetected clip must not take the call over: it takes two
    // consecutive agreeing turns, and the words must match the claimed script.
    // This is the en -> fr -> ur flip-flop that ended the 20:25Z call.
    const flipFlop = await run([
      { text: "On fait maintenant.", language: "fr" },
      { text: "Yes, I can hear you clearly.", language: "en" },
      { text: "What was that?", language: "en" },
      REMOTE_BYE,
    ]);
    assert.equal(flipFlop.out.locale, "en", "one French clip on an English call must not switch the call to French");
    assert.ok(
      !flipFlop.out.timeline.some(t => t.event === "language-switch" && t.locale === "fr"),
      "a single unconfirmed detection must not emit a language switch"
    );
    assert.ok(
      flipFlop.out.timeline.some(t => t.event === "language-candidate" && t.locale === "fr"),
      "the unconfirmed detection must still be recorded as a candidate"
    );

    // A non-Latin locale claimed for Latin text is rejected outright: the Urdu
    // flip is what drove the agent into a voice that cannot synthesize.
    const bogusUrdu = await run([
      { text: "Yes, I can hear you clearly.", language: "ur" },
      { text: "Yes, I can hear you clearly.", language: "ur" },
      REMOTE_BYE,
    ]);
    assert.equal(bogusUrdu.out.locale, "en", "Latin text must never be routed to a non-Latin locale");
  } finally {
    restore();
  }
  console.log("PASS: junk budget, quiet-line hangup, greeting turn");
}

main().catch(e => { restore(); console.error(e); process.exit(1); });
