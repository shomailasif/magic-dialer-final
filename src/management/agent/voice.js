const { spawnSync, spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Hybrid neural voice for the agent — human-sounding, not the robotic Windows
 * TTS. Three tiers, tried in order:
 *
 *   1. edge-tts  (Microsoft Edge neural voices, Python) — best quality,
 *      multilingual (140+ languages / 400+ voices), near-instant. Needs
 *      internet + Python 3 + `pip install edge-tts`.
 *   2. HeadTTS   (Kokoro neural model, local Node.js server on :8883) —
 *      fully offline fallback, human-sounding, English only.
 *   3. Windows   (System.Speech / Zira) — last-resort that always works.
 *
 * All three are free with no API key, no account, no paid service.
 */

const TMP = path.join(os.tmpdir(), "autodial-voice");
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

// Map our persona (energetic female) to the best neural voice per language.
// Keys are our locale codes (see i18n). Falls back to en-US Ava.
const NEURAL_VOICES = {
  en: "en-US-AvaNeural",
  "en-us": "en-US-AvaNeural",
  "en-gb": "en-GB-SoniaNeural",
  "en-au": "en-AU-NatashaNeural",
  "en-ca": "en-CA-ClaraNeural",
  "en-in": "en-IN-NeerjaNeural",
  ar: "ar-SA-ZariyahNeural",
  zh: "zh-CN-XiaoxiaoNeural",
  "zh-cn": "zh-CN-XiaoxiaoNeural",
  "zh-tw": "zh-TW-HsiaoChenNeural",
  cs: "cs-CZ-VlastaNeural",
  da: "da-DK-ChristelNeural",
  nl: "nl-NL-ColetteNeural",
  fi: "fi-FI-SelmaNeural",
  fr: "fr-FR-DeniseNeural",
  de: "de-DE-KatjaNeural",
  el: "el-GR-AthinaNeural",
  he: "he-IL-HilaNeural",
  hi: "hi-IN-SwaraNeural",
  hu: "hu-HU-NoemiNeural",
  id: "id-ID-GadisNeural",
  it: "it-IT-ElsaNeural",
  ja: "ja-JP-NanamiNeural",
  ko: "ko-KR-SunHiNeural",
  ms: "ms-MY-YasminNeural",
  nb: "nb-NO-PernilleNeural",
  pl: "pl-PL-ZofiaNeural",
  pt: "pt-BR-FranciscaNeural",
  "pt-br": "pt-BR-FranciscaNeural",
  "pt-pt": "pt-PT-RaquelNeural",
  ro: "ro-RO-AlinaNeural",
  ru: "ru-RU-SvetlanaNeural",
  sk: "sk-SK-ViktoriaNeural",
  sl: "sl-SI-PetraNeural",
  es: "es-ES-ElviraNeural",
  "es-mx": "es-MX-DaliaNeural",
  "es-es": "es-ES-ElviraNeural",
  sv: "sv-SE-SofieNeural",
  th: "th-TH-PremwadeeNeural",
  tr: "tr-TR-EmelNeural",
  uk: "uk-UA-PolinaNeural",
  vi: "vi-VN-HoaiMyNeural",
};

/**
 * Voice styles the operator can choose from in the portal (voice v2):
 *
 *   human    — natural, even, plainspoken (the default; unchanged behavior).
 *   frank    — business-like, direct, decisive (deeper/male neural voices).
 *   friendly — warm, upbeat, approachable (brighter female neural voices).
 *
 * Style is locale-aware: each style has its own best neural voice per
 * language, and all three tiers (edge, HeadTTS, Windows) honor a small
 * per-style pacing tweak. English defaults are byte-for-byte the old
 * behavior, so existing installs hear no change.
 */

// Franks/direct voices (male, businesslike) per language for the "frank" style.
const FRANK_VOICES = {
  en: "en-US-DavisNeural",
  "en-us": "en-US-DavisNeural",
  "en-gb": "en-GB-RyanNeural",
  "en-au": "en-AU-WilliamNeural",
  "en-ca": "en-CA-LiamNeural",
  "en-in": "en-IN-PrabhatNeural",
  fr: "fr-FR-RemyNeural",
  "fr-fr": "fr-FR-RemyNeural",
  "fr-ca": "fr-CA-AntoineNeural",
  de: "de-DE-ConradNeural",
  es: "es-ES-AlvaroNeural",
  "es-es": "es-ES-AlvaroNeural",
  "es-mx": "es-MX-JorgeNeural",
  pt: "pt-BR-AntonioNeural",
  "pt-br": "pt-BR-AntonioNeural",
  "pt-pt": "pt-PT-DuarteNeural",
  hi: "hi-IN-MadhurNeural",
  ar: "ar-SA-HamedNeural",
  ru: "ru-RU-DmitryNeural",
  tr: "tr-TR-AhmetNeural",
  uk: "uk-UA-OstapNeural",
  it: "it-IT-DiegoNeural",
  pl: "pl-PL-MarekNeural",
  nl: "nl-NL-MaartenNeural",
  ko: "ko-KR-InJoonNeural",
  ja: "ja-JP-KeitaNeural",
  "zh-cn": "zh-CN-YunxiNeural",
  cs: "cs-CZ-AntoninNeural",
  el: "el-GR-NestorasNeural",
  fi: "fi-FI-HarriNeural",
  sv: "sv-SE-MattiasNeural",
  da: "da-DK-JeppeNeural",
  nb: "nb-NO-FinnNeural",
  he: "he-IL-AvriNeural",
  id: "id-ID-ArdiNeural",
  th: "th-TH-NiwatNeural",
  vi: "vi-VN-NamMinhNeural",
  ms: "ms-MY-FaizNeural",
  sk: "sk-SK-LukasNeural",
  sl: "sl-SI-RokNeural",
  ro: "ro-RO-EmilNeural",
};

// Brighter/upbeat voices for the "friendly" style. Most locales already have
// a warm female default in NEURAL_VOICES, so only override where a distinctly
// friendlier option exists.
const FRIENDLY_VOICES = {
  en: "en-US-AvaNeural",
  "en-us": "en-US-AvaNeural",
  "en-gb": "en-GB-SoniaNeural",
  "en-au": "en-AU-NatashaNeural",
  "en-ca": "en-CA-ClaraNeural",
  "en-in": "en-IN-NeerjaNeural",
  fr: "fr-FR-DeniseNeural",
  "fr-fr": "fr-FR-DeniseNeural",
  de: "de-DE-KatjaNeural",
  es: "es-ES-ElviraNeural",
  "es-es": "es-ES-ElviraNeural",
  "es-mx": "es-MX-DaliaNeural",
  pt: "pt-BR-FranciscaNeural",
  "pt-br": "pt-BR-FranciscaNeural",
  "pt-pt": "pt-PT-RaquelNeural",
  hi: "hi-IN-SwaraNeural",
};

const VALID_STYLES = new Set(["human", "frank", "friendly"]);

/** Normalize a style to one of human|frank|friendly (default human). */
function normalizeStyle(style) {
  const s = String(style || "").toLowerCase().trim();
  return VALID_STYLES.has(s) ? s : "human";
}

/** Full voice for a locale + style. Falls back gracefully to the base voice. */
function edgeVoiceFor(locale, style) {
  const raw = String(locale || "en");
  const full = raw.toLowerCase();
  const base = full.split("-")[0];
  const human = NEURAL_VOICES[full] || NEURAL_VOICES[base] || "en-US-JennyNeural";
  const s = normalizeStyle(style);
  const table = s === "frank" ? FRANK_VOICES : s === "friendly" ? FRIENDLY_VOICES : null;
  if (table) {
    const styled = table[full] || table[base];
    if (styled) return styled;
  }
  return human;
}

/** Speech pacing multiplier per style (frank is a touch crisper). */
function styleRate(style, rate) {
  const r = Number(rate) || 1;
  if (normalizeStyle(style) === "frank") return Math.min(1.2, r * 1.06);
  return r;
}

let PYTHON = null;
let PYTHON_PROBED = false;

/**
 * Find a working Python for edge-tts. On Windows the bare `python` command can
 * resolve to the Microsoft Store stub, which fails silently. Prefer a real
 * interpreter found on disk, then fall back to `python`/`py` on PATH.
 * The result (including "none found") is cached after the first probe so a
 * missing Python cannot re-run every candidate on every utterance.
 */
function resolvePython() {
  if (PYTHON_PROBED) return PYTHON;
  PYTHON_PROBED = true;
  const home = os.homedir();
  const bundledPython = path.join(path.dirname(process.execPath || ""), "runtime", "python", "python.exe");
  const candidates = [
    bundledPython,
    process.env.AUTODIAL_PYTHON,
    process.env.PYTHON,
    path.join(home, "AppData", "Local", "Programs", "Python", "Python312", "python.exe"),
    path.join(home, "AppData", "Local", "Programs", "Python", "Python313", "python.exe"),
    path.join(home, "AppData", "Local", "Programs", "Python", "Python311", "python.exe"),
    "C:\\Python312\\python.exe",
    "C:\\Python311\\python.exe",
    "python",
    "py",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const t = spawnSync(c, ["--version"], { stdio: "ignore", timeout: 10000 });
      if (t.status === 0) { PYTHON = c; return c; }
    } catch { /* keep looking */ }
  }
  return null;
}

