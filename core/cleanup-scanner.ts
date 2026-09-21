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
  BURST_CONFIDENCE,
  BURST_RULE_VERSION,
  CLEANUP_RULE_VERSION,
  PARTIAL_EXT,
  burstDraft,
  sameTextDraft,
  classifyByRules,
  duplicateDraft,
  type CleanupCandidateDraft,
} from './cleanup-rules.ts'
import { decodePngGray } from './png.ts'
import { fileTextFresh, putFileText, sweepFileTexts } from './file-texts.ts'
import { TEXT_REASON, kindOfExt, textReader, type TextReader } from './read-text.ts'
import { UntitledError, classifyName } from './untitled.ts'
import {
  DEFAULT_MAX_GAP_MS,
  burstGroups,
  dHash,
  fineSig,
  type BurstGroup,
  type BurstItem,
  type BurstOptions,
  type GrayImage,
} from './imagehash.ts'

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
  /** 幾天內動過的檔一律不提議（cleanup.protectDays，預設 14）。沒給就用規則層的預設。 */
  protectDays?: number
  now?: Date
  /** 最近還在變動的檔案先不分類，避免把下載到一半的正式檔名搬走。 */
  minStableMs?: number
  maxDepth?: number
  maxFiles?: number
  paths?: string[]
  onProblem?: (msg: string) => void
  /**
   * 讀文件內容的 worker。**只有測試會換掉** —— 要重現逾時、worker 連續死掉，
   * 得有一個故意壞掉的 worker（見 core/read-text.ts 的 createTextReader）。
   * 沒給的話，第一次真的要讀的時候才會開整個行程共用的那一個。
   */
  textReader?: TextReader
}

export type CleanupScanResult = {
  scanned: number
  candidates: number
  skipped: number
  errors: number
  truncated: boolean
  /**
   * 這一輪還沒算到指紋的圖還有幾張（一批最多 MAX_IMAGE_BATCH 張，見那個常數）。
   * 0 表示都算完了；> 0 的話下一輪掃描會接著算，呼叫端可以照這個數字決定要不要早一點再掃一次。
   */
  imagesPending: number
  /**
   * 這一輪還沒讀內容的文件檔還有幾個（一批最多 MAX_TEXT_BATCH 個，見那個常數）。
   * 跟 imagesPending 同一個意思：0 表示都讀完了，> 0 的話下一輪接著讀。
   */
  textsPending: number
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
  if (segs.some(s => s.startsWith('.'))) return 'a hidden file or folder'

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
    return isGoneError(e) ? { error: 'the file is gone', missing: true } : { error: 'cannot read this file right now (no permission, or a disk error)' }
  }
  if (st.isSymbolicLink()) return null
  if (!st.isFile()) return null

  let real: string
  try { real = realpathSync(path) }
  catch (e) { return isGoneError(e) ? { error: 'the file is gone', missing: true } : { error: 'realpath failed' } }

  const roots = opts.roots.map(r => {
    try { return realpathSync(r) } catch { return resolve(r) }
  })
  if (!roots.some(r => under(r, real))) return null

  const denied = isDeniedPath(real)
  if (denied) return null

  let realStat
  try { realStat = lstatSync(real) }
  catch (e) { return isGoneError(e) ? { error: 'the file is gone', missing: true } : { error: 'cannot read this file' } }
  if (!realStat.isFile()) return null
  if (realStat.nlink > 1) return { error: 'hard-linked files are never cleaned' }

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

/** PNG 的簽章。**看內容不看副檔名**：`.png` 其實是 JPEG 的解不開，真的 PNG 叫什麼名字都算。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const looksLikePng = (buf: Buffer): boolean =>
  buf.length >= PNG_SIGNATURE.length && buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)

/**
 * 算 sha256，順便說一聲「這個檔的內容是不是 PNG」。
 *
 * **指紋要用的位元組就是這裡讀進來的這一份**：掃描本來就要把整個檔讀一遍算 sha256，
 * 再開一次檔只為了看前 8 個位元組，等於讓每一個檔（絕大多數不是圖）多付一次 I/O。
 * 不是 PNG 的檔只多一次 8 位元組的比較，`png` 是 null，那一份 Buffer 立刻可以回收。
 */
function sha256Of(path: string, expect: FileIdentity): { sha256: string; png: Buffer | null } {
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | NOFOLLOW) }
  catch (e: any) {
    if (e?.code === 'ELOOP' || e?.code === 'EMLINK') throw new Error('the file turned into a symlink mid-scan')
    throw e
  }
  try {
    const st = fstatSync(fd)
    if ((!st.ino && !expect.ino)
        || st.dev !== expect.dev
        || st.ino !== expect.ino
        || st.size !== expect.size
        || st.mtimeMs !== expect.mtimeMs) {
      throw new Error('the file was swapped out mid-scan')
    }
    const buf = readFileSync(fd)
    return { sha256: createHash('sha256').update(buf).digest('hex'), png: looksLikePng(buf) ? buf : null }
  } finally {
    closeSync(fd)
  }
}

/**
 * 檔名有沒有取名（untitled／generic／named）＋理由，見 core/untitled.ts。
 *
 * **只標記，不改名**（預想表倒數第三列）：改名是 P3 的事，而且要可復原。
 * 檔名是不可信的輸入 —— untitled.ts 對不是字串、超長的輸入會丟錯，
 * 接住當成「拿不準」（generic），不要讓一個怪檔名讓整輪掃描失敗。
 */
function namingOf(name: string): { state: string; why: string } {
  try {
    const c = classifyName(name)
    return { state: c.state, why: c.reason }
  } catch (e) {
    const why = e instanceof UntitledError ? 'the name does not look like a normal file name, so this is a guess' : 'something went wrong reading the name, so this is a guess'
    return { state: 'generic', why }
  }
}

