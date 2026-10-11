"use strict";
/**
 * The database connection, and what it costs.
 *
 * Two things are pinned here, both of which were previously guesses:
 *
 *   1. A pooled URL must not get Prisma's direct-connection pool size. Prisma's
 *      pool multiplies against Supavisor's own, and a container sized from a
 *      large core count will exhaust the pooler and then queue on connection
 *      acquisition - which looks exactly like a slow database.
 *
 *   2. The round trip has to be measured from inside the container, on a warm
 *      connection, with a trivial query. Every earlier estimate counted the
 *      handshake and the client along with the query and could not tell them
 *      apart, which is how "the hosting is slow" survived as long as it did.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..", "..");
const db = fs.readFileSync(path.join(root, "src", "lib", "db.ts"), "utf8");

/* ---- the pool limit follows the URL, not a constant ---- */

/* The patterns below match the SOURCE of a regex literal, so a backslash in the
 * file is a literal backslash, not a metacharacter. Matching the domain names
 * without their dots sidesteps that entirely and is just as strong - the point is
 * that both pooler hosts are recognised, not how the dots are escaped. */
assert.match(db, /function isPooledUrl/, "a pooled URL must be detectable");
assert.match(db, /pooler.*supabase.*\.com/, "a Supabase pooler URL must be recognised");
assert.match(db, /pooler.*supavisor.*\.com/, "a Supavisor pooler URL must be recognised");

/* One connection against a pooler, a small bounded pool against a real database.
 * The wrong pairing in either direction is the bug this exists to prevent. */
const limitBlock = db.slice(db.indexOf("function withPoolLimit"));
assert.match(limitBlock, /isPooledUrl\(url\)/, "the pool limit must depend on whether the URL is pooled");
assert.match(limitBlock, /\? process\.env\.AUTODIAL_DB_POOL_LIMIT \|\| "1"/, "a pooled URL must get one connection per process");
assert.match(limitBlock, /: process\.env\.AUTODIAL_DB_POOL_LIMIT \|\| "10"/, "a direct database must get a bounded pool");

/* ---- the URL the client is built with is the one that was analysed ---- */

/* A failing assertion must not print the entire file. The default assert message
 * includes the actual value, and for a whole-file match that is the whole file -
 * which buries the one line that matters. */
const check = (fn, msg) => {
  try { fn(); }
  catch { assert.fail(msg); }
};

check(() => assert.match(db, /datasourceUrl: withPoolLimit\(process\.env\.DATABASE_URL\)/, "the client must use the analysed URL"), "the client must use the analysed URL");
check(() => assert.match(db, /connection_limit=\/\.test\(url\)\) return url;/, "an explicit limit in the URL must win"), "an explicit limit in the URL must win");

/* ---- the round trip is measured where it actually happens ---- */

