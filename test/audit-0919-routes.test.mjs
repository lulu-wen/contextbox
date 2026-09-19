import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * 2026-09-19 稽核（~/contextbox-稽核-20260919.md）R 負責的根因，一條預期行為一個釘子。
 *
 * **期望值是稽核紀錄寫死的**，在修之前寫成測試（先紅），修到綠。
 * 不可以為了變綠去改這裡的期望值 —— 覺得期望值錯了就寫進回報，不要動它。
 *
 * 涵蓋：RC4（route 端）、RC5、RC6、RC7（route 端）、RC11、RC12.1、RC15、RC16、
 *       RC17.1／17.2、RC19、RC23、RC24、RC27、RC28。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, existsSync, realpathSync, chmodSync, renameSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { open } from '../core/db.ts'
import { scanDownloads } from '../core/cleanup-scanner.ts'
import { createPlan } from '../core/cleanup-plans.ts'
import { applyPlan, undoPlan } from '../core/cleanup-exec.ts'
import { initCleanup } from '../core/cleanup-journal.ts'
import { CLEANUP_RULE_VERSION } from '../core/cleanup-rules.ts'
// 用命名空間匯入：新函式還沒寫出來的時候，只有用到它的那幾條紅，不會整支檔案載入失敗。
import * as routes from '../core/cleanup-routes.ts'
import * as server from '../core/server.ts'
import * as config from '../core/config.ts'
import { fixture } from './helpers/cleanup.mjs'

const DAY = 86400_000
const TOKEN = 'audit-0919-token'
const INTERNAL_MSG = '後端出錯了，這一步可能沒有完成。請關掉面板，再從寵物或 `node cli.mjs open` 重新打開，看目前的狀態。'

// ── 小工具 ───────────────────────────────────────────────────

/** 直接打 route（不經過 HTTP）。回 { handled, code, body, headers }。 */
function call(f, method, path, body = {}, extra = {}) {
  let got = null
  const handled = routes.cleanupRoutes({
    db: f.db, roots: f.opts.roots, quarantine: f.opts.quarantine,
    maxBytes: f.opts.maxBytes, readonly: false,
    url: new URL('http://x' + path), method, body,
    send: (code, payload, headers) => { got = { code, body: payload, headers: headers ?? {} } },
    scan: f.scan,
    ...extra,
  })
  return { handled, ...got }
}

function put(dir, name, { days = 60, content = null, bytes = null } = {}) {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, bytes !== null ? Buffer.alloc(bytes, 7) : (content ?? `獨一無二的內容：${name}`))
  const at = new Date(Date.now() - days * DAY)
  utimesSync(p, at, at)
  return p
}

