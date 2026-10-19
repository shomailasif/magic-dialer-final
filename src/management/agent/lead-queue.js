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
 *
 * The portal pages this list. The queue used to always ask for the first page,
 * so an account with more leads than one page could only ever have those dialled
 * and the rest were silently never reached. It now walks the pages in order and
 * only stops when the portal says there is nothing left.
 */
async function fetchDueLeads({ portal, token, limit = 200, deviceToken, offset = 0 }) {
  const base = String(portal || "").replace(/\/+$/, "");
  const auth = { "Content-Type": "application/json" };
  if (deviceToken) auth["Authorization"] = "Bearer " + deviceToken;
  /* /api/leads is the dashboard route and wants a browser session cookie. The
   * engine holds a device token and no cookie, so it asks the engine route
   * instead - authenticated like every other engine route, and it already drops
   * do-not-call rows and suppressed numbers before the engine ever sees them. */
  const res = await fetch(base + "/api/engine/leads?limit=" + limit + "&offset=" + offset, { headers: auth });
  if (!res.ok) throw new Error("could not read the lead list (HTTP " + res.status + ")");
  const body = await res.json().catch(() => null);
  const rows = Array.isArray(body) ? body : (body && (body.leads || body.data)) || [];
  const leads = rows
    .filter((l) => l && l.status !== "CALLED" && l.status !== "CONVERTED")
    .filter(dialable)
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  return { leads, hasMore: Boolean(body && body.hasMore), offset, limit };
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Read the next page of due leads, preferring the portal and falling back to
 * the local cache when the portal cannot be reached.
 *
 * The portal is always asked first, so a working account never dials from a
 * stale copy. The cache is only consulted when that ask fails, and it only
 * holds leads the portal itself handed us on a previous successful read - this
 * never invents a lead.
 *
 * A cache hit is reported through `onOffline` so the operator can see that the
 * campaign is running from a snapshot rather than the live list. Without that
 * signal a suspended account looks identical to a healthy one from the
 * dashboard, which is how a customer discovers the problem days later.
 */
async function readPage({
  portal, token, deviceToken, offset, limit = 200,
  cache: cacheApi = null, onOffline = () => {},
}) {
  try {
    const page = await fetchDueLeads({ portal, token, limit, deviceToken, offset });
    /* Keep the cache warm while the portal is healthy. A campaign that runs for
     * a week then hits an outage has a snapshot from this morning, not from the
     * day it was uploaded. */
    if (cacheApi && cacheApi.cacheLeads && page.leads.length) {
      try { cacheApi.cacheLeads(page.leads); } catch {}
    }
    return { page, fromCache: false };
  } catch (e) {
    if (!cacheApi || !cacheApi.cachedLeads) throw e;
    let cached = [];
    try { cached = cacheApi.cachedLeads(limit) || []; } catch {}
    if (!cached.length) throw e;
    onOffline(e && e.message);
    /* No pagination on the cache: it returns everything still worth dialling,
     * so hasMore is false and the loop stops once they are consumed. */
    return {
      page: { leads: cached, hasMore: false, offset: 0, limit: cached.length },
      fromCache: true,
    };
  }
}

/**
 * Run the queue until it is empty or stopped.
 *
 * `placeCall` is injected so this is testable without a phone: the engine passes
 * the real call path, the test passes a recorder.
 */
async function runQueue({
  portal, token, deviceToken, placeCall, log = () => {}, onProgress = () => {},
  gapMs = DEFAULT_GAP_MS, maxCalls = Infinity, shouldStop = () => false, leadFilter = null,
  cache: cacheApi = null,
}) {
  const summary = { started: Date.now(), attempted: 0, connected: 0, qualified: 0, skipped: 0, errors: 0, results: [] };
  /* Leads already called in this run. The portal may not have marked them yet
   * when we look again, and without this the queue re-reads the same list and
   * calls the same first lead forever. */
  const seen = new Set();
  /* Page cursor. Without it the queue re-read the first page forever and an
   * account with more than one page never got past them. */
  let offset = 0;
  /* Set once the portal has failed and the cache is carrying the campaign, so
   * every later message can say which list it is reading. */
  let offlineNoted = false;
  const noteOffline = (why) => {
    if (offlineNoted) return;
    offlineNoted = true;
    log("Portal unreachable (" + String(why || "no response").slice(0, 80) + ") - calling from the local lead list saved on this PC.");
  };
  log("Dial queue started.");

  while (summary.attempted < maxCalls && !shouldStop()) {
    let page;
    let fromCache = false;
    try {
      ({ page, fromCache } = await readPage({ portal, token, deviceToken, offset, limit: 200, cache: cacheApi, onOffline: noteOffline }));
    } catch (e) {
      // The portal being briefly unreachable must not end a campaign, and with
      // no cache there is nothing else to read, so wait and ask again.
      summary.errors++;
      log("Could not read the lead list: " + (e && e.message) + " - retrying shortly.");
      await delay(5000);
      continue;
    }

    let leads = page.leads;
    if (leadFilter) leads = leads.filter(leadFilter);
    /* A number this PC was told not to call is skipped on the live list too.
     * A portal that comes back still lists them as due until it has seen the
     * result the outage prevented us from delivering, so the local list is the
     * only place that knows. */
    if (cacheApi && cacheApi.isDoNotCall) {
      const before = leads.length;
      leads = leads.filter((l) => !cacheApi.isDoNotCall(l && l.phone));
      summary.skipped += before - leads.length;
    }
    const fresh = leads.filter((l) => l && !seen.has(String(l.id)));

    if (!fresh.length) {
      if (page.hasMore) {
        /* Nothing on this page can be dialled, so the cursor has to move past
         * the whole page. Leaving it put re-reads the same unusable page for
         * ever, which is the one way this loop can spin without doing work. */
        offset += page.limit;
        continue;
      }
      log(leads.length
        ? (fromCache
          ? "Every saved lead has been called. Queue finished."
          : "Every lead in the list has been called. Queue finished.")
        : (fromCache
          ? "No saved leads left to call. Queue finished."
          : "No more leads to call. Queue finished."));
      onProgress(summary);
      break;
    }

    // Take them in order, and never let one bad number stall the queue.
    let progressed = false;
    for (const lead of fresh) {
      if (shouldStop() || summary.attempted >= maxCalls) break;
      if (!dialable(lead)) { summary.skipped++; seen.add(String(lead.id)); offset++; continue; }

      summary.attempted++;
      seen.add(String(lead.id));
      /* The cursor counts leads consumed, not pages read. Only one call is made
       * per read so the portal can record it, so advancing by a whole page here
       * would skip every lead between here and the end of that page. */
      offset++;
      /* Mark in the cache the moment we commit to dialling, not after the call
       * returns. A crash mid-call must not leave the number dialable, or the
       * next run rings them a second time. */
      if (cacheApi && cacheApi.markCachedLeadCalled) {
        try { cacheApi.markCachedLeadCalled(lead.phone); } catch {}
      }
      progressed = true;
      const label = lead.name || lead.company || digits(lead.phone);
      log("Calling " + label + " (" + lead.phone + ") - " + summary.attempted + ".");
      onProgress(summary);

      const startedAt = Date.now();
      try {
        const result = await placeCall(lead, { timeoutMs: MAX_CALL_SECONDS * 1000 });
        /* A refusal has to survive the outage. The portal normally suppresses
         * the number the moment the result lands, but during an outage that
         * POST 404s and the portal still lists them as due. Remembered here so
         * the next read - cached or live - skips them. */
        if (result && result.doNotCall === true && cacheApi && cacheApi.addDoNotCall) {
          try { cacheApi.addDoNotCall(lead.phone, result.escalateReason || "spoken opt-out"); } catch {}
        }
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

module.exports = { runQueue, fetchDueLeads, readPage, dialable, digits, DEFAULT_GAP_MS, MAX_CALL_SECONDS };
