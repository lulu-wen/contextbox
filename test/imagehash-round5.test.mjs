// imagehash 第五輪：往「預設勾」方向的 API 陷阱，與 similar 的外框
//   1. fineCompare 單獨呼叫不可以回 same：它手上只有細比對，沒有原圖。只有拿到兩張原圖的 compareImages 能回 same
//      （長邊 ≤ 640 的圖，細比對就是原圖，compareImages 不帶 gray 也算拿到原圖）
//   2. 兩張的原圖灰階共用同一塊記憶體（同一個 ArrayBuffer、範圍重疊）→ 不可以判 same（當成 unverified → similar）；
//      burstGroups 自己用 loadGray 載入時，留下的那張複製一份，loadGray 重複用同一塊輸出緩衝也不會出錯
//   3. similar 的外框要涵蓋那一處變化：細比對上每一格變了的（每格不只 1 像素時差 ≠ 0；每格 1 像素時差 > SAME_TOL）都在某個框裡。
//      淡色小字整行換掉（fixtures synth4 的 W 類）：框的寬度至少是那行字的 80%
//   4. 擴大外框多做的那一步也算工作量（逐位元組算好的邊界）
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { dHash, fineSig, fineCompare, compareImages, burstGroups, SAME_TOL } from '../core/imagehash.ts'
import { synth4, synthItem } from './imagehash-synth4.mjs'

/** 可重現的亂數（xorshift32）。 */
function rng(seed) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s / 0x100000000
  }
}
/** w×h 的細比對資料；blocks 是 [x, y, 寬, 高, 值] 的方塊（格子座標），底色 base。後面的方塊蓋掉前面的。 */
function sig(w, h, blocks = [], base = 0) {
  const px = new Uint8Array(w * h).fill(base)
  for (const [x, y, bw, bh, v = 255] of blocks) for (let yy = y; yy < y + bh; yy++) px.fill(v, yy * w + x, yy * w + x + bw)
  return { w, h, px }
}
const infoOf = img => ({ width: img.width, height: img.height, hash: dHash(img), fine: fineSig(img) })
const withGray = img => ({ ...infoOf(img), gray: img.gray })
const inBoxes = (boxes, x, y) => boxes.some(b => b.x <= x && x < b.x + b.w && b.y <= y && y < b.y + b.h)
/** 格子座標的框有沒有包住 (x, y) 這一格。 */
const inRegions = (regions, x, y) => regions.some(g => g.x <= x && x < g.x + g.w && g.y <= y && y < g.y + g.h)

