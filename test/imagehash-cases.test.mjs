// imagehash 的「會不會把不同的截圖當成連拍」回歸測試（第三輪起比對分三級：same／similar／different）：
//   1. 對抗式驗證找到的反例（逐位元組重現，fixtures/imagehash/synth；第二輪的反例在 imagehash-levels.test.mjs）
//   2. 四種尺寸 × 多種縮放的「同版面、換 N 行字」與「只改一個字」（用字形表在測試裡排版）
//   3. 工作量上限不能被繞過
//   4. 14 張真實截圖交叉比對的一致性
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ImageHashError, dHash, hamming, fineDims, fineSig, fineCompare, compareImages, isNearDuplicate, burstGroups, LINE_RATIO_W, LINE_RATIO_H, FINE_MAX_AREA_BP, FINE_MAX_SPOTS } from '../core/imagehash.ts'

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'imagehash')
const SYN = join(FIX, 'synth')
const synth = JSON.parse(readFileSync(join(SYN, 'synth.json'), 'utf8'))

// ── 讀合成圖：底圖（可能是別張的左上角）＋貼回方塊，最後驗 sha256 ────────
const rawCache = new Map()
function synthRaw(name) {
  if (rawCache.has(name)) return rawCache.get(name)
  const m = synth.images[name]
  assert.ok(m, `synth 缺 ${name}`)
  let g
  if (!m.base) {
    g = new Uint8Array(gunzipSync(readFileSync(join(SYN, `${name}.gray.gz`))))
  } else {
    const base = synthRaw(m.base)
    g = new Uint8Array(m.width * m.height)
    if (m.crop) {
      const bw = synth.images[m.base].width
      const [cx, cy] = m.crop
      for (let y = 0; y < m.height; y++) g.set(base.subarray((cy + y) * bw + cx, (cy + y) * bw + cx + m.width), y * m.width)
    } else g.set(base)
    if (m.patch) {
      const [px, py, pw, ph] = m.patch
      const p = gunzipSync(readFileSync(join(SYN, `${name}.patch.gz`)))
      assert.equal(p.length, pw * ph, `${name} 的方塊大小不對`)
      for (let y = 0; y < ph; y++) g.set(p.subarray(y * pw, (y + 1) * pw), (py + y) * m.width + px)
    }
  }
  assert.equal(g.length, m.width * m.height)
  assert.equal(createHash('sha256').update(g).digest('hex'), m.sha256, `${name} 重組後內容不對`)
  rawCache.set(name, g)
  return g
}
const infoCache = new Map()
function synthInfo(name) {
  if (infoCache.has(name)) return infoCache.get(name)
  const m = synth.images[name]
  const img = { width: m.width, height: m.height, gray: synthRaw(name) }
  const info = { width: m.width, height: m.height, hash: dHash(img), fine: fineSig(img) }
  infoCache.set(name, info)
  return info
}

// ── 真實截圖（跟 imagehash.test.mjs 同一份 fixtures）────────────────
const realMeta = JSON.parse(readFileSync(join(FIX, 'images.json'), 'utf8')).images
const realCache = new Map()
const realGrayCache = new Map()
/** 原圖灰階（burstGroups 的 loadGray 用）。 */
function realGray(name) {
  if (realGrayCache.has(name)) return realGrayCache.get(name)
  const m = realMeta[name]
  const raw = gunzipSync(readFileSync(join(FIX, `${name}.gray.gz`)))
  assert.equal(createHash('sha256').update(raw).digest('hex'), m.sha256)
  const img = { width: m.width, height: m.height, gray: new Uint8Array(raw.buffer, raw.byteOffset, raw.length) }
  realGrayCache.set(name, img)
  return img
}
function realInfo(name) {
  if (realCache.has(name)) return realCache.get(name)
  const img = realGray(name)
  const info = { width: img.width, height: img.height, hash: dHash(img), fine: fineSig(img) }
  realCache.set(name, info)
  return info
}

// ── 用字形表排版：同一個版面，換 N 行字、改一個字、多打一個字 ────────────
const G = synth.glyphs
const glyphRaw = new Uint8Array(gunzipSync(readFileSync(join(SYN, 'glyphs.gray.gz'))))
assert.equal(createHash('sha256').update(glyphRaw).digest('hex'), G.sha256, '字形表內容不對')
const glyphOffset = []
{
  let off = 0
  for (let si = 0; si < G.sizes.length; si++) { glyphOffset.push(off); off += G.chars.length * G.cells[si][0] * G.cells[si][1] }
  assert.equal(off, glyphRaw.length)
}
const NCH = G.chars.length

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

