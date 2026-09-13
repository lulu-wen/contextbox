import { before, beforeEach, after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { open } from '../core/db.ts'
import { cleanupWalk, scanDownloads } from '../core/cleanup-scanner.ts'

const day = 24 * 60 * 60 * 1000
const now = new Date('2026-09-13T00:00:00Z')

let root, downloads, db

before(() => {
  root = mkdtempSync(join(tmpdir(), 'cb-cleanup-scan-'))
  downloads = join(root, 'Downloads')
})

after(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(downloads, { recursive: true, force: true })
  mkdirSync(downloads, { recursive: true })
  db = open(':memory:')
})

function touchOld(name, content = 'x', days = 40) {
  const p = join(downloads, name)
  writeFileSync(p, content)
  const t = new Date(now.getTime() - days * day)
  utimesSync(p, t, t)
  return p
}

const scan = extra => scanDownloads({
  db,
  roots: [downloads],
  maxBytes: 1024 * 1024,
  now,
  ...extra,
})

const candidates = () => db.prepare(
  `SELECT c.kind, c.status, f.name, c.reason, c.evidence
   FROM cleanup_candidates c JOIN file_items f ON f.id=c.item_id
   ORDER BY f.name, c.kind`
).all()

describe('cleanup scanner', () => {
  test('掃到舊 zip 會建立 file_items 與 archive candidate', () => {
    touchOld('old.zip', 'zip-ish', 40)
    const r = scan()

    assert.equal(r.scanned, 1)
    const item = db.prepare(`SELECT * FROM file_items WHERE name='old.zip'`).get()
    assert.equal(item.status, 'candidate')
    assert.equal(item.sha256.length, 64)

    const rows = candidates()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind, 'archive')
    assert.match(rows[0].evidence, /40 天/)
  })

  test('同內容檔案只提議清掉後看到的那份，重掃不會長出重複卡片', () => {
    touchOld('a-keep.bin', 'same', 2)
    touchOld('b-copy.bin', 'same', 2)
    scan()
    scan()

    const rows = candidates()
    assert.deepEqual(rows.map(r => `${r.name}:${r.kind}`), ['b-copy.bin:duplicate'])
    assert.equal(
      db.prepare(`SELECT count(*) n FROM cleanup_candidates`).get().n,
      1,
      '重掃不可以一直新增同一張 candidate')
  })

  test('最近還在變動的檔案先入庫但不分類', () => {
    const p = join(downloads, 'fresh.zip')
    writeFileSync(p, 'fresh')
    utimesSync(p, now, now)

    scan()
    const item = db.prepare(`SELECT * FROM file_items WHERE name='fresh.zip'`).get()
    assert.equal(item.status, 'new')
    assert.equal(db.prepare(`SELECT count(*) n FROM cleanup_candidates`).get().n, 0)
  })

  test('空檔與下載中檔要夠舊才成為候選', () => {
    touchOld('empty.tmp', '', 2)
    touchOld('video.mp4.crdownload', 'partial', 2)
    scan()

    assert.deepEqual(candidates().map(r => r.kind).sort(), ['empty', 'partial'])
    assert.equal(
      db.prepare(`SELECT sha256 FROM file_items WHERE name='video.mp4.crdownload'`).get().sha256,
      null,
      '半成品不需要讀內容算 hash')
  })

  test('候選條件消失時，舊 proposed candidate 會被 dismiss', () => {
    const p = touchOld('maybe.tmp', '', 2)
    scan()
    assert.equal(candidates()[0].kind, 'empty')

    writeFileSync(p, 'not empty anymore')
    const t = new Date(now.getTime() - 2 * day)
    utimesSync(p, t, t)
    scan()

    assert.equal(
      db.prepare(`SELECT status FROM cleanup_candidates WHERE kind='empty'`).get().status,
      'dismissed')
    assert.equal(db.prepare(`SELECT status FROM file_items WHERE name='maybe.tmp'`).get().status, 'kept')
  })

  test('掃描時檔案不見了會標 missing，不讓流程爆掉', () => {
    const p = touchOld('gone.zip', 'gone', 40)
    scan()
    unlinkSync(p)

    const problems = []
    const r = scan({ paths: [p], onProblem: m => problems.push(m) })
    assert.equal(r.errors, 1)
    assert.ok(problems.some(m => /檔案不見了/.test(m)))
    assert.equal(db.prepare(`SELECT status FROM file_items WHERE name='gone.zip'`).get().status, 'missing')
  })

  test('walk 不跟 symlink、不進隱藏與黑名單資料夾', () => {
    touchOld('real.zip')
    mkdirSync(join(downloads, '.git'), { recursive: true })
    writeFileSync(join(downloads, '.git', 'hidden.zip'), 'x')
    mkdirSync(join(downloads, 'tokens'), { recursive: true })
    writeFileSync(join(downloads, 'tokens', 'secret.zip'), 'x')
    symlinkSync(join(downloads, 'real.zip'), join(downloads, 'link.zip'))

    const found = cleanupWalk(downloads).files.map(p => basename(p)).sort()
    assert.deepEqual(found, ['real.zip'])
  })
})
