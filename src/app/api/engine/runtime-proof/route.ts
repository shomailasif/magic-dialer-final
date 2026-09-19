import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await prisma.user.findFirst({
      select: { id: true, activeEngineMachineId: true, engineLeaseUntil: true },
    });
    await prisma.engineDevice.findFirst({
      select: { id: true, userId: true, machineId: true, leaseUntil: true },
    });
    await prisma.engineEnrollmentTicket.findFirst({
      select: { id: true, userId: true, expiresAt: true, consumedAt: true },
    });
    return NextResponse.json({
      ok: true,
      service: "magic-dialer-enrollment",
      schema: "engine-enrollment-v2",
      singlePcLease: true,
      automaticEnrollment: true,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({
      ok: false,
      service: "magic-dialer-enrollment",
      schema: "unavailable",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
