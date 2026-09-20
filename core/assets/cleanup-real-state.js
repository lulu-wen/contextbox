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

/** 數字＋名詞。1 不加 s —— 畫面上的「1 files」看起來像程式壞了。 */
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

export const formatBytes = n => n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB'
  : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB'

const why = w => safeName(w || 'the backend gave no reason')

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
  const names = list.filter(n => typeof n === 'string' && n).map(n => quoted ? `“${safeName(n)}”` : safeName(n))
  if (!names.length) return total > 1 ? `${total} watched folders` : 'the watched folder'
  const shown = names.slice(0, 3).join(', ')
  return names.length === total && total <= 3 ? shown : `${shown} and more (${total} folders)`
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
    // **只信後端說的**（稽核第三輪 R3-17）。面板不可以用 moved === 0 去猜：
    // 「全部搬失敗」跟「這份先前就跑完了、這次一個檔都沒動」對使用者是兩件完全不同的事。
    // 後端還沒加這兩個欄位時一律 false（舊 server 配新面板時照舊的樣子講）。
    noop: plan.noop === true,
    stoppedEarly: plan.stoppedEarly === true,
  }
}

/**
 * 套用之後結果框與寵物要講的話。
 * 「原檔都還在原位」**只在沒搬成的全部是 failed 時才說**（RC17(3)）：
 * unknown 的檔可能已經在隔離區，照實講「狀態不明」。
 *
 * **後端說 noop 的時候完全不走下面那一段**（稽核第三輪 R3-17）：跑完過的計畫再 apply 是
 * 原樣回傳，一個檔都不會動。照 moved 去印的話，使用者按了「繼續上次那份」會看到
 * 「搬進隔離區 0 個檔案…七天內可以復原」—— 跟剛清完一模一樣，只差數字是 0。
 */
export function applyMessage(r) {
  const failed = r.failed ?? [], unknown = r.unknown ?? []
  if (r.status === 'dismissed') {
    return { text: 'That plan was already dropped. Nothing moved this time.', notice: 'Nothing moved this time.' }
  }
  if (r.noop) {
    return {
      text: 'Nothing happened this time: this list had already been dealt with, so no file moved.\n'
        + 'To clean up other files, close the panel, open it again and tick them.',
      notice: 'Nothing moved this time.',
    }
  }
  const lines = [`Moved ${plural(r.moved, 'file')} (${formatBytes(r.bytesFreed ?? 0)}) to quarantine. You can undo this for seven days.`]
  if (failed.length && !unknown.length) {
    lines.push(`${failed.length} did not move (every original is still where it was — nothing was deleted):`)
    for (const f of failed) lines.push(`- ${safeName(f.name)} — ${why(f.why)}`)
  } else if (unknown.length) {
    lines.push(`${failed.length + unknown.length} are not confirmed moved:`)
    for (const f of failed) lines.push(`- ${safeName(f.name)} — did not move, the original is still where it was: ${why(f.why)}`)
    for (const u of unknown) lines.push(`- ${safeName(u.name)} — state unknown: ${why(u.why)}`)
  }
  // 中途停下來（例如清理鎖被別的動作接走）：已經做到的照實講，但不可以說成「做完了」
  if (r.stoppedEarly) {
    lines.push('This run stopped partway and is not finished — press “Finish the last plan” next time and it picks up the rest of this list.')
  }
  if (r.reloadFailed) lines.push('(The list did not refresh. Close the panel and open it again to see the current state.)')
  const notice = r.stoppedEarly ? 'This run stopped partway. The panel has the details.'
    : r.moved ? 'All tidied up. Changed your mind? You can undo this cleanup any time.'
    : unknown.length ? 'The result is not certain yet. The panel has the details.'
    : 'Nothing moved this time. The panel says why.'
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
  const names = plan.items.map(i => safeName(i.name)).join(', ')
  const others = plan.others > 0
    ? `\n(${plural(plan.others, 'more plan')} still unfinished. Deal with this one, then close the panel and open it again to see the next.)` : ''
  if (!plan.started) {
    return `A cleanup from last time was never finished: ${names} (${plural(plan.items.length, 'file')}).\n`
      + '“Finish the last plan” deals with it — only these files, not the other ones you have ticked now.\n'
      + '“Drop the last plan” voids it: nothing moves, and these files stay on the list.' + others
  }
  if (plan.restoring) {
    // 這份已經開始復原了：後端的 apply 會回 409（RESTORE_STARTED），所以不給「繼續上次那份」
    return `An undo from last time was interrupted partway: ${names} (${plural(plan.items.length, 'file')}).\n`
      + '“Put back what moved” carries on putting them back; the ones already back are left alone.\n'
      + 'This plan has started restoring, so it can neither carry on cleaning up nor be dropped.'
      + (plan.others > 0 ? `\n(${plural(plan.others, 'more plan')} still unfinished. Deal with this one, then close the panel and open it again to see the next.)` : '')
  }
  const moved = plan.moved, unsure = plan.unsure ?? 0
  const halfway = `${plural(unsure, 'file')} stopped mid-move — could be in either place`
  const where = moved == null ? 'some may already be in quarantine'
    : moved > 0 ? `${plural(moved, 'file')} already in quarantine` + (unsure ? `, and ${halfway}` : '')
    : unsure ? `${halfway}`
    : 'nothing is in quarantine'
  return `A cleanup from last time was interrupted partway: ${names} (${plural(plan.items.length, 'file')}) — ${where}.\n`
    + '“Finish the last plan” moves the rest of this plan — only these files, not the other ones you have ticked now.\n'
    + '“Put back what moved” returns the quarantined ones to where they were; the unmoved ones are left alone.\n'
    + 'This plan has started moving files, so it cannot simply be dropped.' + others
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
  return [`${ok} put back; ${notRestored.length} not put back:`,
    ...notRestored.map(x => `- ${safeName(x.name)} — ${why(x.why)}`)]
}

