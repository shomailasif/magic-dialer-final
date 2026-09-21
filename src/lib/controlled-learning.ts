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
