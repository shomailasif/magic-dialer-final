#!/usr/bin/env node
"use strict";

/* The vendor's admin console. This file lives in scripts/ and is never
 * bundled into the customer engine (build/bundle.js starts at agent/agent.js),
 * so no customer installer can contain it, even by accident.
 *
 * Why it exists: the licence tool was a command line that could only create a
 * key, print it and revoke it. Running a business needs three more words -
 * "suspend them for non-payment", "put them back on", "cancel that one" - and
 * a page beats remembering flags under pressure.
 *
 * The gate is the signing key, not a password:
 *
 *   - It refuses to start at all unless licenses/license.private.key exists.
 *     That key is gitignored, never in the installer and never in the repo, so
 *     "can run the console" and "is the vendor's PC" are the same question.
 *   - It binds 127.0.0.1 only. There is no remote admin, by construction, not
 *     by a setting somebody can flip.
 *   - Every API call needs a per-run token, printed in the URL. A random web
 *     page cannot drive it just because it guessed the port.
 *
 * What each action really does:
 *
 *   create    signs a licence for one activation code. The key is shown once.
 *   suspend   adds the licence id to licenses/suspended.json and pushes.
 *             Reversible: the customer sees "suspended - payment outstanding".
 *   reinstate removes that id and pushes. Their next check resumes calling.
 *   cancel    adds the id to licenses/revoked.json, removes any suspension and
 *             pushes. Permanent: the customer sees "cancelled".
 *   renew     re-signs the SAME id with a new expiry. A suspended account stays
 *             suspended until it is explicitly reinstated, so paying and being
 *             switched back on remain two separate, deliberate acts.
 *
 * Run:  node scripts/admin-server.cjs
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const lib = require("./license-lib.cjs");

const HOST = "127.0.0.1";
const DEFAULT_PORT = Number(process.env.ADMIN_PORT) || 48772;
const BODY_LIMIT = 64 * 1024;
const TOKEN_HEADER = "x-admin-token";

let TOKEN = "";
let ACTIVE_PORT = DEFAULT_PORT;
let publicKeyB64 = "";

/* A thrown error, not process.exit, so the tests can assert the refusal and
 * the CLI can decide how to print it. */
function refusal(message) {
  const err = new Error(message);
  err.code = "ADMIN_REFUSED";
  return err;
}

/* ─────────────────────────────── actions ─────────────────────────────── */

function clean(body) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

function doAction(name, raw) {
  const b = clean(raw);
  const push = b.publish !== false && b.publish !== "false";
  switch (name) {
    case "create": {
      const created = lib.createGrant({
        name: b.name,
        machineId: b.machineId,
        plan: b.plan,
        days: b.days,
        until: b.until,
      });
      return {
        ok: true,
        id: created.payload.id,
        until: created.payload.until,
        key: created.key,
        grant: created.grant,
      };
    }
    case "suspend": {
      const r = lib.suspendGrant({ id: b.id, reason: b.reason, push });
      return { ok: true, grant: r.grant, publication: r.publication };
    }
    case "reinstate": {
      const r = lib.reinstateGrant({ id: b.id, push });
      return { ok: true, grant: r.grant, publication: r.publication };
    }
    case "cancel": {
      if (b.confirm !== true && b.confirm !== "true") {
        throw new Error("cancellation is permanent - confirm it in the console");
      }
      const r = lib.cancelGrant({ id: b.id, reason: b.reason, push });
      return { ok: true, grant: r.grant, publication: r.publication };
    }
    case "renew": {
      const r = lib.renewGrant({ id: b.id, days: b.days, until: b.until, push });
      return { ok: true, id: r.payload.id, until: r.payload.until, key: r.key, grant: r.grant };
    }
    default:
      throw new Error("unknown action: " + name);
  }
}

/* ──────────────────────────────── http ───────────────────────────────── */

function send(res, status, body, type = "application/json; charset=utf-8") {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new Error("request too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("body is not JSON")); }
    });
    req.on("error", reject);
  });
}

