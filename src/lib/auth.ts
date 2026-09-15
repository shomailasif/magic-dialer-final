import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import type { User, Subscription } from "@prisma/client";

const SESSION_COOKIE = "autodial_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

function secret(): string {
  const s = process.env.AUTH_SECRET || "dev-fallback-secret-change-me";
  return s;
}

export function signSession(userId: string): string {
  const payload = `${userId}.${Date.now()}`;
  const sig = createHmac("sha256", secret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export function verifySession(token: string): { userId: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const sig = parts[2];
  const expected = createHmac("sha256", secret()).update(payload).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  const ts = Number(parts[1]);
  if (Number.isNaN(ts)) return null;
  if (Date.now() - ts > SESSION_TTL_MS) return null;
  return { userId: parts[0] };
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;

export async function createSessionCookie(userId: string) {
  const token = signSession(userId);
  return token;
}

export type AuthUser = User & {
  subscription: (Subscription & { history?: never }) | null;
};

export async function getCurrentUser(): Promise<AuthUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const verified = verifySession(token);
  if (!verified) return null;
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
