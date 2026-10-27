"use strict";

/* Subscription gate for the engine.
 *
 * The product is sold as a subscription and the vendor must be able to stop a
 * copy that is not being paid for, without running a website. So there is no
 * server here at all: a licence is an offline signature the engine can verify
 * for itself, and revocation is a plain file the engine reads from a public
 * host.
 *
 * Two independent mechanisms, because they answer different questions:
 *
 *  1. Is this copy still inside its paid-for period?
 *     The licence carries an expiry date and is signed with Ed25519. Verified
 *     locally, needs no network, so a customer whose internet drops keeps
 *     working until their term actually ends.
 *
 *  2. Has this licence been stopped early - not paid, or cancelled?
 *     Only remote files can answer that. The engine reads two small public
 *     lists on a timer: suspended.json for a temporary hold (late payment,
 *     reversible) and revoked.json for a cancelled account (permanent).
 *     Granting is "sign a licence"; suspending is "add its id to one list and
 *     push"; reinstating is "remove it again". Seconds, no URL of the
 *     vendor's, nothing to host.
 *
 * WHY THIS FILE CONTAINS ONLY VERIFICATION
 *
 * Signing lives in scripts/ and is never bundled into the engine, so a
 * customer who extracts the binary cannot issue themselves a licence. All this
 * module can do is check one.
 *
 * WHAT IS IN THE PUBLIC FILE
 *
 * Only opaque licence ids and dates - never a key, a name, a phone number or
 * anything that reads back to a customer. A licence id is a random UUID that
 * means nothing without a matching signature, so publishing it authorises
 * nobody. Reading the whole list tells an attacker nothing they can use, and
 * the git history doubles as a tamper-evident record of every grant and
 * revocation.
 *
 * COPYING A LICENCE TO ANOTHER PC DOES NOT WORK
 *
 * The signed payload names a machineId, and the engine refuses any licence
 * issued to a different one. A paid-for install cannot be uninstalled and
 * re-used to seed a second machine: the licence stops matching.
 *
 * FAILING CLOSED, BUT NOT ON SOMEONE ELSE'S OUTAGE
 *
 * Blocking the revocation URL must not be a way to stay activated forever, so
 * an engine that cannot reach the list keeps working only for a grace window
 * measured from its last successful check - then stops. Blocking the file buys
 * you the grace window and no more. A hosting outage of a few hours, on the
 * other hand, never interrupts a paying customer.
 */

const crypto = require("node:crypto");

/* Your public verification key, base64 of a DER SPKI structure. It is meant to
 * be public: it can only ever check a licence, never create one. Anyone may
 * read it and it is useless to them.
 *
 * If this is ever wrong or missing, every licence fails signature checking -
 * fail closed, which is the right direction to fail.
 *
 * Held in a `let` for one reason: this suite must run on machines that have no
 * signing key, including CI, so a test can hand the verifier its own public key
 * and sign against a keypair it just made. _test.usePublicKey is that seam. It
 * grants an attacker nothing they do not already have - anyone who can edit the
 * loaded bundle can already delete the gate - and no production path calls it. */
let vendorPublicKeyB64 = "MCowBQYDK2VwAyEAZ74uPnE8ARIvDeMLELPQFLjGIiU6k18qC/aXpztK+yA=";

/* The revocation list. A public raw file, not a service of the vendor's: no
 * server to run, nothing to suspend, and it does not go down when the vendor's
 * PC does. Read once at startup: override with LICENSE_REVOCATION_URL for a
 * private mirror or for tests. */
const DEFAULT_REVOCATION_URL =
  process.env.LICENSE_REVOCATION_URL ||
  "https://raw.githubusercontent.com/shomailasif/magic-dialer-final/main/licenses/revoked.json";

/* A second public list for a temporary hold - the customer has not paid yet,
 * and the copy is meant to come back the moment they do. Kept apart from the
 * revocation list so the dashboard can say "suspended, pay to resume" instead
 * of "cancelled", which is what an account that is gone deserves. */
