import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行：這支 spawn cli.mjs，家目錄要先換掉
/**
 * 2026-09-19 稽核第三輪：CLI、pet 與路由的接線（cli.mjs、core/cleanup-routes.ts、docs/cli.md）。
 *
 * **期望值是動手之前寫死的**（build-round Step 1），先紅再修。實作中可以改寫法，不可以改期望值。
 *
 * ── Step 0 分級 ───────────────────────────────────────────────────
 * 高風險：no-op 被記成成功（會把還沒解決的錯清掉 → 寵物說沒事，安靜錯很久）、鎖被接走時的離開碼
 * （2 ＝ 動作沒執行是右鍵選單與腳本的契約，實際上檔已經搬了）、收尾把使用者指名的計畫作廢（動作靜靜地不做）。
 * 中風險：needsSettling 的記憶（併發：記錯了就永遠不收尾或永遠拿鎖）、唯讀模式（契約）。
 * 低風險：/cleanup/scan 的 body 白名單、docs/cli.md（錯了馬上看得見）。
 *
 * ── Step 1 ─────────────────────────────────────────────────────────
 *
 * | 段落 | 可能的錯 | 另一種解讀 | 成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | R3-2b 記帳 | no-op 也算「這一種動作成功了」 | no-op 不記成功也不記錯 | 有一個沒解決的 apply 錯 → 重送跑過的計畫／重送之後真的跑一份新計畫 | 錯還在、寵物照樣擔心／錯被清掉、寵物不擔心 |
 * | R3-2b 畫面 | 印得像剛搬完（「搬進隔離區 1 個」「後悔的話」） | 明說「先前已經跑過了，這次什麼都沒做」 | 重送一份 applied 的計畫／第一次套用 | 「這次什麼都沒做」、沒有「搬進隔離區」／照舊 |
 * | R3-15 下一步 | partial／error 重送只印跟第一次一樣的畫面 | 講「不會重試」＋真正的下一步（重掃、建新計畫） | 重送一份 partial 的計畫 | 有「不會重試」、有 `cleanup scan`，離開碼照逐項（3） |
 * | R3-3b 套用被打斷 | 一丟錯就 fail → 2、什麼都不印 | 照常印計畫 id 與逐項結果，離開碼照逐項 | 搬了幾個之後鎖被接走／一個都還沒搬就 BUSY | 3＋計畫 id＋✔ 幾行＋「打斷」「再跑一次」／2（照舊） |
 * | R3-3b 清空被打斷 | 回 1／2，不講刪了幾個 | 講「已經刪掉 N 個」、可以接著做 | 刪了幾個之後鎖被接走 | 3、訊息有「刪掉 1 個」與「再跑一次」 |
 * | R3-6b 指名的計畫 | 收尾連它一起作廢 | 收尾跳過它（skipPlanId），只放棄更舊的 | `apply <2 小時前的 id>`，另有一份 3 小時前的／同一份但沒指名 | 指名的照樣套用（檔搬走）、另一份被作廢／被作廢 |
 * | R3-9 唯讀 | 唯讀照樣 recoverInterrupted／releaseStalePlans | 唯讀整個收尾都不做 | `CONTEXTBOX_READONLY=1 cleanup list`／同一份非唯讀 | 計畫還是 proposed、started 的列不動／被作廢 |
 * | R3-9 doctor | 唯讀的 doctor 照樣改資料庫、什麼都不講 | 不改，而且講一句 | `CONTEXTBOX_READONLY=1 doctor` | 計畫不動、輸出有「不會自動收尾」 |
 * | R3-11 收不動的列 | 每一次指令都再拿一次鎖重算 | 記住這一列，檔案沒變就不再重試 | 第一次 list／第二次 list／隔離區那份被改動之後 | 拿鎖／不拿鎖／拿鎖 |
 * | R3-12 掃描問題 | 寵物只看 db 與 lastError | 掃描問題／清理資料夾不見也要擔心 | 清理資料夾不存在、掃過一次／一切正常 | worried＋訊息講資料夾不見、不含絕對路徑／不是 worried |
 * | R3-14 scan 的 body | 不檢查 | 不認得的欄位 400 BAD_BODY | `{"rootz":1}`／`{}` | 400／200 |
 * | docs/cli.md | 照樣引用已經刪掉的字串 | 引用現在真的會印的那一句 | grep 舊字串 | 一個都沒有 |
 *
 * 預設的決定（寫清楚，不猜）：
 * - no-op 的判斷：exec 組回的 `noop` 為主；它還沒到（或沒回）的時候用「套用前的 status 已經是
 *   applied／partial／error」—— 那正是核心 R2-3 原樣回傳的條件，兩者同一件事。
 * - 被打斷之後的離開碼：**這一次真的有動到東西**（cleanup_journal 多了列）才算「執行了」→ 照逐項（3）；
 *   一個都沒動到就照舊回 2（動作沒執行是真的）。
 * - 收尾在唯讀模式**整個不做**：recoverInterrupted 與 releaseStalePlans 兩支都會寫資料庫。
 * - 指名計畫的那一次收尾「只放棄比它更舊的」：既帶 `{ skipPlanId }`（exec 組之後會認），
 *   也把門檻放寬到那份計畫的建立時間之前（現在這版的核心還不看第三個參數）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync, rmSync, realpathSync,
  existsSync, readFileSync, readdirSync, chmodSync,
} from 'node:fs'
import { spawnSync, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { open } from '../core/db.ts'
import { createPlan } from '../core/cleanup-plans.ts'
import { scanDownloads } from '../core/cleanup-scanner.ts'
import { initCleanup } from '../core/cleanup-journal.ts'
import * as routes from '../core/cleanup-routes.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(REPO, 'cli.mjs')
const DAY = 86400_000
const MAX = 20971520
const sleep = ms => new Promise(r => setTimeout(r, ms))

assert.ok(FAKE_HOME, '前提：測試行程的家目錄已經換掉')

// ── 沙盒 ─────────────────────────────────────────────────────

/** 一個完全隔離的 CLI 環境：HOME 就是暫存資料夾，cleanup.roots 的預設（~/Downloads）落在沙盒裡。 */
function sandbox(t, { files = {}, config = {}, downloads = true } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cb-r3cli-')))
  const dl = join(home, 'Downloads')
  if (downloads) mkdirSync(dl)
  const p = {
    cfg: join(home, 'config.json'), db: join(home, 'data.db'), q: join(home, 'q'),
    token: join(home, 'token'), opened: join(home, 'opened.txt'), opener: join(home, 'opener.sh'),
  }
  writeFileSync(p.opener, '#!/bin/sh\nprintf \'%s\' "$1" > "$CB_OPENED"\n')
  chmodSync(p.opener, 0o755)
  let cfg = {
    watch: [dl], filed: join(home, 'Filed'),
    model: { baseUrl: '', name: '', keyEnv: 'CONTEXTBOX_MODEL_KEY' },
    readonly: false, pdfPages: 3, maxBytes: MAX, ...config,
  }
  writeFileSync(p.cfg, JSON.stringify(cfg))
  const put = (name, days = 60, content = 'x ' + name, dir = dl) => {
    mkdirSync(dir, { recursive: true })
    const f = join(dir, name)
    writeFileSync(f, content)
    const at = new Date(Date.now() - days * DAY)
    utimesSync(f, at, at)
    return f
  }
  for (const [n, d] of Object.entries(files)) put(n, d)
  const env = (extra = {}) => ({
    ...process.env,
    HOME: home, USERPROFILE: home,
    CONTEXTBOX_CONFIG: p.cfg, CONTEXTBOX_DB: p.db, CONTEXTBOX_QUARANTINE: p.q,
    CONTEXTBOX_TOKEN_PATH: p.token, CONTEXTBOX_PORT: '0',
    CONTEXTBOX_OPENER: p.opener, CB_OPENED: p.opened,
    ...extra,
  })
  const run = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: env(extra), timeout: 120_000 })
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '' }
  }
  const dbs = []
  const db = () => { const d = open(p.db); dbs.push(d); return d }
  t.after(() => {
    for (const d of dbs) { try { d.close() } catch { /* 已經關了 */ } }
    rmSync(home, { recursive: true, force: true })
  })
  return { home, dl, p, put, run, env, db }
}

