/** The only production module allowed to delete files. No recursive deletion.
 * Only verified, journaled content under the configured quarantine may be removed,
 * seven days after the move completed, with a short-lived second confirmation.
 */
import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, unlinkSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import {
  activeQuarantine, checkedQuarantinePath, checkOptions, fingerprint, moveFingerprint,
  quarantineCompletedAt, RETENTION_MS, type ExecOptions, type StoppedEarly,
} from './cleanup-exec.ts'
import { CleanupError, cleanupProblem, transaction, withCleanupLock, type JournalRow } from './cleanup-journal.ts'

function eligible(db: DatabaseSync, seq: number): boolean {
  return Date.now() - Date.parse(quarantineCompletedAt(db, seq)) >= RETENTION_MS
}

/**
 * **收掉「自己剛剛用 'wx' 建的 0 byte 佔位檔」**（稽核第三輪 R3-5）。刪掉回 true，其他一律 false。
 *
 * 為什麼這個例外是安全的，而且非放在這一支不可：
 * - putBack（cleanup-exec.ts）搬回原位失敗時，會把自己幾微秒前在使用者資料夾建的空檔留在那裡 ——
 *   檔名跟原檔一模一樣、內容是空的、權限還從 0644 變成 0600。使用者點開是空的、多半直接刪掉它，
 *   而真正的內容還在隔離區；下一次掃描更會把它當成「空檔」預設打勾，下一次清理就搬走這個假檔。
 * - 刪的**不是使用者的資料**：走到這裡的前提是這個 inode 是 ContextBox 自己建的、從來沒有內容。
 * - 所以條件開到最緊：`expect` 的 dev／ino／mtime 要完全等於現在 lstat 到的，而且必須是
 *   一般檔、nlink 是 1、大小是 0。有任何一項對不上（有人在那一瞬間換成別的檔、有人寫了東西進去、
 *   換成捷徑或資料夾、根本不存在）就**什麼都不做**。
 * - 再用 O_NOFOLLOW 開一次、fstat 複驗同一個 inode，把 lstat 與 unlink 之間的縫再縮小一點。
 * - 「只搬不刪」的白名單在 test/repo.test.mjs；這一支與清空的 unlink 是**全專案僅有的兩處**。
 */
