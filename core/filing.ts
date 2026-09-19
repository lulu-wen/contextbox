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
export const COURSES_DIR = '課程'
/** `kind` 不在固定選項裡時用哪一個資料夾（P2 的 VIEW_KINDS 最後一個就是它）。 */
export const OTHER_KIND = '其他'

/** 訊息裡的詞（跟 P3 共用同一套判斷，只有詞不一樣）。 */
const FILE_WORDS: MoveWords = { act: '歸檔', it: '不搬它' }

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
    return '這個檔已經在整理好的資料夾裡了，這一期只往裡面搬。'
  }
  return whyNotTouchable(db, item, scope, FILE_WORDS, midFiling)
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
  let rows: ItemRow[] = []
  try {
    // **先在 SQL 裡縮小**：沒有任何模型看法的檔不可能被建議，一列一列去問 modelViewForItem
    // （而且對不到時還會再打一次 sha256 的 JOIN）會讓成本跟「總檔數」成正比 —— 兩萬個檔就是 0.8 秒。
    // 下面這個條件是 modelViewForItem 的**超集合**（它自己還會再看新不新鮮），
    // 兩條路各自有索引：ix_model_views_item、ix_file_items_sha。
    rows = db.prepare(
      `SELECT id, path, name, status, error, naming, mtime FROM file_items f
        WHERE f.error IS NULL AND f.status IN (${RENAMABLE_STATUSES.map(() => '?').join(',')})
          AND (EXISTS (SELECT 1 FROM model_views v WHERE v.item_id = f.id)
               OR (f.sha256 IS NOT NULL AND EXISTS (
                     SELECT 1 FROM model_views v JOIN file_items j ON j.id = v.item_id
                      WHERE j.sha256 = f.sha256)))
        ORDER BY f.last_seen_at DESC, f.id`
    ).all(...RENAMABLE_STATUSES) as ItemRow[]
  } catch { rows = [] }

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
    if (!course) continue
    if (whyNotFilable(db, row, scope)) continue
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

export type FilingRequest = { itemId: unknown; course?: unknown; kind?: unknown }

