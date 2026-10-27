"use strict";
/**
 * Suspension is not cancellation, and the admin console must exist only on the
 * vendor's PC.
 *
 * The product is sold by subscription, so two different things can happen to a
 * customer: they are late paying (you want them back the moment they pay), or
 * the account is gone (you do not). Collapsing those into one list is how a
 * late payer gets a message that sounds permanent, or a cancelled account gets
 * switched back on by a routine re-check.
 *
 * This suite runs the real vendor code against a throwaway directory - real
 * Ed25519 keys, real ledger, real public lists - so it proves the whole chain:
 * create -> activate -> suspend -> outage -> reinstate -> cancel, plus the
 * console's two gates (no private key = no console, no token = no request).
 */
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "md-admin-"));
process.env.MDL_LICENSE_ROOT = tmp;

const lib = require("../../../scripts/license-lib.cjs");
const lic = require("./license");
const { createLicenseGate } = require("./license-gate");

const MACHINE = "admin-test-machine-0001";
const DAY = 86400000;

/* A keypair of our own in the throwaway root, and the engine pointed at its
 * public half. The vendor's real key is never in a test runner. */
lib.keygen({ embed: false });
lib.writeRevoked({ revoked: [] });
lib.writeSuspended({ suspended: [] });
const previousKey = lic._test.usePublicKey(lib.loadPrivateKey().publicB64);

