import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * P0 連拍截圖 —— 面板與寵物那一半（主動詢問、連拍區、縮圖、外框）。
 *
 * 期望值抄自 `~/contextbox-預想-20260919-P0接線.md` 的 Step 1 表與「預期行為」，
 * **在實作之前寫死**。這一份只驗畫面這一側；指紋、分組、候選那一側在 core 那一組。
 *
 * ── 這一半要釘住的格子（Step 1 表）────────────────────────────────
 *
 * | 段落 | 可能的錯誤 | 另一種合理解讀 | 能分辨兩者的例子（成對） | 認定的答案 |
 * |---|---|---|---|---|
 * | 主動詢問的時機 | 每次掃描都問 | 有**新的**組才問 | 同一組問過、使用者沒理它／又出現一組 | `newGroups` 沒變大就不彈；變大才彈。舊的組還在連拍區裡 |
 * | 預設勾 | 一律照後端的 defaultChecked | `same` 才勾 | 後端把 similar 的 defaultChecked 給成 true／給成 false | 兩種都**不勾**：面板自己再擋一次，只往「不勾」的方向動 |
 * | similar 的提醒 | 只有不勾 | 不勾**而且**講一句 | similar 一組／same 一組 | similar 那一組要有「這一組有看得見的變化，自己看一眼再決定」 |
 * | 外框座標 | 縮圖的像素座標 | 0–1 的相對值換百分比 | `{x:.25,y:.5,w:.1,h:.2}` | `left:25%;top:50%;width:10%;height:20%` |
 * | 縮圖怎麼拿 | `<img src="/cleanup/thumb/<id>?k=token">` | api 取回 blob 再 createObjectURL | 看送出去的網址與 `<img>` 的 src | 網址上**沒有** token（token 在 header）；`src` 是 `blob:` |
 * | 留下的那張 | 也給一個勾選框 | 只標「留著」 | 三張一組 | 只有兩個勾選框；留下的那張標「留著」、沒有勾選框 |
 * | 沒有連拍組 | 空的區塊留在畫面上 | 整區不顯示 | 後端回 `{ groups: [] }` | `#cleanup-bursts` hidden |
 * | 舊版後端 | 面板整個壞掉 | 當成沒有連拍組 | `/cleanup/bursts` 回 501 | 候選清單照常列，連拍區 hidden |
 * | 清理走哪條路 | 連拍區自己一條 | 跟候選清單同一條 | 勾一個成員按清理 | 送 `POST /cleanup/plans` 帶那個成員的 candidateIds，檔真的搬走 |
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync, realpathSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start } from '../core/server.ts'
import { mountPanel, uiApi } from './helpers/panel-dom.mjs'
import { rmTmp } from './helpers/rm.mjs'
import {
  normalizeBurstGroups, burstAskMessage, burstGroupLine, burstNote, applyBurstDefaults,
  createBursts, BURST_SIMILAR_NOTE,
} from '../core/assets/cleanup-real-state.js'

const DAY = 86400_000
const TOKEN = 'burst-ui-token'
// **在任何一次掛載之前抓住真的 fetch** —— mountPanel 會換掉 globalThis.fetch
const realFetch = globalThis.fetch
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13])
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 頁面的 fetch：只給示範模式那一份範例（按 D 會讀它）。 */
const demoFetch = async url => {
  if (String(url).includes('demo-candidates.json')) {
    return new Response(readFileSync(join(REPO, 'core/assets/demo-candidates.json')), { status: 200 })
  }
  throw new TypeError('Failed to fetch')
}

// ── 假的後端 ────────────────────────────────────────────────

/** 一列候選（形狀照 GET /cleanup/candidates）。 */
function candidate(itemId, name, extra = {}) {
  return {
    itemId, name, folder: 'Downloads', subdir: '', bytes: 2048, mtime: new Date().toISOString(),
    kind: 'screenshot-noise', confidence: 40, defaultChecked: false, vetoed: null,
    candidateIds: [itemId + '-c1'],
    reasons: [{ kind: 'screenshot-noise', confidence: 40, reason: 'one burstBursts', evidence: '會Keeping“keep.png”' }],
    ...extra,
  }
}

/** 一張（keep 或 member）。 */
function shot(itemId, name, extra = {}) {
  return { itemId, name, bytes: 2048, thumb: `/cleanup/thumb/${itemId}`, ...extra }
}

/**
 * 假的 window.api。`bursts` 給 null 代表舊版後端（501）。
 * `pet` 是可變的：測試中途改它，下一次輪詢就看得到。
 */
function fakeApi({ candidates = [], bursts = null, pet = {}, thumbFail = new Set() } = {}) {
  const calls = []
  const api = async (path, init = {}) => {
    calls.push({ path, method: init.method ?? 'GET', blob: Boolean(init.blob) })
    if (path === '/health') {
      return {
        ok: true, version: 'test', pendingCandidates: candidates.length, needsHumanCount: 0,
        watcher: { ok: true, watching: ['Downloads'], watchingCount: 1, rootsMissing: 0, why: null },
        scanProblems: [],
      }
    }
    if (path === '/pet/state') {
      return { state: 'found', message: '有幾個檔可以清', pendingCount: candidates.length, quarantinedCount: 0, undoable: false, ...pet }
    }
    if (path.startsWith('/cleanup/candidates')) return { candidates, needsHuman: [], total: candidates.length }
    if (path.startsWith('/cleanup/plans?')) return { total: 0, offset: 0, limit: 1, operations: [] }
    if (path === '/cleanup/bursts') {
      if (!bursts) { const e = new Error('這個功能還沒做好。'); e.code = 'NOT_IMPLEMENTED'; e.status = 501; throw e }
      return bursts
    }
    if (path.startsWith('/cleanup/thumb/')) {
      const id = decodeURIComponent(path.slice('/cleanup/thumb/'.length))
      if (thumbFail.has(id)) { const e = new Error('讀不到'); e.status = 500; throw e }
      return new Blob([PNG], { type: 'image/png' })
    }
    const e = new Error('假後端不認得 ' + path)
    e.status = 404
    throw e
  }
  return { api, calls, pet }
}

