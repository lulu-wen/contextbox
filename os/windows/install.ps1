# ContextBox — install on this Windows machine
#
# Two things, neither of which needs an administrator and both of which can be undone:
#   1. a "ContextBox Pet" shortcut in the Start menu
#   2. (optional) start it when you log in
#
# Run it with:
#   powershell -ExecutionPolicy Bypass -File os\windows\install.ps1
#   powershell -ExecutionPolicy Bypass -File os\windows\install.ps1 -Startup
#
# To remove: os\windows\uninstall.ps1

[CmdletBinding()]
param(
  # Only starts at login if you pass this. Off by default — parking yourself in someone's
  # startup folder without asking is rude.
  [switch]$Startup
)

$ErrorActionPreference = 'Stop'

# os\windows\install.ps1 -> the repo root
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Cmd  = Join-Path $PSScriptRoot 'contextbox-pet.cmd'

Write-Host ''
Write-Host 'Installing ContextBox' -ForegroundColor Cyan
Write-Host "  Project: $Repo"

# ── Node first ────────────────────────────────────────────────
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host '  x Node.js is not here. Install it first: winget install OpenJS.NodeJS' -ForegroundColor Red
  exit 2
}
$ver = (& node -v).TrimStart('v')
$major = [int]($ver.Split('.')[0])
if ($major -lt 24) {
  Write-Host "  x Node is $ver; this needs 24 or newer." -ForegroundColor Red
  exit 2
}
Write-Host "  ok  Node $ver"

if (-not (Test-Path $Cmd)) {
  Write-Host "  x  $Cmd is missing" -ForegroundColor Red
  exit 2
}

# ── The shortcuts ─────────────────────────────────────────────
function New-Shortcut {
  param([string]$Path, [string]$Target, [string]$WorkDir, [string]$Desc)
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($Path)
  $sc.TargetPath       = $Target
  $sc.WorkingDirectory = $WorkDir
  $sc.Description      = $Desc
  # 7 = minimised, not hidden — when something goes wrong you want to see the window.
  $sc.WindowStyle      = 7
  $sc.Save()
}

$programs = [Environment]::GetFolderPath('Programs')
$startMenuLink = Join-Path $programs 'ContextBox Pet.lnk'
New-Shortcut -Path $startMenuLink -Target $Cmd -WorkDir $Repo -Desc 'ContextBox: the desktop pet that tidies your Downloads'
Write-Host "  ok  Start menu: $startMenuLink"

$startupDir  = [Environment]::GetFolderPath('Startup')
$startupLink = Join-Path $startupDir 'ContextBox Pet.lnk'

if ($Startup) {
  New-Shortcut -Path $startupLink -Target $Cmd -WorkDir $Repo -Desc 'ContextBox at login'
  Write-Host "  ok  Starts at login: $startupLink"
} else {
  Write-Host '  -   Not starting at login (add -Startup if you want that)'
}

# ── Check the machine before we call it done ──────────────────
Write-Host ''
Write-Host 'Checking this machine:' -ForegroundColor Cyan
Push-Location $Repo
try { & node cli.mjs doctor } finally { Pop-Location }

Write-Host ''
Write-Host 'Done. Search the Start menu for "ContextBox" to open it.' -ForegroundColor Green
Write-Host 'To remove: powershell -ExecutionPolicy Bypass -File os\windows\uninstall.ps1'
Write-Host ''
Write-Host 'Note: the uninstaller only deletes the shortcuts.' -ForegroundColor Yellow
Write-Host '      It never touches ~/.contextbox/quarantine/ - your files live there.' -ForegroundColor Yellow
