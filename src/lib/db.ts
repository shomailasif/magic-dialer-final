import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaReady?: Promise<void>;
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

/* Append a connection limit unless the URL already carries one. */
function withPoolLimit(url: string | undefined) {
  if (!url) return undefined;
  if (/[?&]connection_limit=/.test(url)) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}connection_limit=${process.env.AUTODIAL_DB_POOL_LIMIT || "10"}`;
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
