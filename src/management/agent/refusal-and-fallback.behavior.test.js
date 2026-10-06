"use strict";

// Bugs 3, 4 and 5 from CHECKPOINT.md, all found on the same 2026-10-06 call.
//
// 3. REFUSAL IGNORED. The prospect said "I told you I'm a bit busy right now"
//    at 2:01 and again at 2:35. The agent said "Sorry." and kept qualifying for
//    another sixty seconds.
// 4. SILENT TURN ON AI FAILURE. "AI gateway returned non-JSON (HTTP 502)" and
//    "AI gateway timed out after 7000ms" each produced a turn with no reply at
//    all - pure dead air.
// 5. GARBAGE SPOKEN ALOUD. Raw truncated output was voiced verbatim:
//    ..." is now a` and `follow…?`up.
const assert = require("node:assert/strict");
const { runCall } = require("./call-runner");

const prevKey = process.env.GROQ_API_KEY;
const prevFetch = global.fetch;

function restore() {
  if (prevKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = prevKey;
  global.fetch = prevFetch;
}

/** Brain always returns `replies`. */
function okBrain(replies) {
  process.env.GROQ_API_KEY = "refusal-test";
  let n = 0;
  global.fetch = async () => {
    const r = replies[Math.min(n, replies.length - 1)];
    n++;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: r } }] }) };
  };
}

/** Brain always fails, the way the gateway did on the test call. */
function deadBrain() {
  process.env.GROQ_API_KEY = "refusal-test";
  global.fetch = async () => ({
    ok: false,
    status: 502,
    text: async () => "<html>502 Bad Gateway</html>",
    json: async () => { throw new SyntaxError("Unexpected token < in JSON"); },
  });
}

async function converse(replies, leadTurns, opts = {}) {
  if (opts.dead) deadBrain(); else okBrain(replies);
  const spoken = [];
  let i = 0;
  const listen = async () => {
    if (i >= leadTurns.length) return { ended: true, text: null };
    return { text: leadTurns[i++], language: opts.locale || "en" };
  };
  const out = await runCall({
    product: "test product",
    leadFields: ["MC NUMBER", "TRUCK TYPE"],
    persona: "test",
    companyName: "Zaz Logistics",
    callbackNumber: null,
    callbackIn: null,
    contactEmail: null,
    learning: null,
    locale: opts.locale || "en",
    preparedOpeningText: "Hi, this is Atlas.",
    portal: null,
    deviceToken: null,
    callId: "refusal-test",
    speak: async (l) => { spoken.push(String(l)); },
    listen,
  });
  return { spoken, out };
}

/** Everything the agent said after the opener, as one string. */
const afterOpening = (spoken) => spoken.slice(1).join(" | ");

