import { createDemo } from './cleanup-demo-state.js'
import {
  setPetBaseState,
  setPetTransientState,
  clearPetTransientState,
  flashPetState,
} from './pet-state.js'
import {
  createReal, createRealHistory, safeName, formatBytes, applyMessage, undoMessage, historyUndoMessage, pendingPlanMessage,
  folderPhrase,
} from './cleanup-real-state.js'

const $ = id => document.getElementById(id)

document.addEventListener('quaso:statechange', event => {
  const text = $('pet-state-text')
  if (text) text.textContent = event.detail.state
})
// 頁面剛載入時先顯示目前 state
const petStateText = $('pet-state-text')
if (petStateText) {
  petStateText.textContent = $('quaso').dataset.petState || 'idle'
}

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

// ── 掃描問題（稽核第三輪 R3-12b）────────────────────────────────
//
// 「清理資料夾不存在、子資料夾打不開」這一類的話，以前只有 CLI 的 doctor 看得到：
// 面板照樣列清單、寵物照樣說「沒事，在發呆」，而工具其實一個檔都沒掃到。
// 帶 token 的 /health 就有 scanProblems（後端已經把完整路徑換成資料夾名），面板拿它來講。
// 示範模式不講：那時候畫面上是假的清單，掛真的警告只會讓人分不清在看什麼。

/** 寵物「沒事做」時的台詞。有掃描問題就換掉它。 */
const RESTING_BUBBLE = '今天吃可頌了嗎？'

/** 後端回報的掃描問題。名字是不可信的輸入 —— 後端已經擋過一次，這裡照樣 safeName。 */
function scanProblems() {
  const raw = health?.scanProblems
  if (isDemo() || !Array.isArray(raw)) return []
  return raw.filter(x => typeof x === 'string' && x).map(safeName)
}

const scanProblemText = probs =>
  `⚠ 上次掃描回報了 ${probs.length} 個問題，可能有檔案沒有掃到：${probs.join('；')}`

/**
 * 掃描問題畫到三個地方：面板頂端的提示、寵物的 stage title、寵物泡泡的靜止台詞。
 *
 * **對話框開著的時候不動泡泡** —— 那裡可能正顯示剛做完的結果（「都幫你放回來了！」）。
 * 輪詢每五秒跑一次，蓋掉它等於把使用者剛做的事洗掉。
 */
