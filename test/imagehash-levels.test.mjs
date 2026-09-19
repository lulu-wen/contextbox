// imagehash 第三輪起：比對分三級（same／similar／different）＋每一處變化的外框。
//   1. 第二輪對抗式驗證判錯的反例（逐位元組重現，fixtures/imagehash/synth3）：
//      多行字整段不同 → different；短回覆、行事曆、成績列、淺灰小字 → 不可以是 same
//   2. 游標與細長的字：第四輪起游標移動、游標一閃、多打一個「l」「|」都不可以是 same（沒有例外）
//   3. 8 組標準答案的等級與外框；會動的浮動按鈕裡數字變了不可以是 same
//   4. 每一條門檻用字面值測邊界（放寬就會紅）；same 只給原圖上每個像素的差都 ≤ SAME_TOL 的
//   5. dHash 碰到細長的合法圖（1×4000 萬）要算得出來
// 第三輪驗證判成 same 的反例與 loadGray 在 imagehash-round4.test.mjs。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ImageHashError,
  resizeGray,
  dHash,
  fineSig,
  fineCompare,
  compareImages,
  isNearDuplicate,
  burstGroups,
  FINE_STRONG,
  FINE_FAINT,
  FINE_MAX_FAINT_BP,
  BAND_EDGE,
  BAND_BLANK_EDGES,
  BAND_MIN_ROWS,
  BAND_WIDE,
  BAND_LINES,
  BAND_VALLEY_NUM,
  BAND_VALLEY_DEN,
  SAME_TOL,
} from '../core/imagehash.ts'

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'imagehash')
const S3 = join(FIX, 'synth3')
const synth3 = JSON.parse(readFileSync(join(S3, 'synth3.json'), 'utf8'))

// ── 讀合成圖：底圖＋貼回方塊，最後驗 sha256 ────────────────────────
const rawCache = new Map() // 只留最近用到的幾張底圖（4K 一張 8 MB）
function synthRaw(name) {
  if (rawCache.has(name)) {
    const g = rawCache.get(name)
    rawCache.delete(name)
    rawCache.set(name, g)
    return g
  }
  const m = synth3.images[name]
  assert.ok(m, `synth3 缺 ${name}`)
  let g
  if (!m.base) g = new Uint8Array(gunzipSync(readFileSync(join(S3, `${name}.gray.gz`))))
  else {
    g = new Uint8Array(m.width * m.height)
    g.set(synthRaw(m.base))
    if (m.patch) {
      const [px, py, pw, ph] = m.patch
      const p = gunzipSync(readFileSync(join(S3, `${name}.patch.gz`)))
      assert.equal(p.length, pw * ph, `${name} 的方塊大小不對`)
      for (let y = 0; y < ph; y++) g.set(p.subarray(y * pw, (y + 1) * pw), (py + y) * m.width + px)
    }
  }
  assert.equal(createHash('sha256').update(g).digest('hex'), m.sha256, `${name} 重組後內容不對`)
  // 底圖會被別張重複用到，留著；其他張算完指紋就不需要原圖
  if (!m.base) {
    rawCache.set(name, g)
    if (rawCache.size > 6) rawCache.delete(rawCache.keys().next().value)
  }
  return g
}
const infoCache = new Map()
function synthInfo(name) {
  if (infoCache.has(name)) return infoCache.get(name)
  const m = synth3.images[name]
  const img = { width: m.width, height: m.height, gray: synthRaw(name) }
  const info = { width: m.width, height: m.height, hash: dHash(img), fine: fineSig(img) }
  infoCache.set(name, info)
  return info
}

// ── 真實截圖（跟 imagehash.test.mjs 同一份 fixtures）──────────────────
const realMeta = JSON.parse(readFileSync(join(FIX, 'images.json'), 'utf8')).images
const expectedPairs = JSON.parse(readFileSync(join(FIX, 'expected.json'), 'utf8'))
const realRawCache = new Map()
function realImage(name) {
  if (realRawCache.has(name)) return realRawCache.get(name)
  const m = realMeta[name]
  const raw = gunzipSync(readFileSync(join(FIX, `${name}.gray.gz`)))
  assert.equal(createHash('sha256').update(raw).digest('hex'), m.sha256)
  const img = { width: m.width, height: m.height, gray: new Uint8Array(raw.buffer, raw.byteOffset, raw.length) }
  realRawCache.set(name, img)
  return img
}
const infoOf = img => ({ width: img.width, height: img.height, hash: dHash(img), fine: fineSig(img) })
const realInfoCache = new Map()
function realInfo(name) {
  if (!realInfoCache.has(name)) realInfoCache.set(name, infoOf(realImage(name)))
  return realInfoCache.get(name)
}
const stem = f => f.replace(/\.png$/, '')

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

/** w×h 的細比對資料；blocks 是 [x, y, 寬, 高, 值] 的方塊（格子座標），底色 base。 */
function sig(w, h, blocks = [], base = 0) {
  const px = new Uint8Array(w * h).fill(base)
  for (const [x, y, bw, bh, v = 255] of blocks) for (let yy = y; yy < y + bh; yy++) px.fill(v, yy * w + x, yy * w + x + bw)
  return { w, h, px }
}
const regionText = r => r.regions.map(g => `${g.kind}@${g.x},${g.y} ${g.w}×${g.h}（強格 ${g.strong}）`).join('；')
const rep = r => `等級 ${r.level}${r.reason ? '（' + r.reason + '）' : ''}；強格 ${(r.strong * 10000 / r.cells).toFixed(1)}‱、淡變化 ${(r.faint * 10000 / r.cells).toFixed(1)}‱、${r.spots} 處、最多 ${r.lines} 條字行；${regionText(r)}${r.notSame ? '；不是 same：' + r.notSame : ''}`

