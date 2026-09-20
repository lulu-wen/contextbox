/**
 * `model_views`／`model_calls`／`model_skips` 這三張表的存取。DDL 在 db.ts。
 *
 * - **model_views 是快取，也是結果**。鍵是「內容的 sha256 ＋ 提示詞版本」，不是檔案路徑：
 *   同一份檔複製兩份，第二份直接命中；改過內容的重問（第一份的答案還在，但配不上新內容）。
 * - **model_calls 是帳本**：每一次真的送出去都留一列（送了多少字／多大的圖、幾毫秒、成不成功）。
 *   使用者查得到「今天送了幾次」。**不存內容**。
 * - **model_skips 是「沒送出去的與為什麼」**：看起來像機密的、太短的、問了幾次都問不到的。
 *
 * ── item_id 的意思 ──────────────────────────────────────────
 *
 * `model_views.item_id` 是「最近一次是哪個檔」，**不是主鍵**（DDL 就這樣寫）。兩份一模一樣的檔
 * 共用一列，那一列只記得住一個 item。所以畫面要拿一個檔的看法時走 modelViewForItem：
 * 先直接對 item_id，對不到就找「sha256 跟它一樣的兄弟」—— 內容一樣，看法本來就一樣。
 */
import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { PROMPT_VERSION } from './model.ts'

export type ModelViewRow = {
  key: string
  item_id: string | null
  source: string
  course: string | null
  topic: string | null
  kind: string | null
  suggested_name: string | null
  evidence: string | null
  confidence: string | null
  model: string
  prompt_version: string
  at: string
  seeded: number
}

export type ModelCallRow = {
  at: string
  item_id: string | null
  source: string
  bytes_sent: number | null
  chars_sent: number | null
  ok: number
  ms: number | null
  error: string | null
  /** 失敗算誰的帳：'answer'（這個檔）／'transport'（環境）。成功時不用給 */
  blame?: 'answer' | 'transport' | null
}

/**
 * 留幾列。跟 file_texts 一樣的理由：這個專案從來不刪 file_items 的列，
 * 沒有上限就會一輩子長下去。
 */
export const MAX_MODEL_VIEWS = 5000
/** 帳本留幾列（doctor 只看今天，但查得到前幾天也有用）。 */
export const MAX_MODEL_CALLS = 2000

/** 快取鍵：內容的 sha256 ＋ ':' ＋ 提示詞版本。 */
export function viewKey(payload: Buffer | Uint8Array | string, promptVersion: string = PROMPT_VERSION): string {
  const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload)
  return createHash('sha256').update(buf).digest('hex') + ':' + promptVersion
}

/**
 * 「這個檔的內容最後一次被讀出來是什麼時候」（跟 core/model-queue.ts 同一個判斷）。
 *
 * P0 的長相指紋與 P1 的文字都是**快取**（存的時候連 size 與 mtime 一起存，對不上就重算），
 * 所以它們的 `at` 一變新就代表內容變了。看法比它舊 ＝ **那是舊內容的答案**，不可以拿來給畫面看。
 */
const freshAt = (idExpr: string) => `COALESCE(
  (SELECT t.at FROM file_texts t WHERE t.item_id = ${idExpr}),
  (SELECT g.at FROM cleanup_image_sigs g WHERE g.item_id = ${idExpr}),
  '')`

/** 照鍵拿（快取命中就是這一支）。 */
export function getModelView(db: DatabaseSync, key: string): ModelViewRow | null {
  return (db.prepare('SELECT * FROM model_views WHERE key=?').get(key) as ModelViewRow | undefined) ?? null
}

/** 寫一列（同一個鍵就蓋掉上一次的）。 */
export function putModelView(db: DatabaseSync, row: ModelViewRow): void {
  db.prepare(
    `INSERT INTO model_views
       (key,item_id,source,course,topic,kind,suggested_name,evidence,confidence,model,prompt_version,at,seeded)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET
       item_id=excluded.item_id, source=excluded.source, course=excluded.course, topic=excluded.topic,
       kind=excluded.kind, suggested_name=excluded.suggested_name, evidence=excluded.evidence,
       confidence=excluded.confidence, model=excluded.model, prompt_version=excluded.prompt_version,
       at=excluded.at, seeded=excluded.seeded`
  ).run(
    row.key, row.item_id, row.source, row.course, row.topic, row.kind, row.suggested_name,
    row.evidence, row.confidence, row.model, row.prompt_version, row.at, row.seeded ? 1 : 0,
  )
}

