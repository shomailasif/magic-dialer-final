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

function statusOf(grant, revokedSet, now = Date.now()) {
  if (grant.revokedAt) return "REVOKED";
  if (revokedSet.has(grant.id)) return "REVOKED";
  if (grant.until && now > Date.parse(grant.until)) return "EXPIRED";
  return "ACTIVE";
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

  let until = null;
  if (argv.until) {
    const d = Date.parse(String(argv.until));
    if (!Number.isFinite(d)) die("--until must be a date such as 2026-12-31");
    until = new Date(d).toISOString();
  } else if (argv.days) {
    until = lib.addDays(argv.days);
    if (!until) die("--days must be a number greater than zero");
  }

  let signed;
  try { signed = lib.signLicense({ machineId: machine, until }); }
  catch (e) { die(e.message); }

  const name = String(argv.name || "").trim();
  const ledger = lib.readLedger();

  /* Re-granting a machine you revoked before: take it back off the public
   * list, otherwise you would hand over a key that is still refused. */
  const revoked = lib.readRevoked();
  const before = revoked.revoked.length;
  revoked.revoked = revoked.revoked.filter((id) => id !== signed.payload.id);
  const removedFromList = revoked.revoked.length !== before;
  if (removedFromList) lib.writeRevoked(revoked);

  ledger.grants.push({
    id: signed.payload.id,
    machineId: signed.payload.machineId,
    name: name || "(unnamed)",
    grantedAt: new Date().toISOString(),
    until: until,
    status: "active",
    revokedAt: null,
  });
  lib.writeLedger(ledger);

  if (removedFromList && wantsPush(argv)) {
    const p = lib.publish(`licence: reinstate ${name || signed.payload.id}`);
    if (!p.pushed) console.error("NOTE: could not publish the reinstatement: " + p.reason);
  }

  hr();
  console.log("LICENCE ISSUED" + (name ? `  for ${name}` : ""));
  hr();
  console.log("  activation code : " + machine);
  console.log("  licence id      : " + signed.payload.id);
  console.log("  valid until     : " + (until ? new Date(until).toISOString().slice(0, 10) : "no expiry"));
  console.log("  ledger          : " + lib.LEDGER_PATH);
  hr();
  console.log("");
  console.log("Send this key to the customer. They paste it into their dashboard:");
  console.log("");
  console.log(signed.key);
  console.log("");
  hr();
  process.exit(0);
}

/* ── revoke ─────────────────────────────────────────────────────────────── */
if (cmd === "revoke") {
  const ledger = lib.readLedger();
  const revoked = lib.readRevoked();

  const byMachine = String(argv.machine || argv.code || "").trim();
  const byId = String(argv.id || "").trim();
  const byName = String(argv.name || "").trim();

  let matches = [];
  if (byId) matches = ledger.grants.filter((g) => g.id === byId);
  else if (byMachine) matches = ledger.grants.filter((g) => g.machineId === byMachine);
  else if (byName) matches = ledger.grants.filter((g) => (g.name || "").toLowerCase() === byName.toLowerCase());
  else die("Say who to revoke with --machine <CODE>, --id <licence id> or --name \"Customer\".");

  if (!matches.length) {
    console.log("No matching grant in your ledger. Known entries:");
    ledger.grants.forEach((g) => console.log(`  ${g.name}  ${g.machineId}  ${g.id}`));
    process.exit(1);
  }

  let added = 0;
  for (const g of matches) {
    if (!revoked.revoked.includes(g.id)) { revoked.revoked.push(g.id); added++; }
    g.status = "revoked";
    g.revokedAt = new Date().toISOString();
  }
  lib.writeLedger(ledger);
  lib.writeRevoked(revoked);

  const push = wantsPush(argv);
  const p = lib.publish(`licence: revoke ${matches.map((g) => g.name || g.id).join(", ")}`, { push });

  hr();
  console.log(`REVOKED ${matches.length} licence(s):`);
  matches.forEach((g) => console.log(`  ${g.name}  (${g.machineId})`));
  console.log(`  added to public list: ${added} new`);
  if (p.pushed) {
    console.log("  published: pushed to main - engines stop on their next check.");
    console.log("  (raw file caching can lag a few minutes)");
  } else {
    console.log("  NOT PUBLISHED: " + p.reason);
    console.log("  Push licenses/revoked.json now or engines will not see the revocation.");
  }
  hr();
  process.exit(p.pushed || !push ? 0 : 2);
}

/* ── list ───────────────────────────────────────────────────────────────── */
if (cmd === "list") {
  const ledger = lib.readLedger();
  const revoked = new Set(lib.readRevoked().revoked);
  if (!ledger.grants.length) { console.log("No licences granted yet."); process.exit(0); }
  hr();
  console.log("YOUR LICENCES  (private ledger - " + lib.LEDGER_PATH + ")");
  hr();
  console.log("STATUS".padEnd(10) + "UNTIL".padEnd(13) + "NAME".padEnd(24) + "ACTIVATION CODE");
  for (const g of ledger.grants) {
    console.log(
      statusOf(g, revoked).padEnd(10) +
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
Licence tool - grant and revoke subscriptions with no server and no URL.

  keygen  [--embed]                                create/rotate your signing key
  grant   --machine CODE [--days N | --until DATE] [--name "Customer"]
                                                  issue a key, print it
  revoke  --machine CODE | --id ID | --name NAME  stop a key  (pushes)
  list                                            your ledger
  check   "MDL1..." [--machine CODE]              verify a key like the engine will

The activation CODE is the machineId shown on the customer's own dashboard.
Your private key and ledger are gitignored; only revoked.json is published.
`);
process.exit(0);
