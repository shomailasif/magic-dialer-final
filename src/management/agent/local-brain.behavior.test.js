"use strict";

/* The offline brain must be an asset, never a new way to lose a call.
 *
 * These tests pin the four promises the local path makes:
 *
 *   1. "local" really answers from this PC and never touches the network.
 *   2. The prompt stays small enough to prefill on a two-core laptop.
 *   3. A broken, missing or slow local model falls through to the hosted brain
 *      inside the same turn.
 *   4. "auto" keeps the fast hosted brain first and uses the local one only when
 *      the hosted path cannot answer.
 */
const assert = require("node:assert/strict");
const http = require("node:http");
const localAi = require("./local-ai");
const health = require("./gateway-health");
const { complete, localSystemPrompt, preflightBrain } = require("./intelligent-brain");

const prevKey = process.env.GROQ_API_KEY;
const prevFetch = global.fetch;

/* A stand-in for llama-server: it records the exact request the brain sends and
 * answers in the OpenAI-compatible shape llama.cpp uses. */
function startLocal(reply, { delayMs = 0, fail = false, finish = "stop" } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{\"status\":\"ok\"}");
      return;
    }
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      seen.push(parsed);
      if (fail) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end("{\"error\":\"boom\"}");
        return;
      }
      const payload = {
        choices: [{ message: { content: reply }, finish_reason: finish }],
        usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 },
      };
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      }, delayMs);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, port: server.address().port }));
  });
}

function hostedOk(text) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: text }, finish_reason: "stop" }] }),
  });
}

function hostedFail(status = 401) {
  return async () => ({
    ok: false,
    status,
    text: async () => "no",
    json: async () => ({}),
  });
}

const CONFIG = {
  companyName: "Zaz Logistics",
  product: "LTL freight",
  persona: { name: "Alex" },
  leadFields: ["lanes", "equipment", "weekly volume"],
  locale: "en",
};

const history = [
  { role: "assistant", content: "Hi, this is Alex from Zaz Logistics. Do you have a minute?" },
  { role: "user", content: "Who is this? We run dry van out of Chicago." },
];

async function withLocal(opts, fn) {
  const local = await startLocal(opts.reply || "Alex from Zaz Logistics - which lanes do you run?", opts);
  localAi._test.reset();
  localAi._test.adopt(local.port);
  localAi._test.forceInstalled(opts.installed !== false);
  health.reset();
  try {
    await fn(local);
  } finally {
    localAi._test.reset();
    await new Promise((r) => local.server.close(r));
  }
}