const DEFAULT_SUSPENSION_URL =
  process.env.LICENSE_SUSPENSION_URL ||
  "https://raw.githubusercontent.com/shomailasif/magic-dialer-final/main/licenses/suspended.json";

/* Licence strings are recognisable and self-describing so a truncated or
 * mangled paste is reported as such rather than as a mysterious failure. */
const PREFIX = "MDL1";

/* How long a copy may keep working when the revocation list cannot be read,
 * counted from the last time it WAS read. 72 hours: long enough that a
 * weekend of CDN trouble never stops a paying customer, short enough that a
 * suspended copy stops the same week. Override with LICENSE_GRACE_HOURS. */
const DEFAULT_GRACE_HOURS = 72;
function graceMs() {
  const h = Number(process.env.LICENSE_GRACE_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : DEFAULT_GRACE_HOURS) * 3600 * 1000;
}

/* How long a copy runs before it must be activated, measured from the moment
 * this engine first started on that PC.
 *
 * Two jobs in one window. It is the product promise - install it and it starts
 * working, no key needed to try it. And it is the safe way to introduce a gate
 * into installs that already exist: PCs in service before this code shipped get
 * the full window to be granted a licence, so nobody already paying is ever
 * interrupted by the upgrade. Nobody can sit in it forever, because it ends.
 *
 * Override with LICENSE_TRIAL_DAYS. Setting it to 0 demands a licence at once. */
