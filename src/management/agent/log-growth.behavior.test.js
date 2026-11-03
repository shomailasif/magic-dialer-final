"use strict";
/* A log that grows without bound is a disk leak on a customer PC.
 *
 * Measured on this machine: watchdog-child.log had reached 63 MB, almost all of
 * it the identical "Local mode" / "heartbeat unavailable" sentence written every
 * three seconds for weeks. The supervisor also opened the file in append mode
 * and never closed it, so nothing bounded it but a reinstall.
 *
 * Two guarantees are pinned here: the heartbeat loop writes a line only when the
 * line changes, and the supervisor keeps at most one previous child log. The
 * dashboard is still updated on every beat, so liveness is unaffected.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { _watchdog } = require("./agent");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-log-"));
try {
  const file = path.join(dir, "watchdog-child.log");

  // 1. First run: there is no file yet, and the handle is usable.
  let fd = _watchdog.openChildLog(file, 32);
  assert.notEqual(fd, null, "a missing log must be created, not skipped");
  fs.writeSync(fd, "first\n");
  fs.closeSync(fd);
  assert.equal(fs.readFileSync(file, "utf8"), "first\n");

  // 2. Below the cap: append in place, no rotation.
  fd = _watchdog.openChildLog(file, 32);
  fs.writeSync(fd, "second\n");
  fs.closeSync(fd);
  assert.equal(fs.readFileSync(file, "utf8"), "first\nsecond\n");
  assert.ok(!fs.existsSync(file + ".1"), "a small log must not be rotated");

  // 3. At the cap: the old file is kept once and the live file starts empty.
  fs.appendFileSync(file, "x".repeat(40));
  const grown = fs.statSync(file).size;
  fd = _watchdog.openChildLog(file, 32);
  fs.closeSync(fd);
  assert.equal(fs.statSync(file).size, 0, "an oversized log must start empty");
  assert.equal(fs.statSync(file + ".1").size, grown, "the previous file must be kept exactly once");

  // 4. Rotating again replaces the previous file; the folder never grows.
  fs.writeFileSync(file, "y".repeat(50));
  fd = _watchdog.openChildLog(file, 32);
  fs.closeSync(fd);
  assert.equal(fs.readFileSync(file + ".1", "utf8"), "y".repeat(50), "the newest previous file wins");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["watchdog-child.log", "watchdog-child.log.1"],
    "rotation must not leave a family of numbered logs");

  // 5. Only a changed message is written; a reset makes the next one news again.
  const seen = [];
  const once = _watchdog.logChanged((m) => seen.push(m));
  assert.equal(once("local tick | 1 lead"), true);
  assert.equal(once("local tick | 1 lead"), false, "the same beat must not be written twice");
  assert.equal(once("local tick | 0 leads"), true, "a changed line is news");
  once.reset();
  assert.equal(once("local tick | 0 leads"), true, "after a reset the next occurrence is reported");
  assert.deepEqual(seen, ["local tick | 1 lead", "local tick | 0 leads", "local tick | 0 leads"]);

  // 6. The heartbeat loop and the supervisor actually use them.
  const src = fs.readFileSync(path.join(__dirname, "agent.js"), "utf8");
  assert.ok(src.includes("const beatLog = logChanged(log);"), "the heartbeat loop must dedupe its log");
  assert.ok(!src.includes('log("local tick | " + line);'), "the local tick must not be logged every three seconds");
  assert.ok(src.includes("openChildLog(watchdogLog)"), "the supervisor must rotate before opening the child log");
  assert.ok(!/fs\.openSync\(watchdogLog, "a"\)/.test(src), "the child log must not be opened unbounded");
  assert.ok(_watchdog.MAX_CHILD_LOG_BYTES >= 1024 * 1024 && _watchdog.MAX_CHILD_LOG_BYTES <= 100 * 1024 * 1024,
    "the rotation cap must be a sane size, got " + _watchdog.MAX_CHILD_LOG_BYTES);

  console.log("log growth: PASS (one line per change, child log bounded at two files)");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
