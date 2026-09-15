import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/mailer";

// Hide from Turbopack static analysis - native CJS modules only run at runtime.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const runtimeRequire = new Function("m", "return require(m)") as NodeRequire;

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const number = String(body.number || "").replace(/[^0-9+]/g, "");
  if (!number || number.length < 7) {
    return NextResponse.json({ error: "Enter a valid phone number (e.g. +16234001991)" }, { status: 400 });
  }

  const rcUser = process.env.RC_SIP_USERNAME;
  const rcPass = process.env.RC_SIP_PASSWORD;
  const rcAuthId = process.env.RC_SIP_AUTH_ID || rcUser;
  const rcCallerId = process.env.RC_CALLER_ID || process.env.RC_PHONE || "";
  const rcDomain = process.env.RC_SIP_DOMAIN || "sip.ringcentral.com";
  const rcProxy = process.env.RC_SIP_PROXY || "sip40.ringcentral.com";
  const rcPort = process.env.RC_SIP_PORT || "5096";

  if (!rcUser || !rcPass) {
    return NextResponse.json({ error: "RingCentral SIP credentials not configured." }, { status: 500 });
  }

  try {
    const sipCallBridge = runtimeRequire("../../../management/portal/softphone").sipCallBridge;
    const textToFrames = runtimeRequire("../../../management/portal/audio").textToFrames;

    // Build the actual sales script from the AI agent config
    const agentConfig = await prisma.aIAgentConfig.findUnique({ where: { userId: user.id } });

    let script: string;
    if (agentConfig) {
      const toneIntro = agentConfig.tone === "FRIENDLY"
        ? "Hi there, thanks for answering."
        : agentConfig.tone === "DIRECT"
          ? "Good day, thank you for taking my call."
          : "Hello, thanks for picking up.";

      const pitch = agentConfig.pitch?.trim() || `I'm reaching out because we provide ${agentConfig.productName || "our service"}.`;

      script = [
        `${toneIntro} This is Sophie from Zaz Logistics.`,
        pitch,
        agentConfig.pricing ? `Our pricing starts at ${agentConfig.pricing}.` : "",
        "I just need a couple of details so I can help you quickly.",
        "Could you share your name?",
        "And what company are you with?",
        "And the best email to reach you at?",
        "Perfect, that is everything I need. Thank you so much.",
        "One of our dispatch managers will give you a call back within 30 minutes at 623-400-1991 to discuss your needs further. Have a great day!",
      ].filter(Boolean).join(" ");
    } else {
      script = "Hello, this is Sophie from Zaz Logistics. I'm calling to follow up on your onboarding. We noticed you started the process but haven't completed it yet. Is there anything I can help you with? Could you share your name? And what company are you with? And the best email to reach you at? Perfect, that is everything I need. Thank you so much. One of our dispatch managers will give you a call back within 30 minutes at 623-400-1991 to discuss your needs further. Have a great day!";
    }

    // Place the bidirectional SIP call
    const callResult = await sipCallBridge({
      user: rcUser,
      pass: rcPass,
      authId: rcAuthId,
      domain: rcDomain,
      proxy: rcProxy,
      port: Number(rcPort),
      number: number,
      callerId: rcCallerId,
    });

    if (!callResult.ok) {
      return NextResponse.json({
        ok: false,
        error: callResult.last || "Call failed to connect",
        steps: callResult.steps,
      }, { status: 400 });
    }

    const cs = callResult.callSession;
    const cleanup = callResult.cleanup;
    const startTime = Date.now();
    let heardAnyAudio = false;

    cs.on("audioPacket", () => { heardAnyAudio = true; });

    // Generate TTS and stream it
    const frames = await textToFrames(script);
    if (frames.length > 0) {
      cs.streamAudio(Buffer.concat(frames));
    }

    // Wait for call to finish: script plays, listen for response, then end
    const scriptDuration = Math.max(5000, frames.length * 20);
    const maxCallDuration = 45000;

    await new Promise<void>((resolve) => {
      const scriptTimer = setTimeout(() => {
        const listenStart = Date.now();
        const listenTimer = setInterval(() => {
          const elapsed = Date.now() - listenStart;
          if (elapsed > 8000 || Date.now() - startTime > maxCallDuration) {
            clearInterval(listenTimer);
            clearTimeout(watchdog);
            resolve();
          }
        }, 1000);
      }, scriptDuration);

      const watchdog = setTimeout(() => {
        clearTimeout(scriptTimer);
        resolve();
      }, maxCallDuration);
    });

    const durationSecs = Math.round((Date.now() - startTime) / 1000);
    try { cs.hangup(); } catch {}
    setTimeout(() => { cleanup(); }, 500);

    // Determine call outcome
    const connected = durationSecs > 5;
    const interested = connected && heardAnyAudio;
    const disposition = interested ? "INTERESTED" : connected ? "NO_RESPONSE" : "NO_ANSWER";

    // If qualified (answered + spoke), send test email to onboarding
    let emailSent = false;
    let emailError: string | null = null;
    if (interested) {
      try {
        const now = new Date();
        const subject = `[TEST] New Interested Lead — ${number}`;
        const text = [
          `TEST CALL LEAD NOTIFICATION`,
          ``,
          `This is a test call result from the dashboard.`,
          ``,
          `Lead Phone: ${number}`,
          `Lead Name: Test Prospect`,
          `Status: Interested`,
          `Call Duration: ${durationSecs}s`,
          `Call Time: ${now.toISOString()}`,
          `Agent: Sophie (Zaz Logistics)`,
          `Disposition: ${disposition}`,
          ``,
          `A dispatch manager should call back within 30 minutes at 623-400-1991.`,
        ].join("\n");

        const html = [
          `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">`,
          `<h2 style="color:#0f172a">Test Call Lead Notification</h2>`,
          `<p>This is a test call result from the dashboard.</p>`,
          `<table style="border-collapse:collapse;width:100%">`,
          `<tr><td style="padding:6px 0"><strong>Lead Phone</strong></td><td>${number}</td></tr>`,
          `<tr><td style="padding:6px 0"><strong>Lead Name</strong></td><td>Test Prospect</td></tr>`,
          `<tr><td style="padding:6px 0"><strong>Status</strong></td><td>Interested</td></tr>`,
          `<tr><td style="padding:6px 0"><strong>Call Duration</strong></td><td>${durationSecs}s</td></tr>`,
          `<tr><td style="padding:6px 0"><strong>Call Time</strong></td><td>${now.toISOString()}</td></tr>`,
          `<tr><td style="padding:6px 0"><strong>Agent</strong></td><td>Sophie (Zaz Logistics)</td></tr>`,
          `</table>`,
          `<p style="margin-top:16px;color:#64748b">A dispatch manager should call back within 30 minutes at 623-400-1991.</p>`,
          `</div>`,
        ].join("\n");

        await sendNotification({
          to: "onboarding@zazlogistics.com",
          subject,
          text,
          html,
        });
        emailSent = true;

        // Also create a notification record
        await prisma.notification.create({
          data: {
            userId: user.id,
            toEmail: "onboarding@zazlogistics.com",
            subject,
            body: text,
            leadName: "Test Prospect",
            phone: number,
            leadEmail: "test@example.com",
            seats: null,
            otherData: JSON.stringify({ testCall: true, disposition }),
          },
        });
      } catch (e: unknown) {
        emailError = e instanceof Error ? e.message : "Email failed";
      }
    }

    return NextResponse.json({
      ok: true,
      status: disposition,
      message: `Test call completed. Duration: ${durationSecs}s. ${interested ? "Prospect answered and spoke — email sent to onboarding." : "No response."}`,
      script: script.substring(0, 200) + "...",
      durationSecs,
      connected,
      interested,
      emailSent,
      emailError,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: "Test call failed: " + msg }, { status: 500 });
  }
}
