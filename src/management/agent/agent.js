const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn, execSync } = require("node:child_process");
const { HEARTBEAT_INTERVAL_MS, HOSTED_VOIP_SERVERS } = require("../shared/protocol");
const { setUi } = require("./ui");
const { topStrategy } = require("./brain");
const { startWebUi, writeDashboardUrl, dashboardUrlPath } = require("./webui");
const localDb = require("./local-db");
const sync = require("./sync");
const { emailQualifiedLead } = require("./email");
const { ensurePhoneSession } = require("./call-start");
const { startEngineHealthServer } = require("./engine-health");\nconst { checkForUpdate } = require("./auto-update");

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
    log("saveConfig failed: " + (err && err.message || err));
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

function takeWatchdogLock() {
  try {
    if (fs.existsSync(WATCHDOG_LOCK)) {
      const old = Number(String(fs.readFileSync(WATCHDOG_LOCK, "utf8")).trim());
      if (old && (process.platform === "win32" ? old !== process.pid && pidAlive(old) : pidAlive(old))) {
        console.log(`[watchdog] another supervisor (pid ${old}) is already running — exiting.`);
        return false;
      }
    }
    fs.mkdirSync(path.dirname(WATCHDOG_LOCK), { recursive: true });
    fs.writeFileSync(WATCHDOG_LOCK, String(process.pid));
    return true;
  } catch { return true; } // never block supervision over a lock file
}

async function runWatchdog(args) {
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
    log(`watchdog starting agent (pid engine: ${childCmd.cmd})...`);
    const watchdogLog = path.join(path.dirname(WATCHDOG_LOCK), "watchdog-child.log");
    let logFd = null;
    try { logFd = fs.openSync(watchdogLog, "a"); } catch {}
    const child = spawn(childCmd.cmd, childCmd.args, { stdio: ["ignore", logFd == null ? "inherit" : logFd, logFd == null ? "inherit" : logFd] });
    const exited = await new Promise((resolve) => {
      child.on("exit", (code) => { try { if (logFd != null) fs.closeSync(logFd); } catch {} resolve({ code, ranFor: Date.now() - (child._start || Date.now()) }); });
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
      crashes = wasCrash && crashy ? crashes + 1 : Math.max(0, crashes - 1);
      log(`agent exited early (code ${exited.code}) — restarting in ${wasCrash ? 4000 : 2000}ms.`);
      await restart(wasCrash ? 4000 : 2000);
    }
  }
}