function validateRequests(items: unknown): asserts items is FilingRequest[] {
  if (!Array.isArray(items) || !items.length) {
    throw new CleanupError('BAD_BODY', '要指名整理哪幾個檔（items 是一個陣列，每一項有 itemId）。')
  }
  if (items.length > 5000) throw new CleanupError('BAD_BODY', '一次最多 5000 項。')
  for (const it of items) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) {
      throw new CleanupError('BAD_BODY', 'items 的每一項要是 { itemId, course, kind }。')
    }
    const id = (it as FilingRequest).itemId
    if (typeof id !== 'string' || !id || id.length > 200) {
      throw new CleanupError('BAD_BODY', 'itemId 必須是 1 到 200 字元的字串。')
    }
    const course = (it as FilingRequest).course
    if (course !== undefined && (typeof course !== 'string' || course.length > 4096)) {
      throw new CleanupError('BAD_BODY', 'course 必須是字串（最多 4096 字元）。')
    }
    const kind = (it as FilingRequest).kind
    if (kind !== undefined && (typeof kind !== 'string' || kind.length > 200)) {
      throw new CleanupError('BAD_BODY', 'kind 必須是字串（最多 200 字元）。')
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
    throw new CleanupError('READ_ONLY', '目前是唯讀模式，不會搬動任何檔案。')
  }
  if (!scope.filed) {
    throw new CleanupError('BAD_CONFIG', '還沒設定「整理好的」資料夾，不知道要搬去哪。')
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
    throw new CleanupError('UNSAFE_PATH', '算出來的資料夾不在「整理好的」資料夾底下，這一個先跳過。')
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
  if (exists) throw new CleanupError('CONFLICT', '目標名字剛剛被別的東西佔走了，這一個先跳過。')
  const now = lstatSync(from)
  if (now.dev !== before.dev || now.ino !== before.ino) {
    throw new CleanupError('CHANGED', '這個檔剛剛被換掉了，先不搬它。')
  }
  try { renameSync(from, to) }
  catch (e: any) {
    if (e?.code === 'EXDEV') {
      throw new CleanupError('CROSS_DEVICE',
        '「整理好的」資料夾在另一顆碟，這一版還不支援搬過去（複製再刪掉等於刪檔，這個專案只搬不刪）。')
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
  const was = db.prepare('SELECT path FROM file_items WHERE id=?').get(itemId) as { path: string } | undefined
  const nowId = followFile(db, itemId, dir, name)
  db.prepare(`UPDATE file_items SET status='kept', error=NULL WHERE id=? AND status='missing'`).run(nowId)
  // followFile 改道跟著別人那一列走的時候，**舊那列要收掉**：檔案已經不在它記的位置了。
  // 改名（P3）不收也沒事 —— 舊位置在清理範圍裡，下一次掃描就會把它標成不見了。
  // 歸檔不一樣：舊位置可能在 filed 底下（復原就是這樣），而 filed 不在掃描範圍裡，
  // **永遠沒有人會來收它**。留著的話 namesTaken 會以為那個名字還被佔住，
  // 下一次同名的檔就被無故加成 -2。
  if (nowId !== itemId && was) {
    let stillThere = true
    try { lstatSync(was.path) } catch { stillThere = false }
    if (!stillThere) {
      db.prepare(
        `UPDATE file_items SET status='missing' WHERE id=? AND status IN (${RENAMABLE_STATUSES.map(() => '?').join(',')})`
      ).run(itemId, ...RENAMABLE_STATUSES)
    }
  }
  return nowId
}

function fileOne(db: DatabaseSync, req: FilingRequest, scope: FilingScope, at: string, memo: Memo): FilingOutcome {
  const itemId = String(req.itemId)
  const item = itemById(db, itemId)
  if (!item) {
    return { itemId, ok: false, name: '', toFolder: '', to: '', why: '找不到這個檔（可能已經被清掉或重新掃描過）。' }
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
  // 呼叫端指名的課名（面板送清單上顯示的那一個、使用者也可以自己打）一樣要洗過
  const course = cleanCourse(req.course === undefined ? offer.course : req.course)
  if (!course) {
    return no(req.course === undefined
      ? '沒有可以用的課程名稱（模型沒有看法、信心太低，或看不出來是哪一堂課）。'
      : '這個課程名稱洗完是空的（只剩路徑符號、控制字元或保留名稱），不能用。')
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
  if (!underSomeRoot(scope.roots, join(fromDir, name))) return no('這個檔不在設定的清理資料夾裡。')

  let before
  try { before = checkFile(join(fromDir, name), FILE_WORDS) } catch (e) { return no(cleanupProblem(e)) }

  let dest: { dir: string; folder: string }
  try { dest = targetDir(scope, course, kind, memo) } catch (e) { return no(cleanupProblem(e)) }
  if (dest.dir === fromDir) return no('這個檔已經在那個資料夾裡了。')

  let taken = memo.taken.get(dest.dir)
  if (!taken) {
    try { taken = namesTaken(db, dest.dir) } catch (e) { return no(cleanupProblem(e)) }
    memo.taken.set(dest.dir, taken)
  }
  const to = freeName(name, originalExt(name), taken)
  if (!to) return no(`「${name}」與它的 -2⋯-${SUFFIX_MAX} 在那個資料夾裡都已經有人用了，這一個先跳過。`)

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
  if (courseKey(course) !== courseKey(offer.course)) {
    learnCourse(db, usable?.course, req.course, course, at, scope)
  }
  if (kind !== offer.kind && kindTyped) learnKind(db, usable?.course, kindFolder(usable?.kind), kind, at, scope)
  // 同一個建議重新做一次成功 → 「你上次退過」的標記要消失（預期行為 5）
  forgetRejected(db, itemId, filingSummary(dest.folder), scope)
  return {
    itemId, ok: true, name, toFolder: dest.folder, to, id,
    why: to === name
      ? `搬到「${dest.folder}」了。反悔的話可以復原。`
      : `搬到「${dest.folder}」了；那裡已經有同名的檔，所以這一份叫「${to}」（沒有覆蓋任何檔）。`,
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
        '原本的資料夾已經不在了，而且它不在設定的清理資料夾底下，沒有幫你建回來。')
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
    throw new CleanupError('READ_ONLY', '目前是唯讀模式，不會搬動任何檔案。')
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
    throw new CleanupError('BAD_BODY', '要指名 ids，或送 { "last": true } 復原最近一次整理。')
  }

  return withCleanupLock(db, renew => {
    recoverInterruptedFilings(db)
    let rows: FilingRow[]
    if (ids.length) {
      rows = db.prepare(
        `SELECT * FROM filings WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY at DESC, id`
      ).all(...ids) as FilingRow[]
      const found = new Set(rows.map(r => r.id))
      if (ids.some(i => !found.has(i))) throw new CleanupError('NOT_FOUND', '找不到這幾筆整理紀錄。')
    } else {
      const last = db.prepare(`SELECT at FROM filings WHERE status='done' ORDER BY at DESC LIMIT 1`)
        .get() as { at: string } | undefined
      if (!last) throw new CleanupError('NOT_FOUND', '沒有可以復原的整理。')
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
  if (row.status === 'reverted') return { ...base, ok: true, name: row.name, why: '這一筆本來就已經復原過了。' }
  if (row.status !== 'done') return no('這一筆沒有搬成功，沒有東西要復原。')

  let toDir: string
  try { toDir = checkedPath(row.to_dir, true) } catch (e) { return no(cleanupProblem(e)) }
  const filed = scope.filed ? resolve(scope.filed) : ''
  if (!filed || !under(filed, join(toDir, row.to_name))) {
    return no('那個檔現在不在「整理好的」資料夾裡，先不動它。')
  }
  let before
  try { before = checkFile(join(toDir, row.to_name), FILE_WORDS) } catch (e) { return no(cleanupProblem(e)) }

  let backDir: string
  try { backDir = restoreDir(row.from_dir, scope) } catch (e) { return no(cleanupProblem(e)) }

  let taken: Set<string>
  try { taken = namesTaken(db, backDir) } catch (e) { return no(cleanupProblem(e)) }
  const back = freeName(row.name, originalExt(row.name), taken)
  if (!back) return no(`原本的名字與它的 -2⋯-${SUFFIX_MAX} 都已經有人用了，沒有搬回去。`)

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
      ? `原本的位置已經有一個同名的檔了，放回來的這一份叫「${restoredAs}」（沒有覆蓋任何檔）。`
      : '搬回原本的資料夾了。',
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
      if (there(join(row.to_dir, row.to_name))) {
        transaction(db, () => {
          const nowId = followFiled(db, row.item_id, row.to_dir, row.to_name)
          if (nowId !== row.item_id) db.prepare('UPDATE filings SET item_id=? WHERE id=?').run(nowId, row.id)
          db.prepare(`UPDATE filings SET status='done' WHERE id=?`).run(row.id)
        })
      } else if (there(join(row.from_dir, row.name))) {
        db.prepare(`UPDATE filings SET status='reverted', undone_at=?, error=? WHERE id=?`)
          .run(new Date().toISOString(), '整理中斷，檔案還在原本的資料夾，沒有搬。', row.id)
      } else {
        db.prepare(`UPDATE filings SET status='failed', error=? WHERE id=?`)
          .run('整理中斷，原位與新位置現在都找不到這個檔，請人工確認。', row.id)
      }
      recovered++
    } catch (e: any) {
      try {
        db.prepare(`UPDATE filings SET error=? WHERE id=? AND status='started'`)
          .run(`收尾失敗：${String(e?.message ?? e).slice(0, 150)}`, row.id)
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
