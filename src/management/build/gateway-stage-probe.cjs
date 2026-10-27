/* Where does the gateway's turn cost actually go?
 *
 * MEMORY.md item 1 attributes the ~1.2-2.0s to the gateway hop itself and
 * proposes bypassing it with a direct provider key. That is only the right fix if
 * the cost sits in reaching Suga or in proxying Groq. These four stages separate
 * the possibilities, because each adds exactly one more stage to the one above:
 *
 *   0 GET /api/health                 no DB, no auth, no AI -> pure platform floor
 *   1 GET /api/engine/runtime-proof   3 sequential DB reads, no auth, no AI
 *   2 POST /api/engine/ai/stt (4 bytes)  device auth + quota write, no Groq
 *   3 POST /api/engine/ai/stt (real)     the whole live turn path
 *
 * Stage 3 minus stage 2 is the cost of Groq from inside the container, which is
 * the ONLY part a direct provider key would remove. Stage 2 minus stage 1 is what
 * auth plus the quota write costs, and stage 1 minus stage 0 is what the database
 * costs per round trip. No key placement touches those last two.
 *
 * Two details this probe got wrong the first time, both of which produced clean,
 * confident, meaningless numbers, so they are pinned here:
 *
 *   - /api/health and /api/engine/runtime-proof export GET only. POSTing to them
 *     returns 405 before the handler body runs, which reads as a fast successful
 *     stage and hides the database entirely. Those two stages use GET.
 *   - the STT route mu-law-decodes its input (function W) and wraps it at 8kHz.
 *     Sending it the 16kHz WAV fixture raw makes Groq transcribe noise, which it
 *     answers with "." in a fraction of the time real speech takes. That understates
 *     the provider cost by an order of magnitude and looks like a fast gateway.
 *     The audio is encoded exactly as the engine encodes it on the wire.
 *
 * One keep-alive connection carries every request, so no stage is charged a fresh
 * TLS handshake the others did not pay. The previous session lost a whole diagnosis
 * to a harness that measured itself.
 *
 *   node build/gateway-stage-probe.cjs [wav]
 */
"use strict";
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const WAV = process.argv[2] || path.join(__dirname, "fixtures", "who-is-it.wav");
const ROUNDS = 5;
const GAP_MS = 250;
const audioLib = require("./probe-audio.cjs");

