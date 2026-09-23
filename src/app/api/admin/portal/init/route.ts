import { NextResponse } from "next/server";
import { ensureAdminsTable, seedAdmins } from "../_lib";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await ensureAdminsTable();
    await seedAdmins();
    return NextResponse.json({ ok: true, message: "Admins table created, admin1@autodial.ai and admin2@autodial.ai seeded" });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Init failed" }, { status: 500 });
  }
}
