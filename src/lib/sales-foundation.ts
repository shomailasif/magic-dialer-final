import { prisma } from "@/lib/db";

function compact(v: unknown){return String(v??"").trim().slice(0,12000)}
export function knowledgeFacts(config:any){
 return {description:compact(config?.productDesc),valueProps:compact(config?.valueProps),pricing:compact(config?.pricing),targetAudience:compact(config?.targetAudience),objectionHandling:compact(config?.objectionHandling)};
}
export function strategyDefinition(config:any){
 return {pitch:compact(config?.pitch),tone:String(config?.tone||"CONSULTATIVE"),language:compact(config?.defaultLanguage||"en"),followUpAttempts:Number(config?.followUpAttempts??2),followUpIntervalHours:Number(config?.followUpIntervalHours??24)};
}
export async function ensureSalesFoundation(userId:string,config:any){
 const productName=compact(config?.productName)||"Customer offering";
 let knowledge=await prisma.productKnowledge.findFirst({where:{userId,active:true},orderBy:{version:"desc"}});
 if(!knowledge){
  knowledge=await prisma.productKnowledge.create({data:{userId,version:1,productName,factsJson:JSON.stringify(knowledgeFacts(config)),source:"customer-config"}});
 }
 let strategy=await prisma.salesStrategy.findFirst({where:{userId,active:true},orderBy:{version:"desc"}});
 if(!strategy){
  strategy=await prisma.salesStrategy.create({data:{userId,version:1,name:"Baseline sales strategy",objective:"Qualify prospect truthfully and advance the customer's configured sales objective.",strategyJson:JSON.stringify(strategyDefinition(config)),knowledgeVersion:knowledge.version}});
 }
 let experiment=await prisma.salesExperiment.findFirst({where:{userId,strategyId:strategy.id,status:"ACTIVE"},orderBy:{startedAt:"desc"}});
 if(!experiment){
  experiment=await prisma.salesExperiment.create({data:{userId,strategyId:strategy.id,name:"Baseline control",variantJson:JSON.stringify({kind:"CONTROL",strategyVersion:strategy.version})}});
 }
 return {knowledge,strategy,experiment};
}
export async function recordCallAttribution(input:{userId:string;callId:string;strategyId:string;experimentId?:string|null;outcome:string;score?:number|null;evidence?:unknown}){
 return prisma.callAttribution.create({data:{userId:input.userId,callId:input.callId,strategyId:input.strategyId,experimentId:input.experimentId||null,outcome:compact(input.outcome),score:input.score??null,evidenceJson:input.evidence===undefined?null:JSON.stringify(input.evidence)}});
}

export function parseStrategy(strategyJson:string){
 try{const v=JSON.parse(strategyJson||"{}");return v&&typeof v==="object"?v:{};}catch{return {};}
}
export function effectiveAgentConfig(base:any,strategy:any,experiment:any){
 const s=parseStrategy(strategy?.strategyJson||"{}");
 let variant:any={};try{variant=JSON.parse(experiment?.variantJson||"{}")||{};}catch{}
 return {
  tone:compact(variant.tone??s.tone??base?.tone??"CONSULTATIVE"),
  productName:compact(base?.productName),
  pitch:compact(variant.pitch??s.pitch??base?.pitch),
  pricing:compact(base?.pricing)||undefined,
  strategyId:strategy?.id||null,
  strategyVersion:Number(strategy?.version||0),
  experimentId:experiment?.id||null,
  experimentName:compact(experiment?.name)
 };
}
