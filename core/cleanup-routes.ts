/**
 * 清理功能的唯讀層：組清單、組健康狀態、掛 HTTP route。
 *
 * ── 這一支為什麼存在 ─────────────────────────────────────────
 *
 * A 的 scanner 把候選寫進 `cleanup_candidates`，一筆規則一列。
 * 但**使用者看的是「這個檔要不要清」，不是「這條規則要不要套用」** ——
 * 一個 90 天沒動的 zip 同時命中 archive 與 old-download，在 UI 上出現兩次就是 bug。
 *
 * 所以這一層做三件事：
 *   1. 以**檔案**為單位聚合，理由全部留著
 *   2. 決定**預設勾不勾**（見 DEFAULT_CHECK_MIN）
 *   3. **把絕對路徑擋在後端** —— 回給 UI 的東西裡不可以有完整路徑
 *
 * CLI 與 HTTP route 都呼叫 `listCandidates()`。
 * **只有一個地方決定 defaultChecked**，不准有第二份。
 */
import { readdirSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import {
  KIND_CONFIDENCE, CLEANUP_KINDS, CLEANUP_RULE_VERSION, PARTIAL_EXT,
} from './cleanup-rules.ts'
import {
  RETENTION_MS, applyPlan, undoPlan, type ExecOptions,
} from './cleanup-exec.ts'
import { createPlan, getPlan, dismissPlan, releasePlan, validateIds } from './cleanup-plans.ts'
import { prepareEmptyQuarantine, emptyQuarantine } from './cleanup-quarantine.ts'
import { CleanupError, execRefusesName, transaction } from './cleanup-journal.ts'

/**
 * meta 表的 key。**兩邊不要各打一次字串。**
 * 稽查抓到：讀的是 `cleanup_watch_heartbeat`，寫的是 `watch_heartbeat`，
 * 永遠對不上，所以 /health 的 watcher 永遠說「從來沒跑過」——
 * 一個為了「靜默失敗是最大的敵人」而加的東西，自己在說謊。
 */
export const META = {
  heartbeat: 'watch_heartbeat',
  pid: 'watch_pid',
  lastError: 'cleanup_last_error',
  /** 最近一次成功的掃描／套用／復原／清空。寵物只在 lastError 比它新的時候擔心。 */
  lastOk: 'cleanup_last_ok',
} as const

/**
 * 後端意外（非 CleanupError）時給呼叫端的話。**要中性。**
 *
 * 上一版寫「這一步沒有搬動或刪除任何檔案」—— 但例外可能發生在檔案已經搬走、
 * 或已經刪掉之後（例如刪完檔、寫回結果時資料庫出錯）。稽查實測過：檔案已經永久刪了，
 * 訊息卻說沒有（C-C5）。我們不知道的時候，就說不知道。
 */
export const INTERNAL_MESSAGE = '後端出錯了，這一步可能沒有完成。請重新整理後看目前的狀態。'

/** 太大、算不出指紋的檔：執行層一定拒收，所以不列成候選，改列在「需要你查看」。 */
export const TOO_LARGE_WHY = '檔案太大，這個工具不處理，要不要留請自己決定。'

/** 預設清理（不帶 id）一次最多幾個檔。超過的下次再清（RC12）。 */
export const DEFAULT_PLAN_MAX_FILES = 1000

/**
 * 信心到多少才預設打勾。
 *
 * **這個數字是規格的洞，不是隨便訂的。** spec 第 5 節的表只明說
 * 「低信心，預設不勾」，中信心那兩格（installer 70、archive 65）沒講勾不勾。
 *
 * 決定性的證據在 spec 第 0 節的 demo 主線：把 `.zip`、重複檔、空檔、
 * **安裝包**丟進 Downloads，「使用者點同意，Downloads 變乾淨」。
 * archive 與 installer 都在那句話的範圍裡，所以中信心也要勾。
 *
 * 實際的信心值是 35（低）與 65（中）兩群，中間沒有東西。取 50，
 * 兩邊各留 15 的餘裕 —— 以後調規則的信心值才不會意外翻邊。
 *
 * 誤刪的風險不是靠「預設不勾」擋的，是靠：先隔離不刪除、七天、
 * 逐項可取消、一鍵復原。
 */
export const DEFAULT_CHECK_MIN = 50

// kind 與信心值的真值來源在 cleanup-rules.ts。**不要在這裡抄第二份。**
export { KIND_CONFIDENCE, CLEANUP_KINDS }

export type CandidateReason = {
  kind: string
  confidence: number
  reason: string
  evidence: string
}

/** 一個**檔案**一列。UI 與 CLI 看到的都是這個。 */
export type CandidateRow = {
  itemId: string
  name: string
  /** 監看資料夾的顯示名（最後一段），不是完整路徑 */
  folder: string
  /** 相對於監看資料夾的子目錄。root 底下就是空字串 */
  subdir: string
  bytes: number
  mtime: string
  /** 信心最高的那一條 */
  kind: string
  confidence: number
  defaultChecked: boolean
  /**
   * 否決理由的位置，**現在永遠是 null**。原本唯一的實例（太大算不出指紋）已經升級成
   * 「不列」（見 noFingerprint）。欄位留著是因為 UI、CLI 與 docs 的範例都讀它；
   * 將來的「使用者釘選」「最近開過」要做成否決時再接回來 —— **不可以做成低信心候選**，max 會把它蓋掉。
   */
  vetoed: null
  /** 這個檔的全部 candidate id。建 plan 要整包送，不然 B 會漏處理 */
  candidateIds: string[]
  /** 依信心由高到低 */
  reasons: CandidateReason[]
}

export type NeedsHumanRow = {
  itemId: string
  name: string
  folder: string
  bytes: number
  why: string
}

export type CandidateList = {
  /** 這次回了幾列 */
  total: number
  /** **全部**有幾列（沒被 limit 截斷的真實數字） */
  totalAvailable: number
  /** 被 limit 砍掉了嗎。沒有這個旗標，UI 會把 500 當成全部 */
  truncated: boolean
  bytes: number
  /**
   * **全部**預設打勾的有幾個檔、多大 —— 不受顯示上限影響。
   * CLI 的清單頁尾與唯讀試跑要用這兩個，不可以自己數 candidates（那只是前 500 個）。
   * 注意：預設清理一次最多 DEFAULT_PLAN_MAX_FILES 個，超過的部分見 defaultSelection().remaining。
   */
  defaultCheckedCount: number
  defaultCheckedBytes: number
  generatedAt: string
  candidates: CandidateRow[]
  /** 全部有幾筆（needsHuman 陣列會被砍到 50） */
  needsHumanTotal: number
  needsHumanTruncated: boolean
  needsHuman: NeedsHumanRow[]
}

type ItemRow = {
  id: string; path: string; name: string; bytes: number
  mtime: string; status: string; error: string | null
  sha256?: string | null
  last_seen_at?: string
}

/**
 * 這個檔**沒有內容指紋**（通常是超過大小上限）嗎？
 *
 * **判準要用這一列自己的事實，不可以用讀取時的門檻。** 用 `bytes > maxBytes`
 * 的話：大的半下載檔會被誤殺；使用者把上限調大（合法操作、不用重掃）時，
 * 那個 8GB 沒有指紋的備份檔會自己回到清單上；完全不傳 maxBytes 時保護整個消失。
 * 真正的事實是「有沒有算出指紋」，而它就在這一列上。
 *
 * 例外：半下載檔 scanner **刻意**不算指紋，那是正常的；0 byte 的檔沒有東西可算。
 */
function noFingerprint(item: ItemRow): boolean {
  const partial = PARTIAL_EXT.has(extname(item.name).toLowerCase())
  return item.sha256 == null && item.bytes > 0 && !partial
}

type CandRow = {
  id: string; item_id: string; kind: string
  confidence: number; reason: string; evidence: string
}

/**
 * 把絕對路徑拆成 UI 看得懂、但洩漏不出去的兩段。
 *
 * spec 第 6 節：「不把本機路徑洩漏給 UI」。
 * 但只給檔名的話，`2026/09/report.pdf` 跟 `report.pdf` 使用者分不出來，
 * 所以給**相對於監看資料夾**的子目錄。
 */
/** subdir 最多給幾段。**這是出口的硬上限，不靠設定正確。** */
const MAX_SUBDIR_SEGMENTS = 2

export function displayPath(path: string, roots: string[]): { folder: string; subdir: string } {
  // **取最長的命中，不是第一個。**
  // roots 同時有 /home/alice 與 /home/alice/Downloads 時（設定裡把家目錄
  // 也加進去，normalize 只會警告不會移除），取第一個會讓 folder 變成
  // 「alice」—— 使用者名稱就這樣出現在一個不需要 token 的端點上。
  const hit = roots
    .map(root => ({ root, rel: relative(root, path) }))
    .filter(h => {
      // 冒號檢查只看**開頭**（Windows 磁碟機字母）。套在整條相對路徑上的話，
      // `log-2026-09-15T10:30:00.zip` 這種合法的 POSIX 檔名會被誤殺。
      const outside = h.rel === '..' || h.rel.startsWith('..' + sep)
      return h.rel && !outside && !/^[A-Za-z]:/.test(h.rel)
    })
    .sort((a, b) => b.root.length - a.root.length)[0]

  // 比不到 root（設定改過、檔案被搬走）—— 只給檔名，寧可少講也不要洩漏
  if (!hit) return { folder: '', subdir: '' }

  const dir = dirname(hit.rel)
  let subdir = dir === '.' ? '' : dir
  // **出口硬上限。** watch 設成 `/` 的時候（normalize 只警告不移除），
  // relative('/', '/home/alice/Downloads/x.zip') 就是完整路徑少一個斜線，
  // 整條會變成 subdir。防線要在資料離開後端的那一行，不在設定驗證那一行。
  const segs = subdir.split(/[\\/]+/).filter(Boolean)
  if (segs.length > MAX_SUBDIR_SEGMENTS) subdir = '…/' + segs.slice(-2).join('/')

  // folder 是家目錄名字的話等於洩漏使用者名稱，不如不給
  const folder = basename(hit.root)
  // 比整條路徑，不要比 basename —— /mnt/backup/lulumi 跟家目錄沒關係
  return { folder: resolve(hit.root) === resolve(homedir()) ? '' : folder, subdir }
}

/**
 * duplicate 的 evidence 要**指名留著的是哪一份**。
 *
 * A 產出的是「同一個 sha256 還有 N 份檔案存在」，數字對但使用者無法確認安全 ——
 * 他沒辦法知道「我還留著一份」。這裡把留下來的那個檔名補進去。
 * 保留者的挑法跟 scanner 的 addDuplicateCandidates 一樣：**只看清理根目錄底下的**，
 * 最早被看到的那份（同時間比路徑）。不然會指名一份舊設定留下、執行層不承認的桌面檔。
 */
function enrichDuplicate(db: DatabaseSync, item: ItemRow, evidence: string, roots: string[], pre: string[]): string {
  const sha = item.sha256
  if (!sha) return evidence
  const keep = (db.prepare(
    `SELECT id, name, path FROM file_items
     WHERE sha256=? AND status NOT IN ('quarantined','missing','error')
     ORDER BY first_seen_at, path`
  ).all(sha) as { id: string; name: string; path: string }[]).find(r => underAny(r.path, pre))
  // **比 id 不比 name。** 比 name 的話，同名不同目錄
  //（`Downloads/report.pdf` 與 `Downloads/2026/09/report.pdf`，瀏覽器重下載很常見）
  // 會被當成同一個檔，「會留著」那句話整個消失 —— 而那句話正是使用者敢勾的理由。
  if (!keep || keep.id === item.id) return evidence
  const where = displayPath(keep.path, roots).subdir
  return `${evidence}，會留著「${keep.name}」` + (where ? `（在 ${where}）` : '')
}

/**
 * 把後端的錯誤原文換成一句固定的人話。
 *
 * **絕對不可以把 `file_items.error` 直通給 UI。** fs 的錯誤長這樣：
 *   `EACCES: permission denied, open '/home/u/Downloads/薪資單.pdf'`
 * 原文裡有完整路徑，而這個欄位會出現在畫面上、也會出現在不需要 token 的
 * /health 旁邊。稽查實測過真的漏出去。原文只留在資料庫裡給人查。
 *
 * **不匯出，對外只有 safeWhy 一個入口。** 直接拿這一支翻所有字串的話，
 * B 寫好的人話（「十分鐘內還在變動」）會被吃成「讀不到這個檔案」（稽核 RC11）。
 */
function humanError(raw: string | null): string {
  const s = String(raw ?? '')
  if (/EACCES|EPERM|permission denied/i.test(s)) {
    // 建隔離區資料夾、搬檔時的權限錯誤不是「讀不到」，講錯的話使用者會去查錯的地方
    if (/\bmkdir\b/.test(s)) return '沒有權限建立資料夾'
    if (/\brename\b/.test(s)) return '沒有權限搬動這個檔案'
    return '沒有權限讀這個檔案'
  }
  if (/ENOENT|no such file/i.test(s)) return '這個檔案已經不在了'
  if (/EISDIR/i.test(s)) return '這是一個資料夾，不是檔案'
  if (/EMFILE|ENFILE/i.test(s)) return '同時開太多檔案了，等一下會再試'
  if (/EBUSY|EAGAIN/i.test(s)) return '這個檔案正在被別的程式使用'
  if (/too large|太大|超過.*上限/i.test(s)) return TOO_LARGE_WHY
  return '讀不到這個檔案'
}

/**
 * 失敗原因要能給 UI 看。**全專案唯一一個翻譯函式**（RC11）。
 *
 * B 的 `cleanupProblem()` 寫進去的已經是人話而且不帶路徑 —— **原樣通過**，
 * 不然「十分鐘內還在變動，等一下再試」這種有用的話會被翻成「讀不到這個檔案」。
 * 但 `file_items.error` 也可能是 scanner 寫的 fs 原文，那種帶完整路徑。
 * 所以：**看起來帶路徑或 fs 錯誤碼的才翻譯**。
 */
export function safeWhy(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = String(raw)
  if (/[\/\\]|\bE[A-Z]{2,}\b/.test(s)) return humanError(s)
  return s.slice(0, 200)
}

export type ListOptions = {
  /** 清理的根目錄（cleanup.roots）。**只看這底下的候選**，也用來換算顯示用的 folder/subdir */
  roots: string[]
  limit?: number
}

// ── 候選的正本：清單、徽章、預設清理、建計畫都從這裡來 ────────────

const fold = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p

/**
 * 根目錄的比對前綴。原樣與真路徑都算 —— file_items.path 存的是 realpath，
 * macOS 的 /var → /private/var 這種情況只比原樣會一個都對不到。
 *
 * **前綴比對在 JS 做，不用 SQL 的 substr。** 根目錄含 emoji 等 astral 字元時，
 * JS 的 length（UTF-16）跟 SQLite 的 substr（字元）對不上（稽核 RC1）。
 */
function rootPrefixes(roots: string[]): string[] {
  const out = new Set<string>()
  for (const r of roots) {
    if (!r) continue
    const forms = [resolve(r)]
    try { forms.push(realpathSync(r)) } catch { /* 不存在就只用原樣 */ }
    for (const f of forms) out.add(fold(f.endsWith(sep) ? f : f + sep))
  }
  return [...out]
}

const underAny = (path: string, prefixes: string[]) => {
  const p = fold(path)
  return prefixes.some(pre => p.startsWith(pre))
}

/**
 * 建得了計畫的檔案狀態。**跟 cleanup-plans.ts 的 createPlan 一致**（那邊是 B 的，寫死在 SQL 裡）。
 * new ＝ 十分鐘內還在變動，執行層一定拒收；quarantined／missing／error 就更不用說。
 */
const PLANNABLE_STATUSES = `'candidate','kept','restored'`

type Group = { item: ItemRow; cands: CandRow[] }
type Collected = {
  /** 列得出來、建得了計畫的檔，依清單順序（信心高的在前） */
  rows: Group[]
  /** 跟清理有關、但要你自己看一眼的檔，最近看到的在前 */
  needsHuman: { item: ItemRow; why: string }[]
}

/**
 * 候選的**唯一一份**篩選。清單、徽章數字（/health、/pet/state）、預設清理、
 * 建計畫前的檢查全部從這裡來 —— 兩份篩選遲早會分歧，而分歧的後果是
 * 「清單上有、按下去卻 STALE」或「徽章說 7 個、清單只有 5 個」。
 *
 * 三條規則：
 *   1. **只看目前清理根目錄底下的**（RC15）。舊設定留下的桌面候選不再出現
 *   2. **列出來的就要搬得動**（RC4）。沒指紋（太大）的檔執行層一定拒收，改列到「需要你查看」；
 *      執行層因為檔名就拒收的（execRefusesName）不列
 *   3. **「需要你查看」只列跟清理有關的**（RC11）。一個沒命中任何規則的大 mp4 不關清理的事
 */
function collect(db: DatabaseSync, roots: string[]): Collected {
  const pre = rootPrefixes(roots)
  const cands = db.prepare(
    `SELECT c.id, c.item_id, c.kind, c.confidence, c.reason, c.evidence,
            i.path, i.name, i.bytes, i.mtime, i.status, i.error, i.sha256, i.last_seen_at
     FROM cleanup_candidates c
     JOIN file_items i ON i.id = c.item_id
     -- rule_version 一定要過濾。scanner 只清當前版本的候選，舊版本的
     -- proposed 列會永久活著 —— 那代表**調降規則信心永遠不會生效**
     -- （max 取的是「這個檔歷史上拿過的最高分」），而且同一個 kind
     -- 會在 reasons 裡出現兩次、舊版的 id 也會被送去 apply。
     WHERE c.status='proposed' AND c.rule_version = ?
       -- **跟 B 的 createPlan 用同一組條件**（檔案狀態白名單、理由與證據不可以是空的）。
       -- 上一版寫 NOT IN ('quarantined','missing','error')，放進了 'new'（十分鐘內還在變動）——
       -- 列得出來、建計畫卻回 STALE（結構化隨機測試抓到）。
       -- 'error' 一定要排除，不然讀不到的檔會同時出現在
       -- 「幫你勾好了」與「你自己看一眼」兩區，而且兩邊講的話互相矛盾
       AND i.status IN (${PLANNABLE_STATUSES})
       AND trim(c.reason) <> '' AND trim(c.evidence) <> ''
       -- **有 error 文字的也要排除**（status 可能還是 candidate：B 搬移失敗就是這樣寫的）。
       -- B 的 createPlan 本來就拒收 error 不是 NULL 的檔 —— 列在清單上
       -- 等於放一個永遠勾不成功的勾選框：前端保留勾選 → 建計畫回 STALE →
       -- 重載 → 還是勾著 → 又 STALE，死循環。**列出來的就要建得了計畫。**
       -- 重掃會清掉 error（upsertFile 的 error=excluded.error），所以會自己回來。
       AND i.error IS NULL
     -- tie-break 一定要穩定。原本是 c.id（UUID），兩條規則同分時
     -- 卡片標題每次重掃都會亂跳（實測 12 次 6:6）。最後補 item_id，
     -- 預設清理一次只收前 1000 個檔，是哪 1000 個也要每次都一樣。
     ORDER BY c.confidence DESC, c.kind, c.item_id`
  ).all(CLEANUP_RULE_VERSION) as (CandRow & ItemRow)[]

  const byItem = new Map<string, Group>()
  const outside = new Set<string>()
  for (const c of cands) {
    let g = byItem.get(c.item_id)
    if (!g) {
      if (outside.has(c.item_id)) continue
      // 執行層因為檔名本身就會拒收的（desktop.ini、*.url…）不列：升級前留下的這種候選，
      // 在下一次重掃把它改成 skipped 之前，列出來就是「勾得起、永遠搬不動」（RC4）
      if (!underAny(c.path, pre) || execRefusesName(c.name)) { outside.add(c.item_id); continue }
      g = {
        item: { id: c.item_id, path: c.path, name: c.name, bytes: c.bytes, mtime: c.mtime,
          status: c.status, error: c.error, sha256: c.sha256, last_seen_at: c.last_seen_at },
        cands: [],
      }
      byItem.set(c.item_id, g)
    }
    g.cands.push({ id: c.id, item_id: c.item_id, kind: c.kind, confidence: c.confidence,
      reason: c.reason, evidence: c.evidence })
  }

  const rows: Group[] = []
  const needsHuman: Collected['needsHuman'] = []
  for (const g of byItem.values()) {
    if (noFingerprint(g.item)) needsHuman.push({ item: g.item, why: TOO_LARGE_WHY })
    else rows.push(g)
  }
  needsHuman.push(...brokenForHuman(db, pre))
  needsHuman.sort((a, b) => cmpDesc(a.item.last_seen_at, b.item.last_seen_at) || (a.item.id < b.item.id ? -1 : 1))
  return { rows, needsHuman }
}

/**
 * 讀不到、搬不動的檔要讓使用者知道，但**不可以把路徑帶出去**。
 * **不可以只看 status='error'**：B 搬移失敗是寫 error 文字、status 留在 candidate。
 *
 * **只列跟清理有關的**（RC11），而且**只看資料庫裡的事實**：
 * 讀不到（status=error）一定算 —— 它可能就是垃圾，只是我們看不到；其餘的要「已經是候選」：
 * status 是 candidate（搬移失敗），或還有提議中的候選。一個沒命中任何規則的大 mp4 不列。
 *
 * **不在讀取的時候再跑一次規則，也不把無關的列讀進 JS。** 上一版對每個有錯的檔呼叫
 * classifyByRules，而 /health 免 token、任何網頁都能用 <img> 連發（第一波驗證：2 萬個大檔 50 ms）。
 * 規則本來就是掃描時跑的：太大的檔掃描器照樣分類，命中就會有候選；「過了幾天才變成舊檔」
 * 這種變化，跟一般候選一樣等下一次掃描才出現。篩選寫在 SQL 裡，無關的大檔不會被讀出來。
 */
function brokenForHuman(db: DatabaseSync, pre: string[]): Collected['needsHuman'] {
  const broken = db.prepare(
    `SELECT i.id, i.path, i.name, i.bytes, i.mtime, i.status, i.error, i.sha256, i.last_seen_at
       FROM file_items i
      WHERE (i.status='error' OR i.error IS NOT NULL) AND i.status NOT IN ('quarantined','missing')
        AND (i.status IN ('error','candidate')
             OR EXISTS (SELECT 1 FROM cleanup_candidates c WHERE c.item_id = i.id
                          AND c.status='proposed' AND c.rule_version = ?))`
  ).all(CLEANUP_RULE_VERSION) as ItemRow[]
  const out: Collected['needsHuman'] = []
  for (const b of broken) {
    if (!underAny(b.path, pre)) continue
    out.push({ item: b, why: needsHumanWhy(b) })
  }
  return out
}

/**
 * 只要數字的版本（/health、/pet/state 的徽章）。**篩選條件跟 collect 一模一樣**，
 * 只是不把每一條候選的理由與證據都讀出來 —— /health 不需要 token，
 * 任何網頁都能用 <img> 連發，7000 個檔時完整版要 30 多 ms，這一版不到十分之一。
 * test/audit-0919-routes.test.mjs 有一條拿兩版對照。
 */
function collectCounts(db: DatabaseSync, roots: string[]): { pending: number; needsHuman: number } {
  const pre = rootPrefixes(roots)
  const items = db.prepare(
    `SELECT i.id, i.path, i.name, i.bytes, i.sha256 FROM file_items i
      WHERE i.status IN (${PLANNABLE_STATUSES}) AND i.error IS NULL
        AND EXISTS (SELECT 1 FROM cleanup_candidates c WHERE c.item_id = i.id
                      AND c.status='proposed' AND c.rule_version = ?
                      AND trim(c.reason) <> '' AND trim(c.evidence) <> '')`
  ).all(CLEANUP_RULE_VERSION) as ItemRow[]
  let pending = 0, tooLarge = 0
  for (const i of items) {
    if (!underAny(i.path, pre) || execRefusesName(i.name)) continue
    if (noFingerprint(i)) tooLarge++
    else pending++
  }
  return { pending, needsHuman: tooLarge + brokenForHuman(db, pre).length }
}

const cmpDesc = (a = '', b = '') => a < b ? 1 : a > b ? -1 : 0

function needsHumanWhy(b: ItemRow): string {
  // 太大是事實（沒有指紋），不看 scanner 寫了什麼字 —— 那句「超過清理掃描上限」
  // 以前被翻成「讀不到這個檔案」（稽核 RC11）。
  if (b.status !== 'error' && noFingerprint(b)) return TOO_LARGE_WHY
  return safeWhy(b.error) ?? '讀不到這個檔案'
}

const isDefaultChecked = (g: Group) => g.cands[0].confidence >= DEFAULT_CHECK_MIN

/**
 * 清理候選，以**檔案**為單位。
 * HTTP route 與 CLI 都用這一支 —— 不准有第二份組裝邏輯。
 */
export function listCandidates(db: DatabaseSync, opts: ListOptions): CandidateList {
  const limit = opts.limit ?? 500
  const all = collect(db, opts.roots)
  const pre = rootPrefixes(opts.roots)

  const rows: CandidateRow[] = []
  let bytes = 0, checkedCount = 0, checkedBytes = 0
  for (const g of all.rows) {
    // 一個檔一個決定，用**最高**信心那條。
    //
    // 為什麼是 max 不是 min：每一條規則都是「這是垃圾」的獨立證據，
    // 多命中一條是證據變多不是變少。取 min 的話，加規則會讓系統變得
    // 更不敢清 —— 200 天的 zip 反而比 40 天的難清掉，那很荒謬。
    //
    // **陷阱**：將來要加「使用者釘選」「最近開過」這種「絕對不要動」的規則，
    // **必須做成否決旗標，不可以做成一條低信心候選** —— max 會把它蓋掉。
    const checked = isDefaultChecked(g)
    // 預設打勾的數字要算**全部**，不受顯示上限影響（RC12）
    if (checked) { checkedCount++; checkedBytes += g.item.bytes }
    if (rows.length >= limit) continue

    const item = g.item
    // 已經照 confidence DESC 抓出來了，第一筆就是最高的
    const reasons: CandidateReason[] = g.cands.map(c => ({
      kind: c.kind,
      confidence: c.confidence,
      reason: c.reason,
      evidence: c.kind === 'duplicate' ? enrichDuplicate(db, item, c.evidence, opts.roots, pre) : c.evidence,
    }))
    const top = reasons[0]
    const { folder, subdir } = displayPath(item.path, opts.roots)
    rows.push({
      itemId: item.id, name: item.name, folder, subdir,
      bytes: item.bytes, mtime: item.mtime,
      kind: top.kind,
      confidence: top.confidence,
      defaultChecked: checked,
      vetoed: null,
      candidateIds: g.cands.map(c => c.id),
      reasons,
    })
    bytes += item.bytes
  }

  const NEEDS_HUMAN_LIMIT = 50
  const nh = all.needsHuman
  return {
    total: rows.length,
    totalAvailable: all.rows.length,
    truncated: all.rows.length > rows.length,
    bytes,
    defaultCheckedCount: checkedCount,
    defaultCheckedBytes: checkedBytes,
    generatedAt: new Date().toISOString(),
    candidates: rows,
    needsHumanTotal: nh.length,
    needsHumanTruncated: nh.length > NEEDS_HUMAN_LIMIT,
    needsHuman: nh.slice(0, NEEDS_HUMAN_LIMIT).map(({ item, why }) => ({
      itemId: item.id,
      name: item.name,
      folder: displayPath(item.path, opts.roots).folder,
      bytes: item.bytes,
      why,
    })),
  }
}

// ── health ───────────────────────────────────────────────────

export type HealthOptions = {
  /** 傳函式的話會延後求值 —— 呼叫端才不用在建構時就去讀設定檔 */
  roots: string[] | (() => string[])
  quarantine: string
  /** 這兩個只有會動檔案的 route 才需要。跟 roots 一樣可以是 thunk（延後讀設定）。 */
  maxBytes?: number | (() => number)
  readonly?: boolean | (() => boolean)
  version?: string
  /**
   * 帶 token 的呼叫才給完整內容。
   *
   * `/health` 在 token 檢查之前，所以同機任何行程、任何已安裝的擴充套件
   * 都讀得到。`watching` 的資料夾顯示名（watch 設成家目錄時就是使用者名稱）、
   * `lastError`（設計上會放錯誤訊息，那種字串很容易帶路徑）都不該無條件送出。
   */
  full?: boolean
}

const getMeta = (db: DatabaseSync, k: string): string | null =>
  ((db.prepare(`SELECT v FROM meta WHERE k=?`).get(k) as { v: string } | undefined)?.v) ?? null

/** 那個 pid 還活著嗎。心跳只證明「它上次寫的時候還活著」。 */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true }
  catch (e: any) { return e?.code === 'EPERM' }
}

