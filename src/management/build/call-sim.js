/* Internal call simulator.
 *
 * The prospect is unavailable, so conversation quality is verified by driving the
 * REAL conversation loop (call-runner -> real AI brain) against scripted
 * prospect behaviour. No SIP, no audio, no dial - but the same code that runs on
 * a live call decides the turns, the language and the ending.
 *
 *   node build/call-sim.js <scenario> [--verbose]
 *
 * Scenarios model the behaviours that were reported as broken:
 *   checklist   a real prospect who answers, and notices being re-asked
 *   greetings   greets repeatedly, must not trigger a second introduction
 *   noisy-locale  mixes short clips in other scripts, must not drag the call off
 *                 the configured language
 *   all         every scenario
 */
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const MGMT = path.join(__dirname, "..");
const { runCall } = require(path.join(MGMT, "agent", "call-runner.js"));
const { MAX_TURN_CHARS, MAX_TURN_OVERSHOOT } = require(path.join(MGMT, "agent", "turn-length.js"));

const VERBOSE = process.argv.includes("--verbose");

/* Real gateway credentials, so the simulator exercises the live brain and not
 * the offline fallback. Falls back to direct Groq if the agent has a key. */
function loadLiveConfig() {
  const file = path.join(process.env.USERPROFILE || os.homedir(), ".magicdialer", "config.json");
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    return { portal: c.portalUrl || null, deviceToken: c.deviceToken || null };
  } catch { return { portal: null, deviceToken: null }; }
}
const LIVE = loadLiveConfig();

/* The real configuration the live agent uses, read from the agent's own config
 * so the simulation cannot drift from production. */
const CONFIG = (() => {
  const base = { product: "Dispatch Services for trucks", companyName: "Zaz Logistics", persona: "Atlas", leadFields: [], callbackNumber: null, callbackIn: null, contactEmail: "sa@zazlogistics.com" };
  try {
    const f = path.join(process.env.USERPROFILE || os.homedir(), ".magicdialer", "config.json");
    const c = JSON.parse(fs.readFileSync(f, "utf8"));
    return {
      ...base,
      product: c.product || base.product,
      companyName: c.companyName || base.companyName,
      persona: c.persona || base.persona,
      leadFields: Array.isArray(c.leadFields) ? c.leadFields : base.leadFields,
      callbackNumber: c.callbackNumber || null,
      callbackIn: c.callbackIn || null,
      contactEmail: c.contactEmail || null,
    };
  } catch { return base; }
})();

/* ---------- scripted prospects ---------- */
const SCENARIOS = {
  // Answers what it is asked, and gets annoyed at being asked twice.
  checklist: [
    { text: "Hello?", language: "en" },
    { text: "My name is Raj.", language: "en" },
    { text: "I drive a three wheeler, not a big truck.", language: "en" },
    { text: "Sure, my number is this one, you already have it.", language: "en" },
    { text: "My biggest problem is empty return trips.", language: "en" },
    { text: "That is all I needed, thanks.", language: "en" },
  ],
  // Greets over and over; the agent must greet back, not re-pitch.
  greetings: [
    { text: "Hello?", language: "en" },
    { text: "Hello, are you there?", language: "en" },
    { text: "Yes, hello.", language: "en" },
    { text: "Go ahead.", language: "en" },
    { text: "Okay, tell me about the service.", language: "en" },
    { text: "Thanks, that is all.", language: "en" },
  ],
  // Short noisy clips in other scripts, the way Whisper mislabels them.
  "noisy-locale": [
    { text: "Hello?", language: "en" },
    { text: "ہاں", language: "ur" },
    { text: "हां", language: "hi" },
    { text: "Yes, go ahead please.", language: "en" },
    { text: "Tell me about pricing for a small fleet.", language: "en" },
    { text: "That works, thank you.", language: "en" },
  ],
};

