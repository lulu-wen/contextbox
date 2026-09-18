import './helpers/isolate-home.mjs'
/**
 * 2026-09-19 稽核的釘子測試（S）：RC1、RC2（watcher 那半）、RC3、RC4（1 的受保護副檔名、2）、RC25、RC26。
 *
 * 期望值都是稽核紀錄 /home/lulumi/contextbox-稽核-20260919.md 裡寫死的「預期行為」，
 * 實作之前就寫好。紀錄沒寫、但修法直接推得出來的，註解裡會標「（推論）」。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync,
  unlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open } from '../core/db.ts'
import * as scanner from '../core/cleanup-scanner.ts'
import * as rules from '../core/cleanup-rules.ts'
import * as exec from '../core/cleanup-exec.ts'
import * as journal from '../core/cleanup-journal.ts'
import { createPlan } from '../core/cleanup-plans.ts'
import { createCleanupWatcher } from '../core/cleanup-watcher.ts'
import { healthSnapshot, listCandidates } from '../core/cleanup-routes.ts'

const DAY = 86400_000
const sleep = ms => new Promise(r => setTimeout(r, ms))
// root 不受 chmod 限制；Windows 的 chmod 不擋讀取。這兩種環境跑權限測試沒有意義。
const noPerm = process.platform === 'win32' || process.getuid?.() === 0

function sandbox(t, rootName = 'Downloads') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-a0919-')))
  const dl = join(dir, rootName)
  mkdirSync(dl, { recursive: true })
  const db = open(join(dir, 'data.db'))
  const problems = []
  const locked = []
  t.after(() => {
    for (const p of locked) { try { chmodSync(p, 0o755) } catch { /* 已經還原 */ } }
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const put = (rel, content = 'content of ' + rel, days = 60) => {
    const p = join(dl, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
    const at = new Date(Date.now() - days * DAY)
    utimesSync(p, at, at)
    return p
  }
  const opts = { roots: [dl], quarantine: join(dir, 'quarantine'), maxBytes: 1024 * 1024 }
  const scan = extra => scanner.scanDownloads({ db, ...opts, onProblem: m => problems.push(m), ...extra })
  const list = () => listCandidates(db, { roots: [dl] })
  const names = () => list().candidates.map(c => c.name).sort()
  const count = () => list().totalAvailable
  const status = name => db.prepare('SELECT status FROM file_items WHERE name=?').get(name)?.status
  const candStatus = (name, kind) => db.prepare(
    `SELECT c.status FROM cleanup_candidates c JOIN file_items f ON f.id=c.item_id WHERE f.name=? AND c.kind=?`
  ).get(name, kind)?.status
  const lock = p => { chmodSync(p, 0o000); locked.push(p) }
  const unlock = p => chmodSync(p, 0o755)
  return { dir, dl, db, opts, problems, put, scan, list, names, count, status, candStatus, lock, unlock }
}

// ── RC1 ─────────────────────────────────────────────────────