/** 隔離區走訪的深度上限。B 的結構是 <plan>/<item>/content，正常只有三層。 */
const MAX_QUARANTINE_DEPTH = 8


/** 任何一段查詢炸掉都不可以讓整個健康快照少半邊。泛型用函式宣告，箭頭會被當成 JSX。 */
function safe<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}

/**
 * 隔離區現在可不可以清空。
 *
 * 抽成純函式是為了**測得到**：「滿七天 + 走訪沒看完」這個組合
 * 用真實檔案造不出來，留在 healthSnapshot 裡的話永遠碰不到那個分支。
 * 突變測試證實過 —— 把 `!truncated` 拿掉，整套測試照樣全綠。
 *
 * `canEmptyNow` 的意思是**「按下去會有東西被刪掉」**，不是「整區都能清」。
 * `emptyQuarantine` 本來就只刪合格的那幾筆，所以只要有一筆滿七天就成立。
 * 這個定義跟 canEmptyAt 互推：`canEmptyNow === (canEmptyAt !== null && canEmptyAt <= now)`。
 */
export function canEmptyNow(
  q: { items: number; truncated: boolean; canEmptyAt: string | null },
  now: number = Date.now(),
): boolean {
  if (q.items === 0) return false        // 空的隔離區「可以清空」沒有意義
  if (q.truncated) return false          // 沒看完 → fail closed
  if (!q.canEmptyAt) return false        // 算不出時間 → fail closed
  return Date.parse(q.canEmptyAt) <= now
}