/**
 * 快取命中之後：那一列記的檔如果已經不在了（被清掉、改名、搬走），就換成現在這個檔。
 * **還在的話不動** —— 動了的話兩份一模一樣的檔會每一輪互搶那一列，於是每一輪都重算一次內容。
 */
export function adoptModelView(db: DatabaseSync, key: string, itemId: string): void {
  db.prepare(
    `UPDATE model_views SET item_id=?
      WHERE key=? AND (item_id IS NULL OR item_id NOT IN (SELECT id FROM file_items))`
  ).run(itemId, key)
}

/**
 * 一個檔的看法。先直接對 item_id；對不到就找 sha256 一樣的兄弟（同樣的內容，同樣的看法）。
 * 兩邊都沒有回 null。
 */
export function modelViewForItem(db: DatabaseSync, itemId: string): ModelViewRow | null {
  const direct = db.prepare(
    `SELECT * FROM model_views WHERE item_id=? AND at >= ${freshAt('model_views.item_id')}
      ORDER BY at DESC, key LIMIT 1`
  ).get(itemId) as ModelViewRow | undefined
  if (direct) return direct
  const sibling = db.prepare(
    `SELECT v.* FROM model_views v JOIN file_items j ON j.id = v.item_id
      WHERE j.sha256 IS NOT NULL
        AND j.sha256 = (SELECT sha256 FROM file_items WHERE id=?)
        AND v.at >= ${freshAt('j.id')}
      ORDER BY v.at DESC, v.key LIMIT 1`
  ).get(itemId) as ModelViewRow | undefined
  return sibling ?? null
}

/** 畫面上要顯示的樣子。**沒有路徑、沒有鍵**，而且標明是模型的意見。 */
export type ModelOpinion = {
  course: string
  topic: string
  kind: string
  suggestedName: string
  evidence: string
  confidence: string
  /** 哪一個模型講的 */
  model: string
  at: string
  /** true ＝ demo 預先塞的示範答案，畫面要標示 */
  seeded: boolean
}

const str = (v: unknown) => typeof v === 'string' ? v : ''

/** 一列 → 畫面要的樣子。 */
export function opinionOf(row: ModelViewRow | null): ModelOpinion | null {
  if (!row) return null
  return {
    course: str(row.course),
    topic: str(row.topic),
    kind: str(row.kind),
    suggestedName: str(row.suggested_name),
    evidence: str(row.evidence),
    confidence: str(row.confidence),
    model: str(row.model),
    at: str(row.at),
    seeded: Number(row.seeded) === 1,
  }
}

/** 一批檔的看法（面板用）。拿不到的不放進 Map。 */
export function opinionsFor(db: DatabaseSync, itemIds: readonly string[]): Map<string, ModelOpinion> {
  const out = new Map<string, ModelOpinion>()
  for (const id of itemIds) {
    let o: ModelOpinion | null = null
    try { o = opinionOf(modelViewForItem(db, id)) } catch { o = null }
    if (o) out.set(id, o)
  }
  return out
}

