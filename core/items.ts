/**
 * items —— 進來的東西。
 *
 * 一個 item 就是「硬碟上某一個檔案，在某一刻被我們看到」。
 * 它只記事實：路徑、指紋、大小、狀態。**對內容的理解在 understanding 表**，
 * 因為理解會重做（換模型、重新問一次），但「這個檔案存在」不會。
 *
 * 兩個設計決定：
 *   1. **path 是唯一鍵。** 同一個檔案被看到兩次不會變成兩列。
 *      搬走之後我們自己更新 path，不會變成孤兒。
 *   2. **sha256 拿來共用理解，不拿來去重。** 同一張截圖存兩份是很常見的事
 *      （下載一次、截圖一次），兩份都是真的檔案，都該出現在收件匣；
 *      但第二份不用再問一次模型，直接沿用第一份的理解。
 */
import { createHash } from 'node:crypto'
import { openSync, fstatSync, readFileSync, closeSync, constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ItemKind, Fingerprint, Verdict } from './guard.ts'

export type ItemStatus = 'new' | 'understanding' | 'proposed' | 'applied' | 'ignored' | 'error'

export type Item = {
  id: string
  path: string
  sha256: string
  kind: ItemKind
  mime: string
  bytes: number
  mtime: string
  seen_at: string
  status: ItemStatus
  error: string | null
}

/** guard 放行的那個東西。直接吃 admit() 的回傳，不要自己拼一個。 */
export type Admitted = Extract<Verdict, { ok: true }>

/** Windows 沒有 O_NOFOLLOW，那裡就退回普通開檔 */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0

/** 檔案在檢查之後被換掉了。呼叫端要分得出這個跟「讀不到」不一樣。 */
export class SwappedError extends Error {
  constructor(path: string) {
    super(`${basename(path)} was swapped out after the check, so this copy is not taken in`)
    this.name = 'SwappedError'
  }
}

/**
 * 檔案指紋。
 *
 * **一定要帶 expect 進來。** guard 檢查的是「那一瞬間的那個 inode」，
 * 但真正被讀、被雜湊、被記進資料庫的是之後才重新解析的路徑。
 * 中間那個窗口可以把檔案換成指向 ~/.ssh 的捷徑 —— 稽查實測過，
 * 入庫的 sha256 會等於私鑰的 sha256。
 *
 * 兩道鎖：`O_NOFOLLOW` 讓換成捷徑這招直接開檔失敗；
 * 開完之後用 `fstat` 比對 dev／ino／大小／時間，確認還是同一個東西。
 * 20MB 上限由 guard 擋在前面，所以一次讀完沒問題。
 */
export function sha256Of(path: string, expect?: Fingerprint): string {
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | NOFOLLOW) }
  catch (e: any) {
    // ELOOP＝被換成捷徑了，這不是「讀不到」，是有人在動手腳
    if (e && (e.code === 'ELOOP' || e.code === 'EMLINK')) throw new SwappedError(path)
    throw e
  }
  try {
    const st = fstatSync(fd)
    if (expect) {
      // exFAT 與部分網路磁碟的 ino 恆為 0。兩邊都 0 的話這一條等於沒比，
      // 只剩 size 與 mtime —— 那兩個攻擊者都改得動。量不出身分就不收。
      if (!st.ino && !expect.ino) throw new SwappedError(path)
      if (st.dev !== expect.dev || st.ino !== expect.ino
          || st.size !== expect.size || st.mtimeMs !== expect.mtimeMs) {
        throw new SwappedError(path)
      }
    }
    if (st.nlink > 1) throw new SwappedError(path)
    return createHash('sha256').update(readFileSync(fd)).digest('hex')
  } finally {
    closeSync(fd)
  }
}

export class Items {
  db: DatabaseSync
  constructor(db: DatabaseSync) { this.db = db }

  get(id: string): Item | null {
    return (this.db.prepare(`SELECT * FROM items WHERE id=?`).get(id) as Item) ?? null
  }

  byPath(path: string): Item | null {
    return (this.db.prepare(`SELECT * FROM items WHERE path=?`).get(path) as Item) ?? null
  }

