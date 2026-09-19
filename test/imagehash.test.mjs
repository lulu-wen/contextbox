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
  hamming,
  fineDims,
  fineSig,
  fineCompare,
  isNearDuplicate,
  compareImages,
  burstGroups,
  DHASH_MAX,
  FINE_LONG_SIDE,
  FINE_CELL_PX,
  FINE_LONG_SIDE_MAX,
  FINE_STRONG,
  FINE_WEAK,
  FINE_GROW,
  FINE_REACH,
  LINE_RATIO_W,
  LINE_RATIO_H,
  FINE_MAX_AREA_BP,
  FINE_MAX_SPOTS,
  FINE_MAX_RAW_SPOTS,
  DEFAULT_MAX_GAP_MS,
} from '../core/imagehash.ts'

// ── 共用工具 ──────────────────────────────────────────────

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'imagehash')
const imagesMeta = JSON.parse(readFileSync(join(FIX, 'images.json'), 'utf8')).images
const expectedPairs = JSON.parse(readFileSync(join(FIX, 'expected.json'), 'utf8'))

const imageCache = new Map()
/** 讀開發期存下來的 raw 灰階（gzip），驗寬高與 sha256，不在測試裡解 PNG。 */
function loadImage(name) {
  if (imageCache.has(name)) return imageCache.get(name)
  const meta = imagesMeta[name]
  assert.ok(meta, `fixture 缺 ${name}`)
  const raw = gunzipSync(readFileSync(join(FIX, `${name}.gray.gz`)))
  assert.equal(raw.length, meta.width * meta.height, `${name} 長度不對`)
  assert.equal(createHash('sha256').update(raw).digest('hex'), meta.sha256, `${name} 內容被改過`)
  const img = { width: meta.width, height: meta.height, gray: new Uint8Array(raw.buffer, raw.byteOffset, raw.length) }
  imageCache.set(name, img)
  return img
}

const infoCache = new Map()
function imageInfo(name) {
  if (infoCache.has(name)) return infoCache.get(name)
  const img = loadImage(name)
  const info = { width: img.width, height: img.height, hash: dHash(img), fine: fineSig(img) }
  infoCache.set(name, info)
  return info
}

const stem = file => file.replace(/\.png$/, '')

/** 可重現的亂數（xorshift32），測試不用 Math.random。 */
function rng(seed) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s / 0x100000000
  }
}

function gray(width, height, fill = 0) {
  return { width, height, gray: new Uint8Array(width * height).fill(fill) }
}

function throwsCode(fn, code) {
  assert.throws(fn, err => {
    assert.ok(err instanceof ImageHashError, `應該丟 ImageHashError，實際是 ${err?.constructor?.name}: ${err?.message}`)
    assert.equal(err.code, code, `錯誤碼應該是 ${code}，實際是 ${err.code}（${err.message}）`)
    return true
  })
}

/** 直接照面積平均的定義逐像素算（不分離、不串流），用來對照實作。 */
function referenceResize(img, tw, th) {
  const { width: W, height: H, gray: g } = img
  const out = new Uint8Array(tw * th)
  const den = W * H
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      let num = 0
      for (let y = 0; y < H; y++) {
        const oy = Math.min((y + 1) * th, (ty + 1) * H) - Math.max(y * th, ty * H)
        if (oy <= 0) continue
        for (let x = 0; x < W; x++) {
          const ox = Math.min((x + 1) * tw, (tx + 1) * W) - Math.max(x * tw, tx * W)
          if (ox <= 0) continue
          num += g[y * W + x] * ox * oy
        }
      }
      // 四捨五入：floor((2·num + den) / (2·den))，全是整數
      out[ty * tw + tx] = Math.floor((2 * num + den) / (2 * den))
    }
  }
  return out
}

/** 直接指定一張 9×8 的圖，縮成 9×8 是恆等，所以 dHash 的位元完全由這張圖決定。 */
function img9x8(rows) {
  assert.equal(rows.length, 8)
  const g = new Uint8Array(72)
  rows.forEach((r, y) => { assert.equal(r.length, 9); r.forEach((v, x) => { g[y * 9 + x] = v }) })
  return { width: 9, height: 8, gray: g }
}

/** w×h 的細比對資料，全部 0；blocks 是 [x, y, 寬, 高, 值] 的方塊（格子座標）。 */
function sig(w, h, blocks = []) {
  const px = new Uint8Array(w * h)
  for (const [x, y, bw, bh, v = 255] of blocks) for (let yy = y; yy < y + bh; yy++) px.fill(v, yy * w + x, yy * w + x + bw)
  return { w, h, px }
}
/** 在 100×100 格裡放 k 個 4×4 的方塊（互相隔很遠、不會併成一處）：每塊 16 格。 */
function spots(k, w = 100, h = 100) {
  const blocks = []
  for (let i = 0; i < k; i++) blocks.push([5 + (i % 5) * 19, 5 + Math.floor(i / 5) * 19, 4, 4])
  return sig(w, h, blocks)
}
/** 400×400 格裡放 k 個 4×4 的方塊（每排 5 個、間隔 60 格）。 */
function spots400(k) {
  const blocks = []
  for (let i = 0; i < k; i++) blocks.push([10 + (i % 5) * 60, 10 + Math.floor(i / 5) * 60, 4, 4])
  return sig(400, 400, blocks)
}
const rep = r => `強格 ${(r.strong * 10000 / r.cells).toFixed(1)}‱（門檻 ≤ ${FINE_MAX_AREA_BP}）、${r.spots} 處（≤ ${FINE_MAX_SPOTS}）、最寬 ${r.widestW}×${r.widestH}${r.widestH ? `＝${(r.widestW / r.widestH).toFixed(2)} 倍` : ''}（≤ ${LINE_RATIO_W}/${LINE_RATIO_H}）${r.reason ? '，不近似：' + r.reason : ''}`

const SAME_HASH = '0123456789abcdef'
/** 只看分組（keep、drop），等級與外框另外測。 */
const kd = groups => groups.map(g => ({ keep: g.keep, drop: g.drop }))
/** 100×100 的圖（細比對格數＝原尺寸），預設跟其他 item 一模一樣。 */
function item(id, takenAt, over = {}) {
  return { id, width: 100, height: 100, hash: SAME_HASH, fine: sig(100, 100), takenAt, ...over }
}

// ── resizeGray ─────────────────────────────────────────────

