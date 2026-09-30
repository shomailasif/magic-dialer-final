import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser, requireUser } from "@/lib/auth";
import { runCampaign } from "@/lib/orchestration";
import { diagnosticId, safeDiagnostic, redactDiagnostic } from "@/lib/safe-diagnostic";

export const dynamic = "force-dynamic";

function localeFrom(request: Request): string {
  const cookies = request.headers.get("cookie") || "";
  const match = cookies.match(/(?:^|;\s*)NEXT_LOCALE=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "en";
}

/** Live progress, so the UI never has to sit on a request that will not close. */
export async function GET(request: Request) {
  const requestId = diagnosticId(request.headers.get("x-request-id"));
  const url = new URL(request.url);
  const wanted = url.searchParams.get("campaignId");
  try {
    const runs = await prisma.callCampaign.findMany({
      /* Scoped to this account. Without the userId filter this returned the most
       * recent campaign belonging to ANY customer, so one account could see
       * another's campaign status, name and call count. */
        where: { userId: (await requireUser()).id, ...(wanted ? { id: wanted } : {}) },
      orderBy: { startedAt: "desc" },
      take: 1,
    });
    const run = runs[0] || null;
    return NextResponse.json({
      ok: true,
      requestId,
      running: Boolean(run && String(run.status).toUpperCase() === "RUNNING"),
      campaign: run && {
        id: run.id,
        name: run.name,
        status: run.status,
        callsMade: run.callsMade,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
      },
    });
  } catch (err) {
    console.error("[campaign] status failed", err);
    return NextResponse.json(
      { error: "Could not read campaign progress.", ...safeDiagnostic("db", "DB_UNAVAILABLE", 503, requestId) },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let limit = 20;
  try {
    const body = await request.json();
    if (typeof body?.limit === "number") limit = Math.min(100, Math.max(1, body.limit));
  } catch {}

  const locale = localeFrom(request);

  /* The campaign is awaited, because a detached background job does not survive
   * the response on this host: the worker is frozen the moment the reply is sent,
   * so the run never actually began and every account sat at RUNNING with zero
   * calls forever. Running it inline is the only thing that places calls here.
   *
   * The limit is small on purpose. A short run returns in a couple of minutes; a
   * long one held the request open until the proxy dropped it and the button spun
   * forever. Long runs are the PC queue's job, not a browser button's. */
  try {
    const result = await runCampaign(user.id, limit, locale);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, detail: (result as any).detail, failedLeads: (result as any).failedLeads },
        { status: 400 },
      );
    }
    return NextResponse.json({ ...result, started: true, message: `Campaign finished: ${result.callsMade} call(s) made.` });
  } catch (err: unknown) {
    const requestId=diagnosticId(request.headers.get("x-request-id"));
    console.error("[campaign] error", requestId, err instanceof Error ? err.stack : redactDiagnostic(err));
    return NextResponse.json({ error:"Campaign failed unexpectedly.", diagnostic:safeDiagnostic("campaign","CAMPAIGN_FAILED",500,requestId) }, { status: 500 });
  }
}
