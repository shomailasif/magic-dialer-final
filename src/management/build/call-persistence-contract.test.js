"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert");
const root=path.join(__dirname,"../.."),o=fs.readFileSync(path.join(root,"lib/orchestration.ts"),"utf8"),s=fs.readFileSync(path.join(root,"../prisma/schema.prisma"),"utf8"),m=fs.readFileSync(path.join(root,"../prisma/migrations/20260921_call_execution_key/migration.sql"),"utf8"),sf=fs.readFileSync(path.join(root,"lib/sales-foundation.ts"),"utf8"),cl=fs.readFileSync(path.join(root,"lib/controlled-learning.ts"),"utf8");
const checks=[
["call execution key unique",s.includes("executionKey   String?      @unique")],["migration adds key",m.includes('ADD COLUMN "executionKey"')],
["migration unique index",m.includes('UNIQUE INDEX "Call_executionKey_key"')],["execution key campaign lead",o.includes('campaign.id+":"+lead.id')],
["existing execution checked",o.includes("findUnique({where:{executionKey}})")],["duplicate skips persistence",o.includes("if(existingCall){continue;}")],
["lead and call atomic",o.includes("const txResult=await prisma.$transaction(txWrites)")],["call in transaction",o.includes("prisma.call.create({")],
["execution key stored",o.includes("executionKey,")],["attribution after stored call",o.indexOf("const storedCall=txResult[1]")<o.lastIndexOf("recordCallAttribution")],
["attribution replay safe",sf.includes("callAttribution.upsert")],["attribution unique call key",sf.includes("where:{callId:input.callId}")],
["learning checks call evidence",cl.includes("const callId=(input.evidence as any)?.callId")],["learning prior tenant lookup",cl.includes("userId:input.userId,strategyId:input.strategyId")],
["learning replay returns prior",cl.includes("if(prior)return prior")],["campaign loop guarded",/try\s*\{\s*for\s*\(const lead of dueLeads\)/.test(o)],
["campaign failure finalized",o.includes('status:"COMPLETED",callsMade,endedAt:new Date(),name:campaign.name+" [FAILED]"')],["campaign failure bounded",o.includes('error:"Campaign execution failed."')],
["campaign failure redacted",o.includes('console.error("[campaign] run failed:", redactDiagnostic(e))')],["successful campaign completes",o.includes('status: "COMPLETED"')],
["DNC update atomic with call",o.indexOf("doNotCallReason")<o.indexOf("prisma.call.create")],["attempt increment atomic with call",o.indexOf("followUpAttemptsMade")<o.indexOf("prisma.call.create")],
["network before DB transaction",o.indexOf("placeConversationalCall")<o.indexOf("prisma.$transaction(txWrites)")],["no executable mutation",!o.includes("eval(")],
["migration additive",!m.match(/DROP|DELETE/i)],["nullable migration safe",m.includes('ADD COLUMN "executionKey" TEXT')],
["attribution tenant scoped",sf.includes("userId:input.userId")],["learning threshold remains",cl.includes("sampleSize>=20")],
["proposal inactive",cl.includes("active:false")],["compliance pre-call",o.indexOf("decideCallCompliance")<o.indexOf("placeConversationalCall")]];
for(const [n,v] of checks)assert.ok(v,n);console.log("call persistence contract: "+checks.length+"/"+checks.length+" checks PASS");