// ── 1. 第二輪的反例 ──────────────────────────────────────────────
describe('第二輪對抗式驗證判錯的反例（逐位元組重現）', () => {
  const byCat = new Map()
  for (const p of synth3.pairs) {
    const cat = p.name.split('-')[0]
    if (!byCat.has(cat)) byCat.set(cat, [])
    byCat.get(cat).push(p)
  }
  const title = {
    A1: '泡泡裡的多行訊息整段不同（1920～4K、行高 1.35／1.5）→ different',
    A2: '程式碼前 6 行換成別的短行 → different',
    A3: '英文便條 5 行整段不同 → different',
    D1: '多行訊息 2～10 行整段不同（行高 1.3～1.7）→ different',
    E1: '1920×1080 多行訊息整段不同（隨機 4 組字）→ different',
    I: '桌面上窄聊天視窗的 60 多字訊息整段不同 → different',
    B: '最後一則短回覆不同（Approved→Rejected、同意→不同意、收到→已取消……）→ 不可以是 same',
    D: '淺灰小字（#999／#aaa／#bbb）整行不同 → 不可以是 same',
    F2: '行事曆事件的名稱、時間、教室不同 → 不可以是 same',
    G: '成績表同一列 6 科分數不同 → 不可以是 same',
    C: '游標移動、游標一閃、多打一個細長的字 → 都不可以是 same（第四輪拿掉游標的例外）',
  }
  for (const [cat, pairs] of byCat) {
    test(`${cat}：${title[cat] ?? cat}（${pairs.length} 組）`, t => {
      const bad = []
      const tally = { same: 0, similar: 0, different: 0 }
      for (const p of pairs) {
        // 帶原圖灰階：same 要在原圖上確認
        const a = { ...synthInfo(p.a), gray: synthRaw(p.a) }, b = { ...synthInfo(p.b), gray: synthRaw(p.b) }
        const c = compareImages(a, b)
        tally[c.level]++
        const ok = p.expect === 'different' ? c.level === 'different' : p.expect === 'same' ? c.level === 'same' : c.level !== 'same'
        if (!ok) bad.push(`${p.name}（${p.why}）：${rep(fineCompare(a.fine, b.fine, a.width / a.fine.w))}`)
        // 對稱
        assert.equal(compareImages(b, a).level, c.level, `${p.name} 要對稱`)
        if (p.expect === 'different') assert.equal(isNearDuplicate(a, b), false, `${p.name} 不可以成組`)
      }
      infoCache.clear()
      t.diagnostic(`same ${tally.same}、similar ${tally.similar}、different ${tally.different}`)
      assert.deepEqual(bad, [], `判錯 ${bad.length} 組`)
    })
  }
})

