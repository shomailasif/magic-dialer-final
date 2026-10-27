"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Agent-side sales research.
 *
 * It used to fetch tactics from the hosted portal, "which is where the search
 * engines live". That portal is gone, so every call got []. The claim that the
 * agent researches the open web was therefore false on a live call, even though
 * the prompt was ready to use the result.
 *
 * This version does the searching on the customer's PC. It uses free endpoints
 * only - Bing's RSS output and DuckDuckGo's HTML page - so there is no key, no
 * account and no per-query cost. If the portal ever comes back it is still
 * tried first, because a curated tactic library beats raw search snippets.
 *
 * Rules that must not change:
 *   - Never throws, never blocks a call. `getResearch` is synchronous and
 *     returns whatever was last fetched, possibly [].
 *   - `refresh` is fire-and-forget: kick it off before a call, read the cache
 *     during it. The caller also races it against a 2.5s timer, so a slow
 *     search can never delay the ring.
 *   - Results are cached on disk, so a restart does not throw away a good
 *     research pass and a campaign does not re-query the web for every call.
 */
const TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const MAX_TACTICS = 6;
const MAX_CACHE_ENTRIES = 40;

const cache = new Map(); // key -> { at, tactics }
const lastAttempt = new Map(); // key -> ms of the last failed/empty attempt
let inFlight = new Set();
let diskLoaded = false;

function keyOf(product, vertical) {
  return String(vertical || product || "").trim().toLowerCase().slice(0, 80);
}

function cachePath() {
  const base = process.env.AUTODIAL_HOME || path.join(os.homedir(), ".magicdialer");
  return path.join(base, "research-cache.json");
}

function loadDisk() {
  if (diskLoaded) return;
  diskLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
    for (const [k, v] of Object.entries(raw || {})) {
      if (v && Array.isArray(v.tactics) && typeof v.at === "number") cache.set(k, { at: v.at, tactics: v.tactics });
    }
  } catch { /* first run, or a corrupt cache: an empty cache is fine */ }
}

function saveDisk() {
  try {
    const entries = [...cache.entries()]
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
      .slice(0, MAX_CACHE_ENTRIES);
    const out = {};
    for (const [k, v] of entries) out[k] = { at: v.at, tactics: v.tactics };
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(out), "utf8");
  } catch { /* a cache that cannot be written is not a call failure */ }
}

function fresh(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  return null;
}

/** Synchronous, instant, safe to call from the middle of placing a call. */
function getResearch(product, vertical) {
  loadDisk();
  const hit = fresh(keyOf(product, vertical));
  return hit ? hit.tactics : [];
}

/* ------------------------------------------------------------------ text -- */

function decodeEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function stripHtml(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function hostOf(url) {
  try { return new URL(String(url || "")).hostname.replace(/^www\./i, ""); } catch { return ""; }
}

/* Results that are about using an AI, or about logging in, teach the agent
 * nothing about selling. A free engine once served ChatGPT results for a
 * cold-call query; that is worse than teaching it nothing. */
const NOISE_RE = /\b(chatgpt|openai|bard|gemini|copilot|login|sign in|sign up|privacy policy|cookie policy)\b/i;

function cleanTactic(topic, text, url) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length < 25) return null;
  if (NOISE_RE.test(t)) return null;
  return { topic: String(topic || "Web").slice(0, 40), tactic: t.slice(0, 300) };
}

/* Search engines are not all reachable from every network, and the ones that
 * answer a bot can return results for a completely different query (a live
 * probe returned Netflix and a tax portal for a truck-dispatch query). A
 * result is only allowed into the prompt if it actually shares a meaningful
 * word with what was asked. That turns "the wrong results" into "no results",
 * which is the safe direction. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "your", "you", "our", "their",
  "are", "was", "were", "will", "have", "has", "had", "not", "but", "all", "any",
  "can", "how", "what", "when", "who", "why", "into", "over", "under", "about",
  "services", "service", "sales", "tactics", "tactic", "objection", "handling",
  "questions", "question", "cold", "call", "calls", "company", "business",
]);

function words(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

function isRelevant(text, subject) {
  const wanted = words(subject);
  if (!wanted.length) return true;
  const found = new Set(words(text));
  return wanted.some((w) => found.has(w));
}

/* The company name is often the domain. Try it, but never trust it: the page
 * must actually mention the company before its words are allowed to shape a
 * sales call. "Zaz Logistics" -> zazlogistics.com, which is theirs; a wrong
 * guess resolves to an unrelated site that fails the check and is discarded. */
