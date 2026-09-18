#!/usr/bin/env node
/**
 * ContextBox 命令列 —— 檔案與截圖管線的入口。
 *
 *   node cli.mjs doctor              這台機器現在什麼狀況
 *   node cli.mjs pet                 啟動寵物與清理面板（印出帶鑰匙的網址）
 *   node cli.mjs open                打開寵物與清理面板（pet 要先在跑）
 *   node cli.mjs cleanup ...         清理：scan、list、apply、undo、release、quarantine
 *   node cli.mjs propose <檔案>...    手動收一個檔案（右鍵選單走的就是這條）
 *   node cli.mjs watch               常駐監看設定裡的資料夾
 *   node cli.mjs list [狀態]          看收件匣
 *   node cli.mjs search <詞>          全文搜尋（要先有理解，P1 之後才有東西）
 *
 * 三個作業系統的右鍵選單最後都是打 `propose`，所以核心不用知道自己在哪個 OS 上跑。
 * **離開碼是那些選單的契約**：只有真的被拒絕才回非零。
 *
 * 幾個環境變數主要是給測試用的（測試不可以佔 7391、不可以真的打開瀏覽器）：
 *   CONTEXTBOX_PORT        pet／open 的 port（測試一律 0，讓系統挑一個空的）
 *   CONTEXTBOX_RESCAN_MS   pet 全部重掃一次的間隔（預設 30 分鐘）
 *   CONTEXTBOX_OPENER      open 用來打開網址的程式（預設看作業系統）
 */
import { load, modelReady, modelKey, CONFIG_PATH } from './core/config.ts'
import { admit } from './core/guard.ts'
import { createWatcher } from './core/watcher.ts'
import { open, DEFAULT_DB } from './core/db.ts'
import { Items } from './core/items.ts'
import {
  listCandidates, healthSnapshot, META, planOutcomes, defaultCandidateIds, createPlanForRoots,
  blockingPlanFor, recordItemErrors, listPlans, quarantineItems, safeWhy, TOO_LARGE_WHY,
} from './core/cleanup-routes.ts'
import * as routes from './core/cleanup-routes.ts'
import { applyPlan, undoPlan } from './core/cleanup-exec.ts'
import { getPlan, releasePlan } from './core/cleanup-plans.ts'
import { prepareEmptyQuarantine, emptyQuarantine } from './core/cleanup-quarantine.ts'
import { CleanupError } from './core/cleanup-journal.ts'
import { scanDownloads } from './core/cleanup-scanner.ts'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, resolve, join } from 'node:path'
import { homedir } from 'node:os'

const QUARANTINE = process.env.CONTEXTBOX_QUARANTINE ?? join(homedir(), '.contextbox', 'quarantine')

/**
 * 離開碼是契約（docs/cli.md）：
 *   0 成功，**包含「沒有東西要清」** —— 那代表清理範圍很乾淨，不是失敗
 *   1 使用者輸入錯（沒有這個計畫、參數看不懂、要的動作跟現在的狀態衝突）
 *   2 後端錯（這個動作根本沒執行，重試通常會過）
 *   3 部分失敗（執行了，但有檔案沒有做成）
 */
const EXIT = { ok: 0, badInput: 1, backend: 2, partial: 3 }

/** 預設清理一次最多幾個檔（RC12）。真值在核心，拿不到才用 1000。 */
const PLAN_MAX = routes.DEFAULT_PLAN_MAX_FILES ?? 1000
/** cleanup list 一次列幾個（跟 HTTP 的預設一樣） */
const LIST_LIMIT = 500
/** 唯讀試跑逐項列幾個，其餘只講數字 */
const DRY_LIST = 50
/** pet 多久全部重掃一次（RC2）。watcher 只看得到「有事件的檔」，pet 沒開的時候刪掉的要靠這個。 */
const RESCAN_MS = 30 * 60_000
const DEFAULT_PORT = 7391
/** pet 把自己實際開在哪個 port 記在 meta，open 才找得到它 */
const PET_PORT_KEY = 'pet_port'

const mb = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB'
  : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B'

/**
 * 顯示用的字串（檔名、資料夾名、錯誤訊息）：C0／C1 控制字元與換行一律換成「·」（RC14）。
 *
 * 檔名是不可信的輸入。原樣印出來的話，名字裡的 ESC 會變成終端機指令（改顏色、改視窗標題），
 * 換行可以偽造一行「✔ 某某檔」—— 而這支工具的全部價值就是使用者信得過它印出來的結果。
 * U+2028／U+2029 在有些終端機與記錄檔裡也會換行，一起換。
 */
const shown = s => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '·')

/** 失敗原因一律經過核心唯一的翻譯函式（safeWhy），再拿掉控制字元 */
const why = raw => shown(safeWhy(raw == null ? null : String(raw)) ?? '原因不明')

const [, , cmd, ...args] = process.argv

const { config, problems, path: cfgPath, created } = load()

let db
try { db = open() }
catch (e) {
  // 右鍵選單一次選 N 個檔就是 N 個行程同時開資料庫。
  // 讓它印一句人話，不要印一坨 Node 堆疊。
  console.error(`打不開資料庫 ${DEFAULT_DB}：${e.message}`)
  console.error('如果剛剛同時開了很多個，等一下再試一次就好。')
  // 打不開資料庫是**後端錯（2）**，不是輸入錯（1）。
  // 回 1 等於跟右鍵選單說「使用者打錯了」，而使用者什麼都沒打錯 ——
  // 呼叫端據此決定要不要重試，分錯就不會重試。
  process.exit(EXIT.backend)
}
const items = new Items(db)

const admitOpts = {
  roots: config.watch,
  maxBytes: config.maxBytes,
  exclude: [config.filed],
}

/**
 * 清理的範圍。**一律用 cleanup.roots，不是 watch**（稽核 RC15，blocker）。
 *
 * watch 是截圖收件用的：macOS 預設含**桌面**、Windows／Linux 含截圖資料夾。
 * 清理沿用它的話，45 天前放在桌面上的客戶提案 zip 會被當成垃圾搬走（稽查 a11 實測）。
 * cleanup.roots 預設只有 Downloads。scan、list、apply、undo、quarantine、doctor、pet 全部用這一份。
 */
const CLEAN_ROOTS = config.cleanup.roots
const rootsLabel = () => CLEAN_ROOTS.map(r => shown(basename(r) || r)).join('、') || 'Downloads'
const execOpts = () => ({
  roots: CLEAN_ROOTS, quarantine: QUARANTINE,
  maxBytes: config.maxBytes, readonly: config.readonly,
})

const say = (...a) => console.log(...a)
const warn = (...a) => console.warn(...a)

const showProblems = () => { for (const p of problems) warn('⚠ ' + shown(p)) }

/** 還要等幾天，無條件進位 —— 「還要等 0 天」是錯的訊息。 */
const days = (at) => Math.max(1, Math.ceil((at - Date.now()) / 86400_000))

