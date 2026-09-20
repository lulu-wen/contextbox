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
  course: '作業系統', topic: '死結', confidence: '高', evidence: '四個必要條件', seeded: false,
  learned: false, rejectedBefore: false, ...over,
})
const filingItem = (over = {}) => ({
  itemId: 'f-1', name: 'IMG_2041.txt', course: '資料結構', modelCourse: '資料結構', kind: '考試',
  topic: '期中考範圍', confidence: '高', evidence: '第一部分', seeded: false,
  toFolder: '課程/資料結構/考試', learned: false, rejectedBefore: false, alsoKnownAs: '', ...over,
})

function fakeApi({ candidates = [], renames = [], filings = [], learned = [], calls = [] } = {}) {
  return async (path, init = {}) => {
    calls.push({ path, method: init?.method ?? 'GET' })
    if (path === '/health') {
      return {
        ok: true, version: 'test', pendingCandidates: candidates.length, needsHumanCount: 0,
        watcher: { ok: true, watching: ['Downloads'], watchingCount: 1, rootsMissing: 0, why: null },
        scanProblems: [],
      }
    }
    if (path === '/pet/state') return { state: 'idle', message: '沒事', burst: { groups: 0, newGroups: 0 } }
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

const tabs = ui => ui.$('cleanup-tabs').all('BUTTON')
const tabNamed = (ui, text) => tabs(ui).find(b => b.textContent.startsWith(text))
const shown = (ui, key) => ui.$('cleanup-sec-' + key).hidden === false

describe('面板裡的小標籤', () => {
  test('五個標籤都在，各自帶數量；預設停在「可以清理」', async t => {
    const ui = await open(t, {
      candidates: [candidate()], renames: [renameItem()], filings: [filingItem()],
    })
    assert.deepEqual(tabs(ui).map(b => b.textContent),
      ['可以清理1', '連拍0', '建議的名字1', '歸檔1', '它學到的0'])
    assert.equal(tabNamed(ui, '可以清理').getAttribute('aria-selected'), 'true')
    assert.equal(shown(ui, 'clean'), true)
    assert.equal(shown(ui, 'filings'), false, '一次只顯示一區')
  })

  test('點「歸檔」→ 只顯示歸檔那一區，而且只看得到歸檔的按鈕', async t => {
    const ui = await open(t, {
      candidates: [candidate()], renames: [renameItem()], filings: [filingItem()],
    })
    await tabNamed(ui, '歸檔').onclick()
    assert.equal(shown(ui, 'filings'), true)
    assert.equal(shown(ui, 'clean'), false)
    assert.equal(shown(ui, 'renames'), false)
    assert.equal(ui.$('cleanup-file').hidden, false, '「整理」要在')
    assert.equal(ui.$('cleanup-apply').hidden, true, '清理那幾顆不屬於這一區')
    assert.equal(ui.$('cleanup-rename').hidden, true, '改名那幾顆也不屬於這一區')
  })

  test('空的那一區：標籤看得到但點不下去（不是整個消失）', async t => {
    const ui = await open(t, { candidates: [candidate()] })
    const burst = tabNamed(ui, '連拍')
    assert.ok(burst, '沒有連拍的時候標籤還是要在 —— 使用者要知道有這個功能')
    assert.equal(burst.disabled, true)
    assert.equal(tabNamed(ui, '可以清理').disabled, false)
  })

  test('現在這一區變空了 → 跳到第一個有東西的', async t => {
    const ui = await open(t, { candidates: [], renames: [renameItem()] })
    // 沒有候選：不會停在空的「可以清理」
    assert.equal(tabNamed(ui, '建議的名字').getAttribute('aria-selected'), 'true')
    assert.equal(shown(ui, 'renames'), true)
  })

  test('全部都空 → 留在「可以清理」，那一區會講「目前沒有待清檔案」', async t => {
    const ui = await open(t, {})
    assert.equal(tabNamed(ui, '可以清理').getAttribute('aria-selected'), 'true')
    assert.equal(shown(ui, 'clean'), true)
    assert.match(ui.$('cleanup-list').textContent, /目前沒有待清檔案/)
  })

  test('示範模式（按 D）整條標籤不顯示，每一區照舊', async t => {
    const ui = await open(t, { candidates: [candidate()] })
    await ui.key('d')
    await ui.click('quaso-cleanup-alert')
    assert.equal(ui.$('cleanup-tabs').hidden, true, '示範模式只有清理那一區是真的')
    assert.equal(ui.$('cleanup-sec-clean').hidden, false)
  })
})
