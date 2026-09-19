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
  renameSync, readdirSync,
} from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import vm from 'node:vm'
import { start } from '../core/server.ts'
import { INTERNAL_MESSAGE } from '../core/cleanup-routes.ts'
import { initDemoHistory, recordDemo } from '../core/cleanup-demo-history.ts'
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
  const revertRestore = (planId, ...names) => {
    const rows = q(`SELECT j.*, f.name FROM cleanup_journal j JOIN file_items f ON f.id = j.item_id
                     WHERE j.plan_id=? AND j.op='restore' AND j.status='done'`, planId)
    for (const j of rows.filter(r => !names.length || names.includes(r.name))) {
      renameSync(j.to_path, j.from_path)
      exec(`UPDATE cleanup_journal SET status='started' WHERE seq=?`, j.seq)
      exec(`UPDATE cleanup_move_details SET completed_at=NULL, reservation=NULL WHERE seq=?`, j.seq)
      exec(`UPDATE file_items SET status='quarantined' WHERE id=?`, j.item_id)
      exec(`UPDATE cleanup_candidates SET status='quarantined' WHERE item_id=?`, j.item_id)
    }
    exec(`UPDATE cleanup_plans SET status='applied' WHERE id=?`, planId)
  }
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
      revertRestore(planId, ...names)
    },
    /** interruptRestore 的後半：已經放回去的 names（沒給就全部）倒回 rename 之前，journal 停在 started */
    revertRestore: (planId, ...names) => revertRestore(planId, ...names),
    /**
     * 真的清空 names 在隔離區的那一份（逐項結果變成 purged）：把它們的隔離時間撥回八天前，
     * 再走一次清空的兩段確認（預覽 → 帶 token 確認）。只有撥過時間的會被清。
     */
    purge: async (...names) => {
      for (const n of names) {
        const row = q(`SELECT j.seq FROM cleanup_journal j JOIN file_items f ON f.id = j.item_id
                        WHERE j.op='quarantine' AND j.status='done' AND f.name=?`, n)[0]
        assert.ok(row, `前提：${n} 在隔離區`)
        exec(`UPDATE cleanup_move_details SET completed_at=? WHERE seq=?`, new Date(Date.now() - 8 * DAY).toISOString(), row.seq)
      }
      const preview = await raw('/cleanup/quarantine/empty', { method: 'POST', body: '{}' })
      assert.equal(preview.itemCount, names.length, `前提：預覽只含撥過時間的那幾個：${JSON.stringify(preview)}`)
      const done = await raw('/cleanup/quarantine/empty', { method: 'POST', body: JSON.stringify({ token: preview.token, confirmed: true }) })
      assert.equal(done.deletedCount, names.length, JSON.stringify(done))
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
 * opts.wrap(url, init, next)：頁面的每一個 fetch 先經過它（假的慢 api、假的逾時用），next 是真的送出去。
 */
async function mountUi(t, s, { wrap = null } = {}) {
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
  const pageFetch = wrap ? (url, init) => wrap(url, init, s.netFetch) : (url, init) => s.netFetch(url, init)
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
    // 第二輪 R2-5 起面板一打開就查 ?pending=1，打開之前就有的計畫會直接提示（那一段在後面的 P2）。
    // 這一條要測的是**撞到 CONFLICT** 那條路，所以兩份計畫改成在面板開著的時候才建（例如 CLI 建的）；
    // 期望值一個都沒改。
    const ui = await mountUi(t, s)
    await ui.click('quaso-cleanup-alert')
    const p1 = await s.raw('/cleanup/plans', { method: 'POST', body: JSON.stringify({ candidateIds: await s.idsOf('a.zip') }) })
    await new Promise(r => setTimeout(r, 5))
    await s.raw('/cleanup/plans', { method: 'POST', body: JSON.stringify({ candidateIds: await s.idsOf('z.zip') }) })
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
  // 沒放回再分成「沒放回」與「還不確定」。
  //
  // 第三波之二：生成器涵蓋逐項結果的**全部八種**（pending、moved、skipped、failed、restored、purged、
  // unknown、cancelled）。上一版只產生 moved／restored／unknown —— 把 maybeInQuarantine 改成
  // 「不是 restored 就算」照樣全綠：沒搬成（failed）、略過（skipped）的檔會被說成「沒放回」，
  // 只有 pending 的計畫也會被送 undo（後端會把它標成 restored）。
  // unknown 有兩種：復原到一半中斷（unknownR，檔在隔離區）與搬到一半中斷、其實沒搬（unknownM，檔在原位）。
  test('**性質：放回＋沒放回＋不確定＋其實沒搬＝復原前 moved 或 unknown 的檔數；其他 outcome 不列、不送 undo；先前已復原＝復原前一個都沒有的份數**（結構化隨機 18 輪）', async t => {
    const rng = seed => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const FATES = ['moved', 'skipped', 'failed', 'restored', 'purged', 'unknownR', 'unknownM']
    const OUTCOME = {
      moved: 'moved', skipped: 'skipped', failed: 'failed', restored: 'restored', purged: 'purged',
      unknownR: 'unknown', unknownM: 'unknown', pending: 'pending', cancelled: 'cancelled',
    }
    /** 根本沒進過隔離區的：不可以被說成「沒放回」「還不確定」，也不可以讓面板送 undo */
    const NEVER_MOVED = ['failed', 'skipped', 'pending', 'cancelled']
    const wasIn = o => o === 'moved' || o === 'unknown'
    // 種子（固定的例子，保證每一種都走到）：
    //   0 全部被改過　1 有一份先復原過　2 都好好的　3 兩份裡改掉一個檔　4 有一份整份復原到一半中斷
    //   5 一份兩個檔只有一個中斷　6 同一份裡有搬走、沒搬成、略過的，外加一份還沒套用、一份放棄了
    //   7 清空過的（整份、半份）與只有沒搬成／略過的一份　8 搬到一半中斷、其實沒搬的（整份、半份）
    const SEEDED = [
      [{ kind: 'applied', fates: ['moved'] }],
      [{ kind: 'applied', fates: ['restored'] }, { kind: 'applied', fates: ['moved', 'moved'] }],
      [{ kind: 'applied', fates: ['moved', 'moved'] }],
      [{ kind: 'applied', fates: ['moved'] }, { kind: 'applied', fates: ['moved'] }],
      [{ kind: 'applied', fates: ['unknownR'] }, { kind: 'applied', fates: ['moved'] }],
      [{ kind: 'applied', fates: ['unknownR', 'restored'] }],
      [{ kind: 'applied', fates: ['moved', 'failed', 'skipped'] }, { kind: 'pending', fates: ['pending'] },
        { kind: 'cancelled', fates: ['cancelled', 'cancelled'] }],
      [{ kind: 'applied', fates: ['failed', 'skipped'] }, { kind: 'applied', fates: ['purged', 'moved'] },
        { kind: 'applied', fates: ['purged'] }],
      [{ kind: 'applied', fates: ['unknownM', 'moved'] }, { kind: 'applied', fates: ['unknownM'] },
        { kind: 'applied', fates: ['restored', 'failed'] }],
    ]
    const hits = { allBack: 0, partial: 0, noneBack: 0, already: 0, interrupted: 0, noUndoSent: 0, mixed: 0 }
    const seen = Object.fromEntries(Object.values(OUTCOME).map(o => [o, 0]))
    for (let round = 0; round < 18; round++) {
      const seed = 104729 * (round + 1)
      const r = rng(seed)
      const spec = SEEDED[round] ?? Array.from({ length: 1 + Math.floor(r() * 4) }, () => {
        const k = r()
        if (k < 0.15) return { kind: 'pending', fates: Array(1 + Math.floor(r() * 2)).fill('pending') }
        if (k < 0.3) return { kind: 'cancelled', fates: Array(1 + Math.floor(r() * 2)).fill('cancelled') }
        return { kind: 'applied', fates: Array.from({ length: 1 + Math.floor(r() * 3) }, () => FATES[Math.floor(r() * FATES.length)]) }
      })
      const plans = spec.map((p, i) => ({ kind: p.kind, id: null, files: p.fates.map((fate, j) => ({ name: `p${i}f${j}.zip`, fate })) }))
      const files = Object.fromEntries(plans.flatMap(p => p.files.map(f => [f.name, { days: 60 }])))
      const s = await serve(t, files)
      const idsOf = new Map((await s.raw('/cleanup/candidates?limit=1000')).candidates.map(c => [c.name, c.candidateIds]))
      const post = (path, body = {}) => s.raw(path, { method: 'POST', body: JSON.stringify(body) })

      // ── 把每個檔做成想要的那一種 ──
      for (const [i, p] of plans.entries()) {
        const plan = await post('/cleanup/plans', { candidateIds: p.files.flatMap(f => idsOf.get(f.name)), requestId: `r${round}p${i}` })
        p.id = plan.id
        if (p.kind === 'pending') continue
        if (p.kind === 'cancelled') { await post(`/cleanup/plans/${p.id}/${r() < 0.5 ? 'release' : 'dismiss'}`); continue }
        // 建好計畫之後原檔被改了 → 套用時 CHANGED，留在原位（failed）
        for (const f of p.files) if (f.fate === 'failed') writeFileSync(join(s.downloads, f.name), '建計畫之後被改過了')
        const skippedIds = p.files.filter(f => f.fate === 'skipped').flatMap(f => idsOf.get(f.name))
        await post(`/cleanup/plans/${p.id}/apply`, skippedIds.length ? { skippedIds } : {})
        if (p.files.some(f => f.fate === 'restored' || f.fate === 'unknownR')) {
          // 要留在隔離區的先改掉（復原時 CHANGED，放不回去），復原一次，再改回來
          const stay = p.files.filter(f => ['moved', 'purged', 'unknownM'].includes(f.fate)).map(f => f.name)
          for (const n of stay) s.tamper(n)
          await post(`/cleanup/plans/${p.id}/undo`)
          for (const n of stay) s.untamper(n)
          const cut = p.files.filter(f => f.fate === 'unknownR').map(f => f.name)
          if (cut.length) s.revertRestore(p.id, ...cut)
        }
        for (const f of p.files) if (f.fate === 'unknownM') s.interruptMove(p.id, f.name)
      }
      const purge = plans.flatMap(p => p.files.filter(f => f.fate === 'purged').map(f => f.name))
      if (purge.length) await s.purge(...purge)

      const before = new Map()
      for (const p of plans) before.set(p.id, (await s.raw(`/cleanup/plans/${p.id}`)).items)
      const beforeOf = new Map([...before.values()].flat().map(i => [i.name, i.outcome]))
      // 生成器自己先對一次帳：每個檔真的是想要的那一種（不然下面的 hits 是假的）
      for (const p of plans) {
        for (const f of p.files) {
          assert.equal(beforeOf.get(f.name), OUTCOME[f.fate], `seed ${seed}：生成器想做 ${f.name}＝${f.fate}，後端說 ${beforeOf.get(f.name)}`)
          seen[OUTCOME[f.fate]]++
        }
      }

      // 在隔離區的（moved、復原到一半中斷的）隨機改掉幾個 → 復原時 CHANGED
      const tampered = new Set()
      plans.forEach((p, pi) => p.files.forEach((f, fi) => {
        if (f.fate !== 'moved' && f.fate !== 'unknownR') return
        if (round === 0 || (round === 3 && pi === 0 && fi === 0) || (round >= SEEDED.length && r() < 0.3)) tampered.add(f.name)
      }))
      for (const n of tampered) s.tamper(n)

      const h = createRealHistory(s.api)
      const from = s.calls.length
      const u = await h('undo', { operationIds: plans.map(p => p.id) })
      const undoSent = s.calls.slice(from).filter(c => c.method === 'POST' && /\/undo$/.test(c.path))
        .map(c => decodeURIComponent(c.path.split('/')[3]))
      const after = new Map()
      for (const p of plans) after.set(p.id, new Map((await s.raw(`/cleanup/plans/${p.id}`)).items.map(i => [i.name, i.outcome])))
      const unsure = u.unconfirmed ?? []
      const outcomes = p => before.get(p.id).map(i => i.outcome).join('、')

      // 復原前不在隔離區的（沒搬成、略過、還沒套用、放棄了，以及已放回、已清空）一個都不列
      for (const x of [...u.notRestored, ...unsure]) {
        const was = beforeOf.get(x.name)
        assert.ok(!NEVER_MOVED.includes(was), `seed ${seed}：${x.name} 復原前是 ${was}（根本沒進隔離區），卻被列成沒放回／不確定：${JSON.stringify(u)}`)
        assert.ok(wasIn(was), `seed ${seed}：${x.name} 復原前是 ${was}，不在隔離區：${JSON.stringify(u)}`)
      }
      // 只有復原前有東西在隔離區的那幾份送 undo，而且各送一次
      for (const p of plans) {
        const any = before.get(p.id).some(i => wasIn(i.outcome))
        assert.equal(undoSent.filter(id => id === p.id).length, any ? 1 : 0,
          `seed ${seed}：${p.kind} 那一份（${outcomes(p)}）${any ? '要送一次' : '不可以送'} undo`)
        if (!any) hits.noUndoSent++
        if (any && before.get(p.id).some(i => NEVER_MOVED.includes(i.outcome))) hits.mixed++
      }
      // 帳：搬到一半中斷、復原時確認其實沒搬（unknown → failed）的，兩邊都不列（CLI 印「當初就沒有搬走」）
      const inQuarantineBefore = [...beforeOf.values()].filter(wasIn).length
      const neverLeft = plans.flatMap(p => before.get(p.id)
        .filter(i => i.outcome === 'unknown' && NEVER_MOVED.includes(after.get(p.id).get(i.name)))).length
      assert.equal(u.restoredFiles + u.notRestored.length + unsure.length + neverLeft, inQuarantineBefore,
        `seed ${seed}：放回＋沒放回＋不確定＋其實沒搬 ≠ 復原前在隔離區的 ${inQuarantineBefore}：${JSON.stringify(u)}`)
      assert.equal(u.alreadyRestored, plans.filter(p => !before.get(p.id).some(i => wasIn(i.outcome))).length,
        `seed ${seed}：先前已復原算錯`)
      // 復原到一半中斷的，再按一次復原一定接得完（沒被改過的話回到原位）；這個生成器不會留下「不確定」
      assert.deepEqual(unsure, [], `seed ${seed}：${JSON.stringify(unsure)}`)
      for (const p of plans) {
        for (const f of p.files) {
          if (f.fate === 'unknownR' && !tampered.has(f.name)) assert.ok(s.has(f.name), `seed ${seed}：復原到一半中斷的 ${f.name} 沒有回到原位`)
          if (f.fate === 'unknownM' || NEVER_MOVED.includes(f.fate)) assert.ok(s.has(f.name), `seed ${seed}：${f.name}（${f.fate}）本來就在原位`)
        }
      }
      if (plans.some(p => p.files.some(f => f.fate === 'unknownR' && !tampered.has(f.name)))) hits.interrupted++
      const m = historyUndoMessage(u)
      if (u.notRestored.length) assert.ok(!/都幫你放回來了/.test(m.text + m.notice), `seed ${seed}：有沒放回的卻說都放回來了`)
      // 真的有東西在隔離區就不可以說「勾選的 N 筆先前已經復原過了」
      if (inQuarantineBefore - neverLeft) assert.ok(!/勾選的 \d+ 筆先前已經復原過了/.test(m.text), `seed ${seed}：${m.text}`)
      if (!u.notRestored.length && u.restoredFiles) { assert.equal(m.notice, '都幫你放回來了！'); hits.allBack++ }
      if (u.notRestored.length && u.restoredFiles) hits.partial++
      if (u.notRestored.length && !u.restoredFiles) hits.noneBack++
      if (u.alreadyRestored) hits.already++
    }
    for (const [k, min] of Object.entries({ allBack: 1, partial: 1, noneBack: 1, already: 1, interrupted: 3, noUndoSent: 3, mixed: 2 })) {
      assert.ok(hits[k] >= min, `生成器沒走到「${k}」：${JSON.stringify(hits)}`)
    }
    for (const [o, n] of Object.entries(seen)) assert.ok(n >= 2, `生成器產生的 ${o} 不到兩個：${JSON.stringify(seen)}`)
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

  // 第三波之二：同一份計畫裡沒搬成的（failed）根本沒進隔離區。面板的復原照「復原前在隔離區的」逐一對，
  // 它不在裡面 —— 把「在隔離區」改成「不是 restored 就算」的話，它會被說成「沒放回」。
  /** a.zip、b.zip 一份計畫；送出套用之前 b.zip 被改了 → 套用時 CHANGED，b.zip 留在原位（failed） */
  async function appliedWithFailed(t) {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    const real = createReal(s.api)
    await real.load()
    s.setHook((p, m) => {
      if (m === 'POST' && p.endsWith('/apply')) writeFileSync(join(s.downloads, 'b.zip'), '建計畫之後被改過了')
    })
    const r = await real.apply()
    s.setHook(null)
    assert.equal(r.moved, 1, JSON.stringify(r))
    assert.deepEqual(r.failed.map(x => x.name), ['b.zip'], '前提：b.zip 沒搬成')
    assert.ok(real.canUndo)
    return { s, real }
  }

  test('**面板的復原：同一份計畫裡沒搬成的（failed）不算「沒放回」** —— a.zip 放回、b.zip 不列', async t => {
    const { s, real } = await appliedWithFailed(t)
    const r = await real.undo()
    assert.equal(r.restored, 1)
    assert.deepEqual(r.notRestored, [], `b.zip 根本沒進隔離區：${JSON.stringify(r)}`)
    assert.deepEqual(r.unconfirmed, [])
    const m = undoMessage(r)
    assert.equal(m.notice, '都幫你放回來了！')
    assert.ok(!/沒放回|b\.zip/.test(m.text), m.text)
    assert.ok(s.has('a.zip') && s.has('b.zip'))
  })

  test('對照：同一份計畫、a.zip 在隔離區被改過 → 只有 a.zip 沒放回，b.zip（failed）還是不列', async t => {
    const { s, real } = await appliedWithFailed(t)
    s.tamper('a.zip')
    const r = await real.undo()
    assert.equal(r.restored, 0)
    assert.deepEqual(r.notRestored.map(x => x.name), ['a.zip'], JSON.stringify(r))
    const m = undoMessage(r)
    assert.ok(m.text.includes('0 個放回；1 個沒放回：'), m.text)
    assert.ok(!/b\.zip/.test(m.text), m.text)
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
    // crypto／TextEncoder：R3-7 起 background.js 會先算 proof（Web Crypto 的 HMAC-SHA256）
    vm.runInNewContext(BG, {
      chrome, fetch: realFetch, AbortSignal, console, URL, encodeURIComponent,
      crypto: globalThis.crypto, TextEncoder,
    })
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
      unknown: [{ name: 'a.zip', why: '搬到一半中斷，說不準檔案現在在原位還是在隔離區。按「復原」會把在隔離區的放回原位；也可以執行 node cli.mjs doctor 檢查。' }] })
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
    assert.deepEqual(u.neverMoved, [{ name: 'b.zip' }])
    const m = historyUndoMessage(u)
    assert.equal(m.text, '已復原 1 次清理，共 1 個檔案放回原位。\n・b.zip 當初就沒有搬走，本來就在原位。')
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

  // ── 第三波之二：同一個坑的另外兩個地方（示範紀錄的錯誤訊息、docs/api 的 INTERNAL 那一列）──

  test('**示範紀錄的兩句錯誤（缺少操作識別碼、範例候選已變更）：不叫人重新整理，跟 INTERNAL 一樣叫人關掉面板再打開**', () => {
    const db = new DatabaseSync(':memory:')
    initDemoHistory(db)
    const fixture = JSON.parse(readFileSync(join(REPO, 'core/assets/demo-candidates.json'), 'utf8'))
    const known = fixture.candidates[0].candidateIds
    const errorOf = body => { try { recordDemo(db, body) } catch (e) { return e.message } return null }
    const said = [
      [/^缺少操作識別碼/, errorOf({ candidateIds: known })],
      [/^範例候選已變更/, errorOf({ candidateIds: ['不在範例裡的-id'], requestId: 'r1' })],
    ]
    for (const [which, m] of said) {
      assert.match(m ?? '', which, `前提：是這一種錯：${m}`)
      assert.ok(!/重新整理/.test(m), `網址上的 k 已經拿掉，重新整理會拿到 401：${m}`)
      assert.match(m, /關掉面板/, m)
      assert.ok(m.includes('`node cli.mjs open`'), `跟 INTERNAL 一樣講去哪裡重新打開：${m}`)
    }
    // 對照：正常的一筆照樣記得進去（上面真的是那兩種錯，不是別的錯）
    assert.equal(recordDemo(db, { candidateIds: known, requestId: 'r2' }).itemCount, 1)
    db.close()
  })

  test('docs/api/README.md 的 INTERNAL 那一列：「呼叫端怎麼做」不叫人重新整理', () => {
    const md = readFileSync(join(REPO, 'docs/api/README.md'), 'utf8')
    const row = md.split('\n').find(l => /^\|\s*500\s*\|\s*`INTERNAL`/.test(l))
    assert.ok(row, '錯誤表沒有 INTERNAL 那一列')
    const todo = row.split('|').slice(1, -1).map(c => c.trim()).at(-1)
    assert.ok(!/重新整理/.test(todo), `重新整理會拿到 401：${todo}`)
    assert.match(todo, /關掉面板/, todo)
    assert.match(todo, /不要自動重試/, todo)
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
    // crypto／TextEncoder：R3-7 起 background.js 會先算 proof（Web Crypto 的 HMAC-SHA256）
    vm.runInNewContext(BG, {
      chrome, fetch: realFetch, AbortSignal, console, URL, encodeURIComponent,
      crypto: globalThis.crypto, TextEncoder,
    })
    const send = msg => new Promise(resolve => {
      const keep = listeners[0](msg, { id: 'ext', origin: 'https://jobs.example.com', tab: { id: 9 } }, resolve)
      if (keep !== true) resolve(undefined)
    })
    return { send, created }
  }

  test('**稽核 U6：存的 token 過期（server 換過鑰匙）→ 不開分頁、講「鑰匙過期」與 node cli.mjs open**', async t => {
    // **代碼從 BAD_TOKEN 換成 UNPROVEN（稽核第三輪 R3-7）**：現在連 401 都走不到 ——
    // 送出任何帶 token 的請求之前先要對方證明「手上有這把鑰匙」，而用舊鑰匙算出來的 proof
    // 跟真 server 用新鑰匙算的對不上。這一步分不出「我的鑰匙過期」與「那不是 ContextBox」
    //（兩者都是 HMAC 對不上），所以訊息要把兩種可能都講出來。
    // 這一條原本要守的三件事一個都不能少：不開分頁、講「鑰匙過期」與 node cli.mjs open、訊息不帶 token。
    const s = await serve(t, {})
    const bg = loadBackground({ token: 'old-token-from-last-week', port: s.port })
    const r = await bg.send({ type: 'open-home' })
    assert.equal(r?.ok, false, JSON.stringify(r))
    assert.equal(r.error, 'UNPROVEN')
    assert.equal(bg.created.length, 0, '一定打不開的分頁不要開')
    assert.match(r.message, /鑰匙過期/)
    assert.ok(r.message.includes('node cli.mjs open'), r.message)
    assert.ok(!r.message.includes('old-token-from-last-week'), '訊息會到網頁那一側，不可以帶 token')
    // 「一個帶 token 的請求都沒送出去」在 test/audit-0919-r3ext.test.mjs 用假的 fetch 逐一數
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

// ═══════════════════════════════════════════════════════════════════════
// 2026-09-19 稽核第二輪・清理面板（R2-5 面板端、C 的慢套用、MOVE_INTERRUPTED 的話）
//
// 期望值在實作之前寫死（build-round Step 1）。分級：P1、P2、P3 是高風險（部分失敗、重試、
// 跟輪詢的時間交錯；錯了畫面會安靜地說謊），P4 的文字與文件是低風險。
//
// | 段落 | 可能的錯誤 | 另一種合理解讀 | 能分辨兩者的例子（成對） | 認定的答案 |
// |---|---|---|---|---|
// | P1 撞到 CONFLICT、started | 照舊給「放棄上次那份：不動任何檔案」與放棄按鈕（按下去 409） | started 為 true 時改成「繼續」與「放回已經搬走的」 | 稽查員 B 的 r7：a、b、c 一份，套用到第一個之後 BUSY（1 個在隔離區）／對照：同樣的計畫還沒套用 | started：訊息不含「放棄上次那份」「不動任何檔案」，含「其中 1 個已經在隔離區」與兩個按鈕名；release() 不送請求；放棄按鈕藏起來、放回按鈕出現。沒開始：訊息一字不改、放棄按鈕照舊 |
// | P1 已經在隔離區的個數 | 用 items.length，或把 unknown 也算成「已經在隔離區」 | moved 才算；unknown 另外講「說不準」 | r7 的那一個 moved／把它的紀錄改回 started（unknown） | moved：「其中 1 個已經在隔離區」；unknown：「1 個搬到一半、說不準在原位還是在隔離區」，不說「已經在隔離區」 |
// | P1 放回已經搬走的 | 放回 lastPlan、或把還沒搬的算成「沒放回」 | 對那一份送 undo，只算原本在隔離區的 | r7 按放回 | 搬走的那個回到原位、計畫 restored；結果「放回原位 1 個檔案。」，還沒搬的兩個不列成沒放回 |
// | P1 繼續上次那份 | 只搬現在勾的 | 接著搬那一份 | r7 按繼續 | 三個都進隔離區、計畫 applied |
// | P1 開始過、但沒有檔在隔離區 | 只看 moved／unknown 判斷開始過沒有（只有 failed 紀錄的那份給出一定 409 的「放棄」） | 有任何一項不是 pending 就算開始過（跟後端「有搬移紀錄」一致） | 第一個搬失敗（紀錄是 failed）之後中斷／對照：還沒套用（上面） | 後端 release 回 409；面板不給放棄、說「目前沒有檔在隔離區」；放回之後「這份裡還沒搬的 3 個沒有動過」 |
// | P2 打開面板 | 只在撞到 CONFLICT 時才提示 | 一打開就查 ?pending=1 | A 的 exp9：計畫裡的 a.zip 被使用者刪了、清單上只剩 new.zip／對照：沒有 proposed 計畫 | exp9：一打開就提示 a.zip、放棄按鈕在、勾選鎖住，放棄之後計畫 dismissed、勾選解開；對照：沒有提示、放棄按鈕藏著、勾選可以改 |
// | P2 好幾份 | 拿最舊的、或一次全塞 | 一次一份（最新的那份），講另外還有幾份 | p1={a}（舊）、p2={z}（新） | 先提示 z、講「另外還有 1 份」；放棄 z、關掉再打開 → 提示 a、不講「另外」 |
// | P2 查不到 | 面板整個讀取失敗，或亂猜一份 | 照常顯示清單，撞到 CONFLICT 仍是入口 | ?pending=1 網路斷／計畫本身讀不到（started 的那份） | 前者：清單照常、不鎖，勾 a 清理 → 撞到 → 提示；後者：打開時不提示（不猜「沒開始」），撞到時用 blockingPlan 的 started，說「其中有些可能已經在隔離區」、沒有放棄按鈕 |
// | P2 結果不明時重新打開 | 用 ?pending=1 的那份蓋掉自己那份的「再試一次」 | 鎖住時不查 | 套用的回應丟了、關掉面板再打開 | 還是「再試一次」，按下去接完自己那份 |
// | P2 鎖住時別份出現 | 鎖住時照樣去查，查到別份就換成「繼續上次那份」（搬的是別人的） | 鎖住時根本不查 | 建計畫的請求沒送出去（自己那份沒建成）、關掉面板前 CLI 建了一份別的／對照：沒鎖 | 鎖住：不送 ?pending=1，還是「再試一次」，按下去搬的是自己勾的 a，CLI 那份還是 proposed、z 還在 |
// | P1／P4 放回、復原時「其實沒搬過」 | 一句都不講（只剩「這次沒有需要放回的檔案」），或算進「還沒搬的 N 個」 | 照後端的結論講「當初就沒有搬走」 | r7 搬走的那個倒回 rename 之前（檔在原位、紀錄停在 started）／對照：真的在隔離區的 unknown | 放回：多一行「・x 當初就沒有搬走，本來就在原位。」，「還沒搬的 2 個」不含它；復原同一行 |
// | P3 輪詢 | 動作進行中 /health 逾時 → 擔心、斷線泡泡 | 動作進行中的逾時不算數 | 套用卡在 server 時 /health 逾時／沒有動作時 /health 逾時 | 前者：petState 不是 worried、斷線按鈕藏著；後者：worried |
// | P3 時間交錯 | 只看「失敗的那一刻有沒有動作在跑」 | 這次輪詢的期間內有動作跑過就不算 | 輪詢先送出、套用接著開始、輪詢才逾時／套用做完之後的輪詢逾時 | 前者不擔心；後者擔心（照常輪詢） |
// | P3 後端回了話 | 動作進行中連 ok:false 也忽略 | 有回應就是結論 | 套用卡住時 /health 回 { ok: false } | worried |
// | P3 歷史面板的復原 | 只算清理面板的動作 | 歷史的復原也算 | 歷史復原卡在 server 時 /health 逾時 | 不擔心 |
// | P4 MOVE_INTERRUPTED | 還說「再套用一次這份計畫會把它接完」（partial／error 原樣回傳之後不成立） | 照實講 | GET 一份有 started 搬移紀錄的計畫 | why 不含「再套用一次」；含「說不準」「復原」「node cli.mjs doctor」 |
// | P5 性質（結構化隨機） | —— | —— | 30 種中斷樣子（沒碰過／在隔離區／說不準／搬失敗／略過的組合） | 面板給「放棄」⇒ 後端 release 回 200；不給而後端給得了，只會是「只有略過、沒有任何搬移紀錄」 |
// | P4 面板的復原鈕 | canUndo 只看 undoable（只有 unknown 時是 false，面板沒有「復原」可按） | moved 或 unknown 都算可以復原 | 套用結果只有一個 unknown（檔其實在隔離區）／對照：只有 failed | 前者 canUndo、按復原放回 1 個；後者 canUndo 是 false |
// ═══════════════════════════════════════════════════════════════════════

/** 一個可以從外面放行的關卡：reached 表示有請求停在這裡了 */
function gateOf() {
  let open
  const g = { reached: false, promise: new Promise(r => { open = r }) }
  g.open = () => open()
  return g
}

const TIMEOUT = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')
const petState = ui => ui.$('quaso').dataset.petState
const worried = ui => petState(ui) === 'worried' || ui.$('quaso-worried').hidden === false

/**
 * 稽查員 B 的 r7：names 建一份計畫，套用到第一個檔搬完之後，鎖被接走（trigger 模擬）。
 *
 * 稽核第三輪 R3-3 之後**不再是 503 BUSY**：核心停在那一項、把已經做完的收好，
 * 回 200＋`stoppedEarly`（呼叫端才報得出已經搬了幾個、給得出計畫 id）。
 * 計畫還是 proposed，已經有一個檔在隔離區。回 { planId, moved（搬走的那一個）, rest（還在的） }。
 */
async function interruptAfterFirst(s, names) {
  const candidateIds = []
  for (const n of names) candidateIds.push(...await s.idsOf(n))
  const plan = await s.raw('/cleanup/plans', { method: 'POST', body: JSON.stringify({ candidateIds, requestId: 'r7' }) })
  s.exec(`CREATE TRIGGER steal AFTER UPDATE OF status ON cleanup_journal WHEN NEW.status='done'
          BEGIN UPDATE cleanup_operation_lock SET owner='2099-01-01T00:00:00.000Z thief'; END`)
  const e = await s.raw(`/cleanup/plans/${plan.id}/apply`, { method: 'POST', body: '{}' }).catch(e => e)
  s.exec('DROP TRIGGER steal')
  s.exec('DELETE FROM cleanup_operation_lock')
  assert.ok(e?.stoppedEarly?.why, `前提：套用中途鎖被接走、回 stoppedEarly（${JSON.stringify(e)}）`)
  const moved = names.filter(n => !s.has(n))
  assert.equal(moved.length, 1, `前提：剛好一個搬走了（${moved}）`)
  assert.equal(s.planStatus(plan.id), 'proposed', '前提：計畫還是 proposed')
  return { planId: plan.id, moved: moved[0], rest: names.filter(n => n !== moved[0]) }
}

/** 把 name 的搬移紀錄改回 started（檔其實在隔離區）：逐項變成 unknown */
function toUnknown(s, planId, name) {
  s.exec(`UPDATE cleanup_journal SET status='started' WHERE plan_id=? AND op='quarantine'
            AND item_id=(SELECT id FROM file_items WHERE name=?)`, planId, name)
}

const OLD_PENDING_TEXT = names => `上次有一份清理沒做完：${names.join('、')}（${names.length} 個）。\n`
  + '按「繼續上次那份」會處理它 —— 只會動這幾個，不會動到你現在勾的其他檔案。\n'
  + '按「放棄上次那份」會把它作廢：不動任何檔案，這些檔也還會留在清單上。'

describe('P1 撞到做到一半中斷的計畫（blockingPlan.started）：不給放棄，給「繼續」與「放回已經搬走的」', () => {
  test('**稽查員 B 的 r7：套用中途 BUSY，面板照預設清理 → 提示講有 1 個已經在隔離區，沒有「放棄上次那份」；release() 不送請求**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 }, 'c.zip': { days: 60 } })
    const { planId, moved } = await interruptAfterFirst(s, ['a.zip', 'b.zip', 'c.zip'])
    const real = createReal(s.api)
    await real.load()
    const r = await real.apply()
    assert.equal(r.status, 'pending-plan', JSON.stringify(r))
    assert.equal(r.plan.id, planId)
    assert.equal(r.plan.started, true)
    const text = pendingPlanMessage(r.plan)
    assert.ok(!text.includes('放棄上次那份'), `開始過的計畫不能放棄：${text}`)
    assert.ok(!text.includes('不動任何檔案'), `已經有檔搬走了：${text}`)
    assert.ok(text.includes('其中 1 個已經在隔離區'), text)
    assert.ok(text.includes('繼續上次那份') && text.includes('放回已經搬走的'), text)
    assert.ok(text.includes(moved), text)
    s.calls.length = 0
    await assert.rejects(real.release(), e => !e.status, '不送請求，前端自己擋')
    assert.ok(!s.calls.some(c => c.path.endsWith('/release')), '一定是 409 的請求不要送')
    assert.equal(real.pendingPlan?.id, planId, '什麼都沒發生：還是提示同一份')
    assert.equal(s.planStatus(planId), 'proposed')
  })

  test('對照：同樣的計畫還沒套用 → started 是 false，提示一字不改（還是可以放棄）', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    await s.raw('/cleanup/plans', { method: 'POST', body: JSON.stringify({ candidateIds: await s.idsOf('a.zip') }) })
    const real = createReal(s.api)
    await real.load()
    const r = await real.apply()
    assert.equal(r.status, 'pending-plan')
    assert.equal(r.plan.started, false)
    assert.equal(pendingPlanMessage(r.plan), OLD_PENDING_TEXT(['a.zip']))
  })

  test('**已經在隔離區的只算 moved：搬到一半中斷的（unknown）另外講「說不準」**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 }, 'c.zip': { days: 60 } })
    const { planId, moved } = await interruptAfterFirst(s, ['a.zip', 'b.zip', 'c.zip'])
    toUnknown(s, planId, moved)
    const real = createReal(s.api)
    await real.load()
    const r = await real.apply()
    assert.equal(r.status, 'pending-plan', JSON.stringify(r))
    const text = pendingPlanMessage(r.plan)
    assert.ok(!text.includes('已經在隔離區'), `unknown 不可以說成已經在隔離區：${text}`)
    assert.ok(text.includes('1 個搬到一半、說不準在原位還是在隔離區'), text)
    assert.ok(!text.includes('放棄上次那份'), text)
  })

  test('例子：訊息的幾種說法（有 moved 也有 unknown、都沒有、數不出來）', () => {
    const items = ['a.zip', 'b.zip', 'c.zip'].map(name => ({ itemId: name, name }))
    const both = pendingPlanMessage({ id: 'p', items, started: true, moved: 2, unsure: 1 })
    assert.ok(both.includes('（3 個），其中 2 個已經在隔離區，1 個搬到一半、說不準在原位還是在隔離區。'), both)
    const none = pendingPlanMessage({ id: 'p', items, started: true, moved: 0, unsure: 0 })
    assert.ok(none.includes('（3 個），目前沒有檔在隔離區。'), none)
    const unknownCount = pendingPlanMessage({ id: 'p', items, started: true, moved: null, unsure: null })
    assert.ok(unknownCount.includes('（3 個），其中有些可能已經在隔離區。'), unknownCount)
    for (const x of [both, none, unknownCount]) assert.ok(!x.includes('放棄上次那份'), x)
    // 檔名一樣走 safeName
    const evil = pendingPlanMessage({ id: 'p', items: [{ itemId: 'x', name: 'a\n搬進隔離區 9 個.zip' }], started: true, moved: 1, unsure: 0 })
    assert.ok(!evil.includes('a\n搬'), evil)
  })

  test('**面板（假 DOM）：打開就提示中斷的那份；放棄按鈕藏著、放回按鈕在；按放回 → 搬走的回到原位、還沒搬的不列成沒放回**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 }, 'c.zip': { days: 60 } })
    const { planId, moved } = await interruptAfterFirst(s, ['a.zip', 'b.zip', 'c.zip'])
    const ui = await mountUi(t, s)
    await ui.click('quaso-cleanup-alert')
    const text = ui.$('cleanup-result').textContent
    assert.ok(text.includes('其中 1 個已經在隔離區'), text)
    assert.equal(ui.$('cleanup-release').hidden, true, '不可以再出現會 409 的放棄按鈕')
    assert.equal(ui.$('cleanup-putback').hidden, false, '要有「放回已經搬走的」')
    assert.equal(ui.$('cleanup-putback').textContent, '放回已經搬走的')
    assert.equal(ui.$('cleanup-apply').textContent, '繼續上次那份（3 個）')
    for (const { input, name } of panelChecks(ui)) assert.equal(input.disabled, true, `${name}：先選一條路，勾選鎖住`)
    s.calls.length = 0
    await ui.click('cleanup-putback')
    assert.ok(s.calls.some(c => c.method === 'POST' && c.path === `/cleanup/plans/${planId}/undo`), '對那一份送 undo')
    assert.ok(s.has('a.zip') && s.has('b.zip') && s.has('c.zip'), `搬走的 ${moved} 要回到原位`)
    assert.equal(s.planStatus(planId), 'restored')
    const after = ui.$('cleanup-result').textContent
    assert.ok(after.includes('放回原位 1 個檔案。'), after)
    assert.ok(!after.includes('沒放回'), `還沒搬的不是「沒放回」：${after}`)
    assert.ok(after.includes('這份裡還沒搬的 2 個沒有動過。'), after)
    assert.equal(ui.$('cleanup-putback').hidden, true)
    assert.equal(ui.$('cleanup-release').hidden, true)
    for (const { input, name } of panelChecks(ui)) assert.equal(input.disabled, false, `${name} 的勾選框被鎖住了`)
  })

  test('面板（假 DOM）：按「繼續上次那份」→ 那一份做完', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 }, 'c.zip': { days: 60 } })
    const { planId } = await interruptAfterFirst(s, ['a.zip', 'b.zip', 'c.zip'])
    const ui = await mountUi(t, s)
    await ui.click('quaso-cleanup-alert')
    await ui.click('cleanup-apply')
    assert.equal(s.planStatus(planId), 'applied')
    assert.ok(!s.has('a.zip') && !s.has('b.zip') && !s.has('c.zip'))
    assert.match(ui.$('cleanup-result').textContent, /搬進隔離區 3 個檔案/)
    assert.equal(ui.$('cleanup-putback').hidden, true)
  })

  test('面板（假 DOM）：unknown 的那個也放得回來（檔其實在隔離區）', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 }, 'c.zip': { days: 60 } })
    const { planId, moved } = await interruptAfterFirst(s, ['a.zip', 'b.zip', 'c.zip'])
    toUnknown(s, planId, moved)
    const ui = await mountUi(t, s)
    await ui.click('quaso-cleanup-alert')
    assert.ok(ui.$('cleanup-result').textContent.includes('說不準'), ui.$('cleanup-result').textContent)
    assert.equal(ui.$('cleanup-release').hidden, true)
    await ui.click('cleanup-putback')
    assert.ok(s.has(moved), `${moved} 要回到原位`)
    assert.ok(ui.$('cleanup-result').textContent.includes('放回原位 1 個檔案。'), ui.$('cleanup-result').textContent)
    // 對照（下一條）：真的在隔離區、放回來的，不可以說成「當初就沒有搬走」
    assert.ok(!ui.$('cleanup-result').textContent.includes('當初就沒有搬走'), ui.$('cleanup-result').textContent)
  })

  test('**放回：搬到一半中斷、其實還在原位的那個（rename 之前當機）→ 說「當初就沒有搬走」，不算進「還沒搬的」**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 }, 'c.zip': { days: 60 } })
    const { planId, moved } = await interruptAfterFirst(s, ['a.zip', 'b.zip', 'c.zip'])
    s.interruptMove(planId, moved)              // 倒回 rename 之前：檔在原位，紀錄停在 started
    assert.ok(s.has('a.zip') && s.has('b.zip') && s.has('c.zip'), '前提：三個都在原位')
    const ui = await mountUi(t, s)
    await ui.click('quaso-cleanup-alert')
    const hint = ui.$('cleanup-result').textContent
    assert.ok(hint.includes('其中 1 個搬到一半、說不準在原位還是在隔離區'), hint)
    await ui.click('cleanup-putback')
    assert.equal(ui.$('cleanup-result').textContent,
      `這次沒有需要放回的檔案。\n・${moved} 當初就沒有搬走，本來就在原位。\n這份裡還沒搬的 2 個沒有動過。`)
    assert.ok(s.has('a.zip') && s.has('b.zip') && s.has('c.zip'))
    assert.equal(ui.$('cleanup-putback').hidden, true)
  })

  test('**開始過、但只有搬失敗的紀錄（沒有檔在隔離區）→ 還是不給放棄（後端一定 409）；放回之後說還沒搬的 3 個沒有動過**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 }, 'c.zip': { days: 60 } })
    const { planId, moved } = await interruptAfterFirst(s, ['a.zip', 'b.zip', 'c.zip'])
    // 第一個其實是搬失敗（例如 EXDEV：rename 沒成功，檔在原位），之後才中斷
    s.interruptMove(planId, moved)
    s.exec(`UPDATE cleanup_journal SET status='failed', error='隔離區跟這個檔不在同一顆碟。' WHERE plan_id=? AND op='quarantine'`, planId)
    assert.ok(s.has('a.zip') && s.has('b.zip') && s.has('c.zip'), '前提：三個都在原位')
    await assert.rejects(s.raw(`/cleanup/plans/${planId}/release`, { method: 'POST', body: '{}' }), e => e.status === 409,
      '前提：後端認定它開始過，不給放棄')
    const ui = await mountUi(t, s)
    await ui.click('quaso-cleanup-alert')
    const hint = ui.$('cleanup-result').textContent
    assert.ok(hint.includes('（3 個），目前沒有檔在隔離區。'), hint)
    assert.ok(!hint.includes('放棄上次那份'), hint)
    assert.equal(ui.$('cleanup-release').hidden, true, '不可以出現會 409 的放棄按鈕')
    assert.equal(ui.$('cleanup-putback').hidden, false)
    await ui.click('cleanup-putback')
    assert.equal(ui.$('cleanup-result').textContent, '這次沒有需要放回的檔案。\n這份裡還沒搬的 3 個沒有動過。')
    assert.equal(s.planStatus(planId), 'restored', '這份結掉了，不再佔住檔案')
    assert.ok(s.has('a.zip') && s.has('b.zip') && s.has('c.zip'))
  })

  test('面板的放回回有 status 的錯 → 解鎖、照實講原因；回應丟了 → 還是那一份、還鎖著', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    const { planId } = await interruptAfterFirst(s, ['a.zip', 'b.zip'])
    const real = createReal(s.api)
    await real.load()
    assert.equal((await real.apply()).status, 'pending-plan')
    s.setHook((p, m) => (m === 'POST' && p.endsWith('/undo') ? 'lose' : undefined))
    await assert.rejects(real.putBack())
    s.setHook(null)
    assert.equal(real.pendingPlan?.id, planId, '不知道放回了沒有：還是那一份')
    assert.equal(real.locked, true)
    const r = await real.putBack()        // undo 是冪等的，再按一次就好
    // 第一次其實已經放回去了（只是回應丟了）：照「提示時在隔離區的那些」對，還是說放回 1 個，
    // 不是「這次沒有需要放回的檔案」
    assert.equal(r.restored, 1, JSON.stringify(r))
    assert.equal(undoMessage(r).text.split('\n')[0], '放回原位 1 個檔案。')
    assert.equal(s.planStatus(planId), 'restored')
    assert.ok(s.has('a.zip') && s.has('b.zip'))
    assert.equal(real.locked, false)
    // 有 status 的錯：另一份
    const s2 = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    await interruptAfterFirst(s2, ['a.zip', 'b.zip'])
    const real2 = createReal(s2.api)
    await real2.load()
    assert.equal((await real2.apply()).status, 'pending-plan')
    s2.setHook((p, m) => (m === 'POST' && p.endsWith('/undo') ? { status: 503, body: { error: '另一個清理動作正在進行，請稍後重試。', code: 'BUSY' } } : undefined))
    const e = await real2.putBack().catch(e => e)
    assert.equal(e.status, 503)
    assert.equal(real2.pendingPlan, null, '伺服器明確回錯：解鎖')
    assert.equal(real2.locked, false)
  })
})

