/**
 * Lead discovery — finds potential customers via web search.
 *
 * Uses DuckDuckGo Lite (no API key, no npm deps) via Node built-in fetch.
 * Returns an array of lead objects matching the shape expected by saveLeads():
 *   { id, title, source, snippet, company }
 *
 * Every export is async and NEVER throws — callers always get an array
 * (possibly empty) so the scheduler cannot crash.
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Search DuckDuckGo HTML lite for businesses matching a product/service query.
 * Extracts result links and snippets from the HTML.
 */
async function ddgSearch(query, count = 10) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return [];
  const html = await res.text();

  const results = [];
  // Match DDG lite result blocks: <a class="result__a" href="...">title</a>
  // and <a class="result__snippet">snippet</a>
  const linkRe = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const links = [];
  let m;
  while ((m = linkRe.exec(html)) !== null && links.length < count * 2) {
    links.push({ url: decodeDDGUrl(m[1]), title: strip(m[2]) });
  }

  const snippets = [];
  while ((m = snippetRe.exec(html)) !== null && snippets.length < count * 2) {
    snippets.push(strip(m[1]));
  }

  for (let i = 0; i < links.length && results.length < count; i++) {
    const { url: href, title } = links[i];
    if (!title || !href) continue;
    // Skip DDG internal links, social media, and huge aggregators
    if (/duckduckgo\.com|facebook\.com|twitter\.com|linkedin\.com|youtube\.com|wikipedia\.org|amazon\.com|yelp\.com/i.test(href)) continue;
    results.push({
      title,
      source: href,
      snippet: snippets[i] || "",
      company: extractCompany(title),
    });
  }
  return results;
}

function decodeDDGUrl(u) {
  try {
    const m = u.match(/uddg=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : u;
  } catch { return u; }
}

function strip(html) {
  return html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

function extractCompany(title) {
  // Heuristic: take the first segment before common separators
  const cleaned = title.replace(/\s*[-–|·].*$/, "").trim();
  return cleaned || title;
}

/**
 * Main entry point — called by the scheduler and API.
 *
 * @param {object} opts
 * @param {string} opts.product - What the customer sells / what to search for
 * @param {number} [opts.count=10] - Max leads to return
 * @returns {Promise<Array<{id:string,title:string,source:string,snippet:string,company:string}>>}
 */
async function searchLeads({ product, count = 10 } = {}) {
  if (!product || !String(product).trim()) return [];

  const query = `${String(product).trim()} business contact`;
  try {
    const results = await ddgSearch(query, count);
    // Add deterministic IDs so dedup in saveLeads works
    return results.map((r) => {
      const crypto = require("node:crypto");
      const id = crypto.createHash("md5").update(r.source || r.title).digest("hex").slice(0, 16);
      return { ...r, id };
    });
  } catch {
    // Search must never crash the scheduler
    return [];
  }
}



/* ---------------------------------------------------------------------------
 * Multi-engine web search.
 *
 * DuckDuckGo Lite alone is not enough: it answers the first few queries and then
 * returns HTTP 202 with an empty body for everything after, which is exactly
 * what happened here during development (one search returned 5 results, the
 * very next returned 0). SEARCH.md already warned that free engines throttle
 * cloud IPs, so every caller goes through this and gets whichever engine is
 * currently answering.
 * ------------------------------------------------------------------------- */
const ENGINE_ORDER = process.env.SEARCH_API_KEY ? ["serper", "ddg", "bing", "mojeek"] : ["ddg", "bing", "mojeek"];

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" }, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) return "";
  return await res.text();
}

/** Bing wraps every result in a redirect: ...&amp;u=a1<base64url of the real
 *  url>. The ampersand is HTML-escaped in the attribute, which is why a plain
 *  [?&]u= match silently failed and leaked bing.com/ck/a links. */
function decodeBingUrl(u) {
  try {
    const s = String(u).replace(/&amp;/g, "&");
    const m = s.match(/[?&]u=a1([^&]+)/);
    if (!m) return s;
    const decoded = Buffer.from(decodeURIComponent(m[1]).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return /^https?:\/\//i.test(decoded) ? decoded : s;
  } catch {
    return String(u);
  }
}

/** Words that carry the meaning of a query, used to reject off-topic results. */
const STOP = new Set(["the", "a", "an", "for", "to", "of", "and", "or", "in", "on", "with", "how", "what", "best", "call", "calls", "script", "scripts", "you", "your", "is", "are", "do", "does", "that", "this", "it", "at", "by", "from", "as", "be", "use", "using"]);

function keywords(q) {
  return String(q || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * A free engine can answer a completely different question - Bing returned
 * ChatGPT results for "cold call opener script for truck dispatch services"
 * from this IP. Feeding that into a sales prompt would teach the agent to
 * answer with nonsense, so every result must share real vocabulary with the
 * query or it is discarded.
 */
function isRelevant(result, query) {
  const kw = keywords(query);
  if (!kw.length) return true;
  const hay = `${result.title || ""} ${result.snippet || ""} ${result.source || ""}`.toLowerCase();
  let hits = 0;
  for (const w of kw) if (hay.includes(w)) hits++;
  // At least a third of the meaningful query words, and never zero.
  return hits > 0 && hits >= Math.max(1, Math.ceil(kw.length * 0.34));
}

function bingSearch(html, count) {
  const out = [];
  const blocks = html.split(/<li class="b_algo"/i).slice(1);
  for (const b of blocks) {
    if (out.length >= count) break;
    const m = b.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!m) continue;
    const href = decodeBingUrl(m[1]);
    if (!/^https?:/i.test(href)) continue;
    const title = strip(m[2]);
    if (!title) continue;
    const p = b.match(/<p class="b_lineclamp\d*"[^>]*>([\s\S]*?)<\/p>/i) || b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    out.push({ title, source: href, snippet: p ? strip(p[1]) : "", company: extractCompany(title) });
  }
  return out;
}

/** Serper.dev, the keyless-free path is unreliable so a key is preferred when
 *  SEARCH_API_KEY is set. Documented in SEARCH.md. */
async function serperSearch(query, count) {
  const key = process.env.SEARCH_API_KEY || "";
  if (!key) return [];
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: Math.max(10, count) }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const d = await res.json();
    const organic = Array.isArray(d.organic) ? d.organic : [];
    return organic.slice(0, count).map((o) => ({
      title: strip(o.title || ""),
      source: o.link || "",
      snippet: strip(o.snippet || ""),
      company: extractCompany(strip(o.title || "")),
    })).filter((r) => r.title && r.source);
  } catch {
    return [];
  }
}

function mojeekSearch(html, count) {
  const out = [];
  const re = /<a[^>]+class="ob"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p class="s"[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html)) !== null && out.length < count) {
    const title = strip(m[2]);
    if (!title || !/^https?:/i.test(m[1])) continue;
    out.push({ title, source: m[1], snippet: strip(m[3]), company: extractCompany(title) });
  }
  if (!out.length) {
    // Fallback shape: title/snippet pairs without the paired <p>.
    const re2 = /<a[^>]+href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = re2.exec(html)) !== null && out.length < count) {
      const title = strip(m[2]);
      if (!title || title.length < 12) continue;
      out.push({ title, source: m[1], snippet: "", company: extractCompany(title) });
    }
  }
  return out;
}