// ── 2. 8 組標準答案的等級與外框 ─────────────────────────────────────
describe('8 組標準答案：完全一樣（其實有浮動按鈕在動畫）、多打一個字、勾選框 → similar；其他 → different', () => {
  // 第四輪：same 只給原圖上幾乎沒有像素變化的，沒有例外。第 1 組「完全一樣」的兩張，三個浮動按鈕在動畫
  //（垃圾桶變色放大、齒輪與復原按鈕上下跳），原圖上 4875 個像素差 > 2，所以是 similar（規格：按鈕跳 1 像素也是 similar）。
  // 第五輪預想表把標準答案第 1 組正式改成 similar；真正逐位元組相同的一對（07-doc-a／08-text-a）是 same（imagehash-round4.test.mjs）
  const LEVEL = ['similar', 'similar', 'similar', 'different', 'different', 'different', 'different', 'different']
  expectedPairs.forEach((p, i) => {
    test(`第 ${i + 1} 組：${p.why} → ${LEVEL[i]}`, t => {
      const a = { ...realInfo(stem(p.a)), gray: realImage(stem(p.a)).gray }, b = { ...realInfo(stem(p.b)), gray: realImage(stem(p.b)).gray }
      if (a.width === b.width && a.height === b.height) t.diagnostic(rep(fineCompare(a.fine, b.fine, a.width / a.fine.w)))
      const c = compareImages(a, b)
      assert.equal(c.level, LEVEL[i])
      assert.equal(compareImages(b, a).level, LEVEL[i], '要對稱')
      assert.equal(isNearDuplicate(a, b), LEVEL[i] !== 'different')
    })
  })

  test('灰階差 ±1（不同解碼器的四捨五入）不會改變任何一組的等級（20 種雜訊）', () => {
    const perturb = (img, seed) => {
      const r = rng(seed)
      const g = new Uint8Array(img.gray.length)
      for (let i = 0; i < g.length; i++) g[i] = Math.min(255, Math.max(0, img.gray[i] + Math.floor(r() * 3) - 1))
      return { ...infoOf({ width: img.width, height: img.height, gray: g }), gray: g }
    }
    for (let seed = 1; seed <= 20; seed++) {
      for (let i = 0; i < 3; i++) {
        const p = expectedPairs[i]
        const na = perturb(realImage(stem(p.a)), seed * 7 + i), nb = perturb(realImage(stem(p.b)), seed * 13 + i)
        const c = compareImages(na, nb)
        assert.equal(c.level, LEVEL[i], `第 ${i + 1} 組，雜訊 ${seed}`)
      }
    }
  })

  test('外框是原圖像素座標：多打的「王」、勾選框、「8.8 KB → 5.9 KB」、按鈕上的數字都被框到，細比對上每一格變了的（差 ≠ 0，第五輪起不只強格與淡變化）都在某個框裡', () => {
    // 開發時逐像素比對找到的位置（灰階差 > 32 的像素範圍，x0-x1、y0-y1 含端點）
    const must = {
      1: [[443, 456, 375, 386]],
      2: [[335, 352, 208, 225], [457, 481, 717, 728], [354, 361, 719, 728], [400, 407, 771, 776]],
    }
    for (const i of [0, 1, 2]) {
      const p = expectedPairs[i]
      const a = realInfo(stem(p.a)), b = realInfo(stem(p.b))
      const c = compareImages(a, b)
      assert.ok(c.boxes.length > 0)
      for (const bx of c.boxes) {
        assert.ok(Number.isInteger(bx.x) && Number.isInteger(bx.y) && bx.w > 0 && bx.h > 0, JSON.stringify(bx))
        assert.ok(bx.x >= 0 && bx.y >= 0 && bx.x + bx.w <= a.width && bx.y + bx.h <= a.height, `框超出畫面：${JSON.stringify(bx)}`)
      }
      const inside = (x0, x1, y0, y1) => c.boxes.some(bx => bx.x <= x0 && x1 < bx.x + bx.w && bx.y <= y0 && y1 < bx.y + bx.h)
      for (const [x0, x1, y0, y1] of must[i] ?? []) assert.ok(inside(x0, x1, y0, y1), `第 ${i + 1} 組：${x0}-${x1}×${y0}-${y1} 沒被框到；框：${JSON.stringify(c.boxes)}`)
      // 細比對上每一格變了的（1280 寬每格 2×2 像素：差 ≠ 0）換算回原圖都在某個框裡（第五輪：外框要涵蓋整處變化，不只強格與淡變化）
      const { w, h, px: A } = a.fine, B = b.fine.px
      let n = 0
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const d = A[y * w + x] - B[y * w + x]
        if (d !== 0) {
          n++
          const x0 = Math.floor(x * a.width / w), x1 = Math.ceil((x + 1) * a.width / w) - 1
          const y0 = Math.floor(y * a.height / h), y1 = Math.ceil((y + 1) * a.height / h) - 1
          assert.ok(inside(x0, x1, y0, y1), `第 ${i + 1} 組：${d > FINE_STRONG || d < -FINE_STRONG ? '強格' : d > FINE_FAINT || d < -FINE_FAINT ? '淡變化' : '差 1～4 的格子'} (${x},${y}) 沒被框到`)
        }
      }
      assert.ok(n > 0)
      // 第 1 組：三個浮動按鈕各一框（按鈕旁的陰影、光暈這種淡變化併進按鈕的框，併完框變大再併一次，不另外冒出小框）
      if (i === 0) assert.equal(c.boxes.length, 3, JSON.stringify(c.boxes))
      // 框要緊：多打一個字那一框不可以大於 40×40 像素
      if (i === 1) assert.ok(c.boxes.some(bx => bx.x <= 443 && bx.x + bx.w > 456 && bx.w <= 40 && bx.h <= 40), JSON.stringify(c.boxes))
    }
  })

  test('外框換算：原圖寬不是格數的整數倍時，整格往外包（1281 寬 → 640 格，第 10 格是像素 20～22）', () => {
    const fine = { w: 640, h: 430, px: new Uint8Array(640 * 430) }
    const px = new Uint8Array(640 * 430)
    px[100 * 640 + 10] = 255 // 第 10 格、第 100 列
    const c = compareImages({ width: 1281, height: 860, hash: '0123456789abcdef', fine }, { width: 1281, height: 860, hash: '0123456789abcdef', fine: { w: 640, h: 430, px } })
    // x：⌊10 × 1281 ÷ 640⌋ = 20 到 ⌈11 × 1281 ÷ 640⌉ = 23（不含）；y：860 ÷ 430 = 2 像素一格
    assert.deepEqual(c, { level: 'similar', reason: '', boxes: [{ x: 20, y: 200, w: 3, h: 2 }] })
  })

  test('細比對資料的每個欄位只讀一次：px 的 getter 驗證後換成別的陣列也不影響', () => {
    const ok = new Uint8Array(100 * 100)
    let reads = 0
    const tricky = { w: 100, h: 100, get px() { reads++; return reads === 1 ? ok : new Uint8Array(3).fill(255) } }
    const a = { width: 100, height: 100, hash: '0123456789abcdef', fine: { w: 100, h: 100, px: ok } }
    assert.deepEqual(compareImages(a, { width: 100, height: 100, hash: '0123456789abcdef', fine: tricky }), { level: 'same', reason: '', boxes: [] })
    assert.equal(reads, 1)
    reads = 0
    // 第五輪起 fineCompare 單獨呼叫不回 same（手上只有細比對）：一模一樣的是 similar／unverified
    assert.deepEqual([fineCompare(a.fine, tricky).level, reads], ['similar', 1])
  })

  test('淡變化的外框：碰到變化處的併進它的框；框變大之後才碰到的也要併（不管掃描的先後）；離很遠的另外框', () => {
    // 變化處 G：x 100～109、y 100～105（差 100）。淡變化（差 10）：B 在 G 下方隔一列（x 94～109、y 107～112，跟 G 不相連但在 2 格內）；
    // A 在左邊（x 85～92、y 104～112），比 B 早開始（掃描時先遇到 A），離 G 7 格，只碰得到併了 B 之後的框；C 離很遠
    const blocks = [[100, 100, 10, 6, 100], [94, 107, 16, 6, 10], [85, 104, 8, 9, 10], [300, 300, 6, 3, 10]]
    const r = fineCompare(sig(400, 400), sig(400, 400, blocks))
    assert.equal(r.level, 'similar')
    assert.deepEqual(r.regions.map(g => [g.kind, g.x, g.y, g.w, g.h]), [['change', 85, 100, 25, 13], ['faint', 300, 300, 6, 3]])
  })

  test('different 不回外框（不成組，面板用不到）', () => {
    const p = expectedPairs[3]
    assert.deepEqual(compareImages(realInfo(stem(p.a)), realInfo(stem(p.b))), { level: 'different', reason: 'area', boxes: [] })
    const q = expectedPairs[5]
    assert.deepEqual(compareImages(realInfo(stem(q.a)), realInfo(stem(q.b))), { level: 'different', reason: 'size', boxes: [] })
    const r = expectedPairs[4]
    assert.deepEqual(compareImages(realInfo(stem(r.a)), realInfo(stem(r.b))), { level: 'different', reason: 'hash', boxes: [] })
  })
})

describe('會動的浮動按鈕裡數字變了：不可以是 same', () => {
  // 01-same-b 的垃圾桶徽章「3」換成 05-scroll-a 的「1」（05-scroll-a 的垃圾桶高 5 像素）
  const badge = () => {
    const src = realImage('01-same-b'), from = realImage('05-scroll-a')
    const g = new Uint8Array(src.gray)
    for (let y = 689; y < 701; y++) for (let x = 1029; x < 1038; x++) g[y * 1280 + x] = from.gray[(y - 5) * 1280 + x]
    return infoOf({ width: 1280, height: 860, gray: g })
  }
  test('01-same-a（按鈕放大、徽章 3）對「01-same-b 但徽章改成 1」→ similar；只換徽章 → similar', t => {
    const b = badge()
    const a = realInfo('01-same-a')
    const r = fineCompare(a.fine, b.fine, 2)
    t.diagnostic(rep(r))
    assert.equal(compareImages(a, b).level, 'similar')
    assert.equal(compareImages(realInfo('01-same-b'), b).level, 'similar')
  })
})