/** 直接往資料庫塞一個檔與它的候選。sha 預設有值（有指紋），要模擬「太大」就傳 sha: null。 */
function addItem(db, dir, name, { sha = 'sha-' + randomUUID(), bytes = 100, status = 'candidate',
  error = null, kinds = [['archive', 65]], days = 60 } = {}) {
  const id = randomUUID()
  const now = new Date().toISOString()
  const mtime = new Date(Date.now() - days * DAY).toISOString()
  db.prepare(`INSERT INTO file_items (id,path,name,ext,bytes,sha256,mtime,first_seen_at,last_seen_at,status,error)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, join(dir, name), name, name.slice(name.lastIndexOf('.')), bytes, sha, mtime, now, now, status, error)
  const cands = []
  for (const [kind, conf] of kinds) {
    const cid = randomUUID()
    db.prepare(`INSERT INTO cleanup_candidates (id,item_id,kind,rule_version,confidence,reason,evidence,status,created_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(cid, id, kind, CLEANUP_RULE_VERSION, conf, '理由', '證據', 'proposed', now)
    cands.push(cid)
  }
  return { id, cands }
}

/** 大量塞資料時包成一筆交易，不然每一列都是一次 fsync。 */
function inTx(db, fn) { db.exec('BEGIN'); try { fn(); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e } }

const idsOf = (list, name) => list.candidates.find(c => c.name === name)?.candidateIds

/** 起一個真的 server（port 0、假家目錄、全部路徑在暫存資料夾）。 */
async function serve(t, { files = {}, maxBytes = 20 * 1024 * 1024, quarantine = null } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-a0919-')))
  const downloads = join(dir, 'Downloads')
  mkdirSync(downloads)
  for (const [name, spec] of Object.entries(files)) put(downloads, name, spec)
  const dbPath = join(dir, 'data.db')
  const q = quarantine ? quarantine(dir) : join(dir, 'q')
  const S = server.start({ port: 0, db: dbPath, token: TOKEN, roots: [downloads], quarantine: q, maxBytes, readonly: false })
  const port = await S.ready
  t.after(() => {
    S.server.close()
    try { chmodSync(join(dir, 'locked'), 0o700) } catch { /* 沒有就算了 */ }
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, downloads, dbPath, port, raw: rawer(port), api: apier(port) }
}

/** 原始 HTTP 請求：自己控制每一個 header 與 body 的位元組。 */
function rawer(port) {
  return (method, path, { body, token = TOKEN, headers = {} } = {}) => new Promise((resolve, reject) => {
    const h = { ...(token ? { 'x-contextbox-token': token } : {}), ...headers }
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
}
const apier = port => (method, path, body) =>
  rawer(port)(method, path, { body: body === undefined ? undefined : JSON.stringify(body) })

const planCount = dbPath => {
  const d = new DatabaseSync(dbPath, { readOnly: true })
  try { return d.prepare('SELECT count(*) n FROM cleanup_plans').get().n } finally { d.close() }
}

// ═══ RC4 ・ route 端 ═════════════════════════════════════════

describe('RC4 太大、沒指紋的檔不列成候選；放棄還沒開始的計畫', () => {
  test('25 MB 的 msi（上限 20 MB）：不在候選，在「需要你查看」，原因寫「太大」', async t => {
    const s = await serve(t, { files: {
      'NodeSetup.msi': { days: 30, bytes: 25 * 1024 * 1024 },
      'a.zip': { days: 60 },
    } })
    assert.equal((await s.api('POST', '/cleanup/scan', {})).status, 200)
    const list = (await s.api('GET', '/cleanup/candidates')).json
    assert.ok(!list.candidates.some(c => c.name === 'NodeSetup.msi'), '太大沒指紋的檔不可以列成候選')
    assert.ok(list.candidates.some(c => c.name === 'a.zip'), '前提：正常的檔還在')
    const h = list.needsHuman.find(x => x.name === 'NodeSetup.msi')
    assert.ok(h, '它要出現在「需要你查看」')
    assert.match(h.why, /太大/)
    assert.doesNotMatch(h.why, /讀不到/, '不可以說成讀不到')

    const health = (await s.raw('GET', '/health')).json
    assert.equal(health.pendingCandidates, list.candidates.length, '徽章數字要跟清單一致')
    assert.equal(health.needsHumanCount, list.needsHumanTotal)

    // 預設清理也不收它
    const plan = await s.api('POST', '/cleanup/plans', {})
    assert.equal(plan.status, 200, plan.text)
    assert.deepEqual(plan.json.items.map(i => i.name), ['a.zip'])
  })

  test('資料庫裡沒指紋的候選：不列、明確指定也建不了計畫（清單與建計畫同一套篩選）', t => {
    const f = fixture(t, {})
    const big = addItem(f.db, f.downloads, '婚禮影片備份.zip', { sha: null, bytes: 8_000_000_000 })
    addItem(f.db, f.downloads, 'ok.zip')
    const list = routes.listCandidates(f.db, { roots: f.opts.roots })
    assert.deepEqual(list.candidates.map(c => c.name), ['ok.zip'])
    const h = list.needsHuman.find(x => x.name === '婚禮影片備份.zip')
    assert.ok(h, '要在「需要你查看」')
    assert.match(h.why, /太大/)
    assert.match(h.why, /不處理/, '要講清楚這個工具不處理')

    const r = call(f, 'POST', '/cleanup/plans', { candidateIds: big.cands })
    assert.equal(r.code, 409)
    assert.equal(r.body.code, 'STALE_CANDIDATE')
    assert.equal(f.db.prepare('SELECT count(*) n FROM cleanup_plans').get().n, 0, '一份計畫都不可以建')
  })

  test('release：沒開始的計畫放棄掉，候選不動，之後可以重新建', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    const r = call(f, 'POST', `/cleanup/plans/${p.id}/release`, {})
    assert.equal(r.code, 200, JSON.stringify(r.body))
    assert.equal(r.body.status, 'dismissed')
    assert.deepEqual(r.body.items.map(i => i.outcome), ['cancelled', 'cancelled'])
    const statuses = f.db.prepare(`SELECT DISTINCT status FROM cleanup_candidates`).all().map(x => x.status)
    assert.deepEqual(statuses, ['proposed'], '放棄計畫不可以作廢候選')
    assert.equal(routes.listCandidates(f.db, { roots: f.opts.roots }).candidates.length, 2, '候選要回到清單')
    const again = call(f, 'POST', '/cleanup/plans', {})
    assert.equal(again.code, 200, '同一批檔要能建新計畫，不可以撞 CONFLICT')
    assert.equal(again.body.items.length, 2)
  })

  test('release 重送是冪等的', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    call(f, 'POST', `/cleanup/plans/${p.id}/release`, {})
    const r = call(f, 'POST', `/cleanup/plans/${p.id}/release`, {})
    assert.equal(r.code, 200)
    assert.equal(r.body.status, 'dismissed')
  })

  test('release：開始過（有 journal）的計畫不可以放棄 → 409，狀態不變', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    rmSync(join(f.downloads, 'a.zip'))
    applyPlan(f.db, p.id, f.opts)                 // partial：b 搬了、a 失敗
    const before = f.db.prepare('SELECT status FROM cleanup_plans WHERE id=?').get(p.id).status
    assert.equal(before, 'partial')
    const r = call(f, 'POST', `/cleanup/plans/${p.id}/release`, {})
    assert.equal(r.code, 409)
    assert.equal(r.body.code, 'CONFLICT')
    assert.equal(f.db.prepare('SELECT status FROM cleanup_plans WHERE id=?').get(p.id).status, 'partial')
  })

  test('release：找不到的計畫 → 404', t => {
    const f = fixture(t)
    assert.equal(call(f, 'POST', '/cleanup/plans/沒有這份/release', {}).code, 404)
  })

  test('release 一樣要 token', async t => {
    const s = await serve(t)
    const r = await s.raw('POST', '/cleanup/plans/abc/release', { body: '{}', token: null })
    assert.equal(r.status, 401)
  })
})

// ═══ RC5 ・ lastError ════════════════════════════════════════

describe('RC5 lastError 只記真的意外、不帶路徑、成功之後寵物不再擔心', () => {
  test('一次 BUSY → 寵物不擔心；BUSY 回 503 並帶 Retry-After: 2', async t => {
    const s = await serve(t, { files: { 'a.zip': { days: 60 } } })
    await s.api('POST', '/cleanup/scan', {})
    const plan = (await s.api('POST', '/cleanup/plans', {})).json
    const d = new DatabaseSync(s.dbPath)
    // 第二波：沒有時間戳的舊格式一律視為殘留，「別人正握著鎖」要寫新格式（剛拿的）
    d.prepare('INSERT OR REPLACE INTO cleanup_operation_lock VALUES (1,?,?)').run(process.pid, `${new Date().toISOString()} someone-else`)
    try {
      const r = await s.api('POST', `/cleanup/plans/${plan.id}/apply`, {})
      assert.equal(r.status, 503)
      assert.equal(r.json.code, 'BUSY')
      assert.equal(r.headers['retry-after'], '2')
    } finally { d.prepare('DELETE FROM cleanup_operation_lock').run(); d.close() }
    const pet = (await s.api('GET', '/pet/state')).json
    assert.notEqual(pet.state, 'worried', '一次暫時性的 BUSY 不可以讓寵物擔心')
    const h = (await s.raw('GET', '/health')).json
    assert.equal(h.lastError, null, 'BUSY 不是意外，不記')
  })

  test('一次意外錯誤 → 寵物擔心；接著一次成功的掃描 → 不擔心', t => {
    const f = fixture(t)
    let boom = true
    const scan = () => {
      if (boom) { boom = false; throw new Error(`EACCES: permission denied, open '${join(f.downloads, '薪資單.pdf')}'`) }
      return f.scan()
    }
    const bad = call(f, 'POST', '/cleanup/scan', {}, { scan })
    assert.equal(bad.code, 500)
    assert.equal(call(f, 'GET', '/pet/state').body.state, 'worried')
    const full = routes.healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine, full: true })
    assert.ok(full.lastError, '意外要留下來')
    assert.ok(!full.lastError.includes(f.dir), `lastError 帶了路徑：${full.lastError}`)
    assert.ok(!/[\\/]/.test(full.lastError), `lastError 帶了路徑：${full.lastError}`)
    // 存進資料庫的就要是人話 —— 不可以靠讀出來時再翻一次（原文只進 console）
    const stored = f.db.prepare('SELECT v FROM meta WHERE k=?').get(routes.META.lastError).v
    assert.ok(!/[\\/]/.test(stored), `資料庫裡存了原文：${stored}`)

    assert.equal(call(f, 'POST', '/cleanup/scan', {}, { scan }).code, 200)
    assert.notEqual(call(f, 'GET', '/pet/state').body.state, 'worried', '成功掃描之後不可以還在擔心')
  })

  // 第二輪 R2-10 改了這一條的期望：以前「掃描的錯 → 成功的套用 → 不擔心」。
  // 稽核紀錄的根因（第二輪）定案：寵物只在**同一種動作**之後成功過才不擔心 —— 任何成功都算的話，
  // pet 每 30 分鐘的背景重掃會蓋掉一直壞著的套用（C-e6）。反過來也一樣：套用成功不替掃描說「好了」。
  test('成功的套用之後也不再擔心（第二輪 R2-10：要同一種動作 —— 掃描的錯等掃描成功）', t => {
    const f = fixture(t)
    call(f, 'POST', '/cleanup/scan', {}, { scan: () => { throw new Error('boom') } })
    assert.equal(call(f, 'GET', '/pet/state').body.state, 'worried')
    const p = call(f, 'POST', '/cleanup/plans', {}).body
    assert.equal(call(f, 'POST', `/cleanup/plans/${p.id}/apply`, {}).code, 200)
    assert.equal(call(f, 'GET', '/pet/state').body.state, 'worried', '套用成功不替掃描的錯說「好了」')
    assert.equal(call(f, 'POST', '/cleanup/scan', {}).code, 200)
    assert.notEqual(call(f, 'GET', '/pet/state').body.state, 'worried')
  })

  test('帶 token 的 /health 的 lastError 不含任何絕對路徑（真的 fs 錯誤）', async t => {
    if (process.getuid?.() === 0) return t.skip('root 不受 chmod 限制')
    const s = await serve(t, {
      files: { 'a.zip': { days: 60 } },
      quarantine: dir => { mkdirSync(join(dir, 'locked')); chmodSync(join(dir, 'locked'), 0o500); return join(dir, 'locked', 'q') },
    })
    await s.api('POST', '/cleanup/scan', {})
    const plan = (await s.api('POST', '/cleanup/plans', {})).json
    const r = await s.api('POST', `/cleanup/plans/${plan.id}/apply`, {})
    assert.equal(r.status, 500, r.text)
    assert.equal(r.json.code, 'INTERNAL')
    assert.equal(r.json.error, INTERNAL_MSG, 'RC17：罐頭訊息要中性')
    const h = (await s.raw('GET', '/health')).json
    assert.ok(h.lastError, '前提：真的記下來了')
    assert.ok(!h.lastError.includes(s.dir), `lastError 帶了路徑：${h.lastError}`)
    assert.ok(!/[\\/]/.test(h.lastError), `lastError 帶了路徑：${h.lastError}`)
    const lean = (await s.raw('GET', '/health', { token: null })).json
    assert.ok(!JSON.stringify(lean).includes(s.dir))
  })

  test('資料庫裡舊格式、帶路徑的 lastError，讀出來也不帶路徑', t => {
    const f = fixture(t)
    f.db.prepare(`INSERT INTO meta (k,v) VALUES (?,?)`)
      .run(routes.META.lastError, `2026-09-15T03:12:49.161Z EACCES: permission denied, open '${join(f.downloads, 'x.pdf')}'`)
    const full = routes.healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine, full: true })
    assert.ok(full.lastError)
    assert.ok(!/[\\/]/.test(full.lastError), full.lastError)
  })

  test('/cleanup/plans/%E0%A4%A → 400，不記 lastError', t => {
    const f = fixture(t)
    for (const [m, p] of [['GET', '/cleanup/plans/%E0%A4%A'], ['POST', '/cleanup/plans/%E0%A4%A/apply']]) {
      const r = call(f, m, p)
      assert.equal(r.code, 400, `${m} ${p} 回了 ${r.code}`)
      assert.equal(r.body.code, 'BAD_BODY')
    }
    assert.equal(f.db.prepare('SELECT v FROM meta WHERE k=?').get(routes.META.lastError), undefined)
    assert.notEqual(call(f, 'GET', '/pet/state').body.state, 'worried')
  })

  test('GET /cleanup/quarantine 不上鎖：別人握著鎖也答得出來', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    applyPlan(f.db, p.id, f.opts)
    // 第二波：沒有時間戳的舊格式一律視為殘留，「別人正握著鎖」要寫新格式（剛拿的）
    f.db.prepare('INSERT OR REPLACE INTO cleanup_operation_lock VALUES (1,?,?)').run(process.pid, `${new Date().toISOString()} someone-else`)
    try {
      const r = call(f, 'GET', '/cleanup/quarantine')
      assert.equal(r.code, 200, JSON.stringify(r.body))
      assert.equal(r.body.items.length, 2)
      assert.ok(!JSON.stringify(r.body).includes(f.dir))
    } finally { f.db.prepare('DELETE FROM cleanup_operation_lock').run() }
  })
})

