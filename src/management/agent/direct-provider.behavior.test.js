"use strict";
/**
 * Behaviour of the direct-provider path, exercised for real rather than asserted
 * from source text.
 *
 * The point of these is the ORDER, because order is the whole decision. A direct
 * call that works is not the requirement; a direct call that is tried first, and
 * a gateway that still answers when the provider is dead, are. Both are easy to
 * get backwards and impossible to see in a source-shape test.
 *
 *   no key          the gateway is called, and the provider is never contacted
 *   key, healthy    the provider is called, and the gateway is NOT
 *   key, dead       the gateway answers in the same turn
 *   key, empty      an empty transcript is a result, not a reason to spend two calls
 *   breaker open    the provider is skipped entirely
 *
 * fetch is stubbed per test and every request is recorded, so "was the provider
 * contacted?" is answered by observation rather than by a timeout.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const agentDir = path.join(__dirname);
const home = fs.mkdtempSync(path.join(os.tmpdir(), "md-direct-path-"));
process.env.AUTODIAL_HOME = home;
delete process.env.AUTODIAL_PROVIDER_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.AUTODIAL_GROQ_KEY;

const pk = require(path.join(agentDir, "provider-key.js"));
const health = require(path.join(agentDir, "gateway-health.js"));
const stt = require(path.join(agentDir, "multilingual-stt.js"));
const brain = require(path.join(agentDir, "intelligent-brain.js"));

const AUDIO = Buffer.alloc(2000, 7);
const PORTAL = "https://portal.example.test";
const TOKEN = "device-token-value";

let calls = [];
function stubFetch(handlers) {
  calls = [];
  global.fetch = async (url, init) => {
    const isPortal = String(url).startsWith(PORTAL);
    const kind = isPortal ? "gateway" : "provider";
    calls.push({ kind, url: String(url) });
    const h = handlers[kind] || handlers.default;
    /* No handler is itself a failure the test needs to see. Returning undefined
     * here produced "h is not a function" several frames away, which reads like
     * a defect in the code under test and was a defect in the stub. */
    if (typeof h !== "function") throw new Error(`stubFetch: no ${kind} handler for ${url}`);
    return h(url, init, kind);
  };
}
/* Retries and retry-after only mean something with headers to read them from, and
 * a stub without them is not the provider the real code meets. */
/* Retries and retry-after only mean something with headers to read them from.
 * Both this stub and the earlier STT one previously left `headers` off entirely
 * and the failure surfaced as "h is not a function" from deep inside a retry -
 * which looks like a bug in the retry and was a bug in the stub. */
const json = (status, body, headers) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: {
    get: (k) => {
      const map = headers || {};
      const key = String(k).toLowerCase();
      return map[key] === undefined ? null : map[key];
    },
  },
  text: async () => JSON.stringify(body),
  json: async () => body,
});

function reset() {
  health.reset();
  pk.clearProviderKey();
  calls = [];
}

/* The direct brain path retries a transient status and then tries a second model
 * before giving up, which is what makes it survivable under a rate limit. These
 * count the provider calls so a test can assert that behaviour rather than infer
 * it from a returned string. */
function providerCalls() { return calls.filter((c) => c.kind === "provider").length; }

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("with no local key the gateway answers and the provider is never contacted", async () => {
  reset();
  stubFetch({
    gateway: () => json(200, { text: "from the gateway", language: "English" }),
    provider: () => { throw new Error("the provider must not be called without a key"); },
  });
  const r = await stt.transcribeAuto(AUDIO, { portal: PORTAL, deviceToken: TOKEN });
  assert.equal(r.text, "from the gateway");
  assert.equal(r.path, "gateway");
  assert.deepEqual(calls.map((c) => c.kind), ["gateway"], "only the gateway may be contacted");
});

test("with a key the provider answers and the gateway is not called at all", async () => {
  reset();
  pk.setProviderKey("gsk_unit_test_key_value");
  stubFetch({
    provider: () => json(200, { text: "direct transcript", language: "English" }),
    gateway: () => { throw new Error("the gateway must not be called when the provider works"); },
  });
  const r = await stt.transcribeAuto(AUDIO, { portal: PORTAL, deviceToken: TOKEN });
  assert.equal(r.text, "direct transcript");
  assert.equal(r.path, "direct");
  assert.deepEqual(calls.map((c) => c.kind), ["provider"], "only the provider may be contacted");
});