// ── 3. burstGroups 帶等級與外框 ─────────────────────────────────────
describe('burstGroups：每一組帶等級（成員最差的）、每個成員帶等級與外框', () => {
  test('逐位元組相同的兩張（07-doc-a、08-text-a）→ same；有浮動按鈕在動的那組、再加一張多打一個字的 → 整組 similar，成員各自的等級', () => {
    const loadGray = id => realImage({ x: '07-doc-a', y: '08-text-a', a: '01-same-a', b: '01-same-b', c: '02-typed-b' }[id])
    const x = { id: 'x', ...realInfo('07-doc-a'), takenAt: 1000 }
    const y = { id: 'y', ...realInfo('08-text-a'), takenAt: 2000 }
    assert.deepEqual(burstGroups([x, y], { loadGray }), [{ keep: 'y', level: 'same', drop: ['x'], members: [{ id: 'x', level: 'same', boxes: [] }] }])
    const a = { id: 'a', ...realInfo('01-same-a'), takenAt: 1000 }
    const b = { id: 'b', ...realInfo('01-same-b'), takenAt: 2000 }
    const g1 = burstGroups([a, b], { loadGray })
    assert.equal(g1.length, 1)
    assert.equal(g1[0].keep, 'b')
    assert.equal(g1[0].level, 'similar', '浮動按鈕在動：原圖上有變化，不是 same')
    assert.deepEqual(g1[0].drop, ['a'])
    assert.deepEqual(g1[0].members.map(m => [m.id, m.level]), [['a', 'similar']])
    assert.deepEqual(g1[0].members[0].boxes, compareImages(b, a).boxes)
    // 框到三個浮動按鈕（1003～1248 × 656～817 是原圖上差 > 2 的範圍）
    assert.ok(g1[0].members[0].boxes.every(bx => bx.x >= 990 && bx.y >= 640), JSON.stringify(g1[0].members[0].boxes))
    // 新的是多打一個字那張：01-same-b 跟它是 similar（王），01-same-a 也是
    const c = { id: 'c', ...realInfo('02-typed-b'), takenAt: 3000 }
    const g2 = burstGroups([a, b, c], { loadGray })
    assert.equal(g2.length, 1)
    assert.equal(g2[0].keep, 'c')
    assert.equal(g2[0].level, 'similar')
    assert.deepEqual(g2[0].members.map(m => [m.id, m.level]), [['b', 'similar'], ['a', 'similar']])
    for (const m of g2[0].members) assert.ok(m.boxes.some(bx => bx.x <= 443 && bx.x + bx.w > 456 && bx.y <= 375 && bx.y + bx.h > 386), `${m.id} 要框到「王」`)
  })

  test('different 絕對不成組：8 組標準答案裡的 5 組各自丟進去都不成組', () => {
    for (const i of [3, 4, 5, 6, 7]) {
      const p = expectedPairs[i]
      assert.deepEqual(burstGroups([{ id: 'x', ...realInfo(stem(p.a)), takenAt: 0 }, { id: 'y', ...realInfo(stem(p.b)), takenAt: 1 }]), [])
    }
  })

  test('群組等級取最差：一張 same、一張 similar → similar；兩張都 same → same', () => {
    const base = sig(100, 100)
    const mk = (id, t, fine) => ({ id, width: 100, height: 100, hash: '0123456789abcdef', fine, takenAt: t })
    const keep = mk('k', 10, base)
    const same = mk('s', 5, base)
    const similar = mk('m', 4, sig(100, 100, [[10, 10, 4, 4]]))
    const g = burstGroups([keep, same, similar])
    assert.deepEqual(g.map(x => [x.keep, x.level, x.drop, x.members.map(m => [m.id, m.level])]), [['k', 'similar', ['s', 'm'], [['s', 'same'], ['m', 'similar']]]])
    const g2 = burstGroups([keep, same])
    assert.deepEqual(g2.map(x => [x.keep, x.level, x.members.map(m => [m.id, m.level, m.boxes])]), [['k', 'same', [['s', 'same', []]]]])
    // similar 的外框：4×4 格、細比對就是原圖（100×100）→ 像素座標一樣
    assert.deepEqual(g[0].members[1].boxes, [{ x: 10, y: 10, w: 4, h: 4 }])
  })
})

