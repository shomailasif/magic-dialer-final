// Regression gate: a supervisor lock that names a live but UNRELATED pid must
// never make the watchdog resign. Windows recycles PIDs, so a stale lock can
// point at an arbitrary process; on that path the agent exits cleanly, with no
// crash and no log line, and no supervisor ever starts again — which is
// exactly how an unattended PC was left with no agent after an update.
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const agent = require("./agent");
const w = agent._watchdog;
assert.ok(w && w.takeWatchdogLock && w.pidIsOurSupervisor, "watchdog lock helpers must be exported for this gate");

const lockPath = w.WATCHDOG_LOCK;
const saved = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : null;

// A genuinely foreign process: alive, but not agent.exe. This is the state a
// recycled PID leaves behind in the lock file.
const foreign = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", windowsHide: true });
const foreignPid = foreign.pid;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("  ok - " + name);
  } catch (e) {
    failures += 1;
    console.log("  FAIL - " + name + ": " + (e && e.message));
  }
}

function writeLock(value) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, value);
}

try {
  check("a live foreign process is not a rival supervisor", () => {
    assert.ok(w.pidAlive(foreignPid), "control check: the foreign process must be alive");
    assert.strictEqual(w.pidIsOurSupervisor(foreignPid), false, "a non-agent.exe pid was mistaken for our supervisor");
  });

  check("a pid with no process behind it is not a rival supervisor", () => {
    assert.strictEqual(w.pidIsOurSupervisor(0x00ffffff), false);
  });

  check("a lock naming a live foreign pid is taken over, not refused", () => {
    writeLock(String(foreignPid));
    assert.strictEqual(w.takeWatchdogLock(), true, "supervisor resigned on a recycled pid");
    assert.strictEqual(String(fs.readFileSync(lockPath, "utf8")).trim(), String(process.pid));
  });

  check("our own pid in the lock is not treated as a rival", () => {
    writeLock(String(process.pid));
    assert.strictEqual(w.takeWatchdogLock(), true);
  });

  check("unparseable lock content is taken over", () => {
    writeLock("not-a-pid");
    assert.strictEqual(w.takeWatchdogLock(), true);
  });

  check("absent lock is acquired", () => {
    fs.rmSync(lockPath, { force: true });
    assert.strictEqual(w.takeWatchdogLock(), true);
    assert.strictEqual(String(fs.readFileSync(lockPath, "utf8")).trim(), String(process.pid));
  });
} finally {
  try {
    if (saved === null) fs.rmSync(lockPath, { force: true });
    else fs.writeFileSync(lockPath, saved);
  } catch {}
  try { foreign.kill(); } catch {}
}

if (failures) {
  console.log(`watchdog lock behavior: ${failures} FAILED`);
  process.exit(1);
}
console.log("watchdog lock behavior: PASS (stale/foreign lock always taken over)");
