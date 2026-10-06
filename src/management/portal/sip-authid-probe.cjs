"use strict";

/* Why the PC could not register.
 *
 * voip-test.js proves the configured line is rejected:
 *   FAIL  SIP REGISTER rejected - bad credentials (sip40.ringcentral.com as +14807166685)  (403)
 *
 * The credentials come from rc-credentials.json, where sipAuthId is
 * "805626843019" - but that is the RingCentral *API* auth account id (the same
 * number used for the JWT audience in trunk.js). RingCentral SIP authenticates
 * against the extension, and the same file records extensionNumber "102".
 *
 * This probes the plausible (username, authId) pairs with a REGISTER only. It
 * places no calls and sends no INVITE.
 */
const tls = require("node:tls");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const creds = JSON.parse(fs.readFileSync(path.join(__dirname, "rc-credentials.json"), "utf8"));
const USER = process.env.V_USER || creds.sipUsername;
const PASS = process.env.V_PASS || creds.sipPassword;
const DOMAIN = creds.sipDomain;
const PROXY = `${creds.sipProxy}:${creds.sipPort}`;

const candidates = [
  { label: "configured (API authId)", user: USER, authId: creds.sipAuthId },
  { label: "extension number", user: USER, authId: creds.extensionNumber },
  { label: "extension id", user: USER, authId: creds.extensionId },
  { label: "authId = username", user: USER, authId: USER },
  { label: "extension number as username", user: creds.extensionNumber, authId: creds.extensionNumber },
  { label: "extension id as username", user: creds.extensionId, authId: creds.extensionId },
];

function parseAuth(header) {
  const out = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(header))) out[m[1]] = m[2];
  return out;
}

function register({ user, authId }) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: creds.sipProxy, port: creds.sipPort, servername: DOMAIN, rejectUnauthorized: false }, () => {
      const a = Buffer.from(`${authId}:${PASS}`).toString("base64");
      socket.write(
        `REGISTER sip:${DOMAIN} SIP/2.0\r\n` +
        `Via: SIP/2.0/TLS ${creds.sipProxy}:${creds.sipPort};branch=z9hG4bK-${crypto.randomBytes(6).toString("hex")}\r\n` +
        `Max-Forwards: 70\r\n` +
        `From: <sip:${authId}@${DOMAIN}>;tag=${crypto.randomBytes(4).toString("hex")}\r\n` +
        `To: <sip:${authId}@${DOMAIN}>\r\n` +
        `Call-ID: ${crypto.randomBytes(12).toString("hex")}@${creds.sipProxy}\r\n` +
        `CSeq: 1 REGISTER\r\n` +
        `Contact: <sip:${authId}@${creds.sipProxy}:${creds.sipPort};transport=tls>\r\n` +
        `Authorization: Digest username="${user}", realm="${DOMAIN}", nonce="probe", uri="sip:${DOMAIN}", response="${a}", algorithm=MD5\r\n` +
        `Content-Length: 0\r\n\r\n`
      );
    });
    let buf = "";
    const done = (result) => { try { socket.destroy(); } catch {} resolve(result); };
    const timer = setTimeout(() => done({ ok: false, why: "timeout" }), 12000);
    socket.on("error", (e) => { clearTimeout(timer); done({ ok: false, why: e.message }); });
    socket.on("data", (d) => {
      buf += d.toString("utf8");
      // A REGISTER answers 100 Trying first. Keep reading until a FINAL response
      // (>=200) arrives, or we would score every attempt as a failure.
      const final = [...buf.matchAll(/^SIP\/2\.0 (\d{3}) ([^\r\n]*)/gm)]
        .filter((m) => Number(m[1]) >= 200)
        .pop();
      if (final) { clearTimeout(timer); done({ ok: final[1] === "200", code: final[1], why: final[2] }); }
    });
  });
}

(async () => {
  console.log(`REGISTER-only probe for ${creds.sipProxy}:${creds.sipPort}. No INVITE, no calls.\n`);
  for (const c of candidates) {
    const r = await register(c);
    const verdict = r.ok ? "PASS  registered" : `FAIL  ${r.code || ""} ${r.why}`.trim();
    console.log(`  ${c.label.padEnd(32)} user=${String(c.user).padEnd(14)} authId=${String(c.authId).padEnd(14)} ${verdict}`);
  }
})();