async function main() {
  process.env.GROQ_API_KEY = "local-brain-test";

  // 1. "local" answers from this PC, and the hosted provider is never called.
  await withLocal({}, async (local) => {
    let hostedCalls = 0;
    global.fetch = async () => { hostedCalls++; return hostedOk("hosted reply")(); };
    const r = await complete({ history, config: { ...CONFIG, ai: { mode: "local" } } });
    assert.equal(r.text, "Alex from Zaz Logistics - which lanes do you run?", "the local reply must be used: " + JSON.stringify(r));
    assert.equal(r.path, "local");
    assert.equal(hostedCalls, 0, "a working local brain must not spend hosted tokens");
    assert.equal(local.seen.length, 1, "exactly one local request expected");
  });

  // 2. The prompt is small, the reply budget is small, and only the last
  //    exchanges travel: a 2-core laptop cannot prefill the hosted prompt.
  await withLocal({}, async (local) => {
    global.fetch = hostedOk("hosted reply");
    const long = [];
    for (let i = 0; i < 20; i++) {
      long.push({ role: i % 2 ? "assistant" : "user", content: `line ${i} ` + "x".repeat(80) });
    }
    /* A question, so the turn is answered by the model rather than by the
     * qualification policy; this case is about what the model is sent. */
    long.push({ role: "user", content: "Can you explain how it works?" });
    const r = await complete({ history: long, config: { ...CONFIG, ai: { mode: "local" } } });
    assert.equal(r.path, "local");
    const request = local.seen[0];
    assert.ok(request.max_tokens <= 20, "the local reply budget must stay small, got " + request.max_tokens);
    assert.ok(
      Array.isArray(request.stop) && request.stop.includes("\nCUSTOMER:"),
      "the model must stop when it starts writing the prospect's line",
    );
    const system = request.messages.find((m) => m.role === "system").content;
    const user = request.messages.find((m) => m.role === "user").content;
    /* 700 chars is roughly the ~150 prompt tokens that prefill in ~4s here.
     * Anything larger is time the prospect spends waiting. */
    assert.ok(system.length < 700, "the offline system prompt must stay compact, got " + system.length);
    assert.ok(user.length < 1500, "only the last exchanges may travel, got " + user.length);
    assert.equal((user.match(/^CUSTOMER:/gm) || []).length, 4, "at most four prospect turns may travel: " + user);
    assert.ok(!user.includes("line 0 "), "the oldest history must be dropped");
    assert.ok(user.endsWith("CALLER:"), "the model must be asked to continue the caller's line");
  });

  // 3. The system prompt is stable for a whole call, so llama.cpp can reuse the
  //    cached prefix instead of re-reading it every turn.
  await withLocal({}, async () => {
    const a = localSystemPrompt({ ...CONFIG, locale: "en" });
    const b = localSystemPrompt({ ...CONFIG, locale: "en" });
    assert.equal(a, b, "the cached prefix must not change between turns");
  });

  // 4. A local server that errors falls through to the hosted brain.
  await withLocal({ fail: true }, async () => {
    const hosted = [];
    global.fetch = async () => { hosted.push(1); return hostedOk("hosted answer")(); };
    const r = await complete({ history, config: { ...CONFIG, ai: { mode: "local" } } });
    assert.equal(r.text, "hosted answer", "a local failure must not cost the turn: " + JSON.stringify(r));
    assert.ok(hosted.length >= 1, "the hosted brain must be tried after a local failure");
  });

  // 5. "auto" keeps the fast hosted brain first.
  await withLocal({}, async (local) => {
    global.fetch = hostedOk("hosted first");
    const r = await complete({ history, config: { ...CONFIG, ai: { mode: "auto" } } });
    assert.equal(r.text, "hosted first");
    assert.equal(local.seen.length, 0, "auto must not pay local latency while the hosted brain answers");
  });

  // 6. "auto" rescues a rate-limited hosted brain with the local model.
  await withLocal({}, async () => {
    global.fetch = hostedFail(429);
    const r = await complete({ history, config: { ...CONFIG, ai: { mode: "auto" } } });
    assert.equal(r.path, "local-fallback", "auto must fall back to the local brain: " + JSON.stringify(r));
    assert.ok(r.text, "the fallback must produce words, not silence");
  });

  // 7. No model installed: the local path is never attempted.
  await withLocal({ installed: false }, async (local) => {
    global.fetch = hostedOk("hosted only");
    const r = await complete({ history, config: { ...CONFIG, ai: { mode: "local" } } });
    assert.equal(r.text, "hosted only");
    assert.equal(local.seen.length, 0, "an uninstalled model must not block the turn");
  });

  // 8. "hosted" opts out completely.
  await withLocal({}, async (local) => {
    global.fetch = hostedOk("hosted only");
    const r = await complete({ history, config: { ...CONFIG, ai: { mode: "hosted" } } });
    assert.equal(r.text, "hosted only");
    assert.equal(local.seen.length, 0, "hosted mode must never start the local model");
  });

  // 9. The opening instruction is an instruction, not something the prospect
  //    said; labelling it CUSTOMER: made the model answer its own setup text.
  await withLocal({}, async (local) => {
    global.fetch = hostedOk("hosted");
    await complete({
      history: [{ role: "user", content: "Start this OUTBOUND sales call now with one brief natural spoken sentence." }],
      config: { ...CONFIG, ai: { mode: "local" } },
    });
    const user = local.seen[0].messages.find((m) => m.role === "user").content;
    assert.ok(!/^CUSTOMER: Start this OUTBOUND/m.test(user), "the opening instruction must not be spoken as the prospect: " + user);
    assert.match(user, /nobody has spoken yet/, "an empty call must tell the model the line is still silent");
  });

  // 10. "auto" prewarms the fallback before the phone rings, so a rescue turn
  //     does not also pay the ~3s model load while the prospect waits.
  await withLocal({ reply: "hello" }, async (local) => {
    global.fetch = hostedOk("READY");
    const ok = await preflightBrain({ ...CONFIG, ai: { mode: "auto" } });
    assert.equal(ok, true, "the hosted preflight must still pass");
    for (let i = 0; i < 40 && !local.seen.some((s) => s.max_tokens === 1); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(
      local.seen.some((s) => s.max_tokens === 1),
      "auto must warm the local model in the background, not on the first rescue turn",
    );
  });

  // 11. "hosted" must not spend memory or CPU on a local warm.
  await withLocal({}, async (local) => {
    global.fetch = hostedOk("READY");
    await preflightBrain({ ...CONFIG, ai: { mode: "hosted" } });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(local.seen.length, 0, "hosted mode must not start the local model");
  });

  // 12. A decisive sales turn is answered by policy without starting the model:
  //     no latency, and no chance of a fabricated rate.
  await withLocal({}, async (local) => {
    global.fetch = hostedOk("hosted");
    const r = await complete({
      history: [
        { role: "assistant", content: "Hi, this is Alex from Zaz Logistics. Do you have a minute?" },
        { role: "user", content: "How much do you charge per load?" },
      ],
      config: { ...CONFIG, ai: { mode: "local" } },
    });
    assert.equal(r.path, "local-policy", "the price turn must come from policy: " + JSON.stringify(r));
    assert.equal(r.intent, "price");
    assert.doesNotMatch(r.text, /\$\s?\d|\b\d+\s*(?:dollars?|per (?:load|mile))/i, "policy must never invent a rate: " + r.text);
    assert.match(r.text, /lane/i, "the price answer must ask for the lane instead: " + r.text);
    assert.equal(local.seen.length, 0, "a policy turn must not pay the model load");
  });

  // 13. A fact-giving turn moves the checklist on without the model, so the 1B
  //     cannot answer "we run 20 trucks" with its own name or an invented
  //     number. The facts it already gave are carried in the state line (pinned
  //     in local-policy.behavior.test.js).
  await withLocal({ reply: "What lanes do you run?" }, async (local) => {
    global.fetch = hostedOk("hosted");
    const r = await complete({
      history: [
        { role: "assistant", content: "Hi, this is Alex from Zaz Logistics. Do you have a minute?" },
        { role: "user", content: "We run dry van out of Chicago, about 20 trucks." },
      ],
      config: { ...CONFIG, ai: { mode: "local" } },
    });
    assert.equal(r.path, "local-policy", "a qualification turn must not pay the model load: " + JSON.stringify(r));
    assert.equal(r.intent, "qualify");
    assert.match(r.text, /^Got it\. Which lanes do you run most\?$/, "the next missing field must be asked: " + r.text);
    assert.equal(local.seen.length, 0, "policy must answer without the model");
  });

  // 14. A completed checklist is closed by policy: the 1B must not invent a
  //     closing pitch or keep qualifying somebody who answered everything.
  await withLocal({ reply: "unused" }, async (local) => {
    global.fetch = hostedOk("hosted");
    const r = await complete({
      history: [
        { role: "assistant", content: "We dispatch freight for carriers. Which lanes do you run most?" },
        { role: "user", content: "We run dry van lanes out of Chicago, about 20 loads a week, 20 trucks." },
      ],
      config: { ...CONFIG, ai: { mode: "local" } },
    });
    assert.equal(r.path, "local-policy", "the close must not pay the model load: " + JSON.stringify(r));
    assert.equal(r.intent, "close");
    assert.match(r.text, /time|number/i, "the close must ask for an appointment: " + r.text);
    assert.equal(local.seen.length, 0, "the close must be answered without the model");
  });

  // 15. The 1B sometimes continues the transcript instead of the caller's line.
  //     A "CALLER:" prefix must never be spoken.
  await withLocal({ reply: "CALLER: Which lanes do you run?" }, async () => {
    global.fetch = hostedOk("hosted");
    const r = await complete({
      history: [{ role: "user", content: "Can you tell me more?" }],
      config: { ...CONFIG, ai: { mode: "local" } },
    });
    assert.equal(r.path, "local");
    assert.equal(r.text, "Which lanes do you run?", "a transcript label must be stripped: " + r.text);
  });

  // 16. A local reply that repeats a line the prospect already heard is not
  //     spoken again; the turn falls through to the hosted brain instead.
  await withLocal({ reply: "What lanes do you run?" }, async (local) => {
    global.fetch = hostedOk("hosted answer");
    const r = await complete({
      history: [
        { role: "assistant", content: "What lanes do you run?" },
        { role: "user", content: "Can you tell me more?" },
      ],
      config: { ...CONFIG, ai: { mode: "local" } },
    });
    assert.equal(r.text, "hosted answer", "a repeated local line must not be spoken twice: " + JSON.stringify(r));
    assert.equal(local.seen.length, 1, "the repeat is only detectable after the local model answers");
  });

  // 17. A 20-token budget can cut a sentence mid-clause. The fragment must
  //     never be spoken: keep the complete sentences, or fall through.
  await withLocal({ reply: "Our dispatch team will confirm the details, including truck type", finish: "length" }, async () => {
    global.fetch = hostedOk("hosted answer");
    const r = await complete({
      history: [{ role: "user", content: "Can you explain how it works?" }],
      config: { ...CONFIG, ai: { mode: "local" } },
    });
    assert.equal(r.text, "hosted answer", "a reply with no complete sentence must fall through: " + JSON.stringify(r));
  });

  await withLocal({ reply: "Your trucks stay loaded. The paperwork is", finish: "length" }, async () => {
    global.fetch = hostedOk("hosted answer");
    const r = await complete({
      history: [{ role: "user", content: "Can you explain how it works?" }],
      config: { ...CONFIG, ai: { mode: "local" } },
    });
    assert.equal(r.text, "Your trucks stay loaded.", "a truncated reply must stop at the last full sentence: " + r.text);
    assert.equal(r.path, "local");
  });

  console.log("PASS: the offline brain answers locally, keeps its prompt small, and never costs a turn");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    if (prevKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = prevKey;
    global.fetch = prevFetch;
  });
