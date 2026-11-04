/* Mail from the PC must actually reach the operator's mailbox.
 *
 * The old sender dialed TLS for every port, wrote EHLO before reading the
 * server's 220 greeting, advanced one state-machine step per line (a
 * multi-line EHLO reply desynchronised the whole session), and wrapped the
 * envelope in the display name: `MAIL FROM:<Magic Dialer <addr>>`, which no
 * server accepts. Gmail is configured on 465, so the transport looked right
 * while the session was wrong - and a qualified lead is the one thing an
 * operator cannot regenerate.
 *
 * These tests speak to a real SMTP server over a real TLS socket (a
 * certificate generated in-process, never committed):
 *
 *  1. implicit TLS (465): greeting is read before EHLO, AUTH LOGIN, bare
 *     envelope addresses, dot-stuffed body.
 *  2. STARTTLS (587): no credentials before the upgrade, EHLO repeated after
 *     it, AUTH PLAIN.
 *  3. a server without STARTTLS is refused and no credentials are sent.
 *  4. a rejected recipient is reported, not swallowed.
 */
const assert = require("node:assert");
const crypto = require("node:crypto");
const net = require("node:net");
const tls = require("node:tls");

const { sendEmail } = require("./email");

/* --- a self-signed certificate, built in memory ------------------------- */

function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v = Math.floor(v / 256); }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}
function seq(...parts) { return tlv(0x30, Buffer.concat(parts)); }
function setOf(...parts) { return tlv(0x31, Buffer.concat(parts)); }
function integer(value) {
  let b = Buffer.isBuffer(value) ? value : Buffer.from([value]);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
function objectId(dotted) {
  const parts = dotted.split(".").map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const enc = [];
    let v = part;
    do { enc.unshift(v & 0x7f); v = Math.floor(v / 128); } while (v > 0);
    for (let i = 0; i < enc.length - 1; i++) enc[i] |= 0x80;
    out.push(...enc);
  }
  return tlv(0x06, Buffer.from(out));
}
function utf8String(s) { return tlv(0x0c, Buffer.from(s, "utf8")); }
function utcTime(date) {
  const p = (n) => String(n).padStart(2, "0");
  return tlv(0x17, Buffer.from(
    `${p(date.getUTCFullYear() % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`, "ascii"));
}

