"use strict";

// The conversation loop must make the same hangup decisions whether or not the
// brain is reachable: quiet-line detection is decided here, not by an LLM call.
const assert = require("node:assert/strict");
const { runCall } = require("./call-runner");

const prevKey = process.env.GROQ_API_KEY;
const prevFetch = global.fetch;

function goOfflineTurns() {
  process.env.GROQ_API_KEY = "call-runner-behavior-test";
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: "Understood, that makes sense." } }] }),
  });
}
function restore() {
  if (prevKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = prevKey;
  global.fetch = prevFetch;
}

const JUNK = { text: null, junk: true };
const REMOTE_BYE = { ended: true, text: null };

async function run(script) {
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
  } finally {
    restore();
  }
  console.log("PASS: junk budget, quiet-line hangup, greeting turn");
}

main().catch(e => { restore(); console.error(e); process.exit(1); });
