/**
 * 清理功能的唯讀層：組清單、組健康狀態、掛 HTTP route。
 *
 * ── 這一支為什麼存在 ─────────────────────────────────────────
 *
 * A 的 scanner 把候選寫進 `cleanup_candidates`，一筆規則一列。
 * 但**使用者看的是「這個檔要不要清」，不是「這條規則要不要套用」** ——
 * 一個 90 天沒動的 zip 同時命中 archive 與 old-download，在 UI 上出現兩次就是 bug。
 *
 * 所以這一層做三件事：
 *   1. 以**檔案**為單位聚合，理由全部留著
 *   2. 決定**預設勾不勾**（見 DEFAULT_CHECK_MIN）
 *   3. **把絕對路徑擋在後端** —— 回給 UI 的東西裡不可以有完整路徑
 *
 * CLI 與 HTTP route 都呼叫 `listCandidates()`。
 * **只有一個地方決定 defaultChecked**，不准有第二份。
 */
import { statSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import { KIND_CONFIDENCE, CLEANUP_KINDS, CLEANUP_RULE_VERSION, PARTIAL_EXT } from './cleanup-rules.ts'
import {
  RETENTION_MS, applyPlan, undoPlan, listQuarantine, type ExecOptions,
} from './cleanup-exec.ts'
import { createPlan, getPlan, dismissPlan } from './cleanup-plans.ts'
import { prepareEmptyQuarantine, emptyQuarantine } from './cleanup-quarantine.ts'
import { CleanupError } from './cleanup-journal.ts'

/**
 * meta 表的 key。**兩邊不要各打一次字串。**
 * 稽查抓到：讀的是 `cleanup_watch_heartbeat`，寫的是 `watch_heartbeat`，
 * 永遠對不上，所以 /health 的 watcher 永遠說「從來沒跑過」——
 * 一個為了「靜默失敗是最大的敵人」而加的東西，自己在說謊。
 */
export const META = {
  heartbeat: 'watch_heartbeat',
  pid: 'watch_pid',
  lastError: 'cleanup_last_error',
} as const

/**
 * 信心到多少才預設打勾。
 *
 * **這個數字是規格的洞，不是隨便訂的。** spec 第 5 節的表只明說
 * 「低信心，預設不勾」，中信心那兩格（installer 70、archive 65）沒講勾不勾。
 *
 * 決定性的證據在 spec 第 0 節的 demo 主線：把 `.zip`、重複檔、空檔、
 * **安裝包**丟進 Downloads，「使用者點同意，Downloads 變乾淨」。
 * archive 與 installer 都在那句話的範圍裡，所以中信心也要勾。
 *
 * 實際的信心值是 35（低）與 65（中）兩群，中間沒有東西。取 50，
 * 兩邊各留 15 的餘裕 —— 以後調規則的信心值才不會意外翻邊。
 *
 * 誤刪的風險不是靠「預設不勾」擋的，是靠：先隔離不刪除、七天、
 * 逐項可取消、一鍵復原。
 */
export const DEFAULT_CHECK_MIN = 50

// kind 與信心值的真值來源在 cleanup-rules.ts。**不要在這裡抄第二份。**
export { KIND_CONFIDENCE, CLEANUP_KINDS }

export type CandidateReason = {
  kind: string
  confidence: number
  reason: string
  evidence: string
}

/** 一個**檔案**一列。UI 與 CLI 看到的都是這個。 */
export type CandidateRow = {
  itemId: string
  name: string
  /** 監看資料夾的顯示名（最後一段），不是完整路徑 */
  folder: string
  /** 相對於監看資料夾的子目錄。root 底下就是空字串 */
  subdir: string
  bytes: number
  mtime: string
  /** 信心最高的那一條 */
  kind: string
  confidence: number
  defaultChecked: boolean
  /** 不為 null 代表被否決：不管信心多高都不預設勾，而且要跟使用者說為什麼 */
  vetoed: string | null
  /** 這個檔的全部 candidate id。建 plan 要整包送，不然 B 會漏處理 */
  candidateIds: string[]
  /** 依信心由高到低 */
  reasons: CandidateReason[]
}

export type NeedsHumanRow = {
  itemId: string
  name: string
  folder: string
  bytes: number
  why: string
}

export type CandidateList = {
  /** 這次回了幾列 */
  total: number
  /** **全部**有幾列（沒被 limit 截斷的真實數字） */
  totalAvailable: number
  /** 被 limit 砍掉了嗎。沒有這個旗標，UI 會把 500 當成全部 */
  truncated: boolean
  bytes: number
  generatedAt: string
  candidates: CandidateRow[]
  /** 全部有幾筆（needsHuman 陣列會被砍到 50） */
  needsHumanTotal: number
  needsHumanTruncated: boolean
  needsHuman: NeedsHumanRow[]
}

type ItemRow = {
  id: string; path: string; name: string; bytes: number
  mtime: string; status: string; error: string | null
  sha256?: string | null
}

/**
 * 有沒有「絕對不要幫他勾」的理由。回 null 代表沒有。
 *
 * 這是註解裡那個「否決旗標」的第一個實例。max 取最高信心，所以
 * 「不要動」這種規則**不可以做成一條低信心候選** —— 會被蓋掉。
 *
 * 目前只有一條：**大到算不出指紋的檔**。spec 第 2 節規則 5 說它們要
 * 「先列為需要人工看」，但 scanner 把它們標成 candidate 而不是 error，
 * 而 archive／installer／old-download 這幾條規則只看副檔名與 mtime、
 * 根本不需要 sha256 —— 所以最大、最可能是重要備份的那批檔，
 * 走的是風險最高的路徑：沒有內容指紋，卻預設勾。
 */
function vetoReason(item: ItemRow): string | null {
  if (item.error) return '這個檔案讀的時候出過問題，請自己看一眼'

  // **判準要用這一列自己的事實，不可以用讀取時的門檻。**
  //
  // 上一版寫 `bytes > maxBytes`，有三個問題：
  //   1. 大的半下載檔會被誤殺 —— 而下載會中斷通常就是因為檔案大
  //   2. 讀取時的 maxBytes 跟掃描時用的可能不同。使用者把設定調大
  //      （合法操作），那個 8GB 沒有指紋的備份檔就自己恢復預設勾
  //   3. 完全不傳 maxBytes 時保護整個消失
  //
  // 真正的事實是「有沒有算出指紋」，而它就在這一列上。
  // 例外是半下載檔 —— scanner 對那些**刻意**不算指紋，那是正常的，
  // 不是「有問題」。
  const partial = PARTIAL_EXT.has(extname(item.name).toLowerCase())
  if (item.sha256 === null && item.bytes > 0 && !partial) {
    return '沒有算出內容指紋（通常是檔案太大），請自己確認'
  }
  return null
}
type CandRow = {
  id: string; item_id: string; kind: string
  confidence: number; reason: string; evidence: string
}

/**
 * 把絕對路徑拆成 UI 看得懂、但洩漏不出去的兩段。
 *
 * spec 第 6 節：「不把本機路徑洩漏給 UI」。
 * 但只給檔名的話，`2026/09/report.pdf` 跟 `report.pdf` 使用者分不出來，
 * 所以給**相對於監看資料夾**的子目錄。
 */
/** subdir 最多給幾段。**這是出口的硬上限，不靠設定正確。** */
const MAX_SUBDIR_SEGMENTS = 2

export function displayPath(path: string, roots: string[]): { folder: string; subdir: string } {
  // **取最長的命中，不是第一個。**
  // roots 同時有 /home/alice 與 /home/alice/Downloads 時（設定裡把家目錄
  // 也加進去，normalize 只會警告不會移除），取第一個會讓 folder 變成
  // 「alice」—— 使用者名稱就這樣出現在一個不需要 token 的端點上。
  const hit = roots
    .map(root => ({ root, rel: relative(root, path) }))
    .filter(h => {
      // 冒號檢查只看**開頭**（Windows 磁碟機字母）。套在整條相對路徑上的話，
      // `log-2026-09-15T10:30:00.zip` 這種合法的 POSIX 檔名會被誤殺。
      const outside = h.rel === '..' || h.rel.startsWith('..' + sep)
      return h.rel && !outside && !/^[A-Za-z]:/.test(h.rel)
    })
    .sort((a, b) => b.root.length - a.root.length)[0]

  // 比不到 root（設定改過、檔案被搬走）—— 只給檔名，寧可少講也不要洩漏
  if (!hit) return { folder: '', subdir: '' }

  const dir = dirname(hit.rel)
  let subdir = dir === '.' ? '' : dir
  // **出口硬上限。** watch 設成 `/` 的時候（normalize 只警告不移除），
  // relative('/', '/home/alice/Downloads/x.zip') 就是完整路徑少一個斜線，
  // 整條會變成 subdir。防線要在資料離開後端的那一行，不在設定驗證那一行。
  const segs = subdir.split(/[\\/]+/).filter(Boolean)
  if (segs.length > MAX_SUBDIR_SEGMENTS) subdir = '…/' + segs.slice(-2).join('/')

  // folder 是家目錄名字的話等於洩漏使用者名稱，不如不給
  const folder = basename(hit.root)
  // 比整條路徑，不要比 basename —— /mnt/backup/lulumi 跟家目錄沒關係
  return { folder: resolve(hit.root) === resolve(homedir()) ? '' : folder, subdir }
}

/**
 * duplicate 的 evidence 要**指名留著的是哪一份**。
 *
 * A 產出的是「同一個 sha256 還有 N 份檔案存在」，數字對但使用者無法確認安全 ——
 * 他沒辦法知道「我還留著一份」。這裡把留下來的那個檔名補進去。
 */
function enrichDuplicate(db: DatabaseSync, item: ItemRow, evidence: string, roots: string[]): string {
  const sha = (db.prepare(`SELECT sha256 FROM file_items WHERE id=?`).get(item.id) as { sha256: string | null })?.sha256
  if (!sha) return evidence
  const keep = db.prepare(
    `SELECT id, name, path FROM file_items
     WHERE sha256=? AND status NOT IN ('quarantined','missing','error')
     ORDER BY first_seen_at, path LIMIT 1`
  ).get(sha) as { id: string; name: string; path: string } | undefined
  // **比 id 不比 name。** 比 name 的話，同名不同目錄
  //（`Downloads/report.pdf` 與 `Downloads/2026/09/report.pdf`，瀏覽器重下載很常見）
  // 會被當成同一個檔，「會留著」那句話整個消失 —— 而那句話正是使用者敢勾的理由。
  if (!keep || keep.id === item.id) return evidence
  const where = displayPath(keep.path, roots).subdir
  return `${evidence}，會留著「${keep.name}」` + (where ? `（在 ${where}）` : '')
}

/**
 * 把後端的錯誤原文換成一句固定的人話。
 *
 * **絕對不可以把 `file_items.error` 直通給 UI。** fs 的錯誤長這樣：
 *   `EACCES: permission denied, open '/home/u/Downloads/薪資單.pdf'`
 * 原文裡有完整路徑，而這個欄位會出現在畫面上、也會出現在不需要 token 的
 * /health 旁邊。稽查實測過真的漏出去。原文只留在資料庫裡給人查。
 */
export function humanError(raw: string | null): string {
  const s = String(raw ?? '')
  if (/EACCES|EPERM|permission denied/i.test(s)) return '沒有權限讀這個檔案'
  if (/ENOENT|no such file/i.test(s)) return '這個檔案已經不在了'
  if (/EISDIR/i.test(s)) return '這是一個資料夾，不是檔案'
  if (/EMFILE|ENFILE/i.test(s)) return '同時開太多檔案了，等一下會再試'
  if (/EBUSY|EAGAIN/i.test(s)) return '這個檔案正在被別的程式使用'
  if (/too large|太大/i.test(s)) return '檔案太大，沒有算指紋'
  return '讀不到這個檔案'
}

export type ListOptions = {
  /** 監看資料夾。用來把絕對路徑換成顯示用的 folder/subdir */
  roots: string[]
  limit?: number
}

/**
 * 清理候選，以**檔案**為單位。
 * HTTP route 與 CLI 都用這一支 —— 不准有第二份組裝邏輯。
 */
export function listCandidates(db: DatabaseSync, opts: ListOptions): CandidateList {
  const limit = opts.limit ?? 500

  const cands = db.prepare(
    `SELECT c.id, c.item_id, c.kind, c.confidence, c.reason, c.evidence
     FROM cleanup_candidates c
     JOIN file_items i ON i.id = c.item_id
     -- rule_version 一定要過濾。scanner 只清當前版本的候選，舊版本的
     -- proposed 列會永久活著 —— 那代表**調降規則信心永遠不會生效**
     -- （max 取的是「這個檔歷史上拿過的最高分」），而且同一個 kind
     -- 會在 reasons 裡出現兩次、舊版的 id 也會被送去 apply。
     WHERE c.status='proposed' AND c.rule_version = ?
       -- 'error' 也要排除，不然讀不到的檔會同時出現在
       -- 「幫你勾好了」與「你自己看一眼」兩區，而且兩邊講的話互相矛盾
       AND i.status NOT IN ('quarantined','missing','error')
       -- **有 error 文字的也要排除**（status 可能還是 candidate：B 搬移失敗、
       -- scanner 的太大檔都是這樣寫的）。原本只排 status='error'，漏了這一半。
       -- 而且 B 的 createPlan 本來就拒收 error 不是 NULL 的檔 —— 列在清單上
       -- 等於放一個永遠勾不成功的勾選框：前端保留勾選 → 建計畫回 STALE →
       -- 重載 → 還是勾著 → 又 STALE，死循環。**列出來的就要建得了計畫。**
       -- 重掃會清掉 error（upsertFile 的 error=excluded.error），所以會自己回來。
       AND i.error IS NULL
     -- tie-break 一定要穩定。原本是 c.id（UUID），兩條規則同分時
     -- 卡片標題每次重掃都會亂跳（實測 12 次 6:6）。
     ORDER BY c.confidence DESC, c.kind`
  ).all(CLEANUP_RULE_VERSION) as CandRow[]

  const byItem = new Map<string, CandRow[]>()
  for (const c of cands) {
    const list = byItem.get(c.item_id)
    if (list) list.push(c)
    else byItem.set(c.item_id, [c])
  }

  const rows: CandidateRow[] = []
  let bytes = 0
  for (const [itemId, list] of byItem) {
    const item = db.prepare(
      `SELECT id, path, name, bytes, mtime, status, error, sha256 FROM file_items WHERE id=?`
    ).get(itemId) as ItemRow | undefined
    if (!item) continue

    // 已經照 confidence DESC 抓出來了，第一筆就是最高的
    const reasons: CandidateReason[] = list.map(c => ({
      kind: c.kind,
      confidence: c.confidence,
      reason: c.reason,
      evidence: c.kind === 'duplicate' ? enrichDuplicate(db, item, c.evidence, opts.roots) : c.evidence,
    }))
    const top = reasons[0]
    const { folder, subdir } = displayPath(item.path, opts.roots)
    const veto = vetoReason(item)

    rows.push({
      itemId, name: item.name, folder, subdir,
      bytes: item.bytes, mtime: item.mtime,
      kind: top.kind,
      confidence: top.confidence,
      // 一個檔一個決定，用**最高**信心那條。
      //
      // 為什麼是 max 不是 min：每一條規則都是「這是垃圾」的獨立證據，
      // 多命中一條是證據變多不是變少。取 min 的話，加規則會讓系統變得
      // 更不敢清 —— 200 天的 zip 反而比 40 天的難清掉，那很荒謬。
      //
      // **陷阱**：將來要加「使用者釘選」「最近開過」這種「絕對不要動」的規則，
      // **必須做成否決旗標，不可以做成一條低信心候選** —— max 會把它蓋掉。
      // 否決旗標優先於信心。沒有這一條的話，一個 8GB 的備份檔
      // 會因為副檔名是 .zip 又超過 30 天，帶著 65 分被預設勾起來。
      defaultChecked: veto === null && top.confidence >= DEFAULT_CHECK_MIN,
      vetoed: veto,
      candidateIds: list.map(c => c.id),
      reasons,
    })
    bytes += item.bytes
    if (rows.length >= limit) break
  }

  // 讀不到的檔案要讓使用者知道，但**不可以把路徑帶出去**
  // **不可以只看 status='error'。** scanner 對「太大，算不出 sha256」的檔
  // 是寫 error 文字但 status 留在 candidate，所以那批檔會完全不出現在這裡。
  const NEEDS_HUMAN_LIMIT = 50
  const brokenTotal = (db.prepare(
    `SELECT count(*) n FROM file_items
     WHERE (status='error' OR error IS NOT NULL) AND status NOT IN ('quarantined','missing')`
  ).get() as { n: number }).n
  const broken = db.prepare(
    `SELECT id, path, name, bytes, mtime, status, error, sha256 FROM file_items
     WHERE (status='error' OR error IS NOT NULL) AND status NOT IN ('quarantined','missing')
     ORDER BY last_seen_at DESC LIMIT ?`
  ).all(NEEDS_HUMAN_LIMIT) as ItemRow[]

  return {
    total: rows.length,
    totalAvailable: byItem.size,
    truncated: byItem.size > rows.length,
    bytes,
    generatedAt: new Date().toISOString(),
    candidates: rows,
    needsHumanTotal: brokenTotal,
    needsHumanTruncated: brokenTotal > broken.length,
    needsHuman: broken.map(b => ({
      itemId: b.id,
      name: b.name,
      folder: displayPath(b.path, opts.roots).folder,
      bytes: b.bytes,
      why: humanError(b.error),
    })),
  }
}

// ── health ───────────────────────────────────────────────────

export type HealthOptions = {
  /** 傳函式的話會延後求值 —— 呼叫端才不用在建構時就去讀設定檔 */
  roots: string[] | (() => string[])
  quarantine: string
  /** 這兩個只有會動檔案的 route 才需要。跟 roots 一樣可以是 thunk（延後讀設定）。 */
  maxBytes?: number | (() => number)
  readonly?: boolean | (() => boolean)
  version?: string
  /**
   * 帶 token 的呼叫才給完整內容。
   *
   * `/health` 在 token 檢查之前，所以同機任何行程、任何已安裝的擴充套件
   * 都讀得到。`watching` 的資料夾顯示名（watch 設成家目錄時就是使用者名稱）、
   * `lastError`（設計上會放錯誤訊息，那種字串很容易帶路徑）都不該無條件送出。
   */
  full?: boolean
}

const getMeta = (db: DatabaseSync, k: string): string | null =>
  ((db.prepare(`SELECT v FROM meta WHERE k=?`).get(k) as { v: string } | undefined)?.v) ?? null

/** 那個 pid 還活著嗎。心跳只證明「它上次寫的時候還活著」。 */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true }
  catch (e: any) { return e?.code === 'EPERM' }
}