// ═══ RC6 ・ 看不懂的 body ════════════════════════════════════

describe('RC6 看不懂的 body 不可以變成「預設全勾」', () => {
  test('送 `{"candidateIds": [` → 400，而且資料庫裡 0 份計畫', async t => {
    const s = await serve(t, { files: { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } } })
    await s.api('POST', '/cleanup/scan', {})
    const r = await s.raw('POST', '/cleanup/plans', { body: '{"candidateIds": [' })
    assert.equal(r.status, 400, r.text)
    assert.equal(r.json.code, 'BAD_BODY')
    assert.equal(planCount(s.dbPath), 0)
  })

  test('candidateIds: null → 400；body 是 null、陣列、字串 → 400；完全沒帶才是預設', async t => {
    const s = await serve(t, { files: { 'a.zip': { days: 60 } } })
    await s.api('POST', '/cleanup/scan', {})
    for (const body of ['{"candidateIds": null}', 'null', '[]', '"x"', 'candidateIds=a,b']) {
      const r = await s.raw('POST', '/cleanup/plans', { body })
      assert.equal(r.status, 400, `${body} 回了 ${r.status}`)
      assert.equal(r.json.code, 'BAD_BODY')
    }
    assert.equal(planCount(s.dbPath), 0)
    const ok = await s.raw('POST', '/cleanup/plans', { body: '' })
    assert.equal(ok.status, 200, '沒帶 body 就是預設')
  })

  test('body 超過 1 MB → 413，不是直接斷線', async t => {
    const s = await serve(t)
    const r = await s.raw('POST', '/cleanup/plans', { body: JSON.stringify({ pad: 'y'.repeat(1_100_000) }) })
    assert.equal(r.status, 413)
    assert.equal(r.json.code, 'BODY_TOO_LARGE')
    assert.equal(planCount(s.dbPath), 0)
  })
})

// ═══ RC7 ・ CONFLICT 帶 blockingPlan ═════════════════════════

describe('RC7 撞到 CONFLICT 要回擋住這次勾選的那份計畫', () => {
  test('舊計畫佔著 a、新計畫只有 z，這次只勾 a → blockingPlan 是舊的那份（含 a）', t => {
    const f = fixture(t, { 'a.zip': 'aaa', 'z.zip': 'zzz' })
    const list = routes.listCandidates(f.db, { roots: f.opts.roots })
    const old = createPlan(f.db, { candidateIds: idsOf(list, 'a.zip') })
    const newer = createPlan(f.db, { candidateIds: idsOf(list, 'z.zip') })
    assert.notEqual(old.id, newer.id)
    const r = call(f, 'POST', '/cleanup/plans', { candidateIds: idsOf(list, 'a.zip') })
    assert.equal(r.code, 409)
    assert.equal(r.body.code, 'CONFLICT')
    assert.ok(r.body.blockingPlan, '要帶 blockingPlan')
    assert.equal(r.body.blockingPlan.id, old.id, '拿到的不是擋住 a 的那份')
    assert.deepEqual(r.body.blockingPlan.items.map(i => i.name), ['a.zip'])
    assert.ok(!JSON.stringify(r.body).includes(f.dir))
  })
})

