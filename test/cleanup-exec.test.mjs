import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, readFileSync, renameSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { applyPlan, listQuarantine, undoPlan } from '../core/cleanup-exec.ts'
import { createPlan, dismissPlan } from '../core/cleanup-plans.ts'
import { listJournal } from '../core/cleanup-journal.ts'
import { fixture } from './helpers/cleanup.mjs'
const nativeRename = fs.renameSync

test('apply preserves content/mtime and writes started before rename; replay moves nothing', t => {
  const f = fixture(t)
  const p = f.plan()
  const calls = []
  t.mock.method(fs, 'renameSync', (from, to) => {
    const rows = listJournal(f.db, p.id)
    assert.equal(rows.at(-1).status, 'started')
    assert.equal(rows.at(-1).to_path, to)
    calls.push(to)
    nativeRename(from, to)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const result = applyPlan(f.db, p.id, f.opts)
  assert.equal(result.status, 'applied')
  assert.equal(result.quarantinedCount, 2)
  assert.equal(calls.length, 2)
  for (const row of listJournal(f.db, p.id)) {
    assert.equal(row.status, 'done')
    assert.ok(!existsSync(row.from_path))
    assert.match(readFileSync(row.to_path, 'utf8'), /archive/)
    assert.equal(fs.statSync(row.to_path).mtime.toISOString(), f.old.toISOString())
    assert.equal(row.sha256.length, 64)
  }
  assert.deepEqual(applyPlan(f.db, p.id, f.opts), result)
  assert.equal(calls.length, 2)
  assert.equal(listQuarantine(f.db).length, 2)
  assert.ok(!JSON.stringify(listQuarantine(f.db)).includes(f.dir))
  assert.throws(() => dismissPlan(f.db, p.id), { code: 'CONFLICT' })
})

test('skipping one reason skips the whole file and persists across retry', t => {
  const f = fixture(t)
  const p = f.plan()
  const skipped = p.items[0]
  assert.throws(() => applyPlan(f.db, p.id, { ...f.opts, skippedIds: ['unknown'] }), { code: 'BAD_BODY' })
  const r = applyPlan(f.db, p.id, { ...f.opts, skippedIds: [skipped.candidateIds[0]] })
  assert.equal(r.quarantinedCount, 1)
  assert.ok(existsSync(join(f.downloads, skipped.name)))
  assert.equal(listJournal(f.db, p.id).filter(r => r.op === 'skip').length, 1)
  assert.equal(applyPlan(f.db, p.id, f.opts).quarantinedCount, 1)
})

test('missing source produces partial failure; successful items remain undoable', t => {
  const f = fixture(t)
  const p = f.plan()
  const gone = join(f.downloads, p.items[0].name)
  renameSync(gone, join(f.dir, 'moved-away'))
  const r = applyPlan(f.db, p.id, f.opts)
  assert.equal(r.status, 'partial')
  assert.equal(r.quarantinedCount, 1)
  assert.equal(r.undoable, true)
  assert.ok(!JSON.stringify(r).includes(f.dir))
  assert.equal(undoPlan(f.db, p.id, f.opts).status, 'restored')
  assert.ok(existsSync(join(f.downloads, p.items[1].name)))
  assert.equal(applyPlan(f.db, p.id, f.opts).quarantinedCount, 0)
})

test('content changed with same size/mtime and a rescan is rejected against snapshot', t => {
  const f = fixture(t, { 'a.zip': 'abc' })
  const p = f.plan()
  writeFileSync(join(f.downloads, 'a.zip'), 'xyz')
  utimesSync(join(f.downloads, 'a.zip'), f.old, f.old)
  f.scan()
  assert.equal(applyPlan(f.db, p.id, f.opts).status, 'error')
  assert.equal(readFileSync(join(f.downloads, 'a.zip'), 'utf8'), 'xyz')
  assert.equal(listJournal(f.db, p.id).length, 0)
})

test('size cap, readonly, links, protected files and roots are enforced at execution', t => {
  const f = fixture(t, { 'a.zip': 'abc' })
  const p = f.plan()
  assert.throws(() => applyPlan(f.db, p.id, { ...f.opts, readonly: true }), { code: 'READ_ONLY' })
  assert.equal(applyPlan(f.db, p.id, { ...f.opts, maxBytes: 1 }).status, 'error')
  assert.equal(applyPlan(f.db, p.id, { ...f.opts, roots: [f.opts.quarantine] }).status, 'error')
  const original = join(f.downloads, 'a.zip')
  renameSync(original, join(f.dir, 'original'))
  symlinkSync(join(f.dir, 'original'), original)
  assert.equal(applyPlan(f.db, p.id, f.opts).status, 'error')
  assert.equal(readFileSync(original, 'utf8'), 'abc')
})

for (const code of ['EACCES', 'EXDEV']) test(`${code} leaves source intact and retry works`, t => {
  const f = fixture(t, { 'a.zip': 'abc' })
  const p = f.plan()
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('private path'), { code }) })
  syncBuiltinESMExports()
  try {
    assert.equal(applyPlan(f.db, p.id, f.opts).status, 'error')
    assert.equal(readFileSync(join(f.downloads, 'a.zip'), 'utf8'), 'abc')
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
  assert.equal(applyPlan(f.db, p.id, f.opts).status, 'applied')
  assert.equal(listJournal(f.db, p.id).length, 1)
})

