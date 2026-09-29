import nodemailer from "nodemailer";
import { prisma } from "@/lib/db";
import type { NotificationStatus } from "@prisma/client";

export interface MailPayload {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

let transporterCache: nodemailer.Transporter | null = null;

/** Raised when the SMTP server refused the credentials. This is permanent: no
 *  number of retries will fix a wrong password, and a ProtonMail account with
 *  2FA rejects the account password with exactly "535 5.7.8 authentication
 *  failed" and only accepts an app password. Retrying that five times hides the
 *  real cause behind a generic error, so it is reported once, clearly. */
export class PermanentMailError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "PermanentMailError";
  }
}

const AUTH_CODES = new Set(["EAUTH", "EENVELOPE"]);

function isAuthFailure(err: unknown): boolean {
  const e = err as { code?: string; responseCode?: number; message?: string } | null;
  if (!e) return false;
  if (e.code && AUTH_CODES.has(e.code)) return true;
  if (e.responseCode === 535 || e.responseCode === 534 || e.responseCode === 530) return true;
  return /535|authentication failed|invalid login|bad credentials/i.test(String(e.message || ""));
}

function authHint(): string {
  const host = String(process.env.SMTP_HOST || "");
  return /proton/i.test(host)
    ? " A free Proton account cannot send via SMTP at all - SMTP submission and the Mail Bridge are paid features - so no password will work. Set RESEND_API_KEY instead, or use a provider with a free SMTP tier such as a Gmail app password."
    : " Check SMTP_USER/SMTP_PASS, and whether the provider requires an app password.";
}

function isConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER);
}

function getTransporter(): nodemailer.Transporter | null {
  if (!isConfigured()) return null;
  if (transporterCache) return transporterCache;
  transporterCache = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  } as nodemailer.TransportOptions);
  return transporterCache;
}

/**
 * Send a sales outcome notification email to a business admin.
 * Persists a Notification row and attempts delivery. On failure the email
 * remains queued so the super admin can see it; retries are attempted.
 *
 * Two transports, because a free Proton account cannot send mail at all:
 * SMTP submission and the Mail Bridge are both paid, so the stored credential
 * is refused with "535 5.7.8" and no password would change that. An HTTPS
 * provider is therefore supported directly, and needs nothing but an API key.
 * RESEND_API_KEY is preferred when both are present.
 */
export async function sendNotification(payload: MailPayload): Promise<void> {
  const brevoKey = process.env.BREVO_API_KEY;
  if (brevoKey) {
    await sendViaBrevo(brevoKey, payload);
    return;
  }
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    await sendViaResend(resendKey, payload);
    return;
  }

  const transporter = getTransporter();
  if (!transporter) {
    // No provider configured -> queue for super admin visibility. We keep the
    // notification row in the DB (created by the caller) so it's visible even
    // though delivery doesn't occur.
    console.warn("[mailer] No email provider configured. Set BREVO_API_KEY (free, 300/day) or RESEND_API_KEY, or SMTP_HOST+SMTP_USER. Notification queued in DB only.", {
      to: payload.to,
      subject: payload.subject,
    });
    return;
  }

  const from = process.env.SMTP_FROM || "AutoDial AI <no-reply@autodial.ai>";
  try {
    await transporter.sendMail({
      from,
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
    });
  } catch (err) {
    if (isAuthFailure(err)) {
      // Do not let a rejected password masquerade as a transient outage.
      console.error(`[mailer] SMTP authentication failed for ${process.env.SMTP_USER}@${process.env.SMTP_HOST}.${authHint()}`);
      // Drop the cached transport so a corrected password takes effect without
      // a redeploy, rather than reusing a known-bad session.
      transporterCache = null;
      throw new PermanentMailError(`SMTP authentication failed for ${process.env.SMTP_USER}@${process.env.SMTP_HOST}.${authHint()}`);
    }
    throw err;
  }
}

const RESEND_URL = "https://api.resend.com/emails";