/** 還不確定放回了沒有的那幾行（U1、U2）。**不說「沒放回」** —— 可能已經放回去了。 */
function unconfirmedLines(unconfirmed) {
  return [`${unconfirmed.length} not confirmed put back:`,
    ...unconfirmed.map(x => `- ${safeName(x.name)} — ${why(x.why)}`)]
}

/**
 * 寵物的話看結果（RC9）：全部放回、部分放回、一個都沒放回各一種；
 * 有還不確定的（U2），照實列出放回、沒放回、不確定各幾個。
 */
function restoreNotice(ok, notRestored, unsure = 0) {
  if (unsure) {
    return [ok && `${ok} put back`, notRestored && `${notRestored} not put back`, `${unsure} not confirmed put back`]
      .filter(Boolean).join(', ') + '. The panel has the details.'
  }
  if (!notRestored) return ok ? 'Everything is back where it was.' : 'Nothing needed putting back this time.'
  return ok ? `${ok} put back, ${notRestored} not put back. The panel says why.`
    : 'Nothing was put back this time. The panel says why.'
}

/** 面板上「復原這次清理」與「放回已經搬走的」之後要講的話。r 是 createReal().undo() 或 putBack() 的回傳。 */
export function undoMessage(r) {
  const notRestored = r.notRestored ?? [], unconfirmed = r.unconfirmed ?? []
  const lines = notRestored.length ? notRestoredLines(r.restored, notRestored)
    : r.restored ? [`Put ${plural(r.restored, 'file')} back.`]
    : unconfirmed.length ? []
    : ['Nothing needed putting back this time.']
  for (const x of r.renamed ?? []) {
    lines.push(`- ${safeName(x.name)} already had a file of that name where it came from, so the one put back is called ${safeName(x.restoredAs)} (nothing was overwritten).`)
  }
  if (unconfirmed.length) lines.push(...unconfirmedLines(unconfirmed))
  if (notRestored.length) lines.push('The ones that did not go back can be retried from “Undo recent actions”.')
  if (unconfirmed.length) lines.push('For the uncertain ones, check “Undo recent actions” to see whether they are still there; anything still listed can be undone again.')
  // 搬到一半中斷、復原時後端確認其實沒搬過（還在原位）的：講一句（跟歷史面板、CLI 同一個意思）。
  // 不講的話，逐項才說「按復原會把在隔離區的放回原位」，按下去只剩「這次沒有需要放回的檔案」，那個檔的下落沒交代
  for (const x of r.neverMoved ?? []) lines.push(`- ${safeName(x.name)} never moved in the first place; it is where it always was.`)
  // 「放回已經搬走的」（做到一半中斷的那份）：還沒搬的那幾個從來沒動過，講一句，不然使用者會以為它們也被放回了
  if (r.untouched) lines.push(`${plural(r.untouched, 'file')} in this plan had not moved yet and were left alone.`)
  if (r.reloadFailed) lines.push('(The list did not refresh. Close the panel and open it again to see the current state.)')
  return { text: lines.join('\n'), notice: restoreNotice(r.restored, notRestored.length, unconfirmed.length) }
}

/** 歷史面板「復原勾選動作」之後要講的話。r 是 createRealHistory 的 undo 回傳。 */
export function historyUndoMessage(r) {
  const notRestored = r.notRestored ?? [], unconfirmed = r.unconfirmed ?? []
  const lines = notRestored.length ? notRestoredLines(r.restoredFiles, notRestored)
    : r.restoredFiles ? [`Undid ${plural(r.restored, 'cleanup')} and put ${plural(r.restoredFiles, 'file')} back.`]
    : unconfirmed.length ? []
    : [r.alreadyRestored ? `The ${r.alreadyRestored} you ticked had already been undone, so nothing moved this time.` : 'Nothing needed putting back this time.']
  if (r.alreadyRestored && (notRestored.length || r.restoredFiles || unconfirmed.length)) {
    // 前面沒有別的句子（只有「還不確定」）時，「另有」接不上
    lines.push(lines.length ? `Another ${r.alreadyRestored} had already been undone.` : `The ${r.alreadyRestored} you ticked had already been undone.`)
  }
  for (const x of r.renamed ?? []) {
    lines.push(`- ${safeName(x.name)} → ${safeName(x.restoredAs)} (a file of that name was already there; nothing was overwritten).`)
  }
  if (unconfirmed.length) {
    lines.push(...unconfirmedLines(unconfirmed), 'Anything still listed in the record above can still be undone — tick it and try again.')
  }
  // 搬到一半中斷、其實沒搬過的（後端確認還在原位）：講一句，不然使用者會以為它不見了。CLI 印同一個意思
  for (const x of r.neverMoved ?? []) lines.push(`- ${safeName(x.name)} never moved in the first place; it is where it always was.`)
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
        if (plan.restoring) throw new Error('This plan has started restoring, so it cannot carry on cleaning up. Choose “Put back what moved”.')
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
        if (!candidateIds.length) throw new Error('Pick at least one file.')
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
      if (!pendingPlan) throw new Error('There is no plan to drop.')
      if (pendingPlan.started) {
        throw new Error('This plan has started moving files, so it cannot be dropped. Choose “Finish the last plan” or “Put back what moved”.')
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
      if (!pendingPlan?.started) throw new Error('There is no half-finished plan to put back.')
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
      if (!lastPlan) throw new Error('There is no cleanup to undo.')
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
    throw new Error('Local mode does not support this history action: ' + path)
  }
}

