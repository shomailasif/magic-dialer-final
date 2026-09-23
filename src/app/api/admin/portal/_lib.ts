import { cookies } from "next/headers";
import crypto from "crypto";
import { prisma } from "@/lib/db";

function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const h = crypto.scryptSync(password, s, 64).toString("hex");
  return { hash: h, salt: s };
}

export function verifyPassword(password: string, storedHash: string, storedSalt: string): boolean {
  const { hash } = hashPassword(password, storedSalt);
  const a = Buffer.from(hash);
  const b = Buffer.from(storedHash);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

interface AdminSession {
  email: string;
  adminId: string;
  createdAt: number;
}

const sessions = new Map<string, AdminSession>();
const SESSION_TTL = 24 * 60 * 60 * 1000;

export function createSession(email: string, adminId: string): string {
  const token = crypto.randomUUID();
  sessions.set(token, { email, adminId, createdAt: Date.now() });
  return token;
}

export function getSession(token: string): AdminSession | null {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL) { sessions.delete(token); return null; }
  return s;
}

export async function requireAdmin(): Promise<Response | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get("portal_admin")?.value;
  if (!token) return unauthorized();
  const session = getSession(token);
  if (!session) return unauthorized();
  return null;
}

export async function getAdminId(): Promise<string> {
  const cookieStore = await cookies();
  const token = cookieStore.get("portal_admin")?.value || "";
  const session = getSession(token);
  return session?.adminId || "";
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
}

export async function seedAdmins(): Promise<void> {
  const admins = [
    { email: "admin1@autodial.ai", password: "Admin1Pass!", name: "Admin 1" },
    { email: "admin2@autodial.ai", password: "Admin2Pass!", name: "Admin 2" },
  ];
  for (const a of admins) {
    const existing = await prisma.portalAdmin.findUnique({ where: { email: a.email } });
    if (!existing) {
      const { hash, salt } = hashPassword(a.password);
      await prisma.portalAdmin.create({ data: { email: a.email, passwordHash: hash, passwordSalt: salt, displayName: a.name } });
    }
  }
}

export async function verifyAdmin(email: string, password: string): Promise<{ id: string } | null> {
  const admin = await prisma.portalAdmin.findUnique({ where: { email } });
  if (!admin) return null;
  const valid = verifyPassword(password, admin.passwordHash, admin.passwordSalt);
  if (!valid) return null;
  return { id: admin.id };
}