async function main() {
  try {
    /* ---- 3. A refusal ends the qualifying. */
    const refusals = [
      "I told you I'm a bit busy right now.",
      "I am busy right now.",
      "Busy.",
      "I don't have time for this.",
      "I'm in the middle of a load.",
      "Can I call you back later?",
      "not right now",
    ];
    for (const said of refusals) {
      const r = await converse(
        ["Can you confirm your MC number for me?", "Sure, it is 123456.", "Appreciate it."],
        [said, "Okay, bye.", "Fine."]
      );
      const tail = afterOpening(r.spoken);
      assert.ok(
        !/mc number|truck type|confirm your/i.test(tail),
        `"${said}" must stop qualification, but the agent said: ${tail}`
      );
      assert.ok(
        /sorry/i.test(tail),
        `"${said}" must be acknowledged, but the agent said: ${tail}`
      );
      // And it must actually end: no third turn after the refusal.
      const agentTurns = r.spoken.slice(1).length;
      assert.ok(agentTurns <= 2, `"${said}" must end the call in one reply, got ${agentTurns}: ${JSON.stringify(r.spoken)}`);
    }

    /* The exact test-call sequence: refused, apologised, then asked again. */
    const twice = await converse(
      [
        "What is your MC number?",
        "Sorry, no problem at all.",
        "I understand you are busy. What is your MC number?",
      ],
      [
        "I told you I'm a bit busy right now.",
        "I'm busy right now.",
        "That is all right.",
      ]
    );
    assert.ok(
      twice.spoken.filter((l) => /mc number/i.test(l)).length <= 1,
      `a refusal must not be followed by the same question, got ${JSON.stringify(twice.spoken)}`
    );

    /* A refusal must not be answered with a question back. */
    const noQuestionBack = await converse(
      ["Would now be a better time?", "Sorry, could you tell me a bit more?"],
      ["I am busy right now."]
    );
    const spoke = noQuestionBack.spoken.slice(1);
    assert.ok(
      spoke.length > 0 && !/\?/.test(spoke[0]),
      `the reply to a refusal must not be a question, got ${JSON.stringify(spoke)}`
    );

    /* The close after a refusal must be localized like everything else. */
    const urdu = await converse(
      ["Sorry, no problem. What is your MC number?"],
      ["میں ابھی مصروف ہوں۔"],
      { locale: "ur" }
    );
    const urTail = afterOpening(urdu.spoken);
    assert.ok(
      /معذرت|sorry/i.test(urTail),
      `an Urdu refusal must be acknowledged in Urdu, got ${JSON.stringify(urdu.spoken)}`
    );
    assert.ok(
      !/\b(?:mc number|truck type)\b/i.test(urTail),
      `an Urdu refusal must end the call, got ${JSON.stringify(urdu.spoken)}`
    );

    /* ---- 4. A dead gateway must never produce a silent turn. */
    const dead = await converse([], ["Hello, I can hear you.", "Yes.", "Okay."], { dead: true });
    assert.ok(
      dead.spoken.length >= 2,
      `a dead gateway must still speak, got ${JSON.stringify(dead.spoken)}`
    );
    assert.ok(
      dead.spoken.every((l) => String(l).trim().length > 0),
      `every spoken line must have content, got ${JSON.stringify(dead.spoken)}`
    );
    // Four consecutive failures end the call, and the close is still spoken.
    assert.ok(
      dead.spoken.length <= 6,
      `a permanently dead gateway must end the call, got ${dead.spoken.length} lines`
    );

    /* The fallback must be in the language of the call. */
    const deadUrdu = await converse([], ["میں سن سکتا ہوں۔"], { dead: true, locale: "ur" });
    const urDead = afterOpening(deadUrdu.spoken);
    assert.ok(
      /[؀-ۿ]/.test(urDead),
      `a dead gateway on an Urdu call must fall back in Urdu, got ${JSON.stringify(deadUrdu.spoken)}`
    );

    /* ---- 5. Fragmentary output must never be spoken. These are the strings
     * the test call voiced verbatim. */
    const fragments = [
      '" is now a',
      'follow...?`up ',
      '...',
      'I understand',
      'Well,',
      'um',
      'the',
      'you',
    ];
    for (const f of fragments) {
      const r = await converse([f, f, "Thank you."], ["Yes, go ahead.", "Sure.", "Okay."]);
      assert.ok(
        !r.spoken.some((l) => l.trim() === f.trim()),
        `fragmentary output must never be spoken verbatim: ${JSON.stringify(f)}`
      );
    }

    /* A complete sentence followed by a fragment keeps the sentence and drops
     * the fragment - the 19:28Z and 20:44Z calls both ended mid-clause. */
    const { capTurnLength } = require("./turn-length");
    assert.equal(capTurnLength("That is helpful. ..."), "That is helpful.",
      "a dangling fragment after a complete sentence must be dropped");
    // A line missing its terminator keeps its words and gains a full stop. Note
    // the model is told to end on a content word: a line ending on "that" or
    // "you" is treated as a truncation by design, and that rule is untouched.
    assert.equal(capTurnLength("I will get that quote"), "I will get that quote.",
      "a missing terminator must be added, not the line dropped");
    // A question ending on a function word is a question, not a truncation.
    assert.ok(
      /truck is it\?/.test(capTurnLength("So, what kind of truck is it?")),
      `a question must survive the fragment rule, got ${JSON.stringify(capTurnLength("So, what kind of truck is it?"))}`
    );

    /* A fragment from the brain must not become the whole spoken turn. */
    const fragTurn = await converse(
      ['" is now a', "That is helpful, thank you."],
      ["Yes, go ahead.", "Sure."]
    );
    assert.ok(
      fragTurn.spoken.every((l) => l.trim().length >= 8),
      `a fragment must not be spoken as a turn, got ${JSON.stringify(fragTurn.spoken)}`
    );
  } finally {
    restore();
  }
  console.log("PASS: refusal ends the call, dead gateway always speaks, fragments never voiced");
}

main().catch((e) => { restore(); console.error(e); process.exit(1); });