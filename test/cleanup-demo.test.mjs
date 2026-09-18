import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createDemo } from '../core/assets/cleanup-demo-state.js'

const fixture = JSON.parse(readFileSync(new URL('../docs/api/cleanup-candidates.json', import.meta.url)))

test('restoring historical operations returns missing candidates without duplicating existing files', () => {
  const demo = createDemo(fixture)
  demo.apply()
  assert.equal(demo.candidates.length, 1)
  demo.restoreItems(fixture.candidates.slice(0, 2))
  assert.equal(demo.candidates.length, 3)
  demo.restoreItems(fixture.candidates.slice(0, 2))
  assert.equal(demo.candidates.length, 3)
  demo.restoreItems(fixture.candidates)
  assert.equal(demo.candidates.length, 4)
  const reloaded = createDemo(fixture)
  reloaded.restoreItems(fixture.candidates)
  assert.equal(reloaded.candidates.length, 4)
})

test('demo uses actual rows and defaultChecked instead of stale fixture totals', () => {
  const demo = createDemo(fixture)
  assert.equal(demo.candidates.length, 4)
  assert.equal(demo.selected.size, 3)
  assert.equal(demo.selected.has('i_92e'), false)
  assert.equal(demo.bytes, 2411882 + 1073741824 + 786432000)
})
test('unselected files remain, all candidate IDs are included, undo restores selection', () => {
  const demo = createDemo(fixture)
  demo.select('i_44f', false)
  const result = demo.apply()
  assert.equal(result.quarantined, 2)
  assert.deepEqual(result.candidateIds, ['c_8Bz', 'c_2Ew', 'c_5Hq'])
  assert.deepEqual(demo.candidates.map(c => c.itemId), ['i_44f', 'i_92e'])
  assert.throws(() => demo.apply())
  assert.equal(demo.undo().restored, 2)
  assert.equal(demo.candidates.length, 4)
  assert.deepEqual([...demo.selected], ['i_51c', 'i_81d'])
  assert.equal(demo.canUndo, false)
  assert.throws(() => demo.undo())
})
test('empty selection cannot clean; reset restores the original fixture', () => {
  const demo = createDemo(fixture)
  for (const item of demo.candidates) demo.select(item.itemId, false)
  assert.throws(() => demo.apply())
  demo.reset()
  demo.apply()
  demo.reset()
  assert.equal(demo.candidates.length, 4)
  assert.equal(demo.selected.size, 3)
  assert.equal(demo.canUndo, false)
  assert.equal(fixture.candidates.length, 4)
})