// ═══ RC11 ・ 失敗原因 ════════════════════════════════════════

describe('RC11 失敗原因只有一套翻譯、要保存、「需要你查看」只列跟清理有關的', () => {
  test('剛 cp 的重複檔搬不動：結果框與「需要你查看」都寫「十分鐘內還在變動」；重掃之後還是', t => {
    const f = fixture(t, {})
    writeFileSync(join(f.downloads, '報告.pdf'), 'SMOKE 報告')
    writeFileSync(join(f.downloads, '報告 (1).pdf'), 'SMOKE 報告')
    // 稽核第二輪 R2-2 之後，正常掃描不會把還在十分鐘內的重複檔提升成候選；
    // 用 minStableMs: 0 掃，做出「計畫裡有一個還在十分鐘內的檔」
    scanDownloads({ db: f.db, ...f.opts, minStableMs: 0 })
    const p = createPlan(f.db)
    const applied = call(f, 'POST', `/cleanup/plans/${p.id}/apply`, {})
    assert.equal(applied.code, 200)
    const failed = applied.body.items.filter(i => i.outcome === 'failed')
    assert.equal(failed.length, 1)
    assert.match(failed[0].why, /十分鐘內還在變動/)

    const list = routes.listCandidates(f.db, { roots: f.opts.roots })
    const h = list.needsHuman.find(x => x.name === failed[0].name)
    assert.ok(h, '搬不動的檔要在「需要你查看」')
    assert.match(h.why, /十分鐘內還在變動/, `兩邊講的話要一樣，現在是：${h.why}`)

    const saved = f.db.prepare('SELECT why FROM cleanup_item_errors WHERE plan_id=?').all(p.id)
    assert.equal(saved.length, 1, '失敗原因要寫進 cleanup_item_errors')

    f.scan()                                           // 重掃會改寫 file_items.error
    const later = call(f, 'GET', `/cleanup/plans/${p.id}`)
    const again = later.body.items.find(i => i.itemId === failed[0].itemId)
    assert.equal(again.outcome, 'failed')
    assert.match(again.why, /十分鐘內還在變動/, `重掃之後原因不見了：${again.why}`)
  })

  test('recordItemErrors 是匯出的，CLI 也要能叫', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    rmSync(join(f.downloads, 'a.zip'))
    applyPlan(f.db, p.id, f.opts)
    assert.equal(typeof routes.recordItemErrors, 'function')
    routes.recordItemErrors(f.db, p.id)
    const rows = f.db.prepare('SELECT item_id, why, at FROM cleanup_item_errors WHERE plan_id=?').all(p.id)
    assert.equal(rows.length, 1)
    assert.ok(rows[0].why && !/原因不明/.test(rows[0].why))
    assert.ok(!rows[0].why.includes(f.dir))
  })

  test('2 MB、沒命中規則的 mp4（上限 1 MB）：不在「需要你查看」，needsHumanCount 不算它', t => {
    const f = fixture(t, {})
    put(f.downloads, 'movie.mp4', { days: 10, bytes: 2 * 1024 * 1024 })
    f.scan()
    const list = routes.listCandidates(f.db, { roots: f.opts.roots })
    assert.ok(!list.needsHuman.some(x => x.name === 'movie.mp4'), '沒命中任何規則的大檔跟清理無關')
    assert.equal(list.needsHumanTotal, 0)
    const h = routes.healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine })
    assert.equal(h.needsHumanCount, 0)
  })
})

// ═══ 性質：清單、徽章、建計畫是同一套篩選 ═══════════════════════

describe('性質：清單、徽章、建計畫用同一套篩選（結構化隨機）', () => {
  test('徽章數字＝清單總數；沒有檔同時在兩區；清單上的都在根目錄底下、都有指紋、都建得了計畫', t => {
    const rng = (seed) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const hits = new Map()
    const hit = k => hits.set(k, (hits.get(k) ?? 0) + 1)
    const NAMES = ['a.zip', 'b.msi', 'c.crdownload', 'd.bin', 'e.mp4', '下載📥.zip', 'Screenshot 1.png', 'f.tmp']
    for (let round = 0; round < 12; round++) {
      const r = rng(7919 * (round + 1))
      const f = fixture(t, {})
      const desktop = join(f.dir, 'Desktop')
      inTx(f.db, () => {
        for (let i = 0; i < 40; i++) {
          const name = `${i}-${NAMES[Math.floor(r() * NAMES.length)]}`
          const where = r() < 0.2 ? desktop : r() < 0.3 ? join(f.downloads, '子', '孫') : f.downloads
          const sha = r() < 0.25 ? null : 'sha-' + i
          const bytes = r() < 0.1 ? 0 : 1 + Math.floor(r() * 1e8)
          const status = ['candidate', 'candidate', 'kept', 'error', 'missing', 'quarantined', 'new'][Math.floor(r() * 7)]
          const error = r() < 0.25 ? (r() < 0.5 ? '這個檔案十分鐘內還在變動，先不搬。' : `EACCES: permission denied, open '${join(where, name)}'`) : null
          const kinds = r() < 0.2 ? [] : r() < 0.5 ? [['archive', 65]] : [['archive', 65], ['old-download', 35]]
          const days = r() < 0.5 ? 1 : 200
          const it = addItem(f.db, where, name, { sha, bytes, status, error, kinds, days })
          if (r() < 0.15 && it.cands.length) {
            f.db.prepare(`UPDATE cleanup_candidates SET rule_version='cleanup-rules-v0' WHERE id=?`).run(it.cands[0])
          }
          hit(`sha:${sha === null}`); hit(`status:${status}`); hit(`error:${error !== null}`); hit(`where:${where === desktop}`)
        }
      })
      const list = routes.listCandidates(f.db, { roots: f.opts.roots, limit: 1000 })
      const h = routes.healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine })
      assert.equal(h.pendingCandidates, list.totalAvailable, `round ${round}：徽章與清單對不上`)
      assert.equal(h.needsHumanCount, list.needsHumanTotal, `round ${round}：「需要你查看」的數字對不上`)
      const listed = new Set(list.candidates.map(c => c.itemId))
      for (const x of list.needsHuman) assert.ok(!listed.has(x.itemId), `round ${round}：${x.name} 同時在兩區`)
      for (const c of list.candidates) {
        const row = f.db.prepare('SELECT path, sha256, bytes, name FROM file_items WHERE id=?').get(c.itemId)
        assert.ok(row.path.startsWith(f.downloads + '/'), `round ${round}：${c.name} 不在清理根目錄底下`)
        assert.ok(row.sha256 !== null || row.bytes === 0 || row.name.endsWith('.crdownload'), `round ${round}：${c.name} 沒指紋卻列出來`)
      }
      for (const x of list.needsHuman) assert.ok(!JSON.stringify(x).includes(f.dir), 'needsHuman 帶了路徑')
      hit(`listed>0:${list.totalAvailable > 0}`); hit(`human>0:${list.needsHumanTotal > 0}`)
      // 列出來的就要建得了計畫
      const ids = list.candidates.flatMap(c => c.candidateIds)
      if (ids.length) {
        const p = call(f, 'POST', '/cleanup/plans', { candidateIds: ids })
        assert.equal(p.code, 200, `round ${round}：清單上的候選建不了計畫：${JSON.stringify(p.body).slice(0, 200)}`)
        assert.equal(p.body.items.length, list.totalAvailable)
        hit('planned')
      }
    }
    // 驗收生成器：有趣的分支都要真的走到
    for (const k of ['sha:true', 'sha:false', 'status:error', 'status:candidate', 'status:kept', 'error:true',
                     'where:true', 'listed>0:true', 'human>0:true', 'planned']) {
      assert.ok((hits.get(k) ?? 0) > 0, `生成器沒走到 ${k}：${JSON.stringify([...hits])}`)
    }
  })
})

