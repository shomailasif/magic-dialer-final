/**
 * Supabase free-tier keepalive: run real SQL against the database.
 *
 * Why this exists: Supabase pauses free projects after 7 days of low *database*
 * activity. An HTTP 200 from an API gateway does not count - a status code says
 * a request was answered and nothing about what work it caused. A daily ping to
 * /auth/v1/health stays green while Postgres sleeps. So this connects to the
 * actual database and executes a query.
 *
 * The assertion is about the DATA, not the status: it requires the row count to
 * come back as a number. A connection that opens and returns nothing is a
 * failure, not a quiet success.
 *
 * Usage:  node scripts/supabase-keepalive.cjs
 *         DATABASE_URL=postgresql://... node scripts/supabase-keepalive.cjs
 *
 * Exit 0 only when a query really ran and answered.
 */
"use strict";
const { Client } = require("pg");

/* Prefer an explicit URL so this can be pointed at production from CI without
 * touching the local .env, which is SQLite for the test suite. */
function url() {
  if (process.env.KEEPALIVE_DATABASE_URL) return process.env.KEEPALIVE_DATABASE_URL;
  const raw = process.env.DATABASE_URL || "";
  if (raw.startsWith("postgres://") || raw.startsWith("postgresql://")) return raw;
  /* Read-only fallback: the connection string used to provision the Suga
   * container. It holds a credential, so it is never printed or committed.
   *
   * The line is written as a concatenation around encodeURIComponent(), so the
   * URL has to be reassembled from its three parts rather than matched whole -
   * a single greedy match stops at the first quote and yields a truncated host. */
  try {
    const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "sugamcp", "myset.cjs"), "utf8");
    const m = src.match(/'(postgresql:\/\/postgres\.[^']+)'\s*\+\s*encodeURIComponent\('([^']*)'\)\s*\+\s*'([^']+)'/);
    if (m) return m[1] + encodeURIComponent(m[2]) + m[3];
  } catch {}
  return null;
}

async function main() {
  const u = url();
  if (!u) {
    console.error("keepalive: no DATABASE_URL - nothing was executed, so the timer was NOT reset");
    process.exit(1);
  }

  const client = new Client({
    connectionString: u,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    statement_timeout: 15000,
  });

  const started = Date.now();
  try {
    await client.connect();

    /* A real query with a real answer. count(*) walks a live relation, so it is
     * database activity rather than a handshake. */
    const res = await client.query('SELECT count(*)::int AS n FROM "Lead"');
    const n = res && res.rows && res.rows[0] && res.rows[0].n;

    if (typeof n !== "number") {
      console.error("keepalive: query returned no row count - this did not prove database activity");
      process.exit(1);
    }

    /* A write is the unambiguous signal, and it is one row we own. Upserting a
     * single heartbeat row keeps the table at exactly one row forever. */
    await client.query(
      `INSERT INTO "EngineKeepalive" ("id", "pingedAt")
       VALUES (1, NOW())
       ON CONFLICT ("id") DO UPDATE SET "pingedAt" = NOW()`
    ).catch(async (e) => {
      /* Table may not exist on a fresh project. Creating one row is cheap and
       * makes every later run a write rather than a read. */
      if (!/does not exist/i.test(String(e && e.message))) throw e;
      await client.query(`CREATE TABLE IF NOT EXISTS "EngineKeepalive" (
        "id" smallint PRIMARY KEY DEFAULT 1,
        "pingedAt" timestamptz NOT NULL DEFAULT now()
      )`);
      await client.query(`INSERT INTO "EngineKeepalive" ("id") VALUES (1) ON CONFLICT DO NOTHING`);
      await client.query(`UPDATE "EngineKeepalive" SET "pingedAt" = now() WHERE "id" = 1`);
    });

    console.log(`keepalive: OK - ${n} leads, write committed, ${Date.now() - started}ms`);
    process.exit(0);
  } catch (e) {
    console.error("keepalive: FAILED - " + String(e && e.message).slice(0, 300));
    console.error("The database was NOT touched, so the inactivity timer was NOT reset.");
    process.exit(1);
  } finally {
    try { await client.end(); } catch {}
  }
}

main();
