import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * 2026-09-19 稽核第二輪：執行層（cleanup-exec／journal／quarantine／plans／scanner）的修正。
 * 編號對應稽核紀錄「根因（第二輪）」的 R2-1、R2-2、R2-3、R2-5、R2-6、R2-12。
 *
 * ── Step 1（build-round）──────────────────────────────────────────
 *
 * | 段落 | 可能的錯 | 另一種解讀 | 成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | R2-1a recoverInterrupted（quarantine 列） | started 一律當成沒搬 | 看檔案證據 | rename 之後被殺／rename 之前被殺 | 結成 done（moved、undo 放得回）／結成 reverted（NOT_MOVED） |
 * | R2-1a（說不準的） | 隔離區有東西就當成搬好了 | 指紋不對就不動 | 隔離區那份被改過 | 維持 started |
 * | R2-1a（restore 列） | started 一律當成放回了 | 看檔案證據 | 放回之後被殺／放回之前被殺 | done（restored）／failed「復原中斷，沒有放回」，之後再復原放得回 |
 * | R2-1b rename 之後驗證沒過 | 記 failed、檔留在隔離區（隱形） | 搬回原位 | 追加 4 bytes／讀指紋時變動 | 搬回原位、failed「已經放回原位」、隔離區不留東西 |
 * | R2-1b 搬回也不行 | 硬搬、蓋掉原位的新檔 | 不動 | 原位又出現同名新檔 | 新檔不動、那一列維持 started（unknown，看得到） |
 * | R2-1c undo 碰到沒完成的列 | 一律 VERIFY_FAILED | 隔離區只有預留空檔＝不在隔離區 | failed＋原檔被刪／started＋原檔被刪 | 計畫 restored（failed 維持 failed、started 結成 reverted） |
 * | R2-1c 對照 | 對不上就當成不在隔離區 | 隔離區有真的內容就不可以藏起來 | 隔離區那份被改過 | 不結掉、計畫不是 restored |
 * | R2-2 剛下載的重複檔 | 重複檔一律提升成 candidate | 只提升靜置過的 | 剛寫入／十分鐘前 | 不列、不算徽章／列出、預設勾 |
 * | R2-2 mtime 在未來 | 過一陣子就列 | 永遠 new | mtime 一年後 | 不列 |
 * | R2-3 partial／error 再 apply | 重試失敗項 | 原樣回傳 | 用別份計畫搬走又放回之後／復原失敗之後 | 原樣回傳、檔留在原位 |
 * | R2-3 對照 | proposed 也原樣回傳 | proposed 接著做 | 中斷的 proposed | 接著做完、applied |
 * | R2-5a releaseStalePlans | 看建立時間就作廢 | 還要沒有 journal | 一小時前沒開始／一小時前有 journal／剛建的 | 作廢／不動／不動 |
 * | R2-6 markFailure | 無條件改成 failed | 只改進行中的 | 另一個行程已經寫好 done | done 不變、不記失敗 |
 * | R2-6 清空被 BUSY 打斷 | 結果只在最後寫 | 每刪一個就存 | 刪了 1 個之後鎖被接走、同一個確認碼重送 | 總數 3 |
 * | R2-6 鎖的時間戳在未來 | 只看往前 | 前後都算 | 31 分鐘後／29 分鐘後 | 殘留（接得走）／BUSY |
 * | R2-12a release 與 dismiss | 共用 dismissed 就互相變 no-op | 分開記 | release 後 dismiss／dismiss 後 release | 候選作廢／原樣 |
 * | R2-12a 舊版遷移 | release 過的算「拒絕過」 | 排除有 release 標記的 | release 過／dismiss 過 | 修回來／不修 |
 * | R2-12b 預覽表清理 | 只有路由清 | 核心清 | 過期兩天／過期一小時 | 刪／留 |
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs, {
  appendFileSync, chmodSync, existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyPlan, undoPlan, listQuarantine, recoverInterrupted, NOT_MOVED,
} from '../core/cleanup-exec.ts'
import { createPlan, dismissPlan, getPlan, releasePlan, releaseStalePlans } from '../core/cleanup-plans.ts'
import { prepareEmptyQuarantine, emptyQuarantine } from '../core/cleanup-quarantine.ts'
import { lockClock, withCleanupLock } from '../core/cleanup-journal.ts'
import { scanDownloads, LEGACY_DISMISSED_REPAIR_KEY } from '../core/cleanup-scanner.ts'
import { planOutcomes, listCandidates, healthSnapshot } from '../core/cleanup-routes.ts'
import { fixture } from './helpers/cleanup.mjs'

assert.ok(FAKE_HOME, '前提：測試行程的家目錄已經換掉')

const HERE = dirname(fileURLToPath(import.meta.url))
const CHILD = join(HERE, 'helpers', 'r2-crash-child.mjs')
const CLI = join(HERE, '..', 'cli.mjs')