/** 讀一列（唯讀連線，不跟 CLI 搶鎖） */
const one = (s, sql, ...a) => {
  const d = new DatabaseSync(s.p.db, { readOnly: true })
  try { d.exec('PRAGMA busy_timeout = 5000'); return d.prepare(sql).get(...a) }
  finally { d.close() }
}
const all = (s, sql, ...a) => {
  const d = new DatabaseSync(s.p.db, { readOnly: true })
  try { d.exec('PRAGMA busy_timeout = 5000'); return d.prepare(sql).all(...a) }
  finally { d.close() }
}
const meta = (s, k) => existsSync(s.p.db) ? one(s, 'SELECT v FROM meta WHERE k=?', k)?.v ?? null : null
const planIdOf = out => /Plan ([0-9a-f-]{36})/.exec(out)?.[1]

/** 某個檔（照檔名）的候選 id */
const candIds = (d, name) => d.prepare(
  `SELECT c.id FROM cleanup_candidates c JOIN file_items i ON i.id=c.item_id WHERE i.name=? AND c.status='proposed'`,
).all(name).map(r => r.id)

/** 非同步跑一次 CLI（測試行程要同時做事的時候用，spawnSync 會卡住事件迴圈） */
function runAsync(s, args, extra = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { env: s.env(extra) })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.once('close', code => resolve({ code, out: stdout + stderr, stdout }))
  })
}

/**
 * 模擬「另一台 CLI／pet 把殘留鎖接走」：等到 ready() 成立，就換掉 cleanup_operation_lock 的 owner。
 * 之後持有者的 renew() 會發現鎖不是自己的 → 丟 BUSY，做到一半停下來。
 */
function stealLockWhen(s, ready) {
  let stop = false, stolen = false
  const d = new DatabaseSync(s.p.db)
  d.exec('PRAGMA busy_timeout = 8000')
  const loop = (async () => {
    const t0 = Date.now()
    while (!stop && Date.now() - t0 < 60_000) {
      try {
        if (d.prepare('SELECT 1 FROM cleanup_operation_lock WHERE singleton=1').get() && ready(d)) {
          d.prepare('INSERT OR REPLACE INTO cleanup_operation_lock VALUES (1,?,?)')
            .run(process.pid, new Date().toISOString() + ' thief')
          stolen = true
          return
        }
      } catch { /* 對方正在寫：下一輪再看 */ }
      await sleep(1)
    }
  })()
  return {
    async done() { stop = true; await loop; try { d.close() } catch { /* 已經關了 */ } return stolen },
  }
}

/** 一把「早就過期、持有者已經不在」的殘留鎖。誰真的去拿清理鎖，這一列就會不見（withCleanupLock 收尾時刪掉自己的 owner）。 */
function plantStaleLock(s) {
  const d = new DatabaseSync(s.p.db)
  try {
    d.exec('PRAGMA busy_timeout = 8000')
    initCleanup(d)
    d.prepare('INSERT OR REPLACE INTO cleanup_operation_lock VALUES (1,?,?)')
      .run(999_999, new Date(Date.now() - 6 * 3600_000).toISOString() + ' ghost')
  } finally { d.close() }
}
const lockTaken = s => !one(s, 'SELECT 1 FROM cleanup_operation_lock WHERE singleton=1')

