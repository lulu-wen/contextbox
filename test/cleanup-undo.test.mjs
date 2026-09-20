import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { applyPlan, listQuarantine, RETENTION_MS, undoPlan } from '../core/cleanup-exec.ts'
import { emptyQuarantine, prepareEmptyQuarantine } from '../core/cleanup-quarantine.ts'
import { listJournal } from '../core/cleanup-journal.ts'
import { fixture } from './helpers/cleanup.mjs'

function applied(t, files = { 'a.zip': 'abc' }) {
  const f = fixture(t, files)
  const p = f.plan()
  assert.equal(applyPlan(f.db, p.id, f.opts).status, 'applied')
  return { ...f, p, rows: listJournal(f.db, p.id) }
}

function mature(f, ms = RETENTION_MS + 1000) {
  f.db.prepare("UPDATE cleanup_move_details SET completed_at=? WHERE seq IN (SELECT seq FROM cleanup_journal WHERE op='quarantine')")
    .run(new Date(Date.now() - ms).toISOString())
}

function empty(f) {
  const preview = prepareEmptyQuarantine(f.db, f.opts)
  return emptyQuarantine(f.db, { ...f.opts, token: preview.token, confirmed: true })
}

test('undo restores original bytes and mtime; repeated undo/apply remains terminal', t => {
  const f = applied(t)
  const r = undoPlan(f.db, f.p.id, f.opts)
  assert.equal(r.status, 'restored')
  assert.equal(r.restoredCount, 1)
  assert.equal(r.undoable, false)
  assert.equal(readFileSync(join(f.downloads, 'a.zip'), 'utf8'), 'abc')
  assert.equal(fs.statSync(join(f.downloads, 'a.zip')).mtime.toISOString(), f.old.toISOString())
  // 重送原樣回傳，**只多一個 noop: true**（稽核第三輪 R3-2）
  assert.equal(r.noop, false, '第一次真的放回了')
  assert.deepEqual(undoPlan(f.db, f.p.id, f.opts), { ...r, noop: true })
  assert.deepEqual(applyPlan(f.db, f.p.id, f.opts), { ...r, noop: true })
  assert.deepEqual(listQuarantine(f.db), [])
})

test('restore never overwrites occupied names, directories or dangling symlinks', t => {
  const f = applied(t)
  writeFileSync(join(f.downloads, 'a.zip'), 'new')
  mkdirSync(join(f.downloads, 'a.zip.restored'))
  symlinkSync(join(f.dir, 'missing'), join(f.downloads, 'a.zip.restored.2'))
  assert.equal(undoPlan(f.db, f.p.id, f.opts).status, 'restored')
  assert.equal(readFileSync(join(f.downloads, 'a.zip'), 'utf8'), 'new')
  assert.equal(readFileSync(join(f.downloads, 'a.zip.restored.3'), 'utf8'), 'abc')
})

test('undo refuses a parent replaced with a symlink and works after repair', t => {
  const f = applied(t)
  const original = join(f.dir, 'saved-downloads')
  renameSync(f.downloads, original)
  symlinkSync(original, f.downloads, 'dir')
  assert.equal(undoPlan(f.db, f.p.id, f.opts).status, 'error')
  assert.ok(existsSync(f.rows[0].to_path))
  fs.unlinkSync(f.downloads)
  renameSync(original, f.downloads)
  assert.equal(undoPlan(f.db, f.p.id, f.opts).status, 'restored')
})

