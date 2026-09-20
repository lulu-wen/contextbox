import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * P6 ・ 面板的「看內容」那一顆按鈕（~/contextbox-預想-20260920-P6面板分頁與預覽.md）。
 *
 * 後端那一半在 test/preview-wire.test.mjs；這一支守的是**畫面這一半**：
 *
 * | 段落 | 可能的錯 | 另一種解讀 | 成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | 怎麼展開 | 彈一個視窗 | 同一列底下展開 | 點一列的「看內容」 | **同一列底下**（彈窗會蓋住勾選框，而他正是為了決定要不要勾才點的） |
 * | 什麼時候抓 | 一開面板就全抓 | 點了才抓 | 清單有 200 個檔 | **點了才抓** |
 * | 連點兩次 | 送兩次 | 用記住的 | 展開→收起→展開 | **只送一次** |
 * | 內容怎麼放上畫面 | innerHTML | textContent | 內容是 `<script>` | **textContent**，標籤原樣當字顯示 |
 * | 沒有內容的檔 | 一句「沒有」 | 分兩種說法 | `.exe` 與剛掃到的 `.txt` | **分兩種**：「沒有可以顯示的內容」與「還沒讀到」 |
 * | 示範模式 | 也給 | 不給 | 按 D | **不給**（那時候是假的清單，後端根本沒有那幾個檔） |
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountPanel } from './helpers/panel-dom.mjs'
import { previewLines, safeText, PREVIEW_TEXT_EXTS } from '../core/assets/cleanup-real-state.js'
import { TEXT_EXTS } from '../core/read-text.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const demoFetch = async url => String(url).includes('demo-candidates.json')
  ? new Response(readFileSync(join(REPO, 'core/assets/demo-candidates.json')), { status: 200 })
  : new Response('not found', { status: 404 })

const NUL = String.fromCharCode(0)
const RLO = String.fromCodePoint(0x202e)

const candidate = (over = {}) => ({
  itemId: 'it-1', name: '舊壓縮檔.zip', folder: 'Downloads', subdir: '',
  bytes: 2048, mtime: '2026-05-01T00:00:00.000Z', kind: 'archive', confidence: 65,
  defaultChecked: true, vetoed: null, candidateIds: ['c-1'], model: null,
  reasons: [{ kind: 'archive', confidence: 65, reason: '舊壓縮檔通常是一次性下載', evidence: '.zip 壓縮檔' }],
  ...over,
})

const view = (over = {}) => ({
  name: '舊壓縮檔.zip', ext: '.zip', bytes: 2048, mtime: '2026-05-01T00:00:00.000Z',
  kind: 'text', text: '一、排班準則\n二、先來先服務', truncated: false, image: null,
  why: '舊壓縮檔通常是一次性下載', ...over,
})

/** 一張夠小的 PNG（縮圖那條路只在意它回得出 Blob）。 */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108000000003a7e9b55'
  + '0000000a49444154789c6300010000050001', 'hex')

function fakeApi({ candidates = [], needsHuman = [], previews = {}, history = [], thumbFails = false, calls = [] } = {}) {
  return async (path, init = {}) => {
    calls.push({ path, method: init?.method ?? 'GET', blob: init?.blob === true })
    if (path === '/health') {
      return {
        ok: true, version: 'test', pendingCandidates: candidates.length, needsHumanCount: needsHuman.length,
        watcher: { ok: true, watching: ['Downloads'], watchingCount: 1, rootsMissing: 0, why: null },
        scanProblems: [],
      }
    }
    if (path === '/pet/state') return { state: 'idle', message: '沒事', burst: { groups: 0, newGroups: 0 } }
    if (path.startsWith('/cleanup/candidates')) {
      return { candidates, needsHuman, total: candidates.length, needsHumanTotal: needsHuman.length }
    }
    if (path.startsWith('/cleanup/plans?')) {
      return { total: history.length, offset: 0, limit: 20, operations: history }
    }
    if (path === '/cleanup/bursts') { const e = new Error('還沒做好'); e.status = 501; throw e }
    if (path.startsWith('/cleanup/thumb/')) {
      if (thumbFails) { const e = new Error('沒有這個檔可以看。'); e.status = 404; throw e }
      return new Blob([PNG], { type: 'image/png' })
    }
    if (path.startsWith('/cleanup/preview/')) {
      const id = decodeURIComponent(path.slice('/cleanup/preview/'.length))
      const got = previews[id]
      if (!got) { const e = new Error('沒有這個檔可以看。'); e.status = 404; e.code = 'NOT_FOUND'; throw e }
      return got
    }
    const e = new Error('假後端不認得 ' + path)
    e.status = 404
    throw e
  }
}

