"use strict";
/* The dashboard runs a small HTTP server on 127.0.0.1. "Loopback only" stops
 * the network from reaching it, but it does not stop the user's own browser:
 * any page on the open internet can POST here as a "simple request"
 * (text/plain needs no preflight) or navigate a new window at a GET URL.
 *
 * That mattered because POST /api/queue/start dials the whole list and
 * GET /?call=+number dialled one. A page could spend the customer's money
 * without ever being able to read a response. These tests pin the refusal:
 * a foreign Origin cannot change state, a non-loopback Host is refused even
 * when Host and Origin agree (DNS rebinding), and the old GET call trigger is
 * gone. The dashboard and the enrolled portal still work.
 */
const assert = require("node:assert/strict");
const http = require("node:http");
const { startWebUi } = require("./webui");

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
  const cfg = { companyName: "Zaz Logistics", product: "Dispatch Services for trucks" };
  const seen = { dialed: [], queueStarts: 0, configWrites: 0, imports: 0, enrolls: [] };
  const ui = await startWebUi({
    port: 0,
    readConfig: () => cfg,
    writeConfig: (next) => { seen.configWrites += 1; Object.assign(cfg, next); },
    statusPath: null,
    onCall: async (number) => { seen.dialed.push(number); return { ok: true }; },
    startQueue: async () => { seen.queueStarts += 1; return { running: true }; },
    onEnroll: async (args) => { seen.enrolls.push(args); },
    leads: { stats: () => ({}), list: () => [], import: () => { seen.imports += 1; return { added: 1 }; } },
  });
  const base = `http://127.0.0.1:${ui.port}`;
  try {
    // 1. A foreign page cannot start the dialer, even as a simple request.
    let r = await request(ui.port, {
      path: "/api/queue/start", method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "text/plain" },
      body: JSON.stringify({ maxCalls: 500 }),
    });
    assert.equal(r.status, 403, "a foreign origin must not start the queue");
    assert.equal(seen.queueStarts, 0, "no call may be dialled because a website asked");
    console.log("  ok   a foreign origin cannot start the dialer");

    // 2. Nor can it rewrite setup, import numbers or clear the licence.
    r = await request(ui.port, {
      path: "/api/setup", method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "text/plain" },
      body: JSON.stringify({ companyName: "Evil", product: "Evil" }),
    });
    assert.equal(r.status, 403, "a foreign origin must not rewrite the setup form");
    r = await request(ui.port, {
      path: "/api/leads", method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "text/plain" },
      body: JSON.stringify({ numbers: "+15555550100" }),
    });
    assert.equal(r.status, 403, "a foreign origin must not import leads");
    assert.equal(seen.imports, 0);
    assert.equal(cfg.companyName, "Zaz Logistics", "the stored setup must be untouched");
    assert.equal(seen.configWrites, 0);
    console.log("  ok   setup, leads and the licence are not writable from another origin");

    // 3. The old one-click GET call trigger is gone.
    r = await request(ui.port, { path: "/?call=%2B15555550100" });
    assert.equal(r.status, 200, "the dashboard page still loads");
    assert.equal(seen.dialed.length, 0, "opening a URL must never place a call");
    console.log("  ok   a navigated URL does not dial");

    // 4. The dashboard itself (same origin) still has full control.
    r = await request(ui.port, {
      path: "/api/queue/start", method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ maxCalls: 1 }),
    });
    assert.equal(r.status, 200);
    assert.equal(seen.queueStarts, 1, "the dashboard must still be able to start");
    console.log("  ok   the dashboard can still start the queue");

    // 5. A non-browser caller (no Origin) is the local operator/tooling.
    r = await request(ui.port, {
      path: "/api/queue/start", method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxCalls: 1 }),
    });
    assert.equal(r.status, 200);
    assert.equal(seen.queueStarts, 2);
    console.log("  ok   local tooling without an Origin still works");

    // 6. A name that resolves to 127.0.0.1 must not become a trusted origin.
    r = await request(ui.port, {
      path: "/api/state",
      headers: { Host: "evil.example" },
    });
    assert.equal(r.status, 403, "DNS rebinding must be refused even though the socket is local");
    r = await request(ui.port, {
      path: "/api/queue/start", method: "POST",
      headers: { Host: "evil.example", Origin: "http://evil.example", "Content-Type": "text/plain" },
      body: JSON.stringify({ maxCalls: 1 }),
    });
    assert.equal(r.status, 403);
    assert.equal(seen.queueStarts, 2, "a rebound name must not dial");
    console.log("  ok   a rebound hostname is refused");

    // 7. The enrolled portal still drives call control through CORS.
    cfg.portalUrl = "https://portal.example";
    r = await request(ui.port, {
      path: "/api/call", method: "POST",
      headers: { Origin: "https://portal.example", "Content-Type": "application/json" },
      body: JSON.stringify({ number: "+15555550123" }),
    });
    assert.equal(r.status, 200, "the enrolled portal must still be able to place its test call");
    assert.deepEqual(seen.dialed, ["+15555550123"]);
    assert.equal(r.headers["access-control-allow-origin"], "https://portal.example");
    assert.equal(r.headers["access-control-allow-private-network"], "true", "a public portal needs the private-network grant");
    console.log("  ok   the enrolled portal keeps its call control");

    // 8. Navigating at the enrollment URL no longer joins a portal by itself.
    r = await request(ui.port, {
      path: "/?enroll=ticket-1&portal=https%3A%2F%2Fevil.example",
    });
    assert.equal(r.status, 200);
    assert.equal(seen.enrolls.length, 0, "opening the URL must not enroll the PC");
    assert.match(r.body, /Connect this PC\?/);
    assert.match(r.body, /evil\.example/);
    assert.equal(r.headers["x-frame-options"], "DENY", "the confirmation must not be clickjackable");
    const nonce = (r.body.match(/nonce=("([a-f0-9]+)")/) || [])[2];
    assert.ok(nonce, "the page must carry a one-time nonce");

    // 9. The click enrolls once; the same nonce cannot be replayed.
    r = await request(ui.port, {
      path: "/enroll/confirm", method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ nonce }),
    });
    assert.equal(r.status, 200);
    assert.equal(seen.enrolls.length, 1);
    assert.equal(seen.enrolls[0].portal, "https://evil.example");
    r = await request(ui.port, {
      path: "/enroll/confirm", method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ nonce }),
    });
    assert.equal(r.status, 409, "a used nonce must not enroll a second time");
    assert.equal(seen.enrolls.length, 1);
    r = await request(ui.port, {
      path: "/enroll/confirm", method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "text/plain" },
      body: JSON.stringify({ nonce: "not-a-real-nonce" }),
    });
    assert.equal(r.status, 403, "a cross-origin page cannot post a guessed nonce either");
    r = await request(ui.port, {
      path: "/enroll/confirm", method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: "not-a-real-nonce" }),
    });
    assert.equal(r.status, 409, "a guessed nonce must fail");
    assert.equal(seen.enrolls.length, 1);
    console.log("  ok   enrollment needs a click and a one-time nonce");

    console.log("local API origins: PASS");
  } finally {
    await ui.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
