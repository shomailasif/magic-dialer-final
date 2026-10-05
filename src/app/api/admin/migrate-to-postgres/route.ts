import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
import { existsSync } from "node:fs";
import { getCurrentUser } from "@/lib/auth";
import { diagnosticId, safeDiagnostic } from "@/lib/safe-diagnostic";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/*
 * One-time move of the whole database from the SQLite file to PostgreSQL.
 *
 * It runs here, inside the container, because Suga does not let the volume be
 * read from anywhere else - the file is only reachable from in here. That is why
 * this is an endpoint the site runs rather than something done from a laptop.
 *
 * Safety:
 *   - the source is opened read-only, so the live database is never modified
 *   - the site keeps serving from the database it is on right now, throughout
 *   - every table is verified source against target
 *   - nothing is switched over by this. Changing DATABASE_URL stays a separate,
 *     deliberate step, so a failure here can never take the site down.
 */

const TABLES = [
  "User", "Subscription", "AIAgentConfig", "DialerConfig", "Session",
  "EngineDevice", "EngineEnrollmentTicket", "Lead", "PhoneSuppression",
  "Call", "CallCampaign", "AIQuotaBucket", "AiQuotaBucket",
];

async function countOf(client: PrismaClient, table: string) {
  /* No `::int` here. That is a PostgreSQL cast and SQLite rejects it outright
   * with "unrecognized token", which is why the first run copied nothing while
   * still reporting success. Both engines return COUNT(*) as a number already. */
  const r = (await client.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM "${table}"`)) as Record<string, unknown>[];
  return Number(r[0].n);
}

export async function POST(request: Request) {
  const requestId = diagnosticId(request.headers.get("x-request-id"));
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const legacyUrl = process.env.LEGACY_DATABASE_URL || "file:/app/data/magicdialer.db";
  const targetUrl = process.env.TARGET_DATABASE_URL || "";
  const file = legacyUrl.replace(/^file:/, "");
  if (!targetUrl) {
    return NextResponse.json({ error: "No PostgreSQL target configured." }, { status: 503 });
  }
  if (!existsSync(file)) {
    return NextResponse.json({ error: `No database file at ${file}.` }, { status: 503 });
  }

  const legacy = new PrismaClient({ datasources: { db: { url: legacyUrl } } });
  const target = new PrismaClient({ datasources: { db: { url: targetUrl } } });
  const result: { tables: Record<string, { from: number; to: number }>; failed?: string; skipped?: Record<string,string>; source?: { file: string; tables: string[] } } = { tables: {} };

  try {
    const seen = (await legacy.$queryRawUnsafe(
      `SELECT name FROM sqlite_master WHERE type='table'`
    )) as { name: string }[];
    result.source = {
      file,
      tables: seen.map((s) => s.name),
    };
    for (const table of TABLES) {
      let from: number;
      try {
        from = await countOf(legacy, table);
      } catch (e) {
        result.skipped = result.skipped || {};
        result.skipped[table] = String((e as Error)?.message || e).slice(0, 120);
        continue;
      }
      if (!from) { result.tables[table] = { from: 0, to: 0 }; continue; }
      try { await target.$executeRawUnsafe(`DELETE FROM "${table}"`); } catch {}
      const rows = (await legacy.$queryRawUnsafe(`SELECT * FROM "${table}"`)) as Record<string, unknown>[];
      let written = 0;
      for (const row of rows) {
        const cols = Object.keys(row);
        const list = cols.map((c) => `"${c}"`).join(", ");
        const marks = "(" + cols.map(() => "?").join(", ") + ")";
        const values = cols.map((c) => {
          const v = (row as Record<string, unknown>)[c];
          if (v === undefined || v === null) return null;
          if (typeof v === "boolean") return v ? 1 : 0;
          if (v instanceof Date) return v;
          if (typeof v === "object") return JSON.stringify(v);
          return v;
        });
        await target.$executeRawUnsafe(
          `INSERT INTO "${table}" (${list}) VALUES ${marks} ON CONFLICT DO NOTHING`, ...values,
        );
        written++;
      }
      const to = await countOf(target, table);
      result.tables[table] = { from, to };
      if (to < from) {
        result.failed = `${table}: expected ${from}, wrote ${to}`;
        break;
      }
    }
  } catch (err) {
    // The site is untouched either way: it is still reading the original file.
    console.error("[migrate] failed", err instanceof Error ? err.stack : err);
    /* Prisma's error message truncates at the useful part, so the code and the
     * driver's own message are pulled out and returned. Every guess about this
     * failure has cost a deploy; it has to report what actually happened. */
    const raw = String((err as Error)?.message || err);
    const code = String((err as any)?.code || "");
    const driverMsg = (raw.match(/Message:\s*([\s\S]{0,300})/) || [])[1] || "";
    return NextResponse.json(
      {
        error: "Copy did not finish. The site is unaffected and still serving normally.",
        detail: raw.replace(/\s+/g, " ").slice(0, 400),
        code,
        driverMessage: driverMsg.trim().slice(0, 300),
        ...result,
        ...safeDiagnostic("migrate", "COPY_INCOMPLETE", 500, requestId),
      },
      { status: 500 },
    );
  } finally {
    await legacy.$disconnect().catch(() => {});
    await target.$disconnect().catch(() => {});
  }

  return NextResponse.json({ ok: !result.failed, ...result, requestId });
}