describe('resizeGray：面積平均、整數、可重現', () => {
  test('同尺寸是恆等', () => {
    const r = rng(7)
    const img = gray(7, 5)
    for (let i = 0; i < img.gray.length; i++) img.gray[i] = Math.floor(r() * 256)
    assert.deepEqual(resizeGray(img, 7, 5), img.gray)
  })

  test('平均剛好 .5 時四捨五入（不是無條件捨去）', () => {
    assert.deepEqual([...resizeGray({ width: 2, height: 1, gray: Uint8Array.from([0, 1]) }, 1, 1)], [1])
    assert.deepEqual([...resizeGray({ width: 2, height: 1, gray: Uint8Array.from([255, 0]) }, 1, 1)], [128])
    assert.deepEqual([...resizeGray({ width: 4, height: 1, gray: Uint8Array.from([0, 0, 0, 1]) }, 1, 1)], [0])
    assert.deepEqual([...resizeGray({ width: 1, height: 2, gray: Uint8Array.from([10, 11]) }, 1, 1)], [11])
  })

  test('非整數倍率照覆蓋面積加權', () => {
    // 3 → 2：第 0 格蓋住 [0, 1.5)，第 1 格蓋住 [1.5, 3)
    assert.deepEqual([...resizeGray({ width: 3, height: 1, gray: Uint8Array.from([0, 90, 180]) }, 2, 1)], [30, 150])
    assert.deepEqual([...resizeGray({ width: 1, height: 3, gray: Uint8Array.from([0, 90, 180]) }, 1, 2)], [30, 150])
  })

  test('放大也照面積（每格落在哪個原像素）', () => {
    assert.deepEqual([...resizeGray({ width: 1, height: 1, gray: Uint8Array.from([77]) }, 3, 2)], [77, 77, 77, 77, 77, 77])
    assert.deepEqual([...resizeGray({ width: 2, height: 1, gray: Uint8Array.from([0, 255]) }, 4, 1)], [0, 0, 255, 255])
    assert.deepEqual([...resizeGray({ width: 2, height: 1, gray: Uint8Array.from([0, 255]) }, 3, 1)], [0, 128, 255])
  })

  test('跟逐像素的參考實作一個位元組都不差（結構化隨機）', () => {
    const r = rng(20260919)
    for (let round = 0; round < 150; round++) {
      const W = 1 + Math.floor(r() * 23)
      const H = 1 + Math.floor(r() * 19)
      const tw = 1 + Math.floor(r() * 30)
      const th = 1 + Math.floor(r() * 30)
      const img = gray(W, H)
      const mode = round % 3
      for (let i = 0; i < img.gray.length; i++) {
        img.gray[i] = mode === 0 ? Math.floor(r() * 256) : mode === 1 ? (r() < 0.5 ? 0 : 255) : 127 + (i % 2)
      }
      assert.deepEqual(resizeGray(img, tw, th), referenceResize(img, tw, th), `W=${W} H=${H} → ${tw}×${th}`)
    }
  })

  test('純色圖縮放後還是同一個顏色', () => {
    for (const v of [0, 1, 128, 254, 255]) {
      const out = resizeGray(gray(37, 23, v), 9, 8)
      assert.ok(out.every(x => x === v), `純色 ${v}`)
    }
  })

  test('結果可重現：同樣的輸入兩次結果一樣，而且不改輸入', () => {
    const img = loadImage('03-check-a')
    const before = createHash('sha256').update(img.gray).digest('hex')
    assert.deepEqual(resizeGray(img, 160, 108), resizeGray(img, 160, 108))
    assert.equal(createHash('sha256').update(img.gray).digest('hex'), before)
  })

  test('壞輸入丟 ImageHashError', () => {
    throwsCode(() => resizeGray(null, 9, 8), 'BAD_IMAGE')
    throwsCode(() => resizeGray({ width: 3, height: 3, gray: new Uint8Array(8) }, 1, 1), 'BAD_IMAGE')
    throwsCode(() => resizeGray({ width: 0, height: 3, gray: new Uint8Array(0) }, 1, 1), 'BAD_IMAGE')
    throwsCode(() => resizeGray({ width: 1.5, height: 2, gray: new Uint8Array(3) }, 1, 1), 'BAD_IMAGE')
    throwsCode(() => resizeGray({ width: 2, height: 2, gray: [1, 2, 3, 4] }, 1, 1), 'BAD_IMAGE')
    throwsCode(() => resizeGray({ width: NaN, height: 2, gray: new Uint8Array(2) }, 1, 1), 'BAD_IMAGE')
    throwsCode(() => resizeGray(gray(2, 2), 0, 1), 'BAD_SIZE')
    throwsCode(() => resizeGray(gray(2, 2), 1, -1), 'BAD_SIZE')
    throwsCode(() => resizeGray(gray(2, 2), 1.5, 1), 'BAD_SIZE')
    throwsCode(() => resizeGray(gray(2, 2), NaN, 1), 'BAD_SIZE')
    // 目標太大：要在配置記憶體之前就拒絕
    throwsCode(() => resizeGray(gray(2, 2), 100000, 100000), 'TOO_LARGE')
  })

  test('運算量：挑便宜的掃描順序，1×100 萬的圖放大成 4096×1024 很快做完（以前要算 16 秒；兩種順序都太貴的在 imagehash-levels 測）', () => {
    const t0 = performance.now()
    const out = resizeGray({ width: 1, height: 1_000_000, gray: new Uint8Array(1_000_000) }, 4096, 1024)
    assert.ok(performance.now() - t0 < 1000, `花了 ${Math.round(performance.now() - t0)} ms`)
    assert.ok(out.every(v => v === 0))
    // 正常的大截圖不受影響：8000×5000（png.ts 的上限 4000 萬像素）縮成細比對與 9×8
    const big = gray(8000, 5000, 255)
    assert.equal(dHash(big), '0000000000000000')
    const f = fineSig(big)
    assert.deepEqual([f.w, f.h], [960, 600])
  })
})

// ── dHash ──────────────────────────────────────────────────

