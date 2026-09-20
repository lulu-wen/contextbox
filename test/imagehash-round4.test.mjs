// imagehash 第四輪：same 只給「全解析度上幾乎沒有任何像素變化」的，沒有任何例外。
//   1. 第三輪對抗式驗證判成 same 的反例（逐位元組重現，fixtures/imagehash/synth4）：都不可以是 same
//      - R：真實 Chromium 截圖，浮動按鈕在跳，徽章 1→2、1→12、未讀數、淺灰字、時鐘變了（confirmed）
//      - E：浮動按鈕平移，徽章數字變了；K：一欄數字整欄平移、其中一格改掉（confirmed）
//      - C：細長的字搬家；H：直條圖一票換邊；L：淡色小字（#eee on 白、深色 #3c on #1e1e1e）整行或幾個字變了（minor）
//        C、K、L 收第三輪判 same 的全部（C 140、K 26、L 292 組，照驗證者的 .out），另外留著第四輪多收的 72、11、36 組
//        （第三輪其實是 similar，一樣不可以是 same）；第五輪之前漏了其中 121 組，見 make-synth4.py 的檔頭
//      - W（第五輪）：淡色小字整行換掉，不可以是 same；外框要涵蓋整行在 imagehash-round5.test.mjs
//      - M：多行字整段不同（每行 3 個字的段落要 different；5120 寬 1x 掉到 similar 是已知限制，但不可以是 same）
//      - F：灰階亮度一樣的換色是已知限制（鎖住現況）
//   2. compareImages 在全解析度上確認 same：完全一樣 → same；差 ±1～2 → same；游標閃一下、差 3 → similar
//   3. burstGroups 只有簽章時，用 loadGray(id) 只替候選的那幾對載入原圖灰階，每張最多一次
//   4. 結構化隨機：same ⇔ 原圖上每個像素的差都 ≤ 2；外框包住變了的地方
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ImageHashError, dHash, fineSig, fineCompare, compareImages, isNearDuplicate, burstGroups, SAME_TOL } from '../core/imagehash.ts'
import { synth4, synthItem, incrementalCheckCount } from './imagehash-synth4.mjs'

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'imagehash')

// ── 1. 第三輪的反例 ──────────────────────────────────────────────
describe('第三輪對抗式驗證判成 same 的反例：全解析度上有變化就不可以是 same', () => {
  const byCat = new Map()
  for (const p of synth4.pairs) {
    const cat = p.name.split('-')[0].replace(/\d+$/, '')
    if (!byCat.has(cat)) byCat.set(cat, [])
    byCat.get(cat).push(p)
  }
  const title = {
    R: '【confirmed】真實 Chromium 截圖：浮動按鈕在跳，徽章 1→2、1→12、未讀數、淺灰字、時鐘變了（按鈕跳動本身也不是 same）',
    E: '【confirmed】浮動按鈕平移 1～3px，徽章 1→2、3→8、2→5、9→12',
    K: '【confirmed】置中的一欄數字整欄移 3～4px，其中一格改掉（第三輪判 same 的 26 組全部＋第四輪多收的 11 組）',
    C: '【minor】細長的字「!」「l」「I」「|」從第 1 行搬到第 3 行（第三輪判 same 的 140 組全部＋第四輪多收的 72 組）',
    H: '【minor】直條圖一票從第 3 項移到第 7 項',
    L: '【minor】淡色小字（#ccc～#eee on 白、#3c～#50 on #1e1e1e，1920～7680 寬）整行或幾個字變了（第三輪判 same 的 292 組全部＋第四輪多收的 36 組）',
    F: '【已知限制】灰階亮度一樣的換色：灰階差 ≤ 2 的是 same（鎖住現況）；差 9 的不是',
    M: '【minor】多行字整段不同：每行 3 個字的段落（BAND_WIDE 改用 ≥ 之後）different；5120 寬 1x 還是 similar 的已知限制不可以是 same',
    W: '【第五輪】淡色小字整行換掉（每個字都不同）：不可以是 same',
  }
  for (const [cat, pairs] of byCat) {
    test(`${cat}：${title[cat] ?? cat}（${pairs.length} 組）`, { timeout: 300000 }, t => {
      const bad = []
      const tally = { same: 0, similar: 0, different: 0 }
      for (const p of pairs) {
        const a = synthItem(p.a), b = synthItem(p.b)
        const c = compareImages(a, b)
        tally[c.level]++
        const ok = p.expect === 'notSame' ? c.level !== 'same' : p.expect === 'different' ? c.level === 'different' : c.level === 'same'
        if (!ok) bad.push(`${p.name}（${p.why}；最大差 ${p.maxDiff}、差 > 2 的像素 ${p.changed}）：${c.level}`)
        assert.equal(compareImages(b, a).level, c.level, `${p.name} 要對稱`)
        // 沒有全解析度灰階時更不可以是 same
        if (p.expect === 'notSame') {
          const lv = compareImages({ ...a, gray: undefined }, { ...b, gray: undefined }).level
          if (lv === 'same') bad.push(`${p.name}（只有簽章）：same`)
        }
      }
      t.diagnostic(`same ${tally.same}、similar ${tally.similar}、different ${tally.different}`)
      assert.deepEqual(bad, [], `判錯 ${bad.length} 組`)
    })
  }
})

