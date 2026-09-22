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
  saveCall, getUnsyncedCalls, markCallSynced,
  saveLearning, getLearning,
  queueSync, getUnsyncedSyncLog, markSyncLogSynced,
  stats,
};
