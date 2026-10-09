const { spawnSync, spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { expressionFor } = require("./expression");

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
  // Was "fi-FI-SelmaNeural", which is not a real Edge voice - verified against the
  // live Microsoft list, where Finnish is only Harri (M) and Noora (F). An unknown
  // short name is not a wrong accent, it is a failed synthesis, so Finnish had
  // no voice at all. Fixed here and pinned by the voice-manifest test.
  fi: "fi-FI-NooraNeural",
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
  // Urdu had no entry at all, so edgeVoiceFor("ur") returned the English
  // default and the agent read Urdu text in an American accent - which is what
  // "the language failed" looked like on the 19:29Z call. ur-PK is the
  // Pakistani voice, which is what a Punjabi/Urdu speaker expects.
  ur: "ur-PK-UzmaNeural",
  "ur-pk": "ur-PK-UzmaNeural",
  "ur-in": "ur-IN-GulNeural",
  // Punjabi has NO Edge neural voice. Verified against the live Microsoft voice
  // list (322 voices, zero `pa-*` entries), so there is nothing correct to
  // point at. Punjabi is Indo-Aryan and hi-IN-SwaraNeural is the closest
  // available phonology; it renders Gurmukhi rather than going silent. Override
  // PUNJABI_VOICE once a real Punjabi voice is available - it is read on every
  // call, so no other file needs to change.
  pa: "hi-IN-SwaraNeural",
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
let PYTHON_PROMISE = null;

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
  // Probe asynchronously so a live call's media/VAD/heartbeats never freeze
  // while we look for Python. Concurrent callers share one probe.
  if (!PYTHON_PROMISE) {
    PYTHON_PROMISE = (async () => {
      for (const c of candidates) {
        try {
          const t = await runAsync(c, ["--version"], 10000);
          if (t.status === 0) { PYTHON = c; return c; }
        } catch { /* keep looking */ }
      }
      return null;
    })();
  }
  // Synchronous callers (legacy paths) get the cached value only; hot paths
  // must await resolvePythonAsync().
  return PYTHON;
}

async function resolvePythonAsync() {
  if (PYTHON_PROBED && PYTHON) return PYTHON;
  if (!PYTHON_PROMISE) { PYTHON_PROBED = false; return resolvePython() || await PYTHON_PROMISE; }
  return await PYTHON_PROMISE;
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
  const python = await resolvePythonAsync();
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
    const ok = await playFile(file);
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
    const played = await playFile(file);
    try { fs.unlinkSync(file); } catch {}
    return played;
  } catch {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return false;
  }
}

/* How long the HeadTTS request is allowed to take.
 *
 * HeadTTS is a local Kokoro server on 127.0.0.1:8883, reached over loopback. A
 * local neural render of one phone line is a few hundred milliseconds, and a
 * server that is not running refuses the connection immediately - so the only
 * situation this timeout actually governs is a server that accepted the socket
 * and then stopped answering.
 *
 * It was 240000ms, and that is a hazard rather than a safety net: this call sits
 * on the turn's critical path, so a wedged HeadTTS meant the prospect listened
 * to four minutes of dead air on a tier they would never hear from, on a machine
 * that is almost never going to use this tier at all. 3000ms is more than an
 * order of magnitude above a local render and keeps the whole fallback chain
 * inside a prospect's patience. A healthy local server is nowhere near it. */
const HEADTTS_TIMEOUT_MS = 3000;

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
    req.setTimeout(HEADTTS_TIMEOUT_MS, () => { req.destroy(); resolve(false); });
    req.write(data);
    req.end();
  });
}

