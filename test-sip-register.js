/**
 * SIP Registration Test — verifies the SDK can connect to RingCentral's SBCs.
 * This does NOT make a call. It only registers and then unregisters.
 *
 * Run: node test-sip-register.js
 */
const path = require("path");

// Load SIP credentials
const rcFile = path.join(__dirname, "src", "management", "portal", "rc-credentials.json");
let rc;
try { rc = JSON.parse(require("fs").readFileSync(rcFile, "utf8")); } catch (e) { console.error("Cannot read rc-credentials.json:", e.message); process.exit(1); }

const { registerSession } = require("./src/management/portal/softphone");

(async () => {
  console.log("\n=== SIP Registration Test (no call) ===\n");
  console.log("  Connecting to " + rc.sipProxy + ":" + rc.sipPort + " ...");
  console.log("  Username: " + rc.sipUsername);
  console.log("  Domain:   " + rc.sipDomain);
  console.log("  Auth ID:  " + rc.sipAuthId);
  console.log("  Codec:    PCMU/8000\n");

  const start = Date.now();
  try {
    const result = await Promise.race([
      registerSession({
        user: rc.sipUsername,
        pass: rc.sipPassword,
        authId: rc.sipAuthId,
        domain: rc.sipDomain,
        proxy: rc.sipProxy,
        port: rc.sipPort,
      }),
      new Promise((res) => setTimeout(() => res({ ok: false, last: "timeout (15s)", steps: [] }), 15000)),
    ]);

    const elapsed = Date.now() - start;
    console.log("  Result: " + (result.ok ? "\x1b[32mSUCCESS\x1b[0m" : "\x1b[31mFAILED\x1b[0m"));
    console.log("  Time:   " + elapsed + "ms");
    console.log("  Steps:  " + (result.steps || []).join(" → "));
    console.log("  Last:   " + (result.last || ""));
    if (result.host) console.log("  Host:   " + result.host);

    if (result.ok) {
      console.log("\n  \x1b[32mSIP registration successful. The SDK can connect to RingCentral.\x1b[0m");
      console.log("  This confirms the SIP credentials and network path are working.\n");
    } else {
      console.log("\n  \x1b[31mSIP registration failed.\x1b[0m");
      console.log("  Check: network connectivity, firewall rules, SIP credentials.\n");
    }
  } catch (e) {
    console.error("  Error: " + e.message);
  }
})();
