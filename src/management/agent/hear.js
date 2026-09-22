const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * "Hearing" for the agent.
 *
 * Windows 11 fix: SAPI's DictationGrammar was removed on modern Windows and
 * returns null. We now capture audio to WAV via winmm (proven to work), then
 * transcribe offline using Vosk (small neural model, ~50MB, no API key).
 * Falls back to SAPI grammar if vosk is unavailable.
 */

// Words the agent listens for. One word per array entry (ASCII only —
// PowerShell 5.1 mangles non-ASCII here-strings).
const WORDS = [
  "yes", "yeah", "yep", "yup", "no", "nope", "nah", "maybe", "okay", "sure",
  "correct", "right", "wrong", "fine", "good", "great", "hello", "hi", "hey",
  "thanks", "thank you", "bye", "goodbye", "good morning", "good afternoon",
  "good evening", "mhm", "uh huh", "yes sir", "no sir", "sounds good",
  "that's fine", "start", "stop", "cancel", "repeat", "repeat that",
  "help", "hold on", "one second", "just a minute", "go ahead", "continue",
  "what", "what did you say", "I don't know", "i don't know", "not sure",
  "don't know", "unknown", "n a", "n/a", "not applicable", "none",
  "i don't have it", "i don't have that", "that's all", "that's it",
  "the number", "the mc", "the phone", "my name is", "it's", "it is",
  "name", "number", "mc", "mc number", "phone", "phone number", "customer",
  "dispatch", "trucking", "freight", "load", "truck", "driver", "carrier",
  "power only", "dry van", "refrigerated", "reefer", "flatbed", "step deck",
  "box truck", "straight truck", "semi", "trailer", "axel", "axle",
  "dallas", "houston", "el paso", "laredo", "chicago", "atlanta",
  "memphis", "nashville", "indianapolis", "kansas city", "oklahoma city",
  "denver", "phoenix", "los angeles", "sacramento", "portland", "seattle",
  "albany", "new york", "buffalo", "cleveland", "columbus", "cincinnati",
  "detroit", "grand rapids", "pittsburgh", "philadelphia", "boston",
  "today", "tomorrow", "yesterday", "monday", "tuesday", "wednesday",
  "thursday", "friday", "saturday", "sunday",
  "morning", "afternoon", "evening", "night", "tonight",
  "this week", "next week", "this month", "next month", "as soon as possible",
  "immediately", "urgent", "open", "available", "empty", "loaded", "pickup",
  "delivery", "origin", "destination", "where", "when", "what time",
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "oh", "ten", "twenty", "thirty", "forty", "fifty", "sixty",
  "seventy", "eighty", "ninety", "hundred", "thousand",
];

// Pairs of words the recognizer should hear together commonly.
const PHRASES = [
  "in dallas", "in houston", "in el paso", "in laredo", "in chicago",
  "from dallas", "from houston", "to dallas", "to houston", "to chicago",
  "twenty four", "twenty five", "twenty six", "twenty seven", "twenty eight",
  "twenty nine", "thirty one", "double zero", "double one", "zero one",
  "one two three", "four five six", "seven eight nine", "one eight hundred",
];

