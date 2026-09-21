import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
export const runtime="nodejs"; export const dynamic="force-dynamic";
function safeMessage(v:unknown){return String(v||"unknown provider response").replace(/[\r\n]/g," ").replace(/gsk_[A-Za-z0-9_-]+/g,"[REDACTED]").slice(0,240)}
async function probe(key:string,model:string){
 try{
  const r=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({model,messages:[{role:"system",content:"You are a connectivity test."},{role:"user",content:"Reply with exactly READY."}],temperature:.72,max_tokens:8,stream:false}),signal:AbortSignal.timeout(8000),cache:"no-store"});
  const raw=await r.text(); let error="";
  if(!r.ok){try{const j=JSON.parse(raw);error=safeMessage(j?.error?.message||j?.error||"")}catch{error=safeMessage(raw)}}
  return {ok:r.ok,status:r.status,model,error:r.ok?null:error};
 }catch(e){return {ok:false,status:null,model,error:safeMessage(e instanceof Error?e.message:String(e))}}
}
export async function GET(){await requireAdmin();const key=process.env.GROQ_API_KEY?.trim();if(!key)return NextResponse.json({ok:false,configured:false,stage:"environment",results:[]},{headers:{"Cache-Control":"no-store"}});const results=[];for(const model of ["openai/gpt-oss-20b","openai/gpt-oss-120b"])results.push(await probe(key,model));return NextResponse.json({ok:results.every(x=>x.ok),configured:true,stage:"groq-production-shape",results},{headers:{"Cache-Control":"no-store"}})}
