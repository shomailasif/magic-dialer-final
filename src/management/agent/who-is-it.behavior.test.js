"use strict";

/* "Who is it?" has to be answered.
 *
 * From the 07 Oct 2026 call, verbatim:
 *
 *   Haris:       Who is it?                                        (t+19s)
 *   Haris:       What do you                                       (t+28s)
 *   ringcentral: Let me get you a straight answer to that - I will have
 *                someone call you back with it.                    (t+40s)
 *   Haris:       The fuck?                                         (t+47s)
 *
 * That reply answers nothing and promises a call back for a question whose
 * answer costs nothing: the agent's own name, the company it works for and what
 * it sells are all in the configuration this call was started from, and all
 * three are already in the system prompt the model is given.
 *
 * There were two reasons it came out as a deflection, and both are pinned here.
 * The fallback line was hardcoded for "I cannot answer that" and was reached
 * whenever the model's reply was a question or an acknowledgment - which is what
 * it produces most often for an identity question. And the retry prompt was
 * hardcoded to "I asked whether your dispatcher can call me now", so a prospect
 * asking who was calling was told, in the prompt, that they had asked about
 * dispatch availability. The model answered that question instead of theirs.
 */
const assert = require("node:assert/strict");
const { runCall } = require("./call-runner");
const { systemPrompt } = require("./intelligent-brain");

const prevKey = process.env.GROQ_API_KEY;
const prevFetch = global.fetch;

/** The brain, scripted. A list of replies, replayed from the last one. */
function scriptBrain(replies) {
  process.env.GROQ_API_KEY = "who-is-it-test";
  let n = 0;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: replies[Math.min(n, replies.length - 1)] } }] }),
  });
  return () => n;
}

function deadBrain() {
  process.env.GROQ_API_KEY = "who-is-it-test";
  global.fetch = async () => ({
    ok: false,
    status: 502,
    text: async () => "<html>502</html>",
    json: async () => { throw new SyntaxError("Unexpected token < in JSON"); },
  });
}

