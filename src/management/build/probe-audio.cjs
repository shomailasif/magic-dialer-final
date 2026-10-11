/* WAV -> the mu-law 8kHz bytes the engine puts on the wire.
 *
 * Shared by the probes so they all send byte-identical audio to what
 * local-call-controller hands the gateway. Getting this wrong is quiet and
 * expensive: the STT route mu-law-decodes its input (function W in
 * src/app/api/engine/ai/stt/route.ts) and wraps it as 8kHz, so sending a raw
 * 16kHz WAV makes Groq transcribe noise and answer "." - which is several times
 * faster than real speech and reads as a suspiciously fast gateway.
 */
"use strict";
const fs = require("node:fs");

function readWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("fixture is not RIFF");
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + sz);
    if (id === "fmt ") fmt = { ch: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    if (id === "data") data = body;
    off += 8 + sz + (sz & 1);
  }
  if (!fmt || !data) throw new Error("fixture has no fmt/data chunk");
  const n = Math.floor(data.length / (fmt.bits / 8) / fmt.ch);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    if (fmt.bits === 16) out[i] = data.readInt16LE(i * 2 * fmt.ch);
    else out[i] = (data[i * fmt.ch] - 128) << 8;
  }
  return { fmt, pcm: out };
}

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

/* G.711 mu-law encode, matching src/management/agent/voice.js. */
function mulaw(pcm) {
  const out = Buffer.alloc(pcm.length);
  const BIAS = 0x84, CLIP = 8159;
  for (let i = 0; i < pcm.length; i++) {
    const sign = (pcm[i] >> 8) & 0x80;
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

/* The engine's decoder, for building a 16-bit WAV the direct Groq call can take. */
function mulawDecode(u) {
  u = (~u) & 255;
  const s = u & 128, e = (u >> 4) & 7, m = u & 15;
  let x = ((m << 1) + 33) << (e + 2);
  x -= 132;
  return s ? -x : x;
}

function wavFromMulaw(ml) {
  const pcm = Buffer.alloc(ml.length * 2);
  for (let i = 0; i < ml.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, mulawDecode(ml[i]))), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** The mu-law 8kHz bytes the gateway expects. */
function engineAudio(wavPath) {
  const { fmt, pcm } = readWav(fs.readFileSync(wavPath));
  return mulaw(to8k(pcm, fmt.rate));
}

module.exports = { readWav, to8k, mulaw, mulawDecode, wavFromMulaw, engineAudio };