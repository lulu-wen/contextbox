/**
 * 2026-09-19 稽核第二波・UI 端（RC7 UI、RC8、RC9、RC10、RC14 UI、RC16 頁面端與擴充套件、RC17(3)）。
 *
 * 期望值抄自 ~/contextbox-稽核-20260919.md 的「預期行為」，**在實作之前寫死**。
 * 打最外層：真的 server（port 0、假家目錄）＋ ui.html 裡真的 window.api ＋ 真的
 * cleanup-demo.js（掛在一個照 ui.html 的 id 建出來的假 DOM 上）。
 *
 * ── 動手前寫下的易錯點（build-round Step 1）─────────────────────────────
 *
 * | 段落 | 可能的錯誤 | 另一種合理解讀 | 能分辨兩者的例子（成對） | 認定的答案 |
 * |---|---|---|---|---|
 * | RC7 撞到 CONFLICT | 拿「最新一份 pending」 | 拿「跟這次勾選有交集的」 | 舊 P1={a}、新 P2={z}：只勾 a／只勾 z | 勾 a → 提示 [a.zip]，繼續之後 z、m 都在；勾 z → 提示 [z.zip] |
 * | RC7 沒有 blockingPlan | 自己去 ?pending=1 猜 | 照實丟錯 | 409 但 blockingPlan 是 null | 丟 CONFLICT、不鎖、不打 ?pending=1 |
 * | RC8 apply 回錯 | 一律當「結果不明」鎖住 | 有 status 就是確定的 | 每次 500（隔離區經過捷徑）／回應在網路上丟了 | 500 → 不鎖、可改勾選、顯示原因；丟了 → 鎖住 |
 * | RC8 繼續上次那份失敗 | pendingPlan 永遠不清 | 有 status 就清 | 500／網路丟了 | 500 → 解鎖；丟了 → 還是提示那份 |
 * | RC8 放棄上次那份 | 只在前端丟掉 | 呼叫 release | 放棄之後查資料庫 | 計畫 dismissed、候選還是 proposed、檔案不動；同樣勾選再清一次會搬 |
 * | RC8 套用成功、重載失敗 | 例外蓋掉「已經搬了 N 個」、catch 裡對 null 設屬性 | 先算結果再重載 | 重載丟 TypeError／重載成功 | 回 moved=1、reloadFailed、canUndo；不丟例外 |
 * | RC9 先前已復原 | ids − 放回的份數 | 復原前就沒有 moved 的 | 隔離區的檔被改過（CHANGED）／重送一次成功復原過的 | CHANGED → alreadyRestored 0、notRestored 1；重送 → alreadyRestored 1、notRestored 0 |
 * | RC9 寵物台詞 | 一律「都幫你放回來了」 | 看結果 | 0 放回／部分／全部 | 0 → 「0 個放回；1 個沒放回：（原因）」，不可以出現「都幫你放回來了」 |
 * | RC10 說明文字 | 寫死 demo 那句 | 跟著模式 | 本機／示範 | 本機：「每次清理為一筆，勾選後會把那一次搬走的檔案放回原位。」 |
 * | RC14 檔名 | 只換 \n | C0／C1 全換 | `a\n搬進隔離區 99 個檔案.zip`、ESC、U+0085、U+2028 | 每個控制字元換成「·」，一般檔名原樣 |
 * | RC16 網址列 | 整個 search 清掉 | 只拿掉 k | `/?k=abc&mockBackend=offline#x` | replaceState 到 `/?mockBackend=offline#x`；沒帶 k 不動 |
 * | RC16 擴充套件 | k 寫進 content script 的 href（網頁讀得到） | 背景程式開分頁 | 點「去補」 | 背景程式用 tabs.create 開 `http://127.0.0.1:<port>/?k=<token>`，那個網址回 200 |
 * | RC17(3) | 有失敗就說「原檔都還在原位」 | 全部是 failed 才說 | 全部 failed／一個 unknown | 全 failed → 說；有 unknown → 不說，照實講「狀態不明」 |
 */
import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync, readFileSync, realpathSync, symlinkSync, statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import vm from 'node:vm'
import { start } from '../core/server.ts'
import {
  createReal, createRealHistory, safeName, applyOutcome, applyMessage, undoMessage, historyUndoMessage,
  pendingPlanMessage,
} from '../core/assets/cleanup-real-state.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const DAY = 86400_000
const TOKEN = 'ui-audit-token'
const realFetch = globalThis.fetch
const UI_HTML = readFileSync(join(REPO, 'core/ui.html'), 'utf8')
const LOCAL_HISTORY_NOTE = '每次清理為一筆，勾選後會把那一次搬走的檔案放回原位。'

/** ui.html 裡真的 window.api（跟 cleanup-panel.test.mjs 抽 api() 的方式一樣）。 */
function uiApi(fetchImpl, doc = { documentElement: { dataset: {} } }) {
  const src = /async function api\([\s\S]*?\n\}/.exec(UI_HTML)?.[0]
  assert.ok(src, '找不到 ui.html 裡的 api()')
  return new Function('document', 'HEAD', 'fetch', src + '\nreturn api')(
    doc, { 'content-type': 'application/json', 'x-contextbox-token': TOKEN }, fetchImpl)
}

/**
 * 起一個 server、放檔案、掃一次。
 * files: { 相對路徑: { days, bytes?, content? } }
 * opts.quarantine: dir => 隔離區路徑（預設 dir/q）
 * 回傳的 api 就是 ui.html 的 window.api；hook(path, method) 回 'before'（沒送出）或 'lose'（送到了、回應丟了）。
 */
async function serve(t, files, { quarantine: qOf } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-ui-audit-')))
  const downloads = join(dir, 'Downloads')
  mkdirSync(downloads)
  for (const [name, spec] of Object.entries(files)) {
    const p = join(downloads, name)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, spec.content ?? `內容 ${name} `.repeat(spec.bytes ?? 3))
    const at = new Date(Date.now() - spec.days * DAY)
    utimesSync(p, at, at)
  }
  const quarantine = qOf ? qOf(dir) : join(dir, 'q')
  const dbPath = join(dir, 'data.db')
  const S = start({
    port: 0, db: dbPath, token: TOKEN, roots: [downloads], quarantine, maxBytes: 20 * 1024 * 1024, readonly: false,
  })
  const port = await S.ready
  const base = `http://127.0.0.1:${port}`
  const calls = []
  let hook = null
  const netFetch = async (url, init = {}) => {
    const path = String(url).replace(base, '')
    const method = init.method ?? 'GET'
    calls.push({ path, method })
    const act = hook?.(path, method)
    if (act === 'before') throw new TypeError('Failed to fetch')
    const r = await realFetch(String(url).startsWith('/') ? base + url : url, init)
    if (act === 'lose') { await r.text(); throw new TypeError('Failed to fetch') }
    return r
  }
  const api = uiApi(netFetch)
  const raw = async (path, init = {}) => {
    const r = await realFetch(base + path, { ...init, headers: { 'content-type': 'application/json', 'x-contextbox-token': TOKEN } })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { const e = new Error(data.error); e.code = data.code; e.status = r.status; e.data = data; throw e }
    return data
  }
  t.after(() => { S.server.close(); rmSync(dir, { recursive: true, force: true }) })
  await raw('/cleanup/scan', { method: 'POST', body: '{}' })
  const q = (sql, ...a) => { const d = new DatabaseSync(dbPath, { readOnly: true }); try { return d.prepare(sql).all(...a) } finally { d.close() } }
  const exec = (sql, ...a) => { const d = new DatabaseSync(dbPath); try { return d.prepare(sql).run(...a) } finally { d.close() } }
  const originals = new Map()
  return {
    dir, downloads, quarantine, dbPath, base, port, api, raw, calls, q, exec, netFetch,
    setHook: fn => { hook = fn },
    has: n => existsSync(join(downloads, n)),
    byName: (real, n) => real.candidates.find(c => c.name === n),
    idsOf: async n => (await raw('/cleanup/candidates')).candidates.find(c => c.name === n).candidateIds,
    planStatus: id => q('SELECT status FROM cleanup_plans WHERE id=?', id)[0]?.status,
    /** 把某個檔在隔離區裡的那一份改掉 → 復原時 CHANGED */
    tamper: name => {
      const row = q(`SELECT j.to_path FROM cleanup_journal j JOIN file_items f ON f.id = j.item_id
                      WHERE j.op='quarantine' AND j.status='done' AND f.name=?`, name)[0]
      assert.ok(row, `前提：${name} 在隔離區`)
      const st = statSync(row.to_path)
      originals.set(name, { path: row.to_path, data: readFileSync(row.to_path), atime: st.atime, mtime: st.mtime })
      writeFileSync(row.to_path, '被改過了，大小也不一樣了！！！')
    },
    /** 改回來（內容與時間都放回原樣）→ 再復原就放得回去 */
    untamper: name => {
      const o = originals.get(name)
      writeFileSync(o.path, o.data)
      utimesSync(o.path, o.atime, o.mtime)
    },
  }
}

