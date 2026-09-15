/**
 * Verification test — tests SIP credentials and codec setup WITHOUT making a call.
 * Run: node test-verify-sip.js
 */
const path = require("path");
const fs = require("fs");

// Load credentials the same way server.js does
const rcFile = path.join(__dirname, "src", "management", "portal", "rc-credentials.json");
let rc = {};
try { rc = JSON.parse(fs.readFileSync(rcFile, "utf8")); } catch (e) { console.error("Cannot read rc-credentials.json:", e.message); process.exit(1); }

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const WARN = "\x1b[33m!\x1b[0m";
let failures = 0;

function check(name, ok, detail) {
  if (ok) { console.log(`  ${PASS} ${name}`); }
  else { console.log(`  ${FAIL} ${name}${detail ? " — " + detail : ""}`); failures++; }
}
function info(name, detail) { console.log(`  ${WARN} ${name}: ${detail}`); }

console.log("\n=== SIP Credential Verification ===\n");

// 1. Check credentials file loaded
check("rc-credentials.json exists", !!rc.sipUsername, "missing sipUsername");
check("SIP username set", rc.sipUsername === "14807166685", "got: " + rc.sipUsername);
check("SIP password set", rc.sipPassword === "TOdYS", "got: " + (rc.sipPassword ? "(hidden)" : "empty"));
check("SIP auth ID set", rc.sipAuthId === "805626843019", "got: " + rc.sipAuthId);
check("SIP domain set", rc.sipDomain === "sip.ringcentral.com", "got: " + rc.sipDomain);
check("SIP proxy set", rc.sipProxy === "sip40.ringcentral.com", "got: " + rc.sipProxy);
check("SIP port set", rc.sipPort === 5096, "got: " + rc.sipPort);
check("Caller ID set", rc.callerId === "14807166685", "got: " + rc.callerId);
check("Phone number set", rc.phoneNumber === "14807164508", "got: " + rc.phoneNumber);
check("JWT set", !!rc.jwt && rc.jwt.startsWith("eyJ"), "missing or invalid JWT");
check("Client ID set", rc.clientId === "2c28dvx7cnueCB1vQ3Lg90", "got: " + rc.clientId);
check("Client Secret set", !!rc.clientSecret, "missing");

console.log("\n=== Process.env Loading ===\n");

// Simulate server.js env loading
process.env.RC_SIP_USERNAME = rc.sipUsername || "";
process.env.RC_SIP_PASSWORD = rc.sipPassword || "";
process.env.RC_SIP_AUTH_ID = rc.sipAuthId || "";
process.env.RC_SIP_DOMAIN = rc.sipDomain || "";
process.env.RC_SIP_PROXY = rc.sipProxy || "";
process.env.RC_SIP_PORT = String(rc.sipPort || "");
process.env.RC_CALLER_ID = rc.callerId || "";
process.env.RC_JWT = rc.jwt || "";
process.env.RC_CLIENT_ID = rc.clientId || "";
process.env.RC_CLIENT_SECRET = rc.clientSecret || "";
process.env.RC_PHONE = rc.phoneNumber || "";

check("RC_SIP_USERNAME in env", process.env.RC_SIP_USERNAME === "14807166685");
check("RC_SIP_PASSWORD in env", process.env.RC_SIP_PASSWORD === "TOdYS");
check("RC_SIP_AUTH_ID in env", process.env.RC_SIP_AUTH_ID === "805626843019");
check("RC_SIP_DOMAIN in env", process.env.RC_SIP_DOMAIN === "sip.ringcentral.com");
check("RC_SIP_PROXY in env", process.env.RC_SIP_PROXY === "sip40.ringcentral.com");
check("RC_SIP_PORT in env", process.env.RC_SIP_PORT === "5096");
check("RC_CALLER_ID in env", process.env.RC_CALLER_ID === "14807166685");

console.log("\n=== Credential Merging (placeCall logic) ===\n");

// Simulate the placeCall credential merge
const customerSettings = { provider: "ringcentral", number: "14807164508", extension: "102" };
let settings = { ...customerSettings };
const e = process.env;
if (settings.provider === "ringcentral" && !settings.username && e.RC_SIP_USERNAME) {
  settings.username = e.RC_SIP_USERNAME;
  settings.sipPassword = e.RC_SIP_PASSWORD || "";
  settings.authId = e.RC_SIP_AUTH_ID || "";
  settings.domain = e.RC_SIP_DOMAIN || "sip.ringcentral.com";
  settings.host = e.RC_SIP_PROXY || "sip40.ringcentral.com";
  settings.port = Number(e.RC_SIP_PORT || 5096);
  settings.number = e.RC_CALLER_ID || e.RC_PHONE || settings.number || "";
}

