import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * 2026-09-19 稽核第三輪：執行層（cleanup-exec／quarantine／plans／routes 的 outcomesOf）的修正。
 * 編號對應第三輪稽核紀錄的 R3-1、R3-2、R3-3、R3-4、R3-5、R3-6、R3-8、R3-13。
 *
 * ── Step 1（build-round）：哪裡會錯＋另一種解讀＋分得出兩者的邊界例子 ───────────
 *
 * | 段落 | 可能的錯 | 另一種解讀 | 成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | R3-1 收計畫 | journal 結掉就好，計畫 status 不動 | 沒有 started、也沒有沒處理到的項目 → 照實收 | 單檔 rename 後被殺／三檔只做完一個 | applied、寵物不再說「等你確認」／維持 proposed |
 * | R3-1 什麼算「沒處理到」 | 沒有 journal 列就算處理過 | 沒有 journal 列**也**沒有存下來的原因才算沒處理到 | 一項搬成、一項 TOO_FRESH（有 cleanup_item_errors） | partial（不是維持 proposed） |
 * | R3-1 全失敗 | 沒搬成就維持 proposed | 全部失敗＝error | 兩項都 TOO_FRESH | error |
 * | R3-1 安全網 | 剛建好的計畫也被收掉 | 一項都沒碰過的維持 proposed | 剛建好、沒跑過 | proposed，候選不動 |
 * | R3-1 復原完的 | 收成 applied | 全部放回了＝restored | 兩項都 restore done、status 卻是 proposed | restored |
 * | R3-2 no-op | 重送跟真的搬長得一樣 | 多一個 noop 布林 | 第一次 apply／同一份再 apply | noop false／noop true |
 * | R3-2 undo 的 no-op | 只有 apply 有 | 兩支都要有 | 第一次 undo／再 undo | false／true |
 * | R3-3 鎖被接走 | 丟例外，做過的事沒人回報 | 停在那裡、回 stoppedEarly | 四檔、第二項前被接走／沒被接走 | 回傳帶 stoppedEarly、已搬的是 moved、計畫還是 proposed／沒有 stoppedEarly |
 * | R3-3 清空被接走 | 丟例外 | 回 stoppedEarly，已刪的算進去 | 三檔、刪掉 1 個之後被接走 | deletedCount 1、stoppedEarly、重送接得完 |
 * | R3-4 搬進去了、驗證沒過、搬不回去 | journal 維持 started（誰都看不到） | 檔確實在隔離區就承認它在 | 原位又有同名新檔（putBack 的 wx 失敗） | 那一列 done＋原因、隔離區清單列得出來、orphans 0 |
 * | R3-4 recoverInterrupted | 指紋對不上就維持 started | 隔離區有內容但對不上 → done＋原因 | 隔離區那份被改過／隔離區只有 0 byte 預留檔 | done＋原因／維持 started |
 * | R3-4 undo | 說「沒有這個檔」 | 照實說對不上 | 對它按復原 | 回 error，原因講隔離區的檔對不上，檔不動 |
 * | R3-5 佔位檔 | rename 失敗就留著 0 byte 假檔 | 收掉自己建的 | putBack 的 rename 丟 EACCES | 原位沒有東西 |
 * | R3-5 dropReservation | 只看大小就刪 | dev／ino／mtime／大小全部對得上才刪 | 完全對得上／被換成別的檔／size 不是 0 | 刪／不刪／不刪 |
 * | R3-6 releaseStalePlans | 連使用者指名的那份都作廢 | 可以指名跳過一份 | skipPlanId 指到 A（A、B 都過期） | A 還是 proposed、B 作廢 |
 * | R3-8 cancelled | 全域的 file_items.error 也算證據 | 只看這份計畫自己的證據 | 無關的 file_items.error／這份計畫存下來的原因 | 還是 cancelled／failed |
 * | R3-13 清空的進度 | 確認碼一過期就查不到 | 下一次預覽講得出上次刪了幾個 | 刪 1 個後被接走、確認碼過期 | 預覽帶 previousDeleted.count 1 |
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs, {
  appendFileSync, chmodSync, existsSync, lstatSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { applyPlan, listQuarantine, recoverInterrupted, undoPlan } from '../core/cleanup-exec.ts'
import { createPlan, getPlan, releaseStalePlans } from '../core/cleanup-plans.ts'
import { emptyQuarantine, prepareEmptyQuarantine } from '../core/cleanup-quarantine.ts'
// 命名空間匯入：新匯出的函式還沒寫出來的時候，只有用到它的那幾條紅
import * as quarantine from '../core/cleanup-quarantine.ts'
import {
  healthSnapshot, invalidateQuarantineCache, planOutcomes, quarantineItems, recordItemErrors,
} from '../core/cleanup-routes.ts'
import { fixture } from './helpers/cleanup.mjs'

assert.ok(FAKE_HOME, '前提：測試行程的家目錄已經換掉')

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
/** 寵物「有 N 份清單等你確認」用的就是這個數字（cleanup-routes 的 /pet/state）。 */
const proposedPlans = f => f.db.prepare(`SELECT count(*) n FROM cleanup_plans WHERE status='proposed'`).get().n
const statusOf = (f, id) => f.db.prepare('SELECT status FROM cleanup_plans WHERE id=?').get(id).status

/** 在這段期間把 fs 的某一支換掉（核心用 named import，要 syncBuiltinESMExports 才換得到）。 */
function withFs(name, wrap, fn) {
  const orig = fs[name]
  fs[name] = wrap(orig)
  syncBuiltinESMExports()
  try { return fn() } finally { fs[name] = orig; syncBuiltinESMExports() }
}

/**
 * 「搬進去之後檔案還在變動，原位又出現同名新檔」——LEFT_IN_QUARANTINE 那一支。
 * rename 真的搬（檔進了隔離區），接著動一下隔離區那份的 mtime 讓驗證對不上，
 * 再在原位寫一個新檔，putBack 的 'wx' 就會 EEXIST。全是真實會發生的事，不用 SQLite trigger。
 */
const leftInQuarantine = (f, fn) => withFs('renameSync', orig => function (from, to) {
  const r = orig.call(this, from, to)
  const at = new Date(Date.now() - 1000)
  utimesSync(to, at, at)
  writeFileSync(from, 'browser downloaded it again')
  return r
}, fn)

/** 把隔離區裡每一項的完成時間調到八天前（滿七天，清空看得到）。 */
const ageQuarantine = f => f.db.prepare('UPDATE cleanup_move_details SET completed_at=? WHERE completed_at IS NOT NULL')
  .run(new Date(Date.now() - 8 * 86400_000).toISOString())

/** 處理到第 index 項時把鎖換給別人：下一次續約就會發現鎖不是自己的。 */
const stealAt = (f, index) => i => {
  if (i === index) f.db.prepare(`UPDATE cleanup_operation_lock SET owner='2099-01-01T00:00:00.000Z thief'`).run()
}
const dropLock = f => f.db.exec('DELETE FROM cleanup_operation_lock')

// ═══ R3-1 ・ recoverInterrupted 結完 journal 之後要把計畫也收掉 ══════════

describe('R3-1 收尾之後，做完的計畫不再停在 proposed', () => {
  test('單檔計畫 rename 之後被砍 → 收尾之後 status 是 applied，寵物不再說「有 1 份清單等你確認」', t => {
    const f = fixture(t, { 'only.zip': 'important-ish' })
    const p = f.plan()
    // rename 做完、還沒寫 done 就被砍：等同 test/helpers/r2-crash-child.mjs 的 after-rename
    withFs('renameSync', orig => function (from, to) {
      const r = orig.call(this, from, to)
      throw Object.assign(new Error('模擬：寫 done 之前行程沒了'), { code: 'EIO', afterRename: r })
    }, () => applyPlan(f.db, p.id, f.opts))
    f.db.prepare(`UPDATE cleanup_journal SET status='started',error=NULL WHERE plan_id=?`).run(p.id)
    f.db.prepare(`UPDATE cleanup_plans SET status='proposed',applied_at=NULL,error=NULL WHERE id=?`).run(p.id)
    f.db.prepare('DELETE FROM cleanup_item_errors WHERE plan_id=?').run(p.id)
    assert.equal(row(f, p.id, 'only.zip').status, 'started', '前提：journal 停在 started')
    assert.equal(proposedPlans(f), 1, '前提：寵物看得到一份待確認')

    recoverInterrupted(f.db, f.opts)
    assert.equal(row(f, p.id, 'only.zip').status, 'done')
    assert.equal(statusOf(f, p.id), 'applied', '整份都做完了，計畫不可以還停在 proposed')
    assert.equal(proposedPlans(f), 0, '寵物還在說「有 1 份清單等你確認」')
    assert.ok(getPlan(f.db, p.id).appliedAt, 'applied 要有套用時間')
  })

  test('**中斷在 rename 之前（檔根本沒搬）→ 維持 proposed、接得完**，不可以收成 error', t => {
    // 第三輪的驗證員抓到的回歸：收尾把「確認沒搬、檔還在原位」的那一列（reverted）當成失敗，
    // 單檔計畫因此被收成 error，之後 apply 一律 no-op —— 那個檔再也搬不動。
    const f = fixture(t, { 'only.zip': 'important-ish' })
    const p = f.plan()
    withFs('renameSync', () => function () {
      throw Object.assign(new Error('模擬：rename 之前行程沒了'), { code: 'EIO' })
    }, () => applyPlan(f.db, p.id, f.opts))
    f.db.prepare(`UPDATE cleanup_journal SET status='started',error=NULL WHERE plan_id=?`).run(p.id)
    f.db.prepare(`UPDATE cleanup_plans SET status='proposed',applied_at=NULL,error=NULL WHERE id=?`).run(p.id)
    f.db.prepare('DELETE FROM cleanup_item_errors WHERE plan_id=?').run(p.id)
    assert.ok(existsSync(join(f.downloads, 'only.zip')), '前提：檔還在原位')

    recoverInterrupted(f.db, f.opts)
    assert.equal(row(f, p.id, 'only.zip').status, 'reverted', '確認沒搬')
    assert.equal(statusOf(f, p.id), 'proposed', '檔還在原位＝還沒處理，不可以收成 error')
    const again = applyPlan(f.db, p.id, f.opts)
    assert.equal(again.status, 'applied', '要接得完')
    assert.equal(again.noop, false, '真的搬了，不是 no-op')
    assert.ok(!existsSync(join(f.downloads, 'only.zip')), '檔要進隔離區')
  })

  test('三個檔只做完一個（後面兩個從來沒碰過）→ 維持 proposed，那才是真的中斷', t => {
    const f = fixture(t, { 'a.zip': 'aaaa', 'b.zip': 'bbbb', 'c.zip': 'cccc' })
    const p = f.plan()
    assert.throws(() => applyPlan(f.db, p.id, { ...f.opts, onProgress: i => { if (i === 1) throw new Error('中斷') } }))
    assert.equal(statusOf(f, p.id), 'proposed', '前提')
    recoverInterrupted(f.db, f.opts)
    assert.equal(statusOf(f, p.id), 'proposed', '還有兩個沒處理到，不可以說整份做完了')
    assert.equal(applyPlan(f.db, p.id, f.opts).status, 'applied', '還接得完')
  })

  test('一項搬成、一項檢查沒過（有存下來的原因、沒有 journal 列）→ partial，不是「沒處理到」', t => {
    const f = fixture(t, { 'a.zip': 'aaaa', 'fresh.zip': 'bbbb' })
    const fresh = join(f.downloads, 'fresh.zip')
    const p = f.plan()
    const now = new Date()
    utimesSync(fresh, now, now)                       // 十分鐘內還在變動 → TOO_FRESH
    assert.equal(applyPlan(f.db, p.id, f.opts).status, 'partial', '前提')
    assert.equal(f.db.prepare('SELECT count(*) n FROM cleanup_item_errors WHERE plan_id=?').get(p.id).n, 1, '前提')
    // 模擬「最後那一行寫計畫狀態之前行程就沒了」
    f.db.prepare(`UPDATE cleanup_plans SET status='proposed' WHERE id=?`).run(p.id)
    recoverInterrupted(f.db, f.opts)
    assert.equal(statusOf(f, p.id), 'partial')
  })

  test('兩項都檢查沒過 → error；對照：剛建好、一項都沒碰過的計畫維持 proposed', t => {
    const f = fixture(t, { 'a.zip': 'aaaa', 'b.zip': 'bbbb' })
    const p = f.plan()
    const now = new Date()
    for (const n of ['a.zip', 'b.zip']) utimesSync(join(f.downloads, n), now, now)
    assert.equal(applyPlan(f.db, p.id, f.opts).status, 'error', '前提')
    f.db.prepare(`UPDATE cleanup_plans SET status='proposed' WHERE id=?`).run(p.id)
    recoverInterrupted(f.db, f.opts)
    assert.equal(statusOf(f, p.id), 'error')
  })

  test('對照：剛建好、沒跑過的計畫 → 收尾不碰它（維持 proposed）', t => {
    const f = fixture(t, { 'a.zip': 'aaaa', 'b.zip': 'bbbb' })
    const p = f.plan()
    recoverInterrupted(f.db, f.opts)
    assert.equal(statusOf(f, p.id), 'proposed')
    assert.equal(proposedPlans(f), 1)
  })

  test('全部放回了、status 卻還停在 proposed → 收成 restored', t => {
    const f = fixture(t, { 'a.zip': 'aaaa', 'b.zip': 'bbbb' })
    const p = f.plan()
    assert.equal(applyPlan(f.db, p.id, f.opts).status, 'applied')
    assert.equal(undoPlan(f.db, p.id, f.opts).status, 'restored')
    f.db.prepare(`UPDATE cleanup_plans SET status='proposed' WHERE id=?`).run(p.id)
    recoverInterrupted(f.db, f.opts)
    assert.equal(statusOf(f, p.id), 'restored')
  })
})

// ═══ R3-2 ・ 重送是 no-op，要講出來 ═══════════════════════════════

describe('R3-2 applyPlan／undoPlan 回傳 noop：這一次到底有沒有動到檔', () => {
  test('真的搬了 → noop false；同一份再 apply（applied）→ noop true', t => {
    const f = fixture(t)
    const p = f.plan()
    const first = applyPlan(f.db, p.id, f.opts)
    assert.equal(first.status, 'applied')
    assert.equal(first.noop, false, '真的搬了不可以說是 no-op')
    const again = applyPlan(f.db, p.id, f.opts)
    assert.equal(again.status, 'applied')
    assert.equal(again.noop, true, '重送一個檔都沒動，要講出來')
  })

  test('partial 再 apply → noop true（R2-3 保證它一個檔都不重試）', t => {
    const f = fixture(t, { 'a.zip': 'aaaa', 'fresh.zip': 'bbbb' })
    const p = f.plan()
    const now = new Date()
    utimesSync(join(f.downloads, 'fresh.zip'), now, now)
    assert.equal(applyPlan(f.db, p.id, f.opts).status, 'partial', '前提')
    const again = applyPlan(f.db, p.id, f.opts)
    assert.equal(again.status, 'partial')
    assert.equal(again.noop, true)
  })

  test('error 再 apply → noop true；dismissed 再 apply → noop true', t => {
    const f = fixture(t, { 'a.zip': 'aaaa' })
    const p = f.plan()
    const now = new Date()
    utimesSync(join(f.downloads, 'a.zip'), now, now)
    assert.equal(applyPlan(f.db, p.id, f.opts).status, 'error', '前提')
    assert.equal(applyPlan(f.db, p.id, f.opts).noop, true)
    f.db.prepare(`UPDATE cleanup_plans SET status='dismissed' WHERE id=?`).run(p.id)
    assert.equal(applyPlan(f.db, p.id, f.opts).noop, true)
  })

  test('undo：真的放回 → noop false；再 undo（restored）→ noop true', t => {
    const f = fixture(t)
    const p = f.plan()
    applyPlan(f.db, p.id, f.opts)
    const first = undoPlan(f.db, p.id, f.opts)
    assert.equal(first.status, 'restored')
    assert.equal(first.noop, false)
    assert.equal(undoPlan(f.db, p.id, f.opts).noop, true)
  })
})

// ═══ R3-3 ・ 鎖被接走不丟例外，回 stoppedEarly ═════════════════════

describe('R3-3 鎖中途被接走：停在那裡、照實回報，不丟例外', () => {
  test('套用到一半鎖被接走 → 不丟例外、回 stoppedEarly，已搬的是 moved，計畫留在 proposed（接得完）', t => {
    const f = fixture(t, { 'a.zip': 'aaaa', 'b.zip': 'bbbb', 'c.zip': 'cccc', 'd.zip': 'dddd' })
    const p = f.plan()
    let r
    assert.doesNotThrow(() => { r = applyPlan(f.db, p.id, { ...f.opts, onProgress: stealAt(f, 0) }) })
    assert.ok(r.stoppedEarly, `鎖被接走要回 stoppedEarly：${JSON.stringify(r)}`)
    assert.equal(typeof r.stoppedEarly.why, 'string')
    assert.ok(r.stoppedEarly.why.length > 0)
    assert.equal(r.id, p.id, '回傳要帶計畫 id，使用者才有 undo 的入口')
    assert.equal(r.quarantinedCount, 1, '已經搬進隔離區的要算進去')
    const done = Object.entries(outcomes(f, p.id)).filter(([, o]) => o.outcome === 'moved')
    assert.equal(done.length, 1, '已經搬走的那一個要是 moved')
    assert.equal(statusOf(f, p.id), 'proposed', '計畫要留在 proposed，才接得下去')
    dropLock(f)
    assert.equal(applyPlan(f.db, p.id, f.opts).status, 'applied', '接得完')
  })

  test('對照：沒被接走 → stoppedEarly 不存在（或 false）', t => {
    const f = fixture(t, { 'a.zip': 'aaaa', 'b.zip': 'bbbb' })
    const p = f.plan()
    const r = applyPlan(f.db, p.id, f.opts)
    assert.ok(!r.stoppedEarly, `沒被接走不可以說停在中途：${JSON.stringify(r.stoppedEarly)}`)
  })

  test('復原到一半鎖被接走 → 回 stoppedEarly，已放回的算進 restoredCount，不丟例外', t => {
    const f = fixture(t, { 'a.zip': 'aaaa', 'b.zip': 'bbbb', 'c.zip': 'cccc' })
    const p = f.plan()
    assert.equal(applyPlan(f.db, p.id, f.opts).status, 'applied')
    let r
    assert.doesNotThrow(() => { r = undoPlan(f.db, p.id, { ...f.opts, onProgress: stealAt(f, 0) }) })
    assert.ok(r.stoppedEarly, `鎖被接走要回 stoppedEarly：${JSON.stringify(r)}`)
    assert.equal(r.restoredCount, 1)
    dropLock(f)
    assert.equal(undoPlan(f.db, p.id, f.opts).status, 'restored', '接得完')
  })

  test('清空到一半鎖被接走 → 回 stoppedEarly＋已經刪掉幾個，不丟例外；同一個確認碼重送接得完', t => {
    const f = fixture(t, { 'a.zip': 'aaaa', 'b.zip': 'bbbb', 'c.zip': 'cccc' })
    const p = f.plan()
    assert.equal(applyPlan(f.db, p.id, f.opts).status, 'applied')
    ageQuarantine(f)
    const prep = prepareEmptyQuarantine(f.db, f.opts)
    assert.equal(prep.itemCount, 3, '前提')
    let r
    assert.doesNotThrow(() => {
      r = emptyQuarantine(f.db, { ...f.opts, token: prep.token, confirmed: true, onProgress: stealAt(f, 0) })
    })
    assert.ok(r.stoppedEarly, `清空被接走要回 stoppedEarly：${JSON.stringify(r)}`)
    assert.equal(r.deletedCount, 1, '已經刪掉的要算進回傳')
    dropLock(f)
    const again = emptyQuarantine(f.db, { ...f.opts, token: prep.token, confirmed: true })
    assert.equal(again.deletedCount, 3, '總數要含之前刪掉的')
    assert.ok(!again.stoppedEarly)
  })
})

// ═══ R3-4 ・ 檔確實在隔離區就承認它在 ═════════════════════════════

describe('R3-4 搬進去了、驗證沒過、又搬不回原位：不可以讓它在每個清單裡隱形', () => {
  /** 稽查員 B 的 x2／x7：檔在隔離區、指紋對不上、原位被新檔佔住。 */
  function stuck(t) {
    const f = fixture(t, { 'a.zip': 'archive a' })
    const p = f.plan()
    const r = leftInQuarantine(f, () => applyPlan(f.db, p.id, f.opts))
    const q = row(f, p.id, 'a.zip')
    assert.ok(existsSync(q.to_path) && statSync(q.to_path).size > 0, '前提：檔真的在隔離區')
    return { f, p, q, r }
  }

  test('那一列記成 done＋原因：隔離區清單列得出來、不再算成孤兒、計畫也收得掉', t => {
    const { f, p, q } = stuck(t)
    assert.equal(row(f, p.id, 'a.zip').status, 'done', 'journal 不可以停在 started：那樣誰都看不到它')
    const why = f.db.prepare('SELECT why FROM cleanup_item_errors WHERE plan_id=? AND item_id=?').get(p.id, q.item_id)
    assert.ok(why && /隔離區/.test(why.why), `要把原因寫下來：${JSON.stringify(why)}`)
    assert.deepEqual(listQuarantine(f.db).map(x => x.name), ['a.zip'], '隔離區清單要列得出來')
    assert.deepEqual(quarantineItems(f.db).map(x => x.name), ['a.zip'])
    invalidateQuarantineCache()
    const h = healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine, full: true })
    assert.equal(h.quarantine.items, 1)
    assert.equal(h.quarantine.orphans, 0, '認得它就不是來路不明的檔')
    assert.equal(outcomes(f, p.id)['a.zip'].outcome, 'moved')
    assert.ok(/隔離區/.test(outcomes(f, p.id)['a.zip'].why ?? ''), '逐項要講得出那句話')
    // 收尾不會再被這一列卡住
    assert.deepEqual(recoverInterrupted(f.db, f.opts), { recovered: 0 })
    assert.equal(f.db.prepare(`SELECT count(*) n FROM cleanup_journal WHERE status='started'`).get().n, 0,
      '不可以留下永遠結不掉的 started 列（needsSettling 會永遠是 true）')
  })

  test('undo 照實說「隔離區裡的這個檔跟當初搬進去的對不上」，兩邊的檔都不動', t => {
    const { f, p, q } = stuck(t)
    const before = readFileSync(q.to_path, 'utf8')
    const u = undoPlan(f.db, p.id, f.opts)
    assert.equal(u.status, 'error')
    assert.ok(/對不上|已變更/.test(u.error ?? ''), `要照實說對不上：${u.error}`)
    assert.equal(readFileSync(q.to_path, 'utf8'), before, '隔離區那份不動')
  })

  test('原因活得過 recordItemErrors 與下一次重掃（cleanup_item_errors 才是正本）', t => {
    const { f, p, q } = stuck(t)
    // CLI 套用完馬上會呼叫 recordItemErrors；它以前會把「不是 failed」的那一項的原因刪掉
    recordItemErrors(f.db, p.id)
    const why = f.db.prepare('SELECT why FROM cleanup_item_errors WHERE plan_id=? AND item_id=?').get(p.id, q.item_id)
    assert.ok(why && /隔離區/.test(why.why), `原因被刪掉了，隔離區那個檔又沒有線索：${JSON.stringify(why)}`)
    // 下一次掃描會改寫 file_items.error —— 那句話還是要講得出來
    f.db.prepare('UPDATE file_items SET error=NULL WHERE id=?').run(q.item_id)
    assert.ok(/隔離區/.test(outcomes(f, p.id)['a.zip'].why ?? ''), '重掃之後就講不出原因了')
  })

  test('滿七天之後清空看得到它（不再是「每個清單都空的」）', t => {
    const { f } = stuck(t)
    ageQuarantine(f)
    assert.equal(prepareEmptyQuarantine(f.db, f.opts).itemCount, 1)
  })

  test('清空：內容對不上的放到一邊、不算錯；使用者自己刪掉之後那一列就收掉（不再是死路）', t => {
    const { f } = stuck(t)
    ageQuarantine(f)
    const q = f.db.prepare(`SELECT to_path FROM cleanup_journal WHERE op='quarantine' LIMIT 1`).get()
    // 第一次清空：不刪、不算錯，照實說一句
    const first = emptyQuarantine(f.db, { ...f.opts, token: prepareEmptyQuarantine(f.db, f.opts).token, confirmed: true })
    assert.deepEqual({ deleted: first.deletedCount, errors: first.errors.length, aside: first.setAside.length },
      { deleted: 0, errors: 0, aside: 1 }, '內容對不上就不刪，但不可以算成錯（算錯的話清空永遠回離開碼 3）')
    assert.match(first.setAside[0].why, /內容跟當初搬進去的不一樣/)
    assert.deepEqual(listQuarantine(f.db).map(x => x.name), ['a.zip'], '還在清單上，等使用者自己看')

    // 使用者看過之後自己刪掉：下一次清空要把那一列收掉，清單才會真的空
    rmSync(q.to_path)
    const second = emptyQuarantine(f.db, { ...f.opts, token: prepareEmptyQuarantine(f.db, f.opts).token, confirmed: true })
    assert.deepEqual({ deleted: second.deletedCount, errors: second.errors.length, aside: second.setAside.length },
      { deleted: 0, errors: 0, aside: 1 })
    assert.match(second.setAside[0].why, /已經不在隔離區/)
    assert.deepEqual(listQuarantine(f.db), [], '收掉之後清單要空')
    invalidateQuarantineCache()
    const h = healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine, full: true })
    assert.equal(h.quarantine.items, 0)
  })

  test('recoverInterrupted 認得這種列：隔離區有內容、指紋對不上 → done＋原因', t => {
    const f = fixture(t, { 'a.zip': 'archive a' })
    const p = f.plan()
    // 讓寫 done 失敗 → rename 做完、journal 停在 started（等同被砍在寫 done 之前）
    f.db.exec(`CREATE TRIGGER fail_done BEFORE UPDATE OF status ON cleanup_journal
               WHEN NEW.status='done' BEGIN SELECT RAISE(ABORT,'boom'); END`)
    applyPlan(f.db, p.id, f.opts)
    f.db.exec('DROP TRIGGER fail_done')
    const q = row(f, p.id, 'a.zip')
    assert.equal(q.status, 'started', '前提')
    chmodSync(q.to_path, 0o600)
    appendFileSync(q.to_path, ' CHANGED')          // 搬進去之後還在被寫

    assert.deepEqual(recoverInterrupted(f.db, f.opts), { recovered: 1 })
    assert.equal(row(f, p.id, 'a.zip').status, 'done')
    const why = f.db.prepare('SELECT why FROM cleanup_item_errors WHERE plan_id=? AND item_id=?').get(p.id, q.item_id)
    assert.ok(why && /隔離區/.test(why.why), `要把原因寫下來：${JSON.stringify(why)}`)
    assert.deepEqual(listQuarantine(f.db).map(x => x.name), ['a.zip'])
  })

  test('對照：隔離區那個位置只有 0 byte 的預留空檔（rename 之前就斷了）→ 不可以說它在隔離區', t => {
    const f = fixture(t, { 'a.zip': 'archive a' })
    const p = f.plan()
    withFs('renameSync', () => function () {
      throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' })
    }, () => applyPlan(f.db, p.id, f.opts))
    f.db.prepare(`UPDATE cleanup_journal SET status='started',error=NULL WHERE plan_id=?`).run(p.id)
    const q = row(f, p.id, 'a.zip')
    assert.equal(statSync(q.to_path).size, 0, '前提：只有預留的空檔')
    // 原檔還在原位、指紋對得上 → 走的是 NOT_MOVED 那一支（reverted），不是「在隔離區」
    recoverInterrupted(f.db, f.opts)
    assert.equal(row(f, p.id, 'a.zip').status, 'reverted')
    assert.deepEqual(listQuarantine(f.db), [])
  })
})

