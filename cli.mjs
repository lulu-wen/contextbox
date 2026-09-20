#!/usr/bin/env node
/**
 * ContextBox 命令列 —— 檔案與截圖管線的入口。
 *
 *   node cli.mjs doctor              這台機器現在什麼狀況
 *   node cli.mjs pet                 啟動寵物與清理面板（印出帶鑰匙的網址）
 *   node cli.mjs open                打開寵物與清理面板（pet 要先在跑）
 *   node cli.mjs cleanup ...         清理：scan、list、apply、undo、release、quarantine
 *   node cli.mjs think               讓模型看一輪還沒看過的檔（要先設定 model 與金鑰）
 *   node cli.mjs rename              替沒取名的檔改名（列建議／--apply／--undo，改得回來）
 *   node cli.mjs file                把同一堂課的檔歸成資料夾（列建議／--apply／--undo，搬得回來）
 *   node cli.mjs learned             它從你的修改學到什麼（--forget／--forget-all 忘得掉）
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
 *   CONTEXTBOX_SCAN_TIMEOUT_MS  pet 的背景掃描最多跑多久（預設 10 分鐘，超過就殺掉）
 *   CONTEXTBOX_OPENER      open 用來打開網址的程式（預設看作業系統）
 */
import { load, modelReady, modelKey, CONFIG_PATH } from './core/config.ts'
import { modelEnabled, whyDisabled, PROMPT_VERSION } from './core/model.ts'
import { modelStats } from './core/model-store.ts'
import { thinkRound, ROUND_MAX_ITEMS } from './core/model-queue.ts'
import { admit } from './core/guard.ts'
import { createWatcher } from './core/watcher.ts'
import { open, DEFAULT_DB } from './core/db.ts'
import { Items } from './core/items.ts'
import {
  listCandidates, healthSnapshot, META, planOutcomes, defaultCandidateIds, createPlanForRoots,
  blockingPlanFor, recordItemErrors, listPlans, quarantineItems, safeWhy,
  recordOk, recordCleanupError, recordActionResult, recordScanProblems, scanProblems, errorStillActive,
  invalidateQuarantineCache,
} from './core/cleanup-routes.ts'
import * as routes from './core/cleanup-routes.ts'
import { applyPlan, undoPlan, checkedPath, recoverInterrupted } from './core/cleanup-exec.ts'
import {
  applyRenames, listRenames, recoverInterruptedRenames, RENAME_BATCH_MAX, renameSuggestions, undoRenames,
} from './core/rename.ts'
import {
  applyFilings, FILING_BATCH_MAX, filingSuggestions, listFilings, recoverInterruptedFilings, undoFilings,
} from './core/filing.ts'
import { courseKey, forgetAllLearned, forgetLearned, listLearned } from './core/learn.ts'
import { getPlan, releasePlan, releaseStalePlans } from './core/cleanup-plans.ts'
import { prepareEmptyQuarantine, emptyQuarantine } from './core/cleanup-quarantine.ts'
import { CleanupError } from './core/cleanup-journal.ts'
import { scanDownloads } from './core/cleanup-scanner.ts'
import { existsSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { basename, resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

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
/**
 * pet 的背景掃描最多跑多久（第二輪 R2-10）。清理範圍在斷線的網路碟上時，readdir 會卡住、子行程永遠不結束 ——
 * 以前 pet 就安靜地再也不重掃，lastError 也不記。超過就殺掉、記一筆，下一輪照常。
 */
const SCAN_TIMEOUT_MS = 10 * 60_000
/** 背景掃描逾時記進 lastError 的那句話（掃描種類） */
const SCAN_TIMEOUT_WHY = 'Background scan timed out (a folder may be stuck)'
/**
 * pet 多久讓模型看一輪（P2）。比重掃密一點：新下載的檔十分鐘內就會有「模型認為⋯⋯」，
 * 而一輪最多 20 個檔（一個 7～10 秒），最壞情況三分鐘，不會兩輪疊在一起。
 */
const THINK_MS = 10 * 60_000
/** 從沒開始的計畫放多久就自動放棄（第二輪 R2-5，核心的 releaseStalePlans）。 */
const STALE_PLAN_MS = 60 * 60_000
/** 指名一份計畫時，自動放棄的門檻往前多留這麼久（第三輪 R3-6b，見 staleCutoffMs）。 */
const SKIP_PLAN_MARGIN_MS = 5 * 60_000
/** 放棄了的計畫是誰放棄的：人，或收尾（STALE_PLAN_MS）。CLI 分不出來，兩種都講 */
const DISMISSED_WHO = 'someone dropped it, or it sat unapplied for over an hour and was dropped automatically'
/** `rename` 印幾筆「最近改過的」，也是 `--undo <編號>` 認得的範圍（兩邊一定要一樣）。 */
const RENAME_LIST = 20
/** `file` 印幾筆「最近整理過的」，也是 `--undo <編號>` 認得的範圍（跟改名同一個規矩）。 */
const FILING_LIST = 20
const DEFAULT_PORT = 7391
/** 這支檔案自己。pet 的全量掃描開子行程跑的就是它（C2）。 */
const CLI_FILE = fileURLToPath(import.meta.url)

const mb = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB'
  : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B'

/** 數字＋名詞。1 不加 s —— 畫面上的「1 files」看起來像程式壞了。 */
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * 顯示用的字串（檔名、資料夾名、錯誤訊息）：C0／C1 控制字元與換行一律換成「·」（RC14）。
 *
 * 檔名是不可信的輸入。原樣印出來的話，名字裡的 ESC 會變成終端機指令（改顏色、改視窗標題），
 * 換行可以偽造一行「✔ 某某檔」—— 而這支工具的全部價值就是使用者信得過它印出來的結果。
 * U+2028／U+2029 在有些終端機與記錄檔裡也會換行，一起換。
 *
 * **bidi 控制字元也換**（第三波 C5）：Unicode 的 Bidi_Control 全部（U+061C、U+200E、U+200F、
 * U+202A–202E、U+2066–2069）。`invoice\u202Efdp.exe` 原樣印出來，畫面上是「invoiceexe.pdf」——
 * 看起來是 PDF 的其實是執行檔。一般的中文、emoji 不在裡面，原樣印。
 */
const shown = s => String(s ?? '')
  .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, '·')

/** 失敗原因一律經過核心唯一的翻譯函式（safeWhy），再拿掉控制字元 */
const why = raw => shown(safeWhy(raw == null ? null : String(raw)) ?? 'reason unknown')

const [, , cmd, ...args] = process.argv

const { config, problems, path: cfgPath, created } = load()

let db
try { db = open() }
catch (e) {
  // 右鍵選單一次選 N 個檔就是 N 個行程同時開資料庫。
  // 讓它印一句人話，不要印一坨 Node 堆疊。
  console.error(`Could not open the database ${DEFAULT_DB}: ${e.message}`)
  console.error('If several copies started at once, wait a moment and try again.')
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
/**
 * 截圖資料夾（cleanup.screenshots 開著才有）：**那底下只清截圖**（第二輪 R2-8）。macOS 的截圖資料夾就是桌面 ——
 * 清單、預設清理、建計畫、doctor 與 pet 的徽章都要帶著它，不然桌面上的舊壓縮檔又被當成垃圾（RC15 換個開關回來）。
 */
const SHOTS = config.cleanup.screenshotsDir ?? null
/** 清單、預設清理、建計畫、健康檢查用的範圍：清理範圍＋截圖資料夾（核心的 CleanupScope） */
const SCOPE = { roots: CLEAN_ROOTS, screenshotsDir: SHOTS }
// 兩個以上的資料夾用英文的頓號串（`Downloads and Desktop`）—— 這一句會塞進英文句子裡
const rootsLabel = () => {
  const names = CLEAN_ROOTS.map(r => shown(basename(r) || r))
  if (!names.length) return 'Downloads'
  if (names.length === 1) return names[0]
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]
}
const execOpts = () => ({
  roots: CLEAN_ROOTS, quarantine: QUARANTINE,
  maxBytes: config.maxBytes, readonly: config.readonly,
})

/**
 * **復原**（放回原位）用的範圍：清理範圍 ∪ 截圖的監看資料夾（第三波 C4）。
 *
 * 舊版 CLI 用 watch 清理過（RC15 之前），桌面上的檔可能還在隔離區。只給 CLEAN_ROOTS 的話
 * 執行層的 originalPath 說「不在清理資料夾內」—— 放不回去，滿七天 --empty 卻刪得掉。
 * 放回原位不會擴大清理範圍，所以**只有 undo 用這一份**；apply、empty 維持 CLEAN_ROOTS。
 *
 * 執行層是逐一 checkedPath 每一個 root：不存在的、路徑含捷徑的資料夾放進去的話，
 * 它會先丟例外，**每一個檔**都放不回去。所以加進來之前先用同一支檢查過，過不了就略過。
 * **清理範圍本身也一樣要過這一關**（第三波之二）：cleanup.roots 裡有一個外接碟拔掉了，
 * 上一版原樣放進去，放回桌面的檔（C4）就整個失效。
 */
function undoRoots() {
  const out = []
  for (const r of restoreRootList()) {
    try { checkedPath(r, true); out.push(r) } catch { /* 不存在、不是資料夾、含捷徑：放不回那裡，略過 */ }
  }
  return out
}
const undoOpts = () => ({ ...execOpts(), roots: undoRoots() })

/**
 * 放回範圍的**全部**資料夾，還沒過濾（清理範圍 ∪ watch，去掉重複）。pet 交給 server 的是這一份（第二輪 R2-4）：
 * server 每次復原都會逐一 checkedPath、過不了的略過（跟 undoRoots 同一個規則），
 * 所以 pet 開著的時候才插上的外接碟也放得回去；pet 啟動時先過濾的話，那一個就一直不在裡面。
 */
function restoreRootList() {
  return [...new Set([...CLEAN_ROOTS, ...config.watch])]
}

const say = (...a) => console.log(...a)
const warn = (...a) => console.warn(...a)

const showProblems = () => { for (const p of problems) warn('⚠ ' + shown(p)) }

/** 還要等幾天，無條件進位 —— 「還要等 0 天」是錯的訊息。 */
const days = (at) => Math.max(1, Math.ceil((at - Date.now()) / 86400_000))

/** 這個 pid 的行程還在嗎。EPERM ＝ 在，只是不是我們的。 */
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

/**
 * 清空的確認碼現在還能不能用：能用回 null，不能用回一句話（C6，唯讀模式用）。
 *
 * 唯讀模式不可以叫 emptyQuarantine（它會刪檔），但「確認碼錯回 1」是契約 —— 只好自己讀。
 * **判斷照核心的 emptyQuarantine**：沒有這個確認碼 → 無效；已經確認過（有結果）→ 能用
 * （重送回原本的結果）；過期 → 過期。話也是核心那兩句。
 */
function emptyTokenProblem(token) {
  const ready = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='cleanup_empty_requests'`).get()
  const row = ready ? db.prepare('SELECT expires_at, result FROM cleanup_empty_requests WHERE token=?').get(token) : undefined
  if (!row) return 'That confirmation code is not valid. Run the preview again.'
  if (row.result) return null
  return Date.now() >= Date.parse(row.expires_at) ? 'That confirmation code has expired. Run the preview again.' : null
}

/**
 * 清空做到一半停下來的時候，**已經永久刪掉幾個**（第三輪 R3-3b）。
 *
 * 核心每刪掉一項就把進度寫進 cleanup_empty_progress（R2-6），做完才刪掉那一列 ——
 * 所以這一列還在，就代表上一次沒做完。只讀，不改。讀不到（沒有那張表、JSON 壞了）回 null，
 * 那種情況照舊只講「被打斷」，不亂報數字。
 */
/** 已經永久刪掉幾個（cleanup_purges 的 done）。用來判斷「**這一次**有沒有真的動到東西」。 */
function countPurged() {
  try {
    const ready = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='cleanup_purges'`).get()
    if (!ready) return 0
    return Number(db.prepare(`SELECT count(*) n FROM cleanup_purges WHERE status='done'`).get()?.n) || 0
  } catch { return 0 }
}

