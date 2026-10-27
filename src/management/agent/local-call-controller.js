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
 *
 * The VAD end-of-silence and this hold together decide when the agent speaks, and
 * they were fighting each other. The VAD default is 700ms, but the controller
 * overrode it to 250ms - and the log shows exactly what that costs:
 *
 *   LEAD:  it's the
 *   LEAD:  6234001991          (17 seconds later, as a separate turn)
 *
 * The pause between "it's the" and the digits is longer than 250ms, so the agent
 * decided they had finished, transcribed half the sentence, replied, and made
 * them say the number again. Same for "6234001991". That is the stuttering, and
 * it reads as the agent not listening.
 *
 * 700ms of end-silence is the cost of not cutting anyone off. The hold below
 * adds a little more on top so trailing digits that land just after the VAD
 * gives up are still part of the same utterance. A prospect who has genuinely
 * finished is not harmed by this: the agent is waiting on silence, not adding
 * silence of its own, and everything after it - transcription, the brain, the
 * reply - is unchanged. */
  const SPEECH_HOLD_MS = 250;

  const BARGE_YIELD_MS = 400;

/* How many times a single turn will try to hear the prospect.
 *
 * Declared here, at module scope, and NOT inside runStt. It is read in two
 * sibling functions - runStt to drive the retry loop, and listenFn to say how
 * many attempts were spent when none of them worked - and a const declared inside
 * runStt is invisible to listenFn. That cost a real call on 13 Oct: the fourth
 * turn failed, and the failure REPORT threw `STT_ATTEMPTS is not defined`,
 * which killed the call and replaced the real reason with a nonsense one.
 *
 * Every turn that ends with an unheard utterance hit this, so it was never a
 * rare path - it was the path taken every time recognition failed, which is
 * exactly when the message matters most. */