function renderScanProblems(probs = scanProblems()) {
  const note = $('cleanup-scan-problems')
  note.textContent = probs.length ? scanProblemText(probs) : ''
  note.hidden = probs.length === 0
  if ($('quaso-dialog').hidden) {
    $('quaso-status').textContent = probs.length ? scanProblemText(probs) : RESTING_BUBBLE
  }
}
function systemHealthProblem() {
  if (!healthChecked) return null

  // server 完全沒有回應
  if (!health) {
    return {
      type: 'offline',
      message: '暫時連不上 ContextBox。'
    }
  }

  // DB 故障
  if (health.db?.ok === false || health.ok === false) {
    return {
      type: 'db',
      message: 'ContextBox 資料庫暫時無法使用。'
    }
  }

  // watcher 沒有正常運作
  // 監看的資料夾真的不存在
  if ((health.watcher?.rootsMissing ?? 0) > 0) {
    return {
      type: 'watcher',
      message: '有清理資料夾不存在，請檢查設定。'
    }
  }

  // scanner 回報問題
  const probs = scanProblems()
  if (probs.length > 0) {
    return {
      type: 'scan',
      message: scanProblemText(probs)
    }
  }

  return null
}
function updateAlert() {
  const count = demo ? demo.candidates.length : health?.pendingCandidates
  $('quaso-candidate-count').textContent = count == null ? '—' : count > 99 ? '99+' : String(count)
  const source = demo ? '示範' : '本機'
  const label = count == null ? '候選數量尚未取得，點擊重試' : `${source}待清檔案 ${count} 個，點擊開啟清理面板`
  alertButton.setAttribute('aria-label', label)
  alertButton.title = label
  const problem = systemHealthProblem()
  const worried = Boolean(problem)

  alertButton.classList.toggle(
    'attention',
    count > 0 && !worried
  )

  if (worried) {
    clearPetTransientState()
    setPetBaseState('worried')
  } else {
    setPetBaseState(count > 0 ? 'found' : 'idle')
  }

$('quaso-worried').hidden = !worried
  // 資料夾名照後端說的（U4）：清理範圍不一定只有 Downloads，名字是不可信的輸入（folderPhrase 會 safeName）
  // 掃描出過問題就先講那件事（R3-12b）：「監看中」在一個檔都沒掃到的時候是在騙人
  const probs = scanProblems()
  $('quaso-stage').title = probs.length ? `⚠ 上次掃描有問題（${probs.length} 個） · 點我看說明`
    : health?.watcher?.ok ? `📁 ${folderPhrase(health.watcher, { quoted: false })} · 監看中` : '與可頌貓對話'
  renderScanProblems(probs)
  if (count > previousCount && !worried) {
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
$('cleanup-select-all').onclick = () => {
  if (busy) return

  const s = session()
  if (!s || s.canUndo || s.locked) return

  for (const item of s.candidates) {
    s.select(item.itemId, true)
  }

  request = null
  render()
}

$('cleanup-select-none').onclick = () => {
  if (busy) return

  const s = session()
  if (!s || s.canUndo || s.locked) return

  for (const item of s.candidates) {
    s.select(item.itemId, false)
  }

  request = null
  render()
}
$('cleanup-close').onclick = () => {
  panel.close()
  
}

panel.addEventListener('close', () => {
  clearPetTransientState() 
  if (!alertButton.hidden) alertButton.focus() 
})
historyPanel.addEventListener('close', () => {
  clearPetTransientState()
})
$('cleanup-dismiss').onclick = () => {
  if (busy) return
  panel.close()
  updateAlert()
  notice('好，這次先不清。今天吃可頌了嗎？')
}
/** 真的清理。訊息**一律照後端說的結果講**，不用勾選數去推算。 */
async function operateReal(kind) {
  if (kind === 'apply') {
    result(
      real.pendingPlan
        ? '正在繼續上次那份……'
        : real.locked
          ? '正在重試（沿用同一份，不會多搬）……'
          : '正在搬進隔離區……'
    )

    const r = await real.apply()

    if (r.status === 'stale') {
      result('清單在你看的時候更新了（例如有檔案被刪掉、或已經被別的地方清過）。一個都還沒動，請再確認一次勾選。')
      return false
    }

    if (r.status === 'pending-plan') {
      result(pendingPlanMessage(r.plan))
      return false
    }

    const m = applyMessage(r)
    result(m.text)
    notice(m.notice)

    return true
  }

  if (kind === 'release') {
    result('正在放棄上次那份……')

    const r = await real.release()

    result(
      `已放棄上次那份（${r.items.length} 個檔案），沒有動任何檔案。現在可以重新勾選再清理。`
      + (r.reloadFailed
        ? '\n（清單沒有重新整理成功。關掉面板再打開就會更新。）'
        : '')
    )

    // release 不是「完成清理」
    return false
  }

  if (kind === 'putback') {
    result('正在把已經搬走的放回原位……')

    const m = undoMessage(await real.putBack())
    result(m.text)
    notice(m.notice)

    return true
  }

  // undo
  result('正在放回原位……')

  const r = await real.undo()
  const m = undoMessage(r)

  result(m.text)
  notice(m.notice)

  return true
}
function seriousOperationError(error) {
  // createReal 已經判定操作結果不確定
  if (real?.uncertain) return true

  // 沒有 HTTP status：
  // fetch failed / timeout / server disconnected
  if (!error?.status) return true

  // server internal error
  if (error.status >= 500) return true

  return false
}
async function operate(kind) {
  if (busy) return

  busy = true

  // ① 操作開始
  if (kind === 'apply') {
    setPetTransientState('cleaning')
  } else if (kind === 'undo' || kind === 'putback') {
    setPetTransientState('restoring')
  }

  render()

  // ─────────────────────────────
  // REAL MODE
  // ─────────────────────────────
  if (!isDemo()) {
    try {
      const completed = await tracked(() => operateReal(kind))

      // ② 真的完成清理 / 復原才 happy
      if (completed) {
        setPetTransientState('happy')
      } else {
        clearPetTransientState()
      }

  } catch (error) {
    const serious = seriousOperationError(error)

    if (serious) {
      setPetTransientState('worried')
    } else {
      clearPetTransientState()
    }

    const lines = [safeName(error.message)]

    if (real.uncertain) {
      lines.push(
        !real.pendingPlan
          ? '結果還沒確認。按「再試一次」會沿用同一份，不會多搬。'
          : real.pendingPlan.started
            ? '結果還沒確認。再按一次「繼續上次那份」或「放回已經搬走的」都是安全的，不會多搬。'
            : '結果還沒確認。再按一次「繼續上次那份」或「放棄上次那份」都是安全的，不會多搬。'
      )
    }

    result(lines.join('\n'))
  } finally {
      busy = false
      render()
    }

    pollHealth()
    return
  }

  // ─────────────────────────────
  // DEMO MODE
  // ─────────────────────────────

  result(
    kind === 'apply'
      ? '正在模擬移入隔離區……'
      : '正在模擬復原……'
  )

  try {
    if (kind === 'apply') {
      const candidateIds = demo.candidates
        .filter(c => demo.selected.has(c.itemId))
        .flatMap(c => c.candidateIds)

      request ??= {
        requestId: crypto.randomUUID(),
        candidateIds
      }

      const saved = await demoHistoryApi('history', request)

      if (!saved.canUndo) {
        throw new Error('這次操作已在其他頁面復原，請重新示範。')
      }

      currentOperation = saved.id
      request = null

      const response = demo.apply()

      const message =
        `模擬清理完成：${response.quarantined} 個檔案，共 ${bytes(response.bytesFreed)} 已移入模擬隔離區。未勾選的檔案保留原樣。`

      result(message)
      notice('整理好了！想改變心意，隨時可以復原這次清理。')

      // cleaning → happy
      setPetTransientState('happy')

    } else {
      await demoHistoryApi('undo', {
        operationIds: [currentOperation]
      })

      const response = demo.undo()

      currentOperation = null

      result(
        `已模擬復原 ${response.restored} 個檔案，回到清理前的清單與勾選狀態。`
      )

      notice('都幫你放回來了！')

      // restoring → happy
      setPetTransientState('happy')
    }

    updateAlert()

  } catch (error) {
    clearPetTransientState()
    const lines = [safeName(error.message)]

    if (real.uncertain) {
      lines.push(
        !real.pendingPlan
          ? '結果還沒確認。按「再試一次」會沿用同一份，不會多搬。'
          : real.pendingPlan.started
            ? '結果還沒確認。再按一次「繼續上次那份」或「放回已經搬走的」都是安全的，不會多搬。'
            : '結果還沒確認。再按一次「繼續上次那份」或「放棄上次那份」都是安全的，不會多搬。'
      )
    }

    result(lines.join('\n'))
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

  // ① 開始復原
  setPetTransientState('restoring')

  const operationIds = [...historySelected]

  renderHistory()

  historyResult(
    demoEnabled
      ? '正在復原勾選的模擬動作……'
      : '正在把勾選的清理放回原位……'
  )

  let message

  try {
    const response = await tracked(() =>
      historyApi('undo', { operationIds })
    )

    if (!demoEnabled) {
      // ─────────────────────────
      // 真實模式
      // ─────────────────────────

      if (real && !real.locked) real = null

      if (panel.open && panel.dataset.mode === 'local') {
        panel.close()
      }

      pollHealth()

      const m = historyUndoMessage(response)

      message = m.text
      notice(m.notice)

    } else {
      // ─────────────────────────
      // Demo 模式
      // ─────────────────────────

      const currentDemo = demo ?? savedDemo

      if (
        currentOperation &&
        response.operationIds.includes(currentOperation) &&
        currentDemo?.canUndo
      ) {
        currentDemo.undo()
        currentOperation = null
        $('cleanup-result').hidden = true
      }

      currentDemo?.restoreItems(response.restoredItems ?? [])

      updateAlert()

      if (panel.open && panel.dataset.mode === 'demo') {
        render()
      }

      message =
        `已復原 ${response.restored} 次模擬清理，共 ${response.restoredFiles} 個檔案。`
        + (
          response.alreadyRestored
            ? `另有 ${response.alreadyRestored} 筆先前已復原。`
            : ''
        )
        + (
          demo
            ? `待清理清單目前有 ${demo.candidates.length} 個檔案，可點垃圾桶查看。`
            : '按 D 可開啟示範清單。'
        )

      notice('已放回待清理清單，點垃圾桶就能看到。')
    }

    // ② 復原 API 成功
    // restoring → happy → 2 秒後回 base state
    setPetTransientState('happy')

  } catch (error) {
  // ③ 復原失敗
  // 結果無法確認 → worried
  setPetTransientState('worried')

  console.error('History undo failed:', error)

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

  // 記住這次 health request 開始時的 action 世代。
  // 即使 timeout 發生時 action 已經結束，也能知道這次輪詢曾經和 action 重疊。
  const epochAtStart = actionEpoch

  try {
    if (mockOffline) {
      throw new Error('Mock backend offline')
    }

    const snapshot = await window.api('/health', {
      signal: AbortSignal.timeout(4000)
    })

    // Server 有明確回答就相信它。
    // 即使正在清理，ok:false 仍然是真正的 health 問題。
    health = snapshot
    healthChecked = true

  } catch {
    const overlappedWithAction =
      actionsInFlight > 0 ||
      actionEpoch !== epochAtStart

    if (!mockOffline && overlappedWithAction) {
      // P3：
      // 這次 health timeout 和清理／復原操作重疊，
      // 很可能只是 server 正忙，所以不能判定斷線。
      //
      // 刻意不改 health，也不改 healthChecked。
    } else {
      // 沒有任何面板操作干擾，這次 timeout 才算真的連不上。
      health = null
      healthChecked = true
    }

  } finally {
    healthBusy = false
    retry.disabled = false
    retry.textContent = '重試連線'
  }

  if (!systemHealthProblem()) {
    closeConnectionWarning()
  }

  updateAlert()

  if (!stopped) {
    healthTimer = setTimeout(pollHealth, 5000)
  }
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
// D / O / S 在 Windows、macOS 相同；輸入中、IME、長按與組合鍵不觸發。
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229
    || event.ctrlKey || event.metaKey || event.altKey) return
  const target = event.target
  if (target instanceof Element && (target.closest('input, textarea, select, [role="textbox"], [role="combobox"]') || target.isContentEditable)) return
  const key = event.key.toLowerCase()
  if (key === 's') {
    const debug = document.querySelector('#quaso .pet-state-debug')
    if (debug) { event.preventDefault(); debug.hidden = !debug.hidden }
  }
  if (key === 'd') { event.preventDefault(); toggleDemo() }
  if (key === 'o') { event.preventDefault(); toggleOffline() }
})
window.addEventListener('pagehide', () => { stopped = true; clearTimeout(healthTimer) }, { once: true })
pollHealth()
