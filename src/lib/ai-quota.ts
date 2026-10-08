import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

type I = { userId: string; deviceId: string };
type K = "chat" | "stt";

const M = 60000,
  D = 86400000;

const e = (n: string, f: number) => {
  const v = Number(process.env[n]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : f;
};

const w = (d: Date, s: number) => new Date(Math.floor(d.getTime() / s) * s);

/* Postgres keeps a Prisma DateTime as `timestamp(3)` with no zone, filled from
 * the JS Date's UTC parts. A Date sent as a bound parameter travels as
 * `timestamptz` and is converted through the connection's session timezone on
 * the way in, so the same window key could be stored at two different wall
 * clocks - two rows for one window, and the quota would stop limiting anything.
 * The key goes over the wire as a plain UTC literal, which has no timezone to
 * convert. */
const tsLiteral = (d: Date) => d.toISOString().replace("T", " ").replace("Z", "");

export function quotaPolicy(k: K) {
  return k === "chat"
    ? {
        u: e("AI_CHAT_USER_RPM", 600),
        d: e("AI_CHAT_DEVICE_RPM", 360),
        g: e("AI_CHAT_GLOBAL_RPM", 12000),
        day: e("AI_CHAT_GLOBAL_DAILY_UNITS", 2000000),
      }
    : {
        u: e("AI_STT_USER_RPM", 900),
        d: e("AI_STT_DEVICE_RPM", 600),
        g: e("AI_STT_GLOBAL_RPM", 18000),
        day: e("AI_STT_GLOBAL_DAILY_UNITS", 3600000),
      };
}

export function quotaPlan(k: K, i: I, units: number, n = new Date()) {
  const p = quotaPolicy(k),
    m = w(n, M),
    day = w(n, D),
    r = (x: Date, s: number) => Math.max(1, Math.ceil((x.getTime() + s - n.getTime()) / 1000)),
    z = Math.max(1, Math.floor(units));
  return [
    {
      scopeKey: `${k}:device:${i.deviceId}:minute`,
      windowStart: m,
      limit: p.d,
      units: 0,
      retryAfter: r(m, M),
    },
    {
      scopeKey: `${k}:user:${i.userId}:minute`,
      windowStart: m,
      limit: p.u,
      units: 0,
      retryAfter: r(m, M),
    },
    {
      scopeKey: `${k}:global:minute`,
      windowStart: m,
      limit: p.g,
      units: 0,
      retryAfter: r(m, M),
    },
    {
      scopeKey: `${k}:global:day-units`,
      windowStart: day,
      limit: p.day,
      units: z,
      retryAfter: r(day, D),
    },
  ];
}

type Scope = ReturnType<typeof quotaPlan>[number];

/* One row of the decision, as the statement reports it.
 * `value` is what that scope's counter becomes - or would have become, if the
 * request was refused - and `blocked` is that scope's own limit verdict. */
export type QuotaRow = { scopeKey: string; blocked: boolean; value: number | bigint };

/* The single statement that replaces an interactive transaction.
 *
 * This used to open a Prisma interactive transaction and run four
 * `aIQuotaBucket.findUnique` reads followed by four `upsert` writes inside it:
 * eight serialized round trips to a remote Postgres, plus the interactive
 * wrapper's own BEGIN/COMMIT and per-query overhead. Together with device auth
 * that was nine blocking round trips on the way to every AI request the phone
 * engine makes - about 2.9s of the turn spent before Groq was ever reached.
 *
 * All four scopes are now read, decided and incremented by one statement:
 *
 *   cur     the four scopes joined to whatever counter they have right now
 *   blocked every scope whose counter, plus this request, would pass its limit
 *   applied the four upserts, gated on there being no blocked scope at all
 *
 * Gating the INSERT on `blocked` is what keeps the old all-or-nothing answer: a
 * refused request still writes nothing, to any scope, exactly as returning
 * early from the transaction used to. Each returned `value` is that scope's
 * counter after the increment, so the caller applies the identical comparison
 * and gets the identical verdict and the identical retryAfter.
 *
 * Every mixed-case identifier is quoted. Postgres folds an unquoted identifier
 * to lower case, and these columns are mixed case.
 */
export function quotaDecision(plan: Scope[]) {
  const scopes = Prisma.join(
    plan.map(
      (q) =>
        Prisma.sql`(${q.scopeKey}::text, ${tsLiteral(q.windowStart)}::text::timestamp(3), ${
          q.units ? true : false
        }::boolean, ${q.units ? 0 : 1}::int, ${q.units || 0}::int, ${q.limit}::int, ${randomUUID()}::text)`,
    ),
    ",\n         ",
  );
  return Prisma.sql`
WITH q("scopeKey","windowStart","isUnits","reqDelta","unitsDelta","maxCount","bucketId") AS (
  VALUES ${scopes}
), cur AS (
  SELECT q.*,
         COALESCE(b."requestCount",0) AS "reqCount",
         COALESCE(b."units",0) AS "unitCount"
  FROM q
  LEFT JOIN "AIQuotaBucket" b
    ON b."scopeKey"=q."scopeKey" AND b."windowStart"=q."windowStart"
), blocked AS (
  SELECT c."scopeKey" FROM cur c
  WHERE (CASE WHEN c."isUnits" THEN c."unitCount"+c."unitsDelta"
              ELSE c."reqCount"+c."reqDelta" END) > c."maxCount"
), applied AS (
  INSERT INTO "AIQuotaBucket" ("id","scopeKey","windowStart","requestCount","units","updatedAt")
  SELECT c."bucketId", c."scopeKey", c."windowStart", c."reqDelta", c."unitsDelta",
         (NOW() AT TIME ZONE 'UTC')
  FROM cur c
  WHERE NOT EXISTS (SELECT 1 FROM blocked)
  ON CONFLICT ("scopeKey","windowStart") DO UPDATE
    SET "requestCount" = "AIQuotaBucket"."requestCount" + EXCLUDED."requestCount",
        "units"         = "AIQuotaBucket"."units" + EXCLUDED."units",
        "updatedAt"     = EXCLUDED."updatedAt"
  RETURNING 1
)
SELECT c."scopeKey" AS "scopeKey",
       (c."scopeKey" IN (SELECT "scopeKey" FROM blocked)) AS "blocked",
       (CASE WHEN c."isUnits" THEN c."unitCount"+c."unitsDelta"
             ELSE c."reqCount"+c."reqDelta" END) AS "value"
FROM cur c
ORDER BY c."scopeKey"`;
}

export type QuotaVerdict = { ok: true } | { ok: false; retryAfter: number };

/* The decision the old read-then-write loop made, on the values one statement
 * returns: the first scope in plan order that is over its limit refuses the
 * request and supplies its retryAfter. A scope the statement did not report is
 * treated as allowed, which is the fail-open direction. */
export function quotaVerdict(plan: Scope[], rows: QuotaRow[]): QuotaVerdict {
  const reported = new Map(rows.map((r) => [r.scopeKey, r]));
  for (const q of plan) {
    const row = reported.get(q.scopeKey);
    if (!row) continue;
    if (row.blocked || Number(row.value) > q.limit) return { ok: false, retryAfter: q.retryAfter };
  }
  return { ok: true };
}

export async function consumeAIQuota(k: K, i: I, units: number, n = new Date()) {
  const plan = quotaPlan(k, i, units, n);
  try {
    return quotaVerdict(plan, await prisma.$queryRaw<QuotaRow[]>(quotaDecision(plan)));
    // A metering failure must never break a phone call, so the gateway fails
    // open. Anything thrown above - a dropped connection, an unreachable
    // database - returns the same answer the request would have got had the
    // meter not existed.
  } catch {
    return { ok: true as const };
  }
}

export function quotaResponse(s: number) {
  return new Response(JSON.stringify({ error: "AI capacity limit reached" }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": String(s) },
  });
}