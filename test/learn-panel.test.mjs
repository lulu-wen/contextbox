import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * P5 ・ 面板的「它學到的事」那一區，以及建議列上的兩個新標記。
 *
 * 期望值抄自 `~/contextbox-預想-20260920-P5學習.md`（介面那一節與預期行為 5、7、11）：
 *
 * | 段落 | 可能的錯 | 另一種解讀 | 成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | 一條怎麼呈現 | 一句話全部塞完 | 三種各講各的 | course／file_kind／rejected | 各一種寫法 |
 * | 退過貨的 | 預設勾起來（它剛列出來） | 不預設勾 | rejectedBefore: true | 不勾，而且畫面講一句 |
 * | 忘掉 | 要二次確認 | 一按就忘 | 按「忘掉」 | DELETE /learned { ids: [那一條] } |
 * | 忘掉之後 | 建議還停在舊寫法 | 重讀建議 | 忘掉課名那一條 | 建議那兩區都重讀 |
 * | 後端沒有這一條 | 整個面板壞掉 | 整區不顯示 | /learned 回 404 | 清理面板照常 |
 * | 示範模式 | 也列 | 不列 | 按 D 開示範 | 整區不顯示 |
 * | 有沒有路徑 | 有 | 沒有 | 任何一條 | 畫面上一個絕對路徑都沒有 |
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountPanel } from './helpers/panel-dom.mjs'
import {
  createLearned, learnedLines, filingLines, renameLines,
} from '../core/assets/cleanup-real-state.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const demoFetch = async url => String(url).includes('demo-candidates.json')
  ? new Response(readFileSync(join(REPO, 'core/assets/demo-candidates.json')), { status: 200 })
  : new Response('not found', { status: 404 })

const learnedItem = (over = {}) => ({ id: 'p-1', kind: 'course', from: '作業系統', to: 'OS', times: 2, at: '2026-09-20T01:00:00.000Z', ...over })
const filing = (over = {}) => ({
  itemId: 'it-1', name: '未命名文件 (3).txt', course: '作業系統', modelCourse: '作業系統', kind: '筆記',
  topic: '死結', confidence: '高', evidence: '四個必要條件', seeded: false,
  toFolder: '課程/作業系統/筆記', learned: false, rejectedBefore: false, alsoKnownAs: '', ...over,
})
const rename = (over = {}) => ({
  itemId: 'it-1', name: '未命名文件 (3).txt', suggested: '作業系統_死結.txt', course: '作業系統',
  topic: '死結', confidence: '高', evidence: '四個必要條件', seeded: false,
  learned: false, rejectedBefore: false, ...over,
})

function fakeApi({ learned = [], evicted = 0, filings = [], renames = [], onDelete = null, calls = [] } = {}) {
  return async (path, init = {}) => {
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null })
    if (path === '/health') {
      return {
        ok: true, version: 'test', pendingCandidates: 0, needsHumanCount: 0,
        watcher: { ok: true, watching: ['Downloads'], watchingCount: 1, rootsMissing: 0, why: null },
        scanProblems: [],
      }
    }
    if (path === '/pet/state') {
      return { state: 'idle', message: '沒事', pendingCount: 0, quarantinedCount: 0, undoable: false }
    }
    if (path.startsWith('/cleanup/candidates')) return { candidates: [], needsHuman: [], total: 0 }
    if (path.startsWith('/cleanup/plans?')) return { total: 0, offset: 0, limit: 1, operations: [] }
    if (path === '/cleanup/bursts') { const e = new Error('還沒做好'); e.status = 501; throw e }
    if (path === '/rename/suggestions') return { items: renames }
    if (path === '/file/suggestions') return { items: filings }
    if (path === '/learned') {
      if (learned === 'missing') { const e = new Error('沒有這個路徑'); e.status = 404; throw e }
      if (init?.method === 'DELETE') return onDelete ? onDelete(JSON.parse(init.body)) : { forgotten: 1 }
      return { items: learned, evicted: { count: evicted, at: evicted ? '2026-09-20T02:00:00.000Z' : null } }
    }
    const e = new Error('假後端不認得 ' + path)
    e.status = 404
    throw e
  }
}