/** 只要 db 的核心沙盒（給直接打 route 的那幾條用） */
function coreBox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-r3core-')))
  const dl = join(dir, 'Downloads')
  mkdirSync(dl)
  const db = open(join(dir, 'data.db'))
  initCleanup(db)
  t.after(() => { try { db.close() } catch { /* 已經關了 */ } ; rmSync(dir, { recursive: true, force: true }) })
  const opts = { roots: [dl], quarantine: join(dir, 'q'), maxBytes: MAX }
  return { dir, dl, db, opts }
}

/** 直接打 route（不經過 HTTP）。回 { handled, code, body }。 */
function call(f, method, path, body = {}, extra = {}) {
  let got = null
  const handled = routes.cleanupRoutes({
    db: f.db, roots: f.opts.roots, quarantine: f.opts.quarantine,
    maxBytes: f.opts.maxBytes, readonly: false,
    url: new URL('http://x' + path), method, body,
    send: (code, payload, headers) => { got = { code, body: payload, headers: headers ?? {} } },
    scan: () => ({ scanned: 0, skipped: 0, errors: 0, truncated: false, candidates: 0 }),
    ...extra,
  })
  return { handled, ...got }
}

// ═══ R3-2b ・ no-op 不是「這一種動作成功了」 ═══════════════════════

describe('R3-2b no-op 的記帳', () => {
  test('recordActionResult 看到 noop：不記成功、也不記錯，還沒解決的套用錯留著', t => {
    const f = coreBox(t)
    // 一個真的、還沒解決的套用錯（磁碟滿）
    assert.equal(routes.recordActionResult(f.db, 'apply', { status: 'error', error: '磁碟空間不足，沒有搬動任何檔案。' }), 'error')
    const errBefore = f.db.prepare('SELECT v FROM meta WHERE k=?').get(routes.META.lastError)?.v ?? null
    assert.ok(errBefore, '前提：錯記下來了')
    const h0 = routes.healthSnapshot(f.db, { ...f.opts, full: true })
    assert.equal(routes.errorStillActive(h0), true, '前提：錯還算數')

    // 跑過的計畫再 apply：核心原樣回傳（noop），一個檔都沒動
    const r = routes.recordActionResult(f.db, 'apply', { status: 'partial', noop: true })
    assert.notEqual(r, 'ok', 'no-op 不可以記成「這一種動作成功了」')
    assert.notEqual(r, 'error', 'no-op 也沒有失敗，不可以記錯')

    const h1 = routes.healthSnapshot(f.db, { ...f.opts, full: true })
    assert.equal(h1.lastError, errBefore, '原本的錯被改掉了')
    assert.equal(h1.lastOkByKind.apply, null, 'no-op 不可以寫 apply 的成功時間')
    assert.equal(routes.errorStillActive(h1), true, '還沒解決的套用錯被 no-op 清掉了')
  })

  test('對照：真的跑成功一次（沒有 noop）照樣把那一種的錯清掉', t => {
    const f = coreBox(t)
    routes.recordActionResult(f.db, 'apply', { status: 'error', error: '磁碟空間不足，沒有搬動任何檔案。' })
    assert.equal(routes.recordActionResult(f.db, 'apply', { status: 'applied' }), 'ok')
    const h = routes.healthSnapshot(f.db, { ...f.opts, full: true })
    assert.equal(routes.errorStillActive(h), false, '真的成功要清得掉')
  })

  test('noop 的計畫就算 status 是 error 也不記錯（它根本沒跑）', t => {
    const f = coreBox(t)
    const r = routes.recordActionResult(f.db, 'apply', { status: 'error', error: '磁碟空間不足。', noop: true })
    assert.notEqual(r, 'error')
    const h = routes.healthSnapshot(f.db, { ...f.opts, full: true })
    assert.equal(h.lastError, null, 'no-op 不可以把舊的失敗再記一次（每次重送都把時間往後推）')
  })

  test('清空的 noop 也一樣', t => {
    const f = coreBox(t)
    routes.recordActionResult(f.db, 'empty', { deletedCount: 0, deletedBytes: 0, errors: [{ error: '隔離檔案不見了。' }] })
    const before = f.db.prepare('SELECT v FROM meta WHERE k=?').get(routes.META.lastError)?.v ?? null
    assert.ok(before, '前提：錯記下來了')
    assert.notEqual(routes.recordActionResult(f.db, 'empty', { deletedCount: 0, deletedBytes: 0, errors: [], noop: true }), 'ok')
    const h = routes.healthSnapshot(f.db, { ...f.opts, full: true })
    assert.equal(h.lastOkByKind.empty, null)
    assert.equal(routes.errorStillActive(h), true)
  })
})

// ═══ R3-14 ・ POST /cleanup/scan 的 body 白名單 ════════════════════

describe('R3-14 POST /cleanup/scan 也要擋不認得的欄位', () => {
  test('拼錯的欄位 → 400 BAD_BODY', t => {
    const f = coreBox(t)
    const r = call(f, 'POST', '/cleanup/scan', { rootz: 1 })
    assert.equal(r.code, 400, '不認得的欄位照樣 200：R2-7 的規則在這一條有缺口')
    assert.equal(r.body.code, 'BAD_BODY')
    assert.match(String(r.body.error), /rootz/)
  })

  test('對照：空 body 與沒帶 body 照樣 200（產生器與面板送的就是這個）', t => {
    const f = coreBox(t)
    assert.equal(call(f, 'POST', '/cleanup/scan', {}).code, 200)
    assert.equal(call(f, 'POST', '/cleanup/scan', undefined).code, 200)
  })
})

// ── CLI 的小工具 ─────────────────────────────────────────────

