"use strict";

const { voiceCall } = require("./call");
const { speakToBuffer } = require("./voice");
const { createVad } = require("./vad");
const { createLocalRingCentralEngine } = require("./local-ringcentral-engine");
const { registerSession } = require("../portal/softphone");
const { transcribeAuto } = require("./multilingual-stt");
const { normalizeLanguage } = require("./language");
const { preflightBrain, opening } = require("./intelligent-brain");

function sipOptions(v) {
  return {
    user: v.username,
    pass: v.sipPassword,
    authId: v.authId || v.username,
    domain: v.domain || "sip.ringcentral.com",
    proxy: v.host || v.server || "sip40.ringcentral.com",
    port: Number(v.port || 5096),
  };
}

async function preflightLocalSip(config, deps = {}) {
  const v = config && config.voip || {};
  if (!v.ready || !v.username || !v.sipPassword || !v.number) throw new Error("VOIP configuration incomplete");
  const reg = deps.registerSession || registerSession;
  const result = await reg(sipOptions(v));
  if (!result || !result.ok) throw new Error("RingCentral SIP registration failed: " + ((result && result.last) || "unknown error"));
  return { ok: true, host: result.host || null };
}

async function runLocalCall({ config, number, onLog = () => {}, onMode = () => {}, deps = {} }) {
  const makeEngine = deps.createLocalRingCentralEngine || createLocalRingCentralEngine;
  const makeVad = deps.createVad || createVad;
  const tts = deps.speakToBuffer || speakToBuffer;
  const sttAuto = deps.transcribeAuto || transcribeAuto;
  const callBrain = deps.voiceCall || voiceCall;
  const v = config.voip || {};
  if (!v.ready || !v.username || !v.sipPassword || !v.number) throw new Error("VOIP configuration incomplete");
  const target = String(number || config.testNumber || (config.callList || [])[0] || "").trim();
  if (!target) throw new Error("No destination number configured");

  let state = null;
  let activeLocale = config.lang && config.lang !== "auto" ? normalizeLanguage(config.lang) : "en";
  const brainCheck = deps.preflightBrain || preflightBrain;
  const openingFn = deps.opening || opening;
  const brainConfig = {
    product: config.product,
    leadFields: config.leadFields || [],
    persona: config.persona,
    companyName: config.companyName,
    callbackNumber: config.callbackNumber,
    callbackIn: config.callbackIn,
    locale: activeLocale,
    portal: config.portalUrl,
    deviceToken: config.deviceToken,
  };
  await brainCheck(brainConfig);
  onLog("[local-media-v2] AI brain preflight passed");
  const first = await openingFn(brainConfig);
  if (!first || !String(first.text || "").trim()) throw new Error("AI opening preflight failed; refusing to place call");
  const openingText = String(first.text).trim();
  const openingAudio = await tts(openingText, { locale: activeLocale, style: config.voiceStyle || "friendly" });
  if (!openingAudio || !Buffer.isBuffer(openingAudio.buffer) || openingAudio.buffer.length < 160) {
    throw new Error("Opening TTS preflight failed; refusing to place call");
  }
  onLog(`[local-media-v2] opening pre-render passed (${openingAudio.engine || "unknown"}, ${openingAudio.buffer.length} bytes PCMU/8000)`);
  const engine = makeEngine({
    number: target,
    sip: sipOptions(v),
    onLog,
    onAudio: (b) => {
      if (!state) return;
      for (let i = 0; i < b.length; i += 160) {
        const frame = b.subarray(i, i + 160);
        if (frame.length < 160) continue;
        const event = state.vad.push(frame, 20);
        state.speechDuringPlaybackMs = state.playing && event.voiced ? (state.speechDuringPlaybackMs || 0) + 20 : 0;
        if (state.playing && event.speaking && state.speechDuringPlaybackMs >= 220 && !state.interrupted) {
          state.interrupted = true;
          engine.interrupt();
          onLog("[local-media-v2] barge-in detected; outbound playback stopped");
        }
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
  let preparedOpening = { text: openingText, audio: openingAudio };
  const speakFn = async (text, turn = {}) => {
    const locale = normalizeLanguage(turn.locale || activeLocale);
    activeLocale = locale;
    // Create capture state BEFORE awaiting TTS so inbound audio is never
    // dropped while state is null during synthesis.
    if (!state) {
      let release;
      const ended = new Promise((resolve) => { release = resolve; });
      state = { vad: makeVad({ minSpeechMs: 160, endSilenceMs: 420 }), pre: [], chunks: [], started: false, done: false, resolve: release, playing: false, interrupted: false, speechDuringPlaybackMs: 0, ended };
    }
    let out;
    if (preparedOpening && String(text || "").trim() === preparedOpening.text) {
      out = preparedOpening.audio;
      preparedOpening = null;
    } else {
      out = await tts(text, { locale, style: config.voiceStyle || "friendly" });
    }
    if (!out || !Buffer.isBuffer(out.buffer) || out.buffer.length < 160) throw new Error("TTS produced no valid PCMU/8000 telephone audio");
    if (!state) {
      let release;
      const ended = new Promise((resolve) => { release = resolve; });
      state = { vad: makeVad({ minSpeechMs: 160, endSilenceMs: 420 }), pre: [], chunks: [], started: false, done: false, resolve: release, playing: true, interrupted: false, speechDuringPlaybackMs: 0, ended };
    } else {
      state.playing = true;
      state.interrupted = false;
      state.speechDuringPlaybackMs = 0;
    }
    const n = await engine.sendAudio(out.buffer);
    if (state) state.playing = false;
    onLog(`[local-media-v2] outbound ${n} bytes PCMU/8000 ${locale} playback finished`);
  };

  const listenFn = async (turn = {}) => {
    let ended;
    if (state && state.ended) {
      ended = state.ended;
      state.playing = false;
    } else {
      let release;
      ended = new Promise((resolve) => { release = resolve; });
      state = { vad: makeVad({ minSpeechMs: 160, endSilenceMs: 420 }), pre: [], chunks: [], started: false, done: false, resolve: release, playing: false, interrupted: false, speechDuringPlaybackMs: 0, ended };
    }
    const timer = setTimeout(() => { if (state && !state.done) { state.done = true; state.resolve(); } }, 15000);
    await ended;
    clearTimeout(timer);
    const captured = state;
    state = null;
    if (!captured.started || !captured.chunks.length) return null;
    const audio = Buffer.concat(captured.chunks);
    onLog(`[local-media-v2] inbound ${audio.length} bytes PCMU/8000`);
    const stt = await sttAuto(audio, { hint: turn.autoLanguage ? "auto" : (turn.locale || activeLocale), portal: config.portalUrl, deviceToken: config.deviceToken });
    // Locale changes are owned by call-runner (it applies command/substantial
    // guards); here we only report what the recognizer saw.
    if (stt.language) onLog(`[local-media-v2] STT detected language ${stt.language}`);
    if (stt.error) onLog(`[local-media-v2] STT ${stt.error}`);
    return stt.text ? { text: stt.text, language: stt.language || activeLocale } : null;
  };

  try {
    return await callBrain({
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
      preparedOpeningText: openingText,
      portal: config.portalUrl,
      token: config.deviceToken,
      speakFn,
      listenFn,
      onLog,
      onMode,
    });
  } finally {
    engine.close();
  }
}

module.exports = { runLocalCall, preflightLocalSip, sipOptions };
