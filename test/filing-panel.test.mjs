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
  itemId: 'it-1', name: '未命名文件 (3).txt', course: '作業系統', kind: 'Notes', topic: '死結',
  confidence: 'high', evidence: '文件裡寫著「四個必要條件」', seeded: false,
  toFolder: 'Courses/作業系統/Notes', ...over,
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
    assert.equal(l.head, '未命名文件 (3).txt → Courses/作業系統/Notes')
    assert.equal(l.why, 'The model thinks: 作業系統 / 死結 (confidence high)')
    assert.match(l.note, /Evidence: 文件裡寫著「四個必要條件」/)
    // 免責聲明搬到 caveat：證據是模型引的字，這句是我們自己的字，兩個欄位不可以混在一起。
    assert.match(l.caveat, /This is the model's opinion, not a fact/)
    assert.match(l.caveat, /it can be undone/)
    assert.ok(!l.note.includes("opinion, not a fact"), '免責聲明不可以混進證據：' + l.note)
  })

  test('示範答案要標出來', () => {
    assert.match(filingLines(suggestion({ seeded: true })).why, /^\[demo answer\] /)
  })

  test('模型沒給證據就直說，不要留一塊空的', () => {
    assert.match(filingLines(suggestion({ evidence: '' })).note, /The model gave no evidence/)
  })

  test('看不出主題就寫「看不出來」，不是空白', () => {
    assert.equal(filingLines(suggestion({ topic: '   ' })).why, 'The model thinks: 作業系統 / Unknown (confidence high)')
  })

  test('**檔名與資料夾名都是不可信的輸入**：控制字元與方向字元換掉', () => {
    const l = filingLines(suggestion({
      name: '好檔案\u202E' + 'txt.exe', toFolder: 'Courses/a\u0000b/筆記', evidence: '第一行\nfake ✔ 已刪除',
    }))
    assert.ok(!l.head.includes('\u202E'), l.head)
    assert.ok(!l.head.includes('\u0000'), l.head)
    assert.ok(!l.note.includes('\n'), l.note)
  })

  // P7（2026-09-22）：course 是空的那幾列走「分類」那條路。
  // 以前 course 會退回 'Unknown'，畫面就寫「The model thinks: Unknown / Unknown」——
  // 而模型其實很確定那是一份履歷。那句話會讓使用者以為它看不懂，於是不敢按。
  test('**沒有課名的那一列要講它說這是什麼**，不可以寫 Unknown / Unknown', () => {
    const l = filingLines(suggestion({
      course: '', modelCourse: '', kind: 'Other', topic: 'Computer Science student profile',
      whatItIs: 'resume', toFolder: 'Resumes',
    }))
    assert.equal(l.head, '未命名文件 (3).txt → Resumes')
    assert.equal(l.why,
      'The model thinks this is: resume — Computer Science student profile (confidence high; not course material)')
    assert.ok(!l.why.includes('Unknown'), l.why)
  })

  test('沒有課名、連 whatItIs 都沒有 → 寫 Unknown，但不寫成課名', () => {
    const l = filingLines(suggestion({ course: '', modelCourse: '', topic: '', whatItIs: '', toFolder: 'Forms' }))
    assert.equal(l.why, 'The model thinks this is: Unknown (confidence high; not course material)')
  })

  test('沒有課名時 topic 是 Unknown 就不要多印一截', () => {
    const l = filingLines(suggestion({ course: '', modelCourse: '', topic: 'Unknown', whatItIs: 'exam', toFolder: 'Exams' }))
    assert.equal(l.why, 'The model thinks this is: exam (confidence high; not course material)')
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
        { itemId: 'a', ok: true, name: '未命名文件 (3).txt', toFolder: 'Courses/作業系統/Notes', to: '未命名文件 (3).txt', why: '' },
        { itemId: 'b', ok: false, name: 'IMG_2041.txt', toFolder: '', to: '', why: 'This file changed within the last ten minutes, so it will not be filed yet.' },
      ],
      remaining: 0,
    })
    assert.match(m, /Filed 1, 1 not filed./)
    assert.match(m, /- 未命名文件 \(3\)\.txt → Courses\/作業系統\/Notes\//)
    assert.match(m, /- IMG_2041\.txt: This file changed within the last ten minutes/)
    assert.match(m, /Undo filing/)
  })

  test('目標同名加了序號：畫面要看得到它真正叫什麼', () => {
    const m = filingApplyMessage({
      results: [{ itemId: 'a', ok: true, name: 'a.txt', toFolder: 'Courses/作業系統/Lecture', to: 'a-2.txt', why: '' }],
      remaining: 0,
    })
    assert.match(m, /Courses\/作業系統\/Lecture\/a-2\.txt/)
  })

  test('超過一次的上限：講還有幾個', () => {
    const m = filingApplyMessage({ results: [{ itemId: 'a', ok: true, name: 'x', toFolder: 'y', to: 'x', why: '' }], remaining: 50 })
    assert.match(m, /50 still to go/)
  })

  test('復原：原位被佔走時**一定要講放回來的叫什麼**', () => {
    const m = filingUndoMessage({
      results: [{ id: 'f1', itemId: 'a', ok: true, name: '未命名文件 (3)-2.txt', restoredAs: '未命名文件 (3)-2.txt', why: '' }],
    })
    assert.match(m, /so this one is called “未命名文件 \(3\)-2\.txt”/)
    assert.match(m, /nothing was overwritten/)
  })

  test('復原失敗也要講', () => {
    const m = filingUndoMessage({
      results: [{ id: 'f1', itemId: 'a', ok: false, name: '', restoredAs: null, why: 'The file or folder is gone. Check and try again.' }],
    })
    assert.match(m, /Moved 0 back, 1 not moved back/)
    assert.match(m, /Not moved back: The file or folder is gone/)
  })
})