function upsertFile(db: DatabaseSync, f: InspectedFile, sha256: string | null, status: CleanupFileStatus, error: string | null, nowIso: string): CleanupFileItem {
  const id = randomUUID()
  // 取名的判斷跟著 name 一起寫進去：它只看檔名，不多一次寫入（掃 1000 個檔就是省 1000 次）
  const nm = namingOf(f.name)
  waitForDb(() => db.prepare(
    `INSERT INTO file_items (id,path,name,ext,bytes,sha256,mtime,first_seen_at,last_seen_at,status,error,naming,naming_why)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
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
       error=excluded.error,
       naming=excluded.naming,
       naming_why=excluded.naming_why`
  ).run(id, f.real, f.name, f.ext, f.bytes, sha256, f.mtime.toISOString(), nowIso, nowIso, status, error, nm.state, nm.why))
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
    `UPDATE file_items SET status='missing', error='the file is gone', last_seen_at=?
     WHERE path IN (${placeholders}) AND status NOT IN ('quarantined','missing')`
  ).run(nowIso, ...forms))
  return Number(r.changes)
}

function upsertCandidate(
  db: DatabaseSync, itemId: string, draft: CleanupCandidateDraft, nowIso: string,
  ruleVersion: string = CLEANUP_RULE_VERSION,
): CleanupCandidate {
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
    ruleVersion,
    draft.confidence,
    draft.reason,
    draft.evidence,
    'proposed',
    nowIso,
  ))
  return db.prepare(
    `SELECT * FROM cleanup_candidates WHERE item_id=? AND kind=? AND rule_version=?`
  ).get(itemId, draft.kind, ruleVersion) as CleanupCandidate
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
    if (!existsSync(root)) { problem(opts, `The scan folder “${basename(root) || root}” does not exist, so it was not scanned.`); continue }
    let rootFailed = false
    let dirsFailed = 0
    const r = cleanupWalk(root, opts.maxDepth ?? 3, opts.maxFiles ?? 5000, dir => {
      if (dir === root) rootFailed = true
      else dirsFailed++
    })
    // 讀不到的資料夾以前是安靜跳過 —— 跟「裡面沒東西」長得一模一樣。
    if (rootFailed) problem(opts, `Could not open the scan folder “${basename(root)}” (no permission?), so nothing in it was scanned.`)
    if (dirsFailed) problem(opts, `${dirsFailed} ${dirsFailed === 1 ? 'folder' : 'folders'} inside “${basename(root)}” could not be opened (no permission?), so the files in ${dirsFailed === 1 ? 'it' : 'them'} were not scanned.`)
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
    problem(opts, `${unreadable} known files in “${label}” could not be read this time (no permission, or a disk error), so they are still treated as present.`)
  }
  try {
    if (!gone.length) return
    if (lastDev !== null && lastDev !== dev) {
      problem(opts, `The watched folder “${label}” is not on the same disk as last scan (swapped disks, or an external drive not mounted?): `
        + `${gone.length} of its ${live.length} known files are missing, so none were marked gone this time.`)
      return
    }
    // 根目錄讀不到：打不開的資料夾 fileList 已經報過了，不猜它是不是空的
    if (entries === null) return
    if (entries === 0 && gone.length === live.length && live.length >= MASS_MISSING_MIN_KNOWN) {
      problem(opts, `The watched folder “${label}” looks like it vanished entirely (an external drive not mounted?): `
        + `all ${live.length} known files are missing and the folder is empty, so none were marked gone this time.`)
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

// ── 連拍截圖：指紋、分組、候選 ───────────────────────────────

/**
 * 一批最多算幾張長相指紋。
 *
 * 1280×720 一張約 15 ms（解 PNG ＋ dHash ＋ 細比對縮圖），120 張約 2 秒 —— 掃描是同步的，
 * 再多就會卡住寵物。剩下的留到下一輪：算過的有快取，下一輪自然接著算沒算到的那些，
 * 而 `scanDownloads` 的回傳會講還剩幾張（`imagesPending`）。
 */
export const MAX_IMAGE_BATCH = 120

/**
 * 連拍分組一次最多幾張。兩個用途：
 *   1. 上游丟 TOO_MUCH_WORK 時照這個張數切開重試（預想表第 48 列）。
 *   2. 一段時間窗裡的圖太多時，先照這個張數切開再載入細比對資料（見 MAX_FINE_BYTES）。
 * 切點兩邊的兩張不會同組 —— 只會少問，不會誤清。
 */
export const BURST_CHUNK = 300
/** 對半切到這麼少還是太重就放棄那一小段（只會少問，不會誤清）。 */
export const BURST_MIN_CHUNK = 16

/** 一次握在手上的細比對資料上限。超過就先切段（1280×720 一張約 230 KB、4K 約 518 KB）。 */
const MAX_FINE_BYTES = 64 * 1024 * 1024

/** 一段時間窗裡最多幾張一起比（再多先切段，跟 MAX_FINE_BYTES 取先到的那個）。 */
const MAX_SEGMENT_ITEMS = 1000

type ImageBatch = { hashed: number; pending: number }

/**
 * 算一張圖的長相指紋，存進 `cleanup_image_sigs`。
 *
 * - **快取先看**：算的時候的 size 與 mtime 跟現在的檔都一樣就什麼都不做（不算進這一批的額度）。
 *   任一個不同就重算 —— mtime 精度只到毫秒，同一秒內改內容而大小一樣的話只看 mtime 會漏掉。
 * - **一批有上限**：額度用完就記一筆「還沒算」，留到下一輪。
 * - **算不出來的跳過**，記一條**只有檔名**的問題，整批掃描照常完成（預想表第 47 列）。
 *   舊的（現在對不上的）那一列一起刪掉，免得檔案改回原來的大小與時間時又被當成有效的快取。
 */
function ensureImageSig(
  opts: CleanupScanOptions, itemId: string, f: InspectedFile, png: Buffer, nowIso: string, batch: ImageBatch,
): void {
  const db = opts.db
  const mtime = f.mtime.toISOString()
  const row = db.prepare('SELECT size, mtime FROM cleanup_image_sigs WHERE item_id=?').get(itemId) as
    { size: number; mtime: string } | undefined
  if (row && Number(row.size) === f.bytes && row.mtime === mtime) return
  if (batch.hashed >= MAX_IMAGE_BATCH) { batch.pending++; return }
  batch.hashed++

  let hash: string
  let fine: { w: number; h: number; px: Uint8Array }
  let width: number, height: number
  try {
    // decodePngGray 每次都配一塊新的灰階陣列，算完就放掉（只有 dHash 與細比對縮圖留下來）
    const img = decodePngGray(png)
    width = img.width
    height = img.height
    hash = dHash(img)
    fine = fineSig(img)
  } catch {
    problem(opts, `${f.name}: could not open this image, so no look-alike fingerprint was computed.`)
    waitForDb(() => db.prepare('DELETE FROM cleanup_image_sigs WHERE item_id=?').run(itemId))
    return
  }

  waitForDb(() => db.prepare(
    `INSERT INTO cleanup_image_sigs (item_id,width,height,size,mtime,hash,fine_w,fine_h,fine,at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(item_id) DO UPDATE SET
       width=excluded.width, height=excluded.height, size=excluded.size, mtime=excluded.mtime,
       hash=excluded.hash, fine_w=excluded.fine_w, fine_h=excluded.fine_h, fine=excluded.fine, at=excluded.at`
  ).run(itemId, width, height, f.bytes, mtime, hash, fine.w, fine.h, fine.px, nowIso))
}

/** file_items 已經不在的列跟著清掉（指紋與連拍組都是）。完整掃描的對帳一起做。 */
/**
 * 收掉不再需要的長相指紋。**這一支不可以只看「file_items 還在不在」**：
 * 這個專案從來不刪 file_items 的列（檔案不見時只改成 status='missing'），所以那個條件永遠不成立，
 * 指紋就會一輩子留著 —— 每張 720p 截圖 225 KB、4K 518 KB，一年 2000 張約 450 MB（P0 驗證員）。
 *
 * 收的條件有三個：
 * 1. 對應的 file_items 不在了（理論上不會發生，留著當保險）
 * 2. 檔案已經不在原位（missing、quarantined）—— 放回來會重算，成本是一次解碼
 * 3. 超過上限（MAX_IMAGE_SIGS）時，留最近算的那些
 */
export const MAX_IMAGE_SIGS = 5000

function sweepImageSigs(db: DatabaseSync) {
  waitForDb(() => {
    db.exec(
      `DELETE FROM cleanup_image_sigs WHERE item_id NOT IN (SELECT id FROM file_items);
       DELETE FROM cleanup_image_sigs WHERE item_id IN
         (SELECT id FROM file_items WHERE status IN ('missing','quarantined'));
       DELETE FROM cleanup_burst_members
        WHERE item_id NOT IN (SELECT id FROM file_items) OR keep_id NOT IN (SELECT id FROM file_items);`
    )
    db.prepare(
      `DELETE FROM cleanup_image_sigs WHERE item_id IN (
         SELECT item_id FROM cleanup_image_sigs ORDER BY at DESC, item_id LIMIT -1 OFFSET ?)`
    ).run(MAX_IMAGE_SIGS)
  })
}

// ── 文件的內容：讀出來存進 file_texts ────────────────────────

/**
 * 一批最多讀幾個沒讀過的檔。
 *
 * 每個檔在 worker 裡最多 5 秒（讀得懂的講義是幾毫秒到幾十毫秒），60 個是一個
 * 「正常情況下幾秒、最壞情況下不會沒完沒了」的數字。剩下的留到下一輪：讀過的有快取，
 * 下一輪自然接著讀沒讀到的那些，而 `scanDownloads` 的回傳會講還剩幾個（`textsPending`）。
 */
export const MAX_TEXT_BATCH = 60

/**
 * worker 連續死幾次就放棄這一輪。
 *
 * 一次死掉是「這個檔有問題」，連續三次比較像是「這台機器現在開不了 worker」
 * （記憶體吃緊、thread 開不出來）。再硬試下去只是每個檔各賠 5 秒。
 */
export const MAX_WORKER_DEATHS = 3

type TextBatch = {
  /** 這一輪已經處理幾個沒讀過的檔 */
  read: number
  /** 還剩幾個沒處理 */
  pending: number
  /** worker 連續死幾次 */
  deaths: number
  /** 已經放棄這一輪了 */
  off: boolean
  /** 這一輪有幾個檔**真的讀不懂**（壞掉、加密、不認得的格式、逾時）——
      只用來報一條總結，不逐檔洗版。**不含「太大」**，見 tooLarge。 */
  unreadable: number
  /**
   * 這一輪有幾個檔**因為超過 maxBytes 所以沒讀**。
   *
   * **跟 unreadable 分開算**（2026-09-21 使用者實機回報）。以前併在一起，
   * 畫面上就長出這一句：
   *
   *   ⚠ The last scan reported 1 problems, so some files may have been missed:
   *     2 files could not be made sense of…
   *
   * 三個地方都不對：它不是「讀不懂」（是我們照設定拒絕讀）、檔案沒有「被漏掉」
   *（照樣掃到、照樣進候選清單，只是沒抽文字），而且它**永遠不會變好** ——
   * 那幾個 21–35 MB 的 PDF 每一次掃描都會再警告一次，變成永久的雜訊。
   *
   * 太大是一個**政策結果**，不是問題。有需要就把 maxBytes 調高。
   */
  tooLarge: number
  reader: TextReader | null
}

/**
 * 讀一個檔的文字，存進 `file_texts`。
 *
 * - **副檔名決定要不要試**（.txt／.md／.csv／.docx／.pptx／.pdf），不在清單裡的完全不碰，
 *   連查資料庫都不查 —— 沒有文件類檔案的資料夾，掃描時間不可以因為這個功能變慢。
 * - **快取先看**：讀的時候的 size 與 mtime 跟現在的檔都一樣就什麼都不做。
 *   讀不懂的檔也記在同一張表，所以 size／mtime 沒變就不會每一輪再試一次。
 * - **讀之前先看大小**：超過 maxBytes 不讀（reason「太大」）。worker 的 heap 上限管不到
 *   heap 外的記憶體，而 PDF 的輸入本身約佔檔案大小 ×2（見 pdf-text.ts 的檔頭）。
 * - **worker 死掉不是掃描失敗**：那個檔記成看不懂（reason「逾時」），掃描照常完成；
 *   連續 MAX_WORKER_DEATHS 次就這一輪不再讀內容，並記一條 problem。
 */
function ensureFileText(
  opts: CleanupScanOptions, itemId: string, f: InspectedFile, nowIso: string, batch: TextBatch,
): void {
  const kind = kindOfExt(f.ext)
  if (kind === null) return
  const db = opts.db
  const mtime = f.mtime.toISOString()
  if (fileTextFresh(db, itemId, f.bytes, mtime)) return
  if (batch.off || batch.read >= MAX_TEXT_BATCH) { batch.pending++; return }
  batch.read++

  const put = (row: {
    text: string | null; chars: number; truncated: boolean; hasText: boolean
    pages: number | null; unmapped: number | null; reason: string | null
  }) => waitForDb(() => putFileText(db, {
    item_id: itemId,
    kind,
    text: row.text,
    chars: row.chars,
    truncated: row.truncated ? 1 : 0,
    has_text: row.hasText ? 1 : 0,
    pages: row.pages,
    unmapped: row.unmapped,
    reason: row.reason,
    size: f.bytes,
    mtime,
    at: nowIso,
  }))

  if (f.bytes > opts.maxBytes) {
    put({ text: null, chars: 0, truncated: false, hasText: false, pages: null, unmapped: null, reason: TEXT_REASON.tooLarge })
    // **太大不算「讀不懂」**：那是照設定拒絕讀，不是失敗（見 TextBatch.tooLarge）
    batch.tooLarge++
    return
  }
  if (f.bytes === 0) {
    // 空檔不是錯：就是沒有文字層
    put({ text: '', chars: 0, truncated: false, hasText: false, pages: null, unmapped: null, reason: null })
    return
  }

  if (!batch.reader) batch.reader = opts.textReader ?? textReader()
  const got = batch.reader.read({
    path: f.real, kind, dev: f.dev, ino: f.ino, size: f.size, mtimeMs: f.mtimeMs,
  })
  if (got.status === 'dead') {
    batch.deaths++
    // 這個檔把 worker 弄死了（卡住、吃爆記憶體）→ 記在它身上，下一輪不用再試。
    // **開不起來（blame env）不記**：那是環境的事，記下去會把幾個好檔永久標成讀不到（P1 驗證員）。
    if (got.blame !== 'env') {
      put({ text: null, chars: 0, truncated: false, hasText: false, pages: null, unmapped: null, reason: got.reason })
    }
    batch.unreadable++
    if (batch.deaths >= MAX_WORKER_DEATHS) {
      batch.off = true
      // 只講次數，不講檔名也不講資料夾
      problem(opts, `The background worker that reads file contents failed ${MAX_WORKER_DEATHS} times in a row, so this scan stopped reading contents.`)
    }
    return
  }
  batch.deaths = 0
  if (got.status === 'changed') {
    // 掃描到現在檔案被換掉了：這一輪什麼都不記（下一輪會看到新的 size／mtime）
    batch.read--
    return
  }
  if (got.status === 'unreadable') {
    put({ text: null, chars: 0, truncated: false, hasText: false, pages: null, unmapped: null, reason: got.reason })
    batch.unreadable++
    return
  }
  put({
    text: got.text,
    chars: got.chars,
    truncated: got.truncated,
    hasText: got.hasText,
    pages: got.pages,
    unmapped: got.unmapped,
    reason: null,
  })
}

const isTooMuchWork = (e: any): boolean => e?.code === 'TOO_MUCH_WORK'

/**
 * 分組，**接住 TOO_MUCH_WORK**：先整批試一次，丟錯就照張數切成每段 BURST_CHUNK 張重試
 * （預想表第 48 列）。切完還是丟錯的那一段記一條問題就跳過 —— 少問幾張，不讓整批掃描失敗。
 *
 * `run` 只有測試會換掉（要重現上游丟 TOO_MUCH_WORK 得先做出上億單位的工作量）。
 */
export function burstGroupsChunked(
  items: BurstItem[],
  opts: BurstOptions,
  run: (items: BurstItem[], opts: BurstOptions) => BurstGroup[] = burstGroups,
  onProblem?: (msg: string) => void,
): BurstGroup[] {
  try { return run(items, opts) }
  catch (e: any) { if (!isTooMuchWork(e)) throw e }
  const tooMuch = (n: number) => {
    // 只講張數，不講檔名也不講資料夾
    if (onProblem) onProblem(`Comparing ${n} images for bursts is too much work, so they were not compared this time.`)
  }
  // **對半切到切不動為止**。以前是「超過 300 張才切」，但上游的記憶體分段本來就把每一段壓在
  // 291 張以下（常見截圖尺寸），所以那條路永遠走不到：整段的連拍組被靜默丟掉，而且每一次掃描
  // 都重報一次問題、寵物永遠擔心（P0 驗證員）。切到剩 BURST_MIN_CHUNK 張還是太重才放棄。
  const out: BurstGroup[] = []
  const attempt = (part: BurstItem[]): void => {
    if (part.length < 2) return
    try { out.push(...run(part, opts)); return }
    catch (e: any) { if (!isTooMuchWork(e)) throw e }
    if (part.length <= BURST_MIN_CHUNK) { tooMuch(part.length); return }
    const half = Math.ceil(part.length / 2)
    // 切點兩邊的兩張不會同組：只會少問，不會誤清
    attempt(part.slice(0, half))
    attempt(part.slice(half))
  }
  for (let i = 0; i < items.length; i += BURST_CHUNK) attempt(items.slice(i, i + BURST_CHUNK))
  return out
}

type BurstRow = {
  id: string
  name: string
  path: string
  mtime: string
  bytes: number
  width: number
  height: number
  fine_w: number
  fine_h: number
}

/** 0–1 的相對座標，小數留六位（面板照比例畫，後端不外流原圖以外的東西）。 */
const rel = (v: number, size: number): number => {
  const x = size > 0 ? v / size : 0
  return Math.min(1, Math.max(0, Math.round(x * 1e6) / 1e6))
}

/**
 * 讀一張圖現在的灰階。**每一次都是新配的緩衝**：上游的已知限制是兩張共用同一塊記憶體時
 * 會把內容不同的兩張判成 same，所以這裡絕對不可以快取或重複使用輸出緩衝。
 * 檔案的大小或 mtime 跟指紋對不上（算完之後又被改過）就回 null —— 指紋是舊的，
 * 這一對只會被判 similar（安全的方向），下一輪重算指紋之後再說。
 */
function loadGrayAt(path: string, size: number, mtimeIso: string, width: number, height: number): GrayImage | null {
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | NOFOLLOW) }
  catch { return null }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size !== size || st.mtime.toISOString() !== mtimeIso) return null
    const buf = readFileSync(fd)
    if (!looksLikePng(buf)) return null
    const img = decodePngGray(buf)
    if (img.width !== width || img.height !== height) return null
    return img
  } catch { return null }
  finally { closeSync(fd) }
}

