import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function requireAdmin(req: NextRequest) {
  const cookie = req.headers.get("cookie") || "";
  const m = cookie.match(/portal_admin=([^;]+)/);
  if (!m) return false;
  try {
    const decoded = Buffer.from(m[1], "base64").toString();
    return decoded === process.env.ADM_PASSWORD;
  } catch {
    return false;
  }
}

async function getPool() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const { Pool } = await import("pg");
  return new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
}

export async function POST(req: NextRequest) {
  if (!requireAdmin(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const { token, voipShared, voip } = body;
  if (!token) return NextResponse.json({ error: "Missing token" }, { status: 400 });
  const pool = await getPool();
  if (!pool) return NextResponse.json({ error: "No database" }, { status: 500 });
  try {
    const existing = await pool.query("SELECT settings FROM customers WHERE token = $1 AND portal_id = $2", [token, "main"]);
    const row = existing.rows[0];
    if (!row) return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    let settings: any = {};
    try { settings = typeof row.settings === "string" ? JSON.parse(row.settings) : (row.settings || {}); } catch { settings = {}; }
    if (voipShared !== undefined) settings.voipShared = !!voipShared;
    if (voip !== undefined) settings.voip = voip;
    await pool.query("UPDATE customers SET settings = $1 WHERE token = $2 AND portal_id = $3", [JSON.stringify(settings), token, "main"]);
    return NextResponse.json({ ok: true, settings });
  } finally {
    pool.end();
  }
}
