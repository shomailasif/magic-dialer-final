const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const MANIFEST_URL = "https://github.com/shomailasif/magic-dialer-final/releases/download/engine-latest/engine-manifest.json";

function newer(a,b){const x=String(a).split(".").map(Number),y=String(b).split(".").map(Number);for(let i=0;i<3;i++){if((x[i]||0)!==(y[i]||0))return (x[i]||0)>(y[i]||0)}return false}
async function sha256(file){return await new Promise((resolve,reject)=>{const h=crypto.createHash("sha256"),s=fs.createReadStream(file);s.on("data",d=>h.update(d));s.on("end",()=>resolve(h.digest("hex")));s.on("error",reject)})}
async function download(url,dest){const r=await fetch(url,{redirect:"follow",cache:"no-store"});if(!r.ok)throw new Error("update download HTTP "+r.status);const buf=Buffer.from(await r.arrayBuffer());fs.writeFileSync(dest,buf)}
async function checkForUpdate(currentVersion){
  if(process.platform!=="win32") return {updated:false,reason:"not-windows"};
  const mr=await fetch(MANIFEST_URL,{redirect:"follow",cache:"no-store"});if(!mr.ok)throw new Error("manifest HTTP "+mr.status);
  const m=await mr.json();if(!m.version||!m.url||!m.sha256)throw new Error("invalid update manifest");
  if(!newer(m.version,currentVersion))return {updated:false,reason:"current"};
  const dir=path.join(os.tmpdir(),"MagicDialerUpdate");fs.mkdirSync(dir,{recursive:true});
  const installer=path.join(dir,"magic-dialer-engine-windows.exe");await download(m.url,installer);
  const got=await sha256(installer);if(got.toLowerCase()!==String(m.sha256).toLowerCase()){try{fs.unlinkSync(installer)}catch{};throw new Error("update SHA-256 mismatch")}
  const child=spawn(installer,["/VERYSILENT","/SUPPRESSMSGBOXES","/NORESTART"],{detached:true,stdio:"ignore",windowsHide:true});child.unref();
  return {updated:true,version:m.version};
}
module.exports={MANIFEST_URL,newer,sha256,checkForUpdate};
