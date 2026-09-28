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
    ? " SMTP_PASS must be a ProtonMail app password (Settings -> Access -> App password), not the account password."
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
 */
export async function sendNotification(payload: MailPayload): Promise<void> {
  const transporter = getTransporter();
  if (!transporter) {
    // No SMTP configured -> queue for super admin visibility. We keep the
    // notification row in the DB (created by the caller) so it's visible even
    // though delivery doesn't occur.
    console.warn("[mailer] SMTP not configured; notification queued in DB only", {
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
