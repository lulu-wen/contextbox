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

const released = (db: DatabaseSync, id: string) =>
  Boolean(db.prepare('SELECT 1 FROM cleanup_plan_releases WHERE plan_id=?').get(id))

/**
 * 使用者**拒絕**這份計畫裡的檔：計畫設成 dismissed，候選一起作廢。
 *
 * 已經 dismissed 的分兩種（稽核第二輪 R2-12）：
 * - 之前是 dismiss 的 → 原樣回傳（冪等）
 * - 之前是 **release** 的（有 release 標記）→ 候選照樣作廢、拿掉標記。以前兩種都原樣回 200，
 *   「先放棄、之後才拒絕」拿到成功，候選卻沒作廢，下次掃描照樣提議。
 *   已經在隔離區的候選（release 之後別份計畫搬走的）不動：那是另一份計畫的結果。
 *
 * **這份計畫裡的檔，有任何一個在另一份還沒套用（proposed）的計畫裡 → CONFLICT，什麼都不改**（第二階段）。
 * 只有 release 過的計畫會碰到：release 之後那些檔還是候選，可以建進新的計畫 B。以前照樣作廢候選，
 * 清單說「拒絕了」，B 照樣把檔搬走（第一階段驗證員 T9）。為什麼不是「跳過 B 佔著的、其他照樣作廢」：
 * dismiss 的意思是「使用者拒絕這些檔」，跳過等於回 200 卻有一部分沒拒絕成、B 之後照搬 —— 使用者
 * 以為拒絕了。CONFLICT 讓呼叫端先處理 B（拒絕或放棄它），這邊整個不動，重送一樣的結果。
 * 比的是**檔**（cleanup_snapshots 的 item_id），跟 createPlan 判斷「這個檔已有待處理的計畫」同一個條件：
 * 重掃之後 B 可能用了同一個檔的另一條候選，只比候選 id 會漏。
 */
export function dismissPlan(db: DatabaseSync, id: string) {
  return withCleanupLock(db, () => transaction(db, () => {
    const p = planRow(db, id)
    if (p.status === 'dismissed' && !released(db, id)) return getPlan(db, id)
    if (p.status !== 'dismissed' && (p.status !== 'proposed' || db.prepare('SELECT 1 FROM cleanup_journal WHERE plan_id=? LIMIT 1').get(id))) {
      throw new CleanupError('CONFLICT', '計畫已開始執行，請使用復原。')
    }
    if (db.prepare(`SELECT 1 FROM cleanup_snapshots s JOIN cleanup_snapshots o ON o.item_id=s.item_id AND o.plan_id<>s.plan_id
        JOIN cleanup_plans op ON op.id=o.plan_id WHERE s.plan_id=? AND op.status='proposed' LIMIT 1`).get(id)) {
      throw new CleanupError('CONFLICT', '這份計畫裡的檔已經在另一份還沒套用的清理計畫裡；要拒絕它們，請先拒絕或放棄那一份。')
    }
    db.prepare(`UPDATE cleanup_candidates SET status='dismissed' WHERE status<>'quarantined' AND id IN
      (SELECT candidate_id FROM cleanup_plan_items WHERE plan_id=?)`).run(id)
    db.prepare(`UPDATE cleanup_plans SET status='dismissed' WHERE id=?`).run(id)
    db.prepare('DELETE FROM cleanup_plan_releases WHERE plan_id=?').run(id)
    return getPlan(db, id)
  }))
}

/** 放棄一份計畫的本體（呼叫端已經拿鎖、開交易，也確認過它還沒開始）：設成 dismissed，記一筆 release 標記。 */
function release(db: DatabaseSync, id: string) {
  db.prepare(`UPDATE cleanup_plans SET status='dismissed' WHERE id=?`).run(id)
  db.prepare('INSERT INTO cleanup_plan_releases(plan_id,at) VALUES (?,?) ON CONFLICT(plan_id) DO NOTHING')
    .run(id, new Date().toISOString())
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
 * 之前是 dismiss（使用者拒絕過）的也原樣回傳：候選維持作廢，不記 release 標記。
 *
 * **另外記一筆 release 標記**（cleanup_plan_releases）：只看 status 分不出 release 與 dismiss，
 * 舊版遷移（repairLegacyDismissed）會把 release 過的當成「使用者拒絕過」（稽核第二輪 R2-12）。
 */
export function releasePlan(db: DatabaseSync, id: string) {
  return withCleanupLock(db, () => transaction(db, () => {
    const p = planRow(db, id)
    if (p.status === 'dismissed') return getPlan(db, id)
    if (p.status !== 'proposed' || db.prepare('SELECT 1 FROM cleanup_journal WHERE plan_id=? LIMIT 1').get(id)) {
      throw new CleanupError('CONFLICT', '這份計畫已經開始執行，不能放棄；要還原請用復原。')
    }
    release(db, id)
    return getPlan(db, id)
  }))
}

/**
 * 自動放棄**放了很久、從沒開始**的計畫：status 是 proposed、沒有任何 journal、
 * 建立超過 olderThanMs。語意跟 releasePlan 一樣（候選不動、記 release 標記）。回傳放棄了幾份。
 *
 * 為什麼要：一份建了沒套用的計畫會一直佔住它的檔（createPlan 撞 CONFLICT），寵物也一直說
 * 「有 1 份清單等你確認」，而面板不一定找得到它（稽核第二輪 R2-5）。**有 journal 的不動**：
 * 做到一半中斷的計畫只能接著做完或復原，不能假裝沒發生過。建立時間讀不懂的也不動（fail closed）。
 */
export function releaseStalePlans(db: DatabaseSync, olderThanMs: number): number {
  if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
    throw new CleanupError('BAD_CONFIG', '自動放棄計畫的時間要是 0 以上的毫秒數。')
  }
  return withCleanupLock(db, () => transaction(db, () => {
    const cutoff = Date.now() - olderThanMs
    const stale = (db.prepare(`SELECT id, created_at FROM cleanup_plans p WHERE status='proposed'
      AND NOT EXISTS (SELECT 1 FROM cleanup_journal j WHERE j.plan_id=p.id)`).all() as { id: string; created_at: string }[])
      .filter(p => Date.parse(p.created_at) < cutoff)
    for (const p of stale) release(db, p.id)
    return stale.length
  }))
}
