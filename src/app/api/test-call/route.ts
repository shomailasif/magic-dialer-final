import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/mailer";

async function rcGetToken(): Promise<string> {
  const clientId = process.env.RC_CLIENT_ID || "";
  const clientSecret = process.env.RC_CLIENT_SECRET || "";
  const jwt = process.env.RC_JWT || "";

  if (jwt && clientId && clientSecret) {
    const basic = "Basic " + Buffer.from(clientId + ":" + clientSecret).toString("base64");
    const r = await fetch("https://platform.ringcentral.com/restapi/oauth/token", {
      method: "POST",
      headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }).toString(),
    });
    if (!r.ok) throw new Error("RC JWT token rejected: " + r.status);
    const d = await r.json();
    return d.access_token;
  }

  const sipUser = process.env.RC_SIP_USERNAME || "";
  const sipPass = process.env.RC_SIP_PASSWORD || "";
  if (sipUser && sipPass && clientId && clientSecret) {
    const basic = "Basic " + Buffer.from(clientId + ":" + clientSecret).toString("base64");
    const r = await fetch("https://platform.ringcentral.com/restapi/v1.0/oauth/token", {
      method: "POST",
      headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", username: sipUser, password: sipPass, extension: "101" }).toString(),
    });
    if (!r.ok) throw new Error("RC password token rejected: " + r.status);
    const d = await r.json();
    return d.access_token;
  }

  throw new Error("No RingCentral credentials configured (need RC_CLIENT_ID + RC_CLIENT_SECRET + RC_JWT or SIP creds)");
}

async function rcRingOut(token: string, from: string, to: string): Promise<string> {
  const r = await fetch("https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/ring-out", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      to: { phoneNumber: to },
      from: { phoneNumber: from },
      callerId: { phoneNumber: from },
      playPrompt: false,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error("RingOut rejected (HTTP " + r.status + "): " + body.substring(0, 200));
  }
  const d = await r.json();
  return d.id || (d.session && d.session.id) || "";
}

async function rcPollRingOut(token: string, ringoutId: string, maxSeconds: number): Promise<{ status: string; detail: string }> {
  const start = Date.now();
  while (Date.now() - start < maxSeconds * 1000) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const r = await fetch("https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/ring-out/" + ringoutId, {
        headers: { Authorization: "Bearer " + token },
      });
      if (!r.ok) continue;
      const d = await r.json();
      const status = d.status || {};
      const callStatus = String(status.callStatus || status.callerStatus || "").toLowerCase();
      if (/connected|completed|success/.test(callStatus)) return { status: "connected", detail: callStatus };
      if (/invalid|error|fail|denied|unavailable|no.?answer/.test(callStatus)) return { status: "error", detail: callStatus };
      if (/in.?progress|progressing|ringing|originated/.test(callStatus)) continue;
    } catch {}
  }
  return { status: "timeout", detail: "no answer after " + maxSeconds + "s" };
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const number = String(body.number || "").replace(/[^0-9+]/g, "");
  if (!number || number.length < 7) {
    return NextResponse.json({ error: "Enter a valid phone number (e.g. +16234001991)" }, { status: 400 });
  }

  try {
    const token = await rcGetToken();
    const from = process.env.RC_CALLER_ID || process.env.RC_SIP_USERNAME || "";

    const agentConfig = await prisma.aIAgentConfig.findUnique({ where: { userId: user.id } });
    const script = agentConfig
      ? [
          agentConfig.tone === "FRIENDLY" ? "Hi there, thanks for answering." : agentConfig.tone === "DIRECT" ? "Good day, thank you for taking my call." : "Hello, thanks for picking up.",
          `This is Sophie from Zaz Logistics.`,
          agentConfig.pitch?.trim() || `I'm reaching out because we provide ${agentConfig.productName || "our service"}.`,
          agentConfig.pricing ? `Our pricing starts at ${agentConfig.pricing}.` : "",
          "I just need a couple of details so I can help you quickly.",
          "Could you share your name?",
          "And what company are you with?",
          "And the best email to reach you at?",
          "Perfect, that is everything I need. Thank you so much.",
          "One of our dispatch managers will give you a call back within 30 minutes at 623-400-1991 to discuss your needs further. Have a great day!",
        ].filter(Boolean).join(" ")
      : "Hello, this is Sophie from Zaz Logistics. I'm calling to follow up on your onboarding. Is there anything I can help you with? Have a great day!";

    const ringoutId = await rcRingOut(token, from, number);
    const result = await rcPollRingOut(token, ringoutId, 30);

    const connected = result.status === "connected";
    const interested = connected;
    const disposition = interested ? "INTERESTED" : result.status === "timeout" ? "NO_ANSWER" : "FAILED";

    let emailSent = false;
    let emailError: string | null = null;
    if (interested) {
      try {
        const now = new Date();
        const emailSubject = `[TEST] New Interested Lead — ${number}`;
        const emailText = [
          `TEST CALL LEAD NOTIFICATION`,
          ``,
          `This is a test call result from the dashboard.`,
          ``,
          `Lead Phone: ${number}`,
          `Lead Name: Test Prospect`,
          `Status: Interested`,
          `Call Time: ${now.toISOString()}`,
          `Agent: Sophie (Zaz Logistics)`,
          `Disposition: ${disposition}`,
          ``,
          `Script played:`,
          script.substring(0, 500),
          ``,
          `A dispatch manager should call back within 30 minutes at 623-400-1991.`,
        ].join("\n");

        const emailHtml = [
          `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">`,
          `<h2 style="color:#0f172a">Test Call Lead Notification</h2>`,
          `<p>This is a test call result from the dashboard.</p>`,
          `<table style="border-collapse:collapse;width:100%">`,
          `<tr><td style="padding:6px 0"><strong>Lead Phone</strong></td><td>${number}</td></tr>`,
          `<tr><td style="padding:6px 0"><strong>Lead Name</strong></td><td>Test Prospect</td></tr>`,
          `<tr><td style="padding:6px 0"><strong>Status</strong></td><td>Interested</td></tr>`,
          `<tr><td style="padding:6px 0"><strong>Call Time</strong></td><td>${now.toISOString()}</td></tr>`,
          `<tr><td style="padding:6px 0"><strong>Agent</strong></td><td>Sophie (Zaz Logistics)</td></tr>`,
          `</table>`,
          `<p style="margin-top:16px;color:#64748b">A dispatch manager should call back within 30 minutes at 623-400-1991.</p>`,
          `</div>`,
        ].join("\n");

        await sendNotification({ to: "onboarding@zazlogistics.com", subject: emailSubject, text: emailText, html: emailHtml });
        await prisma.notification.create({
          data: {
            userId: user.id,
            toEmail: "onboarding@zazlogistics.com",
            subject: emailSubject,
            body: emailText,
            leadName: "Test Prospect",
            phone: number,
            leadEmail: "test@example.com",
            seats: null,
            otherData: JSON.stringify({ testCall: true, disposition }),
          },
        });
        emailSent = true;
      } catch (e: unknown) {
        emailError = e instanceof Error ? e.message : "Email failed";
      }
    }

    return NextResponse.json({
      ok: true,
      status: disposition,
      message: `Test call to ${number}: ${result.detail}. ${interested ? "Email sent to onboarding." : ""}`,
      script: script.substring(0, 200) + "...",
      ringoutId,
      emailSent,
      emailError,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: "Test call failed: " + msg }, { status: 500 });
  }
}