  /** 同一份內容的其他 item。拿來共用理解，不拿來去重。 */
  bySha(sha: string, exceptId?: string): Item[] {
    return (this.db.prepare(
      `SELECT * FROM items WHERE sha256=? AND id != ? ORDER BY seen_at`
    ).all(sha, exceptId ?? '') as Item[])
  }

  list(status?: ItemStatus, limit = 200): Item[] {
    return status
      ? (this.db.prepare(
          `SELECT * FROM items WHERE status=? ORDER BY seen_at DESC LIMIT ?`
        ).all(status, limit) as Item[])
      : (this.db.prepare(
          `SELECT * FROM items ORDER BY seen_at DESC LIMIT ?`
        ).all(limit) as Item[])
  }

  counts(): Record<string, number> {
    const rows = this.db.prepare(
      `SELECT status, count(*) n FROM items GROUP BY status`
    ).all() as { status: string; n: number }[]
    const out: Record<string, number> = {}
    for (const r of rows) out[r.status] = r.n
    return out
  }

  /** 最後一次收到東西是什麼時候。健康列用得到。 */
  lastSeen(): string | null {
    const r = this.db.prepare(`SELECT max(seen_at) t FROM items`).get() as { t: string | null }
    return r?.t ?? null
  }

  /**
   * 收一個檔案進來。
   *
   * 已經看過同一個路徑的話不新增：
   *   - 內容沒變（sha 一樣）→ 原封不動回傳舊的那一列
   *   - 內容變了 → 更新指紋，狀態退回 new，**理解、全文索引、還沒執行的提案
   *     全部作廢**。舊提案裡的「搬到哪、改什麼名字」是照舊內容算的，
   *     留著的話下一期按同意就會把新內容搬到舊提案的位置。
   * 回 { item, fresh }：fresh 代表值得往下送給模型。
   */
  add(v: Admitted, status: ItemStatus = 'new'): { item: Item; fresh: boolean } {
    const sha = sha256Of(v.real, v)
    const now = new Date().toISOString()
    const existing = this.byPath(v.real)

    if (existing && existing.sha256 === sha) return { item: existing, fresh: false }

    // 用 upsert 而不是先查再插：兩個行程同時收同一個檔的時候，
    // check-then-insert 會撞 UNIQUE 丟例外，而那個例外在 watcher 裡
    // 會被當成「處理失敗」。
    const id = existing?.id ?? randomUUID()
    this.db.prepare(
      `INSERT INTO items (id,path,sha256,kind,mime,bytes,mtime,seen_at,status,error)
       VALUES (?,?,?,?,?,?,?,?,?,NULL)
       ON CONFLICT(path) DO UPDATE SET
         sha256=excluded.sha256, bytes=excluded.bytes, mtime=excluded.mtime,
         seen_at=excluded.seen_at, status=excluded.status, error=NULL`
    ).run(id, v.real, sha, v.kind, v.mime, v.bytes, v.mtime, now, status)

    const item = this.byPath(v.real)!
    if (existing) this.invalidate(item.id)
    return { item, fresh: true }
  }

  /** 內容換了，之前對它的一切都不算數 */
  private invalidate(id: string) {
    this.db.prepare(`DELETE FROM understanding WHERE item_id=?`).run(id)
    this.db.prepare(`DELETE FROM items_fts WHERE item_id=?`).run(id)
    this.db.prepare(`UPDATE plans SET status='dismissed' WHERE item_id=? AND status='proposed'`).run(id)
  }

  setStatus(id: string, status: ItemStatus, error?: string | null): Item {
    this.db.prepare(`UPDATE items SET status=?, error=? WHERE id=?`).run(status, error ?? null, id)
    const it = this.get(id)
    if (!it) throw new Error(`No such item: ${id}`)
    return it
  }

  /** 檔案被搬走或改名之後，把路徑更新。內容沒變所以 sha 不動。 */
  setPath(id: string, path: string): Item {
    if (!this.get(id)) throw new Error(`No such item: ${id}`)
    const clash = this.byPath(path)
    if (clash && clash.id !== id) throw new Error(`${path} already belongs to another item, so it is not overwritten`)
    this.db.prepare(`UPDATE items SET path=? WHERE id=?`).run(path, id)
    // 檔名進得了全文搜尋，改名之後要跟著更新
    this.db.prepare(`UPDATE items_fts SET name=? WHERE item_id=?`).run(basename(path), id)
    return this.get(id)!
  }
}