describe('P2 面板一打開就查 ?pending=1：有待處理的計畫就先提示，不用等撞到 CONFLICT', () => {
  test('**A 的 exp9：計畫裡的 a.zip 被使用者刪了、清單上只剩 new.zip → 一打開就提示 a.zip；放棄之後計畫作廢、勾選解開**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const p = await s.raw('/cleanup/plans', { method: 'POST', body: JSON.stringify({ candidateIds: await s.idsOf('a.zip') }) })
    rmSync(join(s.downloads, 'a.zip'))
    const old = new Date(Date.now() - 120 * DAY)
    writeFileSync(join(s.downloads, 'new.zip'), 'nnnn')
    utimesSync(join(s.downloads, 'new.zip'), old, old)
    await s.raw('/cleanup/scan', { method: 'POST', body: '{}' })
    const ui = await mountUi(t, s)
    await ui.click('quaso-cleanup-alert')
    assert.deepEqual(panelChecks(ui).map(c => c.name), ['new.zip'], '前提：a.zip 不在清單上')
    assert.equal(ui.$('cleanup-result').hidden, false)
    assert.equal(ui.$('cleanup-result').textContent, OLD_PENDING_TEXT(['a.zip']))
    assert.equal(ui.$('cleanup-release').hidden, false)
    assert.equal(ui.$('cleanup-putback').hidden, true, '還沒開始的那份沒有東西可以放回')
    assert.equal(ui.$('cleanup-apply').textContent, '繼續上次那份（1 個）')
    assert.equal(panelChecks(ui)[0].input.disabled, true, '先選一條路')
    await ui.click('cleanup-release')
    assert.equal(s.planStatus(p.id), 'dismissed')
    assert.match(ui.$('cleanup-result').textContent, /已放棄上次那份/)
    assert.equal(panelChecks(ui)[0].input.disabled, false)
    assert.equal(ui.$('cleanup-apply').textContent, '清理勾選的 1 個檔案')
  })

  test('對照：沒有待處理的計畫 → 不提示、放棄按鈕藏著、勾選可以改', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const ui = await mountUi(t, s)
    await ui.click('quaso-cleanup-alert')
    assert.ok(s.calls.some(c => c.method === 'GET' && c.path.startsWith('/cleanup/plans?') && c.path.includes('pending=1')), '要真的去查')
    assert.equal(ui.$('cleanup-result').hidden, true)
    assert.equal(ui.$('cleanup-release').hidden, true)
    assert.equal(ui.$('cleanup-putback').hidden, true)
    assert.equal(panelChecks(ui)[0].input.disabled, false)
    assert.equal(ui.$('cleanup-apply').textContent, '清理勾選的 1 個檔案')
  })

  test('好幾份：先提示最新的那份、講另外還有幾份；放棄之後關掉再打開 → 提示下一份', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'z.zip': { days: 60 }, 'm.zip': { days: 60 } })
    const p1 = await s.raw('/cleanup/plans', { method: 'POST', body: JSON.stringify({ candidateIds: await s.idsOf('a.zip') }) })
    await new Promise(r => setTimeout(r, 5))
    const p2 = await s.raw('/cleanup/plans', { method: 'POST', body: JSON.stringify({ candidateIds: await s.idsOf('z.zip') }) })
    const ui = await mountUi(t, s)
    await ui.click('quaso-cleanup-alert')
    const first = ui.$('cleanup-result').textContent
    assert.ok(first.startsWith(OLD_PENDING_TEXT(['z.zip'])), first)
    assert.ok(first.includes('另外還有 1 份'), first)
    await ui.click('cleanup-release')
    assert.equal(s.planStatus(p2.id), 'dismissed')
    assert.equal(s.planStatus(p1.id), 'proposed', '另一份不動')
    ui.$('cleanup-panel').close()
    await ui.click('quaso-cleanup-alert')
    const second = ui.$('cleanup-result').textContent
    assert.equal(second, OLD_PENDING_TEXT(['a.zip']))
    assert.ok(s.has('a.zip') && s.has('z.zip') && s.has('m.zip'))
  })

  test('?pending=1 查不到（網路斷）→ 清單照常、不鎖；勾 a 清理撞到那份 → 照樣提示（CONFLICT 仍是入口）', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    const p = await s.raw('/cleanup/plans', { method: 'POST', body: JSON.stringify({ candidateIds: await s.idsOf('a.zip') }) })
    s.setHook((path, m) => (m === 'GET' && path.includes('pending=1') ? 'before' : undefined))
    const ui = await mountUi(t, s)
    await ui.click('quaso-cleanup-alert')
    assert.equal(panelChecks(ui).length, 2, ui.$('cleanup-list').textContent)
    assert.equal(ui.$('cleanup-result').hidden, true)
    for (const { input, name } of panelChecks(ui)) assert.equal(input.disabled, false, `${name} 被鎖住了`)
    await uiOnly(ui, 'a.zip')
    await ui.click('cleanup-apply')
    assert.equal(ui.$('cleanup-result').textContent, OLD_PENDING_TEXT(['a.zip']))
    assert.equal(ui.$('cleanup-apply').textContent, '繼續上次那份（1 個）')
    assert.equal(s.planStatus(p.id), 'proposed')
    assert.ok(s.has('a.zip') && s.has('b.zip'))
  })

  test('**開始過的那份讀不到細節 → 打開時不猜（不給放棄）；照預設清理撞到它 → 用 blockingPlan 的 started，說「其中有些可能已經在隔離區」**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 }, 'c.zip': { days: 60 } })
    const { planId } = await interruptAfterFirst(s, ['a.zip', 'b.zip', 'c.zip'])
    s.setHook((path, m) => (m === 'GET' && path === `/cleanup/plans/${planId}` ? 'before' : undefined))
    const ui = await mountUi(t, s)
    await ui.click('quaso-cleanup-alert')
    assert.equal(ui.$('cleanup-release').hidden, true, '說不準開始了沒，不可以給放棄')
    assert.ok(!/放棄上次那份/.test(ui.$('cleanup-result').hidden ? '' : ui.$('cleanup-result').textContent))
    await ui.click('cleanup-apply')                // 預設勾選：還在清單上的那兩個 → 撞到中斷的那份
    const text = ui.$('cleanup-result').textContent
    assert.ok(text.includes('其中有些可能已經在隔離區'), text)
    assert.ok(!text.includes('放棄上次那份'), text)
    assert.equal(ui.$('cleanup-release').hidden, true, '不可以再出現會 409 的放棄按鈕')
    assert.equal(ui.$('cleanup-putback').hidden, false)
    assert.equal(s.planStatus(planId), 'proposed')
  })

  test('結果不明（套用的回應丟了）→ 關掉再打開：還是「再試一次」，不被 ?pending=1 的那份蓋掉；按下去接完自己那份', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const ui = await mountUi(t, s)
    await ui.click('quaso-cleanup-alert')
    s.setHook((p, m) => (m === 'POST' && p.endsWith('/apply') ? 'before' : undefined))
    await ui.click('cleanup-apply')
    s.setHook(null)
    assert.match(ui.$('cleanup-result').textContent, /還沒確認/)
    ui.$('cleanup-panel').close()
    await ui.click('quaso-cleanup-alert')
    assert.match(ui.$('cleanup-result').textContent, /上一次清理的結果還沒確認/)
    assert.equal(ui.$('cleanup-apply').textContent, '再試一次')
    assert.equal(ui.$('cleanup-release').hidden, true)
    await ui.click('cleanup-apply')
    assert.ok(!s.has('a.zip'))
    assert.equal(s.q('SELECT count(*) n FROM cleanup_plans')[0].n, 1, '沒有多建一份')
  })

  test('**鎖住（結果不明）時根本不查 ?pending=1：之間 CLI 建了別的一份，也還是「再試一次」，搬的是自己勾的**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'z.zip': { days: 60 } })
    const ui = await mountUi(t, s)
    await ui.click('quaso-cleanup-alert')
    await uiOnly(ui, 'a.zip')
    // 建計畫的請求沒送到：自己那份沒建成。後端待會只有 CLI 建的那一份，?pending=1 查得到的就是它
    s.setHook((p, m) => (m === 'POST' && p === '/cleanup/plans' ? 'before' : undefined))
    await ui.click('cleanup-apply')
    s.setHook(null)
    assert.match(ui.$('cleanup-result').textContent, /還沒確認/)
    const other = await s.raw('/cleanup/plans', { method: 'POST', body: JSON.stringify({ candidateIds: await s.idsOf('z.zip') }) })
    ui.$('cleanup-panel').close()
    s.calls.length = 0
    await ui.click('quaso-cleanup-alert')
    assert.ok(!s.calls.some(c => c.path.includes('pending=1')), `鎖住的時候不查：${JSON.stringify(s.calls)}`)
    assert.match(ui.$('cleanup-result').textContent, /上一次清理的結果還沒確認/)
    assert.equal(ui.$('cleanup-apply').textContent, '再試一次')
    assert.equal(ui.$('cleanup-release').hidden, true)
    assert.equal(ui.$('cleanup-putback').hidden, true)
    await ui.click('cleanup-apply')
    assert.ok(!s.has('a.zip'), '搬的是自己勾的 a')
    assert.ok(s.has('z.zip'), 'CLI 那份的 z 不動')
    assert.equal(s.planStatus(other.id), 'proposed')
  })
})

