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
import {
  closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync,
  realpathSync,
} from 'node:fs'
import { join } from 'node:path'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import {
  KIND_CONFIDENCE, CLEANUP_KINDS, CURRENT_RULE_VERSIONS, PARTIAL_EXT,
} from './cleanup-rules.ts'
import {
  RETENTION_MS, applyPlan, undoPlan, checkedPath, type ExecOptions,
} from './cleanup-exec.ts'
import { createPlan, getPlan, dismissPlan, releasePlan, validateIds } from './cleanup-plans.ts'
import { prepareEmptyQuarantine, emptyQuarantine } from './cleanup-quarantine.ts'
import { CleanupError, execRefusesName, transaction } from './cleanup-journal.ts'
import { keepersFirst } from './cleanup-scanner.ts'
import { decodePngGray } from './png.ts'
import { resizeGray } from './imagehash.ts'
import { encodeGrayPng } from './png-write.ts'
import { opinionsFor, type ModelOpinion } from './model-store.ts'
import { pendingCount } from './model-queue.ts'
import { fileTextOf } from './file-texts.ts'
// 預覽的可見範圍要跟面板一模一樣，所以這裡直接問那兩區的正本（P6 的 panelReason）。
// **不會成環**：rename.ts／filing.ts 都不 import 這一支。
import { renameSuggestions } from './rename.ts'
import { filingSuggestions } from './filing.ts'

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
  /**
   * lastError 是哪一種動作的錯（第二輪 R2-10）。值是「那次錯誤的 ISO 時間 空白 種類」——
   * **時間要跟 lastError 的時間一樣才算數**：舊版（或沒帶種類的呼叫）只寫 lastError，
   * 留下來的這一列時間對不上，那個錯就當成沒有種類。
   */
  lastErrorKind: 'cleanup_last_error_kind',
  /** 最近一次成功（任何一種，含沒帶種類的）。每一種動作另外有一列，見 lastOkKey。 */
  lastOk: 'cleanup_last_ok',
  /** pet 實際開在哪個 port（CONTEXTBOX_PORT=0 時是系統挑的）。`open` 靠它找 pet；pet 結束時清掉。 */
  petPort: 'pet_port',
  /** 最近一次完整掃描回報的問題（已經去掉路徑、換掉控制字元），JSON 字串陣列，最多 MAX_SCAN_PROBLEMS 條。 */
  scanProblems: 'cleanup_scan_problems',
  /**
   * 收尾試過、**收不動**的 journal 列（第三輪 R3-11）。JSON 物件：`{ "<seq>": "<那一刻的樣子>" }`。
   * 「樣子」是隔離區那份與原位那份的大小與 mtime —— 兩邊都沒變的話，再收一次的結果一定一樣，
   * 所以 needsSettling 直接跳過它，不去拿清理鎖、不重算 SHA-256。任何一邊變了（或它終於收掉了），
   * 這一列就不在裡面／對不上，下一個指令會照常再試一次。cli.mjs 的 needsSettling／settleCleanupState 在用。
   */
  stuckJournal: 'cleanup_stuck_journal',
  /**
   * 「現在正在讀檔案嗎」。值是那一輪開始的 ISO 時間；那一輪結束時這一列被刪掉。
   *
   * 為什麼要有：模型一個檔要十幾秒，幾百個檔就是好幾個小時。使用者在面板前面看到
   * 「Suggested names 0」，分不出是**還沒輪到**還是**它根本沒在動** —— 那是最讓人不信任的狀態。
   * 有這一列，/pet/state 就講得出「正在讀，還剩 N 個」，寵物也才有事情可以做
   * （thinking 這個狀態以前是死的，沒有任何地方會設它）。
   *
   * **當機之後會留一列假的**（pet 被 kill）。所以讀的那一端要看時間：超過 STALE_THINK_MS 就不算。
   */
  thinking: 'model_round_started',
} as const

/** 「正在讀」這件事最多信多久。pet 被砍掉的話那一列會留著，不看時間就會永遠顯示在讀。 */
export const STALE_THINK_MS = 15 * 60_000

/**
 * 會記成功與錯誤的動作種類（第二輪 R2-10）。**寵物只在「最新的錯誤之後，同一種動作成功過」時才不擔心** ——
 * 以前任何一次成功都算，pet 每 30 分鐘的背景重掃一成功，一直壞著的套用就被蓋掉了（稽核 C-e6）。
 *
 * `model` 是 P2 加的（看懂內容）：它不是一條 HTTP 路由，是背景佇列 —— 模型連續失敗三次時
 * 記一筆這一種的錯。分開一種的理由跟上面一樣：**模型叫不動不可以被一次成功的掃描蓋掉**，
 * 反過來模型好了也不該讓寵物不再擔心一個一直搬不動的清理。
 */
export const ACTION_KINDS = ['scan', 'apply', 'undo', 'empty', 'model'] as const
export type ActionKind = (typeof ACTION_KINDS)[number]
const isActionKind = (k: unknown): k is ActionKind => typeof k === 'string' && (ACTION_KINDS as readonly string[]).includes(k)
/** 每一種動作最近一次成功的 meta key：cleanup_last_ok_scan、cleanup_last_ok_apply… */
export const lastOkKey = (kind: ActionKind) => `cleanup_last_ok_${kind}`

/**
 * 後端意外（非 CleanupError）時給呼叫端的話。**要中性。**
 *
 * 上一版寫「這一步沒有搬動或刪除任何檔案」—— 但例外可能發生在檔案已經搬走、
 * 或已經刪掉之後（例如刪完檔、寫回結果時資料庫出錯）。稽查實測過：檔案已經永久刪了，
 * 訊息卻說沒有（C-C5）。我們不知道的時候，就說不知道。
 */
export const INTERNAL_MESSAGE = 'The backend hit an error, so this step may not have completed. Close the panel and open it again from the pet or `node cli.mjs open` to see where things stand.'

/** 太大、算不出指紋的檔：執行層一定拒收，所以不列成候選，改列在「需要你查看」。 */
export const TOO_LARGE_WHY = 'This file is too large for this tool to handle. Whether to keep it is your call.'

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
  /**
   * 模型對這個檔的看法（P2），沒問過是 null。
   *
   * **這是意見，不是事實**：面板要標明是模型說的、信心多少、證據是什麼，而且
   * **不可以**因為它說了就自動打勾或改名（預想的不變量 4）。`seeded` 是 demo 預先塞的示範答案。
   */
  model: ModelOpinion | null
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
  /**
   * **全部**（不受 50 個的上限影響）按原因分的數字，加起來等於 needsHumanTotal。
   * tooLarge ＝ why 是 TOO_LARGE_WHY 的；unreadable ＝ 其餘的（讀不到、搬不動）。
   * 自己數 needsHuman 陣列只數得到前 50 個（doctor 踩過，稽核第三波 C7）。
   */
  needsHumanCounts: { tooLarge: number; unreadable: number }
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
  const rawPath = resolve(path)

  const hit = roots
    .flatMap(root => {
      const rawRoot = resolve(root)
      const pairs: { root: string; rel: string; rootLen: number }[] = []

      // 原始路徑版本：
      // 支援尚未真的存在的 path，例如 displayPath 單元測試。
      pairs.push({
        root,
        rel: relative(rawRoot, rawPath),
        rootLen: rawRoot.length,
      })

      // realpath 版本：
      // scanner 存進 DB 的 path 可能是 /private/var/...，
      // 但設定 root 仍然是 /var/...。
      try {
        const realRoot = realpathSync(root)

        let normalizedPath: string
        try {
          normalizedPath = realpathSync(path)
        } catch {
          const rawRel = relative(rawRoot, rawPath)
          normalizedPath = resolve(realRoot, rawRel)
        }

        pairs.push({
          root,
          rel: relative(realRoot, normalizedPath),
          rootLen: realRoot.length,
        })
      } catch {
        // root 無法 realpath 時，仍可使用上面的 raw pair。
      }

      return pairs
    })
    .filter(h => {
      const outside =
        h.rel === '..' ||
        h.rel.startsWith('..' + sep)

      return Boolean(h.rel) &&
        !outside &&
        !/^[A-Za-z]:[\\/]/.test(h.rel)
    })
    .sort((a, b) => b.rootLen - a.rootLen)[0]

  // 不屬於任何 cleanup root：不提供位置資訊。
  if (!hit) return { folder: '', subdir: '' }

  const dir = dirname(hit.rel)
  let subdir = dir === '.' ? '' : dir

  // 最多暴露兩層相對子目錄。
  const segs = subdir.split(/[\\/]+/).filter(Boolean)
  if (segs.length > MAX_SUBDIR_SEGMENTS) {
    subdir = '…/' + segs.slice(-2).join('/')
  }

  const folder = basename(hit.root)

  // cleanup root 本身若是家目錄，不暴露使用者名稱。
  // 比整條路徑，不要比 basename —— /mnt/backup/alice 跟家目錄沒關係。
  return {
    folder: resolve(hit.root) === resolve(homedir()) ? '' : folder,
    subdir,
  }
}
/**
 * duplicate 的 evidence 要**指名留著的是哪一份**。
 *
 * A 產出的是「同一個 sha256 還有 N 份檔案存在」，數字對但使用者無法確認安全 ——
 * 他沒辦法知道「我還留著一份」。這裡把留下來的那個檔名補進去。
 * 保留者的挑法跟 scanner 的 addDuplicateCandidates 一樣：**只看清理根目錄底下的**，
 * 最早被看到的那份（同時間名字不像複本的優先，再比路徑 —— 同一支 keepersFirst）。
 * 不然會指名一份舊設定留下、執行層不承認的桌面檔。
 */
function enrichDuplicate(db: DatabaseSync, item: ItemRow, evidence: string, roots: string[], pre: string[]): string {
  const sha = item.sha256
  if (!sha) return evidence
  const keep = keepersFirst(db.prepare(
    `SELECT id, name, path, first_seen_at FROM file_items
     WHERE sha256=? AND status NOT IN ('quarantined','missing','error')
     ORDER BY first_seen_at, path`
  ).all(sha) as { id: string; name: string; path: string; first_seen_at: string }[]).find(r => underAny(r.path, pre))
  // **比 id 不比 name。** 比 name 的話，同名不同目錄
  //（`Downloads/report.pdf` 與 `Downloads/2026/09/report.pdf`，瀏覽器重下載很常見）
  // 會被當成同一個檔，「會留著」那句話整個消失 —— 而那句話正是使用者敢勾的理由。
  if (!keep || keep.id === item.id) return evidence
  const where = displayPath(keep.path, roots).subdir
  return `${evidence}; “${keep.name}” is the one being kept` + (where ? ` (in ${where})` : '')
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
    if (/\bmkdir\b/.test(s)) return 'no permission to create a folder'
    if (/\brename\b/.test(s)) return 'no permission to move this file'
    return 'no permission to read this file'
  }
  if (/ENOENT|no such file/i.test(s)) return 'this file is no longer there'
  if (/EISDIR/i.test(s)) return 'this is a folder, not a file'
  if (/EMFILE|ENFILE/i.test(s)) return 'too many files open at once; it will try again shortly'
  if (/EBUSY|EAGAIN/i.test(s)) return 'another program is using this file'
  // 寫入端的錯（第二輪 R2-11）。以前全部掉到最後那句「讀不到這個檔案」——
  // 隔離區所在的磁碟滿了，doctor 卻叫使用者去查 Downloads 的讀取權限。
  if (/\bENOSPC\b|no space left/i.test(s)) return 'the disk holding quarantine is full, with no room for this file'
  if (/\bEXDEV\b|cross-device/i.test(s)) return 'quarantine is on a different disk from this file, so it cannot be moved'
  if (/\bEROFS\b|read-only file system/i.test(s)) return 'this disk is read-only, so nothing can be written or moved'
  if (/\bELOOP\b|too many symbolic links/i.test(s)) return 'the symlinks in this path loop back on themselves, so it cannot be handled safely'
  if (/\bEIO\b|i\/o error/i.test(s)) return 'a disk read or write error, possibly hardware or a network drive'
  if (/too large|太大|超過.*上限/i.test(s)) return TOO_LARGE_WHY
  return 'cannot read this file'
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
  /** 截圖資料夾（config 的 cleanup.screenshotsDir）。這底下的檔只收截圖類的候選，見 SCREENSHOT_KINDS */
  screenshotsDir?: string | null
}