function guessWebsite(companyName) {
  const slug = String(companyName || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (slug.length < 4 || slug.length > 40) return "";
  return "https://" + slug + ".com";
}

function pageMentions(html, companyName) {
  const wanted = words(companyName);
  if (!wanted.length) return false;
  const text = stripHtml(html).toLowerCase();
  return wanted.some((w) => text.includes(w));
}

/* ------------------------------------------------------------ Wikipedia -- */

/* Wikipedia's API is free, needs no key, and does not block a desktop app.
 * It gives industry context - who the buyer is, what their day looks like -
 * which is what a cold call needs before a tactic can land. */
function sentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 60 && s.length <= 300);
}

function tacticsFromWiki(summary, title) {
  const body = String(summary || "");
  if (!body) return [];
  const salesWords = /(customer|client|price|pricing|cost|contract|negotiat|service|delay|rate|competit|demand|supply|driver|carrier|shipper)/i;
  const picked = sentences(body).filter((s) => salesWords.test(s)).slice(0, 2);
  const topic = "Wikipedia: " + String(title || "industry").slice(0, 28);
  return picked
    .map((s) => cleanTactic(topic, "Industry context: " + s, ""))
    .filter(Boolean);
}

async function wikipedia(subject, fetchImpl) {
  const q = encodeURIComponent(String(subject || "").slice(0, 120));
  if (!q) return [];
  try {
    const res = await fetchText("https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=" + q + "&format=json&srlimit=2&utf8=1", {
      fetchImpl,
      headers: { Accept: "application/json" },
    });
    const data = JSON.parse(res);
    const titles = ((data && data.query && data.query.search) || []).map((x) => x && x.title).filter(Boolean).slice(0, 2);
    const out = [];
    for (const title of titles) {
      const summary = await wikiSummary(title, fetchImpl);
      out.push(...tacticsFromWiki(summary, title));
      if (out.length >= 2) break;
    }
    return out.slice(0, 2);
  } catch { return []; }
}

async function wikiSummary(title, fetchImpl) {
  const name = encodeURIComponent(String(title).replace(/\s+/g, "_"));
  try {
    const body = await fetchText("https://en.wikipedia.org/api/rest_v1/page/summary/" + name, {
      fetchImpl,
      headers: { Accept: "application/json" },
    });
    const data = JSON.parse(body);
    return [data && data.description, data && data.extract].filter(Boolean).join(" ");
  } catch { return ""; }
}

/* --------------------------------------------------------------- sources -- */

function tacticsFromRss(xml, fallbackTopic) {
  const out = [];
  const items = String(xml || "").match(/<item>[\s\S]*?<\/item>/gi) || [];
  for (const item of items) {
    const pick = (tag) => {
      const m = item.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return m ? stripHtml(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, "")) : "";
    };
    const title = pick("title");
    const desc = pick("description");
    const link = pick("link");
    const topic = hostOf(link) || fallbackTopic || "Web";
    const t = cleanTactic(topic, (title ? title + ": " : "") + desc, link);
    if (t) out.push(t);
    if (out.length >= 10) break;
  }
  return out;
}

