"use strict";

const assert = require("node:assert/strict");
const { runLocalCall } = require("./local-call-controller");

async function main() {
  let onAudio, interrupted = 0, sttBytes = 0, closed = 0, sipSeen = null, sttOpts = null;
  let finishPlayback;
  const engine = {
    async connect() {},
    sendAudio() { return new Promise(resolve => { finishPlayback = () => resolve(3200); }); },
    interrupt() { interrupted++; if (finishPlayback) finishPlayback(); },
    keepAlive() { return Promise.resolve(0); },
    close() { closed++; }
  };

  let pushes = 0;
  const deps = {
    async preflightBrain() { return true; },
    async opening() { return { text: "Hello" }; },
    createLocalRingCentralEngine(opts) {
      sipSeen = opts.sip;
      onAudio = opts.onAudio;
      return {
        ...engine,
        async waitForInboundMedia() { return { gotInbound: true, waitedMs: 5 }; },
      };
    },
    createVad() {
      return { push() {
        pushes++;
        // 1s opening guard (50 frames), then loud sustained speech so the
        // protected-opening barge-in path (level>=500, 700ms) can fire.
        if (pushes <= 50) return { voiced: false, speaking: false, ended: false, level: 0 };
        if (pushes <= 85) return { voiced: true, speaking: pushes >= 58, ended: false, level: 600 };
        return { voiced: false, speaking: true, ended: pushes >= 89, level: 0 };
      }};
    },
    async speakToBuffer() { return { buffer: Buffer.alloc(3200, 0xff), engine: "test" }; },
    async transcribeAuto(audio, opts) { sttBytes = audio.length; sttOpts = opts; return { text: "please wait", language: "en" }; },
    async voiceCall({ speakFn, listenFn }) {
      const speaking = speakFn("Hello");
      await new Promise(r => setImmediate(r));
      // 1s guard + 700ms protected-opening barge-in + end frames
      for (let i = 0; i < 89; i++) onAudio(Buffer.alloc(160, 0x7f));
      await speaking;
      const heard = await listenFn({ locale: "en" });
      assert.equal(heard.text, "please wait");
      return { heard: heard.text };
    }
  };

  const result = await runLocalCall({
    config: { voip: { ready: true, username: "u", sipPassword: "p", authId: "auth-7", domain: "sip.example.test", server: "proxy.example.test", port: 5096, number: "1" }, product: "test", portalUrl: "https://portal.example.test", deviceToken: "device-secret" },
    number: "2", deps
  });
  assert.equal(interrupted, 1, "sustained prospect speech must interrupt playback exactly once");
  assert.equal(pushes, 89, "inbound audio must continue through playback and listening without dropping frames");
  assert.ok(sttBytes >= 160, "prospect audio must reach STT");
  assert.equal(result.heard, "please wait");
  assert.ok(sttBytes >= 160 * 30, "captured turn must retain speech frames through barge-in");
  assert.equal(closed, 1, "engine must close");
  assert.equal(sipSeen.authId, "auth-7"); assert.equal(sipSeen.domain, "sip.example.test"); assert.equal(sipSeen.proxy, "proxy.example.test");
  assert.equal(sttOpts.portal, "https://portal.example.test"); assert.equal(sttOpts.deviceToken, "device-secret");

  let engineAttempted = false;
  await assert.rejects(
    () => runLocalCall({
      config: { voip: { ready: true, username: "u", sipPassword: "p", number: "1" }, product: "test" },
      number: "2",
      deps: {
        async preflightBrain() { return true; },
        async opening() { return { text: "Hello" }; },
        async speakToBuffer() { return null; },
        createLocalRingCentralEngine() { engineAttempted = true; return engine; },
      },
    }),
    /TTS preflight failed/
  );
  assert.equal(engineAttempted, false, "failed TTS preflight must block engine creation and dialing");

  let engineCreated = false;
  await assert.rejects(
    () => runLocalCall({
      config: { voip: { ready: true, username: "u", sipPassword: "bad", number: "1" }, product: "test" },
      number: "2",
      deps: {
        async preflightBrain() { return true; },
        async opening() { return { text: "Hello" }; },
        async speakToBuffer() { return { buffer: Buffer.alloc(3200, 0xff), engine: "test" }; },
        createLocalRingCentralEngine() {
          engineCreated = true;
          return { ...engine, async connect() { throw new Error("403 Forbidden"); } };
        },
      },
    }),
    /403 Forbidden/
  );
  assert.equal(engineCreated, true, "live engine must own SIP registration attempt");
  console.log("PASS: controller single SIP engine + barge-in -> capture -> STT");
}
main().catch(e => { console.error(e); process.exit(1); });
