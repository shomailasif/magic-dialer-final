import { createRequire } from "module";
import path from "path";
import { transcribeAudio, preloadSTT } from "@/lib/free-stt";
import {
  createConversation,
  processProspectInput,
  getInitialGreeting,
  getCollectedData,
  type ConversationState,
} from "@/lib/free-ai";

const runtimeRequire = createRequire(path.join(process.cwd(), "src", "lib", "sip-caller.ts"));

const RATE = 8000;
const FRAME = 160;
const ULAW_SEG_END = [0x0ff, 0x1ff, 0x3ff, 0x7ff, 0x0fff, 0x1fff, 0x3fff, 0x7fff];

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

const EDGE_VOICE = "en-US-AvaNeural";
const EDGE_HOST = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const EDGE_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_GEC_VERSION = "1-143.0.3650.75";
const EDGE_WS_HEADERS: Record<string, string> = {
  "Pragma": "no-cache",
  "Cache-Control": "no-cache",
  "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0"
};

function edgeDateString() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
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
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function edgeTts(text: string, voice: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => finish(null), 20000);
    function finish(buf: Buffer | null) { if (!done) { done = true; clearTimeout(timer); resolve(buf); } }
    let ws: any;
    try {
      const WS = runtimeRequire("ws");
      ws = new WS(
        `${EDGE_HOST}?TrustedClientToken=${EDGE_TOKEN}&ConnectionId=${edgeMakeId()}&Sec-MS-GEC=${edgeSecMsGec()}&Sec-MS-GEC-Version=${EDGE_GEC_VERSION}`,
        { headers: { ...EDGE_WS_HEADERS, Cookie: `muid=${require("node:crypto").randomBytes(16).toString("hex").toUpperCase()};` }, perMessageDeflate: true }
      );
    } catch { finish(null); return; }
    const chunks: Buffer[] = [];
    const stamp = edgeDateString();
    ws.on("open", () => {
      ws.send(`X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-8khz-16kbitrate-mono-mp3"}}}}\r\n`, (err: any) => {
        if (err) { finish(null); return; }
        ws.send(
          `X-RequestId:${edgeMakeId()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp}Z\r\nPath:ssml\r\n\r\n` +
          `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
          `<voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${edgeClean(text)}</prosody></voice></speak>`,
          (e2: any) => { if (e2) finish(null); }
        );
      });
    });
    ws.on("message", (raw: any, isBinary: boolean) => {
      if (!isBinary) {
        if (String(raw).includes("turn.end")) { try { ws.close(); } catch {} finish(Buffer.concat(chunks)); }
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
    ws.on("error", () => finish(null));
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

async function textToFrames(text: string): Promise<Buffer[]> {
  const chunks = splitForTts(text);
  const parts: Buffer[] = [];
  for (const chunk of chunks) {
    const m = await edgeTts(chunk, EDGE_VOICE);
    if (m) parts.push(m);
  }
  if (!parts.length) return [];
  const combined = Buffer.concat(parts);
  try {
    const mod = runtimeRequire("mpg123-decoder");
    const dec = new mod.MPEGDecoder();
    if (dec.ready) await dec.ready;
    const r = dec.decode(new Uint8Array(combined));
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
      }
      return toUlawFrames(pcm);
    }
  } catch {}
  return [];
}

export interface SIPCallConfig {
  user: string;
  pass: string;
  authId: string;
  domain: string;
  proxy: string;
  port: number;
  number: string;
  callerId: string;
}

export interface SIPCallResult {
  ok: boolean;
  durationSecs: number;
  connected: boolean;
  interested: boolean;
  disposition: string;
  transcript: string;
  collectedName: string | null;
  collectedCompany: string | null;
  collectedEmail: string | null;
  error?: string;
}

export async function makeSIPCall(
  sipConfig: SIPCallConfig,
  agentConfig: {
    tone?: string;
    productName?: string;
    pitch?: string;
    pricing?: string;
    followUpAttempts?: number;
    followUpIntervalHours?: number;
  },
  maxDurationMs: number = 120000,
): Promise<SIPCallResult> {
  preloadSTT();

  const { sipCallBridge } = runtimeRequire("../../../management/portal/softphone");

  const callResult = await sipCallBridge(sipConfig);
  if (!callResult.ok) {
    return {
      ok: false,
      durationSecs: 0,
      connected: false,
      interested: false,
      disposition: "FAILED",
      transcript: "",
      collectedName: null,
      collectedCompany: null,
      collectedEmail: null,
      error: callResult.last || "Call failed to connect",
    };
  }

  const cs = callResult.callSession;
  const cleanup = callResult.cleanup;
  const startTime = Date.now();
  let heardAnyAudio = false;
  let currentStreamer: any = null;

  async function speak(text: string): Promise<void> {
    const frames = await textToFrames(text);
    if (frames.length === 0) return;
    return new Promise<void>((resolve) => {
      let stopped = false;
      currentStreamer = cs.streamAudio(Buffer.concat(frames));
      const onAudio = () => {
        if (!stopped) {
          stopped = true;
          try { currentStreamer.stop(); } catch {}
          cs.removeListener("audioPacket", onAudio);
          resolve();
        }
      };
      cs.on("audioPacket", onAudio);
      const durationMs = Math.max(1000, frames.length * 20);
      setTimeout(() => {
        cs.removeListener("audioPacket", onAudio);
        if (!stopped) resolve();
      }, durationMs + 500);
    });
  }

  function listenAndCollect(maxMs: number): Promise<{ spoke: boolean; audioBufs: Buffer[] }> {
    return new Promise((resolve) => {
      let gotAudio = false;
      let lastAudio = 0;
      const start = Date.now();
      const audioBufs: Buffer[] = [];
      const onAudio = (data: any) => {
        heardAnyAudio = true;
        gotAudio = true;
        lastAudio = Date.now();
        if (data && Buffer.isBuffer(data)) audioBufs.push(Buffer.from(data));
      };
      cs.on("audioPacket", onAudio);
      const check = setInterval(() => {
        if (Date.now() - startTime > maxDurationMs) { clearInterval(check); cs.removeListener("audioPacket", onAudio); resolve({ spoke: gotAudio, audioBufs }); return; }
        if (gotAudio && Date.now() - lastAudio > 1200) {
          clearInterval(check);
          cs.removeListener("audioPacket", onAudio);
          resolve({ spoke: true, audioBufs });
        }
        if (!gotAudio && Date.now() - start > maxMs) {
          clearInterval(check);
          cs.removeListener("audioPacket", onAudio);
          resolve({ spoke: false, audioBufs });
        }
      }, 100);
    });
  }

  const state = createConversation({
    tone: agentConfig.tone,
    productName: agentConfig.productName,
    pitch: agentConfig.pitch,
    pricing: agentConfig.pricing,
  });

  const greeting = getInitialGreeting(state);
  await speak(greeting);

  const transcriptLines: string[] = [`Agent: ${greeting}`];

  for (let turn = 0; turn < 20; turn++) {
    if (Date.now() - startTime > maxDurationMs) break;

    const { spoke, audioBufs } = await listenAndCollect(8000);

    if (!spoke || audioBufs.length === 0) {
      await speak("Are you still there?");
      const retry = await listenAndCollect(5000);
      if (!retry.spoke || retry.audioBufs.length === 0) break;
      const pcmChunks: Int16Array[] = [];
      for (const buf of retry.audioBufs) {
        if (buf.length >= 2) {
          const samples = Math.floor(buf.length / 2);
          const pcm = new Int16Array(samples);
          for (let i = 0; i < samples; i++) {
            pcm[i] = buf.readInt16LE(i * 2);
          }
          pcmChunks.push(pcm);
        }
      }
      if (pcmChunks.length > 0) {
        const totalLen = pcmChunks.reduce((sum, c) => sum + c.length, 0);
        const combined = new Int16Array(totalLen);
        let offset = 0;
        for (const chunk of pcmChunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        const result = await transcribeAudio(combined, RATE);
        if (result.text) {
          const response = processProspectInput(state, result.text);
          transcriptLines.push(`Prospect: ${result.text}`);
          if (response.text) {
            transcriptLines.push(`Agent: ${response.text}`);
            await speak(response.text);
          }
          if (response.shouldEnd) break;
        }
      }
      continue;
    }

    const pcmChunks: Int16Array[] = [];
    for (const buf of audioBufs) {
      if (buf.length >= 2) {
        const samples = Math.floor(buf.length / 2);
        const pcm = new Int16Array(samples);
        for (let i = 0; i < samples; i++) {
          pcm[i] = buf.readInt16LE(i * 2);
        }
        pcmChunks.push(pcm);
      }
    }

    if (pcmChunks.length === 0) continue;

    const totalLen = pcmChunks.reduce((sum, c) => sum + c.length, 0);
    const combined = new Int16Array(totalLen);
    let offset = 0;
    for (const chunk of pcmChunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    const result = await transcribeAudio(combined, RATE);
    if (!result.text) continue;

    transcriptLines.push(`Prospect: ${result.text}`);

    const response = processProspectInput(state, result.text);
    if (response.text) {
      transcriptLines.push(`Agent: ${response.text}`);
      await speak(response.text);
    }

    if (response.shouldEnd) break;
  }

  const durationSecs = Math.round((Date.now() - startTime) / 1000);
  try { cs.hangup(); } catch {}
  setTimeout(() => { cleanup(); }, 500);

  const connected = durationSecs > 5;
  const data = getCollectedData(state);
  const interested = connected && heardAnyAudio && (data.name || data.email);
  const disposition = interested ? "INTERESTED" : connected ? "NO_RESPONSE" : "NO_ANSWER";

  return {
    ok: true,
    durationSecs,
    connected,
    interested,
    disposition,
    transcript: transcriptLines.join("\n"),
    collectedName: data.name,
    collectedCompany: data.company,
    collectedEmail: data.email,
  };
}
