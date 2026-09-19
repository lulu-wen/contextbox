import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * P3 ・ 面板的「建議的名字」那一區。
 *
 * 期望值抄自 `~/contextbox-預想-20260919-P3改名.md`（介面那一節與不變量 1、9）：
 *
 * | 段落 | 可能的錯 | 另一種解讀 | 成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | 建議怎麼呈現 | 寫「這個檔是作業系統講義」 | 標明是意見 | 一列建議 | 「原名 → 建議名」＋「模型認為⋯」＋證據＋「這是模型的意見，不是事實」 |
 * | 預設勾不勾 | 信心高的先勾起來 | 一個都不勾 | 信心高的建議 | **一個都不勾**（改名只有紀錄救得回來） |
 * | 沒勾就按改名 | 全部改 | 什麼都不做，講一句 | 一個都沒勾 | 不送請求，畫面講「請先勾選」 |
 * | 送什麼 | 只送 itemId 讓後端自己猜 | 連建議的名字一起送 | 勾一個 | `{ items: [{ itemId, to }] }` |
 * | 後端沒有這幾條 | 整個面板壞掉 | 整區不顯示 | /rename/suggestions 回 404 | 清理面板照常，改名區不見 |
 * | 示範模式 | 也列 | 不列 | 按 D 開示範 | 改名區與兩顆按鈕都不顯示 |
 * | 復原 | 只有改完那一秒有 | 改完就一直在 | 改完 | 「復原改名」出現，送 { last: true } |
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountPanel } from './helpers/panel-dom.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
/** 按 D 的示範模式會去讀這一份；沒有它的話 demo 根本開不起來。 */
const demoFetch = async url => String(url).includes('demo-candidates.json')
  ? new Response(readFileSync(join(REPO, 'core/assets/demo-candidates.json')), { status: 200 })
  : new Response('not found', { status: 404 })
import { renameLines, renameApplyMessage, renameUndoMessage } from '../core/assets/cleanup-real-state.js'

const suggestion = (over = {}) => ({
  itemId: 'it-1', name: '未命名文件 (3).txt', suggested: '作業系統_死結.txt',
  course: '作業系統', topic: '死結', confidence: '高', evidence: '文件裡寫著「四個必要條件」',
  seeded: false, ...over,
})

