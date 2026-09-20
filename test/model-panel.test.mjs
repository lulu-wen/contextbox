import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * P2 的面板那一半：候選卡片與連拍區上的「模型認為⋯⋯」。
 *
 * 期望值抄自 `~/contextbox-預想-20260919-P2看懂.md`（預期行為第 10 條、不變量 4）：
 *
 * | 段落 | 可能的錯誤 | 另一種合理解讀 | 能分辨兩者的例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | 模型說的怎麼呈現 | 當成事實直接寫「這是作業系統講義」 | 標明是意見 | 一張卡片 | 「模型認為：⋯／⋯（信心 ⋯）」＋證據＋「這是模型的意見，不是事實」 |
 * | 模型說了要不要勾 | 自動勾起來 | 一個勾選框都不碰 | 後端 defaultChecked 是 false、模型很有信心 | **還是不勾** |
 * | 預先塞的答案 | 跟真的一樣 | 標「示範答案」 | seeded 1／0 | seeded 的前面加「［示範答案］」 |
 * | 沒接模型 | 卡片上留一塊空的 | 整段不顯示 | model 是 null／舊版後端沒有這一欄 | 卡片上一個字都不多 |
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mountPanel } from './helpers/panel-dom.mjs'
import { modelOpinionLines, normalizeBurstGroups } from '../core/assets/cleanup-real-state.js'

const opinion = (over = {}) => ({
  course: '作業系統', topic: '死結', kind: 'Lecture', suggestedName: '作業系統_死結',
  evidence: '文件裡寫著「四個必要條件」', confidence: 'high',
  model: 'Qwen3-VL-8B', at: '2026-09-19T00:00:00.000Z', seeded: false, ...over,
})

function candidate(itemId, name, extra = {}) {
  return {
    itemId, name, folder: 'Downloads', subdir: '', bytes: 2048, mtime: new Date().toISOString(),
    kind: 'screenshot-noise', confidence: 40, defaultChecked: false, vetoed: null,
    candidateIds: [itemId + '-c1'],
    reasons: [{ kind: 'screenshot-noise', confidence: 40, reason: '舊截圖常常是暫時資訊', evidence: '30 天沒有變動' }],
    model: null, ...extra,
  }
}

const shot = (itemId, name, extra = {}) =>
  ({ itemId, name, bytes: 2048, thumb: `/cleanup/thumb/${itemId}`, model: null, ...extra })

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13])

function fakeApi({ candidates = [], bursts = null } = {}) {
  return async (path, init = {}) => {
    if (path === '/health') {
      return {
        ok: true, version: 'test', pendingCandidates: candidates.length, needsHumanCount: 0,
        watcher: { ok: true, watching: ['Downloads'], watchingCount: 1, rootsMissing: 0, why: null },
        scanProblems: [],
      }
    }
    if (path === '/pet/state') {
      return { state: 'found', message: '有幾個檔可以清', pendingCount: candidates.length, quarantinedCount: 0, undoable: false }
    }
    if (path.startsWith('/cleanup/candidates')) return { candidates, needsHuman: [], total: candidates.length }
    if (path.startsWith('/cleanup/plans?')) return { total: 0, offset: 0, limit: 1, operations: [] }
    if (path === '/cleanup/bursts') {
      if (!bursts) { const e = new Error('還沒做好'); e.status = 501; throw e }
      return bursts
    }
    if (path.startsWith('/cleanup/thumb/')) return new Blob([PNG], { type: 'image/png' })
    const e = new Error('假後端不認得 ' + path)
    e.status = 404
    throw e
  }
}

async function open(t, opts) {
  const ui = await mountPanel(t, { api: fakeApi(opts) })
  await ui.click('quaso-cleanup-alert')
  return ui
}

const cards = ui => ui.$('cleanup-list').all('article')

// ═══ 純函式 ═══════════════════════════════════════════════════