// ── 1. fineCompare 不可以回 same ─────────────────────────────────────
describe('fineCompare 單獨呼叫不可以回 same（最多 similar）：只有拿到兩張原圖的 compareImages 能回 same', () => {
  test('一模一樣的細比對：不管 cellPx 是多少（含預設的 1），都是 similar／unverified，外框是空的', () => {
    for (const cellPx of [undefined, 1, 2, 5.3]) {
      const r = fineCompare(sig(100, 100, [], 200), sig(100, 100, [], 200), cellPx)
      assert.deepEqual([r.level, r.notSame, r.near, r.regions, r.reason], ['similar', 'unverified', true, [], ''], `cellPx ${cellPx}`)
      assert.equal(r.pixels, cellPx === undefined || cellPx === 1 ? 0 : -1, `cellPx ${cellPx}：每格 1 像素時照樣回報差 > SAME_TOL 的格數`)
    }
    // 每格 1 像素、差都 ≤ SAME_TOL：原圖上看不出變化，但 fineCompare 不知道這份細比對是不是原圖 → 還是 unverified
    const r2 = fineCompare(sig(100, 100, [], 200), sig(100, 100, [[20, 20, 30, 3, 202]], 200))
    assert.deepEqual([r2.level, r2.notSame, r2.pixels], ['similar', 'unverified', 0])
  })

  test('驗證者的例子（5120×1440 白底的淡色小字）：原圖上幾個像素差 13、各在不同的格子，細比對平均下去一格都沒變 → fineCompare 不是 same；compareImages 帶原圖 → similar', () => {
    const W = 5120, H = 1440
    const ga = new Uint8Array(W * H).fill(255)
    const gb = new Uint8Array(ga)
    const DOTS = [[300, 300], [320, 302], [340, 301], [360, 300]]
    for (const [x, y] of DOTS) gb[y * W + x] = 242
    const a = withGray({ width: W, height: H, gray: ga }), b = withGray({ width: W, height: H, gray: gb })
    assert.deepEqual(a.fine.px, b.fine.px, '細比對一格都沒變')
    const r = fineCompare(a.fine, b.fine)
    assert.notEqual(r.level, 'same')
    assert.deepEqual([r.level, r.notSame], ['similar', 'unverified'])
    const c = compareImages(a, b)
    assert.equal(c.level, 'similar')
    for (const [x, y] of DOTS) assert.ok(inBoxes(c.boxes, x, y), `(${x}, ${y}) 沒被框到`)
    // 只有簽章的 compareImages 也不是 same
    assert.deepEqual(compareImages({ ...a, gray: undefined }, { ...b, gray: undefined }), { level: 'similar', reason: 'unverified', boxes: [] })
  })

  test('長邊 ≤ 640 的圖：compareImages 不帶原圖也是 same（細比對就是原圖）；同一對給 fineCompare 是 similar／unverified', () => {
    const g = new Uint8Array(300 * 200).fill(90)
    const a = infoOf({ width: 300, height: 200, gray: g }), b = infoOf({ width: 300, height: 200, gray: new Uint8Array(g) })
    assert.deepEqual(compareImages(a, b), { level: 'same', reason: '', boxes: [] })
    assert.deepEqual([fineCompare(a.fine, b.fine).level, fineCompare(a.fine, b.fine).notSame], ['similar', 'unverified'])
  })

  test('結構化隨機：500 組隨機細比對（格數、方塊、差 0～60、各種 cellPx）→ fineCompare 永遠不是 same；每格 1 像素時，其他等級與外框跟 compareImages 一樣', () => {
    const r = rng(5150919)
    const tally = { similar: 0, different: 0, unverified: 0 }
    for (let round = 0; round < 500; round++) {
      const w = 20 + Math.floor(r() * 300), h = 20 + Math.floor(r() * 300)
      const bg = Math.floor(r() * 256)
      const blocks = []
      const nb = Math.floor(r() * 4)
      for (let k = 0; k < nb; k++) {
        const bw = 1 + Math.floor(r() * 12), bh = 1 + Math.floor(r() * 12)
        const d = [0, 1, 2, 3, 5, 13, 40, 60][Math.floor(r() * 8)] * (r() < 0.5 ? -1 : 1)
        blocks.push([Math.floor(r() * (w - bw)), Math.floor(r() * (h - bh)), bw, bh, Math.min(255, Math.max(0, bg + d))])
      }
      const A = sig(w, h, [], bg), B = sig(w, h, blocks, bg)
      const cellPx = [undefined, 1, 2, 3, 5.3][round % 5]
      const fr = fineCompare(A, B, cellPx)
      assert.notEqual(fr.level, 'same', `round ${round}`)
      assert.equal(fr.near, fr.level !== 'different')
      if (fr.notSame === 'unverified') tally.unverified++
      else tally[fr.level]++
      if (cellPx === undefined || cellPx === 1) {
        // 每格 1 像素（長邊 ≤ 640 的圖本身）：compareImages 能拿到原圖，同一份規則；只差在 fineCompare 不能說 same
        const H16 = '0123456789abcdef'
        const c = compareImages({ width: w, height: h, hash: H16, fine: A }, { width: w, height: h, hash: H16, fine: B })
        assert.equal(fr.level, c.level === 'same' ? 'similar' : c.level, `round ${round}`)
        if (c.level === 'same') assert.deepEqual([fr.notSame, fr.regions], ['unverified', []], `round ${round}`)
        else if (c.level === 'similar') assert.deepEqual(fr.regions.map(g => ({ x: g.x, y: g.y, w: g.w, h: g.h })), c.boxes, `round ${round}`)
      }
    }
    assert.ok(tally.similar > 50 && tally.unverified > 50 && tally.different > 10, JSON.stringify(tally))
  })
})

