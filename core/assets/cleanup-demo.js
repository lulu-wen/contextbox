import { createDemo } from './cleanup-demo-state.js'
import {
  setPetBaseState,
  setPetTransientState,
  clearPetTransientState,
  flashPetState,
  setPetMessageData,
} from './pet-state.js'
import {
  createReal, createRealHistory, safeName, formatBytes, applyMessage, undoMessage, historyUndoMessage, pendingPlanMessage,
  folderPhrase, createBursts, applyBurstDefaults, burstAskMessage, burstGroupLine, burstNote,
  modelOpinionLines, createRenames, renameLines, createFilings, filingLines,
  createLearned, learnedLines,
  createSettings, settingLabel,
  createPreviews, previewLines, plural,
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
// 連拍截圖（P0）：組與縮圖。示範模式不用它（那時畫面上是假的清單）。
const bursts = createBursts((path, init) => window.api(path, init))
// 建議的名字（P3）：模型看得出內容、但檔名沒取名的檔。示範模式不用它（同上）。
// **一個都不預設勾**：改名只有 renames 那一份紀錄救得回來，不像清理還有隔離區。
const renames = createRenames((path, init) => window.api(path, init))
// 歸檔建議（P4）：模型看得出是哪一堂課的檔。示範模式不用它（同上）。
// **一個都不預設勾**：搬家比改名更容易讓人找不到檔，只有 filings 那一份紀錄救得回來。
const filings = createFilings((path, init) => window.api(path, init))
// 它學到的事（P5）：使用者改過的課名與類型。示範模式不用它（同上）。
// **這一區按不出任何會動檔案的事** —— 只看得到與「忘掉」。
const learned = createLearned((path, init) => window.api(path, init))
// 設定（2026-09-20）：面板裡改 `~/.contextbox/config.json` 的五個欄位。示範模式不用它（同上）。
// **只在打開面板那一刻讀一次**，不進輪詢 —— 輪詢重讀會把使用者正在打的字洗掉。
const settings = createSettings((path, init) => window.api(path, init))
// 正在送 PATCH /settings。這段期間「儲存」要按不下去：連按兩下就是送兩次寫檔。
let settingsSaving = false
// 這一次 render() 是**背景輪詢**叫的（refreshSuggestions 發現別的區變了）。
// 設定區看這個旗子決定要不要讓開，見 renderSettings —— 別的呼叫端一律照常重畫。
let pollRedraw = false
// 上一次 /pet/state 說的「還沒問過的組數」。**只在它變大的時候主動彈**，見 askAboutBursts。
const burstAsked = new Set()   // 主動問過的連拍組 id（不是數量：數量當高水位會安靜地漏問）
let currentOperation = null, request = null, health = null, previousCount = 0, healthTimer
/** 後端說的「正在讀嗎、還剩幾個」（/pet/state 的 reading）。舊版後端沒有這一段就是全 0。 */
let reading = { running: false, pending: 0 }
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
let cleanupPage = 0
const cleanupPageSize = 10
// 「先不清」只動這一輪的提案：不送後端的 dismiss，也不碰任何檔案。
const skippedOperations = []
const proposalSkips = () => skippedOperations.filter(op => op.demo === demoEnabled)
const localHistory = () => proposalSkips().filter(op => !op.pending)
function proposalRows(s) {
  const committed = new Set(localHistory().flatMap(op => op.items.map(item => item.itemId)))
  return s.candidates.filter(item => !committed.has(item.itemId))
}
function proposalItems(s) {
  const hidden = new Set(proposalSkips().flatMap(op => op.items.map(item => item.itemId)))
  for (const id of hidden) s.select(id, false)
  return s.candidates.filter(item => !hidden.has(item.itemId))
}
/**
 * 只清這一個檔。
 *
 * **不是另一條路**：把勾選換成「只有它」，然後走跟總按鈕一模一樣的 operate('apply') ——
 * 建計畫、寫 journal、逐項結果、可復原，一個環節都不跳過。
 * 做不成的話把使用者原本的勾選放回去（他可能勾了一堆，只是想先清這一個）。
 */
async function cleanOne(s, item) {
  if (busy || s.canUndo || s.locked) return
  const before = new Set(s.selected)
  for (const id of before) s.select(id, false)
  s.select(item.itemId, true)
  render()
  await operate('apply')
  // 還在清單上（沒搬成）就把原本的勾選還原 —— 搬成了的話那一列已經不在了
  if (session().candidates.some(c => c.itemId === item.itemId)) {
    const now = session()
    now.select(item.itemId, false)
    for (const id of before) now.select(id, true)
    render()
  }
}

/**
 * 只改這一個名字／只歸檔這一個檔。
 *
 * 跟 cleanOne 同一個形狀，理由也一樣：清單上有五十列的時候，為了處理一個檔
 * 而滑到最底下按總按鈕是很糟的體驗（使用者自己講的，2026-09-20）。
 *
 * **不是另一條路**：把勾選換成「只有它」，走跟總按鈕一模一樣的 operate('apply') ——
 * 送的還是後端那條 `/rename/apply`／`/file/apply`，逐項結果、可復原，一個環節都不跳過。
 *
 * 做不成的話（那一列還在）把使用者原本的勾選放回去：他可能勾了一堆，只是想先處理這一個。
 * 注意 store 的 apply() 自己會把 selected 清空並重載，所以這裡是**重新勾回去**，不是還原。
 */
async function oneOf(store, operate, item) {
  if (busy || isDemo()) return
  const before = new Set(store.selected)
  for (const id of before) store.select(id, false)
  store.select(item.itemId, true)
  render()
  await operate('apply')
  // 還在清單上 ＝ 沒做成。做成了的話那一列已經不見了，勾選也不用還
  if (store.items.some(i => i.itemId === item.itemId)) {
    store.select(item.itemId, false)
    for (const id of before) store.select(id, true)
    render()
  }
}

function skipItem(s, item) {
  if (busy || s.canUndo || s.locked) return
  let op = proposalSkips().find(op => op.pending && op.owner === s)
  if (!op) {
    op = { id: 'skip-' + crypto.randomUUID(), owner: s, demo: demoEnabled, kind: 'skip', pending: true,
      createdAt: new Date().toISOString(), items: [], canUndo: true, itemCount: 0, bytes: 0 }
    skippedOperations.unshift(op)
  }
  if (!op.items.some(i => i.itemId === item.itemId)) op.items.push({ ...item, wasSelected: s.selected.has(item.itemId) })
  op.itemCount = op.items.length
  op.bytes = op.items.reduce((sum, i) => sum + i.bytes, 0)
  s.select(item.itemId, false)
  request = null
  render()
}
// UI 顯示用：把控制字元替換成可見的「·」，避免不可信文字偽造換行，
// 同時保留「這裡原本有異常字元」的資訊。
function uiSafeName(value) {
  return safeName(value)
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, '·')
}