/** 隔離區走訪的深度上限。B 的結構是 <plan>/<item>/content，正常只有三層。 */
const MAX_QUARANTINE_DEPTH = 8


/** 任何一段查詢炸掉都不可以讓整個健康快照少半邊。泛型用函式宣告，箭頭會被當成 JSX。 */
function safe<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}

/**
 * 隔離區現在可不可以清空。
 *
 * 抽成純函式是為了**測得到**：「滿七天 + 走訪沒看完」這個組合
 * 用真實檔案造不出來，留在 healthSnapshot 裡的話永遠碰不到那個分支。
 * 突變測試證實過 —— 把 `!truncated` 拿掉，整套測試照樣全綠。
 *
 * `canEmptyNow` 的意思是**「按下去會有東西被刪掉」**，不是「整區都能清」。
 * `emptyQuarantine` 本來就只刪合格的那幾筆，所以只要有一筆滿七天就成立。
 * 這個定義跟 canEmptyAt 互推：`canEmptyNow === (canEmptyAt !== null && canEmptyAt <= now)`。
 */
export function canEmptyNow(
  q: { items: number; truncated: boolean; canEmptyAt: string | null },
  now: number = Date.now(),
): boolean {
  if (q.items === 0) return false        // 空的隔離區「可以清空」沒有意義
  if (q.truncated) return false          // 沒看完 → fail closed
  if (!q.canEmptyAt) return false        // 算不出時間 → fail closed
  return Date.parse(q.canEmptyAt) <= now
}

