import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  closeSync,
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { DENY_DIRS, DENY_FILES } from './guard.ts'
import { execRefusesName } from './cleanup-journal.ts'
import {
  CLEANUP_RULE_VERSION,
  PARTIAL_EXT,
  classifyByRules,
  duplicateDraft,
  type CleanupCandidateDraft,
} from './cleanup-rules.ts'

export type CleanupFileStatus = 'new' | 'candidate' | 'kept' | 'quarantined' | 'restored' | 'missing' | 'error'
export type CleanupCandidateStatus = 'proposed' | 'skipped' | 'approved' | 'quarantined' | 'restored' | 'dismissed' | 'error'

export type CleanupFileItem = {
  id: string
  path: string
  name: string
  ext: string
  bytes: number
  sha256: string | null
  mtime: string
  first_seen_at: string
  last_seen_at: string
  status: CleanupFileStatus
  error: string | null
}

export type CleanupCandidate = {
  id: string
  item_id: string
  kind: string
  rule_version: string
  confidence: number
  reason: string
  evidence: string
  status: CleanupCandidateStatus
  created_at: string
}

export type CleanupScanOptions = {
  db: DatabaseSync
  roots: string[]
  maxBytes: number
  now?: Date
  /** 最近還在變動的檔案先不分類，避免把下載到一半的正式檔名搬走。 */
  minStableMs?: number
  maxDepth?: number
  maxFiles?: number
  paths?: string[]
  onProblem?: (msg: string) => void
}

export type CleanupScanResult = {
  scanned: number
  candidates: number
  skipped: number
  errors: number
  truncated: boolean
}

type FileIdentity = {
  dev: number
  ino: number
  size: number
  mtimeMs: number
}