// Per-locale listening (ASCII-only: PowerShell 5.1 mangles non-ASCII
// here-strings, and the recognizer returns ASCII/transliterated text).
// `hear()` picks the engine culture (es-ES/fr-FR/de-DE/pt-BR/hi-IN) when a
// language pack is installed, else falls back to the English engine with the
// localized word list — best-effort but far better than English-only.
const WORDS_BY_LOCALE = {
  es: [
    "si", "no", "okay", "claro", "correcto", "bien", "bueno", "gracias", "hola",
    "oiga", "disculpe", "buenos dias", "muy bien", "de acuerdo", "no se",
    "no lo se", "no entiendo", "no me interesa", "no quiero", "no gracias",
    "estoy ocupado", "ocupado", "conduciendo", "manejando", "en la carretera",
    "ya tengo", "tengo", "mande", "diga", "un momento", "que", "como", "quien",
    "cuando", "donde", "cual", "a que hora", "espere", "repita", "mire",
    "nombre", "numero", "telefono", "celular", "mc", "camion", "camiones",
    "trailer", "carga", "flete", "fletes", "hoy", "manana", "ayer", "lunes",
    "martes", "miercoles", "jueves", "viernes", "sabado", "domingo",
    "esta semana", "proxima", "semana", "dia", "casa",
    "cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho",
    "nueve", "diez", "veinte", "treinta", "cuarenta", "cincuenta", "sesenta",
    "setenta", "ochenta", "noventa", "cien",
  ],
  fr: [
    "oui", "non", "okay", "bonjour", "bonsoir", "merci", "d'accord", "heuresement",
    "je ne sais pas", "je ne comprends pas", "pas interesse", "je ne veux pas",
    "je suis occupe", "occupe", "je conduis", "sur la route", "j'ai deja", "deja",
    "mon transitaire", "un moment", "repetez", "comment", "pourquoi", "quand",
    "ou", "qui", "quel", "a quelle heure", "attendez", "ecoutez", "nom",
    "numero", "telephone", "portable", "mc", "camion", "remorque", "fret",
    "chargement", "aujourd'hui", "demain", "hier", "lundi", "mardi",
    "mercredi", "jeudi", "vendredi", "samedi", "dimanche", "la semaine prochaine",
    "cette semaine", "jour", "tres bien", "c'est bon",
    "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf",
    "zero", "dix", "vingt", "trente", "quarante", "cinquante", "soixante",
    "quatre vingt", "cent",
  ],
  de: [
    "ja", "nein", "okay", "hallo", "guten tag", "danke", "sehr gut",
    "einverstanden", "ich weiss nicht", "ich verstehe nicht", "nicht interessiert",
    "ich will nicht", "ich bin beschaeftigt", "beschaeftigt", "unterwegs",
    "auf der strasse", "ich habe schon", "einen moment", "wie", "warum",
    "wann", "wo", "wer", "welche", "um wie viel uhr", "warten sie",
    "wiederholen", "name", "nummer", "telefon", "handy", "mc", "lkw",
    "lastwagen", "anhaenger", "fracht", "ladung", "transport", "heute",
    "morgen", "gestern", "montag", "dienstag", "mittwoch", "donnerstag",
    "freitag", "samstag", "sonntag", "naechste woche", "diese woche", "woche", "tag",
    "eins", "zwei", "drei", "vier", "fuenf", "sechs", "sieben", "acht", "neun",
    "null", "zehn", "zwanzig", "dreissig", "vierzig", "fuenfzig", "sechzig",
    "siebzig", "achtzig", "neunzig", "hundert",
  ],
  pt: [
    "sim", "nao", "okay", "claro", "certo", "bom", "bem", "obrigado", "ola",
    "bom dia", "muito bem", "de acordo", "nao sei", "nao entendo", "nao quero",
    "nao estou interessado", "nao obrigado", "estou ocupado", "ocupado",
    "dirigindo", "na estrada", "ja tenho", "um momento", "o que", "como",
    "quando", "onde", "quem", "qual", "a que horas", "espere", "repita",
    "nome", "numero", "telefone", "celular", "mc", "caminhao", "reboque",
    "carga", "fretes", "hoje", "amanha", "ontem", "segunda", "terca", "quarta",
    "quinta", "sexta", "sabado", "domingo", "proxima semana", "esta semana", "dia",
    "um", "dois", "tres", "quatro", "cinco", "seis", "sete", "oito", "nove",
    "zero", "dez", "vinte", "trinta", "quarenta", "cinquenta", "sessenta",
    "setenta", "oitenta", "noventa", "cem",
  ],
  hi: [
    "haan", "nahin", "ji", "theek hai", "okay", "achha", "namaste",
    "dhanyavaad", "shukriya", "main samajha nahin", "mujhe nahin chahiye",
    "mujhe nahin", "main chala raha hoon", "busy hoon", "mera nam", "mera number",
    "phone number", "mc", "truck", "gaadi", "mal", "load", "aaj", "kal",
    "parson", "hafata", "agla hafta", "ek minute", "intazaar karo",
    "repete karo", "kya", "kaise", "kab", "kahan", "kaun", "bilkul",
    "ek", "do", "teen", "char", "paanch", "chhe", "saat", "aath", "nau",
    "shunya", "das", "bees", "tees", "chaalees", "pachaas", "saath",
    "sattar", "assi", "nabbey", "sau",
  ],
};

