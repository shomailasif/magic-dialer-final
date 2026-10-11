/* End-to-end proof of what item 1 actually delivers, measured honestly.
 *
 * Runs the engine's OWN transcribeAuto and nextTurn against the real provider,
 * both ways, on the same fixture:
 *
 *   gateway only   no local key - what every install does today
 *   direct first   a local key present - what item 1 turns on
 *
 * TWO HARNESS TRAPS THIS FILE EXISTS TO AVOID
 *
 * 1. The two paths must not run in the same process with a mutable key.
 *    providerKey() reads GROQ_API_KEY from the environment first, so clearing the
 *    on-disk store does NOT produce a gateway-only install - the environment still
 *    supplies a key and the "baseline" silently takes the direct path too. The
 *    first version of this file did exactly that and reported a direct-vs-direct
 *    comparison as if it were direct-vs-gateway. Each phase now runs in its own
 *    child process with its own environment, which is the only way the baseline
 *    can be real.
 *
 * 2. A direct path that silently falls back is not a direct measurement. When the
 *    engine falls back it says so, and the fallback leg is timed and reported as
 *    what it is. A run where the direct path failed is reported as a failed
 *    measurement, not as a saving.
 *
 * The key is read from the environment, never written to disk, never printed.
 *
 *   node build/direct-path-verify.cjs [rounds]
 */
"use strict";
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const ROUNDS = Number(process.argv[2] || 4);
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];

/* ---------------- child: one phase, one environment ---------------- */
if (process.env.MD_VERIFY_CHILD === "1") {
  const mode = process.env.MD_VERIFY_MODE; // "gateway" | "direct"
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "md-verify-"));
  process.env.AUTODIAL_HOME = home;
  /* The only way to get a genuine gateway-only install. */
  if (mode === "gateway") {
    delete process.env.GROQ_API_KEY;
    delete process.env.AUTODIAL_GROQ_KEY;
    delete process.env.AUTODIAL_PROVIDER_KEY;
  }

  const agentDir = path.join(__dirname, "..", "agent");
  const stt = require(path.join(agentDir, "multilingual-stt.js"));
  const brain = require(path.join(agentDir, "intelligent-brain.js"));
  const audio = require("./probe-audio.cjs").engineAudio(path.join(__dirname, "fixtures", "who-is-it.wav"));

  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".magicdialer", "config.json"), "utf8"));
  const portal = String(cfg.portalUrl || "").replace(/\/+$/, "");
  const deviceToken = cfg.deviceToken || cfg.token;
  const rounds = Number(process.env.MD_VERIFY_ROUNDS || 4);

  (async () => {
    const sttRows = [];
    for (let i = 0; i < rounds; i++) {
      const t0 = Date.now();
      const r = await stt.transcribeAuto(audio, { hint: "auto", portal, deviceToken, callId: "verify" });
      sttRows.push({ ms: Date.now() - t0, text: r.text, path: r.path, error: r.error || null, directError: r.directError || null });
      await new Promise((s) => setTimeout(s, 250));
    }
    const brainRows = [];
    /* The gap matters and was wrong at first. Brain requests 250ms apart are not
     * a conversation - they are a load test - and the provider answers them with
     * HTTP 429, which is then indistinguishable from "the direct path is broken".
     * A live turn is seconds apart, so the probe paces like one. STT is not paced
     * this way because a real call can genuinely produce two transcriptions back
     * to back (the speculative pass and the re-transcription after a hold). */
    const BRAIN_GAP_MS = Number(process.env.MD_VERIFY_BRAIN_GAP_MS || 3000);
    for (let i = 0; i < rounds; i++) {
      const t0 = Date.now();
      const r = await brain.nextTurn({
        transcript: [{ role: "prospect", text: "Who is it?" }],
        portal, deviceToken, callId: "verify",
        companyName: "Zaz Logistics", product: "Dispatch Services", persona: "Atlas", locale: "en",
      });
      brainRows.push({ ms: Date.now() - t0, text: String(r.text || "").slice(0, 34), path: r.path, error: r.error || null, directError: r.directError || null });
      await new Promise((s) => setTimeout(s, BRAIN_GAP_MS));
    }
  /* The child logs to stdout as it goes - "[brain] AI gateway unavailable..." is
   * real output from the code under test, and a probe that cannot tell its own
   * measurements from the code's logging will eventually parse a log line as data.
   * The result is wrapped in sentinels and extracted from between them. */
  const BEGIN = "<<<VERIFY_JSON";
  const END = "VERIFY_JSON>>>";
  process.stdout.write(BEGIN);
  process.stdout.write(JSON.stringify({ mode, sttRows, brainRows }));
  process.stdout.write(END);
  fs.rmSync(home, { recursive: true, force: true });
  })().catch((e) => { process.stdout.write(BEGIN + JSON.stringify({ mode, fatal: String(e && e.message) }) + END); });
  return;
}

