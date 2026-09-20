"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const root=path.resolve(__dirname,"..","..","..");
const helper=fs.readFileSync(path.join(root,"src","lib","engine-device-auth.ts"),"utf8");
const chat=fs.readFileSync(path.join(root,"src","app","api","engine","ai","chat","route.ts"),"utf8");
const stt=fs.readFileSync(path.join(root,"src","app","api","engine","ai","stt","route.ts"),"utf8");
[
 /revokedAt/,/leaseUntil:\s*true/,/engineLeaseUntil:\s*true/,/activeEngineMachineId:\s*true/,
 /!device\.leaseUntil\s*\|\|\s*device\.leaseUntil\s*<=\s*now/,
 /!device\.user\.engineLeaseUntil\s*\|\|\s*device\.user\.engineLeaseUntil\s*<=\s*now/,
 /device\.user\.activeEngineMachineId\s*!==\s*device\.machineId/
].forEach((re)=>assert.match(helper,re));
assert.match(chat,/authorizeActiveEngineDevice\(b\.deviceToken\|\|engineBearerToken\(r\)\)/);
assert.match(stt,/authorizeActiveEngineDevice\(engineBearerToken\(r\)\)/);
assert.doesNotMatch(chat,/findUnique\(/); assert.doesNotMatch(stt,/findUnique\(/);
assert.match(chat,/status:401/); assert.match(stt,/status:401/);
console.log("central engine device lease auth contract: PASS");
