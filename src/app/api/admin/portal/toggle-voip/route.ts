import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, getAdminEmail, getPool } from "../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const err = await requireAdmin();
  if (err) return err;
  const adminEmail = await getAdminEmail();
  const body = await req.json().catch(() => ({}));
  const { token, voipShared, voip } = body;
  if (!token || typeof token !== "string") return NextResponse.json({ error: "Missing token" }, { status: 400 });
  if (voipShared !== undefined && typeof voipShared !== "boolean") return NextResponse.json({ error: "Invalid voipShared" }, { status: 400 });
  if (voip !== undefined && (typeof voip !== "object" || voip === null)) return NextResponse.json({ error: "Invalid voip" }, { status: 400 });
  const pool = getPool();
  try {
    const existing = await pool.query("SELECT settings, created_by FROM customers WHERE token = $1 AND portal_id = $2", [token, "main"]);
    const row = existing.rows[0];
    if (!row) return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    let settings: any = {};
    try { settings = typeof row.settings === "string" ? JSON.parse(row.settings) : (row.settings || {}); } catch { settings = {}; }
    if (voipShared !== undefined) settings.voipShared = voipShared;
    if (voip !== undefined) {
      const allowed = ["provider", "number", "username", "sipPassword", "server", "domain", "appClientId", "appClientSecret", "appJwt"];
      const clean: any = {};
      for (const k of allowed) { if (voip[k] !== undefined && voip[k] !== null) clean[k] = String(voip[k]).trim(); }
      settings.voip = clean;
      if (Object.keys(clean).length === 0) { delete settings.voip; settings.voipShared = false; }
    }
    const updates = ["settings = $1"];
    const vals: any[] = [JSON.stringify(settings)];
    let idx = 2;
    if ((!row.created_by || row.created_by === "") && adminEmail) {
      updates.push(`created_by = $${idx}`);
      vals.push(adminEmail);
      idx++;
    }
    vals.push(token);
    vals.push("main");
    await pool.query(`UPDATE customers SET ${updates.join(", ")} WHERE token = $${idx} AND portal_id = $${idx + 1}`, vals);
    return NextResponse.json({ ok: true, settings });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "DB error" }, { status: 500 });
  }
}
