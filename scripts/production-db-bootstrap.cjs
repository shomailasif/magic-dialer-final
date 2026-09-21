"use strict";

const { PrismaClient } = require("@prisma/client");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const prisma = new PrismaClient();
const migrationRoot = path.join(process.cwd(), "prisma", "migrations");

function prismaBin() {
  const bin = process.platform === "win32"
    ? path.join(process.cwd(), "node_modules", ".bin", "prisma.cmd")
    : path.join(process.cwd(), "node_modules", ".bin", "prisma");
  if (!fs.existsSync(bin)) throw new Error("Prisma CLI is unavailable in the production image; refusing to start with an unverifiable database schema.");
  return bin;
}

function runPrisma(args, allowedStatuses = [0]) {
  const result = spawnSync(prismaBin(), args, { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (!allowedStatuses.includes(result.status)) throw new Error(`prisma ${args.join(" ")} failed with exit code ${result.status}`);
  return result.status;
}

async function objectExists(type, name) {
  const rows = await prisma.$queryRawUnsafe("SELECT 1 AS present FROM sqlite_schema WHERE type = ? AND name = ? LIMIT 1", type, name);
  return rows.length > 0;
}

async function columnExists(table, column) {
  const escaped = table.replace(/"/g, '""');
  const rows = await prisma.$queryRawUnsafe(`PRAGMA table_info("${escaped}")`);
  return rows.some((row) => String(row.name) === column);
}

function migrationNames() {
  return fs.readdirSync(migrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(migrationRoot, entry.name, "migration.sql")))
    .map((entry) => entry.name)
    .sort();
}

function statementsFor(name) {
  const sql = fs.readFileSync(path.join(migrationRoot, name, "migration.sql"), "utf8");
  return sql.split(";").map((part) => part.replace(/^\s*(?:--[^\n]*\n\s*)*/g, "").trim()).filter(Boolean);
}

async function applyAdditiveStatement(statement) {
  let match = statement.match(/^ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+COLUMN\s+"([^"]+)"\s+/i);
  if (match) {
    if (!(await columnExists(match[1], match[2]))) await prisma.$executeRawUnsafe(statement);
    return;
  }

  match = statement.match(/^CREATE\s+TABLE\s+"([^"]+)"\s*\(/i);
  if (match) {
    if (!(await objectExists("table", match[1]))) await prisma.$executeRawUnsafe(statement);
    return;
  }

  match = statement.match(/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+"([^"]+)"\s+ON\s+/i);
  if (match) {
    if (!(await objectExists("index", match[1]))) await prisma.$executeRawUnsafe(statement);
    return;
  }

  throw new Error("Legacy adoption encountered a non-additive or unsupported migration statement; refusing to mutate production.");
}

async function tableNames() {
  const rows = await prisma.$queryRawUnsafe("SELECT name FROM sqlite_schema WHERE type='table'");
  return new Set(rows.map((row) => String(row.name)));
}

async function verifyIntegrity() {
  const rows = await prisma.$queryRawUnsafe("PRAGMA integrity_check");
  const values = rows.flatMap((row) => Object.values(row).map(String));
  if (values.length !== 1 || values[0].toLowerCase() !== "ok") throw new Error("SQLite integrity_check failed after legacy adoption.");
}

async function main() {
  const tables = await tableNames();
  const hasHistory = tables.has("_prisma_migrations");
  const appTables = [...tables].filter((name) => !name.startsWith("sqlite_") && name !== "_prisma_migrations");

  if (hasHistory || appTables.length === 0) {
    await prisma.$disconnect();
    runPrisma(["migrate", "deploy"]);
    runPrisma(["migrate", "status"]);
    return;
  }

  console.log("[db-bootstrap] Legacy untracked database detected; performing one-time additive adoption.");
  const names = migrationNames();
  for (const name of names) {
    if (name === "0_init") continue;
    for (const statement of statementsFor(name)) await applyAdditiveStatement(statement);
  }
  await verifyIntegrity();
  await prisma.$disconnect();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for legacy schema verification.");
  runPrisma(["migrate", "diff", "--from-url", databaseUrl, "--to-schema", "prisma/schema.prisma", "--exit-code"]);

  for (const name of names) runPrisma(["migrate", "resolve", "--applied", name]);

  runPrisma(["migrate", "deploy"]);
  runPrisma(["migrate", "status"]);
  console.log("[db-bootstrap] Legacy database adoption complete.");
}

main().catch(async (error) => {
  try { await prisma.$disconnect(); } catch {}
  console.error("[db-bootstrap] Database readiness failed; application will not start:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
