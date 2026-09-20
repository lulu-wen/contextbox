/**
 * P6 ・ 把面板分成兩塊（~/contextbox-預想-20260920-P6面板分頁與預覽.md 的 A 那一半）。
 *
 * 使用者的話：「應該把面板分成兩塊，一邊表單一邊檔案管理，使用者才找得到。」
 *
 * | 段落 | 可能的錯 | 另一種解讀 | 成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | 怎麼分 | 兩個真的網址 `/files`／`/facts` | 同一頁兩個分頁 | 使用者按重新整理 | **同一頁兩個分頁**（`#files`／`#facts`）—— 真的換頁要把鑰匙再帶一次 |
 * | 預設哪一塊 | 基本資料（現狀） | 檔案管理 | 第一次打開 | **檔案管理**（主軸是檔案） |
 * | 要不要記 | localStorage | 不記 | 關掉再開 | **記**；讀不到就用預設 |
 * | 切換的代價 | 重新載入、重新要鑰匙 | 什麼都不送 | 點另一塊 | **什麼都不送** |
 *
 * 做法跟 RC16 那一組一樣：把 ui.html 裡真的那幾支函式抽出來跑，
 * 不是另外抄一份 —— 抄的那一份永遠會跟頁面分岔。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const UI_HTML = readFileSync(join(REPO, 'core/ui.html'), 'utf8')

/** ui.html 裡真的那一段分頁程式碼。 */
const TAB_SRC = (() => {
  const src = /const TABS = \[[\s\S]*?\nfunction setupTabs\([\s\S]*?\n\}/.exec(UI_HTML)?.[0]
  assert.ok(src, 'ui.html 裡找不到分頁那一段（TABS … setupTabs）')
  return src
})()
const tabs = () => new Function(
  TAB_SRC + '\nreturn { TABS, TAB_DEFAULT, TAB_KEY, tabFrom, setupTabs, tabStore }')()

// ── 假的 document／location／localStorage ─────────────────────

function fakeDoc() {
  const mk = () => ({
    hidden: false,
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null },
  })
  const els = {
    'pane-files': mk(), 'pane-facts': mk(),
    'tab-files': mk(), 'tab-facts': mk(), 'facts-meta': mk(),
  }
  return { els, body: { dataset: {} }, getElementById: id => els[id] ?? null }
}

/**
 * 假的 location：**只有 hash 摸得到**。
 * 換頁（assign／replace／reload）或去看 href 都會直接炸掉 —— 切分頁碰到任何一個就是做錯了。
 */
function fakeLoc(hash = '') {
  const boom = name => () => { throw new Error('切分頁不可以 ' + name) }
  return {
    hash,
    get href() { throw new Error('切分頁不可以看 href（那是要換頁才需要的）') },
    assign: boom('assign'), replace: boom('replace'), reload: boom('reload'),
  }
}

function fakeStore(initial = {}, { read = true, write = true } = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem(k) {
      if (!read) throw new Error('這個瀏覽器不給讀 localStorage')
      return map.has(k) ? map.get(k) : null
    },
    setItem(k, v) {
      if (!write) throw new Error('這個瀏覽器不給寫 localStorage')
      map.set(k, String(v))
    },
  }
}

const showing = doc => (doc.els['pane-files'].hidden ? '' : 'files') + (doc.els['pane-facts'].hidden ? '' : 'facts')

// ═══ 預期行為 9 ・ 預設與記住 ═════════════════════════════════

describe('P6-9 預設開在檔案管理；上次在哪一塊，下次還在那一塊', () => {
  test('**第一次打開（沒有 # 也沒有記錄）是檔案管理**，不是基本資料', () => {
    const { setupTabs } = tabs()
    const doc = fakeDoc()
    setupTabs(doc, fakeLoc(''), fakeStore())
    assert.equal(showing(doc), 'files')
    assert.equal(doc.els['pane-facts'].hidden, true)
    assert.equal(doc.body.dataset.tab, 'files')
    // 欄位進度條與分區導覽是基本資料那一塊的東西，這時候要收起來
    assert.equal(doc.els['facts-meta'].hidden, true)
  })

  test('**切到基本資料 → 關掉重開（沒有 #）還在基本資料**', () => {
    const { setupTabs } = tabs()
    const store = fakeStore()
    const first = fakeDoc()
    const show = setupTabs(first, fakeLoc(''), store)
    show('facts')
    assert.equal(showing(first), 'facts')
    // 關掉分頁、重新用 `node cli.mjs open` 打開：新的一份 document，網址上沒有 #
    const again = fakeDoc()
    setupTabs(again, fakeLoc(''), store)
    assert.equal(showing(again), 'facts')
  })

  test('記不住（私密視窗、擋 storage）就用預設，而且**不可以炸掉整頁**', () => {
    const { setupTabs } = tabs()
    for (const store of [null, undefined, fakeStore({}, { read: false }), fakeStore({}, { write: false })]) {
      const doc = fakeDoc()
      const show = setupTabs(doc, fakeLoc(''), store)
      assert.equal(showing(doc), 'files')
      show('facts')
      assert.equal(showing(doc), 'facts', '記不住不代表換不了塊')
    }
  })

  test('記到的是垃圾值就當沒有（不可以把兩塊都藏起來）', () => {
    const { setupTabs, TAB_KEY } = tabs()
    for (const junk of ['hello', '', 'FILES', '../files']) {
      const doc = fakeDoc()
      setupTabs(doc, fakeLoc(''), fakeStore({ [TAB_KEY]: junk }))
      assert.equal(showing(doc), 'files', junk)
    }
  })
})

