/* Localise the 4.3s the gateway adds to a 184ms operation.
 *
 * Three probes, same auth, same server:
 *   A  /api/heartbeat                -> network + TLS + auth + server floor, no AI
 *   B  STT with audio too small to transcribe -> auth + quota + validation, no Groq
 *   C  STT with real audio            -> the full path (measured separately, 4.5s)
 *
 * If A is slow the engine is paying to reach Suga. If A is fast and B is slow,
 * the cost is the quota/DB work. If both are fast, the cost is the Groq call
 * from inside the container.
 *
 *   node build/gateway-breakdown.cjs [wav]
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const WAV = process.argv[2] || path.join(__dirname, "fixtures", "who-is-it.wav");

(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".magicdialer", "config.json"), "utf8"));
  const portal = String(cfg.portalUrl || "").replace(/\/+$/, "");
  const bearer = cfg.deviceToken || cfg.token;
  const auth = { Authorization: "Bearer " + bearer, "Content-Type": "application/json" };

  const time = async (label, fn) => {
    const rows = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      let note;
      try { note = await fn(); } catch (e) { note = "ERR " + String(e.message).slice(0, 40); }
      rows.push({ ms: Date.now() - t0, note });
      await new Promise((r) => setTimeout(r, 400));
    }
    rows.forEach((r, i) => console.log(`  ${label} #${i + 1}  ${String(r.ms).padStart(6)}ms  ${r.note}`));
    const med = rows.map((r) => r.ms).sort((a, b) => a - b)[1];
    console.log(`  ${label} median ${med}ms\n`);
    return med;
  };

  console.log(`portal ${portal}\n`);

  const a = await time("A heartbeat   ", async () => {
    /* The heartbeat route reads the device token from the JSON BODY, not the
     * Authorization header, so putting it only in the header returns a 401 that
     * never opens a database connection. That made this probe measure TLS and
     * routing instead of the database floor, which is what it exists to measure. */
    const r = await fetch(portal + "/api/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceToken: bearer, token: bearer, voipReady: true, sync: null }),
    });
    return `HTTP ${r.status}`;
  });

  const b = await time("B stt tiny    ", async () => {
    const r = await fetch(portal + "/api/engine/ai/stt", {
      method: "POST", headers: auth, body: JSON.stringify({ audio: Buffer.alloc(4).toString("base64") }),
    });
    return `HTTP ${r.status} ${(await r.text()).slice(0, 50)}`;
  });

  const c = await time("C stt realtime", async () => {
    const r = await fetch(portal + "/api/engine/ai/stt", {
      method: "POST", headers: auth, body: JSON.stringify({ audio: fs.readFileSync(WAV).toString("base64") }),
    });
    return `HTTP ${r.status} ${(await r.text()).slice(0, 60)}`;
  });

  console.log("VERDICT");
  if (a > 1500) console.log(`  reaching Suga costs ${a}ms -> the engine cannot get a fast answer from the gateway at all.`);
  else if (b > 1500) console.log(`  auth+quota costs ${b - a}ms -> the quota write is the bottleneck.`);
  else if (c > 1500) console.log(`  auth+quota is fast (${b}ms); the Groq call from inside the container costs ${c - Math.max(a, b)}ms.`);
  else console.log(`  gateway is fast (${c}ms) -> the earlier 4.5s was a transient, re-measure.`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