describe('P3 面板自己有動作在跑時，/health 逾時不算斷線（稽核 C：800 個檔的套用要 27 秒）', () => {
  /**
   * 假的慢 api：POST 符合 slow 的請求停在關卡，直到測試放行；/health 照 health() 的回答：
   * 'ok' 真的送、'timeout' 丟逾時、'bad' 回 { ok: false }、gate 物件就停在那個關卡，放行時丟逾時。
   */
  async function slowUi(t, s, slow) {
    const ctl = { gate: null, health: 'ok' }
    const wrap = async (url, init, next) => {
      const path = String(url)
      if (path.startsWith('/health')) {
        const h = ctl.health
        if (h === 'timeout') throw TIMEOUT()
        if (h === 'bad') return new Response(JSON.stringify({ ok: false }), { status: 200 })
        if (h && typeof h === 'object') { h.reached = true; await h.promise; throw TIMEOUT() }
        return next(url, init)
      }
      if (ctl.gate && (init?.method ?? 'GET') === 'POST' && slow.test(path)) {
        const g = ctl.gate
        g.reached = true
        await g.promise
      }
      return next(url, init)
    }
    const ui = await mountUi(t, s, { wrap })
    await until(() => petState(ui) && petState(ui) !== 'worried', '第一次輪詢拿到 /health')
    return { ui, ctl, poll: () => ui.$('quaso-connection-retry').onclick() }
  }

  test('**套用還沒回來時 /health 逾時 → 寵物不擔心、不跳斷線；套用回來之後照常輪詢（逾時就擔心）**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const { ui, ctl, poll } = await slowUi(t, s, /\/apply$/)
    await ui.click('quaso-cleanup-alert')
    ctl.gate = gateOf()
    const applying = ui.$('cleanup-apply').onclick()
    await until(() => ctl.gate.reached, '套用的請求停在 server')
    ctl.health = 'timeout'
    await poll()
    assert.equal(worried(ui), false, `套用還在跑，/health 逾時不代表斷線（petState=${petState(ui)}）`)
    assert.equal(ui.$('quaso-worried').hidden, true)
    ctl.health = 'ok'
    ctl.gate.open()
    await applying
    await ui.idle()
    assert.ok(!s.has('a.zip'))
    await until(() => petState(ui) !== 'worried' && ui.$('quaso-connection-retry').disabled === false, '套用之後輪詢一次')
    ctl.health = 'timeout'
    await poll()
    assert.equal(petState(ui), 'worried', '動作結束了，逾時就要照常說斷線')
    assert.equal(ui.$('quaso-worried').hidden, false)
  })

  test('對照：沒有動作在跑時 /health 逾時 → 擔心、斷線按鈕出現', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const { ui, ctl, poll } = await slowUi(t, s, /\/apply$/)
    ctl.health = 'timeout'
    await poll()
    assert.equal(petState(ui), 'worried')
    assert.equal(ui.$('quaso-worried').hidden, false)
  })

  test('**輪詢先送出、套用接著開始、輪詢才逾時 → 也不算數**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const { ui, ctl, poll } = await slowUi(t, s, /\/apply$/)
    await ui.click('quaso-cleanup-alert')
    const h = gateOf()
    ctl.health = h
    const polling = poll()
    await until(() => h.reached, '/health 送出去了')
    ctl.gate = gateOf()
    const applying = ui.$('cleanup-apply').onclick()
    await until(() => ctl.gate.reached, '套用的請求停在 server')
    h.open()                                    // 這次 /health 逾時
    await polling
    assert.equal(worried(ui), false, `這次輪詢期間套用開始了，逾時不算數（petState=${petState(ui)}）`)
    ctl.health = 'ok'
    ctl.gate.open()
    await applying
    await ui.idle()
  })

  test('**套用中送出的輪詢、套用做完之後才逾時 → 還是不算數；下一次輪詢照常算**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const { ui, ctl, poll } = await slowUi(t, s, /\/apply$/)
    await ui.click('quaso-cleanup-alert')
    ctl.gate = gateOf()
    const applying = ui.$('cleanup-apply').onclick()
    await until(() => ctl.gate.reached, '套用的請求停在 server')
    const h = gateOf()
    ctl.health = h
    const polling = poll()
    await until(() => h.reached, '/health 送出去了')
    ctl.gate.open()
    await applying                              // 套用做完了，那一次輪詢還掛著
    await ui.idle()
    h.open()                                    // 現在才逾時（server 剛才在忙）
    await polling
    assert.equal(worried(ui), false, `這次輪詢跟套用重疊過，逾時不算數（petState=${petState(ui)}）`)
    ctl.health = 'timeout'
    await poll()
    assert.equal(petState(ui), 'worried', '下一次輪詢照常算')
  })

  test('第一次輪詢就跟動作重疊、逾時 → 不擔心（還沒有結論，不是斷線）', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const ctl = { health: gateOf(), gate: null }
    const wrap = async (url, init, next) => {
      const path = String(url)
      if (path.startsWith('/health')) {
        const h = ctl.health
        if (h && typeof h === 'object') { h.reached = true; await h.promise; throw TIMEOUT() }
        return next(url, init)
      }
      if (ctl.gate && init?.method === 'POST' && path.endsWith('/apply')) { ctl.gate.reached = true; await ctl.gate.promise }
      return next(url, init)
    }
    const first = ctl.health
    const ui = await mountUi(t, s, { wrap })
    await until(() => first.reached, '第一次輪詢送出去了')
    await ui.click('quaso-cleanup-alert')
    ctl.gate = gateOf()
    const applying = ui.$('cleanup-apply').onclick()
    await until(() => ctl.gate.reached, '套用的請求停在 server')
    first.open()
    await new Promise(r => setTimeout(r, 30))
    assert.equal(worried(ui), false, `petState=${petState(ui)}`)
    ctl.health = 'ok'
    ctl.gate.open()
    await applying
    await ui.idle()
  })

  test('對照：套用進行中 /health 回了話、說後端壞了（ok: false）→ 那是結論，照樣擔心', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const { ui, ctl, poll } = await slowUi(t, s, /\/apply$/)
    await ui.click('quaso-cleanup-alert')
    ctl.gate = gateOf()
    const applying = ui.$('cleanup-apply').onclick()
    await until(() => ctl.gate.reached, '套用的請求停在 server')
    ctl.health = 'bad'
    await poll()
    assert.equal(petState(ui), 'worried', '後端明確說壞了')
    ctl.health = 'ok'
    ctl.gate.open()
    await applying
    await ui.idle()
  })

  test('歷史面板的復原還沒回來時 /health 逾時 → 也不擔心', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    await applyNames(s, 'a.zip')
    const { ui, ctl, poll } = await slowUi(t, s, /\/undo$/)
    await ui.click('quaso-history-open')
    const check = ui.$('cleanup-history-list').all('input')[0]
    check.checked = true
    check.onchange()
    ctl.gate = gateOf()
    const undoing = ui.$('cleanup-history-undo').onclick()
    await until(() => ctl.gate.reached, '復原的請求停在 server')
    ctl.health = 'timeout'
    await poll()
    assert.equal(worried(ui), false, `復原還在跑（petState=${petState(ui)}）`)
    ctl.health = 'ok'
    ctl.gate.open()
    await undoing
    await ui.idle()
    assert.ok(s.has('a.zip'))
  })
})

