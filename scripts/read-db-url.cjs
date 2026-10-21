/* Prints the live Supabase connection string, and nothing else.
 *
 * This exists so portal-local.ps1 does not have to pass JavaScript through a
 * shell command line. Windows argument quoting turns an embedded double quote
 * into \" and node then parses garbage - which is exactly how a first attempt
 * at this silently failed to find the URL. A file on disk has no quoting
 * problem at all.
 *
 * Called as: node scripts/read-db-url.cjs
 * The caller captures stdout into $env:DATABASE_URL and must never echo it.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const file = path.join(root, "sugamcp", "myset.cjs");

if (!fs.existsSync(file)) {
  console.error("sugamcp/myset.cjs is missing, so the database URL cannot be read.");
  process.exit(1);
}

const src = fs.readFileSync(file, "utf8");
/* myset.cjs builds the URL by concatenating a base, an encoded password and a
 * suffix, so the whole string is not present in one literal and cannot be
 * grepped out. Reassemble it exactly as that file does. */
const m = src.match(/'(postgresql:\/\/postgres\.[^']+)'\s*\+\s*encodeURIComponent\('([^']*)'\)\s*\+\s*'([^']+)'/);

if (!m) {
  console.error("could not parse the database URL out of sugamcp/myset.cjs");
  process.exit(1);
}

const url = m[1] + encodeURIComponent(m[2]) + m[3];

/* Refuse anything that is not actually postgres: the startup bootstrap treats a
 * non-postgres URL as the legacy SQLite path and would try to migrate it, which
 * is precisely the outcome this whole setup is built to avoid. */
if (!/^postgres(ql)?:\/\//i.test(url)) {
  console.error("read a non-postgres URL; refusing to continue");
  process.exit(1);
}

process.stdout.write(url);
