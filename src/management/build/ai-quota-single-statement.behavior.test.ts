/* The quota decision is one statement, and it decides the same thing the old
 * read-then-write transaction did.
 *
 * The statement itself is exercised against a real PostgreSQL elsewhere; what is
 * locked down here is everything that can be checked without a database: that
 * `quotaDecision` emits exactly one statement with one upsert for all four
 * scopes, that the window keys and the policy numbers reach the database
 * unmangled, and that `quotaVerdict` reproduces the old loop's answer for every
 * case the old loop could reach - including the boundary, the order scopes are
 * refused in, and the fail-open direction.
 */
import assert from "node:assert/strict";
import { quotaPlan, quotaDecision, quotaVerdict } from "../../lib/ai-quota";

process.env.AI_CHAT_USER_RPM = "600";
process.env.AI_CHAT_DEVICE_RPM = "360";
process.env.AI_CHAT_GLOBAL_RPM = "12000";
process.env.AI_CHAT_GLOBAL_DAILY_UNITS = "2000000";

const at = new Date("2026-09-20T12:00:30.000Z");
const plan = quotaPlan("chat", { userId: "u1", deviceId: "d1" }, 7, at);
const stmt = quotaDecision(plan);
const col = (n: number) => stmt.values.filter((_: unknown, i: number) => i % 7 === n);

/* One round trip, so: one statement, one insert, one conflict target. */
assert.doesNotMatch(stmt.text, /;\s*\S/);
assert.equal((stmt.text.match(/\bINSERT\b/gi) || []).length, 1);
assert.equal((stmt.text.match(/ON CONFLICT/gi) || []).length, 1);
assert.match(stmt.text, /ON CONFLICT \("scopeKey","windowStart"\) DO UPDATE/);
assert.doesNotMatch(stmt.text, /\b(BEGIN|COMMIT|START TRANSACTION)\b/i);

/* Every mixed-case column quoted: Postgres folds a bare one to lower case. */
for (const c of ["scopeKey", "windowStart", "requestCount", "units", "updatedAt", "bucketId", "maxCount", "isUnits"]) {
  assert.ok(stmt.text.includes(`"${c}"`), `${c} is quoted`);
}

/* Four scopes, seven parameters each, four distinct ids for the new rows. */
assert.equal(stmt.values.length, 28);
assert.equal(new Set(col(6)).size, 4);
assert.deepEqual(col(5), [360, 600, 12000, 2000000]);
assert.deepEqual(col(2), [false, false, false, true]);
assert.deepEqual(col(3), [1, 1, 1, 0]);
assert.deepEqual(col(4), [0, 0, 0, 7]);

/* Window keys reach the database as timezone-free UTC literals: a bound Date
 * would be converted through the connection's session timezone and could store
 * two different wall clocks for the same window. */
assert.deepEqual(col(1), [
  "2026-09-20 12:00:00.000",
  "2026-09-20 12:00:00.000",
  "2026-09-20 12:00:00.000",
  "2026-09-20 00:00:00.000",
]);

/* The verdict. `values` is what each scope's counter becomes; the old loop
 * refused when pre + delta > limit, which is the same as value > limit. */
const reported = (values: number[]) =>
  plan.map((q, i) => ({
    scopeKey: q.scopeKey,
    blocked: values[i] > q.limit,
    value: values[i],
  }));

assert.deepEqual(quotaVerdict(plan, reported([1, 1, 1, 7])), { ok: true });
assert.deepEqual(quotaVerdict(plan, reported([360, 600, 12000, 2000000])), { ok: true });

/* One over: refused, with that scope's retryAfter. */
const over = reported([361, 1, 1, 7]);
assert.deepEqual(quotaVerdict(plan, over), { ok: false, retryAfter: 30 });

/* Several over: the FIRST scope in plan order wins, exactly as the old loop. */
assert.deepEqual(quotaVerdict(plan, reported([1, 1, 12001, 7])), { ok: false, retryAfter: 30 });
const dayOver = reported([1, 1, 1, 2000001]);
assert.deepEqual(quotaVerdict(plan, dayOver), { ok: false, retryAfter: plan[3].retryAfter });
assert.notEqual(plan[3].retryAfter, plan[0].retryAfter);

/* `blocked` alone refuses, so the answer does not depend on the arithmetic
 * agreeing across the wire. */
assert.deepEqual(quotaVerdict(plan, [{ scopeKey: plan[0].scopeKey, blocked: true, value: 0 }]), {
  ok: false,
  retryAfter: 30,
});

/* Fail open: anything the statement did not report allows the request. */
assert.deepEqual(quotaVerdict(plan, []), { ok: true });
assert.deepEqual(quotaVerdict(plan, [{ scopeKey: "chat:device:someone-else:minute", blocked: true, value: 5 }]), { ok: true });
assert.deepEqual(quotaVerdict(plan, [{ scopeKey: plan[0].scopeKey, blocked: false, value: BigInt(361) }]), {
  ok: false,
  retryAfter: 30,
});

/* Same window maths as before: minute and day floors, and r(x,s) seconds to the
 * next window, never below 1. */
assert.equal(plan[0].windowStart.toISOString(), "2026-09-20T12:00:00.000Z");
assert.equal(plan[3].windowStart.toISOString(), "2026-09-20T00:00:00.000Z");
assert.equal(plan[0].retryAfter, 30);
assert.equal(quotaPlan("chat", { userId: "u1", deviceId: "d1" }, 7, new Date("2026-09-20T12:00:59.000Z"))[0].retryAfter, 1);

console.log("AI quota single-statement behavior: 21/21 checks PASS");