describe('modelOpinionLines', () => {
  test('一般的一筆：標明是模型說的、講信心、講證據', () => {
    const l = modelOpinionLines(opinion())
    assert.equal(l.head, 'The model thinks: 作業系統 / 死結 (confidence high)')
    assert.match(l.note, /Evidence: 文件裡寫著「四個必要條件」/)
    assert.match(l.note, /This is the model's opinion, not a fact/)
    assert.match(l.note, /nothing gets renamed or moved because it said so/)
    assert.equal(l.seeded, false)
  })

  test('seeded：前面加「［示範答案］」', () => {
    const l = modelOpinionLines(opinion({ seeded: true }))
    assert.match(l.head, /^\[demo answer\] The model thinks: /)
    assert.equal(l.seeded, true)
  })

  test('欄位是空的：填「看不出來」「低」，不留一句半截的話', () => {
    const l = modelOpinionLines(opinion({ course: '', topic: '   ', confidence: '', evidence: '' }))
    assert.equal(l.head, 'The model thinks: Unknown / Unknown (confidence low)')
    assert.match(l.note, /The model gave no evidence/)
  })

  test('沒有看法（null、舊版後端沒有這一欄、不是物件）→ null，畫面上什麼都不加', () => {
    for (const bad of [null, undefined, 'x', 3, []]) {
      // 陣列也是物件，但它沒有那幾個欄位 —— 走 pick 的預設值，不會炸
      const l = modelOpinionLines(bad)
      if (Array.isArray(bad)) assert.ok(l, '陣列走預設值')
      else assert.equal(l, null, JSON.stringify(bad))
    }
  })

  test('模型講的字是不可信的輸入：控制字元換掉（safeName）', () => {
    const NUL = String.fromCharCode(0), RLO = String.fromCharCode(0x202e)
    const l = modelOpinionLines(opinion({ topic: '死' + RLO + '結', evidence: '第一行' + NUL + '第二行' }))
    assert.ok(!new RegExp('[' + NUL + RLO + ']').test(l.head + l.note), l.head + l.note)
  })
})

describe('連拍組的整形把 model 留著', () => {
  test('後端給了就留著，沒給就是 null', () => {
    const [g] = normalizeBurstGroups([{
      id: 'g1', level: 'same',
      keep: shot('k', 'keep.png', { model: opinion() }),
      members: [shot('m1', 'a.png', { level: 'same' })],
    }])
    assert.equal(g.keep.model.course, '作業系統')
    assert.equal(g.members[0].model, null)
  })

  test('後端給了奇怪的東西（字串、數字）→ null，不會讓面板壞掉', () => {
    const [g] = normalizeBurstGroups([{
      id: 'g1', level: 'same',
      keep: shot('k', 'keep.png', { model: '作業系統' }),
      members: [shot('m1', 'a.png', { level: 'same', model: 7 })],
    }])
    assert.equal(g.keep.model, null)
    assert.equal(g.members[0].model, null)
  })
})

// ═══ 真的面板 ═════════════════════════════════════════════════

describe('候選卡片（假的 api、真的面板）', () => {
  test('有看法時卡片上多兩行：「模型認為⋯⋯」與證據', async t => {
    const ui = await open(t, { candidates: [candidate('m1', '截圖 1.png', { model: opinion() })] })
    const card = cards(ui)[0]
    assert.match(card.textContent, /The model thinks: 作業系統 \/ 死結 \(confidence high\)/)
    assert.match(card.textContent, /Evidence: 文件裡寫著「四個必要條件」/)
    assert.match(card.textContent, /This is the model's opinion, not a fact/)
    assert.ok(card.byClass('cleanup-model').length, '沒有那個 class，樣式上看不出它跟規則講的話不一樣')
  })

  test('**模型很有信心也不會自動勾起來**', async t => {
    const ui = await open(t, {
      candidates: [candidate('m1', '截圖 1.png', { defaultChecked: false, model: opinion({ confidence: 'high' }) })],
    })
    assert.deepEqual(cards(ui)[0].all('input').map(i => i.checked), [false])
  })

  test('沒接模型（model 是 null）→ 卡片上一個字都不多', async t => {
    const withModel = await open(t, { candidates: [candidate('m1', 'a.png', { model: opinion() })] })
    const long = cards(withModel)[0].textContent
    const without = await open(t, { candidates: [candidate('m1', 'a.png')] })
    const short = cards(without)[0].textContent
    assert.ok(!/模型認為/.test(short), short)
    assert.ok(short.length < long.length)
    assert.equal(cards(without)[0].byClass('cleanup-model').length, 0)
  })

  test('示範答案標得出來（class 也不一樣）', async t => {
    const ui = await open(t, { candidates: [candidate('m1', 'a.png', { model: opinion({ seeded: true }) })] })
    const card = cards(ui)[0]
    assert.match(card.textContent, /\[demo answer\] The model thinks: /)
    assert.ok(card.byClass('cleanup-model-seeded').length, '示範答案要看得出來跟真的問過的不一樣')
  })
})

describe('連拍區（假的 api、真的面板）', () => {
  const fixture = () => ({
    candidates: [candidate('m1', '截圖 1.png'), candidate('m2', '截圖 2.png')],
    bursts: {
      groups: [{
        id: 'g1', level: 'same',
        keep: shot('k1', '截圖 3.png', { model: opinion({ topic: '行程排程' }) }),
        members: [
          shot('m1', '截圖 1.png', { level: 'same', boxes: [], model: opinion({ seeded: true }) }),
          shot('m2', '截圖 2.png', { level: 'same', boxes: [] }),
        ],
      }],
    },
  })

  test('留下的那張與成員都看得到「模型認為⋯⋯」；沒有看法的那張什麼都不多', async t => {
    const ui = await open(t, fixture())
    const cells = ui.$('cleanup-bursts').all('article')[0].byClass('cleanup-shot')
    assert.equal(cells.length, 3)
    assert.match(cells[0].textContent, /The model thinks: 作業系統 \/ 行程排程/)
    assert.match(cells[1].textContent, /\[demo answer\] The model thinks: /)
    assert.ok(!/模型認為/.test(cells[2].textContent), cells[2].textContent)
  })

  test('**連拍區也不會因為模型說了就勾起來**', async t => {
    const ui = await open(t, fixture())
    const checks = ui.$('cleanup-bursts').all('article')[0]
      .byClass('cleanup-shot').flatMap(c => c.all('input'))
    assert.equal(checks.length, 2, '留下的那張沒有勾選框')
    // same 的照後端的預設（這裡是 false）；模型的看法一格都不動
    assert.deepEqual(checks.map(c => c.checked), [false, false])
  })
})
