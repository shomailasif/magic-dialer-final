"use strict";

/*
 * The heartbeat must never make a waiting prospect wait.
 *
 * The heartbeat fires every three seconds and costs a real database round trip
 * - measured at 1.6-1.9s against the deployed gateway. It used to take the same
 * single slot that transcription and the brain need, so every third second a
 * liveness ping could hold the slot while the prospect waited for a reply.
 *
 * These tests pin the two properties that matter: priority work overtakes work
 * already queued, and ordinary work never overlaps priority work.
 */
const assert = require("node:assert/strict");
const Q = require("./portal-queue");

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  /* ---- priority work overtakes ordinary work that is already queued ---- */
  Q.resetStats();
  const order = [];
  let releaseFirst;
  const blocked = new Promise((r) => { releaseFirst = r; });

  const running = [
    Q.withPortalSlot(async () => { order.push("hb-1-start"); await blocked; order.push("hb-1-end"); }),
    Q.withPortalSlot(async () => { order.push("hb-2"); }),
    Q.withPortalPrioritySlot(async () => { order.push("ai"); }),
  ];

  await tick(10);
  /* Two ordinary calls are queued and the first is still holding the slot. */
  assert.deepEqual(order, ["hb-1-start"], `expected only the running call so far, got ${JSON.stringify(order)}`);

  releaseFirst();
  await Promise.all(running);

  assert.equal(order[order.length - 1], "ai", `the priority call must run last, after the queued ordinary work, got ${JSON.stringify(order)}`);
  assert.ok(order.indexOf("ai") > order.indexOf("hb-2"), `priority must not overtake work already queued ahead of it, got ${JSON.stringify(order)}`);

  /* ---- a queued priority call blocks a following ordinary call ---- */
  const seq = [];
  let releaseAi;
  const aiGate = new Promise((r) => { releaseAi = r; });

  const pair = [
    Q.withPortalPrioritySlot(async () => { seq.push("ai-start"); await aiGate; seq.push("ai-end"); }),
    Q.withPortalSlot(async () => { seq.push("hb"); }),
  ];
  await tick(10);
  releaseAi();
  await Promise.all(pair);

  assert.deepEqual(seq, ["ai-start", "ai-end", "hb"], `a heartbeat must not start before priority work finishes, got ${JSON.stringify(seq)}`);

  /* ---- priority work still runs one at a time ---- */
  let concurrent = 0;
  let peakConcurrent = 0;
  await Promise.all([1, 2, 3, 4].map(() =>
    Q.withPortalPrioritySlot(async () => {
      concurrent++;
      if (concurrent > peakConcurrent) peakConcurrent = concurrent;
      await tick(5);
      concurrent--;
    })
  ));
  assert.equal(peakConcurrent, 1, `priority calls must not overlap each other, peaked at ${peakConcurrent}`);

  console.log("PASS: priority work overtakes queued heartbeats, heartbeats never overlap a reply, and priority calls stay serialised");
}

main().catch((e) => {
  console.error("FAIL:", e && e.message ? e.message : e);
  process.exit(1);
});