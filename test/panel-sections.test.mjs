import './helpers/isolate-home.mjs'   // 一定要第一個 import
/**
 * 面板裡的小標籤（P6 之二）。
 *
 * 使用者在 Windows 上打開面板之後講的：「歸檔建議要滑到好下面才看得到」。
 * 五區疊在同一條捲軸上，一次只看得到一區的話就不用滑。
 *
 * 守的性質：
 *   · 預設在「可以清理」；一次只顯示一區
 *   · 空的那幾區標籤看得到但點不下去（不是整個消失 —— 使用者要知道有這個功能）
 *   · 動作按鈕跟著區塊走：在歸檔那一區看不到「改名」
 *   · 現在這一區變空了就跳到第一個有東西的
 *   · 示範模式整條標籤不顯示
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountPanel } from './helpers/panel-dom.mjs'
import { formatBytes } from '../core/assets/cleanup-real-state.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
/** 面板開起來會去抓示範清單（按 D 用的），給它真的那一份。 */
const demoFetch = async url => String(url).includes('demo-candidates.json')
  ? new Response(readFileSync(join(REPO, 'core/assets/demo-candidates.json')), { status: 200 })
  : new Response('not found', { status: 404 })

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

const candidate = (over = {}) => ({
  itemId: 'it-1', name: '很久沒動.zip', bytes: 2048, confidence: 80, folder: 'Downloads',
  reasons: [{ reason: '90 天沒有打開過', evidence: 'mtime' }], candidateIds: ['c-1'], ...over,
})
const renameItem = (over = {}) => ({
  itemId: 'r-1', name: '未命名文件 (3).txt', suggested: '作業系統_死結.txt',
  course: '作業系統', topic: '死結', confidence: 'high', evidence: '四個必要條件', seeded: false,
  learned: false, rejectedBefore: false, ...over,
})
const filingItem = (over = {}) => ({
  itemId: 'f-1', name: 'IMG_2041.txt', course: '資料結構', modelCourse: '資料結構', kind: 'Exam',
  topic: '期中考範圍', confidence: 'high', evidence: '第一部分', seeded: false,
  toFolder: 'Courses/資料結構/Exam', learned: false, rejectedBefore: false, alsoKnownAs: '', ...over,
})

function fakeApi(opts = {}) {
  // **每一次請求都重讀 opts**：測試要能在中途換掉後端的回答（背景問完模型那一刻），
  // 解構一次的話那份陣列就定住了。
  const { calls = [] } = opts
  const list = k => opts[k] ?? []
  return async (path, init = {}) => {
    const candidates = list('candidates'), renames = list('renames')
    const filings = list('filings'), learned = list('learned')
    calls.push({ path, method: init?.method ?? 'GET' })
    if (path === '/health') {
      return {
        ok: true, version: 'test', pendingCandidates: candidates.length, needsHumanCount: 0,
        watcher: { ok: true, watching: ['Downloads'], watchingCount: 1, rootsMissing: 0, why: null },
        scanProblems: [],
      }
    }
    if (path === '/pet/state') {
      return opts.petState ?? { state: 'idle', message: 'nothing going on', burst: { groups: 0, newGroups: 0 } }
    }
    if (path.startsWith('/cleanup/candidates')) {
      return { candidates, needsHuman: [], total: candidates.length, needsHumanTotal: 0 }
    }
    if (path.startsWith('/cleanup/plans?')) return { total: 0, offset: 0, limit: 20, operations: [] }
    if (path === '/cleanup/bursts') return { groups: [] }
    if (path.startsWith('/cleanup/thumb/')) return new Blob([PNG], { type: 'image/png' })
    if (path.startsWith('/rename/suggestions')) return { items: renames }
    if (path.startsWith('/file/suggestions')) return { items: filings }
    if (path.startsWith('/learned')) return { items: learned, evicted: { count: 0, at: null } }
    const e = new Error('假後端不認得 ' + path)
    e.status = 404
    throw e
  }
}

async function open(t, opts = {}) {
  const ui = await mountPanel(t, { api: fakeApi(opts), fetch: demoFetch })
  await ui.click('quaso-cleanup-alert')
  return ui
}

async function selectSection(ui, label) {
  const select = ui.$('cleanup-tabs')
  const option = tabNamed(ui, label)
  assert.ok(option && !option.disabled, `Section unavailable: ${label}`)
  select.value = option.value
  await select.onchange()
}
const tabs = ui => ui.$('cleanup-tabs').all('OPTION')
const tabNamed = (ui, text) => tabs(ui).find(b => b.textContent.startsWith(text))
const shown = (ui, key) => ui.$('cleanup-sec-' + key).hidden === false