export type QuarantineView = {
  items: number
  bytes: number
  oldestMtimeAt: string | null
  /** **最早**一筆變得可刪的時間。取最新那筆的話，UI 會說「還要等七天」，而其實明天就有東西可清。 */
  canEmptyAt: string | null
  /** 隔離區裡有、journal 沒有的檔。清空不會動到它們。 */
  orphans: number
  truncated: boolean
}

/**
 * 隔離區的狀態，**不上鎖**。
 *
 * B 的 `listQuarantine()` 會拿 `withCleanupLock`（寫 `cleanup_operation_lock`）。
 * 但 `/health` **不需要 token**，任何網頁都可以用 `<img src=...>` 連發
 * （它讀不到回應，但請求照樣執行）。健康檢查拿寫鎖 =
 * 一個外部網頁就能跟真正的清理動作搶鎖、或讓 /health 一直丟 BUSY。
 *
 * 所以這裡自己下唯讀查詢。**journal 是正本**，磁碟只用來數孤兒 ——
 * 有人手動丟檔進隔離區、或是搬完檔但寫 DB 前當機，都會留下 journal 沒有的檔案。
 * 那些檔 `emptyQuarantine` 不會刪，所以要另外報數；但也**不可以**讓它們擋住清空，
 * 不然一個孤兒就讓隔離區永遠清不掉。
 */
