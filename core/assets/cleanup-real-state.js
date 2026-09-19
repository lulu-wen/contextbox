// 本機模式：接真的清理路由，會真的搬動監看資料夾裡的檔案。
//
// 介面刻意跟 cleanup-demo-state.js 的 createDemo 一樣（candidates／selected／
// canUndo／bytes／select／apply／undo），讓面板的渲染兩個模式共用。
// 差別是 apply／undo 是 async，而且回傳的是**後端說的結果**，不是前端推算的。
//
// api 由呼叫端注入（瀏覽器是 window.api，測試是打真 server 的 fetch），
// 錯誤要帶 .code 與 .status —— 分不出錯誤種類的話，下面三種處置就沒辦法分開。
// 409 CONFLICT 的回應本體（裡面有 blockingPlan）掛在 .data（ui.html 的 api() 會掛）。
//
// 這支也放面板要講的話（applyMessage 之類）：它們只看後端的結果，不碰 DOM，
// 測試可以直接拿後端的回應餵進來比對。cleanup-demo.js 只負責把字放上畫面。

// ── 顯示用的小工具 ──────────────────────────────────────────

/**
 * 顯示用的檔名：C0／C1 控制字元與換行一律換成「·」（稽核 RC14）。
 *
 * 檔名是不可信的輸入（網頁決定下載檔的名字）。結果框是 `white-space: pre-line`，
 * 檔名裡的換行會變成畫面上的新的一行 —— `a\n搬進隔離區 99 個檔案.zip` 就能偽造一行結果。
 * U+2028／U+2029 在瀏覽器裡也會斷行，一起換掉。一個字元換一個「·」，長度不變。
 * **方向控制字元也換**（U+061C、U+200E／200F、U+202A–202E、U+2066–2069）：
 * `invoice\u202Efdp.exe` 在畫面上會顯示成像 .pdf 的檔。跟 cli.mjs 的 shown、
 * cleanup-routes.ts 的 UNSAFE_DISPLAY 是同一組字元。
 */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g
export function safeName(s) {
  return String(s ?? '').replace(CONTROL, '·')
}

export const formatBytes = n => n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB'
  : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB'

const why = w => safeName(w || '後端沒有給原因')

/**
 * 面板講「你的哪個資料夾」時用的字（稽核第三波 U4）。以前寫死 Downloads ——
 * 清理範圍是 cleanup.roots，開了 cleanup.screenshots 就多一個截圖資料夾，改過設定的也不叫 Downloads。
 *
 * watcher 是帶 token 的 /health 的 watcher：watching 是每個清理根目錄的資料夾名
 * （家目錄那個後端給空字串，不給名字），watchingCount 是一共幾個。沒帶 token 的版本 watching 是空的。
 * 名字是不可信的輸入（資料夾可以叫任何名字）：一律 safeName，最多列三個，多的講「等 N 個」。
 * 拿不到名字就講「監看資料夾」，不猜。
 */
export function folderPhrase(watcher, { quoted = true } = {}) {
  const list = Array.isArray(watcher?.watching) ? watcher.watching : []
  const count = Number.isInteger(watcher?.watchingCount) ? watcher.watchingCount : 0
  const total = Math.max(count, list.length)
  const names = list.filter(n => typeof n === 'string' && n).map(n => quoted ? `「${safeName(n)}」` : safeName(n))
  if (!names.length) return total > 1 ? `${total} 個監看資料夾` : '監看資料夾'
  const shown = names.slice(0, 3).join('、')
  return names.length === total && total <= 3 ? shown : `${shown}${quoted ? '' : ' '}等 ${total} 個資料夾`
}

// ── 套用的結果 ──────────────────────────────────────────────

/** 從後端的計畫 DTO 取出面板要的結果。**只照 outcome 分類**，不用勾選數推算。 */
export function applyOutcome(plan) {
  const pick = o => plan.items.filter(i => i.outcome === o).map(i => ({ itemId: i.itemId, name: i.name, why: i.why }))
  return {
    status: plan.status,
    planId: plan.id,
    moved: plan.quarantinedCount,
    // 沒搬成（原檔確定還在原位）
    failed: pick('failed'),
    // 搬到一半中斷：檔案可能已經在隔離區，**不可以**說「還在原位」（RC17）
    unknown: pick('unknown'),
    bytesFreed: plan.quarantinedBytes,
    undoable: plan.undoable,
  }
}

/**
 * 套用之後結果框與寵物要講的話。
 * 「原檔都還在原位」**只在沒搬成的全部是 failed 時才說**（RC17(3)）：
 * unknown 的檔可能已經在隔離區，照實講「狀態不明」。
 */
