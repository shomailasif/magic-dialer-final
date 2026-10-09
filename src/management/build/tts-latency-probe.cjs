/* TTS is now the largest single stage in a turn (1.0-2.3s measured). Is that the
 * websocket handshake or the synthesis itself? The engine opens a fresh
 * wss://speech.platform.bing.com connection per turn, so if the handshake is the
 * cost it can be opened concurrently with the brain call and taken off the
 * critical path entirely.
 *
 *   node build/tts-latency-probe.cjs
 */
"use strict";
const path = require("node:path");
const voice = require(path.join(__dirname, "..", "agent", "voice.js"));

const LINES = [
  "Who is it?",
  "Sorry, I did not catch that.",
  "Is now a good time for a quick call?",
  "This is Atlas with Zaz Logistics. What can I help you with today?",
];

(async () => {
  console.log("cold first call (includes module init):");
  let t0 = Date.now();
  const first = await voice.speakToBuffer(LINES[0], { locale: "en", style: "friendly" });
  console.log(`  ${LINES[0].length} chars -> ${Date.now() - t0}ms engine=${first && first.engine} bytes=${first && first.buffer.length}\n`);

  console.log("same line repeated (no cache exists today, so this is pure handshake+synthesis):");
  for (let i = 0; i < 3; i++) {
    t0 = Date.now();
    const r = await voice.speakToBuffer(LINES[0], { locale: "en", style: "friendly" });
    console.log(`  run ${i + 1}: ${Date.now() - t0}ms engine=${r && r.engine}`);
  }

  console.log("\nby line length:");
  for (const l of LINES) {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      t0 = Date.now();
      await voice.speakToBuffer(l, { locale: "en", style: "friendly" });
      runs.push(Date.now() - t0);
    }
    runs.sort((a, b) => a - b);
    console.log(`  ${String(runs[1]).padStart(5)}ms median  ${String(l.length).padStart(3)} chars  "${l.slice(0, 46)}"`);
  }

  console.log("\nIf the first run of a repeated line is no faster than the rest,");
  console.log("there is no cache and every turn pays full cost. If a warm socket");
  console.log("helps, pre-warming during the brain call is worth its weight.");
})().catch((e) => { console.error("FATAL", e && e.message); process.exit(1); });