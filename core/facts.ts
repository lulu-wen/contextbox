/**
 * 事實庫
 *
 * 三條規則，程式碼裡強制：
 *   1. 模型只能 propose，產出永遠是 candidate。只有 confirm() 能變成事實。
 *   2. 敏感度與到期日從 key 註冊表拿，呼叫端說了不算。
 *   3. 每一次寫入都先進 journal，復原就是把 journal 倒著放回去。
 */
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { vet, parseKey } from './validate.ts'
import { defOf, fillModeOf, canAutofill } from '../schema/factKeys.ts'

export type SourceKind = 'file' | 'manual' | 'web' | 'derived'
export type Status = 'candidate' | 'confirmed' | 'rejected' | 'stale' | 'superseded'

export type Row = {
  id: string; key: string; key_def: string; idx: number | null
  value: string; status: Status; confidence: number | null; sensitivity: string
  source_kind: SourceKind; source_ref: string | null
  source_quote: string | null; source_page: number | null
  supersedes: string | null
  created_at: string; confirmed_at: string | null
  refreshed_at: string | null; expires_at: string | null
}

export type Fact = Omit<Row, 'value'> & { value: unknown }

const hydrate = (r: Row): Fact => ({ ...r, value: JSON.parse(r.value) })

export class Facts {
  // 不用 constructor(private db) —— Node 的 strip-only 模式不支援參數屬性
  db: DatabaseSync
  constructor(db: DatabaseSync) { this.db = db }

  // ── journal ────────────────────────────────────────────────
  /** 動作前後的整列快照都存起來，復原才不用猜 */
  private log(op: string, factId: string | null, before: Row[], after: Row[]) {
    this.db.prepare(
      `INSERT INTO journal (ts, op, fact_id, before, after) VALUES (?,?,?,?,?)`
    ).run(new Date().toISOString(), op, factId,
          JSON.stringify(before), JSON.stringify(after))
  }

  private row(id: string): Row | null {
    return (this.db.prepare(`SELECT * FROM facts WHERE id=?`).get(id) as Row) ?? null
  }

  // ── 寫入 ───────────────────────────────────────────────────
  /**
   * 提出一筆候選。模型與抽取層只能走這裡。
   * 不管 confidence 多高，出來一律是 candidate。
   */
  propose(input: {
    key: string; value: unknown
    source: { kind: SourceKind; ref?: string; quote?: string; page?: number }
    confidence?: number
    expiresAt?: string | null
  }): Fact {
    const now = new Date()
    const v = vet(input.key, input.value, now, input.expiresAt)
    const id = randomUUID()

    this.db.prepare(`INSERT INTO facts
      (id,key,key_def,idx,value,status,confidence,sensitivity,
       source_kind,source_ref,source_quote,source_page,created_at,expires_at)
      VALUES (?,?,?,?,?,'candidate',?,?,?,?,?,?,?,?)`)
      .run(id, input.key, v.keyDef, v.idx, JSON.stringify(v.value),
           input.confidence ?? null, v.sensitivity,
           input.source.kind, input.source.ref ?? null,
           input.source.quote ?? null, input.source.page ?? null,
           now.toISOString(), v.expiresAt)

    const row = this.row(id)!
    this.log('fact.propose', id, [], [row])
    return hydrate(row)
  }

  /**
   * 人點頭。同一個 key 已經有確認過的事實，舊的轉成 superseded，新的指回去。
   * 舊的不刪——履歷本來就需要歷史。
   */
  confirm(id: string): Fact {
    const row = this.row(id)
    if (!row) throw new Error(`沒有這筆事實：${id}`)
    if (row.status !== 'candidate') throw new Error(`只有 candidate 能確認，這筆是 ${row.status}`)

    const prev = this.db.prepare(
      `SELECT * FROM facts WHERE key=? AND status='confirmed' AND id!=?`
    ).all(row.key, id) as Row[]

    const before = [row, ...prev]
    const now = new Date().toISOString()

    for (const p of prev) {
      this.db.prepare(`UPDATE facts SET status='superseded' WHERE id=?`).run(p.id)
    }
    this.db.prepare(
      `UPDATE facts SET status='confirmed', confirmed_at=?, supersedes=? WHERE id=?`
    ).run(now, prev[0]?.id ?? null, id)

    const after = [this.row(id)!, ...prev.map(p => this.row(p.id)!)]
    this.log('fact.confirm', id, before, after)
    return hydrate(this.row(id)!)
  }

