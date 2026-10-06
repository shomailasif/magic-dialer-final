"use strict";

const { voiceCall } = require("./call");
const { speakToBuffer } = require("./voice");
const { createVad } = require("./vad");
const { createLocalRingCentralEngine } = require("./local-ringcentral-engine");
const { registerSession } = require("../portal/softphone");
const { transcribeAuto } = require("./multilingual-stt");
const { normalizeLanguage } = require("./language");
const { capTurnLength, MAX_TURN_CHARS } = require("./turn-length");
const { isMostlyNonLatin, NON_LATIN_LOCALE } = require("./script-guard");
const health = require("./gateway-health");
const { opening } = require("./intelligent-brain");

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
  return /^(beep\.?|tone\.?|busy signal\.?|dial tone\.?|ring\.?|ringing\.?|the phone is ringing\.?|phone ringing\.?|phone rings|ringback|voicemail\.?|voice mail\.?|please leave a message.*|leave a message.*|at the tone.*|click\.?|noise\.?|static\.?|hum\.?|zzz\.?|\[.*\]|\(beep\)|dtmf\.?|test\.?)$/.test(s)
    || /^(beep|tone|click|noise|static)[\s.!]*$/.test(s);
}

/** Push one voiced level into the barge-in tone-detection window. */
// How long the prospect must keep talking before the agent stops.
// 300ms was tried and reverted: on the 21:05Z call it guillotined the agent
// five times in two minutes (3610ms played of 6160ms intended, 1970ms of
// 4740ms), which is exactly the rushed, half-finished-sentence delivery being
// complained about. Not talking over the prospect is handled by capping our own
// turn length, not by cutting ourselves off mid-word.
/* How long to keep the window open after the VAD thinks the prospect stopped.
 * The VAD end-of-silence alone cannot be both fast and safe: 350ms truncated
 * people mid-sentence, 700ms made the agent visibly slow to answer, which was
 * reported as a huge delay on every single turn. So the end-of-silence is back
 * to 400ms and this short hold absorbs the gap where someone resumes: their
 * resumed speech is appended to the same utterance instead of starting a new
 * turn, so we answer quickly without cutting anyone off. */
  const SPEECH_HOLD_MS = 120;

  const BARGE_YIELD_MS = 400;

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

/* Did the portal reject this device, as opposed to the AI provider being briefly
 * unavailable? Only the first means "this PC must not dial". */
function isAuthFailure(err) {
  const e = String(err || "").toLowerCase();
  if (!e) return false;
  return /\bunauthori[sz]ed\b|\b401\b|\b403\b|\bforbidden\b|not a registered customer|unregistered|\b409\b/.test(e);
}

