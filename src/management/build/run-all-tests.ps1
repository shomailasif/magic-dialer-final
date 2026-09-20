# Magic Dialer - mandatory regression runner.
# Missing required tests are failures, never silent skips.
$node = Join-Path $env:ProgramFiles "nodejs\node.exe"
$tests = @(
  "agent\local-ringcentral-engine.test.js",
  "agent\local-ringcentral-engine.behavior.test.js",
  "agent\local-call-controller.behavior.test.js",
  "agent\engine-health.behavior.test.js",
  "agent\auto-update.behavior.test.js",
  "build\release-version-consistency.test.js",
  "build\\ai-gateway-contract.test.js",
  "build\\groq-direct-probe-contract.test.js",
  "build\\engine-ai-stage-contract.test.js",
  "build\\engine-device-auth-contract.test.js",
  "build\\ai-transport-repair.behavior.test.js"
)
$fail = 0
foreach ($t in $tests) {
  $target = Join-Path $PSScriptRoot "..\$t"
  Write-Host ""
  Write-Host "=== $t ===" -ForegroundColor Cyan
  if (-not (Test-Path -LiteralPath $target)) {
    Write-Host "  $t : FAIL (required test file missing)" -ForegroundColor Red
    $fail++
    continue
  }
  & $node $target
  if ($LASTEXITCODE -eq 0) { Write-Host "  $t : PASS" -ForegroundColor Green }
  else { Write-Host "  $t : FAIL" -ForegroundColor Red; $fail++ }
}
Write-Host ""
if ($fail -eq 0) { Write-Host "ALL REQUIRED REGRESSION SUITES PASSED" -ForegroundColor Green; exit 0 }
Write-Host "$fail REQUIRED SUITE(S) FAILED" -ForegroundColor Red
exit 1