const rowsOf = ui => ui.$('cleanup-bursts').all('article')
const shotsOf = row => row.byClass('cleanup-shot')
const boxesOf = cell => cell.byClass('cleanup-shot-box').map(b => b.getAttribute('style'))
const listNames = ui => ui.$('cleanup-list').all('article').map(c => c.all('strong')[0]?.textContent)

/** 面板上（連拍區）的勾選框與它的檔名 */
function burstChecks(ui) {
  return rowsOf(ui).flatMap(row => shotsOf(row).flatMap(cell => {
    const input = cell.all('input')[0]
    return input ? [{ input, name: cell.all('strong')[0]?.textContent }] : []
  }))
}

// ═══ A ・ 資料整形與台詞（純函式）═══════════════════════════

describe('A 連拍組的整形', () => {
  const group = (over = {}) => ({
    id: 'g1', level: 'similar', keep: shot('k', 'keep.png'),
    members: [shot('m1', 'a.png', { level: 'similar', boxes: [{ x: 0.25, y: 0.5, w: 0.1, h: 0.2 }] })],
    ...over,
  })

  test('照後端給的樣子整好：level、boxes、thumb 都在', () => {
    const [g] = normalizeBurstGroups([group()])
    assert.equal(g.level, 'similar')
    assert.equal(g.keep.name, 'keep.png')
    assert.deepEqual(g.members[0].boxes, [{ x: 0.25, y: 0.5, w: 0.1, h: 0.2 }])
    assert.equal(g.members[0].thumb, '/cleanup/thumb/m1')
  })

  test('**認不得的 level 一律當 similar**（偏保守：不會變成預設勾）', () => {
    const [g] = normalizeBurstGroups([group({ level: 'identical' })])
    assert.equal(g.level, 'similar')
  })

  test('**留下的那張不可以同時是成員**（後端給錯也不列成候選）', () => {
    const [g] = normalizeBurstGroups([group({
      members: [shot('k', 'keep.png', { level: 'same' }), shot('m1', 'a.png', { level: 'same' })],
    })])
    assert.deepEqual(g.members.map(m => m.itemId), ['m1'])
  })

  test('只剩一張（沒有成員）不成組', () => {
    assert.deepEqual(normalizeBurstGroups([group({ members: [] })]), [])
    assert.deepEqual(normalizeBurstGroups([group({ members: [shot('k', 'keep.png')] })]), [])
  })

  test('**thumb 只收 /cleanup/thumb/<id>**：後端給別的路徑一律改回來', () => {
    for (const bad of ['https://evil.example/x.png', '/cleanup/thumb/m1?k=secret', '/health', 42, null]) {
      const [g] = normalizeBurstGroups([group({ members: [shot('m1', 'a.png', { thumb: bad })] })])
      assert.equal(g.members[0].thumb, '/cleanup/thumb/m1', `thumb=${JSON.stringify(bad)}`)
    }
  })

  test('boxes 是 0–1：超出去的夾回邊界，夾完沒有面積的丟掉，壞掉的丟掉', () => {
    const [g] = normalizeBurstGroups([group({
      members: [shot('m1', 'a.png', { boxes: [
        { x: 0.9, y: 0.9, w: 0.5, h: 0.5 },      // 超出右下 → 切到邊上
        { x: -1, y: 0.2, w: 0.3, h: 0.3 },       // 負的 → 夾成 0
        { x: 1, y: 0, w: 0.2, h: 0.2 },          // 貼右邊界 → 沒有寬度，丟掉
        { x: 'x', y: 0, w: 0.2, h: 0.2 },        // 壞掉，丟掉
      ] })],
    })])
    assert.deepEqual(g.members[0].boxes, [
      { x: 0.9, y: 0.9, w: 0.1, h: 0.1 },
      { x: 0, y: 0.2, w: 0.3, h: 0.3 },
    ])
  })

  test('後端回的不是陣列（舊版、壞掉）→ 空陣列，不丟例外', () => {
    for (const bad of [undefined, null, 'x', {}, [null], [{}]]) {
      assert.deepEqual(normalizeBurstGroups(bad), [], JSON.stringify(bad))
    }
  })
})