describe('RC1 對帳：暫時讀不到不是不見了，而且不作廢候選', () => {
  test('子資料夾 chmod 000 → 掃描 → 權限恢復 → 再掃：候選數回到原本的數字', { skip: noPerm }, t => {
    const s = sandbox(t)
    s.put('a.zip'); s.put('sub/b.zip'); s.put('sub/c.msi')
    s.scan()
    const before = s.count()
    assert.equal(before, 3)

    s.lock(join(s.dl, 'sub'))
    s.scan()
    s.unlock(join(s.dl, 'sub'))
    assert.notEqual(s.status('b.zip'), 'missing', 'EACCES 不是 ENOENT，不可以標成不見')
    assert.ok(s.problems.length > 0, '讀不到要記成 problem，不可以安靜跳過')

    s.scan()
    assert.equal(s.count(), before)
    assert.deepEqual(s.names(), ['a.zip', 'b.zip', 'c.msi'])
  })

  test('監看資料夾整個不能進入：候選數不變，出現 problem', { skip: noPerm }, t => {
    const s = sandbox(t)
    s.put('a.zip'); s.put('b.zip'); s.put('sub/c.msi')
    s.scan()
    const before = s.count()

    s.lock(s.dl)
    s.problems.length = 0
    s.scan()
    s.unlock(s.dl)

    assert.equal(s.count(), before, '還沒重掃，數字就已經不可以變')
    assert.ok(s.problems.length > 0, '要出現 problem')
    assert.equal(s.db.prepare(`SELECT count(*) n FROM file_items WHERE status='missing'`).get().n, 0)
  })

  test('空掛載點（10 個已知檔全部 ENOENT）：一個都不標，出現 problem；掛回來再掃：候選數不變', t => {
    const s = sandbox(t)
    for (let i = 0; i < 10; i++) s.put(`f${i}.zip`)
    s.scan()
    assert.equal(s.count(), 10)

    renameSync(s.dl, s.dl + '.mounted')
    mkdirSync(s.dl)                               // 掛載點還在，碟沒掛上
    s.problems.length = 0
    s.scan()
    assert.equal(s.db.prepare(`SELECT count(*) n FROM file_items WHERE status='missing'`).get().n, 0)
    assert.ok(s.problems.some(m => m.includes('看起來整個不見了')), JSON.stringify(s.problems))

    rmSync(s.dl, { recursive: true })
    renameSync(s.dl + '.mounted', s.dl)
    s.scan()
    assert.equal(s.count(), 10)
  })

  // 保險絲的邊界。2026-09-19 第二波改了規則：不再看「會標的 ≥ 50%」（分不出使用者自己一次
  // 刪掉一大半），改成「st_dev 變了」或「根目錄是空的、已知全部不見、已知 ≥ 10」。
  // 這一條原本期望「一個都不標」，照新規則改成 5 個照標（同一個裝置、根目錄還有 5 個檔）。
  // 新規則的釘子在 test/audit-0919-core2.test.mjs 的 a 組。
  test('保險絲邊界：10 個已知、不見 5 個（剛好 50%，根目錄還有東西、同一個裝置）→ 5 個照標', t => {
    const s = sandbox(t)
    for (let i = 0; i < 10; i++) s.put(`f${i}.zip`)
    s.scan()
    for (let i = 0; i < 5; i++) unlinkSync(join(s.dl, `f${i}.zip`))
    s.scan()
    assert.equal(s.db.prepare(`SELECT count(*) n FROM file_items WHERE status='missing'`).get().n, 5)
    assert.ok(!s.problems.some(m => m.includes('看起來整個不見了')))
  })

  test('保險絲邊界：10 個已知、不見 4 個（40%）→ 那 4 個照標', t => {
    const s = sandbox(t)
    for (let i = 0; i < 10; i++) s.put(`f${i}.zip`)
    s.scan()
    for (let i = 0; i < 4; i++) unlinkSync(join(s.dl, `f${i}.zip`))
    s.scan()
    assert.equal(s.db.prepare(`SELECT count(*) n FROM file_items WHERE status='missing'`).get().n, 4)
    assert.equal(s.count(), 6)
  })

  test('保險絲邊界：9 個已知、全部不見 → 未達 10 個門檻，全部照標', t => {
    const s = sandbox(t)
    for (let i = 0; i < 9; i++) s.put(`f${i}.zip`)
    s.scan()
    for (let i = 0; i < 9; i++) unlinkSync(join(s.dl, `f${i}.zip`))
    s.scan()
    assert.equal(s.db.prepare(`SELECT count(*) n FROM file_items WHERE status='missing'`).get().n, 9)
    assert.equal(s.count(), 0)
  })

  test('真的刪掉 1 個（共 12 個）：那 1 個標成 missing，其他不動', t => {
    const s = sandbox(t)
    for (let i = 0; i < 12; i++) s.put(`f${String(i).padStart(2, '0')}.zip`)
    s.scan()
    unlinkSync(join(s.dl, 'f03.zip'))
    s.scan()
    const rows = s.db.prepare(`SELECT name, status FROM file_items ORDER BY name`).all()
    assert.deepEqual(rows.filter(r => r.status === 'missing').map(r => r.name), ['f03.zip'])
    assert.ok(rows.filter(r => r.name !== 'f03.zip').every(r => r.status === 'candidate'))
    assert.equal(s.count(), 11)
    // 修法 2：標 missing 不動候選。檔案狀態已經把它擋在清單外了。
    assert.equal(s.candStatus('f03.zip', 'archive'), 'proposed')
  })

  test('根目錄叫「下載📥」：刪掉的檔會被標成 missing', t => {
    const s = sandbox(t, '下載📥')
    s.put('a.zip'); s.put('b.zip')
    s.scan()
    unlinkSync(join(s.dl, 'a.zip'))
    s.scan()
    assert.equal(s.status('a.zip'), 'missing')
    assert.deepEqual(s.names(), ['b.zip'])
  })

  test('檔案搬出去又搬回來：候選還是 proposed，自然回到清單', t => {
    const s = sandbox(t)
    s.put('a.zip'); s.put('sub/b.zip'); s.put('sub/c.msi')
    s.scan()
    renameSync(join(s.dl, 'sub'), join(s.dir, 'sub-away'))
    s.scan()
    assert.deepEqual(s.names(), ['a.zip'])
    renameSync(join(s.dir, 'sub-away'), join(s.dl, 'sub'))
    s.scan()
    assert.deepEqual(s.names(), ['a.zip', 'b.zip', 'c.msi'])
  })

  test('已經搬進隔離區的列，不可以被蓋成 missing', t => {
    const s = sandbox(t)
    const a = s.put('a.zip')
    s.scan()
    const p = createPlan(s.db)
    assert.equal(exec.applyPlan(s.db, p.id, s.opts).status, 'applied')
    assert.equal(s.status('a.zip'), 'quarantined')
    // 另一個行程的單檔掃描（或 watcher）看到原路徑不在了
    s.scan({ paths: [a] })
    assert.equal(s.status('a.zip'), 'quarantined')
  })

  test('掃描結果的 candidates 不算已經不見的檔（推論：修法 2 讓 missing 的候選留在 proposed）', t => {
    const s = sandbox(t)
    s.put('a.zip'); s.put('b.zip')
    s.scan()
    unlinkSync(join(s.dl, 'a.zip'))
    const r = s.scan()
    assert.equal(r.candidates, 1)
  })
})