async function preflightLocalSip(config, deps = {}) {  const v = config && config.voip || {};
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

async function runLocalCallBody({ config, number, lead, onLog = () => {}, onMode = () => {}, deps = {} }) {
  const makeEngine = deps.createLocalRingCentralEngine || createLocalRingCentralEngine;
  const makeVad = deps.createVad || createVad;
  const tts = deps.speakToBuffer || speakToBuffer;
  const sttAuto = deps.transcribeAuto || transcribeAuto;
  const sttAuthorisedFn = deps.sttAuthorised || require("./stt-preflight").sttAuthorised;
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
  const openingFn = deps.opening || opening;
  const pick = (v, keys) => {
    let x = v;
    if (x && typeof x === "object") {
      for (const k of keys) if (typeof x[k] === "string" && x[k].trim()) { x = x[k]; break; }
      if (typeof x !== "string") x = "";
    }
    const s = String(x == null ? "" : x).trim();
    return !s || s === "[object Object]" ? "" : s;
  };

  /* An opening has to introduce somebody and say why. Anything shorter, or that
   * never names the agent or the company, is a truncated response and is not
   * worth speaking - the customer hears a couple of words and then silence. */
  function isUsableOpening(text, cfg) {
    const s = String(text || "").trim();
    if (s.length < 25) return false;
    const agentName = pick(cfg && cfg.persona, ["name", "agentName", "firstName"]);
    const company = pick(cfg && cfg.companyName, ["name", "companyName", "company"]);
    if (agentName && s.toLowerCase().includes(agentName.toLowerCase())) return true;
    if (company && s.toLowerCase().includes(company.toLowerCase())) return true;
    // Names in full or in part are fine; it only has to be one real sentence.
    return /\b(i am|i'm|my name is|this is|speaking|calling)\b/i.test(s) && s.split(/[.!?]/).filter((x) => x.trim().length > 12).length >= 1;
  }
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
  /* These two ran back to back and the caller heard nothing for 3.3s before
   * the phone even started ringing (measured 20:44:41.736 call control ->
   * 20:44:44.998 pre-render done). The brain check and the opening line are
   * independent, so overlap them; the pre-render is the long pole either way.
   *
   * The separate "reply READY" preflight is gone. It cost a full round trip on
   * every call (~0.9s measured) and it was also a failure mode of its own: it
   * runs in parallel with the opening, so it could pass while the opening got a
   * 502, or fail while the opening succeeded. The opening request already proves
   * the brain works, and an unusable opening now falls back to a local line
   * instead of refusing to dial. */
  const first = await openingFn(brainConfig).catch(() => ({ text: null, error: "opening request failed" }));
  onLog("[local-media-v2] AI brain preflight passed (the opening request is the check)");

  /* Research is gathered here, in the pre-dial window, and nowhere else.
   *
   * It used to be fetched in the background from inside the conversation, which
   * is exactly wrong: the portal accepts one request at a time, this one is slow
   * because it searches the open web, and it was taking the slot the brain
   * needed - turns reached 8s while it ran. Here nobody is waiting on a phone
   * line, so it costs the customer nothing. Bounded, because a slow research
   * fetch must never delay the ring. */
  try {
    const { refresh: refreshResearch } = require("./sales-research");
    await Promise.race([
      refreshResearch({ portal: config.portalUrl, deviceToken: config.deviceToken, product: config.product, vertical: config.companyName }),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
  } catch { /* the deterministic tactic floor covers this */ }
  let openingText = String(first && first.text || "").trim();
  /* An engine that is not authorised cannot think and cannot hear. It must never
   * dial. A gateway blip is worth retrying, but a rejected device is not a blip:
   * every call it placed reached a real prospect as an agent that could not
   * understand them and could not answer - "Could.", "How?", "You cut out for a
   * second there". Falling back to a canned line and dialling anyway is what
   * turned one unenrolled PC into bad calls at the customer's customers. */
  const brainError = String((first && first.error) || "").trim();
  if (!openingText && isAuthFailure(brainError)) {
    throw new Error(
      "This PC is not authorised by the portal (the AI brain rejected it: " + brainError + "). " +
      "The agent cannot hold a conversation without it, so no call was placed. " +
      "Re-enrol this PC from the dashboard, then the queue will work again.",
    );
  }
  if (!openingText) {
    /* A gateway blip must not stop the call being placed. The preflight exists
     * to stop us ringing someone and saying nothing - refusing to dial is a
     * worse failure than opening in a plain line, because the call can still
     * recover once the brain comes back and a greeting still gets the prospect
     * talking. The 20:10Z call was refused outright on one 502: the brain
     * preflight and the opening run in parallel, the preflight got a clean
     * READY and the opening got the 502, and the call never rang. */
    openingText = `Hi, this is ${pick(config.persona, ["name", "agentName", "firstName"]) || "Atlas"} with ${pick(config.companyName, ["name", "companyName", "company"]) || "Zaz Logistics"}. Is now a good time to talk?`;
    onLog(`[local-media-v2] AI opening unavailable (${(first && first.error) || "no text"}); using the local fallback opening`);
  } else if (!isUsableOpening(openingText, config)) {
    /* A truncated opening is worse than a plain one. On the 19:21Z call the
     * brain returned "Hi," and the customer heard two words - "Hi,." - followed
     * by the agent re-introducing itself once the ringback cleared. The four
     * live samples taken straight afterwards all returned full sentences, so
     * this is a bad response rather than a bad prompt, and it has to be caught
     * where it happens. */
    const agentName = pick(config.persona, ["name", "agentName", "firstName"]) || "Atlas";
    const company = pick(config.companyName, ["name", "companyName", "company"]) || "Zaz Logistics";
    onLog(`[local-media-v2] AI opening was unusable (${JSON.stringify(openingText.slice(0, 40))}); using the local opening`);
    openingText = `Hi, this is ${agentName} with ${company}. Is now a good time to talk?`;
  }
  const openingAudio = await tts(openingText, { locale: activeLocale, style: config.voiceStyle || "friendly" });
  if (!openingAudio || !Buffer.isBuffer(openingAudio.buffer) || openingAudio.buffer.length < 160) {
    throw new Error("Opening TTS preflight failed; refusing to place call");
  }
  /* Same rule for hearing: an agent that cannot transcribe cannot hold a
   * conversation, and it used to find that out after ringing a real person. */
  if (sttAuthorisedFn) {
    const hear = await sttAuthorisedFn({ portal: config.portalUrl, deviceToken: config.deviceToken });
    if (hear && hear.fatal) {
      throw new Error(
        "This PC is not authorised by the portal (" + hear.reason + "). The agent would not be " +
        "able to hear the prospect, so no call was placed. Re-enrol this PC from the dashboard.",
      );
    }
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
          // End-of-utterance with a short hold so a resumed sentence is kept in
          // the same window instead of being cut off and re-transcribed.
          if (event.ended && !state.done && !state.holdUntil) state.holdUntil = Date.now() + SPEECH_HOLD_MS;
          if (state.holdUntil) {
            if (event.voiced) state.holdUntil = 0; // they carried on: same utterance
            else if (!state.done && Date.now() >= state.holdUntil) { state.done = true; state.resolve(); }
          }
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
      state = { vad: makeVad({ minSpeechMs: 140, endSilenceMs: 250 }), pre: [], chunks: [], started: false, done: false, resolve: release, playing: false, interrupted: false, speechDuringPlaybackMs: 0, playbackStartedAt: 0, openingProtected: false, ended };
    }
    let out;
    if (isOpening) {
      out = preparedOpening.audio;
      preparedOpening = null;
    } else if (isMostlyNonLatin(spoken) && !NON_LATIN_LOCALE.has(String(locale || "").toLowerCase())) {
      /* Refuse to put a script on the wire that the current voice cannot speak -
       * and only then. This check used to fire on any non-Latin text regardless
       * of the locale, so on a call correctly switched to Urdu the model replied
       * in Urdu and the agent went silent for 25 seconds rather than speak it.
       * The prospect heard nothing at all. For a ur/ar/zh/... call, non-Latin
       * text is the right answer and must always be spoken. */
      onLog(`[local-media-v2] agent turn is mostly non-Latin but the ${locale} voice cannot speak it; not speaking it`);
      if (state) { state.playing = false; state.playbackStartedAt = 0; }
      return;
    } else {
      // Keep RTP warm while Edge/python TTS synthesizes so the carrier does
      // not hear a dead/broken gap between turns.
      const ka = typeof engine.keepAlive === "function"
        ? setInterval(() => { try { engine.keepAlive(); } catch {} }, 1200)
        : 0;
      try {
        out = await tts(spoken, { locale, style: config.voiceStyle || "friendly", intent: turn.intent });
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
      state = { vad: makeVad({ minSpeechMs: 140, endSilenceMs: 250 }), pre: [], chunks: [], started: false, done: false, resolve: release, playing: true, interrupted: false, speechDuringPlaybackMs: 0, playbackStartedAt: Date.now(), openingProtected: isOpening, ended };
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
      state = { vad: makeVad({ minSpeechMs: 140, endSilenceMs: 250 }), pre: [], chunks: [], started: false, done: false, resolve: release, playing: false, interrupted: false, speechDuringPlaybackMs: 0, playbackStartedAt: 0, openingProtected: false, ended };
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
    const sttHint = turn.autoLanguage ? "auto" : (turn.locale || activeLocale);
    /* This audio is the prospect's only utterance. If the STT gateway blips -
     * measured live: "STT gateway HTTP 503" - the whole conversation goes blind.
     *
     * But four 6s attempts is 24s of silence for one short sentence, and on the
     * 20:40Z call that happened three times in a row and then again for the next
     * three turns, because nothing remembered the gateway was already down. So:
     * two bounded attempts, and a circuit breaker that stops paying once the
     * gateway has proved itself dead. Worst case per turn drops from ~25s to
     * ~10s, and to under 100ms on every turn after the third failure. */
    const STT_ATTEMPTS = 2;
    /* Measured on the 06 Oct call: every turn cost 11-15s of dead air, and the
     * transcript showed 13s, 11s, 14s, 13s and 15s gaps in a row. The cause was
     * this budget - 5000ms per attempt, twice, before the AI was even asked, so a
     * single sentence cost ten seconds of waiting and a failed one cost twenty.
     * A short answer transcribes well inside 2500ms; anything slower is a slow
     * gateway, not speech that needs more time, and waiting for it is exactly the
     * silence that makes a prospect say "hello?" and hang up. */
    const STT_ATTEMPT_BUDGET_MS = 2500;
    let stt = null, lastErr = "";
    if (health.isOpen("stt")) {
      stt = { text: null, error: `STT gateway ${health.reason("stt")}` };
    } else {
      for (let attempt = 1; attempt <= STT_ATTEMPTS; attempt++) {
        const startedAt = Date.now();
        let r = null;
        try {
          r = await Promise.race([
            sttAuto(audio, { hint: sttHint, portal: config.portalUrl, deviceToken: config.deviceToken }),
            new Promise((res) => setTimeout(() => res({ error: `STT attempt exceeded ${STT_ATTEMPT_BUDGET_MS}ms` }), STT_ATTEMPT_BUDGET_MS)),
          ]);
        } catch (e) { r = { error: String((e && e.message) || e) }; }
        if (r && r.error) {
          lastErr = r.error;
          health.recordFailure("stt");
          onLog(`[local-media-v2] STT attempt ${attempt}/${STT_ATTEMPTS} failed: ${r.error} (${Date.now() - startedAt}ms)`);
        } else {
          health.recordSuccess("stt");
        }
        if (r && r.text) { stt = r; break; }
        if (r && !r.error) { stt = r; break; } // a real empty result, not a failure
        if (attempt < STT_ATTEMPTS) await new Promise((res) => setTimeout(res, 200));
      }
    }
    if (!stt) stt = { text: null, error: lastErr || "STT unavailable" };
    // Locale changes are owned by call-runner (it applies command/substantial
    // guards); here we only report what the recognizer saw.
    if (stt.language) onLog(`[local-media-v2] STT detected language ${stt.language}`);
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
    // Speech reached the VAD but the recognizer could not turn it into words.
    // The prospect IS there, so this must not be treated as a quiet line: say so
    // and ask them again, rather than hanging up or moving to a new question.
    const gatewayFailed = !!stt.error;
    onLog(gatewayFailed
      ? `[local-media-v2] STT unavailable after ${STT_ATTEMPTS} attempts: ${stt.error}; asking the prospect to repeat`
      : "[local-media-v2] STT returned empty for captured speech; asking the prospect to repeat");
    return { text: null, unheard: true, empty: true, junk: false, gatewayFailed, waitedMs };
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
        /* Which lead this call is for, so the opening can use their name and the
         * conversation is about them. The queue passes it; a manual call has
         * none and the agent opens generically. */
        lead: lead || null,
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
