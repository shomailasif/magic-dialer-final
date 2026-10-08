# Prospect audio fixtures for src/management/build/audio-sim.js.
#
# WHY this exists
# ---------------
# The audio harness has to put REAL speech through the real VAD and the real
# recognizer, because the defects being reproduced (truncated prospect turns,
# a repeated opener) only exist in the audio path - a text simulator cannot
# produce them. Windows SAPI ("Microsoft David Desktop" / "Microsoft Zira
# Desktop") is the only synthesizer guaranteed to exist on every machine that
# runs the customer agent, so the fixtures are generated from it and written as
# 16 kHz mono 16-bit PCM WAV, which is exactly what the harness parses.
#
# The .wav files are NOT committed - they are ~40 KB of binary per line and they
# are reproducible byte-for-byte-ish from this script. The harness generates any
# missing fixture on demand, so a clean checkout can run:
#
#     powershell -ExecutionPolicy Bypass -File src\management\build\fixtures\make-fixtures.ps1
#
# -Force rewrites fixtures that already exist.

param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

Add-Type -AssemblyName System.Speech

# id => the words the prospect says. One file per scripted line.
$lines = [ordered]@{
  "hello"      = "Hello?"
  "who-is-it"  = "Who is it?"
  "what-need"  = "What do you need?"
  "yes-go"     = "Yes, go ahead."
  "all-done"   = "That is all, thanks."
  "on-the-go"  = "Hold on, I am driving right now."
  "mcn"        = "My MC number is 623400."
  "too-busy"   = "I am a bit busy right now, can I call you back later?"
}

# David for most lines (a male voice reading a male trucker), Zira where a
# different timbre helps the harness tell two turns apart.
$voices = [ordered]@{
  "hello"      = "Microsoft David Desktop"
  "who-is-it"  = "Microsoft David Desktop"
  "what-need"  = "Microsoft David Desktop"
  "yes-go"     = "Microsoft David Desktop"
  "all-done"   = "Microsoft Zira Desktop"
  "on-the-go"  = "Microsoft Zira Desktop"
  "mcn"        = "Microsoft David Desktop"
  "too-busy"   = "Microsoft Zira Desktop"
}

# 16 kHz / 16-bit / mono is what the harness resamples to telephone PCMU.
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono
)

$made = 0
foreach ($id in $lines.Keys) {
  $out = Join-Path $here "$id.wav"
  if ((Test-Path -LiteralPath $out) -and -not $Force) {
    Write-Host "  skip  $id.wav (exists; -Force to rewrite)"
    continue
  }
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $wanted = $voices[$id]
  $chosen = $null
  foreach ($v in $synth.GetInstalledVoices()) {
    if ($v.VoiceInfo.Name -eq $wanted) { $chosen = $v.VoiceInfo.Name; break }
  }
  if (-not $chosen) { $chosen = $synth.GetInstalledVoices()[0].VoiceInfo.Name }
  $synth.SelectVoice($chosen)
  $synth.Rate = 0
  $synth.Volume = 100
  $path = $out.Replace("\", "/").Replace("'", "''")
  $synth.SetOutputToWaveFile($path, $format)
  $synth.Speak($lines[$id])
  $synth.SetOutputToNull()
  $synth.Dispose()
  $made++
  Write-Host ("  wrote {0,-12} {1,7} bytes  voice={2}  text={3}" -f "$id.wav", (Get-Item -LiteralPath $out).Length, $chosen, $lines[$id])
}

Write-Host ""
Write-Host "fixtures: $made written, $($lines.Count - $made) already present in $here"