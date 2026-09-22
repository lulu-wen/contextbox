/**
 * 清理面板的本機模式接上真的路由。
 *
 * 期望值來自 `~/contextbox-預想-20260918-面板接線.md` 的表格，**實作之前寫的**。
 *
 * 打最外層：起一個真的 server，`createReal` 透過跟 `window.api` 一樣的函式打它。
 * 檔案是真的、搬移是真的、資料庫是真的。
 */
import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
import { rmTmp } from './helpers/rm.mjs'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { start } from '../core/server.ts'
import { createReal, createRealHistory } from '../core/assets/cleanup-real-state.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const DAY = 86400_000
const TOKEN = 'panel-test-token'

/**
 * 起一個 server、放檔案、掃一次。
 * files: { 名字: { days, bytes?, content? } }
 */
async function serve(t, files, { readonly = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-panel-')))
  const downloads = join(dir, 'Downloads')
  const quarantine = join(dir, 'q')
  mkdirSync(downloads)
  for (const [name, spec] of Object.entries(files)) {
    const p = join(downloads, name)
    writeFileSync(p, spec.content ?? (spec.bytes === 0 ? '' : `內容 ${name} `.repeat(spec.bytes ?? 3)))
    const at = new Date(Date.now() - spec.days * DAY)
    utimesSync(p, at, at)
  }
  const dbPath = join(dir, 'data.db')
  const S = start({
    port: 0, db: dbPath, token: TOKEN,
    roots: [downloads], quarantine, maxBytes: 20 * 1024 * 1024, readonly,
  })
  const port = await S.ready
  const calls = []
  let lose = null   // (path, method) => true 的話，請求照送，但回應「在網路上丟了」
  /** 跟 core/ui.html 的 window.api 同一個行為：錯誤訊息原樣丟、code、status 與回應本體（data）掛上去。 */
  const api = async (path, init = {}) => {
    const method = init.method ?? 'GET'
    calls.push({ path, method, body: init.body ? JSON.parse(init.body) : undefined })
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init, headers: { 'content-type': 'application/json', 'x-contextbox-token': TOKEN },
    })
    const data = await r.json().catch(() => ({}))
    if (lose?.(path, method)) { lose = null; throw new TypeError('Failed to fetch') }
    if (!r.ok) {
      const e = new Error(data.error || '伺服器回了 ' + r.status)
      e.code = data.code; e.status = r.status; e.data = data   // CONFLICT 的 blockingPlan 在 data 裡（RC7）
      throw e
    }
    return data
  }
  t.after(() => { S.server.close(); rmTmp(dir) })
  await api('/cleanup/scan', { method: 'POST', body: '{}' })
  calls.length = 0
  const db = () => new DatabaseSync(dbPath, { readOnly: true })
  const plans = () => { const d = db(); try { return d.prepare('SELECT * FROM cleanup_plans').all() } finally { d.close() } }
  const byName = (real, n) => real.candidates.find(c => c.name === n)
  return {
    dir, downloads, quarantine, dbPath, api, calls, plans, byName,
    loseNext: (fn) => { lose = fn },
    has: (n) => existsSync(join(downloads, n)),
    rescan: () => api('/cleanup/scan', { method: 'POST', body: '{}' }),
  }
}

// ═══ A ・ 勾選 → 送給後端的 id ═════════════════════════════

describe('A 勾選要一對一變成搬移', () => {
  test('**低信心的勾起來就要搬** —— 不可以只拿預設勾的', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'old.bin': { days: 200 } })
    const real = createReal(s.api)
    await real.load()
    const old = s.byName(real, 'old.bin')
    assert.equal(old.defaultChecked, false, '前提：old-download 預設不勾')
    real.select(old.itemId, true)
    const r = await real.apply()
    assert.equal(r.status, 'applied', JSON.stringify(r))
    assert.ok(!s.has('old.bin'), '使用者勾了，就要搬 — 不然是沉默地錯')
    assert.ok(!s.has('a.zip'))
  })

  test('**取消勾選的絕對不可以搬**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    const real = createReal(s.api)
    await real.load()
    real.select(s.byName(real, 'a.zip').itemId, false)
    await real.apply()
    assert.ok(s.has('a.zip'), '使用者取消了 a.zip，它必須還在 Downloads')
    assert.ok(!s.has('b.zip'))
  })

  test('一個檔有兩條理由，兩個 id 都要送', async t => {
    const s = await serve(t, { 'old.zip': { days: 200 } })
    const real = createReal(s.api)
    await real.load()
    const item = s.byName(real, 'old.zip')
    assert.equal(item.candidateIds.length, 2, '前提：archive + old-download')
    await real.apply()
    const sent = s.calls.find(c => c.path === '/cleanup/plans' && c.method === 'POST')
    assert.deepEqual([...sent.body.candidateIds].sort(), [...item.candidateIds].sort())
  })

  test('沒勾任何東西就一個請求都不發', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const real = createReal(s.api)
    await real.load()
    real.select(s.byName(real, 'a.zip').itemId, false)
    s.calls.length = 0
    await assert.rejects(real.apply(), /at least/)
    assert.equal(s.calls.length, 0, '前端要先擋，不可以打 API')
  })
})

