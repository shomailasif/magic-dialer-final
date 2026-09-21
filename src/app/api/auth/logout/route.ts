import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySession } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function POST(request: Request) {
  // Try to delete device session
  try {
    const cookieHeader = request.headers.get("cookie") || "";
    const sessionMatch = cookieHeader.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
    if (sessionMatch) {
      const token = sessionMatch[1];
      const verified = verifySession(token);
      if (verified) {
        if (verified.sessionId) {
          await prisma.session.deleteMany({ where: { id: verified.sessionId, userId: verified.userId } });
        }
      }
    }
  } catch {
    // Ignore errors during cleanup
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    path: "/",
    maxAge: 0,
  });
  return response;
}