// 理由裡的行話換成人話。規則那一側寫的是「N other files have the same sha256」——
// 對不寫程式的人，sha256 只是一串沒有意義的字。
function reasonText(text) {
  return uiSafeName(text)
    .replace(/(\d+) other files? (?:has|have) the same sha256/gi,
      (_, n) => `${n} other file${n === '1' ? '' : 's'} ${n === '1' ? 'has' : 'have'} exactly the same contents`)
    .replace(/sha256/gi, 'content fingerprint')
}
let badgeRequest = 0
function setHistoryBadge(total) {
  $('quaso-history-count').textContent = String(total)
  $('quaso-history-open').setAttribute('aria-label', `Undo recent actions (${plural(total, 'action')})`)
}
async function refreshHistoryBadge() {
  const version = ++badgeRequest
  try {
    const data = await historyApi('history?offset=0&limit=1')
    if (version === badgeRequest) setHistoryBadge(data.total)
  } catch {
    if (version === badgeRequest) $('quaso-history-count').textContent = '—'
  }
}
const historySelected = new Set()
const demoHistoryApi = (path, body) => window.api('/demo/cleanup/' + path,
  body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
const realHistory = createRealHistory((path, init) => window.api(path, init))
// 歷史面板兩個模式共用渲染：demo 開著看模擬紀錄，否則看真的可復原計畫
const historyApi = async (path, body) => {
  const api = demoEnabled ? demoHistoryApi : realHistory
  if (!path.startsWith('history') || body !== undefined) return api(path, body)
  const params = new URLSearchParams(path.split('?')[1])
  const offset = Number(params.get('offset') ?? 0), limit = Number(params.get('limit') ?? 20)
  const local = localHistory()
  const page = await api(`history?offset=${Math.max(0, offset - local.length)}&limit=${limit}`)
  return { ...page, offset, limit, total: page.total + local.length,
    operations: [...local.slice(offset, offset + limit), ...page.operations].slice(0, limit) }
}
const session = () => demo ?? real
const isDemo = () => Boolean(demo)
const bytes = formatBytes
// 歷史面板的說明跟著模式走（稽核 RC10）。本機模式以前也寫著「模擬…不會更動真實檔案」——
// 那是在騙人：本機的復原會真的把檔案放回原位。
const HISTORY_NOTE = {
  demo: 'Simulated action log · one row per cleanup. Tick one and every file from that cleanup comes back. No real file is touched.',
  local: 'One row per cleanup. Tick one and the files it moved go back where they were.',
}

/**
 * 寵物說一句。burst 為 true 時多給一顆「看看這幾張」（點下去打開連拍區）。
 *
 * 泡泡平常寫的是「狀態算出來的那一句」（getPetMessage，見 ui.html 的 renderPetMessage）。
 * notice 講的是狀態算不出來的事 —— 連拍的主動詢問、這一次動作的逐項結果。
 * dataset.notice 讓渲染那一支在狀態沒變的期間不要把它蓋掉；狀態一變就換回去。
 */
function notice(message, { burst = false } = {}) {
  $('quaso-status').dataset.notice = '1'
  $('quaso-status').textContent = message
  $('quaso-burst-open').hidden = !burst
  $('quaso-dialog').hidden = false
  $('quaso-stage').setAttribute('aria-expanded', 'true')
}

// ── 掃描問題（稽核第三輪 R3-12b）────────────────────────────────
//
// 「清理資料夾不存在、子資料夾打不開」這一類的話，以前只有 CLI 的 doctor 看得到：
// 面板照樣列清單、寵物照樣說「沒事，在發呆」，而工具其實一個檔都沒掃到。
// 帶 token 的 /health 就有 scanProblems（後端已經把完整路徑換成資料夾名），面板拿它來講。
// 示範模式不講：那時候畫面上是假的清單，掛真的警告只會讓人分不清在看什麼。
//
// 泡泡那一側現在歸 systemHealthProblem() → worried 狀態管（隊友那一側）：
// 掃描出過問題寵物就是擔心臉，話裡帶得出是哪一種問題。這裡只負責面板頂端那一條與 stage title。

/** 後端回報的掃描問題。名字是不可信的輸入 —— 後端已經擋過一次，這裡照樣 safeName。 */
function scanProblems() {
  const raw = health?.scanProblems
  if (isDemo() || !Array.isArray(raw)) return []
  return raw.filter(x => typeof x === 'string' && x).map(safeName)
}

const scanProblemText = probs =>
  `⚠ The last scan reported ${probs.length} problems, so some files may have been missed: ${probs.join('; ')}`

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
}
function systemHealthProblem() {
  if (!healthChecked) return null

  // server 完全沒有回應
  if (!health) {
    return {
      type: 'offline',
      message: 'cannot reach ContextBox right now.'
    }
  }

  // DB 故障
  if (health.db?.ok === false || health.ok === false) {
    return {
      type: 'db',
      message: 'the ContextBox database is not available right now.'
    }
  }

  // watcher 沒有正常運作
  // 監看的資料夾真的不存在
  if ((health.watcher?.rootsMissing ?? 0) > 0) {
    return {
      type: 'watcher',
      message: 'a cleanup folder is not there. Check the settings.'
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
  // 後端有回話、而且沒說自己壞掉，才算連得上。
  // （health 現在存的是原始快照，ok:false 也留著讓 systemHealthProblem 講得出是哪裡壞。）
  const offline = healthChecked && (!health || health.ok === false)
  const count = demo ? demo.candidates.length : health?.pendingCandidates
  $('quaso-candidate-count').textContent = count == null ? '—' : count > 99 ? '99+' : String(count)
  const source = demo ? 'demo' : 'local'
  const label = count == null ? 'Candidate count not available yet — click to retry' : `${plural(count, source + ' file')} waiting to be cleaned up — click to open the cleanup panel`
  alertButton.setAttribute('aria-label', label)
  alertButton.title = label
  const problem = systemHealthProblem()
  const worried = Boolean(problem)
  if (!busy && !historyBusy) setPetMessageData({
    candidateCount: count ?? 0,
    candidates: session() ? proposalItems(session()) : [],
    ...(problem ? { errorMessage: problem.message } : {})
  })

  alertButton.classList.toggle(
    'attention',
    count > 0 && !worried
  )

  if (worried) {
    clearPetTransientState()
    setPetBaseState('worried')
  } else if (reading.running) {
    // `thinking` 以前是死狀態（宣告了、有台詞、但全樹沒有任何地方會設它）。
    // 模型一個檔十幾秒、幾百個檔要幾小時 —— 使用者最需要知道的就是「它到底有沒有在動」。
    setPetBaseState('thinking')
  } else {
    setPetBaseState(count > 0 ? 'found' : 'idle')
  }

  // 資料夾名照後端說的（U4）：清理範圍不一定只有 Downloads，名字是不可信的輸入（folderPhrase 會 safeName）
  // 掃描出過問題就先講那件事（R3-12b）：「監看中」在一個檔都沒掃到的時候是在騙人
  const probs = scanProblems()
  $('quaso-stage').title = probs.length ? `⚠ The last scan hit ${probs.length} problems · click for details`
    : health?.watcher?.ok ? `📁 Watching ${folderPhrase(health.watcher, { quoted: false })}` : 'Talk to Quaso'
  renderScanProblems(probs)
  if (count > previousCount && !worried) {
    $('quaso-stage').classList.remove('found-hop')
    void $('quaso-stage').offsetWidth
    $('quaso-stage').classList.add('found-hop')
  }
  previousCount = count ?? 0
  // 檔案管理那一塊（P6）：同一份資料，只是換一個使用者找得到的位置
  $('files-candidate-count').textContent = count == null ? 'Looking…' : plural(count, 'file')
  $('files-where').textContent = demo
    ? 'Demo mode · the two panels below open a sample list. Nothing real on your computer gets touched.'
    : offline ? 'Cannot reach the local service right now. Start the server and this updates itself.'
    : health?.watcher?.ok ? `Watching ${folderPhrase(health.watcher)}.`
    : 'Not watching anything yet.'
  renderReading()
}

/**
 * 「它現在在讀檔案嗎、還剩幾個」。
 *
 * 少了這一行，使用者看到「Suggested names 0」分不出兩件完全不同的事：
 * **還沒輪到它**（模型一個檔十幾秒，幾百個檔要幾小時）與**它根本沒在動**。
 * 後者才需要動手，前者只要等 —— 但畫面上長得一模一樣。
 */
function renderReading() {
  const line = $('files-reading')
  if (!line) return
  if (isDemo() || !reading.pending) { line.hidden = true; return }
  line.hidden = false
  line.textContent = reading.running
    ? `Reading your files… ${reading.pending >= 500 ? '500+' : reading.pending} still to go.`
    : `${reading.pending >= 500 ? '500+' : plural(reading.pending, 'file')} not read yet — it works through them in the background.`
}
function announce() {
  updateAlert()
}
function applyLabel(s) {
  if (s.canUndo) return 'Cleanup done'
  if (isDemo()) return 'Run the simulated cleanup'
  if (s.pendingPlan) return `Finish the last plan (${s.pendingPlan.items.length})`
  if (s.locked) return 'Try again'
  return `Clean up ${plural(s.selected.size, 'selected file')}`
}
function summary() {
  updateAlert()
  const s = session()
  // 「先不清」的那幾個這一輪不算數：不進分母，也不算大小
  const candidates = proposalItems(s)
  const selected = candidates.filter(item => s.selected.has(item.itemId))
  $('cleanup-summary').textContent = `${selected.length} of ${candidates.length} files selected`
    + ` · ${bytes(selected.reduce((sum, item) => sum + item.bytes, 0))}`
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
/**
 * 把「模型認為⋯⋯」掛到一張卡片（或一張縮圖）上（P2）。沒有看法就什麼都不加。
 *
 * **只加字，不碰勾選框**（預想的不變量 4）：模型說了不代表要清、要改名。
 * 示範答案多一個 class，樣式上看得出來那不是真的問過的。
 */
function appendModelOpinion(node, model) {
  const lines = modelOpinionLines(model)
  if (!lines) return
  const head = paragraph(lines.head, lines.seeded ? 'cleanup-model cleanup-model-seeded' : 'cleanup-model')
  node.append(head, paragraph(lines.note, 'evidence'))
}
// -- 看內容（P6）---------------------------------------------
//
// 每一列多一顆「看內容」，點開在**同一列底下**展開（不是彈窗：彈窗會蓋住勾選框，
// 而使用者正是為了決定要不要勾才點開的），再點一次收起。
//
// **點了才抓**、同一個檔只抓一次（createPreviews 負責）。示範模式沒有這顆按鈕 ——
// 那時候畫面上是假的清單，後端根本沒有那幾個檔，點下去只會拿到 404。
const previews = createPreviews((path, init) => window.api(path, init))
const previewOpen = new Set()

async function togglePreview(itemId) {
  // 復原面板那幾列也有「看內容」，而它是另一份畫面 —— 兩邊都要重畫，
  // 不然在復原面板點了會沒反應（稽核 2026-09-20）。沒開的那一份 render 本來就很便宜。
  const redraw = () => { render(); if (historyData) renderHistory() }
  if (previewOpen.has(itemId)) { previewOpen.delete(itemId); redraw(); return }
  previewOpen.add(itemId)
  redraw()                       // 先畫「正在讀」，不要讓使用者以為按了沒反應
  await previews.load(itemId)
  // 讀回來之前使用者可能已經又收起來了
  if (previewOpen.has(itemId)) redraw()
}

/**
 * 展開的那一塊：後設資料、為什麼被列出來、內容（文字或縮圖）。
 *
 * **內容一律 textContent**，一個會解析 HTML 的寫法都不准用 —— 這是檔案裡的字，
 * 由誰寫的我們不知道。圖用 `blob:`（帶 token 的 api 取回來的），token 不進網址。
 */
function previewBox(itemId) {
  const box = document.createElement('div')
  box.className = 'cleanup-preview'
  const got = previews.get(itemId)
  if (!got) { box.append(paragraph('Reading this file…', 'evidence')); return box }
  if (!got.ok) { box.append(paragraph(safeName(got.message), 'evidence')); return box }
  const lines = previewLines(got.view)
  if (!lines) { box.append(paragraph("Could not read this file's contents.", 'evidence')); return box }
  box.append(paragraph(lines.meta, 'evidence'), paragraph(lines.why, 'evidence'))
  const url = previews.image(itemId)
  if (url) {
    const img = document.createElement('img')
    img.src = url
    img.alt = lines.name
    box.append(img)
  } else if (lines.image !== null) {
    // 後端說有圖，但縮圖抓不回來（掃完之後檔被刪掉、或檔換過使磁碟核對失敗）。
    // **不可以什麼都不說**（稽核 2026-09-20）—— 那會變成一個空框，使用者以為壞掉了。
    box.append(paragraph('This image cannot be shown right now — the file may have been deleted or replaced.', 'evidence'))
  }
  if (lines.text !== null) {
    const pre = document.createElement('pre')
    pre.className = 'cleanup-preview-text'
    pre.textContent = lines.text
    box.append(pre)
    // 截斷了就要講「還有更多」，不可以安靜地少給
    if (lines.truncated) box.append(paragraph(lines.more, 'evidence'))
  } else if (lines.empty) {
    box.append(paragraph(lines.empty, 'evidence'))
  }
  return box
}

/** 在一列底下掛「看內容」，展開時把內容接在同一列裡。 */
function attachPreview(host, itemId) {
  if (isDemo() || typeof itemId !== 'string' || !itemId) return
  const open = previewOpen.has(itemId)
  const peek = document.createElement('button')
  peek.type = 'button'
  peek.className = 'cleanup-peek'
  peek.textContent = open ? 'Hide' : 'View contents'
  peek.setAttribute('aria-expanded', String(open))
  // **忙的時候照樣可以看**：看內容不動任何檔案，而正在搬檔的時候更需要看得到自己在清什麼
  peek.onclick = () => togglePreview(itemId)
  host.append(peek)
  if (open) {
    // **連拍那一格只有 150px 寬，預覽是 420px。**（2026-09-21 使用者截圖）
    // 不標記的話，預覽會從格子裡滿出來、把同一排的其他張擠出畫面右邊，
    // 連帶那幾張的勾選框也按不到了。展開的那一格整列讓給它（CSS 在 ui.html）。
    host.classList.add('is-previewing')
    host.append(previewBox(itemId))
  }
  // 沒有 else：每一次 render 都是重新造格子，收起來那一格根本是新的 div，
  // 舊標記帶不過來。突變測試證實了這件事 —— 拿掉 remove 那一行，一條測試都沒紅，
  // 那就是死路。看起來像保險的死路比沒有保險更糟（會讓人以為守住了）。
}

/** 面板最上面那一句。本機模式講真的資料夾名（U4），拿不到就講「監看資料夾」。 */
function modeNote() {
  $('cleanup-mode-note').textContent = isDemo()
    ? 'Demo mode · these are sample files. Cleanup and undo will not touch anything real on your computer.'
    : `Local mode · these are the real files in ${folderPhrase(health?.watcher)}. Cleanup moves the ticked ones to quarantine; you can undo it for seven days.`
}
/** 0–1 的相對座標 → 百分比（小數點後一位就夠，框不用畫得比這更準）。 */
const pct = v => (Math.round(v * 1000) / 10) + '%'

/**
 * 連拍區裡的一張縮圖。
 *
 * - 縮圖是 `blob:` 網址（面板用帶 token 的 api 取回來的）。**token 不在網址上**，
 *   所以不能寫成 `<img src="/cleanup/thumb/…">`（那條端點要 token，img 不會帶 header）。
 * - 差異處的外框用**相對座標**（0–1）換成百分比疊在圖上，縮圖多大都對得上。
 * - 留下的那張標「留著」、**沒有勾選框** —— 它永遠不會被提議清掉。
 * - 檔名是不可信的輸入：一律 safeName，而且只進 textContent。
 */
function burstShotCell(shot, { keep = false, state = null } = {}) {
  const cell = document.createElement('div')
  cell.className = 'cleanup-shot'
  const frame = document.createElement('div')
  frame.className = 'cleanup-shot-frame'
  const url = bursts.thumb(shot.itemId)
  if (url) {
    const img = document.createElement('img')
    img.src = url
    img.alt = safeName(shot.name)
    frame.append(img)
  } else {
    frame.append(paragraph('(no thumbnail)', 'evidence'))
  }
  for (const b of shot.boxes) {
    const mark = document.createElement('span')
    mark.className = 'cleanup-shot-box'
    mark.setAttribute('style', `left:${pct(b.x)};top:${pct(b.y)};width:${pct(b.w)};height:${pct(b.h)}`)
    frame.append(mark)
  }
  cell.append(frame)
  if (keep) {
    cell.append(paragraph(`Keeping · ${safeName(shot.name)}`, 'cleanup-shot-keep'))
    appendModelOpinion(cell, shot.model)
    attachPreview(cell, shot.itemId)
    return cell
  }
  const label = document.createElement('label')
  const check = document.createElement('input')
  check.type = 'checkbox'
  // 成員本來就是候選清單上的檔，勾選走**同一個** selected 集合 —— 清理是同一條路。
  // 萬一它不在清單上（後端兩邊不同步），給看但不給勾：勾了也送不出去。
  const listed = state.candidates.some(c => c.itemId === shot.itemId)
  check.checked = state.selected.has(shot.itemId)
  check.disabled = busy || state.canUndo || Boolean(state.locked) || !listed
  check.onchange = () => { state.select(shot.itemId, check.checked); request = null; summary() }
  const name = document.createElement('strong')
  name.textContent = safeName(shot.name)
  label.append(check, name)
  cell.append(label, paragraph(bytes(shot.bytes), 'evidence'))
  appendModelOpinion(cell, shot.model)
  attachPreview(cell, shot.itemId)
  return cell
}

/**
 * 連拍區。**沒有組就整區不顯示**；示範模式也不顯示（那時候畫面上是假的清單，
 * 掛真的連拍組只會讓人分不清在看什麼）。
 */
function renderBursts() {
  const box = $('cleanup-bursts')
  box.replaceChildren()
  const groups = isDemo() ? [] : bursts.groups
  box.hidden = groups.length === 0
  if (!groups.length) return
  const s = session()
  box.append(paragraph('Screenshot bursts · keep only the newest of each batch', 'cleanup-note'))
  for (const g of groups) {
    const row = document.createElement('article')
    row.className = 'cleanup-file cleanup-burst'
    row.append(paragraph(burstGroupLine(g)), paragraph(burstNote(g.level), 'evidence'))
    const shots = document.createElement('div')
    shots.className = 'cleanup-burst-shots'
    shots.append(burstShotCell(g.keep, { keep: true }))
    for (const m of g.members) shots.append(burstShotCell(m, { state: s }))
    row.append(shots)
    box.append(row)
  }
  if (bursts.more) box.append(paragraph(`${plural(bursts.more, 'more group')}. Deal with these, then open the panel again to see them.`, 'evidence'))
}

/**
 * 建議的名字（P3）。**沒有建議就整區不顯示**；示範模式也不顯示（那時候畫面上是假的清單，
 * 掛真的改名按鈕會讓人以為示範會動到自己的檔）。
 *
 * 每一列都寫著「模型認為⋯⋯」與證據，**一個勾選框都不預設勾起來**。
 */
function renderRenames() {
  const box = $('cleanup-renames')
  box.replaceChildren()
  const items = isDemo() ? [] : renames.items
  box.hidden = items.length === 0
  $('cleanup-rename').hidden = items.length === 0
  $('cleanup-rename-undo').hidden = isDemo() || !renames.canUndo
  if (!items.length) return
  box.append(paragraph("Suggested names · these are the model's opinion, not facts. Nothing changes until you tick them and press “Rename”, and it can be undone.", 'cleanup-note'))
  for (const item of items) {
    const lines = renameLines(item)
    if (!lines) continue
    const row = document.createElement('article')
    row.className = 'cleanup-file cleanup-rename-row' + (lines.rejected ? ' cleanup-rejected' : '')
    const label = document.createElement('label')
    const check = document.createElement('input')
    check.type = 'checkbox'
    // **退過貨的一樣不預設勾** —— 這一區本來就一個都不勾，所以這裡不用特例；
    // 真正要做的是**講出來**（下面那一行），不然使用者不知道為什麼它還在清單上。
    check.checked = renames.selected.has(item.itemId)
    check.disabled = busy
    check.onchange = () => { renames.select(item.itemId, check.checked); summary() }
    const head = document.createElement('strong')
    head.textContent = lines.head
    label.append(check, head)
    // 一列一顆：不用滑到最底下按總按鈕（使用者自己講的，2026-09-20）
    const one = document.createElement('button')
    one.type = 'button'
    one.className = 'cleanup-one cleanup-one-rename'
    one.textContent = 'Rename'
    one.disabled = busy
    one.onclick = () => oneOf(renames, renameOperate, item)
    // one 掛在 row 上、**不可以掛進 label**：真瀏覽器裡點 label 底下的按鈕
    // 會連帶把那個勾選框切掉，按一下「Rename」順便偷偷取消勾選。
    row.append(label, one, paragraph(lines.why), paragraph(lines.note, 'evidence'))
    if (lines.back) row.append(paragraph(lines.back, 'evidence'))
    attachPreview(row, item.itemId)
    box.append(row)
  }
  if (renames.more) box.append(paragraph(`${renames.more} more. Rename these, then open the panel again to see them.`, 'evidence'))
}

/**
 * 歸檔建議（P4）。**沒有建議就整區不顯示**；示範模式也不顯示（那時候畫面上是假的清單，
 * 掛真的整理按鈕會讓人以為示範會動到自己的檔）。
 *
 * 每一列都寫著「模型認為⋯⋯」與證據，**一個勾選框都不預設勾起來**。
 */
function renderFilings() {
  const box = $('cleanup-filings')
  box.replaceChildren()
  const items = isDemo() ? [] : filings.items
  box.hidden = items.length === 0
  $('cleanup-file').hidden = items.length === 0
  $('cleanup-file-undo').hidden = isDemo() || !filings.canUndo
  if (!items.length) return
  box.append(paragraph("Filing suggestions · these are the model's opinion, not facts. Nothing moves until you tick them and press “File”, and it can be undone.", 'cleanup-note'))
  for (const item of items) {
    const lines = filingLines(item)
    if (!lines) continue
    const row = document.createElement('article')
    row.className = 'cleanup-file cleanup-filing-row' + (lines.rejected ? ' cleanup-rejected' : '')
    const label = document.createElement('label')
    const check = document.createElement('input')
    check.type = 'checkbox'
    // 同上：一個都不預設勾，退過貨的**另外講一句**
    check.checked = filings.selected.has(item.itemId)
    check.disabled = busy
    check.onchange = () => { filings.select(item.itemId, check.checked); summary() }
    const head = document.createElement('strong')
    head.textContent = lines.head
    label.append(check, head)
    // 一列一顆：不用滑到最底下按總按鈕（使用者自己講的，2026-09-20）
    const one = document.createElement('button')
    one.type = 'button'
    one.className = 'cleanup-one cleanup-one-file'
    one.textContent = 'File'
    one.disabled = busy
    one.onclick = () => oneOf(filings, filingOperate, item)
    // 同上：掛在 row 上，不可以掛進 label
    row.append(label, one, paragraph(lines.why), paragraph(lines.note, 'evidence'))
    if (lines.back) row.append(paragraph(lines.back, 'evidence'))
    attachPreview(row, item.itemId)
    box.append(row)
  }
  if (filings.more) box.append(paragraph(`${filings.more} more. File these, then open the panel again to see them.`, 'evidence'))
}

/**
 * 它學到的事（P5）。**什麼都沒學過就整區不顯示**；示範模式也不顯示（那時候畫面上是假的清單，
 * 掛真的「忘掉」按鈕會讓人以為示範會改到自己的設定）。
 *
 * 這一區**只有「忘掉」一顆按鈕**，按不出任何會動檔案的事。
 */
function renderLearned() {
  const box = $('cleanup-learned')
  box.replaceChildren()
  const items = isDemo() ? [] : learned.items
  box.hidden = items.length === 0
  if (!items.length) return
  box.append(paragraph('What it learned · all of this comes from changes you made yourself. It only shapes the suggestions — it never moves a file on its own.', 'cleanup-note'))
  for (const item of items) {
    const lines = learnedLines(item)
    if (!lines) continue
    const row = document.createElement('article')
    row.className = 'cleanup-file cleanup-learned-row'
    const head = document.createElement('strong')
    head.textContent = lines.head
    const drop = document.createElement('button')
    drop.type = 'button'
    drop.textContent = 'Forget'
    drop.disabled = busy
    drop.onclick = () => forgetLearned(lines.id)
    row.append(head, paragraph(lines.why, 'evidence'), drop)
    box.append(row)
  }
  if (learned.more) box.append(paragraph(`${learned.more} more.`, 'evidence'))
  if (learned.evicted) {
    box.append(paragraph(`Too much to remember, so the ${plural(learned.evicted, 'oldest and least-used entry')} got dropped.`, 'evidence'))
  }
}

/** 忘掉一條。忘完要重畫上面兩區 —— 建議會跟著變回模型原本的說法。 */
async function forgetLearned(id) {
  if (busy) return
  busy = true
  render()
  result('Forgetting…')
  try {
    const out = await tracked(() => learned.forget(id))
    // 建議是算出來的，忘掉一條之後整份都要重讀，不然畫面還停在舊的寫法
    try { await renames.load() } catch { /* 那一區讀不到就維持原樣 */ }
    try { await filings.load() } catch { /* 同上 */ }
    result(out.message)
  } catch (error) {
    result(safeName(error?.message ?? 'Could not forget that. Try again.'))
  } finally {
    busy = false
    render()
  }
}

// -- 設定那一區（2026-09-20）----------------------------------
//
// 使用者：「要讓 client 可以在 panel 裡面輸入 config 的相關參數，像是 read only 或是 model 等等」。
//
// 這一區跟別區最大的差別是**它會寫使用者的設定檔**，所以畫面上要守三件事：
//   1. 每一欄都用人話講它會做什麼，不要把設定檔的欄位名搬上畫面（使用者沒看過那個檔）
//   2. 改 model.baseUrl 就是「把我的檔案送去另一台主機」—— 那句警告要在**按下去之前**看得到
//   3. keyEnv 那一欄要的是**環境變數的名字**。2026-09-20 早上使用者真的把金鑰本人貼進去了，
//      所以這裡只講「有沒有設」，一個字元的金鑰都不畫
//
// 全部走 createElement + textContent（跟這支檔其他地方一樣）：後端回來的字、
// 使用者打的字都是不可信的輸入，沒有一條路通到會解析 HTML 的寫法
// （那一條線由 audit-0919-ui.test.mjs 的整檔掃描守著，連註解裡都不可以出現那幾個名字）。

/** 這一欄底下的「哪裡不行」。有才畫 —— 空的錯誤框會讓每一欄都看起來像壞的。 */
function appendFieldError(row, field) {
  const message = settings.fieldError(field)
  if (!message) return
  const p = paragraph(message, 'cleanup-field-error')
  p.dataset.field = field
  row.append(p)
}

/**
 * 一欄文字設定。**oninput 只改 edited，不重畫** —— 每打一個字就重建輸入框，
 * 游標會跳回開頭，一長串網址根本打不完。
 */
function settingText(field, caption, value, hint) {
  const row = document.createElement('div')
  row.className = 'cleanup-setting'
  row.dataset.field = field
  const label = document.createElement('label')
  const text = document.createElement('span')
  text.textContent = caption
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'cleanup-setting-input'
  input.dataset.field = field
  input.value = value
  input.disabled = settingsSaving
  input.oninput = () => settings.edit(field, input.value)
  label.append(text, input)
  row.append(label)
  if (hint) row.append(paragraph(hint, 'evidence'))
  appendFieldError(row, field)
  return row
}

/** 一欄開關。標籤講的是**它會做什麼**，不是設定檔裡那個鍵叫什麼。 */
function settingCheck(field, caption, checked, hint) {
  const row = document.createElement('div')
  row.className = 'cleanup-setting'
  row.dataset.field = field
  const label = document.createElement('label')
  label.className = 'cleanup-setting-check'
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.className = 'cleanup-setting-input'
  input.dataset.field = field
  input.checked = checked
  input.disabled = settingsSaving
  input.onchange = () => settings.edit(field, input.checked)
  const text = document.createElement('span')
  text.textContent = caption
  label.append(input, text)
  row.append(label)
  if (hint) row.append(paragraph(hint, 'evidence'))
  appendFieldError(row, field)
  return row
}

/** 唯讀區的一行「名稱：值」。值是路徑，一律 uiSafeName。 */
const shownLine = (caption, value) => paragraph(caption + ': ' + uiSafeName(value))

/**
 * 使用者現在正握著設定區嗎：游標就在裡面某一格，或是打了字還沒按儲存。
 *
 * 用在「要不要讓輪詢重畫這一區」那個判斷上。**輪詢期間這一區的內容本來就不會變** ——
 * `settings.load()` 只在打開面板那一刻跑一次，`busy` 與 `settingsSaving` 在 refreshSuggestions
 * 的守門條件下一定是 false —— 所以讓開不會漏掉任何新消息。
 */
function settingsHeldByUser(box) {
  if (isDemo() || !settings.view) return false
  const active = document.activeElement
  if (active && active !== document.body && box.contains(active)) return true
  return Object.keys(settings.patch()).length > 0
}

function renderSettings() {
  const box = $('cleanup-settings')
  // **輪詢重畫的時候，正在被使用者動的設定區要讓開**（2026-09-20 稽核）。
  // 這一支開頭就是 replaceChildren，等於把使用者正在打字的那個 input 換成一個新的。
  // 字不會不見（重畫是從 edited 出來的，oninput 每一鍵都寫進去了），掉的是焦點、游標位置、
  // 選取範圍，以及注音打到一半還沒上屏的字 —— 慢慢敲一串網址的人每五秒被踢出輸入框一次。
  // 只擋輪詢那一條：按儲存、開面板、切分頁那幾條照樣重畫，不然 400 的紅字貼不上去。
  if (pollRedraw && settingsHeldByUser(box)) return
  box.replaceChildren()
  const save = $('cleanup-settings-save')
  save.hidden = true
  // 示範模式沒有這一區：那時畫面上是假的清單，掛真的「儲存」會讓人以為示範也在改自己的設定檔
  if (isDemo()) return
  const view = settings.view
  if (!view) {
    // 讀不到設定不是災難（舊版後端根本沒有這條路由）—— 講一句話就好，別的區照常
    box.append(paragraph(settings.problem ?? 'Could not read your settings.', 'cleanup-note cleanup-warn'))
    return
  }
  const edited = settings.edited
  save.hidden = false
  save.disabled = busy || settingsSaving
  save.textContent = settingsSaving ? 'Saving…' : 'Save settings'

  box.append(paragraph('What you change here gets written into your config file. Everything else in that file is left exactly as it is.', 'cleanup-note'))

  box.append(settingCheck('readonly',
    'Read-only — ContextBox looks and suggests but never moves a file',
    edited.readonly,
    'Suggestions keep coming. Nothing gets moved, renamed or filed while this is on.'))

  box.append(settingText('model.baseUrl', 'Model endpoint', edited.model.baseUrl,
    'Leave it empty to run with no model at all — the rules still work.'))
  // **警告要在按下去之前**：改這一欄就是換一台「我的檔案內容送去哪裡」的主機
  box.append(paragraph('Careful: this is the address the contents of your files get sent to. Point it at a machine you do not trust and your documents go there. Plain http only makes sense for a machine on your own desk.', 'cleanup-note cleanup-warn'))

  box.append(settingText('model.name', 'Model name', edited.model.name,
    'The model the endpoint above should use, for example Qwen3-VL-8B.'))

  box.append(settingText('model.keyEnv', 'Key environment variable', edited.model.keyEnv,
    'This is the NAME of an environment variable, for example CONTEXTBOX_MODEL_KEY — not the key. ContextBox reads the key out of your environment, so never type or paste a key into this box.'))
  // **只講有沒有設**。金鑰本身、遮起來的金鑰、甚至它有幾個字，一個都不上畫面
  const savedEnv = view.editable.model.keyEnv
  box.append(paragraph(!savedEnv ? 'No environment variable is set for the key yet.'
    : view.keySet ? 'Key found in ' + savedEnv
    : savedEnv + ' is empty', 'evidence'))
  if (edited.model.keyEnv !== savedEnv) {
    // 打了新的名字就講一句 —— 但**不重複那個名字**：使用者剛剛可能貼的就是金鑰本人
    box.append(paragraph('You changed this box. Save, and it will read the key out of the variable you typed.', 'evidence'))
  }

  box.append(settingCheck('cleanup.screenshots', 'Include screenshots in cleanup',
    edited.cleanup.screenshots,
    'Adds your screenshots folder to the scan. Only screenshots in it ever get proposed, nothing else in that folder.'))

  // 這一版只顯示、不給改的那幾個（掃描範圍指到哪裡是另一種風險，值得自己一輪）
  const shown = document.createElement('div')
  shown.className = 'cleanup-setting-shown'
  const head = document.createElement('strong')
  head.textContent = 'Folders — shown here, changed in the file'
  shown.append(head)
  shown.append(shownLine('Watched folders', view.shown.watch.join('  ·  ') || 'none'))
  shown.append(shownLine('Filed folder', view.shown.filed || 'none'))
  shown.append(shownLine('Cleanup folders', view.shown.cleanupRoots.join('  ·  ') || 'none'))
  shown.append(shownLine('Quarantine', view.shown.quarantine || 'none'))
  shown.append(shownLine('Pages read out of a PDF', String(view.shown.pdfPages)))
  shown.append(shownLine('Largest file it reads', bytes(view.shown.maxBytes)))
  shown.append(paragraph('Those folders are edited in the config file itself: ' + uiSafeName(view.path), 'evidence'))
  box.append(shown)

  if (view.problems.length) {
    const warn = document.createElement('div')
    warn.className = 'cleanup-note cleanup-warn'
    warn.append(paragraph('Your config file as it stands:'))
    for (const p of view.problems) warn.append(paragraph(uiSafeName(p)))
    box.append(warn)
  }
  // 逐欄講實話：哪幾欄按下儲存就算數、哪幾欄要重開寵物
  if (view.live.length) {
    box.append(paragraph('Takes effect the moment you save: ' + view.live.map(settingLabel).join(', ') + '.', 'evidence'))
  }
  if (view.restart.length) {
    box.append(paragraph('Needs the pet restarted: ' + view.restart.map(settingLabel).join(', ') + '.', 'evidence'))
  }
  if (settings.message) {
    box.append(paragraph(settings.message,
      settings.failed ? 'cleanup-setting-result cleanup-warn' : 'cleanup-setting-result'))
  }
}

/**
 * 按下「儲存」。**只送改過的那幾欄**（store 的 patch()），沒改就什麼都不送。
 *
 * 400 不算爆炸：store 會把逐欄的話收好，這裡只負責重畫 ——
 * 重畫是從 edited 出來的，所以使用者打的字還在原位。
 */
async function saveSettings() {
  if (busy || settingsSaving || isDemo() || !settings.view) return
  settingsSaving = true
  renderSettings()
  try { await tracked(() => settings.save()) }
  catch { /* store 自己會把話收好；真的漏出來的例外不可以讓面板卡在「Saving…」 */ }
  finally {
    settingsSaving = false
    // 存成功會換掉唯讀區與 keySet，整個面板重畫一次最省事（別區的內容不受影響）
    render()
  }
}
$('cleanup-settings-save').onclick = () => saveSettings()

/**
 * 面板裡的六個小標籤（P6 之二）。
 *
 * **為什麼**：以前五區疊在同一條捲軸上，使用者要滑到很下面才看得到歸檔建議 ——
 * 使用者自己講的第一句話就是「不然我都要滑到好下面」。
 *
 * 規矩：
 *   · 一次只顯示一區；空的那幾區標籤變灰，點不下去（但**看得到**，使用者才知道有這個功能）
 *   · 現在這一區變空了就跳到第一個有東西的；全都空的時候留在「可以清理」（那一區會講「目前沒有待清檔案」）
 *   · 動作按鈕跟著區塊走（data-section）：在歸檔那一區只會看到「整理」與「復原整理」
 *   · **示範模式整條不顯示** —— 那時只有清理那一區是真的
 *
 * 「設定」（2026-09-20）是 `always` 的一區：它不是一份清單，沒有數字，而且**永遠點得下去**。
 * 它也不參加上面那兩條跳轉規則 —— 不然「全都空」的時候使用者會被從「可以清理」彈到設定頁，
 * 而那一頁不會告訴他「目前沒有待清檔案」。
 */
const PANEL_SECTIONS = [
  { key: 'clean', label: 'Cleanup' },
  { key: 'bursts', label: 'Bursts' },
  { key: 'renames', label: 'Suggested names' },
  { key: 'filings', label: 'Filing' },
  { key: 'learned', label: 'Learned' },
  { key: 'settings', label: 'Settings', always: true },
]
let panelSection = 'clean'
const alwaysOn = key => PANEL_SECTIONS.some(x => x.key === key && x.always)
/** 每一顆動作按鈕屬於哪一區（不屬於現在這一區的就收起來）。 */
const SECTION_BUTTONS = {
  'cleanup-apply': 'clean', 'cleanup-release': 'clean', 'cleanup-putback': 'clean',
  'cleanup-undo': 'clean', 'cleanup-dismiss': 'clean',
  'cleanup-rename': 'renames', 'cleanup-rename-undo': 'renames',
  'cleanup-file': 'filings', 'cleanup-file-undo': 'filings',
  'cleanup-settings-save': 'settings',
}

/** 每一區現在有幾筆。空的（0）那一區的標籤會變灰（always 的那幾區不看這個數字）。 */
function sectionCounts() {
  const s = session()
  if (isDemo()) return { clean: s.candidates.length, bursts: 0, renames: 0, filings: 0, learned: 0, settings: 0 }
  const inBurst = bursts.memberIds()
  return {
    clean: s.candidates.filter(c => !inBurst.has(c.itemId)).length + (s.needsHuman?.length ?? 0),
    bursts: bursts.groups.length,
    renames: renames.items.length,
    filings: filings.items.length,
    learned: learned.items.length,
    settings: 0,
  }
}

/** 畫標籤列，並且把沒選到的那幾區與它們的按鈕藏起來。 */
function renderSections() {
  const counts = sectionCounts()
  // 現在這一區空了就換到第一個有東西的（全空就留在「可以清理」）。
  // always 的那幾區兩邊都不算：既不會因為「沒有東西」被踢走，也不會被當成「有東西的第一區」
  if (!counts[panelSection] && !alwaysOn(panelSection)) {
    panelSection = PANEL_SECTIONS.find(x => !x.always && counts[x.key])?.key ?? 'clean'
  }
  const bar = $('cleanup-tabs')
  bar.hidden = isDemo()
  bar.replaceChildren()
  if (!isDemo()) {
    for (const { key, label, always } of PANEL_SECTIONS) {
      const b = document.createElement('button')
      b.type = 'button'
      b.dataset.section = key
      b.setAttribute('role', 'tab')
      b.setAttribute('aria-selected', String(key === panelSection))
      b.disabled = !always && !counts[key] && key !== panelSection
      b.append(document.createTextNode(label))
      // always 的那一區沒有數字：「Settings0」看起來像是設定被清空了
      if (!always) {
        const n = document.createElement('span')
        n.className = 'cleanup-tab-n'
        n.textContent = String(counts[key])
        b.append(n)
      }
      b.onclick = () => { panelSection = key; render() }
      bar.append(b)
    }
  }
  // **照 id 拿，不要用 querySelectorAll**：面板的程式碼一律只用 getElementById，
  // 測試那份 DOM 也只實作了它（多一個選擇器語法就多一個測不到的地方）。
  for (const { key } of PANEL_SECTIONS) {
    const box = $('cleanup-sec-' + key)
    // 示範模式沒有標籤列，那時候每一區都照舊（各自的 hidden 說了算）
    if (box) box.hidden = !isDemo() && key !== panelSection
  }
  if (!isDemo()) {
    for (const [id, key] of Object.entries(SECTION_BUTTONS)) {
      if (key !== panelSection && $(id)) $(id).hidden = true
    }
  }
}

function render() {
  const s = session()
  panel.dataset.mode = isDemo() ? 'demo' : 'local'
  const eligible = proposalItems(s)
  const candidates = proposalRows(s)
  modeNote()
  $('cleanup-space-note').hidden = !isDemo()
  $('cleanup-apply').hidden = false
  $('cleanup-reset').hidden = !isDemo()   // 「重新示範」只有 demo 有意義
  for (const id of ['cleanup-undo', 'cleanup-dismiss']) $(id).hidden = false
  renderBursts()
  renderRenames()
  renderFilings()
  renderLearned()
  renderSettings()
  // 連拍區已經列出來的成員不要在下面再列一次 —— 同一個檔兩個勾選框，使用者不知道該信哪一個。
  // **分頁也不要把它們算進去**，不然會有一頁十格、其中幾格是空的。
  const inBurst = isDemo() ? new Set() : bursts.memberIds()
  $('cleanup-list').replaceChildren()
  const rows = candidates.filter(item => !inBurst.has(item.itemId))
  const listed = rows.length
  const pages = Math.max(1, Math.ceil(rows.length / cleanupPageSize))
  cleanupPage = Math.min(Math.max(0, cleanupPage), pages - 1)
  $('cleanup-page').textContent = `Page ${cleanupPage + 1} of ${pages}`
    + ` · ${plural(eligible.filter(item => !inBurst.has(item.itemId)).length, 'file')} to clean up`
  $('cleanup-prev').disabled = busy || cleanupPage === 0
  $('cleanup-next').disabled = busy || cleanupPage === pages - 1
  for (const item of rows.slice(cleanupPage * cleanupPageSize, (cleanupPage + 1) * cleanupPageSize)) {
    const card = document.createElement('article')
    card.className = 'cleanup-file'
    const pendingSkip = proposalSkips().find(op => op.pending && op.items.some(i => i.itemId === item.itemId))
    if (pendingSkip) {
      const restore = document.createElement('button')
      restore.type = 'button'
      restore.className = 'cleanup-restore-skipped'
      restore.textContent = 'Put it back on the list ›'
      restore.disabled = busy || s.canUndo || Boolean(s.locked)
      restore.onclick = () => {
        if (busy || s.canUndo || s.locked) return
        const saved = pendingSkip.items.find(i => i.itemId === item.itemId)
        pendingSkip.items = pendingSkip.items.filter(i => i.itemId !== item.itemId)
        if (!pendingSkip.items.length) skippedOperations.splice(skippedOperations.indexOf(pendingSkip), 1)
        s.select(item.itemId, saved.wasSelected)
        request = null
        render()
      }
      card.append(restore)
      $('cleanup-list').append(card)
      continue
    }
    const label = document.createElement('label')
    const check = document.createElement('input')
    check.type = 'checkbox'
    check.checked = s.selected.has(item.itemId)
    // 結果不明時要鎖住：改了勾選就會撞上自己剛建的那份計畫
    check.disabled = busy || s.canUndo || Boolean(s.locked)
    check.onchange = () => { s.select(item.itemId, check.checked); request = null; summary() }
    const name = document.createElement('strong')
    name.textContent = uiSafeName(item.name)
    label.append(check, name)
    // 卡片上的每一段都走 safeName（U5）：evidence 會帶檔名（「檔名是 …」「會留著「…」」），
    // folder／subdir 是資料夾名 —— 都是不可信的輸入，U+2028 在 white-space: normal 下也會斷行、偽造一行。
    const where = [item.folder, item.subdir].filter(Boolean).map(uiSafeName).join('/')
    const row = document.createElement('div')
    row.className = 'cleanup-file-row'
    const size = document.createElement('span')
    size.className = 'cleanup-file-size'
    size.textContent = bytes(item.bytes)
    const skip = document.createElement('button')
    skip.type = 'button'
    skip.textContent = 'Not this one'
    skip.disabled = check.disabled
    skip.onclick = () => skipItem(s, item)
    // 一列一顆「Clean up」：391 個候選的時候，為了清掉一個檔而滑到最底下按總按鈕
    // 是很糟的體驗（使用者自己講的）。這顆只清這一個，走的是同一條路
    // （建計畫 → 套用 → 逐項結果 → 可復原），不是另一條捷徑。
    const one = document.createElement('button')
    one.type = 'button'
    one.className = 'cleanup-one'
    one.textContent = 'Clean up'
    one.disabled = busy || s.canUndo || Boolean(s.locked)
    one.onclick = () => cleanOne(s, item)
    row.append(label, size, one, skip)
    // 理由收在「Why this one」裡：一眼掃過去是檔名與大小，想知道為什麼再點開
    const details = document.createElement('details')
    const heading = document.createElement('summary')
    heading.textContent = 'Why this one'
    details.append(heading, paragraph(`${where} · confidence ${item.confidence}%`))
    card.append(row, details)
    for (const reason of item.reasons) {
      details.append(paragraph(reasonText(reason.reason)), paragraph(reasonText(reason.evidence), 'evidence'))
    }
    // 模型對這個檔的看法（P2）。示範模式沒有這一段（那時畫面上是假的清單）
    if (!isDemo()) appendModelOpinion(card, item.model)
    if (item.vetoed) card.append(paragraph('⚠ ' + uiSafeName(item.vetoed), 'evidence'))
    // 「不記得這個檔存了什麼」就點開看一眼（P6）
    attachPreview(card, item.itemId)
    $('cleanup-list').append(card)
  }
  if (!listed && !$('cleanup-bursts').children.length && !$('cleanup-renames').children.length
    && !$('cleanup-filings').children.length) {
    $('cleanup-list').append(paragraph(isDemo() ? 'Every sample file has been dealt with.' : 'Nothing to clean up right now.'))
  }
  $('cleanup-needs-human').replaceChildren()
  for (const item of (isDemo() ? data.needsHuman : s.needsHuman) ?? []) {
    // 這一區最需要「看內容」：太大、讀不到的檔，使用者更不記得它是什麼
    const row = document.createElement('div')
    row.className = 'cleanup-human-row'
    row.append(paragraph(`Needs your eyes: ${uiSafeName(item.name)} — ${uiSafeName(item.why)} (not included in the cleanup)`))
    attachPreview(row, item.itemId)
    $('cleanup-needs-human').append(row)
  }
  summary()
  // **一定要在 summary() 之後**：summary 會依狀態決定每顆按鈕的 hidden，
  // 這裡再把「不屬於現在這一區」的收起來。
  renderSections()
}
$('cleanup-prev').onclick = () => { if (!busy && cleanupPage > 0) { cleanupPage--; render() } }
$('cleanup-next').onclick = () => {
  const s = session()
  if (!s) return
  const inBurst = isDemo() ? new Set() : bursts.memberIds()
  const rows = proposalRows(s).filter(item => !inBurst.has(item.itemId))
  if (!busy && (cleanupPage + 1) * cleanupPageSize < rows.length) { cleanupPage++; render() }
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
    if (!response.ok) throw new Error('Could not load the sample data')
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
  bursts.clear()   // 連拍組是本機模式的東西；切模式時把 blob: 網址還回去
  renames.clear()  // 建議的名字也是本機模式的東西
  filings.clear()  // 歸檔建議也是
  learned.clear()  // 「它學到的事」也是（示範模式沒有這一區）
  previews.clear() // 展開的內容也是；blob: 網址要還回去
  previewOpen.clear()
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
    notice('The sample data is not available right now. Check that the server is running, then press D again.')
  }
}
async function openCleanupPanel() {
  $('quaso-dialog').hidden = true
  $('quaso-burst-open').hidden = true
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
  for (const id of ['cleanup-apply', 'cleanup-undo', 'cleanup-release', 'cleanup-putback', 'cleanup-dismiss', 'cleanup-reset', 'cleanup-space-note', 'cleanup-bursts', 'cleanup-renames', 'cleanup-rename', 'cleanup-rename-undo', 'cleanup-filings', 'cleanup-file', 'cleanup-file-undo', 'cleanup-learned', 'cleanup-settings-save']) $(id).hidden = true
  $('cleanup-result').hidden = true
  $('cleanup-settings').replaceChildren()
  $('cleanup-list').replaceChildren(paragraph('Loading candidate files…'))
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
    // 連拍組（後端沒有這條就是空的，面板照常）。**similar 一律再取消勾一次**：
    // 這一區是主動問的，寧可少勾一格，也不要讓人一按就丟掉一張內容不一樣的截圖。
    await bursts.load()
    applyBurstDefaults(real, bursts.groups)
    // 建議的名字（P3）。後端沒有這幾條就是空的，面板照常
    await renames.load()
    // 歸檔建議（P4）。後端沒有這幾條就是空的，面板照常
    await filings.load()
    // 它學到的事（P5）。後端沒有這一條就是空的，面板照常
    await learned.load()
    // 設定（2026-09-20）。**只在這裡讀一次**，不進輪詢 —— 輪詢重讀會把使用者正在打的字洗掉。
    // 後端沒有這條路由（舊版）就是 view 為 null，那一區講一句話，別的區照常。
    await settings.load()
    render()
    if (real.pendingPlan && !real.uncertain) result(pendingPlanMessage(real.pendingPlan))
    else if (real.locked) result('The result of the last cleanup was never confirmed. “Try again” reuses that same plan; nothing extra gets moved.')
  } catch { $('cleanup-list').replaceChildren(paragraph('Loading failed. Check that the server is running, close the panel and click the trash can to try again.')) }
}
alertButton.onclick = openCleanupPanel
// 檔案管理那一塊的入口（P6）：跟可頌貓底下的垃圾桶開的是同一個面板
$('files-open-cleanup').onclick = openCleanupPanel
// 寵物主動問完之後的那顆按鈕：點一下就是打開連拍區（面板一打開就在最上面）
$('quaso-burst-open').onclick = () => {
  $('quaso-burst-open').hidden = true
  return openCleanupPanel()
}
$('cleanup-select-all').onclick = () => {
  if (busy) return

  const s = session()
  if (!s || s.canUndo || s.locked) return

  for (const item of proposalItems(s)) {
    s.select(item.itemId, true)
  }

  request = null
  render()
}

$('cleanup-select-none').onclick = () => {
  if (busy) return

  const s = session()
  if (!s || s.canUndo || s.locked) return

  for (const item of proposalItems(s)) {
    s.select(item.itemId, false)
  }

  request = null
  render()
}
$('cleanup-close').onclick = () => {
  panel.close()
  
}
function selectPage(checked) {
  const s = session()
  if (busy || !s || s.canUndo || s.locked) return
  const eligible = new Set(proposalItems(s).map(item => item.itemId))
  for (const item of proposalRows(s).slice(cleanupPage * cleanupPageSize, (cleanupPage + 1) * cleanupPageSize)) {
    if (!eligible.has(item.itemId)) continue
    s.select(item.itemId, checked)
  }
  request = null
  render()
}
$('cleanup-select-page').onclick = () => selectPage(true)
$('cleanup-unselect-page').onclick = () => selectPage(false)

panel.addEventListener('close', () => {
  for (const op of skippedOperations.filter(op => op.pending)) {
    op.pending = false
    op.createdAt = new Date().toISOString()
    op.itemCount = op.items.length
    op.bytes = op.items.reduce((sum, item) => sum + item.bytes, 0)
  }
  void refreshHistoryBadge()
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
  notice('Fine, no cleanup this time. Had a croissant today?')
}
/** 真的清理。訊息**一律照後端說的結果講**，不用勾選數去推算。 */
async function operateReal(kind) {
  if (kind === 'apply') {
    result(real.pendingPlan ? 'Finishing the last plan…' : real.locked ? 'Retrying (same plan, nothing extra gets moved)…' : 'Moving files to quarantine…')
    const r = await real.apply()
    setPetMessageData({ freedBytes: r.bytesFreed ?? 0 })

    if (r.status === 'stale') {
      result('The list changed while you were looking at it — a file was deleted, or something else cleaned it up. Nothing moved. Check your ticks again.')
      return false
    }

    if (r.status === 'pending-plan') {
      result(pendingPlanMessage(r.plan))
      return false
    }

    const m = applyMessage(r)
    result(m.text)
    notice(m.notice)

    // API 回 200 不等於真的清掉了：noop（重複套用）與 moved=0 都不算完成，
    // 那時候寵物不可以切成 happy、也不可以說「清理完成」。
    return r.noop !== true && (r.moved ?? 0) > 0
  }

  if (kind === 'release') {
    result('Dropping the last plan…')
    const r = await real.release()
    result(`Dropped the last plan (${plural(r.items.length, 'file')}). Nothing moved. You can tick files and clean up again now.`
      + (r.reloadFailed ? '\n(The list did not refresh. Close the panel and open it again to see the current state.)' : ''))
    // 放棄不是「完成清理」
    return false
  }

  if (kind === 'putback') {
    // 做到一半中斷的那份：把已經在隔離區的放回原位，還沒搬的不動（R2-5b）
    result('Putting back what already moved…')
    const restored = await real.putBack()
    const restoredCount = restored.restored ?? 0
    setPetMessageData({ restoredCount, leftBehind: leftBehind(restored) })
    const m = undoMessage(restored)
    result(m.text)
    notice(m.notice)
    // **全部回到原位才算做完**：有放不回去的就不可以說「完成」（見 leftBehind）
    return restoredCount > 0 && leftBehind(restored) === 0
  }

  result('Putting files back…')
  const r = await real.undo()
  // 只講發生了什麼。**不講「之後不會再被提議」**：之後符合新的理由會再出現；
  // 原位置被佔時放回來的那份會改名，重掃後以重複檔的身分被預設勾起來。
  // 寵物的話也看結果：全部放回、部分放回、一個都沒放回，三種不同的話（RC9）。
  const restoredCount = r.restored ?? 0
  setPetMessageData({ restoredCount, leftBehind: leftBehind(r) })
  const m = undoMessage(r)
  result(m.text)
  notice(m.notice)
  // **全部回到原位才算做完。** 部分放回也不算 —— 不然寵物會說「Undo done ✨」，
  // 而使用者還有一個檔卡在隔離區裡沒人講（稽核 2026-09-20，合併時這條被放鬆了）。
  return restoredCount > 0 && leftBehind(r) === 0
}

/**
 * 改名與復原改名。跟清理走同一套忙碌旗標（兩邊都會動同一批檔，後端也是同一把鎖）。
 * **訊息一律照後端的逐項結果講**，不用勾選數推算。
 */
async function renameOperate(kind) {
  if (busy || isDemo()) return
  busy = true
  render()
  result(kind === 'apply' ? 'Renaming…' : 'Changing the names back…')
  try {
    const r = await tracked(() => (kind === 'apply' ? renames.apply() : renames.undo()))
    result(r.message)
  } catch (error) {
    result(safeName(error.message))
  } finally {
    busy = false
    // 改完名字，記住的預覽裡那個檔名就是舊的了
    previews.clear()
    previewOpen.clear()
    // 改完名字，清理清單上的檔名也變了 —— 重讀一次再畫
    try { await real.load() } catch { /* 讀不到就先用舊的，關掉面板再打開會更新 */ }
    render()
  }
  pollHealth()
}

/**
 * 整理與復原整理。跟清理、改名走同一套忙碌旗標（三邊都會動同一批檔，後端也是同一把鎖）。
 * **訊息一律照後端的逐項結果講**，不用勾選數推算。
 */
async function filingOperate(kind) {
  if (busy || isDemo()) return
  busy = true
  render()
  result(kind === 'apply' ? 'Filing…' : 'Moving the files back to the folders they came from…')
  try {
    const r = await tracked(() => (kind === 'apply' ? filings.apply() : filings.undo()))
    result(r.message)
  } catch (error) {
    result(safeName(error.message))
  } finally {
    busy = false
    // 搬走的檔已經不在原本的資料夾，記住的預覽跟著作廢
    previews.clear()
    previewOpen.clear()
    // 搬走的檔不在清理範圍裡了 —— 清單要重讀一次再畫
    try { await real.load() } catch { /* 讀不到就先用舊的，關掉面板再打開會更新 */ }
    render()
  }
  pollHealth()
}

/**
 * 這個錯要不要讓寵物切成 worried。
 * 伺服器明確回的 4xx（勾了不能清的、計畫過期）結果是確定的，只是這次不能做，
 * 不必把整隻寵物變成擔心臉；結果不明、連不上、500 才是。
 */
function seriousOperationError(error) {
  if (real?.uncertain) return true
  if (!error?.status) return true
  if (error.status >= 500) return true
  return false
}
/**
 * 這一次復原有幾個**沒有**回到原位（放不回去的＋結果不明的）。
 *
 * 「做完了嗎」不可以只看「有沒有放回任何一個」：兩個檔放回一個，那一個還在隔離區裡，
 * 而寵物會說「Undo done ✨」—— 那是在騙人。這個專案的第一條原則是講實話。
 */
const leftBehind = r => (r?.notRestored?.length ?? 0) + (r?.unconfirmed?.length ?? 0)

async function operate(kind) {
  if (busy) return
  busy = true
  // ① 動作開始：寵物先進暫時狀態（清理／放回），泡泡跟著換成「正在……」
  if (kind === 'apply') {
    setPetMessageData({
      lastAction: 'cleaning', freedBytes: 0, restoredCount: 0, errorMessage: '',
      candidates: proposalItems(session()).filter(i => session().selected.has(i.itemId)),
    })
    setPetTransientState('cleaning')
  } else if (kind === 'undo' || kind === 'putback') {
    setPetMessageData({ lastAction: 'restoring', freedBytes: 0, restoredCount: 0, errorMessage: '' })
    setPetTransientState('restoring')
  }
  render()
  // ── 真的清理 ────────────────────────────────────────────
  if (!isDemo()) {
    try {
      // ② **真的做完了才 happy。** API 回 200、noop、搬了 0 個都不算（見 operateReal 的回傳）
      const completed = await tracked(() => operateReal(kind))
      if (completed) setPetTransientState('happy')
      else clearPetTransientState()
    } catch (error) {
      // 伺服器明確回的錯（有 status）結果是確定的：只講原因，勾選照樣可以改（RC8）。
      // 只有網路斷了才是「結果不明」，那時候寵物才切成擔心。
      if (seriousOperationError(error)) {
        setPetMessageData({ errorMessage: safeName(error.message) })
        setPetTransientState('worried')
      } else {
        clearPetTransientState()
      }
      const lines = [safeName(error.message)]
      if (real?.uncertain) {
        lines.push(!real.pendingPlan ? 'The result is not confirmed. “Try again” reuses the same plan; nothing extra gets moved.'
          : real.pendingPlan.started ? 'The result is not confirmed. Pressing “Finish the last plan” or “Put back what moved” again is safe; nothing extra gets moved.'
          : 'The result is not confirmed. Pressing “Finish the last plan” or “Drop the last plan” again is safe; nothing extra gets moved.')
      }
      result(lines.join('\n'))
    } finally {
      busy = false
      // 清完（或放回）之後組可能散了、也可能少了一張 —— 重讀一次再畫，不要留著舊的縮圖。
      // **而且要再套一次預設**：重讀清單會把新冒出來的 similar 成員照後端的 defaultChecked 勾起來，
      // 使用者再按一次「清理」就會搬走一張他從來沒看過、有看得見變化的截圖（P0 驗證員）。
      await bursts.load()
      applyBurstDefaults(real, bursts.groups)
      // 清過之後那些檔的樣子（甚至還在不在）都變了，記住的預覽不可以再用
      previews.clear()
      previewOpen.clear()
      render()
    }
    pollHealth()
    return
  }
  // ── 示範模式 ────────────────────────────────────────────
  result(kind === 'apply' ? 'Simulating a move to quarantine…' : 'Simulating an undo…')
  try {
    if (kind === 'apply') {
      const candidateIds = demo.candidates.filter(c => demo.selected.has(c.itemId)).flatMap(c => c.candidateIds)
      request ??= { requestId: crypto.randomUUID(), candidateIds }
      const saved = await demoHistoryApi('history', request)
      if (!saved.canUndo) throw new Error('Another page already undid this action. Restart the demo.')
      currentOperation = saved.id
      request = null
      const response = demo.apply()
      setPetMessageData({ freedBytes: response.bytesFreed })
      const message = `Simulated cleanup done: ${plural(response.quarantined, 'file')} (${bytes(response.bytesFreed)}) moved to the simulated quarantine. Unticked files were left alone.`
      result(message)
      notice('All tidied up. Changed your mind? You can undo this cleanup any time.')
      setPetTransientState('happy')
    } else {
      await demoHistoryApi('undo', { operationIds: [currentOperation] })
      const response = demo.undo()
      setPetMessageData({ restoredCount: response.restored })
      currentOperation = null
      result(`Simulated undo: put ${plural(response.restored, 'file')} back, and the list and ticks are as they were before the cleanup.`)
      notice('Everything is back where it was.')
      setPetTransientState('happy')
    }
    updateAlert()
  } catch (error) {
    // 示範模式裡 real 可能根本還不存在（沒開過本機面板），
    // 「結果不明」那幾句是真的清理才有的事 —— 這裡只照實講這一句。
    clearPetTransientState()
    result(safeName(error.message))
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
    notice('This cleanup is done. Tick it under recent actions whenever you want it undone.')
  }
  else return operate('apply')
}
$('cleanup-undo').onclick = () => operate('undo')
$('cleanup-rename').onclick = () => renameOperate('apply')
$('cleanup-rename-undo').onclick = () => renameOperate('undo')
$('cleanup-file').onclick = () => filingOperate('apply')
$('cleanup-file-undo').onclick = () => filingOperate('undo')
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
  $('cleanup-history-undo').textContent = `Undo selected (${historySelected.size})`
  $('cleanup-history-undo').disabled = historyBusy || busy || historySelected.size === 0
  $('cleanup-history-prev').disabled = historyBusy || historyOffset === 0
  $('cleanup-history-next').disabled = historyBusy || !historyData || historyOffset + historyData.limit >= historyData.total
  $('cleanup-history-refresh').disabled = historyBusy
}
function renderHistory() {
  const list = $('cleanup-history-list')
  list.replaceChildren()
  const { total, operations, limit } = historyData
  setHistoryBadge(total)
  $('cleanup-history-count').textContent = `${plural(total, 'action')} can still be undone${total ? ` · page ${Math.floor(historyOffset / limit) + 1} of ${Math.ceil(total / limit)}` : ''}`
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
    // 「先不清」那幾筆只動這一輪的提案，沒有搬過任何檔 —— 標得出來，不要跟清理混在一起
    label.append(check, document.createTextNode(`${new Date(operation.createdAt).toLocaleString('en-US')}`
      + ` · ${operation.kind === 'skip' ? 'skipped' : 'cleaned up'} ${plural(operation.itemCount, 'file')} · ${bytes(operation.bytes)}`))
    card.append(label)
    // **隔離區裡的檔也要看得到內容**（稽核 2026-09-20）：使用者在這裡正要決定「要不要放回來」，
    // 而清完之後它已經不在清理清單上了 —— 這是唯一列得到它的地方。一個檔一行，各自有「看內容」。
    for (const item of operation.items) {
      const line = document.createElement('div')
      line.className = 'cleanup-history-item'
      line.append(paragraph(uiSafeName(item.name)))
      attachPreview(line, item.itemId)
      card.append(line)
    }
    card.append(paragraph(operation.canUndo ? 'Can be undone' : `Undone · ${new Date(operation.restoredAt).toLocaleString('en-US')}`, 'evidence'))
    list.append(card)
  }
  if (!operations.length) list.append(paragraph('There is nothing to undo right now.'))
  historyControls()
}
async function refreshHistory() {
  if (historyBusy) return
  historyBusy = true
  historySelected.clear()
  historyControls()
  $('cleanup-history-note').textContent = demoEnabled ? HISTORY_NOTE.demo : HISTORY_NOTE.local
  $('cleanup-history-list').replaceChildren(paragraph('Loading the action log…'))
  try {
    historyData = await historyApi(`history?offset=${historyOffset}&limit=20`)
    historyOffset = historyData.offset
    renderHistory()
  } catch {
    historyData = null
    $('cleanup-history-list').replaceChildren()
    $('cleanup-history-count').textContent = 'Log not loaded'
    historyResult('The action log is not available right now. Check that the server is running, then press “Reload”.')
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
$('files-open-history').onclick = openHistory
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
  // ① 開始放回
  setPetMessageData({ lastAction: 'restoring', restoredCount: 0, freedBytes: 0, errorMessage: '' })
  setPetTransientState('restoring')
  // 「先不清」那幾筆只存在這一頁：撤銷它們不必送後端，也沒有檔案會動
  const localUndo = localHistory().filter(op => historySelected.has(op.id))
  const localIds = new Set(localUndo.map(op => op.id))
  const operationIds = [...historySelected].filter(id => !localIds.has(id))
  renderHistory()
  historyResult(demoEnabled ? 'Undoing the selected simulated actions…' : 'Putting the selected cleanups back…')
  let message
  let restoredSkipped = 0
  try {
    for (const op of localUndo) {
      skippedOperations.splice(skippedOperations.indexOf(op), 1)
      restoredSkipped += op.items.length
    }
    if (session()) render()
    if (!operationIds.length) {
      message = ''
      setPetTransientState('happy')
      return
    }
    const response = await tracked(() => historyApi('undo', { operationIds }))
    setPetMessageData({ restoredCount: response.restoredFiles ?? 0 })
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
      message = `Undid ${plural(response.restored, 'simulated cleanup')}: ${plural(response.restoredFiles, 'file')}.`
        + (response.alreadyRestored ? `Another ${response.alreadyRestored} had already been undone.` : '')
        + (demo ? ` The cleanup list now has ${plural(demo.candidates.length, 'file')}; click the trash can to see them.` : ' Press D to open the demo list.')
      notice('They are back on the cleanup list — click the trash can to see them.')
    }
    // ② 有回應不等於全部放回來了。真的放回了、而且沒有「沒放回」也沒有「還不確定」，才 happy。
    const restoredFiles = response.restoredFiles ?? 0
    const hasFailures = (response.notRestored?.length ?? 0) > 0
    const hasUnknown = (response.unconfirmed?.length ?? 0) > 0
    if (restoredFiles > 0 && !hasFailures && !hasUnknown) setPetTransientState('happy')
    else clearPetTransientState()
  } catch (error) {
    // ③ 結果不明：寵物擔心，話裡講得出是什麼錯
    setPetMessageData({ errorMessage: safeName(error.message) })
    setPetTransientState('worried')
    message = 'The undo was not confirmed. Reload the log and try again.'
  } finally {
    historyBusy = false
    await refreshHistory()
    historyResult([
      message,
      restoredSkipped ? `Put ${plural(restoredSkipped, 'skipped file')} back into this proposal. No file was moved.` : '',
    ].filter(Boolean).join('\n'))
  }
}