// ── 真實截圖（跟 imagehash.test.mjs 同一份 fixtures）──────────────────
const realMeta = JSON.parse(readFileSync(join(FIX, 'images.json'), 'utf8')).images
const realCache = new Map()
function realImage(name) {
  if (realCache.has(name)) return realCache.get(name)
  const m = realMeta[name]
  const raw = gunzipSync(readFileSync(join(FIX, `${name}.gray.gz`)))
  assert.equal(createHash('sha256').update(raw).digest('hex'), m.sha256)
  const img = { width: m.width, height: m.height, gray: new Uint8Array(raw.buffer, raw.byteOffset, raw.length) }
  realCache.set(name, img)
  return img
}
const withGray = img => ({ width: img.width, height: img.height, hash: dHash(img), fine: fineSig(img), gray: img.gray })
const sigOnly = img => ({ width: img.width, height: img.height, hash: dHash(img), fine: fineSig(img) })

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
function throwsCode(fn, code) {
  assert.throws(fn, err => {
    assert.ok(err instanceof ImageHashError, `應該丟 ImageHashError，實際是 ${err?.constructor?.name}: ${err?.message}`)
    assert.equal(err.code, code, `錯誤碼應該是 ${code}，實際是 ${err.code}（${err.message}）`)
    return true
  })
}
/** 兩張原圖逐像素：最大差、差 > 2 的像素（規格的定義，直接算）。 */
function pixelTruth(ga, gb, W) {
  let max = 0
  const changed = []
  for (let i = 0; i < ga.length; i++) {
    const d = Math.abs(ga[i] - gb[i])
    if (d > max) max = d
    if (d > 2) changed.push([i % W, Math.floor(i / W)])
  }
  return { max, changed }
}
const inBoxes = (boxes, x, y) => boxes.some(b => b.x <= x && x < b.x + b.w && b.y <= y && y < b.y + b.h)