const DEFAULT_TRIAL_DAYS = 7;
function trialDays() {
  const n = Number(process.env.LICENSE_TRIAL_DAYS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TRIAL_DAYS;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function b64url(buf) {
  return Buffer.from(buf).toString("base64");
}

function decodePayload(segment) {
  const json = Buffer.from(String(segment), "base64").toString("utf8");
  return JSON.parse(json);
}

function publicKey() {
  if (!vendorPublicKeyB64 || vendorPublicKeyB64.startsWith("__")) {
    throw new Error("licence public key is not configured");
  }
  return crypto.createPublicKey({
    key: Buffer.from(vendorPublicKeyB64, "base64"),
    format: "der",
    type: "spki",
  });
}

/* Split a licence string without trusting it. Every early return names why, so
 * the dashboard can tell a customer "this key is for a different PC" instead of
 * "activation failed". */
function parse(raw) {
  const text = String(raw || "").trim();
  if (!text) return { error: "missing", message: "No licence key entered." };
  const parts = text.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) {
    return { error: "format", message: "That is not a licence key. Keys start with MDL1 and look like MDL1.aaa.bbb." };
  }
  let payload;
  try {
    payload = decodePayload(parts[1]);
  } catch {
    return { error: "format", message: "That licence key is damaged - it was not copied in full." };
  }
  if (!payload || typeof payload !== "object" || typeof payload.id !== "string" || typeof payload.machineId !== "string") {
    return { error: "format", message: "That licence key is damaged - it is missing required fields." };
  }
  let ok = false;
  try {
    ok = crypto.verify(null, Buffer.from(parts[1], "utf8"), publicKey(), Buffer.from(parts[2], "base64"));
  } catch {
    ok = false;
  }
  if (!ok) {
    return { error: "signature", message: "That licence key is not genuine." };
  }
  return { payload, sigSegment: parts[1] };
}

/* Is this licence good for THIS machine, right now?
 * Order matters: signature before anything else, so a forged field is never
 * even read as authoritative. */
function verify(raw, machineId, now = Date.now()) {
  const parsed = parse(raw);
  if (parsed.error) return { ok: false, reason: parsed.error, message: parsed.message };

  const p = parsed.payload;
  if (String(machineId || "") !== String(p.machineId)) {
    return {
      ok: false,
      reason: "machine",
      message: "This licence key belongs to a different PC. Each PC needs its own key.",
    };
  }

  if (p.until !== null && p.until !== undefined && p.until !== "") {
    const until = Date.parse(p.until);
    if (!Number.isFinite(until)) {
      return { ok: false, reason: "format", message: "That licence key has an unreadable expiry date." };
    }
    if (now > until) {
      return {
        ok: false,
        reason: "expired",
        message: `This subscription ended on ${new Date(until).toISOString().slice(0, 10)}. Renew to keep calling.`,
        until,
      };
    }
  }

  return { ok: true, payload: p };
}

/* Read one public id list. Deliberately a plain GET of a static file: it
 * carries no licence, no machine id and no customer detail, so the host
 * serving it learns nothing about who is asking. */
async function fetchList(url, opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!fetchImpl) return { ok: false, error: "no fetch" };

  /* A cache-buster matters here: a revocation must not sit behind a CDN copy
   * from before it happened. raw.githubusercontent is cached, so an unchanged
   * URL can serve a stale list for minutes after you push. */
  const sep = String(url).includes("?") ? "&" : "?";
  const target = `${url}${sep}_=${Date.now()}`;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 8000;

  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(target, {
      headers: { "cache-control": "no-cache", pragma: "no-cache" },
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.text();
    const parsed = JSON.parse(body);
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed && parsed.revoked)
        ? parsed.revoked
        : Array.isArray(parsed && parsed.suspended)
          ? parsed.suspended
          : null;
    if (!list) return { ok: false, error: "malformed list" };
    return { ok: true, ids: new Set(list.map(String)), updated: (parsed && parsed.updated) || null };
  } catch (e) {
    return { ok: false, error: (e && e.message) || "fetch failed" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* The public lists, in the shape each caller already expects. `revoked.json`
 * means cancelled; `suspended.json` means held until payment. */
async function fetchRevoked(url = DEFAULT_REVOCATION_URL, opts = {}) {
  const r = await fetchList(url, opts);
  if (!r.ok) return r;
  return { ok: true, revoked: r.ids, updated: r.updated };
}

async function fetchSuspended(url = DEFAULT_SUSPENSION_URL, opts = {}) {
  const r = await fetchList(url, opts);
  if (!r.ok) return r;
  return { ok: true, suspended: r.ids, updated: r.updated };
}

/* Turn every input into one of a handful of states the dashboard can show.
 *
 * The two that need care:
 *   active   - genuinely fine, or inside the grace window on a failed fetch
 *   stale    - grace window exhausted on a failed fetch. Calling stops here,
 *              which is what stops "just block the URL" from being a permanent
 *              bypass: doing so lands you in this state after the window.
 *
 * Unlicensed / invalid / expired / suspended are all decided locally from the
 * signature itself, so they apply immediately and get no grace period - grace
 * exists to absorb someone else's outage, never to delay an actual stop. */
function evaluate({
  raw,
  machineId,
  now = Date.now(),
  revocation = null,       // { ok, revoked:Set, error } | null = not checked yet
  suspension = null,       // { ok, suspended:Set, error } | null = not checked yet
  lastVerifiedAt = 0,      // ms of the last successful revocation read
  grantTime = 0,           // ms when this licence was activated
  firstSeenAt = 0,         // ms when this engine first ran on this PC
  grace = graceMs(),
  trial = trialDays(),
}) {
  const text = String(raw || "").trim();

  /* No licence at all: this is the trial, not a failure. Checked before
   * verify() so an empty key reads as "not yet activated" rather than
   * "invalid key", and so the window counts from first run - which is what
   * protects copies already in service from being cut off by this upgrade. */
  if (!text) {
    const born = firstSeenAt || now;
    const windowMs = trial * DAY_MS;
    const left = born + windowMs - now;
    if (left > 0) {
      return {
        state: "trial",
        ok: true,
        message: trial === 0
          ? "Activation required."
          : `Trial: ${Math.max(1, Math.ceil(left / DAY_MS))} day(s) left before a licence key is required.`,
        payload: null,
        remainingMs: left,
      };
    }
    return {
      state: "unlicensed",
      ok: false,
      message: `The trial ended. Paste your licence key to resume calling.`,
      payload: null,
    };
  }

  const v = verify(raw, machineId, now);
  if (!v.ok) {
    return { state: v.reason, ok: false, message: v.message, payload: null };
  }

  /* No revocation result yet means we have not attempted a check since this
   * licence was installed. Treat activation itself as the starting point, so a
   * brand new install is not blocked before it has ever been online. */
  const reference = lastVerifiedAt || grantTime || now;
  const age = now - reference;
  const id = String(v.payload.id);

  /* Two public answers, checked in this order. Cancelled wins: an account that
   * is gone must never display as merely overdue, because "suspended" invites
   * the customer to wait for a reinstatement that is not coming. */
  if (revocation && revocation.ok && revocation.revoked && revocation.revoked.has(id)) {
    return {
      state: "cancelled",
      ok: false,
      message: "This subscription has been cancelled. Contact your provider if you believe this is a mistake.",
      payload: v.payload,
    };
  }
  if (suspension && suspension.ok && suspension.suspended && suspension.suspended.has(id)) {
    return {
      state: "suspended",
      ok: false,
      message: "This subscription is suspended while a payment is outstanding. Calling resumes as soon as your provider reinstates it.",
      payload: v.payload,
    };
  }

  /* Both lists read successfully: nothing is held against this licence. */
  const verified = Boolean(revocation && revocation.ok) && (!suspension || suspension.ok === true);
  if (verified) {
    return { state: "active", ok: true, message: "Subscription active.", payload: v.payload };
  }

  /* A list could not be read. Inside the window we carry on - but say so,
   * because silently pretending to be verified is how a stale licence becomes
   * invisible. Past it, stop. */
  if (age <= grace) {
    const why = (revocation && !revocation.ok && revocation.error) ||
      (suspension && !suspension.ok && suspension.error) ||
      "no result";
    return {
      state: "checking",
      ok: true,
      message: `Subscription could not be re-checked (${why}); working for another ${Math.max(1, Math.ceil((grace - age) / DAY_MS))} day(s).`,
      payload: v.payload,
      remainingMs: grace - age,
    };
  }
  return {
    state: "stale",
    ok: false,
    message: `Subscription not verified for ${Math.floor(age / DAY_MS)} day(s) - calling is paused. Restore internet access to resume.`,
    payload: v.payload,
  };
}

/* The message the dashboard shows, and a status the badge renderer knows. */
function display(state) {
  switch (state) {
    case "active": return { status: "ONLINE", line: "Subscription active." };
    case "trial": return { status: "ONLINE", line: null };
    case "checking": return { status: "OFFLINE", line: null };
    case "unlicensed": return { status: "UNLICENSED", line: "Not activated - paste your licence key to start calling." };
    case "suspended": return { status: "SUSPENDED", line: "Subscription suspended - payment is outstanding. It resumes when your provider reinstates it." };
    case "cancelled": return { status: "CANCELLED", line: "Subscription cancelled - this PC will no longer place calls." };
    case "stale": return { status: "SUSPENDED", line: null };
    case "expired": return { status: "SUSPENDED", line: null };
    case "machine": return { status: "UNLICENSED", line: "This key belongs to a different PC." };
    case "signature": return { status: "UNLICENSED", line: "Licence key is not genuine." };
    case "format": return { status: "UNLICENSED", line: "Licence key is damaged or incomplete." };
    default: return { status: "UNLICENSED", line: "Licence key not valid." };
  }
}

module.exports = {
  getPublicKeyB64: () => vendorPublicKeyB64,
  DEFAULT_REVOCATION_URL,
  DEFAULT_SUSPENSION_URL,
  DEFAULT_GRACE_HOURS,
  DEFAULT_TRIAL_DAYS,
  PREFIX,
  graceMs,
  trialDays,
  parse,
  verify,
  fetchList,
  fetchRevoked,
  fetchSuspended,
  evaluate,
  display,
  /* Test seam. See the note where vendorPublicKeyB64 is declared: it exists so
   * this suite can sign its own keys and run on machines without yours. Never
   * called outside tests. */
  _test: {
    usePublicKey(b64) {
      const prev = vendorPublicKeyB64;
      vendorPublicKeyB64 = String(b64);
      return prev;
    },
  },
};
