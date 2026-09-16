#!/usr/bin/env node
/**
 * Full TTS + SIP audio pipeline diagnostic.
 * Run locally:  node test-suga-diag.js
 * Or deploy and hit: GET /api/diagnose-full
 *
 * Tests:
 *   1. Google TTS fetch
 *   2. mpg123-decoder
 *   3. wavToPcm16 (WAV path)
 *   4. ulawEncode + frame generation
 *   5. softphone module loading
 *   6. Creates a dummy callSession to test streamAudio exists
 */

const { createRequire } = require("module");
const path = require("path");
const fs = require("fs");
const runtimeRequire = createRequire(path.join(process.cwd(), "src", "lib", "sip-conversation.ts"));

const GUARD_GOOGLE_TTS_CLIENT = "dict-chrome-ex";
const RATE = 8000;
const FRAME = 160;
const ULAW_SEG_END = [0x0ff, 0x1ff, 0x3ff, 0x7ff, 0x0fff, 0x1fff, 0x3fff, 0x7fff];
const TEXT = "Hi there! Thanks for picking up. How are you doing today?";

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

function wavToPcm16(buf) {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return null;
  let offset = 12;
  let fmt = null, dataOffset = 0, dataSize = 0;
  while (offset < buf.length - 8) {
    const id = buf.toString("ascii", offset, offset + 4);
    const sz = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") fmt = { sampleRate: buf.readUInt32LE(offset + 12), channels: buf.readUInt16LE(offset + 10), bitsPerSample: buf.readUInt16LE(offset + 22) };
    else if (id === "data") { dataOffset = offset + 8; dataSize = sz; break; }
    offset += 8 + sz;
  }
  if (!fmt || !dataOffset) return null;
  const raw = buf.subarray(dataOffset, dataOffset + dataSize);
  let pcm;
  if (fmt.bitsPerSample === 16) pcm = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
  else if (fmt.bitsPerSample === 8) pcm = Int16Array.from(raw, (v) => (v - 128) << 8);
  else return null;
  return pcm;
}

const results = [];
function log(level, name, detail) {
  results.push({ level, name, detail });
  const icon = level === "pass" ? "OK" : level === "fail" ? "FAIL" : level === "warn" ? "WARN" : "INFO";
  console.log(`  [${icon}] ${name}: ${detail}`);
}