/** Agent version surfaced in dashboard + status. */
const VERSION = "1.3.0";\n\nfunction scheduleAutoUpdate() {\n  const run = () => checkForUpdate(VERSION).then((r) => { if (r.updated) { log(`Verified update ${r.version} launched; exiting for supervised restart.`); setTimeout(() => process.exit(0), 1500); } }).catch((e) => log("Auto-update check failed safely: " + e.message));\n  setTimeout(run, 15000);\n  const timer = setInterval(run, 6 * 60 * 60 * 1000);\n  if (timer.unref) timer.unref();\n}\n

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
  if (typeof portalCfg.lang === "string" && /^(en|es|fr|de|pt|hi|auto)$/.test(portalCfg.lang.trim())) set("lang", portalCfg.lang.trim());
  if (typeof portalCfg.voiceStyle === "string" && /^(human|frank|friendly)$/.test(portalCfg.voiceStyle.trim())) set("voiceStyle", portalCfg.voiceStyle.trim());
  if (portalCfg.voip && typeof portalCfg.voip === "object" && portalCfg.voip.number && portalCfg.voip.username) {
    const prior = config.voip || {};
    const provider = portalCfg.voip.provider || prior.provider || "";
    const defaultServer = HOSTED_VOIP_SERVERS[provider] || HOSTED_VOIP_SERVERS[prior.provider] || "";
    const next = {
      provider,
      number: portalCfg.voip.number,
      extension: portalCfg.voip.extension || "",
      username: portalCfg.voip.username,
      sipPassword: portalCfg.voip.sipPassword || "",
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
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
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
async function runAgent(opts = {}) {\n  if (isPacked()) scheduleAutoUpdate();
  let engineHealthServer = null;
  try { engineHealthServer = await startEngineHealthServer({ version: VERSION }); log("Local engine health: http://127.0.0.1:18787/health"); }
  catch (e) { log("Local engine health unavailable: " + e.message); }
  const cfgPath = opts.configPath || defaultConfigPath();
  const configDir = path.dirname(cfgPath);
  let config = loadConfig(cfgPath);

  if (!takeAgentLock()) {
    log("Magic Dialer is already running - opening its dashboard...");
    if (!openDashboardExternal()) openBrowser("http://127.0.0.1:48771/");
    setTimeout(() => process.exit(0), 800);
    return;
  }

  // Initialize local database for offline resilience
  try { localDb.open(configDir); log("Local database ready."); } catch (e) { log("Local DB init failed: " + e.message); }

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

  if (!config || !config.token || !config.portalUrl) {
    config = config || {};
    config.machineId = config.machineId || crypto.randomUUID();
    config.lang = config.lang || "en";
    config.voiceStyle = config.voiceStyle || "human";

    if (opts.portalUrl && opts.token) {
      config.portalUrl = opts.portalUrl;
      config.token = opts.token;
      saveConfig(config, cfgPath);
    }

    if (!config.token || !config.portalUrl) {
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
    const srv = await ensureWebUi();
    if (!opts.noBrowser && (opts.setup === true || opts.open === true || isPacked())) {
      maybeOpen(srv.url);
    }
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

  // Optional: run one live voice call before entering the heartbeat loop.
  // `--call` makes the agent speak through the speakers and listen through
  // the mic (free). A real phone line plugs in as a different speak/listen.
  if (opts.call === true) {
    let voiceCall;
    try { ({ voiceCall } = require("./call")); } catch (err) { log("call module unavailable: " + err.message); }
    if (voiceCall) try {
      // Bind this conversation to the cloud SIP session that actually owns the
      // phone audio. Never let a telephone call silently fall back to the PC mic.
      const phoneSession = await ensurePhoneSession({
        portal,
        token: config.token,
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
        token: config.token,
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
      log("Voice call failed: " + e.message);
      ui({ mode: config.mode || "on", line: "Voice call failed - retrying later." });
    }
    if (opts.callOnce === true) {
      log("Test call finished. Exiting (heartbeat stays with the main agent).");
      return;
    }
  }

  // Heartbeat + obey disable loop.
  while (true) {
    try {
      const syncPayload = sync.buildSyncPayload();
      const res = await post(`${portal}/api/heartbeat`, {
        token: config.token,
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
        // Process sync acknowledgements from portal
        if (res.body.sync) sync.processSyncResponse(res.body.sync);
        const stats = localDb.stats();
        const hl = `heartbeat OK | ${stats.leads} leads, ${stats.calls} calls, ${stats.leadsUnsynced} unsynced`;
        log(hl);
        ui({ status: "ONLINE", mode: config.mode || "on", line: hl });
      } else {
        log(`heartbeat rejected (status ${res.status}) - not a registered customer.`);
        ui({ status: "OFFLINE", mode: config.mode || "on", line: "Heartbeat rejected - check your access key." });
      }
    } catch (err) {
      log(`heartbeat failed (${err.code || err.message}) - retrying. Agent continues offline.`);
      ui({ status: "OFFLINE", mode: config.mode || "on", line: "Reconnecting to portal..." });
    }
    await new Promise((r) => setTimeout(r, HEARTBEAT_INTERVAL_MS));
  }
}

module.exports = { runAgent, loadConfig, saveConfig, defaultConfigPath, applyPortalConfig, bumpStats, pushActivity };

// Allow running directly: agent.exe [token] [portalUrl] [--setup] [--open] [--watchdog] [--no-browser] [--call]
if (require.main === module) {
  const argv = process.argv.slice(2);
  const setup = argv.includes("--setup");
  const open = argv.includes("--open") || argv.includes("--launch") || argv.includes("--show");
  const call = argv.includes("--call") || argv.includes("--call-once");
  const callOnce = argv.includes("--call-once");
  const noBrowser = argv.includes("--no-browser") || argv.includes("--silent") || argv.includes("--startup");
   const rest = argv.filter((a) => !a.startsWith("--"));
  if (argv.includes("--watchdog")) {
    runWatchdog(argv.filter((a) => a !== "--watchdog")).catch((e) => { console.error(e); process.exit(1); });
  } else {
    runAgent({ token: rest[0], portalUrl: rest[1], setup, call, callOnce, open, noBrowser }).catch((e) => {
      console.error(e);
      process.exit(1);
    });
  }
}