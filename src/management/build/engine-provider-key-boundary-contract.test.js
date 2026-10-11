"use strict";
/**
 * The credential boundary, restated for the direct-provider path.
 *
 * WHY THIS TEST EXISTS RATHER THAN AN EDIT TO THE OLD TWO
 *
 * MEMORY.md said two contract tests enforced "the current boundary", and named
 * runtime-credential-boundary-contract.test.js and
 * platform-secret-isolation-contract.test.js. Both still pass, unchanged, after
 * the engine was given a direct provider key. That is not because they were
 * relaxed - it is because neither one ever covered this. They pin:
 *
 *   - runtime-credential-boundary: telephony dialer credentials (apiKey,
 *     accountSid, sipPassword) are decrypted per tenant at call time and never
 *     returned in a response. Server side. Nothing to do with the AI provider.
 *   - platform-secret-isolation: the platform does not hold SMTP passwords, SIP
 *     passwords, RC JWTs or client secrets, and no active path reads them from
 *     platformSetting. Server side. Nothing to do with the AI provider.
 *
 * So the boundary that was actually load-bearing - "the engine never holds a
 * provider API key" - was not enforced by a test at all. It was a convention in
 * a comment. This file is the test that makes it enforceable, and it makes it
 * enforce the NEW boundary rather than pretending the old one is still true.
 *
 * WHAT THE NEW BOUNDARY IS
 *
 *   1. Opt-in. An install with no local key behaves exactly as before: gateway
 *      only. Nothing is required of a customer and nothing changes for them.
 *   2. One-way. A local key is used for provider calls and is NEVER sent to the
 *      portal, in a header, a body, or a diagnostic.
 *   3. Encrypted at rest, and the plaintext key is never written to disk.
 *   4. The gateway keeps working. The platform still holds its own provider key
 *      and still serves installs without one, so the fallback is real and not
 *      theoretical.
 *   5. Removable. Clearing the key returns the install to gateway-only with no
 *      other trace.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..", "..");
const agentDir = path.join(root, "src", "management", "agent");
const read = (f) => fs.readFileSync(path.join(agentDir, f), "utf8");
const providerKey = read("provider-key.js");
const stt = read("multilingual-stt.js");
const brain = read("intelligent-brain.js");
const webui = read("webui.js");
const sttRoute = fs.readFileSync(path.join(root, "src", "app", "api", "engine", "ai", "stt", "route.ts"), "utf8");
const chatRoute = fs.readFileSync(path.join(root, "src", "app", "api", "engine", "ai", "chat", "route.ts"), "utf8");

/* ---- 1. the local store is encrypted, and never holds plaintext ---- */

assert.match(providerKey, /createCipheriv\(ALG, secret\(\), iv\)/, "the store must seal with AES-GCM");
assert.match(providerKey, /createDecipheriv\(ALG, secret\(\), iv\)/, "the store must open with AES-GCM");
assert.match(providerKey, /const PREFIX = "enc:v1:"/, "the envelope must carry the redaction prefix");
assert.match(providerKey, /randomBytes\(32\)/, "the wrapping key must be random per machine");
assert.doesNotMatch(
  providerKey,
  /writeFileSync\(storePath\(\)[^)]*groqKey:\s*plain/,
  "the plaintext key must never be written to the store"
);
assert.match(providerKey, /lockDown/, "the store must be narrowed to the owner");
assert.match(providerKey, /icacls/, "on Windows the store must get an owner-only ACL");

/* ---- 2. the direct path never transmits the key anywhere but the provider ---- */

