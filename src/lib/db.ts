import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaReady?: Promise<void>;
  prismaLatency?: Promise<void>;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    /*
     * A bounded pool of warm connections. Left unset, Prisma sizes the pool
     * from the CPU count of whichever machine happens to run the container, and
     * a container that reports a large core count opens a pool far wider than
     * the database will serve - so requests queue on connection acquisition
     * rather than on queries. Capping it keeps the pool small, warm and reused,
     * which is the thing that actually removes handshake cost per round trip.
     */
    datasourceUrl: withPoolLimit(process.env.DATABASE_URL),
  });

/* Pool limits, aware of whether the URL already points at a pooler.
 *
 * Measured against the deployed gateway: ~247ms per database round trip, while
 * the container's own region answers a TCP connect from outside in 27ms. So the
 * database is not merely under-pooled, it is in another continent, and no amount
 * of pooling removes an ocean crossing.
 *
 * Which matters here: Supavisor runs in the SAME region as the project database.
 * If the project is in us-east-1 and the container is in europe-west1, pointing
 * DATABASE_URL at the pooler leaves the ocean crossing exactly where it was and
 * buys nothing. Moving the project region to match the container is the fix.
 * Pooling is still worth getting right for the case where it IS the fix, and
 * getting it wrong is actively harmful: Prisma's pool multiplies against the
 * pooler's own, and a container sized from a large core count will exhaust the
 * pooler and then queue on connection acquisition.
 *
 * So: against a direct database, keep a modest bounded pool. Against a pooler,
 * use one connection per process, because the pooler - not Prisma - is what
 * multiplexes. That also keeps an interactive transaction from pinning more than
 * it needs to.
 */
function withPoolLimit(url: string | undefined) {
  if (!url) return undefined;
  if (/[?&]connection_limit=/.test(url)) return url;
  const sep = url.includes("?") ? "&" : "?";
  const limit = isPooledUrl(url)
    ? process.env.AUTODIAL_DB_POOL_LIMIT || "1"
    : process.env.AUTODIAL_DB_POOL_LIMIT || "10";
  return `${url}${sep}connection_limit=${limit}`;
}

/** True for a Supabase/Supavisor pooler URL rather than the database itself. */
export function isPooledUrl(url: string) {
  return /pooler\.supabase\.com|pooler\.supavisor\.com|supabase\.pooler|:\d+\/.*\?.*pool_mode/i.test(
    String(url || ""),
  );
}

/**
 * The region a pooler URL actually points at.
 *
 * The hostname shape is `<provider>-<cluster>-<region>.pooler.supabase.com` -
 * `aws-0-eu-west-1`, `azure-12-eastus2` - so the region is what comes AFTER the
 * cluster number, and a regex that stops early reports the cluster as the region.
 * That matters because the whole point of logging this is to catch a URL edited
 * into the wrong region, and reporting `aws-0` would not do that.
 */
export function pooledRegion(url: string) {
  /* Matched anywhere, because the host sits behind `postgresql://user:pw@` in
   * the URL text and an anchored pattern silently returns "" for every real
   * value - which looks exactly like "no region configured" and reads as fine. */
  const m = String(url || "").match(
    /(?:aws|azure|gcp)-\d+(?:-\d+)?-([a-z0-9-]+)\.pooler\./i,
  );
  return m ? m[1] : "";
}

/** Just the hostname. Credentials never appear in a log line. */
export function dbHost(url: string) {
  try { return new URL(String(url || "")).hostname; } catch { return ""; }
}

