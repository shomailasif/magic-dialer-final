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
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  return pool;
}

export async function GET(req: NextRequest) {
  if (!requireAdmin(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = await getPool();
  if (!pool) return NextResponse.json({ error: "No database" }, { status: 500 });
  try {
    const r = await pool.query("SELECT token, product, persona, contact_email, status, last_seen, voip_ready, settings, call_list, leads_found, disabled, machine_id FROM customers WHERE portal_id = $1 ORDER BY created_at ASC", ["main"]);
    const customers = r.rows.map((c: any) => ({
      token: c.token,
      product: c.product || "Untitled",
      persona: c.persona || "",
      contactEmail: c.contact_email || "",
      status: c.status || "offline",
      lastSeen: c.last_seen,
      voipReady: c.voip_ready === 1,
      voipShared: !!(c.settings && typeof c.settings === "object" && c.settings.voipShared),
      voip: c.settings && typeof c.settings === "object" ? c.settings.voip || null : null,
      callList: Array.isArray(c.call_list) ? c.call_list : [],
      leadsFound: Array.isArray(c.leads_found) ? c.leads_found : [],
      disabled: c.disabled === 1,
      machineId: c.machine_id || "",
      companyName: c.settings && typeof c.settings === "object" ? c.settings.companyName || "" : "",
    }));
    return NextResponse.json({ customers });
  } finally {
    pool.end();
  }
}
