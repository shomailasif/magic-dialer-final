import { NextResponse } from "next/server";

/**
 * Legacy cloud call execution is intentionally disabled.
 * Real-time calls must run through the installed localhost Windows engine.
 * This endpoint remains only as a fail-closed guard against stale clients.
 */
export async function POST() {
  return NextResponse.json(
    { error: "Cloud call execution disabled. Use the installed Magic Dialer Windows engine.", engine: "local-required" },
    { status: 410 },
  );
}
