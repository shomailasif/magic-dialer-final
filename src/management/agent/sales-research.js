"use strict";
/**
 * Agent-side sales research.
 *
 * Fetches proven techniques for this customer's vertical from the portal, which
 * is where the search engines live, and keeps a local copy so a call never
 * waits on the network.
 *
 * Rules:
 *   - Never throws, never blocks a call. `getResearch` is synchronous and
 *     returns whatever was last fetched, possibly [].
 *   - `refresh` is fire-and-forget: kick it off before a call, read the cache
 *     during it.
 */
const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map(); // key -> { at, tactics }
let inFlight = new Set();

function keyOf(product, vertical) {
  return String(vertical || product || "").trim().toLowerCase().slice(0, 80);
}

/** Synchronous, instant, and safe to call from the middle of placing a call. */
function getResearch(product, vertical) {
  const hit = cache.get(keyOf(product, vertical));
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tactics;
  return [];
}

/** Fire-and-forget. Resolves to the tactics, but callers need not await it. */
async function refresh({ portal, deviceToken, callId, product, vertical } = {}) {
  const base = String(portal || "").replace(/\/+$/, "");
  const key = keyOf(product, vertical);
  if (!base || !deviceToken || !key) return [];
  if (inFlight.has(key)) return getResearch(product, vertical);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tactics;
  inFlight.add(key);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch(base + "/api/engine/research/sales", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + deviceToken, "x-call-id": String(callId || "") },
      body: JSON.stringify({ product: String(product || "").slice(0, 120), vertical: String(vertical || product || "").slice(0, 120) }),
      signal: ac.signal,
    });
    if (r.ok) {
      const d = await r.json().catch(() => ({}));
      const tactics = Array.isArray(d.tactics) ? d.tactics.filter((t) => t && typeof t.tactic === "string") : [];
      cache.set(key, { at: Date.now(), tactics });
    }
  } catch {
    // A research miss is not a call failure.
  } finally {
    clearTimeout(timer);
    inFlight.delete(key);
  }
  return getResearch(product, vertical);
}

/** Compact form for the system prompt: one line per tactic. */
function researchBlock(tactics) {
  if (!Array.isArray(tactics) || !tactics.length) return "";
  return tactics
    .slice(0, 6)
    .map((t, i) => `${i + 1}. (${t.topic}) ${String(t.tactic).replace(/\s+/g, " ").trim()}`)
    .join("\n");
}

module.exports = { getResearch, refresh, researchBlock, TTL_MS };