test("a dead provider falls back to the gateway inside the same turn", async () => {
  reset();
  pk.setProviderKey("gsk_unit_test_key_value");
  stubFetch({
    provider: () => json(503, { error: "provider down" }),
    gateway: () => json(200, { text: "rescued by the gateway", language: "English" }),
  });
  const r = await stt.transcribeAuto(AUDIO, { portal: PORTAL, deviceToken: TOKEN });
  assert.equal(r.text, "rescued by the gateway", "a provider outage must not deafen the call");
  assert.equal(r.path, "gateway-fallback");
  assert.ok(r.directError, "the real reason must survive the fallback");
  assert.deepEqual(calls.map((c) => c.kind), ["provider", "gateway"]);
});

test("a network throw on the direct path also falls back", async () => {
  reset();
  pk.setProviderKey("gsk_unit_test_key_value");
  stubFetch({
    provider: () => { throw Object.assign(new Error("socket hang up"), { name: "TypeError" }); },
    gateway: () => json(200, { text: "rescued after a throw", language: "English" }),
  });
  const r = await stt.transcribeAuto(AUDIO, { portal: PORTAL, deviceToken: TOKEN });
  assert.equal(r.text, "rescued after a throw");
  assert.equal(r.path, "gateway-fallback");
});

test("an empty transcript is a result, not a reason to spend a second call", async () => {
  reset();
  pk.setProviderKey("gsk_unit_test_key_value");
  stubFetch({
    provider: () => json(200, { text: "", language: "English" }),
    gateway: () => { throw new Error("silence must not trigger a fallback"); },
  });
  const r = await stt.transcribeAuto(AUDIO, { portal: PORTAL, deviceToken: TOKEN });
  assert.equal(r.text, null);
  assert.equal(r.error, null, "an empty result carries no error");
  assert.equal(r.path, "direct");
  assert.equal(calls.length, 1, "exactly one provider call");
});

test("once the provider has failed three times the gateway is used without asking again", async () => {
  reset();
  pk.setProviderKey("gsk_unit_test_key_value");
  stubFetch({
    provider: () => json(503, { error: "provider down" }),
    gateway: () => json(200, { text: "gateway still hears", language: "English" }),
  });
  for (let i = 0; i < 6; i++) await stt.transcribeAuto(AUDIO, { portal: PORTAL, deviceToken: TOKEN });
  const providerCalls = calls.filter((c) => c.kind === "provider").length;
  const gatewayCalls = calls.filter((c) => c.kind === "gateway").length;
  assert.ok(providerCalls <= 4, `the breaker must stop paying, saw ${providerCalls} provider calls`);
  assert.ok(gatewayCalls >= 6, `every turn must still reach the gateway, saw ${gatewayCalls}`);
});

test("the brain asks the provider first when a key is held", async () => {
  reset();
  pk.setProviderKey("gsk_unit_test_key_value");
  stubFetch({
    provider: () => json(200, { choices: [{ message: { content: "direct answer" } }] }),
    gateway: () => { throw new Error("the gateway must not be called when the provider works"); },
  });
  const r = await brain.nextTurn({ transcript: [{ role: "prospect", text: "hello" }], portal: PORTAL, deviceToken: TOKEN });
  assert.equal(r.text, "direct answer");
  assert.equal(r.path, "direct");
  assert.deepEqual(calls.map((c) => c.kind), ["provider"]);
});

test("the brain falls back to the gateway when the provider fails", async () => {
  reset();
  pk.setProviderKey("gsk_unit_test_key_value");
  stubFetch({
    provider: () => json(500, { error: "provider exploded" }),
    gateway: () => json(200, { text: "gateway answer" }),
  });
  const r = await brain.nextTurn({ transcript: [{ role: "prospect", text: "hello" }], portal: PORTAL, deviceToken: TOKEN });
  assert.equal(r.text, "gateway answer");
  assert.equal(r.path, "gateway-fallback");
  /* The provider is tried, retried (500 is transient), and then the gateway
   * answers. Exact counts change with the retry policy; what must hold is that
   * the provider was tried at all and the gateway was reached. */
  assert.ok(calls.some((c) => c.kind === "provider"), "the provider must have been tried");
  assert.equal(calls[calls.length - 1].kind, "gateway", "the gateway must be the last thing asked");
  assert.ok(r.directError, "the real reason must survive the fallback");
});

test("with no key the brain is gateway-only and never touches the provider", async () => {
  reset();
  stubFetch({
    gateway: () => json(200, { text: "gateway only" }),
    provider: () => { throw new Error("the provider must not be called without a key"); },
  });
  const r = await brain.nextTurn({ transcript: [{ role: "prospect", text: "hello" }], portal: PORTAL, deviceToken: TOKEN });
  assert.equal(r.text, "gateway only");
  assert.deepEqual(calls.map((c) => c.kind), ["gateway"]);
});

