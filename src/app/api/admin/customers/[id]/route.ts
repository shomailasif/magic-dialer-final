import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { z } from "zod";

const schema = z.object({
  status: z.enum(["PENDING", "ACTIVE", "SUSPENDED", "DEACTIVATED"]).optional(),
  plan: z.enum(["FREE", "STARTER", "PRO", "ENTERPRISE"]).optional(),
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

  if (parsed.data.status) {
    upd.status = parsed.data.status;
    if (parsed.data.status === "ACTIVE" && sub?.status !== "ACTIVE") {
      upd.startedAt = new Date();
    }
  }
  if (parsed.data.plan) upd.plan = parsed.data.plan;

  if (!Object.keys(upd).length) {
    return NextResponse.json({ ok: true, message: "No changes." });
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
