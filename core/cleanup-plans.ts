import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { CleanupFileItem } from './cleanup-scanner.ts'
import { DEFAULT_CHECK_MIN } from './cleanup-routes.ts'
import { CLEANUP_RULE_VERSION } from './cleanup-rules.ts'
import { CleanupError, initCleanup, transaction, withCleanupLock } from './cleanup-journal.ts'

export type PlanSnapshot = CleanupFileItem & {
  reasons: { id: string; kind: string; confidence: number; reason: string; evidence: string }[]
}
type PlanRow = {
  id: string; status: string; item_count: number; created_at: string
  applied_at: string | null; error: string | null
}

export function planRow(db: DatabaseSync, id: string): PlanRow {
  const row = db.prepare('SELECT * FROM cleanup_plans WHERE id=?').get(id) as PlanRow | undefined
  if (!row) throw new CleanupError('NOT_FOUND', '找不到這份清理計畫。')
  return row
}

export function planSnapshots(db: DatabaseSync, id: string): PlanSnapshot[] {
  return (db.prepare('SELECT snapshot FROM cleanup_snapshots WHERE plan_id=? ORDER BY rowid').all(id) as { snapshot: string }[])
    .map(r => JSON.parse(r.snapshot))
}

export function candidateIdsFor(db: DatabaseSync, planId: string, itemId: string): string[] {
  return (db.prepare(`SELECT p.candidate_id FROM cleanup_plan_items p
    JOIN cleanup_candidates c ON c.id=p.candidate_id WHERE p.plan_id=? AND c.item_id=?`).all(planId, itemId) as { candidate_id: string }[])
    .map(r => r.candidate_id)
}

/** Public plan DTO deliberately omits paths and internal snapshots. */
export function getPlan(db: DatabaseSync, id: string) {
  initCleanup(db)
  const p = planRow(db, id)
  const items = planSnapshots(db, id).map(i => {
    const reasons = i.reasons
    const skipped = candidateIdsFor(db, id, i.id).some(c =>
      (db.prepare('SELECT skipped FROM cleanup_plan_items WHERE plan_id=? AND candidate_id=?').get(id, c) as { skipped: number }).skipped === 1)
    return {
      itemId: i.id, name: i.name, bytes: i.bytes, mtime: i.mtime,
      candidateIds: reasons.map(r => r.id), skipped,
      reasons: reasons.map(({ id: _id, ...r }) => r),
    }
  })
  return { id: p.id, status: p.status, itemCount: p.item_count, createdAt: p.created_at,
    appliedAt: p.applied_at, error: p.error, bytes: items.reduce((n, i) => n + i.bytes, 0), items }
}

export function validateIds(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 5000 || value.some(v => typeof v !== 'string' || !v || v.length > 200)) {
    throw new CleanupError('BAD_BODY', '候選 id 必須是字串陣列，最多 5000 筆。')
  }
}

/** Omitted ids select current default-checked files; explicit ids opt in low confidence.
 * All reasons for a selected file travel together, and one file is moved only once.
 */
