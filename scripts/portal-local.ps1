# Runs the Magic Dialer portal on THIS PC, against the live Supabase database.
#
# Why this exists: Suga has suspended the deployment twice this month, and with
# it the site, the one-click queue button and the qualified-lead emails all went
# with it. Suga holds no data - Supabase does - so all that is missing is
# somewhere for the Next.js process to run. That somewhere is this machine.
#
# SAFETY: the startup bootstrap (scripts/production-db-bootstrap.cjs) reads only
# against PostgreSQL - it counts tables and confirms User/Lead exist, then
# returns. It never pushes a schema or runs a migration when DATABASE_URL is
# postgres. Starting this script cannot alter production.
#
# The DATABASE_URL is read from sugamcp/myset.cjs and exported into the process
# environment without being printed, so it never lands in shell history, logs or
# a screenshot.
param(
    # Skip the ~2 minute `next build` when .next is already current.
    [switch]$SkipBuild,
    # Bind a port other than 3000 if something already owns it.
    [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path (Join-Path $root "scripts\read-db-url.cjs"))) {
    Write-Error "scripts/read-db-url.cjs is missing, so the database URL cannot be read."
}

# The URL is read by a helper file rather than inline JavaScript: Windows turns
# a double quote inside a shell argument into \" and node then parses garbage.
# The result is captured into the child environment only and never echoed here,
# so it never reaches shell history, a log or a screenshot.
$dbUrl = (& node (Join-Path $root "scripts\read-db-url.cjs"))
if (-not $dbUrl -or $dbUrl -notmatch "^postgres") {
    Write-Error "Failed to read a usable postgres URL. Nothing was started."
}
$env:DATABASE_URL = $dbUrl
$env:PORT = [string]$Port
if (-not $env:NEXT_PUBLIC_SITE_URL) { $env:NEXT_PUBLIC_SITE_URL = "http://127.0.0.1:$Port" }

Push-Location $root
try {
    if (-not $SkipBuild) {
        Write-Host "Building the portal (this takes about 2 minutes)..."
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "next build failed" }
    }
    Write-Host ""
    Write-Host "Portal starting on http://127.0.0.1:$Port"
    Write-Host "Dashboard:  http://127.0.0.1:$Port/en"
    Write-Host "Health:     http://127.0.0.1:$Port/api/health"
    Write-Host ""
    Write-Host "The startup check below only READS the database. It will print"
    Write-Host "'left untouched' - that is the confirmation nothing was migrated."
    Write-Host ""
    # Bootstrap first, exactly as `npm start` does, then start Next bound to
    # loopback. `next start` alone listens on every interface, which would put
    # the production portal - admin login and all - on the LAN. The tunnel only
    # ever reaches 127.0.0.1, so nothing is lost by refusing everything else.
    node scripts/production-db-bootstrap.cjs
    if ($LASTEXITCODE -ne 0) { throw "database readiness check failed; portal not started" }
    node node_modules/next/dist/bin/next start -H 127.0.0.1 -p $Port
}
finally {
    Pop-Location
    Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
}
