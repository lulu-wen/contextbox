/**
 * 記住你改過的東西（P5）—— **可查、可忘掉**。
 *
 * 上游：P3（改名）與 P4（歸檔）都已經是「模型建議 → 使用者確認 → 真的動檔案 → 可復原」。
 * 這一支只做一件事：**使用者跟建議不一樣的那一下，要被記住**，下一次就不要再問同一件事。
 *
 * ── 為什麼這支要特別小心 ─────────────────────────────────────
 *   它會**改變之後的建議**，而建議會變成真的搬檔。學錯了會安靜地一直錯下去
 *   （使用者只會覺得「它越用越怪」），而且錯誤會累積 —— 這是「錯了不會馬上被看見」那一類。
 *
 * ── 不變量（改這支之前先讀一次）────────────────────────────
 *   1. **只從使用者真的做過的動作學**：`rename apply`／`file apply` 帶的參數，以及 `undo`。
 *      不從掃描、不從模型、不從猜測學。這一支沒有任何地方會自己去讀 model_views。
 *   2. **學到的東西不放寬任何安全檢查**。這一支**只存字串、只讀字串**：不組路徑、不碰檔案系統。
 *      課名在**存之前**已經被呼叫端洗過（cleanCourse），**用的時候呼叫端再洗一次** ——
 *      學到的值要走到 fs 那一層，一定得再過一次跟以前一模一樣的那幾關。
 *   3. **不存路徑、不存檔案內容**。只存「模型說 A、你改成 B」這種對應與計數。
 *   4. **學習永遠不會自己動檔案**。它只改建議的顯示與預設值，使用者照樣要按。
 *   5. 同一個鍵**只有一列**，後來的動作跟先前學到的不一樣時以**最後一次**為準（更新並 times＋1）。
 *   6. 表不見了（舊的資料庫、被人砍掉）→ 當成「什麼都沒學過」，功能照常。
 *      所以這一支每一個 db 呼叫都包起來，回空的，不往上丟。
 *   7. **唯讀模式不學**（呼叫端已經先擋掉 apply／undo；這裡的 `readonly` 再擋一次）。
 *   8. **有上限**（PREF_MAX 列）。滿了丟掉最舊、最少用的，而且**留紀錄可查**。
 *
 * ── 為什麼 courseKey 住在這裡，不住在 filing.ts ──────────────
 *   改名（rename.ts）現在也要用同一個折法去問「這堂課使用者怎麼寫」，而 filing.ts 匯入 rename.ts。
 *   放在 filing.ts 會繞成 rename.ts → filing.ts → rename.ts。
 *   這一支**什麼都不匯入**（只有 node 內建），誰都可以用它，不會繞圈；
 *   filing.ts 照舊 re-export 同一支，外面看起來完全沒變 —— **不准有第二份折法**。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/** 最多記幾列。超過就丟掉最舊、最少用的（預想 Step 1 最後第二格）。 */
export const PREF_MAX = 500
/** 一列的值最多幾個字。課名本來就有 40 的上限，這是**第二道**：別讓別的呼叫端塞一整篇進來。 */
export const PREF_VALUE_MAX = 200
/** 一次最多忘掉幾條（DELETE /learned 的 ids）。 */
export const FORGET_MAX = 1000

/** 丟掉的列數記在 meta 的這兩個鍵底下（不變量 8 的「留紀錄可查」）。 */
const EVICTED_COUNT = 'preferences_evicted'
const EVICTED_AT = 'preferences_evicted_at'

/** 資料表的 CHECK 認得的三種（**跟 db.ts 的 DDL 是同一組**，多一種要兩邊一起改）。 */
export type PrefKind = 'course' | 'file_kind' | 'rejected'

/**
 * 課名的**比對鍵**：NFKC ＋ 去掉所有空白 ＋ 小寫。
 *
 * `作業系統` 與 `作業系統 `、`OS` 與 `ＯＳ` 是同一堂課 —— 不折的話同一堂課會長出兩份偏好，
 * 使用者改了一次卻要再改第二次。**只用來比對**；真的要顯示、要建資料夾一律用存下來的寫法。
 */
