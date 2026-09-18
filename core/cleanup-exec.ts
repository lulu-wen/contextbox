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

export const DEFAULT_QUARANTINE = join(homedir(), '.contextbox', 'quarantine')

/**
 * 執行層拒收的檔名規則。**名單只有一份**（定義在 cleanup-journal.ts 這個葉模組，
 * 理由寫在那邊），這裡匯出同一個物件、originalPath 拿它擋；規則層拿它決定不提議。
 * 加一個受保護副檔名只需要改那一行，清單與執行層會一起變。
 */
export { EXEC_PROTECTED_EXT, execRefusesName } from './cleanup-journal.ts'

export const RETENTION_MS = 7 * 24 * 60 * 60_000
export type ExecOptions = { roots: string[]; quarantine?: string; maxBytes: number; readonly?: boolean }
export type Fingerprint = { dev: number; ino: number; size: number; mtime: string; sha256: string }

/** Reject every symlink component, including dangling links and redirected parents. */
export function checkedPath(path: string, directory = false): string {
  const absolute = resolve(path)
  let cur = parse(absolute).root
  for (const segment of relative(cur, absolute).split(sep).filter(Boolean)) {
    cur = join(cur, segment)
    if (lstatSync(cur).isSymbolicLink()) throw new CleanupError('UNSAFE_PATH', '路徑含有捷徑，無法安全處理。')
  }
  const st = lstatSync(absolute)
  if (directory ? !st.isDirectory() : !st.isFile() || st.nlink !== 1) {
    throw new CleanupError('UNSAFE_PATH', '只處理一般檔案，不處理捷徑或硬鏈結。')
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
      throw new CleanupError('UNSAFE_FILE', '檔案太大或無法確認身分，請人工檢查。')
    }
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(64 * 1024)
    let n: number
    let total = 0
    while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      total += n
      if (total > maxBytes) throw new CleanupError('CHANGED', '讀取時檔案超過大小上限，請重新掃描。')
      hash.update(buffer.subarray(0, n))
    }
    const after = fstatSync(fd)
    const atPath = lstatSync(path)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || atPath.ino !== before.ino || atPath.dev !== before.dev || atPath.isSymbolicLink()) {
      throw new CleanupError('CHANGED', '檔案在讀取時變更，請重新掃描。')
    }
    return { dev: before.dev, ino: before.ino, size: before.size, mtime: before.mtime.toISOString(), sha256: hash.digest('hex') }
  } finally { closeSync(fd) }
}

function same(a: Fingerprint, b: Fingerprint): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtime === b.mtime && a.sha256 === b.sha256
}

export function checkOptions(opts: ExecOptions) {
  if (!opts || opts.readonly) throw new CleanupError('READ_ONLY', '目前不允許變更檔案。')
  if (!Array.isArray(opts.roots) || !opts.roots.length || !Number.isFinite(opts.maxBytes) || opts.maxBytes <= 0) {
    throw new CleanupError('BAD_CONFIG', '請設定清理資料夾與檔案大小上限。')
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

function originalPath(path: string, opts: ExecOptions, allowMissing = false): string {
  const parent = checkedPath(dirname(path), true)
  const target = join(parent, parse(path).base)
  if (!opts.roots.some(root => under(checkedPath(root, true), target))) {
    throw new CleanupError('OUTSIDE_ROOT', '檔案不在設定的清理資料夾內。')
  }
  const segments = target.split(/[\\/]+/).filter(Boolean).map(s => s.toLowerCase())
  const name = segments.at(-1)!
  if (segments.slice(0, -1).some(s => s.startsWith('.') || DENY_DIRS.includes(s)) || execRefusesName(name)) {
    throw new CleanupError('PROTECTED', '這是受保護的檔案，請人工處理。')
  }
  if (!allowMissing) checkedPath(target)
  const q = resolve(opts.quarantine ?? DEFAULT_QUARANTINE)
  if (under(q, target) || q === target) throw new CleanupError('UNSAFE_PATH', '不可把隔離區當成清理來源。')
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
    throw new CleanupError('CHANGED', '檔案已變更或仍在下載，請重新掃描並建立計畫。')
  }
  // **靜置不是「變更」，要分開講。**
  // 併在一起的話，一個剛複製出來、什麼都沒動過的重複檔會得到
  // 「檔案已變更」—— 訊息在說謊，而使用者唯一能做的事（重新掃描）也沒用，
  // 因為重掃之後它還是一樣新。正確的指示是「等一下再試」。
  if (Date.now() - Date.parse(f.mtime) < SETTLE_MS) {
    throw new CleanupError('TOO_FRESH', '這個檔案十分鐘內還在變動，先不搬。等一下再試一次。')
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
      const f = fingerprint(originalPath(other.path, opts), opts.maxBytes)
      if (f.dev === self.dev && f.ino === self.ino) continue
      if (f.sha256 === item.sha256) return
    } catch { /* A stale duplicate record is not evidence of an existing copy. */ }
  }
  throw new CleanupError('NO_DUPLICATE', '找不到會保留的相同檔案，請重新掃描。')
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
  if (!r) throw new CleanupError('UNSAFE_JOURNAL', '缺少搬移紀錄，請人工檢查。')
  return JSON.parse(r.fingerprint)
}