async function open(t, opts) {
  const calls = []
  const ui = await mountPanel(t, { api: fakeApi({ ...opts, calls }), fetch: demoFetch })
  await ui.click('quaso-cleanup-alert')
  return { ...ui, apiCalls: calls }
}

const rows = ui => ui.$('cleanup-learned').all('ARTICLE')

// ═══ 純函式 ═══════════════════════════════════════════════════

describe('learnedLines', () => {
  test('課名：模型說 A ・ 你要 B ・ 用過 N 次', () => {
    const l = learnedLines(learnedItem())
    assert.equal(l.head, '模型說「作業系統」 ・ 你要「OS」')
    assert.equal(l.why, '用過 2 次')
    assert.equal(l.id, 'p-1')
  })

  test('類型：講「這一堂課的」，不是全域的', () => {
    const l = learnedLines(learnedItem({ kind: 'file_kind', from: '作業系統／筆記', to: '講義', times: 1 }))
    assert.equal(l.head, '作業系統／筆記 的東西 ・ 你要「講義」')
    assert.equal(l.why, '用過 1 次')
  })

  test('退過貨：不可以寫成「你要（空白）」', () => {
    // 稽核 2026-09-20 之後「是哪一個建議」走 about（歸檔那一種才有；改名那一種是檔名，後端不回）
    const l = learnedLines(learnedItem({ kind: 'rejected', from: '', to: '', about: '課程/OS/講義' }))
    assert.equal(l.head, '你退過「課程/OS/講義」這個建議')
    assert.match(l.why, /不預設勾/)
  })

  test('退過的是改名建議（後端不回檔名）→ 講得出有這回事，但不編一個名字出來', () => {
    const l = learnedLines(learnedItem({ kind: 'rejected', from: '', to: '', about: '' }))
    assert.equal(l.head, '你退過一個改名建議')
    assert.match(l.why, /不預設勾/)
  })

  test('壞掉的一條不要畫（回 null）', () => {
    assert.equal(learnedLines(null), null)
    assert.equal(learnedLines({}), null)
    assert.equal(learnedLines({ id: 'x', kind: 'course', from: '', to: 'OS' }), null)
  })

  test('**課名是不可信的輸入**：控制字元與方向字元換掉', () => {
    // NUL 與 RLO 用 fromCharCode 組：寫成字面量的話**這支測試檔自己**就帶著真的控制字元，
    // git 會把它當二進位檔（test/repo.test.mjs 的第一條就在守這個）。
    const nul = String.fromCharCode(0), rlo = String.fromCharCode(0x202e)
    const l = learnedLines(learnedItem({ from: 'a' + nul + 'b', to: 'c' + rlo + 'd' }))
    assert.ok(!l.head.includes(nul), l.head)
    assert.ok(!l.head.includes(rlo), l.head)
  })

  test('times 壞掉（負數、NaN）就當成 1，不要印出奇怪的數字', () => {
    assert.equal(learnedLines(learnedItem({ times: -3 })).why, '用過 1 次')
    assert.equal(learnedLines(learnedItem({ times: 'x' })).why, '用過 1 次')
  })
})

