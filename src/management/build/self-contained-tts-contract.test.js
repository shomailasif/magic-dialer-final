"use strict";
const fs=require("fs"),path=require("path"),assert=require("assert");
const root=path.join(__dirname,"..");
const voice=fs.readFileSync(path.join(root,"agent/voice.js"),"utf8");
const iss=fs.readFileSync(path.join(root,"build/installer.iss"),"utf8");
const wf=fs.readFileSync(path.join(root,"../../.github/workflows/build-windows-engine.yml"),"utf8");
const checks=[
 ["voice prefers bundled Python",voice.includes("bundledPython")&&voice.indexOf("bundledPython")<voice.indexOf("process.env.AUTODIAL_PYTHON")],
 ["installer recursively ships runtime",iss.includes('Source: "dist\\runtime\\*"')&&iss.includes("recursesubdirs createallsubdirs")],
 ["workflow builds embedded Python",wf.includes("python-3.12.10-embed-amd64.zip")],
 ["workflow pins edge-tts",wf.includes("edge-tts==7.2.3")],
 ["workflow pins imageio-ffmpeg",wf.includes("imageio-ffmpeg==0.6.0")],
 ["workflow enables site packages",wf.includes("Lib/site-packages")&&wf.includes("import site")],
 ["installed runtime required",wf.includes("Installer missing private Python TTS runtime")],
 ["real synthesis gate present",wf.includes("Private edge-tts synthesis failed")],
 ["PCMU 8k conversion gate present",wf.includes("-ar 8000 -ac 1 -f mulaw")],
 ["clean TTS pass marker present",wf.includes("SELF-CONTAINED TTS: edge-tts -> PCMU/8000 PASS")]
];
for(const [n,ok] of checks)assert.ok(ok,n);
console.log("self-contained TTS contract: "+checks.length+"/"+checks.length+" checks PASS");