// ── 連拍截圖（P0 接線）──────────────────────────────────────
//
// 後端把「同一批連拍的截圖」分好組（`GET /cleanup/bursts`），這裡負責把它整成畫面要的樣子。
// 這一區是寵物**主動**跳出來問的，使用者傾向照著按 —— 所以每一步都往保守的方向做：
// 認不得的等級當 similar、留下的那張永遠不列成候選、similar 一律預設不勾。
//
// 成員本身就是候選清單上的檔（kind 是 screenshot-noise），所以勾選走的是**同一個** selected
// 集合、同一條建計畫→套用→可復原的路。連拍區只是換一種看法（縮圖＋差異處），不是第二條清理路徑。

/**
 * 縮圖端點的相對路徑。後端給的 `thumb` 一律照這個樣子檢查過才用 ——
 * 它會變成 fetch 的路徑，寫死成「只能長這樣」就不會被帶去別的地方（也擋掉帶查詢字串的寫法）。
 */
const THUMB_PATH = /^\/cleanup\/thumb\/[^/?#]+$/

/** 一次最多畫幾組。每一組要拿 1＋N 張縮圖，不設上限的話打開面板會先卡在幾百個請求上。 */
export const BURST_GROUPS_SHOWN = 20

/** 面板要講的話。similar 那一句**不可以省**：除了預設不勾，還要叫人自己看一眼。 */
export const BURST_SIMILAR_NOTE = 'This group has visible differences. Take a look before you decide.'
export const BURST_SAME_NOTE = 'This group looks identical.'
export const burstNote = level => level === 'same' ? BURST_SAME_NOTE : BURST_SIMILAR_NOTE

/**
 * 一個 0–1 的相對座標框 → 夾進畫面裡。
 * 超出右邊界／下邊界的切到邊上（不然框會畫到縮圖外面），夾完沒有面積的、看不懂的丟掉。
 */
function burstBox(raw) {
  const unit = v => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null
  }
  // 切到邊上會帶出浮點屑（1 − 0.9 不是 0.1），收到小數點後六位 —— 畫出來只到 0.1%，夠了
  const tidy = v => Math.round(v * 1e6) / 1e6
  const x = unit(raw?.x), y = unit(raw?.y), w = unit(raw?.w), h = unit(raw?.h)
  if (x === null || y === null || w === null || h === null) return null
  const fitW = tidy(Math.min(w, 1 - x)), fitH = tidy(Math.min(h, 1 - y))
  if (!(fitW > 0) || !(fitH > 0)) return null
  return { x: tidy(x), y: tidy(y), w: fitW, h: fitH }
}

/** 一張（留下的那張或成員）。認不出 itemId 就當它不存在。 */
function burstShot(raw, groupLevel) {
  const itemId = typeof raw?.itemId === 'string' && raw.itemId ? raw.itemId : null
  if (!itemId) return null
  const bytes = Number(raw?.bytes)
  return {
    itemId,
    name: String(raw?.name ?? ''),
    bytes: Number.isFinite(bytes) ? bytes : 0,
    // 成員自己的等級為準（同一組裡可能有 same 也有 similar）；沒給就跟著整組
    level: raw?.level === 'same' ? 'same' : raw?.level === 'similar' ? 'similar' : groupLevel,
    thumb: typeof raw?.thumb === 'string' && THUMB_PATH.test(raw.thumb)
      ? raw.thumb : '/cleanup/thumb/' + encodeURIComponent(itemId),
    boxes: (Array.isArray(raw?.boxes) ? raw.boxes : []).map(burstBox).filter(Boolean),
    // 模型的看法（P2）。舊版後端沒有這一欄 —— 沒有就是沒有，畫面少一行字而已
    model: raw?.model && typeof raw.model === 'object' ? raw.model : null,
  }
}

/**
 * `GET /cleanup/bursts` 的 `groups` → 畫面要的樣子。**後端回什麼都不可以讓面板壞掉**
 * （舊版沒有這條、新版改了形狀），看不懂的一律當成「沒有這一組」。
 *
 * - 等級認不得 → 當 **similar**（偏保守：similar 不預設勾）
 * - **留下的那張不可以同時出現在成員裡**（不變量 2：留下的那張永遠不會被提議清掉）
 * - 扣掉之後沒有成員 → 不成組（只剩一張沒什麼好問的）
 */
export function normalizeBurstGroups(raw) {
  const out = []
  for (const g of Array.isArray(raw) ? raw : []) {
    const level = g?.level === 'same' ? 'same' : 'similar'
    const keep = burstShot(g?.keep, level)
    if (!keep) continue
    const members = (Array.isArray(g?.members) ? g.members : [])
      .map(m => burstShot(m, level)).filter(m => m && m.itemId !== keep.itemId)
    if (!members.length) continue
    out.push({ id: String(g?.id ?? keep.itemId), level, keep, members })
  }
  return out
}

/** 一組一共幾張（留下的那張也算）。 */
const burstShots = g => g.members.length + 1

/** 寵物主動問的那一句。沒有組就回 null —— 不可以彈一句空的。 */
export function burstAskMessage(groups) {
  const list = Array.isArray(groups) ? groups : []
  if (!list.length) return null
  if (list.length === 1) return `These ${burstShots(list[0])} screenshots look like one burst. Keep only the newest?`
  const total = list.reduce((n, g) => n + burstShots(g), 0)
  return `${list.length} groups of screenshots look like bursts (${total} shots in all). Keep only the newest of each?`
}

/**
 * 模型的看法 → 面板上的兩行字（P2）。沒有看法（沒接模型、還沒問到）回 null。
 *
 * **一定要標明是模型說的**（預想的不變量 4）：模型會自信地說錯，而它說的東西之後會變成
 * 改名與歸檔的依據。所以畫面上永遠是「模型認為⋯⋯」＋信心＋證據，**而且不會因為它說了
 * 就自動打勾** —— 這支只產生字，一個勾選框都不碰。
 *
 * `seeded` 是 demo 預先塞的示範答案，前面標「示範答案」，不可以假裝是真的問過的。
 * 模型回的字是**不可信的輸入**（它讀的是使用者的檔）：一律走 safeName。
 */