// ── RC2（watcher 那半）────────────────────────────────────────

describe('RC2 watcher 收到事件、路徑是 ENOENT → 標 missing', () => {
  const SETTLE = 40
  function watcherOn(s) {
    const w = createCleanupWatcher({
      db: s.db, roots: [s.dl], maxBytes: s.opts.maxBytes,
      settleMs: SETTLE, tickMs: 10, pollMs: 0, onProblem: m => s.problems.push(m),
    })
    return w
  }
  const cycle = async w => { await sleep(SETTLE + 60); w.tick(); w.tick() }
  const badge = s => healthSnapshot(s.db, { roots: [s.dl], quarantine: s.opts.quarantine }).pendingCandidates

  test('pet 開著，刪掉一個候選檔 → 一次節流週期內從清單與徽章數字消失', async t => {
    const s = sandbox(t)
    const a = s.put('a.zip'); s.put('b.zip')
    s.scan()
    assert.equal(badge(s), 2)
    const w = watcherOn(s)
    w.start()
    t.after(() => w.stop())

    unlinkSync(a)
    w.notice(a)                                   // 等同 fs.watch 的 rename 事件
    await cycle(w)

    assert.deepEqual(s.names(), ['b.zip'])
    assert.equal(badge(s), 1)
    assert.equal(s.status('a.zip'), 'missing')
    assert.equal(s.candStatus('a.zip', 'archive'), 'proposed', '一樣不動候選')
  })

  test('搬出去再原封不動搬回來（同內容、同 mtime）→ 回到清單', async t => {
    const s = sandbox(t)
    const a = s.put('a.zip')
    s.scan()
    const w = watcherOn(s)
    w.start()
    t.after(() => w.stop())

    const away = join(s.dir, 'a.zip')
    renameSync(a, away)
    w.notice(a)
    await cycle(w)
    assert.equal(s.status('a.zip'), 'missing')

    // rename 保留 mtime，只有一個事件：指紋跟 watcher 之前記住的一模一樣。
    // 標 missing 時沒忘掉「看過了」的話，這個事件會被當成沒變而跳過。
    renameSync(away, a)
    w.notice(a)
    await cycle(w)
    assert.deepEqual(s.names(), ['a.zip'])
  })

  test('已經搬進隔離區的檔，watcher 看到原路徑不見也不可以蓋成 missing', async t => {
    const s = sandbox(t)
    const a = s.put('a.zip')
    s.scan()
    const w = watcherOn(s)
    w.start()
    t.after(() => w.stop())
    exec.applyPlan(s.db, createPlan(s.db).id, s.opts)
    w.notice(a)
    await cycle(w)
    assert.equal(s.status('a.zip'), 'quarantined')
  })

  test('權限錯誤（EACCES）不算不見', { skip: noPerm }, async t => {
    const s = sandbox(t)
    const b = s.put('sub/b.zip')
    s.scan()
    const w = watcherOn(s)
    w.start()
    t.after(() => w.stop())
    s.lock(join(s.dl, 'sub'))
    w.notice(b)
    await cycle(w)
    s.unlock(join(s.dl, 'sub'))
    assert.notEqual(s.status('b.zip'), 'missing')
  })
})

