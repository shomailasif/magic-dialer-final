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

/** Non-speech STT hits that must never become a conversation turn. */
function isJunkUtterance(text) {
  const s = String(text || "").trim().toLowerCase();
  if (!s) return true;
  if (s.length > 40) return false;
  return /^(beep\.?|tone\.?|busy signal\.?|dial tone\.?|ring\.?|click\.?|noise\.?|static\.?|hum\.?|zzz\.?|\[.*\]|\(beep\)|dtmf\.?|test\.?|hello\?)$/.test(s)
    || /^(beep|tone|click|noise|static)[\s.!]*$/.test(s);
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
        const playingMs = state.playing && state.playbackStartedAt ? Date.now() - state.playbackStartedAt : 0;
        // Opening: do not chop the intro on warm-up noise. After 1s require
        // much stronger sustained speech so a short "Beep."/carrier blip cannot
        // kill the sentence the callee is meant to hear.
        if (state.playing && state.openingProtected) {
          if (playingMs < 1000) {
            state.speechDuringPlaybackMs = 0;
          } else {
            state.speechDuringPlaybackMs = state.speechDuringPlaybackMs || 0;
            if (event.voiced && event.level >= 500) state.speechDuringPlaybackMs += 20;
            else if (!event.voiced) state.speechDuringPlaybackMs = 0;
            if (state.speechDuringPlaybackMs >= 700 && !state.interrupted) {
              state.interrupted = true;
              engine.interrupt();
              onLog("[local-media-v2] barge-in detected; outbound playback stopped");
            }
          }
        } else if (state.playing) {
          // Later turns: ignore first 1s of playback, then require sustained
          // voiced energy (not a single noise frame).
          if (playingMs < 1000) {
            state.speechDuringPlaybackMs = 0;
          } else {
            state.speechDuringPlaybackMs = state.playing && event.voiced ? (state.speechDuringPlaybackMs || 0) + 20 : 0;
            if (state.speechDuringPlaybackMs >= 500 && !state.interrupted) {
              state.interrupted = true;
              engine.interrupt();
              onLog("[local-media-v2] barge-in detected; outbound playback stopped");
            }
          }
        } else {
          state.speechDuringPlaybackMs = 0;
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
  // Do not start the opening until callee RTP has shown up (or a short cap).
  // Speaking the millisecond "answered" fires is how the AI opened before the
  // far end was actually ready on the last test call.
  if (typeof engine.waitForInboundMedia === "function") {
    const media = await engine.waitForInboundMedia(1200);
    onLog(`[local-media-v2] opening gated on inbound RTP: ${media.gotInbound ? "yes" : "no"} after ${media.waitedMs}ms`);
  }
  let preparedOpening = { text: openingText, audio: openingAudio };
  const speakFn = async (text, turn = {}) => {
    const locale = normalizeLanguage(turn.locale || activeLocale);
    activeLocale = locale;
    const line = String(text || "").trim();
    if (line) onLog("AGENT: " + line);
    const isOpening = !!(preparedOpening && line === preparedOpening.text);
    // Create capture state BEFORE awaiting TTS so inbound audio is never
    // dropped while state is null during synthesis.
    if (!state) {
      let release;
      const ended = new Promise((resolve) => { release = resolve; });
      state = { vad: makeVad({ minSpeechMs: 160, endSilenceMs: 420 }), pre: [], chunks: [], started: false, done: false, resolve: release, playing: false, interrupted: false, speechDuringPlaybackMs: 0, playbackStartedAt: 0, openingProtected: false, ended };
    }
    let out;
    if (isOpening) {
      out = preparedOpening.audio;
      preparedOpening = null;
    } else {
      out = await tts(text, { locale, style: config.voiceStyle || "friendly" });
    }
    if (!out || !Buffer.isBuffer(out.buffer) || out.buffer.length < 160) throw new Error("TTS produced no valid PCMU/8000 telephone audio");
    if (!state) {
      let release;
      const ended = new Promise((resolve) => { release = resolve; });
      state = { vad: makeVad({ minSpeechMs: 160, endSilenceMs: 420 }), pre: [], chunks: [], started: false, done: false, resolve: release, playing: true, interrupted: false, speechDuringPlaybackMs: 0, playbackStartedAt: Date.now(), openingProtected: isOpening, ended };
    } else {
      state.playing = true;
      state.interrupted = false;
      state.speechDuringPlaybackMs = 0;
      state.playbackStartedAt = Date.now();
      state.openingProtected = isOpening;
    }
    const n = await engine.sendAudio(out.buffer);
    if (state) {
      state.playing = false;
      state.openingProtected = false;
    }
    onLog(`[local-media-v2] outbound ${n} bytes PCMU/8000 ${locale} playback finished`);
  };

  const listenFn = async (turn = {}) => {
    let ended;
    if (state && state.ended) {
      ended = state.ended;
      state.playing = false;
      state.openingProtected = false;
    } else {
      let release;
      ended = new Promise((resolve) => { release = resolve; });
      state = { vad: makeVad({ minSpeechMs: 160, endSilenceMs: 420 }), pre: [], chunks: [], started: false, done: false, resolve: release, playing: false, interrupted: false, speechDuringPlaybackMs: 0, playbackStartedAt: 0, openingProtected: false, ended };
    }
    const timer = setTimeout(() => { if (state && !state.done) { state.done = true; state.resolve(); } }, 15000);
    await ended;
    clearTimeout(timer);
    const captured = state;
    state = null;
    if (!captured.started || !captured.chunks.length) {
      onLog("[local-media-v2] listen: no speech in window");
      return null;
    }
    const audio = Buffer.concat(captured.chunks);
    onLog(`[local-media-v2] inbound ${audio.length} bytes PCMU/8000`);
    const stt = await sttAuto(audio, { hint: turn.autoLanguage ? "auto" : (turn.locale || activeLocale), portal: config.portalUrl, deviceToken: config.deviceToken });
    // Locale changes are owned by call-runner (it applies command/substantial
    // guards); here we only report what the recognizer saw.
    if (stt.language) onLog(`[local-media-v2] STT detected language ${stt.language}`);
    if (stt.error) onLog(`[local-media-v2] STT ${stt.error}`);
    if (stt.text && !isJunkUtterance(stt.text)) {
      onLog("LEAD:  " + stt.text);
      return { text: stt.text, language: stt.language || activeLocale };
    }
    if (stt.text) {
      // Carrier tones / voicemail beeps must not become a fake lead turn that
      // flips the agent into inbound "How can I assist you?" mode.
      onLog("[local-media-v2] STT junk ignored: " + stt.text);
      return null;
    }
    // Speech reached the VAD but the recognizer returned nothing — do not let
    // call-runner treat this as a quiet line and hang up on the prospect.
    onLog("[local-media-v2] STT returned empty for captured speech; retrying once");
    const retry = await sttAuto(audio, { hint: turn.autoLanguage ? "auto" : (turn.locale || activeLocale), portal: config.portalUrl, deviceToken: config.deviceToken });
    if (retry.text && !isJunkUtterance(retry.text)) {
      onLog("LEAD:  " + retry.text);
      return { text: retry.text, language: retry.language || activeLocale };
    }
    if (retry.text) onLog("[local-media-v2] STT junk ignored: " + retry.text);
    else onLog("[local-media-v2] STT still empty after retry");
    return null;
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
