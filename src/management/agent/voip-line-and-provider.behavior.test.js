"use strict";
/**
 * A new customer must be able to answer two questions before a real prospect
 * is dialled:
 *
 *   1. "Will you actually work with my line?"  -> a test button that registers
 *      with the saved SIP account, and places no call (a REGISTER is free; an
 *      INVITE is not, and would ring a stranger).
 *   2. "Which providers do you support?"      -> only RingCentral, because the
 *      engine registers through RingCentral's own Softphone SDK. The old
 *      dropdown offered nine providers and eight of them could never register,
 *      so a Twilio customer's first dial failed with no explanation.
 *
 * The other half is the save path. Re-saving the sales form used to rebuild
 * cfg.voip from the form alone. The form never pre-fills the SIP password (it
 * must not), so editing "what I sell" silently wiped the password and the
 * line stopped registering. Port, domain, authId and transport were dropped
 * the same way.
 *
 * Behaviour is run for real where it is cheap: preflightLocalSip is exercised
 * with a stubbed registerSession, so no network and no SIP socket is opened.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const agentDir = __dirname;
const webui = fs.readFileSync(path.join(agentDir, "webui.js"), "utf8");
const agent = fs.readFileSync(path.join(agentDir, "agent.js"), "utf8");
const { preflightLocalSip } = require("./local-call-controller");

/* ===================================================================
 * 1. THE TEST BUTTON: route + UI + wiring
 * =================================================================== */

/* The route exists, is POST-only, and calls the injected implementation. */
assert.match(webui, /if \(req\.method === "POST" && p === "\/api\/voip\/test"\)/,
  "the dashboard must expose POST /api/voip/test");
assert.match(webui, /const r = await opts\.testVoip\(\);/,
  "the route must call opts.testVoip, not a second SIP implementation");
assert.match(webui, /sendJson\(res, 200, \{ ok: true, host: \(r && r\.host\) \|\| null \}\);/,
  "a successful test must report the host it registered with");