// ═══ R3-5 ・ putBack 自己建的佔位檔要收掉 ══════════════════════════

describe('R3-5 putBack 搬不回去時，不可以在使用者資料夾留下 0 byte 的假檔', () => {
  test('putBack 的 rename 失敗 → 原位不留佔位檔，真內容還在隔離區', t => {
    const f = fixture(t, { 'a.zip': 'archive a' })
    const p = f.plan()
    let n = 0
    withFs('renameSync', orig => function (from, to) {
      if (++n === 1) {                       // 搬進隔離區：真的搬，再動 mtime 讓驗證對不上
        const r = orig.call(this, from, to)
        const at = new Date(Date.now() - 1000)
        utimesSync(to, at, at)
        return r
      }
      throw Object.assign(new Error('EACCES: permission denied, rename'), { code: 'EACCES' })
    }, () => applyPlan(f.db, p.id, f.opts))
    const orig = join(f.downloads, 'a.zip')
    assert.ok(!existsSync(orig), `原位留下了 putBack 自己建的空檔：size=${existsSync(orig) ? statSync(orig).size : '-'}`)
    const q = row(f, p.id, 'a.zip')
    assert.equal(readFileSync(q.to_path, 'utf8'), 'archive a', '真的內容還在隔離區')
  })

  test('dropReservation：dev／ino／mtime／大小全部對得上才刪', t => {
    const f = fixture(t, { 'a.zip': 'archive a' })
    const path = join(f.downloads, 'ph.tmp')
    writeFileSync(path, '')
    const st = lstatSync(path)
    const expect = { dev: st.dev, ino: st.ino, mtime: st.mtime.toISOString() }
    assert.equal(quarantine.dropReservation(path, expect), true)
    assert.ok(!existsSync(path))
  })

  test('dropReservation：有人在那一瞬間換成別的檔（dev／ino 對不上）→ 不刪', t => {
    const f = fixture(t, { 'a.zip': 'archive a' })
    const path = join(f.downloads, 'ph.tmp')
    writeFileSync(path, '')
    const st = lstatSync(path)
    const expect = { dev: st.dev, ino: st.ino + 1, mtime: st.mtime.toISOString() }
    assert.equal(quarantine.dropReservation(path, expect), false)
    assert.ok(existsSync(path), '不是自己建的那一個就不可以刪')
  })

  test('dropReservation：不是 0 byte（有人寫了東西進去）→ 不刪', t => {
    const f = fixture(t, { 'a.zip': 'archive a' })
    const path = join(f.downloads, 'ph.tmp')
    writeFileSync(path, '')
    const st = lstatSync(path)
    writeFileSync(path, 'someone wrote here')
    const after = lstatSync(path)
    assert.equal(quarantine.dropReservation(path, { dev: st.dev, ino: st.ino, mtime: after.mtime.toISOString() }), false)
    assert.ok(existsSync(path))
  })

  test('dropReservation：mtime 對不上 → 不刪；檔根本不在 → 回 false，不丟例外', t => {
    const f = fixture(t, { 'a.zip': 'archive a' })
    const path = join(f.downloads, 'ph.tmp')
    writeFileSync(path, '')
    const st = lstatSync(path)
    assert.equal(quarantine.dropReservation(path, { dev: st.dev, ino: st.ino, mtime: '2001-01-01T00:00:00.000Z' }), false)
    assert.ok(existsSync(path))
    assert.equal(quarantine.dropReservation(join(f.downloads, 'nope.tmp'), { dev: 1, ino: 1, mtime: '2001-01-01T00:00:00.000Z' }), false)
  })
})