export function courseKey(name: unknown): string {
  return String(name ?? '').normalize('NFKC').replace(/\s+/gu, '').toLowerCase()
}

/** `course` 的對應鍵：模型講的課名，折過。 */
const courseKeyOf = (modelCourse: unknown): string => courseKey(modelCourse)

/**
 * `file_kind` 的對應鍵：`courseKey(模型的課名)` ＋ 換行 ＋ 模型的 kind。
 *
 * **學成「這一堂課的」，不是全域的**（預想 Step 1）：使用者把作業系統的東西都改成「講義」，
 * 不代表資料結構的也要跟著變。全域會把別堂課一起帶歪。
 */
const kindKey = (modelCourse: unknown, modelKind: unknown): string =>
  courseKey(modelCourse) + '\n' + String(modelKind ?? '')

/** `rejected` 的對應鍵：哪一個檔 ＋ 哪一個建議。 */
const rejectedKey = (itemId: unknown, summary: unknown): string =>
  String(itemId ?? '') + '\n' + String(summary ?? '')

/**
 * 歸檔的「建議摘要」：`課程/<課名>/<類型>`（**相對於 filed 的那一段，沒有絕對路徑**）。
 * 跟 FilingSuggestion.toFolder 是同一個字串，所以清單上對得起來。
 */
export const filingSummary = (folder: unknown): string => String(folder ?? '').slice(0, PREF_VALUE_MAX)

/** 改名的「建議摘要」：建議的檔名本身（只有檔名，沒有資料夾）。 */
export const renameSummary = (name: unknown): string => String(name ?? '').slice(0, PREF_VALUE_MAX)

/**
 * 比對「這是不是同一個建議」時用的折法。
 *
 * 存進去的是**好看的**寫法（`課程/OS/講義`），比對時兩邊都折一次 ——
 * 使用者退貨的當下與下一次列清單之間，課名的寫法可能差在空白、全形或大小寫
 * （既有資料夾的寫法會蓋過去），那還是同一個建議。折過頭的代價只是「沒標到」，
 * 而沒標到就是回到 P4 的行為（照樣列、照樣可以勾），**不會多勾任何東西**。
 */
const sameSuggestion = (summary: unknown): string => courseKey(summary)

// ── 讀（列清單、套用到建議上）──────────────────────────────

export type LearnedItem = {
  id: string
  kind: PrefKind
  /** 模型說什麼（`rejected` 那一種是「哪一個建議」的摘要） */
  from: string
  /** 你要什麼（`rejected` 那一種是空字串 —— 退貨沒有「要什麼」） */
  to: string
  times: number
  at: string
  /**
   * `rejected` 那一種「是哪一個建議」，而且**只有歸檔那一種有**（`課程/<課名>/<類型>`）。
   * 改名的摘要是真的檔名，規格講死了回給畫面的不可以有檔名，所以那一種是空字串。
   */
  about: string
}

/**
 * 學到的東西，整份載進記憶體。
 *
 * **一次查完**：列建議時一列一列去問資料庫，成本就跟檔案數成正比（五百個檔就是一千次查詢）。
 * 整張表本來就有 PREF_MAX 的上限，全部載進來是固定成本。
 *
 * 表不見了、查詢炸掉 → 回一個「什麼都沒學過」的 Learned（不變量 6），**不往上丟**。
 */
export type Learned = {
  /** 這堂課使用者怎麼寫。沒學過回空字串。**呼叫端一定要再洗一次才可以用**（不變量 2）。 */
  course: (modelCourse: unknown) => string
  /** 這堂課的這一種東西使用者叫它什麼。沒學過回空字串。呼叫端一樣要再過一次 kindFolder。 */
  kind: (modelCourse: unknown, modelKind: unknown) => string
  /** 這一個建議上次被退過嗎。 */
  rejected: (itemId: unknown, summary: unknown) => boolean
  /** 總共學過幾條（面板要決定畫不畫那一區）。 */
  size: number
}

const NOTHING: Learned = { course: () => '', kind: () => '', rejected: () => false, size: 0 }

