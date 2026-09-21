"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert");
const root=path.join(__dirname,"..");
const read=p=>fs.readFileSync(path.join(root,p),"utf8");
const call=read("agent/call.js"), runner=read("agent/call-runner.js"), stt=read("agent/multilingual-stt.js"), brain=read("agent/intelligent-brain.js"), agent=read("agent/agent.js");
const chat=read("../app/api/engine/ai/chat/route.ts"), sttRoute=read("../app/api/engine/ai/stt/route.ts");
const checks=[
 ["call creates correlation id",/const callId = sessionId \|\| requestId\(\)/.test(call)],
 ["call passes correlation to runner",/deviceToken: token, callId/.test(call)],
 ["call passes correlation to STT",/portal, deviceToken: token, callId/.test(call)],
 ["runner preserves callId",/callId = null/.test(runner)&&/deviceToken, callId/.test(runner)],
 ["chat client sends call id",/"x-call-id":callId/.test(brain)],
 ["stt client sends request id",/"x-request-id":reqId/.test(stt)],
 ["stt client sends call id",/"x-call-id":cid/.test(stt)],
 ["chat server reads call id",/r\.headers\.get\("x-call-id"\)/.test(chat)],
 ["stt server reads call id",/r\.headers\.get\("x-call-id"\)/.test(sttRoute)],
 ["server diagnostics bind call id",/safeDiagnostic\(stage,code,status,requestId,callId\)/.test(chat)&&/safeDiagnostic\(stage,code,status,requestId,callId\)/.test(sttRoute)],
 ["agent imports safe logger",/safeLog/.test(agent)],
 ["heartbeat error redacted",/heartbeat failed \(\$\{safeLog\(err,\[enrolledToken\]\)\}/.test(agent)],
 ["voice error redacted",/Voice call failed: " \+ safeLog\(e,\[enrolledToken\]\)/.test(agent)],
 ["call error redacted",/safeError\(e,\[token\]\)/.test(call)],
 ["no raw call failure summary",!/summary: "Call failed: " \+ e\.message/.test(call)]
];
for(const [n,ok] of checks){assert.ok(ok,n)}
console.log("call diagnostic correlation contract: "+checks.length+"/"+checks.length+" checks PASS");
