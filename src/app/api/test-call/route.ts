import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const number = String(body.number || "").replace(/[^0-9+]/g, "");
  if (!number || number.length < 7) {
    return NextResponse.json({ error: "Enter a valid phone number (e.g. +16234001991)" }, { status: 400 });
  }

  const rcUser = process.env.RC_SIP_USERNAME;
  const rcPass = process.env.RC_SIP_PASSWORD;
  const rcAuthId = process.env.RC_SIP_AUTH_ID || rcUser;
  const rcCallerId = process.env.RC_CALLER_ID || process.env.RC_PHONE || "";
  const rcDomain = process.env.RC_SIP_DOMAIN || "sip.ringcentral.com";
  const rcProxy = process.env.RC_SIP_PROXY || "sip40.ringcentral.com";
  const rcPort = process.env.RC_SIP_PORT || "5060";

  if (!rcUser || !rcPass) {
    return NextResponse.json({ error: "RingCentral SIP credentials not configured." }, { status: 500 });
  }

  try {
    const { sipCallOnce } = require("../../../management/portal/softphone");
      const result = await sipCallOnce({
        user: rcUser,
        pass: rcPass,
        authId: rcAuthId,
        domain: rcDomain,
        proxy: rcProxy,
        port: Number(rcPort),
        number: number,
        callerId: rcCallerId,
        durationMs: 15000,
      });

    if (result.ok) {
      return NextResponse.json({
        ok: true,
        status: result.outcome || "connected",
        message: `Test call to ${number} completed successfully.`,
      });
    } else {
      return NextResponse.json({
        ok: false,
        error: result.last || "Call failed",
        outcome: result.outcome,
      }, { status: 400 });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: "Test call failed: " + msg }, { status: 500 });
  }
}