export function modelOpinionLines(m) {
  if (!m || typeof m !== 'object') return null
  const pick = (v, dflt) => safeName(String(v ?? '').trim()) || dflt
  const course = pick(m.course, 'Unknown')
  const topic = pick(m.topic, 'Unknown')
  const confidence = pick(m.confidence, 'low')
  const evidence = safeName(String(m.evidence ?? '').trim())
  const seeded = m.seeded === true
  // **「看不出來」要講成人話。** `Unknown / Unknown (confidence low)` 長得像壞掉，
  // 但它其實是這個作品最該被看見的行為之一：模型不知道的時候會說不知道，而不是硬猜一個課名。
  // **信心是多少都一樣**：說不出是哪一堂課就是說不出來。
  // 模型有時候會回「Unknown（信心 high）」—— 那是它自己前後矛盾，不是我們要轉述的東西。
  const noIdea = /^(unknown|看不出來|未知)$/i.test(course)
  return {
    seeded,
    head: `${seeded ? '[demo answer] ' : ''}`
      + (noIdea
        ? 'The model looked and could not tell what this is, so it is not suggesting anything for it.'
        : `The model thinks: ${course} / ${topic} (confidence ${confidence})`),
    note: (evidence ? `Evidence: ${evidence}  ` : 'The model gave no evidence.  ')
      + "This is the model's opinion, not a fact — nothing gets renamed or moved because it said so.",
  }
}

/** 連拍區裡那一組的標題。檔名是不可信的輸入，一律 safeName。 */
export function burstGroupLine(g) {
  return `${burstShots(g)} shots look like one burst · keeping “${safeName(g.keep.name)}” (the newest)`
}

/**
 * **similar 一律預設不勾**（不變量 1）。後端已經給 similar 信心 40（低於門檻，`defaultChecked`
 * 是 false），這裡再擋一次 —— 這一區是主動跳出來問的，預設勾錯一格，使用者按下去就丟了一張
 * 內容不一樣的截圖。
 *
 * **只往「不勾」的方向動**：same 的照後端的預設（該勾的還是勾著），這支永遠不會幫使用者勾起來。
 * 回傳被取消掉的 itemId（測試與除錯用）。
 */
export function applyBurstDefaults(state, groups) {
  const off = []
  for (const g of Array.isArray(groups) ? groups : []) {
    for (const m of g.members) {
      if (m.level === 'same' || !state.selected.has(m.itemId)) continue
      state.select(m.itemId, false)
      if (!state.selected.has(m.itemId)) off.push(m.itemId)
    }
  }
  return off
}

/**
 * 連拍組與它們的縮圖。
 *
 * 縮圖端點要 token，而 `<img>` **不會**帶 header。做法是用帶 token 的 api 取回 blob，
 * 再換成 `blob:` 網址給 `<img>` —— **token 不可以進網址**：網址會進 DOM、進歷史紀錄，
 * 使用者截個圖就外流了。（頁面的 CSP 也只放行 `img-src data: blob:`。）
 *
 * `createUrl`／`revokeUrl` 可以換掉，測試才不用碰 globalThis。
 */
export function createBursts(api, { createUrl, revokeUrl } = {}) {
  const makeUrl = createUrl ?? (b => URL.createObjectURL(b))
  const dropUrl = revokeUrl ?? (u => URL.revokeObjectURL(u))
  let groups = [], total = 0
  let thumbs = new Map()

  /** 把這一批的 blob: 網址還回去。不還的話開著面板一直重載會愈積愈多。 */
  function revokeAll() {
    for (const u of thumbs.values()) dropUrl(u)
    thumbs = new Map()
  }

  /** 每一張的縮圖各拿一次。**一張讀不到只是那一張沒有圖**，不影響其他張，也不影響整個面板。 */
  async function loadThumbs() {
    const shots = groups.flatMap(g => [g.keep, ...g.members])
    await Promise.all(shots.map(async s => {
      if (thumbs.has(s.itemId)) return
      try { thumbs.set(s.itemId, makeUrl(await api(s.thumb, { blob: true }))) }
      catch { /* 那一張沒有圖，照樣列名字 */ }
    }))
  }

  return {
    get groups() { return groups },
    /** 沒畫出來的還有幾組 */
    get more() { return Math.max(0, total - groups.length) },
    thumb: id => thumbs.get(id) ?? null,
    /** 連拍區裡列出來的成員（留下的那張不算）—— 候選清單要把它們拿掉，不然同一個檔有兩個勾選框 */
    memberIds: () => new Set(groups.flatMap(g => g.members.map(m => m.itemId))),

    /**
     * 重讀一批。**後端沒有這條（舊版回 501）、或讀不到，一律當成「沒有連拍組」** ——
     * 連拍是附加的，不可以讓整個面板打不開。
     */
    async load() {
      revokeAll()
      let body = null
      try { body = await api('/cleanup/bursts') }
      catch { groups = []; total = 0; return groups }
      const all = normalizeBurstGroups(body?.groups)
      total = all.length
      groups = all.slice(0, BURST_GROUPS_SHOWN)
      await loadThumbs()
      return groups
    },

    clear() { revokeAll(); groups = []; total = 0 },
  }
}

// ── 建議的名字（P3）──────────────────────────────────────────

/** 面板上一次最多列幾個建議。再多就叫人去跑 CLI（面板不是批次工具）。 */
export const RENAME_SHOWN = 50

/**
 * 一列建議要印的字：`原名 → 建議名`、模型說了什麼、證據。
 *
 * **永遠標明是模型的意見**（不變量：模型會自信地說錯，而這一按就會動使用者的檔）。
 * 名字與證據都是不可信的輸入（檔名由別人決定，證據是模型讀使用者的檔讀出來的），一律 safeName。
 */