/** Paths in a journal must match the immutable plan, not just be inside some root. */
export function checkedQuarantinePath(db: DatabaseSync, row: JournalRow, opts: ExecOptions): string {
  const root = quarantineRoot(opts)
  const expected = join(root, row.plan_id, row.item_id, 'content')
  if (!/^[\w-]+$/.test(row.plan_id) || !/^[\w-]+$/.test(row.item_id) || row.to_path !== expected) {
    throw new CleanupError('UNSAFE_JOURNAL', '隔離紀錄路徑不符，請人工檢查。')
  }
  const snapshot = planSnapshots(db, row.plan_id).find(i => i.id === row.item_id)
  if (!snapshot || snapshot.path !== row.from_path) throw new CleanupError('UNSAFE_JOURNAL', '隔離紀錄來源不符。')
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

/** Journal is already committed. An exclusive empty reservation prevents ordinary
 * destination collisions; only that exact reservation may be replaced by rename.
 * EXDEV fails closed: no copy/delete fallback.
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
    throw new CleanupError('CHANGED', '來源檔案已變更，無法繼續搬移。')
  }
  if (!exists(row.to_path)) reserveDestination(db, row)
  const detail = db.prepare('SELECT reservation FROM cleanup_move_details WHERE seq=?').get(row.seq) as { reservation: string | null }
  const reservation = detail.reservation ? JSON.parse(detail.reservation) : null
  checkedPath(row.to_path)
  const st = lstatSync(row.to_path)
  if (!reservation || st.dev !== reservation.dev || st.ino !== reservation.ino || st.size !== 0
      || st.mtime.toISOString() !== reservation.mtime) {
    throw new CleanupError('CONFLICT', '目的地已被其他檔案佔用，沒有覆蓋任何檔案。')
  }
  checkedPath(row.from_path)
  renameSync(row.from_path, row.to_path)
  if (!same(expected, fingerprint(row.to_path, opts.maxBytes))) {
    throw new CleanupError('VERIFY_FAILED', '搬移後驗證未通過，請保留隔離區並重試。')
  }
}

function markMoved(db: DatabaseSync, row: JournalRow) {
  transaction(db, () => {
    db.prepare(`UPDATE cleanup_journal SET status='done',error=NULL WHERE seq=?`).run(row.seq)
    db.prepare('UPDATE cleanup_move_details SET completed_at=COALESCE(completed_at,?) WHERE seq=?')
      .run(new Date().toISOString(), row.seq)
    const status = row.op === 'quarantine' ? 'quarantined' : 'restored'
    db.prepare('UPDATE file_items SET status=?,error=NULL WHERE id=?').run(status, row.item_id)
    db.prepare(`UPDATE cleanup_candidates SET status=? WHERE item_id=?`).run(status, row.item_id)
  })
}

function markFailure(db: DatabaseSync, row: JournalRow | undefined, itemId: string, e: unknown) {
  const error = cleanupProblem(e)
  transaction(db, () => {
    if (row) db.prepare(`UPDATE cleanup_journal SET status='failed',error=? WHERE seq=?`).run(error, row.seq)
    db.prepare(`UPDATE file_items SET error=? WHERE id=?`).run(error, itemId)
  })
  return error
}

function result(db: DatabaseSync, id: string) {
  const moved = db.prepare(`SELECT DISTINCT item_id FROM cleanup_journal WHERE plan_id=? AND op='quarantine' AND status='done'
    AND seq NOT IN (SELECT seq FROM cleanup_purges WHERE status='done')`).all(id) as { item_id: string }[]
  const restored = db.prepare(`SELECT DISTINCT item_id FROM cleanup_journal WHERE plan_id=? AND op='restore' AND status='done'`).all(id) as { item_id: string }[]
  const restoredIds = new Set(restored.map(r => r.item_id))
  const active = new Set(moved.filter(r => !restoredIds.has(r.item_id)).map(r => r.item_id))
  return { ...getPlan(db, id), quarantinedCount: active.size, restoredCount: restored.length,
    quarantinedBytes: planSnapshots(db, id).filter(i => active.has(i.id)).reduce((n, i) => n + i.bytes, 0), undoable: active.size > 0 }
}

export function applyPlan(db: DatabaseSync, id: string, opts: ExecOptions & { skippedIds?: string[] }) {
  checkOptions(opts)
  if (opts.skippedIds !== undefined) validateIds(opts.skippedIds)
  return withCleanupLock(db, () => {
    const plan = planRow(db, id)
    if (['applied', 'restored', 'dismissed'].includes(plan.status)) return result(db, id)
    if (db.prepare(`SELECT 1 FROM cleanup_journal WHERE plan_id=? AND op='restore' LIMIT 1`).get(id)) {
      throw new CleanupError('CONFLICT', '計畫已開始復原，請繼續復原。')
    }
    const items = planSnapshots(db, id)
    const started = Boolean(db.prepare('SELECT 1 FROM cleanup_journal WHERE plan_id=? LIMIT 1').get(id))
    if (opts.skippedIds !== undefined) {
      const allowed = new Set(items.flatMap(i => candidateIdsFor(db, id, i.id)))
      if (opts.skippedIds.some(s => !allowed.has(s))) throw new CleanupError('BAD_BODY', '略過清單包含不屬於這份計畫的候選。')
      const skip = new Set(opts.skippedIds)
      for (const i of items) {
        const ids = candidateIdsFor(db, id, i.id)
        const requested = ids.some(c => skip.has(c))
        const current = (db.prepare(`SELECT max(p.skipped) n FROM cleanup_plan_items p JOIN cleanup_candidates c ON c.id=p.candidate_id
          WHERE p.plan_id=? AND c.item_id=?`).get(id, i.id) as { n: number }).n === 1
        if (started && requested !== current) throw new CleanupError('CONFLICT', '計畫已開始，不能更改略過項目。')
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
    const errors: string[] = []
    for (const item of items) {
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
          if (!/^[\w-]+$/.test(id) || !/^[\w-]+$/.test(item.id)) throw new CleanupError('UNSAFE_PATH', '檔案識別碼不合法。')
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
      } catch (e) { errors.push(markFailure(db, row, item.id, e)) }
    }
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
  throw new CleanupError('CONFLICT', '復原檔名都已被佔用，請先整理目的資料夾。')
}

export function undoPlan(db: DatabaseSync, id: string, opts: ExecOptions) {
  checkOptions(opts)
  return withCleanupLock(db, () => {
    const plan = planRow(db, id)
    if (['restored', 'dismissed'].includes(plan.status)) return result(db, id)
    let restored = 0
    const errors: string[] = []
    for (const item of planSnapshots(db, id).reverse()) {
      const q = latest(db, id, item.id, 'quarantine')
      if (!q) continue
      let row = latest(db, id, item.id, 'restore')
      if (row?.status === 'done') { restored++; continue }
      try {
        const path = checkedQuarantinePath(db, q, opts)
        const purge = db.prepare('SELECT status FROM cleanup_purges WHERE seq=?').get(q.seq) as { status: string } | undefined
        if (purge?.status === 'done' || purge?.status === 'started' && !exists(path)) {
          throw new CleanupError('PURGED', '這個檔案已確認清空，無法復原。')
        }
        // Failed pre-move attempts have no quarantined data to restore.
        if (q.status !== 'done' && !row) {
          if (!exists(path) || !same(moveFingerprint(db, q.seq), fingerprint(path, opts.maxBytes))) {
            if (exists(item.path) && same(moveFingerprint(db, q.seq), fingerprint(item.path, opts.maxBytes))) continue
            throw new CleanupError('VERIFY_FAILED', '找不到可驗證的檔案，請檢查來源及隔離區。')
          }
          markMoved(db, q)
        }
        const original = originalPath(item.path, opts, true)
        if (!row) {
          const f = fingerprint(path, opts.maxBytes)
          if (!same(f, moveFingerprint(db, q.seq))) throw new CleanupError('CHANGED', '隔離區檔案已變更，無法安全復原。')
          row = startMove(db, id, item.id, 'restore', path, restoreTarget(original), f)
        }
        if (row.from_path !== path || !(row.to_path === original || /^\.restored(?:\.[1-9]\d*)?$/.test(row.to_path.slice(original.length)) && row.to_path.startsWith(original))) {
          throw new CleanupError('UNSAFE_JOURNAL', '復原紀錄路徑不符。')
        }
        checkedPath(dirname(row.to_path), true)
        performMove(db, row, opts)
        markMoved(db, row)
        restored++
      } catch (e) { errors.push(markFailure(db, row, item.id, e)) }
    }
    db.prepare('UPDATE cleanup_plans SET status=?,error=? WHERE id=?')
      .run(errors.length ? (restored ? 'partial' : 'error') : 'restored', errors[0] ?? null, id)
    return result(db, id)
  })
}

/** Internal journal rows are for B only; public quarantine entries omit paths. */
export function activeQuarantine(db: DatabaseSync): JournalRow[] {
  return db.prepare(`SELECT q.* FROM cleanup_journal q WHERE q.op='quarantine' AND q.status='done'
    AND NOT EXISTS (SELECT 1 FROM cleanup_journal r WHERE r.plan_id=q.plan_id AND r.item_id=q.item_id AND r.op='restore' AND r.status='done')
    AND NOT EXISTS (SELECT 1 FROM cleanup_purges p WHERE p.seq=q.seq AND p.status='done') ORDER BY q.seq`).all() as JournalRow[]
}

export function listQuarantine(db: DatabaseSync) {
  // getPlan/init is unnecessary here; initialize through the shared lock for a consistent view.
  return withCleanupLock(db, () => activeQuarantine(db).map(row => {
    const item = planSnapshots(db, row.plan_id).find(i => i.id === row.item_id)!
    const quarantinedAt = quarantineCompletedAt(db, row.seq)
    const canEmptyAt = new Date(Date.parse(quarantinedAt) + RETENTION_MS).toISOString()
    return { seq: row.seq, planId: row.plan_id, itemId: row.item_id, name: item.name, bytes: item.bytes,
      quarantinedAt, canEmptyAt, canEmptyNow: Date.now() >= Date.parse(canEmptyAt) }
  }))
}

export function quarantineCompletedAt(db: DatabaseSync, seq: number): string {
  const r = db.prepare('SELECT completed_at FROM cleanup_move_details WHERE seq=?').get(seq) as { completed_at: string | null } | undefined
  if (!r?.completed_at || !Number.isFinite(Date.parse(r.completed_at))) {
    throw new CleanupError('UNSAFE_JOURNAL', '缺少隔離完成時間，無法清空。')
  }
  return r.completed_at
}
