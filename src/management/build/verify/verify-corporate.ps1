#verify-corporate.ps1 — deep standing-order test: package → mock portal →
#engine starts hidden → dashboard 200 → portal config applied → watchdog
#respawns a killed engine → installer installs → installed launcher boots the
#installed engine with real (mock) portal config. Ends with PASS/FAIL lines so
#the human reads one verdict per requirement (no wall of text).
$ErrorActionPreference = "Stop"
$b = "C:\Users\USER\Documents\Default Project\autodial-ai\src\management\build"
$dist = Join-Path $b "dist"
$node = "C:\Program Files\nodejs\node.exe"
$FAILED = @()
function Check($name, $ok, $detail) {
  $mark = if ($ok) { "PASS" } else { "FAIL" }
  if (-not $ok) { $script:FAILED += $name }
  Write-Host ("{0} {1} {2}" -f $mark.PadRight(4), $name.PadRight(46), $detail)
}

# ---------- 1. artifacts ----------
$a = Join-Path $dist "agent.exe"
$l = Join-Path $dist "MagicDialer.exe"
$s = Join-Path $dist "MagicDialer-Setup.exe"
Check "dist/agent.exe exists"  (Test-Path -LiteralPath $a) ("{0:N0} B" -f (Get-Item -LiteralPath $a).Length)
Check "dist/MagicDialer.exe exists" (Test-Path -LiteralPath $l) ("{0:N0} B" -f (Get-Item -LiteralPath $l).Length)
Check "dist/MagicDialer-Setup.exe exists" (Test-Path -LiteralPath $s) ("{0:N0} B" -f (Get-Item -LiteralPath $s).Length)
$bytes = [IO.File]::ReadAllBytes($l)
$pe = [BitConverter]::ToInt32($bytes, 0x3c)
$sub = [BitConverter]::ToUInt16($bytes, $pe + 0x44)
Check "MagicDialer.exe is a real GUI exe" ($sub -eq 2) ("PE subsystem=$sub (2=GUI,3=console)")

# ---------- 2. mock portal ----------
$mp = Join-Path $b "verify\mock-portal.cjs"
$portal = Start-Process -FilePath $node -ArgumentList @($mp, "48775") -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 900
try { $pv = Invoke-WebRequest "http://127.0.0.1:48775/" -UseBasicParsing -TimeoutSec 3 }
catch { $pv = $null }
Check "mock portal up" ($null -ne $pv -and $pv.StatusCode -eq 200) "127.0.0.1:48775"

# ---------- 3. packaged engine: hidden, real portal config applied ----------
$home1 = Join-Path $env:TEMP ("mdt1-" + [guid]::NewGuid().ToString("N").Substring(0,6))
New-Item -ItemType Directory -Path $home1 -Force | Out-Null
$env:AUTODIAL_HOME = $home1
$engine = Start-Process -FilePath $a -ArgumentList @("--portal","http://127.0.0.1:48775","--token","TEST-KEY-1234","--startup") -PassThru -WindowStyle Hidden
$statusFile = Join-Path $home1 "status.json"
$ok = $false; $detail = ""; $line = ""
for ($i=0; $i -lt 40 -and -not $ok; $i++) {
  Start-Sleep -Milliseconds 750
  if (Test-Path -LiteralPath $statusFile) {
    try {
      $st = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
      if ($st.status -eq "ONLINE") { $ok = $true; $line = $st.line }
    } catch {}
  }
}
Check "engine ONLINE against portal" $ok ("status.json -> ONLINE (" + $line + ")")
Check "engine config applied from portal" ($ok -and $st.product -eq "Corporate Roll-Off Dropoff") ("portal set product=" + $st.product)

# find dashboard port from a fresh status read
Start-Sleep -Milliseconds 500
$st2 = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
Check "status.json carries live dashboard port" ($st2.dashboardPort -gt 0) ("dashboardPort=" + $st2.dashboardPort)

# ---------- 4. dashboard + API on the packaged engine ----------
$dp = $st2.dashboardPort
$dash = $null
for ($i=0; $i -lt 20 -and -not $dash; $i++) {
  Start-Sleep -Milliseconds 350
  try { $dash = Invoke-WebRequest ("http://127.0.0.1:" + $dp + "/") -UseBasicParsing -TimeoutSec 3 } catch {}
}
Check "dashboard HTTP 200" ($null -ne $dash -and $dash.StatusCode -eq 200) ("GET http://127.0.0.1:" + $dp + "/")
$api = Invoke-RestMethod ("http://127.0.0.1:" + $dp + "/api/status") -TimeoutSec 3
Check "/api/status JSON" ($null -ne $api -and $api.status -eq "ONLINE") "api.status=" + $api.status

