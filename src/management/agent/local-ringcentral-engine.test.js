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
const softphone = fs.readFileSync(path.join(__dirname, "../portal/softphone.js"), "utf8");

for (const forbidden of ["werift-rtp", "srtpSession.encrypt", "RtpPacket", "sendPacket("])
  assert(!engine.includes(forbidden), `forbidden transport found: ${forbidden}`);
assert(engine.includes("session.streamAudio(audio)"), "outbound must use RingCentral SDK streamAudio");
assert(softphone.includes('require("ringcentral-softphone").default') || softphone.includes("(mod.default || mod)"), "CommonJS must resolve RingCentral Softphone default export");
assert(engine.includes('session.on("audioPacket"'), "inbound must use RingCentral SDK audioPacket");
assert(engine.includes("packet && packet.payload"), "inbound must consume RTP payload, not RTP object");
assert(engine.includes('streamer.once("finished"'), "sendAudio must wait for SDK playback completion");
assert(engine.includes('typeof streamer.stop === "function"') && engine.includes("interrupt"), "playback interruption primitive missing");
assert(engine.includes("generation++") && engine.includes("mine === generation"), "interruption must invalidate queued speech");
assert(engine.includes("sendChain = Promise.resolve()"), "interruption must reset outbound queue");
assert(engine.includes("let sendChain = Promise.resolve()"), "outbound utterances must be serialized");
assert(engine.includes("sendChain = sendChain.catch(() => 0).then(() => mine === generation ? play(audio) : 0)"), "outbound audio must not overlap and interrupted queued speech must be discarded");
assert(engine.includes("const rem = b.length % FRAME_BYTES"), "PCMU must be normalized to 20ms frame boundaries");
assert(engine.includes("Buffer.alloc(FRAME_BYTES - rem, SILENCE)"), "partial PCMU frame must be padded with mu-law silence");

assert(controller.includes("await engine.connect()"), "local fallback call must connect/answer before conversation starts");
assert(controller.includes("await engine.sendAudio"), "complete TTS utterance must be awaited before listening");
assert(controller.includes("createVad"), "inbound speech must pass through VAD");
assert(controller.includes("engine.interrupt()") && controller.includes("openingProtected"), "controller must listen while outbound speech is playing and protect the opening from false barge-in");
assert(controller.includes("waitForInboundMedia"), "opening must wait for inbound RTP (or a short cap) before speaking");
assert(engine.includes("waitForInboundMedia"), "engine must expose inbound-media gate");
assert(engine.includes("watchdog") && engine.includes("outbound watchdog"), "playback must have a watchdog so a hung streamAudio cannot freeze the call");
assert(engine.includes("keepAlive") && engine.includes("FRAME_BYTES * 5"), "engine must expose RTP keep-alive for synthesis gaps");
assert(controller.includes("engine.keepAlive"), "controller must keep RTP warm while non-opening TTS synthesizes");
assert(voice.includes("edgeWsToBuffer") && voice.includes("audio-24khz-48kbitrate-mono-mp3"), "primary TTS must be single-shot Edge websocket mp3 (no chunk seams; riff/raw formats are rejected close 1007)");
assert(!voice.includes("riff-16khz-16bit-mono-pcm"), "unsupported Edge format would be rejected with close 1007 and silently fall back to slow Python TTS");
assert(voice.includes("decodeMp3") && voice.includes("mulawEncode"), "Edge WS mp3 must decode in-process (mpg123) to PCMU without Python/ffmpeg");
assert(!voice.includes("padPcmu"), "must not inject artificial lead/trail silence that adds turn pauses");
assert(controller.includes("isJunkUtterance"), "STT junk (beep/tone) must not become a lead turn");
assert(controller.includes("phone ringing") && controller.includes("voicemail"), "ringback/voicemail STT junk must be filtered");
assert(runner.includes("isJunkLead") || controller.includes("isJunkUtterance"), "call path must ignore junk lead utterances");
// Steady carrier tones (ringback/voicemail) hold a flat level; human speech
// swings. The opening was being chopped by the callee's ringtone in live logs.
assert(controller.includes("steadyToneBarge") && controller.includes("trackBargeLevel"), "steady-tone barge-in guard missing");
assert(controller.includes("steady carrier tone"), "steady-tone suppression must be logged for live verification");
assert(engine.includes("gone = true"), "engine must flag remote session end");
assert(engine.includes("onSessionGone"), "engine must notify controller on remote BYE");
assert(controller.includes("onSessionGone: endSession"), "controller must stop the turn loop on remote BYE");
assert(runner.includes("heardResult.ended"), "call runner must break the turn loop on remote hangup");
assert(engine.includes("if (gone) return Promise.resolve(0)"), "post-BYE sends must not reject and crash the child");
assert(engine.includes("!closed && !gone"), "keep-alive/status must not touch a dead session");
assert(controller.includes("state && state.ended"), "listen phase must reuse speech captured during playback");
assert(controller.includes("transcribeAuto"), "captured telephone audio must reach multilingual transcription");
assert(!controller.includes("mediaConnect("), "local fallback must not route live audio through Suga WSS");
assert(!controller.includes("await preflightLocalSip(config, deps);"), "live call must not create and revoke a disposable SIP registration before engine.connect");
const webui = fs.readFileSync(path.join(__dirname, "webui.js"), "utf8");
assert(webui.includes("function escapHtml(v)") && !webui.includes("async function escapHtml(v)"), "call error HTML escaping must be synchronous");

// Production keeps the previously proven shared/cloud call setup instead of forcing
// the second local SIP registration path that returned 401 in the live test.
assert(agent.includes('require("./call")'), "production agent must preserve shared call module");
assert(agent.includes("voiceCall"), "production agent must preserve shared voice-call integration");
assert(agent.includes("authId: portalCfg.voip.authId"), "heartbeat SIP authorization ID must survive into local config");
assert(agent.includes("domain: portalCfg.voip.domain"), "heartbeat SIP domain must survive into local config");

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
