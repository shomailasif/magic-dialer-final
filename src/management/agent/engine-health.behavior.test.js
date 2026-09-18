"use strict";
const assert = require("node:assert/strict");
const { startEngineHealthServer } = require("./engine-health");

(async () => {
  const server = await startEngineHealthServer({ version: "test", getStatus: () => "ready", port: 18788 });
  try {
    const r = await fetch("http://127.0.0.1:18788/health");
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j, { ok: true, service: "magic-dialer-engine", version: "test", status: "ready" });
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    const missing = await fetch("http://127.0.0.1:18788/nope");
    assert.equal(missing.status, 404);
    console.log("PASS: fixed localhost engine health contract");
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exit(1); });