// ── 4. 門檻用字面值測邊界 ───────────────────────────────────────────
describe('same 的門檻（字面值，放寬就會紅）：原圖上每個像素的差都 ≤ 2 才是 same，沒有例外', () => {
  test('原圖上差 2 以內 → same；差 3 → similar（pixels，框出來）；差 5 → 細比對就看得到的淡變化（faint）', () => {
    assert.deepEqual([SAME_TOL, FINE_FAINT], [2, 4])
    // 100×100 格、每格 1 像素（細比對就是原圖）
    const at = v => fineCompare(sig(100, 100, [], 200), sig(100, 100, [[20, 20, 30, 3, 200 + v]], 200))
    // same 要 compareImages 才能說（100×100 的圖，細比對就是原圖）；fineCompare 單獨呼叫最多 similar／unverified（第五輪）
    const cmp = v => compareImages({ width: 100, height: 100, hash: '0123456789abcdef', fine: sig(100, 100, [], 200) }, { width: 100, height: 100, hash: '0123456789abcdef', fine: sig(100, 100, [[20, 20, 30, 3, 200 + v]], 200) })
    assert.deepEqual(cmp(2), { level: 'same', reason: '', boxes: [] })
    assert.deepEqual(cmp(-2), { level: 'same', reason: '', boxes: [] })
    assert.deepEqual(cmp(3), { level: 'similar', reason: '', boxes: [{ x: 20, y: 20, w: 30, h: 3 }] })
    assert.deepEqual([at(2).level, at(2).notSame, at(2).pixels, at(2).regions], ['similar', 'unverified', 0, []])
    assert.deepEqual([at(-2).level, at(-2).notSame, at(-2).pixels], ['similar', 'unverified', 0])
    assert.deepEqual([at(3).level, at(3).notSame, at(3).pixels, at(3).faint], ['similar', 'pixels', 90, 0])
    assert.deepEqual(at(3).regions.map(g => [g.kind, g.x, g.y, g.w, g.h]), [['pixels', 20, 20, 30, 3]])
    assert.deepEqual([at(-3).level, at(-3).notSame], ['similar', 'pixels'])
    assert.deepEqual([at(4).level, at(4).notSame, at(4).faint], ['similar', 'pixels', 0])
    assert.deepEqual([at(5).level, at(5).faint, at(5).notSame], ['similar', 90, 'faint'])
    assert.deepEqual(at(5).regions.map(g => [g.kind, g.x, g.y, g.w, g.h]), [['faint', 20, 20, 30, 3]])
    // 只有一個像素差 3 也不是 same
    const one = fineCompare(sig(100, 100, [], 200), sig(100, 100, [[70, 80, 1, 1, 203]], 200))
    assert.deepEqual([one.level, one.pixels, one.regions.map(g => [g.kind, g.x, g.y, g.w, g.h])], ['similar', 1, [['pixels', 70, 80, 1, 1]]])
  })

  test('每格不只 1 像素時，細比對看不出差別也只能說 similar（unverified）：要帶原圖灰階才能確認', () => {
    const r = fineCompare(sig(100, 100, [], 200), sig(100, 100, [], 200), 2)
    assert.deepEqual([r.level, r.notSame, r.pixels, r.regions], ['similar', 'unverified', -1, []])
    // 第五輪：每格 1 像素（含預設）也一樣，fineCompare 單獨呼叫不回 same；pixels 照樣回報
    for (const cellPx of [undefined, 1]) {
      const r1 = fineCompare(sig(100, 100, [], 200), sig(100, 100, [], 200), cellPx)
      assert.deepEqual([r1.level, r1.notSame, r1.pixels, r1.regions], ['similar', 'unverified', 0, []])
    }
  })

  test('淡變化面積 > 萬分之 150 → different（整頁低對比的東西都變了）', () => {
    assert.equal(FINE_MAX_FAINT_BP, 150)
    const at = n => fineCompare(sig(100, 100, [], 100), sig(100, 100, [[0, 0, 10, 15, 110], [10, 0, n - 150, 1, 110]], 100))
    assert.deepEqual([at(150).level, at(150).faint], ['similar', 150])
    assert.deepEqual([at(151).level, at(151).reason], ['different', 'area'])
  })

  test('沒有「在動的東西」的例外：方框平移 2 格（強格 100 多格、平移後完全對得上）→ similar', () => {
    const ring = (x, y, L) => sig(400, 400, [[x, y, L, 2], [x, y + L - 2, L, 2], [x, y, 2, L], [x + L - 2, y, 2, L]], 0)
    for (const [L, d] of [[14, 2], [20, 1], [40, 4]]) {
      const r = fineCompare(ring(100, 100, L), ring(100 + d, 100, L))
      assert.ok(r.strong >= 50, rep(r))
      assert.deepEqual([r.level, r.notSame], ['similar', 'change'], `邊長 ${L}、移 ${d} 格：${rep(r)}`)
    }
  })

  test('沒有游標的例外：游標從一處移到另一處（一條消失、一條出現）、游標一閃、多打一個細長的字 → 都是 similar', () => {
    const bars = (list, base = 255) => sig(400, 400, list.map(([x, y, w, h, v]) => [x, y, w, h, v]), base)
    const A = bars([[50, 50, 1, 12, 0]]), B = bars([[90, 50, 1, 12, 0]])
    const moved = fineCompare(A, B)
    assert.deepEqual([moved.level, moved.notSame, moved.regions.map(g => g.kind)], ['similar', 'change', ['change', 'change']])
    assert.equal(fineCompare(A, bars([])).level, 'similar')
    assert.equal(fineCompare(bars([]), bars([[50, 50, 1, 12, 0], [90, 50, 1, 12, 0]])).level, 'similar')
    // 很淡的游標（差 3）也不是 same
    assert.deepEqual([fineCompare(bars([[50, 50, 1, 12, 252]]), bars([])).level, fineCompare(bars([[50, 50, 1, 12, 252]]), bars([])).notSame], ['similar', 'pixels'])
  })

  test('compareImages 帶原圖灰階：細比對看不出來的小變化（1920 寬，一個像素差 20，平均到 3×3 的格子只剩 2）→ similar，外框框住那個像素', () => {
    const W = 1920, H = 1080
    const g1 = new Uint8Array(W * H).fill(240)
    const g2 = new Uint8Array(g1)
    g2[500 * W + 1000] = 220
    const a = { ...infoOf({ width: W, height: H, gray: g1 }), gray: g1 }
    const b = { ...infoOf({ width: W, height: H, gray: g2 }), gray: g2 }
    assert.deepEqual([a.fine.w, a.fine.h], [640, 360])
    const r = fineCompare(a.fine, b.fine, 3)
    assert.deepEqual([r.strong, r.faint, r.notSame], [0, 0, 'unverified'], '細比對看不出來')
    const c = compareImages(a, b)
    assert.equal(c.level, 'similar')
    assert.equal(c.reason, '')
    assert.deepEqual(c.boxes, [{ x: 999, y: 498, w: 3, h: 3 }])
    assert.deepEqual(compareImages(b, a), c, '對稱')
    // 差 2 → same；沒有原圖灰階 → similar（unverified、外框空的）
    g2[500 * W + 1000] = 238
    assert.deepEqual(compareImages(a, { ...b, gray: g2 }), { level: 'same', reason: '', boxes: [] })
    assert.deepEqual(compareImages({ ...a, gray: undefined }, b), { level: 'similar', reason: 'unverified', boxes: [] })
    assert.deepEqual(compareImages(a, { ...b, gray: null }), { level: 'similar', reason: 'unverified', boxes: [] })
  })
})

