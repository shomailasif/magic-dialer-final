/* audio-sim.js - offline audio harness for the REAL conversation pipeline.
 *
 * WHY THIS EXISTS
 * ---------------
 * Live calls show two reported defects that no text simulator can reproduce:
 *
 *   1. The agent answers 9-13s after the prospect stops talking, and nobody can
 *      say which stage owns those seconds - end-of-speech detection, STT, the
 *      brain, or TTS. call-sim.js drives the real brain but the prospect is a
 *      string, so three of those four stages are stubs and the total means
 *      nothing.
 *   2. The prospect's speech gets cut off ("it's the" and then the digits as a
 *      separate turn) and the agent repeats its opener. Both live in the AUDIO
 *      path: the VAD closes the window early, or the recognizer returns a
 *      fragment. Text in, text out, and neither can ever happen.
 *
 * So this is call-sim.js with the audio put back. Real WAV in, real VAD (vad.js
 * with the options the controller passes), real STT (multilingual-stt.js), real
 * brain (intelligent-brain.js driven by call-runner.js), real TTS (voice.js
 * speakToBuffer) - all of it through the REAL controller
 * (local-call-controller.runLocalCallBody) with the RingCentral engine replaced
 * by a local media engine that emits PCMU frames at wall-clock pace. Every stage
 * is timed and the timings are the output of this tool.
 *
 * IT NEVER PLACES A CALL. There is no SIP, no RTP and no carrier here. The
 * engine is injected, so createLocalRingCentralEngine is never called and its
 * bridge (portal/softphone.sipCallBridge) is never reached; runLocalCall is not
 * used either - only runLocalCallBody, which is the conversation and nothing
 * that can dial. The voip block carries literal placeholders and no credential
 * is read from anywhere: assertNoTelephony() fails the run if a real credential
 * ever reached the engine factory.
 *
 *   node src/management/build/audio-sim.js <scenario> [--verbose] [--json]
 *   node src/management/build/audio-sim.js all
 *   node src/management/build/audio-sim.js --list
 *
 * Scenarios: greeting-first, reopen, interrupt.
 *
 * Provider note: the portal gateway decides whether it will talk to this PC, and
 * it answers 401 for a machine it has not re-enrolled. That is reported loudly
 * rather than being allowed to look like "the brain is slow": in that case the
 * harness runs the real Groq STT and chat endpoints directly, so the calls are
 * still real network calls and the millisecond numbers are still real. Only the
 * gateway hop itself is not exercised.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MGMT = path.join(__dirname, "..");
const AGENT = path.join(MGMT, "agent");
const REPO = path.join(MGMT, "..", "..");
const FIXTURES = path.join(__dirname, "fixtures");

const { createVad: realCreateVad } = require(path.join(AGENT, "vad.js"));
const { mulawEncode, speakToBuffer: realSpeakToBuffer } = require(path.join(AGENT, "voice.js"));
const { transcribeAuto: realTranscribeAuto } = require(path.join(AGENT, "multilingual-stt.js"));
const { sttAuthorised } = require(path.join(AGENT, "stt-preflight.js"));

/* Brain instrumentation, installed BEFORE anything else in this file requires
 * the controller.
 *
 * local-call-controller -> call.js -> call-runner.js destructures
 * `{ nextTurn, opening }` out of intelligent-brain at require time, so a patch
 * applied after that is patching an object nobody reads again and the brain
 * column of the latency table stays empty. The patch delegates to a module-level
 * holder that each run swaps in, so the real functions still run and every call
 * is still timed. */
let brainTelemetry = null;
require(path.join(AGENT, "intelligent-brain.js"));
(function installBrainInstrumentation() {
  const mod = require(path.join(AGENT, "intelligent-brain.js"));
  for (const name of ["nextTurn", "opening"]) {
    const real = mod[name];
    if (typeof real !== "function") continue;
    mod[name] = async function timed(...args) {
      const tel = brainTelemetry;
      if (tel) tel.onBrainStart();
      try {
        const res = await real.apply(this, args);
        /* The RESULT is passed through, not just the timing. A provider failure
         * comes back as `{text:"", error:"Groq HTTP 429"}`, and call-runner then
         * speaks a canned recovery line. Without seeing the error here, that
         * looks exactly like a brain that answered badly - the harness would
         * report a conversation defect when the truth is a rate limit. */
        if (tel) tel.onBrainEnd(res);
        return res;
      } catch (e) {
        if (tel) tel.onBrainEnd({ text: null, error: String((e && e.message) || e) });
        throw e;
      }
    };
  }
})();

const { runLocalCallBody } = require(path.join(AGENT, "local-call-controller.js"));

/* Must match local-call-controller.js, which calls
 * makeVad({ minSpeechMs: 160, endSilenceMs: 700 }) and then holds the window
 * open a further SPEECH_HOLD_MS. Those are the numbers every turn is measured
 * against. */
const VAD_OPTS = { minSpeechMs: 160, endSilenceMs: 700 };
const SPEECH_HOLD_MS = 250;
const FRAME_BYTES = 160;          // 20ms of PCMU/8000 - the engine's contract
const FRAME_MS = 20;
const SILENCE_BYTE = 0xff;

/* Placeholders only. Nothing here is a credential and nothing reads one: the
 * engine is injected, so these values are never used to register or dial. */
const OFFLINE_VOIP = {
  ready: true,
  username: "audio-sim-offline",
  sipPassword: "audio-sim-offline",
  number: "0000000000",
  domain: "audio-sim.invalid",
  server: "audio-sim.invalid",
  port: 5060,
};

/* ---------- WAV ---------- */

/** Parse a PCM WAV into mono Linear16 samples at its own rate.
 *
 *  Hand-rolled rather than reusing voice.js wavToMono16, which accepts 16-bit
 *  only: a fixture recorded at 24 kHz or in 8-bit has to come out as audio, not
 *  as null.
 *
 *  Returns { samples: Int16Array, rate, channels, bits } or null. */
function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let pos = 12;
  let format = 1, channels = 0, rate = 0, bits = 0, data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      data = buf.subarray(body, Math.min(body + size, buf.length));
      break;
    }
    pos = body + size + (size % 2);
  }
  if (!data || !rate || !channels || (format !== 1 && format !== 0xfffe)) return null;
  if (bits !== 8 && bits !== 16) return null;
  const width = bits / 8;
  const frames = Math.floor(data.length / (channels * width));
  if (frames <= 0) return null;
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const at = (i * channels + c) * width;
      acc += bits === 16 ? data.readInt16LE(at) : (data[at] - 128) * 256;
    }
    out[i] = Math.round(acc / channels);
  }
  return { samples: out, rate, channels, bits };
}

/** Linear-interpolating resample to 8 kHz telephone rate. */
function resampleTo8k(samples, rate) {
  if (rate === 8000) return samples;
  const ratio = rate / 8000;
  const outLen = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = src - i0;
    out[i] = Math.round(samples[i0] * (1 - frac) + samples[i1] * frac);
  }
  return out;
}

/** Linear16 mono -> PCMU/8000 in whole 160-byte frames, silence padded. */
function toPcmuFrames(samples, rate) {
  const at8 = resampleTo8k(samples, rate);
  const mulaw = Buffer.allocUnsafe(at8.length);
  for (let i = 0; i < at8.length; i++) mulaw[i] = mulawEncode(at8[i]);
  const rem = mulaw.length % FRAME_BYTES;
  return rem ? Buffer.concat([mulaw, Buffer.alloc(FRAME_BYTES - rem, SILENCE_BYTE)]) : mulaw;
}

/** One WAV file -> PCMU frames. What the scenarios actually play. */
function wavFileToPcmu(file) {
  const parsed = parseWav(fs.readFileSync(file));
  if (!parsed) throw new Error("not a PCM WAV: " + file);
  return { pcmu: toPcmuFrames(parsed.samples, parsed.rate), rate: parsed.rate, bits: parsed.bits, channels: parsed.channels };
}

/* ---------- fixture synthesis, so no binary blobs are committed ---------- */

function mulawDecode(u) {
  u = (~u) & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 1) + 0x21) << (exponent + 2);
  sample -= 0x84;
  return sign ? -sample : sample;
}

