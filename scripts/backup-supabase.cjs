/* Full export of the Supabase database, run BEFORE the project closes.
 *
 * Produces one folder per run containing every public table (all rows), the
 * column definitions needed to rebuild them, the RLS state, and a manifest.
 * Then reads the files back and re-counts the rows against the live database,
 * because a backup that was never verified is a rumour.
 *
 * The connection string is assembled from sugamcp/myset.cjs exactly as the
 * other tools do it and is never printed, never logged, never written.
 *
 *   node scripts/backup-supabase.cjs [outputFolder]
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..");
const RUN_AT = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = process.argv[2] || path.join(
  "C:\\Users\\USER\\Documents\\MagicDialerBackup",
  "supabase-full-" + RUN_AT
);

function connectionString() {
  const src = fs.readFileSync(path.join(ROOT, "sugamcp", "myset.cjs"), "utf8");
  const m = src.match(/'(postgresql:\/\/postgres\.[^']+)'\s*\+\s*encodeURIComponent\('([^']*)'\)\s*\+\s*'([^']+)'/);
  if (!m) throw new Error("could not assemble the database URL from sugamcp/myset.cjs");
  return m[1] + encodeURIComponent(m[2]) + m[3];
}

const q = (name) => '"' + String(name).replace(/"/g, '""') + '"';

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const c = new Client({
    connectionString: connectionString(),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
    statement_timeout: 120000,
  });
  await c.connect();

  const tables = (await c.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`
  )).rows.map((r) => r.table_name);

  const columns = (await c.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`
  )).rows;

  const rls = (await c.query(
    `SELECT c.relname AS table_name, c.relrowsecurity AS enabled
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`
  )).rows;

  const indexes = (await c.query(
    `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename`
  )).rows;

  const manifest = {
    exportedAt: new Date().toISOString(),
    source: "supabase (pooler)",
    tableCount: tables.length,
    tables: {},
    rls: Object.fromEntries(rls.map((r) => [r.table_name, r.enabled])),
  };

  let total = 0;
  const summaries = [];

  for (const t of tables) {
    const t0 = Date.now();
    const res = await c.query(`SELECT * FROM ${q(t)}`);
    const rows = res.rows;
    const cols = columns.filter((x) => x.table_name === t);
    const file = path.join(OUT, t + ".json");
    fs.writeFileSync(file, JSON.stringify({ table: t, rowCount: rows.length, rows }, null, 1), "utf8");
    const bytes = fs.statSync(file).size;
    /* A digest over the rows, so a later restore can be proven identical
     * without the original database still being there to compare against. */
    const digest = crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    manifest.tables[t] = { rowCount: rows.length, bytes, sha256: digest, columns: cols.length };
    total += rows.length;
    summaries.push([t, rows.length, bytes, Date.now() - t0]);
  }

  fs.writeFileSync(path.join(OUT, "schema.json"), JSON.stringify({
    exportedAt: manifest.exportedAt,
    columns,
    indexes,
    rls: manifest.rls,
  }, null, 1), "utf8");

  /* The verification: read every file back and compare what is on disk with
   * what the database says right now. */
  const verify = { checkedAt: new Date().toISOString(), ok: true, mismatches: [] };
  for (const t of tables) {
    const onDisk = JSON.parse(fs.readFileSync(path.join(OUT, t + ".json"), "utf8"));
    const live = (await c.query(`SELECT count(*)::int AS n FROM ${q(t)}`)).rows[0].n;
    if (onDisk.rowCount !== live || onDisk.rows.length !== onDisk.rowCount) {
      verify.ok = false;
      verify.mismatches.push({ table: t, onDisk: onDisk.rowCount, live });
    }
    const digest = crypto.createHash("sha256").update(JSON.stringify(onDisk.rows)).digest("hex");
    if (digest !== manifest.tables[t].sha256) {
      verify.ok = false;
      verify.mismatches.push({ table: t, reason: "digest changed after write" });
    }
  }

  manifest.verification = verify;
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await c.end();

  const pad = (s, n) => String(s).padEnd(n);
  console.log("export folder: " + OUT);
  console.log("");
  console.log(pad("TABLE", 28) + pad("ROWS", 10) + pad("FILE", 12) + "TIME");
  for (const [t, n, b, ms] of summaries) {
    console.log(pad(t, 28) + pad(n, 10) + pad((b / 1024).toFixed(0) + " KB", 12) + ms + "ms");
  }
  console.log("");
  console.log("tables: " + tables.length + "   rows: " + total);
  console.log("verification: " + (verify.ok ? "OK - every file matches the live database" : "FAILED " + JSON.stringify(verify.mismatches)));
  console.log("totals: " + (tables.reduce((a, t) => a + manifest.tables[t].bytes, 0) / 1048576).toFixed(2) + " MB on disk");
  process.exit(verify.ok ? 0 : 1);
}

main().catch((e) => {
  console.error("BACKUP FAILED: " + (e && e.message));
  process.exit(1);
});
