/**
 * 替沒取名的檔改名（P3）—— **一定要人按過，而且改得回來**。
 *
 * 上游：P1 標了 `naming`（untitled／generic／named），P2 的模型給了 `suggestedName`、
 * `course`、`topic`、`confidence`、`evidence`（core/model-store.ts）。這一支把建議變成真的改名。
 *
 * ── 為什麼這支是高風險 ──────────────────────────────────────
 *   1. 它動的是使用者的檔案，而且**改壞了比清理更難救**：清理有隔離區，改名如果沒有紀錄，
 *      就只剩使用者自己記得原本叫什麼。所以 `renames` 那張表是唯一一份「原本叫什麼」，
 *      先寫 started 再動檔案，改完才寫 done。
 *   2. 名字是模型給的，**模型會自信地說錯**。所以只提議、不自動做；畫面上永遠標「模型認為」。
 *   3. 檔名是不可信的輸入，建議的名字是**模型產生的輸入** —— 兩邊都當成敵意輸入：
 *      路徑穿越（`../../etc/passwd`）、控制字元與方向字元、Windows 保留名稱、超長、
 *      只差大小寫的同名。全部在 cleanName() 那一層擋掉。
 *
 * ── 不變量（改這支之前先讀一次）────────────────────────────
 *   1. 沒有任何自動改名的路徑。呼叫端一定要指名 itemId。
 *   2. 每一次改名都有紀錄，undo 改得回去；當機之後看檔案實際在哪收尾。
 *   3. **只在同一個資料夾裡改名**（搬家是 P4）。`dir` 是紀錄的一部分，不是參數。
 *   4. **不覆蓋任何既有的檔**：目標存在就加 -2⋯-99，含只差大小寫的情況。
 *   5. 副檔名一律沿用原本的。模型只決定主檔名。
 *   6. 只對 naming 是 untitled／generic 的檔提議；named 的不碰。
 *   7. 模型信心「低」的不提議（那通常是「看不出來」）。
 *   8. 受保護的檔名、隔離區裡的檔、被還沒套用的清理計畫佔住的檔、十分鐘內還在變動的檔，都不改。
 *   9. 回給呼叫端的東西**沒有絕對路徑**（dir 只留在資料庫裡）。
 */
