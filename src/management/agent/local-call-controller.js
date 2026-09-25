"use strict";

const { voiceCall } = require("./call");
const { speakToBuffer } = require("./voice");
const { createVad } = require("./vad");
const { createLocalRingCentralEngine } = require("./local-ringcentral-engine");
const { registerSession } = require("../portal/softphone");
const { transcribeAuto } = require("./multilingual-stt");
const { normalizeLanguage } = require("./language");
const { capTurnLength, MAX_TURN_CHARS } = require("./turn-length");
const { isMostlyNonLatin } = require("./script-guard");
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
  // Not a word: ".", ",", "...". A lone "." reached the brain as a real turn
  // in a live call and made the agent answer silence.
  if (s.replace(/[^\p{L}\p{N}]/gu, "").length < 2) return true;
  return /^(beep\.?|tone\.?|busy signal\.?|dial tone\.?|ring\.?|ringing\.?|phone ringing\.?|the phone is ringing\.?|voicemail\.?|voice mail\.?|please leave a message.*|leave a message.*|at the tone.*|click\.?|noise\.?|static\.?|hum\.?|zzz\.?|\[.*\]|\(beep\)|dtmf\.?|test\.?)$/.test(s)
    || /^(beep|tone|click|noise|static)[\s.!]*$/.test(s);
}

/** Push one voiced level into the barge-in tone-detection window. */
// How long the prospect must keep talking before the agent stops.
// 300ms was tried and reverted: on the 21:05Z call it guillotined the agent
// five times in two minutes (3610ms played of 6160ms intended, 1970ms of
// 4740ms), which is exactly the rushed, half-finished-sentence delivery being
// complained about. Not talking over the prospect is handled by capping our own
// turn length, not by cutting ourselves off mid-word.
const BARGE_YIELD_MS = 700;

function trackBargeLevel(state, level) {
  const w = state.bargeLevels || (state.bargeLevels = []);
  w.push(level);
  if (w.length > 25) w.shift();
}

/**
 * Ringback / voicemail tones hold a near-constant level for seconds while
 * human speech swings wildly between phonemes. A steady window must not
 * count toward barge-in — the callee's ringtone was chopping the opening
 * mid-sentence on every test call.
 */
function steadyToneBarge(state) {
  const w = state.bargeLevels;
  if (!w || w.length < 12) return false;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < w.length; i++) {
    const l = w[i];
    if (l < min) min = l;
    if (l > max) max = l;
  }
  const mean = (min + max) / 2;
  return mean > 0 && max - min < mean * 0.25;
}

function noteSteadyTone(state, onLog) {
  state.speechDuringPlaybackMs = 0;
  if (!state.toneLogged) {
    state.toneLogged = true;
    onLog("[local-media-v2] steady carrier tone (ringback/voicemail) ignored for barge-in");
  }
}

async function preflightLocalSip(config, deps = {}) {
  const v = config && config.voip || {};
  if (!v.ready || !v.username || !v.sipPassword || !v.number) throw new Error("VOIP configuration incomplete");
  const reg = deps.registerSession || registerSession;
  const result = await reg(sipOptions(v));
  if (!result || !result.ok) throw new Error("RingCentral SIP registration failed: " + ((result && result.last) || "unknown error"));
  return { ok: true, host: result.host || null };
}

// Every control-path failure must reach watchdog-child.log: the first 1.4.17
// test attempt failed with HTTP 500 after 64s and left no trace of why (it was
// a SIP answer timeout - nobody picked up), which made the failure undiagnosable.
async function runLocalCall(opts) {
  try {
    return await runLocalCallBody(opts);
  } catch (e) {
    const onLog = (opts && opts.onLog) || (() => {});
    try { onLog("[local-media-v2] call control failed: " + ((e && e.message) || String(e))); } catch { /* logging must never mask the error */ }
    throw e;
  }
}