// ═══ R3-6 ・ releaseStalePlans 可以指名跳過一份 ═════════════════════

describe('R3-6 收尾不可以先把使用者這次指名要套用的那一份作廢', () => {
  test('skipPlanId 指到的那一份不動，其他過期的照樣作廢', t => {
    const f = fixture(t, { 'a.zip': 'aaaa', 'b.zip': 'bbbb' })
    const A = planWith(f, 'a.zip')
    const B = planWith(f, 'b.zip')
    const hourAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
    f.db.prepare('UPDATE cleanup_plans SET created_at=? WHERE id IN (?,?)').run(hourAgo, A.id, B.id)
    assert.equal(releaseStalePlans(f.db, 60 * 60_000, { skipPlanId: A.id }), 1)
    assert.equal(statusOf(f, A.id), 'proposed', '使用者指名的那一份不可以被同一個指令作廢')
    assert.equal(statusOf(f, B.id), 'dismissed')
  })

  test('對照：不給 skipPlanId → 兩份都作廢（舊行為不變）', t => {
    const f = fixture(t, { 'a.zip': 'aaaa', 'b.zip': 'bbbb' })
    const A = planWith(f, 'a.zip')
    const B = planWith(f, 'b.zip')
    const hourAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
    f.db.prepare('UPDATE cleanup_plans SET created_at=? WHERE id IN (?,?)').run(hourAgo, A.id, B.id)
    assert.equal(releaseStalePlans(f.db, 60 * 60_000), 2)
    assert.equal(statusOf(f, A.id), 'dismissed')
    assert.equal(statusOf(f, B.id), 'dismissed')
  })

  test('skipPlanId 不是字串 → BAD_BODY（不要默默忽略）', t => {
    const f = fixture(t, { 'a.zip': 'aaaa' })
    assert.throws(() => releaseStalePlans(f.db, 60 * 60_000, { skipPlanId: 7 }), { code: 'BAD_BODY' })
  })
})

