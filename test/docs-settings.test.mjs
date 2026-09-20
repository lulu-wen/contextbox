import './helpers/isolate-home.mjs'   // 一定要第一個 import：下面 import 的 core 模組會在載入時算設定檔路徑
/**
 * 設定那條線的**文件**守門（稽核 2026-09-20）。
 *
 * ddda4ea 把「面板裡就能改設定」整條線做完了，但文件只多了三列表格：錯誤表兩列、
 * 「各路徑收的 body」一列。`PATCH /settings` 送什麼、回什麼、被拒絕時長什麼樣、
 * 金鑰會不會被回出來 —— 一句都沒有。擴充套件與 curl 沒有東西可以照著寫。
 * 面向使用者的那兩份（docs/panel.md、docs/UserGuide.md）更是連「有一個設定分頁」都沒提到。
 *
 * 這一支的每一條都**跟實作對帳**，不是手抄一份清單：
 *   - 回應的欄位從 `docs/api/*.json` 來，而那幾份是 tools/gen-api-examples.mjs
 *     從真的 server 寫下來的（RC20）。實作改了形狀 → 重產 → 這裡就紅
 *   - 白名單五欄從 core/settings.ts 的 `EDITABLE` 列舉
 *   - 「立即生效／要重開」從 core/live-config.ts 的兩份名單列舉
 *   - 分頁名稱從 core/assets/cleanup-demo.js 的 `PANEL_SECTIONS` 列舉
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sectionOf, undocumentedFields } from './helpers/markdown.mjs'
import { EDITABLE } from '../core/settings.ts'
import { LIVE_SETTINGS, RESTART_SETTINGS } from '../core/live-config.ts'
import { STALE_THINK_MS } from '../core/cleanup-routes.ts'
import { SETTING_LABELS } from '../core/assets/cleanup-real-state.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => readFileSync(join(REPO, ...p), 'utf8')
const json = (...p) => JSON.parse(read(...p))

const API = read('docs', 'api', 'README.md')
const PANEL = read('docs', 'panel.md')
const GUIDE = read('docs', 'UserGuide.md')

// ═══ 1 ・ docs/api/README.md 有 /settings 自己一節 ═══════════════

describe('docs/api/README.md 的 `/settings`', () => {
  const HEAD = '## 設定（P6，兩條都要 token）'
  const settings = () => sectionOf(API, HEAD)
  const get = () => sectionOf(API, '### `GET /settings`')
  const patch = () => sectionOf(API, '### `PATCH /settings`')

  test('這條路徑有自己一節，不是只出現在三列表格裡', () => {
    assert.ok(settings().length > 500, `README 裡找不到「${HEAD}」那一節`)
    assert.ok(get().length > 200, '找不到 GET /settings 那一段')
    assert.ok(patch().length > 200, '找不到 PATCH /settings 那一段')
  })

  test('**GET 回的每一個欄位都講到了** —— 欄位取自產生器寫的那一份，不是手抄的', () => {
    // docs/api/settings.json 是 tools/gen-api-examples.mjs 從真的 server 寫下來的（RC20）。
    // 實作多回一個欄位而文件沒跟上，這裡就紅。
    const body = json('docs', 'api', 'settings.json')
    assert.ok(body.editable && body.shown, '前提：範例是 GET /settings 的回應')
    assert.deepEqual(undocumentedFields(get(), body), [], 'GET /settings 那一段沒講到這些欄位')
  })

  test('**PATCH 回的每一個欄位都講到了**（`saved`／`settings`／`restartNeeded`）', () => {
    const body = json('docs', 'api', 'settings-patch.json')
    assert.equal(body.saved, true, '前提：範例是存成功的那一種')
    // `settings` 底下就是 GET 那一份，逐欄再寫一次只是噪音 —— 這一段自己要講的是頂層三欄
    const top = Object.keys(body)
    assert.deepEqual(top.filter(k => !patch().includes('`' + k + '`')), [],
      'PATCH /settings 那一段沒講到這幾個頂層欄位')
    assert.match(patch(), /`settings`[^\n]*GET/, '`settings` 要講明它就是 GET 回的那一份')
  })

  test('**改得動的欄位逐字列出，而且就是 applyPatch 認的那五條**', () => {
    const sec = settings()
    const missing = EDITABLE.filter(f => !sec.includes('`' + f + '`'))
    assert.deepEqual(missing, [], '設定那一節沒有列出這幾個可改的欄位')
    // 反過來也要守：文件不可以承諾一個 applyPatch 不收的欄位
    for (const f of ['watch', 'filed', 'cleanup.roots', 'pdfPages', 'maxBytes']) {
      assert.ok(!new RegExp('改得動[^\\n]*`' + f.replace('.', '\\.') + '`').test(sec),
        `${f} 存不進去（不在 EDITABLE 裡），文件不可以說改得動`)
    }
  })

  test('**每一種回應都寫了**：狀態碼取自 errors.json 裡真的打過的那幾筆', () => {
    // errors.json 也是產生器寫的：`request` 是 `GET /settings`／`PATCH /settings` 的那幾筆，
    // 就是這條路徑真的回得出來的全部狀態。手寫一份清單遲早跟實作分家。
    const errors = json('docs', 'api', 'errors.json')
    const mine = Object.values(errors).filter(e => / \/settings$/.test(e.request ?? ''))
    assert.ok(mine.length >= 5, `前提：errors.json 裡有 /settings 的例子，現在只有 ${mine.length} 筆`)
    const sec = settings()
    for (const e of mine) {
      assert.ok(sec.includes(String(e.status)), `設定那一節沒有講 ${e.status}`)
      if (e.body?.code) assert.ok(sec.includes('`' + e.body.code + '`'), `設定那一節沒有講 ${e.body.code}`)
    }
    assert.ok(mine.some(e => e.body?.code === 'BAD_SETTING' && e.body.fields),
      '前提：400 的例子要帶 fields')
    assert.match(sec, /`fields`/, '400 的 `fields` 是呼叫端唯一知道哪一格錯了的東西')
  })

  test('**兩條都要 token，session cookie 開不了** —— 這是寫入路徑，不為它破例', () => {
    const sec = settings()
    assert.match(sec, /401/)
    assert.ok(/cookie/i.test(sec), '要寫明 session cookie 不算數（core/server.ts 的鎖 2 之後才輪到這條）')
  })

  test('**金鑰不出這條 HTTP**：文件要講，範例也要真的沒有', () => {
    const sec = settings()
    assert.match(sec, /`keySet`/, '要講 keySet')
    assert.ok(/不回|永遠不|never/.test(sec), '要寫明金鑰本身不會被回出來')
    // 產生器是設了一個假金鑰進環境變數才讓 keySet 穩定是 true 的（見那支檔）。
    // 那個值一旦出現在任何一份範例裡，就代表這條路把環境變數的內容回出來了。
    const FAKE = 'example-key-not-a-real-one'
    for (const f of ['settings.json', 'settings-patch.json', 'errors.json']) {
      assert.ok(!read('docs', 'api', f).includes(FAKE), `${f} 裡出現了環境變數的內容`)
    }
    // 使用者把金鑰本人貼進 keyEnv 那一格時，拒絕的句子裡也不可以有它
    const pasted = Object.values(json('docs', 'api', 'errors.json'))
      .find(e => e.body?.fields?.['model.keyEnv'])
    assert.ok(pasted, '前提：errors.json 有一筆 keyEnv 被拒絕的例子')
    assert.ok(!JSON.stringify(pasted).includes('paste-of-something-that-should-never-go-here'),
      '拒絕的句子回放了使用者貼的值')
  })

  test('檔案清單那張表有這兩份範例', () => {
    const list = sectionOf(API, '## 檔案清單')
    for (const f of ['settings.json', 'settings-patch.json']) {
      assert.ok(list.includes('`' + f + '`'), `檔案清單少了 ${f}`)
    }
  })
})

// ═══ 2 ・ 使用者早就要過、但還是缺的那三處 ═══════════════════════

describe('docs/api/README.md：連拍組的 `model`、`reading` 的兩個數字、預覽', () => {
  test('`GET /cleanup/bursts`：`keep` 與 `members[]` 都帶 `model`，文件要講', () => {
    // 欄位從 core/cleanup-routes.ts 的兩個 view 型別列舉 —— 手抄一份會腐爛。
    const src = read('core', 'cleanup-routes.ts')
    const member = /export type BurstMemberView = \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? ''
    const group = /export type BurstGroupView = \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? ''
    assert.ok(member && group, '前提：兩個 view 型別還在')
    assert.ok(/^\s*model:/m.test(member) && /model: ModelOpinion/.test(group),
      '前提：members[] 與 keep 都有 model')
    const sec = sectionOf(API, '## `GET /cleanup/bursts`')
    assert.ok(sec.length > 200, '找不到連拍組那一節')
    assert.match(sec, /`model`/, '連拍組那一節沒有講 model —— 面板每一張縮圖旁邊就印著它')
    assert.ok(/意見/.test(sec), '跟候選清單那一節一樣，要寫明那是意見不是事實')
  })

  test('`GET /pet/state` 的 `reading`：15 分鐘與 500 要跟程式裡的常數對得上', () => {
    const sec = sectionOf(API, '## `GET /pet/state`')
    assert.ok(sec.length > 200, '找不到 /pet/state 那一節')
    for (const k of ['running', 'pending']) assert.match(sec, new RegExp('`' + k + '`'))
    assert.equal(STALE_THINK_MS, 15 * 60_000, '前提：心跳多久算過期')
    assert.match(sec, /15 分鐘/, 'reading.running 的「夠新」是 15 分鐘，文件要寫出來')
    // pendingCount 的上限是預設參數，只能從原始碼讀
    const cap = /export function pendingCount\([^)]*cap = (\d+)/.exec(read('core', 'model-queue.ts'))?.[1]
    assert.equal(cap, '500', '前提：待讀數的上限')
    assert.match(sec, new RegExp('上限 ' + cap), 'reading.pending 的上限，文件要寫出來')
  })

  test('`GET /cleanup/preview/:itemId` 講到回應的每一個欄位（對照實作的型別）', () => {
    // 這一條 test/preview-wire.test.mjs 已經用真的回應比過一次了。這裡從**型別**再比一次：
    // 那一支要先跑一輪掃描才拿得到回應，型別改了而掃描剛好生不出那個欄位時它不會紅。
    const t = /export type PreviewView = \{([\s\S]*?)\n\}/.exec(read('core', 'cleanup-routes.ts'))?.[1] ?? ''
    const fields = [...t.matchAll(/^ {2}(\w+):/gm)].map(m => m[1])
    assert.ok(fields.length >= 8, `前提：PreviewView 有欄位，抓到 ${fields.length} 個`)
    const sec = sectionOf(API, '## `GET /cleanup/preview/:itemId`')
    assert.deepEqual(fields.filter(f => !sec.includes('`' + f + '`')), [],
      '預覽那一節沒講到這些欄位')
  })
})

// ═══ 3 ・ 使用者讀的那兩份文件 ═══════════════════════════════════

/** 面板上真的有哪幾個分頁：從 cleanup-demo.js 的 PANEL_SECTIONS 列舉。 */
function panelSections() {
  const src = read('core', 'assets', 'cleanup-demo.js')
  const block = /const PANEL_SECTIONS = \[([\s\S]*?)\n\]/.exec(src)?.[1] ?? ''
  return [...block.matchAll(/label: '([^']+)'/g)].map(m => m[1])
}