/**
 * 截圖類的規則（第二輪 R2-8）。**截圖資料夾底下的檔只收這幾種**，之後的連拍也放在這裡。
 *
 * cleanup.screenshots 開了，截圖資料夾就加進清理範圍 —— 而 macOS 的截圖資料夾**就是桌面**。
 * 以前那底下的檔套全部規則：桌面上 120 天前的客戶提案 zip（archive 65 分）預設打勾（稽核 C-e8，
 * 就是 RC15 那個 blocker 換了一個開關回來）。開關的意思是「清截圖」，不是「清桌面」。
 */
export const SCREENSHOT_KINDS: readonly string[] = ['screenshot-noise']
const isScreenshotKind = (k: string) => SCREENSHOT_KINDS.includes(k)

/**
 * 清理範圍：根目錄，加上「只清截圖」的那一個資料夾（沒開是 null）。
 * defaultSelection、defaultCandidateIds、createPlanForRoots 收這個，也收舊的根目錄陣列（等於沒有截圖資料夾）。
 */
export type CleanupScope = { roots: string[]; screenshotsDir?: string | null }
const scopeOf = (s: string[] | CleanupScope): CleanupScope => Array.isArray(s) ? { roots: s } : s

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

/** 清理範圍的比對器：pre 是根目錄的前綴；shotOnly(path) ＝ 這個檔只收截圖類的候選。 */
type Scope = { pre: string[]; shotOnly: (path: string) => boolean }

/**
 * 截圖資料夾底下的檔**只收截圖類**，但**最深的根目錄說了算**：使用者自己把「桌面/清理區」
 * 寫進 cleanup.roots 的話，那底下照一般規則 —— 它比截圖資料夾更深，是更明確的意思。
 * 截圖資料夾本身也寫在 cleanup.roots 裡的話，照樣只收截圖（兩者分不開，倒向範圍小）。
 */
function scopeMatcher(scope: CleanupScope): Scope {
  const pre = rootPrefixes(scope.roots)
  const shot = scope.screenshotsDir ? rootPrefixes([scope.screenshotsDir]) : []
  if (!shot.length) return { pre, shotOnly: () => false }
  const explicit = pre.filter(p => !shot.includes(p))
  return {
    pre,
    shotOnly: (path: string) => {
      const p = fold(path)
      const depth = Math.max(-1, ...shot.filter(x => p.startsWith(x)).map(x => x.length))
      return depth >= 0 && !explicit.some(x => x.length > depth && p.startsWith(x))
    },
  }
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
 *   4. **截圖資料夾底下只收截圖類**（第二輪 R2-8，見 SCREENSHOT_KINDS 與 scopeMatcher）
 */
function collect(db: DatabaseSync, scope: CleanupScope): Collected {
  const m = scopeMatcher(scope)
  const pre = m.pre
  const cands = db.prepare(
    `SELECT c.id, c.item_id, c.kind, c.confidence, c.reason, c.evidence,
            i.path, i.name, i.bytes, i.mtime, i.status, i.error, i.sha256, i.last_seen_at
     FROM cleanup_candidates c
     JOIN file_items i ON i.id = c.item_id
     -- rule_version 一定要過濾。scanner 只清當前版本的候選，舊版本的
     -- proposed 列會永久活著 —— 那代表**調降規則信心永遠不會生效**
     -- （max 取的是「這個檔歷史上拿過的最高分」），而且同一個 kind
     -- 會在 reasons 裡出現兩次、舊版的 id 也會被送去 apply。
     WHERE c.status='proposed' AND c.rule_version IN (${RULE_VERSIONS_SQL})
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
  ).all() as (CandRow & ItemRow)[]

  const byItem = new Map<string, Group>()
  // 每個檔判一次：out（範圍外、檔名就拒收）、shot（截圖資料夾底下，只收截圖類）、all
  const verdict = new Map<string, 'out' | 'shot' | 'all'>()
  for (const c of cands) {
    let v = verdict.get(c.item_id)
    if (!v) {
      // 執行層因為檔名本身就會拒收的（desktop.ini、*.url…）不列：升級前留下的這種候選，
      // 在下一次重掃把它改成 skipped 之前，列出來就是「勾得起、永遠搬不動」（RC4）
      v = !underAny(c.path, pre) || execRefusesName(c.name) ? 'out' : m.shotOnly(c.path) ? 'shot' : 'all'
      verdict.set(c.item_id, v)
    }
    // 截圖資料夾底下只收截圖類（R2-8）：其他理由不列、它的 id 也建不了計畫
    if (v === 'out' || (v === 'shot' && !isScreenshotKind(c.kind))) continue
    let g = byItem.get(c.item_id)
    if (!g) {
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
  // **沒讀過內容的大檔也是正常候選**（2026-09-21 使用者實機回報）。以前這裡把它們
  // 全部推去「需要你查看」，使用者想清也清不掉 —— 但規則早就判出來了（舊壓縮檔、
  // 舊安裝檔、.part⋯⋯），沒讀內容只影響重複偵測，不影響那些規則。
  // 身分確認由執行層用 dev／ino／大小／時間做（cleanup-exec.ts 的 fingerprint）。
  for (const g of byItem.values()) rows.push(g)
  needsHuman.push(...brokenForHuman(db, m))
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
function brokenForHuman(db: DatabaseSync, m: Scope): Collected['needsHuman'] {
  const broken = db.prepare(
    `SELECT i.id, i.path, i.name, i.bytes, i.mtime, i.status, i.error, i.sha256, i.last_seen_at,
            EXISTS (SELECT 1 FROM cleanup_candidates c WHERE c.item_id = i.id
                      AND c.status='proposed' AND c.rule_version IN (${RULE_VERSIONS_SQL})
                      AND c.kind IN (${SHOT_KINDS_SQL})) AS shot_kind
       FROM file_items i
      WHERE (i.status='error' OR i.error IS NOT NULL) AND i.status NOT IN ('quarantined','missing')
        AND (i.status IN ('error','candidate')
             OR EXISTS (SELECT 1 FROM cleanup_candidates c WHERE c.item_id = i.id
                          AND c.status='proposed' AND c.rule_version IN (${RULE_VERSIONS_SQL})))`
  ).all() as (ItemRow & { shot_kind: number })[]
  const out: Collected['needsHuman'] = []
  for (const { shot_kind, ...b } of broken) {
    if (!underAny(b.path, m.pre)) continue
    // 截圖資料夾底下只有截圖跟清理有關（R2-8）：桌面上讀不到的一般檔不是這個工具的事
    if (!shot_kind && m.shotOnly(b.path)) continue
    out.push({ item: b, why: needsHumanWhy(b) })
  }
  return out
}

/** SQL 裡還算數的規則版本。值是程式裡的常數（不是輸入），直接組字串沒有注入問題。 */
const RULE_VERSIONS_SQL = CURRENT_RULE_VERSIONS.map(v => `'${v.replace(/'/g, "''")}'`).join(',')

/** SQL 裡的截圖類清單。值是程式裡的常數（不是輸入），直接組字串沒有注入問題。 */
const SHOT_KINDS_SQL = SCREENSHOT_KINDS.map(k => `'${k.replace(/'/g, "''")}'`).join(',')

/**
 * 只要數字的版本（/health、/pet/state 的徽章）。**篩選條件跟 collect 一模一樣**，
 * 只是不把每一條候選的理由與證據都讀出來 —— /health 不需要 token，
 * 任何網頁都能用 <img> 連發，7000 個檔時完整版要 30 多 ms，這一版不到十分之一。
 * test/audit-0919-routes.test.mjs 有一條拿兩版對照。
 */
/**
 * 徽章與 doctor 要的數字。
 *
 * **回兩個數，不是一個**（2026-09-21）。保護副檔名清單拿掉之後，`pending` 從 393 變成 908
 *（1089 個檔裡的 83%）—— 那個數字技術上沒錯，但它不再是「我發現了幾件值得說的事」，
 * 而是「你的 Downloads 有多大」。而寵物與徽章只有這一個對外訊號，
 * 讓它變成雜訊等於把 README 那句 it only speaks up when it has something worth saying 作廢。
 *
 * 所以：`ready` ＝ 預設勾的（有把握的那些，實機 68 個）給徽章用；
 * `pending` ＝ 列得出來的全部（908）留著給清單與 doctor。**兩個都不藏。**
 */
function collectCounts(
  db: DatabaseSync, scope: CleanupScope,
): { pending: number; ready: number; needsHuman: number } {
  const m = scopeMatcher(scope)
  const listed = `c.item_id = i.id AND c.status='proposed'
                  AND c.rule_version IN (${RULE_VERSIONS_SQL})
                  AND trim(c.reason) <> '' AND trim(c.evidence) <> ''`
  const items = db.prepare(
    `SELECT i.id, i.path, i.name, i.bytes, i.sha256,
            EXISTS (SELECT 1 FROM cleanup_candidates c WHERE ${listed} AND c.kind IN (${SHOT_KINDS_SQL})) AS shot_kind,
            (SELECT max(c.confidence) FROM cleanup_candidates c WHERE ${listed}) AS top_conf
       FROM file_items i
      WHERE i.status IN (${PLANNABLE_STATUSES}) AND i.error IS NULL
        AND EXISTS (SELECT 1 FROM cleanup_candidates c WHERE ${listed})`
  ).all() as (ItemRow & { shot_kind: number; top_conf: number })[]
  let pending = 0
  let ready = 0
  for (const i of items) {
    if (!underAny(i.path, m.pre) || execRefusesName(i.name)) continue
    if (!i.shot_kind && m.shotOnly(i.path)) continue
    // 跟 collect 一樣：沒讀過內容的大檔照樣是候選，不再算進「需要你查看」。
    pending++
    // **跟 isDefaultChecked 同一個判斷**，不可以有第二份：信心過門檻、而且讀過內容。
    if (Number(i.top_conf) >= DEFAULT_CHECK_MIN && !noFingerprint(i)) ready++
  }
  return { pending, ready, needsHuman: brokenForHuman(db, m).length }
}

const cmpDesc = (a = '', b = '') => a < b ? 1 : a > b ? -1 : 0

function needsHumanWhy(b: ItemRow): string {
  // 太大是事實（沒有指紋），不看 scanner 寫了什麼字 —— 那句「超過清理掃描上限」
  // 以前被翻成「讀不到這個檔案」（稽核 RC11）。
  if (b.status !== 'error' && noFingerprint(b)) return TOO_LARGE_WHY
  return safeWhy(b.error) ?? 'cannot read this file'
}

/**
 * 預設勾不勾。**沒讀過內容的檔一律不勾**（2026-09-21）。
 *
 * 大檔現在清得掉了（執行層改用 dev／ino／大小／時間認身分，不再整份讀），
 * 但「清得掉」不等於「該幫你勾起來」：超過上限的檔裡最典型的一個就是
 * `婚禮影片備份.zip` —— 8 GB、副檔名 .zip、放了很久，archive 規則給它 65 分，
 * 而我們**連看都沒看過它的內容**。那一格預設打勾，使用者一鍵就把婚禮影片送進隔離區。
 *
 * 2026-09-19 的稽核 RC4 當時的結論是「連列都不要列」，理由是執行層對它永遠拒收、
 * 列出來只會卡住計畫。那個前提現在不成立了（它搬得動），所以改成列、但不預設勾：
 * 使用者看得到、要清得自己伸手勾 —— 這正是這個專案對「沒把握的事」一貫的做法。
 */
const isDefaultChecked = (g: Group) =>
  g.cands[0].confidence >= DEFAULT_CHECK_MIN && !noFingerprint(g.item)

/**
 * 清理候選，以**檔案**為單位。
 * HTTP route 與 CLI 都用這一支 —— 不准有第二份組裝邏輯。
 */
export function listCandidates(db: DatabaseSync, opts: ListOptions): CandidateList {
  const limit = opts.limit ?? 500
  const all = collect(db, opts)
  const pre = rootPrefixes(opts.roots)

  const rows: CandidateRow[] = []
  // 模型的看法一次查完（一個檔最多兩次索引查詢）。查不到就是 null —— 沒接模型時這裡永遠是空的
  const opinions = safe(() => opinionsFor(db, all.rows.slice(0, limit).map(g => g.item.id)),
    new Map<string, ModelOpinion>())
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
      model: opinions.get(item.id) ?? null,
    })
    bytes += item.bytes
  }

  const NEEDS_HUMAN_LIMIT = 50
  const nh = all.needsHuman
  const tooLarge = nh.filter(x => x.why === TOO_LARGE_WHY).length
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
    needsHumanCounts: { tooLarge, unreadable: nh.length - tooLarge },
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
  /** 截圖資料夾（只收截圖類）。徽章數字要跟清單同一套篩選，見 ListOptions */
  screenshotsDir?: string | null | (() => string | null)
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
 * 抽成純函式是為了**測得到**「滿七天 + 走訪沒看完」這個組合。守著它的測試在
 * test/audit-0919-r2routes.test.mjs 的 R2-12c：直接呼叫這一支，也用真的隔離區造一次
 * （裡面放一個讀不到的資料夾）。以前這段註解宣稱有突變測試守著，但直接呼叫它的測試早就刪了，
 * 把 `if (q.truncated) return false` 拿掉整套照樣全綠（第二輪稽核 B-M25）。
 *
 * `canEmptyNow` 的意思是**「按下去會有東西被刪掉」**，不是「整區都能清」。
 * `emptyQuarantine` 本來就只刪合格的那幾筆，所以只要有一筆滿七天就成立。
 * 這個定義跟 canEmptyAt 互推：`canEmptyNow === (canEmptyAt !== null && canEmptyAt <= now)`。
 * 互推只對帶 token 的 /health 成立：免 token 的那一份 canEmptyAt 遮成 null，canEmptyNow 照給（第三波之二）。
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
  // **只有「還沒完成的搬移（started、reverted、failed）留下的 0 byte 預留檔」不是孤兒**（第二輪 R2-1d）。
  // performMove 先在隔離區預留一個空檔、再 rename；中斷或 rename 失敗（EXDEV、Windows 上檔案開著的
  // EPERM）就留下它 —— 那是這個工具自己的。第三波只認 started／reverted，failed 的空檔被報成
  // 「來路不明」，每失敗一份計畫就多一個、永遠消不掉（稽核 A-exp1、B-r6）。
  // **有內容的檔一律照算**，不管掛在哪一列：rename 完才出事（沒寫 done、驗證沒過）的真檔，
  // 清單與清空都看不到它，「另有 1 個來路不明的檔」是使用者唯一的線索。只數，不回路徑。
  const reserved = new Set((db.prepare(
    `SELECT DISTINCT to_path FROM cleanup_journal WHERE op='quarantine' AND status <> 'done' AND to_path IS NOT NULL`
  ).all() as { to_path: string }[]).map(r => r.to_path)
    .filter(p => safe(() => { const st = lstatSync(p); return st.isFile() && st.size === 0 }, false))).size
  // -1 代表磁碟讀不到／沒看完。journal 說有 N 筆但磁碟數不出來 → 說不出有沒有孤兒
  const orphans = onDisk < 0 ? 0 : Math.max(0, onDisk - rows.length - reserved)
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
/**
 * 英文的單複數。`1 files` 是最容易被看到、也最廉價的破綻 ——
 * 而寵物的對話框是整個作品最常被截圖的地方（稽核 2026-09-20）。
 */
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * 「現在在讀嗎、還剩幾個」。
 *
 * `running` 看的是 META.thinking 那一列：**要夠新**才算（pet 被砍掉會留下一列假的，
 * 見那個 key 的說明）。`pending` 是還沒讀過的檔數，上限 500（畫面只寫 500+）。
 */
