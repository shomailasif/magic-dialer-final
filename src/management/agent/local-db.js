/**
 * Agent local database — SQLite on the customer's PC.
 *
 * Stores leads, calls, and learning data LOCALLY so the agent works fully
 * offline. When the portal is reachable, the agent syncs summaries back via
 * the heartbeat response.
 *
 * Zero npm dependencies — uses only Node built-in sqlite (Node 22+).
 */
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

let _db = null;

function open(agentDir) {
  if (_db) return _db;
  const dbPath = path.join(agentDir, "agent.db");
  fs.mkdirSync(agentDir, { recursive: true });

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS leads (
      id           TEXT PRIMARY KEY,
      name         TEXT,
      phone        TEXT,
      email        TEXT,
      company      TEXT,
      product      TEXT,
      source       TEXT,
      status       TEXT NOT NULL DEFAULT 'new',
      score        REAL,
      summary      TEXT,
      answers      TEXT,
      created_at   INTEGER NOT NULL,
      synced       INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS calls (
      id           TEXT PRIMARY KEY,
      lead_id      TEXT,
      product      TEXT,
      transcript   TEXT,
      score        REAL,
      good_lead    INTEGER NOT NULL DEFAULT 0,
      summary      TEXT,
      strategies   TEXT,
      created_at   INTEGER NOT NULL,
      synced       INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS learning (
      key          TEXT PRIMARY KEY,
      value        TEXT NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      type         TEXT NOT NULL,
      payload      TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      synced       INTEGER NOT NULL DEFAULT 0
    );
    /* A copy of the portal's due-lead list, kept so a campaign survives the
     * portal being unreachable.
     *
     * This is deliberately NOT the leads table. That table feeds
     * getUnsyncedLeads(), which the heartbeat PUSHES UP to the portal. Writing
     * the portal's own rows into it would make the engine upload the customer's
     * list back at them on every beat - a sync loop, and a way to pollute
     * production data from a local file. This table is read locally and never
     * sent anywhere.
     *
     * Keyed by phone rather than by portal id, because the phone is the thing
     * that must never be dialled twice. The same subscriber under two portal
     * ids is still one person, and a portal restore can renumber ids while the
     * number stays the same. */
    CREATE TABLE IF NOT EXISTS lead_cache (
      phone       TEXT PRIMARY KEY,
      lead        TEXT NOT NULL,
      cached_at   INTEGER NOT NULL,
      called_at   INTEGER
    );
    /* Refusals heard on this PC, remembered locally.
     *
     * During an outage the call result 404s, so the portal never learns that
     * someone said stop. Without this the next cached page would dial them
     * again - the exact failure the spoken-opt-out work exists to prevent,
     * reintroduced by the offline path. Held by phone so it covers a lead that
     * is not in the cache at all, and applied to a live portal fetch as well
     * as a cached one, because a portal that comes back still lists them as
     * due until it has seen the result we could not deliver. */
    CREATE TABLE IF NOT EXISTS do_not_call (
      phone       TEXT PRIMARY KEY,
      at          INTEGER NOT NULL,
      reason      TEXT
    );
  `);
  _db = db;
  return db;
}

function db() {
  if (!_db) throw new Error("Agent DB not opened. Call open(agentDir) first.");
  return _db;
}

// ── Leads ──────────────────────────────────────────────────────────────

function saveLead(lead) {
  if (!lead) return null;
  const d = db();
  const id = lead.id || crypto.createHash("md5").update((lead.phone || "") + (lead.name || "") + Date.now()).digest("hex").slice(0, 16);
  const now = Date.now();
  try {
    d.prepare(`INSERT OR REPLACE INTO leads (id, name, phone, email, company, product, source, status, score, summary, answers, created_at, synced)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(
      id, lead.name || null, lead.phone || null, lead.email || null,
      lead.company || null, lead.product || null, lead.source || "call",
      lead.status || "new", lead.score ?? null, lead.summary || null,
      lead.answers ? JSON.stringify(lead.answers) : null, now
    );
  } catch (e) { console.error("[local-db] saveLead failed:", e.message); }
  return id;
}

const ALLOWED_LEAD_COLUMNS = new Set(["name", "phone", "email", "company", "product", "source", "status", "score", "summary", "answers"]);

function updateLead(id, fields) {
  if (!id || !fields || typeof fields !== "object") return;
  const d = db();
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (k === "id" || !ALLOWED_LEAD_COLUMNS.has(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(k === "answers" ? JSON.stringify(v) : v);
  }
  if (!sets.length) return;
  sets.push("synced = 0");
  vals.push(id);
  try { d.prepare(`UPDATE leads SET ${sets.join(", ")} WHERE id = ?`).run(...vals); } catch (e) { console.error("[local-db] updateLead failed:", e.message); }
}

function getUnsyncedLeads() {
  try { return db().prepare("SELECT * FROM leads WHERE synced = 0").all(); } catch { return []; }
}

function markLeadSynced(id) {
  try { db().prepare("UPDATE leads SET synced = 1 WHERE id = ?").run(id); } catch {}
}

function allLeads(limit = 100) {
  try { return db().prepare("SELECT * FROM leads ORDER BY created_at DESC LIMIT ?").all(limit); } catch { return []; }
}

// ── Offline lead cache ────────────────────────────────────────────────

/* Store a page of due leads so the campaign survives the portal being down.
 *
 * Upsert by phone. A lead already marked called keeps that mark: the portal
 * refreshes the row's contents but must not make a dialed subscriber dialable
 * again, which is what a blind INSERT OR REPLACE would do. */
function cacheLeads(leads) {
  if (!Array.isArray(leads) || !leads.length) return 0;
  const d = db();
  const now = Date.now();
  let n = 0;
  const stmt = d.prepare(`INSERT INTO lead_cache (phone, lead, cached_at) VALUES (?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET lead = excluded.lead, cached_at = excluded.cached_at`);
  for (const l of leads) {
    const phone = String((l && l.phone) || "").trim();
    if (!phone) continue;
    try { stmt.run(phone, JSON.stringify(l), now); n++; } catch {}
  }
  return n;
}

/* The leads still worth dialling from the cache, oldest first.
 *
 * Excludes anything this PC has already called or been told not to call. The
 * exclusion is by phone, so a subscriber reached under a different portal id
 * is still skipped. */
function cachedLeads(limit = 200) {
  try {
    return db().prepare(`SELECT lead FROM lead_cache
      WHERE called_at IS NULL AND phone NOT IN (SELECT phone FROM do_not_call)
      ORDER BY cached_at ASC LIMIT ?`).all(limit)
      .map((r) => { try { return JSON.parse(r.lead); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function markCachedLeadCalled(phone) {
  const p = String(phone || "").trim();
  if (!p) return;
  try { db().prepare("UPDATE lead_cache SET called_at = ? WHERE phone = ?").run(Date.now(), p); } catch {}
}

/* What the dashboard shows about the campaign list. `remaining` is the number
 * the queue would still dial, which is the only count that means anything to
 * an operator deciding whether to press Start. */
function cachedLeadStats() {
  try {
    const total = db().prepare("SELECT COUNT(*) AS n FROM lead_cache").get().n;
    const remaining = db().prepare(`SELECT COUNT(*) AS n FROM lead_cache
      WHERE called_at IS NULL AND phone NOT IN (SELECT phone FROM do_not_call)`).get().n;
    return { total, remaining };
  } catch { return { total: 0, remaining: 0 }; }
}

/* The last few calls, for the dashboard's results list. Stored since the local
 * database existed but never written to until now, which is why an operator
 * who was not watching the log had no record of what the agent said. */
function recentCalls(limit = 20) {
  try {
    return db().prepare(`SELECT id, lead_id, product, score, good_lead, summary, strategies, created_at
      FROM calls ORDER BY created_at DESC LIMIT ?`).all(limit).map((r) => ({
      id: r.id,
      phone: r.lead_id || null,
      product: r.product || null,
      score: r.score,
      goodLead: r.good_lead === 1,
      summary: r.summary || null,
      strategies: (() => { try { return JSON.parse(r.strategies || "[]"); } catch { return []; } })(),
      at: r.created_at ? new Date(r.created_at).toISOString() : null,
    }));
  } catch { return []; }
}

/* Remember a refusal on this PC, so an outage cannot turn it into a second call. */
function addDoNotCall(phone, reason) {
  const p = String(phone || "").trim();
  if (!p) return;
  try { db().prepare("INSERT OR REPLACE INTO do_not_call (phone, at, reason) VALUES (?, ?, ?)").run(p, Date.now(), String(reason || "spoken opt-out")); } catch {}
}

function isDoNotCall(phone) {
  const p = String(phone || "").trim();
  if (!p) return false;
  try { return !!db().prepare("SELECT 1 AS x FROM do_not_call WHERE phone = ?").get(p); } catch { return false; }
}

// ── Calls ──────────────────────────────────────────────────────────────

function saveCall(call) {
  const d = db();
  const id = call.id || crypto.randomUUID();
  const now = Date.now();
  try {
    d.prepare(`INSERT OR REPLACE INTO calls (id, lead_id, product, transcript, score, good_lead, summary, strategies, created_at, synced)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(
      id, call.leadId || null, call.product || null,
      typeof call.transcript === "string" ? call.transcript : JSON.stringify(call.transcript || []),
      call.score ?? null, call.goodLead ? 1 : 0, call.summary || null,
      call.strategies ? JSON.stringify(call.strategies) : null, now
    );
  } catch (e) { console.error("[local-db] saveCall failed:", e.message); }
  return id;
}

function getUnsyncedCalls() {
  try { return db().prepare("SELECT * FROM calls WHERE synced = 0").all(); } catch { return []; }
}

function markCallSynced(id) {
  try { db().prepare("UPDATE calls SET synced = 1 WHERE id = ?").run(id); } catch {}
}

// ── Learning ───────────────────────────────────────────────────────────

function saveLearning(key, value) {
  try { db().prepare("INSERT OR REPLACE INTO learning (key, value, updated_at) VALUES (?, ?, ?)").run(key, JSON.stringify(value), Date.now()); } catch {}
}

function getLearning(key) {
  try {
    const row = db().prepare("SELECT value FROM learning WHERE key = ?").get(key);
    return row ? JSON.parse(row.value) : null;
  } catch { return null; }
}

// ── Sync queue ─────────────────────────────────────────────────────────

function queueSync(type, payload) {
  try { db().prepare("INSERT INTO sync_log (type, payload, created_at) VALUES (?, ?, ?)").run(type, JSON.stringify(payload), Date.now()); } catch {}
}

function getUnsyncedSyncLog() {
  try { return db().prepare("SELECT * FROM sync_log WHERE synced = 0 ORDER BY created_at ASC").all(); } catch { return []; }
}

function markSyncLogSynced(id) {
  try { db().prepare("UPDATE sync_log SET synced = 1 WHERE id = ?").run(id); } catch {}
}

// ── Stats ──────────────────────────────────────────────────────────────

function stats() {
  const d = db();
  try {
    return {
      leads: d.prepare("SELECT COUNT(*) as n FROM leads").get().n,
      leadsUnsynced: d.prepare("SELECT COUNT(*) as n FROM leads WHERE synced = 0").get().n,
      calls: d.prepare("SELECT COUNT(*) as n FROM calls").get().n,
      callsUnsynced: d.prepare("SELECT COUNT(*) as n FROM calls WHERE synced = 0").get().n,
      qualifiedLeads: d.prepare("SELECT COUNT(*) as n FROM leads WHERE status = 'qualified'").get().n,
    };
  } catch { return { leads: 0, leadsUnsynced: 0, calls: 0, callsUnsynced: 0, qualifiedLeads: 0 }; }
}

function close() {
  if (_db) { try { _db.close(); } catch {} _db = null; }
}

process.on("exit", close);

module.exports = {
  open, close, saveLead, updateLead, getUnsyncedLeads, markLeadSynced, allLeads,
  cacheLeads, cachedLeads, markCachedLeadCalled, cachedLeadStats, addDoNotCall,
  isDoNotCall, recentCalls,
  saveCall, getUnsyncedCalls, markCallSynced,
  saveLearning, getLearning,
  queueSync, getUnsyncedSyncLog, markSyncLogSynced,
  stats,
};
