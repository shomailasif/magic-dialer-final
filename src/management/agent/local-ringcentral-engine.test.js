"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { normalizePcmu, FRAME_BYTES } = require("./local-ringcentral-engine");
assert.strictEqual(FRAME_BYTES,160);
assert.strictEqual(normalizePcmu(Buffer.alloc(FRAME_BYTES)).length,160);
const odd=normalizePcmu(Buffer.alloc(161,0x22));
assert.strictEqual(odd.length,320);
assert.strictEqual(odd[319],0xff);
const engine=fs.readFileSync(path.join(__dirname,"local-ringcentral-engine.js"),"utf8");
const agent=fs.readFileSync(path.join(__dirname,"agent.js"),"utf8");
const voice=fs.readFileSync(path.join(__dirname,"voice.js"),"utf8");
const hear=fs.readFileSync(path.join(__dirname,"hear.js"),"utf8");
for(const forbidden of ["werift-rtp","srtpSession.encrypt","RtpPacket","sendPacket("]) assert(!engine.includes(forbidden),`forbidden transport found: ${forbidden}`);
assert(engine.includes("session.streamAudio(audio)"),"outbound must use RingCentral SDK streamAudio");
assert(engine.includes('session.on("audioPacket"'),"inbound must use RingCentral SDK audioPacket");
assert(engine.includes("packet && packet.payload"),"inbound must consume RTP payload, not RTP object");
assert(engine.includes('streamer.once("finished"'),"sendAudio must wait for SDK playback completion");
assert(agent.includes("await engine.connect()"),"call must connect/answer before conversation starts");
assert(agent.includes("await engine.sendAudio(r.buffer)"),"complete TTS utterance must be awaited before listening");
assert(agent.includes("createVad"),"inbound speech must pass through VAD");
assert(agent.includes("hearFromBuffer(audio"),"captured telephone audio must reach transcription");
assert(!agent.includes("mediaConnect("),"V2 active call path must not route live audio through Suga WSS");
// Voice is synthesized by the neural TTS engine in its native high-quality
// format, then converted only at the telephone boundary to RingCentral's
// required PCMU/8kHz mono format. Do not require low-rate source synthesis.
assert(voice.includes('"-ar", "8000"'),"telephone boundary must resample to 8kHz");
assert(voice.includes('"-ac", "1"'),"telephone boundary must be mono");
assert(voice.includes('"-f", "mulaw"'),"telephone boundary must encode PCMU/mulaw");
assert(voice.includes("edge_tts")&&voice.includes("AvaNeural"),"high-quality friendly neural female TTS path missing");
assert(hear.includes("mulawDecode")&&hear.includes("hearFromBuffer"),"inbound PCMU decode/transcription path missing");
console.log("local RingCentral media v2 acceptance checks: PASS");