export function renameLines(item) {
  if (!item || typeof item !== 'object') return null
  const name = safeName(String(item.name ?? ''))
  const suggested = safeName(String(item.suggested ?? ''))
  if (!name || !suggested) return null
  const seeded = item.seeded === true
  const course = safeName(String(item.course ?? '').trim()) || 'Unknown'
  const topic = safeName(String(item.topic ?? '').trim()) || 'Unknown'
  const confidence = safeName(String(item.confidence ?? '').trim()) || 'low'
  const evidence = safeName(String(item.evidence ?? '').trim())
  return {
    seeded,
    head: `${name} → ${suggested}`,
    why: `${seeded ? '[demo answer] ' : ''}The model thinks: ${course} / ${topic} (confidence ${confidence})`
      + (item.learned === true ? '  The course part is spelled the way you changed it last time.' : ''),
    note: (evidence ? `Evidence: ${evidence}  ` : 'The model gave no evidence.  ')
      + "This is the model's opinion, not a fact — nothing changes until you press “Rename”, and it can be undone.",
    // 你上次把這個建議退回去了（P5）。**照樣列**，但不預設勾、而且畫面上要講一句。
    rejected: item.rejectedBefore === true,
    back: item.rejectedBefore === true ? '⟲ You turned this suggestion down last time, so it is not ticked by default.' : '',
  }
}

/** 改名的結果講成一句話。**逐項都要講**：一個沒改成不可以被「改好 3 個」蓋過去。 */
export function renameApplyMessage(r) {
  const results = Array.isArray(r?.results) ? r.results : []
  const ok = results.filter(x => x.ok)
  const bad = results.filter(x => !x.ok)
  const lines = [`Renamed ${ok.length}${bad.length ? `, ${bad.length} not renamed` : ''}.`]
  for (const o of ok) lines.push(`- ${safeName(o.from)} → ${safeName(o.to)}`)
  for (const o of bad) lines.push(`- ${safeName(o.from) || 'this file'}: ${why(o.why)}`)
  if (r?.remaining) lines.push(`${r.remaining} still to go. Press the button again and they get done too.`)
  if (ok.length) lines.push('Changed your mind? Press “Undo rename” and the names go back.')
  return lines.join('\n')
}

/** 復原的結果。原名被佔走時**一定要講放回來的叫什麼**（不然使用者找不到那個檔）。 */
export function renameUndoMessage(r) {
  const results = Array.isArray(r?.results) ? r.results : []
  const ok = results.filter(x => x.ok)
  const bad = results.filter(x => !x.ok)
  const lines = [`Changed ${ok.length} back${bad.length ? `, ${bad.length} not changed back` : ''}.`]
  for (const o of ok) {
    lines.push(o.restoredAs
      ? `- Another file had taken the original name, so this one is called “${safeName(o.restoredAs)}” (nothing was overwritten).`
      : `- ${safeName(o.to)}`)
  }
  for (const o of bad) lines.push(`- Not changed back: ${why(o.why)}`)
  return lines.join('\n')
}

/**
 * 面板的「建議的名字」那一區。
 *
 * **一個勾選框都不預設勾起來**：清理至少有隔離區救得回來，改名只有這一份紀錄；
 * 而且這些名字是模型給的。使用者自己勾，自己按。
 *
 * 後端沒有這幾條（舊版回 404／501）或讀不到，一律當成「沒有建議」—— 改名是附加的，
 * 不可以讓整個清理面板打不開。
 */
export function createRenames(api) {
  let items = [], total = 0, selected = new Set(), undoable = false

  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) })

  return {
    get items() { return items },
    get selected() { return selected },
    /** 沒畫出來的還有幾個 */
    get more() { return Math.max(0, total - items.length) },
    /** 剛改過、可以復原 */
    get canUndo() { return undoable },

    select(id, checked) {
      if (!items.some(i => i.itemId === id)) return
      if (checked) selected.add(id)
      else selected.delete(id)
    },

    async load() {
      let body = null
      try { body = await api('/rename/suggestions') }
      catch { items = []; total = 0; selected = new Set(); return items }
      const all = Array.isArray(body?.items) ? body.items.filter(i => i && typeof i.itemId === 'string') : []
      total = all.length
      items = all.slice(0, RENAME_SHOWN)
      // 還在清單上的保留使用者的勾選，不在的丟掉
      const keep = new Set(items.map(i => i.itemId))
      selected = new Set([...selected].filter(id => keep.has(id)))
      return items
    },

    /** 改名。**只送勾起來的那幾個，而且連建議的名字一起送** —— 後端不會自己猜。 */
    async apply() {
      const chosen = items.filter(i => selected.has(i.itemId))
      if (!chosen.length) throw new Error('Tick the files you want renamed first.')
      const r = await post('/rename/apply', { items: chosen.map(i => ({ itemId: i.itemId, to: i.suggested })) })
      undoable = Array.isArray(r?.results) && r.results.some(x => x.ok)
      selected = new Set()
      const message = renameApplyMessage(r)
      try { await this.load() } catch { /* 重載失敗不可以蓋掉結果：檔案已經改了 */ }
      return { message, result: r }
    },

    /** 復原最近那一次改名（同一批一起回去）。 */
    async undo() {
      const r = await post('/rename/undo', { last: true })
      undoable = false
      const message = renameUndoMessage(r)
      try { await this.load() } catch { /* 同上 */ }
      return { message, result: r }
    },

    clear() { items = []; total = 0; selected = new Set(); undoable = false },
  }
}
/** 面板一次畫幾列歸檔建議（跟改名同一個數字）。 */
export const FILING_SHOWN = 50

/**
 * 一列歸檔建議要印的字：`檔名 → 課程/作業系統/講義`、模型說了什麼、證據。
 *
 * **永遠標明是模型的意見**（這一按就會把使用者的檔搬到別的資料夾 —— 比改名更難自己找回來）。
 * 檔名、課名、證據都是不可信的輸入（檔名由別人決定，課名與證據是模型讀使用者的檔讀出來的），
 * 一律 safeName。`toFolder` 是相對於「整理好的」資料夾的那一段，**後端從來不給絕對路徑**。
 */
