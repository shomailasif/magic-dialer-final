import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authorizeActiveEngineDevice, engineBearerToken } from "@/lib/engine-device-auth";
import { sendNotification } from "@/lib/mailer";
import { diagnosticId, safeDiagnostic, redactDiagnostic } from "@/lib/safe-diagnostic";
import { isSpokenOptOut, normalizePhoneForSuppression } from "@/lib/call-compliance";

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

/**
 * The agent's transcript, and only what the PROSPECT said in it.
 *
 * The local engine sends an array of {role, text} objects. This route accepted a
 * string and nothing else, so `transcript` was "" for every call the deployed
 * engine makes - the full transcript was never stored, and nothing downstream
 * could read it. The SIP path sends "Prospect: ..." / "Agent: ..." lines, so
 * both shapes have to be understood.
 *
 * Only prospect lines are returned for refusal scanning. isSpokenOptOut is a
 * suppression function: feeding it the agent's own words would let the agent
 * suppress a number by saying the wrong thing, which is both wrong and a very
 * easy way to lose leads by accident.
 */
function parseTranscript(raw: unknown): { full: string; prospect: string } {
  const lines: { lead: boolean; text: string }[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const text = firstString(e.text) || firstString(e.content);
      if (!text) continue;
      const role = String(e.role || e.speaker || "").toLowerCase();
      lines.push({ lead: /^(lead|prospect|user|customer)$/.test(role), text });
    }
  } else if (typeof raw === "string") {
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*(prospect|lead|user|customer|agent)\s*:\s*(.+)$/i.exec(line);
      if (m) lines.push({ lead: !/^agent$/i.test(m[1]), text: m[2] });
    }
  }
  return {
    full: lines.map((l) => `${l.lead ? "Prospect" : "Agent"}: ${l.text}`).join("\n").slice(0, 4000),
    prospect: lines.filter((l) => l.lead).map((l) => l.text).join("\n"),
  };
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
  /* A call is not a lead because it happened. The agent sends goodLead, and
   * this route ignored it - so a 73-second call where the prospect said hello
   * and hung up was stored as a Lead and emailed as "NEW QUALIFIED LEAD".
   * Reporting is still worth doing either way; a lead is not. */
  const goodLead = b.goodLead === undefined ? false : Boolean(b.goodLead);
  const leadName = answerValue(answers, "NAME", "LEAD NAME", "FULL NAME") || firstString(b.summary) || "New lead";
  const company = answerValue(answers, "COMPANY NAME", "COMPANY", "Company") || "";
  const phone = firstString(b.destination) || answerValue(answers, "PHONE", "PHONE NUMBER") || "";
  const { full: transcript, prospect } = parseTranscript(b.transcript);
  const product = firstString(b.product);
  const summary = firstString(b.summary);
  const aiAgentName = firstString(b.persona) || "AI Agent";

  /* A refusal ends the call, and it has to end it in the DATA too.
   *
   * The agent was already refusing correctly in conversation. Nothing acted on it:
   * the transcript this route used to read was always "" (the engine sends an
   * array, this route accepted only a string), so no refusal was ever detected
   * here, and a person who said "don't call me" was stored as a Lead with their
   * number and emailed as a qualified lead - which is how a person who refused to
   * be called ends up in a campaign queue.
   *
   * Two sources, because they fail differently. The agent's own doNotCall is
   * authoritative: it heard the words in real time. The transcript scan is the
   * backstop for a refusal the agent's patterns missed. Either one suppresses. */
  const optedOut = b.doNotCall === true || isSpokenOptOut(prospect);
  if (optedOut) {
    const normalised = normalizePhoneForSuppression(phone);
    console.log(
      `call-result: SPOKEN OPT-OUT on ${callId || "unknown call"}; no lead stored, no email sent` +
        (normalised ? `, suppressing ${normalised}` : ", but no phone was reported to suppress"),
    );
    if (normalised) {
      /* Best effort and deliberately non-fatal. A suppression write that fails
       * must not turn a refused call into a 500 that makes the engine retry and
       * report it again - the outcome the caller asked for has already happened
       * in the conversation, and the important half (no lead row, no email) is
       * already done by returning here. */
      try {
        await prisma.phoneSuppression.upsert({
          where: { userId_normalizedPhone: { userId: device.userId, normalizedPhone: normalised } },
          update: { source: "SPOKEN_OPT_OUT", reason: "SPOKEN_OPT_OUT" },
          create: {
            userId: device.userId,
            normalizedPhone: normalised,
            source: "SPOKEN_OPT_OUT",
            reason: "SPOKEN_OPT_OUT",
          },
        });
      } catch (e) {
        /* safeDiagnostic is not an error formatter - it builds a traceable
         * diagnostic with a stage and a code, and returns an object. Calling it
         * with the error, or calling .slice on what it returns, is a type error
         * the local check missed and CI caught. redactDiagnostic is the one that
         * renders a value to a string. */
        console.error(`call-result: failed to persist opt-out suppression: ${redactDiagnostic(e).slice(0, 200)}`);
      }
    }
    return NextResponse.json({ ok: true, lead: false, optedOut: true, suppressed: !!normalised, emailed: [], requestId, callId });
  }

  // 1. Store it. A lead that is recorded survives any email trouble - but only
  //    if it really is one.
  let leadId = "";
  if (!goodLead) {
    console.log(`call-result: call reported but not a lead (goodLead=false), nothing stored or emailed. summary=${JSON.stringify(summary.slice(0, 80))}`);
    return NextResponse.json({ ok: true, lead: false, emailed: [], requestId, callId });
  }
  try {
    const lead = await prisma.lead.create({
      data: {
        userId: device.userId,
        name: leadName,
        phone: phone || null,
        company: company || null,
        extraData: JSON.stringify({ answers, product, summary, callId }),
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