function emptyProgress(token) {
  try {
    const ready = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='cleanup_empty_progress'`).get()
    const row = ready ? db.prepare('SELECT result FROM cleanup_empty_progress WHERE token=?').get(token) : undefined
    if (!row?.result) return null
    const v = JSON.parse(row.result)
    return Number.isFinite(v?.deletedCount)
      ? { deletedCount: Number(v.deletedCount), deletedBytes: Number(v.deletedBytes) || 0 }
      : null
  } catch { return null }
}

// ── meta：給健康檢查用的心跳 ──────────────────────────────────
const setMeta = (k, v) =>
  db.prepare(`INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(k, String(v))
const getMeta = k => (db.prepare(`SELECT v FROM meta WHERE k=?`).get(k) ?? {}).v ?? null

// ── 成功與意外都要記下來，寵物與 doctor 才看得到（RC5） ─────────
//
// **分種類記**（第二輪 R2-10）：scan、apply、undo、empty。寵物只拿**同一種**動作的成功來蓋掉那一種的錯 ——
// 以前 CLI 記的都是沒種類的成功，pet 每 30 分鐘的背景重掃（就是 cleanup scan）一成功，
// 一直壞著的套用就被蓋掉了；反過來，面板掃描壞過一次，CLI 的掃描成功也蓋不掉它（有種類的錯只認同一種）。
// 核心的 recordOk／recordCleanupError／recordActionResult 自己會吞掉寫入錯誤，這裡再包一層保險。

/** 一次成功的掃描（套用、復原、清空用 noteResult）。寫不進去不可以讓指令本身失敗（頂多寵物多擔心一下）。 */
function noteOk(kind) {
  try { recordOk(db, kind) } catch { /* 忙就算了 */ }
}

/**
 * 套用、復原、清空做完之後記一筆：**每一項都失敗記成那一種的錯，其他記成功**（核心的 recordActionResult）。
 * 以前一律記成功 —— 整份計畫每一項都 EXDEV，寵物照樣說沒事。
 */
function noteResult(kind, r) {
  try { recordActionResult(db, kind, r) } catch { /* 忙就算了 */ }
}

/** 意外才記（哪些算意外由核心的 isSurprise 決定：BUSY、使用者輸入錯都不算），存的是人話。kind 是哪一種動作出的錯。 */
function noteError(e, kind) {
  try { recordCleanupError(db, e, kind) } catch { /* 連 meta 都寫不進去就算了 */ }
}

/**
 * **收尾**（第二輪 R2-1a／R2-5）：每一個會讀或動清理狀態的指令之前（cleanup scan／list／apply／undo／release／quarantine、
 * doctor）、pet 開機與每一輪背景重掃之前都跑一次。
 *
 * - recoverInterrupted：搬到一半被砍（kill -9、斷電、Ctrl+C 落在 rename 與寫 done 之間）的 journal 列停在 started。
 *   檔其實已經在隔離區，但隔離區清單、可以復原的計畫都只認 done —— 單檔計畫被砍的話，每個入口都說「沒有」，
 *   檔對使用者來說就是不見了（稽核 A-exp8）。它只看檔案證據改 journal，不搬任何檔。
 * - releaseStalePlans：放了超過一小時、從沒開始的計畫自動放棄（候選不動）。不然它一直佔住那些檔，
 *   寵物一直說「有 1 份清單等你確認」，面板不一定找得到它。開始過的不動：只能做完或放回。
 *
 * **鎖被別的行程拿著（BUSY）就安靜略過這一次**：那個行程正在搬，收尾等下一次；指令本身照跑，不可以因為它失敗。
 * 其他錯講一行，指令照跑 —— 收尾是幫忙，不是前提。
 */
/**
 * 收尾試過、收不動的 journal 列長什麼樣（第三輪 R3-11）。
 * 隔離區那份與原位那份的**大小與 mtime** —— 兩邊都沒變的話，recoverInterrupted 再跑一次
 * 一定還是收不動（它比的是同一組檔案的指紋）。故意不算 SHA-256：那正是要避免的成本。
 */
function journalRowShape(row) {
  const of = p => {
    try {
      const st = statSync(p, { throwIfNoEntry: false })
      return st ? `${st.size}@${st.mtimeMs}` : '-'
    } catch { return '?' }   // 讀不到：每次都當成「不一樣」，寧可多試一次
  }
  return `${row.status}|${of(row.to_path)}|${of(row.from_path)}`
}

/** 收尾動得了的那幾種 journal 列（跟核心的 recoverInterrupted 同一組：只有 quarantine 與 restore 收得掉）。 */
const startedJournalRows = () => db.prepare(
  `SELECT seq, status, from_path, to_path FROM cleanup_journal
   WHERE status='started' AND op IN ('quarantine','restore') ORDER BY seq`).all()

/** meta 裡記的「這幾列收不動」。壞掉、還沒有就是空的。 */
function stuckJournalMemo() {
  try {
    const v = JSON.parse(getMeta(META.stuckJournal) ?? '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch { return {} }
}

/**
 * 有沒有東西要收尾？**先唯讀問一次，沒有就不要去拿清理鎖。**
 * pet 每 30 分鐘重掃前都會收尾，無條件拿鎖的話，剛好在面板或 CLI 動作時會讓對方收到 BUSY
 * （第二輪第二階段驗證員）。這幾個查詢都不寫任何東西。
 *
 * **收不動的列要記得**（第三輪 R3-11）：recoverInterrupted 對「兩邊都對不上」的列明文維持 started
 * （例如 rename 完成了、驗證沒過、原位又被佔住的 LEFT_IN_QUARANTINE）。只問「有沒有 started」的話，
 * 那一列讓這支函式**永遠**回 true —— 之後每一個清理指令與 pet 的每一輪都會拿清理寫鎖、
 * 對那些檔重算 SHA-256（一份最多 maxBytes），「沒事就不拿鎖」形同失效。
 * 所以比對 meta 裡記下來的樣子：同一列、隔離區與原位那兩個檔都沒變 → 這次不必再試。
 * 檔案變動了（樣子對不上）、或出現新的 started 列 → 照常再試一次。
 */
function needsSettling() {
  try {
    const memo = stuckJournalMemo()
    for (const row of startedJournalRows()) {
      if (memo[row.seq] !== journalRowShape(row)) return true
    }
    const cutoff = new Date(Date.now() - STALE_PLAN_MS).toISOString()
    if (db.prepare(`SELECT 1 FROM cleanup_plans p WHERE p.status='proposed' AND p.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM cleanup_journal j WHERE j.plan_id = p.id) LIMIT 1`).get(cutoff)) return true
    // 改名也要收尾（P3）：以前只有 rename 指令會收，pet 與 doctor 都不收 ——
    // 改名被砍之後只要先掃一次，那一筆就再也收不了尾、也復原不回來（P3 驗證員）
    if (db.prepare(`SELECT 1 FROM renames WHERE status='started' LIMIT 1`).get()) return true
    // 歸檔也一樣（P4）。搬家更嚴重：filed 不在掃描範圍裡，沒收到尾的那一筆
    // 不會有任何別的東西把它接回來
    return Boolean(db.prepare(`SELECT 1 FROM filings WHERE status='started' LIMIT 1`).get())
  } catch { return false }   // 還沒有清理的表：沒有東西要收尾
}

/**
 * 收尾跑完之後，把**還是 started 的那幾列**記成「收不動」（第三輪 R3-11）。
 * 每次整份覆寫：收掉的列自動不見，不用另外清。recoverInterrupted 真的跑完才記 ——
 * 被 BUSY 擋掉那一次什麼都沒試，記了會把一列本來收得掉的列擋在外面。
 */
function rememberStuckJournal() {
  try {
    const next = {}
    for (const row of startedJournalRows()) next[row.seq] = journalRowShape(row)
    setMeta(META.stuckJournal, JSON.stringify(next))
  } catch { /* 寫不進去就算了：頂多下一次再拿一次鎖 */ }
}

/**
 * 收尾。`skipPlanId` 是使用者這一次**指名**的那一份計畫（第三輪 R3-6b）：
 * 不可以在同一個指令裡先把它自動放棄，然後回報「什麼都沒做、成功」。
 *
 * **唯讀模式整個不做**（第三輪 R3-9）：這兩支都會寫資料庫 —— recoverInterrupted 改 journal，
 * releaseStalePlans 改 cleanup_plans 與 cleanup_plan_releases。使用者拿唯讀模式當純預覽
 * （docs/cli.md、smoke 第 0 步），一個 `cleanup list`、甚至一個純診斷的 `doctor`
 * 就把放著的待處理計畫作廢，面板按「繼續上次那份」只會拿到「這份計畫已經被放棄了」。
 */
function settleCleanupState({ skipPlanId = null } = {}) {
  if (config.readonly) return
  if (!needsSettling()) return
  const steps = [
    () => { recoverInterrupted(db, execOpts()); rememberStuckJournal() },
    () => releaseStalePlans(db, staleCutoffMs(skipPlanId), { skipPlanId: skipPlanId ?? undefined }),
    () => recoverInterruptedRenames(db),
    () => recoverInterruptedFilings(db),
  ]
  for (const step of steps) {
    try { step() }
    catch (e) {
      if (e instanceof CleanupError && e.code === 'BUSY') continue
      warn(`⚠ Could not finish tidying up the interrupted cleanup (${e instanceof CleanupError ? shown(e.message) : why(e?.message ?? e)}). Skipping it this time.`)
    }
  }
  // pet 的 server 跟這裡是同一個行程：隔離區的計數有快取，journal 剛改過就不可以再用
  try { invalidateQuarantineCache() } catch { /* 沒有快取就算了 */ }
}

/**
 * 這一次的收尾要放棄「放了多久」的計畫（第三輪 R3-6b）。
 *
 * 平常就是 STALE_PLAN_MS。使用者指名一份計畫（`cleanup apply <id>`／`cleanup undo <id>`）的時候，
 * 門檻放寬到**那一份的建立時間之前** —— 也就是「這一次只放棄比它更舊的」。不然 `cleanup apply <id>`
 * 會在前一毫秒把使用者指名的那一份作廢，然後印「這次什麼都沒做」、回 0（腳本會判定清理完成）。
 *
 * 同時也把 `{ skipPlanId }` 交給核心：那是 releaseStalePlans 之後會認的參數，
 * 到位之後這裡的門檻只是多一層保險（它現在只收兩個參數，第三個會被忽略）。
 */
function staleCutoffMs(skipPlanId) {
  if (!skipPlanId) return STALE_PLAN_MS
  try {
    const row = db.prepare(`SELECT created_at FROM cleanup_plans WHERE id=? AND status='proposed'`).get(skipPlanId)
    const at = row ? Date.parse(row.created_at) : NaN
    if (!Number.isFinite(at)) return STALE_PLAN_MS
    // 留一段緩衝：核心是用**它自己的** Date.now() 減這個毫秒數算門檻，晚我們幾毫秒到幾秒
    // （慢的磁碟、拿鎖等了一下）。不留緩衝的話門檻會剛好落在那一份的建立時間之後，它還是被作廢。
    // 代價是「建立時間比它早不到五分鐘」的別份計畫這一次也留著 —— 下一個沒指名的指令會收掉。
    return Math.max(STALE_PLAN_MS, Date.now() - at + SKIP_PLAN_MARGIN_MS)
  } catch { return STALE_PLAN_MS }
}

/**
 * CleanupError → 離開碼。
 *
 * **判準：1 ＝ 要換個做法（打錯 id、確認碼錯、跟現在的狀態衝突）；
 * 2 ＝ 這個動作根本沒執行，等一下重試通常會過；3 ＝ 執行了但沒有全部成功。**
 * 呼叫端據此決定要不要重試：CONFLICT 重試一百次也一樣，所以不是 2。
 */
// READ_ONLY 也是 1（稽核 2026-09-20）：唯讀是使用者自己開的開關，**重試一百次也一樣** ——
// 那正是「要換個做法」，不是「等一下會過」。docs/cli.md 三處都寫 1，程式卻回 2。
const INPUT_ERRORS = new Set([
  'NOT_FOUND', 'BAD_BODY', 'CONFLICT', 'CONFIRMATION_REQUIRED', 'CONFIRMATION_EXPIRED', 'READ_ONLY',
])
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
  : `Something went wrong (${why(e?.message ?? e)}), so this step may not have completed. Run node cli.mjs doctor to see the current state.`

function fail(e, kind) {
  warn(cliProblem(e))
  noteError(e, kind)
  process.exitCode = exitFor(e)
}

/** 「3 分鐘前」這種人看得懂的講法 */
function ago(iso) {
  if (!iso) return null
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 90) return `${Math.round(s)}s ago`
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 172800) return `${Math.round(s / 3600)} hours ago`
  return `${plural(Math.round(s / 86400), 'day')} ago`
}

// 時間一律用 en-GB（24 小時制、日／月／年）—— zh-TW 會吐「上午／下午」，
// 那是英文畫面裡最刺眼的一段中文（稽核 2026-09-20）
const localTime = iso => new Date(iso).toLocaleString('en-GB', { hour12: false })

/** 「每 30 分鐘」「每 0.2 秒」 */
const every = ms => ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms / 1000}s`

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
    if (res.status === 401 || res.status === 403) return `✗ Reachable, but the key was rejected (${res.status})`
    if (!res.ok) return `✗ ${url} returned ${res.status}`
    const data = await res.json().catch(() => ({}))
    const names = (data.data ?? []).map(m => m.id)
    if (!names.length) return '✓ Reachable, but it lists no models'
    return names.includes(cfg.model.name)
      ? `✓ Reachable, ${cfg.model.name} is up (${names.length} models in all)`
      : `✗ Reachable, but there is no model called ${cfg.model.name}. It has: ${names.slice(0, 6).map(shown).join(', ')}`
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? 'no response in 8s' : (e?.message ?? e)
    return `✗ Cannot reach ${url} (${shown(why)})`
  }
}

/** 收一個檔案。回 'new'｜'known'｜'rejected' */
function intake(path, { quiet = false } = {}) {
  const v = admit(resolve(path), admitOpts)
  if (!v.ok) {
    if (!quiet) warn(`✗ ${shown(basename(path))}: ${shown(v.why)}`)
    return 'rejected'
  }
  let added
  try { added = items.add(v) }
  catch (e) { if (!quiet) warn(`✗ ${shown(basename(path))}: ${shown(e.message)}`); return 'rejected' }

  if (!quiet) {
    const sameContent = items.bySha(added.item.sha256, added.item.id)
    say(`✓ ${shown(basename(v.real))}  ${v.kind}  ${(v.bytes / 1024).toFixed(0)}KB`
      + (added.fresh ? '' : ' (already taken in, unchanged)')
      + (sameContent.length ? `  · ${sameContent.length} other files have the same contents, so the reading can be shared` : ''))
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
    if (code.length < 4) return { error: `${flag} ${shown(raw)}: an id needs at least 4 characters — the ones in [ ] on the cleanup list.` }
    const hits = rows.filter(r => r.itemId.toLowerCase().startsWith(code))
    if (!hits.length) return { error: `No id ${shown(raw)} on the list. Run node cli.mjs cleanup list to see the current ids.` }
    if (hits.length > 1) {
      const short = shortIds(rows.map(r => r.itemId))
      return { error: `The id ${shown(raw)} matches more than one file. Type a few more characters:\n`
        + hits.slice(0, 10).map(r => `  [${short.get(r.itemId)}] ${shown(r.name)}`).join('\n') }
    }
    if (!out.includes(hits[0])) out.push(hits[0])
  }
  return { rows: out }
}

/**
 * 「它學到的事」印成一行人話（P5）。**三種各講各的**：混成同一句的話，
 * 「退過貨」那一種會看起來像「模型說 課程/OS/講義、你要（空白）」，使用者看不懂那是什麼。
 */
function learnedLine(r) {
  if (r.kind === 'rejected') {
    // **改名那一種不講名字**：那個摘要是真的檔名，而回給畫面的東西不可以有檔名（稽核 2026-09-20）。
    // 歸檔那一種的摘要是 `課程/<課名>/<類型>`，沒有檔名，講出來使用者才知道是哪一個建議。
    const which = r.about ? `the suggestion “${r.about}”` : 'a rename suggestion'
    return `turned down  You turned down ${which} last time (it still gets listed, just not ticked)`
  }
  const times = ` · used ${r.times} time${r.times === 1 ? '' : 's'}`
  if (r.kind === 'file_kind') return `kind        ${r.from} files · you call them “${r.to}”${times}`
  // 又改回模型的說法時 from 與 to 會折成同一個（最後一次贏）—— 講清楚，不然看起來像沒意義的一列
  const back = courseKey(r.from) === courseKey(r.to) ? '  (back to what the model said)' : ''
  return `course      The model says “${r.from}” · you say “${r.to}”${times}${back}`
}

/**
 * `--apply`／`--undo`／`--forget` 後面到**下一個旗標為止**的那幾個編號。
 *
 * 不可以用 `filter(a => !a.startsWith('--'))`：`file --apply a1b2 --course OS` 裡的 `OS`
 * 會被當成第二個編號，然後「清單上沒有編號 OS」—— 使用者完全看不懂發生什麼事。
 */
function codesAfter(list, at) {
  const out = []
  for (let i = at + 1; i < list.length; i++) {
    if (list[i].startsWith('--')) break
    out.push(list[i])
  }
  return out
}

/**
 * `--course OS` 這種「旗標＋一個值」。沒給值（後面沒東西、或後面是另一個旗標）回 `{ error }`。
 * 沒有這個旗標回 `{}`。
 */
function flagValue(list, name) {
  const at = list.indexOf(name)
  if (at < 0) return {}
  const v = list[at + 1]
  if (v === undefined || v.startsWith('--')) {
    return { error: `${name} needs a value, e.g. node cli.mjs file --apply a1b2 ${name} OS` }
  }
  return { value: v }
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
        return bad(`--${m[1]} needs an id from the list, e.g. node cli.mjs cleanup apply --${m[1]} a1b2`)
      }
      out[m[1]].push(...codes)
      continue
    }
    if (a.startsWith('--')) return bad(`Don't know ${shown(a)}. You can use: --skip <id>, --also <id>.`)
    if (out.planId) return bad('Only one plan can be applied at a time.')
    out.planId = a
  }
  if (out.planId && (out.skip.length || out.also.length)) {
    return bad('--skip and --also only work when building a new cleanup (no plan id given).')
  }
  return out
}

/**
 * 這個指令**指名**了哪一份計畫（第三輪 R3-6b）。收尾要跳過它：使用者明講要跑的那一份，
 * 不可以被同一個指令的自動放棄搶先作廢。指名不到就回 null（照舊全部收）。
 * 只有 apply 與 undo 會指名；release 指名的那一份本來就是要作廢的，不用跳過。
 */
function namedPlanId(sub, argv) {
  if (sub === 'apply') {
    const p = parseApplyArgs(argv.slice(1))
    return p.error ? null : p.planId
  }
  if (sub === 'undo') {
    const a = argv[1]
    return a && !a.startsWith('--') ? a : null
  }
  return null
}

/** 清單上那一列長什麼樣。每一列都要有原因 —— 沒有原因就不該出現。 */
function printCandidate(c, code) {
  const box = c.defaultChecked ? '✔' : '☐'
  const where = c.subdir ? `${c.folder}/${c.subdir}` : c.folder
  say(`  [${code}] ${box} ${shown(c.name)}`)
  say(`         ${mb(c.bytes).padStart(8)}  ${shown(c.kind)}  ${shown(where)}`)
  for (const r of c.reasons) say(`         · ${shown(r.reason)} (${shown(r.evidence)})`)
  if (c.vetoed) say(`         ⚠ ${shown(c.vetoed)}`)
}

// ── 逐項結果 ────────────────────────────────────────────────
//
// **照 outcome 的全部種類印**（RC13）。只認 moved／skipped 的話，其他每一種都會掉進
// 「✘ 沒有搬動，原因不明」—— 已經復原、已經清空的檔被說成沒搬成，畫面在說謊。
// 逐項結果跟 HTTP 那邊用**同一份算法**（planOutcomes），這裡只決定長相。

/** 套用（或查看一份計畫）時每一項的樣子 */
function applyLine(i, o) {
  const head = `${shown(i.name)}  ${mb(i.bytes)}`
  switch (o?.outcome) {
    case 'moved': return `  ✔ ${head}`
    case 'skipped': return `  - ${head}  (you skipped it)`
    case 'failed': return `  ✘ ${head}  — ${shown(o.why ?? 'did not move, reason unknown')}`
    case 'restored': return `  ↩ ${head}  (put back${o.restoredAs ? ` as ${shown(o.restoredAs)}` : ''})`
    case 'purged': return `  ⌫ ${head}  (emptied)`
    case 'pending': return `  ○ ${head}  (not done yet)`
    // cancelled：計畫放棄了，或計畫跑過、這一項從來沒碰過（第二輪 R2-1e）。兩種都沒有搬移紀錄 —— 檔本來就在原位
    case 'cancelled': return `  ⊘ ${head}  (not handled: the plan stopped or was dropped; the file never moved)`
    // unknown：journal 停在 started。**不可以說「沒有搬動」** —— rename 可能已經完成了（RC17）
    case 'unknown': return `  ? ${head}  — state unknown: ${shown(o.why ?? 'the move was interrupted; the file may already be in quarantine')}`
    default: return `  ? ${head}  — state unknown`
  }
}

