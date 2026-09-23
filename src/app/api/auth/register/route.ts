import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { getCurrentUser } from "@/lib/auth";

export async function POST(request: Request) {
  let body: { companyName?: string; email?: string; password?: string; createdByAdminId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const companyName = (body.companyName || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";

  if (!companyName || !email || !password) {
    return NextResponse.json(
      { error: "Company name, email, and password are required." },
      { status: 400 },
    );
  }
  if (password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters." },
      { status: 400 },
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Please enter a valid email address." }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json(
      { error: "An account with this email already exists." },
      { status: 409 },
    );
  }

  const passwordHash = await hashPassword(password);

  // Only stamp createdByAdminId if the caller is a SUPER_ADMIN, or assign to first admin.
  let createdByAdminId: string | null = null;
  try {
    const currentUser = await getCurrentUser();
    if (currentUser?.role === "SUPER_ADMIN") {
      createdByAdminId = currentUser.id;
    }
  } catch {}
  if (!createdByAdminId) {
    try {
      const firstAdmin = await prisma.portalAdmin.findFirst({ orderBy: { createdAt: "asc" } });
      if (firstAdmin) createdByAdminId = firstAdmin.id;
    } catch {}
  }

  const user = await prisma.user.create({
    data: {
      companyName,
      email,
      passwordHash,
      name: companyName,
      role: "BUSINESS_ADMIN",
      createdByAdminId: createdByAdminId || null,
    },
  });

  // New accounts start PENDING until the super admin activates them (4.5).
  await prisma.subscription.create({
    data: {
      userId: user.id,
      plan: "STARTER",
      status: "PENDING",
    },
  });

  return NextResponse.json({ ok: true, userId: user.id }, { status: 201 });
}
