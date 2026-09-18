"use strict";

const assert = require("node:assert/strict");
const { runLocalCall } = require("./local-call-controller");

async function main() {
  let onAudio, interrupted = 0, sttBytes = 0, closed = 0;
  let finishPlayback;
  const engine = {
    async connect() {},
    sendAudio() { return new Promise(resolve => { finishPlayback = () => resolve(3200); }); },
    interrupt() { interrupted++; if (finishPlayback) finishPlayback(); },
    close() { closed++; }
  };

  let pushes = 0;
  const deps = {
    createLocalRingCentralEngine(opts) { onAudio = opts.onAudio; return engine; },
    createVad() {
      return { push() {
        pushes++;
        if (pushes <= 12) return { voiced: true, speaking: pushes >= 8, ended: false };
        return { voiced: false, speaking: true, ended: pushes >= 14 };
      }};
    },
    async speakToBuffer() { return { buffer: Buffer.alloc(3200, 0xff) }; },
    async transcribeAuto(audio) { sttBytes = audio.length; return { text: "please wait", language: "en" }; },
    async voiceCall({ speakFn, listenFn }) {
      const speaking = speakFn("Hello");
      await new Promise(r => setImmediate(r));
      for (let i = 0; i < 14; i++) onAudio(Buffer.alloc(160, 0x7f));
      await speaking;
      const heard = await listenFn({ locale: "en" });
      assert.equal(heard.text, "please wait");
      return { heard: heard.text };
    }
  };

  const result = await runLocalCall({
    config: { voip: { ready: true, username: "u", sipPassword: "p", number: "1" }, product: "test" },
    number: "2", deps
  });
  assert.equal(interrupted, 1, "sustained prospect speech must interrupt playback exactly once");
  assert.equal(pushes, 14, "inbound audio must continue through playback and listening without dropping frames");
  assert.ok(sttBytes >= 160, "prospect audio must reach STT");
  assert.equal(result.heard, "please wait");
  assert.equal(closed, 1, "engine must close");
  console.log("PASS: controller barge-in -> capture -> STT");
}
main().catch(e => { console.error(e); process.exit(1); });