/** PCMU bytes back into a playable 8 kHz mono WAV (fixtures are stored as WAV). */
function pcmuToWav(pcmu, rate = 8000) {
  const pcm = Buffer.allocUnsafe(pcmu.length * 2);
  for (let i = 0; i < pcmu.length; i++) {
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, mulawDecode(pcmu[i]))), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const FIXTURE_TEXT = {
  "hello": "Hello?",
  "who-is-it": "Who is it?",
  "what-need": "What do you need?",
  "yes-go": "Yes, go ahead.",
  "all-done": "That is all, thanks.",
  "on-the-go": "Hold on, I am driving right now.",
  "mcn": "My MC number is 623400.",
  "too-busy": "I am a bit busy right now, can I call you back later?",
};

/** Speak a line with Windows SAPI. The only synthesizer guaranteed on a
 *  customer PC. Returns both the PCMU frames the engine plays and the 16 kHz WAV
 *  a fixture file holds, so the two paths produce the same fixture bytes. */
function synthesizeLine(text, { voice = "Microsoft David Desktop", withWav = false } = {}) {
  const file = path.join(os.tmpdir(), "audio-sim-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7) + ".wav");
  const script = `
    Add-Type -AssemblyName System.Speech
    $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    foreach($v in $s.GetInstalledVoices()) { if($v.VoiceInfo.Name -eq '${String(voice).replace(/'/g, "''")}') { $s.SelectVoice($v.VoiceInfo.Name); break } }
    $s.SetOutputToWaveFile('${file.replace(/\\/g, "/").replace(/'/g, "''")}', $fmt)
    $s.Speak('${String(text).replace(/'/g, "''")}')
    $s.SetOutputToNull()
    $s.Dispose()
  `;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 60000 });
  if (r.status !== 0 || !fs.existsSync(file)) throw new Error("SAPI could not speak: " + String(r.stderr || "").trim());
  try {
    const wav = fs.readFileSync(file);
    const parsed = parseWav(wav);
    if (!parsed) throw new Error("SAPI wrote a WAV this harness cannot parse");
    const pcmu = toPcmuFrames(parsed.samples, parsed.rate);
    /* withWav keeps SAPI's own 16 kHz samples rather than re-encoding to 8 kHz, so
       a fixture generated on demand is the same kind of file make-fixtures.ps1
       writes and both routes exercise parseWav -> resample -> toPcmuFrames. */
    return withWav ? { pcmu, wav } : pcmu;
  } finally {
    try { fs.unlinkSync(file); } catch { /* best effort */ }
  }
}

/** Path to a fixture, generating it with SAPI if it is not on disk, so no audio
 *  binaries have to be committed. */
function fixturePath(id) {
  const file = path.join(FIXTURES, id + ".wav");
  if (fs.existsSync(file)) return file;
  const text = String(FIXTURE_TEXT[id] || "").trim();
  if (!text) throw new Error("unknown fixture \"" + id + "\" and no text to synthesize it from");
  fs.writeFileSync(file, synthesizeLine(text, { withWav: true }).wav);
  return file;
}

/* ---------- scenarios ---------- */

/* Each step is one thing the prospect does, and each is pinned to agent playback
 * so the scenario is deterministic instead of racing the conversation.
 *   clip            fixture id
 *   afterPlayback   release this step N ms after playback N ends (default 1).
 *                   Turn 1 is the prepared opening, so afterPlayback:1 means the
 *                   prospect answers the phone like a person does.
 *                   afterPlayback:0 means BEFORE any agent audio at all, which is
 *                   what a person who picks up and says "Hello?" actually does -
 *                   and what the agent's speech gate is waiting for. It cannot be
 *                   the default any more: with the opener gated on real inbound
 *                   speech, pinning the greeting to playback 1 would deadlock,
 *                   because playback 1 is now the REPLY to the greeting.
 *   atPlayback      ms into playback N to start instead, which is what talking
 *                   over the agent sounds like. Overrides afterPlayback.
 *   gapMs           silence before the step
 *   leadMs          silence before the clip inside the step (VAD noise floor)
 *   tailMs          silence after the clip; must clear endSilenceMs + hold, or the
 *                   next clip is swallowed into this turn - which is the
 *                   truncation defect being reproduced, so it is not a bug here.
 *   delayMs         pause between playback N starting and the step's audio
 */
const SCENARIOS = {
  "greeting-first": {
    description: "the prospect picks up and speaks before the agent does, then asks who it is and what it wants",
    steps: [
      /* afterPlayback:0 - the prospect answers the phone. They speak before any
       * agent audio exists, which is the whole point of the speech gate. */
      { clip: "hello", afterPlayback: 0, gapMs: 250 },
      /* Playback 1 is now the REPLY to that greeting, not the opening, so every
       * later step is pinned one lower than it used to be. The rest wait for the
       * agent's reply to FINISH and add their own silence; pinned to a fixed
       * offset into the next playback instead, they would overlap the tail of
       * their own clip with the next question and the two would merge into one
       * turn - which is the truncation defect being reproduced, not a scenario,
       * so the scenario must not create it by accident. */
      { clip: "who-is-it", afterPlayback: 1, gapMs: 900 },
      { clip: "what-need", afterPlayback: 2, gapMs: 900 },
      { clip: "all-done", afterPlayback: 3, gapMs: 900 },
    ],
    expect: {
      maxOpeners: 1,
      noRepeatedLines: true,
      /* The agent must not open at all here: the prospect spoke first, so the
       * first agent line is a reply to them, and it may only contain ONE
       * introduction. Zero is the correct answer, and this is what the 07 Oct
       * call got wrong ("Hi, this is Atlas..." at t+7s over "Hello?" at t+7s). */
      maxOpenersBeforeProspectSpeech: 0,
      /* "Who is it?" has to be answered with the name, and "what do you need?"
       * with the reason for the call. Neither may be answered with a question. */
      answered: [
        { clip: "who-is-it", mustMatch: /\batlas\b|\bzaz\b|this is/i },
        { clip: "what-need", mustMatch: /call|about|offer|service|dispatch|information|help/i },
      ],
    },
  },
  reopen: {
    description: "the prospect speaks first, answers, then goes quiet; the agent must re-open once, not twice",
    steps: [
      { clip: "hello", afterPlayback: 0, gapMs: 250 },
      { clip: "yes-go", afterPlayback: 1, gapMs: 300 },
      /* The prospect stops talking and never says goodbye. A quiet window is
       * 5000ms, so this 6000ms gap is deliberately longer: it forces the agent to
       * speak into silence at least once, which is the behaviour under test.
       * It lands mid-turn, so the run continues and a SECOND quiet window can
       * happen - which is exactly how the repeated opener shows up. */
      { clip: "all-done", afterPlayback: 2, gapMs: 6000 },
    ],
    expect: {
      maxOpeners: 1,
      maxOpenersBeforeProspectSpeech: 0,
      noRepeatedLines: true,
      /* A re-open is a greeting, a "good time to talk" or a connectivity check.
       * Once is persistence. Twice is the canned loop. */
      maxReopens: 1,
    },
  },
  interrupt: {
    description: "the prospect speaks first, then talks over the agent mid-turn, and must still be heard",
    steps: [
      { clip: "hello", afterPlayback: 0, gapMs: 250 },
      /* Lands in the middle of the agent's reply to the greeting. 1.8s of
       * sustained speech clears the 400ms barge-in bar, so playback really is cut
       * off. */
      { clip: "on-the-go", afterPlayback: 1, atPlayback: 1200, gapMs: 250 },
      { clip: "mcn", afterPlayback: 2, gapMs: 400 },
      { clip: "all-done", afterPlayback: 3, gapMs: 400 },
    ],
    expect: {
      maxOpenersBeforeProspectSpeech: 0,
      noRepeatedLines: true,
      /* Barge-in itself is not the defect; a lost interrupting turn is. */
      bargeIn: true,
      /* The interrupting clip must reach the recognizer, so the next agent turn
       * has to react to it rather than carrying on as if nothing was said. */
      interruptHeard: true,
    },
  },
};

/* ---------- configuration and provider resolution ---------- */

function loadLiveConfig() {
  const file = path.join(process.env.USERPROFILE || os.homedir(), ".magicdialer", "config.json");
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      portal: c.portalUrl || null,
      deviceToken: c.deviceToken || null,
      persona: c.persona,
      companyName: c.companyName,
      product: c.product,
      leadFields: c.leadFields,
      callbackNumber: c.callbackNumber,
      callbackIn: c.callbackIn,
      contactEmail: c.contactEmail,
      lang: c.lang,
      voiceStyle: c.voiceStyle,
    };
  } catch {
    return { portal: null, deviceToken: null };
  }
}