type InspectedFile = FileIdentity & {
  real: string
  name: string
  ext: string
  bytes: number
  mtime: Date
  recent: boolean
  partial: boolean
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0

function fold(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

function under(root: string, p: string): boolean {
  const rel = relative(fold(resolve(root)), fold(resolve(p)))
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

/** 根目錄的比對前綴（原樣與 realpath，結尾帶分隔符號、Windows 摺成小寫）。file_items.path 存的是 realpath。 */
function rootPrefixes(roots: string[]): string[] {
  const out = new Set<string>()
  for (const r of roots) {
    if (!r) continue
    const forms = [resolve(r)]
    try { forms.push(realpathSync(r)) } catch { /* 不存在就只用原樣 */ }
    for (const f of forms) out.add(fold(f.endsWith(sep) ? f : f + sep))
  }
  return [...out]
}

function problem(opts: CleanupScanOptions, msg: string) {
  if (opts.onProblem) opts.onProblem(msg)
}

/**
 * **只有這兩個錯誤碼代表「真的不在了」。**
 *
 * `existsSync` 遇到 EACCES／EPERM／EIO 也回 false —— 同步軟體暫時鎖住資料夾、
 * macOS 還沒授權、網路碟斷一下，都會被當成「使用者刪掉了」。其他錯誤一律當成
 * 「暫時讀不到」：跳過、記 problem，不動資料庫。
 */
export function isGoneError(e: any): boolean {
  return e?.code === 'ENOENT' || e?.code === 'ENOTDIR'
}

function waitForDb<T>(fn: () => T, attempts = 5): T {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try { return fn() }
    catch (e: any) {
      last = e
      if (!/busy|locked/i.test(String(e?.message ?? e))) throw e
    }
  }
  throw last
}

function isDeniedPath(path: string): string | null {
  const segs = path.split(/[\\/]+/).filter(Boolean)
  if (segs.some(s => s.startsWith('.'))) return '隱藏檔或隱藏資料夾'

  const lower = segs.map(s => s.toLowerCase())
  const file = lower[lower.length - 1] ?? ''
  const dirs = lower.slice(0, -1)
  for (const d of dirs) {
    const hit = DENY_DIRS.find(bad => d === bad || (bad.startsWith('.') && d.startsWith(bad)))
    if (hit) return hit
  }
  for (const f of DENY_FILES) {
    if (file === f || file.startsWith(f + '.')) return f
  }
  return null
}

function skipDir(name: string): boolean {
  const n = name.toLowerCase()
  if (n.startsWith('.')) return true
  return DENY_DIRS.some(bad => n === bad || (bad.startsWith('.') && n.startsWith(bad)))
}

export function cleanupWalk(
  root: string,
  maxDepth = 3,
  maxFiles = 5000,
  onDirError?: (dir: string, e: unknown) => void,
): { files: string[]; truncated: boolean } {
  const files: string[] = []
  let truncated = false
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]

  while (stack.length) {
    if (files.length >= maxFiles) { truncated = true; break }
    const cur = stack.pop()!
    let entries
    try { entries = readdirSync(cur.dir, { withFileTypes: true }) }
    catch (e) { if (onDirError) onDirError(cur.dir, e); continue }
    for (const e of entries) {
      const p = join(cur.dir, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        if (cur.depth < maxDepth && !skipDir(e.name)) stack.push({ dir: p, depth: cur.depth + 1 })
        continue
      }
      if (!e.isFile() || e.name.startsWith('.')) continue
      if (files.length >= maxFiles) { truncated = true; break }
      files.push(p)
    }
  }

  return { files, truncated }
}

function inspectPath(path: string, opts: CleanupScanOptions): InspectedFile | { error: string; missing?: boolean } | null {
  let st
  try { st = lstatSync(path) }
  catch (e) {
    return isGoneError(e) ? { error: '檔案不見了', missing: true } : { error: '暫時讀不到這個檔案（沒有權限或磁碟出錯）' }
  }
  if (st.isSymbolicLink()) return null
  if (!st.isFile()) return null

  let real: string
  try { real = realpathSync(path) }
  catch (e) { return isGoneError(e) ? { error: '檔案不見了', missing: true } : { error: 'realpath 失敗' } }

  const roots = opts.roots.map(r => {
    try { return realpathSync(r) } catch { return resolve(r) }
  })
  if (!roots.some(r => under(r, real))) return null

  const denied = isDeniedPath(real)
  if (denied) return null

  let realStat
  try { realStat = lstatSync(real) }
  catch (e) { return isGoneError(e) ? { error: '檔案不見了', missing: true } : { error: '讀不到這個檔案' } }
  if (!realStat.isFile()) return null
  if (realStat.nlink > 1) return { error: '硬鏈結檔案不清理' }

  const nowMs = (opts.now ?? new Date()).getTime()
  const ext = extname(real).toLowerCase()
  return {
    real,
    name: basename(real),
    ext,
    bytes: realStat.size,
    mtime: realStat.mtime,
    recent: nowMs - realStat.mtimeMs < (opts.minStableMs ?? 10 * 60_000),
    partial: PARTIAL_EXT.has(ext),
    dev: realStat.dev,
    ino: realStat.ino,
    size: realStat.size,
    mtimeMs: realStat.mtimeMs,
  }
}

function sha256Of(path: string, expect: FileIdentity): string {
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | NOFOLLOW) }
  catch (e: any) {
    if (e?.code === 'ELOOP' || e?.code === 'EMLINK') throw new Error('檔案在掃描中變成捷徑')
    throw e
  }
  try {
    const st = fstatSync(fd)
    if ((!st.ino && !expect.ino)
        || st.dev !== expect.dev
        || st.ino !== expect.ino
        || st.size !== expect.size
        || st.mtimeMs !== expect.mtimeMs) {
      throw new Error('檔案在掃描中被換掉')
    }
    return createHash('sha256').update(readFileSync(fd)).digest('hex')
  } finally {
    closeSync(fd)
  }
}

function upsertFile(db: DatabaseSync, f: InspectedFile, sha256: string | null, status: CleanupFileStatus, error: string | null, nowIso: string): CleanupFileItem {
  const id = randomUUID()
  waitForDb(() => db.prepare(
    `INSERT INTO file_items (id,path,name,ext,bytes,sha256,mtime,first_seen_at,last_seen_at,status,error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(path) DO UPDATE SET
       name=excluded.name,
       ext=excluded.ext,
       bytes=excluded.bytes,
       sha256=excluded.sha256,
       mtime=excluded.mtime,
       last_seen_at=excluded.last_seen_at,
       status=CASE
         WHEN file_items.status IN ('quarantined') THEN file_items.status
         ELSE excluded.status
       END,
       error=excluded.error`
  ).run(id, f.real, f.name, f.ext, f.bytes, sha256, f.mtime.toISOString(), nowIso, nowIso, status, error))
  return db.prepare(`SELECT * FROM file_items WHERE path=?`).get(f.real) as CleanupFileItem
}

