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
