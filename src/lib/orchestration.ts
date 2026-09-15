import { prisma } from "@/lib/db";
import { placeCall, validateProvider } from "@/lib/dialer";
import { runAIagent, recordLearning, detectLeadLanguage } from "@/lib/ai-agent";
import { deliverOutcomeNotification } from "@/lib/notifications";
import { makeSIPCall } from "@/lib/sip-caller";
import type { SubscriptionStatus } from "@prisma/client";

/**
 * Execute a campaign run for a business admin.
 *
 * Steps:
 *  1. Confirm the tenant's subscription is ACTIVE (4.5 access control).
 *  2. Confirm the dialer is validated (invalid creds block calls).
 *  3. Pull due leads (pending or past follow-up date).
 *  4. For each: place the call, run the AI agent, update the lead,
 *     schedule follow-up, and trigger outcome notifications for
 *     interested/converted leads.
 *
 * Returns stats about the run.
 */
export async function runCampaign(userId: string, limit = 20, locale = "en") {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { subscription: true, dialerConfig: true, agentConfig: true },
  });
  if (!user) return { ok: false as const, error: "User not found" };

  if (user.subscription?.status !== "ACTIVE") {
    return {
      ok: false as const,
      error:
        "Subscription must be active to initiate calls. Contact the platform admin.",
    };
  }

  if (!user.dialerConfig) {
    if (process.env.RC_SIP_USERNAME && process.env.RC_SIP_PASSWORD) {
      // Shared RC SIP credentials from env — all users can dial
    } else {
      return { ok: false as const, error: "Dialer integration not configured." };
    }
  }
  if (user.dialerConfig) {
    const dialValid = await validateProvider(user.dialerConfig);
    if (!dialValid.ok) {
      return { ok: false as const, error: dialValid.error as string };
    }
  }

  const dueLeads = await prisma.lead.findMany({
    where: {
      userId,
      AND: [
        { OR: [{ status: "PENDING" }, { status: "FAILED" }] },
        { OR: [{ followUpDueAt: null }, { followUpDueAt: { lte: new Date() } }] },
      ],
    },
    take: limit,
    orderBy: { createdAt: "asc" },
  });

  let callsMade = 0;
  let interested = 0;
  let converted = 0;

  const campaign = await prisma.callCampaign.create({
    data: { userId, name: `Campaign ${new Date().toISOString().slice(0, 16)}` },
  });

  const hasSIP = !!(process.env.RC_SIP_USERNAME && process.env.RC_SIP_PASSWORD);

  for (const lead of dueLeads) {
    let aiResult = null as Awaited<ReturnType<typeof runAIagent>> | null;
    let sipResult = null as Awaited<ReturnType<typeof makeSIPCall>> | null;
    let dialResult: { connected: boolean; outcome: "CONNECTED" | "NO_ANSWER" | "BUSY" | "UNREACHABLE" | "FAILED"; durationSecs: number } = { connected: false, outcome: "FAILED", durationSecs: 0 };

    if (hasSIP && lead.phone) {
      try {
        sipResult = await makeSIPCall(
          {
            user: process.env.RC_SIP_USERNAME || "",
            pass: process.env.RC_SIP_PASSWORD || "",
            authId: process.env.RC_SIP_AUTH_ID || process.env.RC_SIP_USERNAME || "",
            domain: process.env.RC_SIP_DOMAIN || "sip.ringcentral.com",
            proxy: process.env.RC_SIP_PROXY || "sip40.ringcentral.com",
            port: Number(process.env.RC_SIP_PORT || "5096"),
            number: lead.phone,
            callerId: process.env.RC_CALLER_ID || "",
          },
          {
            tone: user.agentConfig?.tone || "PROFESSIONAL",
            productName: user.agentConfig?.productName || "",
            pitch: user.agentConfig?.pitch || "",
            pricing: user.agentConfig?.pricing || undefined,
          },
        );
        dialResult = {
          connected: sipResult.connected,
          outcome: sipResult.connected ? "CONNECTED" : "NO_ANSWER",
          durationSecs: sipResult.durationSecs,
        };
      } catch (e) {
        console.error("[campaign] SIP call failed, falling back to RingOut:", e);
        sipResult = null;
      }
    }

    if (!sipResult) {
      dialResult = await placeCall({
        from: user.dialerConfig?.outboundNumber || process.env.RC_CALLER_ID || process.env.RC_SIP_USERNAME || "Unknown Caller",
        to: lead.phone || "",
        provider: user.dialerConfig?.provider || "RINGCENTRAL",
        apiKey: user.dialerConfig?.apiKey || process.env.RC_API_KEY || null,
        accountSid: user.dialerConfig?.accountSid || process.env.RC_ACCOUNT_SID || null,
      });

      if (dialResult.connected && user.agentConfig) {
        const callLocale = detectLeadLanguage(lead, user.agentConfig);
        aiResult = await runAIagent(user.agentConfig, lead, callLocale);
      }
    }

    let resultStatus: string;
    let disposition: string;
    let transcript: string;
    let collectedEmail: string | null;
    let collectedSeats: number | null;

    if (sipResult) {
      resultStatus = sipResult.interested ? "INTERESTED" : sipResult.connected ? "NO_RESPONSE" : "FAILED";
      disposition = sipResult.disposition;
      transcript = Array.isArray(sipResult.transcript) ? sipResult.transcript.join("\n") : sipResult.transcript;
      collectedEmail = sipResult.collectedEmail;
      collectedSeats = null;
    } else {
      resultStatus = aiResult ? aiResult.leadStatus : "FAILED";
      disposition = aiResult ? aiResult.disposition : dialResult.outcome;
      transcript = aiResult?.transcript || "";
      collectedEmail = aiResult?.collectedEmail || null;
      collectedSeats = aiResult?.collectedSeats || null;
    }

    await prisma.$transaction([
      prisma.lead.update({
        where: { id: lead.id },
        data: {
          status: resultStatus as any,
          lastCallAt: new Date(),
          disposition,
          followUpDueAt: scheduleFollowUp(resultStatus, user.agentConfig?.followUpAttempts ?? 2, user.agentConfig?.followUpIntervalHours ?? 24),
        },
      }),
    ]);

    if (dialResult.connected && user.agentConfig && aiResult) {
      const nextNotes = recordLearning(
        user.agentConfig,
        aiResult.disposition,
        aiResult.leadStatus === "CONVERTED" || aiResult.leadStatus === "INTERESTED",
      );
      await prisma.aIAgentConfig.update({
        where: { userId },
        data: { learningNotes: nextNotes },
      });
    }

    await prisma.call.create({
      data: {
        userId,
        leadId: lead.id,
        campaignId: campaign.id,
        phoneNumber: lead.phone,
        timestamp: new Date(),
        durationSecs: dialResult.durationSecs,
        outcome: dialResult.outcome,
        disposition,
        aiSummary: sipResult ? `Call with ${sipResult.collectedName || "prospect"}. ${(Array.isArray(sipResult.transcript) ? sipResult.transcript.join("\n") : sipResult.transcript).slice(0, 500)}` : aiResult?.summary || null,
        transcript: transcript || null,
        resultStatus: resultStatus as never,
        collectedData: JSON.stringify({
          seats: collectedSeats,
          email: collectedEmail,
          name: sipResult?.collectedName || null,
          company: sipResult?.collectedCompany || null,
        }),
      },
    });

    callsMade++;
    if (resultStatus === "INTERESTED") interested++;
    if (resultStatus === "CONVERTED") converted++;

    if (resultStatus === "INTERESTED" || resultStatus === "CONVERTED") {
      await deliverOutcomeNotification(userId, user.email, lead, {
        leadName: sipResult?.collectedName || lead.name || "Prospect",
        phone: lead.phone || "N/A",
        leadEmail: collectedEmail || lead.email || "N/A",
        seats: collectedSeats,
        otherData: { transcript },
      }, locale);
    }
  }

  const stats = await prisma.callCampaign.update({
    where: { id: campaign.id },
    data: {
      status: "COMPLETED",
      callsMade,
      endedAt: new Date(),
    },
  });

  return {
    ok: true as const,
    campaignId: campaign.id,
    callsMade,
    interested,
    converted,
    stats,
  };
}

function scheduleFollowUp(
  status: string,
  attempts: number,
  intervalHours: number,
): Date | null {
  if (status === "PENDING" || status === "FAILED") {
    return new Date(Date.now() + intervalHours * 3600 * 1000);
  }
  return null;
}

/**
 * Check current access to AI features: only ACTIVE subscriptions may
 * initiate calls / use the agent.
 */
export async function ensureTenantCanCall(
  status: SubscriptionStatus | undefined,
): Promise<boolean> {
  return status === "ACTIVE";
}