describe('A 主動詢問要講的話', () => {
  const g = (n, over = {}) => ({
    id: 'g' + n, level: 'similar', keep: shot('k' + n, 'keep.png'),
    members: Array.from({ length: n }, (_, i) => shot(`m${n}-${i}`, `a${i}.png`)),
    ...over,
  })

  test('一組：講**張數**（留下的那張也算一張）', () => {
    assert.equal(burstAskMessage(normalizeBurstGroups([g(2)])), 'These 3 screenshots look like one burst. Keep only the newest?')
  })

  test('兩組：講組數與總張數', () => {
    assert.equal(burstAskMessage(normalizeBurstGroups([g(1), g(2)])),
      '2 groups of screenshots look like bursts (5 shots in all). Keep only the newest of each?')
  })

  test('沒有組就沒有話講（不可以彈一句空的）', () => {
    assert.equal(burstAskMessage([]), null)
    assert.equal(burstAskMessage(null), null)
  })

  test('那一組的標題講「會留著哪一張」，檔名走 safeName', () => {
    const [one] = normalizeBurstGroups([{ ...g(2), keep: shot('k', 'a\nb.png') }])
    assert.equal(burstGroupLine(one), '3 shots look like one burst · keeping “a·b.png” (the newest)')
  })

  // 「這幾張是同一批」是一句**關於時間**的主張。以前畫面上只有縮圖與檔名，
  // 使用者沒有辦法檢查那句話對不對（2026-09-21 實機回報）。
  test('有秒數時標題要講「前後跨了多久」', () => {
    const [one] = normalizeBurstGroups([{ ...g(2), spanSec: 7 }])
    assert.equal(one.spanSec, 7)
    assert.equal(burstGroupLine(one),
      '3 shots look like one burst · taken within 7s · keeping “keep.png” (the newest)')
  })

  test('60 秒以上改用分鐘、3600 秒以上改用小時（連拍不該用「5400s」講）', () => {
    const line = sec => burstGroupLine(normalizeBurstGroups([{ ...g(2), spanSec: sec }])[0])
    assert.match(line(59), /taken within 59s ·/)
    assert.match(line(90), /taken within 2 min ·/)
    assert.match(line(5400), /taken within 2 hr ·/)
  })

  // 舊版後端沒有這一欄，壞掉的值也不可以讓標題長出一句半截的話。
  test('沒給秒數／給了壞值 → 整段不提時間，不猜', () => {
    for (const bad of [undefined, null, 0, -5, 'x', NaN]) {
      const [one] = normalizeBurstGroups([{ ...g(2), spanSec: bad }])
      assert.equal(one.spanSec, 0, JSON.stringify(bad))
      assert.ok(!burstGroupLine(one).includes('taken within'), JSON.stringify(bad))
    }
  })

  test('**similar 那一句照抄**；same 是另一句', () => {
    assert.equal(burstNote('similar'), 'This group has visible differences. Take a look before you decide.')
    assert.equal(BURST_SIMILAR_NOTE, 'This group has visible differences. Take a look before you decide.')
    assert.notEqual(burstNote('same'), burstNote('similar'))
  })
})

describe('A **similar 預設不勾**（面板自己再擋一次）', () => {
  function fakeState(ids) {
    const selected = new Set(ids)
    return { selected, select: (id, on) => (on ? selected.add(id) : selected.delete(id)) }
  }

  test('後端把 similar 的 defaultChecked 給成 true → 面板照樣不勾', () => {
    const groups = normalizeBurstGroups([{
      id: 'g', level: 'similar', keep: shot('k', 'keep.png'),
      members: [shot('m1', 'a.png', { level: 'similar' }), shot('m2', 'b.png', { level: 'similar' })],
    }])
    const s = fakeState(['m1', 'm2'])
    assert.deepEqual(applyBurstDefaults(s, groups).sort(), ['m1', 'm2'])
    assert.deepEqual([...s.selected], [])
  })

  test('對照：same 的不動（勾著就是勾著）—— 只往「不勾」的方向動', () => {
    const groups = normalizeBurstGroups([{
      id: 'g', level: 'same', keep: shot('k', 'keep.png'),
      members: [shot('m1', 'a.png', { level: 'same' })],
    }])
    const s = fakeState(['m1'])
    assert.deepEqual(applyBurstDefaults(s, groups), [])
    assert.deepEqual([...s.selected], ['m1'])
  })

  test('**同一組裡的 same 成員不動、similar 成員取消**（看成員自己的等級，不是整組的）', () => {
    const groups = normalizeBurstGroups([{
      id: 'g', level: 'similar', keep: shot('k', 'keep.png'),
      members: [shot('m1', 'a.png', { level: 'same' }), shot('m2', 'b.png', { level: 'similar' })],
    }])
    const s = fakeState(['m1', 'm2'])
    assert.deepEqual(applyBurstDefaults(s, groups), ['m2'])
    assert.deepEqual([...s.selected], ['m1'])
  })

  test('本來就沒勾的不會被算進「取消了哪些」', () => {
    const groups = normalizeBurstGroups([{
      id: 'g', level: 'similar', keep: shot('k', 'keep.png'), members: [shot('m1', 'a.png')],
    }])
    assert.deepEqual(applyBurstDefaults(fakeState([]), groups), [])
  })
})

describe('A 縮圖：token 在 header，不在網址上', () => {
  const oneGroup = { groups: [{ id: 'g', level: 'same', keep: shot('k', 'keep.png'), members: [shot('m1', 'a.png')] }] }

  test('**送出去的路徑就是 /cleanup/thumb/<id>**，而且是 blob 那條分支', async () => {
    const { api, calls } = fakeApi({ bursts: oneGroup })
    let made = 0
    const b = createBursts(api, { createUrl: () => 'blob:fake-' + (++made), revokeUrl: () => {} })
    await b.load()
    const thumbCalls = calls.filter(c => c.path.startsWith('/cleanup/thumb/'))
    assert.deepEqual(thumbCalls.map(c => c.path), ['/cleanup/thumb/k', '/cleanup/thumb/m1'])
    assert.ok(thumbCalls.every(c => c.blob), '縮圖要走 blob 分支，不可以當 JSON 解')
    assert.ok(thumbCalls.every(c => !/token|[?&]k=/.test(c.path)), 'token 不可以進網址：' + JSON.stringify(thumbCalls))
    assert.equal(b.thumb('m1'), 'blob:fake-2')
  })

  test('一張讀不到只是那一張沒有圖，其他張照常', async () => {
    const { api } = fakeApi({ bursts: oneGroup, thumbFail: new Set(['m1']) })
    const b = createBursts(api, { createUrl: () => 'blob:x', revokeUrl: () => {} })
    await b.load()
    assert.equal(b.thumb('m1'), null)
    assert.equal(b.thumb('k'), 'blob:x')
  })

  test('**換一批就把上一批的 blob: 網址還回去**（開著面板不會愈積愈多）', async () => {
    const { api } = fakeApi({ bursts: oneGroup })
    const revoked = []
    let n = 0
    const b = createBursts(api, { createUrl: () => 'blob:' + (++n), revokeUrl: u => revoked.push(u) })
    await b.load()
    await b.load()
    assert.deepEqual(revoked, ['blob:1', 'blob:2'])
    assert.equal(b.thumb('k'), 'blob:3', '新的一批是新的網址')
  })

  test('舊版後端（/cleanup/bursts 501）→ 沒有組，不丟例外', async () => {
    const { api } = fakeApi({ bursts: null })
    const b = createBursts(api, { createUrl: () => 'blob:x', revokeUrl: () => {} })
    assert.deepEqual(await b.load(), [])
    assert.deepEqual(b.groups, [])
  })
})

