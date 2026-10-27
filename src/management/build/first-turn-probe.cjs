/* Is the first-turn STT outlier a cold start, or something else?
 *
 * MEMORY.md flags one run where turn 1 STT took 7751ms while turns 2-4 were
 * normal, and correctly refuses to guess at the cause. "Probably a cold
 * connection" is exactly the kind of convenient answer that preceded three wrong
 * diagnoses, so this probe tests the cold-start hypothesis against alternatives
 * rather than assuming it.
 *
 * Each trial spawns a BRAND NEW node process that fires the same STT request
 * once, exactly as the engine does on turn 1, and reports its own elapsed time.
 * Running several trials back to back separates two different things that both
 * look like "cold":
 *
 *   cold process   first request from a fresh Node process: TLS handshake, undici
 *                  pool setup, no HTTP keep-alive reuse
 *   cold container what the previous trials have already warmed: Prisma pool,
 *                  Next route module, provider connection inside Suga
 *
 * If trial 1 is slow and trials 2+ are fast while each runs in its own process,
 * it is per-process cold start - a real, fixable engine cost (a persistent agent
 * process that keeps connections alive would not pay it on every turn).
 * If every trial is slow, the container itself is cold or the path is just slow,
 * and nothing in the engine can fix it.
 * If the slow trial appears at a random position rather than the first, it is not
 * cold start at all and needs the distribution, not an anecdote.
 *
 *   node build/first-turn-probe.cjs [trials]
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const TRIALS = Number(process.argv[2] || 6);
const ROOT = path.join(__dirname, "..");

/* ---- one request, run in this process. Reports elapsed to stdout as JSON. ---- */
if (process.env.MD_PROBE_CHILD === "1") {
  const { readInstalledConfig } = require("./installed-config.cjs");
  const cfg = readInstalledConfig();
  const portal = String(cfg.portalUrl || "").replace(/\/+$/, "");
  const bearer = cfg.deviceToken || cfg.token;
  /* The STT route mu-law-decodes its input, so the 16kHz WAV fixture must be
   * converted to 8k mu-law first. Sent raw it transcribes to "." in a fraction
   * of the time real speech takes, which would make this probe measure a
   * provider fast-path instead of a turn. */
  /* .cjs is not in CommonJS extension resolution order, so it must be named. */
  const audio = require("./probe-audio.cjs").engineAudio(
    path.join(__dirname, "fixtures", "who-is-it.wav"),
  ).toString("base64");
  const t0 = process.hrtime.bigint();
  (async () => {
    try {
      const r = await fetch(portal + "/api/engine/ai/stt", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + bearer },
        body: JSON.stringify({ audio }),
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json().catch(() => ({}));
      process.stdout.write(JSON.stringify({
        ms: Number(process.hrtime.bigint() - t0) / 1e6,
        status: r.status,
        text: String(j.text || j.error || "").slice(0, 30),
      }));
    } catch (e) {
      process.stdout.write(JSON.stringify({ ms: Number(process.hrtime.bigint() - t0) / 1e6, status: 0, text: "ERR " + String(e && e.message).slice(0, 50) }));
    }
  })();
  return;
}

/* ---- parent: one fresh process per trial ---- */
(async () => {
  console.log(`${TRIALS} trials, each a brand new node process firing ONE STT request`);
  console.log("isolates per-process cold start from container warm state\n");

  const rows = [];
  for (let i = 1; i <= TRIALS; i++) {
    const out = execFileSync(process.execPath, [__filename], {
      env: { ...process.env, MD_PROBE_CHILD: "1" },
      encoding: "utf8",
      timeout: 40000,
    });
    const r = JSON.parse(out);
    rows.push(r);
    console.log(`  trial ${String(i).padStart(2)}  ${String(r.ms.toFixed(0)).padStart(6)}ms  HTTP ${r.status}  "${r.text}"`);
    await new Promise((r2) => setTimeout(r2, 400));
  }

  const good = rows.filter((r) => r.status === 200 && /\w\w/.test(r.text));
  if (good.length < 2) {
    console.log("\nVERDICT: too few successful trials to conclude anything. Re-run when the gateway is healthy.");
    return;
  }
  const sorted = good.map((r) => r.ms).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const first = good[0].ms;
  const rest = good.slice(1).map((r) => r.ms).sort((a, b) => a - b);
  const restMed = rest.length ? rest[Math.floor(rest.length / 2)] : NaN;

  console.log("\nDISTRIBUTION");
  console.log(`  successful trials : ${good.length}/${TRIALS}`);
  console.log(`  first trial       : ${first.toFixed(0)}ms`);
  console.log(`  median of the rest: ${Number.isFinite(restMed) ? restMed.toFixed(0) + "ms" : "n/a"}`);
  console.log(`  median all        : ${med.toFixed(0)}ms`);
  console.log(`  slowest           : ${sorted[sorted.length - 1].toFixed(0)}ms`);

  console.log("\nVERDICT");
  if (first > restMed * 2 && first > 800) {
    console.log(`  Per-process cold start is real: trial 1 cost ${first.toFixed(0)}ms against a ${restMed.toFixed(0)}ms warm median.`);
    console.log(`  Each trial was a fresh process, so the cost is paid by anything that does not keep connections alive.`);
    console.log(`  The engine is long-lived, so it pays this once per launch, not per turn - which means this does NOT`);
    console.log(`  explain a mid-call 7751ms outlier. Keep looking; do not file this as the answer.`);
  } else if (first > restMed * 1.4) {
    console.log(`  Trial 1 was ${(first / restMed).toFixed(2)}x the warm median. Mild, within the spread the gateway already shows.`);
    console.log(`  Not a per-turn cost and not an explanation for a 7751ms outlier.`);
  } else {
    console.log(`  Trial 1 is unremarkable against the rest. Cold start is NOT the cause of the first-turn outlier.`);
    console.log(`  The outlier needs instrumentation inside the engine, not a cold-start theory.`);
  }
  void ROOT;
})().catch((e) => { console.error("FATAL", e && e.message); process.exit(1); });