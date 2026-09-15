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
  const wav = wavToPcm16(combined);
  if (wav && wav.length > 0) return toUlawFrames(wav);
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

function listenForSpeech(cs: any, startTime: number, heardRef: { current: boolean }, maxMs: number): Promise<{ spoke: boolean; durationMs: number; peakEnergy: number }> {
  return new Promise((resolve) => {
    let gotAudio = false;
    let lastAudio = 0;
    let firstAudio = 0;
    let peakEnergy = 0;
    const start = Date.now();
    const onAudio = (data: any) => {
      heardRef.current = true;
      if (!gotAudio) firstAudio = Date.now();
      gotAudio = true;
      lastAudio = Date.now();
      if (Buffer.isBuffer(data)) {
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += Math.abs(data[i] - 128);
        const avg = sum / data.length;
        if (avg > peakEnergy) peakEnergy = avg;
      }
    };
    cs.on("audioPacket", onAudio);
    const check = setInterval(() => {
      if (Date.now() - startTime > 120000) { clearInterval(check); cs.removeListener("audioPacket", onAudio); resolve({ spoke: gotAudio, durationMs: gotAudio ? Date.now() - firstAudio : 0, peakEnergy }); return; }
      if (gotAudio && Date.now() - lastAudio > 1000) {
        clearInterval(check);
        cs.removeListener("audioPacket", onAudio);
        resolve({ spoke: true, durationMs: Date.now() - firstAudio, peakEnergy });
      }
      if (!gotAudio && Date.now() - start > maxMs) {
        clearInterval(check);
        cs.removeListener("audioPacket", onAudio);
        resolve({ spoke: false, durationMs: 0, peakEnergy: 0 });
      }
    }, 100);
  });
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

  const rcUser = process.env.RC_SIP_USERNAME || "";
  const rcPass = process.env.RC_SIP_PASSWORD || "";
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

    const callResult = await sipCallBridge({
      user: rcUser, pass: rcPass, authId: rcAuthId,
      domain: rcDomain, proxy: rcProxy, port: Number(rcPort),
      number: number, callerId: rcCallerId,
    });

    if (!callResult.ok) {
      console.error("[test-call] SIP steps:", JSON.stringify(callResult.steps));
      return NextResponse.json({ ok: false, error: callResult.last || "Call failed to connect", steps: callResult.steps }, { status: 400 });
    }

    const cs = callResult.callSession;
    const cleanup = callResult.cleanup;
    const startTime = Date.now();
    let heardAnyAudio = false;
    let currentStreamer: any = null;
    const heardRef = { current: false };

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
        if (currentStreamer && currentStreamer.finished) {
          currentStreamer.finished.then(() => {
            cs.removeListener("audioPacket", onAudio);
            if (!stopped) resolve();
          }).catch(() => {
            cs.removeListener("audioPacket", onAudio);
            if (!stopped) resolve();
          });
        } else {
          const durationMs = Math.max(1000, frames.length * 20);
          setTimeout(() => {
            cs.removeListener("audioPacket", onAudio);
            if (!stopped) resolve();
          }, durationMs + 500);
        }
      });
    }

    const toneIntro = agentConfig?.tone === "FRIENDLY"
      ? "Hi there, thanks for answering."
      : agentConfig?.tone === "DIRECT"
        ? "Good day, thank you for taking my call."
        : "Hello, thanks for picking up.";

    const productName = agentConfig?.productName || "dispatch and logistics solutions";
    const pitch = agentConfig?.pitch?.trim() || `I'm reaching out because we provide ${productName}.`;

    const collected = { name: null as string | null, company: null as string | null, email: null as string | null };
    const transcriptLines: string[] = [];

    await listenForSpeech(cs, startTime, heardRef, 15000);
    heardAnyAudio = heardRef.current;
    if (Date.now() - startTime > 120000) { try { cs.hangup(); } catch {} cleanup(); return NextResponse.json({ ok: true, status: "TIMEOUT", durationSecs: Math.round((Date.now() - startTime) / 1000) }); }

    async function askAndListen(question: string, listenMs: number, field: keyof typeof collected): Promise<boolean> {
      if (Date.now() - startTime > 120000) return false;
      transcriptLines.push(`Agent: ${question}`);
      await speak(question);
      if (Date.now() - startTime > 120000) return false;

      const result = await listenForSpeech(cs, startTime, heardRef, listenMs);
      heardAnyAudio = heardAnyAudio || result.spoke;

      if (!result.spoke) return false;

      if (result.durationMs < 500 && result.peakEnergy < 30) {
        collected[field] = "yes";
        transcriptLines.push(`Prospect: [short response ${Math.round(result.durationMs)}ms]`);
      } else if (result.durationMs < 2000) {
        collected[field] = "provided";
        transcriptLines.push(`Prospect: [response ${Math.round(result.durationMs)}ms]`);
      } else {
        collected[field] = "provided";
        transcriptLines.push(`Prospect: [detailed response ${Math.round(result.durationMs)}ms]`);
      }

      if (Date.now() - startTime > 120000) return false;
      const acks = ["Got it!", "Perfect, thank you!", "Great!", "Awesome, thanks!"];
      const ack = acks[Math.floor(Math.random() * acks.length)];
      transcriptLines.push(`Agent: ${ack}`);
      await speak(ack);
      return true;
    }

    async function listenForObjection(maxMs: number): Promise<{ spoke: boolean; durationMs: number }> {
      if (Date.now() - startTime > 120000) return { spoke: false, durationMs: 0 };
      const result = await listenForSpeech(cs, startTime, heardRef, maxMs);
      heardAnyAudio = heardAnyAudio || result.spoke;
      return result;
    }

    const intro = `${toneIntro} This is Sophie from Zaz Logistics.`;
    transcriptLines.push(`Agent: ${intro}`);
    await speak(intro);
    if (Date.now() - startTime > 120000) { try { cs.hangup(); } catch {} cleanup(); return NextResponse.json({ ok: true, status: "TIMEOUT", durationSecs: Math.round((Date.now() - startTime) / 1000) }); }

    const obj1 = await listenForObjection(3000);
    if (obj1.spoke && obj1.durationMs > 3000) {
      const responses = [
        "I appreciate you sharing that. Let me quickly explain why I'm calling.",
        "I understand. This will only take a moment.",
        "Fair enough. Let me tell you what we do.",
      ];
      const resp = responses[Math.floor(Math.random() * responses.length)];
      transcriptLines.push(`Agent: ${resp}`);
      await speak(resp);
    }

    transcriptLines.push(`Agent: ${pitch}`);
    await speak(pitch);
    if (Date.now() - startTime > 120000) { try { cs.hangup(); } catch {} cleanup(); return NextResponse.json({ ok: true, status: "TIMEOUT", durationSecs: Math.round((Date.now() - startTime) / 1000) }); }

    const obj2 = await listenForObjection(3000);
    if (obj2.spoke && obj2.durationMs > 2000) {
      if (obj2.durationMs > 5000) {
        const handleObj = [
          "I completely understand your concern. Many of our clients felt the same way before they tried us. Can I ask what's holding you back?",
          "I respect that. Would it be okay if I just took 30 seconds to explain how we're different?",
          "That's totally fair. Let me ask you this — what's the biggest challenge you're facing right now?",
        ];
        const resp = handleObj[Math.floor(Math.random() * handleObj.length)];
        transcriptLines.push(`Agent: ${resp}`);
        await speak(resp);

        const objResp = await listenForObjection(8000);
        if (objResp.spoke) {
          transcriptLines.push(`Prospect: [objection response ${Math.round(objResp.durationMs)}ms]`);
          const followUp = [
            "I appreciate you sharing that. Let me just get your name and email so we can follow up with more details.",
            "That makes sense. Let me quickly get your info so we can send you something relevant.",
            "Got it. Let me just grab a few details and I'll let you go.",
          ];
          const fu = followUp[Math.floor(Math.random() * followUp.length)];
          transcriptLines.push(`Agent: ${fu}`);
          await speak(fu);
        }
      } else {
        const ack = "I understand. Let me just get a few quick details.";
        transcriptLines.push(`Agent: ${ack}`);
        await speak(ack);
      }
    }

    if (Date.now() - startTime > 120000) { try { cs.hangup(); } catch {} cleanup(); return NextResponse.json({ ok: true, status: "TIMEOUT", durationSecs: Math.round((Date.now() - startTime) / 1000) }); }

    await askAndListen("Could you share your name?", 8000, "name");
    if (Date.now() - startTime > 120000) { try { cs.hangup(); } catch {} cleanup(); return NextResponse.json({ ok: true, status: "TIMEOUT", durationSecs: Math.round((Date.now() - startTime) / 1000) }); }

    await askAndListen("And what company are you with?", 8000, "company");
    if (Date.now() - startTime > 120000) { try { cs.hangup(); } catch {} cleanup(); return NextResponse.json({ ok: true, status: "TIMEOUT", durationSecs: Math.round((Date.now() - startTime) / 1000) }); }

    const emailResult = await listenForSpeech(cs, startTime, heardRef, 2000);
    if (!emailResult.spoke) {
      await askAndListen("And the best email to reach you at?", 10000, "email");
    }

    if (Date.now() - startTime > 120000) { try { cs.hangup(); } catch {} cleanup(); return NextResponse.json({ ok: true, status: "TIMEOUT", durationSecs: Math.round((Date.now() - startTime) / 1000) }); }

    const closing = `That is everything I need. Thank you so much. One of our dispatch managers will call you back within 30 minutes at 623-400-1991. Have a great day!`;
    transcriptLines.push(`Agent: ${closing}`);
    await speak(closing);

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
          `TEST CALL LEAD NOTIFICATION`, ``,
          `Lead Phone: ${number}`,
          `Lead Name: ${collected.name || "Unknown"}`,
          `Lead Company: ${collected.company || "Unknown"}`,
          `Lead Email: ${collected.email || "Unknown"}`,
          `Status: Interested`,
          `Call Duration: ${durationSecs}s`,
          `Call Time: ${now.toISOString()}`,
          `Agent: Sophie (Zaz Logistics)`, ``,
          transcriptLines.join("\n"), ``,
          `A dispatch manager should call back within 30 minutes at 623-400-1991.`,
        ].join("\n");

        const html = [
          `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">`,
          `<h2 style="color:#0f172a">Test Call Lead Notification</h2>`,
          `<table style="border-collapse:collapse;width:100%">`,
          `<tr><td style="padding:6px 0"><strong>Phone</strong></td><td>${number}</td></tr>`,
          `<tr><td style="padding:6px 0"><strong>Name</strong></td><td>${collected.name || "Unknown"}</td></tr>`,
          `<tr><td style="padding:6px 0"><strong>Company</strong></td><td>${collected.company || "Unknown"}</td></tr>`,
          `<tr><td style="padding:6px 0"><strong>Email</strong></td><td>${collected.email || "Unknown"}</td></tr>`,
          `<tr><td style="padding:6px 0"><strong>Duration</strong></td><td>${durationSecs}s</td></tr>`,
          `</table>`,
          `<pre style="background:#f1f5f9;padding:12px;border-radius:6px;font-size:13px;white-space:pre-wrap;margin-top:12px">${transcriptLines.join("\n")}</pre>`,
          `</div>`,
        ].join("\n");

        await sendNotification({ to: "onboarding@zazlogistics.com", subject, text: emailText, html });
        emailSent = true;

        await prisma.notification.create({
          data: {
            userId: user.id, toEmail: "onboarding@zazlogistics.com", subject, body: emailText,
            leadName: collected.name || "Test Prospect", phone: number,
            leadEmail: collected.email || "test@example.com", seats: null,
            otherData: JSON.stringify({ testCall: true, disposition }),
          },
        });
      } catch (e: unknown) { emailError = e instanceof Error ? e.message : "Email failed"; }
    }

    return NextResponse.json({
      ok: true, status: disposition,
      message: `Test call completed. Duration: ${durationSecs}s. ${interested ? "Prospect answered." : "No response."}`,
      durationSecs, connected, interested, emailSent, emailError,
      transcript: transcriptLines.join("\n"),
      collectedName: collected.name,
      collectedCompany: collected.company,
      collectedEmail: collected.email,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: "Test call failed: " + msg }, { status: 500 });
  }
}
