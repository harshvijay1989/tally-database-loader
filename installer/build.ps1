<#
  build.ps1 - Build the self-contained Windows installer for the
  Tally -> Salesforce Connector.

  What it produces:
    installer\build\TallySalesforceConnector-Setup.exe

  The installer bundles:
    * the compiled connector (dist\)
    * production node_modules
    * a portable Node.js runtime (node\node.exe)  -> machine needs no Node
    * the web UI and Tally/config files
    * the Salesforce CLI offline installer          -> installed silently on setup

  Prerequisites on the BUILD machine (not the target machine):
    * Node.js + npm            (to compile TypeScript and install prod deps)
    * Inno Setup 6 (ISCC.exe)  (to compile the .exe)  -> winget install JRSoftware.InnoSetup

  Usage:
    powershell -ExecutionPolicy Bypass -File installer\build.ps1
    optional: -Version 1.0.0  -SkipSf  (build without bundling the SF CLI)
#>
[CmdletBinding()]
param(
    [string]$Version = '1.0.0'
)

$ErrorActionPreference = 'Stop'
$repo      = Split-Path -Parent $PSScriptRoot          # repo root
$installer = $PSScriptRoot                             # installer\
$build     = Join-Path $installer 'build'
$payload   = Join-Path $build 'payload'

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }

# --- locate the build toolchain -------------------------------------------------
function Find-Exe([string]$name, [string[]]$candidates) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($p in $candidates) { if (Test-Path $p) { return $p } }
    return $null
}

$nodeExe = Find-Exe 'node' @('C:\Program Files\nodejs\node.exe')
if (-not $nodeExe) { throw 'Node.js not found. Install Node.js on the build machine.' }
$nodeDir = Split-Path -Parent $nodeExe
$npmCmd  = Join-Path $nodeDir 'npm.cmd'
$iscc    = Find-Exe 'ISCC' @(
    'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
    'C:\Program Files\Inno Setup 6\ISCC.exe',
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe")
if (-not $iscc) { throw 'Inno Setup (ISCC.exe) not found. Run: winget install JRSoftware.InnoSetup' }

Write-Host "node : $nodeExe"
Write-Host "npm  : $npmCmd"
Write-Host "iscc : $iscc"

# Put node on PATH for this process so npm/npx resolve.
$env:PATH = "$nodeDir;$env:PATH"

# --- 1. compile TypeScript ------------------------------------------------------
Step 'Compiling TypeScript (src -> dist)'
Push-Location $repo
& $npmCmd exec --yes -- tsc -p src\tsconfig.json
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "TypeScript compile failed (exit $LASTEXITCODE)" }
Pop-Location

# --- 2. clean + stage payload ---------------------------------------------------
Step 'Staging payload'
if (Test-Path $payload) { Remove-Item $payload -Recurse -Force }
New-Item -ItemType Directory -Path $payload -Force | Out-Null

# app code + web UI + configs (data dirs like csv/ mappings/ are created at runtime)
Copy-Item (Join-Path $repo 'dist')   (Join-Path $payload 'dist')   -Recurse -Force
Copy-Item (Join-Path $repo 'webui')  (Join-Path $payload 'webui')  -Recurse -Force
foreach ($f in @(
        'config.json',
        'tally-export-config.json',
        'tally-export-config.yaml',
        'tally-export-config-incremental.yaml')) {
    Copy-Item (Join-Path $repo $f) (Join-Path $payload $f) -Force
}
# runtime launcher, renamed to a user-friendly name
Copy-Item (Join-Path $installer 'launcher.bat') (Join-Path $payload 'start-connector.bat') -Force

# --- 3. production node_modules -------------------------------------------------
Step 'Installing production node_modules into payload'
Copy-Item (Join-Path $repo 'package.json')      (Join-Path $payload 'package.json') -Force
Copy-Item (Join-Path $repo 'package-lock.json') (Join-Path $payload 'package-lock.json') -Force
Push-Location $payload
& $npmCmd install --omit=dev --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "npm production install failed (exit $LASTEXITCODE)" }
Pop-Location

# --- 4. portable Node runtime ---------------------------------------------------
Step 'Bundling portable Node.js runtime'
New-Item -ItemType Directory -Path (Join-Path $payload 'node') -Force | Out-Null
Copy-Item $nodeExe (Join-Path $payload 'node\node.exe') -Force
$nodeVer = (& $nodeExe --version)
Write-Host "bundled Node runtime $nodeVer"

# --- 5. compile the installer ---------------------------------------------------
Step 'Compiling installer with Inno Setup'
& $iscc "/DMyAppVersion=$Version" (Join-Path $installer 'connector.iss')
if ($LASTEXITCODE -ne 0) { throw "ISCC failed (exit $LASTEXITCODE)" }

$out = Join-Path $build 'TallySalesforceConnector-Setup.exe'
if (Test-Path $out) {
    $mb = [math]::Round((Get-Item $out).Length / 1MB, 1)
    Write-Host "`nDONE -> $out ($mb MB)" -ForegroundColor Green
} else {
    throw 'Build finished but setup.exe was not produced.'
}
