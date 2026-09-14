# Compile MagicDialer.exe - the real Windows GUI launcher (the customer's face
# of the product). No console, no PowerShell, branded icon + version metadata.
# Uses the .NET Framework compiler that ships with every Windows 10/11.
param(
  [string]$Config = "",
  [string]$Out = ""
)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root "build"
$assets = Join-Path $build "assets"
if (-not $Config) { $Config = Join-Path $build "launcher.cs" }
if (-not $Out)   { $Out = Join-Path $build "dist\MagicDialer.exe" }

$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path -LiteralPath $csc)) {
  $csc = "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path -LiteralPath $csc)) {
  throw "csc.exe not found - cannot build the launcher. Install .NET Framework 4.x."
}

$icon = Join-Path $assets "logo.ico"
$iconArg = if (Test-Path -LiteralPath $icon) { "/win32icon:`"$icon`"" } else { "" }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Out) | Out-Null

& $csc /nologo /target:winexe /optimize+ /platform:anycpu `
  /out:"$Out" `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll `
  $iconArg `
  "$Config"

if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

$i = Get-Item -LiteralPath $Out
Write-Host "built $Out ($([math]::Round($i.Length/1KB,1)) KB)"
