/* A suspended or unreachable portal must not stop the campaign.
 *
 * The engine already survived a portal blip: it retried every 5 seconds and
 * carried on. What it could not do was make a single call during that time,
 * because the due-lead list lived only on the portal. A suspension is not a
 * blip - it lasts until someone fixes the account - so retry-forever means a
 * customer whose hosting is suspended sits at zero calls with a dashboard that
 * looks healthy, because "Portal briefly unavailable" reads as a moment.
 *
 * So the queue now keeps a local copy of the list the portal last handed it,
 * and reads from that when the portal cannot be reached.
 *
 * Two things must hold while it does, or offline mode is worse than no
 * offline mode:
 *
 *  1. A lead already dialled is not dialled again from the copy. The portal
 *     normally marks them, and there is no portal during an outage, so the
 *     copy has to remember itself.
 *
 *  2. A refusal is not forgotten. The result POST 404s during an outage, so
 *     the portal never learns the prospect said stop - and a portal that
 *     comes back still lists them as due. Forgetting that turns one refusal
 *     into a second call, which is the failure the whole spoken-opt-out work
 *     exists to prevent.
 */
const assert = require("node:assert");
const { runQueue } = require("./lead-queue");

const lead = (i) => ({
  id: "L" + i, name: "Carrier " + i, phone: "+1555" + String(1000000 + i),
  status: "PENDING", createdAt: "2026-01-01T00:00:00Z",
});

/** An in-memory stand-in for local-db's cache tables. */
function makeCache() {
  const byPhone = new Map();
  const refused = new Set();
  return {
    cacheLeads(leads) {
      for (const l of leads) {
        const p = String(l.phone || "");
        if (!p) continue;
        // An existing entry keeps its called mark: re-caching must not make a
        // dialled subscriber dialable again.
        const prev = byPhone.get(p);
        byPhone.set(p, { lead: l, called: prev ? prev.called : false });
      }
      return leads.length;
    },
    cachedLeads() {
      return [...byPhone.values()]
        .filter((e) => !e.called && !refused.has(e.lead.phone))
        .map((e) => e.lead);
    },
    markCachedLeadCalled(phone) {
      const e = byPhone.get(String(phone));
      if (e) e.called = true;
    },
    addDoNotCall(phone) { refused.add(String(phone)); },
    isDoNotCall(phone) { return refused.has(String(phone)); },
    _refused: refused,
  };
}

/** Portal serving `total` leads until it is switched off. */
function portalFor(total) {
  let up = true;
  const fn = async (url) => {
    if (!up) throw new Error("connect ECONNREFUSED");
    const u = new URL(url);
    const limit = Number(u.searchParams.get("limit")) || 200;
    const offset = Number(u.searchParams.get("offset")) || 0;
    const slice = [];
    for (let i = offset; i < Math.min(offset + limit, total); i++) slice.push(lead(i));
    return { ok: true, status: 200, json: async () => ({ leads: slice, hasMore: offset + limit < total, offset, limit }) };
  };
  fn.set = (v) => { up = v; };
  return fn;
}