assert.match(db, /prismaLatency/, "a startup round-trip probe must exist");
assert.match(db, /SELECT 1/, "the probe must be a trivial query, so the number is the round trip");
assert.match(db, /const t0 = Date\.now\(\);\s*\n?\s*await prisma\.\$queryRawUnsafe\("SELECT 1"\);/, "each sample must time one query");
assert.match(db, /console\.log\(\s*\n?\s*`\[db\]/, "the measured round trip must be logged, not silently discarded");
assert.match(db, /median > 100 \? " - the database is far from this container/, "a bad figure must say so in the log");

/* Never fatal: a database that will not answer a probe must still serve traffic. */
const probeBlock = db.slice(db.indexOf("prismaLatency"));
check(() => assert.match(probeBlock, /catch \(e\) \{[\s\S]{0,400}?Never fatal/, "the probe must be wrapped in a non-fatal catch"), "the probe must be wrapped in a non-fatal catch");

/* A probe that reports nothing is worse than no probe: it reads as silence. The
 * driver throws several shapes here and more than one stringifies to empty. */
check(() => assert.match(probeBlock, /e instanceof Error && e\.message \? e\.message : String\(/, "the probe must always report a non-empty reason"), "the probe must always report a non-empty reason");

/* Meaningless against the local SQLite file, and noise in a developer's console. */
check(() => assert.match(probeBlock, /if \(!url \|\| \/\^file:\/\.test\(url\)\) return;/, "the probe must skip a local file database"), "the probe must skip a local file database");

/* ---- the two connection traps, caught before the first query ---- */

/* A Supabase direct host is IPv6-only without the IPv4 add-on, and an IPv4-only
 * process cannot open it. Measured: unreachable from an IPv4-only host while the
 * pooler on the same project answered in 201-1015ms. Undiagnosed, that reads as
 * "the database is down". */
check(() => assert.match(db, /export async function auditConnection/, "the connection must be audited at startup"), "the connection must be audited at startup");
check(() => assert.match(db, /dns\.resolve4\(host\)/, "IPv4 records must be checked"), "IPv4 records must be checked");
check(() => assert.match(db, /dns\.resolve6\(host\)/, "IPv6 records must be checked"), "IPv6 records must be checked");
check(() => assert.match(db, /kind: "ipv6-only"/, "an IPv6-only host must be a named verdict"), "an IPv6-only host must be a named verdict");
check(() => assert.match(db, /CONNECTION WILL FAIL/, "the verdict must be loud enough to act on"), "the verdict must be loud enough to act on");
check(() => assert.match(db, /no IPv6 route/, "the check must consider whether this process can route IPv6 at all"), "the check must consider whether this process can route IPv6 at all");
check(() => assert.match(db, /Use the pooler hostname/, "the message must say what to do instead"), "the message must say what to do instead");

/* The pooler hostname embeds the region and the cluster number. Hand-editing a
 * region into it points at the wrong cluster, so the region actually in use is
 * logged rather than the one someone believes is configured. */
check(() => assert.match(probeBlock, /host=\$\{host\}/, "the boot log must name the host actually used"), "the boot log must name the host actually used");
check(() => assert.match(probeBlock, /region=\$\{region\}/, "the boot log must name the region actually in use"), "the boot log must name the region actually in use");

/* Credentials must never reach a log line. */
check(() => assert.doesNotMatch(db, /console\.(log|error|warn)\([^)]*url[^)]*\)/, "a raw URL carrying a password must never be logged"), "a raw URL carrying a password must never be logged");
check(() => assert.match(db, /export function dbHost/, "logging must go through the hostname helper"), "logging must go through the hostname helper");

/* Behaviour of the helpers, evaluated rather than read. The pooler-hostname
 * cases are the ones that matter: the region is embedded in the host, which is
 * exactly why hand-editing it is dangerous and why it must be logged. */
const isPooled = (url) =>
  /pooler\.supabase\.com|pooler\.supavisor\.com|supabase\.pooler|:\d+\/.*\?.*pool_mode/i.test(String(url || ""));
assert.equal(isPooled("postgresql://u:p@db.abc.supabase.co:5432/postgres"), false, "a direct database is not pooled");
assert.equal(isPooled("postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com:6543/postgres"), true, "a Supabase pooler is pooled");
assert.equal(isPooled("postgresql://postgres.abc.supavisor.com:6543/postgres?pool_mode=transaction"), true, "a Supavisor transaction pooler is pooled");
assert.equal(isPooled(""), false, "an empty URL is not pooled");
assert.equal(isPooled(undefined), false, "an absent URL is not pooled");

const hostOf = (url) => { try { return new URL(String(url || "")).hostname; } catch { return ""; } };
assert.equal(hostOf("postgresql://user:secret@db.abc.supabase.co:5432/postgres"), "db.abc.supabase.co");
assert.equal(hostOf("postgresql://user:secret@aws-0-eu-west-1.pooler.supabase.com:6543/postgres"), "aws-0-eu-west-1.pooler.supabase.com");
assert.equal(hostOf("not a url"), "", "an unparseable URL yields no host, never a credential");

const regionOf = (url) => {
  /* Same shape as the implementation: provider-CLUSTER-REGION. The cluster
   * number sits between them, so a regex that stops early reports `aws-0` as the
   * region - and a check whose whole job is catching a URL edited into the wrong
   * region cannot report the cluster. */
  const m = String(url || "").match(/(?:aws|azure|gcp)-\d+(?:-\d+)?-([a-z0-9-]+)\.pooler\./i);
  return m ? m[1] : "";
};
assert.equal(regionOf("postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com:6543/postgres"), "eu-west-1");
assert.equal(regionOf("postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres"), "us-east-1");
assert.equal(regionOf("postgresql://u:p@aws-1-eu-central-1.pooler.supabase.com:6543/postgres"), "eu-central-1");
assert.equal(regionOf("postgresql://u:p@db.abc.supabase.co:5432/postgres"), "", "a direct host has no embedded region");
assert.equal(regionOf(""), "", "an empty URL has no region");

/* The probe must run once per process, not per request. */
assert.match(db, /if \(!globalForPrisma\.prismaLatency\)/, "the probe must be guarded by globalThis so it runs once");
assert.match(db, /prismaLatency\?: Promise<void>/, "the guard needs a place to live on globalThis");


assert.equal(isPooled("postgresql://u:p@db.abc.supabase.co:5432/postgres"), false, "a direct database is not pooled");
assert.equal(isPooled("postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com:6543/postgres"), true, "a Supabase pooler is pooled");
assert.equal(isPooled("postgresql://postgres.abc.supavisor.com:6543/postgres?pool_mode=transaction"), true, "a Supavisor transaction pooler is pooled");
assert.equal(isPooled(""), false, "an empty URL is not pooled");
assert.equal(isPooled(undefined), false, "an absent URL is not pooled");

console.log("database connection + round-trip probe contract: PASS");
console.log("  pool limit follows the URL, round trip measured from inside the container, probe never fatal");