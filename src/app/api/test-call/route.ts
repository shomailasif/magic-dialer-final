import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/mailer";
import { createRequire } from "module";
import path from "path";

const runtimeRequire = createRequire(path.join(process.cwd(), "src", "app", "api", "test-call", "route.ts"));

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
  let pcm: Int16Array;
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
    const out = new Int16Array(Math.ceil((pcm.length * RATE) / fmt.sampleRate));
    const step = fmt.sampleRate / RATE;
    for (let i = 0; i < out.length; i++) {
      const start = Math.floor(i * step);
      const end = Math.min(pcm.length, Math.max(start + 1, Math.ceil((i + 1) * step)));
      let acc = 0;
      for (let j = start; j < end; j++) acc += pcm[j];
      out[i] = Math.max(-32768, Math.min(32767, Math.round(acc / (end - start))));
    }
    pcm = out;
  }
  return pcm;
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
      ws.send(`X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`, (err: any) => {
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

async function textToFramesLocal(text: string): Promise<Buffer[]> {
  const chunks = splitForTts(text);
  const parts: Buffer[] = [];
  for (const chunk of chunks) {
    const m = await edgeTts(chunk, EDGE_VOICE);
    if (m) parts.push(m);
  }
  if (!parts.length) return [];
  const combined = Buffer.concat(parts);
  const wav = wavToPcm16(combined);
  if (wav && wav.length > 0) return toUlawFrames(wav);
  try {
    const mod = runtimeRequire("mpg123-decoder");
    const dec = new mod.MPEGDecoder();
    if (dec.ready) await dec.ready;
    const r = dec.decode(new Uint8Array(combined));
    if (r && r.channelData && r.channelData.length) {
      const channels = r.channelData.length;
      const rate = Number(r.sampleRate) || 24000;
      const mono = new Float64Array(r.samplesDecoded);
      for (let i = 0; i < mono.length; i++) {
        let acc = 0;
        for (let ch = 0; ch < channels; ch++) acc += r.channelData[ch][i] || 0;
        mono[i] = (acc / channels) * 32767;
      }
      dec.free();
      const pcm = Int16Array.from(mono, (v) => Math.max(-32768, Math.min(32767, Math.round(v))));
      let final = pcm;
      if (rate !== RATE) {
        const out = new Int16Array(Math.ceil((pcm.length * RATE) / rate));
        const step = rate / RATE;
        for (let i = 0; i < out.length; i++) {
          const start = Math.floor(i * step);
          const end = Math.min(pcm.length, Math.max(start + 1, Math.ceil((i + 1) * step)));
          let acc = 0;
          for (let j = start; j < end; j++) acc += pcm[j];
          out[i] = Math.max(-32768, Math.min(32767, Math.round(acc / (end - start))));
        }
        final = out;
      }
      return toUlawFrames(final);
    }
  } catch {}
  return [];
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  let number = String(body.number || "").replace(/[^0-9+]/g, "");
  if (number && !number.startsWith("+")) number = "+" + number;
  if (!number || number.length < 8) {
    return NextResponse.json({ error: "Enter a valid phone number (e.g. +16234001991)" }, { status: 400 });
  }

  const rcUser = process.env.RC_SIP_USERNAME;
  const rcPass = process.env.RC_SIP_PASSWORD;
  const rcAuthId = process.env.RC_SIP_AUTH_ID || rcUser;
  const rcCallerId = process.env.RC_CALLER_ID || "";
  const rcDomain = process.env.RC_SIP_DOMAIN || "sip.ringcentral.com";
  const rcProxy = process.env.RC_SIP_PROXY || "sip40.ringcentral.com";
  const rcPort = process.env.RC_SIP_PORT || "5096";

  if (!rcUser || !rcPass) {
    return NextResponse.json({ error: "RingCentral SIP credentials not configured." }, { status: 500 });
  }

  try {
    const { sipCallBridge } = runtimeRequire("../../../management/portal/softphone");

    const agentConfig = await prisma.aIAgentConfig.findUnique({ where: { userId: user.id } });

    let script: string;
    if (agentConfig) {
      const toneIntro = agentConfig.tone === "FRIENDLY"
        ? "Hi there, thanks for answering."
        : agentConfig.tone === "DIRECT"
          ? "Good day, thank you for taking my call."
          : "Hello, thanks for picking up.";

      const pitch = agentConfig.pitch?.trim() || `I'm reaching out because we provide ${agentConfig.productName || "our service"}.`;

      script = [
        `${toneIntro} This is Sophie from Zaz Logistics.`,
        pitch,
        agentConfig.pricing ? `Our pricing starts at ${agentConfig.pricing}.` : "",
        "I just need a couple of details so I can help you quickly.",
        "Could you share your name?",
        "And what company are you with?",
        "And the best email to reach you at?",
        "Perfect, that is everything I need. Thank you so much.",
        "One of our dispatch managers will give you a call back within 30 minutes at 623-400-1991 to discuss your needs further. Have a great day!",
      ].filter(Boolean).join(" ");
    } else {
      script = "Hello, this is Sophie from Zaz Logistics. I'm calling to follow up on your onboarding. We noticed you started the process but haven't completed it yet. Is there anything I can help you with? Could you share your name? And what company are you with? And the best email to reach you at? Perfect, that is everything I need. Thank you so much. One of our dispatch managers will give you a call back within 30 minutes at 623-400-1991 to discuss your needs further. Have a great day!";
    }

    const callResult = await sipCallBridge({
      user: rcUser,
      pass: rcPass,
      authId: rcAuthId,
      domain: rcDomain,
      proxy: rcProxy,
      port: Number(rcPort),
      number: number,
      callerId: rcCallerId,
    });

    if (!callResult.ok) {
      console.error("[test-call] SIP steps:", JSON.stringify(callResult.steps));
      return NextResponse.json({
        ok: false,
        error: callResult.last || "Call failed to connect",
        steps: callResult.steps,
      }, { status: 400 });
    }

    const cs = callResult.callSession;
    const cleanup = callResult.cleanup;
    const startTime = Date.now();
    let heardAnyAudio = false;

    cs.on("audioPacket", () => { heardAnyAudio = true; });

    const frames = await textToFramesLocal(script);
    if (frames.length > 0) {
      cs.streamAudio(Buffer.concat(frames));
    }

    const scriptDuration = Math.max(5000, frames.length * 20);
    const maxCallDuration = 45000;

    await new Promise<void>((resolve) => {
      const scriptTimer = setTimeout(() => {
        const listenStart = Date.now();
        const listenTimer = setInterval(() => {
          const elapsed = Date.now() - listenStart;
          if (elapsed > 8000 || Date.now() - startTime > maxCallDuration) {
            clearInterval(listenTimer);
            clearTimeout(watchdog);
            resolve();
          }
        }, 1000);
      }, scriptDuration);

      const watchdog = setTimeout(() => {
        clearTimeout(scriptTimer);
        resolve();
      }, maxCallDuration);
    });

    const durationSecs = Math.round((Date.now() - startTime) / 1000);
    try { cs.hangup(); } catch {}
    setTimeout(() => { cleanup(); }, 500);

    const connected = durationSecs > 5;
    const interested = connected && heardAnyAudio;
    const disposition = interested ? "INTERESTED" : connected ? "NO_RESPONSE" : "NO_ANSWER";

    let emailSent = false;
    let emailError: string | null = null;
    if (interested) {
      try {
        const now = new Date();
        const subject = `[TEST] New Interested Lead — ${number}`;
        const emailText = [
          `TEST CALL LEAD NOTIFICATION`,
          ``,
          `Lead Phone: ${number}`,
          `Lead Name: Test Prospect`,
          `Status: Interested`,
          `Call Duration: ${durationSecs}s`,
          `Call Time: ${now.toISOString()}`,
          `Agent: Sophie (Zaz Logistics)`,
          ``,
          `A dispatch manager should call back within 30 minutes at 623-400-1991.`,
        ].join("\n");

        const html = [
          `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">`,
          `<h2 style="color:#0f172a">Test Call Lead Notification</h2>`,
          `<table style="border-collapse:collapse;width:100%">`,
          `<tr><td style="padding:6px 0"><strong>Lead Phone</strong></td><td>${number}</td></tr>`,
          `<tr><td style="padding:6px 0"><strong>Status</strong></td><td>Interested</td></tr>`,
          `<tr><td style="padding:6px 0"><strong>Duration</strong></td><td>${durationSecs}s</td></tr>`,
          `<tr><td style="padding:6px 0"><strong>Agent</strong></td><td>Sophie (Zaz Logistics)</td></tr>`,
          `</table>`,
          `<p style="margin-top:16px;color:#64748b">Call back within 30 minutes at 623-400-1991.</p>`,
          `</div>`,
        ].join("\n");

        await sendNotification({ to: "onboarding@zazlogistics.com", subject, text: emailText, html });
        emailSent = true;

        await prisma.notification.create({
          data: {
            userId: user.id,
            toEmail: "onboarding@zazlogistics.com",
            subject,
            body: emailText,
            leadName: "Test Prospect",
            phone: number,
            leadEmail: "test@example.com",
            seats: null,
            otherData: JSON.stringify({ testCall: true, disposition }),
          },
        });
      } catch (e: unknown) {
        emailError = e instanceof Error ? e.message : "Email failed";
      }
    }

    return NextResponse.json({
      ok: true,
      status: disposition,
      message: `Test call completed. Duration: ${durationSecs}s. ${interested ? "Prospect answered — email sent to onboarding." : "No response."}`,
      script: script.substring(0, 200) + "...",
      durationSecs,
      connected,
      interested,
      emailSent,
      emailError,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: "Test call failed: " + msg }, { status: 500 });
  }
}