import { lstatSync, readdirSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { DENY_DIRS, under } from './guard.ts'
import {
  CleanupError, cleanupProblem, execRefusesName, transaction, withCleanupLock,
} from './cleanup-journal.ts'
import { checkedPath, SETTLE_MS } from './cleanup-exec.ts'
import { classifyName, UntitledError } from './untitled.ts'
import { modelViewForItem, opinionOf, type ModelOpinion } from './model-store.ts'

/** 一次最多改幾個。超過的不做，呼叫端要講「還有幾個」（預期行為 10）。 */
export const RENAME_BATCH_MAX = 100
/** 主檔名的上限，**用碼位算**（預想 Step 1）。 */
export const NAME_MAX_CODEPOINTS = 80
/**
 * 整個檔名（含序號與副檔名）的位元組上限。
 *
 * ext4／APFS 的上限是 255 **位元組**，不是 255 個字：80 個碼位的表情符號是 320 個位元組，
 * 只數碼位的話 renameSync 會丟 ENAMETOOLONG。250 是留了五個位元組的餘裕。
 *
 * **不可以訂得更小。** 80 個中文字是 240 個位元組，加 `-99.txt` 是 247 —— 訂 200 的話
 * 一個正常的中文建議名會被截成 66 個字，而預想表寫死的是「上限 80 字，用 code point 算」。
 */
export const NAME_MAX_BYTES = 250
/** 同名時序號從 2 開始找到這裡；找不到就放棄這一個（預想 Step 1）。 */
export const SUFFIX_MAX = 99
/** 模型建議的名字先截到這麼長再洗，擋住「拿超長字串吃光記憶體」。 */
const RAW_MAX = 4096

// ── 名字清理：這一層是安全關鍵 ──────────────────────────────

/** 路徑分隔符。去掉它，`../../etc/passwd` 就跳不出這個資料夾。 */
const SEPARATORS = /[/\\]/g
/**
 * 控制字元與方向字元。跟 cli.mjs 的 shown()、面板的 safeName 同一組：
 * C0／C1、U+061C、U+200E／200F、U+2028–202E、U+2066–2069。
 * 印出來會偽造一行字，或把副檔名倒過來（`invoice\u202Efdp.exe` 看起來是 invoiceexe.pdf）。
 * **這裡是直接從名字裡去掉**，不是換成點 —— 存進檔案系統的名字不可以有這些東西。
 */
const CONTROL_AND_BIDI = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g
/**
 * Windows 不能用的字元。`a.pdf:hidden` 在 NTFS 上是 a.pdf 的替代資料流 ——
 * guard.ts 的 badName 擋的是同一組，這裡擋在寫進去之前。
 */
const WINDOWS_ILLEGAL = /[:<>"|?*]/g
/** Windows 保留名稱。取到這幾個字整個檔案系統會怪怪的（跟 guard.ts 的 RESERVED 同一條）。 */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i
/** 模型自己帶的副檔名：1～10 個英數字而且至少一個字母（跟 untitled.ts 的 extDot 同一條規則）。 */
const OWN_EXT = /\.[A-Za-z0-9]{0,9}[A-Za-z][A-Za-z0-9]{0,9}$/

/** 前後的空白與點都去掉。Windows 會安靜地吃掉結尾的點與空白，留著等於名字對不上。 */
const trimEdges = (s: string) => s.replace(/^[\s.]+/u, '').replace(/[\s.]+$/u, '')

/**
 * 原本的副檔名。**一律沿用**（不變量 5）。
 *
 * 用最後一個點，但 `.tar.gz`／`.tar.bz2` 這種兩層的要一起留 —— 只留 `.gz` 的話
 * `備份.tar.gz` 會變成 `作業系統_死結.gz`，那個檔看起來就解不開了。
 * 點開頭的檔（`.bashrc`）沒有副檔名；那種檔本來就被 execRefusesName 擋掉，不會走到這裡。
 */
export function originalExt(name: string): string {
  const base = String(name ?? '')
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  const ext = base.slice(dot)
  if (!/^\.[A-Za-z0-9]{1,10}$/.test(ext)) return ''
  const rest = base.slice(0, dot)
  if (/\.tar$/i.test(rest) && /^\.(gz|bz2|xz|zst|lz|lzma|z)$/i.test(ext)) return rest.slice(-4) + ext
  return ext
}

/** 主檔名截到上限。**按碼位切**，不按 UTF-16 單位 —— 不可以切在代理對中間。 */
export function capStem(stem: string, ext: string, suffix = ''): string {
  let points = [...stem].slice(0, NAME_MAX_CODEPOINTS)
  while (points.length && Buffer.byteLength(points.join('') + suffix + ext, 'utf8') > NAME_MAX_BYTES) {
    points.pop()
  }
  return trimEdges(points.join(''))
}

/**
 * 把模型（或使用者）給的名字洗成一個安全的**主檔名**。洗完是空的就回空字串 ＝ 不提議。
 *
 * 順序有意義：先去掉分隔符與控制字元，**再**去前後的點 ——
 * 反過來的話 `../../etc/passwd` 會先被當成「前面有點」剝成 `../etc/passwd`，還是帶著分隔符。
 * 去完之後 `../../etc/passwd` 是 `etcpasswd`：一個普通的名字，跳不出這個資料夾。
 */
export function cleanName(suggested: unknown, ext = ''): string {
  if (typeof suggested !== 'string' || !suggested) return ''
  if (suggested.length > 100_000) return ''
  let s = [...suggested].slice(0, RAW_MAX).join('').normalize('NFC')
  s = s.replace(SEPARATORS, '').replace(CONTROL_AND_BIDI, '').replace(WINDOWS_ILLEGAL, '')
  s = s.replace(/\s+/gu, ' ')
  s = trimEdges(s)
  // 模型自己帶了副檔名（`作業系統_死結.pdf`）：去掉，等一下接原本的
  const own = OWN_EXT.exec(s)
  if (own && own.index > 0) s = trimEdges(s.slice(0, own.index))
  if (!s) return ''
  if (RESERVED.test(s)) return ''
  s = capStem(s, ext)
  // 截短之後剛好變成保留名稱（`CON⋯⋯`）也要擋
  if (!s || RESERVED.test(s)) return ''
  return s
}

/**
 * 模型的建議 → 完整的新檔名（含原本的副檔名）。提不出來回空字串。
 * `未命名文件 (3).txt` ＋ 模型說 `作業系統_死結` → `作業系統_死結.txt`。
 */
export function suggestedFileName(currentName: string, suggested: unknown): string {
  const ext = originalExt(currentName)
  const stem = cleanName(suggested, ext)
  if (!stem) return ''
  const full = stem + ext
  // 洗出來的名字自己也要過執行層那一關（`.env`、`id_rsa.*`、`data.db`⋯⋯）
  if (execRefusesName(full)) return ''
  return full
}

// ── 誰可以被提議改名 ────────────────────────────────────────

/** 可以動的檔案狀態。跟清理的 PLANNABLE_STATUSES 同一組：new 的不碰（還在下載）。歸檔（P4）用同一組。 */
export const RENAMABLE_STATUSES = ['candidate', 'kept', 'restored'] as const

/**
 * 信心「低」的不提議（不變量 7）。**只有「高」與「中」算數** ——
 * 空的、看不懂的一律當成不夠有把握：這個方向錯了只是少提議一個，反過來是拿模型的胡說去改檔名。
 */
export const confidentEnough = (c: unknown): boolean => c === '高' || c === '中'

export type RenameSuggestion = {
  itemId: string
  /** 現在叫什麼（只有檔名，沒有資料夾） */
  name: string
  /** 建議改成什麼（含原本的副檔名） */
  suggested: string
  course: string
  topic: string
  confidence: string
  evidence: string
  /** true ＝ demo 預先塞的示範答案，畫面要標示 */
  seeded: boolean
}

export type RenameScope = {
  /** 清理範圍。不在裡面的檔不提議、也不改。 */
  roots: string[]
  /** 隔離區（預設 ~/.contextbox/quarantine）。裡面的檔一律不碰。 */
  quarantine?: string
  readonly?: boolean
}

/** 動檔案的那幾支（改名 P3、歸檔 P4）看的 file_items 欄位。 */
export type ItemRow = {
  id: string; path: string; name: string; status: string; error: string | null
  naming: string | null; mtime: string
}

const has = (db: DatabaseSync, table: string): boolean => {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table))
  } catch { return false }
}

