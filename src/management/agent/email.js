/**
 * Agent local email sender - sends qualified leads directly from the PC.
 *
 * Uses SMTP (nodemailer-style, but dependency-free). Two transports are
 * supported: implicit TLS (port 465, `secure: true`) and a plaintext connection
 * upgraded with STARTTLS (port 587). Credentials are never sent on a plaintext
 * connection; a server that does not offer STARTTLS is refused.
 *
 * Falls back to writing an outbox file if SMTP is not configured or fails.
 */
const crypto = require("node:crypto");
const net = require("node:net");
const tls = require("node:tls");
const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");

/* One complete SMTP reply. A reply is one or more lines: continuation lines
 * are "250-text", the final line is "250 text". Reading stops at the first
 * final line, which is why the old single-counter state machine (one step per
 * line) sent AUTH before the greeting had even been consumed. */
function readResponse(socket, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => { cleanup(); reject(new Error("SMTP response timeout")); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split(/\r?\n/);
      /* The last element is a partial line (or empty); only complete lines can
       * end a reply. */
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
          cleanup();
          resolve({ code: Number(line.slice(0, 3)), lines: lines.slice(0, i + 1) });
          return;
        }
      }
    };
    const onError = (e) => { cleanup(); reject(e); };
    const onClose = () => { cleanup(); reject(new Error("SMTP connection closed")); };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

async function command(socket, line) {
  socket.write(line + "\r\n");
  const r = await readResponse(socket);
  if (r.code >= 400) throw new Error(`${line.split(/\s+/)[0]} rejected (${r.code}): ${r.lines.join(" | ")}`);
  return r;
}

function oneLine(value) {
  return String(value == null ? "" : value).replace(/[\r\n]+/g, " ").trim();
}

/* A header may only carry ASCII. A product or prospect name with an accent
 * would otherwise be sent raw and arrive mangled, so non-ASCII values travel
 * as a single RFC 2047 encoded word. */