function gate({ cancelled = [], suspended = [], mode = "ok" } = {}) {
  const clock = { t: Date.now() };
  const st = { data: {} };
  const net = { mode, cancelled, suspended, calls: [] };
  const g = createLicenseGate({
    readConfig: () => ({ machineId: MACHINE }),
    readStore: () => st.data,
    writeStore: (next) => { st.data = next; },
    fetchImpl: async (u) => {
      const url = String(u);
      net.calls.push(url);
      if (net.mode === "fail") throw new Error("ECONNREFUSED");
      const held = /suspended/.test(url);
      if (net.mode === "half" && held) return { ok: false, status: 500, text: async () => "" };
      const body = held ? { v: 1, suspended: net.suspended } : { v: 1, revoked: net.cancelled };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
    now: () => clock.t,
    intervalMs: 0,
    url: "https://licence.test/revoked.json",
    suspensionUrl: "https://licence.test/suspended.json",
  });
  return { g, clock, st, net };
}

(async () => {
  /* ── 1. create: one account, one signed key, one ledger row ─────────────── */
  console.log("create");
  const made = lib.createGrant({ name: "Test Haulage", machineId: MACHINE, plan: "pro", days: 30 });
  assert.match(made.key, /^MDL1\./, "create must return a usable key");
  assert.equal(made.payload.machineId, MACHINE);
  assert.ok(Date.parse(made.payload.until) > Date.now() + 29 * DAY, "30 days must mean 30 days");
  const listed = lib.listGrants();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].state, "active");
  assert.equal(listed[0].plan, "pro", "the plan must survive into the ledger");
  assert.throws(() => lib.createGrant({ name: "no code" }), /activation code/i, "a licence without a machine id is not a licence");
  console.log("  ok   created " + made.payload.id + " for " + MACHINE);

  /* ── 2. the engine accepts it before any list holds it ─────────────────── */
  console.log("\nactivate");
  const a = gate();
  assert.equal((await a.g.activate(made.key)).ok, true);
  assert.equal(a.g.status().state, "active");
  assert.ok(a.net.calls.filter((u) => /revoked/.test(u)).length >= 1, "the engine must read the cancellation list");
  assert.ok(a.net.calls.filter((u) => /suspended/.test(u)).length >= 1, "the engine must read the suspension list too");
  console.log("  ok   active, and both public lists are checked");

  /* ── 3. suspend: reversible, clearly about money ────────────────────────── */
  console.log("\nsuspend for non-payment");
  const paused = lib.suspendGrant({ id: made.payload.id, reason: "payment not received", push: false });
  assert.equal(paused.publication.pushed, false);
  assert.ok(lib.readSuspended().suspended.includes(made.payload.id), "suspension must be in the public suspension list");
  assert.ok(!lib.readRevoked().revoked.includes(made.payload.id), "a suspension must not be written as a cancellation");
  assert.equal(lib.listGrants()[0].state, "suspended");

  a.net.suspended = [made.payload.id];
  await a.g.checkNow();
  let s = a.g.status();
  assert.equal(s.ok, false, "a suspended PC must stop calling");
  assert.equal(s.state, "suspended");
  assert.equal(s.status, "SUSPENDED");
  assert.match(s.line, /payment/i, "the customer must be told it is about payment, got: " + s.line);
  assert.throws(() => a.g.assertAllowsCall(), (e) => e.code === "LICENSE_SUSPENDED");
  console.log("  ok   stopped with a payment message: " + s.line);

  /* An outage must not lift a hold we already saw. */
  a.net.mode = "fail";
  await a.g.checkNow();
  s = a.g.status();
  assert.equal(s.state, "suspended", "losing the list must not re-open a suspension");
  assert.equal(s.ok, false);
  console.log("  ok   an unreadable list does not re-open it");

  /* One list readable and one not is still not "verified". */
  const half = gate({ mode: "half" });
  await half.g.activate(made.key);
  const hs = half.g.status();
  assert.notEqual(hs.state, "active", "half a check must never read as active");
  assert.match(hs.line, /re-checked/i, "and it must say verification is incomplete, got: " + hs.line);
  console.log("  ok   half a check is not a clean check");

  /* ── 4. reinstate: deleting the id is the whole action ─────────────────── */
  console.log("\nreinstate");
  const back = lib.reinstateGrant({ id: made.payload.id, push: false });
  assert.ok(back.changed);
  assert.deepEqual(lib.readSuspended().suspended, [], "reinstate must remove the id");
  assert.equal(lib.listGrants()[0].state, "active");

  a.net.mode = "ok";
  a.net.suspended = [];
  await a.g.checkNow();
  s = a.g.status();
  assert.equal(s.ok, true, "removing the id must let that PC call again");
  assert.equal(s.state, "active");
  assert.doesNotThrow(() => a.g.assertAllowsCall());
  console.log("  ok   calling resumes on the next check");

  /* ── 5. cancel: permanent, and it survives an outage ───────────────────── */
  console.log("\ncancel");
  const gone = lib.cancelGrant({ id: made.payload.id, reason: "subscription cancelled", push: false });
  assert.equal(gone.grant.status, "cancelled");
  assert.ok(lib.readRevoked().revoked.includes(made.payload.id), "cancellation must be in the public revoked list");
  assert.deepEqual(lib.readSuspended().suspended, [], "cancel must not leave a suspension behind");
  assert.equal(lib.listGrants()[0].state, "cancelled");

  a.net.cancelled = [made.payload.id];
  a.net.suspended = [];
  await a.g.checkNow();
  s = a.g.status();
  assert.equal(s.ok, false);
  assert.equal(s.state, "cancelled");
  assert.equal(s.status, "CANCELLED");
  assert.match(s.line, /cancelled/i, "a cancelled account must not be described as merely suspended");
  assert.throws(() => a.g.assertAllowsCall(), (e) => e.code === "LICENSE_CANCELLED");

  a.net.mode = "fail";
  await a.g.checkNow();
  assert.equal(a.g.status().state, "cancelled", "a cancellation must outlive the list being unreadable");
  console.log("  ok   cancelled is distinct, terminal, and sticky");

  assert.throws(() => lib.renewGrant({ id: made.payload.id, days: 30, push: false }), /cancelled/i,
    "a cancelled account must not be renewed back to life by accident");

  /* ── 6. renew keeps the id, so a hold cannot be cleared by paying ──────── */
  console.log("\nrenew");
  const second = lib.createGrant({ name: "Late Payer Ltd", machineId: "admin-test-machine-0002", days: 10 });
  lib.suspendGrant({ id: second.payload.id, push: false });
  const renewed = lib.renewGrant({ id: second.payload.id, days: 60, push: false });
  assert.equal(renewed.payload.id, second.payload.id, "renew must re-sign the same id, not mint a new identity");
  assert.ok(Date.parse(renewed.payload.until) > Date.parse(second.payload.until), "renew must extend the term");
  assert.equal(renewed.grant.status, "suspended", "paying must not silently lift a suspension");
  assert.ok(lib.readSuspended().suspended.includes(second.payload.id), "the hold stays until it is explicitly cleared");
  assert.notEqual(renewed.key, second.key, "the customer needs the new key to get the new expiry");
  console.log("  ok   same id, later expiry, hold preserved");

  /* ── 7. the engine reads both lists, and a bad body is never empty ─────── */
  console.log("\nreading the suspension list");
  const got = await lic.fetchSuspended("https://licence.test/suspended.json", {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ suspended: ["x"] }) }),
  });
  assert.equal(got.ok, true);
  assert.ok(got.suspended.has("x"));
  const bad = await lic.fetchSuspended("https://licence.test/suspended.json", {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<html>no</html>" }),
  });
  assert.equal(bad.ok, false, "an unreadable body must never be treated as an empty suspension list");
  console.log("  ok   well-formed read, bad body refused");

  /* ── 8. the console refuses to exist without the private key ───────────── */
  console.log("\nadmin console gates");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "md-nokey-"));
  const refused = spawnSync(process.execPath, [path.join(__dirname, "../../../scripts/admin-server.cjs")], {
    env: Object.assign({}, process.env, { MDL_LICENSE_ROOT: empty, ADMIN_PORT: "0" }),
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(refused.status, 1, "a PC without the signing key must not start the console");
  assert.match(String(refused.stderr), /ADMIN CONSOLE NOT STARTED/, "the refusal must be explicit");
  assert.match(String(refused.stderr), /signing key/i, "and must name the missing key");
  console.log("  ok   no private key -> no console");

  /* Real server, random port, real requests. */
  const admin = require("../../../scripts/admin-server.cjs");
  const running = await admin.start({ port: 0 });
  const base = `http://127.0.0.1:${running.port}`;
  try {
    let r = await fetch(base + "/api/state");
    assert.equal(r.status, 401, "a request without the run token must be refused");

    r = await fetch(base + "/api/state", { headers: { "x-admin-token": running.token, Origin: "http://evil.example" } });
    assert.equal(r.status, 403, "a page on another origin must not drive the console even with a guessed token");

    r = await fetch(base + "/?t=" + running.token);
    assert.equal(r.status, 200);
    assert.doesNotMatch(await r.text(), /license\.private\.key/, "the page must never render the private key path to the browser");

    r = await fetch(base + "/api/state", { headers: { "x-admin-token": running.token } });
    assert.equal(r.status, 200);
    const state = await r.json();
    assert.equal(state.ok, true);
    assert.ok(state.grants.length >= 2, "the ledger must be visible to the console");

    const machine = "admin-http-machine-0003";
    r = await fetch(base + "/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-token": running.token },
      body: JSON.stringify({ action: "create", name: "HTTP Customer", machineId: machine, days: 30, publish: false }),
    });
    assert.equal(r.status, 200);
    const created = await r.json();
    assert.match(created.key, /^MDL1\./, "the console must hand back the signed key");
    const row = lib.listGrants().find((g) => g.machineId === machine);
    assert.ok(row && row.state === "active");

    r = await fetch(base + "/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-token": running.token },
      body: JSON.stringify({ action: "cancel", id: row.id, publish: false }),
    });
    assert.equal(r.status, 400, "cancel without confirmation must be refused");
    assert.match((await r.json()).error, /permanent|confirm/i);

    r = await fetch(base + "/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-token": running.token },
      body: JSON.stringify({ action: "cancel", id: row.id, confirm: true, publish: false }),
    });
    assert.equal(r.status, 200);
    assert.ok(lib.readRevoked().revoked.includes(row.id));
    console.log("  ok   token, origin, create and confirm-gated cancel all behave");
  } finally {
    await new Promise((resolve) => running.server.close(resolve));
  }

  /* ── 9. the console can never reach a customer ─────────────────────────── */
  console.log("\npackaging");
  const bundle = fs.readFileSync(path.join(__dirname, "../build/bundle.js"), "utf8");
  assert.match(bundle, /"agent",\s*"agent\.js"/, "the bundle entry must remain the agent only");
  assert.ok(!/admin-server|license-lib/.test(bundle), "the bundle must not mention vendor tooling");

  const agentSrc = fs.readFileSync(path.join(__dirname, "agent.js"), "utf8");
  assert.ok(!/admin-server|license-lib\.cjs/.test(agentSrc), "the engine must not require vendor tooling");

  const installer = fs.readFileSync(path.join(__dirname, "../build/installer.iss"), "utf8");
  assert.ok(!/admin-server|license-lib\.cjs|admin console/i.test(installer), "the installer must not ship the admin console");
  console.log("  ok   agent bundle and installer contain no admin code");

  console.log("\nadmin + suspension: PASS");
  console.log("  suspend is reversible and says payment; cancel is permanent and sticky");
  console.log("  renew keeps the id and cannot clear a hold; the console needs the key and the token");

  lic._test.usePublicKey(previousKey);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