/**
 * **連拍分組與候選。** 完整掃描的最後一步（單檔模式不跑，見 scanDownloads）。
 *
 * 範圍（預想表第 38 列）：只看清理範圍底下、status 是 new／candidate／kept 的檔，
 * 而且**同一個資料夾裡**才成組 —— 跨資料夾的搬走之後邏輯會複雜，使用者的心智模型也是
 * 「這個資料夾裡」。指紋對不上現在的檔（size 或 mtime 變了）的不算數。
 *
 * 時間（第 35 列）：用 mtime，不看檔名。同一個資料夾裡先照時間排好，
 * 相鄰兩張相隔超過時間窗的地方切開 —— 跨過那種空檔的兩張本來就不可能同組，
 * 結果一樣，但一次握在手上的細比對資料少很多。
 *
 * 候選（第 39～41 列）：每一組除了留下的那張，其他成員各一個 screenshot-noise／burst-1 候選，
 * same 70、similar 40。**留下的那張永遠沒有候選。** 組散掉的（剩一張、或不再成組）走 skipped ——
 * 跟重複檔一樣，條件回來時 upsert 會把它改回 proposed。
 *
 * 範圍外的列**不碰**（稽核第三波 K5 的教訓）：兩個呼叫端的 roots 不一樣時，
 * 同一筆會被一邊作廢、另一邊改回來，清單上的檔忽隱忽現。`/cleanup/bursts` 自己也照
 * 呼叫端的清理範圍過濾，所以範圍縮小之後那些組不會出現在畫面上。
 */
