import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, getAdminEmail, getPool } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const err = await requireAdmin();
  if (err) return err;
  const adminEmail = await getAdminEmail();
  const pool = getPool();
  try {
    const r = await pool.query(
      "SELECT token, product, persona, contact_email, status, last_seen, voip_ready, settings, call_list, leads_found, disabled, machine_id, created_by FROM customers WHERE portal_id = $1 AND (created_by = $2 OR created_by = '' OR created_by IS NULL) ORDER BY created_at ASC",
      ["main", adminEmail]
    );
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
      createdBy: c.created_by || "",
    }));
    return NextResponse.json({ customers });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "DB error" }, { status: 500 });
  }
}
