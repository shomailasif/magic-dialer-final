// Bootstrap witness. This must stay the first executable code in the file: if
// anything below it throws while the module is still loading, control never
// reaches require.main and the process exits 1 with no trace anywhere. The
// block below leaves a durable line before any other require runs, and turns
// a silent load-time crash into a durable one.
(function bootWitness() {
  try {
    const p = require("node:path").join(require("node:os").homedir(), "AppData", "Local", "Magic Dialer", "watchdog-supervisor.log");
    const f = require("node:fs");
    const rec = (tag, extra) => f.appendFileSync(p, `[${tag}] ${new Date().toISOString()} pid=${process.pid} ${extra}\n`);
    if (require.main === module) rec("boot", `argv=${JSON.stringify(process.argv.slice(2))}`);
    // Everything the process would print to stderr - Node's own "module failed
    // to load" report included - also lands in the durable log, so a crash is
    // never invisible just because nobody was holding the console.
    try {
      const realWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk, ...rest) => {
        try { rec("stderr", String(chunk).replace(/\s+$/, "")); } catch {}
        return realWrite(chunk, ...rest);
      };
    } catch {}
    process.on("uncaughtException", (e) => {
      try { rec("fatal", `uncaught ${(e && e.stack) || e}`); } catch {}
      process.exit(1);
    });
    process.on("unhandledRejection", (e) => {
      try { rec("fatal", `unhandled ${(e && e.stack) || e}`); } catch {}
      process.exit(1);
    });
  } catch {}
})();

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
try { require("dotenv").config({ path: path.join(__dirname, "..", "..", "..", ".env") }); } catch {}
const { spawn, execSync } = require("node:child_process");
const { HEARTBEAT_INTERVAL_MS, HOSTED_VOIP_SERVERS } = require("../shared/protocol");
const { setUi } = require("./ui");
const { topStrategy } = require("./brain");
const { startWebUi, writeDashboardUrl, dashboardUrlPath } = require("./webui");
const localDb = require("./local-db");
const sync = require("./sync");
const { emailQualifiedLead } = require("./email");
const { ensurePhoneSession } = require("./call-start");
const { runLocalCall } = require("./local-call-controller");
const { startEngineHealthServer } = require("./engine-health");
const { checkForUpdate, validatePendingUpdate, rollbackPendingUpdate, _test: autoUpdateState } = require("./auto-update");
const { safeLog } = require("./safe-diagnostic");

/**
 * Customer PC agent.
 *
 * Runs on a customer's machine. It:
 *   - holds a local config (machine identity + its portal + its token)
 *   - runs a one-time, browser-based setup (what they sell, leads, email)
 *   - serves a live dashboard (http://127.0.0.1:<port>) with status + stats
 *   - sends a heartbeat to the portal every few seconds
 *   - if the admin disables it, the agent detects the order and stops working
 *
 * The pkg engine is `agent.exe` (hidden, no console). The user-visible app is
 * the compiled C# launcher `MagicDialer.exe` (a real Windows GUI exe) which
 * spawns the engine silently and opens the dashboard in the default browser.
 * No PowerShell is involved in the customer-facing experience.
 */

function defaultConfigPath() {
  const base = process.env.AUTODIAL_HOME
    ? process.env.AUTODIAL_HOME
    : path.join(os.homedir(), ".magicdialer");
  return path.join(base, "config.json");
}

function loadConfig(cfgPath = defaultConfigPath()) {
  try {
    return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch {
    return null;
  }
}

function saveConfig(config, cfgPath = defaultConfigPath()) {
  try {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), "utf8");
  } catch (err) {
    log("saveConfig failed: " + safeLog(err));
  }
}

function log(msg) {
  console.log(`[agent] ${new Date().toISOString()} ${msg}`);
}

/** True when running from the packaged binaries (agent.exe / MagicDialer.exe). */
function isPacked() {
  const base = path.basename(process.execPath || "").toLowerCase();
  return base === "agent.exe" || base === "magicdialer.exe";
}

function openBrowser(url) {
  try {
    spawn("cmd.exe", ["/c", "start", "", String(url)], { windowsHide: true, stdio: "ignore" }).unref();
  } catch {}
}

/** Re-open the dashboard with the port recorded by the last running agent. */
function openDashboardExternal() {
  try {
    const txt = fs.readFileSync(dashboardUrlPath(), "utf8");
    const m = txt.match(/^URL=(.+)$/m);
    if (m && m[1].trim()) { openBrowser(m[1].trim()); return true; }
  } catch {}
  return false;
}

