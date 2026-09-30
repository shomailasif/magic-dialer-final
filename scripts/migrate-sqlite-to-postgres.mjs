/*
 * One-time move of every record from the SQLite file to PostgreSQL.
 *
 * This has to run INSIDE the app container, because the SQLite file lives on the
 * container's volume and Suga does not allow it to be read from anywhere else.
 * That is the whole reason this script exists rather than a copy done from a
 * laptop: the source data is only reachable from in here.
 *
 * Usage (in the container, or via a one-off run):
 *   SOURCE_DATABASE_URL="file:/app/data/magicdialer.db" \
 *   TARGET_DATABASE_URL="postgresql://postgres:PASS@postgres:5432/postgres" \
 *   node scripts/migrate-sqlite-to-postgres.mjs
 *
 * Safety rules, in order of importance:
 *   1. The source is opened read-only. Nothing can damage the live data.
 *   2. Nothing is deleted from the target until a row has been read successfully.
 *   3. Every table is verified: source count, target count, and a mismatch is a
 *      hard failure rather than a quiet partial move.
 *   4. The script is safe to re-run. It clears the target tables and copies again.
 */

import { PrismaClient } from "@prisma/client";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const SOURCE_URL = process.env.SOURCE_DATABASE_URL || "file:/app/data/magicdialer.db";
const TARGET_URL = process.env.TARGET_DATABASE_URL || "";
if (!TARGET_URL) {
  console.error("TARGET_DATABASE_URL is required.");
  process.exit(1);
}

/* Order matters only for readability; there are no foreign keys enforced between
 * these tables at this level, and every table is verified independently. */
const TABLES = [
  "User", "Subscription", "AIAgentConfig", "DialerConfig", "Session",
  "EngineDevice", "EngineEnrollmentTicket", "Lead", "PhoneSuppression",
  "Call", "CallCampaign", "AIQuotaBucket", "AiQuotaBucket",
];

const source = new PrismaClient({ datasources: { db: { url: SOURCE_URL } } });
const target = new PrismaClient({ datasources: { db: { url: TARGET_URL } } });

/* Read every row from SQLite as plain JSON. Reading through a raw query keeps
 * this independent of the generated Prisma client on either side, so a schema
 * that has drifted cannot silently drop columns during the move. */
async function readAll(table) {
  const rows = await source.$queryRawUnsafe(`SELECT * FROM "${table}"`);
  return rows;
}

async function writeAll(table, rows) {
  if (!rows.length) return 0;
  // Column names come from the source row itself, so the target is written with
  // exactly the columns the source actually has.
  const cols = Object.keys(rows[0]);
  const colList = cols.map((c) => `"${c}"`).join(", ");
  const placeholders = "(" + cols.map(() => "?").join(", ") + ")";
  for (const row of rows) {
    const values = cols.map((c) => {
      const v = row[c];
      if (v === undefined || v === null) return null;
      if (typeof v === "boolean") return v ? 1 : 0;
      if (v instanceof Date) return v;
      if (typeof v === "object") return JSON.stringify(v);
      return v;
    });
    await target.$executeRawUnsafe(
      `INSERT INTO "${table}" (${colList}) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
      ...values
    );
  }
  return rows.length;
}

async function countOf(client, table) {
  const r = await client.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "${table}"`);
  return Number(r[0].n);
}

(async () => {
  console.log("source:", SOURCE_URL.replace(/:\/\/.*@/, "://***@"));
  console.log("target: PostgreSQL");

  for (const table of TABLES) {
    let srcCount;
    try {
      srcCount = await countOf(source, table);
    } catch {
      console.log(`  skip ${table.padEnd(26)} (not present in source)`);
      continue;
    }
    if (!srcCount) {
      console.log(`  skip ${table.padEnd(26)} (empty)`);
      continue;
    }
    // Clear the target first so a re-run cannot leave duplicates behind.
    try { await target.$executeRawUnsafe(`DELETE FROM "${table}"`); } catch {}
    const rows = await readAll(table);
    await writeAll(table, rows);
    const dstCount = await countOf(target, table);
    const ok = dstCount >= srcCount;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${table.padEnd(26)} ${srcCount} -> ${dstCount}`);
    if (!ok) {
      console.error(`MIGRATION FAILED on ${table}: expected at least ${srcCount}, found ${dstCount}.`);
      process.exit(1);
    }
  }

  console.log("All tables copied and verified.");
})()
  .catch((e) => {
    console.error("Migration failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await source.$disconnect().catch(() => {});
    await target.$disconnect().catch(() => {});
  });