// ═══ R3-8 ・ cancelled 只看這份計畫自己的證據 ═══════════════════════

describe('R3-8 跟這份計畫無關的 file_items.error 不可以把 cancelled 打回 failed', () => {
  /** 一份跑過、但第二項從來沒處理到的計畫（沒有 journal 列、也沒有存下來的原因）。 */
  function untouchedSecond(t) {
    const f = fixture(t, { 'a.zip': 'aaaa', 'b.zip': 'bbbb' })
    const p = f.plan()
    assert.throws(() => applyPlan(f.db, p.id, { ...f.opts, onProgress: i => { if (i === 1) throw new Error('中斷') } }))
    f.db.prepare(`UPDATE cleanup_plans SET status='partial' WHERE id=?`).run(p.id)
    // 計畫裡的順序不是照檔名排的，所以照結果挑出「從來沒處理到」的那一項
    const [name, o] = Object.entries(outcomes(f, p.id)).find(([, x]) => x.outcome === 'cancelled') ?? []
    assert.ok(name, `前提：要有一項從來沒處理到（${JSON.stringify(outcomes(f, p.id))}）`)
    assert.equal(o.why, null)
    const bId = f.db.prepare('SELECT id FROM file_items WHERE name=?').get(name).id
    return { f, p, bId, name }
  }

  test('別的事情把 file_items.error 寫上去（重掃讀不到、另一份計畫失敗）→ 還是 cancelled', t => {
    const { f, p, bId, name } = untouchedSecond(t)
    f.db.prepare(`UPDATE file_items SET error='檔案不見了' WHERE id=?`).run(bId)
    const o = outcomes(f, p.id)[name]
    assert.equal(o.outcome, 'cancelled', `別份計畫／別次掃描的錯不算這一份的：${JSON.stringify(o)}`)
    assert.equal(o.why, null)
  })

  test('對照：這份計畫自己存下來的原因 → 照樣是 failed，講得出原因', t => {
    const { f, p, bId, name } = untouchedSecond(t)
    f.db.prepare(`INSERT INTO cleanup_item_errors (plan_id,item_id,why,at) VALUES (?,?,?,?)`)
      .run(p.id, bId, '這個檔案十分鐘內還在變動，先不搬。等一下再試一次。', new Date().toISOString())
    const o = outcomes(f, p.id)[name]
    assert.equal(o.outcome, 'failed')
    assert.equal(o.why, '這個檔案十分鐘內還在變動，先不搬。等一下再試一次。')
  })
})