/** 縮放倍率 → 字形表的字級（14px 的內文在 1、1.25、1.5、2 倍時是 14、18、21、28 px）。 */
function sizeIndex(scale) {
  const i = G.sizes.indexOf(Math.round(14 * scale))
  const j = i >= 0 ? i : G.sizes.indexOf(Math.round(14 * scale + 0.5))
  assert.ok(j >= 0, `沒有 ${14 * scale}px 的字形`)
  return j
}

/**
 * 排一張「文件／聊天」版面的灰階圖：頂列、側欄（夠寬才有）、一行一行的中文字。
 * lines 是字的編號陣列（字形表裡的第幾個字）。字距等於字寬（中文字等寬）。
 */
function composePage({ W, H, scale, dark, lines }) {
  const g = new Uint8Array(W * H)
  const S = v => Math.round(v * scale)
  const bg = dark ? 30 : 250, fg = dark ? 225 : 30, bar = dark ? 45 : 255, side = dark ? 38 : 240
  g.fill(bg)
  const rect = (x0, y0, x1, y1, v) => { for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) g.fill(v, y * W + Math.max(0, x0), y * W + Math.min(W, x1)) }
  rect(0, 0, W, S(48), bar)
  const sw = W / scale >= 700 ? 200 : 0
  if (sw) rect(0, S(48), S(200), H, side)
  const si = sizeIndex(scale)
  const [cw, ch] = G.cells[si]
  const drawGlyph = (k, x, y, back) => {
    const base = glyphOffset[si] + k * cw * ch
    for (let yy = 0; yy < ch; yy++) {
      const ty = y + yy
      if (ty < 0 || ty >= H) continue
      for (let xx = 0; xx < cw; xx++) {
        const tx = x + xx
        if (tx < 0 || tx >= W) continue
        const cov = glyphRaw[base + yy * cw + xx]
        if (cov) g[ty * W + tx] = Math.floor((back * (255 - cov) + fg * cov + 127) / 255)
      }
    }
  }
  // 頂列標題、側欄選單（固定內容）
  for (let i = 0; i < 8; i++) drawGlyph((i * 7) % NCH, S(20) + i * cw, S(14), bar)
  if (sw) for (let r = 0; r < 6; r++) for (let i = 0; i < 3; i++) drawGlyph((r * 11 + i * 5) % NCH, S(24) + i * cw, S(70) + r * S(36), side)
  const x0 = S(sw + 40), pitch = S(14 * 1.7), maxChars = Math.floor((W - x0 - S(40)) / cw)
  let y = S(72)
  for (const line of lines) {
    if (y + pitch > H - S(20)) break
    for (let i = 0; i < Math.min(line.length, maxChars); i++) drawGlyph(line[i], x0 + i * cw, y, bg)
    y += pitch
  }
  return { width: W, height: H, gray: g }
}

/** 版面上看得到的行數，以及每行最多幾個字。 */
function pageCapacity(W, H, scale) {
  const S = v => Math.round(v * scale)
  const sw = W / scale >= 700 ? 200 : 0
  const cw = G.cells[sizeIndex(scale)][0]
  const pitch = S(14 * 1.7)
  let n = 0
  for (let y = S(72); y + pitch <= H - S(20); y += pitch) n++
  return { rows: n, maxChars: Math.floor((W - S(sw + 40) - S(40)) / cw) }
}