const nameOf = (db, id) => db.prepare('SELECT name FROM file_items WHERE id=?').get(id).name
const outcomes = (f, planId) => Object.fromEntries([...planOutcomes(f.db, planId)].map(([id, o]) => [nameOf(f.db, id), o]))
const row = (f, planId, name, op = 'quarantine') => f.db.prepare(
  `SELECT j.* FROM cleanup_journal j JOIN file_items i ON i.id=j.item_id
    WHERE j.plan_id=? AND j.op=? AND i.name=? ORDER BY j.seq DESC LIMIT 1`
).get(planId, op, name)
const candidateIdsOf = (f, name) => f.db.prepare(
  `SELECT c.id FROM cleanup_candidates c JOIN file_items i ON i.id=c.item_id WHERE i.name=? AND c.status='proposed'`
).all(name).map(r => r.id)
const planWith = (f, ...names) => createPlan(f.db, { candidateIds: names.flatMap(n => candidateIdsOf(f, n)) })

/** 子行程在指定的那一刻被 SIGKILL（見 helpers/r2-crash-child.mjs）。 */
function crash(f, action, planId, point) {
  const r = spawnSync(process.execPath, [CHILD, f.dbPath, JSON.stringify(f.opts), action, planId, point], {
    encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: f.dir, USERPROFILE: f.dir },
  })
  assert.equal(r.signal, 'SIGKILL', `前提：子行程要在 ${point} 被砍掉：${r.stdout}${r.stderr}`)
}

/** 在這段期間把 fs 的某一支換掉（核心用 named import，要 syncBuiltinESMExports 才換得到）。 */
function withFs(name, wrap, fn) {
  const orig = fs[name]
  fs[name] = wrap(orig)
  syncBuiltinESMExports()
  try { return fn() } finally { fs[name] = orig; syncBuiltinESMExports() }
}
const afterRename = (hook, fn) => withFs('renameSync', orig => function (from, to) {
  const r = orig.call(this, from, to)
  hook(from, to)
  return r
}, fn)

// ═══ R2-1a ・ recoverInterrupted ═══════════════════════════════════

