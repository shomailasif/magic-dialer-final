#!/usr/bin/env node
"use strict";

/* Grant and revoke subscriptions. No server, no dashboard, no URL.
 *
 *   node scripts/license-grant.cjs keygen --embed
 *       One-time. Creates your signing key and puts the matching public key
 *       into the engine. The private key stays on this PC.
 *
 *   node scripts/license-grant.cjs grant --machine <CODE> --days 30 --name "Zaz Logistics"
 *       Issues a licence for one PC and prints it. Send that string to the
 *       customer; they paste it into their dashboard. Also remembers, in your
 *       private ledger, which customer it went to.
 *
 *   node scripts/license-grant.cjs revoke --machine <CODE>
 *       (or --id <licence id>, or --name "Zaz Logistics")
 *       Adds the id to the public list and pushes. Their PC stops on its next
 *       check - within minutes - without you hosting anything.
 *
 *   node scripts/license-grant.cjs list
 *       Your ledger: who has what, when it expires, what you revoked.
 *
 *   node scripts/license-grant.cjs check "<MDL1....>"
 *       Verifies a key the way the customer's PC will, so you know it works
 *       before you send it.
 *
 * <CODE> is the activation code shown on the customer's dashboard - their
 * machineId. You never need access to their PC or their data to grant, and
 * nothing here reads what they called.
 */

const lib = require("./license-lib.cjs");

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function die(msg, code = 1) {
  console.error("\nERROR: " + msg + "\n");
  process.exit(code);
}

/* `--push false` arrives as the string "false", and `--no-push` as true, so a
 * plain truthiness check would publish anyway. A tool that cannot be stopped
 * from publishing is the wrong tool for anything but a deliberate revocation. */
function wantsPush(argv) {
  if (argv["no-push"] === true || argv["no-push"] === "true") return false;
  if (argv.push === false || argv.push === "false") return false;
  return true;
}

function hr() {
  console.log("-".repeat(78));
}

const argv = args(process.argv.slice(2));
const cmd = argv._[0] || "help";

/* ── keygen ─────────────────────────────────────────────────────────────── */
if (cmd === "keygen") {
  let r;
  try { r = lib.keygen({ embed: argv.embed === true }); }
  catch (e) { die(e.message); }
  console.log("New licence signing keypair created.");
  console.log("  private key : " + lib.PRIVATE_KEY_PATH + "   (gitignored - keep a backup)");
  if (r.embedded) console.log("  public key  : embedded into src/management/agent/license.js");
  else console.log("  public key  : " + r.publicB64 + "\n  (re-run with --embed to write it into license.js)");
  console.log("");
  console.log("Licences signed with the PREVIOUS key stop verifying after this,");
  console.log("so only rotate when you intend to reissue every customer key.");
  process.exit(0);
}

/* ── grant ──────────────────────────────────────────────────────────────── */
if (cmd === "grant") {
  const machine = String(argv.machine || argv.code || "").trim();
  if (!machine) die("Missing --machine. Use the activation code shown on the customer's dashboard.");
  const name = String(argv.name || "").trim();

  let created;
  try {
    created = lib.createGrant({
      machineId: machine,
      name,
      plan: argv.plan,
      days: argv.days,
      until: argv.until,
    });
  } catch (e) {
    die(e.message);
  }

  hr();
  console.log("LICENCE ISSUED" + (name ? `  for ${name}` : ""));
  hr();
  console.log("  activation code : " + machine);
  console.log("  licence id      : " + created.payload.id);
  console.log("  valid until     : " + (created.payload.until ? new Date(created.payload.until).toISOString().slice(0, 10) : "no expiry"));
  console.log("  ledger          : " + lib.LEDGER_PATH);
  hr();
  console.log("");
  console.log("Send this key to the customer. They paste it into their dashboard:");
  console.log("");
  console.log(created.key);
  console.log("");
  hr();
  process.exit(0);
}