function encodeHeader(value) {
  const s = oneLine(value);
  if (!/[^\x20-\x7E]/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

/* Base64 is safe on every server. Sending UTF-8 bytes with 8bit without
 * checking that the server advertised 8BITMIME is not: a server that does not
 * support it may mangle or reject the message. */
function encodeBody(text) {
  const base64 = Buffer.from(String(text || "").replace(/\r?\n/g, "\r\n"), "utf8").toString("base64");
  /* 76 characters per line, and no stray blank line at the end when the
   * encoded length happens to be an exact multiple. */
  return (base64.match(/.{1,76}/g) || []).join("\r\n");
}

/* "Magic Dialer <owner@example.com>" is a valid header value but not a valid
 * envelope path; MAIL FROM must be the bare address. */
function addressOf(value) {
  const s = oneLine(value);
  const bracketed = s.match(/<([^<>]+)>/);
  const addr = String(bracketed ? bracketed[1] : s).trim();
  if (/[\s<>]/.test(addr) || !/^[^\s@]+@[^\s@]+$/.test(addr)) return "";
  return addr;
}

function tlsOptions({ host, port, ca, rejectUnauthorized }) {
  const o = { host, port };
  if (!net.isIP(String(host || ""))) o.servername = String(host);
  if (ca) o.ca = ca;
  if (rejectUnauthorized === false) o.rejectUnauthorized = false;
  return o;
}

/**
 * Send an email via SMTP. Returns { ok, error? }.
 *
 * opts: { host, port, secure, user, pass, from, to, subject, text, html?, ca?, rejectUnauthorized? }
 * `ca` / `rejectUnauthorized` exist for the test suite only; emailQualifiedLead
 * never sets them, so production always verifies the server certificate.
 */
async function sendEmail(opts) {
  const { host, port = 587, secure = false, user, pass, from, to, subject, text } = opts;
  if (!host || !to) return { ok: false, error: "Missing SMTP host or recipient" };
  const envelopeTo = addressOf(to);
  const envelopeFrom = addressOf(from) || addressOf(user);
  if (!envelopeTo) return { ok: false, error: "Invalid recipient address" };
  if (!envelopeFrom) return { ok: false, error: "Invalid sender address" };

  return new Promise((resolve) => {
    let socket = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(overall);
      try { if (socket) socket.destroy(); } catch {}
      resolve(result);
    };
    const overall = setTimeout(() => finish({ ok: false, error: "SMTP timeout" }), 20000);

    (async () => {
      const implicitTls = secure === true || Number(port) === 465;
      if (implicitTls) {
        socket = tls.connect(tlsOptions({ host, port, ca: opts.ca, rejectUnauthorized: opts.rejectUnauthorized }));
        await once(socket, "secureConnect");
      } else {
        socket = net.connect({ host, port });
        await once(socket, "connect");
      }
      socket.setTimeout(15000, () => finish({ ok: false, error: "socket timeout" }));

      let reply = await readResponse(socket);
      if (reply.code !== 220) throw new Error(`SMTP greeting rejected (${reply.code}): ${reply.lines.join(" | ")}`);

      const clientName = crypto.randomBytes(8).toString("hex") + ".local";
      let ehlo = await command(socket, `EHLO ${clientName}`);
      let caps = ehlo.lines.join("\n").toLowerCase();

      if (!implicitTls) {
        if (!/\bstarttls\b/.test(caps)) {
          throw new Error("SMTP server does not offer STARTTLS; refusing to send credentials over plaintext");
        }
        await command(socket, "STARTTLS");
        const upgraded = tls.connect({ ...tlsOptions({ host, port, ca: opts.ca, rejectUnauthorized: opts.rejectUnauthorized }), socket });
        await once(upgraded, "secureConnect");
        socket = upgraded;
        socket.setTimeout(15000, () => finish({ ok: false, error: "socket timeout" }));
        ehlo = await command(socket, `EHLO ${clientName}`);
        caps = ehlo.lines.join("\n").toLowerCase();
      }

      if (user || pass) {
        if (/\bauth\b[^\n]*\blogin\b/.test(caps)) {
          await command(socket, "AUTH LOGIN");
          await command(socket, Buffer.from(String(user || "")).toString("base64"));
          await command(socket, Buffer.from(String(pass || "")).toString("base64"));
        } else if (/\bauth\b[^\n]*\bplain\b/.test(caps)) {
          const token = Buffer.from("\0" + String(user || "") + "\0" + String(pass || "")).toString("base64");
          await command(socket, `AUTH PLAIN ${token}`);
        } else {
          throw new Error("SMTP server offers neither AUTH LOGIN nor AUTH PLAIN");
        }
      }

      await command(socket, `MAIL FROM:<${envelopeFrom}>`);
      await command(socket, `RCPT TO:<${envelopeTo}>`);
      await command(socket, "DATA");

      const headerFrom = oneLine(from) || envelopeFrom;
      /* The address itself must stay literal in the header; only the subject
       * is a free-text field here. */
      const headerTo = oneLine(to);
      const domain = envelopeFrom.split("@")[1] || "localhost";
      const headers = [
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${crypto.randomBytes(16).toString("hex")}@${domain}>`,
        `From: ${headerFrom}`,
        `To: ${headerTo}`,
        `Subject: ${encodeHeader(subject)}`,
        `MIME-Version: 1.0`,
        `Content-Type: text/plain; charset=utf-8`,
        `Content-Transfer-Encoding: base64`,
        ``,
      ].join("\r\n");
      socket.write(headers + "\r\n" + encodeBody(text) + "\r\n.\r\n");
      const stored = await readResponse(socket);
      if (stored.code >= 400) throw new Error(`message rejected (${stored.code}): ${stored.lines.join(" | ")}`);

      try { await command(socket, "QUIT"); } catch { /* the message is already accepted */ }
      finish({ ok: true });
    })().catch((e) => finish({ ok: false, error: (e && e.message) || String(e) }));
  });
}

/**
 * Email a qualified lead. Tries SMTP first, falls back to outbox file.
 *
 * opts: { lead, smtp, contactEmail, product, outboxDir }
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
  let smtpError = null;
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
    /* Keep the reason: "no mail server is configured" is the wrong story when
     * a server was configured and refused the message. */
    smtpError = r.error || "the mail server rejected the message";
  }

  // Fallback: write to outbox
  try {
    /* Not the process's working directory. A packaged install can be started
     * from Program Files, which is not writable, so the old path turned the
     * last-resort copy of a qualified lead into an EPERM nobody saw. The caller
     * passes the engine's own data directory, which always exists and is the
     * one place the operator can be pointed at. */
    const outboxDir = path.join(opts.outboxDir || process.cwd(), "outbox");
    fs.mkdirSync(outboxDir, { recursive: true });
    const filename = `lead-${Date.now()}.txt`;
    const full = path.join(outboxDir, filename);
    fs.writeFileSync(full, `To: ${to}\nSubject: ${subject}\n\n${body}`);
    return { ok: true, method: "outbox", file: filename, path: full, smtpError };
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
      outboxDir: config.outboxDir,
    });
  } catch (e) {
    r = { ok: false, error: String((e && e.message) || e) };
  }
  const where = r.path || r.file;
  log(r.ok
    ? (r.method === "smtp"
      ? `Qualified lead emailed to ${to} from this PC.`
      : `Qualified lead for ${to} saved to ${where} - ${r.smtpError
        ? `the mail server did not accept it (${r.smtpError})`
        : "no mail server is configured on this PC"}, so nothing was emailed.`)
    : `Qualified lead email to ${to} failed: ${r.error}`);
  return r;
}

module.exports = { sendEmail, emailQualifiedLead, deliverQualifiedLead };
