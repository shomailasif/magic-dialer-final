"use strict";

/* What the dial gate promises, stated as assertions.
 *
 * The two failure modes this file exists to prevent are opposite and both
 * expensive. Blocking a customer who has paid is a live outage on their PC;
 * letting one continue after they stopped paying is the whole business. So
 * the same suite checks both directions: every state that must keep calling
 * is asserted to keep calling, and every state that must stop is asserted to
 * stop with a sentence the customer can act on.
 *
 * It signs its own licences with its own keypair. The real signing key must
 * never exist in a test runner, so license.js exposes _test.usePublicKey and
 * this suite swaps in the matching public key for the duration.
 */

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");

const lic = require("./license");
const { createLicenseGate } = require("./license-gate");

const DAY = 86400000;
const HOUR = 3600000;
const MACHINE = "machine-under-test-0001";

/* ── a keypair of our own, and a signer that matches it ─────────────────── */
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const previousKey = lic._test.usePublicKey(
  publicKey.export({ type: "spki", format: "der" }).toString("base64")
);

function sign({ machineId = MACHINE, until = null, id = null, payloadOverride = null } = {}) {
  const payload = payloadOverride || {
    v: 1,
    id: id || crypto.randomUUID(),
    machineId,
    issued: new Date().toISOString(),
    until,
  };
  const enc = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const sig = crypto.sign(null, Buffer.from(enc, "utf8"), privateKey);
  return { id: payload.id, key: `MDL1.${enc}.${sig.toString("base64")}` };
}

/* ── a gate with a controllable clock, network and disk ─────────────────── */
function harness({ store = {}, config = {}, mode = "ok", ids = [] } = {}) {
  const clock = { t: 1760000000000 };
  const st = { data: Object.assign({}, store) };
  const cfg = Object.assign({ machineId: MACHINE }, config);
  const net = { mode, ids, calls: [] };
  const gate = createLicenseGate({
    readConfig: () => cfg,
    readStore: () => st.data,
    writeStore: (next) => { st.data = next; },
    fetchImpl: async (u) => {
      net.calls.push(String(u));
      if (net.mode === "fail") throw new Error("ECONNREFUSED");
      if (net.mode === "http500") return { ok: false, status: 500, text: async () => "" };
      return { ok: true, status: 200, text: async () => JSON.stringify({ v: 1, revoked: net.ids }) };
    },
    now: () => clock.t,
    intervalMs: 0,          // never starts a timer; tests drive checkNow()
    url: "https://licence.test/revoked.json",
  });
  return {
    gate, clock, st, cfg, net,
    jump: (days) => { clock.t += days * DAY; },
    hours: (h) => { clock.t += h * HOUR; },
  };
}

const has = (s, re) => re.test(String(s || ""));

/* ══ 1. the trial: present, bounded, and impossible to reset ══════════════ */

