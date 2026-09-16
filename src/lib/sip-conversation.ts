import { createRequire } from "module";
import path from "path";
import {
  createConversation,
  processProspectInput,
  getInitialGreeting,
  getCollectedData,
  type ConversationState,
} from "@/lib/free-ai";
import { GUARD_EDGE_TTS_BROKEN_INIT, GUARD_GOOGLE_TTS_CLIENT, logGuardStatus } from "@/lib/guards";

// GUARD: runtimeRequire hides CJS imports from Turbopack static analysis.
// DO NOT replace with `import` - it will crash the build.
const runtimeRequire = createRequire(path.join(process.cwd(), "src", "lib", "sip-conversation.ts"));

const { sipCallBridge } = runtimeRequire("../management/portal/softphone");

// Log guard status at module load
logGuardStatus();

export interface SIPConfig {
  user: string;
  pass: string;
  authId: string;
  domain: string;
  proxy: string;
  port: number;
  number: string;
  callerId: string;
}

export interface AgentConfig {
  tone?: string;
  productName?: string;
  pitch?: string;
  pricing?: string;
}

export interface ConversationResult {
  ok: boolean;
  durationSecs: number;
  connected: boolean;
  interested: boolean;
  disposition: string;
  transcript: string[];
  collectedName: string | null;
  collectedCompany: string | null;
  collectedEmail: string | null;
}

const MAX_CALL_MS = 120000;
const RATE = 8000;
const FRAME = 160;

// FIFO queue — only one Streamer active at any time to prevent RTP sequence collisions
let pendingAudio: Buffer[] = [];
let streamActive = false;
let csRef: any = null;

function drainAudioQueue() {
  if (streamActive || pendingAudio.length === 0 || !csRef) return;
  streamActive = true;
  const next = pendingAudio.shift()!;
  const streamer = csRef.streamAudio(next);
  streamer.once("finished", () => {
    streamActive = false;
    drainAudioQueue();
  });
}
const ULAW_SEG_END = [0x0ff, 0x1ff, 0x3ff, 0x7ff, 0x0fff, 0x1fff, 0x3fff, 0x7fff];

const GROQ_API_KEY = "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";

function ulawEncode(sample: number): number {
  let s = sample | 0;
  const sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > 32767) s = 32767;
  s += 0x84;
  let e = 0;
  while (e < 8 && s > ULAW_SEG_END[e]) e++;
  let b: number;
  if (e === 8) b = 0x7f;
  else { const mant = (s >> (e + 3)) & 0x0f; b = (e << 4) | mant; }
  b |= sign;
  return b ^ 0xff;
}

function ulawDecode(muLaw: number): number {
  muLaw = ~muLaw & 0xff;
  const sign = muLaw & 0x80;
  const exponent = (muLaw >> 4) & 0x07;
  const mantissa = muLaw & 0x0f;
  let sample = ((mantissa << 1) + 0x21) << (exponent + 2);
  sample -= 0x84;
  return sign ? -sample : sample;
}

function ulawToPcm16(muLawBuf: Buffer): Int16Array {
  const pcm = new Int16Array(muLawBuf.length);
  for (let i = 0; i < muLawBuf.length; i++) pcm[i] = ulawDecode(muLawBuf[i]);
  return pcm;
}

function pcm16ToWav(pcm: Int16Array, sampleRate: number): Buffer {
  const dataSize = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  return buf;
}

async function transcribeWithWhisper(audioChunks: Buffer[]): Promise<string> {
  if (!audioChunks.length) { console.log("[sip-conv] Whisper: no audio chunks collected"); return ""; }
  const raw = Buffer.concat(audioChunks);
  console.log("[sip-conv] Whisper: collected", audioChunks.length, "chunks,", raw.length, "total bytes");
  const pcm = ulawToPcm16(raw);
  if (pcm.length < 800) { console.log("[sip-conv] Whisper: audio too short,", pcm.length, "samples"); return ""; }
  const wav = pcm16ToWav(pcm, RATE);
  console.log("[sip-conv] Whisper: WAV size", wav.length, "bytes,", pcm.length, "samples,", Math.round(pcm.length / RATE), "seconds");
  try {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)] as any, { type: "audio/wav" }), "speech.wav");
    form.append("model", "whisper-large-v3-turbo");
    form.append("language", "en");
    form.append("temperature", "0");
    const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(8000),
    });
    const d = await r.json();
    const text = (d?.text || "").trim();
    console.log("[sip-conv] Whisper STT:", text || "(empty)");
    return text;
  } catch (e: any) {
    console.error("[sip-conv] Whisper error:", e?.message);
    return "";
  }
}

