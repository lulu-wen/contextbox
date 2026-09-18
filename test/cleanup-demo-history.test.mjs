import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open } from '../core/db.ts'
import { initDemoHistory, recordDemo, listDemoHistory, undoDemoHistory } from '../core/cleanup-demo-history.ts'

test('模擬紀錄跨 DB 重開保存，與真實清理表分離，重送不重複新增', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'quaso-history-')), 'test.db')
  let db = open(path)
  initDemoHistory(db)
  const body = { requestId: 'request-1', candidateIds: ['c_7Qa'] }
  const one = recordDemo(db, body)
  assert.equal(recordDemo(db, body).id, one.id)
  assert.throws(() => recordDemo(db, { ...body, candidateIds: ['c_8Bz'] }))
  assert.equal(db.prepare('SELECT count(*) n FROM cleanup_plans').get().n, 0)
  assert.equal(db.prepare('SELECT count(*) n FROM cleanup_journal').get().n, 0)
  db.close()
  db = open(path)
  initDemoHistory(db)
  assert.equal(listDemoHistory(db).total, 1)
  assert.equal(listDemoHistory(db).operations[0].id, one.id)
  assert.equal(undoDemoHistory(db, [one.id]).restoredFiles, 1)
  db.close()
  db = open(path)
  assert.equal(listDemoHistory(db).total, 0)
  assert.deepEqual(listDemoHistory(db).operations, [])
  db.close()
})

test('勾選多次操作只復原所選紀錄，重送可安全重試，不存在的 ID 整批拒絕', () => {
  const db = open(':memory:'); initDemoHistory(db)
  const one = recordDemo(db, { requestId: '1', candidateIds: ['c_7Qa'] })
  const two = recordDemo(db, { requestId: '2', candidateIds: ['c_2Ew', 'c_5Hq'] })
  const three = recordDemo(db, { requestId: '3', candidateIds: ['c_8Bz'] })
  assert.equal(two.itemCount, 1)
  assert.throws(() => undoDemoHistory(db, [one.id, 'missing']))
  assert.equal(listDemoHistory(db).operations.every(o => o.canUndo), true)
  const response = undoDemoHistory(db, [one.id, two.id, one.id])
  assert.equal(response.restored, 2)
  assert.equal(response.restoredFiles, 2)
  assert.deepEqual(response.restoredItems.map(i => i.itemId), ['i_44f', 'i_81d'])
  assert.equal(undoDemoHistory(db, [one.id, two.id]).restoredItems.length, 2)
  assert.equal(listDemoHistory(db).total, 1)
  assert.deepEqual(listDemoHistory(db).operations.map(o => o.id), [three.id])
  assert.equal(undoDemoHistory(db, [one.id, two.id]).alreadyRestored, 2)
  assert.throws(() => undoDemoHistory(db, []))
  assert.throws(() => recordDemo(db, { requestId: 'bad', candidateIds: ['real-file'] }))
  db.close()
})

test('分頁保留所有紀錄，排序由新到舊，拒絕錯誤分頁參數', () => {
  const db = open(':memory:'); initDemoHistory(db)
  for (let i = 0; i < 23; i++) recordDemo(db, { requestId: String(i), candidateIds: ['c_7Qa'] })
  const first = listDemoHistory(db), second = listDemoHistory(db, 20)
  assert.equal(first.total, 23)
  assert.equal(first.operations.length, 20)
  assert.equal(second.operations.length, 3)
  assert.equal(new Set([...first.operations, ...second.operations].map(o => o.id)).size, 23)
  undoDemoHistory(db, second.operations.map(o => o.id))
  const afterUndo = listDemoHistory(db, 20)
  assert.equal(afterUndo.total, 20)
  assert.equal(afterUndo.offset, 0)
  assert.equal(afterUndo.operations.length, 20)
  assert.throws(() => listDemoHistory(db, -1))
  assert.throws(() => listDemoHistory(db, 0, 1000))
  db.close()
})
