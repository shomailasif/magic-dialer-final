"use strict";

const { voiceCall } = require("./call");
const { speakToBuffer } = require("./voice");
const { createVad } = require("./vad");
const { createLocalRingCentralEngine } = require("./local-ringcentral-engine");
const { transcribeAuto } = require("./multilingual-stt");
const { normalizeLanguage } = require("./language");

async function runLocalCall({ config, number, onLog = () => {}, onMode = () => {} }) {
  const v = config.voip || {};
  if (!v.ready || !v.username || !v.sipPassword || !v.number) throw new Error("VOIP configuration incomplete");
  const target = String(number || config.testNumber || (config.callList || [])[0] || "").trim();
  if (!target) throw new Error("No destination number configured");

  let state = null;
  let activeLocale = config.lang && config.lang !== "auto" ? normalizeLanguage(config.lang) : "en";
  const engine = createLocalRingCentralEngine({
    number: target,
    sip: {
      user: v.username,
      pass: v.sipPassword,
      authId: v.extension || v.username,
      domain: v.server || "sip.ringcentral.com",
      proxy: v.server || "sip40.ringcentral.com",
      port: Number(v.port || 5096),
    },
    onLog,
    onAudio: (b) => {
      if (!state) return;
      for (let i = 0; i < b.length; i += 160) {
        const frame = b.subarray(i, i + 160);
        if (frame.length < 160) continue;
        const event = state.vad.push(frame, 20);
        if (!state.started) {
          state.pre.push(frame);
          if (state.pre.length > 10) state.pre.shift();
          if (event.speaking) { state.started = true; state.chunks.push(...state.pre); state.pre = []; }
        } else {
          state.chunks.push(frame);
          if (event.ended && !state.done) { state.done = true; state.resolve(); }
        }
      }
    },
  });

  await engine.connect();
  const speakFn = async (text, turn = {}) => {
    const locale = normalizeLanguage(turn.locale || activeLocale);
    activeLocale = locale;
    const out = await speakToBuffer(text, { locale, style: config.voiceStyle || "friendly" });
    if (!out || !Buffer.isBuffer(out.buffer) || out.buffer.length < 160) throw new Error("TTS produced no valid PCMU/8000 telephone audio");
    const n = await engine.sendAudio(out.buffer);
    onLog(`[local-media-v2] outbound ${n} bytes PCMU/8000 ${locale} playback finished`);
  };

  const listenFn = async (turn = {}) => {
    let release;
    const ended = new Promise((resolve) => { release = resolve; });
    state = { vad: createVad({ minSpeechMs: 160, endSilenceMs: 620 }), pre: [], chunks: [], started: false, done: false, resolve: release };
    const timer = setTimeout(() => { if (state && !state.done) { state.done = true; state.resolve(); } }, 15000);
    await ended;
    clearTimeout(timer);
    const captured = state;
    state = null;
    if (!captured.started || !captured.chunks.length) return null;
    const audio = Buffer.concat(captured.chunks);
    onLog(`[local-media-v2] inbound ${audio.length} bytes PCMU/8000`);
    const stt = await transcribeAuto(audio, { hint: turn.autoLanguage ? "auto" : (turn.locale || activeLocale) });
    if (stt.language) { activeLocale = stt.language; onLog(`[local-media-v2] detected language ${activeLocale}`); }
    if (stt.error) onLog(`[local-media-v2] STT ${stt.error}`);
    return stt.text ? { text: stt.text, language: stt.language || activeLocale } : null;
  };

  try {
    return await voiceCall({
      product: config.product,
      leadFields: config.leadFields || [],
      persona: config.persona,
      companyName: config.companyName,
      callbackNumber: config.callbackNumber,
      callbackIn: config.callbackIn,
      contactEmail: config.contactEmail,
      learning: config.learning,
      locale: config.lang || "auto",
      voiceStyle: config.voiceStyle || "friendly",
      speakFn,
      listenFn,
      onLog,
      onMode,
    });
  } finally {
    engine.close();
  }
}

module.exports = { runLocalCall };