// ── meta：給健康檢查用的心跳 ──────────────────────────────────
const setMeta = (k, v) =>
  db.prepare(`INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(k, String(v))
const getMeta = k => (db.prepare(`SELECT v FROM meta WHERE k=?`).get(k) ?? {}).v ?? null

// ── 成功與意外都要記下來，寵物與 doctor 才看得到（RC5） ─────────
// 核心的名字這一波可能從 recordCleanupOk 改成 recordOk，兩個都認；都沒有才自己寫 meta。
const recordOkFn = routes.recordOk ?? routes.recordCleanupOk
const recordErrorFn = routes.recordError ?? routes.recordCleanupError

/** 一次成功的掃描、套用、復原、清空。寫不進去不可以讓指令本身失敗（頂多寵物多擔心一下）。 */
function noteOk() {
  try {
    if (recordOkFn) recordOkFn(db)
    else setMeta(META.lastOk ?? 'cleanup_last_ok', new Date().toISOString())
  } catch { /* 忙就算了 */ }
}

/** 意外才記（哪些算意外由核心的 isSurprise 決定：BUSY、使用者輸入錯都不算），存的是人話。 */
function noteError(e) {
  try { if (recordErrorFn) recordErrorFn(db, e) } catch { /* 連 meta 都寫不進去就算了 */ }
}

/**
 * CleanupError → 離開碼。
 *
 * **判準：1 ＝ 要換個做法（打錯 id、確認碼錯、跟現在的狀態衝突）；
 * 2 ＝ 這個動作根本沒執行，等一下重試通常會過；3 ＝ 執行了但沒有全部成功。**
 * 呼叫端據此決定要不要重試：CONFLICT 重試一百次也一樣，所以不是 2。
 */
const INPUT_ERRORS = new Set(['NOT_FOUND', 'BAD_BODY', 'CONFLICT', 'CONFIRMATION_REQUIRED', 'CONFIRMATION_EXPIRED'])
function exitFor(e) {
  if (!(e instanceof CleanupError)) return EXIT.backend
  if (INPUT_ERRORS.has(e.code)) return EXIT.badInput
  return EXIT.backend
}

/**
 * B 的錯誤訊息本來就是寫好的人話而且不含路徑，直接用。
 * 其他的（程式或資料庫壞了）**講中性的話**：例外可能發生在檔案已經搬走、刪掉之後（RC17），
 * 不知道的時候就說不知道。
 */
const cliProblem = (e) => e instanceof CleanupError
  ? shown(e.message)
  : `出錯了（${why(e?.message ?? e)}），這一步可能沒有完成。用 node cli.mjs doctor 看目前的狀態。`

function fail(e) {
  warn(cliProblem(e))
  noteError(e)
  process.exitCode = exitFor(e)
}

/** 「3 分鐘前」這種人看得懂的講法 */
function ago(iso) {
  if (!iso) return null
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 90) return `${Math.round(s)} 秒前`
  if (s < 5400) return `${Math.round(s / 60)} 分鐘前`
  if (s < 172800) return `${Math.round(s / 3600)} 小時前`
  return `${Math.round(s / 86400)} 天前`
}

const localTime = iso => new Date(iso).toLocaleString('zh-TW', { hour12: false })

/** 「每 30 分鐘」「每 0.2 秒」 */
const every = ms => ms % 60_000 === 0 ? `${ms / 60_000} 分鐘` : `${ms / 1000} 秒`

/**
 * 打一次 /models 看模型在不在，順便確認金鑰對不對。
 * 只回一句給人看的話 —— doctor 的價值就在「能不能用」講得斬釘截鐵。
 */
async function probeModel(cfg, key) {
  const url = `${cfg.model.baseUrl}/models`
  try {
    const res = await fetch(url, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(8000),
    })
    if (res.status === 401 || res.status === 403) return `✗ 連得到，但金鑰不對（${res.status}）`
    if (!res.ok) return `✗ ${url} 回了 ${res.status}`
    const data = await res.json().catch(() => ({}))
    const names = (data.data ?? []).map(m => m.id)
    if (!names.length) return '✓ 連得到，但這台沒有列出任何模型'
    return names.includes(cfg.model.name)
      ? `✓ 連得到，${cfg.model.name} 在線上（共 ${names.length} 個模型）`
      : `✗ 連得到，但沒有叫 ${cfg.model.name} 的模型。有的是：${names.slice(0, 6).map(shown).join('、')}`
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? '8 秒沒回應' : (e?.message ?? e)
    return `✗ 連不上 ${url}（${shown(why)}）`
  }
}

/** 收一個檔案。回 'new'｜'known'｜'rejected' */
function intake(path, { quiet = false } = {}) {
  const v = admit(resolve(path), admitOpts)
  if (!v.ok) {
    if (!quiet) warn(`✗ ${shown(basename(path))}：${shown(v.why)}`)
    return 'rejected'
  }
  let added
  try { added = items.add(v) }
  catch (e) { if (!quiet) warn(`✗ ${shown(basename(path))}：${shown(e.message)}`); return 'rejected' }

  if (!quiet) {
    const sameContent = items.bySha(added.item.sha256, added.item.id)
    say(`✓ ${shown(basename(v.real))}  ${v.kind}  ${(v.bytes / 1024).toFixed(0)}KB`
      + (added.fresh ? '' : '（已經收過了，沒有變）')
      + (sameContent.length ? `　※ 另外有 ${sameContent.length} 份一樣的內容，理解可以共用` : ''))
  }
  return added.fresh ? 'new' : 'known'
}

// ── 清單上的編號 ─────────────────────────────────────────────
//
// 清單印每個檔 id 的前幾碼，`--skip`／`--also` 收的就是它（docs/cli.md）。
// **至少 4 碼，撞在一起就多印幾碼。** id 是 UUID，前 4 碼只有 65536 種，
// 上千個檔裡幾乎一定有兩個撞在一起 —— 印一樣的編號，使用者就沒辦法指定其中一個。

/** 每個 id 的最短不重複前綴（至少 min 碼） */
function shortIds(ids, min = 4) {
  const sorted = [...new Set(ids)].sort()
  const lcp = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i }
  const out = new Map()
  sorted.forEach((id, k) => {
    const need = Math.max(k > 0 ? lcp(sorted[k - 1], id) : 0, k + 1 < sorted.length ? lcp(id, sorted[k + 1]) : 0) + 1
    out.set(id, id.slice(0, Math.max(min, need)))
  })
  return out
}

/** 使用者打的編號 → 清單上的那一列。對不到、對到不只一個都是輸入錯。 */
function resolveCodes(rows, codes, flag) {
  const out = []
  for (const raw of codes) {
    const code = raw.replace(/^\[|\]$/g, '').toLowerCase()
    if (code.length < 4) return { error: `${flag} ${shown(raw)}：編號至少 4 碼，就是 cleanup list 上 [ ] 裡的那幾碼。` }
    const hits = rows.filter(r => r.itemId.toLowerCase().startsWith(code))
    if (!hits.length) return { error: `清單上沒有編號 ${shown(raw)}。先跑 node cli.mjs cleanup list 看現在的編號。` }
    if (hits.length > 1) {
      const short = shortIds(rows.map(r => r.itemId))
      return { error: `編號 ${shown(raw)} 對到不只一個檔，請多打幾碼：\n`
        + hits.slice(0, 10).map(r => `  [${short.get(r.itemId)}] ${shown(r.name)}`).join('\n') }
    }
    if (!out.includes(hits[0])) out.push(hits[0])
  }
  return { rows: out }
}

/** `cleanup apply [計畫 id] [--skip 編號,...] [--also 編號,...]` */
function parseApplyArgs(list) {
  const out = { planId: null, skip: [], also: [], error: null }
  const bad = error => ({ ...out, error })
  for (let k = 0; k < list.length; k++) {
    const a = list[k]
    const m = /^--(skip|also)(?:=(.*))?$/.exec(a)
    if (m) {
      const v = m[2] ?? list[++k]
      const codes = (v ?? '').split(/[,，]/).map(x => x.trim()).filter(Boolean)
      if (!codes.length || v.startsWith('--')) {
        return bad(`--${m[1]} 後面要接清單上的編號，例：node cli.mjs cleanup apply --${m[1]} a1b2`)
      }
      out[m[1]].push(...codes)
      continue
    }
    if (a.startsWith('--')) return bad(`看不懂 ${shown(a)}。可以用：--skip <編號>、--also <編號>。`)
    if (out.planId) return bad('一次只能套用一份計畫。')
    out.planId = a
  }
  if (out.planId && (out.skip.length || out.also.length)) {
    return bad('--skip／--also 只能用在建新的清理（不給計畫 id 的時候）。')
  }
  return out
}

/** 清單上那一列長什麼樣。每一列都要有原因 —— 沒有原因就不該出現。 */
function printCandidate(c, code) {
  const box = c.defaultChecked ? '✔' : '☐'
  const where = c.subdir ? `${c.folder}/${c.subdir}` : c.folder
  say(`  [${code}] ${box} ${shown(c.name)}`)
  say(`         ${mb(c.bytes).padStart(8)}  ${shown(c.kind)}  ${shown(where)}`)
  for (const r of c.reasons) say(`         · ${shown(r.reason)}（${shown(r.evidence)}）`)
  if (c.vetoed) say(`         ⚠ ${shown(c.vetoed)}`)
}

// ── 逐項結果 ────────────────────────────────────────────────
//
// **照 outcome 的全部種類印**（RC13）。只認 moved／skipped 的話，其他每一種都會掉進
// 「✘ 沒有搬動，原因不明」—— 已經復原、已經清空的檔被說成沒搬成，畫面在說謊。
// 逐項結果跟 HTTP 那邊用**同一份算法**（planOutcomes），這裡只決定長相。

/** 套用（或查看一份計畫）時每一項的樣子 */
function applyLine(i, o) {
  const head = `${shown(i.name)}　${mb(i.bytes)}`
  switch (o?.outcome) {
    case 'moved': return `  ✔ ${head}`
    case 'skipped': return `  － ${head}　（你略過了）`
    case 'failed': return `  ✘ ${head}　—— ${shown(o.why ?? '沒有搬動，原因不明')}`
    case 'restored': return `  ↩ ${head}　（已經放回${o.restoredAs ? `，放回來的這份叫 ${shown(o.restoredAs)}` : ''}）`
    case 'purged': return `  ⌫ ${head}　（已清空）`
    case 'pending': return `  ○ ${head}　（還沒做）`
    case 'cancelled': return `  ⊘ ${head}　（已放棄，沒有動過）`
    // unknown：journal 停在 started。**不可以說「沒有搬動」** —— rename 可能已經完成了（RC17）
    case 'unknown': return `  ？ ${head}　—— 狀態不明：${shown(o.why ?? '搬到一半中斷，檔案可能已經在隔離區')}`
    default: return `  ？ ${head}　—— 狀態不明`
  }
}

/** 復原時每一項的樣子。**↩ 只給真的放回去的**，數字跟行數才對得上。 */
function undoLine(i, o) {
  const head = shown(i.name)
  switch (o?.outcome) {
    // **不要講「之後不會再被提議」。** 那不一定是真的：之後符合新的理由會再出現；
    // 原位置被佔時放回來的那份會改名成 .restored，重掃後以重複檔的身分被預設勾起來。
    case 'restored': return o.restoredAs
      ? `  ↩ ${head}　→ 原位置已經有同名檔案，放回來的這份叫 ${shown(o.restoredAs)}（沒有覆蓋任何檔案）`
      : `  ↩ ${head}`
    case 'moved': return `  ✘ ${head}　—— 沒放回，還在隔離區：${shown(o.why ?? '原因不明')}`
    case 'purged': return `  ✘ ${head}　—— 已經清空，放不回來了`
    case 'unknown': return `  ？ ${head}　—— 狀態不明：${shown(o.why ?? '做到一半中斷')}`
    // skipped／failed／pending／cancelled：當初就沒有搬走
    default: return `  － ${head}　（當初就沒有搬走，本來就在原位）`
  }
}

function printPlanItems(plan, line) {
  const o = planOutcomes(db, plan.id)
  for (const i of plan.items) say(line(i, o.get(i.itemId)))
}

/**
 * 撞到 CONFLICT：**找出擋住這次勾選的那一份**（RC7），講得出怎麼往下走。
 *
 * 只有還沒套用的（proposed）計畫會佔住檔案（RC4）。上一版拿「最新一份 proposed／partial／error」，
 * 那一份不一定跟這次有關，而且叫人「不清了：cleanup undo」—— 對一份 partial 的計畫照做，
 * 會把已經清掉的檔放回來（驗證者 v7）。現在給的兩條路都不動任何檔案以外的東西：
 * 接著清那一份，或放棄那一份（release：計畫作廢、候選不動）。
 */
function explainConflict(e, candidateIds) {
  warn(shown(e.message))
  let b = null
  try { b = blockingPlanFor(db, candidateIds) } catch { /* 找不到就只講原因 */ }
  if (!b || b.status !== 'proposed') {
    say('\n找不到擋住的是哪一份。先跑 node cli.mjs cleanup scan 再試一次。')
  } else {
    say(`\n擋住的是一份還沒套用的計畫 ${b.id}（${ago(b.createdAt) ?? '不知道什麼時候'}建立），裡面有 ${b.items.length} 個檔：`)
    for (const i of b.items.slice(0, 20)) say(`  ${shown(i.name)}　${mb(i.bytes)}`)
    if (b.items.length > 20) say(`  …另外 ${b.items.length - 20} 個`)
    say('\n兩個選擇：')
    say(`  接著清那一份：node cli.mjs cleanup apply ${b.id}`)
    say(`  放棄那一份（不動任何檔案，裡面的檔還是候選）：node cli.mjs cleanup release ${b.id}`)
  }
  process.exitCode = EXIT.badInput
}

/** 真的套用一份計畫，印逐項結果。remaining／skippedRows 是預設清理才有的補充。 */
function runApply(id, { remaining = 0, skippedRows = [] } = {}) {
  let r
  try { r = applyPlan(db, id, execOpts()) }
  catch (e) { fail(e); return }
  // 失敗原因**馬上**存起來：下一次掃描會改寫 file_items.error，重掃之後原因就變成「原因不明」（RC11）。
  // 存不進去不可以讓結果消失 —— 檔案已經搬了。
  try { recordItemErrors(db, id) }
  catch (e) { warn(`⚠ 失敗原因存不進去（${why(e?.message)}），重新掃描之後可能看不到原因。`) }
  noteOk()

  say(`計畫 ${r.id}`)
  const outcomes = planOutcomes(db, r.id)
  for (const i of r.items) say(applyLine(i, outcomes.get(i.itemId)))
  for (const row of skippedRows) say(`  － ${shown(row.name)}　${mb(row.bytes)}　（你略過了，這次不清）`)
  say(`\n搬進隔離區 ${r.quarantinedCount} 個，${mb(r.quarantinedBytes)}。`)
  if (r.quarantinedCount) say(`後悔的話：node cli.mjs cleanup undo ${r.id}`)
  if (remaining > 0) say(`一次最多清 ${PLAN_MAX} 個，剩下 ${remaining} 個下次再清（再跑一次 node cli.mjs cleanup apply）。`)

  const kinds = r.items.map(i => outcomes.get(i.itemId)?.outcome)
  const failed = kinds.filter(k => k === 'failed').length
  const unknown = kinds.filter(k => k === 'unknown').length
  if (!failed && !unknown && r.status !== 'partial' && r.status !== 'error') return
  // **「原檔都還在原位」只在失敗的全部是 failed 時才說**（RC17）。
  // unknown 是搬到一半中斷：rename 可能已經做完了，檔案可能在隔離區 —— 說「都還在原位」是在說謊。
  if (failed && !unknown) warn('\n⚠ 上面 ✘ 的沒搬成。原檔都還在原位，沒有任何東西被刪除。')
  else if (failed) warn('\n⚠ 上面 ✘ 的沒搬成。')
  if (unknown) {
    warn(`${failed ? '' : '\n'}⚠ 有 ${unknown} 個搬到一半中斷，檔案可能已經在隔離區，執行 node cli.mjs doctor 檢查。`)
  }
  if (!failed && !unknown) warn('\n⚠ 這份計畫沒有全部完成。')
  // 動作執行了，只是檔案沒全部搬成：3。全失敗也不是 2 —— 2 要留給「連跑都跑不起來」。
  process.exitCode = EXIT.partial
}

/** `cleanup apply <id>`：套用（或重送）指定的那一份 */
function applyExisting(id) {
  let plan
  try { plan = getPlan(db, id) }
  catch (e) { fail(e); return }       // 沒有這份 → NOT_FOUND → 1，唯讀模式也一樣（上一版唯讀時回 0）

  // 已經復原過的再套用一次：B 會原樣回傳結果，逐項全是 restored —— 上一版把它們印成一排 ✘、回 0。
  if (plan.status === 'restored') {
    say(`計畫 ${plan.id} 已經復原過了，檔案都放回原位，這次什麼都沒做。`)
    say('要再清的話：node cli.mjs cleanup scan，再 node cli.mjs cleanup apply。')
    return
  }
  if (plan.status === 'dismissed') {
    say(`計畫 ${plan.id} 已經放棄了，沒有動過任何檔案，這次什麼都沒做。`)
    printPlanItems(plan, applyLine)
    return
  }
  if (config.readonly) {
    // smoke 第 0 步就靠這個確認「只說不做」。回非 0 會讓那一步永遠紅。
    const o = planOutcomes(db, plan.id)
    const todo = plan.items.filter(i => ['pending', 'failed', 'unknown'].includes(o.get(i.itemId)?.outcome ?? 'pending'))
    say(`唯讀模式：會清掉 ${todo.length} 個檔案，但這次一個都沒動。`)
    for (const i of plan.items) say(applyLine(i, o.get(i.itemId)))
    return
  }
  runApply(plan.id)
}

/**
 * `cleanup apply`：清掉 cleanup list 上打 ✔ 的，一次最多 PLAN_MAX 個（RC12），
 * 再照 --skip／--also 調整（RC13）。
 *
 * 要清哪些**不自己算**：defaultCandidateIds（核心）決定打 ✔ 的是哪些、一次收幾個、還剩幾個 ——
 * defaultChecked 只有 listCandidates 一個地方在決定。這裡只做 --skip 減、--also 加。
 */
function applyDefault({ skip, also }) {
  let all, ids
  try {
    all = listCandidates(db, { roots: CLEAN_ROOTS, limit: Number.MAX_SAFE_INTEGER }).candidates
    ids = defaultCandidateIds(db, CLEAN_ROOTS)
  } catch (e) {
    warn('讀不到清理候選：' + cliProblem(e))
    noteError(e)
    process.exitCode = EXIT.backend
    return
  }
  const idList = Array.isArray(ids) ? ids : (ids?.candidateIds ?? [])
  const remaining = Number(ids?.remaining) || 0

  const s = resolveCodes(all, skip, '--skip')
  const a = s.error ? s : resolveCodes(all, also, '--also')
  if (s.error || a.error) { warn(s.error ?? a.error); process.exitCode = EXIT.badInput; return }
  const skipSet = new Set(s.rows.map(r => r.itemId))
  if (a.rows.some(r => skipSet.has(r.itemId))) {
    warn('同一個編號不可以同時 --skip 又 --also。')
    process.exitCode = EXIT.badInput
    return
  }

  const inDefault = new Set(idList)
  const chosen = all.filter(r => r.candidateIds.some(c => inDefault.has(c)))
  const chosenSet = new Set(chosen.map(r => r.itemId))
  for (const r of s.rows) if (!chosenSet.has(r.itemId)) say(`${shown(r.name)} 本來就不在這次要清的裡面。`)
  for (const r of a.rows) if (chosenSet.has(r.itemId)) say(`${shown(r.name)} 本來就打勾了。`)
  const skippedRows = chosen.filter(r => skipSet.has(r.itemId))
  const final = [...chosen.filter(r => !skipSet.has(r.itemId)), ...a.rows.filter(r => !chosenSet.has(r.itemId))]

  // **唯讀模式不可以建 plan。**
  // createPlan 不看 readonly（只有 applyPlan 看），所以先建再被擋的話，
  // 那份 plan 會留在資料庫裡佔住那些檔案，下一次真的 apply 直接撞
  // 「這個檔案已有待處理的清理計畫」—— 而 smoke 第 0 步正是叫使用者
  // 先跑一次唯讀試跑。照著文件做就會壞掉。
  // 數字跟真的跑**同一份算法**（上面的 final），試跑說幾個、真的就清幾個。
  if (config.readonly) {
    say(`唯讀模式：會清掉 ${final.length} 個檔案，${mb(final.reduce((n, r) => n + r.bytes, 0))}。`)
    for (const r of final.slice(0, DRY_LIST)) say(`  ✔ ${shown(r.name)}　${mb(r.bytes)}`)
    if (final.length > DRY_LIST) say(`  …另外 ${final.length - DRY_LIST} 個`)
    for (const r of skippedRows) say(`  － ${shown(r.name)}　${mb(r.bytes)}　（你略過了，這次不清）`)
    if (remaining > 0) say(`一次最多清 ${PLAN_MAX} 個，剩下 ${remaining} 個下次再清。`)
    say('\n這次一個都沒動，也沒有建立計畫。')
    return
  }

  if (!final.length) {
    // **沒東西要清是成功。** 回非 0 會讓每晚 smoke 一直紅。
    say(chosen.length ? '這次沒有要清的：打勾的都被 --skip 略過了。' : `沒有東西需要清，${rootsLabel()} 很乾淨。`)
    return
  }

  const candidateIds = final.flatMap(r => r.candidateIds)
  let plan
  try {
    // 用核心的 createPlanForRoots：只收清單列得出來的（在清理範圍裡、搬得動的），跟清單同一套篩選
    plan = createPlanForRoots(db, CLEAN_ROOTS, { candidateIds })
  } catch (e) {
    if (e instanceof CleanupError && e.code === 'CONFLICT') { explainConflict(e, candidateIds); return }
    if (e instanceof CleanupError && e.code === 'EMPTY_PLAN') {
      say(`沒有東西需要清，${rootsLabel()} 很乾淨。`)
      return
    }
    fail(e)
    return
  }
  runApply(plan.id, { remaining, skippedRows })
}

/**
 * doctor 的「另外 N 個」要分開講（RC11／RC4）：真的讀不到（或搬不動）的，
 * 跟「太大，這個工具不處理」的不是同一件事 —— 上一版把太大的也說成讀不到，使用者會去查權限。
 */
function needsHumanText(nh, fallbackTotal) {
  if (!nh) return fallbackTotal ? `，另外 ${fallbackTotal} 個要你自己看一眼` : ''
  const total = nh.needsHumanTotal ?? nh.needsHuman.length
  if (!total) return ''
  const big = nh.needsHuman.filter(x => x.why === TOO_LARGE_WHY).length
  const other = nh.needsHuman.length - big
  const parts = []
  if (other) parts.push(`${other} 個讀不到或搬不動`)
  if (big) parts.push(`${big} 個太大，這個工具不處理`)
  if (total > nh.needsHuman.length) parts.push(`還有 ${total - nh.needsHuman.length} 個沒有列出來`)
  return `；另外 ${parts.join('、')}（用 cleanup list 看是哪些）`
}

/** 看得懂的 CONTEXTBOX_PORT 才用（0 ＝ 讓系統挑）。看不懂就當沒設。 */
function portFromEnv() {
  const v = process.env.CONTEXTBOX_PORT
  if (v === undefined || v === '') return null
  if (!/^\d{1,5}$/.test(v) || Number(v) > 65535) {
    warn(`⚠ CONTEXTBOX_PORT 看不懂（${shown(v)}），改用 ${DEFAULT_PORT}。`)
    return null
  }
  return Number(v)
}

function rescanFromEnv() {
  const n = Number(process.env.CONTEXTBOX_RESCAN_MS)
  return Number.isInteger(n) && n >= 100 ? n : null
}

/** open 要連哪個 port：明講的（環境變數）→ pet 記下來的 → 7391 */
function petPort() {
  const env = portFromEnv()
  if (env) return env
  let recorded = NaN
  try { recorded = Number(getMeta(PET_PORT_KEY)) } catch { /* 讀不到就用預設 */ }
  return Number.isInteger(recorded) && recorded > 0 && recorded <= 65535 ? recorded : DEFAULT_PORT
}

/** pet 有沒有在那個 port 上回應 */
async function petUp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
    return res.status === 200
  } catch { return false }
}

/**
 * 用系統的方式打開網址：Linux xdg-open、macOS open、Windows start。打不開回 false，呼叫端只印網址。
 * 等它結束最多 3 秒；還沒結束就當成開了（有些開啟程式會等瀏覽器關掉才結束）。
 */
function openInBrowser(url) {
  const custom = process.env.CONTEXTBOX_OPENER
  const [bin, argv, extra] = custom ? [custom, [url], {}]
    : process.platform === 'darwin' ? ['open', [url], {}]
    // start 是 cmd 的內建指令。第一個引號參數是視窗標題，所以先給一個空的。
    // 網址裡只有 token（base64url），沒有 & 或 %，可以原樣交給 cmd。
    : process.platform === 'win32' ? ['cmd', ['/d', '/s', '/c', `start "" "${url}"`], { windowsVerbatimArguments: true }]
    : ['xdg-open', [url], {}]
  return new Promise(done => {
    let child
    try { child = spawn(bin, argv, { stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true, ...extra }) }
    catch { done(false); return }
    const timer = setTimeout(() => { child.unref(); done(true) }, 3000)
    child.once('error', () => { clearTimeout(timer); done(false) })
    child.once('exit', code => { clearTimeout(timer); done(code === 0) })
  })
}

// ── 搜尋 ────────────────────────────────────────────────────
//
// 使用者打的字**不可以**原封不動丟進 MATCH。FTS5 會把它當查詢語法解析，
// 所以 `發票-2026`、`2026/09`、`a"b`、`*` 這些都會讓 CLI 帶著堆疊崩掉——
// 而「搜一個檔名」正是這個工具最自然的用法。
const ftsQuery = q =>
  q.split(/\s+/).filter(Boolean).map(w => '"' + w.replace(/"/g, '""') + '"').join(' ')

switch (cmd) {
  case 'doctor': {
    say('ContextBox 檢查')
    say('')
    say(`設定檔    ${shown(cfgPath)}${created ? '（還沒有，剛剛幫你建了一份）' : ''}`)
    say(`資料庫    ${shown(DEFAULT_DB)}`)
    say(`唯讀模式  ${config.readonly ? '開著（清理只會說，不會搬也不會刪任何檔案）' : '關著'}`)
    say('')
    say('監看資料夾（截圖與收件）')
    for (const r of config.watch) say(`  ${existsSync(r) ? '✓' : '✗ 不存在'}  ${shown(r)}`)
    say('清理範圍（只有這裡面的檔會被清）')
    for (const r of CLEAN_ROOTS) say(`  ${existsSync(r) ? '✓' : '✗ 不存在'}  ${shown(r)}`)
    say(`歸檔到    ${shown(config.filed)}${existsSync(config.filed) ? '' : '（同意第一份提案時才會建）'}`)
    say('')

    // 監看到底有沒有在跑？設定正確不代表有人在看。
    const beat = getMeta(META.heartbeat)
    const beatPid = Number(getMeta(META.pid))
    const beatAgo = ago(beat)
    // 心跳只證明「它上次寫的時候還活著」。被 kill -9 掉的話，
    // 心跳會停在那裡，而 doctor 會繼續說「還活著」說滿五分鐘 ——
    // 這個心跳本來就是為了「靜默失敗是最大的敵人」加的，不能自己說謊。
    const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
    if (!beat) say('監看      ✗ 從來沒跑過。要它一直看著就開一個終端機跑 `node cli.mjs watch`。')
    else if (!Number.isInteger(beatPid) || !alive(beatPid)) {
      say(`監看      ✗ 那個行程（pid ${beatPid || '?'}）已經不在了，最後一次心跳是 ${beatAgo}。`)
    } else if ((Date.now() - Date.parse(beat)) > 5 * 60_000) {
      say(`監看      ✗ 行程還在，但最後一次心跳是 ${beatAgo}，看起來卡住了。`)
    } else say(`監看      ✓ ${beatAgo}還活著（pid ${beatPid}）`)

    // doctor 是本機的人自己在看，給完整版（lastError 的內容只有帶 token 的才看得到）
    const h = healthSnapshot(db, { roots: CLEAN_ROOTS, quarantine: QUARANTINE, full: true })
    say(`隔離區    ${shown(QUARANTINE)}`)
    say(`          ${h.quarantine.items} 個檔案，${mb(h.quarantine.bytes)}`
      + (h.quarantine.items
        // canEmptyNow 的意思是「按下去**會有東西**被刪掉」，不是「整區都能清」。
        // 講成「現在可以清空」的話，使用者按完發現還有東西，會以為壞了。
        ? (h.quarantine.canEmptyNow ? '，其中有滿七天可以清空的' : '，最舊的還不到七天')
        : '')
      + (h.quarantine.orphans ? `\n          另有 ${h.quarantine.orphans} 個來路不明的檔，清空不會動到它們` : '')
      + (h.quarantine.truncated ? '\n          ⚠ 隔離區沒讀完，數字可能不準' : ''))
    let nh = null
    try { nh = listCandidates(db, { roots: CLEAN_ROOTS, limit: 0 }) } catch { /* 用 health 的總數 */ }
    say(`待清候選  ${h.pendingCandidates} 個` + needsHumanText(nh, h.needsHumanCount))

    // 最近一次意外（RC5）：人話＋時間。之後成功過的話寵物已經不擔心了，也要講。
    const errAt = h.lastErrorAt ?? null
    const errWhy = h.lastError
      ? (errAt && h.lastError.startsWith(errAt + ' ') ? h.lastError.slice(errAt.length + 1) : h.lastError)
      : null
    if (!errWhy) say('最近出錯  沒有')
    else {
      say(`最近出錯  ${errAt ? `${ago(errAt)}（${localTime(errAt)}）` : '時間不明'}：${shown(errWhy)}`)
      if (h.lastOkAt && errAt && h.lastOkAt > errAt) say(`          之後已經成功過（${ago(h.lastOkAt)}），寵物不會再為它擔心。`)
    }
    say('')

    const last = items.lastSeen()
    say(`最後收到  ${last ? `${ago(last)}（${last}）` : '還沒收過任何東西'}`)
    say('')

    if (!modelReady(config)) {
      say('模型      ✗ 還沒設定。請在設定檔填 model.baseUrl 與 model.name。')
    } else {
      say(`模型      ${shown(config.model.name)} @ ${shown(config.model.baseUrl)}`)
      const key = modelKey(config)
      say(`金鑰      ${key ? '✓ 從 ' + config.model.keyEnv + ' 讀到了' : '✗ 環境變數 ' + config.model.keyEnv + ' 是空的'}`)
      // 真的打一次。設定檔填對不代表連得到——靜默失敗是這種工具最大的敵人。
      say(`連線      ${await probeModel(config, key)}`)
    }
    say('')
    const c = items.counts()
    const total = Object.values(c).reduce((a, b) => a + b, 0)
    say(`收件匣    共 ${total} 筆` + (total ? '：' + Object.entries(c).map(([k, v]) => `${k} ${v}`).join('、') : ''))
    showProblems()
    break
  }

  case 'propose': {
    showProblems()
    if (!args.length) { warn('要給檔案路徑。例：node cli.mjs propose ~/Downloads/a.pdf'); process.exit(1) }
    const r = { new: 0, known: 0, rejected: 0 }
    for (const a of args) r[intake(a)]++
    // 「已經收過了」是成功。右鍵選單靠離開碼判斷成敗，
    // 回非零會在 Windows／Nautilus 上跳一個錯誤視窗給使用者看。
    if (r.new + r.known === 0) { process.exitCode = 1; break }
    say(`\n收了 ${r.new} 個新檔案`
      + (r.known ? `，${r.known} 個之前就收過了` : '')
      + (r.rejected ? `，${r.rejected} 個被擋下` : '') + '。')
    if (!modelReady(config)) {
      say('（模型還沒設定，所以只有記下來，還沒有人去看懂它。設定好之後跑 `node cli.mjs doctor` 確認。）')
    }
    break
  }

  case 'watch': {
    showProblems()
    if (!config.watch.length) { warn('設定裡沒有任何監看資料夾。'); process.exit(1) }

    const beat = () => { try { setMeta(META.heartbeat, new Date().toISOString()); setMeta(META.pid, process.pid) } catch { /* 資料庫忙就下次再寫 */ } }

    const w = createWatcher({
      roots: config.watch,
      maxBytes: config.maxBytes,
      exclude: [config.filed],
      onSeed: count => {
        say(`開機掃描：記住了 ${count} 個既有檔案，全部當成已經看過。`)
        say('之後才落地、或是內容有變的檔案才會進收件匣。要處理舊檔就用 propose 手動指定。')
      },
      onFile: v => {
        // 這裡丟例外不會讓檔案消失 —— watcher 會重試，重試太多次才放棄
        const { fresh } = items.add(v)
        say(`＋ ${new Date().toLocaleTimeString('zh-TW')}  ${shown(basename(v.real))}（${v.kind}）`
          + (fresh ? '' : '（內容沒變）'))
      },
      onProblem: m => warn('⚠ ' + shown(m)),
    })

    beat()
    w.start()
    const heartbeat = setInterval(beat, 30_000)
    say(`正在看：\n  ${config.watch.map(shown).join('\n  ')}`)
    say('按 Ctrl+C 停止。')
    if (!modelReady(config)) say('⚠ 模型還沒設定，收到的檔案只會被記下來，不會被看懂。')

    const bye = () => { clearInterval(heartbeat); w.stop(); say('\n停了。'); process.exit(0) }
    process.on('SIGINT', bye)
    process.on('SIGTERM', bye)
    setInterval(() => {}, 1 << 30)          // 讓行程活著
    break
  }

  case 'pet': {
    showProblems()
    const { start, uiUrl } = await import('./core/server.ts')
    const { createCleanupWatcher } = await import('./core/cleanup-watcher.ts')
    const want = portFromEnv() ?? DEFAULT_PORT
    // **roots、quarantine、maxBytes、readonly 全部傳進去。** 少給一個 server 就會自己再讀一次設定檔，
    // 而 pet 印出來的隔離區跟它剛啟動的那個 server 服務的就可能不是同一個。
    // 清理範圍是 cleanup.roots（RC15），不是截圖的 watch —— macOS 上 watch 含桌面。
    const srv = start({
      port: want, roots: CLEAN_ROOTS, quarantine: QUARANTINE,
      maxBytes: config.maxBytes, readonly: config.readonly,
    })
    let port
    try { port = await srv.ready }
    catch (e) {
      if (e?.code === 'EADDRINUSE') {
        // 網址**帶鑰匙**（RC16）：不帶 k 的網址打開是 401
        say(`已經有一個 ContextBox 在跑了。打開 ${uiUrl(want, srv.token)} 就好。`)
        break
      }
      warn('起不來：' + why(e?.message ?? e))
      process.exitCode = EXIT.backend
      break
    }

    // 心跳要有人寫，不然 /health 的 watcher 永遠說「從來沒跑過」，
    // 而寵物的 watching 狀態永遠進不去。
    const beat = () => { try { setMeta(META.heartbeat, new Date().toISOString()); setMeta(META.pid, process.pid) } catch { /* 忙就下次 */ } }
    beat()
    const heartbeat = setInterval(beat, 30_000)
    try { setMeta(PET_PORT_KEY, port) } catch { /* open 找不到就用預設的 port */ }

    // **印出來的網址一律帶鑰匙**（RC16）。只印 http://127.0.0.1:<port> 的話，使用者點下去是 401。
    say(`ContextBox 開在 127.0.0.1 的 ${port} 埠。`)
    say(`寵物與清理面板：${uiUrl(port, srv.token)}`)
    say('　（鑰匙已經帶在網址裡，直接打開就能用；之後要再打開：node cli.mjs open）')
    say('')
    say(`清理範圍：${rootsLabel()}`)
    say(`隔離區：${shown(QUARANTINE)}`)

    // **一啟動就全部掃一次，之後定期重掃**（RC2）。watcher 只看得到有事件的檔：
    // pet 沒開的時候刪掉、下載的檔，不全量掃描的話會一直（不）留在清單與徽章上。
    // 掃描成功要記 lastOk —— 寵物只在 lastError 比 lastOk 新的時候擔心（RC5）。
    const rescanMs = rescanFromEnv() ?? RESCAN_MS
    const fullScan = () => {
      try {
        const r = scanDownloads({
          db, roots: CLEAN_ROOTS, maxBytes: config.maxBytes,
          onProblem: m => warn('⚠ ' + shown(m)),
        })
        noteOk()
        if (r.truncated) warn('⚠ 檔案太多，這次只掃了前面那些。把清理範圍縮小。')
        return { scanned: r.scanned, files: listCandidates(db, { roots: CLEAN_ROOTS, limit: 0 }).totalAvailable }
      } catch (e) {
        noteError(e)
        warn(`⚠ 全部重掃的時候出錯（${why(e?.message ?? e)}）。掃描不會搬動或刪除任何檔案，下次會再試。`)
        return null
      }
    }
    const first = fullScan()
    say((first ? `開機掃描：掃了 ${first.scanned} 個檔案，${first.files} 個可以清。` : '')
      + `之後每 ${every(rescanMs)}全部重掃一次。`)
    const rescan = setInterval(fullScan, rescanMs)

    const w = createCleanupWatcher({
      db, roots: CLEAN_ROOTS, maxBytes: config.maxBytes,
      onProblem: m => warn('⚠ ' + shown(m)),
    })
    w.start()
    say('按 Ctrl+C 停止。')
    const bye = () => { clearInterval(heartbeat); clearInterval(rescan); w.stop(); say('\n停了。'); process.exit(0) }
    process.on('SIGINT', bye)
    process.on('SIGTERM', bye)
    break
  }

  case 'open': {
    // 印出帶鑰匙的網址，並試著用系統的方式打開瀏覽器（RC16）。
    // GET / 沒帶 k 是 401，那一頁就是叫人來跑這個指令。
    const { loadToken, uiUrl } = await import('./core/server.ts')
    let token
    try { token = loadToken() }
    catch (e) { warn('讀不到鑰匙：' + why(e?.message ?? e)); process.exitCode = EXIT.backend; break }
    const port = petPort()
    const url = uiUrl(port, token)
    if (!(await petUp(port))) {
      // 沒有人在聽就不要打開一個一定連不上的分頁；網址還是印出來，pet 起來之後就能用
      say(url)
      warn(`pet 好像沒在跑（127.0.0.1:${port} 沒有回應）。先跑 node cli.mjs pet，它會印出同一個網址。`)
      process.exitCode = EXIT.backend
      break
    }
    say(url)
    if (!(await openInBrowser(url))) warn('打不開瀏覽器，請自己複製上面的網址貼到瀏覽器。')
    break
  }

  case 'cleanup': {
    showProblems()
    const sub = args[0]

    if (sub === 'scan') {
      let r
      try {
        // 讀不到的資料夾、保險絲（整個資料夾看起來不見了）都經由 onProblem 講出來 ——
        // 不接的話，那些話只存在於 API 層，使用者永遠看不到。
        r = scanDownloads({
          db, roots: CLEAN_ROOTS, maxBytes: config.maxBytes,
          onProblem: m => warn('⚠ ' + shown(m)),
        })
      } catch (e) {
        noteError(e)
        warn(`掃描出錯（${why(e?.message ?? e)}），這次掃描可能沒有完成。掃描不會搬動或刪除任何檔案。`)
        process.exitCode = EXIT.backend
        break
      }
      noteOk()
      // scanner 回的 candidates 是**規則列數**，但 list 講的是**檔案數** ——
      // 這整支檔案存在的理由就是消掉這個差別，不可以在自己的 CLI 又端出來。
      const files = listCandidates(db, { roots: CLEAN_ROOTS, limit: 0 }).totalAvailable
      say(`掃了 ${r.scanned} 個檔案，${files} 個可以清。`)
      if (r.skipped) say(`${r.skipped} 個還在變動，這次跳過。`)
      // 讀不到的檔案**不算掃描失敗** —— 掃描的工作是更新資料庫，那件事成功了。
      // 它們已經記成 status=error，在 list 裡看得到。回非 0 會讓每晚 smoke 一直紅。
      if (r.errors) say(`${r.errors} 個讀不到，用 cleanup list 看是哪些。`)
      if (r.truncated) warn('⚠ 檔案太多，這次只掃了前面那些。把清理範圍縮小。')
      break
    }

    if (sub === 'list' || sub === undefined) {
      let r
      try { r = listCandidates(db, { roots: CLEAN_ROOTS, limit: Number.MAX_SAFE_INTEGER }) }
      catch (e) {
        // 後端錯是 2 不是 1，而且不要噴一坨 Node 堆疊
        warn('讀不到清理候選：' + cliProblem(e))
        process.exitCode = EXIT.backend
        break
      }
      const nhTotal = r.needsHumanTotal ?? r.needsHuman.length
      if (!r.totalAvailable && !nhTotal) {
        // 沒東西要清是**成功**，不是失敗
        const scanned = db.prepare(`SELECT count(*) n FROM file_items`).get().n
        say(scanned
          ? `沒有東西需要清，${rootsLabel()} 很乾淨。`
          : '還沒掃過。先跑 `node cli.mjs cleanup scan`。')
        break
      }
      if (r.totalAvailable) {
        // 編號看**全部**的候選算，不是只看列出來的那 500 個 —— --skip／--also 對的是全部
        const code = shortIds(r.candidates.map(c => c.itemId))
        const rows = r.candidates.slice(0, LIST_LIMIT)
        say(`有 ${r.totalAvailable} 個可以清掉的東西，大概 ${mb(r.bytes)}`
          + (rows.length < r.totalAvailable ? `（這裡只列前 ${rows.length} 個）` : '') + '\n')
        for (const c of rows) { printCandidate(c, code.get(c.itemId)); say('') }
        // 頁尾的數字要算**全部**打勾的，不受顯示上限影響（RC12）。自己數 rows 的話只有前 500 個。
        const n = r.defaultCheckedCount ?? r.candidates.filter(c => c.defaultChecked).length
        const bytes = r.defaultCheckedBytes ?? r.candidates.filter(c => c.defaultChecked).reduce((s, c) => s + c.bytes, 0)
        say(`☐ 的預設不清。cleanup apply 會清掉打勾的 ${n} 個，${mb(bytes)}`
          + (n > PLAN_MAX ? `（一次最多 ${PLAN_MAX} 個，剩下的下次再清）` : '') + '。')
        say('  跳過其中幾個：node cli.mjs cleanup apply --skip <編號>')
        say('  多清幾個 ☐ 的：node cli.mjs cleanup apply --also <編號>')
      }
      if (r.needsHuman.length) {
        say(`\n另外 ${nhTotal} 個需要你自己看一眼：`
          + (r.needsHumanTruncated ? `（只列前 ${r.needsHuman.length} 個）` : ''))
        for (const h of r.needsHuman) say(`  ${shown(h.name)}　${mb(h.bytes)}　—— ${shown(h.why)}`)
      }
      break
    }

    // ── 會真的動檔案的 ───────────────────────────────────────
    //
    // **離開碼的判準：2 ＝ 這個動作根本沒執行；3 ＝ 執行了但沒有全部成功。**
    // 呼叫端（右鍵選單、每晚 smoke）據此決定要不要重試：
    // 2 通常重試會成功（鎖住了、資料庫開不了），3 要人去看那幾個檔。

    if (sub === 'apply') {
      const a = parseApplyArgs(args.slice(1))
      if (a.error) { warn(a.error); process.exitCode = EXIT.badInput; break }
      if (a.planId) applyExisting(a.planId)
      else applyDefault(a)
      break
    }

    if (sub === 'undo') {
      let id = args[1]
      if (!id) {
        // 不給 id ＝ 最近一份還能復原的（docs/cli.md）。上一版直接回 1。
        let last
        try { last = listPlans(db, { filter: 'undoable', limit: 1 }).operations[0] }
        catch (e) { fail(e); break }
        if (!last) {
          warn('沒有可以復原的計畫：隔離區裡沒有這個工具搬過去、還沒放回的檔。')
          process.exitCode = EXIT.badInput
          break
        }
        id = last.id
        say(`復原最近一次清理：計畫 ${id}（${ago(last.appliedAt ?? last.createdAt) ?? '時間不明'}）`)
      }
      let plan
      try { plan = getPlan(db, id) }
      catch (e) { fail(e); break }
      // 還沒套用的計畫沒有東西可以復原。交給 B 的話它會把計畫標成「已復原」，那是在說謊。
      if (plan.status === 'proposed') {
        warn(`計畫 ${plan.id} 還沒套用，沒有東西可以復原。要放棄它：node cli.mjs cleanup release ${plan.id}`)
        process.exitCode = EXIT.badInput
        break
      }
      if (plan.status === 'dismissed') { say(`計畫 ${plan.id} 已經放棄了，沒有動過任何檔案，不用復原。`); break }
      if (plan.status === 'restored') {
        say(`計畫 ${plan.id} 已經復原過了。`)
        printPlanItems(plan, undoLine)
        break
      }
      if (config.readonly) {
        const o = planOutcomes(db, plan.id)
        const back = plan.items.filter(i => o.get(i.itemId)?.outcome === 'moved')
        say(`唯讀模式：會放回 ${back.length} 個檔案，但這次一個都沒動。`)
        for (const i of back) say(`  ↩ ${shown(i.name)}`)
        break
      }
      let r
      try { r = undoPlan(db, id, execOpts()) }
      catch (e) { fail(e); break }
      noteOk()
      // **逐項照 outcome 印**：↩ 只給真的放回去的，沒放回的講原因（還在隔離區、已清空、狀態不明）。
      // 列全部都打 ↩ 的話會出現「放回 2 個」後面接三行 ↩ —— 跟 apply 一律印 ✔ 是同一類的畫面說謊。
      const outcomes = planOutcomes(db, id)
      say(`放回 ${rootsLabel()} ${r.restoredCount} 個檔案。`)
      for (const i of r.items) say(undoLine(i, outcomes.get(i.itemId)))
      const left = r.items.map(i => outcomes.get(i.itemId)?.outcome).filter(k => ['moved', 'purged', 'unknown'].includes(k))
      if (left.length || r.status === 'partial' || r.status === 'error') {
        warn(`\n⚠ 有 ${left.length} 個沒放回（原因寫在上面）。`
          + (left.includes('unknown') ? '狀態不明的，執行 node cli.mjs doctor 檢查。' : ''))
        process.exitCode = EXIT.partial
      }
      break
    }

    if (sub === 'release') {
      // 放棄一份**還沒開始**的計畫：計畫作廢、檔案不動、候選還在（撞到 CONFLICT 時的第二條路）
      const id = args[1]
      if (!id) {
        warn('要給計畫 id。例：node cli.mjs cleanup release <plan-id>')
        process.exitCode = EXIT.badInput
        break
      }
      let r
      try { r = releasePlan(db, id) }
      catch (e) { fail(e); break }      // 沒有這份 → 1；已經開始執行 → CONFLICT → 1
      say(`放棄了計畫 ${r.id}：沒有動任何檔案。裡面的 ${r.items.length} 個檔還是候選，下次 cleanup apply 會再算進去。`)
      break
    }

    if (sub === 'quarantine') {
      const wantsEmpty = args.includes('--empty')
      const yesAt = args.indexOf('--yes')
      if (yesAt >= 0 && !wantsEmpty) { warn('--yes 要跟 --empty 一起用。'); process.exitCode = EXIT.badInput; break }

      // ── 第二步：帶著預覽給的確認碼真的刪 ──
      // **這是整個專案唯一會刪檔的路徑。** 確認的就是預覽的那一個：不再產生新的預覽（RC13）。
      // 上一版每次都先預覽一次，所以 `--yes` 後面沒給或給錯確認碼，畫面上還是會印出一個新的，回 2。
      if (wantsEmpty && yesAt >= 0) {
        const token = args[yesAt + 1]
        if (!token || token.startsWith('--')) {
          warn('--yes 後面要接預覽時印出來的確認碼。先跑：node cli.mjs cleanup quarantine --empty')
          process.exitCode = EXIT.badInput
          break
        }
        if (config.readonly) { say('唯讀模式：不會刪任何檔案，這次一個都沒動。'); break }
        let r
        try { r = emptyQuarantine(db, { ...execOpts(), token, confirmed: true }) }
        catch (e) {
          if (e instanceof CleanupError && (e.code === 'CONFIRMATION_REQUIRED' || e.code === 'CONFIRMATION_EXPIRED')) {
            warn(`${shown(e.message)}先跑：node cli.mjs cleanup quarantine --empty`)
            process.exitCode = EXIT.badInput
            break
          }
          fail(e)
          break
        }
        noteOk()
        say(`刪掉 ${r.deletedCount} 個，${mb(r.deletedBytes)}。`)
        if (r.errors.length) {
          warn(`${r.errors.length} 個沒刪成：`)
          for (const x of r.errors) warn(`  ${shown(x.error)}`)
          process.exitCode = EXIT.partial
        }
        break
      }

      // 純讀，不上鎖：CLI 另一個視窗正在套用的時候，看一眼隔離區不該收到「忙碌中」
      let rows
      try { rows = quarantineItems(db) }
      catch (e) { fail(e); break }

      if (wantsEmpty) {
        // ── 第一步：預覽，給一個確認碼 ──
        const ready = rows.filter(r => r.canEmptyNow)
        if (!ready.length) {
          // 沒有東西可清就不產生預覽（確認碼）
          const soonest = rows.map(r => Date.parse(r.canEmptyAt)).sort((a, b) => a - b)[0]
          say(rows.length
            ? `還沒有滿七天的檔案。最早的那個還要等 ${days(soonest)} 天。`
            : '隔離區是空的。')
          break
        }
        if (config.readonly) {
          say(`唯讀模式：滿七天的有 ${ready.length} 個，${mb(ready.reduce((n, r) => n + r.bytes, 0))}，這次一個都沒動。`)
          break
        }
        let prep
        try { prep = prepareEmptyQuarantine(db, execOpts()) }
        catch (e) { fail(e); break }
        if (!prep.itemCount) { say('還沒有滿七天的檔案。'); break }
        say(shown(prep.message))
        say(`會永久刪除 ${prep.itemCount} 個檔案，${mb(prep.bytes)}。`)
        // **二次確認要人真的再打一次。**
        say(`確定的話跑：node cli.mjs cleanup quarantine --empty --yes ${prep.token}`)
        break
      }

      if (!rows.length) { say('隔離區是空的。'); break }
      say(`隔離區有 ${rows.length} 個檔案，${mb(rows.reduce((n, r) => n + r.bytes, 0))}：\n`)
      for (const r of rows) {
        say(`  ${shown(r.name)}　${mb(r.bytes)}`)
        say(`         ${r.canEmptyNow ? '可以清空了' : `還要等 ${days(Date.parse(r.canEmptyAt))} 天`}`)
      }
      break
    }

    if (sub === 'dismiss') {
      // 不是「還沒做好的後端」（2），是這個指令根本不存在：輸入錯（1）
      warn('cleanup dismiss 這個指令還沒有。要放棄一份還沒套用的計畫：node cli.mjs cleanup release <plan-id>')
      process.exitCode = EXIT.badInput
      break
    }

    warn(`不認得 cleanup ${shown(sub ?? '')}。可以用：scan、list、apply、undo、release、quarantine`)
    process.exitCode = EXIT.badInput
    break
  }

  case 'list': {
    showProblems()
    const status = args[0]
    const rows = items.list(status, 50)
    if (!rows.length) { say(status ? `沒有狀態是 ${shown(status)} 的東西。` : '收件匣是空的。'); break }
    for (const r of rows) say(`${r.status.padEnd(13)} ${r.kind.padEnd(10)} ${shown(basename(r.path))}`)
    say(`\n共 ${rows.length} 筆。`)
    break
  }

  case 'search': {
    showProblems()
    const q = args.join(' ').trim()
    if (!q) { warn('要給搜尋字詞。'); process.exit(1) }

    // trigram 索引至少要三個字元才建得起來，所以短詞走 LIKE。
    // 中文的詞大多是兩個字（發票、收據、學費），不處理的話這個工具
    // 會對「發票」回「找不到」，而使用者會以為是資料沒進去。
    const short = [...q].length < 3
    // LIKE 的 % 與 _ 是萬用字元。不跳脫的話 `search %` 會把整個資料庫
    // 倒出來 —— 包含每一張截圖抄下來的字。
    const like = q.replace(/[\\%_]/g, c => '\\' + c)
    let rows
    try {
      rows = short
        ? db.prepare(
            `SELECT i.*, f.summary FROM items_fts f JOIN items i ON i.id = f.item_id
             WHERE f.name LIKE '%' || ? || '%' ESCAPE '\\'
                OR f.summary LIKE '%' || ? || '%' ESCAPE '\\'
                OR f.text LIKE '%' || ? || '%' ESCAPE '\\' LIMIT 20`
          ).all(like, like, like)
        : db.prepare(
            `SELECT i.*, f.summary FROM items_fts f JOIN items i ON i.id = f.item_id
             WHERE items_fts MATCH ? ORDER BY rank LIMIT 20`
          ).all(ftsQuery(q))
    } catch (e) {
      warn(`這個搜尋字詞資料庫看不懂（${shown(e.message)}）。換個說法再試一次。`)
      process.exitCode = 1
      break
    }

    if (!rows.length) {
      say(`找不到「${shown(q)}」。`)
      const n = db.prepare(`SELECT count(*) n FROM understanding`).get().n
      if (!n) say('（目前一份文件都還沒被看懂，所以搜尋還沒有東西可以找。那是 P1 的事。）')
      break
    }
    for (const r of rows) say(`${shown(basename(r.path))}\n   ${shown(r.summary ?? '')}\n   ${shown(r.path)}\n`)
    break
  }

  default: {
    say(`ContextBox —— 檔案與截圖管線

  node cli.mjs doctor                      這台機器現在什麼狀況
  node cli.mjs pet                         啟動寵物與清理面板
  node cli.mjs open                        打開寵物與清理面板（pet 要先在跑）
  node cli.mjs cleanup scan                掃一次清理範圍（預設只有 Downloads）
  node cli.mjs cleanup list                看有什麼可以清
  node cli.mjs cleanup apply [--skip 編號] [--also 編號]
                                           清掉打勾的（編號是 list 上 [ ] 裡的那幾碼）
  node cli.mjs cleanup undo [計畫 id]       復原（不給 id 就是最近一次）
  node cli.mjs cleanup release <計畫 id>    放棄一份還沒套用的計畫（不動檔案）
  node cli.mjs cleanup quarantine [--empty] 看隔離區／清空（要滿七天、要二次確認）
  node cli.mjs watch                       常駐監看
  node cli.mjs propose <檔案>...            手動收一個檔案
  node cli.mjs list [狀態]                  看收件匣
  node cli.mjs search <詞>                  全文搜尋

設定檔在 ${shown(CONFIG_PATH)}`)
    if (cmd) process.exit(1)
  }
}