function authorised(req, url) {
  if (req.headers[TOKEN_HEADER] === TOKEN) return true;
  /* The initial page load cannot set a header; it carries the token in the
   * query instead, and the token is injected into the page it returns. */
  if (req.method === "GET" && url.pathname === "/" && url.searchParams.get("t") === TOKEN) return true;
  return false;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl, or a local tool - the token still applies
  return origin === `http://${HOST}:${ACTIVE_PORT}` || origin === `http://localhost:${ACTIVE_PORT}`;
}

async function handle(req, res) {
  try {
    const url = new URL(req.url || "/", `http://${HOST}:${ACTIVE_PORT}`);

    if (!sameOrigin(req)) return send(res, 403, { ok: false, error: "cross-origin request refused" });
    if (!authorised(req, url)) {
      return send(res, 401, {
        ok: false,
        error: "not authorised - open the URL printed by the console, including its ?t= token",
      });
    }

    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, page(TOKEN, ACTIVE_PORT), "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      const grants = lib.listGrants();
      return send(res, 200, {
        ok: true,
        grants,
        revoked: lib.readRevoked().revoked,
        suspended: lib.readSuspended().suspended,
        keyFingerprint: crypto.createHash("sha256").update(publicKeyB64).digest("hex").slice(0, 16),
        port: ACTIVE_PORT,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/action") {
      const body = await readBody(req);
      if (!body || typeof body.action !== "string") return send(res, 400, { ok: false, error: "missing action" });
      try {
        return send(res, 200, doAction(body.action, body));
      } catch (e) {
        return send(res, 400, { ok: false, error: (e && e.message) || "action failed" });
      }
    }

    return send(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    return send(res, 500, { ok: false, error: (e && e.message) || "server error" });
  }
}

/* ───────────────────────────────  start  ─────────────────────────────── */

function start({ port = DEFAULT_PORT } = {}) {
  /* The one gate that matters. Anything that can sign a licence can run a
   * business; anything that cannot has no business here. Checked before the
   * port is opened, so there is never a window where the page exists without
   * a key behind it. */
  if (!fs.existsSync(lib.PRIVATE_KEY_PATH)) {
    throw refusal(
      "No signing key at:\n" + lib.PRIVATE_KEY_PATH + "\n\n" +
      "This console is vendor-only. Create the key on YOUR PC with:\n" +
      "  node scripts/license-grant.cjs keygen --embed\n\n" +
      "If this is a customer PC, that is the correct answer: it has no key, so it\n" +
      "cannot issue, suspend or cancel anybody's subscription."
    );
  }

  /* A per-run token, not a stored password. Restarting the console rotates it,
   * which is fine: the URL is printed for the person who started it. */
  TOKEN = crypto.randomBytes(24).toString("hex");
  try {
    publicKeyB64 = lib.loadPrivateKey().publicB64;
  } catch (e) {
    throw refusal("The signing key exists but cannot be read:\n" + (e && e.message));
  }

  const server = http.createServer(handle);

  return new Promise((resolve, reject) => {
    server.once("error", (e) => {
      if (e && e.code === "EADDRINUSE") {
        return reject(refusal(`port ${port} is already in use - the console may already be running.\nOpen the URL it printed, or set ADMIN_PORT to another port.`));
      }
      reject(e);
    });
    server.listen(port, HOST, () => {
      ACTIVE_PORT = server.address().port;
      resolve({
        server,
        port: ACTIVE_PORT,
        token: TOKEN,
        url: `http://${HOST}:${ACTIVE_PORT}/?t=${TOKEN}`,
      });
    });
  });
}

module.exports = { start, HOST, DEFAULT_PORT };

if (require.main === module) {
  Promise.resolve()
    .then(() => start())
    .then(({ server, port, url }) => {
      console.log("");
      console.log("MAGIC DIALER - ADMIN CONSOLE (this PC only)");
      console.log("-".repeat(70));
      console.log("  " + url);
      console.log("");
      console.log("  signing key : " + lib.PRIVATE_KEY_PATH + "  (present, never published)");
      console.log("  binding     : " + HOST + ":" + port + "  (loopback only)");
      console.log("");
      console.log("  The token in the URL is new every run. Keep this window open;");
      console.log("  closing it (Ctrl+C) shuts the console and invalidates the token.");
      console.log("");
      const stop = () => server.close(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    })
    .catch((e) => {
      console.error("\nADMIN CONSOLE NOT STARTED\n");
      console.error(String((e && e.message) || e).split("\n").map((l) => "  " + l).join("\n"));
      console.error("");
      process.exit(1);
    });
}

/* ───────────────────────────────  page  ───────────────────────────────── */

function page(token, port) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Magic Dialer - Admin</title>
<style>
  :root{color-scheme:dark;--bg:#0d1117;--panel:#161b22;--line:#30363d;--ink:#e6edf3;--dim:#8b949e;--ok:#3fb950;--warn:#d29922;--err:#f85149;--accent:#58a6ff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  header{padding:18px 24px;border-bottom:1px solid var(--line);display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}
  h1{font-size:17px;margin:0;font-weight:600}
  header .tag{font-size:12px;color:var(--dim)}
  main{max-width:1180px;margin:0 auto;padding:24px}
  section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px;margin-bottom:20px}
  h2{font-size:14px;margin:0 0 14px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}
  label{display:block;font-size:12px;color:var(--dim);margin-bottom:4px}
  input,select{width:100%;background:#0d1117;border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:8px 10px;font:inherit}
  input:focus,select:focus{outline:2px solid var(--accent);outline-offset:-1px}
  .row{display:grid;grid-template-columns:2fr 2fr 1fr 1fr;gap:12px;align-items:end}
  .row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;align-items:end}
  button{font:inherit;border-radius:6px;border:1px solid var(--line);background:#21262d;color:var(--ink);padding:8px 14px;cursor:pointer}
  button:hover{background:#30363d}
  button.primary{background:#1f6feb;border-color:#1f6feb}
  button.primary:hover{background:#388bfd}
  button.danger{border-color:#5a1e1e;color:#ffb3ad}
  button.danger:hover{background:#3b1a1a}
  button.small{padding:4px 9px;font-size:12px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{padding:9px 10px;text-align:left;border-bottom:1px solid var(--line);vertical-align:middle}
  th{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em}
  tr:last-child td{border-bottom:none}
  .mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}
  .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;border:1px solid}
  .active{color:var(--ok);border-color:#1f4428;background:#0f2417}
  .suspended{color:var(--warn);border-color:#4a3a12;background:#2a2110}
  .expired{color:var(--dim);border-color:var(--line)}
  .cancelled{color:var(--err);border-color:#5a1e1e;background:#2a1214}
  .keybox{display:none;margin-top:14px;padding:14px;border:1px solid #1f4428;border-radius:8px;background:#0f2417}
  .keybox.show{display:block}
  .keybox textarea{width:100%;height:88px;background:#0d1117;color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:10px;font-family:ui-monospace,Consolas,monospace;font-size:12px}
  .msg{margin-top:12px;font-size:13px;display:none;white-space:pre-wrap}
  .msg.show{display:block}
  .msg.ok{color:var(--ok)} .msg.err{color:var(--err)} .msg.warn{color:var(--warn)}
  .muted{color:var(--dim);font-size:12px}
  .actions{display:flex;gap:6px;flex-wrap:wrap}
  .empty{padding:18px;color:var(--dim);font-size:13px}
  @media(max-width:820px){.row,.row3{grid-template-columns:1fr}main{padding:14px}}
</style></head>
<body>
<header>
  <h1>Magic Dialer - Admin</h1>
  <span class="tag">this PC only &middot; signed with your private key &middot; port ${port}</span>
</header>
<main>

<section>
  <h2>New customer</h2>
  <div class="row">
    <div><label for="cName">Account name</label><input id="cName" placeholder="Zaz Logistics"></div>
    <div><label for="cMachine">Activation code (from their dashboard)</label><input id="cMachine" class="mono" placeholder="d83d2452-..."></div>
    <div><label for="cPlan">Plan</label><input id="cPlan" placeholder="standard" value="standard"></div>
    <div><label for="cDays">Days</label><input id="cDays" type="number" min="1" value="30"></div>
  </div>
  <div style="margin-top:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <button class="primary" id="createBtn">Create licence</button>
    <label style="display:flex;gap:7px;align-items:center;margin:0;color:var(--dim);font-size:12px"><input type="checkbox" id="publishBox" checked style="width:auto"> publish the stop lists to GitHub</label>
  </div>
  <div class="msg" id="createMsg"></div>
  <div class="keybox" id="keyBox">
    <div style="font-size:12px;color:var(--dim);margin-bottom:8px">Send this key to the customer. It is shown once; the ledger keeps only its id.</div>
    <textarea id="keyText" readonly></textarea>
    <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
      <button class="small" id="copyKey">Copy key</button>
      <span class="muted" id="keyMeta"></span>
    </div>
  </div>
</section>

<section>
  <h2>Accounts</h2>
  <div id="list"><div class="empty">Loading...</div></div>
  <div class="msg" id="listMsg"></div>
</section>

<section>
  <h2>Renew one account</h2>
  <div class="row3">
    <div><label for="rId">Licence id</label><input id="rId" class="mono" placeholder="pick one from the table"></div>
    <div><label for="rDays">Days</label><input id="rDays" type="number" min="1" value="30"></div>
    <div><button id="renewBtn">Renew</button></div>
  </div>
  <div class="msg" id="renewMsg"></div>
</section>

</main>
<script>
const TOKEN = ${JSON.stringify(token)};
const $ = (id) => document.getElementById(id);

function say(el, text, kind) {
  el.textContent = text || "";
  el.className = "msg show " + (kind || "");
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
async function api(action, body) {
  const r = await fetch("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": TOKEN },
    body: JSON.stringify(Object.assign({ action, publish: $("publishBox").checked }, body || {})),
  });
  const d = await r.json().catch(() => ({ ok: false, error: "unreadable reply" }));
  if (!r.ok || !d.ok) throw new Error(d.error || ("HTTP " + r.status));
  return d;
}
function publishNote(p) {
  if (!p) return "";
  if (p.pushed) return "\\nPublished: pushed to main. Their PC stops or resumes on its next check (a few minutes for the raw file cache).";
  if (p.reason === "no change to publish" || p.reason === "nothing public changed" || p.reason === "push disabled") return "";
  return "\\nNOT PUBLISHED: " + p.reason + "\\nThe file is changed locally but their PC will not see it until this is pushed.";
}
function badge(state) {
  const s = String(state || "");
  return '<span class="badge ' + esc(s) + '">' + esc(s || "?") + "</span>";
}
function date(s) { return s ? String(s).slice(0, 10) : "never"; }

async function load() {
  const r = await fetch("/api/state", { headers: { "x-admin-token": TOKEN } });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || "could not read state");
  const rows = d.grants.slice().sort((a, b) => String(b.grantedAt).localeCompare(String(a.grantedAt)));
  if (!rows.length) { $("list").innerHTML = '<div class="empty">No licences yet. Create one above.</div>'; return; }
  $("list").innerHTML = '<table><thead><tr><th>State</th><th>Account</th><th>Expires</th><th>Activation code</th><th>Licence id</th><th>Actions</th></tr></thead><tbody>'
    + rows.map((g) => '<tr>'
      + "<td>" + badge(g.state) + "</td>"
      + "<td>" + esc(g.name) + '<div class="muted">' + esc(g.plan || "") + "</div></td>"
      + "<td>" + esc(date(g.until)) + "</td>"
      + '<td class="mono">' + esc(g.machineId) + "</td>"
      + '<td class="mono">' + esc(String(g.id).slice(0, 8)) + "&hellip;</td>"
      + '<td><div class="actions">'
      + (g.state === "suspended"
          ? '<button class="small" data-act="reinstate" data-id="' + esc(g.id) + '">Reinstate</button>'
          : (g.state === "cancelled" ? "" : '<button class="small" data-act="suspend" data-id="' + esc(g.id) + '">Suspend</button>'))
      + (g.state === "cancelled" ? "" : '<button class="small" data-act="renew" data-id="' + esc(g.id) + '">Renew</button>')
      + (g.state === "cancelled" ? "" : '<button class="small danger" data-act="cancel" data-id="' + esc(g.id) + '">Cancel</button>')
      + "</div></td></tr>").join("")
    + "</tbody></table>";
  $("list").querySelectorAll("button[data-act]").forEach((b) => {
    b.addEventListener("click", () => rowAction(b.dataset.act, b.dataset.id, b.closest("tr").querySelector("td:nth-child(2)").textContent.trim()));
  });
}

async function rowAction(act, id, name) {
  try {
    if (act === "suspend") {
      if (!confirm("Suspend " + name + " for non-payment?\\n\\nThey stop calling, and you can put them back with Reinstate.")) return;
      const d = await api("suspend", { id, reason: "payment not received" });
      say($("listMsg"), "Suspended " + name + "." + publishNote(d.publication), "ok");
    } else if (act === "reinstate") {
      const d = await api("reinstate", { id });
      say($("listMsg"), "Reinstated " + name + "." + publishNote(d.publication), "ok");
    } else if (act === "cancel") {
      if (!confirm("Cancel " + name + " permanently?\\n\\nThis is the terminal state: the console has no un-cancel.\\nSuspend is the reversible option for late payment.")) return;
      const d = await api("cancel", { id, confirm: true, reason: "subscription cancelled" });
      say($("listMsg"), "Cancelled " + name + "." + publishNote(d.publication), "ok");
    } else if (act === "renew") {
      $("rId").value = id;
      $("renewMsg").className = "msg show warn";
      $("renewMsg").textContent = "Renew " + name + ": set the days above, then press Renew. A suspended account stays suspended until you Reinstate it.";
      $("rId").scrollIntoView({ behavior: "smooth", block: "center" });
      $("rDays").focus();
      return;
    }
    await load();
  } catch (e) {
    say($("listMsg"), e.message, "err");
  }
}

$("createBtn").addEventListener("click", async () => {
  const name = $("cName").value.trim();
  const machineId = $("cMachine").value.trim();
  const plan = $("cPlan").value.trim();
  const days = Number($("cDays").value);
  if (!machineId) return say($("createMsg"), "Paste the activation code from the customer's dashboard.", "err");
  if (!(days > 0)) return say($("createMsg"), "Days must be greater than zero.", "err");
  try {
    const d = await api("create", { name, machineId, plan, days });
    $("keyText").value = d.key;
    $("keyBox").classList.add("show");
    $("keyMeta").textContent = "Expires " + date(d.until) + " - licence id " + d.id;
    say($("createMsg"), "Licence created for " + (name || "this account") + ". Copy the key now; it is not stored anywhere.", "ok");
    $("cName").value = ""; $("cMachine").value = "";
    await load();
  } catch (e) {
    say($("createMsg"), e.message, "err");
  }
});

$("copyKey").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("keyText").value);
    say($("createMsg"), "Key copied to the clipboard.", "ok");
  } catch {
    $("keyText").select();
    say($("createMsg"), "Press Ctrl+C to copy the selected key.", "warn");
  }
});

$("renewBtn").addEventListener("click", async () => {
  const id = $("rId").value.trim();
  const days = Number($("rDays").value);
  if (!id) return say($("renewMsg"), "Enter or click a licence id.", "err");
  if (!(days > 0)) return say($("renewMsg"), "Days must be greater than zero.", "err");
  try {
    const d = await api("renew", { id, days });
    $("keyText").value = d.key;
    $("keyBox").classList.add("show");
    $("keyMeta").textContent = "Renewed to " + date(d.until) + " - licence id " + d.id;
    say($("renewMsg"), "Renewed. Send the new key; the old one keeps working until its old expiry." + publishNote(d.publication), "ok");
    await load();
  } catch (e) {
    say($("renewMsg"), e.message, "err");
  }
});

load().catch((e) => { $("list").innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; });
</script>
</body></html>`;
}