export function filingLines(item) {
  if (!item || typeof item !== 'object') return null
  const name = safeName(String(item.name ?? ''))
  const folder = safeName(String(item.toFolder ?? ''))
  if (!name || !folder) return null
  const seeded = item.seeded === true
  // **模型說的那一句一定用模型自己的課名**（P5）：套了學到的偏好之後 `course` 是使用者的寫法，
  // 拿它來填「模型認為：⋯⋯」等於把使用者自己的話說成模型講的。舊的後端沒有這個欄位，退回 course。
  const course = safeName(String(item.modelCourse ?? item.course ?? '').trim()) || 'Unknown'
  const topic = safeName(String(item.topic ?? '').trim()) || 'Unknown'
  const confidence = safeName(String(item.confidence ?? '').trim()) || 'low'
  const evidence = safeName(String(item.evidence ?? '').trim())
  const also = safeName(String(item.alsoKnownAs ?? '').trim())
  return {
    seeded,
    head: `${name} → ${folder}`,
    why: `${seeded ? '[demo answer] ' : ''}The model thinks: ${course} / ${topic} (confidence ${confidence})`
      + (item.learned === true ? '  The location is the one you moved it to last time.' : ''),
    note: (evidence ? `Evidence: ${evidence}  ` : 'The model gave no evidence.  ')
      + "This is the model's opinion, not a fact — nothing moves until you press “File”, and it can be undone."
      // 舊資料夾**沒有被搬走、也沒有改名**（只搬不刪的延伸）：不講的話使用者會以為東西不見了
      + (also ? `  You used to call it “${also}”; that folder is still there, untouched.` : ''),
    rejected: item.rejectedBefore === true,
    back: item.rejectedBefore === true ? '⟲ You turned this suggestion down last time, so it is not ticked by default.' : '',
  }
}

/** 整理的結果講成一句話。**逐項都要講**：一個沒搬成不可以被「整理好 3 個」蓋過去。 */
export function filingApplyMessage(r) {
  const results = Array.isArray(r?.results) ? r.results : []
  const ok = results.filter(x => x.ok)
  const bad = results.filter(x => !x.ok)
  const lines = [`Filed ${ok.length}${bad.length ? `, ${bad.length} not filed` : ''}.`]
  for (const o of ok) lines.push(`- ${safeName(o.name)} → ${safeName(o.toFolder)}/${o.to === o.name ? '' : safeName(o.to)}`)
  for (const o of bad) lines.push(`- ${safeName(o.name) || 'this file'}: ${why(o.why)}`)
  if (r?.remaining) lines.push(`${r.remaining} still to go. Press the button again and they get done too.`)
  if (ok.length) lines.push('Changed your mind? Press “Undo filing” and the files go back to the folders they came from.')
  return lines.join('\n')
}

/** 復原的結果。原位被佔走時**一定要講放回來的叫什麼**（不然使用者找不到那個檔）。 */
export function filingUndoMessage(r) {
  const results = Array.isArray(r?.results) ? r.results : []
  const ok = results.filter(x => x.ok)
  const bad = results.filter(x => !x.ok)
  const lines = [`Moved ${ok.length} back${bad.length ? `, ${bad.length} not moved back` : ''}.`]
  for (const o of ok) {
    lines.push(o.restoredAs
      ? `- A file of that name was already in the original place, so this one is called “${safeName(o.restoredAs)}” (nothing was overwritten).`
      : `- ${safeName(o.name)}`)
  }
  for (const o of bad) lines.push(`- Not moved back: ${why(o.why)}`)
  return lines.join('\n')
}

/**
 * 面板的「歸檔建議」那一區。
 *
 * **一個勾選框都不預設勾起來**：搬家比改名更容易讓人找不到檔（改名還在同一個資料夾），
 * 而且這些課名是模型給的。使用者自己勾，自己按。
 *
 * 後端沒有這幾條（舊版回 404／501）或讀不到，一律當成「沒有建議」—— 歸檔是附加的，
 * 不可以讓整個清理面板打不開。
 */
export function createFilings(api) {
  let items = [], total = 0, selected = new Set(), undoable = false

  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) })

  return {
    get items() { return items },
    get selected() { return selected },
    /** 沒畫出來的還有幾個 */
    get more() { return Math.max(0, total - items.length) },
    /** 剛整理過、可以復原 */
    get canUndo() { return undoable },

    select(id, checked) {
      if (!items.some(i => i.itemId === id)) return
      if (checked) selected.add(id)
      else selected.delete(id)
    },

    async load() {
      let body = null
      try { body = await api('/file/suggestions') }
      catch { items = []; total = 0; selected = new Set(); return items }
      const all = Array.isArray(body?.items) ? body.items.filter(i => i && typeof i.itemId === 'string') : []
      total = all.length
      items = all.slice(0, FILING_SHOWN)
      // 還在清單上的保留使用者的勾選，不在的丟掉
      const keep = new Set(items.map(i => i.itemId))
      selected = new Set([...selected].filter(id => keep.has(id)))
      return items
    },

    /** 整理。**只送勾起來的那幾個，而且連課名與類型一起送** —— 後端不會自己猜。 */
    async apply() {
      const chosen = items.filter(i => selected.has(i.itemId))
      if (!chosen.length) throw new Error('Tick the files you want filed first.')
      const r = await post('/file/apply', { items: chosen.map(i => ({ itemId: i.itemId, course: i.course, kind: i.kind })) })
      undoable = Array.isArray(r?.results) && r.results.some(x => x.ok)
      selected = new Set()
      const message = filingApplyMessage(r)
      try { await this.load() } catch { /* 重載失敗不可以蓋掉結果：檔案已經搬了 */ }
      return { message, result: r }
    },

    /** 復原最近那一次整理（同一批一起回去）。 */
    async undo() {
      const r = await post('/file/undo', { last: true })
      undoable = false
      const message = filingUndoMessage(r)
      try { await this.load() } catch { /* 同上 */ }
      return { message, result: r }
    },

    clear() { items = []; total = 0; selected = new Set(); undoable = false },
  }
}

