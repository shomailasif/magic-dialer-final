const assert=require("node:assert/strict");const{requestId,safeError}=require("../agent/safe-diagnostic");
const secret="sk-THIS_IS_A_FAKE_SECRET_12345",token="device-token-FAKE-987654";
const out=safeError(new Error("provider failed Bearer "+secret+" token="+token),[secret,token]);
assert.ok(requestId().length>=8);assert.ok(!out.includes(secret));assert.ok(!out.includes(token));assert.ok(!out.includes("THIS_IS_A_FAKE_SECRET"));assert.ok(out.includes("[REDACTED]"));
console.log("safe diagnostic behavior: 5/5 checks PASS");
