import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authorizeActiveEngineDevice, engineBearerToken } from "@/lib/engine-device-auth";
import { sendNotification } from "@/lib/mailer";
import { diagnosticId, safeDiagnostic } from "@/lib/safe-diagnostic";

export const dynamic = "force-dynamic";

/**
 * Where a qualified lead is reported by the customer's PC after a call.
 *
 * This route was MISSING from the deployed portal. The agent posts here at the
 * end of every call, and the live portal answered 404 - so no lead was ever
 * stored and no lead email was ever sent, on any account. The code that did this
 * lived in an older standalone server file that the live site does not serve.
 *
 * Recipients, deliberately:
 *   1. the account's own address (user.email, collected at signup). A new
 *      account therefore gets its leads at its own inbox.
 *   2. a shared forward, LEAD_FORWARD_EMAIL (default onboarding@zazlogistics.com),
 *      which is where the existing accounts' leads are watched. Skipped when it
 *      is the same address as (1), so nobody gets the same mail twice.
 *
 * Delivery must never fail a call: this runs after the phone has hung up, and a
 * lead that is stored but not emailed is far better than a lead that is lost.
 */

function answerValue(answers: unknown, ...keys: string[]): string {
  if (!answers || typeof answers !== "object") return "";
  const rec = answers as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

function firstString(v: unknown): string {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (Array.isArray(v)) for (const x of v) { const s = firstString(x); if (s) return s; }
  return "";
}

/** The address the account was created with. Lookup is best effort: if it fails
 *  the lead is still stored and still forwarded, never lost. */
async function accountEmail(userId: string): Promise<string> {
  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    return String(u?.email || "").trim().toLowerCase();
  } catch {
    return "";
  }
}

export async function POST(r: Request) {
  const requestId = diagnosticId(r.headers.get("x-request-id"));
  const callId = diagnosticId(r.headers.get("x-call-id"));
  const fail = (error: string, stage: string, code: string, status: number) =>
    NextResponse.json({ error, ...safeDiagnostic(stage, code, status, requestId, callId) }, { status });

  let b: Record<string, unknown>;
  try { b = (await r.json()) as Record<string, unknown>; }
  catch { return fail("Invalid body", "body", "INVALID_BODY", 400); }

  const token = firstString(b.deviceToken) || engineBearerToken(r);
  const device = await authorizeActiveEngineDevice(token);
  if (!device) return fail("Unauthorized", "device-auth", "UNAUTHORIZED", 401);

  const answers = (b.answers && typeof b.answers === "object" ? b.answers : {}) as Record<string, unknown>;
  const leadName = answerValue(answers, "NAME", "LEAD NAME", "FULL NAME") || firstString(b.summary) || "New lead";
  const company = answerValue(answers, "COMPANY NAME", "COMPANY", "Company") || "";
  const phone = firstString(b.destination) || answerValue(answers, "PHONE", "PHONE NUMBER") || "";
  const transcript = typeof b.transcript === "string" ? b.transcript.slice(0, 4000) : "";
  const product = firstString(b.product);
  const summary = firstString(b.summary);
  const qualified = b.qualified === undefined ? true : Boolean(b.qualified);
  const aiAgentName = firstString(b.persona) || "AI Agent";

  // 1. Store it. A lead that is recorded survives any email trouble.
  let leadId = "";
  try {
    const lead = await prisma.lead.create({
      data: {
        userId: device.userId,
        name: leadName,
        phone: phone || null,
        company: company || null,
        extraData: JSON.stringify({ answers, product, summary, callId, qualified }),
        status: "PENDING",
      },
    });
    leadId = lead.id;
  } catch (e) {
    // Never lose the notification because a write failed: still try to email it.
    console.error("call-result lead store failed", e);
  }

  // 2. Email it. Per-account first, then the shared forward, never duplicated.
  // The account's own address is user.email, collected when the account was
  // created, so a new account receives its leads at its own inbox. The shared
  // forward covers the accounts whose leads are watched centrally.
  const recipients: string[] = [];
  const own = firstString(b.contactEmail) || await accountEmail(device.userId);
  const forward = (process.env.LEAD_FORWARD_EMAIL || "onboarding@zazlogistics.com").trim().toLowerCase();
  if (own) recipients.push(own);
  if (forward && !recipients.includes(forward)) recipients.push(forward);

  const lines = [
    "NEW QUALIFIED LEAD",
    "",
    `AI Agent: ${aiAgentName}`,
    `Lead Name: ${leadName || "N/A"}`,
    `Company: ${company || "N/A"}`,
    `Phone: ${phone || "N/A"}`,
    product ? `Offering: ${product}` : "",
    "",
    summary ? `Summary: ${summary}` : "",
    transcript ? `--- Full Transcript ---\n${transcript}` : "",
  ].filter(Boolean);

  const emailed: string[] = [];
  for (const to of recipients) {
    try {
      await sendNotification({
        to,
        subject: `[Qualified Lead] ${leadName}${company ? " - " + company : ""} (${aiAgentName})`,
        text: lines.join("\n"),
      });
      emailed.push(to);
    } catch (e) {
      console.error(`call-result email to ${to} failed`, (e as Error)?.message || e);
    }
  }

  if (!recipients.length) console.error("call-result: no recipient resolved for lead " + leadId);
  return NextResponse.json({ ok: true, leadId, emailed, requestId, callId });
}
