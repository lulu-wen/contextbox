import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'

// 模擬紀錄與真實 cleanup_plans / cleanup_journal 完全分開，沒有檔案操作。
export function initDemoHistory(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS cleanup_demo_history (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, selection TEXT NOT NULL,
    created_at TEXT NOT NULL, restored_at TEXT, items TEXT NOT NULL
  )`)
}
type Row = { id: string; request_id: string; selection: string; created_at: string; restored_at: string | null; items: string }
function dto(row: Row) {
  const items = JSON.parse(row.items) as { itemId: string; name: string; bytes: number; candidateIds: string[] }[]
  return { id: row.id, createdAt: row.created_at, restoredAt: row.restored_at,
    status: row.restored_at ? 'restored' : 'applied', canUndo: !row.restored_at,
    itemCount: items.length, bytes: items.reduce((n, i) => n + i.bytes, 0), items }
}
function ids(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || !value.length || value.length > 100
    || value.some(v => typeof v !== 'string' || !v || v.length > 200)) throw new Error('請勾選有效的項目（每次最多 100 筆）。')
}
export function recordDemo(db: DatabaseSync, body: any) {
  ids(body?.candidateIds)
  if (typeof body?.requestId !== 'string' || !body.requestId || body.requestId.length > 200) throw new Error('缺少操作識別碼，請重新整理後再試。')
  const selection = JSON.stringify([...new Set(body.candidateIds)].sort())
  const fixture = JSON.parse(readFileSync(new URL('./assets/demo-candidates.json', import.meta.url), 'utf8'))
  const known = new Set(fixture.candidates.flatMap((i: any) => i.candidateIds))
  if (body.candidateIds.some((id: string) => !known.has(id))) throw new Error('範例候選已變更，請重新整理。')
  const selected = new Set(body.candidateIds)
  const items = fixture.candidates.filter((i: any) => i.candidateIds.some((id: string) => selected.has(id)))
    .map((i: any) => ({ itemId: i.itemId, name: i.name, bytes: i.bytes, candidateIds: i.candidateIds }))
  db.exec('BEGIN IMMEDIATE')
  try {
    const prior = db.prepare('SELECT * FROM cleanup_demo_history WHERE request_id=?').get(body.requestId) as Row | undefined
    if (prior && prior.selection !== selection) throw new Error('同一次操作的勾選已改變，請重試。')
    if (prior) { db.exec('COMMIT'); return dto(prior) }
    const row: Row = { id: randomUUID(), request_id: body.requestId, selection,
      created_at: new Date().toISOString(), restored_at: null, items: JSON.stringify(items) }
    db.prepare('INSERT INTO cleanup_demo_history VALUES (?,?,?,?,?,?)')
      .run(row.id, row.request_id, row.selection, row.created_at, null, row.items)
    db.exec('COMMIT')
    return dto(row)
  } catch (e) { db.exec('ROLLBACK'); throw e }
}
export function listDemoHistory(db: DatabaseSync, offset = 0, limit = 20) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('分頁參數不正確。')
  const total = (db.prepare('SELECT count(*) n FROM cleanup_demo_history WHERE restored_at IS NULL').get() as { n: number }).n
  offset = Math.min(offset, Math.max(0, Math.ceil(total / limit) - 1) * limit)
  const rows = db.prepare('SELECT * FROM cleanup_demo_history WHERE restored_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?').all(limit, offset) as Row[]
  return { total, offset, limit, operations: rows.map(dto) }
}
export function undoDemoHistory(db: DatabaseSync, operationIds: unknown) {
  ids(operationIds)
  db.exec('BEGIN IMMEDIATE')
  try {
    const rows = [...new Set(operationIds)].map(id => {
      const row = db.prepare('SELECT * FROM cleanup_demo_history WHERE id=?').get(id) as Row | undefined
      if (!row) throw new Error('找不到所選紀錄，請重新載入清單。')
      return row
    })
    let restored = 0, restoredFiles = 0
    for (const row of rows) {
      if (row.restored_at) continue
      db.prepare('UPDATE cleanup_demo_history SET restored_at=? WHERE id=?').run(new Date().toISOString(), row.id)
      restored++; restoredFiles += dto(row).itemCount
    }
    db.exec('COMMIT')
    // 重送也回傳檔案清單，讓前端在回應曾遺失時仍能同步候選。
    const restoredItems = [...new Map(rows.flatMap(row => dto(row).items).map(item => [item.itemId, item])).values()]
    return { restored, restoredFiles, restoredItems, alreadyRestored: rows.length - restored, operationIds: rows.map(r => r.id) }
  } catch (e) { db.exec('ROLLBACK'); throw e }
}

export function demoHistoryRoutes(db: DatabaseSync, url: URL, method: string, body: any, send: (code: number, value: unknown) => void) {
  if (!url.pathname.startsWith('/demo/cleanup/')) return false
  try {
    if (url.pathname === '/demo/cleanup/history' && method === 'GET') {
      send(200, listDemoHistory(db, Number(url.searchParams.get('offset') ?? 0), Number(url.searchParams.get('limit') ?? 20)))
    } else if (url.pathname === '/demo/cleanup/history' && method === 'POST') {
      send(200, recordDemo(db, body))
    } else if (url.pathname === '/demo/cleanup/undo' && method === 'POST') {
      send(200, undoDemoHistory(db, body?.operationIds))
    } else send(404, { error: '找不到模擬操作功能。' })
  } catch (e: any) {
    send(400, { error: e?.code ? '模擬紀錄暫時無法讀寫，請稍後重試。' : e.message })
  }
  return true
}
