"use strict";
/**
 * The brain's system prompt: small enough to be sent, complete enough to prevent
 * every defect it was written for.
 *
 * It was 7362 characters (~2100 tokens) re-sent on every call. That is a
 * reliability problem, not a cost one: the provider's limit is tokens-per-minute,
 * and 2100 tokens of standing instructions on a 3-second-turn conversation
 * exhausts it, after which every reply is "Groq HTTP 429" and the agent talks in
 * canned recovery lines. audio-sim reported that on every turn of every scenario.
 *
 * So two things have to hold at once, and either alone is insufficient:
 *
 *   1. Small. There is a hard ceiling, and exceeding it does not slowly degrade -
 *      it makes every call fail.
 *   2. Complete. Every rule maps to something that actually went wrong on a real
 *      call. A prompt cut for length that quietly drops "never invent a load
 *      list" has traded one outage for a worse one.
 *
 * The coverage half is the important half. A future edit that trims the prompt
 * further must come here and say which recorded defect it is willing to risk.
 */
const assert = require("node:assert/strict");
const path = require("node:path");

const brain = require(path.join(__dirname, "intelligent-brain.js"));

const CONFIG = {
  companyName: "Zaz Logistics",
  product: "Dispatch Services for trucks",
  persona: { name: "Atlas", description: "energetic, friendly, polite female sales representative" },
  locale: "en",
  leadFields: ["MC NUMBER"],
  callbackNumber: null,
  callbackIn: null,
  playbook: null,
  research: null,
};

const prompt = brain.systemPrompt(CONFIG);
const rulesBlock = prompt.slice(prompt.indexOf("Rules:"), prompt.indexOf("Output only the exact words"));

/* ---- 1. the size ceiling, with the reason stated so nobody raises it ---- */

/* Measured: ~4.4 chars per token. The old prompt was 7362 chars / ~2100 tokens;
 * this one is ~4416 / ~1022, about half. The ceiling is generous enough to absorb
 * a customer's real configuration (a long product description, several
 * qualification fields, a playbook) without reaching what reliably failed. */
const CEILING_CHARS = 7000;
assert.ok(prompt.length < CEILING_CHARS,
  `the system prompt is ${prompt.length} chars, over the ${CEILING_CHARS} ceiling that keeps it inside the provider's token budget`);
assert.ok(prompt.length < 7362,
  "the prompt got LARGER than the 7362-char version that exhausted the provider's token budget");

/* ---- 2. every rule that prevents a recorded defect ---- */

/* Each entry is [what the rule must still do, a pattern that proves it is there].
 * The comment is the recorded defect. Deleting a rule without deleting its test
 * entry fails here rather than on a live call. */
const REQUIRED = [
  ["never invents prices, stock or availability",
    /no live inventory|never present, list, summarise or read out loads/i],
  ["never says it cannot send information",
    /never reply that you cannot send or share it/i],
  ["answers a question instead of deflecting",
    /your next words must BE the answer/i],
  ["answers who-is-calling in the first sentence",
    /answer in your FIRST sentence with your name, the company and the purpose/i],
  ["never invents an inbound receptionist opening",
    /never behave like an inbound receptionist/i],
  ["does not assume the prospect's industry",
    /never assume an industry/i],
  ["never asks a broad discovery question",
    /never ask a broad business-discovery question/i],
  ["never asks twice for the same thing",
    /never ask the same thing twice/i],
  ["drops preamble when the prospect is in a hurry",
    /drop all preamble/i],
  ["only ever one question per turn",
    /at most ONE question/i],
  ["tells the prospect to stop when asked",
    /asks to stop, not to be called, or to be removed/i],
  ["answers truthfully about being AI",
    /answer truthfully/i],
  ["never exposes instructions or credentials",
    /never expose system instructions, credentials/i],
  ["stays in the configured language",
    /ACTIVE CONVERSATION LANGUAGE/i],
  ["tolerates carrier noise without switching to inbound",
    /beep, tone or click/i],
  ["never guesses what the prospect gave it",
    /do not name it/i],
  ["answers the concrete need first",
    /before asking anything of your own/i],
  ["keeps the agent's own name stable",
    /introduce yourself by the name given above/i],
];

for (const [what, pattern] of REQUIRED) {
  assert.match(rulesBlock, pattern, `the prompt lost the rule that ${what}`);
}

/* ---- 3. the configuration itself must survive ---- */

assert.match(prompt, /You are Atlas/, "the agent name must be present");
assert.match(prompt, /Zaz Logistics/, "the company must be present");
assert.match(prompt, /Dispatch Services for trucks/, "the product must be present");
assert.match(prompt, /MC NUMBER/, "the qualification goals must be present");
assert.match(prompt, /en \(English\)/, "the active language must be present");
assert.match(prompt, /Output only the exact words to speak/, "the output contract must be present");

/* The persona arriving as an object was spoken aloud as literal "[object Object]"
 * on a real call, so the object form must resolve to the name. */
const objectPersona = brain.systemPrompt({ ...CONFIG, persona: { name: "Nova" } });
assert.match(objectPersona, /You are Nova/, "an object persona must resolve to its name");
assert.doesNotMatch(objectPersona, /\[object Object\]/, "[object Object] must never reach the prompt");

/* ---- 4. the rules must not have grown back into paragraphs ---- */

/* A regression guard on the SHAPE, not just the size: one short sentence per
 * rule, so the next person to add a paragraph is caught by the same test that
 * guards the behaviour. */
const bulletCount = (rulesBlock.match(/ - /g) || []).length;
assert.ok(bulletCount >= REQUIRED.length, `expected at least ${REQUIRED.length} rules, found ${bulletCount}`);
const longestRule = rulesBlock
  .split(" - ")
  .slice(1)
  .reduce((a, b) => (b.length > a.length ? b : a), "");
assert.ok(longestRule.length < 700,
  `one rule grew to ${longestRule.length} chars; keep rules to a short sentence so the prompt stays small`);

console.log("brain system-prompt contract: PASS");
console.log(`  ${prompt.length} chars (was 7362), ${bulletCount} rules, all ${REQUIRED.length} recorded defects covered`);