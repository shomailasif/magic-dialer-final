/* The queue has to work a 7000-lead list and only stop when the customer stops
 * it or closes the app.
 *
 * Two things used to end it early. The dashboard clamped a run to 5000 calls and
 * reported it as finished, so a 7000-lead list silently lost 2000. And any single
 * portal read error, or a stretch of undialable numbers, could end the run
 * instead of stepping over it. A queue that stops quietly is worse than one that
 * is slow, because the customer believes it is calling. */
const assert = require("node:assert");
const { runQueue } = require("./lead-queue");

const PAGE = 200;
const lead = (i) => ({
  id: "L" + i, name: "Carrier " + i, phone: "+1555" + String(1000000 + i),
  status: "PENDING", createdAt: "2026-01-01T00:00:00Z",
});

/** Portal holding `total` leads, paged, with `badEvery`th lead undialable. */
function portal(total, badEvery = 0) {
  return async (url) => {
    const u = new URL(url);
    const limit = Number(u.searchParams.get("limit")) || PAGE;
    const offset = Number(u.searchParams.get("offset")) || 0;
    const slice = [];
    for (let i = offset; i < Math.min(offset + limit, total); i++) {
      const l = lead(i);
      if (badEvery && i % badEvery === 0) l.phone = "12";      // undialable
      slice.push(l);
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, count: slice.length, hasMore: offset + limit < total, offset, limit, leads: slice }) };
  };
}

async function main() {
  // 1. 7000 leads, all called, in order, nothing left behind.
  const total = 7000;
  global.fetch = portal(total);
  const called = [];
  const s = await runQueue({
    portal: "https://p", token: "t",
    placeCall: async (l) => { called.push(l.id); return { connected: true, goodLead: false }; },
    log: () => {}, gapMs: 0,
  });
  assert.equal(called.length, total, "every lead must be called, got " + called.length + " of " + total);
  assert.equal(s.attempted, total);
  assert.equal(called[0], "L0", "starts at the oldest");
  assert.equal(called[total - 1], "L" + (total - 1), "ends at the newest");
  console.log("  ok  all " + total + " leads called, oldest first, nothing skipped");

  // 2. Undialable numbers throughout must not end the run early.
  global.fetch = portal(1000, 10);
  let n = 0;
  const mixed = await runQueue({
    portal: "https://p", token: "t",
    placeCall: async () => { n++; return { connected: true, goodLead: false }; },
    log: () => {}, gapMs: 0,
  });
  assert.ok(n >= 890 && n <= 900, "expected ~900 good numbers of 1000, made " + n);
  console.log("  ok  100 undialable numbers skipped without stopping the run (" + n + " called)");

  // 3. A portal that keeps failing must be retried, not abandoned.
  let reads = 0;
  const good = portal(300);
  global.fetch = async (url) => {
    reads++;
    if (reads % 4 === 0) return { ok: false, status: 503, json: async () => ({}) };   // transient blip
    return good(url);
  };
  let made = 0;
  const flaky = await runQueue({
    portal: "https://p", token: "t",
    placeCall: async () => { made++; return { connected: true, goodLead: false }; },
    log: () => {}, gapMs: 0,
  });
  assert.equal(made, 300, "a portal that blips must not cost calls, made " + made);
  assert.ok(flaky.errors > 0, "the blips must be recorded");
  console.log("  ok  transient portal failures are retried, all " + made + " calls still placed");

  // 4. stop must still work, and must take effect promptly.
  global.fetch = portal(5000);
  let stopped = 0;
  await runQueue({
    portal: "https://p", token: "t",
    placeCall: async () => { stopped++; return { connected: true, goodLead: false }; },
    log: () => {}, gapMs: 0,
    shouldStop: () => stopped >= 5,
  });
  assert.equal(stopped, 5, "stop must be honoured immediately, made " + stopped);
  console.log("  ok  stop takes effect immediately");

  console.log("PASS: the queue works a 7000-lead list and only stops when told to");
}

main().catch((e) => { console.error("  FAIL " + e.message); process.exit(1); });
