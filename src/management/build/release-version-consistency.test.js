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
/* The workflow no longer carries a version literal at all. It reads VERSION
 * from agent.js and exports it as ENGINE_VERSION, which is what the smoke test
 * compares against the installed engine and what the immutable tag is built
 * from. A hardcoded literal here is exactly how 1.4.86 was built but tested and
 * published as 1.4.85, so the literal itself is now forbidden. */
assert.equal((workflow.match(/\$version = "(\d+\.\d+\.\d+)"/g) || []).length, 0, "the workflow must not hardcode a release version");
assert.equal((workflow.match(/^\s*ENGINE_VERSION:\s*"/gm) || []).length, 0, "the workflow env must not hardcode ENGINE_VERSION");
assert.ok(workflow.includes('const VERSION = "(\\d+\\.\\d+\\.\\d+)";'), "the workflow must read the version from agent.js");
assert.ok(workflow.includes("agent/agent.js"), "the version must come from agent/agent.js");
assert.ok(workflow.includes("GITHUB_ENV"), "the derived version must be exported to later steps");
assert.ok(workflow.includes("$version = $env:ENGINE_VERSION"), "the release tag must be derived from the read version");
assert.ok(workflow.includes('$tag = "engine-v$version"'), "the immutable tag must still be derived from the release version");
assert.equal((workflow.match(/gh release create \$tag/g) || []).length, 1, "immutable versioned release must be created exactly once");
assert.ok(workflow.includes("Immutable release $tag already exists and engine sources are unchanged; preserving release and skipping republish."), "unchanged engine must preserve existing immutable release");
assert.ok(workflow.includes("Engine sources changed after immutable $tag; bump engine version before publishing."), "changed engine must require a version bump");
assert.ok(workflow.includes(":(glob,exclude)src/management/**/*.test.js")&&workflow.includes(":(exclude)src/management/build/run-all-tests.ps1"), "immutable reuse must be limited to unchanged engine sources");
assert.equal((workflow.match(/\$tag = "engine-v\$version"/g) || []).length, 1, "versioned immutable tag must be derived from release version");
assert.equal((workflow.match(/--clobber/g) || []).length, 1, "only the legacy 1.3.9 migration bridge may use clobber");
assert.ok(workflow.includes("sourceCommit = $env:GITHUB_SHA"), "immutable manifest must bind source commit");
assert.ok(workflow.includes("tag = $tag"), "immutable manifest must bind release tag");

for (const [label, value] of Object.entries({installerVersion, launcherAssembly, launcherFile, launcherInfo})) {
  assert.equal(value, agentVersion, label + " must equal agent version " + agentVersion);
}

  /* The updater used to poll every 6 hours, which meant a customer could keep
   * dialling with a bad agent for half a day after a fix shipped. It now polls
   * every 30 minutes. The point of this guard is unchanged: exactly one interval
   * must be declared, and no temporary debug interval may survive. */
  assert.equal((agent.match(/setInterval\(run, 30 \* 60 \* 1000\)/g) || []).length, 1,
    "production updater interval must be exactly thirty minutes and declared once");
  assert.equal((agent.match(/setInterval\(run, 5 \* 60 \* 1000\)/g) || []).length, 0,
    "temporary five-minute updater interval must not remain in production");
  assert.equal((agent.match(/setInterval\(run, 6 \* 60 \* 60 \* 1000\)/g) || []).length, 0,
    "superseded six-hour updater interval must not remain in production");

  console.log("release version consistency: PASS " + agentVersion + " / updater 30m");