/**
 * Search the open web, trying each engine until one returns results.
 * Never throws - returns [] if every engine fails.
 */
async function webSearch(query, count = 5, engines = ENGINE_ORDER) {
  const q = encodeURIComponent(String(query || "").trim());
  if (!q) return [];
  for (const engine of engines) {
    let results = [];
    try {
      if (engine === "serper") {
        results = await serperSearch(String(query || "").trim(), count);
      } else if (engine === "ddg") {
        const html = await fetchHtml(`https://lite.duckduckgo.com/lite/?q=${q}`);
        if (html) {
          const re = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
          let m;
          while ((m = re.exec(html)) !== null && results.length < count) {
            const title = strip(m[2]);
            if (!title) continue;
            results.push({ title, source: decodeDDGUrl(m[1]), snippet: "", company: extractCompany(title) });
          }
          if (!results.length) {
            const html2 = await fetchHtml(`https://html.duckduckgo.com/html/?q=${q}`);
            if (html2) {
              const re2 = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
              while ((m = re2.exec(html2)) !== null && results.length < count) {
                const title = strip(m[2]);
                if (!title) continue;
                results.push({ title, source: decodeDDGUrl(m[1]), snippet: "", company: extractCompany(title) });
              }
            }
          }
        }
      } else if (engine === "bing") {
        const html = await fetchHtml(`https://www.bing.com/search?q=${q}&count=${Math.max(10, count)}`);
        if (html) results = bingSearch(html, count);
      } else if (engine === "mojeek") {
        const html = await fetchHtml(`https://www.mojeek.com/search?q=${q}`);
        if (html) results = mojeekSearch(html, count);
      }
    } catch {
      results = [];
    }
    const relevant = results.filter((r) => isRelevant(r, query));
    if (relevant.length) return relevant;
  }
  return [];
}

module.exports = { searchLeads, ddgSearch, webSearch, decodeBingUrl, isRelevant, ENGINE_ORDER };
