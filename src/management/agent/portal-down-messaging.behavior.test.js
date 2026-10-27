// Regression gate: the dashboard must stop describing an unreachable portal as
// a moment, while never alarming the operator over a real blip.
//
// Why this needs a gate at all: the product's site was suspended for days and
// every heartbeat came back 404, yet the dashboard read "Portal briefly
// unavailable - call is unaffected" the entire time - a line that is true for a
// hiccup and hides an outage completely. Nothing failed, nothing alerted, and
// the operator had no signal that their own site was gone. The two cases differ
// only in elapsed time, so the decision is a pure function and this test is what
// keeps it honest in both directions: a channel that cries wolf at a 3-second
// blip is as useless as one that stays silent for a week.
const assert = require("node:assert");
const { _portal, _watchdog } = require("./agent");

assert.ok(_portal && _portal.portalDownState && _portal.PORTAL_DOWN_HONEST_MS, "portal status helpers must be exported for this gate");
assert.ok(_watchdog && _watchdog.takeWatchdogLock, "module must still expose the watchdog hooks");

const { portalDownState: state, PORTAL_DOWN_HONEST_MS: THRESHOLD } = _portal;
const BLIP = 3000;
const MINUTE = 60000;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("  ok  " + name);
  } catch (e) {
    failures += 1;
    console.log("  FAIL " + name + ": " + (e && e.message));
  }
}

check("the threshold is a real duration, not zero or absurd", () => {
  assert.ok(THRESHOLD >= 60000, "threshold under a minute would alarm on every blip, got " + THRESHOLD);
  assert.ok(THRESHOLD <= 10 * MINUTE, "threshold over 10 minutes would hide a real outage, got " + THRESHOLD);
});

check("a blip on a synced portal still reads as a moment", () => {
  const s = state(BLIP, true, true);
  assert.strictEqual(s.line, "Portal briefly unavailable - call is unaffected.");
  assert.strictEqual(s.status, "ONLINE");
});

check("a blip before the portal was ever synced still reads as connecting", () => {
  const s = state(BLIP, false, true);
  assert.strictEqual(s.line, "Connecting to portal...");
  assert.strictEqual(s.status, "OFFLINE");
});

check("sustained downtime names the duration instead of saying briefly", () => {
  const s = state(THRESHOLD, true, true, 404);
  assert.ok(!/briefly/i.test(s.line), "still says 'briefly' after " + THRESHOLD + "ms: " + s.line);
  assert.ok(/min/.test(s.line), "does not name the duration: " + s.line);
  assert.ok(/site/i.test(s.line), "does not point at the operator's site: " + s.line);
  assert.ok(!/suspend/i.test(s.line), "must not guess that the site was suspended: " + s.line);
});

check("the honest line keeps reporting the part that stays true", () => {
  const s = state(10 * MINUTE, true, true, 503);
  assert.ok(/Calls continue from the local list/i.test(s.line), "dropped the reassurance that matters mid-call: " + s.line);
  assert.ok(!/briefly/i.test(s.line), "contradicts itself: " + s.line);
});

check("the HTTP status is named when the portal answered", () => {
  assert.match(state(10 * MINUTE, true, true, 404).line, /HTTP 404/, "a gone site must say what it answered");
  assert.match(state(10 * MINUTE, true, true, 503).line, /HTTP 503/);
});

check("an outage does not flip a synced portal OFFLINE mid-call", () => {
  // The phone line is fine while the site is down; flipping status here reads
  // to the operator as a broken product, which is the old bug in reverse.
  assert.strictEqual(state(THRESHOLD, true, true).status, "ONLINE");
  assert.strictEqual(state(2 * 60 * MINUTE, true, true).status, "ONLINE");
});

check("an outage still reports OFFLINE when the portal was never reachable", () => {
  assert.strictEqual(state(THRESHOLD, false, true).status, "OFFLINE");
  assert.strictEqual(state(THRESHOLD, false, false).status, "OFFLINE");
});

check("no answer at all reads as reconnecting while it is still short", () => {
  const s = state(BLIP, true, false);
  assert.strictEqual(s.line, "Reconnecting to portal...");
  assert.strictEqual(s.status, "OFFLINE");
});

check("no answer at all escalates once it is sustained", () => {
  const s = state(THRESHOLD, true, false);
  assert.strictEqual(s.line, "Portal site unreachable for 2 min (no answer). Calls continue from the local list.");
  assert.strictEqual(s.status, "OFFLINE");
});

check("the boundary is exact, so neither side can drift", () => {
  assert.ok(/briefly/i.test(state(THRESHOLD - 1, true, true, 404).line), "escalated one millisecond early");
  assert.ok(!/briefly/i.test(state(THRESHOLD, true, true, 404).line), "stayed gentle one millisecond too long");
});

check("duration is reported in whole minutes and never as zero", () => {
  const line = (ms) => state(ms, true, true, 503).line;
  assert.ok(/after 10 min\b/.test(line(10 * MINUTE)), "10 whole minutes did not render as 10: " + line(10 * MINUTE));
  assert.ok(/after 90 min\b/.test(line(90 * MINUTE)), "90 whole minutes did not render as 90: " + line(90 * MINUTE));
  // A fractional minute must round, not truncate - 90.5 is 91, not 90.
  assert.ok(/after 91 min\b/.test(line(90 * MINUTE + 30000)), "fractional minute was truncated: " + line(90 * MINUTE + 30000));
  assert.ok(!/ 0 min /.test(line(THRESHOLD)), "reported 0 minutes");
  assert.ok(!/NaN|\[object/.test(line(THRESHOLD)), "duration did not render: " + line(THRESHOLD));
});

check("status and line are always both populated", () => {
  for (const downMs of [0, BLIP, THRESHOLD - 1, THRESHOLD, 10 * MINUTE, 6 * 60 * MINUTE]) {
    for (const synced of [true, false]) {
      for (const reached of [true, false]) {
        const s = state(downMs, synced, reached);
        assert.ok(typeof s.status === "string" && s.status, "missing status");
        assert.ok(typeof s.line === "string" && s.line, "missing line");
        assert.ok(["ONLINE", "OFFLINE"].includes(s.status), "unexpected status " + s.status);
      }
    }
  }
});

if (failures) {
  console.log(`portal down messaging: ${failures} FAILED`);
  process.exit(1);
}
console.log("PASS: a portal outage is named after the threshold, and a blip is not");
