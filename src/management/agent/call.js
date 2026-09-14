const { speak, speakToBuffer } = require("./voice");
const { hear, hearFromBuffer } = require("./hear");
const { runCall } = require("./call-runner");
const { mediaConnect } = require("./media-client");

/**
 * Live voice call driver.
 *
 * Two modes:
 *   1. MEDIA CHANNEL (when portal + token provided): audio flows through the
 *      cloud portal's WSS media channel. No PC mic or speakers needed — works
 *      for any customer hardware setup. TTS goes down the channel to the
 *      carrier; lead audio comes back up the channel for transcription.
 *   2. LOCAL MIC (fallback): PC speakers play TTS, PC mic listens. Traditional
 *      speakerphone mode for testing without a carrier.
 */

const AUDIO_SAMPLE_RATE = 8000;  // mulaw telephony standard

async function voiceCall({
  product,
  leadFields,
  persona,
  companyName,
  callbackNumber,
  callbackIn,
  contactEmail,
  token,
  portal,
  learning,
  locale = "en",
  voiceStyle = "human",
  onLog = () => {},
  onMode = () => {},
  speakFn,
  listenFn,
}) {
  // --- Try to connect to the media channel ---
  let channel = null;
  if (portal && token) {
    try {
      onLog("Connecting to media channel…");
      // We need the session ID — it's passed as `sessionId` or derived
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
    // === MEDIA CHANNEL MODE ===
    // Accumulator for incoming audio from the lead
    let audioChunks = [];
    let audioResolve = null;
    let listenActive = false;

    channel.onAudio((buffer) => {
      if (listenActive) {
        audioChunks.push(buffer);
        if (audioResolve) {
          const resolve = audioResolve;
          audioResolve = null;
          resolve();
        }
      }
    });

    say = async (text) => {
      onMode("speaking");
      onLog("AGENT: " + text);
      const result = await speakToBuffer(text, { locale, style: voiceStyle });
      if (result && result.buffer) {
        // Send in 160-byte chunks (20ms at 8kHz mulaw)
        const CHUNK = 160;
        for (let i = 0; i < result.buffer.length; i += CHUNK) {
          const chunk = result.buffer.subarray(i, Math.min(i + CHUNK, result.buffer.length));
          channel.sendAudio(chunk);
          // Pace: 20ms per chunk (real-time streaming)
          await new Promise(r => setTimeout(r, 20));
        }
        onLog(`[media] sent ${result.buffer.length} bytes TTS`);
      } else {
        onLog("[media] TTS buffer generation failed");
      }
    };

    listen = async () => {
      onMode("listening");
      onLog("(listening via media channel…)");
      listenActive = true;
      audioChunks = [];

      // Wait for audio or timeout
      const timeoutMs = 6000;
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (audioChunks.length > 0) {
          // Got some audio — wait a bit more for speech to finish
          const silenceWait = 1200;
          const silenceStart = Date.now();
          const preLen = audioChunks.length;
          while (Date.now() - silenceStart < silenceWait) {
            await new Promise(r => setTimeout(r, 200));
            if (audioChunks.length > preLen) break; // more audio arrived
          }
          break;
        }
        await new Promise(r => setTimeout(r, 100));
      }
      listenActive = false;

      if (audioChunks.length === 0) {
        onLog("(nothing heard via media)");
        return null;
      }

      // Concatenate all audio chunks into one buffer
      const fullAudio = Buffer.concat(audioChunks);
      onLog(`[media] received ${fullAudio.length} bytes audio`);

      // Transcribe with vosk
      const text = hearFromBuffer(fullAudio, { locale, sampleRate: AUDIO_SAMPLE_RATE });
      if (text) {
        onLog("LEAD:  " + text);
        return text;
      }
      onLog("(nothing transcribed)");
      return null;
    };

  } else {
    // === LOCAL MIC MODE (fallback) ===
    say = speakFn || (async (text) => {
      onMode("speaking");
      onLog("AGENT: " + text);
      return speak(text, { locale, style: voiceStyle });
    });
    listen = listenFn || (async () => {
      onMode("listening");
      onLog("(listening…)");
      const t = await hear({ timeoutMs: 4500, locale });
      if (t) onLog("LEAD:  " + t);
      else onLog("(nothing heard)");
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
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          product,
          transcript: result.transcript,
          score: result.score,
          goodLead: result.goodLead,
          escalateToHuman: result.escalateToHuman,
          strategies: result.strategies || [],
          summary: result.summary,
        }),
      });
      posted = res.status;
      const body = await res.json().catch(() => ({}));
      onLog(body.emailed ? "Qualified lead email sent ✓" : "Result reported.");
    } catch (e) {
      onLog(`Could not report result (${e.message}).`);
    }
  }

  return { ...result, posted, learning: updatedLearning };
}

module.exports = { voiceCall };
