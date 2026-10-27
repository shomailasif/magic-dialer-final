"use strict";

/* Vendor-side licence tooling. Everything that can CREATE a licence lives
 * here, which is why it sits in scripts/ and never in the agent: the engine
 * bundle must contain verification and nothing else, or a customer could
 * extract a copy of it and issue themselves a key.
 *
 * Files this manages, and who can see them:
 *
 *   licenses/license.private.key   YOURS ONLY  - gitignored. Signs licences.
 *                                               Never committed, never bundled.
 *   licenses/grants.local.json     YOURS ONLY  - gitignored ledger of who holds
 *                                               which key, so a hash in the
 *                                               public list maps back to a
 *                                               customer for you alone.
 *   licenses/revoked.json          PUBLIC     - committed. Opaque licence ids
 *                                               that were CANCELLED.
 *   licenses/suspended.json        PUBLIC     - committed. Opaque licence ids
 *                                               held for non-payment; removing
 *                                               one id reinstates that PC.
 *
 * Rotation: `node scripts/license-grant.cjs keygen --embed` makes a new keypair,
 * writes the private key locally and substitutes the public key into
 * src/management/agent/license.js. Licences signed with the old key stop
 * verifying from that point, so rotate only when you intend to reissue.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("path");
const { execFileSync } = require("child_process");

/* Where the private material lives. The default is the repo this file is in.
 * MDL_LICENSE_ROOT exists so the test suite can run the real signing and list
 * code against a throwaway directory instead of your ledger and key. */
const ROOT = process.env.MDL_LICENSE_ROOT
  ? path.resolve(process.env.MDL_LICENSE_ROOT)
  : path.join(__dirname, "..");
const LICENSES_DIR = path.join(ROOT, "licenses");
const PRIVATE_KEY_PATH = path.join(LICENSES_DIR, "license.private.key");
const LEDGER_PATH = path.join(LICENSES_DIR, "grants.local.json");
const REVOKED_PATH = path.join(LICENSES_DIR, "revoked.json");
const SUSPENDED_PATH = path.join(LICENSES_DIR, "suspended.json");
const ENGINE_FILE = path.join(ROOT, "src", "management", "agent", "license.js");

const PREFIX = "MDL1";

function ensureDir() {
  fs.mkdirSync(LICENSES_DIR, { recursive: true });
}

function exportPublicBase64(publicKey) {
  return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

function exportPrivateBase64(privateKey) {
  return privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
}

function importPrivate(b64) {
  return crypto.createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });
}

function loadPrivateKey() {
  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    throw new Error(
      `No signing key at ${PRIVATE_KEY_PATH}.\n` +
      "Run:  node scripts/license-grant.cjs keygen --embed"
    );
  }
  const b64 = fs.readFileSync(PRIVATE_KEY_PATH, "utf8").replace(/\s+/g, "");
  const priv = importPrivate(b64);
  return { priv, publicB64: exportPublicBase64(crypto.createPublicKey(priv)) };
}

function keygen({ embed = false } = {}) {
  ensureDir();
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicB64 = exportPublicBase64(publicKey);
  const privateB64 = exportPrivateBase64(privateKey);

  fs.writeFileSync(PRIVATE_KEY_PATH, privateB64 + "\n", { mode: 0o600 });

  let embedded = false;
  if (embed) {
    const src = fs.readFileSync(ENGINE_FILE, "utf8");
    const replaced = src.replace(
      /let vendorPublicKeyB64 = "[^"]*";/,
      `let vendorPublicKeyB64 = "${publicB64}";`
    );
    if (replaced === src && !src.includes(publicB64)) {
      throw new Error("could not find the vendor public key declaration in license.js; not embedded");
    }
    fs.writeFileSync(ENGINE_FILE, replaced, "utf8");
    embedded = true;
  }

  if (!fs.existsSync(REVOKED_PATH)) {
    fs.writeFileSync(REVOKED_PATH, JSON.stringify({ v: 1, updated: new Date().toISOString(), revoked: [] }, null, 2) + "\n", "utf8");
  }

  return { publicB64, privatePath: PRIVATE_KEY_PATH, embedded };
}

/* A licence is a payload plus an Ed25519 signature over the encoded payload.
 * Signing the encoded segment rather than the parsed object means both sides
 * sign and verify the exact same bytes - no JSON key-ordering or whitespace
 * rule that could quietly make every key invalid after a refactor. */