// ═══ B ・ 逐項結果 ═════════════════════════════════════════

describe('B 逐項結果要照實講', () => {
  test('**搬成幾個就說幾個**，不是勾了幾個', async t => {
    const s = await serve(t, {
      'a.zip': { days: 60, bytes: 10 }, 'b.zip': { days: 60, bytes: 20 }, 'c.zip': { days: 60, bytes: 30 },
    })
    const real = createReal(s.api)
    await real.load()
    const sizes = Object.fromEntries(real.candidates.map(c => [c.name, c.bytes]))
    rmSync(join(s.downloads, 'b.zip'))    // 按下去之前被刪掉
    const r = await real.apply()
    assert.equal(r.moved, 2, '勾了 3 個，搬成 2 個')
    assert.equal(r.failed.length, 1)
    assert.equal(r.failed[0].name, 'b.zip')
    assert.ok(r.failed[0].why && !/reason unknown/.test(r.failed[0].why), '每個失敗都要講得出為什麼')
    assert.equal(r.bytesFreed, sizes['a.zip'] + sizes['c.zip'], '只算真的搬走的')
    assert.equal(r.status, 'partial')
  })

  test('檢查沒過（不寫 journal 的那種）也要有原因', async t => {
    // 剛 cp 出來的重複檔會撞到十分鐘的靜置窗 —— 那種失敗不寫 journal
    const s = await serve(t, {
      '報告.pdf': { days: 0, content: 'SMOKE 同一份' },
      '報告 (1).pdf': { days: 0, content: 'SMOKE 同一份' },
    })
    // 稽核第二輪 R2-2 之後，正常掃描不會把還在十分鐘內的重複檔提升成候選；
    // 用 minStableMs: 0 再掃一次，做出「計畫裡有一個還在十分鐘內的檔」
    const { scanDownloads } = await import('../core/cleanup-scanner.ts')
    const { open } = await import('../core/db.ts')
    const db = open(s.dbPath)
    try { scanDownloads({ db, roots: [s.downloads], maxBytes: 20 * 1024 * 1024, minStableMs: 0, now: new Date(Date.now() + 1000) }) } finally { db.close() }
    const real = createReal(s.api)
    await real.load()
    assert.equal(real.candidates.length, 1, '前提：只有其中一份被提議')
    const r = await real.apply()
    assert.equal(r.moved, 0)
    assert.match(r.failed[0].why, /ten minutes|later/)
  })

  test('逐項結果的守恆：搬了＋略過＋失敗 = 計畫的檔數', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 }, 'c.msi': { days: 30 } })
    rmSync(join(s.downloads, 'c.msi'))
    const created = await s.api('/cleanup/plans', { method: 'POST', body: '{}' })
    const r = await s.api(`/cleanup/plans/${created.id}/apply`, { method: 'POST', body: '{}' })
    const count = (o) => r.items.filter(i => i.outcome === o).length
    assert.equal(count('moved') + count('skipped') + count('failed'), r.items.length)
    assert.equal(count('moved'), r.quarantinedCount)
    for (const i of r.items) {
      assert.ok(['moved', 'skipped', 'failed'].includes(i.outcome), `${i.name} 的 outcome 是 ${i.outcome}`)
      if (i.outcome === 'failed') assert.ok(i.why, `${i.name} 失敗卻沒有 why`)
    }
  })

  test('`why` 不可以帶絕對路徑', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const created = await s.api('/cleanup/plans', { method: 'POST', body: '{}' })
    rmSync(join(s.downloads, 'a.zip'))
    await s.api(`/cleanup/plans/${created.id}/apply`, { method: 'POST', body: '{}' })
    // scanner 那條線寫進 file_items.error 的是 fs 的原文，帶完整路徑
    const d = new DatabaseSync(s.dbPath)
    d.prepare(`UPDATE file_items SET error=? WHERE name='a.zip'`)
      .run(`EACCES: permission denied, open '/home/alice/Downloads/a.zip'`)
    d.close()
    const got = await s.api(`/cleanup/plans/${created.id}`)
    const s2 = JSON.stringify(got)
    assert.ok(!s2.includes('/home/alice'), `回應帶了路徑：${s2}`)
    assert.ok(got.items[0].why, '還是要有原因，只是不能有路徑')
  })
})

