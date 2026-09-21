"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert");
const root=path.join(__dirname,"../.."),o=fs.readFileSync(path.join(root,"lib/orchestration.ts"),"utf8"),n=fs.readFileSync(path.join(root,"lib/notifications.ts"),"utf8"),r=fs.readFileSync(path.join(root,"app/api/campaign/route.ts"),"utf8");
const checks=[
["internal run limit bounded",o.includes("Math.min(100,Math.max(1")],["empty due leads no campaign",o.includes("if(dueLeads.length===0)return")],
["no empty campaign id fabricated",o.includes("campaignId:null")],["notification failure isolated",o.includes("outcome notification failed")],
["notification error redacted",o.includes("redactDiagnostic(e)")],["notification DB error redacted",n.includes("const msg = redactDiagnostic(err)")],
["notification imports redactor",n.includes("@/lib/safe-diagnostic")],["campaign route single diagnostic import",(r.match(/diagnosticId, safeDiagnostic, redactDiagnostic/g)||[]).length===1],
["campaign route bounded limit",r.includes("Math.min(100")],["campaign subscription gate",o.includes('status !== "ACTIVE"')],
["dialer validation gate",o.includes("validateProvider")],["DNC query gate",o.includes("{ doNotCall: false }")],
["DNC decision gate",o.includes("decideCallCompliance")],["provider certification gate",o.includes("certifiedLiveProvider")],
["no simulated AI on media-less call",o.includes("refusing simulated AI result")],["outcome stored",o.includes("prisma.call.create")],
["attribution stored",o.includes("recordCallAttribution")],["learning stored",o.includes("learnFromAttributedOutcome")],
["proposal remains review path",o.includes("ELIGIBLE_FOR_STRATEGY_REVIEW")],["campaign completion stored",o.includes('status: "COMPLETED"')],
["followup scheduling present",o.includes("scheduleFollowUp")],["spoken DNC cancels followup",o.includes("sipResult?.doNotCall ? null")],
["notification only positive outcomes",o.includes('resultStatus === "INTERESTED" || resultStatus === "CONVERTED"')],["notification failure cannot undo call",o.indexOf("const storedCall=txResult[1]")<o.lastIndexOf("deliverOutcomeNotification")],
["no raw notification exception DB",!n.includes("err.message")],["campaign main loop tenant due leads",/prisma\.lead\.findMany\(\{[\s\S]*?where:\s*\{[\s\S]*?userId/.test(o)],
["strategy assigned campaign",o.includes("strategyId: foundation.strategy.id")],["experiment assigned campaign",o.includes("experimentId: foundation.experiment.id")],
["limit integerized",o.includes("Math.floor(limit)")],["no release mutation",!o.includes("engine-v1.4.0")]];
for(const [n,v] of checks)assert.ok(v,n);console.log("campaign autonomy contract: "+checks.length+"/"+checks.length+" checks PASS");