function wireBursts(opts: CleanupScanOptions, nowIso: string) {
  const db = opts.db
  const pre = rootPrefixes(opts.roots)
  if (!pre.length) return
  const inScope = (p: string) => pre.some(x => fold(p).startsWith(x))

  const rows = (db.prepare(
    `SELECT i.id, i.name, i.path, i.mtime, i.bytes, s.width, s.height, s.fine_w, s.fine_h
       FROM cleanup_image_sigs s JOIN file_items i ON i.id = s.item_id
      -- **不收 status='new'（十分鐘內還在變動的）**：那種建不了計畫（createPlan 只收
      -- candidate／kept／restored），分了組、勾得起來、按下去卻是 STALE_CANDIDATE。
      -- 剛截的那一批等下一次掃描（檔案靜置之後）再分組，晚幾分鐘問而已。
      WHERE i.status IN ('candidate','kept','restored')
        AND s.size = i.bytes AND s.mtime = i.mtime
      ORDER BY i.mtime, i.id`
  ).all() as BurstRow[]).filter(r => inScope(r.path))

  // 同一個資料夾一桶，桶裡照時間排好（SQL 已經排過，這裡是穩定的分桶）
  const byDir = new Map<string, BurstRow[]>()
  for (const r of rows) {
    const t = Date.parse(r.mtime)
    if (!Number.isFinite(t)) continue
    const key = fold(dirname(r.path))
    const bucket = byDir.get(key)
    if (bucket) bucket.push(r)
    else byDir.set(key, [r])
  }

  const byId = new Map(rows.map(r => [r.id, r]))

  const loadGray = (id: string): GrayImage | null => {
    const r = byId.get(id)
    if (!r) return null
    return loadGrayAt(r.path, Number(r.bytes), r.mtime, r.width, r.height)
  }
  const burstOpts: BurstOptions = { maxGapMs: DEFAULT_MAX_GAP_MS, loadGray }

  const itemsOf = (part: BurstRow[]): BurstItem[] => {
    const holes = part.map(() => '?').join(',')
    const sigs = db.prepare(
      `SELECT item_id, hash, fine_w, fine_h, fine FROM cleanup_image_sigs WHERE item_id IN (${holes})`
    ).all(...part.map(r => r.id)) as { item_id: string; hash: string; fine_w: number; fine_h: number; fine: Uint8Array }[]
    const sig = new Map(sigs.map(x => [x.item_id, x]))
    const out: BurstItem[] = []
    for (const r of part) {
      const x = sig.get(r.id)
      if (!x) continue
      out.push({
        id: r.id,
        takenAt: Date.parse(r.mtime),
        width: r.width,
        height: r.height,
        hash: String(x.hash),
        // 每一張都是自己的一塊記憶體（上游要求兩張的細比對資料不可以共用）
        fine: { w: Number(x.fine_w), h: Number(x.fine_h), px: new Uint8Array(x.fine) },
      })
    }
    return out
  }

  const found: BurstGroup[] = []
  const runPart = (part: BurstRow[]) => {
    if (part.length < 2) return
    found.push(...burstGroupsChunked(itemsOf(part), burstOpts, burstGroups,
      msg => problem(opts, msg)))
  }
  /** 一段時間窗：再照張數與細比對資料的大小切開（記憶體有上限），然後才載入。 */
  const runSegment = (seg: BurstRow[]) => {
    if (seg.length < 2) return
    let part: BurstRow[] = []
    let bytes = 0
    for (const r of seg) {
      const cost = Math.max(1, r.fine_w * r.fine_h)
      if (part.length && (part.length >= MAX_SEGMENT_ITEMS || bytes + cost > MAX_FINE_BYTES)) {
        runPart(part)
        part = []
        bytes = 0
      }
      part.push(r)
      bytes += cost
    }
    runPart(part)
  }

  for (const bucket of byDir.values()) {
    if (bucket.length < 2) continue
    let seg: BurstRow[] = []
    for (const r of bucket) {
      if (seg.length && Date.parse(r.mtime) - Date.parse(seg[seg.length - 1].mtime) > DEFAULT_MAX_GAP_MS) {
        runSegment(seg)
        seg = []
      }
      seg.push(r)
    }
    runSegment(seg)
  }

  // ── 寫回：這一輪的組是正本 ──────────────────────────────
  const members: { itemId: string; groupId: string; keepId: string; level: string; boxes: string }[] = []
  const drops = new Map<string, { keepName: string; level: 'same' | 'similar'; gapSec: number }>()
  for (const g of found) {
    const keep = byId.get(g.keep)
    if (!keep) continue
    const groupId = burstGroupId(g.keep, g.drop)
    members.push({ itemId: keep.id, groupId, keepId: keep.id, level: g.level, boxes: '[]' })
    for (const m of g.members) {
      const row = byId.get(m.id)
      if (!row) continue
      const boxes = m.boxes.map(b => ({
        x: rel(b.x, row.width), y: rel(b.y, row.height),
        w: rel(b.w, row.width), h: rel(b.h, row.height),
      }))
      members.push({ itemId: row.id, groupId, keepId: keep.id, level: m.level, boxes: JSON.stringify(boxes) })
      drops.set(row.id, {
        keepName: keep.name,
        level: m.level,
        gapSec: Math.max(0, Math.round(Math.abs(Date.parse(keep.mtime) - Date.parse(row.mtime)) / 1000)),
      })
    }
  }

  const keepSet = new Set(members.map(m => m.itemId))
  // 範圍內、已經不在任何組裡的舊列刪掉（範圍外的不碰）
  const old = (db.prepare(
    `SELECT m.item_id, i.path FROM cleanup_burst_members m JOIN file_items i ON i.id=m.item_id`
  ).all() as { item_id: string; path: string }[]).filter(r => inScope(r.path) && !keepSet.has(r.item_id))
  for (const r of old) {
    waitForDb(() => db.prepare('DELETE FROM cleanup_burst_members WHERE item_id=?').run(r.item_id))
  }
  for (const m of members) {
    waitForDb(() => db.prepare(
      `INSERT INTO cleanup_burst_members (item_id,group_id,keep_id,level,boxes,at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(item_id) DO UPDATE SET
         group_id=excluded.group_id, keep_id=excluded.keep_id, level=excluded.level,
         boxes=excluded.boxes, at=excluded.at`
    ).run(m.itemId, m.groupId, m.keepId, m.level, m.boxes, nowIso))
  }

  // 組散掉的候選走 skipped（不是 dismissed）；範圍外的不碰
  const stale = (db.prepare(
    `SELECT c.id, c.item_id, i.path FROM cleanup_candidates c JOIN file_items i ON i.id=c.item_id
      WHERE c.rule_version=? AND c.status='proposed'`
  ).all(BURST_RULE_VERSION) as { id: string; item_id: string; path: string }[])
    .filter(r => inScope(r.path) && !drops.has(r.item_id))
  for (const r of stale) {
    waitForDb(() => db.prepare(`UPDATE cleanup_candidates SET status='skipped' WHERE id=?`).run(r.id))
  }
  for (const [itemId, d] of drops) {
    upsertCandidate(db, itemId, burstDraft(d.level, d.keepName, d.gapSec), nowIso, BURST_RULE_VERSION)
  }
}

