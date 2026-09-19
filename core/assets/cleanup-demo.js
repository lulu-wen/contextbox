import { createDemo } from './cleanup-demo-state.js'
import {
  createReal, createRealHistory, safeName, formatBytes, applyMessage, undoMessage, historyUndoMessage, pendingPlanMessage,
  folderPhrase,
} from './cleanup-real-state.js'

const $ = id => document.getElementById(id)
const panel = $('cleanup-panel')
const alertButton = $('quaso-cleanup-alert')
let demo, savedDemo, data, busy = false, pending = null, demoEnabled = false
// 本機模式：接真的路由，會真的搬動監看資料夾（cleanup.roots）裡的檔案。介面跟 demo 一樣，渲染共用。
let real = null
let currentOperation = null, request = null, health = null, previousCount = 0, healthTimer
let healthChecked = false, healthBusy = false, stopped = false
/**
 * 面板自己送出、還沒回來的動作（清理、復原、放回、放棄、歷史面板的復原）。
 * 套用與復原在 server 的主執行緒上同步跑：一次搬幾百個檔，那段時間 /health 也等不到回應。
 * 稽查實測 800 個檔的套用要 27 秒，以前 4 秒後寵物就切成擔心、跳出斷線泡泡（稽核第二輪 C-f14）。
 * actionEpoch 在動作開始與結束時各加一：輪詢期間它變過，就代表這次輪詢跟動作重疊過。
 */
let actionsInFlight = 0, actionEpoch = 0
async function tracked(fn) {
  actionsInFlight++
  actionEpoch++
  try { return await fn() }
  finally { actionsInFlight--; actionEpoch++ }
}
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
const bytes = formatBytes
// 歷史面板的說明跟著模式走（稽核 RC10）。本機模式以前也寫著「模擬…不會更動真實檔案」——
// 那是在騙人：本機的復原會真的把檔案放回原位。
const HISTORY_NOTE = {
  demo: '模擬操作紀錄 · 每次清理為一筆，勾選後會復原該次全部檔案。不會更動真實檔案。',
  local: '每次清理為一筆，勾選後會把那一次搬走的檔案放回原位。',
}

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
  // 資料夾名照後端說的（U4）：清理範圍不一定只有 Downloads，名字是不可信的輸入（folderPhrase 會 safeName）
  $('quaso-stage').title = health?.watcher?.ok ? `📁 ${folderPhrase(health.watcher, { quoted: false })} · 監看中` : '與可頌貓對話'
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
  // 撞到擋住的那份時的第二個出口（RC8）：放棄它，不動任何檔。
  // **開始過的那份不給放棄**（後端一定回 409，R2-5b），改給「放回已經搬走的」
  const started = Boolean(s.pendingPlan?.started)
  $('cleanup-release').hidden = isDemo() || !s.pendingPlan || started
  $('cleanup-release').disabled = busy
  $('cleanup-putback').hidden = isDemo() || !started
  $('cleanup-putback').disabled = busy
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
/** 面板最上面那一句。本機模式講真的資料夾名（U4），拿不到就講「監看資料夾」。 */
function modeNote() {
  $('cleanup-mode-note').textContent = isDemo()
    ? '示範模式 · 以下為範例檔案，清理與復原不會動到你電腦上真的檔案。'
    : `本機模式 · 這些是你${folderPhrase(health?.watcher)}裡真的檔案。清理會把勾選的搬進隔離區，七天內可以復原。`
}
function render() {
  const s = session()
  panel.dataset.mode = isDemo() ? 'demo' : 'local'
  modeNote()
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
    name.textContent = safeName(item.name)
    label.append(check, name)
    // 卡片上的每一段都走 safeName（U5）：evidence 會帶檔名（「檔名是 …」「會留著「…」」），
    // folder／subdir 是資料夾名 —— 都是不可信的輸入，U+2028 在 white-space: normal 下也會斷行、偽造一行。
    const where = [item.folder, item.subdir].filter(Boolean).map(safeName).join('/')
    card.append(label, paragraph(`${where} · ${bytes(item.bytes)} · 信心 ${item.confidence}%`))
    for (const reason of item.reasons) {
      card.append(paragraph(safeName(reason.reason)), paragraph(safeName(reason.evidence), 'evidence'))
    }
    if (item.vetoed) card.append(paragraph('⚠ ' + safeName(item.vetoed), 'evidence'))
    $('cleanup-list').append(card)
  }
  if (!s.candidates.length) $('cleanup-list').append(paragraph(isDemo() ? '這批候選檔案已全部處理。' : '目前沒有待清檔案。'))
  $('cleanup-needs-human').replaceChildren()
  for (const item of (isDemo() ? data.needsHuman : s.needsHuman) ?? []) {
    $('cleanup-needs-human').append(paragraph(`需要你查看：${safeName(item.name)} — ${safeName(item.why)}（未列入清理）`))
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
  // 兩個面板都關掉：開著的那個是另一個模式的資料（歷史面板的說明與復原也跟著模式走）
  panel.close()
  historyPanel.close()
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
  modeNote()
  for (const id of ['cleanup-apply', 'cleanup-undo', 'cleanup-release', 'cleanup-putback', 'cleanup-dismiss', 'cleanup-reset', 'cleanup-space-note']) $(id).hidden = true
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
    // 有待處理的計畫就一打開先提示（R2-5）。查不到就照常，撞到 CONFLICT 仍是入口
    await real.checkPending()
    render()
    if (real.pendingPlan && !real.uncertain) result(pendingPlanMessage(real.pendingPlan))
    else if (real.locked) result('上一次清理的結果還沒確認。按「再試一次」會沿用同一份，不會多搬。')
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
      result(pendingPlanMessage(r.plan))
      return
    }
    const m = applyMessage(r)
    result(m.text)
    notice(m.notice)
  } else if (kind === 'release') {
    result('正在放棄上次那份……')
    const r = await real.release()
    result(`已放棄上次那份（${r.items.length} 個檔案），沒有動任何檔案。現在可以重新勾選再清理。`
      + (r.reloadFailed ? '\n（清單沒有重新整理成功。關掉面板再打開就會更新。）' : ''))
  } else if (kind === 'putback') {
    // 做到一半中斷的那份：把已經在隔離區的放回原位，還沒搬的不動（R2-5b）
    result('正在把已經搬走的放回原位……')
    const m = undoMessage(await real.putBack())
    result(m.text)
    notice(m.notice)
  } else {
    result('正在放回原位……')
    const r = await real.undo()
    // 只講發生了什麼。**不講「之後不會再被提議」**：之後符合新的理由會再出現；
    // 原位置被佔時放回來的那份會改名，重掃後以重複檔的身分被預設勾起來。
    // 寵物的話也看結果：全部放回、部分放回、一個都沒放回，三種不同的話（RC9）。
    const m = undoMessage(r)
    result(m.text)
    notice(m.notice)
  }
}

