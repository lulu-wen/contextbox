import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * 2026-09-19 稽核第二波（core）：第一波驗證者找到的核心問題，一條預期行為一個釘子。
 *
 * **期望值在修之前就寫死**（先紅，再修到綠）。覺得期望值錯了就寫進回報，不要動它。
 * 稽核紀錄沒寫死、由修法推出來的，測試名稱標「（推論）」。
 *
 * ── Step 1：容易錯的地方（build-round）────────────────────────────
 *
 * | 項目 | 可能的錯 | 另一種解讀 | 分辨用的成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | a 保險絲 | 沿用 ≥50% | 使用者一次刪一大半＝碟沒掛上 | 同一顆碟 20 刪 12／st_dev 變了刪 1 | 12 個都標／一個都不標 |
 * | a 保險絲 | 「根目錄空」只看已知的檔 | 有別的新檔也算空 | 10 個全刪、根目錄空／10 個全刪、多一個新檔 | 不標／10 個照標 |
 * | a 保險絲 | 跳過一次之後永遠跳 | 新的裝置編號不記 | st_dev 變了掃一次、再掃一次 | 第一次不標、第二次照標（推論） |
 * | b 續約 | 只在拿鎖時寫時間 | 30 分鐘內一定做完 | 每項 11 分鐘、5 項 | 別的行程每一次都拿到 BUSY |
 * | b 續約 | 被接走了還繼續做 | 照做不誤 | 做到一半鎖被別人接走 | 停下來回 BUSY，不刪別人的鎖 |
 * | c 舊格式 | 舊格式只看 pid | fail closed | 舊格式＋活 pid／新格式 1 分鐘前＋活 pid | 拿得到／BUSY |
 * | d 遷移 | 使用者 dismiss 的也放回來 | 全部 dismissed 都改 | 舊版作廢的／使用者 dismiss 的 | 回到清單／還是不在 |
 * | d 遷移 | 每次掃描都跑 | 沒有旗標 | 旗標設了之後再出現的 dismissed | 不動 |
 * | e 保留者 | 保留者用 originalPath 驗 | 受保護檔不能當保留者 | notes.txt＋desktop.ini 同內容／desktop.ini 後來被改 | 搬得動／不搬 |
 * | f 復原中斷 | 從 ?undoable=1 消失、七天後被清空 | unknown 就不算可復原 | 一份復原中斷＋一份正常隔離 | 前者可復原、不清空；後者照常清空 |
 * | g pending | partial／error 也算 | 還有沒做完的項目 | partial 計畫＋proposed 計畫 | 只列 proposed |
 * | h 受保護檔名 | 只靠重掃擋 | 清單信任資料庫 | 資料庫裡留著 desktop.ini 的 proposed 候選 | 不列、不算、建不了計畫 |
 * | i 清理根目錄 | 只擋家目錄本身 | 上一層也算合法 | /home、C:\Users（大小寫不同）／alice-backup、Downloads\sub | 拒絕／照收 |
 * | j /health | 免 token 也給時間 | 時間不算隱私 | 帶 token／不帶 | 有時間／null |
 * | j relatedness | 每次 /health 跑規則 | 讀取時再分類 | 沒候選的舊大 zip（kept＋error）／同一列有 proposed 候選 | 不列／列 |
 * | k 空 token | '' === '' 通過 | 空檔也是一把鑰匙 | token 檔是空的／有內容 | 重新產生（0600）／原樣 |
 * | l problems | 帶完整路徑 | 原文照給 | 根目錄不存在／子資料夾打不開 | 有人話、不帶路徑 |
 * | m 失敗原因 | 只有 route 記 | CLI 自己補 | 直接呼叫 applyPlan 再重掃／重試成功 | why 還在／記錄刪掉 |
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync,
  statSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { randomUUID } from 'node:crypto'
import { open } from '../core/db.ts'
import * as scanner from '../core/cleanup-scanner.ts'
import * as exec from '../core/cleanup-exec.ts'
import * as journal from '../core/cleanup-journal.ts'
import * as plans from '../core/cleanup-plans.ts'
import * as quarantine from '../core/cleanup-quarantine.ts'
import * as routes from '../core/cleanup-routes.ts'
import * as server from '../core/server.ts'
import * as config from '../core/config.ts'
import { CLEANUP_RULE_VERSION } from '../core/cleanup-rules.ts'
import { fixture } from './helpers/cleanup.mjs'

const DAY = 86400_000
const noPerm = process.platform === 'win32' || process.getuid?.() === 0

function sandbox(t, rootName = 'Downloads') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-core2-')))
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
  const list = () => routes.listCandidates(db, { roots: [dl] })
  const names = () => list().candidates.map(c => c.name).sort()
  const missing = () => db.prepare(`SELECT count(*) n FROM file_items WHERE status='missing'`).get().n
  const lock = p => { chmodSync(p, 0o000); locked.push(p) }
  return { dir, dl, db, opts, problems, put, scan, list, names, missing, lock }
}