/**
 * 組 id ＝ 留下那張的 item_id ＋ 成員 id 排序後的雜湊。**成員變了就是新的一組**，
 * 所以「這一組問過了」不會因為多了一張、少了一張而繼續算數（見 meta 的 burst_asked）。
 * 取 sha256 的前 16 個字（64 位元）：只記最新 50 組，碰撞機率可以忽略。
 */
export function burstGroupId(keepId: string, memberIds: string[]): string {
  return createHash('sha256')
    .update(keepId).update('\n').update([...memberIds].sort().join(','))
    .digest('hex').slice(0, 16)
}

export function scanDownloads(opts: CleanupScanOptions): CleanupScanResult {
  const now = opts.now ?? new Date()
  const nowIso = now.toISOString()
  const result: CleanupScanResult = {
    scanned: 0, candidates: 0, skipped: 0, errors: 0, truncated: false, imagesPending: 0, textsPending: 0,
  }
  // 這一輪算了幾張長相指紋、還剩幾張沒算（一批最多 MAX_IMAGE_BATCH 張）
  const batch: ImageBatch = { hashed: 0, pending: 0 }
  // 讀文件內容的額度（一批最多 MAX_TEXT_BATCH 個）。reader 要到真的有文件類的檔才會開 worker
  const texts: TextBatch = { read: 0, pending: 0, deaths: 0, off: false, unreadable: 0, tooLarge: 0, reader: null }
  // 舊版留下的錯誤作廢要在 upsert 之前改回 skipped，這一輪條件還成立的才會回到 proposed
  repairLegacyDismissed(opts.db)
  const { files, truncated } = fileList(opts)
  result.truncated = truncated
  const touched: string[] = []

  for (const path of files) {
    const inspected = inspectPath(path, opts)
    if (!inspected) { result.skipped++; continue }
    if ('error' in inspected) {
      // **檔案不見了不是「問題」**（2026-09-21 使用者實機回報）。
      //
      // 使用者刪掉一個檔、或清理剛把它搬進隔離區之後，下一次掃描一定會走到這裡。
      // 以前這裡一律 problem() ＋ errors++，於是：
      //   · 面板頂端掛著「The last scan reported 1 problems, so some files may have been
      //     missed: CLAUDE.md：the file is gone」，而那句話是假的 —— 沒有任何檔被漏掉，
      //     那個檔就是使用者自己刪的；
      //   · CLI 印「1 could not be read」，同樣在說謊（它不是讀不到，是不在了）；
      //   · 警告會一直掛到下一次完整掃描蓋掉它，看起來像清不完、還要人去已閱一次。
      //
      // 不見了本來就有正規處理：markMissing 把它記成 missing，之後不再提議。
      // 這一格是**正常結局**，不是需要人看的事。真正該報的是另一邊：沒有權限、
      // 磁碟錯誤 —— 那種才叫「這次沒看到它，它可能還在」。
      if (inspected.missing) {
        markMissing(opts.db, path, opts.roots, nowIso)
        result.skipped++
        continue
      }
      problem(opts, `${basename(path)}：${inspected.error}`)
      result.errors++
      continue
    }

    let sha: string | null = null
    let status: CleanupFileStatus = inspected.recent ? 'new' : 'kept'
    let error: string | null = null
    // 內容真的是 PNG 的話，算 sha256 那一次讀進來的位元組就是指紋要用的（不再開一次檔）
    let png: Buffer | null = null

    if (inspected.bytes > opts.maxBytes) {
      // **太大不是「壞掉」**（2026-09-21 使用者實機回報：379 個候選、8 個卡在「需要你查看」）。
      //
      // 以前這裡寫一句 error，而 collect 的 SQL 有 `i.error IS NULL` —— 一句話就把
      // 每一個大檔踢出候選清單，只能待在「需要你查看」，使用者想清也清不掉。
      // 但那一句話講的其實不是「這個檔壞了」，是「我們沒有讀它的內容」。
      //
      // 沒讀內容的後果只有一個：算不出 sha256，所以它不參與重複偵測
      //（addDuplicateCandidates 的 SQL 本來就有 `sha256 IS NOT NULL`）。
      // 其他規則 —— 舊安裝檔、舊壓縮檔、.part、.tmp、空檔 —— 一條都不需要雜湊，
      // 看的是檔名、副檔名、大小與時間。一個放了三個月的 1.4 GB .gz 完全判得出來。
      //
      // 身分確認改由執行層用 dev／ino／大小／時間做（見 cleanup-exec.ts 的 fingerprint）。
      // sha 留 null 就是「這個檔沒有被讀過」的記號，不需要再多一個欄位。
      sha = null
    } else if (inspected.bytes > 0 && !inspected.partial) {
      try {
        const got = sha256Of(inspected.real, inspected)
        sha = got.sha256
        png = got.png
      }
      catch (e: any) {
        status = 'error'
        error = e?.message ?? 'computing sha256 failed'
        result.errors++
      }
    }

    const item = upsertFile(opts.db, inspected, sha, status, error, nowIso)
    touched.push(item.id)
    result.scanned++

    // 長相指紋（連拍分組用）。status error 的檔連 sha 都沒算出來，不會走到這裡。
    if (png !== null) ensureImageSig(opts, item.id, inspected, png, nowIso, batch)
    png = null

    // 文件的內容（P2 的模型要用）。status error 的檔在掃描中被換掉了，這一輪不讀。
    // **watcher 的單檔模式不讀**（跟連拍分組一樣）：那條路跑在 pet 的主執行緒上，
    // 一個惡意檔就會讓面板卡 5 秒，而且「一批 60 個」「連死 3 次就放棄」兩道閘每次呼叫都重來（P1 驗證員）。
    // 新檔的內容等下一次完整掃描（背景子行程）再讀，最多晚 30 分鐘。
    if (status !== 'error' && !opts.paths) ensureFileText(opts, item.id, inspected, nowIso, texts)

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
      protectDays: opts.protectDays,
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
  addSameTextCandidates(opts.db, nowIso, touched, opts.roots)

  // 連拍分組只在完整掃描做（跟對帳一樣）。單檔模式是 watcher 的一串事件，
  // 每一個事件都把整個資料夾的圖重比一次是白做工；下一次完整掃描（寵物每半小時、
  // 面板按掃描、CLI）會接手。指紋本身在上面逐檔算過了，所以那時候只剩分組。
  if (!opts.paths) {
    sweepImageSigs(opts.db)
    waitForDb(() => sweepFileTexts(opts.db))
    wireBursts(opts, nowIso)
  }
  result.imagesPending = batch.pending
  result.textsPending = texts.pending
  // 讀不懂不是錯（預想的不變量第 6 條）：**只講幾個，不逐檔洗版**。
  // **太大的不報**：那是政策結果，而且永遠不會變好，報了就是每次掃描都洗一次版。
  if (texts.unreadable > 0) {
    const n = texts.unreadable
    problem(opts, `${n} ${n === 1 ? 'file' : 'files'} could not be opened as ${n === 1 ? 'its' : 'their'} format`
      + ` (broken, encrypted, or something this tool does not read), so ${n === 1 ? 'its' : 'their'} contents were not read.`)
  }

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

/** 複本後綴本身（不含副檔名）。跟 COPY_NAME 是同一組樣式，拆出來給 stripCopySuffix 用。 */
const COPY_SUFFIX =
  /(?:\s*\(\d{1,3}\)|\s+-\s+(?:copy|副本|複製|复制|複本)(?:\s*\(\d{1,3}\))?|\s+(?:copy|拷貝|拷贝|副本|的副本|複本)(?:\s+\d{1,3})?)$/i

/**
 * 把「複本」的痕跡從檔名上拿掉：`報告 (1).pdf` → `報告.pdf`。
 *
 * **給模型那條路用的**（2026-09-21）。檔名開始進 prompt、也進快取鍵之後，
 * `講義.txt` 與 `講義 (1).txt` 會變成兩把不同的鑰匙 —— 同一份東西問兩次，
 * 而且兩次可能給出不一樣的答案。那個 `(1)` 是瀏覽器加的，不是檔案內容的一部分。
 *
 * 剝掉之後兩者的鑰匙一樣，「同樣的內容只問一次」照舊成立；
 * 而真的不同名的檔（`report.pdf` 與 `OS HW3.pdf`）鑰匙仍然不同 —— 那是對的，
 * 因為名字會影響答案。
 *
 * 剝完是空的就回原名（`(1).pdf` 這種整個名字都是後綴的，剝了反而更糟）。
 */
export function stripCopySuffix(name: string): string {
  const s = String(name ?? '')
  if (!looksLikeCopy(s)) return s
  const lead = /^copy of\s+/i
  if (lead.test(s)) return s.replace(lead, '') || s
  // 副檔名最多兩段（.tar.gz），先摘下來再剝後綴
  const m = /^(.*?)((?:\.[^.\s]{1,8}){0,2})$/.exec(s)
  const stem = m ? m[1] : s
  const ext = m ? m[2] : ''
  const stripped = stem.replace(COPY_SUFFIX, '').trim()
  return stripped ? stripped + ext : s
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
/**
 * 位元組不同、抽出來的文字一模一樣的檔（2026-09-21 使用者實機回報）。
 *
 * `.pdf`／`.docx` 是保護副檔名，90 天的 old-download 不挑它們；duplicate 又要求
 * sha256 完全相同，而重新下載一次的 PDF 位元組就不一樣了。兩條路都斷掉，所以
 *「最新(第18-20題)…(1).pdf」與「(2).pdf」這種一眼看得出重複的檔從來不上清單。
 *
 * **門檻很重要**：使用者的資料庫裡有 23 個檔抽出來的文字是空字串（沒有文字圖層的
 * 掃描件 PDF）。照文字分組的話它們會互為「重複」，那是**會刪掉真東西的誤判**。
 * 所以只看長度過得了 MIN_SAME_TEXT_CHARS 的文字，空的、太短的一律不分組。
 *
 * sha256 一樣的那幾份不在這裡處理 —— 那是真的重複檔，duplicate（98、預設勾）已經管了，
 * 兩邊都提議會讓同一個檔出現兩個理由。這裡只收「跟留下那份的 sha256 不一樣」的。
 */
export const MIN_SAME_TEXT_CHARS = 200

export function addSameTextCandidates(
  db: DatabaseSync, nowIso = new Date().toISOString(), onlyItemIds?: string[], roots?: string[],
) {
  const pre = roots ? rootPrefixes(roots) : null
  const groups = db.prepare(
    `SELECT t.text AS text, count(*) n
       FROM file_texts t JOIN file_items i ON i.id = t.item_id
      WHERE t.text IS NOT NULL AND length(trim(t.text)) >= ?
        AND i.status NOT IN ('quarantined','missing','error')
      GROUP BY t.text HAVING count(*) > 1`
  ).all(MIN_SAME_TEXT_CHARS) as { text: string; n: number }[]

  const only = onlyItemIds ? new Set(onlyItemIds) : null
  const extra = new Set<string>()
  for (const g of groups) {
    const rows = keepersFirst((db.prepare(
      `SELECT i.* FROM file_items i JOIN file_texts t ON t.item_id = i.id
        WHERE t.text = ? AND i.status NOT IN ('quarantined','missing','error')
        ORDER BY i.first_seen_at, i.path`
    ).all(g.text) as CleanupFileItem[]).filter(r => !pre || pre.some(x => fold(r.path).startsWith(x))))
    if (rows.length < 2) continue
    const keep = rows[0]
    for (const item of rows.slice(1)) {
      if (execRefusesName(item.name) || item.status === 'new') continue
      // 位元組也一樣的話那是真的重複檔，duplicate 已經管了
      if (item.sha256 && keep.sha256 && item.sha256 === keep.sha256) continue
      extra.add(item.id)
      if (only && !only.has(item.id)) continue
      upsertCandidate(db, item.id, sameTextDraft(keep.name, rows.length), nowIso)
      setItemStatus(db, item.id, 'candidate')
    }
  }
  skipStaleKind(db, 'same-text', extra, pre)
}

/** kind 不再成立的候選收成 skipped。duplicate 與 same-text 共用這一支。 */
function skipStaleKind(db: DatabaseSync, kind: string, extra: Set<string>, pre: string[] | null) {
  const stale = (db.prepare(
    `SELECT c.id, c.item_id, i.path FROM cleanup_candidates c JOIN file_items i ON i.id=c.item_id
     WHERE c.kind=? AND c.rule_version=? AND c.status='proposed'
       AND i.status NOT IN ('quarantined','missing','error')`
  ).all(kind, CLEANUP_RULE_VERSION) as { id: string; item_id: string; path: string }[])
    .filter(r => !extra.has(r.item_id) && (!pre || pre.some(x => fold(r.path).startsWith(x))))
  for (const r of stale) {
    waitForDb(() => db.prepare(`UPDATE cleanup_candidates SET status='skipped' WHERE id=?`).run(r.id))
    if (!candidatesFor(db, r.item_id).length) {
      waitForDb(() => db.prepare(`UPDATE file_items SET status='kept' WHERE id=? AND status='candidate'`).run(r.item_id))
    }
  }
}

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
