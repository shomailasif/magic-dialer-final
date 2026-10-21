/* Fill the engine's local lead cache from a verified Supabase export.
 *
 * WHY THIS EXISTS
 *
 * The engine's queue always asks the portal first and falls back to a local
 * cache when the portal cannot be reached. That fallback only ever holds leads
 * the portal handed over on a previous successful read, and this PC's cache is
 * empty: the site has been down since 13 October, so nothing was ever cached.
 * When Supabase is closed the portal is not coming back at all, and an empty
 * cache means the campaign has nothing to dial even though the leads still
 * exist - they are simply about to be unreachable.
 *
 * This writes the portal's own rows, read from the backup we took and
 * verified, into that cache using the engine's own `cacheLeads`, so the shape,
 * schema and dedupe-by-phone behaviour are exactly what a portal read would
 * have produced. Nothing is invented, no other customer's leads are touched,
 * and every phone written is recorded so `--undo` can take it back out.
 *
 *   node scripts/prime-lead-cache.cjs --dry-run
 *   node scripts/prime-lead-cache.cjs
 *   node scripts/prime-lead-cache.cjs --undo
 *
 * The engine must be stopped: it holds the SQLite file open.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const AGENT_DIR = process.env.AUTODIAL_HOME || path.join(require("node:os").homedir(), ".magicdialer");
const MANIFEST = path.join(AGENT_DIR, "lead-cache-prime.json");
const BACKUP_ROOT = "C:\\Users\\USER\\Documents\\MagicDialerBackup";

const NEVER_DIAL = new Set(["CALLED", "CONVERTED", "NOT_INTERESTED", "FAILED", "OPT_OUT", "DO_NOT_CALL", "SUPPRESSED"]);
const digits = (s) => String(s || "").replace(/\D/g, "");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const undo = args.includes("--undo");
const force = args.includes("--force");

function die(msg) { console.error("ERROR: " + msg); process.exit(1); }

function engineRunning() {
  try {
    const out = execSync('netstat -ano | findstr /R "LISTENING" | findstr ":18787"', { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return Boolean(out.trim());
  } catch { return false; }
}

function latestBackup() {
  if (process.argv.includes("--backup")) {
    const i = process.argv.indexOf("--backup");
    const p = process.argv[i + 1];
    if (!p) die("--backup needs a folder");
    return p;
  }
  const dirs = fs.readdirSync(BACKUP_ROOT)
    .filter((d) => d.startsWith("supabase-full-"))
    .map((d) => path.join(BACKUP_ROOT, d))
    .filter((p) => fs.existsSync(path.join(p, "Lead.json")))
    .sort();
  if (!dirs.length) die("no supabase-full-* export found in " + BACKUP_ROOT);
  return dirs[dirs.length - 1];
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }

async function main() {
  if (engineRunning() && !force && !dryRun) {
    die("the engine is running (port 18787). Stop it first, or pass --force if you are certain it is idle.");
  }

  if (undo) {
    if (!fs.existsSync(MANIFEST)) die("no prime manifest at " + MANIFEST + " - nothing to undo");
    const m = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
    /* Only removes what is still untouched: anything already dialled since the
     * prime is history worth keeping, not something to erase. */
    const removed = rawRemove(m.phones);
    fs.unlinkSync(MANIFEST);
    console.log(`undone: removed ${removed} of ${m.count} primed leads (kept any already dialled)`);
    return;
  }

  const backup = latestBackup();
  const config = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, "config.json"), "utf8"));
  const company = String(config.companyName || "").trim();
  if (!company) die("this PC has no companyName in config.json - refusing to guess whose leads to load");

  const users = readJson(path.join(backup, "User.json")).rows;
  const mine = new Set(users.filter((u) => String(u.companyName || "").trim().toLowerCase() === company.toLowerCase()).map((u) => u.id));
  if (!mine.size) die(`no account in the export matches this PC's "${company}" - refusing to load somebody else's leads`);

  const all = readJson(path.join(backup, "Lead.json")).rows;
  const counts = { total: all.length, wrongAccount: 0, status: 0, doNotCall: 0, consent: 0, badPhone: 0, kept: 0 };
  const kept = [];

  for (const r of all) {
    if (!mine.has(r.userId)) { counts.wrongAccount++; continue; }
    if (NEVER_DIAL.has(String(r.status || "").toUpperCase())) { counts.status++; continue; }
    if (r.doNotCall === true) { counts.doNotCall++; continue; }
    if (String(r.consentStatus || "").toUpperCase() === "DENIED") { counts.consent++; continue; }
    const d = digits(r.phone);
    if (d.length < 7 || d.length > 15) { counts.badPhone++; continue; }
    let extra = {};
    try { extra = typeof r.extraData === "string" ? JSON.parse(r.extraData || "{}") : (r.extraData || {}); } catch {}
    kept.push({
      id: r.id,
      name: r.name || null,
      phone: r.phone,
      email: r.email || null,
      company: r.company || null,
      status: r.status,
      createdAt: r.createdAt || null,
      extraData: extra,
      fields: extra,
    });
    counts.kept++;
  }

  console.log("backup   : " + backup);
  console.log("account  : " + company + "  (" + mine.size + " user id(s))");
  console.log("");
  console.log("  leads in export          " + counts.total);
  console.log("  other accounts (kept out) " + counts.wrongAccount);
  console.log("  already handled status    " + counts.status);
  console.log("  do-not-call               " + counts.doNotCall);
  console.log("  consent denied            " + counts.consent);
  console.log("  unusable number           " + counts.badPhone);
  console.log("  -> to cache               " + counts.kept);

  if (dryRun) { console.log("\ndry run - nothing written"); return; }
  if (!counts.kept) die("nothing qualified to cache");

  const localDb = require(path.join(ROOT, "src", "management", "agent", "local-db.js"));
  localDb.open(AGENT_DIR);
  const written = localDb.cacheLeads(kept);
  const phones = kept.map((k) => String(k.phone));
  fs.writeFileSync(MANIFEST, JSON.stringify({
    primedAt: new Date().toISOString(),
    backup,
    company,
    count: written,
    phones,
  }, null, 1), "utf8");

  const nowCached = localDb.cachedLeads(100000).length;
  console.log("");
  console.log("written  : " + written + " leads into " + path.join(AGENT_DIR, "agent.db"));
  console.log("readable : " + nowCached + " leads now available to the queue while offline");
  console.log("rollback : node scripts/prime-lead-cache.cjs --undo");
}

function rawRemove(phones) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(AGENT_DIR, "agent.db"));
  let n = 0;
  const stmt = db.prepare("DELETE FROM lead_cache WHERE phone = ? AND called_at IS NULL");
  for (const p of phones) { try { if (stmt.run(String(p)).changes) n++; } catch {} }
  db.close();
  return n;
}

main().catch((e) => { console.error("FAILED: " + (e && e.message)); process.exit(1); });
