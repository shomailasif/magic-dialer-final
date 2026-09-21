"use strict";
const {spawnSync}=require("node:child_process");
const path=require("node:path");
const {PrismaClient}=require("@prisma/client");
const prisma=new PrismaClient();
const prismaBin=path.join(process.cwd(),"node_modules",".bin",process.platform==="win32"?"prisma.cmd":"prisma");

const migrations=[
 ["0_init",["t:User","t:Subscription","t:AIAgentConfig","t:DialerConfig","t:Lead","t:CallCampaign","t:Call","t:Session","t:EngineDevice","t:EngineEnrollmentTicket"]],
 ["20260920_ai_quota",["t:AIQuotaBucket","i:AIQuotaBucket_scopeKey_windowStart_key","i:AIQuotaBucket_windowStart_idx"]],
 ["20260921_call_execution_key",["c:Call.executionKey","i:Call_executionKey_key"]],
 ["20260921_compliance_suppression",["c:Lead.doNotCall","c:Lead.doNotCallAt","c:Lead.doNotCallReason","c:Lead.consentStatus","i:Lead_userId_doNotCall_idx"]],
 ["20260921_consent_provenance",["c:Lead.consentSource","c:Lead.consentUpdatedAt"]],
 ["20260921_controlled_learning",["t:StrategyLearningEvent","i:StrategyLearningEvent_userId_createdAt_idx","i:StrategyLearningEvent_strategyId_createdAt_idx"]],
 ["20260921_followup_attempt_accounting",["c:Lead.followUpAttemptsMade"]],
 ["20260921_learning_source_call",["c:StrategyLearningEvent.sourceCallId","i:StrategyLearningEvent_sourceCallId_key"]],
 ["20260921_phone_suppression",["t:PhoneSuppression","i:PhoneSuppression_userId_normalizedPhone_key","i:PhoneSuppression_userId_createdAt_idx"]],
 ["20260921_sales_learning_foundation",["c:CallCampaign.strategyId","c:CallCampaign.experimentId","t:ProductKnowledge","t:SalesStrategy","t:SalesExperiment","t:CallAttribution","i:CallAttribution_callId_key"]]
];

function runPrisma(args){
 const r=spawnSync(prismaBin,args,{stdio:"inherit",env:process.env});
 if(r.error)throw r.error;
 if(r.status!==0)throw new Error("Prisma command failed: "+args.join(" "));
}
async function objects(){
 const rows=await prisma.$queryRawUnsafe("SELECT type,name FROM sqlite_schema WHERE type IN ('table','index')");
 return new Set(rows.map(r=>(r.type==="table"?"t:":"i:")+r.name));
}
async function columns(table){
 const safe=table.replace(/"/g,'""');
 const rows=await prisma.$queryRawUnsafe('PRAGMA table_info("'+safe+'")');
 return new Set(rows.map(r=>String(r.name)));
}
async function present(token,obj,colCache){
 if(token.startsWith("t:")||token.startsWith("i:"))return obj.has(token);
 const spec=token.slice(2),dot=spec.indexOf("."),table=spec.slice(0,dot),column=spec.slice(dot+1);
 if(!colCache.has(table))colCache.set(table,await columns(table));
 return colCache.get(table).has(column);
}
async function state(tokens){
 const obj=await objects(),cols=new Map(); let count=0;
 for(const t of tokens)if(await present(t,obj,cols))count++;
 return count===0?"none":count===tokens.length?"all":"partial";
}
async function verifyAll(){
 for(const [name,tokens] of migrations){
  const s=await state(tokens);
  if(s!=="all")throw new Error("Post-migration verification failed for "+name+": "+s);
 }
}
async function main(){
 const obj=await objects();
 const hasCore=obj.has("t:User");
 const hasHistory=obj.has("t:_prisma_migrations");
 if(hasCore&&!hasHistory){
  const baseline=await state(migrations[0][1]);
  if(baseline!=="all")throw new Error("Legacy database baseline is incomplete; refusing automatic migration.");
  runPrisma(["migrate","resolve","--applied","0_init"]);
  for(const [name,tokens] of migrations.slice(1)){
   const s=await state(tokens);
   if(s==="partial")throw new Error("Migration "+name+" is partially present; refusing to guess.");
   if(s==="all")runPrisma(["migrate","resolve","--applied",name]);
  }
 }
 runPrisma(["migrate","deploy"]);
 await verifyAll();
 console.log("PRODUCTION_SCHEMA_READY");
}
main().then(async()=>{
 await prisma.$disconnect();
 if(process.argv.includes("--migrate-only"))return;
 const r=spawnSync(process.execPath,[path.join(process.cwd(),"node_modules","next","dist","bin","next"),"start"],{stdio:"inherit",env:process.env});
 process.exit(r.status??1);
}).catch(async e=>{console.error("PRODUCTION_SCHEMA_BLOCKED:",e.message);await prisma.$disconnect();process.exit(1);});
