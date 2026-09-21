"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert");
const root=path.join(__dirname,"../..");
const foundation=fs.readFileSync(path.join(root,"lib/sales-foundation.ts"),"utf8");
const orch=fs.readFileSync(path.join(root,"lib/orchestration.ts"),"utf8");
const sip=fs.readFileSync(path.join(root,"lib/sip-conversation.ts"),"utf8");
const ai=fs.readFileSync(path.join(root,"lib/free-ai.ts"),"utf8");
const llm=fs.readFileSync(path.join(root,"lib/llm.ts"),"utf8");
const checks=[
 ["effective config parses persisted strategy",foundation.includes("parseStrategy(strategy?.strategyJson")],
 ["experiment may override bounded fields",foundation.includes("variant.pitch??s.pitch")&&foundation.includes("variant.tone??s.tone")],
 ["product facts remain base customer config",foundation.includes("productName:compact(base?.productName)")],
 ["campaign builds effective config",orch.includes("effectiveAgentConfig(user.agentConfig, foundation.strategy, foundation.experiment)")],
 ["real SIP receives effective config",orch.includes("liveAgentConfig,")],
 ["strategy id transported",sip.includes("strategyId?: string | null")&&ai.includes("strategyId: config.strategyId")],
 ["strategy version transported",sip.includes("strategyVersion?: number")&&ai.includes("strategyVersion: Number(config.strategyVersion")],
 ["experiment id transported",sip.includes("experimentId?: string | null")&&ai.includes("experimentId: config.experimentId")],
 ["LLM receives strategy context",ai.includes("strategyContext: state.strategyVersion")&&llm.includes("Assigned strategy context")],
 ["truth boundary explicit",ai.includes("Stay truthful and within supplied product facts")],
 ["attribution uses same assigned strategy",orch.includes("strategyId:foundation.strategy.id")],
 ["attribution uses same experiment",orch.includes("experimentId:foundation.experiment.id")],
 ["no executable mutation",!foundation.includes("eval(")&&!foundation.includes("writeFile")],
 ["no cross tenant lookup added",!foundation.includes("findMany({})"],
 ["legacy web snippets not injected",!orch.includes("refreshKnowledge")]
];
for(const [n,ok] of checks)assert.ok(ok,n);
console.log("live strategy binding contract: "+checks.length+"/"+checks.length+" checks PASS");
