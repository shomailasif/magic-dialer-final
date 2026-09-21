"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert");
const root=path.join(__dirname,"../..");
const schema=fs.readFileSync(path.join(root,"../prisma/schema.prisma"),"utf8");
const lib=fs.readFileSync(path.join(root,"lib/sales-foundation.ts"),"utf8");
const orch=fs.readFileSync(path.join(root,"lib/orchestration.ts"),"utf8");
const migration=fs.readFileSync(path.join(root,"../prisma/migrations/20260921_sales_learning_foundation/migration.sql"),"utf8");
const checks=[
 ["tenant knowledge model",schema.includes("model ProductKnowledge")&&schema.includes("@@unique([userId, version])")],
 ["versioned strategy model",schema.includes("model SalesStrategy")&&schema.includes("knowledgeVersion Int")],
 ["experiment model",schema.includes("model SalesExperiment")&&schema.includes("variantJson String")],
 ["call attribution model",schema.includes("model CallAttribution")&&schema.includes("callId      String   @unique")],
 ["tenant isolation keys",["ProductKnowledge","SalesStrategy","SalesExperiment","CallAttribution"].every(n=>schema.slice(schema.indexOf("model "+n),schema.indexOf("model "+n)+900).includes("userId"))],
 ["knowledge derived from customer config",lib.includes("productDesc")&&lib.includes("valueProps")&&lib.includes("targetAudience")],
 ["strategy derived from config",lib.includes("pitch")&&lib.includes("followUpAttempts")],
 ["no executable-code learning",!lib.includes("eval(")&&!lib.includes("Function(")&&!lib.includes("writeFile")],
 ["campaign assigns strategy",orch.includes("strategyId: foundation.strategy.id")],
 ["campaign assigns experiment",orch.includes("experimentId: foundation.experiment.id")],
 ["call outcome attributed",orch.includes("recordCallAttribution({userId,callId:storedCall.id")],
 ["migration creates all learning tables",["ProductKnowledge","SalesStrategy","SalesExperiment","CallAttribution"].every(n=>migration.includes('CREATE TABLE "'+n+'"'))],
 ["migration is additive",!migration.includes("DROP TABLE")&&!migration.includes("DELETE FROM")],
 ["strategy deletion protects attribution",migration.includes("ON DELETE RESTRICT")],
 ["call attribution cascades with call",migration.includes('CallAttribution_callId_fkey')&&migration.includes('ON DELETE CASCADE')]
];
for(const [n,ok] of checks)assert.ok(ok,n);
console.log("sales foundation contract: "+checks.length+"/"+checks.length+" checks PASS");