function fakeApi({ suggestions = [], onApply = null, onUndo = null, calls = [] } = {}) {
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
    if (path === '/rename/suggestions') {
      if (suggestions === 'missing') { const e = new Error('沒有這個路徑'); e.status = 404; throw e }
      return { items: suggestions }
    }
    if (path === '/rename/apply') return onApply ? onApply(JSON.parse(init.body)) : { results: [], remaining: 0 }
    if (path === '/rename/undo') return onUndo ? onUndo(JSON.parse(init.body)) : { results: [] }
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

const rows = ui => ui.$('cleanup-renames').all('ARTICLE')
const boxes = ui => ui.$('cleanup-renames').all('INPUT')

// ═══ 純函式 ═══════════════════════════════════════════════════

describe('renameLines', () => {
  test('一列：原名 → 建議名、模型說了什麼、證據、而且講明是意見', () => {
    const l = renameLines(suggestion())
    assert.equal(l.head, '未命名文件 (3).txt → 作業系統_死結.txt')
    assert.equal(l.why, '模型認為：作業系統／死結（信心 高）')
    assert.match(l.note, /證據：文件裡寫著「四個必要條件」/)
    assert.match(l.note, /這是模型的意見，不是事實/)
    assert.match(l.note, /改得回來/)
  })

  test('示範答案要標出來', () => {
    assert.match(renameLines(suggestion({ seeded: true })).why, /^［示範答案］/)
  })

  test('模型沒給證據就直說，不要留一塊空的', () => {
    assert.match(renameLines(suggestion({ evidence: '' })).note, /模型沒有給證據/)
  })

  test('看不出課程或主題就寫「看不出來」，不是空白', () => {
    assert.equal(renameLines(suggestion({ course: '', topic: '   ' })).why, '模型認為：看不出來／看不出來（信心 高）')
  })

  test('**檔名與證據是不可信的輸入**：控制字元與方向字元換掉', () => {
    const l = renameLines(suggestion({
      name: '好檔案\u202E' + 'txt.exe', suggested: 'a\u0000b.txt', evidence: '第一行\nfake ✔ 已刪除',
    }))
    assert.ok(!l.head.includes('\u202E'), l.head)
    assert.ok(!l.head.includes('\u0000'), l.head)
    assert.ok(!l.note.includes('\n'), l.note)
  })

  test('壞掉的一列不要畫（回 null）', () => {
    assert.equal(renameLines(null), null)
    assert.equal(renameLines({}), null)
    assert.equal(renameLines({ name: 'a.txt' }), null)
  })
})

describe('結果的訊息', () => {
  test('改名：逐項都講，成功與失敗分開', () => {
    const m = renameApplyMessage({
      results: [
        { itemId: 'a', ok: true, from: '未命名文件 (3).txt', to: '作業系統_死結.txt', why: '改好了。' },
        { itemId: 'b', ok: false, from: 'IMG_2041.txt', to: '', why: '這個檔十分鐘內還在變動，先不改名。' },
      ],
      remaining: 0,
    })
    assert.match(m, /改好 1 個，1 個沒有改。/)
    assert.match(m, /・未命名文件 \(3\)\.txt → 作業系統_死結\.txt/)
    assert.match(m, /・IMG_2041\.txt：這個檔十分鐘內還在變動/)
    assert.match(m, /復原改名/)
  })

  test('超過一次的上限：講還有幾個', () => {
    const m = renameApplyMessage({ results: [{ itemId: 'a', ok: true, from: 'x', to: 'y', why: '' }], remaining: 50 })
    assert.match(m, /還有 50 個沒做/)
  })

  test('復原：原名被佔走時**一定要講放回來的叫什麼**', () => {
    const m = renameUndoMessage({
      results: [{ id: 'r1', itemId: 'a', ok: true, to: '未命名文件 (3)-2.txt', restoredAs: '未命名文件 (3)-2.txt', why: '' }],
    })
    assert.match(m, /放回來的這一份叫「未命名文件 \(3\)-2\.txt」/)
    assert.match(m, /沒有覆蓋任何檔/)
  })

  test('復原失敗也要講', () => {
    const m = renameUndoMessage({ results: [{ id: 'r1', itemId: 'a', ok: false, to: '', restoredAs: null, why: '檔案或資料夾不見了，請確認後重試。' }] })
    assert.match(m, /改回去 0 個，1 個沒有放回/)
    assert.match(m, /沒有放回：檔案或資料夾不見了/)
  })
})

// ═══ 面板 ═════════════════════════════════════════════════════

describe('面板的「建議的名字」區', () => {
  test('列出來，而且**一個勾選框都不預設勾起來**', async t => {
    const ui = await open(t, { suggestions: [suggestion(), suggestion({ itemId: 'it-2', name: 'IMG_2041.txt', suggested: '資料結構_期中考範圍.txt' })] })
    assert.equal(ui.$('cleanup-renames').hidden, false)
    assert.equal(rows(ui).length, 2)
    assert.match(ui.$('cleanup-renames').textContent, /未命名文件 \(3\)\.txt → 作業系統_死結\.txt/)
    assert.match(ui.$('cleanup-renames').textContent, /模型認為：作業系統／死結（信心 高）/)
    assert.match(ui.$('cleanup-renames').textContent, /這是模型的意見，不是事實/)
    assert.deepEqual(boxes(ui).map(b => b.checked), [false, false], '改名不可以預設勾起來')
    assert.equal(ui.$('cleanup-rename').hidden, false)
    assert.equal(ui.$('cleanup-rename-undo').hidden, true, '還沒改過，沒有東西要復原')
  })

  test('沒有建議：整區與兩顆按鈕都不顯示', async t => {
    const ui = await open(t, { suggestions: [] })
    assert.equal(ui.$('cleanup-renames').hidden, true)
    assert.equal(ui.$('cleanup-rename').hidden, true)
    assert.equal(ui.$('cleanup-rename-undo').hidden, true)
  })

  test('後端沒有這幾條（404）：清理面板照常，改名區不見', async t => {
    const ui = await open(t, { suggestions: 'missing' })
    assert.equal(ui.$('cleanup-renames').hidden, true)
    assert.match(ui.$('cleanup-list').textContent, /目前沒有待清檔案/)
  })

  test('沒勾就按「改名」：不送請求，畫面講一句', async t => {
    const ui = await open(t, { suggestions: [suggestion()] })
    await ui.click('cleanup-rename')
    assert.match(ui.$('cleanup-result').textContent, /請先勾選/)
    assert.equal(ui.apiCalls.filter(c => c.path === '/rename/apply').length, 0, '一個請求都不可以送出去')
  })

  test('勾起來按「改名」：**只送勾的那幾個，而且連建議的名字一起送**', async t => {
    const applied = []
    const ui = await open(t, {
      suggestions: [suggestion(), suggestion({ itemId: 'it-2', name: 'IMG_2041.txt', suggested: '資料結構_期中考範圍.txt' })],
      onApply: body => {
        applied.push(body)
        return { results: body.items.map(i => ({ itemId: i.itemId, ok: true, from: '未命名文件 (3).txt', to: i.to, why: '改好了。' })), remaining: 0 }
      },
    })
    const [first] = boxes(ui)
    first.checked = true
    await first.onchange()
    await ui.click('cleanup-rename')

    assert.deepEqual(applied, [{ items: [{ itemId: 'it-1', to: '作業系統_死結.txt' }] }])
    assert.match(ui.$('cleanup-result').textContent, /改好 1 個/)
    assert.match(ui.$('cleanup-result').textContent, /→ 作業系統_死結\.txt/)
    assert.equal(ui.$('cleanup-rename-undo').hidden, false, '改完要看得到「復原改名」')
  })

  test('「復原改名」送 { last: true }，訊息照後端說的講', async t => {
    const undos = []
    const ui = await open(t, {
      suggestions: [suggestion()],
      onApply: body => ({ results: body.items.map(i => ({ itemId: i.itemId, ok: true, from: '未命名文件 (3).txt', to: i.to, why: '' })), remaining: 0 }),
      onUndo: body => {
        undos.push(body)
        return { results: [{ id: 'r1', itemId: 'it-1', ok: true, to: '未命名文件 (3).txt', restoredAs: null, why: '' }] }
      },
    })
    const [first] = boxes(ui)
    first.checked = true
    await first.onchange()
    await ui.click('cleanup-rename')
    await ui.click('cleanup-rename-undo')
    assert.deepEqual(undos, [{ last: true }])
    assert.match(ui.$('cleanup-result').textContent, /改回去 1 個/)
    assert.equal(ui.$('cleanup-rename-undo').hidden, true, '復原過就沒有東西要復原了')
  })

  test('後端說某一個沒改成：畫面要講出來，不可以只說「改好 0 個」', async t => {
    const ui = await open(t, {
      suggestions: [suggestion()],
      onApply: () => ({
        results: [{ itemId: 'it-1', ok: false, from: '未命名文件 (3).txt', to: '', why: '它在一份還沒處理完的清理計畫裡。' }],
        remaining: 0,
      }),
    })
    const [first] = boxes(ui)
    first.checked = true
    await first.onchange()
    await ui.click('cleanup-rename')
    assert.match(ui.$('cleanup-result').textContent, /它在一份還沒處理完的清理計畫裡/)
    assert.equal(ui.$('cleanup-rename-undo').hidden, true, '一個都沒改成，沒有東西要復原')
  })

  test('改名的請求失敗：只講原因，不假裝成功', async t => {
    const ui = await open(t, {
      suggestions: [suggestion()],
      onApply: () => { const e = new Error('目前是唯讀模式，不會改任何檔案的名字。'); e.status = 403; throw e },
    })
    const [first] = boxes(ui)
    first.checked = true
    await first.onchange()
    await ui.click('cleanup-rename')
    assert.match(ui.$('cleanup-result').textContent, /唯讀模式/)
    assert.equal(ui.$('cleanup-rename-undo').hidden, true)
  })

  test('示範模式不顯示改名區（那時候畫面上是假的清單）', async t => {
    const ui = await open(t, { suggestions: [suggestion()] })
    assert.equal(ui.$('cleanup-renames').hidden, false, '前提：本機模式看得到')
    await ui.key('d')
    await ui.click('quaso-cleanup-alert')
    assert.equal(ui.$('cleanup-renames').hidden, true)
    assert.equal(ui.$('cleanup-rename').hidden, true)
    assert.equal(ui.$('cleanup-rename-undo').hidden, true)
  })
})