describe('建議列上的兩個標記', () => {
  test('歸檔：learned 要講一句、rejectedBefore 要講一句', () => {
    assert.ok(!filingLines(filing()).why.includes('照你上次改的'))
    assert.equal(filingLines(filing()).rejected, false)
    assert.equal(filingLines(filing()).back, '')
    assert.match(filingLines(filing({ learned: true })).why, /位置照你上次改的寫/)
    const back = filingLines(filing({ rejectedBefore: true }))
    assert.equal(back.rejected, true)
    assert.match(back.back, /你上次退過這個建議/)
    assert.match(back.back, /沒有預設勾/)
  })

  test('歸檔：**「模型認為」那一句用模型自己的課名**', () => {
    const l = filingLines(filing({ course: 'OS', modelCourse: '作業系統', learned: true, toFolder: '課程/OS/筆記' }))
    assert.match(l.why, /模型認為：作業系統／死結/)
    assert.equal(l.head, '未命名文件 (3).txt → 課程/OS/筆記')
  })

  test('歸檔：舊資料夾還在的時候要講一句（預期行為 12）', () => {
    const l = filingLines(filing({ course: 'OS', learned: true, alsoKnownAs: '作業系統', toFolder: '課程/OS/筆記' }))
    assert.match(l.note, /你之前把它叫「作業系統」，那個資料夾還在/)
    assert.ok(!filingLines(filing()).note.includes('你之前把它叫'))
  })

  test('改名：learned 與 rejectedBefore 同樣看得到', () => {
    assert.match(renameLines(rename({ learned: true })).why, /課名那一段照你上次改的寫/)
    assert.equal(renameLines(rename({ rejectedBefore: true })).rejected, true)
    assert.equal(renameLines(rename()).rejected, false)
  })

  test('舊的後端沒有這幾個欄位 → 當成沒有（面板不可以因此壞掉）', () => {
    const old = { itemId: 'x', name: 'a.txt', course: '作業系統', kind: '筆記', toFolder: '課程/作業系統/筆記' }
    const l = filingLines(old)
    assert.equal(l.rejected, false)
    assert.equal(l.back, '')
    assert.match(l.why, /模型認為：作業系統/)
  })
})

// ═══ 面板 ═════════════════════════════════════════════════════

