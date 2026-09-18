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
import { CleanupError, cleanupProblem, transaction, withCleanupLock, type JournalRow } from './cleanup-journal.ts'

function eligible(db: DatabaseSync, seq: number): boolean {
  return Date.now() - Date.parse(quarantineCompletedAt(db, seq)) >= RETENTION_MS
}

/**
 * 這一項**復原到一半中斷**嗎（restore 的 journal 停在 started）。
 *
 * 那種檔可能還在隔離區，而畫面告訴使用者「再按一次復原會把它接完」——
 * 清空的時候刪掉它，那句話就變成謊話，而且檔案永久消失（第一波引進的退步）。
 * 預覽不算它；拿之前的確認碼來清空也跳過它。
 */
function restoring(db: DatabaseSync, row: JournalRow): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM cleanup_journal WHERE plan_id=? AND item_id=? AND op='restore'
    AND status='started' LIMIT 1`).get(row.plan_id, row.item_id))
}

/**
 * 過期超過一天的預覽列刪掉（RC28）。不然每按一次預覽就多一列，永遠不會少。
 * 以前只有 HTTP 路由會清，CLI 的預覽（每晚跑的腳本）照樣只增不減（稽核第二輪 R2-12）；
 * 放在這裡，誰預覽都一樣。過期不到一天的留著：重送會拿到「已過期」，而不是「確認碼無效」。
 * 做到一半的進度（cleanup_empty_progress）跟著它的預覽一起走。
 */
function pruneEmptyRequests(db: DatabaseSync) {
  db.prepare('DELETE FROM cleanup_empty_requests WHERE expires_at < ?')
    .run(new Date(Date.now() - 24 * 60 * 60_000).toISOString())
  db.prepare('DELETE FROM cleanup_empty_progress WHERE token NOT IN (SELECT token FROM cleanup_empty_requests)').run()
}

/** First click: preview and bind a token to exactly these journal entries. */
export function prepareEmptyQuarantine(db: DatabaseSync, opts: ExecOptions) {
  checkOptions(opts)
  return withCleanupLock(db, () => {
    try { pruneEmptyRequests(db) } catch (e: any) {
      // 清不掉只是表多幾列，不可以讓預覽本身失敗
      console.error('[contextbox] 清空預覽的舊紀錄清不掉：', e?.message ?? e)
    }
    const entries = activeQuarantine(db).filter(r => !restoring(db, r) && eligible(db, r.seq))
    const token = randomUUID()
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()
    db.prepare('INSERT INTO cleanup_empty_requests(token,expires_at,entries) VALUES (?,?,?)')
      .run(token, expiresAt, JSON.stringify(entries.map(r => r.seq)))
    return { token, expiresAt, itemCount: entries.length,
      bytes: entries.reduce((n, r) => n + moveFingerprint(db, r.seq).size, 0),
      message: '這些檔案已隔離七天。再次確認後會永久刪除，無法復原。' }
  })
}

type EmptyResult = { deletedCount: number; deletedBytes: number; errors: { seq: number; error: string }[] }

/**
 * Second click. Replays return the original result; unrelated/new files are excluded.
 *
 * **每處理完一項就把進度存起來**（cleanup_empty_progress，跟那一項的清空紀錄同一個交易）。
 * 以前結果要整個迴圈跑完才寫：中途被 BUSY 打斷（鎖被接走）時已經刪了幾個，同一個確認碼重送
 * 只數得到剩下的，報少了；確認碼過期之後就再也查不到（稽核第二輪 R2-6）。現在重送從停下來的
 * 那一項接著做，總數含之前刪掉的。過期的確認碼不會接著刪（照樣回「已過期」）。
 */
export function emptyQuarantine(db: DatabaseSync, opts: ExecOptions & { token: string; confirmed: boolean }) {
  checkOptions(opts)
  if (opts.confirmed !== true || typeof opts.token !== 'string' || !opts.token) {
    throw new CleanupError('CONFIRMATION_REQUIRED', '請先預覽，再次確認清空隔離區。')
  }
  return withCleanupLock(db, renew => {
    const request = db.prepare('SELECT * FROM cleanup_empty_requests WHERE token=?').get(opts.token) as
      { expires_at: string; entries: string; result: string | null } | undefined
    if (!request) throw new CleanupError('CONFIRMATION_REQUIRED', '清空確認無效，請重新預覽。')
    if (request.result) return JSON.parse(request.result)
    if (Date.now() >= Date.parse(request.expires_at)) throw new CleanupError('CONFIRMATION_EXPIRED', '清空確認已過期，請重新預覽。')
    const progress = db.prepare('SELECT next, result FROM cleanup_empty_progress WHERE token=?').get(opts.token) as
      { next: number; result: string } | undefined
    let result: EmptyResult = progress ? JSON.parse(progress.result) : { deletedCount: 0, deletedBytes: 0, errors: [] }
    const saveProgress = (next: number, r: EmptyResult) => db.prepare(`INSERT INTO cleanup_empty_progress(token,next,result)
      VALUES (?,?,?) ON CONFLICT(token) DO UPDATE SET next=excluded.next, result=excluded.result`).run(opts.token, next, JSON.stringify(r))
    const seqs = JSON.parse(request.entries) as number[]
    for (let index = progress?.next ?? 0; index < seqs.length; index++) {
      const seq = seqs[index]
      // 每處理一項就續約（見 withCleanupLock）
      renew()
      opts.onProgress?.(index, seqs.length)
      const row = activeQuarantine(db).find(r => r.seq === seq)
      if (!row) continue // Restored or already purged since preview.
      // 預覽之後有人按了復原、復原到一半中斷：那個檔要留給「再按一次復原」
      if (restoring(db, row)) continue
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
        // 清空紀錄與進度一起寫：兩個之間被砍的話，重送會少算（紀錄說刪了、進度說還沒）
        const next = { ...result, deletedCount: result.deletedCount + 1, deletedBytes: result.deletedBytes + expected.size }
        transaction(db, () => {
          db.prepare(`UPDATE cleanup_purges SET status='done',error=NULL WHERE seq=?`).run(seq)
          saveProgress(index + 1, next)
        })
        result = next
      } catch (e) {
        const error = cleanupProblem(e)
        // Do not overwrite a started intent: deletion may have succeeded before DB failure.
        result = { ...result, errors: [...result.errors, { seq, error }] }
        saveProgress(index + 1, result)
      }
    }
    transaction(db, () => {
      db.prepare('UPDATE cleanup_empty_requests SET result=? WHERE token=?').run(JSON.stringify(result), opts.token)
      db.prepare('DELETE FROM cleanup_empty_progress WHERE token=?').run(opts.token)
    })
    return result
  })
}