function toUlawFrames(pcm16: Int16Array): Buffer[] {
  const frames: Buffer[] = [];
  const n = pcm16.length;
  for (let off = 0; off < n; off += FRAME) {
    const end = Math.min(off + FRAME, n);
    const b = Buffer.alloc(FRAME);
    for (let i = off; i < end; i++) b[i - off] = ulawEncode(pcm16[i]);
    frames.push(b);
  }
  return frames;
}

function antiAliasLowPass(pcm: Int16Array, factor: number) {
  if (factor <= 1) return pcm;
  const windowSize = Math.max(2, factor * 2 + 1);
  const half = Math.floor(windowSize / 2);
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = -half; j <= half; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < pcm.length) { sum += pcm[idx]; count++; }
    }
    out[i] = Math.round(sum / count);
  }
  return out;
}

function wavToPcm16(buf: Buffer): Int16Array | null {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return null;
  let offset = 12;
  let fmt: { sampleRate: number; channels: number; bitsPerSample: number } | null = null;
  let dataOffset = 0;
  let dataSize = 0;
  while (offset < buf.length - 8) {
    const id = buf.toString("ascii", offset, offset + 4);
    const sz = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") { fmt = { sampleRate: buf.readUInt32LE(offset + 12), channels: buf.readUInt16LE(offset + 10), bitsPerSample: buf.readUInt16LE(offset + 22) }; }
    else if (id === "data") { dataOffset = offset + 8; dataSize = sz; break; }
    offset += 8 + sz;
  }
  if (!fmt || !dataOffset) return null;
  const raw = buf.subarray(dataOffset, dataOffset + dataSize);
  let pcm;
  if (fmt.bitsPerSample === 16) {
    pcm = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
  } else if (fmt.bitsPerSample === 8) {
    pcm = Int16Array.from(raw, (v) => (v - 128) << 8);
  } else return null;
  if (fmt.channels === 2) {
    const mono = new Int16Array(Math.floor(pcm.length / 2));
    for (let i = 0; i < mono.length; i++) mono[i] = Math.round((pcm[i * 2] + pcm[i * 2 + 1]) / 2);
    pcm = mono;
  }
  if (fmt.sampleRate !== RATE) {
    const ratio = Math.round(fmt.sampleRate / RATE);
    if (ratio > 1) {
      pcm = antiAliasLowPass(pcm, ratio) as Int16Array<ArrayBuffer>;
      const outLen = Math.ceil(pcm.length / ratio);
      const out = new Int16Array(outLen);
      for (let i = 0; i < outLen; i++) out[i] = pcm[i * ratio] || 0;
      pcm = out;
    }
  }
  return pcm;
}

