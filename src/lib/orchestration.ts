import { prisma } from "@/lib/db";
import { placeCall, validateProvider } from "@/lib/dialer";
import { deliverOutcomeNotification } from "@/lib/notifications";
import { createTelephonySession, certifiedLiveProvider } from "@/lib/telephony-session";
import type { SIPCallResult } from "@/lib/sip-caller";
import type { SubscriptionStatus } from "@prisma/client";
import { ensureSalesFoundation, recordCallAttribution, effectiveAgentConfig } from "@/lib/sales-foundation";
import { learnFromAttributedOutcome, proposeStrategyVersion } from "@/lib/controlled-learning";
import { decideCallCompliance, normalizePhoneForSuppression } from "@/lib/call-compliance";
import { redactDiagnostic } from "@/lib/safe-diagnostic";
import { decryptSecret } from "@/lib/credential-crypto";

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
  limit=Math.min(100,Math.max(1,Number.isFinite(limit)?Math.floor(limit):20));
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { subscription: true, dialerConfig: true, agentConfig: true },
  });
  if (!user) return { ok: false as const, error: "User not found" };

  // Allow test calls (limit=1) even without active subscription
  const isTestCall = limit <= 1;
  if (!isTestCall && user.subscription?.status !== "ACTIVE") {
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
  let runtimeDialer=user.dialerConfig;
  if(runtimeDialer){
    try{
      runtimeDialer={...runtimeDialer,apiKey:decryptSecret(runtimeDialer.apiKey),accountSid:decryptSecret(runtimeDialer.accountSid),sipPassword:decryptSecret(runtimeDialer.sipPassword)};
    }catch{return {ok:false as const,error:"Stored dialer credentials cannot be decrypted."};}
  }
  if (runtimeDialer) {
    const dialValid = await validateProvider(runtimeDialer);
    if (!dialValid.ok) {
      return { ok: false as const, error: dialValid.error as string };
    }
  }

  const dueLeads = await prisma.lead.findMany({
    where: {
      userId,
      AND: [
        { OR: [{ status: "PENDING" }, { status: "FAILED" }] },
        { doNotCall: false },
        { OR: [{ followUpDueAt: null }, { followUpDueAt: { lte: new Date() } }] },
      ],
    },
    take: limit,
    orderBy: { createdAt: "asc" },
  });

  let callsMade = 0;
  let interested = 0;
  let converted = 0;

  const staleBefore=new Date(Date.now()-2*60*60*1000);
  await prisma.callCampaign.updateMany({where:{userId,status:"RUNNING",startedAt:{lt:staleBefore}},data:{status:"COMPLETED",endedAt:new Date()}});
  if(dueLeads.length===0)return {ok:true as const,campaignId:null,callsMade:0,interested:0,converted:0,stats:null};
  const foundation = await ensureSalesFoundation(userId, user.agentConfig);
  const liveAgentConfig = effectiveAgentConfig(user.agentConfig, foundation.strategy, foundation.experiment);
  const campaign = await prisma.callCampaign.create({
    data: { userId, name: `Campaign ${new Date().toISOString().slice(0, 16)}`, strategyId: foundation.strategy.id, experimentId: foundation.experiment.id },
  });

  const selectedProvider = runtimeDialer?.provider || "RINGCENTRAL";
  const hasSIP = certifiedLiveProvider(selectedProvider) && !!(process.env.RC_SIP_USERNAME && process.env.RC_SIP_PASSWORD);

  try {
  for (const lead of dueLeads) {
    const normalizedPhone=normalizePhoneForSuppression(lead.phone);
    const tenantSuppression=normalizedPhone?await prisma.phoneSuppression.findUnique({where:{userId_normalizedPhone:{userId,normalizedPhone}}}):null;
    const compliance = decideCallCompliance({doNotCall:lead.doNotCall||!!tenantSuppression,phone:lead.phone,consentStatus:tenantSuppression?"DENIED":lead.consentStatus});
    if(!compliance.allowed){ console.warn("[campaign] call suppressed", compliance.code, lead.id); continue; }
    let sipResult = null as SIPCallResult | null;
    let dialResult: { connected: boolean; outcome: "CONNECTED" | "NO_ANSWER" | "BUSY" | "UNREACHABLE" | "FAILED"; durationSecs: number } = { connected: false, outcome: "FAILED", durationSecs: 0 };

    if (hasSIP && lead.phone) {
      try {
        const telephony = createTelephonySession(selectedProvider, {
            user: process.env.RC_SIP_USERNAME || "",
            pass: process.env.RC_SIP_PASSWORD || "",
            authId: process.env.RC_SIP_AUTH_ID || process.env.RC_SIP_USERNAME || "",
            domain: process.env.RC_SIP_DOMAIN || "sip.ringcentral.com",
            proxy: process.env.RC_SIP_PROXY || "sip40.ringcentral.com",
            port: Number(process.env.RC_SIP_PORT || "5096"),
            number: lead.phone,
            callerId: process.env.RC_CALLER_ID || "",
          });
        sipResult = await telephony.placeConversationalCall(liveAgentConfig);
        dialResult = {
          connected: sipResult.connected,
          outcome: sipResult.connected ? "CONNECTED" : "NO_ANSWER",
          durationSecs: sipResult.durationSecs,
        };
      } catch (e) {
        console.error("[campaign] SIP call failed; attempting provider fallback:", redactDiagnostic(e));
        sipResult = null;
      }
    }

    if (!sipResult) {
      try {
      dialResult = await placeCall({
        from: runtimeDialer?.outboundNumber || process.env.RC_CALLER_ID || process.env.RC_SIP_USERNAME || "Unknown Caller",
        to: lead.phone || "",
        provider: runtimeDialer?.provider || "RINGCENTRAL",
        apiKey: runtimeDialer?.apiKey || process.env.RC_API_KEY || null,
        accountSid: runtimeDialer?.accountSid || process.env.RC_ACCOUNT_SID || null,
      });

      if (dialResult.connected) {
        console.error("[campaign] call connected without live media bridge; refusing simulated AI result");
        dialResult = { connected: false, outcome: "FAILED", durationSecs: dialResult.durationSecs };
      }
      } catch (e) {
        console.error("[campaign] RingOut call also failed:", redactDiagnostic(e));
        dialResult = { connected: false, outcome: "FAILED", durationSecs: 0 };
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
      resultStatus = "FAILED";
      disposition = dialResult.outcome;
      transcript = "";
      collectedEmail = null;
      collectedSeats = null;
    }

    const executionKey=campaign.id+":"+lead.id;
    const existingCall=await prisma.call.findUnique({where:{executionKey}});
    if(existingCall){continue;}
    const txWrites:any[] = [
      prisma.lead.update({
        where: { id: lead.id },
        data: {
          status: resultStatus as any,
          lastCallAt: new Date(),
          disposition,
          followUpDueAt: sipResult?.doNotCall ? null : scheduleFollowUp(resultStatus, lead.followUpAttemptsMade, user.agentConfig?.followUpAttempts ?? 2, user.agentConfig?.followUpIntervalHours ?? 24),
          followUpAttemptsMade: resultStatus==="FAILED" ? {increment:1} : lead.followUpAttemptsMade,
          doNotCall: sipResult?.doNotCall ? true : lead.doNotCall,
          doNotCallAt: sipResult?.doNotCall ? new Date() : lead.doNotCallAt,
          doNotCallReason: sipResult?.doNotCall ? "SPOKEN_OPT_OUT" : lead.doNotCallReason,
          consentStatus: sipResult?.doNotCall ? "DENIED" : lead.consentStatus,
          consentSource: sipResult?.doNotCall ? "SPOKEN_OPT_OUT" : lead.consentSource,
          consentUpdatedAt: sipResult?.doNotCall ? new Date() : lead.consentUpdatedAt,
        },
      }),
      prisma.call.create({
      data: {
        userId,
        leadId: lead.id,
        campaignId: campaign.id,
        phoneNumber: lead.phone,
        timestamp: new Date(),
        durationSecs: dialResult.durationSecs,
        outcome: dialResult.outcome,
        disposition,
        aiSummary: sipResult ? `Call with ${sipResult.collectedName || "prospect"}. ${(Array.isArray(sipResult.transcript) ? sipResult.transcript.join("\n") : sipResult.transcript).slice(0, 500)}` : null,
        transcript: transcript || null,
        resultStatus: resultStatus as never,
        executionKey,
        collectedData: JSON.stringify({
          seats: collectedSeats,
          email: collectedEmail,
          name: sipResult?.collectedName || null,
          company: sipResult?.collectedCompany || null,
        }),
      },
    }),
    ];
    if(sipResult?.doNotCall && normalizedPhone){txWrites.push(prisma.phoneSuppression.upsert({where:{userId_normalizedPhone:{userId,normalizedPhone}},update:{reason:"SPOKEN_OPT_OUT",source:"LIVE_CALL"},create:{userId,normalizedPhone,reason:"SPOKEN_OPT_OUT",source:"LIVE_CALL"}}));}
    const txResult=await prisma.$transaction(txWrites);
    const storedCall=txResult[1] as any;
    await recordCallAttribution({userId,callId:storedCall.id,strategyId:foundation.strategy.id,experimentId:foundation.experiment.id,outcome:resultStatus,evidence:{dialOutcome:dialResult.outcome,disposition}});
    const learningEvent = await learnFromAttributedOutcome({userId,strategyId:foundation.strategy.id,outcome:resultStatus,evidence:{callId:storedCall.id,experimentId:foundation.experiment.id}});
    if(learningEvent.action==="ELIGIBLE_FOR_STRATEGY_REVIEW"){
      await proposeStrategyVersion({userId,strategyId:foundation.strategy.id,reason:"evidence-threshold"});
    }

    callsMade++;
    if (resultStatus === "INTERESTED") interested++;
    if (resultStatus === "CONVERTED") converted++;

    if (resultStatus === "INTERESTED" || resultStatus === "CONVERTED") {
      try { await deliverOutcomeNotification(userId, user.email, lead, {
        leadName: sipResult?.collectedName || lead.name || "Prospect",
        phone: lead.phone || "N/A",
        leadEmail: collectedEmail || lead.email || "N/A",
        seats: collectedSeats,
        otherData: { transcript },
      }, locale); } catch(e){ console.error("[campaign] outcome notification failed:", redactDiagnostic(e)); }
    }
  }
  } catch(e) {
    await prisma.callCampaign.update({where:{id:campaign.id},data:{status:"COMPLETED",callsMade,endedAt:new Date(),name:campaign.name+" [FAILED]"}}).catch(()=>undefined);
    console.error("[campaign] run failed:", redactDiagnostic(e));
    return {ok:false as const,error:"Campaign execution failed.",campaignId:campaign.id,callsMade,interested,converted};
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
  attemptsMade: number,
  maxAttempts: number,
  intervalHours: number,
): Date | null {
  if (status === "PENDING" || status === "FAILED") {
    if(attemptsMade>=Math.max(0,maxAttempts-1))return null;
    return new Date(Date.now() + Math.max(1,intervalHours) * 3600 * 1000);
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
