import { prisma } from "@/lib/db";

export function outcomeReward(outcome:string){
 const x=String(outcome||"").toUpperCase();
 if(x==="CONVERTED")return 1;
 if(x==="INTERESTED")return .6;
 if(x==="NO_RESPONSE")return .1;
 if(x==="NOT_INTERESTED")return -.25;
 if(x==="FAILED")return -.1;
 return 0;
}
export async function learnFromAttributedOutcome(input:{userId:string;strategyId:string;outcome:string;evidence?:unknown}){
 const reward=outcomeReward(input.outcome);
 const callId=(input.evidence as any)?.callId;
 if(callId){const prior=await prisma.strategyLearningEvent.findFirst({where:{userId:input.userId,strategyId:input.strategyId,evidenceJson:{contains:String(callId)}}});if(prior)return prior;}
 const sampleSize=await prisma.callAttribution.count({where:{userId:input.userId,strategyId:input.strategyId}});
 // Learning is deliberately data-only. It may propose a new strategy version
 // after enough evidence; it never edits executable code, auth, or compliance.
 const action=sampleSize>=20?"ELIGIBLE_FOR_STRATEGY_REVIEW":"OBSERVE";
 return prisma.strategyLearningEvent.create({data:{userId:input.userId,strategyId:input.strategyId,outcome:String(input.outcome),reward,sampleSize,action,evidenceJson:input.evidence===undefined?null:JSON.stringify(input.evidence)}});
}

export async function proposeStrategyVersion(input:{userId:string;strategyId:string;reason:string}){
 const current=await prisma.salesStrategy.findFirst({where:{id:input.strategyId,userId:input.userId}});
 if(!current)return null;
 const eligible=await prisma.strategyLearningEvent.count({where:{userId:input.userId,strategyId:input.strategyId,action:"ELIGIBLE_FOR_STRATEGY_REVIEW"}});
 if(eligible<1)return null;
 const pending=await prisma.salesStrategy.findFirst({where:{userId:input.userId,active:false,strategyJson:current.strategyJson,knowledgeVersion:current.knowledgeVersion},orderBy:{version:"desc"}});
 if(pending)return pending;
 const latest=await prisma.salesStrategy.findFirst({where:{userId:input.userId},orderBy:{version:"desc"}});
 const nextVersion=(latest?.version||current.version)+1;
 const exists=await prisma.salesStrategy.findFirst({where:{userId:input.userId,version:nextVersion}});
 if(exists)return exists;
 return prisma.salesStrategy.create({data:{userId:input.userId,version:nextVersion,name:`Strategy proposal v${nextVersion}`,objective:current.objective,strategyJson:current.strategyJson,knowledgeVersion:current.knowledgeVersion,active:false}});
}

export async function evaluateStrategyProposal(input:{userId:string;proposalId:string}){
 const proposal=await prisma.salesStrategy.findFirst({where:{id:input.proposalId,userId:input.userId,active:false}});
 if(!proposal)return {eligible:false,code:"NO_PENDING_PROPOSAL"} as const;
 const baseline=await prisma.salesStrategy.findFirst({where:{userId:input.userId,active:true},orderBy:{version:"desc"}});
 if(!baseline)return {eligible:false,code:"NO_ACTIVE_BASELINE"} as const;
 const events=await prisma.strategyLearningEvent.findMany({where:{userId:input.userId,strategyId:baseline.id},select:{reward:true}});
 if(events.length<20)return {eligible:false,code:"INSUFFICIENT_EVIDENCE",samples:events.length} as const;
 const mean=events.reduce((a,e)=>a+e.reward,0)/events.length;
 return {eligible:mean>0,code:mean>0?"REVIEWABLE":"NO_POSITIVE_SIGNAL",samples:events.length,mean,baselineId:baseline.id,proposalId:proposal.id} as const;
}
export async function promoteStrategyProposal(input:{userId:string;proposalId:string;approved:boolean}){
 if(!input.approved)return {ok:false,code:"APPROVAL_REQUIRED"} as const;
 const review=await evaluateStrategyProposal(input);
 if(!review.eligible||!("baselineId" in review))return {ok:false,code:review.code} as const;
 return prisma.$transaction(async tx=>{
  await tx.salesStrategy.updateMany({where:{userId:input.userId,active:true},data:{active:false}});
  const promoted=await tx.salesStrategy.update({where:{id:input.proposalId},data:{active:true}});
  return {ok:true,code:"PROMOTED",strategyId:promoted.id,previousStrategyId:review.baselineId} as const;
 });
}
export async function rollbackStrategy(input:{userId:string;targetStrategyId:string;approved:boolean}){
 if(!input.approved)return {ok:false,code:"APPROVAL_REQUIRED"} as const;
 const target=await prisma.salesStrategy.findFirst({where:{id:input.targetStrategyId,userId:input.userId}});
 if(!target)return {ok:false,code:"TARGET_NOT_FOUND"} as const;
 return prisma.$transaction(async tx=>{
  await tx.salesStrategy.updateMany({where:{userId:input.userId,active:true},data:{active:false}});
  await tx.salesStrategy.update({where:{id:target.id},data:{active:true}});
  return {ok:true,code:"ROLLED_BACK",strategyId:target.id} as const;
 });
}