/** 只勾 names，其他取消 */
function only(real, ...names) {
  for (const c of real.candidates) real.select(c.itemId, names.includes(c.name))
}

// ═══ 假 DOM：只認 ui.html 裡真的有的 id ═══════════════════════════════

const HTML_IDS = new Map()
for (const m of UI_HTML.matchAll(/<(\w+)\b([^>]*?)\sid="([^"]+)"([^>]*)>([^<]*)/g)) {
  HTML_IDS.set(m[3], { tag: m[1], hidden: /\shidden\b/.test(m[2] + ' ' + m[4]), text: m[5].trim() })
}

class FakeEl {
  constructor(tag, id = '') {
    this.tagName = tag.toUpperCase(); this.id = id
    this._text = ''; this.children = []; this.parent = null
    this.hidden = false; this.disabled = false; this.checked = false; this.type = ''
    this.title = ''; this.className = ''; this.dataset = {}; this.attrs = {}; this.listeners = {}
    this.open = false; this.offsetWidth = 0; this.onclick = null; this.onchange = null; this.isContentEditable = false
    const set = new Set()
    this.classList = {
      add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c),
      toggle: (c, on) => ((on ?? !set.has(c)) ? set.add(c) : set.delete(c)),
    }
  }
  get textContent() { return this._text + this.children.map(c => c.textContent).join('') }
  set textContent(v) { this._text = String(v); this.children = [] }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return this.attrs[k] ?? null }
  append(...kids) {
    for (const k of kids) {
      const n = typeof k === 'string' ? Object.assign(new FakeEl('#text'), { _text: k }) : k
      n.parent = this
      this.children.push(n)
    }
  }
  replaceChildren(...kids) { this._text = ''; this.children = []; this.append(...kids) }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) }
  showModal() { this.open = true }
  close() { if (!this.open) return; this.open = false; for (const f of this.listeners.close ?? []) f({ type: 'close' }) }
  focus() {}
  closest() { return null }
  contains(x) { for (let n = x; n; n = n.parent) if (n === this) return true; return false }
  /** 底下所有 tag 的元素 */
  all(tag) {
    const out = []
    const walk = n => { for (const c of n.children) { if (c.tagName === tag.toUpperCase()) out.push(c); walk(c) } }
    walk(this)
    return out
  }
}

let uiCase = 0
/**
 * 把真的 cleanup-demo.js 掛到假 DOM 上。window.api 是 ui.html 的 api()，打 s 那台 server。
 * 回傳 { $, click, key, idle, apiHook }。
 */
async function mountUi(t, s) {
  const els = new Map()
  for (const [id, spec] of HTML_IDS) {
    const el = new FakeEl(spec.tag, id)
    el.hidden = spec.hidden
    el._text = spec.text
    els.set(id, el)
  }
  const docListeners = {}
  const doc = {
    documentElement: new FakeEl('html'),
    body: new FakeEl('body'),
    getElementById: id => els.get(id) ?? null,
    createElement: tag => new FakeEl(tag),
    createTextNode: text => Object.assign(new FakeEl('#text'), { _text: String(text) }),
    addEventListener: (type, fn) => (docListeners[type] ??= []).push(fn),
  }
  const winListeners = {}
  let apiHook = null
  const pageFetch = (url, init) => s.netFetch(url, init)
  const pageApi = uiApi(pageFetch, doc)
  const win = {
    api: (path, init) => { apiHook?.(path, init?.method ?? 'GET'); return pageApi(path, init) },
    addEventListener: (type, fn) => (winListeners[type] ??= []).push(fn),
  }
  Object.assign(globalThis, {
    document: doc, window: win, Element: FakeEl,
    location: { href: s.base + '/', search: '' },
    history: { state: null, replaceState() {} },
    fetch: (url, init) => pageFetch(url, init),
  })
  await import(`../core/assets/cleanup-demo.js?ui=${++uiCase}`)
  const $ = id => { const el = els.get(id); assert.ok(el, `ui.html 裡沒有 id="${id}"`); return el }
  /** 等到面板與歷史面板都不在「正在…」 */
  const idle = async () => {
    for (let i = 0; i < 300; i++) {
      await new Promise(r => setTimeout(r, 10))
      const busy = [$('cleanup-result'), $('cleanup-history-result')].some(el => !el.hidden && el.textContent.startsWith('正在'))
      const loading = /正在讀取/.test($('cleanup-list').textContent + $('cleanup-history-list').textContent)
      if (!busy && !loading) return
    }
    throw new Error('UI 一直沒有結束')
  }
  const click = async id => { await $(id).onclick?.(); await idle() }
  const key = async k => {
    for (const f of docListeners.keydown ?? []) {
      f({ key: k, target: doc.body, defaultPrevented: false, repeat: false, isComposing: false, preventDefault() {} })
    }
    await idle()
  }
  t.after(async () => {
    await new Promise(r => setTimeout(r, 30))
    for (const f of winListeners.pagehide ?? []) f({ type: 'pagehide' })
  })
  await idle()
  return { $, click, key, idle, setApiHook: fn => { apiHook = fn }, els }
}

/** 面板上清單裡的勾選框（照卡片順序）與它的檔名 */
function panelChecks(ui) {
  return ui.$('cleanup-list').all('article').map(card => ({
    input: card.all('input')[0], name: card.all('strong')[0]?.textContent,
  }))
}

async function uiOnly(ui, ...names) {
  for (const { input, name } of panelChecks(ui)) {
    input.checked = names.includes(name)
    input.onchange()
  }
}

// ═══ RC7 ・ 撞到 CONFLICT 用回應裡的 blockingPlan ════════════════════════