export function quarantineFromJournal(db: DatabaseSync, dir: string): QuarantineView {
  // **B 的表是懶建的。** `cleanup_move_details` 與 `cleanup_purges` 只在
  // `initCleanup()` 裡建，而那支只被 createPlan／getPlan 呼叫 ——
  // 全新安裝、還沒建過任何 plan 的機器上它們不存在，JOIN 會丟例外，
  // 外層的 safe() 就把整個隔離區區塊吞成 truncated，而且永遠不會好。
  //
  // 這裡**不主動建表**：/health 不需要 token，不可以在那條路徑上做 DDL 寫入。
  // 沒有 journal 就代表從來沒搬過檔 —— 隔離區裡任何東西都是孤兒，這是誠實的答案。
  const ready = db.prepare(
    `SELECT count(*) n FROM sqlite_master WHERE type='table'
       AND name IN ('cleanup_journal','cleanup_move_details','cleanup_purges')`
  ).get() as { n: number }
  if (ready.n < 3) {
    const onDisk = countFilesCached(dir)
    return { items: 0, bytes: 0, oldestMtimeAt: null, canEmptyAt: null,
      orphans: onDisk < 0 ? 0 : onDisk, truncated: onDisk < 0 }
  }

  const rows = db.prepare(
    `SELECT q.seq, d.completed_at, d.fingerprint
       FROM cleanup_journal q
       JOIN cleanup_move_details d ON d.seq = q.seq
      WHERE q.op='quarantine' AND q.status='done'
        AND NOT EXISTS (SELECT 1 FROM cleanup_journal r
                         WHERE r.plan_id=q.plan_id AND r.item_id=q.item_id
                           AND r.op='restore' AND r.status='done')
        AND NOT EXISTS (SELECT 1 FROM cleanup_purges p WHERE p.seq=q.seq AND p.status='done')`
  ).all() as { seq: number; completed_at: string | null; fingerprint: string }[]

  let bytes = 0, oldestMtime: number | null = null, earliest: number | null = null
  let truncated = false
  for (const r of rows) {
    // 大小與 mtime 存在 fingerprint 的 JSON 裡（B 的格式）。讀不出來就當 0，
    // 但**不影響七天窗** —— 那是 completed_at 的事。
    const fp = safe(() => JSON.parse(r.fingerprint) as { size?: number; mtime?: string }, {})
    bytes += fp.size ?? 0
    const m = fp.mtime ? Date.parse(fp.mtime) : NaN
    if (Number.isFinite(m) && (oldestMtime === null || m < oldestMtime)) oldestMtime = m
    const done = r.completed_at ? Date.parse(r.completed_at) : NaN
    // 缺隔離完成時間就算不出七天 → fail closed，而不是當成「很久以前」
    if (!Number.isFinite(done)) { truncated = true; continue }
    const at = done + RETENTION_MS
    if (earliest === null || at < earliest) earliest = at
  }

  const onDisk = countFilesCached(dir)
  // -1 代表磁碟讀不到／沒看完。journal 說有 N 筆但磁碟數不出來 → 說不出有沒有孤兒
  const orphans = onDisk < 0 ? 0 : Math.max(0, onDisk - rows.length)
  if (onDisk < 0) truncated = true

  return {
    items: rows.length,
    bytes,
    oldestMtimeAt: oldestMtime === null ? null : new Date(oldestMtime).toISOString(),
    canEmptyAt: earliest === null ? null : new Date(earliest).toISOString(),
    orphans,
    truncated,
  }
}

/** 只數檔案數，用來對帳孤兒。讀不到／沒看完就回 -1（**不是 0** —— 0 會被當成「確定沒有孤兒」）。 */
function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0
  let n = 0
  let ok = true
  const walk = (d: string, depth: number) => {
    if (depth > MAX_QUARANTINE_DEPTH) { ok = false; return }
    let entries
    // 讀不到子目錄跟深度截斷的意義一樣：**我沒有看完**，說不出有沒有孤兒。
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { ok = false; return }
    for (const e of entries) {
      if (e.isDirectory()) walk(d + sep + e.name, depth + 1)
      else if (e.isFile()) n++
    }
  }
  walk(dir, 0)
  return ok ? n : -1
}

/**
 * 數檔案要快取。
 *
 * 七天窗現在走 journal（一次 SQL），但**孤兒對帳還是得走訪磁碟**，
 * 而 `/health` 不需要 token —— 這支是同步遞迴，4 萬個檔實測 61ms，
 * 那段時間整個事件迴圈是停住的。任何網頁都可以用不帶 Origin 的 `<img>` 連發
 * （它讀不到回應，但請求照樣執行）。隔離區只有 B 的 exec 會改，十秒夠用。
 */
let countCache: { dir: string; at: number; files: number } | null = null

function countFilesCached(dir: string): number {
  if (countCache && countCache.dir === dir && Date.now() - countCache.at < 10_000) return countCache.files
  const files = countFiles(dir)
  countCache = { dir, at: Date.now(), files }
  return files
}

/** B 搬完檔呼叫這個，數字立刻更新 —— 不然新檔在那十秒裡看起來像孤兒。 */
export function invalidateQuarantineCache() { countCache = null }

/**
 * 寵物狀態。**第一個成立的贏。**
 *
 * spec 第 8 節把 `undoable` 列成一個 state，但它的條件是
 * 「隔離區裡還有這份 plan 的檔」——那會成立**七天**。當成 state 的話
 * 寵物會卡在「可以復原」整整一週，`found`／`watching` 永遠不會出現。
 * 所以降成旗標。
 *
 * 另外 `thinking`／`cleaning`／`happy` 後端**查不出來**：掃描與 apply
 * 都是同步 request，回應送出的時候它們已經結束了。那三個是前端在等
 * response 的時候自己播的動畫，不該由這裡回報。
 */
