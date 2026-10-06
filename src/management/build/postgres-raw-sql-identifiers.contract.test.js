const fs = require("node:fs");
const path = require("node:path");

/* Unquoted mixed-case columns in raw SQL break on PostgreSQL.
 *
 * Postgres folds an unquoted identifier to lower case. A column created quoted as
 * "passwordHash" is therefore unreachable as bare `passwordHash`, and the query
 * fails with 42703 column "passwordhash" does not exist. Quoting the table but
 * not its columns reads as correct SQL and is not.
 *
 * This finds every bare camelCase identifier inside $queryRaw* template literals.
 */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const root = process.argv[2] || path.join(__dirname, "..", "..", "..", "src");
const files = walk(path.resolve(root));
const findings = [];

for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  const re = /\$queryRaw(?:Unsafe)?\(\s*`([\s\S]*?)`/g;
  let m;
  while ((m = re.exec(text))) {
    const sql = m[1];
    // Strip already-quoted identifiers and string literals so only BARE camelCase names remain.
    const bare = sql
      .replace(/"[^"]*"/g, '""')
      .replace(/'[^']*'/g, "''");
    const camel = bare.match(/(?<![.\w$])([a-z]+[A-Z][A-Za-z0-9]*)/g) || [];
    if (camel.length) {
      findings.push({
        file: path.relative(process.cwd(), f),
        cols: [...new Set(camel)],
        sql: sql.replace(/\s+/g, " ").trim().slice(0, 120),
      });
    }
  }
}

if (!findings.length) {
  console.log("PASS: no unquoted mixed-case columns in raw SQL");
} else {
  console.log(`FAIL: ${findings.length} raw SQL quer(ies) reference unquoted mixed-case columns\n`);
  for (const f of findings) {
    console.log(`  ${f.file}`);
    console.log(`    columns: ${f.cols.join(", ")}`);
    console.log(`    sql: ${f.sql}\n`);
  }
  process.exitCode = 1;
}