export function applyMessage(r) {
  const failed = r.failed ?? [], unknown = r.unknown ?? []
  if (r.status === 'dismissed') {
    return { text: '這份計畫已經被放棄了，這次沒有動任何檔案。', notice: '這次沒有動任何檔案。' }
  }
  const lines = [`搬進隔離區 ${r.moved} 個檔案，${formatBytes(r.bytesFreed ?? 0)}。七天內可以復原。`]
  if (failed.length && !unknown.length) {
    lines.push(`有 ${failed.length} 個沒搬（原檔都還在原位，沒有任何東西被刪除）：`)
    for (const f of failed) lines.push(`・${safeName(f.name)} —— ${why(f.why)}`)
  } else if (unknown.length) {
    lines.push(`有 ${failed.length + unknown.length} 個沒有確定搬好：`)
    for (const f of failed) lines.push(`・${safeName(f.name)} —— 沒搬，原檔還在原位：${why(f.why)}`)
    for (const u of unknown) lines.push(`・${safeName(u.name)} —— 狀態不明：${why(u.why)}`)
  }
  if (r.reloadFailed) lines.push('（清單沒有重新整理成功。關掉面板再打開就會更新。）')
  const notice = r.moved ? '整理好了！想改變心意，隨時可以復原這次清理。'
    : unknown.length ? '這次的結果還不確定，狀態寫在面板上。'
    : '這次一個都沒搬成，原因寫在面板上。'
  return { text: lines.join('\n'), notice }
}

/**
 * 撞到卡住的計畫（或面板一打開就查到）時的提示。
 *
 * - **還沒開始的**（RC8）：兩個出口，「繼續上次那份」或「放棄上次那份」（不動任何檔）。
 * - **做到一半中斷的**（plan.started，第二輪 R2-5b）：已經有搬移紀錄（多半有檔搬進隔離區，也可能只有
 *   搬失敗的紀錄），**不能放棄**（後端的 release 一定回 409）。
 *   以前照樣說「放棄上次那份：不動任何檔案」，按下去 409（稽核 B-r7）。
 *   出口是「繼續上次那份」與「放回已經搬走的」（undo）。幾個已經在隔離區照後端的逐項結果講：
 *   moved 才算「已經在隔離區」；unknown（搬到一半中斷）說不準在哪，另外講；數不出來（plan.moved 是 null）
 *   就只說「有些可能已經在隔離區」，不猜數字。
 * - plan.others：另外還有幾份沒做完的（面板打開時查 ?pending=1 才知道），一次只提示一份。
 */
export function pendingPlanMessage(plan) {
  const names = plan.items.map(i => safeName(i.name)).join('、')
  const others = plan.others > 0
    ? `\n（另外還有 ${plan.others} 份沒做完的：處理完這一份，關掉面板再打開就會看到下一份。）` : ''
  if (!plan.started) {
    return `上次有一份清理沒做完：${names}（${plan.items.length} 個）。\n`
      + '按「繼續上次那份」會處理它 —— 只會動這幾個，不會動到你現在勾的其他檔案。\n'
      + '按「放棄上次那份」會把它作廢：不動任何檔案，這些檔也還會留在清單上。' + others
  }
  if (plan.restoring) {
    // 這份已經開始復原了：後端的 apply 會回 409（RESTORE_STARTED），所以不給「繼續上次那份」
    return `上次有一份復原做到一半中斷了：${names}（${plan.items.length} 個）。\n`
      + '按「放回已經搬走的」會接著放回，放回去的不會再動。\n'
      + '這份已經開始復原了，不能繼續清理，也不能放棄。'
      + (plan.others > 0 ? `\n（另外還有 ${plan.others} 份沒做完的：處理完這一份，關掉面板再打開就會看到下一份。）` : '')
  }
  const moved = plan.moved, unsure = plan.unsure ?? 0
  const halfway = `${unsure} 個搬到一半、說不準在原位還是在隔離區`
  const where = moved == null ? '其中有些可能已經在隔離區'
    : moved > 0 ? `其中 ${moved} 個已經在隔離區` + (unsure ? `，${halfway}` : '')
    : unsure ? `其中 ${halfway}`
    : '目前沒有檔在隔離區'
  return `上次有一份清理做到一半中斷了：${names}（${plan.items.length} 個），${where}。\n`
    + '按「繼續上次那份」會接著搬這份裡還沒搬的 —— 只會動這幾個，不會動到你現在勾的其他檔案。\n'
    + '按「放回已經搬走的」會把在隔離區的放回原位，還沒搬的不會動。\n'
    + '這份已經開始搬了，不能直接放棄。' + others
}

// ── 復原的結果 ──────────────────────────────────────────────

