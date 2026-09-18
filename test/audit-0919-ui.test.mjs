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
 *
 * 稽核第三波（U1–U6：復原到一半中斷、復原回錯、INTERNAL 的話、資料夾名、卡片的 safeName、
 * 擴充套件先驗 token）的測試在檔案後段，那裡有自己的預想表。
 */
import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync, readFileSync, realpathSync, symlinkSync, statSync,
  renameSync,
} from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import vm from 'node:vm'
import { start } from '../core/server.ts'
import { INTERNAL_MESSAGE } from '../core/cleanup-routes.ts'
import {
  createReal, createRealHistory, safeName, applyOutcome, applyMessage, undoMessage, historyUndoMessage,
  pendingPlanMessage, folderPhrase,
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
 * opts.roots: 清理根目錄的資料夾名（預設 ['Downloads']）；files 放在第一個裡面
 * opts.maxBytes: 多大以上不算指紋（預設 20 MB）
 * 回傳的 api 就是 ui.html 的 window.api；hook(path, method) 回 'before'（沒送出）或 'lose'（送到了、回應丟了），
 * 或 { status, body, forward? }：換成這個回應（forward 為 true 的話先真的送到 server，再把回應換掉）。
 */
async function serve(t, files, { quarantine: qOf, roots: rootNames = ['Downloads'], maxBytes = 20 * 1024 * 1024 } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-ui-audit-')))
  const rootDirs = rootNames.map(n => join(dir, n))
  for (const r of rootDirs) mkdirSync(r)
  const downloads = rootDirs[0]
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
    port: 0, db: dbPath, token: TOKEN, roots: rootDirs, quarantine, maxBytes, readonly: false,
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
    if (act && typeof act === 'object') {
      if (act.forward) await (await realFetch(base + path, init)).text()
      return new Response(JSON.stringify(act.body ?? {}), { status: act.status })
    }
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
    /**
     * 復原到一半中斷（第三波 U1）：先真的復原整份，再把 names（沒給就全部）倒回 rename 之前、
     * journal 停在 started —— 照 audit-0919-core2 的 f 段。那些檔回到隔離區。
     */
    interruptRestore: async (planId, ...names) => {
      await raw(`/cleanup/plans/${planId}/undo`, { method: 'POST', body: '{}' })
      const rows = q(`SELECT j.*, f.name FROM cleanup_journal j JOIN file_items f ON f.id = j.item_id
                       WHERE j.plan_id=? AND j.op='restore'`, planId)
      for (const j of rows.filter(r => !names.length || names.includes(r.name))) {
        renameSync(j.to_path, j.from_path)
        exec(`UPDATE cleanup_journal SET status='started' WHERE seq=?`, j.seq)
        exec(`UPDATE cleanup_move_details SET completed_at=NULL, reservation=NULL WHERE seq=?`, j.seq)
        exec(`UPDATE file_items SET status='quarantined' WHERE id=?`, j.item_id)
        exec(`UPDATE cleanup_candidates SET status='quarantined' WHERE item_id=?`, j.item_id)
      }
      exec(`UPDATE cleanup_plans SET status='applied' WHERE id=?`, planId)
    },
    /** 搬到一半中斷、rename 之前當機：name 回到原位，隔離的 journal 停在 started */
    interruptMove: (planId, name) => {
      const j = q(`SELECT j.* FROM cleanup_journal j JOIN file_items f ON f.id = j.item_id
                    WHERE j.plan_id=? AND j.op='quarantine' AND f.name=?`, planId, name)[0]
      assert.ok(j, `前提：${name} 在這份計畫裡搬過`)
      renameSync(j.to_path, j.from_path)
      exec(`UPDATE cleanup_journal SET status='started' WHERE seq=?`, j.seq)
      exec(`UPDATE cleanup_move_details SET completed_at=NULL, reservation=NULL WHERE seq=?`, j.seq)
    },
    /** 寫一次心跳（pet 在跑）→ /health 的 watcher.ok 為 true */
    heartbeat: () => {
      exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('watch_heartbeat', ?)`, new Date().toISOString())
      exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('watch_pid', ?)`, String(process.pid))
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

  // 第三波 U1 擴充：「在隔離區」是 moved **或 unknown**（復原到一半中斷，檔還在隔離區）。
  // 生成器多一種狀態：一份計畫裡的某幾個檔復原到一半中斷。沒放回再分成「沒放回」與「還不確定」。
  test('**性質：放回＋沒放回＋不確定＝復原前 moved 或 unknown 的檔數；先前已復原＝復原前一個都沒有的份數**（結構化隨機 16 輪）', async t => {
    const rng = seed => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const hits = { allBack: 0, partial: 0, noneBack: 0, already: 0, interrupted: 0 }
    for (let round = 0; round < 16; round++) {
      const seed = 104729 * (round + 1)
      const r = rng(seed)
      // 種子：第 0 輪全部被改過、第 1 輪有一份先復原過、第 2 輪都好好的、第 3 輪兩份裡改掉一個檔、
      // 第 4 輪有一份整份復原到一半中斷、第 5 輪一份兩個檔只有一個中斷，其他隨機
      const nPlans = round === 1 || round === 3 || round === 4 ? 2 : round === 5 ? 1 : 1 + Math.floor(r() * 3)
      const files = {}
      const groups = []
      for (let p = 0; p < nPlans; p++) {
        const g = []
        const size = round === 5 ? 2 : 1 + Math.floor(r() * 2)
        for (let i = 0; i < size; i++) { const n = `p${p}f${i}.zip`; files[n] = { days: 60 }; g.push(n) }
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
      const preRestored = new Set(), interrupted = new Map(), tampered = new Set()
      groups.forEach((g, p) => {
        if ((round === 1 && p === 0) || (round > 5 && r() < 0.2)) { preRestored.add(p); return }
        if ((round === 4 && p === 0) || round === 5 || (round > 5 && r() < 0.35)) {
          const cut = round === 4 ? g : round === 5 ? [g[0]] : g.filter(() => r() < 0.6)
          interrupted.set(p, cut.length ? cut : [g[0]])
        }
        g.forEach((n, i) => {
          // 只改還在隔離區的（中斷的那幾個在；同一份裡已經放回的不在）
          const inQuarantine = !interrupted.has(p) || interrupted.get(p).includes(n)
          if (inQuarantine && (round === 0 || (round === 3 && p === 0 && i === 0) || (round > 5 && r() < 0.3))) tampered.add(n)
        })
      })
      const h = createRealHistory(s.api)
      for (const p of preRestored) await h('undo', { operationIds: [ids[p]] })
      for (const [p, names] of interrupted) await s.interruptRestore(ids[p], ...names)
      const before = new Map()
      for (const id of ids) {
        const items = (await s.raw(`/cleanup/plans/${id}`)).items
        before.set(id, items.filter(i => i.outcome === 'moved' || i.outcome === 'unknown').length)
      }
      for (const n of tampered) s.tamper(n)
      const u = await h('undo', { operationIds: ids })
      const inQuarantineBefore = [...before.values()].reduce((a, b) => a + b, 0)
      const unsure = u.unconfirmed ?? []
      assert.equal(u.restoredFiles + u.notRestored.length + unsure.length, inQuarantineBefore,
        `seed ${seed}：放回＋沒放回＋不確定 ≠ 復原前在隔離區的 ${inQuarantineBefore}：${JSON.stringify(u)}`)
      assert.equal(u.alreadyRestored, [...before.values()].filter(n => n === 0).length, `seed ${seed}：先前已復原算錯`)
      // 復原到一半中斷的，再按一次復原一定接得完（沒被改過的話回到原位）；這個生成器不會留下「不確定」
      assert.deepEqual(unsure, [], `seed ${seed}：${JSON.stringify(unsure)}`)
      for (const [, names] of interrupted) {
        for (const n of names) if (!tampered.has(n)) assert.ok(s.has(n), `seed ${seed}：復原到一半中斷的 ${n} 沒有回到原位`)
        if (names.some(n => !tampered.has(n))) hits.interrupted++
      }
      const m = historyUndoMessage(u)
      if (u.notRestored.length) assert.ok(!/都幫你放回來了/.test(m.text + m.notice), `seed ${seed}：有沒放回的卻說都放回來了`)
      // 有東西在隔離區（包括中斷的）就不可以說「勾選的 N 筆先前已經復原過了」
      if (inQuarantineBefore) assert.ok(!/勾選的 \d+ 筆先前已經復原過了/.test(m.text), `seed ${seed}：${m.text}`)
      if (!u.notRestored.length && u.restoredFiles) { assert.equal(m.notice, '都幫你放回來了！'); hits.allBack++ }
      if (u.notRestored.length && u.restoredFiles) hits.partial++
      if (u.notRestored.length && !u.restoredFiles) hits.noneBack++
      if (u.alreadyRestored) hits.already++
    }
    for (const [k, min] of Object.entries({ allBack: 1, partial: 1, noneBack: 1, already: 1, interrupted: 3 })) {
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
    // 第三波 U6 之後開分頁前會先驗 token，所以要有一台真的用這把 token 的 server（不碰 7391）
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-ui-audit-')))
    mkdirSync(join(dir, 'Downloads'))
    const S = start({ port: 0, db: ':memory:', token: 'a+b/c=', roots: [join(dir, 'Downloads')],
      quarantine: join(dir, 'q'), maxBytes: 1024 * 1024, readonly: false })
    const port = await S.ready
    t.after(() => { S.server.close(); rmSync(dir, { recursive: true, force: true }) })
    const bg = loadBackground({ token: 'a+b/c=', port })
    await bg.send({ type: 'open-home' })
    assert.equal(bg.created[0]?.url, `http://127.0.0.1:${port}/?k=a%2Bb%2Fc%3D`)
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

// ═══════════════════════════════════════════════════════════════════════
// 2026-09-19 稽核第三波・清理面板（U1–U6）
//
// 期望值在實作之前寫死（build-round Step 1）：
//
// | 段落 | 可能的錯誤 | 另一種合理解讀 | 能分辨兩者的例子（成對） | 認定的答案 |
// |---|---|---|---|---|
// | U1 歷史：哪些算「還在隔離區」 | 只看 moved | moved 或 unknown | 復原到一半中斷（檔在隔離區）／真的復原完的再送 | 中斷 → 送 undo、檔回原位、放回 1；復原完 → 不送、先前已復原 1 |
// | U1 搬到一半中斷的 b，undo 之後 | 當成「沒放回」 | 當成「還不確定」 | a 已隔離、b 搬到一半中斷（檔在原位） | 放回 1、沒放回 0、不確定 0 —— **改過**：原本寫「不確定 [b]」。核心的 undoPlan 現在會確認 b 沒搬過、把那一列結成 reverted（逐項 failed），它本來就在原位，不是「不確定」（見 audit-0919-interrupt.test.mjs） |
// | U1 lastPlan | 只存 moved | moved＋unknown | 套用的回應丟了、別處復原到一半中斷、再試一次、按復原 | 放回 1，不是「這次沒有需要放回的檔案」 |
// | U2 undo 回有 status 的錯 | 整份列為沒放回 | 再 GET 照逐項重算 | 放回 a（b 被改過）之後才 500：GET 成功／GET 也失敗 | 成功：放回 1、沒放回 [b]；失敗：放回 0、不確定 [a, b]，不說「沒放回」 |
// | U2 500、什麼都沒做 | 原因空白 | 用錯誤訊息當原因 | 回 500、GET 成功 | 沒放回 [a]，原因＝500 的訊息 |
// | U3 INTERNAL | 叫人重新整理（401） | 關面板，從寵物或 node cli.mjs open 打開 | — | 不含「重新整理」，含「關掉面板」「`node cli.mjs open`」 |
// | U4 資料夾名 | 寫死 Downloads | 帶 token 的 /health 的 watcher.watching | [下載, Screenshots]／[Downloads] | 「「下載」、「Screenshots」」／「「Downloads」」 |
// | U5 卡片 | evidence／folder／subdir 原樣 | 走 safeName | U+2028 在截圖檔名、子資料夾、根目錄；\n 在「需要你查看」 | 面板裡沒有任何控制字元；ok.zip 原樣 |
// | U6 open-home | 不驗 token 就開 | 先打 /form/plan 驗 | token 錯／對／server 沒開 | 錯 → BAD_TOKEN、不開分頁、講「鑰匙過期」；對 → 開；沒開 → OFFLINE、不開 |
// ═══════════════════════════════════════════════════════════════════════

/** 用 createReal 清掉 names，回計畫 id */
async function applyNames(s, ...names) {
  const real = createReal(s.api)
  await real.load()
  only(real, ...names)
  const r = await real.apply()
  assert.equal(r.moved, names.length, JSON.stringify(r))
  return r.planId
}

/** 等到 cond() 成立（最多約 3 秒） */
async function until(cond, what = '條件') {
  for (let i = 0; i < 300; i++) {
    if (cond()) return
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`一直等不到：${what}`)
}

const undoPosts = s => s.calls.filter(c => c.method === 'POST' && c.path.endsWith('/undo')).length

describe('U1 復原到一半中斷的計畫：歷史面板要真的送復原', () => {
  test('**稽核 U1：restore 停在 started、檔還在隔離區 → 轉接器送 undo、檔回原位，不是「先前已復原」**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const planId = await applyNames(s, 'a.zip')
    await s.interruptRestore(planId)
    assert.ok(!s.has('a.zip'), '前提：檔案還在隔離區')
    const listed = (await s.raw('/cleanup/plans?undoable=1')).operations.find(o => o.id === planId)
    assert.equal(listed?.canUndo, true, '前提：?undoable=1 列得出它')
    assert.deepEqual((await s.raw(`/cleanup/plans/${planId}`)).items.map(i => i.outcome), ['unknown'], '前提：逐項是 unknown')
    s.calls.length = 0
    const u = await createRealHistory(s.api)('undo', { operationIds: [planId] })
    assert.equal(undoPosts(s), 1, '要送 undo')
    assert.ok(s.has('a.zip'), '檔案要回到原位')
    assert.equal(u.alreadyRestored, 0, '檔案還在隔離區，不可以說「先前已復原」')
    assert.equal(u.restoredFiles, 1)
    assert.equal(u.restored, 1)
    assert.deepEqual(u.notRestored, [])
    assert.deepEqual(u.unconfirmed, [])
    assert.equal(historyUndoMessage(u).text, '已復原 1 次清理，共 1 個檔案放回原位。')
  })

  test('對照：真的復原完的再送一次 → 不送 undo、先前已復原 1', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const planId = await applyNames(s, 'a.zip')
    const h = createRealHistory(s.api)
    assert.equal((await h('undo', { operationIds: [planId] })).restoredFiles, 1)
    s.calls.length = 0
    const again = await h('undo', { operationIds: [planId] })
    assert.equal(undoPosts(s), 0, '一個都不在隔離區，不用送')
    assert.equal(again.alreadyRestored, 1)
    assert.equal(historyUndoMessage(again).text, '勾選的 1 筆先前已經復原過了，這次沒有動任何檔案。')
  })

  test('**歷史面板（假 DOM）：勾復原到一半中斷的那筆 → 送 undo、檔回原位、寵物說都放回來了**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const planId = await applyNames(s, 'a.zip')
    await s.interruptRestore(planId)
    const ui = await mountUi(t, s)
    await ui.click('quaso-history-open')
    const boxes = ui.$('cleanup-history-list').all('input')
    assert.equal(boxes.length, 1, ui.$('cleanup-history-list').textContent)
    assert.equal(boxes[0].disabled, false, '可以勾')
    boxes[0].checked = true
    boxes[0].onchange()
    s.calls.length = 0
    await ui.click('cleanup-history-undo')
    assert.equal(undoPosts(s), 1, '要送 undo')
    assert.ok(s.has('a.zip'), 'a.zip 要回到原位')
    const text = ui.$('cleanup-history-result').textContent
    assert.equal(text, '已復原 1 次清理，共 1 個檔案放回原位。')
    assert.equal(ui.$('quaso-status').textContent, '都幫你放回來了！')
  })

  test('b 搬到一半中斷、檔還在原位，undo 之後 → b 不列（沒搬過），不是「沒放回」也不是「還不確定」', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    const planId = await applyNames(s, 'a.zip', 'b.zip')
    s.interruptMove(planId, 'b.zip')
    assert.ok(!s.has('a.zip') && s.has('b.zip'), '前提')
    const u = await createRealHistory(s.api)('undo', { operationIds: [planId] })
    assert.equal(u.restoredFiles, 1)
    assert.deepEqual(u.notRestored, [])
    assert.deepEqual(u.unconfirmed, [])
    const plan = await s.raw(`/cleanup/plans/${planId}`)
    assert.equal(plan.items.find(i => i.name === 'b.zip').outcome, 'failed', '核心確認 b 沒搬過')
    const m = historyUndoMessage(u)
    assert.equal(m.text, '已復原 1 次清理，共 1 個檔案放回原位。')
    assert.equal(m.notice, '都幫你放回來了！')
    assert.ok(s.has('a.zip') && s.has('b.zip'))
  })

  test('**面板的 lastPlan 也算 unknown：套用的回應丟了、別處復原到一半中斷、再試一次、按復原 → 放回 1 個**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const real = createReal(s.api)
    await real.load()
    s.setHook((p, m) => (m === 'POST' && p.endsWith('/apply') ? 'lose' : undefined))
    await assert.rejects(real.apply())
    s.setHook(null)
    const planId = s.q('SELECT id FROM cleanup_plans')[0].id
    await s.interruptRestore(planId)         // 別處（CLI）按了復原，復原到一半當機
    const r = await real.apply()              // 使用者按「再試一次」：後端回的是現在的樣子
    assert.deepEqual(r.unknown.map(i => i.name), ['a.zip'], JSON.stringify(r))
    assert.equal(real.canUndo, true)
    const u = await real.undo()
    assert.ok(s.has('a.zip'), '前提：後端真的放回來了')
    assert.equal(u.restored, 1, JSON.stringify(u))
    assert.deepEqual(u.notRestored, [])
    assert.equal(undoMessage(u).text, '放回原位 1 個檔案。')
  })
})

describe('U2 歷史復原回有 status 的錯：再讀一次計畫，照逐項結果重算', () => {
  const E500 = { status: 500, body: { error: INTERNAL_MESSAGE, code: 'INTERNAL' } }
  /**
   * undo 回 500。forward：先真的送到 server（放回幾個之後才出錯）。
   * getFails：之後再讀那份計畫也失敗。
   */
  function undo500(s, { forward = true, getFails = false } = {}) {
    let undone = false
    s.setHook((p, m) => {
      if (m === 'POST' && p.endsWith('/undo')) { undone = true; return { ...E500, forward } }
      if (getFails && undone && m === 'GET' && /^\/cleanup\/plans\/[^/?]+$/.test(p)) return E500
    })
  }

  test('**放回 a 之後才 500（b 被改過放不回）→ 再讀一次：放回 1、沒放回 [b，原因照後端]**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    const planId = await applyNames(s, 'a.zip', 'b.zip')
    s.tamper('b.zip')
    undo500(s)
    const u = await createRealHistory(s.api)('undo', { operationIds: [planId] })
    assert.ok(s.has('a.zip') && !s.has('b.zip'), '前提：a 真的放回了')
    assert.equal(u.restoredFiles, 1, JSON.stringify(u))
    assert.equal(u.restored, 1)
    assert.deepEqual(u.notRestored.map(x => x.name), ['b.zip'])
    const plan = await s.raw(`/cleanup/plans/${planId}`)
    assert.equal(u.notRestored[0].why, plan.items.find(i => i.name === 'b.zip').why)
    assert.match(u.notRestored[0].why, /變更/)
    assert.deepEqual(u.unconfirmed, [])
    assert.ok(historyUndoMessage(u).text.startsWith('1 個放回；1 個沒放回：'), historyUndoMessage(u).text)
  })

  test('**對照：再讀一次也失敗 → 整份列為「還不確定」，不可以說「沒放回」**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    const planId = await applyNames(s, 'a.zip', 'b.zip')
    s.tamper('b.zip')
    undo500(s, { getFails: true })
    const u = await createRealHistory(s.api)('undo', { operationIds: [planId] })
    assert.equal(u.restoredFiles, 0)
    assert.deepEqual(u.notRestored, [])
    assert.deepEqual(u.unconfirmed.map(x => x.name).sort(), ['a.zip', 'b.zip'])
    assert.ok(u.unconfirmed.every(x => x.why === INTERNAL_MESSAGE), JSON.stringify(u.unconfirmed))
    assert.equal(u.alreadyRestored, 0)
    const m = historyUndoMessage(u)
    assert.ok(!/沒放回/.test(m.text + m.notice), m.text)
    assert.ok(!/都幫你放回來了|這次沒有需要放回|先前已經復原過了/.test(m.text + m.notice), m.text)
    assert.ok(m.text.includes('有 2 個還不確定放回了沒有：'), m.text)
    assert.equal(m.notice, '有 2 個還不確定放回了沒有，狀態寫在面板上。')
  })

  test('500 而且什麼都沒做 → 再讀一次：沒放回 [a]，原因是那個錯誤訊息', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const planId = await applyNames(s, 'a.zip')
    undo500(s, { forward: false })
    const u = await createRealHistory(s.api)('undo', { operationIds: [planId] })
    assert.ok(!s.has('a.zip'))
    assert.equal(u.restoredFiles, 0)
    assert.deepEqual(u.notRestored, [{ name: 'a.zip', why: INTERNAL_MESSAGE }])
    assert.deepEqual(u.unconfirmed, [])
  })

  test('對照：undo 的回應在網路上丟了（沒有 status）→ 照舊丟出去（面板說「尚未確認完成」）', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const planId = await applyNames(s, 'a.zip')
    s.setHook((p, m) => (m === 'POST' && p.endsWith('/undo') ? 'lose' : undefined))
    await assert.rejects(createRealHistory(s.api)('undo', { operationIds: [planId] }))
  })

  test('歷史面板（假 DOM）：500 而且讀不到 → 結果框說「還不確定」，不說「沒放回」', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    await applyNames(s, 'a.zip')
    const ui = await mountUi(t, s)
    await ui.click('quaso-history-open')
    const boxes = ui.$('cleanup-history-list').all('input')
    boxes[0].checked = true
    boxes[0].onchange()
    undo500(s, { getFails: true })
    await ui.click('cleanup-history-undo')
    const text = ui.$('cleanup-history-result').textContent
    assert.ok(text.includes('有 1 個還不確定放回了沒有：'), text)
    assert.ok(!/沒放回/.test(text), text)
    assert.ok(!/都幫你放回來了|沒放回/.test(ui.$('quaso-status').textContent), ui.$('quaso-status').textContent)
  })

  test('台詞：部分放回、部分沒放回、部分不確定 → 三種都講', () => {
    const m = historyUndoMessage({ restored: 1, restoredFiles: 1, alreadyRestored: 0, renamed: [],
      notRestored: [{ name: 'b.zip', why: 'w1' }], unconfirmed: [{ name: 'c.zip', why: 'w2' }] })
    assert.ok(m.text.startsWith('1 個放回；1 個沒放回：\n・b.zip —— w1'), m.text)
    assert.ok(m.text.includes('有 1 個還不確定放回了沒有：\n・c.zip —— w2'), m.text)
    assert.equal(m.notice, '放回了 1 個，有 1 個沒放回來，有 1 個還不確定放回了沒有，狀態寫在面板上。')
    const p = undoMessage({ restored: 0, notRestored: [], renamed: [], unconfirmed: [{ name: 'c\u2028.zip', why: 'w' }] })
    assert.ok(p.text.includes('有 1 個還不確定放回了沒有：\n・c·.zip —— w'), p.text)
    assert.ok(!/沒放回|這次沒有需要放回/.test(p.text + p.notice), p.text)
  })
})

