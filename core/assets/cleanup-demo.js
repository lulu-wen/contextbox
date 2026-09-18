import { createDemo } from './cleanup-demo-state.js'

const $ = id => document.getElementById(id)
const panel = $('cleanup-panel')
const alertButton = $('quaso-cleanup-alert')
let demo, savedDemo, data, busy = false, pending = null, demoEnabled = false
let currentOperation = null, request = null, health = null, previousCount = 0, healthTimer
let healthChecked = false, healthBusy = false, stopped = false
let mockOffline = new URLSearchParams(location.search).get('mockBackend') === 'offline'
function updateMock() {
  document.documentElement.dataset.mockBackend = mockOffline ? 'offline' : 'online'

}
updateMock()
const historyPanel = $('cleanup-history-panel')
let historyOffset = 0, historyData = null, historyBusy = false
const historySelected = new Set()
const historyApi = (path, body) => window.api('/demo/cleanup/' + path,
  body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
const bytes = n => n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB'
  : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB'

function notice(message) {
  $('quaso-status').textContent = message
  $('quaso-dialog').hidden = false
  $('quaso-stage').setAttribute('aria-expanded', 'true')
}
function updateAlert() {
  const count = demo ? demo.candidates.length : health?.pendingCandidates
  $('quaso-candidate-count').textContent = count == null ? '—' : count > 99 ? '99+' : String(count)
  const source = demo ? '示範' : '本機'
  const label = count == null ? '候選數量尚未取得，點擊重試' : `${source}待清檔案 ${count} 個，點擊開啟清理面板`
  alertButton.setAttribute('aria-label', label)
  alertButton.title = label
  const offline = healthChecked && !health
  alertButton.classList.toggle('attention', count > 0 && !offline)
  const state = offline ? 'worried' : count > 0 ? 'found' : health?.watcher?.ok ? 'watching' : 'idle'
  $('quaso').dataset.petState = state
  $('quaso-worried').hidden = !offline
  $('quaso-stage').title = health?.watcher?.ok ? '📁 Downloads · 監看中' : '與可頌貓對話'
  if (count > previousCount && !offline) {
    $('quaso-stage').classList.remove('found-hop')
    void $('quaso-stage').offsetWidth
    $('quaso-stage').classList.add('found-hop')
  }
  previousCount = count ?? 0
}
function announce() {
  updateAlert()
}
function summary() {
  updateAlert()
  $('cleanup-summary').textContent = `已選 ${demo.selected.size} / ${demo.candidates.length} 個檔案 · ${bytes(demo.bytes)}`
  $('cleanup-apply').disabled = busy || (!demo.canUndo && demo.selected.size === 0)
  $('cleanup-apply').textContent = demo.canUndo ? '完成本次清理' : '確認模擬清理'
  $('cleanup-undo').hidden = !demo.canUndo
  $('cleanup-undo').disabled = busy
  $('cleanup-dismiss').hidden = demo.canUndo
  $('cleanup-dismiss').disabled = busy
  $('cleanup-reset').disabled = busy
}
function paragraph(text, className = '') {
  const p = document.createElement('p')
  p.textContent = text
  p.className = className
  return p
}
function render() {
  panel.dataset.mode = 'demo'
  $('cleanup-mode-note').textContent = '示範模式 · 以下為範例檔案，清理與復原不會修改你的 Downloads。'
  $('cleanup-space-note').hidden = false
  $('cleanup-apply').hidden = $('cleanup-reset').hidden = false
  $('cleanup-list').replaceChildren()
  for (const item of demo.candidates) {
    const card = document.createElement('article')
    card.className = 'cleanup-file'
    const label = document.createElement('label')
    const check = document.createElement('input')
    check.type = 'checkbox'
    check.checked = demo.selected.has(item.itemId)
    check.disabled = busy || demo.canUndo
    check.onchange = () => { demo.select(item.itemId, check.checked); request = null; summary() }
    const name = document.createElement('strong')
    name.textContent = item.name
    label.append(check, name)
    card.append(label, paragraph(`${[item.folder, item.subdir].filter(Boolean).join('/')} · ${bytes(item.bytes)} · 信心 ${item.confidence}%`))
    for (const reason of item.reasons) {
      card.append(paragraph(reason.reason), paragraph(reason.evidence, 'evidence'))
    }
    $('cleanup-list').append(card)
  }
  if (!demo.candidates.length) $('cleanup-list').append(paragraph('這批候選檔案已全部處理。'))
  $('cleanup-needs-human').replaceChildren()
  for (const item of data.needsHuman ?? []) {
    $('cleanup-needs-human').append(paragraph(`需要你查看：${item.name} — ${item.why}（未列入清理）`))
  }
  summary()
}
function result(message) {
  $('cleanup-result').hidden = false
  $('cleanup-result').textContent = message
}
async function load() {
  if (demo) return
  if (savedDemo) { demo = savedDemo; updateAlert(); return }
  if (!pending) pending = (async () => {
    const response = await fetch('/assets/demo-candidates.json')
    if (!response.ok) throw new Error('無法載入範例')
    data = await response.json()
  })().finally(() => { pending = null })
  await pending
  if (!demoEnabled) return
  demo = createDemo(data)
  updateAlert()
}
async function toggleDemo() {
  if (busy || historyBusy) return
  demoEnabled = !demoEnabled
  document.documentElement.dataset.mockCandidates = String(demoEnabled)
  panel.close()
  $('quaso-dialog').hidden = true
  $('quaso-stage').setAttribute('aria-expanded', 'false')
  if (!demoEnabled) {
    if (demo) savedDemo = demo
    demo = null
    updateAlert()
    return
  }
  try { await load() }
  catch {
    demoEnabled = false
    document.documentElement.dataset.mockCandidates = 'false'
    notice('範例暫時讀不到，請確認伺服器已啟動，再按 D 重試。')
  }
}
alertButton.onclick = async () => {
  $('quaso-dialog').hidden = true
  $('quaso-stage').setAttribute('aria-expanded', 'false')
  if (demo) {
    render()
    if (!panel.open) panel.showModal()
    return
  }
  // 真實候選只能查看，避免將本機資料誤送進模擬清理流程。
  panel.dataset.mode = 'local'
  $('cleanup-mode-note').textContent = '本機候選檔案 · 目前可查看，真實清理功能尚未串接。'
  for (const id of ['cleanup-apply', 'cleanup-undo', 'cleanup-dismiss', 'cleanup-reset', 'cleanup-space-note', 'cleanup-result']) $(id).hidden = true
  $('cleanup-list').replaceChildren(paragraph('正在讀取候選檔案……'))
  $('cleanup-needs-human').replaceChildren()
  $('cleanup-summary').textContent = ''
  if (!panel.open) panel.showModal()
  try {
    const local = await window.api('/cleanup/candidates?limit=1000')
    $('cleanup-list').replaceChildren()
    for (const item of local.candidates) {
      const card = document.createElement('article')
      card.className = 'cleanup-file'
      card.append(paragraph(`${item.name} · ${bytes(item.bytes)} · 信心 ${item.confidence}%`))
      for (const reason of item.reasons) card.append(paragraph(reason.reason))
      $('cleanup-list').append(card)
    }
    if (!local.candidates.length) $('cleanup-list').append(paragraph('目前沒有待清檔案。'))
    $('cleanup-summary').textContent = `顯示 ${local.candidates.length} 個本機候選檔案`
  } catch { $('cleanup-list').replaceChildren(paragraph('讀取失敗，請確認伺服器已啟動，關閉面板後點垃圾桶重試。')) }
}
$('cleanup-close').onclick = () => panel.close()
panel.addEventListener('close', () => { if (!alertButton.hidden) alertButton.focus() })
$('cleanup-dismiss').onclick = () => {
  if (busy) return
  panel.close()
  updateAlert()
  notice('好，這次先不清。今天吃可頌了嗎？')
}
async function operate(kind) {
  if (busy) return
  busy = true
  render()
  result(kind === 'apply' ? '正在模擬移入隔離區……' : '正在模擬復原……')
  try {
    if (kind === 'apply') {
      const candidateIds = demo.candidates.filter(c => demo.selected.has(c.itemId)).flatMap(c => c.candidateIds)
      request ??= { requestId: crypto.randomUUID(), candidateIds }
      const saved = await historyApi('history', request)
      if (!saved.canUndo) throw new Error('這次操作已在其他頁面復原，請重新示範。')
      currentOperation = saved.id
      request = null
      const response = demo.apply()
      const message = `模擬清理完成：${response.quarantined} 個檔案，共 ${bytes(response.bytesFreed)} 已移入模擬隔離區。未勾選的檔案保留原樣。`
      result(message)
      notice('整理好了！想改變心意，隨時可以復原這次清理。')
    } else {
      await historyApi('undo', { operationIds: [currentOperation] })
      const response = demo.undo()
      currentOperation = null
      result(`已模擬復原 ${response.restored} 個檔案，回到清理前的清單與勾選狀態。`)
      notice('都幫你放回來了！')
    }
    updateAlert()
  } catch (error) {
    result(error.message)
  } finally {
    busy = false
    render()
  }
}
$('cleanup-apply').onclick = () => {
  if (busy) return
  if (demo.canUndo) {
    updateAlert()
    panel.close()
    notice('這次整理完成了，需要時可以勾選最近動作來復原。')
  }
  else operate('apply')
}
$('cleanup-undo').onclick = () => operate('undo')
$('cleanup-reset').onclick = () => {
  if (busy) return
  demo.reset()
  currentOperation = null
  request = null
  $('cleanup-result').hidden = true
  panel.close()
  announce()
}

function historyResult(message) {
  $('cleanup-history-result').hidden = false
  $('cleanup-history-result').textContent = message
}
function historyControls() {
  $('cleanup-history-undo').textContent = `復原勾選動作（${historySelected.size}）`
  $('cleanup-history-undo').disabled = historyBusy || busy || historySelected.size === 0
  $('cleanup-history-prev').disabled = historyBusy || historyOffset === 0
  $('cleanup-history-next').disabled = historyBusy || !historyData || historyOffset + historyData.limit >= historyData.total
  $('cleanup-history-refresh').disabled = historyBusy
}
function renderHistory() {
  const list = $('cleanup-history-list')
  list.replaceChildren()
  const { total, operations, limit } = historyData
  $('cleanup-history-count').textContent = `尚可復原 ${total} 筆操作${total ? ` · 第 ${Math.floor(historyOffset / limit) + 1} / ${Math.ceil(total / limit)} 頁` : ''}`
  for (const operation of operations) {
    const card = document.createElement('article')
    card.className = 'cleanup-file'
    const label = document.createElement('label')
    const check = document.createElement('input')
    check.type = 'checkbox'
    check.disabled = historyBusy || !operation.canUndo
    check.checked = historySelected.has(operation.id)
    check.onchange = () => {
      if (check.checked) historySelected.add(operation.id)
      else historySelected.delete(operation.id)
      historyControls()
    }
    label.append(check, document.createTextNode(`${new Date(operation.createdAt).toLocaleString('zh-TW')} · 清理 ${operation.itemCount} 個檔案 · ${bytes(operation.bytes)}`))
    card.append(label, paragraph(operation.items.map(i => i.name).join('、')),
      paragraph(operation.canUndo ? '可復原' : `已復原 · ${new Date(operation.restoredAt).toLocaleString('zh-TW')}`, 'evidence'))
    list.append(card)
  }
  if (!operations.length) list.append(paragraph('目前沒有可復原的動作。'))
  historyControls()
}
async function refreshHistory() {
  if (historyBusy) return
  historyBusy = true
  historySelected.clear()
  historyControls()
  $('cleanup-history-list').replaceChildren(paragraph('正在讀取操作紀錄……'))
  try {
    historyData = await historyApi(`history?offset=${historyOffset}&limit=20`)
    historyOffset = historyData.offset
    renderHistory()
  } catch {
    historyData = null
    $('cleanup-history-list').replaceChildren()
    $('cleanup-history-count').textContent = '紀錄尚未載入'
    historyResult('暫時讀不到操作紀錄，請確認伺服器已啟動，再按「重新載入」。')
  } finally {
    historyBusy = false
    if (historyData) renderHistory()
    else historyControls()
  }
}
async function openHistory() {
  $('quaso-dialog').hidden = true
  $('quaso-stage').setAttribute('aria-expanded', 'false')
  $('cleanup-history-result').hidden = true
  if (!historyPanel.open) historyPanel.showModal()
  await refreshHistory()
}
$('quaso-history-open').onclick = openHistory
$('cleanup-history-close').onclick = () => historyPanel.close()
$('cleanup-history-refresh').onclick = () => {
  $('cleanup-history-result').hidden = true
  refreshHistory()
}
$('cleanup-history-prev').onclick = () => { historyOffset = Math.max(0, historyOffset - 20); refreshHistory() }
$('cleanup-history-next').onclick = () => { historyOffset += 20; refreshHistory() }
$('cleanup-history-undo').onclick = async () => {
  if (historyBusy || busy || !historySelected.size) return
  historyBusy = true
  const operationIds = [...historySelected]
  renderHistory()
  historyResult('正在復原勾選的模擬動作……')
  let message
  try {
    const response = await historyApi('undo', { operationIds })
    const currentDemo = demo ?? savedDemo
    if (currentOperation && response.operationIds.includes(currentOperation) && currentDemo?.canUndo) {
      currentDemo.undo()
      currentOperation = null
      $('cleanup-result').hidden = true
    }
    currentDemo?.restoreItems(response.restoredItems ?? [])
    updateAlert()
    if (panel.open && panel.dataset.mode === 'demo') render()
    message = `已復原 ${response.restored} 次模擬清理，共 ${response.restoredFiles} 個檔案。`
      + (response.alreadyRestored ? `另有 ${response.alreadyRestored} 筆先前已復原。` : '')
      + (demo ? `待清理清單目前有 ${demo.candidates.length} 個檔案，可點垃圾桶查看。` : '按 D 可開啟示範清單。')
    notice('已放回待清理清單，點垃圾桶就能看到。')
  } catch {
    message = '復原尚未確認完成，請重新載入紀錄後重試。'
  } finally {
    historyBusy = false
    await refreshHistory()
    historyResult(message)
  }
}


async function pollHealth() {
  if (healthBusy || stopped) return
  clearTimeout(healthTimer)
  healthBusy = true
  const retry = $('quaso-connection-retry')
  retry.disabled = true
  retry.textContent = '正在連線……'
  try {
    if (mockOffline) throw new Error('Mock backend offline')
    const response = await fetch('/health', { cache: 'no-store', signal: AbortSignal.timeout(4000) })
    if (!response.ok) throw new Error('health')
    const snapshot = await response.json()
    health = snapshot.ok ? snapshot : null
  } catch { health = null }
  healthChecked = true
  healthBusy = false
  retry.disabled = false
  retry.textContent = '重試連線'
  if (health) closeConnectionWarning()
  updateAlert()
  if (!stopped) healthTimer = setTimeout(pollHealth, 5000)
}
$('quaso-connection-retry').onclick = pollHealth
function closeConnectionWarning() {
  $('quaso-connection-warning').hidden = true
  $('quaso-worried').setAttribute('aria-expanded', 'false')
}
$('quaso-worried').onclick = () => {
  const open = $('quaso-connection-warning').hidden
  $('quaso-connection-warning').hidden = !open
  $('quaso-worried').setAttribute('aria-expanded', String(open))
  $('quaso-dialog').hidden = true
  $('quaso-stage').setAttribute('aria-expanded', 'false')
}
document.addEventListener('click', event => {
  if (!$('quaso-worried').contains(event.target) && !$('quaso-connection-warning').contains(event.target)) closeConnectionWarning()
})
$('quaso-connection-warning').addEventListener('keydown', event => {
  if (event.key === 'Escape') { closeConnectionWarning(); $('quaso-worried').focus() }
})
function toggleOffline() {
  if (healthBusy || busy || historyBusy) return
  mockOffline = !mockOffline
  updateMock()
  const url = new URL(location.href)
  if (mockOffline) url.searchParams.set('mockBackend', 'offline')
  else url.searchParams.delete('mockBackend')
  history.replaceState(null, '', url)
  pollHealth()
}
// D / O 在 Windows、macOS 相同；輸入中、IME、長按與組合鍵不觸發。
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229
    || event.ctrlKey || event.metaKey || event.altKey) return
  const target = event.target
  if (target instanceof Element && (target.closest('input, textarea, select, [role="textbox"], [role="combobox"]') || target.isContentEditable)) return
  const key = event.key.toLowerCase()
  if (key === 'd') { event.preventDefault(); toggleDemo() }
  if (key === 'o') { event.preventDefault(); toggleOffline() }
})
window.addEventListener('pagehide', () => { stopped = true; clearTimeout(healthTimer) }, { once: true })
pollHealth()