export function petState(
  h: { db: { ok: boolean }; watcher: { ok: boolean }; pendingCandidates: number; lastError: unknown },
  counts: { proposedPlans: number; activeQuarantine: number },
) {
  const state =
    // 壞掉的時候顯示「找到 7 個可以清」是在騙人
    !h.db.ok || h.lastError ? 'worried'
    // 使用者正在等確認，這時候跳「找到東西了」會蓋掉待辦
    : counts.proposedPlans > 0 ? 'waiting'
    : h.pendingCandidates > 0 ? 'found'
    : h.watcher.ok ? 'watching'
    : 'idle'

  const message =
    state === 'worried' ? '後端出了點狀況，先看一下 doctor。'
    : state === 'waiting' ? `有 ${counts.proposedPlans} 份清單等你確認。`
    : state === 'found' ? `找到 ${h.pendingCandidates} 個可以清的檔案。`
    : state === 'watching' ? '盯著 Downloads。'
    : '沒事，在發呆。'

  return {
    state,
    message,
    pendingCount: h.pendingCandidates,
    quarantinedCount: counts.activeQuarantine,
    undoable: counts.activeQuarantine > 0,
  }
}

export function healthSnapshot(db: DatabaseSync, opts: HealthOptions) {
  const rootList = typeof opts.roots === 'function' ? opts.roots() : opts.roots
  // **每一段各自 try/catch。** 這支是唯一免 token 的端點，它必須
  // 永遠回得出完整形狀 —— 資料庫壞掉時回一個少了 watcher／quarantine
  // 的第三種形狀，UI 會直接 TypeError。
  // 而且 lastError 要**最先**讀：資料庫壞掉正是它唯一要處理的情境，
  // 排在後面的話會先被別的查詢炸掉，整條回饋迴路失效。
  const lastError = safe(() => getMeta(db, META.lastError), null)
  const beat = safe(() => getMeta(db, META.heartbeat), null)
  const pid = Number(safe(() => getMeta(db, META.pid), null))
  const running = Boolean(beat) && alive(pid)
  const fresh = Boolean(beat) && (Date.now() - Date.parse(beat!)) < 5 * 60_000

  // 隔離區：journal 是正本，磁碟只用來對帳（見 quarantineFromJournal）。
  const q = safe(() => quarantineFromJournal(db, opts.quarantine),
    { items: 0, bytes: 0, oldestMtimeAt: null, canEmptyAt: null, orphans: 0, truncated: true })

  const pending = safe(() => (db.prepare(
    `SELECT count(DISTINCT c.item_id) n FROM cleanup_candidates c
     JOIN file_items i ON i.id = c.item_id
     WHERE c.status='proposed' AND c.rule_version = ?
       AND i.status NOT IN ('quarantined','missing','error')
       AND i.error IS NULL`
  ).get(CLEANUP_RULE_VERSION) as { n: number }).n, 0)

  const errors = safe(() => (db.prepare(
    `SELECT count(*) n FROM file_items
     WHERE (status='error' OR error IS NOT NULL) AND status NOT IN ('quarantined','missing')`
  ).get() as { n: number }).n, 0)

  // 真的問資料庫一次。寫死 true 的話，資料庫壞到其他每一條 route 都在噴，
  // /health 還會說一切正常 —— 那這個端點就沒有輸入，只是一個裝飾。
  let dbOk = true
  try { db.prepare('SELECT 1').get(); db.prepare('SELECT count(*) FROM meta').get() } catch { dbOk = false }

  // 監看資料夾不存在的話，掃描會安靜地回 0 個檔 —— 跟「很乾淨」長得一模一樣。
  // 使用者搬了家目錄、換了 OneDrive 路徑、外接碟沒掛上，都會踩到。
  const rootsMissing = rootList.filter(r => !existsSync(r)).length
  const watcherOk = running && fresh && rootsMissing === 0
  const full = opts.full === true

  return {
    // **ok 只講「這台後端能不能用」。** watcher 有沒有在跑是另一回事 ——
    // 使用者剛裝好還沒開 pet，後端是好的（查得到候選、資料庫是通的），
    // 這時候回 ok:false 對 liveness probe 與 UI 都是錯的訊號。
    ok: dbOk,
    version: opts.version ?? '0.1.0',
    db: { ok: dbOk },
    watcher: {
      ok: watcherOk,
      // **形狀在兩版之間必須一致。** 換型別（string[] ↔ number）的話，
      // C 拿免 token 那版做 UI，`watching.map(...)` 直接 TypeError。
      // undefined 更糟 —— JSON.stringify 會整個刪掉，連「這個欄位被遮蔽了」
      // 都看不出來。所以：一律有，遮蔽時給 null／空陣列。
      lastHeartbeatAt: full ? beat : null,
      pid: full ? (Number.isInteger(pid) && pid > 0 ? pid : null) : null,
      rootsMissing,
      watchingCount: rootList.length,
      // 顯示名只給帶 token 的。watch 設成家目錄時，basename 就是使用者名稱。
      watching: full ? rootList.map(r => displayPath(join(r, 'x'), rootList).folder) : [],
      why: !beat ? '從來沒跑過'
        : !running ? '那個行程已經不在了'
        : !fresh ? '行程還在，但心跳停了超過五分鐘'
        : rootsMissing ? '有監看資料夾不存在'
        : null,
    },
    quarantine: {
      items: q.items, bytes: q.bytes,
      /** 檔案自己的 mtime，**不是**隔離時間。只拿來顯示，不要拿來算七天。 */
      oldestMtimeAt: q.oldestMtimeAt,
      canEmptyAt: q.canEmptyAt,
      canEmptyNow: canEmptyNow(q),
      /** 隔離區裡有、journal 沒有的檔。清空**不會**動到它們，所以要說出來。 */
      orphans: q.orphans,
      truncated: q.truncated,
    },
    pendingCandidates: pending,
    needsHumanCount: errors,
    // lastError 的內容只給帶 token 的 —— 那個欄位設計上會放錯誤訊息，
    // 而這個系統的錯誤字串帶完整路徑（fs 的 message 一律含 path）。
    lastError: full ? lastError : (lastError ? '有，帶 token 才看得到' : null),
  }
}

// ── 預設要清哪些 ─────────────────────────────────────────────

/**
 * 「預設清理」要清的候選 id。**跟清單上打 ✔ 的一模一樣。**
 *
 * B 的 createPlan 不帶 id 時有自己的預設（信心 ≥ 50），但它**不看否決** ——
 * 太大、沒有指紋的檔在清單上是 ☐，卻會被收進預設計畫。使用者把大小上限調大
 * （合法操作、不用重掃）之後，它就直接被搬走了。獨立重推實測抓到。
 *
 * 所以 route 與 CLI 一律用這支算出明確的 id 再交給 createPlan：
 * **defaultChecked 只有 listCandidates 一個地方在決定**（spec 不變量 2）。
 * 不受顯示上限影響 —— 清單只列 500 個，但預設清理要清的是全部打 ✔ 的。
 */
export function defaultCandidateIds(db: DatabaseSync, roots: string[]): string[] {
  return listCandidates(db, { roots, limit: Number.MAX_SAFE_INTEGER }).candidates
    .filter(c => c.defaultChecked).flatMap(c => c.candidateIds)
}

// ── 計畫的逐項結果 ───────────────────────────────────────────