/**
 * Spawn a child process WITHOUT blocking the event loop. A blocking spawnSync
 * during a live call freezes the media WebSocket, VAD and heartbeats for the
 * whole synthesis, which the carrier hears as a dead/broken line.
 */
function runAsync(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ status: -1, stdout: "", stderr: String((e && e.message) || e) });
      return;
    }
    let stdout = "", stderr = "", done = false;
    const finish = (status) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(-1); }, timeoutMs);
    if (child.stdout) child.stdout.on("data", (d) => { if (stdout.length < 8192) stdout += d; });
    if (child.stderr) child.stderr.on("data", (d) => { if (stderr.length < 8192) stderr += d; });
    child.on("error", (e) => { stderr += String((e && e.message) || e); finish(-1); });
    child.on("close", (status) => finish(status == null ? -1 : status));
  });
}

/** Speak via edge-tts (Python). Returns true on success. Async: never blocks the event loop. */
async function speakEdge(text, { locale = "en", rate = 1, style = "human" } = {}) {
  if (process.env.AUTODIAL_NO_EDGE_TTS === "1") return false;
  const python = resolvePython();
  if (!python) return false;
  const file = path.join(TMP, `edge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp3`);
  const effRate = styleRate(style, rate);
  const rateArg = effRate === 1 ? "+0%" : `${effRate > 1 ? "+" : ""}${Math.round((effRate - 1) * 60)}%`;
  const voice = edgeVoiceFor(locale, style);
  try {
    const r = await runAsync(
      python,
      ["-m", "edge_tts", "--voice", voice, "--rate", rateArg, "--text", text, "--write-media", file],
      90000,
    );
    if (r.status !== 0 || !fs.existsSync(file) || fs.statSync(file).size < 100) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return false;
    }
    const ok = playFile(file);
    try { fs.unlinkSync(file); } catch {}
    return ok;
  } catch {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return false;
  }
}

