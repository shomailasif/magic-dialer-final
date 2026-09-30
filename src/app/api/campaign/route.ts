import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
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
      where: wanted ? { id: wanted } : {},
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

  /* The campaign runs in the background and this returns immediately.
   *
   * It used to be awaited inside the request, which only ever worked for a
   * handful of leads. Two accounts had 500 each: the request stayed open making
   * calls for hours, the proxy eventually dropped it, and the Launch button spun
   * forever with nothing on screen. The third account failed fast and appeared to
   * work, which is exactly why this looked intermittent and was hard to catch.
   *
   * Nothing waits for a campaign to finish, so the request must not hold it. */
  void (async () => {
    try {
      const result = await runCampaign(user.id, limit, locale);
      if (!result.ok) {
        // Recorded on the run itself so the UI can show what went wrong.
        console.error("[campaign] run failed:", result.error);
      }
    } catch (err) {
      console.error("[campaign] background run crashed:", err instanceof Error ? err.stack : redactDiagnostic(err));
    }
  })();

  return NextResponse.json({
    ok: true,
    started: true,
    limit,
    message:
      `Campaign started with up to ${limit} lead${limit === 1 ? "" : "s"}. It runs in the ` +
      `background - you can close this page. Progress is shown on the campaign list.`,
  });
}
