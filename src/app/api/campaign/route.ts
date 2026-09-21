import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { runCampaign } from "@/lib/orchestration";
import { diagnosticId, safeDiagnostic, redactDiagnostic } from "@/lib/safe-diagnostic";
import { diagnosticId, safeDiagnostic, redactDiagnostic } from "@/lib/safe-diagnostic";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let limit = 20;
  try {
    const body = await request.json();
    if (typeof body?.limit === "number") limit = Math.min(100, Math.max(1, body.limit));
  } catch {}

  try {
    const cookies = request.headers.get("cookie") || "";
    const match = cookies.match(/(?:^|;\s*)NEXT_LOCALE=([^;]+)/);
    const locale = match ? decodeURIComponent(match[1]) : "en";
    const result = await runCampaign(user.id, limit, locale);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (err: unknown) {
    const requestId=diagnosticId(request.headers.get("x-request-id"));
    console.error("[campaign] error", requestId, redactDiagnostic(err));
    return NextResponse.json({ error:"Campaign failed unexpectedly.", diagnostic:safeDiagnostic("campaign","CAMPAIGN_FAILED",500,requestId) }, { status: 500 });
  }
}
