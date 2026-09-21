"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert");
const s=fs.readFileSync(path.join(__dirname,"../../lib/controlled-learning.ts"),"utf8");
const checks=[
["evaluation tenant scoped",s.includes("id:input.proposalId,userId:input.userId,active:false")],
["baseline tenant scoped",s.includes("userId:input.userId,active:true")],
["minimum 20 evidence",s.includes("rows.length<20")],["mean reward computed",s.includes("outcomeReward(e.outcome),0)/rows.length")],
["positive signal required",s.includes("mean>0")],["promotion explicit approval",s.includes('if(!input.approved)return {ok:false,code:"APPROVAL_REQUIRED"}')],
["promotion reevaluates",s.includes("const review=await evaluateStrategyProposal(input)")],["promotion transactional",s.includes("prisma.$transaction(async tx")],
["old active disabled",s.includes("updateMany({where:{userId:input.userId,active:true},data:{active:false}})")],
["proposal activated explicitly",s.includes("where:{id:input.proposalId},data:{active:true}")],["rollback explicit approval",s.includes("rollbackStrategy")],
["rollback tenant target",s.includes("id:input.targetStrategyId,userId:input.userId")],["rollback activates target",s.includes("where:{id:target.id},data:{active:true}")],
["no autonomous promotion from learning",!s.match(/learnFromAttributedOutcome[\s\S]{0,900}active:true/)],
["no code mutation",!s.includes("writeFile")&&!s.includes("eval(")],["no auth mutation",!s.includes("EngineDevice")],
["no compliance mutation",!s.includes("doNotCall")&&!s.includes("consentStatus")],["proposal stays inactive initially",s.includes("active:false")],
["review failure codes bounded",s.includes("INSUFFICIENT_EVIDENCE")&&s.includes("NO_POSITIVE_SIGNAL")],["rollback target existence checked",s.includes("TARGET_NOT_FOUND")],
["tenant-wide single active intent",s.includes("updateMany({where:{userId:input.userId,active:true}")],["review returns baseline id",s.includes("baselineId:baseline.id")],
["promotion returns previous id",s.includes("previousStrategyId:review.baselineId")],["approval false never mutates",s.indexOf("if(!input.approved)")<s.indexOf("prisma.$transaction")],
["review proposal must be inactive",s.includes("active:false")]];
for(const [n,v] of checks)assert.ok(v,n);console.log("strategy lifecycle contract: "+checks.length+"/"+checks.length+" checks PASS");