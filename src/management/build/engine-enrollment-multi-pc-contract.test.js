"use strict";
/* Enrolling a second PC must not permanently kill the first one.
 *
 * The enroll route used to do this:
 *   engineDevice.updateMany({ where:{ userId, machineId:{ not: machineId } },
 *                             data:{ revokedAt: now, leaseUntil: null } })
 * and `revokedAt` was set nowhere else in the codebase - there is no admin
 * revoke and no "unlink this PC". Enrolling on this machine therefore revoked
 * the other machine's token permanently, and every heartbeat from it returned
 * 401 Unauthorized, so every call it placed failed with "Call failed:
 * Unauthorized". A machine that had been working fine was left running with no
 * portal config, which is also why it sounded wrong: no introduction, no
 * language handling, abrupt endings.
 *
 * The lease already does the job revocation was doing. The heartbeat allows a
 * device only when it holds activeEngineMachineId, or when the lease is unset
 * or expired, and it renews every beat; another machine gets
 * 409 "Account active on another PC" while the first is live, and takes over
 * automatically two minutes after the first stops. One active machine at a
 * time, no permanent lockout.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..", "..", "..");

const enroll = fs.readFileSync(path.join(root, "src", "app", "api", "engine", "enroll", "route.ts"), "utf8");
const heartbeat = fs.readFileSync(path.join(root, "src", "app", "api", "heartbeat", "route.ts"), "utf8");

// 1. Enrolling must not revoke any other device.
assert.doesNotMatch(
  enroll,
  /engineDevice\.updateMany\([^)]*revokedAt/,
  "enroll must not revoke other machines' device tokens"
);
assert.doesNotMatch(
  enroll,
  /machineId:\s*\{\s*not:\s*machineId\s*\}[\s\S]{0,160}revokedAt/,
  "enroll must not revoke devices belonging to other machineIds"
);

// 2. It must still claim the active-machine lease, so only one PC places calls.
assert.match(
  enroll,
  /activeEngineMachineId:\s*machineId/,
  "enroll must still claim the active-engine lease for this machine"
);

// 3. A revoked device is rejected, so the check is not simply being removed.
assert.match(heartbeat, /!d\s*\|\|\s*d\.revokedAt/);
assert.match(heartbeat, /error:"Unauthorized"/);
assert.match(heartbeat, /status:\s*401/);

// 4. The lease is what gates concurrent use, and it expires.
assert.match(heartbeat, /activeEngineMachineId:\s*d\.machineId/);
assert.match(heartbeat, /engineLeaseUntil:\s*\{\s*lte:\s*now\s*\}/);
assert.match(heartbeat, /engineLeaseUntil:\s*null/);
assert.match(heartbeat, /error:"Account active on another PC"/);
assert.match(heartbeat, /status:\s*409/);

console.log("engine enrollment does not lock out other machines: PASS");
