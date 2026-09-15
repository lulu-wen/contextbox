/** The only production module allowed to delete files. No recursive deletion.
 * Only verified, journaled content under the configured quarantine may be removed,
 * seven days after the move completed, with a short-lived second confirmation.
 */
import { randomUUID } from 'node:crypto'
import { lstatSync, unlinkSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import {
  activeQuarantine, checkedQuarantinePath, checkOptions, fingerprint, moveFingerprint,
  quarantineCompletedAt, RETENTION_MS, type ExecOptions,
} from './cleanup-exec.ts'
import { CleanupError, cleanupProblem, withCleanupLock } from './cleanup-journal.ts'

function eligible(db: DatabaseSync, seq: number): boolean {
  return Date.now() - Date.parse(quarantineCompletedAt(db, seq)) >= RETENTION_MS
}

/** First click: preview and bind a token to exactly these journal entries. */
export function prepareEmptyQuarantine(db: DatabaseSync, opts: ExecOptions) {
  checkOptions(opts)
  return withCleanupLock(db, () => {
    const entries = activeQuarantine(db).filter(r => eligible(db, r.seq))
    const token = randomUUID()
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()
    db.prepare('INSERT INTO cleanup_empty_requests(token,expires_at,entries) VALUES (?,?,?)')
      .run(token, expiresAt, JSON.stringify(entries.map(r => r.seq)))
    return { token, expiresAt, itemCount: entries.length,
      bytes: entries.reduce((n, r) => n + moveFingerprint(db, r.seq).size, 0),
      message: '這些檔案已隔離七天。再次確認後會永久刪除，無法復原。' }
  })
}

/** Second click. Replays return the original result; unrelated/new files are excluded. */
export function emptyQuarantine(db: DatabaseSync, opts: ExecOptions & { token: string; confirmed: boolean }) {
  checkOptions(opts)
  if (opts.confirmed !== true || typeof opts.token !== 'string' || !opts.token) {
    throw new CleanupError('CONFIRMATION_REQUIRED', '請先預覽，再次確認清空隔離區。')
  }
  return withCleanupLock(db, () => {
    const request = db.prepare('SELECT * FROM cleanup_empty_requests WHERE token=?').get(opts.token) as
      { expires_at: string; entries: string; result: string | null } | undefined
    if (!request) throw new CleanupError('CONFIRMATION_REQUIRED', '清空確認無效，請重新預覽。')
    if (request.result) return JSON.parse(request.result)
    if (Date.now() >= Date.parse(request.expires_at)) throw new CleanupError('CONFIRMATION_EXPIRED', '清空確認已過期，請重新預覽。')
    const result: { deletedCount: number; deletedBytes: number; errors: { seq: number; error: string }[] } =
      { deletedCount: 0, deletedBytes: 0, errors: [] }
    for (const seq of JSON.parse(request.entries) as number[]) {
      const row = activeQuarantine(db).find(r => r.seq === seq)
      if (!row) continue // Restored or already purged since preview.
      try {
        if (!eligible(db, seq)) throw new CleanupError('TOO_RECENT', '檔案隔離未滿七天，無法清空。')
        const path = checkedQuarantinePath(db, row, opts)
        const expected = moveFingerprint(db, seq)
        const prior = db.prepare('SELECT status FROM cleanup_purges WHERE seq=?').get(seq) as { status: string } | undefined
        let missing = false
        try { lstatSync(path) } catch (e: any) { if (e.code === 'ENOENT') missing = true; else throw e }
        if (missing && prior?.status !== 'started') throw new CleanupError('MISSING', '隔離檔案不見了，請人工檢查。')
        if (!missing) {
          const actual = fingerprint(path, opts.maxBytes)
          if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size
              || actual.mtime !== expected.mtime || actual.sha256 !== expected.sha256) {
            throw new CleanupError('CHANGED', '隔離檔案已變更，沒有刪除。')
          }
          // A committed deletion intent also makes a post-delete crash recoverable.
          db.prepare(`INSERT INTO cleanup_purges(seq,ts,status) VALUES (?,?,'started')
            ON CONFLICT(seq) DO UPDATE SET status='started',error=NULL`).run(seq, new Date().toISOString())
          checkedQuarantinePath(db, row, opts)
          const final = lstatSync(path)
          if (!final.isFile() || final.nlink !== 1 || final.dev !== actual.dev || final.ino !== actual.ino
              || final.size !== actual.size || final.mtime.toISOString() !== actual.mtime) {
            throw new CleanupError('CHANGED', '隔離檔案已變更，沒有刪除。')
          }
          unlinkSync(path)
        }
        db.prepare(`UPDATE cleanup_purges SET status='done',error=NULL WHERE seq=?`).run(seq)
        result.deletedCount++
        result.deletedBytes += expected.size
      } catch (e) {
        const error = cleanupProblem(e)
        // Do not overwrite a started intent: deletion may have succeeded before DB failure.
        result.errors.push({ seq, error })
      }
    }
    db.prepare('UPDATE cleanup_empty_requests SET result=? WHERE token=?').run(JSON.stringify(result), opts.token)
    return result
  })
}
