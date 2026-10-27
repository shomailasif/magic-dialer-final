"use strict";
/* Secrets in config.json must not be readable off the disk.
 *
 * The live config held the SIP password, the SMTP password, the device token
 * and the legacy bearer token as plaintext, and the agent rewrites that file
 * after every call. A copied profile, a backup or a sync folder therefore held
 * live credentials. This pins the envelope on disk, the transparent plaintext
 * the runtime sees, the migration of an older file, and the fail-closed
 * behaviour when the key does not match.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "autodial-secrets-"));
process.env.AUTODIAL_HOME = HOME;

const secrets = require("./config-secrets");

const PLAIN = {
  machineId: "m-1",
  companyName: "Zaz Logistics",
  token: "legacy-bearer-token-value",
  deviceToken: "device-token-value",
  smtp: { host: "smtp.example.test", user: "ops@example.test", pass: "smtp-password-value" },
  voip: { username: "101", number: "14807166685", sipPassword: "sip-password-value", appClientSecret: "app-secret-value" },
};

const RAW_SECRETS = ["legacy-bearer-token-value", "device-token-value", "smtp-password-value", "sip-password-value", "app-secret-value"];

try {
  // 1. Sealing never mutates the caller: the call in progress keeps plaintext.
  const sealedCopy = secrets.sealConfig(PLAIN);
  assert.equal(PLAIN.token, "legacy-bearer-token-value", "the live object must keep its plaintext");
  assert.equal(PLAIN.voip.sipPassword, "sip-password-value");
  assert.ok(sealedCopy.token.startsWith(secrets.PREFIX), "token must be sealed");
  assert.ok(sealedCopy.deviceToken.startsWith(secrets.PREFIX), "deviceToken must be sealed");
  assert.ok(sealedCopy.smtp.pass.startsWith(secrets.PREFIX), "smtp.pass must be sealed");
  assert.ok(sealedCopy.voip.sipPassword.startsWith(secrets.PREFIX), "sipPassword must be sealed");
  assert.ok(sealedCopy.voip.appClientSecret.startsWith(secrets.PREFIX), "appClientSecret must be sealed");
  assert.equal(sealedCopy.voip.username, "101", "non-secret fields stay readable");
  assert.equal(sealedCopy.smtp.host, "smtp.example.test");

  // 2. The envelope opens back to exactly the original values.
  const reopened = secrets.openConfig(sealedCopy);
  assert.deepEqual(reopened.unreadable, []);
  assert.equal(reopened.config.token, "legacy-bearer-token-value");
  assert.equal(reopened.config.deviceToken, "device-token-value");
  assert.equal(reopened.config.smtp.pass, "smtp-password-value");
  assert.equal(reopened.config.voip.sipPassword, "sip-password-value");
  assert.equal(reopened.config.voip.appClientSecret, "app-secret-value");

  // 3. What reaches the disk contains none of the secrets.
  const file = path.join(HOME, "config.json");
  secrets.writeConfigFile(file, PLAIN);
  const onDisk = fs.readFileSync(file, "utf8");
  for (const value of RAW_SECRETS) {
    assert.ok(!onDisk.includes(value), `plaintext secret reached config.json: ${value}`);
  }
  assert.ok(onDisk.includes(secrets.PREFIX), "the file must carry envelopes");
  assert.ok(onDisk.includes("smtp.example.test"), "ordinary settings must stay readable for support");

  // 4. The runtime reads plaintext back through the same file.
  const read = secrets.readConfigFile(file);
  assert.equal(read.sealed, false, "an already-sealed file is not marked for migration");
  assert.equal(read.config.voip.sipPassword, "sip-password-value");
  assert.equal(read.config.deviceToken, "device-token-value");

  // 5. An older plaintext config still reads, and is sealed once at startup.
  const legacyFile = path.join(HOME, "legacy.json");
  fs.writeFileSync(legacyFile, JSON.stringify(PLAIN, null, 2), "utf8");
  const legacy = secrets.readConfigFile(legacyFile);
  assert.equal(legacy.sealed, true, "plaintext secrets must be flagged for re-sealing");
  assert.equal(legacy.config.token, "legacy-bearer-token-value", "a legacy file must still work");
  assert.equal(secrets.migrateFile(legacyFile), true, "migration must rewrite the file");
  const migrated = fs.readFileSync(legacyFile, "utf8");
  assert.ok(!migrated.includes("sip-password-value"), "migration must seal the SIP password");
  assert.equal(secrets.migrateFile(legacyFile), false, "a sealed file must not be rewritten again");
  assert.equal(secrets.readConfigFile(legacyFile).config.smtp.pass, "smtp-password-value", "migration must not lose the secret");

  // 6. A config copied from another machine fails closed, and is not erased.
  const copied = secrets.sealConfig(PLAIN);
  // Flip a real ciphertext byte. Changing the last base64url character is not
  // reliable: its unused bits can encode to the same bytes (this test flaked
  // exactly that way once before).
  const corrupt = (envelope) => {
    const [iv, tag, ct] = envelope.slice(secrets.PREFIX.length).split(".");
    const bytes = Buffer.from(ct, "base64url");
    bytes[0] ^= 0xff;
    return secrets.PREFIX + [iv, tag, bytes.toString("base64url")].join(".");
  };
  for (const k of ["token", "deviceToken"]) copied[k] = corrupt(copied[k]);
  const broken = secrets.openConfig(copied);
  assert.deepEqual(broken.unreadable.sort(), ["deviceToken", "token"], "unreadable fields must be named");
  assert.equal(broken.config.token, "", "an unreadable secret must never be handed to a caller");
  assert.equal(broken.config.deviceToken, "");
  assert.ok(copied.token.startsWith(secrets.PREFIX), "the envelope stays on disk instead of being wiped");

  // 7. Empty values are left alone: nothing to protect, nothing to spend.
  const empties = secrets.sealConfig({ token: "", deviceToken: "", smtp: { pass: "" }, voip: { sipPassword: "" } });
  assert.equal(empties.token, "");
  assert.equal(empties.smtp.pass, "");
  assert.equal(empties.voip.sipPassword, "");

  // 8. The agent's own load/save path uses this layer end to end.
  const original = process.env.AUTODIAL_HOME;
  process.env.AUTODIAL_HOME = HOME;
  try {
    delete require.cache[require.resolve("./agent")];
    const agent = require("./agent");
    const cfgPath = path.join(HOME, "installed", "config.json");
    agent.saveConfig(PLAIN, cfgPath);
    const disk = fs.readFileSync(cfgPath, "utf8");
    for (const value of RAW_SECRETS) {
      assert.ok(!disk.includes(value), `agent.saveConfig wrote a plaintext secret: ${value}`);
    }
    const loaded = agent.loadConfig(cfgPath);
    assert.equal(loaded.voip.sipPassword, "sip-password-value", "agent.loadConfig must return usable plaintext");
    assert.equal(loaded.smtp.pass, "smtp-password-value");
    assert.equal(loaded.companyName, "Zaz Logistics");
  } finally {
    process.env.AUTODIAL_HOME = original;
  }

  console.log("config secrets at rest: PASS (sealed on disk, plaintext in memory, legacy migrated, copied config fails closed)");
} finally {
  fs.rmSync(HOME, { recursive: true, force: true });
}