describe('P4 搬到一半中斷的話照實講；面板找得到「復原」', () => {
  test('**MOVE_INTERRUPTED：不說「再套用一次會接完」，說不準在哪、按復原放回在隔離區的、可以跑 doctor**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const planId = await applyNames(s, 'a.zip')
    toUnknown(s, planId, 'a.zip')
    const plan = await s.raw(`/cleanup/plans/${planId}`)
    const why = plan.items[0].why
    assert.equal(plan.items[0].outcome, 'unknown')
    assert.ok(!why.includes('再套用一次'), `partial／error 原樣回傳之後這句不成立：${why}`)
    assert.ok(why.startsWith('搬到一半中斷'), why)
    assert.ok(why.includes('說不準'), why)
    assert.ok(why.includes('按「復原」會把在隔離區的放回原位'), why)
    assert.ok(why.includes('node cli.mjs doctor'), why)
  })

  test('RESTORE_INTERRUPTED：說不準放回了沒有、再按一次復原會接著放回', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const planId = await applyNames(s, 'a.zip')
    await s.interruptRestore(planId)
    const plan = await s.raw(`/cleanup/plans/${planId}`)
    const why = plan.items[0].why
    assert.equal(plan.items[0].outcome, 'unknown')
    assert.ok(why.startsWith('復原到一半中斷'), why)
    assert.ok(why.includes('說不準'), why)
    assert.ok(why.includes('再按一次復原'), why)
    assert.ok(why.includes('node cli.mjs doctor'), why)
  })

  test('core 與 docs/api 裡不再有「再套用一次這份計畫會把它接完」', () => {
    const hits = []
    const walk = d => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) { if (e.name !== 'vendor') walk(p) }
        else if (/\.(ts|js|mjs|md|json|html)$/.test(e.name) && readFileSync(p, 'utf8').includes('再套用一次這份計畫會把它接完')) hits.push(p.replace(REPO + '/', ''))
      }
    }
    walk(join(REPO, 'core'))
    // docs 整棵都要掃，不是只有 docs/api（第三輪 B）：docs/cli.md 剛好在掃描範圍外，
    // 所以它原樣引用這句已經刪掉的字串半年都沒人發現，整套照樣全綠。
    walk(join(REPO, 'docs'))
    assert.deepEqual(hits, [])
  })

  test('**套用結果只有 unknown（檔其實在隔離區）→ 面板有「復原」可按，按下去放回 1 個**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const real = createReal(s.api)
    await real.load()
    s.setHook((p, m) => (m === 'POST' && p.endsWith('/apply') ? 'lose' : undefined))
    await assert.rejects(real.apply())
    s.setHook(null)
    const planId = s.q('SELECT id FROM cleanup_plans')[0].id
    toUnknown(s, planId, 'a.zip')
    const r = await real.apply()                   // 再試一次：拿到現在的樣子（applied、a 是 unknown）
    assert.deepEqual(r.unknown.map(i => i.name), ['a.zip'], JSON.stringify(r))
    assert.equal(r.undoable, false, '前提：後端的 undoable 只算 done 的')
    assert.equal(real.canUndo, true, '訊息叫人按「復原」，面板就要有得按')
    const u = await real.undo()
    assert.ok(s.has('a.zip'))
    assert.equal(u.restored, 1, JSON.stringify(u))
    assert.equal(undoMessage(u).text, '放回原位 1 個檔案。')
  })

  test('**套用結果只有 unknown、其實還在原位（rename 之前當機）→ 按復原：講「當初就沒有搬走」，不是只說「這次沒有需要放回的檔案」**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const real = createReal(s.api)
    await real.load()
    s.setHook((p, m) => (m === 'POST' && p.endsWith('/apply') ? 'lose' : undefined))
    await assert.rejects(real.apply())
    s.setHook(null)
    const planId = s.q('SELECT id FROM cleanup_plans')[0].id
    s.interruptMove(planId, 'a.zip')
    assert.ok(s.has('a.zip'), '前提：檔在原位')
    const r = await real.apply()
    assert.deepEqual(r.unknown.map(i => i.name), ['a.zip'], JSON.stringify(r))
    assert.equal(real.canUndo, true)
    const u = await real.undo()
    assert.ok(s.has('a.zip'))
    assert.equal(u.restored, 0, JSON.stringify(u))
    assert.deepEqual(u.neverMoved, [{ name: 'a.zip' }])
    const m = undoMessage(u)
    assert.equal(m.text, '這次沒有需要放回的檔案。\n・a.zip 當初就沒有搬走，本來就在原位。')
    assert.equal(m.notice, '這次沒有要放回的檔案。')
  })

  test('對照：套用結果只有 failed（原檔都在原位）→ canUndo 是 false', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const real = createReal(s.api)
    await real.load()
    rmSync(join(s.downloads, 'a.zip'))
    const r = await real.apply()
    assert.equal(r.failed.length, 1, JSON.stringify(r))
    assert.equal(real.canUndo, false)
  })
})

