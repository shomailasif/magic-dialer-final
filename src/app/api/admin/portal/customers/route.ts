import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, getPool } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const err = await requireAdmin();
  if (err) return err;
  const pool = getPool();
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
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "DB error" }, { status: 500 });
  }
}
