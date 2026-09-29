"use strict";
/**
 * The queue must never be the thing that wastes the customer's line time.
 *
 *  - one call at a time, the next one starting as soon as the previous ends
 *  - a number we cannot dial is skipped, not retried in place
 *  - a portal read failure pauses rather than ending the campaign
 *  - the queue stops on request, and stops at maxCalls
 *  - qualification is counted, not emailed from here: the portal already emailed
 *    it the moment the result arrived, and sending it twice is worse than not
 */

const assert = require("node:assert");
const { runQueue, dialable, fetchDueLeads } = require("./lead-queue");

function lead(i, over) {
  return { id: "L" + i, name: "Lead " + i, phone: "+1555000" + String(1000 + i), status: "PENDING", createdAt: "2026-01-0" + (i + 1) + "T00:00:00Z", ...over };
}

function stubPortal(leads) {
  return async () => ({ ok: true, status: 200, json: async () => ({ leads }) });
}

async function main() {
  // 1. Unusable leads are never dialled.
  assert.equal(dialable(lead(1)), true);
  assert.equal(dialable(lead(2, { phone: "12" })), false, "too short must not be dialled");
  assert.equal(dialable(lead(3, { doNotCall: true })), false, "do-not-call must never be dialled");
  assert.equal(dialable(lead(4, { consentStatus: "DENIED" })), false, "denied consent must never be dialled");
  assert.equal(dialable(null), false);

  // 2. The whole list is worked, in order, back to back.
  const list = [1, 2, 3, 4].map((i) => lead(i));
  global.fetch = stubPortal(list);
  const called = [];
  const s = await runQueue({
    portal: "https://p", token: "t",
    placeCall: async (l) => { called.push(l.id); return { connected: true, goodLead: l.id === "L2" }; },
    log: () => {}, gapMs: 0,
  });
  assert.equal(called.length, 4, "every lead must be called, got " + called.join(","));
  assert.deepEqual(called, ["L1", "L2", "L3", "L4"], "order must be oldest first");
  assert.equal(s.attempted, 4);
  assert.equal(s.connected, 4);
  assert.equal(s.qualified, 1, "only the reported lead counts as qualified");

  // 3. maxCalls is honoured - it is the safety stop.
  global.fetch = stubPortal([1, 2, 3, 4, 5].map((i) => lead(i)));
  let n = 0;
  const limited = await runQueue({
    portal: "https://p", token: "t",
    placeCall: async () => { n++; return { connected: true, goodLead: false }; },
    log: () => {}, gapMs: 0, maxCalls: 2,
  });
  assert.equal(n, 2, "maxCalls must stop the queue, made " + n);
  assert.equal(limited.attempted, 2);

  // 4. shouldStop is honoured between calls.
  global.fetch = stubPortal([1, 2, 3].map((i) => lead(i)));
  let made = 0;
  await runQueue({
    portal: "https://p", token: "t",
    placeCall: async () => { made++; return { connected: false, goodLead: false }; },
    log: () => {}, gapMs: 0, shouldStop: () => made >= 2,
  });
  assert.equal(made, 2, "stop must take effect after the current call, made " + made);

  // 5. A lead that cannot be called does not stall the queue.
  global.fetch = stubPortal([lead(1, { phone: "nope" }), lead(2), lead(3)]);
  const seen = [];
  await runQueue({
    portal: "https://p", token: "t",
    placeCall: async (l) => { seen.push(l.id); return { connected: true, goodLead: false }; },
    log: () => {}, gapMs: 0,
  });
  assert.deepEqual(seen, ["L2", "L3"], "an undiallable lead must be skipped, not retried in place");

  // 6. A portal read failure pauses the campaign instead of ending it.
  let reads = 0;
  global.fetch = async () => { reads++; if (reads === 1) return { ok: false, status: 503 }; return { ok: true, status: 200, json: async () => ({ leads: [lead(9)] }) }; };
  const out = await runQueue({
    portal: "https://p", token: "t",
    placeCall: async () => ({ connected: true, goodLead: false }),
    log: () => {}, gapMs: 0, maxCalls: 1,
  });
  assert.equal(out.errors, 1, "the failed read must be recorded");
  assert.equal(out.attempted, 1, "the campaign must continue after a failed read");

  // 7. A call that throws is recorded and the queue continues.
  global.fetch = stubPortal([1, 2].map((i) => lead(i)));
  const mixed = await runQueue({
    portal: "https://p", token: "t",
    placeCall: async (l) => { if (l.id === "L1") throw new Error("no answer"); return { connected: true, goodLead: false }; },
    log: () => {}, gapMs: 0, maxCalls: 2,
  });
  assert.equal(mixed.errors, 1);
  assert.ok(mixed.results.some((r) => r.error), "a failed call must be recorded, not lost");

  console.log("PASS: lead queue - no idle time, bad numbers skipped, survives a portal blip, stops on request");
}

main().catch((e) => { console.error(e); process.exit(1); });