async function open(t, opts = {}) {
  const calls = []
  const ui = await mountPanel(t, { api: fakeApi({ ...opts, calls }), fetch: demoFetch })
  await ui.click('quaso-cleanup-alert')
  return { ...ui, apiCalls: calls }
}

const peeks = host => host.byClass('cleanup-peek')
const boxOf = host => host.byClass('cleanup-preview')[0] ?? null
const previewCalls = ui => ui.apiCalls.filter(c => c.path.startsWith('/cleanup/preview/'))

/** 點一顆按鈕，等它跑完（onclick 是 async 的，回傳的 promise 要 await）。 */
async function press(btn) {
  await btn.onclick()
  await new Promise(r => setTimeout(r, 10))
}

// ═══ 純函式 ═══════════════════════════════════════════════════

describe('previewLines', () => {
  test('後設資料那一行：大小、最後修改、副檔名', () => {
    const l = previewLines(view({ bytes: 2048 }))
    assert.match(l.meta, /^2\.0 KB · 最後修改 /)
    assert.ok(l.meta.endsWith('.zip'), l.meta)
  })

  test('為什麼被列出來一定要講；後端沒給就照實說，不編一個理由', () => {
    assert.equal(previewLines(view()).why, '為什麼列出來：舊壓縮檔通常是一次性下載')
    assert.equal(previewLines(view({ why: '   ' })).why, '為什麼列出來：（後端沒有說）')
  })

  test('**內容是不可信的輸入**：控制字元與方向字元換掉，換行留著', () => {
    const l = previewLines(view({ text: `第一行${NUL}${RLO}\n第二行` }))
    assert.ok(!l.text.includes(NUL) && !l.text.includes(RLO), JSON.stringify(l.text))
    assert.deepEqual(l.text.split('\n'), ['第一行··', '第二行'])
  })

  test('截斷了才講「還有更多」', () => {
    assert.equal(previewLines(view({ truncated: true })).truncated, true)
    assert.equal(previewLines(view({ truncated: false })).truncated, false)
    // 沒有文字的時候不可以說「還有更多」
    assert.equal(previewLines(view({ kind: 'none', text: null, truncated: true })).truncated, false)
  })

  test('**沒有內容要分兩種說法**：這種檔本來就沒有 vs 還沒讀到', () => {
    const exe = previewLines(view({ name: 'x.exe', ext: '.exe', kind: 'none', text: null }))
    assert.match(exe.empty, /沒有可以顯示的內容/)
    const txt = previewLines(view({ name: 'x.txt', ext: '.txt', kind: 'none', text: null }))
    assert.equal(txt.empty, '還沒讀到這個檔的內容。')
    // 有圖就不是「沒有內容」
    assert.equal(previewLines(view({ kind: 'image', text: null, image: '/cleanup/thumb/it-1' })).empty, null)
  })

  test('**會抽文字的副檔名那一份，跟 core/read-text.ts 是同一份**', () => {
    assert.deepEqual([...PREVIEW_TEXT_EXTS].sort(), [...TEXT_EXTS].sort())
  })

  test('image 只收 /cleanup/thumb/<id>：後端給別的一律當成沒有', () => {
    for (const bad of ['https://evil.example/x.png', '/cleanup/thumb/a?k=secret', '/health', 42, null]) {
      assert.equal(previewLines(view({ image: bad })).image, null, JSON.stringify(bad))
    }
    assert.equal(previewLines(view({ image: '/cleanup/thumb/it-1' })).image, '/cleanup/thumb/it-1')
  })

  test('看不懂的回 null（舊版後端、形狀變了都不可以讓面板壞掉）', () => {
    assert.equal(previewLines(null), null)
    assert.equal(previewLines('x'), null)
  })

  test('safeText：換行與 tab 留著，其餘控制字元一個換一個', () => {
    const TAB = String.fromCharCode(9)
    assert.equal(safeText(`a${NUL}b`), 'a·b')
    assert.equal(safeText(`a\nb${TAB}c`), `a\nb${TAB}c`)
    assert.equal(safeText('a\r\nb\rc'), 'a\nb\nc')
    assert.equal(safeText('乾淨的字'), '乾淨的字')
  })
})