function localeToHeadTTS(locale) { return String(locale).split("-")[0] === "fi" ? "fi" : "en-us"; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** Speak via Windows System.Speech (always available). Returns true. */
async function speakWindows(text, { rate = 1, volume = 100 } = {}) {
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
  const r = await runAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 60000);
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
async function playFile(file) {
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
    const r = await runAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      30000,
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
  const ok = await speakWindows(text, { rate: styleRate(style, rate), volume });
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
  return FFMPEG;
}

async function resolveFfmpegAsync() {
  if (FFMPEG_PROBED && FFMPEG) return FFMPEG;
  if (resolveFfmpegCachePromise) return await resolveFfmpegCachePromise;
  FFMPEG_PROBED = true;
  resolveFfmpegCachePromise = (async () => {
    const python = await resolvePythonAsync();
    if (python) {
      try {
        const r = await runAsync(python, ["-c", "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"], 5000);
        if (r.status === 0) {
          const p = (r.stdout || "").toString().trim();
          if (p && fs.existsSync(p)) { FFMPEG = p; return FFMPEG; }
        }
      } catch {}
    }
    for (const c of ["ffmpeg", "ffmpeg.exe"]) {
      try {
        const r = await runAsync(c, ["-version"], 5000);
        if (r.status === 0) { FFMPEG = c; return FFMPEG; }
      } catch {}
    }
    return null;
  })();
  return await resolveFfmpegCachePromise;
}
let resolveFfmpegCachePromise = null;

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

/** Box-average downsample when rate is an integer multiple of 8 kHz (16k→8k). */
function resampleTo8k(samples, rate) {
  if (rate === 8000) return samples;
  if (!rate || rate <= 0 || !samples.length) return null;
  if (rate % 8000 === 0 && rate > 8000) {
    const step = rate / 8000;
    const outLen = Math.max(1, Math.floor(samples.length / step));
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const start = i * step;
      let acc = 0;
      for (let j = 0; j < step; j++) acc += samples[start + j] || 0;
      out[i] = Math.max(-32768, Math.min(32767, Math.round(acc / step)));
    }
    return out;
  }
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

/* Edge Read-Aloud websocket: one continuous synthesis per utterance.
 * No Python, no ffmpeg, no multi-sentence chunk joins (chunk gaps sounded
 * like a breaking line). Falls through to the proven Python edge-tts path. */
const EDGE_WS_HOST = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const EDGE_WS_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_WS_GEC_VERSION = "1-143.0.3650.75";
const EDGE_WS_HEADERS = {
  Pragma: "no-cache",
  "Cache-Control": "no-cache",
  Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
};
const EDGE_WS_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const EDGE_WS_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function edgeWsDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${EDGE_WS_WEEKDAYS[d.getUTCDay()]} ${EDGE_WS_MONTHS[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

function edgeWsGec(nowS = Date.now() / 1000) {
  let ticks = nowS + 11644473600;
  ticks -= ticks % 300;
  ticks *= 1e9 / 100;
  return crypto.createHash("sha256").update(`${Math.floor(ticks)}${EDGE_WS_TOKEN}`, "ascii").digest("hex").toUpperCase();
}

/* ONE WARM EDGE SOCKET, REUSED ACROSS TURNS.
 *
 * WHERE THE TTS COST ACTUALLY IS. Measured against the live read-aloud endpoint,
 * five consecutive renders of short lines on a FRESH connection each:
 *
 *   handshake + websocket upgrade   600ms median
 *   first audio byte                193ms after the handshake
 *   synthesis to turn.end           390ms median
 *   mp3 -> PCMU decode               54ms median
 *
 * So roughly two thirds of a turn's TTS cost is the dial, not the synthesis,
 * and it was paid on every single turn because edgeWsSynth dialled a new
 * wss://speech.platform.bing.com for each one. That is also why TTS time is flat
 * against text length (10 chars 965ms, 65 chars 1065ms) - a bigger line just
 * streams longer on a connection that had already cost the same to open.
 *
 * REUSE WAS MEASURED, NOT ASSUMED. One connection, ten consecutive syntheses
 * 3-6s apart: every turn returned audio and readyState stayed OPEN throughout,
 * first audio byte 169-234ms, whole turn 324-501ms with no handshake at all.
 * The same socket survives a 30s idle gap. So the socket is pooled rather than
 * dialled per turn.
 *
 * WHY THE CREDENTIALS STAY VALID. Sec-MS-GEC (edgeWsGec) buckets the clock into
 * 300-second windows and hashes the bucket with the public client token; it is
 * the credential for the HTTP upgrade, and it is not re-presented per message.
 * A pooled connection opened before a window boundary therefore keeps working
 * after it, which is why the pool is allowed to outlive one bucket.
 *
 * WHY IT IS STILL BOUNDED. Every bound here is about never handing out a socket
 * that could be rejected mid-call, not about tidiness:
 *
 *   EDGE_WS_POOL_IDLE_MS   - unused for longer than this and the connection is
 *                            closed instead of pooled. Turns are seconds apart
 *                            inside a call, so it stays warm through a call and
 *                            dies between calls rather than sitting on a
 *                            possibly-stale credential all afternoon.
 *   EDGE_WS_POOL_MAX_AGE_MS - an absolute ceiling regardless of use.
 *   EDGE_WS_POOL_MAX       - at most this many idle connections are kept. A
 *                            process running two calls leases one each, so two
 *                            conversations can never share a connection and
 *                            interleave each other's audio frames.
 *
 * A synthesis that did not finish cleanly (error, timeout, unexpected close)
 * returns the socket to nobody: the protocol position is unknown, so it is
 * terminated and the next turn dials. That is also what keeps a dead connection
 * from being leased and failing the turn behind it.
 */
const EDGE_WS_POOL_MAX = 2;
const EDGE_WS_POOL_IDLE_MS = 90000;
const EDGE_WS_POOL_MAX_AGE_MS = 600000;
const EDGE_WS_CONNECT_TIMEOUT_MS = 4000;
const edgeWsPool = [];
const EDGE_WS_OPENED_AT = new WeakMap();

/** Drop any pooled connection that must not be handed to a synthesis. */
function edgeWsPrunePool() {
  const now = Date.now();
  for (let i = edgeWsPool.length - 1; i >= 0; i--) {
    const e = edgeWsPool[i];
    const openedAt = (e && EDGE_WS_OPENED_AT.get(e.ws)) || 0;
    const bad = !e || !e.ws || e.ws.readyState !== 1
      || now - e.idleSince >= EDGE_WS_POOL_IDLE_MS
      || (openedAt && now - openedAt >= EDGE_WS_POOL_MAX_AGE_MS);
    if (!bad) continue;
    edgeWsPool.splice(i, 1);
    try { if (e && e.ws) { if (typeof e.ws.terminate === "function") e.ws.terminate(); else e.ws.close(); } } catch { /* already gone */ }
  }
}

/** Take a warm connection, or null to dial a fresh one. */
function edgeWsLease() {
  edgeWsPrunePool();
  const entry = edgeWsPool.pop();
  return entry ? entry.ws : null;
}

/** Offer a cleanly-finished connection back for the next turn. */
function edgeWsRelease(ws) {
  if (!ws) return;
  try {
    edgeWsPrunePool();
    if (ws.readyState !== 1) return;
    if (edgeWsPool.length >= EDGE_WS_POOL_MAX) { ws.close(); return; }
    edgeWsPool.push({ ws, idleSince: Date.now() });
  } catch { /* a connection that cannot be parked is simply not pooled */ }
}

function edgeWsDial() {
  return new Promise((resolve) => {
    let WS;
    try { WS = require("ws"); } catch { resolve(null); return; }
    let ws;
    try {
      ws = new WS(
        `${EDGE_WS_HOST}?TrustedClientToken=${EDGE_WS_TOKEN}&ConnectionId=${crypto.randomUUID().replace(/-/g, "")}&Sec-MS-GEC=${edgeWsGec()}&Sec-MS-GEC-Version=${EDGE_WS_GEC_VERSION}`,
        { headers: { ...EDGE_WS_HEADERS, Cookie: `muid=${crypto.randomBytes(16).toString("hex").toUpperCase()};` }, perMessageDeflate: true },
      );
    } catch { resolve(null); return; }
    EDGE_WS_OPENED_AT.set(ws, Date.now());
    /* Registered once per connection, so a socket that dies while it is sitting
     * in the pool cannot be leased by the next turn. */
    ws.on("close", () => {
      const i = edgeWsPool.findIndex((e) => e && e.ws === ws);
      if (i >= 0) edgeWsPool.splice(i, 1);
    });
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => { try { ws.terminate(); } catch {} done(null); }, EDGE_WS_CONNECT_TIMEOUT_MS);
    ws.once("open", () => done(ws));
    ws.once("error", () => { try { ws.terminate(); } catch {} done(null); });
  });
}

function edgeWsClean(text) {
  return String(text || "")
    .split("").map((c) => {
      const code = c.charCodeAt(0);
      return (code <= 0x08 || (code >= 0x0B && code <= 0x0C) || (code >= 0x0E && code <= 0x1F)) ? " " : c;
    }).join("")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The SSML language tag that matches an Edge voice, e.g. "en-US-AvaNeural"
 *  -> "en-US". Was hardcoded to en-US, so every non-English turn was
 *  synthesised with an English language tag. */
function voiceLangFor(voice) {
  const v = String(voice || "");
  const m = v.match(/^([a-z]{2,3}(?:-[A-Za-z]{2,4})?)-[A-Za-z]+Neural/);
  return m ? m[1] : "";
}

/* One Edge WS synthesis of the FULL utterance -> MP3 or null.
 * Edge rejects riff-16khz/other raw formats with close 1007; only the
 * audio-* compressed formats (mp3) are accepted.
 *
 * The connection comes from the warm pool when there is one (see the pool notes
 * above) and is handed back only after a clean turn.end, so a connection that
 * errored, timed out or closed early is terminated rather than inherited by the
 * next turn. */
async function edgeWsSynth(text, voice, ratePct, opts = {}) {
  const ws = edgeWsLease() || (await edgeWsDial());
  if (!ws) return null;
  return await new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => finish(null, false), 6000);
    /* `reusable` is the whole safety argument for the pool: a turn that ended
     * cleanly on turn.end with audio leaves the connection at a known protocol
     * position, and anything else leaves it at an unknown one. */
    function finish(buf, reusable) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.off("message", onMessage); } catch {}
      if (reusable) edgeWsRelease(ws);
      else { try { if (typeof ws.terminate === "function") ws.terminate(); else ws.close(); } catch {} }
      resolve(buf);
    }
    const stamp = edgeWsDate();
    /* Expression: per-turn pitch and volume, and a style where the voice has
     * one. Every turn used to be pitch +0Hz / volume +0%, which is why the voice
     * sounded flat. Deltas are small and clamped on purpose. */
    const ex = expressionFor({ intent: opts.intent, text, style: opts.style, baseRatePct: ratePct });
    const rateArg = `${ex.ratePct > 0 ? "+" : ""}${ex.ratePct}%`;
    const pitchArg = `${ex.pitchHz > 0 ? "+" : ""}${ex.pitchHz}Hz`;
    const volArg = `${ex.volumePct > 0 ? "+" : ""}${ex.volumePct}%`;
    /* The language tag was hardcoded to en-US, so a French, Hindi or Urdu turn
     * was synthesised with an English language tag and mispronounced. It must
     * follow the voice. */
    const langTag = String(opts.lang || voiceLangFor(voice) || "en-US");
    /* Prosody only. mstts:express-as was tried and rejected: the styled-version
     * form Edge requires does not survive this websocket endpoint, and every
     * turn fell off the fast path onto the Python fallback - 11.7s instead of
     * ~1.3s. Pitch/rate/volume is the part that is reliably honoured, and it is
     * what actually reads as expression on the phone. */
    const styleAttr = "";
    const chunks = [];
    const sendTurn = () => ws.send(
      `X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`,
      (err) => {
        if (err) { finish(null, false); return; }
        ws.send(
          `X-RequestId:${crypto.randomUUID().replace(/-/g, "")}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp}Z\r\nPath:ssml\r\n\r\n` +
          `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${langTag}'>` +
          `<voice name='${voice}'${styleAttr}><prosody pitch='${pitchArg}' rate='${rateArg}' volume='${volArg}'>${edgeWsClean(text)}</prosody></voice></speak>`,
          (e2) => { if (e2) finish(null, false); },
        );
      },
    );
    const onMessage = (raw, isBinary) => {
      if (!isBinary) {
        if (String(raw).includes("turn.end")) finish(chunks.length ? Buffer.concat(chunks) : null, chunks.length > 0);
        return;
      }
      const buf = Buffer.from(raw);
      try {
        if (buf.length < 2) return;
        const hl = buf.readUInt16BE(0);
        const head = buf.toString("ascii", 2, 2 + hl);
        if (!head.includes("Path:audio")) return;
        /* Edge binary audio frame = uint16 headerLen | headerLen header bytes |
         * mp3 payload to end of message. No uint16 data-length field follows,
         * so skipping 2 more bytes ate the first 2 bytes of every 720B chunk
         * (5x144B MPEG2 frames) and destroyed MP3 frame alignment. */
        chunks.push(buf.subarray(2 + hl));
      } catch { finish(null, false); }
    };
    ws.on("message", onMessage);
    ws.once("error", () => finish(null, false));
    ws.once("close", () => { if (!done) finish(chunks.length ? Buffer.concat(chunks) : null, false); });
    /* A leased connection is already open, so its `open` event has been and gone.
     * A freshly dialled one may still be connecting, and edgeWsDial only resolves
     * once it is open - so by here it is open either way. */
    if (ws.readyState !== 1) { finish(null, false); return; }
    sendTurn();
  });
}