async function main() {
  const quiet = () => {};
  const logs = [];

  // 1. While the portal is healthy it is the source of truth, and every lead
  //    it serves is remembered locally.
  const cache1 = makeCache();
  const portal1 = portalFor(50);
  global.fetch = portal1;
  const seen1 = [];
  await runQueue({
    portal: "https://p", token: "t", cache: cache1,
    placeCall: async (l) => { seen1.push(l.phone); return { connected: true, goodLead: false }; },
    log: (m) => logs.push(m), gapMs: 0, maxCalls: 10,
  });
  assert.equal(seen1.length, 10, "the live portal must be used while it is up, got " + seen1.length);
  assert.equal(cache1.cachedLeads().length, 40, "the 10 called must be excluded, the 40 untouched must remain");
  console.log("  ok  a healthy portal is used and its list is cached (" + cache1.cachedLeads().length + " left)");

  // 2. Portal goes down. The campaign carries on from the saved list rather
  //    than spinning on retries, and it says so.
  //
  //    Stopped once the saved list is consumed rather than left to run: with
  //    nothing left to read and the portal still down the queue correctly
  //    reverts to polling every 5s (a campaign waiting for its source is the
  //    right behaviour), which would hang this test rather than finish it.
  portal1.set(false);
  logs.length = 0;
  const seen2 = [];
  /* Wall-clock bound as well as a completion condition.
   *
   * Without the cache the queue polls the dead portal every 5s for ever -
   * correct behaviour, and exactly what this test exists to prove has changed.
   * But a test that stalls on the old behaviour hangs the suite instead of
   * failing it, and a hang is not a failure anyone can read. So the run also
   * stops when it runs out of time, which turns "the feature is missing" into
   * a fast assertion failure rather than a stuck build. */
  const deadline = Date.now() + 20000;
  await runQueue({
    portal: "https://p", token: "t", cache: cache1,
    placeCall: async (l) => { seen2.push(l.phone); return { connected: true, goodLead: false }; },
    log: (m) => logs.push(m), gapMs: 0,
    shouldStop: () => seen2.length >= 40 || Date.now() > deadline,
  });
  assert.equal(seen2.length, 40, "all 40 cached leads must be called with the portal down, got " + seen2.length);
  assert.ok(!seen2.includes(seen1[0]), "a lead already called must not be called again from the copy");
  assert.ok(logs.some((m) => /local lead list/i.test(m)),
    "the operator must be told the campaign is running from a saved copy, logs: " + JSON.stringify(logs.slice(0, 3)));
  console.log("  ok  portal down: " + seen2.length + " called from cache, none repeated, and it says so");

  // 2b. The saved list finishing must END the queue, not leave it polling.
  //     Seed the cache directly with numbers that cannot be dialled, so the
  //     list is non-empty on every read and nothing is ever called - the case
  //     where a queue reads forever without doing work.
  const cacheDry = makeCache();
  cacheDry.cacheLeads([{ id: "X1", phone: "12", name: "bad" }, { id: "X2", phone: "", name: "none" }]);
  global.fetch = async () => { throw new Error("connect ECONNREFUSED"); };
  const dryLogs = [];
  await runQueue({
    portal: "https://p", token: "t", cache: cacheDry,
    placeCall: async () => assert.fail("nothing dialable may be called"),
    log: (m) => dryLogs.push(m), gapMs: 0, maxCalls: 5,
  });
  assert.ok(dryLogs.some((m) => /Queue finished/i.test(m)),
    "an exhausted saved list must end the queue, logs: " + JSON.stringify(dryLogs));
  console.log("  ok  an undialable saved list ends the queue instead of polling");

  // 3. Nothing cached, portal down: the queue retries rather than declaring
  //    an empty list - an empty read is not the same as an empty campaign.
  global.fetch = async () => { throw new Error("connect ECONNREFUSED"); };
  let reads = 0;
  global.fetch = async () => { reads++; throw new Error("connect ECONNREFUSED"); };
  const s3 = await runQueue({
    portal: "https://p", token: "t", cache: makeCache(),
    placeCall: async () => ({ connected: true, goodLead: false }),
    log: quiet, gapMs: 0, maxCalls: 1, shouldStop: () => reads >= 3,
  });
  assert.ok(reads >= 3, "with no cache the portal must keep being asked, asked " + reads + " times");
  assert.equal(s3.attempted, 0, "nothing may be called when nothing is known");
  console.log("  ok  no cache and no portal: keeps retrying, dials nothing");

  // 4. The refusal survives the outage and the return. This is the one that
  //    must never regress.
  const cache4 = makeCache();
  const portal4 = portalFor(4);
  global.fetch = portal4;
  const dialled = [];
  let refuse = false;
  // Prime the cache with 4 leads without calling any: read once, stop immediately.
  await runQueue({
    portal: "https://p", token: "t", cache: cache4,
    placeCall: async (l) => { dialled.push(l.phone); return { connected: true, goodLead: false, doNotCall: refuse }; },
    log: quiet, gapMs: 0, maxCalls: 1, shouldStop: () => dialled.length >= 1,
  });
  assert.equal(cache4.cachedLeads().length, 3, "3 leads must remain after 1 was called");

  portal4.set(false);
  refuse = true;   // this call is a refusal
  await runQueue({
    portal: "https://p", token: "t", cache: cache4,
    placeCall: async (l) => { dialled.push(l.phone); return { connected: true, goodLead: false, doNotCall: true }; },
    log: quiet, gapMs: 0, maxCalls: 1,
  });
  assert.equal(cache4._refused.size, 1, "the refusal must be remembered locally");
  assert.equal(cache4.cachedLeads().length, 2, "the refused lead must leave the dialable set");

  // Portal comes back and still lists everyone as due - it never saw the result.
  portal4.set(true);
  const before = dialled.length;
  await runQueue({
    portal: "https://p", token: "t", cache: cache4,
    placeCall: async (l) => { dialled.push(l.phone); return { connected: true, goodLead: false, doNotCall: false }; },
    log: quiet, gapMs: 0,
  });
  const refusedPhone = [...cache4._refused][0];
  assert.ok(!dialled.slice(before).includes(refusedPhone),
    "the refused number must never be dialled again, even from a live portal that lists it as due");
  console.log("  ok  a refusal during the outage is remembered and never dialled again");

  // 5. Re-caching must not resurrect a lead this PC already called.
  const cache5 = makeCache();
  const p5 = portalFor(3);
  global.fetch = p5;
  await runQueue({
    portal: "https://p", token: "t", cache: cache5,
    placeCall: async () => ({ connected: true, goodLead: false }),
    log: quiet, gapMs: 0, maxCalls: 3,
  });
  assert.equal(cache5.cachedLeads().length, 0, "all called, none left");
  // The portal is asked again on the next run and re-serves the same rows.
  await runQueue({
    portal: "https://p", token: "t", cache: cache5,
    placeCall: async () => { assert.fail("a called lead must not be dialled again"); },
    log: quiet, gapMs: 0,
  });
  console.log("  ok  re-caching a list does not make a called lead dialable again");

  console.log("PASS: a suspended portal does not stop the campaign, and a refusal survives it");
}

main().catch((e) => { console.error("  FAIL " + (e && e.stack || e)); process.exit(1); });