// ═══ C ・ 重試、冪等、卡住的計畫 ═════════════════════════════

describe('C 重試與卡住的計畫', () => {
  test('**apply 的回應丟了，再按一次要成功，而且只搬一次**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    const real = createReal(s.api)
    await real.load()
    s.loseNext((path, m) => m === 'POST' && path.endsWith('/apply'))
    await assert.rejects(real.apply())
    assert.ok(!s.has('a.zip'), '前提：伺服器其實已經搬完了')
    assert.equal(real.locked, true, '結果不明的時候要鎖住勾選')

    const r = await real.apply()
    assert.equal(r.status, 'applied', '重送要拿到同一份計畫的結果')
    assert.equal(r.moved, 2)
    assert.equal(s.plans().length, 1, '不可以因為重送多一份計畫')
  })

  test('建計畫的回應丟了，再按一次也只有一份計畫', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const real = createReal(s.api)
    await real.load()
    s.loseNext((path, m) => m === 'POST' && path === '/cleanup/plans')
    await assert.rejects(real.apply())
    const r = await real.apply()
    assert.equal(r.status, 'applied')
    assert.equal(s.plans().length, 1)
  })

  test('結果不明的時候不能改勾選 —— 改了就會撞上自己剛建的那份', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    const real = createReal(s.api)
    await real.load()
    s.loseNext((path, m) => m === 'POST' && path === '/cleanup/plans')
    await assert.rejects(real.apply())
    const a = s.byName(real, 'a.zip').itemId
    real.select(a, false)
    assert.ok(real.selected.has(a), '鎖住時 select 不可以生效')
  })

  test('做完一次之後，下一次是新的計畫', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    const real = createReal(s.api)
    await real.load()
    real.select(s.byName(real, 'b.zip').itemId, false)
    await real.apply()
    await real.load()
    real.select(s.byName(real, 'b.zip').itemId, true)
    const r = await real.apply()
    assert.equal(r.status, 'applied')
    assert.equal(s.plans().length, 2)
  })

  test('**唯讀模式一份計畫都不可以建**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } }, { readonly: true })
    const real = createReal(s.api)
    await real.load()
    await assert.rejects(real.apply(), e => e.code === 'READ_ONLY')
    assert.equal(s.plans().length, 0, '建了就會卡在 proposed，永遠佔住那些檔')
    assert.ok(s.has('a.zip'))
  })

  test('**有一份卡住的計畫時，要讓使用者看到它、選擇接續，不可以自動套用**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    // 另一個分頁建了一份只有 a 的計畫，然後被關掉了
    const first = createReal(s.api)
    await first.load()
    first.select(s.byName(first, 'b.zip').itemId, false)
    await s.api('/cleanup/plans', { method: 'POST', body: JSON.stringify({
      candidateIds: s.byName(first, 'a.zip').candidateIds }) })

    const real = createReal(s.api)
    await real.load()
    const r = await real.apply()          // 想清 a、b
    assert.equal(r.status, 'pending-plan', JSON.stringify(r))
    assert.deepEqual(r.plan.items.map(i => i.name), ['a.zip'])
    assert.ok(s.has('a.zip') && s.has('b.zip'), '只是提示，一個都還沒動')
    assert.equal(real.locked, true)

    const r2 = await real.apply()        // 使用者按“Finish the last plan”
    assert.equal(r2.status, 'applied')
    assert.ok(!s.has('a.zip'), '上次那份是 a')
    assert.ok(s.has('b.zip'), '**b 不在上次那份裡，不可以被順便搬走**')
  })
})

// ═══ D ・ 候選過期 ═════════════════════════════════════════

describe('D 候選過期', () => {
  test('**清單變了就一個都不搬**，重載，保留還在的那些的勾選', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'old.bin': { days: 200 } })
    const real = createReal(s.api)
    await real.load()
    const old = s.byName(real, 'old.bin').itemId
    real.select(old, true)                // 使用者主動勾了低信心的
    rmSync(join(s.downloads, 'a.zip'))
    await s.rescan()                      // watcher 在面板開著的時候重掃了

    const r = await real.apply()
    assert.equal(r.status, 'stale')
    assert.ok(s.has('old.bin'), '清單變了就不可以自動重試 — 使用者要再看一眼')
    assert.ok(!real.candidates.some(c => c.name === 'a.zip'), '重載之後 a 不在了')
    assert.ok(real.selected.has(old), '使用者對 old.bin 的選擇沒變，要保留')
    assert.equal(real.locked, false, '沒有建出任何計畫，不需要鎖')
  })
})

