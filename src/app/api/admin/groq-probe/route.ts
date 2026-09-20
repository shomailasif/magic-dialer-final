import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeMessage(value: unknown): string {
  return String(value || "unknown provider response")
    .replace(/[\r\n]/g, " ")
    .replace(/gsk_[A-Za-z0-9_-]+/g, "[REDACTED]")
    .slice(0, 240);
}

export async function GET() {
  await requireAdmin();
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) return NextResponse.json({ ok:false, configured:false, stage:"environment", status:null, error:"GROQ_API_KEY is not configured" }, { headers:{ "Cache-Control":"no-store" } });
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method:"POST",
      headers:{ Authorization:`Bearer ${key}`, "Content-Type":"application/json" },
      body:JSON.stringify({ model:"openai/gpt-oss-20b", messages:[{role:"user",content:"Reply with exactly OK."}], max_completion_tokens:8, stream:false }),
      signal:AbortSignal.timeout(8000),
      cache:"no-store",
    });
    const raw=await response.text();
    let providerError="";
    try { const parsed=JSON.parse(raw); providerError=safeMessage(parsed?.error?.message || parsed?.error || ""); }
    catch { providerError=safeMessage(raw); }
    return NextResponse.json({ ok:response.ok, configured:true, stage:"groq-direct", status:response.status, model:"openai/gpt-oss-20b", error:response.ok?null:providerError }, { headers:{ "Cache-Control":"no-store" } });
  } catch(error) {
    return NextResponse.json({ ok:false, configured:true, stage:"groq-direct", status:null, model:"openai/gpt-oss-20b", error:safeMessage(error instanceof Error?error.message:String(error)) }, { headers:{ "Cache-Control":"no-store" } });
  }
}