/** Speak via HeadTTS (local Kokoro server). Returns true on success. */
async function speakHeadTTS(text, { locale = "en", rate = 1, style = "human" } = {}) {
  if (process.env.AUTODIAL_NO_HEADTTS === "1") return false;
  const file = path.join(TMP, `headtts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`);
  try {
    const ok = await synthViaServer(text, file, locale, styleRate(style, rate));
    if (!ok || !fs.existsSync(file) || fs.statSync(file).size < 1000) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return false;
    }
    const played = playFile(file);
    try { fs.unlinkSync(file); } catch {}
    return played;
  } catch {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return false;
  }
}

/** POST to HeadTTS server, write base64 audio to `outFile`. */
function synthViaServer(text, outFile, locale, rate) {
  return new Promise((resolve) => {
    const data = JSON.stringify({
      input: text,
      voice: "af_bella",
      language: String(locale).split("-")[0] === "fi" ? "fi" : "en-us",
      speed: clamp(rate, 0.5, 2),
      audioEncoding: "wav",
    });
    const req = http.request(
      { host: "127.0.0.1", port: 8883, path: "/v1/synthesize", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (j && j.audio) { fs.writeFileSync(outFile, Buffer.from(j.audio, "base64")); resolve(true); return; }
          } catch { /* fall through */ }
          resolve(false);
        });
      },
    );
    req.on("error", () => resolve(false));
    req.setTimeout(240000, () => { req.destroy(); resolve(false); });
    req.write(data);
    req.end();
  });
}

