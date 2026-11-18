"use strict";
/* A qualified lead must reach the operator's inbox. The engine can only do that
 * through an SMTP account the operator owns, so the setup form and the dashboard
 * must be able to save one - and re-saving the sales form must not wipe it.
 *
 * This pins the wiring that was missing: before it, setup asked only for the
 * destination address, so every lead fell back to the outbox file and nothing
 * was ever emailed.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { startWebUi } = require("./webui");

const here = __dirname;
const webui = fs.readFileSync(path.join(here, "webui.js"), "utf8");
const agent = fs.readFileSync(path.join(here, "agent.js"), "utf8");
const secrets = fs.readFileSync(path.join(here, "config-secrets.js"), "utf8");

function request(port, { path: p, method = "GET", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
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
  for (const id of ["fSmtpHost", "fSmtpPort", "fSmtpUser", "fSmtpPass", "fSmtpFrom"]) {
    assert.ok(webui.includes(`id="${id}"`), `${id} must exist in the setup form`);
  }
  assert.match(webui, /smtpHost:\$id\("fSmtpHost"\)\.value\.trim\(\)/, "the setup form must send the SMTP server");
  assert.match(webui, /smtpUser:\$id\("fSmtpUser"\)\.value\.trim\(\)/, "the setup form must send the SMTP username");
  assert.match(webui, /smtpPass:\$id\("fSmtpPass"\)\.value/, "the setup form must send the SMTP password");
  assert.match(webui, /smtpPass \|\| prior\.pass \|\| ""/, "a blank password must keep the saved one");
  assert.match(webui, /id="smtpSave"/, "the dashboard must let the operator save email settings later");
  assert.match(webui, /id="smtpTest"/, "the dashboard must offer a real test email");
  assert.match(webui, /POST" && p === "\/api\/email\/test"/, "the test email must have its own route");
  assert.match(webui, /const \{ sendEmail \} = require\("\.\/email"\)/, "the dashboard must use the real SMTP sender");
  assert.match(agent, /contactEmail = await ask\("Where should qualified leads be emailed\?"\)/, "console setup must still ask for the address");
  assert.match(secrets, /\["smtp", "pass"\]/, "the SMTP password must stay sealed at rest");

  const cfg = {
    companyName: "Zaz Logistics",
    product: "Dispatch Services for trucks",
    contactEmail: "owner@example.com",
  };
  const ui = await startWebUi({
    port: 0,
    readConfig: () => cfg,
    writeConfig: (next) => { Object.assign(cfg, next); },
    statusPath: null,
  });
  const base = `http://127.0.0.1:${ui.port}`;
  try {
    let r = await request(ui.port, {
      path: "/api/email", method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ host: "smtp.gmail.com", port: "587", user: "owner@example.com", pass: "app-password", from: "" }),
    });
    assert.equal(r.status, 200, r.body);
    assert.equal(cfg.smtp.host, "smtp.gmail.com");
    assert.equal(cfg.smtp.port, 587);
    assert.equal(cfg.smtp.pass, "app-password");

    r = await request(ui.port, { path: "/api/email" });
    assert.equal(r.status, 200);
    const status = JSON.parse(r.body);
    assert.equal(status.configured, true, "a saved server must report configured");
    assert.equal(status.user, "owner@example.com");
    assert.ok(!r.body.includes("app-password"), "the page must never receive the SMTP password");

    /* Re-saving the sales form with a blank password must keep delivery alive. */
    r = await request(ui.port, {
      path: "/api/setup", method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({
        companyName: "Zaz Logistics", product: "Dispatch Services for trucks",
        contactEmail: "owner@example.com",
        smtpHost: "smtp.gmail.com", smtpPort: "587", smtpUser: "owner@example.com", smtpPass: "",
      }),
    });
    assert.equal(r.status, 200, r.body);
    assert.equal(cfg.smtp.pass, "app-password", "a blank SMTP password must not erase the saved one");
    assert.equal(cfg.smtp.host, "smtp.gmail.com");

    /* A server without a username is a configuration that can never send. */
    r = await request(ui.port, {
      path: "/api/email", method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ host: "smtp.gmail.com", user: "", pass: "x" }),
    });
    assert.equal(r.status, 400, "an incomplete SMTP configuration must be refused");

    console.log("lead email setup: PASS");
    console.log("  setup asks for the SMTP account, not just the destination");
    console.log("  re-saving setup keeps a saved app password");
    console.log("  the page never receives the password back");
  } finally {
    ui.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