describe('R2-1a recoverInterrupted：只看檔案證據改 journal，不搬任何檔', () => {
  test('單檔計畫在 rename 之後被 SIGKILL（稽查員 A 的 exp8）→ 結成 done：逐項 moved、列在隔離區、undo 放得回', t => {
    const f = fixture(t, { 'only.zip': 'important-ish' })
    const p = f.plan()
    crash(f, 'apply', p.id, 'after-rename')
    const before = row(f, p.id, 'only.zip')
    assert.equal(before.status, 'started', '前提：rename 完、還沒寫 done')
    assert.ok(!existsSync(join(f.downloads, 'only.zip')), '前提：Downloads 已經空了')
    assert.equal(readFileSync(before.to_path, 'utf8'), 'important-ish')

    assert.deepEqual(recoverInterrupted(f.db, f.opts), { recovered: 1 })
    assert.equal(row(f, p.id, 'only.zip').status, 'done')
    assert.equal(outcomes(f, p.id)['only.zip'].outcome, 'moved')
    assert.deepEqual(listQuarantine(f.db).map(q => q.name), ['only.zip'], '隔離區清單看得到它')
    assert.equal(readFileSync(before.to_path, 'utf8'), 'important-ish', '沒有搬任何檔')

    const u = undoPlan(f.db, p.id, f.opts)
    assert.equal(u.status, 'restored')
    assert.equal(readFileSync(join(f.downloads, 'only.zip'), 'utf8'), 'important-ish')
  })

  test('對照：rename 之前被 SIGKILL → 結成 reverted（NOT_MOVED），檔在原位、預留空檔不動', t => {
    const f = fixture(t, { 'only.zip': 'important-ish' })
    const p = f.plan()
    crash(f, 'apply', p.id, 'before-rename')
    const before = row(f, p.id, 'only.zip')
    assert.equal(before.status, 'started')
    assert.equal(statSync(before.to_path).size, 0, '前提：隔離區只有預留的空檔')

    assert.deepEqual(recoverInterrupted(f.db, f.opts), { recovered: 1 })
    const after = row(f, p.id, 'only.zip')
    assert.deepEqual({ status: after.status, error: after.error }, { status: 'reverted', error: NOT_MOVED })
    assert.deepEqual({ ...outcomes(f, p.id)['only.zip'] }, { outcome: 'failed', why: NOT_MOVED })
    assert.equal(readFileSync(join(f.downloads, 'only.zip'), 'utf8'), 'important-ish')
    assert.equal(statSync(before.to_path).size, 0, '預留空檔不刪（只有清空會刪檔）')
  })

  test('說不準的（隔離區那份被改過、原位也沒有）→ 維持 started；再跑一次也是 0', t => {
    const f = fixture(t, { 'only.zip': 'important-ish' })
    const p = f.plan()
    crash(f, 'apply', p.id, 'after-rename')
    const r = row(f, p.id, 'only.zip')
    chmodSync(r.to_path, 0o600)
    appendFileSync(r.to_path, '!')
    assert.deepEqual(recoverInterrupted(f.db, f.opts), { recovered: 0 })
    assert.equal(row(f, p.id, 'only.zip').status, 'started')
    assert.equal(readFileSync(r.to_path, 'utf8'), 'important-ish!', '沒有搬任何檔')
  })

  test('冪等：結完之後再跑一次，recovered 是 0', t => {
    const f = fixture(t, { 'only.zip': 'x' })
    const p = f.plan()
    crash(f, 'apply', p.id, 'after-rename')
    assert.deepEqual(recoverInterrupted(f.db, f.opts), { recovered: 1 })
    assert.deepEqual(recoverInterrupted(f.db, f.opts), { recovered: 0 })
  })

  test('復原在放回之後被 SIGKILL → restore 列結成 done，逐項 restored，隔離區清單沒有它', t => {
    const f = fixture(t, { 'only.zip': 'important-ish' })
    const p = f.plan()
    assert.equal(applyPlan(f.db, p.id, f.opts).status, 'applied')
    crash(f, 'undo', p.id, 'after-rename')
    assert.equal(row(f, p.id, 'only.zip', 'restore').status, 'started', '前提')
    assert.deepEqual(recoverInterrupted(f.db, f.opts), { recovered: 1 })
    assert.equal(row(f, p.id, 'only.zip', 'restore').status, 'done')
    assert.equal(outcomes(f, p.id)['only.zip'].outcome, 'restored')
    assert.deepEqual(listQuarantine(f.db), [])
    assert.equal(readFileSync(join(f.downloads, 'only.zip'), 'utf8'), 'important-ish')
  })

  test('復原在放回之前被 SIGKILL → restore 列結成 failed「復原中斷，沒有放回」，還在隔離區，之後再復原放得回', t => {
    const f = fixture(t, { 'only.zip': 'important-ish' })
    const p = f.plan()
    assert.equal(applyPlan(f.db, p.id, f.opts).status, 'applied')
    const q = row(f, p.id, 'only.zip')
    crash(f, 'undo', p.id, 'before-rename')
    assert.equal(row(f, p.id, 'only.zip', 'restore').status, 'started', '前提')
    assert.deepEqual(recoverInterrupted(f.db, f.opts), { recovered: 1 })
    const r = row(f, p.id, 'only.zip', 'restore')
    assert.deepEqual({ status: r.status, error: r.error }, { status: 'failed', error: '復原中斷，沒有放回' })
    const o = outcomes(f, p.id)['only.zip']
    assert.deepEqual({ outcome: o.outcome, why: o.why }, { outcome: 'moved', why: '復原中斷，沒有放回' })
    assert.equal(readFileSync(q.to_path, 'utf8'), 'important-ish', '還在隔離區')
    assert.deepEqual(listQuarantine(f.db).map(x => x.name), ['only.zip'])

    assert.equal(undoPlan(f.db, p.id, f.opts).status, 'restored')
    assert.equal(readFileSync(join(f.downloads, 'only.zip'), 'utf8'), 'important-ish')
  })
})

// ═══ R2-1b ・ rename 之後驗證沒過 ═════════════════════════════════

