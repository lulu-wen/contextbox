// imagehash 的 synth4 合成圖讀取（imagehash-round4／round5 測試共用；檔名不是 .test.mjs，node --test 不會單獨跑它）。
// 底圖＋貼回幾個方塊，最後驗 sha256；dHash／fineSig 只重算被方塊蓋到的格子（每張底圖抽一張跟直接算的比對）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dHash, fineSig, resizeGray } from '../core/imagehash.ts'

export const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'imagehash')
const S4 = join(FIX, 'synth4')
export const synth4 = JSON.parse(readFileSync(join(S4, 'synth4.json'), 'utf8'))

// ── 讀合成圖：底圖＋貼回幾個方塊，最後驗 sha256 ───────────────────────
// 8K 的圖每張算 dHash／fineSig 要 0.1 秒以上，所以底圖算一次，貼了方塊的圖只重算被方塊蓋到的格子
//（照面積平均的定義逐格算，跟 resizeGray 一樣是精確整數；每個畫面抽一張跟 dHash／fineSig 直接算的比對過，見 checkIncremental）
const baseCache = new Map() // 只留最近用到的兩張底圖（8K 一張 33 MB）
function baseEntry(name) {
  if (baseCache.has(name)) return baseCache.get(name)
  const m = synth4.images[name]
  const g = new Uint8Array(gunzipSync(readFileSync(join(S4, `${name}.gray.gz`))))
  assert.equal(createHash('sha256').update(g).digest('hex'), m.sha256, `${name} 內容不對`)
  const img = { width: m.width, height: m.height, gray: g }
  const fine = fineSig(img)
  const e = { img, fine, small: resizeGray(img, 9, 8), hash: dHash(img), checked: false }
  baseCache.set(name, e)
  if (baseCache.size > 2) baseCache.delete(baseCache.keys().next().value)
  return e
}
/** 面積平均縮到 tw×th 之後，第 (tx, ty) 格的值（跟 resizeGray 同一個定義：重疊長度相乘加權、四捨五入）。 */
function cellValue(g, W, H, tw, th, tx, ty) {
  let num = 0
  const xa = Math.floor((tx * W) / tw), xb = Math.ceil(((tx + 1) * W) / tw)
  const ya = Math.floor((ty * H) / th), yb = Math.ceil(((ty + 1) * H) / th)
  for (let y = ya; y < yb; y++) {
    const oy = Math.min((y + 1) * th, (ty + 1) * H) - Math.max(y * th, ty * H)
    if (oy <= 0) continue
    let row = 0
    for (let x = xa; x < xb; x++) {
      const ox = Math.min((x + 1) * tw, (tx + 1) * W) - Math.max(x * tw, tx * W)
      if (ox > 0) row += g[y * W + x] * ox
    }
    num += row * oy
  }
  const den = W * H
  return Math.floor((2 * num + den) / (2 * den))
}
/** 底圖的縮圖 base（tw×th）換成貼了方塊之後的縮圖：只重算被方塊蓋到的格子。 */
function patchedResize(base, g, W, H, tw, th, patches) {
  const out = new Uint8Array(base)
  for (const [px, py, pw, ph] of patches) {
    const tx0 = Math.floor((px * tw) / W), tx1 = Math.floor(((px + pw) * tw - 1) / W)
    const ty0 = Math.floor((py * th) / H), ty1 = Math.floor(((py + ph) * th - 1) / H)
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) out[ty * tw + tx] = cellValue(g, W, H, tw, th, tx, ty)
  }
  return out
}
function hashOf(small) {
  let hex = ''
  for (let r = 0; r < 8; r++) {
    let byte = 0
    for (let c = 0; c < 8; c++) byte = (byte << 1) | (small[r * 9 + c] < small[r * 9 + c + 1] ? 1 : 0)
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}
/** 回 { width, height, hash, fine, gray }（gray 是原圖灰階，拿來確認 same）。 */
export function synthItem(name) {
  const m = synth4.images[name]
  assert.ok(m, `synth4 缺 ${name}`)
  if (!m.base) {
    const e = baseEntry(name)
    return { width: m.width, height: m.height, hash: e.hash, fine: e.fine, gray: e.img.gray }
  }
  const e = baseEntry(m.base)
  const g = new Uint8Array(e.img.gray)
  const patches = m.patches ?? []
  if (patches.length) {
    const p = gunzipSync(readFileSync(join(S4, `${name}.patch.gz`)))
    let off = 0
    for (const [px, py, pw, ph] of patches) {
      for (let y = 0; y < ph; y++) g.set(p.subarray(off + y * pw, off + (y + 1) * pw), (py + y) * m.width + px)
      off += pw * ph
    }
    assert.equal(off, p.length, `${name} 的方塊大小不對`)
  }
  assert.equal(createHash('sha256').update(g).digest('hex'), m.sha256, `${name} 重組後內容不對`)
  const fw = e.fine.w, fh = e.fine.h
  const fine = { w: fw, h: fh, px: patchedResize(e.fine.px, g, m.width, m.height, fw, fh, patches) }
  const hash = hashOf(patchedResize(e.small, g, m.width, m.height, 9, 8, patches))
  const item = { width: m.width, height: m.height, hash, fine, gray: g }
  if (!e.checked) {
    // 每張底圖第一次用到時，抽這一張跟 dHash／fineSig 直接算的比對（逐位元組）
    e.checked = true
    checkIncremental(item)
  }
  return item
}
let incrementalChecks = 0
function checkIncremental(item) {
  const img = { width: item.width, height: item.height, gray: item.gray }
  assert.equal(item.hash, dHash(img), '只重算方塊蓋到的格子，dHash 要跟直接算的一樣')
  assert.deepEqual(item.fine, fineSig(img), '只重算方塊蓋到的格子，fineSig 要跟直接算的一樣')
  incrementalChecks++
}

/** 到目前為止跟 dHash／fineSig 直接算的比對過幾張。 */
export function incrementalCheckCount() {
  return incrementalChecks
}
