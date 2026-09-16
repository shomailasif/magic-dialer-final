const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { HEARTBEAT_INTERVAL_MS, HOSTED_VOIP_SERVERS } = require("../shared/protocol");
const { setUi } = require("./ui");
const { startWebUi, writeDashboardUrl, dashboardUrlPath } = require("./webui");
const localDb = require("./local-db");
const sync = require("./sync");
function defaultConfigPath(){const base=process.env.AUTODIAL_HOME||path.join(os.homedir(),".magicdialer");return path.join(base,"config.json");}
function loadConfig(p=defaultConfigPath()){try{return JSON.parse(fs.readFileSync(p,"utf8"));}catch{return null;}}
function saveConfig(c,p=defaultConfigPath()){try{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(c,null,2),"utf8");}catch(e){log("saveConfig failed: "+e.message);}}
function log(m){console.log(`[agent] ${new Date().toISOString()} ${m}`);}
function isPacked(){const b=path.basename(process.execPath||"").toLowerCase();return b==="agent.exe"||b==="magicdialer.exe";}
function openBrowser(url){try{spawn("cmd.exe",["/c","start","",String(url)],{windowsHide:true,stdio:"ignore"}).unref();}catch{}}
function openDashboardExternal(){try{const t=fs.readFileSync(dashboardUrlPath(),"utf8"),m=t.match(/^URL=(.+)$/m);if(m&&m[1].trim()){openBrowser(m[1].trim());return true;}}catch{}return false;}
function pidAlive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
const VERSION="2.0.0-local-media";
function pushActivity(c,msg){const f=(c.activity||[]).slice(0,29);f.unshift({at:new Date().toISOString(),msg});c.activity=f;}
function bumpStats(c,r){const d=new Date().toISOString().slice(0,10),s=c.stats||{day:d,calls:0,qualified:0,today:0,qualifiedToday:0};if(s.day!==d){s.day=d;s.today=0;s.qualifiedToday=0;}s.calls++;s.today++;if(r.goodLead){s.qualified++;s.qualifiedToday++;}s.lastScore=r.score||0;c.stats=s;}
function post(url,body){return fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(async r=>({status:r.status,body:await r.json().catch(()=>({}))}));}
function applyPortalConfig(config,p,cfgPath){if(!p||typeof p!=="object")return false;let changed=false;const set=(k,v)=>{if(JSON.stringify(v)!==JSON.stringify(config[k])){config[k]=v;changed=true;}};for(const k of ["product","contactEmail","persona","companyName","callbackNumber","callbackIn","lang","voiceStyle"])if(typeof p[k]==="string"&&p[k].trim())set(k,p[k].trim());if(Array.isArray(p.leadFields))set("leadFields",p.leadFields);if(Array.isArray(p.callList))set("callList",p.callList);if(typeof p.searchEnabled==="boolean")set("searchEnabled",p.searchEnabled);if(p.voip&&p.voip.number&&p.voip.username){const prior=config.voip||{},provider=p.voip.provider||prior.provider||"";set("voip",{provider,number:p.voip.number,extension:p.voip.extension||"",username:p.voip.username,sipPassword:p.voip.sipPassword||"",server:p.voip.server||prior.server||HOSTED_VOIP_SERVERS[provider]||"",port:p.voip.port||prior.port||"",transport:p.voip.transport||prior.transport||"",ready:true});}if(changed)saveConfig(config,cfgPath);return changed;}
async function runAgent(opts={}){
 const cfgPath=opts.configPath||defaultConfigPath(),configDir=path.dirname(cfgPath);let config=loadConfig(cfgPath)||{};
 if(!config.machineId)config.machineId=crypto.randomUUID();if(opts.portalUrl)config.portalUrl=opts.portalUrl;if(opts.token)config.token=opts.token;saveConfig(config,cfgPath);
 let uiServer=null;const ensureWebUi=async()=>uiServer||(uiServer=await startWebUi({readConfig:()=>loadConfig(cfgPath),writeConfig:c=>saveConfig(c,cfgPath),statusPath:path.join(configDir,"status.json"),serviceName:"Magic Dialer"}));
 if(isPacked()||opts.webui||opts.open){const s=await ensureWebUi();try{writeDashboardUrl(s.url);}catch{}if(!opts.noBrowser)openBrowser(s.url);}
 const portal=(config.portalUrl||"").replace(/\/+$/,"");
 const ui=patch=>setUi(configDir,{version:VERSION,company:config.companyName||"our team",product:config.product||"Magic Dialer customer",machineId:config.machineId,stats:config.stats||null,...patch});
 ui({status:"STARTING",mode:"on",line:"Starting local media engine..."});
 if(opts.call===true){
  const { voiceCall }=require("./call"),{ speakToBuffer }=require("./voice"),{ createVad }=require("./vad"),{ createLocalRingCentralEngine }=require("./local-ringcentral-engine"),{ transcribeAuto }=require("./multilingual-stt"),{ normalizeLanguage }=require("./language");
  const v=config.voip||{};if(!v.ready||!v.username||!v.sipPassword||!v.number)throw new Error("VOIP configuration incomplete");
  const target=String(opts.number||config.testNumber||(config.callList||[])[0]||"").trim();if(!target)throw new Error("No destination number configured");
  let state=null,activeLocale=config.lang&&config.lang!=="auto"?normalizeLanguage(config.lang):"en";
  const engine=createLocalRingCentralEngine({number:target,sip:{user:v.username,pass:v.sipPassword,authId:v.extension||v.username,domain:v.server||"sip.ringcentral.com",proxy:v.server||"sip40.ringcentral.com",port:Number(v.port||5096)},onLog:log,onAudio:b=>{if(!state)return;for(let i=0;i<b.length;i+=160){const f=b.subarray(i,i+160);if(f.length<160)continue;const x=state.vad.push(f,20);if(!state.started){state.pre.push(f);if(state.pre.length>10)state.pre.shift();if(x.speaking){state.started=true;state.chunks.push(...state.pre);state.pre=[];}}else{state.chunks.push(f);if(x.ended&&!state.done){state.done=true;state.resolve();}}}}});
  await engine.connect();
  const speakFn=async(text,turn={})=>{const locale=normalizeLanguage(turn.locale||activeLocale);activeLocale=locale;const r=await speakToBuffer(text,{locale,style:config.voiceStyle||"friendly"});if(!r||!Buffer.isBuffer(r.buffer)||r.buffer.length<160)throw new Error("TTS produced no valid PCMU/8000 telephone audio");const n=await engine.sendAudio(r.buffer);log(`[local-media-v2] outbound ${n} bytes PCMU/8000 ${locale} playback finished`);};
  const listenFn=async(turn={})=>{let release;const ended=new Promise(r=>release=r);state={vad:createVad({minSpeechMs:160,endSilenceMs:620}),pre:[],chunks:[],started:false,done:false,resolve:release};const timer=setTimeout(()=>{if(state&&!state.done){state.done=true;state.resolve();}},15000);await ended;clearTimeout(timer);const s=state;state=null;if(!s.started||!s.chunks.length)return null;const audio=Buffer.concat(s.chunks);log(`[local-media-v2] inbound ${audio.length} bytes PCMU/8000`);const stt=await transcribeAuto(audio,{hint:turn.autoLanguage?"auto":(turn.locale||activeLocale)});if(stt.language){activeLocale=stt.language;log(`[local-media-v2] detected language ${activeLocale}`);}if(stt.error)log(`[local-media-v2] STT ${stt.error}`);log(`[local-media-v2] transcript ${stt.text?"received":"empty"}`);return stt.text?{text:stt.text,language:stt.language||activeLocale}:null;};
  try{const result=await voiceCall({product:config.product,leadFields:config.leadFields||[],persona:config.persona,companyName:config.companyName,callbackNumber:config.callbackNumber,callbackIn:config.callbackIn,contactEmail:config.contactEmail,learning:config.learning,locale:config.lang||"auto",voiceStyle:config.voiceStyle||"friendly",speakFn,listenFn,onLog:m=>{log(m);ui({line:m});},onMode:m=>ui({mode:m})});config.learning=result.learning;bumpStats(config,result);pushActivity(config,`Local-media call done - score ${result.score}`);saveConfig(config,cfgPath);}finally{engine.close();}
  if(opts.callOnce)return;
 }
 while(true){try{const res=await post(`${portal}/api/heartbeat`,{token:config.token,voipReady:!!(config.voip&&config.voip.ready),sync:sync.buildSyncPayload()});if(res.status===200&&res.body){if(res.body.disabled){ui({status:"DISABLED",mode:"off",line:"Disabled by admin."});return;}applyPortalConfig(config,res.body.config,cfgPath);if(res.body.sync)sync.processSyncResponse(res.body.sync);ui({status:"ONLINE",mode:"on",line:"heartbeat OK"});}else ui({status:"OFFLINE",mode:"on",line:"Heartbeat rejected"});}catch{ui({status:"OFFLINE",mode:"on",line:"Reconnecting to portal..."});}await new Promise(r=>setTimeout(r,HEARTBEAT_INTERVAL_MS));}
}
if(require.main===module){const args=process.argv.slice(2);runAgent({call:args.includes("--call"),callOnce:args.includes("--call-once"),open:!args.includes("--no-browser")}).catch(e=>{console.error(e);process.exitCode=1;});}
module.exports={runAgent,loadConfig,saveConfig,defaultConfigPath,applyPortalConfig};