describe('多行字的判斷（字面值，放寬就會紅）', () => {
  // 「一行字」：A 是隨機黑白格（很多邊），B 是 A 反白（每一格都不一樣，平移也對不上）；行跟行之間留空白列
  const page = (rows, h, which, gapBlack = []) => {
    const s = sig(500, 500, [], 255)
    const r = rng(4242)
    for (const [dy, len] of rows) for (let y = 20 + dy; y < 20 + dy + h; y++) for (let x = 20; x < 20 + len; x++) {
      const v = r() < 0.5 ? 0 : 255
      s.px[y * 500 + x] = which === 0 ? v : 255 - v
    }
    for (const [x, y] of gapBlack) s.px[y * 500 + x] = 0
    return s
  }
  const pair = (rows, h, gapBlack) => fineCompare(page(rows, h, 0, gapBlack), page(rows, h, 1, gapBlack))
  const edges = (s, y, x0, x1) => { let n = 0; for (let x = x0; x < x1; x++) if (Math.abs(s.px[y * 500 + x + 1] - s.px[y * 500 + x]) > BAND_EDGE) n++; return n }

  test('兩行字（中間空一列）整段不同 → different（lines）；整塊外框不寬、只看外框會放過；只有一行 → 不算', () => {
    assert.deepEqual([BAND_EDGE, BAND_BLANK_EDGES, BAND_MIN_ROWS, BAND_LINES], [16, 3, 3, 2])
    // 每行 18 格寬、4 格高，中間空 1 列：整塊 18×9（2.0 倍，不到 2.2）
    const r = pair([[0, 18], [5, 18]], 4)
    assert.deepEqual([r.widestW, r.widestH], [18, 9])
    assert.deepEqual([r.level, r.reason, r.lines], ['different', 'lines', 2], rep(r))
    const one = pair([[0, 8]], 4)
    assert.equal(one.level, 'similar', rep(one))
  })

  test('一行字至少 3 列高（2 列高的兩條細線不算）；寬至少是高的 3 倍（一個方塊字的上半、下半只有 2.3 倍，不算）', () => {
    assert.equal(BAND_WIDE, 3)
    const r = pair([[0, 10], [4, 10]], 3)
    assert.equal(r.reason, 'lines', rep(r))
    const thin = pair([[0, 10], [3, 10]], 2)
    assert.notEqual(thin.reason, 'lines', rep(thin))
    // 3 列高：寬 9（剛好 3 倍，每行 3 個字的段落）算一行字（第四輪改成 ≥）；寬 8（2.67 倍）不算。
    // 用棋盤格（每一列都有 len − 1 個邊，不會被當成空白列），B 是 A 反白
    const checker = (len, which) => {
      const s = sig(500, 500, [], 255)
      for (const dy of [0, 4]) for (let y = 20 + dy; y < 23 + dy; y++) for (let x = 20; x < 20 + len; x++) s.px[y * 500 + x] = ((x + y) % 2 === which) ? 0 : 255
      return s
    }
    const band = len => fineCompare(checker(len, 0), checker(len, 1))
    const nine = band(9)
    assert.deepEqual([nine.widestW, nine.widestH, nine.reason, nine.lines], [9, 7, 'lines', 2], rep(nine))
    const eight = band(8)
    assert.deepEqual([eight.widestW, eight.widestH, eight.lines], [8, 7, 0], rep(eight))
    assert.notEqual(eight.reason, 'lines', rep(eight))
  })

  test('行跟行之間那一列：兩張都 ≤ 3 個邊算空白；更多邊時，兩張都有的邊數 ≤ 字行最多那一列的一半還是行距，多了就連成一塊', () => {
    assert.deepEqual([BAND_VALLEY_NUM, BAND_VALLEY_DEN], [1, 2])
    // 每行 26 格寬、6 格高，中間空 1 列（y = 26）：整塊 26×13（2.0 倍）
    const rows = [[0, 26], [7, 26]]
    const x0 = 20, x1 = 45
    let peak = 0
    for (let y = 20; y < 33; y++) if (y !== 26) peak = Math.max(peak, Math.min(edges(page(rows, 6, 0), y, x0, x1), edges(page(rows, 6, 1), y, x0, x1)))
    // 中間那一列放 k 個孤立的黑點（兩張一樣，不是變化）：每個 2 個邊
    const dots = k => Array.from({ length: k }, (_, i) => [x0 + 1 + 2 * i, 26])
    const gap = k => pair(rows, 6, dots(k))
    assert.equal(edges(page(rows, 6, 0, dots(3)), 26, x0, x1), 6)
    assert.equal(gap(1).reason, 'lines', rep(gap(1))) // 2 個邊：空白列
    const kIn = Math.floor(peak / 4) // 2k ≤ peak / 2
    assert.ok(2 * kIn > BAND_BLANK_EDGES, `字行最多那一列 ${peak} 個邊，要讓相對低谷測得到`)
    assert.equal(gap(kIn).reason, 'lines', `${2 * kIn} 個邊 ≤ ${peak} 的一半：${rep(gap(kIn))}`)
    const kOut = kIn + 1
    assert.ok(4 * kOut > peak)
    const r = gap(kOut)
    assert.notEqual(r.reason, 'lines', `${2 * kOut} 個邊 > ${peak} 的一半：${rep(r)}`)
  })
})

