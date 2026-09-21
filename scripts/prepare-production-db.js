const { execFileSync, spawnSync } = require("node:child_process");
const { copyFileSync, constants, existsSync, readdirSync, rmSync } = require("node:fs");
const { join, resolve, isAbsolute } = require("node:path");
const { tmpdir } = require("node:os");
const { PrismaClient } = require("@prisma/client");

const root = resolve(__dirname, "..");
const migrationsDir = join(root, "prisma", "migrations");
const schemaPath = join(root, "prisma", "schema.prisma");
const databaseUrl = process.env.DATABASE_URL;
const prismaBin = join(root, "node_modules", ".bin", process.platform === "win32" ? "prisma.cmd" : "prisma");

if (!databaseUrl || !databaseUrl.startsWith("file:")) {
  throw new Error("Production database preparation requires an explicit SQLite DATABASE_URL.");
}
if (!existsSync(prismaBin)) {
  throw new Error("Prisma CLI is unavailable; refusing to start with an unverifiable database schema.");
}

function run(args, options = {}) {
  return execFileSync(prismaBin, args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function dbFilePath() {
  const raw = databaseUrl.slice("file:".length).split("?")[0];
  return isAbsolute(raw) ? raw : resolve(root, "prisma", raw);
}

function migrationNames() {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(migrationsDir, entry.name, "migration.sql")))
    .map((entry) => entry.name)
    .sort();
}

function shadowUrl() {
  const p = join(tmpdir(), `magic-dialer-shadow-${process.pid}.db`);
  rmSync(p, { force: true });
  return { path: p, url: `file:${p}` };
}

function diffArgs(shadow, extra = []) {
  return [
    "migrate", "diff",
    "--from-url", databaseUrl,
    "--to-migrations", migrationsDir,
    "--shadow-database-url", shadow.url,
    ...extra,
  ];
}

async function main() {
  const client = new PrismaClient();
  let hasHistory = false;
  try {
    const rows = await client.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'"
    );
    hasHistory = Array.isArray(rows) && rows.length > 0;
  } finally {
    await client.$disconnect();
  }

  if (!hasHistory) {
    const dbPath = dbFilePath();
    if (existsSync(dbPath)) {
      const backup = `${dbPath}.pre-migrate-${Date.now()}.bak`;
      copyFileSync(dbPath, backup, constants.COPYFILE_EXCL);
      console.log(`Production DB backup created: ${backup}`);
    }

    const shadow = shadowUrl();
    const forwardSql = join(tmpdir(), `magic-dialer-forward-${process.pid}.sql`);
    try {
      run(diffArgs(shadow, ["--script", "--output", forwardSql]));
      run(["db", "execute", "--url", databaseUrl, "--file", forwardSql], { stdio: "inherit" });

      const verify = spawnSync(prismaBin, diffArgs(shadow, ["--exit-code"]), {
        cwd: root,
        env: process.env,
        encoding: "utf8",
        stdio: "pipe",
      });
      if (verify.status !== 0) {
        throw new Error(`Database reconciliation verification failed (exit ${verify.status}): ${verify.stderr || verify.stdout}`);
      }

      for (const migration of migrationNames()) {
        run(["migrate", "resolve", "--applied", migration, "--schema", schemaPath], { stdio: "inherit" });
      }
    } finally {
      rmSync(forwardSql, { force: true });
      rmSync(shadow.path, { force: true });
    }
  }

  run(["migrate", "deploy", "--schema", schemaPath], { stdio: "inherit" });
  run(["migrate", "status", "--schema", schemaPath], { stdio: "inherit" });

  const verifyShadow = shadowUrl();
  try {
    const verify = spawnSync(prismaBin, diffArgs(verifyShadow, ["--exit-code"]), {
      cwd: root,
      env: process.env,
      encoding: "utf8",
      stdio: "pipe",
    });
    if (verify.status !== 0) {
      throw new Error(`Final database schema verification failed (exit ${verify.status}): ${verify.stderr || verify.stdout}`);
    }
  } finally {
    rmSync(verifyShadow.path, { force: true });
  }

  const integrity = new PrismaClient();
  try {
    const rows = await integrity.$queryRawUnsafe("PRAGMA integrity_check");
    const values = rows.flatMap((row) => Object.values(row)).map(String);
    if (values.length !== 1 || values[0].toLowerCase() !== "ok") {
      throw new Error(`SQLite integrity_check failed: ${JSON.stringify(rows)}`);
    }
  } finally {
    await integrity.$disconnect();
  }

  console.log("Production database preparation PASS");
}

main().catch((error) => {
  console.error("Production database preparation FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