// ── 2. 原圖灰階共用同一塊記憶體 ────────────────────────────────────────
describe('原圖灰階共用同一塊記憶體（同一個 ArrayBuffer、範圍重疊）→ 不可以判 same', () => {
  // 1920 寬：細比對每格 3×3 像素。一個像素差 20，平均下去只剩 2，細比對看不出來，要回原圖確認
  const W = 1920, H = 1080, n = W * H
  const g1 = new Uint8Array(n).fill(240)
  const g2 = new Uint8Array(g1)
  g2[500 * W + 1000] = 220
  const A = { width: W, height: H, gray: g1 }, B = { width: W, height: H, gray: g2 }
  const a = infoOf(A), b = infoOf(B)
  const UNVERIFIED = { level: 'similar', reason: 'unverified', boxes: [] }

  test('compareImages：兩張的 gray 是同一個陣列、或重疊的 subarray → similar／unverified；沒重疊的 subarray（同一個 ArrayBuffer）照常確認', () => {
    const truth = compareImages({ ...a, gray: g1 }, { ...b, gray: g2 })
    assert.deepEqual(truth, { level: 'similar', reason: '', boxes: [{ x: 999, y: 498, w: 3, h: 3 }] })
    // 同一個陣列（呼叫端的緩衝被下一張蓋掉）：內容一樣，但不可以說 same
    assert.deepEqual(compareImages({ ...a, gray: g2 }, { ...b, gray: g2 }), UNVERIFIED)
    assert.deepEqual(compareImages({ ...a, gray: g1 }, { ...b, gray: g1 }), UNVERIFIED)
    // 同一個 ArrayBuffer、差 1 個位元組的兩個 subarray（範圍重疊）：底色一樣，兩個 view 的內容也一樣
    const buf = new Uint8Array(n + 1).fill(240)
    assert.deepEqual(compareImages({ ...a, gray: buf.subarray(0, n) }, { ...b, gray: buf.subarray(1) }), UNVERIFIED)
    assert.deepEqual(compareImages({ ...a, gray: buf.subarray(1) }, { ...b, gray: buf.subarray(0, n) }), UNVERIFIED)
    // 同一個 ArrayBuffer、沒重疊的兩段：照常確認（跟分開的陣列結果一樣）
    const two = new Uint8Array(2 * n + 3)
    two.set(g1, 0)
    two.set(g2, n + 3)
    assert.deepEqual(compareImages({ ...a, gray: two.subarray(0, n) }, { ...b, gray: two.subarray(n + 3) }), truth)
    two.set(g1, n + 3)
    assert.deepEqual(compareImages({ ...a, gray: two.subarray(0, n) }, { ...b, gray: two.subarray(n + 3) }), { level: 'same', reason: '', boxes: [] })
    // 剛好相鄰（前一段的結尾就是後一段的開頭）不算重疊
    const adj = new Uint8Array(2 * n)
    adj.set(g1, 0)
    adj.set(g1, n)
    assert.deepEqual(compareImages({ ...a, gray: adj.subarray(0, n) }, { ...b, gray: adj.subarray(n) }).level, 'same')
  })

  const items = () => [{ id: 'new', ...b, takenAt: 1000 }, { id: 'old', ...a, takenAt: 0 }]
  const fresh = id => ({ width: W, height: H, gray: new Uint8Array(id === 'new' ? g2 : g1) })

  test('burstGroups：loadGray 每次都寫進同一塊緩衝再回傳 → 結果跟每次回新陣列一樣（留下的那張先複製一份），不會是 same', () => {
    const want = burstGroups(items(), { loadGray: fresh })
    assert.deepEqual(want, [{ keep: 'new', level: 'similar', drop: ['old'], members: [{ id: 'old', level: 'similar', boxes: [{ x: 999, y: 498, w: 3, h: 3 }] }] }])
    const scratch = new Uint8Array(n)
    const calls = []
    const reuse = id => {
      calls.push(id)
      scratch.set(id === 'new' ? g2 : g1)
      return { width: W, height: H, gray: scratch }
    }
    assert.deepEqual(burstGroups(items(), { loadGray: reuse }), want)
    assert.deepEqual(calls, ['new', 'old'], '每張還是只載入一次')
    // 兩格輪流用的環狀緩衝（同一個 ArrayBuffer 的兩段）
    const ring = new Uint8Array(2 * n)
    let slot = 0
    const ringLoad = id => {
      const v = ring.subarray(slot * n, (slot + 1) * n)
      slot ^= 1
      v.set(id === 'new' ? g2 : g1)
      return { width: W, height: H, gray: v }
    }
    assert.deepEqual(burstGroups(items(), { loadGray: ringLoad }), want)
    // 內容真的一樣時，重複用緩衝也要能確認 same（不是一律放棄）
    const sameItems = [{ id: 'new', ...a, takenAt: 1000 }, { id: 'old', ...a, takenAt: 0 }]
    const reuseSame = () => {
      scratch.set(g1)
      return { width: W, height: H, gray: scratch }
    }
    assert.deepEqual(burstGroups(sameItems, { loadGray: reuseSame }), [{ keep: 'new', level: 'same', drop: ['old'], members: [{ id: 'old', level: 'same', boxes: [] }] }])
  })

  test('burstGroups：留下那張跟三個成員（一樣、差一個像素、一樣），loadGray 重複用緩衝 → 每一個成員都跟每次回新陣列時一樣', () => {
    const list = [
      { id: 'k', ...b, takenAt: 100 },
      { id: 'm1', ...b, takenAt: 90 },
      { id: 'm2', ...a, takenAt: 80 },
      { id: 'm3', ...b, takenAt: 70 },
    ]
    const src = { k: g2, m1: g2, m2: g1, m3: g2 }
    const want = burstGroups(list, { loadGray: id => ({ width: W, height: H, gray: new Uint8Array(src[id]) }) })
    assert.deepEqual(want[0].members.map(m => [m.id, m.level]), [['m1', 'same'], ['m2', 'similar'], ['m3', 'same']])
    const scratch = new Uint8Array(n)
    assert.deepEqual(burstGroups(list, { loadGray: id => { scratch.set(src[id]); return { width: W, height: H, gray: scratch } } }), want)
  })

  test('burstGroups：item.gray 兩張共用同一個陣列、或成員載入回來的是留下那張的 item.gray → similar／unverified', () => {
    const shared = burstGroups([{ id: 'new', ...b, gray: g2, takenAt: 1000 }, { id: 'old', ...a, gray: g2, takenAt: 0 }])
    assert.deepEqual(shared, [{ keep: 'new', level: 'similar', drop: ['old'], members: [{ id: 'old', level: 'similar', boxes: [] }] }])
    // 留下那張帶 item.gray（S），成員沒帶；loadGray 把成員解進 S 再回傳（把留下那張的內容蓋掉了）
    const S = new Uint8Array(g2)
    const r = burstGroups([{ id: 'new', ...b, gray: S, takenAt: 1000 }, { id: 'old', ...a, takenAt: 0 }], { loadGray: () => { S.set(g1); return { width: W, height: H, gray: S } } })
    assert.deepEqual(r, [{ keep: 'new', level: 'similar', drop: ['old'], members: [{ id: 'old', level: 'similar', boxes: [] }] }])
    // 成員之間共用（留下那張是自己的陣列）沒關係：成員只跟留下那張比
    const ok = burstGroups([{ id: 'k', ...b, gray: new Uint8Array(g2), takenAt: 9 }, { id: 'x', ...b, gray: g2, takenAt: 8 }, { id: 'y', ...b, gray: g2, takenAt: 7 }])
    assert.deepEqual(ok, [{ keep: 'k', level: 'same', drop: ['x', 'y'], members: [{ id: 'x', level: 'same', boxes: [] }, { id: 'y', level: 'same', boxes: [] }] }])
  })
})