/**
 * 復原前「還在（或可能還在）隔離區」的項目：outcome 是 moved，**或 unknown**（稽核第三波 U1）。
 * unknown 有兩種：復原到一半中斷（檔多半還在隔離區，再按一次復原會接完），或搬到一半中斷。
 * 兩種 undo 都處理得了，所以都要送 undo、都要算。以前只看 moved：復原到一半中斷的那份
 * 在歷史面板勾了也不送 undo，結果框說「先前已經復原過了」，檔案還在隔離區。
 */
const maybeInQuarantine = i => i.outcome === 'moved' || i.outcome === 'unknown'

/**
 * 復原前在隔離區的那些，復原之後各自的下場。原因照後端的逐項結果。
 * - 放回：outcome 變成 restored
 * - 還不確定：還是 unknown（後端也說不準檔案在哪）—— **不可以說「沒放回」**
 * - 沒放回：其他（還是 moved：隔離區的檔被改過、原本的資料夾被刪了……）。
 *   後端沒給原因的話用 fallbackWhy（undo 回錯時就是那個錯誤訊息）。
 */
function restoreDelta(beforeItems, after, fallbackWhy = null) {
  const now = new Map(after.items.map(i => [i.itemId, i]))
  const back = [], notBack = [], unsure = [], stayed = []
  for (const was of beforeItems) {
    const i = now.get(was.itemId)
    // 搬到一半中斷的（復原前是 unknown），復原時後端確認檔案根本沒搬、還在原位 → 結果變成
    // failed。那不是「沒放回」，是本來就沒離開過，兩邊都不列（CLI 印「當初就沒有搬走」）。
    if (was.outcome === 'unknown' && ['failed', 'skipped', 'pending', 'cancelled'].includes(i?.outcome)) {
      stayed.push({ itemId: was.itemId, name: was.name })
      continue
    }
    if (i?.outcome === 'restored') back.push(i)
    else if (i?.outcome === 'unknown') unsure.push({ itemId: was.itemId, name: was.name, why: i.why ?? fallbackWhy })
    else notBack.push({ itemId: was.itemId, name: was.name, why: i?.why ?? fallbackWhy })
  }
  return { back, notBack, unsure, stayed }
}

const renamedOf = items => items.filter(i => i.restoredAs).map(i => ({ name: i.name, restoredAs: i.restoredAs }))
const nameAndWhy = list => list.map(({ name, why }) => ({ name, why }))

/** 沒放回的那幾行 */
function notRestoredLines(ok, notRestored) {
  return [`${ok} 個放回；${notRestored.length} 個沒放回：`,
    ...notRestored.map(x => `・${safeName(x.name)} —— ${why(x.why)}`)]
}

/** 還不確定放回了沒有的那幾行（U1、U2）。**不說「沒放回」** —— 可能已經放回去了。 */
function unconfirmedLines(unconfirmed) {
  return [`有 ${unconfirmed.length} 個還不確定放回了沒有：`,
    ...unconfirmed.map(x => `・${safeName(x.name)} —— ${why(x.why)}`)]
}

/**
 * 寵物的話看結果（RC9）：全部放回、部分放回、一個都沒放回各一種；
 * 有還不確定的（U2），照實列出放回、沒放回、不確定各幾個。
 */
function restoreNotice(ok, notRestored, unsure = 0) {
  if (unsure) {
    return [ok && `放回了 ${ok} 個`, notRestored && `有 ${notRestored} 個沒放回來`, `有 ${unsure} 個還不確定放回了沒有`]
      .filter(Boolean).join('，') + '，狀態寫在面板上。'
  }
  if (!notRestored) return ok ? '都幫你放回來了！' : '這次沒有要放回的檔案。'
  return ok ? `放回了 ${ok} 個，有 ${notRestored} 個沒放回來，原因寫在面板上。`
    : '這次一個都沒放回來，原因寫在面板上。'
}

