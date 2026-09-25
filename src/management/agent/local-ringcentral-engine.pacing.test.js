"use strict";

// Live calls showed three outbound failure modes that no other suite can see:
//   1. playback that only ever resolved via the watchdog (17080ms / 4000ms in
//      watchdog-child.log) -> the voice was cut mid-sentence;
//   2. a stalled event loop dumping a whole utterance into the far-end jitter
//      buffer in one tick -> break-up on the callee's side;
//   3. RTP leaving at the wrong wall-clock rate.
// The fake Streamer below mirrors ringcentral-softphone's Streamer exactly:
// 160-byte packets, `finished` = buffer < 160, "finished" emitted from inside
// its own packet sender (which the pacer neutralises).
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createLocalRingCentralEngine } = require("./local-ringcentral-engine");

const PACKET = 160;

function makeStream({ silentFinish = false } = {}) {
  const s = new EventEmitter();
  s.buffer = Buffer.alloc(0);
  s.stop = () => { s.buffer = Buffer.alloc(0); };
  Object.defineProperty(s, "finished", { get: () => s.buffer.length < PACKET });
  s.sendPacket = function () {
    if (s.buffer.length < PACKET) return;
    s.buffer = s.buffer.subarray(PACKET);
    if (silentFinish) return;
    if (s.finished) s.emit("finished");
    else setTimeout(() => s.sendPacket(), 20);
  };
  return s;
}

function makeEngine(opts = {}) {
  const session = new EventEmitter();
  const logs = [];
  session.streamAudio = (buf) => {
    const s = makeStream(opts);
    s.buffer = buf;
    s.sendPacket(); // SDK start(): first packet leaves immediately
    return s;
  };
  const engine = createLocalRingCentralEngine({
    sip: {}, number: "15555550100",
    onAudio: () => {},
    onLog: (l) => logs.push(String(l)),
    bridgeFactory: async () => ({ ok: true, callSession: session, cleanup() {} }),
  });
  return { engine, logs };
}

const stat = (logs, kind) => {
  const line = logs.find(l => l.includes("outbound pacing:"));
  assert.ok(line, "every playback must log its send timeline");
  const burst = Number((line.match(/maxBurst (\d+)f/) || [])[1]);
  const dropped = Number((line.match(/dropped (\d+)b/) || [])[1]);
  const gap = Number((line.match(/maxGap (\d+)ms/) || [])[1]);
  const sent = Number((line.match(/outbound pacing: (\d+)\//) || [])[1]);
  return { line, burst, dropped, gap, sent, warning: line.includes("pacing warning"), kind };
};

async function main() {
  // 1. Healthy playback: 2.4s of audio must leave in ~2.4s, in frame-sized
  //    pieces, and must finish on its own rather than on the watchdog.
  {
    const { engine, logs } = makeEngine();
    await engine.connect();
    const startedAt = Date.now();
    const sent = await engine.sendAudio(Buffer.alloc(19200, 0x7f));
    const elapsed = Date.now() - startedAt;
    assert.equal(sent, 19200, "the whole utterance must be handed back");
    assert.ok(elapsed >= 2100 && elapsed <= 3000, `2.4s of audio must take ~2.4s, took ${elapsed}ms`);
    assert.ok(!logs.some(l => l.includes("outbound watchdog")), "healthy playback must never reach the watchdog");
    const s = stat(logs);
    assert.equal(s.sent, 19200, "every byte must have been sent");
    assert.ok(s.burst <= 4, `frames per tick must stay bounded, saw ${s.burst}`);
    assert.ok(s.dropped === 0, "a healthy run must not drop audio");
    engine.close();
  }

  // 2. Event-loop stall: 400ms of blocked loop must NOT turn into a 20-frame
  //    burst. The excess is skipped on the timeline and reported.
  {
    const { engine, logs } = makeEngine();
    await engine.connect();
    const playback = engine.sendAudio(Buffer.alloc(9600, 0x7f));
    await new Promise(r => setTimeout(r, 300));
    const blockUntil = Date.now() + 400;
    while (Date.now() < blockUntil) { /* deliberately stall the event loop */ }
    await playback;
    const s = stat(logs);
    assert.ok(s.burst <= 4, `a 400ms stall must not burst, saw ${s.burst} frames in one tick`);
    assert.ok(s.dropped > 0, "a stall longer than the catch-up window must skip frames instead of bursting");
    assert.ok(s.warning, "a stall must be reported as a pacing warning");
    assert.ok(!logs.some(l => l.includes("outbound watchdog")), "stalled playback must still complete without the watchdog");
    engine.close();
  }

  // 3. SDK never emits "finished" (the watchdog class from the live logs):
  //    the pacer must declare completion itself.
  {
    const { engine, logs } = makeEngine({ silentFinish: true });
    await engine.connect();
    const startedAt = Date.now();
    await engine.sendAudio(Buffer.alloc(3200, 0x7f));
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 1500, `playback must finish on its own, not after the 4000ms watchdog (took ${elapsed}ms)`);
    assert.ok(!logs.some(l => l.includes("outbound watchdog")), "the watchdog must stay a last resort");
    engine.close();
  }

  console.log("PASS outbound pacing: wall clock, bounded catch-up, self-declared finish");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