function baseLines(r, count, maxChars) {
  const lens = [12, 18, 24, 30, 36, 40, 44]
  return Array.from({ length: count }, () => {
    const L = Math.min(maxChars, lens[Math.floor(r() * lens.length)])
    return Array.from({ length: L }, () => Math.floor(r() * NCH))
  })
}
function otherChar(r, k) {
  let c = Math.floor(r() * NCH)
  while (c === k) c = Math.floor(r() * NCH)
  return c
}
const infoOf = img => ({ width: img.width, height: img.height, hash: dHash(img), fine: fineSig(img) })
const ratio = r => (r.widestH ? r.widestW / r.widestH : 0)
const rep = r => `${r.level}：強格 ${(r.strong * 10000 / r.cells).toFixed(1)}‱（≤ ${FINE_MAX_AREA_BP}）、${r.spots} 處（≤ ${FINE_MAX_SPOTS}）、最寬 ${r.widestW}×${r.widestH}＝${ratio(r).toFixed(2)} 倍（≤ ${(LINE_RATIO_W / LINE_RATIO_H).toFixed(1)}）、${r.lines} 條字行${r.reason ? '，不一樣：' + r.reason : ''}${r.notSame ? '，不是 same：' + r.notSame : ''}`
const level = (a, b) => compareImages(a, b).level
/** 扁的字：差異只有幾條橫線，單獨打進去時寬高比很大，會判成「不是連拍」（安全的方向，另外測）。 */
const FLAT = new Set(['一', '三'].map(c => G.chars.indexOf(c)))
function roundChar(r, not = -1) {
  let c = Math.floor(r() * NCH)
  while (c === not || FLAT.has(c)) c = Math.floor(r() * NCH)
  return c
}

// 四種尺寸，每種都有 100% 與常見的放大倍率
const MATRIX = [
  [1280, 720, 1], [1280, 720, 1.5],
  [1920, 1080, 1], [1920, 1080, 1.25], [1920, 1080, 1.5],
  [2560, 1440, 1], [2560, 1440, 1.5], [2560, 1440, 2],
  [3840, 2160, 1], [3840, 2160, 1.5], [3840, 2160, 2],
]

// ── 1. 對抗式驗證的反例 ──────────────────────────────────────────
describe('對抗式驗證找到的反例：逐位元組重現，每一組都要判對', () => {
  // 第四輪的等級：same 只給原圖上幾乎沒有像素變化的，沒有例外，所以游標移動、時鐘、已讀時間與「好 → 不行」都是 similar；其他 different
  const LEVEL = { 's08-graymeta': 'similar', 's09-caret': 'similar', 's10-editor-caret': 'similar', 's12-clock': 'similar', 's18-phone-clock': 'similar', 's01-ok-vs-no': 'similar', 's05-dark-ok-no': 'similar', 's17-phone-ok-no': 'similar' }
  for (const p of synth.pairs) {
    const want = LEVEL[p.name] ?? 'different'
    test(`${p.name}：${p.why} → ${want}`, t => {
      const a = synthInfo(p.a), b = synthInfo(p.b)
      t.diagnostic(`dHash ${hamming(a.hash, b.hash)}；${rep(fineCompare(a.fine, b.fine, a.width / a.fine.w))}`)
      assert.equal(level(a, b), want)
      assert.equal(level(b, a), want, '要對稱')
      assert.equal(isNearDuplicate(a, b), want !== 'different')
    })
  }
})

// ── 2. 四種尺寸的「換 N 行字」與「只改一個字」 ────────────────────
describe('四種尺寸 × 縮放 × 深淺色：換 N 行字 different；只改一個字、多打一個字 similar', () => {
  for (const [W, H, scale] of MATRIX) {
    for (const dark of [false, true]) {
      test(`${W}×${H} @${scale * 100}% ${dark ? '深色' : '淺色'}`, t => {
        const r = rng(W * 7 + H * 3 + scale * 1000 + (dark ? 1 : 0))
        const { rows, maxChars } = pageCapacity(W, H, scale)
        assert.ok(rows >= 16, `${W}×${H}@${scale} 至少要 16 行才放得下換 6 行`)
        const lines = baseLines(r, rows, maxChars)
        // 要換的行：從第 3 行開始隔一行，只挑 ≥ 12 字的行（一行字）
        const longRows = lines.map((l, i) => [l.length, i]).filter(([n, i]) => n >= 12 && i >= 3).map(([, i]) => i)
        const a = infoOf(composePage({ W, H, scale, dark, lines }))
        for (const N of [1, 2, 4, 6]) {
          const L2 = lines.map(l => [...l])
          for (let j = 0; j < N; j++) { const i = longRows[j * 2]; L2[i] = L2[i].map(k => otherChar(r, k)) }
          const b = infoOf(composePage({ W, H, scale, dark, lines: L2 }))
          t.diagnostic(`換 ${N} 行：${rep(fineCompare(a.fine, b.fine, W / a.fine.w))}`)
          assert.equal(level(a, b), 'different', `換 ${N} 行字要判 different`)
        }
        // 只改一個字：第 3 行中間那個字換成別的字（扁的字「一」「三」另外測）
        const L3 = lines.map(l => [...l]); const i3 = longRows[0]; const p3 = Math.floor(L3[i3].length / 2)
        L3[i3][p3] = roundChar(r, L3[i3][p3])
        const c1 = infoOf(composePage({ W, H, scale, dark, lines: L3 }))
        t.diagnostic(`改一個字：${rep(fineCompare(a.fine, c1.fine, W / a.fine.w))}`)
        assert.equal(level(a, c1), 'similar', '只改一個字要判 similar')
        // 多打一個字：同一行，前一張 10 個字、後一張 11 個字
        const t0 = lines.map(l => [...l]); t0[i3] = t0[i3].slice(0, 10)
        const t1 = t0.map(l => [...l]); t1[i3].push(roundChar(r))
        const T0 = infoOf(composePage({ W, H, scale, dark, lines: t0 })), T1 = infoOf(composePage({ W, H, scale, dark, lines: t1 }))
        t.diagnostic(`多打一個字：${rep(fineCompare(T0.fine, T1.fine, W / T0.fine.w))}`)
        assert.equal(level(T0, T1), 'similar', '多打一個字要判 similar')
      })
    }
  }
})

