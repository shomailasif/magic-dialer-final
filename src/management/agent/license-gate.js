"use strict";

/* The dial gate: decides whether this PC may place a call, and keeps the
 * revocation list fresh enough that "you stopped paying" is noticed within
 * minutes rather than at the next reinstall.
 *
 * Two design points worth stating, because both are easy to get wrong.
 *
 * The licence lives in its own file, not in config.json. The agent keeps an
 * in-memory config and writes it back after every call to store stats, so a
 * key stored in there would be silently reverted to whatever that in-memory
 * copy last saw - losing a customer's activation the first time they dialed.
 *
 * The trial clock is written once and never rewritten. Clearing a key, moving
 * config between installs or editing the file by hand must not hand back a
 * fresh trial, or the window is not a window, it is a button.
 */

const fs = require("node:fs");
const path = require("node:path");
const lic = require("./license");

const DAY_MS = 86400000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

function createLicenseGate({
  file,
  readConfig = () => ({}),
  readStore: readStoreIn,
  writeStore: writeStoreIn,
  fetchImpl,
  log = () => {},
  now = () => Date.now(),
  intervalMs = CHECK_INTERVAL_MS,
  timeoutMs = FETCH_TIMEOUT_MS,
  url = lic.DEFAULT_REVOCATION_URL,
  suspensionUrl = lic.DEFAULT_SUSPENSION_URL,
} = {}) {
  if (typeof readConfig !== "function") throw new Error("license gate needs readConfig()");

  const defaultRead = () => {
    if (!file) return {};
    try {
      const s = JSON.parse(fs.readFileSync(file, "utf8"));
      return s && typeof s === "object" ? s : {};
    } catch { return {}; }
  };
  const defaultWrite = (s) => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n", "utf8");
  };
  const readStore = typeof readStoreIn === "function" ? readStoreIn : defaultRead;
  const writeStore = typeof writeStoreIn === "function" ? writeStoreIn : defaultWrite;

  /* Last known answers from the two public lists. Held in memory rather than
   * on disk: a value written at 03:00 and read at 09:00 after a reboot would
   * claim six hours of verification we did not do. Boot always starts
   * unverified, which is the honest state and still lands inside the grace
   * window. */
  const mem = { cancelled: new Set(), suspended: new Set(), error: null, checkedAt: 0, attemptAt: 0 };
  let timer = null;

  const cfg = () => {
    const c = readConfig();
    return c && typeof c === "object" ? c : {};
  };
  const store = () => {
    const s = readStore();
    return s && typeof s === "object" ? s : {};
  };
  const save = (patch) => writeStore(Object.assign({}, store(), patch));
  const machineId = () => String(cfg().machineId || "");

  /* The id inside the stored key, signature-checked. Null when there is no key
   * or when it is not a genuine one. */
  function licenceId() {
    const s = store();
    if (!s.raw) return null;
    try {
      const p = lic.parse(s.raw);
      return p && p.payload ? String(p.payload.id) : null;
    } catch { return null; }
  }

  /* Called once when the engine starts. */
  function boot() {
    const s = store();
    if (!s.firstSeenAt) save({ firstSeenAt: now() });
    return checkNow();
  }

  function evaluate() {
    const s = store();
    const id = licenceId();

    /* Once we have seen this key on a stop list, that fact stops depending on
     * the next request succeeding. It is written to disk for exactly that
     * reason: without it, the moment the list became unreadable the engine
     * would fall back into the grace window and start calling again - so
     * blocking your own revocation file would quietly undo the revocation.
     * Each list clears only when a later, successful read says the id is gone,
     * which is how a reinstatement reaches this PC.
     *
     * `ok` stays false while a list is unreadable and nothing is sticky, so
     * the grace window still ends in a stop. */
    const stickyCancelled = Boolean(s.revokedId && id && s.revokedId === id);
    const stickySuspended = Boolean(s.suspendedId && id && s.suspendedId === id);
    const attempted = Boolean(mem.checkedAt) || stickyCancelled || stickySuspended || Boolean(mem.error);
    const cancelled = new Set(mem.cancelled);
    const suspended = new Set(mem.suspended);
    if (stickyCancelled) cancelled.add(id);
    if (stickySuspended) suspended.add(id);
    const readOk = !mem.error;

    return lic.evaluate({
      raw: s.raw,
      machineId: machineId(),
      now: now(),
      revocation: attempted
        ? { ok: readOk || stickyCancelled, revoked: cancelled, error: mem.error }
        : null,
      suspension: attempted
        ? { ok: readOk || stickySuspended, suspended: suspended, error: mem.error }
        : null,
      lastVerifiedAt: s.lastVerifiedAt || 0,
      grantTime: s.grantTime || 0,
      firstSeenAt: s.firstSeenAt || 0,
    });
  }

  /* The one entry point the call paths use. Throws with a sentence the
   * customer can act on, because "refused" on a live call with no reason is
   * how a healthy customer spends an afternoon on support. */
  function assertAllowsCall() {
    const e = evaluate();
    if (e.ok) return e;
    const d = lic.display(e.state);
    const message = d.line || e.message || "Calling is paused - this subscription is not active.";
    const err = new Error(message);
    err.code = "LICENSE_" + String(e.state || "BLOCKED").toUpperCase();
    err.state = e.state;
    throw err;
  }

  async function checkNow() {
    mem.attemptAt = now();
    /* Both lists, one pass. They answer two halves of the same question and a
     * successful check must mean both were read; otherwise a customer whose
     * cancellation list loaded but whose suspension list did not would be
     * reported fully verified. */
    const [cancelled, suspended] = await Promise.all([
      lic.fetchRevoked(url, { fetchImpl, timeoutMs }),
      lic.fetchSuspended(suspensionUrl, { fetchImpl, timeoutMs }),
    ]);

    if (!cancelled.ok || !suspended.ok) {
      /* Keep the previous lists if we have them. An unreadable list is not an
       * empty list - dropping what we knew would re-open a stop we had already
       * seen, which is exactly how a block gets undone by a blip. */
      if (cancelled.ok) mem.cancelled = cancelled.revoked;
      if (suspended.ok) mem.suspended = suspended.suspended;
      const why = [
        !cancelled.ok ? `revoked: ${cancelled.error}` : "",
        !suspended.ok ? `suspended: ${suspended.error}` : "",
      ].filter(Boolean).join("; ");
      mem.error = why || "fetch failed";
      mem.checkedAt = mem.checkedAt || 0;
      return { ok: false, error: mem.error };
    }

    mem.cancelled = cancelled.revoked;
    mem.suspended = suspended.suspended;
    mem.error = null;
    mem.checkedAt = now();

    /* Record, or forget, each stop for this specific key - the only two
     * moments that may change it. A successful read that no longer carries the
     * id is what makes a reinstatement take effect. */
    const id = licenceId();
    const patch = { lastVerifiedAt: mem.checkedAt };
    if (id) {
      patch.revokedId = mem.cancelled.has(id) ? id : null;
      patch.suspendedId = mem.suspended.has(id) ? id : null;
    }
    save(patch);
    return { ok: true, updated: cancelled.updated || suspended.updated || null };
  }

  /* Paste a key. Verified against this PC's machine id before it is stored,
   * so a key meant for another machine never becomes this machine's licence
   * and never looks like an activation that "did not take". */
  async function activate(raw) {
    const text = String(raw || "").trim();
    if (!text) return clear();
    const machine = machineId();
    if (!machine) return { ok: false, error: "This PC is not enrolled yet - it has no activation code to licence." };

    const v = lic.verify(text, machine);
    if (!v.ok) return { ok: false, error: v.message };

    const s = store();
    save({
      raw: text,
      grantTime: now(),
      firstSeenAt: s.firstSeenAt || now(),
      lastVerifiedAt: 0,
      /* A new key is a new licence id, so a stop recorded against the old one
       * must not follow it. Re-pasting the very same revoked key is caught
       * immediately by the check right below, not by this line. */
      revokedId: null,
      suspendedId: null,
    });
    mem.checkedAt = 0;

    /* Check immediately: if the key was already revoked we must say so now,
     * not in five minutes when the timer happens to fire. */
    await checkNow();
    const e = evaluate();
    if (!e.ok) return { ok: false, error: lic.display(e.state).line || e.message, state: e.state };
    return { ok: true, state: e.state };
  }

  function clear() {
    const s = store();
    /* firstSeenAt deliberately survives. It is what stops "remove the key"
     * from being a way to restart the trial. */
    writeStore({ firstSeenAt: s.firstSeenAt || now() });
    mem.cancelled = new Set();
    mem.suspended = new Set();
    mem.error = null;
    mem.checkedAt = 0;
    return { ok: true, cleared: true };
  }

  function status() {
    const e = evaluate();
    const d = lic.display(e.state);
    const s = store();
    const out = {
      state: e.state,
      ok: Boolean(e.ok),
      status: d.status,
      line: e.message || d.line || null,
      machineId: machineId() || null,
      activated: Boolean(s.raw),
      until: (e.payload && e.payload.until) || null,
      grantedAt: s.grantTime || null,
      lastCheckedAt: mem.checkedAt || s.lastVerifiedAt || null,
      revocationError: mem.error,
      suspensionError: mem.error,
      trialDays: lic.trialDays(),
      graceHours: Math.round(lic.graceMs() / 3600000),
    };
    if (e.state === "trial" && Number.isFinite(e.remainingMs)) {
      out.daysLeft = Math.max(1, Math.ceil(e.remainingMs / DAY_MS));
    }
    return out;
  }

  function start() {
    if (timer || intervalMs <= 0) return;
    timer = setInterval(() => { checkNow().catch(() => {}); }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { boot, evaluate, assertAllowsCall, checkNow, activate, clear, status, start, stop, machineId };
}

module.exports = { createLicenseGate, CHECK_INTERVAL_MS, FETCH_TIMEOUT_MS, DAY_MS };
