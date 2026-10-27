const fs=require("fs"),path=require("path"),os=require("node:os");
const { readInstalledConfig } = require("./installed-config.cjs");
(async()=>{
 const cfg=readInstalledConfig();
 const portal=String(cfg.portalUrl||"").replace(/\/+$/,"");
 const bearer=cfg.deviceToken||cfg.token;
 for (let i=0;i<4;i++){
  const t0=Date.now();
  try{
   const r=await fetch(portal+"/api/engine/ai/chat",{method:"POST",headers:{Authorization:"Bearer "+bearer,"Content-Type":"application/json"},body:JSON.stringify({messages:[{role:"user",content:"Say hello in one short sentence."}],max_tokens:40})});
   const txt=await r.text();
   console.log(`try ${i+1}: ${Date.now()-t0}ms HTTP ${r.status} ${txt.slice(0,150).replace(/\s+/g," ")}`);
  }catch(e){console.log(`try ${i+1}: ${Date.now()-t0}ms ERR ${e.message.slice(0,80)}`);}
  await new Promise(r=>setTimeout(r,2500));
 }
})();