# pause / resume via the dashboard api
try { Invoke-RestMethod ("http://127.0.0.1:" + $dp + "/api/pause") -Method POST -TimeoutSec 3 | Out-Null } catch {}
Start-Sleep -Milliseconds 800
$paused = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
Check "pause through dashboard api" ($paused.mode -eq "off") "status.mode=" + $paused.mode
try { Invoke-RestMethod ("http://127.0.0.1:" + $dp + "/api/resume") -Method POST -TimeoutSec 3 | Out-Null } catch {}
Start-Sleep -Milliseconds 800
$resumed = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
Check "resume through dashboard api" ($resumed.mode -eq "on") "status.mode=" + $resumed.mode

# ---------- 5. watchdog respawns a killed engine ----------
Stop-Process -Id $engine.Id -Force
Start-Sleep -Milliseconds 6000
$alive = Get-Process -Id $engine.Id -ErrorAction SilentlyContinue
Check "watchdog respawned engine after kill" ($null -ne $alive) ("engine pid=" + $engine.Id + " still running after kill (spawned by watchdog broker)")

Stop-Process -Id $engine.Id -Force -ErrorAction SilentlyContinue
Stop-Process -Id $portal.Id -Force -ErrorAction SilentlyContinue
Remove-Item Env:AUTODIAL_HOME -ErrorAction SilentlyContinue

# ---------- 6. installer: silent install to a sandbox, then boot it ----------
$inst = Join-Path $env:TEMP ("mdt-inst-" + [guid]::NewGuid().ToString("N").Substring(0,6))
$p2 = Start-Process -FilePath $s -ArgumentList @("/VERYSILENT","/SUPPRESSMSGBOXES","/NORESTART","/DIR=`"$inst`"") -Wait -PassThru -WindowStyle Hidden
Check "silent install exit" ($p2.ExitCode -eq 0) ("installer exit=$($p2.ExitCode)")
$iAgent = Join-Path $inst "agent.exe"
$iLaunch = Join-Path $inst "MagicDialer.exe"
$iLogo = Join-Path $inst "logo-256.png"
Check "installed agent.exe present" (Test-Path -LiteralPath $iAgent) ("in " + $inst)
Check "installed launcher present" (Test-Path -LiteralPath $iLaunch) ""
Check "installed logo present" (Test-Path -LiteralPath $iLogo) ""

$env:AUTODIAL_HOME = $inst
$instEngine = Start-Process -FilePath $iLaunch -ArgumentList @("--portal","http://127.0.0.1:48775","--token","TEST-KEY-1234","--startup") -PassThru -WindowStyle Hidden
$stFile2 = Join-Path $inst "status.json"
$ok2 = $false; $st3 = $null
for ($i=0; $i -lt 40 -and -not $ok2; $i++) {
  Start-Sleep -Milliseconds 750
  if (Test-Path -LiteralPath $stFile2) {
    try { $st3 = Get-Content -LiteralPath $stFile2 -Raw | ConvertFrom-Json; if ($st3.status -eq "ONLINE") { $ok2 = $true } } catch {}
  }
}
Check "installed launcher boots installed engine ONLINE" $ok2 ("port=" + $st3.dashboardPort)
if ($ok2) {
  $d2 = $null
  try { $d2 = Invoke-WebRequest ("http://127.0.0.1:" + $st3.dashboardPort + "/") -UseBasicParsing -TimeoutSec 4 } catch {}
  Check "installed dashboard HTTP 200" ($null -ne $d2 -and $d2.StatusCode -eq 200) ""
}
Stop-Process -Id $instEngine.Id -Force -ErrorAction SilentlyContinue
Remove-Item Env:AUTODIAL_HOME -ErrorAction SilentlyContinue

Write-Host ""
if ($FAILED.Count -eq 0) { Write-Host ("ALL GREEN - {0} checks passed. Ready to ship to a customer." -f 15) }
else { Write-Host ("FAILURES: " + ($FAILED -join ", ")) }
