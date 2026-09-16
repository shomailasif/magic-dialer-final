const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { createVad } = require("../src/management/agent/vad");
const { systemPrompt } = require("../src/management/agent/intelligent-brain");

function ulawEncode(sample) {
  let s = sample | 0; const sign = (s >> 8) & 0x80; if (sign) s = -s;
  if (s > 32635) s = 32635; s += 0x84;
  let exponent = 7; for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {}
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}
function frame(amplitude) {
  const b = Buffer.alloc(160);
  for (let i = 0; i < b.length; i++) b[i] = ulawEncode(i % 2 ? amplitude : -amplitude);
  return b;
}

let vad = createVad({ minSpeechMs: 160, endSilenceMs: 620 });
for (let i = 0; i < 50; i++) assert.equal(vad.push(Buffer.alloc(160, 0xff)).speaking, false);
vad = createVad({ minSpeechMs: 160, endSilenceMs: 620 });
for (let i = 0; i < 20; i++) vad.push(Buffer.alloc(160, 0xff));
let state;
for (let i = 0; i < 12; i++) state = vad.push(frame(7000));
assert.equal(state.speaking, true);
for (let i = 0; i < 30; i++) state = vad.push(Buffer.alloc(160, 0xff));
assert.equal(state.ended, false);
state = vad.push(Buffer.alloc(160, 0xff));
assert.equal(state.ended, true);

const call = fs.readFileSync(path.join(__dirname, "../src/management/agent/call.js"), "utf8");
const runner = fs.readFileSync(path.join(__dirname, "../src/management/agent/call-runner.js"), "utf8");
const ai = fs.readFileSync(path.join(__dirname, "../src/management/agent/intelligent-brain.js"), "utf8");
const voice = fs.readFileSync(path.join(__dirname, "../src/management/agent/voice.js"), "utf8");
const agent = fs.readFileSync(path.join(__dirname, "../src/management/agent/agent.js"), "utf8");
const trunk = fs.readFileSync(path.join(__dirname, "../src/management/portal/trunk.js"), "utf8");
const softphone = fs.readFileSync(path.join(__dirname, "../src/management/portal/softphone.js"), "utf8");
const projectNotes = fs.readFileSync(path.join(__dirname, "../PROJECT_NOTES.md"), "utf8");

assert(call.includes('require("./vad")'));
assert(call.includes("endSilenceMs: 620"));
assert(runner.includes('require("./intelligent-brain")'));
assert(!runner.includes('require("./brain-i18n")'));
assert(!runner.includes("setTimeout(r, 600)"));
assert(!runner.includes("100 + Math.floor(Math.random() * 150)"));
assert(ai.includes("prior turns as context"));
assert(ai.includes("Never assume freight, dispatch, logistics, trucking"));
assert(ai.includes("GROQ_API_KEY"));
assert(!ai.includes("gsk_"));
const prompt = systemPrompt({ product: "dental appointments", companyName: "Example Dental", leadFields: ["preferred appointment time"], locale: "en" });
assert(prompt.includes("Example Dental"));
assert(prompt.includes("dental appointments"));
assert(prompt.includes("preferred appointment time"));
assert(voice.includes("AvaNeural") || voice.includes("JennyNeural"));
assert(agent.includes("config.voip"));
assert(agent.includes("config.product"));
assert(agent.includes("config.companyName"));
assert(trunk.includes("rtpPacket.payload"));
assert(trunk.includes("cs.streamAudio"), "RingCentral outbound media must use SDK streamAudio");
assert(!trunk.includes('require("werift-rtp")'), "portal bridge must not construct RTP manually");
assert(!trunk.includes("new werift_rtp.RtpPacket"), "manual RTP packet construction is forbidden");
assert(!trunk.includes("cs.srtpSession.encrypt"), "portal bridge must leave SRTP to RingCentral SDK");
assert(softphone.includes("streamAudio"));
assert(projectNotes.includes("Each customer's PC acts as a learning node"));
assert(projectNotes.includes("Each customer gets their own VOIP credentials"));

console.log("repair regression checks: PASS");
