/* The STT gateway says whether the portal will accept audio from this PC, and
 * an unreach or a rejection is reported without sending any billable audio.
 * A deaf agent is as damaging as a brainless one, so this runs before the dial. */
const STT_PROBE_URL = "https://0nrl0r6g7wyn-production-4w2zqfnq.europe-west1.suga.run";

async function sttAuthorised({ portal, deviceToken, timeoutMs = 12000 } = {}) {
  const base = String(portal || "").replace(/\/+$/, "");
  if (!base || !deviceToken) return { ok: false, fatal: false, reason: "no portal or device token" };
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(base + "/api/engine/ai/stt", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + deviceToken,
      },
      // Far too short to be transcribed, so no audio is ever sent upstream.
      body: JSON.stringify({ audio: "AA==", hint: "auto" }),
      signal: c.signal,
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403 || r.status === 409) {
      return { ok: false, fatal: true, reason: "STT gateway rejected this PC (HTTP " + r.status + ")" };
    }
    // 400 "invalid audio" or a quota response means the route ran and the device
    // is known - that is all this probe is checking.
    return { ok: true, fatal: false, reason: "HTTP " + r.status };
  } catch (e) {
    // A network blip is not proof of a bad device, so it must not stop a call.
    return { ok: false, fatal: false, reason: "STT probe could not reach the portal" };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { sttAuthorised };