/**
 * Tier 1: Edge websocket → MP3 → WASM mpg123 decode → pure-JS PCMU as ONE
 * buffer. Edge only accepts compressed audio-* formats (raw/riff close 1007),
 * so the mp3 stream is decoded in-process (no Python, no ffmpeg) in ~1.8s.
 * Single continuous synthesis avoids the sentence-chunk seams that broke
 * the voice in 1.4.6, and skips the multi-second Python gap that sounded
 * like a dead line between turns.
 */
async function edgeWsToBuffer(text, { locale, style, rate, intent } = {}) {
  if (process.env.AUTODIAL_NO_EDGE_TTS === "1") return null;
  try {
    const body = String(text || "").trim();
    if (!body) return null;
    const voice = edgeVoiceFor(locale, style);
    const effRate = styleRate(style, rate);
    const ratePct = Math.round((effRate - 1) * 100);
    const mp3 = await edgeWsSynth(body, voice, ratePct, { intent, style, lang: locale });
    if (!mp3 || mp3.length < 100) return null;
    const { decodeMp3 } = require("../portal/audio");
    const pcm = await decodeMp3(mp3);
    if (!pcm || !pcm.length) return null;
    const mulaw = Buffer.allocUnsafe(pcm.length);
    for (let i = 0; i < pcm.length; i++) mulaw[i] = mulawEncode(pcm[i]);
    return mulaw.length >= 160 ? { buffer: mulaw, engine: "edge-ws" } : null;
  } catch {
    return null;
  }
}

