"use strict";

/**
 * One at a time. The live portal cannot be talked to in parallel.
 *
 * Measured against the production portal, 2026-09-28:
 *
 *   8 concurrent heartbeats (~200ms each)   8/8 ok, 624ms wall
 *   1 AI request                            1/1 ok, 493ms
 *   2 concurrent AI requests                0/2 ok, 10.2s wall, both HTTP 502
 *   3 concurrent AI requests                1/3 ok, 10.5s wall
 *   1 AI + 1 heartbeat at the same time     AI 502, heartbeat 503, 10.3s
 *
 * Concurrency itself is fine - a fast request never queues behind another fast
 * request. What fails is a *slow* request overlapping anything at all. The edge
 * answers 502 at ~5s and 10s, and a single instance behind it cannot keep a
 * second in-flight request warm.
 *
 * A live call overlaps constantly: the heartbeat every 3s, the STT, the brain,
 * and research. Every one of those overlaps the others, which is why calls
 * produced "AI gateway returned non-JSON (HTTP 502)", "AI gateway timed out
 * after 7000ms", heartbeat 500s, the "I want to answer that accurately rather
 * than guess" fallbacks, and 45-second turns.
 *
 * So every portal call from this process goes through here. One in flight, FIFO.
 * Each request then gets the edge's full budget instead of being starved, and a
 * call that needs two things pays for them in sequence rather than losing both.
 */

let chain = Promise.resolve();
let depth = 0;
let peak = 0;

function withPortalSlot(fn) {
  depth++;
  if (depth > peak) peak = depth;
  const run = chain.then(fn, fn);
  // The chain must not reject, or one failure would poison every call after it.
  chain = run.then(() => { depth--; }, () => { depth--; });
  return run;
}

function inFlight() { return depth; }
function peakDepth() { return peak; }
function resetStats() { peak = depth; }

/** Wait for any portal call already running, so a caller can be deliberately
 *  sequential without holding a slot itself. */
function settled() { return chain.then(() => {}, () => {}); }

module.exports = { withPortalSlot, inFlight, peakDepth, resetStats, settled };
