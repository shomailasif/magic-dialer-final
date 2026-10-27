"use strict";
/**
 * This PC is the product.
 *
 * Every account used to be enrolled through a hosted portal: a ticket, a
 * device token, a heartbeat that received its config, a lead upload and a
 * results page. That portal is gone. The engine could still place a call on a
 * PC that had been enrolled years earlier, but a fresh install was stuck: setup
 * saved, the dashboard asked for setup again, and the call button answered
 * "this PC is not enrolled and synchronized with the portal".
 *
 * This suite proves the standalone path end to end, with no portal URL, no
 * device token and no network:
 *
 *   - a business description is enough to be configured
 *   - the lead list is the one on this PC, and it dials all of it
 *   - imported numbers survive, deduplicate, and are never dialled twice
 *   - each call is stored locally, so the operator has a record
 *   - the dashboard accepts leads without a portal
 *
 * It also pins the two bugs that made the local list useless: leads with no
 * portal id were all treated as the same lead, and a PC with no portal was
 * painted OFFLINE forever.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "md-standalone-"));
process.env.AUTODIAL_HOME = home;

const localDb = require("./local-db");
const { runQueue, parseLeadText, leadKey } = require("./lead-queue");
const { startWebUi } = require("./webui");

const digits = (p) => String(p || "").replace(/\D/g, "");

(async () => {
  /* ── 1. pasted numbers become leads ─────────────────────────────────────── */
  console.log("import");
  const parsed = parseLeadText([
    "Zaz Dispatch, +1 555 123 4567",
    "+15551234567",                       // duplicate, different spelling
    "  555 987 6543  ",
    "# a comment",
    "not a phone",
    "Acme Freight; (555) 222-3333",
  ].join("\n"));
  assert.equal(parsed.length, 3, "three real numbers, one duplicate, comments and junk dropped");
  assert.equal(digits(parsed[0].phone), "15551234567");
  assert.equal(parsed[0].name, "Zaz Dispatch", "a name before the number must be kept");
  assert.equal(digits(parsed[2].phone), "5552223333", "semicolon-separated CSV must parse");
  assert.equal(parsed[0].source, "local", "imported leads are marked as local, not invented portal rows");
  assert.equal(leadKey(parsed[0]), "15551234567", "a lead without a portal id is identified by its number");
  assert.equal(leadKey({ id: "abc", phone: "+1 555 000 0000" }), "abc", "a portal id still wins when there is one");
  console.log("  ok   " + parsed.length + " leads parsed, deduplicated, identified by phone");

  /* ── 2. the queue dials the local list, not just the first lead ─────────── */
  console.log("\nlocal queue");
  const dbDir = path.join(home, "db");
  localDb.open(dbDir);
  localDb.cacheLeads(parsed);

  const before = localDb.cachedLeadStats();
  assert.equal(before.total, 3);
  assert.equal(before.remaining, 3);

  const dialled = [];
  const summary = await runQueue({
    portal: "",                       // no portal at all
    token: "",
    gapMs: 0,
    log: () => {},
    cache: {
      cacheLeads: (l) => localDb.cacheLeads(l),
      cachedLeads: (n) => localDb.cachedLeads(n),
      markCachedLeadCalled: (p) => localDb.markCachedLeadCalled(p),
      addDoNotCall: (p, r) => localDb.addDoNotCall(p, r),
      isDoNotCall: (p) => localDb.isDoNotCall(p),
    },
    placeCall: async (lead) => {
      dialled.push(digits(lead.phone));
      localDb.saveCall({ leadId: lead.phone, score: 0.8, goodLead: true, summary: "interested", strategies: ["hook"] });
      return { connected: true, goodLead: true, leadEmailed: true };
    },
  });

  assert.equal(dialled.length, 3, "the whole saved list must be dialled, not one lead and a false 'finished': " + JSON.stringify(dialled));
  assert.equal(new Set(dialled).size, 3, "no number may be dialled twice in one run");
  assert.equal(summary.attempted, 3);
  assert.equal(summary.qualified, 3);
  const after = localDb.cachedLeadStats();
  assert.equal(after.remaining, 0, "called leads must leave the waiting list");
  console.log("  ok   dialled " + dialled.length + " of " + before.total + " without a portal");

  /* An empty local list ends the run instead of retrying every five seconds. */
  const empty = await runQueue({ portal: "", gapMs: 0, log: () => {}, cache: {
    cacheLeads: () => 0, cachedLeads: () => [], markCachedLeadCalled: () => {},
    addDoNotCall: () => {}, isDoNotCall: () => false,
  }, placeCall: async () => { throw new Error("must not dial an empty list"); } });
  assert.equal(empty.attempted, 0);
  console.log("  ok   an empty list finishes instead of spinning");

  /* ── 3. the results are stored where the operator can read them ─────────── */
  console.log("\nresults");
  const recent = localDb.recentCalls(10);
  assert.equal(recent.length, 3, "every call must be stored on this PC, not only logged");
  assert.equal(recent[0].goodLead, true);
  assert.equal(recent[0].score, 0.8);
  assert.deepEqual(recent[0].strategies, ["hook"]);
  assert.equal(digits(recent[0].phone).length >= 7, true, "the number must be stored with the result");
  console.log("  ok   " + recent.length + " results readable from the local database");

  /* ── 4. the dashboard serves leads and results without a portal ────────── */
  console.log("\ndashboard");
  const cfg = { companyName: "Zaz Logistics", product: "Dispatch Services for trucks" };
  const ui = await startWebUi({
    port: 0,
    readConfig: () => cfg,
    writeConfig: (c) => Object.assign(cfg, c),
    statusPath: null,
    leads: {
      stats: () => localDb.cachedLeadStats(),
      list: (n) => localDb.cachedLeads(n),
      import: (text) => {
        const rows = parseLeadText(text);
        const added = localDb.cacheLeads(rows);
        return Object.assign({ added, parsed: rows.length }, localDb.cachedLeadStats());
      },
      recent: (n) => localDb.recentCalls(n),
    },
  });
  const base = `http://127.0.0.1:${ui.port}`;
  try {
    let r = await fetch(base + "/api/state");
    const state = await r.json();
    assert.equal(state.configured, true, "a business description is enough - a device token must not be required");

    r = await fetch(base + "/api/leads");
    let d = await r.json();
    assert.equal(d.ok, true);
    assert.equal(d.total, 3);
    assert.equal(d.remaining, 0);

    r = await fetch(base + "/api/leads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ numbers: "+1 555 444 0000\nfoo" }) });
    d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.added, 1);
    assert.equal(d.remaining, 1, "a newly imported number is immediately dialable");

    r = await fetch(base + "/api/leads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ numbers: "  " }) });
    assert.equal(r.status, 400, "an empty import must be refused, not silently accepted");

    r = await fetch(base + "/api/calls");
    d = await r.json();
    assert.equal(d.ok, true);
    assert.equal(d.calls.length, 3, "the dashboard must show what the agent did");
    console.log("  ok   state, import and results all served locally");

    /* ── the AI key, which is the last thing a portal used to provide ─────
     * A fresh PC can dial and store results with no portal, but without an AI
     * key every call connects and stays silent. The dashboard must be able to
     * say whether one is held, take one, and never hand it back. */
    r = await fetch(base + "/api/provider-key");
    d = await r.json();
    assert.equal(d.ok, true);
    assert.equal(d.configured, false, "a new install has no AI key");

    r = await fetch(base + "/api/status");
    d = await r.json();
    assert.equal(d.aiKey && d.aiKey.configured, false, "the status feed must admit there is no AI key");
    assert.equal(d.portalConfigured, false, "and that no portal gateway could stand in for one");

    const KEY = "gsk_test_standalone_key_1234567890";
    r = await fetch(base + "/api/provider-key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: KEY }) });
    d = await r.json();
    assert.equal(d.ok, true);
    assert.equal(d.configured, true, "a saved key must be reported as held");
    assert.equal(JSON.stringify(d).includes(KEY), false, "the key must never come back out of the API");

    const storeRaw = fs.readFileSync(path.join(home, "provider.json"), "utf8");
    assert.equal(storeRaw.includes(KEY), false, "the key must be encrypted at rest, not written in plaintext");

    r = await fetch(base + "/api/status");
    d = await r.json();
    assert.equal(d.aiKey.configured, true, "the warning must clear once a key is saved");

    r = await fetch(base + "/api/provider-key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clear: true }) });
    d = await r.json();
    assert.equal(d.configured, false, "an empty save must remove the key, which is how a customer opts out");
    console.log("  ok   AI key stored encrypted, reported by presence, removable");
  } finally {
    await ui.close();
    localDb.close();
  }

  /* ── 5. the engine no longer gates a call on enrolment ─────────────────── */
  console.log("\nsource");
  const agentSrc = fs.readFileSync(path.join(__dirname, "agent.js"), "utf8");
  assert.ok(!/is not enrolled and synchronized/.test(agentSrc),
    "the enrolment gate that blocked every fresh install must be gone");
  assert.match(agentSrc, /if \(!isConfigured\(liveConfig\)\)/, "call control must check setup, not a portal token");
  assert.match(agentSrc, /Local mode - /, "a PC with no portal must report local mode, not reconnect forever");
  assert.match(agentSrc, /function recordCall\(/, "call results must be persisted locally");
  console.log("  ok   no enrolment gate, local mode, results stored");

  console.log("\nstandalone mode: PASS");
  console.log("  a business description is enough; the list, the results and the calls are all on this PC");
  fs.rmSync(home, { recursive: true, force: true });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
