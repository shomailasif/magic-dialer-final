import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
import { Client } from "pg";
import { existsSync } from "node:fs";
import { getCurrentUser } from "@/lib/auth";
import { diagnosticId, safeDiagnostic } from "@/lib/safe-diagnostic";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/*
 * One-time move of the whole database from the SQLite file to PostgreSQL.
 *
 * It runs here, inside the container, because Suga does not let the volume be
 * read from anywhere else - the file is only reachable from in here.
 *
 * The target is reached with the plain pg driver, NOT Prisma, and that is
 * deliberate: Prisma generates one client per schema, and the app's schema is
 * SQLite, so a Prisma client built from it refuses a postgresql:// address
 * outright with "the URL must start with the protocol file:". Two providers
 * cannot share one generated client. The plain driver has no such opinion, so
 * the copy works without changing the schema the app is running on.
 *
 * Safety:
 *   - the source is opened read-only, so the live database is never modified
 *   - the site keeps serving from the database it is on now, throughout
 *   - every table is verified source against target
 *   - nothing is switched over. Changing DATABASE_URL stays a separate,
 *     deliberate step, so a failure here can never take the site down.
 */

const TABLES = [
  "User", "Subscription", "AIAgentConfig", "DialerConfig", "Session",
  "EngineDevice", "EngineEnrollmentTicket", "Lead", "PhoneSuppression",
  "Call", "CallCampaign", "AIQuotaBucket", "AiQuotaBucket",
];

async function sourceCount(legacy: PrismaClient, table: string) {
  const r = (await legacy.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM "${table}"`)) as Record<string, unknown>[];
  return Number(r[0].n);
}

export async function POST(request: Request) {
  const requestId = diagnosticId(request.headers.get("x-request-id"));
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const legacyUrl = process.env.LEGACY_DATABASE_URL || "file:/app/data/magicdialer.db";
  /* Supabase's direct host is IPv6-only, and most hosts, Suga included, cannot
   * reach it. The pooler host is plain IPv4 and works from anywhere, so the
   * caller may supply it here for a one-time move. It is used for this request
   * only, never written anywhere, and never logged. */
  let targetUrl = process.env.TARGET_DATABASE_URL || "";
  if (!targetUrl) {
    const body = (await request.json().catch(() => ({}))) as { targetUrl?: string };
    targetUrl = (body.targetUrl || "").trim();
  }
  const file = legacyUrl.replace(/^file:/, "");
  if (!targetUrl) return NextResponse.json({ error: "No PostgreSQL target configured." }, { status: 503 });
  if (!existsSync(file)) return NextResponse.json({ error: `No database file at ${file}.` }, { status: 503 });

  const legacy = new PrismaClient({ datasources: { db: { url: legacyUrl } } });
  const pg = new Client({ connectionString: targetUrl, ssl: { rejectUnauthorized: false } });
  const result: Record<string, unknown> = { tables: {} };

  try {
    const seen = (await legacy.$queryRawUnsafe(
      `SELECT name FROM sqlite_master WHERE type='table'`
    )) as { name: string }[];
    result.sourceTables = seen.length;

    await pg.connect();

    for (const table of TABLES) {
      let from: number;
      try {
        from = await sourceCount(legacy, table);
      } catch (e) {
        (result.skipped as Record<string, string>) ||= {};
        (result.skipped as Record<string, string>)[table] = String((e as Error)?.message || e).slice(0, 140);
        continue;
      }
      if (!from) continue;

      const rows = (await legacy.$queryRawUnsafe(`SELECT * FROM "${table}"`)) as Record<string, unknown>[];
      // Read the target's own column list, so a column the old file happens to
      // carry is not sent to a table that has no such column.
      const info = await pg.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
        [table]
      );
      const targetCols = new Set(info.rows.map((r: { column_name: string }) => r.column_name));
      if (!targetCols.size) { result.failed = `${table}: no such table in PostgreSQL`; break; }

      await pg.query(`DELETE FROM "${table}"`);
      let written = 0;
      for (const row of rows) {
        const cols = Object.keys(row).filter((c) => targetCols.has(c));
        if (!cols.length) continue;
        const list = cols.map((c) => `"${c}"`).join(", ");
        const marks = cols.map((_c, i) => "$" + (i + 1)).join(", ");
        const values = cols.map((c) => {
          const v = row[c];
          if (v === undefined || v === null) return null;
          if (typeof v === "boolean") return v ? 1 : 0;
          if (v instanceof Date) return v.toISOString();
          if (typeof v === "object") return JSON.stringify(v);
          if (Buffer.isBuffer(v)) return v;
          return v;
        });
        // ON CONFLICT DO NOTHING so a re-run cannot fail on a duplicate.
        await pg.query(
          `INSERT INTO "${table}" (${list}) VALUES (${marks}) ON CONFLICT DO NOTHING`, values
        );
        written++;
      }
      const to = Number((await pg.query(`SELECT COUNT(*) AS n FROM "${table}"`)).rows[0].n);
      (result.tables as Record<string, unknown>)[table] = { from, to };
      if (to < from) { result.failed = `${table}: expected ${from}, wrote ${to}`; break; }
    }
  } catch (err) {
    // The site is untouched either way: it is still reading the original file.
    console.error("[migrate] failed", err instanceof Error ? err.stack : err);
    const raw = String((err as Error)?.message || err).replace(/\s+/g, " ");
    return NextResponse.json(
      {
        error: "Copy did not finish. The site is unaffected and still serving normally.",
        detail: raw.slice(0, 400),
        ...result,
        ...safeDiagnostic("migrate", "COPY_INCOMPLETE", 500, requestId),
      },
      { status: 500 },
    );
  } finally {
    await legacy.$disconnect().catch(() => {});
    await pg.end().catch(() => {});
  }

  return NextResponse.json({ ok: !result.failed, ...result, requestId });
}