describe('結構化隨機：隨機挑行、挑字，規則不能只對特定幾個字成立', () => {
  const CONFIGS = [[1280, 720, 1, false], [1920, 1080, 1, true], [2560, 1440, 1.5, false], [3840, 2160, 2, true]]
  for (const [W, H, scale, dark] of CONFIGS) {
    test(`${W}×${H} @${scale * 100}% ${dark ? '深色' : '淺色'}：隨機改一個字 ×12、多打一個字 ×8 都是 similar；隨機換 1～6 行 ×8 都是 different`, t => {
      const r = rng(W + H * 13 + scale * 7 + (dark ? 99 : 0))
      const { rows, maxChars } = pageCapacity(W, H, scale)
      const lines = baseLines(r, rows, maxChars)
      const a = infoOf(composePage({ W, H, scale, dark, lines }))
      const vis = lines.map((l, i) => i).filter(i => i >= 1)
      let worstBurst = 0, bestNot = Infinity
      for (let k = 0; k < 12; k++) {
        const L = lines.map(l => [...l]); const i = vis[Math.floor(r() * vis.length)]; const pos = Math.floor(r() * L[i].length)
        L[i][pos] = roundChar(r, L[i][pos])
        const b = infoOf(composePage({ W, H, scale, dark, lines: L }))
        worstBurst = Math.max(worstBurst, ratio(fineCompare(a.fine, b.fine)))
        assert.equal(level(a, b), 'similar', `第 ${i} 行第 ${pos} 字`)
      }
      for (let k = 0; k < 8; k++) {
        const i = vis[Math.floor(r() * vis.length)]; const cut = 1 + Math.floor(r() * (lines[i].length - 1))
        const t0 = lines.map(l => [...l]); t0[i] = t0[i].slice(0, cut)
        const t1 = t0.map(l => [...l]); t1[i].push(roundChar(r))
        const A = infoOf(composePage({ W, H, scale, dark, lines: t0 })), B = infoOf(composePage({ W, H, scale, dark, lines: t1 }))
        worstBurst = Math.max(worstBurst, ratio(fineCompare(A.fine, B.fine)))
        assert.equal(level(A, B), 'similar', `第 ${i} 行打到第 ${cut + 1} 字`)
      }
      for (let k = 0; k < 8; k++) {
        const N = 1 + Math.floor(r() * 6)
        const L = lines.map(l => [...l])
        const picked = new Set()
        while (picked.size < N) picked.add(vis[Math.floor(r() * vis.length)])
        for (const i of picked) L[i] = L[i].map(c => otherChar(r, c))
        const b = infoOf(composePage({ W, H, scale, dark, lines: L }))
        const rr = fineCompare(a.fine, b.fine)
        bestNot = Math.min(bestNot, ratio(rr))
        assert.equal(level(a, b), 'different', `換 ${[...picked]} 行`)
      }
      t.diagnostic(`連拍側最寬 ${worstBurst.toFixed(2)} 倍、不是連拍側最窄 ${bestNot.toFixed(2)} 倍（門檻 ${(LINE_RATIO_W / LINE_RATIO_H).toFixed(1)}）`)
    })
  }

  test('1280×720 與 1920×1080（100%）：連續 3 個字換掉 ×12 都是 different', t => {
    for (const [W, H] of [[1280, 720], [1920, 1080]]) {
      const r = rng(W * 3 + 1)
      const { rows, maxChars } = pageCapacity(W, H, 1)
      const lines = baseLines(r, rows, maxChars)
      const a = infoOf(composePage({ W, H, scale: 1, dark: false, lines }))
      let best = Infinity
      for (let k = 0; k < 12; k++) {
        const L = lines.map(l => [...l]); const i = 1 + Math.floor(r() * (rows - 1)); const pos = Math.floor(r() * (L[i].length - 3))
        for (let j = pos; j < pos + 3; j++) L[i][j] = otherChar(r, L[i][j])
        const b = infoOf(composePage({ W, H, scale: 1, dark: false, lines: L }))
        best = Math.min(best, ratio(fineCompare(a.fine, b.fine)))
        assert.equal(level(a, b), 'different', `${W} 第 ${i} 行第 ${pos} 起 3 字`)
      }
      t.diagnostic(`${W}×${H}：3 個字最窄 ${best.toFixed(2)} 倍（門檻 ${(LINE_RATIO_W / LINE_RATIO_H).toFixed(1)}）`)
    }
  })
})

