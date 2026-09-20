/**
 * 背景佇列 —— 「哪些檔要問模型、照什麼順序問、什麼時候停」。
 *
 * **不可以卡住任何互動**（預想的不變量 5）：掃描只負責把檔寫進資料庫，這一支在背景跑，
 * 一次一個。pet 定時跑一輪，CLI 的 `think` 手動跑一輪。面板與掃描都不等它。
 *
 * ── 一輪做什麼 ───────────────────────────────────────────────
 *
 * 1. 模型沒開（沒 baseUrl／沒模型名字／沒金鑰）→ **什麼都不做**，一個請求都不送
 * 2. 挑出「還沒有看法、也還沒被跳過」的檔，只收兩種（預想表第 38 列）：
 *    有文字的文件（P1 讀得到 ≥ 30 個字）、有長相指紋的 PNG 截圖。其他不問
 * 3. 每一個檔：**先過 model-guard**（名字或內容像機密就不送，記一句為什麼）
 *    → 組出要送的東西（文字砍到 2000 字／圖片縮到長邊 1344 的灰階）
 *    → 算快取鍵（內容的 sha256 ＋ 提示詞版本）→ **命中就不送**
 *    → 送一次，成功就存進 model_views，失敗記一列 model_calls
 * 4. **連續失敗 3 次就這一輪停**，記 lastError（kind: model）。下一輪再試
 * 5. 同一個檔失敗滿 3 次（跨輪累計）就標成「問不到」，不再排進來
 *
 * ── 中途停 ───────────────────────────────────────────────────
 *
 * Ctrl+C 與 pet 結束走 AbortSignal。**取消不算失敗**：不記 model_calls、不動連續失敗的計數、
 * 不寫 lastError —— 使用者自己停的事不該讓寵物擔心。已經問完的那幾筆照樣留著（那是完整的一筆）。
 *
 * ── 預先塞的示範答案 ─────────────────────────────────────────
 *
 * `tools/demo-setup.mjs --seed-model` 會先把答案寫進 model_views（seeded=1）。那些檔因此
 * 「已經有看法」，**不會再被排進來**，所以真的接上模型跑 think 也不會把示範答案蓋掉
 * （預想的預期行為第 10 條）。要換成真的答案就改內容 —— 換了內容就是換了快取鍵。
 */
import type { DatabaseSync } from 'node:sqlite'
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from 'node:fs'
import type { Config } from './config.ts'
import { modelKey } from './config.ts'
import { under } from './guard.ts'
import {
  PROMPT_VERSION, askModel, imagePayload, longEnough, modelEnabled, textPayload,
  type AskInput, type ModelSource,
} from './model.ts'
import { SECRET_WHY, TOO_SHORT_WHY, UNANSWERED_WHY, UNUSABLE_WHY, screen, secretByName } from './model-guard.ts'
import {
  adoptModelView, failedCallCount, getModelView, putModelSkip, putModelView, recordModelCall,
  sweepModel, viewKey,
} from './model-store.ts'

/** 一輪最多處理幾個檔。7～10 秒一個，20 個就是三分鐘 —— 再多沒有意義，下一輪會接著做。 */
export const ROUND_MAX_ITEMS = 20

/** 連續失敗幾次就這一輪停。 */
export const STOP_AFTER_FAILURES = 3

/** 同一個檔最多失敗幾次，之後標成「問不到」。 */
export const MAX_ITEM_FAILURES = 3

/** 圖片最多讀多大（跟縮圖端點同一個上限）。 */
const IMAGE_MAX_BYTES = 64 * 1024 * 1024

/** 一輪最多記幾個「名字看起來像機密」。多的下一輪繼續記（一列一句話，會收斂）。 */
const NAME_BLOCKED_PER_ROUND = 200

/**
 * 「這個檔的內容最後一次被讀出來是什麼時候」。
 *
 * P0 的長相指紋（cleanup_image_sigs）與 P1 的文字（file_texts）都是**快取**：
 * 存的時候連 size 與 mtime 一起存，任一個對不上就重算 —— 所以它們的 `at` 一變新，
 * 就代表**內容變了**。看法（model_views）比它舊就是「那是舊內容的答案」，要重問。
 *
 * 兩張表都沒有列（一個 .zip）就退回 v.at，那種檔本來就不會被問。
 */
