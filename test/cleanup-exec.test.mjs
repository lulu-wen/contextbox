import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync, readFileSync, renameSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { applyPlan, listQuarantine, recoverInterrupted, undoPlan } from '../core/cleanup-exec.ts'
import { createPlan, dismissPlan } from '../core/cleanup-plans.ts'
import { scanDownloads } from '../core/cleanup-scanner.ts'
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
  // 重送原樣回傳，**只多一個 noop: true**（稽核第三輪 R3-2：呼叫端要分得出「這次什麼都沒做」）
  assert.deepEqual(applyPlan(f.db, p.id, f.opts), { ...result, noop: true })
  assert.equal(result.noop, false, '第一次真的搬了')
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

// 2026-09-21 使用者實機回報：doctor 說「379 candidates; 8 too large for this tool」，
// 那 8 個（最大的一個 1.42 GB .gz）永遠只能待在「需要你查看」，想清也清不掉。
//
// 太大的意思其實只是「我們沒有讀它的內容」，所以算不出 sha256 —— 它只影響重複偵測。
// 舊壓縮檔、舊安裝檔、.part 這些規則看的是檔名、副檔名、大小與時間，一條都不需要雜湊。
// 身分確認改由 dev／ino／大小／時間做（fingerprint 對超過上限的檔不讀內容）。
test('超過 maxBytes 的檔照樣清得掉：不讀內容，用中繼資料認身分', t => {
  const f = fixture(t, { 'huge.zip': 'x'.repeat(4096) })
  // 上限調到比檔案小 —— 掃描與執行都走「不讀內容」那條路
  const opts = { ...f.opts, maxBytes: 1024 }
  f.db.exec('DELETE FROM cleanup_candidates')
  f.db.exec('DELETE FROM file_items')
  scanDownloads({ db: f.db, ...opts })

  const item = f.db.prepare(`SELECT sha256, error, status FROM file_items WHERE name='huge.zip'`).get()
  assert.equal(item.sha256, null, '沒讀內容就沒有雜湊')
  assert.equal(item.error, null, '**太大不是「壞掉」** —— 有 error 的檔會被 collect 的 SQL 整個踢出候選')

  const p = createPlan(f.db)
  assert.equal(p.items.length, 1, '大檔要進得了計畫')
  const r = applyPlan(f.db, p.id, opts)
  assert.equal(r.status, 'applied')
  assert.ok(!existsSync(join(f.downloads, 'huge.zip')))
  // 沒有雜湊的那一列，journal 的 sha256 就是 null（不可以塞一個假的進去）
  assert.equal(listJournal(f.db, p.id)[0].sha256, null)
  // 放得回來，而且內容一個位元組都沒變
  assert.equal(undoPlan(f.db, p.id, opts).status, 'restored')
  assert.equal(readFileSync(join(f.downloads, 'huge.zip'), 'utf8'), 'x'.repeat(4096))
})

// 對照：**上限以內的檔照樣要算雜湊**。把上限拿掉等於把內容比對整個關掉，
// 那條「同樣大小、同樣 mtime、內容被換掉」的防線就沒了（上面那條測試守的就是它）。
test('對照：上限以內的檔還是有雜湊', t => {
  const f = fixture(t, { 'small.zip': 'archive small' })
  const item = f.db.prepare(`SELECT sha256 FROM file_items WHERE name='small.zip'`).get()
  assert.equal(item.sha256.length, 64)
  const p = createPlan(f.db)
  assert.equal(applyPlan(f.db, p.id, f.opts).status, 'applied')
  assert.equal(listJournal(f.db, p.id)[0].sha256.length, 64)
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
  // 計畫是一次性的（稽核第二輪 R2-3）：同一份再 apply 原樣回傳、不重試；重試＝重掃之後建新計畫
  assert.equal(applyPlan(f.db, p.id, f.opts).status, 'error')
  assert.equal(listJournal(f.db, p.id).length, 1)
  f.scan()
  assert.equal(applyPlan(f.db, f.plan().id, f.opts).status, 'applied')
  assert.ok(!existsSync(join(f.downloads, 'a.zip')))
})

test('database failure after rename is recoverable and does not repeat the move', t => {
  const f = fixture(t, { 'a.zip': 'abc' })
  const p = f.plan()
  f.db.exec(`CREATE TRIGGER fail_done BEFORE UPDATE OF status ON cleanup_journal
    WHEN NEW.status='done' BEGIN SELECT RAISE(ABORT,'injected DB failure'); END`)
  assert.equal(applyPlan(f.db, p.id, f.opts).status, 'error')
  assert.ok(!existsSync(join(f.downloads, 'a.zip')))
  f.db.exec('DROP TRIGGER fail_done')
  // 計畫是一次性的（稽核第二輪 R2-3）：再 apply 原樣回傳。檔在隔離區，journal 停在 started
  // （不是 failed），由 recoverInterrupted 看證據結成 done（R2-1a），之後照常復原
  assert.equal(applyPlan(f.db, p.id, f.opts).status, 'error')
  assert.equal(listJournal(f.db, p.id)[0].status, 'started')
  assert.deepEqual(recoverInterrupted(f.db, f.opts), { recovered: 1 })
  assert.equal(listJournal(f.db, p.id).length, 1)
  assert.equal(listJournal(f.db, p.id)[0].status, 'done')
  assert.equal(undoPlan(f.db, p.id, f.opts).status, 'restored')
  assert.equal(readFileSync(join(f.downloads, 'a.zip'), 'utf8'), 'abc')
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

test('someone else grabs the destination after the reservation — nothing is overwritten', t => {
  // 稽核 2026-09-20：這是整條管線最後一道防覆蓋的閘門，而它一條測試都沒有 ——
  // 把那個 if 改成 if (false)，全套 2696 條照樣全綠。
  //
  // 情境：我們用 'wx' 在隔離區佔了一個 0 byte 的空位（'wx' 保證那一刻沒有別人），
  // 但在真的 rename 之前，那個位置被換成**別的檔**。rename 不管目的地存不存在，
  // 直接搬過去就把別人的檔蓋掉了。所以動手前要再確認一次：那裡還是我剛剛佔的那一個 inode、
  // 還是 0 byte、mtime 還是那一個。
  const f = fixture(t, { 'a.zip': 'abc' })
  const p = f.plan()
  const realOpen = fs.openSync
  t.mock.method(fs, 'openSync', (path, flags, mode) => {
    const fd = realOpen(path, flags, mode)
    // 佔位檔剛建好的那一刻，把它換成別人的檔（新的 inode、有內容）
    if (flags === 'wx' && String(path).includes('quarantine')) {
      fs.closeSync(fd)
      fs.unlinkSync(path)
      writeFileSync(path, 'someone else was here')
      return realOpen(path, 'r')
    }
    return fd
  })
  syncBuiltinESMExports()
  let r
  try { r = applyPlan(f.db, p.id, f.opts) }
  finally { t.mock.restoreAll(); syncBuiltinESMExports() }

  assert.equal(r.status, 'error', '佔位檔被換掉就不可以搬')
  assert.equal(readFileSync(join(f.downloads, 'a.zip'), 'utf8'), 'abc', '原檔要留在原位')
})