describe('扁的字與已知的邊界（照實記下來，改門檻時會紅）', () => {
  test('1280×720：96 個字單獨打進去，都是 similar，只有「一」「三」判成 different（差異只有橫線，寬高比大；安全的方向）', () => {
    const W = 1280, H = 720
    const r = rng(4242)
    const { rows, maxChars } = pageCapacity(W, H, 1)
    const lines = baseLines(r, rows, maxChars)
    const t0 = lines.map(l => [...l]); t0[4] = t0[4].slice(0, 10)
    const A = infoOf(composePage({ W, H, scale: 1, dark: false, lines: t0 }))
    const notBurst = []
    for (let c = 0; c < NCH; c++) {
      const t1 = t0.map(l => [...l]); t1[4].push(c)
      const lv = level(A, infoOf(composePage({ W, H, scale: 1, dark: false, lines: t1 })))
      assert.notEqual(lv, 'same', G.chars[c])
      if (lv === 'different') notBurst.push(G.chars[c])
    }
    assert.deepEqual(notBurst, ['一', '三'])
  })

  test('1920×1080：側邊清單 10 項各改一個字 → 10 處，different；改 8 項 → 8 處，還是 similar（上限 8 處）', () => {
    const W = 1920, H = 1080
    const r = rng(77)
    const { rows, maxChars } = pageCapacity(W, H, 1)
    const lines = baseLines(r, rows, maxChars).map(l => l.slice(0, 12))
    const a = infoOf(composePage({ W, H, scale: 1, dark: false, lines }))
    const change = k => { const L = lines.map(l => [...l]); for (let i = 0; i < k; i++) L[1 + i * 3][11] = roundChar(r, L[1 + i * 3][11]); return infoOf(composePage({ W, H, scale: 1, dark: false, lines: L })) }
    const r10 = fineCompare(a.fine, change(10).fine)
    assert.deepEqual([r10.spots, r10.near, r10.reason], [10, false, 'spots'])
    const r8 = fineCompare(a.fine, change(8).fine)
    assert.deepEqual([r8.spots, r8.near, r8.level], [8, true, 'similar'])
  })

  test('一張 180×160 的圖換成別的圖：1920×1080 強格 87.5‱，different；3840×2160 以 100% 顯示只有 22.5‱（< 25）→ 成組，但一定是 similar（已知弱點）', () => {
    const photo = (W, H, seed) => {
      const img = composePage({ W, H, scale: 1, dark: false, lines: [] })
      const r = rng(seed)
      const x0 = W - 300, y0 = 200
      for (let by = 0; by < 160; by += 12) for (let bx = 0; bx < 180; bx += 12) {
        const v = 40 + Math.floor(r() * 180)
        for (let y = by; y < Math.min(160, by + 12); y++) img.gray.fill(v, (y0 + y) * W + x0 + bx, (y0 + y) * W + x0 + Math.min(180, bx + 12))
      }
      return infoOf(img)
    }
    const fhd = fineCompare(photo(1920, 1080, 1).fine, photo(1920, 1080, 2).fine)
    assert.equal(fhd.reason, 'area')
    assert.equal((fhd.strong * 10000 / fhd.cells).toFixed(1), '87.5')
    const uhd = fineCompare(photo(3840, 2160, 1).fine, photo(3840, 2160, 2).fine)
    assert.equal(uhd.near, true, '已知弱點：4K 100% 下 180×160 的圖只佔 0.35%，形狀又是一團')
    assert.equal(uhd.level, 'similar', '圖換了不可以是 same')
    assert.equal((uhd.strong * 10000 / uhd.cells).toFixed(1), '22.5')
  })
})

