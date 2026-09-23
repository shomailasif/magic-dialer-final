import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, getAdminId, seedAdmins } from "../_lib";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await seedAdmins();
    return NextResponse.json({ ok: true, message: "Admin accounts seeded" });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Init failed" }, { status: 500 });
  }
}