describe('RC7 撞到 CONFLICT 要提示擋住這次勾選的那一份', () => {
  async function twoPlans(t) {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'z.zip': { days: 60 }, 'm.zip': { days: 60 } })
    // 舊的一份佔著 a（上次關掉頁面留下的，或 CLI 建的）；較新的一份只有 z
    const p1 = await s.raw('/cleanup/plans', { method: 'POST', body: JSON.stringify({ candidateIds: await s.idsOf('a.zip') }) })
    await new Promise(r => setTimeout(r, 5))
    const p2 = await s.raw('/cleanup/plans', { method: 'POST', body: JSON.stringify({ candidateIds: await s.idsOf('z.zip') }) })
    return { s, p1, p2 }
  }

  test('**稽查員 a10：舊計畫佔著 a、新計畫只有 z，只勾 a → 提示含 a 的那份，z 不會被搬**', async t => {
    const { s, p1 } = await twoPlans(t)
    const real = createReal(s.api)
    await real.load()
    only(real, 'a.zip')
    s.calls.length = 0
    const r = await real.apply()
    assert.equal(r.status, 'pending-plan', JSON.stringify(r))
    assert.deepEqual(r.plan.items.map(i => i.name), ['a.zip'], '要提示擋住 a 的那一份，不是最新的那一份')
    assert.equal(r.plan.id, p1.id)
    assert.ok(!s.calls.some(c => c.path.includes('pending=1')), '不可以再自己去 ?pending=1 猜')
    const done = await real.apply()          // 使用者按「繼續上次那份」
    assert.equal(done.status, 'applied', JSON.stringify(done))
    assert.ok(!s.has('a.zip'), '上次那份是 a')
    assert.ok(s.has('z.zip'), '**z 不在擋住 a 的那一份裡，不可以被搬**')
    assert.ok(s.has('m.zip'))
  })

  test('對照：同樣兩份計畫，只勾 z → 提示的是只有 z 的那份（不是「永遠拿最舊的」）', async t => {
    const { s, p2 } = await twoPlans(t)
    const real = createReal(s.api)
    await real.load()
    only(real, 'z.zip')
    const r = await real.apply()
    assert.equal(r.status, 'pending-plan', JSON.stringify(r))
    assert.equal(r.plan.id, p2.id)
    assert.deepEqual(r.plan.items.map(i => i.name), ['z.zip'])
  })

  test('409 沒帶 blockingPlan → 照實丟錯、不鎖、不去猜', async t => {
    const { s } = await twoPlans(t)
    // 模擬後端找不到擋住的那份（blockingPlan: null）：把 ui.html 的 api 丟出來的 data 改掉
    const api = async (path, init) => {
      try { return await s.api(path, init) }
      catch (e) { if (e.data) e.data = { ...e.data, blockingPlan: null }; throw e }
    }
    const real = createReal(api)
    await real.load()
    only(real, 'a.zip')
    s.calls.length = 0
    const e = await real.apply().catch(e => e)
    assert.equal(e.code, 'CONFLICT', String(e))
    assert.equal(real.locked, false, '伺服器明確回了 409，不是結果不明')
    assert.ok(!s.calls.some(c => c.path.includes('pending=1')), '不可以再自己去 ?pending=1 猜')
    assert.ok(s.has('a.zip') && s.has('z.zip') && s.has('m.zip'))
  })

  test('ui.html 的 window.api 要把回應本體帶上來（blockingPlan 在裡面）', async () => {
    const body = { error: '這個檔案已有待處理的清理計畫。', code: 'CONFLICT', blockingPlan: { id: 'p1', status: 'proposed', items: [{ itemId: 'i', name: 'a.zip', bytes: 1 }] } }
    const api = uiApi(async () => ({ ok: false, status: 409, json: async () => body }))
    const e = await api('/cleanup/plans', { method: 'POST', body: '{}' }).catch(e => e)
    assert.equal(e.message, body.error)
    assert.equal(e.code, 'CONFLICT')
    assert.equal(e.status, 409)
    assert.deepEqual(e.data?.blockingPlan, body.blockingPlan)
  })
})

// ═══ RC8 ・ 面板不可以鎖死 ═════════════════════════════════════════════

/** 隔離區路徑經過捷徑 → 每次 apply 都回 500 UNSAFE_PATH（沒動任何檔） */
const unsafeQuarantine = dir => {
  mkdirSync(join(dir, 'real-home'))
  symlinkSync(join(dir, 'real-home'), join(dir, 'home'))
  return join(dir, 'home', '.contextbox', 'quarantine')
}

