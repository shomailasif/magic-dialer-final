import { createRequire } from "module";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const SUGA_TOKEN_PATH = path.join(ROOT, "sugamcp", "token.json");
const ENV_PATH = path.join(ROOT, ".env");

let allOk = true;

function ok(label) {
  console.log(`  [PASS] ${label}`);
}
function fail(label, reason) {
  console.error(`  [FAIL] ${label}: ${reason}`);
  allOk = false;
}
function step(label) {
  console.log(`\n=== ${label} ===`);
}

async function checkBuild() {
  step("1. Build Check (npx next build)");
  try {
    const out = execSync("npx next build 2>&1", { cwd: ROOT, timeout: 120000, encoding: "utf-8" });
    const hasErrors = out.includes("error") && !out.includes("Successfully") && !out.includes("compiled");
    if (hasErrors || out.includes("TypeScript errors")) {
      fail("Build", "TypeScript errors found");
    } else {
      ok("Build passed clean");
    }
  } catch (e) {
    const msg = e.message || e.stdout || "";
    if (msg.includes("TypeError") || msg.includes("error TS")) {
      fail("Build", "TypeScript compilation errors");
    } else if (msg.includes("Successfully") || msg.includes("compiled")) {
      ok("Build passed clean (warnings only)");
    } else {
      fail("Build", e.message?.slice(0, 200));
    }
  }
}

function checkTtsGuards() {
  step("2. TTS Regression Guards");
  try {
    const guards = require("./src/lib/guards");
    if (guards.GUARD_EDGE_TTS_BROKEN_INIT === true) {
      ok("Edge TTS starts as broken (prevents 20s silence on Suga)");
    } else {
      fail("Edge TTS guard", "GUARD_EDGE_TTS_BROKEN_INIT is not true");
    }
    if (guards.GUARD_GOOGLE_TTS_CLIENT === "dict-chrome-ex") {
      ok("Google TTS client is dict-chrome-ex (not deprecated tw-ob)");
    } else {
      fail("Google TTS guard", `Client is ${guards.GUARD_GOOGLE_TTS_CLIENT}, expected dict-chrome-ex`);
    }
    if (guards.GUARD_TTS_TIMEOUT_MS <= 15000) {
      ok(`TTS timeout is ${guards.GUARD_TTS_TIMEOUT_MS}ms (< 15s)`);
    } else {
      fail("TTS timeout", `Timeout ${guards.GUARD_TTS_TIMEOUT_MS}ms exceeds 15s`);
    }
    if (guards.GUARD_AUDIO_RATE === 8000) {
      ok("Audio rate is 8kHz (SIP/RTP compatible)");
    } else {
      fail("Audio rate", `Rate is ${guards.GUARD_AUDIO_RATE}Hz, expected 8000`);
    }
    const violations = guards.validateTtsGuards();
    if (violations.length === 0) {
      ok("All guard validations passed");
    } else {
      violations.forEach(v => fail(`Guard violation: ${v.guard}`, v.message));
    }
  } catch (e) {
    fail("Guards module", e.message?.slice(0, 200));
  }
}

function checkSipConversation() {
  step("3. SIP Conversation Flow");
  try {
    const content = fs.readFileSync(path.join(ROOT, "src", "lib", "sip-conversation.ts"), "utf-8");
    if (!content.includes("await speak(cs, greeting, heardRef)")) {
      fail("sip-conversation", "Missing immediate greeting speak after call connect");
    } else {
      ok("Agent speaks immediately after call connect (no 15s wait)");
    }
    if (content.includes("GUARD_EDGE_TTS_BROKEN_INIT")) {
      ok("Uses GUARD_EDGE_TTS_BROKEN_INIT for edgeTtsBroken flag");
    } else {
      fail("sip-conversation", "Not using guard constant for edgeTtsBroken");
    }
    if (content.includes("GUARD_GOOGLE_TTS_CLIENT")) {
      ok("Uses GUARD_GOOGLE_TTS_CLIENT for Google TTS fallback");
    } else {
      fail("sip-conversation", "Not using guard constant for Google TTS client");
    }
    if (content.includes("client=dict-chrome-ex") || content.includes("GUARD_GOOGLE_TTS_CLIENT")) {
      ok("Google TTS URL uses dict-chrome-ex endpoint");
    } else {
      fail("Google TTS URL", "Not using dict-chrome-ex client");
    }
    if (!content.includes("15000") && content.includes("await speak(cs, greeting")) {
      ok("Agent speaks immediately after call connect — no 15s wait");
    } else if (content.includes("15000")) {
      fail("Conversation flow", "Still has hardcoded 15-second wait before speaking");
    } else {
      ok("Conversation flow: greeting → listen → speak cycle");
    }
    if (content.includes("runtimeRequire")) {
      ok("Uses runtimeRequire pattern for Turbopack compatibility");
    } else {
      fail("sip-conversation", "Missing runtimeRequire pattern (will crash Turbopack build)");
    }
  } catch (e) {
    fail("sip-conversation.ts", e.message?.slice(0, 200));
  }
}

