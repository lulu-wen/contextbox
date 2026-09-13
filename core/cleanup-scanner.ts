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
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { DENY_DIRS, DENY_FILES } from './guard.ts'
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

export function cleanupWalk(root: string, maxDepth = 3, maxFiles = 5000): { files: string[]; truncated: boolean } {
  const files: string[] = []
  let truncated = false
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]

  while (stack.length) {
    if (files.length >= maxFiles) { truncated = true; break }
    const cur = stack.pop()!
    let entries
    try { entries = readdirSync(cur.dir, { withFileTypes: true }) } catch { continue }
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
  catch { return { error: '檔案不見了', missing: true } }
  if (st.isSymbolicLink()) return null
  if (!st.isFile()) return null

  let real: string
  try { real = realpathSync(path) }
  catch { return { error: 'realpath 失敗' } }

  const roots = opts.roots.map(r => {
    try { return realpathSync(r) } catch { return resolve(r) }
  })
  if (!roots.some(r => under(r, real))) return null

  const denied = isDeniedPath(real)
  if (denied) return null

  let realStat
  try { realStat = lstatSync(real) }
  catch { return { error: '讀不到這個檔案', missing: true } }
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

function markPathMissing(db: DatabaseSync, path: string, nowIso: string) {
  waitForDb(() => db.prepare(
    `UPDATE file_items SET status='missing', error='檔案不見了', last_seen_at=? WHERE path=?`
  ).run(nowIso, path))
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

function dismissStaleCandidates(db: DatabaseSync, itemId: string, keepKinds: string[]) {
  const placeholders = keepKinds.map(() => '?').join(',')
  const args = keepKinds.length ? [itemId, CLEANUP_RULE_VERSION, ...keepKinds] : [itemId, CLEANUP_RULE_VERSION]
  const sql = keepKinds.length
    ? `UPDATE cleanup_candidates SET status='dismissed'
       WHERE item_id=? AND rule_version=? AND status='proposed' AND kind NOT IN (${placeholders})`
    : `UPDATE cleanup_candidates SET status='dismissed'
       WHERE item_id=? AND rule_version=? AND status='proposed'`
  waitForDb(() => db.prepare(sql).run(...args))
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
    const r = cleanupWalk(root, opts.maxDepth ?? 3, opts.maxFiles ?? 5000)
    files.push(...r.files)
    truncated = truncated || r.truncated
  }
  return { files: [...new Set(files)], truncated }
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
      if (inspected.missing) markPathMissing(opts.db, path, nowIso)
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
      dismissStaleCandidates(opts.db, item.id, [])
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
    dismissStaleCandidates(opts.db, item.id, drafts.map(d => d.kind))
    const current = candidatesFor(opts.db, item.id)
    if (current.length) {
      setItemStatus(opts.db, item.id, 'candidate')
      result.candidates += current.length
    } else {
      setItemStatus(opts.db, item.id, error ? 'kept' : 'kept', error)
    }
  }

  addDuplicateCandidates(opts.db, nowIso, touched)
  result.candidates = (opts.db.prepare(
    `SELECT count(*) n FROM cleanup_candidates WHERE status='proposed' AND rule_version=?`
  ).get(CLEANUP_RULE_VERSION) as { n: number }).n

  return result
}

export function addDuplicateCandidates(db: DatabaseSync, nowIso = new Date().toISOString(), onlyItemIds?: string[]) {
  const groups = db.prepare(
    `SELECT sha256, count(*) n FROM file_items
     WHERE sha256 IS NOT NULL AND status NOT IN ('quarantined','missing','error')
     GROUP BY sha256 HAVING count(*) > 1`
  ).all() as { sha256: string; n: number }[]

  const only = onlyItemIds ? new Set(onlyItemIds) : null
  for (const g of groups) {
    const rows = db.prepare(
      `SELECT * FROM file_items WHERE sha256=? AND status NOT IN ('quarantined','missing','error')
       ORDER BY first_seen_at, path`
    ).all(g.sha256) as CleanupFileItem[]
    const keep = rows[0]
    for (const item of rows.slice(1)) {
      if (only && !only.has(item.id)) continue
      upsertCandidate(db, item.id, duplicateDraft(rows.length), nowIso)
      setItemStatus(db, item.id, 'candidate')
    }
    if (keep) dismissDuplicateIfNoLongerNeeded(db, keep.id)
  }
}

function dismissDuplicateIfNoLongerNeeded(db: DatabaseSync, itemId: string) {
  waitForDb(() => db.prepare(
    `UPDATE cleanup_candidates SET status='dismissed'
     WHERE item_id=? AND kind='duplicate' AND rule_version=? AND status='proposed'`
  ).run(itemId, CLEANUP_RULE_VERSION))
}
