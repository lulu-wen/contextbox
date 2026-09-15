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

type QuarantineStats = {
  items: number; bytes: number
  oldestAt: string | null
  /** **最新**一次被搬進來的時間。七天窗看這個。 */
  newestQuarantinedAt: string | null
  /** 走訪超過深度上限，數字是少報的 */
  truncated: boolean
}

/** 隔離區的佈局是 B 決定的（可能按 plan id 或日期分層），留寬一點 */
const MAX_QUARANTINE_DEPTH = 8

/** 檔案是什麼時候被搬進隔離區的。ctime 會被 rename 更新，mtime 不會。 */
const quarantinedAt = (st: { ctimeMs: number; mtimeMs: number }): number =>
  // 取 max 是對的方向（rename／cross-fs move／cp -a 都會把 ctime 設成現在，
  // 所以 max ≥ 真正的隔離時間，永遠偏保守）。但**一定要夾上限** ——
  // 一個 mtime 在未來的檔（從壓縮檔解出來、下載自帶未來時間、雙開機時鐘）
  // 會把整個隔離區鎖到一年後，而且沒有任何欄位講得出是哪一個檔。
  Math.min(Math.max(st.ctimeMs, st.mtimeMs), Date.now())

/**
 * 隔離區的統計要快取。
 *
 * `/health` **不需要 token**，而這支是同步的遞迴走訪 —— 4 萬個檔實測 61ms，
 * 那段時間整個事件迴圈是停住的。任何網頁都可以用不帶 Origin 的 `<img>`
 * 連發（它讀不到回應，但請求照樣執行）。隔離區只有 B 的 exec 會改，
 * 十秒的快取完全夠用。
 */
let qCache: { dir: string; at: number; val: QuarantineStats } | null = null
const Q_CACHE_MS = 10_000

/**
 * **搬完檔案一定要呼叫這個。**
 * 不呼叫的話，剛搬進來的檔在接下來十秒內不存在於統計裡 ——
 * 而 canEmptyNow 是用那份統計算的，等於它的七天窗在那十秒裡消失。
 */
export function invalidateQuarantineCache() { qCache = null }

function quarantineStatsCached(dir: string): QuarantineStats {
  if (qCache && qCache.dir === dir && Date.now() - qCache.at < Q_CACHE_MS) return qCache.val
  const val = quarantineStats(dir)
  qCache = { dir, at: Date.now(), val }
  return val
}

function quarantineStats(dir: string): QuarantineStats {
  // 隔離區要等第一次搬檔才會建，所以這是每個新安裝的預設回應。
  // 少一個欄位的話 JSON 出去就整個不見，C 拿 `=== false` 判斷會走錯分支。
  if (!existsSync(dir)) return { items: 0, bytes: 0, oldestAt: null, newestQuarantinedAt: null, truncated: false }
  let items = 0, bytes = 0, oldest: number | null = null, newest: number | null = null
  let truncated = false
  const walk = (d: string, depth: number) => {
    if (depth > MAX_QUARANTINE_DEPTH) { truncated = true; return }
    let entries
    // 讀不到子目錄跟深度截斷對 canEmptyNow 的意義一樣：**我沒有看完**。
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { truncated = true; return }
    for (const e of entries) {
      const p = d + sep + e.name
      if (e.isDirectory()) { walk(p, depth + 1); continue }
      if (!e.isFile()) continue
      try {
        const st = statSync(p)
        items++; bytes += st.size
        if (oldest === null || st.mtimeMs < oldest) oldest = st.mtimeMs
        const qAt = quarantinedAt(st)
        if (newest === null || qAt > newest) newest = qAt
      } catch { truncated = true }
    }
  }
  walk(dir, 0)
  return {
    items, bytes,
    oldestAt: oldest === null ? null : new Date(oldest).toISOString(),
    newestQuarantinedAt: newest === null ? null : new Date(newest).toISOString(),
    truncated,
  }
}

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000