/**
 * 失敗原因要能給 UI 看。
 *
 * B 的 `cleanupProblem()` 寫進去的已經是人話而且不帶路徑 —— **原樣通過**，
 * 不然「十分鐘內還在變動，等一下再試」這種有用的話會被 humanError 吃成
 * 「讀不到這個檔案」。但 `file_items.error` 也可能是 scanner 寫的 fs 原文，
 * 那種帶完整路徑。所以：**看起來帶路徑或 fs 錯誤碼的才翻譯**。
 */
function safeWhy(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = String(raw)
  if (/[\/\\]|\bE[A-Z]{2,}\b/.test(s)) return humanError(s)
  return s.slice(0, 200)
}

export type ItemOutcome = 'pending' | 'moved' | 'skipped' | 'failed' | 'restored' | 'purged'
type Outcome = { outcome: ItemOutcome; why: string | null; restoredAs?: string }

/**
 * 計畫裡每個檔現在的下場。**這是唯一一份算法**，route 與 CLI 共用。
 *
 * CLI 那邊踩過一次：一律印 ✔，全失敗時畫面上是一排 ✔ 後面接「搬進隔離區 0 個」。
 * 前端自己用「勾了幾個」去推算，會踩同一個坑。
 *
 * 失敗原因有兩個地方：搬移失敗寫在 journal；**檢查沒過（例如 TOO_FRESH）
 * 根本不會寫 journal**，只寫 `file_items.error`。只查一處的話最常見的失敗會沒有原因。
 */
export function planOutcomes(db: DatabaseSync, planId: string): Map<string, Outcome> {
  const plan = db.prepare('SELECT status FROM cleanup_plans WHERE id=?').get(planId) as { status: string } | undefined
  const out = new Map<string, Outcome>()
  if (!plan) return out
  const hasPurges = (db.prepare(
    `SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='cleanup_purges'`).get() as { n: number }).n > 0
  const purged = new Set(hasPurges
    ? (db.prepare(`SELECT seq FROM cleanup_purges WHERE status='done'`).all() as { seq: number }[]).map(r => r.seq)
    : [])
  const lastQ = new Map<string, { seq: number; status: string; error: string | null }>()
  const lastR = new Map<string, { status: string; to_path: string | null }>()
  for (const j of db.prepare(
    `SELECT seq, item_id, op, status, error, to_path FROM cleanup_journal WHERE plan_id=? ORDER BY seq`
  ).all(planId) as { seq: number; item_id: string; op: string; status: string; error: string | null; to_path: string | null }[]) {
    if (j.op === 'quarantine') lastQ.set(j.item_id, j)
    if (j.op === 'restore') lastR.set(j.item_id, j)
  }
  const ran = plan.status !== 'proposed' && plan.status !== 'dismissed'
  const items = db.prepare(
    `SELECT DISTINCT c.item_id, max(p.skipped) skipped, f.error, f.name
       FROM cleanup_plan_items p
       JOIN cleanup_candidates c ON c.id = p.candidate_id
       LEFT JOIN file_items f ON f.id = c.item_id
      WHERE p.plan_id = ? GROUP BY c.item_id`
  ).all(planId) as { item_id: string; skipped: number; error: string | null; name: string }[]
  for (const i of items) {
    const q = lastQ.get(i.item_id)
    const r = lastR.get(i.item_id)
    let outcome: ItemOutcome, why: string | null = null
    if (i.skipped) outcome = 'skipped'
    else if (q?.status === 'done' && r?.status === 'done') outcome = 'restored'
    else if (q?.status === 'done' && purged.has(q.seq)) outcome = 'purged'
    else if (q?.status === 'done') outcome = 'moved'
    else if (!ran && !q) outcome = 'pending'
    else {
      outcome = 'failed'
      why = safeWhy(q?.error) ?? safeWhy(i.error) ?? '沒有搬動，原因不明'
    }
    const o: Outcome = { outcome, why }
    // **原位置被佔的時候，放回來的那份會改名**（B 的 restoreTarget：X.zip.restored）。
    // 不講的話使用者會以為「放回原位」—— 其實原位是後來那個檔。只給檔名，不給路徑。
    if (outcome === 'restored' && r?.to_path) {
      const as = basename(r.to_path)
      if (as !== i.name) o.restoredAs = as
    }
    out.set(i.item_id, o)
  }
  return out
}

/** 把逐項結果掛到 B 的計畫 DTO 上。 */
export function withOutcomes<T extends { id: string; items: { itemId: string }[] }>(db: DatabaseSync, dto: T): T {
  const o = planOutcomes(db, dto.id)
  return { ...dto, items: dto.items.map(i => ({ ...i, ...(o.get(i.itemId) ?? { outcome: 'pending', why: null }) })) }
}

/**
 * 計畫列表。形狀刻意跟 C 的 `/demo/cleanup/history` 一樣
 * （`{ total, offset, limit, operations }`），讓歷史面板兩個模式共用同一段渲染。
 *
 * `filter`：
 * - `undoable`：隔離區裡**現在**還有東西的。已復原、已被清空的都不算 ——
 *   說能復原但其實檔案已經永久刪除，是在騙人。`items` 只列還能放回去的那些。
 * - `pending`：還沒做完、還佔著檔案的（proposed／partial／error）。給「接續上次那份」用。
 *
 * **不上鎖**，純讀。
 */
export function listPlans(db: DatabaseSync, opts: { filter?: 'undoable' | 'pending'; offset?: number; limit?: number }) {
  const limit = opts.limit ?? 20
  let offset = opts.offset ?? 0
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
    throw new CleanupError('BAD_BODY', '分頁參數不正確：limit 要是 1 到 100，offset 不可以是負的。')
  }
  const ready = (db.prepare(
    `SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='cleanup_snapshots'`).get() as { n: number }).n
  if (!ready) return { total: 0, offset: 0, limit, operations: [] }

  const plans = db.prepare(
    `SELECT id, status, created_at, applied_at FROM cleanup_plans ORDER BY created_at DESC, rowid DESC`
  ).all() as { id: string; status: string; created_at: string; applied_at: string | null }[]

  const rows = []
  for (const p of plans) {
    if (opts.filter === 'pending' && !['proposed', 'partial', 'error'].includes(p.status)) continue
    const o = planOutcomes(db, p.id)
    const snaps = (db.prepare('SELECT snapshot FROM cleanup_snapshots WHERE plan_id=? ORDER BY rowid')
      .all(p.id) as { snapshot: string }[]).map(r => JSON.parse(r.snapshot) as { id: string; name: string; bytes: number })
    const want = opts.filter === 'undoable' ? ['moved']
      : opts.filter === 'pending' ? ['pending', 'failed'] : null
    const items = snaps.filter(i => !want || want.includes(o.get(i.id)?.outcome ?? ''))
      .map(i => ({ itemId: i.id, name: i.name, bytes: i.bytes }))
    const canUndo = snaps.some(i => o.get(i.id)?.outcome === 'moved')
    if (opts.filter === 'undoable' && !canUndo) continue
    if (opts.filter === 'pending' && !items.length) continue
    const restored = db.prepare(
      `SELECT max(ts) ts FROM cleanup_journal WHERE plan_id=? AND op='restore' AND status='done'`
    ).get(p.id) as { ts: string | null }
    rows.push({
      id: p.id, status: p.status, createdAt: p.created_at, appliedAt: p.applied_at,
      restoredAt: restored.ts, canUndo,
      itemCount: items.length, bytes: items.reduce((n, i) => n + i.bytes, 0), items,
    })
  }
  const total = rows.length
  // 跟 C 的 demo 歷史一樣：offset 超過最後一頁就夾回最後一頁，不回空白頁
  offset = Math.min(offset, Math.max(0, Math.ceil(total / limit) - 1) * limit)
  return { total, offset, limit, operations: rows.slice(offset, offset + limit) }
}

