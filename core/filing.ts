/**
 * 把同一堂課的檔歸成結構化資料夾（P4）—— **一定要人按過，而且搬得回來**。
 *
 * 上游：P2 的模型給了 `course`／`topic`／`kind`／`confidence`／`evidence`（core/model-store.ts）；
 * P3 已經有一套「使用者確認 → 動檔案 → 收得了尾 → 復原得回去」的骨架（core/rename.ts）。
 * 這一支照同一套做**搬家**，而且**共用 P3 那幾支**（cleanName、freeName、namesTaken、followFile、
 * checkFile、whyNotTouchable）—— 不准有第二份判斷。
 *
 * ── 為什麼這支比改名更危險 ──────────────────────────────────
 *   搬家比改名更容易讓人找不到檔：改名還在同一個資料夾，搬家是換地方。錯了就是「我的檔不見了」。
 *   所以 `filings` 那張表是唯一一份「它本來住在哪」，先寫 started 再動檔案，搬完才寫 done。
 *
 * ── 不變量（改這支之前先讀一次）────────────────────────────
 *   1. 沒有任何自動歸檔的路徑。呼叫端一定要指名 itemId。
 *   2. 每一次搬家都有紀錄，undo 搬回原本的資料夾；當機之後看檔案實際在哪收尾。
 *   3. **只搬到 `<filed>/課程/<課名>/<類型>/`**。整條路徑過 checkedPath（拒捷徑），
 *      最後還要再確認一次算出來的資料夾真的在 filed 底下 —— 不可以往上跳。
 *   4. **不覆蓋**：目標已經有同名檔就加 -2⋯-99（跟 P3 同一支 freeName）。
 *   5. 擋的檔跟 P3 一樣（正在下載、在還沒套用的清理計畫裡、隔離區、受保護的檔、捷徑、硬鏈結），
 *      **但不看 naming** —— 已經有名字的檔照樣可以歸檔（`作業系統_第5章.txt` 就是）。
 *   6. 信心「低」不提議；`course` 是「看不出來」不提議。
 *   7. **跨磁碟不硬搬**：rename 回 EXDEV 就這一項失敗。複製＋刪除會變成「刪檔」，這個專案只搬不刪。
 *   8. 回給呼叫端的東西**沒有絕對路徑**：只給相對於 filed 的那一段（`課程/作業系統/講義`）。
 *   9. **這一期只往 filed 裡面搬**：已經在 filed 底下的檔不提議、不動。
 */
import { lstatSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { under } from './guard.ts'
import { CleanupError, cleanupProblem, transaction, withCleanupLock } from './cleanup-journal.ts'
import { checkedPath } from './cleanup-exec.ts'
import { VIEW_KINDS } from './model.ts'
import { modelViewForItem, opinionOf, type ModelOpinion } from './model-store.ts'
import { cleanGroupName, distinctPhrases, phraseKey } from './grouping.ts'
import {
  checkFile, cleanCourse, confidentEnough, followFile, freeName, itemById, namesTaken, originalExt,
  underSomeRoot, whyNotTouchable, COURSE_MAX_CODEPOINTS, RENAMABLE_STATUSES, SUFFIX_MAX, UNKNOWN_COURSE,
  type ItemRow, type MoveWords, type RenameScope,
} from './rename.ts'
import {
  courseKey, filingSummary, forgetRejected, learnCourse, learnKind, loadLearned, rememberRejected,
  type Learned,
} from './learn.ts'

/**
 * 課名的**比對鍵**（P5 之後住在 core/learn.ts —— 改名那條線也要用同一個折法，
 * 而 filing.ts 匯入 rename.ts，放這裡會繞回來）。這裡 re-export，呼叫端不用改。
 */
export { courseKey } from './learn.ts'

/** 一次最多搬幾個。超過的不做，呼叫端要講「還有幾個」（預期行為 10）。跟改名一樣是 100。 */
export const FILING_BATCH_MAX = 100
/** 課名的洗法與上限住在 core/rename.ts（cleanName 就在那裡），這裡 re-export，呼叫端不用改。 */
export { cleanCourse, COURSE_MAX_CODEPOINTS, UNKNOWN_COURSE }
/** 歸檔樹的第一層。`<filed>/課程/<課名>/<類型>/` */
export const COURSES_DIR = 'Courses'

/**
 * 「這是什麼文件」→ 資料夾名。沒對到回空字串（＝這一輪不提議這個檔）。
 *
 * 對照表是 `file_group_map`，由分群那一步寫進去的（見 core/grouping.ts）。
 * **沒對到就不提議**，不隨便塞一個 —— 塞錯地方比不提議更糟。
 *
 * 洗一次再用（不變量 2）：存進去時過 cleanGroupName，拿出來再過一次同一支 ——
 * 資料庫可能被手改過，而這個值會變成磁碟上的資料夾名。
 * 而且**不可以叫 Courses**，那會跟課程那棵樹撞在一起。
 */
export function groupFolderFor(db: DatabaseSync, whatItIs: unknown): string {
  const key = phraseKey(whatItIs)
  if (!key) return ''
  let row: { folder?: unknown } | undefined
  try {
    row = db.prepare('SELECT folder FROM file_group_map WHERE phrase=?').get(key) as typeof row
  } catch { return '' }
  const folder = cleanGroupName(row?.folder)
  if (!folder) return ''
  if (folder.toLowerCase() === COURSES_DIR.toLowerCase()) return ''
  return folder
}

/** `kind` 不在固定選項裡時用哪一個資料夾（P2 的 VIEW_KINDS 最後一個就是它）。 */
export const OTHER_KIND = 'Other'

/** 訊息裡的詞（跟 P3 共用同一套判斷，只有詞不一樣）。 */
const FILE_WORDS: MoveWords = { act: 'be filed', doIt: 'file this file', it: 'it is left where it is' }

// ── 課名與類型 ──────────────────────────────────────────────


/** 類型資料夾。**只收 P2 的固定選項**，別的一律進「其他」—— 不讓模型自己發明資料夾名。 */
export function kindFolder(kind: unknown): string {
  const k = String(kind ?? '').trim()
  return VIEW_KINDS.includes(k) ? k : OTHER_KIND
}

/**
 * `<filed>/課程/<課名>/<類型>` 裡**畫面看得到的那一段**（不變量 8）。
 *
 * 從真路徑的最後兩層取名字，前面補上固定的第一層 —— 不管 filed 放在哪、有幾層深，
 * 洩漏出去的都只有課名與類型這兩個資料夾名字。
 */
export function folderOf(toDir: string): string {
  const parts = String(toDir ?? '').split(/[\\/]+/).filter(Boolean)
  if (parts.length < 2) return ''
  return [COURSES_DIR, parts[parts.length - 2], parts[parts.length - 1]].join('/')
}

/**
 * `<filed>/課程/` 底下現在有哪些課（比對鍵 → 真的資料夾名字）。
 *
 * 讀不到（還沒建過）就是空的 —— 那是正常狀態，不是錯。
 * **先排序再收**：兩個資料夾折起來一樣時（`OS` 與 `ＯＳ`），每次都挑同一個。
 */
function existingCourses(coursesDir: string): Map<string, string> {
  const out = new Map<string, string>()
  let entries: string[] = []
  try { entries = readdirSync(coursesDir).sort() } catch { return out }
  for (const e of entries) {
    const k = courseKey(e)
    if (k && !out.has(k)) out.set(k, e)
  }
  return out
}

// ── 誰可以被提議歸檔 ────────────────────────────────────────

export type FilingScope = RenameScope & {
  /** 「整理好的」資料夾（設定檔的 `filed`）。**只搬到這底下。** */
  filed: string
  /**
   * 復原時「原本的資料夾不見了可以建回來」的範圍（預想 Step 1）。沒給就用 roots。
   * 資料夾**還在**的話不看這個 —— 那是它原本的家，放回原位不算擴大範圍。
   */
  restoreRoots?: string[]
}

export type FilingSuggestion = {
  itemId: string
  /** 現在叫什麼（只有檔名，沒有資料夾） */
  name: string
  /** 會用的課名寫法（學到偏好之後就是**你的**寫法，按下去就是搬到這個資料夾） */
  course: string
  /**
   * **模型自己說的課名**（洗過）。跟 `course` 不一樣時，`course` 是你上次改的寫法。
   *
   * 為什麼要分開回：畫面上寫著「模型認為：⋯⋯」。只回一個欄位的話，
   * 學到 `作業系統`→`OS` 之後畫面會變成「模型認為：OS」—— 那是**把使用者自己的話說成模型講的**。
   */
  modelCourse: string
  kind: string
  topic: string
  /**
   * 有值 ＝ 這個檔是靠「這是什麼文件」歸進來的，不是靠課名（P7）。
   * 畫面要講得不一樣：課程那條講「課程／類型」，這條講「這是一份 resume」。
   */
  whatItIs?: string
  confidence: string
  evidence: string
  /** true ＝ demo 預先塞的示範答案，畫面要標示 */
  seeded: boolean
  /** 會搬去哪，**相對於 filed**（例如 `課程/作業系統/講義`）。沒有絕對路徑。 */
  toFolder: string
  /** true ＝ 這一項套用了你以前改過的寫法（P5）。畫面要標「照你上次改的」。 */
  learned: boolean
  /** true ＝ 你上次把這個建議退回去了（P5）。照樣列，但**不預設勾**。 */
  rejectedBefore: boolean
  /**
   * 學到新寫法之前，這堂課的資料夾叫什麼（磁碟上還在的那一個）。沒有就是空字串。
   *
   * **既有的資料夾不會被搬動或改名**（只搬不刪的延伸，預期行為 12）：新的檔進新資料夾，
   * 舊的留在原地。清單上要講這一句，不然使用者會以為東西不見了。
   */
  alsoKnownAs: string
}

/** 這個檔現在有沒有一筆還沒收尾的歸檔（started）。有的話先不提議，等收尾。 */
function midFiling(db: DatabaseSync, itemId: string): boolean {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM filings WHERE item_id=? AND status='started' LIMIT 1`).get(itemId))
  } catch { return true }
}

/**
 * 這個檔現在可不可以被歸檔。可以回 null，不可以回一句**人話**（不帶路徑）。
 *
 * 跟改名共用 whyNotTouchable（同一批檔、同一個順序），**但不看 naming**：
 * 已經有名字的檔照樣要歸類（`作業系統_第5章_行程排程.txt` 正是預期行為 1 的那一個）。
 * 多一條自己的：**已經在 filed 底下的不動**（這一期只往裡面搬）。
 */
export function whyNotFilable(db: DatabaseSync, item: ItemRow, scope: FilingScope): string | null {
  const filed = scope.filed ? resolve(scope.filed) : ''
  if (filed && (item.path === filed || under(filed, item.path))) {
    return 'This file is already in the filed folder, and this version only moves things in.'
  }
  return whyNotTouchable(db, item, scope, FILE_WORDS, midFiling)
}

/**
 * 有模型看法、而且現在還活著的檔。**歸檔建議與分類（P7）用同一份名單** ——
 * 兩邊看到的檔不一樣的話，分類分出來的資料夾會對不上真的要搬的檔。
 *
 * **先在 SQL 裡縮小**：沒有任何模型看法的檔不可能被建議，一列一列去問 modelViewForItem
 * （而且對不到時還會再打一次 sha256 的 JOIN）會讓成本跟「總檔數」成正比 —— 兩萬個檔就是 0.8 秒。
 * 下面這個條件是 modelViewForItem 的**超集合**（它自己還會再看新不新鮮），
 * 兩條路各自有索引：ix_model_views_item、ix_file_items_sha。
 */
function filableRows(db: DatabaseSync): ItemRow[] {
  try {
    return db.prepare(
      `SELECT id, path, name, status, error, naming, mtime FROM file_items f
        WHERE f.error IS NULL AND f.status IN (${RENAMABLE_STATUSES.map(() => '?').join(',')})
          AND (EXISTS (SELECT 1 FROM model_views v WHERE v.item_id = f.id)
               OR (f.sha256 IS NOT NULL AND EXISTS (
                     SELECT 1 FROM model_views v JOIN file_items j ON j.id = v.item_id
                      WHERE j.sha256 = f.sha256)))
        ORDER BY f.last_seen_at DESC, f.id`
    ).all(...RENAMABLE_STATUSES) as ItemRow[]
  } catch { return [] }
}

/**
 * 建議清單。**只列**：模型看得出是哪一堂課（信心不是低、course 不是「看不出來」）、
 * 而且現在真的可以動的檔。
 *
 * `toFolder` 用**既有資料夾的寫法**（`<filed>/課程/` 底下已經有 `OS` 的話，`ＯＳ` 也顯示成 `OS`）——
 * 畫面上講的位置要跟按下去之後真的落地的位置一樣。
 */
export function filingSuggestions(db: DatabaseSync, scope: FilingScope, opts: { limit?: number } = {}): {
  items: FilingSuggestion[]
} {
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 500))
  const rows = filableRows(db)

  // 一次就好：整份清單共用同一張「已經有哪些課」的表（不碰磁碟的話會建出第二個同名資料夾）
  const known = existingCourses(join(resolve(scope.filed ?? '.'), COURSES_DIR))
  // 學到的偏好也是一次就好（整張表有上限，全部載進來是固定成本；一列一列去查會變成 N 次查詢）
  const learned = loadLearned(db)
  const items: FilingSuggestion[] = []
  for (const row of rows) {
    if (items.length >= limit) break
    let opinion: ModelOpinion | null = null
    try { opinion = opinionOf(modelViewForItem(db, row.id)) } catch { opinion = null }
    if (!opinion) continue
    if (!confidentEnough(opinion.confidence)) continue
    const course = cleanCourse(opinion.course)
    if (whyNotFilable(db, row, scope)) continue

    // ── 課名說不出來的走另一條路（2026-09-21，P7）────────────────────
    //
    // 以前這裡是 `if (!course) continue` —— 一行就把所有不屬於任何課程的檔放棄。
    // 而使用者的 Downloads 大半是 CV、自傳、推薦書、獎學金表單、法規、論文、規格書：
    // 實機 202 筆答案裡 186 筆 course=Unknown，也就是**這個工具對它實際看到的
    // 大部分檔案都束手無策**，而原因不是看不懂。
    //
    // 現在：course 說得出來 → Courses/<課名>/<kind>（完全不變，learned 偏好照舊）；
    // 說不出來 → <分類>/，分類來自 file_group_map（從 whatItIs 分群長出來的）。
    // **兩條路互斥**，一個檔只會走一條，不會有兩個互相矛盾的目的地。
    if (!course) {
      const folder = groupFolderFor(db, opinion.whatItIs)
      // 還沒分群、或這個說法沒對到任何資料夾 → 這個檔這一輪就是沒有去處。
      // **不隨便塞一個** —— 塞錯地方比不提議更糟。
      if (!folder) continue
      items.push({
        itemId: row.id,
        name: row.name,
        course: '',
        modelCourse: '',
        kind: kindFolder(opinion.kind),
        topic: opinion.subject || opinion.topic,
        confidence: opinion.confidence,
        evidence: opinion.evidence,
        seeded: opinion.seeded,
        toFolder: folder,
        learned: false,
        rejectedBefore: learned.rejected(row.id, filingSummary(folder)),
        alsoKnownAs: '',
        /** 這個檔是靠「這是什麼文件」歸進來的，不是靠課名。畫面要講得不一樣。 */
        whatItIs: opinion.whatItIs,
      })
      continue
    }

    const offer = offeredFiling(learned, opinion.course, opinion.kind, known)
    const toFolder = [COURSES_DIR, offer.course, offer.kind].join('/')
    items.push({
      itemId: row.id,
      name: row.name,
      course: offer.course,
      modelCourse: course,
      kind: offer.kind,
      topic: opinion.topic,
      confidence: opinion.confidence,
      evidence: opinion.evidence,
      seeded: opinion.seeded,
      toFolder,
      learned: offer.learnedCourse || offer.learnedKind,
      rejectedBefore: learned.rejected(row.id, filingSummary(toFolder)),
      alsoKnownAs: offer.alsoKnownAs,
    })
  }
  return { items }
}

/** 「我們現在會建議什麼」。`learnedCourse`／`learnedKind` ＝ 這一段是學來的，不是模型講的。 */
export type FilingOffer = {
  course: string; kind: string; learnedCourse: boolean; learnedKind: boolean; alsoKnownAs: string
}

/**
 * 模型的看法 ＋ 學到的偏好 → **這一刻我們建議的課名與類型**。
 *
 * **列清單與真的搬共用這一支**（不准有第二份判斷）。為什麼非共用不可：
 * 面板與 CLI 送回來的 `course` 就是清單上顯示的那一個，真的搬那邊要拿它跟「我們建議的」比，
 * 才知道使用者到底有沒有改。兩邊算出來不一樣的話，**照單全收會被當成使用者改過**，
 * 計數就被灌水了（預想 Step 1 第一格）。
 *
 * 學到的值**用之前再洗一次**（不變量 2）：cleanCourse／kindFolder 跟存進去時是同一支。
 * 有人直接改資料庫塞了 `../../etc`，洗完是 `etc`，跳不出 filed 那棵樹；洗成空的就當沒學過。
 */
export function offeredFiling(
  learned: Learned, modelCourse: unknown, modelKind: unknown, known?: Map<string, string>,
): FilingOffer {
  const model = cleanCourse(modelCourse)
  const modelKind0 = kindFolder(modelKind)
  // **模型自己講不出是哪一堂課的話，學到的偏好不可以替它頂上**（稽核 2026-09-20）。
  // 清單那邊的門檻是 cleanCourse(opinion.course) 非空，這裡少一道的話會變成：
  // 清單不列（因為看不出來），直接打 POST /file/apply 卻搬得成 —— 兩邊判斷不一樣。
  // 偏好是「這一堂課你怎麼寫」，沒有那一堂課就沒有東西可以套。
  if (!model) {
    return { course: '', kind: modelKind0, learnedCourse: false, learnedKind: false, alsoKnownAs: '' }
  }
  const pref = cleanCourse(learned.course(modelCourse))
  const learnedCourse = Boolean(pref) && courseKey(pref) !== courseKey(model)
  const want = learnedCourse ? pref : model
  // 既有資料夾的寫法蓋過去：畫面上講的位置要跟按下去之後真的落地的位置一樣（targetDir 也這樣挑）
  const course = known?.get(courseKey(want)) ?? want
  const modelK = modelKind0
  const rawK = learned.kind(modelCourse, modelK)
  const prefK = rawK ? kindFolder(rawK) : ''
  const learnedKind = Boolean(prefK) && prefK !== modelK
  // 舊的資料夾**不搬、不改名**，只在清單上講一句（預期行為 12）
  const old = learnedCourse ? (known?.get(courseKey(model)) ?? '') : ''
  return {
    course,
    kind: learnedKind ? prefK : modelK,
    learnedCourse,
    learnedKind,
    alsoKnownAs: old && courseKey(old) !== courseKey(course) ? old : '',
  }
}

// ── 真的搬 ──────────────────────────────────────────────────

export type FilingRow = {
  id: string; item_id: string; name: string; from_dir: string; to_dir: string; to_name: string
  course: string; kind: string; topic: string | null
  status: 'started' | 'done' | 'reverted' | 'failed'
  error: string | null; at: string; undone_at: string | null
}

export type FilingOutcome = {
  itemId: string
  ok: boolean
  /** 搬之前叫什麼（只有檔名） */
  name: string
  /** 搬去哪，相對於 filed；沒搬成就是空字串 */
  toFolder: string
  /** 落地之後真正的名字（同名會加序號）；沒搬成就是空字串 */
  to: string
  /** 一句人話。**不帶絕對路徑** */
  why: string
  /** 成功時的紀錄 id，undo 要用 */
  id?: string
}

export type FilingRequest = {
  itemId: unknown; course?: unknown; kind?: unknown
  /**
   * 不屬於任何課程的檔要搬去的資料夾（P7，2026-09-21）。
   * 有它就走「分類」那條路：`<folder>/`，不經過 Courses、不分 kind。
   * 給了 folder 就不看 course／kind —— **兩條路互斥**。
   */
  folder?: unknown
}

function validateRequests(items: unknown): asserts items is FilingRequest[] {
  if (!Array.isArray(items) || !items.length) {
    throw new CleanupError('BAD_BODY', 'Name which files to file: items is an array and each entry has an itemId.')
  }
  if (items.length > 5000) throw new CleanupError('BAD_BODY', 'At most 5000 entries at a time.')
  for (const it of items) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) {
      throw new CleanupError('BAD_BODY', 'Each entry in items must be { itemId, course, kind }.')
    }
    const id = (it as FilingRequest).itemId
    if (typeof id !== 'string' || !id || id.length > 200) {
      throw new CleanupError('BAD_BODY', 'itemId must be a string of 1 to 200 characters.')
    }
    const course = (it as FilingRequest).course
    if (course !== undefined && (typeof course !== 'string' || course.length > 4096)) {
      throw new CleanupError('BAD_BODY', 'course must be a string of at most 4096 characters.')
    }
    const kind = (it as FilingRequest).kind
    if (kind !== undefined && (typeof kind !== 'string' || kind.length > 200)) {
      throw new CleanupError('BAD_BODY', 'kind must be a string of at most 200 characters.')
    }
    const folder = (it as FilingRequest).folder
    if (folder !== undefined && (typeof folder !== 'string' || folder.length > 4096)) {
      throw new CleanupError('BAD_BODY', 'folder must be a string of at most 4096 characters.')
    }
  }
}

/** 一整批共用的記事本：課名用哪一種寫法、每個目標資料夾已經被佔走哪些名字。 */
type Memo = { courses: Map<string, string>; taken: Map<string, Set<string>> }

/**
 * 真的搬。**只做呼叫端指名的那幾個**（不變量 1），一次最多 FILING_BATCH_MAX 個，
 * 其餘回在 `remaining` 讓呼叫端講「還有幾個」。
 *
 * 每一個檔：先寫 started → 建資料夾 → renameSync → 同一個交易裡更新 file_items 並寫 done。
 * 中間被砍就靠 recoverInterruptedFilings 看檔案實際在哪收尾。
 *
 * 整批拿**清理的鎖**（withCleanupLock）：歸檔跟清理、改名不可以同時動同一個檔。
 */
export function applyFilings(db: DatabaseSync, items: unknown, scope: FilingScope): {
  results: FilingOutcome[]; remaining: number
} {
  validateRequests(items)
  if (scope.readonly) {
    throw new CleanupError('READ_ONLY', 'Read-only mode is on, so no file gets moved.')
  }
  if (!scope.filed) {
    throw new CleanupError('BAD_CONFIG', 'The filed folder is not configured, so there is nowhere to move things to.')
  }
  // 同一個檔送兩次只做一次（第二次的來源已經是搬完的位置，很難講清楚）
  const seen = new Set<string>()
  const wanted: FilingRequest[] = []
  for (const it of items) {
    if (seen.has(it.itemId as string)) continue
    seen.add(it.itemId as string)
    wanted.push(it)
  }
  const batch = wanted.slice(0, FILING_BATCH_MAX)
  const remaining = wanted.length - batch.length

  return withCleanupLock(db, renew => {
    recoverInterruptedFilings(db)
    const results: FilingOutcome[] = []
    // 一整批共用一個時間戳：undo 的 `last` 靠它認出「最近那一次」是哪幾列
    const at = new Date().toISOString()
    const memo: Memo = { courses: new Map(), taken: new Map() }
    for (const req of batch) {
      renew()
      results.push(fileOne(db, req, scope, at, memo))
    }
    return { results, remaining }
  })
}

/**
 * 把目標資料夾建出來並攤開。**mkdir 只發生在 filed 底下**，而且每一層都過 checkedPath（拒捷徑）——
 * `<filed>/課程` 被換成一個捷徑的話，這一項就失敗（預想 Step 1「目標樹被人動過」）。
 */
function ensureDir(parentReal: string, name: string): string {
  const path = join(parentReal, name)
  try { mkdirSync(path) }
  catch (e: any) { if (e?.code !== 'EEXIST') throw e }
  return checkedPath(path, true)
}

/**
 * `<filed>/課程/<課名>/<類型>`。回真路徑與**畫面看得到的那一段**。
 *
 * 課名用「第一次出現的寫法」：同一批裡先看記事本，再看磁碟上已經有的（含只差空白／全形／大小寫的），
 * 都沒有才用這一次洗出來的。最後再確認一次算出來的資料夾真的在 filed 底下 —— 那是不變量 3 的底線。
 */
/**
 * 分類那條路的目的地：`<folder>/`，直接在 filed 底下（P7，2026-09-21）。
 *
 * 跟課程那條**刻意不共用** —— 課程是兩層（`Courses/<課名>/<kind>`），
 * 分類是一層。硬塞進同一支函式會讓「幾層」變成一個參數，而那正是最容易搞錯的地方。
 *
 * 名字再洗一次（不變量 2），而且最後照樣確認算出來的資料夾真的在 filed 底下 ——
 * 那是不變量 3 的底線，不因為換了一條路就少做。
 */
function targetGroupDir(scope: FilingScope, folder: string): { dir: string; folder: string } {
  const clean = cleanGroupName(folder)
  if (!clean) {
    throw new CleanupError('BAD_BODY', 'That folder name washes out to nothing, so it cannot be used.')
  }
  if (clean.toLowerCase() === COURSES_DIR.toLowerCase()) {
    throw new CleanupError('BAD_BODY', `A category cannot be called ${COURSES_DIR} — that is where course material goes.`)
  }
  const want = resolve(scope.filed)
  try { mkdirSync(want, { recursive: true }) }
  catch (e: any) { if (e?.code !== 'EEXIST') throw e }
  const root = checkedPath(want, true)
  const dir = ensureDir(root, clean)
  if (!under(root, dir)) {
    throw new CleanupError('UNSAFE_PATH', 'The folder this works out to is not under the filed folder, so this one is skipped.')
  }
  return { dir, folder: clean }
}

function targetDir(scope: FilingScope, course: string, kind: string, memo: Memo): { dir: string; folder: string } {
  const want = resolve(scope.filed)
  try { mkdirSync(want, { recursive: true }) }
  catch (e: any) { if (e?.code !== 'EEXIST') throw e }
  const root = checkedPath(want, true)
  const courses = ensureDir(root, COURSES_DIR)
  const key = courseKey(course)
  let actual = memo.courses.get(key)
  if (!actual) {
    actual = existingCourses(courses).get(key) ?? course
    memo.courses.set(key, actual)
  }
  const dir = ensureDir(ensureDir(courses, actual), kind)
  if (!under(root, dir)) {
    throw new CleanupError('UNSAFE_PATH', 'The folder this works out to is not under the filed folder, so this one is skipped.')
  }
  return { dir, folder: [COURSES_DIR, actual, kind].join('/') }
}

/**
 * 搬過去，**絕不覆蓋**。
 *
 * 跟 P3 的 moveInDir 同一個做法（Node 沒有 RENAME_NOREPLACE，而這個專案不准建佔位檔再刪掉）：
 * 動手前的最後一刻再確認一次目標不存在，而且來源還是剛剛量到的那一個 inode。
 *
 * **EXDEV 不硬搬**（不變量 7）：複製＋刪除會變成「刪檔」。
 */
function moveTo(from: string, to: string, before: { dev: number; ino: number }): void {
  let exists = true
  try { lstatSync(to) } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e
    exists = false
  }
  if (exists) throw new CleanupError('CONFLICT', 'Something just took the target name, so this one is skipped.')
  const now = lstatSync(from)
  if (now.dev !== before.dev || now.ino !== before.ino) {
    throw new CleanupError('CHANGED', 'This file was just swapped out, so it is not moved.')
  }
  try { renameSync(from, to) }
  catch (e: any) {
    if (e?.code === 'EXDEV') {
      throw new CleanupError('CROSS_DEVICE',
        'The filed folder is on another disk, which this version cannot move to. Copying and deleting would be deleting, and this project only moves — it never deletes.')
    }
    throw e
  }
}

/**
 * 讓 file_items 跟著搬家走（P3 的 followFile 同一支），再補一件歸檔專屬的事：
 *
 * **把「不見了」收回來**。filed 不在清理範圍裡、掃描走不到那棵樹，所以搬到一半被砍、
 * 中間又掃過一次的話，那一列會被標成 missing 而且永遠回不來（掃描再也看不到它）。
 * 檔案就在我們手上、位置也剛更新過，那就不是 missing。
 */
function followFiled(db: DatabaseSync, itemId: string, dir: string, name: string): string {
  // 被丟下的那一列由 followFile 自己收（稽核 2026-09-20 之後兩條線共用同一份判斷）。
  const nowId = followFile(db, itemId, dir, name)
  // 歸檔專屬的那一半：filed 不在掃描範圍裡，被標成 missing 的那一列永遠不會有人把它接回來。
  // 檔案就在我們手上、位置也剛更新過，那就不是 missing。
  db.prepare(`UPDATE file_items SET status='kept', error=NULL WHERE id=? AND status='missing'`).run(nowId)
  return nowId
}

function fileOne(db: DatabaseSync, req: FilingRequest, scope: FilingScope, at: string, memo: Memo): FilingOutcome {
  const itemId = String(req.itemId)
  const item = itemById(db, itemId)
  if (!item) {
    return { itemId, ok: false, name: '', toFolder: '', to: '', why: 'Cannot find this file — it may have been cleaned up, or rescanned.' }
  }
  const name = item.name
  const no = (why: string): FilingOutcome => ({ itemId, ok: false, name, toFolder: '', to: '', why })

  const blocked = whyNotFilable(db, item, scope)
  if (blocked) return no(blocked)

  const opinion = (() => { try { return opinionOf(modelViewForItem(db, itemId)) } catch { return null } })()
  const usable = opinion && confidentEnough(opinion.confidence) ? opinion : null
  // **每一項各讀一次學到的東西**（P5）：同一批裡第一個檔學到 `作業系統`→`OS` 之後，
  // 第二個檔就該直接用 `OS`，而且使用者送 `OS` 不算「他又改了一次」（不然計數會灌水）。
  // 整張表有 PREF_MAX 的上限，重讀一次是固定成本。
  const offer = offeredFiling(loadLearned(db), usable?.course, usable?.kind)

  // ── 分類那條路（P7，2026-09-21）────────────────────────────────
  //
  // 呼叫端給了 folder ＝ 這個檔不屬於任何課程，要搬去 `<folder>/`。
  // **在課名那一關之前分流**：不然下面那句「沒有可用的課名」會把它擋掉，
  // 而那正是這一整期要修的事（實機 202 筆答案裡 186 筆 course=Unknown）。
  //
  // folder 是呼叫端給的字串（面板送清單上顯示的那一個），所以照樣是不可信的輸入：
  // targetGroupDir 會洗一次、擋掉 Courses、最後確認在 filed 底下。
  // **給了 folder 就走分類那條路**，而且要在課名那一關之前分流 ——
  // 不然下面那句「沒有可用的課名」會把它擋掉，而那正是這一整期要修的事
  //（實機 202 筆答案裡 186 筆 course=Unknown）。
  const wantFolder = req.folder !== undefined && String(req.folder).trim() ? String(req.folder) : ''

  // 呼叫端指名的課名（面板送清單上顯示的那一個、使用者也可以自己打）一樣要洗過。
  // 走分類那條路的時候課名是空的，這一關整個跳過。
  const course = wantFolder ? '' : cleanCourse(req.course === undefined ? offer.course : req.course)
  if (!wantFolder && !course) {
    return no(req.course === undefined
      ? 'There is no usable course name: the model had no view, was not confident enough, or could not tell which course.'
      : 'That course name washes out to nothing — only path separators, control characters or reserved names are left — so it cannot be used.')
  }
  const kind = kindFolder(req.kind === undefined ? offer.kind : req.kind)
  // 打錯字的類型（`講議`）會被 kindFolder 收斂成「其他」。**那一次照舊進「其他」，但不可以學** ——
  // 學了的話這一堂課之後每一個「筆記」都變「其他」，打錯一個字的代價從一個檔變成整堂課（稽核 2026-09-20）。
  const kindTyped = req.kind === undefined ? true : VIEW_KINDS.includes(String(req.kind).trim())
  // 主題不進路徑（太細會變成一堆只有一個檔的資料夾），但記在紀錄裡 —— 那是「模型認為的主題」，
  // 就算呼叫端自己指名了課名也照記。
  const topic = String(usable?.topic ?? '').slice(0, 200)

  let fromDir: string
  try { fromDir = checkedPath(dirname(item.path), true) } catch (e) { return no(cleanupProblem(e)) }
  // 資料夾攤開之後還要在清理範圍裡（父層是捷徑時 path 與 fromDir 會不一樣）
  if (!underSomeRoot(scope.roots, join(fromDir, name))) return no('This file is not inside a configured cleanup folder.')

  let before
  try { before = checkFile(join(fromDir, name), FILE_WORDS) } catch (e) { return no(cleanupProblem(e)) }

  let dest: { dir: string; folder: string }
  try {
    // 分類那條路是一層（`<folder>/`），課程那條是兩層（`Courses/<課名>/<kind>`）。
    // 兩支刻意分開，見 targetGroupDir 的說明。
    dest = wantFolder ? targetGroupDir(scope, wantFolder) : targetDir(scope, course, kind, memo)
  } catch (e) { return no(cleanupProblem(e)) }
  if (dest.dir === fromDir) return no('This file is already in that folder.')

  let taken = memo.taken.get(dest.dir)
  if (!taken) {
    try { taken = namesTaken(db, dest.dir) } catch (e) { return no(cleanupProblem(e)) }
    memo.taken.set(dest.dir, taken)
  }
  const to = freeName(name, originalExt(name), taken)
  if (!to) return no(`“${name}” and its -2…-${SUFFIX_MAX} variants are all taken in that folder, so this one is skipped.`)

  const id = randomUUID()
  db.prepare(
    `INSERT INTO filings (id,item_id,name,from_dir,to_dir,to_name,course,kind,topic,status,error,at,undone_at)
     VALUES (?,?,?,?,?,?,?,?,?,'started',NULL,?,NULL)`
  ).run(id, itemId, name, fromDir, dest.dir, to, course, kind, topic, at)

  try {
    moveTo(join(fromDir, name), join(dest.dir, to), before)
  } catch (e) {
    const why = cleanupProblem(e)
    db.prepare(`UPDATE filings SET status='failed', error=? WHERE id=?`).run(why.slice(0, 200), id)
    return no(why)
  }
  taken.add(to.toLowerCase())
  transaction(db, () => {
    followFiled(db, itemId, dest.dir, to)
    db.prepare(`UPDATE filings SET status='done' WHERE id=?`).run(id)
  })
  // ── 學（P5）────────────────────────────────────────────────
  // **只在這裡學**：檔案真的搬成功了才算「使用者做過這個動作」（不變量 1）。
  // 而且只學「跟我們建議的不一樣」的那一下 —— 照單全收不是新資訊。
  // 學習本身絕對不可以讓這一項失敗：learn.ts 每一個 db 呼叫都自己包著，不往上丟。
  // **分類那條路沒有課名可學**：course 是空的，學下去會寫出一筆 ''→'' 的偏好，
  // 而 learned 那一區是給使用者看「它學到了什麼」的 —— 空的一列只會讓人困惑。
  if (!wantFolder && courseKey(course) !== courseKey(offer.course)) {
    learnCourse(db, usable?.course, req.course, course, at, scope)
  }
  if (!wantFolder && kind !== offer.kind && kindTyped) {
    learnKind(db, usable?.course, kindFolder(usable?.kind), kind, at, scope)
  }
  // 同一個建議重新做一次成功 → 「你上次退過」的標記要消失（預期行為 5）
  forgetRejected(db, itemId, filingSummary(dest.folder), scope)
  return {
    itemId, ok: true, name, toFolder: dest.folder, to, id,
    why: to === name
      ? `Moved to “${dest.folder}”. Changed your mind? It can be undone.`
      : `Moved to “${dest.folder}”. A file of that name was already there, so this one is called “${to}” (nothing was overwritten).`,
  }
}

// ── 復原 ────────────────────────────────────────────────────

export type FilingUndoOutcome = {
  id: string
  itemId: string
  ok: boolean
  /** 放回去之後叫什麼（沒放回就是空字串） */
  name: string
  /** 原名被佔走時，真正放回來的名字；沒有就是 null */
  restoredAs: string | null
  why: string
}

export type FilingUndoSelection = { ids?: unknown; last?: unknown }

const restoreRootsOf = (scope: FilingScope): string[] =>
  scope.restoreRoots && scope.restoreRoots.length ? scope.restoreRoots : scope.roots

/**
 * 原本的資料夾。還在就用它（**在不在清理範圍裡都照放回去** —— 那是它原本的家，
 * 放回原位不算擴大範圍，跟清理的復原同一個判斷）；不見了才要**在放回範圍內**建回來。
 */
function restoreDir(from: string, scope: FilingScope): string {
  const want = resolve(from)
  let missing = false
  try { lstatSync(want) } catch (e: any) {
    if (e?.code === 'ENOENT') missing = true
    else throw e
  }
  if (missing) {
    const inScope = restoreRootsOf(scope).some(r => {
      let real = resolve(r)
      // 根目錄本身也不見了（外接碟拔掉）：退回字面比較，建回來之後還是會再過一次 checkedPath
      try { real = checkedPath(r, true) } catch { /* 用字面的 */ }
      return want === real || under(real, want)
    })
    if (!inScope) {
      throw new CleanupError('OUTSIDE_ROOT',
        'The original folder is gone, and it is not under a configured cleanup folder, so it was not recreated.')
    }
    mkdirSync(want, { recursive: true })
  }
  return checkedPath(want, true)
}

/**
 * 復原：把檔搬回原本的資料夾。
 *
 * - `{ ids: [...] }`：指名哪幾筆
 * - `{ last: true }`：**最近那一次**（同一批 apply 共用一個時間戳，所以是整批一起回去）
 *
 * 原位被別人佔走了就加序號，而且**講清楚放回來的叫什麼**（預期行為 11）。
 */
export function undoFilings(db: DatabaseSync, sel: FilingUndoSelection, scope: FilingScope): {
  results: FilingUndoOutcome[]
} {
  if (scope.readonly) {
    throw new CleanupError('READ_ONLY', 'Read-only mode is on, so no file gets moved.')
  }
  const wantLast = sel.last === true
  if (sel.last !== undefined && typeof sel.last !== 'boolean') {
    throw new CleanupError('BAD_BODY', 'last must be true or false.')
  }
  let ids: string[] = []
  if (sel.ids !== undefined) {
    if (!Array.isArray(sel.ids) || sel.ids.length > 1000
      || sel.ids.some(v => typeof v !== 'string' || !v || v.length > 200)) {
      throw new CleanupError('BAD_BODY', 'ids must be an array of strings, at most 1000 of them.')
    }
    ids = [...new Set(sel.ids as string[])]
  }
  if (!ids.length && !wantLast) {
    throw new CleanupError('BAD_BODY', 'Name the ids, or send { "last": true } to undo the most recent filing.')
  }

  return withCleanupLock(db, renew => {
    recoverInterruptedFilings(db)
    let rows: FilingRow[]
    if (ids.length) {
      rows = db.prepare(
        `SELECT * FROM filings WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY at DESC, id`
      ).all(...ids) as FilingRow[]
      const found = new Set(rows.map(r => r.id))
      if (ids.some(i => !found.has(i))) throw new CleanupError('NOT_FOUND', 'Cannot find those filing records.')
    } else {
      const last = db.prepare(`SELECT at FROM filings WHERE status='done' ORDER BY at DESC LIMIT 1`)
        .get() as { at: string } | undefined
      if (!last) throw new CleanupError('NOT_FOUND', 'There is no filing to undo.')
      rows = db.prepare(`SELECT * FROM filings WHERE status='done' AND at=? ORDER BY id`)
        .all(last.at) as FilingRow[]
    }
    const results: FilingUndoOutcome[] = []
    for (const row of rows) {
      renew()
      results.push(undoOne(db, row, scope))
    }
    return { results }
  })
}

function undoOne(db: DatabaseSync, row: FilingRow, scope: FilingScope): FilingUndoOutcome {
  const base: FilingUndoOutcome = {
    id: row.id, itemId: row.item_id, ok: false, name: '', restoredAs: null, why: '',
  }
  const no = (why: string): FilingUndoOutcome => ({ ...base, why })
  if (row.status === 'reverted') return { ...base, ok: true, name: row.name, why: 'This one had already been undone.' }
  if (row.status !== 'done') return no('This one never succeeded, so there is nothing to undo.')

  let toDir: string
  try { toDir = checkedPath(row.to_dir, true) } catch (e) { return no(cleanupProblem(e)) }
  const filed = scope.filed ? resolve(scope.filed) : ''
  if (!filed || !under(filed, join(toDir, row.to_name))) {
    return no('That file is no longer in the filed folder, so it is left alone.')
  }
  let before
  try { before = checkFile(join(toDir, row.to_name), FILE_WORDS) } catch (e) { return no(cleanupProblem(e)) }

  let backDir: string
  try { backDir = restoreDir(row.from_dir, scope) } catch (e) { return no(cleanupProblem(e)) }

  let taken: Set<string>
  try { taken = namesTaken(db, backDir) } catch (e) { return no(cleanupProblem(e)) }
  const back = freeName(row.name, originalExt(row.name), taken)
  if (!back) return no(`The original name and its -2…-${SUFFIX_MAX} variants are all taken, so it was not moved back.`)

  try {
    moveTo(join(toDir, row.to_name), join(backDir, back), before)
  } catch (e) {
    const why = cleanupProblem(e)
    db.prepare('UPDATE filings SET error=? WHERE id=?').run(why.slice(0, 200), row.id)
    return no(why)
  }
  let nowItem = row.item_id
  transaction(db, () => {
    // 收尾那邊同一段：掃描已經先在原位收了一列的話，跟著那一列走，紀錄也要指過去
    const nowId = followFiled(db, row.item_id, backDir, back)
    if (nowId !== row.item_id) db.prepare('UPDATE filings SET item_id=? WHERE id=?').run(nowId, row.id)
    nowItem = nowId
    db.prepare(`UPDATE filings SET status='reverted', undone_at=? WHERE id=?`)
      .run(new Date().toISOString(), row.id)
  })
  // ── 學（P5）：undo ＝ 這個建議被退貨了 ──────────────────────
  // 記在**檔現在那一列**上（跟著 followFiled 改過道的 id 走），不然下一次列清單找不到這個標記。
  // 只記「哪一個建議」，清單照樣列它，只是**不預設勾**（預期行為 5）。
  rememberRejected(db, nowItem, filingSummary(folderOf(row.to_dir)), new Date().toISOString(), scope)
  const restoredAs = back === row.name ? null : back
  return {
    ...base, ok: true, name: back, restoredAs,
    why: restoredAs
      ? `A file of that name was already in the original place, so this one is called “${restoredAs}” (nothing was overwritten).`
      : 'Moved back to the folder it came from.',
  }
}

// ── 收尾（中斷之後）────────────────────────────────────────

/**
 * 收尾還停在 started 的紀錄。**看檔案實際在哪**決定那一列是 done 還是 reverted：
 *
 *   · 新位置有 → 其實搬完了，只是沒來得及寫 done。補上 file_items，標 done。
 *   · 原位有 → 沒搬到。標 reverted（檔案本來就在原位，不用動它）。
 *   · 兩邊都沒有 → 標 failed，留一句話，不猜。
 *
 * **「掃描已經先收了一列」一定要跟著那一列走**（P3 驗證員抓到的 blocker，不可以再犯）：
 * pet 開機與每 30 分鐘都會掃，搬完、還沒寫 done 就被砍的話，掃描可能已經把新位置收成另一列
 * （filed 落在清理範圍底下時），舊那列變成 missing。硬改舊那列的 path 會撞 UNIQUE(file_items.path)，
 * 例外被吞掉，那一筆就永遠停在 started、永遠復原不回來。followFile 會處理這個情況。
 *
 * **收不掉一定要留下原因**：吞掉的話使用者只看到「上一次歸檔還沒收尾」卻永遠收不完。
 */
export function recoverInterruptedFilings(db: DatabaseSync): { recovered: number } {
  let rows: FilingRow[]
  try {
    rows = db.prepare(`SELECT * FROM filings WHERE status='started' ORDER BY at, id`).all() as FilingRow[]
  } catch { return { recovered: 0 } }
  let recovered = 0
  for (const row of rows) {
    const there = (path: string) => { try { lstatSync(path); return true } catch { return false } }
    try {
      // **每一個 UPDATE 都要再確認一次那一列還是 started**（稽核 2026-09-20，跟改名同一條）。
      // 收尾不拿鎖，另一個行程的 apply 可能已經把它 commit 成 done —— 蓋掉的話那一筆
      // 其實搬好了卻被講成 failed，undo 永遠拒絕；蓋成 reverted 更糟，undo 會回「已經復原過了」。
      let changed = 0
      if (there(join(row.to_dir, row.to_name))) {
        transaction(db, () => {
          changed = db.prepare(`UPDATE filings SET status='done' WHERE id=? AND status='started'`)
            .run(row.id).changes
          if (changed) {
            const nowId = followFiled(db, row.item_id, row.to_dir, row.to_name)
            if (nowId !== row.item_id) db.prepare('UPDATE filings SET item_id=? WHERE id=?').run(nowId, row.id)
          }
        })
      } else if (there(join(row.from_dir, row.name))) {
        changed = db.prepare(`UPDATE filings SET status='reverted', undone_at=?, error=? WHERE id=? AND status='started'`)
          .run(new Date().toISOString(), 'Interrupted mid-filing; the file never left its folder, so nothing moved.', row.id).changes
      } else {
        changed = db.prepare(`UPDATE filings SET status='failed', error=? WHERE id=? AND status='started'`)
          .run('Interrupted mid-filing; the file is in neither the old nor the new place. Check it yourself.', row.id).changes
      }
      if (changed) recovered++
    } catch (e: any) {
      try {
        db.prepare(`UPDATE filings SET error=? WHERE id=? AND status='started'`)
          .run(`Tidying up failed: ${String(e?.message ?? e).slice(0, 150)}`, row.id)
      } catch { /* 連這個都寫不進去就算了 */ }
    }
  }
  return { recovered }
}

/** 最近幾筆整理紀錄（CLI 的 `file --undo` 要列出可以復原的）。**不回 from_dir／to_dir。** */
export function listFilings(db: DatabaseSync, limit = 20): {
  id: string; itemId: string; name: string; to: string; toFolder: string
  course: string; kind: string; status: string; at: string
}[] {
  const n = Math.max(1, Math.min(200, limit))
  let rows: FilingRow[] = []
  try {
    rows = db.prepare('SELECT * FROM filings ORDER BY at DESC, id LIMIT ?').all(n) as FilingRow[]
  } catch { return [] }
  return rows.map(r => ({
    id: r.id, itemId: r.item_id, name: r.name, to: r.to_name, toFolder: folderOf(r.to_dir),
    course: r.course, kind: r.kind, status: r.status, at: r.at,
  }))
}

/** 走分類那條路的檔案數，以及它們說自己是什麼。 */
export type GroupCandidates = {
  /** 不重複的「這是什麼文件」，常見的排前面。 */
  phrases: { phrase: string; count: number }[]
  /** 走分類那條路的檔案數（course 說不出來、但模型看得懂的那些）。 */
  files: number
  /** 其中連「這是什麼文件」都說不出來的。**要算出來給人看**，不可以安靜消失。 */
  speechless: number
}

/**
 * 分類那一次要問的東西（P7，2026-09-21）。
 *
 * **對象是「不重複的說法」，不是檔案。** 1164 個檔取 distinct whatItIs 之後
 * 剩一兩百種說法，一次呼叫就收斂得完 —— 1164 個檔跟 100 個檔成本一樣。
 *
 * 名單跟 filingSuggestions 走同一份（filableRows ＋ 同一組門檻），
 * 而且**只收 course 說不出來的那些**：屬於某門課的檔已經有去處，
 * 把它們的說法也丟進來只會讓分類被課程教材帶偏。
 */
export function groupCandidates(db: DatabaseSync, scope: FilingScope): GroupCandidates {
  const said: string[] = []
  let files = 0
  let speechless = 0
  for (const row of filableRows(db)) {
    let opinion: ModelOpinion | null = null
    try { opinion = opinionOf(modelViewForItem(db, row.id)) } catch { opinion = null }
    if (!opinion) continue
    if (!confidentEnough(opinion.confidence)) continue
    if (cleanCourse(opinion.course)) continue
    if (whyNotFilable(db, row, scope)) continue
    files++
    const what = phraseKey(opinion.whatItIs) ? String(opinion.whatItIs) : ''
    if (!what) { speechless++; continue }
    said.push(what)
  }
  return { phrases: distinctPhrases(said), files, speechless }
}
