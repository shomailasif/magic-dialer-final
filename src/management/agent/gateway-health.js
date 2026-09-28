"use strict";

/**
 * Circuit breaker for the two portal gateways the conversation depends on:
 * the STT gateway (hearing the prospect) and the AI gateway (thinking).
 *
 * Why this exists, from the 20:40Z call:
 *
 *   20:41:08  prospect speaks
 *   20:41:14  STT attempt 1/4 failed: exceeded 6000ms
 *   20:41:20  STT attempt 2/4 failed
 *   20:41:26  STT attempt 3/4 failed
 *   20:41:33  STT attempt 4/4 failed
 *   20:41:41  AGENT: Sorry, I did not catch that clearly.
 *
 *   45 seconds of silence for a two-word answer, and then the same 45 seconds
 *   again on the next turn, and the next. Every turn paid the full retry budget
 *   because nothing remembered that the gateway was already down. That is what
 *   "delays are still large" is: not per-turn slowness, but the same outage
 *   billed again and again.
 *
 * So: after a few consecutive failures, stop paying. Fail fast, say something
 * short and human, and let the call limp on until the gateway recovers.
 */

const WINDOW_MS = 45000;
const TRIP_AFTER = 3;      // consecutive failures before the breaker opens
const OPEN_MS = 30000;     // how long to fail fast before trying again
const HALF_OPEN = 1;       // one probe allowed through while half-open

const state = new Map();

function key(name) { return String(name || "default"); }

function get(name) {
  const k = key(name);
  let s = state.get(k);
  if (!s) { s = { failures: 0, openedAt: 0, probing: false, lastOkAt: 0 }; state.set(k, s); }
  return s;
}

/** True when calls should be skipped without hitting the network. */
function isOpen(name) {
  const s = get(name);
  if (!s.openedAt) return false;
  if (Date.now() - s.openedAt >= OPEN_MS) {
    // Half-open: let exactly one probe through to test the water.
    if (!s.probing) { s.probing = true; return false; }
    return true;
  }
  return true;
}

function recordSuccess(name) {
  const s = get(name);
  s.failures = 0;
  s.openedAt = 0;
  s.probing = false;
  s.lastOkAt = Date.now();
}

function recordFailure(name) {
  const s = get(name);
  s.failures++;
  if (s.probing) {
    // The probe failed: back to fully open.
    s.probing = false;
    s.openedAt = Date.now();
    return;
  }
  if (s.failures >= TRIP_AFTER) s.openedAt = Date.now();
}

/** Why the breaker is open, for the log. Empty when it is closed. */
function reason(name) {
  const s = get(name);
  if (!s.openedAt) return "";
  const left = Math.max(0, OPEN_MS - (Date.now() - s.openedAt));
  return `after ${s.failures} consecutive failures, failing fast for ${Math.ceil(left / 1000)}s`;
}

/** Test/reset hook. */
function reset(name) {
  if (name) state.delete(key(name));
  else state.clear();
}

module.exports = { isOpen, recordSuccess, recordFailure, reason, reset, TRIP_AFTER, OPEN_MS };
