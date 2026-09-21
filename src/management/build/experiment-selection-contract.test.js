"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert");
const root=path.join(__dirname,"../..");
const sf=fs.readFileSync(path.join(root,"lib/sales-foundation.ts"),"utf8");
const cl=fs.readFileSync(path.join(root,"lib/controlled-learning.ts"),"utf8");
const llm=fs.readFileSync(path.join(root,"lib/llm.ts"),"utf8");
const checks=[
 ["LLM accepts strategy context",llm.includes("strategyContext?: string")],
 ["LLM prompt binds strategy context",llm.includes("ASSIGNED STRATEGY CONTEXT")],
 ["selection tenant scoped",sf.includes('findMany({where:{userId,strategyId,status:"ACTIVE"}')],
 ["selection uses attributed outcomes",sf.includes("prisma.callAttribution.findMany")],
 ["selection experiment scoped",sf.includes("experimentId:e.id")],
 ["minimum 20 samples",sf.includes("x.n>=20")],
 ["deterministic mean reward",sf.includes("rows.reduce")&&sf.includes("/rows.length")],
 ["stable tie break",sf.includes("a.e.startedAt.getTime()-b.e.startedAt.getTime()")],
 ["control fallback before evidence",sf.includes("if(!eligible.length)return control?.e||scored[0].e")],
 ["foundation uses selector",sf.includes("selectExperiment(userId,strategy.id)")],
 ["proposal tenant scoped",cl.includes("id:input.strategyId,userId:input.userId")],
 ["proposal requires evidence",cl.includes('action:"ELIGIBLE_FOR_STRATEGY_REVIEW"')],
 ["proposal increments version",cl.includes("nextVersion")],
 ["proposal remains inactive",cl.includes("active:false")],
 ["proposal copies data only",cl.includes("strategyJson:current.strategyJson")],
 ["no automatic activation",cl.includes("APPROVAL_REQUIRED")&&!cl.match(/proposeStrategyVersion[\\s\\S]{0,1600}active:true/)],
 ["no executable mutation",!cl.includes("eval(")&&!cl.includes("writeFile")&&!cl.includes("exec(")],
 ["no auth mutation",!cl.includes("EngineDevice")&&!cl.includes("tokenHash")],
 ["no compliance mutation",!cl.includes("consent")&&!cl.includes("do-not-call")],
 ["no cross-tenant selection",!sf.includes("findMany({where:{strategyId,status")]
];
for(const [n,ok] of checks)assert.ok(ok,n);
console.log("experiment selection contract: "+checks.length+"/"+checks.length+" checks PASS");