// ── 2. 完全一樣 → same；只有游標閃一下 → similar ─────────────────────────
describe('same 在原圖上確認：完全一樣 → same；差 ±1～2 → same；游標閃一下、差 3 → similar', () => {
  test('逐位元組相同的兩張真實截圖（07-doc-a、08-text-a）→ same；沒帶原圖灰階 → similar（unverified，外框空的）', () => {
    const a = realImage('07-doc-a'), b = realImage('08-text-a')
    assert.deepEqual(compareImages(withGray(a), withGray(b)), { level: 'same', reason: '', boxes: [] })
    assert.deepEqual(compareImages(sigOnly(a), sigOnly(b)), { level: 'similar', reason: 'unverified', boxes: [] })
    assert.deepEqual(compareImages(withGray(a), sigOnly(b)), { level: 'similar', reason: 'unverified', boxes: [] })
    assert.equal(isNearDuplicate(sigOnly(a), sigOnly(b)), true, '成組不需要原圖')
  })

  test('同一張圖各自加 ±1 雜訊（兩張相差最多 2，不同解碼器的四捨五入）→ same；各自 ±2（相差到 4）→ similar', () => {
    for (const name of ['01-same-a', '03-check-b', '07-doc-a']) {
      const img = realImage(name)
      const noisy = (seed, amp) => {
        const r = rng(seed)
        const g = new Uint8Array(img.gray.length)
        for (let i = 0; i < g.length; i++) g[i] = Math.min(255, Math.max(0, img.gray[i] + Math.floor(r() * (2 * amp + 1)) - amp))
        return withGray({ width: img.width, height: img.height, gray: g })
      }
      for (let seed = 1; seed <= 3; seed++) {
        assert.equal(compareImages(noisy(seed, 1), noisy(seed + 100, 1)).level, 'same', `${name} ±1 雜訊 ${seed}`)
        assert.equal(compareImages(withGray(img), noisy(seed, 1)).level, 'same', `${name} 原圖 vs ±1 雜訊 ${seed}`)
      }
      const c = compareImages(noisy(7, 2), noisy(8, 2))
      assert.equal(c.level, 'similar', `${name} ±2 雜訊`)
      assert.ok(c.boxes.length > 0)
    }
  })

  test('只有游標閃一下（07-doc-a 上畫一條 1×18 像素的游標）→ similar，外框框住游標；很淡的游標（差 3）也是 similar；差 2 → same', () => {
    const img = realImage('07-doc-a')
    const W = img.width
    const caret = v => {
      const g = new Uint8Array(img.gray)
      for (let y = 300; y < 318; y++) g[y * W + 640] = v === null ? g[y * W + 640] : v(g[y * W + 640])
      return withGray({ width: img.width, height: img.height, gray: g })
    }
    const base = withGray(img)
    for (const [label, v, want] of [['黑色游標', () => 20, 'similar'], ['差 3 的游標', p => (p >= 3 ? p - 3 : p + 3), 'similar'], ['差 2', p => (p >= 2 ? p - 2 : p + 2), 'same']]) {
      const c = compareImages(base, caret(v))
      assert.equal(c.level, want, label)
      if (want === 'similar') for (let y = 300; y < 318; y++) assert.ok(inBoxes(c.boxes, 640, y), `${label}：(640, ${y}) 沒被框到：${JSON.stringify(c.boxes)}`)
    }
  })
})

describe('原圖確認的邊角', () => {
  test('像素數不是 4 的倍數（1283×5）：最後一個像素差 3 也看得到；灰階是沒有對齊 4 位元組的 subarray 也一樣', () => {
    const W = 1283, H = 5, n = W * H
    assert.equal(n % 4, 3)
    const ga = new Uint8Array(n).fill(128)
    for (const i of [0, 1, 2, n - 3, n - 2, n - 1]) {
      const gb = new Uint8Array(ga)
      gb[i] = 131
      const a = withGray({ width: W, height: H, gray: ga }), b = withGray({ width: W, height: H, gray: gb })
      assert.ok(a.fine.w < W, '要走原圖確認（細比對每格不只 1 像素）')
      const c = compareImages(a, b)
      assert.equal(c.level, 'similar', `第 ${i} 個像素`)
      assert.ok(inBoxes(c.boxes, i % W, Math.floor(i / W)), `第 ${i} 個像素沒被框到：${JSON.stringify(c.boxes)}`)
      // 沒對齊：前面多塞 1～3 個位元組再取 subarray
      for (const off of [1, 2, 3]) {
        const bufA = new Uint8Array(n + off), bufB = new Uint8Array(n + off)
        bufA.set(ga, off)
        bufB.set(gb, off)
        const c2 = compareImages({ ...a, gray: bufA.subarray(off) }, { ...b, gray: bufB.subarray(off) })
        assert.deepEqual(c2, c, `第 ${i} 個像素、位移 ${off}`)
      }
      gb[i] = 130
      assert.equal(compareImages(a, withGray({ width: W, height: H, gray: gb })).level, 'same', `第 ${i} 個像素差 2`)
    }
  })
})

