/* A brain that runs on this PC.
 *
 * The hosted free tier is fast but metered; a customer who runs out of tokens
 * goes silent mid-call. This module owns the local alternative: llama.cpp's
 * server, a small quantised model, and the download that fetches it once.
 *
 * It is deliberately optional. Every entry point answers "not available"
 * instead of throwing, so a PC without the runtime, without the model, or with
 * a broken one keeps using the hosted path and never loses a call.
 *
 * Nothing here is bundled into the 50 MB installer except the ~25 MB server
 * binaries; the model is downloaded on first use into the same folder, with a
 * pinned size and SHA-256 so a truncated or swapped file is rejected.
 */
"use strict";
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const MODEL_FILE = "qwen2.5-1.5b-instruct-q4_k_m.gguf";
const MODEL_URL =
  "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf";
/* Published file, pinned. A truncated or swapped download is refused. */
const MODEL_BYTES = 1117320736;
const MODEL_SHA256 = "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e";

const FIRST_PORT = 48773;
const LAST_PORT = 48779;
const READY_TIMEOUT_MS = 90000;

function appDir() {
  /* Packaged: agent.exe sits in the install folder and local-ai is beside it.
   * Development: the build output is the same shape. */
  const exe = process.execPath || "";
  const packed = /^(agent|magicdialer)\.exe$/i.test(path.basename(exe));
  const dir = packed || !exe ? path.dirname(exe || process.cwd()) : process.cwd();
  return path.join(dir, "local-ai");
}

/* The model is a user download, not part of the install, so it lives with the
 * customer's data: an upgrade or uninstall of the program folder must not cost
 * them another 1.1 GB. */
function dataDir() {
  if (process.env.AUTODIAL_HOME) return process.env.AUTODIAL_HOME;
  if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, "Magic Dialer");
  return appDir();
}

function modelPath() {
  return path.join(dataDir(), "models", MODEL_FILE);
}

function serverPath() {
  return path.join(appDir(), "llama-server.exe");
}

function installed() {
  if (forcedInstalled !== null) return forcedInstalled;
  try {
    if (!fs.existsSync(serverPath())) return false;
    const stat = fs.statSync(modelPath());
    if (!stat.isFile()) return false;
    if (MODEL_BYTES && stat.size !== MODEL_BYTES) return false;
    return stat.size > 100 * 1024 * 1024;
  } catch {
    return false;
  }
}

/* What the dashboard reports, without loading the model. */
function status() {
  let bytes = 0;
  try { bytes = fs.statSync(modelPath()).size; } catch {}
  return {
    installed: installed(),
    server: fs.existsSync(serverPath()),
    modelBytes: bytes,
    expectedBytes: MODEL_BYTES,
    running: !!(child && child.exitCode === null),
  };
}

function sha256File(file) {  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function httpJson({ port, method, route, body, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
        timeout: timeoutMs,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": payload.length }
          : {},
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("local model timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* One server per process, started on first use and reused for every turn.
 * Model load is ~2s; paying that per turn is the difference between a
 * conversation and a walkie-talkie. */
let child = null;
let childPort = 0;
let starting = null;
let lastError = "";

/* The model is ~1.3 GB of resident memory and it only matters while calls are
 * happening. Ten idle minutes after the last turn it is stopped, so a dialer
 * left running overnight is not holding that memory for nothing. The next call
 * warms it again before the phone rings. */
const IDLE_STOP_MS = 10 * 60 * 1000;
let idleTimer = null;

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    stopServer();
  }, IDLE_STOP_MS);
  /* Never keep the agent process alive just for this. */
  if (idleTimer && typeof idleTimer.unref === "function") idleTimer.unref();
}

/* A server this process started must not outlive it. An upgrade kills and
 * restarts the agent; without this the old llama-server would keep the port and
 * ~1.3 GB until the machine reboots. */
process.once("exit", () => {
  try { stopServer(); } catch {}
});
let forcedInstalled = null;

function healthy(port) {
  return httpJson({ port, method: "GET", route: "/health", timeoutMs: 2000 })
    .then((r) => r.status === 200)
    .catch(() => false);
}

async function waitReady(port, childProc) {
  const stopAt = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < stopAt) {
    if (childProc.exitCode !== null) throw new Error("local model exited");
    if (await healthy(port)) return port;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("local model did not become ready");
}

async function startServer() {
  if (child && child.exitCode === null && childPort) {
    if (await healthy(childPort)) return childPort;
  }
  if (!installed()) throw new Error("local model is not installed");
  let lastFailure = null;
  for (let port = FIRST_PORT; port <= LAST_PORT; port++) {
    if (await healthy(port)) return port; // another engine instance owns it
    const proc = spawn(
      serverPath(),
      [
        "-m", modelPath(),
        "--host", "127.0.0.1",
        "--port", String(port),
        "-c", "2048",
        /* Four threads measured on the 2-core/4-thread test machine: a warm
         * turn is ~2.0s at 4 threads against ~4.0s at 2. */
        "-t", "4",
        "-np", "1",
        "--no-webui",
      ],
      { cwd: appDir(), windowsHide: true, stdio: ["ignore", "ignore", "ignore"] },
    );
    proc.on("exit", () => {
      if (child === proc) {
        child = null;
        childPort = 0;
      }
    });
    try {
      await waitReady(port, proc);
      child = proc;
      childPort = port;
      lastError = "";
      touchIdle();
      return port;
    } catch (e) {
      lastFailure = e;
      try { proc.kill(); } catch {}
      if (e && e.code === "ENOENT") break;
    }
  }
  lastError = (lastFailure && lastFailure.message) || "local model failed to start";
  throw new Error(lastError);
}

function ensureServer() {
  if (!starting) {
    starting = startServer().finally(() => {
      starting = null;
    });
  }
  return starting;
}

function stopServer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (child) {
    try { child.kill(); } catch {}
    child = null;
    childPort = 0;
  }
}