// ═══ B ・ 假的 api ＋ 假 DOM（真的 cleanup-demo.js）═════════

/** 一組 similar（兩個成員、第一個成員有一個外框）＋對應的候選。 */
function similarFixture() {
  const candidates = [
    candidate('m1', '截圖 1.png'),
    candidate('m2', '截圖 2.png'),
    candidate('z1', '很久沒動.zip', { kind: 'old-download', confidence: 35, candidateIds: ['z1-c1'] }),
  ]
  const bursts = {
    groups: [{
      id: 'g1', level: 'similar', keep: shot('k1', '截圖 3.png'),
      members: [
        shot('m1', '截圖 1.png', { level: 'similar', boxes: [{ x: 0.25, y: 0.5, w: 0.1, h: 0.2 }] }),
        shot('m2', '截圖 2.png', { level: 'similar', boxes: [] }),
      ],
    }],
  }
  return { candidates, bursts }
}

describe('B 連拍區（假的 api、真的面板）', () => {
  async function open(t, opts, mount = {}) {
    const f = fakeApi(opts)
    const ui = await mountPanel(t, { api: f.api, ...mount })
    await ui.click('quaso-cleanup-alert')
    return { ui, f }
  }

  test('**每一組一列，並排顯示縮圖；留下的那張標「留著」、沒有勾選框**', async t => {
    const { ui } = await open(t, similarFixture())
    const rows = rowsOf(ui)
    assert.equal(rows.length, 1, '一組一列')
    const cells = shotsOf(rows[0])
    assert.equal(cells.length, 3, '三張並排（留下的那張也要看得到）')
    assert.match(rows[0].textContent, /3 shots look like one burst · keeping “截圖 3\.png” \(the newest\)/)
    assert.match(cells[0].textContent, /Keeping/)
    assert.equal(cells[0].all('input').length, 0, '留下的那張不可以有勾選框')
    assert.deepEqual(burstChecks(ui).map(c => c.name), ['截圖 1.png', '截圖 2.png'])
  })

  test('**similar 預設不勾，而且要講那一句**', async t => {
    const { ui } = await open(t, similarFixture())
    assert.deepEqual(burstChecks(ui).map(c => c.input.checked), [false, false])
    assert.match(rowsOf(ui)[0].textContent, /This group has visible differences. Take a look before you decide./)
  })

  test('**後端把 similar 的 defaultChecked 給成 true，面板照樣不勾**（成對）', async t => {
    const fx = similarFixture()
    for (const c of fx.candidates) if (c.itemId.startsWith('m')) c.defaultChecked = true
    const { ui } = await open(t, fx)
    assert.deepEqual(burstChecks(ui).map(c => c.input.checked), [false, false])
    assert.equal(ui.$('cleanup-summary').textContent.startsWith('0 of '), true, ui.$('cleanup-summary').textContent)
  })

  test('對照：same 的照後端的預設勾起來，也不講那一句', async t => {
    const fx = similarFixture()
    fx.bursts.groups[0].level = 'same'
    for (const m of fx.bursts.groups[0].members) { m.level = 'same'; m.boxes = [] }
    for (const c of fx.candidates) if (c.itemId.startsWith('m')) { c.defaultChecked = true; c.confidence = 70 }
    const { ui } = await open(t, fx)
    assert.deepEqual(burstChecks(ui).map(c => c.input.checked), [true, true])
    assert.doesNotMatch(rowsOf(ui)[0].textContent, /自己看一眼再決定/)
  })

  test('**外框畫在對的位置**：0–1 的相對座標換成百分比', async t => {
    const { ui } = await open(t, similarFixture())
    const cells = shotsOf(rowsOf(ui)[0])
    assert.deepEqual(boxesOf(cells[1]), ['left:25%;top:50%;width:10%;height:20%'])
    assert.deepEqual(boxesOf(cells[2]), [], '沒有差異處就不畫框')
    assert.deepEqual(boxesOf(cells[0]), [], '留下的那張不畫框')
  })

  test('**縮圖的網址是 blob:，網址上沒有 token**', async t => {
    const { ui, f } = await open(t, similarFixture())
    const imgs = ui.$('cleanup-bursts').all('img')
    assert.equal(imgs.length, 3)
    for (const img of imgs) {
      assert.match(String(img.src), /^blob:/, '<img> 只能吃 blob: 網址')
      assert.doesNotMatch(String(img.src), /cleanup\/thumb/, '不可以直接指到要 token 的端點')
    }
    const thumbCalls = f.calls.filter(c => c.path.startsWith('/cleanup/thumb/'))
    assert.deepEqual(thumbCalls.map(c => c.path).sort(), ['/cleanup/thumb/k1', '/cleanup/thumb/m1', '/cleanup/thumb/m2'])
    assert.ok(thumbCalls.every(c => !/[?&]k=|token/.test(c.path)), JSON.stringify(thumbCalls))
  })

  test('**連拍的成員不會在下面的候選清單再列一次**（同一個檔不可以有兩個勾選框）', async t => {
    const { ui } = await open(t, similarFixture())
    assert.deepEqual(listNames(ui), ['很久沒動.zip'])
  })

  test('沒有連拍組 → 整區不顯示，候選清單照常', async t => {
    const fx = similarFixture()
    fx.bursts = { groups: [] }
    const { ui } = await open(t, fx)
    assert.equal(ui.$('cleanup-bursts').hidden, true)
    assert.deepEqual(listNames(ui), ['截圖 1.png', '截圖 2.png', '很久沒動.zip'])
  })

  test('**舊版後端（501）：面板照常，連拍區不顯示**', async t => {
    const fx = similarFixture()
    fx.bursts = null
    const { ui } = await open(t, fx)
    assert.equal(ui.$('cleanup-bursts').hidden, true)
    assert.deepEqual(listNames(ui), ['截圖 1.png', '截圖 2.png', '很久沒動.zip'])
    assert.match(ui.$('cleanup-summary').textContent, /\d+ of 3 files selected/)
  })

  test('檔名是不可信的輸入：換行不可以在畫面上偽造一行', async t => {
    const fx = similarFixture()
    fx.bursts.groups[0].members[0].name = 'a\nKeeping 99 張.png'
    fx.candidates[0].name = 'a\nKeeping 99 張.png'
    const { ui } = await open(t, fx)
    assert.match(ui.$('cleanup-bursts').textContent, /a·Keeping 99 張\.png/)
    assert.doesNotMatch(ui.$('cleanup-bursts').textContent, /a\nKeeping/)
  })

  test('示範模式（按 D）不顯示連拍區 —— 那時候畫面上是假的清單', async t => {
    const { ui } = await open(t, similarFixture(), { fetch: demoFetch })
    assert.equal(ui.$('cleanup-bursts').hidden, false, '前提：本機模式有Bursts區')
    await ui.key('d')
    await ui.click('quaso-cleanup-alert')
    assert.equal(ui.$('cleanup-bursts').hidden, true)
  })
})

