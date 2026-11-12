# Remove stale/failed installer artifacts so a fresh build is unambiguous.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$rel = Join-Path $root 'release'
if (-not (Test-Path $rel)) { exit 0 }
Get-ChildItem $rel -File | Where-Object { $_.Name -match '\.(old|stale|failed)$' -or $_.Name -like 'builder-*' -or ($_.Name -like 'Jarvin-Setup-*.exe' -and $_.Length -lt 5MB) } | Remove-Item -Force
Write-Host "Cleaned stale artifacts in $rel"