/** 復原時每一項的樣子。**↩ 只給真的放回去的**，數字跟行數才對得上。 */
function undoLine(i, o) {
  const head = shown(i.name)
  switch (o?.outcome) {
    // **不要講「之後不會再被提議」。** 那不一定是真的：之後符合新的理由會再出現；
    // 原位置被佔時放回來的那份會改名成 .restored，重掃後以重複檔的身分被預設勾起來。
    case 'restored': return o.restoredAs
      ? `  ↩ ${head}  → a file of that name was already there, so this one is called ${shown(o.restoredAs)} (nothing was overwritten)`
      : `  ↩ ${head}`
    case 'moved': return `  ✘ ${head}  — not put back, still in quarantine: ${shown(o.why ?? 'reason unknown')}`
    case 'purged': return `  ✘ ${head}  — already emptied, cannot be put back`
    case 'unknown': return `  ? ${head}  — state unknown: ${shown(o.why ?? 'interrupted partway')}`
    // skipped／failed／pending／cancelled：當初就沒有搬走
    default: return `  - ${head}  (never moved in the first place; it is where it always was)`
  }
}

function printPlanItems(plan, line) {
  const o = planOutcomes(db, plan.id)
  for (const i of plan.items) say(line(i, o.get(i.itemId)))
}

/**
 * 這份計畫**開始執行了沒**：cleanup_journal 裡有沒有它的任何一列（第三波 C1）。
 *
 * **跟核心的 releasePlan（cleanup-plans.ts）同一個判斷**：proposed 而且沒有任何 journal
 * 才算「沒開始」，才放棄得了。套用做到一半中斷（Ctrl+C、當機、被砍）的計畫停在 proposed，
 * 但已經有 journal、有檔案在隔離區 —— 上一版只看 status，undo 說「還沒套用，去 release」、
 * release 說「已經開始了，去復原」，兩邊互相推，使用者卡死。
 * 開始了的只有兩條路：undo（把已經搬的放回來）或 apply（把它做完）。連「略過」的紀錄都算開始了。
 */
const planStarted = id => Boolean(db.prepare('SELECT 1 FROM cleanup_journal WHERE plan_id=? LIMIT 1').get(id))

/**
 * 一份開始了的計畫怎麼往下走（CONFLICT、release 被拒的時候講）。
 *
 * 選 undo 之前要知道放回來的檔之後的下場（第三波之二）：放回原位的檔，候選記成 restored，
 * 重掃時 upsertCandidate 碰到同一個檔、同一種理由的 restored 候選不會改回 proposed ——
 * 只有出現新的理由（新的 kind、新的規則版本）才會再被提議。原位置被佔、改名成 .restored
 * 放回的那份是另一條路徑，資料庫裡是新的檔，照規則重新評估，所以要另外講。
 */
/** 這份計畫開始復原了沒？有 restore 紀錄的話，再 apply 一定回 409（核心的 applyPlan 先擋）。 */
function planRestoring(id) {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM cleanup_journal WHERE plan_id=? AND op='restore' LIMIT 1`).get(id))
  } catch { return false }
}

function startedChoices(id) {
  // 已經開始復原的那份：apply 一定 409，只剩一條路，不要叫人去撞（第二輪第二階段驗證員）
  if (planRestoring(id)) {
    say('\nThis plan has started restoring, so it can neither carry on cleaning up nor be dropped (release). One way out:')
    say(`  Carry on putting back what already moved: node cli.mjs cleanup undo ${id}`)
    return
  }
  say('\nThis plan has started moving files, so it cannot be dropped (release). Two choices:')
  say(`  Put back what already moved: node cli.mjs cleanup undo ${id}`)
  say('    Files put back are not suggested again unless a new reason turns up; one renamed on the way back counts as a new file.')
  say(`  Finish it: node cli.mjs cleanup apply ${id}`)
}

/**
 * 撞到 CONFLICT：**找出擋住這次勾選的那一份**（RC7），講得出怎麼往下走。
 *
 * 只有還沒套用的（proposed）計畫會佔住檔案（RC4）。上一版拿「最新一份 proposed／partial／error」，
 * 那一份不一定跟這次有關，而且叫人「不清了：cleanup undo」—— 對一份 partial 的計畫照做，
 * 會把已經清掉的檔放回來（驗證者 v7）。沒開始的那一份給兩條不動檔案的路：
 * 接著清那一份，或放棄那一份（release：計畫作廢、候選不動）。
 *
 * **做到一半中斷的那一份不給 release**（第三波 C1）：核心一定拒絕，叫人去跑只會再被推回來。
 * 給的是 undo（放回已搬的）與 apply（做完）。
 */
function explainConflict(e, candidateIds) {
  warn(shown(e.message))
  let b = null, started = false
  try { b = blockingPlanFor(db, candidateIds); started = Boolean(b) && planStarted(b.id) } catch { /* 找不到就只講原因 */ }
  if (!b || b.status !== 'proposed') {
    say('\nCannot tell which plan is in the way. Run node cli.mjs cleanup scan and try again.')
  } else {
    const when = `created ${ago(b.createdAt) ?? 'at an unknown time'}`
    if (started) {
      let moved = 0
      try { moved = [...planOutcomes(db, b.id).values()].filter(o => o.outcome === 'moved').length } catch { /* 數不出來就不講 */ }
      say(`\nIn the way is a plan interrupted partway, ${b.id} (${when}): of its ${plural(b.items.length, 'file')}, ${moved} are already in quarantine:`)
    } else {
      say(`\nIn the way is a plan that was never applied, ${b.id} (${when}), holding ${plural(b.items.length, 'file')}:`)
    }
    for (const i of b.items.slice(0, 20)) say(`  ${shown(i.name)}  ${mb(i.bytes)}`)
    if (b.items.length > 20) say(`  …and ${b.items.length - 20} more`)
    if (started) startedChoices(b.id)
    else {
      say('\nTwo choices:')
      say(`  Carry on with that plan: node cli.mjs cleanup apply ${b.id}`)
      say(`  Drop that plan (nothing moves; its files stay candidates): node cli.mjs cleanup release ${b.id}`)
    }
  }
  process.exitCode = EXIT.badInput
}

/** 這份計畫在 cleanup_journal 裡有幾列（拿來判斷「這一次真的動到東西了沒」）。 */
function journalRowCount(id) {
  try { return Number(db.prepare('SELECT count(*) n FROM cleanup_journal WHERE plan_id=?').get(id)?.n ?? 0) }
  catch { return 0 }
}

/**
 * 真的套用一份計畫，印逐項結果。remaining／skippedRows 是預設清理才有的補充。
 * `alreadyRun` 是「呼叫之前這份計畫就已經跑過了」（applied／partial／error）—— 見下面的 no-op。
 *
 * 這支要處理三種收場，畫面與離開碼都不一樣：
 *
 * 1. **正常**：照舊，逐項結果＋「搬進隔離區 N 個」＋復原指令。
 * 2. **no-op**（第三輪 R3-2b／R3-15）：跑過的計畫再套用，核心原樣回傳、一個檔都不碰（R2-3）。
 *    以前畫面跟剛搬完一模一樣（「搬進隔離區 1 個」「後悔的話：cleanup undo」），使用者會以為剛剛真的清了；
 *    記帳也把它當成「這一種動作成功了」，一個一直壞著的套用錯就被標成「好了」。
 *    現在照實說「先前已經跑過了，這次什麼都沒做」，並給真正的下一步（重掃、建一份新的）。
 * 3. **做到一半被打斷**（第三輪 R3-3b）：清理鎖被另一個清理動作接走（renew 丟 BUSY，
 *    或核心之後回 `stoppedEarly`）。以前一丟錯就 `fail()` → 回 2、一行逐項結果都沒印、連計畫 id 都沒給 ——
 *    但檔已經在隔離區了，而 2 的意思是「這個動作根本沒執行」（不變量 7），腳本會據此重試。
 *    現在照常印計畫 id 與逐項結果，離開碼照逐項；**這一次真的一列都沒動到**才回 2。
 */
function runApply(id, { remaining = 0, skippedRows = [], alreadyRun = false } = {}) {
  const rowsBefore = journalRowCount(id)
  let r = null, stopped = null
  try { r = applyPlan(db, id, execOpts()) }
  catch (e) {
    // 這一次一列都沒動到 → 動作真的沒執行，照舊 fail（BUSY → 2、其他照 exitFor）
    if (journalRowCount(id) <= rowsBefore) { fail(e, 'apply'); return }
    // 動到東西了：意外照記（BUSY 不算意外，核心的 isSurprise 會過濾），
    // 但畫面與離開碼走下面那一條 —— 回 2 會讓腳本以為什麼都沒發生。
    noteError(e, 'apply')
    stopped = cliProblem(e)
  }
  // 核心之後會改成回傳 stoppedEarly（不丟例外）：兩條路都要接得住
  if (r?.stoppedEarly) stopped = shown(r.stoppedEarly.why ?? 'another cleanup action interrupted it.')
  // `noop` 是核心之後會回的欄位；它還沒到（或沒回）的時候，用「套用前就已經跑過了」判斷 ——
  // 那正是 applyPlan 原樣回傳的條件（cleanup-exec.ts 的 R2-3），兩者是同一件事。
  const noop = !stopped && (r?.noop === true || alreadyRun)

  // 失敗原因**馬上**存起來：下一次掃描會改寫 file_items.error，重掃之後原因就變成「原因不明」（RC11）。
  // 存不進去不可以讓結果消失 —— 檔案已經搬了。
  try { recordItemErrors(db, id) }
  catch (e) { warn(`⚠ Could not store the failure reason (${why(e?.message)}); it may be gone after the next scan.`) }
  // 被打斷的那一次不記：BUSY 本來就不算意外（核心的 isSurprise），而它也還沒做完，不是一次成功。
  if (!stopped) noteResult('apply', noop ? { ...r, noop: true } : r)

  say(`Plan ${id}`)
  const outcomes = planOutcomes(db, id)
  // 被打斷的時候 r 是 null（核心丟了例外）：逐項要照資料庫裡現在的樣子印，不是照回傳值
  let items = r?.items ?? null
  if (!items) { try { items = getPlan(db, id).items } catch { items = [] } }
  for (const i of items) say(applyLine(i, outcomes.get(i.itemId)))
  for (const row of skippedRows) say(`  - ${shown(row.name)}  ${mb(row.bytes)}  (you skipped it; not cleaned this time)`)

  if (noop) {
    say('\nThis plan had already run, so nothing happened this time — no file was moved and nothing was deleted.')
    say('Applying again does not retry what failed — a plan runs once. To clean again: node cli.mjs cleanup scan, '
      + 'then node cli.mjs cleanup apply, which builds a new plan from the current list.')
    const inQ = items.filter(i => outcomes.get(i.itemId)?.outcome === 'moved').length
    if (inQ) say(`The ${plural(inQ, 'file')} moved to quarantine earlier ${inQ === 1 ? 'is' : 'are'} still there. To put ${inQ === 1 ? 'it' : 'them'} back: node cli.mjs cleanup undo ${id}`)
  } else if (stopped) {
    const moved = items.filter(i => outcomes.get(i.itemId)?.outcome === 'moved').length
    warn(`\n⚠ Another cleanup action interrupted this one, so it stopped partway (${stopped}).`)
    say(`${plural(moved, 'file')} already in quarantine. Running node cli.mjs cleanup apply ${id} again picks up where it stopped; `
      + `to put back what already moved: node cli.mjs cleanup undo ${id}`)
  } else {
    say(`\nMoved ${plural(r.quarantinedCount, 'file')} (${mb(r.quarantinedBytes)}) to quarantine.`)
    if (r.quarantinedCount) say(`Changed your mind? node cli.mjs cleanup undo ${r.id}`)
    if (remaining > 0) say(`At most ${PLAN_MAX} files per run, so ${remaining} are left for next time (run node cli.mjs cleanup apply again).`)
  }

  // **離開碼照逐項結果，不看計畫的 status**（第二輪 R2-1）。逐項才是實話：status 是整份計畫的摘要，
  // 對不上逐項的時候（例如 partial 但每一項都搬了），照 status 回 3 就是叫腳本去看一個不存在的問題。
  // 找不到逐項結果的當成狀態不明（倒向要人看一眼）。
  const kinds = items.map(i => outcomes.get(i.itemId)?.outcome)
  const failed = kinds.filter(k => k === 'failed').length
  const unknown = kinds.filter(k => k === 'unknown' || k === undefined).length
  // cancelled／pending：計畫中途停了，這一項從來沒碰過（沒有任何搬移紀錄）
  const untouched = kinds.filter(k => k === 'cancelled' || k === 'pending').length
  if (!failed && !unknown && !untouched) return
  // 這幾行講的是**這份計畫現在的樣子**（哪幾個沒搬成、哪幾個狀態不明、哪幾個沒處理到），
  // no-op 與被打斷的那兩種也照印 —— 上面已經把「為什麼這一次沒動」講清楚了，這裡補「所以現在是什麼狀況」。
  // **「原檔都還在原位」只在失敗的全部是 failed 時才說**（RC17）。
  // unknown 是搬到一半中斷：rename 可能已經做完了，檔案可能在隔離區 —— 說「都還在原位」是在說謊。
  if (failed && !unknown) warn('\n⚠ The ✘ files above did not move. Every original is still where it was — nothing was deleted.')
  else if (failed) warn('\n⚠ The ✘ files above did not move.')
  if (unknown) {
    warn(`${failed ? '' : '\n'}⚠ ${plural(unknown, 'file')} interrupted mid-move and may already be in quarantine. Run node cli.mjs doctor to check.`)
  }
  if (untouched) warn(`${failed || unknown ? '' : '\n'}⚠ ${plural(untouched, 'file')} not handled this time (the plan stopped partway), still where they were.`)
  // 動作執行了，只是檔案沒全部搬成：3。全失敗也不是 2 —— 2 要留給「連跑都跑不起來」。
  process.exitCode = EXIT.partial
}

/** `cleanup apply <id>`：套用（或重送）指定的那一份 */
function applyExisting(id) {
  let plan
  try { plan = getPlan(db, id) }
  catch (e) { fail(e, 'apply'); return }   // 沒有這份 → NOT_FOUND → 1，唯讀模式也一樣（上一版唯讀時回 0）

  // 已經復原過的再套用一次：B 會原樣回傳結果，逐項全是 restored —— 上一版把它們印成一排 ✘、回 0。
  if (plan.status === 'restored') {
    say(`Plan ${plan.id} was already undone — the files are back where they were, so nothing happened this time.`)
    say('To clean again: node cli.mjs cleanup scan, then node cli.mjs cleanup apply.')
    return
  }
  if (plan.status === 'dismissed') {
    // 放棄的可能是人（release），也可能是收尾自動放棄的（建立之後超過一小時沒套用，R2-5）：兩種都講，
    // 不然使用者會以為自己按錯了什麼
    say(`Plan ${plan.id} was dropped (${DISMISSED_WHO}). No file was ever moved, so nothing happened this time.`)
    say('To clean: node cli.mjs cleanup apply, which builds a new plan from the current list.')
    printPlanItems(plan, applyLine)
    return
  }
  if (config.readonly) {
    // smoke 第 0 步就靠這個確認「只說不做」。回非 0 會讓那一步永遠紅。
    const o = planOutcomes(db, plan.id)
    // 已經跑過的計畫（applied／partial／error）再套用是原樣回傳、不重試（第二輪 R2-3）：真的套用一個都不會動，
    // 這裡也不可以說「會清掉 N 個」。只有還是 proposed 的（還沒套用、或做到一半中斷）會接著做
    const todo = plan.status !== 'proposed' ? []
      : plan.items.filter(i => ['pending', 'failed', 'unknown'].includes(o.get(i.itemId)?.outcome ?? 'pending'))
    say(`Read-only mode: this would clean up ${plural(todo.length, 'file')}, but nothing was touched.`)
    if (plan.status === 'partial' || plan.status === 'error') {
      say('This plan was already applied; applying again does not retry what failed. To retry: node cli.mjs cleanup scan, then node cli.mjs cleanup apply.')
    }
    for (const i of plan.items) say(applyLine(i, o.get(i.itemId)))
    return
  }
  // **跑過的計畫再套用是 no-op**（核心的 R2-3：applied／partial／error 原樣回傳，一個檔都不碰）。
  // 唯讀那一條上面已經講了；非唯讀這一條以前一個字都沒講（第三輪 R3-15），畫面跟剛失敗一次一模一樣。
  runApply(plan.id, { alreadyRun: ['applied', 'partial', 'error'].includes(plan.status) })
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
    all = listCandidates(db, { ...SCOPE, limit: Number.MAX_SAFE_INTEGER }).candidates
    ids = defaultCandidateIds(db, SCOPE)
  } catch (e) {
    warn('Could not read the cleanup candidates: ' + cliProblem(e))
    noteError(e, 'apply')
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
    warn('The same id cannot be both --skip and --also.')
    process.exitCode = EXIT.badInput
    return
  }

  const inDefault = new Set(idList)
  const chosen = all.filter(r => r.candidateIds.some(c => inDefault.has(c)))
  const chosenSet = new Set(chosen.map(r => r.itemId))
  for (const r of s.rows) if (!chosenSet.has(r.itemId)) say(`${shown(r.name)} was not in this cleanup anyway.`)
  for (const r of a.rows) if (chosenSet.has(r.itemId)) say(`${shown(r.name)} was already ticked.`)
  const skippedRows = chosen.filter(r => skipSet.has(r.itemId))
  const final = [...chosen.filter(r => !skipSet.has(r.itemId)), ...a.rows.filter(r => !chosenSet.has(r.itemId))]

  // **唯讀模式不可以建 plan。**
  // createPlan 不看 readonly（只有 applyPlan 看），所以先建再被擋的話，
  // 那份 plan 會留在資料庫裡佔住那些檔案，下一次真的 apply 直接撞
  // 「這個檔案已有待處理的清理計畫」—— 而 smoke 第 0 步正是叫使用者
  // 先跑一次唯讀試跑。照著文件做就會壞掉。
  // 數字跟真的跑**同一份算法**（上面的 final），試跑說幾個、真的就清幾個。
  if (config.readonly) {
    say(`Read-only mode: this would clean up ${plural(final.length, 'file')} (${mb(final.reduce((n, r) => n + r.bytes, 0))}).`)
    for (const r of final.slice(0, DRY_LIST)) say(`  ✔ ${shown(r.name)}  ${mb(r.bytes)}`)
    if (final.length > DRY_LIST) say(`  …and ${final.length - DRY_LIST} more`)
    for (const r of skippedRows) say(`  - ${shown(r.name)}  ${mb(r.bytes)}  (you skipped it; not cleaned this time)`)
    if (remaining > 0) say(`At most ${PLAN_MAX} files per run, so ${remaining} are left for next time.`)
    say('\nNothing was touched this time, and no plan was created.')
    return
  }

  if (!final.length) {
    // **沒東西要清是成功。** 回非 0 會讓每晚 smoke 一直紅。
    say(chosen.length ? 'Nothing to clean this time: --skip covered everything that was ticked.' : `Nothing needs cleaning — ${rootsLabel()} is tidy.`)
    return
  }

  const candidateIds = final.flatMap(r => r.candidateIds)
  let plan
  try {
    // 用核心的 createPlanForRoots：只收清單列得出來的（在清理範圍裡、搬得動的、截圖資料夾裡只收截圖），跟清單同一套篩選
    plan = createPlanForRoots(db, SCOPE, { candidateIds })
  } catch (e) {
    if (e instanceof CleanupError && e.code === 'CONFLICT') { explainConflict(e, candidateIds); return }
    if (e instanceof CleanupError && e.code === 'EMPTY_PLAN') {
      say(`Nothing needs cleaning — ${rootsLabel()} is tidy.`)
      return
    }
    fail(e, 'apply')
    return
  }
  runApply(plan.id, { remaining, skippedRows })
}

/**
 * doctor 的「另外 N 個」要分開講（RC11／RC4）：真的讀不到（或搬不動）的，
 * 跟「太大，這個工具不處理」的不是同一件事 —— 上一版把太大的也說成讀不到，使用者會去查權限。
 *
 * **用核心算好的全部計數（needsHumanCounts），不自己數陣列**（第三波 C7）：
 * needsHuman 陣列只回前 50 個，超過的部分上一版只能說「還有 N 個沒有列出來」，分不出是哪一種。
 */
function needsHumanText(nh, fallbackTotal) {
  if (!nh) return fallbackTotal ? `; ${fallbackTotal} more need your eyes` : ''
  if (!nh.needsHumanTotal) return ''
  const { tooLarge, unreadable } = nh.needsHumanCounts
  const parts = []
  if (unreadable) parts.push(`${unreadable} unreadable or unmovable`)
  if (tooLarge) parts.push(`${tooLarge} too large for this tool`)
  return `; ${parts.join(', ')} (run cleanup list to see which)`
}

/** 看得懂的 CONTEXTBOX_PORT 才用（0 ＝ 讓系統挑）。看不懂就當沒設。 */
function portFromEnv() {
  const v = process.env.CONTEXTBOX_PORT
  if (v === undefined || v === '') return null
  if (!/^\d{1,5}$/.test(v) || Number(v) > 65535) {
    warn(`⚠ CONTEXTBOX_PORT is not a port (${shown(v)}); using ${DEFAULT_PORT} instead.`)
    return null
  }
  return Number(v)
}

function rescanFromEnv() {
  const n = Number(process.env.CONTEXTBOX_RESCAN_MS)
  return Number.isInteger(n) && n >= 100 ? n : null
}

function scanTimeoutFromEnv() {
  const n = Number(process.env.CONTEXTBOX_SCAN_TIMEOUT_MS)
  return Number.isInteger(n) && n >= 100 ? n : null
}

/** pet 多久讓模型看一輪（測試調小）。 */
function thinkFromEnv() {
  const n = Number(process.env.CONTEXTBOX_THINK_MS)
  return Number.isInteger(n) && n >= 100 ? n : null
}

/** 「今天」的起點（這台機器的日曆日）。model_calls 的 at 是 ISO，字串比得動。 */
function startOfToday() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

/**
 * doctor 的「看懂內容」那一段（P2）。模型有沒有設定、今天送了幾次、平均幾秒、幾次失敗、
 * 幾個檔因為像機密沒送。**一個字都不印檔案內容。**
 */
function modelDoctorLines() {
  const off = whyDisabled(config)
  let st
  try { st = modelStats(db, startOfToday()) }
  catch { st = null }
  if (off) {
    const lines = [`Reading     ✗ ${off}.`]
    // demo 沙盒沒有模型，但 --seed-model 已經把示範答案塞進快取了 ——
    // 不講的話，doctor 說「沒開」而面板上卻寫著「模型認為⋯⋯」，看起來像壞掉
    if (st?.seeded) lines.push(`            (the cache holds ${plural(st.seeded, 'demo answer')}; the panel marks them “[demo answer]”.)`)
    return lines
  }
  if (!st) return ['Reading     ✓ on (today\'s log could not be read)']
  const secs = st.avgMs == null ? null : (st.avgMs / 1000).toFixed(1)
  const out = [
    `Reading     ✓ on (prompt version ${PROMPT_VERSION})`,
    `            ${plural(st.calls, 'request')} sent today`
      + (st.ok ? `, ${st.ok} answered${secs === null ? '' : ` (${secs}s on average)`}` : '')
      + (st.failed ? `, ${st.failed} failed` : ', none failed'),
  ]
  out.push(`            ${plural(st.secretSkips, 'file')} held back for looking like secrets`
    + (st.skips > st.secretSkips ? `, and ${st.skips - st.secretSkips} more for being too short or unanswerable` : ''))
  out.push(`            The cache holds ${plural(st.views, 'reading')}`
    + (st.seeded ? ` (${st.seeded} of them demo answers)` : '')
    + '. These are the model\'s opinions; nothing is renamed or moved automatically.')
  return out
}

/** open 要連哪個 port：明講的（環境變數）→ pet 記下來的 → 7391 */
function petPort() {
  const env = portFromEnv()
  if (env) return env
  let recorded = NaN
  try { recorded = Number(getMeta(META.petPort)) } catch { /* 讀不到就用預設 */ }
  return Number.isInteger(recorded) && recorded > 0 && recorded <= 65535 ? recorded : DEFAULT_PORT
}

/**
 * 免 token 的 /health 是不是 ContextBox 的形狀（healthSnapshot 的欄位，docs/api/health.json）。
 * 只是健全性檢查，擋的是「那個埠剛好被別的開發伺服器佔著、它的 /health 也回 200」。
 */
const looksLikeHealth = j => Boolean(j) && typeof j === 'object'
  && typeof j.ok === 'boolean' && typeof j.db?.ok === 'boolean'
  && typeof j.watcher === 'object' && j.watcher !== null
  && typeof j.quarantine === 'object' && j.quarantine !== null
  && Number.isFinite(j.pendingCandidates)

/**
 * 那個 port 上的是不是我們的 pet。回 'up'｜'down'（沒人回應）｜'stranger'（回應的不是 ContextBox）｜
 * 'unproven'（形狀像 ContextBox，但證明不了手上有我們的鑰匙）。
 *
 * **只有 'up' 才把帶鑰匙的網址交出去**（第三波 C3）。問 /health 的時候**不帶 token**：還不知道對方是誰，
 * 帶了就等於交出去。形狀可以模仿，所以要對方**證明**（第二輪 R2-9）：帶一個每次都不同的 nonce 問
 * `/health?nonce=`，真的 pet 回 proof ＝ HMAC-SHA256(token, `${它實際監聽的埠}:${nonce}`)，這裡用**要連的那個埠**
 * 自己算一次來比。算得出來的只有手上有鑰匙的那一個。
 *
 * 上一版的證明是「META 裡記的 pid 還活著」：冒牌只要形狀對、剛好有一個活著的 pid（`watch` 也寫同一個 pid，
 * pid 也會被重用）就拿到鑰匙（稽核 C-e5）；反過來，直接跑 `node core/server.ts` 沒有寫 pid，真的 server 永遠被拒絕（C-e9）。
 * **埠號一起算**：不然冒牌可以把 nonce 轉給另一個埠上的真 pet，再把 proof 原封不動交回來（轉送攻擊）。
 * pet 撞 port（EADDRINUSE）的時候也用它：一樣只有 'up' 才印網址。
 */
async function petUp(port, token, healthProof) {
  const nonce = randomBytes(16).toString('hex')
  let res, body
  try {
    res = await fetch(`http://127.0.0.1:${port}/health?nonce=${nonce}`, { signal: AbortSignal.timeout(1500), redirect: 'manual' })
  } catch { return 'down' }
  try { body = await res.json() } catch { return 'stranger' }
  if (res.status !== 200 || !looksLikeHealth(body)) return 'stranger'
  const want = Buffer.from(healthProof(token, port, nonce))
  const got = Buffer.from(typeof body.proof === 'string' ? body.proof : '')
  return got.length === want.length && timingSafeEqual(got, want) ? 'up' : 'unproven'
}