// ═══ 預期行為 10 ・ 切換不重新載入、不重新要鑰匙 ════════════════

describe('P6-10 切分頁不重新載入頁面、不重新要鑰匙', () => {
  test('**切塊的時候一次都沒有碰 location**（碰了假的就會炸）', () => {
    const { setupTabs } = tabs()
    const doc = fakeDoc()
    const show = setupTabs(doc, fakeLoc('#facts'), fakeStore())
    assert.equal(showing(doc), 'facts')
    show('files')
    show('facts')
    show('files')
    assert.equal(showing(doc), 'files')
  })

  test('**分頁連結是 # 不是帶鑰匙的網址**：換網址等於要再帶一次 ?k=', () => {
    const links = [...UI_HTML.matchAll(/<a class="tab" id="tab-(\w+)" href="([^"]+)"/g)]
    assert.deepEqual(links.map(m => [m[1], m[2]]), [['files', '#files'], ['facts', '#facts']])
  })

  test('分頁那一段程式碼裡沒有換頁、沒有請求、沒有鑰匙', () => {
    const code = TAB_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    for (const bad of ['location.replace', 'location.assign', 'location.reload', 'fetch(', 'k=', 'TOKEN']) {
      assert.ok(!code.includes(bad), `分頁那一段用了 ${bad}`)
    }
  })

  test('**網址上的 # 是欄位導覽（#g3）時不換塊**：點分區導覽不可以把人踢回檔案管理', () => {
    const { setupTabs, TAB_KEY } = tabs()
    const doc = fakeDoc()
    setupTabs(doc, fakeLoc('#g3'), fakeStore({ [TAB_KEY]: 'facts' }))
    assert.equal(showing(doc), 'facts')
  })

  test('網址上的 #files／#facts 說了算（勝過記住的那一塊）', () => {
    const { setupTabs, TAB_KEY } = tabs()
    const a = fakeDoc()
    setupTabs(a, fakeLoc('#facts'), fakeStore({ [TAB_KEY]: 'files' }))
    assert.equal(showing(a), 'facts')
    const b = fakeDoc()
    setupTabs(b, fakeLoc('#files'), fakeStore({ [TAB_KEY]: 'facts' }))
    assert.equal(showing(b), 'files')
  })

  test('aria-current：現在這一塊是 page，另一塊不是', () => {
    const { setupTabs } = tabs()
    const doc = fakeDoc()
    const show = setupTabs(doc, fakeLoc(''), fakeStore())
    assert.equal(doc.els['tab-files'].getAttribute('aria-current'), 'page')
    assert.notEqual(doc.els['tab-facts'].getAttribute('aria-current'), 'page')
    show('facts')
    assert.equal(doc.els['tab-facts'].getAttribute('aria-current'), 'page')
    assert.notEqual(doc.els['tab-files'].getAttribute('aria-current'), 'page')
  })

  test('認不得的塊名一律退回預設，不會兩塊都不見', () => {
    const { setupTabs } = tabs()
    const doc = fakeDoc()
    const show = setupTabs(doc, fakeLoc(''), fakeStore())
    show('nope')
    assert.equal(showing(doc), 'files')
  })
})

// ═══ 頁面本身：兩塊都在，既有的東西一個都沒掉 ════════════════

