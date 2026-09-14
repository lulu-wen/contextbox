# ContextBox — 從這台 Windows 移除
#
#   powershell -ExecutionPolicy Bypass -File os\windows\uninstall.ps1
#
# 只刪 install.ps1 建的那兩個捷徑。
# **不碰你的資料**：~/.contextbox/ 底下的設定、資料庫、隔離區都留著。

$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host 'ContextBox 移除' -ForegroundColor Cyan

$links = @(
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'ContextBox Pet.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Startup'))  'ContextBox Pet.lnk')
)

$n = 0
foreach ($l in $links) {
  if (Test-Path $l) {
    Remove-Item $l -Force
    Write-Host "  ✓ 刪掉 $l"
    $n++
  }
}
if ($n -eq 0) { Write-Host '  · 沒有找到任何捷徑，本來就沒裝' }

# ── 資料留著，而且要講清楚留在哪 ──────────────────────────────
$data = Join-Path $env:USERPROFILE '.contextbox'
$quar = Join-Path $data 'quarantine'

Write-Host ''
if (Test-Path $quar) {
  $items = @(Get-ChildItem $quar -Recurse -File -ErrorAction SilentlyContinue)
  $mb = if ($items.Count) { [math]::Round(($items | Measure-Object Length -Sum).Sum / 1MB, 1) } else { 0 }
  Write-Host "隔離區還有 $($items.Count) 個檔案（$mb MB）：" -ForegroundColor Yellow
  Write-Host "  $quar"
  Write-Host ''
  Write-Host '那裡面是**你的檔案**，不是程式的東西。' -ForegroundColor Yellow
  Write-Host '要救回來：node cli.mjs cleanup quarantine'
  Write-Host '確定不要了才手動刪那個資料夾。'
} else {
  Write-Host "設定與資料留在 $data（沒有動它）"
}
Write-Host ''