/** petUp 不是 'up' 的時候，「為什麼不把鑰匙交出去」那一句（open 與 pet 撞 port 共用） */
function notPetText(port, up) {
  if (up === 'stranger') return `Whatever answers on 127.0.0.1:${port} is not the ContextBox pet, so the key is not handed to it.`
  if (up === 'unproven') {
    return `Something on 127.0.0.1:${port} looks like ContextBox but cannot prove it holds your key — it may be fake, another account's, or an old pet, `
      + 'so the key is not handed to it.'
  }
  return `127.0.0.1:${port} is taken but does not answer, so there is no telling whether it is the ContextBox pet. The key is not handed to it.`
}

/**
 * 這個資料夾在不在 OneDrive 的同步資料夾裡（第二輪 R2-11）。在的話，搬進隔離區等於在雲端與所有裝置上刪掉；
 * 只存在雲端的檔，掃描算指紋時還會被整個下載回來。doctor 看到就要講。
 *
 * 不分作業系統：路徑裡有一層叫 OneDrive（`OneDrive`、`OneDrive - 公司名`、macOS 的 `OneDrive-Personal`），
 * 或在 Windows 設的 OneDrive／OneDriveConsumer／OneDriveCommercial 環境變數那個資料夾底下。只是提醒，寧可多講。
 */
function inOneDrive(p) {
  const path = String(p ?? '')
  if (path.split(/[\\/]+/).some(seg => /^onedrive(?:$|[\s\-–—])/i.test(seg))) return true
  const norm = x => x.replace(/[\\/]+$/, '').toLowerCase()
  for (const k of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const base = process.env[k] ? norm(process.env[k]) : ''
    const here = norm(path)
    if (base && (here === base || here.startsWith(base + '\\') || here.startsWith(base + '/'))) return true
  }
  return false
}

/** 錯誤種類的說法（doctor 用） */
const KIND_LABEL = { scan: 'a scan', apply: 'a cleanup', undo: 'an undo', empty: 'emptying quarantine', model: 'a model request' }

