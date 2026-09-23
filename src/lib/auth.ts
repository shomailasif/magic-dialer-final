import { createHash, createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import type { User, Subscription } from "@prisma/client";

const SESSION_COOKIE = "autodial_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // maximum session lifetime

function secret(): string {
  const configured = process.env.AUTH_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET is required in production");
  }
  return "dev-fallback-secret-change-me";
}

export function signSession(userId: string, sessionId = ""): string {
  const payload = `${userId}.${Date.now()}.${sessionId}`;
  const sig = createHmac("sha256", secret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export function verifySession(token: string): { userId: string; sessionId: string } | null {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const payload = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const sig = parts[3];
  const expected = createHmac("sha256", secret()).update(payload).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  const ts = Number(parts[1]);
  if (Number.isNaN(ts)) return null;
  const now = Date.now();
  if (now - ts > SESSION_TTL_MS) return null;
  if (ts - now > 60_000) return null; // reject tokens with future timestamps (clock skew tolerance 60s)
  return { userId: parts[0], sessionId: parts[2] };
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;

export async function createSessionCookie(userId: string) {
  const token = signSession(userId);
  return token;
}

export type AuthUser = User & {
  subscription: (Subscription & { history?: never }) | null;
};

/**
 * Generate a device fingerprint from request headers
 */
export function generateDeviceFingerprint(userAgent: string, ip: string): string {
  return createHash("sha256").update(`${userAgent}:${ip}`).digest("hex").slice(0, 32);
}

/**
 * Create a new session and invalidate any existing sessions for this user
 */
export async function createDeviceSession(
  userId: string,
  deviceFingerprint: string,
  ipAddress: string,
  userAgent: string
): Promise<string> {
  const now = new Date();
  await prisma.session.deleteMany({ where: { userId, expiresAt: { lte: now } } });
  const active = await prisma.session.findFirst({
    where: { userId, expiresAt: { gt: now } },
    orderBy: { lastActiveAt: "desc" },
  });
  // Same device: reuse and touch its session. Any other device presenting valid
  // credentials takes over — customers can log in and connect a new PC anytime.
  if (active && active.deviceFingerprint === deviceFingerprint) {
    await prisma.session.update({ where: { id: active.id }, data: { lastActiveAt: now } });
    return active.id;
  }

  await prisma.session.deleteMany({ where: { userId } });

  const session = await prisma.session.create({
    data: {
      userId,
      deviceFingerprint,
      ipAddress,
      userAgent,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  return session.id;
}

/**
 * Check if a session is active for this device
 */
export async function isSessionActive(
  userId: string,
  deviceFingerprint: string
): Promise<boolean> {
  const session = await prisma.session.findFirst({
    where: {
      userId,
      deviceFingerprint,
      expiresAt: { gt: new Date() },
    },
  });
  return !!session;
}

/**
 * Delete a session (for logout)
 */
export async function deleteDeviceSession(
  userId: string,
  deviceFingerprint: string
): Promise<void> {
  await prisma.session.deleteMany({
    where: {
      userId,
      deviceFingerprint,
    },
  });
}

/**
 * Touch session to keep it alive
 */
export async function touchSession(
  userId: string,
  deviceFingerprint: string
): Promise<void> {
  await prisma.session.updateMany({
    where: {
      userId,
      deviceFingerprint,
    },
    data: {
      lastActiveAt: new Date(),
    },
  });
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const verified = verifySession(token);
  if (!verified) return null;
  if (!verified.sessionId) return null;
  const now = new Date();
  const active = await prisma.session.findFirst({ where: { id: verified.sessionId, userId: verified.userId, expiresAt: { gt: now } } });
  if (!active) return null;
  // Authenticated activity renews the device lease. This keeps a genuinely active PC locked
  // while still allowing abandoned/crashed sessions to recover after DEVICE_LOCK_MS.
  if (now.getTime() - active.lastActiveAt.getTime() > 60_000) {
    await prisma.session.update({ where: { id: active.id }, data: { lastActiveAt: now } });
  }
  const user = await prisma.user.findUnique({
    where: { id: verified.userId },
    include: { subscription: true },
  });
  return user as AuthUser | null;
}

export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) {
    const jar = await cookies();
    const locale = jar.get("NEXT_LOCALE")?.value || "en";
    redirect(`/${locale}/login`);
  }
  return user;
}

export async function requireAdmin(): Promise<AuthUser> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") {
    const jar = await cookies();
    const locale = jar.get("NEXT_LOCALE")?.value || "en";
    redirect(`/${locale}/dashboard`);
  }
  return user;
}

/** Return the admin ID of the currently logged-in super admin. */
export async function getAdminId(): Promise<string> {
  const admin = await requireAdmin();
  return admin.id;
}

export function isSubscriptionActive(user: AuthUser): boolean {
  return user.subscription?.status === "ACTIVE";
}