export type QuarantineView = {
  items: number
  bytes: number
  oldestMtimeAt: string | null
  /** **最早**一筆變得可刪的時間。取最新那筆的話，UI 會說「還要等七天」，而其實明天就有東西可清。 */
  canEmptyAt: string | null
  /** 隔離區裡有、journal 沒有的檔。清空不會動到它們。 */
  orphans: number
  truncated: boolean
}

/**
 * 隔離區的狀態，**不上鎖**。
 *
 * B 的 `listQuarantine()` 會拿 `withCleanupLock`（寫 `cleanup_operation_lock`）。
 * 但 `/health` **不需要 token**，任何網頁都可以用 `<img src=...>` 連發
 * （它讀不到回應，但請求照樣執行）。健康檢查拿寫鎖 =
 * 一個外部網頁就能跟真正的清理動作搶鎖、或讓 /health 一直丟 BUSY。
 *
 * 所以這裡自己下唯讀查詢。**journal 是正本**，磁碟只用來數孤兒 ——
 * 有人手動丟檔進隔離區、或是搬完檔但寫 DB 前當機，都會留下 journal 沒有的檔案。
 * 那些檔 `emptyQuarantine` 不會刪，所以要另外報數；但也**不可以**讓它們擋住清空，
 * 不然一個孤兒就讓隔離區永遠清不掉。
 */
export function quarantineFromJournal(db: DatabaseSync, dir: string): QuarantineView {
  // **B 的表是懶建的。** `cleanup_move_details` 與 `cleanup_purges` 只在
  // `initCleanup()` 裡建，而那支只被 createPlan／getPlan 呼叫 ——
  // 全新安裝、還沒建過任何 plan 的機器上它們不存在，JOIN 會丟例外，
  // 外層的 safe() 就把整個隔離區區塊吞成 truncated，而且永遠不會好。
  //
  // 這裡**不主動建表**：/health 不需要 token，不可以在那條路徑上做 DDL 寫入。
  // 沒有 journal 就代表從來沒搬過檔 —— 隔離區裡任何東西都是孤兒，這是誠實的答案。
  const ready = db.prepare(
    `SELECT count(*) n FROM sqlite_master WHERE type='table'
       AND name IN ('cleanup_journal','cleanup_move_details','cleanup_purges')`
  ).get() as { n: number }
  if (ready.n < 3) {
    const onDisk = countFilesCached(dir)
    return { items: 0, bytes: 0, oldestMtimeAt: null, canEmptyAt: null,
      orphans: onDisk < 0 ? 0 : onDisk, truncated: onDisk < 0 }
  }

  const rows = db.prepare(
    `SELECT q.seq, d.completed_at, d.fingerprint,
            EXISTS (SELECT 1 FROM cleanup_journal r
                     WHERE r.plan_id=q.plan_id AND r.item_id=q.item_id
                       AND r.op='restore' AND r.status='started') AS restoring
       FROM cleanup_journal q
       JOIN cleanup_move_details d ON d.seq = q.seq
      WHERE q.op='quarantine' AND q.status='done'
        AND NOT EXISTS (SELECT 1 FROM cleanup_journal r
                         WHERE r.plan_id=q.plan_id AND r.item_id=q.item_id
                           AND r.op='restore' AND r.status='done')
        AND NOT EXISTS (SELECT 1 FROM cleanup_purges p WHERE p.seq=q.seq AND p.status='done')`
  ).all() as { seq: number; completed_at: string | null; fingerprint: string; restoring: number }[]

  let bytes = 0, oldestMtime: number | null = null, earliest: number | null = null
  let truncated = false
  for (const r of rows) {
    // 大小與 mtime 存在 fingerprint 的 JSON 裡（B 的格式）。讀不出來就當 0，
    // 但**不影響七天窗** —— 那是 completed_at 的事。
    const fp = safe(() => JSON.parse(r.fingerprint) as { size?: number; mtime?: string }, {})
    bytes += fp.size ?? 0
    const m = fp.mtime ? Date.parse(fp.mtime) : NaN
    if (Number.isFinite(m) && (oldestMtime === null || m < oldestMtime)) oldestMtime = m
    // 復原到一半中斷的還在隔離區（照數），但清空不會刪它，所以不算進「最早可以清空」
    if (r.restoring) continue
    const done = r.completed_at ? Date.parse(r.completed_at) : NaN
    // 缺隔離完成時間就算不出七天 → fail closed，而不是當成「很久以前」
    if (!Number.isFinite(done)) { truncated = true; continue }
    const at = done + RETENTION_MS
    if (earliest === null || at < earliest) earliest = at
  }

  const onDisk = countFilesCached(dir)
  // -1 代表磁碟讀不到／沒看完。journal 說有 N 筆但磁碟數不出來 → 說不出有沒有孤兒
  const orphans = onDisk < 0 ? 0 : Math.max(0, onDisk - rows.length)
  if (onDisk < 0) truncated = true

  return {
    items: rows.length,
    bytes,
    oldestMtimeAt: oldestMtime === null ? null : new Date(oldestMtime).toISOString(),
    canEmptyAt: earliest === null ? null : new Date(earliest).toISOString(),
    orphans,
    truncated,
  }
}