/** 面板上「復原這次清理」與「放回已經搬走的」之後要講的話。r 是 createReal().undo() 或 putBack() 的回傳。 */
export function undoMessage(r) {
  const notRestored = r.notRestored ?? [], unconfirmed = r.unconfirmed ?? []
  const lines = notRestored.length ? notRestoredLines(r.restored, notRestored)
    : r.restored ? [`放回原位 ${r.restored} 個檔案。`]
    : unconfirmed.length ? []
    : ['這次沒有需要放回的檔案。']
  for (const x of r.renamed ?? []) {
    lines.push(`・${safeName(x.name)} 的原位置已經有同名檔案，放回來的這份叫 ${safeName(x.restoredAs)}（沒有覆蓋任何檔案）。`)
  }
  if (unconfirmed.length) lines.push(...unconfirmedLines(unconfirmed))
  if (notRestored.length) lines.push('沒放回的可以從「復原最近動作」再試一次。')
  if (unconfirmed.length) lines.push('還不確定的，可以從「復原最近動作」看它還在不在；還列在那裡的可以再復原一次。')
  // 搬到一半中斷、復原時後端確認其實沒搬過（還在原位）的：講一句（跟歷史面板、CLI 同一個意思）。
  // 不講的話，逐項才說「按復原會把在隔離區的放回原位」，按下去只剩「這次沒有需要放回的檔案」，那個檔的下落沒交代
  for (const x of r.neverMoved ?? []) lines.push(`・${safeName(x.name)} 當初就沒有搬走，本來就在原位。`)
  // 「放回已經搬走的」（做到一半中斷的那份）：還沒搬的那幾個從來沒動過，講一句，不然使用者會以為它們也被放回了
  if (r.untouched) lines.push(`這份裡還沒搬的 ${r.untouched} 個沒有動過。`)
  if (r.reloadFailed) lines.push('（清單沒有重新整理成功。關掉面板再打開就會更新。）')
  return { text: lines.join('\n'), notice: restoreNotice(r.restored, notRestored.length, unconfirmed.length) }
}

/** 歷史面板「復原勾選動作」之後要講的話。r 是 createRealHistory 的 undo 回傳。 */
export function historyUndoMessage(r) {
  const notRestored = r.notRestored ?? [], unconfirmed = r.unconfirmed ?? []
  const lines = notRestored.length ? notRestoredLines(r.restoredFiles, notRestored)
    : r.restoredFiles ? [`已復原 ${r.restored} 次清理，共 ${r.restoredFiles} 個檔案放回原位。`]
    : unconfirmed.length ? []
    : [r.alreadyRestored ? `勾選的 ${r.alreadyRestored} 筆先前已經復原過了，這次沒有動任何檔案。` : '這次沒有需要放回的檔案。']
  if (r.alreadyRestored && (notRestored.length || r.restoredFiles || unconfirmed.length)) {
    // 前面沒有別的句子（只有「還不確定」）時，「另有」接不上
    lines.push(lines.length ? `另有 ${r.alreadyRestored} 筆先前已復原。` : `勾選的 ${r.alreadyRestored} 筆先前已經復原過了。`)
  }
  for (const x of r.renamed ?? []) {
    lines.push(`・${safeName(x.name)} → ${safeName(x.restoredAs)}（原位置已經有同名檔案，沒有覆蓋）。`)
  }
  if (unconfirmed.length) {
    lines.push(...unconfirmedLines(unconfirmed), '還列在上面紀錄裡的，就是還可以復原的，可以再勾起來試一次。')
  }
  // 搬到一半中斷、其實沒搬過的（後端確認還在原位）：講一句，不然使用者會以為它不見了。CLI 印同一個意思
  for (const x of r.neverMoved ?? []) lines.push(`・${safeName(x.name)} 當初就沒有搬走，本來就在原位。`)
  return { text: lines.join('\n'), notice: restoreNotice(r.restoredFiles, notRestored.length, unconfirmed.length) }
}

// ── 面板的狀態 ──────────────────────────────────────────────