async function pollHealth() {
  if (healthBusy || stopped) return
  clearTimeout(healthTimer)
  healthBusy = true
  // 記住這次輪詢送出時的動作世代：逾時的那一刻動作可能已經結束，
  // 但只要這段期間有動作跑過，這次逾時就不算數。
  const epochAtStart = actionEpoch
  try {
    if (mockOffline) throw new Error('Mock backend offline')
    // 帶 token 問（window.api 會帶）：資料夾名（watcher.watching）只給帶 token 的（U4）
    const snapshot = await window.api('/health', { signal: AbortSignal.timeout(4000) })
    // 後端回了話就是結論，動作在不在跑都一樣 —— **ok:false 也留著**，
    // systemHealthProblem 會照它講得出是資料庫壞了還是資料夾不見了。
    health = snapshot
    healthChecked = true
  } catch {
    // **沒回應**（逾時、連不上）的時候，面板自己的動作在這次輪詢期間跑過（開始時就在跑、或中途開始／結束）
    // → 多半是 server 正忙著搬檔，這次不算數，寵物維持上一次的樣子；動作結束之後的輪詢照常算（稽核 C-f14）。
    // 模擬離線（按 O）照樣算數。
    if (!mockOffline && (actionsInFlight > 0 || actionEpoch !== epochAtStart)) {
      // 刻意不動 health，也不動 healthChecked
    } else {
      health = null
      healthChecked = true
    }
  } finally {
    healthBusy = false
  }
  updateAlert()
  // 復原徽章跟著輪詢更新就夠了。掛在 updateAlert 上的話，每勾一個勾選框都會多送一次請求。
  void refreshHistoryBadge()
  // 一次輪詢只問一次 /pet/state：連拍要它、「正在讀」那一行也要它
  const petSnapshot = health ? await pollPetState() : null
  if (health) updateAlert()          // reading 變了要重畫那一行與寵物狀態
  if (health) await askAboutBursts(petSnapshot)
  // 背景那一輪問完模型之後，面板要自己跟上（不用關掉重開）
  if (health) await refreshSuggestions()
  if (!stopped) healthTimer = setTimeout(pollHealth, 5000)
}

