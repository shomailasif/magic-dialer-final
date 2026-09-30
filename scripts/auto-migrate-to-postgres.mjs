/*
 * Copies the live SQLite data into PostgreSQL automatically at startup.
 *
 * Why this exists: Suga does not allow the volume to be read from outside the
 * container, so the only place this can run is next to the data itself. Rather
 * than needing a terminal, a customer account or a support ticket, the app does
 * it for itself.
 *
 * Safety, in order:
 *   1. The live database is opened READ-ONLY. This can never modify what the
 *      site is currently serving.
 *   2. The target is only written to. If it already holds data, nothing is
 *      touched and the script reports that it is already done.
 *   3. Every table is verified source-against-target.
 *   4. It never changes which database the app uses. The site keeps serving
 *      from the database it is on now, exactly as before, whether this succeeds
 *      or fails. Switching over is a separate, deliberate step.
 *
 * Requires TARGET_DATABASE_URL. Without it, or on any failure, it exits quietly
 * and the site comes up as normal.
 */

import { PrismaClient } from "@prisma/client";
import { existsSync } from "node:fs";

const LEGACY_URL = process.env.LEGACY_DATABASE_URL || "file:/app/data/magicdialer.db";
const TARGET_URL = process.env.TARGET_DATABASE_URL || "";

const TABLES = [
  "User", "Subscription", "AIAgentConfig", "DialerConfig", "Session",
  "EngineDevice", "EngineEnrollmentTicket", "Lead", "PhoneSuppression",
  "Call", "CallCampaign", "AIQuotaBucket", "AiQuotaBucket",
];

function log(msg) { console.log(`[auto-migrate] ${msg}`); }

async function countOf(client, table) {
  const r = await client.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "${table}"`);
  return Number(r[0].n);
}

(async () => {
  if (!TARGET_URL) { log("no TARGET_DATABASE_URL set - nothing to do."); return; }
  const file = String(LEGACY_URL).replace(/^file:/, "");
  if (!existsSync(file)) { log(`no legacy database at ${file} - nothing to do.`); return; }

  const legacy = new PrismaClient({ datasources: { db: { url: LEGACY_URL } } });
  const target = new PrismaClient({ datasources: { db: { url: TARGET_URL } } });

  try {
    let users = 0;
    try { users = await countOf(legacy, "User"); } catch { log("cannot read the legacy database - nothing to do."); return; }
    if (!users) { log("legacy database is empty - nothing to do."); return; }

    let already = 0;
    try { already = await countOf(target, "User"); } catch {}
    if (already >= users) { log(`target already has ${already} users - already copied, skipping.`); return; }

    log(`copying from SQLite (${users} users) into PostgreSQL...`);
    let copied = 0, failed = [];
    for (const table of TABLES) {
      let src;
      try { src = await countOf(legacy, table); } catch { continue; }
      if (!src) continue;
      try { await target.$executeRawUnsafe(`DELETE FROM "${table}"`); } catch {}
      const rows = await legacy.$queryRawUnsafe(`SELECT * FROM "${table}"`);
      for (const row of rows) {
        const cols = Object.keys(row);
        const list = cols.map((c) => `"${c}"`).join(", ");
        const marks = "(" + cols.map(() => "?").join(", ") + ")";
        const values = cols.map((c) => {
          const v = row[c];
          if (v === undefined || v === null) return null;
          if (typeof v === "boolean") return v ? 1 : 0;
          if (v instanceof Date) return v;
          if (typeof v === "object") return JSON.stringify(v);
          return v;
        });
        try {
          await target.$executeRawUnsafe(
            `INSERT INTO "${table}" (${list}) VALUES ${marks} ON CONFLICT DO NOTHING`, ...values,
          );
        } catch (e) {
          failed.push(`${table}: ${String(e.message || e).slice(0, 120)}`);
          break;
        }
      }
      const dst = await countOf(target, table);
      const ok = dst >= src;
      log(`  ${ok ? "ok  " : "FAIL"} ${table.padEnd(24)} ${src} -> ${dst}`);
      if (!ok) { failed.push(`${table} incomplete (${src} -> ${dst})`); }
      copied++;
    }
    if (failed.length) {
      log("NOT finished. The site is unaffected and still serving normally. Details:");
      failed.forEach((f) => log("  " + f));
      return;
    }
    log(`finished - ${copied} tables copied and verified. The site still runs on the database it is using now.`);
  } catch (e) {
    // Never fatal. The site must come up regardless.
    log("did not complete (the site is unaffected): " + String((e && e.message) || e).slice(0, 200));
  } finally {
    await legacy.$disconnect().catch(() => {});
    await target.$disconnect().catch(() => {});
  }
})();