describe('RC8 伺服器明確回錯就解鎖；撞到卡住的計畫可以放棄', () => {
  test('**稽核預期：隔離區路徑不安全（每次 500）→ 按一次清理 → 顯示原因、不鎖住、勾選可以改**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } }, { quarantine: unsafeQuarantine })
    const real = createReal(s.api)
    await real.load()
    const e = await real.apply().catch(e => e)
    assert.equal(e.status, 500, String(e))
    assert.match(e.message, /捷徑/, '原因要照後端說的講')
    assert.equal(real.locked, false, '伺服器明確回了 500，不是「結果不明」')
    const a = s.byName(real, 'a.zip').itemId
    real.select(a, false)
    assert.equal(real.selected.has(a), false, '勾選要可以改')
    assert.ok(s.has('a.zip') && s.has('b.zip'))
    // 再按一次（勾選沒變）還是同一個原因，不是 CONFLICT、不是鎖住
    real.select(a, true)
    const again = await real.apply().catch(e => e)
    assert.equal(again.status, 500, String(again))
    assert.equal(real.locked, false)
  })

  test('對照：apply 的回應在網路上丟了（沒有 status）→ 才鎖住', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const real = createReal(s.api)
    await real.load()
    s.setHook((p, m) => (m === 'POST' && p.endsWith('/apply') ? 'lose' : undefined))
    await assert.rejects(real.apply())
    assert.equal(real.locked, true)
    assert.equal(real.uncertain, true)
  })

  test('「繼續上次那份」伺服器回錯 → 解鎖（pendingPlan 清掉）', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } }, { quarantine: unsafeQuarantine })
    await s.raw('/cleanup/plans', { method: 'POST', body: JSON.stringify({ candidateIds: await s.idsOf('a.zip') }) })
    const real = createReal(s.api)
    await real.load()
    const p = await real.apply()
    assert.equal(p.status, 'pending-plan', JSON.stringify(p))
    const e = await real.apply().catch(e => e)       // 繼續上次那份 → 500
    assert.equal(e.status, 500, String(e))
    assert.equal(real.pendingPlan, null, '伺服器明確回錯，不可以一直卡在「繼續上次那份」')
    assert.equal(real.locked, false)
  })

  test('對照：「繼續上次那份」回應丟了 → 還是那一份、還鎖著；再按一次接得完', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    const blocking = await s.raw('/cleanup/plans', { method: 'POST', body: JSON.stringify({ candidateIds: await s.idsOf('a.zip') }) })
    const real = createReal(s.api)
    await real.load()
    assert.equal((await real.apply()).status, 'pending-plan')
    s.setHook((p, m) => (m === 'POST' && p.endsWith('/apply') ? 'lose' : undefined))
    await assert.rejects(real.apply())
    s.setHook(null)
    assert.equal(real.pendingPlan?.id, blocking.id, '結果不明：還是要提示同一份')
    assert.equal(real.locked, true)
    const r = await real.apply()
    assert.equal(r.status, 'applied')
    assert.equal(r.moved, 1)
    assert.ok(!s.has('a.zip') && s.has('b.zip'))
  })

  test('**放棄上次那份：呼叫 release，不動任何檔、不作廢候選；之後同樣的勾選清得掉**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    const blocking = await s.raw('/cleanup/plans', { method: 'POST', body: JSON.stringify({ candidateIds: await s.idsOf('a.zip') }) })
    const real = createReal(s.api)
    await real.load()
    only(real, 'a.zip')
    assert.equal((await real.apply()).status, 'pending-plan')
    s.calls.length = 0
    const r = await real.release()
    assert.equal(r.status, 'released', JSON.stringify(r))
    assert.ok(s.calls.some(c => c.method === 'POST' && c.path === `/cleanup/plans/${blocking.id}/release`), '要真的呼叫 release')
    assert.equal(s.planStatus(blocking.id), 'dismissed')
    assert.ok(s.has('a.zip') && s.has('b.zip'), '放棄不動任何檔')
    const cand = s.q(`SELECT c.status FROM cleanup_candidates c JOIN file_items f ON f.id=c.item_id WHERE f.name='a.zip'`)
    assert.ok(cand.length && cand.every(c => c.status === 'proposed'), `候選不可以被作廢：${JSON.stringify(cand)}`)
    assert.equal(real.locked, false)
    assert.equal(real.pendingPlan, null)
    assert.ok(real.candidates.some(c => c.name === 'a.zip'), 'a 還在清單上')
    assert.ok(real.selected.has(s.byName(real, 'a.zip').itemId), '使用者的勾選沒變')
    const done = await real.apply()
    assert.equal(done.status, 'applied', JSON.stringify(done))
    assert.ok(!s.has('a.zip'), '同樣的勾選再清一次要搬得動')
    assert.ok(s.has('b.zip'), '沒勾的 b 不可以動')
  })

  test('放棄的回應丟了 → 還鎖著；再按一次放棄（冪等）就解開', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const blocking = await s.raw('/cleanup/plans', { method: 'POST', body: JSON.stringify({ candidateIds: await s.idsOf('a.zip') }) })
    const real = createReal(s.api)
    await real.load()
    assert.equal((await real.apply()).status, 'pending-plan')
    s.setHook((p, m) => (m === 'POST' && p.endsWith('/release') ? 'lose' : undefined))
    await assert.rejects(real.release())
    s.setHook(null)
    assert.equal(real.locked, true, '不知道放棄了沒有，還是那一份')
    assert.equal(real.pendingPlan?.id, blocking.id)
    const r = await real.release()
    assert.equal(r.status, 'released')
    assert.equal(real.locked, false)
    assert.ok(s.has('a.zip'))
  })

  test('**稽查員 H4：套用成功、重載清單失敗 → 還是回「已經搬了 1 個」，不丟例外**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const real = createReal(s.api)
    await real.load()
    let applied = false
    s.setHook((p, m) => {
      if (m === 'POST' && p.endsWith('/apply')) { applied = true; return undefined }
      if (applied && p.startsWith('/cleanup/candidates')) return 'before'
    })
    const r = await real.apply().catch(e => e)
    assert.ok(!(r instanceof Error), `不可以丟例外：${r}`)
    assert.equal(r.status, 'applied')
    assert.equal(r.moved, 1, '檔案已經搬了，重載失敗不可以蓋掉這件事')
    assert.equal(r.reloadFailed, true)
    assert.equal(real.locked, false)
    assert.equal(real.canUndo, true)
    assert.ok(!s.has('a.zip'))
  })

  test('對照：重載成功就沒有 reloadFailed', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const real = createReal(s.api)
    await real.load()
    const r = await real.apply()
    assert.equal(r.moved, 1)
    assert.ok(!r.reloadFailed)
  })
})

describe('RC8 面板（假 DOM 上跑真的 cleanup-demo.js）', () => {
  test('**隔離區路徑不安全 → 面板顯示原因、勾選框可以按、不說「結果還沒確認」**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } }, { quarantine: unsafeQuarantine })
    const ui = await mountUi(t, s)
    await ui.click('quaso-cleanup-alert')
    assert.equal(panelChecks(ui).length, 2, ui.$('cleanup-list').textContent)
    await ui.click('cleanup-apply')
    const text = ui.$('cleanup-result').textContent
    assert.match(text, /捷徑/, text)
    assert.ok(!/還沒確認/.test(text), `伺服器明確回錯，不可以說結果不明：${text}`)
    for (const { input, name } of panelChecks(ui)) assert.equal(input.disabled, false, `${name} 的勾選框被鎖住了`)
    assert.equal(ui.$('cleanup-release').hidden, true, '沒有卡住的計畫，不要出現「放棄上次那份」')
    await uiOnly(ui, 'a.zip')
    assert.match(ui.$('cleanup-summary').textContent, /已選 1 \/ 2/)
  })

  test('**撞到卡住的計畫：兩個按鈕「繼續上次那份」與「放棄上次那份」；放棄不動任何檔**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'z.zip': { days: 60 }, 'm.zip': { days: 60 } })
    const p1 = await s.raw('/cleanup/plans', { method: 'POST', body: JSON.stringify({ candidateIds: await s.idsOf('a.zip') }) })
    await new Promise(r => setTimeout(r, 5))
    await s.raw('/cleanup/plans', { method: 'POST', body: JSON.stringify({ candidateIds: await s.idsOf('z.zip') }) })
    const ui = await mountUi(t, s)
    await ui.click('quaso-cleanup-alert')
    await uiOnly(ui, 'a.zip')
    await ui.click('cleanup-apply')
    const text = ui.$('cleanup-result').textContent
    assert.match(text, /a\.zip/, text)
    assert.ok(!/z\.zip/.test(text), `提示的不可以是 z 那份：${text}`)
    assert.equal(ui.$('cleanup-apply').textContent, '繼續上次那份（1 個）')
    assert.equal(ui.$('cleanup-release').hidden, false, '要有「放棄上次那份」')
    assert.equal(ui.$('cleanup-release').textContent, '放棄上次那份')
    await ui.click('cleanup-release')
    const after = ui.$('cleanup-result').textContent
    assert.match(after, /放棄/, after)
    assert.match(after, /沒有動任何檔案/, after)
    assert.equal(s.planStatus(p1.id), 'dismissed')
    assert.ok(s.has('a.zip') && s.has('z.zip') && s.has('m.zip'))
    assert.equal(ui.$('cleanup-release').hidden, true)
    for (const { input, name } of panelChecks(ui)) assert.equal(input.disabled, false, `${name} 的勾選框被鎖住了`)
  })

  test('稽查員 H4（面板）：套用成功、重載失敗 → 結果框還是說搬了 1 個', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const ui = await mountUi(t, s)
    await ui.click('quaso-cleanup-alert')
    let applied = false
    s.setHook((p, m) => {
      if (m === 'POST' && p.endsWith('/apply')) { applied = true; return undefined }
      if (applied && p.startsWith('/cleanup/candidates')) return 'before'
    })
    await ui.click('cleanup-apply')
    const text = ui.$('cleanup-result').textContent
    assert.match(text, /搬進隔離區 1 個檔案/, text)
    assert.ok(!s.has('a.zip'))
  })
})