describe('P6 ui.html 的結構', () => {
  const idsOf = html => [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1])

  test('兩塊都在，而且**預設顯示的是檔案管理那一塊**', () => {
    assert.match(UI_HTML, /<section id="pane-files" class="pane">/)
    assert.match(UI_HTML, /<section id="pane-facts" class="pane" hidden>/)
    assert.match(UI_HTML, /<div id="facts-meta" hidden>/)
    assert.ok(UI_HTML.indexOf('id="pane-files"') < UI_HTML.indexOf('id="pane-facts"'), '檔案管理排前面')
  })

  test('**既有的東西一個都不可以掉**：表單、進度、導覽、可頌貓與兩個面板都還在', () => {
    const ids = new Set(idsOf(UI_HTML))
    for (const id of ['ver', 'count', 'bar', 'nav', 'banner', 'groups',
      'quaso', 'quaso-stage', 'quaso-cleanup-alert', 'quaso-history-open',
      'cleanup-panel', 'cleanup-list', 'cleanup-history-panel']) {
      assert.ok(ids.has(id), `ui.html 少了 id="${id}"`)
    }
  })

  test('表單那一塊真的在基本資料那一塊裡面（不是被搬到檔案管理去）', () => {
    const facts = UI_HTML.indexOf('id="pane-facts"')
    const groups = UI_HTML.indexOf('id="groups"')
    const foot = UI_HTML.indexOf('class="foot"')
    assert.ok(facts > 0 && facts < groups && groups < foot, `${facts} / ${groups} / ${foot}`)
  })

  test('id 不可以重複（假 DOM 與 getElementById 都只認得到第一個）', () => {
    const ids = idsOf(UI_HTML)
    const dup = ids.filter((x, i) => ids.indexOf(x) !== i)
    assert.deepEqual([...new Set(dup)], [])
  })

  test('可頌貓與它那兩個小圖示照舊（那是常駐的，不屬於任何一塊）', () => {
    const aside = /<aside id="quaso"[\s\S]*?<\/aside>/.exec(UI_HTML)?.[0] ?? ''
    assert.ok(aside.includes('id="quaso-cleanup-alert"'), '垃圾桶')
    assert.ok(aside.includes('id="quaso-history-open"'), '返回箭頭')
    // 兩個面板是 <dialog>，跟分頁沒有關係 —— 不可以被塞進某一塊裡面
    const paneFiles = UI_HTML.indexOf('id="pane-files"')
    assert.ok(UI_HTML.indexOf('<aside id="quaso"') > UI_HTML.indexOf('</main>'), '可頌貓在 main 外面')
    assert.ok(paneFiles > 0)
  })
})

// ═══ 稽核補的（2026-09-20）═══════════════════════════════════

describe('稽核 ・ 分區導覽的 # 不可以把人踢回檔案管理', () => {
  test('在基本資料那一塊點 #g3 → 留在基本資料（就算記住的是 files）', () => {
    const { setupTabs, TAB_KEY } = tabs()
    const doc = fakeDoc()
    const loc = fakeLoc('')
    // 另一個面板視窗把記住的值覆寫成 files（同一個 origin，這很容易發生）
    const store = fakeStore({ [TAB_KEY]: 'files' })
    const show = setupTabs(doc, loc, store)

    show('facts')
    assert.equal(doc.els['pane-facts'].hidden, false, '前提：現在在基本資料')

    loc.hash = '#g3'          // 左上角的分區導覽
    show.follow()
    assert.equal(doc.els['pane-facts'].hidden, false, '點分區導覽不可以讓整片表單消失')
    assert.equal(doc.els['pane-files'].hidden, true)
  })

  test('讀不到 localStorage（私密視窗）時也一樣留著', () => {
    const { setupTabs } = tabs()
    const doc = fakeDoc()
    const loc = fakeLoc('')
    const show = setupTabs(doc, loc, null)
    show('facts')
    loc.hash = '#g0'
    show.follow()
    assert.equal(doc.els['pane-facts'].hidden, false)
  })

  test('明確指名的 # 照樣換得了塊', () => {
    const { setupTabs } = tabs()
    const doc = fakeDoc()
    const loc = fakeLoc('')
    const show = setupTabs(doc, loc, fakeStore())
    show('facts')
    loc.hash = '#files'
    show.follow()
    assert.equal(doc.els['pane-files'].hidden, false)
    loc.hash = '#facts'
    show.follow()
    assert.equal(doc.els['pane-facts'].hidden, false)
  })
})

describe('稽核 ・ 讓分頁真的會動的那一行要在', () => {
  test('ui.html 有掛 hashchange，而且掛的就是分頁那一支', () => {
    // 這一行刪掉的話功能整個死（分頁是 <a href="#files">，只會改 hash），
    // 但抽程式碼的 regex 剛好停在 setupTabs 結尾，把它排除在外 —— 所以直接比原始碼。
    assert.match(UI_HTML, /addEventListener\('hashchange',\s*showTab\.follow\)/,
      'ui.html 要把 hashchange 接到分頁那一支')
    assert.match(UI_HTML, /const showTab = setupTabs\(document, location, tabStore\(\)\)/)
  })
})
