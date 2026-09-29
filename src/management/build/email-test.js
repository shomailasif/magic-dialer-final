"use strict";
/**
 * Verify outbound email with one command, without deploying anything.
 *
 *   node build/email-test.js you@example.com
 *
 * It reports which provider is configured, sends a real test message, and says
 * plainly what went wrong if it did not. This exists because the configured
 * ProtonMail account was silently unusable - a free Proton plan cannot send via
 * SMTP at all, since both "SMTP submission" and the Mail Bridge are paid - and
 * that was only discovered by a customer notification never arriving.
 *
 * Free providers that work with it, no card required:
 *   BREVO_API_KEY   https://brevo.com  free, 300 emails/day
 *   RESEND_API_KEY  https://resend.com free tier available
 *   SMTP_*          smtp-relay.brevo.com also works over SMTP
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const ENV_FILE = path.join(ROOT, ".env");

function loadEnv() {
  const out = {};
  if (!fs.existsSync(ENV_FILE)) return out;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function mask(s) {
  const v = String(s || "");
  if (v.length <= 6) return "*".repeat(v.length);
  return v.slice(0, 3) + "*".repeat(Math.max(0, v.length - 5)) + v.slice(-2);
}

async function main() {
  const to = process.argv[2];
  if (!to) {
    console.error("usage: node build/email-test.js you@example.com");
    process.exit(2);
  }
  const env = loadEnv();
  for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;

  const hasBrevo = !!env.BREVO_API_KEY;
  const hasResend = !!env.RESEND_API_KEY;
  const hasSmtp = !!(env.SMTP_HOST && env.SMTP_USER);

  console.log("  provider:");
  if (hasBrevo) console.log("    brevo  BREVO_API_KEY=" + mask(env.BREVO_API_KEY));
  if (hasResend) console.log("    resend RESEND_API_KEY=" + mask(env.RESEND_API_KEY));
  if (hasSmtp) console.log(`    smtp   ${env.SMTP_HOST}:${env.SMTP_PORT || 587} as ${env.SMTP_USER}`);
  if (!hasBrevo && !hasResend && !hasSmtp) {
    console.log("    NONE. Add one of these to .env:");
    console.log("      BREVO_API_KEY=...   free, 300 emails/day, no card - recommended");
    console.log("      RESEND_API_KEY=...  free tier available");
    console.log("      SMTP_HOST=smtp-relay.brevo.com  (Brevo's free SMTP relay also works)");
    process.exit(2);
  }
  if (hasSmtp && /proton/i.test(env.SMTP_HOST || "")) {
    console.log("    NOTE: a free Proton account cannot send via SMTP at all - both SMTP");
    console.log("          submission and the Mail Bridge are paid. That is why this failed.");
    console.log("          Add BREVO_API_KEY; the Proton settings are ignored once it is set.");
  }

  const { sendNotification, mailProviderStatus, PermanentMailError } = require(path.join(ROOT, "src", "lib", "mailer.ts"));
  const status = mailProviderStatus();
  console.log(`  using   : ${status.provider} - ${status.detail}`);

  try {
    await sendNotification({
      to,
      subject: "Magic Dialer - email test (ignore this message)",
      text: "This is an automated test from the Magic Dialer engine.\n\nIf you received it, sales outcome notifications will reach you.\n",
    });
    console.log(`  SENT     : ${to}`);
  } catch (err) {
    const permanent = err instanceof PermanentMailError;
    console.log(`  FAILED   : ${String(err.message).slice(0, 220)}`);
    if (permanent) {
      console.log("             This will never succeed on retry - it is a configuration problem, not a network one.");
    }
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