function localeToHeadTTS(locale) { return String(locale).split("-")[0] === "fi" ? "fi" : "en-us"; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** Speak via Windows System.Speech (always available). Returns true. */
function speakWindows(text, { rate = 1, volume = 100 } = {}) {
  const chosen = "Microsoft Zira Desktop";
  const rate10 = Math.round(rate * 10);
  const script = `
    Add-Type -AssemblyName System.Speech
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    foreach($v in $s.GetInstalledVoices()) { if($v.VoiceInfo.Name -eq '${ps(chosen)}') { $s.SelectVoice($v.VoiceInfo.Name); break } }
    $s.Rate = ${rate10}
    $s.Volume = ${Number(volume) || 100}
    $s.Speak('${ps(text)}')
  `;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", timeout: 60000 });
  return r.status === 0;
}

function ps(v) {
  return String(v || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''");
}

/**
 * Play a generated audio file (WAV or MP3) through the speakers using the
 * Windows Media Player (WPF) engine via PowerShell. Waits for the file's real
 * duration (so short lines don't stall and long lines don't get cut off).
 * Returns true on success.
 */
function playFile(file) {
  const url = "file:///" + file.replace(/\\/g, "/").replace(/ /g, "%20");
  const script =
    "Add-Type -AssemblyName PresentationCore;" +
    "$p = New-Object System.Windows.Media.MediaPlayer;" +
    "$p.Open([uri]'" + url + "');" +
    "while(-not $p.NaturalDuration.HasTimeSpan){ Start-Sleep -Milliseconds 50 };" +
    "$d = [Math]::Max(1.0, $p.NaturalDuration.TimeSpan.TotalSeconds);" +
    "$p.Play(); Start-Sleep -Milliseconds ([Math]::Min(15000, ($d * 1000) + 350));" +
    "$p.Stop(); $p.Close()";
  try {
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { stdio: "ignore", timeout: 30000 },
    );
    return r.status === 0;
  } catch { return false; }
}

/**
 * Speak text out loud. Tries the best available engine:
 *   edge-tts -> HeadTTS -> Windows.
 * Returns { engine, ok } so callers know which tier was used.
 */
async function speak(text, { voice, rate = 1, volume = 100, locale = "en", style = "human" } = {}) {
  if (await speakEdge(text, { locale, rate, style })) return { engine: "edge", ok: true };
  if (await speakHeadTTS(text, { locale, rate, style })) return { engine: "headtts", ok: true };
  const ok = speakWindows(text, { rate: styleRate(style, rate), volume });
  return { engine: "windows", ok };
}

let FFMPEG = null;
let FFMPEG_PROBED = false;

/**
 * Find ffmpeg binary (cached after first probe, including "not found").
 * Checks Python's imageio-ffmpeg first, then PATH.
 */
function resolveFfmpeg() {
  if (FFMPEG_PROBED) return FFMPEG;
  FFMPEG_PROBED = true;
  // Try Python's bundled ffmpeg
  const python = resolvePython();
  if (python) {
    try {
      const r = spawnSync(python, ["-c", "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"], {
        stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
      });
      if (r.status === 0) {
        const p = (r.stdout || "").toString().trim();
        if (p && fs.existsSync(p)) { FFMPEG = p; return FFMPEG; }
      }
    } catch {}
  }
  // Try PATH
  for (const c of ["ffmpeg", "ffmpeg.exe"]) {
    try {
      const r = spawnSync(c, ["-version"], { stdio: "ignore", timeout: 5000 });
      if (r.status === 0) { FFMPEG = c; return FFMPEG; }
    } catch {}
  }
  return null;
}

/**
 * ITU-T G.711 mu-law encode table, built once from the SAME decode formula
 * used by vad.js / multilingual-stt.js so every decoded sample round-trips.
 */
const MULAW_ENC = (() => {
  const table = new Uint8Array(32768);
  const codes = [];
  for (let u = 255; u >= 128; u--) {
    const c = (~u) & 0xff;
    const e = (c >> 4) & 7;
    const m = c & 15;
    codes.push({ u, val: (((m << 1) + 33) << (e + 2)) - 132 });
  }
  let ci = 0;
  for (let v = 0; v <= 32767; v++) {
    while (ci < codes.length - 1 && v >= (codes[ci].val + codes[ci + 1].val) / 2) ci++;
    table[v] = codes[ci].u;
  }
  return table;
})();

function mulawEncode(sample) {
  let v = Math.round(sample);
  if (v < 0) return MULAW_ENC[v < -32767 ? 32767 : -v] ^ 0x80;
  return MULAW_ENC[v > 32767 ? 32767 : v];
}

/** Parse a PCM WAV buffer into mono Int16 samples at its native rate, or null. */
function wavToMono16(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44) return null;
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") return null;
  let pos = 12, format = 0, channels = 0, rate = 0, bits = 0, data = null;
  while (pos + 8 <= wav.length) {
    const id = wav.toString("ascii", pos, pos + 4);
    const size = wav.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt " && body + 16 <= wav.length) {
      format = wav.readUInt16LE(body);
      channels = wav.readUInt16LE(body + 2);
      rate = wav.readUInt32LE(body + 4);
      bits = wav.readUInt16LE(body + 14);
    } else if (id === "data") {
      data = wav.subarray(body, Math.min(body + size, wav.length));
      break;
    }
    pos = body + size + (size % 2);
  }
  if (!data || !rate || !channels || bits !== 16 || (format !== 1 && format !== 0xfffe)) return null;
  const frames = Math.floor(data.length / (channels * 2));
  if (frames <= 0) return null;
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += data.readInt16LE((i * channels + c) * 2);
    out[i] = Math.round(acc / channels);
  }
  return { samples: out, rate };
}

