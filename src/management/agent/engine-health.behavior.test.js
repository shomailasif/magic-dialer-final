"use strict";
const assert = require("node:assert/strict");
const { startEngineHealthServer } = require("./engine-health");

(async () => {
  let dialed = null;
  const server = await startEngineHealthServer({
    version: "test", getStatus: () => "ready", port: 18788,
    onCall: async (number) => { dialed = number; return { connected: true }; },
  });
  try {
    const r = await fetch("http://127.0.0.1:18788/health");
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j, { ok: true, service: "magic-dialer-engine", version: "test", status: "ready", callControl: true });
    const call = await fetch("http://127.0.0.1:18788/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ number: "+16234001991" }) });
    assert.equal(call.status, 200);
    const cj = await call.json();
    assert.equal(cj.engine, "local");
    assert.equal(dialed, "+16234001991");
    const bad = await fetch("http://127.0.0.1:18788/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ number: "bad" }) });
    assert.equal(bad.status, 400);
    console.log("PASS: localhost health + mandatory local call-control contract");
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exit(1); });
