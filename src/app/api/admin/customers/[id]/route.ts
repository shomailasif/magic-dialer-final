import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { isSharedRcEmail } from "@/lib/constants";
import { z } from "zod";

const schema = z.object({
  status: z.enum(["PENDING", "ACTIVE", "SUSPENDED", "DEACTIVATED"]).optional(),
  plan: z.enum(["FREE", "STARTER", "PRO", "ENTERPRISE"]).optional(),
  voipShared: z.boolean().optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid fields." }, { status: 400 });
  }

  const target = await prisma.user.findFirst({
    where: { id, role: "BUSINESS_ADMIN", createdByAdminId: admin.id },
    include: { subscription: true },
  });
  if (!target) return NextResponse.json({ error: "Business account not found." }, { status: 404 });

  const sub = target.subscription;
  const upd: { status?: string; plan?: string; startedAt?: Date; notes?: string } = {};
  let voipTouched = false;

  if (parsed.data.status) {
    upd.status = parsed.data.status;
    if (parsed.data.status === "ACTIVE" && sub?.status !== "ACTIVE") {
      upd.startedAt = new Date();
    }
  }
  if (parsed.data.plan) upd.plan = parsed.data.plan;

  if (parsed.data.voipShared !== undefined) {
    if (parsed.data.voipShared && !isSharedRcEmail(target.email)) {
      return NextResponse.json({ error: "Shared RingCentral is only available for the designated accounts." }, { status: 403 });
    }
    voipTouched = true;
    try {
      await prisma.$executeRawUnsafe(`UPDATE "DialerConfig" SET "voipShared" = ? WHERE "userId" = ?`, parsed.data.voipShared ? 1 : 0, id);
    } catch {}
    if (parsed.data.voipShared) {
      const settings: any[] = await prisma.$queryRawUnsafe(`SELECT "rcSipUsername","rcSipPassword","rcSipAuthId","rcSipDomain","rcSipProxy","rcSipPort","rcCallerId" FROM "PlatformSetting" WHERE id = 'platform' LIMIT 1`);
      const ps = settings[0];
      if (ps && ps.rcSipUsername && ps.rcSipPassword) {
        await prisma.dialerConfig.upsert({
          where: { userId: id },
          create: {
            userId: id, provider: "RINGCENTRAL",
            sipUsername: ps.rcSipUsername, sipPassword: ps.rcSipPassword,
            sipAuthId: ps.rcSipAuthId || ps.rcSipUsername, sipDomain: ps.rcSipDomain || "sip.ringcentral.com",
            sipProxy: ps.rcSipProxy || "sip40.ringcentral.com", sipPort: ps.rcSipPort || "5096",
            outboundNumber: ps.rcCallerId || ps.rcSipUsername, validated: true,
          },
          update: {
            provider: "RINGCENTRAL",
            sipUsername: ps.rcSipUsername, sipPassword: ps.rcSipPassword,
            sipAuthId: ps.rcSipAuthId || ps.rcSipUsername, sipDomain: ps.rcSipDomain || "sip.ringcentral.com",
            sipProxy: ps.rcSipProxy || "sip40.ringcentral.com", sipPort: ps.rcSipPort || "5096",
            outboundNumber: ps.rcCallerId || ps.rcSipUsername, validated: true,
          },
        });
      }
    }
  }

  if (!Object.keys(upd).length) {
    return NextResponse.json({ ok: true, message: voipTouched ? "VOIP sharing updated." : "No changes." });
  }

  if (sub) {
    await prisma.$transaction([
      prisma.subscription.update({ where: { id: sub.id }, data: upd as never }),
      prisma.subscriptionHistory.create({
        data: {
          subId: sub.id,
          plan: parsed.data.plan || sub.plan,
          status: parsed.data.status || sub.status,
        },
      }),
    ]);
  } else {
    await prisma.subscription.create({
      data: {
        userId: id,
        plan: parsed.data.plan || "STARTER",
        status: parsed.data.status || "PENDING",
        startedAt: parsed.data.status === "ACTIVE" ? new Date() : null,
      },
    });
    if (parsed.data.plan || parsed.data.status) {
      const newSub = await prisma.subscription.findUnique({ where: { userId: id } });
      if (newSub) {
        await prisma.subscriptionHistory.create({
          data: {
            subId: newSub.id,
            plan: parsed.data.plan || "STARTER",
            status: parsed.data.status || "PENDING",
          },
        });
      }
    }
  }

  return NextResponse.json({ ok: true });
}
