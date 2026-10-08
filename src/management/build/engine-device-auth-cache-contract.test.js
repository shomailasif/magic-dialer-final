"use strict";
/* The device-auth cache must be fast without being able to hide a revocation.
 *
 * Every AI request the engine makes authorizes its device. That read was one
 * more blocking round trip to a remote Postgres on the way to a phone call, so
 * it is now held in memory for three seconds. The risk of holding an
 * authorization is that a revoked device keeps working, so these checks pin the
 * three things that prevent it: a denial is never cached, a cached record is
 * re-validated against a fresh `now` on every hit, and revoking a device or
 * releasing a lease clears the cache on the way out.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..", "..", "..");
const helper = fs.readFileSync(path.join(root, "src", "lib", "engine-device-auth.ts"), "utf8");
const heartbeat = fs.readFileSync(path.join(root, "src", "app", "api", "heartbeat", "route.ts"), "utf8");
const revoke = fs.readFileSync(path.join(root, "src", "app", "api", "admin", "portal", "revoke-device", "route.ts"), "utf8");
const release = fs.readFileSync(path.join(root, "src", "app", "api", "admin", "portal", "release-lease", "route.ts"), "utf8");
const stt = fs.readFileSync(path.join(root, "src", "app", "api", "engine", "ai", "stt", "route.ts"), "utf8");
const chat = fs.readFileSync(path.join(root, "src", "app", "api", "engine", "ai", "chat", "route.ts"), "utf8");

// 1. Short window: three seconds, and it cannot be stretched.
assert.match(helper, /const AUTH_CACHE_MS = 3_000;/);
assert.match(helper, /Date\.now\(\) - hit\.at >= AUTH_CACHE_MS/);

// 2. A denial is never stored, so a revoked device is re-read on every call.
assert.match(helper, /if \(allowed && device\) cacheDevice\(hash, device\)/);
assert.doesNotMatch(helper, /cacheDevice\(hash, (device|allowed), true\)/);

// 3. A hit is not trusted: the cached record goes back through the same
//    authorizeEngineDeviceRecord with a fresh now, so a lease that expires
//    inside the window still denies on the next request.
assert.match(helper, /return authorizeEngineDeviceRecord\(cached, now\)/);

// 4. The lease rules themselves are unchanged.
assert.match(helper, /!device\.leaseUntil \|\| device\.leaseUntil <= now/);
assert.match(helper, /!device\.user\?\.engineLeaseUntil \|\| device\.user\.engineLeaseUntil <= now/);
assert.match(helper, /device\.revokedAt/);
assert.match(helper, /device\.user\.activeEngineMachineId !== device\.machineId/);

// 5. Keyed by token hash, never the token, and it cannot grow without bound.
assert.match(helper, /const hash = tokenHash\(token\)/);
assert.match(helper, /authCache\.get\(hash\)/);
assert.match(helper, /authCache\.set\(hash, \{ at: Date\.now\(\), record \}\)/);
assert.match(helper, /const AUTH_CACHE_MAX = \d+;/);
assert.match(helper, /authCache\.size > AUTH_CACHE_MAX/);
assert.doesNotMatch(helper, /authCache\.(get|set)\(token[,)]/);

// 6. Revoke and release-lease clear it, through the path they already use.
assert.match(helper, /export function invalidateEngineDeviceAuthCache/);
assert.match(heartbeat, /invalidateEngineDeviceAuthCache/);
assert.match(revoke, /invalidateConfigCache\(\)/);
assert.match(release, /invalidateConfigCache\(\)/);

// 7. Auth is still enforced on every AI request - the cache is not a bypass.
assert.match(stt, /authorizeActiveEngineDevice\(engineBearerToken\(r\)\)/);
assert.match(chat, /authorizeActiveEngineDevice\(b\.deviceToken\|\|engineBearerToken\(r\)\)/);
assert.match(stt, /if\(!d\)return fail\("Unauthorized","device-auth","UNAUTHORIZED",401\)/);
assert.match(chat, /if\(!d\)return fail\("Unauthorized","device-auth","UNAUTHORIZED",401\)/);

// 8. Only the device read is cached. The gateway never holds a provider key.
assert.match(stt, /const key=process\.env\.GROQ_API_KEY/);

console.log("engine device auth cache contract: 8 groups PASS");