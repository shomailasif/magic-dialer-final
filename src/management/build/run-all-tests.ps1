# Magic Dialer - master test runner.
# Runs every automated test suite and fails loudly if ANYTHING fails.
# Usage: powershell -ExecutionPolicy Bypass -File run-all-tests.ps1
$node = Join-Path $env:ProgramFiles "nodejs\node.exe"
$tests = @(
  "test-brain.js",
  "test-brain-i18n.js",
  "test-agent.js",
  "test-leads.js",
  "test-inbound-learning.js",
  "test-hear-wave.js",
  "test-portal.js",
  "test-portal-isolation.js",
  "test-portal-lang.js",
  "test-voice-style.js",
  "test-learning.js",
  "test-gateway.js",
  "agent\\local-ringcentral-engine.test.js"
)
$fail = 0
foreach ($t in $tests) {
  $target = Join-Path $PSScriptRoot "..\$t"
  Write-Host ""
  Write-Host "=== $t ===" -ForegroundColor Cyan
  if (-not (Test-Path -LiteralPath $target)) { Write-Host "  SKIP (file not found)" -ForegroundColor Yellow; continue }
  & $node $target
  if ($LASTEXITCODE -eq 0) { Write-Host "  $t : PASS" -ForegroundColor Green }
  else { Write-Host "  $t : FAIL" -ForegroundColor Red; $fail++ }
}
Write-Host ""
if ($fail -eq 0) { Write-Host "ALL TEST SUITES PASSED" -ForegroundColor Green; exit 0 }
else { Write-Host "$fail SUITE(S) FAILED" -ForegroundColor Red; exit 1 }
