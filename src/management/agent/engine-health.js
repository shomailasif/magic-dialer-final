"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

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
  const noncePath = path.join(os.homedir(), ".magicdialer", "browser-token");
  let browserToken = "";
  try { fs.mkdirSync(path.dirname(noncePath), { recursive: true }); browserToken = fs.existsSync(noncePath) ? fs.readFileSync(noncePath, "utf8").trim() : crypto.randomBytes(24).toString("hex"); if (!fs.existsSync(noncePath)) fs.writeFileSync(noncePath, browserToken, { mode: 0o600 }); } catch { browserToken = crypto.randomBytes(24).toString("hex"); }
  let callActive = false;
  const server = http.createServer(async (req, res) => {
    const origin = String(req.headers.origin || "");
    const corsOrigin = allowedOrigin === "*" ? "*" : (origin === allowedOrigin ? origin : "");
    if (origin && !corsOrigin) return json(res, 403, { error: "origin not allowed" }, "null");
    if (req.method === "OPTIONS") return json(res, 204, {}, corsOrigin || allowedOrigin);
    if (req.method === "GET" && req.url === "/browser-call") {
      const u = new URL(req.url, "http://127.0.0.1");
      return json(res, 400, { error: "number required" }, corsOrigin || allowedOrigin);
    }
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { ok: true, service: "magic-dialer-engine", version: version || null, status: getStatus(), callControl: typeof onCall === "function" }, corsOrigin || allowedOrigin);
    }
    if (req.method === "POST" && req.url === "/call") {
      if (typeof onCall !== "function") return json(res, 503, { error: "local call control unavailable" }, corsOrigin || allowedOrigin);
      if (callActive) return json(res, 409, { error: "a call is already active" }, corsOrigin || allowedOrigin);
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 4096) return json(res, 413, { error: "request too large" }, corsOrigin || allowedOrigin);
      }
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch { return json(res, 400, { error: "invalid JSON" }, corsOrigin || allowedOrigin); }
      const number = String(body.number || "").replace(/[^0-9+]/g, "");
      if (!/^\+?[0-9]{7,15}$/.test(number)) return json(res, 400, { error: "invalid phone number" }, corsOrigin || allowedOrigin);
      callActive = true;
      try {
        const result = await onCall(number);
        return json(res, 200, { ok: true, engine: "local", result }, corsOrigin || allowedOrigin);
      } catch (e) {
        return json(res, 500, { error: e && e.message || "local call failed", engine: "local" }, corsOrigin || allowedOrigin);
      } finally { callActive = false; }
    }
    return json(res, 404, { error: "not found" }, corsOrigin || allowedOrigin);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
module.exports = { startEngineHealthServer };