/**
 * 隔離區現在可不可以清空。
 *
 * 抽成純函式是為了**測得到**。留在 healthSnapshot 裡的話，
 * 「超過七天 + 走訪沒看完」這個組合用真實檔案造不出來 ——
 * 新建的檔 ctime 一定是現在，而 quarantinedAt 取 max(ctime, mtime)，
 * 所以 canEmptyAt 永遠在未來，`!truncated` 那個子句永遠碰不到。
 * 突變測試證實了：把 `&& !truncated` 拿掉，整套測試照樣全綠。
 *
 * 等 B 的 cleanup_journal 進來（那裡的 ts 是真的隔離時間，可以是任意過去），
 * 這個組合就會在真實世界出現，而那正是最危險的時候：
 * 讀不到的那個子目錄裡可能有昨天才搬進來的東西。
 */
export function canEmptyNow(
  q: { items: number; truncated: boolean },
  canEmptyAt: string | null,
  now: number = Date.now(),
): boolean {
  if (q.items === 0) return false        // 空的隔離區「可以清空」沒有意義
  if (q.truncated) return false          // 沒看完 → fail closed
  if (!canEmptyAt) return false          // 算不出時間 → fail closed
  return Date.parse(canEmptyAt) <= now
}

/** 後端到底有沒有在運作。**這裡也不可以有絕對路徑。** */
/** 任何一段查詢炸掉都不可以讓整個健康快照少半邊。泛型用函式宣告，箭頭會被當成 JSX。 */
function safe<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
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

  const q = safe(() => quarantineStatsCached(opts.quarantine),
    { items: 0, bytes: 0, oldestAt: null, newestQuarantinedAt: null, truncated: true })
  // **七天窗要看「搬進隔離區的時間」，不是檔案自己的 mtime。**
  //
  // rename／mv 會保留 mtime，而這個工具的目標客群就是「很久沒動的舊檔」——
  // 一個 200 天沒動的 zip 一搬進來，用 mtime 算出來的 canEmptyAt 已經是過去式，
  // 七天反悔期等於不存在。稽查實測過。
  //
  // 而且要看**最新**一次隔離，不是最舊的那一份 —— 只要裡面還有東西不滿七天，
  // 整區就不能清空。
  //
  // 正確的來源是 cleanup_journal 的 ts（B 還沒做）。在那之前用檔案的 ctime
  // （搬移會更新 ctime，Windows 上是建立時間），兩個都拿不到就 fail closed。
  const newest = q.newestQuarantinedAt
  const canEmptyAt = newest ? new Date(Date.parse(newest) + SEVEN_DAYS).toISOString() : null

  const pending = safe(() => (db.prepare(
    `SELECT count(DISTINCT c.item_id) n FROM cleanup_candidates c
     JOIN file_items i ON i.id = c.item_id
     WHERE c.status='proposed' AND c.rule_version = ?
       AND i.status NOT IN ('quarantined','missing','error')`
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
      oldestMtimeAt: q.oldestAt,
      lastQuarantinedAt: q.newestQuarantinedAt,
      canEmptyAt,
      // 空的隔離區「可以清空」沒有意義，而且算不出時間就當不能清（fail closed）
      canEmptyNow: canEmptyNow(q, canEmptyAt),
      truncated: q.truncated,
    },
    pendingCandidates: pending,
    needsHumanCount: errors,
    // lastError 的內容只給帶 token 的 —— 那個欄位設計上會放錯誤訊息，
    // 而這個系統的錯誤字串帶完整路徑（fs 的 message 一律含 path）。
    lastError: full ? lastError : (lastError ? '有，帶 token 才看得到' : null),
  }
}

// ── HTTP ─────────────────────────────────────────────────────

export type RouteCtx = {
  db: DatabaseSync
  roots: string[] | (() => string[])
  quarantine: string
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
 * 清理相關的唯讀 route。**認得就處理並回 true，不認得回 false** 讓下一個接手。
 *
 * apply／undo／dismiss 不在這裡 —— 那些會真的動檔案，是 B 的範圍。
 */
export function cleanupRoutes(ctx: RouteCtx): boolean {
  // **整支包起來。** 不包的話例外會穿到 server.ts 的 catch，那裡回的是
  // 400 + SQLite 原文 —— 伺服器故障卻告訴 C「你打錯了」，而且原文可能帶路徑。
  try { return route(ctx) }
  catch (e: any) {
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
