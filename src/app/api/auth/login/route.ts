import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { signSession, SESSION_COOKIE_NAME, generateDeviceFingerprint, createDeviceSession } from "@/lib/auth";

export async function POST(request: Request) {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";

  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password are required." },
      { status: 400 },
    );
  }

  const user = await prisma.user.findUnique({
    where: { email },
    include: { subscription: true },
  });
  if (!user) {
    return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
  }

  // Get device info from request headers
  const userAgent = request.headers.get("user-agent") || "unknown";
  const ip = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown";
  const deviceFingerprint = generateDeviceFingerprint(userAgent, ip);

  let sessionId: string;
  try {
    sessionId = await createDeviceSession(user.id, deviceFingerprint, ip, userAgent);
  } catch (e) {
    if (e instanceof Error && e.message === "ACCOUNT_ACTIVE_ON_ANOTHER_PC") {
      return NextResponse.json({ error: "This account is already active on another PC. Log out there before signing in here." }, { status: 409 });
    }
    throw e;
  }

  const token = signSession(user.id, sessionId);
  const response = NextResponse.json({
    ok: true,
    role: user.role,
    subscriptionStatus: user.subscription?.status ?? "PENDING",
  });
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}