export function createReal(api, { uuid = () => crypto.randomUUID() } = {}) {
  let candidates = [], needsHuman = [], selected = new Set(), loaded = false
  // 目前這一次清理的請求。**同一份勾選重送時沿用同一個 requestId**，
  // 後端靠它認出「這是同一次」而回傳同一份計畫，不會多建一份、也不會多搬一次。
  let request = null           // { requestId, candidateIds, planId?, uncertain }
  // 擋住這次勾選的那份計畫（後端 409 帶回來的 blockingPlan），或面板打開時查到的待處理計畫
  // （checkPending）。要先給使用者看，**不可以自動套用** —— 那份的內容可能跟現在的勾選不一樣。
  // started：開始過（已經有搬移紀錄）→ 不能放棄，出口是繼續或放回；moved／unsure：幾個已經在隔離區、
  // 幾個搬到一半說不準（數不出來是 null）；inQuarantine：提示那時在（或可能在）隔離區的項目，放回時拿來對。
  let pendingPlan = null       // { id, items, started, moved?, unsure?, inQuarantine?, others?, uncertain? }
  let lastPlan = null          // { id, undoable, inQuarantine: 還在（或可能還在）隔離區的項目 }

  const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) })
  const planUrl = id => `/cleanup/plans/${encodeURIComponent(id)}`
  const planPath = (id, action) => `${planUrl(id)}/${action}`
  const sameIds = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

  async function load() {
    const r = await api('/cleanup/candidates?limit=1000')
    const before = new Set(candidates.map(c => c.itemId))
    const wanted = selected
    candidates = r.candidates ?? []
    needsHuman = r.needsHuman ?? []
    // 第一次載入用預設勾選。之後重載：**還在的那些保留使用者的選擇**
    // （使用者對它們的意圖沒變），新出現的才用預設。
    selected = new Set(candidates
      .filter(c => loaded && before.has(c.itemId) ? wanted.has(c.itemId) : c.defaultChecked)
      .map(c => c.itemId))
    loaded = true
  }

  /**
   * 動作已經做完、結果也算好了，才重載清單。**重載失敗不可以蓋掉結果**（RC8）——
   * 檔案已經搬了，丟例外的話畫面會說「失敗」，使用者以為什麼都沒發生。
   */
  async function reloadInto(result) {
    try { await load() } catch { result.reloadFailed = true }
    return result
  }

  /**
   * 從計畫的逐項結果（GET /cleanup/plans/:id）算出提示要的東西。
   * started 沒給（面板打開時查到的那份，列表沒有這個欄位）就看逐項結果：還沒套用（proposed）的計畫裡，
   * 只要有一項不是 pending（在隔離區、搬到一半、失敗過、略過），就是套用開始過、有搬移紀錄 ——
   * 跟後端 blockingPlan.started 的判斷一致。只差一種：帶 skippedIds 套用、還沒碰到任何一個檔就中斷的，
   * 略過已經寫下、搬移紀錄還沒有，後端說沒開始。這裡算成開始過（偏保守）：頂多少給一個「放棄」，
   * 反過來會給出一定 409 的「放棄」。**已經在隔離區只算 moved**；unknown 說不準在哪，另外數。
   */
  function pendingFrom(plan, started) {
    return {
      id: plan.id,
      items: plan.items.map(i => ({ itemId: i.itemId, name: i.name, bytes: i.bytes })),
      started: started ?? plan.items.some(i => i.outcome !== 'pending'),
      // 復原到一半中斷：再 apply 一定 409，出口只剩「接著放回」（第二輪第二階段驗證員）
      restoring: plan.restoring === true,
      moved: plan.items.filter(i => i.outcome === 'moved').length,
      unsure: plan.items.filter(i => i.outcome === 'unknown').length,
      inQuarantine: plan.items.filter(maybeInQuarantine),
    }
  }

  /**
   * 409 帶回來的 blockingPlan → 提示用的 pendingPlan。**started 照後端說的**（R2-5b）。
   * 開始過的再讀一次逐項結果，才講得出幾個已經在隔離區；讀不到就不講數字（moved: null），不猜。
   */
  async function fromBlocking(b) {
    const started = b.started === true
    const restoring = b.restoring === true
    if (!started) return { id: b.id, items: b.items ?? [], started, restoring }
    try { return { ...pendingFrom(await api(planUrl(b.id)), true), restoring } }
    catch { return { id: b.id, items: b.items ?? [], started, restoring, moved: null, unsure: null } }
  }

  // 勾選要鎖住的只有兩種情況：
  //   1. 結果不明（網路斷了、沒有 status）：計畫可能已經建在後端，改了勾選會撞上自己那份
  //   2. 正在提示擋住的那份：使用者要先選「繼續」或「放棄」
  // 伺服器**明確回了錯**（有 status）的時候結果是確定的，不鎖（RC8）。
  const isLocked = () => Boolean(pendingPlan) || Boolean(request?.uncertain)

  async function applyPlanId(planId) {
    const plan = await post(planPath(planId, 'apply'))
    // 先把結果算好、狀態收乾淨，再重載清單
    const outcome = applyOutcome(plan)
    lastPlan = { id: plan.id, undoable: plan.undoable, inQuarantine: plan.items.filter(maybeInQuarantine) }
    request = null
    pendingPlan = null
    return reloadInto(outcome)
  }

  return {
    load,
    get candidates() { return candidates },
    get needsHuman() { return needsHuman },
    get selected() { return selected },
    get locked() { return isLocked() },
    /** 結果不明（網路斷了）：這時候按鈕是「再試一次」，會沿用同一份 */
    get uncertain() { return Boolean(request?.uncertain || pendingPlan?.uncertain) },
    get pendingPlan() { return pendingPlan },
    // 後端的 undoable 只算確定在隔離區的（moved）。搬到一半中斷的（unknown）檔可能也在隔離區，
    // 逐項的話叫人按「復原」把它放回原位 —— 面板就要有「復原」可按（第二輪，MOVE_INTERRUPTED 改寫時一起）
    get canUndo() { return Boolean(lastPlan?.undoable || lastPlan?.inQuarantine?.length) },
    get bytes() { return candidates.filter(c => selected.has(c.itemId)).reduce((n, c) => n + c.bytes, 0) },

    select(id, checked) {
      if (isLocked()) return
      if (!candidates.some(c => c.itemId === id)) return
      if (checked) selected.add(id)
      else selected.delete(id)
      // 不在這裡丟掉 request：按下清理時拿勾選的 id 跟它比，一樣（例如取消又勾回來）就沿用
      // 同一份 —— 計畫已經建好、只是套用被伺服器拒絕的話，再按一次是重試那一份，
      // 不是再建一份去撞自己那份的 CONFLICT。不一樣才換新的請求。
    },

    async apply() {
      // 使用者看過擋住的那份、按了「繼續上次那份」
      if (pendingPlan) {
        const plan = pendingPlan
        // 已經開始復原的那份，後端的 apply 一定 409 —— 不要送，直接講出口
        if (plan.restoring) throw new Error('這份已經開始復原了，不能繼續清理。請選「放回已經搬走的」。')
        try { return await applyPlanId(plan.id) }
        catch (e) {
          // 伺服器明確回了錯：它說了沒做成，解鎖，讓使用者改勾選或放棄（RC8）。
          // 網路斷了：不知道做了沒有，還是提示同一份；再按一次「繼續」是冪等的。
          if (e.status) pendingPlan = null
          else plan.uncertain = true
          throw e
        }
      }

      // **結果不明的時候，原封不動沿用上一次的請求。**
      // 不可以用「現在的勾選」重算再比：重新打開面板會 load()，已經搬走的檔
      // 從清單消失、勾選跟著變，一比就不同 → 換掉 requestId、丟掉 planId ——
      // 使用者看到「請至少選擇一個檔案」，卻不知道檔案其實已經搬走了。
      if (!request?.uncertain) {
        // **送勾了的那些，而且每個檔的每一條理由都要送。**
        // 不可以「不帶 id 讓後端拿預設勾的，再用 skippedIds 扣掉」——
        // 那樣使用者主動勾起來的低信心檔根本不在計畫裡，勾了卻沒搬。
        const candidateIds = candidates.filter(c => selected.has(c.itemId))
          .flatMap(c => c.candidateIds).sort()
        if (!candidateIds.length) throw new Error('請至少選擇一個檔案。')
        if (!request || !sameIds(request.candidateIds, candidateIds)) {
          request = { requestId: uuid(), candidateIds, planId: null, uncertain: false }
        }
      }
      const { candidateIds } = request

      if (!request.planId) {
        let plan
        try {
          // 送出之後、拿到回應之前，後端可能已經建好了 —— 先當成不確定
          request.uncertain = true
          plan = await post('/cleanup/plans', { candidateIds, requestId: request.requestId })
        } catch (e) {
          // 沒有 status ＝ 網路斷了，不確定建了沒有：維持鎖住，下次用同一個 requestId 重送。
          if (!e.status) throw e
          // 有 status ＝ 伺服器說了沒建成。
          request = null
          if (e.code === 'STALE_CANDIDATE') {
            // **清單變了就一個都不搬**，重載給使用者再看一眼。不自動重試。
            await load()
            return { status: 'stale' }
          }
          if (e.code === 'CONFLICT') {
            // 有別的計畫佔著這次勾的檔（上次關掉頁面留下的、或 CLI 建的）。
            // **用後端說的「擋住這次勾選的那一份」**（RC7）。以前自己拿「最新一份沒做完的」，
            // 稽查實測：舊計畫佔著 a、新計畫只有 z，只勾 a，按「繼續」搬走的是 z。
            // 後端沒給（找不到）就照實丟錯，不猜。
            const b = e.data?.blockingPlan
            if (b?.id) {
              pendingPlan = await fromBlocking(b)
              return { status: 'pending-plan', plan: pendingPlan }
            }
          }
          throw e
        }
        request.planId = plan.id
      }

      try {
        return await applyPlanId(request.planId)
      } catch (e) {
        // applyPlanId 只有在「套用」這個請求本身失敗時才丟（重載失敗不丟，見 reloadInto），
        // 所以 request 還在。計畫已經建好了：同樣的勾選再按一次會沿用同一份。
        // 伺服器明確回錯 → 不鎖，勾選可以改（改了就換新的請求）；網路斷了 → 鎖住，只能再試一次。
        if (request) request.uncertain = !e.status
        throw e
      }
    },

    /**
     * 面板打開時查有沒有待處理的計畫（第二輪 R2-5）：有就先提示最新的那一份，不用等撞到 CONFLICT。
     * 以前只從 409 的 blockingPlan 得知 —— 計畫裡的檔不在清單上（被使用者刪了、被別處清過）時，
     * 永遠撞不到，面板完全沒有入口，寵物卻一直說「有 1 份清單等你確認」（稽核 A-exp9）。
     *
     * - **鎖住的時候不查**：結果不明的那份（自己剛建的）要讓使用者「再試一次」，不可以被換掉。
     * - 查不到（網路斷、讀不到那份的細節）就當沒有：清單照常，撞到 CONFLICT 仍是入口。
     *   不猜「沒開始」—— 猜錯的話會給出一定是 409 的「放棄」。
     * - 一次只提示一份；others 是另外還有幾份。
     */
    async checkPending() {
      if (isLocked()) return pendingPlan
      let list, plan
      try {
        list = await api('/cleanup/plans?pending=1&limit=1')
        const first = list?.operations?.[0]
        if (!first?.id) return null
        plan = await api(planUrl(first.id))
      } catch { return null }
      if (isLocked()) return pendingPlan
      if (plan?.status !== 'proposed' || !Array.isArray(plan.items)) return null
      pendingPlan = { ...pendingFrom(plan), others: Math.max(0, (Number(list.total) || 1) - 1) }
      return pendingPlan
    },

    /**
     * 放棄擋住的那份（RC8「放棄上次那份」）。呼叫後端的 release：
     * 計畫作廢，**不動任何檔、不作廢候選** —— 那些檔還會留在清單上，使用者可以重新勾。
     * **開始過的那份不送**（R2-5b）：後端一定回 409，面板也不給這顆按鈕；提示維持原樣。
     */
    async release() {
      if (!pendingPlan) throw new Error('目前沒有要放棄的計畫。')
      if (pendingPlan.started) {
        throw new Error('這份已經開始搬了，不能放棄。請選「繼續上次那份」或「放回已經搬走的」。')
      }
      const plan = pendingPlan
      try { await post(planPath(plan.id, 'release')) }
      catch (e) {
        // 伺服器說不行（例如那份已經開始執行）：照實講、解鎖。
        // 網路斷了：不知道放棄了沒有；放棄是冪等的，再按一次就好。
        if (e.status) pendingPlan = null
        else plan.uncertain = true
        throw e
      }
      pendingPlan = null
      request = null
      return reloadInto({ status: 'released', planId: plan.id, items: plan.items })
    },

    /**
     * 「放回已經搬走的」：對做到一半中斷的那份（pendingPlan.started）送 undo（第二輪 R2-5b）。
     * 還沒搬的那幾個不會動（沒碰過的逐項結果是 cancelled），回傳的 untouched 是它們的個數。
     *
     * 放回幾個照**提示那時在隔離區的那些**逐一對（跟 undo 一樣，RC9）：回應在網路上丟了、再按一次，
     * 第一次其實已經放回的照樣算放回，不會變成「這次沒有需要放回的檔案」。
     * 提示時沒讀到逐項結果的（撞到 CONFLICT 之後讀不到），送出之前先讀一次；讀不到就不送。
     * 錯誤的處置跟「繼續」「放棄」一樣：伺服器明確回錯 → 解鎖；網路斷了 → 還是那一份。
     */
    async putBack() {
      if (!pendingPlan?.started) throw new Error('目前沒有做到一半的計畫要放回。')
      const plan = pendingPlan
      if (!plan.inQuarantine) plan.inQuarantine = (await api(planUrl(plan.id))).items.filter(maybeInQuarantine)
      let after
      try { after = await post(planPath(plan.id, 'undo')) }
      catch (e) {
        if (e.status) pendingPlan = null
        else plan.uncertain = true
        throw e
      }
      const { back, notBack, unsure, stayed } = restoreDelta(plan.inQuarantine, after)
      lastPlan = { id: after.id, undoable: after.undoable, inQuarantine: after.items.filter(maybeInQuarantine) }
      pendingPlan = null
      request = null
      // 「還沒搬的」：提示那時就不在隔離區的那些（沒碰過的 cancelled、搬過但失敗的 failed、略過的）。
      // 提示時在（或可能在）隔離區的，照上面逐一對過了 —— 搬到一半、確認沒搬過的另外講（neverMoved），不重複算
      const wasIn = new Set(plan.inQuarantine.map(i => i.itemId))
      const untouched = after.items.filter(i => !wasIn.has(i.itemId)
        && ['cancelled', 'failed', 'skipped', 'pending'].includes(i.outcome)).length
      return reloadInto({
        status: after.status,
        planId: after.id,
        restored: back.length,
        renamed: renamedOf(back),
        notRestored: nameAndWhy(notBack),
        unconfirmed: nameAndWhy(unsure),
        neverMoved: stayed.map(({ name }) => ({ name })),
        untouched,
      })
    },

    async undo() {
      if (!lastPlan) throw new Error('目前沒有可以復原的清理。')
      const before = lastPlan.inQuarantine
      const plan = await post(planPath(lastPlan.id, 'undo'))
      // 放回幾個、沒放回哪幾個，照復原前在隔離區的那些逐一對（RC9）。
      // 不可以用 restoredCount：它算的是這份計畫「曾經」放回的全部，重按一次會重複算。
      const { back, notBack, unsure, stayed } = restoreDelta(before, plan)
      lastPlan = { id: plan.id, undoable: plan.undoable, inQuarantine: plan.items.filter(maybeInQuarantine) }
      // **從後端重載，不要自己把檔加回清單。** 復原過的檔 A 的規則不會再提議
      // （你復原過就代表想留著），前端加回去的話，勾它會撞 STALE。
      return reloadInto({
        status: plan.status,
        planId: plan.id,
        restored: back.length,
        // 原位置被佔時放回來的那份會改名。要講出來，不然使用者以為「放回原位」
        renamed: renamedOf(back),
        notRestored: nameAndWhy(notBack),
        unconfirmed: nameAndWhy(unsure),
        // 搬到一半中斷、復原時確認其實沒搬過的（只有 unknown 的套用結果按「復原」會碰到）
        neverMoved: stayed.map(({ name }) => ({ name })),
      })
    },
  }
}