function loadDotEnv() {
  try {
    for (const line of fs.readFileSync(path.join(REPO, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const value = m[2].trim().replace(/^"(.*)"$/, "$1");
      if (!process.env[m[1]]) process.env[m[1]] = value;
    }
  } catch { /* no .env: the portal gateway has to be the way through */ }
}

/** Which real provider this run talks to. Both options are real calls; only the
 *  door differs. The portal gateway 401s a machine it has not re-enrolled, and
 *  that must not be allowed to masquerade as "the brain is slow". */
async function resolveProviders(warnings, force) {
  const live = loadLiveConfig();
  if (force === "portal") return { mode: "portal", portal: live.portal, deviceToken: live.deviceToken };
  if (force === "direct") return { mode: "groq-direct", portal: null, deviceToken: null };
  if (!live.portal || !live.deviceToken) {
    loadDotEnv();
    warnings.push("no portal/deviceToken in %USERPROFILE%\\.magicdialer\\config.json; using the real Groq endpoints directly");
    return { mode: "groq-direct", portal: null, deviceToken: null };
  }
  const probe = await sttAuthorised({ portal: live.portal, deviceToken: live.deviceToken });
  if (probe && probe.fatal) {
    loadDotEnv();
    if (!process.env.GROQ_API_KEY && !process.env.AUTODIAL_GROQ_KEY) {
      warnings.push("portal gateway rejected this PC (" + probe.reason + ") and there is no GROQ_API_KEY either: this run cannot measure anything real");
      return { mode: "none", portal: live.portal, deviceToken: live.deviceToken };
    }
    warnings.push("portal gateway rejected this PC (" + probe.reason + "); running the real Groq STT/brain endpoints directly instead. Timings are still real network calls; the gateway hop is not exercised.");
    return { mode: "groq-direct", portal: null, deviceToken: null };
  }
  return { mode: "portal", portal: live.portal, deviceToken: live.deviceToken };
}

/* ---------- analysis ---------- */

/** Dangling function word: a turn that stops exactly where a sentence would have
 *  continued. "what do you", "i was just", "can i get" are all this. */
const DANGLING = /\b(?:you|your|yours|the|a|an|to|of|for|and|or|with|from|at|on|in|about|is|are|was|were|am|be|been|can|could|would|will|shall|should|may|might|must|just|like|my|our|their|that|this|it|his|her|them|us|me|i|got|had|need|want|help)\s*[.?!]?$/i;

/* True when a transcript looks cut off.
 *
 * A QUESTION IS EXEMPT. "Who is it?" ends on the function word "it" and
 * "What do you need?" ends on "need", and both are complete turns - flagging
 * them would make the tool cry wolf on the most ordinary thing a prospect does.
 * turn-length.js learned this the hard way on the 07 Oct call, where treating a
 * finished question as a fragment deleted whole sentences and the agent was
 * heard saying "Talk." and "Let.".
 *
 * What is left is the real defect: a statement with no terminator at all, or one
 * that stops on a function word, either of which is what a clipped frame comes
 * back as. The recognizer does punctuate its own truncations, so the terminator
 * alone cannot be trusted - the dangling word is the load-bearing signal. */
function truncationReason(text) {
  const s = String(text || "").trim();
  if (s.length < 5) return null;
  if (s.replace(/[^\p{L}\p{N}]/gu, "").length < 4) return null;
  if (s.split(/\s+/).length < 2) return null;
  const isQuestion = /\?\s*["')\u2019]?$/.test(s);
  if (isQuestion) return null;
  const stripped = s.replace(/[.!?,;:]+$/, "");
  if (DANGLING.test(stripped)) return "ends on a dangling function word: " + JSON.stringify(s.slice(-40));
  if (!/[.!?]["')\u2019]?$/.test(s)) return "no sentence terminator, so the turn was cut off: " + JSON.stringify(s.slice(-40));
  return null;
}

const normLine = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

/** Near-duplicate detection. The exact repeat is the reported bug; the
 *  high-overlap case is the same bug with different punctuation. */
function similarLines(a, b) {
  const x = normLine(a), y = normLine(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const ta = new Set(x.split(" ")), tb = new Set(y.split(" "));
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  const denom = Math.min(ta.size, tb.size);
  return denom > 0 && shared / denom >= 0.9;
}

/** The stage timings, in the order a turn actually spends them. */
const STAGE_LABELS = {
  eos: "last speech sample -> end of speech",
  hold: "end of speech -> STT start (SPEECH_HOLD_MS)",
  stt: "STT",
  brain: "brain / LLM",
  tts: "TTS synthesis",
  total: "prospect stop -> agent audio ready",
};

/** Per-turn latency + defect checks. Returns { defects, slowStages }. */
function analyseTurns(turns, opts) {
  const threshold = Number((opts && opts.stageBudgetMs) || 2500);
  const defects = [];
  const slow = [];
  for (const t of turns) {
    for (const stage of Object.keys(STAGE_LABELS)) {
      const ms = t[stage + "Ms"];
      if (ms == null) continue;
      if (ms > threshold) slow.push({ turn: t.index, stage, ms, label: STAGE_LABELS[stage] });
    }
    if (t.prospectText) {
      const why = truncationReason(t.prospectText);
      if (why) defects.push({ kind: "truncation", turn: t.index, detail: "prospect turn " + t.index + " " + why });
    }
    const agentLines = t.agentLines || [];
    let repeated = false;
    for (let i = 1; i < agentLines.length && !repeated; i++) {
      for (let j = 0; j < i; j++) {
        if (similarLines(agentLines[j], agentLines[i])) {
          defects.push({ kind: "repetition", turn: t.index, detail: "agent repeated a line within turn " + t.index + ": " + JSON.stringify(String(agentLines[i]).slice(0, 80)) });
          repeated = true;
          break;
        }
      }
    }
  }
  return { defects, slowStages: slow };
}

const OPENER_RE = /^(?:hi|hello|hey)[,.!]?\s+(?:this is|i'?m calling|i am calling|it'?s)\b/i;
const REOPEN_RE = /\b(is (?:now )?(?:this|it) a (?:good|okay|ok) time|good time to (?:talk|chat)|are you (?:still )?there|just checking|can you hear me|hello there)\b/i;

/** Scenario expectations, measured off the transcript. */
function checkExpectations(report, expect) {
  const problems = [];
  if (!expect) return problems;
  const agent = (report.agentLines || []).map(String);
  /* Judged against what the recognizer returned (heardLines), not only the
     transcript: the prospect's words are the STT result whether or not the loop
     kept them, and the interruption check is about those words existing at all. */
  const lead = (report.heardLines || report.leadLines || []).map(String);
  const exp = (report.expect && report.expect.clipText) || FIXTURE_TEXT;

  const openers = agent.filter((l) => OPENER_RE.test(l.trim()));
  if (expect.maxOpeners != null && openers.length > expect.maxOpeners) {
    problems.push("agent opened " + openers.length + " times (at most " + expect.maxOpeners + " expected, more is the repeated opener): " + JSON.stringify(openers.map((o) => o.slice(0, 44))));
  }
  if (expect.maxReopens != null) {
    const reopens = agent.filter((l) => REOPEN_RE.test(l));
    if (reopens.length > expect.maxReopens) {
      problems.push("agent re-opened " + reopens.length + " times, at most " + expect.maxReopens + " expected: " + JSON.stringify(reopens.map((r) => r.slice(0, 44))));
    }
  }
  /* The rule this whole harness was rebuilt for: the agent does not begin
   * talking until the other person has spoken. Judged on the real timestamps -
   * the VAD's own `speaking` against the first outbound playback - and not on
   * the words, because a correct-looking reply that was spoken over somebody's
   * first word is exactly the defect. */
  if (expect.maxOpenersBeforeProspectSpeech != null) {
    if (report.firstProspectSpeechAt == null) {
      problems.push("the prospect never spoke (no VAD speech at all), so this run cannot show the agent waiting for them");
    } else if (report.firstAgentAudioAt == null) {
      problems.push("the agent never spoke, so there is nothing to judge against the prospect's first words");
    } else if (report.firstAgentAudioAt < report.firstProspectSpeechAt) {
      problems.push(
        "the agent put audio on the wire " + (report.firstProspectSpeechAt - report.firstAgentAudioAt) +
        "ms BEFORE the prospect said anything: the opening is not gated on their speech"
      );
    }
  }
  for (const rule of expect.answered || []) {
    const wanted = normLine(exp[rule.clip] || "");
    const pos = lead.findIndex((l) => wanted && similarLines(l, wanted));
    if (pos < 0) {
      problems.push("the \"" + rule.clip + "\" line never reached the transcript, so its answer was never checked");
      continue;
    }
    const replies = agent.slice(pos).filter((l) => rule.mustMatch.test(l));
    if (!replies.length) {
      problems.push("after \"" + rule.clip + "\" the agent never said anything matching " + rule.mustMatch);
      continue;
    }
    /* Answering "who is it?" with another question is the defect as much as
     * failing to answer it. */
    if (rule.noQuestion && replies.some((l) => /\?\s*["')\u2019]?$/.test(l.trim()) && !rule.allowQuestion)) {
      problems.push("after \"" + rule.clip + "\" the agent answered with a question instead of an answer: " + JSON.stringify(replies[0].slice(0, 70)));
    }
  }
  if (expect.interruptHeard) {
    /* The interrupting clip is the one that landed during playback. If the
     * recognizer never saw its words, the prospect was talked over. */
    const wanted = normLine((exp["on-the-go"] || "Hold on I am driving right now").split(/\s+/).slice(0, 4).join(" "));
    const heard = lead.some((l) => wanted && normLine(l).includes(wanted));
    if (!heard) {
      problems.push("the interrupting clip (\"" + (exp["on-the-go"] || "") + "\") never reached the transcript: the prospect talked over the agent and was dropped");
    }
  }
  if (expect.bargeIn && !report.bargeIns) {
    problems.push("no barge-in was detected: the prospect talked over the agent and playback was never interrupted");
  }
  return problems;
}

/* ---------- media engine (replaces RingCentral, dials nothing) ---------- */

/**
 * Local engine with the same surface local-call-controller.js uses:
 *   connect() / waitForInboundMedia(ms) / sendAudio(buf) / interrupt()
 *   keepAlive() / close() / status()
 * plus opts.onAudio, which it calls with 160-byte PCMU frames.
 *
 * sendAudio resolves with the byte count once the audio would have finished
 * playing, so playback really lasts as long as the TTS is long and a barge-in
 * really cuts the turn off mid-sentence.
 */
function createLocalMediaEngine(opts) {
  const onAudio = opts.onAudio;
  const onLog = opts.onLog || (() => {});
  const script = opts.script || [];
  /* Clamped to at least 1ms: the clock divides by this, and 0 would make every
     frame instantly due. */
  const frameDelayMs = Math.max(1, Number(opts.frameDelayMs == null ? FRAME_MS : opts.frameDelayMs));

  let connected = false, closed = false;
  let clockAnchor = Date.now();
  let bytesIn = 0, bytesOut = 0, keepAliveSends = 0;
  let playSeq = 0, playing = null;
  let feedChain = Promise.resolve();
  let scriptQueued = false;
  function queueScriptOnce() {
    if (scriptQueued) return;
    scriptQueued = true;
    queueScript();
  }

  const log = (m) => { try { onLog(m); } catch { /* logging must never break a run */ } };
  const silence = (ms) => Buffer.alloc(Math.max(1, Math.round(ms / FRAME_MS)) * FRAME_BYTES, SILENCE_BYTE);

  /* Wall-clock pacing, not setTimeout(20) per frame.
   *
   * Windows timers fire at ~15.6ms, so a naive setTimeout(20) frame clock emits
   * one frame every ~31ms and the prospect's audio runs 1.5x slower than the
   * wall clock - which silently invalidates every number this tool prints and
   * lets a clip finish after playback the barge-in was supposed to interrupt.
   * Frames are therefore released against an elapsed-time budget with a small
   * send-ahead, the same trick local-ringcentral-engine.js uses for outbound
   * RTP. */
const PACE_TICK_MS = 8;
const PACE_LEAD_FRAMES = 2;

  /* A CONTINUOUS 160-byte frame clock, not per-clip bursts.
   *
   * Real inbound RTP is 20ms of audio every 20ms for the whole call, silence
   * included, and the controller depends on it: its SPEECH_HOLD_MS timer is only
   * evaluated inside the onAudio frame loop, so with no frames arriving the
   * 250ms hold cannot expire and the turn is reported as if it held for seconds.
   * Emitting per clip therefore does not just distort the numbers, it changes
   * the behaviour under test - the first version of this harness measured a
   * 4.3s "hold" that was entirely the harness's own silence.
   *
   * So: one clock, always running, emitting whatever the scenario has queued for
   * that moment and mu-law silence (0xff) otherwise. It stops on close(). */
  const clock = { timer: null, queue: [], emitted: 0 };
  let silenceBuf = Buffer.alloc(FRAME_BYTES, SILENCE_BYTE);

  function frameClockTick() {
    clock.timer = null;
    if (closed) return;
    const tickStartedAt = Date.now();
    /* How many frames SHOULD have gone out by now, counted from the clock
     * anchor. This has to be a count and not a decrementing "due": the tick runs
     * every ~16ms while a frame is 20ms, so a loop that emits "up to due" each
     * tick runs the whole stream faster than real time and every timing in the
     * report is compressed by exactly that factor. */
    const owed = Math.floor((tickStartedAt - clockAnchor) / frameDelayMs) + 1 + PACE_LEAD_FRAMES;
    while (clock.emitted < owed) {
      let frame = silenceBuf;
      const active = clock.queue.find((q) => q.i < q.buf.length);
      if (active) {
        frame = active.buf.subarray(active.i, Math.min(active.i + FRAME_BYTES, active.buf.length));
        active.i += FRAME_BYTES;
      }
      clock.emitted++;
      bytesIn += FRAME_BYTES;
      onAudio(frame);
    }
    const spent = Date.now() - tickStartedAt;
    clock.timer = setTimeout(frameClockTick, Math.max(1, Math.min(frameDelayMs, PACE_TICK_MS) - spent));
  }

  /* Compressed mode still runs a real clock, just a fast one (a few ms a frame).
   * Stopping the clock entirely was tried and is wrong: the controller's
   * SPEECH_HOLD_MS expiry is only evaluated inside the frame loop, so with no
   * frames arriving a turn can never close and the run hangs instead of
   * finishing quickly. Compressed runs therefore still take real wall clock for
   * the controller's own timers - they are part of what is under test - they
   * just spend a fraction of it on audio, and their latency numbers are
   * meaningless, which the output says. */
  function startClock() {
    if (clock.timer || closed) return;
    clockAnchor = Date.now();
    clock.timer = setTimeout(frameClockTick, 0);
  }

  function queueAudio(buf) {
    clock.queue.push({ buf, i: 0 });
    startClock();
  }

  /** The frame clock runs for its whole length; resolve when it has drained. */
  function emitFrames(buf) {
    queueAudio(buf);
    return new Promise((resolve) => {
      const check = () => {
        if (closed) return resolve();
        const done = clock.queue.every((q) => q.i >= q.buf.length);
        if (done) return resolve();
        setTimeout(check, frameDelayMs);
      };
      check();
    });
  }

/* The prospect's script, pinned to agent playback.
   *
   * Each step waits for its playback (either "N ms into playback N" for talking
   * over the agent, or "N ms after playback N ends" for answering it) and the
   * steps run one at a time, so the prospect cannot answer a question the agent
   * has not asked yet. Pinning to playback instead of wall clock is what makes a
   * scenario reproducible: the brain's reply length varies, and the prospect
   * must not answer a question that has not happened. */
  let playStarted = 0;
  let playEnded = 0;
  let playWaiters = [];

  /* A step with atPlayback waits for playback N to START; otherwise it waits for
   * playback N to END. Those are different moments and conflating them is what
   * makes a scripted prospect go silent. */
  /* A step with afterPlayback:0 plays before any agent audio exists. That is the
   * prospect picking up the phone, and it is what the agent's speech gate waits
   * for - so it must not wait for a playback that cannot happen yet. */
  function waitForPlayback(n, into) {
    const started = into != null;
    if (n <= 0 && !started) return Promise.resolve();
    if ((started ? playStarted : playEnded) >= n) {
      return into > 0 ? new Promise((r) => setTimeout(r, into)) : Promise.resolve();
    }
    return new Promise((resolve) => {
      playWaiters.push({ n, into, started, resolve });
    });
  }

  function flushWaiters(started) {
    for (const w of playWaiters.slice()) {
      const reached = w.started ? playStarted >= w.n : playEnded >= w.n;
      if (!reached) continue;
      playWaiters.splice(playWaiters.indexOf(w), 1);
      if (w.into > 0) setTimeout(w.resolve, w.into);
      else w.resolve();
    }
    void started;
  }

  function queueScript() {
    for (const step of script) {
      feedChain = feedChain.then(async () => {
        await waitForPlayback(step.afterPlayback == null ? 1 : step.afterPlayback, step.atPlayback);
        const lead = silence(step.leadMs == null ? 400 : step.leadMs);
        if (step.gapMs) await new Promise((r) => setTimeout(r, step.gapMs));
        await emitFrames(lead);
        const tail = silence(step.tailMs == null ? 1600 : step.tailMs);
        await emitFrames(Buffer.concat([step.pcmu, tail]));
      });
    }
    return feedChain;
  }

  function play(buf) {
    return new Promise((resolve) => {
      if (closed) return resolve(0);
      const id = ++playSeq;
      const audioMs = Math.ceil(buf.length / 8); // PCMU/8000: one byte is one ms
      let done = false;
      const finish = (why) => {
        if (done) return;
        done = true;
        if (playing && playing.id === id) playing = null;
        playEnded++;
        flushWaiters(false);
        if (opts.onPlaybackEnd) opts.onPlaybackEnd({ bytes: buf.length, audioMs, finishedEarly: why === "interrupt", at: Date.now() });
        resolve(buf.length);
      };
      playing = { id, finish: () => finish("interrupt") };
      bytesOut += buf.length;
      playStarted++;
      flushWaiters(true);
      if (opts.onPlaybackStart) opts.onPlaybackStart({ bytes: buf.length, audioMs, at: Date.now() });
      // Real playback lasts as long as the audio does. Compressed mode shortens
      // it so an offline test finishes; its latencies are flagged as not real.
      const wait = frameDelayMs >= FRAME_MS ? audioMs : Math.max(1, Math.round(audioMs / 24));
      setTimeout(() => finish("complete"), wait);
    });
  }

  return {
    async connect() {
      connected = true;
      /* The frame clock starts here, before any audio is queued, because a real
       * call has inbound RTP from the moment it is answered. */
      startClock();
      /* And the prospect's script starts here too.
       *
       * A person picks up the phone when it is ANSWERED, not when the agent first
       * speaks, and the agent's opening now waits for their voice - so their
       * first words have to be able to arrive before any outbound audio exists.
       * Queueing the script on the first sendAudio made that impossible, and it
       * looked fine only because every step used to be pinned to a playback and
       * playback 1 was the opening: the two could not be told apart. With the
       * opening gated, "afterPlayback: 0" would have been a deadlock and
       * "before any agent audio" would have been untestable. */
      queueScriptOnce();
      log("[audio-sim] local media engine connected (no SIP, no RTP, nothing dialed)");
      return { connected: true };
    },
    async waitForInboundMedia(maxWaitMs = 1200) {
      const waited = Math.min(60, Math.max(0, Number(maxWaitMs) || 0));
      if (waited) await new Promise((r) => setTimeout(r, waited));
      return { gotInbound: true, waitedMs: waited };
    },
    sendAudio(buf) {
      if (!buf || !buf.length) return Promise.resolve(0);
      /* The script is queued at connect(), which is where a prospect's greeting
       * really starts. Kept idempotent here for an engine used without connect(). */
      queueScriptOnce();
      return play(buf);
    },
    /* Test seam: the frame clock is what makes the timing real, so a test that
     * compresses time has to be able to stop it. */
    stopClock() { if (clock.timer) clearTimeout(clock.timer); clock.timer = null; },
    interrupt() {
      const p = playing;
      playing = null;
      if (p) p.finish();
      log("[audio-sim] outbound playback interrupted (prospect barge-in)");
    },
    keepAlive() {
      // The real engine refuses keep-alive while audio is playing.
      if (!connected || closed || playing) return Promise.resolve(0);
      keepAliveSends++;
      return Promise.resolve(0);
    },
    status() { return { connected, bytesIn, bytesOut, frameBytes: FRAME_BYTES, codec: "PCMU/8000", keepAliveSends }; },
    close() {
      if (closed) return;
      closed = true;
      if (clock.timer) clearTimeout(clock.timer);
      clock.timer = null;
      log("[audio-sim] media stats: inbound " + bytesIn + " bytes, outbound " + bytesOut + " bytes, keep-alive sends " + keepAliveSends);
    },
  };
}

/* ---------- telemetry ---------- */

/* Per-turn latency records.
 *
 * The whole point of this tool is that these numbers are real, so where each one
 * comes from is worth stating: `eos` and `hold` are read off the REAL VAD's own
 * decisions (onVadPush), and `stt` / `brain` / `tts` are wall-clock around the
 * real calls. `total` is measured from the prospect's last voiced frame to the
 * moment the agent's TTS buffer exists - not to the end of playback, because a
 * prospect cannot hear a reply that has not been synthesised yet.
 *
 * The prepared opening is NOT a turn: it has no prospect speech to be measured
 * from. It gets its own record, because "how long from answer to first word" is
 * the single most-reported number on a live call and it would be wrong to leave
 * it out of the table entirely.
 */
function makeTelemetry() {
  const state = {
    turns: [],
    opening: { brainMs: 0, brainCalls: 0, ttsMs: null, ttsEngine: null, agentLines: [] },
    current: null,
    lastVoicedAt: 0,
    eosAt: 0,
    stt: null,
    brain: null,
    tts: null,
    ttsTarget: null,
    sawStt: false,
    bargeIns: 0,
    /* Whether agent audio is on the wire right now. Needed because the cost of a
       prospect who speaks over the agent is NOT in any stage column: their
       speech is buffered during playback and the turn does not even start until
       playback ends, so `hold` reads as the rest of the agent's sentence plus the
       hold. Without this flag that number is unexplainable. */
    playing: false,
    spokeDuringPlayback: false,
    /* When the far end first spoke, and when our audio first started. The
     * product rule is that we do not begin talking until they have spoken, and
     * these two timestamps are the only way a run can prove it rather than infer
     * it from the text. */
    firstVoicedAt: 0,
    firstAgentAudioAt: 0,
  };

  function turn() {
    if (!state.current) {
      state.current = {
        index: state.turns.length,
        eosMs: null, holdMs: null, sttMs: null, brainMs: null, ttsMs: null, totalMs: null,
        prospectText: "", agentLines: [], brainCalls: 0, ttsEngine: null,
      };
    }
    return state.current;
  }

  function finishTurn() {
    const t = state.current;
    if (!t) return;
    if (state.eosAt && state.lastVoicedAt) t.eosMs = state.eosAt - state.lastVoicedAt;
    if (state.eosAt && state.stt) t.holdMs = state.stt.startAt - state.eosAt;
    /* Flagged, not fixed: if the prospect spoke while the agent was still
       talking, the controller is still buffering their speech and cannot run STT
       until playback ends. The hold then contains the rest of the agent's own
       sentence, and a large `hold` here is a real cost to the prospect - it is
       just not the 250ms the constant suggests. */
    t.spokeDuringPlayback = state.spokeDuringPlayback;
    if (state.stt) t.sttMs = state.stt.endAt - state.stt.startAt;
    if (state.brain && state.brain.calls) {
      t.brainMs = state.brain.ms;
      t.brainCalls = state.brain.calls;
    }
    if (state.tts) t.ttsMs = state.tts.endAt - state.tts.startAt;
    state.turns.push(t);
    state.current = null;
    /* lastVoicedAt / eosAt are kept until the reply is attributed, because the
     * reply's total is measured from the prospect's last speech sample. */
    state.stt = null;
    state.brain = null;
    state.tts = null;
  }

  /* The agent's reply belongs to the turn it is answering.
   *
   * STT completes first, so the turn is pushed before the brain and TTS have
   * run - which means the reply's synthesis has nowhere to land and `total` was
   * being measured against the NEXT turn's speech (a negative number, or a
   * number that silently included an unrelated gap). So the reply is attached to
   * the most recent turn that does not yet have one. */
  function turnForReply() {
    for (let i = state.turns.length - 1; i >= 0; i--) {
      if (state.turns[i].totalMs == null) return state.turns[i];
    }
    return null;
  }

  return {
    state,
    turn,
    finishTurn,
    turnForReply,
    /* Called from the instrumented VAD with what the REAL VAD decided about the
     * frame just pushed. That is how "last speech sample" and "end of speech"
     * become real timestamps rather than estimates.
     *
     * `eosAt` is latched on the FIRST ended frame. The VAD's `ended` stays true
     * for every subsequent silent frame, so an unlatched assignment would keep
     * overwriting it and report an end-of-speech time measured from the end of
     * the silence rather than the start of it. */
    onVadPush(ev, at) {
      if (ev.voiced) {
        state.lastVoicedAt = at;
        if (state.playing) state.spokeDuringPlayback = true;
        /* The VAD's own `speaking` is the "they have spoken, not merely that
         * media arrived" signal - the same one the controller's speech gate
         * waits on. */
        if (ev.speaking && !state.firstVoicedAt) state.firstVoicedAt = at;
        /* Resumed speech cancels the controller's hold
         * (`if (event.voiced) state.holdUntil = 0`), so it has to cancel the
         * end-of-speech timestamp here too. Otherwise a prospect who pauses and
         * then carries on - which is the SPEECH_HOLD_MS behaviour under test -
         * is reported as having ended speech at the pause, and every later stage
         * of that turn is inflated by the resumed part. */
        state.eosAt = 0;
        return;
      }
      /* `ended` stays true for every subsequent silent frame, so it is latched
       * once rather than reassigned; an unlatched value would keep moving and
       * measure end-of-speech from the end of the silence instead of the
       * start of it. */
      if (ev.ended && !state.eosAt) state.eosAt = at;
    },
    onSttStart() { turn(); state.sawStt = true; state.stt = { startAt: Date.now() }; },
    onSttEnd(res) {
      state.stt = state.stt || { startAt: Date.now() };
      state.stt.endAt = Date.now();
      const t = turn();
      t.prospectText = String((res && res.text) || "");
      t.sttError = (res && res.error) || null;
      finishTurn();
    },
    onBrainStart() {
      /* Before the first STT call this is the opening request, which is its own
       * thing to measure. After it, it is the brain call inside a turn. */
      if (!state.sawStt) { state.brain = { ms: 0, calls: 0, opening: true }; state.brain.calls++; state.brain._t0 = Date.now(); return; }
      turn();
      state.brain = state.brain || { ms: 0, calls: 0 };
      state.brain.calls++;
      state.brain._t0 = Date.now();
    },
    onBrainEnd(res) {
      if (!state.brain || !state.brain._t0) return;
      state.brain.ms += Date.now() - state.brain._t0;
      state.brain._t0 = 0;
      const t = state.brain.opening ? state.opening : turnForReply();
      if (t) {
        t.brainMs = state.brain.ms;
        t.brainCalls = state.brain.calls;
        if (res && res.error) t.brainError = res.error;
      }
    },
    onTtsStart() {
      /* Attach to the turn being answered. Before any prospect has spoken there
       * is no turn, so this is the opening. */
      state.ttsTarget = state.sawStt ? (turnForReply() || turn()) : state.opening;
      state.tts = { startAt: Date.now() };
    },
    onTtsEnd(res) {
      state.tts = state.tts || { startAt: Date.now() };
      state.tts.endAt = Date.now();
      const t = state.ttsTarget || turn();
      t.ttsMs = state.tts.endAt - state.tts.startAt;
      t.ttsEngine = (res && res.engine) || "unknown";
      /* The number a prospect experiences: they stop talking, and the agent's
       * audio has to exist. Measured to the end of synthesis, not the end of
       * playback, because nothing is audible before the buffer exists. */
      if (state.lastVoicedAt) t.totalMs = state.tts.endAt - state.lastVoicedAt;
state.tts = null;
    state.ttsTarget = null;
    state.lastVoicedAt = 0;
    state.eosAt = 0;
    state.spokeDuringPlayback = false;
  },
    onAgentLine(line) {
      const t = state.sawStt ? (turnForReply() || turn()) : state.opening;
      t.agentLines.push(String(line));
    },
    onBargeIn() { state.bargeIns++; },
    onPlaybackStart() {
      state.playing = true;
      if (!state.firstAgentAudioAt) state.firstAgentAudioAt = Date.now();
    },
    onPlaybackEnd() { state.playing = false; },
  };
}

/* Point the brain instrumentation (installed at the top of this file) at this
 *  run's telemetry. The patch itself is already in place by then. */
function instrumentBrain(telemetry) {
  brainTelemetry = telemetry;
}

/* ---------- the run ---------- */

function assertNoTelephony(marks) {
  if (!marks.engineWasInjected) throw new Error("audio-sim refused to finish: the real RingCentral engine was reached");
  if (marks.foreignSipOptions) throw new Error("audio-sim refused to finish: a SIP credential reached the engine factory");
}

/** runCall from call-runner.js, loaded lazily so the brain instrumentation
 *  above is in place first. */
function realConversationLoop() {
  return require(path.join(AGENT, "call-runner.js")).runCall;
}

/**
 * Run one scenario through the real controller.
 *
 * opts.stt / opts.tts / opts.brain / opts.opening / opts.sttAuthorised let a
 * test replace the three network stages. Everything else stays real:
 * runLocalCallBody, call-runner.js, the real VAD and its options, SPEECH_HOLD_MS,
 * the 160-byte frame contract and the barge-in logic.
 */
async function runScenario(name, opts = {}) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error("unknown scenario \"" + name + "\"");
/* Frame clock period. The default is the real 20ms. A smaller value compresses
   * the audio timeline so an offline test finishes quickly - the clock keeps
   * running, because the controller's hold timer only advances inside the frame
   * loop - but every latency it produces is meaningless and the output says so.
   * Nothing here switches the clock off. */
  const frameDelayMs = opts.frameDelayMs == null ? FRAME_MS : Math.max(1, Number(opts.frameDelayMs));
  const warnings = [];
  const marks = { engineWasInjected: false, foreignSipOptions: false };
  const tel = makeTelemetry();
  instrumentBrain(tel);

  const providers = opts.providers || await resolveProviders(warnings, opts.provider);
  if (providers.mode === "none") {
    return { name, description: scenario.description, providerMode: providers.mode, failure: "no usable provider", warnings, turns: [], defects: [], expectProblems: [], agentLines: [], leadLines: [], bargeIns: 0, elapsedMs: 0, realTime: true, logs: [] };
  }

  const cfg = loadLiveConfig();
/* Prefer a fixture on disk; otherwise synthesize the same clip from its text, so
   * a clean checkout runs without committed binaries. opts.pcmuFor lets a test
   * hand over generated audio instead, and opts.leadMs / opts.tailMs / opts.gapMs
   * override the surrounding silence - a compressed test run cannot afford a
   * 1.6s tail, and the values that matter (minSpeechMs, endSilenceMs, the hold,
   * the listen window) all belong to the controller and are not adjustable here. */
  const script = scenario.steps.map((s) => ({
    ...s,
    leadMs: opts.leadMs == null ? s.leadMs : opts.leadMs,
    tailMs: opts.tailMs == null ? s.tailMs : opts.tailMs,
    gapMs: opts.gapMs == null ? s.gapMs : opts.gapMs,
    pcmu: (opts.pcmuFor && opts.pcmuFor(s.clip)) || wavFileToPcmu(fixturePath(s.clip)).pcmu,
  }));

  /* Every log line is stamped. The controller's own log is the only place the
   * real ordering of a turn is written down, and a 4-second gap between
   * "playback finished" and "inbound N bytes" is precisely the kind of thing
   * that is invisible without a timestamp and unfixable without one. */
  const logs = [];
  const runStartedAt = Date.now();
  const onLog = (m) => {
    const line = String(m);
    logs.push({ at: Date.now() - runStartedAt, line });
    if (opts.verbose) console.log("    " + String(Date.now() - runStartedAt).padStart(6) + "  " + line);
  };

  const tts = opts.tts || realSpeakToBuffer;
  const stt = opts.stt || realTranscribeAuto;

  const deps = {
    /* The REAL VAD with the REAL options, wrapped only so the timestamps of
     * "last voiced frame" and "end of speech" can be read off it. */
    createVad() {
      /* The REAL VAD with the REAL options, wrapped only so the timestamps of
       * "last voiced frame" and "end of speech" can be read off it. Nothing
       * about its decisions is changed. */
      const real = realCreateVad(opts.vadOptions || VAD_OPTS);
      return {
        push(frame, frameMs = FRAME_MS) {
          const ev = real.push(frame, frameMs);
          tel.onVadPush(ev, Date.now());
          return ev;
        },
        get speaking() { return real.speaking; },
      };
    },
    createLocalRingCentralEngine(engineOpts) {
      marks.engineWasInjected = true;
      const sip = (engineOpts && engineOpts.sip) || {};
      if (sip.pass && sip.pass !== OFFLINE_VOIP.sipPassword) marks.foreignSipOptions = true;
      return createLocalMediaEngine({
        onAudio: engineOpts.onAudio,
        onLog: engineOpts.onLog || (() => {}),
        script,
        frameDelayMs,
        onPlaybackStart: () => tel.onPlaybackStart(),
        onPlaybackEnd: (p) => {
          if (p.finishedEarly) tel.onBargeIn();
          tel.onPlaybackEnd();
        },
      });
    },
    async speakToBuffer(text, voiceOpts) {
      tel.onTtsStart();
      let out = null;
      try {
        out = await tts(text, voiceOpts);
      } finally {
        tel.onTtsEnd(out);
      }
      return out;
    },
    async transcribeAuto(audio, sttOpts) {
      tel.onSttStart();
      let res = null;
      try {
        res = await stt(audio, { ...sttOpts, portal: providers.portal, deviceToken: providers.deviceToken });
      } finally {
        tel.onSttEnd(res);
      }
      return res || { text: null, error: "STT returned nothing" };
    },
    voiceCall: null,
  };
  if (opts.sttAuthorised !== undefined) deps.sttAuthorised = opts.sttAuthorised;
  if (opts.opening !== undefined) deps.opening = opts.opening;

  const controllerConfig = {
    voip: { ...OFFLINE_VOIP },
    product: opts.product || cfg.product || "Dispatch Services for trucks",
    persona: opts.persona !== undefined ? opts.persona : (cfg.persona || "Atlas"),
    companyName: opts.companyName !== undefined ? opts.companyName : (cfg.companyName || "Zaz Logistics"),
    leadFields: cfg.leadFields || [],
    callbackNumber: cfg.callbackNumber || null,
    callbackIn: cfg.callbackIn || null,
    contactEmail: null,
    learning: null,
    lang: cfg.lang || "en",
    voiceStyle: cfg.voiceStyle || "human",
    /* These reach the brain only. They are deliberately not handed to
     * call.js voiceCall, because with a portal set voiceCall POSTs the
     * transcript to /api/call-result - which writes a fake call into the live
     * customer dashboard. A harness must not do that. */
    portalUrl: providers.portal,
    deviceToken: providers.deviceToken,
  };

  /* The conversation driver. Default: call-runner.js runCall, which is exactly
   * what call.js voiceCall runs once it has been handed speakFn/listenFn. It is
   * used instead of voiceCall so no call result is ever posted to the portal. */
  const brain = opts.brain || ((args) => {
    const runCall = realConversationLoop();
    return runCall({
      product: args.product,
      leadFields: args.leadFields,
      persona: args.persona,
      companyName: args.companyName,
      callbackNumber: args.callbackNumber,
      callbackIn: args.callbackIn,
      contactEmail: args.contactEmail,
      learning: args.learning,
      locale: args.locale,
      voiceStyle: args.voiceStyle,
      preparedOpeningText: args.preparedOpeningText,
      portal: args.portal,
      deviceToken: args.token,
      callId: "audio-sim-" + name,
      speak: args.speakFn,
      listen: args.listenFn,
      /* The real speech gate, straight from the controller. Without this the
       * conversation loop has no way to know the prospect spoke first, and the
       * opener goes out over their greeting - which is the defect. */
      waitForFirstSpeech: args.firstSpeechFn,
    });
  });

  /* speakFn is wrapped HERE, at the point the brain is handed it, so the spoken
     lines are recorded whichever brain is driving. Wrapping it inside the default
     brain instead meant an injected brain (a test, or a scripted run) recorded
     nothing, so repetition and the opening count silently came back empty and
     every expectation passed for the wrong reason. */
  deps.voiceCall = (args) => brain({
    ...args,
    speakFn: (line, turn) => {
      tel.onAgentLine(String(line));
      return args.speakFn(line, turn);
    },
  });

  const startedAt = Date.now();
  let out = null;
  let failure = null;
  try {
    out = await runLocalCallBody({
      config: controllerConfig,
      number: OFFLINE_VOIP.number,
      lead: null,
      onLog,
      onMode: () => {},
      deps,
    });
  } catch (e) {
    failure = String((e && e.message) || e);
  }
  const elapsedMs = Date.now() - startedAt;
  assertNoTelephony(marks);

  const transcript = (out && Array.isArray(out.transcript)) ? out.transcript : [];
  const transcriptAgentLines = transcript.filter((t) => t.role === "agent").map((t) => String(t.text));
  /* What the agent actually SENT, captured at the point the words left for the
     voice, which is not always what the transcript claims: the conversation loop
     rewrites a turn (turn cap, repeat-ask guard, "unusable reply") after the
     transcript entry is written, and repetition has to be judged on the words the
     prospect heard. The transcript is kept alongside for comparison. */
  const spokenAgentLines = tel.state.opening.agentLines.concat(...tel.state.turns.map((t) => t.agentLines));
  /* A provider that failed is not a slow provider, and it must never be allowed to
   * read as one. When the brain or the recognizer returns an error the controller
   * speaks a canned recovery line, so the run still looks like a conversation
   * while the numbers measure a failure path. Every provider error is surfaced. */
  const providerFailures = [];
  for (const t of tel.state.turns) {
    if (t.brainError) providerFailures.push({ turn: t.index, stage: "brain", error: t.brainError });
    if (t.sttError) providerFailures.push({ turn: t.index, stage: "stt", error: t.sttError });
  }
  if (tel.state.opening.brainError) providerFailures.push({ turn: -1, stage: "brain", error: tel.state.opening.brainError });

  const report = {
    name,
    description: scenario.description,
    providerFailures,
    providerMode: providers.mode,
    realTime: frameDelayMs >= FRAME_MS,
    elapsedMs,
    failure,
    warnings,
    opening: tel.state.opening,
    turns: tel.state.turns,
    bargeIns: tel.state.bargeIns,
    firstProspectSpeechAt: tel.state.firstVoicedAt || null,
    firstAgentAudioAt: tel.state.firstAgentAudioAt || null,
    agentLines: spokenAgentLines,
    transcriptAgentLines,
    /* What the prospect actually said, as the RECOGNIZER returned it. Taken from
     the STT results rather than the transcript, because those are the words the
     brain was given and the defect being hunted (a truncated turn) is a property
     of that string. The transcript is kept alongside for comparison. */
    leadLines: transcript.filter((t) => t.role === "lead" && !String(t.text).startsWith("(silence)")).map((t) => String(t.text)),
    /* Every transcript, STT results included, so an expectation can be judged
       against what the recognizer returned even when the loop recorded the turn
       differently (and it sometimes does - a junk or empty STT never becomes a
       lead line). */
    heardLines: tel.state.turns.map((t) => t.prospectText).filter(Boolean),
    expect: { ...(scenario.expect || {}), clipText: FIXTURE_TEXT },
    logs,
  };

  const { defects, slowStages } = analyseTurns(report.turns, opts);
  /* Repetition across the whole call, not only inside one turn. */
  for (let i = 1; i < report.agentLines.length; i++) {
    for (let j = 0; j < i; j++) {
      if (similarLines(report.agentLines[j], report.agentLines[i])) {
        defects.push({ kind: "repetition", turn: -1, detail: "agent repeated a line later in the call: " + JSON.stringify(report.agentLines[i].slice(0, 80)) });
        break;
      }
    }
  }
  report.defects = defects;
  report.slowStages = slowStages;
  report.expectProblems = checkExpectations(report, scenario.expect);

  /* A provider outage ends the conversation early, which then makes every
   * remaining clip look "lost". That is not a lost clip, and reporting it as one
   * would blame the harness for the provider's failure. So when the providers
   * failed, the unplayed clips are reported as unplayed and the run is marked
   * inconclusive rather than failed on the agent's behaviour. */
  const clipProblems = [];
  for (const step of script) {
    const want = String(FIXTURE_TEXT[step.clip] || "").split(/\s+/).slice(0, 3).join(" ");
    if (!want) continue;
    if (report.heardLines.some((l) => normLine(l).includes(normLine(want)))) continue;
    clipProblems.push({
      clip: step.clip,
      text: report.providerFailures.length
        ? "never reached the recognizer - the call ended after a provider failure (" + report.providerFailures[0].stage + ": " + report.providerFailures[0].error + ")"
        : "never reached the recognizer - the harness lost audio, so this run proves nothing about the agent",
    });
  }
  report.missingClips = clipProblems;
  if (report.providerFailures.length) {
    report.inconclusive = true;
    /* Drop the clip complaints and the behavioural expectations: they were
       measured against a conversation the provider cut short. */
    report.expectProblems = report.expectProblems.filter((p) => !/never reached the recognizer/.test(p));
  } else {
    report.inconclusive = false;
    for (const c of clipProblems) report.expectProblems.push("the \"" + c.clip + "\" clip " + c.text);
  }
   /* Non-zero on a defect, on a behaviour failure, and on a provider outage: an
   * inconclusive run is not a passing run. */
  report.exitCode = (report.failure || report.defects.length || report.expectProblems.length || report.providerFailures.length) ? 1 : 0;
  return report;
}

/* ---------- output ---------- */

const pad = (s, n) => String(s == null ? "" : s).padEnd(n);
const lpad = (s, n) => String(s == null ? "" : s).padStart(n);

function printReport(report, opts) {
  const threshold = Number((opts && opts.stageBudgetMs) || 2500);
  console.log("");
  console.log("=== audio-sim: " + report.name + " ===");
  console.log("  " + (report.description || ""));
  console.log("  provider=" + report.providerMode + "  wallClock=" + report.elapsedMs + "ms  frames=" + (report.realTime ? "real-time 20ms" : "COMPRESSED - latencies are not real"));
  for (const w of report.warnings) console.log("  ! " + w);
  if (report.failure) console.log("  RUN FAILED: " + report.failure);

  if (report.opening && (report.opening.brainMs != null || report.opening.ttsMs != null)) {
    console.log("");
    console.log("  prepared opening (before anyone spoke): brain " + report.opening.brainMs + "ms, tts " + report.opening.ttsMs + "ms (" + report.opening.ttsEngine + ")");
  }

  if (!report.turns.length) {
    console.log("  no measured turns");
  } else {
    console.log("");
    console.log("  " + pad("turn", 5) + lpad("eos", 7) + lpad("hold", 7) + lpad("stt", 7) + lpad("brain", 8) + lpad("tts", 7) + lpad("total", 8) + "  prospect heard");
    for (const t of report.turns) {
      /* A prospect who talked over the agent is marked, because their `hold` is
         not 250ms - the controller cannot run STT until playback ends, so the
         rest of our own sentence is charged to their wait. */
      console.log(
        "  " + pad(t.index, 5) +
        lpad(t.eosMs == null ? "-" : t.eosMs, 7) +
        lpad(t.holdMs == null ? "-" : (t.spokeDuringPlayback ? t.holdMs + "*" : t.holdMs), 7) +
        lpad(t.sttMs == null ? "-" : t.sttMs, 7) +
        lpad(t.brainMs == null ? "-" : t.brainMs, 8) +
        lpad(t.ttsMs == null ? "-" : t.ttsMs, 7) +
        lpad(t.totalMs == null ? "-" : t.totalMs, 8) +
        "  " + JSON.stringify(String(t.prospectText || "").slice(0, 44)),
      );
    }
    const anyOverlap = report.turns.some((t) => t.spokeDuringPlayback);
    if (anyOverlap) console.log("  * the prospect spoke while the agent was still talking, so that hold includes the rest of our own playback");
    const worst = report.turns.reduce((a, b) => ((b.totalMs || 0) > (a.totalMs || 0) ? b : a), report.turns[0]);
    console.log("");
    console.log("  worst turn: #" + worst.index + " total=" + (worst.totalMs == null ? "n/a" : worst.totalMs + "ms") +
      "  (eos " + worst.eosMs + " + hold " + worst.holdMs + " + stt " + worst.sttMs + " + brain " + worst.brainMs + " + tts " + worst.ttsMs + ")");
  }

  if (opts && opts.verbose) {
    if (report.agentLines.length) {
      console.log("");
      console.log("  agent said:");
      report.agentLines.forEach((l, i) => console.log("   " + String(i + 1).padStart(2) + ". " + l));
    }
    if (report.leadLines.length) {
      console.log("");
      console.log("  prospect said:");
      report.leadLines.forEach((l, i) => console.log("   " + String(i + 1).padStart(2) + ". " + l));
    }
  }

  if (report.slowStages.length) {
    console.log("");
    console.log("  slow stages (over " + threshold + "ms):");
    for (const s of report.slowStages) console.log("    turn " + pad(s.turn, 3) + pad(s.stage, 7) + lpad(s.ms, 7) + "ms  " + s.label);
  }
  if (report.defects.length) {
    console.log("");
    console.log("  DEFECTS:");
    for (const d of report.defects) console.log("    [" + d.kind + "] " + d.detail);
  }
  if (report.expectProblems.length) {
    console.log("");
    console.log("  BEHAVIOUR PROBLEMS:");
    for (const p of report.expectProblems) console.log("    - " + p);
  }
  if (report.providerFailures && report.providerFailures.length) {
    console.log("");
    console.log("  PROVIDER FAILURES (not slow stages - the agent spoke a canned recovery line instead of an answer):");
    for (const f of report.providerFailures) console.log("    turn " + pad(f.turn, 3) + pad(f.stage, 6) + f.error);
    if (report.missingClips && report.missingClips.length) {
      console.log("  clips never played because the call ended:");
      for (const c of report.missingClips) console.log("    " + c.clip + ": " + c.text);
    }
  }
  const providerFailed = !!(report.providerFailures && report.providerFailures.length);
  const bad = !!(report.failure || report.defects.length || report.expectProblems.length);
  console.log("");
  const verdict = providerFailed ? "INCONCLUSIVE (the provider failed - this run says nothing about the agent)" : bad ? "FAIL" : "PASS";
  console.log("  " + verdict + " (" + report.agentLines.length + " agent turns, " + report.turns.length + " measured turns, " + report.bargeIns + " barge-ins)");
  /* A provider outage is a non-zero exit: the caller must not read "INCONCLUSIVE"
     as success, and the stage numbers above it are still worth having. */
  return bad || providerFailed ? 1 : 0;
}

/* ---------- main ---------- */

function parseArgs(argv) {
  const out = { scenario: "all", verbose: false, json: false, stageBudgetMs: 2500, list: false };
  for (const a of argv) {
    if (a === "--verbose" || a === "-v") out.verbose = true;
    else if (a === "--json") out.json = true;
    else if (a === "--list") out.list = true;
    /* Compressed audio timeline, for checking behaviour rather than latency. */
    else if (a === "--fast") out.frameDelayMs = 4;
    else if (a.startsWith("--stage-budget=")) out.stageBudgetMs = Number(a.split("=")[1]);
    else if (a.startsWith("--provider=")) out.provider = a.split("=")[1];
    else if (!a.startsWith("-")) out.scenario = a;
  }
  return out;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.list) {
    for (const [k, v] of Object.entries(SCENARIOS)) console.log(k.padEnd(16) + v.description);
    return 0;
  }
  const names = opts.scenario === "all" ? Object.keys(SCENARIOS) : [opts.scenario];
  for (const n of names) {
    if (!SCENARIOS[n]) {
      console.error("unknown scenario \"" + n + "\"; try --list");
      return 2;
    }
  }
  const reports = [];
  let failed = 0;
  for (const n of names) {
    const report = await runScenario(n, opts);
    reports.push(report);
    failed += printReport(report, opts);
    // The provider rate-limits bursts; a live call spaces its turns out.
    if (n !== names[names.length - 1]) await new Promise((r) => setTimeout(r, Number(process.env.AUDIO_SIM_GAP_MS) || 3000));
  }
  if (opts.json) {
    const file = path.join(os.tmpdir(), "audio-sim-report.json");
    fs.writeFileSync(file, JSON.stringify(reports, null, 2));
    console.log("\njson: " + file);
  }
  console.log("");
  console.log(failed ? failed + " scenario(s) FAILED" : "all audio scenarios PASS");
  return failed ? 1 : 0;
}

module.exports = {
  SCENARIOS,
  FIXTURE_TEXT,
  VAD_OPTS,
  SPEECH_HOLD_MS,
  FRAME_BYTES,
  FRAME_MS,
  parseWav,
  resampleTo8k,
  toPcmuFrames,
  /* Re-exported because it is the one piece of the audio path a test needs to
     build PCMU without a fixture file or a synthesizer. */
  mulawEncode,
  wavFileToPcmu,
  pcmuToWav,
  synthesizeLine,
  fixturePath,
  truncationReason,
  similarLines,
  analyseTurns,
  createLocalMediaEngine,
  makeTelemetry,
  instrumentBrain,
  runScenario,
  checkExpectations,
  loadLiveConfig,
  resolveProviders,
  parseArgs,
  printReport,
  main,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
}