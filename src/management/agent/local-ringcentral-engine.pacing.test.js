"use strict";

// Live calls showed four outbound failure modes that no other suite can see:
//   1. playback that only ever resolved via the watchdog (17080ms / 4000ms in
//      watchdog-child.log) -> the voice was cut mid-sentence;
//   2. a stalled event loop dumping a whole utterance into the far-end jitter
//      buffer in one tick -> break-up on the callee's side;
//   3. RTP leaving at the wrong wall-clock rate;
//   4. RTP stopping altogether between turns (15s with zero outbound packets
//      on the 1.4.17 live call) -> the callee's jitter buffer drains and every
//      reply starts cold, which is what the lead reported as voice breaking.
// The fake Streamer below mirrors ringcentral-softphone's Streamer exactly:
// 160-byte packets, `finished` = buffer < 160, "finished" emitted from inside
// its own packet sender (which the pacer neutralises).
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createLocalRingCentralEngine } = require("./local-ringcentral-engine");

const PACKET = 160;

/* Windows wakes timers on the ~15.6ms system tick, and under load a tick can
 * slip 50-90ms. Measured on this box: maxGap 57/84/87ms with slowGaps 6/12/3
 * across three identical runs of scenario 1, i.e. the old fixed "gap < 60 &&
 * slow <= 2" bound was asserting the host's timer jitter, not engine logic --
 * it passed or failed on machine load alone. A genuine stall is still caught
 * deterministically by scenarios 2 and 3 (dropped > 0 + a pacing warning), so
 * the healthy-path bound is derived from the host's own jitter floor instead of
 * a hardcoded number, with a hard ceiling that no real break-up can hide under. */
async function hostTimerJitterFloor(samples = 40) {
  let max = 0;
  for (let i = 0; i < samples; i++) {
    const want = Date.now() + 8;
    await new Promise((r) => setTimeout(r, 8));
    const d = Date.now() - want;
    if (d > max) max = d;
  }
  return max;
}

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
  const slow = Number((line.match(/slowGaps (\d+)f/) || [])[1]);
  const sent = Number((line.match(/outbound pacing: (\d+)\//) || [])[1]);
  return { line, burst, dropped, gap, slow, sent, warning: line.includes("pacing warning"), kind };
};

async function main() {
  // 0. What this host can actually promise. Feeds the healthy-path bound below.
  const jitterFloor = await hostTimerJitterFloor();
  const GAP_CEILING = 200; // a real break-up is hundreds of ms; never hide under this
  const gapBound = Math.min(GAP_CEILING, Math.max(60, jitterFloor * 4));
  // Observed slowGaps track the jitter floor almost linearly: floor 38-39ms gave
  // slowGaps 12, floor 30ms gave 3, floor 17ms gave 0-1 over 120 frames.
  const slowBound = Math.max(2, Math.ceil((19200 / PACKET) * (jitterFloor / 400)));
  console.log(`host timer jitter floor ${jitterFloor}ms -> healthy-path bounds: maxGap<=${gapBound}ms slowGaps<=${slowBound}`);

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
    // The 1.4.17 live log showed maxGap 33-48ms against a 20ms frame grid:
    // Windows wakes us every ~15.6ms, so the only defence is running ahead of
    // the clock. The SDK's start() has already sent 1 frame, so a 480-byte
    // due-count must push 2 more in that first tick.
    assert.ok(s.burst >= 2, `the first tick must prime the callee buffer with send-ahead, saw ${s.burst} frames`);
    assert.ok(s.gap <= gapBound && s.slow <= slowBound, `outbound gaps must stay bounded, saw maxGap ${s.gap}ms slowGaps ${s.slow} (host jitter floor ${jitterFloor}ms)`);
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

  // 4. Between turns the engine must keep sending RTP. The 1.4.17 live call
  //    logged 15s stretches with zero outbound packets while listening; the
  //    callee's buffer drained and the next reply arrived cold.
  {
    const { engine, logs } = makeEngine();
    await engine.connect();
    const before = engine.status().bytesOut;
    await new Promise(r => setTimeout(r, 450));
    const after = engine.status().bytesOut;
    assert.ok(after >= before + 800 * 2, `idle RTP must keep flowing (bytesOut ${before} -> ${after})`);
    assert.ok(logs.some(l => l.includes("keep-alive silence")), "the first keep-alive must be reported in the log");
    engine.close();
    assert.ok(logs.some(l => l.includes("keep-alive sends")), "media stats must report keep-alive activity");
  }

  console.log("PASS outbound pacing: wall clock, bounded catch-up, self-declared finish, idle RTP");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