(async () => {
  console.log("trial window");

  const h = harness();
  await h.gate.boot();
  let s = h.gate.status();
  assert.equal(s.state, "trial", "a brand new install must start in trial, not refused");
  assert.equal(s.ok, true, "trial must be allowed to call");
  assert.equal(s.status, "ONLINE", "trial must not read as a blocking badge state");
  assert.ok(has(s.line, /day\(s\) left/), "trial must say how long is left, got: " + s.line);

  /* Nobody can dial while they are in it - it is not a state that stops work. */
  assert.doesNotThrow(() => h.gate.assertAllowsCall(), "trial must place calls");
  console.log("  ok   fresh install calls immediately: " + s.line);

  h.jump(6);
  s = h.gate.status();
  assert.equal(s.state, "trial");
  assert.equal(s.daysLeft, 1, "six of seven days spent leaves exactly one");
  assert.ok(s.daysLeft >= 1, "the trial must never display as zero days while still running");
  console.log("  ok   day six still in trial (" + s.daysLeft + " day left)");

  h.jump(2);
  s = h.gate.status();
  assert.equal(s.state, "unlicensed", "day eight must be past the window");
  assert.equal(s.ok, false, "past the window calling must stop");
  assert.throws(() => h.gate.assertAllowsCall(), (e) => has(e.message, /licence key/i),
    "a blocked PC must be told how to unblock it");
  assert.equal(h.gate.status().status, "UNLICENSED", "past the window the badge must say not activated");
  console.log("  ok   day eight blocked: " + h.gate.status().line);

  /* Clearing the key, or anything else that rewrites the file, must not hand
   * back a fresh week - otherwise the trial is a button, not a window. */
  const reset = harness();
  await reset.gate.boot();
  reset.jump(6);
  reset.gate.clear();
  const after = reset.gate.status();
  assert.equal(after.state, "trial", "clearing an unlicensed key keeps the same trial");
  assert.ok(after.daysLeft <= 2, "clearing must not restore the full window, got " + after.daysLeft + " days");
  console.log("  ok   removing a key does not restart the trial");

  /* ── 2. activation ─────────────────────────────────────────────────────── */
  console.log("\nactivation");

  const a = harness();
  await a.gate.boot();
  a.jump(9);                                     // past the trial
  assert.equal(a.gate.status().state, "unlicensed");

  const mine = sign();
  const r = await a.gate.activate(mine.key);
  assert.equal(r.ok, true, "a genuine key for this PC must activate: " + (r.error || ""));
  assert.equal(a.gate.status().state, "active");
  assert.doesNotThrow(() => a.gate.assertAllowsCall());
  assert.equal(a.gate.status().activated, true);
  console.log("  ok   pasting a key activates a PC that had run out of trial");

  const wrong = sign({ machineId: "some-other-machine-0002" });
  const rw = await a.gate.activate(wrong.key);
  assert.equal(rw.ok, false, "a key for another PC must not activate this one");
  assert.match(rw.error, /different PC/, "the refusal must name the reason, got: " + rw.error);
  assert.equal(a.gate.status().activated, true, "a refused key must not disturb the good one");
  assert.equal(a.st.data.raw, mine.key, "the stored key must still be the one that works");
  console.log("  ok   another PC's key refused and the good one untouched");

  const tampered = mine.key.slice(0, -4) + "AAAA";
  const rt = await a.gate.activate(tampered);
  assert.equal(rt.ok, false, "a tampered key must be refused");
  assert.match(rt.error, /not genuine/, "a tampered key must say so, got: " + rt.error);
  assert.equal(a.st.data.raw, mine.key, "a tampered key must not replace the good one");
  console.log("  ok   tampered key refused as not genuine");

  const blank = await a.gate.activate("   ");
  assert.equal(blank.ok, true, "clearing through activate('') is the same as clear()");
  assert.equal(a.gate.status().activated, false, "the key must be gone");
  assert.equal(a.gate.status().state, "unlicensed", "and the PC must be back to blocked");
  console.log("  ok   removing a key puts the PC back to not activated");

  /* ── 3. the status object never leaks the key, but does hand over the code ── */
  console.log("\nwhat the dashboard is shown");

  const d = harness();
  await d.gate.boot();
  const view = d.gate.status();
  assert.equal(view.machineId, MACHINE, "the activation code is what we need from the customer");
  assert.equal(JSON.stringify(view).includes("MDL1."), false, "the stored key must never be sent to the browser");
  console.log("  ok   status gives the activation code and never the key");

  /* ── 4. revocation: stops within minutes, and does not come back on a blip ── */
  console.log("\nrevocation");

  const v = harness();
  await v.gate.boot();
  const licensed = sign();
  assert.equal((await v.gate.activate(licensed.key)).ok, true);

  v.net.ids = [licensed.id];                     // you stop paying, you push the list
  await v.gate.checkNow();
  let vs = v.gate.status();
  assert.equal(vs.ok, false, "a revoked licence must stop calling");
  assert.equal(vs.state, "suspended");
  assert.match(vs.line, /suspended/i, "the customer must be told it is a subscription stop");
  assert.throws(() => v.gate.assertAllowsCall());
  console.log("  ok   revoked key stops: " + vs.line);

  v.net.mode = "fail";                           // your list, or GitHub, goes away
  await v.gate.checkNow();
  vs = v.gate.status();
  assert.equal(vs.ok, false, "a network blip must not undo a revocation we already saw");
  assert.equal(vs.state, "suspended", "and it must still read as suspended");
  console.log("  ok   outage after revocation does not re-open it");

  /* Re-granting puts them back to work: you reinstated them, so the list no
   * longer carries their id. */
  v.net.mode = "ok";
  v.net.ids = [];
  await v.gate.checkNow();
  vs = v.gate.status();
  assert.equal(vs.ok, true, "removing an id from the list must let that PC call again");
  assert.equal(vs.state, "active");
  console.log("  ok   reinstatement from your side starts it again");

  const other = harness();
  await other.gate.boot();
  const otherKey = sign();
  assert.equal((await other.gate.activate(otherKey.key)).ok, true);
  other.net.ids = ["someone-elses-licence-id"];
  await other.gate.checkNow();
  assert.equal(other.gate.status().ok, true, "someone else's revocation must not stop this PC");
  console.log("  ok   another customer's revocation is not this customer's problem");

  /* ── 5. the grace window: a weekend of trouble, not a loophole ─────────── */
  console.log("\nrevocation list cannot be read");

  const g = harness({ mode: "fail" });
  await g.gate.boot();
  const gk = sign();
  assert.equal((await g.gate.activate(gk.key)).ok, true, "activation does not depend on the list being readable");

  g.hours(70);                                   // inside the 72 hour window
  await g.gate.checkNow();
  let gs = g.gate.status();
  assert.equal(gs.ok, true, "inside the window a paying customer must keep calling");
  assert.match(gs.line, /working for another/i, "and must be able to see it is temporary");
  assert.doesNotThrow(() => g.gate.assertAllowsCall());
  console.log("  ok   70 hours with no list, still working: " + gs.line);

  g.hours(4);                                    // past 72 hours
  await g.gate.checkNow();
  gs = g.gate.status();
  assert.equal(gs.ok, false, "past the window the engine must fail closed");
  assert.equal(gs.state, "stale");
  assert.match(gs.line, /internet access/i, "past the window the fix must be named, got: " + gs.line);
  assert.throws(() => g.gate.assertAllowsCall());
  console.log("  ok   74 hours with no list, stopped: " + gs.line);

  /* Blocking the raw file for good is the obvious bypass, and it is exactly
   * what this window closes. */
  const blocked = harness({ mode: "http500" });
  await blocked.gate.boot();
  assert.equal((await blocked.gate.activate(sign().key)).ok, true);
  blocked.jump(10);
  await blocked.gate.checkNow();
  assert.equal(blocked.gate.status().ok, false, "permanently blocking the list must not be a permanent bypass");
  console.log("  ok   blocking the URL forever buys three days, no more");

  /* ── 8. the fetch: a revocation that cannot arrive is not a revocation ──── */
  console.log("\nreading the list");

  let seen = null;
  const got = await lic.fetchRevoked("https://licence.test/revoked.json", {
    fetchImpl: async (u, o) => {
      seen = { url: String(u), opts: o };
      return { ok: true, status: 200, text: async () => JSON.stringify({ v: 1, updated: "now", revoked: ["a", "b"] }) };
    },
    timeoutMs: 1000,
  });
  assert.equal(got.ok, true, "a well-formed list must be read");
  assert.equal(got.revoked.has("a"), true, "the wrapped {revoked:[...]} shape must be read");
  assert.match(seen.url, /\?_=\d+$/, "the request must be cache-busted or a CDN copy outranks your push: " + seen.url);
  assert.equal(seen.opts.headers["cache-control"], "no-cache", "the request must refuse a cached copy");

  const bare = await lic.fetchRevoked("https://licence.test/revoked.json", {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(["only-an-id"]) }),
  });
  assert.equal(bare.revoked.has("only-an-id"), true, "a bare array must be accepted too");

  const httpErr = await lic.fetchRevoked("https://licence.test/revoked.json", {
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => "" }),
  });
  assert.equal(httpErr.ok, false, "a 500 must be a failure");
  assert.match(httpErr.error, /HTTP 500/);

  const garbage = await lic.fetchRevoked("https://licence.test/revoked.json", {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<html>not json</html>" }),
  });
  assert.equal(garbage.ok, false, "an unreadable body must never be read as an empty list - that would un-revoke everyone");
  console.log("  ok   cache-busted, no-cache, and a bad body is never treated as an empty list");

  /* ── 9. the key's home ─────────────────────────────────────────────────── */
  console.log("\nthe key's home");

  const c = harness();
  await c.gate.boot();
  const keepKey = sign();
  assert.equal((await c.gate.activate(keepKey.key)).ok, true);
  /* The agent rewrites config.json after every call to store stats. The key
   * does not live there, so that rewrite must not touch it. */
  Object.keys(c.cfg).forEach((k) => delete c.cfg[k]);
  c.cfg.machineId = MACHINE;
  assert.equal(c.gate.status().state, "active", "rewriting config must not lose the licence");
  assert.equal(c.st.data.raw, keepKey.key, "the key must still be in its own file");
  assert.ok(c.st.data.firstSeenAt, "the trial clock must survive too");
  console.log("  ok   config.json is rewritten constantly; licence.json is untouched");

  /* ── 7. the engine actually uses the gate on every dial path ───────────── */
  console.log("\nthe engine wires it up");

  const agentSrc = fs.readFileSync(path.join(__dirname, "agent.js"), "utf8");
  const dialSites = (agentSrc.match(/licenseGate\.assertAllowsCall\(\)/g) || []).length;
  assert.ok(dialSites >= 3, "every dial path must be gated, found " + dialSites);
  assert.match(agentSrc, /createLicenseGate\(\{/, "the engine must construct the gate");
  console.log("  ok   " + dialSites + " dial paths check the licence first");

  const webuiSrc = fs.readFileSync(path.join(__dirname, "webui.js"), "utf8");
  assert.match(webuiSrc, /"\/api\/license"/, "the dashboard must expose activation");
  assert.match(webuiSrc, /if\(p\.status==="SUSPENDED"\)/, "the badge must know Suspended");
  assert.match(webuiSrc, /if\(p\.status==="UNLICENSED"\)/, "the badge must know Not activated");
  console.log("  ok   dashboard can activate and can show both new states");

  lic._test.usePublicKey(previousKey);
  console.log("\nALL PASS");
})().catch((e) => {
  lic._test.usePublicKey(previousKey);
  console.error("\nFAIL: " + (e && e.message));
  console.error((e && e.stack) || "");
  process.exit(1);
});