const PHRASES_BY_LOCALE = {
  es: ["buenos dias", "no me interesa", "no lo se", "un momento", "esta semana"],
  fr: ["bonjour monsieur", "pas interesse", "un moment", "cette semaine"],
  de: ["guten tag", "einen moment", "naechste woche"],
  pt: ["bom dia", "nao estou interessado", "um momento", "proxima semana"],
  hi: ["theek hai", "mujhe nahin chahiye", "ek minute"],
};

/**
 * Return a PS script that enumerates waveIn devices by name, picks the first
 * whose name matches /internal|built-in/i (or first "microphone" / any),
 * captures `sec` seconds to a temp WAV, and transcribes it with SAPI's
 * Grammar engine (no device-enum dependency).
 *
 * Output lines:
 *   CAPTURED:<path>
 *   RMS:<value>
 *   HEARD:<text>   (or HEARD: for silence, ERR: on failure)
 */
function captureTranscribeScript({ sec, locale = "en" }) {
  const wordsRaw = (WORDS_BY_LOCALE[locale] || WORDS).join(";");
  const phrasesRaw = (PHRASES_BY_LOCALE[locale] || PHRASES).join(";");
  const cultureLine =
    locale === "en"
      ? ""
      : `      $cult = '${CULTURE[locale] || "en-US"}'
      $info = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Culture.Name -eq $cult } | Select-Object -First 1
`;
  const engineLine = locale === "en"
    ? `      $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine`
    : `      if ($info) { $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info) } else { $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine }`;

  return `
Add-Type -AssemblyName System.Speech
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Hm {
  [DllImport("winmm.dll")] public static extern uint waveInGetNumDevs();
  [DllImport("winmm.dll", CharSet=CharSet.Ansi, EntryPoint="waveInGetDevCaps")]
    public static extern uint waveInGetDevCaps(uint uDeviceID, IntPtr lpCaps, uint cbCaps);
  [DllImport("winmm.dll")] public static extern uint waveInOpen(out IntPtr h, uint devId, ref HmFmt fmt, IntPtr cb, IntPtr ctx, uint flags);
  [DllImport("winmm.dll")] public static extern uint waveInPrepareHeader(IntPtr h, IntPtr hdr, uint size);
  [DllImport("winmm.dll")] public static extern uint waveInAddBuffer(IntPtr h, IntPtr hdr, uint size);
  [DllImport("winmm.dll")] public static extern uint waveInStart(IntPtr h);
  [DllImport("winmm.dll")] public static extern uint waveInStop(IntPtr h);
  [DllImport("winmm.dll")] public static extern uint waveInClose(IntPtr h);
}
[StructLayout(LayoutKind.Sequential)] public struct HmFmt {
  public ushort wFormatTag; public ushort nChannels; public uint nSamplesPerSec;
  public uint nAvgBytesPerSec; public ushort nBlockAlign; public ushort wBitsPerSample; public ushort cbSize;
}
[StructLayout(LayoutKind.Sequential)] public struct HmHdr {
  public IntPtr lpData; public uint dwBufferLength; public uint dwBytesRecorded;
  public IntPtr dwUser; public uint dwFlags; public uint dwLoops; public IntPtr lpNext; public IntPtr reserved;
}
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)] public struct HmCaps {
  public ushort wMid; public ushort wPid; public uint vDriverVersion;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string szPname;
  public uint dwFormats; public ushort wChannels; public ushort wReserved1;
}
"@

$SR = 16000; $CH = 1; $BPS = 16; $SEC = ${sec}
$nbuf = $SR * $CH * ($BPS/8) * $SEC
$fmt = New-Object HmFmt
$fmt.wFormatTag=1; $fmt.nChannels=$CH; $fmt.nSamplesPerSec=$SR; $fmt.wBitsPerSample=$BPS
$fmt.nBlockAlign=($CH*$BPS/8); $fmt.nAvgBytesPerSec=($SR*$fmt.nBlockAlign); $fmt.cbSize=0

# --- pick the best physical mic (internal preferred) ---
$n = [Hm]::waveInGetNumDevs()
$nameMap = @()
for ($i = 0; $i -lt $n; $i++) {
  $sz = [Runtime.InteropServices.Marshal]::SizeOf([type][HmCaps])
  $p  = [Runtime.InteropServices.Marshal]::AllocHGlobal($sz)
  [void][Hm]::waveInGetDevCaps($i, $p, [uint32]$sz)
  $caps = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][HmCaps])
  [Runtime.InteropServices.Marshal]::FreeHGlobal($p)
  $nameMap += @{ idx = $i; name = $caps.szPname }
  Write-Output ("DEV$($i): $($caps.szPname)")
}
$pick = -1
foreach ($m in $nameMap) {
  if ($m.name -match '(?i)(external|headset|headphone)') { $pick = $m.idx; break }
}
if ($pick -lt 0) { foreach ($m in $nameMap) { if ($m.name -match '(?i)(usb|aux|headset|headphone)') { $pick = $m.idx; break } } }
if ($pick -lt 0) { foreach ($m in $nameMap) { if ($m.name -match '(?i)mic') { $pick = $m.idx; break } } }
if ($pick -lt 0 -and $n -gt 0) { $pick = $n - 1 }
Write-Output ("PICK: device $pick")

# --- capture audio from chosen device ---
function Capture([uint32]$devIdx) {
  $h = [IntPtr]::Zero
  $rOpen = [Hm]::waveInOpen([ref]$h, [uint32]$devIdx, [ref]$fmt, [IntPtr]::Zero, [IntPtr]::Zero, 0)
  if ($rOpen -ne 0) { Write-Output ("CAPTURE_ERR:$rOpen"); return @{ rms=0; peak=0; path=""; dev=$devIdx } }
  $data = New-Object byte[] $nbuf
  $dataPtr = [Runtime.InteropServices.Marshal]::AllocHGlobal($nbuf)
  $hdr = New-Object HmHdr; $hdr.lpData=$dataPtr; $hdr.dwBufferLength=$nbuf; $hdr.dwBytesRecorded=0
  $hdrSz = [Runtime.InteropServices.Marshal]::SizeOf([type][HmHdr])
  $hdrPtr = [Runtime.InteropServices.Marshal]::AllocHGlobal($hdrSz)
  [Runtime.InteropServices.Marshal]::StructureToPtr($hdr,$hdrPtr,$false)
  $p = [Hm]::waveInPrepareHeader($h,$hdrPtr,$hdrSz)
  $a = [Hm]::waveInAddBuffer($h,$hdrPtr,$hdrSz)
  $s = [Hm]::waveInStart($h)
  Start-Sleep -Milliseconds (($SEC*1000)+600)
  [Hm]::waveInStop($h)
  $got = [Runtime.InteropServices.Marshal]::PtrToStructure($hdrPtr,[type][HmHdr])
  $bytes = [int]$got.dwBytesRecorded
  $sum=[long]0; $peak=0; $wav=$null
  if ($bytes -gt 16) {
    $cap = New-Object byte[] $bytes
    [Runtime.InteropServices.Marshal]::Copy($got.lpData,$cap,0,$bytes)
    for ($i=0;$i -lt $bytes;$i+=2){
      $v=[BitConverter]::ToInt16($cap,$i); $ab=[Math]::Abs($v); if($ab -gt $peak){$peak=$ab}; $sum+=[long]$v*$v
    }
    $wav = Join-Path $env:TEMP ("md-hear-" + $PID + ".wav")
    $fs=New-Object System.IO.FileStream($wav,[System.IO.FileMode]::Create)
    $bw=New-Object System.IO.BinaryWriter($fs)
    $bw.Write([Text.Encoding]::ASCII.GetBytes("RIFF"))
    $bw.Write([int](36+$bytes)); $bw.Write([Text.Encoding]::ASCII.GetBytes("WAVEfmt "))
    $bw.Write([int]16); $bw.Write([int16]1); $bw.Write([int16]$CH); $bw.Write([int]$SR)
    $bw.Write([int]($SR*$CH*($BPS/8))); $bw.Write([int16]($CH*$BPS/8)); $bw.Write([int16]$BPS)
    $bw.Write([Text.Encoding]::ASCII.GetBytes("data")); $bw.Write([int]$bytes); $bw.Write($cap)
    $bw.Close(); $fs.Close()
  }
  [Hm]::waveInClose($h)
  [Runtime.InteropServices.Marshal]::FreeHGlobal($dataPtr)
  [Runtime.InteropServices.Marshal]::FreeHGlobal($hdrPtr)
  $rms = if($bytes -gt 16){ [Math]::Sqrt($sum/($bytes/2)) } else { 0 }
  return @{ rms=$rms; peak=$peak; path=$wav; dev=$devIdx }
}

  $r1 = Capture $pick
Write-Output ("RMS:" + [Math]::Round($r1.rms,1) + " peak:" + $r1.peak + " bytes:" + $nbuf)
if ($r1.path) { Write-Output ("WAVPATH:" + $r1.path) }

# --- transcribe the WAV via SAPI (SetInputToWaveFile avoids device routing) ---
try {
  ${cultureLine}
  ${engineLine}
  $r.SetInputToWaveFile($r1.path)
  $r.InitialSilenceTimeout = New-Object System.TimeSpan(0,0,10)
  $r.EndSilenceTimeout     = New-Object System.TimeSpan(0,0,2)
  $rawWords = "${wordsRaw}"
  $rawPhrases = "${phrasesRaw}"
  $wordList = $rawWords -split ";"
  $phraseList = $rawPhrases -split ";"
  $allItems = $wordList + $phraseList
  if ($allItems.Count -gt 0) {
    $choices = New-Object System.Speech.Recognition.Choices($allItems)
    $gb = New-Object System.Speech.Recognition.GrammarBuilder
    $gb.Append($choices)
    $gr = New-Object System.Speech.Recognition.Grammar($gb)
    $r.LoadGrammar($gr)
  }
  $dg = New-Object System.Speech.Recognition.DictationGrammar
  $r.LoadGrammar($dg)
  $res = $r.Recognize()
  if ($res -and $res.Confidence -ge 0.05) { Write-Output ("HEARD:" + $res.Text) } else { Write-Output "HEARD:" }
} catch {
  Write-Output ("ERR:" + $_.Exception.Message)
}
  `;
}

