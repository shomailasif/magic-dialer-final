"use strict";
const assert = require("node:assert/strict");
const http = require("node:http");
const { startEngineHealthServer } = require("./engine-health");

function request(port, { path, method = "GET", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  let dialed = null;
  const server = await startEngineHealthServer({
    version: "test", getStatus: () => "ready", port: 18788,
    onCall: async (number) => { dialed = number; return { connected: true }; },
  });
  try {
    const r = await fetch("http://127.0.0.1:18788/health");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-private-network"), "true");
    assert.equal(r.headers.get("private-network-access-name"), "magic-dialer-engine");
    assert.match(r.headers.get("private-network-access-id") || "", /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i);
    const j = await r.json();
    assert.deepEqual(j, { ok: true, service: "magic-dialer-engine", version: "test", status: "ready", callControl: true });
    const call = await fetch("http://127.0.0.1:18788/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ number: "+16234001991" }) });
    assert.equal(call.status, 200);
    const cj = await call.json();
    assert.equal(cj.engine, "local");
    assert.equal(dialed, "+16234001991");
    const bad = await fetch("http://127.0.0.1:18788/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ number: "bad" }) });
    assert.equal(bad.status, 400);

    /* No portal is enrolled -> allowedOrigin is "*". That must not mean any
     * website can dial; only local callers without an Origin may. */
    dialed = null;
    let r2 = await request(18788, {
      path: "/call", method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "text/plain" },
      body: JSON.stringify({ number: "+15555550100" }),
    });
    assert.equal(r2.status, 403, "a foreign origin must not reach call control when no portal is enrolled");
    assert.equal(dialed, null, "and must not place a call");
    r2 = await request(18788, { path: "/health", headers: { Origin: "https://evil.example" } });
    assert.equal(r2.status, 200, "health is readable, it carries no customer data");

    // A name that resolves to 127.0.0.1 is not a trusted caller.
    r2 = await request(18788, { path: "/health", headers: { Host: "evil.example" } });
    assert.equal(r2.status, 403, "DNS rebinding must be refused");

    // The enrolled portal keeps call control; everyone else does not.
    let portalDialed = null;
    const portal = await startEngineHealthServer({
      version: "test", port: 18789, allowedOrigin: "https://portal.example",
      onCall: async (number) => { portalDialed = number; return { connected: true }; },
    });
    try {
      r2 = await request(18789, { path: "/call", method: "OPTIONS", headers: { Origin: "https://portal.example" } });
      assert.equal(r2.status, 204);
      assert.equal(r2.headers["access-control-allow-origin"], "https://portal.example");
      r2 = await request(18789, {
        path: "/call", method: "POST",
        headers: { Origin: "https://portal.example", "Content-Type": "application/json" },
        body: JSON.stringify({ number: "+15555550123" }),
      });
      assert.equal(r2.status, 200);
      assert.equal(portalDialed, "+15555550123");
      assert.equal(r2.headers["access-control-allow-origin"], "https://portal.example");
      r2 = await request(18789, {
        path: "/call", method: "POST",
        headers: { Origin: "https://evil.example", "Content-Type": "text/plain" },
        body: JSON.stringify({ number: "+15555550124" }),
      });
      assert.equal(r2.status, 403);
      assert.equal(portalDialed, "+15555550123", "the second number must never be dialled");
      r2 = await request(18789, { path: "/call", method: "OPTIONS", headers: { Origin: "https://evil.example" } });
      assert.equal(r2.status, 403);
    } finally {
      await new Promise((resolve) => portal.close(resolve));
    }

    // Enrollment happens while the engine runs; the next origin must work
    // without a restart.
    let currentOrigin = "*";
    let lateDialed = null;
    const late = await startEngineHealthServer({
      version: "test", port: 18790, allowedOrigin: () => currentOrigin,
      onCall: async (number) => { lateDialed = number; return { connected: true }; },
    });
    try {
      r2 = await request(18790, {
        path: "/call", method: "POST",
        headers: { Origin: "https://portal.example", "Content-Type": "text/plain" },
        body: JSON.stringify({ number: "+15555550125" }),
      });
      assert.equal(r2.status, 403, "not enrolled yet");
      currentOrigin = "https://portal.example";
      r2 = await request(18790, {
        path: "/call", method: "POST",
        headers: { Origin: "https://portal.example", "Content-Type": "application/json" },
        body: JSON.stringify({ number: "+15555550126" }),
      });
      assert.equal(r2.status, 200, "enrollment must take effect without a restart");
      assert.equal(lateDialed, "+15555550126");
    } finally {
      await new Promise((resolve) => late.close(resolve));
    }

    console.log("PASS: localhost health + origin-bound call control");
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exit(1); });