/** `think` 的逐項那一行。**只印檔名與模型講的字，不印內容、不印路徑。** */
function thinkLine(p) {
  const head = `[${p.index}/${p.total}] ${shown(p.name)}`
  const what = p.source === 'image' ? 'screenshot' : 'document'
  if (p.outcome === 'asked' || p.outcome === 'cached') {
    const who = p.outcome === 'cached' ? ' (same contents were asked before; reusing that answer)' : ''
    return `  ✔ ${head}  — The model thinks: ${shown(p.course || 'Unknown')} / ${shown(p.topic || 'Unknown')}`
      + ` (confidence ${shown(p.confidence || 'low')})${who}`
  }
  if (p.outcome === 'skipped') return `  - ${head}  — ${shown(p.why ?? 'not sent')}`
  return `  ✘ ${head} (${what})  — ${shown(p.why ?? 'no answer')}`
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
    // 先收尾（R2-1a）：中斷的搬移不結掉的話，下面的隔離區會少算、中斷的計畫也列不出來。
    // 唯讀模式它自己會整個跳過（R3-9）—— 純診斷不可以改資料庫，下面那一行會講清楚。
    settleCleanupState()
    say('ContextBox check')
    say('')
    say(`Config      ${shown(cfgPath)}${created ? ' (there was none, so one was just created)' : ''}`)
    say(`Database    ${shown(DEFAULT_DB)}`)
    say(`Read-only   ${config.readonly ? 'on (cleanup only talks; it moves and deletes nothing)' : 'off'}`)
    // 唯讀模式連收尾都不做（R3-9）：中斷的搬移不會結掉、放太久的計畫不會自動放棄。
    // 不講的話，doctor 底下那些數字（隔離區、中斷計畫）看起來像是「已經收過尾」的樣子。
    if (config.readonly) {
      say('            Read-only mode does not tidy up: interrupted moves stay open and stale plans are not dropped.')
      say('            To let it tidy up, turn CONTEXTBOX_READONLY off and run again.')
    }
    say('')
    say('Watched folders (screenshots and intake)')
    for (const r of config.watch) say(`  ${existsSync(r) ? '✓' : '✗ missing'}  ${shown(r)}`)
    say('Cleanup scope (only files in here are ever cleaned)')
    for (const r of CLEAN_ROOTS) {
      say(`  ${existsSync(r) ? '✓' : '✗ missing'}  ${shown(r)}`)
      // R2-11：OneDrive 同步資料夾裡的檔，搬進隔離區就是雲端刪除。工具不替你挑，但一定要講
      if (inOneDrive(r)) {
        say('     ⚠ This folder is inside OneDrive: moving a file to quarantine deletes it in the cloud and on every device, '
          + 'and cloud-only files get downloaded in full during a scan. Point cleanup.roots at a folder that is not synced.')
      }
    }
    // R2-8：截圖資料夾在清理範圍裡，但那底下只清截圖（macOS 的截圖資料夾就是桌面）
    if (SHOTS) say(`  (“${shown(basename(SHOTS) || SHOTS)}” is the screenshots folder: only screenshots are cleaned there)`)
    say(`Files to    ${shown(config.filed)}${existsSync(config.filed) ? '' : ' (created when you accept the first suggestion)'}`)
    say('')

    // 監看到底有沒有在跑？設定正確不代表有人在看。
    const beat = getMeta(META.heartbeat)
    const beatPid = Number(getMeta(META.pid))
    const beatAgo = ago(beat)
    // 心跳只證明「它上次寫的時候還活著」。被 kill -9 掉的話，
    // 心跳會停在那裡，而 doctor 會繼續說「還活著」說滿五分鐘 ——
    // 這個心跳本來就是為了「靜默失敗是最大的敵人」加的，不能自己說謊。
    if (!beat) say('Watcher     ✗ never ran. To keep an eye on things, open a terminal and run `node cli.mjs watch`.')
    else if (!Number.isInteger(beatPid) || !alive(beatPid)) {
      say(`Watcher     ✗ that process (pid ${beatPid || '?'}) is gone; its last heartbeat was ${beatAgo}.`)
    } else if ((Date.now() - Date.parse(beat)) > 5 * 60_000) {
      say(`Watcher     ✗ the process is alive but its last heartbeat was ${beatAgo}, so it looks stuck.`)
    } else say(`Watcher     ✓ alive as of ${beatAgo} (pid ${beatPid})`)

    // doctor 是本機的人自己在看，給完整版（lastError 的內容只有帶 token 的才看得到）
    const h = healthSnapshot(db, { ...SCOPE, quarantine: QUARANTINE, full: true })
    say(`Quarantine  ${shown(QUARANTINE)}`)
    say(`            ${plural(h.quarantine.items, 'file')}, ${mb(h.quarantine.bytes)}`
      + (h.quarantine.items
        // canEmptyNow 的意思是「按下去**會有東西**被刪掉」，不是「整區都能清」。
        // 講成「現在可以清空」的話，使用者按完發現還有東西，會以為壞了。
        ? (h.quarantine.canEmptyNow ? ', some of them old enough to empty' : ', the oldest is not yet seven days old')
        : '')
      + (h.quarantine.orphans ? `\n            ${plural(h.quarantine.orphans, 'file')} of unknown origin ${h.quarantine.orphans === 1 ? 'is' : 'are'} also here; emptying leaves them alone` : '')
      + (h.quarantine.truncated ? '\n            ⚠ quarantine was not read to the end, so the numbers may be off' : ''))
    let nh = null
    try { nh = listCandidates(db, { ...SCOPE, limit: 0 }) } catch { /* 用 health 的總數 */ }
    say(`Candidates  ${h.pendingCandidates}` + needsHumanText(nh, h.needsHumanCount))

    // 做到一半中斷的計畫（第二輪 R2-5）：proposed 而且已經有 journal。它佔著它的檔（預設清理會撞 CONFLICT），
    // 已經搬的在隔離區 —— 只有兩條路，不能放棄。以前沒有任何指令會把它的 id 印出來。
    let cut = []
    try {
      cut = db.prepare(`SELECT id, created_at FROM cleanup_plans p WHERE status='proposed'
        AND EXISTS (SELECT 1 FROM cleanup_journal j WHERE j.plan_id=p.id) ORDER BY created_at DESC, rowid DESC`).all()
    } catch { /* 還沒有清理的表：沒有中斷的計畫 */ }
    if (cut.length) {
      say(`Interrupted ${plural(cut.length, 'plan')} stopped partway (killed mid-apply, a crash, or Ctrl+C):`)
      for (const p of cut.slice(0, 5)) {
        let total = 0, moved = 0, unknown = 0
        try {
          const o = [...planOutcomes(db, p.id).values()].map(x => x.outcome)
          total = o.length
          moved = o.filter(k => k === 'moved').length
          unknown = o.filter(k => k === 'unknown').length
        } catch { /* 數不出來就講 0 */ }
        const where = moved || unknown
          ? `${moved} already in quarantine` + (unknown ? `, ${unknown} in an unknown state` : '')
          : 'not one file has moved yet'
        say(`            ${p.id} (created ${ago(p.created_at) ?? 'at an unknown time'}): ${plural(total, 'file')}, ${where}`)
        if (planRestoring(p.id)) {
          say(`              It has started restoring; the only way on is to carry on: node cli.mjs cleanup undo ${p.id}`)
        } else {
          if (moved || unknown) say(`              Put back what already moved: node cli.mjs cleanup undo ${p.id}`)
          say(`              Finish it: node cli.mjs cleanup apply ${p.id}`)
          if (!moved && !unknown) say(`              Or drop it (nothing moves): node cli.mjs cleanup undo ${p.id}`)
        }
      }
      if (cut.length > 5) say(`            …and ${cut.length - 5} more`)
    }

    // 最近一次完整掃描回報的問題（第二輪 R2-10）：保險絲、打不開的資料夾。以前只印在背景行程的 stderr，沒有人看得到
    // 超過 50 條的話，核心存的最後一條是「還有 N 條沒有列出來。」：總數要把它算回去，不可以說成 50 個
    const probs = Array.isArray(h.scanProblems) ? h.scanProblems : []
    const over = /^(\d+) more are not listed\.$/.exec(probs.at(-1) ?? '')
    const listed = over ? probs.slice(0, -1) : probs
    const totalProbs = listed.length + (over ? Number(over[1]) : 0)
    if (totalProbs) {
      say(`Scan issues The last scan reported ${totalProbs} problems:`)
      for (const x of listed.slice(0, 10)) say(`          ⚠ ${shown(x)}`)
      if (totalProbs > 10) say(`            …and ${totalProbs - Math.min(10, listed.length)} more`)
    }

    // 最近一次意外（RC5）：人話＋時間。寵物還擔不擔心它，**跟寵物用同一個判斷**（errorStillActive，R2-10）：
    // 有種類的錯只有同一種動作之後成功過才算好了 —— 掃描成功不會蓋掉一直壞著的套用。
    const errAt = h.lastErrorAt ?? null
    const errWhy = h.lastError
      ? (errAt && h.lastError.startsWith(errAt + ' ') ? h.lastError.slice(errAt.length + 1) : h.lastError)
      : null
    if (!errWhy) say('Last error  none')
    else {
      say(`Last error  ${errAt ? `${ago(errAt)} (${localTime(errAt)})` : 'time unknown'}: ${shown(errWhy)}`)
      const label = KIND_LABEL[h.lastErrorKind] ?? null
      if (!errorStillActive(h)) {
        const okAt = label ? h.lastOkByKind?.[h.lastErrorKind] : h.lastOkAt
        say(`            ${label ?? 'Something'} has succeeded since (${ago(okAt) ?? 'time unknown'}), so the pet has stopped worrying.`)
      } else {
        say('            The pet is still worried: '
          + (label ? `this came from ${label}, and there has been no successful one since.` : 'no cleanup action has succeeded since.'))
      }
    }
    say('')

    const last = items.lastSeen()
    say(`Last intake ${last ? `${ago(last)} (${last})` : 'nothing taken in yet'}`)
    say('')

    if (!modelReady(config)) {
      say('Model       ✗ not configured. Fill in model.baseUrl and model.name in the config file.')
    } else {
      say(`Model       ${shown(config.model.name)} @ ${shown(config.model.baseUrl)}`)
      const key = modelKey(config)
      say(`Key         ${key ? '✓ read from ' + config.model.keyEnv : '✗ the environment variable ' + config.model.keyEnv + ' is empty'}`)
      // 真的打一次。設定檔填對不代表連得到——靜默失敗是這種工具最大的敵人。
      say(`Connection  ${await probeModel(config, key)}`)
    }
    // P2：看懂內容。**沒設定就只講一句「沒開」**，不報錯、不留空白
    for (const line of modelDoctorLines()) say(line)
    say('')
    const c = items.counts()
    const total = Object.values(c).reduce((a, b) => a + b, 0)
    say(`Inbox       ${plural(total, 'item')}` + (total ? ': ' + Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ') : ''))
    showProblems()
    break
  }

  case 'propose': {
    showProblems()
    if (!args.length) { warn('Give a file path, e.g. node cli.mjs propose ~/Downloads/a.pdf'); process.exit(1) }
    const r = { new: 0, known: 0, rejected: 0 }
    for (const a of args) r[intake(a)]++
    // 「已經收過了」是成功。右鍵選單靠離開碼判斷成敗，
    // 回非零會在 Windows／Nautilus 上跳一個錯誤視窗給使用者看。
    if (r.new + r.known === 0) { process.exitCode = 1; break }
    say(`\nTook in ${plural(r.new, 'new file')}`
      + (r.known ? `, ${r.known} were already known` : '')
      + (r.rejected ? `, ${r.rejected} were turned away` : '') + '.')
    if (!modelReady(config)) {
      say('(No model is configured, so these were only recorded, not read. Once one is set up, run `node cli.mjs doctor` to check.)')
    }
    break
  }

  /**
   * 手動讓模型看一輪（P2）。pet 在背景做的就是這件事，這一條是給人自己跑的。
   *
   * **沒設定模型就什麼都不做**：講一句怎麼設定，離開碼 0（那不是錯，是還沒接）。
   * 連續失敗三次停掉的話離開碼是 2（後端錯）—— 腳本據此決定要不要重試。
   */
  case 'think': {
    showProblems()
    if (!modelEnabled(config)) {
      say(`Reading is not on: ${whyDisabled(config)}.`)
      say(`Fill in model.baseUrl and model.name in ${shown(cfgPath)}, put the key in ${shown(config.model.keyEnv)}, and run again.`)
      say('(Everything else works without a model: scanning, cleanup and the panel are unaffected.)')
      break
    }
    let limit = ROUND_MAX_ITEMS
    const li = args.indexOf('--limit')
    if (li >= 0) {
      const n = Number(args[li + 1])
      if (!Number.isInteger(n) || n < 1 || n > 500) {
        warn('--limit must be a whole number between 1 and 500.')
        process.exitCode = EXIT.badInput
        break
      }
      limit = n
    }
    say(`Asking the model: ${shown(config.model.name)} @ ${shown(config.model.baseUrl)}`)
    say(`One file at a time, 60 seconds each. Ctrl+C stops it wherever it is, with no half-written records.`)
    const ac = new AbortController()
    const stopThinking = () => { if (!ac.signal.aborted) ac.abort() }
    process.on('SIGINT', stopThinking)
    process.on('SIGTERM', stopThinking)
    const r = await thinkRound({
      db, config, roots: CLEAN_ROOTS, limit, signal: ac.signal,
      onError: w => noteError(new Error(w), 'model'),
      onProgress: p => say(thinkLine(p)),
    })
    process.off('SIGINT', stopThinking)
    process.off('SIGTERM', stopThinking)
    say('')
    if (!r.total) {
      say('Nothing to ask about — every document and screenshot with text has been read, or nothing has been scanned yet.')
      break
    }
    say(`This round: ${r.total} queued, ${r.asked} asked`
      + `, ${r.cached} served from cache, ${r.skipped} not sent, ${r.failed} failed.`)
    if (r.cancelled) say('(You stopped it; the rest wait for the next round.)')
    say('What the model says is an **opinion**, not a fact: nothing is renamed or moved because it said so. The panel marks every one “The model thinks”.')
    if (r.asked) noteOk('model')
    if (r.stopped) {
      warn('⚠ ' + shown(r.stopped))
      process.exitCode = EXIT.backend
    }
    break
  }

  /**
   * 替沒取名的檔改名（P3）。**沒有自動改名的路徑**：`rename` 只列，`--apply` 才動。
   *
   *   node cli.mjs rename                      列出建議
   *   node cli.mjs rename --apply [編號⋯]       改名（不給編號 ＝ 清單上全部，退過貨的除外）
   *   node cli.mjs rename --apply <編號> --to X 自己指名新名字（跟建議不一樣就會被記住，P5）
   *   node cli.mjs rename --undo [紀錄 id⋯]     復原（不給 id ＝ 最近那一次）
   *
   * 離開碼照 docs/cli.md：0 成功（含「沒有東西要改」）、1 輸入錯、2 後端錯、3 部分失敗。
   */
  case 'rename': {
    showProblems()
    const scope = { roots: CLEAN_ROOTS, quarantine: QUARANTINE, readonly: config.readonly }
    // 每一次都先收尾上一次被砍在中間的改名（看檔案實際在哪決定那一列是 done 還是 reverted）
    try { recoverInterruptedRenames(db) }
    catch (e) { warn(`⚠ Could not finish tidying up the interrupted rename (${why(e?.message ?? e)}). Skipping it this time.`) }

    const undoAt = args.indexOf('--undo')
    const applyAt = args.indexOf('--apply')
    if (undoAt >= 0 && applyAt >= 0) {
      warn('--apply and --undo cannot be used together.')
      process.exitCode = EXIT.badInput
      break
    }
    const unknown = args.find(a => a.startsWith('--') && a !== '--apply' && a !== '--undo' && a !== '--to')
    if (unknown) {
      warn(`Don't know ${shown(unknown)}. You can use: --apply <id>, --undo <record id>, --to <new name>.`)
      process.exitCode = EXIT.badInput
      break
    }
    const to = flagValue(args, '--to')
    if (to.error) { warn(to.error); process.exitCode = EXIT.badInput; break }
    if (to.value !== undefined && applyAt < 0) {
      warn('--to only means something with --apply — it is the name for one particular file.')
      process.exitCode = EXIT.badInput
      break
    }

    // ── 復原 ─────────────────────────────────────────────────
    if (undoAt >= 0) {
      const ids = codesAfter(args, undoAt)
      // **跟下面列出來的那一批同一個數字**：印編號的集合與解析編號的集合不一樣大的話，
      // 印出來明明分得開的編號，解析時會說「對到不只一筆」。
      const done = listRenames(db, RENAME_LIST).filter(r => r.status === 'done')
      let picked
      if (ids.length) {
        const short = shortIds(done.map(r => r.id))
        picked = []
        for (const raw of ids) {
          const code = raw.replace(/^\[|\]$/g, '').toLowerCase()
          const hits = done.filter(r => r.id.toLowerCase().startsWith(code))
          if (code.length < 4) { warn(`--undo ${shown(raw)}: a record id needs at least 4 characters — the ones in [ ] on the rename list.`); picked = null; break }
          if (!hits.length) { warn(`There is no record ${shown(raw)} to undo. Run node cli.mjs rename to see the records.`); picked = null; break }
          if (hits.length > 1) {
            warn(`The id ${shown(raw)} matches more than one record. Type a few more characters:\n`
              + hits.slice(0, 10).map(r => `  [${short.get(r.id)}] ${shown(r.to)}`).join('\n'))
            picked = null
            break
          }
          if (!picked.includes(hits[0].id)) picked.push(hits[0].id)
        }
        if (!picked) { process.exitCode = EXIT.badInput; break }
      }
      let r
      try { r = undoRenames(db, picked ? { ids: picked } : { last: true }, scope) }
      catch (e) { fail(e, 'undo'); break }
      for (const o of r.results) {
        if (o.ok && o.restoredAs) say(`  ↩ ${shown(o.to)}  (another file had taken the original name, so this is what it is called; nothing was overwritten)`)
        else if (o.ok) say(`  ↩ ${shown(o.to)}`)
        else say(`  ✘ Not changed back  — ${shown(o.why)}`)
      }
      const bad = r.results.filter(o => !o.ok).length
      say(`\nChanged ${r.results.length - bad} back${bad ? `, ${bad} not changed back` : ''}.`)
      if (bad) process.exitCode = EXIT.partial
      break
    }

    // ── 列建議 ───────────────────────────────────────────────
    let list
    try { list = renameSuggestions(db, scope) }
    catch (e) { fail(e, 'rename'); break }
    const rows = list.items
    const short = shortIds(rows.map(r => r.itemId))

    if (applyAt < 0) {
      if (!rows.length) {
        say(`Nothing in ${rootsLabel()} can be renamed.`)
        say('(Only unnamed files the model can make sense of get suggested. For files it has not read yet, run node cli.mjs think first.)')
      } else {
        say(`${plural(rows.length, 'file')} can be renamed (**these are the model's opinions, not facts**):\n`)
        for (const r of rows) {
          say(`  [${short.get(r.itemId)}] ${shown(r.name)}`)
          say(`         → ${shown(r.suggested)}${r.learned ? '  (course spelled the way you changed it last time)' : ''}`)
          say(`         The model thinks: ${shown(r.course || 'Unknown')} / ${shown(r.topic || 'Unknown')}`
            + ` (confidence ${shown(r.confidence)})${r.seeded ? ' [demo answer]' : ''}`)
          if (r.evidence) say(`         Evidence: ${shown(r.evidence)}`)
          if (r.rejectedBefore) say('         ⟲ You turned this suggestion down last time — it is skipped unless you name its id.')
        }
        say(`\nTo rename: node cli.mjs rename --apply${rows.length > 1 ? ' [id…]' : ''}`)
        say('Changed your mind afterwards: node cli.mjs rename --undo')
      }
      const recent = listRenames(db, RENAME_LIST).filter(r => r.status === 'done')
      if (recent.length) {
        say('\nRecently renamed (all still undoable):')
        const rs = shortIds(recent.map(r => r.id))
        for (const r of recent) say(`  [${rs.get(r.id)}] ${shown(r.from)} → ${shown(r.to)}`)
      }
      break
    }

    // ── 真的改 ───────────────────────────────────────────────
    const codes = codesAfter(args, applyAt)
    let chosen = rows
    if (codes.length) {
      const picked = resolveCodes(rows, codes, '--apply')
      if (picked.error) { warn(picked.error); process.exitCode = EXIT.badInput; break }
      chosen = picked.rows
    } else {
      // **退過貨的不預設做**（P5 預期行為 5）：不給編號是「清單上那些」，
      // 而使用者上次已經把這幾個放回去了。要做還是做得到 —— 指名它的編號就好。
      const back = rows.filter(r => r.rejectedBefore)
      chosen = rows.filter(r => !r.rejectedBefore)
      if (back.length) {
        say(`(${back.length} ${back.length === 1 ? 'suggestion you turned down last time is' : 'suggestions you turned down last time are'} left out. `
          + `To do them, name their ids: ${back.map(r => '[' + short.get(r.itemId) + ']').join(' ')})`)
      }
    }
    if (!chosen.length) {
      say(`Nothing in ${rootsLabel()} can be renamed, so nothing happened.`)
      break
    }
    if (to.value !== undefined && chosen.length > 1) {
      warn(`--to names one file at a time (${chosen.length} are selected right now). Use --apply <id> to pick one.`)
      process.exitCode = EXIT.badInput
      break
    }
    if (config.readonly) {
      warn('Read-only mode is on, so no file gets renamed.')
      process.exitCode = EXIT.badInput
      break
    }
    let r
    try {
      r = applyRenames(db,
        chosen.map(c => ({ itemId: c.itemId, to: to.value ?? c.suggested })), scope)
    }
    catch (e) { fail(e, 'rename'); break }
    for (const o of r.results) {
      if (o.ok) say(`  ✔ ${shown(o.from)} → ${shown(o.to)}`)
      else say(`  ✘ ${shown(o.from || 'this file')}  — ${shown(o.why)}`)
    }
    const ok = r.results.filter(o => o.ok).length
    const bad = r.results.length - ok
    say(`\nRenamed ${ok}${bad ? `, ${bad} not renamed` : ''}.`)
    if (r.remaining) say(`At most ${RENAME_BATCH_MAX} per run, so ${r.remaining} are still to go. Run it again and they get done too.`)
    if (ok) say('Changed your mind? node cli.mjs rename --undo')
    if (bad) process.exitCode = EXIT.partial
    break
  }

  /**
   * 把同一堂課的檔歸成結構化資料夾（P4）。**沒有自動歸檔的路徑**：`file` 只列，`--apply` 才搬。
   *
   *   node cli.mjs file                        列出建議
   *   node cli.mjs file --apply [編號⋯]         搬進「整理好的」資料夾（不給編號 ＝ 清單上全部，
   *                                            退過貨的除外）
   *   node cli.mjs file --apply <編號> --course OS [--kind 講義]
   *                                            自己指名課名／類型（跟建議不一樣就會被記住，P5）
   *   node cli.mjs file --undo [紀錄 id⋯]       復原（不給 id ＝ 最近那一次）
   *
   * 離開碼照 docs/cli.md：0 成功（含「沒有東西要整理」）、1 輸入錯、2 後端錯、3 部分失敗。
   */
  case 'file': {
    showProblems()
    const scope = {
      roots: CLEAN_ROOTS, filed: config.filed, quarantine: QUARANTINE,
      readonly: config.readonly, restoreRoots: restoreRootList(),
    }
    // 每一次都先收尾上一次被砍在中間的整理（看檔案實際在哪決定那一列是 done 還是 reverted）
    try { recoverInterruptedFilings(db) }
    catch (e) { warn(`⚠ Could not finish tidying up the interrupted filing (${why(e?.message ?? e)}). Skipping it this time.`) }

    const undoAt = args.indexOf('--undo')
    const applyAt = args.indexOf('--apply')
    if (undoAt >= 0 && applyAt >= 0) {
      warn('--apply and --undo cannot be used together.')
      process.exitCode = EXIT.badInput
      break
    }
    const known = ['--apply', '--undo', '--course', '--kind']
    const unknown = args.find(a => a.startsWith('--') && !known.includes(a))
    if (unknown) {
      warn(`Don't know ${shown(unknown)}. You can use: --apply <id>, --undo <record id>, --course <course>, --kind <kind>.`)
      process.exitCode = EXIT.badInput
      break
    }
    const course = flagValue(args, '--course')
    const kind = flagValue(args, '--kind')
    const badFlag = course.error ?? kind.error
    if (badFlag) { warn(badFlag); process.exitCode = EXIT.badInput; break }
    if ((course.value !== undefined || kind.value !== undefined) && applyAt < 0) {
      warn('--course and --kind only mean something with --apply — they say where the files should go.')
      process.exitCode = EXIT.badInput
      break
    }

    // ── 復原 ─────────────────────────────────────────────────
    if (undoAt >= 0) {
      const ids = codesAfter(args, undoAt)
      // **跟下面列出來的那一批同一個數字**（跟改名同一個理由：印編號與解析編號要用同一個集合）
      const done = listFilings(db, FILING_LIST).filter(r => r.status === 'done')
      let picked
      if (ids.length) {
        const short = shortIds(done.map(r => r.id))
        picked = []
        for (const raw of ids) {
          const code = raw.replace(/^\[|\]$/g, '').toLowerCase()
          const hits = done.filter(r => r.id.toLowerCase().startsWith(code))
          if (code.length < 4) { warn(`--undo ${shown(raw)}: a record id needs at least 4 characters — the ones in [ ] on the file list.`); picked = null; break }
          if (!hits.length) { warn(`There is no record ${shown(raw)} to undo. Run node cli.mjs file to see the records.`); picked = null; break }
          if (hits.length > 1) {
            warn(`The id ${shown(raw)} matches more than one record. Type a few more characters:\n`
              + hits.slice(0, 10).map(r => `  [${short.get(r.id)}] ${shown(r.to)}`).join('\n'))
            picked = null
            break
          }
          if (!picked.includes(hits[0].id)) picked.push(hits[0].id)
        }
        if (!picked) { process.exitCode = EXIT.badInput; break }
      }
      let r
      try { r = undoFilings(db, picked ? { ids: picked } : { last: true }, scope) }
      catch (e) { fail(e, 'undo'); break }
      for (const o of r.results) {
        if (o.ok && o.restoredAs) say(`  ↩ ${shown(o.name)}  (a file of that name was already in the original place, so this is what it is called; nothing was overwritten)`)
        else if (o.ok) say(`  ↩ ${shown(o.name)}`)
        else say(`  ✘ Not moved back  — ${shown(o.why)}`)
      }
      const bad = r.results.filter(o => !o.ok).length
      say(`\nMoved ${r.results.length - bad} back${bad ? `, ${bad} not moved back` : ''}.`)
      if (bad) process.exitCode = EXIT.partial
      break
    }

    // ── 列建議 ───────────────────────────────────────────────
    let list
    try { list = filingSuggestions(db, scope) }
    catch (e) { fail(e, 'file'); break }
    const rows = list.items
    const short = shortIds(rows.map(r => r.itemId))

    if (applyAt < 0) {
      if (!rows.length) {
        say(`Nothing in ${rootsLabel()} can be filed.`)
        say('(Only files the model can place in a course get suggested. For files it has not read yet, run node cli.mjs think first.)')
      } else {
        say(`${plural(rows.length, 'file')} can be filed (**these are the model's opinions, not facts**):\n`)
        for (const r of rows) {
          say(`  [${short.get(r.itemId)}] ${shown(r.name)}`)
          say(`         → ${shown(r.toFolder)}/${r.learned ? '  (the way you changed it last time)' : ''}`)
          // **模型說的那一句一定用模型自己的課名**：套了偏好之後 course 是使用者的寫法，
          // 印它就變成「把使用者自己的話說成模型講的」
          say(`         The model thinks: ${shown(r.modelCourse || r.course)} / ${shown(r.topic || 'Unknown')}`
            + ` (confidence ${shown(r.confidence)})${r.seeded ? ' [demo answer]' : ''}`)
          if (r.evidence) say(`         Evidence: ${shown(r.evidence)}`)
          // 舊資料夾**沒有被搬走也沒有改名**，只是之後的檔不再進去（P5 預期行為 12）
          if (r.alsoKnownAs) {
            say(`         You used to call it “${shown(r.alsoKnownAs)}”; that folder is still there, untouched.`)
          }
          if (r.rejectedBefore) say('         ⟲ You turned this suggestion down last time — it is skipped unless you name its id.')
        }
        say(`\nTo file them: node cli.mjs file --apply${rows.length > 1 ? ' [id…]' : ''}`)
        say(`Filed things land in ${shown(config.filed)} and are never suggested for cleanup again.`)
        say('Changed your mind afterwards: node cli.mjs file --undo')
      }
      const recent = listFilings(db, FILING_LIST).filter(r => r.status === 'done')
      if (recent.length) {
        say('\nRecently filed (all still undoable):')
        const rs = shortIds(recent.map(r => r.id))
        for (const r of recent) say(`  [${rs.get(r.id)}] ${shown(r.to)} → ${shown(r.toFolder)}/`)
      }
      break
    }

    // ── 真的搬 ───────────────────────────────────────────────
    const codes = codesAfter(args, applyAt)
    let chosen = rows
    if (codes.length) {
      const picked = resolveCodes(rows, codes, '--apply')
      if (picked.error) { warn(picked.error); process.exitCode = EXIT.badInput; break }
      chosen = picked.rows
    } else {
      // **退過貨的不預設做**（P5 預期行為 5）：不給編號是「清單上那些」，
      // 而使用者上次已經把這幾個搬回去了。要做還是做得到 —— 指名它的編號就好。
      const back = rows.filter(r => r.rejectedBefore)
      chosen = rows.filter(r => !r.rejectedBefore)
      if (back.length) {
        say(`(${back.length} ${back.length === 1 ? 'suggestion you turned down last time is' : 'suggestions you turned down last time are'} left out. `
          + `To do them, name their ids: ${back.map(r => '[' + short.get(r.itemId) + ']').join(' ')})`)
      }
    }
    if (!chosen.length) {
      say(`Nothing in ${rootsLabel()} can be filed, so nothing happened.`)
      break
    }
    if (config.readonly) {
      warn('Read-only mode is on, so no file gets moved.')
      process.exitCode = EXIT.badInput
      break
    }
    let r
    try {
      r = applyFilings(db, chosen.map(c => ({
        itemId: c.itemId,
        course: course.value ?? c.course,
        kind: kind.value ?? c.kind,
      })), scope)
    }
    catch (e) { fail(e, 'file'); break }
    for (const o of r.results) {
      if (o.ok) say(`  ✔ ${shown(o.name)} → ${shown(o.toFolder)}/${o.to === o.name ? '' : shown(o.to)}`)
      else say(`  ✘ ${shown(o.name || 'this file')}  — ${shown(o.why)}`)
    }
    const ok = r.results.filter(o => o.ok).length
    const bad = r.results.length - ok
    say(`\nFiled ${ok}${bad ? `, ${bad} not filed` : ''}.`)
    if (r.remaining) say(`At most ${FILING_BATCH_MAX} per run, so ${r.remaining} are still to go. Run it again and they get done too.`)
    if (ok) say('Changed your mind? node cli.mjs file --undo')
    if (bad) process.exitCode = EXIT.partial
    break
  }

  /**
   * 它學到的事（P5）。**看得到、忘得掉**（預想的不變量 3）。
   *
   *   node cli.mjs learned                  列出每一條
   *   node cli.mjs learned --forget <編號⋯>  忘掉指名的那幾條
   *   node cli.mjs learned --forget-all      全部忘掉
   *
   * 這個指令**不動任何檔案**，所以唯讀模式照樣列得出來；但 `--forget` 是寫，唯讀模式不做。
   * 離開碼：列出來（含「什麼都沒學過」）是 0，編號打錯、旗標看不懂、唯讀模式要忘是 1。
   */
  case 'learned': {
    const forgetAt = args.indexOf('--forget')
    const all = args.includes('--forget-all')
    if (forgetAt >= 0 && all) {
      warn('--forget and --forget-all cannot be used together.')
      process.exitCode = EXIT.badInput
      break
    }
    const unknown = args.find(a => a.startsWith('--') && a !== '--forget' && a !== '--forget-all')
    if (unknown) {
      warn(`Don't know ${shown(unknown)}. You can use: --forget <id>, --forget-all.`)
      process.exitCode = EXIT.badInput
      break
    }
    let learned
    try { learned = listLearned(db) }
    catch (e) { fail(e, 'learned'); break }
    const rows = learned.items
    const short = shortIds(rows.map(r => r.id))

    // ── 忘掉 ─────────────────────────────────────────────────
    if (forgetAt >= 0 || all) {
      if (config.readonly) {
        warn('Read-only mode is on, so nothing changes — not even forgetting what it learned.')
        process.exitCode = EXIT.badInput
        break
      }
      if (all) {
        const n = forgetAllLearned(db)
        say(n ? `Forgot all ${n} of them. Future suggestions go back to what the model says.` : 'There was nothing learned to begin with.')
        break
      }
      const codes = codesAfter(args, forgetAt)
      if (!codes.length) {
        warn('--forget needs an id — the characters in [ ] on the learned list. To clear everything, use --forget-all.')
        process.exitCode = EXIT.badInput
        break
      }
      const picked = []
      let bad = false
      for (const raw of codes) {
        const code = raw.replace(/^\[|\]$/g, '').toLowerCase()
        if (code.length < 4) { warn(`--forget ${shown(raw)}: an id needs at least 4 characters — the ones in [ ] on the learned list.`); bad = true; break }
        const hits = rows.filter(r => r.id.toLowerCase().startsWith(code))
        if (!hits.length) { warn(`There is no entry ${shown(raw)}. Run node cli.mjs learned to see the list.`); bad = true; break }
        if (hits.length > 1) {
          warn(`The id ${shown(raw)} matches more than one entry. Type a few more characters:\n`
            + hits.slice(0, 10).map(r => `  [${short.get(r.id)}] ${shown(learnedLine(r))}`).join('\n'))
          bad = true
          break
        }
        if (!picked.includes(hits[0].id)) picked.push(hits[0].id)
      }
      if (bad) { process.exitCode = EXIT.badInput; break }
      const n = forgetLearned(db, picked)
      say(`Forgot ${n} of them. They no longer shape any suggestion.`)
      break
    }

    // ── 列清單 ───────────────────────────────────────────────
    if (!rows.length) {
      say('It has not learned anything yet.')
      say('(It only remembers when you change a rename or filing suggestion into something else. Accepting one as-is teaches it nothing.)')
      break
    }
    say(`It learned ${plural(rows.length, 'thing')}, all from changes you made (**it never moves a file on its own**):\n`)
    for (const r of rows) {
      say(`  [${short.get(r.id)}] ${shown(learnedLine(r))}`)
    }
    if (learned.evicted.count) {
      say(`\n(Too much to remember, so the ${learned.evicted.count} oldest and least-used got dropped`
        + `${learned.evicted.at ? `, most recently ${shown(learned.evicted.at)}` : ''}.)`)
    }
    say('\nForget one: node cli.mjs learned --forget [id]')
    say('Forget everything: node cli.mjs learned --forget-all')
    break
  }

  case 'watch': {
    showProblems()
    if (!config.watch.length) { warn('The config lists no watched folders.'); process.exit(1) }

    const beat = () => { try { setMeta(META.heartbeat, new Date().toISOString()); setMeta(META.pid, process.pid) } catch { /* 資料庫忙就下次再寫 */ } }

    const w = createWatcher({
      roots: config.watch,
      maxBytes: config.maxBytes,
      exclude: [config.filed],
      onSeed: count => {
        say(`Startup scan: noted ${plural(count, 'existing file')} and treated them all as already seen.`)
        say('Only files that land later, or whose contents change, reach the inbox. For older files, name them with propose.')
      },
      onFile: v => {
        // 這裡丟例外不會讓檔案消失 —— watcher 會重試，重試太多次才放棄
        const { fresh } = items.add(v)
        say(`+ ${new Date().toLocaleTimeString('en-GB', { hour12: false })}  ${shown(basename(v.real))} (${v.kind})`
          + (fresh ? '' : ' (contents unchanged)'))
      },
      onProblem: m => warn('⚠ ' + shown(m)),
    })

    beat()
    w.start()
    const heartbeat = setInterval(beat, 30_000)
    say(`Watching:\n  ${config.watch.map(shown).join('\n  ')}`)
    say('Ctrl+C to stop.')
    if (!modelReady(config)) say('⚠ No model is configured, so incoming files are only recorded, never read.')

    const bye = () => { clearInterval(heartbeat); w.stop(); say('\nStopped.'); process.exit(0) }
    process.on('SIGINT', bye)
    process.on('SIGTERM', bye)
    setInterval(() => {}, 1 << 30)          // 讓行程活著
    break
  }

  case 'pet': {
    showProblems()
    const { start, uiUrl, healthProof } = await import('./core/server.ts')
    const { createCleanupWatcher } = await import('./core/cleanup-watcher.ts')
    const want = portFromEnv() ?? DEFAULT_PORT
    // **roots、quarantine、maxBytes、readonly 全部傳進去。** 少給一個 server 就會自己再讀一次設定檔，
    // 而 pet 印出來的隔離區跟它剛啟動的那個 server 服務的就可能不是同一個。
    // 清理範圍是 cleanup.roots（RC15），不是截圖的 watch —— macOS 上 watch 含桌面。
    // **放回範圍與截圖資料夾也要傳**（第二輪 R2-4／R2-8）：參數全給了 server 就不讀設定檔，沒傳的話
    // 面板的復原只看清理範圍（舊版從桌面搬走的檔放不回去），截圖資料夾也照全部規則列候選。
    const srv = start({
      port: want, roots: CLEAN_ROOTS, quarantine: QUARANTINE,
      maxBytes: config.maxBytes, readonly: config.readonly,
      restoreRoots: restoreRootList(), screenshotsDir: SHOTS,
      // 歸檔（P4）搬進去的那棵樹。不傳的話 server 會用它自己的預設，
      // 與 pet 印出來的「歸檔到……」就可能不是同一個資料夾。
      filed: config.filed,
    })
    let port
    try { port = await srv.ready }
    catch (e) {
      if (e?.code === 'EADDRINUSE') {
        // **先問那個埠上是不是真的 pet，是才印網址**（第三波之二，跟 open 同一個判斷：要它證明手上有鑰匙，R2-9）。
        // 上一版不問就印帶鑰匙的網址、回 0：佔著那個埠的是陌生程式的話，使用者一點下去，鑰匙就交給它了。
        const up = await petUp(want, srv.token, healthProof)
        if (up === 'up') {
          // 網址**帶鑰匙**（RC16）：不帶 k 的網址打開是 401
          const url = uiUrl(want, srv.token)
          say(`A ContextBox is already running. Just open ${url}.`)
          // **順便打開**（R2-9，稽核 C-e7）：Windows 的捷徑開的是最小化視窗，這裡印完就結束，
          // pet 開著時再點一次捷徑等於沒反應 —— 那正是使用者想打開面板的時候
          if (!(await openInBrowser(url))) warn('Could not open a browser. Copy the address above and paste it in yourself.')
          break
        }
        warn(notPetText(want, up) + ' See what is holding that port, or set CONTEXTBOX_PORT to move the pet to another one.')
        process.exitCode = EXIT.backend
        break
      }
      warn('Could not start: ' + why(e?.message ?? e))
      process.exitCode = EXIT.backend
      break
    }

    // 心跳要有人寫，不然 /health 的 watcher 永遠說「從來沒跑過」，
    // 而寵物的 watching 狀態永遠進不去。
    const beat = () => { try { setMeta(META.heartbeat, new Date().toISOString()); setMeta(META.pid, process.pid) } catch { /* 忙就下次 */ } }
    beat()
    const heartbeat = setInterval(beat, 30_000)
    try { setMeta(META.petPort, port) } catch { /* open 找不到就用預設的 port */ }

    // **印出來的網址一律帶鑰匙**（RC16）。只印 http://127.0.0.1:<port> 的話，使用者點下去是 401。
    say(`ContextBox is listening on 127.0.0.1 port ${port}.`)
    say(`Pet and cleanup panel: ${uiUrl(port, srv.token)}`)
    say('  (the key is already in the address, so it just opens; to open it again later: node cli.mjs open)')
    say('')
    say(`Cleanup scope: ${rootsLabel()}`)
    if (SHOTS) say(`  (“${shown(basename(SHOTS) || SHOTS)}” is the screenshots folder: only screenshots are cleaned there)`)
    say(`Quarantine: ${shown(QUARANTINE)}`)

    // **一啟動就全部掃一次，之後定期重掃**（RC2）。watcher 只看得到有事件的檔：
    // pet 沒開的時候刪掉、下載的檔，不全量掃描的話會一直（不）留在清單與徽章上。
    //
    // **全量掃描開子行程跑**（第三波 C2）。掃描是同步的，一千個檔要將近二十秒（逐列提交）：
    // 在 server 這條執行緒上跑的話，那段時間 /health 一個都不回，`open` 誤報 pet 沒在跑。
    // 子行程就是 `cleanup scan --json`：同一支 cli.mjs、同一份環境變數（HOME、CONTEXTBOX_*），
    // 它自己記掃描種類的 lastOk／lastError（寵物只拿同一種動作的成功蓋掉那一種的錯，RC5／R2-10）、
    // 自己把 problem 印到 stderr（它的 stderr 直接接在 pet 的 stderr 上），也存進資料庫給 doctor 與帶 token 的 /health（R2-10）。
    // 同時間最多一個；pet 結束時殺掉；子行程沒交代結果就死掉（被砍、當掉）由 pet 記 lastError。
    // **有逾時**（第二輪 R2-10）：超過 CONTEXTBOX_SCAN_TIMEOUT_MS（預設 10 分鐘）就殺掉、記一筆掃描的錯，下一輪照常。
    // 以前子行程卡在斷線的網路碟上就永遠不結束，scanning 一直有值 —— 再也不重掃，也沒有人知道。
    // **每一輪之前先收尾**（R2-1a／R2-5，開機那一輪也是）：pet 自己做，不靠子行程 —— 子行程卡住的時候也收得到尾。
    // watcher 觸發的單檔增量處理還是在這裡做（一次一個檔，很快）。
    const rescanMs = rescanFromEnv() ?? RESCAN_MS
    const scanTimeoutMs = scanTimeoutFromEnv() ?? SCAN_TIMEOUT_MS
    let scanning = null
    let stopping = false
    const fullScan = (first = false) => {
      if (scanning || stopping) return
      settleCleanupState()
      let child
      try {
        // detached（POSIX）：自己一個行程群組。不然終端機的 Ctrl+C 會同時送到子行程，
        // 它先死的話 pet 會把「使用者按了 Ctrl+C」記成「背景掃描意外結束」。收掉它是 bye 的事。
        child = spawn(process.execPath, [CLI_FILE, 'cleanup', 'scan', '--json'], {
          env: { ...process.env }, stdio: ['ignore', 'pipe', 'inherit'],
          detached: process.platform !== 'win32', windowsHide: true,
        })
      } catch (e) { child = null; scanEnded(first, '', null, null, e); return }
      scanning = child
      let out = ''
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', d => { if (out.length < 65536) out += d })
      let settled = false
      const settle = (code, signal, err, timedOut = false) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (scanning === child) scanning = null
        scanEnded(first, out, code, signal, err, timedOut)
      }
      // 卡住了：SIGKILL（卡在系統呼叫裡的行程 SIGTERM 不一定收得到），**不等它的 close** ——
      // 卡在 D state 的行程要等系統呼叫回來才會真的死，等 close 的話 scanning 還是一直有值
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* 已經結束了 */ }
        settle(null, null, null, true)
      }, scanTimeoutMs)
      // 開不起來會先 error（可能再 close），跑完是 close（stdout 讀完了才算）
      child.once('error', e => settle(null, null, e))
      child.once('close', (code, signal) => settle(code, signal, null))
    }
    /** 一次全量掃描結束了。子行程最後一行是 JSON 結果；沒有的話就是沒交代就死掉了（或逾時被殺）。 */
    function scanEnded(first, out, code, signal, err, timedOut) {
      if (stopping) return
      if (timedOut) {
        noteError(new Error(SCAN_TIMEOUT_WHY), 'scan')
        warn(`⚠ The background scan ran longer than ${every(scanTimeoutMs)} without finishing (a folder may be stuck), so it was stopped. It will try again in ${every(rescanMs)}.`
          + ' A scan never moves or deletes anything.')
        return
      }
      let r = null
      try { r = JSON.parse(out.trim().split('\n').pop() || 'null') } catch { /* 沒交代結果 */ }
      if (r?.ok === true) {
        if (first) say(`Startup scan: looked at ${plural(r.scanned, 'file')}; ${r.files} can be cleaned up.`)
        return
      }
      if (r?.ok === false) {
        // 原因子行程印過了，記不記 lastError 也是它照 isSurprise 決定的（BUSY 不算意外）
        warn(`⚠ This full rescan did not finish. It will try again in ${every(rescanMs)}.`)
        return
      }
      const how = err ? why(err?.message ?? err) : signal ? `ended by ${signal}` : `exit code ${code}`
      noteError(new Error(`The full-rescan background process ended unexpectedly (${how})`), 'scan')
      warn(`⚠ The full-rescan background process ended unexpectedly (${how}). A scan never moves or deletes anything; it will try again in ${every(rescanMs)}.`)
    }
    fullScan(true)
    say(`The startup scan runs in the background and says so when it finishes; after that it rescans everything every ${every(rescanMs)}.`)
    const rescan = setInterval(fullScan, rescanMs)

    const w = createCleanupWatcher({
      db, roots: CLEAN_ROOTS, maxBytes: config.maxBytes,
      onProblem: m => warn('⚠ ' + shown(m)),
    })
    w.start()

    // ── P2：背景讓模型看一輪 ─────────────────────────────────
    //
    // **不可以卡住掃描或面板**（預想的不變量 5）：一次一輪、一輪一個檔，全部是 async，
    // server 照常回應。沒設定模型就整段不存在（一個計時器都不開）。
    // 同時間只有一輪：上一輪還沒跑完就跳過這一次 —— 模型只有一張卡，排隊沒有意義。
    const thinkMs = thinkFromEnv() ?? THINK_MS
    const thinkAbort = new AbortController()
    let thinking = false
    let thinkTimer = null
    const thinkOnce = async () => {
      if (thinking || stopping || !modelEnabled(config)) return
      thinking = true
      try {
        const r = await thinkRound({
          db, config, roots: CLEAN_ROOTS, signal: thinkAbort.signal,
          onError: msg => noteError(new Error(msg), 'model'),
        })
        if (r.asked) {
          noteOk('model')
          say(`The model read ${plural(r.asked, 'file')} (${r.cached} more reused earlier answers). Open the panel to see “The model thinks…”.`)
        }
        if (r.stopped) warn('⚠ ' + shown(r.stopped))
      } catch (e) {
        // thinkRound 自己不丟例外，這裡只是保險：一輪壞掉不可以讓 pet 死掉
        noteError(e, 'model')
      } finally { thinking = false }
    }
    if (modelEnabled(config)) {
      say(`Reading: ${shown(config.model.name)} — every ${every(thinkMs)} it works through the unread files in the background, one at a time.`)
      say('  (What the model says is an opinion and the panel labels it as such; nothing is renamed or moved because of it.)')
      // 開機先讓掃描與面板站穩再問（模型一個檔要 7～10 秒）
      setTimeout(() => { void thinkOnce() }, Math.min(3000, thinkMs)).unref()
      thinkTimer = setInterval(() => { void thinkOnce() }, thinkMs)
    } else {
      const off = whyDisabled(config)
      if (off) say(`Reading: off (${off}). Everything else works as usual.`)
    }

    say('Ctrl+C to stop.')
    const bye = () => {
      stopping = true
      thinkAbort.abort()
      if (thinkTimer) clearInterval(thinkTimer)
      clearInterval(heartbeat); clearInterval(rescan); w.stop()
      // 掃描子行程一起收掉，不然 pet 結束了它還在寫資料庫
      if (scanning) { try { scanning.kill() } catch { /* 已經結束了 */ } }
      // pet_port 清掉（C3）：留著的話 open 會去問一個已經不是 pet 的東西。只清自己寫的那個值
      try { db.prepare('DELETE FROM meta WHERE k=? AND v=?').run(META.petPort, String(port)) } catch { /* 忙就算了：open 還會要對方證明 */ }
      say('\nStopped.')
      process.exit(0)
    }
    process.on('SIGINT', bye)
    process.on('SIGTERM', bye)
    // 關掉終端機視窗也是結束（Windows 關主控台視窗也是這個）：一樣要收掉子行程、清掉 pet_port
    process.on('SIGHUP', bye)
    break
  }

  case 'open': {
    // 印出帶鑰匙的網址，並試著用系統的方式打開瀏覽器（RC16）。
    // GET / 沒帶 k 是 401，那一頁就是叫人來跑這個指令。
    const { loadToken, uiUrl, healthProof } = await import('./core/server.ts')
    let token
    try { token = loadToken() }
    catch (e) { warn('Could not read the key: ' + why(e?.message ?? e)); process.exitCode = EXIT.backend; break }
    const port = petPort()
    const url = uiUrl(port, token)
    // 要它證明手上有鑰匙（R2-9），不看形狀、不看 pid：直接跑 `node core/server.ts` 的也認得（稽核 C-e9）
    const up = await petUp(port, token, healthProof)
    if (up === 'down') {
      // **沒在跑就不印帶鑰匙的網址**（R2-9）。上一版照印：之後佔住那個埠的不管是誰，
      // 使用者把這一行貼進瀏覽器，鑰匙就交給它了 —— 跟「不是 pet 就連網址都不印」同一個原則。pet 起來會自己印
      warn(`The pet does not look like it is running (nothing answers on 127.0.0.1:${port}). Run node cli.mjs pet first; it prints the address with the key in it.`)
      process.exitCode = EXIT.backend
      break
    }
    if (up !== 'up') {
      // 有東西在回應、但不是（或證明不了是）我們的 pet：**連網址都不印**，免得被人複製去貼給它
      warn(notPetText(port, up) + (up === 'stranger'
        ? ' See what is holding that port, or set CONTEXTBOX_PORT to move the pet to another one.'
        : ' If that is an old pet of yours, close it and run node cli.mjs pet again; otherwise see what is holding that port.'))
      process.exitCode = EXIT.backend
      break
    }
    say(url)
    if (!(await openInBrowser(url))) warn('Could not open a browser. Copy the address above and paste it in yourself.')
    break
  }

  case 'cleanup': {
    const sub = args[0]
    // --json 是 pet 的背景重掃（C2），每 30 分鐘一次；設定的警告 pet 開機時講過了，不要每次重講
    const json = sub === 'scan' && args.includes('--json')
    if (!json) showProblems()
    // 會讀或動清理狀態的子指令，先收尾（R2-1a／R2-5）：中斷的搬移結掉、放太久沒開始的計畫放棄。
    // 不給 id 的 undo 要找得到單檔被砍的那份，quarantine 要列得出它，list 不能被一份早就沒人要的計畫佔著。
    // **使用者指名的那一份不可以被這一次的收尾作廢**（第三輪 R3-6b）：`cleanup apply <放了兩小時的 id>`
    // 以前會先自動放棄它，再印「已經放棄了，這次什麼都沒做」、回 0。
    if (['scan', 'list', undefined, 'apply', 'undo', 'release', 'quarantine'].includes(sub)) {
      settleCleanupState({ skipPlanId: namedPlanId(sub, args) })
    }

    if (sub === 'scan') {
      let r
      const found = []
      try {
        // 讀不到的資料夾、保險絲（整個資料夾看起來不見了）都經由 onProblem 講出來 ——
        // 不接的話，那些話只存在於 API 層，使用者永遠看不到。
        r = scanDownloads({
          db, roots: CLEAN_ROOTS, maxBytes: config.maxBytes,
          onProblem: m => { found.push(m); warn('⚠ ' + shown(m)) },
        })
      } catch (e) {
        noteError(e, 'scan')
        warn(`The scan hit an error (${why(e?.message ?? e)}), so it may not have finished. A scan never moves or deletes anything.`)
        if (json) say(JSON.stringify({ ok: false }))
        process.exitCode = EXIT.backend
        break
      }
      noteOk('scan')
      // 回報的問題也存起來（R2-10）：pet 的背景重掃（--json）只印到 stderr 的話，最小化的視窗沒有人在看。
      // 存的是去掉完整路徑的那份（跟 POST /cleanup/scan 同一支整理），空陣列＝這次沒問題、清掉上一次的
      try { recordScanProblems(db, scanProblems(found, CLEAN_ROOTS)) } catch { /* 存不進去就算了：stderr 照樣印了 */ }
      // scanner 回的 candidates 是**規則列數**，但 list 講的是**檔案數** ——
      // 這整支檔案存在的理由就是消掉這個差別，不可以在自己的 CLI 又端出來。
      const files = listCandidates(db, { ...SCOPE, limit: 0 }).totalAvailable
      if (json) {
        // 給 pet 讀的：stdout 只有這一行。problem 與「太多了」照樣印到 stderr
        say(JSON.stringify({ ok: true, scanned: r.scanned, files, skipped: r.skipped, errors: r.errors, truncated: r.truncated }))
        if (r.truncated) warn('⚠ Too many files, so only the first ones were scanned. Narrow the cleanup scope.')
        break
      }
      say(`Looked at ${plural(r.scanned, 'file')}; ${files} can be cleaned up.`)
      if (r.skipped) say(`${r.skipped} are still changing and were skipped this time.`)
      // 讀不到的檔案**不算掃描失敗** —— 掃描的工作是更新資料庫，那件事成功了。
      // 它們已經記成 status=error，在 list 裡看得到。回非 0 會讓每晚 smoke 一直紅。
      if (r.errors) say(`${r.errors} could not be read; run cleanup list to see which.`)
      if (r.truncated) warn('⚠ Too many files, so only the first ones were scanned. Narrow the cleanup scope.')
      break
    }

    if (sub === 'list' || sub === undefined) {
      let r
      try { r = listCandidates(db, { ...SCOPE, limit: Number.MAX_SAFE_INTEGER }) }
      catch (e) {
        // 後端錯是 2 不是 1，而且不要噴一坨 Node 堆疊
        warn('Could not read the cleanup candidates: ' + cliProblem(e))
        process.exitCode = EXIT.backend
        break
      }
      const nhTotal = r.needsHumanTotal ?? r.needsHuman.length
      if (!r.totalAvailable && !nhTotal) {
        // 沒東西要清是**成功**，不是失敗
        const scanned = db.prepare(`SELECT count(*) n FROM file_items`).get().n
        say(scanned
          ? `Nothing needs cleaning — ${rootsLabel()} is tidy.`
          : 'Nothing has been scanned yet. Run `node cli.mjs cleanup scan` first.')
        break
      }
      if (r.totalAvailable) {
        // 編號看**全部**的候選算，不是只看列出來的那 500 個 —— --skip／--also 對的是全部
        const code = shortIds(r.candidates.map(c => c.itemId))
        const rows = r.candidates.slice(0, LIST_LIMIT)
        say(`${plural(r.totalAvailable, 'thing')} can be cleaned up, roughly ${mb(r.bytes)}`
          + (rows.length < r.totalAvailable ? ` (only the first ${rows.length} are listed)` : '') + '\n')
        for (const c of rows) { printCandidate(c, code.get(c.itemId)); say('') }
        // 頁尾的數字要算**全部**打勾的，不受顯示上限影響（RC12）。自己數 rows 的話只有前 500 個。
        const n = r.defaultCheckedCount ?? r.candidates.filter(c => c.defaultChecked).length
        const bytes = r.defaultCheckedBytes ?? r.candidates.filter(c => c.defaultChecked).reduce((s, c) => s + c.bytes, 0)
        say(`☐ means it stays put unless you say otherwise. `
          + `cleanup apply clears the ${plural(n, 'ticked file')}, ${mb(bytes)}`
          + (n > PLAN_MAX ? ` (at most ${PLAN_MAX} per run; the rest wait for next time)` : '') + '.')
        say('  Skip a few of them: node cli.mjs cleanup apply --skip <id>')
        say('  Also clear some ☐ ones: node cli.mjs cleanup apply --also <id>')
      }
      if (r.needsHuman.length) {
        say(`\n${nhTotal} more ${nhTotal === 1 ? 'needs' : 'need'} your eyes:`
          + (r.needsHumanTruncated ? ` (only the first ${r.needsHuman.length} are listed)` : ''))
        for (const h of r.needsHuman) say(`  ${shown(h.name)}  ${mb(h.bytes)}  — ${shown(h.why)}`)
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
        catch (e) { fail(e, 'undo'); break }
        if (!last) {
          warn('There is no cleanup to undo: nothing this tool moved to quarantine is still waiting there.')
          process.exitCode = EXIT.badInput
          break
        }
        id = last.id
        say(`Undoing the most recent cleanup: plan ${id} (${ago(last.appliedAt ?? last.createdAt) ?? 'time unknown'})`)
      }
      let plan
      try { plan = getPlan(db, id) }
      catch (e) { fail(e, 'undo'); break }
      // **還沒開始**的計畫沒有東西可以復原。交給 B 的話它會把計畫標成「已復原」，那是在說謊。
      // 「沒開始」跟 releasePlan 同一個判斷（planStarted，C1）：做到一半中斷的計畫也停在 proposed，
      // 但已經有檔在隔離區 —— 那種要交給 undoPlan 放回去，不可以叫人去 release（核心一定拒絕）。
      if (plan.status === 'proposed') {
        let started
        try { started = planStarted(plan.id) }
        catch (e) { fail(e, 'undo'); break }
        if (!started) {
          warn(`Plan ${plan.id} was never applied, so there is nothing to undo. To drop it: node cli.mjs cleanup release ${plan.id}`)
          process.exitCode = EXIT.badInput
          break
        }
        say(`Plan ${plan.id} was interrupted partway; putting back what already moved.`)
      }
      if (plan.status === 'dismissed') { say(`Plan ${plan.id} was dropped (${DISMISSED_WHO}). No file was ever moved, so there is nothing to undo.`); break }
      if (plan.status === 'restored') {
        say(`Plan ${plan.id} has already been undone.`)
        printPlanItems(plan, undoLine)
        break
      }
      if (config.readonly) {
        const o = planOutcomes(db, plan.id)
        const back = plan.items.filter(i => o.get(i.itemId)?.outcome === 'moved')
        say(`Read-only mode: this would put back ${plural(back.length, 'file')}, but nothing was touched.`)
        for (const i of back) say(`  ↩ ${shown(i.name)}`)
        break
      }
      let r
      // 放回原位的範圍比清理範圍寬一點：舊版從監看資料夾（桌面）搬走的也放得回去（C4）
      try { r = undoPlan(db, id, undoOpts()) }
      catch (e) { fail(e, 'undo'); break }
      noteResult('undo', r)
      // **逐項照 outcome 印**：↩ 只給真的放回去的，沒放回的講原因（還在隔離區、已清空、狀態不明）。
      // 列全部都打 ↩ 的話會出現「放回 2 個」後面接三行 ↩ —— 跟 apply 一律印 ✔ 是同一類的畫面說謊。
      // 不講資料夾名：放回的可能是舊版搬走的桌面檔，不一定在清理範圍裡（面板也是講「放回原位」）。
      const outcomes = planOutcomes(db, id)
      say(`Put ${plural(r.restoredCount, 'file')} back.`)
      for (const i of r.items) say(undoLine(i, outcomes.get(i.itemId)))
      // **離開碼照逐項結果，不看計畫的 status**（第二輪 R2-1，稽核 A-exp2）：3 只給真的有檔沒放回
      // （還在隔離區、已經清空、狀態不明）。上一版 status 是 partial 就回 3，畫面卻印「有 0 個沒放回」。
      const left = r.items.map(i => outcomes.get(i.itemId)?.outcome).filter(k => ['moved', 'purged', 'unknown'].includes(k))
      if (left.length) {
        warn(`\n⚠ ${left.length} were not put back; the reasons are above.`
          + (left.includes('unknown') ? ' For the ones in an unknown state, run node cli.mjs doctor to check.' : ''))
        process.exitCode = EXIT.partial
      } else if (r.status === 'partial' || r.status === 'error') {
        // 核心說有一步沒做好，但逐項看沒有任何搬走的檔留在隔離區（例如隔離區裡那個位置的內容對不上、沒有動它）：
        // 照印核心的原因，不吞掉；離開碼照逐項（0）
        warn(`\n⚠ ${shown(safeWhy(r.error) ?? 'One step of the undo did not go through; reason unknown.')}`)
      }
      break
    }

    if (sub === 'release') {
      // 放棄一份**還沒開始**的計畫：計畫作廢、檔案不動、候選還在（撞到 CONFLICT 時的第二條路）
      const id = args[1]
      if (!id) {
        warn('Give a plan id, e.g. node cli.mjs cleanup release <plan-id>')
        process.exitCode = EXIT.badInput
        break
      }
      let r
      try { r = releasePlan(db, id) }
      catch (e) {
        // 沒有這份 → 1；已經開始執行 → CONFLICT → 1。開始了的要講得出往哪走（C1），不是只說「不行」
        if (!(e instanceof CleanupError && e.code === 'CONFLICT')) { fail(e); break }
        warn(shown(e.message))
        let status = null
        try { status = getPlan(db, id).status } catch { /* 講不出來就只講原因 */ }
        if (status === 'proposed') startedChoices(id)
        else if (['applied', 'partial', 'error'].includes(status)) say(`To put back what moved: node cli.mjs cleanup undo ${id}`)
        process.exitCode = EXIT.badInput
        break
      }
      say(`Dropped plan ${r.id}. Nothing moved. Its ${plural(r.items.length, 'file')} are still candidates and count again on the next cleanup apply.`)
      break
    }

    if (sub === 'quarantine') {
      const wantsEmpty = args.includes('--empty')
      const yesAt = args.indexOf('--yes')
      if (yesAt >= 0 && !wantsEmpty) { warn('--yes only works together with --empty.'); process.exitCode = EXIT.badInput; break }

      // ── 第二步：帶著預覽給的確認碼真的刪 ──
      // **這是整個專案唯一會刪檔的路徑。** 確認的就是預覽的那一個：不再產生新的預覽（RC13）。
      // 上一版每次都先預覽一次，所以 `--yes` 後面沒給或給錯確認碼，畫面上還是會印出一個新的，回 2。
      if (wantsEmpty && yesAt >= 0) {
        const token = args[yesAt + 1]
        if (!token || token.startsWith('--')) {
          warn('--yes needs the confirmation code the preview printed. Run: node cli.mjs cleanup quarantine --empty')
          process.exitCode = EXIT.badInput
          break
        }
        if (config.readonly) {
          // **唯讀也要驗確認碼**（C6）：確認碼錯是輸入錯（1），跟真的清空一樣。只讀，不消耗、不刪
          let bad
          try { bad = emptyTokenProblem(token) }
          catch (e) { fail(e, 'empty'); break }
          if (bad) {
            warn(`${bad} Run: node cli.mjs cleanup quarantine --empty`)
            process.exitCode = EXIT.badInput
            break
          }
          say('Read-only mode: nothing gets deleted, so nothing was touched.')
          break
        }
        let r = null, stopped = null
        // **這一次真的刪了幾個**：累計進度（含上一次被打斷那批）不能當成這一次的成績。
        // 以前用累計數判斷，連鎖都沒拿到（一個檔都沒刪）也會印「刪掉 2 個」、回 3（稽核第三輪）。
        const purgedBefore = countPurged()
        try { r = emptyQuarantine(db, { ...execOpts(), token, confirmed: true }) }
        catch (e) {
          if (e instanceof CleanupError && (e.code === 'CONFIRMATION_REQUIRED' || e.code === 'CONFIRMATION_EXPIRED')) {
            warn(`${shown(e.message)} Run: node cli.mjs cleanup quarantine --empty`)
            process.exitCode = EXIT.badInput
            break
          }
          // **被另一個清理動作打斷**（第三輪 R3-3b）：檔已經被**永久刪掉**幾個了，
          // 只印一句「鎖被接走」、回 2（＝動作沒執行）是說謊，而且使用者永遠不知道刪了幾個。
          // 核心把進度存在 cleanup_empty_progress 裡（R2-6），讀得到就照實講。
          const done = e instanceof CleanupError ? emptyProgress(token) : null
          // 這一次一個檔都沒刪（例如連鎖都沒拿到）→ 動作沒執行，照常回 2
          if (!done || !done.deletedCount || countPurged() === purgedBefore) { fail(e, 'empty'); break }
          stopped = { why: shown(e.message), ...done }
        }
        // 核心之後會改成回傳 stoppedEarly（不丟例外）：兩條路都要接得住
        if (r?.stoppedEarly) {
          if (countPurged() === purgedBefore) { fail(new CleanupError('BUSY', r.stoppedEarly.why), 'empty'); break }
          stopped = { ...r, why: shown(r.stoppedEarly.why ?? 'another cleanup action interrupted it.') }
        }
        if (stopped) {
          say(`Deleted ${plural(stopped.deletedCount, 'file')}, ${mb(stopped.deletedBytes)}.`)
          warn(`\n⚠ Another cleanup action interrupted this one, so it stopped partway (${stopped.why}).`)
          say('What was deleted is gone for good. To carry on with the rest, run '
            + `node cli.mjs cleanup quarantine --empty --yes ${shown(token)}`
            + ' again (if the code has expired, preview again: node cli.mjs cleanup quarantine --empty).')
          process.exitCode = EXIT.partial
          break
        }
        // noop：同一個確認碼重送，核心回上一次存下來的結果、一個檔都沒再刪（不記成「清空成功過」，R3-2b）
        noteResult('empty', r)
        say(`Deleted ${plural(r.deletedCount, 'file')}, ${mb(r.deletedBytes)}.`)
        if (r.noop === true) say('That confirmation code had already been used, so nothing happened this time — the numbers above are from that run.')
        // 放到一邊的（內容跟當初不一樣、或已經不在隔離區）：講清楚，但**不算失敗**
        // —— 以前算成錯，清空從此固定回 3，隔離區永遠清不空（稽核第三輪）。
        for (const x of r.setAside ?? []) say(`  ・${shown(x.why)}`)
        if ((r.setAside ?? []).length) {
          say(`Quarantine is at ${shown(QUARANTINE)}; look and delete them yourself. The next empty tidies those rows away.`)
        }
        if (r.errors.length) {
          warn(`${r.errors.length} could not be deleted:`)
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
            ? `No file is seven days old yet. The oldest has ${plural(days(soonest), 'day')} to go.`
            : 'Quarantine is empty.')
          break
        }
        if (config.readonly) {
          say(`Read-only mode: ${plural(ready.length, 'file')} old enough (${mb(ready.reduce((n, r) => n + r.bytes, 0))}), but nothing was touched.`)
          break
        }
        let prep
        try { prep = prepareEmptyQuarantine(db, execOpts()) }
        catch (e) { fail(e, 'empty'); break }
        if (!prep.itemCount) { say('No file is seven days old yet.'); break }
        say(shown(prep.message))
        say(`This will permanently delete ${plural(prep.itemCount, 'file')}, ${mb(prep.bytes)}.`)
        // **二次確認要人真的再打一次。**
        say(`If you are sure, run: node cli.mjs cleanup quarantine --empty --yes ${prep.token}`)
        break
      }

      if (!rows.length) { say('Quarantine is empty.'); break }
      say(`Quarantine holds ${plural(rows.length, 'file')}, ${mb(rows.reduce((n, r) => n + r.bytes, 0))}:\n`)
      for (const r of rows) {
        say(`  ${shown(r.name)}  ${mb(r.bytes)}`)
        say(`         ${r.canEmptyNow ? 'old enough to empty' : `${plural(days(Date.parse(r.canEmptyAt)), 'day')} to go`}`)
      }
      break
    }

    if (sub === 'dismiss') {
      // 不是「還沒做好的後端」（2），是這個指令根本不存在：輸入錯（1）
      warn('There is no cleanup dismiss command. To drop a plan that was never applied: node cli.mjs cleanup release <plan-id>')
      process.exitCode = EXIT.badInput
      break
    }

    warn(`Don't know cleanup ${shown(sub ?? '')}. You can use: scan, list, apply, undo, release, quarantine`)
    process.exitCode = EXIT.badInput
    break
  }

  case 'list': {
    showProblems()
    const status = args[0]
    const rows = items.list(status, 50)
    if (!rows.length) { say(status ? `Nothing has the status ${shown(status)}.` : 'The inbox is empty.'); break }
    for (const r of rows) say(`${r.status.padEnd(13)} ${r.kind.padEnd(10)} ${shown(basename(r.path))}`)
    say(`\n${rows.length} in all.`)
    break
  }

  case 'search': {
    showProblems()
    const q = args.join(' ').trim()
    if (!q) { warn('Give something to search for.'); process.exit(1) }

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
      warn(`The database could not parse that search (${shown(e.message)}). Try wording it differently.`)
      process.exitCode = 1
      break
    }

    if (!rows.length) {
      say(`Nothing found for “${shown(q)}”.`)
      const n = db.prepare(`SELECT count(*) n FROM understanding`).get().n
      if (!n) say('(No document has been read yet, so there is nothing to search. That comes with P1.)')
      break
    }
    for (const r of rows) say(`${shown(basename(r.path))}\n   ${shown(r.summary ?? '')}\n   ${shown(r.path)}\n`)
    break
  }

  default: {
    say(`ContextBox — a pipeline for files and screenshots

  node cli.mjs doctor                      how this machine is doing right now
  node cli.mjs pet                         start the pet and the cleanup panel
  node cli.mjs open                        open the pet and cleanup panel (pet must be running)
  node cli.mjs cleanup scan                scan the cleanup scope once (Downloads only, by default)
  node cli.mjs cleanup list                see what can be cleaned up
  node cli.mjs cleanup apply [--skip id] [--also id]
                                           clear the ticked ones (ids are the characters in [ ] on the list)
  node cli.mjs cleanup undo [plan id]      undo a cleanup (no id means the most recent)
  node cli.mjs cleanup release <plan id>   drop a plan that was never applied (nothing moves)
  node cli.mjs cleanup quarantine [--empty] see quarantine, or empty it (seven days old, and a second confirmation)
  node cli.mjs think                       let the model read a round of unread files (does nothing without a model)
  node cli.mjs rename                      see which unnamed files could be renamed (the model's suggestions)
  node cli.mjs rename --apply [id…]        rename them (undoable)
  node cli.mjs rename --undo [record id…]  undo a rename (no id means the most recent)

  node cli.mjs file                        see which files belong in a course folder (the model's suggestions)
  node cli.mjs file --apply [id…] [--course name] [--kind kind]
                                           file them (undoable; a course name you change gets remembered)
  node cli.mjs file --undo [record id…]    undo a filing (no id means the most recent)
  node cli.mjs learned                     what it learned from your changes (it never moves a file)
  node cli.mjs learned --forget [id…]      forget those entries
  node cli.mjs learned --forget-all        forget everything
  node cli.mjs watch                       keep watching in the foreground
  node cli.mjs propose <file>...           take a file in by hand
  node cli.mjs list [status]               see the inbox
  node cli.mjs search <words>              full-text search

The config file is at ${shown(CONFIG_PATH)}`)
    if (cmd) process.exit(1)
  }
}