describe('dHash：9×8、左 < 右記 1、列優先、高位先', () => {
  const inc = [0, 10, 20, 30, 40, 50, 60, 70, 80]
  const flat = Array(9).fill(100)

  test('每列都遞增 → 全部是 1', () => {
    assert.equal(dHash(img9x8(Array(8).fill(inc))), 'ffffffffffffffff')
  })

  test('相等不算（嚴格小於）：純色圖是 0', () => {
    assert.equal(dHash(img9x8(Array(8).fill(flat))), '0000000000000000')
    assert.equal(dHash(gray(640, 400, 200)), '0000000000000000')
  })

  test('左 > 右不算：每列都遞減 → 0', () => {
    assert.equal(dHash(img9x8(Array(8).fill([...inc].reverse()))), '0000000000000000')
  })

  test('位元順序：第 0 列第 0 格是最高位，第 7 列第 7 格是最低位，列優先', () => {
    const only = (row, col) => {
      const rows = Array.from({ length: 8 }, () => [...flat])
      rows[row][col + 1] = 101 // 只有這一格「左 < 右」
      return img9x8(rows)
    }
    assert.equal(dHash(only(0, 0)), '8000000000000000')
    assert.equal(dHash(only(0, 7)), '0100000000000000')
    assert.equal(dHash(only(1, 0)), '0080000000000000')
    assert.equal(dHash(only(7, 7)), '0000000000000001')
    // 一格變暗會讓它左邊那格變成「左 > 右」（不算）、自己變成「左 < 右」
    const rows = Array.from({ length: 8 }, () => [...flat])
    rows[3][4] = 50
    assert.equal(dHash(img9x8(rows)), '0000000800000000')
  })

  test('縮放不變：每個像素放大成 3×2 的方塊，指紋一樣', () => {
    const r = rng(11)
    const small = img9x8(Array.from({ length: 8 }, () => Array.from({ length: 9 }, () => Math.floor(r() * 256))))
    const big = gray(27, 16)
    for (let y = 0; y < 16; y++) for (let x = 0; x < 27; x++) big.gray[y * 27 + x] = small.gray[Math.floor(y / 2) * 9 + Math.floor(x / 3)]
    assert.equal(dHash(big), dHash(small))
  })

  test('輸出格式：16 個小寫 hex', () => {
    assert.match(dHash(loadImage('01-same-a')), /^[0-9a-f]{16}$/)
  })

  test('14 張真實截圖：dHash 與細比對縮圖跟另一份獨立實作（make-golden.py → golden.json）一致', () => {
    const golden = JSON.parse(readFileSync(join(FIX, 'golden.json'), 'utf8')).images
    assert.deepEqual(Object.keys(golden).sort(), Object.keys(imagesMeta).sort())
    for (const [name, g] of Object.entries(golden)) {
      const info = imageInfo(name)
      assert.equal(info.hash, g.dHash, `${name} 的 dHash`)
      assert.deepEqual([info.fine.w, info.fine.h], g.fineDims, `${name} 的細比對格數`)
      assert.equal(info.fine.px.reduce((s, v) => s + v, 0), g.fineSum, `${name} 的細比對縮圖總和`)
      assert.equal(createHash('sha256').update(info.fine.px).digest('hex'), g.fineSha256, `${name} 的細比對縮圖逐位元組`)
    }
  })
})

// ── hamming ────────────────────────────────────────────────

describe('hamming', () => {
  test('算不同的位元數', () => {
    assert.equal(hamming('0000000000000000', '0000000000000000'), 0)
    assert.equal(hamming('0000000000000000', 'ffffffffffffffff'), 64)
    assert.equal(hamming('8000000000000000', '0000000000000000'), 1)
    assert.equal(hamming('0000000000000001', '0000000000000000'), 1)
    assert.equal(hamming('f000000000000000', '0000000000000000'), 4)
    assert.equal(hamming('0123456789abcdef', 'fedcba9876543210'), hamming('fedcba9876543210', '0123456789abcdef'))
    assert.equal(hamming('ABCDEF0123456789', 'abcdef0123456789'), 0)
  })

  test('不是 16 個 hex 就丟 BAD_HASH', () => {
    throwsCode(() => hamming('abc', '0000000000000000'), 'BAD_HASH')
    throwsCode(() => hamming('0000000000000000', '00000000000000000'), 'BAD_HASH')
    throwsCode(() => hamming('gggggggggggggggg', '0000000000000000'), 'BAD_HASH')
    throwsCode(() => hamming(123, '0000000000000000'), 'BAD_HASH')
    throwsCode(() => hamming(null, '0000000000000000'), 'BAD_HASH')
  })
})

// ── fineSig / fineCompare ──────────────────────────────────

describe('fineSig：細比對縮圖的格數', () => {
  test('長邊 640～960 格、每格最多 4 像素（字面值，鎖住校準）、保持比例、.5 進位；小圖原樣；短邊至少 1', () => {
    assert.deepEqual([FINE_LONG_SIDE, FINE_CELL_PX, FINE_LONG_SIDE_MAX], [640, 4, 960])
    assert.deepEqual(fineDims(1280, 860), [640, 430])
    assert.deepEqual(fineDims(860, 1280), [430, 640])
    assert.deepEqual(fineDims(1920, 1080), [640, 360])
    assert.deepEqual(fineDims(2560, 1440), [640, 360])
    assert.deepEqual(fineDims(2564, 1440), [641, 360]) // ⌈2564 ÷ 4⌉ = 641
    assert.deepEqual(fineDims(2880, 1800), [720, 450])
    assert.deepEqual(fineDims(3456, 2234), [864, 559]) // 558.5 → 559
    assert.deepEqual(fineDims(3840, 2160), [960, 540])
    assert.deepEqual(fineDims(5120, 2880), [960, 540]) // 最多 960
    assert.deepEqual(fineDims(1170, 2532), [296, 640]) // 295.73 → 296
    assert.deepEqual(fineDims(1281, 860), [640, 430]) // 429.66 → 430：尺寸不同、格數相同
    assert.deepEqual(fineDims(1600, 1200), [640, 480])
    assert.deepEqual(fineDims(5000, 1), [960, 1])
    assert.deepEqual(fineDims(641, 1), [640, 1])
    assert.deepEqual(fineDims(640, 640), [640, 640])
    assert.deepEqual(fineDims(100, 50), [100, 50])
    throwsCode(() => fineDims(0, 5), 'BAD_INPUT')
    const s = fineSig(loadImage('01-same-a'))
    assert.deepEqual([s.w, s.h, s.px.length], [640, 430, 640 * 430])
    const small = gray(100, 50)
    for (let i = 0; i < small.gray.length; i++) small.gray[i] = i % 251
    assert.deepEqual(fineSig(small).px, small.gray)
  })
})

