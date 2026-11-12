# Creates a Start menu shortcut for Jarvin (and optionally one on the Desktop).
param([switch]$Desktop)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$shell = New-Object -ComObject WScript.Shell

function New-Link([string]$path) {
  $l = $shell.CreateShortcut($path)
  $l.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
  $l.Arguments = '"' + (Join-Path $root 'scripts\launch.vbs') + '"'
  $l.WorkingDirectory = $root
  $l.IconLocation = (Join-Path $root 'assets\icon.ico') + ',0'
  $l.Description = 'Jarvin - local voice and desktop companion'
  $l.WindowStyle = 7
  $l.Save()
  Write-Host "Created $path"
}

New-Link (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Jarvin.lnk')
if ($Desktop) { New-Link (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Jarvin.lnk') }
Write-Host 'Done. Press the Windows key and type "Jarvin".'