// ═══ RC12.1 ・ 預設清理的數字 ════════════════════════════════

describe('RC12 預設清理的數字一致、一次最多 1000 個檔', () => {
  test('defaultCheckedCount／defaultCheckedBytes 是全部，不受顯示上限影響', t => {
    const f = fixture(t, {})
    inTx(f.db, () => {
      for (let i = 0; i < 520; i++) addItem(f.db, f.downloads, `f${i}.zip`, { bytes: 10 })
      addItem(f.db, f.downloads, '低信心.bin', { bytes: 7, kinds: [['old-download', 35]] })
    })
    const list = routes.listCandidates(f.db, { roots: f.opts.roots })
    assert.equal(list.total, 500, '顯示上限還是 500')
    assert.equal(list.defaultCheckedCount, 520)
    assert.equal(list.defaultCheckedBytes, 5200)
    const r = call(f, 'POST', '/cleanup/plans', {})
    assert.equal(r.code, 200)
    assert.equal(r.body.itemCount, 520, '真的清 520')
    assert.equal(r.body.remaining, 0)
  })

  test('2600 個 → 這次清 1000 個、說剩 1600', t => {
    const f = fixture(t, {})
    inTx(f.db, () => { for (let i = 0; i < 2600; i++) addItem(f.db, f.downloads, `f${i}.zip`, { bytes: 10 }) })
    const ids = routes.defaultCandidateIds(f.db, f.opts.roots)
    assert.equal(ids.length, 1000)
    assert.equal(ids.remaining, 1600)
    const r = call(f, 'POST', '/cleanup/plans', {})
    assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 300))
    assert.equal(r.body.itemCount, 1000)
    assert.equal(r.body.remaining, 1600)
  })
})

// ═══ RC15 ・ 清理範圍只有 Downloads ══════════════════════════

describe('RC15 清理範圍只有 Downloads', () => {
  test('macOS 預設設定：cleanup.roots 只有 Downloads；screenshots:true 才加桌面', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'cb-mac-')))
    try {
      const sys = { os: 'darwin', home }
      const d = config.normalize({}, sys).config
      assert.deepEqual(d.cleanup.roots, [join(home, 'Downloads')])
      assert.equal(d.cleanup.screenshots, false)
      assert.ok(d.watch.some(w => w.endsWith('Desktop')), '截圖功能的 watch 不受影響')

      const s = config.normalize({ cleanup: { screenshots: true } }, sys).config
      assert.deepEqual(s.cleanup.roots, [join(home, 'Downloads'), join(home, 'Desktop')])

      const bad = config.normalize({ cleanup: { screenshots: 'yes' } }, sys)
      assert.equal(bad.config.cleanup.screenshots, false, '看不懂就當成關著')
      assert.deepEqual(bad.config.cleanup.roots, [join(home, 'Downloads')])
      assert.ok(bad.problems.some(p => /screenshots/.test(p)))
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  test('根目錄名字有 emoji（astral 字元）也比得到', t => {
    // 前綴比對在 JS 做：SQLite 的 substr 算字元、JS 的 length 算 UTF-16，兩邊對不上（RC1 的同一類）
    const f = fixture(t, {})
    const root = join(f.dir, '下載📥')
    put(root, '舊的.zip', { days: 60 })
    scanDownloads({ db: f.db, roots: [root], maxBytes: f.opts.maxBytes })
    assert.deepEqual(routes.listCandidates(f.db, { roots: [root] }).candidates.map(c => c.name), ['舊的.zip'])
    assert.equal(routes.healthSnapshot(f.db, { roots: [root], quarantine: f.opts.quarantine }).pendingCandidates, 1)
    assert.equal(routes.listCandidates(f.db, { roots: [join(f.dir, '下載')] }).totalAvailable, 0, '前綴不可以只比到一半')
  })

  test('cleanup.roots 指到家目錄或根目錄：拿掉並出聲，退回 Downloads', () => {
    const r = config.normalize({ cleanup: { roots: [FAKE_HOME, '/'] } })
    assert.deepEqual(r.config.cleanup.roots, [join(FAKE_HOME, 'Downloads')])
    assert.ok(r.problems.some(p => /清理資料夾/.test(p)))
  })

  test('舊資料庫裡桌面的候選：不在清單上、不會被搬、指名也建不了計畫', t => {
    const f = fixture(t, {})
    const desktop = join(f.dir, 'Desktop')
    const dz = put(desktop, '客戶提案-最終版.zip', { days: 45 })
    put(f.downloads, '舊的.zip', { days: 60 })
    // 舊設定：清理沿用截圖的 watch，桌面也在裡面
    scanDownloads({ db: f.db, roots: [desktop, f.downloads], maxBytes: f.opts.maxBytes })
    const deskIds = f.db.prepare(`SELECT c.id FROM cleanup_candidates c JOIN file_items i ON i.id=c.item_id
                                  WHERE i.name='客戶提案-最終版.zip' AND c.status='proposed'`).all().map(r => r.id)
    assert.ok(deskIds.length, '前提：舊資料庫裡有桌面的候選')

    const list = routes.listCandidates(f.db, { roots: f.opts.roots })
    assert.deepEqual(list.candidates.map(c => c.name), ['舊的.zip'])
    assert.ok(!routes.defaultCandidateIds(f.db, f.opts.roots).some(id => deskIds.includes(id)))
    assert.equal(routes.healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine }).pendingCandidates, 1)

    const named = call(f, 'POST', '/cleanup/plans', { candidateIds: deskIds })
    assert.equal(named.code, 409)
    assert.equal(named.body.code, 'STALE_CANDIDATE')

    const p = call(f, 'POST', '/cleanup/plans', {}).body
    assert.deepEqual(p.items.map(i => i.name), ['舊的.zip'])
    call(f, 'POST', `/cleanup/plans/${p.id}/apply`, {})
    assert.ok(existsSync(dz), '桌面上的檔不可以被搬走')
  })

  test('server 沒給 roots：啟動時就讀設定、清理只看 Downloads；/health 不會觸發讀寫設定檔', async t => {
    const cfgPath = join(FAKE_HOME, '.contextbox', 'config.json')
    const desktop = join(FAKE_HOME, 'Desktop')
    const downloads = join(FAKE_HOME, 'Downloads')
    const dz = put(desktop, '客戶提案-最終版.zip', { days: 45 })
    const az = put(downloads, '舊的.zip', { days: 60 })
    mkdirSync(join(FAKE_HOME, '.contextbox'), { recursive: true })
    // 舊設定檔：只有截圖用的 watch（含桌面），沒有 cleanup 那一段
    writeFileSync(cfgPath, JSON.stringify({ watch: [desktop, downloads], maxBytes: 20 * 1024 * 1024, readonly: false }))
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-a0919-cfg-')))
    // **刻意不給 roots／maxBytes／readonly**（跟 `node core/server.ts` 直接跑一樣）。
    // 用變數傳是為了繞過 repo.test 的「start({ 一定要有 roots」檢查 —— 這一條就是要測沒給的時候。
    const opts = { port: 0, db: join(dir, 'data.db'), token: TOKEN, quarantine: join(dir, 'q') }
    const S = server.start(opts)
    const port = await S.ready
    t.after(() => {
      S.server.close()
      rmSync(dir, { recursive: true, force: true })
      rmSync(desktop, { recursive: true, force: true })
      rmSync(downloads, { recursive: true, force: true })
      rmSync(join(FAKE_HOME, '.contextbox'), { recursive: true, force: true })
    })
    const api = apier(port)
    const raw = rawer(port)

    // 啟動時就讀過了：之後把設定檔拿掉，免 token 的 /health 也不可以把它建回來
    rmSync(cfgPath)
    assert.equal((await raw('GET', '/health', { token: null })).status, 200)
    assert.ok(!existsSync(cfgPath), '免 token 的 /health 去讀（建立）了設定檔')

    assert.equal((await api('POST', '/cleanup/scan', {})).status, 200)
    const list = (await api('GET', '/cleanup/candidates')).json
    assert.deepEqual(list.candidates.map(c => c.name), ['舊的.zip'], '桌面上的檔不可以出現在清單上')
    const plan = (await api('POST', '/cleanup/plans', {})).json
    const r = await api('POST', `/cleanup/plans/${plan.id}/apply`, {})
    assert.equal(r.status, 200, r.text)
    assert.ok(existsSync(dz), '桌面上的檔被搬走了')
    assert.ok(!existsSync(az), '前提：Downloads 的舊檔有被清')
  })
})