describe('fineCompare：強格面積、變化處的形狀與數目（門檻用字面值測，放寬就會紅）', () => {
  test('一模一樣：沒有強格、0 處；fineCompare 單獨呼叫不回 same（第五輪），是 similar／unverified；對稱', () => {
    const r = fineCompare(sig(100, 100), sig(100, 100))
    assert.deepEqual(r, { comparable: true, cells: 10000, strong: 0, faint: 0, spots: 0, widestW: 0, widestH: 0, lines: 0, pixels: 0, level: 'similar', reason: '', notSame: 'unverified', regions: [], near: true })
    const a = spots(1), b = sig(100, 100)
    assert.deepEqual(fineCompare(a, b), fineCompare(b, a))
  })

  test('強格：差 32 不算、差 33 才算', () => {
    assert.equal(FINE_STRONG, 32)
    const r32 = fineCompare(sig(100, 100), sig(100, 100, [[10, 10, 4, 4, 32]]))
    assert.deepEqual([r32.strong, r32.spots, r32.near], [0, 0, true])
    const r33 = fineCompare(sig(100, 100), sig(100, 100, [[10, 10, 4, 4, 33]]))
    assert.deepEqual([r33.strong, r33.spots, r33.widestW, r33.widestH, r33.near], [16, 1, 4, 4, true])
    // 反方向（b 比 a 暗）一樣算
    const rn = fineCompare(sig(100, 100, [[10, 10, 4, 4, 200]]), sig(100, 100, [[10, 10, 4, 4, 167]]))
    assert.equal(rn.strong, 16)
  })

  test('面積：強格 ≤ 萬分之 25 才可能是連拍（10000 格裡 25 格可以、26 格不行）', () => {
    assert.equal(FINE_MAX_AREA_BP, 25)
    const ok = fineCompare(sig(100, 100), sig(100, 100, [[10, 10, 5, 5]]))
    assert.deepEqual([ok.strong, ok.near], [25, true])
    const over = fineCompare(sig(100, 100), sig(100, 100, [[10, 10, 5, 5], [15, 10, 1, 1]]))
    assert.deepEqual([over.strong, over.near, over.reason], [26, false, 'area'])
  })

  test('一行字：寬超過高的 2.2 倍就不是連拍（11×5 可以、12×5 不行；22×10 可以、23×10 不行）', () => {
    assert.deepEqual([LINE_RATIO_W, LINE_RATIO_H], [11, 5])
    const at = (w, h) => fineCompare(sig(400, 400), sig(400, 400, [[50, 50, w, h]]))
    assert.equal(at(11, 5).near, true)
    assert.deepEqual([at(12, 5).near, at(12, 5).reason, at(12, 5).widestW, at(12, 5).widestH], [false, 'line', 12, 5])
    assert.equal(at(22, 10).near, true)
    assert.equal(at(23, 10).near, false)
    // 直的不算（游標、捲軸）
    assert.equal(at(1, 20).near, true)
    // 2×1 這種小點：寬高比 2，不到門檻
    assert.equal(at(2, 1).near, true)
    assert.equal(at(3, 1).near, false)
  })

  test('弱格：差 > 12、離強格 ≤ 4 格，才把範圍補進同一處', () => {
    assert.deepEqual([FINE_WEAK, FINE_GROW], [12, 4])
    // 7×5 的強格塊，右邊接一排弱格：補進 4 格 → 11×5（剛好 2.2 倍，可以）；補進 5 格就變 12×5
    const run = (len, v, bw = 7) => fineCompare(sig(400, 400), sig(400, 400, [[50, 50, bw, 5], [50 + bw, 52, len, 1, v]]))
    assert.deepEqual([run(5, 13).widestW, run(5, 13).near], [11, true]) // 第 5 格離強格 5 格，不算
    assert.deepEqual([run(5, 12).widestW, run(5, 12).near], [7, true]) // 差 12 不是弱格
    // 8×5 的強格塊接 4 格弱格 → 12×5 → 一行字；弱格差 12 就不補 → 8×5 可以
    assert.deepEqual([run(4, 13, 8).widestW, run(4, 13, 8).near], [12, false])
    assert.deepEqual([run(4, 12, 8).widestW, run(4, 12, 8).near], [8, true])
  })

  test('相連：兩格距離 ≤ 2 才算同一處（上下兩條 5×2 中間空 1 列 → 一處 5×5；空 2 列 → 兩條橫線）', () => {
    assert.equal(FINE_REACH, 2)
    const bars = gapRows => fineCompare(sig(400, 400), sig(400, 400, [[50, 50, 5, 2], [50, 52 + gapRows, 5, 2]]))
    const one = bars(1)
    assert.deepEqual([one.spots, one.widestW, one.widestH, one.near], [1, 5, 5, true])
    const two = bars(2)
    assert.deepEqual([two.spots, two.widestW, two.widestH, two.near, two.reason], [2, 5, 2, false, 'line'])
  })

  test('同一橫排、間隔 ≤ 較高那處的高度 → 併成一處（兩個 3×3 隔 3 格 → 9×3 一行字；隔 4 格 → 兩處）', () => {
    const pair = gap => fineCompare(sig(400, 400), sig(400, 400, [[50, 50, 3, 3], [53 + gap, 50, 3, 3]]))
    const merged = pair(3)
    assert.deepEqual([merged.spots, merged.widestW, merged.widestH, merged.near, merged.reason], [1, 9, 3, false, 'line'])
    const apart = pair(4)
    assert.deepEqual([apart.spots, apart.near], [2, true])
    // 高度不同時看較高的那處：3×6 與 3×2（上緣對齊）隔 6 格 → 併成 12×6（2 倍，可以）；隔 7 格 → 兩處
    const tall = gap => fineCompare(sig(400, 400), sig(400, 400, [[50, 50, 3, 6], [53 + gap, 50, 3, 2]]))
    assert.deepEqual([tall(6).spots, tall(6).widestW, tall(6).widestH], [1, 12, 6])
    assert.equal(tall(7).spots, 2)
    // 沒有共同的列就不併
    const offRow = fineCompare(sig(400, 400), sig(400, 400, [[50, 50, 3, 3], [54, 56, 3, 3]]))
    assert.equal(offRow.spots, 2)
  })

  test('變化處最多 8 處（9 處就不是連拍）；沒合併前超過 64 處也不是', () => {
    assert.equal(FINE_MAX_SPOTS, 8)
    const many = k => fineCompare(sig(400, 400), spots400(k))
    assert.deepEqual([many(8).spots, many(8).near], [8, true])
    assert.deepEqual([many(9).spots, many(9).near, many(9).reason], [9, false, 'spots'])
    assert.equal(FINE_MAX_RAW_SPOTS, 64)
    const dots = []
    for (let i = 0; i < 65; i++) dots.push([10 + (i % 13) * 30, 10 + Math.floor(i / 13) * 30, 1, 1])
    const r = fineCompare(sig(400, 400), sig(400, 400, dots))
    assert.deepEqual([r.spots, r.near, r.reason], [65, false, 'spots'])
  })

  test('格數不同 → 不能比', () => {
    assert.deepEqual(fineCompare(sig(10, 10), sig(10, 9)), { comparable: false, cells: 0, strong: 0, faint: 0, spots: 0, widestW: 0, widestH: 0, lines: 0, pixels: -1, level: 'different', reason: 'size', notSame: '', regions: [], near: false })
  })

  test('壞的細比對資料丟 BAD_SIG', () => {
    throwsCode(() => fineCompare(null, sig(2, 2)), 'BAD_SIG')
    throwsCode(() => fineCompare({ w: 2, h: 2, px: new Uint8Array(3) }, sig(2, 2)), 'BAD_SIG')
    throwsCode(() => fineCompare({ w: 0, h: 2, px: new Uint8Array(0) }, sig(2, 2)), 'BAD_SIG')
    throwsCode(() => fineCompare({ w: 2, h: 2, px: [0, 0, 0, 0] }, sig(2, 2)), 'BAD_SIG')
  })
})

