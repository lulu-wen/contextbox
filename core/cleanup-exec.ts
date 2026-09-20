import { createHash } from 'node:crypto'
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync,
  realpathSync, renameSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { DENY_DIRS, under } from './guard.ts'
import {
  CleanupError, cleanupProblem, execRefusesName, transaction, withCleanupLock, type JournalRow,
} from './cleanup-journal.ts'
import { candidateIdsFor, getPlan, planRow, planSnapshots, validateIds, type PlanSnapshot } from './cleanup-plans.ts'
// **只搬不刪的唯一例外都住在 cleanup-quarantine.ts。** 這裡拿 dropReservation 收掉
// putBack 自己建的 0 byte 佔位檔（稽核第三輪 R3-5）；循環 import 沒問題，兩邊都只在函式裡用。
import { dropReservation } from './cleanup-quarantine.ts'

export const DEFAULT_QUARANTINE = join(homedir(), '.contextbox', 'quarantine')

/**
 * 執行層拒收的檔名規則。**名單只有一份**（定義在 cleanup-journal.ts 這個葉模組，
 * 理由寫在那邊），這裡匯出同一個物件、originalPath 拿它擋；規則層拿它決定不提議。
 * 加一個受保護副檔名只需要改那一行，清單與執行層會一起變。
 */
export { EXEC_PROTECTED_EXT, execRefusesName } from './cleanup-journal.ts'

export const RETENTION_MS = 7 * 24 * 60 * 60_000
export type ExecOptions = {
  roots: string[]; quarantine?: string; maxBytes: number; readonly?: boolean
  /**
   * 每開始處理一項呼叫一次（index 從 0 起算）。在續約鎖之後、動那個檔之前，不在交易裡。
   * CLI 可以拿來印進度；測試拿它模擬「一次跑超過 30 分鐘」。丟例外會讓整個動作停在那一項。
   */
  onProgress?: (index: number, total: number) => void
}
export type Fingerprint = { dev: number; ino: number; size: number; mtime: string; sha256: string }

/** Reject every symlink component, including dangling links and redirected parents. */
export function checkedPath(path: string, directory = false): string {
  const absolute = resolve(path)
  let cur = parse(absolute).root
  for (const segment of relative(cur, absolute).split(sep).filter(Boolean)) {
    cur = join(cur, segment)
    if (lstatSync(cur).isSymbolicLink()) throw new CleanupError('UNSAFE_PATH', 'The path contains a symlink, so it cannot be handled safely.')
  }
  const st = lstatSync(absolute)
  if (directory ? !st.isDirectory() : !st.isFile() || st.nlink !== 1) {
    throw new CleanupError('UNSAFE_PATH', 'Only ordinary files are handled — not symlinks or hard links.')
  }
  return realpathSync(absolute)
}

function exists(path: string): boolean {
  try { lstatSync(path); return true } catch (e: any) { if (e.code === 'ENOENT') return false; throw e }
}

export function fingerprint(path: string, maxBytes: number): Fingerprint {
  checkedPath(path)
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes || !before.ino) {
      throw new CleanupError('UNSAFE_FILE', 'The file is too large, or its identity cannot be confirmed. Check it yourself.')
    }
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(64 * 1024)
    let n: number
    let total = 0
    while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      total += n
      if (total > maxBytes) throw new CleanupError('CHANGED', 'The file grew past the size limit while being read. Scan again.')
      hash.update(buffer.subarray(0, n))
    }
    const after = fstatSync(fd)
    const atPath = lstatSync(path)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || atPath.ino !== before.ino || atPath.dev !== before.dev || atPath.isSymbolicLink()) {
      throw new CleanupError('CHANGED', 'The file changed while being read. Scan again.')
    }
    return { dev: before.dev, ino: before.ino, size: before.size, mtime: before.mtime.toISOString(), sha256: hash.digest('hex') }
  } finally { closeSync(fd) }
}

function same(a: Fingerprint, b: Fingerprint): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtime === b.mtime && a.sha256 === b.sha256
}

export function checkOptions(opts: ExecOptions) {
  if (!opts || opts.readonly) throw new CleanupError('READ_ONLY', 'Changing files is not allowed right now.')
  if (!Array.isArray(opts.roots) || !opts.roots.length || !Number.isFinite(opts.maxBytes) || opts.maxBytes <= 0) {
    throw new CleanupError('BAD_CONFIG', 'Set the cleanup folders and the file size limit first.')
  }
}