// ═══ RC9 ・ 復原要照結果講 ═════════════════════════════════════════════

describe('RC9 歷史轉接器：notRestored、先前已復原只算復原前就不在隔離區的', () => {
  async function appliedOne(t, files, ...names) {
    const s = await serve(t, files)
    const real = createReal(s.api)
    await real.load()
    only(real, ...names)
    const r = await real.apply()
    assert.equal(r.moved, names.length, JSON.stringify(r))
    return { s, planId: r.planId }
  }

  test('**稽查員 H6：隔離區的檔被改過 → 0 個放回、1 個沒放回（附原因），不是「先前已復原」**', async t => {
    const { s, planId } = await appliedOne(t, { 'a.zip': { days: 60 } }, 'a.zip')
    s.tamper('a.zip')
    const h = createRealHistory(s.api)
    const u = await h('undo', { operationIds: [planId] })
    assert.equal(u.restoredFiles, 0)
    assert.equal(u.restored, 0)
    assert.equal(u.alreadyRestored, 0, '檔案還在隔離區，不可以說「先前已復原」')
    assert.equal(u.notRestored?.length, 1, JSON.stringify(u))
    assert.equal(u.notRestored[0].name, 'a.zip')
    const plan = await s.raw(`/cleanup/plans/${planId}`)
    assert.ok(u.notRestored[0].why && !/原因不明/.test(u.notRestored[0].why), `要講得出為什麼：${u.notRestored[0].why}`)
    assert.equal(u.notRestored[0].why, plan.items[0].why, 'why 照後端的逐項結果')
  })

  test('稽查員 H6 另一種：使用者把清空的子資料夾刪了 → 放不回去，也不是「先前已復原」', async t => {
    const { s, planId } = await appliedOne(t, { 'sub/a.zip': { days: 60 } }, 'a.zip')
    rmSync(join(s.downloads, 'sub'), { recursive: true })
    const u = await createRealHistory(s.api)('undo', { operationIds: [planId] })
    assert.equal(u.alreadyRestored, 0)
    assert.deepEqual(u.notRestored.map(x => x.name), ['a.zip'])
    assert.ok(u.notRestored[0].why)
  })

  test('部分放回：一份計畫兩個檔、一個被改過 → 1 放回、1 沒放回', async t => {
    const { s, planId } = await appliedOne(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } }, 'a.zip', 'b.zip')
    s.tamper('b.zip')
    const u = await createRealHistory(s.api)('undo', { operationIds: [planId] })
    assert.equal(u.restoredFiles, 1)
    assert.equal(u.restored, 1, '有放回任何一個的份數')
    assert.deepEqual(u.notRestored.map(x => x.name), ['b.zip'])
    assert.equal(u.alreadyRestored, 0)
    assert.ok(s.has('a.zip'))
  })

  test('對照：成功復原過的再送一次 → 先前已復原 1、沒放回 0', async t => {
    const { s, planId } = await appliedOne(t, { 'a.zip': { days: 60 } }, 'a.zip')
    const h = createRealHistory(s.api)
    const first = await h('undo', { operationIds: [planId] })
    assert.equal(first.restoredFiles, 1)
    assert.deepEqual(first.notRestored, [])
    const again = await h('undo', { operationIds: [planId] })
    assert.equal(again.alreadyRestored, 1)
    assert.deepEqual(again.notRestored, [])
    assert.equal(again.restoredFiles, 0)
  })

  test('對照：復原失敗過的再送一次 → 還是「沒放回」，不會變成「先前已復原」', async t => {
    const { s, planId } = await appliedOne(t, { 'a.zip': { days: 60 } }, 'a.zip')
    s.tamper('a.zip')
    const h = createRealHistory(s.api)
    await h('undo', { operationIds: [planId] })
    const again = await h('undo', { operationIds: [planId] })
    assert.equal(again.alreadyRestored, 0)
    assert.equal(again.notRestored.length, 1)
  })

  test('**性質：放回＋沒放回＝復原前在隔離區的檔數；先前已復原＝復原前一個都不在隔離區的份數**（結構化隨機 12 輪）', async t => {
    const rng = seed => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const hits = { allBack: 0, partial: 0, noneBack: 0, already: 0 }
    for (let round = 0; round < 12; round++) {
      const seed = 104729 * (round + 1)
      const r = rng(seed)
      // 種子：第 0 輪全部被改過、第 1 輪有一份先復原過、第 2 輪都好好的、第 3 輪兩份裡改掉一個檔，其他隨機
      const nPlans = round === 1 || round === 3 ? 2 : 1 + Math.floor(r() * 3)
      const files = {}
      const groups = []
      for (let p = 0; p < nPlans; p++) {
        const g = []
        for (let i = 0; i < 1 + Math.floor(r() * 2); i++) { const n = `p${p}f${i}.zip`; files[n] = { days: 60 }; g.push(n) }
        groups.push(g)
      }
      const s = await serve(t, files)
      const ids = []
      for (const g of groups) {
        const real = createReal(s.api)
        await real.load()
        only(real, ...g)
        ids.push((await real.apply()).planId)
      }
      const preRestored = new Set(), tampered = new Set()
      groups.forEach((g, p) => {
        if ((round === 1 && p === 0) || (round > 3 && r() < 0.25)) { preRestored.add(p); return }
        g.forEach((n, i) => {
          if (round === 0 || (round === 3 && p === 0 && i === 0) || (round > 3 && r() < 0.35)) tampered.add(n)
        })
      })
      const h = createRealHistory(s.api)
      for (const p of preRestored) await h('undo', { operationIds: [ids[p]] })
      const before = new Map()
      for (const id of ids) before.set(id, (await s.raw(`/cleanup/plans/${id}`)).items.filter(i => i.outcome === 'moved').length)
      for (const n of tampered) s.tamper(n)
      const u = await h('undo', { operationIds: ids })
      const movedBefore = [...before.values()].reduce((a, b) => a + b, 0)
      assert.equal(u.restoredFiles + u.notRestored.length, movedBefore, `seed ${seed}：放回＋沒放回 ≠ 復原前在隔離區的 ${movedBefore}：${JSON.stringify(u)}`)
      assert.equal(u.alreadyRestored, [...before.values()].filter(n => n === 0).length, `seed ${seed}：先前已復原算錯`)
      const m = historyUndoMessage(u)
      if (u.notRestored.length) assert.ok(!/都幫你放回來了/.test(m.text + m.notice), `seed ${seed}：有沒放回的卻說都放回來了`)
      if (!u.notRestored.length && u.restoredFiles) { assert.equal(m.notice, '都幫你放回來了！'); hits.allBack++ }
      if (u.notRestored.length && u.restoredFiles) hits.partial++
      if (u.notRestored.length && !u.restoredFiles) hits.noneBack++
      if (u.alreadyRestored) hits.already++
    }
    for (const [k, min] of Object.entries({ allBack: 1, partial: 1, noneBack: 1, already: 1 })) {
      assert.ok(hits[k] >= min, `生成器沒走到「${k}」：${JSON.stringify(hits)}`)
    }
  })
})