/* ---------- verdict ---------- */
function grade(name, script, out, spoken) {
  const problems = [];
  const agentLines = out.transcript.filter(t => t.role === "agent").map(t => t.text);
  const last = agentLines[agentLines.length - 1] || "";

  // 1. must close properly
  if (!/thank|goodbye|have a (great|good) (day|evening)|bye/i.test(last)) {
    problems.push(`no closing on the final turn: ${JSON.stringify(last)}`);
  }
  // 2. must not repeat the introduction after the prospect already greeted
  const intros = agentLines.filter(l => /this is (atlas|autumn)|calling from|calling about/i.test(l));
  if (intros.length > 1) problems.push(`re-introduced the company ${intros.length} times`);
  // 3. must not ask the same thing over and over
  const asks = { name: 0, phone: 0, mcn: 0 };
  for (const l of agentLines) {
    if (/\byour name\b|\bwhat('s| is) your name\b/i.test(l)) asks.name++;
    if (/phone number|best number|reach you at|email address/i.test(l)) asks.phone++;
    if (/\bMC number\b|\bmc number\b/i.test(l)) asks.mcn++;
  }
  for (const [k, v] of Object.entries(asks)) {
    if (v > 2) problems.push(`asked for the ${k} ${v} times`);
  }
  // 4. must not stack questions
  const stacked = agentLines.filter(l => (l.match(/\?/g) || []).length > 2);
  if (stacked.length) problems.push(`${stacked.length} turn(s) stacked more than two questions`);
  // 5. must not run a checklist: too many distinct "ask" turns back to back
  let askRun = 0, worstRun = 0;
  for (const l of agentLines) {
    if (/\?/.test(l) && /(could|can|may|would) (i|you|we)|what|how much|which|do you|share|provide|confirm|tell me/i.test(l)) {
      askRun++; worstRun = Math.max(worstRun, askRun);
    } else askRun = 0;
  }
  if (worstRun >= 4) problems.push(`ran ${worstRun} consecutive question turns without reacting`);
  // 6. must not mirror a script the call is not configured for
  const nonLatin = out.transcript.filter(t => {
    const letters = String(t.text || "").replace(/[^\p{L}\p{N}]/gu, "");
    if (letters.length < 4) return false;
    const n = (letters.match(/\p{Script=Arabic}|\p{Script=Devanagari}|\p{Script=Han}|\p{Script=Cyrillic}|\p{Script=Greek}|\p{Script=Hebrew}/gu) || []).length;
    return n / letters.length > 0.3;
  });
  if (nonLatin.length) problems.push(`replied in a non-Latin script ${nonLatin.length} time(s) on an en call`);
  if (out.locale !== "en") problems.push(`call locale drifted to ${out.locale}`);
  // 7. turn length (the prepared opening is exempt; the controller caps the rest)
  const body = agentLines.slice(1);
  const budget = MAX_TURN_CHARS + MAX_TURN_OVERSHOOT;
  const longTurns = body.filter(l => l.length > budget);
  if (longTurns.length) problems.push(`${longTurns.length} body turn(s) over the ${budget} char budget: ${JSON.stringify(longTurns[0].slice(0, 60))}`);
  // A turn must not end mid-thought: that is what a dropped line sounds like.
  const dangling = body.filter(l => l.length > 25 && !/[.!?]["')\u2019]?$/.test(l.trim()));
  if (dangling.length) problems.push(`${dangling.length} turn(s) end mid-sentence: ${JSON.stringify(dangling[0].slice(-50))}`);
  // 8. must not end by itself mid-flow without the prospect being done
  if (spoken.length > 20) problems.push(`ran ${spoken.length} turns, hit the runaway bound`);

  // 9. must never sound like an inbound receptionist on a call we placed
  const inbound = agentLines.filter(l => /how can i (help|assist) you|what can i (help|assist) you with|thanks for reaching out|how may i direct your call/i.test(l));
  if (inbound.length) problems.push(`${inbound.length} inbound-receptionist turn(s): ${JSON.stringify(inbound[0].slice(0, 60))}`);

  // 0. The brain must actually be reachable. A canned fallback turn means the
  //    gateway failed, and a 3-turn canned call must never read as a pass.
  const canned = agentLines.filter(l => /rather than guess|I will note it for (the team )?follow-up|Hello\? I just want to make sure/i.test(l));
  if (canned.length) {
    problems.push(`AI brain unavailable: ${canned.length} canned fallback turn(s) - this run proves nothing`);
    return { name, problems, agentLines, locale: out.locale };
  }
  if (agentLines.length < 5) {
    problems.push(`call ended after only ${agentLines.length} turns - the conversation never got going`);
    return { name, problems, agentLines, locale: out.locale };
  }

  return { name, problems, agentLines, locale: out.locale };
}

async function run(name) {
  const script = SCENARIOS[name];
  const spoken = [];
  let i = 0;
  const listen = async () => {
    if (i >= script.length) return { ended: true, text: null };
    const turn = script[i++];
    return { text: turn.text, language: turn.language, waitedMs: 4000 };
  };
  const speak = async (line) => { spoken.push(String(line)); };
  const out = await runCall({ ...CONFIG, locale: "en", learning: null, portal: LIVE.portal, deviceToken: LIVE.deviceToken, callId: `sim-${name}`, speak, listen });
  return grade(name, script, out, spoken);
}

async function main() {
  const want = process.argv[2] && process.argv[2] !== "--verbose" ? process.argv[2] : "all";
  const names = want === "all" ? Object.keys(SCENARIOS) : [want];
  let failed = 0;
  for (const n of names) {
    if (!SCENARIOS[n]) { console.error(`unknown scenario ${n}`); process.exit(2); }
    const r = await run(n);
    console.log(`\n=== scenario: ${n} ===`);
    if (VERBOSE) {
      console.log(`  spoken ${r.agentLines.length} turns, locale=${r.locale}`);
      r.agentLines.forEach((l, k) => console.log(`   ${String(k + 1).padStart(2)}. ${l}`));
    }
    if (r.problems.length) {
      failed++;
      console.log(`  FAIL`);
      for (const p of r.problems) console.log(`    - ${p}`);
    } else {
      console.log(`  PASS (${r.agentLines.length} turns, locale=${r.locale})`);
    }
    // The AI gateway rate-limits bursts. A live call makes one brain call every
    // few seconds; the simulator would otherwise fire them back to back and get
    // throttled, which looks exactly like a broken brain.
    if (n !== names[names.length - 1]) await new Promise((r2) => setTimeout(r2, Number(process.env.SIM_GAP_MS) || 45000));
  }
  console.log(failed ? `\n${failed} scenario(s) FAILED` : "\nall simulated calls PASS");
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
