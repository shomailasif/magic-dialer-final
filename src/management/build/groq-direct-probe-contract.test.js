"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const root=path.resolve(__dirname,"..","..","..");
const src=fs.readFileSync(path.join(root,"src","app","api","admin","groq-probe","route.ts"),"utf8");
const checks=[
()=>assert.match(src,/requireAdmin\(\)/),()=>assert.match(src,/process\.env\.GROQ_API_KEY/),
()=>assert.match(src,/api\.groq\.com\/openai\/v1\/chat\/completions/),()=>assert.match(src,/openai\/gpt-oss-20b/),
()=>assert.match(src,/max_completion_tokens:8/),()=>assert.match(src,/AbortSignal\.timeout\(8000\)/),
()=>assert.match(src,/cache:"no-store"/),()=>assert.match(src,/Cache-Control":"no-store"/),
()=>assert.match(src,/response\.status/),()=>assert.match(src,/parsed\?\.error\?\.message/),
()=>assert.match(src,/slice\(0, 240\)/),()=>assert.match(src,/\[REDACTED\]/),
()=>assert.doesNotMatch(src,/console\.(log|error|warn)/),()=>assert.doesNotMatch(src,/RC_SIP|RingCentral|deviceToken/),
()=>assert.doesNotMatch(src,/NextResponse\.json\(\{[^}]*key[,:]/),
()=>assert.match(src,/configured:false/),()=>assert.match(src,/stage:"environment"/),
()=>assert.match(src,/stage:"groq-direct"/),()=>assert.match(src,/status:null/),
()=>assert.match(src,/response\.ok/),()=>assert.match(src,/await response\.text\(\)/),
()=>assert.match(src,/JSON\.parse\(raw\)/),()=>assert.match(src,/stream:false/),
()=>assert.match(src,/method:"POST"/),()=>assert.match(src,/Content-Type":"application\/json"/)
];
checks.forEach(fn=>fn());
console.log("admin Groq direct probe: 25/25 contract checks PASS");