export function createPlan(db: DatabaseSync, opts: { candidateIds?: string[]; requestId?: string } = {}) {
  if (opts.candidateIds !== undefined) validateIds(opts.candidateIds)
  if (opts.requestId !== undefined && (typeof opts.requestId !== 'string' || !opts.requestId || opts.requestId.length > 200)) {
    throw new CleanupError('BAD_BODY', 'requestId 必須是 1 到 200 字元的字串。')
  }
  const selection = JSON.stringify(opts.candidateIds === undefined ? null : [...new Set(opts.candidateIds)].sort())
  return withCleanupLock(db, () => transaction(db, () => {
    if (opts.requestId) {
      const prior = db.prepare('SELECT * FROM cleanup_plan_requests WHERE request_id=?').get(opts.requestId) as
        { selection: string; plan_id: string } | undefined
      if (prior) {
        if (prior.selection !== selection) throw new CleanupError('CONFLICT', '同一個 requestId 不能指定不同候選。')
        return getPlan(db, prior.plan_id)
      }
    }
    const candidates = db.prepare(`SELECT c.* FROM cleanup_candidates c JOIN file_items i ON i.id=c.item_id
      WHERE c.status='proposed' AND c.rule_version=? AND i.status IN ('candidate','kept','restored') AND i.error IS NULL
        AND trim(c.reason)<>'' AND trim(c.evidence)<>''
      ORDER BY c.confidence DESC, c.id`).all(CLEANUP_RULE_VERSION) as any[]
    const ids = opts.candidateIds === undefined
      ? candidates.filter(c => c.confidence >= DEFAULT_CHECK_MIN).map(c => c.id)
      : [...new Set(opts.candidateIds)]
    const selected = new Set<string>()
    for (const id of ids) {
      const c = candidates.find(c => c.id === id)
      if (!c) throw new CleanupError('STALE_CANDIDATE', '候選已變更，請重新掃描並建立計畫。')
      selected.add(c.item_id)
    }
    if (!selected.size) throw new CleanupError('EMPTY_PLAN', '沒有選擇可清理的檔案。')
    // **只有還沒套用的（proposed）計畫佔住檔案。** 計畫是一次性的：套用過的
    // （applied／partial／error）不再佔住，失敗的檔要重試就建一份新計畫。
    // 以前連 partial／error 都佔住，一個永遠搬不動的檔會讓之後每一次清理都撞
    // CONFLICT（CLI 每晚回 2）。重送同一份（同一個 requestId）在上面就回舊計畫了，仍然冪等。
    for (const id of selected) {
      if (db.prepare(`SELECT 1 FROM cleanup_snapshots s JOIN cleanup_plans p ON p.id=s.plan_id
        WHERE s.item_id=? AND p.status='proposed' LIMIT 1`).get(id)) {
        throw new CleanupError('CONFLICT', '這個檔案已有待處理的清理計畫。')
      }
    }
    const id = randomUUID()
    db.prepare(`INSERT INTO cleanup_plans(id,status,item_count,created_at) VALUES (?,'proposed',?,?)`)
      .run(id, selected.size, new Date().toISOString())
    let position = 0
    for (const itemId of selected) {
      const item = db.prepare('SELECT * FROM file_items WHERE id=?').get(itemId)
      const reasons = candidates.filter(c => c.item_id === itemId)
        .map(({ id, kind, confidence, reason, evidence }) => ({ id, kind, confidence, reason, evidence }))
      db.prepare('INSERT INTO cleanup_snapshots VALUES (?,?,?)').run(id, itemId, JSON.stringify({ ...item, reasons }))
      for (const c of candidates.filter(c => c.item_id === itemId)) {
        db.prepare('INSERT INTO cleanup_plan_items VALUES (?,?,?,0)').run(id, c.id, position)
      }
      position++
    }
    if (opts.requestId) db.prepare('INSERT INTO cleanup_plan_requests VALUES (?,?,?)').run(opts.requestId, selection, id)
    return getPlan(db, id)
  }))
}

export function dismissPlan(db: DatabaseSync, id: string) {
  return withCleanupLock(db, () => transaction(db, () => {
    const p = planRow(db, id)
    if (p.status === 'dismissed') return getPlan(db, id)
    if (p.status !== 'proposed' || db.prepare('SELECT 1 FROM cleanup_journal WHERE plan_id=? LIMIT 1').get(id)) {
      throw new CleanupError('CONFLICT', '計畫已開始執行，請使用復原。')
    }
    db.prepare(`UPDATE cleanup_candidates SET status='dismissed' WHERE id IN
      (SELECT candidate_id FROM cleanup_plan_items WHERE plan_id=?)`).run(id)
    db.prepare(`UPDATE cleanup_plans SET status='dismissed' WHERE id=?`).run(id)
    return getPlan(db, id)
  }))
}

/**
 * 放棄一份**還沒開始**的計畫：計畫設成 dismissed，**候選不動**。
 *
 * 跟 dismissPlan 的差別：dismissPlan 是「使用者拒絕這些檔」，會把候選一起作廢；
 * 這一支是「上次那份卡住了，我不要它了」—— 那些檔還是候選，下一份計畫要收得進去。
 * 面板撞到卡住的計畫時給的「放棄上次那份」就是呼叫這一支（RC4／RC8）。
 *
 * 只允許沒有任何 journal 的 proposed 計畫：一旦開始搬，就只能用復原，不能假裝沒發生過。
 * 已經是 dismissed 的再送一次回原樣（冪等）—— 網路斷線後重送不該變成錯誤。
 */
export function releasePlan(db: DatabaseSync, id: string) {
  return withCleanupLock(db, () => transaction(db, () => {
    const p = planRow(db, id)
    if (p.status === 'dismissed') return getPlan(db, id)
    if (p.status !== 'proposed' || db.prepare('SELECT 1 FROM cleanup_journal WHERE plan_id=? LIMIT 1').get(id)) {
      throw new CleanupError('CONFLICT', '這份計畫已經開始執行，不能放棄；要還原請用復原。')
    }
    db.prepare(`UPDATE cleanup_plans SET status='dismissed' WHERE id=?`).run(id)
    return getPlan(db, id)
  }))
}