async function main() {
  console.log("=== Full TTS + SIP Pipeline Diagnostic ===\n");

  // --- 1. Environment ---
  log("info", "node", process.versions.node);
  log("info", "platform", `${process.platform} ${process.arch}`);
  log("info", "cwd", process.cwd());

  // --- 2. mpg123-decoder ---
  console.log("\n--- mpg123-decoder ---");
  let mpg = null;
  try {
    mpg = runtimeRequire("mpg123-decoder");
    log("pass", "mpg123-decoder loads", typeof mpg);
    if (mpg.MPEGDecoder) log("pass", "MPEGDecoder class", "present");
    else log("fail", "MPEGDecoder class", "missing");
  } catch (e) {
    log("fail", "mpg123-decoder", e.message);
  }

  // --- 3. Google TTS ---
  console.log("\n--- Google TTS ---");
  let googleBuf = null;
  const clients = [GUARD_GOOGLE_TTS_CLIENT, "tw-ob", "gtx"];
  for (const client of clients) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=${client}&q=${encodeURIComponent(TEXT)}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win6; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          "Referer": "https://translate.google.com/",
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      const ct = resp.headers.get("content-type") || "";
      const arr = Buffer.from(await resp.arrayBuffer());
      log("info", `client=${client}`, `status=${resp.status} ctype=${ct} bytes=${arr.length}`);
      if (resp.ok && ct.includes("audio") && arr.length > 100) {
        googleBuf = arr;
        log("pass", "Google TTS audio", `${arr.length} bytes`);
        break;
      }
      log("warn", `client=${client}`, "not audio or too small");
    } catch (e) {
      log("fail", `client=${client}`, e.message);
    }
  }
  if (!googleBuf) {
    log("fail", "Google TTS", "ALL clients failed - calls will be silent (no TTS)");
  }

  // --- 4. Decode MP3 → PCM ---
  console.log("\n--- Decode pipeline ---");
  if (googleBuf && mpg && mpg.MPEGDecoder) {
    try {
      const dec = new mpg.MPEGDecoder();
      if (dec.ready) await dec.ready;
      const r = dec.decode(new Uint8Array(googleBuf));
      dec.free();
      if (r && r.channelData && r.channelData.length) {
        const channels = r.channelData.length;
        const rate = Number(r.sampleRate) || 8000;
        log("pass", "MP3 decode", `${r.samplesDecoded} samples, ${rate}Hz, ${channels}ch`);

        // Mix to mono + float → int16
        const mono = new Float64Array(r.samplesDecoded);
        for (let i = 0; i < mono.length; i++) {
          let acc = 0;
          for (let ch = 0; ch < channels; ch++) acc += r.channelData[ch][i] || 0;
          mono[i] = (acc / channels) * 32767;
        }

        // Peak
        let peak = 0;
        for (let i = 0; i < mono.length; i += 16) {
          const v = Math.abs(mono[i]);
          if (v > peak) peak = v;
        }
        log(peak > 500 ? "pass" : "fail", "PCM peak", `peak=${Math.round(peak)}${peak <= 500 ? " -> SILENCE" : ""}`);

        // Resample if needed
        let pcm = Int16Array.from(mono, (v) => Math.max(-32768, Math.min(32767, Math.round(v))));
        if (rate !== RATE) {
          const out = new Int16Array(Math.ceil((pcm.length * RATE) / rate));
          const step = rate / RATE;
          for (let i = 0; i < out.length; i++) {
            const s = Math.floor(i * step);
            const e = Math.min(pcm.length, Math.max(s + 1, Math.ceil((i + 1) * step)));
            let a = 0;
            for (let j = s; j < e; j++) a += pcm[j];
            out[i] = Math.max(-32768, Math.min(32767, Math.round(a / (e - s))));
          }
          pcm = out;
          log("info", "resample", `${rate}Hz → ${RATE}Hz, ${pcm.length} samples`);
        }

        // Encode to uLaw frames
        const frames = [];
        for (let off = 0; off < pcm.length; off += FRAME) {
          const end = Math.min(off + FRAME, pcm.length);
          const b = Buffer.alloc(FRAME);
          for (let i = off; i < end; i++) b[i - off] = ulawEncode(pcm[i]);
          frames.push(b);
        }
        let nonSilent = 0;
        for (const f of frames) {
          for (let i = 0; i < FRAME; i++) { if (f[i] !== 0xff) { nonSilent++; break; } }
        }
        const raw = Buffer.concat(frames);
        log(frames.length && nonSilent ? "pass" : "fail", "uLaw frames",
          `${frames.length} frames / ${nonSilent} non-silent / ${raw.length} bytes`);

        // WAV path test
        const wavTest = wavToPcm16(googleBuf);
        log("info", "wavToPcm16 on MP3", wavTest ? "incorrectly matched as WAV" : "correctly returned null (it's MP3, not WAV)");
      } else {
        log("fail", "MP3 decode", "no channelData returned");
      }
    } catch (e) {
      log("fail", "MP3 decode", e.message);
    }
  } else {
    log("skip", "decode", "skipped (no audio or no decoder)");
  }

  // --- 5. Softphone module ---
  console.log("\n--- Softphone module ---");
  try {
    const sp = runtimeRequire("../management/portal/softphone");
    const funcs = Object.keys(sp);
    log("pass", "softphone loads", funcs.join(", "));
    if (typeof sp.sipCallBridge === "function") log("pass", "sipCallBridge", "function");
    else log("fail", "sipCallBridge", "missing");
  } catch (e) {
    log("fail", "softphone load", e.message);
  }

  // --- 6. ringcentral-softphone SDK ---
  console.log("\n--- RingCentral SDK ---");
  try {
    const RC = runtimeRequire("ringcentral-softphone");
    log("pass", "ringcentral-softphone loads", typeof RC);
  } catch (e) {
    log("fail", "ringcentral-softphone", e.message);
  }

  // --- 7. ws module ---
  console.log("\n--- WebSocket (ws) ---");
  try {
    const WS = runtimeRequire("ws");
    log("pass", "ws loads", typeof WS);
  } catch (e) {
    log("fail", "ws", e.message);
  }

  // --- Summary ---
  console.log("\n=== Summary ===");
  const fails = results.filter(r => r.level === "fail");
  const passes = results.filter(r => r.level === "pass");
  console.log(`  ${passes.length} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("\n  FAILURES:");
    for (const f of fails) console.log(`    - ${f.name}: ${f.detail}`);
    console.log("\n  These failures explain why calls are silent.");
  } else {
    console.log("\n  All checks passed. If calls are still silent,");
    console.log("  the issue is in the live SIP call (streamAudio or network).");
  }

  // Write full report
  fs.writeFileSync("test-suga-diag-results.json", JSON.stringify(results, null, 2));
  console.log("\n  Full report saved to test-suga-diag-results.json");
}

main().catch(e => {
  console.error("FATAL:", e);
  process.exit(1);
});