test('undo partial failure retries remaining entries and blocks apply', t => {
  const f = applied(t, { 'a.zip': 'a', 'b.zip': 'b' })
  const native = fs.renameSync
  let n = 0
  t.mock.method(fs, 'renameSync', (...args) => {
    if (++n === 2) throw Object.assign(new Error('private path'), { code: 'EACCES' })
    return native(...args)
  })
  syncBuiltinESMExports()
  try {
    const r = undoPlan(f.db, f.p.id, f.opts)
    assert.equal(r.status, 'partial')
    assert.equal(r.restoredCount, 1)
    assert.throws(() => applyPlan(f.db, f.p.id, f.opts), { code: 'CONFLICT' })
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
  assert.equal(undoPlan(f.db, f.p.id, f.opts).restoredCount, 2)
})

test('undo recovers when the done database write fails after a successful restore', t => {
  const f = applied(t)
  f.db.exec(`CREATE TRIGGER fail_restore BEFORE UPDATE OF status ON cleanup_journal
    WHEN NEW.op='restore' AND NEW.status='done' BEGIN SELECT RAISE(ABORT,'fail'); END`)
  assert.equal(undoPlan(f.db, f.p.id, f.opts).status, 'error')
  f.db.exec('DROP TRIGGER fail_restore')
  assert.equal(undoPlan(f.db, f.p.id, f.opts).status, 'restored')
  assert.equal(readFileSync(join(f.downloads, 'a.zip'), 'utf8'), 'abc')
})

test('purge requires seven days since quarantine completion, regardless of original mtime', t => {
  const f = applied(t)
  assert.equal(listQuarantine(f.db)[0].canEmptyNow, false)
  assert.equal(prepareEmptyQuarantine(f.db, f.opts).itemCount, 0)
  assert.equal(empty(f).deletedCount, 0)
  mature(f, RETENTION_MS - 60000)
  assert.equal(empty(f).deletedCount, 0)
  assert.ok(existsSync(f.rows[0].to_path))
  mature(f)
  assert.equal(listQuarantine(f.db)[0].canEmptyNow, true)
  assert.equal(empty(f).deletedCount, 1)
  assert.ok(!existsSync(f.rows[0].to_path))
  assert.equal(undoPlan(f.db, f.p.id, f.opts).status, 'error')
})

test('purge requires valid second confirmation; tokens expire and replays are idempotent', t => {
  const f = applied(t)
  mature(f)
  assert.throws(() => emptyQuarantine(f.db, { ...f.opts, confirmed: true, token: 'bad' }), { code: 'CONFIRMATION_REQUIRED' })
  const p = prepareEmptyQuarantine(f.db, f.opts)
  for (const confirmed of [false, undefined, 'true', 1]) {
    assert.throws(() => emptyQuarantine(f.db, { ...f.opts, token: p.token, confirmed }), { code: 'CONFIRMATION_REQUIRED' })
  }
  f.db.prepare('UPDATE cleanup_empty_requests SET expires_at=? WHERE token=?').run('2000-01-01T00:00:00Z', p.token)
  assert.throws(() => emptyQuarantine(f.db, { ...f.opts, token: p.token, confirmed: true }), { code: 'CONFIRMATION_EXPIRED' })
  const fresh = prepareEmptyQuarantine(f.db, f.opts)
  const opts = { ...f.opts, token: fresh.token, confirmed: true }
  // setAside：不刪、也不算錯的那些（稽核第三輪）。這一組沒有，所以是空的。
  assert.deepEqual(emptyQuarantine(f.db, opts), { deletedCount: 1, deletedBytes: 3, errors: [], setAside: [], noop: false })
  // 重送同一個確認碼：原樣回傳，但這一次一個檔都沒刪（R3-2）
  assert.deepEqual(emptyQuarantine(f.db, opts), { deletedCount: 1, deletedBytes: 3, errors: [], setAside: [], noop: true })
})

test('purge excludes unknown files and files restored after preview', t => {
  const f = applied(t)
  mature(f)
  const unknown = join(f.opts.quarantine, 'untracked.zip')
  writeFileSync(unknown, 'keep')
  const preview = prepareEmptyQuarantine(f.db, f.opts)
  undoPlan(f.db, f.p.id, f.opts)
  assert.equal(emptyQuarantine(f.db, { ...f.opts, token: preview.token, confirmed: true }).deletedCount, 0)
  assert.equal(readFileSync(unknown, 'utf8'), 'keep')
  assert.equal(readFileSync(join(f.downloads, 'a.zip'), 'utf8'), 'abc')
})

test('purge rejects forged paths outside quarantine', t => {
  const f = applied(t)
  mature(f)
  const outside = join(f.dir, 'important.zip')
  writeFileSync(outside, 'keep')
  f.db.prepare('UPDATE cleanup_journal SET to_path=? WHERE seq=?').run(outside, f.rows[0].seq)
  const r = empty(f)
  assert.equal(r.deletedCount, 0)
  assert.equal(r.errors.length, 1)
  assert.equal(readFileSync(outside, 'utf8'), 'keep')
  assert.ok(!JSON.stringify(r).includes(f.dir))
})

test('purge rejects symlink/hardlink substitutions and modified contents', t => {
  const f = applied(t, { 'a.zip': 'a', 'b.zip': 'b', 'c.zip': 'c' })
  mature(f)
  const [a, b, c] = f.rows
  const external = join(f.dir, 'external')
  writeFileSync(external, 'keep')
  renameSync(a.to_path, join(f.dir, 'saved-a'))
  symlinkSync(external, a.to_path)
  renameSync(b.to_path, join(f.dir, 'saved-b'))
  fs.linkSync(external, b.to_path)
  writeFileSync(c.to_path, 'changed')
  const r = empty(f)
  assert.equal(r.deletedCount, 0)
  // **改過的答案（稽核第三輪）**：捷徑與硬鏈結是攻擊，照舊算錯；「內容被改過」是使用者自己動的，
  // 不刪、但也不算錯 —— 以前算錯，清空從此固定回離開碼 3，隔離區永遠清不空。
  assert.equal(r.errors.length, 2, '捷徑、硬鏈結還是錯')
  assert.deepEqual(r.setAside.length, 1, '內容改過的那個放到一邊')
  assert.match(r.setAside[0].why, /no longer matches what was moved in/)
  assert.equal(readFileSync(external, 'utf8'), 'keep')
})

test('purge rejects quarantine directory redirected by symlink', t => {
  const f = applied(t)
  mature(f)
  const saved = join(f.dir, 'saved-quarantine')
  renameSync(f.opts.quarantine, saved)
  symlinkSync(saved, f.opts.quarantine, 'dir')
  const r = empty(f)
  assert.equal(r.deletedCount, 0)
  assert.equal(r.errors.length, 1)
  assert.equal(readFileSync(f.rows[0].to_path, 'utf8'), 'abc')
})

test('purge permission failure leaves data and can be retried with fresh confirmation', t => {
  const f = applied(t)
  mature(f)
  t.mock.method(fs, 'unlinkSync', () => { throw Object.assign(new Error('private path'), { code: 'EACCES' }) })
  syncBuiltinESMExports()
  try {
    const r = empty(f)
    assert.equal(r.deletedCount, 0)
    assert.equal(r.errors.length, 1)
    assert.ok(existsSync(f.rows[0].to_path))
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
  assert.equal(empty(f).deletedCount, 1)
})

test('purge recovers deletion followed by a database failure', t => {
  const f = applied(t)
  mature(f)
  f.db.exec(`CREATE TRIGGER fail_purge BEFORE UPDATE OF status ON cleanup_purges
    WHEN NEW.status='done' BEGIN SELECT RAISE(ABORT,'fail'); END`)
  assert.equal(empty(f).errors.length, 1)
  assert.ok(!existsSync(f.rows[0].to_path))
  f.db.exec('DROP TRIGGER fail_purge')
  assert.equal(empty(f).deletedCount, 1)
  assert.deepEqual(listQuarantine(f.db), [])
})

test('a failed purge still allows undo when the verified file remains', t => {
  const f = applied(t)
  mature(f)
  t.mock.method(fs, 'unlinkSync', () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) })
  syncBuiltinESMExports()
  try { assert.equal(empty(f).errors.length, 1) }
  finally { t.mock.restoreAll(); syncBuiltinESMExports() }
  assert.equal(undoPlan(f.db, f.p.id, f.opts).status, 'restored')
  assert.equal(readFileSync(join(f.downloads, 'a.zip'), 'utf8'), 'abc')
})
