import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySession, deleteDeviceSession, generateDeviceFingerprint } from "@/lib/auth";

export async function POST(request: Request) {
  // Try to delete device session
  try {
    const cookieHeader = request.headers.get("cookie") || "";
    const sessionMatch = cookieHeader.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
    if (sessionMatch) {
      const token = sessionMatch[1];
      const verified = verifySession(token);
      if (verified) {
        const userAgent = request.headers.get("user-agent") || "unknown";
        const ip = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown";
        const deviceFingerprint = generateDeviceFingerprint(userAgent, ip);
        await deleteDeviceSession(verified.userId, deviceFingerprint);
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