describe('面板裡的小標籤', () => {
  test('五個清單標籤都在，各自帶數量；「設定」沒有數字；預設停在「可以清理」', async t => {
    const ui = await open(t, {
      candidates: [candidate()], renames: [renameItem()], filings: [filingItem()],
    })
    // 「設定」（2026-09-20）不是一份清單，所以不帶數字 ——「Settings0」看起來像設定被清空了
    assert.deepEqual(tabs(ui).map(b => b.textContent),
      ['Cleanup (1)', 'Bursts (0)', 'Suggested names (1)', 'Filing (1)', 'Learned (0)', 'Settings'])
    assert.equal(ui.$('cleanup-tabs').value, tabNamed(ui, 'Cleanup').value)
    assert.equal(shown(ui, 'clean'), true)
    assert.equal(shown(ui, 'filings'), false, '一次只顯示一區')
  })

  test('點「歸檔」→ 只顯示歸檔那一區，而且只看得到歸檔的按鈕', async t => {
    const ui = await open(t, {
      candidates: [candidate()], renames: [renameItem()], filings: [filingItem()],
    })
    await selectSection(ui, 'Filing')
    assert.equal(shown(ui, 'filings'), true)
    assert.equal(shown(ui, 'clean'), false)
    assert.equal(shown(ui, 'renames'), false)
    assert.equal(ui.$('cleanup-file').hidden, false, '「整理」要在')
    assert.equal(ui.$('cleanup-apply').hidden, true, '清理那幾顆不屬於這一區')
    assert.equal(ui.$('cleanup-rename').hidden, true, '改名那幾顆也不屬於這一區')
  })

  test('空的那一區：標籤看得到但點不下去（不是整個消失）', async t => {
    const ui = await open(t, { candidates: [candidate()] })
    const burst = tabNamed(ui, 'Bursts')
    assert.ok(burst, '沒有Bursts的時候標籤還是要在 — 使用者要知道有這個功能')
    assert.equal(burst.disabled, true)
    assert.equal(tabNamed(ui, 'Cleanup').disabled, false)
  })

  test('現在這一區變空了 → 跳到第一個有東西的', async t => {
    const ui = await open(t, { candidates: [], renames: [renameItem()] })
    // 沒有候選：不會停在空的「可以清理」
    assert.equal(ui.$('cleanup-tabs').value, tabNamed(ui, 'Suggested names').value)
    assert.equal(shown(ui, 'renames'), true)
  })

  test('全部都空 → 留在「可以清理」，那一區會講「目前沒有待清檔案」', async t => {
    const ui = await open(t, {})
    assert.equal(ui.$('cleanup-tabs').value, tabNamed(ui, 'Cleanup').value)
    assert.equal(shown(ui, 'clean'), true)
    assert.match(ui.$('cleanup-list').textContent, /Nothing to clean up right now/)
  })

  test('示範模式（按 D）整條標籤不顯示，每一區照舊', async t => {
    const ui = await open(t, { candidates: [candidate()] })
    await ui.key('d')
    await ui.click('quaso-cleanup-alert')
    assert.equal(ui.$('cleanup-tabs').hidden, true, '示範模式只有清理那一區是真的')
    assert.equal(ui.$('cleanup-sec-clean').hidden, false)
  })
})

// ═══ 面板開著的時候自己跟上（2026-09-20）═══════════════════════