/**
 * 主動詢問（P0）。**有新的連拍組才彈** —— 舊的組還在連拍區裡，只是不再跳出來問。
 *
 * `/pet/state` 的 `burst.newGroups` 是「還沒問過的組數」（後端把問過的組 id 記在 meta）。
 * 這裡再守一層：**只在它比上一次大的時候彈**。後端萬一沒把問過的記下來（一直回同一個數字），
 * 不守的話寵物會每五秒跳出來問一次同一批。
 *
 * 忙的時候（面板開著、正在搬檔、示範模式）不彈，**也不把數字記起來** —— 下一輪再問，
 * 不要蓋掉使用者正在看的結果。真的要彈之前先把組讀回來：讀不到就什麼都不做，
 * 彈一句「有 N 張很像」卻打不開任何東西比不彈更糟。
 */
/**
 * 面板開著的時候，把「模型產生的那幾區」重新抓一次（連拍、建議的名字、歸檔、學到的）。
 *
 * **為什麼要有**：`pet` 在背景每十分鐘問一輪模型，但面板只在打開的那一刻抓資料 ——
 * 背景問完之後，使用者盯著一個空的「Suggested names」，得關掉重開才看得到。
 * 使用者第一句話就是「這些應該直接整合在 UI」。
 *
 * **三條安全規矩**：
 *   1. **不重新套預設勾選**（不呼叫 applyBurstDefaults）—— 那會把使用者自己勾的洗掉。
 *      load() 本身已經保留「還在清單上的那幾個勾」。
 *   2. 忙的時候不做：正在搬檔、示範模式、復原面板開著，一律跳過。
 *   3. **沒變就不重畫** —— 每五秒重畫一次會把使用者正在點的東西抽掉。
 */
