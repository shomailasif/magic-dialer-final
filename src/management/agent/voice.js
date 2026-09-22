const { spawnSync } = require("node:child_process");
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

/**
 * Find a working Python for edge-tts. On Windows the bare `python` command can
 * resolve to the Microsoft Store stub, which fails silently. Prefer a real
 * interpreter found on disk, then fall back to `python`/`py` on PATH.
 * Result is cached after the first successful check.
 */
function resolvePython() {
  if (PYTHON) return PYTHON;
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

/** Speak via edge-tts (Python). Returns true on success. */
function speakEdge(text, { locale = "en", rate = 1, style = "human" } = {}) {
  if (process.env.AUTODIAL_NO_EDGE_TTS === "1") return false;
  const python = resolvePython();
  if (!python) return false;
  const file = path.join(TMP, `edge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp3`);
  const effRate = styleRate(style, rate);
  const rateArg = effRate === 1 ? "+0%" : `${effRate > 1 ? "+" : ""}${Math.round((effRate - 1) * 60)}%`;
  const voice = edgeVoiceFor(locale, style);
  try {
    const r = spawnSync(
      python,
      ["-m", "edge_tts", "--voice", voice, "--rate", rateArg, "--text", text, "--write-media", file],
      { stdio: "pipe", timeout: 90000, encoding: "utf8" },
    );
    if (r.status !== 0 || !fs.existsSync(file) || fs.statSync(file).size < 100) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return false;
    }
    return playFile(file);
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
    return playFile(file);
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

function ps(v) { return v.replace(/'/g, "''"); }

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
  if (speakEdge(text, { locale, rate, style })) return { engine: "edge", ok: true };
  if (await speakHeadTTS(text, { locale, rate, style })) return { engine: "headtts", ok: true };
  const ok = speakWindows(text, { rate: styleRate(style, rate), volume });
  return { engine: "windows", ok };
}

/**
 * Find ffmpeg binary. Checks Python's imageio-ffmpeg first, then PATH.
 */
function resolveFfmpeg() {
  // Try Python's bundled ffmpeg
  const python = resolvePython();
  if (python) {
    try {
      const r = spawnSync(python, ["-c", "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"], {
        stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
      });
      if (r.status === 0) {
        const p = (r.stdout || "").toString().trim();
        if (p && fs.existsSync(p)) return p;
      }
    } catch {}
  }
  // Try PATH
  for (const c of ["ffmpeg", "ffmpeg.exe"]) {
    try {
      const r = spawnSync(c, ["-version"], { stdio: "ignore", timeout: 5000 });
      if (r.status === 0) return c;
    } catch {}
  }
  return null;
}

/**
 * Generate TTS audio and return as a raw PCM buffer (mulaw 8kHz mono).
 * Used by the media channel to stream agent voice to the lead.
 * Returns { buffer, engine } or null on failure.
 */
async function speakToBuffer(text, { locale = "en", style = "human", rate = 1 } = {}) {
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) return null;

  const file = path.join(TMP, `tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp3`);
  try {
    const python = resolvePython();
    if (!python) return null;
    const voice = edgeVoiceFor(locale, style);
    const effRate = styleRate(style, rate);
    const rateArg = effRate === 1 ? "+0%" : `${effRate > 1 ? "+" : ""}${Math.round((effRate - 1) * 60)}%`;
    const r = spawnSync(
      python,
      ["-m", "edge_tts", "--voice", voice, "--rate", rateArg, "--text", text, "--write-media", file],
      { stdio: "pipe", timeout: 60000, encoding: "utf8" },
    );
    if (r.status !== 0 || !fs.existsSync(file) || fs.statSync(file).size < 100) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return null;
    }

    // Convert MP3 → raw mulaw 8kHz mono PCM
    const rawPath = file.replace(/\.mp3$/, ".raw");
    const conv = spawnSync(
      ffmpeg,
      ["-i", file, "-ar", "8000", "-ac", "1", "-f", "mulaw", "-y", rawPath],
      { stdio: "pipe", timeout: 15000 },
    );
    if (conv.status !== 0 || !fs.existsSync(rawPath)) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
      return null;
    }
    const buffer = fs.readFileSync(rawPath);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
    return { buffer, engine: "edge" };
  } catch {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return null;
  }
}

module.exports = { speak, speakEdge, speakHeadTTS, speakWindows, speakToBuffer, edgeVoiceFor, normalizeStyle, styleRate };