const CONTENT_AT = `COALESCE(
  (SELECT t.at FROM file_texts t WHERE t.item_id = i.id),
  (SELECT g.at FROM cleanup_image_sigs g WHERE g.item_id = i.id),
  v.at)`

/** 還在原位、讀得到的檔（搬進隔離區、不見了、讀不到的不問）。 */
const LIVE_ITEM = `i.status IN ('new','candidate','kept','restored') AND i.error IS NULL`

/**
 * 兄弟那一列用的「內容最後讀出來的時間」。
 *
 * 那條 `j.id <> i.id` 是寫給讀的人看的（「兄弟」的意思就是別的檔）。**效果上它是多餘的**：
 * j 就是 i 的時候，這裡算出來的時間跟上面的 CONTENT_AT 一模一樣，那一列在上面就已經被判過了 ——
 * 突變測試把它拿掉，整套照樣綠（見 mutations 的說明）。留著是因為少了它，這條子查詢讀起來
 * 像是「自己也算兄弟」，而那正是一個很難發現的錯法。
 */
const SIB_CONTENT_AT = `COALESCE(
  (SELECT t.at FROM file_texts t WHERE t.item_id = j.id),
  (SELECT g.at FROM cleanup_image_sigs g WHERE g.item_id = j.id),
  v.at)`

/** 跳過那一列用的「內容最後讀出來的時間」（沒有 v 可以參照，退回 s.at）。 */
const SKIP_CONTENT_AT = `COALESCE(
  (SELECT t.at FROM file_texts t WHERE t.item_id = i.id),
  (SELECT g.at FROM cleanup_image_sigs g WHERE g.item_id = i.id),
  s.at)`

type ItemRow = {
  id: string
  path: string
  name: string
  ext: string
  bytes: number
  sha256: string | null
  mtime: string
}

/** 一個排進來的工作：要問哪個檔、用文字問還是用圖問。 */
export type PendingItem = { id: string; name: string; source: ModelSource }

/**
 * 這一輪可以問的檔，照「最近看到的」排前面。
 *
 * 排除：
 * - 已經有看法的（直接對 item_id，或**內容一樣的兄弟**已經有 —— 複製出來的第二份不用再問）
 * - 已經記過跳過的，**除非那之後內容被重讀過**（file_texts.at 比跳過的時間新 ＝ 檔改過了）
 * - 不在清理範圍底下、狀態不在的、讀不到的
 */
export function pendingItems(db: DatabaseSync, roots: readonly string[], limit: number = ROUND_MAX_ITEMS): PendingItem[] {
  const rows = db.prepare(
    `SELECT i.id, i.path, i.name, i.ext, i.bytes, i.sha256, i.mtime
       FROM file_items i
      WHERE ${LIVE_ITEM}
        AND NOT EXISTS (SELECT 1 FROM model_skips s WHERE s.item_id = i.id AND s.at >= ${SKIP_CONTENT_AT})
        AND NOT EXISTS (SELECT 1 FROM model_views v WHERE v.item_id = i.id AND v.at >= ${CONTENT_AT})
        AND NOT EXISTS (SELECT 1 FROM model_views v JOIN file_items j ON j.id = v.item_id
                         WHERE j.id <> i.id AND i.sha256 IS NOT NULL AND j.sha256 = i.sha256
                           AND v.at >= ${SIB_CONTENT_AT})
      ORDER BY i.last_seen_at DESC, i.id`
  ).all() as ItemRow[]

  const out: PendingItem[] = []
  for (const r of rows) {
    if (out.length >= limit) break
    if (!roots.some(root => under(root, r.path))) continue
    const source = sourceFor(db, r)
    if (!source) continue
    out.push({ id: r.id, name: r.name, source })
  }
  return out
}

/**
 * 名字看起來像機密、而且還沒記過的檔。
 *
 * **為什麼要單獨一支**：`id_rsa`、`server.pem`、`.env` 這些檔**本來就不會被問**
 * （沒有文字層、也不是截圖），所以走不到 payloadFor 那一層的篩選 —— 而預想的預期行為
 * 第 3 條要的正是「`model_skips` 有一句『看起來像機密』」。使用者要看得到這道關真的在守著，
 * 不是「剛好沒問到」。doctor 的「幾個檔因為像機密沒送」也是數這一張表。
 */