/** 記一次真的送出去（成功與失敗都記）。**不存內容。** */
export function recordModelCall(db: DatabaseSync, row: ModelCallRow): void {
  db.prepare(
    `INSERT INTO model_calls (at,item_id,source,bytes_sent,chars_sent,ok,ms,error,blame)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(row.at, row.item_id, row.source, row.bytes_sent, row.chars_sent, row.ok ? 1 : 0, row.ms, row.error,
        row.blame ?? null)
}

/**
 * 這個檔**答不出來**幾次（同一個檔最多重試 3 次，之後標成「問不到」）。
 *
 * **只數 blame='answer'**：模型有回應、但答案不能用，那才是這個檔的問題。
 * 連不上、逾時、5xx 是 transport，跟這個檔無關 —— 以前一起數，閘道掛三十分鐘就把排在
 * 前面的幾個檔永久燒掉，改了內容也回不來（P2 驗證員）。舊資料沒有 blame（NULL）不數。
 */
export function failedCallCount(db: DatabaseSync, itemId: string): number {
  const r = db.prepare(
    `SELECT count(*) AS n FROM model_calls WHERE item_id=? AND ok=0 AND blame='answer'`
  ).get(itemId) as { n: number }
  return Number(r?.n ?? 0)
}

/** 記一個沒送出去的檔與為什麼。 */
export function putModelSkip(db: DatabaseSync, itemId: string, why: string, at: string = new Date().toISOString()): void {
  db.prepare(
    `INSERT INTO model_skips (item_id,why,at) VALUES (?,?,?)
     ON CONFLICT(item_id) DO UPDATE SET why=excluded.why, at=excluded.at`
  ).run(itemId, String(why).slice(0, 200), at)
}

export type ModelSkipRow = { item_id: string; why: string; at: string }

export function modelSkipOf(db: DatabaseSync, itemId: string): ModelSkipRow | null {
  return (db.prepare('SELECT * FROM model_skips WHERE item_id=?').get(itemId) as ModelSkipRow | undefined) ?? null
}

export type ModelStats = {
  /** 今天送出去幾次 */
  calls: number
  ok: number
  failed: number
  /** 平均幾毫秒（只算成功的；沒有就是 null） */
  avgMs: number | null
  /** 現在有幾個檔因為看起來像機密沒送 */
  secretSkips: number
  /** 現在總共有幾個檔沒送（含太短、問不到） */
  skips: number
  /** 快取裡有幾筆看法，其中幾筆是 demo 預先塞的 */
  views: number
  seeded: number
}

/**
 * doctor 要的數字。`since` 是「今天」的起點（ISO），呼叫端自己算 —— 這一層不決定時區。
 */
export function modelStats(db: DatabaseSync, since: string): ModelStats {
  const one = (sql: string, ...args: unknown[]) => {
    try { return db.prepare(sql).get(...(args as any[])) as Record<string, unknown> } catch { return {} }
  }
  const c = one(
    `SELECT count(*) AS calls,
            sum(CASE WHEN ok=1 THEN 1 ELSE 0 END) AS ok,
            sum(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS failed,
            avg(CASE WHEN ok=1 THEN ms END) AS avg_ms
       FROM model_calls WHERE at >= ?`, since)
  const s = one(
    `SELECT count(*) AS skips,
            sum(CASE WHEN why LIKE '%looks like a secret%' THEN 1 ELSE 0 END) AS secret
       FROM model_skips`)
  const v = one(`SELECT count(*) AS views, sum(seeded) AS seeded FROM model_views`)
  const n = (x: unknown) => Number(x ?? 0) || 0
  const avg = c.avg_ms == null ? null : Math.round(Number(c.avg_ms))
  return {
    calls: n(c.calls), ok: n(c.ok), failed: n(c.failed),
    avgMs: Number.isFinite(avg as number) ? avg : null,
    secretSkips: n(s.secret), skips: n(s.skips),
    views: n(v.views), seeded: n(v.seeded),
  }
}

/**
 * 收掉不再需要的列。
 *
 * - `model_skips`：對應的 file_items 不在了就清掉（那個檔已經不在清理範圍裡）
 * - `model_views`：超過上限時留最近的（**預先塞的示範答案先留**：demo 沒有模型可以重問）
 * - `model_calls`：超過上限時留最近的
 */
export function sweepModel(db: DatabaseSync): void {
  try {
    db.exec(`DELETE FROM model_skips WHERE item_id NOT IN (SELECT id FROM file_items);`)
    db.prepare(
      `DELETE FROM model_views WHERE key IN (
         SELECT key FROM model_views ORDER BY seeded DESC, at DESC, key LIMIT -1 OFFSET ?)`
    ).run(MAX_MODEL_VIEWS)
    db.prepare(
      `DELETE FROM model_calls WHERE id IN (
         SELECT id FROM model_calls ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?)`
    ).run(MAX_MODEL_CALLS)
  } catch { /* 收不掉只是多幾列，不可以讓這一輪失敗 */ }
}
