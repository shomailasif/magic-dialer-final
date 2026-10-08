/* Why live calls are 9-13s but the offline harness is 2.5-3.4s.
 *
 * The harness falls back to direct Groq because the portal gateway 401s. Live
 * calls go THROUGH that gateway, and the gateway is a single FIFO slot shared
 * with a 3s heartbeat, with its own 4.5s budget and retry. So the same audio is
 * timed on both paths. If the gateway is the cost, this shows it.
 *
 *   node build/stt-path-compare.cjs [wav]
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ROOT = path.join(__dirname, "..", "..", "..");
const WAV = process.argv[2] || path.join(__dirname, "fixtures", "who-is-it.wav");

/* ---- read the 16k fixture, get 8k mono int16 (engine format) ---- */
function readWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("not RIFF");
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + sz);
    if (id === "fmt ") fmt = { ch: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    if (id === "data") data = body;
    off += 8 + sz + (sz & 1);
  }
  if (!fmt || !data) throw new Error("no fmt/data chunk");
  const n = Math.floor(data.length / (fmt.bits / 8) / fmt.ch);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    if (fmt.bits === 16) out[i] = data.readInt16LE(i * 2 * fmt.ch);
    else out[i] = (data[i * fmt.ch] - 128) << 8;
  }
  return { fmt, pcm: out };
}

/* decimate to 8k by simple averaging - fine for a latency A/B */
function to8k(pcm, rate) {
  if (rate === 8000) return pcm;
  const ratio = rate / 8000;
  const n = Math.floor(pcm.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), b = Math.min(pcm.length, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += pcm[j];
    out[i] = s / Math.max(1, b - a);
  }
  return out;
}

/* G.711 mu-law encode - the wire format the engine sends */
function mulaw(pcm) {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const BIAS = 0x84, CLIP = 32635;
    let s = pcm[i] < 0 ? -pcm[i] : pcm[i];
    let p = (s + BIAS) >> 8;
    if (s > CLIP) p = 255;
    if (p >= 255) p = 255;
    else if (p >= 0) p ^= 0x55;
    else p ^= 0x55;
    const x = p ^ 0x80;
    out[i] = ((pcm[i] < 0 ? 0x7f : 0xff) & 0xff) ^ ((x & 0x7f) | 0x80) & 0xff;
    out[i] = p ^ (0x80 | (pcm[i] < 0 ? 0x00 : 0x7f));
    out[i] = (~(pcm[i] < 0 ? 0x55 : 0xd5) & 0x80) | 0x00;
  }
  return out;
}
/* the compact standard encoder */
function mulaw2(pcm) {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const BIAS = 0x84, CLIP = 8159;
    let sign = (pcm[i] >> 8) & 0x80;
    let s = sign ? -pcm[i] : pcm[i];
    if (s > CLIP) s = CLIP;
    s += BIAS;
    let exponent = 7;
    for (let mask = 0x4000; s & mask && exponent > 0; exponent--, mask >>= 1) { /* leading zeros */ }
    const mantissa = (s >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

function wavFromInt16(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length * 2, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length * 2, 40);
  const b = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) b.writeInt16LE(pcm[i], i * 2);
  return Buffer.concat([h, b]);
}

function envKey(name) {
  try {
    const f = path.join(ROOT, ".env");
    const m = fs.readFileSync(f, "utf8").match(new RegExp("^" + name + "=(.+)$", "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
  } catch { return null; }
}

(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".magicdialer", "config.json"), "utf8"));
  const portal = String(cfg.portalUrl || "").replace(/\/+$/, "");
  const bearer = cfg.deviceToken || cfg.token;
  const groqKey = envKey("GROQ_API_KEY");
  if (!portal || !bearer) throw new Error("no portal/bearer in config");
  if (!groqKey) throw new Error("no GROQ_API_KEY in .env");

  const { fmt, pcm } = readWav(fs.readFileSync(WAV));
  const pcm8 = to8k(pcm, fmt.rate);
  const ml = mulaw2(pcm8);
  const wav = wavFromInt16(pcm, fmt.rate);

  console.log(`fixture      : ${path.basename(WAV)}  ${(pcm.length / fmt.rate).toFixed(2)}s @${fmt.rate}Hz`);
  console.log(`engine bytes : ${ml.length} (mu-law 8k)`);
  console.log(`groq  bytes  : ${wav.length} (wav ${fmt.rate}Hz)\n`);

  const time = async (label, fn) => {
    const t0 = Date.now();
    try {
      const r = await fn();
      const ms = Date.now() - t0;
      console.log(`${label.padEnd(22)} ${String(ms).padStart(6)}ms  ${r}`);
      return ms;
    } catch (e) {
      const ms = Date.now() - t0;
      console.log(`${label.padEnd(22)} ${String(ms).padStart(6)}ms  ERROR ${String(e.message).slice(0, 70)}`);
      return ms;
    }
  };

  console.log("--- via PORTAL GATEWAY (what live calls use) ---");
  const gw = [];
  for (let i = 0; i < 3; i++) {
    gw.push(await time(`gateway attempt ${i + 1}`, async () => {
      const r = await fetch(portal + "/api/engine/ai/stt", {
        method: "POST",
        headers: { Authorization: "Bearer " + bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ audio: ml.toString("base64") }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`HTTP ${r.status} ${JSON.stringify(j).slice(0, 60)}`);
      return `ok text="${String(j.text || "").slice(0, 40)}"`;
    }));
  }

  console.log("\n--- DIRECT to GROQ (what the offline harness uses) ---");
  const dir = [];
  for (let i = 0; i < 3; i++) {
    dir.push(await time(`direct attempt ${i + 1}`, async () => {
      const fd = new FormData();
      fd.append("file", new Blob([wav], { type: "audio/wav" }), "a.wav");
      fd.append("model", "whisper-large-v3-turbo");
      fd.append("response_format", "json");
      const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST", headers: { Authorization: "Bearer " + groqKey }, body: fd,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`HTTP ${r.status} ${JSON.stringify(j).slice(0, 60)}`);
      return `ok text="${String(j.text || "").slice(0, 40)}"`;
    }));
  }

  const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const g = med(gw), d = med(dir);
  console.log(`\nmedian gateway ${g}ms   median direct ${d}ms   gateway overhead ${g - d}ms`);
  console.log(g - d > 800 ? "\nCONFIRMED: the gateway is the latency." : "\nGateway overhead is small; latency is elsewhere.");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