function stripThinking(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\|im_start\|>[\s\S]*$/i, "")
    .trim();
}

async function chat({ messages, maxTokens = 64, temperature = 0.6, timeoutMs = 12000 } = {}) {
  const port = await ensureServer();
  const r = await httpJson({
    port,
    method: "POST",
    route: "/v1/chat/completions",
    timeoutMs,
    body: {
      model: "local",
      messages,
      temperature,
      top_p: 0.9,
      max_tokens: maxTokens,
      stream: false,
    },
  });
  if (r.status !== 200) {
    throw new Error(`local model HTTP ${r.status}`);
  }
  let data;
  try { data = JSON.parse(r.body); } catch { throw new Error("local model returned invalid JSON"); }
  const choice = data && data.choices && data.choices[0];
  const text = stripThinking(choice && choice.message && choice.message.content);
  if (!text) throw new Error("local model returned an empty reply");
  touchIdle();
  return {
    text,
    finish: (choice && choice.finish_reason) || null,
    usage: data.usage || null,
  };
}

/* Load the model and cache the prompt prefix before anyone speaks.
 *
 * Model load is ~2.5s and the first prefill of the system prompt is ~2s on the
 * test machine. Both are paid while the phone is still ringing if we ask for
 * them here, instead of during the prospect's first answer. */
async function warm({ system, timeoutMs = 30000 } = {}) {
  if (!installed() || !String(system || "").trim()) return false;
  const port = await ensureServer();
  const r = await httpJson({
    port,
    method: "POST",
    route: "/v1/chat/completions",
    timeoutMs,
    body: {
      model: "local",
      messages: [
        { role: "system", content: String(system) },
        { role: "user", content: "CUSTOMER: hello\nCALLER:" },
      ],
      temperature: 0,
      max_tokens: 1,
      stream: false,
    },
  });
  if (r.status === 200) touchIdle();
  return r.status === 200;
}

/* Download the model once, resuming a partial file, then verify it. */
async function downloadModel({ log = () => {}, onProgress = () => {} } = {}) {
  const dest = modelPath();
  const part = dest + ".part";
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let have = 0;
  try { have = fs.statSync(part).size; } catch {}
  if (have > 0 && MODEL_BYTES && have >= MODEL_BYTES) {
    // A complete .part from a previous run still needs verifying.
  }
  log(`Downloading the free offline model (${MODEL_BYTES ? Math.round(MODEL_BYTES / 1048576) : "~1100"} MB). This happens once.`);
  const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
  const res = await fetch(MODEL_URL, { headers, redirect: "follow" });
  if (!res.ok && res.status !== 206) throw new Error(`model download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") || 0) + (res.status === 206 ? have : 0);
  const out = fs.createWriteStream(part, { flags: have > 0 && res.status === 206 ? "a" : "w" });
  let written = have;
  let lastTick = Date.now();
  for await (const chunk of res.body) {
    written += chunk.length;
    if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
    const now = Date.now();
    if (now - lastTick > 2000) {
      lastTick = now;
      onProgress({ written, total });
      if (total) log(`Offline model: ${Math.round((written / total) * 100)}%`);
    }
  }
  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  const size = fs.statSync(part).size;
  if (MODEL_BYTES && size !== MODEL_BYTES) throw new Error(`model size mismatch (${size})`);
  if (MODEL_SHA256) {
    const got = await sha256File(part);
    if (got !== MODEL_SHA256) {
      try { fs.unlinkSync(part); } catch {}
      throw new Error("model checksum mismatch");
    }
  }
  fs.renameSync(part, dest);
  log("Offline model ready.");
  return { path: dest, bytes: size };
}

/* One download at a time, reported to the dashboard. */
let downloadState = null;

function startDownload({ log = () => {} } = {}) {
  if (downloadState && !downloadState.done && !downloadState.error) return downloadState;
  if (installed()) {
    downloadState = { startedAt: Date.now(), written: MODEL_BYTES, total: MODEL_BYTES, error: "", done: true };
    return downloadState;
  }
  const state = { startedAt: Date.now(), written: 0, total: MODEL_BYTES, error: "", done: false };
  downloadState = state;
  downloadModel({
    log,
    onProgress: (p) => {
      state.written = p.written;
      if (p.total) state.total = p.total;
    },
  })
    .then(() => {
      state.done = true;
      state.written = MODEL_BYTES;
      state.finishedAt = Date.now();
    })
    .catch((e) => {
      state.error = (e && e.message) || "download failed";
      state.finishedAt = Date.now();
    });
  return state;
}

function downloadProgress() {
  return downloadState ? { ...downloadState } : null;
}

module.exports = {
  MODEL_FILE,
  MODEL_URL,
  MODEL_BYTES,
  MODEL_SHA256,
  appDir,
  dataDir,
  modelPath,
  serverPath,
  installed,
  status,
  ensureServer,
  stopServer,
  warm,
  chat,
  downloadModel,
  startDownload,
  downloadProgress,
  _test: {
    reset() {
      child = null;
      childPort = 0;
      starting = null;
      lastError = "";
      forcedInstalled = null;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    },
    lastError() {
      return lastError;
    },
    /* Point the manager at a server the test started, so no binary or model
     * has to exist to exercise the brain's routing. */
    adopt(port) {
      child = { exitCode: null, kill() {} };
      childPort = port;
      starting = null;
    },
    forceInstalled(value) {
      forcedInstalled = value;
    },
  },
};