/**
 * What kind of failure this URL is heading for, decided before the first query.
 *
 * Both of these were found by running `sugamcp/cutover-region.mjs --verify`
 * against real Supabase hostnames rather than by reading the docs, and both were
 * documented before either was fixed. Documenting them was not enough, because
 * the failure they describe is silent and total:
 *
 * 1. A Supabase DIRECT host (`db.<ref>.supabase.co`) is IPv6-only unless the
 *    project has the IPv4 add-on. Measured here: that host was unreachable from
 *    an IPv4-only host while the pooler host on the same project answered in
 *    201-1015ms. If a container has no IPv6 route and DATABASE_URL points at the
 *    direct host, EVERY query fails and the symptom reads as "the database is
 *    down" - when the database is fine and the hostname is unreachable from
 *    here. That is a support incident, an outage, or both.
 *
 * 2. The pooler hostname embeds the region: `aws-<n>-eu-west-1.pooler...`. The
 *    `<n>` is a cluster number, not a region. Hand-editing a region into an
 *    existing hostname produces a host that resolves to the wrong cluster or to
 *    nothing, with no error until the first query. So the region actually in use
 *    is logged, rather than the region someone believes is configured.
 *
 * Returns a verdict the caller logs. Never throws: a diagnostic that can take
 * the site down is worse than the diagnostic.
 */
export type ConnectionRisk =
  | { kind: "ok" }
  | { kind: "unknown"; detail: string }
  | { kind: "ipv6-only"; detail: string }
  | { kind: "no-host"; detail: string };

export async function auditConnection(url: string): Promise<ConnectionRisk> {
  const host = dbHost(url);
  if (!host) return { kind: "no-host", detail: "DATABASE_URL could not be parsed, so the host is unknown" };
  try {
    /* `dns/promises` is only present on the node runtime, and this module is
     * also loaded by tooling that does not resolve DNS at all. Missing capability
     * is "unknown", never a failure. */
    const dns = await import("node:dns/promises");
    const v4 = await dns.resolve4(host).catch(() => [] as string[]);
    const v6 = await dns.resolve6(host).catch(() => [] as string[]);
    if (!v4.length && !v6.length) return { kind: "unknown", detail: `${host} did not resolve` };
    if (v4.length || !v6.length) return { kind: "ok" };

    /* AAAA only. Whether that is fatal depends on this process having an IPv6
     * route, which is why the check is here rather than an assumption: a host
     * with no IPv6 route cannot open the connection at all. */
    let hasIpv6Route = true;
    try {
      const os = await import("node:os");
      const ifaces = os.networkInterfaces();
      hasIpv6Route = Object.values(ifaces).some(
        (list) => (list || []).some((i) => i.family === "IPv6" && !i.internal),
      );
    } catch {
      hasIpv6Route = true; // cannot tell - do not cry wolf
    }
    return hasIpv6Route
      ? { kind: "ok" }
      : {
          kind: "ipv6-only",
          detail:
            `${host} resolves to IPv6 addresses only and this process has no IPv6 route. ` +
            `Every query will fail. Use the pooler hostname from the project's Connect panel ` +
            `(it answers over IPv4) - a Supabase direct host needs the IPv4 add-on.`,
        };
  } catch (e) {
    return { kind: "unknown", detail: (e instanceof Error ? e.message : String(e)) || "could not check" };
  }
}

/*
 * Cache the client on globalThis in production as well as in development.
 *
 * This used to be guarded by NODE_ENV !== "production", which is backwards for
 * a server. In production that guard means the cache is never populated, so
 * every re-evaluation of this module constructs another PrismaClient with its
 * own connection pool, and the first query on each pays for a fresh Postgres
 * TLS handshake instead of reusing a warm connection.
 *
 * That is not theoretical. Measured against the deployed gateway, an authorized
 * heartbeat took 1668ms and an STT request took 3029ms before its quota check -
 * roughly 555ms per database round trip, to a Postgres that should be tens of
 * milliseconds away. Three round trips at 555ms is exactly the heartbeat. The
 * batching in the heartbeat route removed one round trip and changed nothing,
 * because the cost was the connection, not the count.
 *
 * globalThis is the documented way to survive Next.js re-evaluating server
 * modules, and it is process-scoped, so this is one client per container
 * rather than one per request. The existing SQLite pragmas below are unchanged
 * and still only run against a file-backed database.
 */
globalForPrisma.prisma = prisma;