describe('R2-1b rename 之後驗證沒過：立刻搬回原位', () => {
  test('rename 之後檔尾被追加 4 bytes（稽查員 A 的 exp5）→ 搬回原位，failed「已經放回原位」，隔離區不留東西', t => {
    const f = fixture(t, { 'a.zip': 'aaaa', 'b.zip': 'bbbbbb' })
    const p = f.plan()
    const r = afterRename((from, to) => { if (from.endsWith('a.zip')) appendFileSync(to, 'more') },
      () => applyPlan(f.db, p.id, f.opts))
    assert.equal(r.status, 'partial')
    assert.equal(readFileSync(join(f.downloads, 'a.zip'), 'utf8'), 'aaaamore', '放回原位，後來寫進去的也在')
    const a = row(f, p.id, 'a.zip')
    assert.equal(a.status, 'failed')
    assert.equal(a.error, '搬進去之後檔案還在變動，已經放回原位。')
    assert.ok(!existsSync(a.to_path), '隔離區那個位置沒有留東西')
    const o = outcomes(f, p.id)['a.zip']
    assert.deepEqual({ outcome: o.outcome, why: o.why }, { outcome: 'failed', why: '搬進去之後檔案還在變動，已經放回原位。' })
    assert.deepEqual(listQuarantine(f.db).map(x => x.name), ['b.zip'])
    assert.equal(undoPlan(f.db, p.id, f.opts).status, 'restored', '復原不會卡在 a')
    assert.equal(readFileSync(join(f.downloads, 'b.zip'), 'utf8'), 'bbbbbb')
  })

  test('讀指紋時檔案還在變（CHANGED）→ 一樣搬回原位', t => {
    const f = fixture(t, { 'a.zip': 'aaaa' })
    const p = f.plan()
    let grow = null
    const r = afterRename((from, to) => { if (from.endsWith('a.zip')) grow = to }, () =>
      withFs('readSync', orig => function (...args) {
        if (grow) { const g = grow; grow = null; appendFileSync(g, 'more') }
        return orig.apply(this, args)
      }, () => applyPlan(f.db, p.id, f.opts)))
    assert.equal(r.status, 'error')
    assert.equal(readFileSync(join(f.downloads, 'a.zip'), 'utf8'), 'aaaamore')
    assert.equal(row(f, p.id, 'a.zip').status, 'failed')
    assert.equal(row(f, p.id, 'a.zip').error, '搬進去之後檔案還在變動，已經放回原位。')
  })

  test('對照：原位又出現同名的新檔 → 不搬回（新檔不動），那一列維持 started，看得到（unknown）', t => {
    const f = fixture(t, { 'a.zip': 'aaaa', 'b.zip': 'bbbbbb' })
    const p = f.plan()
    const r = afterRename((from, to) => {
      if (!from.endsWith('a.zip')) return
      appendFileSync(to, 'more')
      writeFileSync(from, 'NEW DOWNLOAD')
    }, () => applyPlan(f.db, p.id, f.opts))
    assert.equal(r.status, 'partial')
    assert.equal(readFileSync(join(f.downloads, 'a.zip'), 'utf8'), 'NEW DOWNLOAD', '原位的新檔沒有被蓋掉')
    const a = row(f, p.id, 'a.zip')
    assert.equal(a.status, 'started', '不可以記成 failed（failed 的意思是「原檔還在原位」）')
    assert.equal(readFileSync(a.to_path, 'utf8'), 'aaaamore', '檔在隔離區')
    assert.equal(outcomes(f, p.id)['a.zip'].outcome, 'unknown')
    // recoverInterrupted 與 undo 都認得它、都不會把它結成「沒搬」
    assert.deepEqual(recoverInterrupted(f.db, f.opts), { recovered: 0 })
    assert.notEqual(undoPlan(f.db, p.id, f.opts).status, 'restored')
    assert.equal(row(f, p.id, 'a.zip').status, 'started')
    assert.equal(readFileSync(a.to_path, 'utf8'), 'aaaamore')
  })

  test('對照：rename 之後沒有變動 → 照常搬進隔離區', t => {
    const f = fixture(t, { 'a.zip': 'aaaa' })
    const p = f.plan()
    const r = afterRename(() => {}, () => applyPlan(f.db, p.id, f.opts))
    assert.equal(r.status, 'applied')
    assert.ok(!existsSync(join(f.downloads, 'a.zip')))
  })
})

// ═══ R2-1c ・ undo 碰到從沒完成的列 ═══════════════════════════════

describe('R2-1c undo 碰到從沒完成的 quarantine 列', () => {
  const eacces = from => { if (from.endsWith('b.zip')) throw Object.assign(new Error('denied'), { code: 'EACCES' }) }
  const failB = (f, p) => withFs('renameSync', orig => function (from, to) { eacces(from); return orig.call(this, from, to) },
    () => applyPlan(f.db, p.id, f.opts))

  test('套用時 b 失敗（隔離區留預留空檔）、使用者後來刪掉 b（稽查員 A 的 exp1／exp2）→ 復原是 restored，b 維持 failed；再復原一次一樣', t => {
    const f = fixture(t, { 'a.zip': 'aaaa', 'b.zip': 'bbbb' })
    const p = f.plan()
    assert.equal(failB(f, p).status, 'partial')
    const b = row(f, p.id, 'b.zip')
    assert.equal(b.status, 'failed', '前提')
    assert.equal(statSync(b.to_path).size, 0, '前提：隔離區留的是預留空檔')
    rmSync(join(f.downloads, 'b.zip'))
    const u = undoPlan(f.db, p.id, f.opts)
    assert.equal(u.status, 'restored', `不是 partial：${u.error}`)
    assert.equal(readFileSync(join(f.downloads, 'a.zip'), 'utf8'), 'aaaa')
    assert.equal(row(f, p.id, 'b.zip').status, 'failed')
    assert.equal(outcomes(f, p.id)['b.zip'].outcome, 'failed')
    assert.equal(undoPlan(f.db, p.id, f.opts).status, 'restored')
  })

  test('started（rename 之前被殺）、使用者後來刪掉原檔 → 結成 reverted，計畫 restored', t => {
    const f = fixture(t, { 'only.zip': 'x' })
    const p = f.plan()
    crash(f, 'apply', p.id, 'before-rename')
    rmSync(join(f.downloads, 'only.zip'))
    const u = undoPlan(f.db, p.id, f.opts)
    assert.equal(u.status, 'restored', `不是 partial／error：${u.error}`)
    const r = row(f, p.id, 'only.zip')
    assert.equal(r.status, 'reverted')
    assert.notEqual(r.error, NOT_MOVED, '原位已經沒有檔，不可以說「檔案還在原位」')
    assert.equal(outcomes(f, p.id)['only.zip'].outcome, 'failed')
  })

  test('對照：隔離區那份有內容但對不上（可能是搬進去之後被改過）→ 不結掉、不藏起來，計畫不是 restored', t => {
    const f = fixture(t, { 'only.zip': 'x' })
    const p = f.plan()
    crash(f, 'apply', p.id, 'after-rename')
    const r = row(f, p.id, 'only.zip')
    chmodSync(r.to_path, 0o600)
    appendFileSync(r.to_path, 'changed')
    const u = undoPlan(f.db, p.id, f.opts)
    assert.notEqual(u.status, 'restored')
    assert.equal(row(f, p.id, 'only.zip').status, 'started')
    assert.equal(outcomes(f, p.id)['only.zip'].outcome, 'unknown')
    assert.equal(readFileSync(r.to_path, 'utf8'), 'xchanged')
  })
})

