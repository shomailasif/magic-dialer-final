import { NextRequest, NextResponse } from "next/server";
import { checkPassword, createSession } from "../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const password = body.password || "";
  if (!checkPassword(password)) return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  const token = createSession();
  const res = NextResponse.json({ ok: true });
  res.cookies.set("portal_admin", token, { httpOnly: true, path: "/", sameSite: "lax", maxAge: 86400, secure: process.env.NODE_ENV === "production" });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set("portal_admin", "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