function restore() {
  if (prevKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = prevKey;
  global.fetch = prevFetch;
}

const CONFIG = {
  product: "Dispatch Services for trucks",
  leadFields: ["MC NUMBER"],
  persona: { name: "Atlas" },
  companyName: { name: "Zaz Logistics" },
  callbackNumber: null,
  callbackIn: null,
  contactEmail: null,
  learning: null,
  locale: "en",
  preparedOpeningText: "Hi, this is Atlas with Zaz Logistics. Is now a good time to talk?",
  portal: null,
  deviceToken: null,
  callId: "who-is-it-test",
};

async function converse({ replies, leadTurns, dead = false, over = {}, gate = null }) {
  if (dead) deadBrain(); else scriptBrain(replies || []);
  const spoken = [];
  let i = 0;
  /* `gate` models the real path: the prospect picks up and speaks, so the canned
   * opener is never spoken and the agent's FIRST line is the reply to them. That
   * is the condition the near-duplicate case exists for - with an opener already
   * on the wire the introduction has been said before the conversation started,
   * and the repetition being hunted cannot happen. */
  const waitForFirstSpeech = gate ? async () => gate : null;
  const out = await runCall({
    ...CONFIG,
    ...over,
    speak: async (line) => { spoken.push(String(line)); },
    listen: async () => (i < leadTurns.length ? { text: leadTurns[i++], language: "en" } : { ended: true, text: null }),
    waitForFirstSpeech,
  });
  return { spoken, out };
}

/* Everything the agent said after the opener.
 *
 * The closing is excluded: it legitimately promises a manager will call back,
 * and that promise is the whole point of a closing. What must never happen is an
 * ANSWER being a promise instead of an answer. */
const isClosing = (l) => /call (?:you )?back within|call (?:you )?back on\b/i.test(l);
const reply = (spoken) => spoken.slice(1).filter((l) => !isClosing(l)).join(" | ");

async function main() {
  try {
    /* ---- 1. The live question, answered from the configuration. */
    const asked = await converse({
      replies: ["Sure, happy to help with your dispatch needs."],
      leadTurns: ["Who is it?", "What do you need?"],
    });
    const said = reply(asked.spoken);
    assert.match(said, /zaz logistics/i, `the company must be named, got: ${JSON.stringify(asked.spoken)}`);
    assert.match(said, /atlas/i, `the agent's own name must be given, got: ${JSON.stringify(asked.spoken)}`);
    assert.doesNotMatch(
      said, /call you back|callback|get you a straight answer|have someone/i,
      `"who is it" must never be answered with a callback promise, got: ${JSON.stringify(asked.spoken)}`,
    );
    assert.doesNotMatch(said, /\?\s*$/, `"who is it" must be answered, not deflected with a question, got: ${JSON.stringify(asked.spoken)}`);

    /* Both of the live questions, and both answered rather than promised. */
    const both = await converse({
      replies: ["Thanks for your time."],
      leadTurns: ["Who is it?", "What do you need?"],
    });
    assert.equal(both.spoken.filter((l) => /zaz logistics/i.test(l)).length >= 2, true,
      `both identity questions must be answered, got: ${JSON.stringify(both.spoken)}`);

    /* ---- 2. The deflection must not be reachable even when the model refuses
     * to answer. A dead gateway is the worst case: the reply has to come from
     * us, and the only thing in the configuration is the truth. */
    const dead = await converse({ leadTurns: ["Who is it?"], dead: true });
    assert.match(reply(dead.spoken), /zaz logistics/i,
      `a dead brain must still be able to name the company, got: ${JSON.stringify(dead.spoken)}`);
    assert.doesNotMatch(reply(dead.spoken), /get you a straight answer/i,
      `the callback deflection must not survive as the answer to an identity question: ${JSON.stringify(dead.spoken)}`);

    /* ---- 3. A model that answers with another question, or with nothing but
     * "thanks", must not be allowed to be the answer to "who is it?". */
    for (const bad of ["Can I get your name first?", "Thanks for your time.", "Sure thing."]) {
      const r = await converse({ replies: [bad], leadTurns: ["Who is it?"] });
      assert.match(reply(r.spoken), /zaz logistics/i,
        `"${bad}" is not an answer to "who is it?", got: ${JSON.stringify(r.spoken)}`);
    }

    /* ---- 4. Asked twice, answered twice - with different words. A person who
     * asks "who is this?" twice has not heard us once, and the never-repeat-a-
     * line guard would otherwise hold the second answer and say nothing. */
    const twice = await converse({
      replies: ["Thanks for your time."],
      leadTurns: ["Who is it?", "Who is it?"],
    });
    const identities = twice.spoken.filter((l) => /zaz logistics/i.test(l));
    assert.ok(identities.length >= 2, `"who is it" twice must be answered twice, got: ${JSON.stringify(twice.spoken)}`);
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    assert.equal(new Set(identities.map(norm)).size, identities.length,
      `and the two answers must not be the same sentence, got: ${JSON.stringify(identities)}`);

    /* ---- 5. The answer must not be the sentence the prospect just heard, with
     * one word changed. That is what the first real audio-sim run of this fix
     * caught: the reply to "Hello?" was "I'm Atlas from Zaz Logistics, calling
     * about our dispatch services for trucks", and the answer built for "Who is
     * it?" came out "I am Atlas with Zaz Logistics, calling about Dispatch
     * Services for trucks" - a different string, the same sentence, 92% of the
     * same words. The exact-match guard cannot see that; word overlap can. */
    {
      const greeting = "I'm Atlas from Zaz Logistics, calling about our dispatch services for trucks.";
      const echo = await converse({
        replies: [greeting],
        leadTurns: ["Who is it?", "What is this about?"],
        gate: { text: "Hello?", language: "en", waitedMs: 900 },
      });
      const wordSet = (s) => new Set(String(s).toLowerCase().match(/[a-z]+/g) || []);
      const overlap = (a, b) => {
        const A = wordSet(a), B = wordSet(b);
        let n = 0;
        for (const w of A) if (B.has(w)) n++;
        return n / Math.min(A.size, B.size);
      };
      assert.equal(echo.spoken[0], greeting,
        `the first line must be the reply to the greeting, got: ${JSON.stringify(echo.spoken)}`);
      assert.ok(!echo.spoken.slice(1).some((l) => overlap(l, greeting) >= 0.8),
        `the agent must not re-say the introduction it just gave, one word apart: ${JSON.stringify(echo.spoken)}`);
      /* And it must still answer - silence is not the fix. */
      assert.ok(echo.spoken.filter((l) => /zaz logistics/i.test(l)).length >= 2,
        `"who is it" must still be answered when the greeting already introduced us, got: ${JSON.stringify(echo.spoken)}`);
    }

    /* ---- 6. "What is this about?" is the same question. */
    for (const q of [
      "What is this call about?",
      "What is this about?",
      "Why are you calling me?",
      "What do you want?",
    ]) {
      const r = await converse({ replies: ["Thanks."], leadTurns: [q] });
      assert.match(reply(r.spoken), /zaz logistics/i,
        `"${q}" must be answered from the configuration, got: ${JSON.stringify(r.spoken)}`);
    }

    /* ---- 7. What the company actually sells has to be in the answer too, when
     * it is configured - that is the second half of "what is this about?". */
    const about = await converse({ replies: ["Thanks."], leadTurns: ["What do you need?"] });
    assert.match(reply(about.spoken), /dispatch services for trucks/i,
      `the configured offering must be in the answer, got: ${JSON.stringify(about.spoken)}`);

    /* ---- 8. The facts have to reach the model in the first place. This is the
     * half the configuration can silently lose: persona and companyName arrive as
     * OBJECTS from the call config, and String({}) is "[object Object]", which
     * was once read aloud on a live call because the prompt never looked inside
     * them. */
    const prompt = systemPrompt({
      product: { name: "Dispatch Services for trucks" },
      leadFields: ["MC NUMBER"],
      persona: { name: "Atlas" },
      companyName: { name: "Zaz Logistics" },
      locale: "en",
    });
    assert.doesNotMatch(prompt, /\[object Object\]/, "an object must never reach the model prompt");
    assert.match(prompt, /Zaz Logistics/, "the company must be in the prompt the model is given");
    assert.match(prompt, /Dispatch Services for trucks/, "the offering must be in the prompt too");
    assert.match(prompt, /who is calling|why you are calling|what this call/i,
      "the prompt must tell the model that an identity question is answered in the first sentence, not promised away");
    assert.match(prompt, /NEVER answer one of those questions with a promise/i,
      "and it must forbid the callback deflection for exactly those questions");

    /* ---- 9. A caller who is NOT asking who we are must not be handed the
     * identity answer. The guard is for identity questions, not a reflex. */
    const ordinary = await converse({
      replies: ["Got it, could you share your MC number?"],
      leadTurns: ["I run six trucks out of Ohio.", "Thanks."],
    });
    assert.doesNotMatch(reply(ordinary.spoken), /i am atlas with zaz logistics|you are speaking with atlas/i,
      `an ordinary answer must not turn into an introduction, got: ${JSON.stringify(ordinary.spoken)}`);
  } finally {
    restore();
  }
  console.log("PASS: \"who is it\" is answered from the configuration, with the company named, and never with a callback promise");
}

main().catch((e) => { restore(); console.error(e); process.exit(1); });