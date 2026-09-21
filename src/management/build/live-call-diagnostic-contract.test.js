"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert");
const root=path.join(__dirname,"../..");
const api=fs.readFileSync(path.join(root,"app/api/campaign/route.ts"),"utf8");
const orch=fs.readFileSync(path.join(root,"lib/orchestration.ts"),"utf8");
const sip=fs.readFileSync(path.join(root,"lib/sip-conversation.ts"),"utf8");
const checks=[
["campaign redactor import",api.includes("redactDiagnostic")],
["campaign request id",api.includes("diagnosticId(request.headers.get")],
["campaign generic 500",api.includes('error:"Campaign failed unexpectedly."')],
["campaign safe diagnostic",api.includes("CAMPAIGN_FAILED")],
["campaign no raw error response",!api.includes("error: msg")],
["campaign no raw error log",!api.includes('console.error("[campaign] error", err)')],
["orchestration redactor",orch.includes("redactDiagnostic(e)")],
["orchestration no raw SIP exception",!orch.includes('fallback to RingOut:", e')],
["SIP redactor import",sip.includes("@/lib/safe-diagnostic")],
["SIP no e.message logs",!sip.match(/console\.error[^\n]*e\?\.message/)],
["SIP no raw phone log",!sip.includes("Starting conversation with")],
["SIP no transcript content log",!sip.includes('Whisper STT:", text')],
["SIP no prospect text log",!sip.includes('Prospect said:", txt')],
["SIP no transcript preview",!sip.includes("transcript?.slice")],
["SIP no spoken preview",!sip.includes('speak:", text.slice')],
["SIP no stream preview",!sip.includes('sentences from:", text.slice')],
["SIP no response preview",!sip.includes("responseText.slice")],
["SIP no timeout text",!sip.includes("TIMEOUT for:")],
["SIP no tiny audio text",!sip.includes("chunk.slice")],
["DNC remains",sip.includes("isSpokenOptOut(txt)")],
["strategy voice remains",sip.includes("voiceForTone(agentConfig.tone)")],
["no executable mutation",!sip.includes("eval(")],
["campaign auth unchanged",api.includes("Unauthorized")],
["campaign limit bounded",api.includes("Math.min(100")],
["diagnostic status",api.includes("500,requestId")]
];
for(const [n,v] of checks)assert.ok(v,n);
console.log("live call diagnostic contract: "+checks.length+"/"+checks.length+" checks PASS");