// ═══ E ・ GET /cleanup/plans ═══════════════════════════════

describe('E 可復原的計畫清單', () => {
  test('復原過的不列、形狀跟 demo 的歷史一樣', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    const p = await s.api('/cleanup/plans', { method: 'POST', body: '{}' })
    await s.api(`/cleanup/plans/${p.id}/apply`, { method: 'POST', body: '{}' })
    let h = await s.api('/cleanup/plans?undoable=1')
    assert.equal(h.total, 1)
    const op = h.operations[0]
    for (const k of ['id', 'createdAt', 'restoredAt', 'canUndo', 'itemCount', 'bytes', 'items']) {
      assert.ok(k in op, `少了 ${k}，C 的歷史面板會壞`)
    }
    assert.equal(op.canUndo, true)
    assert.equal(op.itemCount, 2)

    await s.api(`/cleanup/plans/${p.id}/undo`, { method: 'POST', body: '{}' })
    h = await s.api('/cleanup/plans?undoable=1')
    assert.equal(h.total, 0, '復原過的不能再復原')
  })

  test('**已經清空（滿七天被刪掉）的不可以說能復原**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const p = await s.api('/cleanup/plans', { method: 'POST', body: '{}' })
    await s.api(`/cleanup/plans/${p.id}/apply`, { method: 'POST', body: '{}' })
    const d = new DatabaseSync(s.dbPath)
    d.prepare('UPDATE cleanup_move_details SET completed_at=?')
      .run(new Date(Date.now() - 8 * DAY).toISOString())
    d.close()
    const prep = await s.api('/cleanup/quarantine/empty', { method: 'POST', body: '{}' })
    await s.api('/cleanup/quarantine/empty', { method: 'POST',
      body: JSON.stringify({ token: prep.token, confirmed: true }) })
    const h = await s.api('/cleanup/plans?undoable=1')
    assert.equal(h.total, 0, '檔案已經永久刪除了，說能復原是在騙人')
  })

  test('檔數與大小只算還在隔離區的', async t => {
    const s = await serve(t, {
      'a.zip': { days: 60, bytes: 10 }, 'b.zip': { days: 60, bytes: 20 }, 'c.zip': { days: 60, bytes: 30 },
    })
    const real = createReal(s.api)
    await real.load()
    const sizes = Object.fromEntries(real.candidates.map(c => [c.name, c.bytes]))
    rmSync(join(s.downloads, 'c.zip'))
    await real.apply()
    const op = (await s.api('/cleanup/plans?undoable=1')).operations[0]
    assert.equal(op.itemCount, 2, '計畫有 3 個但只搬了 2 個，復原也只會放回 2 個')
    assert.equal(op.bytes, sizes['a.zip'] + sizes['b.zip'])
    assert.deepEqual(op.items.map(i => i.name).sort(), ['a.zip', 'b.zip'])
  })

  test('total 算篩選之後的，排序穩定，沒有路徑', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 }, 'c.zip': { days: 60 } })
    const ids = []
    for (const n of ['a.zip', 'b.zip', 'c.zip']) {
      const real = createReal(s.api)
      await real.load()
      for (const c of real.candidates) real.select(c.itemId, c.name === n)
      ids.push((await real.apply()).planId)
    }
    await s.api(`/cleanup/plans/${ids[1]}/undo`, { method: 'POST', body: '{}' })
    const h = await s.api('/cleanup/plans?undoable=1&limit=1')
    assert.equal(h.total, 2, '3 份裡復原了 1 份')
    assert.equal(h.operations.length, 1)
    const orders = new Set()
    for (let i = 0; i < 10; i++) {
      const all = await s.api('/cleanup/plans?undoable=1')
      orders.add(all.operations.map(o => o.id).join(','))
      assert.ok(!JSON.stringify(all).includes(s.downloads), '不可以有路徑')
    }
    assert.equal(orders.size, 1, '重整十次順序都要一樣')
    const all = await s.api('/cleanup/plans?undoable=1')
    assert.deepEqual(all.operations.map(o => o.id), [ids[2], ids[0]], '新的在前')
  })

  test('分頁參數亂給回 400', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    for (const q of ['limit=0', 'limit=101', 'offset=-1', 'limit=abc']) {
      await assert.rejects(s.api('/cleanup/plans?undoable=1&' + q), e => e.status === 400, q)
    }
  })

  test('歷史面板的轉接器：復原多份、重送安全', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    const ids = []
    for (const n of ['a.zip', 'b.zip']) {
      const real = createReal(s.api)
      await real.load()
      for (const c of real.candidates) real.select(c.itemId, c.name === n)
      ids.push((await real.apply()).planId)
    }
    const history = createRealHistory(s.api)
    const listed = await history('history?offset=0&limit=20')
    assert.equal(listed.total, 2)
    const r = await history('undo', { operationIds: ids })
    assert.equal(r.restored, 2)
    assert.equal(r.restoredFiles, 2)
    assert.ok(s.has('a.zip') && s.has('b.zip'))
    const again = await history('undo', { operationIds: ids })
    assert.equal(again.restored, 0, '重送不可以出錯')
    assert.equal(again.alreadyRestored, 2)
  })
})