/**
 * Tier 1b: edge-tts MP3 -> ffmpeg -> PCMU/8000 (fallback when WS is blocked).
 * Async spawn so the media WebSocket / VAD / heartbeats keep running while
 * the voice synthesizes.
 */
async function edgeToBuffer(text, { locale, style, rate }) {
  if (process.env.AUTODIAL_NO_EDGE_TTS === "1") return null;
  const ffmpeg = await resolveFfmpegAsync();
  if (!ffmpeg) return null;
  const python = await resolvePythonAsync();
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
    const conv = await runAsync(ffmpeg, ["-i", file, "-ar", "8000", "-ac", "1", "-af", "aresample=async=1:first_pts=0", "-f", "mulaw", "-y", rawPath], 15000);
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
async function sapiToBuffer(text, { rate = 1 } = {}) {
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
    const r = await runAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 30000);
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

/* ---------- rendered-audio cache ----------
 *
 * The agent says a small set of lines over and over, on every call: the opener,
 * "Sorry, I did not catch that", every re-ask, the refusals, the callback
 * sentence, the busy close. Voice output is deterministic for the same text,
 * voice and prosody, so those renders are worth keeping - and keeping them is
 * what takes TTS off those turns entirely, which matters because the cost of a
 * render is dominated by a fixed dial rather than by synthesis (see the socket
 * pool notes: 600ms handshake against 390ms synthesis on a fresh connection).
 *
 * WHAT IS IN THE KEY. Everything that changes the waveform, or a Turkish line
 * gets served in an English voice:
 *
 *   engine - each tier keeps its own namespace, so a Windows-Zira render recorded
 *            while Edge was blocked is never handed out in place of a neural one
 *            after Edge recovers
 *   text   - the exact string sent to the engine
 *   locale - selects the Edge voice AND the SSML language tag
 *   style  - selects the voice table (human/frank/friendly) and the pacing tweak
 *   rate   - the effective rate after the style tweak, which is the baseRatePct
 *            expressionFor() adds the intent movement to
 *   intent - the prosody movement (pitch/rate/volume). An explicit intent and an
 *            inferred one for the same text produce different prosody, so the raw
 *            intent is keyed alongside the text it was inferred from.
 *
 * WHAT IS NOT. The locale fallback: if a locale's voice cannot speak the script,
 * speakToBuffer retries the whole chain with "en", and that English render is
 * cached under "en". Caching it under the failed locale instead would pin the
 * fallback for the rest of the process even after the locale's voice came back.
 *
 * A tier that FAILS stores nothing, so the next tier runs exactly as before and
 * a failure is never remembered as a success. Nothing here can skip a tier that
 * would have produced better audio - a cache hit only replaces a synthesis that
 * would have returned those same bytes.
 */
const TTS_CACHE_MAX = 48;
/* One 20ms PCMU frame. Below this it is not speech, and it must never be stored
 * or served. */
const TTS_CACHE_MIN_BYTES = 160;
const ttsCache = new Map();

function ttsCacheKey(engine, body, locale, style, rate, intent) {
  return [
    engine,
    String(locale || "en").toLowerCase(),
    normalizeStyle(style),
    Number(styleRate(style, rate)).toFixed(4),
    String(intent || ""),
    body,
  ].join("\u0001");
}

/** Most-recently-used wins: re-inserting makes an entry the newest, so the first
 *  key Map yields is always the least recently used one to evict. */
function ttsCacheGet(key) {
  const hit = ttsCache.get(key);
  if (!hit) return null;
  ttsCache.delete(key);
  ttsCache.set(key, hit);
  return hit;
}

/** Store a private copy of a render that actually happened. Never stores a
 *  failure, never stores a non-Buffer, never stores a buffer too short to be
 *  speech. Returns the value the caller should use unchanged, so the first
 *  synthesis of a line behaves byte-for-byte as it did before the cache. */
function ttsCacheSet(key, value) {
  if (!value || !Buffer.isBuffer(value.buffer) || value.buffer.length < TTS_CACHE_MIN_BYTES) return value;
  ttsCache.set(key, { buffer: Buffer.from(value.buffer), engine: value.engine });
  while (ttsCache.size > TTS_CACHE_MAX) {
    const oldest = ttsCache.keys().next().value;
    if (oldest === undefined) break;
    ttsCache.delete(oldest);
  }
  return value;
}

/** A hit hands out a COPY, in the same { buffer, engine } shape every caller
 *  reads (.buffer for sendAudio, .engine for the log line). Copying a cached
 *  frame is a few microseconds against a synthesis that was over a second, and it
 *  means a caller that did write into the buffer it was given could not poison
 *  the entry for every later call. */
function ttsCacheResult(hit) {
  if (!hit || !Buffer.isBuffer(hit.buffer) || hit.buffer.length < TTS_CACHE_MIN_BYTES) return null;
  return { buffer: Buffer.from(hit.buffer), engine: hit.engine };
}

/** Test/diagnostic seam: drop every cached render. */
function ttsCacheClear() { ttsCache.clear(); }
function ttsCacheSize() { return ttsCache.size; }

/* The tier list, in order, with the engine name each one is cached under. Kept as
 * data so the cache and the fallback chain are driven from a single place and so
 * an offline test can count real synthesis calls (see _test below). */
const TTS_TIERS = [
  ["edge-ws", (body, o) => edgeWsToBuffer(body, o)],
  ["edge", (body, o) => edgeToBuffer(body, o)],
  ["headtts", (body, o) => headTtsToBuffer(body, o)],
  ["windows", (body, o) => sapiToBuffer(body, o)],
];
let ttsTiers = TTS_TIERS;

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
async function speakToBuffer(text, { locale = "en", style = "human", rate = 1, intent } = {}) {
  /* Trimmed once, here, because that is the string every tier is asked to speak
   * and therefore the string the cache is keyed on. The controller already
   * trims (local-call-controller.js: `String(text || "").trim()`), so this is
   * what it was sending anyway. */
  const body = String(text || "").trim();
  const chain = async (loc) => {
    if (!body) return null;
    /* Each tier is consulted under its OWN engine name, and only a render that
     * really happened is stored. So a tier that fails falls through to the next
     * one exactly as it does today, and its failure leaves nothing behind. */
    for (const [engine, run] of ttsTiers) {
      const key = ttsCacheKey(engine, body, loc, style, rate, intent);
      const hit = ttsCacheResult(ttsCacheGet(key));
      if (hit) return hit;
      const out = await run(body, { locale: loc, style, rate, intent });
      if (!out) continue;
      return ttsCacheSet(key, out);
    }
    return null;
  };
  const first = await chain(locale);
  if (first) return first;
  // A locale whose voice cannot speak this script yields nothing: measured on
  // the 20:25Z live call, Urdu script text returned null for locale=ur *and*
  // locale=en, and the controller then killed the call mid-conversation. Retry
  // the whole chain with the default voice so the phone still gets speech.
  if (locale && String(locale).toLowerCase() !== "en") {
    const fallback = await chain("en");
    if (fallback) return fallback;
  }
  return null;
}

module.exports = {
  speak, speakEdge, speakHeadTTS, speakWindows, speakToBuffer, edgeVoiceFor, normalizeStyle, styleRate,
  wavToMulaw, mulawEncode, edgeWsToBuffer, edgeWsSynth,
  ttsCacheKey, ttsCacheGet, ttsCacheSet, ttsCacheResult, ttsCacheClear, ttsCacheSize,
  TTS_CACHE_MAX, TTS_CACHE_MIN_BYTES, HEADTTS_TIMEOUT_MS,
  /* Offline tests need to know how many times a synthesis ACTUALLY ran, which is
   * only observable by replacing the tier list - there is no other injection
   * point into the fallback chain, and no production path sets this. */
  _test: {
    setTiers(list) { ttsTiers = list && list.length ? list : TTS_TIERS; },
    resetTiers() { ttsTiers = TTS_TIERS; },
    tiers() { return ttsTiers; },
  },
};