describe('背景問完模型之後，面板自己抓回來', () => {
  test('新的改名建議會自己出現，不用關掉重開', async t => {
    // pet 在背景每十分鐘問一輪模型。面板只在打開的那一刻抓資料的話，
    // 使用者會盯著一個空的「Suggested names」，得關掉重開才看得到。
    const back = { candidates: [candidate()], renames: [] }
    const ui = await mountPanel(t, { api: fakeApi(back), fetch: demoFetch })
    await ui.click('quaso-cleanup-alert')
    assert.equal(tabNamed(ui, 'Suggested names').textContent, 'Suggested names (0)', '前提：一開始沒有建議')

    back.renames = [renameItem()]   // 背景那一輪問完了，後端現在有建議
    await ui.poll()                 // 輪詢跑一次

    assert.equal(tabNamed(ui, 'Suggested names').textContent, 'Suggested names (1)',
      '面板要自己跟上，不可以等使用者關掉重開')
  })

  test('使用者已經勾的不可以被重抓洗掉', async t => {
    const ui = await mountPanel(t, {
      api: fakeApi({ candidates: [candidate()], renames: [renameItem(), renameItem({ itemId: 'r-2' })] }),
      fetch: demoFetch,
    })
    await ui.click('quaso-cleanup-alert')
    await selectSection(ui, 'Suggested names')
    const boxes = ui.$('cleanup-renames').all('INPUT')
    assert.ok(boxes.length >= 1, ui.$('cleanup-renames').textContent)
    boxes[0].checked = true
    boxes[0].onchange()

    await ui.poll()                 // 內容沒變的一次重抓

    const after = ui.$('cleanup-renames').all('INPUT')
    assert.equal(after[0].checked, true, '重抓不可以把使用者勾的洗掉')
  })

  test('面板沒開的時候不要一直打後端', async t => {
    const calls = []
    const ui = await mountPanel(t, {
      api: fakeApi({ candidates: [candidate()], renames: [renameItem()], calls }), fetch: demoFetch,
    })
    calls.length = 0
    await ui.poll()
    assert.deepEqual(calls.filter(c => c.path.startsWith('/rename/suggestions')), [],
      '面板關著就不用抓建議')
  })
})

// ═══ 看得出它有沒有在跑（2026-09-20）═══════════════════════════

describe('「它正在讀檔案」看得見', () => {
  const withReading = (reading, over = {}) => ({
    candidates: [candidate()], petState: { state: 'idle', message: '', burst: { groups: 0, newGroups: 0 }, reading },
    ...over,
  })

  test('正在讀 → 那一行講剩幾個，寵物進 thinking', async t => {
    const ui = await mountPanel(t, {
      api: fakeApi(withReading({ running: true, pending: 128 })), fetch: demoFetch,
    })
    await ui.poll()
    assert.equal(ui.$('files-reading').hidden, false)
    assert.match(ui.$('files-reading').textContent, /Reading your files… 128 still to go/)
    assert.equal(ui.$('quaso').dataset.petState, 'thinking',
      'thinking 以前是死狀態，現在要真的用得到')
  })

  test('沒在讀但還有待讀 → 講「還沒讀」，不要假裝正在跑', async t => {
    const ui = await mountPanel(t, {
      api: fakeApi(withReading({ running: false, pending: 3 })), fetch: demoFetch,
    })
    await ui.poll()
    assert.match(ui.$('files-reading').textContent, /3 files not read yet/)
    assert.notEqual(ui.$('quaso').dataset.petState, 'thinking')
  })

  test('全部讀完 → 那一行整個不顯示', async t => {
    const ui = await mountPanel(t, {
      api: fakeApi(withReading({ running: false, pending: 0 })), fetch: demoFetch,
    })
    await ui.poll()
    assert.equal(ui.$('files-reading').hidden, true)
  })

  test('舊版後端（沒有 reading 這一段）→ 面板照常，那一行不顯示', async t => {
    const ui = await mountPanel(t, {
      api: fakeApi({ candidates: [candidate()], petState: { state: 'idle', burst: { groups: 0, newGroups: 0 } } }),
      fetch: demoFetch,
    })
    await ui.poll()
    assert.equal(ui.$('files-reading').hidden, true)
  })
})

/**
 * 檔案大小（2026-09-21 實機回報）。
 *
 * 少了 byte 這一級，`empty.txt`（0 B）與 `meeting-notes-draft.tmp`（7 B）
 * 在面板上都寫「0.0 KB」：兩個看起來一模一樣，而且 0 B 那個看起來像讀取失敗。
 * CLI（cli.mjs 的 `mb`）本來就照 byte 講 —— 同一個檔兩個地方講的話不可以不一樣。
 */
describe('檔案大小要講得出 1 KB 以下', () => {
  test('1 KB 以下照 byte 講，不寫成 0.0 KB', () => {
    assert.equal(formatBytes(0), '0 B')
    assert.equal(formatBytes(7), '7 B')
    assert.equal(formatBytes(1023), '1023 B')
  })

  test('1 KB 以上照舊', () => {
    assert.equal(formatBytes(1024), '1.0 KB')
    assert.equal(formatBytes(1024 ** 2), '1.0 MB')
    assert.equal(formatBytes(1024 ** 3), '1.00 GB')
  })

  test('負數與壞值不可以印出「-0.0 KB」這種東西', () => {
    assert.equal(formatBytes(-1), '0 B')
  })
})
