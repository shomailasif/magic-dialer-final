import { cookies } from "next/headers";
import crypto from "crypto";
import { Pool } from "pg";

const EXPECTED_PW = process.env.ADM_PASSWORD || "MagicDialer2026!";

let pgPool: Pool | null = null;
export function getPool(): Pool {
  if (pgPool) return pgPool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  pgPool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  return pgPool;
}

const sessions = new Map<string, number>();
const SESSION_TTL = 24 * 60 * 60 * 1000;

export function createSession(): string {
  const token = crypto.randomUUID();
  sessions.set(token, Date.now());
  return token;
}

export function validateSession(token: string): boolean {
  const created = sessions.get(token);
  if (!created) return false;
  if (Date.now() - created > SESSION_TTL) { sessions.delete(token); return false; }
  return true;
}

export async function requireAdmin(): Promise<Response | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get("portal_admin")?.value;
  if (!token || !validateSession(token)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  }
  return null;
}

export function checkPassword(password: string): boolean {
  if (!password || typeof password !== "string") return false;
  const a = Buffer.from(password);
  const b = Buffer.from(EXPECTED_PW);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
