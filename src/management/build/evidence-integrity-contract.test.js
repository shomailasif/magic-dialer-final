"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert");
const root=path.join(__dirname,"../.."),s=fs.readFileSync(path.join(root,"../prisma/schema.prisma"),"utf8"),m=fs.readFileSync(path.join(root,"../prisma/migrations/20260921_learning_source_call/migration.sql"),"utf8"),cl=fs.readFileSync(path.join(root,"lib/controlled-learning.ts"),"utf8"),sf=fs.readFileSync(path.join(root,"lib/sales-foundation.ts"),"utf8");
const checks=[
["source call unique",s.includes("sourceCallId String? @unique")],["migration adds source call",m.includes('ADD COLUMN "sourceCallId"')],
["migration unique index",m.includes("StrategyLearningEvent_sourceCallId_key")],["migration additive",!m.match(/DROP|DELETE/i)],
["exact prior lookup",cl.includes("findUnique({where:{sourceCallId:String(callId)}})")],["event stores source call",cl.includes("sourceCallId:callId?String(callId):null")],
["proposal uses attribution evidence",cl.includes("prisma.callAttribution.findMany")],["proposal tenant scoped",cl.includes("userId:input.userId,strategyId:baseline.id")],
["proposal min 20 actual calls",cl.includes("rows.length<20")],["proposal reward from outcome",cl.includes("outcomeReward(e.outcome)")],
["experiment min 20",sf.includes("x.n>=20")],["control detected explicitly",sf.includes('kind==="CONTROL"')],
["challenger margin 5 percent",sf.includes("best.mean-control.mean<0.05")],["control itself needs evidence",sf.includes("control.n<20")],
["sparse experiment falls control",sf.includes("if(!eligible.length)return active[0]")],["no autonomous strategy activation",!cl.match(/evaluateStrategyProposal[\s\S]{0,1200}active:true/)],
["learning no code mutation",!cl.includes("writeFile")&&!cl.includes("eval(")],["learning no compliance mutation",!cl.includes("doNotCall")],
["attribution replay safe",sf.includes("callAttribution.upsert")],["call attribution unique schema",s.includes("callId       String      @unique")],
["proposal explicit approval retained",cl.includes("APPROVAL_REQUIRED")],["rollback approval retained",cl.includes("rollbackStrategy")],
["experiment tenant scoped",sf.includes("where:{userId,strategyId,status")],["stable tie break",sf.includes("startedAt.getTime()")],
["negative signal not reviewable",cl.includes("NO_POSITIVE_SIGNAL")],["evidence call nullable for legacy safety",s.includes("sourceCallId String?")],
["no cross tenant event lookup",cl.includes("userId:input.userId")],["no release mutation",!cl.includes("engine-v1.4.0")],
["reward mapping bounded",cl.includes("return 1")&&cl.includes("return -.25")],["strategy proposals remain inactive",cl.includes("active:false")]];
for(const [n,v] of checks)assert.ok(v,n);console.log("evidence integrity contract: "+checks.length+"/"+checks.length+" checks PASS");