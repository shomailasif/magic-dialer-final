import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { diagnosticId, safeDiagnostic } from "@/lib/safe-diagnostic";

export const dynamic = "force-dynamic";

/**
 * Start or stop the customer's dialer from the website.
 *
 * The website cannot place a sales call itself: the AI agent, the customer's own
 * VOIP line and the live media all run on their PC. So the button does the only
 * thing it can - it hands the PC an instruction, and the PC obeys it on its next
 * heartbeat, which is a few seconds away. The customer clicks once and never
 * touches a terminal, which is the entire point: they are paying a subscription
 * and they are not going to run PowerShell.
 */
export async function POST(request: Request) {
  const requestId = diagnosticId(request.headers.get("x-request-id"));
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let action = "start";
  let maxCalls = 0;
  try {
    const body = await request.json();
    if (body && typeof body.action === "string") action = body.action;
    if (body && Number(body.maxCalls) > 0) maxCalls = Math.floor(Number(body.maxCalls));
  } catch {}

  if (action !== "start" && action !== "stop") {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  try {
    const config = await prisma.aIAgentConfig.findUnique({ where: { userId: user.id } });
    if (!config) {
      return NextResponse.json(
        { error: "Set up your agent first, then start calling.", ...safeDiagnostic("config", "NO_AGENT_CONFIG", 400, requestId) },
        { status: 400 },
      );
    }
    const command = action === "start" ? JSON.stringify({ action: "start", maxCalls }) : JSON.stringify({ action: "stop" });
    await prisma.aIAgentConfig.update({ where: { id: config.id }, data: { queueCommand: command } as any });
    return NextResponse.json({
      ok: true,
      action,
      requestId,
      message:
        action === "start"
          ? "Starting your dialer. It begins within a few seconds and keeps going through your whole lead list until you stop it."
          : "Stopping your dialer. The current call finishes first.",
    });
  } catch (err) {
    console.error("[queue-command] failed", err);
    return NextResponse.json(
      { error: "Could not reach your PC. Is the Magic Dialer app running on it?", ...safeDiagnostic("db", "DB_UNAVAILABLE", 503, requestId) },
      { status: 503 },
    );
  }
}

/** What the PC reports back, so the website can show real progress. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const config = await prisma.aIAgentConfig.findUnique({ where: { userId: user.id } });
    let state: unknown = null;
    try { state = config?.queueState ? JSON.parse(config.queueState) : null; } catch { state = null; }
    return NextResponse.json({ ok: true, running: Boolean((state as any)?.running), state });
  } catch {
    return NextResponse.json({ error: "Could not read dialer progress." }, { status: 503 });
  }
}