// ── 3. similar 的外框要涵蓋那一處變化 ─────────────────────────────────
describe('similar 的外框要涵蓋那一處變化：細比對上每一格變了的都在某個框裡', () => {
  test('一格淡變化旁邊一整排差 1～2 的格子（淡色小字平均下去）：每格不只 1 像素時整排都要框進去；每格 1 像素時差 ≤ SAME_TOL 的不框、差 3 的要框', () => {
    assert.equal(SAME_TOL, 2)
    // 第 100 列：x 60～159 差 1～2，x 100 那一格差 15（淡變化）
    const row = d => sig(400, 400, [[60, 100, 100, 1, 255 - d], [100, 100, 1, 1, 240]], 255)
    const A = sig(400, 400, [], 255)
    for (const d of [1, 2]) {
      const r = fineCompare(A, row(d), 4)
      assert.equal(r.level, 'similar')
      assert.deepEqual(r.regions.map(g => [g.kind, g.x, g.y, g.w, g.h]), [['faint', 60, 100, 100, 1]], `差 ${d}：整排都要框進去`)
      const r1 = fineCompare(A, row(d), 1)
      assert.deepEqual(r1.regions.map(g => [g.kind, g.x, g.y, g.w, g.h]), [['faint', 100, 100, 1, 1]], `每格 1 像素、差 ${d} ≤ SAME_TOL：只框淡變化那一格`)
    }
    const r3 = fineCompare(A, row(3), 1)
    assert.deepEqual(r3.regions.map(g => [g.kind, g.x, g.y, g.w, g.h]), [['faint', 60, 100, 100, 1]], '每格 1 像素、差 3：整排都要框進去')
    // 強格的變化處也一樣：旁邊差 1 的格子併進它的框
    const withStrong = sig(400, 400, [[60, 100, 100, 3, 254], [150, 100, 5, 3, 0]], 255)
    const rs = fineCompare(A, withStrong, 3)
    assert.deepEqual(rs.regions.map(g => [g.kind, g.x, g.y, g.w, g.h]), [['change', 60, 100, 100, 3]])
  })

  test('離任何變化處都很遠、只有差 1～4 的小塊（每格不只 1 像素）也另外框出來；到處都是零星小塊時（超過 64 塊）整片框成一個', () => {
    const A = sig(400, 400, [], 200)
    const B = sig(400, 400, [[100, 100, 4, 4, 180], [300, 300, 20, 2, 198]], 200)
    const r = fineCompare(A, B, 3)
    assert.deepEqual(r.regions.map(g => [g.kind, g.x, g.y, g.w, g.h]), [['faint', 100, 100, 4, 4], ['faint', 300, 300, 20, 2]])
    // 70 個零星的差 1 小點（彼此離很遠）＋一格淡變化
    const dots = [[10, 10, 1, 1, 180]]
    for (let k = 0; k < 70; k++) dots.push([20 + (k % 10) * 37, 40 + Math.floor(k / 10) * 50, 1, 1, 201])
    const rm = fineCompare(A, sig(400, 400, dots, 200), 3)
    assert.equal(rm.level, 'similar')
    for (const [x, y] of dots) assert.ok(inRegions(rm.regions, x, y), `(${x}, ${y}) 沒被框到：${JSON.stringify(rm.regions)}`)
  })

  test('結構化隨機：600 組（每格 1 像素與不只 1 像素）→ similar 的每一格變了的都在某個框裡，每個框裡都有變了的格子', () => {
    const r = rng(20260920)
    let checked = 0
    for (let round = 0; round < 600; round++) {
      const w = 60 + Math.floor(r() * 300), h = 40 + Math.floor(r() * 200)
      const bg = 30 + Math.floor(r() * 200)
      const blocks = []
      const nb = 1 + Math.floor(r() * 6)
      for (let k = 0; k < nb; k++) {
        const bw = 1 + Math.floor(r() * 30), bh = 1 + Math.floor(r() * 4)
        const d = [1, 2, 3, 4, 6, 20, 50][Math.floor(r() * 7)] * (r() < 0.5 ? -1 : 1)
        blocks.push([Math.floor(r() * (w - bw)), Math.floor(r() * (h - bh)), bw, bh, Math.min(255, Math.max(0, bg + d))])
      }
      const A = sig(w, h, [], bg), B = sig(w, h, blocks, bg)
      const cellPx = round % 2 === 0 ? 1 : 3
      const tol = cellPx === 1 ? SAME_TOL : 0
      const fr = fineCompare(A, B, cellPx)
      if (fr.level !== 'similar' || fr.notSame === 'unverified') continue
      checked++
      const changed = []
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const d = A.px[y * w + x] - B.px[y * w + x]
        if (d > tol || d < -tol) changed.push([x, y])
      }
      for (const [x, y] of changed) assert.ok(inRegions(fr.regions, x, y), `round ${round}（cellPx ${cellPx}）：(${x}, ${y}) 沒被框到：${JSON.stringify(fr.regions)}`)
      for (const g of fr.regions) assert.ok(changed.some(([x, y]) => g.x <= x && x < g.x + g.w && g.y <= y && y < g.y + g.h), `round ${round}：空的框 ${JSON.stringify(g)}`)
    }
    assert.ok(checked > 150, `檢查了 ${checked} 組`)
  })

  test('淡色小字整行換掉（synth4 W 類：1920～7680 寬、7 種顏色、中英文、11／13px）：similar 的外框寬度至少是那行字的 80%；細比對上變了的格子都在框裡', { timeout: 300000 }, t => {
    const W = synth4.pairs.filter(p => p.name.startsWith('W-'))
    assert.equal(W.length, 140)
    const tally = { same: 0, similar: 0, different: 0 }
    const bad = []
    let worst = 1
    for (const p of W) {
      const a = synthItem(p.a), b = synthItem(p.b)
      const c = compareImages(a, b)
      tally[c.level]++
      assert.notEqual(c.level, 'same', p.name)
      if (c.level !== 'similar') continue
      const [lx, ly, lw, lh] = p.line
      // 跟那行字同一列、橫向蓋住最多的那個框
      let best = 0
      for (const bx of c.boxes) {
        if (bx.y >= ly + lh || bx.y + bx.h <= ly) continue
        best = Math.max(best, Math.min(lx + lw, bx.x + bx.w) - Math.max(lx, bx.x))
      }
      worst = Math.min(worst, best / lw)
      if (best < 0.8 * lw) bad.push(`${p.name}：那行字 x ${lx}～${lx + lw - 1}（${lw} 像素），框最多蓋住 ${best} 像素：${JSON.stringify(c.boxes)}`)
      // 細比對上差 ≠ 0 的格子，換回原圖座標都在某個框裡
      const { w, h, px: FA } = a.fine, FB = b.fine.px
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (FA[y * w + x] === FB[y * w + x]) continue
        const px0 = Math.floor((x * a.width) / w), px1 = Math.ceil(((x + 1) * a.width) / w) - 1
        const py0 = Math.floor((y * a.height) / h), py1 = Math.ceil(((y + 1) * a.height) / h) - 1
        if (!(inBoxes(c.boxes, px0, py0) && inBoxes(c.boxes, px1, py1))) bad.push(`${p.name}：細比對 (${x}, ${y}) 變了但沒被框到`)
      }
    }
    t.diagnostic(`same ${tally.same}、similar ${tally.similar}、different ${tally.different}；框蓋住那行字最少 ${(worst * 100).toFixed(0)}%`)
    assert.ok(tally.similar >= 100, JSON.stringify(tally))
    assert.deepEqual(bad.slice(0, 10), [], `${bad.length} 個問題`)
  })
})

