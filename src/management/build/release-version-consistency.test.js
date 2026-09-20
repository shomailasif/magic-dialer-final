const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const repoRoot = path.resolve(root, "..", "..");
const read = (p) => fs.readFileSync(p, "utf8");

function one(text, regex, label) {
  const matches = [...text.matchAll(regex)];
  assert.equal(matches.length, 1, label + " must have exactly one version declaration");
  return matches[0][1];
}

const agent = read(path.join(root, "agent", "agent.js"));
const installer = read(path.join(root, "build", "installer.iss"));
const launcher = read(path.join(root, "build", "launcher.cs"));
const workflow = read(path.join(repoRoot, ".github", "workflows", "build-windows-engine.yml"));

const agentVersion = one(agent, /const VERSION = "(\d+\.\d+\.\d+)";/g, "agent");
const installerVersion = one(installer, /^AppVersion=(\d+\.\d+\.\d+)$/gm, "installer");
const launcherAssembly = one(launcher, /AssemblyVersion\("(\d+\.\d+\.\d+)\.0"\)/g, "launcher assembly");
const launcherFile = one(launcher, /AssemblyFileVersion\("(\d+\.\d+\.\d+)\.0"\)/g, "launcher file");
const launcherInfo = one(launcher, /AssemblyInformationalVersion\("(\d+\.\d+\.\d+)"\)/g, "launcher informational");
const manifestVersion = one(workflow, /\$manifest = @\{ version = "(\d+\.\d+\.\d+)";/g, "release manifest");

for (const [label, value] of Object.entries({installerVersion, launcherAssembly, launcherFile, launcherInfo, manifestVersion})) {
  assert.equal(value, agentVersion, label + " must equal agent version " + agentVersion);
}

assert.equal((agent.match(/setInterval\(run, 6 \* 60 \* 60 \* 1000\)/g) || []).length, 1,
  "production updater interval must be exactly six hours and declared once");
assert.equal((agent.match(/setInterval\(run, 5 \* 60 \* 1000\)/g) || []).length, 0,
  "temporary five-minute updater interval must not remain in production");

console.log("release version consistency: PASS " + agentVersion + " / updater 6h");
