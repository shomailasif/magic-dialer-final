"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const brainPath=path.join(__dirname,"..","agent","intelligent-brain.js");
const routePath=path.resolve(__dirname,"..","..","..","src","app","api","engine","ai","chat","route.ts");
const route=fs.readFileSync(routePath,"utf8");
(async()=>{
 const original=global.fetch; let seen=null;
 try{
  global.fetch=async(url,opts)=>{seen={url:String(url),opts};return{ok:true,status:200,json:async()=>({ok:true,text:"READY",model:"openai/gpt-oss-120b"})}};
  delete require.cache[require.resolve(brainPath)];
  const brain=require(brainPath);
  const cfg={portal:"https://portal.example/",deviceToken:"fresh-device-token",product:"Widgets",leadFields:["name"],persona:"Atlas",companyName:"Acme",locale:"en"};
  assert.equal(await brain.preflightBrain(cfg),true);                                      // 1
  assert.equal(seen.url,"https://portal.example/api/engine/ai/chat");                    // 2
  assert.equal(seen.opts.method,"POST");                                                  // 3
  assert.equal(seen.opts.headers["Content-Type"],"application/json");                    // 4
  assert.equal(Object.hasOwn(seen.opts.headers,"Authorization"),false);                   // 5
  assert.ok(seen.opts.signal);                                                            // 6
  const body=JSON.parse(seen.opts.body);
  assert.equal(body.deviceToken,"fresh-device-token");                                   // 7
  assert.equal(body.maxTokens,8);                                                         // 8
  assert.equal(Array.isArray(body.messages),true);                                        // 9
  assert.equal(body.messages.length,2);                                                   // 10
  assert.equal(body.messages[0].role,"system");                                           // 11
  assert.match(body.messages[0].content,/Acme/);                                          // 12
  assert.match(body.messages[0].content,/Widgets/);                                       // 13
  assert.match(body.messages[0].content,/ACTIVE CONVERSATION LANGUAGE: en/);              // 14
  assert.equal(body.messages[1].role,"user");                                             // 15
  assert.equal(body.messages[1].content,"Reply with exactly READY.");                     // 16
  assert.match(route,/authorizeActiveEngineDevice/);                                      // 17
  assert.match(route,/engineBearerToken/);                                                // 18
  assert.match(route,/b\.deviceToken\|\|engineBearerToken\(r\)/);                         // 19
  assert.doesNotMatch(route,/async function auth/);                                      // 20
  assert.doesNotMatch(route,/tokenHash:H\(t\)/);                                       // 21
  assert.match(route,/if\(!d\)return NextResponse\.json/);                            // 22
  assert.match(route,/diagnosticStage:"device-auth"/);                                   // 23
  assert.match(route,/PRIMARY_MODEL="openai\/gpt-oss-120b"/);                            // 24
  assert.match(route,/FALLBACK_MODEL="openai\/gpt-oss-20b"/);                            // 25
  assert.match(route,/AbortSignal\.timeout\(timeout\)/);                                   // 26
  assert.match(route,/TRANSIENT=new Set\(\[429,500,502,503,504\]\)/);                   // 27
  assert.match(route,/Authorization:"Bearer "\+key/);                                   // 28 provider auth unchanged
  assert.doesNotMatch(route,/RC_SIP|RingCentral/);                                       // 29
  assert.doesNotMatch(seen.opts.body,/gsk_[A-Za-z0-9_-]+/);                              // 30
  global.fetch=async()=>({ok:false,status:401,json:async()=>({error:"Unauthorized",diagnosticStage:"device-auth"})});
  await assert.rejects(()=>brain.preflightBrain(cfg),/AI brain preflight failed: Unauthorized/); // 31
  console.log("AI transport behavioral repair: 31/31 checks PASS");
 }finally{global.fetch=original}
})().catch(e=>{console.error(e);process.exit(1)});
