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
    if (!existsSync(root)) { problem(opts, `掃描資料夾不存在：${root}`); continue }
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

/** 大量消失的保險絲：已知的活檔至少這麼多個，而且這一輪會標成不見的至少一半，就整批不標。 */
export const MASS_MISSING_MIN_KNOWN = 10

/**
 * **全量掃描要對帳：根目錄底下、檔案已經不存在的列，標成 missing。**
 *
 * 上面的迴圈只處理「走訪時看到的」檔。watcher 沒開的期間被刪掉的檔，要靠這裡
 * 才會被標成 missing，不然使用者自己刪掉的檔會一直留在清單上、徽章數字是錯的。
 * 判準是逐列 lstat，不是「這次有沒有走訪到」：走訪有深度與檔數上限。
 *
 * 會錯的地方，每一條都真的發生過（2026-09-19 稽核 RC1）：
 * - **只有 ENOENT／ENOTDIR 才算不見。** EACCES、EPERM、EIO 是暫時讀不到，
 *   跳過並記 problem。以前用 existsSync，子資料夾權限被拿掉一次，裡面的檔就永久消失。
 * - **大量消失的保險絲。** 外接碟沒掛上時掛載點是空的，每個檔都是 ENOENT。
 *   已知 ≥ MASS_MISSING_MIN_KNOWN 個、而且會標的 ≥ 50% 就整批不標，記一條 problem。
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
  let root: string
  try { root = realpathSync(given) } catch { return }
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
  if (!gone.length) return
  if (live.length >= MASS_MISSING_MIN_KNOWN && gone.length * 2 >= live.length) {
    problem(opts, `監看資料夾「${label}」看起來整個不見了（外接碟沒掛上？）：`
      + `${live.length} 個已知的檔有 ${gone.length} 個找不到，這次一個都不標成不見。`)
    return
  }
  for (const p of gone) markMissing(opts.db, p, [], nowIso)
}

export function scanDownloads(opts: CleanupScanOptions): CleanupScanResult {
  const now = opts.now ?? new Date()
  const nowIso = now.toISOString()
  const result: CleanupScanResult = { scanned: 0, candidates: 0, skipped: 0, errors: 0, truncated: false }
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

  addDuplicateCandidates(opts.db, nowIso, touched)

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
 * 重複檔候選**全部由這裡管**：新增、以及不再成立時改成 skipped。
 *
 * - 保留者：同一個 sha256、還活著的檔裡，最早被看到的那份（同時間比路徑）。其他的是「多出來的」。
 * - 只替這一輪有碰到的檔（onlyItemIds）新增候選 —— 新增要有剛量過的指紋。
 * - 不再是「多出來的」那些（保留者、內容變了、另一份不在了），候選改 **skipped**
 *   而不是 dismissed：之後又變回重複檔時 upsert 會把它改回 proposed。這一步看所有活著的檔，
 *   不限 onlyItemIds —— 保留者被刪掉時，剩下那份不是這一輪碰到的檔，但它已經是唯一的一份。
 * - 執行層不收的檔名（`.ini`、`.url`…）不提議；它們可以當保留者。
 */
export function addDuplicateCandidates(db: DatabaseSync, nowIso = new Date().toISOString(), onlyItemIds?: string[]) {
  const groups = db.prepare(
    `SELECT sha256, count(*) n FROM file_items
     WHERE sha256 IS NOT NULL AND status NOT IN ('quarantined','missing','error')
     GROUP BY sha256 HAVING count(*) > 1`
  ).all() as { sha256: string; n: number }[]

  const only = onlyItemIds ? new Set(onlyItemIds) : null
  const extra = new Set<string>()
  for (const g of groups) {
    const rows = db.prepare(
      `SELECT * FROM file_items WHERE sha256=? AND status NOT IN ('quarantined','missing','error')
       ORDER BY first_seen_at, path`
    ).all(g.sha256) as CleanupFileItem[]
    for (const item of rows.slice(1)) {
      if (execRefusesName(item.name)) continue
      extra.add(item.id)
      if (only && !only.has(item.id)) continue
      upsertCandidate(db, item.id, duplicateDraft(rows.length), nowIso)
      setItemStatus(db, item.id, 'candidate')
    }
  }
  skipStaleDuplicates(db, extra)
}

/** 活著的檔上、已經不是「多出來那份」的 proposed 重複檔候選 → skipped。 */
function skipStaleDuplicates(db: DatabaseSync, extra: Set<string>) {
  const stale = (db.prepare(
    `SELECT c.id, c.item_id FROM cleanup_candidates c JOIN file_items i ON i.id=c.item_id
     WHERE c.kind='duplicate' AND c.rule_version=? AND c.status='proposed'
       AND i.status NOT IN ('quarantined','missing','error')`
  ).all(CLEANUP_RULE_VERSION) as { id: string; item_id: string }[]).filter(r => !extra.has(r.item_id))
  for (const r of stale) {
    waitForDb(() => db.prepare(`UPDATE cleanup_candidates SET status='skipped' WHERE id=?`).run(r.id))
    // 沒有別的候選了就不再是 candidate
    if (!candidatesFor(db, r.item_id).length) {
      waitForDb(() => db.prepare(`UPDATE file_items SET status='kept' WHERE id=? AND status='candidate'`).run(r.item_id))
    }
  }
}
