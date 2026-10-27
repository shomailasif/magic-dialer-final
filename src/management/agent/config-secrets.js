"use strict";
/**
 * Secrets in the customer's config.json, encrypted at rest.
 *
 * WHAT WAS WRONG
 *
 * config.json held the SMTP password, the device token, the legacy bearer token
 * and the SIP password as plaintext, and it is rewritten after every call to
 * store statistics. A copied profile, a backup, a support bundle or a cloud
 * sync folder therefore contained live credentials, plus a plaintext token file
 * beside it. The provider key already had an encrypted envelope; the other
 * secrets did not.
 *
 * THE SHAPE
 *
 * Each secret is sealed with the same AES-256-GCM envelope as the provider key
 * (provider-key.js): enc:v1:<iv>.<tag>.<ciphertext>, under the per-user key in
 * the user's own profile. The envelope is inert on another machine or another
 * Windows account, which is the property a plaintext config did not have.
 *
 * COMPATIBILITY
 *
 * This is transparent to every caller: loadConfig() returns plaintext, so the
 * agent, the softphone, SMTP and the web UI see exactly what they saw before.
 * A config written by an older build is still read - a plaintext secret is
 * accepted and re-sealed on the next save, and migrate() seals it immediately
 * at startup. A value that cannot be opened (the config was copied to another
 * PC, or the key file is gone) is reported as unreadable and left sealed on
 * disk rather than being silently erased, and the affected secret reads as ""
 * so the caller fails closed instead of trying an envelope as a password.
 */

const fs = require("node:fs");
const path = require("node:path");
const { seal, open: openSealed, isSealed, PREFIX } = require("./provider-key");

/* Every secret known to live in config.json. Written as paths so a nested field
 * costs one entry and a typo cannot silently target the wrong object. */
const SECRET_FIELDS = Object.freeze([
  ["token"],
  ["deviceToken"],
  ["smtp", "pass"],
  ["voip", "sipPassword"],
  ["voip", "appClientSecret"],
  ["voip", "appJwt"],
]);

function parentOf(root, keys) {
  let node = root;
  for (const key of keys) {
    if (!node || typeof node !== "object") return null;
    node = node[key];
  }
  return node && typeof node === "object" ? node : null;
}

/**
 * A deep copy of `config` with every secret sealed.
 *
 * The caller's object is never mutated: the running agent must keep working
 * with plaintext for the rest of the call, while what reaches the disk is the
 * envelope.
 */
function sealConfig(config) {
  if (!config || typeof config !== "object") return config;
  const out = JSON.parse(JSON.stringify(config));
  for (const keys of SECRET_FIELDS) {
    const parent = parentOf(out, keys.slice(0, -1));
    if (!parent) continue;
    const key = keys[keys.length - 1];
    const value = parent[key];
    if (typeof value === "string" && value && !isSealed(value)) {
      parent[key] = seal(value);
    }
  }
  return out;
}

/**
 * Open an on-disk config and return `{ config, sealed, unreadable }`.
 *
 * `sealed` is true when at least one secret was still plaintext, which is what
 * tells the startup migration that this file needs rewriting. `unreadable`
 * lists the dotted paths that could not be opened; their in-memory value is ""
 * so no caller can accidentally use an envelope as a credential.
 */
function openConfig(config) {
  if (!config || typeof config !== "object") return { config, sealed: false, unreadable: [] };
  const out = JSON.parse(JSON.stringify(config));
  let sealed = false;
  const unreadable = [];
  for (const keys of SECRET_FIELDS) {
    const parent = parentOf(out, keys.slice(0, -1));
    if (!parent) continue;
    const key = keys[keys.length - 1];
    const value = parent[key];
    if (typeof value !== "string" || !value) continue;
    if (!isSealed(value)) {
      /* Plaintext from an older build: usable, and marked for re-sealing. */
      sealed = true;
      continue;
    }
    try {
      parent[key] = openSealed(value);
    } catch {
      parent[key] = "";
      unreadable.push(keys.join("."));
    }
  }
  return { config: out, sealed, unreadable };
}

function readConfigFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const opened = openConfig(raw);
  return Object.assign(opened, { raw });
}

function writeConfigFile(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(sealConfig(config), null, 2), "utf8");
}

/**
 * Seal any plaintext secret already on disk. Called once at startup.
 *
 * Returns true when the file was rewritten. Best effort: a read-only or
 * unwritable config must not stop the agent from running, because the next
 * normal save will seal it anyway. Only fields that were plaintext are
 * rewritten, and only once - a file that is already sealed is not touched.
 */
function migrateFile(file) {
  try {
    const read = readConfigFile(file);
    if (!read.sealed) return false;
    writeConfigFile(file, read.config);
    return true;
  } catch {
    return false;
  }
}

/** True when this string is an at-rest envelope, not a usable secret. */
function isEnvelope(value) {
  return isSealed(value);
}

module.exports = {
  SECRET_FIELDS,
  sealConfig,
  openConfig,
  readConfigFile,
  writeConfigFile,
  migrateFile,
  isEnvelope,
  PREFIX,
};