const CULTURE = { es: "es-ES", fr: "fr-FR", de: "de-DE", pt: "pt-BR", hi: "hi-IN" };

// --- Vosk offline speech recognition (replaces broken SAPI DictationGrammar) ---

let PYTHON = null;
function resolvePython() {
  if (PYTHON) return PYTHON;
  const home = os.homedir();
  const candidates = [
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

const VOSK_SCRIPT = path.join(__dirname, "vosk-transcribe.py");
const HEAR_PY_SCRIPT = path.join(__dirname, "hear-py.py");
let voskAvailable = null;
function isVoskAvailable() {
  if (voskAvailable !== null) return voskAvailable;
  const py = resolvePython();
  if (!py) { voskAvailable = false; return false; }
  const r = spawnSync(py, ["-c", "import vosk; print('ok')"], { stdio: "ignore", timeout: 10000 });
  voskAvailable = r.status === 0;
  return voskAvailable;
}

/** Transcribe a WAV file using Vosk. Returns recognized text or null. */
function transcribeWithVosk(wavPath) {
  const py = resolvePython();
  if (!py || !fs.existsSync(VOSK_SCRIPT)) return null;
  try {
    const r = spawnSync(py, [VOSK_SCRIPT, wavPath], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    });
    const out = (r.stdout || "").toString().trim();
    const m = out.match(/"text"\s*:\s*"([^"]*)"/);
    if (m) return m[1].trim() || null;
    return null;
  } catch { return null; }
}

