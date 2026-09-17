"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { normalizePcmu, FRAME_BYTES } = require("./local-ringcentral-engine");
const { SUPPORTED_LANGUAGES, normalizeLanguage } = require("./language");

assert.strictEqual(FRAME_BYTES, 160);
assert.strictEqual(normalizePcmu(Buffer.alloc(FRAME_BYTES)).length, 160);
const odd = normalizePcmu(Buffer.alloc(161, 0x22));
assert.strictEqual(odd.length, 320);
assert.strictEqual(odd[319], 0xff);

const engine = fs.readFileSync(path.join(__dirname, "local-ringcentral-engine.js"), "utf8");
const controller = fs.readFileSync(path.join(__dirname, "local-call-controller.js"), "utf8");
const agent = fs.readFileSync(path.join(__dirname, "agent.js"), "utf8");
const voice = fs.readFileSync(path.join(__dirname, "voice.js"), "utf8");
const stt = fs.readFileSync(path.join(__dirname, "multilingual-stt.js"), "utf8");
const runner = fs.readFileSync(path.join(__dirname, "call-runner.js"), "utf8");
const trunk = fs.readFileSync(path.join(__dirname, "../portal/trunk.js"), "utf8");

for (const forbidden of ["werift-rtp", "srtpSession.encrypt", "RtpPacket", "sendPacket("])
  assert(!engine.includes(forbidden), `forbidden transport found: ${forbidden}`);
assert(engine.includes("session.streamAudio(audio)"), "outbound must use RingCentral SDK streamAudio");
assert(engine.includes('session.on("audioPacket"'), "inbound must use RingCentral SDK audioPacket");
assert(engine.includes("packet && packet.payload"), "inbound must consume RTP payload, not RTP object");
assert(engine.includes('streamer.once("finished"'), "sendAudio must wait for SDK playback completion");
assert(engine.includes("let sendChain = Promise.resolve()"), "outbound utterances must be serialized");
assert(engine.includes("sendChain = sendChain.then(() => play(audio))"), "outbound audio must not overlap");
assert(engine.includes("const rem = b.length % FRAME_BYTES"), "PCMU must be normalized to 20ms frame boundaries");
assert(engine.includes("Buffer.alloc(FRAME_BYTES - rem, SILENCE)"), "partial PCMU frame must be padded with mu-law silence");

assert(controller.includes("await engine.connect()"), "local fallback call must connect/answer before conversation starts");
assert(controller.includes("await engine.sendAudio"), "complete TTS utterance must be awaited before listening");
assert(controller.includes("createVad"), "inbound speech must pass through VAD");
assert(controller.includes("transcribeAuto"), "captured telephone audio must reach multilingual transcription");
assert(!controller.includes("mediaConnect("), "local fallback must not route live audio through Suga WSS");

// Production keeps the previously proven shared/cloud call setup instead of forcing
// the second local SIP registration path that returned 401 in the live test.
assert(agent.includes('require("./call")'), "production agent must preserve shared call module");
assert(agent.includes("voiceCall"), "production agent must preserve shared voice-call integration");

// The shared production media boundary must use RingCentral SDK primitives only.
assert(trunk.includes("cs.streamAudio(Buffer.from(audioBuffer))"), "production outbound audio must use RingCentral SDK streamAudio");
assert(trunk.includes("rtpPacket.payload"), "production inbound audio must consume RTP payload");
for (const forbidden of ["werift-rtp", "werift_rtp", "srtpSession.encrypt", "RtpPacket"])
  assert(!trunk.includes(forbidden), `forbidden production media transport found: ${forbidden}`);

assert(Object.keys(SUPPORTED_LANGUAGES).length >= 20, "at least 20 languages required");
assert(stt.includes("whisper-large-v3-turbo") && stt.includes("verbose_json"), "automatic multilingual Whisper path missing");
assert(runner.includes("language-switch") && runner.includes("activeLocale"), "mid-call language switching missing");
assert(normalizeLanguage("en") === "en", "English normalization missing");
assert(normalizeLanguage("urd") === "ur", "Urdu ISO-3 normalization missing");
assert(normalizeLanguage("English") === "en", "Whisper English-name normalization missing");
assert(normalizeLanguage("Urdu") === "ur", "Whisper Urdu-name normalization missing");
assert(normalizeLanguage("Mandarin") === "zh", "Whisper Mandarin-name normalization missing");

// Voice is synthesized at neural quality and converted only at the telephone boundary.
assert(voice.includes('"-ar", "8000"'), "telephone boundary must resample to 8kHz");
assert(voice.includes('"-ac", "1"'), "telephone boundary must be mono");
assert(voice.includes('"-f", "mulaw"'), "telephone boundary must encode PCMU/mulaw");
assert(voice.includes("edge_tts") && voice.includes("AvaNeural"), "high-quality friendly neural female TTS path missing");

// Guard the restored production agent instead of accepting another stripped replacement.
for (const marker of ["runWatchdog", "takeAgentLock", "localDb.open", "topStrategy", "emailQualifiedLead", "onSetup", "--watchdog"])
  assert(agent.includes(marker), `restored production agent marker missing: ${marker}`);

console.log("local RingCentral media v2 acceptance checks: PASS");