const STT_ATTEMPTS = 2;

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
  /* Derive readiness from the credentials rather than trusting `v.ready`:
   * that flag is written on save, so a config created before the flag (or by
   * hand) holds a perfectly working line that this check used to refuse. */
  if (!v.username || !v.sipPassword || !v.number) throw new Error("VOIP configuration incomplete");
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
  /* Close a capture window exactly once, and freeze what it was holding when it
   * closed.
   *
   * Inbound frames keep arriving for as long as `state` is non-null, so reading
   * state.chunks after the window resolved can pick up frames from AFTER the
   * turn ended. That used to be harmless. It is not harmless now that
   * transcription can start before the window closes: the re-transcribe decision
   * has to be made against the buffer that belongs to this turn, not against
   * whatever arrived while the browser was elsewhere. So the frame list is copied
   * at close and that copy is what gets transcribed. */
  const closeWindow = (win) => {
    if (!win || win.done) return;
    win.done = true;
    win.finalChunks = win.chunks.slice();
    win.voicedAfterEos = win.voicedAfterEos || 0;
    win.onEos = null;
    win.resolve();
  };
  const endSession = () => {
    if (sessionEnded) return;
    sessionEnded = true;
    if (state) closeWindow(state);
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
      refreshResearch({ portal: config.portalUrl, deviceToken: config.deviceToken, product: config.product, vertical: config.companyName, website: config.website || config.websiteUrl }),
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

  /* Inbound audio that arrives when no window is open.
   *
   * `state` is null for the whole gap between one listen window returning and the
   * next one being built - during transcription, the brain call, synthesis, and
   * the agent's own playback. onAudio used to `if (!state) return`, so every
   * frame spoken in that gap was discarded. A prospect who starts talking as the
   * agent finishes is therefore unheard: the first word is dropped, and if the
   * rest falls inside the gap as well, the whole sentence is.
   *
   * On 06 Oct the agent's last turn ended and "Hello." at 15:35:01 produced no
   * reply at all. That is this.
   *
   * So speech outside a window is kept, not dropped, and seeds the pre-roll of
   * the next window - which already exists to hold speech that began just before
   * the VAD decided there was any. Bounded, so a long silence cannot grow. */
  const IDLE_BUFFER_FRAMES = 25; // 500ms at 20ms a frame
  const PRE_ROLL_FRAMES = IDLE_BUFFER_FRAMES + 10;
  let idleFrames = [];
  const seedPre = () => {
    const seeded = idleFrames.slice();
    idleFrames = [];
    return seeded;
  };

  const engine = makeEngine({
    number: target,
    sip: sipOptions(v),
    onLog,
    onSessionGone: endSession,
    onAudio: (b) => {
      if (!state) {
        for (let i = 0; i + 160 <= b.length; i += 160) {
          idleFrames.push(b.subarray(i, i + 160));
          if (idleFrames.length > IDLE_BUFFER_FRAMES) idleFrames.shift();
        }
        return;
      }
      for (let i = 0; i < b.length; i += 160) {
        const frame = b.subarray(i, i + 160);
        if (frame.length < 160) continue;
        const event = state.vad.push(frame, 20);
        /* When the far end last made a sound. This is what the listen window's
         * ceiling is measured from - see listenFn. It has to be stamped here,
         * on the frame that carries the voice, because nothing else in the loop
         * knows a human is still talking. */
        if (event.voiced) state.lastVoicedAt = Date.now();
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
          /* The pre-roll has to be able to hold what was seeded from the idle
           * buffer as well as what arrived inside this window, or the seeded
           * frames are evicted as soon as the first new frame lands and the
           * prospect's opening word is lost again - which is the bug. */
          if (state.pre.length > PRE_ROLL_FRAMES) state.pre.shift();
          if (event.speaking) { state.started = true; state.chunks.push(...state.pre); state.pre = []; }
        } else {
          state.chunks.push(frame);
          /* END OF SPEECH, LATCHED ONCE.
           *
           * `event.ended` stays true for every silent frame from here on, so it
           * has to be latched or the timestamp would keep moving and measure the
           * end of the silence rather than the start of it.
           *
           * This is the moment transcription starts. Everything the VAD knows is
           * already in state.chunks, and the 250ms hold below is only insurance
           * against a prospect who resumes. Waiting for that insurance before
           * starting STT cost ~250ms of dead air on every single turn; now the
           * two overlap, and the hold's verdict is applied afterwards (see
           * listenFn). */
          if (event.ended && !state.eosLatched) {
            state.eosLatched = true;
            if (typeof state.onEos === "function") {
              try { state.onEos(); } catch (e) { onLog("[local-media-v2] end-of-speech hook failed: " + ((e && e.message) || e)); }
            }
          }
          /* Any voice after the end-of-speech latch is a resumed utterance, which
           * is what decides whether the transcript has to be redone. Counted, not
           * inferred from length: the hold also accumulates ~250ms of SILENCE, so
           * the buffer always grows during it and length alone would say "the
           * hold was used" on every turn. */
          if (state.eosLatched && event.voiced) state.voicedAfterEos++;
          // End-of-utterance with a short hold so a resumed sentence is kept in
          // the same window instead of being cut off and re-transcribed.
          if (event.ended && !state.done && !state.holdUntil) state.holdUntil = Date.now() + SPEECH_HOLD_MS;
          if (state.holdUntil) {
            if (event.voiced) state.holdUntil = 0; // they carried on: same utterance
            else if (!state.done && Date.now() >= state.holdUntil) closeWindow(state);
          }
        }
      }
    },
  });

  await engine.connect();
  /* Two gates, and they answer different questions.
   *
   * This one asks "is the far end ready for audio at all", and inbound RTP
   * arrives within a frame or two of the answer, so it costs tens of
   * milliseconds and it must stay that cheap. Speaking the millisecond
   * "answered" fires is how the AI opened before the far end was ready.
   *
   * It says NOTHING about whether the other person has spoken, and that used to
   * be the only gate: the opener was therefore on the wire long before the
   * prospect's own "Hello?" had finished. The speech gate is firstSpeechFn below
   * - it is a real capture window, so it ends when the VAD says their speech has
   * ended rather than when RTP appeared. */
  if (typeof engine.waitForInboundMedia === "function") {
    const media = await engine.waitForInboundMedia(1200);
    onLog(`[local-media-v2] inbound RTP ready: ${media.gotInbound ? "yes" : "no"} after ${media.waitedMs}ms`);
  }
  let preparedOpening = { text: openingText, audio: openingAudio };
  /* Counted so the "the agent went quiet" complaint becomes a number instead of an
   * anecdote. Zero is the target; anything else is a turn that cost silence. */
  let contentlessTurns = 0;
  /* What to say when OUR side produces nothing and we refuse to leave a gap.
   *
   * Deliberately not "sorry, I did not catch that" - that blames the prospect
   * for our failure. And deliberately not a question, because a question here
   * re-enters the ask-repetition guard on the following turn and the call
   * loops. These hand the floor back without pretending to have failed to hear.
   *
   * Per-locale because the English-only version of this bug was exactly how an
   * Urdu call got told "Sorry, I did not catch that" in English. */
  const NEXT_ON_DECENT_LINE = Object.freeze({
    en: "Absolutely - tell me what you need and I will help you with it.",
    ur: "بالکل - بتائیے آپ کو کیا چاہیے، میں آپ کی مدد کرتا ہوں۔",
    es: "Claro - dígame qué necesitas y te ayudo.",
    ru: "Конечно - скажите, что вам нужно, и я помогу.",
    fr: "Bien sûr - dites-moi ce qu'il vous faut et je vous aide.",
    it: "Certo - mi dica cosa le serve e la aiuto.",
    zh: "当然 - 告诉我您的需求，我来帮您。",
    hi: "बिल्कुल - बताइए आपको क्या चाहिए, मैं मदद करूँगा।",
  });
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
    /* The agent NEVER goes silent.
     *
     * `capTurnLength` deliberately returns "" for a contentless turn - "Got it.",
     * "Thanks.", "Okay.", "Great." - on the reasoning that the caller should
     * substitute something a person needs to hear. The caller did not.
     * `speakToBuffer("")` returns null immediately, the turn is skipped, and the
     * prospect gets dead air in the middle of their own sentence.
     *
     * Measured on the call of 13 Oct: twice, for exactly this reason, producing
     * ~12s of silence where the agent should have been speaking. This is the
     * complaint that has been open for two months - the agent "going quiet" mid
     * call - and it is not a model problem and not a TTS problem. It is a missing
     * branch here.
     *
     * So the substitution happens, and it asks them to repeat rather than
     * announcing filler: the agent produced nothing usable, so the honest thing
     * to put on the line is "I didn't catch that", which also gives the prospect
     * the floor back. Applied AFTER capping, because the substitute is itself
     * capped-checked - running it back through capTurnLength could return "" again
     * and recurse straight into the silence this closes. */