export function quarantineRoot(opts: ExecOptions, create = false): string {
  const path = resolve(opts.quarantine ?? DEFAULT_QUARANTINE)
  if (create && !exists(path)) {
    // Validate existing ancestors before creating our own private directories.
    let ancestor = dirname(path)
    while (!exists(ancestor)) ancestor = dirname(ancestor)
    checkedPath(ancestor, true)
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  return checkedPath(path, true)
}

/** 路徑切成小寫的段落（最後一段是檔名）。 */
const lowerSegments = (target: string) => target.split(/[\\/]+/).filter(Boolean).map(s => s.toLowerCase())

/**
 * 路徑上（**不含檔名**）有 . 開頭的資料夾或金鑰資料夾。originalPath 與 keeperPath 共用這一條，
 * 兩邊才不會一邊改了、一邊沒改。
 */
const inProtectedDir = (segments: string[]) => segments.slice(0, -1).some(s => s.startsWith('.') || DENY_DIRS.includes(s))

/**
 * target 在不在任何一個清理根目錄底下。**過不了檢查的根目錄略過，不丟例外。**
 * 以前 `roots.some(root => under(checkedPath(root), …))`：cleanup.roots 裡有一個資料夾不見了
 * （外接碟拔掉）而且排在前面，checkedPath 丟 ENOENT，**每一個檔**都失敗、訊息說「檔案或資料夾
 * 不見了」—— 檔案明明在。略過那個根目錄是 fail closed：它底下的檔只會被當成範圍外。
 */
function underSomeRoot(roots: string[], target: string): boolean {
  return roots.some(root => {
    let real: string
    try { real = checkedPath(root, true) } catch { return false }
    return under(real, target)
  })
}

function originalPath(path: string, opts: ExecOptions, allowMissing = false): string {
  const parent = checkedPath(dirname(path), true)
  const target = join(parent, parse(path).base)
  if (!underSomeRoot(opts.roots, target)) {
    throw new CleanupError('OUTSIDE_ROOT', 'The file is not inside a configured cleanup folder.')
  }
  const segments = lowerSegments(target)
  const name = segments.at(-1)!
  if (inProtectedDir(segments) || execRefusesName(name)) {
    throw new CleanupError('PROTECTED', 'This file is protected. Handle it yourself.')
  }
  if (!allowMissing) checkedPath(target)
  const q = resolve(opts.quarantine ?? DEFAULT_QUARANTINE)
  if (under(q, target) || q === target) throw new CleanupError('UNSAFE_PATH', 'Quarantine cannot be a cleanup source.')
  return target
}

/**
 * 重複檔**保留者**（不會被搬的那一份）的路徑檢查。
 *
 * 跟 originalPath 一樣：要在清理根目錄底下、父資料夾不可以有捷徑、路徑上不可以有 . 開頭的
 * 資料夾或金鑰資料夾、不可以在隔離區裡。**只放寬檔名**：受保護的檔名意思是「不可以搬它」，
 * 拿它當「另外還有一份」的證據沒有問題。
 * 以前用 originalPath 驗保留者：notes.txt 與內容相同的 desktop.ini 並存時，desktop.ini 被當成
 * PROTECTED 丟例外、被 catch 當成「不存在」，notes.txt 永遠 NO_DUPLICATE —— 列得出、勾得起、
 * 永遠搬不動（稽核 RC4-1 的後半）。檔案本身（捷徑、硬鏈結）由 fingerprint 的 checkedPath 檢查。
 *
 * **資料夾那段不放寬。** 保留者會被打開算雜湊；舊版留下的 Downloads/.ssh/x、
 * Downloads/credentials/x 這種列要是也能當保留者，執行層就會去讀金鑰資料夾裡的檔（稽核第三波 K2）。
 */
function keeperPath(path: string, opts: ExecOptions): string {
  const parent = checkedPath(dirname(path), true)
  const target = join(parent, parse(path).base)
  if (!underSomeRoot(opts.roots, target)) {
    throw new CleanupError('OUTSIDE_ROOT', 'The file is not inside a configured cleanup folder.')
  }
  if (inProtectedDir(lowerSegments(target))) {
    throw new CleanupError('PROTECTED', 'This file is protected. Handle it yourself.')
  }
  const q = resolve(opts.quarantine ?? DEFAULT_QUARANTINE)
  if (under(q, target) || q === target) throw new CleanupError('UNSAFE_PATH', 'Quarantine cannot be a cleanup source.')
  return target
}

/**
 * 檔案要「靜置」多久才肯搬。
 *
 * 防的是「還在寫入」—— 下載器、解壓縮、編輯器的暫存寫入都會在幾秒內
 * 連續改同一個檔。搬一個正在被寫的檔會讓那個程式的 fd 指向舊 inode，
 * 資料靜靜消失。
 */
export const SETTLE_MS = 10 * 60_000

function verifySnapshot(item: PlanSnapshot, opts: ExecOptions): Fingerprint {
  const path = originalPath(item.path, opts)
  const f = fingerprint(path, opts.maxBytes)
  if (f.size !== item.bytes || f.mtime !== item.mtime || (item.sha256 && f.sha256 !== item.sha256)) {
    throw new CleanupError('CHANGED', 'The file changed, or is still downloading. Scan again and build a new plan.')
  }
  // **靜置不是「變更」，要分開講。**
  // 併在一起的話，一個剛複製出來、什麼都沒動過的重複檔會得到
  // 「檔案已變更」—— 訊息在說謊，而使用者唯一能做的事（重新掃描）也沒用，
  // 因為重掃之後它還是一樣新。正確的指示是「等一下再試」。
  if (Date.now() - Date.parse(f.mtime) < SETTLE_MS) {
    throw new CleanupError('TOO_FRESH', 'This file changed within the last ten minutes, so it stays put. Try again later.')
  }
  return f
}

/**
 * 只有重複檔理由的檔，搬之前要確認**另外真的還有一份**會留著。
 *
 * `self` 是要搬的那個檔剛量到的指紋。保留者的 dev／ino 必須跟它不同：
 * 資料庫裡兩列可能指向同一個實體檔（Windows 不分大小寫，`A.zip` 與 `a.zip`
 * 是兩列；同一條路徑的兩種寫法也是），把自己當成自己的保留者等於搬走唯一的一份。
 */
function verifyDuplicateKeeper(db: DatabaseSync, item: PlanSnapshot, opts: ExecOptions, selected: Set<string>, self: Fingerprint) {
  if (!item.reasons.every(r => r.kind === 'duplicate')) return
  const others = db.prepare(`SELECT id,path FROM file_items WHERE sha256=? AND id<>?
    AND status NOT IN ('quarantined','missing','error')`).all(item.sha256, item.id) as { id: string; path: string }[]
  for (const other of others) {
    if (selected.has(other.id)) continue
    try {
      const f = fingerprint(keeperPath(other.path, opts), opts.maxBytes)
      if (f.dev === self.dev && f.ino === self.ino) continue
      if (f.sha256 === item.sha256) return
    } catch { /* A stale duplicate record is not evidence of an existing copy. */ }
  }
  throw new CleanupError('NO_DUPLICATE', 'Cannot find the identical file that would be kept. Scan again.')
}

function latest(db: DatabaseSync, planId: string, itemId: string, op: string): JournalRow | undefined {
  return db.prepare('SELECT * FROM cleanup_journal WHERE plan_id=? AND item_id=? AND op=? ORDER BY seq DESC LIMIT 1')
    .get(planId, itemId, op) as JournalRow | undefined
}

function startMove(db: DatabaseSync, planId: string, itemId: string, op: 'quarantine' | 'restore', from: string, to: string, f: Fingerprint): JournalRow {
  const seq = transaction(db, () => {
    const result = db.prepare(`INSERT INTO cleanup_journal(ts,plan_id,item_id,op,from_path,to_path,sha256,status)
      VALUES (?,?,?,?,?,?,?,'started')`).run(new Date().toISOString(), planId, itemId, op, from, to, f.sha256)
    db.prepare('INSERT INTO cleanup_move_details(seq,fingerprint) VALUES (?,?)').run(result.lastInsertRowid, JSON.stringify(f))
    return Number(result.lastInsertRowid)
  })
  return db.prepare('SELECT * FROM cleanup_journal WHERE seq=?').get(seq) as JournalRow
}

export function moveFingerprint(db: DatabaseSync, seq: number): Fingerprint {
  const r = db.prepare('SELECT fingerprint FROM cleanup_move_details WHERE seq=?').get(seq) as { fingerprint: string } | undefined
  if (!r) throw new CleanupError('UNSAFE_JOURNAL', 'The move record is missing. Check it yourself.')
  return JSON.parse(r.fingerprint)
}

/** Paths in a journal must match the immutable plan, not just be inside some root. */
export function checkedQuarantinePath(db: DatabaseSync, row: JournalRow, opts: ExecOptions): string {
  const root = quarantineRoot(opts)
  const expected = join(root, row.plan_id, row.item_id, 'content')
  if (!/^[\w-]+$/.test(row.plan_id) || !/^[\w-]+$/.test(row.item_id) || row.to_path !== expected) {
    throw new CleanupError('UNSAFE_JOURNAL', 'The quarantine record points somewhere else. Check it yourself.')
  }
  const snapshot = planSnapshots(db, row.plan_id).find(i => i.id === row.item_id)
  if (!snapshot || snapshot.path !== row.from_path) throw new CleanupError('UNSAFE_JOURNAL', 'The quarantine record came from somewhere else.')
  checkedPath(dirname(expected), true)
  return expected
}

function reserveDestination(db: DatabaseSync, row: JournalRow) {
  const fd = openSync(row.to_path, 'wx', 0o600)
  try {
    const st = fstatSync(fd)
    db.prepare('UPDATE cleanup_move_details SET reservation=? WHERE seq=?')
      .run(JSON.stringify({ dev: st.dev, ino: st.ino, mtime: st.mtime.toISOString() }), row.seq)
  } finally { closeSync(fd) }
}

/** rename 之後驗證沒過、已經把檔搬回原位 —— 那一項的原因（逐項結果是 failed）。 */
export const MOVED_BACK = 'The file kept changing after the move, so it was put back where it was.'
/**
 * rename 之後驗證沒過、原位又有了別的檔（或搬不回去）—— **檔確實在隔離區**。
 *
 * 稽核第三輪 R3-4：以前這一支讓 journal 維持 started，結果 recoverInterrupted 結不掉
 * （它要求指紋對得上，而走到這裡的前提就是對不上）、undo 一定丟 VERIFY_FAILED、
 * 隔離區清單／可復原清單／健康檢查／doctor 四個地方都看不到它 —— 檔案在隔離區裡隱形。
 * 現在**承認它在**：那一列記成 done，這句話存進 cleanup_item_errors 與 file_items.error。
 */
export const LEFT_IN_QUARANTINE = 'The file kept changing after the move and was not put back. Have a look in quarantine yourself.'

/**
 * 隔離區那個位置有沒有**可能是搬進去的檔**：不存在、或是 0 byte（預留的空檔）→ 沒有。
 * 讀不到（權限、I/O）→ 當成有：說不準的時候不可以說「沒搬」，那會讓檔在隔離區裡隱形。
 * 原檔本身是 0 byte 的話分不出來，但那種檔沒有內容可以丟。
 */
function mayHoldMovedFile(path: string): boolean {
  try { return lstatSync(path).size > 0 } catch (e: any) { return e?.code !== 'ENOENT' }
}

/**
 * rename 之後驗證沒過：把檔搬回原位（稽核第二輪 R2-1b）。**原位不存在才搬**，搬回成功回 true。
 * 跟搬進去一樣先用 'wx' 佔住原位再 rename：檢查與 rename 之間有人建了同名檔的話，'wx' 會失敗，
 * 不會蓋掉它。佔住之後被換掉（dev／ino 不對）也不搬。
 */
function putBack(row: JournalRow): boolean {
  // 自己建的佔位檔（還沒被 rename 換掉的話）。**搬回失敗就要收掉它**（稽核第三輪 R3-5）：
  // 以前留在使用者的 Downloads 裡，檔名跟原檔一模一樣、內容是空的、權限還從 0644 變成 0600，
  // 下一次掃描會把它當成新的空檔、預設打勾，下一次清理就把這個假檔搬走 —— 真內容還在隔離區。
  let reserved: { dev: number; ino: number; mtime: string } | null = null
  try {
    checkedPath(dirname(row.from_path), true)
    const fd = openSync(row.from_path, 'wx', 0o600)
    try {
      const held = fstatSync(fd)
      reserved = { dev: held.dev, ino: held.ino, mtime: held.mtime.toISOString() }
    } finally { closeSync(fd) }
    const st = lstatSync(row.from_path)
    if (st.dev !== reserved.dev || st.ino !== reserved.ino || st.size !== 0) return false
    renameSync(row.to_path, row.from_path)
    reserved = null   // rename 成功：佔位的那個 inode 已經被換掉，沒有東西要收
    return true
  } catch { return false }
  finally {
    // 只有「完全是自己剛建的那一個 0 byte 檔」會被刪，別人換上去的一律不動（dropReservation 自己驗）
    if (reserved) { try { dropReservation(row.from_path, reserved) } catch { /* 收不掉就算了，不可以蓋掉原本的結果 */ } }
  }
}

/** Journal is already committed. An exclusive empty reservation prevents ordinary
 * destination collisions; only that exact reservation may be replaced by rename.
 * EXDEV fails closed: no copy/delete fallback.
 *
 * **rename 之後驗證沒過（指紋對不上，或讀指紋時檔案還在變）→ 立刻搬回原位**（只有搬進隔離區這個方向）。
 * 以前記成 failed、檔留在隔離區：畫面說「原檔都還在原位」，隔離區清單沒有它，undo 也放不回來 ——
 * 檔案實質遺失（稽核第二輪 R2-1b）。搬回成功丟 MOVED_BACK（applyPlan 記 failed）；
 * 搬不回去丟 LEFT_IN_QUARANTINE，applyPlan 看到隔離區有東西就讓 journal 維持 started，
 * recoverInterrupted 與 undo 都還找得到它。
 */
function performMove(db: DatabaseSync, row: JournalRow, opts: ExecOptions, beforeMove?: () => void) {
  const expected = moveFingerprint(db, row.seq)
  if (exists(row.to_path)) {
    const atTarget = fingerprint(row.to_path, opts.maxBytes)
    // Recovery after rename succeeded but the process died before the done write.
    if (same(expected, atTarget)) return
  }
  beforeMove?.()
  if (!same(expected, fingerprint(row.from_path, opts.maxBytes))) {
    throw new CleanupError('CHANGED', 'The source file changed, so the move cannot continue.')
  }
  if (!exists(row.to_path)) reserveDestination(db, row)
  const detail = db.prepare('SELECT reservation FROM cleanup_move_details WHERE seq=?').get(row.seq) as { reservation: string | null }
  const reservation = detail.reservation ? JSON.parse(detail.reservation) : null
  checkedPath(row.to_path)
  const st = lstatSync(row.to_path)
  if (!reservation || st.dev !== reservation.dev || st.ino !== reservation.ino || st.size !== 0
      || st.mtime.toISOString() !== reservation.mtime) {
    throw new CleanupError('CONFLICT', 'Another file already holds the destination, so nothing was overwritten.')
  }
  checkedPath(row.from_path)
  renameSync(row.from_path, row.to_path)
  let problem: unknown = null
  try {
    if (!same(expected, fingerprint(row.to_path, opts.maxBytes))) {
      problem = new CleanupError('VERIFY_FAILED', 'The post-move check did not pass. Leave quarantine alone and try again.')
    }
  } catch (e) { problem = e }
  if (problem === null) return
  if (row.op !== 'quarantine') throw problem
  throw new CleanupError('VERIFY_FAILED', putBack(row) ? MOVED_BACK : LEFT_IN_QUARANTINE)
}

function markMoved(db: DatabaseSync, row: JournalRow) {
  transaction(db, () => {
    // 這一項搬成了：先前失敗留下的原因不再成立（同一份計畫重試成功）
    if (row.op === 'quarantine') {
      db.prepare('DELETE FROM cleanup_item_errors WHERE plan_id=? AND item_id=?').run(row.plan_id, row.item_id)
    }
    db.prepare(`UPDATE cleanup_journal SET status='done',error=NULL WHERE seq=?`).run(row.seq)
    db.prepare('UPDATE cleanup_move_details SET completed_at=COALESCE(completed_at,?) WHERE seq=?')
      .run(new Date().toISOString(), row.seq)
    const status = row.op === 'quarantine' ? 'quarantined' : 'restored'
    db.prepare('UPDATE file_items SET status=?,error=NULL WHERE id=?').run(status, row.item_id)
    db.prepare(`UPDATE cleanup_candidates SET status=? WHERE item_id=?`).run(status, row.item_id)
  })
}

/**
 * 隔離區那個位置有**真的內容**、但跟當初記下的指紋對不上 —— 檔確實搬進去了，
 * 只是搬進去之後還在被寫（稽核第三輪 R3-4）。
 *
 * 0 byte 的預留空檔不算（那是「還沒搬」）；讀不到也不算（說不準的時候不可以下結論）。
 */
function quarantineMismatch(db: DatabaseSync, row: JournalRow, opts: ExecOptions): boolean {
  if (row.op !== 'quarantine') return false
  const at = fingerprintOrNull(row.to_path, opts.maxBytes)
  if (!at || at.size === 0) return false
  try { return !same(moveFingerprint(db, row.seq), at) } catch { return false }
}

/**
 * **承認檔在隔離區**：那一列記成 done，原因同時寫進 cleanup_item_errors（跟著計畫走，重掃不會被蓋掉）
 * 與 file_items.error（逐項結果馬上講得出來）。回傳有沒有真的改到（別人先結掉了就回 false）。
 *
 * 跟 markMoved 的差別只有一個：**不刪 cleanup_item_errors，反而寫一筆**。
 * 這一項搬是搬進去了，但沒有驗證過，使用者該去看一眼隔離區裡那個檔。
 */
function markLeftInQuarantine(db: DatabaseSync, row: JournalRow): boolean {
  const at = new Date().toISOString()
  return transaction(db, () => {
    const changed = Number(db.prepare(`UPDATE cleanup_journal SET status='done',error=? WHERE seq=? AND status='started'`)
      .run(LEFT_IN_QUARANTINE, row.seq).changes) === 1
    if (!changed) return false
    db.prepare('UPDATE cleanup_move_details SET completed_at=COALESCE(completed_at,?) WHERE seq=?').run(at, row.seq)
    db.prepare(`UPDATE file_items SET status='quarantined',error=? WHERE id=?`).run(LEFT_IN_QUARANTINE, row.item_id)
    db.prepare(`UPDATE cleanup_candidates SET status='quarantined' WHERE item_id=?`).run(row.item_id)
    db.prepare(`INSERT INTO cleanup_item_errors (plan_id,item_id,why,at) VALUES (?,?,?,?)
                ON CONFLICT(plan_id,item_id) DO UPDATE SET why=excluded.why, at=excluded.at`)
      .run(row.plan_id, row.item_id, LEFT_IN_QUARANTINE, at)
    return true
  })
}

/**
 * 記一項失敗。`planId` 有給（套用時）就**同時寫進 cleanup_item_errors**。
 *
 * 檢查沒過的失敗（TOO_FRESH、CHANGED…）根本不會寫 journal，只寫 file_items.error，
 * 而那一欄下一次掃描就被改寫 —— 重掃一次，計畫的逐項結果就從「十分鐘內還在變動」變成
 * 「原因不明」（稽核 RC11）。以前是 route 在套用之後補記，直接呼叫 applyPlan 的 CLI
 * 就會漏；記在這裡，誰呼叫都一樣。存的是 cleanupProblem 的人話，不帶路徑。
 */
function markFailure(
  db: DatabaseSync, row: JournalRow | undefined, itemId: string, e: unknown, planId?: string, keepJournal = false,
): string | null {
  const error = cleanupProblem(e)
  return transaction(db, () => {
    if (row) {
      // **別人寫好的 done 不可以改成 failed**（稽核第二輪 R2-6）。卡住超過 30 分鐘、鎖被另一個行程
      // 接走、對方把這一項做完之後，這邊醒來 rename 丟 ENOENT —— 以前無條件改成 failed，檔在隔離區，
      // 逐項結果卻說「檔案不見了」，隔離區清單也沒有它。這種失敗不算數，什麼都不記，回 null。
      const now = db.prepare('SELECT status FROM cleanup_journal WHERE seq=?').get(row.seq) as { status: string } | undefined
      if (now?.status === 'done') return null
      // keepJournal：隔離區裡可能就是搬進去的檔（applyPlan 判斷），journal 維持 started，
      // recoverInterrupted／undo 才找得到它。reverted 是復原時確認過的結論，也不改。
      if (!keepJournal) {
        db.prepare(`UPDATE cleanup_journal SET status='failed',error=? WHERE seq=? AND status IN ('started','failed')`)
          .run(error, row.seq)
      }
    }
    db.prepare(`UPDATE file_items SET error=? WHERE id=?`).run(error, itemId)
    if (planId) {
      db.prepare(`INSERT INTO cleanup_item_errors (plan_id,item_id,why,at) VALUES (?,?,?,?)
                  ON CONFLICT(plan_id,item_id) DO UPDATE SET why=excluded.why, at=excluded.at`)
        .run(planId, itemId, error, new Date().toISOString())
    }
    return error
  })
}

/** 這一次動作停在半路的原因（鎖被另一個清理動作接走）。呼叫端拿它決定要不要說「還沒做完」。 */
export type StoppedEarly = { why: string }
type ResultExtra = { noop?: boolean; stoppedEarly?: StoppedEarly }

/**
 * 一次動作的結果。
 *
 * - `noop`：這一次**一個檔都沒動**（跑過的計畫重送、已經放棄的、已經復原完的）。
 *   稽核第三輪 R3-2：以前重送跟真的搬長得一模一樣，呼叫端把 no-op 當成「這一種動作成功了」，
 *   把一個還沒解決的套用錯誤清掉。既有欄位的意思都不變，只是多講一句「這次什麼都沒做」。
 * - `stoppedEarly`：鎖中途被接走，停在半路（稽核第三輪 R3-3）。沒停就不帶這個欄位。
 */
function result(db: DatabaseSync, id: string, extra: ResultExtra = {}) {
  const moved = db.prepare(`SELECT DISTINCT item_id FROM cleanup_journal WHERE plan_id=? AND op='quarantine' AND status='done'
    AND seq NOT IN (SELECT seq FROM cleanup_purges WHERE status='done')`).all(id) as { item_id: string }[]
  const restored = db.prepare(`SELECT DISTINCT item_id FROM cleanup_journal WHERE plan_id=? AND op='restore' AND status='done'`).all(id) as { item_id: string }[]
  const restoredIds = new Set(restored.map(r => r.item_id))
  const active = new Set(moved.filter(r => !restoredIds.has(r.item_id)).map(r => r.item_id))
  return { ...getPlan(db, id), quarantinedCount: active.size, restoredCount: restored.length,
    quarantinedBytes: planSnapshots(db, id).filter(i => active.has(i.id)).reduce((n, i) => n + i.bytes, 0),
    undoable: active.size > 0, noop: false, ...extra }
}

/**
 * 鎖被另一個清理動作接走（renew 丟 BUSY）時停下來，**不丟例外**（稽核第三輪 R3-3）。
 *
 * 以前直接讓 BUSY 冒出去：CLI 回 2（「動作沒執行」），其實已經有檔搬進隔離區、計畫停在半途，
 * 一行逐項結果都沒印、連計畫 id 都沒給 —— 使用者沒有 undo 的入口。現在停在那裡、
 * 把已經做完的收好，回傳帶 stoppedEarly，呼叫端才能逐項報告。其他錯照樣往上丟。
 */
function stopIfTakenOver(renew: () => void): StoppedEarly | null {
  try { renew(); return null } catch (e) {
    if (e instanceof CleanupError && e.code === 'BUSY') return { why: e.message }
    throw e
  }
}

export function applyPlan(db: DatabaseSync, id: string, opts: ExecOptions & { skippedIds?: string[] }) {
  checkOptions(opts)
  if (opts.skippedIds !== undefined) validateIds(opts.skippedIds)
  return withCleanupLock(db, renew => {
    const plan = planRow(db, id)
    // 提早回傳的一律是 no-op：一個檔都不會動（R3-2）
    if (['applied', 'restored', 'dismissed'].includes(plan.status)) return result(db, id, { noop: true })
    if (db.prepare(`SELECT 1 FROM cleanup_journal WHERE plan_id=? AND op='restore' LIMIT 1`).get(id)) {
      throw new CleanupError('CONFLICT', 'This plan has started restoring. Carry on with the undo.')
    }
    // **計畫是一次性的**：跑完過一次（partial／error）就原樣回傳，不重試任何項目（稽核第二輪 R2-3）。
    // 以前會重試失敗項：失敗的檔可以再進別份計畫（partial／error 不佔檔），使用者用別份計畫搬走又
    // 放回（表示要留著）之後，遲到的重送、面板的「再試一次」、cleanup apply <id> 會把它再搬一次；
    // 復原失敗留下的 error 也被當成「套用失敗、可重試」。失敗的檔要重試就建一份新計畫。
    // proposed（包括做到一半中斷、有 journal 的）照舊接著做。
    if (plan.status === 'partial' || plan.status === 'error') return result(db, id, { noop: true })
    const items = planSnapshots(db, id)
    const started = Boolean(db.prepare('SELECT 1 FROM cleanup_journal WHERE plan_id=? LIMIT 1').get(id))
    if (opts.skippedIds !== undefined) {
      const allowed = new Set(items.flatMap(i => candidateIdsFor(db, id, i.id)))
      if (opts.skippedIds.some(s => !allowed.has(s))) throw new CleanupError('BAD_BODY', 'The skip list names candidates that are not in this plan.')
      const skip = new Set(opts.skippedIds)
      for (const i of items) {
        const ids = candidateIdsFor(db, id, i.id)
        const requested = ids.some(c => skip.has(c))
        const current = (db.prepare(`SELECT max(p.skipped) n FROM cleanup_plan_items p JOIN cleanup_candidates c ON c.id=p.candidate_id
          WHERE p.plan_id=? AND c.item_id=?`).get(id, i.id) as { n: number }).n === 1
        if (started && requested !== current) throw new CleanupError('CONFLICT', 'This plan has started, so the skip list cannot change.')
      }
      transaction(db, () => {
        for (const i of items) {
          const ids = candidateIdsFor(db, id, i.id)
          for (const c of ids) db.prepare('UPDATE cleanup_plan_items SET skipped=? WHERE plan_id=? AND candidate_id=?')
            .run(ids.some(c => skip.has(c)) ? 1 : 0, id, c)
        }
      })
    }
    const q = quarantineRoot(opts, true)
    const selected = new Set(getPlan(db, id).items.filter(i => !i.skipped).map(i => i.itemId))
    let done = 0
    let stopped: StoppedEarly | null = null
    const errors: string[] = []
    for (const [index, item] of items.entries()) {
      // 每處理一項就續約：一次跑超過 30 分鐘時，鎖不可以被別的行程當成殘留接走。
      // 被接走了就停在這裡（不丟例外），計畫留在 proposed，之後接得下去（R3-3）。
      stopped = stopIfTakenOver(renew)
      if (stopped) break
      opts.onProgress?.(index, items.length)
      const ids = candidateIdsFor(db, id, item.id)
      const skipped = ids.some(c => (db.prepare('SELECT skipped FROM cleanup_plan_items WHERE plan_id=? AND candidate_id=?').get(id, c) as any).skipped)
      if (skipped) {
        if (!latest(db, id, item.id, 'skip')) transaction(db, () => {
          db.prepare(`INSERT INTO cleanup_journal(ts,plan_id,item_id,op,status) VALUES (?,?,?,'skip','done')`).run(new Date().toISOString(), id, item.id)
          for (const c of ids) db.prepare(`UPDATE cleanup_candidates SET status='skipped' WHERE id=?`).run(c)
        })
        continue
      }
      let row = latest(db, id, item.id, 'quarantine')
      if (row?.status === 'done') { done++; continue }
      try {
        if (!row) {
          const f = verifySnapshot(item, opts)
          verifyDuplicateKeeper(db, item, opts, selected, f)
          const dir = join(q, id, item.id)
          if (!/^[\w-]+$/.test(id) || !/^[\w-]+$/.test(item.id)) throw new CleanupError('UNSAFE_PATH', 'That file id is not valid.')
          if (!exists(join(q, id))) mkdirSync(join(q, id), { mode: 0o700 })
          checkedPath(join(q, id), true)
          if (!exists(dir)) mkdirSync(dir, { mode: 0o700 })
          checkedPath(dir, true)
          row = startMove(db, id, item.id, 'quarantine', item.path, join(dir, 'content'), f)
        }
        checkedQuarantinePath(db, row, opts)
        originalPath(item.path, opts, true)
        performMove(db, row, opts, () => {
          verifyDuplicateKeeper(db, item, opts, selected, verifySnapshot(item, opts))
        })
        markMoved(db, row)
        done++
      } catch (e) {
        // **搬進去了、驗證沒過、又搬不回原位**：檔確實在隔離區，承認它在（稽核第三輪 R3-4）。
        // 那一列記成 done＋原因，隔離區清單才列得出來、七天後的清空才碰得到、undo 才說得出實話。
        if (row && e instanceof CleanupError && e.code === 'VERIFY_FAILED' && e.message === LEFT_IN_QUARANTINE
            && quarantineMismatch(db, row, opts) && markLeftInQuarantine(db, row)) {
          errors.push(LEFT_IN_QUARANTINE)
          continue
        }
        // 隔離區那個位置有真的內容（rename 做完了：寫 done 失敗……）→ journal 維持 started，
        // 不可以記成 failed：failed 的意思是「原檔還在原位」，檔會在隔離區裡隱形（稽核第二輪 R2-1b）
        const why = markFailure(db, row, item.id, e, id, row ? mayHoldMovedFile(row.to_path) : false)
        if (why === null) done++   // 另一個行程已經把這一項做完
        else errors.push(why)
      }
    }
    // **停在半路就不寫計畫狀態**：它還是 proposed，使用者（或下一次指令）接得下去。
    if (stopped) return result(db, id, { stoppedEarly: stopped })
    db.prepare('UPDATE cleanup_plans SET status=?,applied_at=COALESCE(applied_at,?),error=? WHERE id=?')
      .run(errors.length ? (done ? 'partial' : 'error') : 'applied', new Date().toISOString(), errors[0] ?? null, id)
    return result(db, id)
  })
}

function restoreTarget(path: string): string {
  if (!exists(path)) return path
  for (let n = 1; n <= 10000; n++) {
    const candidate = path + '.restored' + (n === 1 ? '' : '.' + n)
    if (!exists(candidate)) return candidate
  }
  throw new CleanupError('CONFLICT', 'Every name the undo could use is taken. Tidy the destination folder first.')
}

/** 套用中斷在 rename 之前、復原時確認檔案還在原位 —— 那一項的原因（逐項結果是 failed）。 */
export const NOT_MOVED = 'Interrupted mid-move; the file never left, so nothing moved.'
/** 套用中斷在 rename 之前、隔離區只有預留的空檔，原位也找不到（使用者後來刪掉、搬走了）。 */
export const NOT_MOVED_GONE = 'Interrupted mid-move; it never reached quarantine, and it is no longer where it was either.'
/**
 * 套用中斷在 rename 之前、隔離區只有預留的空檔，原位**有東西、但不是當初那一份**
 *（被改過、被換掉、換成資料夾或捷徑）。以前併在 NOT_MOVED_GONE 裡，檔明明在原位，卻說「找不到」。
 */
export const NOT_MOVED_CHANGED = 'Interrupted mid-move; it never reached quarantine, and the file in its place is no longer the same one.'
/** 復原中斷在 rename 之前（recoverInterrupted 確認的）：檔還在隔離區，可以再復原。 */
const RESTORE_NOT_DONE = 'the undo was interrupted, so it was not put back'

/** 讀指紋；讀不到（不見了、被換成捷徑、還在變）回 null。只拿來當證據，不丟例外。 */
function fingerprintOrNull(path: string, maxBytes: number): Fingerprint | null {
  try { return fingerprint(path, maxBytes) } catch { return null }
}

/**
 * 從沒搬進隔離區的那一項，原位現在是什麼情況（undo 結掉 started 列時的原因）：
 * 還是當初那一份 → NOT_MOVED；有東西但對不上 → NOT_MOVED_CHANGED；連 lstat 都看不到 → NOT_MOVED_GONE。
 * 看不到包括 ENOENT 以外的錯（上層資料夾沒有權限）：那種情況我們確實「找不到這個檔」。
 */
function originalVerdict(path: string, expected: Fingerprint, maxBytes: number): string {
  const atOriginal = fingerprintOrNull(path, maxBytes)
  if (atOriginal && same(expected, atOriginal)) return NOT_MOVED
  try { lstatSync(path) } catch { return NOT_MOVED_GONE }
  return NOT_MOVED_CHANGED
}

export function undoPlan(db: DatabaseSync, id: string, opts: ExecOptions) {
  checkOptions(opts)
  return withCleanupLock(db, renew => {
    const plan = planRow(db, id)
    if (['restored', 'dismissed'].includes(plan.status)) return result(db, id, { noop: true })
    // **還沒開始的計畫沒有東西可以復原。** 以前照樣跑完、把計畫標成 restored，逐項變成
    // 「沒有搬動，原因不明」—— 一份從沒套用的計畫在歷史裡變成「復原過了」。判斷跟 releasePlan 一樣。
    if (plan.status === 'proposed' && !db.prepare('SELECT 1 FROM cleanup_journal WHERE plan_id=? LIMIT 1').get(id)) {
      throw new CleanupError('CONFLICT', 'This plan was never applied, so there is nothing to undo. If you do not want it, drop it (release).')
    }
    let restored = 0
    let stopped: StoppedEarly | null = null
    const errors: string[] = []
    const items = planSnapshots(db, id).reverse()
    for (const [index, item] of items.entries()) {
      // 鎖被接走就停在這裡：已經放回去的照實回報，計畫狀態不動，之後接得下去（R3-3）
      stopped = stopIfTakenOver(renew)
      if (stopped) break
      opts.onProgress?.(index, items.length)
      const q = latest(db, id, item.id, 'quarantine')
      if (!q) continue
      let row = latest(db, id, item.id, 'restore')
      if (row?.status === 'done') { restored++; continue }
      try {
        const path = checkedQuarantinePath(db, q, opts)
        const purge = db.prepare('SELECT status FROM cleanup_purges WHERE seq=?').get(q.seq) as { status: string } | undefined
        if (purge?.status === 'done' || purge?.status === 'started' && !exists(path)) {
          throw new CleanupError('PURGED', 'This file was confirmed deleted, so it cannot be brought back.')
        }
        // Failed pre-move attempts have no quarantined data to restore.
        if (q.status !== 'done' && !row) {
          const expected = moveFingerprint(db, q.seq)
          if (!exists(path) || !same(expected, fingerprint(path, opts.maxBytes))) {
            // 隔離區那個位置有真的內容、又對不上：可能就是搬進去之後被改過的那份 ——
            // **不可以說它不在隔離區**，照實丟錯，那一列不動（稽核第二輪 R2-1b／R2-1c）
            if (mayHoldMovedFile(path)) {
              throw new CleanupError('VERIFY_FAILED', 'The file in quarantine does not match what was moved in, so it was not put back. Have a look in quarantine yourself.')
            }
            // **這一項根本不在隔離區**（只有預留的空檔，或什麼都沒有）：沒有東西可以放回，跳過。
            // 以前這裡丟 VERIFY_FAILED：套用失敗、原檔後來被使用者刪掉的項目讓復原永遠是 partial，
            // CLI 回 3 卻說「有 0 個沒放回」（稽核第二輪 R2-1c）。failed 的維持 failed；
            // started 的（中斷在 rename 之前）**結掉**（reverted），不然它永遠是「狀態不明」。
            // 隔離區裡預留的空檔不刪：只有清空才會刪檔。
            if (q.status === 'started') {
              db.prepare(`UPDATE cleanup_journal SET status='reverted',error=? WHERE seq=? AND status='started'`)
                .run(originalVerdict(item.path, expected, opts.maxBytes), q.seq)
            }
            continue
          }
          markMoved(db, q)
        }
        const original = originalPath(item.path, opts, true)
        if (!row) {
          const f = fingerprint(path, opts.maxBytes)
          if (!same(f, moveFingerprint(db, q.seq))) throw new CleanupError('CHANGED', 'The quarantined file changed, so it cannot be put back safely.')
          row = startMove(db, id, item.id, 'restore', path, restoreTarget(original), f)
        }
        if (row.from_path !== path || !(row.to_path === original || /^\.restored(?:\.[1-9]\d*)?$/.test(row.to_path.slice(original.length)) && row.to_path.startsWith(original))) {
          throw new CleanupError('UNSAFE_JOURNAL', 'The undo record points somewhere else.')
        }
        checkedPath(dirname(row.to_path), true)
        performMove(db, row, opts)
        markMoved(db, row)
        restored++
      } catch (e) {
        const why = markFailure(db, row, item.id, e)
        if (why === null) restored++   // 另一個行程已經把這一項放回去了
        else errors.push(why)
      }
    }
    if (stopped) return result(db, id, { stoppedEarly: stopped })
    db.prepare('UPDATE cleanup_plans SET status=?,error=? WHERE id=?')
      .run(errors.length ? (restored ? 'partial' : 'error') : 'restored', errors[0] ?? null, id)
    return result(db, id)
  })
}

/**
 * **把中斷留下的 started 列結掉**：只看檔案證據改 journal，**不搬任何檔**（稽核第二輪 R2-1a）。
 * 開機與每個清理指令之前跑一次（呼叫端決定），拿清理鎖。回傳改了幾列。
 *
 * 為什麼要：搬到一半被砍（kill -9、斷電、Ctrl+C 落在 rename 與寫 done 之間）的列停在 started。
 * 檔其實已經在隔離區，但隔離區清單、可復原的歷史都只認 done —— 整份計畫還沒有任何一項完成的話，
 * 每個入口都說「沒有」，檔案對使用者來說就是不見了。
 *
 * quarantine 列（started）：
 * - 隔離區那份存在、指紋等於記錄的搬移指紋 → 檔在隔離區，照 markMoved 結成 done
 * - 原位那份存在、指紋相符，隔離區那個位置不存在或是 0 byte（預留的空檔）→ 沒搬，結成 reverted（NOT_MOVED）
 * - 其他 → 維持 started（真的說不準：兩邊都對不上、讀不到、路徑對不上紀錄）
 *
 * restore 列（started）：
 * - 原位（to_path）指紋相符 → 放回了，結成 done
 * - 隔離區那份指紋相符、原位沒有（不存在，或只是這一列記錄的預留空檔）→ 結成 failed
 *   「復原中斷，沒有放回」：這一項還在隔離區，逐項是 moved，可以再復原（failed 的列 undo 會接著做）
 * - 其他 → 維持 started
 *
 * **結完 journal 之後再收計畫**（稽核第三輪 R3-1）：整份其實已經做完的計畫以前永遠停在 proposed ——
 * 寵物永遠說「有 1 份清單等你確認」，面板的待確認清單卻是空的，releaseStalePlans 依設計又不碰有
 * journal 的計畫，任何自動路徑都收不掉它。見 settleProposedPlans。
 * 唯讀模式也可以跑：它只改資料庫，不動檔案。
 */
export function recoverInterrupted(db: DatabaseSync, opts: ExecOptions): { recovered: number } {
  if (!opts || !Number.isFinite(opts.maxBytes) || opts.maxBytes <= 0) {
    throw new CleanupError('BAD_CONFIG', 'Set the file size limit first.')
  }
  return withCleanupLock(db, () => {
    let recovered = 0
    const rows = db.prepare(`SELECT * FROM cleanup_journal WHERE status='started' AND op IN ('quarantine','restore')
      ORDER BY seq`).all() as JournalRow[]
    for (const row of rows) {
      try {
        if (row.op === 'quarantine' ? recoverMove(db, row, opts) : recoverRestore(db, row, opts)) recovered++
      } catch { /* 這一列說不準（路徑對不上、隔離區讀不到）：維持 started */ }
    }
    settleProposedPlans(db)
    return { recovered }
  })
}

/** 一項在這份計畫裡的下場（settlePlan 用）。跟 cleanup-routes 的逐項結果同一套判斷。 */
type ItemVerdict = 'moved' | 'restored' | 'failed' | 'skipped' | 'unresolved' | 'untouched'

/**
 * **把已經做完、卻還停在 proposed 的計畫收成正確的狀態**（稽核第三輪 R3-1）。回傳收了幾份。
 *
 * 只收「沒有還在半路的 journal 列（started），而且每一項都有下落」的 proposed 計畫：
 * - 全部搬成 → applied；有失敗的 → partial；全部失敗 → error；全部放回了 → restored
 * - **還有「沒處理到」的項目（沒有 journal 列、也沒有存下來的失敗原因）→ 維持 proposed**，
 *   那才是真的中斷，使用者要接著做完或復原。
 *
 * 為什麼一定要在這裡做：recoverInterrupted 結掉 journal 之後，計畫本身沒有任何自動路徑會收 ——
 * releaseStalePlans 明文跳過有 journal 的計畫，寵物只看 proposedPlans 的數量，
 * 結果寵物永遠顯示「有 1 份清單等你確認」而面板的待確認清單是空的，使用者按不到任何東西。
 * 任何一份判不出來的（讀不到快照、SQL 出錯）就不動它：說不準的時候不可以改使用者的狀態。
 */
function settleProposedPlans(db: DatabaseSync): number {
  let settled = 0
  const plans = db.prepare(`SELECT id FROM cleanup_plans WHERE status='proposed'`).all() as { id: string }[]
  for (const p of plans) {
    try { if (settlePlan(db, p.id)) settled++ } catch { /* 這一份說不準：維持 proposed */ }
  }
  return settled
}

function verdictOf(
  db: DatabaseSync, planId: string, itemId: string, stored: Map<string, string>,
): { verdict: ItemVerdict; why: string | null } {
  const q = latest(db, planId, itemId, 'quarantine')
  const r = latest(db, planId, itemId, 'restore')
  if (q?.status === 'started' || r?.status === 'started') return { verdict: 'unresolved', why: null }
  if (!q) {
    if (latest(db, planId, itemId, 'skip')) return { verdict: 'skipped', why: null }
    // 檢查沒過（TOO_FRESH、CHANGED…）根本不寫 journal，但套用當下會存原因 —— 那也是「處理過」。
    // 兩樣都沒有才是真的沒碰過。
    const why = stored.get(itemId)
    return why === undefined ? { verdict: 'untouched', why: null } : { verdict: 'failed', why }
  }
  if (q.status === 'done') {
    if (r?.status === 'done') return { verdict: 'restored', why: null }
    // 搬進去了、驗證沒過（R3-4）：檔在隔離區，但這一項不算成功
    const why = stored.get(itemId)
    return why === undefined ? { verdict: 'moved', why: null } : { verdict: 'failed', why }
  }
  // **reverted ＝ 確認沒搬、檔還好端端在原位**（中斷在 rename 之前）。那是「還沒處理」，不是失敗：
  // 判成 failed 的話，收尾會把一份接得完的計畫收成 error，之後 apply 一律 no-op，那個檔再也搬不動
  // （稽核第三輪的驗證員抓到的回歸）。留成 unresolved，計畫維持 proposed，下一次 apply 會接著搬。
  if (q.status === 'reverted' && stored.get(itemId) === undefined) return { verdict: 'unresolved', why: null }
  return { verdict: 'failed', why: stored.get(itemId) ?? q.error }   // failed（或 reverted 而且套用當下記過原因）
}

function settlePlan(db: DatabaseSync, id: string): boolean {
  const items = planSnapshots(db, id)
  if (!items.length) return false
  const stored = new Map((db.prepare('SELECT item_id, why FROM cleanup_item_errors WHERE plan_id=?')
    .all(id) as { item_id: string; why: string }[]).map(r => [r.item_id, r.why]))
  let moved = 0, restored = 0, failed = 0
  let why: string | null = null
  for (const item of items) {
    const v = verdictOf(db, id, item.id, stored)
    if (v.verdict === 'unresolved' || v.verdict === 'untouched') return false
    if (v.verdict === 'moved') moved++
    else if (v.verdict === 'restored') restored++
    else if (v.verdict === 'failed') { failed++; why = why ?? v.why }
  }
  // 判斷跟 applyPlan／undoPlan 寫計畫狀態時一模一樣，不另外發明一套
  const status = failed ? (moved || restored ? 'partial' : 'error')
    : restored && !moved ? 'restored'
    : 'applied'
  return Number(db.prepare(
    `UPDATE cleanup_plans SET status=?,applied_at=COALESCE(applied_at,?),error=? WHERE id=? AND status='proposed'`
  ).run(status, new Date().toISOString(), failed ? why : null, id).changes) === 1
}

function recoverMove(db: DatabaseSync, row: JournalRow, opts: ExecOptions): boolean {
  checkedQuarantinePath(db, row, opts)
  const expected = moveFingerprint(db, row.seq)
  const atQuarantine = fingerprintOrNull(row.to_path, opts.maxBytes)
  if (atQuarantine && same(expected, atQuarantine)) {
    markMoved(db, row)
    return true
  }
  const atOriginal = fingerprintOrNull(row.from_path, opts.maxBytes)
  const stillAtOriginal = Boolean(atOriginal && same(expected, atOriginal))
  if (stillAtOriginal && !mayHoldMovedFile(row.to_path)) {
    return Number(db.prepare(`UPDATE cleanup_journal SET status='reverted',error=? WHERE seq=? AND status='started'`)
      .run(NOT_MOVED, row.seq).changes) === 1
  }
  // **隔離區那個位置有真的內容、指紋卻對不上**：檔就是搬進去了，只是搬進去之後還在被寫（R3-4）。
  // 承認它在，記成 done＋原因；以前維持 started，每個清單都看不到它、undo 也動不了它。
  // 原檔還好端端在原位的話不算（那種就不是「搬進去了」），fail closed。
  if (!stillAtOriginal && atQuarantine && atQuarantine.size > 0) return markLeftInQuarantine(db, row)
  return false
}

function recoverRestore(db: DatabaseSync, row: JournalRow, opts: ExecOptions): boolean {
  // 路徑要對得上：from 是這一項的隔離區檔，to 是原位（或 .restored 改名）。對不上就不碰。
  const q = latest(db, row.plan_id, row.item_id, 'quarantine')
  if (!q || q.status !== 'done') return false
  const path = checkedQuarantinePath(db, q, opts)
  const original = q.from_path
  if (row.from_path !== path || !(row.to_path === original
      || row.to_path.startsWith(original) && /^\.restored(?:\.[1-9]\d*)?$/.test(row.to_path.slice(original.length)))) {
    return false
  }
  const expected = moveFingerprint(db, row.seq)
  const atOriginal = fingerprintOrNull(row.to_path, opts.maxBytes)
  if (atOriginal && same(expected, atOriginal)) {
    markMoved(db, row)
    return true
  }
  const atQuarantine = fingerprintOrNull(path, opts.maxBytes)
  if (atQuarantine && same(expected, atQuarantine) && originVacant(db, row)) {
    return Number(db.prepare(`UPDATE cleanup_journal SET status='failed',error=? WHERE seq=? AND status='started'`)
      .run(RESTORE_NOT_DONE, row.seq).changes) === 1
  }
  return false
}

/** 復原的目的地是空的：不存在，或只是這一列自己記錄的預留空檔（中斷在預留之後、rename 之前）。 */
function originVacant(db: DatabaseSync, row: JournalRow): boolean {
  let st
  try { st = lstatSync(row.to_path) } catch (e: any) { return e?.code === 'ENOENT' }
  const detail = db.prepare('SELECT reservation FROM cleanup_move_details WHERE seq=?').get(row.seq) as { reservation: string | null } | undefined
  const reservation = detail?.reservation ? JSON.parse(detail.reservation) : null
  return Boolean(reservation) && st.isFile() && st.size === 0 && st.dev === reservation.dev && st.ino === reservation.ino
}

/** Internal journal rows are for B only; public quarantine entries omit paths. */
export function activeQuarantine(db: DatabaseSync): JournalRow[] {
  return db.prepare(`SELECT q.* FROM cleanup_journal q WHERE q.op='quarantine' AND q.status='done'
    AND NOT EXISTS (SELECT 1 FROM cleanup_journal r WHERE r.plan_id=q.plan_id AND r.item_id=q.item_id AND r.op='restore' AND r.status='done')
    AND NOT EXISTS (SELECT 1 FROM cleanup_purges p WHERE p.seq=q.seq AND p.status='done') ORDER BY q.seq`).all() as JournalRow[]
}

/**
 * 隔離區清單（拿鎖）。形狀與判斷跟 cleanup-routes.ts 的 quarantineItems（不拿鎖）一樣。
 *
 * **復原到一半中斷（restore 停在 started）的照列，但 canEmptyNow 一律 false**：
 * emptyQuarantine 會跳過它（留給「再按一次復原」），說「現在可以清空」就是在說謊。
 * 以前這裡只看七天，同一份計畫在 quarantineItems 與 /health 是 false、在這裡是 true。
 */
export function listQuarantine(db: DatabaseSync) {
  // getPlan/init is unnecessary here; initialize through the shared lock for a consistent view.
  return withCleanupLock(db, () => activeQuarantine(db).map(row => {
    const item = planSnapshots(db, row.plan_id).find(i => i.id === row.item_id)!
    const quarantinedAt = quarantineCompletedAt(db, row.seq)
    const canEmptyAt = new Date(Date.parse(quarantinedAt) + RETENTION_MS).toISOString()
    const restoring = Boolean(db.prepare(`SELECT 1 FROM cleanup_journal WHERE plan_id=? AND item_id=? AND op='restore'
      AND status='started' LIMIT 1`).get(row.plan_id, row.item_id))
    return { seq: row.seq, planId: row.plan_id, itemId: row.item_id, name: item.name, bytes: item.bytes,
      quarantinedAt, canEmptyAt, canEmptyNow: !restoring && Date.now() >= Date.parse(canEmptyAt) }
  }))
}

export function quarantineCompletedAt(db: DatabaseSync, seq: number): string {
  const r = db.prepare('SELECT completed_at FROM cleanup_move_details WHERE seq=?').get(seq) as { completed_at: string | null } | undefined
  if (!r?.completed_at || !Number.isFinite(Date.parse(r.completed_at))) {
    throw new CleanupError('UNSAFE_JOURNAL', 'The quarantine timestamp is missing, so this cannot be emptied.')
  }
  return r.completed_at
}
