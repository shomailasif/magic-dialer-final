import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { validateProvider } from "@/lib/dialer";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const current = await prisma.dialerConfig.findUnique({
    where: { userId: user.id },
  });

  const rcApiKey = process.env.RC_API_KEY || process.env.RC_ACCESS_TOKEN || "";
  const rcSid = process.env.RC_ACCOUNT_SID || "";

  const candidate = {
    provider: (body.provider as string) || current?.provider || "TWILIO",
    apiKey: body.apiKey && body.apiKey !== "••••••••" ? body.apiKey : current?.apiKey || rcApiKey,
    accountSid: body.accountSid && body.accountSid !== "••••••••" ? body.accountSid : current?.accountSid || rcSid,
    outboundNumber: (body.outboundNumber as string) || current?.outboundNumber || "",
  };

  const check = await validateProvider(candidate as never);
  if (!check.ok) {
    return NextResponse.json({ ok: false, error: check.error }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    message: `Connection successful. Your ${candidate.provider} credentials are valid.`,
  });
}