describe('P5 性質：面板給「放棄」的那一份，後端一定放棄得了（結構化隨機）', () => {
  /**
   * 每一輪：k 個檔建一份計畫、真的套用完，再把每一項倒回成指定的下場，計畫改回 proposed ——
   * 等於「套用做到一半中斷」的各種樣子。下場：
   *   pending（從沒碰過：倒回原位、刪掉搬移紀錄）、moved（在隔離區）、unknown（在隔離區、紀錄停在 started）、
   *   inPlace（rename 之前當機：在原位、紀錄停在 started）、failed（搬失敗：在原位、紀錄 failed）、
   *   skipNoJournal（帶 skippedIds 套用、還沒碰到它就中斷：只有略過、沒有紀錄）、skipped（略過，有 skip 紀錄）
   * 性質：
   *   1. 面板給「放棄」（checkPending 的 started 是 false）⇒ 後端的 release 回 200（面板不給一定 409 的按鈕）
   *   2. 面板不給、後端卻放棄得了 ⇒ 只有 pending 與 skipNoJournal（已知的偏保守，見 pendingFrom）
   *   3. 「幾個已經在隔離區」＝ moved 的個數；「說不準」＝ unknown＋inPlace
   *   4. ?pending=1 列得出來 ⇔ 面板提示得出來；提示了，訊息有沒有「放棄上次那份」跟 started 一致
   */
  const FATES = ['pending', 'moved', 'unknown', 'inPlace', 'failed', 'skipNoJournal', 'skipped']
  function rng(seed) {
    let x = seed >>> 0 || 1
    return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 2 ** 32 }
  }
  // 種子：全部沒碰過、全部在隔離區（不在 ?pending=1）、只有失敗、只有略過沒紀錄、只有原位的 unknown、混的
  const FIXED = [
    ['pending'], ['pending', 'pending', 'pending'], ['moved'], ['moved', 'moved'], ['failed'], ['failed', 'pending'],
    ['skipNoJournal', 'pending'], ['skipNoJournal'], ['skipped', 'pending'], ['inPlace'], ['unknown', 'pending'],
    ['moved', 'pending', 'pending'], ['moved', 'unknown', 'inPlace', 'failed'], ['skipped', 'moved'],
  ]

  async function build(t, fates) {
    const names = fates.map((_, i) => `f${i}.zip`)
    const s = await serve(t, Object.fromEntries(names.map(n => [n, { days: 60 }])))
    const candidateIds = []
    for (const n of names) candidateIds.push(...await s.idsOf(n))
    const plan = await s.raw('/cleanup/plans', { method: 'POST', body: JSON.stringify({ candidateIds, requestId: 'p5' }) })
    await s.raw(`/cleanup/plans/${plan.id}/apply`, { method: 'POST', body: '{}' })
    for (const [i, fate] of fates.entries()) {
      const j = s.q(`SELECT j.* FROM cleanup_journal j JOIN file_items f ON f.id = j.item_id
                      WHERE j.plan_id=? AND j.op='quarantine' AND f.name=?`, plan.id, names[i])[0]
      assert.ok(j, `前提：${names[i]} 搬過`)
      const itemCands = `candidate_id IN (SELECT id FROM cleanup_candidates WHERE item_id='${j.item_id}')`
      if (fate === 'moved') continue
      if (fate === 'unknown') { s.exec(`UPDATE cleanup_journal SET status='started' WHERE seq=?`, j.seq); continue }
      s.interruptMove(plan.id, names[i])                  // 檔回原位、紀錄停在 started
      if (fate === 'inPlace') continue
      if (fate === 'failed') { s.exec(`UPDATE cleanup_journal SET status='failed', error='搬不動。' WHERE seq=?`, j.seq); continue }
      s.exec('DELETE FROM cleanup_move_details WHERE seq=?', j.seq)
      s.exec('DELETE FROM cleanup_journal WHERE seq=?', j.seq)
      if (fate === 'pending') continue
      s.exec(`UPDATE cleanup_plan_items SET skipped=1 WHERE plan_id=? AND ${itemCands}`, plan.id)
      if (fate === 'skipped') {
        s.exec(`INSERT INTO cleanup_journal(ts,plan_id,item_id,op,status) VALUES (?,?,?,'skip','done')`,
          new Date().toISOString(), plan.id, j.item_id)
      }
    }
    s.exec(`UPDATE cleanup_plans SET status='proposed', applied_at=NULL WHERE id=?`, plan.id)
    return { s, planId: plan.id }
  }

  test('**面板給「放棄」⇒ 後端放棄得了；幾個在隔離區照逐項結果**（14 個種子＋隨機 16 輪）', async t => {
    const random = rng(20260919)
    const cases = [...FIXED]
    while (cases.length < 30) {
      const k = 1 + Math.floor(random() * 4)
      cases.push(Array.from({ length: k }, () => FATES[Math.floor(random() * FATES.length)]))
    }
    const hits = { offered: 0, withheld: 0, conservative: 0, notListed: 0, moved: 0, unsure: 0 }
    for (const fates of cases) {
      const { s, planId } = await build(t, fates)
      const listed = (await s.raw('/cleanup/plans?pending=1')).operations.some(o => o.id === planId)
      const real = createReal(s.api)
      await real.load()
      const p = await real.checkPending()
      const label = JSON.stringify(fates)
      assert.equal(Boolean(p), listed, `${label}：?pending=1 列得出來 ⇔ 面板提示得出來`)
      const release = await s.raw(`/cleanup/plans/${planId}/release`, { method: 'POST', body: '{}' }).then(() => 200, e => e.status)
      if (!p) { hits.notListed++; continue }
      assert.equal(p.id, planId, label)
      const count = (...f) => fates.filter(x => f.includes(x)).length
      assert.equal(p.moved, count('moved'), `${label}：已經在隔離區的只算 moved`)
      assert.equal(p.unsure, count('unknown', 'inPlace'), `${label}：說不準的`)
      const text = pendingPlanMessage(p)
      assert.equal(text.includes('放棄上次那份'), !p.started, `${label}：${text}`)
      if (!p.started) {
        hits.offered++
        assert.equal(release, 200, `${label}：面板給了「放棄」，後端卻回 ${release}`)
      } else {
        hits.withheld++
        if (release === 200) {
          hits.conservative++
          assert.ok(fates.every(f => f === 'pending' || f === 'skipNoJournal') && fates.includes('skipNoJournal'),
            `${label}：面板不給放棄、後端卻放棄得了，只該發生在「只有略過、還沒有任何搬移紀錄」`)
        }
      }
      if (p.moved) hits.moved++
      if (p.unsure) hits.unsure++
    }
    // 生成器驗收：每一條路都要真的走到
    for (const [k, n] of Object.entries(hits)) assert.ok(n > 0, `生成器沒有走到 ${k}：${JSON.stringify(hits)}`)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 2026-09-19 稽核第三輪・面板（R3-12b 掃描問題、noop／stoppedEarly 的呈現）
//
// 期望值在實作之前寫死（build-round Step 1）。
//
// | 段落 | 可能的錯誤 | 另一種合理解讀 | 能分辨兩者的例子（成對） | 認定的答案 |
// |---|---|---|---|---|
// | R3-12b 從哪裡讀 | 面板自己再掃一次、或讀 /pet/state（頁面根本沒讀它） | 帶 token 的 /health 的 scanProblems | 清理資料夾被刪掉之後重掃／對照：資料夾正常 | 前者：寵物泡泡與面板頂端都講得出問題；後者：泡泡是「今天吃可頌了嗎？」、提示藏著 |
// | R3-12b 泡泡 | 每一輪輪詢都把泡泡蓋掉（剛做完的結果會被洗掉） | 對話框開著就不動它 | 復原完（notice 開著對話框）之後下一輪輪詢／對話框關著 | 前者：泡泡還是「都幫你放回來了！」；後者：泡泡換成警告 |
// | R3-12b 文字 | 帶絕對路徑（後端已經去掉，但面板可能自己補） | 只講資料夾名 | 清理根目錄在 /tmp/xxx 底下 | 三個地方（泡泡、stage title、面板提示）都不可以出現 / 開頭的完整路徑 |
// | R3-12b 示範模式 | 把真的掃描問題混進示範清單 | 示範模式不講 | 按 D 打開示範 | 面板提示藏起來 |
// | noop | 照 moved=0 印成「搬進隔離區 0 個檔案…七天內可以復原」（看起來像剛清完） | 照實說「這次什麼都沒做」 | 後端回 noop: true／對照：真的搬了 0 個但不是 noop | noop：不可以出現「搬進隔離區」「七天內可以復原」「整理好了」；要講「沒有動任何檔案」 |
// | noop 的來源 | 面板自己猜（moved===0 就當 noop） | 只信後端的 noop 欄位 | moved=0、noop 沒給（真的全部失敗） | 照舊講「一個都沒搬成，原因寫在面板上」 |
// | stoppedEarly | 當成做完了 | 講「停在中途，還沒做完」 | 後端回 stoppedEarly: true | 結果框要講「停在中途」與「還沒處理的下次會接著做」 |
// ═══════════════════════════════════════════════════════════════════════

/** 清理根目錄被刪掉 → 重掃一次，後端把「掃描問題」記下來（帶 token 的 /health 才看得到） */
async function withScanProblem(s) {
  rmSync(s.downloads, { recursive: true, force: true })
  await s.raw('/cleanup/scan', { method: 'POST', body: '{}' })
  const h = await s.raw('/health')
  assert.ok(Array.isArray(h.scanProblems) && h.scanProblems.length > 0,
    `前提：/health 回得出掃描問題：${JSON.stringify(h.scanProblems)}`)
  return h.scanProblems
}

/** 畫面上不可以出現絕對路徑（POSIX 的 /a/b、Windows 的 C:\a）。`~/Downloads` 是後端刻意的寫法，放行。 */
const ABSOLUTE = /(^|[\s「」（）:：])[/\\][A-Za-z0-9._-]+[/\\]|[A-Za-z]:[\\/]/

describe('R3-12b 掃描問題要走到寵物與面板（不是只有 doctor 看得到）', () => {
  test('這一段的守門本身抓得到路徑（不是永遠成立的檢查）', () => {
    for (const leak of [
      '⚠ 掃描資料夾 /tmp/cb-ui-audit-x9/Downloads 不存在，這次沒有掃。',
      '⚠ 掃描資料夾「/home/someone/Downloads」不存在。',
      '⚠ 打不開 C:\\Users\\alice\\Downloads\\sub。',
    ]) assert.ok(ABSOLUTE.test(leak), `沒抓到：${leak}`)
    for (const ok of [
      '⚠ 上次掃描回報了 1 個問題，可能有檔案沒有掃到：掃描資料夾「Downloads」不存在，這次沒有掃。',
      '⚠ ~/Downloads/sub 打不開。',              // 後端把家目錄換成 ~ 是刻意的，不算絕對路徑
      '📁 「Downloads」 · 監看中',
    ]) assert.ok(!ABSOLUTE.test(ok), `誤抓：${ok}`)
  })

  test('**稽核 R3-12b：清理資料夾不見了 → 寵物泡泡與面板頂端都講得出來，而且沒有絕對路徑**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const problems = await withScanProblem(s)
    const ui = await mountUi(t, s)
    await until(() => ui.$('quaso-status').textContent.includes(problems[0]), '寵物泡泡講出掃描問題')
    const bubble = ui.$('quaso-status').textContent
    assert.ok(!bubble.includes('今天吃可頌了嗎'), bubble)
    assert.ok(!ABSOLUTE.test(bubble), `泡泡帶了絕對路徑：${bubble}`)
    // stage 的 title（滑鼠移上去、螢幕閱讀器都讀得到）也不可以只說「監看中」
    const title = ui.$('quaso-stage').title
    assert.ok(/掃描/.test(title), `stage title 沒講掃描出問題：${title}`)
    assert.ok(!ABSOLUTE.test(title), title)
    // 面板頂端的提示
    await ui.click('quaso-cleanup-alert')
    const note = ui.$('cleanup-scan-problems')
    assert.equal(note.hidden, false, '面板頂端的掃描提示藏著')
    assert.ok(note.textContent.includes(problems[0]), note.textContent)
    assert.ok(!ABSOLUTE.test(note.textContent), `面板提示帶了絕對路徑：${note.textContent}`)
  })

  test('對照：掃描沒問題 → 泡泡照舊、面板的提示藏著', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    s.heartbeat()
    const ui = await mountUi(t, s)
    await until(() => ui.$('quaso-stage').title.includes('監看中'), '拿到 /health')
    assert.equal(ui.$('quaso-status').textContent, '今天吃可頌了嗎？')
    await ui.click('quaso-cleanup-alert')
    assert.equal(ui.$('cleanup-scan-problems').hidden, true)
    assert.equal(ui.$('cleanup-scan-problems').textContent, '')
  })

  test('**對話框正開著（剛做完一個動作）的時候不可以把泡泡蓋掉**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    const ui = await mountUi(t, s)
    await ui.click('quaso-cleanup-alert')
    await uiOnly(ui, 'a.zip')
    await ui.click('cleanup-apply')
    assert.equal(ui.$('quaso-dialog').hidden, false, '前提：做完動作之後對話框是開著的')
    const said = ui.$('quaso-status').textContent
    assert.match(said, /整理好了/)
    // 現在才出現掃描問題（下一輪輪詢會讀到）
    await withScanProblem(s)
    await ui.click('quaso-connection-retry')      // 立刻再輪詢一次
    assert.equal(ui.$('quaso-status').textContent, said, '對話框開著的時候不可以蓋掉剛剛的結果')
  })

  test('示範模式不把真的掃描問題混進來', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 } })
    await withScanProblem(s)
    const ui = await mountUi(t, s)
    await until(() => ui.$('cleanup-scan-problems').hidden === false, '本機模式先看得到')
    await ui.key('d')
    await ui.click('quaso-cleanup-alert')
    assert.equal(ui.$('cleanup-panel').dataset.mode, 'demo', '前提：示範模式')
    assert.equal(ui.$('cleanup-scan-problems').hidden, true, '示範清單旁邊不該掛真的掃描問題')
  })
})