export function loadLearned(db: DatabaseSync): Learned {
  let rows: { kind: string; k: string; v: string }[]
  try {
    rows = db.prepare('SELECT kind, k, v FROM preferences').all() as { kind: string; k: string; v: string }[]
  } catch { return NOTHING }
  const courses = new Map<string, string>()
  const kinds = new Map<string, string>()
  const rejected = new Set<string>()
  for (const r of rows) {
    // **每一列都當成可能是壞的**（稽核 2026-09-20）：舊版本、手改過的資料庫、遷移到一半，
    // k 或 v 都可能是 NULL。`r.k.indexOf` 會丟 TypeError 一路穿出去，那就不是「當成沒學過」，
    // 而是整個建議清單出不來 —— 不變量 7 要保護到這一段，不是只保護查詢。
    const k = typeof r?.k === 'string' ? r.k : ''
    const v = typeof r?.v === 'string' ? r.v : ''
    if (!k) continue
    if (r.kind === 'course') courses.set(k, v)
    else if (r.kind === 'file_kind') kinds.set(k, v)
    else if (r.kind === 'rejected') {
      // k 是 itemId＋換行＋摘要；比對時摘要要折過（見 sameSuggestion）
      const at = k.indexOf('\n')
      if (at > 0) rejected.add(k.slice(0, at) + '\n' + sameSuggestion(k.slice(at + 1)))
    }
  }
  return {
    course: modelCourse => courses.get(courseKeyOf(modelCourse)) ?? '',
    kind: (modelCourse, modelKind) => kinds.get(kindKey(modelCourse, modelKind)) ?? '',
    rejected: (itemId, summary) => rejected.has(String(itemId ?? '') + '\n' + sameSuggestion(summary)),
    size: rows.length,
  }
}

/** 學到的每一條，**最近的在前面**。`rejected` 那一種只回「哪一個建議」的摘要，不回別的。 */
export function listLearned(db: DatabaseSync, limit = PREF_MAX): {
  items: LearnedItem[]; evicted: { count: number; at: string | null }
} {
  const n = Math.max(1, Math.min(PREF_MAX, Math.floor(limit) || PREF_MAX))
  let rows: { id: string; kind: string; k: string; v: string; times: number; at: string }[] = []
  try {
    rows = db.prepare('SELECT id, kind, k, v, times, at FROM preferences ORDER BY at DESC, id LIMIT ?')
      .all(n) as typeof rows
  } catch { return { items: [], evicted: { count: 0, at: null } } }
  return {
    items: rows.map(r => {
      // 壞掉的列不可以讓整份清單炸掉（跟 loadLearned 同一個理由）
      const k = typeof r?.k === 'string' ? r.k : ''
      const v = typeof r?.v === 'string' ? r.v : ''
      const nl = k.indexOf('\n')
      return {
        id: String(r?.id ?? ''),
        kind: r.kind as PrefKind,
        // file_kind 的鍵是「課名＋換行＋類型」，換行不可以進畫面（會偽造一行字）。
        // **rejected 那一種一個字都不回**：改名的摘要是真的檔名，而規格講死了
        // 「回給畫面的沒有路徑、沒有檔名」（稽核 2026-09-20）。要忘掉它用 id 就夠了。
        from: r.kind === 'rejected' ? '' : k.replace('\n', ' / '),
        to: r.kind === 'rejected' ? '' : v,
        times: Number.isFinite(Number(r?.times)) ? Number(r.times) : 0,
        at: typeof r?.at === 'string' ? r.at : '',
        // 歸檔那一種的摘要（`課程/<課名>/<類型>`）本來就沒有檔名，留著讓畫面講得出是哪一個建議；
        // 改名那一種是檔名，一律不回。
        // 歸檔的摘要長 `課程/<課名>/<類型>`（有斜線），改名的摘要是**檔名**（cleanName 把斜線都拿掉了，
        // 所以一定沒有斜線）。用這個分辨：有斜線的留著讓畫面講得出是哪一個建議，檔名一律不回。
        about: r.kind === 'rejected' && nl > 0 && k.slice(nl + 1).includes('/') ? k.slice(nl + 1) : '',
      }
    }),
    evicted: evictedNote(db),
  }
}

