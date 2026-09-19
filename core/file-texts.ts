/**
 * `file_texts`（掃描讀出來的文件內容）這張表的存取。DDL 在 db.ts。
 *
 * **這是快取，不是事實**（跟 `cleanup_image_sigs` 同一個規矩）：讀的時候的 size 與 mtime
 * 一起存，任一個跟現在的檔對不上就重讀 —— mtime 精度只到毫秒，同一秒內改內容而大小一樣，
 * 只看 mtime 會漏掉。
 *
 * **讀不懂的檔也留一列**（`text` 是 NULL、`reason` 寫原因）。這不是為了記帳：
 * 沒有這一列的話，一個壞掉的 PDF 每一輪掃描都會再被丟進 worker 一次。
 *
 * **裡面是使用者檔案的內容**。送去模型之前要擋什麼（密碼、金鑰、對帳單）是 P2 的事；
 * 這一層只負責存，而資料庫的權限跟家目錄一樣（db.ts 的 lockDown：資料夾 0700、檔案 0600）。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { TextKind } from './read-text.ts'

export type FileTextRow = {
  item_id: string
  kind: TextKind
  /** 讀得懂才有，最多 STORE_MAX_CHARS 個字 */
  text: string | null
  /** 截斷前原本讀到幾個字 */
  chars: number
  truncated: number
  has_text: number
  pages: number | null
  unmapped: number | null
  reason: string | null
  size: number
  mtime: string
  at: string
}

/**
 * 留幾列。每一列最多 4000 個字（中文約 12 KB），5000 列約 60 MB ——
 * 跟長相指紋一樣，這個專案從來不刪 `file_items` 的列，沒有上限就會一輩子長下去。
 */
export const MAX_FILE_TEXTS = 5000

/** 這個檔已經讀過、而且那次讀的 size／mtime 跟現在一樣嗎。 */
export function fileTextFresh(db: DatabaseSync, itemId: string, size: number, mtimeIso: string): boolean {
  const row = db.prepare('SELECT size, mtime FROM file_texts WHERE item_id=?').get(itemId) as
    { size: number; mtime: string } | undefined
  return Boolean(row && Number(row.size) === size && row.mtime === mtimeIso)
}

/** 一個檔讀到的內容（沒讀過回 null）。**P2 就是從這裡拿內容。** */
export function fileTextOf(db: DatabaseSync, itemId: string): FileTextRow | null {
  return (db.prepare('SELECT * FROM file_texts WHERE item_id=?').get(itemId) as FileTextRow | undefined) ?? null
}

/** 照真路徑拿（P2 與 CLI 方便用）。 */
export function fileTextByPath(db: DatabaseSync, path: string): FileTextRow | null {
  return (db.prepare(
    'SELECT t.* FROM file_texts t JOIN file_items i ON i.id=t.item_id WHERE i.path=?'
  ).get(path) as FileTextRow | undefined) ?? null
}

/** 寫一列（同一個 item 就蓋掉上一次的）。 */
export function putFileText(db: DatabaseSync, row: FileTextRow): void {
  db.prepare(
    `INSERT INTO file_texts (item_id,kind,text,chars,truncated,has_text,pages,unmapped,reason,size,mtime,at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(item_id) DO UPDATE SET
       kind=excluded.kind, text=excluded.text, chars=excluded.chars, truncated=excluded.truncated,
       has_text=excluded.has_text, pages=excluded.pages, unmapped=excluded.unmapped,
       reason=excluded.reason, size=excluded.size, mtime=excluded.mtime, at=excluded.at`
  ).run(
    row.item_id, row.kind, row.text, row.chars, row.truncated, row.has_text,
    row.pages, row.unmapped, row.reason, row.size, row.mtime, row.at,
  )
}

/**
 * 收掉不再需要的內容。條件跟 `sweepImageSigs` 一樣：
 * 1. 對應的 `file_items` 不在了（理論上不會發生，留著當保險）
 * 2. 檔案已經不在原位（missing、quarantined）—— 放回來會重讀，成本是一次解析
 * 3. 超過上限（MAX_FILE_TEXTS）時，留最近讀的那些
 */
export function sweepFileTexts(db: DatabaseSync): void {
  db.exec(
    `DELETE FROM file_texts WHERE item_id NOT IN (SELECT id FROM file_items);
     DELETE FROM file_texts WHERE item_id IN
       (SELECT id FROM file_items WHERE status IN ('missing','quarantined'));`
  )
  db.prepare(
    `DELETE FROM file_texts WHERE item_id IN (
       SELECT item_id FROM file_texts ORDER BY at DESC, item_id LIMIT -1 OFFSET ?)`
  ).run(MAX_FILE_TEXTS)
}
