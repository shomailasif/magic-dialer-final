/**
 * Agent-to-portal sync — pushes local leads, calls, and stats to the cloud
 * when the portal is reachable. Runs on the heartbeat interval.
 *
 * The heartbeat payload now includes:
 *  - Local stats (leads, calls, qualified)
 *  - Unsynced leads and calls (the portal stores or merges them)
 *
 * This way the agent works fully offline and catches up when back online.
 */
const localDb = require("./local-db");

/**
 * Build the sync payload to include in the heartbeat POST.
 * Returns { stats, unsyncedLeads, unsyncedCalls }.
 */
function buildSyncPayload() {
  const stats = localDb.stats();
  const unsyncedLeads = localDb.getUnsyncedLeads().map((l) => {
    let answers = null;
    try { answers = l.answers ? JSON.parse(l.answers) : null; } catch {}
    return { id: l.id, name: l.name, phone: l.phone, email: l.email,
      company: l.company, product: l.product, source: l.source,
      status: l.status, score: l.score, summary: l.summary,
      answers, created_at: l.created_at,
    };
  });
  const unsyncedCalls = localDb.getUnsyncedCalls().map((c) => {
    let strategies = [];
    try { strategies = c.strategies ? JSON.parse(c.strategies) : []; } catch {}
    return { id: c.id, lead_id: c.lead_id, product: c.product,
      transcript: c.transcript, score: c.score,
      good_lead: c.good_lead, summary: c.summary,
      strategies, created_at: c.created_at,
    };
  });
  return { stats, unsyncedLeads, unsyncedCalls };
}

/**
 * Process the sync response from the portal (returned in heartbeat response).
 * Marks synced items locally.
 */
function processSyncResponse(response) {
  if (!response || typeof response !== "object") return;
  const { syncedLeads, syncedCalls } = response;
  if (Array.isArray(syncedLeads)) {
    for (const id of syncedLeads) localDb.markLeadSynced(id);
  }
  if (Array.isArray(syncedCalls)) {
    for (const id of syncedCalls) localDb.markCallSynced(id);
  }
}

module.exports = { buildSyncPayload, processSyncResponse };
