/* Hearing that runs on this PC.
 *
 * The hosted transcriber is faster than anything this class of laptop can do
 * locally, but it is metered and it needs the internet. This module is the
 * fallback that keeps the agent able to hear after the free quota is gone:
 * whisper.cpp's `whisper-cli` and the 74 MB multilingual "tiny" model.
 *
 * Measured on the target machine (i3-7100U, 2C/4T): 7-8 seconds of telephone
 * audio transcribes in ~2.0s with `-bs 1 -nf` and an explicit language, ~4.3s
 * for a digit-heavy sentence. That is a fallback, not a replacement for the
 * hosted model on every turn - which is why the default "auto" mode still uses
 * the hosted transcriber first.
 *
 * Deliberately narrow:
 *   - English is what this is tuned and measured for; an explicit non-English
 *     hint still works (Spanish measured accurately), but quality is the
 *     model's, not ours, and repeated output is cut.
 *   - Nothing is bundled except the ~5 MB runtime. The model is downloaded once
 *     into the customer's data folder with a pinned size and SHA-256.
 */
"use strict";
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeLanguage } = require("./language");
const { dataDir } = require("./local-ai");

const CLI_FILE = "whisper-cli.exe";
const MODEL_FILE = "ggml-tiny.bin";
const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin";
/* Published file, pinned. A truncated or swapped download is refused. */
const MODEL_BYTES = 77691713;
const MODEL_SHA256 = "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21";

/* Sits inside the controller's 9s STT turn budget and leaves room for one
 * hosted attempt if this one produces nothing. */
const LOCAL_TIMEOUT_MS = 4500;
const THREADS = 4;

function appDir() {
  const exe = process.execPath || "";
  const packed = /^(agent|magicdialer)\.exe$/i.test(path.basename(exe));
  const dir = packed || !exe ? path.dirname(exe || process.cwd()) : process.cwd();
  /* Its own folder, deliberately: whisper.cpp and llama.cpp ship different
   * builds of ggml.dll and ggml-base.dll, so the two programs cannot share a
   * directory without one breaking the other. */
  return path.join(dir, "local-ai", "whisper");
}

function cliPath() {
  return path.join(appDir(), CLI_FILE);
}

function modelPath() {
  return path.join(dataDir(), "models", MODEL_FILE);
}

let forcedInstalled = null;
let runner = null; // test hook
let lastError = "";

function installed() {
  if (forcedInstalled !== null) return forcedInstalled;
  try {
    if (!fs.existsSync(cliPath())) return false;
    const stat = fs.statSync(modelPath());
    if (!stat.isFile() || stat.size !== MODEL_BYTES) return false;
    return true;
  } catch {
    return false;
  }
}

function status() {
  let bytes = 0;
  try { bytes = fs.statSync(modelPath()).size; } catch {}
  return {
    installed: installed(),
    cli: fs.existsSync(cliPath()),
    modelBytes: bytes,
    expectedBytes: MODEL_BYTES,
    model: MODEL_FILE,
  };
}

/* ---- audio ------------------------------------------------------------------ */

function mulawDecode(mulaw) {
  mulaw = ~mulaw & 0xff;
  const sign = (mulaw & 0x80) ? -1 : 1;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0f;
  const sample = ((mantissa << 1) + 33) << (exponent + 2);
  return sign * (sample - 132);
}

/* PCMU is 8 kHz. whisper wants 16 kHz mono 16-bit, so every sample is doubled
 * and the gap is filled with the average of its neighbours - the same gentle
 * upsample the microphone path uses. A bare 8 kHz WAV is accepted by whisper's
 * decoder but is resampled with no anti-alias filter, which cost us words in
 * testing. */