export function readingState(db: DatabaseSync, roots: readonly string[]): { running: boolean; pending: number } {
  const started = safe(() => getMeta(db, META.thinking), null)
  const at = started ? Date.parse(started) : NaN
  const running = Number.isFinite(at) && Date.now() - at < STALE_THINK_MS
  return { running, pending: safe(() => pendingCount(db, roots), 0) }
}

export function petState(
  h: {
    db: { ok: boolean }; watcher: { ok: boolean; watching?: unknown; watchingCount?: unknown; rootsMissing?: unknown }
    pendingCandidates: number
    /**
     * 預設勾的那幾個（有把握的）。**寵物的心情與台詞用這個數，不用 pendingCandidates**
     * （2026-09-21）。保護副檔名清單拿掉之後 pendingCandidates 從 393 變成 908，
     * 而 `pendingCandidates > 0 ? 'found'` 會讓寵物**永遠**停在「找到東西了」，
     * 台詞永遠是「Found 908 files that could be cleaned up」——
     * 那是「你的 Downloads 有多大」，不是「我發現了幾件值得說的事」。
     *
     * 舊後端沒有這一欄就退回 pendingCandidates（照以前的樣子講）。
     */
    readyCandidates?: number
    lastError: unknown
    lastErrorAt?: string | null; lastOkAt?: string | null
    lastErrorKind?: string | null; lastOkByKind?: Partial<Record<string, string | null>> | null
    scanProblems?: unknown
  },
  counts: { proposedPlans: number; activeQuarantine: number },
) {
  const problems = (Array.isArray(h.scanProblems) ? h.scanProblems : [])
    .filter((p: unknown): p is string => typeof p === 'string' && p !== '')
    .slice(0, MAX_SCAN_PROBLEMS)
  const rootsMissing = typeof h.watcher.rootsMissing === 'number' && Number.isInteger(h.watcher.rootsMissing)
    ? h.watcher.rootsMissing : 0
  // 有把握的那幾個。舊後端沒給就退回全部（照以前的樣子講）。
  const ready = Number.isFinite(Number(h.readyCandidates))
    ? Math.max(0, Math.floor(Number(h.readyCandidates)))
    : h.pendingCandidates
  const state =
    // 壞掉的時候顯示「找到 7 個可以清」是在騙人
    !h.db.ok || errorStillActive(h) ? 'worried'
    // **掃描根本沒在掃也要擔心**（第三輪 R3-12）：清理資料夾不見了（使用者搬了家目錄、換了
    // OneDrive 路徑、外接碟沒掛上）、或上一次掃描回報過問題的時候，掃描會安靜地回 0 個檔 ——
    // 跟「很乾淨」長得一模一樣。以前這件事只有跑 CLI doctor 的人看得到，常駐在系統匣、
    // 只看寵物與面板的使用者會一直被告知「沒事，在發呆」，而工具其實一個檔都沒在掃。
    : rootsMissing > 0 || problems.length > 0 ? 'worried'
    // 使用者正在等確認，這時候跳「找到東西了」會蓋掉待辦
    : counts.proposedPlans > 0 ? 'waiting'
    : ready > 0 ? 'found'
    : h.watcher.ok ? 'watching'
    : 'idle'

  // **訊息裡不放問題的原文**（R3-12）：那些字串已經去過路徑，但寵物的對話框是最容易被截圖、
  // 最容易被旁人看到的地方，檔名與資料夾名不必出現在那裡。詳情在 scanProblems 陣列裡，面板自己決定怎麼列。
  const scanWhy = rootsMissing > 0
    ? (rootsMissing > 1 ? `${rootsMissing} cleanup folders look like they are gone. Have a look at doctor.` : 'A cleanup folder looks like it is gone. Have a look at doctor.')
    : `The last scan reported ${plural(problems.length, 'problem')}. Have a look at doctor.`

  const message =
    !h.db.ok || errorStillActive(h) ? 'Something is off in the backend. Have a look at doctor.'
    : state === 'worried' ? scanWhy
    : state === 'waiting' ? `${plural(counts.proposedPlans, 'list')} ${counts.proposedPlans === 1 ? 'is' : 'are'} waiting for you.`
    : state === 'found' ? `Found ${plural(ready, 'file')} that could be cleaned up.`
    : state === 'watching' ? `Keeping an eye on ${watchingPhrase(h.watcher)}.`
    : 'Nothing going on. Just daydreaming.'

  return {
    state,
    message,
    // **這個欄位是寵物的對外數字**，所以給有把握的那幾個（跟 message 一致）。
    pendingCount: ready,
    /** 清單列得出來的全部。面板的「Files you can clear out」那一行用它，不藏。 */
    listedCount: h.pendingCandidates,
    quarantinedCount: counts.activeQuarantine,
    undoable: counts.activeQuarantine > 0,
    /** 上一次完整掃描回報的問題（人話、不帶完整路徑）。面板要看得到，不能只有 doctor（R3-12）。 */
    scanProblems: problems,
  }
}

/**
 * 顯示用的資料夾名：C0／C1 控制字元、換行、U+2028／U+2029、bidi 控制字元一律換成「·」
 * （跟 cli.mjs 的 shown 同一組字元）。資料夾名是不可信的輸入 —— 名字裡的換行可以在
 * 寵物的對話框裡偽造一行字，`\u202E` 可以把後半段倒過來顯示。
 */
const UNSAFE_DISPLAY = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g

/**
 * 寵物「監看中」那句話講的是哪些資料夾（第三波之二）。以前寫死「Downloads」——
 * 清理範圍是 cleanup.roots，開了截圖資料夾就多一個，改過設定的也不叫 Downloads。
 *
 * 說法跟面板的 folderPhrase（core/assets/cleanup-real-state.js）一樣：只給名字，
 * 最多列三個、多的講「等 N 個」；家目錄那個 displayPath 給空字串（名字就是使用者名稱），不列；
 * 拿不到名字就講「監看資料夾」，不猜。`watching` 要是帶 token 的 /health 那一份（免 token 的是空陣列）。
 */
function watchingPhrase(w: { watching?: unknown; watchingCount?: unknown }): string {
  const list = Array.isArray(w.watching) ? w.watching : []
  const count = typeof w.watchingCount === 'number' && Number.isInteger(w.watchingCount) ? w.watchingCount : 0
  const total = Math.max(count, list.length)
  const names = list.filter(n => typeof n === 'string' && n !== '')
    .map(n => `“${String(n).replace(UNSAFE_DISPLAY, '·')}”`)
  if (!names.length) return total > 1 ? `${total} watched folders` : 'the watched folder'
  const shown = names.slice(0, 3).join(', ')
  return names.length === total && total <= 3 ? shown : `${shown} and more (${total} folders)`
}

/**
 * 上一次的錯還「算數」嗎？**之後同一種動作成功過就不算。**
 *
 * 稽查抓到（A-M4、C-C3）：lastError 寫了就永遠不清，一次 BUSY、一次打錯的網址
 * 就讓寵物永久擔心。修法是記「最近一次成功」，比時間。
 * 第二輪（R2-10）再分種類：以前**任何**一次成功都算，pet 每 30 分鐘的背景重掃一成功，
 * 一直壞著的套用就被蓋掉了。所以：
 * - 錯有種類（scan／apply／undo／empty）→ 看 lastOkByKind 裡**同一種**的成功時間
 * - 錯沒有種類（舊資料、GET 路由的意外、沒帶種類的呼叫）→ 照舊，任何一次成功（lastOkAt）都算
 * 沒有時間可比（舊格式、或呼叫端只給了 lastError）的時候倒向擔心 —— 寧可多看一眼。
 *
 * 匯出給 doctor 用（「之後同一種動作成功過，寵物不會再為它擔心」要跟寵物同一個判斷）。
 */
export function errorStillActive(h: {
  lastError: unknown; lastErrorAt?: string | null; lastOkAt?: string | null
  lastErrorKind?: string | null; lastOkByKind?: Partial<Record<string, string | null>> | null
}): boolean {
  if (!h.lastError) return false
  const okAt = isActionKind(h.lastErrorKind) ? (h.lastOkByKind?.[h.lastErrorKind] ?? null) : h.lastOkAt
  const e = Date.parse(h.lastErrorAt ?? ''), o = Date.parse(okAt ?? '')
  return !(Number.isFinite(e) && Number.isFinite(o) && o > e)
}

/** meta 裡的 lastError 是「ISO 時間 空白 訊息」。舊資料可能帶路徑，讀出來一律再翻一次。 */
function parseLastError(raw: string | null): { at: string | null; why: string | null } {
  if (!raw) return { at: null, why: null }
  const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+([\s\S]*)$/.exec(raw)
  const at = m && Number.isFinite(Date.parse(m[1])) ? m[1] : null
  return { at, why: safeWhy(m ? m[2] : raw) ?? 'the backend hit an error' }
}

