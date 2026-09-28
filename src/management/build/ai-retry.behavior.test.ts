import assert from"node:assert/strict";
import fs from"node:fs";
import path from"node:path";
import{AI_GATEWAY_BUDGET_MS,AI_ATTEMPT_MAX_MS,boundedAttemptMs,boundedRetryDelay,retryAfterMs}from"../../lib/ai-retry";

const n=1_000_000;

/* These used to assert the literal 12000/5000, which is how the portal ended up
 * slower than its own caller: the engine abandons a live turn at 7s, the route was
 * given 12s, so every slow call was abandoned work and the client saw an HTML 502
 * instead of an error. Asserting the *relationship* is what stops that returning.
 */
const brain=fs.readFileSync(path.resolve(__dirname,"..","agent","intelligent-brain.js"),"utf8");
const enginePatience=/const REQUEST_TIMEOUT_MS = (\d+);/.exec(brain);
assert.ok(enginePatience,"the engine must declare its live-turn timeout");
const engineMs=Number(enginePatience[1]);
assert.ok(
  AI_GATEWAY_BUDGET_MS < engineMs,
  `the portal AI budget (${AI_GATEWAY_BUDGET_MS}ms) must finish inside the engine's patience (${engineMs}ms), otherwise every slow call is abandoned work`,
);
assert.ok(AI_ATTEMPT_MAX_MS <= AI_GATEWAY_BUDGET_MS,"a single attempt cannot exceed the whole budget");
// A 4s gateway abort produced 21s and 22s of dead air on the 16:09Z call.
assert.ok(engineMs <= 8000,`the engine's live-turn patience must stay tight, got ${engineMs}ms`);

assert.equal(retryAfterMs("2",n),2000);
assert.equal(retryAfterMs(null,n),180);
assert.equal(retryAfterMs(new Date(n+3000).toUTCString(),n),3000);
assert.equal(boundedAttemptMs(n+AI_GATEWAY_BUDGET_MS,n),AI_ATTEMPT_MAX_MS);
assert.equal(boundedAttemptMs(n+800,n),0);
assert.equal(boundedRetryDelay("2",n+12_000,n),2000);
assert.equal(boundedRetryDelay("10",n+12_000,n),10000);
assert.equal(boundedRetryDelay("12",n+12_000,n),null);
assert.equal(boundedRetryDelay(null,n+1000,n),null);
assert.equal(boundedRetryDelay("1",n+1500,n),null);
console.log(`AI deadline retry behavior: PASS (portal ${AI_GATEWAY_BUDGET_MS}ms inside engine ${engineMs}ms)`);
