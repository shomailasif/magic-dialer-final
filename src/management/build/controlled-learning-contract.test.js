"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert");
const root=path.join(__dirname,"../..");
const schema=fs.readFileSync(path.join(root,"../prisma/schema.prisma"),"utf8");
const lib=fs.readFileSync(path.join(root,"lib/controlled-learning.ts"),"utf8");
const orch=fs.readFileSync(path.join(root,"lib/orchestration.ts"),"utf8");
const legacy=fs.readFileSync(path.join(root,"management/portal/learning.js"),"utf8");
const checks=[
 ["persistent learning event",schema.includes("model StrategyLearningEvent")],
 ["tenant scoped learning",schema.includes("userId      String")&&lib.includes("userId:input.userId")],
 ["strategy scoped learning",lib.includes("strategyId:input.strategyId")],
 ["outcome reward deterministic",lib.includes('x==="CONVERTED"')&&lib.includes('x==="INTERESTED"')],
 ["minimum evidence threshold",lib.includes('sampleSize>=20')],
 ["no executable mutation",!lib.includes("eval(")&&!lib.includes("writeFile")&&!lib.includes("exec(")],
 ["no auth mutation",!lib.includes("EngineDevice")&&!lib.includes("tokenHash")],
 ["no compliance mutation",!lib.includes("do-not-call")&&!lib.includes("consent")],
 ["attribution precedes learning",orch.indexOf("recordCallAttribution")<orch.lastIndexOf("learnFromAttributedOutcome")],
 ["campaign feeds real stored outcome",orch.includes("outcome:resultStatus")],
 ["learning stores evidence",lib.includes("evidenceJson")],
 ["legacy web learning identified but not connected to server campaign",legacy.includes("refreshKnowledge")&&!orch.includes("refreshKnowledge")],
 ["review not autonomous promotion",lib.includes("ELIGIBLE_FOR_STRATEGY_REVIEW")&&!lib.includes("salesStrategy.update")],
 ["learning model indexed by tenant",schema.includes("@@index([userId, createdAt])")],
 ["learning model indexed by strategy",schema.includes("@@index([strategyId, createdAt])")]
];
for(const [n,ok] of checks)assert.ok(ok,n);
console.log("controlled learning contract: "+checks.length+"/"+checks.length+" checks PASS");
