/* Self-healing authorisation, in its own module with no side effects.
 *
 * Living inside agent.js made this untestable: requiring that file installs a
 * process-wide uncaughtException handler that exits the process, and starts the
 * watchdog lock, so a unit test could not load it. Kept separate, it is a plain
 * function with injected dependencies and can be tested for real.
 *
 * The problem it solves: the brain and speech-to-text both check the same device
 * token, so when the portal rejects it the PC is deaf AND unable to think at the
 * same time, and it was reaching real prospects saying "Could." and "You cut out
 * for a second there". Before this, the only cure was a human sending us a log,
 * which does not work for a thousand customers on their own PCs. The portal
 * re-enrols idempotently by {userId, machineId}, so a PC holding its enrolment
 * ticket can simply enrol again. */
const { randomUUID } = require("node:crypto");

/**
 * @param {object} o
 * @param {() => object|null} o.loadConfig  reads the PC's stored config
 * @param {(cfg: object) => void} o.saveConfig
 * @param {(url: string, body: object) => Promise<{status:number, body:any}>} o.post
 * @param {string} o.configPath
 * @param {object} [o.liveConfig] mutated in place so the running agent adopts the new token
 * @param {string} [o.reason] for logs
 * @param {(msg: string) => void} [o.log]
 * @returns {Promise<boolean>} true only when the PC is authorised again
 */
async function reEnrollSelf({
  loadConfig, saveConfig, post, configPath, liveConfig = null, reason = "", log = () => {},
}) {
  try {
    if (typeof loadConfig !== "function" || typeof saveConfig !== "function" || typeof post !== "function") {
      return false;
    }
    const cfg = loadConfig(configPath) || {};
    const ticket = String(cfg.enrollmentTicket || "").trim();
    const base = String(cfg.portalUrl || "").replace(/\/+$/, "");
    const machineId = cfg.machineId || randomUUID();
    // Enrolled by hand and never stored a ticket: nothing to reuse, and we must
    // never invent one.
    if (!ticket || !base) return false;

    const r = await post(base + "/api/engine/enroll", { ticket, machineId });
    if (!r || r.status !== 200 || !r.body || !r.body.deviceToken) return false;

    cfg.deviceToken = r.body.deviceToken;
    cfg.machineId = machineId;
    cfg.portalUrl = base;
    delete cfg.token;
    saveConfig(cfg, configPath);
    if (liveConfig) { liveConfig.deviceToken = cfg.deviceToken; liveConfig.machineId = machineId; }
    return true;
  } catch (e) {
    // A network blip must never take the agent down.
    try { log("self-re-enrol did not work: " + (e && e.message) + (reason ? " (" + reason + ")" : "")); } catch {}
    return false;
  }
}

module.exports = { reEnrollSelf };
