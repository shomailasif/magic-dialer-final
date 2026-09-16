const { speak, speakToBuffer } = require("./voice");
const { hear, hearFromBuffer } = require("./hear");
const { runCall } = require("./call-runner");
const { mediaConnect } = require("./media-client");
const { createVad } = require("./vad");

const AUDIO_SAMPLE_RATE = 8000;
const FRAME_BYTES = 160;
const FRAME_MS = 20;

async function voiceCall({
  product, leadFields, persona, companyName, callbackNumber, callbackIn,
  contactEmail, token, portal, learning, locale = "en", voiceStyle = "friendly",
  onLog = () => {}, onMode = () => {}, speakFn, listenFn,
}) {
  let channel = null;
  if (portal && token) {
    try {
      onLog("Connecting to media channel…");
      const sessionId = arguments[0].sessionId || null;
      if (sessionId) {
        channel = await mediaConnect({ portal, sessionId, token, onLog });
        onLog("Media channel connected ✓");
      }
    } catch (e) {
      onLog("Media channel unavailable (" + e.message + "), using local mic.");
    }
  }

  let say, listen;

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

    say = async (text) => {
      onMode("speaking");
      onLog("AGENT: " + text);
      const result = await speakToBuffer(text, { locale, style: voiceStyle });
      if (!result || !result.buffer) {
        onLog("[media] TTS buffer generation failed");
        return;
      }
      for (let i = 0; i < result.buffer.length; i += FRAME_BYTES) {
        if (!channel.open) break;
        channel.sendAudio(result.buffer.subarray(i, Math.min(i + FRAME_BYTES, result.buffer.length)));
        await new Promise((r) => setTimeout(r, FRAME_MS));
      }
      onLog(`[media] sent ${result.buffer.length} bytes TTS (${result.engine})`);
    };

    listen = async () => {
      onMode("listening");
      onLog("(listening for speech…)");
      const vad = createVad({ minSpeechMs: 160, endSilenceMs: 620 });
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
      const text = hearFromBuffer(fullAudio, { locale, sampleRate: AUDIO_SAMPLE_RATE });
      if (text) { onLog("LEAD:  " + text); return text; }
      onLog("(speech detected but nothing transcribed)");
      return null;
    };
  } else {
    say = speakFn || (async (text) => {
      onMode("speaking"); onLog("AGENT: " + text);
      return speak(text, { locale, style: voiceStyle });
    });
    listen = listenFn || (async () => {
      onMode("listening"); onLog("(listening…)");
      // Local-mic capture remains the offline fallback. The real phone/media path above is VAD-driven.
      const t = await hear({ timeoutMs: 4500, locale });
      if (t) onLog("LEAD:  " + t); else onLog("(nothing heard)");
      return t;
    });
  }

  onLog("Starting live call…");
  let result;
  try {
    result = await runCall({ product, leadFields, persona, companyName, callbackNumber, callbackIn, speak: say, listen, contactEmail, learning, locale });
  } catch (e) {
    onLog("Call failed: " + e.message);
    if (channel) channel.close();
    return { transcript: [], score: 0, goodLead: false, strategies: [], summary: "Call failed: " + e.message, learning: learning || {}, posted: null };
  }
  onLog("Call finished.");
  if (channel) channel.close();

  const updatedLearning = result.learning || learning || {};
  let posted = null;
  if (portal && token) {
    try {
      const res = await fetch(`${portal.replace(/\/+$/, "")}/api/call-result`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, product, transcript: result.transcript, score: result.score, goodLead: result.goodLead, escalateToHuman: result.escalateToHuman, strategies: result.strategies || [], summary: result.summary }),
      });
      posted = res.status;
      const body = await res.json().catch(() => ({}));
      onLog(body.emailed ? "Qualified lead email sent ✓" : "Result reported.");
    } catch (e) { onLog(`Could not report result (${e.message}).`); }
  }
  return { ...result, posted, learning: updatedLearning };
}

module.exports = { voiceCall };