describe('RC9 寵物台詞看結果決定', () => {
  const why = '隔離區檔案已變更，無法安全復原。'
  test('**歷史：0 個放回 → 「0 個放回；1 個沒放回：（原因）」，不可以說「都幫你放回來了」**', () => {
    const m = historyUndoMessage({ restored: 0, restoredFiles: 0, alreadyRestored: 0, notRestored: [{ name: 'a.zip', why }], renamed: [] })
    assert.ok(m.text.includes('0 個放回；1 個沒放回：'), m.text)
    assert.ok(m.text.includes(why), m.text)
    assert.ok(!/都幫你放回來了/.test(m.text + m.notice), m.notice)
  })
  test('歷史：部分放回 → 「1 個放回；1 個沒放回：」、台詞不是「都幫你放回來了」', () => {
    const m = historyUndoMessage({ restored: 1, restoredFiles: 1, alreadyRestored: 0, notRestored: [{ name: 'b.zip', why }], renamed: [] })
    assert.ok(m.text.includes('1 個放回；1 個沒放回：'), m.text)
    assert.ok(!/都幫你放回來了/.test(m.notice), m.notice)
  })
  test('歷史：全部放回 → 「都幫你放回來了！」', () => {
    const m = historyUndoMessage({ restored: 2, restoredFiles: 3, alreadyRestored: 0, notRestored: [], renamed: [] })
    assert.equal(m.notice, '都幫你放回來了！')
    assert.ok(!/沒放回/.test(m.text), m.text)
  })
  test('三種情況的台詞兩兩不同', () => {
    const none = historyUndoMessage({ restored: 0, restoredFiles: 0, alreadyRestored: 0, notRestored: [{ name: 'a', why }], renamed: [] }).notice
    const part = historyUndoMessage({ restored: 1, restoredFiles: 1, alreadyRestored: 0, notRestored: [{ name: 'a', why }], renamed: [] }).notice
    const all = historyUndoMessage({ restored: 1, restoredFiles: 1, alreadyRestored: 0, notRestored: [], renamed: [] }).notice
    assert.equal(new Set([none, part, all]).size, 3, JSON.stringify([none, part, all]))
    const pNone = undoMessage({ restored: 0, notRestored: [{ name: 'a', why }], renamed: [] }).notice
    const pPart = undoMessage({ restored: 1, notRestored: [{ name: 'a', why }], renamed: [] }).notice
    const pAll = undoMessage({ restored: 1, notRestored: [], renamed: [] }).notice
    assert.equal(new Set([pNone, pPart, pAll]).size, 3, JSON.stringify([pNone, pPart, pAll]))
    assert.equal(pAll, '都幫你放回來了！')
  })

  test('**面板的復原（createReal.undo）：隔離區的檔被改過 → notRestored 帶原因**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const real = createReal(s.api)
    await real.load()
    await real.apply()
    s.tamper('a.zip')
    const r = await real.undo()
    assert.equal(r.restored, 0)
    assert.equal(r.notRestored?.length, 1, JSON.stringify(r))
    assert.ok(r.notRestored[0].why && !/原因不明/.test(r.notRestored[0].why))
    const m = undoMessage(r)
    assert.ok(m.text.includes('0 個放回；1 個沒放回：'), m.text)
    assert.ok(!/都幫你放回來了/.test(m.text + m.notice))
  })

  test('面板的復原再按一次：只算這一次放回的，不把上一次放回的再算一遍', async t => {
    // 突變測試抓到的洞：用 restoredCount（這份計畫曾經放回的全部）的話，第二次會說放回 2 個
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    const real = createReal(s.api)
    await real.load()
    assert.equal((await real.apply()).moved, 2)
    s.tamper('b.zip')
    const first = await real.undo()
    assert.equal(first.restored, 1)
    assert.deepEqual(first.notRestored.map(x => x.name), ['b.zip'])
    assert.equal(real.canUndo, true, 'b 還在隔離區，還能再復原')
    s.untamper('b.zip')
    const second = await real.undo()
    assert.equal(second.restored, 1, `這一次只放回 b：${JSON.stringify(second)}`)
    assert.deepEqual(second.notRestored, [])
    assert.equal(undoMessage(second).text, '放回原位 1 個檔案。')
    assert.ok(s.has('a.zip') && s.has('b.zip'))
    assert.equal(real.canUndo, false)
  })

  test('面板的復原（假 DOM）：沒放回 → 結果框照實講、寵物不說「都幫你放回來了」', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const ui = await mountUi(t, s)
    await ui.click('quaso-cleanup-alert')
    await ui.click('cleanup-apply')
    assert.match(ui.$('cleanup-result').textContent, /搬進隔離區 1 個檔案/)
    s.tamper('a.zip')
    await ui.click('cleanup-undo')
    const text = ui.$('cleanup-result').textContent
    assert.ok(text.includes('0 個放回；1 個沒放回：'), text)
    assert.ok(text.includes('隔離區檔案已變更'), text)
    assert.ok(!/都幫你放回來了/.test(ui.$('quaso-status').textContent), ui.$('quaso-status').textContent)
  })

  test('對照（假 DOM）：面板復原全部放回 → 「都幫你放回來了！」', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const ui = await mountUi(t, s)
    await ui.click('quaso-cleanup-alert')
    await ui.click('cleanup-apply')
    await ui.click('cleanup-undo')
    assert.equal(ui.$('quaso-status').textContent, '都幫你放回來了！')
    assert.ok(s.has('a.zip'))
  })

  test('**歷史面板（假 DOM）：隔離區的檔被改過 → 「0 個放回；1 個沒放回：（原因）」，寵物不說「都幫你放回來了」**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const real = createReal(s.api)
    await real.load()
    await real.apply()
    s.tamper('a.zip')
    const ui = await mountUi(t, s)
    await ui.click('quaso-history-open')
    const boxes = ui.$('cleanup-history-list').all('input')
    assert.equal(boxes.length, 1, ui.$('cleanup-history-list').textContent)
    boxes[0].checked = true
    boxes[0].onchange()
    await ui.click('cleanup-history-undo')
    const text = ui.$('cleanup-history-result').textContent
    assert.ok(text.includes('0 個放回；1 個沒放回：'), text)
    assert.ok(text.includes('隔離區檔案已變更'), text)
    assert.ok(!/都幫你放回來了/.test(text), text)
    assert.ok(!/都幫你放回來了/.test(ui.$('quaso-status').textContent), ui.$('quaso-status').textContent)
  })
})

// ═══ RC10 ・ 歷史面板的說明文字跟著模式 ════════════════════════════════

describe('RC10 歷史面板的說明文字', () => {
  test('**本機模式：「每次清理為一筆，勾選後會把那一次搬走的檔案放回原位。」；示範模式才說「模擬」**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const ui = await mountUi(t, s)
    await ui.click('quaso-history-open')
    assert.equal(ui.$('cleanup-history-note').textContent, LOCAL_HISTORY_NOTE)
    ui.$('cleanup-history-panel').close()
    await ui.key('d')                        // 打開示範模式
    for (let i = 0; i < 100 && ui.$('quaso-candidate-count').textContent !== '4'; i++) await new Promise(r => setTimeout(r, 10))
    await ui.click('quaso-history-open')
    const demo = ui.$('cleanup-history-note').textContent
    assert.match(demo, /模擬/, demo)
    assert.match(demo, /不會更動真實檔案/, demo)
    ui.$('cleanup-history-panel').close()
    await ui.key('d')                        // 關掉示範模式
    await ui.click('quaso-history-open')
    assert.equal(ui.$('cleanup-history-note').textContent, LOCAL_HISTORY_NOTE)
  })

  test('ui.html 的預設文字就是本機那一句（頁面一打開就是本機模式）', () => {
    assert.equal(HTML_IDS.get('cleanup-history-note')?.text, LOCAL_HISTORY_NOTE)
  })
})

