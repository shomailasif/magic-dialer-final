const { speak } = require("./voice");
const { hear } = require("./hear");
const { transcribeAuto } = require("./multilingual-stt");
const { normalizeLanguage } = require("./language");
const { runCall } = require("./call-runner");
const { requestId, safeError } = require("./safe-diagnostic");

const AUDIO_SAMPLE_RATE = 8000;

/* There was a second, cloud-hosted call path here.
 *
 * When the engine was given a `sessionId` it opened a WebSocket to
 * /ws/media/{id} on the portal and ran the whole conversation over it - its own
 * VAD, its own say and listen, and the whole turn loop. That was the code behind
 * /api/agent/dial and trunk.js, and neither endpoint is served by the deployed
 * portal: it answers 404 for both and deliberately answers 410 on /api/test-call
 * with "cloud call execution disabled".
 *
 * So the branch was unreachable, and worse, it was reachable-looking: a future
 * session reading this file would see a media channel, a VAD at 350ms, and a
 * plausible way to place calls, and wire it up again - which is what happened
 * once already and is why every test call failed at 404.
 *
 * The PC places and carries its own call now, through the engine that
 * local-call-controller owns, so this file keeps only the shape it actually uses:
 * runCall with the caller's own say and listen. */
async function voiceCall({
  product, leadFields, persona, companyName, callbackNumber, callbackIn,
  contactEmail, token, portal, learning, locale = "en", voiceStyle = "friendly",
  preparedOpeningText = null, onLog = () => {}, onMode = () => {}, speakFn, listenFn,
}) {
  const callId = requestId();

  const say = speakFn || (async (text, turn = {}) => {
    const turnLocale = normalizeLanguage(turn.locale || locale, "en");
    onMode("speaking"); onLog("AGENT: " + text);
    return speak(text, { locale: turnLocale, style: voiceStyle });
  });

  const listen = listenFn || (async (turn = {}) => {
    const turnLocale = normalizeLanguage(turn.locale || locale, "en");
    onMode("listening"); onLog("(listening…)");
    /* Local-mic capture, for the offline path with no phone session at all. */
    const t = await hear({ timeoutMs: 4500, locale: turnLocale });
    if (t) onLog("LEAD: " + t); else onLog("(nothing heard)");
    return t;
  });

  onLog("Starting live call…");
  let result;
  try {
    result = await runCall({ product, leadFields, persona, companyName, callbackNumber, callbackIn, speak: say, listen, contactEmail, learning, locale, preparedOpeningText, portal, deviceToken: token, callId });
  } catch (e) {
    onLog("Call failed [" + callId + "]: " + safeError(e,[token]));
    return { transcript: [], score: 0, goodLead: false, strategies: [], summary: "Call failed", callId, learning: learning || {}, posted: null };
  }
  onLog("Call finished.");

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