async function operate(kind) {
  if (busy) return
  busy = true
  render()
  if (!isDemo()) {
    try { await tracked(() => operateReal(kind)) }
    catch (error) {
      // 伺服器明確回的錯（有 status）結果是確定的：只講原因，勾選照樣可以改（RC8）。
      // 只有網路斷了才是「結果不明」。
      const lines = [safeName(error.message)]
      if (real.uncertain) {
        lines.push(!real.pendingPlan ? '結果還沒確認。按「再試一次」會沿用同一份，不會多搬。'
          : real.pendingPlan.started ? '結果還沒確認。再按一次「繼續上次那份」或「放回已經搬走的」都是安全的，不會多搬。'
          : '結果還沒確認。再按一次「繼續上次那份」或「放棄上次那份」都是安全的，不會多搬。')
      }
      result(lines.join('\n'))
    } finally {
      busy = false
      render()
    }
    pollHealth()   // 徽章數字馬上更新，不用等五秒（動作已經結束，這次輪詢的結果照常算數）
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
  else return operate('apply')
}
$('cleanup-undo').onclick = () => operate('undo')
$('cleanup-release').onclick = () => operate('release')
$('cleanup-putback').onclick = () => operate('putback')
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
    card.append(label, paragraph(operation.items.map(i => safeName(i.name)).join('、')),
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
  $('cleanup-history-note').textContent = demoEnabled ? HISTORY_NOTE.demo : HISTORY_NOTE.local
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
    const response = await tracked(() => historyApi('undo', { operationIds }))
    if (!demoEnabled) {
      // 真的復原：檔案回到原位，但**不會回到清理清單**（A 的規則：復原過就代表想留著）。
      // 目前這一輪若不是結果不明，就丟掉，下次打開面板重新載入。
      if (real && !real.locked) real = null
      if (panel.open && panel.dataset.mode === 'local') panel.close()
      pollHealth()
      // 放回幾個、沒放回哪幾個（附原因）照轉接器算好的講；寵物的話也看結果（RC9）。
      // 以前不管結果一律說「都幫你放回來了」—— 一個都沒放回的時候也是。
      const m = historyUndoMessage(response)
      message = m.text
      notice(m.notice)
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
  const epoch = actionEpoch
  let settled = true
  try {
    if (mockOffline) throw new Error('Mock backend offline')
    // 帶 token 問（window.api 會帶）：資料夾名（watcher.watching）只給帶 token 的（U4）
    const snapshot = await window.api('/health', { signal: AbortSignal.timeout(4000) })
    // 後端回了話（包括說自己壞了的 ok: false）就是結論，動作在不在跑都一樣
    health = snapshot.ok ? snapshot : null
  } catch {
    // **沒回應**（逾時、連不上）的時候，面板自己的動作在這次輪詢期間跑過（開始時就在跑、或中途開始／結束）
    // → 多半是 server 正忙著搬檔，這次不算數，寵物維持上一次的樣子；動作結束之後的輪詢照常算（稽核 C-f14）。
    // 模擬離線（按 O）照樣算數。
    if (!mockOffline && (actionsInFlight > 0 || epoch !== actionEpoch)) settled = false
    else health = null
  }
  if (settled) healthChecked = true
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