// ═══ RC14 ・ 檔名裡的控制字元 ══════════════════════════════════════════

describe('RC14 訊息裡的檔名把控制字元與換行換成「·」', () => {
  test('例子', () => {
    assert.equal(safeName('a\n搬進隔離區 99 個檔案.zip'), 'a·搬進隔離區 99 個檔案.zip')
    assert.equal(safeName('b\u001b]8;;http://x\u0007y.zip'), 'b·]8;;http://x·y.zip')
    assert.equal(safeName('c\r\nd.zip'), 'c··d.zip')
    assert.equal(safeName('e\u0085f\u009bg.zip'), 'e·f·g.zip')
    assert.equal(safeName('h\u2028i\u2029j.zip'), 'h·i·j.zip')
    assert.equal(safeName('tab\there\u007f.zip'), 'tab·here·.zip')
    assert.equal(safeName('報告 (1).pdf'), '報告 (1).pdf', '一般檔名原樣')
    assert.equal(safeName('下載📥.zip'), '下載📥.zip', 'emoji 不是控制字元')
  })

  test('性質：輸出沒有控制字元與換行、長度不變、沒有控制字元的字串原樣（結構化隨機 500 個）', () => {
    const pool = ['a', '報', '📥', ' ', '.', '\n', '\r', '\t', '\u0000', '\u001b', '\u007f', '\u0080', '\u0085', '\u009f', '\u00a0', '\u2028', '\u2029', '\u200b', '·']
    const bad = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
    let seed = 42
    const r = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    let withBad = 0, clean = 0
    for (let i = 0; i < 500; i++) {
      const s = Array.from({ length: Math.floor(r() * 12) }, () => pool[Math.floor(r() * pool.length)]).join('')
      const out = safeName(s)
      assert.ok(!bad.test(out), JSON.stringify(s))
      assert.equal(out.length, s.length, JSON.stringify(s))
      if (bad.test(s)) withBad++
      else { clean++; assert.equal(out, s) }
    }
    assert.ok(withBad > 50 && clean > 20, `生成器：${withBad} / ${clean}`)
  })

  test('**面板（假 DOM）：檔名裡的換行不可以在結果框偽造一行**', async t => {
    const evil = 'a\n搬進隔離區 99 個檔案，1.0 GB。七天內可以復原。.zip'
    const s = await serve(t, { [evil]: { days: 60 }, 'ok.zip': { days: 60 } })
    const ui = await mountUi(t, s)
    await ui.click('quaso-cleanup-alert')
    rmSync(join(s.downloads, evil))          // 按下去之前被刪掉 → 失敗，檔名會出現在結果框
    await ui.click('cleanup-apply')
    const lines = ui.$('cleanup-result').textContent.split('\n')
    assert.ok(!lines.some(l => l.startsWith('搬進隔離區 99')), `檔名偽造了一行：${JSON.stringify(lines)}`)
    assert.ok(lines.some(l => l.includes('a·搬進隔離區 99')), JSON.stringify(lines))
    const names = panelChecks(ui).map(c => c.name)
    assert.ok(names.every(n => !/\n/.test(n)), JSON.stringify(names))
  })

  test('提示上次那份、復原的訊息也一樣', () => {
    const plan = { id: 'p', items: [{ itemId: 'i', name: 'x\n・y.zip —— 已經搬走了', bytes: 1 }] }
    assert.ok(!pendingPlanMessage(plan).includes('x\n'), pendingPlanMessage(plan))
    const m = historyUndoMessage({ restored: 0, restoredFiles: 0, alreadyRestored: 0, notRestored: [{ name: 'x\ny', why: 'w' }], renamed: [] })
    assert.ok(m.text.includes('x·y'), m.text)
    const p = undoMessage({ restored: 1, notRestored: [], renamed: [{ name: 'r\nq.zip', restoredAs: 'r\nq.zip.restored' }] })
    assert.ok(p.text.includes('r·q.zip') && !p.text.includes('r\nq'), p.text)
  })
})

// ═══ RC16 ・ 網址上的鑰匙 ══════════════════════════════════════════════

describe('RC16 頁面：載入後把 k 從網址列拿掉', () => {
  const fnSrc = () => {
    const src = /function keepKeyOutOfAddressBar\([\s\S]*?\n\}/.exec(UI_HTML)?.[0]
    assert.ok(src, 'ui.html 裡找不到 keepKeyOutOfAddressBar()')
    return new Function(src + '\nreturn keepKeyOutOfAddressBar')()
  }
  function fakes(href) {
    const replaced = [], navigated = []
    const retry = new FakeEl('button', 'quaso-retry')
    return {
      replaced, navigated, retry,
      loc: { href, replace: u => navigated.push(u) },
      hist: { state: null, replaceState: (s, t, u) => replaced.push(String(u)) },
      doc: { getElementById: id => (id === 'quaso-retry' ? retry : null) },
    }
  }

  test('**只拿掉 k，其他參數與 # 留著**', () => {
    const f = fakes('http://127.0.0.1:7391/?k=abc&mockBackend=offline#x')
    fnSrc()('abc', f.loc, f.hist, f.doc)
    assert.deepEqual(f.replaced, ['/?mockBackend=offline#x'])
  })

  test('只有 k → 網址列剩 /', () => {
    const f = fakes('http://127.0.0.1:7391/?k=abc')
    fnSrc()('abc', f.loc, f.hist, f.doc)
    assert.deepEqual(f.replaced, ['/'])
  })

  test('對照：沒帶 k 就不動網址列', () => {
    const f = fakes('http://127.0.0.1:7391/?mockBackend=offline')
    fnSrc()('abc', f.loc, f.hist, f.doc)
    assert.deepEqual(f.replaced, [])
  })

  test('「重新載入」要帶鑰匙重開（k 拿掉之後 location.reload() 會拿到 401），而且攔在別人的 onclick 之前', () => {
    const f = fakes('http://127.0.0.1:7391/?k=a%2Bb&mockBackend=offline')
    fnSrc()('a+b', f.loc, f.hist, f.doc)
    f.loc.href = 'http://127.0.0.1:7391/?mockBackend=offline'   // replaceState 之後
    let stopped = false
    for (const fn of f.retry.listeners.click ?? []) fn({ stopImmediatePropagation() { stopped = true }, preventDefault() {} })
    assert.equal(f.navigated.length, 1)
    const u = new URL(f.navigated[0])
    assert.equal(u.searchParams.get('k'), 'a+b')
    assert.equal(u.searchParams.get('mockBackend'), 'offline')
    assert.equal(stopped, true, 'pet-viewer.js 的 onclick 是 location.reload()，要攔下來')
  })

  test('頁面一載入就呼叫，而且 ui.html 裡不再有 location.reload()', () => {
    assert.match(UI_HTML, /\nkeepKeyOutOfAddressBar\(TOKEN\)\n/)
    assert.ok(!/location\.reload\(\)/.test(UI_HTML), 'k 拿掉之後 reload 會拿到 401')
    const at = UI_HTML.indexOf('\nkeepKeyOutOfAddressBar(TOKEN)')
    const tokenAt = UI_HTML.indexOf('const TOKEN = __TOKEN__')
    assert.ok(tokenAt > 0 && at > tokenAt, '要在 TOKEN 定義之後')
    assert.ok(at < UI_HTML.indexOf('async function api('), '要在其他程式之前，越早拿掉越好')
  })

  test('server 送出的頁面（帶對的 k）裡有這一段', async t => {
    const s = await serve(t, {})
    const r = await realFetch(`${s.base}/?k=${encodeURIComponent(TOKEN)}`, { headers: { 'sec-fetch-dest': 'document' } })
    assert.equal(r.status, 200)
    const html = await r.text()
    assert.match(html, /keepKeyOutOfAddressBar\("ui-audit-token"\)|keepKeyOutOfAddressBar\(TOKEN\)/)
  })
})

