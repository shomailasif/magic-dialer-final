# Start the vendor admin console on this PC, hidden, and print its URL.
#
# The console refuses to run without licenses\license.private.key, so this
# shortcut is inert on a customer PC. It is also what the logon task runs, so
# the console comes back by itself after a restart.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-admin.ps1
#   powershell ... -File scripts\start-admin.ps1 -Open

param([switch]$Open)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$urlFile = Join-Path $root "licenses\admin-url.txt"
$logFile = Join-Path $root "licenses\admin.log"
$errFile = Join-Path $root "licenses\admin-err.log"

function Show-Url([string]$url) {
  Write-Output ""
  Write-Output "MAGIC DIALER - ADMIN CONSOLE (this PC only)"
  Write-Output ("-" * 70)
  Write-Output "  $url"
  Write-Output ""
  Write-Output "  The token is new every run. Close the console with: Stop-Process -Name node"
  Write-Output "  (or Ctrl+C when it was started in a window)."
  Write-Output ""
  if ($Open) { Start-Process $url | Out-Null }
}

function Get-RunningUrl {
  if (-not (Test-Path $urlFile)) { return $null }
  $url = (Get-Content $urlFile -Raw -ErrorAction SilentlyContinue).Trim()
  if (-not $url) { return $null }
  try {
    $null = Invoke-WebRequest $url -TimeoutSec 3 -UseBasicParsing
    return $url
  } catch {
    return $null
  }
}

$running = Get-RunningUrl
if ($running) { Show-Url $running; exit 0 }

# The port may be taken by a console whose URL file was lost (for example a
# profile restore). Starting a second one would fail, so say so plainly.
$listening = Get-NetTCPConnection -LocalPort 48772 -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Write-Output "The admin console is already listening on 127.0.0.1:48772 but its URL file is missing."
  Write-Output "Stop that process and run this script again: Stop-Process -Id $($listening[0].OwningProcess)"
  exit 1
}

New-Item -ItemType Directory -Force -Path (Join-Path $root "licenses") | Out-Null
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }

Start-Process -FilePath $node `
  -ArgumentList "scripts\admin-server.cjs" `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $logFile `
  -RedirectStandardError $errFile | Out-Null

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  $url = Get-RunningUrl
  if ($url) { Show-Url $url; exit 0 }
}

Write-Output "ADMIN CONSOLE DID NOT START"
Write-Output "  signing key present: $(Test-Path (Join-Path $root 'licenses\license.private.key'))"
if (Test-Path $errFile) { Get-Content $errFile -Tail 10 | ForEach-Object { "  $_" } }
exit 1