/** 只數檔案數，用來對帳孤兒。讀不到／沒看完就回 -1（**不是 0** —— 0 會被當成「確定沒有孤兒」）。 */
function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0
  let n = 0
  let ok = true
  const walk = (d: string, depth: number) => {
    if (depth > MAX_QUARANTINE_DEPTH) { ok = false; return }
    let entries
    // 讀不到子目錄跟深度截斷的意義一樣：**我沒有看完**，說不出有沒有孤兒。
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { ok = false; return }
    for (const e of entries) {
      if (e.isDirectory()) walk(d + sep + e.name, depth + 1)
      else if (e.isFile()) n++
    }
  }
  walk(dir, 0)
  return ok ? n : -1
}

/**
 * 數檔案要快取。
 *
 * 七天窗現在走 journal（一次 SQL），但**孤兒對帳還是得走訪磁碟**，
 * 而 `/health` 不需要 token —— 這支是同步遞迴，4 萬個檔實測 61ms，
 * 那段時間整個事件迴圈是停住的。任何網頁都可以用不帶 Origin 的 `<img>` 連發
 * （它讀不到回應，但請求照樣執行）。隔離區只有 B 的 exec 會改，十秒夠用。
 */
let countCache: { dir: string; at: number; files: number } | null = null

function countFilesCached(dir: string): number {
  if (countCache && countCache.dir === dir && Date.now() - countCache.at < 10_000) return countCache.files
  const files = countFiles(dir)
  countCache = { dir, at: Date.now(), files }
  return files
}

/** B 搬完檔呼叫這個，數字立刻更新 —— 不然新檔在那十秒裡看起來像孤兒。 */
export function invalidateQuarantineCache() { countCache = null }

/**
 * 寵物狀態。**第一個成立的贏。**
 *
 * spec 第 8 節把 `undoable` 列成一個 state，但它的條件是
 * 「隔離區裡還有這份 plan 的檔」——那會成立**七天**。當成 state 的話
 * 寵物會卡在「可以復原」整整一週，`found`／`watching` 永遠不會出現。
 * 所以降成旗標。
 *
 * 另外 `thinking`／`cleaning`／`happy` 後端**查不出來**：掃描與 apply
 * 都是同步 request，回應送出的時候它們已經結束了。那三個是前端在等
 * response 的時候自己播的動畫，不該由這裡回報。
 */
export function petState(
  h: {
    db: { ok: boolean }; watcher: { ok: boolean }; pendingCandidates: number; lastError: unknown
    lastErrorAt?: string | null; lastOkAt?: string | null
  },
  counts: { proposedPlans: number; activeQuarantine: number },
) {
  const state =
    // 壞掉的時候顯示「找到 7 個可以清」是在騙人
    !h.db.ok || errorStillActive(h) ? 'worried'
    // 使用者正在等確認，這時候跳「找到東西了」會蓋掉待辦
    : counts.proposedPlans > 0 ? 'waiting'
    : h.pendingCandidates > 0 ? 'found'
    : h.watcher.ok ? 'watching'
    : 'idle'

  const message =
    state === 'worried' ? '後端出了點狀況，先看一下 doctor。'
    : state === 'waiting' ? `有 ${counts.proposedPlans} 份清單等你確認。`
    : state === 'found' ? `找到 ${h.pendingCandidates} 個可以清的檔案。`
    : state === 'watching' ? '盯著 Downloads。'
    : '沒事，在發呆。'

  return {
    state,
    message,
    pendingCount: h.pendingCandidates,
    quarantinedCount: counts.activeQuarantine,
    undoable: counts.activeQuarantine > 0,
  }
}

/**
 * 上一次的錯還「算數」嗎？**之後有成功過就不算。**
 *
 * 稽查抓到（A-M4、C-C3）：lastError 寫了就永遠不清，一次 BUSY、一次打錯的網址
 * 就讓寵物永久擔心。修法是記「最近一次成功」，比時間。
 * 沒有時間可比（舊格式、或呼叫端只給了 lastError）的時候倒向擔心 —— 寧可多看一眼。
 */
function errorStillActive(h: { lastError: unknown; lastErrorAt?: string | null; lastOkAt?: string | null }): boolean {
  if (!h.lastError) return false
  const e = Date.parse(h.lastErrorAt ?? ''), o = Date.parse(h.lastOkAt ?? '')
  return !(Number.isFinite(e) && Number.isFinite(o) && o > e)
}

/** meta 裡的 lastError 是「ISO 時間 空白 訊息」。舊資料可能帶路徑，讀出來一律再翻一次。 */
function parseLastError(raw: string | null): { at: string | null; why: string | null } {
  if (!raw) return { at: null, why: null }
  const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+([\s\S]*)$/.exec(raw)
  const at = m && Number.isFinite(Date.parse(m[1])) ? m[1] : null
  return { at, why: safeWhy(m ? m[2] : raw) ?? '後端出錯了' }
}

