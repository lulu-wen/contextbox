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
 *
 * ── 第二階段（第一階段驗證員找到的缺口）──────────────────────────
 *
 * | 段落 | 可能的錯 | 另一種解讀 | 成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | X01 markFailure 回 null（套用） | 當成錯 | 另一個行程做完了＝這一項完成 | 單檔計畫、A 卡在 rename 前、B 接手做完（A 走得到寫計畫狀態）／兩檔（A 在下一次續約丟 BUSY） | A 回 applied、計畫 applied、沒有失敗原因／BUSY（已有） |
 * | X12 markFailure 回 null（復原） | 當成錯 | 同上 | 單檔計畫的復原，B 接手放回 | A 回 restored、計畫 restored |
 * | X08 清空被 BUSY 打斷後重送 | 從第 0 項重來 | 從停下來的那一項接著 | 第 0 項出錯、第 1 項刪掉、鎖被接走／沒有錯（已有） | deletedCount 2、errors 只有 1 條／總數 3、errors [] |
 * | X09 created_at 讀不懂 | NaN 當成很舊、作廢 | fail closed：不動 | created_at 'garbage'（門檻 0）／一小時前 | 0、還是 proposed／1、dismissed |
 * | X02 recoverInterrupted 的鎖 | 不拿鎖就改 journal | 拿鎖 | 鎖被活著、時間新的行程拿著／鎖是 31 分鐘前的殘留 | BUSY、started 不動／照常結掉 |
 * | R2-2 測試在 tmpfs 上 | 兩次掃描落在同一毫秒 → 保留者換人 | 把 report.pdf 看到的時間調早 | first_seen_at 早一小時 | 跟檔案系統快慢無關，連跑 10 次都綠 |
 * | R2-2 保留者平手 | 只比路徑：「report (1).pdf」（' ' < '.'）當保留者、原檔被列成重複 | 名字不像複本的優先，再比路徑 | 同一輪看到 report.pdf＋report (1).pdf／a.pdf＋b.pdf（都不像複本）／report (1)＋report (2) | 列 report (1).pdf、證據說會留著 report.pdf／列 b.pdf／列 report (2).pdf |
 * | R2-2 平手才看名字 | 名字比時間優先 | 最早看到的優先 | report (1).pdf 早一小時被看到、report.pdf 後來才出現 | 保留 report (1).pdf、列 report.pdf |
 * | R2-2 性質 | scanner 與路由的證據各挑各的保留者 | 同一支 keepersFirst | 結構化隨機：80 組、兩個時間、十種字尾、子資料夾，對照照定義排的慢速參考 | 清單＝整組扣掉保留者、證據指名保留者；三種決定方式（時間、名字、路徑）都真的走到 |
 * | NOT_MOVED_GONE | 原檔還在、只是變了也說「找不到」 | 分成兩句 | rename 之前被殺＋原檔被追加／原檔被刪／原檔沒動 | reverted「原位置的檔已經不是當初那一份」／「原位置現在也找不到這個檔」／NOT_MOVED |
 * | dismiss release 過的計畫 | 照樣作廢候選，另一份還沒套用的計畫照搬 | 撞到還活著的計畫就 CONFLICT、什麼都不改 | B（proposed）也有 a.zip／B 已經套用過（不再佔住檔案） | 409、候選與 release 標記都不動、B 照常套用／成功、b 作廢、a（已在隔離區）不動 |
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs, {
  appendFileSync, chmodSync, existsSync, linkSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
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
// 命名空間匯入：新匯出的函式還沒寫出來的時候，只有用到它的那幾條紅
import * as scanner from '../core/cleanup-scanner.ts'
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

  // 稽核第三輪 R3-4 改了這一條的答案：**隔離區有真的內容、原位也沒有 → 檔就是在隔離區**。
  // 以前維持 started，結果 recoverInterrupted 永遠結不掉、undo 拒絕、四個清單都看不到它。
  // 現在記成 done＋「請人工檢查隔離區」，列得出來、清得掉、undo 說得出實話。
  test('隔離區那份被改過、原位也沒有 → 承認它在隔離區（done＋原因）；再跑一次是 0（R3-4）', t => {
    const f = fixture(t, { 'only.zip': 'important-ish' })
    const p = f.plan()
    crash(f, 'apply', p.id, 'after-rename')
    const r = row(f, p.id, 'only.zip')
    chmodSync(r.to_path, 0o600)
    appendFileSync(r.to_path, '!')
    assert.deepEqual(recoverInterrupted(f.db, f.opts), { recovered: 1 })
    assert.equal(row(f, p.id, 'only.zip').status, 'done')
    assert.match(f.db.prepare('SELECT why FROM cleanup_item_errors WHERE plan_id=?').get(p.id).why, /隔離區/)
    assert.deepEqual(listQuarantine(f.db).map(q => q.name), ['only.zip'], '隔離區清單看得到它')
    assert.equal(readFileSync(r.to_path, 'utf8'), 'important-ish!', '沒有搬任何檔')
    assert.deepEqual(recoverInterrupted(f.db, f.opts), { recovered: 0 })
  })

  test('鎖被活著的行程拿著（時間是新的）→ BUSY，started 不動；鎖是 31 分鐘前的殘留 → 照常結掉（突變 X02）', t => {
    const f = fixture(t, { 'only.zip': 'important-ish' })
    const p = f.plan()
    crash(f, 'apply', p.id, 'after-rename')
    const hold = at => f.db.prepare('INSERT OR REPLACE INTO cleanup_operation_lock VALUES (1,?,?)')
      .run(process.pid, `${new Date(at).toISOString()} someone-else`)
    hold(Date.now())
    try {
      assert.throws(() => recoverInterrupted(f.db, f.opts), { code: 'BUSY' })
      assert.equal(row(f, p.id, 'only.zip').status, 'started', '沒拿到鎖就改了 journal')
    } finally { f.db.prepare('DELETE FROM cleanup_operation_lock').run() }
    hold(Date.now() - 31 * 60_000)
    assert.deepEqual(recoverInterrupted(f.db, f.opts), { recovered: 1 })
    assert.equal(row(f, p.id, 'only.zip').status, 'done')
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

  test('對照：原位又出現同名的新檔 → 不搬回（新檔不動），那一列記成 done＋原因，看得到（R3-4）', t => {
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
    // 不可以記成 failed（failed 的意思是「原檔還在原位」），也不可以維持 started（那樣誰都看不到它）：
    // 檔確實在隔離區，就記成 done，把「沒有放回原位，請人工檢查隔離區」存起來（稽核第三輪 R3-4）
    assert.equal(a.status, 'done')
    assert.match(f.db.prepare('SELECT why FROM cleanup_item_errors WHERE plan_id=? AND item_id=?')
      .get(p.id, a.item_id).why, /隔離區/)
    assert.equal(readFileSync(a.to_path, 'utf8'), 'aaaamore', '檔在隔離區')
    assert.equal(outcomes(f, p.id)['a.zip'].outcome, 'moved')
    assert.match(outcomes(f, p.id)['a.zip'].why, /隔離區/)
    assert.deepEqual(listQuarantine(f.db).map(q => q.name).sort(), ['a.zip', 'b.zip'])
    // 收尾不會再被它卡住；undo 照實說隔離區那份對不上，兩邊的檔都不動
    assert.deepEqual(recoverInterrupted(f.db, f.opts), { recovered: 0 })
    assert.notEqual(undoPlan(f.db, p.id, f.opts).status, 'restored')
    assert.equal(row(f, p.id, 'a.zip').status, 'done')
    assert.equal(readFileSync(a.to_path, 'utf8'), 'aaaamore')
    assert.equal(readFileSync(join(f.downloads, 'a.zip'), 'utf8'), 'NEW DOWNLOAD')
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

  test('started（rename 之前被殺）、使用者後來刪掉原檔 → 結成 reverted「原位置現在也找不到這個檔」，計畫 restored', t => {
    const f = fixture(t, { 'only.zip': 'x' })
    const p = f.plan()
    crash(f, 'apply', p.id, 'before-rename')
    rmSync(join(f.downloads, 'only.zip'))
    const u = undoPlan(f.db, p.id, f.opts)
    assert.equal(u.status, 'restored', `不是 partial／error：${u.error}`)
    const r = row(f, p.id, 'only.zip')
    assert.equal(r.status, 'reverted')
    assert.notEqual(r.error, NOT_MOVED, '原位已經沒有檔，不可以說「檔案還在原位」')
    assert.equal(r.error, '搬到一半中斷，沒有搬進隔離區；原位置現在也找不到這個檔。')
    assert.equal(outcomes(f, p.id)['only.zip'].outcome, 'failed')
  })

  test('started（rename 之前被殺）、原檔還在但被改過 → reverted「原位置的檔已經不是當初那一份」，不是「找不到」（驗證員 T4）', t => {
    const f = fixture(t, { 'only.zip': 'important-ish' })
    const p = f.plan()
    crash(f, 'apply', p.id, 'before-rename')
    appendFileSync(join(f.downloads, 'only.zip'), 'more')
    assert.deepEqual(recoverInterrupted(f.db, f.opts), { recovered: 0 }, '前提：兩邊都對不上，recover 維持 started')
    const u = undoPlan(f.db, p.id, f.opts)
    assert.equal(u.status, 'restored', `不是 partial／error：${u.error}`)
    const r = row(f, p.id, 'only.zip')
    assert.deepEqual({ status: r.status, error: r.error },
      { status: 'reverted', error: '搬到一半中斷，沒有搬進隔離區；原位置的檔已經不是當初那一份。' })
    assert.equal(readFileSync(join(f.downloads, 'only.zip'), 'utf8'), 'important-ishmore', '原位的檔不動')
  })

  test('對照：started（rename 之前被殺）、原檔沒動、直接復原（沒先跑 recover）→ reverted（NOT_MOVED）', t => {
    const f = fixture(t, { 'only.zip': 'important-ish' })
    const p = f.plan()
    crash(f, 'apply', p.id, 'before-rename')
    assert.equal(undoPlan(f.db, p.id, f.opts).status, 'restored')
    const r = row(f, p.id, 'only.zip')
    assert.deepEqual({ status: r.status, error: r.error }, { status: 'reverted', error: NOT_MOVED })
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
  /**
   * report.pdf 是一小時前就看到的（保留者）。**不調的話測試跟檔案系統的快慢有關**：tmpfs 上 fixture 的掃描
   * 與下一次掃描常常落在同一毫秒，first_seen_at 平手（第一階段驗證員：/dev/shm 上 6 次紅 3 次）。
   */
  const seenEarlier = (f, name) => f.db.prepare('UPDATE file_items SET first_seen_at=? WHERE name=?')
    .run(new Date(Date.now() - 3600_000).toISOString(), name)

  test('剛寫入的 report (1).pdf（稽查員 A 的 exp10）→ 不列、不算徽章；十分鐘後再掃 → 列出、預設勾', t => {
    const f = fixture(t, { 'report.pdf': 'same content' })
    seenEarlier(f, 'report.pdf')
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
    // 平手的話 copy.pdf（'c' < 'r'）會變成保留者、report.pdf 被列出來 —— 這條測的不是那個
    seenEarlier(f, 'report.pdf')
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
    // 同一輪看到的兩份：名字像複本的那份被列出來（見下面「保留者平手」）
    const extra = listed(f).map(c => c.name)
    assert.equal(extra.length, 1, '前提：舊的重複檔列得出來')
    const now = new Date()
    utimesSync(join(f.downloads, extra[0]), now, now)
    f.scan()
    assert.equal(statusOf(f, extra[0]), 'new')
    assert.deepEqual(listed(f).map(c => c.name), [])
  })
})

describe('R2-2 保留者平手（同一輪掃描看到的，first_seen_at 一樣）：名字不像複本的那份留著', () => {
  const dups = f => listCandidates(f.db, { roots: f.opts.roots }).candidates
    .filter(c => c.reasons.some(r => r.kind === 'duplicate'))
  const seenAt = (f, name) => f.db.prepare('SELECT first_seen_at FROM file_items WHERE name=?').get(name).first_seen_at

  test('report.pdf＋report (1).pdf → 列 report (1).pdf，證據說會留著 report.pdf；套用之後 report.pdf 還在', t => {
    const f = fixture(t, { 'report.pdf': 'same content', 'report (1).pdf': 'same content' })
    assert.equal(seenAt(f, 'report.pdf'), seenAt(f, 'report (1).pdf'), '前提：同一輪看到，平手')
    const d = dups(f)
    assert.deepEqual(d.map(c => c.name), ['report (1).pdf'], '原檔被列成重複、複本被留著')
    assert.match(d[0].reasons.find(r => r.kind === 'duplicate').evidence, /會留著「report\.pdf」/)
    assert.equal(applyPlan(f.db, f.plan().id, f.opts).status, 'applied')
    assert.equal(readFileSync(join(f.downloads, 'report.pdf'), 'utf8'), 'same content')
    assert.ok(!existsSync(join(f.downloads, 'report (1).pdf')))
  })

  test('報告.pdf＋報告 - 副本.pdf（Windows 的複製）→ 列副本', t => {
    const f = fixture(t, { '報告.pdf': 'same content', '報告 - 副本.pdf': 'same content' })
    assert.deepEqual(dups(f).map(c => c.name), ['報告 - 副本.pdf'])
  })

  test('對照：兩份都不像複本（a.pdf＋b.pdf）→ 照路徑，列 b.pdf', t => {
    const f = fixture(t, { 'b.pdf': 'same content', 'a.pdf': 'same content' })
    assert.deepEqual(dups(f).map(c => c.name), ['b.pdf'])
  })

  test('對照：兩份都像複本（report (1)＋report (2)）→ 照路徑，列 report (2).pdf', t => {
    const f = fixture(t, { 'report (2).pdf': 'same content', 'report (1).pdf': 'same content' })
    assert.deepEqual(dups(f).map(c => c.name), ['report (2).pdf'])
  })

  test('平手才看名字：report (1).pdf 早一小時被看到、report.pdf 後來才出現 → 留 report (1).pdf，列 report.pdf', t => {
    const f = fixture(t, { 'report (1).pdf': 'same content' })
    f.db.prepare('UPDATE file_items SET first_seen_at=?').run(new Date(Date.now() - 3600_000).toISOString())
    const later = join(f.downloads, 'report.pdf')
    writeFileSync(later, 'same content')
    utimesSync(later, f.old, f.old)
    f.scan()
    const d = dups(f)
    assert.deepEqual(d.map(c => c.name), ['report.pdf'])
    assert.match(d[0].reasons.find(r => r.kind === 'duplicate').evidence, /會留著「report \(1\)\.pdf」/)
  })

  test('looksLikeCopy：瀏覽器、Windows、macOS 的複本字尾算；名字裡剛好有括號或「副本」兩個字的原檔不算', () => {
    const copies = [
      'report (1).pdf', 'report(2).pdf', 'report (12).tar.gz', 'report - Copy.pdf', 'report - Copy (2).pdf',
      'report copy.pdf', 'report copy 2.pdf', '報告 - 副本.docx', '報告 - 複製.docx', '報告 - 副本 (2).docx',
      '報告 的副本.docx', '報告 拷貝.docx', '報告 拷貝 2.docx', 'Copy of report.pdf', 'README (1)',
    ]
    const originals = [
      'report.pdf', 'chapter (1) intro.pdf', '合約副本.pdf', 'copy.pdf', 'photocopy.pdf', '(1).pdf',
      'Budget (2026).xlsx', 'report-1.pdf', 'README', '.bashrc',
    ]
    for (const n of copies) assert.equal(scanner.looksLikeCopy(n), true, n)
    for (const n of originals) assert.equal(scanner.looksLikeCopy(n), false, n)
  })

  test('性質（結構化隨機）：清單上的重複檔＝整組扣掉保留者；證據指名的就是保留者；保留者照「時間、像不像複本、路徑」挑', t => {
    const f = fixture(t, {})
    // mulberry32：固定種子、可重現
    let seed = 20260919
    const rnd = n => {
      seed = (seed + 0x6D2B79F5) | 0
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
      return ((x ^ (x >>> 14)) >>> 0) % n
    }
    const bases = ['report', '報告', 'a', 'b', 'photo']
    const tails = ['', ' (1)', ' (2)', '(3)', ' - Copy', ' - 副本', ' copy', ' copy 2', ' 拷貝', ' (2026)']
    const times = [new Date(Date.now() - 7200_000).toISOString(), new Date(Date.now() - 3600_000).toISOString()]
    const hits = { copyDecided: 0, timeBeatName: 0, pathDecided: 0 }
    const groups = []
    const used = new Set()
    for (let g = 0; g < 80; g++) {
      const sha = 'sha-prop-' + g
      // 同一組用同一個主檔名（真的重複檔多半是這樣：report.pdf、report (1).pdf）
      const base = bases[rnd(bases.length)] + g
      const rows = []
      for (let k = 0, n = 2 + rnd(3); k < n; k++) {
        const dir = rnd(4) === 0 ? join(f.downloads, 'sub') : f.downloads
        const name = base + tails[rnd(tails.length)] + '.pdf'
        const path = join(dir, name)
        if (used.has(path)) continue
        used.add(path)
        rows.push({ id: `p${g}-${k}`, name, path, first_seen_at: times[rnd(times.length)] })
      }
      if (rows.length < 2) continue
      for (const r of rows) {
        f.db.prepare(`INSERT INTO file_items (id,path,name,ext,bytes,sha256,mtime,first_seen_at,last_seen_at,status,error)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(r.id, r.path, r.name, '.pdf', 10, sha, f.old.toISOString(), r.first_seen_at, r.first_seen_at, 'kept', null)
      }
      groups.push(rows)
    }
    scanner.addDuplicateCandidates(f.db, new Date().toISOString(), groups.flat().map(r => r.id), f.opts.roots)
    const listed = new Map(listCandidates(f.db, { roots: f.opts.roots, limit: 1000 }).candidates
      .filter(c => c.reasons.some(r => r.kind === 'duplicate')).map(c => [c.itemId, c]))
    const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0
    const copyOf = r => scanner.looksLikeCopy(r.name) ? 1 : 0
    for (const rows of groups) {
      // 慢速參考：直接照定義排
      const keeper = [...rows].sort((a, b) => cmp(a.first_seen_at, b.first_seen_at) || copyOf(a) - copyOf(b) || cmp(a.path, b.path))[0]
      const byPath = [...rows].sort((a, b) => cmp(a.first_seen_at, b.first_seen_at) || cmp(a.path, b.path))[0]
      const byName = [...rows].sort((a, b) => copyOf(a) - copyOf(b) || cmp(a.first_seen_at, b.first_seen_at) || cmp(a.path, b.path))[0]
      if (keeper !== byPath) hits.copyDecided++
      else hits.pathDecided++
      if (keeper !== byName) hits.timeBeatName++
      assert.ok(!listed.has(keeper.id), `保留者 ${keeper.name} 被列出來了`)
      for (const r of rows.filter(r => r !== keeper)) {
        const c = listed.get(r.id)
        assert.ok(c, `${r.name} 是多出來的，卻沒有列`)
        const ev = c.reasons.find(x => x.kind === 'duplicate').evidence
        assert.ok(ev.includes(`會留著「${keeper.name}」`), `${r.name} 的證據指名的不是保留者 ${keeper.name}：${ev}`)
      }
    }
    // 生成器驗收：三種決定方式都要真的走到
    assert.ok(hits.copyDecided > 5 && hits.timeBeatName > 5 && hits.pathDecided > 5, JSON.stringify(hits))
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

  test('建立時間讀不懂的計畫不動（fail closed，突變 X09）；對照：一小時前的照樣作廢', t => {
    const f = fixture(t, { 'a.zip': 'a', 'b.zip': 'b' })
    const garbled = planWith(f, 'a.zip')
    const stale = planWith(f, 'b.zip')
    f.db.prepare('UPDATE cleanup_plans SET created_at=? WHERE id=?').run('garbage', garbled.id)
    f.db.prepare('UPDATE cleanup_plans SET created_at=? WHERE id=?').run(new Date(Date.now() - 3600_000).toISOString(), stale.id)
    assert.equal(releaseStalePlans(f.db, 0), 1)
    assert.equal(getPlan(f.db, garbled.id).status, 'proposed', '建立時間讀不懂就當成很舊，作廢了')
    assert.equal(getPlan(f.db, stale.id).status, 'dismissed')
    assert.throws(() => releaseStalePlans(f.db, NaN), { code: 'BAD_CONFIG' })
    assert.throws(() => releaseStalePlans(f.db, -1), { code: 'BAD_CONFIG' })
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
    // 鎖被 B 接走：A 停在那一項、照實回報（稽核第三輪 R3-3），不再丟 BUSY
    }, () => {
      const a = applyPlan(f.db, p.id, f.opts)
      assert.ok(a.stoppedEarly, `鎖被接走要回 stoppedEarly：${JSON.stringify(a.stoppedEarly)}`)
    })
    const rows = f.db.prepare(`SELECT status FROM cleanup_journal WHERE plan_id=? AND op='quarantine'`).all(p.id)
    assert.deepEqual(rows.map(r => r.status), ['done', 'done'])
    assert.ok(Object.values(outcomes(f, p.id)).every(o => o.outcome === 'moved' && o.why === null))
    assert.equal(getPlan(f.db, p.id).status, 'applied')
    assert.equal(f.db.prepare('SELECT count(*) n FROM cleanup_item_errors WHERE plan_id=?').get(p.id).n, 0)
    assert.equal(listQuarantine(f.db).length, 2)
  })

  /**
   * A 在 rename 之前卡住超過 30 分鐘、B 接手把整份做完，然後 A 醒來。
   * **單檔計畫**：A 沒有下一次續約可以丟 BUSY，會一路走到寫計畫狀態 —— 面板最常見的就是單檔。
   * 兩檔的版本（上面那條）A 在下一項的續約就停了，看不到 A 怎麼算這一項（第一階段驗證員 T1／T13）。
   */
  function stalledThenTakenOver(t, f, action) {
    const clock = lockClock.now
    let skew = 0
    lockClock.now = () => Date.now() + skew
    t.after(() => { lockClock.now = clock })
    const run = action === 'apply' ? applyPlan : undoPlan
    let hook = () => {
      skew = 31 * 60_000
      assert.equal(run(f.db, f.planId, f.opts).status, action === 'apply' ? 'applied' : 'restored', '前提：B 把整份做完')
    }
    return withFs('renameSync', orig => function (from, to) {
      if (hook) { const h = hook; hook = null; h() }
      return orig.call(this, from, to)
    }, () => run(f.db, f.planId, f.opts))
  }

  test('單檔計畫：A 卡在 rename 之前、B 接手做完 → A 醒來回 applied，不是 error（突變 X01）', t => {
    const f = fixture(t, { 'only.zip': 'aaaa' })
    const p = f.plan()
    const a = stalledThenTakenOver(t, { ...f, planId: p.id }, 'apply')
    assert.equal(a.status, 'applied', `A 把「另一個行程做完了」當成錯：${a.error}`)
    assert.equal(a.quarantinedCount, 1)
    assert.equal(getPlan(f.db, p.id).status, 'applied')
    assert.equal(getPlan(f.db, p.id).error, null)
    assert.equal(row(f, p.id, 'only.zip').status, 'done')
    assert.equal(f.db.prepare('SELECT count(*) n FROM cleanup_item_errors WHERE plan_id=?').get(p.id).n, 0)
    assert.equal(readFileSync(row(f, p.id, 'only.zip').to_path, 'utf8'), 'aaaa')
  })

  test('單檔計畫的復原：A 卡在 rename 之前、B 接手放回 → A 醒來回 restored，不是 error（突變 X12）', t => {
    const f = fixture(t, { 'only.zip': 'aaaa' })
    const p = f.plan()
    assert.equal(applyPlan(f.db, p.id, f.opts).status, 'applied')
    const a = stalledThenTakenOver(t, { ...f, planId: p.id }, 'undo')
    assert.equal(a.status, 'restored', `A 把「另一個行程放回去了」當成錯：${a.error}`)
    assert.equal(getPlan(f.db, p.id).status, 'restored')
    assert.equal(row(f, p.id, 'only.zip', 'restore').status, 'done')
    assert.equal(readFileSync(join(f.downloads, 'only.zip'), 'utf8'), 'aaaa')
  })

  test('清空：第 0 項出錯、第 1 項刪掉之後鎖被接走 → 重送從第 2 項接著做，第 0 項的錯只報一次（突變 X08）', t => {
    const f = fixture(t, { 'a.zip': 'aaaa', 'b.zip': 'bbbb', 'c.zip': 'cccc' })
    const p = f.plan()
    assert.equal(applyPlan(f.db, p.id, f.opts).status, 'applied')
    f.db.prepare('UPDATE cleanup_move_details SET completed_at=?').run(new Date(Date.now() - 8 * 86400_000).toISOString())
    const prep = prepareEmptyQuarantine(f.db, f.opts)
    const seqs = JSON.parse(f.db.prepare('SELECT entries FROM cleanup_empty_requests WHERE token=?').get(prep.token).entries)
    assert.equal(seqs.length, 3)
    const first = f.db.prepare('SELECT to_path FROM cleanup_journal WHERE seq=?').get(seqs[0]).to_path
    chmodSync(first, 0o600)
    // 第 0 項換成**真的錯**（硬鏈結替換是攻擊）。「內容被改過」在第三輪改成「放到一邊」、不算錯，
    // 那條路另外由 audit-0919-r3exec 的「內容對不上不算錯」守。
    const other = join(f.dir, 'elsewhere.bin')
    writeFileSync(other, 'x')
    rmSync(first)
    linkSync(other, first)
    const steal = i => {
      if (i === 1) f.db.prepare(`UPDATE cleanup_operation_lock SET owner='2099-01-01T00:00:00.000Z thief'`).run()
    }
    const stop = emptyQuarantine(f.db, { ...f.opts, token: prep.token, confirmed: true, onProgress: steal })
    assert.ok(stop.stoppedEarly, `鎖被接走要回 stoppedEarly：${JSON.stringify(stop)}`)
    assert.equal(stop.deletedCount, 1, '已經刪掉的要算進回傳（R3-3）')
    f.db.exec('DELETE FROM cleanup_operation_lock')
    assert.equal(f.db.prepare(`SELECT count(*) n FROM cleanup_purges WHERE status='done'`).get().n, 1, '前提：刪了第 1 項')
    const r = emptyQuarantine(f.db, { ...f.opts, token: prep.token, confirmed: true })
    assert.equal(r.deletedCount, 2)
    assert.equal(r.deletedBytes, 8)
    assert.deepEqual(r.errors.map(e => e.seq), [seqs[0]], `同一個錯報了不只一次：${JSON.stringify(r.errors)}`)
    assert.ok(existsSync(first), '出錯的那一個沒有被刪')
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
    const stop = emptyQuarantine(f.db, { ...f.opts, token: prep.token, confirmed: true })
    assert.ok(stop.stoppedEarly, `鎖被接走要回 stoppedEarly：${JSON.stringify(stop)}`)
    assert.equal(stop.deletedCount, 1)
    f.db.exec('DROP TRIGGER steal')
    f.db.exec('DELETE FROM cleanup_operation_lock')
    assert.equal(f.db.prepare(`SELECT count(*) n FROM cleanup_purges WHERE status='done'`).get().n, 1, '前提：刪了 1 個')
    const r = emptyQuarantine(f.db, { ...f.opts, token: prep.token, confirmed: true })
    assert.deepEqual({ count: r.deletedCount, bytes: r.deletedBytes, errors: r.errors }, { count: 3, bytes: 12, errors: [] })
    // 形狀只多 noop（稽核第三輪 R3-2）；stoppedEarly 只在真的停在半路時才有
    // setAside 是第三輪加的：不刪、也不算錯的那些（內容跟當初不一樣、或已經不在隔離區）
    assert.deepEqual(Object.keys(r).sort(), ['deletedBytes', 'deletedCount', 'errors', 'noop', 'setAside'], '回應形狀不對')
    assert.equal(r.noop, false)
    const again = emptyQuarantine(f.db, { ...f.opts, token: prep.token, confirmed: true })
    assert.deepEqual(again, { ...r, noop: true }, '之後重送拿到同一份結果，只多一句「這次什麼都沒做」')
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

  test('release A、用同一個檔建 B（還沒套用）、再 dismiss A → 409 CONFLICT，候選與 release 標記都不動，B 照常套用（驗證員 T9）', t => {
    const f = fixture(t, { 'a.zip': 'a', 'b.zip': 'b' })
    const A = f.plan()
    assert.equal(A.items.length, 2, '前提：A 有 a、b')
    releasePlan(f.db, A.id)
    const B = planWith(f, 'a.zip')
    const statuses = () => f.db.prepare(`SELECT i.name, c.status FROM cleanup_candidates c JOIN file_items i ON i.id=c.item_id
      ORDER BY i.name, c.kind`).all().map(r => `${r.name}:${r.status}`)
    const before = statuses()
    assert.throws(() => dismissPlan(f.db, A.id), { code: 'CONFLICT' })
    assert.deepEqual(statuses(), before, '撞到還活著的計畫，候選一個都不可以動')
    assert.deepEqual(releases(f), [A.id], 'release 標記還在')
    assert.equal(getPlan(f.db, B.id).status, 'proposed')
    assert.deepEqual(listedNames(f).sort(), ['a.zip', 'b.zip'], '清單跟 B 一致：a 還是候選')
    assert.equal(applyPlan(f.db, B.id, f.opts).status, 'applied')

    // 對照：B 套用過（不再佔住檔案）之後，dismiss A 照常：b 作廢；a 已經在隔離區，不動
    assert.equal(dismissPlan(f.db, A.id).status, 'dismissed')
    assert.deepEqual(releases(f), [])
    const after = Object.fromEntries(f.db.prepare(`SELECT i.name, c.status FROM cleanup_candidates c JOIN file_items i ON i.id=c.item_id`)
      .all().map(r => [r.name, r.status]))
    assert.deepEqual(after, { 'a.zip': 'quarantined', 'b.zip': 'dismissed' })
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
