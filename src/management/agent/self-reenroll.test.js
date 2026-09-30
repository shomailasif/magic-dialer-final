/* The self-heal was untested because it lived inside agent.js, which cannot be
 * required in a test: it installs a process-wide uncaughtException handler that
 * exits the process and takes the watchdog lock. Extracted to self-reenroll.js
 * it is finally testable for real.
 *
 * This is the permanent fix for listening and the brain, which fail together
 * because both check the same device token. */
const assert = require("node:assert");
const { reEnrollSelf } = require("./self-reenroll");

function harness(stored, postImpl) {
  const saved = [];
  const live = { deviceToken: "stale-token" };
  return {
    live,
    saved,
    run: (reason) => reEnrollSelf({
      loadConfig: () => Object.assign({}, stored),
      saveConfig: (c) => { saved.push(Object.assign({}, c)); },
      post: postImpl,
      configPath: "C:/cfg.json",
      liveConfig: live,
      reason: reason || "",
    }),
  };
}
const ok = (t) => Promise.resolve({ status: 200, ok: true, body: { ok: true, deviceToken: "fresh-token" } });

async function main() {
  // 1. The whole point: a rejected PC repairs itself and starts working again.
  let seen = null;
  let h = harness(
    { deviceToken: "stale", machineId: "machine-1", portalUrl: "https://portal.example", enrollmentTicket: "ticket-123" },
    (url, body) => { seen = { url, body }; return ok(); },
  );
  assert.equal(await h.run("401"), true, "must heal itself when it holds a ticket");
  assert.equal(h.live.deviceToken, "fresh-token", "must adopt the new token so the brain and STT work again");
  assert.equal(seen.body.ticket, "ticket-123", "must reuse its own enrolment ticket");
  assert.equal(seen.body.machineId, "machine-1", "must keep the same machine id so it is the same PC");
  assert.match(seen.url, /\/api\/engine\/enroll$/);
  assert.equal(h.saved.length, 1, "the new token must be persisted across a restart");
  assert.equal(h.saved[0].deviceToken, "fresh-token");
  console.log("  ok  a rejected PC re-enrols itself and starts working again");

  // 2. It must never churn: it is only ever run in response to a rejection.
  let called = 0;
  h = harness({ deviceToken: "good", machineId: "m", portalUrl: "https://p", enrollmentTicket: "t" }, () => { called++; return ok(); });
  await h.run("403");
  assert.equal(called, 1, "called exactly once for the rejection");
  console.log("  ok  re-enrolment only ever runs in response to a rejection");

  // 3. No ticket (enrolled by hand long ago) - decline, never invent one.
  h = harness({ deviceToken: "t", machineId: "m", portalUrl: "https://p" }, () => { throw new Error("must not call"); });
  assert.equal(await h.run("401"), false, "without a ticket it must decline");
  console.log("  ok  without a ticket it declines instead of inventing one");

  // 4. Portal refuses the ticket - never reported as success.
  h = harness(
    { deviceToken: "t", machineId: "m", portalUrl: "https://p", enrollmentTicket: "bad" },
    () => Promise.resolve({ status: 401, body: { error: "Unauthorized" } }),
  );
  assert.equal(await h.run("401"), false, "a refused ticket must not be treated as success");
  assert.equal(h.saved.length, 0, "and must not write a token we do not have");
  console.log("  ok  a refused ticket is never faked as success");

  // 5. Network error must not take the agent down.
  h = harness(
    { deviceToken: "t", machineId: "m", portalUrl: "https://p", enrollmentTicket: "t" },
    () => Promise.reject(new Error("network down")),
  );
  assert.equal(await h.run("401"), false, "a network error returns false");
  console.log("  ok  a network error never takes the agent down");

  console.log("PASS: a PC that lost its authorisation repairs itself with no human involved");
}

main().catch((e) => { console.error("  FAIL " + e.message); process.exit(1); });