// ── RC3 ─────────────────────────────────────────────────────

describe('RC3 規則不再成立是 skipped，不是永久 dismissed', () => {
  test('重複檔：掃第 1、2、3 次，候選都還在', t => {
    const s = sandbox(t)
    s.put('report.pdf', 'same content', 20)
    s.put('report (1).pdf', 'same content', 20)
    let first
    for (let i = 1; i <= 3; i++) {
      s.scan()
      const c = s.list().candidates
      assert.equal(c.length, 1, `第 ${i} 次掃描`)
      assert.equal(c[0].kind, 'duplicate', `第 ${i} 次掃描`)
      first ??= c[0].name
      assert.equal(c[0].name, first, '每次都是同一份')
    }
  })

  test('一個 zip 被改過（變新）→ archive 候選消失；30 天後再掃 → 回來', t => {
    const s = sandbox(t)
    const T0 = Date.now()
    const z = s.put('a.zip', 'v1', 40)
    s.scan({ now: new Date(T0) })
    assert.deepEqual(s.names(), ['a.zip'])

    writeFileSync(z, 'v2 changed')
    utimesSync(z, new Date(T0), new Date(T0))
    s.scan({ now: new Date(T0 + 60_000) })       // 十分鐘內：還在變動
    assert.deepEqual(s.names(), [])
    assert.equal(s.candStatus('a.zip', 'archive'), 'skipped', 'dismissed 只留給使用者真的拒絕')

    s.scan({ now: new Date(T0 + 1 * DAY) })       // 一天：不到 30 天
    assert.deepEqual(s.names(), [])

    s.scan({ now: new Date(T0 + 31 * DAY) })
    assert.deepEqual(s.names(), ['a.zip'])
    assert.equal(s.list().candidates[0].kind, 'archive')
  })

  test('保留的那份換手又換回來：重複檔候選會回來（dismissDuplicateIfNoLongerNeeded 改 skipped）', t => {
    const s = sandbox(t)
    const a = s.put('a.bin', 'same', 20)
    s.scan()                                      // a 先被看到 → a 是保留者
    s.put('b.bin', 'same', 20)
    s.scan()
    assert.deepEqual(s.names(), ['b.bin'])

    renameSync(a, join(s.dir, 'a.bin'))           // a 暫時不在 → b 變成唯一的一份
    s.put('c.bin', 'same', 20)
    s.scan()
    assert.deepEqual(s.names(), ['c.bin'], 'b 現在是保留者，不可以再列成重複檔')

    renameSync(join(s.dir, 'a.bin'), a)           // a 回來 → 又是保留者
    s.scan()
    assert.deepEqual(s.names(), ['b.bin', 'c.bin'])
  })

  test('（推論）保留的那份不見了：剩下那份不可以還掛著「重複檔」', t => {
    const s = sandbox(t)
    const a = s.put('a.bin', 'same', 20)
    s.scan()
    s.put('b.bin', 'same', 20)
    s.scan()
    assert.deepEqual(s.names(), ['b.bin'])
    unlinkSync(a)
    s.scan()
    assert.deepEqual(s.names(), [], 'b.bin 現在是唯一的一份')
  })
})