// ── 5. dHash：細長的合法圖 ─────────────────────────────────────────
describe('dHash 與 fineSig：細長的合法圖（png.ts 的上限 4000 萬像素以內）算得出來', () => {
  test('1×4000 萬、2×2000 萬、3×1333 萬：dHash 算得出來，跟同樣內容的短圖一樣', { timeout: 60000 }, () => {
    for (const [W, H, cols] of [[1, 40_000_000, [90]], [2, 20_000_000, [10, 240]], [3, 13_333_333, [0, 128, 255]]]) {
      const g = new Uint8Array(W * H)
      for (let x = 0; x < W; x++) for (let i = x; i < g.length; i += W) g[i] = cols[x]
      const t0 = performance.now()
      const h = dHash({ width: W, height: H, gray: g })
      const took = performance.now() - t0
      const short = new Uint8Array(W * 16)
      for (let i = 0; i < short.length; i++) short[i] = cols[i % W]
      assert.equal(h, dHash({ width: W, height: 16, gray: short }), `${W}×${H}`)
      assert.ok(took < 5000, `${W}×${H} 花了 ${Math.round(took)} ms`)
      const f = fineSig({ width: W, height: H, gray: g })
      assert.deepEqual([f.w, f.h], [1, 960])
    }
  })

  test('resizeGray 兩種掃描順序（先橫再直、先直再橫）結果一樣，跟逐像素的定義一樣（細長的圖）', () => {
    const r = rng(31337)
    for (let round = 0; round < 60; round++) {
      const tall = round % 2 === 0
      const W = tall ? 1 + Math.floor(r() * 3) : 40 + Math.floor(r() * 80)
      const H = tall ? 40 + Math.floor(r() * 80) : 1 + Math.floor(r() * 3)
      const tw = 1 + Math.floor(r() * 12), th = 1 + Math.floor(r() * 12)
      const img = { width: W, height: H, gray: new Uint8Array(W * H) }
      for (let i = 0; i < img.gray.length; i++) img.gray[i] = Math.floor(r() * 256)
      const out = new Uint8Array(tw * th)
      for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
        let num = 0
        for (let y = 0; y < H; y++) {
          const oy = Math.min((y + 1) * th, (ty + 1) * H) - Math.max(y * th, ty * H)
          if (oy <= 0) continue
          for (let x = 0; x < W; x++) {
            const ox = Math.min((x + 1) * tw, (tx + 1) * W) - Math.max(x * tw, tx * W)
            if (ox > 0) num += img.gray[y * W + x] * ox * oy
          }
        }
        out[ty * tw + tx] = Math.floor((2 * num + W * H) / (2 * W * H))
      }
      assert.deepEqual(resizeGray(img, tw, th), out, `${W}×${H} → ${tw}×${th}`)
    }
  })

  test('1×100 萬放大成 4096×1024：以前要 16 秒，現在走「先直再橫」很快做完', () => {
    const t0 = performance.now()
    const out = resizeGray({ width: 1, height: 1_000_000, gray: new Uint8Array(1_000_000).fill(77) }, 4096, 1024)
    assert.ok(performance.now() - t0 < 1000, `花了 ${Math.round(performance.now() - t0)} ms`)
    assert.ok(out.every(v => v === 77))
  })

  test('兩種順序都太貴才丟 TOO_LARGE（遠超過 4000 萬像素的輸入；呼叫端要當「這張不比對」）', () => {
    // 不真的配置 3 億像素：長度用 getter 回報，運算量檢查在讀像素之前
    class Huge extends Uint8Array {
      constructor(n) { super(1); this.n = n }
      get length() { return this.n }
    }
    const W = 20000, H = 15000
    throwsCode(() => resizeGray({ width: W, height: H, gray: new Huge(W * H) }, 9, 8), 'TOO_LARGE')
    throwsCode(() => dHash({ width: W, height: H, gray: new Huge(W * H) }), 'TOO_LARGE')
  })
})