function pcmuToWav16k(audio) {
  const pcm = Buffer.alloc(audio.length * 4);
  for (let i = 0; i < audio.length; i++) {
    const here = mulawDecode(audio[i]);
    const next = i + 1 < audio.length ? mulawDecode(audio[i + 1]) : here;
    pcm.writeInt16LE(here, i * 4);
    pcm.writeInt16LE((here + next) >> 1, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  const rate = 16000;
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/* Whisper tiny repeats a phrase forever on some low-resource audio (measured:
 * Urdu produced "get a chance to" for the rest of the clip). A caller must
 * never hear that, and the brain must never be handed it. Collapse an immediate
 * phrase repeated three or more times. */
function cutRepeats(text) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const out = [];
  for (const word of words) {
    const n = out.length;
    if (n >= 2 && out[n - 1] === word && out[n - 2] === word) continue;
    out.push(word);
  }
  // Longer repeated runs ("the same five words" x20) in one pass.
  const collapsed = out.join(" ").replace(/\b(.{4,60}?)(?:\s+\1){2,}\b/gi, "$1");
  return collapsed.replace(/\s+/g, " ").trim();
}

function clean(text) {
  return cutRepeats(
    String(text || "")
      .replace(/\[[\d:.\s>-]+\]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/* ---- one transcription ------------------------------------------------------ */

function runWhisper(args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cliPath(), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ ok: false, error: (e && e.message) || "whisper failed to start" });
      return;
    }
    let out = "";
    let err = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, error: `local STT exceeded ${timeoutMs}ms` });
    }, Math.max(500, timeoutMs));
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => {
      // Bounded: a failing decoder can be noisy, and none of it is wanted.
      if (err.length < 2000) err += c;
    });
    child.on("error", (e) => finish({ ok: false, error: (e && e.message) || "whisper failed" }));
    child.on("close", (code) => {
      if (code !== 0) {
        finish({ ok: false, error: `whisper exited ${code}${err ? ": " + err.split(/\r?\n/).filter(Boolean).slice(-1)[0] : ""}` });
        return;
      }
      finish({ ok: true, text: clean(out) });
    });
  });
}

/* Null when this PC cannot hear at all; throws only for a real transcription
 * failure, so the caller can fall through to the hosted transcriber. */
async function transcribe(audioBuffer, { hint = "en", timeoutMs = LOCAL_TIMEOUT_MS } = {}) {
  if (!audioBuffer || audioBuffer.length < 100) return { text: null, language: null, error: "empty audio" };
  if (!installed()) return { text: null, language: null, error: "local STT is not installed" };

  const language = String(hint || "auto").toLowerCase() === "auto" ? "auto" : normalizeLanguage(hint, "en");
  const wav = pcmuToWav16k(audioBuffer);
  const file = path.join(os.tmpdir(), `md-stt-${process.pid}-${Date.now()}.wav`);
  try {
    fs.writeFileSync(file, wav);
  } catch (e) {
    return { text: null, language: null, error: (e && e.message) || "could not write audio" };
  }
  try {
    const args = ["-m", modelPath(), "-f", file, "-t", String(THREADS), "-l", language, "-bs", "1", "-nf", "-np", "-nt"];
    const result = runner
      ? await runner({ args, language, file })
      : await runWhisper(args, timeoutMs);
    if (!result || !result.ok) {
      lastError = (result && result.error) || "local STT failed";
      return { text: null, language, error: lastError };
    }
    const text = clean(result.text);
    if (!text) return { text: null, language, error: null };
    return { text, language, error: null };
  } catch (e) {
    lastError = (e && e.message) || "local STT failed";
    return { text: null, language, error: lastError };
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
}

/* ---- one-time model download ------------------------------------------------ */

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (c) => hash.update(c));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function downloadModel({ log = () => {}, onProgress = () => {} } = {}) {
  const dest = modelPath();
  const part = dest + ".part";
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let have = 0;
  try { have = fs.statSync(part).size; } catch {}
  log(`Downloading the free offline hearing model (${Math.round(MODEL_BYTES / 1048576)} MB). This happens once.`);
  const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
  const res = await fetch(MODEL_URL, { headers, redirect: "follow" });
  if (!res.ok && res.status !== 206) throw new Error(`STT model download failed: HTTP ${res.status}`);
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
    }
  }
  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  const size = fs.statSync(part).size;
  if (size !== MODEL_BYTES) throw new Error(`STT model size mismatch (${size})`);
  const got = await sha256File(part);
  if (got !== MODEL_SHA256) {
    try { fs.unlinkSync(part); } catch {}
    throw new Error("STT model checksum mismatch");
  }
  fs.renameSync(part, dest);
  log("Offline hearing model ready.");
  return { path: dest, bytes: size };
}

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
  CLI_FILE,
  MODEL_FILE,
  MODEL_URL,
  MODEL_BYTES,
  MODEL_SHA256,
  LOCAL_TIMEOUT_MS,
  appDir,
  cliPath,
  modelPath,
  installed,
  status,
  transcribe,
  pcmuToWav16k,
  clean,
  downloadModel,
  startDownload,
  downloadProgress,
  _test: {
    reset() {
      forcedInstalled = null;
      runner = null;
      lastError = "";
      downloadState = null;
    },
    forceInstalled(value) {
      forcedInstalled = value;
    },
    setRunner(fn) {
      runner = fn;
    },
    lastError() {
      return lastError;
    },
  },
};