/** 面板一次畫幾條「它學到的事」（跟上面兩區同一個數字）。 */
export const LEARNED_SHOWN = 50

/**
 * 一條「它學到的事」要印的字。認不得的就回 null（不畫）。
 *
 * **三種各講各的**：混成同一句的話，「退過貨」那一種會看起來像
 * 「模型說 課程/OS/講義 ・ 你要（空白）」，使用者看不懂那是什麼。
 * 來源全部是不可信的輸入（課名是模型讀使用者的檔讀出來的、也可能是使用者自己打的），一律 safeName。
 */
export function learnedLines(item) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id) return null
  const from = safeName(String(item.from ?? '').trim())
  const to = safeName(String(item.to ?? '').trim())
  const times = Number.isFinite(item.times) && item.times > 0 ? Math.floor(item.times) : 1
  if (item.kind === 'rejected') {
    // 歸檔的摘要（`課程/<課名>/<類型>`）講得出來；改名的摘要是真的檔名，後端就不回了（稽核 2026-09-20）
    const about = safeName(String(item.about ?? '').trim())
    const head = about ? `You turned down the suggestion “${about}”` : 'You turned down a rename suggestion'
    return { id: item.id, head, why: 'It still gets listed, it is just not ticked by default.' }
  }
  if (!from || !to) return null
  if (item.kind === 'file_kind') {
    return { id: item.id, head: `${from} files · you call them “${to}”`, why: `used ${plural(times, 'time')}` }
  }
  return { id: item.id, head: `The model says “${from}” · you say “${to}”`, why: `used ${plural(times, 'time')}` }
}

/**
 * 面板的「它學到的事」那一區（P5）。
 *
 * **只讀與忘掉，按不出任何會動檔案的事**：這一區沒有「套用」。學到的東西只改建議，
 * 使用者照樣要去上面那兩區勾、按。
 *
 * 後端沒有這一條（舊版回 404／501）或讀不到，一律當成「什麼都沒學過」—— 這一區是附加的，
 * 不可以讓整個清理面板打不開。
 */
export function createLearned(api) {
  let items = [], total = 0, evicted = 0

  return {
    get items() { return items },
    /** 沒畫出來的還有幾條 */
    get more() { return Math.max(0, total - items.length) },
    /** 記太多、被丟掉的有幾條（後端會留紀錄） */
    get evicted() { return evicted },

    async load() {
      let body = null
      try { body = await api('/learned') } catch { items = []; total = 0; evicted = 0; return items }
      const all = Array.isArray(body?.items) ? body.items.filter(i => i && typeof i.id === 'string') : []
      total = all.length
      items = all.slice(0, LEARNED_SHOWN)
      const n = Number(body?.evicted?.count)
      evicted = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
      return items
    },

    /** 忘掉一條。**只送使用者按的那一條** —— 這裡沒有「全清」的捷徑按鈕。 */
    async forget(id) {
      if (!items.some(i => i.id === id)) throw new Error('That entry is no longer on the list.')
      await api('/learned', { method: 'DELETE', body: JSON.stringify({ ids: [id] }) })
      const message = 'Forgotten. Future suggestions will not use that spelling.'
      try { await this.load() } catch { /* 重載失敗不可以蓋掉結果：那一條真的刪掉了 */ }
      return { message }
    },

    clear() { items = []; total = 0; evicted = 0 },
  }
}

// -- 看內容（P6）---------------------------------------------
//
// 「建議刪除的檔要能點進去看內容，不然我不記得那個檔存了什麼。」
//
// 後端的 `GET /cleanup/preview/:itemId` 只回**已經抽好的**東西（file_texts 的文字、
// 既有縮圖的相對路徑）與後設資料，沒有路徑、也沒有原圖。這一區負責：
//   · 點了才抓，同一個檔只抓一次（成功的記在記憶體裡）
//   · 內容是**不可信的輸入**：再洗一次控制字元與方向字元，而且只進 textContent
//   · 圖跟連拍那一區一樣走 blob:（縮圖端點要 token，<img> 不會帶 header）

/**
 * 顯示用的**檔案內容**：控制字元與方向字元換成「·」，**但換行與 tab 留著** ——
 * 內容本來就有行，全部換掉的話一份講義會擠成一長條，使用者根本認不出那是什麼。
 * CRLF 與單獨的 CR 先收成 LF，不然 Windows 上存的檔每一行尾巴都會多一個「·」。
 *
 * 跟後端的 safePreviewText 是同一組字元（後端已經洗過一次，這裡是第二道）。
 * 留著換行是安全的：這段字只進 `textContent`，而且自己一個框 —— 面板講的話在別的地方，
 * 沒有東西可以偽造。
 *
 * **不用正規表示式一次換掉**（跟 core/filing-routes.ts 的 shown 同一個理由）：
 * 要從字元集裡挖掉換行與 tab，regex 會又長又容易寫錯一格；逐字比碼位看得懂也改得動。
 */
export function safeText(s) {
  let out = ''
  for (const ch of String(s ?? '').replace(/\r\n?/g, '\n')) {
    if (ch === '\n' || ch === '\t') { out += ch; continue }
    const c = ch.codePointAt(0) ?? 0
    // 跟 safeName 同一組：C0／C1、U+061C、U+200E／200F、U+2028-202E、U+2066-2069
    const bad = c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x61c
      || (c >= 0x200e && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)
    out += bad ? '·' : ch
  }
  return out
}