/* What the database connection actually costs, from the only place that can
 * measure it honestly: inside the container, on a warm pooled connection.
 *
 * Every earlier estimate of this number came from the outside, where the
 * handshake and the client both get counted and neither can be told apart. One
 * trivial query per sample, so the number is the round trip and nothing else.
 *
 * Logged at startup rather than on a timer on purpose - this runs once, it is
 * cheap, and a number that appears in the boot log is a number someone can read
 * instead of re-deriving from a guess. A database far from the container prints
 * an obviously bad figure, which is the point.
 */
if (!globalForPrisma.prismaLatency) {
  globalForPrisma.prismaLatency = (async () => {
    const url = String(process.env.DATABASE_URL || "");
    /* Meaningless against the local SQLite file, and it would only add noise to a
     * developer's console. This is a measurement of a network round trip. */
    if (!url || /^file:/.test(url)) return;
    try {
      const pooled = isPooledUrl(url);
      const region = pooledRegion(url);
      const host = dbHost(url);

      /* The two connection-level traps, checked BEFORE the first query so they
       * are a startup line rather than an outage. */
      const risk = await auditConnection(url);
      if (risk.kind === "ipv6-only") console.error(`[db] CONNECTION WILL FAIL: ${risk.detail}`);
      else if (risk.kind === "no-host") console.error(`[db] ${risk.detail}`);
      else if (risk.kind === "unknown") console.warn(`[db] could not verify the database host: ${risk.detail}`);

      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = Date.now();
        await prisma.$queryRawUnsafe("SELECT 1");
        samples.push(Date.now() - t0);
        if (i === 0) await new Promise((r) => setTimeout(r, 50));
      }
      const sorted = samples.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      console.log(
        `[db] host=${host} ${pooled ? `pooled${region ? ` region=${region}` : ""}` : "direct"}` +
          ` round trip median ${median}ms samples=[${samples.join(",")}]ms` +
          (median > 100 ? " - the database is far from this container; see MEMORY.md item 2" : ""),
      );
    } catch (e) {
      /* Never fatal: a database that will not answer a probe must still serve
       * traffic. The message is built by hand because the driver throws a range
       * of shapes here and several of them stringify to nothing, which reads as
       * a silent failure rather than a reported one. */
      const detail = e instanceof Error && e.message ? e.message : String((e as { code?: string })?.code || e || "unknown error");
      console.error(`[db] round-trip probe failed: ${detail}`);
    }
  })();
}

/*
 * The database is a single SQLite file, and it is written to constantly: every
 * customer's PC checks in every few seconds, calls are recorded, leads are
 * imported. In SQLite's default rollback-journal mode a single writer takes an
 * exclusive lock on the whole file, so a burst of those writes blocks every other
 * reader and writer until it times out - which is what took the site down.
 *
 * Write-ahead logging lets readers carry on while a write is in progress, and a
 * single connection stops several connections fighting over the same write lock.
 * Neither changes the data or the schema; both only stop the file locking up.
 * WAL is persistent once set on the file, so this runs once per process.
 */
if (!globalForPrisma.prismaReady) {
  globalForPrisma.prismaReady = (async () => {
    try {
      /* WAL and the busy timeout are SQLite settings. The database is
       * PostgreSQL now, and PRAGMA is a syntax error there, so these are only
       * sent when this connection is actually a SQLite file. Running them
       * unconditionally failed every build and every query on Postgres. */
      if (/^file:/.test(String(process.env.DATABASE_URL || ""))) {
        await prisma.$executeRawUnsafe(`PRAGMA journal_mode = WAL;`);
        await prisma.$executeRawUnsafe(`PRAGMA busy_timeout = 10000;`);
        await prisma.$executeRawUnsafe(`PRAGMA synchronous = NORMAL;`);
      }
    } catch (e) {
      // Never fatal: a database that refuses a pragma must still serve traffic.
      console.error("Could not set SQLite pragmas:", e instanceof Error ? e.message : e);
    }
  })();
}
