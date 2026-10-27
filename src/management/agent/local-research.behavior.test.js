"use strict";
/**
 * The agent must actually research the web, not just be ready to.
 *
 * Research used to come only from the hosted portal: "where the search engines
 * live". When that portal closed, every call got an empty list while the
 * product still claimed the agent researches its vertical. This test runs the
 * real module against a stubbed web, with no portal URL and no device token, so
 * the dead dependency cannot creep back in.
 *
 * It checks the two failure modes that matter:
 *   1. Nothing is fetched without the portal (the old bug).
 *   2. A network failure is silent and never becomes a call failure, and is not
 *      retried on every prospect.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "md-research-"));
process.env.AUTODIAL_HOME = home;

const research = require("./sales-research");
const { refresh, getResearch, researchBlock, _test } = research;

const KEY = { product: "Dispatch Services", vertical: "Zaz Logistics" };
const RSS = `<?xml version="1.0"?><rss><channel>
  <item>
    <title>Truck dispatch cold call: detention pay and empty miles</title>
    <link>https://freight.example.com/dispatch-objections</link>
    <description>Ask how many empty miles they run and who pays detention. Those two numbers are the pain worth fixing.</description>
  </item>
  <item>
    <title>Questions that open a dispatch conversation</title>
    <link>https://sales.example.org/trucking</link>
    <description>Ask what happens when a driver sits for three hours at a shipper, then let them describe the cost themselves.</description>
  </item>
</channel></rss>`;

function okFetch(body, seen) {
  return async (url, opts) => {
    if (seen) seen.push(String(url));
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
  };
}

(async () => {
  /* ---- 1. the parser keeps what is useful and drops noise ---------------- */
  const parsed = _test.tacticsFromRss(RSS);
  assert.equal(parsed.length, 2, "both RSS items must become tactics");
  assert.equal(parsed[0].topic, "freight.example.com");
  assert.match(parsed[0].tactic, /detention/i);

  const noise = _test.tacticsFromRss(`<rss><channel><item>
    <title>ChatGPT can write your cold call script</title>
    <link>https://ai.example.com/x</link>
    <description>OpenAI and Gemini can generate a script for you in seconds.</description>
  </item></channel></rss>`);
  assert.deepEqual(noise, [], "AI-tool results teach a sales agent nothing and must be dropped");

  /* ---- 2. a website gives the agent the customer's own words ------------- */
  const page = _test.tacticsFromPage(`<html><head>
    <title>Zaz Logistics - truck dispatch</title>
    <meta name="description" content="We keep trucks loaded and drivers paid on time.">
  </head><body><h1>Dispatch that answers the phone</h1><h2>Detention and layover help</h2>
  <p>Our dispatchers cover your truck twenty four hours a day, negotiate rates, and chase detention pay so your driver is never left waiting for free.</p>
  </body></html>`, "https://zaz.example.com/");
  assert.ok(page.length >= 2, "a real page must yield title/description and site sections");
  assert.match(page.map((t) => t.tactic).join(" "), /detention/i);
  assert.equal(page[0].topic, "zaz.example.com");

  /* ---- 3. refresh works with NO portal and NO device token --------------- */
  const seen = [];
  const tactics = await refresh({ ...KEY, fetchImpl: okFetch(RSS, seen) });
  assert.ok(tactics.length >= 2, "the agent must research the web without the portal");
  assert.ok(seen.length >= 1, "research must actually make a request");
  assert.ok(seen.every((u) => /^https:\/\/(www\.)?bing\.com\/search\?/.test(u) || /duckduckgo/.test(u) || u === "https://zazlogistics.com"),
    "research must only go to free public sources (or the customer's own site), got: " + JSON.stringify(seen.slice(0, 3)));
  assert.ok(!seen.some((u) => /api\/engine\/research/.test(u)), "the dead portal route must not be the only source");
  assert.ok(seen.some((u) => /bing\.com|duckduckgo/.test(u)), "the open web must still be searched, not only the customer's site");

  /* ---- 3b. an irrelevant result is dropped, not taught ------------------- */
  const irrelevant = `<rss><channel><item>
    <title>Netflix - Watch TV Shows Online</title>
    <link>https://netflix.com/</link>
    <description>Netflix is a streaming service with award winning shows, movies and documentaries on any device.</description>
  </item></channel></rss>`;
  const rejected = await _test.searchWeb("truck dispatch sales tactics", okFetch(irrelevant), "Zaz Logistics Dispatch Services");
  assert.deepEqual(rejected, [], "a result for a different query must never become a sales tactic");

  /* ---- 3c. the guessed domain is only trusted if it names the company ---- */
  assert.equal(_test.guessWebsite("Zaz Logistics"), "https://zazlogistics.com");
  assert.equal(_test.pageMentions("<html><body>Zaz Logistics keeps trucks moving</body></html>", "Zaz Logistics"), true);
  assert.equal(_test.pageMentions("<html><body>An unrelated parking page</body></html>", "Zaz Logistics"), false,
    "a wrong domain guess must be discarded instead of teaching the agent nonsense");

  /* ---- 3d. Wikipedia is a free fallback with no key and no account ------ */
  const wikiHtml = JSON.stringify({
    query: { search: [{ title: "Trucking industry" }] },
  });
  const wikiSummaryBody = JSON.stringify({
    description: "Industry of road freight transport",
    extract: "Carriers negotiate rates with shippers and pay drivers per mile, so a delayed load costs the carrier both the truck and the driver's time. Customers choose a dispatcher on price and on how quickly loads are covered.",
  });
  const wikiFetch = async (url) => {
    const body = /rest_v1\/page\/summary/.test(String(url)) ? wikiSummaryBody : wikiHtml;
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
  };
  const wiki = await _test.wikipedia("trucking", wikiFetch);
  assert.ok(wiki.length >= 1, "Wikipedia must supply industry context when search is blocked");
  assert.match(wiki.map((t) => t.tactic).join(" "), /carrier|driver/i);
  assert.match(wiki[0].topic, /^Wikipedia:/);

  /* ---- 4. the result is available synchronously and on disk -------------- */
  assert.ok(getResearch(KEY.product, KEY.vertical).length >= 2, "a call reads research synchronously");
  _test.reset();
  assert.ok(getResearch(KEY.product, KEY.vertical).length >= 2,
    "a restart must reuse the cached research instead of re-querying the web");
  assert.ok(fs.existsSync(path.join(home, "research-cache.json")), "the cache must be on disk");

  /* ---- 5. the prompt actually carries it --------------------------------- */
  const { systemPrompt } = require("./intelligent-brain");
  const prompt = systemPrompt({ product: KEY.product, companyName: KEY.vertical, leadFields: [], research: tactics });
  assert.match(prompt, /RESEARCH \(proven techniques/);
  assert.match(prompt, /detention/i, "the researched tactic must reach the live prompt");

  /* ---- 6. failure is silent, and is not retried on every call ------------ */
  _test.reset();
  let attempts = 0;
  const failing = async () => { attempts++; throw new Error("offline"); };
  const none = await refresh({ product: "Other Product", vertical: "Other Co", fetchImpl: failing });
  assert.deepEqual(none, [], "a research miss is not a call failure");
  const afterFirst = attempts;
  await refresh({ product: "Other Product", vertical: "Other Co", fetchImpl: failing });
  assert.equal(attempts, afterFirst, "a failed search must back off instead of hammering the web on every prospect");

  /* ---- 7. the old portal-only guard cannot come back --------------------- */
  const src = fs.readFileSync(path.join(__dirname, "sales-research.js"), "utf8");
  assert.ok(!src.includes("if (!base || !deviceToken || !key) return [];"),
    "requiring a portal before doing any research is exactly the bug that made the claim false");

  console.log("local research: PASS");
  console.log("  free web search with no portal, no key, no account");
  console.log("  cached in memory and on disk; prompt carries the tactics");
  console.log("  offline is silent and backs off; AI-tool noise is filtered");

  fs.rmSync(home, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
