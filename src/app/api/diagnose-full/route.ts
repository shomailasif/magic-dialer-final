import { NextResponse } from "next/server";
import { createRequire } from "module";
import path from "path";
import { GUARD_GOOGLE_TTS_CLIENT, GUARD_EDGE_TTS_BROKEN_INIT } from "@/lib/guards";

const runtimeRequire = createRequire(path.join(process.cwd(), "src", "lib", "sip-conversation.ts"));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE = 8000;
const FRAME = 160;
const ULAW_SEG_END = [0x0ff, 0x1ff, 0x3ff, 0x7ff, 0x0fff, 0x1fff, 0x3fff, 0x7fff];
const TEXT = "Hi there! Thanks for picking up. How are you doing today?";

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

export async function GET() {
  const results: { level: string; name: string; detail: string }[] = [];
  const push = (level: string, name: string, detail: string) => results.push({ level, name, detail });

  push("info", "node", process.versions.node);
  push("info", "platform", `${process.platform} ${process.arch}`);
  push("info", "edgeTtsBroken init", String(GUARD_EDGE_TTS_BROKEN_INIT));

  // mpg123-decoder
  let mpg: any = null;
  try {
    mpg = runtimeRequire("mpg123-decoder");
    push("pass", "mpg123-decoder", typeof mpg);
    if (mpg.MPEGDecoder) push("pass", "MPEGDecoder", "present");
    else push("fail", "MPEGDecoder", "missing");
  } catch (e: any) {
    push("fail", "mpg123-decoder", e?.message || String(e));
  }

  // softphone
  try {
    const sp = runtimeRequire("../management/portal/softphone");
    push("pass", "softphone", Object.keys(sp).join(", "));
    if (typeof sp.sipCallBridge === "function") push("pass", "sipCallBridge", "function");
    else push("fail", "sipCallBridge", "missing");
  } catch (e: any) {
    push("fail", "softphone", e?.message || String(e));
  }

  // ringcentral-softphone
  try {
    const RC = runtimeRequire("ringcentral-softphone");
    push("pass", "ringcentral-softphone", typeof RC);
  } catch (e: any) {
    push("fail", "ringcentral-softphone", e?.message || String(e));
  }

  // ws
  try {
    const WS = runtimeRequire("ws");
    push("pass", "ws", typeof WS);
  } catch (e: any) {
    push("fail", "ws", e?.message || String(e));
  }

  // Google TTS
  let googleBuf: Buffer | null = null;
  for (const client of [GUARD_GOOGLE_TTS_CLIENT, "tw-ob", "gtx"]) {
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
      push("info", `google:${client}`, `status=${resp.status} ctype=${ct} bytes=${arr.length}`);
      if (resp.ok && ct.includes("audio") && arr.length > 100) {
        googleBuf = arr;
        push("pass", "Google TTS", `${arr.length} bytes`);
        break;
      }
    } catch (e: any) {
      push("fail", `google:${client}`, e?.message || String(e));
    }
  }
  if (!googleBuf) push("fail", "Google TTS", "ALL clients failed");

  // Decode MP3
  if (googleBuf && mpg && mpg.MPEGDecoder) {
    try {
      const dec = new mpg.MPEGDecoder();
      if (dec.ready) await dec.ready;
      const r = dec.decode(new Uint8Array(googleBuf));
      dec.free();
      if (r && r.channelData && r.channelData.length) {
        const channels = r.channelData.length;
        const rate = Number(r.sampleRate) || 8000;
        push("pass", "decode", `${r.samplesDecoded} samples ${rate}Hz ${channels}ch`);

        const mono = new Float64Array(r.samplesDecoded);
        for (let i = 0; i < mono.length; i++) {
          let acc = 0;
          for (let ch = 0; ch < channels; ch++) acc += r.channelData[ch][i] || 0;
          mono[i] = (acc / channels) * 32767;
        }
        let peak = 0;
        for (let i = 0; i < mono.length; i += 16) { const v = Math.abs(mono[i]); if (v > peak) peak = v; }
        push(peak > 500 ? "pass" : "fail", "pcm peak", `peak=${Math.round(peak)}`);

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

        const frames: Buffer[] = [];
        for (let off = 0; off < pcm.length; off += FRAME) {
          const end = Math.min(off + FRAME, pcm.length);
          const b = Buffer.alloc(FRAME);
          for (let i = off; i < end; i++) b[i - off] = ulawEncode(pcm[i]);
          frames.push(b);
        }
        let nonSilent = 0;
        for (const f of frames) { for (let i = 0; i < FRAME; i++) { if (f[i] !== 0xff) { nonSilent++; break; } } }
        push(frames.length && nonSilent ? "pass" : "fail", "uLaw frames",
          `${frames.length} frames / ${nonSilent} non-silent`);
      } else {
        push("fail", "decode", "no channelData");
      }
    } catch (e: any) {
      push("fail", "decode", e?.message || String(e));
    }
  }

  const fails = results.filter(r => r.level === "fail");
  return NextResponse.json({ ok: fails.length === 0, failures: fails.length, report: results });
}