/** Linear resample mono Int16 samples to 8000 Hz (telephony rate). */
function resampleTo8k(samples, rate) {
  if (rate === 8000) return samples;
  if (!rate || rate <= 0 || !samples.length) return null;
  const ratio = rate / 8000;
  const outLen = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = src - i0;
    const v = samples[i0] * (1 - frac) + samples[i1] * frac;
    out[i] = v < -32768 ? -32768 : v > 32767 ? 32767 : Math.round(v);
  }
  return out;
}

/** Convert any PCM WAV to raw PCMU/8000 telephone audio, or null. */
function wavToMulaw(wav) {
  const parsed = wavToMono16(wav);
  if (!parsed) return null;
  const samples = resampleTo8k(parsed.samples, parsed.rate);
  if (!samples || !samples.length) return null;
  const out = Buffer.allocUnsafe(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = mulawEncode(samples[i]);
  return out;
}

/**
 * Tier 1 for the phone path: edge-tts MP3 -> ffmpeg -> PCMU/8000.
 * Async spawn so the media WebSocket / VAD / heartbeats keep running while
 * the voice synthesizes.
 */
async function edgeToBuffer(text, { locale, style, rate }) {
  if (process.env.AUTODIAL_NO_EDGE_TTS === "1") return null;
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) return null;
  const python = resolvePython();
  if (!python) return null;
  const file = path.join(TMP, `tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp3`);
  try {
    const voice = edgeVoiceFor(locale, style);
    const effRate = styleRate(style, rate);
    const rateArg = effRate === 1 ? "+0%" : `${effRate > 1 ? "+" : ""}${Math.round((effRate - 1) * 60)}%`;
    const r = await runAsync(
      python,
      ["-m", "edge_tts", "--voice", voice, "--rate", rateArg, "--text", text, "--write-media", file],
      60000,
    );
    if (r.status !== 0 || !fs.existsSync(file) || fs.statSync(file).size < 100) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return null;
    }
    const rawPath = file.replace(/\.mp3$/, ".raw");
    const conv = spawnSync(ffmpeg, ["-i", file, "-ar", "8000", "-ac", "1", "-f", "mulaw", "-y", rawPath], { stdio: "pipe", timeout: 15000 });
    if (conv.status !== 0 || !fs.existsSync(rawPath) || fs.statSync(rawPath).size < 160) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
      return null;
    }
    const buffer = fs.readFileSync(rawPath);
    try { fs.unlinkSync(file); } catch {}
    try { fs.unlinkSync(rawPath); } catch {}
    return { buffer, engine: "edge" };
  } catch {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return null;
  }
}

