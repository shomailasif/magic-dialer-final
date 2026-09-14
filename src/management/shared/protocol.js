/**
 * Shared protocol between the agent (customer PC) and the portal (admin cloud).
 * Kept dependency-free so both the portal and the packaged agent agree.
 */

/** How often the agent reports health to the portal (milliseconds). */
const HEARTBEAT_INTERVAL_MS = 3000;

/** If a customer hasn't reported in this long, the portal marks it offline. */
const STALE_AFTER_MS = 10000;

/**
 * Hosted VOIP provider -> default SIP registration domain.
 * Single source of truth — imported by trunk.js, db.js, agent.js, server.js.
 */
const HOSTED_VOIP_SERVERS = {
  ringcentral: "sip.ringcentral.com",
  twilio: "sip-1042-sip.twilio.com",
  vonage: "sip.nexmo.com",
  plivo: "sip.plivo.com",
  thinq: "sip.thinq.com",
  flowroute: "sip.flowroute.com",
  myexotel: "voip.myexotel.com",
  asterisk: "",
  freepbx: "",
  generic: "",
  sim: "sim.local",
};

/** Check if a VOIP line config has all required fields. */
function voipComplete(v) {
  if (!v || typeof v !== "object") return false;
  if (!v.provider) return false;
  if (HOSTED_VOIP_SERVERS[v.provider]) {
    // RingCentral: SIP credentials OR RingOut REST (JWT + app credentials)
    if (v.provider === "ringcentral") {
      return !!((v.username && v.sipPassword) || (v.appClientId && v.appClientSecret && v.appJwt)
        || (typeof process !== "undefined" && process.env && process.env.RC_JWT && process.env.RC_CLIENT_ID && process.env.RC_CLIENT_SECRET));
    }
    // Sim provider needs no real credentials
    if (v.provider === "sim") return true;
    return !!(v.username && v.sipPassword);
  }
  return !!(v.server && v.username && v.sipPassword);
}

/** Response the heartbeat API returns to the agent. */
function heartbeatResponse(opts) {
  const { ok, disabled, config, reason, sync } = opts || {};
  const body = { ok, disabled: !!disabled };
  if (disabled) body.reason = reason || "disabled";
  if (config) body.config = config;
  if (sync) body.sync = sync;
  return body;
}

module.exports = { HEARTBEAT_INTERVAL_MS, STALE_AFTER_MS, HOSTED_VOIP_SERVERS, voipComplete, heartbeatResponse };
