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
 *                                               the engine reads. Nothing else.
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

const ROOT = path.join(__dirname, "..");
const LICENSES_DIR = path.join(ROOT, "licenses");
const PRIVATE_KEY_PATH = path.join(LICENSES_DIR, "license.private.key");
const LEDGER_PATH = path.join(LICENSES_DIR, "grants.local.json");
const REVOKED_PATH = path.join(LICENSES_DIR, "revoked.json");
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

/* Publish. Revocation only matters once the engines can read it, so the
 * default is to commit and push immediately - an unsent revocation is not a
 * revocation. Uses the repo's standing convention (push `final HEAD:main`),
 * never origin, never force. */
function publish(message, { push = true } = {}) {
  if (!push) return { pushed: false, reason: "push disabled" };
  const run = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    run(["add", "licenses/revoked.json"]);
    const staged = run(["status", "--porcelain", "--", "licenses/revoked.json"]).trim();
    if (!staged) return { pushed: false, reason: "no change to publish" };
    run(["commit", "-m", message]);
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

module.exports = {
  ROOT,
  LICENSES_DIR,
  PRIVATE_KEY_PATH,
  LEDGER_PATH,
  REVOKED_PATH,
  ENGINE_FILE,
  PREFIX,
  loadPrivateKey,
  keygen,
  signLicense,
  readLedger,
  writeLedger,
  readRevoked,
  writeRevoked,
  publish,
  addDays,
};
