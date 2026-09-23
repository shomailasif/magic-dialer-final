import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, getAdminId } from "../_lib";
import { prisma } from "@/lib/db";
import { DialerProvider } from "@prisma/client";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const err = await requireAdmin();
  if (err) return err;
  const adminId = await getAdminId();
  const body = await req.json().catch(() => ({}));
  const { userId, voipShared, voip } = body;
  if (!userId || typeof userId !== "string") return NextResponse.json({ error: "Missing userId" }, { status: 400 });
  if (voipShared !== undefined && typeof voipShared !== "boolean") return NextResponse.json({ error: "Invalid voipShared" }, { status: 400 });
  if (voip !== undefined && (typeof voip !== "object" || voip === null)) return NextResponse.json({ error: "Invalid voip" }, { status: 400 });
  const user = await prisma.user.findFirst({ where: { id: userId, createdByAdminId: adminId } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (voipShared !== undefined) {
    await prisma.$executeRawUnsafe(`UPDATE "DialerConfig" SET "voipShared" = ? WHERE "userId" = ?`, voipShared ? 1 : 0, userId);
  }
  if (voip !== undefined) {
    const allowed = ["provider", "number", "username", "sipPassword", "server", "domain", "authId", "port"];
    const clean: any = {};
    for (const k of allowed) { if (voip[k] !== undefined && voip[k] !== null && String(voip[k]).trim()) clean[k] = String(voip[k]).trim(); }
    const providerMap: Record<string, DialerProvider> = { ringcentral: "RINGCENTRAL", twilio: "TWILIO", vonage: "VONAGE" };
    const prov = providerMap[clean.provider?.toLowerCase()] || "RINGCENTRAL";
    await prisma.dialerConfig.upsert({
      where: { userId },
      create: {
        userId,
        provider: prov,
        sipUsername: clean.username || "",
        sipPassword: clean.sipPassword || "",
        sipAuthId: clean.authId || clean.username || "",
        sipDomain: clean.domain || "sip.ringcentral.com",
        sipProxy: clean.server || "",
        sipPort: clean.port || "5096",
        outboundNumber: clean.number || "",
        validated: true,
      },
      update: {
        provider: prov,
        sipUsername: clean.username || "",
        sipPassword: clean.sipPassword || "",
        sipAuthId: clean.authId || clean.username || "",
        sipDomain: clean.domain || "sip.ringcentral.com",
        sipProxy: clean.server || "",
        sipPort: clean.port || "5096",
        outboundNumber: clean.number || "",
        validated: true,
      },
    });
  }
  return NextResponse.json({ ok: true });
}
