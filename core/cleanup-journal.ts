import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

export class CleanupError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'CleanupError'
    this.code = code
  }
}

/** B-owned companion tables: keep A's schema intact; snapshots survive rescans. */
export function initCleanup(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cleanup_snapshots (
      plan_id TEXT NOT NULL REFERENCES cleanup_plans(id),
      item_id TEXT NOT NULL REFERENCES file_items(id),
      snapshot TEXT NOT NULL,
      PRIMARY KEY(plan_id,item_id)
    );
    CREATE TABLE IF NOT EXISTS cleanup_move_details (
      seq INTEGER PRIMARY KEY REFERENCES cleanup_journal(seq),
      fingerprint TEXT NOT NULL,
      reservation TEXT,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS cleanup_operation_lock (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, owner TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cleanup_empty_requests (
      token TEXT PRIMARY KEY, expires_at TEXT NOT NULL, entries TEXT NOT NULL, result TEXT
    );
    CREATE TABLE IF NOT EXISTS cleanup_plan_requests (
      request_id TEXT PRIMARY KEY, selection TEXT NOT NULL,
      plan_id TEXT NOT NULL REFERENCES cleanup_plans(id)
    );
    CREATE TABLE IF NOT EXISTS cleanup_purges (
      seq INTEGER PRIMARY KEY REFERENCES cleanup_journal(seq),
      ts TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('started','done','failed')), error TEXT
    );
  `)
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = fn()
    db.exec('COMMIT')
    return value
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** Serialize B operations across processes without keeping journal writes uncommitted.
 * A dead process's lock can be reclaimed; a live or inaccessible PID fails closed.
 */
export function withCleanupLock<T>(db: DatabaseSync, fn: () => T): T {
  initCleanup(db)
  const owner = randomUUID()
  transaction(db, () => {
    const lock = db.prepare('SELECT pid FROM cleanup_operation_lock WHERE singleton=1').get() as { pid: number } | undefined
    if (lock) {
      let dead = false
      try { process.kill(lock.pid, 0) } catch (e: any) { dead = e?.code === 'ESRCH' }
      if (!dead) throw new CleanupError('BUSY', '另一個清理動作正在進行，請稍後重試。')
    }
    db.prepare('INSERT OR REPLACE INTO cleanup_operation_lock VALUES (1,?,?)').run(process.pid, owner)
  })
  try { return fn() }
  finally { db.prepare('DELETE FROM cleanup_operation_lock WHERE singleton=1 AND owner=?').run(owner) }
}

export type JournalRow = {
  seq: number; ts: string; plan_id: string; item_id: string
  op: 'quarantine' | 'restore' | 'skip'
  from_path: string; to_path: string; sha256: string
  status: 'started' | 'done' | 'failed' | 'reverted'; error: string | null
}

export function listJournal(db: DatabaseSync, planId: string): JournalRow[] {
  return db.prepare('SELECT * FROM cleanup_journal WHERE plan_id=? ORDER BY seq').all(planId) as JournalRow[]
}

/** Never expose OS error messages (which contain absolute paths) through the API. */
export function cleanupProblem(e: any): string {
  if (e instanceof CleanupError) return e.message
  if (e?.code === 'ENOENT') return '檔案或資料夾不見了，請確認後重試。'
  if (e?.code === 'EACCES' || e?.code === 'EPERM') return '沒有權限搬動這個檔案，請確認權限後重試。'
  if (e?.code === 'EXDEV') return '來源與隔離區位於不同磁碟，無法安全搬移；原檔仍保留。'
  return '清理動作失敗，檔案仍可追蹤，請重試。'
}
