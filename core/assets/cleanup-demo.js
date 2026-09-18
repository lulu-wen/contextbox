import { createDemo } from './cleanup-demo-state.js'
import { createReal, createRealHistory } from './cleanup-real-state.js'

const $ = id => document.getElementById(id)
const panel = $('cleanup-panel')
const alertButton = $('quaso-cleanup-alert')
let demo, savedDemo, data, busy = false, pending = null, demoEnabled = false
// 本機模式：接真的路由，會真的搬動 Downloads。介面跟 demo 一樣，渲染共用。
let real = null
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
const demoHistoryApi = (path, body) => window.api('/demo/cleanup/' + path,
  body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
const realHistory = createRealHistory((path, init) => window.api(path, init))
// 歷史面板兩個模式共用渲染：demo 開著看模擬紀錄，否則看真的可復原計畫
const historyApi = (path, body) => (demoEnabled ? demoHistoryApi : realHistory)(path, body)
const session = () => demo ?? real
const isDemo = () => Boolean(demo)
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
function applyLabel(s) {
  if (s.canUndo) return '完成本次清理'
  if (isDemo()) return '確認模擬清理'
  if (s.pendingPlan) return `繼續上次那份（${s.pendingPlan.items.length} 個）`
  if (s.locked) return '再試一次'
  return `清理勾選的 ${s.selected.size} 個檔案`
}
function summary() {
  updateAlert()
  const s = session()
  $('cleanup-summary').textContent = `已選 ${s.selected.size} / ${s.candidates.length} 個檔案 · ${bytes(s.bytes)}`
  // 鎖住（結果不明、或正在提示上次那份）時按鈕仍要能按 —— 它就是「再試一次」／「繼續」
  $('cleanup-apply').disabled = busy || (!s.canUndo && !s.locked && s.selected.size === 0)
  $('cleanup-apply').textContent = applyLabel(s)
  $('cleanup-undo').hidden = !s.canUndo
  $('cleanup-undo').disabled = busy
  $('cleanup-dismiss').hidden = s.canUndo
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
  const s = session()
  panel.dataset.mode = isDemo() ? 'demo' : 'local'
  $('cleanup-mode-note').textContent = isDemo()
    ? '示範模式 · 以下為範例檔案，清理與復原不會修改你的 Downloads。'
    : '本機模式 · 這些是你 Downloads 裡真的檔案。清理會把勾選的搬進隔離區，七天內可以復原。'
  $('cleanup-space-note').hidden = !isDemo()
  $('cleanup-apply').hidden = false
  $('cleanup-reset').hidden = !isDemo()   // 「重新示範」只有 demo 有意義
  for (const id of ['cleanup-undo', 'cleanup-dismiss']) $(id).hidden = false
  $('cleanup-list').replaceChildren()
  for (const item of s.candidates) {
    const card = document.createElement('article')
    card.className = 'cleanup-file'
    const label = document.createElement('label')
    const check = document.createElement('input')
    check.type = 'checkbox'
    check.checked = s.selected.has(item.itemId)
    // 結果不明時要鎖住：改了勾選就會撞上自己剛建的那份計畫
    check.disabled = busy || s.canUndo || Boolean(s.locked)
    check.onchange = () => { s.select(item.itemId, check.checked); request = null; summary() }
    const name = document.createElement('strong')
    name.textContent = item.name
    label.append(check, name)
    card.append(label, paragraph(`${[item.folder, item.subdir].filter(Boolean).join('/')} · ${bytes(item.bytes)} · 信心 ${item.confidence}%`))
    for (const reason of item.reasons) {
      card.append(paragraph(reason.reason), paragraph(reason.evidence, 'evidence'))
    }
    if (item.vetoed) card.append(paragraph('⚠ ' + item.vetoed, 'evidence'))
    $('cleanup-list').append(card)
  }
  if (!s.candidates.length) $('cleanup-list').append(paragraph(isDemo() ? '這批候選檔案已全部處理。' : '目前沒有待清檔案。'))
  $('cleanup-needs-human').replaceChildren()
  for (const item of (isDemo() ? data.needsHuman : s.needsHuman) ?? []) {
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
  // 本機模式：真的清理。模擬的資料與真的資料**永遠不混用** ——
  // demo 開著走 demo，否則走 createReal，兩者是不同的物件。
  panel.dataset.mode = 'local'
  for (const id of ['cleanup-apply', 'cleanup-undo', 'cleanup-dismiss', 'cleanup-reset', 'cleanup-space-note']) $(id).hidden = true
  $('cleanup-result').hidden = true
  $('cleanup-list').replaceChildren(paragraph('正在讀取候選檔案……'))
  $('cleanup-needs-human').replaceChildren()
  $('cleanup-summary').textContent = ''
  if (!panel.open) panel.showModal()
  // 每次打開都是新的一輪 —— **除非上一輪結果還不明**。那時候丟掉就會撞上
  // 自己剛建的那份計畫，要保留下來讓使用者「再試一次」。
  if (!real || !real.locked) real = createReal((path, init) => window.api(path, init))
  try {
    await real.load()
    render()
    if (real.locked) result('上一次清理的結果還沒確認。按「再試一次」會沿用同一份，不會多搬。')
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
/** 真的清理。訊息**一律照後端說的結果講**，不用勾選數去推算。 */
async function operateReal(kind) {
  if (kind === 'apply') {
    result(real.pendingPlan ? '正在繼續上次那份……' : real.locked ? '正在重試（沿用同一份，不會多搬）……' : '正在搬進隔離區……')
    const r = await real.apply()
    if (r.status === 'stale') {
      result('清單在你看的時候更新了（例如有檔案被刪掉、或已經被別的地方清過）。一個都還沒動，請再確認一次勾選。')
      return
    }
    if (r.status === 'pending-plan') {
      const names = r.plan.items.map(i => i.name).join('、')
      result(`上次有一份清理沒做完：${names}（${r.plan.items.length} 個）。`
        + '按「繼續上次那份」會處理它 —— 只會動這幾個，不會動到你現在勾的其他檔案。')
      return
    }
    const lines = [`搬進隔離區 ${r.moved} 個檔案，${bytes(r.bytesFreed)}。七天內可以復原。`]
    if (r.failed.length) {
      lines.push(`有 ${r.failed.length} 個沒搬（原檔都還在原位，沒有任何東西被刪除）：`)
      for (const f of r.failed) lines.push(`・${f.name} —— ${f.why}`)
    }
    result(lines.join('\n'))
    notice(r.moved ? '整理好了！想改變心意，隨時可以復原這次清理。' : '這次一個都沒搬成，原因寫在面板上。')
  } else {
    const r = await real.undo()
    // 只講發生了什麼。**不講「之後不會再被提議」**：之後符合新的理由會再出現；
    // 原位置被佔時放回來的那份會改名，重掃後以重複檔的身分被預設勾起來。
    const lines = [`放回 Downloads ${r.restored} 個檔案。`]
    for (const x of r.renamed) {
      lines.push(`・${x.name} 的原位置已經有同名檔案，放回來的這份叫 ${x.restoredAs}（沒有覆蓋任何檔案）。`)
    }
    if (r.failed.length) lines.push(`有 ${r.failed.length} 個還在隔離區，可以從「復原最近動作」再試一次。`)
    result(lines.join('\n'))
    notice('都幫你放回來了！')
  }
  pollHealth()   // 徽章數字馬上更新，不用等五秒
}

async function operate(kind) {
  if (busy) return
  busy = true
  render()
  if (!isDemo()) {
    try { await operateReal(kind) }
    catch (error) {
      result(error.message + (real.locked ? '\n結果還沒確認。按「再試一次」會沿用同一份，不會多搬。' : ''))
    } finally {
      busy = false
      render()
    }
    return
  }
  result(kind === 'apply' ? '正在模擬移入隔離區……' : '正在模擬復原……')
  try {
    if (kind === 'apply') {
      const candidateIds = demo.candidates.filter(c => demo.selected.has(c.itemId)).flatMap(c => c.candidateIds)
      request ??= { requestId: crypto.randomUUID(), candidateIds }
      const saved = await demoHistoryApi('history', request)
      if (!saved.canUndo) throw new Error('這次操作已在其他頁面復原，請重新示範。')
      currentOperation = saved.id
      request = null
      const response = demo.apply()
      const message = `模擬清理完成：${response.quarantined} 個檔案，共 ${bytes(response.bytesFreed)} 已移入模擬隔離區。未勾選的檔案保留原樣。`
      result(message)
      notice('整理好了！想改變心意，隨時可以復原這次清理。')
    } else {
      await demoHistoryApi('undo', { operationIds: [currentOperation] })
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
  if (session().canUndo) {
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
  historyResult(demoEnabled ? '正在復原勾選的模擬動作……' : '正在把勾選的清理放回原位……')
  let message
  try {
    const response = await historyApi('undo', { operationIds })
    if (!demoEnabled) {
      // 真的復原：檔案回到原位，但**不會回到清理清單**（A 的規則：復原過就代表想留著）。
      // 目前這一輪若不是結果不明，就丟掉，下次打開面板重新載入。
      if (real && !real.locked) real = null
      if (panel.open && panel.dataset.mode === 'local') panel.close()
      pollHealth()
      message = `已復原 ${response.restored} 次清理，共 ${response.restoredFiles} 個檔案放回 Downloads。`
        + (response.alreadyRestored ? `另有 ${response.alreadyRestored} 筆先前已復原。` : '')
        + (response.renamed?.length
          ? `其中 ${response.renamed.map(x => `${x.name} → ${x.restoredAs}`).join('、')}（原位置已經有同名檔案，沒有覆蓋）。`
          : '')
      notice('都幫你放回來了！')
    } else {
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
    }
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
