async function handleAgentDialApi({ url, method, readBody, send, db, trunk, gatewayCtx, dialCtx, getCustomerByToken }) {
  if (url.pathname === "/api/agent/dial" && method === "POST") {
    const body = await readBody();
    const token = String(body.token || "").trim();
    const owner = token ? await getCustomerByToken(db, token) : null;
    if (!owner) { send(401, { error: "Invalid access token" }); return true; }
    try {
      const s = await trunk.placeCall(dialCtx, { customer: owner, destination: body.number });
      send(200, { ok: true, id: s.id, status: s.status, provider: s.provider, providerLabel: s.providerLabel, destination: s.destination, mediaPath: s.mediaPath, error: s.error || null });
    } catch (e) {
      const code = e.code === "BAD_NUMBER" || e.code === "NO_DIALER" ? 400 : 500;
      send(code, { error: e.message });
    }
    return true;
  }

  if (url.pathname === "/api/agent/dial-status" && method === "POST") {
    const body = await readBody();
    const token = String(body.token || "").trim();
    const owner = token ? await getCustomerByToken(db, token) : null;
    if (!owner) { send(401, { error: "Invalid access token" }); return true; }
    const sessionId = String(body.sessionId || "").trim();
    if (!sessionId) { send(400, { error: "Missing session id" }); return true; }
    const s = trunk.getSession(gatewayCtx.portalId, sessionId);
    if (!s) { send(404, { error: "No such call" }); return true; }
    if (s.token !== token) { send(403, { error: "Not your call" }); return true; }
    send(200, { ok: true, id: s.id, status: s.status, provider: s.provider, providerLabel: s.providerLabel, destination: s.destination, startedAt: s.startedAt, mediaPath: s.mediaPath, mediaActive: s.mediaActive === true, mediaBytesIn: s.mediaBytesIn || 0, mediaBytesOut: s.mediaBytesOut || 0, error: s.error || null });
    return true;
  }
  return false;
}

module.exports = { handleAgentDialApi };
