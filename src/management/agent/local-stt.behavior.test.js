"use strict";

/* The offline transcriber is a fallback, and these tests pin what that means:
 *
 *   1. "local" hears from this PC and never calls the provider.
 *   2. "auto" keeps the fast hosted transcriber first.
 *   3. When the hosted transcriber cannot answer, the local one is tried in the
 *      same turn - including when this PC has no key and no gateway at all,
 *      which used to be a hard "cannot hear anything" failure.
 *   4. "hosted" never touches the local model.
 *   5. The model download is pinned, and repeated output is cut before it can
 *      reach the brain.
 */
const assert = require("node:assert/strict");
const localStt = require("./local-stt");
const health = require("./gateway-health");
const { transcribeAuto } = require("./multilingual-stt");

const prevKey = process.env.GROQ_API_KEY;
const prevFetch = global.fetch;

function hostedOk(text) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ text, language: "en" }),
    text: async () => text,
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

const AUDIO = Buffer.alloc(8000, 0xff); // one second of PCMU silence

function localText(text, seen = { calls: 0 }) {
  return async ({ language }) => {
    seen.calls++;
    seen.language = language;
    return { ok: true, text };
  };
}

function withLocal(fn, { installed = true } = {}) {
  localStt._test.reset();
  localStt._test.forceInstalled(installed);
  health.reset();
  return Promise.resolve()
    .then(fn)
    .finally(() => localStt._test.reset());
}

async function main() {
  process.env.GROQ_API_KEY = "local-stt-test";

  // 1. "local" hears from this PC, and the provider is never called.
  await withLocal(async () => {
    const seen = { calls: 0 };
    localStt._test.setRunner(localText("we run dry van out of chicago", seen));
    let fetched = 0;
    global.fetch = async () => { fetched++; return hostedOk("hosted")().then((r) => r); };
    const r = await transcribeAuto(AUDIO, { hint: "en", ai: { mode: "local" } });
    assert.equal(r.text, "we run dry van out of chicago", "local transcript must be used: " + JSON.stringify(r));
    assert.equal(r.path, "local");
    assert.equal(seen.calls, 1, "exactly one local transcription expected");
    assert.equal(seen.language, "en", "the language hint must reach the transcriber");
    assert.equal(fetched, 0, "a working local transcriber must not spend hosted quota");
  });

  // 2. "auto" keeps the hosted transcriber first.
  await withLocal(async () => {
    const seen = { calls: 0 };
    localStt._test.setRunner(localText("local", seen));
    global.fetch = hostedOk("hosted transcript");
    const r = await transcribeAuto(AUDIO, { hint: "en", ai: { mode: "auto" } });
    assert.equal(r.text, "hosted transcript");
    assert.equal(r.path, "direct");
    assert.equal(seen.calls, 0, "auto must not pay local latency while hosted answers");
  });

  // 3. A failed hosted transcription is rescued by the local one.
  await withLocal(async () => {
    localStt._test.setRunner(localText("local rescue"));
    global.fetch = hostedFail(429);
    const r = await transcribeAuto(AUDIO, { hint: "en", ai: { mode: "auto" } });
    assert.equal(r.text, "local rescue", "auto must fall back to local hearing: " + JSON.stringify(r));
    assert.equal(r.path, "local-fallback");
    assert.equal(r.after, "direct");
  });

  // 4. No hosted transcriber at all is no longer "cannot hear anything".
  await withLocal(async () => {
    localStt._test.setRunner(localText("heard offline"));
    delete process.env.GROQ_API_KEY;
    const r = await transcribeAuto(AUDIO, { hint: "en", ai: { mode: "auto" } });
    assert.equal(r.text, "heard offline", "a PC with no hosted brain must still hear: " + JSON.stringify(r));
    assert.equal(r.path, "local-fallback");
    process.env.GROQ_API_KEY = "local-stt-test";
  });

  // 5. "hosted" opts out completely.
  await withLocal(async () => {
    const seen = { calls: 0 };
    localStt._test.setRunner(localText("local", seen));
    global.fetch = hostedOk("hosted only");
    const r = await transcribeAuto(AUDIO, { hint: "en", ai: { mode: "hosted" } });
    assert.equal(r.text, "hosted only");
    assert.equal(seen.calls, 0, "hosted mode must never start the local model");
  });

  // 6. No local model: the hosted path is unchanged.
  await withLocal(async () => {
    let ran = 0;
    localStt._test.setRunner(async () => { ran++; return { ok: true, text: "x" }; });
    global.fetch = hostedOk("hosted only");
    const r = await transcribeAuto(AUDIO, { hint: "en", ai: { mode: "local" } });
    assert.equal(r.text, "hosted only");
    assert.equal(ran, 0, "an uninstalled model must not block the turn");
  }, { installed: false });

  // 7. Local silence is a real result; it must not become a phantom transcript.
  await withLocal(async () => {
    localStt._test.setRunner(async () => ({ ok: true, text: "   " }));
    global.fetch = hostedOk("hosted after silence");
    const r = await transcribeAuto(AUDIO, { hint: "en", ai: { mode: "local" } });
    assert.equal(r.text, "hosted after silence", "an empty local transcript must not be spoken");
  });

  // 8. Timestamps and repeated phrases never reach the brain.
  assert.equal(localStt.clean("[00:00:01.000 --> 00:00:02.000]  hello   there"), "hello there");
  const looped = localStt.clean("we need freight " + "we need freight ".repeat(20));
  assert.ok(looped.length < 60, "a looping decoder must be cut, got: " + looped);

  // 9. The WAV handed to whisper is 16 kHz mono 16-bit, with every 8 kHz
  //    sample doubled.
  const wav = localStt.pcmuToWav16k(Buffer.alloc(100, 0xff));
  assert.equal(wav.slice(0, 4).toString(), "RIFF");
  assert.equal(wav.readUInt32LE(24), 16000, "sample rate must be 16 kHz");
  assert.equal(wav.readUInt16LE(22), 1, "must be mono");
  assert.equal(wav.readUInt16LE(34), 16, "must be 16-bit");
  assert.equal(wav.length, 44 + 400, "one 8 kHz sample must become two 16 kHz samples");

  // 10. The model is pinned so a swapped download cannot run.
  assert.equal(localStt.MODEL_FILE, "ggml-tiny.bin");
  assert.equal(localStt.MODEL_BYTES, 77691713);
  assert.equal(localStt.MODEL_SHA256, "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21");
  assert.ok(localStt.LOCAL_TIMEOUT_MS <= 5000, "the local attempt must leave room in the STT turn budget");

  // 11. "local" first, then hosted, when the local attempt produces nothing.
  await withLocal(async () => {
    const seen = { calls: 0 };
    localStt._test.setRunner(async () => { seen.calls++; return { ok: false, error: "whisper exited 1" }; });
    global.fetch = hostedOk("hosted fallback");
    const r = await transcribeAuto(AUDIO, { hint: "en", ai: { mode: "local" } });
    assert.equal(r.text, "hosted fallback");
    assert.equal(seen.calls, 1, "the local attempt must happen exactly once");
    assert.equal(r.path, "direct");
  });

  console.log("PASS: offline hearing answers locally, keeps hosted first in auto, and never costs a turn");
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
    localStt._test.reset();
  });
