import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, getAdminId } from "../_lib";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/password";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const err = await requireAdmin();
  if (err) return err;
  const adminId = await getAdminId();
  const body = await req.json().catch(() => ({}));
  const companyName = (body.companyName || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  if (!companyName || !email || !password) return NextResponse.json({ error: "Company name, email, and password required" }, { status: 400 });
  if (password.length < 8) return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return NextResponse.json({ error: "Email already exists" }, { status: 409 });
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      companyName,
      email,
      passwordHash,
      name: companyName,
      role: "BUSINESS_ADMIN",
      createdByAdminId: adminId,
    },
  });
  await prisma.subscription.create({
    data: { userId: user.id, plan: "STARTER", status: "PENDING" },
  });
  return NextResponse.json({ ok: true, userId: user.id, email: user.email });
}
