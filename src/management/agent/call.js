const { speak, speakToBuffer } = require("./voice");
const { hear } = require("./hear");
const { transcribeAuto } = require("./multilingual-stt");
const { normalizeLanguage } = require("./language");
const { runCall } = require("./call-runner");
const { mediaConnect } = require("./media-client");
const { createVad } = require("./vad");
const { requestId, safeError } = require("./safe-diagnostic");

const AUDIO_SAMPLE_RATE = 8000;
const FRAME_BYTES = 160;
const FRAME_MS = 20;

async function voiceCall({
  product, leadFields, persona, companyName, callbackNumber, callbackIn,
  contactEmail, token, portal, sessionId = null, learning, locale = "en", voiceStyle = "friendly", preparedOpeningText = null,
  onLog = () => {}, onMode = () => {}, speakFn, listenFn,
}) {
  const callId = sessionId || requestId();
  let channel = null;
  if (portal && token) {
    try {
      onLog("Connecting to media channel…");
      if (sessionId) {
        channel = await mediaConnect({ portal, sessionId, token, onLog });
        onLog("Media channel connected ✓");
      }
    } catch (e) {
      onLog("Media channel unavailable (" + e.message + "), using local mic.");
    }
  }

  let say, listen;

  if (portal && token && sessionId && (!channel || !channel.open)) {
    throw new Error("Phone media channel failed to connect; refusing local microphone fallback.");
  }

  if (channel && channel.open) {
    let listenState = null;

    channel.onAudio((buffer) => {
      const state = listenState;
      if (!state || !buffer || !buffer.length) return;
      for (let off = 0; off < buffer.length; off += FRAME_BYTES) {
        const frame = buffer.subarray(off, Math.min(off + FRAME_BYTES, buffer.length));
        const v = state.vad.push(frame, FRAME_MS);
        if (!state.started) {
          state.preRoll.push(frame);
          if (state.preRoll.length > 10) state.preRoll.shift();
          if (v.speaking) {
            state.started = true;
            state.startedAt = Date.now();
            state.chunks.push(...state.preRoll);
            state.preRoll = [];
          }
        } else {
          state.chunks.push(frame);
          if (v.ended && !state.done) {
            state.done = true;
            state.resolve();
          }
        }
      }
    });

    say = async (text, turn = {}) => {
      const turnLocale = normalizeLanguage(turn.locale || locale, "en");
      onMode("speaking");
      onLog("AGENT: " + text);
      const result = await speakToBuffer(text, { locale: turnLocale, style: voiceStyle });
      if (!result || !result.buffer) {
        onLog("[media] TTS buffer generation failed");
        return;
      }
      // The media channel carries raw PCMU/8000 bytes. Send the complete
      // utterance as ONE binary message so the cloud trunk can hand the whole
      // buffer to RingCentral's streamAudio() exactly once. Do not split an
      // utterance into 20ms WebSocket messages: streamAudio() already owns RTP
      // framing/pacing, and repeatedly creating one-frame streamers causes
      // audible gaps/clicks/noise.
      if (channel.open) {
        try { channel.sendAudio(result.buffer); } catch (e) { onLog("[media] sendAudio failed: " + (e.message || e)); }
      }
      onLog(`[media] sent ${result.buffer.length} bytes TTS (${result.engine})`);
    };

    listen = async (turn = {}) => {
      onMode("listening");
      onLog("(listening for speech…)");
      const vad = createVad({ minSpeechMs: 160, endSilenceMs: 350 });
      let release;
      const ended = new Promise((resolve) => { release = resolve; });
      const state = { vad, chunks: [], preRoll: [], started: false, startedAt: 0, done: false, resolve: release };
      listenState = state;

      // This is only a dead-line safety ceiling. Conversation timing is VAD-driven.
      const safety = setTimeout(() => { if (!state.done) { state.done = true; state.resolve(); } }, 15000);
      await ended;
      clearTimeout(safety);
      if (listenState === state) listenState = null;

      if (!state.started || state.chunks.length === 0) {
        onLog("(no speech detected)");
        return null;
      }
      const fullAudio = Buffer.concat(state.chunks);
      onLog(`[media] speech turn ${fullAudio.length} bytes, ${Math.round(fullAudio.length / 8)}ms`);
      const requestedLocale = normalizeLanguage(turn.locale || locale, "en");
      const result = await transcribeAuto(fullAudio, {
        hint: turn.autoLanguage ? "auto" : requestedLocale,
        sampleRate: AUDIO_SAMPLE_RATE,
        portal, deviceToken: token, callId,
      });
      const text = result && result.text ? String(result.text).trim() : "";
      const language = result && result.language ? normalizeLanguage(result.language, requestedLocale) : requestedLocale;
      if (text) { onLog("LEAD:  " + text); return { text, language }; }
      onLog("(speech detected but nothing transcribed)");
      return null;
    };
  } else {
    say = speakFn || (async (text, turn = {}) => {
      const turnLocale = normalizeLanguage(turn.locale || locale, "en");
      onMode("speaking"); onLog("AGENT: " + text);
      return speak(text, { locale: turnLocale, style: voiceStyle });
    });
    listen = listenFn || (async (turn = {}) => {
      const turnLocale = normalizeLanguage(turn.locale || locale, "en");
      onMode("listening"); onLog("(listening…)");
      // Local-mic capture remains the offline fallback. The real phone/media path above is VAD-driven.
      const t = await hear({ timeoutMs: 4500, locale: turnLocale });
      if (t) onLog("LEAD: " + t); else onLog("(nothing heard)");
      return t;
    });
  }

  onLog("Starting live call…");
  let result;
  try {
    result = await runCall({ product, leadFields, persona, companyName, callbackNumber, callbackIn, speak: say, listen, contactEmail, learning, locale, preparedOpeningText, portal, deviceToken: token, callId });
  } catch (e) {
    onLog("Call failed [" + callId + "]: " + safeError(e,[token]));
    if (channel) channel.close();
    return { transcript: [], score: 0, goodLead: false, strategies: [], summary: "Call failed", callId, learning: learning || {}, posted: null };
  }
  onLog("Call finished.");
  if (channel) channel.close();

  const updatedLearning = result.learning || learning || {};
  let posted = null;
  if (portal && token) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 15000);
      const res = await fetch(`${portal.replace(/\/+$/, "")}/api/call-result`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, product, transcript: result.transcript, score: result.score, goodLead: result.goodLead, escalateToHuman: result.escalateToHuman, strategies: result.strategies || [], summary: result.summary }),
        signal: ac.signal,
      });
      clearTimeout(timer);
      posted = res.status;
      const body = await res.json().catch(() => ({}));
      onLog(body.emailed ? "Qualified lead email sent ✓" : "Result reported.");
    } catch (e) { clearTimeout(timer); onLog(`Could not report result [${callId}] (${safeError(e,[token])}).`); }
  }
  return { ...result, callId, posted, learning: updatedLearning };
}

module.exports = { voiceCall };