const setMeta = (db: DatabaseSync, k: string, v: string) =>
  db.prepare(`INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(k, v)

/**
 * 時間戳要**嚴格晚於**另一個。同一毫秒內先錯後成功（或先成功後錯），
 * 單看時鐘分不出先後；寵物要看得出哪個在後。時鐘往回跳也一樣成立。
 */
function laterThan(other: string | null): string {
  const o = other ? Date.parse(other) : NaN
  return new Date(Number.isFinite(o) ? Math.max(Date.now(), o + 1) : Date.now()).toISOString()
}

/**
 * 這個錯值不值得記。**只記真的意外**（RC5）：
 * - 不是 CleanupError（程式或資料庫壞了）
 * - CleanupError 而且對到 5xx，但**不是 BUSY** —— BUSY 是「等一下就好」，
 *   記了寵物就為了一件自己會好的事擔心
 * 4xx 是呼叫端的事，記了只會把 doctor 洗版。
 */
export function isSurprise(e: unknown): boolean {
  if (!(e instanceof CleanupError)) return true
  return statusFor(e.code) >= 500 && e.code !== 'BUSY'
}

/**
 * 記一筆後端意外。不是意外（見 isSurprise）就什麼都不做，回 false。
 *
 * **存的是翻過的人話（safeWhy）＋時間，不存原文。** 原文只進 console ——
 * fs 的錯誤訊息一律帶完整路徑，而 lastError 會出現在 /health。
 * CLI 也要用這一支，不要自己寫 meta。
 */
export function recordCleanupError(db: DatabaseSync, e: unknown): boolean {
  if (!isSurprise(e)) return false
  const raw = String((e as any)?.message ?? e).slice(0, 300)
  console.error('[contextbox] 清理出錯：', raw)
  try {
    const why = safeWhy(raw) ?? '後端出錯了'
    setMeta(db, META.lastError, `${laterThan(safe(() => getMeta(db, META.lastOk), null))} ${why}`)
  } catch { /* 連 meta 都寫不進去就算了 */ }
  return true
}

/**
 * 記一次成功（寫 lastOkAt）。成功的掃描、套用、復原、清空都要記 —— route 與 CLI 都用這一支，
 * 不要自己寫 meta。寵物只在 lastError 比這個新的時候擔心。
 */
export function recordOk(db: DatabaseSync): void {
  try {
    setMeta(db, META.lastOk, laterThan(parseLastError(getMeta(db, META.lastError)).at))
  } catch { /* 寫不進去就算了：頂多寵物多擔心一下 */ }
}

/** 舊名字（第一波的介面），跟 recordOk 是同一支。新程式碼請用 recordOk。 */
export const recordCleanupOk = recordOk

export function healthSnapshot(db: DatabaseSync, opts: HealthOptions) {
  const rootList = typeof opts.roots === 'function' ? opts.roots() : opts.roots
  // **每一段各自 try/catch。** 這支是唯一免 token 的端點，它必須
  // 永遠回得出完整形狀 —— 資料庫壞掉時回一個少了 watcher／quarantine
  // 的第三種形狀，UI 會直接 TypeError。
  // 而且 lastError 要**最先**讀：資料庫壞掉正是它唯一要處理的情境，
  // 排在後面的話會先被別的查詢炸掉，整條回饋迴路失效。
  const lastErrorRaw = safe(() => getMeta(db, META.lastError), null)
  const lastErr = parseLastError(lastErrorRaw)
  const lastOkAt = safe(() => getMeta(db, META.lastOk), null)
  const beat = safe(() => getMeta(db, META.heartbeat), null)
  const pid = Number(safe(() => getMeta(db, META.pid), null))
  const running = Boolean(beat) && alive(pid)
  const fresh = Boolean(beat) && (Date.now() - Date.parse(beat!)) < 5 * 60_000

  // 隔離區：journal 是正本，磁碟只用來對帳（見 quarantineFromJournal）。
  const q = safe(() => quarantineFromJournal(db, opts.quarantine),
    { items: 0, bytes: 0, oldestMtimeAt: null, canEmptyAt: null, orphans: 0, truncated: true })

  // 徽章數字跟清單**同一套篩選**（collectCounts 是 collect 的只數數字版）。各自寫一條 COUNT 的話，
  // 清單排掉的（桌面上的、太大的、跟清理無關的大檔）這裡還會算進去。
  const counted = safe(() => collectCounts(db, rootList), { pending: 0, needsHuman: 0 })
  const pending = counted.pending
  const errors = counted.needsHuman

  // 真的問資料庫一次。寫死 true 的話，資料庫壞到其他每一條 route 都在噴，
  // /health 還會說一切正常 —— 那這個端點就沒有輸入，只是一個裝飾。
  let dbOk = true
  try { db.prepare('SELECT 1').get(); db.prepare('SELECT count(*) FROM meta').get() } catch { dbOk = false }

  // 監看資料夾不存在的話，掃描會安靜地回 0 個檔 —— 跟「很乾淨」長得一模一樣。
  // 使用者搬了家目錄、換了 OneDrive 路徑、外接碟沒掛上，都會踩到。
  const rootsMissing = rootList.filter(r => !existsSync(r)).length
  const watcherOk = running && fresh && rootsMissing === 0
  const full = opts.full === true

  return {
    // **ok 只講「這台後端能不能用」。** watcher 有沒有在跑是另一回事 ——
    // 使用者剛裝好還沒開 pet，後端是好的（查得到候選、資料庫是通的），
    // 這時候回 ok:false 對 liveness probe 與 UI 都是錯的訊號。
    ok: dbOk,
    version: opts.version ?? '0.1.0',
    db: { ok: dbOk },
    watcher: {
      ok: watcherOk,
      // **形狀在兩版之間必須一致。** 換型別（string[] ↔ number）的話，
      // C 拿免 token 那版做 UI，`watching.map(...)` 直接 TypeError。
      // undefined 更糟 —— JSON.stringify 會整個刪掉，連「這個欄位被遮蔽了」
      // 都看不出來。所以：一律有，遮蔽時給 null／空陣列。
      lastHeartbeatAt: full ? beat : null,
      pid: full ? (Number.isInteger(pid) && pid > 0 ? pid : null) : null,
      rootsMissing,
      watchingCount: rootList.length,
      // 顯示名只給帶 token 的。watch 設成家目錄時，basename 就是使用者名稱。
      watching: full ? rootList.map(r => displayPath(join(r, 'x'), rootList).folder) : [],
      why: !beat ? '從來沒跑過'
        : !running ? '那個行程已經不在了'
        : !fresh ? '行程還在，但心跳停了超過五分鐘'
        : rootsMissing ? '有監看資料夾不存在'
        : null,
    },
    quarantine: {
      items: q.items, bytes: q.bytes,
      /** 檔案自己的 mtime，**不是**隔離時間。只拿來顯示，不要拿來算七天。 */
      oldestMtimeAt: q.oldestMtimeAt,
      canEmptyAt: q.canEmptyAt,
      canEmptyNow: canEmptyNow(q),
      /** 隔離區裡有、journal 沒有的檔。清空**不會**動到它們，所以要說出來。 */
      orphans: q.orphans,
      truncated: q.truncated,
    },
    pendingCandidates: pending,
    needsHumanCount: errors,
    // lastError 的內容只給帶 token 的。存進去的時候已經翻成人話（recordCleanupError），
    // 讀出來再翻一次 —— 舊版存的是原文，帶完整路徑（fs 的 message 一律含 path）。
    lastError: full
      ? (lastErrorRaw ? (lastErr.at ? `${lastErr.at} ${lastErr.why}` : lastErr.why) : null)
      : (lastErrorRaw ? '有，帶 token 才看得到' : null),
    // 時間只給帶 token 的：免 token 的 /health 同機任何行程都讀得到，時間會洩漏
    // 「使用者什麼時候清理過」。欄位兩版都有（形狀一致），遮蔽時是 null。
    // 寵物（/pet/state，要 token）拿它們比「錯在成功之後嗎」。
    lastErrorAt: full ? lastErr.at : null,
    lastOkAt: full ? lastOkAt : null,
  }
}

// ── 預設要清哪些 ─────────────────────────────────────────────

/** createPlan 的 validateIds 上限。一個檔最多命中五、六條規則，1000 個檔不會超過 —— 但防線不靠估計。 */
const MAX_PLAN_IDS = 5000

/**
 * 「預設清理」要清的候選。**跟清單上打 ✔ 的一模一樣，但一次最多 maxFiles 個檔**（RC12）。
 *
 * B 的 createPlan 不帶 id 時有自己的預設（信心 ≥ 50），但它**不看否決**、也不看清理根目錄。
 * 所以 route 與 CLI 一律用這支算出明確的 id 再交給 createPlan：
 * **defaultChecked 只有 listCandidates 一個地方在決定**（spec 不變量 2）。
 *
 * 不受顯示上限影響（清單只列 500 個，預設清理看的是全部打 ✔ 的），
 * 但一次只收前 maxFiles 個 —— 上一版不設上限，超過 5000 個 id 時 createPlan
 * 直接回 BAD_BODY，使用者什麼都清不了（A-C7）。剩下幾個放在 remaining，
 * 呼叫端要講清楚「剩下 N 個下次再清」。
 */
export function defaultSelection(db: DatabaseSync, roots: string[], maxFiles: number = DEFAULT_PLAN_MAX_FILES) {
  const checked = collect(db, roots).rows.filter(isDefaultChecked)
  const candidateIds: string[] = []
  let files = 0, bytes = 0
  for (const g of checked) {
    if (files >= maxFiles || candidateIds.length + g.cands.length > MAX_PLAN_IDS) break
    for (const c of g.cands) candidateIds.push(c.id)
    files++
    bytes += g.item.bytes
  }
  return { candidateIds, files, bytes, remaining: checked.length - files }
}

/**
 * 同 defaultSelection，回候選 id 陣列（可以直接交給 createPlan）。
 * 陣列上另外掛兩個**不列舉**的屬性：`files`（這次收了幾個檔）與 `remaining`（還剩幾個下次再清）。
 */
export function defaultCandidateIds(db: DatabaseSync, roots: string[]): string[] & { files: number; remaining: number } {
  const s = defaultSelection(db, roots)
  return Object.defineProperties(s.candidateIds, {
    files: { value: s.files },
    remaining: { value: s.remaining },
  }) as string[] & { files: number; remaining: number }
}

/**
 * 建計畫，但**只收目前清單上列得出來的候選**（RC4、RC15）。
 *
 * createPlan（B）不知道清理根目錄，也不知道「太大」的檔執行層一定拒收。
 * 不在這裡擋的話：舊資料庫裡桌面的候選 id、太大的檔的 id 都建得成計畫，
 * 然後永遠搬不動、把檔案佔住。清單與建計畫要用**同一套篩選**（collect）。
 *
 * 同一個 requestId 的重送不檢查 —— 那是網路斷線後的重播，檔案可能已經搬走了
 * （所以不在清單上），createPlan 會認出它並回原本那份（冪等）。
 *
 * route 與 CLI 都用這一支。
 */
export function createPlanForRoots(db: DatabaseSync, roots: string[], opts: { candidateIds: unknown; requestId?: unknown }) {
  validateIds(opts.candidateIds)
  const ids = opts.candidateIds
  const replay = typeof opts.requestId === 'string' && opts.requestId.length > 0 && safe(() => Boolean(
    db.prepare('SELECT 1 FROM cleanup_plan_requests WHERE request_id=?').get(opts.requestId as string)), false)
  if (!replay) {
    const listed = new Set(collect(db, roots).rows.flatMap(g => g.cands.map(c => c.id)))
    if (ids.some(id => !listed.has(id))) {
      throw new CleanupError('STALE_CANDIDATE', '候選已變更，請重新掃描並建立計畫。')
    }
  }
  return createPlan(db, { candidateIds: ids, requestId: opts.requestId as string | undefined })
}

/**
 * 撞到 CONFLICT 的時候，**擋住這次勾選的是哪一份計畫**（RC7）。
 *
 * UI 原本自己去拿「最新一份還沒做完的」—— 那一份不一定跟這次勾的有關係。
 * 稽查實測：舊計畫佔著 a、新計畫只有 z，使用者只勾 a，面板請他「繼續上次那份」，
 * 結果搬走的是 z（A-M2、C-M2）。
 *
 * 找的是檔案跟這次勾選有交集的 **proposed** 計畫 —— 計畫是一次性的，
 * 只有還沒套用的 proposed 會佔住檔案（跟 createPlan 一致）。套用過的 partial／error
 * 不佔檔，回它的話 CLI 會叫使用者去 undo 一份無關的計畫。多份取最新的。找不到回 null。
 */
export function blockingPlanFor(db: DatabaseSync, candidateIds: string[]) {
  if (!candidateIds.length) return null
  const ready = (db.prepare(
    `SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='cleanup_snapshots'`).get() as { n: number }).n
  if (!ready) return null
  const p = db.prepare(
    `SELECT p.id, p.status, p.created_at FROM cleanup_plans p
      WHERE p.status = 'proposed'
        AND EXISTS (SELECT 1 FROM cleanup_snapshots s
                     WHERE s.plan_id = p.id
                       AND s.item_id IN (SELECT item_id FROM cleanup_candidates
                                          WHERE id IN (SELECT value FROM json_each(?))))
      ORDER BY p.created_at DESC, p.rowid DESC LIMIT 1`
  ).get(JSON.stringify([...new Set(candidateIds)])) as { id: string; status: string; created_at: string } | undefined
  if (!p) return null
  const items = (db.prepare('SELECT snapshot FROM cleanup_snapshots WHERE plan_id=? ORDER BY rowid').all(p.id) as { snapshot: string }[])
    .map(r => JSON.parse(r.snapshot) as { id: string; name: string; bytes: number })
    .map(i => ({ itemId: i.id, name: i.name, bytes: i.bytes }))
  return { id: p.id, status: p.status, createdAt: p.created_at, items }
}

// ── 計畫的逐項結果 ───────────────────────────────────────────

export type ItemOutcome =
  | 'pending' | 'moved' | 'skipped' | 'failed' | 'restored' | 'purged'
  /** journal 停在 started：搬（或復原）到一半中斷，檔案在哪裡不確定 */
  | 'unknown'
  /** 計畫被放棄了（dismiss／release），這個檔沒有動過 */
  | 'cancelled'
type Outcome = { outcome: ItemOutcome; why: string | null; restoredAs?: string }

/**
 * 搬到一半中斷的話。**不可以說「沒有搬動」** —— rename 可能已經完成、只是還沒寫 done
 * （kill -9、斷電）。稽查實測：檔案在隔離區，畫面說「沒有搬動，原因不明」（A-M3）。
 * 再套用一次同一份計畫會把它接完（performMove 認得「已經到了」）。
 */
const MOVE_INTERRUPTED = '搬到一半中斷，檔案可能已經在隔離區。再套用一次這份計畫會把它接完。'
const RESTORE_INTERRUPTED = '復原到一半中斷，檔案可能已經放回原位。再按一次復原會把它接完。'

const tableExists = (db: DatabaseSync, name: string) =>
  Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name))

/** 已經確認清空的隔離紀錄。列很多份計畫的時候**只讀一次**（RC19）。 */
function purgedSeqs(db: DatabaseSync): Set<number> {
  if (!tableExists(db, 'cleanup_purges')) return new Set()
  return new Set((db.prepare(`SELECT seq FROM cleanup_purges WHERE status='done'`).all() as { seq: number }[]).map(r => r.seq))
}

function storedWhys(db: DatabaseSync, planId: string): Map<string, string> {
  return new Map(safe(() => db.prepare('SELECT item_id, why FROM cleanup_item_errors WHERE plan_id=?')
    .all(planId) as { item_id: string; why: string }[], []).map(r => [r.item_id, r.why]))
}

type OutcomeOptions = {
  /** 呼叫端已經讀好的清空紀錄（列很多份的時候共用一份） */
  purged?: Set<number>
  /** false ＝ 不讀 cleanup_item_errors，只看 journal 與 file_items（recordItemErrors 用） */
  stored?: boolean
}

/**
 * 內部用的逐項結果：
 * - `raw` 是「這次從 journal／file_items 讀到的原因」，讀不到就是 null ——
 *   recordItemErrors 靠它判斷要不要蓋掉舊的紀錄。
 * - `restoring` 是「復原到一半中斷」（outcome 是 unknown）：檔案可能還在隔離區，
 *   **再按一次復原會把它接完**，所以它算「可以復原」（listPlans 的 undoable、canUndo）。
 */
type InnerOutcome = Outcome & { raw: string | null; restoring: boolean }

function outcomesOf(db: DatabaseSync, planId: string, opts: OutcomeOptions = {}): Map<string, InnerOutcome> {
  const plan = db.prepare('SELECT status FROM cleanup_plans WHERE id=?').get(planId) as { status: string } | undefined
  const out = new Map<string, InnerOutcome>()
  if (!plan) return out
  const purged = opts.purged ?? purgedSeqs(db)
  const stored = opts.stored === false ? new Map<string, string>() : storedWhys(db, planId)
  const lastQ = new Map<string, { seq: number; status: string; error: string | null }>()
  const lastR = new Map<string, { status: string; error: string | null; to_path: string | null }>()
  for (const j of db.prepare(
    `SELECT seq, item_id, op, status, error, to_path FROM cleanup_journal WHERE plan_id=? ORDER BY seq`
  ).all(planId) as { seq: number; item_id: string; op: string; status: string; error: string | null; to_path: string | null }[]) {
    if (j.op === 'quarantine') lastQ.set(j.item_id, j)
    if (j.op === 'restore') lastR.set(j.item_id, j)
  }
  const ran = plan.status !== 'proposed' && plan.status !== 'dismissed'
  const items = db.prepare(
    `SELECT c.item_id, max(p.skipped) skipped, f.error, f.name, f.status
       FROM cleanup_plan_items p
       JOIN cleanup_candidates c ON c.id = p.candidate_id
       LEFT JOIN file_items f ON f.id = c.item_id
      WHERE p.plan_id = ? GROUP BY c.item_id`
  ).all(planId) as { item_id: string; skipped: number; error: string | null; name: string; status: string | null }[]
  for (const i of items) {
    const q = lastQ.get(i.item_id)
    const r = lastR.get(i.item_id)
    let outcome: ItemOutcome, why: string | null = null, raw: string | null = null, restoring = false
    if (i.skipped) outcome = 'skipped'
    else if (q?.status === 'done') {
      if (r?.status === 'done') outcome = 'restored'
      else if (purged.has(q.seq)) outcome = 'purged'
      else if (r?.status === 'started') { outcome = 'unknown'; why = RESTORE_INTERRUPTED; restoring = true }
      else {
        outcome = 'moved'
        // 還在隔離區。復原失敗過的話要講得出為什麼沒放回來（UI 的「沒放回」要用）。
        // 搬進隔離區成功時 markMoved 會清掉 file_items.error，所以隔離中的檔身上有 error，
        // 就是之後的復原失敗寫的（驗證沒過的那種不會寫 journal）。
        why = (r?.status === 'failed' ? safeWhy(r.error) : null)
          ?? (i.status === 'quarantined' ? safeWhy(i.error) : null)
      }
    }
    else if (q?.status === 'started') { outcome = 'unknown'; why = MOVE_INTERRUPTED }
    else if (!ran && !q) outcome = plan.status === 'dismissed' ? 'cancelled' : 'pending'
    else {
      outcome = 'failed'
      // 失敗原因有兩個地方：搬移失敗寫在 journal；**檢查沒過（例如 TOO_FRESH）
      // 根本不會寫 journal**，只寫 file_items.error —— 而那一欄下一次掃描就被改寫。
      // 所以先讀套用當下存起來的（cleanup_item_errors），再看 journal，最後才是 file_items。
      raw = safeWhy(q?.error) ?? safeWhy(i.error)
      why = stored.get(i.item_id) ?? raw ?? '沒有搬動，原因不明'
    }
    const o: InnerOutcome = { outcome, why, raw, restoring }
    // **原位置被佔的時候，放回來的那份會改名**（B 的 restoreTarget：X.zip.restored）。
    // 不講的話使用者會以為「放回原位」—— 其實原位是後來那個檔。只給檔名，不給路徑。
    if (outcome === 'restored' && r?.to_path) {
      const as = basename(r.to_path)
      if (as !== i.name) o.restoredAs = as
    }
    out.set(i.item_id, o)
  }
  return out
}

/**
 * 計畫裡每個檔現在的下場。**這是唯一一份算法**，route 與 CLI 共用。
 *
 * CLI 那邊踩過一次：一律印 ✔，全失敗時畫面上是一排 ✔ 後面接「搬進隔離區 0 個」。
 * 前端自己用「勾了幾個」去推算，會踩同一個坑。
 *
 * outcome 的全部種類：pending（還沒做）、moved（在隔離區）、skipped（你略過了）、
 * failed（沒搬成，why 講原因）、restored（放回去了）、purged（已清空）、
 * unknown（搬到一半中斷）、cancelled（計畫放棄了）。
 * moved 的 why 通常是 null；復原失敗過的話是沒放回來的原因。
 */
export function planOutcomes(db: DatabaseSync, planId: string, opts: { purged?: Set<number> } = {}): Map<string, Outcome> {
  const out = new Map<string, Outcome>()
  for (const [k, { raw: _raw, restoring: _restoring, ...o }] of outcomesOf(db, planId, opts)) out.set(k, o)
  return out
}

/**
 * 從 journal／file_items 補記失敗原因（RC11）。回存了幾筆。
 *
 * **平常不需要呼叫**：applyPlan 失敗的當下就會寫 cleanup_item_errors（cleanup-exec.ts 的
 * markFailure），route 與 CLI 都不必再補。這一支留著給修補舊資料、或想重新對一次帳的人。
 *
 * - 失敗、而且這次讀得到原因 → 寫入（蓋掉舊的）
 * - 失敗、但這次讀不到原因（file_items 已經被重掃改寫）→ 保留舊的，不要蓋成「原因不明」
 * - 不是失敗（重試成功了）→ 刪掉，不然它會掛在一個已經搬走的檔上
 */
export function recordItemErrors(db: DatabaseSync, planId: string): number {
  const o = outcomesOf(db, planId, { stored: false })
  if (!o.size) return 0
  const at = new Date().toISOString()
  let n = 0
  transaction(db, () => {
    for (const [itemId, x] of o) {
      if (x.outcome === 'failed') {
        if (!x.raw) continue
        db.prepare(`INSERT INTO cleanup_item_errors (plan_id,item_id,why,at) VALUES (?,?,?,?)
                    ON CONFLICT(plan_id,item_id) DO UPDATE SET why=excluded.why, at=excluded.at`)
          .run(planId, itemId, x.raw, at)
        n++
      } else {
        db.prepare('DELETE FROM cleanup_item_errors WHERE plan_id=? AND item_id=?').run(planId, itemId)
      }
    }
  })
  return n
}

/** 把逐項結果掛到 B 的計畫 DTO 上。 */
export function withOutcomes<T extends { id: string; items: { itemId: string }[] }>(db: DatabaseSync, dto: T): T {
  const o = planOutcomes(db, dto.id)
  return { ...dto, items: dto.items.map(i => ({ ...i, ...(o.get(i.itemId) ?? { outcome: 'pending', why: null }) })) }
}

/**
 * **現在還可以復原**的計畫 id。一次查詢算完（RC19）。
 *
 * 條件要跟 outcomesOf 的 moved ＋ restoring 一模一樣：搬進去了（done）、沒放回來
 * （restore 不是 done）、沒被清空。**復原到一半中斷（restore 停在 started）也算** ——
 * 畫面說「再按一次復原會把它接完」，歷史面板只拿 ?undoable=1，把它排除的話使用者
 * 找不到那顆按鈕，而檔案還在隔離區（第一波引進的退步）。
 * test/audit-0919-routes.test.mjs 有一條拿慢的參考算法對照。
 */
function undoablePlanIds(db: DatabaseSync): Set<string> {
  const purgeClause = tableExists(db, 'cleanup_purges')
    ? `AND NOT EXISTS (SELECT 1 FROM cleanup_purges p WHERE p.seq = q.seq AND p.status = 'done')`
    : ''
  return new Set((db.prepare(
    `SELECT DISTINCT q.plan_id FROM cleanup_journal q
      WHERE q.op = 'quarantine' AND q.status = 'done'
        AND NOT EXISTS (SELECT 1 FROM cleanup_journal r
                         WHERE r.plan_id = q.plan_id AND r.item_id = q.item_id
                           AND r.op = 'restore' AND r.status = 'done')
        ${purgeClause}`
  ).all() as { plan_id: string }[]).map(r => r.plan_id))
}

/**
 * 計畫列表。形狀刻意跟 C 的 `/demo/cleanup/history` 一樣
 * （`{ total, offset, limit, operations }`），讓歷史面板兩個模式共用同一段渲染。
 *
 * `filter`：
 * - `undoable`：**現在還可以復原**的。已復原、已被清空的都不算 ——
 *   說能復原但其實檔案已經永久刪除，是在騙人。`items` 只列還能放回去的那些
 *   （moved，以及復原到一半中斷、再按一次復原會接完的 unknown）。
 * - `pending`：**還沒套用的（proposed）**計畫裡有 pending、failed、unknown 的項目。
 *   給「接續上次那份」用。計畫是一次性的：套用過的 partial／error 不佔住檔案、
 *   也不算「上次那份」—— 失敗的檔要重試就建新計畫（跟 createPlan、blockingPlanFor 一致）。
 *
 * **先篩、先分頁，只對這一頁算細節**（RC19）。上一版每一份都算完整逐項結果再篩，
 * 3000 份計畫要 4.9 秒，而 server 是單執行緒 —— 那段時間整台 server 停住。
 *
 * **不上鎖**，純讀。
 */
export function listPlans(db: DatabaseSync, opts: { filter?: 'undoable' | 'pending'; offset?: number; limit?: number }) {
  const limit = opts.limit ?? 20
  let offset = opts.offset ?? 0
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
    throw new CleanupError('BAD_BODY', '分頁參數不正確：limit 要是 1 到 100，offset 不可以是負的。')
  }
  if (!tableExists(db, 'cleanup_snapshots')) return { total: 0, offset: 0, limit, operations: [] }

  const plans = db.prepare(
    `SELECT id, status, created_at, applied_at FROM cleanup_plans ORDER BY created_at DESC, rowid DESC`
  ).all() as { id: string; status: string; created_at: string; applied_at: string | null }[]
  const purged = purgedSeqs(db)
  const want = opts.filter === 'pending' ? ['pending', 'failed', 'unknown'] : null

  const cache = new Map<string, ReturnType<typeof detail>>()
  // 還可以復原：還在隔離區（moved），或復原到一半中斷（再按一次復原會接完）
  const undoable = (x: InnerOutcome | undefined) => x?.outcome === 'moved' || x?.restoring === true
  function detail(p: (typeof plans)[number]) {
    const o = outcomesOf(db, p.id, { purged })
    const snaps = (db.prepare('SELECT snapshot FROM cleanup_snapshots WHERE plan_id=? ORDER BY rowid')
      .all(p.id) as { snapshot: string }[]).map(r => JSON.parse(r.snapshot) as { id: string; name: string; bytes: number })
    const items = snaps.filter(i => opts.filter === 'undoable' ? undoable(o.get(i.id))
      : !want || want.includes(o.get(i.id)?.outcome ?? ''))
      .map(i => ({ itemId: i.id, name: i.name, bytes: i.bytes }))
    const canUndo = snaps.some(i => undoable(o.get(i.id)))
    const restored = db.prepare(
      `SELECT max(ts) ts FROM cleanup_journal WHERE plan_id=? AND op='restore' AND status='done'`
    ).get(p.id) as { ts: string | null }
    return {
      id: p.id, status: p.status, createdAt: p.created_at, appliedAt: p.applied_at,
      restoredAt: restored.ts, canUndo,
      itemCount: items.length, bytes: items.reduce((n, i) => n + i.bytes, 0), items,
    }
  }
  const detailOf = (p: (typeof plans)[number]) => {
    let d = cache.get(p.id)
    if (!d) { d = detail(p); cache.set(p.id, d) }
    return d
  }

  let chosen = plans
  if (opts.filter === 'undoable') {
    const active = undoablePlanIds(db)
    chosen = plans.filter(p => active.has(p.id))
  } else if (opts.filter === 'pending') {
    // 只有 proposed 還佔著檔案、還算「上次那份」。這種通常只有幾份，逐份算沒關係。
    chosen = plans.filter(p => p.status === 'proposed').filter(p => detailOf(p).items.length > 0)
  }
  const total = chosen.length
  // 跟 C 的 demo 歷史一樣：offset 超過最後一頁就夾回最後一頁，不回空白頁
  offset = Math.min(offset, Math.max(0, Math.ceil(total / limit) - 1) * limit)
  return { total, offset, limit, operations: chosen.slice(offset, offset + limit).map(detailOf) }
}

/**
 * 隔離區清單，**不上鎖**（RC5）。
 *
 * B 的 listQuarantine() 會拿清理鎖，所以 CLI 正在套用的時候，面板打開隔離區清單
 * 會收到 BUSY —— 一個純讀的畫面不該跟真正的動作搶鎖。這裡自己下唯讀查詢，
 * 回的形狀跟 listQuarantine 一樣。B 的表是懶建的，還沒建過就是空的。
 */
export function quarantineItems(db: DatabaseSync) {
  if (!['cleanup_snapshots', 'cleanup_move_details', 'cleanup_purges'].every(t => tableExists(db, t))) return []
  const rows = db.prepare(
    `SELECT q.seq, q.plan_id, q.item_id, s.snapshot, d.completed_at,
            EXISTS (SELECT 1 FROM cleanup_journal r WHERE r.plan_id=q.plan_id AND r.item_id=q.item_id
                      AND r.op='restore' AND r.status='started') AS restoring
       FROM cleanup_journal q
       JOIN cleanup_snapshots s ON s.plan_id = q.plan_id AND s.item_id = q.item_id
       LEFT JOIN cleanup_move_details d ON d.seq = q.seq
      WHERE q.op='quarantine' AND q.status='done'
        AND NOT EXISTS (SELECT 1 FROM cleanup_journal r WHERE r.plan_id=q.plan_id AND r.item_id=q.item_id
                          AND r.op='restore' AND r.status='done')
        AND NOT EXISTS (SELECT 1 FROM cleanup_purges p WHERE p.seq=q.seq AND p.status='done')
      ORDER BY q.seq`
  ).all() as { seq: number; plan_id: string; item_id: string; snapshot: string; completed_at: string | null; restoring: number }[]
  const now = Date.now()
  return rows.map(r => {
    const snap = JSON.parse(r.snapshot) as { name: string; bytes: number }
    const done = r.completed_at ? Date.parse(r.completed_at) : NaN
    // 跟 B 的 quarantineCompletedAt 一樣：算不出七天就不猜
    if (!Number.isFinite(done)) throw new CleanupError('UNSAFE_JOURNAL', '缺少隔離完成時間，無法清空。')
    return {
      seq: r.seq, planId: r.plan_id, itemId: r.item_id, name: snap.name, bytes: snap.bytes,
      quarantinedAt: r.completed_at!, canEmptyAt: new Date(done + RETENTION_MS).toISOString(),
      // 復原到一半中斷的，清空不會刪（留給「再按一次復原」）
      canEmptyNow: !r.restoring && now >= done + RETENTION_MS,
    }
  })
}

/** 清空預覽留下的列，過期超過一天的順便刪掉（RC28）。不然每按一次預覽就多一列，永遠不會少。 */
function pruneEmptyRequests(db: DatabaseSync) {
  try {
    db.prepare('DELETE FROM cleanup_empty_requests WHERE expires_at < ?')
      .run(new Date(Date.now() - 24 * 60 * 60_000).toISOString())
  } catch (e: any) {
    // 清不掉只是表多幾列，不可以讓預覽本身失敗
    console.error('[contextbox] 清空預覽的舊紀錄清不掉：', e?.message ?? e)
  }
}

// ── HTTP ─────────────────────────────────────────────────────

export type RouteCtx = {
  db: DatabaseSync
  roots: string[] | (() => string[])
  quarantine: string
  /** 這兩個只有會動檔案的 route 才需要。跟 roots 一樣可以是 thunk（延後讀設定）。 */
  maxBytes?: number | (() => number)
  readonly?: boolean | (() => boolean)
  url: URL
  method: string
  body: any
  /** 第三個參數是額外的 response header（例如 BUSY 的 Retry-After、405 的 Allow）。 */
  send: (code: number, payload: unknown, headers?: Record<string, string>) => void
  /**
   * 手動掃一次。由呼叫端注入，這一支不直接相依 scanner。
   * `onProblem` 要傳給 scanDownloads：保險絲、讀不到的檔、打不開的資料夾都從這裡報，
   * 回應的 `problems` 就是收到的這些（不傳的話那些話走 HTTP 永遠看不到）。
   */
  scan: (onProblem: (msg: string) => void) => { scanned: number; candidates: number; skipped: number; errors: number; truncated: boolean }
}

/** POST /cleanup/scan 回應裡 problems 最多幾條。 */
const MAX_SCAN_PROBLEMS = 50

/**
 * 掃描回報的問題，整理成要回給 UI 的樣子：**人話、不帶完整路徑**。
 *
 * scanner 寫的訊息本來就只帶資料夾名稱與檔名；這裡再保險一次 —— 清理根目錄（原樣與
 * realpath）與家目錄的完整寫法換成資料夾名稱（家目錄換成 ~），長的先換。
 * 重複的只留一條；太多條（一個壞掉的資料夾可能讓上千個檔各報一次）收成一句「還有 N 條」。
 */
export function scanProblems(raw: string[], roots: string[]): string[] {
  const forms: [string, string][] = []
  for (const r of roots) {
    if (!r) continue
    const all = [resolve(r)]
    try { all.push(realpathSync(r)) } catch { /* 不存在就只用原樣 */ }
    for (const f of all) forms.push([f, basename(f) || f])
  }
  forms.push([resolve(homedir()), '~'])
  forms.sort((a, b) => b[0].length - a[0].length)
  const clean = [...new Set(raw.map(m => {
    let out = String(m)
    for (const [full, name] of forms) if (full && full !== sep) out = out.split(full).join(name)
    return out.slice(0, 300)
  }))]
  if (clean.length <= MAX_SCAN_PROBLEMS) return clean
  const shown = clean.slice(0, MAX_SCAN_PROBLEMS - 1)
  return [...shown, `還有 ${clean.length - shown.length} 條沒有列出來。`]
}

/** 錯誤沿用既有 server 的 { error: 字串 }，多一個 code 給程式分支。 */
const fail = (send: RouteCtx['send'], code: number, error: string, tag: string, headers?: Record<string, string>) =>
  send(code, { error, code: tag }, headers)

/**
 * B 的 CleanupError code → HTTP 狀態碼。
 *
 * **這張表一定要跟 B 的原始碼對得上。** 手寫清單會腐爛 ——
 * 上一輪 `KIND_CONFIDENCE` 就是這樣：新增一條規則、表沒更新，
 * 它靜靜變成預設值，沒有任何測試會紅。
 * 所以 `test/cleanup-wire.test.mjs` 會從 `core/cleanup-*.ts` 把 code 抓出來比對，
 * B 新增一個沒對應的 code 就紅。
 *
 * 分三類：**使用者送錯**（4xx 該改請求）、**狀態衝突**（4xx 該改做法）、
 * **這台機器的問題**（5xx 不是呼叫端的錯）。
 */
export const HTTP_FOR_CODE: Record<string, number> = {
  // ── 請求本身有問題
  BAD_BODY: 400,
  NOT_FOUND: 404,

  // ── 請求合法，但現在的狀態不允許
  CONFLICT: 409,
  // 候選變了是狀態衝突，不是格式錯 —— C 該重新掃描，不是改參數
  STALE_CANDIDATE: 409,
  // 「沒東西可清」對 HTTP 是狀態；對 CLI 是**成功**（見 cli.mjs 的離開碼）
  EMPTY_PLAN: 409,
  TOO_RECENT: 409,
  // 檔案十分鐘內還在變動。等一下重試就會成功，所以是狀態不是錯誤。
  TOO_FRESH: 409,
  // 唯讀模式是權限拒絕，不是格式錯
  READ_ONLY: 403,
  // 語意就是為「你少做了前一步」設計的
  CONFIRMATION_REQUIRED: 428,
  // 曾經有效、現在永久消失 —— 重試同一個 token 沒有意義
  CONFIRMATION_EXPIRED: 410,
  // 請求完全合法，只是現在忙。409 會讓 C 以為要改請求
  BUSY: 503,

  // ── 這台機器的問題，呼叫端改什麼都沒用
  BAD_CONFIG: 500,
  UNSAFE_PATH: 500,
  UNSAFE_JOURNAL: 500,
  UNSAFE_FILE: 500,
  // 底下這些多半只出現在**逐項結果**裡（applyPlan／emptyQuarantine 的
  // 逐檔 try/catch），整個請求仍然 200 —— 一個檔失敗不該讓另外九個檔的成功消失。
  // 列在這裡是為了萬一它們真的穿到路由層時不會掉進未知分支。
  CHANGED: 500,
  MISSING: 500,
  PURGED: 500,
  PROTECTED: 500,
  OUTSIDE_ROOT: 500,
  NO_DUPLICATE: 500,
  VERIFY_FAILED: 500,
}

/**
 * 認不得的 code 走 **500**。
 *
 * 400 等於告訴 C「你打錯了」，它會改 body 重試，永遠修不好 ——
 * 第二輪才修過一模一樣的 bug（後端故障回 400 + SQLite 原文）。
 * 不知道是誰的錯的時候，說「不是你的錯」比較安全。
 */
export function statusFor(code: string | undefined): number {
  if (code && Object.prototype.hasOwnProperty.call(HTTP_FOR_CODE, code)) return HTTP_FOR_CODE[code]
  return 500
}

/** 組出 B 要的 ExecOptions。thunk 在這裡才求值 —— 唯讀的 route 不該去碰設定檔。 */
function execOptions(ctx: RouteCtx): ExecOptions {
  return {
    roots: typeof ctx.roots === 'function' ? ctx.roots() : ctx.roots,
    quarantine: ctx.quarantine,
    maxBytes: typeof ctx.maxBytes === 'function' ? ctx.maxBytes() : (ctx.maxBytes ?? 0),
    readonly: typeof ctx.readonly === 'function' ? ctx.readonly() : ctx.readonly,
  }
}

/**
 * 清理相關的 route。**認得就處理並回 true，不認得回 false** 讓下一個接手。
 * 真的動檔案的部分（apply／undo／empty）交給 B 的執行層，這裡只負責接線與翻譯錯誤。
 */
export function cleanupRoutes(ctx: RouteCtx): boolean {
  // **整支包起來。** 不包的話例外會穿到 server.ts 的 catch，那裡回的是
  // 400 + SQLite 原文 —— 伺服器故障卻告訴 C「你打錯了」，而且原文可能帶路徑。
  try { return route(ctx) }
  catch (e: any) {
    // 只記真的意外（非 CleanupError、或 5xx 而且不是 BUSY），見 isSurprise。
    // 錯誤吞掉的話 /health 的 lastError 永遠是 null；什麼都記的話寵物永遠在擔心。
    recordCleanupError(ctx.db, e)
    // B 的 CleanupError 訊息都是寫好的人話而且不含路徑（cleanupProblem 負責），
    // 所以可以直接送出去。其他例外一律換成罐頭訊息。
    if (e instanceof CleanupError) {
      // BUSY 是「等一下就好」：告訴呼叫端多久之後再試（RC5）
      fail(ctx.send, statusFor(e.code), e.message, e.code, e.code === 'BUSY' ? { 'retry-after': '2' } : undefined)
      return true
    }
    fail(ctx.send, 500, INTERNAL_MESSAGE, 'INTERNAL')
    return true
  }
}

/**
 * 認得的路徑與它們收的方法。**已知的路徑用錯方法回 405，不是 501**（RC24）——
 * 501 是「這個功能還沒做」，會讓呼叫端以為要等新版。
 */
const KNOWN: [RegExp, string[]][] = [
  [/^\/cleanup\/candidates$/, ['GET']],
  [/^\/cleanup\/scan$/, ['POST']],
  [/^\/cleanup\/plans$/, ['GET', 'POST']],
  [/^\/cleanup\/plans\/[^/]+$/, ['GET']],
  [/^\/cleanup\/plans\/[^/]+\/(?:apply|undo|dismiss|release)$/, ['POST']],
  [/^\/cleanup\/quarantine$/, ['GET']],
  [/^\/cleanup\/quarantine\/empty$/, ['POST']],
  [/^\/pet\/state$/, ['GET']],
]

/**
 * body 一定要是物件。**看不懂的 body 不可以被當成「什麼都沒帶」**（RC6）——
 * 「什麼都沒帶」在建計畫那條的意思是「清單上打 ✔ 的全部」。
 * undefined（呼叫端根本沒給）才算沒帶。
 */
function bodyOf(ctx: RouteCtx): Record<string, any> {
  const b = ctx.body
  if (b === undefined) return {}
  if (b === null || typeof b !== 'object' || Array.isArray(b)) throw new CleanupError('BAD_BODY', '看不懂送來的資料。')
  return b
}

const rootsOf = (ctx: RouteCtx) => typeof ctx.roots === 'function' ? ctx.roots() : ctx.roots

function route(ctx: RouteCtx): boolean {
  const { url, method, send } = ctx
  const p = url.pathname

  const known = KNOWN.find(([re]) => re.test(p))
  if (known && !known[1].includes(method)) {
    fail(send, 405, `這個路徑只收 ${known[1].join('、')}。`, 'BAD_METHOD', { allow: known[1].join(', ') })
    return true
  }

  if (p === '/cleanup/candidates' && method === 'GET') {
    const raw = url.searchParams.get('limit')
    const limit = raw === null ? undefined : Number(raw)
    if (raw !== null && (!Number.isInteger(limit) || limit! < 1 || limit! > 1000)) {
      fail(send, 400, 'limit 要是 1 到 1000 之間的整數。', 'BAD_BODY')
      return true
    }
    send(200, listCandidates(ctx.db, { roots: rootsOf(ctx), limit }))
    return true
  }

  if (p === '/cleanup/scan' && method === 'POST') {
    // 註：這裡曾經有一個 module 層的 `scanning` 旗標想擋併發掃描。
    // 那是死碼 —— scanDownloads 是同步的，中間沒有任何 await，
    // 同一個行程裡第二個請求根本沒機會在旗標為 true 時被處理（實測 4 個併發全部 200）。
    // 而真正的風險是**多個行程**（右鍵一次選 20 個檔 = 20 個行程），
    // module 層變數對那個一點用都沒有。要做就得用 meta 表的租約鎖。
    const problems: string[] = []
    let r
    try {
      r = ctx.scan(msg => { problems.push(msg) })
    } catch (e: any) {
      // 掃描壞掉不可以把路徑吐給 UI，但**錯誤本身不可以消失** ——
      // 吞掉的話連續失敗十次，doctor 與 /health 都會說一切正常。
      // scanner 逐檔寫入沒有交易，掃到一半炸掉時資料庫已經改了一半，
      // 所以只說「可能沒有完成」；掃描本身從來不搬也不刪，那一句是真的。
      recordCleanupError(ctx.db, e)
      fail(send, 500, '掃描的時候出錯了，這次掃描可能沒有完成。掃描不會搬動或刪除任何檔案。', 'INTERNAL')
      return true
    }
    recordOk(ctx.db)
    // problems：保險絲、讀不到的檔、打不開的資料夾（RC1）。人話、不帶完整路徑，沒事是空陣列。
    send(200, { ...r, problems: scanProblems(problems, rootsOf(ctx)) })
    return true
  }

  // ── B 的執行層 ────────────────────────────────────────────

  if (p === '/cleanup/plans' && method === 'GET') {
    const q = url.searchParams
    const num = (k: string) => q.get(k) === null ? undefined : Number(q.get(k))
    send(200, listPlans(ctx.db, {
      filter: q.get('undoable') === '1' ? 'undoable' : q.get('pending') === '1' ? 'pending' : undefined,
      offset: num('offset'), limit: num('limit'),
    }))
    return true
  }

  if (p === '/cleanup/plans' && method === 'POST') {
    const body = bodyOf(ctx)
    // **唯讀模式一份都不可以建。** createPlan 不看 readonly（只有 applyPlan 看），
    // 建了再被 apply 擋下的話，那份計畫卡在 proposed、永遠佔住那些檔，
    // 之後任何人建計畫都撞 CONFLICT。CLI 那輪修過一模一樣的 bug。
    const ro = typeof ctx.readonly === 'function' ? ctx.readonly() : ctx.readonly
    if (ro) throw new CleanupError('READ_ONLY', '目前是唯讀模式，不會建立清理計畫，也不會搬動任何檔案。')
    const roots = rootsOf(ctx)
    // **只有完全沒帶 candidateIds 才是預設**（清單上打 ✔ 的，一次最多 1000 個檔）。
    // `null` 是看不懂，不是沒帶 —— 上一版用 `??`，null 就變成「全部打 ✔ 的」（RC6）。
    let candidateIds: unknown = body.candidateIds
    let remaining = 0
    if (candidateIds === undefined) {
      const sel = defaultSelection(ctx.db, roots)
      candidateIds = sel.candidateIds
      remaining = sel.remaining
    }
    let plan
    try {
      plan = createPlanForRoots(ctx.db, roots, { candidateIds, requestId: body.requestId })
    } catch (e: any) {
      // 撞到別的計畫：**回擋住這次勾選的那一份**，UI 用它，不要自己猜（RC7）
      if (e instanceof CleanupError && e.code === 'CONFLICT') {
        send(409, { error: e.message, code: e.code,
          blockingPlan: blockingPlanFor(ctx.db, Array.isArray(candidateIds) ? candidateIds as string[] : []) })
        return true
      }
      throw e
    }
    // remaining：預設清理這次沒收進去、下次再清的檔數。指定 id 的時候永遠是 0。
    send(200, { ...withOutcomes(ctx.db, plan), remaining })
    return true
  }

  const plan = /^\/cleanup\/plans\/([^/]+)(?:\/(apply|undo|dismiss|release))?$/.exec(p)
  if (plan) {
    let id: string
    // 壞掉的 %xx 是呼叫端送錯，不是後端故障（RC5）—— 上一版丟 URIError，變成 500 + lastError
    try { id = decodeURIComponent(plan[1]) }
    catch { throw new CleanupError('BAD_BODY', '計畫 id 的格式不正確。') }
    const action = plan[2]
    // 每個回應都帶逐項結果（outcome／why）。UI 不可以自己用「勾了幾個」推算。
    if (!action) { send(200, withOutcomes(ctx.db, getPlan(ctx.db, id))); return true }
    const body = bodyOf(ctx)
    if (action === 'dismiss') { send(200, withOutcomes(ctx.db, dismissPlan(ctx.db, id))); return true }
    // 放棄還沒開始的那份：計畫作廢、候選不動（RC4／RC8 的「放棄上次那份」）
    if (action === 'release') { send(200, withOutcomes(ctx.db, releasePlan(ctx.db, id))); return true }
    const opts = execOptions(ctx)
    const r = action === 'apply'
      ? applyPlan(ctx.db, id, { ...opts, skippedIds: body.skippedIds })
      : undoPlan(ctx.db, id, opts)
    invalidateQuarantineCache()   // 隔離區剛變了，孤兒對帳的快取不可以再用
    // 失敗原因 applyPlan 自己會存（cleanup_item_errors），這裡不必再補（RC11）
    recordOk(ctx.db)
    send(200, withOutcomes(ctx.db, r))
    return true
  }

  if (p === '/cleanup/quarantine' && method === 'GET') {
    // 純讀，不上鎖（RC5）—— CLI 正在套用的時候打開隔離區清單不該收到 BUSY
    const items = quarantineItems(ctx.db)
    send(200, {
      items,
      total: items.length,
      bytes: items.reduce((n, i) => n + i.bytes, 0),
    })
    return true
  }

  if (p === '/cleanup/quarantine/empty' && method === 'POST') {
    const body = bodyOf(ctx)
    // **一個路由兩個階段。** 不帶 token = 預覽；帶 token + confirmed = 真的刪。
    // `phase` 一定要回，不然 C 分不出自己拿到的是預覽還是結果。
    const token = body.token
    if (!token) {
      // 預覽是唯讀動作。現在沒有滿七天的檔就回 itemCount 0，
      // 不要丟錯 —— 對一個唯讀動作丟錯很沒道理。
      const preview = prepareEmptyQuarantine(ctx.db, execOptions(ctx))
      pruneEmptyRequests(ctx.db)
      send(200, { phase: 'preview', ...preview })
      return true
    }
    // **`confirmed` 原封不動傳給 B。** 不可以 Boolean() ——
    // body 是 `{"confirmed":"false"}` 的話，字串 "false" 在 JS 是 truthy，
    // 而這是整個專案唯一會真的刪檔的路徑。
    // 帶了但不是布林是**送錯**（400），跟「還沒確認」（沒帶或 false，428）分開（RC23）。
    if (body.confirmed !== undefined && typeof body.confirmed !== 'boolean') {
      throw new CleanupError('BAD_BODY', 'confirmed 要是 true 或 false。')
    }
    const result = emptyQuarantine(ctx.db, { ...execOptions(ctx), token, confirmed: body.confirmed })
    recordOk(ctx.db)
    send(200, { phase: 'done', ...result })
    return true
  }

  if (p === '/pet/state' && method === 'GET') {
    // 這條要 token，所以拿完整版 —— 寵物要比 lastErrorAt 與 lastOkAt，瘦身版兩個都是 null
    const h = healthSnapshot(ctx.db, { roots: rootsOf(ctx), quarantine: ctx.quarantine, full: true })
    send(200, petState(h, {
      proposedPlans: safe(() => (ctx.db.prepare(
        `SELECT count(*) n FROM cleanup_plans WHERE status='proposed'`).get() as { n: number }).n, 0),
      activeQuarantine: h.quarantine.items,
    }))
    return true
  }

  // 還沒實作的（B 的範圍）要回一句人話，不是 404 —— 404 會讓 C 以為自己打錯網址。
  // **反過來列白名單。** 逐條列黑名單一定會漏（第一版漏了 apply／undo／
  // dismiss／reveal／quarantine/empty，第二版還漏 restore／empty），
  // 而漏掉的後果就是這段註解要避免的那件事。
  // 認得的路徑用錯方法在最上面就回 405 了，走到這裡的是真的不認得的路徑。
  if (p.startsWith('/cleanup/') || p.startsWith('/pet/')) {
    fail(send, 501, '這個功能還沒做好。', 'NOT_IMPLEMENTED')
    return true
  }

  return false
}
