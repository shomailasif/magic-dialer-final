"use strict";

/**
 * Work the lead list, one call after another, without waiting.
 *
 * Until now the engine placed exactly one call and then idled. The customer
 * asked for the obvious thing: take the next lead as soon as the previous call
 * ends, and if it was qualified, have the email already gone out.
 *
 * The email side already exists and is already correct - the agent posts the
 * call result to the portal, and /api/call-result only stores and emails a lead
 * when the agent reports goodLead. So this module is only responsible for the
 * loop: pull the next due lead, place the call, record what happened, repeat.
 *
 * The one thing it must never do is hang around. A campaign that idles between
 * calls is a campaign that wastes the customer's line time, so there is no
 * inter-call delay beyond letting the portal settle, and a lead that cannot be
 * called is skipped rather than retried in place.
 */

const DEFAULT_GAP_MS = 1500;
const MAX_CALL_SECONDS = 15 * 60;

function digits(phone) { return String(phone || "").replace(/\D/g, ""); }

/** A number we are willing to place. Cheap gate before spending a call slot. */
function dialable(lead) {
  if (!lead) return false;
  const d = digits(lead.phone);
  if (d.length < 7 || d.length > 15) return false;
  if (lead.doNotCall === true) return false;
  if (String(lead.consentStatus || "").toUpperCase() === "DENIED") return false;
  return true;
}

/**
 * Pull leads that are due. Ordered oldest-first so nobody is starved, and
 * filtered here as well as on the portal so a bad number never costs a call.
 */
async function fetchDueLeads({ portal, token, limit = 10, deviceToken }) {
  const base = String(portal || "").replace(/\/+$/, "");
  const auth = { "Content-Type": "application/json" };
  if (deviceToken) auth["x-device-token"] = deviceToken;
  const res = await fetch(base + "/api/leads?limit=" + limit, { headers: auth });
  if (!res.ok) throw new Error("could not read the lead list (HTTP " + res.status + ")");
  const body = await res.json().catch(() => null);
  const rows = Array.isArray(body) ? body : (body && (body.leads || body.data)) || [];
  return rows
    .filter((l) => l && !l.archived && l.status !== "CALLED" && l.status !== "CONVERTED")
    .filter(dialable)
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Run the queue until it is empty or stopped.
 *
 * `placeCall` is injected so this is testable without a phone: the engine passes
 * the real call path, the test passes a recorder.
 */
async function runQueue({
  portal, token, deviceToken, placeCall, log = () => {}, onProgress = () => {},
  gapMs = DEFAULT_GAP_MS, maxCalls = Infinity, shouldStop = () => false, leadFilter = null,
}) {
  const summary = { started: Date.now(), attempted: 0, connected: 0, qualified: 0, skipped: 0, errors: 0, results: [] };
  /* Leads already called in this run. The portal may not have marked them yet
   * when we look again, and without this the queue re-reads the same list and
   * calls the same first lead forever. */
  const seen = new Set();
  log("Dial queue started.");

  while (summary.attempted < maxCalls && !shouldStop()) {
    let leads;
    try {
      leads = await fetchDueLeads({ portal, token, limit: 10, deviceToken });
    } catch (e) {
      // The portal being briefly unreachable must not end a campaign.
      summary.errors++;
      log("Could not read the lead list: " + (e && e.message) + " - retrying shortly.");
      await delay(5000);
      continue;
    }

    if (leadFilter) leads = leads.filter(leadFilter);
    const fresh = leads.filter((l) => l && !seen.has(String(l.id)));
    if (!fresh.length) {
      const remaining = leads.length;
      log(remaining
        ? "Every lead in the list has been called. Queue finished."
        : "No more leads to call. Queue finished.");
      onProgress(summary);
      break;
    }

    // Take them in order, and never let one bad number stall the queue.
    let progressed = false;
    for (const lead of fresh) {
      if (shouldStop() || summary.attempted >= maxCalls) break;
      if (!dialable(lead)) { summary.skipped++; seen.add(String(lead.id)); continue; }

      summary.attempted++;
      seen.add(String(lead.id));
      progressed = true;
      const label = lead.name || lead.company || digits(lead.phone);
      log("Calling " + label + " (" + lead.phone + ") - " + summary.attempted + ".");
      onProgress(summary);

      const startedAt = Date.now();
      try {
        const result = await placeCall(lead, { timeoutMs: MAX_CALL_SECONDS * 1000 });
        const entry = {
          leadId: lead.id, name: label, phone: lead.phone,
          connected: !!(result && result.connected),
          goodLead: !!(result && result.goodLead),
          seconds: Math.round((Date.now() - startedAt) / 1000),
        };
        if (entry.connected) summary.connected++;
        // The portal emails the moment it receives a qualified result; there is
        // nothing to send from here and no reason to send it twice.
        if (entry.goodLead) {
          summary.qualified++;
          log("Qualified: " + label + " - the portal has emailed the lead already.");
        }
        summary.results.push(entry);
      } catch (e) {
        summary.errors++;
        summary.results.push({ leadId: lead.id, name: label, phone: lead.phone, error: String((e && e.message) || e).slice(0, 120) });
        log("Call to " + label + " failed: " + String((e && e.message) || e).slice(0, 90));
      }
      onProgress(summary);

      // Straight to the next one. The only wait is long enough that the portal
      // has recorded the previous result before the next call starts.
      if (!shouldStop() && summary.attempted < maxCalls) await delay(gapMs);
      break; // re-read the list: the portal may have updated it
    }
    if (!progressed) { summary.skipped++; await delay(2000); }
  }

  log("Dial queue finished: " + summary.attempted + " attempted, " + summary.connected
    + " connected, " + summary.qualified + " qualified, " + summary.skipped + " skipped, "
    + summary.errors + " errors.");
  onProgress(summary);
  return summary;
}

module.exports = { runQueue, fetchDueLeads, dialable, digits, DEFAULT_GAP_MS, MAX_CALL_SECONDS };
