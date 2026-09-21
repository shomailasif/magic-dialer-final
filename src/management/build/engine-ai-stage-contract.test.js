"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const root=path.resolve(__dirname,"..","..",".."),src=fs.readFileSync(path.join(root,"src","app","api","engine","ai","chat","route.ts"),"utf8");
const checks=[
()=>assert.match(src,/"device-auth","UNAUTHORIZED",401/),()=>assert.match(src,/"environment","AI_NOT_CONFIGURED",503/),()=>assert.match(src,/"body","INVALID_BODY",400/),()=>assert.match(src,/"messages","NO_MESSAGES",400/),()=>assert.match(src,/"groq-final","PROVIDER_FAILURE",502/),
()=>assert.match(src,/UNAUTHORIZED",401/),()=>assert.match(src,/AI_NOT_CONFIGURED",503/),()=>assert.match(src,/INVALID_BODY",400/),()=>assert.match(src,/PROVIDER_FAILURE",502/),
()=>assert.match(src,/PRIMARY_MODEL="openai\/gpt-oss-120b"/),()=>assert.match(src,/FALLBACK_MODEL="openai\/gpt-oss-20b"/),()=>assert.match(src,/TRANSIENT=new Set\(\[429,500,502,503,504\]\)/),
()=>assert.match(src,/AbortSignal\.timeout\(timeout\)/),()=>assert.match(src,/boundedRetryDelay\(a\.retryAfter,deadline\)/),()=>assert.match(src,/authorizeActiveEngineDevice/),()=>assert.match(src,/engineBearerToken/),()=>assert.doesNotMatch(src,/prisma\\.engineDevice\\.findUnique/),
()=>assert.match(src,/Authorization:"Bearer "\+key/),()=>assert.match(src,/max_tokens:maxTokens/),()=>assert.match(src,/temperature:\.72/),()=>assert.match(src,/stream:false/),()=>assert.match(src,/502,a\.status/),
()=>assert.match(src,/slice\(0,240\)/),()=>assert.doesNotMatch(src,/console\.(log|error|warn)/),()=>assert.doesNotMatch(src,/RC_SIP|RingCentral/),()=>assert.doesNotMatch(src,/GROQ_API_KEY\s*[:,]/),
()=>assert.match(src,/No messages/),()=>assert.match(src,/Invalid body/),()=>assert.match(src,/Unauthorized/),()=>assert.match(src,/AI provider authentication failed/)
];checks.forEach(fn=>fn());console.log("engine AI gateway stage diagnostic: 30/30 contract checks PASS");
