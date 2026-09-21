"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert");
const root=path.join(__dirname,"../..");
const legacy=fs.readFileSync(path.join(root,"management/portal/learning.js"),"utf8");
const agent=fs.readFileSync(path.join(root,"management/agent/agent.js"),"utf8");
const runner=fs.readFileSync(path.join(root,"management/agent/call-runner.js"),"utf8");
const orch=fs.readFileSync(path.join(root,"lib/orchestration.ts"),"utf8");
const sf=fs.readFileSync(path.join(root,"lib/sales-foundation.ts"),"utf8");
const checks=[
["legacy module still identified",legacy.includes("refreshKnowledge")],["legacy hardcoded callback identified",legacy.includes("CALLBACK_PROMISE")],
["active agent does not import portal learning",!agent.includes("portal/learning")&&!agent.includes("../portal/learning")],
["call runner does not import portal learning",!runner.includes("portal/learning")&&!runner.includes("../portal/learning")],
["server campaign does not import portal learning",!orch.includes("portal/learning")],
["server campaign does not refresh web knowledge",!orch.includes("refreshKnowledge")],["server foundation no web refresh",!sf.includes("refreshKnowledge")],
["server product knowledge customer config",sf.includes('source:"customer-config"')],["server strategy versioned",sf.includes("version:1")],
["server attribution persisted",orch.includes("recordCallAttribution")],["server controlled learning persisted",orch.includes("learnFromAttributedOutcome")],
["local learning not passed into server campaign",!orch.includes("config.learning")],["legacy callback not in server orchestration",!orch.includes("623-400-1991")],
["legacy dispatch assumptions not in server strategy",!sf.includes("dispatch manager")],["no web snippets in live SIP",!fs.readFileSync(path.join(root,"lib/sip-conversation.ts"),"utf8").includes("refreshKnowledge")],
["learning cannot change compliance",!fs.readFileSync(path.join(root,"lib/controlled-learning.ts"),"utf8").includes("doNotCall")],
["learning cannot write executable code",!fs.readFileSync(path.join(root,"lib/controlled-learning.ts"),"utf8").includes("writeFile")],
["legacy module not deleted blindly",legacy.length>1000],["agent local learning remains local",agent.includes("config.learning = result.learning")],
["server source of strategy evolution present",orch.includes("proposeStrategyVersion")]];
for(const [n,v] of checks)assert.ok(v,n);console.log("legacy learning isolation contract: "+checks.length+"/"+checks.length+" checks PASS");