describe('第二輪的規格衝突「好」→「不行」：第三輪改成三級之後解開', () => {
  test('跟真實第 3 組（勾選框）一樣是 similar：成組但預設不勾、把不一樣的地方框出來；寬高比還是分不開（最窄的比第 3 組窄）', t => {
    const a3 = realInfo('03-check-a'), b3 = realInfo('03-check-b')
    const r3 = fineCompare(a3.fine, b3.fine, 2)
    t.diagnostic(`第 3 組：${rep(r3)}`)
    assert.equal(level(a3, b3), 'similar')
    const ratios = []
    for (const name of ['s01-ok-vs-no', 's05-dark-ok-no', 's17-phone-ok-no']) {
      const p = synth.pairs.find(x => x.name === name)
      const a = synthInfo(p.a), b = synthInfo(p.b)
      const r = fineCompare(a.fine, b.fine, a.width / a.fine.w)
      t.diagnostic(`${name}：${rep(r)}`)
      ratios.push(ratio(r))
      assert.equal(level(a, b), 'similar', name)
      assert.ok(compareImages(a, b).boxes.length > 0, `${name} 要有外框`)
    }
    assert.ok(Math.min(...ratios) < ratio(r3), `好→不行 最窄 ${Math.min(...ratios).toFixed(2)}，第 3 組 ${ratio(r3).toFixed(2)}`)
  })
})

// ── 3. 工作量上限 ────────────────────────────────────────────────
describe('burstGroups 的工作量上限不能被繞過', () => {
  const H16 = '0123456789abcdef'
  const one = { w: 1, h: 1, px: new Uint8Array(1) }
  /** 寬 w、高 1 的圖應有的細比對資料（全 0）。 */
  const strip = w => { const [fw, fh] = fineDims(w, 1); return { w: fw, h: fh, px: new Uint8Array(fw * fh) } }
  const expectBounded = (items, ms) => {
    const t0 = performance.now()
    try { burstGroups(items) } catch (err) {
      assert.ok(err instanceof ImageHashError, String(err))
      assert.equal(err.code, 'TOO_MUCH_WORK')
    }
    const took = performance.now() - t0
    assert.ok(took < ms, `花了 ${Math.round(took)} ms（上限 ${ms} ms）`)
  }

  test('已分組的張被跳過也要算：2 萬個夾在中間的 keep × 20 萬張已分組的 → 幾秒內做完或丟 TOO_MUCH_WORK', { timeout: 20000 }, () => {
    const items = [{ id: 'K0', width: 1, height: 1, hash: H16, fine: one, takenAt: 100 }]
    for (let i = 1; i < 20000; i++) items.push({ id: 'K' + i, width: 1 + i, height: 1, hash: H16, fine: strip(1 + i), takenAt: 50 })
    for (let i = 0; i < 200000; i++) items.push({ id: 'D' + i, width: 1, height: 1, hash: H16, fine: one, takenAt: 0 })
    expectBounded(items, 5000)
  })

  test('只靠「跳過已分組的張」拖時間：5000 個 keep 各要跨過 100 萬張已分組的（互看只有 1250 萬次，不會觸發上限）→ 還是要幾秒內做完', { timeout: 30000 }, () => {
    // 最新的 K0 先把 100 萬張 D 收走；K1..K4999 比 D 新、寬度各不相同。
    // 舊版每個 K 都要逐一跳過 100 萬張已分組的 D（不算工作量），約 50 億次；新版分組後就不會再看到它們
    const items = [{ id: 'K0', width: 1, height: 1, hash: H16, fine: one, takenAt: 200 }]
    for (let i = 1; i < 5000; i++) items.push({ id: 'K' + i, width: 1 + i, height: 1, hash: H16, fine: strip(1 + i), takenAt: 100 })
    for (let i = 0; i < 1_000_000; i++) items.push({ id: 'D' + i, width: 1, height: 1, hash: H16, fine: one, takenAt: 0 })
    const t0 = performance.now()
    const groups = burstGroups(items)
    const took = performance.now() - t0
    assert.equal(groups.length, 1)
    assert.equal(groups[0].keep, 'K0')
    assert.equal(groups[0].drop.length, 1_000_000)
    assert.ok(took < 5000, `花了 ${Math.round(took)} ms`)
  })

  test('每次比對都很便宜（寬度各不相同）：6.3 萬張 → 幾秒內做完或丟 TOO_MUCH_WORK', { timeout: 20000 }, () => {
    const items = []
    for (let i = 0; i < 63300; i++) items.push({ id: 'c' + i, width: 1 + i, height: 1, hash: H16, fine: strip(1 + i), takenAt: 0 })
    expectBounded(items, 5000)
  })
})

