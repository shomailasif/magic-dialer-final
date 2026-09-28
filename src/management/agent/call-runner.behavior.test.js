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

async function run(script, onSpoken) {
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
  const speak = async (line) => { spoken.push(String(line)); if (onSpoken) onSpoken(String(line)); };
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

    // A genuinely engaged prospect must not be cut off by the runaway backstop.
    // The 20:44Z call hit exactly 12 turns and was truncated mid-sentence right
    // after the prospect asked for a load. Sixteen real turns must survive.
    const engaged = [];
    for (let i = 0; i < 16; i++) engaged.push({ text: `Tell me more about option ${i + 1}.`, language: "en" });
    const longTalk = await run(engaged);
    const heardAll = engaged.every(t => longTalk.out.transcript.some(x => x.role === "lead" && x.text === t.text));
    assert.ok(heardAll, `every one of the 16 real turns must reach the transcript, heard ${longTalk.out.transcript.filter(x => x.role === "lead").length}`);
    assert.ok(
      longTalk.listenCalls.length >= engaged.length,
      "a real conversation must not be cut off by the runaway turn bound"
    );

    // Every ending must be a spoken closing. The 20:44Z call was cut off
    // mid-sentence with no sign-off, which is not how a sales call ends.
    const ends = {
      "dead line": [null, null, { text: "too late", language: "en" }],
      "beep-only line": [JUNK, JUNK, JUNK, JUNK],
      "turn backstop": engaged,
    };
    for (const [label, script] of Object.entries(ends)) {
      brainPrompts.length = 0;
      const finished = await run(script);
      const last = finished.spoken[finished.spoken.length - 1] || "";
      const askedClose = brainPrompts.some(p => /professional closing/i.test(JSON.stringify(p)));
      assert.ok(
        askedClose || /thank|goodbye|have a great day|bye/i.test(last),
        `a call ending by "${label}" must speak a closing, got: ${JSON.stringify(finished.spoken.slice(-2))}`
      );
    }

    // A farewell that was already spoken must not be doubled up.
    const stopCall = await run([{ text: "Please stop calling me.", language: "en" }, { text: "too late", language: "en" }]);
    const goodbyes = stopCall.spoken.filter(l => /thank you for your time|have a great day/i.test(l));
    assert.ok(goodbyes.length <= 1, `a do-not-call ending must not be followed by a second closing, got ${goodbyes.length}`);
    // The prospect spoke but we could not hear them. That must never become
    // silence or advance the conversation: the 18:51Z call lost the prospect's
    // only utterance to a gateway 503, sat in dead air, then said "The line is
    // connected and ready" twice.
    let repeats = 0;
    const unhearScript = [];
    for (let i = 0; i < 4; i++) unhearScript.push({ text: null, unheard: true, empty: true, junk: false, gatewayFailed: true, waitedMs: 5000 });
    const unheard = await run(unhearScript, (line) => { if (line) repeats++; });
    assert.equal(
      unheard.out.transcript.filter(t => t.role === "lead" && t.text === "(silence)").length > 0,
      true,
      "an unheard window is still reported to the transcript"
    );
    const unheardReplies = unheard.out.transcript.filter(t => t.role === "agent").map(t => t.text);
    assert.ok(unheardReplies.length >= 1, "an unheard window must still get a spoken reply");
    const uniqueReplies = new Set(unheardReplies.map((l) => l.toLowerCase().replace(/[^a-z ]/g, "").trim()));
    assert.equal(uniqueReplies.size, unheardReplies.length, `the agent must never repeat itself, got ${JSON.stringify(unheardReplies)}`);
    assert.ok(
      !unheardReplies.some(l => /line is connected|ready/i.test(l)),
      `the agent must not announce that the line is connected, got ${JSON.stringify(unheardReplies)}`
    );
    // And it must not have hung up: silence is not consent.
    assert.equal(unheard.listenCalls.length >= 4, true, "unheard windows must not age into the dead-line hangup");
    // A guard must never make the agent go quiet. On the 19:09Z call the brain
    // was asked to restate the opener, complied, and the repeat-introduction
    // guard then deleted the whole line - 14 seconds of dead air.
    const openerAgain = await run([{ text: null, quiet: true, waitedMs: 5000 }, { text: "too late", language: "en" }]);
    assert.ok(openerAgain.spoken.length >= 2, `the agent must speak after a quiet window, got ${JSON.stringify(openerAgain.spoken)}`);
    const gap = openerAgain.spoken.length;
    assert.ok(gap >= 2, "silence after a quiet window is the worst possible failure");

    // The closing must never state a number nobody gave, must not say the same
    // thing twice, and must fit in a turn.
    const closingRuns = [
      [JUNK, JUNK, JUNK, JUNK],
      [{ text: "My number is 555 123 4567.", language: "en" }, { text: "Yes, I can hear you.", language: "en" }, { text: "too late", language: "en" }],
    ];
    for (const script of closingRuns) {
      const run2 = await run(script);
      const last = run2.spoken[run2.spoken.length - 1] || "";
      assert.ok(last.length <= 160, `the closing must be one turn, got ${last.length} chars`);
      const numbers = (last.match(/[\d][\d\s().`'\-]{5,}[\d]/g) || []).map((m) => m.replace(/\D/g, ""));
      const saidNumber = script.some((s) => s && s.text && /\d[\d\s().`'-]{7,}\d/.test(s.text));
      if (!saidNumber) {
        assert.equal(numbers.length, 0, `the agent must never invent a number, said: ${JSON.stringify(last)}`);
      }
      assert.ok(!/line is connected|ready\b/i.test(last), `the closing must not announce line status: ${JSON.stringify(last)}`);
    }
  } finally {
    restore();
  }
  console.log("PASS: junk budget, quiet-line hangup, greeting turn");
}

main().catch(e => { restore(); console.error(e); process.exit(1); });