describe('B 主動詢問：有新的組才彈', () => {
  test('**newGroups > 0 → 寵物主動說一句，而且給一顆打開連拍區的按鈕**', async t => {
    const fx = similarFixture()
    const f = fakeApi({ ...fx, pet: { burst: { groups: 1, newGroups: 1 } } })
    const ui = await mountPanel(t, { api: f.api })
    assert.equal(ui.$('quaso-dialog').hidden, false)
    assert.equal(ui.$('quaso-status').textContent, 'These 3 screenshots look like one burst. Keep only the newest?')
    assert.equal(ui.$('quaso-burst-open').hidden, false)
    await ui.click('quaso-burst-open')
    assert.equal(ui.$('cleanup-panel').open, true, '點一下要打開面板')
    assert.equal(ui.$('cleanup-bursts').hidden, false)
  })

  test('**同一組問過之後不再主動彈**（舊的組還在連拍區裡，只是不彈）', async t => {
    const fx = similarFixture()
    const f = fakeApi({ ...fx, pet: { burst: { groups: 1, newGroups: 1 } } })
    const ui = await mountPanel(t, { api: f.api })
    assert.equal(ui.$('quaso-status').textContent, 'These 3 screenshots look like one burst. Keep only the newest?', '前提：第一次彈了')
    // 把泡泡收起來，再輪詢一次
    ui.$('quaso-status').textContent = '（沒有人講話）'
    ui.$('quaso-dialog').hidden = true
    ui.$('quaso-burst-open').hidden = true
    await ui.poll()
    assert.equal(ui.$('quaso-dialog').hidden, true, 'one burst不可以再彈一次')
    assert.equal(ui.$('quaso-burst-open').hidden, true)
    // 舊的組還在：打開面板照樣看得到
    await ui.click('quaso-cleanup-alert')
    assert.equal(rowsOf(ui).length, 1)
  })

  test('**問過的那幾組被清掉、又冒出一組新的（newGroups 反而變小）→ 照樣要彈**', async t => {
    const fx = similarFixture()
    const f = fakeApi({ ...fx, pet: { burst: { groups: 2, newGroups: 2 } } })
    const ui = await mountPanel(t, { api: f.api })
    assert.equal(ui.$('quaso-dialog').hidden, false, '前提：第一次彈了')
    ui.$('quaso-dialog').hidden = true
    ui.$('quaso-status').textContent = '（沒有人講話）'
    // 問過的那一組不見了（清掉了），換成一組全新的；數量從 2 掉到 1
    fx.bursts.groups = [{
      id: 'g9', level: 'same', keep: shot('k9', 'z3.png'),
      members: [shot('m9', 'z1.png', { level: 'same' })],
    }]
    f.pet.burst = { groups: 1, newGroups: 1 }
    await ui.poll()
    assert.equal(ui.$('quaso-dialog').hidden, false, '新的一組沒有被問到（數量比上次少就不問是錯的）')
    assert.match(ui.$('quaso-status').textContent, /one burst/)
  })

  test('**又出現一組（newGroups 變大）→ 再彈一次**', async t => {
    const fx = similarFixture()
    const f = fakeApi({ ...fx, pet: { burst: { groups: 1, newGroups: 1 } } })
    const ui = await mountPanel(t, { api: f.api })
    ui.$('quaso-dialog').hidden = true
    ui.$('quaso-status').textContent = '（沒有人講話）'
    fx.bursts.groups.push({
      id: 'g2', level: 'same', keep: shot('k2', 'b3.png'),
      members: [shot('n1', 'b1.png', { level: 'same' })],
    })
    f.pet.burst = { groups: 2, newGroups: 2 }
    await ui.poll()
    assert.equal(ui.$('quaso-dialog').hidden, false)
    // **只講新的那一組**：問過的那一組不再重提（面板端記的是「問過哪幾組」，不是「問過幾組」）。
    // 拿數量當高水位會安靜地漏問：問過 2 組、那 2 組被清掉、又冒出 1 組時 1 ≤ 2 就再也不問了。
    assert.equal(ui.$('quaso-status').textContent, 'These 2 screenshots look like one burst. Keep only the newest?')
  })

  test('**沒有新的組（newGroups 0）就不要主動彈**，組還是列得出來', async t => {
    const fx = similarFixture()
    const f = fakeApi({ ...fx, pet: { burst: { groups: 1, newGroups: 0 } } })
    const ui = await mountPanel(t, { api: f.api })
    assert.equal(ui.$('quaso-dialog').hidden, true, '沒有新的組不可以彈')
    await ui.click('quaso-cleanup-alert')
    assert.equal(rowsOf(ui).length, 1, '舊的組還在Bursts區裡')
  })

  test('舊版後端（/pet/state 沒有 burst）→ 不彈、不壞掉', async t => {
    const fx = similarFixture()
    const f = fakeApi({ ...fx, pet: {} })
    const ui = await mountPanel(t, { api: f.api })
    assert.equal(ui.$('quaso-dialog').hidden, true)
    assert.equal(ui.$('quaso-burst-open').hidden, true)
  })

  test('/pet/state 說有新的組、但 /cleanup/bursts 讀不到 → 不彈，下一輪再問', async t => {
    const fx = similarFixture()
    const f = fakeApi({ candidates: fx.candidates, bursts: null, pet: { burst: { groups: 1, newGroups: 1 } } })
    const ui = await mountPanel(t, { api: f.api })
    assert.equal(ui.$('quaso-dialog').hidden, true, '沒有東西可以給看就不要彈')
  })

  test('面板開著的時候不彈（不要蓋掉使用者正在看的東西）', async t => {
    const fx = similarFixture()
    const f = fakeApi({ ...fx, pet: { burst: { groups: 1, newGroups: 0 } } })
    const ui = await mountPanel(t, { api: f.api })
    await ui.click('quaso-cleanup-alert')
    assert.equal(ui.$('cleanup-panel').open, true, '前提：面板開著')
    f.pet.burst = { groups: 2, newGroups: 2 }
    await ui.poll()
    assert.equal(ui.$('quaso-dialog').hidden, true, '面板開著的時候不可以彈泡泡')
    // 關掉面板之後照樣會問（沒有被吃掉）
    await ui.click('cleanup-close')
    await ui.poll()
    assert.equal(ui.$('quaso-dialog').hidden, false)
  })
})