async function runLocalCallBody({ config, number, onLog = () => {}, onMode = () => {}, deps = {} }) {
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
  let sessionEnded = false;
  const endSession = () => {
    if (sessionEnded) return;
    sessionEnded = true;
    if (state && !state.done) { state.done = true; state.resolve(); }
    onLog("[local-media-v2] remote hangup; conversation loop will stop");
  };
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
  // These three ran back to back and the caller heard nothing for 3.3s before
  // the phone even started ringing (measured 20:44:41.736 call control ->
  // 20:44:44.998 pre-render done). The brain check and the opening line are
  // independent, so overlap them; the pre-render is the long pole either way.
  const [brainOk, first] = await Promise.all([
    brainCheck(brainConfig).then(() => true),
    openingFn(brainConfig),
  ]);
  if (!brainOk) throw new Error("AI brain preflight failed");
  onLog("[local-media-v2] AI brain preflight passed");
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
    onSessionGone: endSession,
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
            state.bargeLevels = [];
          } else {
            state.speechDuringPlaybackMs = state.speechDuringPlaybackMs || 0;
            if (event.voiced && event.level >= 500) {
              trackBargeLevel(state, event.level);
              if (steadyToneBarge(state)) noteSteadyTone(state, onLog);
              else state.speechDuringPlaybackMs += 20;
            }
            else if (!event.voiced) { state.speechDuringPlaybackMs = 0; state.bargeLevels = []; }
            if (state.speechDuringPlaybackMs >= BARGE_YIELD_MS && !state.interrupted) {
              state.interrupted = true;
              engine.interrupt();
              onLog("[local-media-v2] barge-in detected; outbound playback stopped");
            }
          }
        } else if (state.playing) {
          // Later turns: ignore first 1s of playback, then require sustained
          // voiced energy (not a single noise frame) that varies like speech
          // rather than holding steady like a carrier/ringback tone.
          if (playingMs < 1000) {
            state.speechDuringPlaybackMs = 0;
            state.bargeLevels = [];
          } else if (event.voiced && event.level >= 500) {
            state.speechDuringPlaybackMs = (state.speechDuringPlaybackMs || 0) + 20;
            trackBargeLevel(state, event.level);
            if (steadyToneBarge(state)) noteSteadyTone(state, onLog);
            // Same bar as the opening: soft/room noise must not cut our own
            // sentence off. Speech captured before the interrupt is still kept.
            if (state.speechDuringPlaybackMs >= BARGE_YIELD_MS && !state.interrupted) {
              state.interrupted = true;
              engine.interrupt();
              onLog(`[local-media-v2] barge-in detected; outbound playback stopped (sustained ${state.speechDuringPlaybackMs}ms at level ${event.level})`);
            }
          } else {
            state.speechDuringPlaybackMs = 0;
            state.bargeLevels = [];
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
    if (sessionEnded) {
      onLog("[local-media-v2] session already ended remotely; skipping outbound turn");
      return;
    }
    const locale = normalizeLanguage(turn.locale || activeLocale);
    activeLocale = locale;
    const line = String(text || "").trim();
    const isOpening = !!(preparedOpening && line === preparedOpening.text);
    // A prospect answers a person, not a broadcast. The 20:44Z call ran agent
    // turns of 6.6s, 7.4s, 8.7s and 14.1s - a 14-second monologue over someone
    // who was trying to reply is exactly "it interrupts". Cap the turn and say
    // only the leading sentences when it is over the line, so the prospect
    // always gets a gap to speak in.
    const spoken = isOpening ? line : capTurnLength(line);
    if (line) onLog("AGENT: " + line);
    // Create capture state BEFORE awaiting TTS so inbound audio is never
    // dropped while state is null during synthesis.
    if (!state) {
      let release;
      const ended = new Promise((r) => { release = r; });
      state = { vad: makeVad({ minSpeechMs: 160, endSilenceMs: 700 }), pre: [], chunks: [], started: false, done: false, resolve: release, playing: false, interrupted: false, speechDuringPlaybackMs: 0, playbackStartedAt: 0, openingProtected: false, ended };
    }
    let out;
    if (isOpening) {
      out = preparedOpening.audio;
      preparedOpening = null;
    } else if (isMostlyNonLatin(spoken)) {
      // The brain sometimes mirrors the prospect's script even when the call is
      // configured for another language. On the 21:05Z call that put Devanagari
      // and Arabic text through an English voice, which is what made the prospect
      // say "the dumb AI is not understanding what I'm saying". Refuse to put a
      // script on the wire we have no voice for; the next turn is generated in
      // the configured language.
      onLog(`[local-media-v2] agent turn is mostly non-Latin for locale=${locale}; not speaking it`);
      if (state) { state.playing = false; state.playbackStartedAt = 0; }
      return;
    } else {
      // Keep RTP warm while Edge/python TTS synthesizes so the carrier does
      // not hear a dead/broken gap between turns.
      const ka = typeof engine.keepAlive === "function"
        ? setInterval(() => { try { engine.keepAlive(); } catch {} }, 1200)
        : 0;
      try {
        out = await tts(spoken, { locale, style: config.voiceStyle || "friendly" });
      } finally {
        if (ka) clearInterval(ka);
      }
    }
    if (!out || !Buffer.isBuffer(out.buffer) || out.buffer.length < 160) {
      // One unspeakable turn must not end a live call. On the 20:25Z call an
      // Urdu reply synthesized to nothing and this threw, so the prospect got a
      // dead line 105s in. Log it and keep the conversation open; the opening is
      // still gated by the pre-dial TTS preflight, so a totally broken voice is
      // caught before we ever dial.
      onLog(`[local-media-v2] tts produced no audio for locale=${locale}; skipping turn instead of ending the call`);
      if (state) { state.playing = false; state.playbackStartedAt = 0; }
      return;
    }
    if (!state) {
      let release;
      const ended = new Promise((resolve) => { release = resolve; });
      state = { vad: makeVad({ minSpeechMs: 160, endSilenceMs: 700 }), pre: [], chunks: [], started: false, done: false, resolve: release, playing: true, interrupted: false, speechDuringPlaybackMs: 0, playbackStartedAt: Date.now(), openingProtected: isOpening, ended };
    } else {
      state.playing = true;
      state.interrupted = false;
      state.speechDuringPlaybackMs = 0;
      state.playbackStartedAt = Date.now();
      state.openingProtected = isOpening;
    }
    let n = 0;
    try { n = await engine.sendAudio(out.buffer); }
    catch (e) {
      // A remote BYE mid-playback rejects the send; that is a clean end, not
      // a media failure. Anything else must still surface as before.
      if (!sessionEnded) throw e;
    }
    if (state) {
      state.playing = false;
      state.openingProtected = false;
    }
    if (sessionEnded) return;
    onLog(`[local-media-v2] outbound ${n} bytes PCMU/8000 ${locale} playback finished`);
  };

  const listenFn = async (turn = {}) => {
    if (sessionEnded) return { ended: true, text: null };
    let ended;
    if (state && state.ended) {
      ended = state.ended;
      state.playing = false;
      state.openingProtected = false;
    } else {
      let release;
      ended = new Promise((resolve) => { release = resolve; });
      state = { vad: makeVad({ minSpeechMs: 160, endSilenceMs: 700 }), pre: [], chunks: [], started: false, done: false, resolve: release, playing: false, interrupted: false, speechDuringPlaybackMs: 0, playbackStartedAt: 0, openingProtected: false, ended };
    }
    // A prospect who has stopped talking is answered in well under a second by
    // a human. The old 15s ceiling left 15s of dead air on the line before the
    // agent said anything (measured: playback finished 20:26:07.098, "no speech
    // in window" 20:26:22.109). The VAD still ends the window early the moment
    // real speech stops, so this ceiling only governs "the far end said nothing
    // at all" - and call-runner now budgets the hangup on cumulative quiet time
    // so shortening it does not make the agent hang up sooner than before.
    const windowMs = Number(turn.maxSilenceMs) > 0 ? Number(turn.maxSilenceMs) : 5000;
    const windowStartedAt = Date.now();
    const timer = setTimeout(() => { if (state && !state.done) { state.done = true; state.resolve(); } }, windowMs);
    await ended;
    clearTimeout(timer);
    const waitedMs = Date.now() - windowStartedAt;
    const captured = state;
    state = null;
    if (sessionEnded) return { ended: true, text: null };
    if (!captured.started || !captured.chunks.length) {
      onLog(`[local-media-v2] listen: no speech in window (${waitedMs}ms)`);
      return { text: null, quiet: true, waitedMs };
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
      // flips the agent into inbound "How can I assist you?" mode. They are
      // still audio on the line, so report them as junk rather than as a quiet
      // window — call-runner must not age them toward the dead-line hangup.
      onLog("[local-media-v2] STT junk ignored: " + stt.text);
      return { text: null, junk: true, waitedMs };
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
    return { text: null, junk: !!retry.text, empty: !retry.text, waitedMs };
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