/**
 * Self-healing supervisor. Keeps the agent process alive around-the-clock:
 * if it crashes or exits unexpectedly it is restarted immediately; if the
 * admin disables it, the child exits after writing DISABLED status and the
 * watchdog sees that marker and stops (no zombie restart loop). Crash-loops
 * get a growing backoff so a broken build doesn't spin a CPU/disk storm.
 *
 * Launched by the launcher as `agent.exe --watchdog`.
 */
const WATCHDOG_LOCK = path.join(os.homedir(), "AppData", "Local", "Magic Dialer", "watchdog.lock");
const CRASH_WINDOW_MS = 45000;
const CRASH_BEFORE_BACKOFF = 3;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const WATCHDOG_LOG = path.join(path.dirname(WATCHDOG_LOCK), "watchdog-supervisor.log");

/** Durable record of every lock decision; console output is discarded when the GUI launcher spawns us. */
function supervisorNote(msg) {
  try {
    fs.appendFileSync(WATCHDOG_LOG, `[supervisor] ${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

/**
 * Positive identification of a PID before we trust it as a rival supervisor.
 * Windows recycles PIDs, so a stale lock can name a live but unrelated
 * process — and refusing on a recycled PID means no supervisor ever starts
 * again: no crash, no log line, no agent, until the next logon.
 * Anything we cannot positively identify is treated as not-a-supervisor.
 */
function pidIsOurSupervisor(pid) {
  const p = Number(pid);
  try {
    if (process.platform === "win32") {
      const r = execSync(`tasklist /FI "PID eq ${p}" /NH`, { encoding: "utf8", windowsHide: true, timeout: 4000, stdio: ["ignore", "pipe", "pipe"] });
      // \b keeps an unrelated "<something>agent.exe" from matching.
      return /\bagent\.exe\b/i.test(String(r));
    }
    const r = execSync(`ps -p ${p} -o args=`, { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "pipe"] });
    return /\bagent(\.exe|\.js)?\b/i.test(String(r));
  } catch (e) {
    supervisorNote(`could not identify pid ${p}: ${safeLog(e)}`);
    return false;
  }
}

function takeWatchdogLock() {
  try {
    if (fs.existsSync(WATCHDOG_LOCK)) {
      const raw = String(fs.readFileSync(WATCHDOG_LOCK, "utf8")).trim();
      const old = Number(raw);
      const foreign = old && old !== process.pid && pidAlive(old);
      const rival = foreign && pidIsOurSupervisor(old);
      if (rival) {
        supervisorNote(`another supervisor (pid ${old}) is running - exiting.`);
        console.log(`[watchdog] another supervisor (pid ${old}) is already running — exiting.`);
        return false;
      }
      supervisorNote(`taking over stale lock (raw=${JSON.stringify(raw)} alive=${!!foreign} ours=${rival})`);
    }
    fs.mkdirSync(path.dirname(WATCHDOG_LOCK), { recursive: true });
    fs.writeFileSync(WATCHDOG_LOCK, String(process.pid));
    supervisorNote(`lock acquired (pid ${process.pid})`);
    return true;
  } catch (e) { supervisorNote(`lock handling error: ${safeLog(e)} - proceeding`); return true; } // never block supervision over a lock file
}

async function runWatchdog(args) {
  // Before anything else: a supervisor that never reaches the lock write is
  // indistinguishable from one that never started. Record the boot first.
  supervisorNote(`watchdog boot pid=${process.pid} ver=${VERSION} packed=${isPacked()}`);
  if (!takeWatchdogLock()) return;
  const childArgs = args.filter((a) => a !== "--watchdog");
  childArgs.push("--no-browser");
  const childCmd = process.env.MD_WATCHDOG_CHILD
    ? { cmd: "cmd.exe", args: ["/d", "/c", process.env.MD_WATCHDOG_CHILD] }
    : isPacked()
      ? { cmd: process.execPath, args: [process.argv[1], ...childArgs] }
      : { cmd: process.execPath, args: [__filename, ...childArgs] };
  let crashes = 0;
  let lastExit = 0;
  const restart = (n) => new Promise((r) => setTimeout(r, n));

  while (true) {
   try {
    log(`watchdog starting agent (pid engine: ${childCmd.cmd})...`);
    const watchdogLog = path.join(path.dirname(WATCHDOG_LOCK), "watchdog-child.log");
    let logFd = null;
    try { logFd = fs.openSync(watchdogLog, "a"); } catch {}
    const child = spawn(childCmd.cmd, childCmd.args, { stdio: ["ignore", logFd == null ? "inherit" : logFd, logFd == null ? "inherit" : logFd] });
    const exited = await new Promise((resolve) => {
      let settled = false;
      const done = (code) => {
        if (settled) return;
        settled = true;
        try { if (logFd != null) fs.closeSync(logFd); } catch {}
        resolve({ code, ranFor: Date.now() - (child._start || Date.now()) });
      };
      child.on("exit", (code) => done(code));
      // A spawn issued while the installer is replacing agent.exe fails with an
      // 'error' event and never emits 'exit'. With no listener the EventEmitter
      // throws, runWatchdog()'s catch runs process.exit(1), and the machine is
      // left with no supervisor at all the moment the update finishes.
      child.on("error", (err) => { log(`watchdog could not start agent: ${safeLog(err)}`); done(-1); });
      child._start = Date.now();
    });

    const cfgDir = path.join(os.homedir(), "AppData", "Local", "Magic Dialer");
    let disabled = false;
    try {
      const st = JSON.parse(fs.readFileSync(path.join(cfgDir, "status.json"), "utf8"));
      disabled = st && st.status === "DISABLED";
    } catch {}

    if (disabled) {
      log(`agent left status DISABLED — supervisor standing down.`);
      return;
    }

    const wasCrash = exited.code !== 0 || exited.ranFor < CRASH_WINDOW_MS;
    const crashy = wasCrash && Date.now() - lastExit < CRASH_WINDOW_MS;
    crashes = (wasCrash && crashy) ? Math.min(crashes + 1, 10) : (wasCrash ? 1 : 0);
    lastExit = Date.now();

    if (wasCrash && crashes >= CRASH_BEFORE_BACKOFF) {
      const backoff = Math.min(1000 * crashes, 300000);
      log(`agent exited ${exited.code} after ${exited.ranFor}ms — crash streak ${crashes}, backing off ${backoff}ms.`);
      await restart(backoff);
    } else if (exited.ranFor >= CRASH_WINDOW_MS) {
      log(`agent exited cleanly (code ${exited.code}) after ${exited.ranFor}ms — restarting in 4s.`);
      await restart(4000);
    } else {
      log(`agent exited early (code ${exited.code}) — restarting in ${wasCrash ? 4000 : 2000}ms.`);
      await restart(wasCrash ? 4000 : 2000);
    }
   } catch (e) {
      // The supervisor must outlive every failure mode of the loop itself:
      // exiting here would leave the PC with no agent until the next logon.
      log(`watchdog supervisor error: ${safeLog(e)} — retrying in 5s.`);
      await restart(5000);
    }
  }
}

/** Agent version surfaced in dashboard + status. */
const VERSION = "1.4.19";

// Leaving is only correct while the installer we handed the update to is still
// running: it is what stops the old engine and starts the new one. If it is
// already gone the hand-off never happens, and exiting would leave the PC with
// no agent at all until the next logon.
function installerStillRunning() {
  try {
    const inst = autoUpdateState.readState().pendingInstaller;
    if (!inst) return true;
    const name = path.basename(inst);
    const out = execSync(`tasklist /FI "IMAGENAME eq ${name}" /NH`, { encoding: "utf8", windowsHide: true, timeout: 4000, stdio: ["ignore", "pipe", "pipe"] });
    return out.toLowerCase().includes(name.toLowerCase());
  } catch { return true; }
}

function scheduleAutoUpdate() {
  const run = () => checkForUpdate(VERSION).then((r) => {
    if (!r.updated) return;
    log(`Verified update ${r.version} launched; checking the installer before restarting.`);
    setTimeout(() => {
      if (!installerStillRunning()) {
        log(`Update ${r.version} installer exited before it took hold; staying on ${VERSION} so the PC is never left without an agent.`);
        return;
      }
      log(`Installer for ${r.version} is running; exiting for supervised restart.`);
      process.exit(0);
    }, 1500);
  }).catch((e) => log("Auto-update check failed safely: " + safeLog(e)));
  setTimeout(run, 15000);
  const timer = setInterval(run, 6 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();
}


/**
 * Roll a call result into the customer's lifetime + daily stats, persisted in
 * the config so the dashboard and portal can show "today / all time".
 */
/**
 * Apply the sales form + settings the admin edited on the portal. The portal
 * is the source of truth for these fields; the local setup form only seeds
 * the first values. Only meaningful values are applied and the config file is
 * rewritten only when something actually changed.
 * Returns true when the config changed.
 */
function applyPortalConfig(config, portalCfg, cfgPath) {
  if (!portalCfg || typeof portalCfg !== "object") return false;
  let changed = false;
  const set = (key, v) => {
    const jv = JSON.stringify(v);
    if (jv !== JSON.stringify(config[key])) {
      config[key] = v;
      changed = true;
    }
  };
  if (typeof portalCfg.product === "string" && portalCfg.product.trim()) set("product", portalCfg.product.trim());
  if (Array.isArray(portalCfg.leadFields) && portalCfg.leadFields.length) set("leadFields", portalCfg.leadFields.map((s) => String(s).trim()).filter(Boolean));
  if (typeof portalCfg.contactEmail === "string" && portalCfg.contactEmail.trim()) set("contactEmail", portalCfg.contactEmail.trim());
  if (typeof portalCfg.persona === "string" && portalCfg.persona.trim()) set("persona", portalCfg.persona.trim());
  if (typeof portalCfg.companyName === "string" && portalCfg.companyName.trim()) set("companyName", portalCfg.companyName.trim());
  if (typeof portalCfg.callbackNumber === "string" && portalCfg.callbackNumber.trim()) set("callbackNumber", portalCfg.callbackNumber.trim());
  if (typeof portalCfg.callbackIn === "string" && portalCfg.callbackIn.trim()) set("callbackIn", portalCfg.callbackIn.trim());
  if (Array.isArray(portalCfg.callList)) set("callList", portalCfg.callList.map((n) => String(n).trim()).filter(Boolean));
  if (typeof portalCfg.searchEnabled === "boolean") set("searchEnabled", portalCfg.searchEnabled);
  if (typeof portalCfg.lang === "string" && /^(en|es|fr|de|pt|hi|auto|ar|he|id|it|ja|ko|nl|pl|ru|tr|uk|ur|vi|zh)$/.test(portalCfg.lang.trim())) set("lang", portalCfg.lang.trim());
  if (typeof portalCfg.voiceStyle === "string" && /^(human|frank|friendly)$/.test(portalCfg.voiceStyle.trim())) set("voiceStyle", portalCfg.voiceStyle.trim());
  if (portalCfg.voip === null || portalCfg.voip === undefined) {
    if (config.voip && config.voip.ready) {
      config.voip = { ...config.voip, ready: false };
      changed = true;
      pushActivity(config, "VOIP config cleared by admin.");
    }
  } else if (portalCfg.voip && typeof portalCfg.voip === "object" && portalCfg.voip.number && portalCfg.voip.username) {
    const prior = config.voip || {};
    const provider = portalCfg.voip.provider || prior.provider || "";
    const defaultServer = HOSTED_VOIP_SERVERS[provider] || HOSTED_VOIP_SERVERS[prior.provider] || "";
    const next = {
      provider,
      number: portalCfg.voip.number,
      extension: portalCfg.voip.extension || "",
      username: portalCfg.voip.username,
      sipPassword: portalCfg.voip.sipPassword || "",
      authId: portalCfg.voip.authId || prior.authId || portalCfg.voip.username,
      domain: portalCfg.voip.domain || prior.domain || "sip.ringcentral.com",
      server: portalCfg.voip.server || prior.server || defaultServer,
      port: portalCfg.voip.port || prior.port || "",
      transport: portalCfg.voip.transport || prior.transport || "",
      ready: true,
    };
    if (JSON.stringify(next) !== JSON.stringify(prior)) {
      config.voip = next;
      changed = true;
      pushActivity(config, `VOIP line applied (${next.provider}, ${next.number}) - outbound calls use it.`);
    }
  }
  if (changed) {
    saveConfig(config, cfgPath);
    pushActivity(config, "Admin updated the sales form from the portal - applied.");
    console.log(`[agent] applied portal config: ${JSON.stringify({
      product: config.product, leadFields: config.leadFields || [], companyName: config.companyName || null,
      callbackNumber: config.callbackNumber || null, callbackIn: config.callbackIn || null,
      callList: (config.callList || []).length, searchEnabled: config.searchEnabled, lang: config.lang,
    })}`);
  }
  return changed;
}

function bumpStats(config, result) {
  const day = new Date().toISOString().slice(0, 10);
  const s = config.stats || { since: day, day, calls: 0, qualified: 0, today: 0, qualifiedToday: 0, lastScore: 0, bestScore: 0, qualifiedRate: 0 };
  if (s.day !== day) {
    s.day = day;
    s.today = 0;
    s.qualifiedToday = 0;
  }
  s.calls++;
  s.today++;
  if (result.goodLead) {
    s.qualified++;
    s.qualifiedToday++;
  }
  s.lastScore = result.score;
  if (result.score > (s.bestScore || 0)) s.bestScore = result.score;
  s.qualifiedRate = Math.round((100 * s.qualified) / Math.max(1, s.calls)) / 100;
  config.stats = s;
  return s;
}

/** Keep a bounded, newest-first activity feed written to status.json. */
function pushActivity(config, msg) {
  const feed = (config.activity || []).slice(0, 29);
  feed.unshift({ at: new Date().toISOString(), msg });
  config.activity = feed;
  return feed;
}

function post(url, body) {
  const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), 15000) : null;
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: ac ? ac.signal : undefined,
  }).then(async (r) => {
    if (timer) clearTimeout(timer);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }).catch((e) => {
    if (timer) clearTimeout(timer);
    throw e;
  });
}

/** Optional animated cockpit (PowerShell) — opt-in only; the web dashboard is
 *  the default face. Enable with the env var MAGICDIALER_COCKPIT=1. */
function tryCockpit(configDir) {
  if (!isPacked()) return;
  if (process.env.MAGICDIALER_COCKPIT !== "1") return;
  const cockpit = path.join(path.dirname(process.execPath), "cockpit.ps1");
  if (fs.existsSync(cockpit)) {
    try {
      spawn("powershell.exe", [
        "-NoProfile", "-Sta", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", cockpit,
      ], { stdio: "ignore" });
    } catch {}
  }
}

/** One agent per customer PC: an extra icon double-click must not stack a
 *  second live agent. Only enforced for the packaged exe (not dev/test runs). */
const AGENT_LOCK = path.join(os.homedir(), "AppData", "Local", "Magic Dialer", "agent.lock");

function pidIsMagicDialer(pid) {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    });
    return /(magicdialer|agent)\.exe/i.test(out);
  } catch { return false; }
}

function takeAgentLock() {
  if (!isPacked()) return true;
  try {
    if (fs.existsSync(AGENT_LOCK)) {
      const old = Number(String(fs.readFileSync(AGENT_LOCK, "utf8")).trim());
      if (old && pidAlive(old) && pidIsMagicDialer(old)) return false;
    }
    fs.mkdirSync(path.dirname(AGENT_LOCK), { recursive: true });
    fs.writeFileSync(AGENT_LOCK, String(process.pid));
    process.on("exit", () => { try { fs.unlinkSync(AGENT_LOCK); } catch {} });
    return true;
  } catch { return true; }
}

const { createInterface } = require("node:readline");

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question + " ", (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

/**
 * Agent main loop. `opts.configPath` lets the demo point at different
 * machines on one computer. `opts.setup` opens the web setup/dashboard.
 */
async function runAgent(opts = {}) {
  let pendingValidation = { pending: false };
  if (isPacked()) {
    pendingValidation = await validatePendingUpdate(VERSION).catch((e) => ({ error: e.message }));
    if (pendingValidation && pendingValidation.rollback) { log("Pending update rejected; known-good rollback launched."); setTimeout(() => process.exit(0), 1500); return; }
    if (pendingValidation && pendingValidation.error) log("Update validation failed safely: " + pendingValidation.error);
  }
  const cfgPath = opts.configPath || defaultConfigPath();
  const configDir = path.dirname(cfgPath);
  let config = loadConfig(cfgPath);

  // Ownership must be established before either fixed local port is bound.
  // A duplicate child must never create a partial 18787-only engine.
  if (!takeAgentLock()) {
    log("Magic Dialer is already running - opening its dashboard...");
    if (!openDashboardExternal()) openBrowser("http://127.0.0.1:48771/");
    setTimeout(() => process.exit(0), 800);
    return;
  }

  let engineHealthServer = null;
  try {
    const portalOrigin = config && config.portalUrl ? new URL(config.portalUrl).origin : "*";
    engineHealthServer = await startEngineHealthServer({
      version: VERSION,
      allowedOrigin: portalOrigin,
      getStatus: () => "online",
      onCall: async (number) => {
        const liveConfig = loadConfig(cfgPath);
        if (!liveConfig || !liveConfig.deviceToken || !liveConfig.portalUrl || !liveConfig.portalSyncedAt) throw new Error("This PC is not enrolled and synchronized with the portal");
        log("LOCAL CALL CONTROL: " + number);
        return runLocalCall({
          config: liveConfig,
          number,
          onLog: (m) => log(m),
          onMode: () => {},
        });
      },
    });
    log("Local engine call control: http://127.0.0.1:18787");
  } catch (e) {
    log("Local engine call control unavailable: " + safeLog(e));
    if (pendingValidation && pendingValidation.awaitingReadiness) await rollbackPendingUpdate(VERSION).catch(() => {});
    throw e;
  }

  // Initialize local database for offline resilience
  try { localDb.open(configDir); log("Local database ready."); } catch (e) { log("Local DB init failed: " + safeLog(e)); }

  const useWebUi = opts.webui === true || isPacked() || opts.setup === true || opts.open === true;
  let uiServer = null;
  let setupDoneResolve = null;
  const setupDone = new Promise((r) => { setupDoneResolve = r; });

  const ensureWebUi = async () => {
    if (uiServer) return uiServer;
    uiServer = await startWebUi({
      readConfig: () => loadConfig(cfgPath),
      writeConfig: (c) => saveConfig(c, cfgPath),
      statusPath: path.join(configDir, "status.json"),
      onSetup: (cfg) => { try { setupDoneResolve(cfg); } catch {} },
      onMode: (mode) => { try { log(`dashboard mode -> ${mode}`); } catch {} },
      onEnroll: async ({ ticket, portal }) => {
        const live = loadConfig(cfgPath) || {};
        live.machineId = live.machineId || crypto.randomUUID();
        const r = await post(String(portal).replace(/\/+$/, "") + "/api/engine/enroll", { ticket, machineId: live.machineId });
        if (r.status !== 200 || !r.body || !r.body.deviceToken) throw new Error("Account enrollment rejected");
        live.portalUrl = String(portal).replace(/\/+$/, "");
        live.deviceToken = r.body.deviceToken;
        delete live.token;
        saveConfig(live, cfgPath);
        Object.assign(config, live);
        try { setupDoneResolve(live); } catch {}
        log("PC enrolled to logged-in customer account.");
        return { ok: true };
      },

      onCall: async (number) => {
        const liveConfig = loadConfig(cfgPath);
        if (!liveConfig || !liveConfig.deviceToken || !liveConfig.portalUrl || !liveConfig.portalSyncedAt) throw new Error("This PC is not enrolled and synchronized with the portal");
        log("LOCAL DASHBOARD CALL CONTROL: " + number);
        return runLocalCall({ config: liveConfig, number, onLog: (m) => log(m), onMode: () => {} });
      },
      serviceName: "Magic Dialer",
    });
    try { writeDashboardUrl(uiServer.url); } catch {}
    log(`dashboard: ${uiServer.url}`);
    return uiServer;
  };

  let opened = false;
  const maybeOpen = (url) => {
    if (!opened) { opened = true; openBrowser(url); }
  };

  if (!config || (!config.deviceToken && !config.token) || !config.portalUrl) {
    config = config || {};
    config.machineId = config.machineId || crypto.randomUUID();
    config.lang = config.lang || "en";
    config.voiceStyle = config.voiceStyle || "human";

    if (opts.portalUrl && opts.token) {
      config.portalUrl = opts.portalUrl;
      config.token = opts.token;
      saveConfig(config, cfgPath);
    }

    if ((!config.deviceToken && !config.token) || !config.portalUrl) {
      log("No config yet - setting up.");
      if (useWebUi) {
        const srv = await ensureWebUi();
        log("Opening setup in the browser...");
        maybeOpen(srv.url);
        log("Waiting for the onboarding form to be saved...");
        config = await setupDone;
        log("Onboarding saved. Starting the agent.");
      } else {
        config.portalUrl = opts.portalUrl || (await ask("Magic Dialer portal URL (from your admin):"));
        config.token = opts.token || (await ask("Your Magic Dialer access token (from your admin):"));
        saveConfig(config, cfgPath);
        log("Config saved.");
      }
    }
  }

  // Dev/console onboarding (only when not using the web app).
  if (opts.setup === true && !useWebUi) {
    log("");
    log("MAGIC DIALER - one-time console setup");
    config.product = await ask("What do you sell / what services do you provide?");
    config.leadFieldsRaw = await ask("What do you need from a qualified lead (comma-separated)?");
    config.contactEmail = await ask("Where should qualified leads be emailed?");
    config.leadFields = config.leadFieldsRaw.split(",").map((s) => s.trim()).filter(Boolean);
    log("Optional: your phone/VOIP line (press Enter on each to skip and configure later)");
    config.voip = config.voip || {};
    config.voip.provider = (await ask("VOIP/SIP provider (e.g. Twilio, Asterisk)? (Enter = none yet):")).trim() || config.voip.provider || "";
    config.voip.number = (await ask("Your outbound phone number? (Enter = none yet):")).trim() || config.voip.number || "";
    config.voip.username = (await ask("SIP username/account? (Enter = none yet):")).trim() || config.voip.username || "";
    config.voip.server = (await ask("SIP domain/server (e.g. sip.example.com)? (Enter = none yet):")).trim() || config.voip.server || "";
    if (!config.voip.provider && !config.voip.number && !config.voip.username && !config.voip.server) {
      config.voip.ready = false;
    } else {
      config.voip.ready = true;
    }
    saveConfig(config, cfgPath);
    log("Setup complete.");
  }

  if (useWebUi) {
    try {
      const srv = await ensureWebUi();
      if (!opts.noBrowser && (opts.setup === true || opts.open === true || isPacked())) {
        maybeOpen(srv.url);
      }
    } catch (e) {
      log("Customer local endpoint unavailable: " + safeLog(e));
      try { if (engineHealthServer) engineHealthServer.close(); } catch {}
      if (pendingValidation && pendingValidation.awaitingReadiness) await rollbackPendingUpdate(VERSION).catch(() => {});
      throw e;
    }
  }

  // A pending release becomes known-good only after BOTH fixed local services
  // have successfully bound: 18787 call-control health and 48771 customer UI/enrollment.
  // Auto-update must also run for non-packed (source-tree) agents so a stale
  // node process cannot pin an old VERSION forever without ever checking releases.
  {
    if (isPacked()) {
      const finalized = await validatePendingUpdate(VERSION, { ready: !!engineHealthServer && !!uiServer }).catch((e) => ({ error: e.message }));
      if (finalized && finalized.rollback) { log("Pending update failed complete local readiness; known-good rollback launched."); setTimeout(() => process.exit(0), 1500); return; }
      if (finalized && finalized.error) throw new Error("Pending update finalization failed: " + finalized.error);
    }
    scheduleAutoUpdate();
  }

  tryCockpit(configDir);
  const productLabel = config.product || "Magic Dialer customer";

  // One status writer for the dashboard + portal: always carries brand + stats + feed.
  const ui = (patch) => setUi(configDir, {
    version: VERSION,
    agent: (config.persona || "autumn").toLowerCase().includes("female") ? "Autumn" : "Atlas",
    company: config.companyName || "our team",
    product: productLabel,
    machineId: config.machineId,
    stats: config.stats || null,
    strategy: (config.learning ? topStrategy(config.learning) : null),
    callListCount: Array.isArray(config.callList) ? config.callList.length : 0,
    logs: (config.activity || []).slice(0, 12),
    ...patch,
  });

  ui({ status: "STARTING", mode: config.mode || "on", line: "Starting Magic Dialer agent..." });

  const portal = (config.portalUrl || "").replace(/\/+$/, "");
  log("");
  log("Magic Dialer v" + VERSION + " - running");
  log("  Customer : " + (config.companyName || config.product || productLabel));
  log("  Portal   : " + portal);
  if (uiServer) log("  Dashboard: " + uiServer.url);
  log("");

  const enrolledToken = config.deviceToken || config.token;
  let stopHeartbeat = false;

  const heartbeatTask = (async () => {
    while (!stopHeartbeat) {
    try {
      const syncPayload = sync.buildSyncPayload();
      const heartbeatPortal = String(config.portalUrl || portal).replace(/\/+$/, "");
      const res = await post(`${heartbeatPortal}/api/heartbeat`, {
        deviceToken: config.deviceToken || config.token,
        voipReady: !!(config.voip && config.voip.ready),
        sync: syncPayload,
      });
      if (res.status === 200 && res.body) {
        if (res.body.disabled) {
          log("DISABLED by admin - stopping work. This PC will not run again until re-enabled.");
          ui({ status: "DISABLED", mode: "off", line: "Disabled by admin." });
          process.exit(0);
        }
        applyPortalConfig(config, res.body.config, cfgPath);
        config.portalSyncedAt = new Date().toISOString();
        saveConfig(config, cfgPath);
        // Process sync acknowledgements from portal
        if (res.body.sync) sync.processSyncResponse(res.body.sync);
        const stats = localDb.stats();
        const hl = `heartbeat OK | ${stats.leads} leads, ${stats.calls} calls, ${stats.leadsUnsynced} unsynced`;
        log(hl);
        ui({ status: "ONLINE", mode: config.mode || "on", line: hl });
      } else {
        log(`heartbeat rejected (status ${res.status}) - not a registered customer.`);
        ui({ status: "OFFLINE", mode: config.mode || "on", line: "Heartbeat rejected - reconnect this PC from the portal." });
      }
    } catch (err) {
      log(`heartbeat failed (${safeLog(err,[enrolledToken])}) - retrying. Agent continues offline.`);
      ui({ status: "OFFLINE", mode: config.mode || "on", line: "Reconnecting to portal..." });
    }
      if (!stopHeartbeat) await new Promise((r) => setTimeout(r, HEARTBEAT_INTERVAL_MS));
    }
  })();

  // Optional call runs while the same heartbeat task keeps the single-PC lease alive.
  if (opts.call === true) {
    let voiceCall;
    try { ({ voiceCall } = require("./call")); } catch (err) { log("call module unavailable: " + safeLog(err,[enrolledToken])); }
    if (voiceCall) try {
      // Bind this conversation to the cloud SIP session that actually owns the
      // phone audio. Never let a telephone call silently fall back to the PC mic.
      const phoneSession = await ensurePhoneSession({
        portal,
        token: enrolledToken,
        callList: config.callList,
        post,
        log,
      });
      const sessionId = phoneSession.sessionId;
      log("Attaching AI to phone media session " + sessionId);
      const result = await voiceCall({
        sessionId,
        product: config.product,
        leadFields: config.leadFields || [],
        persona: config.persona,
        companyName: config.companyName,
        callbackNumber: config.callbackNumber,
        callbackIn: config.callbackIn,
        contactEmail: config.contactEmail,
        token: enrolledToken,
        portal,
        learning: config.learning,
        locale: config.lang || "en",
        voiceStyle: config.voiceStyle || "human",
        onLog: (m) => { log(m); ui({ line: m }); },
        onMode: (m) => ui({ mode: m }),
      });
      config.learning = result.learning;
      bumpStats(config, result);
      pushActivity(config, `Call done - score ${result.score}, ${result.goodLead ? "QUALIFIED LEAD" : "no lead"}. Strategy: ${(result.strategies || []).slice(0, 3).join(", ") || "intro"}${result.goodLead ? ". EMAILED to " + (config.contactEmail || "the portal") : ""}`);
      saveConfig(config, cfgPath);
      const finalLine = `Call result - score ${result.score}, ${result.goodLead ? "QUALIFIED LEAD" : "no lead"}.`;
      log(finalLine);
      ui({ mode: config.mode || "on", line: finalLine });
    } catch (e) {
      log("Voice call failed: " + safeLog(e,[enrolledToken]));
      ui({ mode: config.mode || "on", line: "Voice call failed - retrying later." });
    }
    if (opts.callOnce === true) {
      log("Test call finished. Exiting.");
      stopHeartbeat = true;
      await heartbeatTask;
      return;
    }
  }


  // Normal agent lifetime is owned by the one heartbeat task above.
  await heartbeatTask;
}

module.exports = { runAgent, loadConfig, saveConfig, defaultConfigPath, applyPortalConfig, bumpStats, pushActivity, _watchdog: { takeWatchdogLock, pidIsOurSupervisor, pidAlive, WATCHDOG_LOCK, WATCHDOG_LOG, supervisorNote } };

// Allow running directly: agent.exe [token] [portalUrl] [--setup] [--open] [--watchdog] [--no-browser] [--call]
if (require.main === module) {
  // First durable line of the process, whatever mode it ends up in.
  try {
    supervisorNote(`process boot pid=${process.pid} ver=${VERSION} packed=${isPacked()} argv=${JSON.stringify(process.argv.slice(1))}`);
  } catch {}
  const argv = process.argv.slice(2);
  const setup = argv.includes("--setup");
  const open = argv.includes("--open") || argv.includes("--launch") || argv.includes("--show");
  const call = argv.includes("--call") || argv.includes("--call-once");
  const callOnce = argv.includes("--call-once");
  const noBrowser = argv.includes("--no-browser") || argv.includes("--silent") || argv.includes("--startup");
   const rest = argv.filter((a) => !a.startsWith("--"));
  if (argv.includes("--watchdog")) {
    runWatchdog(argv.filter((a) => a !== "--watchdog")).catch((e) => {
      supervisorNote(`watchdog supervisor crashed: ${safeLog(e)}`);
      console.error(safeLog(e));
      process.exit(1);
    });
  } else {
    runAgent({ token: rest[0], portalUrl: rest[1], setup, call, callOnce, open, noBrowser }).catch((e) => {
      supervisorNote(`agent crashed: ${safeLog(e)}`);
      console.error(safeLog(e));
      process.exit(1);
    });
  }
}