/**
 * 這個檔在一份**還沒套用**（proposed）的清理計畫裡嗎（不變量 8）。
 *
 * 改了之後那份計畫的快照（路徑、名字）就對不上，套用時會變成「檔案不見了」。
 * 快照表是清理那條線懶建的；**沒有那張表就是沒有計畫**，不是「看不出來」。
 * 查詢真的出錯才 fail closed（回 true ＝ 不改）。
 */
function heldByPlan(db: DatabaseSync, itemId: string): boolean {
  if (!has(db, 'cleanup_snapshots')) return false
  try {
    return Boolean(db.prepare(
      `SELECT 1 FROM cleanup_snapshots s JOIN cleanup_plans p ON p.id=s.plan_id
        WHERE s.item_id=? AND p.status='proposed' LIMIT 1`).get(itemId))
  } catch { return true }
}

/** 這個檔現在有沒有一筆還沒收尾的改名（started）。有的話先不提議，等收尾。 */
function midRename(db: DatabaseSync, itemId: string): boolean {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM renames WHERE item_id=? AND status='started' LIMIT 1`).get(itemId))
  } catch { return true }
}

/** 路徑上（不含檔名）有沒有 . 開頭或金鑰資料夾。跟 cleanup-exec 的 inProtectedDir 同一條。 */
export function inProtectedDir(target: string): boolean {
  return target.split(/[\\/]+/).filter(Boolean).map(s => s.toLowerCase()).slice(0, -1)
    .some(s => s.startsWith('.') || DENY_DIRS.includes(s))
}

/** 這個檔在不在任何一個（過得了捷徑檢查的）清理根目錄底下。 */
export function underSomeRoot(roots: readonly string[], target: string): boolean {
  return roots.some(root => {
    let real: string
    try { real = checkedPath(root, true) } catch { return false }
    return under(real, target)
  })
}

/** 隔離區裡的檔一律不碰。 */
export function inQuarantine(scope: RenameScope, target: string): boolean {
  if (!scope.quarantine) return false
  const q = resolve(scope.quarantine)
  return q === target || under(q, target)
}

/**
 * 訊息裡那兩個會隨動作變的詞。**只有詞不一樣，判斷完全一樣** ——
 * 改名（P3）與歸檔（P4）擋的是同一批檔，不可以有兩份會走樣的判斷。
 *
 * - `act`：動作本身（「改名」／「歸檔」），接在「先不⋯⋯」「不能⋯⋯」「上一次⋯⋯還沒收尾」後面
 * - `it`：整句的「不動它」（「不改它的名字」／「不搬它」）
 */
export type MoveWords = { act: string; it: string }
export const RENAME_WORDS: MoveWords = { act: '改名', it: '不改它的名字' }

/**
 * 動使用者的檔之前，**改名與歸檔共用**的那幾條擋門。可以動回 null，不可以回一句人話（不帶路徑）。
 *
 * `mid` 是「這個檔有沒有一筆自己這條線還沒收尾的紀錄」——
 * 改名看 renames、歸檔看 filings，表不一樣，所以由呼叫端傳進來；順序跟以前一樣夾在計畫與 mtime 之間。
 *
 * 列清單與真的動手走的是同一支 —— **不准有第二份判斷**。
 */
export function whyNotTouchable(
  db: DatabaseSync, item: ItemRow, scope: RenameScope, words: MoveWords,
  mid?: (db: DatabaseSync, itemId: string) => boolean,
): string | null {
  if (item.error) return `這個檔上次掃描就出過問題，先不${words.act}。`
  if (item.status === 'new') return '這個檔才剛出現，還在等它穩定下來。'
  if (!(RENAMABLE_STATUSES as readonly string[]).includes(item.status)) {
    return `這個檔現在的狀態不能${words.act}（可能在隔離區，或已經不見了）。`
  }
  if (execRefusesName(item.name) || inProtectedDir(item.path)) {
    return `這是受保護的檔案，${words.it}。`
  }
  if (inQuarantine(scope, item.path)) return `這個檔在隔離區裡，${words.it}。`
  if (!underSomeRoot(scope.roots, item.path)) return '這個檔不在設定的清理資料夾裡。'
  if (heldByPlan(db, item.id)) return '它在一份還沒處理完的清理計畫裡，先把那一份做完或放棄。'
  if (mid && mid(db, item.id)) return `上一次${words.act}還沒收尾，先跑一次收尾再試。`
  // 十分鐘內還在變動的不碰（跟清理同一條規矩）。這裡看的是上次掃描記下來的 mtime ——
  // 便宜、不用碰磁碟，列清單時每一列都要算。真的動手前 checkFile 會再用磁碟上的時間確認一次。
  const mtime = Date.parse(item.mtime)
  if (Number.isFinite(mtime) && Date.now() - mtime < SETTLE_MS) {
    return `這個檔十分鐘內還在變動，先不${words.act}。等一下再試一次。`
  }
  return null
}

/**
 * 這個檔現在可不可以被改名。可以回 null，不可以回一句**人話**（不帶路徑）。
 *
 * 只有第一條是改名專屬的（使用者自己取的名字最大）；其餘跟歸檔共用 whyNotTouchable。
 */
export function whyNotRenamable(db: DatabaseSync, item: ItemRow, scope: RenameScope): string | null {
  if (item.naming !== 'untitled' && item.naming !== 'generic') {
    return '這個檔已經有名字了，不動使用者自己取的名字。'
  }
  return whyNotTouchable(db, item, scope, RENAME_WORDS, midRename)
}

/**
 * 建議清單。**只列**：naming 是 untitled／generic、有模型看法、信心不是「低」、
 * 洗得出一個安全的新名字、而且現在真的可以動的檔。
 *
 * **naming 這一關故意擋兩次**（這裡的 SQL 一次、whyNotRenamable 再一次）：
 * SQL 那一次是為了不要對幾千個 named 的檔各做一次模型查詢，whyNotRenamable 那一次是**防線** ——
 * 真的動檔案的 applyRenames 只走得到後面那一支。任何一邊單獨拿掉，行為都不會變
 * （2026-09-19 的突變測試：拿掉 SQL 那一條，整套照樣綠）；**兩邊都拿掉才會出事**。
 * 所以這不是重複的死碼，是分工：一個管快，一個管對。
 */
export function renameSuggestions(db: DatabaseSync, scope: RenameScope, opts: { limit?: number } = {}): {
  items: RenameSuggestion[]
} {
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 500))
  let rows: ItemRow[] = []
  try {
    rows = db.prepare(
      `SELECT id, path, name, status, error, naming, mtime FROM file_items
        WHERE naming IN ('untitled','generic') AND error IS NULL
          AND status IN (${RENAMABLE_STATUSES.map(() => '?').join(',')})
        ORDER BY last_seen_at DESC, id`
    ).all(...RENAMABLE_STATUSES) as ItemRow[]
  } catch { rows = [] }

  const items: RenameSuggestion[] = []
  for (const row of rows) {
    if (items.length >= limit) break
    let opinion: ModelOpinion | null = null
    try { opinion = opinionOf(modelViewForItem(db, row.id)) } catch { opinion = null }
    if (!opinion) continue
    if (!confidentEnough(opinion.confidence)) continue
    const suggested = suggestedFileName(row.name, opinion.suggestedName)
    if (!suggested) continue
    // 名字一樣就沒有東西可以建議（改成自己沒有意義）
    if (suggested === row.name) continue
    if (whyNotRenamable(db, row, scope)) continue
    items.push({
      itemId: row.id,
      name: row.name,
      suggested,
      course: opinion.course,
      topic: opinion.topic,
      confidence: opinion.confidence,
      evidence: opinion.evidence,
      seeded: opinion.seeded,
    })
  }
  return { items }
}

// ── 真的改名 ────────────────────────────────────────────────

export type RenameRow = {
  id: string; item_id: string; from_name: string; to_name: string; dir: string
  source: string; status: 'started' | 'done' | 'reverted' | 'failed'
  error: string | null; at: string; undone_at: string | null
}

export type RenameOutcome = {
  itemId: string
  ok: boolean
  /** 原本叫什麼（只有檔名） */
  from: string
  /** 改成什麼；沒改成就是空字串 */
  to: string
  /** 一句人話。成功時講「改好了」，失敗時講為什麼。**不帶路徑** */
  why: string
  /** 成功時的紀錄 id，undo 要用 */
  id?: string
}

export type RenameRequest = { itemId: unknown; to?: unknown }

/** 目錄裡現在有哪些名字（小寫）。「只差大小寫」也算同名，所以一律折成小寫比。 */
export function namesTaken(db: DatabaseSync, dir: string): Set<string> {
  const taken = new Set<string>()
  for (const entry of readdirSync(dir)) taken.add(entry.toLowerCase())
  // 資料庫裡還記著、但檔案已經不在的路徑也算佔住：file_items.path 有 UNIQUE，
  // 撞上去的話改名會在最後一步（更新那一列）炸掉 —— 檔案已經改好名，資料庫還指著舊路徑。
  // 用 JS 比 dirname，不用 LIKE：dir 裡可能有 % 或 \（Windows），跳脫寫錯就會安靜地比不到。
  // **status 是 missing 的不算佔住**：那個檔已經不在磁碟上了（掃描標的），
  // 只是那一列還留著。算進去的話，改名被砍又掃過一次之後就復原不回原本的名字了（P3 驗證員）。
  try {
    const rows = db.prepare(`SELECT path, name FROM file_items WHERE status <> 'missing'`)
      .all() as { path: string; name: string }[]
    for (const r of rows) if (dirname(String(r.path)) === dir) taken.add(String(r.name).toLowerCase())
  } catch { /* 查不到就只靠資料夾本身 */ }
  return taken
}

/**
 * 不覆蓋任何既有的檔（不變量 4）：目標被佔走就加 `-2`、`-3`⋯⋯ 到 99。
 * **「只差大小寫」也算佔走** —— 在不分大小寫的檔案系統上 `A.txt` → `a.txt` 是同一個檔。
 * 序號加在副檔名前面：`作業系統_死結-2.txt`。找不到空位回空字串（放棄這一個）。
 */
export function freeName(wanted: string, ext: string, taken: ReadonlySet<string>): string {
  const stem = ext && wanted.endsWith(ext) ? wanted.slice(0, wanted.length - ext.length) : wanted
  if (!taken.has(wanted.toLowerCase())) return wanted
  for (let n = 2; n <= SUFFIX_MAX; n++) {
    const suffix = '-' + n
    const candidate = capStem(stem, ext, suffix) + suffix + ext
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return ''
}

/**
 * 檔案現在的樣子。不是一般檔、是捷徑、被硬鏈結的一律不碰。
 * `words` 只換訊息裡的詞（歸檔說「不搬它」），判斷完全一樣。
 */
export function checkFile(path: string, words: MoveWords = RENAME_WORDS):
  { dev: number; ino: number; mtimeMs: number } {
  const st = lstatSync(path)
  if (st.isSymbolicLink()) throw new CleanupError('UNSAFE_PATH', `這是一個捷徑（symlink），${words.it}。`)
  if (!st.isFile()) throw new CleanupError('UNSAFE_FILE', `這不是一般檔案，${words.it}。`)
  if (st.nlink > 1) throw new CleanupError('UNSAFE_FILE', `這個檔案被硬鏈結到別的地方，${words.it}。`)
  if (Date.now() - st.mtimeMs < SETTLE_MS) {
    throw new CleanupError('TOO_FRESH', `這個檔十分鐘內還在變動，先不${words.act}。等一下再試一次。`)
  }
  return { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs }
}

/** 重新判一次 naming（改完會變 named，就不再提議）。判不出來當成拿不準。 */
function namingOf(name: string): { state: string; why: string } {
  try {
    const c = classifyName(name)
    return { state: c.state, why: c.reason }
  } catch (e) {
    return {
      state: 'generic',
      why: e instanceof UntitledError ? '檔名不像正常的檔名，拿不準' : '判斷檔名時出錯，拿不準',
    }
  }
}

/**
 * 檔案改好之後，把 `file_items` 那一列跟上。
 *
 * **更新同一列，不要變成兩列**（預想 Step 1 倒數第三格）：path 是 key，
 * 新增一列的話指紋、內容、模型看法全部要重算，而且舊那列會被下一次掃描標成 missing。
 */
/**
 * 讓 file_items 跟著改名走。回「這個檔現在是哪一列」。
 *
 * **可能已經有別人在那個路徑上了**：改名被砍之後如果先掃了一次（pet 開機與每 30 分鐘都會掃），
 * 掃描會把新名字當成一個新檔收進來，舊那列變成 missing。這時候硬改舊那列的 path 會撞
 * UNIQUE(file_items.path)，例外被吞掉，那一筆改名就永遠停在 started、永遠復原不回來（P3 驗證員）。
 * 所以：那個路徑已經有一列的話，**改跟著那一列走**（順便補上 naming），舊那列留給掃描自己收。
 */
export function followFile(db: DatabaseSync, itemId: string, dir: string, name: string): string {
  const nm = namingOf(name)
  const path = join(dir, name)
  const other = db.prepare('SELECT id FROM file_items WHERE path=?').get(path) as { id: string } | undefined
  if (other && other.id !== itemId) {
    db.prepare('UPDATE file_items SET naming=?, naming_why=? WHERE id=?').run(nm.state, nm.why, other.id)
    return other.id
  }
  db.prepare('UPDATE file_items SET path=?, name=?, naming=?, naming_why=? WHERE id=?')
    .run(path, name, nm.state, nm.why, itemId)
  return itemId
}

export const itemById = (db: DatabaseSync, id: string): ItemRow | null =>
  (db.prepare('SELECT id, path, name, status, error, naming, mtime FROM file_items WHERE id=?')
    .get(id) as ItemRow | undefined) ?? null

function validateRequests(items: unknown): asserts items is RenameRequest[] {
  if (!Array.isArray(items) || !items.length) {
    throw new CleanupError('BAD_BODY', '要指名改哪幾個檔（items 是一個陣列，每一項有 itemId）。')
  }
  if (items.length > 5000) throw new CleanupError('BAD_BODY', '一次最多 5000 項。')
  for (const it of items) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) {
      throw new CleanupError('BAD_BODY', 'items 的每一項要是 { itemId, to }。')
    }
    const id = (it as RenameRequest).itemId
    if (typeof id !== 'string' || !id || id.length > 200) {
      throw new CleanupError('BAD_BODY', 'itemId 必須是 1 到 200 字元的字串。')
    }
    const to = (it as RenameRequest).to
    if (to !== undefined && (typeof to !== 'string' || to.length > 4096)) {
      throw new CleanupError('BAD_BODY', 'to 必須是字串（最多 4096 字元）。')
    }
  }
}

/**
 * 真的改名。**只做呼叫端指名的那幾個**（不變量 1），一次最多 RENAME_BATCH_MAX 個，
 * 其餘回在 `remaining` 讓呼叫端講「還有幾個」。
 *
 * 每一個檔：先寫 started → renameSync → 同一個交易裡更新 file_items 並寫 done。
 * 中間被砍就靠 recoverInterruptedRenames 看檔案實際在哪收尾。
 *
 * 整批拿**清理的鎖**（withCleanupLock）：改名跟清理不可以同時動同一個資料夾。
 */
export function applyRenames(db: DatabaseSync, items: unknown, scope: RenameScope): {
  results: RenameOutcome[]; remaining: number
} {
  validateRequests(items)
  if (scope.readonly) {
    throw new CleanupError('READ_ONLY', '目前是唯讀模式，不會改任何檔案的名字。')
  }
  // 同一個檔送兩次只做一次（第二次的目標會是第一次改完的名字，很難講清楚）
  const seen = new Set<string>()
  const wanted: RenameRequest[] = []
  for (const it of items) {
    if (seen.has(it.itemId as string)) continue
    seen.add(it.itemId as string)
    wanted.push(it)
  }
  const batch = wanted.slice(0, RENAME_BATCH_MAX)
  const remaining = wanted.length - batch.length

  return withCleanupLock(db, renew => {
    recoverInterruptedRenames(db)
    const results: RenameOutcome[] = []
    // 一整批共用一個時間戳：undo 的 `last` 靠它認出「最近那一次」是哪幾列
    const at = new Date().toISOString()
    // 同一個資料夾裡已經被佔走的名字，邊做邊補（同一批兩個檔可能想要同一個名字）
    const takenByDir = new Map<string, Set<string>>()
    for (const req of batch) {
      renew()
      results.push(renameOne(db, req, scope, at, takenByDir))
    }
    return { results, remaining }
  })
}

function renameOne(
  db: DatabaseSync, req: RenameRequest, scope: RenameScope, at: string,
  takenByDir: Map<string, Set<string>>,
): RenameOutcome {
  const itemId = String(req.itemId)
  const item = itemById(db, itemId)
  if (!item) return { itemId, ok: false, from: '', to: '', why: '找不到這個檔（可能已經被清掉或重新掃描過）。' }
  const from = item.name
  const no = (why: string): RenameOutcome => ({ itemId, ok: false, from, to: '', why })

  const blocked = whyNotRenamable(db, item, scope)
  if (blocked) return no(blocked)

  // 呼叫端指名的名字（面板送模型的建議、使用者也可以自己打）一樣要洗過
  const opinion = (() => { try { return opinionOf(modelViewForItem(db, itemId)) } catch { return null } })()
  const modelName = opinion && confidentEnough(opinion.confidence)
    ? suggestedFileName(from, opinion.suggestedName) : ''
  const asked = req.to === undefined ? modelName : suggestedFileName(from, req.to)
  if (!asked) {
    return no(req.to === undefined
      ? '沒有可以用的建議名字（模型沒有看法、信心太低，或建議洗完是空的）。'
      : '這個名字洗完是空的（只剩路徑符號、控制字元或保留名稱），不能用。')
  }
  if (asked === from) return no('新名字跟現在一樣，沒有改。')
  const source = asked === modelName && modelName ? 'model' : 'manual'

  let dir: string
  try { dir = checkedPath(dirname(item.path), true) } catch (e) { return no(cleanupProblem(e)) }
  // 資料夾攤開之後還要在清理範圍裡（父層是捷徑時 path 與 dir 會不一樣）
  if (!underSomeRoot(scope.roots, join(dir, from))) return no('這個檔不在設定的清理資料夾裡。')

  let before
  try { before = checkFile(join(dir, from)) } catch (e) { return no(cleanupProblem(e)) }

  let taken = takenByDir.get(dir)
  if (!taken) {
    try { taken = namesTaken(db, dir) } catch (e) { return no(cleanupProblem(e)) }
    takenByDir.set(dir, taken)
  }
  const ext = originalExt(from)
  const to = freeName(asked, ext, taken)
  if (!to) return no(`「${asked}」與它的 -2⋯-${SUFFIX_MAX} 都已經有人用了，這一個先跳過。`)

  const id = randomUUID()
  db.prepare(
    `INSERT INTO renames (id,item_id,from_name,to_name,dir,source,status,error,at,undone_at)
     VALUES (?,?,?,?,?,?,'started',NULL,?,NULL)`
  ).run(id, itemId, from, to, dir, source, at)

  try {
    moveInDir(dir, from, to, before)
  } catch (e) {
    const why = cleanupProblem(e)
    db.prepare(`UPDATE renames SET status='failed', error=? WHERE id=?`).run(why.slice(0, 200), id)
    return no(why)
  }
  taken.add(to.toLowerCase())
  transaction(db, () => {
    followFile(db, itemId, dir, to)
    db.prepare(`UPDATE renames SET status='done' WHERE id=?`).run(id)
  })
  return { itemId, ok: true, from, to, why: '改好了。反悔的話可以復原。', id }
}

/**
 * 在同一個資料夾裡改名，**絕不覆蓋**。
 *
 * Node 沒有「目標存在就失敗」的 rename（那要 renameat2 的 RENAME_NOREPLACE，沒有暴露出來），
 * 而這個專案不准建佔位檔再刪掉（只搬不刪）。所以：**動手前的最後一刻再確認一次目標不存在**，
 * 而且確認來源還是剛剛量到的那一個 inode（中間被換掉就不動）。
 * 剩下的競爭窗口是這兩行之間的幾微秒，而且要有另一個程式剛好在那一瞬間建出同名檔。
 */
function moveInDir(dir: string, from: string, to: string, before: { dev: number; ino: number }): void {
  let exists = true
  try { lstatSync(join(dir, to)) } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e
    exists = false
  }
  if (exists) throw new CleanupError('CONFLICT', '目標名字剛剛被別的東西佔走了，這一個先跳過。')
  const now = lstatSync(join(dir, from))
  if (now.dev !== before.dev || now.ino !== before.ino) {
    throw new CleanupError('CHANGED', '這個檔剛剛被換掉了，先不改名。')
  }
  renameSync(join(dir, from), join(dir, to))
}

// ── 復原 ────────────────────────────────────────────────────

export type UndoOutcome = {
  id: string
  itemId: string
  ok: boolean
  /** 改回什麼名字（沒放回就是空字串） */
  to: string
  /** 原名被佔走時，真正放回來的名字（`X-2.txt`）；沒有就是 null */
  restoredAs: string | null
  why: string
}

export type UndoSelection = { ids?: unknown; last?: unknown }

/**
 * 復原：把名字改回去。
 *
 * - `{ ids: [...] }`：指名哪幾筆
 * - `{ last: true }`：**最近那一次**（同一批 apply 共用一個時間戳，所以是整批一起回去）
 *
 * 原名被別人佔走了就加序號，而且**講清楚放回來的叫什麼**（預期行為 11）——
 * 跟清理的復原同一個規矩，不覆蓋任何東西。
 */
export function undoRenames(db: DatabaseSync, sel: UndoSelection, scope: RenameScope): {
  results: UndoOutcome[]
} {
  if (scope.readonly) {
    throw new CleanupError('READ_ONLY', '目前是唯讀模式，不會改任何檔案的名字。')
  }
  const wantLast = sel.last === true
  if (sel.last !== undefined && typeof sel.last !== 'boolean') {
    throw new CleanupError('BAD_BODY', 'last 要是 true 或 false。')
  }
  let ids: string[] = []
  if (sel.ids !== undefined) {
    if (!Array.isArray(sel.ids) || sel.ids.length > 1000
      || sel.ids.some(v => typeof v !== 'string' || !v || v.length > 200)) {
      throw new CleanupError('BAD_BODY', 'ids 必須是字串陣列，最多 1000 筆。')
    }
    ids = [...new Set(sel.ids as string[])]
  }
  if (!ids.length && !wantLast) {
    throw new CleanupError('BAD_BODY', '要指名 ids，或送 { "last": true } 復原最近一次改名。')
  }

  return withCleanupLock(db, renew => {
    recoverInterruptedRenames(db)
    let rows: RenameRow[]
    if (ids.length) {
      rows = db.prepare(
        `SELECT * FROM renames WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY at DESC, id`
      ).all(...ids) as RenameRow[]
      const found = new Set(rows.map(r => r.id))
      const missing = ids.filter(i => !found.has(i))
      if (missing.length) throw new CleanupError('NOT_FOUND', '找不到這幾筆改名紀錄。')
    } else {
      const last = db.prepare(`SELECT at FROM renames WHERE status='done' ORDER BY at DESC LIMIT 1`)
        .get() as { at: string } | undefined
      if (!last) throw new CleanupError('NOT_FOUND', '沒有可以復原的改名。')
      rows = db.prepare(`SELECT * FROM renames WHERE status='done' AND at=? ORDER BY id`)
        .all(last.at) as RenameRow[]
    }
    const results: UndoOutcome[] = []
    for (const row of rows) {
      renew()
      results.push(undoOne(db, row, scope))
    }
    return { results }
  })
}

function undoOne(db: DatabaseSync, row: RenameRow, scope: RenameScope): UndoOutcome {
  const base: UndoOutcome = {
    id: row.id, itemId: row.item_id, ok: false, to: '', restoredAs: null, why: '',
  }
  const no = (why: string): UndoOutcome => ({ ...base, why })
  if (row.status === 'reverted') return { ...base, ok: true, to: row.from_name, why: '這一筆本來就已經復原過了。' }
  if (row.status !== 'done') return no('這一筆沒有改成功，沒有東西要復原。')

  let dir: string
  try { dir = checkedPath(row.dir, true) } catch (e) { return no(cleanupProblem(e)) }
  if (!underSomeRoot(scope.roots, join(dir, row.to_name))) {
    return no('那個資料夾現在不在設定的清理資料夾裡，先不動它。')
  }
  let before
  try { before = checkFile(join(dir, row.to_name)) } catch (e) { return no(cleanupProblem(e)) }

  let taken: Set<string>
  try { taken = namesTaken(db, dir) } catch (e) { return no(cleanupProblem(e)) }
  // 自己現在佔著的那個名字不算「被佔走」
  taken.delete(row.to_name.toLowerCase())
  const ext = originalExt(row.from_name)
  const back = freeName(row.from_name, ext, taken)
  if (!back) return no(`原本的名字與它的 -2⋯-${SUFFIX_MAX} 都已經有人用了，沒有放回去。`)

  try {
    moveInDir(dir, row.to_name, back, before)
  } catch (e) {
    const why = cleanupProblem(e)
    db.prepare('UPDATE renames SET error=? WHERE id=?').run(why.slice(0, 200), row.id)
    return no(why)
  }
  transaction(db, () => {
    followFile(db, row.item_id, dir, back)
    db.prepare(`UPDATE renames SET status='reverted', undone_at=? WHERE id=?`)
      .run(new Date().toISOString(), row.id)
  })
  const restoredAs = back === row.from_name ? null : back
  return {
    ...base, ok: true, to: back, restoredAs,
    why: restoredAs
      ? `原本的名字已經被別的檔佔走了，放回來的這一份叫「${restoredAs}」（沒有覆蓋任何檔）。`
      : '名字改回去了。',
  }
}

// ── 收尾（中斷之後）────────────────────────────────────────

/**
 * 收尾還停在 started 的紀錄。**看檔案實際在哪**決定那一列是 done 還是 reverted
 * （跟 cleanup-exec.ts 的 recoverInterrupted 同一個做法）：
 *
 *   · 新名字在 → 改名其實做完了，只是沒來得及寫 done。補上 file_items，標 done。
 *   · 舊名字在 → 沒改到。標 reverted（檔案本來就在原位，不用動它）。
 *   · 兩個都不在 → 標 failed，留一句話，不猜。
 *
 * 不會重複改名（預期行為 7）：done 的那一列下次不會再被撿起來。
 */
export function recoverInterruptedRenames(db: DatabaseSync): { recovered: number } {
  let rows: RenameRow[]
  try {
    rows = db.prepare(`SELECT * FROM renames WHERE status='started' ORDER BY at, id`).all() as RenameRow[]
  } catch { return { recovered: 0 } }
  let recovered = 0
  for (const row of rows) {
    const there = (name: string) => { try { lstatSync(join(row.dir, name)); return true } catch { return false } }
    try {
      if (there(row.to_name)) {
        transaction(db, () => {
          // 掃描已經把新名字收成另一列的話，這一筆要改跟著那一列走，不然之後復原找不到檔
          const nowId = followFile(db, row.item_id, row.dir, row.to_name)
          if (nowId !== row.item_id) db.prepare('UPDATE renames SET item_id=? WHERE id=?').run(nowId, row.id)
          db.prepare(`UPDATE renames SET status='done' WHERE id=?`).run(row.id)
        })
      } else if (there(row.from_name)) {
        db.prepare(`UPDATE renames SET status='reverted', undone_at=?, error=? WHERE id=?`)
          .run(new Date().toISOString(), '改名中斷，檔案還在原位，沒有改。', row.id)
      } else {
        db.prepare(`UPDATE renames SET status='failed', error=? WHERE id=?`)
          .run('改名中斷，新舊兩個名字現在都找不到，請人工確認。', row.id)
      }
      recovered++
    } catch (e: any) {
      // 收不掉要留下線索：以前整個吞掉，使用者只看到「上一次改名還沒收尾」卻永遠收不完
      try {
        db.prepare(`UPDATE renames SET error=? WHERE id=? AND status='started'`)
          .run(`收尾失敗：${String(e?.message ?? e).slice(0, 150)}`, row.id)
      } catch { /* 連這個都寫不進去就算了 */ }
    }
  }
  return { recovered }
}

/** 最近幾筆改名紀錄（CLI 的 `rename --undo` 要列出可以復原的）。**不回 dir。** */
export function listRenames(db: DatabaseSync, limit = 20): {
  id: string; itemId: string; from: string; to: string; status: string; at: string; source: string
}[] {
  const n = Math.max(1, Math.min(200, limit))
  let rows: RenameRow[] = []
  try {
    rows = db.prepare('SELECT * FROM renames ORDER BY at DESC, id LIMIT ?').all(n) as RenameRow[]
  } catch { return [] }
  return rows.map(r => ({
    id: r.id, itemId: r.item_id, from: r.from_name, to: r.to_name,
    status: r.status, at: r.at, source: r.source,
  }))
}