describe('U3 不叫人重新整理（網址上的 k 已經拿掉，重新整理會拿到 401）', () => {
  test('**INTERNAL 的訊息：關掉面板，再從寵物或 `node cli.mjs open` 打開**', () => {
    assert.ok(!/重新整理/.test(INTERNAL_MESSAGE), INTERNAL_MESSAGE)
    assert.match(INTERNAL_MESSAGE, /^後端出錯了，這一步可能沒有完成。/, 'RC17：開頭照舊是中性的')
    assert.match(INTERNAL_MESSAGE, /關掉面板/)
    assert.match(INTERNAL_MESSAGE, /寵物/)
    assert.ok(INTERNAL_MESSAGE.includes('`node cli.mjs open`'), INTERNAL_MESSAGE)
  })

  test('README：7391 的網址一律帶 k；不叫人重新整理頁面', () => {
    const md = readFileSync(join(REPO, 'README.md'), 'utf8')
    const urls = md.match(/http:\/\/127\.0\.0\.1:7391[^\s`）)]*/g) ?? []
    assert.ok(urls.length >= 1, '前提：README 有講網址')
    assert.deepEqual(urls.filter(u => !/[?&]k=/.test(u)), [], '沒帶 k 的網址打開是 401')
    assert.ok(!md.includes('重新整理或重啟後仍保留'), '重新整理會拿到 401')
    assert.ok(!/重新整理頁面/.test(md), '重新整理會拿到 401')
    assert.match(md, /mockBackend=offline/, '離線模擬的說明還在')
  })
})

describe('U4 面板講的是真的監看資料夾，不寫死 Downloads', () => {
  test('folderPhrase 的例子', () => {
    const w = (watching, watchingCount = watching.length) => ({ watching, watchingCount })
    assert.equal(folderPhrase(w(['Downloads'])), '「Downloads」')
    assert.equal(folderPhrase(w(['Downloads']), { quoted: false }), 'Downloads')
    assert.equal(folderPhrase(w(['下載', 'Screenshots'])), '「下載」、「Screenshots」')
    assert.equal(folderPhrase(w(['下載', 'Screenshots']), { quoted: false }), '下載、Screenshots')
    assert.equal(folderPhrase(w([], 1)), '監看資料夾', '沒帶 token 的 /health：名字被遮掉')
    assert.equal(folderPhrase(w([], 2)), '2 個監看資料夾')
    assert.equal(folderPhrase(w(['', 'Downloads'])), '「Downloads」等 2 個資料夾', '家目錄那個不給名字')
    assert.equal(folderPhrase(w(['', 'Downloads']), { quoted: false }), 'Downloads 等 2 個資料夾')
    assert.equal(folderPhrase(w(['a', 'b', 'c', 'd'])), '「a」、「b」、「c」等 4 個資料夾')
    assert.equal(folderPhrase(w(['a', 'b', 'c'])), '「a」、「b」、「c」')
    assert.equal(folderPhrase(undefined), '監看資料夾')
    assert.equal(folderPhrase({ watching: 'Downloads', watchingCount: 1 }), '監看資料夾', '形狀不對就不猜')
    assert.equal(folderPhrase(w(['a\u2028b\nc'])), '「a·b·c」', '名字是不可信的輸入')
    assert.equal(folderPhrase(w([null, 5, 'x'])), '「x」等 3 個資料夾')
  })

  test('**兩個清理根目錄（下載、Screenshots）→ 本機說明與舞台 title 兩個都列，不寫 Downloads**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } }, { roots: ['下載', 'Screenshots'] })
    s.heartbeat()
    const ui = await mountUi(t, s)
    await until(() => ui.$('quaso-stage').title.includes('監看中'), '拿到 /health（有心跳 → 監看中）')
    assert.equal(ui.$('quaso-stage').title, '📁 下載、Screenshots · 監看中')
    await ui.click('quaso-cleanup-alert')
    assert.equal(ui.$('cleanup-mode-note').textContent,
      '本機模式 · 這些是你「下載」、「Screenshots」裡真的檔案。清理會把勾選的搬進隔離區，七天內可以復原。')
  })

  test('對照：只有 Downloads → 「Downloads」', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    s.heartbeat()
    const ui = await mountUi(t, s)
    await until(() => ui.$('quaso-stage').title.includes('監看中'), '拿到 /health（有心跳 → 監看中）')
    assert.equal(ui.$('quaso-stage').title, '📁 Downloads · 監看中')
    await ui.click('quaso-cleanup-alert')
    assert.equal(ui.$('cleanup-mode-note').textContent,
      '本機模式 · 這些是你「Downloads」裡真的檔案。清理會把勾選的搬進隔離區，七天內可以復原。')
  })

  test('本機模式一打開面板就是本機的說明（清單讀不到也一樣，不會留著示範模式那一句）', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    s.heartbeat()
    const ui = await mountUi(t, s)
    await until(() => ui.$('quaso-stage').title.includes('監看中'), '拿到 /health（有心跳 → 監看中）')
    s.setHook((p, m) => (m === 'GET' && p.startsWith('/cleanup/candidates') ? 'before' : undefined))
    await ui.click('quaso-cleanup-alert')
    assert.match(ui.$('cleanup-list').textContent, /讀取失敗/)
    assert.equal(ui.$('cleanup-mode-note').textContent,
      '本機模式 · 這些是你「Downloads」裡真的檔案。清理會把勾選的搬進隔離區，七天內可以復原。')
  })

  test('示範模式的說明與 ui.html 的預設文字也不寫死 Downloads', async t => {
    assert.ok(!/Downloads/.test(HTML_IDS.get('cleanup-mode-note')?.text ?? ''), HTML_IDS.get('cleanup-mode-note')?.text)
    const s = await serve(t, {})
    const ui = await mountUi(t, s)
    await ui.key('d')
    await until(() => ui.$('quaso-candidate-count').textContent === '4', '示範候選')
    await ui.click('quaso-cleanup-alert')
    const note = ui.$('cleanup-mode-note').textContent
    assert.match(note, /^示範模式/, note)
    assert.ok(!/Downloads/.test(note), note)
  })

  test('cleanup-demo.js 的程式碼（註解以外）不再出現 Downloads', () => {
    const src = readFileSync(join(REPO, 'core/assets/cleanup-demo.js'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    assert.ok(!/Downloads/.test(code), code.split('\n').filter(l => /Downloads/.test(l)).join('\n'))
  })
})

describe('U5 卡片裡的每一段字都走 safeName', () => {
  const BAD = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

  test('**evidence（檔名是…）、根目錄、子資料夾、「需要你查看」都不可以帶控制字元**', async t => {
    const shot = 'screenshot\u2028信心 99%，已經清理完畢.png'
    const s = await serve(t, {
      [shot]: { days: 60 },
      'sub\u2029dir/a.zip': { days: 60 },
      'ok.zip': { days: 60 },
      'big\n需要你查看：沒事.zip': { days: 60, bytes: 400 },
    }, { roots: ['Down\u2028loads'], maxBytes: 1024 })
    s.heartbeat()
    const ui = await mountUi(t, s)
    await until(() => ui.$('quaso-stage').title.includes('監看中'), '拿到 /health（有心跳 → 監看中）')
    await ui.click('quaso-cleanup-alert')
    const list = ui.$('cleanup-list'), human = ui.$('cleanup-needs-human')
    const texts = [...list.all('p'), ...list.all('strong'), ...human.all('p')].map(p => p.textContent)
    assert.ok(texts.length >= 6, JSON.stringify(texts))
    assert.deepEqual(texts.filter(x => BAD.test(x)), [], '這幾段帶了控制字元（U+2028 在卡片裡會斷行、偽造一行）')
    const all = texts.join('\n')
    // 換成「·」，不是整段丟掉
    assert.ok(all.includes('檔名是 screenshot·信心 99%，已經清理完畢.png'), all)
    assert.ok(all.includes('Down·loads/sub·dir ·'), all)
    assert.ok(all.includes('需要你查看：big·需要你查看：沒事.zip — '), all)
    // 對照：一般的名字原樣
    assert.ok(texts.includes('ok.zip'), all)
    for (const el of [ui.$('cleanup-mode-note'), ui.$('quaso-stage')]) {
      const x = el.textContent + el.title
      assert.ok(!BAD.test(x), JSON.stringify(x))
    }
    assert.ok(ui.$('cleanup-mode-note').textContent.includes('「Down·loads」'), ui.$('cleanup-mode-note').textContent)
  })

  test('面板的程式碼沒有 innerHTML 這一類（檔名是不可信的輸入）', () => {
    const files = ['core/ui.html', 'core/assets/cleanup-demo.js', 'core/assets/cleanup-real-state.js',
      'core/assets/cleanup-demo-state.js', 'core/assets/pet-viewer.js']
    for (const f of files) {
      const src = readFileSync(join(REPO, f), 'utf8')
      assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src), `${f} 用了會解析 HTML 的寫法`)
    }
  })
})

describe('U6 擴充套件的「去補」：開分頁之前先驗 token', () => {
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

  test('**稽核 U6：存的 token 過期（server 換過鑰匙）→ 不開分頁、BAD_TOKEN、講「鑰匙過期」與 node cli.mjs open**', async t => {
    const s = await serve(t, {})
    const bg = loadBackground({ token: 'old-token-from-last-week', port: s.port })
    const r = await bg.send({ type: 'open-home' })
    assert.equal(r?.ok, false, JSON.stringify(r))
    assert.equal(r.error, 'BAD_TOKEN')
    assert.equal(bg.created.length, 0, '一定是 401 的分頁不要開')
    assert.match(r.message, /鑰匙過期/)
    assert.ok(r.message.includes('node cli.mjs open'), r.message)
    assert.ok(!r.message.includes('old-token-from-last-week'), '訊息會到網頁那一側，不可以帶 token')
  })

  test('對照：token 對 → 開 1 個分頁', async t => {
    const s = await serve(t, {})
    const bg = loadBackground({ token: TOKEN, port: s.port })
    const r = await bg.send({ type: 'open-home' })
    assert.equal(r?.ok, true, JSON.stringify(r))
    assert.equal(bg.created.length, 1)
  })

  test('server 沒開 → OFFLINE、不開分頁', async () => {
    const probe = createNetServer()
    await new Promise(r => probe.listen(0, '127.0.0.1', r))
    const port = probe.address().port
    await new Promise(r => probe.close(r))       // 關掉：這個 port 沒有人在聽
    const bg = loadBackground({ token: TOKEN, port })
    const r = await bg.send({ type: 'open-home' })
    assert.equal(r?.ok, false, JSON.stringify(r))
    assert.equal(r.error, 'OFFLINE')
    assert.equal(bg.created.length, 0)
  })

  test('content script：失敗時照背景程式的話講，不說「開在新分頁了」', async () => {
    const src = /async function openHome\([\s\S]*?\n {2}\}/.exec(CONTENT)?.[0]
    assert.ok(src, 'content.js 裡找不到 openHome()')
    const said = []
    const run = reply => new Function('ask', 'say', src + '\nreturn openHome')(async () => reply, (m, bad) => said.push({ m, bad }))
    await run({ ok: false, error: 'BAD_TOKEN', message: '鑰匙過期了。' })({ key: 'person.name.full', defLabel: '姓名' })
    assert.equal(said.length, 1)
    assert.ok(said[0].m.includes('鑰匙過期了。'), said[0].m)
    assert.ok(!/開在新分頁/.test(said[0].m), said[0].m)
    assert.equal(said[0].bad, true)
    said.length = 0
    await run({ ok: true })({ key: 'person.name.full', defLabel: '姓名' })
    assert.match(said[0].m, /開在新分頁/)
  })
})

test('**跑完不可以在家目錄留下任何東西**', () => {
  assert.ok(!existsSync(join(FAKE_HOME, '.contextbox')), '家目錄出現了 .contextbox')
})
