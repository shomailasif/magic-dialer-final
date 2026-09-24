"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const root=path.resolve(__dirname,"..","..",".."),src=fs.readFileSync(path.join(root,"src","app","api","admin","groq-probe","route.ts"),"utf8");
const checks=[
()=>assert.match(src,/requireAdmin\(\)/),()=>assert.match(src,/process\.env\.GROQ_API_KEY/),
()=>assert.match(src,/api\.groq\.com\/openai\/v1\/chat\/completions/),()=>assert.match(src,/openai\/gpt-oss-20b/),
()=>assert.match(src,/openai\/gpt-oss-120b/),()=>assert.match(src,/temperature:\.72/),
  ()=>assert.match(src,/max_tokens:64/),()=>assert.match(src,/stream:false/),
()=>assert.match(src,/AbortSignal\.timeout\(8000\)/),()=>assert.match(src,/cache:"no-store"/),
()=>assert.match(src,/Cache-Control":"no-store"/),()=>assert.match(src,/r\.status/),
()=>assert.match(src,/j\?\.error\?\.message/),()=>assert.match(src,/slice\(0,240\)/),
()=>assert.match(src,/\[REDACTED\]/),()=>assert.doesNotMatch(src,/console\.(log|error|warn)/),
()=>assert.doesNotMatch(src,/RC_SIP|RingCentral|deviceToken/),()=>assert.doesNotMatch(src,/NextResponse\.json\(\{[^}]*\b(?:apiKey|GROQ_API_KEY|key)\s*:/),
()=>assert.match(src,/stage:"environment"/),()=>assert.match(src,/stage:"groq-production-shape"/),
()=>assert.match(src,/results\.every\(x=>x\.ok\)/),()=>assert.match(src,/for\(const model of/),
()=>assert.match(src,/role:"system"/),()=>assert.match(src,/role:"user"/),
()=>assert.match(src,/Reply with exactly READY/),()=>assert.match(src,/method:"POST"/),
()=>assert.match(src,/Content-Type":"application\/json"/),()=>assert.match(src,/await r\.text\(\)/),
()=>assert.match(src,/JSON\.parse\(raw\)/),()=>assert.match(src,/configured:true/)
];checks.forEach(fn=>fn());console.log("admin Groq production-shape probe: 30/30 contract checks PASS");
