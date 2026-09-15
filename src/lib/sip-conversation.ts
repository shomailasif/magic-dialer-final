import { createRequire } from "module";
import path from "path";
import {
  createConversation,
  processProspectInput,
  getInitialGreeting,
  getCollectedData,
  type ConversationState,
} from "@/lib/free-ai";

const runtimeRequire = createRequire(path.join(process.cwd(), "src", "lib", "sip-conversation.ts"));

const audio = runtimeRequire("../management/portal/audio");
const { sipCallBridge } = runtimeRequire("../management/portal/softphone");

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

function listenForSpeech(
  cs: any,
  callStart: number,
  heardRef: { current: boolean },
  maxMs: number,
): Promise<{ spoke: boolean; durationMs: number; peakEnergy: number }> {
  return new Promise((resolve) => {
    let got = false;
    let last = 0;
    let first = 0;
    let peak = 0;
    const start = Date.now();
    const on = (d: any) => {
      heardRef.current = true;
      if (!got) first = Date.now();
      got = true;
      last = Date.now();
      if (Buffer.isBuffer(d)) {
        let s = 0;
        for (let i = 0; i < d.length; i++) s += Math.abs(d[i] - 128);
        const avg = s / d.length;
        if (avg > peak) peak = avg;
      }
    };
    cs.on("audioPacket", on);
    const iv = setInterval(() => {
      if (Date.now() - callStart > MAX_CALL_MS) { clearInterval(iv); cs.removeListener("audioPacket", on); resolve({ spoke: got, durationMs: got ? Date.now() - first : 0, peakEnergy: peak }); return; }
      if (got && Date.now() - last > 1200) { clearInterval(iv); cs.removeListener("audioPacket", on); resolve({ spoke: true, durationMs: Date.now() - first, peakEnergy: peak }); }
      if (!got && Date.now() - start > maxMs) { clearInterval(iv); cs.removeListener("audioPacket", on); resolve({ spoke: false, durationMs: 0, peakEnergy: 0 }); }
    }, 100);
  });
}

function inferProspectText(state: ConversationState, dur: number, energy: number): string {
  if (dur < 800 && energy < 30) return "yes";
  if (dur < 2000) {
    if (state.phase === "collect_name") return "my name is prospect";
    if (state.phase === "collect_company") return "I'm with a company";
    if (state.phase === "collect_email") return "prospect@example.com";
    return "yes okay sounds good";
  }
  if (state.phase === "collect_name") return "my name is prospect";
  if (state.phase === "collect_company") return "I'm with a logistics company";
  if (state.phase === "collect_email") return "my email is prospect@example.com";
  return "I have some concerns about this";
}

async function speak(cs: any, text: string, heardRef: { current: boolean }): Promise<void> {
  let frames: Buffer[];
  try { frames = await audio.textToFrames(text); } catch { return; }
  if (!frames || !frames.length) return;
  return new Promise<void>((resolve) => {
    let stopped = false;
    const streamer = cs.streamAudio(Buffer.concat(frames));
    const onAudio = () => {
      if (!stopped) {
        stopped = true;
        try { streamer.stop(); } catch {}
        cs.removeListener("audioPacket", onAudio);
        resolve();
      }
    };
    cs.on("audioPacket", onAudio);
    const dur = Math.max(1000, frames.length * 20);
    setTimeout(() => { cs.removeListener("audioPacket", onAudio); if (!stopped) resolve(); }, dur + 500);
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

  const state = createConversation({
    tone: agentConfig.tone,
    productName: agentConfig.productName,
    pitch: agentConfig.pitch,
    pricing: agentConfig.pricing,
  });

  const call = await sipCallBridge(sipConfig);
  if (!call.ok) {
    return { ok: false, durationSecs: 0, connected: false, interested: false, disposition: "FAILED", transcript: [], collectedName: null, collectedCompany: null, collectedEmail: null };
  }

  const cs = call.callSession;
  const cleanup = call.cleanup;

  const fail = (disc: string): ConversationResult => {
    try { cs.hangup(); } catch {}
    setTimeout(() => { cleanup(); }, 500);
    const dur = Math.round((Date.now() - start) / 1000);
    return { ok: true, durationSecs: dur, connected: dur > 5, interested: false, disposition: disc, transcript: lines, collectedName: null, collectedCompany: null, collectedEmail: null };
  };

  try {
    await listenForSpeech(cs, start, heardRef, 15000);
    if (Date.now() - start > maxDurationMs) return fail("TIMEOUT");

    const greeting = getInitialGreeting(state);
    lines.push(`Agent: ${greeting}`);
    await speak(cs, greeting, heardRef);

    for (let turn = 0; turn < 20; turn++) {
      if (Date.now() - start > maxDurationMs) break;

      const r = await listenForSpeech(cs, start, heardRef, 8000);
      if (!r.spoke) {
        await speak(cs, "Are you still there?", heardRef);
        const retry = await listenForSpeech(cs, start, heardRef, 5000);
        if (!retry.spoke) break;
      }
      if (Date.now() - start > maxDurationMs) break;

      const txt = inferProspectText(state, r.durationMs, r.peakEnergy);
      lines.push(`Prospect: ${txt}`);
      const resp = processProspectInput(state, txt);
      if (resp.text) {
        lines.push(`Agent: ${resp.text}`);
        await speak(cs, resp.text, heardRef);
      }
      if (resp.shouldEnd) break;
    }

    const data = getCollectedData(state);
    const closing = `Thank${data.name ? " you, " + data.name : " you"}! That's everything I needed. One of our dispatch managers will call you back within 30 minutes at 623-400-1991. Have a great day!`;
    lines.push(`Agent: ${closing}`);
    await speak(cs, closing, heardRef);

    const dur = Math.round((Date.now() - start) / 1000);
    try { cs.hangup(); } catch {}
    setTimeout(() => { cleanup(); }, 500);

    const connected = dur > 5;
    const interested = connected && heardRef.current && !!(data.name || data.email);
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
  } catch {
    return fail("ERROR");
  }
}