// ═══ F ・ 復原 ═════════════════════════════════════════════

describe('F 復原要講真話', () => {
  test('**復原後檔案回到 Downloads，但不會回到清單**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    const real = createReal(s.api)
    await real.load()
    await real.apply()
    assert.equal(real.canUndo, true)
    const r = await real.undo()
    assert.equal(r.restored, 2)
    assert.ok(s.has('a.zip') && s.has('b.zip'), '檔案要回到原位')
    assert.equal(real.candidates.length, 0,
      'A 的規則：復原過就代表想Keeping，之後不再提議。前端不可以自己把它們加回清單')
    assert.equal(real.canUndo, false)
  })
})

// ═══ 設定檔 ════════════════════════════════════════════════

test('**測試起的 server 不可以去讀使用者的設定檔**', async t => {
  // start() 以前只收 roots／quarantine，maxBytes 與 readonly 要去讀設定檔 ——
  // 任何透過 server 真的 apply 的測試都會讀（開發機）甚至建立（乾淨的機器）
  // 使用者真的 ~/.contextbox/config.json。
  //
  // 探針是假家目錄：這個行程的 HOME 已經換成空資料夾（見 helpers/isolate-home.mjs），
  // 所以只要有任何一條路徑去讀設定檔，就會在假家目錄建出 .contextbox/config.json。
  // （第一版的探針是設一個 CONTEXTBOX_CONFIG 再看它有沒有被建出來 —— 但設定檔路徑
  //   在模組載入時就算好了，測試裡才設的環境變數根本沒用，突變活著。）
  const s = await serve(t, { 'a.zip': { days: 60 } })
  const real = createReal(s.api)
  await real.load()
  await real.apply()
  await real.undo()
  await s.api('/health')
  await s.api('/cleanup/plans?undoable=1')
  assert.ok(!existsSync(join(FAKE_HOME, '.contextbox')),
    '跑完一整輪清理，家目錄底下出現了 .contextbox — 有路徑去讀了設定檔')
})

// ═══ window.api 要把 code 帶上來 ════════════════════════════

test('window.api 丟錯時要帶 code 與 status', async () => {
  // 只有人話的話，UI 分不出「候選過期（要重載）」、「有計畫卡著（要接續）」、
  // 「忙碌中（要重試）」—— 三種要做的事完全不同。
  const html = readFileSync(join(REPO, 'core/ui.html'), 'utf8')
  const src = /async function api\([\s\S]*?\n\}/.exec(html)?.[0]
  assert.ok(src, '找不到 ui.html 裡的 api()')
  const api = new Function('document', 'HEAD', 'fetch', src + '\nreturn api')(
    { documentElement: { dataset: {} } }, {},
    async () => ({ ok: false, status: 409, json: async () => ({ error: '候選已變更', code: 'STALE_CANDIDATE' }) }),
  )
  const e = await api('/x').catch(e => e)
  assert.equal(e.message, '候選已變更', '訊息維持原樣 — 既有呼叫端只看 message')
  assert.equal(e.code, 'STALE_CANDIDATE')
  assert.equal(e.status, 409)
})

// ═══ A 的 scanner：幽靈候選 ═════════════════════════════════

