import{NextResponse}from"next/server";import{authorizeActiveEngineDevice,engineBearerToken}from"@/lib/engine-device-auth";import{consumeAIQuota,quotaResponse}from"@/lib/ai-quota";import{diagnosticId,safeDiagnostic}from"@/lib/safe-diagnostic";const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));function D(u:number){u=(~u)&255;const s=u&128,e=(u>>4)&7,m=u&15;let x=((m<<1)+33)<<(e+2);x-=132;return s?-x:x}function W(a:Buffer){const p=Buffer.alloc(a.length*2);for(let i=0;i<a.length;i++)p.writeInt16LE(Math.max(-32768,Math.min(32767,D(a[i]))),i*2);const h=Buffer.alloc(44);h.write("RIFF",0);h.writeUInt32LE(36+p.length,4);h.write("WAVE",8);h.write("fmt ",12);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(8000,24);h.writeUInt32LE(16000,28);h.writeUInt16LE(1,32);h.writeUInt16LE(16,34);h.write("data",36);h.writeUInt32LE(p.length,40);return Buffer.concat([h,p])}export async function POST(r:Request){const requestId=diagnosticId(r.headers.get("x-request-id"));const callId=diagnosticId(r.headers.get("x-call-id"));const fail=(error:string,stage:string,code:string,status:number,upstreamStatus?:number)=>NextResponse.json({error,...safeDiagnostic(stage,code,status,requestId,callId),...(upstreamStatus?{upstreamStatus}:{})},{status});const d=await authorizeActiveEngineDevice(engineBearerToken(r));if(!d)return fail("Unauthorized","device-auth","UNAUTHORIZED",401);const quota=await consumeAIQuota("stt",d,Math.max(1,Math.ceil(Number(r.headers.get("content-length")||0)/1024)));if(!quota.ok)return quotaResponse(quota.retryAfter);const key=process.env.GROQ_API_KEY;if(!key)return fail("STT service unavailable","environment","STT_NOT_CONFIGURED",503);let b:any;try{b=await r.json()}catch{return fail("Invalid body","body","INVALID_BODY",400)}const s=String(b.audio||"");if(!s||s.length>500000)return fail("Invalid audio","audio","INVALID_AUDIO",400);const a=Buffer.from(s,"base64");if(a.length<100||a.length>300000)return fail("Invalid audio size","audio","INVALID_AUDIO_SIZE",400);const f=new FormData();f.append("file",new Blob([new Uint8Array(W(a))],{type:"audio/wav"}),"speech.wav");f.append("model",process.env.AUTODIAL_WHISPER_MODEL||"whisper-small");f.append("response_format","verbose_json");f.append("temperature","0");const hint=String(b.hint||"auto").toLowerCase();if(hint!=="auto"&&/^[a-z]{2}(-[a-z]{2})?$/.test(hint))f.append("language",hint.split("-")[0]);try{
 // Bounded, and retried once. This route had a single 15s upstream attempt and
 // no retry at all, so one slow provider call failed the whole turn - and the
 // engine was giving up on this route after 5s anyway, meaning the provider
 // kept working for another 10s on an answer nobody would read. The budget now
 // finishes under the engine's patience, and a transient failure gets a second
 // try instead of being handed straight back as a 502.
 // Must finish inside the engine's 5s per-attempt window, or the engine abandons
 // the request while this route is still working on it. A second attempt only
 // happens when the first failed fast and budget remains.
 const STT_BUDGET_MS=4_500,STT_ATTEMPT_MS=4_000;
 const sttDeadline=Date.now()+STT_BUDGET_MS;
 let lastStatus=0,reason="STT provider request failed";
 for(let attempt=1;attempt<=2;attempt++){
  const left=sttDeadline-Date.now();
  if(left<900)break;
  const slot=Math.min(STT_ATTEMPT_MS,left);
  try{
   const u=await fetch("https://api.groq.com/openai/v1/audio/transcriptions",{method:"POST",headers:{Authorization:"Bearer "+key},body:f,signal:AbortSignal.timeout(slot)}),j:any=await u.json().catch(()=>({}));
   if(u.ok)return NextResponse.json({ok:true,text:String(j.text||"").trim()||null,language:j.language||null,requestId,callId});
   lastStatus=u.status;reason="STT provider request failed";
  }catch(e:any){
   lastStatus=504;reason=e?.name==="TimeoutError"?"STT provider timed out":"STT provider request failed";
  }
  if(attempt<2)await sleep(150);
 }
 return fail(reason,"groq-stt","PROVIDER_FAILURE",lastStatus||502,lastStatus||undefined)
}catch{return fail("STT provider request failed","groq-stt","PROVIDER_FAILURE",502)}}