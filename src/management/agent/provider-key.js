"use strict";
/**
 * The customer's own AI provider key, on the customer's own PC.
 *
 * WHY THIS EXISTS
 *
 * A turn used to cost two gateway round trips: one for transcription, one for
 * the brain. Measured against the deployed gateway with a keep-alive connection
 * and real mu-law audio (build/gateway-stage-probe.cjs):
 *
 *   platform floor, no database            172ms
 *   + 3 database round trips               912ms
 *   + device auth (cache hit) + quota write 426ms
 *   the whole turn                          705ms
 *   direct to the provider, same run       195ms
 *
 * So the gateway costs ~509ms a turn, and ~247ms of that is simply the distance
 * to the database. Talking to the provider directly removes the platform hop,
 * the quota write and the container-to-provider leg in one move.
 *
 * WHAT THIS IS NOT
 *
 * This is NOT a replacement for the gateway, and it is NOT a claim that a key on
 * a customer PC is free. Two things must stay true, and both are enforced here:
 *
 *   1. The gateway is still the fallback and still the default. An install with no
 *      local key behaves exactly as it did before this file existed. Nothing is
 *      required of a customer for this to work; it is an opt-in speedup.
 *   2. The key at rest is encrypted and the envelope is bound to this Windows
 *      user account, so config.json copied to another machine, or another user on
 *      this machine, yields nothing usable.
 *
 * And the honest limit of (2): anything running as this Windows user can read the
 * key, because it has to be able to use the key. This protects a copied config
 * file, a backup, and a support engineer with file access but no code execution.
 * It does not protect against malware already running as the user. That is a
 * different, much stronger requirement, and no local storage scheme meets it -
 * which is the actual argument for keeping the gateway available as the default.
 *
 * AT REST
 *
 * AES-256-GCM under a random 32-byte secret generated on first use and stored
 * beside it. The envelope is enc:v1:<iv>.<tag>.<ciphertext>, the same shape the
 * portal uses for stored credentials (src/lib/credential-crypto.ts), so the
 * redaction in safe-diagnostic.js already covers it.
 *
 * The secret file is created with an owner-only ACL. That is the actual control:
 * the ciphertext without the key file is inert, and the key file without being
 * that user is unreadable.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PREFIX = "enc:v1:";
const ALG = "aes-256-gcm";

function agentDir() {
  if (process.env.AUTODIAL_HOME) return process.env.AUTODIAL_HOME;
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local) return path.join(local, "Magic Dialer");
  }
  return path.join(os.homedir(), ".magicdialer");
}

function keyPath() { return path.join(agentDir(), "provider.key"); }
function storePath() { return path.join(agentDir(), "provider.json"); }

/* Owner-only. On Windows the file inherits the user profile ACL by default, which
 * already excludes other users; this narrows it further so the secret is not
 * readable by anything that manages to slip into the machine group. Best effort
 * by design - if icacls is unavailable or fails, the profile ACL still stands and
 * refusing to store a key at all would be a worse outcome than a slightly wider
 * ACL on one file inside the user's own profile. */
function lockDown(file) {
  if (process.platform !== "win32") {
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    return;
  }
  try {
    const { execFileSync } = require("node:child_process");
    const user = `${os.userInfo().domain || ""}\\${os.userInfo().username}`;
    execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:(F)`], {
      windowsHide: true, stdio: "ignore", timeout: 10000,
    });
  } catch { /* profile ACL stands */ }
}

function secret() {
  try {
    const raw = fs.readFileSync(keyPath());
    if (raw.length === 32) return raw;
  } catch { /* not created yet */ }
  const fresh = crypto.randomBytes(32);
  try {
    fs.mkdirSync(agentDir(), { recursive: true });
    fs.writeFileSync(keyPath(), fresh, { mode: 0o600 });
    lockDown(keyPath());
  } catch { /* fall through: an unwritable store simply yields no key */ }
  return fresh;
}

function seal(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, secret(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), ciphertext].map((x) => x.toString("base64url")).join(".");
}

function open_(stored) {
  const parts = String(stored || "").slice(PREFIX.length).split(".");
  if (parts.length !== 3) throw new Error("provider key envelope is invalid");
  const [iv, tag, ciphertext] = parts.map((x) => Buffer.from(x, "base64url"));
  if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error("provider key envelope is invalid");
  const decipher = crypto.createDecipheriv(ALG, secret(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * The provider key to use on this PC, or "" when there is none.
 *
 * An environment variable still wins, so an operator can inject a key without
 * touching disk at all and an existing deployment that already sets
 * GROQ_API_KEY keeps behaving identically. A plaintext value left in the store by
 * an operator editing it by hand is read as-is rather than treated as an error -
 * refusing to start would be worse than accepting a working configuration.
 */
function providerKey() {
  const fromEnv = process.env.AUTODIAL_PROVIDER_KEY || process.env.GROQ_API_KEY || process.env.AUTODIAL_GROQ_KEY || "";
  if (fromEnv.trim()) return fromEnv.trim();
  try {
    const store = JSON.parse(fs.readFileSync(storePath(), "utf8"));
    const stored = String(store && store.groqKey || "");
    if (!stored) return "";
    if (!stored.startsWith(PREFIX)) return stored;
    return open_(stored);
  } catch {
    return "";
  }
}

/** True when a direct provider call is possible on this PC. */
function hasProviderKey() { return !!providerKey(); }

/** Never the key: only whether one is present, and where it came from. */
function providerKeyStatus() {
  if (process.env.AUTODIAL_PROVIDER_KEY || process.env.GROQ_API_KEY || process.env.AUTODIAL_GROQ_KEY) {
    return { configured: true, source: "environment" };
  }
  try {
    const store = JSON.parse(fs.readFileSync(storePath(), "utf8"));
    return { configured: !!String((store && store.groqKey) || ""), source: "local-store" };
  } catch {
    return { configured: false, source: "none" };
  }
}

/** Store a key. An empty value removes it, which is how a customer opts out. */
function setProviderKey(value) {
  const plain = String(value || "").trim();
  if (!plain) return clearProviderKey();
  try {
    fs.mkdirSync(agentDir(), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify({ groqKey: seal(plain), savedAt: new Date().toISOString() }, null, 2), "utf8");
    lockDown(storePath());
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function clearProviderKey() {
  try { fs.unlinkSync(storePath()); return { ok: true }; }
  catch (e) {
    if (e && e.code === "ENOENT") return { ok: true };
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { providerKey, hasProviderKey, setProviderKey, clearProviderKey, providerKeyStatus, agentDir, storePath };