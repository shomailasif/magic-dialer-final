"use strict";

const { PrismaClient } = require("@prisma/client");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const prisma = new PrismaClient();
const migrationRoot = path.join(process.cwd(), "prisma", "migrations");

function runPrisma(args) {
  const bin = process.platform === "win32"
    ? path.join(process.cwd(), "node_modules", ".bin", "prisma.cmd")
    : path.join(process.cwd(), "node_modules", ".bin", "prisma");
  if (!fs.existsSync(bin)) {
    throw new Error("Prisma CLI is unavailable in the production image; refusing to start with an unverifiable database schema.");
  }
  const result = spawnSync(bin, args, { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`prisma ${args.join(" ")} failed with exit code ${result.status}`);
}

async function tableNames() {
  const rows = await prisma.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table'");
  return new Set(rows.map((row) => String(row.name)));
}

function migrationNames() {
  return fs.readdirSync(migrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(migrationRoot, entry.name, "migration.sql")))
    .map((entry) => entry.name)
    .sort();
}

async function main() {
  const tables = await tableNames();
  const hasHistory = tables.has("_prisma_migrations");
  const appTables = [...tables].filter((name) => !name.startsWith("sqlite_") && name !== "_prisma_migrations");

  await prisma.$disconnect();

  if (hasHistory || appTables.length === 0) {
    runPrisma(["migrate", "deploy"]);
    runPrisma(["migrate", "status"]);
    return;
  }

  // Legacy production databases were managed by db push and have no migration history.
  // Reconcile to the checked-in schema without --accept-data-loss, then adopt the
  // complete checked-in history. Any destructive reconciliation fails closed.
  console.log("[db-bootstrap] Legacy untracked database detected; performing one-time safe adoption.");
  runPrisma(["db", "push", "--skip-generate"]);

  for (const name of migrationNames()) {
    runPrisma(["migrate", "resolve", "--applied", name]);
  }

  runPrisma(["migrate", "deploy"]);
  runPrisma(["migrate", "status"]);
  console.log("[db-bootstrap] Legacy database adoption complete.");
}

main().catch(async (error) => {
  try { await prisma.$disconnect(); } catch {}
  console.error("[db-bootstrap] Database readiness failed; application will not start:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