// ── RC4 ─────────────────────────────────────────────────────

describe('RC4 清單只列執行層會收的；計畫是一次性的', () => {
  test('Downloads 有 60 天前的 0 byte desktop.ini：不在清單上（同樣 0 byte 的 .tmp 在）', t => {
    const s = sandbox(t)
    s.put('desktop.ini', '', 60)
    s.put('empty.tmp', '', 60)
    s.scan()
    assert.deepEqual(s.names(), ['empty.tmp'])
  })

  test('檔名叫 credentials 的檔執行層不收 → 不列；credentials.zip 收 → 列', t => {
    const s = sandbox(t)
    s.put('credentials', 'x', 100)
    s.put('credentials.zip', 'y', 100)
    s.scan()
    assert.deepEqual(s.names(), ['credentials.zip'])
  })

  test('兩個一模一樣的 .ini：不列成重複檔', t => {
    const s = sandbox(t)
    s.put('a.ini', 'same', 20)
    s.put('b.ini', 'same', 20)
    s.scan()
    assert.deepEqual(s.names(), [])
  })

  test('名單只有一份：執行層拒收的每一種副檔名，規則都不提議', () => {
    assert.ok(Array.isArray(exec.EXEC_PROTECTED_EXT) && exec.EXEC_PROTECTED_EXT.length >= 12,
      'cleanup-exec.ts 要匯出執行層的受保護副檔名')
    const old = Date.now() - 200 * DAY
    for (const ext of exec.EXEC_PROTECTED_EXT) {
      for (const name of [`old${ext}`, `OLD${ext.toUpperCase()}`]) {
        assert.equal(exec.execRefusesName(name), true, name)
        assert.deepEqual(rules.classifyByRules({ path: `/d/${name}`, bytes: 0, mtimeMs: old }), [], name)
      }
    }
    for (const name of ['credentials', 'token', '.env', 'data.db', 'id_rsa.pub']) {
      assert.equal(exec.execRefusesName(name), true, name)
      assert.deepEqual(rules.classifyByRules({ path: `/d/${name}`, bytes: 0, mtimeMs: old }), [], name)
    }
    for (const name of ['a.zip', 'credentials.zip', 'setup.msi', 'report.pdf']) {
      assert.equal(exec.execRefusesName(name), false, name)
    }
  })

  test('執行層自己還是會擋（第二道防線）', t => {
    const s = sandbox(t)
    const u = s.put('shortcut.url', 'x', 200)
    s.scan()
    const now = new Date().toISOString()
    const item = s.db.prepare(`SELECT id FROM file_items WHERE name='shortcut.url'`).get()
    s.db.prepare(`INSERT INTO cleanup_candidates VALUES ('forced',?,'old-download',?,35,'r','e','proposed',?)`)
      .run(item.id, rules.CLEANUP_RULE_VERSION, now)
    s.db.prepare(`UPDATE file_items SET status='candidate' WHERE id=?`).run(item.id)
    const p = createPlan(s.db, { candidateIds: ['forced'] })
    assert.equal(exec.applyPlan(s.db, p.id, s.opts).status, 'error')
    assert.ok(existsSync(u))
  })

  function failingSecond(t) {
    // b 在建計畫之後被改過 → 套用時 CHANGED；a 照常搬
    const s = sandbox(t)
    s.put('a.zip', 'a', 120)
    const b = s.put('b.zip', 'b', 120)
    s.scan()
    return { ...s, b }
  }
  const touchB = s => {
    writeFileSync(s.b, 'b changed after plan')
    const at = new Date(Date.now() - 120 * DAY)
    utimesSync(s.b, at, at)
  }

  test('一份 partial 計畫之後，失敗的那個檔可以被下一份計畫收進去', t => {
    const s = failingSecond(t)
    const p1 = createPlan(s.db)
    touchB(s)
    assert.equal(exec.applyPlan(s.db, p1.id, s.opts).status, 'partial')
    s.scan()
    const p2 = createPlan(s.db)
    assert.deepEqual(p2.items.map(i => i.name), ['b.zip'])
    assert.equal(exec.applyPlan(s.db, p2.id, s.opts).status, 'applied')
    assert.equal(existsSync(s.b), false)
  })

  test('error 計畫同理：不再佔住檔案', t => {
    const s = failingSecond(t)
    const bid = s.list().candidates.find(c => c.name === 'b.zip').candidateIds
    const p1 = createPlan(s.db, { candidateIds: bid })
    touchB(s)
    assert.equal(exec.applyPlan(s.db, p1.id, s.opts).status, 'error')
    s.scan()
    assert.doesNotThrow(() => createPlan(s.db, { candidateIds: s.list().candidates.find(c => c.name === 'b.zip').candidateIds }))
  })

  test('還沒套用的 proposed 計畫仍然佔住檔案（邊界的另一側）', t => {
    const s = failingSecond(t)
    const ids = s.list().candidates.find(c => c.name === 'b.zip').candidateIds
    createPlan(s.db, { candidateIds: ids })
    assert.throws(() => createPlan(s.db, { candidateIds: ids }), { code: 'CONFLICT' })
  })

  test('重送同一份（同一個 requestId）在套用之後仍然冪等', t => {
    const s = failingSecond(t)
    const p1 = createPlan(s.db, { requestId: 'click-1' })
    touchB(s)
    exec.applyPlan(s.db, p1.id, s.opts)
    s.scan()
    const again = createPlan(s.db, { requestId: 'click-1' })
    assert.equal(again.id, p1.id)
    assert.equal(s.db.prepare('SELECT count(*) n FROM cleanup_plans').get().n, 1)
  })

  test('連跑三晚：有一個檔每晚都搬不動，第 2、3 晚照樣清新的檔，不撞 CONFLICT', t => {
    const s = sandbox(t)
    s.put('stuck.zip', '0123456789', 120)          // 10 bytes，執行層上限 5 bytes → 每晚 UNSAFE_FILE
    const small = { ...s.opts, maxBytes: 5 }
    for (const night of [1, 2, 3]) {
      s.put(`n${night}.zip`, 'new', 120)
      s.scan()
      const p = createPlan(s.db)
      const r = exec.applyPlan(s.db, p.id, small)
      assert.equal(r.status, 'partial', `第 ${night} 晚`)
      assert.equal(existsSync(join(s.dl, `n${night}.zip`)), false, `第 ${night} 晚的新檔要清掉`)
    }
  })
})

