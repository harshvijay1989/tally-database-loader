<#
  build.ps1 - Package the zero-install Google token baker for hand-off.
  Copies a portable node.exe into this folder and zips the tool so it runs on a
  machine with NO Node.js installed.

  Usage:  powershell -ExecutionPolicy Bypass -File tools\google-token\build.ps1
          optional: -Version 5   (otherwise auto-increments v1, v2, ...)
  Output: tools\google-token\google-token-tool-v<N>.zip
          (versioned so each rebuild extracts to a distinct folder and can't be
           confused with an older copy on the recipient's machine)
#>
param([int]$Version = 0)
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot

$node = @('C:\Program Files\nodejs\node.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $node) { $c = Get-Command node -ErrorAction SilentlyContinue; if ($c) { $node = $c.Source } }
if (-not $node) { throw 'node.exe not found. Install Node.js on this build machine.' }
Copy-Item $node (Join-Path $dir 'node.exe') -Force
Write-Host "bundled node.exe ($(& $node --version))"

# include a pre-filled oauth-client.json if present, so the zip is ready to run
$items = 'node.exe', 'bake-google-token.mjs', 'run.bat', 'README.md', 'oauth-client.sample.json', 'oauth-client.json' |
    ForEach-Object { Join-Path $dir $_ } | Where-Object { Test-Path $_ }
# pick a version number: use -Version, else one past the highest existing v<N>
if ($Version -le 0) {
    $existing = Get-ChildItem $dir -Filter 'google-token-tool-v*.zip' -ErrorAction SilentlyContinue
    $max = 0
    foreach ($f in $existing) { if ($f.BaseName -match '-v(\d+)$') { $n = [int]$Matches[1]; if ($n -gt $max) { $max = $n } } }
    $Version = $max + 1
}
$zip = Join-Path $dir "google-token-tool-v$Version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $items -DestinationPath $zip -Force
Write-Host "DONE -> $zip ($([math]::Round((Get-Item $zip).Length/1MB,1)) MB)" -ForegroundColor Green
Write-Host "Extracts to folder: google-token-tool-v$Version"
Write-Host 'Hand this zip to whoever can sign into the target Google account.'