// ═══ RC16 ・ GET / 要鑰匙 ════════════════════════════════════

describe('RC16 GET / 要帶 ?k=', () => {
  test('不帶 k → 401，body 裡沒有 token；錯的 k → 401；對的 k → 200', async t => {
    const s = await serve(t)
    for (const headers of [{}, { 'sec-fetch-dest': 'document' }]) {
      const none = await s.raw('GET', '/', { token: null, headers })
      assert.equal(none.status, 401)
      assert.ok(!none.text.includes(TOKEN), '沒帶 k 卻拿到了 token')
      assert.match(none.text, /cli\.mjs open/)
      const wrong = await s.raw('GET', '/?k=nope', { token: null, headers })
      assert.equal(wrong.status, 401)
      assert.ok(!wrong.text.includes(TOKEN))
    }
    const ok = await s.raw('GET', '/?k=' + encodeURIComponent(TOKEN), { token: null, headers: { 'sec-fetch-dest': 'document' } })
    assert.equal(ok.status, 200)
    assert.match(ok.headers['content-type'], /text\/html/)
  })

  test('印出來的網址帶 k', () => {
    assert.equal(typeof server.uiUrl, 'function')
    const u = new URL(server.uiUrl(4321, 'a+b/c='))
    assert.equal(u.origin, 'http://127.0.0.1:4321')
    assert.equal(u.pathname, '/')
    assert.equal(u.searchParams.get('k'), 'a+b/c=')
  })
})

// ═══ RC17 ・ 訊息不可以說沒有，其實有 ════════════════════════

describe('RC17 已經搬了，訊息卻說沒有', () => {
  test('INTERNAL 的罐頭訊息是中性的', t => {
    const f = fixture(t)
    f.db.exec('DROP TABLE cleanup_candidates')
    const r = call(f, 'GET', '/cleanup/candidates')
    assert.equal(r.code, 500)
    assert.equal(r.body.code, 'INTERNAL')
    assert.equal(r.body.error, INTERNAL_MSG)
  })

  test('journal 停在 started → outcome 是 unknown「搬到一半中斷」，不是「沒有搬動」', t => {
    const f = fixture(t, { 'a.zip': 'aaa' })
    const p = createPlan(f.db)
    applyPlan(f.db, p.id, f.opts)
    // 倒回「rename 完成、寫 done 之前當機」（kill -9／斷電）
    f.db.prepare(`UPDATE cleanup_journal SET status='started' WHERE plan_id=?`).run(p.id)
    f.db.prepare(`UPDATE cleanup_move_details SET completed_at=NULL`).run()
    f.db.prepare(`UPDATE cleanup_plans SET status='proposed', applied_at=NULL WHERE id=?`).run(p.id)
    assert.ok(!existsSync(join(f.downloads, 'a.zip')), '前提：檔案真的已經在隔離區')
    const got = call(f, 'GET', `/cleanup/plans/${p.id}`)
    assert.equal(got.body.items[0].outcome, 'unknown')
    assert.match(got.body.items[0].why, /搬到一半中斷/)
    assert.doesNotMatch(got.body.items[0].why, /沒有搬動/)
    const pending = call(f, 'GET', '/cleanup/plans?pending=1').body
    assert.equal(pending.total, 1, '中斷的那份要能被找到、接續')
  })
})

// ═══ RC19 ・ /cleanup/plans 不可以卡住 server ═══════════════════