/** 掃一次，再用這些檔名建一份計畫（不套用），回計畫 id */
function planFor(s, names) {
  assert.equal(s.run(['cleanup', 'scan']).code, 0)
  const d = s.db()
  const ids = names.flatMap(n => candIds(d, n))
  assert.ok(ids.length >= names.length, `前提：${names.join('、')} 都是候選`)
  return createPlan(d, { candidateIds: ids }).id
}

/** 把一份計畫的 created_at 往前撥（模擬「開著放了很久」） */
function backdatePlan(s, id, ms) {
  const d = new DatabaseSync(s.p.db)
  try {
    d.exec('PRAGMA busy_timeout = 8000')
    d.prepare('UPDATE cleanup_plans SET created_at=? WHERE id=?').run(new Date(Date.now() - ms).toISOString(), id)
  } finally { d.close() }
}

const planStatus = (s, id) => one(s, 'SELECT status FROM cleanup_plans WHERE id=?', id)?.status ?? null
const releases = s => Number(one(s, 'SELECT count(*) n FROM cleanup_plan_releases')?.n ?? 0)

// ═══ R3-2b／R3-15 ・ 重送跑過的計畫，畫面與記帳都要照實說 ═══════════

describe('R3-2b／R3-15 重送一份跑過的計畫（CLI）', () => {
  test('partial 的計畫再 apply：不可以印得像剛搬完，而且要講「不會重試」與真正的下一步', t => {
    const s = sandbox(t, { files: { 'ok.zip': 60, 'bad.zip': 60 } })
    const id = planFor(s, ['ok.zip', 'bad.zip'])
    // bad.zip 在建計畫之後被改動 → 套用時 TOO_FRESH／CHANGED，計畫落在 partial
    writeFileSync(join(s.dl, 'bad.zip'), '改過了改過了')
    const first = s.run(['cleanup', 'apply', id])
    assert.equal(first.code, 3, `前提：第一次是部分失敗\n${first.out}`)
    assert.equal(planStatus(s, id), 'partial', `前提：計畫落在 partial\n${first.out}`)
    assert.match(first.out, /Moved 1 file/, '前提：第一次真的搬了一個')

    const again = s.run(['cleanup', 'apply', id])
    assert.match(again.out, /nothing happened this time/, `重送是 no-op，畫面要說出來：\n${again.out}`)
    assert.doesNotMatch(again.out, /Moved \d+ files? \(/, `一個檔都沒動，不可以印得像剛搬完：\n${again.out}`)
    assert.match(again.out, /does not retry/, `R3-15：非Read-only路徑也要講「does not retry沒搬成的」：\n${again.out}`)
    assert.match(again.out, /cleanup scan/, `R3-15：要給真正的下一步（full-rescan、建新計畫）：\n${again.out}`)
    assert.match(again.out, new RegExp(`Plan ${id}`), '計畫 id 照印')
  })

  test('重送不可以把還沒解決的套用錯清掉（寵物照樣擔心）', t => {
    const s = sandbox(t, { files: { 'ok.zip': 60, 'bad.zip': 60 } })
    const id = planFor(s, ['ok.zip', 'bad.zip'])
    writeFileSync(join(s.dl, 'bad.zip'), '改過了改過了')
    assert.equal(s.run(['cleanup', 'apply', id]).code, 3, '前提：第一次是部分失敗')

    // 一個真的、還沒解決的套用錯（磁碟滿）
    const d = s.db()
    routes.recordActionResult(d, 'apply', { status: 'error', error: '磁碟空間不足，沒有搬動任何檔案。' })
    const h0 = routes.healthSnapshot(d, { roots: [s.dl], quarantine: s.p.q, full: true })
    assert.equal(routes.errorStillActive(h0), true, '前提：錯還算數')

    const before = readFileSync(join(s.dl, 'bad.zip'), 'utf8')
    s.run(['cleanup', 'apply', id])
    assert.equal(readFileSync(join(s.dl, 'bad.zip'), 'utf8'), before, '前提：重送一個檔都不會動')

    routes.invalidateQuarantineCache()
    const h1 = routes.healthSnapshot(s.db(), { roots: [s.dl], quarantine: s.p.q, full: true })
    assert.equal(routes.errorStillActive(h1), true, 'no-op 的重送把還沒解決的套用錯清掉了')
    assert.equal(routes.petState(h1, { proposedPlans: 0, activeQuarantine: 1 }).state, 'worried')
  })

  test('對照：第一次套用照舊印「搬進隔離區」與復原指令，不講「什麼都沒做」', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    const id = planFor(s, ['a.zip'])
    const r = s.run(['cleanup', 'apply', id])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /Moved 1 file/, r.out)
    assert.match(r.out, /cleanup undo/, r.out)
    assert.doesNotMatch(r.out, /nothing happened this time/, r.out)
  })

  test('applied 的計畫再 apply：講「什麼都沒做」，但復原這條路還在（離開碼 0）', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    const id = planFor(s, ['a.zip'])
    assert.equal(s.run(['cleanup', 'apply', id]).code, 0)
    const again = s.run(['cleanup', 'apply', id])
    assert.equal(again.code, 0, again.out)
    assert.match(again.out, /nothing happened this time/, again.out)
    assert.doesNotMatch(again.out, /Moved \d+ files? \(/, again.out)
    assert.match(again.out, new RegExp(`cleanup undo ${id}`), `搬走的還在隔離區，放回原位這條路要講：\n${again.out}`)
  })
})

// ═══ R3-3b ・ 鎖被接走：做到一半，不可以說「動作沒執行」 ═══════════

