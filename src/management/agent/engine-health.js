"use strict";
const http = require("node:http");

/* Loopback names this server answers to. A Host outside this set reached
 * 127.0.0.1 under someone else's name (DNS rebinding) and is refused. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function hostnameOf(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(/^[a-z]+:\/\//i.test(raw) ? raw : "http://" + raw).hostname.toLowerCase();
  } catch { return ""; }
}

function json(res, code, body, origin = "*") {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Private-Network": "true",
    "Private-Network-Access-Name": "magic-dialer-engine",
    "Private-Network-Access-ID": "4d:44:4c:52:01:01",
  });
  res.end(JSON.stringify(body));
}

function startEngineHealthServer({ version, getStatus = () => "online", onCall = null, allowedOrigin = "*", port = 18787 } = {}) {
  let callActive = false;
  let callTimer = null;
  let activeAbort = null;
  const CALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max per call
  /* "*" means "no portal is enrolled". It must never mean "any website may
   * place a call": with the default, any page could POST here and spend the
   * customer's money. Call control is therefore closed to cross-origin
   * callers unless a concrete portal origin was configured. Local tooling
   * (no Origin header) still works.
   *
   * The origin is read per request because enrollment happens while this
   * server is already running; caching "*" at boot used to lock the portal out
   * until the next restart once it had enrolled. */
  const configuredOrigin = () => {
    try {
      const value = typeof allowedOrigin === "function" ? allowedOrigin() : allowedOrigin;
      return value && value !== "*" ? String(value).replace(/\/+$/, "") : "";
    } catch { return ""; }
  };
  const server = http.createServer(async (req, res) => {
    if (!LOOPBACK_HOSTS.has(hostnameOf(req.headers.host))) {
      return json(res, 403, { error: "local access only" }, "null");
    }
    const concreteOrigin = configuredOrigin();
    const origin = String(req.headers.origin || "").replace(/\/+$/, "");
    const isCall = (req.method === "POST" || req.method === "OPTIONS") && req.url === "/call";
    const originAllowed = !origin || (!!concreteOrigin && origin === concreteOrigin);
    if (isCall && !originAllowed) return json(res, 403, { error: "origin not allowed" }, "null");
    const responseOrigin = origin && originAllowed ? origin : "*";
    if (req.method === "OPTIONS") return json(res, 204, {}, responseOrigin);
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { ok: true, service: "magic-dialer-engine", version: version || null, status: getStatus(), callControl: typeof onCall === "function" }, responseOrigin);
    }
    if (req.method === "POST" && req.url === "/call") {
      if (typeof onCall !== "function") return json(res, 503, { error: "local call control unavailable" }, responseOrigin);
      if (callActive) return json(res, 409, { error: "a call is already active" }, responseOrigin);
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 4096) return json(res, 413, { error: "request too large" }, responseOrigin);
      }
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch { return json(res, 400, { error: "invalid JSON" }, responseOrigin); }
      const number = String(body.number || "").replace(/[^0-9+]/g, "");
      if (!/^\+?[0-9]{7,15}$/.test(number)) return json(res, 400, { error: "invalid phone number" }, responseOrigin);
      callActive = true;
      activeAbort = new AbortController();
      callTimer = setTimeout(() => { console.warn("[engine-health] call exceeded 5min timeout, aborting"); activeAbort?.abort(); }, CALL_TIMEOUT_MS);
      try {
        const result = await onCall(number, activeAbort.signal);
        return json(res, 200, { ok: true, engine: "local", result }, responseOrigin);
      } catch (e) {
        return json(res, 500, { error: e && e.message || "local call failed", engine: "local" }, responseOrigin);
      } finally { clearTimeout(callTimer); activeAbort = null; callActive = false; }
    }
    return json(res, 404, { error: "not found" }, responseOrigin);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
module.exports = { startEngineHealthServer };
