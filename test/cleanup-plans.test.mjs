import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { createPlan, dismissPlan, getPlan, planSnapshots } from '../core/cleanup-plans.ts'
import { fixture } from './helpers/cleanup.mjs'

test('plan groups all reasons per file; default excludes low confidence; DTO omits paths', t => {
  const f = fixture(t, { 'a.zip': 'a', 'old.bin': 'b' })
  const p = f.plan()
  assert.equal(p.itemCount, 1)
  assert.equal(p.items[0].reasons.length, 2)
  assert.equal(p.bytes, 1)
  assert.ok(!JSON.stringify(p).includes(f.downloads))
  assert.equal(planSnapshots(f.db, p.id)[0].path, join(f.downloads, 'a.zip'))
})

test('explicit selection opts into low confidence and rejects stale/unknown ids atomically', t => {
  const f = fixture(t, { 'old.bin': 'b' })
  assert.throws(() => f.plan(), { code: 'EMPTY_PLAN' })
  const id = f.db.prepare('SELECT id FROM cleanup_candidates').get().id
  assert.throws(() => createPlan(f.db, { candidateIds: [id, 'unknown'] }), { code: 'STALE_CANDIDATE' })
  assert.equal(f.db.prepare('SELECT count(*) n FROM cleanup_plans').get().n, 0)
  const p = createPlan(f.db, { candidateIds: [id, id] })
  assert.equal(p.itemCount, 1)
  assert.throws(() => createPlan(f.db, { candidateIds: [id] }), { code: 'CONFLICT' })
})

test('plan snapshot remains immutable after A rescans changed content', t => {
  const f = fixture(t, { 'a.zip': 'old' })
  const p = f.plan()
  const original = planSnapshots(f.db, p.id)
  writeFileSync(join(f.downloads, 'a.zip'), 'new content')
  utimesSync(join(f.downloads, 'a.zip'), f.old, f.old)
  f.scan()
  assert.deepEqual(planSnapshots(f.db, p.id), original)
})

test('dismiss is idempotent and releases reservations; invalid inputs are rejected', t => {
  const f = fixture(t)
  for (const candidateIds of [null, 'id', [1], [''], new Array(5001).fill('a')]) {
    assert.throws(() => createPlan(f.db, { candidateIds }), { code: 'BAD_BODY' })
  }
  const p = f.plan()
  assert.equal(dismissPlan(f.db, p.id).status, 'dismissed')
  assert.deepEqual(dismissPlan(f.db, p.id), getPlan(f.db, p.id))
  assert.equal(f.db.prepare("SELECT count(*) n FROM cleanup_candidates WHERE status='proposed'").get().n, 0)
  assert.throws(() => getPlan(f.db, 'unknown'), { code: 'NOT_FOUND' })
})

test('requestId makes creation retries idempotent, including after dismiss', t => {
  const f = fixture(t)
  const p = createPlan(f.db, { requestId: 'click-1' })
  assert.deepEqual(createPlan(f.db, { requestId: 'click-1' }), p)
  assert.throws(() => createPlan(f.db, { requestId: 'click-1', candidateIds: [] }), { code: 'CONFLICT' })
  dismissPlan(f.db, p.id)
  assert.equal(createPlan(f.db, { requestId: 'click-1' }).status, 'dismissed')
  assert.equal(f.db.prepare('SELECT count(*) n FROM cleanup_plans').get().n, 1)
})
