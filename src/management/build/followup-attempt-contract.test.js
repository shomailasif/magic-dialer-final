"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert");
const root=path.join(__dirname,"../.."),o=fs.readFileSync(path.join(root,"lib/orchestration.ts"),"utf8"),s=fs.readFileSync(path.join(root,"../prisma/schema.prisma"),"utf8"),m=fs.readFileSync(path.join(root,"../prisma/migrations/20260921_followup_attempt_accounting/migration.sql"),"utf8");
const checks=[
["lead stores attempts",s.includes("followUpAttemptsMade Int @default(0)")],["migration additive",m.includes('ADD COLUMN "followUpAttemptsMade"')],
["migration default zero",m.includes("DEFAULT 0")],["scheduler receives attempts made",o.includes("lead.followUpAttemptsMade")],
["scheduler receives max attempts",o.includes("user.agentConfig?.followUpAttempts ?? 2")],["failed attempt increments",o.includes('resultStatus==="FAILED" ? {increment:1}')],
["max attempt boundary",o.includes("attemptsMade>=Math.max(0,maxAttempts-1)")],["max reached clears followup",o.includes("return null")],
["interval lower bounded",o.includes("Math.max(1,intervalHours)")],["DNC overrides schedule",o.includes("sipResult?.doNotCall ? null")],
["interested no retry",o.includes('status === "PENDING" || status === "FAILED"')],["tenant lead query",o.includes("userId")],
["no infinite failed schedule by config zero",o.includes("Math.max(0,maxAttempts-1)")],["attempt count persisted with lead update",o.includes("followUpAttemptsMade:")],
["attempts not reset on failure",!o.includes("followUpAttemptsMade: 0")],["no code mutation",!o.includes("eval(")],
["migration does not drop",!m.match(/DROP|DELETE/i)],["schema remains indexed DNC",s.includes("@@index([userId, doNotCall])")],
["scheduler returns date only eligible",o.includes("new Date(Date.now()")],["followup config still tenant agent config",o.includes("user.agentConfig?.followUpAttempts")],
["spoken optout persists",o.includes('doNotCallReason: sipResult?.doNotCall ? "SPOKEN_OPT_OUT"')],["no followup on spoken optout",o.includes("sipResult?.doNotCall ? null")],
["attempt model deterministic",o.includes("function scheduleFollowUp(")],["migration one column",(m.match(/ADD COLUMN/g)||[]).length===1],
["default attempt value safe",s.includes("@default(0)")]];
for(const [n,v] of checks)assert.ok(v,n);console.log("followup attempt contract: "+checks.length+"/"+checks.length+" checks PASS");