describe('面板的「它學到的事」', () => {
  test('什麼都沒學過 → 整區不顯示', async t => {
    const ui = await open(t, {})
    assert.equal(ui.$('cleanup-learned').hidden, true)
    assert.equal(rows(ui).length, 0)
  })

  test('學過之後列出來，每一列一個「忘掉」', async t => {
    const ui = await open(t, { learned: [learnedItem(), learnedItem({ id: 'p-2', kind: 'file_kind', from: '作業系統／筆記', to: '講義' })] })
    assert.equal(ui.$('cleanup-learned').hidden, false)
    assert.equal(rows(ui).length, 2)
    const buttons = ui.$('cleanup-learned').all('BUTTON')
    assert.equal(buttons.length, 2)
    assert.equal(buttons[0].textContent, '忘掉')
    assert.match(ui.$('cleanup-learned').textContent, /模型說「作業系統」 ・ 你要「OS」/)
    assert.match(ui.$('cleanup-learned').textContent, /不會自己動檔案/)
  })

  test('按「忘掉」→ DELETE /learned { ids: [那一條] }，而且重讀建議那兩區', async t => {
    const ui = await open(t, {
      learned: [learnedItem()],
      filings: [filing({ learned: true, course: 'OS', toFolder: '課程/OS/筆記' })],
    })
    const before = ui.apiCalls.length
    await ui.$('cleanup-learned').all('BUTTON')[0].onclick()
    await ui.idle()
    const after = ui.apiCalls.slice(before)
    const del = after.find(c => c.path === '/learned' && c.method === 'DELETE')
    assert.ok(del, JSON.stringify(after))
    assert.deepEqual(del.body, { ids: ['p-1'] })
    assert.ok(after.some(c => c.path === '/file/suggestions'), '忘掉之後建議要重讀')
    assert.ok(after.some(c => c.path === '/rename/suggestions'), '忘掉之後建議要重讀')
    assert.match(ui.$('cleanup-result').textContent, /忘掉了/)
  })

  test('**沒有「全部忘掉」這種按鈕**：面板一次只忘一條', async t => {
    const ui = await open(t, { learned: [learnedItem(), learnedItem({ id: 'p-2' })] })
    for (const b of ui.$('cleanup-learned').all('BUTTON')) assert.equal(b.textContent, '忘掉')
  })

  test('丟掉過幾條要講出來（不是安靜地消失）', async t => {
    const ui = await open(t, { learned: [learnedItem()], evicted: 7 })
    assert.match(ui.$('cleanup-learned').textContent, /已經丟掉最舊、最少用的 7 條/)
  })

  test('後端沒有這一條（404）→ 整區不顯示，清理面板照常', async t => {
    const ui = await open(t, { learned: 'missing' })
    assert.equal(ui.$('cleanup-learned').hidden, true)
    assert.equal(ui.$('cleanup-panel').open, true)
    assert.match(ui.$('cleanup-list').textContent, /目前沒有待清檔案/)
  })

  test('示範模式整區不顯示（示範不可以改到真的設定）', async t => {
    const ui = await open(t, { learned: [learnedItem()] })
    assert.equal(ui.$('cleanup-learned').hidden, false, '前提：本機模式看得到')
    await ui.key('d')
    await ui.click('quaso-cleanup-alert')
    assert.equal(ui.$('cleanup-learned').hidden, true)
  })

  test('**畫面上一個絕對路徑都沒有**（預期行為 11）', async t => {
    const ui = await open(t, {
      learned: [learnedItem(), learnedItem({ id: 'p-2', kind: 'rejected', from: '課程/OS/講義', to: '' })],
    })
    const text = ui.$('cleanup-learned').textContent
    assert.ok(!text.includes(FAKE_HOME), text)
    assert.ok(!text.includes('/home/'), text)
    assert.ok(!/(^|[^課])\/Users\//.test(text), text)
  })
})

describe('退過貨的建議：列出來，但不預設勾（預期行為 5）', () => {
  test('歸檔區：勾選框沒有勾，而且畫面上講了原因', async t => {
    const ui = await open(t, { filings: [filing({ rejectedBefore: true })] })
    const boxes = ui.$('cleanup-filings').all('INPUT')
    assert.equal(boxes.length, 1)
    assert.equal(boxes[0].checked, false)
    assert.match(ui.$('cleanup-filings').textContent, /你上次退過這個建議，所以沒有預設勾起來/)
  })

  test('改名區：一樣', async t => {
    const ui = await open(t, { renames: [rename({ rejectedBefore: true })] })
    assert.equal(ui.$('cleanup-renames').all('INPUT')[0].checked, false)
    assert.match(ui.$('cleanup-renames').textContent, /你上次退過這個建議/)
  })

  test('沒退過的那幾列不會多出那一句', async t => {
    const ui = await open(t, { filings: [filing()] })
    assert.equal(ui.$('cleanup-filings').all('INPUT')[0].checked, false)
    assert.ok(!ui.$('cleanup-filings').textContent.includes('你上次退過'))
  })

  test('使用者自己勾還是勾得起來（退貨不是禁止）', async t => {
    const ui = await open(t, { filings: [filing({ rejectedBefore: true })] })
    const box = ui.$('cleanup-filings').all('INPUT')[0]
    box.checked = true
    box.onchange()
    await ui.idle()
    assert.equal(ui.$('cleanup-filings').all('INPUT')[0].checked, true)
  })
})

describe('createLearned（單獨測，不掛 DOM）', () => {
  test('讀不到就當成什麼都沒學過', async () => {
    const store = createLearned(async () => { throw new Error('沒有這個路徑') })
    assert.deepEqual(await store.load(), [])
    assert.equal(store.more, 0)
    assert.equal(store.evicted, 0)
  })

  test('回的不是陣列也不會炸', async () => {
    const store = createLearned(async () => ({ items: '不是陣列' }))
    assert.deepEqual(await store.load(), [])
  })

  test('超過 50 條只畫前 50 條，其餘算在 more 裡', async () => {
    const many = Array.from({ length: 63 }, (_, i) => learnedItem({ id: `p-${i}` }))
    const store = createLearned(async () => ({ items: many, evicted: { count: 0, at: null } }))
    await store.load()
    assert.equal(store.items.length, 50)
    assert.equal(store.more, 13)
  })

  test('忘掉一條不在清單上的 → 不送請求', async () => {
    const calls = []
    const store = createLearned(async (path, init) => {
      calls.push({ path, method: init?.method ?? 'GET' })
      return { items: [learnedItem()], evicted: { count: 0, at: null } }
    })
    await store.load()
    await assert.rejects(() => store.forget('不存在'), /已經不在清單上/)
    assert.equal(calls.filter(c => c.method === 'DELETE').length, 0)
  })
})