/**
 * 資料庫存的是 realpath。事件給的路徑可能是設定裡的寫法（macOS 的 /var 與
 * /private/var、符號連結的根目錄），所以把幾種可能的寫法都列出來比。
 * 父資料夾整個被刪掉時 realpath(dirname) 會失敗，這時候靠根目錄的 realpath 補。
 */
function knownFormsOf(path: string, roots: string[] = []): string[] {
  const forms = [path, resolve(path)]
  try { forms.push(join(realpathSync(dirname(path)), basename(path))) } catch { /* 父資料夾也不見了就算了 */ }
  for (const root of roots) {
    if (!under(root, path)) continue
    try { forms.push(join(realpathSync(root), relative(resolve(root), resolve(path)))) } catch { /* 根目錄讀不到 */ }
  }
  return [...new Set(forms)]
}

/**
 * 把一條路徑標成 missing。回傳改了幾列。
 *
 * **不動候選。** 檔案的 missing 狀態已經讓清單與建計畫擋掉它；以前這裡把候選
 * 改成 dismissed，而 dismissed 永久保留 —— 檔案只是暫時不在（外接碟、搬出去
 * 又搬回來、非原子存檔），回來之後也永遠不會再被提議。現在檔案回來時
 * upsert 把檔案狀態改回來，候選還是 proposed，自然回到清單。
 *
 * **避開 quarantined。** 跨行程的競態：另一個行程剛把它搬進隔離區，
 * 原路徑當然不在了，那是被搬走，不是不見。
 *
 * watcher 收到刪除事件時直接呼叫這支（見 cleanup-watcher.ts）。
 */
export function markMissing(db: DatabaseSync, path: string, roots: string[] = [], nowIso = new Date().toISOString()): number {
  const forms = knownFormsOf(path, roots)
  const placeholders = forms.map(() => '?').join(',')
  const r = waitForDb(() => db.prepare(
    `UPDATE file_items SET status='missing', error='檔案不見了', last_seen_at=?
     WHERE path IN (${placeholders}) AND status NOT IN ('quarantined','missing')`
  ).run(nowIso, ...forms))
  return Number(r.changes)
}

function upsertCandidate(db: DatabaseSync, itemId: string, draft: CleanupCandidateDraft, nowIso: string): CleanupCandidate {
  const id = randomUUID()
  waitForDb(() => db.prepare(
    `INSERT INTO cleanup_candidates
       (id,item_id,kind,rule_version,confidence,reason,evidence,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(item_id, kind, rule_version) DO UPDATE SET
       confidence=excluded.confidence,
       reason=excluded.reason,
       evidence=excluded.evidence,
       status=CASE
         WHEN cleanup_candidates.status IN ('approved','quarantined','restored','dismissed') THEN cleanup_candidates.status
         ELSE 'proposed'
       END`
  ).run(
    id,
    itemId,
    draft.kind,
    CLEANUP_RULE_VERSION,
    draft.confidence,
    draft.reason,
    draft.evidence,
    'proposed',
    nowIso,
  ))
  return db.prepare(
    `SELECT * FROM cleanup_candidates WHERE item_id=? AND kind=? AND rule_version=?`
  ).get(itemId, draft.kind, CLEANUP_RULE_VERSION) as CleanupCandidate
}

/**
 * 這一輪規則沒再產出的候選，改成 **skipped**。
 *
 * - **不是 dismissed。** dismissed 只留給使用者真的拒絕（upsert 永遠不會把它改回來）。
 *   「規則暫時不成立」—— 檔案剛被改過、還在變動、讀不到 —— 條件回來時候選要能回來，
 *   upsertCandidate 會把 skipped 改回 proposed。
 * - **不碰 duplicate。** 重複檔從來不是 classifyByRules 產出的，由 addDuplicateCandidates 管。
 *   以前這裡把它也算成「規則沒產出」，重複檔候選在第二次掃描就被永久作廢。
 */
function skipStaleCandidates(db: DatabaseSync, itemId: string, keepKinds: string[]) {
  const keep = [...new Set([...keepKinds, 'duplicate'])]
  const placeholders = keep.map(() => '?').join(',')
  waitForDb(() => db.prepare(
    `UPDATE cleanup_candidates SET status='skipped'
     WHERE item_id=? AND rule_version=? AND status='proposed' AND kind NOT IN (${placeholders})`
  ).run(itemId, CLEANUP_RULE_VERSION, ...keep))
}

