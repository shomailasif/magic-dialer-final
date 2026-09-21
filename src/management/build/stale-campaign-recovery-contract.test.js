"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert");
const o=fs.readFileSync(path.join(__dirname,"../../lib/orchestration.ts"),"utf8");
const checks=[
["stale cutoff 2h",o.includes("2*60*60*1000")],["tenant scoped stale query",o.includes('where:{userId,status:"RUNNING"')],
["only older campaigns",o.includes("startedAt:{lt:staleBefore}")],["terminal existing status",o.includes('data:{status:"COMPLETED",endedAt:new Date()}')],
["recovery before foundation",o.indexOf("staleBefore")<o.indexOf("ensureSalesFoundation")],["empty due leads returns before recovery",o.indexOf("dueLeads.length===0")<o.indexOf("staleBefore")],
["does not delete history",!o.includes("callCampaign.delete")],["does not touch other tenants",o.includes("where:{userId")],
["new campaign still running default",o.includes("prisma.callCampaign.create")],["normal completion retained",o.includes('status: "COMPLETED"')],
["crash completion retained",o.includes('[FAILED]')],["no invented enum",!o.includes('status:"FAILED"')],
["calls made retained on crash",o.includes("callsMade,endedAt")],["no executable mutation",!o.includes("eval(")],
["limit remains bounded",o.includes("Math.min(100")],["subscription gate remains",o.includes('status !== "ACTIVE"')],
["DNC gate remains",o.includes("decideCallCompliance")],["tenant suppression remains",o.includes("phoneSuppression")],
["execution idempotency remains",o.includes("executionKey")],["atomic persistence remains",o.includes("prisma.$transaction(txWrites)")]];
for(const [n,v] of checks)assert.ok(v,n);console.log("stale campaign recovery contract: "+checks.length+"/"+checks.length+" checks PASS");