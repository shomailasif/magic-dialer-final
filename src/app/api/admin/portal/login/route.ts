import { NextRequest, NextResponse } from "next/server";
import { createSession, verifyAdmin } from "../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  if (!email || !password) return NextResponse.json({ error: "Email and password required" }, { status: 400 });
  const valid = await verifyAdmin(email, password);
  if (!valid) return NextResponse.json({ error: "Wrong email or password" }, { status: 401 });
  const token = createSession(email);
  const res = NextResponse.json({ ok: true, email });
  res.cookies.set("portal_admin", token, { httpOnly: true, path: "/", sameSite: "lax", maxAge: 86400, secure: process.env.NODE_ENV === "production" });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set("portal_admin", "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