// ═══ R2-2 ・ 剛下載的重複檔 ═══════════════════════════════════════

describe('R2-2 重複檔只提升可以建計畫的狀態', () => {
  const statusOf = (f, name) => f.db.prepare('SELECT status FROM file_items WHERE name=?').get(name)?.status
  const listed = f => listCandidates(f.db, { roots: f.opts.roots }).candidates
  const pending = f => healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine }).pendingCandidates

  test('剛寫入的 report (1).pdf（稽查員 A 的 exp10）→ 不列、不算徽章；十分鐘後再掃 → 列出、預設勾', t => {
    const f = fixture(t, { 'report.pdf': 'same content' })
    const copy = join(f.downloads, 'report (1).pdf')
    writeFileSync(copy, 'same content')
    // watcher 的單檔掃描也走同一條
    scanDownloads({ db: f.db, ...f.opts, paths: [copy] })
    assert.equal(statusOf(f, 'report (1).pdf'), 'new')
    f.scan()
    assert.equal(statusOf(f, 'report (1).pdf'), 'new')
    assert.deepEqual(listed(f).map(c => c.name), [])
    assert.equal(pending(f), 0)

    const tenMinutesAgo = new Date(Date.now() - 11 * 60_000)
    utimesSync(copy, tenMinutesAgo, tenMinutesAgo)
    f.scan()
    assert.equal(statusOf(f, 'report (1).pdf'), 'candidate')
    const c = listed(f).find(c => c.name === 'report (1).pdf')
    assert.ok(c, '靜置之後要列出來')
    assert.equal(c.defaultChecked, true)
    assert.equal(pending(f), 1)
  })

  test('mtime 在未來的重複檔 → 永遠不列', t => {
    const f = fixture(t, { 'report.pdf': 'same content' })
    const copy = join(f.downloads, 'copy.pdf')
    writeFileSync(copy, 'same content')
    const future = new Date(Date.now() + 365 * 86400_000)
    utimesSync(copy, future, future)
    f.scan()
    assert.equal(statusOf(f, 'copy.pdf'), 'new')
    scanDownloads({ db: f.db, ...f.opts, now: new Date(Date.now() + 3600_000) })
    assert.equal(statusOf(f, 'copy.pdf'), 'new')
    assert.deepEqual(listed(f).map(c => c.name), [])
  })

  test('對照：本來是重複檔候選、之後又被動過（變成 new）→ 候選收掉，不列', t => {
    const f = fixture(t, { 'report.pdf': 'same content', 'report (1).pdf': 'same content' })
    // 同一輪看到的兩份，保留者照路徑排；列出來的是另一份
    const extra = listed(f).map(c => c.name)
    assert.equal(extra.length, 1, '前提：舊的重複檔列得出來')
    const now = new Date()
    utimesSync(join(f.downloads, extra[0]), now, now)
    f.scan()
    assert.equal(statusOf(f, extra[0]), 'new')
    assert.deepEqual(listed(f).map(c => c.name), [])
  })
})

// ═══ R2-3 ・ 計畫一次性 ═══════════════════════════════════════════