// ── HTTP ─────────────────────────────────────────────────────

export type RouteCtx = {
  db: DatabaseSync
  roots: string[] | (() => string[])
  quarantine: string
  /** 這兩個只有會動檔案的 route 才需要。跟 roots 一樣可以是 thunk（延後讀設定）。 */
  maxBytes?: number | (() => number)
  readonly?: boolean | (() => boolean)
  url: URL
  method: string
  body: any
  send: (code: number, payload: unknown) => void
  /** 手動掃一次。由呼叫端注入，這一支不直接相依 scanner。 */
  scan: () => { scanned: number; candidates: number; skipped: number; errors: number; truncated: boolean }
}

/** 錯誤沿用既有 server 的 { error: 字串 }，多一個 code 給程式分支。 */
const fail = (send: RouteCtx['send'], code: number, error: string, tag: string) =>
  send(code, { error, code: tag })

/**
 * B 的 CleanupError code → HTTP 狀態碼。
 *
 * **這張表一定要跟 B 的原始碼對得上。** 手寫清單會腐爛 ——
 * 上一輪 `KIND_CONFIDENCE` 就是這樣：新增一條規則、表沒更新，
 * 它靜靜變成預設值，沒有任何測試會紅。
 * 所以 `test/cleanup-wire.test.mjs` 會從 `core/cleanup-*.ts` 把 code 抓出來比對，
 * B 新增一個沒對應的 code 就紅。
 *
 * 分三類：**使用者送錯**（4xx 該改請求）、**狀態衝突**（4xx 該改做法）、
 * **這台機器的問題**（5xx 不是呼叫端的錯）。
 */
export const HTTP_FOR_CODE: Record<string, number> = {
  // ── 請求本身有問題
  BAD_BODY: 400,
  NOT_FOUND: 404,

  // ── 請求合法，但現在的狀態不允許
  CONFLICT: 409,
  // 候選變了是狀態衝突，不是格式錯 —— C 該重新掃描，不是改參數
  STALE_CANDIDATE: 409,
  // 「沒東西可清」對 HTTP 是狀態；對 CLI 是**成功**（見 cli.mjs 的離開碼）
  EMPTY_PLAN: 409,
  TOO_RECENT: 409,
  // 檔案十分鐘內還在變動。等一下重試就會成功，所以是狀態不是錯誤。
  TOO_FRESH: 409,
  // 唯讀模式是權限拒絕，不是格式錯
  READ_ONLY: 403,
  // 語意就是為「你少做了前一步」設計的
  CONFIRMATION_REQUIRED: 428,
  // 曾經有效、現在永久消失 —— 重試同一個 token 沒有意義
  CONFIRMATION_EXPIRED: 410,
  // 請求完全合法，只是現在忙。409 會讓 C 以為要改請求
  BUSY: 503,

  // ── 這台機器的問題，呼叫端改什麼都沒用
  BAD_CONFIG: 500,
  UNSAFE_PATH: 500,
  UNSAFE_JOURNAL: 500,
  UNSAFE_FILE: 500,
  // 底下這些多半只出現在**逐項結果**裡（applyPlan／emptyQuarantine 的
  // 逐檔 try/catch），整個請求仍然 200 —— 一個檔失敗不該讓另外九個檔的成功消失。
  // 列在這裡是為了萬一它們真的穿到路由層時不會掉進未知分支。
  CHANGED: 500,
  MISSING: 500,
  PURGED: 500,
  PROTECTED: 500,
  OUTSIDE_ROOT: 500,
  NO_DUPLICATE: 500,
  VERIFY_FAILED: 500,
}

/**
 * 認不得的 code 走 **500**。
 *
 * 400 等於告訴 C「你打錯了」，它會改 body 重試，永遠修不好 ——
 * 第二輪才修過一模一樣的 bug（後端故障回 400 + SQLite 原文）。
 * 不知道是誰的錯的時候，說「不是你的錯」比較安全。
 */
export function statusFor(code: string | undefined): number {
  if (code && Object.prototype.hasOwnProperty.call(HTTP_FOR_CODE, code)) return HTTP_FOR_CODE[code]
  return 500
}

/**
 * 清理相關的唯讀 route。**認得就處理並回 true，不認得回 false** 讓下一個接手。
 *
 * apply／undo／dismiss 不在這裡 —— 那些會真的動檔案，是 B 的範圍。
 */
/** 組出 B 要的 ExecOptions。thunk 在這裡才求值 —— 唯讀的 route 不該去碰設定檔。 */
function execOptions(ctx: RouteCtx): ExecOptions {
  return {
    roots: typeof ctx.roots === 'function' ? ctx.roots() : ctx.roots,
    quarantine: ctx.quarantine,
    maxBytes: typeof ctx.maxBytes === 'function' ? ctx.maxBytes() : (ctx.maxBytes ?? 0),
    readonly: typeof ctx.readonly === 'function' ? ctx.readonly() : ctx.readonly,
  }
}

export function cleanupRoutes(ctx: RouteCtx): boolean {
  // **整支包起來。** 不包的話例外會穿到 server.ts 的 catch，那裡回的是
  // 400 + SQLite 原文 —— 伺服器故障卻告訴 C「你打錯了」，而且原文可能帶路徑。
  try { return route(ctx) }
  catch (e: any) {
    // B 的 CleanupError 訊息都是寫好的人話而且不含路徑（cleanupProblem 負責），
    // 所以可以直接送出去。其他例外一律換成罐頭訊息。
    if (e instanceof CleanupError) {
      const status = statusFor(e.code)
      // 5xx 才值得記進 lastError —— 4xx 是呼叫端的事，記了只會把 doctor 洗版
      if (status >= 500) reportError(ctx.db, e)
      fail(ctx.send, status, e.message, e.code)
      return true
    }
    reportError(ctx.db, e)
    fail(ctx.send, 500, '後端出錯了，這一步沒有搬動或刪除任何檔案。', 'INTERNAL')
    return true
  }
}

/** 錯誤要留下來。吞掉的話 /health 的 lastError 永遠是 null。 */
function reportError(db: DatabaseSync, e: any) {
  const msg = String((e && e.message) || e).slice(0, 300)
  console.error('[contextbox] cleanup route 出錯：', msg)
  try {
    db.prepare(`INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`)
      .run(META.lastError, `${new Date().toISOString()} ${msg}`)
  } catch { /* 連 meta 都寫不進去就算了 */ }
}