// ── RC25 ────────────────────────────────────────────────────

describe('RC25 殘留鎖：owner 帶時間戳，超過 30 分鐘視為殘留', () => {
  function lockDb(t) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-a0919-lock-')))
    const db = open(join(dir, 'data.db'))
    t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
    journal.initCleanup(db)
    const hold = owner => db.prepare('INSERT OR REPLACE INTO cleanup_operation_lock VALUES (1,?,?)').run(process.pid, owner)
    return { db, hold }
  }
  const ago = min => new Date(Date.now() - min * 60_000).toISOString()

  test('pid 還活著（被重用），但鎖是 31 分鐘前拿的 → 視為殘留，拿得到', t => {
    const { db, hold } = lockDb(t)
    hold(`${ago(31)} 00000000-0000-4000-8000-000000000000`)
    assert.equal(journal.withCleanupLock(db, () => 'ran'), 'ran')
  })

  test('pid 還活著、鎖是 29 分鐘前拿的 → 還是 BUSY', t => {
    const { db, hold } = lockDb(t)
    hold(`${ago(29)} 00000000-0000-4000-8000-000000000000`)
    assert.throws(() => journal.withCleanupLock(db, () => 'ran'), { code: 'BUSY' })
  })

  test('拿鎖時寫進去的 owner 帶著現在的時間', t => {
    const { db } = lockDb(t)
    const owner = journal.withCleanupLock(db, () =>
      db.prepare('SELECT owner FROM cleanup_operation_lock WHERE singleton=1').get().owner)
    const at = Date.parse(owner.split(' ')[0])
    assert.ok(Math.abs(Date.now() - at) < 5_000, owner)
  })

  // 2026-09-19 第二波改了：沒有時間戳的舊格式一律視為殘留（升級之後活著的持有者都寫新格式）。
  // 這一條原本期望 BUSY（fail closed），照新規格改成拿得到。
  test('沒有時間戳的舊格式鎖＋活著的 pid → 視為殘留，拿得到', t => {
    const { db, hold } = lockDb(t)
    hold('someone-else')
    assert.equal(journal.withCleanupLock(db, () => 'ran'), 'ran')
  })
})

