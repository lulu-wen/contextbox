# ContextBox — 安裝到這台 Windows
#
# 做兩件事，兩件都**不需要系統管理員**、兩件都可以還原：
#   1. 開始選單放一個「ContextBox Pet」捷徑
#   2. （選配）開機自動啟動
#
# 跑法：
#   powershell -ExecutionPolicy Bypass -File os\windows\install.ps1
#   powershell -ExecutionPolicy Bypass -File os\windows\install.ps1 -Startup
#
# 移除：os\windows\uninstall.ps1

[CmdletBinding()]
param(
  # 加了這個才會開機自動啟動。預設不開 —— 不問一聲就常駐是很沒禮貌的事。
  [switch]$Startup
)

$ErrorActionPreference = 'Stop'

# os\windows\install.ps1 -> repo 根目錄
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Cmd  = Join-Path $PSScriptRoot 'contextbox-pet.cmd'

Write-Host ''
Write-Host 'ContextBox 安裝' -ForegroundColor Cyan
Write-Host "  專案位置：$Repo"

# ── 先確認 Node ───────────────────────────────────────────────
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host '  ✗ 找不到 Node.js。先裝：winget install OpenJS.NodeJS' -ForegroundColor Red
  exit 2
}
$ver = (& node -v).TrimStart('v')
$major = [int]($ver.Split('.')[0])
if ($major -lt 24) {
  Write-Host "  ✗ Node 版本是 $ver，需要 24 以上。" -ForegroundColor Red
  exit 2
}
Write-Host "  ✓ Node $ver"

if (-not (Test-Path $Cmd)) {
  Write-Host "  ✗ 找不到 $Cmd" -ForegroundColor Red
  exit 2
}

# ── 建捷徑 ────────────────────────────────────────────────────
function New-Shortcut {
  param([string]$Path, [string]$Target, [string]$WorkDir, [string]$Desc)
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($Path)
  $sc.TargetPath       = $Target
  $sc.WorkingDirectory = $WorkDir
  $sc.Description      = $Desc
  # 7 = 最小化。不用隱藏 —— 出錯的時候使用者要看得到視窗。
  $sc.WindowStyle      = 7
  $sc.Save()
}

$programs = [Environment]::GetFolderPath('Programs')
$startMenuLink = Join-Path $programs 'ContextBox Pet.lnk'
New-Shortcut -Path $startMenuLink -Target $Cmd -WorkDir $Repo -Desc 'ContextBox：幫你清 Downloads 的桌面寵物'
Write-Host "  ✓ 開始選單：$startMenuLink"

$startupDir  = [Environment]::GetFolderPath('Startup')
$startupLink = Join-Path $startupDir 'ContextBox Pet.lnk'

if ($Startup) {
  New-Shortcut -Path $startupLink -Target $Cmd -WorkDir $Repo -Desc 'ContextBox 開機啟動'
  Write-Host "  ✓ 開機自動啟動：$startupLink"
} else {
  Write-Host '  · 沒有設定開機自動啟動（要的話加 -Startup）'
}

# ── 裝完先跑一次健檢 ──────────────────────────────────────────
Write-Host ''
Write-Host '健檢：' -ForegroundColor Cyan
Push-Location $Repo
try { & node cli.mjs doctor } finally { Pop-Location }

Write-Host ''
Write-Host '裝好了。開始選單搜尋「ContextBox」就能開。' -ForegroundColor Green
Write-Host '要移除：powershell -ExecutionPolicy Bypass -File os\windows\uninstall.ps1'
Write-Host ''
Write-Host '注意：移除腳本只會刪捷徑，' -ForegroundColor Yellow
Write-Host '      不會碰 ~/.contextbox/quarantine/ —— 那裡是你的檔案。' -ForegroundColor Yellow