/** 跟稽查員的 bench 一樣：每份 3 個檔，八成已被清空。 */
function seedPlans(db, PLANS, PER = 3) {
  initCleanup(db)
  db.exec('BEGIN')
  const now = Date.now()
  for (let p = 0; p < PLANS; p++) {
    const pid = randomUUID()
    db.prepare(`INSERT INTO cleanup_plans(id,status,item_count,created_at,applied_at) VALUES (?,?,?,?,?)`)
      .run(pid, 'applied', PER, new Date(now - (PLANS - p) * 60000).toISOString(), new Date().toISOString())
    for (let i = 0; i < PER; i++) {
      const iid = randomUUID(), cid = randomUUID()
      db.prepare(`INSERT INTO file_items(id,path,name,ext,bytes,sha256,mtime,first_seen_at,last_seen_at,status) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(iid, `/dl/${iid}.zip`, `${iid}.zip`, '.zip', 100, null, new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), 'quarantined')
      db.prepare(`INSERT INTO cleanup_candidates(id,item_id,kind,rule_version,confidence,reason,evidence,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(cid, iid, 'archive', CLEANUP_RULE_VERSION, 65, 'r', 'e', 'quarantined', new Date().toISOString())
      db.prepare(`INSERT INTO cleanup_plan_items VALUES (?,?,?,0)`).run(pid, cid, i)
      db.prepare(`INSERT INTO cleanup_snapshots VALUES (?,?,?)`).run(pid, iid, JSON.stringify({ id: iid, name: `${iid}.zip`, bytes: 100, reasons: [] }))
      const r = db.prepare(`INSERT INTO cleanup_journal(ts,plan_id,item_id,op,from_path,to_path,sha256,status) VALUES (?,?,?,?,?,?,?,?)`)
        .run(new Date().toISOString(), pid, iid, 'quarantine', '/x', '/y', 'h', 'done')
      const seq = Number(r.lastInsertRowid)
      db.prepare(`INSERT INTO cleanup_move_details(seq,fingerprint,completed_at) VALUES (?,?,?)`).run(seq, '{"size":100}', new Date(now - 8 * DAY).toISOString())
      if (p < PLANS * 0.8) db.prepare(`INSERT INTO cleanup_purges(seq,ts,status) VALUES (?,?,?)`).run(seq, new Date().toISOString(), 'done')
    }
  }
  db.exec('COMMIT')
}

/**
 * 慢但顯然正確的參考算法：每一份都算完整逐項結果，再篩、再分頁。
 *
 * 2026-09-19 第二波改了兩條語意（稽核第二波 f、g）：
 * - pending 只算 proposed 計畫（計畫是一次性的，partial／error 不佔檔、不算「上次那份」）
 * - 「可以復原」包含復原到一半中斷的項目（outcome 是 unknown、why 是「復原到一半中斷…」）
 */
function slowListPlans(db, { filter, offset = 0, limit = 20 } = {}) {
  const plans = db.prepare(`SELECT id, status, created_at, applied_at FROM cleanup_plans ORDER BY created_at DESC, rowid DESC`).all()
  const rows = []
  const canRestore = x => x?.outcome === 'moved' || (x?.outcome === 'unknown' && /復原到一半中斷/.test(x.why ?? ''))
  for (const p of plans) {
    if (filter === 'pending' && p.status !== 'proposed') continue
    const o = routes.planOutcomes(db, p.id)
    const snaps = db.prepare('SELECT snapshot FROM cleanup_snapshots WHERE plan_id=? ORDER BY rowid').all(p.id).map(r => JSON.parse(r.snapshot))
    const want = filter === 'pending' ? ['pending', 'failed', 'unknown'] : null
    const items = snaps.filter(i => filter === 'undoable' ? canRestore(o.get(i.id)) : !want || want.includes(o.get(i.id)?.outcome ?? ''))
      .map(i => ({ itemId: i.id, name: i.name, bytes: i.bytes }))
    const canUndo = snaps.some(i => canRestore(o.get(i.id)))
    if (filter === 'undoable' && !canUndo) continue
    if (filter === 'pending' && !items.length) continue
    const restored = db.prepare(`SELECT max(ts) ts FROM cleanup_journal WHERE plan_id=? AND op='restore' AND status='done'`).get(p.id)
    // 已經開始復原（有任何 restore 紀錄）：再 apply 一定 409，面板要拿它決定給哪些出口
    const restoring = Boolean(db.prepare(`SELECT 1 FROM cleanup_journal WHERE plan_id=? AND op='restore' LIMIT 1`).get(p.id))
    rows.push({ id: p.id, status: p.status, createdAt: p.created_at, appliedAt: p.applied_at, restoredAt: restored.ts, canUndo, restoring,
      itemCount: items.length, bytes: items.reduce((n, i) => n + i.bytes, 0), items })
  }
  const total = rows.length
  offset = Math.min(offset, Math.max(0, Math.ceil(total / limit) - 1) * limit)
  return { total, offset, limit, operations: rows.slice(offset, offset + limit) }
}

describe('RC19 /cleanup/plans 要快', () => {
  test('3000 份計畫，?undoable=1 < 150 ms', t => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-a0919-bench-'))
    const db = open(join(dir, 'd.db'))
    t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
    seedPlans(db, 3000)
    const f = { db, opts: { roots: ['/dl'], quarantine: join(dir, 'q'), maxBytes: 1e6 }, scan: () => ({}) }
    let best = Infinity, r
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      r = call(f, 'GET', '/cleanup/plans?undoable=1')
      best = Math.min(best, performance.now() - t0)
    }
    assert.equal(r.code, 200)
    assert.equal(r.body.total, 600, '八成被清空，剩兩成還能復原')
    assert.equal(r.body.operations.length, 20)
    assert.ok(best < 150, `?undoable=1 花了 ${best.toFixed(0)} ms`)
  })

  test('性質：快的 listPlans 跟慢的參考算法一模一樣（各種狀態混在一起）', t => {
    const files = {}
    for (let i = 0; i < 17; i++) files[`f${i}.zip`] = `內容 ${i}`
    const f = fixture(t, files)
    const list = routes.listCandidates(f.db, { roots: f.opts.roots })
    const ids = n => idsOf(list, `f${n}.zip`)
    const mk = (...ns) => createPlan(f.db, { candidateIds: ns.flatMap(ids) })
    const applied = mk(0, 1); applyPlan(f.db, applied.id, f.opts)
    const undone = mk(2, 3); applyPlan(f.db, undone.id, f.opts); undoPlan(f.db, undone.id, f.opts)
    rmSync(join(f.downloads, 'f5.zip'))
    const partial = mk(4, 5); applyPlan(f.db, partial.id, f.opts)
    mk(6)                                               // proposed
    const dismissed = mk(7); call(f, 'POST', `/cleanup/plans/${dismissed.id}/dismiss`, {})
    const purged = mk(8, 9); applyPlan(f.db, purged.id, f.opts)
    const seq = f.db.prepare(`SELECT seq FROM cleanup_journal WHERE plan_id=? AND op='quarantine' ORDER BY seq LIMIT 1`).get(purged.id).seq
    f.db.prepare(`INSERT INTO cleanup_purges(seq,ts,status) VALUES (?,?,'done')`).run(seq, new Date().toISOString())
    rmSync(join(f.downloads, 'f10.zip')); rmSync(join(f.downloads, 'f11.zip'))
    const allFailed = mk(10, 11); applyPlan(f.db, allFailed.id, f.opts)
    const skipped = mk(12, 13); applyPlan(f.db, skipped.id, { ...f.opts, skippedIds: ids(13) })
    // 第二波加的三種：復原到一半中斷、另一份 proposed、搬到一半中斷（proposed 裡的 unknown）
    const restoring = mk(14); applyPlan(f.db, restoring.id, f.opts); undoPlan(f.db, restoring.id, f.opts)
    const rr = f.db.prepare(`SELECT * FROM cleanup_journal WHERE plan_id=? AND op='restore'`).get(restoring.id)
    renameSync(rr.to_path, rr.from_path)
    f.db.prepare(`UPDATE cleanup_journal SET status='started' WHERE seq=?`).run(rr.seq)
    f.db.prepare(`UPDATE cleanup_plans SET status='applied' WHERE id=?`).run(restoring.id)
    mk(15)
    const moving = mk(16); applyPlan(f.db, moving.id, f.opts)
    f.db.prepare(`UPDATE cleanup_journal SET status='started' WHERE plan_id=?`).run(moving.id)
    f.db.prepare(`UPDATE cleanup_plans SET status='proposed', applied_at=NULL WHERE id=?`).run(moving.id)

    let compared = 0
    for (const filter of [undefined, 'undoable', 'pending']) {
      for (const [offset, limit] of [[0, 20], [0, 1], [1, 2], [3, 2], [99, 3]]) {
        const fast = routes.listPlans(f.db, { filter, offset, limit })
        assert.deepEqual(fast, slowListPlans(f.db, { filter, offset, limit }), `filter=${filter} offset=${offset} limit=${limit}`)
        compared++
      }
    }
    // 驗收：三種篩選都真的有東西，不是一堆空陣列在互相比
    assert.ok(routes.listPlans(f.db, { filter: 'undoable' }).total >= 3)
    assert.ok(routes.listPlans(f.db, { filter: 'pending' }).total >= 3)
    assert.ok(routes.listPlans(f.db, { filter: 'undoable' }).operations.some(o => o.id === restoring.id), '復原中斷的要真的走到')
    assert.ok(routes.listPlans(f.db, { filter: 'pending' }).operations.some(o => o.id === moving.id), '搬到一半中斷的要真的走到')
    assert.equal(compared, 15)
  })
})