// ═══ C ・ 真的 server ═══════════════════════════════════════

/**
 * 起一台真的 server（port 0、假家目錄），放幾個真的檔、掃一次。
 * `setHook(fn)`：fn(path) 回 Response 的話就用它換掉這一次的回應（後端還沒做的
 * /cleanup/bursts 與 /cleanup/thumb 用它假裝），回 undefined 就照常送到 server。
 */
async function serve(t, files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-burst-ui-')))
  const downloads = join(dir, 'Downloads')
  mkdirSync(downloads)
  for (const [name, spec] of Object.entries(files)) {
    const p = join(downloads, name)
    writeFileSync(p, spec.content ?? `內容 ${name} `.repeat(3))
    const at = new Date(Date.now() - spec.days * DAY)
    utimesSync(p, at, at)
  }
  const S = start({
    port: 0, db: join(dir, 'data.db'), token: TOKEN, roots: [downloads],
    quarantine: join(dir, 'q'), maxBytes: 20 * 1024 * 1024, readonly: false,
  })
  const port = await S.ready
  const base = `http://127.0.0.1:${port}`
  let hook = null
  const seen = []
  const netFetch = async (url, init = {}) => {
    const path = String(url).replace(base, '')
    seen.push({ path, headers: init.headers ?? {} })
    const faked = hook?.(path, init)
    if (faked) return faked
    return realFetch(String(url).startsWith('/') ? base + url : url, init)
  }
  const raw = async (path, init = {}) => {
    const r = await realFetch(base + path, {
      ...init, headers: { 'content-type': 'application/json', ...(init.token === null ? {} : { 'x-contextbox-token': TOKEN }) },
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { const e = new Error(data.error); e.code = data.code; e.status = r.status; e.data = data; throw e }
    return data
  }
  t.after(() => { globalThis.__cbStopPage?.(); S.server.closeAllConnections(); S.server.close(); S.server.unref(); rmTmp(dir) })
  await raw('/cleanup/scan', { method: 'POST', body: '{}' })
  return {
    dir, downloads, base, port, netFetch, raw, seen,
    setHook: fn => { hook = fn },
    status: async (path, init = {}) => (await realFetch(base + path, init)).status,
    has: n => existsSync(join(downloads, n)),
    idsOf: async n => (await raw('/cleanup/candidates?limit=1000')).candidates.find(c => c.name === n),
  }
}

const pngResponse = () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })

describe('C 真的 server', () => {
  test('**舊版後端（真的 server 還沒有 /cleanup/bursts）：面板照常列清單，連拍區不顯示**', async t => {
    const s = await serve(t, { 'old.zip': { days: 200 } })
    const ui = await mountPanel(t, { fetch: s.netFetch, token: TOKEN, base: s.base })
    await ui.click('quaso-cleanup-alert')
    assert.equal(ui.$('cleanup-bursts').hidden, true)
    assert.deepEqual(listNames(ui), ['old.zip'])
    assert.equal(await s.status('/cleanup/bursts'), 401, '不帶 token：擋在認證那一關')
  })

  test('**縮圖端點要 token**：不帶 token 拿不到', async t => {
    const s = await serve(t, { 'old.zip': { days: 200 } })
    assert.equal(await s.status('/cleanup/thumb/anything'), 401)
  })

  test('**token 走 header，不進網址**：頁面拿縮圖時送出去的路徑是乾淨的', async t => {
    const s = await serve(t, { 'shot-1.png': { days: 200 }, 'shot-2.png': { days: 200 }, 'shot-3.png': { days: 200 } })
    const one = await s.idsOf('shot-1.png'), two = await s.idsOf('shot-2.png'), keep = await s.idsOf('shot-3.png')
    s.setHook(path => {
      if (path === '/cleanup/bursts') {
        return Response.json({ groups: [{
          id: 'g1', level: 'similar', keep: shot(keep.itemId, 'shot-3.png'),
          members: [
            shot(one.itemId, 'shot-1.png', { level: 'similar', boxes: [{ x: 0.25, y: 0.5, w: 0.1, h: 0.2 }] }),
            shot(two.itemId, 'shot-2.png', { level: 'similar' }),
          ],
        }] })
      }
      if (path.startsWith('/cleanup/thumb/')) return pngResponse()
      return undefined
    })
    const ui = await mountPanel(t, { fetch: s.netFetch, token: TOKEN, base: s.base })
    await ui.click('quaso-cleanup-alert')
    const thumbs = s.seen.filter(c => c.path.startsWith('/cleanup/thumb/'))
    assert.equal(thumbs.length, 3, JSON.stringify(s.seen.map(c => c.path)))
    for (const c of thumbs) {
      assert.doesNotMatch(c.path, /\?|token|[&]k=/, `縮圖的網址不可以帶 token：${c.path}`)
      assert.equal(c.headers['x-contextbox-token'], TOKEN, 'token 要在 header 上')
    }
    const imgs = ui.$('cleanup-bursts').all('img')
    assert.equal(imgs.length, 3, '三張縮圖都要拿得到（api 的 blob 分支）')
    for (const img of imgs) assert.match(String(img.src), /^blob:/)
    assert.deepEqual(boxesOf(shotsOf(rowsOf(ui)[0])[1]), ['left:25%;top:50%;width:10%;height:20%'])
  })

  test('**勾了走既有的清理流程**：建計畫 → 套用 → 檔真的搬走，留下的那張不動', async t => {
    const s = await serve(t, { 'shot-1.png': { days: 200 }, 'shot-2.png': { days: 200 }, 'shot-3.png': { days: 200 } })
    const one = await s.idsOf('shot-1.png'), two = await s.idsOf('shot-2.png'), keep = await s.idsOf('shot-3.png')
    s.setHook(path => {
      if (path === '/cleanup/bursts') {
        return Response.json({ groups: [{
          id: 'g1', level: 'similar', keep: shot(keep.itemId, 'shot-3.png'),
          members: [shot(one.itemId, 'shot-1.png', { level: 'similar' }), shot(two.itemId, 'shot-2.png', { level: 'similar' })],
        }] })
      }
      if (path.startsWith('/cleanup/thumb/')) return pngResponse()
      return undefined
    })
    const ui = await mountPanel(t, { fetch: s.netFetch, token: TOKEN, base: s.base })
    await ui.click('quaso-cleanup-alert')
    const checks = burstChecks(ui)
    assert.deepEqual(checks.map(c => c.input.checked), [false, false], 'similar 預設不勾')
    checks[0].input.checked = true
    checks[0].input.onchange()
    await ui.click('cleanup-apply')
    assert.match(ui.$('cleanup-result').textContent, /Moved 1 file/, ui.$('cleanup-result').textContent)
    assert.ok(!s.has('shot-1.png'), '勾了的要真的搬走')
    assert.ok(s.has('shot-2.png'), '沒勾的不可以動')
    assert.ok(s.has('shot-3.png'), '**留下的那張永遠不會被清掉**')
    const sent = s.seen.find(c => c.path === '/cleanup/plans')
    assert.ok(sent, '要走既有的建計畫路徑')
  })

  test('**逐張那顆按下去也真的搬走那一張**（而且只有那一張）', async t => {
    // 只檢查按鈕存在是不夠的：把 onclick 換成空函式，那種測試照樣全綠（突變測試抓到）。
    // 這一條走到底 —— 真的 server、真的檔案、真的搬走。
    const s = await serve(t, { 'shot-1.png': { days: 200 }, 'shot-2.png': { days: 200 }, 'shot-3.png': { days: 200 } })
    const one = await s.idsOf('shot-1.png'), two = await s.idsOf('shot-2.png'), keep = await s.idsOf('shot-3.png')
    s.setHook(path => {
      if (path === '/cleanup/bursts') {
        return Response.json({ groups: [{
          id: 'g1', level: 'similar', keep: shot(keep.itemId, 'shot-3.png'),
          members: [shot(one.itemId, 'shot-1.png', { level: 'similar' }), shot(two.itemId, 'shot-2.png', { level: 'similar' })],
        }] })
      }
      if (path.startsWith('/cleanup/thumb/')) return pngResponse()
      return undefined
    })
    const ui = await mountPanel(t, { fetch: s.netFetch, token: TOKEN, base: s.base })
    await ui.click('quaso-cleanup-alert')
    const cells = shotsOf(rowsOf(ui)[0])
    const button = cells[1].byClass('cleanup-one')[0]
    assert.ok(button, '前提：成員那一格有逐張按鈕')
    await button.onclick()
    assert.ok(!s.has('shot-1.png'), '按下去的那一張要真的搬走')
    assert.ok(s.has('shot-2.png'), '沒按的那一張不可以被順便搬走')
    assert.ok(s.has('shot-3.png'), '**留下的那張永遠不會被清掉**')
    assert.ok(s.seen.some(c => c.path === '/cleanup/plans'), '要走同一條建計畫的路，不是捷徑')
  })
})

