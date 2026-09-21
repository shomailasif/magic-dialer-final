"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert");
const root=path.join(__dirname,"../..");
const tel=fs.readFileSync(path.join(root,"lib/telephony-session.ts"),"utf8");
const orch=fs.readFileSync(path.join(root,"lib/orchestration.ts"),"utf8");
const dial=fs.readFileSync(path.join(root,"lib/dialer.ts"),"utf8");
const checks=[
 ["provider-neutral session type",tel.includes("export type TelephonySession")],
 ["provider carried by session",tel.includes("provider:DialerProvider")],
 ["capability contract",tel.includes("TelephonyCapabilities")],
 ["live media capability",tel.includes("liveMedia:boolean")],
 ["barge-in capability",tel.includes("bargeIn:boolean")],
 ["STT capability",tel.includes("stt:boolean")],
 ["TTS capability",tel.includes("tts:boolean")],
 ["RingCentral certified",tel.includes('provider==="RINGCENTRAL"')],
 ["unsupported live adapter fails closed",tel.includes("has no certified live-media adapter")],
 ["RingCentral adapter uses proven SIP caller",tel.includes("makeSIPCall(sip,agent)")],
 ["campaign selects configured provider",orch.includes('selectedProvider = user.dialerConfig?.provider || "RINGCENTRAL"')],
 ["SIP only for certified provider",orch.includes("certifiedLiveProvider(selectedProvider)")],
 ["campaign creates telephony session",orch.includes("createTelephonySession(selectedProvider")],
 ["campaign uses session call",orch.includes("telephony.placeConversationalCall(liveAgentConfig)")],
 ["Twilio not falsely live-certified",!tel.includes('provider==="TWILIO"')],
 ["Vonage not falsely live-certified",!tel.includes('provider==="VONAGE"')],
 ["legacy API unsupported providers fail closed",dial.includes("is not enabled for live calling yet")],
 ["no simulated transcript fallback",orch.includes("refusing simulated AI result")],
 ["compliance remains before telephony",orch.indexOf("decideCallCompliance")<orch.indexOf("createTelephonySession(selectedProvider")],
 ["strategy remains passed to telephony",orch.includes("placeConversationalCall(liveAgentConfig)")],
 ["no credentials embedded in abstraction",!tel.includes("RC_SIP_PASSWORD")&&!tel.includes("clientSecret")],
 ["no executable mutation",!tel.includes("eval(")&&!tel.includes("writeFile")],
 ["single certified adapter today",(tel.match(/provider===\"RINGCENTRAL\"/g)||[]).length===1],
 ["session reports live capabilities",tel.includes("capabilities:{liveMedia:true,bargeIn:true,stt:true,tts:true}")],
 ["provider mismatch cannot silently use RC SIP",orch.includes("certifiedLiveProvider(selectedProvider)")]
];
for(const [n,ok] of checks)assert.ok(ok,n);
console.log("telephony abstraction contract: "+checks.length+"/"+checks.length+" checks PASS");