test("with a key but no gateway the direct path still answers", async () => {
  reset();
  pk.setProviderKey("gsk_unit_test_key_value");
  stubFetch({ provider: () => json(200, { choices: [{ message: { content: "no gateway needed" } }] }) });
  const r = await brain.nextTurn({ transcript: [{ role: "prospect", text: "hello" }], portal: "", deviceToken: "" });
  assert.equal(r.text, "no gateway needed");
  assert.equal(r.path, "direct");
  assert.equal(providerCalls(), 1, "a working provider must cost exactly one call");
});

/* The regression that made this file necessary a second time.
 *
 * audio-sim with the direct provider returned HTTP 429 on EVERY brain call, and
 * the agent answered with canned recovery lines instead of replies. The direct
 * path had no retry and no second model, so it was strictly less survivable than
 * the gateway it replaced - "faster" had quietly become "more often silent". */
test("a rate-limited brain retries the primary model before giving up", async () => {
  reset();
  pk.setProviderKey("gsk_unit_test_key_value");
  let n = 0;
  stubFetch({
    provider: () => {
      n++;
      return n === 1 ? json(429, { error: "rate limited" }, { "retry-after": "0" })
        : json(200, { choices: [{ message: { content: "recovered from 429" } }] });
    },
    gateway: () => { throw new Error("a rate limit is recoverable and must not reach the gateway"); },
  });
  const r = await brain.nextTurn({ transcript: [{ role: "prospect", text: "hello" }], portal: PORTAL, deviceToken: TOKEN });
  assert.equal(r.text, "recovered from 429", "a 429 must be retried, not reported");
  assert.equal(r.path, "direct");
  assert.equal(providerCalls(), 2, "exactly one retry of the primary model");
});

test("a rate limit that persists falls to the second model, not to a canned line", async () => {
  reset();
  pk.setProviderKey("gsk_unit_test_key_value");
  const seen = [];
  stubFetch({
    provider: (url, init) => {
      seen.push(JSON.parse(init.body).model);
      /* The primary model is limited; the second one still answers. This is the
       * audio-sim case: a per-model limit that would otherwise cost every turn. */
      const model = JSON.parse(init.body).model;
      return model === "openai/gpt-oss-20b"
        ? json(200, { choices: [{ message: { content: "second model answered" } }] })
        : json(429, { error: "rate limited" }, { "retry-after": "0" });
    },
    gateway: () => { throw new Error("the second model must absorb this, not the gateway"); },
  });
  const r = await brain.nextTurn({ transcript: [{ role: "prospect", text: "hello" }], portal: PORTAL, deviceToken: TOKEN });
  assert.ok(r.text, "the agent must still say something real: " + JSON.stringify(r));
  assert.equal(r.path, "direct");
  assert.ok(seen.includes("openai/gpt-oss-20b"), `the second model must be tried, saw ${seen.join(",")}`);
});

/* The direct path starts on 20b, not 120b.
 *
 * Measured on the live account with the real 7.4k-character system prompt: 120b
 * returns HTTP 429 in ~100ms because the account's tokens-per-minute for it is
 * spent, while 20b answers 200 in ~550ms. Starting on the limited model spends
 * the first call of every turn on a failure. */
test("the direct path prefers the model that is not rate-limited", async () => {
  reset();
  pk.setProviderKey("gsk_unit_test_key_value");
  const seen = [];
  stubFetch({
    provider: (url, init) => { seen.push(JSON.parse(init.body).model); return json(200, { choices: [{ message: { content: "ok" } }] }); },
  });
  await brain.nextTurn({ transcript: [{ role: "prospect", text: "hello" }], portal: PORTAL, deviceToken: TOKEN });
  assert.equal(seen[0], "openai/gpt-oss-20b",
    `the direct path must start on 20b, started on ${seen[0]}`);
});

test("a rate limit on the first model still reaches the other one", async () => {
  reset();
  pk.setProviderKey("gsk_unit_test_key_value");
  const seen = [];
  stubFetch({
    provider: (url, init) => {
      const model = JSON.parse(init.body).model;
      seen.push(model);
      return model === "openai/gpt-oss-20b"
        ? json(429, { error: "rate limited" }, { "retry-after": "0" })
        : json(200, { choices: [{ message: { content: "120b answered" } }] });
    },
    gateway: () => { throw new Error("the other model must absorb this, not the gateway"); },
  });
  const r = await brain.nextTurn({ transcript: [{ role: "prospect", text: "hello" }], portal: PORTAL, deviceToken: TOKEN });
  assert.equal(r.text, "120b answered", "the other model must be reachable: " + JSON.stringify(r));
  assert.ok(seen.includes("openai/gpt-oss-120b"), `120b must be the fallback, saw ${seen.join(",")}`);
});

