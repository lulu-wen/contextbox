/**
 * 把真的 core/assets/cleanup-demo.js 掛到一個照 core/ui.html 建出來的假 DOM 上。
 *
 * 跟 test/audit-0919-ui.test.mjs 裡那一套是同一個做法（那一份是自己寫在檔案裡的）。
 * 這裡抽出來給新的面板測試用：**id 只認 ui.html 裡真的有的**，
 * 面板去 $('沒有的 id') 會在測試裡直接炸掉，不會靜靜地不動。
 *
 * 這支檔**不碰 server**，只要一個 window.api（與 demo 用的 fetch）就能跑。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const UI_HTML = readFileSync(join(REPO, 'core/ui.html'), 'utf8')

/** ui.html 裡真的那一支 window.api（連 token header、blob 那條分支都是真的）。 */
export function uiApi(fetchImpl, token, doc = { documentElement: { dataset: {} } }) {
  const src = /async function api\([\s\S]*?\n\}/.exec(UI_HTML)?.[0]
  assert.ok(src, '找不到 ui.html 裡的 api()')
  return new Function('document', 'HEAD', 'fetch', src + '\nreturn api')(
    doc, { 'content-type': 'application/json', 'x-contextbox-token': token }, fetchImpl)
}

/** ui.html 裡每一個 id：標籤、預設 hidden、預設文字。 */
export const HTML_IDS = new Map()
for (const m of UI_HTML.matchAll(/<(\w+)\b([^>]*?)\sid="([^"]+)"([^>]*)>([^<]*)/g)) {
  HTML_IDS.set(m[3], { tag: m[1], hidden: /\shidden\b/.test(m[2] + ' ' + m[4]), text: m[5].trim() })
}