// ═══ 面板 ═════════════════════════════════════════════════════

describe('面板的「看內容」', () => {
  test('**每一列都有一顆，而且一打開面板一個請求都不送**（點了才抓）', async t => {
    const ui = await open(t, {
      candidates: [candidate(), candidate({ itemId: 'it-2', name: '安裝檔.exe', candidateIds: ['c-2'] })],
      previews: { 'it-1': view() },
    })
    assert.equal(peeks(ui.$('cleanup-list')).length, 2)
    assert.deepEqual(previewCalls(ui), [], '一開面板就全抓的話，200 個檔就是 200 個請求')
    for (const b of peeks(ui.$('cleanup-list'))) assert.equal(b.textContent, '看內容')
  })

  test('**點開在同一列底下展開**（不是彈窗），再點收起', async t => {
    const ui = await open(t, { candidates: [candidate()], previews: { 'it-1': view() } })
    const card = ui.$('cleanup-list').all('ARTICLE')[0]
    assert.equal(boxOf(card), null)
    await press(peeks(card)[0])
    const after = ui.$('cleanup-list').all('ARTICLE')[0]
    assert.ok(boxOf(after), '展開的內容要在那一列裡面')
    assert.equal(peeks(after)[0].textContent, '收起')
    assert.equal(peeks(after)[0].getAttribute('aria-expanded'), 'true')
    // 面板本身還是那個面板，沒有多開一個彈窗
    assert.equal(ui.$('cleanup-panel').open, true)
    await press(peeks(after)[0])
    const closed = ui.$('cleanup-list').all('ARTICLE')[0]
    assert.equal(boxOf(closed), null)
    assert.equal(peeks(closed)[0].textContent, '看內容')
  })

  test('P6-12 **同一個檔連點兩次只送一次請求**（第二次用記住的）', async t => {
    const ui = await open(t, { candidates: [candidate()], previews: { 'it-1': view() } })
    const find = () => peeks(ui.$('cleanup-list').all('ARTICLE')[0])[0]
    await press(find())          // 展開
    await press(find())          // 收起
    await press(find())          // 再展開
    assert.deepEqual(previewCalls(ui).map(c => c.path), ['/cleanup/preview/it-1'])
    assert.ok(boxOf(ui.$('cleanup-list').all('ARTICLE')[0]), '第二次展開照樣看得到內容')
  })

  test('P6-1／P6-7 **內容是純文字**：標籤原樣當字顯示，方向字元不見了', async t => {
    const ui = await open(t, {
      candidates: [candidate()],
      previews: { 'it-1': view({ text: `<script>alert(1)</script>\nfdp${RLO}exe` }) },
    })
    await press(peeks(ui.$('cleanup-list').all('ARTICLE')[0])[0])
    const box = boxOf(ui.$('cleanup-list').all('ARTICLE')[0])
    const pre = box.all('PRE')
    assert.equal(pre.length, 1, '內容要放在自己一個框裡')
    assert.equal(pre[0].className, 'cleanup-preview-text')
    assert.ok(pre[0].textContent.includes('<script>alert(1)</script>'), pre[0].textContent)
    assert.ok(!pre[0].textContent.includes(RLO), JSON.stringify(pre[0].textContent))
    // 後設資料與「為什麼列出來」也在
    assert.match(box.textContent, /最後修改/)
    assert.match(box.textContent, /為什麼列出來：/)
  })

  test('P6-8 截斷了要講「還有更多」；沒截斷就不要講', async t => {
    const ui = await open(t, { candidates: [candidate()], previews: { 'it-1': view({ truncated: true }) } })
    await press(peeks(ui.$('cleanup-list').all('ARTICLE')[0])[0])
    assert.match(boxOf(ui.$('cleanup-list').all('ARTICLE')[0]).textContent, /還有更多/)

    const ui2 = await open(t, { candidates: [candidate()], previews: { 'it-1': view({ truncated: false }) } })
    await press(peeks(ui2.$('cleanup-list').all('ARTICLE')[0])[0])
    assert.ok(!boxOf(ui2.$('cleanup-list').all('ARTICLE')[0]).textContent.includes('還有更多'))
  })

  test('P6-3 沒有內容的檔：看得到大小、最後修改、為什麼被列出來', async t => {
    const ui = await open(t, {
      candidates: [candidate({ name: 'Node-v24-安裝檔.exe' })],
      previews: {
        'it-1': view({
          name: 'Node-v24-安裝檔.exe', ext: '.exe', bytes: 52428800, kind: 'none', text: null,
          why: '舊安裝檔通常裝完就不需要留在 Downloads',
        }),
      },
    })
    await press(peeks(ui.$('cleanup-list').all('ARTICLE')[0])[0])
    const text = boxOf(ui.$('cleanup-list').all('ARTICLE')[0]).textContent
    assert.match(text, /50\.0 MB/)
    assert.match(text, /最後修改/)
    assert.match(text, /為什麼列出來：舊安裝檔/)
    assert.match(text, /沒有可以顯示的內容/)
  })

  test('P6-4 還沒讀到的檔說「還沒讀到」，**而且面板不會自己再去要一次**', async t => {
    const ui = await open(t, {
      candidates: [candidate({ name: '剛掃到.txt' })],
      previews: { 'it-1': view({ name: '剛掃到.txt', ext: '.txt', kind: 'none', text: null }) },
    })
    const find = () => peeks(ui.$('cleanup-list').all('ARTICLE')[0])[0]
    await press(find())
    assert.match(boxOf(ui.$('cleanup-list').all('ARTICLE')[0]).textContent, /還沒讀到這個檔的內容/)
    await press(find())
    await press(find())
    assert.equal(previewCalls(ui).length, 1, '「還沒讀到」也是一個答案，不可以每次點都再問一次')
  })

  test('P6-2 有圖的：用帶 token 的 api 取回 blob，**token 不進網址**', async t => {
    const ui = await open(t, {
      candidates: [candidate({ name: 'Screenshot 1.png' })],
      previews: { 'it-1': view({ ext: '.png', kind: 'image', text: null, image: '/cleanup/thumb/it-1' }) },
    })
    await press(peeks(ui.$('cleanup-list').all('ARTICLE')[0])[0])
    const img = boxOf(ui.$('cleanup-list').all('ARTICLE')[0]).all('IMG')
    assert.equal(img.length, 1)
    assert.match(String(img[0].src), /^blob:/, img[0].src)
    const thumb = ui.apiCalls.filter(c => c.path.startsWith('/cleanup/thumb/'))
    assert.deepEqual(thumb.map(c => c.path), ['/cleanup/thumb/it-1'])
    assert.equal(thumb[0].blob, true, '縮圖要走 blob 那條分支')
    assert.ok(!thumb[0].path.includes('k='), '網址上不可以有鑰匙')
  })

  test('後端說看不到（404）：只講一句，不假裝有內容，而且下次還能再試', async t => {
    const ui = await open(t, { candidates: [candidate()], previews: {} })
    const find = () => peeks(ui.$('cleanup-list').all('ARTICLE')[0])[0]
    await press(find())
    const box = boxOf(ui.$('cleanup-list').all('ARTICLE')[0])
    assert.match(box.textContent, /沒有這個檔可以看/)
    assert.equal(box.all('PRE').length, 0)
    await press(find())   // 收起
    await press(find())   // 再展開 —— 失敗的不記，所以會再問一次
    assert.equal(previewCalls(ui).length, 2, '一時讀不到的下次要能再試')
  })

  test('「需要你查看」那幾列也有「看內容」（那一區最需要：太大、讀不到的檔更不記得是什麼）', async t => {
    const ui = await open(t, {
      candidates: [],
      needsHuman: [{ itemId: 'nh-1', name: '大備份.bin', folder: 'Downloads', bytes: 9e9, why: '檔案太大' }],
      previews: { 'nh-1': view({ name: '大備份.bin', ext: '.bin', kind: 'none', text: null, why: '檔案太大' }) },
    })
    const host = ui.$('cleanup-needs-human')
    // 原本那一句話照舊（U5 守的是這一段不可以帶控制字元）
    assert.match(host.all('P')[0].textContent, /需要你查看：大備份\.bin — 檔案太大（未列入清理）/)
    assert.equal(peeks(host).length, 1)
    await press(peeks(host)[0])
    assert.match(boxOf(host).textContent, /為什麼列出來：檔案太大/)
  })

  test('示範模式沒有「看內容」（那時候是假的清單，後端根本沒有那幾個檔）', async t => {
    const ui = await open(t, { candidates: [candidate()], previews: { 'it-1': view() } })
    assert.equal(peeks(ui.$('cleanup-list')).length, 1)
    ui.$('cleanup-panel').close()
    await ui.key('d')
    for (let i = 0; i < 100 && ui.$('quaso-candidate-count').textContent !== '4'; i++) {
      await new Promise(r => setTimeout(r, 10))
    }
    await ui.click('quaso-cleanup-alert')
    assert.ok(ui.$('cleanup-list').all('ARTICLE').length > 0, '前提：示範清單真的畫出來了')
    assert.equal(peeks(ui.$('cleanup-list')).length, 0)
  })
})

