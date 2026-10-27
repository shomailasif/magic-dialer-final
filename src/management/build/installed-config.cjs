"use strict";
/* Read the installed agent's config with its encrypted secrets opened.
 *
 * config.json no longer holds the SIP password, SMTP password, device token or
 * bearer token in plaintext: they are sealed with the per-user envelope in
 * agent/provider-key.js (see agent/config-secrets.js). A diagnostic that parses
 * the file directly would now read an opaque enc:v1:... string and either try
 * it as a credential or silently see no token at all.
 *
 * Every local probe goes through this file so the probe sees exactly what the
 * agent sees, on the same machine, without duplicating the format.
 */
const path = require("node:path");
const os = require("node:os");
const { readConfigFile } = require("../agent/config-secrets");

function installedConfigPath() {
  const base = process.env.AUTODIAL_HOME || path.join(os.homedir(), ".magicdialer");
  return path.join(base, "config.json");
}

/** The config object, secrets decrypted. {} when there is no readable config. */
function readInstalledConfig() {
  try {
    return readConfigFile(installedConfigPath()).config || {};
  } catch {
    return {};
  }
}

module.exports = { installedConfigPath, readInstalledConfig };
