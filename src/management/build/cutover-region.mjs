/* Supabase region cutover: europe-west1, with gates that refuse to lie.
 *
 * WHY THIS EXISTS
 *
 * Every database round trip from inside the container costs ~247ms, measured
 * (gateway-stage-probe.cjs: runtime-proof minus health, over 3 reads, on a
 * keep-alive connection). This machine reaches the container's own region in
 * 27ms, so that 247ms is the ocean, not a slow host. The heartbeat makes FOUR
 * serialized round trips and so costs ~1s every three seconds, for the whole
 * length of every live call.
 *
 * Supabase binds a project to its region at creation - there is no in-place
 * region change and the dashboard cannot do it. So this is a new project, a
 * data move and a repoint. That is a decision with a downtime window and a
 * rollback story, so it gets a tool with gates rather than a checklist.
 *
 * WHAT THIS WILL NOT DO
 *
 * It will not invent a connection string, guess a project ref, or run a
 * migration it cannot verify. Every step that touches production requires an
 * explicit flag and prints what it is about to do first. `--verify` is safe and
 * read-only and is the step to run first.
 *
 *   node src/management/build/cutover-region.mjs --verify              # read-only, safe
 *   node src/management/build/cutover-region.mjs --plan                # steps only
 *   node src/management/build/cutover-region.mjs --dump  --confirm     # snapshot
 *   node src/management/build/cutover-region.mjs --restore --confirm    # restore
 *   node src/management/build/cutover-region.mjs --repoint              # how-to
 *
 * The last one deliberately does NOT edit Suga. That needs a human at the
 * dashboard, and a tool that silently repoints production at a database nobody
 * has verified is the exact failure this whole file exists to prevent.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const TARGET_REGION = "eu-west-1";

/* The ceiling that makes the migration worth doing. Measured against the
 * container's own region: 27ms. Anything under this and the move bought nothing
 * and the risk was not worth taking. */
const ROUND_TRIP_TARGET_MS = 60;

const env = (name, required = true) => {
  const v = process.env[name];
  if (!v && required) {
    console.error(`\n  ${name} is not set.`);
    console.error("  Source project:  OLD_DATABASE_URL");
    console.error("  Target project:  NEW_DATABASE_URL");
    console.error("  Copy both from each project's Connect panel. Do not hand-edit the\n" +
                  "  region into a host: the pooler hostname embeds it, and editing it\n" +
                  "  by hand produces a host that resolves to the wrong cluster.\n");
    process.exit(2);
  }
  return v || "";
};

const say = (s = "") => console.log(s);
const step = (s) => console.log(`\n  ${s}`);
const warn = (s) => console.log(`  ! ${s}`);
const bad = (s) => { console.error(`\n  FAILED: ${s}\n`); process.exit(1); };

/* Postgres URLs must never be echoed - they carry the password. Host and region
 * are safe and are all a human needs to check. */
function hostOf(url) {
  try { return new URL(url).hostname; } catch { return "(unparseable)"; }
}
function poolerOf(url) {
  const h = hostOf(url);
  return /pooler\./i.test(h) ? "yes - already pooled" : "no - direct connection";
}

/* TCP connect time. Not a query - just the network floor, which is the part a
 * region move actually changes. Repeated because a single sample can land on a
 * bad packet and a human will trust the number in front of them. */
function tcpMs(host, port = 5432, samples = 5) {
  return new Promise((resolve) => {
    const times = [];
    let i = 0;
    const once = () => {
      if (i++ >= samples) return resolve(times.filter(Number.isFinite).sort((a, b) => a - b));
      const t0 = process.hrtime.bigint();
      const s = net.connect({ host, port });
      s.setTimeout(8000);
      s.once("connect", () => { times.push(Number(process.hrtime.bigint() - t0) / 1e6); s.destroy(); once(); });
      const fail = () => { s.destroy(); times.push(NaN); once(); };
      s.once("timeout", fail);
      s.once("error", fail);
    };
    once();
  });
}