function setItemStatus(db: DatabaseSync, itemId: string, status: CleanupFileStatus, error: string | null = null) {
  waitForDb(() => db.prepare(
    `UPDATE file_items SET status=?, error=? WHERE id=? AND status != 'quarantined'`
  ).run(status, error, itemId))
}

function candidatesFor(db: DatabaseSync, itemId: string): CleanupCandidate[] {
  return db.prepare(
    `SELECT * FROM cleanup_candidates WHERE item_id=? AND rule_version=? AND status='proposed' ORDER BY confidence DESC, kind`
  ).all(itemId, CLEANUP_RULE_VERSION) as CleanupCandidate[]
}

function fileList(opts: CleanupScanOptions): { files: string[]; truncated: boolean } {
  if (opts.paths) return { files: opts.paths, truncated: false }
  const files: string[] = []
  let truncated = false
  for (const root of opts.roots) {
    // 只給資料夾名稱，不給完整路徑：這句話會經由 POST /cleanup/scan 回到 UI
    if (!existsSync(root)) { problem(opts, `掃描資料夾「${basename(root) || root}」不存在，這次沒有掃。`); continue }
    let rootFailed = false
    let dirsFailed = 0
    const r = cleanupWalk(root, opts.maxDepth ?? 3, opts.maxFiles ?? 5000, dir => {
      if (dir === root) rootFailed = true
      else dirsFailed++
    })
    // 讀不到的資料夾以前是安靜跳過 —— 跟「裡面沒東西」長得一模一樣。
    if (rootFailed) problem(opts, `打不開掃描資料夾「${basename(root)}」（沒有權限？），這次什麼都沒掃到。`)
    if (dirsFailed) problem(opts, `「${basename(root)}」裡有 ${dirsFailed} 個資料夾打不開（沒有權限？），裡面的檔這次沒有掃到。`)
    files.push(...r.files)
    truncated = truncated || r.truncated
  }
  return { files: [...new Set(files)], truncated }
}

/** 大量消失的保險絲：根目錄是空的時候，已知的活檔至少這麼多個才整批不標。 */
export const MASS_MISSING_MIN_KNOWN = 10

/** meta 裡記「這個根目錄上次成功掃描時的 st_dev」的 key。`realRoot` 是 realpath。 */
export function rootDevKey(realRoot: string): string {
  return 'cleanup_root_dev:' + fold(realRoot)
}

const getMeta = (db: DatabaseSync, k: string): string | null =>
  ((db.prepare('SELECT v FROM meta WHERE k=?').get(k) as { v: string } | undefined)?.v) ?? null