const capped = isOpening ? line : capTurnLength(line);
      let spoken = capped;
      if (!spoken) {
        /* We could not say anything and silence is not an option, so say the
         * least-wrong thing.
         *
         * The first version of this was "Sorry, I did not catch that." That
         * claims the PROSPECT was unintelligible, and on the call of 13 Oct it
         * was said to somebody whose very next words were perfectly clear: they
         * said "Okay." and were told we did not catch that, then asked to repeat
         * something they had said correctly. It reads as a machine that missed
         * the word "okay" - which is worse than the silence it replaced, because
         * now they doubt whether anything they said got in.
         *
         * Nothing here tells us the prospect was unclear. They spoke, the
         * recogniser accepted it, and then OUR side produced no usable line.
         * So the substitute has to be about us and it has to move the call
         * forward rather than restart it - a prospect repeating a word we failed
         * to answer loses the thread, and so does the call.
         *
         * These are deliberately statements, not questions. A question here would
         * be re-asked forever by the guard above whenever the prospect answers
         * it, and the whole point of this branch is to break the loop, not add
         * one more turn to it. */
        onLog(`[local-media-v2] brain produced no speakable turn (${JSON.stringify(line).slice(0, 60)}); holding the floor with a forward line instead of going silent`);
        spoken = NEXT_ON_DECENT_LINE[locale] || NEXT_ON_DECENT_LINE.en;
        contentlessTurns++;
      }
    if (line) onLog("AGENT: " + line);
    // Create capture state BEFORE awaiting TTS so inbound audio is never
    // dropped while state is null during synthesis.
    if (!state) {
      let release;
      const ended = new Promise((r) => { release = r; });
      state = { vad: makeVad({ minSpeechMs: 160 }), pre: seedPre(), chunks: [], started: false, done: false, resolve: release, playing: false, interrupted: false, speechDuringPlaybackMs: 0, playbackStartedAt: 0, openingProtected: false, ended, eosLatched: false, voicedAfterEos: 0, onEos: null, finalChunks: null };
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
      state = { vad: makeVad({ minSpeechMs: 160 }), pre: seedPre(), chunks: [], started: false, done: false, resolve: release, playing: true, interrupted: false, speechDuringPlaybackMs: 0, playbackStartedAt: Date.now(), openingProtected: isOpening, ended, eosLatched: false, voicedAfterEos: 0, onEos: null, finalChunks: null };
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
      /* We were the one talking. If the far end said nothing while we played,
       * everything this window is holding is OUR OWN voice and the silence around
       * it, and the recognizer must never be handed that. If they DID start
       * talking, it is theirs and it stays - see listenFn.
       *
       * Before this, the pre-roll was left in place and listenFn then built a
       * fresh window over the top of it, so the tail of our own playback was
       * either transcribed as the prospect's words or thrown away with the rest
       * of their utterance. */
      if (!state.started) { state.pre = []; state.chunks = []; }
    }
    if (sessionEnded) return;
    onLog(`[local-media-v2] outbound ${n} bytes PCMU/8000 ${locale} playback finished`);
  };

  const listenFn = async (turn = {}) => {
    if (sessionEnded) return { ended: true, text: null };
    let ended;
    let win;
    if (state) {
      /* Reuse the window that is already open.
       *
       * It used to build a fresh one whenever the existing window had not
       * finished, and that threw away the prospect's speech: speakFn captures
       * inbound audio for the whole time we are talking, and everything it holds
       * at that moment is discarded by the replacement. A person who starts
       * answering as the agent finishes - the ordinary way anyone interrupts -
       * was therefore silenced, which is the exact failure the idle-frame buffer
       * above was added to prevent. It only ever covered the gap where `state`
       * is null, which is between windows and never during playback.
       *
       * Our own audio is kept out of it by the reset at the end of speakFn: if
       * they did not speak while we played, the window is emptied. */
      win = state;
      ended = win.ended;
      win.playing = false;
      win.openingProtected = false;
    } else {
      let release;
      ended = new Promise((resolve) => { release = resolve; });
      state = { vad: makeVad({ minSpeechMs: 160 }), pre: seedPre(), chunks: [], started: false, done: false, resolve: release, playing: false, interrupted: false, speechDuringPlaybackMs: 0, playbackStartedAt: 0, openingProtected: false, ended, lastVoicedAt: 0, eosLatched: false, voicedAfterEos: 0, onEos: null, finalChunks: null };
      win = state;
    }
    /* A prospect who has stopped talking is answered in well under a second by
     * a human. The old 15s ceiling left 15s of dead air on the line before the
     * agent said anything (measured: playback finished 20:26:07.098, "no speech
     * in window" 20:26:22:109). The VAD still ends the window early the moment
     * real speech stops, so this budget only has to govern "the far end said
     * nothing for a while" - and call-runner budgets the hangup on cumulative
     * quiet time, so it does not make the agent hang up sooner than before.
     *
     * It is a DEAD LINE budget, not a TURN budget, and that distinction is the
     * whole fix for truncated prospect speech.
     *
     * It used to be a single setTimeout taken when the window opened, so it
     * expired mid-sentence for anyone who talked for longer than the budget and
     * the recognizer was handed the first five seconds of their words and
     * nothing after them. On the 07 Oct call that is exactly what a transcript
     * entry reads like:
     *
     *   LEAD:  What do you
     *
     * a sentence ending on a dangling function word, because that is where five
     * seconds of audio fell. The comment above it claimed the VAD ends the
     * window early "the moment real speech stops, so this ceiling only governs
     * the far end said nothing at all" - and for an utterance with less than
     * endSilenceMs (700ms) of breath in it, there is no such moment, so the
     * ceiling is the only thing that ever ended the turn. A length cap belongs
     * on what WE say; it must never bound what THEY say.
     *
     * So the budget is measured from the last voiced frame. While they are
     * talking the window stays open and their whole sentence is captured; when
     * they fall silent it still closes within the budget, which is the
     * behaviour the number was chosen for. MAX_SPEAKING_WINDOW_MS is only a
     * guard so a stuck VAD cannot hold a live call open forever. */
    const windowMs = Number(turn.maxSilenceMs) > 0 ? Number(turn.maxSilenceMs) : 5000;
    const MAX_SPEAKING_WINDOW_MS = 25000;
    const windowStartedAt = Date.now();
    const quietTimer = setInterval(() => {
      if (!win || win.done) return;
      const quietSince = win.lastVoicedAt ? win.lastVoicedAt : windowStartedAt;
      if (Date.now() - quietSince >= windowMs || Date.now() - windowStartedAt >= MAX_SPEAKING_WINDOW_MS) {
        closeWindow(win);
      }
    }, 100);

    /* TRANSCRIPTION STARTS AT THE VAD'S OWN END-OF-SPEECH, NOT AFTER THE HOLD.
     *
     * The window used to sit on 950ms of dead air before a single byte reached
     * the recognizer: 700ms of VAD end-silence plus SPEECH_HOLD_MS of fixed wait
     * (measured, audio-sim, real Groq STT + real Groq brain + real Edge TTS):
     *
     *   turn     eos   hold    stt   brain    tts   total
     *   0        687    252    299     253   2076    3600
     *
     * All of it is avoidable without touching what the hold is FOR. The hold
     * exists because a prospect who resumes mid-sentence must stay one utterance
     * - "it's the" followed by the number 17 seconds later was the stuttering
     * that was complained about, and deleting the hold reintroduces it. But the
     * hold is not a reason to WAIT: at the instant the VAD says ended, the audio
     * is already buffered, so STT can begin immediately and the hold runs
     * alongside it.
     *
     * So the turn is now speculative-then-corrected:
     *   - STT starts on the buffer as it stands at end-of-speech.
     *   - if the hold expires without a voiced frame, that transcript is the
     *     answer. One STT call, ~250ms earlier than before.
     *   - if a voiced frame arrives during the hold, the prospect carried on, so
     *     that transcript is a fragment of a longer sentence. It is discarded and
     *     STT runs again on the extended buffer, and the LONGER one wins.
     *
     * The re-transcribe only happens on turns where the hold is actually used,
     * which is exactly the turn where a fragment would have been a defect, so one
     * extra billable STT call there is the correct trade against truncating
     * somebody. Worst case those turns are ~250ms + one STT slower than before.
     */
    const runStt = async (audio) => {
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
       * ~10s, and to under 100ms on every turn after the third failure.
       *
       * STT_ATTEMPTS is declared at MODULE scope above, not here: listenFn reads
       * it too when a turn ends with an unheard utterance, and a const declared
       * inside this function is invisible to a sibling function. That is what
       * killed the call of 13 Oct with "STT_ATTEMPTS is not defined". */
      /* Measured on the 06 Oct call: every turn cost 11-15s of dead air. The cause
       * was this budget at 5000ms per attempt, twice, before the AI was even asked,
       * so one sentence cost ten seconds of waiting and a failed one cost twenty.
       *
       * It was then cut to 2500ms to halve that, and that was wrong. The live call
       * on 07 Oct measured real transcriptions at 2516ms and 2503ms - a couple of
       * milliseconds past the new budget - so every single turn was discarded and
       * the agent went deaf:
       *   STT attempt 1/2 failed: STT attempt exceeded 2500ms (2516ms)
       *   STT attempt 2/2 failed: STT attempt exceeded 2500ms (2503ms)
       * The transcript showed the agent talking to nobody - "That gives me a clear
       * picture", three "Sorry"s, and a prospect asking "Who is this?" twice with no
       * answer. None of that was the brain failing; it was never given a word to
       * work with. Halving the budget did not halve the silence, it removed the
       * hearing.
       *
       * The cost of waiting one short turn is far smaller than the cost of never
       * understanding a word: a prospect who is answered is worth more than one who
       * is answered 2s sooner but wrongly.
       *
       * Verified against the live gateway after the revert: a transcription came
       * back in 5458ms. At 6000ms that is half a second of headroom, and it is
       * inside the gateway's own 4500ms budget plus a slow retry - so a turn that
       * needed its second attempt would fail here rather than being spoken late.
       * 12000ms holds three attempts and keeps the prospect listening to us rather
       * than to silence. The circuit breaker still short-circuits a dead gateway,
       * so a real outage is not made slower by any of this. */
      /* The whole turn gets ONE budget, shared by every attempt.
       *
       * It was 12000 per attempt, twice, so a turn could spend 24s on
       * transcription alone. Worse, the gateway's own provider budget is 4500ms:
       * a request that blows that returns 5xx rather than hanging, so the
       * controller saw a "failure" at ~4.5s, waited 200ms, and paid the second
       * 12s for an answer the first attempt was about to have produced anyway.
       * That is how a single turn reaches the multi-second outliers that were
       * logged as one unexplained number.
       *
       * Sharing one budget means the sum of every attempt is capped, so a retry
       * can never quietly double a turn. It also matches the rule the rest of
       * this work learned the hard way: a bound that applies per attempt is not
       * a bound on the turn.
       *
       * 9000ms total is still far above any real transcription (warm p100 around
       * 2.2s) and above the gateway's 4500ms provider budget plus a retry, so a
       * turn that genuinely needs two attempts still gets two. */
      const STT_TURN_BUDGET_MS = 9000;
      let stt = null, lastErr = "", turnStartedAt = Date.now(), attemptsUsed = 0;
      if (health.isOpen("stt")) {
        stt = { text: null, error: `STT gateway ${health.reason("stt")}` };
      } else {
        for (let attempt = 1; attempt <= STT_ATTEMPTS; attempt++) {
          const startedAt = Date.now();
          const left = STT_TURN_BUDGET_MS - (Date.now() - turnStartedAt);
          /* No time for a full second attempt - spend what is left rather than
           * starting one that cannot finish inside the budget. */
          if (attempt > 1 && left < 1200) {
            onLog(`[local-media-v2] STT attempt ${attempt}/${STT_ATTEMPTS} skipped: only ${left}ms of the ${STT_TURN_BUDGET_MS}ms turn budget left`);
            break;
          }
          attemptsUsed = attempt;
          let r = null;
          try {
            r = await Promise.race([
              sttAuto(audio, { hint: sttHint, portal: config.portalUrl, deviceToken: config.deviceToken }),
              new Promise((res) => setTimeout(() => res({ error: `STT turn budget exhausted` }), Math.max(250, left))),
            ]);
          } catch (e) { r = { error: String((e && e.message) || e) }; }
          const elapsed = Date.now() - startedAt;
          /* Timed on SUCCESS as well as on failure.
           *
           * Only failures were ever logged, which is why a 7751ms first-turn STT
           * could be observed and never explained: there was no number for it. A
           * slow-but-successful transcription is exactly the case worth seeing, and
           * it is the one that costs a prospect real time rather than producing an
           * error message. `path` says which leg answered, so a slow gateway hop
           * and a slow provider are distinguishable in the log rather than being
           * the same unexplained figure. */
          if (r && r.error) {
            lastErr = r.error;
            health.recordFailure("stt");
            onLog(`[local-media-v2] STT attempt ${attempt}/${STT_ATTEMPTS} failed: ${r.error} (${elapsed}ms)`);
          } else {
            health.recordSuccess("stt");
            const path = r && r.path ? r.path : "unknown";
            /* Only the slow ones, and every first turn. A log line per turn at
             * normal speed is noise; a log line for the first turn of every call
             * is the one that would have caught this. */
            if (elapsed >= 1500 || attempt === 1) {
              onLog(`[local-media-v2] STT attempt ${attempt}/${STT_ATTEMPTS} ok via ${path} (${elapsed}ms, turn total ${Date.now() - turnStartedAt}ms)`);
            }
          }
          if (r && r.text) { stt = r; break; }
          if (r && !r.error) { stt = r; break; } // a real empty result, not a failure
          if (attempt < STT_ATTEMPTS) await new Promise((res) => setTimeout(res, 200));
        }
      }
      const totalMs = Date.now() - turnStartedAt;
      if (totalMs >= 1500 || attemptsUsed > 1) {
        onLog(`[local-media-v2] STT turn total ${totalMs}ms over ${attemptsUsed} attempt(s), ${audio.length} bytes PCMU`);
      }
      return stt || { text: null, error: lastErr || "STT unavailable" };
    };

    /* Idempotent: the latch fires once, and listenFn also fires it directly when
     * the window ended before this turn started listening to it (a prospect who
     * talked over the agent can reach end-of-speech before listenFn runs). */
    let early = null;
    const startEarlyStt = () => {
      if (early || !win.started || !win.chunks.length || win.done) return;
      const snapshot = Buffer.concat(win.chunks);
      early = { promise: runStt(snapshot).catch((e) => ({ text: null, error: String((e && e.message) || e) })) };
    };
    win.onEos = startEarlyStt;
    if (win.eosLatched) startEarlyStt();

    await ended;
    clearInterval(quietTimer);
    win.onEos = null;
    const waitedMs = Date.now() - windowStartedAt;
    const captured = state;
    state = null;
    if (sessionEnded) return { ended: true, text: null };
    const turnChunks = (captured.finalChunks && captured.finalChunks.length) ? captured.finalChunks : captured.chunks;
    if (!captured.started || !turnChunks.length) {
      onLog(`[local-media-v2] listen: no speech in window (${waitedMs}ms)`);
      return { text: null, quiet: true, waitedMs };
    }
    const audio = Buffer.concat(turnChunks);
    const holdWasUsed = (captured.voicedAfterEos || 0) > 0;
    let stt;
    if (early && !holdWasUsed) {
      /* The ordinary turn: the hold found nobody, so the speculative transcript
       * IS the turn, and exactly one STT call was made. */
      stt = await early.promise;
    } else {
      /* Either the hold caught a resumed sentence - in which case the speculative
       * transcript is a fragment and the longer one must win - or there was no
       * speculative call to begin with. The speculative call is awaited first so
       * two recognizer calls can never be in flight for one turn at once. */
      if (early) {
        const first = await early.promise;
        if (holdWasUsed) onLog(`[local-media-v2] prospect resumed inside the ${SPEECH_HOLD_MS}ms hold; re-transcribing the full utterance (speculative pass returned ${JSON.stringify(String((first && first.text) || "").slice(0, 40))})`);
      }
      stt = await runStt(audio);
    }
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

  /* THE SPEECH GATE. Do not open our mouth until the far end has spoken.
   *
   * This is a product rule, and the live call of 07 Oct broke it on both counts:
   *
   *   ringcentral: Hi, this is Atlas with Zaz Logistics. Is now a good time...  (t+7s)
   *   Haris:       Hello?                                                       (t+7s)
   *
   * The opener was already on the wire at the instant the prospect said "Hello?",
   * because the only thing gating it was inbound RTP, which is true within a
   * frame or two of the far end being answered - whether or not a word has been
   * said. A person who answers a phone says something; an agent that talks over
   * that is not holding a conversation.
   *
   * So this is a real capture window, not a media gate. It runs the same VAD a
   * turn runs, so it ends when the prospect's speech ends rather than when RTP
   * appeared, and it returns their words with it - which is what lets the
   * conversation answer what they actually said instead of reading an opener
   * over the top of it.
   *
   * FIRST_SPEECH_TIMEOUT_MS is the fallback, for a prospect who answers and says
   * nothing at all. 4000ms:
   *
   *  - Long enough to be useless to skip. Somebody who has picked up and is
   *    going to speak has started within about a second and a half of the
   *    answer - "Hello?", "Hello, yes?", "One moment", "Yes, go ahead" - so 4s
   *    captures every one of those with room to spare, and the window closes the
   *    moment their breath ends rather than waiting the full budget out.
   *  - Short enough to keep. A person who picked up and said nothing has usually
   *    decided nobody is there, and four seconds of dead air before the first
   *    word is about as long as a caller will sit through. It is also below the
   *    5000ms quiet budget every other window uses, so the opener can never be
   *    later in this call than any other thing the agent says.
   */
  const FIRST_SPEECH_TIMEOUT_MS = 4000;
  const firstSpeechFn = async (turn = {}) => {
    const got = await listenFn({ ...turn, maxSilenceMs: FIRST_SPEECH_TIMEOUT_MS, gate: true });
    onLog(
      "[local-media-v2] speech gate: " +
      (got && got.ended ? "call ended before we spoke"
        : got && got.text ? "the prospect spoke first: " + got.text
        : got && got.junk ? "a carrier tone or voicemail, not a person"
        : got && got.unheard ? "someone is speaking and we could not make them out"
        : "silence; opening after " + FIRST_SPEECH_TIMEOUT_MS + "ms") +
      " (waited " + ((got && got.waitedMs) || 0) + "ms)",
    );
    return got;
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
        /* How long to wait for a voice before speaking the opening at all. */
        firstSpeechFn,
        onLog,
        onMode,
      });
  } finally {
    engine.close();
  }
}

/* runLocalCallBody is exported alongside the entry point, not instead of it.
 *
 * It is the whole conversation and it cannot dial by itself: the only thing that
 * reaches a carrier is the engine returned by createLocalRingCentralEngine, and
 * that is a deps injection point. src/management/build/audio-sim.js runs it with
 * an injected local media engine to drive the real VAD/STT/brain/TTS offline and
 * time every stage, and it must never go through runLocalCall - the name that
 * means "place a call" - even with the same deps. */
module.exports = { runLocalCall, runLocalCallBody, preflightLocalSip, sipOptions };