function route(ctx: RouteCtx): boolean {
  const { url, method, send } = ctx
  const p = url.pathname

  if (p === '/cleanup/candidates' && method === 'GET') {
    const raw = url.searchParams.get('limit')
    const limit = raw === null ? undefined : Number(raw)
    if (raw !== null && (!Number.isInteger(limit) || limit! < 1 || limit! > 1000)) {
      fail(send, 400, 'limit 要是 1 到 1000 之間的整數。', 'BAD_BODY')
      return true
    }
    const roots = typeof ctx.roots === 'function' ? ctx.roots() : ctx.roots
    send(200, listCandidates(ctx.db, { roots, limit }))
    return true
  }

  if (p === '/cleanup/scan' && method === 'POST') {
    // 註：這裡曾經有一個 module 層的 `scanning` 旗標想擋併發掃描。
    // 那是死碼 —— scanDownloads 是同步的，中間沒有任何 await，
    // 同一個行程裡第二個請求根本沒機會在旗標為 true 時被處理（實測 4 個併發全部 200）。
    // 而真正的風險是**多個行程**（右鍵一次選 20 個檔 = 20 個行程），
    // module 層變數對那個一點用都沒有。要做就得用 meta 表的租約鎖。
    try {
      const r = ctx.scan()
      send(200, r)
    } catch (e: any) {
      // 掃描壞掉不可以把路徑吐給 UI，但**錯誤本身不可以消失** ——
      // 吞掉的話連續失敗十次，doctor 與 /health 都會說一切正常。
      // （檔案沒被搬動是真的，但 scanner 逐檔寫入沒有交易，
      //   掃到一半炸掉時資料庫已經改了一半，所以措辭是「沒有搬動或刪除」。）
      reportError(ctx.db, e)
      fail(send, 500, '掃描的時候出錯了，沒有搬動或刪除任何檔案。', 'INTERNAL')
    }
    return true
  }

  // ── B 的執行層 ────────────────────────────────────────────

  if (p === '/cleanup/plans' && method === 'GET') {
    const q = url.searchParams
    const num = (k: string) => q.get(k) === null ? undefined : Number(q.get(k))
    send(200, listPlans(ctx.db, {
      filter: q.get('undoable') === '1' ? 'undoable' : q.get('pending') === '1' ? 'pending' : undefined,
      offset: num('offset'), limit: num('limit'),
    }))
    return true
  }

  if (p === '/cleanup/plans' && method === 'POST') {
    // **唯讀模式一份都不可以建。** createPlan 不看 readonly（只有 applyPlan 看），
    // 建了再被 apply 擋下的話，那份計畫卡在 proposed、永遠佔住那些檔，
    // 之後任何人建計畫都撞 CONFLICT。CLI 那輪修過一模一樣的 bug。
    const ro = typeof ctx.readonly === 'function' ? ctx.readonly() : ctx.readonly
    if (ro) throw new CleanupError('READ_ONLY', '目前是唯讀模式，不會建立清理計畫，也不會搬動任何檔案。')
    const roots = typeof ctx.roots === 'function' ? ctx.roots() : ctx.roots
    send(200, withOutcomes(ctx.db, createPlan(ctx.db, {
      // 不帶 id ＝「清單上打 ✔ 的」。不交給 B 的預設 —— 那個不看否決。
      candidateIds: ctx.body?.candidateIds ?? defaultCandidateIds(ctx.db, roots),
      requestId: ctx.body?.requestId,
    })))
    return true
  }

  const plan = /^\/cleanup\/plans\/([^/]+)(?:\/(apply|undo|dismiss))?$/.exec(p)
  if (plan) {
    const id = decodeURIComponent(plan[1])
    const action = plan[2]
    // 每個回應都帶逐項結果（outcome／why）。UI 不可以自己用「勾了幾個」推算。
    if (!action && method === 'GET') { send(200, withOutcomes(ctx.db, getPlan(ctx.db, id))); return true }
    if (action && method === 'POST') {
      if (action === 'dismiss') { send(200, withOutcomes(ctx.db, dismissPlan(ctx.db, id))); return true }
      const opts = execOptions(ctx)
      const r = action === 'apply'
        ? applyPlan(ctx.db, id, { ...opts, skippedIds: ctx.body?.skippedIds })
        : undoPlan(ctx.db, id, opts)
      invalidateQuarantineCache()   // 隔離區剛變了，孤兒對帳的快取不可以再用
      send(200, withOutcomes(ctx.db, r))
      return true
    }
    fail(send, 405, '這個路徑不收這個方法。', 'BAD_METHOD')
    return true
  }

  if (p === '/cleanup/quarantine' && method === 'GET') {
    const items = listQuarantine(ctx.db)
    send(200, {
      items,
      total: items.length,
      bytes: items.reduce((n, i) => n + i.bytes, 0),
    })
    return true
  }

  if (p === '/cleanup/quarantine/empty' && method === 'POST') {
    // **一個路由兩個階段。** 不帶 token = 預覽；帶 token + confirmed = 真的刪。
    // `phase` 一定要回，不然 C 分不出自己拿到的是預覽還是結果。
    const token = ctx.body?.token
    if (!token) {
      // 預覽是唯讀動作。現在沒有滿七天的檔就回 itemCount 0，
      // 不要丟錯 —— 對一個唯讀動作丟錯很沒道理。
      send(200, { phase: 'preview', ...prepareEmptyQuarantine(ctx.db, execOptions(ctx)) })
      return true
    }
    // **`confirmed` 原封不動傳給 B。** 不可以 Boolean() ——
    // body 是 `{"confirmed":"false"}` 的話，字串 "false" 在 JS 是 truthy，
    // 而這是整個專案唯一會真的刪檔的路徑。
    send(200, { phase: 'done', ...emptyQuarantine(ctx.db, {
      ...execOptions(ctx), token, confirmed: ctx.body?.confirmed,
    }) })
    return true
  }

  if (p === '/pet/state' && method === 'GET') {
    const roots = typeof ctx.roots === 'function' ? ctx.roots() : ctx.roots
    const h = healthSnapshot(ctx.db, { roots, quarantine: ctx.quarantine })
    send(200, petState(h, {
      proposedPlans: safe(() => (ctx.db.prepare(
        `SELECT count(*) n FROM cleanup_plans WHERE status='proposed'`).get() as { n: number }).n, 0),
      activeQuarantine: h.quarantine.items,
    }))
    return true
  }

  // 還沒實作的（B 的範圍）要回一句人話，不是 404 —— 404 會讓 C 以為自己打錯網址。
  // 第一版漏了 apply／undo／dismiss／reveal／quarantine/empty，它們照樣掉到 404，
  // 也就是這段註解本來要避免的那件事。
  // **反過來列白名單。** 逐條列黑名單一定會漏（第一版漏了 apply／undo／
  // dismiss／reveal／quarantine/empty，第二版還漏 restore／empty），
  // 而漏掉的後果就是這段註解要避免的那件事。
  if (p.startsWith('/cleanup/') || p.startsWith('/pet/')) {
    fail(send, 501, '這個功能還沒做好。', 'NOT_IMPLEMENTED')
    return true
  }

  return false
}