describe('掃描之前就被刪掉的檔不可以變成幽靈候選', () => {
  test('**全量掃描要把不存在的檔標成 missing**', async t => {
    // 全量掃描只處理「走訪時看到的」檔。watcher 沒開的期間被刪掉的檔永遠不會
    // 被標成 missing —— 候選一直活著，徽章數字是錯的，還能被勾、被建進計畫。
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    rmSync(join(s.downloads, 'a.zip'))
    await s.rescan()
    const r = await s.api('/cleanup/candidates')
    assert.deepEqual(r.candidates.map(c => c.name), ['b.zip'], '使用者自己刪掉的 a.zip 不可以還在清單上')
    const h = await s.api('/health')
    assert.equal(h.pendingCandidates, 1, '徽章數字也要對')
  })

  test('單檔掃描（watcher 用的）只碰它被給的那個檔', async t => {
    // 不是怕誤殺（對帳的判準是 existsSync），是 watcher 每個檔案事件都叫一次
    // scanDownloads —— 每次都對整個資料夾做 stat 是白做工，寫入範圍也會從
    // 「這一個檔」擴大成「整個資料夾」。刪檔事件本身會讓 watcher 掃到那個路徑。
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    rmSync(join(s.downloads, 'a.zip'))
    const { scanDownloads } = await import('../core/cleanup-scanner.ts')
    const { open } = await import('../core/db.ts')
    const db = open(s.dbPath)
    try {
      scanDownloads({ db, roots: [s.downloads], maxBytes: 20 * 1024 * 1024, paths: [join(s.downloads, 'b.zip')] })
      const a = db.prepare(`SELECT status FROM file_items WHERE name='a.zip'`).get()
      assert.notEqual(a.status, 'missing', '只掃 b 的時候，不可以順便去動 a 的那一列')
      scanDownloads({ db, roots: [s.downloads], maxBytes: 20 * 1024 * 1024 })
      const a2 = db.prepare(`SELECT status FROM file_items WHERE name='a.zip'`).get()
      assert.equal(a2.status, 'missing', '全量掃描才對帳')
    } finally { db.close() }
  })

  test('隔離區裡的檔不可以被標成 missing —— 它只是被搬走了', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const real = createReal(s.api)
    await real.load()
    const r = await real.apply()
    await s.rescan()
    const undone = await real.undo()
    assert.equal(undone.restored, 1, '重掃之後還要能復原')
    assert.ok(s.has('a.zip'))
  })
})

test('監看資料夾是捷徑（symlink）時，對帳也要做得到', async t => {
  // file_items.path 存 realpath。監看資料夾若經過 symlink（macOS 的 /var 就是），
  // 用給定的路徑去比前綴會一個都對不到，對帳靜靜地什麼都沒做。
  const { symlinkSync } = await import('node:fs')
  const { scanDownloads } = await import('../core/cleanup-scanner.ts')
  const { open } = await import('../core/db.ts')
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-link-')))
  t.after(() => rmTmp(dir))
  const real = join(dir, 'real-dl')
  mkdirSync(real)
  const link = join(dir, 'Downloads')
  symlinkSync(real, link)
  for (const n of ['a.zip', 'b.zip']) {
    writeFileSync(join(real, n), 'x' + n)
    const at = new Date(Date.now() - 60 * DAY); utimesSync(join(real, n), at, at)
  }
  const db = open(join(dir, 'data.db'))
  try {
    const scan = () => scanDownloads({ db, roots: [link], maxBytes: 1e6 })
    scan()
    rmSync(join(real, 'a.zip'))
    scan()
    const alive = db.prepare(`SELECT name FROM file_items WHERE status NOT IN ('missing','quarantined') ORDER BY name`).all()
    assert.deepEqual(alive.map(r => r.name), ['b.zip'], '經過捷徑的the watched folder，被刪的檔也要標成 missing')
  } finally { db.close() }
})

test('**搬失敗的檔要離開候選清單** —— 不然會卡在 STALE 死循環', async t => {
  // B 的 createPlan 拒收 error 不是 NULL 的檔。清單若還列著它、前端又保留勾選，
  // 下一次按清理 → 建計畫回 STALE → 重載 → 還是勾著 → 又 STALE，永遠出不去。
  const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 }, 'c.zip': { days: 60 } })
  const real = createReal(s.api)
  await real.load()
  rmSync(join(s.downloads, 'b.zip'))
  const r = await real.apply()
  assert.equal(r.status, 'partial')
  assert.ok(!real.candidates.some(c => c.name === 'b.zip'), '失敗的 b 還在候選清單上')
  // 2026-09-19 稽核 RC21：斷言訊息寫了「講得出為什麼」卻沒驗 why —— why 換成「原因不明」也是綠的
  const b = real.needsHuman.find(h => h.name === 'b.zip')
  assert.ok(b, '它該出現在「需要你看一眼」')
  assert.ok(typeof b.why === 'string' && b.why.trim() && !/reason unknown/.test(b.why), `而且講得出為什麼：${b.why}`)
  // 剩下沒有可以清的了。再按一次要老實說沒東西可清，不可以回 stale
  await assert.rejects(real.apply(), /at least/)
})