// ── 3. burstGroups 只有簽章：loadGray 只替候選的那幾對載入 ─────────────────
describe('burstGroups 的 loadGray：只替細比對看不出差別的那幾對載入原圖，每張最多一次', () => {
  const W = 1280, H = 860
  const mk = (fill, dots = []) => {
    const g = new Uint8Array(W * H).fill(fill)
    for (const [x, y, v] of dots) g[y * W + x] = v
    return { width: W, height: H, gray: g }
  }
  const IMG = {
    k: mk(200), // 留下的那張（最新）
    same1: mk(200), // 一模一樣
    faint: mk(200, [[400, 300, 203]]), // 原圖上一個像素差 3（細比對看不出來）
    typed: mk(200, Array.from({ length: 64 }, (_, i) => [600 + (i % 8), 400 + (i >> 3), 0])), // 細比對就看得到（8×8 的黑塊）
    other: mk(40), // 整張不一樣
    same2: mk(200),
  }
  const T = { k: 100, same1: 90, faint: 80, typed: 70, other: 60, same2: 50 }
  const items = (keys = Object.keys(IMG), gray = false) => keys.map(id => ({ id, ...sigOnly(IMG[id]), ...(gray ? { gray: IMG[id].gray } : {}), takenAt: T[id] }))

  test('載入的只有候選的那幾對（一樣、差 3 的那兩張與留下的那張），每張一次；結果跟帶 item.gray 一樣', () => {
    const calls = []
    const g = burstGroups(items(), { loadGray: id => { calls.push(id); return IMG[id] } })
    assert.deepEqual(calls, ['k', 'same1', 'faint', 'same2'], '細比對已經看到變化的（typed）、不成組的（other）不載入')
    assert.equal(g.length, 1)
    assert.equal(g[0].keep, 'k')
    assert.equal(g[0].level, 'similar')
    assert.deepEqual(g[0].members.map(m => [m.id, m.level]), [['same1', 'same'], ['faint', 'similar'], ['typed', 'similar'], ['same2', 'same']])
    assert.deepEqual(g[0].members[1].boxes, [{ x: 400, y: 300, w: 2, h: 2 }], '差 3 的那個像素被框到（整格往外包）')
    assert.deepEqual(burstGroups(items(undefined, true)), g, 'item 自己帶 gray：結果一樣')
    // 每一張都帶 gray 時不呼叫 loadGray
    assert.deepEqual(burstGroups(items(undefined, true), { loadGray: () => assert.fail('不該呼叫') }), g)
  })

  test('留下的那張讀不到（loadGray 回 null）→ 候選都判 similar（外框空的），也不再載入成員', () => {
    const calls = []
    const g = burstGroups(items(['k', 'same1', 'same2']), { loadGray: id => { calls.push(id); return id === 'k' ? null : IMG[id] } })
    assert.deepEqual(calls, ['k'])
    assert.deepEqual(g, [{ keep: 'k', level: 'similar', drop: ['same1', 'same2'], members: [{ id: 'same1', level: 'similar', boxes: [] }, { id: 'same2', level: 'similar', boxes: [] }] }])
    // 成員讀不到（undefined 也算讀不到）→ 只有那一張 similar
    const g2 = burstGroups(items(['k', 'same1', 'same2']), { loadGray: id => (id === 'same1' ? undefined : IMG[id]) })
    assert.deepEqual(g2[0].members.map(m => [m.id, m.level, m.boxes]), [['same1', 'similar', []], ['same2', 'same', []]])
    // 沒給 loadGray、也沒帶 gray → 沒辦法確認
    const g3 = burstGroups(items(['k', 'same1']))
    assert.deepEqual(g3, [{ keep: 'k', level: 'similar', drop: ['same1'], members: [{ id: 'same1', level: 'similar', boxes: [] }] }])
  })

  test('壞輸入：loadGray 不是函式 → BAD_INPUT；回的圖尺寸不對或不是灰階圖 → BAD_IMAGE；loadGray 自己丟的錯照原樣丟出；item.gray 長度不對 → BAD_IMAGE', () => {
    throwsCode(() => burstGroups(items(['k', 'same1']), { loadGray: 'no' }), 'BAD_INPUT')
    throwsCode(() => burstGroups(items(['k', 'same1']), { loadGray: () => ({ width: W, height: H - 1, gray: new Uint8Array(W * (H - 1)) }) }), 'BAD_IMAGE')
    throwsCode(() => burstGroups(items(['k', 'same1']), { loadGray: () => ({ width: W, height: H, gray: new Uint8Array(5) }) }), 'BAD_IMAGE')
    throwsCode(() => burstGroups(items(['k', 'same1']), { loadGray: () => 42 }), 'BAD_IMAGE')
    const boom = new Error('讀檔失敗')
    assert.throws(() => burstGroups(items(['k', 'same1']), { loadGray: () => { throw boom } }), e => e === boom)
    const bad = { id: 'x', ...sigOnly(IMG.k), gray: new Uint8Array(10), takenAt: 1 }
    throwsCode(() => burstGroups([bad]), 'BAD_IMAGE')
    throwsCode(() => compareImages(bad, sigOnly(IMG.k)), 'BAD_IMAGE')
    throwsCode(() => compareImages({ ...sigOnly(IMG.k), gray: [1, 2, 3] }, sigOnly(IMG.k)), 'BAD_IMAGE')
    // null 跟 undefined 都算沒帶
    assert.equal(compareImages({ ...sigOnly(IMG.k), gray: null }, withGray(IMG.same1)).reason, 'unverified')
  })

  test('原圖灰階的每個欄位只讀一次：loadGray 回的物件用 getter 驗證後換掉也不影響', () => {
    let reads = 0
    const tricky = { width: W, height: H, get gray() { reads++; return reads === 1 ? IMG.k.gray : new Uint8Array(3) } }
    const g = burstGroups(items(['k', 'same1']), { loadGray: id => (id === 'k' ? tricky : IMG[id]) })
    assert.equal(g[0].level, 'same')
    assert.equal(reads, 1)
  })
})