describe('RC16 擴充套件：「去補」要帶 ?k= 開手填頁，而且 k 不進網頁的 DOM', () => {
  const BG = readFileSync(join(REPO, 'extension/background.js'), 'utf8')
  const CONTENT = readFileSync(join(REPO, 'extension/content.js'), 'utf8')

  function loadBackground({ token, port }) {
    const listeners = [], created = []
    const chrome = {
      storage: { local: { get: async defaults => ({ ...defaults, token, port }) } },
      runtime: { onMessage: { addListener: f => listeners.push(f) }, onInstalled: { addListener() {} }, openOptionsPage() {} },
      tabs: { create: async o => { created.push(o); return { id: 1 } } },
    }
    vm.runInNewContext(BG, { chrome, fetch: realFetch, AbortSignal, console, URL, encodeURIComponent })
    const send = msg => new Promise(resolve => {
      const keep = listeners[0](msg, { id: 'ext', origin: 'https://jobs.example.com', tab: { id: 9 } }, resolve)
      if (keep !== true) resolve(undefined)
    })
    return { send, created }
  }

  test('**背景程式開 http://127.0.0.1:<port>/?k=<token>，那個網址打得開（200）**', async t => {
    const s = await serve(t, {})
    const bg = loadBackground({ token: TOKEN, port: s.port })
    const r = await bg.send({ type: 'open-home' })
    assert.equal(r?.ok, true, JSON.stringify(r))
    assert.equal(bg.created.length, 1)
    assert.equal(bg.created[0].url, `http://127.0.0.1:${s.port}/?k=${encodeURIComponent(TOKEN)}`)
    const page = await realFetch(bg.created[0].url, { headers: { 'sec-fetch-dest': 'document' } })
    assert.equal(page.status, 200, '帶了 k 的網址要打得開')
    assert.ok(!('token' in r) && !JSON.stringify(r).includes(TOKEN), 'token 不可以回到 content script 那一側')
  })

  test('token 有特殊字元也要編碼', async t => {
    const bg = loadBackground({ token: 'a+b/c=', port: 7391 })
    await bg.send({ type: 'open-home' })
    assert.equal(bg.created[0]?.url, 'http://127.0.0.1:7391/?k=a%2Bb%2Fc%3D')
  })

  test('對照：還沒設定 token → 不開分頁，回 NO_TOKEN', async () => {
    const bg = loadBackground({ token: '', port: 7391 })
    const r = await bg.send({ type: 'open-home' })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'NO_TOKEN')
    assert.equal(bg.created.length, 0)
  })

  test('content script：「去補」送 open-home 給背景程式，不自己拼 127.0.0.1 的網址', () => {
    assert.ok(/type:\s*'open-home'/.test(CONTENT), 'content.js 沒有送 open-home')
    assert.ok(!/href\s*=\s*HOME/.test(CONTENT), '「去補」還是直接連到沒帶 k 的網址（會 401）')
    assert.ok(!/http:\/\/127\.0\.0\.1/.test(CONTENT.replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '')),
      'content.js 的程式碼裡不該再有 127.0.0.1 的網址（網址由背景程式組）')
    // 硬規則 4：content.js 不准持有 token —— 程式碼（註解以外）裡不可以出現這個字
    const code = CONTENT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    assert.ok(!/token/i.test(code), code.split('\n').filter(l => /token/i.test(l)).join('\n'))
  })
})

// ═══ RC17(3) ・ 「原檔都還在原位」只在全部是 failed 時說 ════════════════

describe('RC17(3) 失敗訊息照 outcome 講', () => {
  async function planWith(t) {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 }, 'c.zip': { days: 60 } })
    const real = createReal(s.api)
    await real.load()
    rmSync(join(s.downloads, 'b.zip'))        // b 失敗（不見了）
    const r = await real.apply()
    return { s, r }
  }

  test('**全部失敗的都是 failed → 說「原檔都還在原位」**', async t => {
    const { r } = await planWith(t)
    assert.equal(r.failed.length, 1)
    assert.deepEqual(r.unknown, [])
    const m = applyMessage(r)
    assert.ok(m.text.includes('原檔都還在原位'), m.text)
    assert.ok(m.text.includes('b.zip'), m.text)
  })

  test('**有一個是 unknown（搬到一半中斷）→ 不可以說「原檔都還在原位」，要照實講狀態不明**', async t => {
    const { s, r } = await planWith(t)
    // a 的 journal 停在 started：搬到一半中斷（kill -9、斷電）
    s.exec(`UPDATE cleanup_journal SET status='started' WHERE op='quarantine'
              AND item_id=(SELECT id FROM file_items WHERE name='a.zip')`)
    const plan = await s.raw(`/cleanup/plans/${r.planId}`)
    const o = applyOutcome(plan)
    assert.deepEqual(o.unknown.map(i => i.name), ['a.zip'], JSON.stringify(plan.items))
    assert.deepEqual(o.failed.map(i => i.name), ['b.zip'])
    const m = applyMessage(o)
    assert.ok(!m.text.includes('原檔都還在原位'), m.text)
    assert.match(m.text, /狀態不明/, m.text)
    assert.ok(m.text.includes(o.unknown[0].why), `unknown 的原因要照後端講：${m.text}`)
    assert.ok(m.text.includes('b.zip') && m.text.includes('a.zip'), m.text)
  })

  test('只有 unknown、一個都沒確定搬好 → 寵物不說「一個都沒搬成」', () => {
    const m = applyMessage({ status: 'error', moved: 0, bytesFreed: 0, failed: [],
      unknown: [{ name: 'a.zip', why: '搬到一半中斷，檔案可能已經在隔離區。再套用一次這份計畫會把它接完。' }] })
    assert.ok(!m.text.includes('原檔都還在原位'), m.text)
    assert.ok(!/一個都沒搬成/.test(m.notice), m.notice)
  })

  test('面板（假 DOM）：全部 failed 的時候說「原檔都還在原位」', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    const ui = await mountUi(t, s)
    await ui.click('quaso-cleanup-alert')
    rmSync(join(s.downloads, 'b.zip'))
    await ui.click('cleanup-apply')
    const text = ui.$('cleanup-result').textContent
    assert.ok(text.includes('原檔都還在原位'), text)
    assert.ok(text.includes('b.zip'), text)
  })
})

test('**跑完不可以在家目錄留下任何東西**', () => {
  assert.ok(!existsSync(join(FAKE_HOME, '.contextbox')), '家目錄出現了 .contextbox')
})
