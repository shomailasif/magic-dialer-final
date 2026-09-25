const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const DISCOVERY_URL = "https://api.github.com/repos/shomailasif/magic-dialer-final/releases/latest";
const RELEASE_BASE = "https://github.com/shomailasif/magic-dialer-final/releases/download/";
const HEALTH_URL = "http://127.0.0.1:18787/health";
const CUSTOMER_HEALTH_URL = "http://127.0.0.1:48771/api/health";

function newer(a,b){const x=String(a).split(".").map(Number),y=String(b).split(".").map(Number);for(let i=0;i<3;i++){if((x[i]||0)!==(y[i]||0))return(x[i]||0)>(y[i]||0)}return false}
function validRelease(r){return !!(r&&/^engine-v\d+\.\d+\.\d+$/.test(String(r.tag_name))&&Array.isArray(r.assets)&&r.assets.some(a=>a&&a.name==="engine-manifest.json"&&typeof a.browser_download_url==="string"&&a.browser_download_url===RELEASE_BASE+r.tag_name+"/engine-manifest.json"))}
function validManifest(m,tag){return !!(m&&/^\d+\.\d+\.\d+$/.test(String(m.version))&&m.tag===tag&&tag==="engine-v"+m.version&&/^[a-f0-9]{64}$/i.test(String(m.sha256))&&/^[a-f0-9]{40}$/i.test(String(m.sourceCommit))&&typeof m.url==="string"&&m.url===RELEASE_BASE+tag+"/magic-dialer-engine-windows.exe")}
async function sha256(file){return await new Promise((resolve,reject)=>{const h=crypto.createHash("sha256"),s=fs.createReadStream(file);s.on("data",d=>h.update(d));s.on("end",()=>resolve(h.digest("hex")));s.on("error",reject)})}
async function download(url,dest){const r=await fetch(url,{redirect:"follow",cache:"no-store"});if(!r.ok)throw new Error("update download HTTP "+r.status);fs.writeFileSync(dest,Buffer.from(await r.arrayBuffer()))}
function stateDir(){return path.join(process.env.LOCALAPPDATA||os.homedir(),"Magic Dialer","updates")}
// A revived pre-update agent runs this check 15s after it boots, while the
// installer it spawned is still working. Launching a second installer for the
// same release re-kills the engine the first one just restarted, which is how
// an unattended PC could be left with nothing running after an update.
const INSTALL_LAUNCH_GRACE_MS = 10 * 60 * 1000;
function readState(){const target=path.join(stateDir(),"state.json");try{return JSON.parse(fs.readFileSync(target,"utf8"))}catch{try{const bak=target+".bak";return JSON.parse(fs.readFileSync(bak,"utf8"))}catch{return{}}}}
function writeState(s){fs.mkdirSync(stateDir(),{recursive:true});const target=path.join(stateDir(),"state.json"),tmp=target+".tmp-"+process.pid;fs.writeFileSync(tmp,JSON.stringify(s,null,2));if(fs.existsSync(target))fs.copyFileSync(target,target+".bak");fs.renameSync(tmp,target)}
function seededInstaller(version){const p=path.join(stateDir(),"known-good-"+version+".exe");return fs.existsSync(p)?p:null}
async function healthy(expectedVersion,timeoutMs=45000){const end=Date.now()+timeoutMs;while(Date.now()<end){try{const r=await fetch(HEALTH_URL,{cache:"no-store"});const j=await r.json();if(r.ok&&j.ok&&(!expectedVersion||j.version===expectedVersion))return true}catch{}await new Promise(r=>setTimeout(r,1000))}return false}
// The installer this agent spawns is a child of this agent, and the agent then
// leaves. If the installer dies for any reason after that - it was killed by
// its own StopRunningMagicDialer, crashed, was cut off - nothing is left to
// restart the engine and the PC stays down until the next logon. Arm a
// throwaway cmd.exe (deliberately NOT agent.exe, so the installer's taskkill
// cannot take it down with us) that starts MagicDialer again if no agent is
// running when it wakes up.
function spawnRecoveryWatch(){
 try{
  const md=path.join(process.env.LOCALAPPDATA||os.homedir(),"Magic Dialer","MagicDialer.exe");
  const cmd='ping -n 91 127.0.0.1 >nul & tasklist /FI "IMAGENAME eq agent.exe" 2>nul | findstr /I "agent.exe" >nul || start "" "'+md+'" --no-browser';
  const c=spawn(process.env.ComSpec||"cmd.exe",["/d","/c",cmd],{detached:true,stdio:"ignore",windowsHide:true});c.unref();
 }catch{}
}
function launchInstaller(file,logFile){const args=["/VERYSILENT","/SUPPRESSMSGBOXES","/NORESTART"];if(logFile)args.push("/LOG="+logFile);const c=spawn(file,args,{detached:true,stdio:"ignore",windowsHide:true});c.unref();spawnRecoveryWatch()}
async function checkForUpdate(currentVersion){
 if(process.platform!=="win32")return{updated:false,reason:"not-windows"};
 const rr=await fetch(DISCOVERY_URL,{redirect:"follow",cache:"no-store",headers:{Accept:"application/vnd.github+json"}});if(!rr.ok)throw new Error("release discovery HTTP "+rr.status);
 const release=await rr.json();if(!validRelease(release))throw new Error("invalid immutable release discovery");
 const tag=release.tag_name;const manifestAsset=release.assets.find(a=>a.name==="engine-manifest.json");
 const mr=await fetch(manifestAsset.browser_download_url,{redirect:"follow",cache:"no-store"});if(!mr.ok)throw new Error("manifest HTTP "+mr.status);
 const m=await mr.json();if(!validManifest(m,tag))throw new Error("invalid or untrusted immutable update manifest");
 if(!newer(m.version,currentVersion))return{updated:false,reason:"current"};
 let s=readState();if(s.blockedVersion===m.version)return{updated:false,reason:"blocked-after-failure"};
 if(s.pendingVersion===m.version&&s.installLaunchedAt&&Date.now()-s.installLaunchedAt<INSTALL_LAUNCH_GRACE_MS)return{updated:false,reason:"install-already-launched"};
 const seed=!s.lastGoodInstaller&&seededInstaller(currentVersion);if(seed)s={...s,lastGoodVersion:currentVersion,lastGoodInstaller:seed};
 const dir=stateDir();fs.mkdirSync(dir,{recursive:true});const installer=path.join(dir,"candidate-"+m.version+".exe");
 // Inno's own /LOG gives us the record of what [Run] and [Code] did, which is
 // the only evidence available if an unattended update ever needs a post-mortem.
 try{for(const f of fs.readdirSync(dir))if(/^setup-.*\.log$/i.test(f)&&f!=="setup-"+m.version+".log")try{fs.unlinkSync(path.join(dir,f))}catch{}}catch{}
 const setupLog=path.join(dir,"setup-"+m.version+".log");
 await download(m.url,installer);const got=await sha256(installer);if(got.toLowerCase()!==m.sha256.toLowerCase()){try{fs.unlinkSync(installer)}catch{};throw new Error("update SHA-256 mismatch")}
 writeState({...s,pendingVersion:m.version,pendingInstaller:installer,previousVersion:currentVersion,sourceCommit:m.sourceCommit,releaseTag:m.tag,installLaunchedAt:Date.now()});launchInstaller(installer,setupLog);
 return{updated:true,version:m.version};
}
async function customerHealthy(timeoutMs=15000){const end=Date.now()+timeoutMs;while(Date.now()<end){try{const r=await fetch(CUSTOMER_HEALTH_URL,{cache:"no-store"});const j=await r.json();if(r.ok&&j.ok===true)return true}catch{}await new Promise(r=>setTimeout(r,500))}return false}
async function validatePendingUpdate(currentVersion,{ready=false}={}){
 const s=readState();if(!s.pendingVersion)return{pending:false};
 if(currentVersion===s.previousVersion)return{pending:true,installing:true};
 if(currentVersion===s.pendingVersion){
   if(!ready)return{pending:true,awaitingReadiness:true};
   writeState({lastGoodVersion:currentVersion,lastGoodInstaller:s.pendingInstaller});
   return{pending:true,healthy:true};
 }
 if(newer(currentVersion,s.pendingVersion)){
   const recovered={...s,lastGoodVersion:currentVersion,blockedVersion:s.pendingVersion,supersededPendingVersion:s.pendingVersion,pendingVersion:null,pendingInstaller:null,previousVersion:null};
   const seed=seededInstaller(currentVersion);if(seed)recovered.lastGoodInstaller=seed;
   writeState(recovered);
   return{pending:true,superseded:true,healthy:true};
 }
 return rollbackPendingUpdate(currentVersion);
}
async function rollbackPendingUpdate(currentVersion){
 const s=readState();if(!s.pendingVersion)return{pending:false};
 const prior=s.lastGoodInstaller;
 writeState({...s,blockedVersion:s.pendingVersion,pendingVersion:null,pendingInstaller:null,failedVersion:currentVersion,installLaunchedAt:Date.now()});
 if(prior&&fs.existsSync(prior)){launchInstaller(prior,path.join(stateDir(),"setup-rollback.log"));return{pending:true,healthy:false,rollback:true}}
 return{pending:true,healthy:false,rollback:false};
}
module.exports={DISCOVERY_URL,RELEASE_BASE,HEALTH_URL,CUSTOMER_HEALTH_URL,newer,validRelease,validManifest,sha256,healthy,customerHealthy,checkForUpdate,validatePendingUpdate,rollbackPendingUpdate,_test:{readState,writeState,stateDir,seededInstaller}};