/**
 * Listen for speech for up to `timeoutMs`. Returns recognized text (trimmed)
 * or null if nothing matched / recognition unavailable.
 *
 * For tests: pass `waveFile` (a .wav path) to transcribe a file directly.
 */
function hear({ timeoutMs = 6000, waveFile = null, locale = "en" } = {}) {
  const sec = Math.max(1, Math.round(timeoutMs / 1000));

  if (waveFile) {
    // Transcribe a pre-recorded WAV through SAPI's grammar (no mic needed).
    const wordsRaw = (WORDS_BY_LOCALE[locale] || WORDS).join(";");
    const phrasesRaw = (PHRASES_BY_LOCALE[locale] || PHRASES).join(";");
    const cultureLine =
      locale === "en"
        ? ""
        : `      $cult = '${CULTURE[locale] || "en-US"}'
      $info = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Culture.Name -eq $cult } | Select-Object -First 1
`;
    const engineLine = locale === "en"
      ? `      $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine`
      : `      if ($info) { $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info) } else { $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine }`;
    const safeWaveFile = String(waveFile || "").replace(/'/g, "''").replace(/\\/g, "\\\\");
    const script = `
    Add-Type -AssemblyName System.Speech
    try {
      ${cultureLine}
      ${engineLine}
      $r.SetInputToWaveFile('${safeWaveFile}')
      $r.InitialSilenceTimeout = New-Object System.TimeSpan(0,0,${sec})
      $r.EndSilenceTimeout     = New-Object System.TimeSpan(0,0,2)
      $dg = New-Object System.Speech.Recognition.DictationGrammar
      $r.LoadGrammar($dg)
      $res = $r.Recognize()
      if ($res -and $res.Confidence -ge 0.1) { Write-Output ('HEARD:' + $res.Text) } else { Write-Output 'HEARD:' }
    } catch {
      Write-Output ('ERR:' + $_.Exception.Message)
    }
    `;
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs + 20000,
    });
    const out = (r.stdout || "").toString().trim();
    const line = out.split(/\r?\n/).find((l) => /^(HEARD|ERR):/.test(l));
    if (!line) return null;
    if (line.startsWith("ERR:")) return null;
    const text = line.slice("HEARD:".length).trim();
    return text === "" ? null : text;
  }

  // Live mic: capture + vosk transcription in one Python call.
  try {
    const py = resolvePython();
    if (py && fs.existsSync(HEAR_PY_SCRIPT)) {
      const r = spawnSync(py, [HEAR_PY_SCRIPT, String(sec), "10"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs + 15000,
      });
      const out = (r.stdout || "").toString().trim();
      const m = out.match(/"text"\s*:\s*"([^"]*)"/);
      const rmsM = out.match(/"raw_rms"\s*:\s*([0-9.]+)/);
      const rawRms = rmsM ? parseFloat(rmsM[1]) : 0;
      if (rawRms > 0) console.error("[hear] raw_rms=" + rawRms);
      if (m && m[1].trim()) return m[1].trim();
    }
  } catch (e) { console.error("[hear] exception:", e.message); }

  // Fallback: PowerShell capture + SAPI grammar
  const script = captureTranscribeScript({ sec, locale });
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs + 20000 },
  );
  const out = (r.stdout || "").toString().trim();
  const heard = out.split(/\r?\n/).find((l) => l.startsWith("HEARD:"));
  if (heard) {
    const text = heard.slice("HEARD:".length).trim();
    if (text) return text;
  }
  return null;
}

