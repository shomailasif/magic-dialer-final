/*
 * diagnose-tts.js - Trace the EXACT production TTS chain and report where audio dies.
 *
 * Run:  node diagnose-tts.js
 *
 * It exercises the same code paths as src/lib/sip-conversation.ts:
 *   1. Google Translate TTS HTTP fetch      (GUARD_GOOGLE_TTS_CLIENT = dict-chrome-ex)
 *   2. content-type must contain "audio"    (else HTML/CAPTCHA => silence)
 *   3. MP3 decode via mpg123-decoder        (loaded via createRequire, like production)
 *   4. mu-law encode into 160-byte frames   (what streamAudio() sends over RTP)
 *
 * Writes:  tts-diagnose-google.mp3, tts-diagnose-google.raw (PCMU frames as
 * produced for streamAudio), tts-diagnose-google.wav (playable). If the .wav
 * holds audible speech, the TTS chain is fine locally and the failure is on
 * the server (network/CAPTCHA/bundle). If it holds tone/silence, the chain
 * itself is broken.
 */
"use strict";
const { createRequire } = require("module");
const path = require("path");
const fs = require("fs");
const crypto = require("node:crypto");

const OUTDIR = path.join(__dirname, ".tts-diag");
fs.mkdirSync(OUTDIR, { recursive: true });

