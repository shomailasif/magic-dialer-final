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
const manifestVersion = one(workflow, /\$version = "(\d+\.\d+\.\d+)"/g, "release version");
assert.equal((workflow.match(/gh release create \$tag/g) || []).length, 1, "immutable versioned release must be created exactly once");
assert.equal((workflow.match(/Immutable release \$tag already exists; refusing overwrite/g) || []).length, 1, "immutable release overwrite must be refused");
assert.equal((workflow.match(/\$tag = "engine-v\$version"/g) || []).length, 1, "versioned immutable tag must be derived from release version");
assert.equal((workflow.match(/--clobber/g) || []).length, 1, "only the legacy 1.3.9 migration bridge may use clobber");
assert.ok(workflow.includes("sourceCommit = $env:GITHUB_SHA"), "immutable manifest must bind source commit");
assert.ok(workflow.includes("tag = $tag"), "immutable manifest must bind release tag");

for (const [label, value] of Object.entries({installerVersion, launcherAssembly, launcherFile, launcherInfo, manifestVersion})) {
  assert.equal(value, agentVersion, label + " must equal agent version " + agentVersion);
}

assert.equal((agent.match(/setInterval\(run, 6 \* 60 \* 60 \* 1000\)/g) || []).length, 1,
  "production updater interval must be exactly six hours and declared once");
assert.equal((agent.match(/setInterval\(run, 5 \* 60 \* 1000\)/g) || []).length, 0,
  "temporary five-minute updater interval must not remain in production");

console.log("release version consistency: PASS " + agentVersion + " / updater 6h");
