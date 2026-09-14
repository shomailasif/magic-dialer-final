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

module.exports = { searchLeads };