describe('R2-3 partial／error 的計畫再 apply：原樣回傳，不重試', () => {
  const touch = path => { const now = new Date(); utimesSync(path, now, now) }
  const journalCount = (f, id) => f.db.prepare('SELECT count(*) n FROM cleanup_journal WHERE plan_id=?').get(id).n

  test('A 計畫 partial → 用 B 計畫搬走 x 又放回（使用者要留著）→ 再送 apply A：原樣 partial，x 還在（稽查員 B 的 r3）', t => {
    const f = fixture(t, { 'x.zip': 'x', 'y.zip': 'y' })
    const A = f.plan()
    const x = join(f.downloads, 'x.zip')
    touch(x)
    assert.equal(applyPlan(f.db, A.id, f.opts).status, 'partial', '前提：x 太新')
    utimesSync(x, f.old, f.old)
    f.scan()
    const B = planWith(f, 'x.zip')
    assert.equal(applyPlan(f.db, B.id, f.opts).status, 'applied')
    assert.equal(undoPlan(f.db, B.id, f.opts).status, 'restored')
    const n = journalCount(f, A.id)
    const again = applyPlan(f.db, A.id, f.opts)
    assert.equal(again.status, 'partial')
    assert.equal(again.quarantinedCount, 1)
    assert.equal(readFileSync(x, 'utf8'), 'x', 'x 沒有被再搬一次')
    assert.equal(journalCount(f, A.id), n, '沒有重試任何項目')
  })

  test('套用 partial → 復原時隔離區的檔被改過（error，沒有復原紀錄）→ 再送 apply：原樣 error，x 還在（稽查員 B 的 r9）', t => {
    const f = fixture(t, { 'x.zip': 'x', 'y.zip': 'y' })
    const A = f.plan()
    const x = join(f.downloads, 'x.zip')
    touch(x)
    assert.equal(applyPlan(f.db, A.id, f.opts).status, 'partial')
    utimesSync(x, f.old, f.old)
    const yq = row(f, A.id, 'y.zip').to_path
    chmodSync(yq, 0o600)
    appendFileSync(yq, '!')
    assert.equal(undoPlan(f.db, A.id, f.opts).status, 'error', '前提')
    const n = journalCount(f, A.id)
    const again = applyPlan(f.db, A.id, f.opts)
    assert.equal(again.status, 'error')
    assert.equal(readFileSync(x, 'utf8'), 'x')
    assert.equal(journalCount(f, A.id), n)
  })

  test('對照：做到一半中斷的 proposed（有 journal）→ 接著做完', t => {
    const f = fixture(t, { 'a.zip': 'aaaa', 'b.zip': 'bbbb' })
    const p = f.plan()
    crash(f, 'apply', p.id, 'after-rename')
    assert.equal(getPlan(f.db, p.id).status, 'proposed', '前提')
    assert.equal(applyPlan(f.db, p.id, f.opts).status, 'applied')
    assert.ok(!existsSync(join(f.downloads, 'a.zip')) && !existsSync(join(f.downloads, 'b.zip')))
  })
})

// ═══ R2-5a ・ releaseStalePlans ═══════════════════════════════════

describe('R2-5a releaseStalePlans：放了很久、從沒開始的計畫自動作廢', () => {
  test('一小時前建、沒開始的 → 作廢（候選不動）；一小時前建、有 journal 的 → 不動；剛建的 → 不動', t => {
    const f = fixture(t, { 'a.zip': 'a', 'b.zip': 'b', 'c.zip': 'c' })
    const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString()
    const stale = planWith(f, 'a.zip')
    const started = planWith(f, 'b.zip')
    const fresh = planWith(f, 'c.zip')
    f.db.prepare('UPDATE cleanup_plans SET created_at=? WHERE id IN (?,?)').run(hourAgo, stale.id, started.id)
    f.db.prepare(`INSERT INTO cleanup_journal(ts,plan_id,item_id,op,status) VALUES (?,?,?,'skip','done')`)
      .run(hourAgo, started.id, started.items[0].itemId)

    assert.equal(releaseStalePlans(f.db, 30 * 60_000), 1)
    assert.equal(getPlan(f.db, stale.id).status, 'dismissed')
    assert.equal(getPlan(f.db, started.id).status, 'proposed')
    assert.equal(getPlan(f.db, fresh.id).status, 'proposed')
    assert.deepEqual(f.db.prepare('SELECT plan_id FROM cleanup_plan_releases').all().map(r => r.plan_id), [stale.id])
    // 候選不動：a 還在清單上、還能建新計畫
    assert.ok(candidateIdsOf(f, 'a.zip').length > 0)
    assert.equal(planWith(f, 'a.zip').status, 'proposed')
    assert.equal(releaseStalePlans(f.db, 30 * 60_000), 0, '沒有別的可以作廢')
  })
})

// ═══ R2-6 ・ 鎖被接手後的資料 ══════════════════════════════════════