/* ---------------- parent: run both phases, compare, and be honest ---------------- */
function runPhase(mode, rounds) {
  const env = { ...process.env, MD_VERIFY_CHILD: "1", MD_VERIFY_MODE: mode, MD_VERIFY_ROUNDS: String(rounds) };
  const out = execFileSync(process.execPath, [__filename, String(rounds)], {
    env, encoding: "utf8", timeout: 900000, stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 32 * 1024 * 1024,
  });
  /* Take only what the child wrapped, and surface anything it logged in between. */
  const m = out.match(/<<<VERIFY_JSON([\s\S]*?)VERIFY_JSON>>>/);
  if (!m) throw new Error(`phase ${mode} produced no result envelope. child output:\n${out.slice(0, 800)}`);
  const noise = out.replace(/<<<VERIFY_JSON[\s\S]*?VERIFY_JSON>>>/, "").trim();
  if (noise) console.log(`  (${mode} phase logged: ${noise.split("\n").length} line(s))`);
  return JSON.parse(m[1]);
}

function report(phase, kind) {
  const rows = kind === "stt" ? phase.sttRows : phase.brainRows;
  console.log(`\n--- ${kind.toUpperCase()}  mode=${phase.mode} ---`);
  for (const r of rows) {
    const note = r.error ? `ERR ${String(r.error).slice(0, 40)}` : JSON.stringify(r.text).slice(0, 40);
    const fell = r.path === "gateway-fallback" ? `  <- direct failed: ${String(r.directError).slice(0, 40)}` : "";
    console.log(`  ${String(r.ms).padStart(6)}ms  ${String(r.path || "-").padEnd(17)} ${note}${fell}`);
  }
  const m = med(rows.map((r) => r.ms));
  console.log(`  median ${m}ms`);
  return m;
}

function fallbacks(phase, kind) {
  const rows = kind === "stt" ? phase.sttRows : phase.brainRows;
  return rows.filter((r) => r.path === "gateway-fallback").length;
}

function failures(phase, kind) {
  const rows = kind === "stt" ? phase.sttRows : phase.brainRows;
  return rows.filter((r) => r.error).length;
}

if (!process.env.GROQ_API_KEY && !process.env.AUTODIAL_GROQ_KEY) {
  console.log("set GROQ_API_KEY in the environment first - it is used by the direct phase only and never written to disk");
  process.exit(2);
}

console.log(`item 1 measured end to end through the engine's own code`);
console.log(`${ROUNDS} rounds per path per stage, one fresh process per phase, real mu-law audio\n`);

const gw = runPhase("gateway", ROUNDS);
const dr = runPhase("direct", ROUNDS);
if (gw.fatal || dr.fatal) { console.error("phase failed: " + (gw.fatal || dr.fatal)); process.exit(1); }

const sGw = report(gw, "stt"), sDr = report(dr, "stt");
const bGw = report(gw, "brain"), bDr = report(dr, "brain");

/* A phase that took the wrong path invalidates the whole comparison. This is the
 * check the first version of this file could not make, and it is the one that
 * would have caught its own nonsense. */
const gwPurity = gw.sttRows.every((r) => r.path === "gateway") && gw.brainRows.every((r) => r.path !== "direct");
if (!gwPurity) {
  console.log("\nVERDICT: INVALID RUN. The gateway baseline was not gateway-only, so nothing here can be compared.");
  process.exit(1);
}

const dirFallbacks = fallbacks(dr, "stt") + fallbacks(dr, "brain");
const anyErrors = failures(dr, "stt") + failures(dr, "brain");
const turnGw = sGw + bGw, turnDr = sDr + bDr;

console.log("\nRESULT");
console.log(`  STT    gateway ${sGw}ms  ->  direct ${sDr}ms   saved ${sGw - sDr}ms`);
console.log(`  BRAIN  gateway ${bGw}ms  ->  direct ${bDr}ms   saved ${bGw - bDr}ms`);
console.log(`  TURN   gateway ${turnGw}ms  ->  direct ${turnDr}ms   saved ${turnGw - turnDr}ms`);
console.log(`  direct-path fallbacks to the gateway: ${dirFallbacks} of ${ROUNDS * 2}`);
console.log("");

if (anyErrors) {
  console.log(`  VERDICT: ${anyErrors} direct calls returned an error. That is a fault to diagnose, not a speed result.`);
  process.exit(1);
}
if (dirFallbacks) {
  console.log(`  VERDICT: ${dirFallbacks} of ${ROUNDS * 2} direct calls fell back, so the direct medians above are not`);
  console.log("  direct measurements. The safety net worked - that is what it is for - but find out why the");
  console.log("  provider failed before quoting any saving from this run.");
  process.exit(1);
}
if (turnGw - turnDr < 200) {
  console.log("  VERDICT: the saving is inside the noise. Do not build a claim on this run.");
} else {
  console.log(`  VERDICT: real, clean saving of ~${turnGw - turnDr}ms per turn.`);
}