function signLicense({ machineId, until = null, id = null }) {
  const { priv } = loadPrivateKey();
  const payload = {
    v: 1,
    id: id || crypto.randomUUID(),
    machineId: String(machineId),
    issued: new Date().toISOString(),
    until: until || null,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const sig = crypto.sign(null, Buffer.from(encoded, "utf8"), priv);
  return {
    payload,
    key: `${PREFIX}.${encoded}.${sig.toString("base64")}`,
  };
}

function readLedger() {
  if (!fs.existsSync(LEDGER_PATH)) return { grants: [] };
  try {
    const data = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
    return Array.isArray(data.grants) ? data : { grants: [] };
  } catch {
    return { grants: [] };
  }
}

function writeLedger(data) {
  ensureDir();
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function readRevoked() {
  if (!fs.existsSync(REVOKED_PATH)) return { v: 1, updated: null, revoked: [] };
  try {
    const data = JSON.parse(fs.readFileSync(REVOKED_PATH, "utf8"));
    return { v: data.v || 1, updated: data.updated || null, revoked: Array.isArray(data.revoked) ? data.revoked : [] };
  } catch {
    return { v: 1, updated: null, revoked: [] };
  }
}

function writeRevoked(data) {
  ensureDir();
  const out = { v: 1, updated: new Date().toISOString(), revoked: data.revoked };
  fs.writeFileSync(REVOKED_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
  return out;
}

/* Temporary hold, for a customer who is late paying but whose copy you intend
 * to switch back on. Kept separate from revoked.json so "not paid this week"
 * never looks identical to "gone for good": reinstating is deleting one id
 * from this file, while cancelling is a different file and a different state
 * on the customer's screen. */
function readSuspended() {
  if (!fs.existsSync(SUSPENDED_PATH)) return { v: 1, updated: null, suspended: [] };
  try {
    const data = JSON.parse(fs.readFileSync(SUSPENDED_PATH, "utf8"));
    return { v: data.v || 1, updated: data.updated || null, suspended: Array.isArray(data.suspended) ? data.suspended : [] };
  } catch {
    return { v: 1, updated: null, suspended: [] };
  }
}

function writeSuspended(data) {
  ensureDir();
  const out = { v: 1, updated: new Date().toISOString(), suspended: data.suspended };
  fs.writeFileSync(SUSPENDED_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
  return out;
}

/* Publish. Revocation only matters once the engines can read it, so the
 * default is to commit and push immediately - an unsent revocation is not a
 * revocation. Both public lists go together: a suspension and a cancellation
 * are two answers to the same question and must never disagree after a push.
 * Uses the repo's standing convention (push `final HEAD:main`), never origin,
 * never force. */
function publish(message, { push = true } = {}) {
  if (!push) return { pushed: false, reason: "push disabled" };
  const run = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const paths = ["licenses/revoked.json", "licenses/suspended.json"];
  try {
    if (!fs.existsSync(SUSPENDED_PATH)) writeSuspended(readSuspended());
    run(["add", ...paths]);
    const staged = run(["status", "--porcelain", "--", ...paths]).trim();
    if (!staged) return { pushed: false, reason: "no change to publish" };
    /* Commit ONLY these two files. Without the pathspec a `git commit` takes
     * every staged file with it, so an unrelated change sitting in the index
     * would be published under the message "licence: suspend ...". */
    run(["commit", "-m", message, "--", ...paths]);
    run(["push", "final", "HEAD:main"]);
    return { pushed: true };
  } catch (e) {
    const out = String((e && e.stdout) || "") + String((e && e.stderr) || "");
    return { pushed: false, reason: out.slice(0, 300) || (e && e.message) || "git failed" };
  }
}

function addDays(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
}

/* ── the four things an admin console is allowed to do ──────────────────────
 *
 * These are here, not in the HTTP layer, so they can be tested without a
 * browser and so every caller - CLI, console, a future script - goes through
 * the same signing and the same two public lists. All of them are no-ops for a
 * customer's PC: they only write to this machine's private files and, when
 * asked, push the two public id lists.
 */

function resolveUntil({ days, until } = {}) {
  if (until) {
    const d = Date.parse(String(until));
    if (!Number.isFinite(d)) throw new Error("expiry must be a date such as 2026-12-31");
    return new Date(d).toISOString();
  }
  if (days === undefined || days === null || days === "") return null;
  const out = addDays(days);
  if (!out) throw new Error("days must be a number greater than zero");
  return out;
}

function findGrants(ledger, { id, machineId, name } = {}) {
  const key = String(id || "").trim();
  const machine = String(machineId || "").trim();
  const who = String(name || "").trim().toLowerCase();
  if (key) return ledger.grants.filter((g) => g.id === key);
  if (machine) return ledger.grants.filter((g) => g.machineId === machine);
  if (who) return ledger.grants.filter((g) => String(g.name || "").toLowerCase() === who);
  return [];
}

/* One word per customer for the list the admin reads. Kept deliberately
 * different for "paused until they pay" and "gone": conflating them is how a
 * late payer gets treated like a lost account. */
function grantState(grant, revoked, suspended, now = Date.now()) {
  const id = String(grant.id);
  if (grant.cancelledAt || revoked.has(id)) return "cancelled";
  if (grant.suspendedAt || suspended.has(id)) return "suspended";
  if (grant.until && now > Date.parse(grant.until)) return "expired";
  return "active";
}

function listGrants({ now = Date.now() } = {}) {
  const ledger = readLedger();
  const revoked = new Set(readRevoked().revoked);
  const suspended = new Set(readSuspended().suspended);
  return ledger.grants.map((g) => Object.assign({}, g, { state: grantState(g, revoked, suspended, now) }));
}

function createGrant({ name, machineId, plan = "standard", days, until } = {}) {
  const machine = String(machineId || "").trim();
  if (!machine) throw new Error("an activation code (machine id) is required");
  const expires = resolveUntil({ days, until });
  const signed = signLicense({ machineId: machine, until: expires });
  const ledger = readLedger();
  const grant = {
    id: signed.payload.id,
    machineId: machine,
    name: String(name || "").trim() || "(unnamed)",
    plan: String(plan || "standard").trim() || "standard",
    grantedAt: new Date().toISOString(),
    renewedAt: null,
    until: expires,
    status: "active",
    suspendedAt: null,
    cancelledAt: null,
    revokeReason: null,
  };
  ledger.grants.push(grant);
  writeLedger(ledger);
  return { key: signed.key, payload: signed.payload, grant };
}

function requireGrant(ledger, query) {
  const matches = findGrants(ledger, query);
  if (!matches.length) throw new Error("no matching account in the ledger");
  if (matches.length > 1) throw new Error("that matches more than one account - use its licence id");
  return matches[0];
}

function suspendGrant({ id, machineId, name, reason = "payment not received", push = true } = {}) {
  const ledger = readLedger();
  const revoked = readRevoked();
  const suspended = readSuspended();
  const grant = requireGrant(ledger, { id, machineId, name });
  if (revoked.revoked.includes(grant.id)) throw new Error("that account is cancelled; suspension would be a downgrade");
  if (!suspended.suspended.includes(grant.id)) suspended.suspended.push(grant.id);
  grant.status = "suspended";
  grant.suspendedAt = new Date().toISOString();
  grant.suspendReason = String(reason || "payment not received");
  writeLedger(ledger);
  writeSuspended(suspended);
  return { grant, publication: publish(`licence: suspend ${grant.name}`, { push }) };
}

function reinstateGrant({ id, machineId, name, push = true } = {}) {
  const ledger = readLedger();
  const suspended = readSuspended();
  const grant = requireGrant(ledger, { id, machineId, name });
  if (grant.cancelledAt) throw new Error("that account is cancelled; reinstatement is not available");
  const before = suspended.suspended.length;
  suspended.suspended = suspended.suspended.filter((x) => x !== grant.id);
  grant.status = "active";
  grant.suspendedAt = null;
  grant.suspendReason = null;
  writeLedger(ledger);
  const changed = suspended.suspended.length !== before;
  if (changed) writeSuspended(suspended);
  return { grant, changed, publication: changed ? publish(`licence: reinstate ${grant.name}`, { push }) : { pushed: false, reason: "not suspended" } };
}

function cancelGrant({ id, machineId, name, reason = "subscription cancelled", push = true } = {}) {
  const ledger = readLedger();
  const revoked = readRevoked();
  const suspended = readSuspended();
  const grant = requireGrant(ledger, { id, machineId, name });
  if (!revoked.revoked.includes(grant.id)) revoked.revoked.push(grant.id);
  const wasSuspended = suspended.suspended.includes(grant.id);
  suspended.suspended = suspended.suspended.filter((x) => x !== grant.id);
  grant.status = "cancelled";
  grant.cancelledAt = grant.cancelledAt || new Date().toISOString();
  grant.revokeReason = String(reason || "subscription cancelled");
  writeLedger(ledger);
  writeRevoked(revoked);
  if (wasSuspended) writeSuspended(suspended);
  return { grant, publication: publish(`licence: cancel ${grant.name}`, { push }) };
}

/* Renew keeps the SAME licence id on purpose. A suspension is recorded against
 * that id, so renewing a suspended account must not quietly lift the hold: the
 * customer pays, then payment is recorded, then the hold is cleared by an
 * explicit reinstate. A new id would make the old stop point at a key nobody
 * uses and hand out a working key before the money arrived. */
function renewGrant({ id, days, until, push = true } = {}) {
  const ledger = readLedger();
  const revoked = readRevoked();
  const suspended = readSuspended();
  const grant = requireGrant(ledger, { id });
  if (revoked.revoked.includes(grant.id) || grant.cancelledAt) {
    throw new Error("that account is cancelled; it cannot be renewed");
  }
  const expires = resolveUntil({ days, until });
  if (!expires) throw new Error("a renewal needs a number of days or an expiry date");
  const signed = signLicense({ machineId: grant.machineId, until: expires, id: grant.id });
  grant.until = expires;
  grant.renewedAt = new Date().toISOString();
  grant.status = suspended.suspended.includes(grant.id) ? "suspended" : "active";
  writeLedger(ledger);
  return { key: signed.key, payload: signed.payload, grant, publication: { pushed: false, reason: "nothing public changed" } };
}

module.exports = {
  ROOT,
  LICENSES_DIR,
  PRIVATE_KEY_PATH,
  LEDGER_PATH,
  REVOKED_PATH,
  SUSPENDED_PATH,
  ENGINE_FILE,
  PREFIX,
  loadPrivateKey,
  keygen,
  signLicense,
  readLedger,
  writeLedger,
  readRevoked,
  writeRevoked,
  readSuspended,
  writeSuspended,
  publish,
  addDays,
  resolveUntil,
  findGrants,
  grantState,
  listGrants,
  createGrant,
  suspendGrant,
  reinstateGrant,
  cancelGrant,
  renewGrant,
};
