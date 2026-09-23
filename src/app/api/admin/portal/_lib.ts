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

async function tableExists(): Promise<boolean> {
  try {
    const rows: any[] = await prisma.$queryRawUnsafe(`SELECT name FROM sqlite_master WHERE type='table' AND name='PortalAdmin' LIMIT 1`);
    return rows.length > 0;
  } catch { return false; }
}

export async function ensureInit(): Promise<void> {
  if (await tableExists()) return;
  const res = await fetch(`${process.env.VERCEL_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/admin/portal/init`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to initialize admin database");
}

export async function verifyAdmin(email: string, password: string): Promise<{ id: string } | null> {
  await ensureInit();
  const rows: any[] = await prisma.$queryRawUnsafe(`SELECT id, passwordHash, passwordSalt FROM "PortalAdmin" WHERE email = ? LIMIT 1`, email);
  if (rows.length === 0) return null;
  const row = rows[0];
  const valid = verifyPassword(password, row.passwordHash, row.passwordSalt);
  if (!valid) return null;
  return { id: row.id };
}