export function nameBlockedItems(
  db: DatabaseSync, roots: readonly string[], limit: number = NAME_BLOCKED_PER_ROUND,
): { id: string; name: string; rule: string }[] {
  const rows = db.prepare(
    `SELECT i.id, i.path, i.name FROM file_items i
      WHERE ${LIVE_ITEM}
        AND NOT EXISTS (SELECT 1 FROM model_skips s WHERE s.item_id = i.id)
      ORDER BY i.last_seen_at DESC, i.id`
  ).all() as { id: string; path: string; name: string }[]
  const out: { id: string; name: string; rule: string }[] = []
  for (const r of rows) {
    if (out.length >= limit) break
    if (!roots.some(root => under(root, r.path))) continue
    const rule = secretByName(r.name)
    if (rule) out.push({ id: r.id, name: r.name, rule })
  }
  return out
}

/** 這個檔要用什麼問（拿不到就是不問）。 */
function sourceFor(db: DatabaseSync, r: ItemRow): ModelSource | null {
  const t = db.prepare('SELECT text, has_text FROM file_texts WHERE item_id=?').get(r.id) as
    { text: string | null; has_text: number } | undefined
  if (t && Number(t.has_text) === 1 && longEnough(t.text)) return 'text'
  if (String(r.ext).toLowerCase() === '.png') {
    const sig = db.prepare('SELECT item_id FROM cleanup_image_sigs WHERE item_id=?').get(r.id)
    if (sig) return 'image'
  }
  return null
}

/**
 * 讀一張圖。**檔案現在的樣子要跟資料庫記的對得上**（O_NOFOLLOW 開，再核對大小與 mtime）——
 * 掃描到現在被換掉的話這一輪不問，等下一次掃描。
 */
function readImage(path: string, bytes: number, mtime: string): Buffer | null {
  if (!Number.isFinite(bytes) || bytes > IMAGE_MAX_BYTES) return null
  let fd: number
  try { fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)) }
  catch { return null }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size !== bytes || st.mtime.toISOString() !== mtime) return null
    return readFileSync(fd)
  } catch { return null }
  finally { closeSync(fd) }
}

export type RoundProgress = {
  index: number
  total: number
  name: string
  /** 用什麼問的。連問都沒問（名字像機密）是 null */
  source: ModelSource | null
  outcome: 'asked' | 'cached' | 'skipped' | 'failed'
  /** 成功或命中快取時才有 */
  course?: string
  topic?: string
  confidence?: string
  /** 跳過或失敗的原因（人話、不含內容） */
  why?: string
}

export type RoundResult = {
  /** 模型這條線開著嗎。false 的時候底下全部是 0 */
  enabled: boolean
  /** 排進來幾個 */
  total: number
  /** 真的問到答案幾個 */
  asked: number
  /** 命中快取幾個 */
  cached: number
  /** 沒送出去幾個（像機密、太短、讀不到） */
  skipped: number
  /** 失敗幾次 */
  failed: number
  /** 連續失敗停掉的話是那一句話，沒停是 null */
  stopped: string | null
  /** 使用者按了 Ctrl+C（或 pet 結束） */
  cancelled: boolean
  /** 逐項（給 CLI 印） */
  steps: RoundProgress[]
}

export type RoundOptions = {
  db: DatabaseSync
  config: Config
  roots: readonly string[]
  limit?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  timeoutMs?: number
  onProgress?: (p: RoundProgress) => void
  /**
   * 連續失敗停掉的時候記一筆（CLI 與 pet 傳 recordCleanupError(db, e, 'model') 進來）。
   * 這一層不 import cleanup-routes —— 那支檔案是 HTTP 那一邊的，佇列不該依賴它。
   */
  onError?: (why: string) => void
  now?: () => Date
}

/** 一個檔要送的東西（過完篩選、縮圖與截斷之後）。 */
type Payload =
  | { ok: true; input: AskInput; payload: Buffer; charsSent: number; bytesSent: number }
  /** remember: true ＝ 這個原因要記進 model_skips（暫時性的不記，下一輪再試） */
  | { ok: false; why: string; remember: boolean }

/**
 * 組一個檔要送的東西。**篩選在最前面** —— 一個像機密的檔連讀都不用讀完就該退回。
 */
