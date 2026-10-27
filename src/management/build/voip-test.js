const dns = require("dns");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { registerSession } = require("../portal/softphone");

//
// Provider-aware VOIP line probe. Reads the installed agent config
// (%USERPROFILE%\.magicdialer\config.json -> voip) and proves the line:
//   DNS        -> provider host resolves
//   REST       -> the provider gateway is reachable over 443 (some vendors)
//   REGISTER   -> SIP REGISTER + digest auth completes (200 OK)
// Place no calls. Override with V_USER / V_PASS env when the config'd line
// should not be used (the harness never writes anything).
//
// THE REGISTER USES THE PRODUCTION CLIENT.
//
// This file used to hand-build REGISTER requests and its own MD5 digest. That
// probe answered 403 for a line that the real softphone registers in 200 OK
// through sip40.ringcentral.com:5096 - a false failure that sent a whole
// diagnostic down the wrong path ("the line is rejected") when the credentials
// and the line were fine. A probe is only worth running if it exercises the
// code the product actually uses, so it now calls the same registerSession()
// that places real calls.
//

const HOSTED_SERVERS = {
  ringcentral: "sip.ringcentral.com",
  twilio: "sip-1042-sip.twilio.com",
  vonage: "sip.nexmo.com",
  plivo: "sip.plivo.com",
  thinq: "sip.thinq.com",
  flowroute: "sip.flowroute.com",
  myexotel: "voip.myexotel.com",
};
const REST_HOSTS = { ringcentral: "platform.ringcentral.com" };

function configVoip() {
  try {
    const cfg = require("./installed-config.cjs").readInstalledConfig();
    return cfg.voip || {};
  } catch {}
  return {};
}

const v = configVoip();
const USER = process.env.V_USER || v.username || "";
const PASS = process.env.V_PASS || v.sipPassword || "";
const PROVIDER = process.env.V_PROVIDER || v.provider || "custom";
const NUMBER = v.number || "";
const TRANSPORT = v.transport || "tls";
const server = v.server || HOSTED_SERVERS[PROVIDER] || "";
const HOST = process.env.V_HOST || v.host || server;
const PORT = Number(v.port || 0) || (TRANSPORT === "udp" ? 5060 : 5061);

let failures = 0;
function ok(label, extra) { console.log("PASS  " + label + (extra ? "  (" + extra + ")" : "")); }
function fail(label, extra) { failures++; console.log("FAIL  " + label + (extra ? "  (" + extra + ")" : "")); }

function restReach(host) {
  return new Promise((resolve) => {
    const req = https.request({ host: host, path: "/", method: "GET", timeout: 10000, rejectUnauthorized: false }, (res) => {
      res.resume(); resolve("http " + res.statusCode);
    });
    req.on("error", (e) => resolve("err:" + e.code));
    req.on("timeout", () => { req.destroy(); resolve("timeout"); });
    req.end();
  });
}

(async () => {
  console.log("VOIP line probe  ::  provider=" + PROVIDER + "  username=" + USER + "  pass len=" + (PASS ? PASS.length : 0));
  console.log("   configured  :  server=" + (HOST || "(none)") + " port=" + PORT + " transport=" + TRANSPORT);
  console.log("   caller id   :  " + (NUMBER || "(none)") + "");
  console.log("(REGISTER only - no calls are placed during this test)\n");

  if (!PASS) { fail("password present (config voip.sipPassword or V_PASS)"); }
  if (!USER) { fail("username present (config voip.username or V_USER)"); }
  if (!HOST) { fail("SIP server known (config voip.server or hosted default for " + PROVIDER + ")"); }
  if (!USER || !PASS || !HOST) { console.log("\nResult: " + failures + " check(s) failed - no line to probe"); process.exit(failures === 0 ? 0 : 1); }

  await new Promise((res) => dns.resolve4(HOST, (e, a) => {
    e ? fail("DNS resolution for " + HOST, "NONE") : ok("DNS resolution for " + HOST, a.join(","));
    res();
  }));

  const restHost = REST_HOSTS[PROVIDER];
  if (restHost) {
    const rest = await restReach(restHost);
    rest.indexOf("http") === 0 ? ok("REST gateway reachable (" + restHost + ")", rest) : fail("REST gateway reachable (" + restHost + ")", rest);
  }

  const numDigits = (NUMBER || USER).replace(/\D/g, "");
  if (numDigits.length >= 7) ok("phone number format accepted", NUMBER || USER);
  else if (numDigits.length === 0) fail("phone number format check", "no digits found");
  else fail("phone number format check", NUMBER + " -> " + numDigits.length + " digits");

  if (TRANSPORT === "udp") {
    console.log("  (the production softphone registers over TLS; a udp-only line is not exercised here)");
  }

  /* The production path, exactly as a real call uses it. */
  const reg = await registerSession({
    user: USER,
    pass: PASS,
    authId: v.authId || USER,
    domain: v.domain || "sip.ringcentral.com",
    proxy: HOST,
    port: PORT,
  });
  if (reg && reg.ok) {
    ok("SIP REGISTER authenticated as " + USER, (reg.last || "200 OK") + " via " + (reg.host || HOST));
  } else {
    fail("SIP REGISTER rejected or unreachable", (reg && reg.last) || "unknown error");
  }

  console.log("\nResult: " + (failures === 0 ? "ALL CHECKS PASSED - line is ready" : failures + " check(s) failed"));
  process.exit(failures === 0 ? 0 : 1);
})();