describe('R2-6 鎖被接手之後', () => {
  test('A 卡在 rename 之前超過 30 分鐘、B 接手做完（稽查員 A 的 exp4）→ B 寫好的 done 不會被 A 改成 failed', t => {
    const f = fixture(t, { 'a.zip': 'aaaa', 'b.zip': 'bbbbbb' })
    const p = f.plan()
    const clock = lockClock.now
    let skew = 0
    lockClock.now = () => Date.now() + skew
    t.after(() => { lockClock.now = clock })
    let hook = () => {
      skew = 31 * 60_000
      assert.equal(applyPlan(f.db, p.id, f.opts).status, 'applied', '前提：B 把整份做完')
    }
    withFs('renameSync', orig => function (from, to) {
      if (hook) { const h = hook; hook = null; h() }
      return orig.call(this, from, to)
    }, () => assert.throws(() => applyPlan(f.db, p.id, f.opts), { code: 'BUSY' }))
    const rows = f.db.prepare(`SELECT status FROM cleanup_journal WHERE plan_id=? AND op='quarantine'`).all(p.id)
    assert.deepEqual(rows.map(r => r.status), ['done', 'done'])
    assert.ok(Object.values(outcomes(f, p.id)).every(o => o.outcome === 'moved' && o.why === null))
    assert.equal(getPlan(f.db, p.id).status, 'applied')
    assert.equal(f.db.prepare('SELECT count(*) n FROM cleanup_item_errors WHERE plan_id=?').get(p.id).n, 0)
    assert.equal(listQuarantine(f.db).length, 2)
  })

  test('清空刪了 1 個之後鎖被接走（稽查員 B 的 r1）→ 同一個確認碼重送，總數是 3', t => {
    const f = fixture(t, { 'a.zip': 'aaaa', 'b.zip': 'bbbb', 'c.zip': 'cccc' })
    const p = f.plan()
    assert.equal(applyPlan(f.db, p.id, f.opts).status, 'applied')
    f.db.prepare('UPDATE cleanup_move_details SET completed_at=?').run(new Date(Date.now() - 8 * 86400_000).toISOString())
    const prep = prepareEmptyQuarantine(f.db, f.opts)
    assert.equal(prep.itemCount, 3)
    f.db.exec(`CREATE TRIGGER steal AFTER UPDATE OF status ON cleanup_purges WHEN NEW.status='done'
      BEGIN UPDATE cleanup_operation_lock SET owner='2099-01-01T00:00:00.000Z thief'; END`)
    assert.throws(() => emptyQuarantine(f.db, { ...f.opts, token: prep.token, confirmed: true }), { code: 'BUSY' })
    f.db.exec('DROP TRIGGER steal')
    f.db.exec('DELETE FROM cleanup_operation_lock')
    assert.equal(f.db.prepare(`SELECT count(*) n FROM cleanup_purges WHERE status='done'`).get().n, 1, '前提：刪了 1 個')
    const r = emptyQuarantine(f.db, { ...f.opts, token: prep.token, confirmed: true })
    assert.deepEqual({ count: r.deletedCount, bytes: r.deletedBytes, errors: r.errors }, { count: 3, bytes: 12, errors: [] })
    assert.deepEqual(Object.keys(r).sort(), ['deletedBytes', 'deletedCount', 'errors'], '回應形狀不變')
    const again = emptyQuarantine(f.db, { ...f.opts, token: prep.token, confirmed: true })
    assert.deepEqual(again, r, '之後重送拿到同一份結果')
  })

  describe('鎖的時間戳', () => {
    const hold = (db, at) => db.prepare('INSERT OR REPLACE INTO cleanup_operation_lock VALUES (1,?,?)')
      .run(process.pid, `${new Date(at).toISOString()} someone-else`)

    test('在未來 31 分鐘（時鐘往回調過）→ 算殘留，接得走', t => {
      const f = fixture(t)
      withCleanupLock(f.db, () => {})   // 建表
      hold(f.db, Date.now() + 31 * 60_000)
      assert.equal(withCleanupLock(f.db, () => 'mine'), 'mine')
    })

    test('對照：在未來 29 分鐘 → 還算有效，BUSY', t => {
      const f = fixture(t)
      withCleanupLock(f.db, () => {})
      hold(f.db, Date.now() + 29 * 60_000)
      assert.throws(() => withCleanupLock(f.db, () => 'mine'), { code: 'BUSY' })
      f.db.prepare('DELETE FROM cleanup_operation_lock').run()
    })
  })
})

// ═══ R2-12a ・ release 與 dismiss 分開 ════════════════════════════

