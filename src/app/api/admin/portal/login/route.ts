import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const password = body.password || "";
  const expected = process.env.ADM_PASSWORD;
  if (!expected) return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  if (password !== expected) return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  const token = Buffer.from(password).toString("base64");
  const res = NextResponse.json({ ok: true });
  res.cookies.set("portal_admin", token, { httpOnly: true, path: "/", sameSite: "lax", maxAge: 86400 });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set("portal_admin", "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
