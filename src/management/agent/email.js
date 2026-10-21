/**
 * Agent local email sender — sends qualified leads directly from the PC.
 *
 * Uses SMTP (nodemailer-style, but dependency-free via raw SMTP over TLS).
 * Falls back to writing an outbox file if SMTP is not configured.
 *
 * Config is stored in the agent's local config file (set during setup).
 */
const crypto = require("node:crypto");
const tls = require("node:tls");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Send an email via SMTP. Returns { ok, error? }.
 *
 * opts: { host, port, secure, user, pass, from, to, subject, text, html? }
 */
async function sendEmail(opts) {
  const { host, port = 587, secure = false, user, pass, from, to, subject, text, html } = opts;
  if (!host || !to) return { ok: false, error: "Missing SMTP host or recipient" };

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: "SMTP timeout" }), 15000);
    const socket = tls.connect({ host, port }, () => {
      let buf = "";
      const send = (line) => socket.write(line + "\r\n");

      send(`EHLO ${crypto.randomBytes(8).toString("hex")}.local`);
      // Simple SMTP flow — AUTH LOGIN
      let step = 0;
      const steps = [
        () => { send(`AUTH LOGIN`); },
        () => { send(Buffer.from(user || "").toString("base64")); },
        () => { send(Buffer.from(pass || "").toString("base64")); },
        () => { send(`MAIL FROM:<${from || user}>`); },
        () => { send(`RCPT TO:<${to}>`); },
        () => { send(`DATA`); },
        () => {
          const safeSubject = String(subject || "").replace(/[\r\n]/g, " ");
          const safeFrom = String(from || user || "").replace(/[\r\n]/g, " ");
          const safeTo = String(to || "").replace(/[\r\n]/g, " ");
          send(`From: ${safeFrom}`);
          send(`To: ${safeTo}`);
          send(`Subject: ${safeSubject}`);
          send(`Content-Type: text/plain; charset=utf-8`);
          send(``);
          const body = (text || "").replace(/^\./gm, "..");
          send(body);
          send(`.`);
        },
        () => { send(`QUIT`); clearTimeout(timer); socket.destroy(); resolve({ ok: true }); },
      ];

      socket.on("data", (d) => {
        buf += d.toString("ascii");
        // Process one complete line at a time (SMTP responses can be multi-line)
        const lines = buf.split(/\r\n/);
        buf = lines.pop(); // keep incomplete line in buffer
        for (const line of lines) {
          if (!line) continue;
          if (/^5/.test(line)) { clearTimeout(timer); socket.destroy(); resolve({ ok: false, error: line.trim() }); return; }
          // Only advance on the last line of a response (no dash = complete)
          if (step < steps.length && !/^-/.test(line)) steps[step++]();
        }
      });
    });
    socket.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    socket.setTimeout(10000);
    socket.on("timeout", () => { clearTimeout(timer); socket.destroy(); resolve({ ok: false, error: "socket timeout" }); });
  });
}

/**
 * Email a qualified lead. Tries SMTP first, falls back to outbox file.
 *
 * opts: { lead, smtp, contactEmail, product }
 */
async function emailQualifiedLead(opts) {
  const { lead, smtp, contactEmail, product } = opts;
  const to = contactEmail;
  if (!to) return { ok: false, error: "No contact email configured" };

  const subject = `New qualified lead: ${product || "your service"}`;
  const body = [
    `A new qualified lead was found by your AI agent.`,
    ``,
    `Company: ${lead.company || "Unknown"}`,
    `Name: ${lead.name || "Unknown"}`,
    `Phone: ${lead.phone || "Unknown"}`,
    `Email: ${lead.email || "Unknown"}`,
    `Score: ${lead.score ?? "N/A"}`,
    ``,
    `Summary:`,
    lead.summary || "No summary available.",
    ``,
    `Answers:`,
    lead.answers ? JSON.stringify(lead.answers, null, 2) : "None collected",
  ].join("\n");

  // Try SMTP
  if (smtp && smtp.host) {
    const r = await sendEmail({
      host: smtp.host,
      port: smtp.port || 587,
      secure: smtp.secure || false,
      user: smtp.user,
      pass: smtp.pass,
      from: smtp.from || smtp.user,
      to,
      subject,
      text: body,
    });
    if (r.ok) return { ok: true, method: "smtp" };
  }

  // Fallback: write to outbox
  try {
    const outboxDir = path.join(process.cwd(), "outbox");
    fs.mkdirSync(outboxDir, { recursive: true });
    const filename = `lead-${Date.now()}.txt`;
    fs.writeFileSync(path.join(outboxDir, filename), `To: ${to}\nSubject: ${subject}\n\n${body}`);
    return { ok: true, method: "outbox", file: filename };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Send a qualified lead from this PC when nobody else has.
 *
 * The portal emails every result it accepts (call.js reports that back as
 * `emailed`), so this fires only when the portal could not take the result -
 * suspended hosting, a dead network, a result POST that timed out. A qualified
 * lead is the one thing an operator cannot regenerate, and when their site is
 * gone it must still arrive in the mailbox they configured during setup.
 *
 * Never both: a duplicate email is worse than a delayed one, so `emailed` from
 * the portal short-circuits before any SMTP work happens.
 *
 * opts: { config, result, lead, log }
 * Returns { ok, method?, error?, skipped? }.
 */
async function deliverQualifiedLead({ config = {}, result = {}, lead = null, log = () => {} }) {
  if (!result || !result.goodLead) return { ok: false, skipped: "not a qualified lead" };
  if (result.emailed) return { ok: true, method: "portal" };
  const to = String(config.contactEmail || "").trim();
  if (!to) return { ok: false, error: "No contact email configured" };

  const l = lead || {};
  /* A failing email must never take a call path down with it: the call has
   * already happened and the result is already recorded, so this reports and
   * moves on. */
  let r;
  try {
    r = await emailQualifiedLead({
      lead: {
        company: l.company || null, name: l.name || null, phone: l.phone || null,
        email: l.email || null, score: result.score, summary: result.summary,
        answers: result.answers,
      },
      smtp: config.smtp,
      contactEmail: to,
      product: config.product,
    });
  } catch (e) {
    r = { ok: false, error: String((e && e.message) || e) };
  }
  log(r.ok
    ? `Qualified lead emailed to ${to} (${r.method === "smtp" ? "smtp" : "outbox file" + (r.file ? " " + r.file : "")}).`
    : `Qualified lead email to ${to} failed: ${r.error}`);
  return r;
}

module.exports = { sendEmail, emailQualifiedLead, deliverQualifiedLead };