// 歷史面板的轉接器：把 C 的 demo 歷史介面（historyApi）接到真的路由。
// 回應形狀跟 /demo/cleanup/history 與 /demo/cleanup/undo 一樣（多 notRestored 與 unconfirmed），
// C 的 renderHistory 兩個模式共用。
export function createRealHistory(api) {
  const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) })
  return async function history(path, body) {
    if (path.startsWith('history') && body === undefined) {
      const q = new URLSearchParams(path.split('?')[1] ?? '')
      q.set('undoable', '1')
      return api('/cleanup/plans?' + q.toString())
    }
    if (path === 'undo') {
      const ids = [...new Set(body?.operationIds ?? [])]
      let restored = 0, restoredFiles = 0, alreadyRestored = 0
      const restoredItems = [], renamed = [], notRestored = [], unconfirmed = [], neverMoved = []
      for (const id of ids) {
        const enc = encodeURIComponent(id)
        // **先看復原前還有哪些在隔離區。** undo 是冪等的：已經復原過的再送一次，
        // 後端回的計畫長得一模一樣（項目都是 restored）—— 只看回應的話，
        // 重送會被算成「又放回來一次」。
        const before = await api(`/cleanup/plans/${enc}`)
        // 復原到一半中斷的（unknown）也算：檔多半還在隔離區，送 undo 會把它接完（U1）
        const inQuarantine = before.items.filter(maybeInQuarantine)
        // 「先前已復原」**只算復原之前就沒有東西在隔離區的**（RC9）。
        // 以前用「勾了幾筆 − 放回幾筆」，放不回來的（隔離區的檔被改過）也被算成「先前已復原」。
        if (!inQuarantine.length) { alreadyRestored++; continue }
        let plan, fallbackWhy = null
        try { plan = await post(`/cleanup/plans/${enc}/undo`) }
        catch (e) {
          // 網路斷了：不知道放回去沒有，交給面板說「還沒確認」。
          if (!e.status) throw e
          // 伺服器明確回錯 —— 但可能是放回幾個之後才出錯（U2）。以前整份列為「沒放回」，
          // 放回去的那幾個也被說成沒放回。**再讀一次這份計畫**，照逐項結果重算；
          // 還在隔離區而後端沒給原因的，原因就是這個錯誤。
          try { plan = await api(`/cleanup/plans/${enc}`) }
          catch {
            // 也讀不到：不知道放回了哪幾個。**不可以說「沒放回」**，照實說還不確定。
            for (const i of inQuarantine) unconfirmed.push({ name: i.name, why: e.message })
            continue
          }
          fallbackWhy = e.message
        }
        const { back, notBack, unsure, stayed } = restoreDelta(inQuarantine, plan, fallbackWhy)
        neverMoved.push(...stayed.map(({ name }) => ({ name })))
        renamed.push(...renamedOf(back))
        notRestored.push(...nameAndWhy(notBack))
        unconfirmed.push(...nameAndWhy(unsure))
        if (back.length) {
          restored++
          restoredFiles += back.length
          restoredItems.push(...back.map(i => ({ itemId: i.itemId, name: i.name, bytes: i.bytes })))
        }
      }
      return { restored, restoredFiles, restoredItems, alreadyRestored, notRestored, unconfirmed, neverMoved, operationIds: ids, renamed }
    }
    throw new Error('本機模式不支援這個歷史操作：' + path)
  }
}