// ── 4. 擴大外框也算工作量 ───────────────────────────────────────────
describe('擴大外框多做的那一步也算工作量', () => {
  test('逐位元組算好的邊界：7×7 的強格旁邊接一排 100 格差 3 的格子（640×430，每格 1 像素）', { timeout: 60000 }, () => {
    const W = 640, H = 430, N = W * H
    const H16 = '0123456789abcdef'
    const base = new Uint8Array(N).fill(200)
    const px = new Uint8Array(base)
    for (let y = 0; y < 7; y++) px.fill(255, (100 + y) * W + 100, (100 + y) * W + 107)
    px.fill(203, 103 * W + 107, 103 * W + 207)
    const one = compareImages({ width: W, height: H, hash: H16, fine: { w: W, h: H, px: base } }, { width: W, height: H, hash: H16, fine: { w: W, h: H, px } })
    assert.deepEqual(one, { level: 'similar', reason: '', boxes: [{ x: 100, y: 100, w: 107, h: 7 }] }, '那一排差 3 的格子併進強格的框')
    const members = m => {
      const items = [{ id: 'k', width: W, height: H, hash: H16, fine: { w: W, h: H, px: base }, takenAt: 1e9 }]
      for (let i = 0; i < m; i++) items.push({ id: 'm' + String(i).padStart(6, '0'), width: W, height: H, hash: H16, fine: { w: W, h: H, px }, takenAt: 1e9 - 1 - i })
      return items
    }
    // 看一張 16 ＋ 掃一次 275200 ＋ 弱格 49 × 81 ＋ 連成一處 49 × 25 ＋ 1² ＋ 歸屬 49 ＋ 切字行 2 × 7 × 7 = 280558（沒有這一排時的每次工作量）；
    // 擴大外框：再掃一次 275200 ＋ 變了的 149 格每格 6（GROW_PER_CELL）＋ 連成塊（149 × 9 ＋ 149）＋ 併進變化處 1 × 1 ＋ 1 × 0
    // = 277585 → 每次 558143。2149 次 = 1,199,449,307 ≤ 12 億，第 2150 次超過
    const g = burstGroups(members(2149))
    assert.deepEqual([g.length, g[0].drop.length, g[0].level, g[0].members[0].boxes], [1, 2149, 'similar', [{ x: 100, y: 100, w: 107, h: 7 }]])
    assert.throws(() => burstGroups(members(2150)), err => err.code === 'TOO_MUCH_WORK')
  })
})