export function payloadFor(db: DatabaseSync, item: PendingItem, key: string): Payload {
  const row = db.prepare('SELECT id, path, name, ext, bytes, sha256, mtime FROM file_items WHERE id=?')
    .get(item.id) as ItemRow | undefined
  if (!row) return { ok: false, why: 'this file is no longer there', remember: false }

  if (item.source === 'text') {
    const t = db.prepare('SELECT text, has_text FROM file_texts WHERE item_id=?').get(item.id) as
      { text: string | null; has_text: number } | undefined
    const full = String(t?.text ?? '')
    if (!t || Number(t.has_text) !== 1 || !longEnough(full)) {
      return { ok: false, why: TOO_SHORT_WHY, remember: true }
    }
    // **整份文字都要過篩**（不是只有要送的那 2000 字）：第 3000 個字才出現的私鑰一樣要擋掉整個檔
    const s = screen({ name: row.name, text: full, key })
    if (!s.send) return { ok: false, why: s.why ?? SECRET_WHY, remember: true }
    const text = textPayload(full)
    return {
      ok: true,
      input: { source: 'text', text },
      payload: Buffer.from(text, 'utf8'),
      charsSent: [...text].length,
      bytesSent: Buffer.byteLength(text, 'utf8'),
    }
  }

  // 圖片：內容是像素，看不出「像不像機密」，只過名字那一層
  const s = screen({ name: row.name, key })
  if (!s.send) return { ok: false, why: s.why ?? SECRET_WHY, remember: true }
  const raw = readImage(row.path, Number(row.bytes), row.mtime)
  if (!raw) return { ok: false, why: 'cannot read this file right now (or it just changed); it will be tried next round', remember: false }
  try {
    const shrunk = imagePayload(raw)
    return {
      ok: true,
      input: { source: 'image', png: shrunk.bytes },
      payload: shrunk.bytes,
      charsSent: 0,
      bytesSent: shrunk.bytes.length,
    }
  } catch {
    // 解不開的 PNG 每一輪都重試只是白燒 CPU
    return { ok: false, why: UNUSABLE_WHY, remember: true }
  }
}

/**
 * 跑一輪。**保證不丟例外**（除了呼叫端自己給的 onProgress／onError 丟出來的）。
 *
 * 模型沒開就直接回 `{ enabled: false }`，一個請求都不送 —— 掃描、清理、面板全部照常。
 */