export function dropReservation(reservation: string, expect: { dev: number; ino: number; mtime: string }): boolean {
  if (!expect || !Number.isFinite(expect.dev) || !Number.isFinite(expect.ino) || typeof expect.mtime !== 'string') return false
  const matches = (st: { isFile(): boolean; nlink: number; size: number; dev: number; ino: number; mtime: Date }) =>
    st.isFile() && st.nlink === 1 && st.size === 0
    && st.dev === expect.dev && st.ino === expect.ino && st.mtime.toISOString() === expect.mtime
  let st
  try { st = lstatSync(reservation) } catch { return false }
  if (!matches(st)) return false
  try {
    const fd = openSync(reservation, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try { if (!matches(fstatSync(fd))) return false } finally { closeSync(fd) }
  } catch { return false }
  unlinkSync(reservation)
  return true
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

/**
 * 上一批清空做到一半就停了（鎖被接走、行程被砍）、還沒收掉的進度：總共已經永久刪掉幾個（稽核第三輪 R3-13）。
 *
 * 以前這個數字只有「同一個確認碼、五分鐘內重送」讀得到：被 BUSY 打斷通常表示另一個動作正在跑，
 * 使用者回來時確認碼早就過期，emptyQuarantine 先丟 CONFIRMATION_EXPIRED、根本走不到讀進度那一行 ——
 * 「上次已經永久刪掉 3 個」就再也沒有任何路徑講得出來。現在下一次預覽會講。
 * 進度列跟著它的預覽一起被 pruneEmptyRequests 清掉（過期滿一天）。
 */
function unfinishedDeletes(db: DatabaseSync): { count: number; bytes: number } {
  let count = 0
  let bytes = 0
  for (const r of db.prepare('SELECT result FROM cleanup_empty_progress').all() as { result: string }[]) {
    try {
      const x = JSON.parse(r.result) as EmptyResult
      count += Number(x?.deletedCount) || 0
      bytes += Number(x?.deletedBytes) || 0
    } catch { /* 讀不懂的那一列就不算 */ }
  }
  return { count, bytes }
}

/** First click: preview and bind a token to exactly these journal entries. */
export function prepareEmptyQuarantine(db: DatabaseSync, opts: ExecOptions) {
  checkOptions(opts)
  return withCleanupLock(db, () => {
    try { pruneEmptyRequests(db) } catch (e: any) {
      // 清不掉只是表多幾列，不可以讓預覽本身失敗
      console.error('[contextbox] could not clear old empty-preview rows:', e?.message ?? e)
    }
    const entries = activeQuarantine(db).filter(r => !restoring(db, r) && eligible(db, r.seq))
    const token = randomUUID()
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()
    db.prepare('INSERT INTO cleanup_empty_requests(token,expires_at,entries) VALUES (?,?,?)')
      .run(token, expiresAt, JSON.stringify(entries.map(r => r.seq)))
    // 上一批被打斷、還沒收掉的進度（R3-13）：有才帶，沒有就不要多一個永遠是 0 的欄位
    const previous = unfinishedDeletes(db)
    return { token, expiresAt, itemCount: entries.length,
      bytes: entries.reduce((n, r) => n + moveFingerprint(db, r.seq).size, 0),
      ...(previous.count ? { previousDeleted: previous } : {}),
      message: 'These files have been in quarantine for seven days. Confirm again and they are deleted for good.' }
  })
}

/**
 * `setAside`：**不刪、但也不算錯**的那些（稽核第三輪）。
 * 隔離區那個檔的內容跟當初搬進去的不一樣時，刪它等於刪一份我們沒驗證過的東西 —— 不做。
 * 但以前它被記成 error：清空從此固定回離開碼 3，隔離區永遠清不空，使用者被關在迴圈裡。
 * 現在把它放到一邊、照實講，讓使用者自己看一眼再決定（手動刪掉之後，下一次清空會自己收掉那一列）。
 */
type EmptyResult = {
  deletedCount: number; deletedBytes: number
  errors: { seq: number; error: string }[]
  setAside: { seq: number; why: string }[]
}
/** 回給呼叫端的形狀：多 `noop`（這次什麼都沒做）與 `stoppedEarly`（鎖被接走，停在半路）。 */
type EmptyReply = EmptyResult & { noop: boolean; stoppedEarly?: StoppedEarly }

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
    throw new CleanupError('CONFIRMATION_REQUIRED', 'Preview first, then confirm emptying quarantine.')
  }
  return withCleanupLock(db, renew => {
    const request = db.prepare('SELECT * FROM cleanup_empty_requests WHERE token=?').get(opts.token) as
      { expires_at: string; entries: string; result: string | null } | undefined
    if (!request) throw new CleanupError('CONFIRMATION_REQUIRED', 'That confirmation code is not valid. Run the preview again.')
    // 重送已經做完的那一次：原樣回傳，**但講清楚這次一個檔都沒刪**（稽核第三輪 R3-2）
    if (request.result) return { ...JSON.parse(request.result), noop: true } as EmptyReply
    const progress = db.prepare('SELECT next, result FROM cleanup_empty_progress WHERE token=?').get(opts.token) as
      { next: number; result: string } | undefined
    if (Date.now() >= Date.parse(request.expires_at)) {
      // **過期也要把已經刪掉幾個講出來**（R3-13）：以前這一行排在讀進度之前，那個數字就此消失
      const already = progress ? Number((JSON.parse(progress.result) as EmptyResult)?.deletedCount) || 0 : 0
      throw new CleanupError('CONFIRMATION_EXPIRED',
        already ? `That confirmation code has expired. Run the preview again. The previous batch already deleted ${already}.` : 'That confirmation code has expired. Run the preview again.')
    }
    let result: EmptyResult = progress
      ? { setAside: [], ...JSON.parse(progress.result) as EmptyResult }
      : { deletedCount: 0, deletedBytes: 0, errors: [], setAside: [] }
    // **這一次自己刪了幾個**（不含接手過來的進度）：鎖被接走而這一次一個檔都沒刪時，
    // 回 stoppedEarly 會讓呼叫端把上一次的數字再報一次、離開碼也變成「做了一半」。
    // 那種情況等於「動作沒執行」，照舊丟 BUSY。
    let deletedHere = 0
    const saveProgress = (next: number, r: EmptyResult) => db.prepare(`INSERT INTO cleanup_empty_progress(token,next,result)
      VALUES (?,?,?) ON CONFLICT(token) DO UPDATE SET next=excluded.next, result=excluded.result`).run(opts.token, next, JSON.stringify(r))
    const seqs = JSON.parse(request.entries) as number[]
    let stopped: StoppedEarly | null = null
    for (let index = progress?.next ?? 0; index < seqs.length; index++) {
      const seq = seqs[index]
      // 每處理一項就續約（見 withCleanupLock）。**鎖被接走就停在這裡、不丟例外**（稽核第三輪 R3-3）：
      // 已經永久刪掉的要算進回傳，不然呼叫端會以為「什麼都沒發生」。進度留著，重送接得下去。
      try { renew() } catch (e) {
        if (!(e instanceof CleanupError) || e.code !== 'BUSY') throw e
        stopped = { why: e.message }
        break
      }
      opts.onProgress?.(index, seqs.length)
      const row = activeQuarantine(db).find(r => r.seq === seq)
      if (!row) continue // Restored or already purged since preview.
      // 預覽之後有人按了復原、復原到一半中斷：那個檔要留給「再按一次復原」
      if (restoring(db, row)) continue
      try {
        if (!eligible(db, seq)) throw new CleanupError('TOO_RECENT', 'This file has not been in quarantine for seven days yet, so it cannot be emptied.')
        const path = checkedQuarantinePath(db, row, opts)
        const expected = moveFingerprint(db, seq)
        const prior = db.prepare('SELECT status FROM cleanup_purges WHERE seq=?').get(seq) as { status: string } | undefined
        let missing = false
        try { lstatSync(path) } catch (e: any) { if (e.code === 'ENOENT') missing = true; else throw e }
        // 檔不在了（多半是使用者自己看過之後刪掉的）：它確實不在隔離區，把那一列收掉。
        // 以前一律丟 MISSING，於是那一列永遠留在清單上、清空永遠回錯（稽核第三輪）。
        if (missing && prior?.status !== 'started') {
          const at = new Date().toISOString()
          transaction(db, () => {
            db.prepare(`INSERT INTO cleanup_purges(seq,ts,status,error) VALUES (?,?,'done',?)
              ON CONFLICT(seq) DO UPDATE SET status='done',error=excluded.error`)
              .run(seq, at, 'By the time of the empty, this file was no longer in quarantine (deleted by hand?).')
            saveProgress(index + 1, { ...result, setAside: [...result.setAside,
              { seq, why: 'This file is no longer in quarantine (did you delete it?), so it was taken off the list.' }] })
          })
          result = { ...result, setAside: [...result.setAside,
            { seq, why: 'This file is no longer in quarantine (did you delete it?), so it was taken off the list.' }] }
          continue
        }
        if (!missing) {
          const actual = fingerprint(path, opts.maxBytes)
          if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size
              || actual.mtime !== expected.mtime || actual.sha256 !== expected.sha256) {
            // 不刪（沒驗證過的內容不刪），但也不算錯：放到一邊、照實講，留給使用者自己看
            result = { ...result, setAside: [...result.setAside,
              { seq, why: 'This file no longer matches what was moved in, so it was not deleted. Have a look and decide yourself.' }] }
            saveProgress(index + 1, result)
            continue
          }
          // A committed deletion intent also makes a post-delete crash recoverable.
          db.prepare(`INSERT INTO cleanup_purges(seq,ts,status) VALUES (?,?,'started')
            ON CONFLICT(seq) DO UPDATE SET status='started',error=NULL`).run(seq, new Date().toISOString())
          checkedQuarantinePath(db, row, opts)
          const final = lstatSync(path)
          if (!final.isFile() || final.nlink !== 1 || final.dev !== actual.dev || final.ino !== actual.ino
              || final.size !== actual.size || final.mtime.toISOString() !== actual.mtime) {
            throw new CleanupError('CHANGED', 'The quarantined file changed, so it was not deleted.')
          }
          unlinkSync(path)
        }
        // 清空紀錄與進度一起寫：兩個之間被砍的話，重送會少算（紀錄說刪了、進度說還沒）
        const next = { ...result, deletedCount: result.deletedCount + 1, deletedBytes: result.deletedBytes + expected.size }
        deletedHere++
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
    // 停在半路就**不要**把它記成「這個確認碼的最終結果」：同一個確認碼重送才接得下去
    if (stopped) {
      if (!deletedHere) throw new CleanupError('BUSY', stopped.why)
      return { ...result, noop: false, stoppedEarly: stopped }
    }
    transaction(db, () => {
      db.prepare('UPDATE cleanup_empty_requests SET result=? WHERE token=?').run(JSON.stringify(result), opts.token)
      db.prepare('DELETE FROM cleanup_empty_progress WHERE token=?').run(opts.token)
    })
    return { ...result, noop: false }
  })
}