function run(cmd, args, extra = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...extra });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`  ${question} Type YES to continue: `)).trim();
  rl.close();
  return a === "YES";
}

async function verify() {
  const oldUrl = env("OLD_DATABASE_URL");
  const newUrl = process.env.NEW_DATABASE_URL || "";
  const oldHost = hostOf(oldUrl);
  const newHost = newUrl ? hostOf(newUrl) : "(not set)";

  say("\n  REGION CHECK (read-only)");
  say(`    source      ${oldHost}   pooler: ${poolerOf(oldUrl)}`);
  if (newUrl) say(`    target      ${newHost}   pooler: ${poolerOf(newUrl)}`);
  else say("    target      not set - set NEW_DATABASE_URL to compare");

  const oldTimes = await tcpMs(oldHost);
  const oldMed = oldTimes[Math.floor(oldTimes.length / 2)];
  say(`\n    TCP to source host from this machine: ${oldTimes.map((x) => x.toFixed(0) + "ms").join(", ")}` +
      `  median ${oldMed ? oldMed.toFixed(0) + "ms" : "unreachable"}`);

  if (newUrl) {
    const newTimes = await tcpMs(newHost);
    const newMed = newTimes[Math.floor(newTimes.length / 2)];
    say(`    TCP to target host from this machine: ${newTimes.map((x) => x.toFixed(0) + "ms").join(", ")}` +
        `  median ${newMed ? newMed.toFixed(0) + "ms" : "unreachable"}`);
    say("");
    if (newMed && oldMed) {
      const delta = oldMed - newMed;
      if (delta <= 0) {
        warn(`the target is NOT closer (${delta.toFixed(0)}ms). Do not migrate - this would add risk for nothing.`);
      } else if (newMed > ROUND_TRIP_TARGET_MS) {
        warn(`the target is closer by ${delta.toFixed(0)}ms but still far from the ${ROUND_TRIP_TARGET_MS}ms target.`);
        warn("Re-check that the new project was actually created in " + TARGET_REGION + ".");
      } else {
        say(`    Good: ${delta.toFixed(0)}ms closer, inside the ${ROUND_TRIP_TARGET_MS}ms target.`);
      }
    }
  }

  say("");
  say("    This is a network floor from YOUR machine. It is a sanity check, not the");
  say("    measurement that decides it. The real number is the boot log after the");
  say("    repoint:   [db] direct round trip median XXms");
  say("");
  return { oldMed, newMed: newUrl ? (await tcpMs(newHost))[0] : null };
}

function plan() {
  say("\n  REGION CUTOVER PLAN");
  say("    Region is bound at project creation. This is a new project, not a setting.\n");
  say("    1. Create a new Supabase project in " + TARGET_REGION + ".");
  say("       Same or next PG major. Keep the old project alive - it is the rollback.");
  say("    2. Snapshot and restore:");
  say("         pg_dump --no-owner --no-acl \"$OLD_DATABASE_URL\" | psql \"$NEW_DATABASE_URL\"");
  say("    3. Point DATABASE_URL in Suga at the NEW project.");
  say("       Copy the whole string from the new Connect panel.");
  say("    4. Deploy the gateway (dashboard UI - there is no MCP deploy tool).");
  say("    5. Read the boot log and confirm:");
  say("         [db] direct round trip median <" + ROUND_TRIP_TARGET_MS + "ms");
  say("       If it is still above 100ms, STOP and roll DATABASE_URL back.");
  say("    6. Only after a verified live call, retire the old project.\n");
  say("    Rollback: until step 3 nothing writes to the new project, so reverting");
  say("    DATABASE_URL is lossless. After step 3 there is no flow back - do not");
  say("    delete the old project until the new one has carried a real call.\n");
  say("    This app uses no Supabase Storage, Edge Functions, or OAuth provider");
  say("    callbacks, so the move is Postgres only. That is the simple case.\n");
}

