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

async function textToFramesLocal(text: string): Promise<Buffer[]> {
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

function pcmuToWav(pcm16: Int16Array): Buffer {
  const numChannels = 1;
  const sampleRate = RATE;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = pcm16.length * (bitsPerSample / 8);
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < pcm16.length; i++) buf.writeInt16LE(pcm16[i], 44 + i * 2);
  return buf;
}

function pcmuToBase64(pcmBufs: Buffer[]): string {
  const all = Buffer.concat(pcmBufs);
  const pcm16 = new Int16Array(all.buffer, all.byteOffset, Math.floor(all.length / 2));
  const wav = pcmuToWav(pcm16);
  return wav.toString("base64");
}

async function transcribeWithOpenAI(audioBase64: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return "";
  try {
    const wavBuf = Buffer.from(audioBase64, "base64");
    const blob = new Blob([wavBuf], { type: "audio/wav" });
    const fd = new FormData();
    fd.append("file", blob, "audio.wav");
    fd.append("model", "whisper-1");
    fd.append("language", "en");
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    });
    if (!r.ok) return "";
    const d = await r.json();
    return (d.text || "").trim();
  } catch { return ""; }
}

async function chatWithOpenAI(messages: { role: string; content: string }[]): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return "";
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        max_tokens: 150,
        temperature: 0.7,
      }),
    });
    if (!r.ok) return "";
    const d = await r.json();
    return (d.choices?.[0]?.message?.content || "").trim();
  } catch { return ""; }
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
  const hasAI = !!process.env.OPENAI_API_KEY;

  if (!rcUser || !rcPass) {
    return NextResponse.json({ error: "RingCentral SIP credentials not configured." }, { status: 500 });
  }

  try {
    const { sipCallBridge } = runtimeRequire("../../../management/portal/softphone");
    const agentConfig = await prisma.aIAgentConfig.findUnique({ where: { userId: user.id } });

    const callResult = await sipCallBridge({
      user: rcUser, pass: rcPass, authId: rcAuthId,
      domain: rcDomain, proxy: rcProxy, port: Number(rcPort),
      number: number, callerId: rcCallerId,
    });

    if (!callResult.ok) {
      console.error("[test-call] SIP steps:", JSON.stringify(callResult.steps));
      return NextResponse.json({ ok: false, error: callResult.last || "Call failed", steps: callResult.steps }, { status: 400 });
    }

    const cs = callResult.callSession;
    const cleanup = callResult.cleanup;
    const startTime = Date.now();
    let heardAnyAudio = false;
    let currentStreamer: any = null;
    let prospectAudioBufs: Buffer[] = [];
    const conversationHistory: { role: string; content: string }[] = [];

    async function speak(text: string): Promise<void> {
      const frames = await textToFramesLocal(text);
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

    function listenAndCollect(maxMs: number): Promise<boolean> {
      return new Promise((resolve) => {
        let gotAudio = false;
        let lastAudio = 0;
        const start = Date.now();
        const onAudio = (data: any) => {
          heardAnyAudio = true;
          gotAudio = true;
          lastAudio = Date.now();
          if (data && Buffer.isBuffer(data)) prospectAudioBufs.push(Buffer.from(data));
        };
        cs.on("audioPacket", onAudio);
        const check = setInterval(() => {
          if (Date.now() - startTime > 120000) { clearInterval(check); cs.removeListener("audioPacket", onAudio); resolve(gotAudio); return; }
          if (gotAudio && Date.now() - lastAudio > 1200) {
            clearInterval(check);
            cs.removeListener("audioPacket", onAudio);
            resolve(true);
          }
          if (!gotAudio && Date.now() - start > maxMs) {
            clearInterval(check);
            cs.removeListener("audioPacket", onAudio);
            resolve(false);
          }
        }, 100);
      });
    }

    async function sayAndListen(text: string, listenMs: number): Promise<string> {
      prospectAudioBufs = [];
      await speak(text);
      if (Date.now() - startTime > 120000) return "";
      const spoke = await listenAndCollect(listenMs);
      if (!spoke || !hasAI || prospectAudioBufs.length === 0) return "";
      const audioB64 = pcmuToBase64(prospectAudioBufs);
      return await transcribeWithOpenAI(audioB64);
    }

    if (hasAI) {
      const systemPrompt = [
        "You are Sophie, a friendly and professional AI assistant calling from Zaz Logistics.",
        "You are making an outbound sales/onboarding call. Your goal is to collect the prospect's name, company name, and email address.",
        "Be conversational, warm, and natural. Keep responses SHORT (1-2 sentences max) since this is a phone call.",
        "If the prospect asks a question, answer it briefly then redirect to collecting their info.",
        "If they say they're not interested, politely ask if there's a better time.",
        "Always end by confirming you have their name, company, and email, then tell them a dispatch manager will call back at 623-400-1991.",
      ].join(" ");
      conversationHistory.push({ role: "system", content: systemPrompt });

      await listenAndCollect(10000);

      const intro = "Hello, this is Sophie from Zaz Logistics. How are you doing today?";
      await speak(intro);
      conversationHistory.push({ role: "assistant", content: intro });

      for (let turn = 0; turn < 15; turn++) {
        if (Date.now() - startTime > 120000) break;
        prospectAudioBufs = [];
        const spoke = await listenAndCollect(8000);
        if (!spoke || prospectAudioBufs.length === 0) {
          await speak("Are you still there?");
          prospectAudioBufs = [];
          const retry = await listenAndCollect(5000);
          if (!retry) break;
        }
        if (prospectAudioBufs.length === 0) continue;
        const audioB64 = pcmuToBase64(prospectAudioBufs);
        const transcript = await transcribeWithOpenAI(audioB64);
        if (!transcript) continue;
        conversationHistory.push({ role: "user", content: transcript });
        const reply = await chatWithOpenAI(conversationHistory);
        if (!reply) continue;
        conversationHistory.push({ role: "assistant", content: reply });
        await speak(reply);
        if (Date.now() - startTime > 120000) break;
      }
    } else {
      await listenAndCollect(15000);
      if (Date.now() - startTime > 120000) { try { cs.hangup(); } catch {} cleanup(); return NextResponse.json({ ok: true, status: "TIMEOUT", durationSecs: Math.round((Date.now() - startTime) / 1000) }); }

      const intro = agentConfig
        ? `${agentConfig.tone === "FRIENDLY" ? "Hi there, thanks for answering." : agentConfig.tone === "DIRECT" ? "Good day, thank you for taking my call." : "Hello, thanks for picking up."} This is Sophie from Zaz Logistics.`
        : "Hello, this is Sophie from Zaz Logistics.";
      await speak(intro);
      if (Date.now() - startTime > 120000) { try { cs.hangup(); } catch {} cleanup(); return NextResponse.json({ ok: true, status: "TIMEOUT", durationSecs: Math.round((Date.now() - startTime) / 1000) }); }

      await listenAndCollect(3000);
      const pitch = agentConfig?.pitch?.trim() || "I'm reaching out because we provide dispatch and logistics solutions.";
      await speak(pitch);
      if (Date.now() - startTime > 120000) { try { cs.hangup(); } catch {} cleanup(); return NextResponse.json({ ok: true, status: "TIMEOUT", durationSecs: Math.round((Date.now() - startTime) / 1000) }); }

      await listenAndCollect(3000);
      await speak("I just need a couple of details so I can help you quickly. Could you share your name?");
      if (Date.now() - startTime > 120000) { try { cs.hangup(); } catch {} cleanup(); return NextResponse.json({ ok: true, status: "TIMEOUT", durationSecs: Math.round((Date.now() - startTime) / 1000) }); }

      await listenAndCollect(10000);
      await speak("Great, thank you! And what company are you with?");
      if (Date.now() - startTime > 120000) { try { cs.hangup(); } catch {} cleanup(); return NextResponse.json({ ok: true, status: "TIMEOUT", durationSecs: Math.round((Date.now() - startTime) / 1000) }); }

      await listenAndCollect(10000);
      await speak("Perfect. And the best email to reach you at?");
      if (Date.now() - startTime > 120000) { try { cs.hangup(); } catch {} cleanup(); return NextResponse.json({ ok: true, status: "TIMEOUT", durationSecs: Math.round((Date.now() - startTime) / 1000) }); }

      await listenAndCollect(10000);
      await speak("That is everything I need. Thank you so much. One of our dispatch managers will call you back within 30 minutes at 623-400-1991. Have a great day!");
    }

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
        const transcript = conversationHistory.map(m => `${m.role}: ${m.content}`).join("\n");
        const emailText = [
          `TEST CALL LEAD NOTIFICATION`,
          ``,
          `Lead Phone: ${number}`,
          `Status: Interested`,
          `Call Duration: ${durationSecs}s`,
          `Call Time: ${now.toISOString()}`,
          `Agent: Sophie (Zaz Logistics)`,
          ``,
          transcript ? `Conversation Transcript:\n${transcript}` : `A dispatch manager should call back within 30 minutes at 623-400-1991.`,
        ].join("\n");

        const html = [
          `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">`,
          `<h2 style="color:#0f172a">Test Call Lead Notification</h2>`,
          `<table style="border-collapse:collapse;width:100%">`,
          `<tr><td style="padding:6px 0"><strong>Phone</strong></td><td>${number}</td></tr>`,
          `<tr><td style="padding:6px 0"><strong>Status</strong></td><td>Interested</td></tr>`,
          `<tr><td style="padding:6px 0"><strong>Duration</strong></td><td>${durationSecs}s</td></tr>`,
          `</table>`,
          transcript ? `<pre style="background:#f1f5f9;padding:12px;border-radius:6px;font-size:13px;white-space:pre-wrap;margin-top:12px">${transcript}</pre>` : "",
          `</div>`,
        ].join("\n");

        await sendNotification({ to: "onboarding@zazlogistics.com", subject, text: emailText, html });
        emailSent = true;

        await prisma.notification.create({
          data: {
            userId: user.id, toEmail: "onboarding@zazlogistics.com", subject, body: emailText,
            leadName: "Test Prospect", phone: number, leadEmail: "test@example.com", seats: null,
            otherData: JSON.stringify({ testCall: true, disposition }),
          },
        });
      } catch (e: unknown) { emailError = e instanceof Error ? e.message : "Email failed"; }
    }

    return NextResponse.json({
      ok: true, status: disposition,
      message: `Test call completed. Duration: ${durationSecs}s. ${interested ? "Prospect answered." : "No response."}`,
      durationSecs, connected, interested, emailSent, emailError, hasAI,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: "Test call failed: " + msg }, { status: 500 });
  }
}