// ── 4. 結構化隨機：跟規格的定義（逐像素最大差）對照 ──────────────────────────
describe('結構化隨機：same ⇔ 原圖上每個像素的差都 ≤ 2；原圖確認出來的外框包住每一個變了的像素', () => {
  test('600 組隨機圖（每格 1 像素與每格 2～3 像素兩種）× 隨機改幾個像素（差 1～6）', () => {
    const r = rng(20260919)
    const tally = { same: 0, similar: 0, different: 0 }
    for (let round = 0; round < 600; round++) {
      const big = round % 3 === 0
      const W = big ? 700 + Math.floor(r() * 700) : 40 + Math.floor(r() * 300)
      const H = big ? 300 + Math.floor(r() * 300) : 30 + Math.floor(r() * 200)
      const ga = new Uint8Array(W * H)
      // 背景：幾塊隨機灰階的方塊（像介面）
      const bg = 60 + Math.floor(r() * 190)
      ga.fill(bg)
      for (let k = 0; k < 6; k++) {
        const x0 = Math.floor(r() * W), y0 = Math.floor(r() * H), bw = 1 + Math.floor(r() * W / 3), bh = 1 + Math.floor(r() * H / 3), v = Math.floor(r() * 256)
        for (let y = y0; y < Math.min(H, y0 + bh); y++) ga.fill(v, y * W + x0, y * W + Math.min(W, x0 + bw))
      }
      const gb = new Uint8Array(ga)
      const mode = round % 5
      const n = mode === 0 ? 0 : 1 + Math.floor(r() * 12)
      const amp = mode === 1 ? 2 : mode === 2 ? 3 : 1 + Math.floor(r() * 6)
      for (let k = 0; k < n; k++) {
        const i = Math.floor(r() * ga.length)
        const d = (r() < 0.5 ? -1 : 1) * (1 + Math.floor(r() * amp))
        gb[i] = Math.min(255, Math.max(0, ga[i] + d))
      }
      const A = { width: W, height: H, gray: ga }, B = { width: W, height: H, gray: gb }
      const a = withGray(A), b = withGray(B)
      const c = compareImages(a, b)
      tally[c.level]++
      const truth = pixelTruth(ga, gb, W)
      const label = `round ${round}：${W}×${H}，最大差 ${truth.max}，變了 ${truth.changed.length} 個像素`
      if (truth.max <= SAME_TOL) assert.deepEqual(c, { level: 'same', reason: '', boxes: [] }, label)
      else assert.notEqual(c.level, 'same', label)
      assert.deepEqual(compareImages(b, a).level, c.level, `${label}：對稱`)
      // 細比對看不出差別（每格差 ≤ FINE_FAINT）而原圖有變化：外框是原圖確認出來的，要包住每一個變了的像素
      const fr = fineCompare(a.fine, b.fine)
      if (c.level === 'similar' && fr.faint === 0) for (const [x, y] of truth.changed) assert.ok(inBoxes(c.boxes, x, y), `${label}：(${x}, ${y}) 沒被框到`)
      // 細比對看得到的淡變化（含強格）時：細比對上每一格變了的（第五輪起不只淡變化：每格 1 像素時差 > SAME_TOL，
      // 每格不只 1 像素時差 ≠ 0）換算回原圖都在某個框裡
      if (c.level === 'similar' && fr.faint > 0) {
        const { w, h, px: FA } = a.fine, FB = b.fine.px
        const tol = w === W && h === H ? SAME_TOL : 0
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const d = FA[y * w + x] - FB[y * w + x]
          if (d > tol || d < -tol) {
            const px0 = Math.floor(x * W / w), px1 = Math.ceil((x + 1) * W / w) - 1, py0 = Math.floor(y * H / h), py1 = Math.ceil((y + 1) * H / h) - 1
            assert.ok(inBoxes(c.boxes, px0, py0) && inBoxes(c.boxes, px1, py1), `${label}：細比對 (${x}, ${y}) 變了（差 ${d}）沒被框到`)
          }
        }
      }
      for (const bx of c.boxes) assert.ok(bx.x >= 0 && bx.y >= 0 && bx.w > 0 && bx.h > 0 && bx.x + bx.w <= W && bx.y + bx.h <= H, `${label}：框超出畫面`)
      // burstGroups（loadGray）跟 compareImages 一樣
      const g = burstGroups([{ id: 'b', ...sigOnly(B), takenAt: 2 }, { id: 'a', ...sigOnly(A), takenAt: 1 }], { loadGray: id => (id === 'a' ? A : B) })
      if (c.level === 'different') assert.deepEqual(g, [], label)
      else assert.deepEqual(g[0].members[0], { id: 'a', level: c.level, boxes: compareImages(b, a).boxes }, label)
    }
    assert.ok(tally.same > 100 && tally.similar > 100, JSON.stringify(tally))
  })
})

test('只重算方塊蓋到的格子（測試用的加速）有跟 dHash／fineSig 直接算的比對過', () => {
  assert.ok(incrementalCheckCount() >= 40, `比對了 ${incrementalCheckCount()} 張`)
})