test('清單上的每一個候選都要建得了計畫（清單與 createPlan 用同一套篩選）', async t => {
  const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 }, 'c.msi': { days: 30 } })
  // 讓 b 帶著 error 但 status 還是 candidate —— B 的搬移失敗、scanner 的太大檔都是這樣
  const d = new DatabaseSync(s.dbPath)
  d.prepare(`UPDATE file_items SET error='隨便什麼原因' WHERE name='b.zip'`).run()
  d.close()
  const list = await s.api('/cleanup/candidates')
  const ids = list.candidates.flatMap(c => c.candidateIds)
  const plan = await s.api('/cleanup/plans', { method: 'POST', body: JSON.stringify({ candidateIds: ids }) })
  assert.equal(plan.items.length, list.candidates.length, '清單列出的每一個都要被計畫收下')
  const h = await s.api('/health')
  assert.equal(h.pendingCandidates, list.candidates.length, '徽章數字要跟清單一致')
})

// ═══ 獨立重推抓到的 ════════════════════════════════════════

describe('獨立重推抓到的', () => {
  test('**結果不明後重新打開面板，再試一次要沿用原本那份**', async t => {
    // 重新打開面板會 load()，搬走的檔從清單消失，勾選跟著變。
    // 用「現在的勾選」重算 id 去比的話會換掉 requestId、丟掉 planId ——
    // 使用者看到「請至少選擇一個檔案」，卻不知道檔案其實已經搬走了。
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    const real = createReal(s.api)
    await real.load()
    s.loseNext((path, m) => m === 'POST' && path.endsWith('/apply'))
    await assert.rejects(real.apply())
    await real.load()                    // 關掉再打開面板
    const r = await real.apply()         // 按“Try again”
    assert.equal(r.status, 'applied', JSON.stringify(r))
    assert.equal(r.moved, 2)
    assert.equal(s.plans().length, 1)
  })

  test('**預設清理不可以動到清單上顯示 ☐ 的檔**（只有一個地方決定 defaultChecked）', async t => {
    // 太大的檔沒有指紋 → 清單上被否決、顯示不勾。但 B 的預設（不帶 id）只看信心 ≥ 50，
    // 不看否決 —— 不帶 id 建計畫的話它會被收進去。
    const s = await serve(t, { 'a.zip': { days: 60 }, 'big.zip': { days: 60, content: 'x'.repeat(30 * 1024 * 1024) } })
    const list = await s.api('/cleanup/candidates')
    // 2026-09-19 稽核 RC4：太大沒指紋的檔不再列成 ☐，而是不列、改列在「需要你查看」
    assert.ok(!list.candidates.some(c => c.name === 'big.zip'), '前提：big.zip 不在候選清單上')
    assert.ok(list.needsHuman.some(h => h.name === 'big.zip'), '前提：big.zip 在「需要你查看」')
    const plan = await s.api('/cleanup/plans', { method: 'POST', body: '{}' })
    assert.deepEqual(plan.items.map(i => i.name), ['a.zip'], '不帶 id 的預設要跟清單上的 ✔ 一模一樣')
  })

  test('復原時原位置已被佔，要講得出放回來叫什麼名字', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const real = createReal(s.api)
    await real.load()
    await real.apply()
    writeFileSync(join(s.downloads, 'a.zip'), '後來又下載了一個同名的')
    const r = await real.undo()
    assert.equal(r.restored, 1)
    assert.deepEqual(r.renamed, [{ name: 'a.zip', restoredAs: 'a.zip.restored' }],
      '不講的話使用者會以為「放回原位」—— 其實原位是後來那個檔，他的檔改名了')
    const plan = await s.api(`/cleanup/plans/${r.planId}`)
    assert.equal(plan.items[0].restoredAs, 'a.zip.restored')
    assert.ok(!JSON.stringify(plan).includes(s.downloads), 'restoredAs 只給檔名，不給路徑')
  })
})

// ═══ Step 4 ・ 性質：隨機情境跟笨參考實作對照 ══════════════════