// ── isNearDuplicate：8 組真實截圖 ───────────────────────────

describe('isNearDuplicate：expected.json 的 8 組真實截圖', () => {
  test('標準答案有 8 組，每一張都讀得到', () => {
    assert.equal(expectedPairs.length, 8)
    for (const p of expectedPairs) { loadImage(stem(p.a)); loadImage(stem(p.b)) }
  })

  expectedPairs.forEach((p, i) => {
    test(`第 ${i + 1} 組：${p.why} → ${p.burst ? '連拍' : '不是連拍'}`, t => {
      const a = imageInfo(stem(p.a))
      const b = imageInfo(stem(p.b))
      const sameSize = a.width === b.width && a.height === b.height
      const dh = hamming(a.hash, b.hash)
      const r = fineCompare(a.fine, b.fine)
      t.diagnostic(`尺寸${sameSize ? '相同' : '不同'}；dHash 距離 ${dh}（門檻 ≤ ${DHASH_MAX}）；細比對 ${r.comparable ? rep(r) : '格數不同，不能比'}`)
      assert.equal(isNearDuplicate(a, b), p.burst)
      assert.equal(isNearDuplicate(b, a), p.burst, '要對稱')
    })
  })

  test('第 8 組（同一個版面、只有文字不同）：只看 dHash 會誤判，細比對擋下來', () => {
    const p = expectedPairs[7]
    assert.match(p.why, /同一個版面、只有文字不同/)
    const a = imageInfo(stem(p.a))
    const b = imageInfo(stem(p.b))
    assert.ok(hamming(a.hash, b.hash) <= DHASH_MAX, '這組的粗指紋在門檻內，才證明需要兩段比對')
    assert.equal(fineCompare(a.fine, b.fine).near, false)
    assert.equal(isNearDuplicate(a, b), false)
  })

  test('灰階差 ±1（不同解碼器的四捨五入）不會改變任何一組的結果', () => {
    const noisy = new Map()
    const perturb = name => {
      if (noisy.has(name)) return noisy.get(name)
      const img = loadImage(name)
      const r = rng([...name].reduce((s, c) => s * 31 + c.charCodeAt(0), 7))
      const g = new Uint8Array(img.gray.length)
      for (let i = 0; i < g.length; i++) {
        const d = Math.floor(r() * 3) - 1
        g[i] = Math.min(255, Math.max(0, img.gray[i] + d))
      }
      const n = { width: img.width, height: img.height, gray: g }
      const info = { width: n.width, height: n.height, hash: dHash(n), fine: fineSig(n) }
      noisy.set(name, info)
      return info
    }
    for (const p of expectedPairs) {
      assert.equal(isNearDuplicate(perturb(stem(p.a)), perturb(stem(p.b))), p.burst, `${p.a} vs ${p.b}`)
      assert.equal(isNearDuplicate(perturb(stem(p.a)), imageInfo(stem(p.b))), p.burst, `${p.a}（加雜訊）vs ${p.b}`)
    }
  })

  test('尺寸不同就不算，就算指紋與細比對都一樣', () => {
    // 1280×860 與 1281×860 的細比對都是 640×430 格，只能靠尺寸擋
    const fine = sig(640, 430)
    const a = { width: 1280, height: 860, hash: SAME_HASH, fine }
    assert.equal(isNearDuplicate(a, { ...a }), true)
    assert.equal(isNearDuplicate(a, { ...a, width: 1281 }), false)
    assert.equal(isNearDuplicate(a, { ...a, width: 1279 }), false)
    assert.equal(isNearDuplicate(a, { ...a, height: 861, fine: sig(640, 431) }), false)
  })

  test('細比對的格數跟寬高對不上（舊版算的、或別處搬來的）→ 丟 BAD_SIG，不默默比', () => {
    const stale = { width: 1280, height: 860, hash: SAME_HASH, fine: sig(160, 108) }
    throwsCode(() => isNearDuplicate(stale, stale), 'BAD_SIG')
    throwsCode(() => burstGroups([{ ...stale, id: 'x', takenAt: 0 }]), 'BAD_SIG')
  })

  test('比對的是驗證當下的快照：getter 前後回不同的值也不影響', () => {
    let calls = 0
    const a = { width: 100, height: 100, hash: SAME_HASH, fine: sig(100, 100) }
    const b = { width: 100, height: 100, hash: SAME_HASH, get fine() { return calls++ === 0 ? sig(100, 100) : sig(100, 100, [[0, 0, 100, 100]]) } }
    assert.equal(isNearDuplicate(a, b), true)
    assert.equal(calls, 1)
  })

  test('粗指紋：差 10 個位元還算，11 個就不算（字面值，就算細比對一樣）', () => {
    const lowBits = k => ((1n << BigInt(k)) - 1n).toString(16).padStart(16, '0')
    const a = { width: 100, height: 100, hash: '0000000000000000', fine: sig(100, 100) }
    assert.equal(DHASH_MAX, 10)
    assert.equal(hamming(a.hash, lowBits(10)), 10)
    assert.equal(isNearDuplicate(a, { ...a, hash: lowBits(10) }), true)
    assert.equal(isNearDuplicate(a, { ...a, hash: lowBits(11) }), false)
  })

  test('細比對走同一套規則：強格 25 格可以、26 格不行；一行字（12×5）不行', () => {
    const a = { width: 100, height: 100, hash: SAME_HASH, fine: sig(100, 100) }
    assert.equal(isNearDuplicate(a, { ...a, fine: sig(100, 100, [[10, 10, 5, 5]]) }), true)
    assert.equal(isNearDuplicate(a, { ...a, fine: sig(100, 100, [[10, 10, 5, 5], [15, 10, 1, 1]]) }), false)
    assert.equal(isNearDuplicate(a, { ...a, fine: sig(100, 100, [[10, 10, 11, 2]]) }), false)
    assert.equal(isNearDuplicate(a, { ...a, fine: sig(100, 100, [[10, 10, 4, 2]]) }), true)
  })

  test('壞輸入丟錯', () => {
    const ok = { width: 10, height: 10, hash: SAME_HASH, fine: sig(10, 10) }
    throwsCode(() => isNearDuplicate({ ...ok, hash: 'zz' }, ok), 'BAD_HASH')
    throwsCode(() => isNearDuplicate({ ...ok, fine: null }, ok), 'BAD_SIG')
    throwsCode(() => isNearDuplicate({ ...ok, width: -1 }, ok), 'BAD_INPUT')
    throwsCode(() => isNearDuplicate(null, ok), 'BAD_INPUT')
  })
})