assert.match(webui, /sendJson\(res, 502, \{ ok: false, error: \(e && e\.message\)/,
  "a failed test must return the real reason, not a bare failure");

/* The button exists, calls the route, and is explicitly type=button so it
 * cannot submit the setup form and navigate away mid-test. */
assert.match(webui, /<button type="button" id="voipTestBtn" class="btn ghost">Test saved line<\/button>/,
  "the VOIP section needs a Test saved line button");
assert.ok(webui.includes('fetch("/api/voip/test",{method:"POST"})'),
  "the button must call the test route");
assert.match(webui, /Line OK/,
  "the UI must say plainly when the line registered");

/* The agent injects the real implementation and it is the REGISTER-only
 * preflight, not runLocalCall. */
assert.match(agent, /const \{ runLocalCall, preflightLocalSip \} = require\("\.\/local-call-controller"\);/,
  "agent.js must import preflightLocalSip");
assert.match(agent, /testVoip: async \(\) => \{/,
  "agent.js must pass testVoip into the dashboard");
assert.match(agent, /const r = await preflightLocalSip\(\{ \.\.\.liveConfig, voip: \{ \.\.\.v, ready \} \}\);/,
  "testVoip must call the REGISTER preflight");
assert.ok(!/testVoip[\s\S]{0,600}runLocalCall/.test(agent),
  "the line test must never place a call");

/* A double-click must not open two registrations, which RingCentral treats as
 * a device conflict. */
assert.match(agent, /if \(voipTestInFlight\) return voipTestInFlight;/,
  "concurrent line tests must share one registration");

/* ===================================================================
 * 2. THE PROVIDER LIST MUST BE HONEST
 * =================================================================== */
const selectStart = webui.indexOf('<select id="fVoipProvider">');
const selectEnd = webui.indexOf("</select>", selectStart);
assert.ok(selectStart > -1 && selectEnd > selectStart, "the provider select must exist");
const select = webui.slice(selectStart, selectEnd);

const options = [...select.matchAll(/<option\b[^>]*>([^<]*)<\/option>/g)]
  .map((m) => ({ tag: m[0], label: m[1].trim() }));
assert.ok(options.length >= 8, "the historical provider list must still be visible");

const ringCentral = options.find((o) => o.label === "RingCentral");
assert.ok(ringCentral, "RingCentral must be offered");
assert.ok(!/\bdisabled\b/.test(ringCentral.tag), "RingCentral must be selectable");

const unsupported = options.filter((o) => /\(not supported\)$/.test(o.label));
assert.ok(unsupported.length >= 7,
  "every provider the engine cannot register must be labelled (not supported)");
for (const o of unsupported) {
  assert.match(o.tag, /\bdisabled\b/,
    `"${o.label}" must be disabled, not merely labelled - a label can be ignored, a disabled option cannot be chosen`);
}
assert.ok(webui.includes("RingCentral is the supported VOIP provider"),
  "the form must say which provider actually works");

/* The CLI path must stop advertising providers that do not work. */
assert.ok(!agent.includes("e.g. Twilio, Asterisk"),
  "the console setup prompt must not advertise unsupported providers");
assert.match(agent, /RingCentral is the supported provider/,
  "the console setup prompt must name the supported provider");

/* ===================================================================
 * 3. SAVING MUST NOT WIPE THE LINE
 * =================================================================== */
const setupStart = webui.indexOf('if (req.method === "POST" && p === "/api/setup")');
const setupEnd = webui.indexOf('if (req.method === "POST" && p === "/api/voip/test")', setupStart);
assert.ok(setupStart > -1 && setupEnd > setupStart, "the setup route must precede the test route");
const setup = webui.slice(setupStart, setupEnd);

assert.match(setup, /const prior = cfg\.voip && typeof cfg\.voip === "object" \? cfg\.voip : \{\};/,
  "the save path must read the existing voip object");
assert.match(setup, /\.\.\.prior,/,
  "the new voip object must be merged over the existing one, not replace it");
assert.match(setup, /const sipPassword = voipPass \|\| prior\.sipPassword \|\| "";/,
  "a blank password field must keep the saved password");
assert.match(setup, /server: voipServer \|\| prior\.server \|\| HOSTED\[voipProvider\] \|\| ""/,
  "a blank server must keep the saved server");
assert.match(setup, /domain: voipDomain \|\| prior\.domain \|\| ""/,
  "the SIP domain must be preserved or editable");
assert.match(setup, /port: Number\.isFinite\(portNum\) && portNum > 0 \? Math\.floor\(portNum\) : prior\.port/,
  "the SIP port must be preserved or editable");
assert.match(setup, /const HOSTED = \{ ringcentral: "sip40\.ringcentral\.com" \};/,
  "the saved default host must be the SBC the SDK registers against, not the domain");

/* The new fields exist in the form and are sent to the save route. */
for (const id of ["fVoipDomain", "fVoipPort"]) {
  assert.ok(webui.includes(`id="${id}"`), `${id} must exist in the VOIP form`);
  assert.ok(webui.includes(`${id.replace("fVoip", "voip")}:$id("${id}").value.trim()`),
    `${id} must be sent to /api/setup`);
}

/* ===================================================================
 * 4. THE PREFLIGHT ITSELF (run, not trusted)
 * =================================================================== */
(async () => {
  /* Incomplete credentials must not open a socket at all. */
  let called = 0;
  const stub = (result) => async () => { called++; return result; };

  await assert.rejects(
    () => preflightLocalSip({ voip: { username: "u", sipPassword: "p" } }, { registerSession: stub({ ok: true }) }),
    /^Error: VOIP configuration incomplete$/,
    "a line with no number must be reported as incomplete"
  );
  assert.equal(called, 0, "an incomplete line must never reach the network");

  await assert.rejects(
    () => preflightLocalSip({ voip: { number: "15551234567", username: "u" } }, { registerSession: stub({ ok: true }) }),
    /VOIP configuration incomplete/,
    "a line with no password must be reported as incomplete"
  );
  assert.equal(called, 0);

  /* A stored `ready:false` must not block a configured line: the flag is
   * written on save, and configs created before it existed are still valid. */
  let seen = null;
  const okResult = await preflightLocalSip({
    voip: {
      number: "14807166685",
      username: "101",
      sipPassword: "secret",
      authId: "101",
      domain: "sip.ringcentral.com",
      host: "sip40.ringcentral.com",
      port: 5096,
      ready: false,
    },
  }, { registerSession: async (opts) => { seen = opts; return { ok: true, host: "sip40.ringcentral.com" }; } });

  assert.deepEqual(okResult, { ok: true, host: "sip40.ringcentral.com" },
    "a successful registration must return the host");
  assert.deepEqual(seen, {
    user: "101",
    pass: "secret",
    authId: "101",
    domain: "sip.ringcentral.com",
    proxy: "sip40.ringcentral.com",
    port: 5096,
  }, "the preflight must pass the customer's own host/domain/port/authId through to the SDK");

  /* A rejected registration must surface the provider's reason, because
   * "wrong password" and "wrong port" are different fixes. */
  await assert.rejects(
    () => preflightLocalSip({
      voip: { number: "14807166685", username: "101", sipPassword: "wrong", ready: true },
    }, { registerSession: async () => ({ ok: false, last: "403 Forbidden" }) }),
    /RingCentral SIP registration failed: 403 Forbidden/,
    "the failure reason must reach the operator"
  );

  /* Defaults must still target RingCentral, so a form with only credentials
   * (the common case) registers without the customer knowing the host names. */
  let defaults = null;
  await preflightLocalSip({
    voip: { number: "14807166685", username: "101", sipPassword: "secret" },
  }, { registerSession: async (opts) => { defaults = opts; return { ok: true }; } });
  assert.equal(defaults.domain, "sip.ringcentral.com");
  assert.equal(defaults.proxy, "sip40.ringcentral.com");
  assert.equal(defaults.port, 5096);
  assert.equal(defaults.authId, "101", "authId must default to the SIP username");

  console.log("voip line + provider: PASS");
  console.log("  test button registers only (no INVITE, no telephony charge)");
  console.log("  1 supported provider, 7 explicitly disabled and labelled");
  console.log("  re-saving setup preserves password, host, domain, port");
  console.log("  preflight: incomplete / ok / rejected / defaults all verified");
})().catch((e) => { console.error(e); process.exit(1); });