function metaGet(db: DatabaseSync, k: string): string | null {
  try {
    return ((db.prepare('SELECT v FROM meta WHERE k=?').get(k) as { v: string } | undefined)?.v) ?? null
  } catch { return null }
}

function metaPut(db: DatabaseSync, k: string, v: string): void {
  try {
    db.prepare('INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v)
  } catch { /* 連 meta 都寫不進去就算了 —— 學習本身不可以讓 apply 失敗 */ }
}

/** 到目前為止丟掉了幾條、最後一次是什麼時候（不變量 8）。 */
function evictedNote(db: DatabaseSync): { count: number; at: string | null } {
  const raw = Number(metaGet(db, EVICTED_COUNT) ?? 0)
  return { count: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0, at: metaGet(db, EVICTED_AT) }
}

// ── 寫（只有使用者真的做過的動作會走到這裡）──────────────

/** 寫進去的時候順便擋一次：值是空的就不學（洗完是空的 ＝ 不是一個能用的偏好）。 */
function upsert(db: DatabaseSync, kind: PrefKind, k: string, v: string, at: string): void {
  if (!k || k.length > 1000) return
  const value = String(v ?? '').slice(0, PREF_VALUE_MAX)
  const when = String(at || new Date().toISOString())
  try {
    const row = db.prepare('SELECT id FROM preferences WHERE kind=? AND k=?').get(kind, k) as
      { id: string } | undefined
    if (row) {
      // 不變量 5：同一個鍵只有一列，最後一次贏，用過幾次要加上去
      db.prepare('UPDATE preferences SET v=?, times=times+1, at=? WHERE id=?').run(value, when, row.id)
      return
    }
    const id = randomUUID()
    db.prepare('INSERT INTO preferences (id,kind,k,v,times,at) VALUES (?,?,?,?,1,?)').run(id, kind, k, value, when)
    prune(db, id, when)
  } catch { /* 表不見了、CHECK 不過 → 當成沒學過（不變量 6） */ }
}

/**
 * 收到 PREF_MAX 列以內。**丟最舊、最少用的**（times 小、at 舊的先走）。
 *
 * `keep` 是剛剛才寫進去的那一列：**它一定留著**。一整批 apply 共用同一個時間戳，
 * 所以表滿了而且大家 times 都是 1 的時候，「at 最舊」會變成 uuid 抽籤 ——
 * 剛學到的東西有機會當場被自己擠掉，使用者會看到「我明明改了它卻沒記住」。
 */
function prune(db: DatabaseSync, keep: string, at: string): void {
  const n = (db.prepare('SELECT count(*) AS n FROM preferences').get() as { n: number }).n
  if (n <= PREF_MAX) return
  // **退過貨的先丟**（稽核 2026-09-20）：三種偏好共用同一個上限，而 rejected 那一種
  // 每按一次 undo 就多一列、times 永遠是 1，所以它會把使用者真的教過的課名與類型擠掉。
  // 兩者的價值差很多：課名是「我要這樣叫它」，退貨只是「這一個建議這次不要」——
  // 而且建議一變，退貨的標記本來就對不上任何東西了。
  const doomed = db.prepare(
    `SELECT id FROM preferences WHERE id <> ?
      ORDER BY (kind = 'rejected') DESC, times ASC, at ASC, id ASC LIMIT ?`
  ).all(keep, n - PREF_MAX) as { id: string }[]
  if (!doomed.length) return
  db.prepare(`DELETE FROM preferences WHERE id IN (${doomed.map(() => '?').join(',')})`)
    .run(...doomed.map(d => d.id))
  metaPut(db, EVICTED_COUNT, String(evictedNote(db).count + doomed.length))
  metaPut(db, EVICTED_AT, at)
}

/** 唯讀模式一律不學（不變量 7）。呼叫端已經擋過一次，這是第二道。 */
type Maybe = { readonly?: boolean } | undefined

/**
 * 「這一堂課使用者怎麼寫」。
 *
 * `userCourse` 一定要是**已經過 cleanCourse** 的值；洗完跟使用者原本打的折起來不一樣
 * （`../../etc` → `etc`）就**不學** —— 那不是使用者指名的寫法，是我們替他猜的，
 * 記下來只會讓之後的建議長出一個他沒要過的資料夾名。
 */
export function learnCourse(
  db: DatabaseSync, modelCourse: unknown, userRaw: unknown, userCourse: string, at: string, scope?: Maybe,
): void {
  if (scope?.readonly) return
  const key = courseKeyOf(modelCourse)
  if (!key) return
  if (!userCourse) return
  if (courseKey(userCourse) !== courseKey(userRaw)) return
  upsert(db, 'course', key, userCourse, at)
}

/** 「這一堂課的這一種東西，使用者叫它什麼」。`userKind` 要是已經過 kindFolder 的值。 */
export function learnKind(
  db: DatabaseSync, modelCourse: unknown, modelKind: unknown, userKind: string, at: string, scope?: Maybe,
): void {
  if (scope?.readonly) return
  if (!userKind) return
  // 模型沒講是哪一堂課 → 沒有「這一堂課的」可以學（全域偏好會把別堂課一起帶歪）
  if (!courseKey(modelCourse)) return
  upsert(db, 'file_kind', kindKey(modelCourse, modelKind), userKind, at)
}

/**
 * 「這一個建議被退貨了」（使用者 undo 了它）。
 *
 * 清單**還是會列**它 —— 退貨不是刪除，使用者可能只是想換個課名再來一次；
 * 但**不預設勾**，而且標一句「你上次退過」。重新做一次成功就清掉（forgetRejected）。
 */
export function rememberRejected(
  db: DatabaseSync, itemId: unknown, summary: string, at: string, scope?: Maybe,
): void {
  if (scope?.readonly) return
  if (!itemId || !summary) return
  upsert(db, 'rejected', rejectedKey(itemId, summary), '', at)
}

/** 同一個建議重新做一次成功 → 那個「退過貨」的標記要消失（預期行為 5）。 */
export function forgetRejected(db: DatabaseSync, itemId: unknown, summary: string, scope?: Maybe): void {
  if (scope?.readonly) return
  const want = String(itemId ?? '') + '\n' + sameSuggestion(summary)
  try {
    const rows = db.prepare(`SELECT id, k FROM preferences WHERE kind='rejected'`).all() as
      { id: string; k: string }[]
    // 折過比（見 sameSuggestion），所以不能直接用 k 當條件；表本來就有上限，整份掃很便宜
    const hit = rows.filter(r => {
      const at = r.k.indexOf('\n')
      return at > 0 && r.k.slice(0, at) + '\n' + sameSuggestion(r.k.slice(at + 1)) === want
    })
    if (!hit.length) return
    db.prepare(`DELETE FROM preferences WHERE id IN (${hit.map(() => '?').join(',')})`).run(...hit.map(h => h.id))
  } catch { /* 表不見了 → 本來就沒有標記要清（不變量 6） */ }
}

// ── 忘掉 ────────────────────────────────────────────────────

/** 忘掉指名的那幾條。回真的刪掉幾條（不存在的 id 不算錯 —— 使用者要的是「它不見了」）。 */
export function forgetLearned(db: DatabaseSync, ids: readonly string[]): number {
  const want = [...new Set(ids.map(String))].filter(Boolean).slice(0, FORGET_MAX)
  if (!want.length) return 0
  try {
    const before = (db.prepare('SELECT count(*) AS n FROM preferences').get() as { n: number }).n
    db.prepare(`DELETE FROM preferences WHERE id IN (${want.map(() => '?').join(',')})`).run(...want)
    const after = (db.prepare('SELECT count(*) AS n FROM preferences').get() as { n: number }).n
    return before - after
  } catch { return 0 }
}

/** 全部忘掉。連「丟掉過幾條」那筆紀錄也一起清 —— 使用者要的是回到什麼都沒學過。 */
export function forgetAllLearned(db: DatabaseSync): number {
  try {
    const before = (db.prepare('SELECT count(*) AS n FROM preferences').get() as { n: number }).n
    db.prepare('DELETE FROM preferences').run()
    try { db.prepare('DELETE FROM meta WHERE k IN (?,?)').run(EVICTED_COUNT, EVICTED_AT) }
    catch { /* meta 清不掉不影響「偏好都沒了」 */ }
    return before
  } catch { return 0 }
}