// ═══ 面板 ═════════════════════════════════════════════════════

describe('面板的「歸檔建議」區', () => {
  test('列出來，而且**一個勾選框都不預設勾起來**', async t => {
    const ui = await open(t, {
      suggestions: [suggestion(), suggestion({ itemId: 'it-2', name: 'IMG_2041.txt', course: '資料結構', kind: 'Exam', toFolder: 'Courses/資料結構/Exam' })],
    })
    assert.equal(ui.$('cleanup-filings').hidden, false)
    assert.equal(rows(ui).length, 2)
    assert.match(ui.$('cleanup-filings').textContent, /未命名文件 \(3\)\.txt → Courses\/作業系統\/Notes/)
    assert.match(ui.$('cleanup-filings').textContent, /The model thinks: 作業系統 \/ 死結 \(confidence high\)/)
    assert.match(ui.$('cleanup-filings').textContent, /This is the model's opinion, not a fact/)
    assert.deepEqual(boxes(ui).map(b => b.checked), [false, false], 'Filing不可以預設勾起來')
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
    assert.match(ui.$('cleanup-list').textContent, /Nothing to clean up right now/)
  })

  test('沒勾就按「整理」：不送請求，畫面講一句', async t => {
    const ui = await open(t, { suggestions: [suggestion()] })
    await ui.click('cleanup-file')
    assert.match(ui.$('cleanup-result').textContent, /Tick the files you want/)
    assert.equal(ui.apiCalls.filter(c => c.path === '/file/apply').length, 0, '一個請求都不可以送出去')
  })

  test('勾起來按「整理」：**只送勾的那幾個，而且連課名與類型一起送**', async t => {
    const applied = []
    const ui = await open(t, {
      suggestions: [suggestion(), suggestion({ itemId: 'it-2', name: 'IMG_2041.txt', course: '資料結構', kind: 'Exam', toFolder: 'Courses/資料結構/Exam' })],
      onApply: body => {
        applied.push(body)
        return {
          results: body.items.map(i => ({
            itemId: i.itemId, ok: true, name: '未命名文件 (3).txt',
            toFolder: `Courses/${i.course}/${i.kind}`, to: '未命名文件 (3).txt', why: '',
          })),
          remaining: 0,
        }
      },
    })
    const [first] = boxes(ui)
    first.checked = true
    await first.onchange()
    await ui.click('cleanup-file')

    assert.deepEqual(applied, [{ items: [{ itemId: 'it-1', course: '作業系統', kind: 'Notes' }] }])
    assert.match(ui.$('cleanup-result').textContent, /Filed 1/)
    assert.match(ui.$('cleanup-result').textContent, /Courses\/作業系統\/Notes/)
    assert.equal(ui.$('cleanup-file-undo').hidden, false, '整理完要看得到“Undo filing”')
  })

  // P7（2026-09-22）：這一條釘住一個真的會讓人「按了沒反應」的 bug。
  // 沒有課名的那幾列 course 是空的，只送 course／kind 的話後端會在
  // 「沒有可用的課名」那一關擋掉 —— 畫面上明明寫著去處。
  test('**沒有課名的那一列要送 folder**，不是空的課名', async t => {
    const applied = []
    const ui = await open(t, {
      suggestions: [suggestion({
        itemId: 'it-cv', name: 'Peng-Ju_Wen_CV_1.docx', course: '', modelCourse: '',
        kind: 'Other', topic: '', whatItIs: 'resume', toFolder: 'Resumes',
      })],
      onApply: body => {
        applied.push(body)
        return {
          results: body.items.map(i => ({
            itemId: i.itemId, ok: true, name: 'Peng-Ju_Wen_CV_1.docx',
            toFolder: 'Resumes', to: 'Peng-Ju_Wen_CV_1.docx', why: '',
          })),
          remaining: 0,
        }
      },
    })
    const [first] = boxes(ui)
    first.checked = true
    await first.onchange()
    await ui.click('cleanup-file')

    assert.deepEqual(applied, [{ items: [{ itemId: 'it-cv', folder: 'Resumes' }] }])
    assert.match(ui.$('cleanup-result').textContent, /Filed 1/)
  })

  test('有課名的和沒課名的勾在一起：各送各的那一組', async t => {
    const applied = []
    const ui = await open(t, {
      suggestions: [
        suggestion(),
        suggestion({ itemId: 'it-cv', name: 'CV.docx', course: '', modelCourse: '', whatItIs: 'resume', toFolder: 'Resumes' }),
      ],
      onApply: body => {
        applied.push(body)
        return {
          results: body.items.map(i => ({ itemId: i.itemId, ok: true, name: 'x', toFolder: 'y', to: 'x', why: '' })),
          remaining: 0,
        }
      },
    })
    for (const b of boxes(ui)) { b.checked = true; await b.onchange() }
    await ui.click('cleanup-file')
    assert.deepEqual(applied, [{
      items: [
        { itemId: 'it-1', course: '作業系統', kind: 'Notes' },
        { itemId: 'it-cv', folder: 'Resumes' },
      ],
    }])
  })

  // 2026-09-22 實機回報：「按下 File 按鈕後他不會有任何反應，box 不會消失，貓咪也沒說話，
  // 他並不會告訴我是否有成功」。原因有兩個，這是第二個：結果那一塊在整個面板的最下面，
  // 而按鈕在每一列上 —— 清單一長，訊息就寫在螢幕外七百多像素的地方。
  //
  // 第一版的修法是「捲到看得見」，同一天使用者就打回來了：
  // 「每次點一個 file 他就會無限往下跳到成功的訊息那邊」。
  // 現在的做法是**交給貓說**（使用者自己指定的）—— 貓固定在右下角、浮在面板之上，
  // 不管捲到哪裡都看得見，所以誰都不用捲。
  test('**成功訊息要讓貓說出來**（它固定在畫面上，不必捲動）', async t => {
    const ui = await open(t, {
      suggestions: [suggestion()],
      onApply: body => ({
        results: body.items.map(i => ({ itemId: i.itemId, ok: true, name: 'x.txt', toFolder: 'y', to: 'x.txt', why: '' })),
        remaining: 0,
      }),
    })
    const [first] = boxes(ui)
    first.checked = true
    await first.onchange()
    await ui.click('cleanup-file')
    assert.match(ui.$('quaso-status').textContent, /Filed 1/, '貓沒有把結果說出來')
    assert.equal(ui.$('quaso-dialog').hidden, false, '泡泡要打開，不然那句話沒人看得到')
    // 面板裡那一塊照樣留著當紀錄
    assert.match(ui.$('cleanup-result').textContent, /Filed 1/)
  })

  // 使用者 2026-09-22：「不然每次點一個 file 他就會無限往下跳到成功的訊息那邊」
  test('**不可以自己捲動畫面**', async t => {
    const ui = await open(t, {
      suggestions: [suggestion()],
      onApply: body => ({
        results: body.items.map(i => ({ itemId: i.itemId, ok: true, name: 'x.txt', toFolder: 'y', to: 'x.txt', why: '' })),
        remaining: 0,
      }),
    })
    const box = ui.$('cleanup-result')
    const scrolled = []
    box.scrollIntoView = opts => scrolled.push(opts)
    const [first] = boxes(ui)
    first.checked = true
    await first.onchange()
    await ui.click('cleanup-file')
    assert.deepEqual(scrolled, [], '按一個檔就把整頁捲到最底下')
  })

  test('貓說的那一句要標成 ask，輪詢才不會馬上蓋掉它', async t => {
    const ui = await open(t, {
      suggestions: [suggestion()],
      onApply: body => ({
        results: body.items.map(i => ({ itemId: i.itemId, ok: true, name: 'x.txt', toFolder: 'y', to: 'x.txt', why: '' })),
        remaining: 0,
      }),
    })
    const [first] = boxes(ui)
    first.checked = true
    await first.onchange()
    await ui.click('cleanup-file')
    assert.equal(ui.$('quaso-status').dataset.ask, '1')
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
    assert.match(ui.$('cleanup-result').textContent, /Moved 1 back/)
    assert.equal(ui.$('cleanup-file-undo').hidden, true, '復原過就沒有東西要復原了')
  })

  test('後端說某一個沒搬成：畫面要講出來，不可以只說「整理好 0 個」', async t => {
    const ui = await open(t, {
      suggestions: [suggestion()],
      onApply: () => ({
        results: [{ itemId: 'it-1', ok: false, name: '未命名文件 (3).txt', toFolder: '', to: '', why: 'The filed folder is on another disk, which this version cannot move to.' }],
        remaining: 0,
      }),
    })
    const [first] = boxes(ui)
    first.checked = true
    await first.onchange()
    await ui.click('cleanup-file')
    assert.match(ui.$('cleanup-result').textContent, /another disk/)
    assert.equal(ui.$('cleanup-file-undo').hidden, true, 'Nothing moved this time，沒有東西要復原')
  })

  test('整理的請求失敗：只講原因，不假裝成功', async t => {
    const ui = await open(t, {
      suggestions: [suggestion()],
      onApply: () => { const e = new Error('Read-only mode is on, so no file gets moved.'); e.status = 403; throw e },
    })
    const [first] = boxes(ui)
    first.checked = true
    await first.onchange()
    await ui.click('cleanup-file')
    assert.match(ui.$('cleanup-result').textContent, /Read-only mode/)
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
    assert.ok(!ui.$('cleanup-list').textContent.includes('Nothing to clean up right now'), ui.$('cleanup-list').textContent)
  })
})

// ═══ 一列一顆「File」（2026-09-20，使用者：不用滑到最下面）═══

const oneButtons = ui => rows(ui).map(r => r.all('BUTTON').find(b => b.textContent === 'File'))

describe('每一列自己的「File」', () => {
  const two = () => [
    suggestion(),
    suggestion({ itemId: 'it-2', name: 'IMG_2041.txt', course: '資料結構', kind: 'Exam', toFolder: 'Courses/資料結構/Exam' }),
  ]
  const ok = body => ({
    results: body.items.map(i => ({
      itemId: i.itemId, ok: true, name: 'x.txt', toFolder: `Courses/${i.course}/${i.kind}`, to: 'x.txt', why: '',
    })),
    remaining: 0,
  })

  test('每一列都有一顆，而且不在 <label> 裡（點它不可以順便切掉勾選框）', async t => {
    const ui = await open(t, { suggestions: two() })
    assert.equal(oneButtons(ui).filter(Boolean).length, 2)
    for (const row of rows(ui)) {
      const label = row.all('LABEL')[0]
      assert.ok(!label.all('BUTTON').some(b => b.textContent === 'File'),
        '按鈕放進 label 裡，真瀏覽器點下去會連帶取消那一列的勾選')
    }
  })

  test('**只搬那一列**，別的都不動 —— 走的是同一條 /file/apply', async t => {
    const applied = []
    const ui = await open(t, { suggestions: two(), onApply: body => { applied.push(body); return ok(body) } })
    await oneButtons(ui)[1].onclick()
    assert.deepEqual(applied.flatMap(b => b.items.map(i => i.itemId)), ['it-2'])
    assert.equal(applied[0].items[0].course, '資料結構')
  })

  test('原本勾了別的：那幾個**不會被一起搬走**', async t => {
    const applied = []
    const ui = await open(t, { suggestions: two(), onApply: body => { applied.push(body); return ok(body) } })
    const [first] = boxes(ui)
    first.checked = true
    await first.onchange()
    await oneButtons(ui)[1].onclick()
    assert.deepEqual(applied.flatMap(b => b.items.map(i => i.itemId)), ['it-2'],
      '按第二列的按鈕，第一列勾著的檔不可以被一起搬走')
  })

  test('沒搬成（那一列還在）→ 原本的勾選放回去', async t => {
    const ui = await open(t, {
      suggestions: two(),
      onApply: body => ({ results: body.items.map(i => ({ itemId: i.itemId, ok: false, why: '那個資料夾裡已經有同名的檔。' })), remaining: 0 }),
    })
    const [first] = boxes(ui)
    first.checked = true
    await first.onchange()
    await oneButtons(ui)[1].onclick()
    assert.deepEqual(boxes(ui).map(b => b.checked), [true, false],
      '第一列的勾要還回去，第二列（剛剛失敗那個）不要自己勾著')
  })

  test('唯讀模式下按這一顆：一樣被擋，而且講得出原因', async t => {
    const ui = await open(t, {
      suggestions: two(),
      onApply: () => { const e = new Error('Read-only mode is on, so no file gets moved.'); e.status = 403; throw e },
    })
    await oneButtons(ui)[0].onclick()
    assert.match(ui.$('cleanup-result').textContent, /Read-only mode/)
  })
})
