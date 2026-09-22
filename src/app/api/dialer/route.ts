import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { validateProvider } from "@/lib/dialer";
import { z } from "zod";
import type { DialerProvider } from "@prisma/client";
import { decryptSecret, encryptSecret, isMask, maskSecret } from "@/lib/credential-crypto";

const schema = z.object({
  provider: z.enum(["TWILIO", "RINGCENTRAL", "VONAGE"]),
  apiKey: z.string().optional().default(""),
  accountSid: z.string().optional().default(""),
  outboundNumber: z.string().optional().default(""),
  sipUsername: z.string().optional().default(""),
  sipPassword: z.string().nullable().optional().default(null),
  sipAuthId: z.string().optional().default(""),
  sipDomain: z.string().optional().default(""),
  sipProxy: z.string().optional().default(""),
  sipPort: z.string().optional().default(""),
});

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const config = await prisma.dialerConfig.findUnique({ where: { userId: user.id } });
  return NextResponse.json({
    config: config
      ? { ...config, apiKey: maskSecret(config.apiKey), accountSid: maskSecret(config.accountSid), sipPassword: maskSecret(config.sipPassword) }
      : null,
  });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed." }, { status: 400 });
  }
  const d = parsed.data;

  const existing = await prisma.dialerConfig.findUnique({ where: { userId: user.id } });
  let prevApiKey = "", prevSid = "", prevSipPassword = "";
  try {
    prevApiKey = decryptSecret(existing?.apiKey);
    prevSid = decryptSecret(existing?.accountSid);
    prevSipPassword = decryptSecret(existing?.sipPassword);
  } catch {
    return NextResponse.json({ error: "Stored dialer credentials cannot be decrypted. Contact the administrator." }, { status: 503 });
  }

  const apiKey = d.apiKey && !isMask(d.apiKey) ? d.apiKey : prevApiKey;
  const accountSid = d.accountSid && !isMask(d.accountSid) ? d.accountSid : prevSid;
  // null/undefined = keep existing; "" = clear; anything else = set new
  const sipPassword = d.sipPassword != null ? (isMask(d.sipPassword) ? prevSipPassword : d.sipPassword) : prevSipPassword;

  const temp = {
    provider: d.provider as DialerProvider,
    apiKey,
    accountSid,
    outboundNumber: d.outboundNumber,
    sipUsername: d.sipUsername || existing?.sipUsername || "",
    sipPassword,
  };

  const check = await validateProvider(temp as never);
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }
  if (d.provider === "RINGCENTRAL" && (!(d.sipUsername || existing?.sipUsername) || !sipPassword || !d.outboundNumber)) {
    return NextResponse.json({ error: "RingCentral local calling requires SIP username, SIP password, and outbound number." }, { status: 400 });
  }

  const config = await prisma.dialerConfig.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      provider: d.provider as DialerProvider,
      apiKey: encryptSecret(apiKey),
      accountSid: encryptSecret(accountSid),
      outboundNumber: d.outboundNumber,
      sipUsername: d.sipUsername,
      sipPassword: encryptSecret(sipPassword),
      sipAuthId: d.sipAuthId,
      sipDomain: d.sipDomain,
      sipProxy: d.sipProxy,
      sipPort: d.sipPort,
      validated: true,
    },
    update: {
      provider: d.provider as DialerProvider,
      apiKey: encryptSecret(apiKey),
      accountSid: encryptSecret(accountSid),
      outboundNumber: d.outboundNumber,
      sipUsername: d.sipUsername,
      sipPassword: encryptSecret(sipPassword),
      sipAuthId: d.sipAuthId,
      sipDomain: d.sipDomain,
      sipProxy: d.sipProxy,
      sipPort: d.sipPort,
      validated: true,
    },
  });

  return NextResponse.json({ ok: true, validated: true, config: { ...config, apiKey: maskSecret(config.apiKey), accountSid: maskSecret(config.accountSid), sipPassword: maskSecret(config.sipPassword) } });
}
