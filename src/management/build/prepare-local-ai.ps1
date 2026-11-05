# Stages the llama.cpp server that runs the offline brain, and the whisper.cpp
# transcribers that let the same PC hear when the hosted transcriber is out of
# quota.
#
# Both archives are pinned by release tag AND by the SHA-256 of the published
# file, so a re-tagged or replaced asset cannot silently become the code we
# ship. Only the files each program actually loads are copied: the full archives
# are mostly other executables.
#
# The models are NOT staged here. They are downloaded once by the dashboard into
# the customer's data folder, pinned by size and SHA-256 in local-ai.js and
# local-stt.js, so an upgrade never costs another ~1.2 GB.
#
#   llama-server   0.9.0-dev (b12110)       ~26 MB   offline brain
#   whisper-cli    1.9.5 (b5454)            ~5 MB    offline hearing

$ErrorActionPreference = "Stop"

$llamaUrl = "https://github.com/ggml-org/llama.cpp/releases/download/b12110/llama-b12110-bin-win-cpu-x64.zip"
$llamaSha = "98901e327c252875accaf2d1bf364e10e868843b0b63468baad1aa945cdc5da2"
$whisperUrl = "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip"
$whisperSha = "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb"

# llama-server loads its implementation from -impl.dll, the llama/ggml DLLs and
# one CPU backend chosen at runtime. haswell covers every AVX2 machine (2013+),
# sse42 covers the older ones, x64 is the floor.
$needed = @(
  "llama-server.exe",
  "llama-server-impl.dll",
  "llama.dll",
  "llama-common.dll",
  "ggml.dll",
  "ggml-base.dll",
  "mtmd.dll",
  "libomp.dll",
  "ggml-cpu-haswell.dll",
  "ggml-cpu-sse42.dll",
  "ggml-cpu-x64.dll"
)

# whisper-cli is a separate program with its own ggml DLLs, built from a
# different llama.cpp commit than llama-server. It gets its own subfolder: the
# two archives ship different ggml.dll/ggml-base.dll builds, and putting them in
# one directory breaks whichever program is loaded second.
$whisperNeeded = @(
  "whisper-cli.exe",
  "whisper.dll",
  "ggml.dll",
  "ggml-base.dll",
  "ggml-cpu-haswell.dll",
  "ggml-cpu-sse42.dll",
  "ggml-cpu-x64.dll"
)

$root = $PSScriptRoot
$dest = Join-Path $root "dist\local-ai"
$cache = Join-Path $root "cache"
New-Item -ItemType Directory -Force -Path $cache, $dest | Out-Null

function Get-Pinned($url, $sha, $name) {
  $zip = Join-Path $cache $name
  $haveHash = ""
  if (Test-Path -LiteralPath $zip) {
    $haveHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
  }
  if ($haveHash -ne $sha) {
    Write-Host "Downloading pinned $name..."
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    $haveHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
  }
  if ($haveHash -ne $sha) { throw "$name checksum mismatch: $haveHash" }
  return $zip
}

$llamaZip = Get-Pinned $llamaUrl $llamaSha "llama-b12110-bin-win-cpu-x64.zip"
$tmp = Join-Path $cache "extract-b12110"
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $llamaZip -DestinationPath $tmp -Force

foreach ($name in $needed) {
  $from = Join-Path $tmp $name
  if (-not (Test-Path -LiteralPath $from)) { throw "llama.cpp archive is missing $name" }
  Copy-Item -LiteralPath $from -Destination (Join-Path $dest $name) -Force
}

# Native programs write their version banner to stderr, and PowerShell 5.1
# turns stderr into a terminating error while ErrorActionPreference is Stop.
# Run the --version probes with that temporarily relaxed, then restore it.
$server = Join-Path $dest "llama-server.exe"
$eap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $server --version 2>&1 | Out-Host
$serverExit = $LASTEXITCODE
$ErrorActionPreference = $eap
if ($serverExit -ne 0) { throw "llama-server.exe does not start (exit $serverExit)" }

$whisperZip = Get-Pinned $whisperUrl $whisperSha "whisper-bin-x64.zip"
$wtmp = Join-Path $cache "extract-b5454"
Remove-Item -LiteralPath $wtmp -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $whisperZip -DestinationPath $wtmp -Force

# The archive keeps everything under Release\, and the program keeps its own
# DLLs in its own folder so it can never overwrite llama-server's.
$wroot = Join-Path $wtmp "Release"
if (-not (Test-Path -LiteralPath $wroot)) { $wroot = $wtmp }
$wdest = Join-Path $dest "whisper"
New-Item -ItemType Directory -Force -Path $wdest | Out-Null
foreach ($name in $whisperNeeded) {
  $from = Join-Path $wroot $name
  if (-not (Test-Path -LiteralPath $from)) { throw "whisper.cpp archive is missing $name" }
  Copy-Item -LiteralPath $from -Destination (Join-Path $wdest $name) -Force
}

$whisper = Join-Path $wdest "whisper-cli.exe"
$eap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $whisper --version 2>&1 | Out-Host
$whisperExit = $LASTEXITCODE
$ErrorActionPreference = $eap
if ($whisperExit -ne 0) { throw "whisper-cli.exe does not start (exit $whisperExit)" }

$bytes = (Get-ChildItem -LiteralPath $dest -Recurse -File | Measure-Object -Property Length -Sum).Sum
if ($bytes -lt 25000000) { throw "offline runtime is unexpectedly small ($bytes bytes)" }
Write-Host ("Offline runtime staged: {0} MB in {1}" -f [math]::Round($bytes / 1MB, 1), $dest)