describe('R3-3b 清理鎖被另一個清理動作接走', () => {
  test('套用到一半被接走：照常印計畫 id 與逐項結果，離開碼 3（不是 2）', async t => {
    // 這是一場真的競賽（另一個行程把鎖接走）。搶太慢（整份做完了）就換一個沙盒重來，
    // 不要把「這次沒搶到」報成「修錯了」—— 期望值一個字都不改。
    const N = 200
    let s = null, r = null, moved = 0
    for (let attempt = 0; attempt < 4 && !(moved >= 1 && moved < N); attempt++) {
      const files = {}
      for (let i = 1; i <= N; i++) files[`f${i}.zip`] = 60
      s = sandbox(t, { files })
      assert.equal(s.run(['cleanup', 'scan']).code, 0)
      const doneRows = d => Number(d.prepare(`SELECT count(*) n FROM cleanup_journal WHERE status='done'`).get().n)
      const thief = stealLockWhen(s, d => doneRows(d) >= 1)
      r = await runAsync(s, ['cleanup', 'apply'])
      await thief.done()
      moved = Number(one(s, `SELECT count(*) n FROM cleanup_journal WHERE status='done' AND op='quarantine'`)?.n ?? 0)
    }
    assert.ok(moved >= 1 && moved < N, `前提：做到一半就停了（搬了 ${moved} 個）\n${r.out}`)

    assert.match(r.out, /Plan [0-9a-f-]{36}/, `沒有計畫 id 的話使用者沒有 undo 的入口：\n${r.out}`)
    assert.match(r.out, /✔ /, `一行逐項結果都沒印：\n${r.out}`)
    assert.match(r.out, /interrupted/, `要說清楚是被另一個清理動作interrupted：\n${r.out}`)
    assert.match(r.out, /again picks up where it stopped/, `要說得出下一步（again picks up where it stopped接著做）：\n${r.out}`)
    assert.equal(r.code, 3, `已經有檔搬進隔離區，回 2（＝動作沒執行）是說謊：\n${r.out}`)
  })

  test('對照：一個檔都還沒搬就 BUSY（鎖本來就被別人拿著）→ 照舊回 2', async t => {
    const s = sandbox(t, { files: { 'a.zip': 60, 'b.zip': 60 } })
    assert.equal(s.run(['cleanup', 'scan']).code, 0)
    // 一把「持有者還活著、剛拿的」鎖：誰都接不走
    const d = new DatabaseSync(s.p.db)
    d.exec('PRAGMA busy_timeout = 8000')
    initCleanup(d)
    d.prepare('INSERT OR REPLACE INTO cleanup_operation_lock VALUES (1,?,?)')
      .run(process.pid, new Date().toISOString() + ' holder')
    let r
    try { r = await runAsync(s, ['cleanup', 'apply']) } finally { d.close() }
    assert.equal(r.code, 2, `什麼都沒發生，2 是對的：\n${r.out}`)
    assert.equal(Number(one(s, 'SELECT count(*) n FROM cleanup_journal')?.n ?? 0), 0, '前提：一個檔都沒搬')
  })

  test('清空到一半被接走：要講已經刪掉幾個，而且可以接著做', async t => {
    // 同樣是真的競賽：搶太慢就換一個沙盒重來（期望值不變）
    const N = 150
    let s = null, r = null, deleted = 0
    for (let attempt = 0; attempt < 4 && !(deleted >= 1 && deleted < N); attempt++) {
      const files = {}
      for (let i = 1; i <= N; i++) files[`q${i}.zip`] = 60
      s = sandbox(t, { files })
      assert.equal(s.run(['cleanup', 'scan']).code, 0)
      assert.equal(s.run(['cleanup', 'apply']).code, 0, '前提：先全部搬進隔離區')
      // 隔離滿七天才清得掉：把搬移完成時間往前撥
      const d0 = new DatabaseSync(s.p.db)
      try {
        d0.exec('PRAGMA busy_timeout = 8000')
        const old = new Date(Date.now() - 9 * DAY).toISOString()
        d0.prepare('UPDATE cleanup_move_details SET completed_at=?').run(old)
        d0.prepare('UPDATE cleanup_journal SET ts=?').run(old)
      } finally { d0.close() }

      const preview = s.run(['cleanup', 'quarantine', '--empty'])
      const token = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(preview.out)?.[1]
      assert.ok(token, `前提：預覽給了確認碼\n${preview.out}`)

      const purged = d => Number(d.prepare(`SELECT count(*) n FROM cleanup_purges WHERE status='done'`).get().n)
      const thief = stealLockWhen(s, d => purged(d) >= 1)
      r = await runAsync(s, ['cleanup', 'quarantine', '--empty', '--yes', token])
      await thief.done()
      deleted = Number(one(s, `SELECT count(*) n FROM cleanup_purges WHERE status='done'`)?.n ?? 0)
    }
    assert.ok(deleted >= 1 && deleted < N, `前提：刪到一半就停了（刪了 ${deleted} 個）\n${r.out}`)

    assert.match(r.out, new RegExp(`Deleted ${deleted} file`), `已經永久刪掉的要講出來：\n${r.out}`)
    assert.match(r.out, /interrupted/, `要說清楚是被另一個清理動作interrupted：\n${r.out}`)
    assert.match(r.out, /carry on with the rest|again picks up/, `要說得出下一步：\n${r.out}`)
    assert.equal(r.code, 3, `刪掉了一部分：3（執行了但沒全部做完），不是 1／2：\n${r.out}`)
  })

  test('**打斷之後再送一次、但鎖還被別人拿著（這一次一個檔都沒刪）→ 2，而且不可以再報一次「刪掉 N 個」**', t => {
    const s = sandbox(t, { files: { 'a.zip': 60, 'b.zip': 60 } })
    assert.equal(s.run(['cleanup', 'scan']).code, 0)
    assert.equal(s.run(['cleanup', 'apply']).code, 0)
    const d0 = new DatabaseSync(s.p.db)
    try {
      d0.exec('PRAGMA busy_timeout = 8000')
      const old = new Date(Date.now() - 9 * DAY).toISOString()
      d0.prepare('UPDATE cleanup_move_details SET completed_at=?').run(old)
      d0.prepare('UPDATE cleanup_journal SET ts=?').run(old)
    } finally { d0.close() }
    const preview = s.run(['cleanup', 'quarantine', '--empty'])
    const token = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(preview.out)?.[1]
    assert.ok(token, preview.out)
    // 假裝上一次刪了 1 個之後被打斷：進度留著（清空是照這個接著做的）
    const d = new DatabaseSync(s.p.db)
    try {
      d.exec('PRAGMA busy_timeout = 8000')
      d.prepare(`INSERT INTO cleanup_empty_progress(token,next,result) VALUES (?,?,?)`)
        .run(token, 1, JSON.stringify({ deletedCount: 1, deletedBytes: 12, errors: [], setAside: [] }))
      // 鎖還被另一個**活著的**清理動作拿著：這一次連鎖都拿不到
      d.prepare('INSERT OR REPLACE INTO cleanup_operation_lock VALUES (1,?,?)')
        .run(process.pid, `${new Date().toISOString()} someone-else`)
    } finally { d.close() }

    const r = s.run(['cleanup', 'quarantine', '--empty', '--yes', token])
    assert.equal(r.code, 2, `這一次一個檔都沒刪 → 動作沒執行，回 2：\n${r.out}`)
    assert.doesNotMatch(r.out, /Deleted 1 file/, `不可以把上一次的數字再報一次：\n${r.out}`)
  })

})

