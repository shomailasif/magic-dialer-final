import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/mailer";
import { runConversation, type SIPConfig, type AgentConfig } from "@/lib/sip-conversation";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  let number = String(body.number || "").replace(/[^0-9+]/g, "");
  if (number && !number.startsWith("+")) number = "+" + number;
  if (!number || number.length < 8) {
    return NextResponse.json({ error: "Enter a valid phone number (e.g. +16234001991)" }, { status: 400 });
  }

  const rcUser = process.env.RC_SIP_USERNAME || "";
  const rcPass = process.env.RC_SIP_PASSWORD || "";
  if (!rcUser || !rcPass) {
    return NextResponse.json({ error: "RingCentral SIP credentials not configured." }, { status: 500 });
  }

  try {
    const agentConfig = await prisma.aIAgentConfig.findUnique({ where: { userId: user.id } });

    const sipConfig: SIPConfig = {
      user: rcUser,
      pass: rcPass,
      authId: process.env.RC_SIP_AUTH_ID || rcUser,
      domain: process.env.RC_SIP_DOMAIN || "sip.ringcentral.com",
      proxy: process.env.RC_SIP_PROXY || "sip40.ringcentral.com",
      port: Number(process.env.RC_SIP_PORT || "5096"),
      number,
      callerId: process.env.RC_CALLER_ID || "",
    };

    const agentCfg: AgentConfig = {
      tone: agentConfig?.tone || "PROFESSIONAL",
      productName: agentConfig?.productName || undefined,
      pitch: agentConfig?.pitch || undefined,
      pricing: agentConfig?.pricing || undefined,
    };

    const result = await runConversation(sipConfig, agentCfg);

    let emailSent = false;
    let emailError: string | null = null;

    if (result.interested) {
      try {
        const now = new Date();
        const subject = `[TEST] New Interested Lead — ${number}`;
        const emailText = [
          `TEST CALL LEAD NOTIFICATION`, ``,
          `Lead Phone: ${number}`,
          `Lead Name: ${result.collectedName || "Unknown"}`,
          `Lead Company: ${result.collectedCompany || "Unknown"}`,
          `Lead Email: ${result.collectedEmail || "Unknown"}`,
          `Status: Interested`,
          `Call Duration: ${result.durationSecs}s`,
          `Call Time: ${now.toISOString()}`,
          `Agent: Sophie (Zaz Logistics)`, ``,
          result.transcript.join("\n"), ``,
          `A dispatch manager should call back within 30 minutes at 623-400-1991.`,
        ].join("\n");

        const html = [
          `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">`,
          `<h2 style="color:#0f172a">Test Call Lead Notification</h2>`,
          `<table style="border-collapse:collapse;width:100%">`,
          `<tr><td style="padding:6px 0"><strong>Phone</strong></td><td>${number}</td></tr>`,
          `<tr><td style="padding:6px 0"><strong>Name</strong></td><td>${result.collectedName || "Unknown"}</td></tr>`,
          `<tr><td style="padding:6px 0"><strong>Company</strong></td><td>${result.collectedCompany || "Unknown"}</td></tr>`,
          `<tr><td style="padding:6px 0"><strong>Email</strong></td><td>${result.collectedEmail || "Unknown"}</td></tr>`,
          `<tr><td style="padding:6px 0"><strong>Duration</strong></td><td>${result.durationSecs}s</td></tr>`,
          `</table>`,
          `<pre style="background:#f1f5f9;padding:12px;border-radius:6px;font-size:13px;white-space:pre-wrap;margin-top:12px">${result.transcript.join("\n")}</pre>`,
          `</div>`,
        ].join("\n");

        await sendNotification({ to: "onboarding@zazlogistics.com", subject, text: emailText, html });
        emailSent = true;

        await prisma.notification.create({
          data: {
            userId: user.id, toEmail: "onboarding@zazlogistics.com", subject, body: emailText,
            leadName: result.collectedName || "Test Prospect", phone: number,
            leadEmail: result.collectedEmail || "test@example.com", seats: null,
            otherData: JSON.stringify({ testCall: true, disposition: result.disposition }),
          },
        });
      } catch (e: unknown) { emailError = e instanceof Error ? e.message : "Email failed"; }
    }

    return NextResponse.json({
      ok: true, status: result.disposition,
      message: `Test call completed. Duration: ${result.durationSecs}s. ${result.interested ? "Prospect answered." : "No response."}`,
      durationSecs: result.durationSecs, connected: result.connected, interested: result.interested,
      emailSent, emailError,
      transcript: result.transcript.join("\n"),
      collectedName: result.collectedName,
      collectedCompany: result.collectedCompany,
      collectedEmail: result.collectedEmail,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: "Test call failed: " + msg }, { status: 500 });
  }
}