// ── burstGroups ────────────────────────────────────────────

describe('burstGroups：連拍分組', () => {
  const MIN = 60 * 1000

  test('預設時間窗是 5 分鐘', () => {
    assert.equal(DEFAULT_MAX_GAP_MS, 5 * MIN)
  })

  test('沒有或只有一張：不成組、不問', () => {
    assert.deepEqual(kd(burstGroups([])), [])
    assert.deepEqual(kd(burstGroups([item('only', 0)])), [])
  })

  test('兩張一樣：留新的、清舊的；等級 same、沒有外框', () => {
    assert.deepEqual(burstGroups([item('old', 0), item('new', MIN)]), [{ keep: 'new', level: 'same', drop: ['old'], members: [{ id: 'old', level: 'same', boxes: [] }] }])
    assert.deepEqual(kd(burstGroups([item('old', 0), item('new', MIN)])), [{ keep: 'new', drop: ['old'] }])
    assert.deepEqual(kd(burstGroups([item('new', MIN), item('old', 0)])), [{ keep: 'new', drop: ['old'] }])
  })

  test('同一組 3 張：留最新（不是最舊），drop 由新到舊', () => {
    const items = [item('t1', MIN), item('t0', 0), item('t2', 2 * MIN)]
    assert.deepEqual(kd(burstGroups(items)), [{ keep: 't2', drop: ['t1', 't0'] }])
    assert.deepEqual(kd(burstGroups([...items].reverse())), [{ keep: 't2', drop: ['t1', 't0'] }])
  })

  test('時間一樣時留 id 較大的（結果可重現）', () => {
    assert.deepEqual(kd(burstGroups([item('img-a', 5), item('img-b', 5)])), [{ keep: 'img-b', drop: ['img-a'] }])
    assert.deepEqual(kd(burstGroups([item('img-b', 5), item('img-a', 5)])), [{ keep: 'img-b', drop: ['img-a'] }])
    // 三張同時：最大的留，其餘由大到小
    assert.deepEqual(kd(burstGroups([item('b', 5), item('c', 5), item('a', 5)])), [{ keep: 'c', drop: ['b', 'a'] }])
  })

  test('時間邊界：相隔剛好 5 分鐘算，多 1 毫秒不算', () => {
    assert.deepEqual(kd(burstGroups([item('a', 0), item('b', 5 * MIN)])), [{ keep: 'b', drop: ['a'] }])
    assert.deepEqual(kd(burstGroups([item('a', 0), item('b', 5 * MIN + 1)])), [])
    assert.deepEqual(kd(burstGroups([item('a', 1000), item('b', 1000 + 5 * MIN)])), [{ keep: 'b', drop: ['a'] }])
  })

  test('時間窗可以自訂，邊界一樣是 ≤', () => {
    assert.deepEqual(kd(burstGroups([item('a', 0), item('b', 1000)], { maxGapMs: 1000 })), [{ keep: 'b', drop: ['a'] }])
    assert.deepEqual(kd(burstGroups([item('a', 0), item('b', 1001)], { maxGapMs: 1000 })), [])
    assert.deepEqual(kd(burstGroups([item('a', 7), item('b', 7)], { maxGapMs: 0 })), [{ keep: 'b', drop: ['a'] }])
  })

  test('時間窗是跟留下的那張比（最舊那張離最新超過 5 分鐘就不進組）', () => {
    const items = [item('t0', 0), item('t3', 3 * MIN), item('t6', 6 * MIN)]
    // t6 留下：t3 在 5 分鐘內；t0 離 t6 有 6 分鐘，不進這一組
    assert.deepEqual(kd(burstGroups(items)), [{ keep: 't6', drop: ['t3'] }])
  })

  test('尺寸不同：不成組', () => {
    assert.deepEqual(kd(burstGroups([item('a', 0), item('b', MIN, { height: 99, fine: sig(100, 99) })])), [])
    assert.deepEqual(kd(burstGroups([item('a', 0), item('b', MIN, { width: 101, fine: sig(101, 100) })])), [])
    // 細比對格數一樣（640×430）、只有寬差 1 也不成組
    const big = (id, t, w) => ({ id, width: w, height: 860, hash: SAME_HASH, fine: sig(640, 430), takenAt: t })
    assert.deepEqual(kd(burstGroups([big('a', 0, 1280), big('b', MIN, 1281)])), [])
    assert.deepEqual(kd(burstGroups([big('a', 0, 1280), big('b', MIN, 1280)])), [{ keep: 'b', drop: ['a'] }])
  })

  test('串連：A 像 B、B 像 C，但 A 不像 C → 留 C 時 A 不可以進組', () => {
    // B 比 A 多一塊 4×4（16 格，面積可以）；C 比 B 又多一塊；C 比 A 多兩塊（32 格 > 25，不像）
    const A = item('A', 0, { fine: spots(0) })
    const B = item('B', MIN, { fine: spots(1) })
    const C = item('C', 2 * MIN, { fine: spots(2) })
    assert.equal(isNearDuplicate(A, B), true)
    assert.equal(isNearDuplicate(B, C), true)
    assert.equal(isNearDuplicate(A, C), false)
    for (const order of [[A, B, C], [C, B, A], [B, A, C], [A, C, B]]) {
      const groups = burstGroups(order)
      assert.deepEqual(kd(groups), [{ keep: 'C', drop: ['B'] }])
      assert.ok(!groups.some(g => g.keep === 'A' || g.drop.includes('A')), 'A 不可以被建議清掉')
    }
  })

  test('串連（預想表的例子）：打一份文件每 20 秒截一張共 10 張，第 1 張不可以跟最後一張同組', () => {
    // 640×400 白底（細比對就是原圖），第 k 張有 k 個 20×20 的深色方塊。
    // 面積上限是 256000 格的萬分之 25 = 640 格：差 1 塊（400 格）像，差 2 塊（800 格）不像
    const shots = []
    for (let k = 0; k < 10; k++) {
      const img = gray(640, 400, 255)
      for (let j = 0; j < k; j++) {
        const x0 = 40 + (j % 5) * 60
        const y0 = 40 + Math.floor(j / 5) * 60
        for (let y = y0; y < y0 + 20; y++) for (let x = x0; x < x0 + 20; x++) img.gray[y * 640 + x] = 30
      }
      shots.push({ id: `shot-${k}`, width: 640, height: 400, hash: dHash(img), fine: fineSig(img), takenAt: k * 20 * 1000 })
    }
    for (let k = 0; k < 9; k++) assert.equal(isNearDuplicate(shots[k], shots[k + 1]), true, `相鄰 ${k}~${k + 1} 很像`)
    assert.equal(isNearDuplicate(shots[0], shots[9]), false, '第 1 張跟第 10 張差很多')
    const groups = burstGroups(shots)
    const last = groups.find(g => g.keep === 'shot-9')
    assert.ok(last, '最新那張要留下並成組')
    assert.ok(!last.drop.includes('shot-0'), '第 1 張不可以因為串連被歸進最新那組')
    for (const g of groups) {
      const keep = shots.find(s => s.id === g.keep)
      for (const d of g.drop) assert.equal(isNearDuplicate(shots.find(s => s.id === d), keep), true, `${d} 要像 ${g.keep}`)
    }
    // 每張只像前後一張（差 400 格 ≤ 640；差 800 格 > 640）→ 兩兩一組
    assert.deepEqual(kd(groups), [
      { keep: 'shot-9', drop: ['shot-8'] },
      { keep: 'shot-7', drop: ['shot-6'] },
      { keep: 'shot-5', drop: ['shot-4'] },
      { keep: 'shot-3', drop: ['shot-2'] },
      { keep: 'shot-1', drop: ['shot-0'] },
    ])
  })

  test('真實截圖走完整流程：8 組各自丟進去分組（帶 loadGray），結果跟標準答案一致（第 1 組有浮動按鈕在動、多打一個字、勾選框 similar；其他不成組）', () => {
    // 第四輪：same 只給原圖上幾乎沒有像素變化的。第 1 組「完全一樣」其實有三個浮動按鈕在動畫（4875 個像素差 > 2），是 similar
    //（第五輪預想表把標準答案第 1 組正式改成 similar）
    const LEVEL = ['similar', 'similar', 'similar']
    const loadGray = id => loadImage(id.replace('#later', ''))
    expectedPairs.forEach((p, i) => {
      const a = { id: stem(p.a), ...imageInfo(stem(p.a)), takenAt: 1_000_000 }
      const b = { id: `${stem(p.b)}#later`, ...imageInfo(stem(p.b)), takenAt: 1_000_000 + 30_000 }
      const groups = burstGroups([a, b], { loadGray })
      assert.deepEqual(kd(groups), p.burst ? [{ keep: b.id, drop: [a.id] }] : [], p.why)
      if (p.burst) {
        assert.equal(groups[0].level, LEVEL[i], p.why)
        assert.deepEqual(groups[0].members, [{ id: a.id, level: LEVEL[i], boxes: compareImages(b, a).boxes }])
      }
    })
  })

  test('結構化隨機：跟獨立的參考實作一致、輸入順序不影響、每組都符合規則', () => {
    const r = rng(9191)
    // 一族細比對資料（640×430 格，面積上限 688 格）：第 v 個變體有 v 塊 24×24（576 格）；
    // 差 1 個變體近似，差 2 個（1152 格）不近似。1280×860 與 1281×860 的格數一樣，只能靠尺寸擋
    const family = Array.from({ length: 6 }, (_, v) => sig(640, 430, Array.from({ length: v }, (_, j) => [20 + j * 100, 40, 24, 24])))
    const hashes = [SAME_HASH, SAME_HASH, SAME_HASH, 'fedcba9876543210']
    const sizes = [[1280, 860], [1280, 860], [1281, 860]]
    const reference = (items, maxGap) => {
      const order = [...items].sort((x, y) => (y.takenAt - x.takenAt) || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0))
      const done = new Set()
      const out = []
      for (const k of order) {
        if (done.has(k.id)) continue
        done.add(k.id)
        const drop = []
        for (const m of order) {
          if (done.has(m.id)) continue
          const olderOrTie = m.takenAt < k.takenAt || (m.takenAt === k.takenAt && m.id < k.id)
          if (olderOrTie && k.takenAt - m.takenAt <= maxGap && isNearDuplicate(m, k)) drop.push(m.id)
        }
        for (const d of drop) done.add(d)
        if (drop.length > 0) out.push({ keep: k.id, drop })
      }
      return out
    }
    for (let round = 0; round < 300; round++) {
      const n = Math.floor(r() * 14)
      const items = []
      for (let i = 0; i < n; i++) {
        const [w, h] = sizes[Math.floor(r() * sizes.length)]
        items.push({
          id: `i${Math.floor(r() * 1e6).toString(36)}-${i}`,
          width: w,
          height: h,
          hash: hashes[Math.floor(r() * hashes.length)],
          fine: family[Math.floor(r() * family.length)],
          takenAt: Math.floor(r() * 4) * 100 * 1000 + (r() < 0.3 ? 0 : Math.floor(r() * 3)),
        })
      }
      const maxGap = r() < 0.5 ? DEFAULT_MAX_GAP_MS : Math.floor(r() * 200 * 1000)
      const opts = maxGap === DEFAULT_MAX_GAP_MS ? undefined : { maxGapMs: maxGap }
      const got = burstGroups(items, opts)
      assert.deepEqual(kd(got), reference(items, maxGap), `round ${round}`)
      const shuffled = [...items].sort(() => r() - 0.5)
      assert.deepEqual(burstGroups(shuffled, opts), got, `round ${round}：換順序結果要一樣（含等級與外框）`)
      const byId = new Map(items.map(x => [x.id, x]))
      const seen = new Set()
      for (const g of got) {
        assert.ok(g.drop.length >= 1, '至少兩張才成組')
        assert.deepEqual(g.members.map(m => m.id), g.drop, 'members 跟 drop 同順序')
        assert.equal(g.level, g.members.some(m => m.level === 'similar') ? 'similar' : 'same', '整組的等級取成員最差的')
        for (const m of g.members) assert.equal(m.level, compareImages(byId.get(g.keep), byId.get(m.id)).level)
        const k = byId.get(g.keep)
        for (const id of [g.keep, ...g.drop]) { assert.ok(!seen.has(id), `${id} 出現兩次`); seen.add(id) }
        for (const d of g.drop) {
          const m = byId.get(d)
          assert.equal(isNearDuplicate(m, k), true, '每一張都要像留下的那張')
          assert.ok(k.takenAt - m.takenAt >= 0 && k.takenAt - m.takenAt <= maxGap, '時間窗是跟留下的那張比')
          assert.ok(m.takenAt < k.takenAt || (m.takenAt === k.takenAt && m.id < k.id), '留下的是最新（平手 id 大）')
        }
      }
    }
  })

  test('壞輸入丟錯', () => {
    throwsCode(() => burstGroups(null), 'BAD_INPUT')
    throwsCode(() => burstGroups([item('a', 0), item('a', 1)]), 'BAD_INPUT')
    throwsCode(() => burstGroups([item(1, 0)]), 'BAD_INPUT')
    throwsCode(() => burstGroups([item('a', NaN)]), 'BAD_INPUT')
    throwsCode(() => burstGroups([item('a', Infinity)]), 'BAD_INPUT')
    throwsCode(() => burstGroups([item('a', 0)], { maxGapMs: -1 }), 'BAD_INPUT')
    throwsCode(() => burstGroups([item('a', 0)], { maxGapMs: NaN }), 'BAD_INPUT')
    throwsCode(() => burstGroups([item('a', 0)], { maxGapMs: Infinity }), 'BAD_INPUT')
    throwsCode(() => burstGroups([item('a', 0, { hash: 'nope' })]), 'BAD_HASH')
    throwsCode(() => burstGroups([item('a', 0, { fine: { w: 1, h: 1, px: new Uint8Array(2) } })]), 'BAD_SIG')
    throwsCode(() => burstGroups([item('a', 0, { fine: sig(100, 99) })]), 'BAD_SIG')
    throwsCode(() => burstGroups([item('a', 0, { width: 0 })]), 'BAD_INPUT')
  })

  test('大量真實規模的輸入很快做完（5000 張分散、100 組連拍）', () => {
    const t0 = performance.now()
    const spread = Array.from({ length: 5000 }, (_, i) => item(`s${String(i).padStart(5, '0')}`, i * 10 * MIN))
    assert.deepEqual(kd(burstGroups(spread)), [])
    const bursts = []
    for (let b = 0; b < 100; b++) for (let k = 0; k < 20; k++) bursts.push(item(`b${String(b).padStart(3, '0')}-${String(k).padStart(2, '0')}`, b * 60 * MIN + k * 1000, { width: 640, height: 430, fine: sig(640, 430) }))
    const groups = burstGroups(bursts)
    assert.equal(groups.length, 100)
    assert.ok(groups.every(g => g.drop.length === 19))
    assert.ok(performance.now() - t0 < 5000, '要在幾秒內做完')
  })

  test('工作量上限剛好是 12 億單位：640×430 的同一張截圖 4361 張（4360 次整張比完）做得完，4362 張就丟 TOO_MUCH_WORK', { timeout: 30000 }, () => {
    // 每次比對 = 看一張 16 ＋ 掃過 640×430 = 275200 格（一模一樣：沒有強格、沒有淡變化，其他步驟都不用做）；
    // 4360 次 = 1,199,941,760 ≤ 1.2e9，第 4361 次超過
    const fine = sig(640, 430)
    const many = n => Array.from({ length: n }, (_, i) => ({ id: `s${String(i).padStart(5, '0')}`, width: 640, height: 430, hash: SAME_HASH, fine, takenAt: i }))
    const ok = burstGroups(many(4361))
    assert.equal(ok.length, 1)
    assert.equal(ok[0].drop.length, 4360)
    assert.equal(ok[0].level, 'same')
    throwsCode(() => burstGroups(many(4362)), 'TOO_MUCH_WORK')
  })

  test('只看不比也算工作量（每看一張 16 單位）：寬度各不相同的 12247 張（74,988,381 次）做得完，12248 張就丟 TOO_MUCH_WORK', { timeout: 30000 }, () => {
    // 12247×12246÷2×16 = 1,199,814,096 ≤ 1.2e9；12248 張多出 12247 次，超過
    const one = { w: 1, h: 1, px: new Uint8Array(1) }
    const strip = w => { const [fw, fh] = fineDims(w, 1); return fw === 1 ? one : { w: fw, h: fh, px: new Uint8Array(fw * fh) } }
    const many = n => Array.from({ length: n }, (_, i) => ({ id: 'w' + i, width: 1 + i, height: 1, hash: SAME_HASH, fine: strip(1 + i), takenAt: 0 }))
    assert.deepEqual(kd(burstGroups(many(12247))), [])
    throwsCode(() => burstGroups(many(12248)), 'TOO_MUCH_WORK')
  })

  test('惡意輸入不卡住：大量同時間、粗指紋全一樣、細比對都差在最後面 → 很快做完或丟 TOO_MUCH_WORK', { timeout: 30000 }, () => {
    const n = 3000
    const perBit = FINE_MAX_AREA_BP + 1 // 100×100 格裡 1 格 = 1‱，差 perBit 格就超過面積門檻
    const items = []
    for (let i = 0; i < n; i++) {
      const px = new Uint8Array(100 * 100)
      // 用 i 的 12 個位元，每個位元控制最後面的一段格子：任兩張至少差 perBit 格（> 門檻），而且差異都在最後面
      const tail = px.length - 12 * perBit
      for (let bit = 0; bit < 12; bit++) if ((i >> bit) & 1) px.fill(255, tail + bit * perBit, tail + (bit + 1) * perBit)
      items.push({ id: `x${i}`, width: 100, height: 100, hash: SAME_HASH, fine: { w: 100, h: 100, px }, takenAt: 0 })
    }
    const t0 = performance.now()
    try {
      const groups = burstGroups(items)
      assert.deepEqual(groups, [])
    } catch (err) {
      assert.ok(err instanceof ImageHashError)
      assert.equal(err.code, 'TOO_MUCH_WORK')
    }
    assert.ok(performance.now() - t0 < 10000, `花了 ${Math.round(performance.now() - t0)} ms`)
  })
})