/* ── revoke ─────────────────────────────────────────────────────────────── */
if (cmd === "revoke") {
  /* Kept as the old spelling of "cancel". It must not keep its own copy of the
   * logic: a revocation that leaves a suspension behind, or a ledger saying
   * "revoked" while the public list says otherwise, is how two sources of
   * truth start disagreeing. */
  const q = whoFrom(argv);
  needWho(q);
  let r;
  try { r = lib.cancelGrant(Object.assign({}, q, { reason: argv.reason || "subscription cancelled", push: wantsPush(argv) })); }
  catch (e) { die(e.message); }
  hr();
  console.log("CANCELLED  " + r.grant.name + "  (" + r.grant.machineId + ")");
  showPublication(r.publication);
  hr();
  process.exit(0);
}

/* ── list ───────────────────────────────────────────────────────────────── */
/* ── suspend / reinstate / cancel / renew ────────────────────────────────
 * The same four actions the admin console offers, for when the browser is
 * not the tool at hand. They share license-lib.cjs with the console, so the
 * two can never disagree about what a suspension means. */
function whoFrom(argv) {
  return {
    id: String(argv.id || "").trim(),
    machineId: String(argv.machine || argv.code || "").trim(),
    name: String(argv.name || "").trim(),
  };
}
function needWho(q) {
  if (!q.id && !q.machineId && !q.name) {
    die("Say who with --id <licence id>, --machine <CODE> or --name \"Customer\".");
  }
}
function showPublication(p, verb) {
  if (p && p.pushed) {
    console.log("  published to main - engines pick it up on their next check (a few minutes for the raw cache).");
  } else if (p && p.reason && p.reason !== "no change to publish" && p.reason !== "nothing public changed" && p.reason !== "push disabled") {
    console.log("  NOT PUBLISHED: " + p.reason);
    console.log("  Run: git add licenses/revoked.json licenses/suspended.json && git commit -m ... && git push final HEAD:main");
  } else if (verb) {
    console.log("  " + verb);
  }
}

if (cmd === "suspend") {
  const q = whoFrom(argv);
  needWho(q);
  let r;
  try { r = lib.suspendGrant(Object.assign({}, q, { reason: argv.reason || "payment not received", push: wantsPush(argv) })); }
  catch (e) { die(e.message); }
  hr();
  console.log("SUSPENDED  " + r.grant.name + "  (" + r.grant.machineId + ")");
  console.log("  reversible: `reinstate --id " + r.grant.id + "` puts them back.");
  showPublication(r.publication);
  hr();
  process.exit(0);
}

if (cmd === "reinstate") {
  const q = whoFrom(argv);
  needWho(q);
  let r;
  try { r = lib.reinstateGrant(Object.assign({}, q, { push: wantsPush(argv) })); }
  catch (e) { die(e.message); }
  hr();
  console.log("REINSTATED  " + r.grant.name + "  (" + r.grant.machineId + ")");
  showPublication(r.publication, "was not suspended - nothing to publish.");
  hr();
  process.exit(0);
}

if (cmd === "cancel") {
  const q = whoFrom(argv);
  needWho(q);
  let r;
  try { r = lib.cancelGrant(Object.assign({}, q, { reason: argv.reason || "subscription cancelled", push: wantsPush(argv) })); }
  catch (e) { die(e.message); }
  hr();
  console.log("CANCELLED  " + r.grant.name + "  (" + r.grant.machineId + ")");
  console.log("  permanent: the console has no un-cancel. Use `suspend` for late payment.");
  showPublication(r.publication);
  hr();
  process.exit(0);
}