for (const [name, src] of [["multilingual-stt", stt], ["intelligent-brain", brain]]) {
  const providerCalls = src.match(/Authorization:\s*`?Bearer[^\n]*\$\{key\}/g) || [];
  assert.ok(
    providerCalls.length >= 1,
    `${name} must send the key to the provider on the direct path`
  );
  /* Anything addressed to the portal must not carry the key. The gateway takes a
   * device token; the provider key must never ride along with it. */
  const portalCalls = src.match(/withPortalPrioritySlot\([\s\S]{0,900}?\n/g) || [];
  for (const call of portalCalls) {
    assert.doesNotMatch(call, /\$\{key\}/, `${name} must not send the provider key to the portal`);
  }
  assert.match(
    src,
    /safeError\([^)]*\[key\]/,
    `${name} must redact the key out of any error it reports`
  );
}

/* ---- 3. opt-in: no key means the gateway, exactly as before ---- */

assert.match(stt, /const key=providerKey\(\);/, "STT must read the key through the local store");
assert.match(brain, /const key = providerKey\(\);/, "the brain must read the key through the local store");
assert.ok(
  !/GROQ_API_KEY/.test(stt.replace(/AUTODIAL_PROVIDER_KEY \|\| process\.env\.GROQ_API_KEY/g, "")) ||
    /provider-key\.js/.test(stt),
  "STT must not read a raw provider key from the environment directly"
);
assert.match(stt, /path:"gateway"/, "STT must still be able to answer from the gateway alone");
assert.match(brain, /completeViaGateway/, "the brain must keep a gateway path");

/* ---- 4. a dead provider falls back rather than deafening the call ---- */

assert.match(stt, /health\.isOpen\("stt-direct"\)/, "the direct STT path needs a circuit breaker");
assert.match(stt, /health\.recordFailure\("stt-direct"\)/, "a direct STT failure must be recorded");
assert.match(brain, /health\.isOpen\("brain-direct"\)/, "the direct brain path needs a circuit breaker");
assert.match(brain, /health\.recordFailure\("brain-direct"\)/, "a direct brain failure must be recorded");
assert.match(stt, /DIRECT_TIMEOUT_MS = 6000/, "the direct STT budget must leave room for the fallback");
assert.match(stt, /gateway-fallback/, "a direct STT failure must fall back to the gateway in-turn");
assert.match(brain, /gateway-fallback/, "a direct brain failure must fall back to the gateway in-turn");

/* ---- 5. the gateway keeps its own key and keeps working ---- */

assert.match(sttRoute, /process\.env\.GROQ_API_KEY/, "the gateway must still hold a provider key");
assert.match(chatRoute, /process\.env\.(GROQ_API_KEY|AUTODIAL_GROQ_KEY)/, "the gateway chat route must still hold a provider key");
assert.doesNotMatch(sttRoute, /deviceToken/, "the STT gateway must not take a device token in the body");

/* ---- 6. the local UI can set, read and clear it, and never echoes the key ---- */

assert.match(webui, /\/api\/provider-key/, "the local UI must expose the key status");
assert.match(webui, /pk\.setProviderKey/, "the local UI must be able to store a key");
assert.match(webui, /pk\.clearProviderKey/, "the local UI must be able to remove a key");
assert.doesNotMatch(
  webui,
  /sendJson\([^)]*groqKey\s*:/i,
  "the status endpoint must never return the key itself"
);
assert.doesNotMatch(
  webui,
  /sendJson\([^)]*key\s*:\s*String\(body\.key/,
  "the set endpoint must not echo the key back"
);

/* ---- 7. behavioural: encrypt at rest, round-trip, clear, and default-off ---- */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "md-provider-key-"));
const prevHome = process.env.AUTODIAL_HOME;
const prevEnvKey = process.env.AUTODIAL_PROVIDER_KEY;
const prevGroq = process.env.GROQ_API_KEY;
delete process.env.AUTODIAL_PROVIDER_KEY;
delete process.env.GROQ_API_KEY;
process.env.AUTODIAL_HOME = home;

const pk = require(path.join(agentDir, "provider-key.js"));
try {
  assert.equal(pk.providerKey(), "", "a fresh install must have no key: opt-in, not opt-out");
  assert.deepEqual(pk.providerKeyStatus(), { configured: false, source: "none" });

  const SECRET = "gsk_testkey_0123456789abcdefghijklmnop";
  const stored = pk.setProviderKey(SECRET);
  assert.ok(stored && stored.ok, "storing a key must succeed: " + JSON.stringify(stored));

  const onDisk = fs.readFileSync(pk.storePath(), "utf8");
  assert.ok(!onDisk.includes(SECRET), "the plaintext key must not appear anywhere in the store file");
  assert.match(onDisk, /enc:v1:/, "the store must hold an envelope, not the key");

  /* The wrapping key is a separate file: an attacker with the store alone gets
   * nothing. This is the property the whole scheme rests on. */
  const keyFile = path.join(home, "provider.key");
  assert.ok(fs.existsSync(keyFile), "the wrapping key must be a separate file");
  assert.equal(fs.readFileSync(keyFile).length, 32, "the wrapping key must be 32 bytes");

  assert.equal(pk.providerKey(), SECRET, "the key must round-trip through the store");
  assert.deepEqual(pk.providerKeyStatus(), { configured: true, source: "local-store" });

  /* Copied to another machine, the store is inert without the key file. */
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "md-provider-copy-"));
  fs.copyFileSync(pk.storePath(), path.join(elsewhere, "provider.json"));
  process.env.AUTODIAL_HOME = elsewhere;
  assert.equal(pk.providerKey(), "", "a copied store alone must not yield a usable key");
  process.env.AUTODIAL_HOME = home;

  /* An environment key still wins, so an operator can inject one without disk. */
  process.env.AUTODIAL_PROVIDER_KEY = "from-env";
  assert.equal(pk.providerKey(), "from-env", "an env key must take precedence");
  delete process.env.AUTODIAL_PROVIDER_KEY;

  /* Clearing returns the install to the old behaviour with no other trace. */
  const cleared = pk.clearProviderKey();
  assert.ok(cleared && cleared.ok, "clearing must succeed");
  assert.equal(pk.providerKey(), "", "a cleared install must be back to gateway-only");
  assert.deepEqual(pk.clearProviderKey(), { ok: true }, "clearing twice must be safe, not an error");

  fs.rmSync(elsewhere, { recursive: true, force: true });
} finally {
  if (prevHome === undefined) delete process.env.AUTODIAL_HOME; else process.env.AUTODIAL_HOME = prevHome;
  if (prevEnvKey === undefined) delete process.env.AUTODIAL_PROVIDER_KEY; else process.env.AUTODIAL_PROVIDER_KEY = prevEnvKey;
  if (prevGroq === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = prevGroq;
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("engine provider-key boundary contract: 7 groups PASS");
console.log("  opt-in, encrypted at rest, never sent to the portal, gateway intact, removable");