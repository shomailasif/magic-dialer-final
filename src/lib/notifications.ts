import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/mailer";
import { getMessage } from "@/lib/i18n";
import type { MailPayload } from "@/lib/mailer";
import type { Lead } from "@prisma/client";
import { redactDiagnostic } from "@/lib/safe-diagnostic";

function escHtml(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface LeadOutcomeEmailData {
  leadName: string;
  phone: string;
  leadEmail: string;
  seats: number | null;
  otherData: Record<string, unknown>;
}

/**
 * Persist a sales outcome notification and attempt to deliver it.
 * Triggered when a lead moves to "interested" or "converted".
 */
export async function deliverOutcomeNotification(
  userId: string,
  toEmail: string,
  lead: Lead,
  collected: LeadOutcomeEmailData,
  locale = "en",
) {
  const isConversion = Boolean(collected.seats);
  const subjectKey = isConversion ? "subjectConversion" : "subjectInterest";
  const subject = getMessage(locale, "email", subjectKey, {
    name: lead.name || getMessage(locale, "email", "fallbackName"),
  });

  const fallback = getMessage(locale, "email", "bodyFallbackName");
  const leadNameLabel = lead.name || fallback;
  const bodyKey = isConversion ? "bodyConversion" : "bodyInterest";

  const otherRows = Object.entries(collected.otherData)
    .map(([k, v]) => `  - ${k}: ${v}`)
    .join("\n");

  const fieldName = getMessage(locale, "email", "fieldName");
  const fieldPhone = getMessage(locale, "email", "fieldPhone");
  const fieldEmail = getMessage(locale, "email", "fieldEmail");
  const fieldSeats = getMessage(locale, "email", "fieldSeats");
  const notSpecified = getMessage(locale, "email", "notSpecified");
  const seatsText = collected.seats ? String(collected.seats) : notSpecified;

  const text = [
    getMessage(locale, "email", "greeting"),
    ``,
    getMessage(locale, "email", bodyKey, { name: leadNameLabel }),
    ``,
    getMessage(locale, "email", "detailsIntro"),
    `  - ${fieldName}: ${collected.leadName} (${lead.name ?? ""})`,
    `  - ${fieldPhone}: ${collected.phone}`,
    `  - ${fieldEmail}: ${collected.leadEmail}`,
    `  - ${fieldSeats}: ${seatsText}`,
    otherRows ? `\n${getMessage(locale, "email", "otherDetails")}\n${otherRows}` : "",
    ``,
    getMessage(locale, "email", "closing"),
    ``,
    getMessage(locale, "email", "signature"),
  ].join("\n");

  const htmlHeadingKey = isConversion ? "htmlHeadingConversion" : "htmlHeadingInterest";
  const html = [
    `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">`,
    `<h2 style="color:#0f172a">${getMessage(locale, "email", htmlHeadingKey)}</h2>`,
    `<p>${getMessage(locale, "email", "htmlBody", { name: leadNameLabel })}</p>`,
    `<table style="border-collapse:collapse;width:100%">`,
    `<tr><td style="padding:6px 0"><strong>${fieldName}</strong></td><td>${escHtml(collected.leadName)} (${escHtml(lead.name ?? "")})</td></tr>`,
    `<tr><td style="padding:6px 0"><strong>${fieldPhone}</strong></td><td>${escHtml(collected.phone)}</td></tr>`,
    `<tr><td style="padding:6px 0"><strong>${fieldEmail}</strong></td><td>${escHtml(collected.leadEmail)}</td></tr>`,
    `<tr><td style="padding:6px 0"><strong>${fieldSeats}</strong></td><td>${escHtml(seatsText)}</td></tr>`,
    otherRows ? `<tr><td style="padding:6px 0"><strong>${getMessage(locale, "email", "otherDetails")}</strong></td><td><pre>${escHtml(otherRows)}</pre></td></tr>` : "",
    `</table>`,
    `<p style="margin-top:24px;color:#64748b">${getMessage(locale, "email", "signature")}</p>`,
    `</div>`,
  ].join("\n");

  const record = await prisma.notification.create({
    data: {
      userId,
      toEmail,
      subject,
      body: text,
      leadName: collected.leadName,
      phone: collected.phone,
      leadEmail: collected.leadEmail,
      seats: collected.seats,
      otherData: JSON.stringify(collected.otherData),
    },
  });

  await attemptDelivery(record.id);
}

/**
 * Attempt to (re)deliver a queued notification. Retries up to 5 times with
 * increasing backoff. Failures are logged and left in the DB for the super
 * admin to review.
 */
export async function attemptDelivery(notificationId: string): Promise<boolean> {
  const notif = await prisma.notification.findUnique({
    where: { id: notificationId },
  });
  if (!notif) return false;
  if (notif.status === "SENT") return true;
  if (notif.attempts >= 5) {
    await prisma.notification.update({
      where: { id: notificationId },
      data: { status: "FAILED", lastError: notif.lastError || "Max attempts reached" },
    });
    return false;
  }

  const payload: MailPayload = {
    to: notif.toEmail,
    subject: notif.subject,
    text: notif.body,
    html: undefined,
  };

  try {
    await sendNotification(payload);
    await prisma.notification.update({
      where: { id: notificationId },
      data: { status: "SENT", attempts: { increment: 1 } },
    });
    return true;
  } catch (err: unknown) {
    const msg = redactDiagnostic(err);
    const attempts = notif.attempts + 1;
    const status: NotificationStatus = attempts >= 5 ? "FAILED" : "QUEUED";
    await prisma.notification.update({
      where: { id: notificationId },
      data: { attempts, lastError: msg, status },
    });
    return false;
  }
}

type NotificationStatus = "QUEUED" | "SENT" | "FAILED";