export class FakeEl {
  constructor(tag, id = '') {
    this.tagName = tag.toUpperCase(); this.id = id
    this._text = ''; this.children = []; this.parent = null
    this.hidden = false; this.disabled = false; this.checked = false; this.type = ''
    this.title = ''; this.className = ''; this.dataset = {}; this.attrs = {}; this.listeners = {}
    this.open = false; this.offsetWidth = 0; this.onclick = null; this.onchange = null; this.isContentEditable = false
    // 輸入框（設定那一區）。**value 一定要預設成空字串**：undefined 的話，
    // 「400 之後使用者打的字還在不在」這種測試會連真的壞掉都看不出來（兩邊都是 undefined）。
    this.value = ''; this.placeholder = ''; this.oninput = null; this.htmlFor = ''
    // **classList 與 className 是同一份東西**（2026-09-21）。以前 classList 自己藏一個 Set，
    // 兩邊不通：程式用 classList.add 加的 class，byClass()／className 一輩子看不到 ——
    // 於是畫面真的壞了（連拍格子裡的預覽滿出去），測試照樣全綠。真瀏覽器不是這樣。
    const list = () => String(this.className).split(/\s+/).filter(Boolean)
    const write = arr => { this.className = [...new Set(arr)].join(' ') }
    this.classList = {
      add: c => write([...list(), c]),
      remove: c => write(list().filter(x => x !== c)),
      contains: c => list().includes(c),
      toggle: (c, on) => ((on ?? !list().includes(c)) ? write([...list(), c]) : write(list().filter(x => x !== c))),
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
  // **真的記下誰有焦點**（2026-09-20）：以前這裡是空的，於是「背景輪詢把使用者正在打字的
  // 輸入框整個換掉」這種錯，測試裡看起來跟沒事一樣 —— 文字是從 edited 重畫出來的，
  // 掉的只有焦點與游標，而假 DOM 根本沒有焦點這回事。
  focus() { if (globalThis.document) globalThis.document.activeElement = this }
  closest() { return null }
  contains(x) { for (let n = x; n; n = n.parent) if (n === this) return true; return false }
  /** 底下所有這個標籤的元素（照畫面順序） */
  all(tag) {
    const out = []
    const walk = n => { for (const c of n.children) { if (c.tagName === tag.toUpperCase()) out.push(c); walk(c) } }
    walk(this)
    return out
  }
  /** 底下所有帶這個 class 的元素（照畫面順序） */
  byClass(name) {
    const out = []
    const walk = n => { for (const c of n.children) { if (String(c.className).split(/\s+/).includes(name)) out.push(c); walk(c) } }
    walk(this)
    return out
  }
}

/**
 * 在一個輸入框裡打字。先換 value 再叫 oninput —— 瀏覽器就是這個順序，
 * 面板的 oninput 讀的也是 `input.value`（不是事件裡的東西）。
 */
export function typeInto(input, text) {
  input.value = String(text)
  input.oninput?.({ target: input })
}

/** 勾／取消勾一個勾選框。 */
export function toggle(input, on) {
  input.checked = Boolean(on)
  input.onchange?.({ target: input })
}

let mounted = 0

/**
 * 掛一次面板。
 * - `api`：window.api（沒給就用 ui.html 那一支，配 `fetch` 與 `token`）
 * - `fetch`：頁面的 fetch（demo 讀 /assets/demo-candidates.json 用它）
 * - `base`：假的 location.href 前綴
 *
 * 回傳 { $, click, key, idle, els }。**一個測試檔裡可以掛很多次**（每次都重新 import 一份模組），
 * 但它們共用 globalThis.document —— 掛了新的，舊的那一份就別再碰了。
 */
export async function mountPanel(t, { api = null, fetch: fetchImpl = null, token = 'panel-token', base = 'http://127.0.0.1:1' } = {}) {
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
    // 瀏覽器裡沒人有焦點的時候這裡是 body，不是 null —— 照抄，不然 `box.contains(activeElement)`
    // 在測試裡走的是跟真的頁面不一樣的那一條分支
    activeElement: null,   // 掛好之後填成 body
    getElementById: id => els.get(id) ?? null,
    createElement: tag => new FakeEl(tag),
    createTextNode: text => Object.assign(new FakeEl('#text'), { _text: String(text) }),
    addEventListener: (type, fn) => (docListeners[type] ??= []).push(fn),
    // pet-state.js 會發 quaso:statechange／quaso:messagechange
    dispatchEvent: event => {
      for (const fn of docListeners[event.type] ?? []) fn(event)
      return true
    },
  }
  const winListeners = {}
  const pageFetch = fetchImpl ?? (() => { throw new TypeError('Failed to fetch') })
  const pageApi = api ?? uiApi(pageFetch, token, doc)
  const calls = []
  const win = {
    api: (path, init) => { calls.push({ path, method: init?.method ?? 'GET', init }); return pageApi(path, init) },
    addEventListener: (type, fn) => (winListeners[type] ??= []).push(fn),
  }
  doc.activeElement = doc.body
  Object.assign(globalThis, {
    document: doc, window: win, Element: FakeEl,
    location: { href: base + '/', search: '' },
    history: { state: null, replaceState() {} },
    fetch: (url, init) => pageFetch(url, init),
  })
  // 每一次掛載都要一份自己的 pet-state（模組層有狀態），面板那一份也要指到同一個實例。
  // 順便把 pollHealth 匯出來：以前測試是點「重試連線」逼一次輪詢，那顆按鈕已經沒有了。
  const caseId = ++mounted
  const stateUrl = new URL(`../../core/assets/pet-state.js?panel=${caseId}`, import.meta.url).href
  const source = readFileSync(join(REPO, 'core/assets/cleanup-demo.js'), 'utf8')
    .replace(/from '(\.\/[^']+)'/g, (_, path) =>
      `from '${path === './pet-state.js' ? stateUrl : new URL('../../core/assets/' + path.slice(2), import.meta.url).href}'`)
  const { pollHealth } = await import('data:text/javascript;base64,'
    + Buffer.from(source + `\nexport { pollHealth };\n// panel=${caseId}`).toString('base64'))
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
  return { $, click, key, idle, poll: async () => { await pollHealth(); await idle() }, els, calls, doc }
}
