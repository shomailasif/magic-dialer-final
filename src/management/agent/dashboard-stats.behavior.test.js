"use strict";
/* The dashboard counters must describe the calls this PC actually has.
 *
 * Two records exist: config.stats (a running counter that survived the versions
 * where the calls table was never written to) and the calls table itself. On
 * the deployed machine the dashboard showed "9 calls made, 1 call today" from a
 * day in the previous month, while "Recent calls" was empty - because the
 * status feed read the counter and the list read the table.
 *
 * mergedStats() is the only place that reconciles them, and these checks pin
 * both directions: legacy history is kept, a stale "today" is not, and a call
 * that is in both records is counted once.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { mergedStats, bumpStats, localDayKey, startOfLocalDay } = require("./agent");

const ZERO = { calls: 0, today: 0, qualified: 0, qualifiedToday: 0, bestScore: 0 };
const TODAY = localDayKey();
const longAgo = "2000-01-01";

// 1. A legacy install: history in the counter, nothing in the table.
{
  const s = mergedStats({ stats: { since: "2026-09-11", day: longAgo, calls: 9, qualified: 0, today: 1, qualifiedToday: 0, lastScore: 0.25, bestScore: 0.5 } }, ZERO);
  assert.equal(s.calls, 9, "calls that predate the table must not disappear");
  assert.equal(s.today, 0, "a stale day's counter must never be reported as today");
  assert.equal(s.bestScore, 0.5, "the legacy best score is still a real result");
  assert.equal(s.day, TODAY, "the feed must carry today's key");
}

// 2. A fresh install with no counter at all.
{
  const s = mergedStats({}, { calls: 3, today: 2, qualified: 1, qualifiedToday: 1, bestScore: 0.8 });
  assert.equal(s.calls, 3);
  assert.equal(s.today, 2);
  assert.equal(s.qualified, 1);
  assert.equal(s.bestScore, 0.8);
  assert.equal(s.qualifiedRate, 0.33, "rate is qualified over all calls");
}

// 3. Both records in step: the same call must not be counted twice.
{
  const s = mergedStats(
    { stats: { since: "2026-09-11", day: TODAY, calls: 9, qualified: 1, today: 1, qualifiedToday: 1, bestScore: 0.5 } },
    { calls: 1, today: 1, qualified: 1, qualifiedToday: 1, bestScore: 0.5 }
  );
  assert.equal(s.calls, 9, "the call in both records must be counted once, got " + s.calls);
  assert.equal(s.today, 1, "today's call must be counted once, got " + s.today);
  assert.equal(s.qualified, 1);
}

// 4. The table ahead of the counter (a call saved, the process stopped before
//    the config was written) must win rather than being hidden.
{
  const s = mergedStats(
    { stats: { day: longAgo, calls: 9, qualified: 0, today: 1, qualifiedToday: 0 } },
    { calls: 10, today: 1, qualified: 1, qualifiedToday: 1, bestScore: 0.9 }
  );
  assert.equal(s.calls, 10);
  assert.equal(s.today, 1);
  assert.equal(s.qualified, 1);
  assert.equal(s.bestScore, 0.9);
}

// 5. A counter day that is today is trusted, so a call the table missed is
//    still shown.
{
  const s = mergedStats({ stats: { day: TODAY, calls: 5, qualified: 2, today: 2, qualifiedToday: 1 } }, { calls: 4, today: 1, qualified: 1, qualifiedToday: 0 });
  assert.equal(s.today, 2);
  assert.equal(s.qualifiedToday, 1);
  assert.equal(s.qualified, 2);
}

// 6. bumpStats resets the daily counters on a new local day and keeps the total.
{
  const cfg = { stats: { since: "2026-09-11", day: longAgo, calls: 9, qualified: 2, today: 7, qualifiedToday: 2, lastScore: 0.3, bestScore: 0.6, qualifiedRate: 0.22 } };
  const s = bumpStats(cfg, { score: 0.7, goodLead: true });
  assert.equal(s.calls, 10, "the total must keep accumulating across days");
  assert.equal(s.today, 1, "a new day starts at one call, not seven");
  assert.equal(s.qualifiedToday, 1, "a new day starts at one qualified call");
  assert.equal(s.bestScore, 0.7);
  assert.equal(s.day, TODAY);
}

// 7. The same day does not reset.
{
  const cfg = { stats: { since: TODAY, day: TODAY, calls: 1, qualified: 0, today: 1, qualifiedToday: 0, bestScore: 0.1 } };
  const s = bumpStats(cfg, { score: 0.2, goodLead: false });
  assert.equal(s.today, 2);
  assert.equal(s.calls, 2);
}

// 8. startOfLocalDay really is midnight where the operator is.
{
  const d = new Date(startOfLocalDay());
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getSeconds(), 0);
  assert.equal(d.getMilliseconds(), 0);
  assert.equal(localDayKey(startOfLocalDay()), localDayKey(), "midnight belongs to today");
}

// 9. The table counters are read from the calls table, so the list and the
//    numbers cannot drift apart.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autodial-stats-"));
  const localDb = require("./local-db");
  try {
    localDb.open(dir);
    assert.deepEqual(localDb.callStats(startOfLocalDay()), { calls: 0, today: 0, qualified: 0, qualifiedToday: 0, bestScore: 0 });
    localDb.saveCall({ leadId: "1", score: 0.8, goodLead: true, summary: "interested" });
    localDb.saveCall({ leadId: "2", score: 0.2, goodLead: false, summary: "not now" });
    assert.deepEqual(localDb.callStats(startOfLocalDay()), { calls: 2, today: 2, qualified: 1, qualifiedToday: 1, bestScore: 0.8 });
    assert.equal(localDb.callStats(0).today, 0, "no cutoff means no today count, not every call");
    assert.equal(localDb.recentCalls(20).length, 2, "the list and the counters must read the same rows");
    const merged = mergedStats({ stats: { day: longAgo, calls: 9, qualified: 0, today: 1, qualifiedToday: 0 } }, localDb.callStats(startOfLocalDay()));
    assert.equal(merged.calls, 9, "legacy history above the table is kept");
    assert.equal(merged.today, 2, "today is the two real rows, not the stale counter");
  } finally {
    localDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("dashboard stats: PASS (table and legacy counter reconciled, today is today, nothing double-counted)");
