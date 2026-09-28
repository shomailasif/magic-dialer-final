/**
 * Sales-strategy research.
 *
 * The agent was learning only from its own call outcomes, and the playbook it
 * learned from was a hand-written list frozen at build time. It now researches
 * proven techniques for the customer's actual vertical on the open web, using
 * the same keyless DuckDuckGo Lite search the lead finder already uses, and
 * distils what it finds into short, speakable tactics.
 *
 * Two rules, both deliberate:
 *   1. It NEVER throws and NEVER blocks. A call is placed on a timer; research
 *      is fetched ahead of the call and a cache miss simply means we fall back
 *      to what we already know.
 *   2. It returns tactics, not articles. A tactic has to be sayable in one
 *      short sentence on a phone call, or it is worthless in the prompt.
 */
const { ddgSearch } = require("./find-leads");

const UA_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_RESULTS_PER_QUERY = 5;
const PAGES_PER_TOPIC = 2;
const PAGE_TIMEOUT_MS = 6000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** What we want to learn, per topic, for a given vertical. */
const RESEARCH_TOPICS = [
  { key: "opener", q: (v) => `cold call opener script for ${v} what to say first` },
  { key: "objections", q: (v) => `${v} objection handling phrases respond to` },
  { key: "discovery", q: (v) => `discovery questions to ask ${v} buyers` },
  { key: "closing", q: (v) => `how to close a ${v} sales call assumptive close` },
  { key: "followup", q: (v) => `follow up call after no answer ${v} what to say` },
];

/* Junk we must never learn from: vendor marketing pages, listicles with no
 * substance, and anything that is obviously not a technique. */
const NOISE = /list of \d+|top \d+ (?!.*(script|technique|question))/i;

/* A sentence only counts as a tactic if it tells the agent what to DO or SAY. */
const TACTIC_SIGNAL = /\b(say|ask|says|asking|respond|reply|answer|tell|phrase|script|instead of|rather than|mirror|close|handle|open with|start with|focus on|emphasi[sz]e|avoid|never|always|momentum|permission|assume)\b/i;

function clean(s) {
  return String(s || "").replace(/\s+/g, " ").replace(/[|#*_>]/g, " ").trim();
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/** Fetch a page and return its visible text, or "" on any failure. */
async function pageText(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) return "";
    const type = String(res.headers.get("content-type") || "");
    if (!/text\/html|application\/xhtml/i.test(type)) return "";
    const html = (await res.text()).slice(0, 400000);
    return clean(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
        .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
        .replace(/<[^>]+>/g, " ")
    );
  } catch {
    return "";
  }
}

/** Pull the most useful speakable sentences out of a page. */
function tacticsFromText(topic, text, source) {
  if (!text) return [];
  const out = [];
  for (const raw of text.split(/(?<=[.!?])\s+/)) {
    const s = clean(raw);
    if (s.length < 40 || s.length > 240) continue;
    if (!TACTIC_SIGNAL.test(s)) continue;
    if (NOISE.test(s)) continue;
    if (/^\+?\d[\d\s().-]{6,}$/.test(s)) continue;
    if (/\bcookie|privacy policy|terms of service|all rights reserved|sign up|subscribe\b/i.test(s)) continue;
    if (out.some((x) => x.tactic.toLowerCase().slice(0, 50) === s.toLowerCase().slice(0, 50))) continue;
    out.push({ topic, tactic: s, source });
    if (out.length >= 3) break;
  }
  return out;
}

/** Turn a search snippet into one speakable tactic, or nothing. */
function toTactic(topic, snippet, title) {
  const text = clean(snippet);
  if (text.length < 40) return null;
  if (NOISE.test(clean(title))) return null;
  // A tactic must look like guidance, not a phone number or a nav label.
  if (/^\+?\d[\d\s().-]{6,}$/.test(text)) return null;
  if (!TACTIC_SIGNAL.test(text)) return null;
  const first = text.split(/(?<=[.!?])\s/)[0] || text;
  const sentence = first.length >= 40 && first.length <= 240 ? first : (text.length <= 240 ? text : text.slice(0, 237) + "...");
  return { topic, tactic: sentence, source: clean(title).slice(0, 90) };
}

const cache = new Map();

/**
 * Research tactics for a vertical. Returns [] on any failure.
 * @param {{vertical?:string, product?:string, limit?:number}} opts
 */
async function researchSales({ vertical, product, limit = 6 } = {}) {
  const v = clean(vertical || product || "business").slice(0, 60) || "business";
  const key = v.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < UA_CACHE_TTL_MS && hit.tactics.length) return hit.tactics.slice(0, limit);

  const topics = RESEARCH_TOPICS.slice(0, Math.max(2, Math.min(RESEARCH_TOPICS.length, Math.ceil(limit / 1.5))));
  // Search every topic, then read the best pages from each. Search alone only
  // tells us a page *about* scripts exists; the technique is in the page.
  const searches = await Promise.all(
    topics.map(async (t) => {
      let results = [];
      try { results = await ddgSearch(t.q(v), MAX_RESULTS_PER_QUERY); } catch { results = []; }
      return { topic: t.key, results };
    })
  );

  const gathered = [];
  const pageWork = [];
  for (const s of searches) {
    for (const r of s.results.slice(0, PAGES_PER_TOPIC)) {
      const tactic = toTactic(s.topic, r.snippet, r.title);
      if (tactic) gathered.push(tactic);
      const host = hostOf(r.source);
      if (host && !/\.(pdf|jpg|png|zip|mp4)$/i.test(r.source)) {
        pageWork.push(pageText(r.source).then((t) => tacticsFromText(s.topic, t, host)));
      }
    }
  }
  const pages = await Promise.all(pageWork);

  const byTopic = new Map();
  for (const list of pages) {
    for (const t of list) {
      if (!byTopic.has(t.topic)) byTopic.set(t.topic, []);
      byTopic.get(t.topic).push(t);
    }
  }
  // Real page content beats a search snippet, and one tactic per topic keeps
  // the prompt balanced instead of six ways of opening a call.
  const fromPages = [];
  for (const [topic, list] of byTopic) {
    list.sort((a, b) => b.tactic.length - a.tactic.length);
    if (list[0]) fromPages.push(list[0]);
  }
  for (const t of fromPages) gathered.unshift(t);

  // De-duplicate near-identical tactics so the prompt is not five ways of
  // saying the same thing.
  const seen = new Set();
  const tactics = [];
  for (const t of gathered) {
    const k = t.tactic.toLowerCase().replace(/[^a-z ]/g, "").slice(0, 60);
    if (seen.has(k)) continue;
    seen.add(k);
    tactics.push(t);
    if (tactics.length >= limit) break;
  }

  cache.set(key, { at: Date.now(), tactics });
  return tactics;
}

module.exports = { researchSales, RESEARCH_TOPICS, UA_CACHE_TTL_MS };