test('database failure after rename is recoverable and does not repeat the move', t => {
  const f = fixture(t, { 'a.zip': 'abc' })
  const p = f.plan()
  f.db.exec(`CREATE TRIGGER fail_done BEFORE UPDATE OF status ON cleanup_journal
    WHEN NEW.status='done' BEGIN SELECT RAISE(ABORT,'injected DB failure'); END`)
  assert.equal(applyPlan(f.db, p.id, f.opts).status, 'error')
  assert.ok(!existsSync(join(f.downloads, 'a.zip')))
  f.db.exec('DROP TRIGGER fail_done')
  assert.equal(applyPlan(f.db, p.id, f.opts).status, 'applied')
  assert.equal(listJournal(f.db, p.id).length, 1)
})

test('a process crash after rename leaves a durable journal and reclaimable lock', t => {
  const f = fixture(t, { 'a.zip': 'abc' })
  const p = f.plan()
  const code = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { open } from ${JSON.stringify(new URL('../core/db.ts', import.meta.url).href)};
    import { applyPlan } from ${JSON.stringify(new URL('../core/cleanup-exec.ts', import.meta.url).href)};
    const rename = fs.renameSync;
    fs.renameSync = (...args) => { rename(...args); process.exit(23); };
    syncBuiltinESMExports();
    applyPlan(open(${JSON.stringify(f.dbPath)}), ${JSON.stringify(p.id)}, ${JSON.stringify(f.opts)});
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' })
  assert.equal(child.status, 23, child.stderr)
  assert.equal(listJournal(f.db, p.id)[0].status, 'started')
  // A newly downloaded file at the old path must survive crash recovery and undo.
  writeFileSync(join(f.downloads, 'a.zip'), 'new file')
  assert.equal(applyPlan(f.db, p.id, f.opts).status, 'applied')
  assert.equal(undoPlan(f.db, p.id, f.opts).status, 'restored')
  assert.equal(readFileSync(join(f.downloads, 'a.zip'), 'utf8'), 'new file')
  assert.equal(readFileSync(join(f.downloads, 'a.zip.restored'), 'utf8'), 'abc')
})

test('duplicate-only cleanup rechecks that an unchanged copy will remain', t => {
  const f = fixture(t, { 'a.pdf': 'same', 'b.pdf': 'same' })
  const p = f.plan()
  assert.equal(p.itemCount, 1)
  const keep = ['a.pdf', 'b.pdf'].find(name => name !== p.items[0].name)
  writeFileSync(join(f.downloads, keep), 'different')
  assert.equal(applyPlan(f.db, p.id, f.opts).status, 'error')
  assert.equal(readFileSync(join(f.downloads, p.items[0].name), 'utf8'), 'same')
})

test('protected database/key files and hardlinks never move even when A proposes them', t => {
  const f = fixture(t, { 'private.db': 'database', 'private.pem': 'key', 'a.zip': 'archive' })
  const all = f.db.prepare('SELECT id FROM cleanup_candidates').all().map(c => c.id)
  // Explicitly selecting low-confidence candidates still cannot bypass protection.
  const { db, opts } = f
  const p = createPlan(db, { candidateIds: all })
  fs.linkSync(join(f.downloads, 'a.zip'), join(f.dir, 'another-link'))
  assert.equal(applyPlan(db, p.id, opts).status, 'error')
  assert.equal(listJournal(db, p.id).length, 0)
  assert.ok(existsSync(join(f.downloads, 'private.db')))
  assert.ok(existsSync(join(f.downloads, 'private.pem')))
})