describe('R3-12b／noop：「這次什麼都沒做」不可以顯示成剛清完', () => {
  test('**applyMessage：後端說 noop → 不講「搬進隔離區」「七天內可以復原」「整理好了」**', () => {
    const m = applyMessage({
      status: 'applied', planId: 'p1', moved: 0, bytesFreed: 0, failed: [], unknown: [], noop: true,
    })
    assert.ok(!/搬進隔離區/.test(m.text), m.text)
    assert.ok(!/七天內可以復原/.test(m.text), m.text)
    assert.ok(!/整理好了/.test(m.notice), m.notice)
    assert.match(m.text, /沒有動任何檔案|什麼都沒做/)
  })

  test('對照：沒有 noop、真的搬了 0 個（全部失敗）→ 照舊講原因', () => {
    const m = applyMessage({
      status: 'partial', planId: 'p1', moved: 0, bytesFreed: 0,
      failed: [{ itemId: '1', name: 'a.zip', why: '檔案不見了' }], unknown: [],
    })
    assert.match(m.text, /搬進隔離區 0 個檔案/)
    assert.match(m.text, /原檔都還在原位/)
    assert.match(m.notice, /一個都沒搬成/)
  })

  test('applyOutcome 要把 noop／stoppedEarly 從後端的回應帶上來（面板才講得出來）', () => {
    const plan = {
      id: 'p1', status: 'applied', items: [], quarantinedCount: 0, quarantinedBytes: 0, undoable: false,
      noop: true, stoppedEarly: false,
    }
    assert.equal(applyOutcome(plan).noop, true)
    assert.equal(applyOutcome(plan).stoppedEarly, false)
    // 後端還沒加這兩個欄位的時候，一律當成 false（不可以變成 undefined 而被 ?? 當成別的意思）
    assert.equal(applyOutcome({ ...plan, noop: undefined, stoppedEarly: undefined }).noop, false)
    assert.equal(applyOutcome({ ...plan, noop: undefined, stoppedEarly: undefined }).stoppedEarly, false)
    assert.equal(applyOutcome({ ...plan, noop: 'true' }).noop, false, '只認布林 true')
  })

  test('applyMessage：stoppedEarly → 要講「停在中途、還沒做完」', () => {
    const m = applyMessage({
      status: 'proposed', planId: 'p1', moved: 3, bytesFreed: 1024, failed: [], unknown: [], stoppedEarly: true,
    })
    assert.match(m.text, /搬進隔離區 3 個檔案/, '已經做到的照實講')
    assert.match(m.text, /停在中途|還沒做完/, m.text)
    assert.ok(!/整理好了/.test(m.notice), m.notice)
  })

  test('**面板：按「繼續上次那份」而後端其實什麼都沒做 → 畫面不可以像剛清完**', async t => {
    const s = await serve(t, { 'a.zip': { days: 60 }, 'b.zip': { days: 60 } })
    // 一份 proposed 的計畫擋著（面板一打開就會提示它）
    const plan = await s.raw('/cleanup/plans', {
      method: 'POST', body: JSON.stringify({ candidateIds: await s.idsOf('a.zip'), requestId: 'noop-1' }),
    })
    // 後端把它當成「跑完過的計畫再 apply」：原樣回傳、一個檔都不動（exec 組加的 noop）
    s.setHook((path, method) => (method === 'POST' && path.endsWith('/apply')
      ? { status: 200, body: { ...plan, status: 'applied', quarantinedCount: 0, quarantinedBytes: 0, undoable: false, noop: true,
          items: plan.items.map(i => ({ ...i, outcome: 'cancelled', why: null })) } }
      : null))
    const ui = await mountUi(t, s)
    await ui.click('quaso-cleanup-alert')
    assert.match(ui.$('cleanup-apply').textContent, /繼續上次那份/, '前提：面板提示了上次那份')
    await ui.click('cleanup-apply')
    const text = ui.$('cleanup-result').textContent
    assert.ok(!/搬進隔離區/.test(text), `什麼都沒做卻說搬了：${text}`)
    assert.ok(!/七天內可以復原/.test(text), text)
    assert.match(text, /沒有動任何檔案|什麼都沒做/)
    assert.ok(!/整理好了/.test(ui.$('quaso-status').textContent), ui.$('quaso-status').textContent)
    assert.ok(s.has('a.zip'), '前提：檔案真的沒動')
  })
})

test('**跑完不可以在家目錄留下任何東西**', () => {
  assert.ok(!existsSync(join(FAKE_HOME, '.contextbox')), '家目錄出現了 .contextbox')
})
