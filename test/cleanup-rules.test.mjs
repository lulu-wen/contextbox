import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyByRules, duplicateDraft, isScreenshotNoiseName } from '../core/cleanup-rules.ts'

const day = 24 * 60 * 60 * 1000
const now = new Date('2026-09-13T00:00:00Z').getTime()
const ago = n => now - n * day

const kinds = rows => rows.map(r => r.kind).sort()

describe('cleanup rules', () => {
  test('半成品與空檔要等 24 小時才提議清理', () => {
    assert.deepEqual(kinds(classifyByRules({
      path: '/Downloads/a.crdownload',
      bytes: 10,
      mtimeMs: ago(0),
      nowMs: now,
    })), [])

    assert.deepEqual(kinds(classifyByRules({
      path: '/Downloads/a.crdownload',
      bytes: 10,
      mtimeMs: ago(2),
      nowMs: now,
    })), ['partial'])

    assert.deepEqual(kinds(classifyByRules({
      path: '/Downloads/empty.txt',
      bytes: 0,
      mtimeMs: ago(2),
      nowMs: now,
    })), ['empty'])
  })

  test('安裝檔、壓縮檔、舊下載檔都有可解釋 evidence', () => {
    const rows = classifyByRules({
      path: '/Downloads/tool.dmg',
      bytes: 123,
      mtimeMs: ago(100),
      nowMs: now,
    })
    assert.deepEqual(kinds(rows), ['installer', 'old-download'])
    assert.ok(rows.every(r => r.reason && r.evidence), '每一條都要能講原因')
  })

  test('舊暫存檔是 temp，但空暫存檔只算 empty', () => {
    assert.deepEqual(kinds(classifyByRules({
      path: '/Downloads/cache.tmp',
      bytes: 10,
      mtimeMs: ago(8),
      nowMs: now,
    })), ['temp'])

    assert.deepEqual(kinds(classifyByRules({
      path: '/Downloads/empty.tmp',
      bytes: 0,
      mtimeMs: ago(8),
      nowMs: now,
    })), ['empty'])
  })

  test('保護副檔名不會因為很舊就被 old-download 預設提議', () => {
    assert.deepEqual(kinds(classifyByRules({
      path: '/Downloads/important.pdf',
      bytes: 123,
      mtimeMs: ago(120),
      nowMs: now,
    })), [])
  })

  test('舊截圖是低信心候選', () => {
    const rows = classifyByRules({
      path: '/Downloads/Screenshot 2026-01-01.png',
      bytes: 123,
      mtimeMs: ago(40),
      nowMs: now,
    })
    assert.deepEqual(kinds(rows), ['screenshot-noise'])
    assert.equal(rows[0].confidence, 35)
    assert.equal(isScreenshotNoiseName('截圖 2026-01-01'), true)
  })

  test('duplicate draft 說得出還有幾份', () => {
    const d = duplicateDraft(3)
    assert.equal(d.kind, 'duplicate')
    assert.match(d.evidence, /2 份/)
  })
})
