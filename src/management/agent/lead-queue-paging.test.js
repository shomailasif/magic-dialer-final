/* The queue used to always ask for the first page of leads, so an account with
 * more than one page could only ever have those dialled - the rest were silently
 * never reached and the queue cheerfully reported "no more leads to call". For
 * someone paying to be called, that is the worst failure there is, and it is
 * silent. This proves the queue walks every page in order. */
const assert = require("node:assert");
const { runQueue, fetchDueLeads } = require("./lead-queue");

const PAGE = 50;
function lead(i) {
  return { id: "L" + i, name: "Lead " + i, phone: "+1555000" + String(10000 + i), status: "PENDING", createdAt: "2026-01-01T00:00:00Z" };
}

/** A portal holding 3 full pages plus a short one. */
function pagedPortal(total) {
  return async (url) => {
    const u = new URL(url);
    const limit = Number(u.searchParams.get("limit")) || PAGE;
    const offset = Number(u.searchParams.get("offset")) || 0;
    const slice = [];
    for (let i = offset; i < Math.min(offset + limit, total); i++) slice.push(lead(i));
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, count: slice.length, hasMore: offset + limit < total, offset, limit, leads: slice }),
    };
  };
}

async function main() {
  // 1. Every lead in a list far larger than one page gets dialled, in order.
  const total = PAGE * 3 + 7;
  global.fetch = pagedPortal(total);
  const called = [];
  const s = await runQueue({
    portal: "https://p", token: "t",
    placeCall: async (l) => { called.push(l.id); return { connected: true, goodLead: false }; },
    log: () => {}, gapMs: 0,
  });
  assert.equal(called.length, total, "every lead across every page must be called, got " + called.length + " of " + total);
  assert.equal(s.attempted, total);
  assert.equal(called[0], "L0", "must start at the oldest");
  assert.equal(called[total - 1], "L" + (total - 1), "must finish at the newest");
  console.log("  ok  all " + total + " leads across 4 pages are called, oldest first");

  // 2. It must stop, not loop. The queue deliberately re-reads the list after
  //    each call so the portal can record it, so the bound is a small multiple of
  //    the work, not one read per call.
  let reads = 0;
  const inner = pagedPortal(total);
  global.fetch = async (url) => { reads++; return inner(url); };
  const s2 = await runQueue({ portal: "https://p", token: "t", placeCall: async () => ({ connected: true, goodLead: false }), log: () => {}, gapMs: 0 });
  assert.equal(s2.attempted, total, "the whole list must still be worked");
  assert.ok(reads <= total * 2 + 4, "must terminate, made " + reads + " reads for " + total + " calls");
  console.log("  ok  it terminates after the list is exhausted (" + reads + " reads for " + total + " calls)");

  // 3. maxCalls still wins over a huge list, and the pages it read are bounded.
  global.fetch = pagedPortal(100000);
  let n = 0;
  const limited = await runQueue({
    portal: "https://p", token: "t",
    placeCall: async () => { n++; return { connected: true, goodLead: false }; },
    log: () => {}, gapMs: 0, maxCalls: 25,
  });
  assert.equal(n, 25, "maxCalls must still stop the queue, made " + n);
  assert.equal(limited.attempted, 25);
  console.log("  ok  maxCalls still stops the queue on a list of 100000");

  // 4. A page with nothing dialable must not end the run while more remain.
  let pageNo = 0;
  global.fetch = async (url) => {
    const u = new URL(url);
    const offset = Number(u.searchParams.get("offset")) || 0;
    pageNo++;
    // Page one is entirely suppressed; page two holds the real leads.
    const slice = offset === 0 ? [] : [lead(1), lead(2)];
    return { ok: true, status: 200, json: async () => ({ ok: true, count: slice.length, hasMore: offset === 0, offset, limit: PAGE, leads: slice }) };
  };
  const seenIds = [];
  await runQueue({ portal: "https://p", token: "t", placeCall: async (l) => { seenIds.push(l.id); return { connected: true, goodLead: false }; }, log: () => {}, gapMs: 0 });
  assert.deepEqual(seenIds, ["L1", "L2"], "an empty first page must not end the queue, got " + seenIds.join(","));
  console.log("  ok  an undialable first page does not stop the queue");

  // 5. fetchDueLeads reports the cursor the loop needs.
  global.fetch = pagedPortal(total);
  const p1 = await fetchDueLeads({ portal: "https://p", deviceToken: "t", limit: PAGE, offset: 0 });
  assert.equal(p1.hasMore, true, "page one of a long list must report more");
  assert.equal(p1.limit, PAGE, "the cursor must carry the page size");
  const p2 = await fetchDueLeads({ portal: "https://p", deviceToken: "t", limit: PAGE, offset: PAGE });
  assert.equal(p2.leads[0].id, "L" + PAGE, "the second page must start where the first ended");
  console.log("  ok  the page cursor is reported correctly");

  console.log("PASS: the queue works the whole lead list, not just the first page");
}

main().catch((e) => { console.error("  FAIL " + e.message); process.exit(1); });
