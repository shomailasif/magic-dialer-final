"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert");
const root=path.join(__dirname,"../..");
const schema=fs.readFileSync(path.join(root,"../prisma/schema.prisma"),"utf8");
const comp=fs.readFileSync(path.join(root,"lib/call-compliance.ts"),"utf8");
const orch=fs.readFileSync(path.join(root,"lib/orchestration.ts"),"utf8");
const sip=fs.readFileSync(path.join(root,"lib/sip-conversation.ts"),"utf8");
const learn=fs.readFileSync(path.join(root,"lib/controlled-learning.ts"),"utf8");
const checks=[
 ["persistent DNC flag",schema.includes("doNotCall     Boolean")],
 ["persistent DNC timestamp",schema.includes("doNotCallAt   DateTime?")],
 ["persistent DNC reason",schema.includes("doNotCallReason String?")],
 ["persistent consent state",schema.includes('consentStatus String     @default("UNKNOWN")')],
 ["tenant DNC index",schema.includes("@@index([userId, doNotCall])")],
 ["DNC blocks deterministically",comp.includes('if(input.doNotCall)return {allowed:false,code:"DNC"}')],
 ["denied consent blocks",comp.includes('==="DENIED"')],
 ["missing phone blocks",comp.includes('code:"NO_PHONE"')],
 ["campaign query excludes DNC",orch.includes("{ doNotCall: false }")],
 ["pre-dial decision exists",orch.includes("decideCallCompliance({doNotCall:lead.doNotCall||!!tenantSuppression")],
 ["suppression occurs before telephony",orch.indexOf("decideCallCompliance")<orch.indexOf("createTelephonySession(")],
 ["spoken opt-out detected",sip.includes("isSpokenOptOut(txt)")],
 ["spoken opt-out returned",sip.includes("doNotCall,")],
 ["spoken opt-out persisted",orch.includes('doNotCallReason: sipResult?.doNotCall ? "SPOKEN_OPT_OUT"')],
 ["spoken opt-out cancels followup",orch.includes("sipResult?.doNotCall ? null : scheduleFollowUp")],
 ["spoken opt-out denies consent",orch.includes('consentStatus: sipResult?.doNotCall ? "DENIED"')],
 ["learning cannot clear DNC",!learn.includes("doNotCall")],
 ["learning cannot change consent",!learn.includes("consentStatus")],
 ["compliance module no DB mutation",!comp.includes("prisma")&&!comp.includes("update(")],
 ["compliance module no AI",!comp.includes("LLM")&&!comp.includes("Groq")],
 ["no code mutation",!comp.includes("eval(")&&!comp.includes("writeFile")],
 ["opt-out phrase stop calling",comp.includes('"stop calling"')],
 ["opt-out phrase remove me",comp.includes('"remove me"')],
 ["DNC is tenant lead state",schema.includes("model Lead")&&schema.includes("userId       String")],
 ["suppressed lead cannot schedule retry",orch.includes("followUpDueAt: sipResult?.doNotCall ? null")]
];
for(const [n,ok] of checks)assert.ok(ok,n);
console.log("compliance gate contract: "+checks.length+"/"+checks.length+" checks PASS");