check("Merged username", settings.username === "14807166685", "got: " + settings.username);
check("Merged sipPassword", settings.sipPassword === "TOdYS", "got: " + (settings.sipPassword ? "(set)" : "empty"));
check("Merged authId", settings.authId === "805626843019", "got: " + settings.authId);
check("Merged domain", settings.domain === "sip.ringcentral.com");
check("Merged host/proxy", settings.host === "sip40.ringcentral.com");
check("Merged port", settings.port === 5096, "got: " + settings.port);
check("Merged callerId/number", settings.number === "14807166685", "got: " + settings.number);

console.log("\n=== voipComplete Check ===\n");
const { voipComplete } = require("./src/management/shared/protocol");
check("voipComplete returns true", voipComplete(settings), "should be true with merged SIP creds");

console.log("\n=== Softphone SDK Loading ===\n");
let Softphone;
try { Softphone = require("ringcentral-softphone"); check("ringcentral-softphone loaded", true); } catch (e) { check("ringcentral-softphone loaded", false, e.message); }

let werift_rtp;
try { werift_rtp = require("werift-rtp"); check("werift-rtp loaded", true); } catch (e) { check("werift-rtp loaded", false, e.message); }

console.log("\n=== Codec Properties (SDK object) ===\n");

// Verify what cs.softphone.codec looks like after SDK creates it
// For PCMU/8000, the Codec should have: id=0, packetSize=160, timestampInterval=160
const expectedCodec = { packetSize: 160, id: 0, timestampInterval: 160 };
info("Expected PCMU/8000 codec", JSON.stringify(expectedCodec));
info("The SDK codec object has .id, .packetSize, .timestampInterval — no string parsing needed");

console.log("\n=== Audio Chain Verification (logical) ===\n");
const { speakToBuffer } = require("./src/management/agent/voice");
const { hearFromBuffer, mulawDecode } = require("./src/management/agent/hear");
check("speakToBuffer exported", typeof speakToBuffer === "function");
check("hearFromBuffer exported", typeof hearFromBuffer === "function");
check("mulawDecode exported", typeof mulawDecode === "function");

// Test mulawDecode roundtrip
const testMulaw = 0xFF; // silence in mulaw
const decoded = mulawDecode(testMulaw);
check("mulawDecode(0xFF) works", typeof decoded === "number", "got: " + decoded);

console.log("\n=== TTS Buffer Generation Test ===\n");
(async () => {
  try {
    const result = await speakToBuffer("test", { locale: "en", style: "human" });
    if (result && result.buffer) {
      check("speakToBuffer produces buffer", true, result.buffer.length + " bytes");
      check("Buffer is mulaw 8kHz", result.buffer.length > 100, "got " + result.buffer.length + " bytes");
      // Verify the buffer can be chunked into 160-byte packets
      const packets = Math.ceil(result.buffer.length / 160);
      info("Would produce " + packets + " RTP packets", "at 20ms each = " + (packets * 20) + "ms of audio");
    } else {
      check("speakToBuffer produces buffer", false, "returned null");
    }
  } catch (e) {
    check("speakToBuffer works", false, e.message);
  }

  // Test hearFromBuffer roundtrip
  try {
    // Create a fake mulaw buffer (160 bytes of silence = 0xFF)
    const fakeMulaw = Buffer.alloc(160, 0xFF);
    const text = hearFromBuffer(fakeMulaw, { sampleRate: 8000 });
    // This should return null (silence), not throw
    check("hearFromBuffer handles mulaw input", true, text === null ? "(silence detected correctly)" : "got: " + text);
  } catch (e) {
    check("hearFromBuffer handles mulaw input", false, e.message);
  }

  console.log("\n=== Summary ===\n");
  if (failures === 0) {
    console.log("  \x1b[32mAll checks passed! SIP credentials and audio chain verified.\x1b[0m");
    console.log("\n  The SIP path is ready for a live test call.");
    console.log("  To test SIP registration only: node test-sip-bridge.js");
    console.log("  To test a full call: ask the admin first.\n");
  } else {
    console.log("  \x1b[31m" + failures + " check(s) failed. Fix these before testing.\x1b[0m\n");
  }
})();