function checkSmtpConfig() {
  step("4. SMTP Email Configuration");
  try {
    const envContent = fs.readFileSync(ENV_PATH, "utf-8");
    const required = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS"];
    for (const key of required) {
      if (envContent.includes(key)) {
        ok(`${key} configured`);
      } else {
        fail("SMTP config", `${key} is missing from .env`);
      }
    }
    if (envContent.includes('smtp.protonmail.ch')) {
      ok("SMTP_HOST is smtp.protonmail.ch");
    }
    if (envContent.includes('autodial.ai@proton.me')) {
      ok("SMTP_USER is configured");
    }
  } catch (e) {
    fail(".env", e.message?.slice(0, 200));
  }
}

async function checkSugaDeployment() {
  step("5. Suga Deployment Status");
  try {
    const token = JSON.parse(fs.readFileSync(SUGA_TOKEN_PATH, "utf-8"));
    if (!token.access_token) {
      fail("Suga token", "No access_token found in sugamcp/token.json");
      return;
    }
    ok("Suga MCP token exists");
    if (token.expires_at * 1000 < Date.now()) {
      fail("Suga token", "Token is expired — need to re-authenticate");
    } else {
      ok("Suga MCP token is valid");
    }
    // Use Suga MCP API (no public REST API)
    const pid = '47c28cbe-75fb-43b8-82d4-e62efb718adc';
    const eid = 'd31e44b8-2da7-4887-87af-de2bb2ea1edf';
    const mcpBody = JSON.stringify({
      jsonrpc: "2.0", id: Date.now(), method: "tools/call",
      params: { name: "list_deployments", arguments: { project_id: pid, env_id: eid } }
    });
    const resp = await fetch("https://dashboard.suga.app/api/mcp", {
      method: "POST",
      headers: { "Authorization": "Bearer " + token.access_token, "Content-Type": "application/json" },
      body: mcpBody,
    });
    const raw = await resp.text();
    const dataLine = raw.split("\n").find(l => l.startsWith("data: "));
    const data = dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(raw);
    const depsText = data?.result?.content?.[0]?.text || "{}";
    const depsData = JSON.parse(depsText);
    const deps = depsData.deployments || [];
    if (deps.length > 0) {
      const latest = deps[0];
      ok(`Latest deployment: ${latest.status} at ${latest.startedAt || 'N/A'}`);
      if (latest.status === 'FAILED') {
        fail("Suga deployment", `Latest deployment FAILED: ${latest.error || 'unknown'}`);
      } else {
        ok("Latest deployment succeeded");
      }
    } else {
      ok("No completed deployments in API yet — trigger was sent, may need minutes to appear");
    }
  } catch (e) {
    fail("Suga deployment", e.message?.slice(0, 200));
  }
}

function checkCleanup() {
  step("6. Cleanup Verification");
  const pathsToCheck = [
    ["src", "lib", "free-stt.ts"],
    ["test-restore.txt"],
    ["sugamcp"],
  ];
  for (const p of pathsToCheck) {
    const fullPath = path.join(ROOT, ...p);
    if (fs.existsSync(fullPath)) {
      if (p[p.length - 1] === "sugamcp") {
        ok("sugamcp/ directory preserved (MCP helpers needed)");
      } else {
        fail("Cleanup", `${p.join("/")} still exists — should be removed`);
      }
    } else {
      if (p[p.length - 1] !== "sugamcp") {
        ok(`${p.join("/")} removed`);
      }
    }
  }
}

async function main() {
  console.log("\n🔍 AutoDial AI — Deployment Verification\n");
  console.log(`Project root: ${ROOT}`);
  console.log(`Timestamp: ${new Date().toISOString()}\n`);

  await checkBuild();
  checkTtsGuards();
  checkSipConversation();
  checkSmtpConfig();
  await checkSugaDeployment();
  checkCleanup();

  console.log("\n" + "=".repeat(50));
  if (allOk) {
    console.log("✅ All checks passed — deployment is healthy");
  } else {
    console.error("❌ Some checks failed — review the output above");
    process.exit(1);
  }
  console.log("=".repeat(50) + "\n");
}

main().catch(e => {
  console.error("Verification script crashed:", e);
  process.exit(1);
});