// ═══ R3-6b ・ 收尾不可以把使用者指名的那一份作廢 ═══════════════════

describe('R3-6b cleanup apply／undo <id> 之前的收尾', () => {
  test('指名一份放了兩小時的計畫：照樣套用，不可以被自己的收尾作廢', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    const id = planFor(s, ['a.zip'])
    backdatePlan(s, id, 2 * 3600_000)
    const r = s.run(['cleanup', 'apply', id])
    assert.doesNotMatch(r.out, /was dropped/, `使用者指名的那一份被同一個指令的收尾作廢了：\n${r.out}`)
    assert.equal(existsSync(join(s.dl, 'a.zip')), false, `檔沒有搬走（指令什麼都沒做）：\n${r.out}`)
    assert.equal(planStatus(s, id), 'applied', r.out)
    assert.equal(r.code, 0, r.out)
  })

  test('同一次收尾照樣放棄「比它更舊」的別份計畫', t => {
    const s = sandbox(t, { files: { 'a.zip': 60, 'b.zip': 60 } })
    assert.equal(s.run(['cleanup', 'scan']).code, 0)
    const d = s.db()
    const older = createPlan(d, { candidateIds: candIds(d, 'b.zip') }).id
    const named = createPlan(d, { candidateIds: candIds(d, 'a.zip') }).id
    backdatePlan(s, older, 3 * 3600_000)
    backdatePlan(s, named, 2 * 3600_000)
    const r = s.run(['cleanup', 'apply', named])
    assert.equal(planStatus(s, named), 'applied', `指名的那一份要照常套用：\n${r.out}`)
    assert.equal(planStatus(s, older), 'dismissed', `沒被指名、更舊的那一份照舊dropped automatically：\n${r.out}`)
  })

  test('對照：沒有指名（cleanup list）時，放兩小時的計畫照舊自動放棄', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    const id = planFor(s, ['a.zip'])
    backdatePlan(s, id, 2 * 3600_000)
    assert.equal(s.run(['cleanup', 'list']).code, 0)
    assert.equal(planStatus(s, id), 'dismissed', 'dropped automatically本身不可以被關掉')
  })

  test('cleanup undo <id> 也一樣：指名的那一份不可以在同一個指令裡被作廢', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    const id = planFor(s, ['a.zip'])
    backdatePlan(s, id, 2 * 3600_000)
    const r = s.run(['cleanup', 'undo', id])
    assert.doesNotMatch(r.out, /was dropped/, `undo 之前的收尾把它作廢了：\n${r.out}`)
    assert.match(r.out, /was never applied/, `was never applied的計畫，undo 要叫人去 release：\n${r.out}`)
    assert.equal(planStatus(s, id), 'proposed', r.out)
  })
})

// ═══ R3-9 ・ 唯讀模式不可以自動收尾 ═══════════════════════════════

describe('R3-9 唯讀模式與 doctor', () => {
  test('唯讀的 cleanup list 不可以作廢使用者的計畫', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    const id = planFor(s, ['a.zip'])
    backdatePlan(s, id, 2 * 3600_000)
    const before = releases(s)
    const r = s.run(['cleanup', 'list'], { CONTEXTBOX_READONLY: '1' })
    assert.equal(r.code, 0, r.out)
    assert.equal(planStatus(s, id), 'proposed', `Read-only mode把計畫作廢了：\n${r.out}`)
    assert.equal(releases(s), before, 'Read-only mode寫了 cleanup_plan_releases')
  })

  test('唯讀的 doctor 什麼都不改，而且講一句「不會自動收尾」', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    const id = planFor(s, ['a.zip'])
    backdatePlan(s, id, 2 * 3600_000)
    const r = s.run(['doctor'], { CONTEXTBOX_READONLY: '1' })
    assert.equal(planStatus(s, id), 'proposed', `Read-only的 doctor 改了資料庫：\n${r.out}`)
    assert.match(r.out, /does not tidy up/, `Read-only mode要講清楚它不收尾：\n${r.out}`)
  })

  test('唯讀模式也不可以跑 recoverInterrupted（它會改 journal）', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    const id = planFor(s, ['a.zip'])
    assert.equal(s.run(['cleanup', 'apply', id]).code, 0)
    const d0 = new DatabaseSync(s.p.db)
    try {
      d0.exec('PRAGMA busy_timeout = 8000')
      d0.prepare(`UPDATE cleanup_journal SET status='started' WHERE op='quarantine'`).run()
    } finally { d0.close() }
    assert.equal(s.run(['cleanup', 'quarantine'], { CONTEXTBOX_READONLY: '1' }).code, 0)
    assert.equal(one(s, `SELECT status FROM cleanup_journal WHERE op='quarantine'`)?.status, 'started',
      'Read-only mode改了 journal')
    // 對照：非唯讀照舊收得掉
    assert.equal(s.run(['cleanup', 'quarantine']).code, 0)
    assert.equal(one(s, `SELECT status FROM cleanup_journal WHERE op='quarantine'`)?.status, 'done',
      '非Read-only的收尾不可以跟著被關掉')
  })

  test('對照：非唯讀的 doctor 不講那句話', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    const r = s.run(['doctor'])
    assert.doesNotMatch(r.out, /does not tidy up/, r.out)
  })
})