// ═══ 檔案管理那一塊的入口 ═════════════════════════════════════

describe('檔案管理那一塊（P6 的分頁）', () => {
  test('**兩顆按鈕開的是同兩個面板**，數字與「在看哪些資料夾」跟徽章同一份資料', async t => {
    const calls = []
    const ui = await mountPanel(t, {
      api: fakeApi({ candidates: [candidate(), candidate({ itemId: 'it-2' })], calls }), fetch: demoFetch,
    })
    for (let i = 0; i < 100 && ui.$('files-candidate-count').textContent === '正在看……'; i++) {
      await new Promise(r => setTimeout(r, 10))
    }
    assert.equal(ui.$('files-candidate-count').textContent, '2 個')
    assert.match(ui.$('files-where').textContent, /Downloads/)

    await ui.$('files-open-cleanup').onclick()
    await ui.idle()
    assert.equal(ui.$('cleanup-panel').open, true)
    ui.$('cleanup-panel').close()

    await ui.$('files-open-history').onclick()
    await ui.idle()
    assert.equal(ui.$('cleanup-history-panel').open, true)
    ui.$('cleanup-history-panel').close()
  })
})

// ═══ 稽核補的（2026-09-20）═══════════════════════════════════

describe('稽核 ・ 隔離區裡的檔也要看得到內容', () => {
  test('復原面板的每一個檔各有一顆「看內容」—— 那是清完之後唯一列得到它的地方', async t => {
    const ui = await open(t, {
      previews: { 'q-1': view({ name: '舊報告.pdf', text: '第三季營收' }) },
      history: [{
        id: 'plan-1', createdAt: new Date().toISOString(), itemCount: 2, bytes: 4096, canUndo: true,
        items: [{ itemId: 'q-1', name: '舊報告.pdf' }, { itemId: 'q-2', name: '安裝檔.exe' }],
      }],
    })
    await ui.$('files-open-history').onclick()
    await new Promise(r => setTimeout(r, 10))
    const list = ui.$('cleanup-history-list')
    assert.equal(peeks(list).length, 2, '一個檔一顆，不是整批一顆')

    await press(peeks(list)[0])
    const box = boxOf(ui.$('cleanup-history-list'))
    assert.ok(box, '展開的內容要在那一列裡')
    assert.match(box.textContent, /第三季營收/)
  })
})

describe('稽核 ・ 圖抓不回來的時候要講一句', () => {
  test('後端說有圖但縮圖 404 → 不可以只留一個空框', async t => {
    const ui = await open(t, {
      candidates: [candidate()],
      previews: { 'it-1': view({ kind: 'image', text: null, image: '/cleanup/thumb/it-1' }) },
      // 掃完之後檔被刪掉、或檔換過使磁碟核對失敗，縮圖那一條就會 404
      thumbFails: true,
    })
    await press(peeks(ui.$('cleanup-list'))[0])
    const box = boxOf(ui.$('cleanup-list').all('ARTICLE')[0])
    assert.ok(box, '框要在')
    assert.match(box.textContent, /這張圖現在看不到/)
  })
})
