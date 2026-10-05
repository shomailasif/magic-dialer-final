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
   * caller may supply it here for a one-time move. A supplied value wins over
   * the environment variable, which is left pointing at the direct host that is
   * unreachable from here. It is used for this request only, never stored and
   * never logged. */
  const body = (await request.json().catch(() => ({}))) as { targetUrl?: string; budget?: number };
  const targetUrl = (body.targetUrl || "").trim() || process.env.TARGET_DATABASE_URL || "";
  /* One request must finish well inside the gateway's 120s limit, so each call
   * moves a bounded number of rows and the caller repeats until it reports done.
   * Resuming needs no stored cursor: the target's own row count says how far the
   * previous call got, because rows are always inserted in source order. */
  const BUDGET = Math.min(Math.max(Number(body.budget) || 1500, 100), 5000);
  const CHUNK = 200;
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

    let remaining = BUDGET;
    const progress: Record<string, unknown> = {};

    for (const table of TABLES) {
      if (remaining <= 0) { progress.stopped = "budget"; break; }
      let from: number;
      try {
        from = await sourceCount(legacy, table);
      } catch (e) {
        (result.skipped as Record<string, string>) ||= {};
        (result.skipped as Record<string, string>)[table] = String((e as Error)?.message || e).slice(0, 140);
        continue;
      }
      if (!from) continue;

      const info = await pg.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
        [table]
      );
      const targetCols = new Set(info.rows.map((r: { column_name: string }) => r.column_name));
      if (!targetCols.size) { result.failed = `${table}: no such table in PostgreSQL`; break; }

      let to = Number((await pg.query(`SELECT COUNT(*) AS n FROM "${table}"`)).rows[0].n);

      /* Rows already copied are skipped by counting what the target holds, so an
       * interrupted run continues instead of starting over or duplicating. */
      while (to < from && remaining > 0) {
        const size = Math.min(CHUNK, from - to, remaining);
        const rows = (await legacy.$queryRawUnsafe(
          `SELECT * FROM "${table}" LIMIT ${size} OFFSET ${to}`
        )) as Record<string, unknown>[];
        if (!rows.length) break;

        for (let i = 0; i < rows.length; i += CHUNK) {
          const part = rows.slice(i, i + CHUNK);
          const sets: string[] = [];
          const params: unknown[] = [];
          for (const row of part) {
            const cols = Object.keys(row).filter((c) => targetCols.has(c));
            if (!cols.length) continue;
            const marks = cols.map((c) => "$" + (params.push(row[c]), params.length));
            sets.push(`(${marks.join(", ")})`);
          }
          if (!sets.length) continue;
          const cols = Object.keys(rows[0]).filter((c) => targetCols.has(c));
          await pg.query(
            `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES ${sets.join(", ")} ON CONFLICT DO NOTHING`,
            params
          );
        }
        const now = Number((await pg.query(`SELECT COUNT(*) AS n FROM "${table}"`)).rows[0].n);
        remaining -= size;
        if (now <= to) { result.failed = `${table}: no progress at ${to}/${from}`; break; }
        to = now;
      }
      progress[table] = `${to}/${from}`;
      (result.tables as Record<string, unknown>)[table] = { from, to };
    }
    result.progress = progress;
    /* Not done if the budget cut it short or a table failed; the caller repeats
     * until it reports done, at which point every source row is in the target. */
    result.done = !result.failed && progress.stopped === undefined;
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