function makeCertificate() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sha256WithRsa = seq(objectId("1.2.840.113549.1.1.11"), tlv(0x05, Buffer.alloc(0)));
  const name = seq(setOf(seq(objectId("2.5.4.3"), utf8String("localhost"))));
  const now = Date.now();
  const san = seq(
    tlv(0x82, Buffer.from("localhost", "ascii")), // dNSName
    tlv(0x87, Buffer.from([127, 0, 0, 1])),        // iPAddress
  );
  const extensions = tlv(0xa3, seq(seq(objectId("2.5.29.17"), tlv(0x04, san))));
  const tbs = seq(
    tlv(0xa0, integer(2)),
    integer(crypto.randomBytes(16)),
    sha256WithRsa,
    name,
    seq(utcTime(new Date(now - 3600e3)), utcTime(new Date(now + 10 * 365 * 24 * 3600e3))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const signature = crypto.sign("sha256", tbs, privateKey);
  const certificate = seq(tbs, sha256WithRsa, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  // Refuse to test against something Node itself will not parse.
  const parsed = new crypto.X509Certificate(certificate);
  assert.match(parsed.subject, /CN=localhost/);
  return {
    cert: parsed.toString(),
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
    ca: parsed.toString(),
  };
}

/* --- a scripted SMTP peer ----------------------------------------------- */

async function startServer(options = {}) {
  const cfg = {
    implicitTls: false,
    offerStartTls: true,
    advertiseAuth: true,
    greetingDelayMs: 0,
    rejectRcpt: false,
    ...options,
  };
  const identity = makeCertificate();
  const seen = {
    commands: [], auth: [], mailFrom: null, rcptTo: [], data: "",
    connectedAt: 0, greetedAt: 0, firstCommandAt: 0, upgraded: false,
  };
  const sockets = new Set();

  const protocol = (socket, upgraded) => {
    let buf = "";
    let inData = false;
    let authStep = 0;
    const write = (line) => { if (!socket.destroyed) socket.write(line + "\r\n"); };
    const greet = () => { seen.greetedAt = Date.now(); write("220 localhost ESMTP ready"); };
    /* Only a fresh connection gets a greeting; the upgraded socket is the same
     * session and must not speak out of turn. */
    if (!upgraded) {
      if (cfg.greetingDelayMs) setTimeout(greet, cfg.greetingDelayMs); else greet();
    }

    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let cut;
      while ((cut = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        if (inData) {
          if (line === ".") { inData = false; write("250 2.0.0 Ok: queued as test"); }
          else seen.data += line + "\n";
          continue;
        }
        seen.commands.push(line);
        if (!seen.firstCommandAt) seen.firstCommandAt = Date.now();
        const upper = line.toUpperCase();

        if (upper.startsWith("EHLO ") || upper.startsWith("HELO ")) {
          const lines = ["localhost", "SIZE 35882577"];
          if (cfg.offerStartTls && !cfg.implicitTls && !upgraded) lines.push("STARTTLS");
          if (cfg.advertiseAuth) lines.push("AUTH LOGIN PLAIN");
          lines.push("8BITMIME");
          lines.forEach((entry, i) => write(`250${i === lines.length - 1 ? " " : "-"}${entry}`));
        } else if (upper === "STARTTLS") {
          write("220 2.0.0 Ready to start TLS");
          socket.removeAllListeners("data");
          const secure = new tls.TLSSocket(socket, { isServer: true, key: identity.key, cert: identity.cert });
          secure.on("error", () => {});
          seen.upgraded = true;
          protocol(secure, true);
        } else if (upper === "AUTH LOGIN") {
          authStep = 1;
          write("334 VXNlcm5hbWU6");
        } else if (authStep === 1) {
          seen.auth.push(Buffer.from(line, "base64").toString("utf8"));
          authStep = 2;
          write("334 UGFzc3dvcmQ6");
        } else if (authStep === 2) {
          seen.auth.push(Buffer.from(line, "base64").toString("utf8"));
          authStep = 0;
          write("235 2.7.0 Accepted");
        } else if (upper.startsWith("AUTH PLAIN ")) {
          const parts = Buffer.from(line.slice(11).trim(), "base64").toString("utf8").split("\0");
          seen.auth.push(parts[1], parts[2]);
          write("235 2.7.0 Accepted");
        } else if (upper.startsWith("MAIL FROM:")) {
          seen.mailFrom = line;
          write("250 2.1.0 Ok");
        } else if (upper.startsWith("RCPT TO:")) {
          seen.rcptTo.push(line);
          write(cfg.rejectRcpt ? "550 5.1.1 No such user here" : "250 2.1.5 Ok");
        } else if (upper === "DATA") {
          inData = true;
          write("354 End data with <CR><LF>.<CR><LF>");
        } else if (upper === "QUIT") {
          write("221 2.0.0 Bye");
          socket.end();
        } else {
          write("250 2.0.0 Ok");
        }
      }
    });
  };

  const server = cfg.implicitTls
    ? tls.createServer({ key: identity.key, cert: identity.cert }, (socket) => {
      seen.connectedAt = Date.now();
      sockets.add(socket);
      socket.on("error", () => {});
      protocol(socket, false);
    })
    : net.createServer((socket) => {
      seen.connectedAt = Date.now();
      sockets.add(socket);
      socket.on("error", () => {});
      protocol(socket, false);
    });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    port: server.address().port,
    ca: identity.ca,
    seen,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) { try { socket.destroy(); } catch {} }
      server.close(() => resolve());
    }),
  };
}