// ═══ R3-11 ・ 收不動的 journal 列不可以讓每一個指令都去拿鎖 ═══════════

/**
 * 造一列「這次收不動」的 started：搬完之後把 journal 改回 started，
 * 再把隔離區那個資料夾設成讀不到 —— 指紋算不出來，recoverMove 兩個分支都不成立
 * （**故意不用「指紋對不上」**：R3-4 之後那一種會被結成 done，不再是收不動的例子），
 * recoverInterrupted 每次都 {recovered:0}。
 */
function stuckRow(t, s) {
  if (process.getuid?.() === 0) { t.skip('root 不受 chmod 限制'); return null }
  const id = planFor(s, ['a.zip'])
  assert.equal(s.run(['cleanup', 'apply', id]).code, 0, '前提：先搬進隔離區')
  const row = one(s, `SELECT seq, to_path FROM cleanup_journal WHERE op='quarantine'`)
  assert.ok(row?.to_path && existsSync(row.to_path), '前提：隔離區那份找得到')
  const d = new DatabaseSync(s.p.db)
  try {
    d.exec('PRAGMA busy_timeout = 8000')
    d.prepare(`UPDATE cleanup_journal SET status='started' WHERE seq=?`).run(row.seq)
  } finally { d.close() }
  // 讀不到那個檔（不是改資料夾權限：資料夾設成 000 的話，測試收尾的 rmSync 會刪不掉沙盒）
  chmodSync(row.to_path, 0o000)
  return { ...row, unlock: () => chmodSync(row.to_path, 0o600) }
}

describe('R3-11 needsSettling 要記得「這一列這次收不動」', () => {
  test('第一次會拿鎖試著收；同一列第二次不再拿鎖', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    const row = stuckRow(t, s)

    plantStaleLock(s)
    assert.equal(s.run(['cleanup', 'list']).code, 0)
    assert.equal(lockTaken(s), true, '前提：第一次真的去拿了清理鎖')
    assert.equal(one(s, 'SELECT status FROM cleanup_journal WHERE seq=?', row.seq)?.status, 'started',
      '前提：這一列真的收不動')

    plantStaleLock(s)
    assert.equal(s.run(['cleanup', 'list']).code, 0)
    assert.equal(lockTaken(s), false,
      '同一列收不動，第二次還去拿鎖、重算指紋 —— 「沒事就不拿鎖」形同失效')

    plantStaleLock(s)
    assert.equal(s.run(['cleanup', 'quarantine']).code, 0)
    assert.equal(lockTaken(s), false, '換一個指令也一樣，不可以再試')
    row.unlock()
  })

  test('隔離區那份變動了就要再試一次（它可能又收得動了）', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    const row = stuckRow(t, s)
    assert.equal(s.run(['cleanup', 'list']).code, 0)
    plantStaleLock(s)
    assert.equal(s.run(['cleanup', 'list']).code, 0)
    assert.equal(lockTaken(s), false, '前提：第二次沒拿鎖')

    row.unlock()                          // 讀得到了：這一列可能又收得動
    appendFileSync(row.to_path, '又變了')
    plantStaleLock(s)
    assert.equal(s.run(['cleanup', 'list']).code, 0)
    assert.equal(lockTaken(s), true, '檔案變動之後要再試一次')
  })

  test('對照：一收就收得掉的列，下一次本來就沒有東西要收尾（照舊不拿鎖）', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    const id = planFor(s, ['a.zip'])
    assert.equal(s.run(['cleanup', 'apply', id]).code, 0)
    const d = new DatabaseSync(s.p.db)
    try {
      d.exec('PRAGMA busy_timeout = 8000')
      d.prepare(`UPDATE cleanup_journal SET status='started' WHERE op='quarantine'`).run()
    } finally { d.close() }
    plantStaleLock(s)
    assert.equal(s.run(['cleanup', 'list']).code, 0)
    assert.equal(lockTaken(s), true, '收得掉的要收')
    assert.equal(one(s, `SELECT status FROM cleanup_journal WHERE op='quarantine'`)?.status, 'done')
    plantStaleLock(s)
    assert.equal(s.run(['cleanup', 'list']).code, 0)
    assert.equal(lockTaken(s), false, '收完了就沒有東西要收尾')
  })
})

// ═══ R3-12 ・ 掃描問題要走到寵物 ═══════════════════════════════════