async function dump() {
  const url = env("OLD_DATABASE_URL");
  const out = path.join(os.tmpdir(), `autodial-${TARGET_REGION}-cutover-${Date.now()}.sql`);
  step("Snapshotting the source project.");
  say(`    host ${hostOf(url)}  pooler: ${poolerOf(url)}`);
  say(`    ->   ${out}`);
  if (!(await confirm("This reads every row of production. Proceed?"))) return bad("cancelled");
  const r = run("pg_dump", ["--no-owner", "--no-acl", "--file", out, url]);
  if (r.code !== 0) return bad(`pg_dump exited ${r.code}\n${r.out.slice(-800)}`);
  const size = fs.statSync(out).size;
  if (size < 1024) return bad(`the dump is only ${size} bytes. An empty dump is not a migration.`);
  say(`\n    OK  ${(size / 1024 / 1024).toFixed(1)} MB written.`);
  say(`    Keep this file. It is the only copy of the source until the restore is verified.`);
  say(`    Restore it with:  node src/management/build/cutover-region.mjs --restore --confirm`);
}

async function restore() {
  const url = env("NEW_DATABASE_URL");
  const dir = os.tmpdir();
  const candidates = fs.readdirSync(dir)
    .filter((f) => f.startsWith(`autodial-${TARGET_REGION}-cutover-`) && f.endsWith(".sql"))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!candidates.length) return bad(`no dump found in ${dir}. Run --dump first.`);
  const file = path.join(dir, candidates[0].f);
  step("Restoring into the target project.");
  say(`    target ${hostOf(url)}  pooler: ${poolerOf(url)}`);
  say(`    source ${file}`);
  if (!(await confirm("This writes every row into the NEW project. Proceed?"))) return bad("cancelled");
  const r = run("psql", ["-v", "ON_ERROR_STOP=1", url, "-f", file]);
  if (r.code !== 0) return bad(`psql exited ${r.code}\n${r.out.slice(-1200)}`);
  say("\n    OK  restore reported success.");
  warn("A clean exit is not a verified migration. Check row counts on both sides before repointing:");
  say(`      SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 15;`);
  say("    Compare source and target. Users, leads and calls are what matter.");
}

function repoint() {
  step("Repointing DATABASE_URL");
  say("    This tool deliberately does NOT edit the Suga environment.");
  say("    A script that repoints production at an unverified database is the exact");
  say("    failure this whole tool exists to prevent.\n");
  say("    Do it by hand:");
  say("      1. Suga dashboard -> your project -> environment -> DATABASE_URL");
  say("      2. Paste the full connection string from the NEW project's Connect panel.");
  say("      3. Deploy via the dashboard UI (set_env_variable only stages).");
  say("      4. Then read the boot log:");
  say("           [db] direct round trip median XXms samples=[...]ms");
  say(`      5. Above ${ROUND_TRIP_TARGET_MS}ms is a failed migration: set DATABASE_URL back immediately.`);
  say("         The old project is still authoritative until you do.");
}

(async () => {
  say("\n  Supabase region cutover -> " + TARGET_REGION);
  const actions = [verify, plan, dump, restore, repoint].filter((_, i) =>
    [flag("--verify"), flag("--plan"), flag("--dump"), flag("--restore"), flag("--repoint")][i]);

  if (!actions.length) {
    say("\n  Nothing to do. Pick one:");
    say("    --verify     read-only comparison of source and target hosts");
    say("    --plan       print the steps, change nothing");
    say("    --dump       snapshot the source project to a file");
    say("    --restore    restore a snapshot into the target project");
    say("    --repoint    how to change DATABASE_URL, by hand\n");
    process.exit(0);
  }

  if (!flag("--confirm") && (flag("--dump") || flag("--restore"))) {
    bad("destructive steps need --confirm");
  }

  for (const a of actions) await a();
  say("");
})().catch((e) => { console.error("\n  FAILED:", e && e.message); process.exit(1); });