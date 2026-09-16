/**
 * TTS Regression Guard Tests
 * 
 * Run: npx tsx test-tts-guards.ts
 * 
 * These tests validate that critical TTS fixes haven't been reverted.
 * If any test fails, the TTS system will produce silence on calls.
 */

import {
  GUARD_EDGE_TTS_BROKEN_INIT,
  GUARD_GOOGLE_TTS_CLIENT,
  GUARD_TTS_TIMEOUT_MS,
  GUARD_AUDIO_RATE,
  validateTtsGuards,
} from "./src/lib/guards";

let passed = 0;
let failed = 0;

function test(name: string, condition: boolean, message: string) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name} - ${message}`);
    failed++;
  }
}

console.log("\n=== TTS Regression Guard Tests ===\n");

// Test 1: Edge TTS must start as broken
console.log("Guard 1: Edge TTS initialization");
test(
  "edgeTtsBroken starts as true",
  GUARD_EDGE_TTS_BROKEN_INIT === true,
  "Setting to false causes 20s timeouts on Suga container"
);

// Test 2: Google TTS client must be dict-chrome-ex
console.log("\nGuard 2: Google TTS endpoint");
test(
  "Google TTS client is dict-chrome-ex",
  GUARD_GOOGLE_TTS_CLIENT === "dict-chrome-ex",
  "Old client=tw-ob returns HTML CAPTCHAs instead of audio"
);

// Test 3: TTS timeout must be reasonable
console.log("\nGuard 4: TTS timeout");
test(
  "TTS timeout under 15 seconds",
  GUARD_TTS_TIMEOUT_MS <= 15000,
  "Timeout too high causes call hangs"
);
test(
  "TTS timeout at least 5 seconds",
  GUARD_TTS_TIMEOUT_MS >= 5000,
  "Timeout too low causes premature abort"
);

// Test 4: Audio rate must be 8kHz
console.log("\nGuard 5: Audio format");
test(
  "Audio rate is 8000 Hz",
  GUARD_AUDIO_RATE === 8000,
  "SIP/RTP requires 8kHz mu-law"
);

// Test 5: Run full validation
console.log("\nGuard Validation:");
const violations = validateTtsGuards();
test(
  "No guard violations",
  violations.length === 0,
  `Found ${violations.length} violations: ${violations.map(v => v.message).join("; ")}`
);

// Test 6: Verify sip-conversation.ts imports guards
console.log("\nGuard 6: Import verification");
try {
  const fs = require("fs");
  const content = fs.readFileSync("./src/lib/sip-conversation.ts", "utf-8");
  test(
    "sip-conversation.ts imports guards module",
    content.includes('from "@/lib/guards"'),
    "Missing guards import - regression protection disabled"
  );
  test(
    "sip-conversation.ts uses GUARD_EDGE_TTS_BROKEN_INIT",
    content.includes("GUARD_EDGE_TTS_BROKEN_INIT"),
    "Not using guard constant for edgeTtsBroken init"
  );
  test(
    "sip-conversation.ts uses GUARD_GOOGLE_TTS_CLIENT",
    content.includes("GUARD_GOOGLE_TTS_CLIENT"),
    "Not using guard constant for Google TTS client"
  );
  test(
    "Google TTS URL uses dict-chrome-ex",
    content.includes("client=dict-chrome-ex") || content.includes("client=${GUARD_GOOGLE_TTS_CLIENT}"),
    "Google TTS still using deprecated client=tw-ob"
  );
  test(
    "runtimeRequire pattern preserved",
    content.includes("runtimeRequire"),
    "createRequire pattern removed - will crash Turbopack build"
  );
} catch (e: any) {
  console.error(`  ERROR reading sip-conversation.ts: ${e.message}`);
  failed++;
}

// Summary
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
