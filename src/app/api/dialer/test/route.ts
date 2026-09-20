import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { validateProvider } from "@/lib/dialer";
import { decryptSecret, isMask } from "@/lib/credential-crypto";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const current = await prisma.dialerConfig.findUnique({
    where: { userId: user.id },
  });

  const rcApiKey = process.env.RC_API_KEY || process.env.RC_ACCESS_TOKEN || "";
  const rcSid = process.env.RC_ACCOUNT_SID || "";

  let storedApiKey="", storedSid="", storedSipPassword="";
  try { storedApiKey=decryptSecret(current?.apiKey); storedSid=decryptSecret(current?.accountSid); storedSipPassword=decryptSecret(current?.sipPassword); }
  catch { return NextResponse.json({ ok:false, error:"Stored dialer credentials cannot be decrypted." }, { status:503 }); }

  const candidate = {
    provider: (body.provider as string) || current?.provider || "TWILIO",
    apiKey: body.apiKey && !isMask(body.apiKey) ? body.apiKey : storedApiKey || rcApiKey,
    accountSid: body.accountSid && !isMask(body.accountSid) ? body.accountSid : storedSid || rcSid,
    outboundNumber: (body.outboundNumber as string) || current?.outboundNumber || "",
    sipUsername: (body.sipUsername as string) || current?.sipUsername || "",
    sipPassword: body.sipPassword && !isMask(body.sipPassword) ? body.sipPassword : storedSipPassword,
  };

  const check = await validateProvider(candidate as never);
  if (candidate.provider === "RINGCENTRAL" && (!candidate.sipUsername || !candidate.sipPassword || !candidate.outboundNumber)) {
    return NextResponse.json({ ok: false, error: "RingCentral local calling requires SIP username, SIP password, and outbound number." }, { status: 400 });
  }
  if (!check.ok) {
    return NextResponse.json({ ok: false, error: check.error }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    message: `Configuration is complete for ${candidate.provider}. Live SIP registration is verified by the enrolled local engine before calling.`,
  });
}
