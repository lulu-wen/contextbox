import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * P4 ・ 面板的「歸檔建議」那一區。
 *
 * 期望值抄自 `~/contextbox-預想-20260919-P4歸檔.md`（介面那一節與不變量 1、8）：
 *
 * | 段落 | 可能的錯 | 另一種解讀 | 成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | 一列怎麼呈現 | 寫完整路徑 | 只寫相對那一段 | 一列建議 | 「檔名 → 課程/作業系統/講義」＋「模型認為⋯」＋證據 |
 * | 預設勾不勾 | 信心高的先勾 | 一個都不勾 | 信心高的建議 | **一個都不勾**（搬家比改名更難自己找回來） |
 * | 沒勾就按整理 | 全部搬 | 什麼都不做，講一句 | 一個都沒勾 | 不送請求，畫面講「請先勾選」 |
 * | 送什麼 | 只送 itemId | 連課名與類型一起送 | 勾一個 | `{ items: [{ itemId, course, kind }] }` |
 * | 後端沒有這幾條 | 整個面板壞掉 | 整區不顯示 | /file/suggestions 回 404 | 清理面板照常，歸檔區不見 |
 * | 示範模式 | 也列 | 不列 | 按 D 開示範 | 歸檔區與兩顆按鈕都不顯示 |
 * | 復原 | 只有搬完那一秒有 | 搬完就一直在 | 搬完 | 「復原整理」出現，送 { last: true } |
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
import { filingLines, filingApplyMessage, filingUndoMessage } from '../core/assets/cleanup-real-state.js'