// ── 6. 工作量：第三輪新加的步驟（淡變化、切字行、找平移）也算進上限 ─────────
describe('burstGroups 的工作量上限：每一步都要算（含回原圖確認 same）', () => {
  const W = 640, H = 430, N = W * H
  const H16 = '0123456789abcdef'
  const bounded = (label, mk, count) => {
    const keep = { id: 'k', width: W, height: H, hash: H16, fine: { w: W, h: H, px: mk(-1) }, takenAt: 1e9 }
    const items = [keep]
    const pool = Array.from({ length: 32 }, (_, i) => mk(i)) // 32 種輪流用，省記憶體（每張 275 KB）
    for (let i = 0; i < count; i++) items.push({ id: 'm' + String(i).padStart(6, '0'), width: W, height: H, hash: H16, fine: { w: W, h: H, px: pool[i % 32] }, takenAt: 1e9 - 1 - i })
    const t0 = performance.now()
    throwsCode(() => burstGroups(items), 'TOO_MUCH_WORK')
    const took = performance.now() - t0
    assert.ok(took < 8000, `${label}：花了 ${Math.round(took)} ms`)
    return took
  }
  const base = new Uint8Array(N).fill(200)
  /** 一張 keep、m 張跟它比（同時間、同指紋）；px 是那 m 張共用的細比對。 */
  const members = (keepPx, px, m) => {
    const items = [{ id: 'k', width: W, height: H, hash: H16, fine: { w: W, h: H, px: keepPx }, takenAt: 1e9 }]
    for (let i = 0; i < m; i++) items.push({ id: 'm' + String(i).padStart(6, '0'), width: W, height: H, hash: H16, fine: { w: W, h: H, px }, takenAt: 1e9 - 1 - i })
    return items
  }
  test('每一步都算工作量（逐位元組算好的邊界）：淡變化、切字行少算一步就會多做一次比對', { timeout: 60000 }, () => {
    // 淡變化一大塊 100×41（差 10）：看一張 16 ＋ 掃一次 275200 ＋ 淡變化洪水 4100 × 9 ＋ 外框合併 1² = 312117；
    // 3844 次 = 1,199,777,748 ≤ 12 億，第 3845 次超過
    const blob = new Uint8Array(base)
    for (let y = 0; y < 41; y++) blob.fill(210, (100 + y) * W + 100, (100 + y) * W + 200)
    const g = burstGroups(members(base, blob, 3844))
    assert.deepEqual([g.length, g[0].drop.length, g[0].level], [1, 3844, 'similar'])
    throwsCode(() => burstGroups(members(base, blob, 3845)), 'TOO_MUCH_WORK')
    // 一塊 7×7 的強格（49 格，不到找平移的 50 格）：16 ＋ 275200 ＋ 弱格 49 × 81 ＋ 連成一處 49 × 25 ＋ 1² ＋ 歸屬 49 ＋ 切字行 2 × 7 × 7 = 280558；
    // 4277 次 = 1,199,946,566，第 4278 次超過
    const sq = new Uint8Array(base)
    for (let y = 0; y < 7; y++) sq.fill(255, (100 + y) * W + 100, (100 + y) * W + 107)
    throwsCode(() => burstGroups(members(base, sq, 4278)), 'TOO_MUCH_WORK')
    // 10×10 的黑方塊往右下移 4 格（強格 128；第四輪起不找平移，是 similar）：
    // 16 ＋ 275200 ＋ 128 × 81 ＋ 128 × 25 ＋ 1 ＋ 128 ＋ 切字行 2 × 14 × 14 = 289305；4147 次 = 1,199,747,835，第 4148 次超過
    const sqA = new Uint8Array(base), sqB = new Uint8Array(base)
    for (let y = 0; y < 10; y++) { sqA.fill(0, (100 + y) * W + 100, (100 + y) * W + 110); sqB.fill(0, (104 + y) * W + 104, (104 + y) * W + 114) }
    assert.equal(compareImages({ width: W, height: H, hash: H16, fine: { w: W, h: H, px: sqA } }, { width: W, height: H, hash: H16, fine: { w: W, h: H, px: sqB } }).level, 'similar')
    const g2 = burstGroups(members(sqA, sqB, 4147))
    assert.deepEqual([g2.length, g2[0].drop.length, g2[0].level], [1, 4147, 'similar'])
    throwsCode(() => burstGroups(members(sqA, sqB, 4148)), 'TOO_MUCH_WORK')
  })
  test('回原圖確認 same 也算工作量：1280×860 一模一樣（帶原圖灰階）的 2175 次做得完，第 2176 次丟 TOO_MUCH_WORK', { timeout: 60000 }, () => {
    // 每次：看一張 16 ＋ 細比對掃一次 640×430 = 275200 ＋ 原圖 1280×860 每 4 個像素算 1 = 275200 ＋ 格子對照表 1280 = 551696；
    // 2175 次 = 1,199,938,800 ≤ 12 億，第 2176 次超過。
    // 成員的灰階共用同一個陣列（不佔記憶體；成員只跟留下那張比，彼此共用沒關係）；留下那張用自己的一份
    //（第五輪：兩張共用同一塊記憶體就不能確認 same）
    const PW = 1280, PH = 860
    const gray = new Uint8Array(PW * PH).fill(200)
    const keepGray = new Uint8Array(gray)
    const fine = { w: 640, h: 430, px: new Uint8Array(640 * 430).fill(200) }
    const many = (m, withGray) => Array.from({ length: m + 1 }, (_, i) => ({ id: 'g' + String(i).padStart(5, '0'), width: PW, height: PH, hash: H16, fine, gray: withGray ? (i === 0 ? keepGray : gray) : undefined, takenAt: 1e9 - i }))
    const ok = burstGroups(many(2175, true))
    assert.deepEqual([ok.length, ok[0].drop.length, ok[0].level], [1, 2175, 'same'])
    throwsCode(() => burstGroups(many(2176, true)), 'TOO_MUCH_WORK')
    // 用 loadGray 載入也一樣算；留下那張載入後另外複製一份（loadGray 可能重複用同一塊緩衝），複製每 4 個像素算 1 = 275200：
    // 2174 次 ＋ 275200 = 1,199,662,304 做得完，2175 次 ＋ 275200 = 1,200,214,000 超過
    let calls = 0
    const loadGray = () => { calls++; return { width: PW, height: PH, gray } }
    assert.equal(burstGroups(many(2174, false), { loadGray })[0].level, 'same')
    assert.equal(calls, 2175, '留下的那張 1 次＋每個成員 1 次')
    throwsCode(() => burstGroups(many(2175, false), { loadGray }), 'TOO_MUCH_WORK')
    // 原圖上每個成員都有一塊 50×20 差 3 的像素（細比對平均下去看不到）：每個變了的像素再算 4，外框另算。
    // 16 ＋ 275200 ＋ 275200 ＋ 1280 ＋ 4 × 1000 ＋ 連成塊（250 格 × 9 ＋ 250 ＋ 1²）= 558197；2149 次 = 1,199,565,353，第 2150 次超過
    const dim = new Uint8Array(gray)
    for (let y = 400; y < 420; y++) dim.fill(203, y * PW + 600, y * PW + 650)
    const manyDim = m => [{ id: 'k', width: PW, height: PH, hash: H16, fine, gray, takenAt: 1e9 + 1 }, ...Array.from({ length: m }, (_, i) => ({ id: 'd' + String(i).padStart(5, '0'), width: PW, height: PH, hash: H16, fine, gray: dim, takenAt: 1e9 - i }))]
    const okDim = burstGroups(manyDim(2149))
    assert.deepEqual([okDim[0].drop.length, okDim[0].level, okDim[0].members[0].boxes], [2149, 'similar', [{ x: 600, y: 400, w: 50, h: 20 }]])
    throwsCode(() => burstGroups(manyDim(2150)), 'TOO_MUCH_WORK')
    // 沒有原圖灰階：不用確認，工作量只有細比對（16 ＋ 275200），4361 次也做得完，但都是 similar（沒辦法確認）
    const blind = burstGroups(many(4360, false))
    assert.deepEqual([blind[0].drop.length, blind[0].level, blind[0].members[0].boxes], [4360, 'similar', []])
  })
  test('8 處變化 → 幾秒內丟 TOO_MUCH_WORK', { timeout: 30000 }, t => {
    const ms = bounded('8 處變化', i => {
      const p = new Uint8Array(base)
      if (i < 0) return p
      const r = rng(i + 7)
      for (let s = 0; s < 8; s++) for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) if (r() < 0.9) p[(100 + y) * W + 20 + s * 70 + x] = r() < 0.5 ? 0 : 255
      return p
    }, 6000)
    t.diagnostic(`${Math.round(ms)} ms`)
  })
  test('淡變化一大塊（剛好在面積上限內）→ 幾秒內丟 TOO_MUCH_WORK', { timeout: 30000 }, t => {
    const ms = bounded('淡變化', i => {
      const p = new Uint8Array(base)
      if (i < 0) return p
      for (let y = 0; y < 41; y++) p.fill(210, (100 + y) * W + 100, (100 + y) * W + 200)
      return p
    }, 6000)
    t.diagnostic(`${Math.round(ms)} ms`)
  })
})