/**
 * 會去抽文字的副檔名。**正本是 core/read-text.ts 的 `EXT_KIND`**（它匯出的 `TEXT_EXTS`），
 * test/preview-panel.test.mjs 拿那一份來比，兩邊不一樣就紅。
 *
 * 為什麼面板要知道：後端的 `kind: 'none'` 有兩種意思 ——「這種檔本來就沒有文字可以看」
 * （`.exe`、`.zip`）與「這個檔還沒被讀到」（剛掃到、P1 還沒排到它）。對使用者是兩件事，
 * 而預覽**不會現場觸發讀取**（讀取有 worker 與逾時，那是背景的事），所以要講清楚是哪一種。
 */
export const PREVIEW_TEXT_EXTS = ['.txt', '.md', '.csv', '.docx', '.pptx', '.pdf']

/** ISO 時間 → 本地寫法。看不懂的就原樣（照樣 safeName），不猜。 */
function localTime(iso) {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(t).toLocaleString('en-US') : safeName(String(iso ?? ''))
}

/**
 * 預覽要印的幾段字。後端回什麼都不可以讓面板壞掉（舊版沒有這條、新版改了形狀），
 * 看不懂的一律回 null（畫面上就是一句「讀不到這個檔的內容」）。
 */
export function previewLines(view) {
  if (!view || typeof view !== 'object') return null
  const name = safeName(String(view.name ?? ''))
  const ext = safeName(String(view.ext ?? '')).toLowerCase()
  const size = Number(view.bytes)
  const parts = [formatBytes(Number.isFinite(size) && size >= 0 ? size : 0), 'last modified ' + localTime(view.mtime)]
  if (ext) parts.push(ext)
  const text = typeof view.text === 'string' && view.text !== '' ? safeText(view.text) : null
  const image = typeof view.image === 'string' && THUMB_PATH.test(view.image) ? view.image : null
  return {
    name,
    meta: parts.join(' · '),
    // 「為什麼會被列出來」就是使用者要的判斷材料。後端沒給就照實說，不要編一個理由
    why: 'Why it is listed: ' + (safeName(String(view.why ?? '').trim()) || '(the backend did not say)'),
    text,
    image,
    truncated: text !== null && view.truncated === true,
    more: 'Showing the beginning only — there is more in this file.',
    // 沒有文字也沒有圖的時候，要講清楚是哪一種「沒有」
    empty: text !== null || image !== null ? null
      : PREVIEW_TEXT_EXTS.includes(ext) ? 'This file has not been read yet.'
      : 'There is nothing in this file to show. Its size and last-modified time are above; it is your call whether to keep it.',
  }
}

/**
 * 面板的「看內容」。
 *
 * **點了才抓**（清單可能有 200 個檔，一開就全抓等於 200 個請求），而且
 * **同一個檔只抓一次** —— 成功的記在記憶體裡，第二次點開用記住的。
 * 失敗的**不記**：那多半是一時的（server 正忙、網路斷），記下來會讓它永遠讀不到。
 * 同一個檔連點的時候共用同一個還沒回來的請求，不會送兩次。
 *
 * 圖走 `blob:`：縮圖端點要 token，而 `<img>` 不會帶 header，**token 也不可以進網址**
 * （網址會進 DOM、進歷史紀錄、進使用者的截圖）。`createUrl`／`revokeUrl` 可以換掉，測試才不用碰 globalThis。
 */
export function createPreviews(api, { createUrl, revokeUrl } = {}) {
  const makeUrl = createUrl ?? (b => URL.createObjectURL(b))
  const dropUrl = revokeUrl ?? (u => URL.revokeObjectURL(u))
  let cache = new Map()      // itemId → { ok: true, view }。**只記成功的**
  // 上一次沒讀到的（itemId → { ok: false, message }）。**畫得出來，但不算記住** ——
  // 不畫的話那一列會永遠停在「正在讀……」，記住的話一時的失敗會變成永遠讀不到。
  let failed = new Map()
  let images = new Map()     // itemId → blob: 網址
  const inflight = new Map()

  /** 拿回一張縮圖。**拿不到只是那一張沒有圖**，不影響文字與後設資料。 */
  async function loadImage(id, path) {
    if (images.has(id)) return
    try { images.set(id, makeUrl(await api(path, { blob: true }))) }
    catch { /* 那一張沒有圖，其他照樣顯示 */ }
  }

  return {
    /** 已經拿到的（或上一次拿不到的）。還沒問過、正在問是 null —— 畫面上就是「正在讀」 */
    get: id => cache.get(id) ?? failed.get(id) ?? null,
    image: id => images.get(id) ?? null,

    async load(id) {
      const had = cache.get(id)
      if (had) return had
      const running = inflight.get(id)
      if (running) return running
      const job = (async () => {
        const bad = message => {
          // **不進 cache**：下次點開會再問一次。只放進 failed，讓畫面講得出為什麼
          const out = { ok: false, message }
          failed.set(id, out)
          return out
        }
        let got
        try { got = await api('/cleanup/preview/' + encodeURIComponent(id)) }
        catch (e) { return bad(e?.message ?? "Could not read this file's contents.") }
        const view = got && typeof got === 'object' ? got : null
        if (!view) return bad("Could not read this file's contents.")
        const out = { ok: true, view }
        failed.delete(id)
        cache.set(id, out)
        if (typeof view.image === 'string' && THUMB_PATH.test(view.image)) await loadImage(id, view.image)
        return out
      })().finally(() => inflight.delete(id))
      inflight.set(id, job)
      return job
    },

    /** 面板關掉、換模式時把 blob: 網址還回去，不然一直開著會愈積愈多。 */
    clear() {
      for (const u of images.values()) dropUrl(u)
      images = new Map()
      cache = new Map()
      failed = new Map()
      inflight.clear()
    },
  }
}