const setMeta = (db: DatabaseSync, k: string, v: string) => waitForDb(() =>
  db.prepare('INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v))

/**
 * **全量掃描要對帳：根目錄底下、檔案已經不存在的列，標成 missing。**
 *
 * 上面的迴圈只處理「走訪時看到的」檔。watcher 沒開的期間被刪掉的檔，要靠這裡
 * 才會被標成 missing，不然使用者自己刪掉的檔會一直留在清單上、徽章數字是錯的。
 * 判準是逐列 lstat，不是「這次有沒有走訪到」：走訪有深度與檔數上限。
 *
 * 會錯的地方，每一條都真的發生過（2026-09-19 稽核 RC1 與第一波驗證）：
 * - **只有 ENOENT／ENOTDIR 才算不見。** EACCES、EPERM、EIO 是暫時讀不到，
 *   跳過並記 problem。以前用 existsSync，子資料夾權限被拿掉一次，裡面的檔就永久消失。
 * - **大量消失的保險絲，看「碟」不看比例。** 外接碟沒掛上時掛載點是空的，每個檔都是 ENOENT。
 *   上一版用「會標的 ≥ 50%」判斷，分不出「使用者自己一次刪掉一大半」—— 那些檔就變成
 *   永遠留在清單上的幽靈，每次掃描都說「碟沒掛上？」。現在只在兩種情況整批不標：
 *     1. 根目錄的 st_dev 跟上次成功掃描時不同（換了碟，或碟沒掛上、看到的是底下的空資料夾）
 *     2. 根目錄一個項目都沒有、已知的活檔全部不見、而且已知 ≥ MASS_MISSING_MIN_KNOWN
 *   新的 st_dev 每次都記下來（保險絲跳了也記）：碟真的換了的話，只跳一次，下一次照常對帳；
 *   碟還沒掛上的話，下一次由第 2 條接手。標錯也不會丟資料 —— 候選不動，檔案回來就回到清單。
 * - **前綴在 JS 比。** SQLite 的 substr 數字元、JS 的 length 數 UTF-16，
 *   根目錄名字有 emoji（「下載📥」）的時候兩邊對不上，對帳什麼都不做。
 * - **不動候選、避開 quarantined**：見 markMissing。
 *
 * 單檔模式（watcher 的 paths:[path]）不跑：一次下載就是一串事件，每次都對幾千列
 * 做 stat 是白做工。刪除事件由 watcher 自己呼叫 markMissing。
 */
function reconcileRoot(opts: CleanupScanOptions, given: string, nowIso: string) {
  // file_items.path 存的是 realpath，根目錄要用同一種形式比（macOS 的 /var → /private/var）。
  // 根目錄本身 realpath 不到（不存在、讀不到）就整個跳過 —— fileList 已經報過了。
  let root: string, dev: string
  try { root = realpathSync(given); dev = String(statSync(root).dev) } catch { return }
  const devKey = rootDevKey(root)
  const lastDev = getMeta(opts.db, devKey)
  // 根目錄裡有幾個項目（含隱藏檔與資料夾）。讀不到就是 null：說不出它是不是空的。
  let entries: number | null
  try { entries = readdirSync(root).length } catch { entries = null }

  const prefix = fold(root.endsWith(sep) ? root : root + sep)
  const live = (opts.db.prepare(
    `SELECT path FROM file_items WHERE status NOT IN ('missing','quarantined')`
  ).all() as { path: string }[]).filter(r => fold(r.path).startsWith(prefix))

  const gone: string[] = []
  let unreadable = 0
  for (const r of live) {
    try { lstatSync(r.path) }
    catch (e) {
      if (isGoneError(e)) gone.push(r.path)
      else unreadable++
    }
  }
  const label = basename(root) || root
  if (unreadable) {
    problem(opts, `「${label}」裡有 ${unreadable} 個已知的檔這次讀不到（沒有權限或磁碟出錯），先當成還在。`)
  }
  try {
    if (!gone.length) return
    if (lastDev !== null && lastDev !== dev) {
      problem(opts, `監看資料夾「${label}」跟上次掃描時不在同一顆碟上（換了碟，或外接碟沒掛上？）：`
        + `${live.length} 個已知的檔有 ${gone.length} 個找不到，這次一個都不標成不見。`)
      return
    }
    // 根目錄讀不到：打不開的資料夾 fileList 已經報過了，不猜它是不是空的
    if (entries === null) return
    if (entries === 0 && gone.length === live.length && live.length >= MASS_MISSING_MIN_KNOWN) {
      problem(opts, `監看資料夾「${label}」看起來整個不見了（外接碟沒掛上？）：`
        + `${live.length} 個已知的檔全部找不到、資料夾是空的，這次一個都不標成不見。`)
      return
    }
    for (const p of gone) markMissing(opts.db, p, [], nowIso)
  } finally {
    setMeta(opts.db, devKey, dev)
  }
}

/** meta 裡記「舊資料修復已經跑過」的 key。 */
export const LEGACY_DISMISSED_REPAIR_KEY = 'cleanup_repair_legacy_dismissed_v1'

/**
 * **一次性遷移：舊版掃描器錯誤作廢的候選改回 skipped。**
 *
 * 舊版把「規則這次沒產出」（重複檔第二次掃描、檔案剛被改過、讀不到、碟沒掛上）
 * 一律改成 dismissed，而 dismissed 永久保留 —— 升級之後這些候選還是永遠不會回來
 * （稽核 RC1／RC3 的舊資料）。
 *
 * 分辨方法：**使用者真的拒絕過的，一定經過 dismissPlan**，掛在一份 status='dismissed'
 * 的計畫底下。不在任何 dismissed 計畫裡的 dismissed 候選，就是掃描器自己作廢的，
 * 改成 skipped；這一輪掃描條件還成立的話，upsert 會把它改回 proposed。
 * **release 過的計畫不算**（有 release 標記）：它也停在 dismissed，但意思是「這份卡住了、不要了」，
 * 候選本來就該留著。以前算進去，升級後先 release、才第一次掃描的話，被舊版誤作廢的候選永遠
 * 修不回來（稽核第二輪 R2-12）。
 *
 * meta 記一次，只跑一次（新版不會再產生這種 dismissed）。回傳改了幾列（已經跑過回 0）。
 */
export function repairLegacyDismissed(db: DatabaseSync): number {
  if (getMeta(db, LEGACY_DISMISSED_REPAIR_KEY) !== null) return 0
  // **用 SAVEPOINT，不用 BEGIN。** 呼叫端可能已經在交易裡（CLI 在交易裡呼叫
  // scanDownloads），BEGIN 會丟「cannot start a transaction within a transaction」。
  // SAVEPOINT 在交易內外都能用：外面沒有交易時它自己開一個，有的話就巢狀進去。
  // 兩個行程同時跑：後寫的那個在 WAL 下升級寫鎖會拿到 BUSY，waitForDb 整段重來，
  // 重來時旗標已經有了，直接回 0。
  return waitForDb(() => {
    db.exec('SAVEPOINT repair_legacy_dismissed')
    try {
      // 另一個行程可能剛跑完
      if (getMeta(db, LEGACY_DISMISSED_REPAIR_KEY) !== null) { db.exec('RELEASE repair_legacy_dismissed'); return 0 }
      const r = db.prepare(
        `UPDATE cleanup_candidates SET status='skipped'
          WHERE status='dismissed'
            AND id NOT IN (SELECT pi.candidate_id FROM cleanup_plan_items pi
                             JOIN cleanup_plans p ON p.id = pi.plan_id
                            WHERE p.status = 'dismissed'
                              AND p.id NOT IN (SELECT plan_id FROM cleanup_plan_releases))`
      ).run()
      db.prepare('INSERT INTO meta (k,v) VALUES (?,?)').run(LEGACY_DISMISSED_REPAIR_KEY,
        `${new Date().toISOString()} ${Number(r.changes)}`)
      db.exec('RELEASE repair_legacy_dismissed')
      return Number(r.changes)
    } catch (e) {
      db.exec('ROLLBACK TO repair_legacy_dismissed')
      db.exec('RELEASE repair_legacy_dismissed')
      throw e
    }
  })
}

export function scanDownloads(opts: CleanupScanOptions): CleanupScanResult {
  const now = opts.now ?? new Date()
  const nowIso = now.toISOString()
  const result: CleanupScanResult = { scanned: 0, candidates: 0, skipped: 0, errors: 0, truncated: false }
  // 舊版留下的錯誤作廢要在 upsert 之前改回 skipped，這一輪條件還成立的才會回到 proposed
  repairLegacyDismissed(opts.db)
  const { files, truncated } = fileList(opts)
  result.truncated = truncated
  const touched: string[] = []

  for (const path of files) {
    const inspected = inspectPath(path, opts)
    if (!inspected) { result.skipped++; continue }
    if ('error' in inspected) {
      if (inspected.missing) markMissing(opts.db, path, opts.roots, nowIso)
      problem(opts, `${basename(path)}：${inspected.error}`)
      result.errors++
      continue
    }

    let sha: string | null = null
    let status: CleanupFileStatus = inspected.recent ? 'new' : 'kept'
    let error: string | null = null

    if (inspected.bytes > opts.maxBytes) {
      error = `檔案 ${(inspected.bytes / 1048576).toFixed(1)}MB，超過清理掃描上限`
    } else if (inspected.bytes > 0 && !inspected.partial) {
      try { sha = sha256Of(inspected.real, inspected) }
      catch (e: any) {
        status = 'error'
        error = e?.message ?? '算 sha256 失敗'
        result.errors++
      }
    }

    const item = upsertFile(opts.db, inspected, sha, status, error, nowIso)
    touched.push(item.id)
    result.scanned++

    if (status === 'error' || inspected.recent) {
      skipStaleCandidates(opts.db, item.id, [])
      continue
    }

    const drafts = classifyByRules({
      path: inspected.real,
      name: inspected.name,
      ext: inspected.ext,
      bytes: inspected.bytes,
      mtimeMs: inspected.mtimeMs,
      nowMs: now.getTime(),
      sha256: sha,
    })
    for (const d of drafts) upsertCandidate(opts.db, item.id, d, nowIso)
    skipStaleCandidates(opts.db, item.id, drafts.map(d => d.kind))
    const current = candidatesFor(opts.db, item.id)
    if (current.length) {
      setItemStatus(opts.db, item.id, 'candidate')
      result.candidates += current.length
    } else {
      setItemStatus(opts.db, item.id, error ? 'kept' : 'kept', error)
    }
  }

  // 對帳要在重複檔之前：保留的那份剛被標成不見的話，剩下那份這一輪就不該再是「重複檔」。
  if (!opts.paths) {
    for (const given of opts.roots) reconcileRoot(opts, given, nowIso)
  }

  addDuplicateCandidates(opts.db, nowIso, touched, opts.roots)

  // 只算清單上真的會出現的：候選在 missing 的檔上會留在 proposed（見 markMissing），
  // 不過濾的話刪掉的檔還會算進這個數字。
  result.candidates = (opts.db.prepare(
    `SELECT count(*) n FROM cleanup_candidates c JOIN file_items i ON i.id=c.item_id
     WHERE c.status='proposed' AND c.rule_version=?
       AND i.status NOT IN ('quarantined','missing','error') AND i.error IS NULL`
  ).get(CLEANUP_RULE_VERSION) as { n: number }).n

  return result
}

/**
 * 複本常見的字尾：瀏覽器重下載的 `report (1).pdf`／`report(2).pdf`、Windows 檔案總管的
 * `report - Copy.pdf`／`報告 - 複製.docx`／`報告 - 副本 (2).docx`、macOS Finder 的 `report copy 2.pdf`／
 * `報告 拷貝.docx`／`报告 的副本.docx`；後面可以接一到兩段副檔名（`.tar.gz`）。
 * 字尾前面一定要有空白或破折號：`合約副本.pdf`、`photocopy.pdf` 是原檔自己的名字。
 * 括號裡最多三位數：`Budget (2026).xlsx` 的括號是年份。
 */
const COPY_NAME = /^(?:copy of\s+\S.*|.*\S(?:\s*\(\d{1,3}\)|\s+-\s+(?:copy|副本|複製|复制|複本)(?:\s*\(\d{1,3}\))?|\s+(?:copy|拷貝|拷贝|副本|的副本|複本)(?:\s+\d{1,3})?)(?:\.[^.\s]{1,8}){0,2})$/i

/** 檔名看起來像「另一份的複本」嗎（見 COPY_NAME）。只拿來在重複檔裡挑保留者，不影響任何規則。 */
export function looksLikeCopy(name: string): boolean {
  return COPY_NAME.test(name)
}

/**
 * 重複檔的**保留者排在最前面**。scanner 與路由（evidence 的「會留著 X」）共用這一支，兩邊才會指名同一份。
 *
 * 最早被看到的那份優先；**同時間的（同一輪掃描看到的 —— 第一次掃描時整個資料夾都是同一個時間）
 * 名字不像複本的優先**，再照原本的順序（呼叫端的 SQL 已經照 `first_seen_at, path` 排好，這裡是穩定排序）。
 * 以前平手只比路徑：' ' 排在 '.' 前面，`report (1).pdf` 當保留者，原檔 `report.pdf` 被列成重複
 *（第二輪第二階段；test/cleanup-routes.test.mjs 的 A3 早就記下這個瑕疵）。
 * 名字不在時間之前：先看到 `report (1).pdf`、後來才出現的 `report.pdf` 是比較新的那份。
 */
export function keepersFirst<T extends { first_seen_at: string; name: string }>(rows: T[]): T[] {
  return rows.map((r, i) => ({ r, i, copy: looksLikeCopy(r.name) ? 1 : 0 }))
    .sort((a, b) => (a.r.first_seen_at < b.r.first_seen_at ? -1 : a.r.first_seen_at > b.r.first_seen_at ? 1 : 0)
      || a.copy - b.copy || a.i - b.i)
    .map(x => x.r)
}

/**
 * 重複檔候選**全部由這裡管**：新增、以及不再成立時改成 skipped。
 *
 * - 保留者：同一個 sha256、還活著的檔裡，最早被看到的那份；同時間的名字不像複本的優先，再比路徑
 *   （見 keepersFirst）。其他的是「多出來的」。
 * - 只替這一輪有碰到的檔（onlyItemIds）新增候選 —— 新增要有剛量過的指紋。
 * - 不再是「多出來的」那些（保留者、內容變了、另一份不在了），候選改 **skipped**
 *   而不是 dismissed：之後又變回重複檔時 upsert 會把它改回 proposed。這一步看所有活著的檔，
 *   不限 onlyItemIds —— 保留者被刪掉時，剩下那份不是這一輪碰到的檔，但它已經是唯一的一份。
 *   但**有給 roots 的話只看 roots 底下的候選**（見 skipStaleDuplicates）。
 * - 執行層不收的檔名（`.ini`、`.url`…）不提議；它們可以當保留者（執行層的 keeperPath 不擋檔名）。
 * - 有給 `roots` 的話，**只有這些根目錄底下的檔算數**（當保留者、被提議都是）。
 *   執行層只接受根目錄底下的保留者；舊設定留下的桌面列從來不會被對帳（檔案早就刪了也還是「活的」），
 *   拿它當保留者的話，Downloads 那份會列得出、永遠 NO_DUPLICATE（第一波驗證 v8-keeper-root）。
 *   scanDownloads 一律傳自己的 roots。
 * - **status 是 new 的（十分鐘內還在變動、或 mtime 在未來）不提議、不改成 candidate。**
 *   collect 只列建得了計畫的狀態（排除 new），執行層也一定回 TOO_FRESH；以前這裡無條件
 *   提升，剛下載的重複檔列得出、預設打勾、算進徽章，套用卻一個都搬不動（稽核第二輪 R2-2）。
 *   它不算「多出來的」，身上舊的 proposed 重複檔候選由 skipStaleDuplicates 收成 skipped，
 *   靜置之後重掃時 upsert 會改回 proposed。它還是可以當保留者（執行層會重新量它的指紋）。
 */
export function addDuplicateCandidates(
  db: DatabaseSync, nowIso = new Date().toISOString(), onlyItemIds?: string[], roots?: string[],
) {
  const pre = roots ? rootPrefixes(roots) : null
  const groups = db.prepare(
    `SELECT sha256, count(*) n FROM file_items
     WHERE sha256 IS NOT NULL AND status NOT IN ('quarantined','missing','error')
     GROUP BY sha256 HAVING count(*) > 1`
  ).all() as { sha256: string; n: number }[]

  const only = onlyItemIds ? new Set(onlyItemIds) : null
  const extra = new Set<string>()
  for (const g of groups) {
    const rows = keepersFirst((db.prepare(
      `SELECT * FROM file_items WHERE sha256=? AND status NOT IN ('quarantined','missing','error')
       ORDER BY first_seen_at, path`
    ).all(g.sha256) as CleanupFileItem[]).filter(r => !pre || pre.some(x => fold(r.path).startsWith(x))))
    if (rows.length < 2) continue
    for (const item of rows.slice(1)) {
      if (execRefusesName(item.name) || item.status === 'new') continue
      extra.add(item.id)
      if (only && !only.has(item.id)) continue
      upsertCandidate(db, item.id, duplicateDraft(rows.length), nowIso)
      setItemStatus(db, item.id, 'candidate')
    }
  }
  skipStaleDuplicates(db, extra, pre)
}

/**
 * 活著的檔上、已經不是「多出來那份」的 proposed 重複檔候選 → skipped。
 *
 * `pre`（根目錄前綴）有給的話，**只處理這些根目錄底下的候選**。`extra` 是只用 roots 底下的檔
 * 算出來的，拿它去判斷 roots 外面的候選等於「沒看就說不成立」：兩個呼叫端的 roots 不一樣
 * （CLI 與 server 的設定不同、設定改過）時，同一個候選會被一邊改成 skipped、另一邊改回 proposed，
 * 清單上的檔忽隱忽現（稽核第三波 K5）。roots 外面的候選留給掃那裡的人判斷。
 */
function skipStaleDuplicates(db: DatabaseSync, extra: Set<string>, pre: string[] | null) {
  const stale = (db.prepare(
    `SELECT c.id, c.item_id, i.path FROM cleanup_candidates c JOIN file_items i ON i.id=c.item_id
     WHERE c.kind='duplicate' AND c.rule_version=? AND c.status='proposed'
       AND i.status NOT IN ('quarantined','missing','error')`
  ).all(CLEANUP_RULE_VERSION) as { id: string; item_id: string; path: string }[])
    .filter(r => !extra.has(r.item_id) && (!pre || pre.some(x => fold(r.path).startsWith(x))))
  for (const r of stale) {
    waitForDb(() => db.prepare(`UPDATE cleanup_candidates SET status='skipped' WHERE id=?`).run(r.id))
    // 沒有別的候選了就不再是 candidate
    if (!candidatesFor(db, r.item_id).length) {
      waitForDb(() => db.prepare(`UPDATE file_items SET status='kept' WHERE id=? AND status='candidate'`).run(r.item_id))
    }
  }
}