// ── RC26 ────────────────────────────────────────────────────

describe('RC26 重複檔的保留者必須是另一個實體檔', () => {
  function aliasSetup(t, withRealCopy) {
    const s = sandbox(t)
    const a = s.put('a.bin', 'same bytes', 20)
    s.scan()
    const row = s.db.prepare(`SELECT * FROM file_items WHERE name='a.bin'`).get()
    // 同一個實體檔的另一種寫法（Windows 上是大小寫不同的兩列）
    const alias = s.dl + '/./a.bin'
    s.db.prepare(`INSERT INTO file_items (id,path,name,ext,bytes,sha256,mtime,first_seen_at,last_seen_at,status,error)
      VALUES ('alias',?,?,?,?,?,?,?,?,'kept',NULL)`)
      .run(alias, 'a.bin', '.bin', row.bytes, row.sha256, row.mtime, '2000-01-01T00:00:00.000Z', row.last_seen_at)
    if (withRealCopy) {
      const b = s.put('b.bin', 'same bytes', 20)
      s.scan({ paths: [b] })
    }
    scanner.addDuplicateCandidates(s.db)
    const dup = s.db.prepare(`SELECT c.id FROM cleanup_candidates c JOIN file_items f ON f.id=c.item_id
      WHERE f.id=? AND c.kind='duplicate'`).get(row.id)
    assert.ok(dup, '前提：a.bin 被當成重複檔提議')
    return { ...s, a, dup: dup.id }
  }

  test('保留者跟要搬的是同一個 dev/ino → 不搬', t => {
    const s = aliasSetup(t, false)
    const p = createPlan(s.db, { candidateIds: [s.dup] })
    const r = exec.applyPlan(s.db, p.id, s.opts)
    assert.equal(r.status, 'error')
    assert.ok(existsSync(s.a), '唯一的一份不可以被搬走')
  })

  test('另外真的有一份（不同 inode）→ 照搬', t => {
    const s = aliasSetup(t, true)
    const p = createPlan(s.db, { candidateIds: [s.dup] })
    assert.equal(exec.applyPlan(s.db, p.id, s.opts).status, 'applied')
    assert.equal(existsSync(s.a), false)
  })
})