/** Tier 2: local HeadTTS (Kokoro) -> WAV -> pure-JS PCMU (no ffmpeg needed). */
async function headTtsToBuffer(text, { locale, style, rate }) {
  if (process.env.AUTODIAL_NO_HEADTTS === "1") return null;
  const file = path.join(TMP, `headtts-buf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`);
  try {
    const ok = await synthViaServer(text, file, locale, styleRate(style, rate));
    if (!ok || !fs.existsSync(file) || fs.statSync(file).size < 1000) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return null;
    }
    const wav = fs.readFileSync(file);
    try { fs.unlinkSync(file); } catch {}
    const buffer = wavToMulaw(wav);
    return buffer && buffer.length >= 160 ? { buffer, engine: "headtts" } : null;
  } catch {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return null;
  }
}

/** Tier 3: Windows SAPI -> WAV -> pure-JS PCMU (always available on Windows). */
function sapiToBuffer(text, { rate = 1 } = {}) {
  const file = path.join(TMP, `sapi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`);
  try {
    const chosen = "Microsoft Zira Desktop";
    const rate10 = Math.round(rate * 10);
    const wavPath = file.replace(/\\/g, "/").replace(/'/g, "''");
    const script = `
      Add-Type -AssemblyName System.Speech
      $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
      foreach($v in $s.GetInstalledVoices()) { if($v.VoiceInfo.Name -eq '${ps(chosen)}') { $s.SelectVoice($v.VoiceInfo.Name); break } }
      $s.Rate = ${rate10}
      $s.SetOutputToWaveFile('${wavPath}')
      $s.Speak('${ps(text)}')
      $s.SetOutputToNull()
      $s.Dispose()
    `;
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", timeout: 30000 });
    if (r.status !== 0 || !fs.existsSync(file) || fs.statSync(file).size < 100) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return null;
    }
    const wav = fs.readFileSync(file);
    try { fs.unlinkSync(file); } catch {}
    const buffer = wavToMulaw(wav);
    return buffer && buffer.length >= 160 ? { buffer, engine: "windows" } : null;
  } catch {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return null;
  }
}

/**
 * Generate TTS audio and return as a raw PCM buffer (mulaw 8kHz mono).
 * Used by the media channel to stream agent voice to the lead.
 *
 * Three tiers, best first:
 *   1. edge-tts   (neural, multilingual) -> ffmpeg -> PCMU
 *   2. HeadTTS    (local Kokoro)         -> WAV -> pure-JS PCMU
 *   3. Windows    (System.Speech/Zira)   -> WAV -> pure-JS PCMU
 *
 * A silent turn sounds like a broken line to the prospect, so lower tiers
 * keep the phone fed even when Python / edge-tts / ffmpeg are unavailable.
 * Returns { buffer, engine } or null only when every tier fails.
 */
async function speakToBuffer(text, { locale = "en", style = "human", rate = 1 } = {}) {
  const edge = await edgeToBuffer(text, { locale, style, rate });
  if (edge) return edge;
  const headtts = await headTtsToBuffer(text, { locale, style, rate });
  if (headtts) return headtts;
  const sapi = sapiToBuffer(text, { locale, style, rate });
  if (sapi) return sapi;
  return null;
}

module.exports = { speak, speakEdge, speakHeadTTS, speakWindows, speakToBuffer, edgeVoiceFor, normalizeStyle, styleRate, wavToMulaw, mulawEncode };