const setMeta = (db: DatabaseSync, k: string, v: string) =>
  db.prepare(`INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(k, v)

/**
 * 時間戳要**嚴格晚於**其他幾個。同一毫秒內先錯後成功（或先成功後錯），
 * 單看時鐘分不出先後；寵物要看得出哪個在後。時鐘往回跳也一樣成立。
 */
function laterThan(...others: (string | null)[]): string {
  let t = Date.now()
  for (const other of others) {
    const o = other ? Date.parse(other) : NaN
    if (Number.isFinite(o)) t = Math.max(t, o + 1)
  }
  return new Date(t).toISOString()
}

/** lastError 的種類：種類那一列的時間要跟 lastError 的時間一樣才算（見 META.lastErrorKind）。 */
function lastErrorKindOf(db: DatabaseSync, errorAt: string | null): ActionKind | null {
  if (!errorAt) return null
  const m = /^(\S+)\s+(\S+)$/.exec(getMeta(db, META.lastErrorKind) ?? '')
  return m && m[1] === errorAt && isActionKind(m[2]) ? m[2] : null
}

/**
 * 寫一筆 lastError（人話＋時間，種類另外一列）。時間要晚於最近的成功**與**上一個錯 ——
 * 不然同一毫秒的兩個錯，後一個（沒種類）會對上前一個的種類。
 */
function writeLastError(db: DatabaseSync, why: string, kind?: ActionKind) {
  try {
    const prev = parseLastError(safe(() => getMeta(db, META.lastError), null)).at
    const at = laterThan(safe(() => getMeta(db, META.lastOk), null), prev)
    setMeta(db, META.lastError, `${at} ${why}`)
    if (kind) setMeta(db, META.lastErrorKind, `${at} ${kind}`)
  } catch { /* 連 meta 都寫不進去就算了 */ }
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
export function recordCleanupError(db: DatabaseSync, e: unknown, kind?: ActionKind): boolean {
  if (!isSurprise(e)) return false
  const raw = String((e as any)?.message ?? e).slice(0, 300)
  console.error('[contextbox] cleanup error:', raw)
  writeLastError(db, safeWhy(raw) ?? 'the backend hit an error', isActionKind(kind) ? kind : undefined)
  return true
}

/**
 * 記一次成功。成功的掃描、套用、復原、清空都要記 —— route 與 CLI 都用這一支，不要自己寫 meta。
 *
 * `kind` 是哪一種動作（第二輪 R2-10）：寫 lastOkAt，也寫那一種自己的時間（lastOkByKind）。
 * **不帶 kind 是「通用成功」**（第一波的舊呼叫照樣能用）：只寫 lastOkAt —— 它清得掉沒有種類的錯
 * （舊資料、GET 路由的意外），**清不掉有種類的錯**：不知道成功的是哪一種，就不替別的動作說「好了」。
 * 看不懂的 kind 當成沒帶。
 */
export function recordOk(db: DatabaseSync, kind?: ActionKind): void {
  try {
    const at = laterThan(parseLastError(getMeta(db, META.lastError)).at)
    setMeta(db, META.lastOk, at)
    if (isActionKind(kind)) setMeta(db, lastOkKey(kind), at)
  } catch { /* 寫不進去就算了：頂多寵物多擔心一下 */ }
}

/**
 * 套用、復原、清空做完之後記一筆（第二輪 R2-10）：**每一項都失敗記成錯，其他記成功**。
 * 以前一律 recordOk —— 整份計畫全部 EXDEV（status error），寵物照樣說沒事。
 * 回 'error' 或 'ok'。route 與 CLI 都用這一支。
 *
 * - apply／undo：看計畫的 `status`，'error' 就是每一項都失敗（partial 算成功：有做成的）
 * - empty：看清空的結果，有錯而且一個都沒刪掉才算失敗
 * 存的原因是第一項的人話（B 的 cleanupProblem 寫的，不帶路徑），再過一次 safeWhy。
 *
 * **`noop`（這次什麼都沒做）既不算成功、也不算失敗**（第三輪 R3-2b）。跑過的計畫再 apply、
 * 已經確認過的清空再送，核心會原樣回傳、一個檔都不碰（R2-3）。以前這種回傳走 recordOk，
 * 於是任何一次重送（面板斷線重試、擴充套件重送、點歷史列、腳本 retry）都把一個**一直壞著**的
 * 套用錯標成「好了」，寵物從擔心變成發呆 —— 正是 R2-10 要防的那件事（稽核第三輪 A）。
 * 反過來也不可以記錯：那個 status='error' 是上一次留下的，重記只會把 lastError 的時間一直往後推，
 * 讓一個早就過期的錯永遠續命（R3-15）。所以回 'noop'，meta 一個字都不動。
 */
export function recordActionResult(db: DatabaseSync, kind: 'apply' | 'undo' | 'empty', result: unknown): 'error' | 'ok' | 'noop' {
  const r = (result ?? {}) as {
    status?: unknown; error?: unknown; deletedCount?: unknown; errors?: { error?: unknown }[]; noop?: unknown
  }
  if (r.noop === true) return 'noop'
  let why: string | null = null
  if (kind === 'empty') {
    if (Array.isArray(r.errors) && r.errors.length && !r.deletedCount) {
      why = `Emptying quarantine deleted nothing: ${safeWhy(String(r.errors[0]?.error ?? '')) ?? 'reason unknown'}`
    }
  } else if (r.status === 'error') {
    const first = safeWhy(typeof r.error === 'string' ? r.error : null) ?? 'reason unknown'
    why = kind === 'apply' ? `This cleanup moved nothing: ${first}` : `This undo put nothing back: ${first}`
  }
  if (why) {
    console.error('[contextbox] cleanup error:', why)
    writeLastError(db, why.slice(0, 300), kind)
    return 'error'
  }
  recordOk(db, kind)
  return 'ok'
}

/**
 * 存最近一次完整掃描回報的問題（第二輪 R2-10）。帶 token 的 /health 回 `scanProblems`。
 *
 * 呼叫端要給**已經去掉路徑**的那份（scanProblems() 的輸出）；這裡再保險一次：
 * 控制字元與方向字元換掉、每條最多 300 字、最多 MAX_SCAN_PROBLEMS 條。空陣列＝這次沒問題（清掉上一次的）。
 * 以前這些話只印到背景行程的 stderr，面板與 doctor 都看不到（稽核 C-f6）。
 * POST /cleanup/scan 會呼叫；CLI 的 cleanup scan（pet 的背景重掃）也要呼叫。
 */
export function recordScanProblems(db: DatabaseSync, problems: string[]): void {
  const clean = (Array.isArray(problems) ? problems : []).slice(0, MAX_SCAN_PROBLEMS)
    .map(p => String(p).replace(UNSAFE_DISPLAY, '·').slice(0, 300))
  try { setMeta(db, META.scanProblems, JSON.stringify(clean)) } catch { /* 寫不進去就算了 */ }
}

function readScanProblems(db: DatabaseSync): string[] {
  const v = JSON.parse(getMeta(db, META.scanProblems) ?? '[]')
  return Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, MAX_SCAN_PROBLEMS) : []
}

/** 舊名字（第一波的介面），跟 recordOk 是同一支。新程式碼請用 recordOk。 */
export const recordCleanupOk = recordOk

export function healthSnapshot(db: DatabaseSync, opts: HealthOptions) {
  const rootList = safe(() => typeof opts.roots === 'function' ? opts.roots() : opts.roots, [] as string[])
  const shots = safe(() => typeof opts.screenshotsDir === 'function' ? opts.screenshotsDir() : (opts.screenshotsDir ?? null), null)
  // **每一段各自 try/catch。** 這支是唯一免 token 的端點，它必須
  // 永遠回得出完整形狀 —— 資料庫壞掉時回一個少了 watcher／quarantine
  // 的第三種形狀，UI 會直接 TypeError。
  // 而且 lastError 要**最先**讀：資料庫壞掉正是它唯一要處理的情境，
  // 排在後面的話會先被別的查詢炸掉，整條回饋迴路失效。
  const lastErrorRaw = safe(() => getMeta(db, META.lastError), null)
  const lastErr = parseLastError(lastErrorRaw)
  const lastOkAt = safe(() => getMeta(db, META.lastOk), null)
  const lastErrorKind = lastErrorRaw ? safe(() => lastErrorKindOf(db, lastErr.at), null) : null
  const okByKind = Object.fromEntries(ACTION_KINDS.map(k => [k, safe(() => getMeta(db, lastOkKey(k)), null)])) as Record<ActionKind, string | null>
  const beat = safe(() => getMeta(db, META.heartbeat), null)
  const pid = Number(safe(() => getMeta(db, META.pid), null))
  const running = Boolean(beat) && alive(pid)
  const fresh = Boolean(beat) && (Date.now() - Date.parse(beat!)) < 5 * 60_000

  // 隔離區：journal 是正本，磁碟只用來對帳（見 quarantineFromJournal）。
  const q = safe(() => quarantineFromJournal(db, opts.quarantine),
    { items: 0, bytes: 0, oldestMtimeAt: null, canEmptyAt: null, orphans: 0, truncated: true })

  // 徽章數字跟清單**同一套篩選**（collectCounts 是 collect 的只數數字版）。各自寫一條 COUNT 的話，
  // 清單排掉的（桌面上的、太大的、跟清理無關的大檔）這裡還會算進去。
  const counted = safe(() => collectCounts(db, { roots: rootList, screenshotsDir: shots }),
    { pending: 0, ready: 0, needsHuman: 0 })
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
      why: !beat ? 'never ran'
        : !running ? 'that process is gone'
        : !fresh ? 'the process is alive but its heartbeat stopped over five minutes ago'
        : rootsMissing ? 'a watched folder does not exist'
        : null,
    },
    quarantine: {
      items: q.items, bytes: q.bytes,
      // 兩個時間只給帶 token 的，跟下面的 lastOkAt 同一個理由：canEmptyAt 減七天
      // 就是「使用者什麼時候清理過」，oldestMtimeAt 是「那個檔什麼時候下載的」。
      // 欄位兩版都有（形狀一致），遮蔽時是 null。
      /** 檔案自己的 mtime，**不是**隔離時間。只拿來顯示，不要拿來算七天。 */
      oldestMtimeAt: full ? q.oldestMtimeAt : null,
      canEmptyAt: full ? q.canEmptyAt : null,
      // 布林不帶時間，兩版都給 —— 而且要用**遮蔽前**的 q 算，遮掉之後 canEmptyAt 是 null，會永遠 false
      canEmptyNow: canEmptyNow(q),
      /** 隔離區裡有、journal 沒有的檔。清空**不會**動到它們，所以要說出來。 */
      orphans: q.orphans,
      truncated: q.truncated,
    },
    pendingCandidates: pending,
    // **有把握的那幾個**（預設勾的）。徽章與寵物的心情／台詞都用這個數 ——
    // 保護副檔名清單拿掉之後那個數字變成「你的 Downloads 有多大」，不是「有幾件事要說」。
    readyCandidates: counted.ready,
    needsHumanCount: errors,
    // lastError 的內容只給帶 token 的。存進去的時候已經翻成人話（recordCleanupError），
    // 讀出來再翻一次 —— 舊版存的是原文，帶完整路徑（fs 的 message 一律含 path）。
    lastError: full
      ? (lastErrorRaw ? (lastErr.at ? `${lastErr.at} ${lastErr.why}` : lastErr.why) : null)
      : (lastErrorRaw ? 'yes, but only visible with a token' : null),
    // 時間只給帶 token 的：免 token 的 /health 同機任何行程都讀得到，時間會洩漏
    // 「使用者什麼時候清理過」。欄位兩版都有（形狀一致），遮蔽時是 null。
    // 寵物（/pet/state，要 token）拿它們比「錯在成功之後嗎」。
    lastErrorAt: full ? lastErr.at : null,
    lastOkAt: full ? lastOkAt : null,
    // 第二輪 R2-10：錯是哪一種動作的、每一種動作最近一次成功。寵物比的是**同一種**（見 errorStillActive）。
    // 只給帶 token 的（時間），免 token 的欄位還在、值是 null。
    lastErrorKind: full ? lastErrorKind : null,
    lastOkByKind: Object.fromEntries(ACTION_KINDS.map(k => [k, full ? okByKind[k] : null])) as Record<ActionKind, string | null>,
    // 最近一次完整掃描回報的問題（人話、不帶路徑）。內容只給帶 token 的，免 token 的是空陣列
    scanProblems: full ? safe(() => readScanProblems(db), [] as string[]) : [] as string[],
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
export function defaultSelection(db: DatabaseSync, scope: string[] | CleanupScope, maxFiles: number = DEFAULT_PLAN_MAX_FILES) {
  const checked = collect(db, scopeOf(scope)).rows.filter(isDefaultChecked)
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
export function defaultCandidateIds(db: DatabaseSync, scope: string[] | CleanupScope): string[] & { files: number; remaining: number } {
  const s = defaultSelection(db, scope)
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
export function createPlanForRoots(db: DatabaseSync, scope: string[] | CleanupScope, opts: { candidateIds: unknown; requestId?: unknown }) {
  validateIds(opts.candidateIds)
  const ids = opts.candidateIds
  const replay = typeof opts.requestId === 'string' && opts.requestId.length > 0 && safe(() => Boolean(
    db.prepare('SELECT 1 FROM cleanup_plan_requests WHERE request_id=?').get(opts.requestId as string)), false)
  if (!replay) {
    const listed = new Set(collect(db, scopeOf(scope)).rows.flatMap(g => g.cands.map(c => c.id)))
    if (ids.some(id => !listed.has(id))) {
      throw new CleanupError('STALE_CANDIDATE', 'The candidates changed. Scan again and build a new plan.')
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
 *
 * `started`：這份計畫**有沒有任何搬移紀錄**（第二輪 R2-5b）。套用到一半中斷（被砍、斷電、鎖被接走）
 * 的計畫還是 proposed，但它已經開始了：只能「繼續」（apply）或「放回」（undo），**不能放棄**
 * （release 回 409）。以前沒有這個欄位，面板照樣說「放棄上次那份：不動任何檔案」，按下去 409（稽核 B-r7）。
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
  const started = tableExists(db, 'cleanup_journal')
    && Boolean(db.prepare('SELECT 1 FROM cleanup_journal WHERE plan_id=? LIMIT 1').get(p.id))
  // **復原到一半中斷的那份，再 apply 一定 409**（applyPlan 看到 restore 紀錄就擋）。
  // 不講的話面板會給「繼續上次那份」這顆一定失敗的按鈕（第二輪第二階段驗證員）。
  const restoring = tableExists(db, 'cleanup_journal')
    && Boolean(db.prepare(`SELECT 1 FROM cleanup_journal WHERE plan_id=? AND op='restore' LIMIT 1`).get(p.id))
  return { id: p.id, status: p.status, createdAt: p.created_at, started, restoring, items }
}

// ── 計畫的逐項結果 ───────────────────────────────────────────

export type ItemOutcome =
  | 'pending' | 'moved' | 'skipped' | 'failed' | 'restored' | 'purged'
  /** journal 停在 started：搬（或復原）到一半中斷，檔案在哪裡不確定 */
  | 'unknown'
  /** 這個檔沒有動過：計畫被放棄了（dismiss／release），或計畫跑過、這一項從來沒處理到（沒有搬移紀錄、也沒有失敗原因） */
  | 'cancelled'
type Outcome = { outcome: ItemOutcome; why: string | null; restoredAs?: string }

/**
 * 搬到一半中斷的話。**不可以說「沒有搬動」** —— rename 可能已經完成、只是還沒寫 done
 * （kill -9、斷電）。稽查實測：檔案在隔離區，畫面說「沒有搬動，原因不明」（A-M3）。
 *
 * **也不可以叫人再套用一次、說那樣會接完**（第二輪）：R2-3 起跑完過的 partial／error 再 apply
 * 原樣回傳，不重試；rename 之後驗證沒過、又搬不回去的那種，journal 刻意停在 started，再套用也不會動它。
 * 只有還沒跑完的 proposed 再套用會接著做。所以照實講：說不準檔在哪；復原（undoPlan）會把在隔離區、
 * 指紋對得上的放回原位，確認沒搬過的結掉；doctor 看得到整體的狀態。
 */
const MOVE_INTERRUPTED = 'Interrupted mid-move, so there is no telling whether the file is where it was or in quarantine. “Undo” puts back whatever is in quarantine; you can also run node cli.mjs doctor to check.'
/**
 * 復原到一半中斷的話。再按一次復原多半接得完（performMove 認得「已經放回去了」），但放回之後
 * 原位的檔又被改過就接不上 —— 所以不說「會把它接完」，只說會接著放回。
 */
const RESTORE_INTERRUPTED = 'Interrupted mid-undo, so there is no telling whether the file is still in quarantine or already back. Pressing undo again carries on; you can also run node cli.mjs doctor to check.'

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
  // 存下來的原因**一律要讀**：stored:false 只是 why 不拿它（recordItemErrors 用）。
  // 「有沒有存下來的原因」決定這一項是 failed 還是 cancelled —— 看不到就會把它當成沒處理到，
  // recordItemErrors 接著把那一列刪掉（第二輪 R2-1e 的陷阱）。
  const storedAll = storedWhys(db, planId)
  const stored = opts.stored === false ? new Map<string, string>() : storedAll
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
        // **第三波 R3-4**：搬進去了、驗證沒過、又搬不回原位的那一種，原因存在 cleanup_item_errors
        // （跟著計畫走，重掃不會蓋掉）—— 那句「請人工檢查隔離區」是使用者唯一的線索，不可以吞掉。
        raw = (r?.status === 'failed' ? safeWhy(r.error) : null)
          ?? (i.status === 'quarantined' ? safeWhy(i.error) : null)
        why = raw ?? storedAll.get(i.item_id) ?? null
      }
    }
    else if (q?.status === 'started') { outcome = 'unknown'; why = MOVE_INTERRUPTED }
    else if (!ran && !q) outcome = plan.status === 'dismissed' ? 'cancelled' : 'pending'
    // **跑過的計畫裡，這一項沒有任何搬移紀錄、也沒有任何存下來的失敗原因 → 沒處理到**（第二輪 R2-1e）。
    // 套用中斷在前幾項、之後按了復原（計畫變成 restored），後面那些從來沒碰過 ——
    // 以前掉進下面的 failed「沒有搬動，原因不明」，逐項結果不是實話（稽核 A-exp3）。
    // 檢查沒過（TOO_FRESH…）也不寫 journal，但它會存原因（cleanup_item_errors），所以照樣是 failed。
    //
    // **只看跟這份計畫有關的證據**（稽核第三輪 R3-8）：cleanup_journal 依 plan_id、
    // cleanup_item_errors 依 (plan_id,item_id)。以前還看了 `i.error` —— 那是 file_items.error，
    // 全域、每個檔一份，寫它的人不只這份計畫（下一次掃描讀不到那個檔、另一份計畫失敗都會寫）。
    // 只要那個檔之後因為任何別的理由被寫上 error，這一項就從 cancelled 被打回 failed，
    // 而且顯示的原因是別份計畫／別次掃描的原因，掛在這份計畫的歷史上。
    else if (!q && !storedAll.has(i.item_id)) outcome = 'cancelled'
    else {
      outcome = 'failed'
      // 失敗原因有兩個地方：搬移失敗寫在 journal；**檢查沒過（例如 TOO_FRESH）
      // 根本不會寫 journal**，只寫 file_items.error —— 而那一欄下一次掃描就被改寫。
      // 所以先讀套用當下存起來的（cleanup_item_errors），再看 journal，最後才是 file_items。
      raw = safeWhy(q?.error) ?? safeWhy(i.error)
      why = stored.get(i.item_id) ?? raw ?? 'did not move, reason unknown'
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
 * unknown（搬到一半中斷）、cancelled（沒動過：計畫放棄了，或計畫跑過、這一項沒處理到）。
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
      // **還在隔離區、但講得出原因的不可以刪掉**（稽核第三輪 R3-4）：
      // 「搬進去之後檔案還在變動，沒有放回原位，請人工檢查隔離區」是隔離區那個檔唯一的線索，
      // 刪掉它就等於又把這件事藏起來。照樣寫回去（file_items.error 會被下一次掃描蓋掉）。
      } else if (x.outcome === 'moved' && x.raw) {
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
  // restoring：這份已經開始復原（有 restore 紀錄）。**再 apply 一定 409**，呼叫端要拿它決定給哪些出口。
  const restoring = tableExists(db, 'cleanup_journal') && Boolean(db.prepare(
    `SELECT 1 FROM cleanup_journal WHERE plan_id=? AND op='restore' LIMIT 1`).get(dto.id))
  return { ...dto, restoring, items: dto.items.map(i => ({ ...i, ...(o.get(i.itemId) ?? { outcome: 'pending', why: null }) })) }
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
    throw new CleanupError('BAD_BODY', 'Bad paging: limit must be 1 to 100 and offset cannot be negative.')
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
    // 有任何 restore 紀錄 → 這份已經開始復原了，再 apply 一定 409（跟 blockingPlanFor 同一個判斷）
    const restoring = Boolean(db.prepare(
      `SELECT 1 FROM cleanup_journal WHERE plan_id=? AND op='restore' LIMIT 1`).get(p.id))
    return {
      id: p.id, status: p.status, createdAt: p.created_at, appliedAt: p.applied_at,
      restoredAt: restored.ts, canUndo, restoring,
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
    if (!Number.isFinite(done)) throw new CleanupError('UNSAFE_JOURNAL', 'The quarantine timestamp is missing, so this cannot be emptied.')
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
    console.error('[contextbox] could not clear old empty-preview rows:', e?.message ?? e)
  }
}

// ── HTTP ─────────────────────────────────────────────────────

// ── 連拍截圖：組、縮圖、主動詢問 ─────────────────────────────

/**
 * 縮圖的長邊上限。**原圖不回**：4K 截圖一張 8 MB，面板要同時看好幾張；
 * 而且原圖就是使用者的螢幕內容，沒有必要整張再走一次 HTTP。
 */
export const THUMB_MAX_SIDE = 480

/** 縮圖端點願意讀多大的檔（超過的不給縮圖 —— 上游 png.ts 還有 4000 萬像素的上限）。 */
const THUMB_MAX_BYTES = 64 * 1024 * 1024

/** meta 裡記「已經主動彈過的組 id」。 */
export const BURST_ASKED_KEY = 'burst_asked'
/** burst_asked 只留最新這麼多組。 */
export const BURST_ASKED_KEEP = 50

export type BurstBox = { x: number; y: number; w: number; h: number }
export type BurstMemberView = {
  itemId: string
  name: string
  bytes: number
  level: 'same' | 'similar'
  thumb: string
  boxes: BurstBox[]
  /** 模型對這張截圖的看法（P2），沒問過是 null。**是意見，不是事實** */
  model: ModelOpinion | null
}
export type BurstGroupView = {
  id: string
  level: 'same' | 'similar'
  /** 這一組最早與最晚差幾秒。0 代表算不出來（面板就不提時間）。 */
  spanSec: number
  keep: { itemId: string; name: string; bytes: number; thumb: string; model: ModelOpinion | null }
  members: BurstMemberView[]
}

type BurstRowView = {
  item_id: string
  group_id: string
  keep_id: string
  level: string
  boxes: string
  name: string
  bytes: number
  path: string
  mtime: string
}

const thumbUrl = (itemId: string) => `/cleanup/thumb/${encodeURIComponent(itemId)}`

function parseBoxes(raw: string): BurstBox[] {
  let v: unknown
  try { v = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(v)) return []
  const out: BurstBox[] = []
  for (const b of v) {
    if (!b || typeof b !== 'object') continue
    const { x, y, w, h } = b as Record<string, unknown>
    if (![x, y, w, h].every(n => typeof n === 'number' && Number.isFinite(n))) continue
    out.push({ x: x as number, y: y as number, w: w as number, h: h as number })
  }
  return out
}

/**
 * 目前的連拍組。**掃描算好的**（core/cleanup-scanner.ts 的 wireBursts），這裡只組畫面要的樣子：
 * 檔名、大小、等級、縮圖網址、0–1 的外框。**沒有路徑**。
 *
 * 再過濾一次的理由跟 collect 一樣：
 * - **只看現在清理範圍底下的**。設定改小之後，上一輪留下的組不該再出現在畫面上
 *   （掃描端不去動範圍外的列，見 wireBursts 的 K5 註解）。
 * - **檔案狀態要還在**：搬進隔離區、不見了、讀不到的不列；少到剩一張的整組不列。
 */
export function burstGroupsView(
  db: DatabaseSync, scope: string[] | CleanupScope, opts: { models?: boolean } = {},
): BurstGroupView[] {
  const m = scopeMatcher(scopeOf(scope))
  const rows = safe(() => db.prepare(
    `SELECT b.item_id, b.group_id, b.keep_id, b.level, b.boxes, i.name, i.bytes, i.path, i.mtime
       FROM cleanup_burst_members b JOIN file_items i ON i.id = b.item_id
      WHERE i.status IN ('candidate','kept','restored') AND i.error IS NULL
      ORDER BY b.group_id, i.mtime DESC, b.item_id`
  ).all() as BurstRowView[], [] as BurstRowView[])

  const byGroup = new Map<string, BurstRowView[]>()
  for (const r of rows) {
    if (!underAny(r.path, m.pre)) continue
    // **檔案真的還在才列。** 整個資料夾被清空時，大量消失的保險絲會讓那些列維持 candidate
    // （外接碟沒掛上的情況不可以亂標 missing），但那時候問使用者「要不要清掉這幾張」很荒謬，
    // 縮圖也全部 404（P0 驗證員）。這裡的筆數很少（一組幾張、最多列 20 組），一次 lstat 不貴。
    if (!safe(() => { lstatSync(r.path); return true }, false)) continue
    const list = byGroup.get(r.group_id)
    if (list) list.push(r)
    else byGroup.set(r.group_id, [r])
  }

  // 模型的看法（P2）。**縮圖那條路不查**（burstThumbPng 只是要知道「在不在組裡」）
  const wantModels = opts.models !== false
  const ids: string[] = []
  if (wantModels) for (const list of byGroup.values()) for (const r of list) ids.push(r.item_id)
  const opinions = wantModels
    ? safe(() => opinionsFor(db, ids), new Map<string, ModelOpinion>())
    : new Map<string, ModelOpinion>()

  const out: (BurstGroupView & { at: string })[] = []
  for (const [id, list] of byGroup) {
    const keep = list.find(r => r.item_id === r.keep_id)
    const members = list.filter(r => r.item_id !== r.keep_id)
    // 留下的那張不在了（被清掉、被改掉）就整組不列 —— 「會留著 X」不成立的話不可以再問
    if (!keep || !members.length) continue
    const level = keep.level === 'same' ? 'same' : 'similar'
    // 這一組**前後跨了幾秒**。「這幾張是同一批」本質上是一句關於時間的主張，
    // 可是面板上只看得到縮圖與檔名 —— 使用者沒有辦法檢查那句話對不對
    //（2026-09-21 實機回報）。給秒數，讓人自己判斷 3 秒內連按與隔了半天是兩回事。
    // 時間解析不出來的一律當 0（面板看到 0 就不寫這一段），不猜。
    const stamps = list.map(r => Date.parse(r.mtime)).filter(Number.isFinite)
    const spanSec = stamps.length > 1
      ? Math.max(0, Math.round((Math.max(...stamps) - Math.min(...stamps)) / 1000))
      : 0
    out.push({
      id,
      level,
      spanSec,
      at: keep.mtime,
      keep: {
        itemId: keep.item_id, name: keep.name, bytes: keep.bytes, thumb: thumbUrl(keep.item_id),
        model: opinions.get(keep.item_id) ?? null,
      },
      members: members.map(r => ({
        itemId: r.item_id,
        name: r.name,
        bytes: r.bytes,
        level: r.level === 'same' ? 'same' as const : 'similar' as const,
        thumb: thumbUrl(r.item_id),
        boxes: parseBoxes(r.boxes),
        model: opinions.get(r.item_id) ?? null,
      })),
    })
  }
  // 最近的一組排最前面；時間一樣時照組 id，每次都一樣
  out.sort((a, b) => cmpDesc(a.at, b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out.map(({ at, ...g }) => g)
}

/**
 * 縮圖：灰階 PNG、長邊 ≤ THUMB_MAX_SIDE。**只給面板看得到的那些 item**，
 * 其他一律 null（呼叫端回 404）—— 這不是「任意檔案的讀取端點」。
 * 讀不到、不是 PNG、解不開的也回 null：那是一張看不到的縮圖，不是伺服器故障。
 *
 * **可見範圍問 panelReason，跟預覽同一支**（P6）。以前這裡只認「還在某一組連拍裡」，
 * 比面板窄：面板上一個普通的候選截圖點「看內容」就拿不到圖。放寬之後兩條端點寬窄永遠一致 ——
 * **不可以在這裡另外寫一份判斷**，分岔出來的那一條就是一個任意檔案讀取端點。
 */
export function burstThumbPng(db: DatabaseSync, scope: string[] | PanelScope, itemId: string): Buffer | null {
  if (typeof itemId !== 'string' || !itemId || itemId.length > 200) return null
  const row = safe(() => db.prepare(
    'SELECT id, path, bytes, mtime FROM file_items WHERE id=?').get(itemId) as
    { id: string; path: string; bytes: number; mtime: string } | undefined, undefined)
  if (!row || Number(row.bytes) > THUMB_MAX_BYTES) return null
  // **先看它到底是不是一張解得開的圖**（稽核 2026-09-20）。兩個理由，都是 P6 放寬可見範圍之後才有的：
  //   1. 省錢：這一關是一行 SQL；panelReason 要把所有候選算一遍（8000 個候選 30 ms），
  //      而面板一打開就會連打好幾次縮圖。
  //   2. 更要緊的是記憶體：放寬之後「面板看得到的檔」包含 zip、exe、影片 ——
  //      以前它們連可見範圍那一關都過不了，現在會被 readFileSync 整個讀進來（上限 64 MB）
  //      才在 decodePngGray 失敗。掃描時算過長相指紋的才有這一列，那就是「解得開的 PNG」。
  if (!hasThumb(db, row)) return null
  if (panelReason(db, scope, itemId) === null) return null

  // 檔案可能在這中間被換掉（甚至換成捷徑）：O_NOFOLLOW 開，再核對大小與 mtime
  let fd: number
  try { fd = openSync(row.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)) }
  catch { return null }
  let buf: Buffer
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size !== Number(row.bytes) || st.mtime.toISOString() !== row.mtime) return null
    buf = readFileSync(fd)
  } catch { return null }
  finally { closeSync(fd) }

  try {
    const img = decodePngGray(buf)
    const long = Math.max(img.width, img.height)
    if (long <= THUMB_MAX_SIDE) return encodeGrayPng(img.width, img.height, img.gray)
    const w = Math.max(1, Math.round(img.width * THUMB_MAX_SIDE / long))
    const h = Math.max(1, Math.round(img.height * THUMB_MAX_SIDE / long))
    return encodeGrayPng(w, h, resizeGray(img, w, h))
  } catch { return null }
}

/**
 * 寵物要不要主動開口：`groups` 是現在有幾組，`newGroups` 是**這次新出現、還沒彈過**的幾組。
 *
 * 「彈過」記在 meta 的 burst_asked（組 id，留最新 BURST_ASKED_KEEP 組）。組 id 是
 * 「留下的那張 ＋ 成員」算出來的，所以**成員變了就是新的一組**，會再彈一次；
 * 一模一樣的一組不會每次掃描都來煩人（預想表第 44 列）。
 *
 * **會寫 meta 的讀取端點**：問過就算問過，不然使用者沒理它、下一次輪詢又彈一次。
 * 寫不進去（資料庫忙、唯讀）不算錯 —— 最壞是多問一次。
 */
export function burstAsk(db: DatabaseSync, scope: string[] | CleanupScope): { groups: number; newGroups: number } {
  const ids = burstGroupsView(db, scope, { models: false }).map(g => g.id)
  let asked: string[] = []
  const raw = safe(() => getMeta(db, BURST_ASKED_KEY), null)
  if (raw) {
    try {
      const v = JSON.parse(raw)
      if (Array.isArray(v)) asked = v.filter((x: unknown): x is string => typeof x === 'string')
    } catch { /* 壞掉的舊值當成沒問過 */ }
  }
  const seen = new Set(asked)
  const fresh = ids.filter(id => !seen.has(id))
  if (fresh.length || asked.length > BURST_ASKED_KEEP) {
    const next = [...asked, ...fresh].slice(-BURST_ASKED_KEEP)
    safe(() => setMeta(db, BURST_ASKED_KEY, JSON.stringify(next)), undefined)
  }
  return { groups: ids.length, newGroups: fresh.length }
}

// ── 看得到檔案內容（P6）──────────────────────────────────────
//
// 使用者的話：「建議刪除的檔要能點進去看內容，不然我不記得那個檔存了什麼。」
//
// **這是第一條把檔案內容送到瀏覽器的路**，所以兩條不變量刻在這一段裡：
//   1. **不新增任何「照路徑讀檔」的介面。** 內容只來自兩份**已經存在**的資料 ——
//      `file_texts.text`（掃描時抽好的，最多 4000 字）與 `/cleanup/thumb/:itemId`（P0 的縮圖）。
//      這一段一行 `readFileSync`／`openSync` 都沒有，端點收的也只有 itemId，不收路徑。
//   2. **看得到的範圍就是面板本來列得出來的那些**，判斷只有 panelReason 一支，
//      預覽與縮圖共用（見那一支的檔頭）。不在範圍內一律 404，訊息跟「不存在」一模一樣。

/**
 * 預覽最多給幾個字（以 code point 計）。
 * `file_texts` 本來就只留 4000 個字（read-text.ts 的 STORE_MAX_CHARS）；面板一次看得完的比那更少，
 * 截斷的時候要講「還有更多」，不可以安靜地少給。
 */
export const PREVIEW_MAX_CHARS = 2000

/**
 * 檔案內容是**不可信的輸入**（任何人都能讓你下載一個檔）。控制字元與方向字元換成「·」——
 * 跟檔名的 UNSAFE_DISPLAY 同一組字元，**只留下換行與 tab**：內容本來就有行，
 * 把換行也換掉的話一份講義會擠成一長條，使用者根本認不出那是什麼。
 *
 * `\r\n` 與單獨的 `\r` 先收成 `\n`：不收的話 Windows 上存的檔每一行尾巴都會多一個「·」。
 * 換行留著是安全的 —— 這段字只進 `textContent`（不是 innerHTML），而且它自己一個框，
 * 不會跟面板講的話混在一起（結果框那種「偽造一行」的招數在這裡沒有東西可以偽造）。
 */
export function safePreviewText(raw: string): string {
  let out = ''
  for (const ch of String(raw ?? '').replace(/\r\n?/g, '\n')) {
    if (ch === '\n' || ch === '\t') { out += ch; continue }
    const c = ch.codePointAt(0) ?? 0
    const bad = c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x61c
      || (c >= 0x200e && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)
    out += bad ? '·' : ch
  }
  return out
}

/** 前 n 個 code point（不會切在代理對中間），順便說有沒有切到。 */
function headChars(s: string, n: number): { text: string; cut: boolean } {
  const cps = [...s]
  if (cps.length <= n) return { text: s, cut: false }
  return { text: cps.slice(0, n).join(''), cut: true }
}

/**
 * 預覽與縮圖要的範圍。`CleanupScope` 再加兩個可選的：
 * - `quarantine`：改名／歸檔那兩區判斷「這個檔是不是在隔離區裡」要用（跟它們的 route 同一個值）
 * - `filed`：「整理好的」資料夾。沒設定的話面板本來就沒有歸檔建議那一區，這裡也不去查
 */
export type PanelScope = CleanupScope & {
  quarantine?: string
  filed?: string | null
}

const panelScopeOf = (s: string[] | PanelScope): PanelScope => Array.isArray(s) ? { roots: s } : s

/**
 * 這個 itemId **面板看得到嗎**？看得到回「它為什麼會出現在面板上」那一句，看不到回 `null`。
 *
 * **預覽（`GET /cleanup/preview/:itemId`）與縮圖（`GET /cleanup/thumb/:itemId`）共用這一支，
 * 不准有第二份。** 兩邊的可見範圍一旦分岔，比較寬的那一條就變成「任意檔案的讀取端點」——
 * 而這正是 P6 最大的風險。縮圖以前只認「還在某一組連拍裡」，範圍比面板窄；
 * 現在兩邊都問這一支，寬窄永遠一致。
 *
 * 範圍＝面板本來就列得出來的那些：
 *   1. 清理候選（`collect` 的 rows —— 跟 `/cleanup/candidates` 同一份篩選）
 *   2. 需要你查看（`collect` 的 needsHuman）
 *   3. 連拍組：留下的那張與成員
 *   4. 隔離區裡的（「復原最近動作」列得出來的）—— 使用者正要決定要不要放回來
 *   5. 改名建議（P3）
 *   6. 歸檔建議（P4；沒設定 `filed` 就沒有這一區，也不查）
 *
 * **由便宜排到貴，第一個命中就回**：面板一打開就會打好幾次縮圖，不可以每一次都把
 * 改名與歸檔的建議整份算一遍。任何一段查詢炸掉都當成「這一段沒有命中」（safe），
 * 不可以讓一張讀不到的縮圖變成 500。
 */
export function panelReason(db: DatabaseSync, scope: string[] | PanelScope, itemId: string): string | null {
  // id 是呼叫端給的字串。太長的、空的直接回絕 —— 不用拿它去查任何一張表
  if (typeof itemId !== 'string' || !itemId || itemId.length > 200) return null
  const s = panelScopeOf(scope)
  const listed = safe(() => collect(db, s), { rows: [], needsHuman: [] } as Collected)
  for (const g of listed.rows) {
    if (g.item.id !== itemId) continue
    // 信心最高的那一條理由就是清單上印的那一句
    return safeWhy(g.cands[0]?.reason) ?? 'It is on the cleanup list.'
  }
  for (const n of listed.needsHuman) if (n.item.id === itemId) return n.why
  for (const g of safe(() => burstGroupsView(db, s, { models: false }), [] as BurstGroupView[])) {
    if (g.keep.itemId === itemId) return 'The one being kept from a burst of screenshots.'
    if (g.members.some(m => m.itemId === itemId)) return 'Much like the other screenshots in its burst, so it is suggested for cleanup.'
  }
  for (const q of safe(() => quarantineItems(db), [] as { itemId: string }[])) {
    if (q.itemId === itemId) return 'Already moved to quarantine, and still possible to put back.'
  }
  const moveScope = { roots: s.roots, quarantine: s.quarantine }
  for (const r of safe(() => renameSuggestions(db, moveScope).items, [])) {
    if (r.itemId === itemId) return 'The model suggests a different name; not renamed yet.'
  }
  if (s.filed) {
    for (const f of safe(() => filingSuggestions(db, { ...moveScope, filed: s.filed as string }).items, [])) {
      if (f.itemId === itemId) return 'The model suggests filing it under a course folder; not moved yet.'
    }
  }
  return null
}

/**
 * 一個檔的預覽。**回應裡沒有路徑**（只有檔名、副檔名、大小、時間），
 * 面板看不到的檔回 null（呼叫端回 404，訊息不分「不存在」與「不給看」）。
 */
export type PreviewView = {
  name: string
  ext: string
  bytes: number
  mtime: string
  /** `text` ＝ 抽到文字；`image` ＝ 有縮圖；`none` ＝ 兩者都沒有（只給後設資料） */
  kind: 'text' | 'image' | 'none'
  /** 洗過、最多 PREVIEW_MAX_CHARS 個字；沒有內容是 null */
  text: string | null
  /** 還有更多沒顯示（這一次截斷的，或當初存進 file_texts 時就截斷過的） */
  truncated: boolean
  /** `/cleanup/thumb/<id>` 或 null。**不是原圖**，而且那條端點一樣要 token */
  image: string | null
  /** 它為什麼會出現在面板上（panelReason 給的那一句） */
  why: string
}

type PreviewItemRow = { id: string; name: string; ext: string; bytes: number; mtime: string }

/**
 * 有沒有可以拿來當預覽圖的縮圖。
 *
 * **不去讀檔**：看的是掃描時算長相指紋留下的那一列（`cleanup_image_sigs`）——
 * 有那一列就代表掃描器真的把它解成了 PNG，`/cleanup/thumb/` 走得通。
 * 那一列跟 `file_texts` 一樣是快取：大小或 mtime 跟現在對不上就當成沒有
 * （檔換過了，舊指紋算出來的縮圖不是現在這個檔）。
 */
function hasThumb(db: DatabaseSync, item: { id: string; bytes: number; mtime: string }): boolean {
  const row = safe(() => db.prepare(
    'SELECT size, mtime FROM cleanup_image_sigs WHERE item_id=?').get(item.id) as
    { size: number; mtime: string } | undefined, undefined)
  return Boolean(row && Number(row.size) === Number(item.bytes) && row.mtime === item.mtime)
}

/**
 * 預覽一個檔。**內容只從已經抽好的那兩份來**，這一支不開任何檔案。
 *
 * - 文字：`file_texts.text`。那張表是**快取**（file-texts.ts 的檔頭），所以這裡照它的規矩
 *   核對 size 與 mtime —— 對不上代表檔案在抽完之後改過，那段字已經不是這個檔的內容了，
 *   寧可說「還沒讀到」也不可以拿舊的內容騙人。
 * - 圖：既有的縮圖端點（長邊 ≤ THUMB_MAX_SIDE 的灰階 PNG），**不送原圖**。
 * - 兩者都沒有：照樣回 200，用大小、最後修改與 `why` 讓使用者自己判斷要不要留。
 */
export function previewOf(db: DatabaseSync, scope: string[] | PanelScope, itemId: string): PreviewView | null {
  const why = panelReason(db, scope, itemId)
  if (why === null) return null
  const item = safe(() => db.prepare(
    'SELECT id, name, ext, bytes, mtime FROM file_items WHERE id=?').get(itemId) as PreviewItemRow | undefined, undefined)
  // 看得到卻查不到那一列（中間被刪掉）—— 跟看不到走同一個出口
  if (!item) return null

  const stored = safe(() => fileTextOf(db, itemId), null)
  const fresh = Boolean(stored && Number(stored.size) === Number(item.bytes) && stored.mtime === item.mtime)
  const raw = fresh && typeof stored!.text === 'string' ? safePreviewText(stored!.text) : ''
  // 空白字串（空檔、只有空白的檔）不算有內容：畫面上一個空框比「沒有內容」更讓人困惑
  const cut = /\S/.test(raw) ? headChars(raw, PREVIEW_MAX_CHARS) : null
  const image = hasThumb(db, item) ? thumbUrl(item.id) : null
  return {
    name: item.name,
    ext: item.ext,
    bytes: Number(item.bytes),
    mtime: item.mtime,
    kind: cut ? 'text' : image ? 'image' : 'none',
    text: cut ? cut.text : null,
    // 當初存進 file_texts 的時候就截斷過的（原檔超過 4000 字）也要講
    truncated: Boolean(cut && (cut.cut || (fresh && stored!.truncated === 1))),
    image,
    why,
  }
}

/** 看不到與不存在**講同一句話**：不讓呼叫端從訊息或狀態碼問出「這個 id 存不存在」。 */
const PREVIEW_NOT_FOUND = 'There is no such file to look at.'

export type RouteCtx = {
  db: DatabaseSync
  roots: string[] | (() => string[])
  /**
   * 復原（放回原位）用的範圍（第二輪 R2-4）：清理範圍 ∪ 截圖的監看資料夾。沒給就只用 roots。
   * **只有 undo 用它**；apply、清空維持只用 roots（放回原位不會擴大清理範圍）。
   * 每一個先過 checkedPath，不存在、含捷徑的略過 —— 跟 cli.mjs 的 undoRoots 同一個規則。
   */
  restoreRoots?: string[] | (() => string[])
  /** 截圖資料夾（config 的 cleanup.screenshotsDir）：清單、徽章、預設清理、建計畫在這底下只收截圖類。 */
  screenshotsDir?: string | null | (() => string | null)
  quarantine: string
  /**
   * 「整理好的」資料夾（config 的 `filed`）。**只有歸檔（P4）那三條用得到**；
   * 沒給的話那三條回 500 BAD_CONFIG（不猜一個位置去搬使用者的檔）。
   */
  filed?: string | (() => string)
  /** 這兩個只有會動檔案的 route 才需要。跟 roots 一樣可以是 thunk（延後讀設定）。 */
  maxBytes?: number | (() => number)
  readonly?: boolean | (() => boolean)
  url: URL
  method: string
  body: any
  /** 第三個參數是額外的 response header（例如 BUSY 的 Retry-After、405 的 Allow）。 */
  send: (code: number, payload: unknown, headers?: Record<string, string>) => void
  /**
   * 送二進位（現在只有連拍縮圖的灰階 PNG）。**沒給的呼叫端就沒有縮圖**：
   * 那一條路徑會回 501，而不是假裝成功或把圖塞進 JSON 裡。server.ts 一定要給。
   */
  sendBytes?: (code: number, contentType: string, body: Uint8Array, headers?: Record<string, string>) => void
  /**
   * 手動掃一次。由呼叫端注入，這一支不直接相依 scanner。
   * `onProblem` 要傳給 scanDownloads：保險絲、讀不到的檔、打不開的資料夾都從這裡報，
   * 回應的 `problems` 就是收到的這些（不傳的話那些話走 HTTP 永遠看不到）。
   */
  scan: (onProblem: (msg: string) => void) => {
    scanned: number; candidates: number; skipped: number; errors: number; truncated: boolean
    /** 還有幾張圖的長相指紋沒算（一批有上限，見 scanner 的 MAX_IMAGE_BATCH）。 */
    imagesPending?: number
    /** 還有幾個文件檔沒讀內容（一批有上限，見 scanner 的 MAX_TEXT_BATCH）。 */
    textsPending?: number
  }
}

/** POST /cleanup/scan 回應裡 problems 最多幾條。 */
const MAX_SCAN_PROBLEMS = 50

/**
 * 掃描回報的問題，整理成要回給 UI 的樣子：**人話、不帶完整路徑、控制字元與方向字元換成「·」**。
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
    // 檔名是不可信的輸入：換行可以偽造一行字、U+202E 可以把副檔名倒過來（第二輪 R2-11，跟 shown 同一組字元）
    return out.replace(UNSAFE_DISPLAY, '·').slice(0, 300)
  }))]
  if (clean.length <= MAX_SCAN_PROBLEMS) return clean
  const shown = clean.slice(0, MAX_SCAN_PROBLEMS - 1)
  return [...shown, `${clean.length - shown.length} more are not listed.`]
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
  // 歸檔（P4）：`filed` 在另一顆碟，rename 回 EXDEV。**不硬搬**（複製＋刪除等於刪檔），
  // 所以它只出現在逐項結果裡，那一項失敗、其他項照做。
  CROSS_DEVICE: 500,
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
 * 復原用的 ExecOptions：roots 換成放回的範圍（第二輪 R2-4）。
 *
 * 以前面板的復原只用清理範圍，CLI 的用清理範圍 ∪ watch（第三波 C4 只修了 CLI）：RC15 之前被舊版
 * 從桌面搬走的檔，面板永遠放不回去、還叫使用者「再試一次」，滿七天一清空就沒了（稽核 C-e1、A-exp12）。
 * **每一個先過 checkedPath，過不了就略過**（不存在、不是資料夾、路徑含捷徑）—— 跟 cli.mjs 的 undoRoots 一樣。
 *
 * **全部都被略過的話，退回清理範圍**，交給執行層逐項回報（第二階段）。以前給空的範圍，執行層的
 * checkOptions 丟 500 BAD_CONFIG「請設定清理資料夾與檔案大小上限」—— 外接碟暫時拔掉、Downloads 改了名，
 * 使用者被叫去改設定，lastError 也記成這句。退回之後逐項是「檔案或資料夾不見了」，插回來再按一次就放得回。
 * 清理範圍本身是空的（真的沒設定）照樣是 BAD_CONFIG。
 */
function restoreOptions(ctx: RouteCtx): ExecOptions {
  const base = execOptions(ctx)
  const wanted = ctx.restoreRoots === undefined ? base.roots
    : typeof ctx.restoreRoots === 'function' ? ctx.restoreRoots() : ctx.restoreRoots
  const roots: string[] = []
  for (const r of wanted) {
    if (roots.includes(r)) continue
    try { checkedPath(r, true); roots.push(r) } catch { /* 放不回那裡，略過 */ }
  }
  return { ...base, roots: roots.length ? roots : base.roots }
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
    // 記下是哪一種動作（R2-10）：要同一種動作之後成功過，寵物才不擔心
    recordCleanupError(ctx.db, e, safe(() => actionOf(ctx), undefined))
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
  [/^\/cleanup\/bursts$/, ['GET']],
  [/^\/cleanup\/thumb\/[^/]+$/, ['GET']],
  [/^\/cleanup\/preview\/[^/]+$/, ['GET']],
  [/^\/cleanup\/quarantine$/, ['GET']],
  [/^\/cleanup\/quarantine\/empty$/, ['POST']],
  [/^\/pet\/state$/, ['GET']],
]

/**
 * body 一定要是物件。**看不懂的 body 不可以被當成「什麼都沒帶」**（RC6）——
 * 「什麼都沒帶」在建計畫那條的意思是「清單上打 ✔ 的全部」。
 * undefined（呼叫端根本沒給）才算沒帶。
 *
 * **不認得的 key 也是看不懂**（第二輪 R2-7）：`{ candidateID: [a] }`（拼錯一個字母）以前等於沒帶 ——
 * 只勾一個檔，清掉的是清單上打 ✔ 的全部；apply 的 `{ skippedIDs }` 等於一個都不略過（稽核 B-r2）。
 * `allowed` 是這條路徑認得的 key，面板、CLI、產生器送的都在裡面。
 */
function bodyOf(ctx: RouteCtx, allowed: readonly string[]): Record<string, any> {
  const b = ctx.body
  if (b === undefined) return {}
  if (b === null || typeof b !== 'object' || Array.isArray(b)) throw new CleanupError('BAD_BODY', 'Could not make sense of the body.')
  const unknown = Object.keys(b).filter(k => !allowed.includes(k))
  if (unknown.length) {
    // key 是呼叫端給的字串：控制字元換掉、只講前幾個
    const shown = unknown.slice(0, 3).map(k => k.replace(UNSAFE_DISPLAY, '·').slice(0, 40)).join(', ')
    throw new CleanupError('BAD_BODY', `Could not make sense of the body: unknown field ${shown}.`
      + (allowed.length ? ` This route only takes ${allowed.join(', ')}.` : ' This route takes no fields.'))
  }
  return b
}

/** 各路徑認得的 body key（R2-7）。改之前先看面板（core/assets）、CLI、tools/gen-api-examples.mjs 送了什麼。 */
const BODY_KEYS = {
  createPlan: ['candidateIds', 'requestId'],
  apply: ['skippedIds'],
  none: [],
  empty: ['token', 'confirmed'],
} as const

const rootsOf = (ctx: RouteCtx) => typeof ctx.roots === 'function' ? ctx.roots() : ctx.roots
const shotsOf = (ctx: RouteCtx) =>
  typeof ctx.screenshotsDir === 'function' ? ctx.screenshotsDir() : (ctx.screenshotsDir ?? null)
const filedOf = (ctx: RouteCtx) => typeof ctx.filed === 'function' ? ctx.filed() : (ctx.filed ?? null)
/**
 * 這一次請求的範圍。**帶上 quarantine 與 filed**（P6）：預覽與縮圖的可見範圍要跟面板一樣寬，
 * 而面板的改名／歸檔那兩區看得到什麼，就是靠這兩個值算的。其他路徑不讀這兩個欄位，行為不變。
 */
const scopeOfCtx = (ctx: RouteCtx): PanelScope => ({
  roots: rootsOf(ctx), screenshotsDir: shotsOf(ctx), quarantine: ctx.quarantine, filed: filedOf(ctx),
})

/**
 * 這個請求是哪一種動作（記錯的時候用，R2-10）。建計畫算「套用」—— 那是清理的第一步。
 * 其他路徑（GET、dismiss、release、寵物）的意外沒有種類：任何一次成功都清得掉。
 */
function actionOf(ctx: RouteCtx): ActionKind | undefined {
  if (ctx.method !== 'POST') return undefined
  const p = ctx.url.pathname
  if (p === '/cleanup/scan') return 'scan'
  if (p === '/cleanup/plans') return 'apply'
  if (p === '/cleanup/quarantine/empty') return 'empty'
  const m = /^\/cleanup\/plans\/[^/]+\/(apply|undo)$/.exec(p)
  return m ? m[1] as ActionKind : undefined
}

function route(ctx: RouteCtx): boolean {
  const { url, method, send } = ctx
  const p = url.pathname

  const known = KNOWN.find(([re]) => re.test(p))
  if (known && !known[1].includes(method)) {
    fail(send, 405, `This route only takes ${known[1].join(', ')}.`, 'BAD_METHOD', { allow: known[1].join(', ') })
    return true
  }

  if (p === '/cleanup/candidates' && method === 'GET') {
    const raw = url.searchParams.get('limit')
    const limit = raw === null ? undefined : Number(raw)
    if (raw !== null && (!Number.isInteger(limit) || limit! < 1 || limit! > 1000)) {
      fail(send, 400, 'limit must be a whole number between 1 and 1000.', 'BAD_BODY')
      return true
    }
    send(200, listCandidates(ctx.db, { ...scopeOfCtx(ctx), limit }))
    return true
  }

  // 連拍組：畫面要的只有縮圖與外框，**沒有路徑**（見 burstGroupsView）
  if (p === '/cleanup/bursts' && method === 'GET') {
    send(200, { groups: burstGroupsView(ctx.db, scopeOfCtx(ctx)) })
    return true
  }

  // 縮圖。**只給現在還在某一組裡的 item**，其他一律 404 —— 這不是任意檔案的讀取端點。
  const thumb = /^\/cleanup\/thumb\/([^/]+)$/.exec(p)
  if (thumb && method === 'GET') {
    let itemId: string
    try { itemId = decodeURIComponent(thumb[1]) }
    catch { throw new CleanupError('BAD_BODY', 'That thumbnail id is not a valid shape.') }
    if (!ctx.sendBytes) { fail(send, 501, 'This feature is not built yet.', 'NOT_IMPLEMENTED'); return true }
    const png = burstThumbPng(ctx.db, scopeOfCtx(ctx), itemId)
    // 不在組裡、讀不到、解不開都一樣回 404：不讓呼叫端從狀態碼問出「這個 id 存不存在」
    if (!png) { fail(send, 404, 'There is no such thumbnail.', 'NOT_FOUND'); return true }
    ctx.sendBytes(200, 'image/png', png, { 'content-length': String(png.length) })
    return true
  }

  // 看內容（P6）。**只吃 itemId，不收路徑，也不開任何檔** —— 內容來自 file_texts（掃描時抽好的）
  // 與既有的縮圖端點。面板看不到的一律 404，訊息跟「不存在」一模一樣。
  const peek = /^\/cleanup\/preview\/([^/]+)$/.exec(p)
  if (peek && method === 'GET') {
    let itemId: string
    try { itemId = decodeURIComponent(peek[1]) }
    catch { throw new CleanupError('BAD_BODY', 'That file id is not a valid shape.') }
    const view = previewOf(ctx.db, scopeOfCtx(ctx), itemId)
    if (!view) { fail(send, 404, PREVIEW_NOT_FOUND, 'NOT_FOUND'); return true }
    send(200, view)
    return true
  }

  if (p === '/cleanup/scan' && method === 'POST') {
    // **這條也要過 body 白名單**（第三輪 R3-14）：它是唯一漏掉 R2-7 的寫入路徑，而 README 的說法是
    // 全面的。目前它一個欄位都不讀，所以白名單是空的 —— 之後要加參數，加進 BODY_KEYS 就好，
    // 打錯字才不會像 skippedIDs 那樣被靜靜當成「什麼都沒帶」。
    bodyOf(ctx, BODY_KEYS.none)
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
      recordCleanupError(ctx.db, e, 'scan')
      fail(send, 500, 'The scan hit an error, so it may not have finished. A scan never moves or deletes anything.', 'INTERNAL')
      return true
    }
    recordOk(ctx.db, 'scan')
    // problems：保險絲、讀不到的檔、打不開的資料夾（RC1）。人話、不帶完整路徑、控制字元換掉，沒事是空陣列。
    // 同一份存進 meta，帶 token 的 /health 看得到（R2-10）—— 面板與 doctor 以前都看不到
    const cleaned = scanProblems(problems, rootsOf(ctx))
    recordScanProblems(ctx.db, cleaned)
    send(200, { ...r, problems: cleaned })
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
    const body = bodyOf(ctx, BODY_KEYS.createPlan)
    // **唯讀模式一份都不可以建。** createPlan 不看 readonly（只有 applyPlan 看），
    // 建了再被 apply 擋下的話，那份計畫卡在 proposed、永遠佔住那些檔，
    // 之後任何人建計畫都撞 CONFLICT。CLI 那輪修過一模一樣的 bug。
    const ro = typeof ctx.readonly === 'function' ? ctx.readonly() : ctx.readonly
    if (ro) throw new CleanupError('READ_ONLY', 'Read-only mode is on: no cleanup plan is created and no file is moved.')
    const scope = scopeOfCtx(ctx)
    // **只有完全沒帶 candidateIds 才是預設**（清單上打 ✔ 的，一次最多 1000 個檔）。
    // `null` 是看不懂，不是沒帶 —— 上一版用 `??`，null 就變成「全部打 ✔ 的」（RC6）。
    let candidateIds: unknown = body.candidateIds
    let remaining = 0
    if (candidateIds === undefined) {
      const sel = defaultSelection(ctx.db, scope)
      candidateIds = sel.candidateIds
      remaining = sel.remaining
    }
    let plan
    try {
      plan = createPlanForRoots(ctx.db, scope, { candidateIds, requestId: body.requestId })
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
    catch { throw new CleanupError('BAD_BODY', 'That plan id is not a valid shape.') }
    const action = plan[2]
    // 每個回應都帶逐項結果（outcome／why）。UI 不可以自己用「勾了幾個」推算。
    if (!action) { send(200, withOutcomes(ctx.db, getPlan(ctx.db, id))); return true }
    const body = bodyOf(ctx, action === 'apply' ? BODY_KEYS.apply : BODY_KEYS.none)
    if (action === 'dismiss') { send(200, withOutcomes(ctx.db, dismissPlan(ctx.db, id))); return true }
    // 放棄還沒開始的那份：計畫作廢、候選不動（RC4／RC8 的「放棄上次那份」）
    if (action === 'release') { send(200, withOutcomes(ctx.db, releasePlan(ctx.db, id))); return true }
    // **跑過的計畫再 apply 是 no-op**（核心 R2-3：applied／partial／error 原樣回傳、一個檔都不碰）。
    // 記帳要認得出來（第三輪 R3-2b）：面板斷線後的重試、擴充套件重送、使用者點歷史列，
    // 以前每一次都走 recordOk，把一個一直壞著的套用錯標成「好了」。
    // 核心之後會在回傳裡帶 `noop`；在那之前用「呼叫前的 status」判斷 —— 那就是它原樣回傳的條件。
    const ranBefore = action === 'apply'
      && ['applied', 'partial', 'error', 'restored', 'dismissed'].includes(
        safe(() => (ctx.db.prepare('SELECT status FROM cleanup_plans WHERE id=?').get(id) as { status?: string } | undefined)?.status, undefined) ?? '')
    let r
    // 隔離區剛變了，孤兒對帳的快取不可以再用 —— **丟錯也一樣**：做到一半丟錯時已經搬了幾個
    try {
      // 套用只用清理範圍；復原用放回的範圍（清理範圍 ∪ 監看資料夾，R2-4）
      r = action === 'apply'
        ? applyPlan(ctx.db, id, { ...execOptions(ctx), skippedIds: body.skippedIds })
        : undoPlan(ctx.db, id, restoreOptions(ctx))
    } finally { invalidateQuarantineCache() }
    // 失敗原因 applyPlan 自己會存（cleanup_item_errors），這裡不必再補（RC11）。
    // 每一項都失敗記成錯、其他記成功（R2-10）；no-op 兩邊都不記（R3-2b）
    recordActionResult(ctx.db, action as 'apply' | 'undo', ranBefore ? { ...(r as object), noop: true } : r)
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
    const body = bodyOf(ctx, BODY_KEYS.empty)
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
      throw new CleanupError('BAD_BODY', 'confirmed must be true or false.')
    }
    let result
    // 清空刪了檔，孤兒對帳的快取同樣要作廢（以前沒有：清空後十秒內 /health 會報假的孤兒）
    try { result = emptyQuarantine(ctx.db, { ...execOptions(ctx), token, confirmed: body.confirmed }) }
    finally { invalidateQuarantineCache() }
    recordActionResult(ctx.db, 'empty', result)
    send(200, { phase: 'done', ...result })
    return true
  }

  if (p === '/pet/state' && method === 'GET') {
    // 這條要 token，所以拿完整版 —— 寵物要比 lastErrorAt 與 lastOkAt，瘦身版兩個都是 null
    const h = healthSnapshot(ctx.db, { ...scopeOfCtx(ctx), quarantine: ctx.quarantine, full: true })
    send(200, {
      ...petState(h, {
        proposedPlans: safe(() => (ctx.db.prepare(
          `SELECT count(*) n FROM cleanup_plans WHERE status='proposed'`).get() as { n: number }).n, 0),
        activeQuarantine: h.quarantine.items,
      }),
      // 連拍：現在有幾組、其中幾組是還沒主動彈過的。**畫面自己決定要不要開口**
      // （petState 的 state 階梯不動 —— 那是「第一個成立的贏」，插隊會蓋掉待辦與錯誤）。
      burst: safe(() => burstAsk(ctx.db, scopeOfCtx(ctx)), { groups: 0, newGroups: 0 }),
      // 「它現在在讀檔案嗎、還剩幾個」。畫面靠這個決定要不要轉圈圈 ——
      // 少了它，使用者分不出「還沒輪到」與「它根本沒在動」。
      reading: safe(() => readingState(ctx.db, rootsOf(ctx) ?? []), { running: false, pending: 0 }),
    })
    return true
  }

  // 還沒實作的（B 的範圍）要回一句人話，不是 404 —— 404 會讓 C 以為自己打錯網址。
  // **反過來列白名單。** 逐條列黑名單一定會漏（第一版漏了 apply／undo／
  // dismiss／reveal／quarantine/empty，第二版還漏 restore／empty），
  // 而漏掉的後果就是這段註解要避免的那件事。
  // 認得的路徑用錯方法在最上面就回 405 了，走到這裡的是真的不認得的路徑。
  if (p.startsWith('/cleanup/') || p.startsWith('/pet/')) {
    fail(send, 501, 'This feature is not built yet.', 'NOT_IMPLEMENTED')
    return true
  }

  return false
}