// ── 4. 14 張真實截圖交叉比對 ───────────────────────────────────────
describe('14 張真實截圖交叉比對要一致', () => {
  test('內容跟 05-scroll-a 更接近的 02-typed-b，不可以比 01-same-a 更「不像」05-scroll-a', t => {
    // 05-scroll-a 是同一個表單、欄位裡已經有「王」；02-typed-b 也有「王」，01-same-a 沒有
    const a01 = realInfo('01-same-a'), b02 = realInfo('02-typed-b'), s05 = realInfo('05-scroll-a')
    if (isNearDuplicate(a01, s05)) assert.equal(isNearDuplicate(b02, s05), true, '01-same-a 算像 05-scroll-a，02-typed-b 更該算像')
    const r01 = fineCompare(a01.fine, s05.fine), r02 = fineCompare(b02.fine, s05.fine)
    t.diagnostic(`01-same-a vs 05-scroll-a：${rep(r01)}`)
    t.diagnostic(`02-typed-b vs 05-scroll-a：${rep(r02)}`)
  })

  test('14 張照截圖順序、每 5 秒一張分組：同一個表單頁（01、02、05-scroll-a：差「王」與垃圾桶徽章 3→1）一組 similar、勾選框一組 similar、07-doc-a 與 08-text-a 是同一張圖 same（要能載入原圖確認）', () => {
    const order = ['01-same-a', '01-same-b', '02-typed-b', '03-check-a', '03-check-b', '04-dialog-a', '04-dialog-b', '05-scroll-a', '05-scroll-b', '06-size-b', '07-doc-a', '07-doc-b', '08-text-a', '08-text-b']
    const items = order.map((name, i) => ({ id: name, ...realInfo(name), takenAt: 1_000_000 + i * 5000 }))
    const loaded = []
    const groups = burstGroups(items, { loadGray: id => { loaded.push(id); return realGray(id) } })
    assert.deepEqual(groups.map(g => [g.keep, g.level, g.members.map(m => [m.id, m.level])]), [
      ['08-text-a', 'same', [['07-doc-a', 'same']]],
      ['05-scroll-a', 'similar', [['02-typed-b', 'similar'], ['01-same-b', 'similar'], ['01-same-a', 'similar']]],
      ['03-check-b', 'similar', [['03-check-a', 'similar']]],
    ])
    assert.deepEqual(groups[0].members[0].boxes, [], '同一張圖沒有外框')
    // 只有細比對看不出差別的那一對要載入原圖，每張一次
    assert.deepEqual(loaded, ['08-text-a', '07-doc-a'])
    // 沒辦法載入原圖：那一組是 similar、外框是空的（沒辦法確認），不會是 same
    const blind = burstGroups(items)
    assert.deepEqual(blind.map(g => [g.keep, g.level]), [['08-text-a', 'similar'], ['05-scroll-a', 'similar'], ['03-check-b', 'similar']])
    assert.deepEqual(blind[0].members, [{ id: '07-doc-a', level: 'similar', boxes: [] }])
  })
})