async function refreshSuggestions() {
  if (isDemo() || busy || historyBusy || actionsInFlight > 0 || !panel.open) return
  const before = suggestionSignature()
  try {
    await bursts.load()          // **不套預設**：那是打開面板那一刻的事
    await renames.load()
    await filings.load()
    await learned.load()
  } catch { return }             // 讀不到就維持畫面上的樣子
  // 標記「這一次是輪詢叫的」：設定區靠它決定要不要讓開（renderSettings）。
  // render() 是同步的，所以 finally 一定在它跑完之後才把旗子放下。
  if (suggestionSignature() !== before) {
    pollRedraw = true
    try { render() } finally { pollRedraw = false }
  }
}

/** 那四區現在的內容（換了才重畫）。 */
const suggestionSignature = () => JSON.stringify([
  bursts.groups.map(g => g.id),
  renames.items.map(i => i.itemId + i.suggested),
  filings.items.map(i => i.itemId + i.toFolder),
  learned.items.map(i => i.id),
])

/**
 * 每一輪輪詢問一次 `/pet/state`，**面板開著也要問** —— 「它正在讀」那一行就靠它。
 * 連拍那邊用同一份回應，不再自己打一次（一次輪詢只送一個請求）。
 */
async function pollPetState() {
  if (isDemo()) { reading = { running: false, pending: 0 }; return null }
  let state
  try { state = await window.api('/pet/state') } catch { return null }
  const r = state?.reading
  // 舊版後端沒有 reading 這一段：當成沒有在讀、沒有待讀（那一行就不顯示）
  reading = {
    running: r?.running === true,
    pending: Number.isFinite(Number(r?.pending)) ? Math.max(0, Math.floor(Number(r.pending))) : 0,
  }
  return state
}

