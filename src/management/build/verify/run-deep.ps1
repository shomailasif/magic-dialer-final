# run-deep.ps1 - deterministic corporate deep-verify for the packaged
# customer build. Starts a REAL local mock portal (node), boots the REAL
# packaged engine (agent.exe) with a sample token, waits for status.json to
# go ONLINE, hits the real dashboard HTTP endpoint, then proves the PS-free
# watchdog-broker respawn path. Prints one Check per requirement: PASS/FAIL.
param(
  [string]$Build = ""
)
$ErrorActionPreference = "Stop"

if (-not $Build) { $Build = "C:\Users\USER\Documents\Default Project\autodial-ai\src\management\build" }
$nodeExe = "C:\Program Files\nodejs\node.exe"
$engine = Join-Path $Build "dist\agent.exe"
$launcher = Join-Path $Build "dist\MagicDialer.exe"
$setup = Join-Path $Build "dist\MagicDialer-Setup.exe"

$Failed = New-Object System.Collections.ArrayList
function Check($name, $ok, $detail = "") {
  if (-not $ok) { $script:Failed += $name }
  $tag = if ($ok) { "PASS" } else { "FAIL" }
  Write-Host ("[" + $tag + "] " + $name + "  (" + $detail + ")")
}

# 1. artifacts exist + sizes
Check "dist\agent.exe (engine) exists" (Test-Path -LiteralPath $engine) ("{0:N0} B" -f (Get-Item $engine).Length)
Check "dist\MagicDialer.exe (launcher) exists" (Test-Path -LiteralPath $launcher) ("{0:N0} B" -f (Get-Item $launcher).Length)
Check "dist\MagicDialer-Setup.exe (installer) exists" (Test-Path -LiteralPath $setup) ("{0:N0} B" -f (Get-Item $setup).Length)

# 2. PE subsystem of launcher (2 = GUI, no console) and engine (3 = console, hidden)
function Get-Subsystem([string]$f) {
  $fs = [IO.File]::OpenRead($f)
  try {
    $len = $fs.Length
    $b = New-Object byte[] (4096)
    $fs.Read($b, 0, [Math]::Min(4096, $len)) | Out-Null
  } finally { $fs.Close() }
  if ([Text.Encoding]::ASCII.GetString($b, 0, 2) -ne "MZ") { return -1 }
  $peOff = [BitConverter]::ToInt32($b, 0x3C)
  if ([Text.Encoding]::ASCII.GetString($b, $peOff, 4) -ne "PE`0`0") { return -1 }
  return [BitConverter]::ToUInt16($b, $peOff + 0x5C)
}
$subL = Get-Subsystem $launcher
$subE = Get-Subsystem $engine
Check "MagicDialer.exe is a real GUI exe (subsystem 2)" ($subL -eq 2) ("PE subsystem=" + $subL)
Check "agent.exe is the console engine (subsystem 3)" ($subE -eq 3) ("PE subsystem=" + $subE)

# 3. spin up the mock portal (real node, background, own port)
$portalPort = 48991
$mock = Join-Path $Build "verify\mock-portal.cjs"
$ph = Start-Process -FilePath $nodeExe -ArgumentList @($mock, $portalPort) -PassThru -WindowStyle Hidden
$portalUp = $false
for ($i = 0; $i -lt 40 -and -not $portalUp; $i++) {
  Start-Sleep -Milliseconds 250
  try { $pv = Invoke-WebRequest ("http://127.0.0.1:" + $portalPort + "/") -UseBasicParsing -TimeoutSec 2; $portalUp = ($pv.StatusCode -eq 200) } catch {}
}
Check "mock portal up" $portalUp ("127.0.0.1:" + $portalPort)

# 4. boot the REAL packaged engine with a sample token against the mock portal
$configDir = Join-Path $env:TEMP ("mdl-deep-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
$env:AUTODIAL_HOME = $configDir

$engineProc = Start-Process -FilePath $engine -ArgumentList @(
  "--portal", ("http://127.0.0.1:" + $portalPort),
  "--token", "TEST-KEY-1234",
  "--startup", "--no-browser"
) -PassThru -WindowStyle Hidden

$statusPath = Join-Path $configDir "status.json"
$status = $null
$ok = $false
for ($i = 0; $i -lt 60 -and -not $ok; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Path -LiteralPath $statusPath) {
    try {
      $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
      if ($status.status -eq "ONLINE") { $ok = $true }
    } catch {}
  }
}
Check "engine reached ONLINE via mock portal" $ok ("status.json status=" + $status.status)

if ($ok) {
  Check "dashboard URL recorded" ([bool]$status.dashboardUrl) ("url=" + $status.dashboardUrl)
  $port = 0
  if ($status.dashboardUrl -match ":(\d+)") { $port = [int]$Matches[1] }
  $dash = $null
  for ($i = 0; $i -lt 10 -and -not $dash; $i++) {
    Start-Sleep -Milliseconds 400
    try { $dash = Invoke-WebRequest ("http://127.0.0.1:" + $port + "/") -UseBasicParsing -TimeoutSec 3 } catch {}
  }
  Check "dashboard HTTP 200" ($null -ne $dash -and $dash.StatusCode -eq 200) ("port=" + $port)
}

# 5. watchdog-broker respawn: kill the engine, expect it to come back
if ($ok) {
  Stop-Process -Id $engineProc.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 5000
  $re = Get-Process -Name "agent" -ErrorAction SilentlyContinue
  Check "engine respawned by watchdog-broker after kill" ($null -ne $re) ("procs=" + (@($re).Count))
}

# 6. shutdown
if ($ph) { Stop-Process -Id $ph.Id -Force -ErrorAction SilentlyContinue }
Get-Process -Name "agent" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item Env:AUTODIAL_HOME -ErrorAction SilentlyContinue

Write-Host ""
if ($Failed.Count -eq 0) { Write-Host "==== DEEP VERIFY: ALL GREEN ====" } else { Write-Host ("==== FAILURES: " + ($Failed -join ", ")) }
exit $(if ($Failed.Count -eq 0) { 0 } else { 1 })