/** Brevo's transactional API. Its free plan is 300 emails/day (~9,000/month),
 *  no card and no time limit, and the only thing needed is one API key - which
 *  is why it is preferred here. It replaced a Proton account, which cannot send
 *  via SMTP on the free plan at all: both "SMTP submission" and the Mail Bridge
 *  are paid features, so the stored credential was refused with 535 5.7.8 and no
 *  password would ever have worked.
 *
 *  Brevo also offers an SMTP relay, so SMTP_HOST=smtp-relay.brevo.com works with
 *  the nodemailer path too. The API is used first because it needs no port or TLS
 *  configuration and fails with a readable message. */
async function sendViaBrevo(key: string, payload: MailPayload): Promise<void> {
  const from = process.env.MAIL_FROM || process.env.SMTP_FROM || "Magic Dialer <noreply@brevo.com>";
  let res: Response;
  try {
    res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": key, "accept": "application/json" },
      body: JSON.stringify({
        sender: { email: extractEmail(from), name: extractName(from) },
        to: [{ email: payload.to }],
        subject: payload.subject,
        textContent: payload.text,
        ...(payload.html ? { htmlContent: payload.html } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new Error(`[mailer] email provider unreachable: ${String((err as Error)?.message || err).slice(0, 160)}`);
  }
  if (!res.ok) {
    let detail = "";
    try { detail = JSON.stringify(await res.json()).slice(0, 220); } catch { /* body not json */ }
    if (res.status === 401 || res.status === 403) {
      throw new PermanentMailError(`Brevo rejected the API key (HTTP ${res.status}). ${detail}`);
    }
    throw new Error(`[mailer] email provider returned HTTP ${res.status}. ${detail}`);
  }
}

function extractEmail(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1] : from).trim();
}
function extractName(from: string): string {
  const m = /^\s*([^<]+)<([^>]+)>/.exec(from);
  return m ? m[1].trim() : "Magic Dialer";
}

/** HTTPS transactional email. No SMTP, no password, no paid Proton plan - just
 *  an API key, and a free tier that is far larger than a dialer's needs. */
async function sendViaResend(key: string, payload: MailPayload): Promise<void> {
  const from = process.env.MAIL_FROM || process.env.SMTP_FROM || "AutoDial AI <onboarding@resend.dev>";
  let res: Response;
  try {
    res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        from,
        to: [payload.to],
        subject: payload.subject,
        text: payload.text,
        ...(payload.html ? { html: payload.html } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new Error(`[mailer] email provider unreachable: ${String((err as Error)?.message || err).slice(0, 160)}`);
  }
  if (!res.ok) {
    let detail = "";
    try { detail = JSON.stringify(await res.json()).slice(0, 200); } catch { /* body not json */ }
    // 401/403 from the provider is a bad key, which no retry will fix.
    if (res.status === 401 || res.status === 403) {
      throw new PermanentMailError(`Email provider rejected the API key (HTTP ${res.status}). ${detail}`);
    }
    throw new Error(`[mailer] email provider returned HTTP ${res.status}. ${detail}`);
  }
}

/** What the operator needs to see at a glance, without sending anything. */
export function mailProviderStatus(): { provider: string; usable: boolean; detail: string } {
  if (process.env.BREVO_API_KEY) {
    return {
      provider: "brevo",
      usable: true,
      detail: `BREVO_API_KEY set, from=${process.env.MAIL_FROM || process.env.SMTP_FROM || "Magic Dialer <noreply@brevo.com>"}. Free plan: 300 emails/day.`,
    };
  }
  if (process.env.RESEND_API_KEY) {
    return { provider: "resend", usable: true, detail: `RESEND_API_KEY set, from=${process.env.MAIL_FROM || process.env.SMTP_FROM || "onboarding@resend.dev"}` };
  }
  if (isConfigured()) {
    return {
      provider: "smtp",
      usable: true,
      detail: `SMTP ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587} as ${process.env.SMTP_USER}.` +
        (/proton/i.test(String(process.env.SMTP_HOST))
          ? " A free Proton account cannot send via SMTP at all - SMTP submission is a paid feature, so this will fail with 535. Set BREVO_API_KEY instead."
          : " Not verified until the first send."),
    };
  }
  return { provider: "none", usable: false, detail: "No email provider configured. Set BREVO_API_KEY (free, 300/day), or SMTP_HOST and SMTP_USER." };
}