async function askAboutBursts(state) {
  if (isDemo() || busy || historyBusy || panel.open || historyPanel.open) return
  if (!state) return
  const n = Number(state?.burst?.newGroups)
  // 舊版後端沒有 burst 這一段（n 是 NaN）：當成沒有新的組
  if (!Number.isFinite(n) || n <= 0) return
  // **記住問過哪幾組，不是問過幾組。** 拿數量當高水位的話：問過 2 組之後那 2 組被清掉、
  // 又出現 1 組新的（newGroups 從 2 掉到 1），1 ≤ 2 就再也不會問了（P0 驗證員）。
  const groups = await bursts.load()
  const fresh = groups.filter(g => g.id && !burstAsked.has(g.id))
  if (!fresh.length) return
  for (const g of fresh) burstAsked.add(g.id)
  // 記太多沒有意義：留最近 200 組（一組一個短字串）
  if (burstAsked.size > 200) for (const id of [...burstAsked].slice(0, burstAsked.size - 200)) burstAsked.delete(id)
  notice(burstAskMessage(fresh), { burst: true })
}
/** 「Pet state: …」那一行（隊友加的）。齒輪與 S 鍵是同一件事。 */
function togglePetStateLine() {
  const line = $('pet-state-debug')
  if (!line) return
  line.hidden = !line.hidden
  $('quaso-settings-toggle').setAttribute('aria-expanded', String(!line.hidden))
}
$('quaso-settings-toggle').onclick = togglePetStateLine
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
  if (key === 's') { event.preventDefault(); togglePetStateLine() }
  if (key === 'd') { event.preventDefault(); toggleDemo() }
  if (key === 'o') { event.preventDefault(); toggleOffline() }
})
window.addEventListener('pagehide', () => {
  stopped = true
  clearTimeout(healthTimer)
  bursts.clear()
  previews.clear()
}, { once: true })
pollHealth()
