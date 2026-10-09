"use strict";

/* A brain failure is our outage, not the prospect losing interest.
 *
 * Found by audio-sim `reopen` against the real deployed gateway. The gateway
 * 502'd for about seven seconds and the call ended like this:
 *
 *   LEAD:  Hello.
 *   AGENT: Sorry, could you tell me a bit more about that?
 *   LEAD:  Yes, go ahead.
 *   AGENT: Sorry, I lost that. What were you asking about?
 *   AGENT: Thanks for your time.  A manager will call you back within the next
 *          30 minutes. Goodbye.
 *
 * The prospect said "Hello." and "Yes, go ahead." They were interested. We hung
 * up on them because a provider was briefly unhealthy: escalation was
 * `llmFailures > 0`, so a single failure - no threshold, no notion of how long
 * the outage had lasted - closed the call.
 *
 * A transient failure must keep the call alive. A sustained one must still end
 * it, because there is no conversation to be had.
 */
const assert = require("node:assert/strict");
const { runCall } = require("./call-runner");

const prevKey = process.env.GROQ_API_KEY;
const prevFetch = global.fetch;
const prevMinMs = process.env.AUTODIAL_LLM_OUTAGE_MIN_MS;
const prevMinFails = process.env.AUTODIAL_LLM_OUTAGE_MIN_FAILURES;

function restore() {
  if (prevKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = prevKey;
  global.fetch = prevFetch;
  if (prevMinMs === undefined) delete process.env.AUTODIAL_LLM_OUTAGE_MIN_MS;
  else process.env.AUTODIAL_LLM_OUTAGE_MIN_MS = prevMinMs;
  if (prevMinFails === undefined) delete process.env.AUTODIAL_LLM_OUTAGE_MIN_FAILURES;
  else process.env.AUTODIAL_LLM_OUTAGE_MIN_FAILURES = prevMinFails;
}

/** Fails the first `failFirst` brain calls with a 502, then answers `replies`. */
function flakyBrain(failFirst, replies) {
  process.env.GROQ_API_KEY = "outage-test";
  let n = 0;
  global.fetch = async () => {
    n++;
    if (n <= failFirst) {
      return {
        ok: false,
        status: 502,
        text: async () => "<html>502 Bad Gateway</html>",
        json: async () => { throw new SyntaxError("Unexpected token < in JSON"); },
      };
    }
    const r = replies[Math.min(n - failFirst - 1, replies.length - 1)];
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: r } }] }) };
  };
}

/** Fails every brain call, for as long as the call lasts. */
function deadBrain() {
  process.env.GROQ_API_KEY = "outage-test";
  global.fetch = async () => ({
    ok: false,
    status: 502,
    text: async () => "<html>502 Bad Gateway</html>",
    json: async () => { throw new SyntaxError("Unexpected token < in JSON"); },
  });
}

async function converse(brain, leadTurns) {
  brain();
  const spoken = [];
  let i = 0;
  const listen = async () => {
    if (i >= leadTurns.length) return { ended: true, text: null };
    return { text: leadTurns[i++], language: "en" };
  };
  const out = await runCall({
    product: "Dispatch Services for trucks",
    leadFields: ["MC NUMBER"],
    persona: "Atlas",
    companyName: "Zaz Logistics",
    callbackNumber: null,
    callbackIn: null,
    contactEmail: null,
    learning: null,
    locale: "en",
    preparedOpeningText: "Hi, this is Atlas with Zaz Logistics.",
    portal: null,
    deviceToken: null,
    callId: "outage-test",
    speak: async (l) => { spoken.push(String(l)); },
    listen,
  });
  return { spoken, out };
}

const isClosing = (s) => /goodbye|good ?bye|call you back|manager will|thanks for your time/i.test(s);

async function main() {
  try {
    /* ---- 1. A burst of failures must NOT hang up on an interested prospect. */
    /* failFirst 4 covers both agent-side attempts of two consecutive turns, */
    /* which is what the gateway outage actually looked like. */
    const burst = await converse(
      () => flakyBrain(4, [
        "Can I grab your MC number quickly?",
        "Got it, thanks. What kind of trucks do you run?",
        "Understood, thanks for your time.",
      ]),
      ["Hello.", "Yes, go ahead.", "Sounds fine.", "Alright.", "Okay, bye."]
    );
    const burstText = burst.spoken.join(" | ");
    assert.equal(
      burst.out.escalateToHuman,
      false,
      `a brief outage must not escalate to a human, got reason: ${burst.out.escalateReason}`
    );
    assert.ok(
      !/gateway/i.test(String(burst.out.escalateReason || "")),
      `a recovered outage must not be recorded as a gateway failure, got: ${burst.out.escalateReason}`
    );
    /* The real symptom was that the call never got past its first turn. After a */
    /* brief outage the agent has to pick the conversation back up and keep */
    /* qualifying - that is what proves the lead was not abandoned. */
    assert.ok(
      /mc number|truck|dispatch/i.test(burstText),
      `the agent must carry on qualifying after a brief outage, it said: ${burstText}`
    );

    /* ---- 2. The agent still has to say SOMETHING while the brain is down. */
    /* This is the original bug 4: a failed brain used to produce a turn with */
    /* no reply at all, which is dead air. */
    assert.ok(
      burst.spoken.length >= 2,
      `the agent must keep the call alive out loud, got: ${JSON.stringify(burst.spoken)}`
    );

    /* ---- 3. A SUSTAINED outage must still end the call, gracefully. */
    /* The window is shortened so this does not sit there for 60 seconds. */
    process.env.AUTODIAL_LLM_OUTAGE_MIN_MS = "1";
    process.env.AUTODIAL_LLM_OUTAGE_MIN_FAILURES = "2";
    const dead = await converse(deadBrain, [
      "Hello.", "Yes, go ahead.", "Sure.", "Okay.", "Right.", "Fine.", "Yep.",
    ]);
    assert.equal(
      dead.out.escalateToHuman,
      true,
      "a sustained outage must escalate - there is no conversation to be had"
    );
    assert.match(
      String(dead.out.escalateReason),
      /gateway/i,
      `the reason must name the gateway rather than blame the prospect, got: ${dead.out.escalateReason}`
    );
    assert.ok(
      dead.spoken.some(isClosing),
      `a sustained outage must end with a proper closing, got: ${JSON.stringify(dead.spoken)}`
    );

    console.log(
      "PASS: a brief brain outage keeps an interested prospect on the line, says " +
        "something while it lasts, and only a sustained outage ends the call"
    );
  } finally {
    restore();
  }
}

main().catch((e) => {
  restore();
  console.error("FAIL:", e && e.message ? e.message : e);
  process.exit(1);
});