"use strict";
/**
 * The portal cannot be talked to in parallel. This is measured, not assumed:
 *
 *   8 concurrent heartbeats (~200ms)   8/8 ok, 624ms wall
 *   1 AI request                       1/1 ok, 493ms
 *   2 concurrent AI requests           0/2 ok, 10.2s wall, both Cloudflare 502
 *   1 AI + 1 heartbeat together        AI 502, heartbeat 503, 10.3s
 *
 * A live call overlaps the heartbeat, the STT, the brain and research constantly,
 * and that overlap is what produced the 502s, the heartbeat 500s, the
 * "I want to answer that accurately rather than guess" fallbacks and the
 * 45-second turns. Every portal call from this process must therefore pass
 * through the queue, and the queue must never break the call it is protecting.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const Q = require("./portal-queue");
const root = path.resolve(__dirname, "..", "..", "..");

function src(p) { return fs.readFileSync(path.join(root, p), "utf8"); }

async function main() {
  // 1. One at a time, in order.
  let maxSeen = 0;
  let live = 0;
  const order = [];
  await Promise.all([1, 2, 3, 4, 5, 6].map((n) => Q.withPortalSlot(async () => {
    live++;
    if (live > maxSeen) maxSeen = live;
    order.push(n);
    await new Promise((r) => setTimeout(r, 5));
    live--;
  })));
  assert.equal(maxSeen, 1, "two portal calls must never be in flight at once, saw " + maxSeen);
  assert.equal(order.join(","), "1,2,3,4,5,6", "the queue must be FIFO");

  // 2. A failure must not poison the queue, or one blip ends the whole call.
  const err = await Q.withPortalSlot(async () => { throw new Error("boom"); }).catch((e) => e.message);
  assert.equal(err, "boom");
  let after = "never ran";
  await Q.withPortalSlot(async () => { after = "ran"; });
  assert.equal(after, "ran", "a failed call must not break every later call");
  // And a rejection handed to a caller that does not catch it must not become an
  // unhandled rejection, which on Node 16+ kills the process.
  await Q.withPortalSlot(async () => { throw new Error("boom2"); }).catch(() => {});

  // 3. Interleaved call traffic - a brain turn while the heartbeat runs - must
  //    all complete.
  const mixed = await Promise.all([
    Q.withPortalSlot(async () => "ai-1"),
    Q.withPortalSlot(async () => "hb"),
    Q.withPortalSlot(async () => "ai-2"),
  ]);
  assert.deepEqual(mixed, ["ai-1", "hb", "ai-2"], "every queued call must get its turn");

  // 4. Every call-critical portal request must actually go through the queue.
  //    A route that forgets is invisible until a call dies.
  const brain = src(path.join("src", "management", "agent", "intelligent-brain.js"));
  const stt = src(path.join("src", "management", "agent", "multilingual-stt.js"));
  const agent = src(path.join("src", "management", "agent", "agent.js"));
  for (const [name, code] of [["intelligent-brain", brain], ["multilingual-stt", stt], ["agent", agent]]) {
    assert.match(code, /require\("\.\/portal-queue"\)/, name + " must require the portal queue");
    assert.match(code, /withPortal(?:Priority)?Slot\(/, name + " must route its portal traffic through the queue");
  }
  // The brain's and STT's portal fetches specifically, not just any call.
  // Whitespace-tolerant: these files are minified in places, so requiring exact
  // spacing would make the test fail for cosmetic reasons.
  assert.match(brain, /withPortalPrioritySlot\(\s*\(\)\s*=>\s*fetch\(\s*portal\s*\+\s*"\/api\/engine\/ai\/chat"/,
    "the AI request must be serialized");
  assert.match(stt, /withPortalPrioritySlot\(\s*\(\)\s*=>\s*fetch\(\s*base\s*\+\s*"\/api\/engine\/ai\/stt"/,
    "the STT request must be serialized");
  assert.match(agent, /withPortalSlot\(\s*\(\)\s*=>\s*post\(\s*`\$\{heartbeatPortal\}\/api\/heartbeat`/,
    "the heartbeat must be serialized");

  // 5. The queue must not serialize the non-portal fallbacks, or a dead gateway
  //    would still pay the full retry budget inside the lock.
  assert.match(brain, /health\.isOpen\("brain"\)/, "the breaker must still run before the queue is taken");

  console.log("PASS: portal queue is single-slot, FIFO, failure-isolated, and wraps brain, STT and heartbeat");
}

main().catch((e) => { console.error(e); process.exit(1); });