// ═══ D 展開預覽不可以把同一排擠出畫面（2026-09-21 使用者截圖）═══

describe('D 連拍格子裡的預覽', () => {
  async function open(t, opts, mount = {}) {
    const ui = await mountPanel(t, { api: fakeApi(opts).api, ...mount })
    await ui.click('quaso-cleanup-alert')
    return ui
  }
  const cells = ui => rowsOf(ui)[0].byClass('cleanup-shot')
  const peekOf = cell => cell.byClass('cleanup-peek')[0]

  test('展開的那一格要標記起來，沒展開的不可以有標記', async t => {
    // 一格只有 150px 寬，預覽是 420px。不讓展開的那一格整列，420px 會從格子裡滿出來，
    // 把同一排其他張擠出畫面右邊 —— 連那幾張的勾選框都按不到（使用者截圖）。
    const ui = await open(t, similarFixture())
    const before = cells(ui)
    assert.ok(before.length >= 2, '前提：一排不只一張')
    for (const c of before) {
      assert.ok(!c.className.includes('is-previewing'), '還沒展開就不該有標記')
    }
    await peekOf(before[1]).onclick()
    const after = cells(ui)
    assert.ok(after[1].className.includes('is-previewing'), '展開的那一格要整列讓給它')
    assert.ok(!after[0].className.includes('is-previewing'), '別的格子不要跟著變寬')
  })

  test('收起來標記就要消失（不然那一格永遠佔著整列）', async t => {
    const ui = await open(t, similarFixture())
    await peekOf(cells(ui)[1]).onclick()
    assert.ok(cells(ui)[1].className.includes('is-previewing'))
    await peekOf(cells(ui)[1]).onclick()
    assert.ok(!cells(ui)[1].className.includes('is-previewing'), '收起來了還佔著整列')
  })

  test('CSS 那一半：展開佔整列、預覽跟著格子走、整區不可以橫向捲', () => {
    // 面板測試看得到 class，看不到樣式。這條守住樣式那一半 ——
    // 只留 class 而沒有規則的話，畫面上還是壞的。
    const css = readFileSync(join(REPO, 'core/ui.html'), 'utf8')
    assert.match(css, /\.cleanup-shot\.is-previewing\s*\{[^}]*width:\s*100%/,
      '展開的那一格要佔滿整列')
    assert.match(css, /\.cleanup-shot \.cleanup-preview\s*\{[^}]*max-width:\s*100%/,
      '預覽不可以比它的格子寬')
    assert.ok(!/\.cleanup-shot \.cleanup-preview\s*\{[^}]*width:\s*min\(420px/.test(css),
      '420px 寫死在 150px 的格子裡，就是這次的 bug')
  })
})

// ═══ E 連拍區要按得下去（2026-09-21）═══════════════════════════
//
// 勾得動只是一半。使用者問「是不是要留按鍵給我按刪除截圖的部分」——
// 問得對：SECTION_BUTTONS 原本只把 Clean up 掛在 clean 那一區，
// 所以在 Bursts 分頁勾了兩張，整個畫面上一顆能按的都沒有，勾了等於沒用。

describe('E 連拍區的動作按鈕', () => {
  async function open(t, opts, mount = {}) {
    const ui = await mountPanel(t, { api: fakeApi(opts).api, ...mount })
    await ui.click('quaso-cleanup-alert')
    return ui
  }
  const cellsOf = ui => rowsOf(ui)[0].byClass('cleanup-shot')
  const oneOf = cell => cell.byClass('cleanup-one')[0]

  test('每一張成員一顆「Clean up」；留下的那張沒有（它本來就不會被清掉）', async t => {
    const ui = await open(t, similarFixture())
    const cells = cellsOf(ui)
    assert.equal(cells.length, 3)
    assert.equal(oneOf(cells[0]), undefined, '留下的那張不可以有清理按鈕')
    for (const c of cells.slice(1)) {
      assert.ok(oneOf(c), '每一張成員都要有一顆')
      assert.equal(oneOf(c).textContent, 'Clean up')
    }
  })

  test('**按鈕不在 <label> 裡**（真瀏覽器裡點它會連帶取消那一格的勾選）', async t => {
    const ui = await open(t, similarFixture())
    for (const c of cellsOf(ui).slice(1)) {
      const label = c.all('LABEL')[0]
      assert.ok(!label.byClass('cleanup-one').length, '按鈕放進 label 裡會偷偷切掉勾選框')
    }
  })

  test('勾不動的時候按鈕也要跟著停用（不然按了只會失敗）', async t => {
    const fx = similarFixture()
    // 成員不在候選清單上 → 勾選框停用；按鈕不可以還亮著
    fx.candidates = []
    const ui = await open(t, fx)
    for (const c of cellsOf(ui).slice(1)) {
      const box = c.all('INPUT')[0]
      assert.equal(box.disabled, true, '前提：這一格勾不動')
      assert.equal(oneOf(c).disabled, true, '勾不動卻按得下去，按了只會失敗')
    }
  })

  test('**整批執行的那幾顆在連拍分頁也看得到**（勾了要有地方按）', async t => {
    const ui = await open(t, similarFixture())
    await ui.$('cleanup-tabs') && null
    // 切到連拍那一區
    const tabs = ui.$('cleanup-tabs')
    const opt = tabs.all('OPTION').find(o => o.textContent.startsWith('Bursts'))
    assert.ok(opt, '前提：有 Bursts 這一區')
    tabs.value = opt.value
    await tabs.onchange()
    assert.equal(ui.$('cleanup-apply').hidden, false, '在 Bursts 勾了卻沒有 Clean up 可以按')
    assert.equal(ui.$('cleanup-rename').hidden, true, '改名那顆不屬於這一區')
  })
})