test("an explicit model override is honoured and still has a fallback", async () => {
  reset();
  pk.setProviderKey("gsk_unit_test_key_value");
  const prev = process.env.AUTODIAL_GROQ_MODEL;
  process.env.AUTODIAL_GROQ_MODEL = "openai/gpt-oss-120b";
  const seen = [];
  stubFetch({
    provider: (url, init) => {
      const model = JSON.parse(init.body).model;
      seen.push(model);
      return model === "openai/gpt-oss-120b"
        ? json(429, { error: "rate limited" }, { "retry-after": "0" })
        : json(200, { choices: [{ message: { content: "20b answered" } }] });
    },
  });
  const r = await brain.nextTurn({ transcript: [{ role: "prospect", text: "hello" }], portal: PORTAL, deviceToken: TOKEN });
  if (prev === undefined) delete process.env.AUTODIAL_GROQ_MODEL; else process.env.AUTODIAL_GROQ_MODEL = prev;
  assert.equal(seen[0], "openai/gpt-oss-120b", "an explicit override must be used first");
  assert.equal(r.text, "20b answered", "an override must not remove the fallback");
});

test("a bad model name is retried against the known-good default", async () => {
  reset();
  pk.setProviderKey("gsk_unit_test_key_value");
  const prevModel = process.env.AUTODIAL_GROQ_MODEL;
  process.env.AUTODIAL_GROQ_MODEL = "some/model-that-does-not-exist";
  const seen = [];
  stubFetch({
    provider: (url, init) => {
      seen.push(JSON.parse(init.body).model);
      return JSON.parse(init.body).model === "some/model-that-does-not-exist"
        ? json(404, { error: "model not found" })
        : json(200, { choices: [{ message: { content: "recovered" } }] });
    },
  });
  const r = await brain.nextTurn({ transcript: [{ role: "prospect", text: "hello" }], portal: PORTAL, deviceToken: TOKEN });
  if (prevModel === undefined) delete process.env.AUTODIAL_GROQ_MODEL; else process.env.AUTODIAL_GROQ_MODEL = prevModel;
  assert.equal(r.text, "recovered");
  assert.ok(seen.length >= 2, "a rejected model must be retried");
  assert.ok(seen.includes("openai/gpt-oss-20b"), `the known-good model must be tried, saw ${seen.join(",")}`);
});

test("retries stay inside the turn budget", async () => {
  reset();
  pk.setProviderKey("gsk_unit_test_key_value");
  /* The gateway is stubbed so a fallback is a measured outcome, not a crash the
   * test reports as an unrelated "no handler" error. */
  stubFetch({
    provider: () => json(429, { error: "rate limited" }, { "retry-after": "120" }),
    gateway: () => json(200, { text: "gateway answered" }),
  });
  const started = Date.now();
  const r = await brain.nextTurn({ transcript: [{ role: "prospect", text: "hello" }], portal: PORTAL, deviceToken: TOKEN });
  const elapsed = Date.now() - started;
  /* A provider asking for two minutes must not put a prospect on hold for two
   * minutes. The wait is clamped to what the deadline can afford. */
  assert.ok(elapsed < 9000, `a retry-after of 120s cost ${elapsed}ms of dead air`);
  assert.ok(r.error || r.text, "the turn must resolve one way or the other");
});

test("the key never appears in a diagnostic or an error string", async () => {
  reset();
  pk.setProviderKey("gsk_supersecretvalue123");
  stubFetch({ provider: () => json(401, { error: "invalid key gsk_supersecretvalue123" }) });
  const r = await stt.transcribeAuto(AUDIO, { portal: "", deviceToken: "" });
  assert.ok(!JSON.stringify(r).includes("gsk_supersecretvalue123"), "the key leaked into the result: " + JSON.stringify(r));
});

(async () => {
  const realFetch = global.fetch;
  let failed = 0;
  try {
    for (const [name, fn] of tests) {
      try {
        await fn();
        console.log(`  ok    ${name}`);
      } catch (e) {
        failed++;
        console.log(`  FAIL  ${name}`);
        console.log(`        ${e && e.message}`);
      }
    }
  } finally {
    global.fetch = realFetch;
    pk.clearProviderKey();
    fs.rmSync(home, { recursive: true, force: true });
  }
  if (failed) {
    console.error(`\n${failed} of ${tests.length} direct-provider behaviour tests FAILED`);
    process.exit(1);
  }
  console.log(`\nPASS: ${tests.length} direct-provider behaviour tests - order, fallback, breaker and redaction all hold`);
})();