const NUMBER_WORD = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve']

describe('docs/panel.md 與 docs/UserGuide.md 講得出設定分頁', () => {
  test('前提：面板上現在有六個分頁，最後一個是 Settings', () => {
    assert.deepEqual(panelSections(), ['Cleanup', 'Bursts', 'Suggested names', 'Filing', 'Learned', 'Settings'])
  })

  for (const [name, md] of [['docs/panel.md', () => PANEL], ['docs/UserGuide.md', () => GUIDE]]) {
    test(`${name} 的分頁清單跟 PANEL_SECTIONS 一樣，數量也講對`, () => {
      const tabs = panelSections()
      const doc = md()
      for (const label of tabs) {
        assert.ok(doc.includes(label), `${name} 沒有提到「${label}」這個分頁`)
      }
      // 「五個分頁」這種寫死的數字最容易過期 —— 多一個分頁就要紅
      const stale = NUMBER_WORD.filter((w, i) => w && i !== tabs.length)
        .filter(w => new RegExp(w + ' section tabs', 'i').test(doc))
      assert.deepEqual(stale, [], `${name} 還在說有 ${stale.join('／')} 個分頁，實際有 ${tabs.length} 個`)
      assert.match(doc, new RegExp(NUMBER_WORD[tabs.length] + ' section tabs', 'i'),
        `${name} 要講現在有幾個分頁`)
    })
  }

  test('**UserGuide 有設定分頁自己一段**，五欄逐欄講，而且講對生不生效', () => {
    const sec = sectionOf(GUIDE, '#### The Settings tab')
    assert.ok(sec.length > 400, 'UserGuide 沒有 Settings 那一段')
    // 欄位用**畫面上的說法**列（面板自己那份標籤），不是設定檔的鍵名 ——
    // 使用者看到的是輸入框旁邊那行字，不是 JSON 的 key
    for (const f of EDITABLE) {
      assert.ok(sec.toLowerCase().includes(SETTING_LABELS[f].toLowerCase()),
        `Settings 那一段沒有講「${SETTING_LABELS[f]}」這一欄`)
    }
    // 逐欄講實話：立即生效的與要重開的，兩邊都要出現，而且不可以互換
    const takesEffect = sec.slice(sec.search(/takes effect|in effect/i))
    assert.ok(takesEffect.length > 100, 'Settings 那一段沒有講什麼時候生效')
    for (const f of LIVE_SETTINGS) assert.ok(sec.includes(SETTING_LABELS[f]) || sec.toLowerCase().includes(SETTING_LABELS[f].toLowerCase()), f)
    assert.ok(RESTART_SETTINGS.length === 1, '前提：只有一欄要重開')
    const restartLabel = SETTING_LABELS[RESTART_SETTINGS[0]]
    assert.ok(new RegExp(restartLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]{0,240}?restart', 'i').test(sec)
      || new RegExp('restart[\\s\\S]{0,240}?' + restartLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(sec),
      `Settings 那一段要講明「${restartLabel}」是唯一一欄要重開寵物才算數的`)
  })

  test('**金鑰那一格要的是環境變數的「名字」** —— 這句話一定要在，而且講得很直白', () => {
    const sec = sectionOf(GUIDE, '#### The Settings tab')
    assert.match(sec, /\bname\b/i, '要講「名字」')
    assert.match(sec, /never/i, '要講「絕對不要把金鑰打進去」')
    assert.match(sec, /CONTEXTBOX_MODEL_KEY/, '要給一個真的名字當例子')
    // 這一段本身不可以看起來像在教人把金鑰貼進設定檔
    assert.ok(!/paste (your |the )?key into/i.test(sec.replace(/never [^.]*paste[^.]*\./gi, '')),
      '別把「貼金鑰」寫成一個做法')
  })

  test('引用的截圖照既有慣例：docs/images/README.md 那張清單裡要有它', () => {
    // 九張圖都還沒拍，慣例是「UserGuide 先引用，docs/images/README.md 記下怎麼拍」。
    // 新的一節不可以自己發明別的做法，也不可以引用一個清單上沒有的檔名。
    const list = read('docs', 'images', 'README.md')
    const used = [...GUIDE.matchAll(/!\[[^\]]*\]\(images\/([^)]+)\)/g)].map(m => m[1])
    assert.ok(used.includes('Settings.png'), 'UserGuide 的 Settings 那一段沒有引用截圖')
    for (const f of new Set(used)) {
      assert.ok(list.includes('`' + f + '`'), `docs/images/README.md 的清單裡沒有 ${f}`)
    }
    assert.match(list, new RegExp(NUMBER_WORD[new Set(used).size] + ' images', 'i'),
      `docs/images/README.md 開頭的張數跟實際引用的 ${new Set(used).size} 張對不上`)
  })
})
