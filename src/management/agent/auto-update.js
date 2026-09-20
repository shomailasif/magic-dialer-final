const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const MANIFEST_URL = "https://github.com/shomailasif/magic-dialer-final/releases/download/engine-latest/engine-manifest.json";
const RELEASE_PREFIX = "https://github.com/shomailasif/magic-dialer-final/releases/download/engine-latest/";
const HEALTH_URL = "http://127.0.0.1:18787/health";
const CUSTOMER_HEALTH_URL = "http://127.0.0.1:48771/api/health";

function newer(a,b){const x=String(a).split(".").map(Number),y=String(b).split(".").map(Number);for(let i=0;i<3;i++){if((x[i]||0)!==(y[i]||0))return(x[i]||0)>(y[i]||0)}return false}
function validManifest(m){return !!(m&&/^\d+\.\d+\.\d+$/.test(String(m.version))&&/^[a-f0-9]{64}$/i.test(String(m.sha256))&&typeof m.url==="string"&&m.url.startsWith(RELEASE_PREFIX)&&!m.url.includes(".."))}
async function sha256(file){return await new Promise((resolve,reject)=>{const h=crypto.createHash("sha256"),s=fs.createReadStream(file);s.on("data",d=>h.update(d));s.on("end",()=>resolve(h.digest("hex")));s.on("error",reject)})}
async function download(url,dest){const r=await fetch(url,{redirect:"follow",cache:"no-store"});if(!r.ok)throw new Error("update download HTTP "+r.status);fs.writeFileSync(dest,Buffer.from(await r.arrayBuffer()))}
function stateDir(){return path.join(process.env.LOCALAPPDATA||os.homedir(),"Magic Dialer","updates")}
function readState(){const target=path.join(stateDir(),"state.json");try{return JSON.parse(fs.readFileSync(target,"utf8"))}catch{try{const bak=target+".bak";return JSON.parse(fs.readFileSync(bak,"utf8"))}catch{return{}}}}
function writeState(s){fs.mkdirSync(stateDir(),{recursive:true});const target=path.join(stateDir(),"state.json"),tmp=target+".tmp-"+process.pid;fs.writeFileSync(tmp,JSON.stringify(s,null,2));if(fs.existsSync(target))fs.copyFileSync(target,target+".bak");fs.renameSync(tmp,target)}
function seededInstaller(version){const p=path.join(stateDir(),"known-good-"+version+".exe");return fs.existsSync(p)?p:null}
async function healthy(expectedVersion,timeoutMs=45000){const end=Date.now()+timeoutMs;while(Date.now()<end){try{const r=await fetch(HEALTH_URL,{cache:"no-store"});const j=await r.json();if(r.ok&&j.ok&&(!expectedVersion||j.version===expectedVersion))return true}catch{}await new Promise(r=>setTimeout(r,1000))}return false}
function launchInstaller(file){const c=spawn(file,["/VERYSILENT","/SUPPRESSMSGBOXES","/NORESTART"],{detached:true,stdio:"ignore",windowsHide:true});c.unref()}
async function checkForUpdate(currentVersion){
 if(process.platform!=="win32")return{updated:false,reason:"not-windows"};
 const mr=await fetch(MANIFEST_URL,{redirect:"follow",cache:"no-store"});if(!mr.ok)throw new Error("manifest HTTP "+mr.status);
 const m=await mr.json();if(!validManifest(m))throw new Error("invalid or untrusted update manifest");
 if(!newer(m.version,currentVersion))return{updated:false,reason:"current"};
 let s=readState();if(s.blockedVersion===m.version)return{updated:false,reason:"blocked-after-failure"};
 const seed=!s.lastGoodInstaller&&seededInstaller(currentVersion);if(seed)s={...s,lastGoodVersion:currentVersion,lastGoodInstaller:seed};
 const dir=stateDir();fs.mkdirSync(dir,{recursive:true});const installer=path.join(dir,"candidate-"+m.version+".exe");
 await download(m.url,installer);const got=await sha256(installer);if(got.toLowerCase()!==m.sha256.toLowerCase()){try{fs.unlinkSync(installer)}catch{};throw new Error("update SHA-256 mismatch")}
 writeState({...s,pendingVersion:m.version,pendingInstaller:installer,previousVersion:currentVersion});launchInstaller(installer);
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
 return rollbackPendingUpdate(currentVersion);
}
async function rollbackPendingUpdate(currentVersion){
 const s=readState();if(!s.pendingVersion)return{pending:false};
 const prior=s.lastGoodInstaller;
 writeState({...s,blockedVersion:s.pendingVersion,pendingVersion:null,pendingInstaller:null,failedVersion:currentVersion});
 if(prior&&fs.existsSync(prior)){launchInstaller(prior);return{pending:true,healthy:false,rollback:true}}
 return{pending:true,healthy:false,rollback:false};
}
module.exports={MANIFEST_URL,RELEASE_PREFIX,HEALTH_URL,CUSTOMER_HEALTH_URL,newer,validManifest,sha256,healthy,customerHealthy,checkForUpdate,validatePendingUpdate,rollbackPendingUpdate,_test:{readState,writeState,stateDir,seededInstaller}};