// ═══ R3-13 ・ 清空被打斷之後，刪了幾個要查得到 ══════════════════════

describe('R3-13 清空被打斷、確認碼過期之後，還講得出上次刪了幾個', () => {
  test('確認碼過期 → 下一次預覽講得出「上次那批已經刪了 1 個」', t => {
    const f = fixture(t, { 'a.zip': 'aaaa', 'b.zip': 'bbbb', 'c.zip': 'cccc' })
    const p = f.plan()
    assert.equal(applyPlan(f.db, p.id, f.opts).status, 'applied')
    ageQuarantine(f)
    const prep = prepareEmptyQuarantine(f.db, f.opts)
    const first = emptyQuarantine(f.db, { ...f.opts, token: prep.token, confirmed: true, onProgress: stealAt(f, 0) })
    assert.equal(first.deletedCount, 1, '前提：刪了 1 個就被接走')
    dropLock(f)
    f.db.prepare('UPDATE cleanup_empty_requests SET expires_at=? WHERE token=?')
      .run(new Date(Date.now() - 60_000).toISOString(), prep.token)
    assert.throws(() => emptyQuarantine(f.db, { ...f.opts, token: prep.token, confirmed: true }),
      { code: 'CONFIRMATION_EXPIRED' })
    const next = prepareEmptyQuarantine(f.db, f.opts)
    assert.deepEqual(next.previousDeleted, { count: 1, bytes: 4 }, '刪掉的數字不可以就這樣不見了')
  })

  test('對照：沒有中斷過的預覽不帶 previousDeleted', t => {
    const f = fixture(t, { 'a.zip': 'aaaa' })
    const p = f.plan()
    assert.equal(applyPlan(f.db, p.id, f.opts).status, 'applied')
    ageQuarantine(f)
    assert.equal(prepareEmptyQuarantine(f.db, f.opts).previousDeleted, undefined)
  })
})