if (cmd === "renew") {
  const id = String(argv.id || "").trim();
  if (!id) die("Renew needs --id <licence id> (see `list`), plus --days N or --until DATE.");
  let expires = null;
  if (argv.until) {
    const d = Date.parse(String(argv.until));
    if (!Number.isFinite(d)) die("--until must be a date such as 2026-12-31");
    expires = new Date(d).toISOString();
  } else if (argv.days) {
    expires = lib.addDays(argv.days);
    if (!expires) die("--days must be a number greater than zero");
  } else die("Renew needs --days N or --until DATE.");
  let r;
  try { r = lib.renewGrant({ id, days: argv.days, until: expires, push: wantsPush(argv) }); }
  catch (e) { die(e.message); }
  hr();
  console.log("RENEWED  " + r.grant.name + "  until " + new Date(r.payload.until).toISOString().slice(0, 10));
  if (r.grant.status === "suspended") console.log("  note: still suspended for payment - `reinstate` when it is settled.");
  hr();
  console.log("Send the new key to the customer:");
  console.log("");
  console.log(r.key);
  console.log("");
  hr();
  process.exit(0);
}

if (cmd === "list") {
  const ledger = lib.readLedger();
  const revoked = new Set(lib.readRevoked().revoked);
  const suspended = new Set(lib.readSuspended().suspended);
  if (!ledger.grants.length) { console.log("No licences granted yet."); process.exit(0); }
  hr();
  console.log("YOUR LICENCES  (private ledger - " + lib.LEDGER_PATH + ")");
  hr();
  console.log("STATUS".padEnd(10) + "UNTIL".padEnd(13) + "NAME".padEnd(24) + "ACTIVATION CODE");
  for (const g of ledger.grants) {
    const state = lib.grantState(g, revoked, suspended).toUpperCase();
    console.log(
      state.padEnd(10) +
      (g.until ? new Date(g.until).toISOString().slice(0, 10) : "never").padEnd(13) +
      String(g.name || "").slice(0, 23).padEnd(24) +
      g.machineId
    );
  }
  hr();
  process.exit(0);
}

/* ── check ──────────────────────────────────────────────────────────────── */
if (cmd === "check") {
  const key = String(argv._[1] || argv.key || "").trim();
  if (!key) die('Missing the key to check:  license-grant.cjs check "MDL1...."');
  const lic = require("../src/management/agent/license.js");
  const machine = String(argv.machine || "").trim();
  const parsed = lic.parse(key);
  if (parsed.error) { console.log("INVALID (" + parsed.error + "): " + parsed.message); process.exit(1); }
  console.log("signature  : genuine");
  console.log("licence id : " + parsed.payload.id);
  console.log("machine    : " + parsed.payload.machineId + (machine ? (machine === parsed.payload.machineId ? "  (matches)" : "  <-- DIFFERENT from") : ""));
  console.log("expires    : " + (parsed.payload.until ? new Date(parsed.payload.until).toISOString().slice(0, 10) : "never"));
  if (machine) {
    const v = lic.verify(key, machine);
    console.log("verdict    : " + (v.ok ? "ACCEPTED" : "REFUSED - " + v.message));
    if (!v.ok) process.exit(1);
  }
  process.exit(0);
}

/* ── help ───────────────────────────────────────────────────────────────── */
console.log(`
Licence tool - grant, suspend, reinstate and cancel with no server and no URL.

  keygen  [--embed]                                create/rotate your signing key
  grant   --machine CODE [--days N | --until DATE] [--name "Customer"]
                                                  issue a key, print it
  suspend --id ID | --machine CODE | --name NAME  stop for non-payment (reversible, pushes)
  reinstate --id ID | --machine CODE | --name NAME put a suspended PC back on (pushes)
  cancel  --id ID | --machine CODE | --name NAME  permanent stop (pushes)
  renew   --id ID [--days N | --until DATE]       re-sign the same id, print the new key
  list                                            your ledger
  check   "MDL1..." [--machine CODE]              verify a key like the engine will

The activation CODE is the machineId shown on the customer's own dashboard.
Your private key and ledger are gitignored; only revoked.json and
suspended.json are published.
`);
process.exit(0);
