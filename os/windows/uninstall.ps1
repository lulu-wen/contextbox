# ContextBox — remove it from this Windows machine
#
#   powershell -ExecutionPolicy Bypass -File os\windows\uninstall.ps1
#
# Deletes only the two shortcuts install.ps1 made.
# **Your data is left alone**: the settings, database and quarantine under ~/.contextbox/ all stay.

$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host 'Removing ContextBox' -ForegroundColor Cyan

$links = @(
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'ContextBox Pet.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Startup'))  'ContextBox Pet.lnk')
)

$n = 0
foreach ($l in $links) {
  if (Test-Path $l) {
    Remove-Item $l -Force
    Write-Host "  ok  deleted $l"
    $n++
  }
}
if ($n -eq 0) { Write-Host '  -   No shortcuts found; it was not installed' }

# ── The data stays, and we say exactly where ──────────────────
$data = Join-Path $env:USERPROFILE '.contextbox'
$quar = Join-Path $data 'quarantine'

Write-Host ''
if (Test-Path $quar) {
  $items = @(Get-ChildItem $quar -Recurse -File -ErrorAction SilentlyContinue)
  $mb = if ($items.Count) { [math]::Round(($items | Measure-Object Length -Sum).Sum / 1MB, 1) } else { 0 }
  Write-Host "Quarantine still holds $($items.Count) files ($mb MB):" -ForegroundColor Yellow
  Write-Host "  $quar"
  Write-Host ''
  Write-Host 'Those are your files, not the program''s.' -ForegroundColor Yellow
  Write-Host 'To get them back: node cli.mjs cleanup quarantine'
  Write-Host 'Delete that folder by hand only once you are sure you do not want them.'
} else {
  Write-Host "Settings and data are still in $data (untouched)"
}
Write-Host ''