test('**性質：沒勾的絕不搬、搬了幾個就說幾個、復原全部回來**（結構化隨機 40 輪）', async t => {
  // 可重現的亂數（失敗時印出 seed）
  const rng = (seed) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  // 刻意挑會命中不同規則與預設的檔：
  //   zip60 → archive 65（預設 ✔）
  //   zip200 → archive + old-download（兩條理由）
  //   bin200 → old-download 35（預設 ☐，低信心）
  //   msi30 → installer 70（預設 ✔）
  const KINDS = [['zip', 60], ['zip', 200], ['bin', 200], ['msi', 30]]
  const hits = { applied: 0, partial: 0, error: 0, rejected: 0, lowConfChecked: 0, twoReasons: 0, uncheckedDefault: 0 }

  // 種子一定要涵蓋的：勾 0 個、勾 1 個、全勾、全部被刪、低信心全勾
  const forced = ['none', 'one', 'all', 'allDeleted', 'lowOnly']
  for (let round = 0; round < 40; round++) {
    const seed = 7919 * (round + 1)
    const r = rng(seed)
    const n = 1 + Math.floor(r() * 5)
    const files = {}
    for (let i = 0; i < n; i++) {
      const [ext, days] = KINDS[Math.floor(r() * KINDS.length)]
      files[`f${i}.${ext}`] = { days, bytes: 1 + Math.floor(r() * 20) }
    }
    const s = await serve(t, files)
    const real = createReal(s.api)
    await real.load()

    const mode = forced[round] ?? 'random'
    for (const c of real.candidates) {
      const want = mode === 'none' ? false : mode === 'all' || mode === 'allDeleted' ? true
        : mode === 'one' ? c === real.candidates[0]
        : mode === 'lowOnly' ? !c.defaultChecked
        : r() < 0.6
      real.select(c.itemId, want)
      if (want && !c.defaultChecked) hits.lowConfChecked++
      if (!want && c.defaultChecked) hits.uncheckedDefault++
      if (want && c.candidateIds.length > 1) hits.twoReasons++
    }
    const selected = new Set(real.candidates.filter(c => real.selected.has(c.itemId)).map(c => c.name))
    const unselected = real.candidates.filter(c => !real.selected.has(c.itemId)).map(c => c.name)
    const deleted = new Set()
    for (const name of selected) {
      if (mode === 'allDeleted' || (mode === 'random' && r() < 0.2)) { rmSync(join(s.downloads, name)); deleted.add(name) }
    }

    let res
    try { res = await real.apply() }
    catch (e) {
      assert.equal(selected.size, 0, `seed ${seed}：有勾卻丟例外：${e.message}`)
      hits.rejected++
      continue
    }
    hits[res.status] = (hits[res.status] ?? 0) + 1
    const gone = [...selected].filter(n => !s.has(n) && !deleted.has(n))

    // 1. 沒勾的絕不搬
    for (const n of unselected) assert.ok(s.has(n), `seed ${seed}：沒勾的 ${n} 被搬走了`)
    // 2. 搬走的都是有勾的（上面那條的另一面：消失的檔一定在勾選裡）
    for (const n of Object.keys(files)) {
      if (!s.has(n) && !deleted.has(n)) assert.ok(selected.has(n), `seed ${seed}：${n} 不見了卻沒被勾`)
    }
    // 3. 搬了幾個就說幾個
    assert.equal(res.moved, gone.length, `seed ${seed}：說搬了 ${res.moved}，實際少了 ${gone.length}`)
    // 4. 守恆：搬了 + 失敗 = 勾選數（UI 不帶 skippedIds，所以沒有略過）
    assert.equal(res.moved + res.failed.length, selected.size, `seed ${seed}：守恆不成立`)
    for (const f of res.failed) assert.ok(f.why, `seed ${seed}：${f.name} 失敗卻沒有原因`)
    // 5. 復原之後，搬走的全部回來
    if (res.moved) {
      const u = await real.undo()
      assert.equal(u.restored, res.moved, `seed ${seed}：搬了 ${res.moved} 只放回 ${u.restored}`)
      for (const n of gone) assert.ok(s.has(n), `seed ${seed}：${n} 沒有放回來`)
    }
  }

  // 驗收生成器：有趣的路徑都要真的走到，不然這 40 輪等於同一輪跑 40 次
  for (const [k, min] of Object.entries({ applied: 3, partial: 2, error: 1, rejected: 1, lowConfChecked: 3, twoReasons: 3, uncheckedDefault: 3 })) {
    assert.ok(hits[k] >= min, `生成器沒走到“${k}”（${hits[k]} 次，at least要 ${min}）：${JSON.stringify(hits)}`)
  }
  console.log('# 性質測試走到的路徑：' + JSON.stringify(hits))
})