const EDGE_VOICE = "en-US-JennyNeural";
const EDGE_HOST = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const EDGE_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_GEC_VERSION = "1-143.0.3650.75";
const EDGE_WS_HEADERS: Record<string, string> = {
  "Pragma": "no-cache",
  "Cache-Control": "no-cache",
  "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "en-US,en;q=0.9",
};
const EDGE_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const EDGE_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function edgeDateString() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${EDGE_WEEKDAYS[d.getUTCDay()]} ${EDGE_MONTHS[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

function edgeSecMsGec(nowS = Date.now() / 1000) {
  let ticks = nowS + 11644473600;
  ticks -= ticks % 300;
  ticks *= 1e9 / 100;
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(`${Math.floor(ticks)}${EDGE_TOKEN}`, "ascii").digest("hex").toUpperCase();
}

function edgeMakeId() {
  const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
  return randomUUID().replace(/-/g, "");
}

function edgeClean(text: string): string {
  return String(text || "")
    .split("").map((c) => { const code = c.charCodeAt(0); return (code <= 0x08 || (code >= 0x0B && code <= 0x0C) || (code >= 0x0E && code <= 0x1F)) ? " " : c; }).join("")
    .replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">");
}

function edgeTts(text: string, voice: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { console.error("[sip-conv] edgeTts TIMEOUT for:", text.slice(0, 40)); finish(null); }, 4000);
    function finish(buf: Buffer | null) { if (!done) { done = true; clearTimeout(timer); resolve(buf); } }
    let ws: any;
    try {
      const WS = runtimeRequire("ws");
      const url = `${EDGE_HOST}?TrustedClientToken=${EDGE_TOKEN}&ConnectionId=${edgeMakeId()}&Sec-MS-GEC=${edgeSecMsGec()}&Sec-MS-GEC-Version=${EDGE_GEC_VERSION}`;
      console.log("[sip-conv] edgeTts connecting WS...");
      ws = new WS(url, { headers: { ...EDGE_WS_HEADERS, Cookie: `muid=${require("node:crypto").randomBytes(16).toString("hex").toUpperCase()};` }, perMessageDeflate: true });
    } catch (e: any) { console.error("[sip-conv] WS create failed:", e?.message); finish(null); return; }
    const chunks: Buffer[] = [];
    const stamp = edgeDateString();
    ws.on("open", () => {
      console.log("[sip-conv] edgeTts WS open, sending config...");
      ws.send(`X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`, (err: any) => {
        if (err) { console.error("[sip-conv] TTS config send error:", err); finish(null); return; }
        ws.send(
          `X-RequestId:${edgeMakeId()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp}Z\r\nPath:ssml\r\n\r\n` +
          `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
          `<voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${edgeClean(text)}</prosody></voice></speak>`,
          (e2: any) => { if (e2) { console.error("[sip-conv] SSML send error:", e2); finish(null); } }
        );
      });
    });
    ws.on("message", (raw: any, isBinary: boolean) => {
      if (!isBinary) {
        const msg = String(raw);
        if (msg.includes("turn.end")) { console.log("[sip-conv] edgeTts turn.end, got", chunks.length, "audio chunks"); try { ws.close(); } catch {} finish(Buffer.concat(chunks)); }
        return;
      }
      const buf = Buffer.from(raw);
      try {
        if (buf.length < 2) return;
        const hl = buf.readUInt16BE(0);
        const head = buf.toString("ascii", 2, 2 + hl);
        if (!head.includes("Path:audio")) return;
        chunks.push(buf.subarray(2 + hl + 2));
      } catch { finish(null); }
    });
    ws.on("error", (e: any) => { console.error("[sip-conv] TTS WS error:", e?.code, e?.message); finish(null); });
    ws.on("close", (code: any, reason: any) => { console.log("[sip-conv] edgeTts WS closed:", code, reason?.toString()?.slice(0, 100)); });
  });
}

function splitForTts(text: string): string[] {
  const sentences = String(text || "").split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + " " + s).trim().length > 180) { if (cur.trim()) chunks.push(cur.trim()); cur = s; }
    else cur = (cur + " " + s).trim();
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length ? chunks : [String(text || "Hello").slice(0, 180)];
}

function toneWav(ms = 1000): Buffer {
  const n = Math.floor((RATE * ms) / 1000);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / RATE) * 4000);
    data.writeInt16LE(v, i * 2);
  }
  const wav = Buffer.alloc(44 + data.length);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + data.length, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(RATE, 24);
  wav.writeUInt32LE(RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(data.length, 40);
  data.copy(wav, 44);
  return wav;
}

async function toFramesFromAudio(mp3: Buffer): Promise<Buffer[]> {
  const wav = wavToPcm16(mp3);
  if (wav && wav.length > 0) {
    console.log("[sip-conv] decoded as WAV:", wav.length, "samples");
    return toUlawFrames(wav);
  }
  try {
    const mod = runtimeRequire("mpg123-decoder");
    const dec = new mod.MPEGDecoder();
    if (dec.ready) await dec.ready;
    const r = dec.decode(new Uint8Array(mp3));
    if (r && r.channelData && r.channelData.length) {
      const channels = r.channelData.length;
      const rate = Number(r.sampleRate) || 8000;
      const mono = new Float64Array(r.samplesDecoded);
      for (let i = 0; i < mono.length; i++) {
        let acc = 0;
        for (let ch = 0; ch < channels; ch++) acc += r.channelData[ch][i] || 0;
        mono[i] = (acc / channels) * 32767;
      }
      dec.free();
      let pcm = Int16Array.from(mono, (v) => Math.max(-32768, Math.min(32767, Math.round(v))));
      if (rate !== RATE) {
        const ratio = Math.round(rate / RATE);
        if (ratio > 1) {
          pcm = antiAliasLowPass(pcm, ratio) as Int16Array<ArrayBuffer>;
          const outLen = Math.ceil(pcm.length / ratio);
          const out = new Int16Array(outLen);
          for (let i = 0; i < outLen; i++) out[i] = pcm[i * ratio] || 0;
          pcm = out;
        }
      }
      console.log("[sip-conv] TTS final pcm:", pcm.length, "samples");
      return toUlawFrames(pcm);
    }
  } catch (e: any) { console.error("[sip-conv] decode error:", e?.message); }
  return [];
}

async function textToFramesLocal(text: string, skipEdge = false): Promise<Buffer[]> {
  const chunks = splitForTts(text);
  console.log("[sip-conv] TTS chunks:", chunks.length, "text:", text.slice(0, 60));

  const allParts: Buffer[] = [];
  for (const chunk of chunks) {
    let mp3: Buffer | null = null;

    // 1) Try Edge TTS (JennyNeural voice - human-sounding)
    if (!edgeTtsBroken && !skipEdge) {
      try {
        mp3 = await edgeTts(chunk, EDGE_VOICE);
        if (mp3 && mp3.length > 100) {
          allParts.push(mp3);
          console.log("[sip-conv] Edge TTS OK:", mp3.length, "bytes");
          continue;
        }
        console.error("[sip-conv] Edge TTS returned null/tiny for:", chunk.slice(0, 40));
        edgeTtsBroken = true;
        console.log("[sip-conv] Edge TTS marked broken, switching to HTTP fallback");
      } catch { edgeTtsBroken = true; }
    }

    // 2) Fallback: Google Translate TTS (plain HTTP)
    try {
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=${GUARD_GOOGLE_TTS_CLIENT}&q=${encodeURIComponent(chunk)}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win6; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          "Referer": "https://translate.google.com/",
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const ct = resp.headers.get("content-type") || "";
      if (resp.ok && ct.includes("audio")) {
        const arr = Buffer.from(await resp.arrayBuffer());
        if (arr.length > 100) {
          allParts.push(arr);
          console.log("[sip-conv] Google TTS OK:", arr.length, "bytes, type:", ct);
          continue;
        }
      }
      console.error("[sip-conv] Google TTS failed:", resp.status, "content-type:", ct);
    } catch (e: any) { console.error("[sip-conv] Google TTS error:", e?.message); }

    // 3) Fallback: pre-recorded tone
    console.error("[sip-conv] All TTS failed for chunk, generating tone");
    allParts.push(toneWav(800));
  }

  if (!allParts.length) { console.error("[sip-conv] TTS: no audio parts at all"); return []; }
  const combined = Buffer.concat(allParts);
  console.log("[sip-conv] TTS combined:", combined.length, "bytes");
  return toFramesFromAudio(combined);
}

// GUARD: Edge TTS starts enabled (GUARD_EDGE_TTS_BROKEN_INIT = false).
// Gets set to true if Edge TTS fails, then falls back to Google TTS.
let edgeTtsBroken = GUARD_EDGE_TTS_BROKEN_INIT;

function listenForSpeech(
  cs: any,
  callStart: number,
  heardRef: { current: boolean },
  maxMs: number,
): Promise<{ spoke: boolean; durationMs: number; transcript: string }> {
  return new Promise((resolve) => {
    let got = false;
    let last = 0;
    let first = 0;
    const start = Date.now();
    const audioChunks: Buffer[] = [];
    const on = (d: any) => {
      heardRef.current = true;
      if (!got) first = Date.now();
      got = true;
      last = Date.now();
      // audioPacket event passes an rtpPacket object; audio data is in .payload
      const payload = d?.payload || d;
      if (Buffer.isBuffer(payload)) audioChunks.push(payload);
      else if (payload && typeof payload.length === "number") audioChunks.push(Buffer.from(payload));
    };
    cs.on("audioPacket", on);
    const finish = async () => {
      clearInterval(iv);
      cs.removeListener("audioPacket", on);
      if (!got) { resolve({ spoke: false, durationMs: 0, transcript: "" }); return; }
      const dur = Date.now() - first;
      if (dur < 500) { resolve({ spoke: true, durationMs: dur, transcript: "" }); return; }
      const transcript = await transcribeWithWhisper(audioChunks);
      resolve({ spoke: true, durationMs: dur, transcript });
    };
    const iv = setInterval(() => {
      if (Date.now() - callStart > MAX_CALL_MS) { finish(); return; }
      if (got && Date.now() - last > 2000) { finish(); return; }
      if (!got && Date.now() - start > maxMs) { finish(); return; }
    }, 100);
  });
}

async function speak(cs: any, text: string, heardRef: { current: boolean }, skipEdge = false): Promise<void> {
  console.log("[sip-conv] speak:", text.slice(0, 80));
  let frames: Buffer[];
  try { frames = await textToFramesLocal(text, skipEdge); } catch (e: any) { console.error("[sip-conv] speak TTS error:", e?.message); return; }
  if (!frames || !frames.length) { console.error("[sip-conv] speak: no frames generated"); return; }
  console.log("[sip-conv] speak: got", frames.length, "frames");
  pendingAudio.push(Buffer.concat(frames));
  drainAudioQueue();
  return new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!streamActive && pendingAudio.length === 0) { clearInterval(check); resolve(); }
    }, 100);
  });
}

export async function runConversation(
  sipConfig: SIPConfig,
  agentConfig: AgentConfig,
  maxDurationMs: number = MAX_CALL_MS,
): Promise<ConversationResult> {
  const start = Date.now();
  const lines: string[] = [];
  const heardRef = { current: false };

  console.log("[sip-conv] Starting conversation with", sipConfig.number);

  // Edge TTS broken state persists from guard - do NOT reset per call

  const state = createConversation({
    tone: agentConfig.tone,
    productName: agentConfig.productName,
    pitch: agentConfig.pitch,
    pricing: agentConfig.pricing,
  });

  const call = await sipCallBridge(sipConfig);
  if (!call.ok) {
    console.error("[sip-conv] SIP call failed:", call.last);
    return { ok: false, durationSecs: 0, connected: false, interested: false, disposition: "FAILED", transcript: [], collectedName: null, collectedCompany: null, collectedEmail: null };
  }

  console.log("[sip-conv] SIP call connected, steps:", call.steps?.slice(-3));
  const cs = call.callSession;
  const cleanup = call.cleanup;

  // Set queue reference for this call
  csRef = cs;

  // Speak immediately - Google TTS only (clean native 8kHz, no downsampling)
  const greeting = getInitialGreeting(state);
  lines.push(`Agent: ${greeting}`);
  await speak(cs, greeting, heardRef);

  for (let turn = 0; turn < 20; turn++) {
    if (Date.now() - start > maxDurationMs) break;

    // Listen for speech and transcribe with Whisper
    const r = await listenForSpeech(cs, start, heardRef, 4000);
    if (!r.spoke) {
      await speak(cs, "Are you still there?", heardRef);
      const retry = await listenForSpeech(cs, start, heardRef, 3000);
      if (!retry.spoke) break;
    }
    if (Date.now() - start > maxDurationMs) break;

    // Use real Whisper transcript
    let txt = r.transcript;
    if (!txt || txt.trim().length === 0) {
      // Whisper returned empty but prospect DID speak - use smart fallback to keep conversation alive
      console.log("[sip-conv] Whisper empty but prospect spoke, using smart fallback");
      const fallbackResp = await processProspectInput(state, "");
      let fallbackText = fallbackResp.text || "Sorry, could you repeat that?";
      lines.push(`Agent: ${fallbackText}`);
      await speak(cs, fallbackText, heardRef);
      continue;
    }
    txt = txt.trim();
    console.log("[sip-conv] Prospect said:", txt);
    lines.push(`Prospect: ${txt}`);
    const resp = await processProspectInput(state, txt);
    // Always speak - use fallback if LLM returned empty
    let responseText = resp.text || "I'm sorry, could you repeat that?";
    const ERROR_PATTERNS = ["budget", "rate limit", "api key", "error", "limit reached"];
    if (ERROR_PATTERNS.some(p => responseText.toLowerCase().includes(p))) {
      console.error("[sip-conv] Error text blocked from TTS:", responseText.slice(0, 80));
      responseText = "I'm sorry, could you repeat that?";
    }
    lines.push(`Agent: ${responseText}`);
    await speak(cs, responseText, heardRef);
    if (resp.shouldEnd) break;
  }

  const data = getCollectedData(state);
  const closing = `Thank${data.name ? " you, " + data.name : " you"}! That's everything I needed. One of our dispatch managers will call you back within 30 minutes at 623-400-1991. Have a great day!`;
  lines.push(`Agent: ${closing}`);
  await speak(cs, closing, heardRef);

  // Wait for final audio to finish playing before hangup
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!streamActive && pendingAudio.length === 0) { clearInterval(check); resolve(); }
    }, 100);
  });

  const dur = Math.round((Date.now() - start) / 1000);
  try { cs.hangup(); } catch {}

  // Cleanup queue state — prevents bleed into next call
  pendingAudio = [];
  streamActive = false;
  csRef = null;

  setTimeout(() => { cleanup(); }, 500);

  const connected = dur > 5;
  const interested = connected && heardRef.current && !!(data.name || data.email);
  console.log("[sip-conv] Conversation ended:", { dur, connected, interested });
  return {
    ok: true,
    durationSecs: dur,
    connected,
    interested,
    disposition: interested ? "INTERESTED" : connected ? "NO_RESPONSE" : "NO_ANSWER",
    transcript: lines,
    collectedName: data.name,
    collectedCompany: data.company,
    collectedEmail: data.email,
  };
}