describe('R2-12a release 與 dismiss 分開記', () => {
  const listedNames = f => listCandidates(f.db, { roots: f.opts.roots }).candidates.map(c => c.name)
  const releases = f => f.db.prepare('SELECT plan_id FROM cleanup_plan_releases').all().map(r => r.plan_id)

  test('先 release 再 dismiss（稽查員 B 的 r8）→ 候選作廢、release 標記拿掉，重掃之後不列', t => {
    const f = fixture(t, { 'a.zip': 'a' })
    const p = f.plan()
    assert.equal(releasePlan(f.db, p.id).status, 'dismissed')
    assert.deepEqual(releases(f), [p.id])
    assert.equal(dismissPlan(f.db, p.id).status, 'dismissed')
    assert.deepEqual(releases(f), [])
    f.scan()
    assert.deepEqual(listedNames(f), [])
  })

  test('對照：只 release → 重掃之後還在清單上；再 release 一次原樣回傳', t => {
    const f = fixture(t, { 'a.zip': 'a' })
    const p = f.plan()
    releasePlan(f.db, p.id)
    assert.equal(releasePlan(f.db, p.id).status, 'dismissed')
    f.scan()
    assert.deepEqual(listedNames(f), ['a.zip'])
  })

  test('先 dismiss 再 release → 原樣回傳，候選還是作廢，沒有 release 標記', t => {
    const f = fixture(t, { 'a.zip': 'a' })
    const p = f.plan()
    dismissPlan(f.db, p.id)
    assert.equal(releasePlan(f.db, p.id).status, 'dismissed')
    assert.deepEqual(releases(f), [])
    f.scan()
    assert.deepEqual(listedNames(f), [])
  })

  test('舊版遷移：release 過的計畫不算「使用者拒絕過」，被舊掃描器誤作廢的候選修得回來', t => {
    const f = fixture(t, { 'a.zip': 'a' })
    const p = f.plan()
    f.db.prepare(`UPDATE cleanup_candidates SET status='dismissed'`).run()     // 舊掃描器誤作廢
    f.db.prepare('DELETE FROM meta WHERE k=?').run(LEGACY_DISMISSED_REPAIR_KEY) // 升級後還沒掃過
    releasePlan(f.db, p.id)
    f.scan()
    assert.deepEqual(listedNames(f), ['a.zip'])
  })

  test('對照：dismiss 過的計畫（使用者真的拒絕）→ 遷移不修', t => {
    const f = fixture(t, { 'a.zip': 'a' })
    const p = f.plan()
    dismissPlan(f.db, p.id)
    f.db.prepare('DELETE FROM meta WHERE k=?').run(LEGACY_DISMISSED_REPAIR_KEY)
    f.scan()
    assert.deepEqual(listedNames(f), [])
  })
})

// ═══ R2-12b ・ 清空預覽表的清理搬進核心 ════════════════════════════

describe('R2-12b prepareEmptyQuarantine 自己清過期超過一天的預覽', () => {
  const tokens = f => f.db.prepare('SELECT token FROM cleanup_empty_requests ORDER BY token').all().map(r => r.token)
  const insert = (f, token, expiresAt) => f.db.prepare(
    'INSERT INTO cleanup_empty_requests(token,expires_at,entries) VALUES (?,?,?)'
  ).run(token, new Date(expiresAt).toISOString(), '[]')

  test('過期兩天的刪、過期一小時的留', t => {
    const f = fixture(t)
    withCleanupLock(f.db, () => {})
    insert(f, 'old', Date.now() - 2 * 86400_000)
    insert(f, 'recent', Date.now() - 3600_000)
    const prep = prepareEmptyQuarantine(f.db, f.opts)
    assert.deepEqual(tokens(f), [prep.token, 'recent'].sort())
  })

  test('CLI 的預覽也會清（稽查員 B 的 r10）', t => {
    const f = fixture(t, { 'a.zip': 'a' })
    const p = f.plan()
    assert.equal(applyPlan(f.db, p.id, f.opts).status, 'applied')
    f.db.prepare('UPDATE cleanup_move_details SET completed_at=?').run(new Date(Date.now() - 8 * 86400_000).toISOString())
    for (const k of ['o1', 'o2', 'o3']) insert(f, k, Date.now() - 2 * 86400_000)
    const cfg = join(f.dir, 'config.json')
    writeFileSync(cfg, JSON.stringify({
      watch: [f.downloads], filed: join(f.dir, 'Filed'),
      model: { baseUrl: '', name: '', keyEnv: 'CONTEXTBOX_MODEL_KEY' },
      readonly: false, pdfPages: 3, maxBytes: 20971520, cleanup: { roots: [f.downloads] },
    }))
    const r = spawnSync(process.execPath, [CLI, 'cleanup', 'quarantine', '--empty'], {
      encoding: 'utf8', timeout: 60_000,
      env: {
        ...process.env, HOME: f.dir, USERPROFILE: f.dir, CONTEXTBOX_PORT: '0',
        CONTEXTBOX_CONFIG: cfg, CONTEXTBOX_DB: f.dbPath,
        CONTEXTBOX_QUARANTINE: f.opts.quarantine, CONTEXTBOX_TOKEN_PATH: join(f.dir, 'token'),
      },
    })
    assert.equal(r.status, 0, (r.stdout ?? '') + (r.stderr ?? ''))
    assert.match(r.stdout, /--yes /, '前提：真的做了預覽')
    const left = tokens(f)
    assert.equal(left.length, 1, `過期超過一天的三列要清掉：${left}`)
    assert.ok(!left.some(k => k.startsWith('o')))
  })
})