  reject(id: string): Fact {
    const row = this.row(id)
    if (!row) throw new Error(`沒有這筆事實：${id}`)
    this.db.prepare(`UPDATE facts SET status='rejected' WHERE id=?`).run(id)
    const after = this.row(id)!
    this.log('fact.reject', id, [row], [after])
    return hydrate(after)
  }

  /** 人自己填的。不用再確認自己一次，直接 confirmed。 */
  manual(key: string, value: unknown): Fact {
    const f = this.propose({ key, value, source: { kind: 'manual', ref: 'user' }, confidence: 1 })
    return this.confirm(f.id)
  }

  // ── 讀取 ───────────────────────────────────────────────────
  get(key: string): Fact | null {
    const r = this.db.prepare(
      `SELECT * FROM facts WHERE key=? AND status='confirmed' ORDER BY confirmed_at DESC LIMIT 1`
    ).get(key) as Row | undefined
    return r ? hydrate(r) : null
  }

  /** 某個 key 定義下的所有確認事實。education[].school 會回傳三筆。 */
  allOf(keyDef: string): Fact[] {
    return (this.db.prepare(
      `SELECT * FROM facts WHERE key_def=? AND status='confirmed' ORDER BY idx, confirmed_at`
    ).all(keyDef) as Row[]).map(hydrate)
  }

  list(status: Status): Fact[] {
    return (this.db.prepare(
      `SELECT * FROM facts WHERE status=? ORDER BY created_at DESC`
    ).all(status) as Row[]).map(hydrate)
  }

  /**
   * 擴充套件要的東西：一組 key，回傳每一個能不能填、填什麼。
   * 這裡是唯一決定「要不要問人」的地方。
   */
  forForm(keyDefs: string[]) {
    return keyDefs.map(kd => {
      const def = defOf(kd)
      if (!def) return { key: kd, action: 'unknown' as const }

      const mode = fillModeOf(def)
      const hits = this.allOf(kd)

      if (mode === 'compose') {
        return { key: kd, action: 'compose' as const, label: def.label }
      }
      if (hits.length === 0) {
        return { key: kd, action: 'missing' as const, label: def.label }
      }
      if (!canAutofill(kd)) {
        return { key: kd, action: 'confirm-each-time' as const, label: def.label,
                 value: hits[0].value, sensitivity: def.sensitivity,
                 source: hits[0].source_ref }
      }
      if (mode === 'pick' && hits.length > 1) {
        return { key: kd, action: 'pick' as const, label: def.label,
                 options: hits.map(h => ({ id: h.id, value: h.value, source: h.source_ref })) }
      }
      return { key: kd, action: 'fill' as const, label: def.label,
               value: hits[0].value, source: hits[0].source_ref }
    })
  }

  // ── 時效 ───────────────────────────────────────────────────
  /** 到期的確認事實標成 stale，排程器每天跑一次 */
  sweepStale(now = new Date()): Fact[] {
    const due = this.db.prepare(
      `SELECT * FROM facts WHERE status='confirmed' AND expires_at IS NOT NULL AND expires_at < ?`
    ).all(now.toISOString()) as Row[]

    for (const r of due) {
      this.db.prepare(`UPDATE facts SET status='stale' WHERE id=?`).run(r.id)
      this.log('fact.stale', r.id, [r], [this.row(r.id)!])
    }
    return due.map(r => hydrate(this.row(r.id)!))
  }

  // ── 復原 ───────────────────────────────────────────────────
  /** 把 journal 倒著放回去。before 是空的就代表那筆本來不存在，刪掉。 */
  undoLast(n = 1) {
    const entries = this.db.prepare(
      `SELECT * FROM journal WHERE undone=0 ORDER BY seq DESC LIMIT ?`
    ).all(n) as { seq: number; before: string; after: string }[]

    for (const e of entries) {
      const before: Row[] = JSON.parse(e.before)
      const after: Row[] = JSON.parse(e.after)
      const restored = new Set(before.map(r => r.id))

      for (const r of before) {
        this.db.prepare(`DELETE FROM facts WHERE id=?`).run(r.id)
        const cols = Object.keys(r)
        this.db.prepare(
          `INSERT INTO facts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
        ).run(...cols.map(c => (r as any)[c]))
      }
      for (const r of after) {
        if (!restored.has(r.id)) this.db.prepare(`DELETE FROM facts WHERE id=?`).run(r.id)
      }
      this.db.prepare(`UPDATE journal SET undone=1 WHERE seq=?`).run(e.seq)
    }
    return entries.length
  }

  journal(limit = 50) {
    return this.db.prepare(`SELECT * FROM journal ORDER BY seq DESC LIMIT ?`).all(limit)
  }
}