const base = {
  user: "u@example.com",
  pass: "s3cret",
  from: "Magic Dialer <owner@example.com>",
  to: "Ops <ops@example.com>",
  subject: "New lead",
  text: "First line\n.dot line",
};

async function testImplicitTls() {
  const server = await startServer({ implicitTls: true, greetingDelayMs: 150 });
  try {
    const r = await sendEmail({ ...base, host: "localhost", port: server.port, secure: true, ca: server.ca });
    assert.equal(r.ok, true, r.error);
    const s = server.seen;
    assert.equal(s.mailFrom, "MAIL FROM:<owner@example.com>", "envelope sender must be the bare address");
    assert.deepEqual(s.rcptTo, ["RCPT TO:<ops@example.com>"], "envelope recipient must be the bare address");
    assert.deepEqual(s.auth, ["u@example.com", "s3cret"]);
    assert.match(s.data, /^From: Magic Dialer <owner@example\.com>$/m);
    assert.match(s.data, /^\.\.dot line$/m, "a leading dot must be stuffed");
    /* The greeting is written first; the client may not send anything until
     * it has read it. */
    assert.ok(s.greetedAt > 0);
    assert.ok(s.firstCommandAt >= s.greetedAt, "EHLO was sent before the 220 greeting");
    assert.ok(s.firstCommandAt - s.connectedAt >= 140, "the client spoke before the greeting arrived");
  } finally {
    await server.close();
  }
}

async function testStartTls() {
  const server = await startServer({ implicitTls: false, offerStartTls: true });
  try {
    const r = await sendEmail({ ...base, host: "localhost", port: server.port, secure: false, ca: server.ca });
    assert.equal(r.ok, true, r.error);
    const s = server.seen;
    assert.equal(s.upgraded, true, "the session was not upgraded");
    assert.deepEqual(s.auth, ["u@example.com", "s3cret"]);
    assert.equal(s.mailFrom, "MAIL FROM:<owner@example.com>");
    const startTlsAt = s.commands.findIndex((line) => /^STARTTLS$/i.test(line));
    const firstAuth = s.commands.findIndex((line) => /^AUTH /i.test(line));
    assert.ok(startTlsAt >= 0, "STARTTLS was never sent");
    assert.ok(firstAuth > startTlsAt, "credentials were offered before the TLS upgrade");
    assert.equal(s.commands.filter((line) => /^EHLO /i.test(line)).length, 2, "EHLO must be repeated after the upgrade");
  } finally {
    await server.close();
  }
}

async function testPlaintextIsRefused() {
  const server = await startServer({ implicitTls: false, offerStartTls: false });
  try {
    const r = await sendEmail({ ...base, host: "localhost", port: server.port, secure: false });
    assert.equal(r.ok, false);
    assert.match(r.error, /STARTTLS/i);
    assert.equal(server.seen.auth.length, 0, "credentials leaked over plaintext");
    assert.equal(server.seen.mailFrom, null, "a message was sent over plaintext");
    assert.ok(!server.seen.commands.some((line) => /^AUTH /i.test(line)));
  } finally {
    await server.close();
  }
}

async function testRejectedRecipient() {
  const server = await startServer({ implicitTls: true, rejectRcpt: true });
  try {
    const r = await sendEmail({ ...base, host: "localhost", port: server.port, secure: true, ca: server.ca });
    assert.equal(r.ok, false);
    assert.match(r.error, /550/);
    assert.equal(server.seen.data, "", "message body was sent after the recipient was refused");
  } finally {
    await server.close();
  }
}

(async () => {
  await testImplicitTls();
  await testStartTls();
  await testPlaintextIsRefused();
  await testRejectedRecipient();
  console.log("PASS: SMTP transport reads the greeting, upgrades to TLS before AUTH, and sends a bare envelope");
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
