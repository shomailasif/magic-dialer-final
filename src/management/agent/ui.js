const fs = require("node:fs");
const path = require("node:path");

/**
 * Live UI bridge for the Agent Cockpit window (cockpit.ps1).
 * Writes a small status.json the cockpit polls and animates from.
 */
function statusFile(configDir) {
  return path.join(configDir, "status.json");
}

function setUi(configDir, patch) {
  if (!configDir) return;
  try {
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(statusFile(configDir), "utf8")); } catch {}
    const next = Object.assign({}, cur, patch, { ts: Date.now() });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(statusFile(configDir), JSON.stringify(next));
  } catch { /* never crash the agent for UI */ }
}

module.exports = { setUi, statusFile };