const RATE = 8000;
const FRAME = 160;
const ULAW_SEG_END = [0x0ff, 0x1ff, 0x3ff, 0x7ff, 0x0fff, 0x1fff, 0x3fff, 0x7fff];

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  process.stdout.write(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? "  -- " + detail : ""}\n`);
  ok ? pass++ : fail++;
}

function ulawEncode(sample) {
  let s = sample | 0;
  const sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > 32767) s = 32767;
  s += 0x84;
  let e = 0;
  while (e < 8 && s > ULAW_SEG_END[e]) e++;
  let b;
  if (e === 8) b = 0x7f;
  else { const mant = (s >> (e + 3)) & 0x0f; b = (e << 4) | mant; }
  b |= sign;
  return b ^ 0xff;
}

function toUlawFrames(pcm16) {
  const frames = [];
  const n = pcm16.length;
  for (let off = 0; off < n; off += FRAME) {
    const end = Math.min(off + FRAME, n);
    const b = Buffer.alloc(FRAME);
    for (let i = off; i < end; i++) b[i - off] = ulawEncode(pcm16[i]);
    frames.push(b);
  }
  return frames;
}

function pcm16ToWav(buf, rate = RATE) {
  const n = buf.length;
  const wav = Buffer.alloc(44 + n);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + n, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(n, 40);
  buf.copy(wav, 44);
  return wav;
}

// mu-law silence byte is 0xFF; "energy" here = how far from silence per frame.
function frameStats(raw) {
  const frames = Math.floor(raw.length / FRAME);
  let nonSilent = 0;
  let maxDev = 0;
  for (let f = 0; f < frames; f++) {
    let dev = 0;
    for (let i = 0; i < FRAME; i++) dev += raw[f * FRAME + i] !== 0xff ? 1 : 0;
    if (dev > 0) nonSilent++;
    if (dev > maxDev) maxDev = dev;
  }
  return { frames, nonSilent, maxDevPerFrame: maxDev };
}

console.log("\n=== diagnose-tts.js — production TTS chain trace ===\n");

// ---------------------------------------------------------------- env / deps
console.log("1. Environment");
const nodeVer = process.versions.node;
check("Node version", parseFloat(nodeVer) >= 20, "node " + nodeVer + (parseFloat(nodeVer) >= 22.12 ? " (require-ESM OK)" : " (require-ESM NOT guaranteed)"));

let mpg = null;
let mpgErr = null;
try {
  // Exact production load path: createRequire from src/lib like sip-conversation.ts
  const shim = createRequire(path.join(__dirname, "src", "lib", "sip-conversation.ts"));
  mpg = shim("mpg123-decoder");
} catch (e) { mpgErr = e && e.message; }
check("mpg123-decoder loads", !!mpg, mpgErr || (typeof mpg === "function" ? "function" : typeof mpg));
check("MPEGDecoder exported", !!(mpg && mpg.MPEGDecoder), mpgErr || (mpg && mpg.MPEGDecoder ? "yes" : "NO"));

let ws = null;
let wsErr = null;
try { ws = require("ws"); } catch (e) { wsErr = e && e.message; }
check("ws loads", !!ws, wsErr || "ok");

// ---------------------------------------------------------------- Google TTS
const TEXT = "Hi there! Thanks for picking up. How are you doing today?";
const CLIENTS = ["dict-chrome-ex", "tw-ob", "gtx"];

console.log("\n2. Google Translate TTS (HTTP)");
let googleBuf = null;
let googleCtype = null;
let googleStatus = null;
let googleClientUsed = null;
let googleErr = null;

(async () => {
  for (const client of CLIENTS) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=${client}&q=${encodeURIComponent(TEXT)}`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win6; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          "Referer": "https://translate.google.com/",
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const ct = resp.headers.get("content-type") || "";
      const arr = Buffer.from(await resp.arrayBuffer());
      console.log(`      client=${client}  status=${resp.status}  content-type=${ct || "(none)"}  bytes=${arr.length}`);
      if (resp.ok && ct.includes("audio") && arr.length > 100) {
        googleBuf = arr; googleCtype = ct; googleStatus = resp.status; googleClientUsed = client;
        break;
      }
      const head = arr.subarray(0, 60).toString("latin1").replace(/[^\x20-\x7e]/g, ".");
      console.log(`        (rejected - head: ${head.slice(0, 60)})`);
    } catch (e) { console.log(`      client=${client}  ERROR ${e && e.message}`); }
  }

  check("Google TTS returns audio", !!googleBuf, googleErr || (googleStatus + " " + googleCtype + " " + (googleBuf ? googleBuf.length + " bytes" : "NO AUDIO")) + " via " + googleClientUsed);
  if (googleBuf && googleClientUsed !== "dict-chrome-ex") {
    console.warn("      NOTE: production pins client=dict-chrome-ex (GUARD_GOOGLE_TTS_CLIENT). If only a different client works, the guard must change.");
  }

  // ---------------------------------------------------------------- decode
  console.log("\n3. MP3 decode (mpg123-decoder)");
  let pcm = null;
  if (googleBuf) {
    fs.writeFileSync(path.join(OUTDIR, "google.mp3"), googleBuf);
    if (mpg && mpg.MPEGDecoder) {
      try {
        const enc = Buffer.from(googleBuf).toString("base64");
        process.stdout.write("      decoding " + googleBuf.length + " bytes...");
        const dec = new mpg.MPEGDecoder();
        if (dec.ready) await dec.ready;
        const r = dec.decode(new Uint8Array(googleBuf));
        dec.free();
        if (r && r.channelData && r.channelData.length) {
          const channels = r.channelData.length;
          const rate = Number(r.sampleRate) || 8000;
          const mono = new Float64Array(r.samplesDecoded);
          for (let i = 0; i < mono.length; i++) {
            let acc = 0;
            for (let ch = 0; ch < channels; ch++) acc += r.channelData[ch][i] || 0;
            mono[i] = (acc / channels) * 32767;
          }
          let p = Int16Array.from(mono, (v) => Math.max(-32768, Math.min(32767, Math.round(v))));
          if (rate !== RATE) {
            const out = new Int16Array(Math.ceil((p.length * RATE) / rate));
            const step = rate / RATE;
            for (let i = 0; i < out.length; i++) {
              const s = Math.floor(i * step);
              const e = Math.min(p.length, Math.max(s + 1, Math.ceil((i + 1) * step)));
              let a = 0;
              for (let j = s; j < e; j++) a += p[j];
              out[i] = Math.max(-32768, Math.min(32767, Math.round(a / (e - s))));
            }
            p = out;
          }
          pcm = p;
          console.log(` ok - samples=${pcm.length} rate=${rate} channels=${channels}`);
        } else {
          console.log(" FAIL - decoder returned no channelData");
        }
      } catch (e) {
        console.log(" FAIL - " + (e && e.message));
      }
    }
  }
  // a purely empty / silent PCM decode check
  if (pcm) {
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 16) { const v = Math.abs(pcm[i]); if (v > peak) peak = v; }
    check("PCM has audible peaks", peak > 500, "peak=" + peak + " samples=" + pcm.length + " sec=" + (pcm.length / RATE).toFixed(2));
  } else {
    check("PCM has audible peaks", false, "no decoded PCM");
  }

  // ---------------------------------------------------------------- ulaw frames
  console.log("\n4. mu-law frames (exactly what streamAudio() sends)");
  let raw = null;
  if (pcm) {
    const frames = toUlawFrames(pcm);
    raw = Buffer.concat(frames);
    const st = frameStats(raw);
    fs.writeFileSync(path.join(OUTDIR, "google.ulaw.raw"), raw);
    fs.writeFileSync(path.join(OUTDIR, "google.wav"), pcm16ToWav(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)));
    check("Generate frames", frames.length > 0, frames.length + " frames / " + st.nonSilent + " non-silent / max " + st.maxDevPerFrame + " active bytes per frame");
  }
  // streamAudio expects 160-byte PCMU frames every 20ms.
  if (raw) {
    const frac = raw.length % FRAME;
    check("Frame-size aligned (streamAudio-compatible)", frac === 0, frac === 0 ? raw.length + " bytes (" + Math.floor(raw.length / 160) + " frames)" : "trailing " + frac + " bytes would be dropped");
  }

  // ---------------------------------------------------------------- tone fallback
  console.log("\n5. Tone fallback path (current production code)");
  const toneBuf = Buffer.alloc(1600);
  for (let i = 0; i < toneBuf.length; i++) {
    toneBuf[i] = ((Math.sin((2 * Math.PI * 440 * i) / 8000) * 4000) | 0) ^ 0xff;
  }
  const isRiff = toneBuf.toString("ascii", 0, 4) === "RIFF";
  const isMp3 = toneBuf[0] === 0xff && (toneBuf[1] & 0xe0) === 0xe0;
  check("Tone has RIFF header", isRiff, "tone is raw ulaw, NOT a WAV");
  check("Tone looks like MP3", isMp3, "tone is raw ulaw, NOT MP3");
  console.warn("      BUG: fallback emits pre-encoded ulaw bytes but the code feeds them to wavToPcm16()/mpg123-decoder().");
  console.warn("      Both reject raw ulaw => the tone fallback ALWAYS produces [] frames => silence when TTS fails.");
  console.warn("      Fix: push tone bytes directly as frames (skip decode).");

  // ---------------------------------------------------------------- verdict
  console.log("\n=== RESULT: " + pass + " passed, " + fail + " failed ===");
  console.log("Files written to: " + OUTDIR);
  if (googleBuf) console.log("  - google.mp3        raw TTS mp3 (play with any player)");
  if (pcm) console.log("  - google.wav         decoded PCM as WAV (play: confirms spoken audio)");
  if (raw) console.log("  - google.ulaw.raw    raw 8kHz mu-law frames exactly as streamAudio() would send");
  if (!googleBuf) {
    console.error("\n>>> DIAGNOSIS: Google TTS returned no audio on THIS machine. If it also fails on Suga, the AI voice is silent because every TTS path dies and the broken tone fallback produces nothing.");
  } else if (pcm) {
    console.log("\n>>> DIAGNOSIS: TTS chain WORKS locally. Silence on Suga means the server can't reach translate.google.com (blocked), or mpg123-decoder/webassembly is missing from the serverless bundle. Deploy+run this same script on Suga to confirm.");
  } else {
    console.error("\n>>> DIAGNOSIS: Google TTS delivered audio but the decode step failed locally. Same likely on Suga => silence. Check mpg123-decoder load in the serverless bundle (it is ESM-only; require() may throw).");
  }
  process.exit(fail > 0 ? 1 : 0);
})();