export async function thinkRound(opts: RoundOptions): Promise<RoundResult> {
  const { db, config, roots } = opts
  const now = opts.now ?? (() => new Date())
  const result: RoundResult = {
    enabled: false, total: 0, asked: 0, cached: 0, skipped: 0, failed: 0,
    stopped: null, cancelled: false, steps: [],
  }
  if (!modelEnabled(config)) return result
  result.enabled = true
  // 已經被取消了（pet 正在收尾、上一輪的 Ctrl+C）：**一個檔都不碰**。
  // 不擋的話，第一個檔還是會被讀出來、縮圖、記一列跳過 —— 使用者已經說停了。
  if (opts.signal?.aborted) { result.cancelled = true; return result }
  const key = modelKey(config)

  // ── 名字像機密的：連問都不問，先把「為什麼沒送」記下來 ──────
  //
  // 這一步要在挑工作之前做：`id_rsa`、`server.pem` 這些檔沒有文字層也不是截圖，
  // 本來就不會被排進來 —— 但使用者要看得到這道關真的在守著（預期行為第 3 條）。
  let blocked: { id: string; name: string; rule: string }[] = []
  try { blocked = nameBlockedItems(db, roots) }
  catch { blocked = [] }

  // **先記，再挑工作**：記完之後 pendingItems 才看得到那幾列跳過，
  // 不然一個「名字像機密、又剛好有文字」的檔會被數兩次（記一次、又排一次）
  for (const b of blocked) {
    try { putModelSkip(db, b.id, SECRET_WHY, now().toISOString()) } catch { /* 忙就下次 */ }
  }

  let items: PendingItem[] = []
  try { items = pendingItems(db, roots, opts.limit ?? ROUND_MAX_ITEMS) }
  catch { items = [] }
  result.total = blocked.length + items.length

  let index = 0
  for (const b of blocked) {
    index++
    result.skipped++
    const p: RoundProgress = {
      index, total: result.total, name: b.name, source: null, outcome: 'skipped', why: SECRET_WHY,
    }
    result.steps.push(p)
    try { opts.onProgress?.(p) } catch { /* 印壞了不可以讓這一輪掛掉 */ }
  }

  let inARow = 0
  for (const item of items) {
    if (opts.signal?.aborted) { result.cancelled = true; break }
    index++
    const step = (p: Partial<RoundProgress>): void => {
      const full = { index, total: result.total, name: item.name, source: item.source, ...p } as RoundProgress
      result.steps.push(full)
      try { opts.onProgress?.(full) } catch { /* 印壞了不可以讓這一輪掛掉 */ }
    }

    // 問了幾次都問不到：標起來，不再排進來
    let fails = 0
    try { fails = failedCallCount(db, item.id) } catch { fails = 0 }
    if (fails >= MAX_ITEM_FAILURES) {
      try { putModelSkip(db, item.id, UNANSWERED_WHY, now().toISOString()) } catch { /* 忙就下次 */ }
      result.skipped++
      step({ outcome: 'skipped', why: UNANSWERED_WHY })
      continue
    }

    let p: Payload
    try { p = payloadFor(db, item, key) }
    catch { p = { ok: false, why: UNUSABLE_WHY, remember: true } }
    if (!p.ok) {
      // **講得出為什麼沒送**（不變量 2）
      if (p.remember) {
        try { putModelSkip(db, item.id, p.why, now().toISOString()) } catch { /* 忙就下次 */ }
      }
      result.skipped++
      step({ outcome: 'skipped', why: p.why })
      continue
    }

    const cacheKey = viewKey(p.payload)
    let cached = null
    try { cached = getModelView(db, cacheKey) } catch { cached = null }
    if (cached) {
      // **同樣的內容只問一次**（不變量 7）
      try { adoptModelView(db, cacheKey, item.id) } catch { /* 忙就下次 */ }
      result.cached++
      step({
        outcome: 'cached',
        course: String(cached.course ?? ''), topic: String(cached.topic ?? ''),
        confidence: String(cached.confidence ?? ''),
      })
      continue
    }

    const r = await askModel(config, p.input, {
      signal: opts.signal, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs,
    })
    if (!r.ok && r.aborted) {
      // 使用者自己停的：不記帳、不算失敗、不留半筆
      result.cancelled = true
      break
    }
    const at = now().toISOString()
    try {
      recordModelCall(db, {
        at, item_id: item.id, source: item.source,
        bytes_sent: p.bytesSent, chars_sent: p.charsSent,
        ok: r.ok ? 1 : 0, ms: r.ms, error: r.ok ? null : r.error,
        blame: r.ok ? null : r.blame,
      })
    } catch { /* 帳本寫不進去不可以讓這一輪掛掉 */ }

    if (!r.ok) {
      inARow++
      result.failed++
      step({ outcome: 'failed', why: r.error })
      if (inARow >= STOP_AFTER_FAILURES) {
        result.stopped = `The model failed to answer ${STOP_AFTER_FAILURES} times in a row (last one: ${r.error}). This round stops here and it will try again next round.`
        try { opts.onError?.(result.stopped) } catch { /* 記不下來就算了 */ }
        break
      }
      continue
    }

    inARow = 0
    // **只有完整、格式正確的一筆才寫進去**（askModel 已經驗過形狀，壞的在那裡就變成失敗了）
    try {
      putModelView(db, {
        key: cacheKey, item_id: item.id, source: item.source,
        course: r.view.course, topic: r.view.topic, kind: r.view.kind,
        suggested_name: r.view.suggestedName, evidence: r.view.evidence, confidence: r.view.confidence,
        model: config.model.name, prompt_version: PROMPT_VERSION, at, seeded: 0,
      })
    } catch { /* 寫不進去下一輪會再問一次 */ }
    result.asked++
    step({ outcome: 'asked', course: r.view.course, topic: r.view.topic, confidence: r.view.confidence })
  }

  if (!result.cancelled) sweepModel(db)
  return result
}

/** 這一輪有沒有東西可以做（pet 用來決定要不要排）。 */
export function hasPending(db: DatabaseSync, roots: readonly string[]): boolean {
  try { return pendingItems(db, roots, 1).length > 0 } catch { return false }
}
