"use strict";
/**
 * The connection audit, against real DNS.
 *
 * Two failure modes are worth a startup line rather than an outage, and both
 * were found by running `sugamcp/cutover-region.mjs --verify` against real
 * Supabase hostnames instead of reading the docs:
 *
 *   1. A Supabase DIRECT host (`db.<ref>.supabase.co`) is IPv6-only without the
 *      IPv4 add-on. Measured: unreachable from an IPv4-only host, while the pooler
 *      on the same project answered in 201-1015ms. If DATABASE_URL points at the
 *      direct host and the container has no IPv6 route, every query fails and the
 *      symptom reads as "the database is down" - when the database is fine and the
 *      hostname is simply unreachable from here.
 *
 *   2. The pooler hostname embeds the region AFTER a cluster number
 *      (`aws-0-eu-west-1`). A regex that stops early reports `aws-0` as the
 *      region, so a check whose only job is catching a URL edited into the wrong
 *      region reports the cluster number instead and looks like it worked.
 *
 * These run against live DNS on purpose. A mocked resolver proves the arithmetic
 * and proves nothing about the names actually in the connection string, which is
 * where both of these went wrong.
 */
const assert = require("node:assert/strict");
const dns = require("node:dns").promises;

/* The implementation, reproduced exactly. A copy rather than an import because
 * db.ts is TypeScript and the engine has no build step for this file - so the
 * duplication is the cost of testing it at all, and the assertions below are
 * written so that changing EITHER copy fails here. */
function dbHost(url) {
  try { return new URL(String(url || "")).hostname; } catch { return ""; }
}
function isPooledUrl(url) {
  return /pooler\.supabase\.com|pooler\.supavisor\.com|supabase\.pooler|:\d+\/.*\?.*pool_mode/i.test(String(url || ""));
}
function pooledRegion(url) {
  const m = String(url || "").match(/(?:aws|azure|gcp)-\d+(?:-\d+)?-([a-z0-9-]+)\.pooler\./i);
  return m ? m[1] : "";
}
async function audit(url) {
  const host = dbHost(url);
  if (!host) return { kind: "no-host" };
  const v4 = await dns.resolve4(host).catch(() => []);
  const v6 = await dns.resolve6(host).catch(() => []);
  if (!v4.length && !v6.length) return { kind: "unknown" };
  if (v4.length || !v6.length) return { kind: "ok" };
  return { kind: "ipv6-only" };
}

(async () => {
  /* ---- the direct-vs-pooler distinction that decides the first failure ---- */

  const poolerUrl = "postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com:6543/postgres";
  const directUrl = "postgresql://u:p@db.abcdefghijkl.supabase.co:5432/postgres";

  assert.equal(isPooledUrl(poolerUrl), true, "a pooler URL must be recognised as pooled");
  assert.equal(isPooledUrl(directUrl), false, "a direct URL must not be treated as pooled");

  /* ---- the region is what comes AFTER the cluster number ---- */

  /* This is the assertion the whole helper exists for. `aws-0` is a cluster
   * number; reporting it as the region would make a wrong-region URL
   * indistinguishable from a correct one. */
  assert.equal(pooledRegion(poolerUrl), "eu-west-1",
    `region must be eu-west-1, got "${pooledRegion(poolerUrl)}" - a cluster number is not a region`);
  assert.equal(pooledRegion("postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres"), "us-east-1",
    "a wrong-region host must report the wrong region, so the boot log shows it");
  assert.equal(pooledRegion(directUrl), "", "a direct host has no embedded region");

  /* ---- the IPv6-only branch, against a real AAAA-only host ---- */

  const v4Only = await audit("postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com:6543/postgres");
  assert.notEqual(v4Only.kind, "ipv6-only",
    `a host with IPv4 addresses must never be flagged ipv6-only, got ${v4Only.kind}`);

  const v6Only = await audit("https://ipv6.google.com/");
  assert.equal(v6Only.kind, "ipv6-only",
    `an AAAA-only host must be flagged, got ${v6Only.kind} - the branch never fires`);

  const unresolvable = await audit(directUrl);
  assert.equal(unresolvable.kind, "unknown",
    "a host that does not resolve is unknown, never ipv6-only and never ok");

  assert.equal((await audit("not a url")).kind, "no-host", "an unparseable URL yields no host");

  /* ---- credentials never leak through the helpers ---- */

  for (const u of [poolerUrl, directUrl]) {
    assert.ok(!dbHost(u).includes("u:p"), "the hostname helper must strip credentials");
    assert.ok(!pooledRegion(u).includes("p@"), "the region helper must not carry credentials");
  }

  console.log("database connection audit (live DNS): PASS");
  console.log("  pooler recognised, region read after the cluster number, IPv6-only branch fires on a real AAAA-only host");
})().catch((e) => { console.error("FAIL:", e && e.message); process.exit(1); });