# Build the Windows installer and report why it failed if it does.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/build-installer.ps1 [-Zip]
param([switch]$Zip)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

& "$PSScriptRoot\clean-release.ps1"

# To create the uninstaller, electron-builder runs the freshly built, unsigned setup stub.
# Smart App Control blocks that (Code Integrity event 3077), which surfaces as "spawn UNKNOWN".
# The same policy would also block running the finished unsigned installer on this PC,
# so with Smart App Control enforcing we build the zip instead.
try {
  $sac = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -ErrorAction Stop).VerifiedAndReputablePolicyState
  if ($sac -eq 1 -and -not $Zip) {
    Write-Warning 'Smart App Control is ON, so the installer cannot be built or run on this PC. Building the zip instead. For a Setup .exe, use the "installer" CI job or a PC without Smart App Control.'
    $Zip = $true
  }
  elseif ($sac -eq 2) { Write-Host 'Smart App Control is in evaluation mode.' }
} catch { }

$env:DEBUG = 'electron-builder'
npm run build
if ($LASTEXITCODE -ne 0) { throw 'build failed' }

if ($Zip) { npx electron-builder --win zip --x64 }
else      { npx electron-builder --win nsis --x64 }
if ($LASTEXITCODE -ne 0) {
  Write-Error @"
Packaging failed. If the error is 'spawn UNKNOWN' during uninstaller creation:
  1. Add the project folder and %LOCALAPPDATA%\electron-builder\Cache to Windows Security exclusions.
  2. Check Windows Security > App & browser control > Smart App Control (it blocks unsigned helpers; turning it off cannot be undone).
  3. Re-run with -Zip to get a portable folder archive that needs no NSIS step.
"@
}
Get-ChildItem release -File | Format-Table Name, Length
