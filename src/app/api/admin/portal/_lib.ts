import { cookies } from "next/headers";
import crypto from "crypto";
import { Pool } from "pg";

let pgPool: Pool | null = null;
export function getPool(): Pool {
  if (pgPool) return pgPool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  pgPool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  return pgPool;
}

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
  createdAt: number;
}

const sessions = new Map<string, AdminSession>();
const SESSION_TTL = 24 * 60 * 60 * 1000;

export function createSession(email: string): string {
  const token = crypto.randomUUID();
  sessions.set(token, { email, createdAt: Date.now() });
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

export async function getAdminEmail(): Promise<string> {
  const cookieStore = await cookies();
  const token = cookieStore.get("portal_admin")?.value || "";
  const session = getSession(token);
  return session?.email || "";
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
}

export async function ensureAdminsTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      email TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      display_name TEXT DEFAULT '',
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)
    )
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS created_by TEXT DEFAULT '';
    EXCEPTION WHEN duplicate_column THEN null;
    END $$;
  `);
}

export async function seedAdmins(): Promise<void> {
  const pool = getPool();
  const admins = [
    { email: "admin1@autodial.ai", password: "Admin1Pass!", name: "Admin 1" },
    { email: "admin2@autodial.ai", password: "Admin2Pass!", name: "Admin 2" },
  ];
  for (const a of admins) {
    const existing = await pool.query("SELECT email FROM admins WHERE email = $1", [a.email]);
    if (existing.rows.length === 0) {
      const { hash, salt } = hashPassword(a.password);
      await pool.query("INSERT INTO admins (email, password_hash, password_salt, display_name) VALUES ($1, $2, $3, $4)", [a.email, hash, salt, a.name]);
    }
  }
}

export async function verifyAdmin(email: string, password: string): Promise<boolean> {
  const pool = getPool();
  const r = await pool.query("SELECT password_hash, password_salt FROM admins WHERE email = $1", [email]);
  if (r.rows.length === 0) return false;
  const row = r.rows[0];
  return verifyPassword(password, row.password_hash, row.password_salt);
}
