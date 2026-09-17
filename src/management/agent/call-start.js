"use strict";

/**
 * Start or recover the phone session owned by this agent token and wait until
 * carrier media is connected. This keeps --call/--call-once independent of a
 * browser/admin dial while refusing any local-microphone fallback.
 */
async function ensurePhoneSession({ portal, token, callList, post, log = () => {}, timeoutMs = 60000 }) {
  if (!portal || !token) throw new Error("Portal URL and access token are required for phone calls.");
  if (typeof post !== "function") throw new Error("Phone call transport is unavailable.");

  let sessionId = null;
  let sessionStatus = null;

  try {
    const active = await post(`${portal}/api/agent/active-call`, { token });
    if (active.status === 200 && active.body) {
      sessionId = active.body.sessionId || null;
      sessionStatus = active.body.status || null;
    }
  } catch {}

  if (!sessionId) {
    const destination = Array.isArray(callList)
      ? callList.map((n) => String(n || "").trim()).find(Boolean)
      : null;
    if (!destination) throw new Error("No phone number configured in call list.");

    log("Starting phone call to " + destination);
    const dial = await post(`${portal}/api/agent/dial`, { token, number: destination });
    if (dial.status !== 200 || !dial.body || !dial.body.id) {
      throw new Error((dial.body && dial.body.error) || `Phone dial failed (HTTP ${dial.status}).`);
    }
    sessionId = dial.body.id;
    sessionStatus = dial.body.status || null;
  }

  if (!["connected", "in_call"].includes(String(sessionStatus || ""))) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await post(`${portal}/api/agent/dial-status`, { token, sessionId });
      if (state.status !== 200 || !state.body) {
        throw new Error((state.body && state.body.error) || `Call status failed (HTTP ${state.status}).`);
      }
      sessionStatus = state.body.status || null;
      if (["connected", "in_call"].includes(String(sessionStatus))) break;
      if (["error", "completed"].includes(String(sessionStatus))) {
        throw new Error(state.body.error || `Call ended before media connected (${sessionStatus}).`);
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }

  if (!["connected", "in_call"].includes(String(sessionStatus || ""))) {
    throw new Error("Timed out waiting for phone call to connect.");
  }

  return { sessionId, status: sessionStatus };
}

module.exports = { ensurePhoneSession };
