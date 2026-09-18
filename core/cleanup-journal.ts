import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { DENY_DIRS, DENY_FILES } from './guard.ts'

export class CleanupError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'CleanupError'
    this.code = code
  }
}

/**
 * 執行層**不收**的副檔名。**全專案只有這一份**：cleanup-exec.ts 拿它擋、
 * 也從那裡匯出；cleanup-rules.ts 與 scanner 拿它決定「不提議」。
 *
 * 以前規則會提議 `desktop.ini`、`shortcut.url` 這種檔，執行層每次都拒收，
 * 計畫永遠停在 partial／error —— 列得出、勾得起、建得了計畫、永遠搬不動。
 *
 * 為什麼放在這裡而不是 cleanup-exec.ts 本體：規則模組 import exec 會拉出
 * rules → exec → plans → routes → rules 的循環 import，哪天有人在 routes 的
 * 模組頂層用到規則的常數，`node --test test/cleanup-rules.test.mjs` 就會
 * TDZ 爆掉。這一支是葉模組（只 import guard），誰 import 都安全。
 */
export const EXEC_PROTECTED_EXT: readonly string[] = Object.freeze([
  '.db', '.sqlite', '.sqlite3', '.pem', '.key', '.p12', '.pfx', '.ini', '.cfg', '.conf', '.lnk', '.url',
])

/**
 * 執行層會不會因為**檔名本身**拒收（回 PROTECTED）。不分大小寫。
 * 隱藏檔、檔名就叫 `credentials`／`token` 這種、`.env`／`id_rsa.*`、受保護副檔名。
 * 路徑上的資料夾另外由呼叫端檢查。
 */
export function execRefusesName(name: string): boolean {
  const n = String(name).toLowerCase()
  return n.startsWith('.')
    || DENY_DIRS.includes(n)
    || DENY_FILES.some(f => n === f || n.startsWith(f + '.'))
    || EXEC_PROTECTED_EXT.some(ext => n.endsWith(ext))
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

/** 鎖拿了超過這麼久就當成殘留。清理動作是秒到分鐘級，三十分鐘還沒放就是當掉了。 */
export const STALE_LOCK_MS = 30 * 60_000

/** owner 的格式：`<ISO 時間> <uuid>`。時間是拿鎖的那一刻。 */
function lockOwner(): string {
  return `${new Date().toISOString()} ${randomUUID()}`
}

/** 讀出 owner 裡的拿鎖時間；舊格式（只有 uuid）或看不懂的回 null。 */
function lockTakenAt(owner: unknown): number | null {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) /.exec(String(owner ?? ''))
  const t = m ? Date.parse(m[1]) : NaN
  return Number.isFinite(t) ? t : null
}

/** Serialize B operations across processes without keeping journal writes uncommitted.
 * A dead process's lock can be reclaimed; a live or inaccessible PID fails closed.
 *
 * **pid 還活著不代表鎖還有效。** 行程當掉之後 pid 會被別的程式重用，
 * 只看 pid 的話那把鎖永遠拿不回來，每個清理動作都回 BUSY。所以 owner 帶
 * 拿鎖的時間，超過 STALE_LOCK_MS（前後都算，時鐘被往回調也一樣）視為殘留。
 * 沒有時間戳的舊格式照舊只看 pid（fail closed）。
 */
export function withCleanupLock<T>(db: DatabaseSync, fn: () => T): T {
  initCleanup(db)
  const owner = lockOwner()
  transaction(db, () => {
    const lock = db.prepare('SELECT pid, owner FROM cleanup_operation_lock WHERE singleton=1').get() as
      { pid: number; owner: string } | undefined
    if (lock) {
      let dead = false
      try { process.kill(lock.pid, 0) } catch (e: any) { dead = e?.code === 'ESRCH' }
      const at = lockTakenAt(lock.owner)
      const expired = at !== null && Math.abs(Date.now() - at) > STALE_LOCK_MS
      if (!dead && !expired) throw new CleanupError('BUSY', '另一個清理動作正在進行，請稍後重試。')
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
