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

/*
 * Two queues, and the reason is a live turn rather than throughput.
 *
 * The heartbeat fires every three seconds and takes the same single slot that
 * STT and the brain need. Measured against the deployed gateway an authorized
 * heartbeat costs 1.6-1.9s - not because it is slow, but because it is a real
 * database round trip. So every third second there is a good chance the slot is
 * held by a liveness ping while the prospect is waiting for a reply, and the
 * prospect pays for it. Nothing about that ping is urgent: if it is delayed by
 * one turn, the only cost is a missed heartbeat.
 *
 * So priority work - transcription and the brain, both on the critical path of
 * the conversation - jumps the queue, while ordinary work like the heartbeat
 * runs only when no priority call is waiting or in flight. Ordering within a
 * class is still FIFO, so this cannot reorder two pieces of the same
 * conversation, and ordinary work still runs alone.
 */
let priorityWaiting = 0;
let priorityActive = false;

function withPortalSlot(fn, opts) {
  const priority = !!(opts && opts.priority);
  depth++;
  if (depth > peak) peak = depth;
  if (priority) priorityWaiting++;
  const task = () => {
    if (priority) {
      priorityActive = true;
      return Promise.resolve().then(fn).finally(() => { priorityActive = false; });
    }
    /* Ordinary work waits while priority work is queued or running, and */
    /* re-checks after each predecessor, because a priority call may have been */
    /* enqueued while this one was already waiting its turn. */
    const waitForPriority = () =>
      priorityActive || priorityWaiting > 0
        ? chain.then(waitForPriority, waitForPriority)
        : Promise.resolve();
    return waitForPriority().then(fn);
  };
  const run = chain.then(task, task);
  if (priority) priorityWaiting--;
  // The chain must not reject, or one failure would poison every call after it.
  chain = run.then(() => { depth--; }, () => { depth--; });
  return run;
}

/** Priority variant, for anything a waiting prospect is blocked on. */
function withPortalPrioritySlot(fn) { return withPortalSlot(fn, { priority: true }); }

function inFlight() { return depth; }
function peakDepth() { return peak; }
function resetStats() { peak = depth; }

/** Wait for any portal call already running, so a caller can be deliberately
 *  sequential without holding a slot itself. */
function settled() { return chain.then(() => {}, () => {}); }

module.exports = { withPortalSlot, withPortalPrioritySlot, inFlight, peakDepth, resetStats, settled };
