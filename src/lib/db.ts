import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaReady?: Promise<void>;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

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
      await prisma.$executeRawUnsafe(`PRAGMA journal_mode = WAL;`);
      await prisma.$executeRawUnsafe(`PRAGMA busy_timeout = 10000;`);
      await prisma.$executeRawUnsafe(`PRAGMA synchronous = NORMAL;`);
    } catch (e) {
      // Never fatal: a database that refuses a pragma must still serve traffic.
      console.error("Could not set SQLite pragmas:", e instanceof Error ? e.message : e);
    }
  })();
}