/** Diagnostic helper: capture `sec` seconds, report signal strength + what
 *  SAPI transcribed. Returns { rms, peak, text, raw }. */
function probeMic({ sec = 8, locale = "en" } = {}) {
  const script = captureTranscribeScript({ sec, locale });
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { stdio: ["ignore", "pipe", "pipe"], timeout: sec * 1000 + 25000 },
  );
  const out = (r.stdout || "").toString();
  const rms = Number((out.match(/^RMS:([0-9.]+)/m) || [])[1]) || 0;
  const peak = Number((out.match(/peak:([0-9.]+)/m) || [])[1]) || 0;
  const heard = (out.match(/^HEARD:(.*)$/m) || [])[1];
  return { rms, peak, text: heard && heard.trim() ? heard.trim() : null, raw: out };
}

/**
 * Decode mu-law byte to 16-bit PCM sample.
 */
function mulawDecode(mulaw) {
  mulaw = ~mulaw & 0xff;
  const sign = (mulaw & 0x80) ? -1 : 1;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0f;
  const sample = ((mantissa << 1) + 33) << (exponent + 2);
  return sign * (sample - 132);
}

/**
 * Transcribe a raw audio buffer (mulaw 8kHz mono) from the media channel.
 * Decodes mulaw → PCM, upsamples to 16kHz, saves WAV, transcribes with vosk.
 * Returns recognized text or null.
 */