describe('R3-12 掃描問題不可以只走到 doctor', () => {
  const base = over => ({
    ok: true, db: { ok: true }, watcher: { ok: true, watching: [], watchingCount: 1, rootsMissing: 0 },
    pendingCandidates: 0, lastError: null, scanProblems: [], ...over,
  })

  test('清理資料夾不見了：寵物要擔心，訊息講得出是資料夾的事', () => {
    const s = routes.petState(base({
      watcher: { ok: false, watching: [], watchingCount: 1, rootsMissing: 1, why: '有Watch資料夾不存在' },
      scanProblems: ['掃描資料夾「Downloads」不存在，這次沒有掃。'],
    }), { proposedPlans: 0, activeQuarantine: 0 })
    assert.equal(s.state, 'worried', '清理資料夾不見了，寵物照樣說「沒事，在發呆」')
    assert.notEqual(s.message, '沒事，在發呆。')
    assert.match(s.message, /folder/, s.message)
  })

  test('訊息不可以有絕對路徑', () => {
    const s = routes.petState(base({
      watcher: { ok: false, watching: [], watchingCount: 1, rootsMissing: 1 },
      scanProblems: ['讀不到「/home/someone/Downloads/秘密」，這次沒有掃。'],
    }), { proposedPlans: 0, activeQuarantine: 0 })
    assert.doesNotMatch(s.message, /\/home\//, s.message)
    assert.doesNotMatch(s.message, /秘密/, s.message)
  })

  test('掃描回報過問題（資料夾還在）也要擔心', () => {
    const s = routes.petState(base({ scanProblems: ['有 3 個檔讀不到，這次跳過。'] }),
      { proposedPlans: 0, activeQuarantine: 0 })
    assert.equal(s.state, 'worried')
  })

  test('對照：沒有掃描問題、資料夾都在 → 照舊', () => {
    assert.equal(routes.petState(base({}), { proposedPlans: 0, activeQuarantine: 0 }).state, 'watching')
    assert.equal(routes.petState(base({ watcher: { ok: false, rootsMissing: 0 } }),
      { proposedPlans: 0, activeQuarantine: 0 }).state, 'idle')
    assert.equal(routes.petState(base({ pendingCandidates: 3 }),
      { proposedPlans: 0, activeQuarantine: 0 }).state, 'found')
  })

  test('GET /pet/state 帶得出掃描問題（面板才看得到）', t => {
    const f = coreBox(t)
    routes.recordScanProblems(f.db, ['掃描資料夾「Downloads」不存在，這次沒有掃。'])
    const r = call(f, 'GET', '/pet/state')
    assert.equal(r.code, 200)
    assert.deepEqual(r.body.scanProblems, ['掃描資料夾「Downloads」不存在，這次沒有掃。'],
      '面板拿不到Scan issues，就永遠只能看 doctor')
    assert.equal(r.body.state, 'worried')
  })
})

// ═══ docs/cli.md ・ 不可以引用已經刪掉的字串 ═══════════════════════

describe('docs/cli.md 引用的核心字串要真的存在', () => {
  test('「再套用一次這份計畫會把它接完」整棵樹都不可以再有（docs/cli.md 也算）', () => {
    const dead = '再套用一次這份計畫會把它接完'
    const hits = []
    const walk = d => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== '.git' && e.name !== 'node_modules') walk(p) }
        else if (/\.(ts|js|mjs|md|json|html)$/.test(e.name) && !e.name.endsWith('.test.mjs')
          && readFileSync(p, 'utf8').includes(dead)) hits.push(p.replace(REPO + '/', ''))
      }
    }
    walk(join(REPO, 'core'))
    walk(join(REPO, 'docs'))
    assert.deepEqual(hits, [], 'docs 引用了核心已經不會印的字串')
  })
})

// ═══ R3-2b ・ 面板（HTTP）那一條也一樣 ═══════════════════════════

describe('R3-2b 面板重送一份跑過的計畫', () => {
  test('POST /cleanup/plans/:id/apply 重送 partial 的計畫：不可以把還沒解決的套用錯清掉', t => {
    const f = coreBox(t)
    const put = (name, days = 60) => {
      const p = join(f.dl, name)
      writeFileSync(p, `獨一無二的內容：${name}`)
      const at = new Date(Date.now() - days * DAY)
      utimesSync(p, at, at)
      return p
    }
    put('a.zip'); const bad = put('b.zip')
    scanDownloads({ db: f.db, roots: [f.dl], maxBytes: MAX })
    const ids = f.db.prepare(
      `SELECT c.id FROM cleanup_candidates c JOIN file_items i ON i.id=c.item_id WHERE c.status='proposed'`).all().map(r => r.id)
    const plan = createPlan(f.db, { candidateIds: ids })
    rmSync(bad)                                         // 這一項會失敗 → 計畫落在 partial
    const first = call(f, 'POST', `/cleanup/plans/${plan.id}/apply`)
    assert.equal(first.code, 200, JSON.stringify(first.body))
    assert.equal(first.body.status, 'partial', `前提：計畫落在 partial（${first.body.status}）`)

    // 一個真的、還沒解決的套用錯（磁碟滿）
    routes.recordActionResult(f.db, 'apply', { status: 'error', error: '磁碟空間不足，沒有搬動任何檔案。' })
    const h0 = routes.healthSnapshot(f.db, { ...f.opts, full: true })
    assert.equal(routes.errorStillActive(h0), true, '前提')

    const again = call(f, 'POST', `/cleanup/plans/${plan.id}/apply`)
    assert.equal(again.code, 200)
    routes.invalidateQuarantineCache()
    const h = routes.healthSnapshot(f.db, { ...f.opts, full: true })
    assert.equal(routes.errorStillActive(h), true,
      '面板重送一份跑過的計畫（一個檔都沒動），把還沒解決的套用錯標成「好了」')
    assert.equal(h.lastOkByKind.apply, h0.lastOkByKind.apply, 'no-op 不可以把 apply 的成功時間往後推')
    assert.equal(h.lastError, h0.lastError, 'no-op 也不可以把 lastError 的時間往後推')
  })
})
