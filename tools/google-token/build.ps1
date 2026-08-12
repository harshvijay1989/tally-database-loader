<#
  build.ps1 - Package the zero-install Google token baker for hand-off.
  Copies a portable node.exe into this folder and zips the tool so it runs on a
  machine with NO Node.js installed.

  Usage:  powershell -ExecutionPolicy Bypass -File tools\google-token\build.ps1
  Output: tools\google-token\google-token-tool.zip
#>
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot

$node = @('C:\Program Files\nodejs\node.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $node) { $c = Get-Command node -ErrorAction SilentlyContinue; if ($c) { $node = $c.Source } }
if (-not $node) { throw 'node.exe not found. Install Node.js on this build machine.' }
Copy-Item $node (Join-Path $dir 'node.exe') -Force
Write-Host "bundled node.exe ($(& $node --version))"

$items = 'node.exe', 'bake-google-token.mjs', 'run.bat', 'README.md', 'oauth-client.sample.json' |
    ForEach-Object { Join-Path $dir $_ } | Where-Object { Test-Path $_ }
$zip = Join-Path $dir 'google-token-tool.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $items -DestinationPath $zip -Force
Write-Host "DONE -> $zip ($([math]::Round((Get-Item $zip).Length/1MB,1)) MB)" -ForegroundColor Green
Write-Host 'Hand this zip to whoever can sign into the target Google account.'