const suggestion = (over = {}) => ({
  itemId: 'it-1', name: '未命名文件 (3).txt', course: '作業系統', kind: '筆記', topic: '死結',
  confidence: '高', evidence: '文件裡寫著「四個必要條件」', seeded: false,
  toFolder: '課程/作業系統/筆記', ...over,
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
    if (path === '/rename/suggestions') return { items: [] }
    if (path === '/file/suggestions') {
      if (suggestions === 'missing') { const e = new Error('沒有這個路徑'); e.status = 404; throw e }
      return { items: suggestions }
    }
    if (path === '/file/apply') return onApply ? onApply(JSON.parse(init.body)) : { results: [], remaining: 0 }
    if (path === '/file/undo') return onUndo ? onUndo(JSON.parse(init.body)) : { results: [] }
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

const rows = ui => ui.$('cleanup-filings').all('ARTICLE')
const boxes = ui => ui.$('cleanup-filings').all('INPUT')

// ═══ 純函式 ═══════════════════════════════════════════════════

describe('filingLines', () => {
  test('一列：檔名 → 課程/作業系統/筆記、模型說了什麼、證據，而且講明是意見', () => {
    const l = filingLines(suggestion())
    assert.equal(l.head, '未命名文件 (3).txt → 課程/作業系統/筆記')
    assert.equal(l.why, '模型認為：作業系統／死結（信心 高）')
    assert.match(l.note, /證據：文件裡寫著「四個必要條件」/)
    assert.match(l.note, /這是模型的意見，不是事實/)
    assert.match(l.note, /搬得回來/)
  })

  test('示範答案要標出來', () => {
    assert.match(filingLines(suggestion({ seeded: true })).why, /^［示範答案］/)
  })

  test('模型沒給證據就直說，不要留一塊空的', () => {
    assert.match(filingLines(suggestion({ evidence: '' })).note, /模型沒有給證據/)
  })

  test('看不出主題就寫「看不出來」，不是空白', () => {
    assert.equal(filingLines(suggestion({ topic: '   ' })).why, '模型認為：作業系統／看不出來（信心 高）')
  })

  test('**檔名與資料夾名都是不可信的輸入**：控制字元與方向字元換掉', () => {
    const l = filingLines(suggestion({
      name: '好檔案\u202E' + 'txt.exe', toFolder: '課程/a\u0000b/筆記', evidence: '第一行\nfake ✔ 已刪除',
    }))
    assert.ok(!l.head.includes('\u202E'), l.head)
    assert.ok(!l.head.includes('\u0000'), l.head)
    assert.ok(!l.note.includes('\n'), l.note)
  })

  test('壞掉的一列不要畫（回 null）', () => {
    assert.equal(filingLines(null), null)
    assert.equal(filingLines({}), null)
    assert.equal(filingLines({ name: 'a.txt' }), null)
  })
})

describe('結果的訊息', () => {
  test('整理：逐項都講，成功與失敗分開', () => {
    const m = filingApplyMessage({
      results: [
        { itemId: 'a', ok: true, name: '未命名文件 (3).txt', toFolder: '課程/作業系統/筆記', to: '未命名文件 (3).txt', why: '' },
        { itemId: 'b', ok: false, name: 'IMG_2041.txt', toFolder: '', to: '', why: '這個檔十分鐘內還在變動，先不歸檔。' },
      ],
      remaining: 0,
    })
    assert.match(m, /整理好 1 個，1 個沒有搬。/)
    assert.match(m, /・未命名文件 \(3\)\.txt → 課程\/作業系統\/筆記\//)
    assert.match(m, /・IMG_2041\.txt：這個檔十分鐘內還在變動/)
    assert.match(m, /復原整理/)
  })

  test('目標同名加了序號：畫面要看得到它真正叫什麼', () => {
    const m = filingApplyMessage({
      results: [{ itemId: 'a', ok: true, name: 'a.txt', toFolder: '課程/作業系統/講義', to: 'a-2.txt', why: '' }],
      remaining: 0,
    })
    assert.match(m, /課程\/作業系統\/講義\/a-2\.txt/)
  })

  test('超過一次的上限：講還有幾個', () => {
    const m = filingApplyMessage({ results: [{ itemId: 'a', ok: true, name: 'x', toFolder: 'y', to: 'x', why: '' }], remaining: 50 })
    assert.match(m, /還有 50 個沒做/)
  })

  test('復原：原位被佔走時**一定要講放回來的叫什麼**', () => {
    const m = filingUndoMessage({
      results: [{ id: 'f1', itemId: 'a', ok: true, name: '未命名文件 (3)-2.txt', restoredAs: '未命名文件 (3)-2.txt', why: '' }],
    })
    assert.match(m, /放回來的這一份叫「未命名文件 \(3\)-2\.txt」/)
    assert.match(m, /沒有覆蓋任何檔/)
  })

  test('復原失敗也要講', () => {
    const m = filingUndoMessage({
      results: [{ id: 'f1', itemId: 'a', ok: false, name: '', restoredAs: null, why: '檔案或資料夾不見了，請確認後重試。' }],
    })
    assert.match(m, /搬回 0 個，1 個沒有搬回/)
    assert.match(m, /沒有搬回：檔案或資料夾不見了/)
  })
})

// ═══ 面板 ═════════════════════════════════════════════════════

describe('面板的「歸檔建議」區', () => {
  test('列出來，而且**一個勾選框都不預設勾起來**', async t => {
    const ui = await open(t, {
      suggestions: [suggestion(), suggestion({ itemId: 'it-2', name: 'IMG_2041.txt', course: '資料結構', kind: '考試', toFolder: '課程/資料結構/考試' })],
    })
    assert.equal(ui.$('cleanup-filings').hidden, false)
    assert.equal(rows(ui).length, 2)
    assert.match(ui.$('cleanup-filings').textContent, /未命名文件 \(3\)\.txt → 課程\/作業系統\/筆記/)
    assert.match(ui.$('cleanup-filings').textContent, /模型認為：作業系統／死結（信心 高）/)
    assert.match(ui.$('cleanup-filings').textContent, /這是模型的意見，不是事實/)
    assert.deepEqual(boxes(ui).map(b => b.checked), [false, false], '歸檔不可以預設勾起來')
    assert.equal(ui.$('cleanup-file').hidden, false)
    assert.equal(ui.$('cleanup-file-undo').hidden, true, '還沒整理過，沒有東西要復原')
  })

  test('沒有建議：整區與兩顆按鈕都不顯示', async t => {
    const ui = await open(t, { suggestions: [] })
    assert.equal(ui.$('cleanup-filings').hidden, true)
    assert.equal(ui.$('cleanup-file').hidden, true)
    assert.equal(ui.$('cleanup-file-undo').hidden, true)
  })

  test('後端沒有這幾條（404）：清理面板照常，歸檔區不見', async t => {
    const ui = await open(t, { suggestions: 'missing' })
    assert.equal(ui.$('cleanup-filings').hidden, true)
    assert.match(ui.$('cleanup-list').textContent, /目前沒有待清檔案/)
  })

  test('沒勾就按「整理」：不送請求，畫面講一句', async t => {
    const ui = await open(t, { suggestions: [suggestion()] })
    await ui.click('cleanup-file')
    assert.match(ui.$('cleanup-result').textContent, /請先勾選/)
    assert.equal(ui.apiCalls.filter(c => c.path === '/file/apply').length, 0, '一個請求都不可以送出去')
  })

  test('勾起來按「整理」：**只送勾的那幾個，而且連課名與類型一起送**', async t => {
    const applied = []
    const ui = await open(t, {
      suggestions: [suggestion(), suggestion({ itemId: 'it-2', name: 'IMG_2041.txt', course: '資料結構', kind: '考試', toFolder: '課程/資料結構/考試' })],
      onApply: body => {
        applied.push(body)
        return {
          results: body.items.map(i => ({
            itemId: i.itemId, ok: true, name: '未命名文件 (3).txt',
            toFolder: `課程/${i.course}/${i.kind}`, to: '未命名文件 (3).txt', why: '',
          })),
          remaining: 0,
        }
      },
    })
    const [first] = boxes(ui)
    first.checked = true
    await first.onchange()
    await ui.click('cleanup-file')

    assert.deepEqual(applied, [{ items: [{ itemId: 'it-1', course: '作業系統', kind: '筆記' }] }])
    assert.match(ui.$('cleanup-result').textContent, /整理好 1 個/)
    assert.match(ui.$('cleanup-result').textContent, /課程\/作業系統\/筆記/)
    assert.equal(ui.$('cleanup-file-undo').hidden, false, '整理完要看得到「復原整理」')
  })

  test('「復原整理」送 { last: true }，訊息照後端說的講', async t => {
    const undos = []
    const ui = await open(t, {
      suggestions: [suggestion()],
      onApply: body => ({
        results: body.items.map(i => ({ itemId: i.itemId, ok: true, name: 'x.txt', toFolder: 'y', to: 'x.txt', why: '' })),
        remaining: 0,
      }),
      onUndo: body => {
        undos.push(body)
        return { results: [{ id: 'f1', itemId: 'it-1', ok: true, name: '未命名文件 (3).txt', restoredAs: null, why: '' }] }
      },
    })
    const [first] = boxes(ui)
    first.checked = true
    await first.onchange()
    await ui.click('cleanup-file')
    await ui.click('cleanup-file-undo')
    assert.deepEqual(undos, [{ last: true }])
    assert.match(ui.$('cleanup-result').textContent, /搬回 1 個/)
    assert.equal(ui.$('cleanup-file-undo').hidden, true, '復原過就沒有東西要復原了')
  })

  test('後端說某一個沒搬成：畫面要講出來，不可以只說「整理好 0 個」', async t => {
    const ui = await open(t, {
      suggestions: [suggestion()],
      onApply: () => ({
        results: [{ itemId: 'it-1', ok: false, name: '未命名文件 (3).txt', toFolder: '', to: '', why: '「整理好的」資料夾在另一顆碟，這一版還不支援搬過去。' }],
        remaining: 0,
      }),
    })
    const [first] = boxes(ui)
    first.checked = true
    await first.onchange()
    await ui.click('cleanup-file')
    assert.match(ui.$('cleanup-result').textContent, /另一顆碟/)
    assert.equal(ui.$('cleanup-file-undo').hidden, true, '一個都沒搬成，沒有東西要復原')
  })

  test('整理的請求失敗：只講原因，不假裝成功', async t => {
    const ui = await open(t, {
      suggestions: [suggestion()],
      onApply: () => { const e = new Error('目前是唯讀模式，不會搬動任何檔案。'); e.status = 403; throw e },
    })
    const [first] = boxes(ui)
    first.checked = true
    await first.onchange()
    await ui.click('cleanup-file')
    assert.match(ui.$('cleanup-result').textContent, /唯讀模式/)
    assert.equal(ui.$('cleanup-file-undo').hidden, true)
  })

  test('示範模式不顯示歸檔區（那時候畫面上是假的清單）', async t => {
    const ui = await open(t, { suggestions: [suggestion()] })
    assert.equal(ui.$('cleanup-filings').hidden, false, '前提：本機模式看得到')
    await ui.key('d')
    await ui.click('quaso-cleanup-alert')
    assert.equal(ui.$('cleanup-filings').hidden, true)
    assert.equal(ui.$('cleanup-file').hidden, true)
    assert.equal(ui.$('cleanup-file-undo').hidden, true)
  })

  test('只有歸檔建議、沒有待清檔案時，不可以說「目前沒有待清檔案」蓋掉整區', async t => {
    const ui = await open(t, { suggestions: [suggestion()] })
    assert.ok(!ui.$('cleanup-list').textContent.includes('目前沒有待清檔案'), ui.$('cleanup-list').textContent)
  })
})