// ═══ RC23 ・ confirmed 的型別 ═════════════════════════════════

describe('RC23 confirmed 型別錯回 400、沒帶回 428', () => {
  test('"false"（字串）→ 400；沒帶 → 428；false → 428', t => {
    const f = fixture(t)
    const token = call(f, 'POST', '/cleanup/quarantine/empty', {}).body.token
    for (const bad of ['false', 'true', 1, null]) {
      const r = call(f, 'POST', '/cleanup/quarantine/empty', { token, confirmed: bad })
      assert.equal(r.code, 400, `confirmed=${JSON.stringify(bad)} 回了 ${r.code}`)
      assert.equal(r.body.code, 'BAD_BODY')
    }
    for (const body of [{ token }, { token, confirmed: false }]) {
      const r = call(f, 'POST', '/cleanup/quarantine/empty', body)
      assert.equal(r.code, 428, JSON.stringify(body))
      assert.equal(r.body.code, 'CONFIRMATION_REQUIRED')
    }
  })
})

// ═══ RC24 ・ 用錯方法 ═════════════════════════════════════════

describe('RC24 已知的路徑用錯方法回 405', () => {
  test('cleanup 與 pet 的路徑', t => {
    const f = fixture(t)
    for (const [m, p] of [['GET', '/cleanup/scan'], ['POST', '/cleanup/candidates'], ['GET', '/cleanup/quarantine/empty'],
                          ['POST', '/cleanup/quarantine'], ['POST', '/pet/state'], ['PUT', '/cleanup/plans'],
                          ['DELETE', '/cleanup/plans/abc'], ['GET', '/cleanup/plans/abc/release']]) {
      const r = call(f, m, p)
      assert.equal(r.code, 405, `${m} ${p} 回了 ${r.code}`)
      assert.equal(r.body.code, 'BAD_METHOD')
    }
    // 認不得的路徑還是 501
    assert.equal(call(f, 'POST', '/cleanup/reveal').code, 501)
  })

  test('server 自己的路徑', async t => {
    const s = await serve(t)
    for (const [m, p] of [['GET', '/form/plan'], ['POST', '/schema'], ['GET', '/undo'], ['GET', '/facts/abc/confirm']]) {
      const r = await s.raw(m, p, { body: m === 'POST' ? '{}' : undefined })
      assert.equal(r.status, 405, `${m} ${p} 回了 ${r.status}`)
    }
  })
})

// ═══ RC27 ・ 放棄的計畫 ═══════════════════════════════════════

describe('RC27 放棄的計畫逐項是 cancelled，不是 pending', () => {
  test('dismiss 之後', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    const r = call(f, 'POST', `/cleanup/plans/${p.id}/dismiss`, {})
    assert.equal(r.code, 200)
    assert.deepEqual(r.body.items.map(i => i.outcome), ['cancelled', 'cancelled'])
    assert.deepEqual(call(f, 'GET', `/cleanup/plans/${p.id}`).body.items.map(i => i.outcome), ['cancelled', 'cancelled'])
  })
})

// ═══ RC28 ・ 清空預覽表 ═══════════════════════════════════════

describe('RC28 清空預覽表不可以無限成長', () => {
  test('預覽時順便刪掉過期超過一天的列', t => {
    const f = fixture(t)
    initCleanup(f.db)
    const ins = (token, ms) => f.db.prepare('INSERT INTO cleanup_empty_requests(token,expires_at,entries) VALUES (?,?,?)')
      .run(token, new Date(Date.now() + ms).toISOString(), '[]')
    ins('two-days-old', -2 * DAY)
    ins('one-hour-old', -3600_000)
    ins('future', 60_000)
    const r = call(f, 'POST', '/cleanup/quarantine/empty', {})
    assert.equal(r.code, 200)
    const left = f.db.prepare('SELECT token FROM cleanup_empty_requests').all().map(x => x.token)
    assert.ok(!left.includes('two-days-old'), '過期超過一天的要刪掉')
    assert.ok(left.includes('one-hour-old'), '過期不到一天的先留著')
    assert.ok(left.includes('future'))
    assert.ok(left.includes(r.body.token), '這次的預覽要在')
  })
})

// ═══ 第三波之二 ・ 免 token 的 /health 不給隔離區的時間 ══════════════════

describe('第三波之二：免 token 的 GET /health 不給 quarantine.canEmptyAt／oldestMtimeAt', () => {
  test('同一個 server、同一個隔離區：帶 token 有兩個時間，免 token 是 null（欄位還在），canEmptyNow 一樣', async t => {
    const s = await serve(t, { files: { 'a.zip': { days: 60 } } })
    await s.api('POST', '/cleanup/scan', {})
    const plan = (await s.api('POST', '/cleanup/plans', {})).json
    assert.equal((await s.api('POST', `/cleanup/plans/${plan.id}/apply`, {})).status, 200)
    const full = (await s.raw('GET', '/health')).json
    const lean = (await s.raw('GET', '/health', { token: null })).json
    assert.equal(full.quarantine.items, 1, '前提：隔離區裡有一個檔')
    assert.equal(typeof full.quarantine.canEmptyAt, 'string')
    assert.equal(typeof full.quarantine.oldestMtimeAt, 'string')
    assert.deepEqual(Object.keys(lean.quarantine).sort(), Object.keys(full.quarantine).sort(), '形狀一致')
    assert.equal(lean.quarantine.canEmptyAt, null, 'canEmptyAt 減七天就是「使用者什麼時候清理過」')
    assert.equal(lean.quarantine.oldestMtimeAt, null)
    assert.equal(lean.quarantine.canEmptyNow, full.quarantine.canEmptyNow)
    assert.doesNotMatch(JSON.stringify(lean), /\d{4}-\d\d-\d\dT\d\d:/, '免 token 那份整份不可以有時間')
  })
})