function tacticsFromDdg(html, fallbackTopic) {
  const titles = [];
  const snippets = [];
  const tRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const sRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = tRe.exec(html))) titles.push(stripHtml(m[1]));
  while ((m = sRe.exec(html))) snippets.push(stripHtml(m[1]));
  const out = [];
  for (let i = 0; i < titles.length && out.length < MAX_TACTICS; i++) {
    const t = cleanTactic(fallbackTopic || "Web", (titles[i] ? titles[i] + ": " : "") + (snippets[i] || ""), "");
    if (t) out.push(t);
  }
  /* Some DDG responses carry the snippet in a <td> rather than an <a>. */
  if (!out.length) {
    const cells = String(html || "").match(/<td[^>]+class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/gi) || [];
    for (const cell of cells) {
      const t = cleanTactic(fallbackTopic || "Web", stripHtml(cell), "");
      if (t) out.push(t);
      if (out.length >= MAX_TACTICS) break;
    }
  }
  return out;
}

function tacticsFromPage(html, url) {
  const page = String(html || "");
  const title = stripHtml((page.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  const meta = stripHtml(
    (page.match(/<meta[^>]+name=["']description["'][^>]*content=["']([\s\S]*?)["']/i) ||
     page.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]*name=["']description["']/i) ||
     [])[1] || ""
  );
  const headings = [];
  const hRe = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi;
  let h;
  while ((h = hRe.exec(page)) && headings.length < 6) {
    const text = stripHtml(h[1]);
    if (text.length >= 4 && text.length <= 160) headings.push(text);
  }
  let paragraph = "";
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let p;
  while ((p = pRe.exec(page)) && paragraph.length < 80) {
    const text = stripHtml(p[1]);
    if (text.length > paragraph.length) paragraph = text;
  }
  const out = [];
  const host = hostOf(url) || "Your website";
  if (title || meta) out.push(cleanTactic(host, [title, meta].filter(Boolean).join(" - "), url));
  if (headings.length) out.push(cleanTactic(host, "Site sections: " + headings.join(" | "), url));
  if (paragraph.length >= 80) out.push(cleanTactic(host, "Site copy: " + paragraph, url));
  return out.filter(Boolean).slice(0, 3);
}

async function fetchText(url, { fetchImpl, ms = 6000, headers = {} } = {}) {
  const f = typeof fetchImpl === "function" ? fetchImpl : fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await f(url, {
      method: "GET",
      redirect: "follow",
      signal: ac.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MagicDialer/1.0",
        "Accept-Language": "en-US,en;q=0.8",
        ...headers,
      },
    });
    if (!res || !res.ok) return "";
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const DDG_HEADERS = { Accept: "text/html,application/xhtml+xml" };

async function searchWeb(query, fetchImpl, subject = "") {
  const q = encodeURIComponent(String(query || "").slice(0, 180));
  const keep = (list) => list.filter((t) => isRelevant(t.tactic, subject || query));
  /* Bing's RSS output is the cheapest free endpoint to parse. It is also the
   * one that served unrelated results on a live probe, so every item is
   * checked against the subject before it is kept. */
  try {
    const xml = await fetchText("https://www.bing.com/search?q=" + q + "&format=rss&count=10", { fetchImpl });
    const found = keep(tacticsFromRss(xml, "Web"));
    if (found.length) return found;
  } catch { /* fall through to DuckDuckGo */ }
  try {
    const html = await fetchText("https://html.duckduckgo.com/html/?q=" + q, { fetchImpl, headers: DDG_HEADERS });
    return keep(tacticsFromDdg(html, "Web"));
  } catch { return []; }
}

async function fromPortal({ portal, deviceToken, callId, product, vertical, fetchImpl, ms = 6000 }) {
  const base = String(portal || "").replace(/\/+$/, "");
  if (!base || !deviceToken) return [];
  const f = typeof fetchImpl === "function" ? fetchImpl : fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await f(base + "/api/engine/research/sales", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + deviceToken, "x-call-id": String(callId || "") },
      body: JSON.stringify({ product: String(product || "").slice(0, 120), vertical: String(vertical || product || "").slice(0, 120) }),
      signal: ac.signal,
    });
    if (!res || !res.ok) return [];
    const d = await res.json().catch(() => ({}));
    return Array.isArray(d.tactics)
      ? d.tactics.filter((t) => t && typeof t.tactic === "string").slice(0, MAX_TACTICS)
      : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function queriesFor(product, vertical) {
  const p = String(product || "").trim();
  const v = String(vertical || "").trim();
  const subject = v && v.toLowerCase() !== p.toLowerCase() ? v + " " + p : (p || v);
  if (!subject) return [];
  const out = [subject + " sales tactics objection handling"];
  /* A second, differently-shaped query helps when the first returns generic
   * marketing pages: the questions a buyer in this vertical actually asks. */
  out.push(subject + " cold call questions pain points");
  return out.map((q) => q.replace(/\s+/g, " ").slice(0, 180));
}

/* --------------------------------------------------------------- refresh -- */

/** Fire-and-forget. Resolves to the tactics, but callers need not await it. */
async function refresh({ portal, deviceToken, callId, product, vertical, website, fetchImpl } = {}) {
  loadDisk();
  const key = keyOf(product, vertical);
  if (!key) return [];
  const hit = fresh(key);
  if (hit) return hit.tactics;
  if (inFlight.has(key)) return getResearch(product, vertical);
  /* A failed or empty pass is not retried on every call: offline for an hour
   * should cost one attempt, not one per prospect. */
  const last = lastAttempt.get(key) || 0;
  if (Date.now() - last < RETRY_MS) return getResearch(product, vertical);

  inFlight.add(key);
  let tactics = [];
  try {
    /* The curated portal library first, if that portal still exists. */
    tactics = await fromPortal({ portal, deviceToken, callId, product, vertical, fetchImpl });

    if (!tactics.length) {
      const local = [];
      const subject = [String(vertical || "").trim(), String(product || "").trim()]
        .filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i)
        .join(" ") || String(product || vertical || "").trim();

      /* The customer's own site is the highest-value source: it is their
       * words, their services, their differentiators. Use the address they
       * gave us; otherwise try the company name as a domain and accept it
       * only if the page actually mentions the company. */
      const explicit = String(website || "").trim();
      let site = /^https?:\/\//i.test(explicit) ? explicit : "";
      if (!site && vertical) {
        const guessed = guessWebsite(vertical);
        if (guessed) {
          try {
            const html = await fetchText(guessed, { fetchImpl, ms: 7000 });
            if (pageMentions(html, vertical)) site = guessed;
          } catch { /* not every company owns the obvious domain */ }
        }
      }
      if (site) {
        try {
          const html = await fetchText(site, { fetchImpl, ms: 7000 });
          local.push(...tacticsFromPage(html, site));
        } catch { /* a dead website must not stop the search */ }
      }

      /* Best-effort open web. Filtered by relevance inside searchWeb, because
       * a blocked engine can otherwise answer with a different query's page. */
      for (const query of queriesFor(product, vertical)) {
        if (local.length >= 4) break;
        local.push(...await searchWeb(query, fetchImpl, subject));
      }

      /* Guaranteed free source: Wikipedia's API does not block desktop apps
       * and gives the buyer's industry context when search returns nothing. */
      if (local.length < 2) {
        const wiki = await wikipedia([vertical, product].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" "), fetchImpl);
        local.push(...wiki);
      }

      /* De-duplicate by the start of the tactic, keeping the first. */
      const seen = new Set();
      tactics = local.filter((t) => {
        const k = String(t.tactic || "").toLowerCase().slice(0, 80);
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      }).slice(0, MAX_TACTICS);
    }

    if (tactics.length) {
      cache.set(key, { at: Date.now(), tactics });
      lastAttempt.delete(key);
      saveDisk();
    } else {
      lastAttempt.set(key, Date.now());
    }
  } catch {
    lastAttempt.set(key, Date.now());
  } finally {
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

module.exports = {
  getResearch,
  refresh,
  researchBlock,
  TTL_MS,
  _test: {
    keyOf,
    cachePath,
    tacticsFromRss,
    tacticsFromDdg,
    tacticsFromPage,
    searchWeb,
    queriesFor,
    guessWebsite,
    pageMentions,
    isRelevant,
    words,
    wikipedia,
    tacticsFromWiki,
    reset() {
      cache.clear();
      lastAttempt.clear();
      inFlight = new Set();
      diskLoaded = false;
    },
  },
};
