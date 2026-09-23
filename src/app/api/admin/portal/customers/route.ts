import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, getAdminId } from "../_lib";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const err = await requireAdmin();
  if (err) return err;
  const adminId = await getAdminId();
  const users = await prisma.user.findMany({
    where: { createdByAdminId: adminId },
    include: { engineDevices: true, dialerConfig: true, subscription: true, agentConfig: true },
    orderBy: { createdAt: "asc" },
  });
  const customers = users.map((u) => {
    const dc = u.dialerConfig;
    const voipReady = !!(dc?.validated && dc.sipUsername && dc.sipPassword && dc.outboundNumber);
    const lastDevice = u.engineDevices.sort((a, b) => (b.lastSeenAt?.getTime() || 0) - (a.lastSeenAt?.getTime() || 0))[0];
    const status = u.activeEngineMachineId ? "online" : "offline";
    const disabled = u.subscription?.status === "SUSPENDED" || u.subscription?.status === "DEACTIVATED";
    let leadsFound: any[] = [];
    let callList: string[] = [];
    try {
      const ac = u.agentConfig as any;
      if (ac?.leadsJson) leadsFound = JSON.parse(ac.leadsJson);
      if (ac?.callListJson) callList = JSON.parse(ac.callListJson);
    } catch {}
    return {
      userId: u.id,
      product: u.agentConfig?.productName || u.companyName || "Untitled",
      persona: "",
      contactEmail: u.email,
      status: disabled ? "disabled" : status,
      lastSeen: lastDevice?.lastSeenAt?.getTime() || null,
      voipReady,
      voipShared: false,
      voip: dc ? {
        provider: dc.provider?.toLowerCase() || "",
        number: dc.outboundNumber || "",
        username: dc.sipUsername || "",
        sipPassword: "********",
        server: dc.sipProxy || "",
        port: dc.sipPort || "",
      } : null,
      callList,
      leadsFound,
      disabled,
      machineId: u.activeEngineMachineId || "",
      companyName: u.companyName || "",
      createdBy: u.createdByAdminId || "",
    };
  });
  return NextResponse.json({ customers });
}