const setMeta = (db, k, v) =>
  db.prepare(`INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(k, v)

// ═══ a ・ 保險絲改用裝置編號 ═══════════════════════════════════

describe('a 大量消失的保險絲：用裝置編號與「根目錄是空的」判斷，不再用 ≥50%', () => {
  test('同一個裝置、20 個檔、使用者刪掉 12 個 → 12 個都標 missing', t => {
    const s = sandbox(t)
    for (let i = 0; i < 20; i++) s.put(`f${String(i).padStart(2, '0')}.zip`)
    s.scan()
    assert.equal(s.names().length, 20)
    for (let i = 0; i < 12; i++) unlinkSync(join(s.dl, `f${String(i).padStart(2, '0')}.zip`))
    s.problems.length = 0
    s.scan()
    assert.equal(s.missing(), 12)
    assert.equal(s.names().length, 8)
    assert.ok(!s.problems.some(m => /整個不見了|同一顆碟/.test(m)), JSON.stringify(s.problems))
  })

  test('根目錄的 st_dev 跟上次不同 → 一個都不標、記 problem；（推論）新的裝置編號記下來，下一次照常標', t => {
    const s = sandbox(t)
    for (let i = 0; i < 12; i++) s.put(`f${String(i).padStart(2, '0')}.zip`)
    s.scan()
    const key = scanner.rootDevKey(realpathSync(s.dl))
    const recorded = s.db.prepare('SELECT v FROM meta WHERE k=?').get(key)?.v
    assert.equal(recorded, String(statSync(s.dl).dev), '成功掃描要記下根目錄的 st_dev')

    setMeta(s.db, key, String(Number(recorded) + 12345))   // 模擬上次是另一顆碟
    unlinkSync(join(s.dl, 'f03.zip'))
    s.problems.length = 0
    s.scan()
    assert.equal(s.missing(), 0, '換了碟（或沒掛上）的時候一個都不可以標')
    const hit = s.problems.find(m => /同一顆碟/.test(m))
    assert.ok(hit, JSON.stringify(s.problems))
    assert.ok(hit.includes('Downloads') && !hit.includes(s.dir), `problem 要有資料夾名稱、不帶完整路徑：${hit}`)

    s.scan()
    assert.equal(s.missing(), 1, '新的裝置編號記下來之後，真的刪掉的要照標')
  })

  test('根目錄清空、10 個已知全部不見 → 不標、記 problem', t => {
    const s = sandbox(t)
    for (let i = 0; i < 10; i++) s.put(`f${i}.zip`)
    s.scan()
    for (let i = 0; i < 10; i++) unlinkSync(join(s.dl, `f${i}.zip`))
    s.problems.length = 0
    s.scan()
    assert.equal(s.missing(), 0)
    const hit = s.problems.find(m => m.includes('看起來整個不見了'))
    assert.ok(hit, JSON.stringify(s.problems))
    assert.ok(!hit.includes(s.dir), hit)
  })

  test('10 個已知全部不見、但根目錄裡還有一個新檔 → 不是空的，10 個照標', t => {
    const s = sandbox(t)
    for (let i = 0; i < 10; i++) s.put(`f${i}.zip`)
    s.scan()
    for (let i = 0; i < 10; i++) unlinkSync(join(s.dl, `f${i}.zip`))
    writeFileSync(join(s.dl, '剛下載的.txt'), 'new')
    s.scan()
    assert.equal(s.missing(), 10)
    assert.deepEqual(s.names(), [])
  })

  // 上一條的新檔會變成「已知的活檔」，分不出「根目錄是空的」這個條件（突變測試抓到的洞）。
  // 這一條根目錄裡只剩一個空的子資料夾：已知的 10 個全部不見，但根目錄不是空的。
  test('10 個已知全部不見、根目錄只剩一個空的子資料夾 → 不是空的，10 個照標', t => {
    const s = sandbox(t)
    for (let i = 0; i < 10; i++) s.put(`f${i}.zip`)
    s.scan()
    for (let i = 0; i < 10; i++) unlinkSync(join(s.dl, `f${i}.zip`))
    mkdirSync(join(s.dl, '整理好的'))
    s.problems.length = 0
    s.scan()
    assert.equal(s.missing(), 10)
    assert.ok(!s.problems.some(m => m.includes('看起來整個不見了')), JSON.stringify(s.problems))
  })
})

// ═══ b ・ 長時間操作要續約鎖 ════════════════════════════════════

describe('b 長時間操作每處理一項就續約鎖', () => {
  /** 假時鐘：每處理一項過 11 分鐘。另一條連線（＝另一個行程，pid 一樣活著）每一項都試著拿鎖。 */
  function longRun(t, f) {
    const other = open(f.dbPath)
    t.after(() => other.close())
    let fake = Date.now()
    const real = journal.lockClock.now
    journal.lockClock.now = () => fake
    t.after(() => { journal.lockClock.now = real })
    const seen = []
    const onProgress = () => {
      fake += 11 * 60_000
      try { seen.push(journal.withCleanupLock(other, () => 'stolen')) }
      catch (e) { seen.push(e.code) }
    }
    return { other, seen, onProgress }
  }

  test('apply 跑超過 30 分鐘（5 項、每項 11 分鐘）：鎖不會被別的行程接走', t => {
    const f = fixture(t, { 'a.zip': 'a', 'b.zip': 'b', 'c.zip': 'c', 'd.zip': 'd', 'e.zip': 'e' })
    const p = plans.createPlan(f.db)
    const run = longRun(t, f)
    const r = exec.applyPlan(f.db, p.id, { ...f.opts, onProgress: run.onProgress })
    assert.equal(r.status, 'applied')
    assert.deepEqual(run.seen, ['BUSY', 'BUSY', 'BUSY', 'BUSY', 'BUSY'])
    assert.equal(f.db.prepare('SELECT count(*) n FROM cleanup_operation_lock').get().n, 0, '做完要放掉')
  })

  test('undo 也一樣', t => {
    const f = fixture(t, { 'a.zip': 'a', 'b.zip': 'b', 'c.zip': 'c', 'd.zip': 'd' })
    const p = plans.createPlan(f.db)
    exec.applyPlan(f.db, p.id, f.opts)
    const run = longRun(t, f)
    const r = exec.undoPlan(f.db, p.id, { ...f.opts, onProgress: run.onProgress })
    assert.equal(r.status, 'restored')
    assert.deepEqual(run.seen, ['BUSY', 'BUSY', 'BUSY', 'BUSY'])
  })

  test('清空隔離區也一樣', t => {
    const f = fixture(t, { 'a.zip': 'a', 'b.zip': 'b', 'c.zip': 'c', 'd.zip': 'd' })
    const p = plans.createPlan(f.db)
    exec.applyPlan(f.db, p.id, f.opts)
    f.db.prepare('UPDATE cleanup_move_details SET completed_at=?').run(new Date(Date.now() - 8 * DAY).toISOString())
    const { token } = quarantine.prepareEmptyQuarantine(f.db, f.opts)
    const run = longRun(t, f)
    const r = quarantine.emptyQuarantine(f.db, { ...f.opts, token, confirmed: true, onProgress: run.onProgress })
    assert.equal(r.deletedCount, 4)
    assert.deepEqual(run.seen, ['BUSY', 'BUSY', 'BUSY', 'BUSY'])
  })

  test('（推論）做到一半鎖被別人接走了 → 下一項續約時停下來回 stoppedEarly，不刪別人的鎖；之後重跑接得完', t => {
    const f = fixture(t, { 'a.zip': 'a', 'b.zip': 'b', 'c.zip': 'c', 'd.zip': 'd' })
    const p = plans.createPlan(f.db)
    const other = open(f.dbPath)
    t.after(() => other.close())
    const thief = `${new Date().toISOString()} ${randomUUID()}`
    let n = 0
    // 稽核第三輪 R3-3：不再丟 BUSY —— 停在那一項、把已經做完的收好、回傳帶 stoppedEarly，
    // 呼叫端才報得出「已經搬了幾個」與計畫 id（以前 CLI 回 2「動作沒執行」，其實已經搬了幾個）
    const r = exec.applyPlan(f.db, p.id, { ...f.opts, onProgress: () => {
      // 第二項開始前：別的行程認定這把鎖是殘留，接手了
      if (++n === 2) other.prepare('INSERT OR REPLACE INTO cleanup_operation_lock VALUES (1,?,?)').run(process.pid, thief)
    } })
    assert.ok(r.stoppedEarly, `要回 stoppedEarly：${JSON.stringify(r.stoppedEarly)}`)
    assert.match(r.stoppedEarly.why, /清理鎖/)
    assert.equal(f.db.prepare('SELECT status FROM cleanup_plans WHERE id=?').get(p.id).status, 'proposed',
      '停在半路不可以寫計畫狀態，不然接不下去')
    assert.equal(f.db.prepare('SELECT owner FROM cleanup_operation_lock').get()?.owner, thief, '不可以刪掉別人的鎖')
    assert.ok(['a.zip', 'b.zip', 'c.zip', 'd.zip'].some(x => existsSync(join(f.downloads, x))), '停下來之後不可以再搬')

    other.prepare('DELETE FROM cleanup_operation_lock').run()
    assert.equal(exec.applyPlan(f.db, p.id, f.opts).status, 'applied')
    for (const x of ['a.zip', 'b.zip', 'c.zip', 'd.zip']) assert.ok(!existsSync(join(f.downloads, x)), x)
  })
})

// ═══ c ・ 沒有時間戳的舊格式鎖 ═════════════════════════════════

describe('c 沒有時間戳的舊格式鎖一律視為殘留', () => {
  function lockDb(t) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-core2-lock-')))
    const db = open(join(dir, 'data.db'))
    t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
    journal.initCleanup(db)
    const hold = owner => db.prepare('INSERT OR REPLACE INTO cleanup_operation_lock VALUES (1,?,?)').run(process.pid, owner)
    return { db, hold }
  }

  test('舊格式（只有 uuid）＋活著的 pid → 拿得到', t => {
    const { db, hold } = lockDb(t)
    hold('11111111-1111-4111-8111-111111111111')
    assert.equal(journal.withCleanupLock(db, () => 'ran'), 'ran')
  })

  test('看不懂的 owner（someone-else）＋活著的 pid → 拿得到', t => {
    const { db, hold } = lockDb(t)
    hold('someone-else')
    assert.equal(journal.withCleanupLock(db, () => 'ran'), 'ran')
  })

  test('新格式、1 分鐘前拿的＋活著的 pid → 還是 BUSY（邊界的另一側）', t => {
    const { db, hold } = lockDb(t)
    hold(`${new Date(Date.now() - 60_000).toISOString()} someone-else`)
    assert.throws(() => journal.withCleanupLock(db, () => 'ran'), { code: 'BUSY' })
  })
})

// ═══ d ・ 舊資料修復 ═══════════════════════════════════════════

describe('d 一次性遷移：舊版掃描器錯誤作廢的候選改成 skipped', () => {
  /** 舊版資料庫沒有遷移旗標。 */
  const asLegacy = db => db.prepare('DELETE FROM meta WHERE k=?').run(scanner.LEGACY_DISMISSED_REPAIR_KEY)

  test('舊版作廢的重複檔與 archive 候選：升級後掃一次就回到清單；使用者 dismiss 的還是不在', t => {
    const s = sandbox(t)
    s.put('report.pdf', 'same content', 20)
    s.put('report (1).pdf', 'same content', 20)
    s.put('a.zip', 'zip a', 60)
    s.put('rejected.zip', 'zip r', 60)
    s.scan()
    assert.equal(s.names().length, 3)

    // 使用者真的拒絕過 rejected.zip（經過 dismissPlan）
    const rid = s.list().candidates.find(c => c.name === 'rejected.zip').candidateIds
    plans.dismissPlan(s.db, plans.createPlan(s.db, { candidateIds: rid }).id)
    // 舊版掃描器：第二次掃描把重複檔候選作廢、讀不到一次就把 a.zip 作廢
    s.db.prepare(`UPDATE cleanup_candidates SET status='dismissed'
                  WHERE kind='duplicate' OR item_id=(SELECT id FROM file_items WHERE name='a.zip')`).run()
    asLegacy(s.db)
    assert.deepEqual(s.names(), [])

    s.scan()
    const after = s.names()
    assert.ok(after.includes('a.zip'), JSON.stringify(after))
    assert.equal(after.filter(n => n.startsWith('report')).length, 1, '重複檔候選要回來')
    assert.ok(!after.includes('rejected.zip'), '使用者 dismiss 過的不可以放回來')
    assert.ok(s.db.prepare('SELECT v FROM meta WHERE k=?').get(scanner.LEGACY_DISMISSED_REPAIR_KEY), '要記下已經跑過')
  })

  test('只跑一次：旗標設了之後，dismissed 候選不再被動', t => {
    const s = sandbox(t)
    s.put('a.zip', 'zip a', 60)
    s.scan()
    s.db.prepare(`UPDATE cleanup_candidates SET status='dismissed'`).run()
    s.scan()
    assert.deepEqual(s.names(), [])
  })
})

// ═══ e ・ 保留者可以是受保護的檔 ═══════════════════════════════

describe('e 重複檔的保留者可以是受保護的檔（保留者不會被搬）', () => {
  function pair(t) {
    const s = sandbox(t)
    const notes = s.put('notes.txt', 'same bytes', 20)
    const ini = s.put('desktop.ini', 'same bytes', 20)
    s.scan()
    const c = s.list().candidates
    assert.deepEqual(c.map(x => x.name), ['notes.txt'], '前提：被提議的是 notes.txt，desktop.ini 是保留者')
    assert.equal(c[0].kind, 'duplicate')
    const p = routes.createPlanForRoots(s.db, [s.dl], { candidateIds: c[0].candidateIds })
    return { ...s, notes, ini, p }
  }

  test('notes.txt 與內容相同的 desktop.ini：notes.txt 搬得動，desktop.ini 留著', t => {
    const s = pair(t)
    const r = exec.applyPlan(s.db, s.p.id, s.opts)
    assert.equal(r.status, 'applied', JSON.stringify(routes.planOutcomes(s.db, s.p.id).values().next().value))
    assert.ok(!existsSync(s.notes))
    assert.ok(existsSync(s.ini))
  })

  test('desktop.ini 在建計畫之後被改掉 → 已經不是同一份，notes.txt 不搬', t => {
    const s = pair(t)
    writeFileSync(s.ini, 'different now')
    const at = new Date(Date.now() - 20 * DAY)
    utimesSync(s.ini, at, at)
    assert.equal(exec.applyPlan(s.db, s.p.id, s.opts).status, 'error')
    assert.ok(existsSync(s.notes), '唯一的一份不可以被搬走')
  })
})

// 第一波驗證者的同一個根因（RC4-1 沒修完）：保留者在舊設定的桌面上（不在目前的清理根目錄底下），
// 執行層回 OUTSIDE_ROOT，一樣是「列得出、永遠搬不動」。而且根目錄外的列從來不會被對帳，
// 檔案早就刪了也還是「活的」。所以掃描器挑保留者只看目前清理根目錄底下的檔（跟執行層同一個條件）。
describe('（推論）e2 重複檔的保留者要在目前的清理根目錄底下', () => {
  function withDesktopCopy(t) {
    const s = sandbox(t)
    const desk = join(s.dir, 'Desktop')
    mkdirSync(desk)
    const dz = join(desk, 'report.pdf')
    writeFileSync(dz, 'same bytes')
    const at = new Date(Date.now() - 20 * DAY)
    utimesSync(dz, at, at)
    // 舊設定：清理沿用截圖的 watch，桌面先被掃到（first_seen_at 最早）
    scanner.scanDownloads({ db: s.db, roots: [desk], maxBytes: s.opts.maxBytes, now: new Date(Date.now() - DAY) })
    return { ...s, desk, dz }
  }

  test('只有桌面上還有一份：Downloads 那份不列成重複檔', t => {
    const s = withDesktopCopy(t)
    s.put('report.pdf', 'same bytes', 20)
    s.scan()
    assert.deepEqual(s.names(), [])
  })

  test('Downloads 裡另外還有一份：列出多出來的那份、證據指名 Downloads 裡的保留者，而且搬得動', t => {
    const s = withDesktopCopy(t)
    const a = s.put('a.pdf', 'same bytes', 20)
    const b = s.put('b.pdf', 'same bytes', 20)
    s.scan()
    const c = s.list().candidates
    assert.deepEqual(c.map(x => x.name), ['b.pdf'])
    assert.match(c[0].reasons[0].evidence, /會留著「a\.pdf」/)
    const p = routes.createPlanForRoots(s.db, [s.dl], { candidateIds: c[0].candidateIds })
    assert.equal(exec.applyPlan(s.db, p.id, s.opts).status, 'applied')
    assert.ok(existsSync(a) && !existsSync(b) && existsSync(s.dz))
  })
})

// ═══ f ・ 復原到一半中斷 ═══════════════════════════════════════

describe('f 復原到一半中斷：還可以再按一次復原，清空隔離區不可以刪掉它', () => {
  /**
   * a.zip 在計畫 A、b.zip 在計畫 B，兩份都套用了、隔離滿八天。
   * A 按了復原，journal 寫了 restore started，rename 之前當機。
   * previewFirst：當機之前就先拿到一張清空確認碼（那時候 a 還是合格的）。
   */
  function interrupted(t, { previewFirst = false } = {}) {
    const f = fixture(t, { 'a.zip': 'aaa', 'b.zip': 'bbb' })
    const list = routes.listCandidates(f.db, { roots: f.opts.roots })
    const ids = n => list.candidates.find(c => c.name === n).candidateIds
    const A = plans.createPlan(f.db, { candidateIds: ids('a.zip') })
    const B = plans.createPlan(f.db, { candidateIds: ids('b.zip') })
    exec.applyPlan(f.db, A.id, f.opts)
    exec.applyPlan(f.db, B.id, f.opts)
    f.db.prepare('UPDATE cleanup_move_details SET completed_at=?').run(new Date(Date.now() - 8 * DAY).toISOString())
    const token = previewFirst ? quarantine.prepareEmptyQuarantine(f.db, f.opts).token : null

    exec.undoPlan(f.db, A.id, f.opts)
    const r = f.db.prepare(`SELECT * FROM cleanup_journal WHERE plan_id=? AND op='restore'`).get(A.id)
    renameSync(r.to_path, r.from_path)                  // 倒回 rename 之前
    f.db.prepare(`UPDATE cleanup_journal SET status='started' WHERE seq=?`).run(r.seq)
    f.db.prepare(`UPDATE cleanup_move_details SET completed_at=NULL, reservation=NULL WHERE seq=?`).run(r.seq)
    f.db.prepare(`UPDATE file_items SET status='quarantined' WHERE id=?`).run(r.item_id)
    f.db.prepare(`UPDATE cleanup_candidates SET status='quarantined' WHERE item_id=?`).run(r.item_id)
    f.db.prepare(`UPDATE cleanup_plans SET status='applied' WHERE id=?`).run(A.id)
    assert.ok(existsSync(r.from_path), '前提：檔案還在隔離區')
    return { ...f, A, B, token, inQuarantine: r.from_path, original: join(f.downloads, 'a.zip') }
  }

  test('那份計畫還在 ?undoable=1 裡、canUndo 為 true', t => {
    const f = interrupted(t)
    const u = routes.listPlans(f.db, { filter: 'undoable' })
    const a = u.operations.find(o => o.id === f.A.id)
    assert.ok(a, `復原中斷的計畫從 ?undoable=1 消失了：${JSON.stringify(u.operations.map(o => o.id))}`)
    assert.equal(a.canUndo, true)
    assert.deepEqual(a.items.map(i => i.name), ['a.zip'])
    assert.equal(u.total, 2, 'B 也還在')
    const all = routes.listPlans(f.db, {}).operations.find(o => o.id === f.A.id)
    assert.equal(all.canUndo, true, '不篩的列表也要說可以復原')
  })

  test('清空預覽不算它；正常隔離的那份照算', t => {
    const f = interrupted(t)
    const pre = quarantine.prepareEmptyQuarantine(f.db, f.opts)
    assert.equal(pre.itemCount, 1)
    assert.equal(pre.bytes, 3)
    const r = quarantine.emptyQuarantine(f.db, { ...f.opts, token: pre.token, confirmed: true })
    assert.equal(r.deletedCount, 1)
    assert.ok(existsSync(f.inQuarantine), '復原到一半的檔不可以被刪')
  })

  test('當機之前拿到的確認碼：清空時也不刪它', t => {
    const f = interrupted(t, { previewFirst: true })
    const r = quarantine.emptyQuarantine(f.db, { ...f.opts, token: f.token, confirmed: true })
    assert.equal(r.deletedCount, 1, 'b.zip 照刪')
    assert.ok(existsSync(f.inQuarantine), '復原到一半的檔不可以被刪')
  })

  test('再按一次復原會把它接完', t => {
    const f = interrupted(t)
    const r = exec.undoPlan(f.db, f.A.id, f.opts)
    assert.equal(r.status, 'restored')
    assert.equal(readFileSync(f.original, 'utf8'), 'aaa')
    assert.equal(routes.listPlans(f.db, { filter: 'undoable' }).operations.some(o => o.id === f.A.id), false)
  })

  test('（推論）/health 的「現在可以清空」不算它', t => {
    const f = interrupted(t)
    exec.undoPlan(f.db, f.B.id, f.opts)                 // 只剩復原中斷的那一個
    const h = routes.healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine })
    assert.equal(h.quarantine.items, 1, '它還在隔離區裡，照數')
    assert.equal(h.quarantine.canEmptyNow, false, '按下去什麼都不會刪，不可以說可以清空')
    const q = routes.quarantineItems(f.db)
    assert.equal(q.length, 1)
    assert.equal(q[0].canEmptyNow, false)
  })
})

// ═══ g ・ pending 與 blockingPlanFor 只算 proposed ═══════════════

describe('g ?pending=1 與 blockingPlanFor 只算 proposed', () => {
  function mixed(t) {
    const f = fixture(t, { 'a.zip': 'a', 'b.zip': 'b', 'c.zip': 'c' })
    const list = routes.listCandidates(f.db, { roots: f.opts.roots })
    const ids = n => list.candidates.find(c => c.name === n).candidateIds
    const P1 = plans.createPlan(f.db, { candidateIds: [...ids('a.zip'), ...ids('b.zip')] })
    // a 在建計畫之後被改過 → CHANGED；P1 變 partial
    writeFileSync(join(f.downloads, 'a.zip'), 'a changed')
    utimesSync(join(f.downloads, 'a.zip'), f.old, f.old)
    assert.equal(exec.applyPlan(f.db, P1.id, f.opts).status, 'partial')
    const P2 = plans.createPlan(f.db, { candidateIds: ids('c.zip') })
    return { ...f, ids, P1, P2 }
  }

  test('partial 計畫不在 ?pending=1；proposed 的在', t => {
    const f = mixed(t)
    const r = routes.listPlans(f.db, { filter: 'pending' })
    assert.deepEqual(r.operations.map(o => o.id), [f.P2.id])
    assert.equal(r.total, 1)
  })

  test('blockingPlanFor 不回 partial 計畫；有 proposed 的才回那一份', t => {
    const f = mixed(t)
    assert.equal(routes.blockingPlanFor(f.db, f.ids('a.zip')), null, 'a 只在 partial 計畫裡，那份不佔住檔案')
    f.scan()
    const P3 = plans.createPlan(f.db, { candidateIds: f.ids('a.zip') })
    assert.equal(routes.blockingPlanFor(f.db, f.ids('a.zip'))?.id, P3.id)
  })
})

// ═══ h ・ 清單再用 execRefusesName 擋一次 ═══════════════════════

describe('h 升級前留下的受保護檔名候選不可以列出來', () => {
  test('desktop.ini 的 proposed 候選：清單不列、徽章不算、指名建不了計畫、預設清理不收', t => {
    const f = fixture(t, { 'a.zip': 'a' })
    const ini = join(f.downloads, 'desktop.ini')
    writeFileSync(ini, 'x')
    utimesSync(ini, f.old, f.old)
    const id = randomUUID(), cid = randomUUID(), now = new Date().toISOString()
    f.db.prepare(`INSERT INTO file_items (id,path,name,ext,bytes,sha256,mtime,first_seen_at,last_seen_at,status)
                  VALUES (?,?,?,?,?,?,?,?,?,'candidate')`).run(id, ini, 'desktop.ini', '.ini', 1, 'sha-ini', f.old.toISOString(), now, now)
    f.db.prepare(`INSERT INTO cleanup_candidates (id,item_id,kind,rule_version,confidence,reason,evidence,status,created_at)
                  VALUES (?,?,'old-download',?,65,'舊','舊','proposed',?)`).run(cid, id, CLEANUP_RULE_VERSION, now)

    const list = routes.listCandidates(f.db, { roots: f.opts.roots })
    assert.deepEqual(list.candidates.map(c => c.name), ['a.zip'])
    assert.equal(list.defaultCheckedCount, 1)
    assert.equal(routes.healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine }).pendingCandidates, 1)
    assert.throws(() => routes.createPlanForRoots(f.db, f.opts.roots, { candidateIds: [cid] }), { code: 'STALE_CANDIDATE' })
    assert.ok(!routes.defaultSelection(f.db, f.opts.roots).candidateIds.includes(cid))
  })
})

// ═══ i ・ cleanup.roots 驗證 ═══════════════════════════════════

describe('i cleanup.roots 不可以是根目錄、家目錄、家目錄的上一層', () => {
  test('POSIX：/、家目錄、家目錄的每一層上層都拒絕並出聲，退回 Downloads；旁邊的資料夾與子資料夾照收', t => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'cb-core2-home-')))
    t.after(() => rmSync(base, { recursive: true, force: true }))
    const home = join(base, 'users', 'alice')
    mkdirSync(join(home, 'Downloads', 'sub'), { recursive: true })
    const sys = { home }
    for (const bad of ['/', home, join(base, 'users'), base, join(base, 'users') + '/']) {
      const r = config.normalize({ cleanup: { roots: [bad] } }, sys)
      assert.deepEqual(r.config.cleanup.roots, [join(home, 'Downloads')], bad)
      assert.ok(r.problems.some(p => p.includes('清理資料夾')), `${bad}：${JSON.stringify(r.problems)}`)
    }
    const good = [join(base, 'users', 'alice-backup'), join(home, 'Downloads', 'sub')]
    const ok = config.normalize({ cleanup: { roots: good } }, sys)
    assert.deepEqual(ok.config.cleanup.roots, good)
    assert.deepEqual(ok.problems, [])
  })

  test('Windows 不分大小寫：C:\\Users、c:\\users\\alice、磁碟根目錄都拒絕', () => {
    const w = { os: 'win32', home: 'C:\\Users\\Alice' }
    for (const bad of ['C:\\', 'c:\\', 'D:\\', 'C:\\Users', 'c:\\users', 'C:\\USERS\\', 'C:\\Users\\Alice', 'c:\\users\\alice\\']) {
      assert.ok(config.cleanupRootProblem(bad, w), bad)
    }
    for (const good of ['C:\\Users\\Alice\\Downloads', 'c:\\users\\alice\\downloads\\x', 'C:\\Users2', 'D:\\Downloads']) {
      assert.equal(config.cleanupRootProblem(good, w), null, good)
    }
  })

  test('POSIX 的純函式：/home 拒絕、/home/bobby 照收', () => {
    const p = { os: 'linux', home: '/home/bob' }
    for (const bad of ['/', '/home', '/home/', '/home/bob', '/home/bob/']) assert.ok(config.cleanupRootProblem(bad, p), bad)
    for (const good of ['/home/bob/Downloads', '/home/bobby', '/srv/dl']) assert.equal(config.cleanupRootProblem(good, p), null, good)
  })
})

// ═══ j ・ /health ══════════════════════════════════════════════

describe('j /health 的細節', () => {
  test('lastOkAt／lastErrorAt 只給帶 token 的（免 token 的欄位還在，是 null）', t => {
    const f = fixture(t)
    routes.recordCleanupError(f.db, new Error('boom'))
    routes.recordOk(f.db)
    const lean = routes.healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine })
    assert.ok('lastOkAt' in lean && 'lastErrorAt' in lean, '形狀要一致')
    assert.equal(lean.lastOkAt, null)
    assert.equal(lean.lastErrorAt, null)
    const full = routes.healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine, full: true })
    assert.ok(Date.parse(full.lastOkAt) > Date.parse(full.lastErrorAt))
  })

  /** 一個沒有候選、有錯誤文字的舊大 zip。拿規則問一次會命中 archive —— 但那是下一次掃描的事。 */
  function bigOldZip(f, { status = 'kept', withCandidate = false } = {}) {
    const id = randomUUID(), now = new Date().toISOString()
    f.db.prepare(`INSERT INTO file_items (id,path,name,ext,bytes,sha256,mtime,first_seen_at,last_seen_at,status,error)
                  VALUES (?,?,?,?,?,NULL,?,?,?,?,?)`)
      .run(id, join(f.downloads, 'big.zip'), 'big.zip', '.zip', 30 * 1024 * 1024,
           new Date(Date.now() - 200 * DAY).toISOString(), now, now, status, '檔案 30.0MB，超過清理掃描上限')
    if (withCandidate) {
      f.db.prepare(`INSERT INTO cleanup_candidates (id,item_id,kind,rule_version,confidence,reason,evidence,status,created_at)
                    VALUES (?,?,'archive',?,65,'r','e','proposed',?)`).run(randomUUID(), id, CLEANUP_RULE_VERSION, now)
    }
  }
  const counts = f => [
    routes.listCandidates(f.db, { roots: f.opts.roots }).needsHumanTotal,
    routes.healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine }).needsHumanCount,
  ]

  test('（推論）跟清理有沒有關係看資料庫的事實，不在讀取時跑規則：沒有候選的 kept 大檔不列', t => {
    const f = fixture(t, {})
    bigOldZip(f)
    assert.deepEqual(counts(f), [0, 0])
  })

  test('同一個檔有 proposed 候選 → 列；status 是 error → 列（邊界的另一側）', t => {
    const f = fixture(t, {})
    bigOldZip(f, { withCandidate: true })
    assert.deepEqual(counts(f), [1, 1])
    const g = fixture(t, {})
    bigOldZip(g, { status: 'error' })
    assert.deepEqual(counts(g), [1, 1])
  })

  test('405 一律帶 Allow：/health、/assets', async t => {
    const s = await serve(t)
    const h = await s.raw('POST', '/health', { body: '{}' })
    assert.equal(h.status, 405)
    assert.equal(h.json.code, 'BAD_METHOD')
    assert.equal(h.headers.allow, 'GET')
    const a = await s.raw('POST', '/assets/pet-viewer.js', { body: '{}' })
    assert.equal(a.status, 405)
    assert.equal(a.json.code, 'BAD_METHOD')
    assert.equal(a.headers.allow, 'GET, HEAD')
  })
})

// ═══ k ・ 空 token ═════════════════════════════════════════════

describe('k 空 token 不可以跑起來', () => {
  test('sameToken 拒絕空字串', () => {
    assert.equal(server.sameToken('', ''), false)
    assert.equal(server.sameToken('abc', 'abc'), true)
    assert.equal(server.sameToken('abc', 'abd'), false)
  })

  test('token 檔是空的或只有空白 → 重新產生一把、寫回去（0600）；有內容的不動', t => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-core2-tok-')))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    for (const empty of ['', '  \n\t ']) {
      const p = join(dir, 'token-' + empty.length)
      writeFileSync(p, empty, { mode: 0o644 })
      const tok = server.loadToken(p)
      assert.ok(tok.length >= 20, `產生的 token 太短：${JSON.stringify(tok)}`)
      assert.equal(readFileSync(p, 'utf8').trim(), tok, '要寫回檔案')
      if (process.platform !== 'win32') assert.equal(statSync(p).mode & 0o777, 0o600)
    }
    const kept = join(dir, 'token-kept')
    writeFileSync(kept, 'abc-123\n')
    assert.equal(server.loadToken(kept), 'abc-123')
    assert.equal(readFileSync(kept, 'utf8'), 'abc-123\n')
  })

  test('server 啟動時 token 檔是空的 → 用新產生的那把；不帶 header 的請求一律 401', async t => {
    mkdirSync(join(FAKE_HOME, '.contextbox'), { recursive: true })
    writeFileSync(server.TOKEN_PATH, '')
    t.after(() => rmSync(server.TOKEN_PATH, { force: true }))
    const s = await serve(t, { token: null })          // null ＝ 不給，讓 server 自己讀 token 檔
    assert.ok(s.token.length >= 20)
    assert.equal(readFileSync(server.TOKEN_PATH, 'utf8').trim(), s.token)
    for (const [path, token] of [['/cleanup/candidates', null], ['/cleanup/candidates', ''], ['/facts', null]]) {
      const r = await s.raw('GET', path, { token })
      assert.equal(r.status, 401, `${path} token=${JSON.stringify(token)}`)
    }
    for (const path of ['/', '/?k=']) {
      assert.equal((await s.raw('GET', path, { token: null })).status, 401, path)
    }
  })

  test('呼叫端明確給了空 token（""）也不可以用空 token 跑', async t => {
    const s = await serve(t, { token: '' })
    assert.ok(s.token.length >= 20, JSON.stringify(s.token))
    assert.equal((await s.raw('GET', '/cleanup/candidates', { token: '' })).status, 401)
  })
})

// ═══ l ・ POST /cleanup/scan 回 problems ═══════════════════════════

describe('l POST /cleanup/scan 回 problems（人話、不帶完整路徑）', () => {
  test('route：把 onProblem 傳給掃描，收到的話原樣回（根目錄的完整路徑換成資料夾名稱）', t => {
    const f = fixture(t)
    let got = null
    const handled = routes.cleanupRoutes({
      db: f.db, roots: f.opts.roots, quarantine: f.opts.quarantine, maxBytes: f.opts.maxBytes, readonly: false,
      url: new URL('http://x/cleanup/scan'), method: 'POST', body: {},
      send: (code, body) => { got = { code, body } },
      scan: onProblem => {
        onProblem('打不開掃描資料夾「Downloads」（沒有權限？），這次什麼都沒掃到。')
        onProblem(`掃描資料夾不存在：${f.downloads}`)
        return f.scan()
      },
    })
    assert.ok(handled)
    assert.equal(got.code, 200)
    assert.ok(Array.isArray(got.body.problems))
    assert.equal(got.body.problems.length, 2)
    assert.match(got.body.problems[0], /打不開掃描資料夾「Downloads」/)
    assert.match(got.body.problems[1], /掃描資料夾不存在/)
    for (const m of got.body.problems) assert.ok(!m.includes(f.dir), `problem 帶了完整路徑：${m}`)
    assert.equal(typeof got.body.scanned, 'number', '原本的欄位還在')
  })

  test('scanner 自己寫的話就不帶完整路徑（不靠 route 再擋一次）', t => {
    const s = sandbox(t)
    s.scan({ roots: [s.dl, join(s.dir, '外接碟')] })
    const hit = s.problems.find(m => m.includes('外接碟'))
    assert.ok(hit, JSON.stringify(s.problems))
    assert.ok(!hit.includes(s.dir), `problem 帶了完整路徑：${hit}`)
  })

  test('真的 server：根目錄不存在、子資料夾打不開 → problems 有人話、不帶路徑；沒事的時候是空陣列', async t => {
    const s = await serve(t, { files: { 'a.zip': {} }, extraRoot: '不存在的資料夾' })
    let r = await s.api('POST', '/cleanup/scan', {})
    assert.equal(r.status, 200)
    assert.ok(r.json.problems.some(m => m.includes('不存在的資料夾')), JSON.stringify(r.json.problems))
    if (!noPerm) {
      mkdirSync(join(s.downloads, '鎖住的'))
      writeFileSync(join(s.downloads, '鎖住的', 'x.zip'), 'x')
      chmodSync(join(s.downloads, '鎖住的'), 0o000)
      try { r = await s.api('POST', '/cleanup/scan', {}) }
      finally { chmodSync(join(s.downloads, '鎖住的'), 0o755) }
      assert.ok(r.json.problems.some(m => /打不開/.test(m)), JSON.stringify(r.json.problems))
    }
    for (const m of r.json.problems) {
      assert.equal(typeof m, 'string')
      assert.ok(!m.includes(s.dir), `problem 帶了完整路徑：${m}`)
    }
    const clean = await serve(t, { files: { 'a.zip': {} } })
    const c = await clean.api('POST', '/cleanup/scan', {})
    assert.deepEqual(c.json.problems, [])
  })
})

// ═══ m ・ 失敗原因在 applyPlan 裡面記 ══════════════════════════════

describe('m 失敗原因在 applyPlan 裡面記（不經過 route）', () => {
  test('直接呼叫 applyPlan → 重掃 → why 還在', t => {
    const f = fixture(t, {})
    writeFileSync(join(f.downloads, 'r.pdf'), 'same')
    writeFileSync(join(f.downloads, 'r (1).pdf'), 'same')
    // 稽核第二輪 R2-2 之後，正常掃描不會把還在十分鐘內的重複檔提升成候選；
    // 用 minStableMs: 0 掃，做出「計畫裡有一個還在十分鐘內的檔」
    scanner.scanDownloads({ db: f.db, ...f.opts, minStableMs: 0, now: new Date(Date.now() + 1000) })
    const p = plans.createPlan(f.db)
    const r = routes.withOutcomes(f.db, exec.applyPlan(f.db, p.id, f.opts))
    const failed = r.items.filter(i => i.outcome === 'failed')
    assert.equal(failed.length, 1)
    assert.match(failed[0].why, /十分鐘內還在變動/)
    assert.equal(f.db.prepare('SELECT count(*) n FROM cleanup_item_errors WHERE plan_id=?').get(p.id).n, 1)
    f.scan()                                            // 會改寫 file_items.error
    const later = routes.withOutcomes(f.db, plans.getPlan(f.db, p.id)).items.find(i => i.itemId === failed[0].itemId)
    assert.equal(later.outcome, 'failed')
    assert.match(later.why, /十分鐘內還在變動/, `重掃之後原因不見了：${later.why}`)
  })

  test('（推論）同一份計畫接著做成功 → 失敗紀錄刪掉', t => {
    const f = fixture(t, { 'a.zip': 'aaa', 'b.zip': 'bbb' })
    const p = plans.createPlan(f.db)
    const b = join(f.downloads, 'b.zip')
    writeFileSync(b, 'bbb changed')
    utimesSync(b, f.old, f.old)
    assert.equal(exec.applyPlan(f.db, p.id, f.opts).status, 'partial')
    assert.equal(f.db.prepare('SELECT count(*) n FROM cleanup_item_errors WHERE plan_id=?').get(p.id).n, 1)
    // 跑完的計畫（partial）是一次性的、不重試（稽核第二輪 R2-3）；會接著做的只有中斷的 proposed。
    // 把狀態撥回 proposed，模擬「b 失敗之後、寫計畫狀態之前被砍」
    f.db.prepare(`UPDATE cleanup_plans SET status='proposed' WHERE id=?`).run(p.id)
    writeFileSync(b, 'bbb')                             // 改回原樣（內容、大小、時間都一樣）
    utimesSync(b, f.old, f.old)
    assert.equal(exec.applyPlan(f.db, p.id, f.opts).status, 'applied')
    assert.equal(f.db.prepare('SELECT count(*) n FROM cleanup_item_errors WHERE plan_id=?').get(p.id).n, 0)
    assert.ok(routes.withOutcomes(f.db, plans.getPlan(f.db, p.id)).items.every(i => i.outcome === 'moved'))
  })
})

// ═══ n、o ・ recordOk 與 safeWhy ═══════════════════════════════════

describe('n recordOk 匯出、o 只留 safeWhy 一個翻譯入口', () => {
  test('recordOk 寫 lastOkAt：一次意外之後 recordOk，寵物不再擔心', t => {
    const f = fixture(t)
    assert.equal(typeof routes.recordOk, 'function')
    routes.recordCleanupError(f.db, new Error('boom'))
    const pet = () => {
      const h = routes.healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine, full: true })
      return routes.petState(h, { proposedPlans: 0, activeQuarantine: 0 }).state
    }
    assert.equal(pet(), 'worried')
    routes.recordOk(f.db)
    assert.notEqual(pet(), 'worried')
  })

  test('humanError 不再匯出；safeWhy 翻帶路徑的、人話原樣通過、空的回 null', () => {
    assert.equal(routes.humanError, undefined)
    assert.equal(routes.safeWhy("EACCES: permission denied, open '/home/u/x.pdf'"), '沒有權限讀這個檔案')
    assert.equal(routes.safeWhy('這個檔案十分鐘內還在變動，先不搬。等一下再試一次。'), '這個檔案十分鐘內還在變動，先不搬。等一下再試一次。')
    assert.equal(routes.safeWhy(null), null)
    assert.equal(routes.safeWhy(''), null)
  })
})

// ── HTTP 小工具 ──────────────────────────────────────────────

async function serve(t, { files = {}, token = 'core2-token', extraRoot = null } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-core2-srv-')))
  const downloads = join(dir, 'Downloads')
  mkdirSync(downloads)
  for (const name of Object.keys(files)) {
    const p = join(downloads, name)
    writeFileSync(p, 'content ' + name)
    const at = new Date(Date.now() - 60 * DAY)
    utimesSync(p, at, at)
  }
  const roots = extraRoot ? [downloads, join(dir, extraRoot)] : [downloads]
  const S = server.start({ port: 0, db: join(dir, 'data.db'), token: token === null ? undefined : token, roots, quarantine: join(dir, 'q'),
    maxBytes: 1024 * 1024, readonly: false })
  const port = await S.ready
  t.after(() => { S.server.close(); rmSync(dir, { recursive: true, force: true }) })
  const raw = (method, path, { body, token: tk = S.token, headers = {} } = {}) => new Promise((resolve, reject) => {
    const h = { ...(tk !== null ? { 'x-contextbox-token': tk } : {}), ...headers }
    if (body !== undefined) h['content-type'] ??= 'application/json'
    const req = request({ host: '127.0.0.1', port, method, path, headers: h }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { /* 不是 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.end(body)
    else req.end()
  })
  const api = (method, path, body) => raw(method, path, { body: body === undefined ? undefined : JSON.stringify(body) })
  return { dir, downloads, port, token: S.token, raw, api }
}

test('舊資料修復可以在呼叫端的交易裡跑（合併時抓到：BEGIN 在交易裡會丟例外）', async () => {
  const { open } = await import('../core/db.ts')
  const { repairLegacyDismissed } = await import('../core/cleanup-scanner.ts')
  const db = open(':memory:')
  try {
    db.exec('BEGIN')
    assert.doesNotThrow(() => repairLegacyDismissed(db), '呼叫端已經開了交易')
    db.exec('COMMIT')
    assert.equal(repairLegacyDismissed(db), 0, '第二次不再跑')
  } finally { db.close() }
})