function request(portal, agent, method, pathname, body, bearer) {
  return new Promise((resolve, reject) => {
    const u = new URL(portal);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const t0 = process.hrtime.bigint();
    const req = https.request({
      host: u.hostname,
      path: pathname,
      method,
      agent,
      headers: {
        ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
        ...(bearer ? { Authorization: "Bearer " + bearer } : {}),
      },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { raw += c; });
      res.on("end", () => resolve({
        ms: Number(process.hrtime.bigint() - t0) / 1e6,
        status: res.statusCode,
        note: raw.slice(0, 46).replace(/\s+/g, " "),
      }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function envKey(name) {
  try {
    const f = path.join(__dirname, "..", "..", "..", ".env");
    const m = fs.readFileSync(f, "utf8").match(new RegExp("^" + name + "=(.+)$", "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
  } catch { return null; }
}

const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];

(async () => {
  const { readInstalledConfig } = require("./installed-config.cjs");
  const cfg = readInstalledConfig();
  const portal = String(cfg.portalUrl || "").replace(/\/+$/, "");
  const bearer = cfg.deviceToken || cfg.token;
  if (!portal || !bearer) throw new Error("no portal/bearer in ~/.magicdialer/config.json");

  const fixture = audioLib.readWav(fs.readFileSync(WAV));
  const engineBytes = audioLib.engineAudio(WAV);
  console.log(`portal ${portal}`);
  console.log(`fixture ${path.basename(WAV)} ${(pcm.length / fmt.rate).toFixed(2)}s @${fmt.rate}Hz -> ${engineBytes.length} mu-law 8k bytes`);
  console.log(`${ROUNDS} rounds per stage, one keep-alive connection, ${GAP_MS}ms apart\n`);

  const agent = new https.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 30000 });
  const stages = [
    ["0 health        (no DB)      ", "GET", "/api/health", undefined, null],
    ["1 runtime-proof (3 DB reads)  ", "GET", "/api/engine/runtime-proof", undefined, null],
    ["2 stt 4 bytes   (auth+quota)  ", "POST", "/api/engine/ai/stt", { audio: Buffer.alloc(4).toString("base64") }, bearer],
    ["3 stt real      (full turn)   ", "POST", "/api/engine/ai/stt", { audio: engineBytes.toString("base64") }, bearer],
  ];

  const medians = [];
  let anomaly = null;
  for (const [label, method, pathname, body, tok] of stages) {
    const rows = [];
    for (let i = 0; i < ROUNDS; i++) {
      try {
        const r = await request(portal, agent, method, pathname, body, tok);
        rows.push(r);
        console.log(`  ${label} #${i + 1} ${String(r.ms.toFixed(0)).padStart(6)}ms  HTTP ${r.status}  ${r.note}`);
        /* A GET-only route answering 405, or STT returning punctuation instead of
         * words, means this stage is not doing the work it claims to measure. */
        if (r.status === 405) anomaly = anomaly || `${label} answered 405 - wrong verb, stage not exercised`;
        if (pathname.includes("/ai/stt") && /"text":"\.?"/.test(r.note)) anomaly = anomaly || `${label} transcribed to punctuation - audio format is wrong`;
      } catch (e) {
        rows.push({ ms: NaN, status: 0, note: "ERR " + String(e.message).slice(0, 40) });
        console.log(`  ${label} #${i + 1}    ERR  ${String(e.message).slice(0, 60)}`);
      }
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
    const good = rows.filter((r) => Number.isFinite(r.ms));
    const m = good.length ? med(good.map((r) => r.ms)) : NaN;
    medians.push(m);
    console.log(`  ${label} median ${Number.isFinite(m) ? m.toFixed(0) + "ms" : "n/a"}\n`);
  }
  agent.destroy();

  /* Stages 1 and 2 are NOT nested inside one another, so they must not be
   * differenced against each other. Stage 1 pays three uncached sequential DB
   * reads; stage 2 pays one quota write and gets device auth from the 3s cache
   * (its requests are 250ms apart). Differencing them produced a negative cost,
   * which is how this probe first reported a nonsense attribution. Each is
   * differenced against the platform floor, which they all genuinely sit on. */
  const [floor, db3, authq, full] = medians;
  const line = (k, v) => console.log(`  ${k.padEnd(36)} ${Number.isFinite(v) ? v.toFixed(0) + "ms" : "n/a"}`);

  console.log(`MEASURED (median of ${ROUNDS})`);
  line("platform floor, no DB", floor);
  line("floor + 3 uncached DB reads", db3);
  line("floor + auth(cache) + quota write", authq);
  line("floor + auth + quota + Groq (turn)", full);
  console.log("");
  if ([floor, db3, authq, full].some((v) => !Number.isFinite(v))) {
    console.log("  VERDICT: incomplete run. Do not draw a conclusion from it.");
    return;
  }

  const perRoundTrip = (db3 - floor) / 3;
  const quotaWrite = authq - floor;
  const groqInContainer = full - authq;

  console.log("DERIVED");
  line("per DB round trip", perRoundTrip);
  line("quota write (1 round trip)", quotaWrite);
  line("device auth, cache hit", quotaWrite - perRoundTrip);
  line("Groq from inside the container", groqInContainer);
  console.log("");

  /* The comparison that decides item 1, timed in this same run so platform
   * weather cannot flatter either number. */
  let direct = NaN, directNote = "skipped (no GROQ_API_KEY)";
  const key = envKey("GROQ_API_KEY");
  if (key) {
    const rows = [];
    for (let i = 0; i < ROUNDS; i++) {
      const t0 = process.hrtime.bigint();
      try {
        const fd = new FormData();
        fd.append("file", new Blob([audioLib.wavFromMulaw(engineBytes)], { type: "audio/wav" }), "speech.wav");
        fd.append("model", "whisper-large-v3-turbo");
        fd.append("response_format", "json");
        fd.append("temperature", "0");
        const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST", headers: { Authorization: "Bearer " + key }, body: fd, signal: AbortSignal.timeout(15000),
        });
        const j = await r.json().catch(() => ({}));
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (!r.ok) { directNote = `HTTP ${r.status}`; break; }
        rows.push({ ms, text: String(j.text || "").trim() });
      } catch (e) {
        directNote = "ERR " + String(e.message).slice(0, 40);
        break;
      }
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
    if (rows.length) {
      const best = rows.slice().sort((a, b) => b.text.length - a.text.length)[0];
      direct = med(rows.map((r) => r.ms));
      directNote = `text="${best.text.slice(0, 28)}"`;
      console.log("DIRECT TO GROQ FROM THIS PC (same run, same fixture)");
      rows.forEach((r, i) => console.log(`  direct #${i + 1} ${String(r.ms.toFixed(0)).padStart(6)}ms  "${r.text.slice(0, 28)}"`));
      console.log(`  direct median ${direct.toFixed(0)}ms  ${directNote}\n`);
      if (!/\w\w/.test(best.text)) {
        console.log("  VERDICT: direct path transcribed to noise - comparison invalid.");
        return;
      }
    }
  }

  console.log("THE DECISION IN MEMORY.md ITEM 1");
  if (!Number.isFinite(direct)) {
    console.log(`  Gateway turn ${full.toFixed(0)}ms. Direct path not comparable this run (${directNote}).`);
  } else {
    console.log(`  Through the gateway: ${full.toFixed(0)}ms   direct to Groq: ${direct.toFixed(0)}ms   gap: ${(full - direct).toFixed(0)}ms`);
    console.log(`  of which platform floor ~${floor.toFixed(0)}ms, quota write ~${quotaWrite.toFixed(0)}ms, Groq-in-container ~${groqInContainer.toFixed(0)}ms`);
    console.log("");
    console.log(`  A direct provider key removes the floor, the quota write and the container->Groq leg:`);
    console.log(`  it replaces all ${full.toFixed(0)}ms with ${direct.toFixed(0)}ms, saving ~${(full - direct).toFixed(0)}ms per STT.`);
    console.log(`  It also removes every DB round trip from the hot path, because nothing authenticates or meters locally.`);
    console.log(`  That is a real ${(full - direct).toFixed(0)}ms - and it is a product/security decision, not a cleanup.`);
  }
  console.log("");
  if (anomaly) {
    console.log(`  VERDICT: run is not trustworthy - ${anomaly}`);
    return;
  }
  if (perRoundTrip > 150) {
    console.log(`  SEPARATE FINDING: each DB round trip costs ~${perRoundTrip.toFixed(0)}ms from inside the container.`);
    console.log(`  MEMORY.md item 2 is confirmed and quantified. Region or transaction pooler is an infrastructure change;`);
    console.log(`  it buys nothing the key placement does not already buy on this path, and it also helps every other route.`);
  }
})().catch((e) => { console.error("FATAL", e && e.message); process.exit(1); });