function hearFromBuffer(audioBuffer, { sampleRate = 8000 } = {}) {
  if (!audioBuffer || audioBuffer.length < 100) return null;

  // Decode mulaw → linear PCM
  const pcm = new Int16Array(audioBuffer.length);
  for (let i = 0; i < audioBuffer.length; i++) {
    pcm[i] = mulawDecode(audioBuffer[i]);
  }

  // Upsample 8kHz → 16kHz (simple linear interpolation)
  const upsampled = new Int16Array(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    upsampled[i * 2] = pcm[i];
    if (i + 1 < pcm.length) {
      upsampled[i * 2 + 1] = (pcm[i] + pcm[i + 1]) >> 1;
    } else {
      upsampled[i * 2 + 1] = pcm[i];
    }
  }

  const outRate = 16000;
  const bytes = Buffer.from(upsampled.buffer);

  // Write WAV header (PCM format, 16kHz mono 16-bit)
  const header = Buffer.alloc(44);
  const dataSize = bytes.length;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);           // PCM format
  header.writeUInt16LE(1, 22);           // mono
  header.writeUInt32LE(outRate, 24);     // 16kHz
  header.writeUInt32LE(outRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);           // block align
  header.writeUInt16LE(16, 34);          // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  const tmpWav = path.join(os.tmpdir(), `media-hear-${Date.now()}.wav`);
  try {
    fs.writeFileSync(tmpWav, Buffer.concat([header, bytes]));
  } catch { return null; }

  // Transcribe via Python vosk
  try {
    const py = resolvePython();
    if (py && fs.existsSync(VOSK_SCRIPT)) {
      const r = spawnSync(py, [VOSK_SCRIPT, tmpWav], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000,
      });
      const out = (r.stdout || "").toString().trim();
      const m = out.match(/"text"\s*:\s*"([^"]*)"/);
      if (m && m[1].trim()) return m[1].trim();
    }
  } catch {}
  finally {
    try { fs.unlinkSync(tmpWav); } catch {}
  }
  return null;
}

module.exports = { hear, probeMic, hearFromBuffer, mulawDecode, WORDS, PHRASES, WORDS_BY_LOCALE, PHRASES_BY_LOCALE };