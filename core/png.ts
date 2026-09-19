/**
 * 零依賴 PNG 解碼器：只輸出灰階（拿來算長相指紋），省記憶體。
 *
 * 輸入是不可信的（任何人都能讓使用者下載一張惡意 PNG），所以：
 * - 先驗簽章、每個 chunk 的長度與 CRC，截斷一律丟錯，絕不回半張圖
 * - 解壓之前就用 IHDR 的尺寸擋掉太大的圖（預設 4000 萬像素）
 * - 解壓上限 = 應有的原始大小 + 1，壓縮炸彈解到上限就停
 * - 一個檔最多 100 萬個 chunk；IDAT 不論切成幾段，都只記起點、段數與總長度，不會每段留一個物件
 * - 每個迴圈都只往前走、長度有上限，任何輸入都不會卡住
 *
 * 灰階規則（寫死在預想表）：
 * - Y = (299R + 587G + 114B + 500) / 1000 取整（四捨五入）
 * - 透明度疊在白底上（跟在白色頁面上看到的一樣）；tRNS 也算透明度
 * - 16 位元取高位元組；小於 8 位元等比放大到 0..255
 * - tRNS 比對用完整的樣本值（16 位元就比 16 位元）
 * - 交錯式（Adam7）直接拒絕（INTERLACED）
 *
 * 記憶體峰值是下面四份相加：
 * - 輸入本身（呼叫端已經讀進來的檔案）
 * - 壓縮資料接起來的副本：只有 IDAT 分成好幾段時才有，不會超過輸入大小；只有一段就直接用輸入，不複製
 * - 解壓後的原始資料：高 ×（每列位元組數 ＋ 1）。每列多 1 byte 記 filter，所以窄圖不能用
 *   「每像素位元組數 × 像素數」估：寬 1 的 1 位元灰階每列要 2 bytes，是那個估法的 16 倍
 * - 灰階輸出：像素數
 * 後兩份合計「高 ×（每列位元組數 ＋ 1）＋ 像素數」。預設上限下最壞是 1 × 4000 萬的 RGBA 16 位元：
 * 4000 萬 ×（8 ＋ 1）＋ 4000 萬 ＝ 400 MB。實測（Node 24，全零圖，maxRSS 比解一張小圖多多少）：
 * - RGBA 16 位元：1 × 4000 萬多 406 MB，8000 × 5000 多 366 MB
 * - 1 位元灰階：1 × 4000 萬多 126 MB，8000 × 5000 多 50 MB
 * 壓縮炸彈最多用到「原始資料」那一份就停，不會超過解一張同尺寸的正常圖。要更省就調低 maxPixels。
 */
import { crc32, inflateSync } from 'node:zlib'

export type PngErrorCode =
  | 'NOT_PNG'
  | 'TRUNCATED'
  | 'CORRUPT'
  | 'TOO_LARGE'
  | 'INTERLACED'
  | 'UNSUPPORTED'
  | 'BAD_OPTION'

export class PngError extends Error {
  code: PngErrorCode
  constructor(code: PngErrorCode, message: string) {
    super(message)
    this.name = 'PngError'
    this.code = code
  }
}

export type PngGray = { width: number; height: number; gray: Uint8Array }

type Header = {
  width: number
  height: number
  bitDepth: number
  colorType: number
  compression: number
  filterMethod: number
  interlace: number
}

type Chunk = { type: string; dataStart: number; length: number; next: number }

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const DEFAULT_MAX_PIXELS = 40_000_000
/**
 * 一個檔最多幾個 chunk（含 IHDR、IEND）。每個 chunk 都要驗 CRC，數量不設限的話，
 * 幾百 MB 全是 12 bytes 空 chunk 的檔會讓解碼花好幾秒。正常的圖遠遠用不到：
 * 4000 萬像素的 RGBA 16 位元（原始資料最多 360 MB）就算不壓縮、用常見的 8 KB 一段，也才約 4.4 萬個 IDAT。
 */
const MAX_CHUNKS = 1_000_000
/** PNG 規格：chunk 長度與寬高都不可以超過 2^31−1。 */
const MAX_U31 = 0x7fffffff
/** 每種 color type 的通道數。 */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
/** 每種 color type 允許的 bit depth（PNG 規格表 11.1）。 */
const ALLOWED_DEPTHS: Record<number, number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
}
const KNOWN_CRITICAL = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND'])

function fail(code: PngErrorCode, message: string): never {
  throw new PngError(code, message)
}

function readU32(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0
}

function readU16(buf: Uint8Array, off: number): number {
  return (buf[off] << 8) | buf[off + 1]
}

function checkSignature(buf: unknown): Uint8Array {
  if (!(buf instanceof Uint8Array)) fail('NOT_PNG', '輸入不是 Buffer／Uint8Array，不是 PNG')
  const n = Math.min(buf.length, SIGNATURE.length)
  for (let i = 0; i < n; i++) {
    if (buf[i] !== SIGNATURE[i]) fail('NOT_PNG', '檔頭簽章不對，這不是 PNG')
  }
  if (buf.length === 0) fail('NOT_PNG', '空的檔案，不是 PNG')
  if (buf.length < SIGNATURE.length) fail('TRUNCATED', '檔案在 PNG 簽章中間就結束了')
  return buf
}

/** 名稱第一個字母大寫＝關鍵 chunk（第 5 位元為 0）。 */
function isCritical(type: string): boolean {
  return (type.charCodeAt(0) & 0x20) === 0
}

function isLetter(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
}

/** 讀 pos 位置的一個 chunk：驗長度、名稱、範圍、CRC。 */
function readChunk(buf: Uint8Array, pos: number): Chunk {
  if (pos + 8 > buf.length) fail('TRUNCATED', '檔案在 chunk 標頭中間就結束了')
  const length = readU32(buf, pos)
  if (length > MAX_U31) fail('CORRUPT', `chunk 長度 ${length} 超過規格上限`)
  for (let i = 4; i < 8; i++) {
    if (!isLetter(buf[pos + i])) fail('CORRUPT', 'chunk 名稱不是英文字母')
  }
  const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7])
  const next = pos + 12 + length
  if (next > buf.length) fail('TRUNCATED', `${type} chunk 不完整，檔案被截斷了`)
  const stored = readU32(buf, pos + 8 + length)
  if (crc32(buf.subarray(pos + 4, pos + 8 + length)) !== stored) fail('CORRUPT', `${type} chunk 的 CRC 不對`)
  return { type, dataStart: pos + 8, length, next }
}

/** 驗簽章、讀第一個 chunk（必須是 IHDR）。只驗結構與寬高，不判斷其他欄位。 */
function readHeader(input: unknown): { buf: Uint8Array; header: Header; next: number } {
  const buf = checkSignature(input)
  const c = readChunk(buf, 8)
  if (c.type !== 'IHDR') {
    if (isCritical(c.type) && !KNOWN_CRITICAL.has(c.type)) {
      fail('UNSUPPORTED', `第一個 chunk 是不認得的關鍵 chunk ${c.type}（例如 Apple 的 CgBI），不支援`)
    }
    fail('CORRUPT', '第一個 chunk 不是 IHDR')
  }
  if (c.length !== 13) fail('CORRUPT', `IHDR 長度應該是 13，實際是 ${c.length}`)
  const d = c.dataStart
  const header: Header = {
    width: readU32(buf, d),
    height: readU32(buf, d + 4),
    bitDepth: buf[d + 8],
    colorType: buf[d + 9],
    compression: buf[d + 10],
    filterMethod: buf[d + 11],
    interlace: buf[d + 12],
  }
  if (header.width === 0 || header.height === 0) fail('CORRUPT', '寬或高是 0')
  if (header.width > MAX_U31 || header.height > MAX_U31) fail('CORRUPT', '寬或高超過規格上限 2^31−1')
  return { buf, header, next: c.next }
}

/** 只讀 IHDR 的寬高，不解壓。不判斷太大（呼叫端自己決定）。 */
export function pngSize(buf: Buffer | Uint8Array): { width: number; height: number } {
  const { header } = readHeader(buf)
  return { width: header.width, height: header.height }
}

function resolveMaxPixels(opts: unknown): number {
  if (opts === undefined || opts === null) return DEFAULT_MAX_PIXELS
  if (typeof opts !== 'object') fail('BAD_OPTION', 'opts 必須是物件')
  const m = (opts as { maxPixels?: unknown }).maxPixels
  if (m === undefined) return DEFAULT_MAX_PIXELS
  if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0) {
    fail('BAD_OPTION', 'maxPixels 必須是大於 0 的有限數字')
  }
  return m
}

function validateHeader(h: Header): void {
  const depths = ALLOWED_DEPTHS[h.colorType]
  if (depths === undefined) fail('CORRUPT', `color type ${h.colorType} 不存在`)
  if (!depths.includes(h.bitDepth)) fail('CORRUPT', `color type ${h.colorType} 不能搭配 bit depth ${h.bitDepth}`)
  if (h.compression !== 0) fail('UNSUPPORTED', `不認得的壓縮方法 ${h.compression}`)
  if (h.filterMethod !== 0) fail('UNSUPPORTED', `不認得的 filter 方法 ${h.filterMethod}`)
  if (h.interlace === 1) fail('INTERLACED', '交錯式（Adam7）PNG 不支援')
  if (h.interlace !== 0) fail('UNSUPPORTED', `不認得的交錯方法 ${h.interlace}`)
}

/**
 * IDAT 只記位置：第一個 IDAT chunk 的起點、連續幾段、資料總長度。
 * 不可以每段存一個 subarray——幾十萬段零長度或 1 byte 的 IDAT 會讓 JS heap 用量變成檔案大小的
 * 好幾十倍，最後整個行程被 V8 OOM 殺掉（攔不下來，不是 PngError）。
 */
type IdatRun = { start: number; count: number; bytes: number }

type Collected = { idat: IdatRun; plte: Uint8Array | null; trns: Uint8Array | null }

/** 從 IHDR 之後掃到 IEND：驗每個 chunk，記下 IDAT 的位置、收集 PLTE／tRNS。 */
function collectChunks(buf: Uint8Array, start: number): Collected {
  const idat: IdatRun = { start: -1, count: 0, bytes: 0 }
  let plte: Uint8Array | null = null
  let trns: Uint8Array | null = null
  // 0：還沒遇到 IDAT；1：在 IDAT 區段裡；2：IDAT 區段已經結束
  let idatState = 0
  let chunks = 1 // IHDR 已經讀過了
  let pos = start
  for (;;) {
    if (pos >= buf.length) fail('TRUNCATED', '沒有 IEND，檔案被截斷了')
    if (++chunks > MAX_CHUNKS) fail('TOO_LARGE', `chunk 超過 ${MAX_CHUNKS} 個，不解`)
    const c = readChunk(buf, pos)
    if (c.type === 'IDAT') {
      if (idatState === 2) fail('CORRUPT', 'IDAT 不連續（中間夾了別的 chunk）')
      if (idatState === 0) idat.start = pos
      idatState = 1
      idat.count++
      idat.bytes += c.length
      pos = c.next
      continue
    }
    pos = c.next
    const data = buf.subarray(c.dataStart, c.dataStart + c.length)
    if (idatState === 1) idatState = 2
    if (c.type === 'IEND') {
      if (c.length !== 0) fail('CORRUPT', 'IEND 不應該有資料')
      break
    }
    if (c.type === 'IHDR') fail('CORRUPT', 'IHDR 出現兩次')
    if (c.type === 'PLTE') {
      if (plte !== null) fail('CORRUPT', 'PLTE 出現兩次')
      if (idatState !== 0) fail('CORRUPT', 'PLTE 出現在 IDAT 之後')
      if (c.length === 0 || c.length % 3 !== 0 || c.length > 768) fail('CORRUPT', `PLTE 長度 ${c.length} 不對`)
      plte = data
      continue
    }
    if (c.type === 'tRNS') {
      // 規格要求 tRNS 在 IDAT 之前；之後出現的跟重複的都忽略（libpng 也是這樣）
      if (trns === null && idatState === 0) trns = data
      continue
    }
    if (isCritical(c.type)) fail('UNSUPPORTED', `不認得的關鍵 chunk ${c.type}，依規格不能略過`)
    // 不認得的輔助 chunk：略過
  }
  if (idat.count === 0) fail('CORRUPT', '沒有 IDAT，沒有影像資料')
  return { idat, plte, trns }
}

/**
 * 把連續的 IDAT 資料接成一段壓縮資料。只有一段就直接用原輸入（不複製）；
 * 好幾段就一次配好總長度再逐段複製，不先建每段的陣列。chunk 結構與 CRC 在 collectChunks 已經驗過，
 * 而且 collectChunks 保證 IDAT 連續（不連續就丟 CORRUPT），所以從起點往後走 count 段一定都是 IDAT。
 */
function joinIdat(buf: Uint8Array, run: IdatRun): Uint8Array {
  if (run.count === 1) return buf.subarray(run.start + 8, run.start + 8 + run.bytes)
  let out: Uint8Array
  try {
    out = new Uint8Array(run.bytes)
  } catch {
    fail('TOO_LARGE', '壓縮資料太大，配置不了記憶體')
  }
  let pos = run.start
  let o = 0
  for (let i = 0; i < run.count; i++) {
    const len = readU32(buf, pos)
    const d = pos + 8
    // 很短的段逐 byte 複製，省掉每段建一個 subarray 物件
    if (len < 32) for (let j = 0; j < len; j++) out[o + j] = buf[d + j]
    else out.set(buf.subarray(d, d + len), o)
    o += len
    pos = d + len + 4
  }
  return out
}

/** 解壓：上限 = 應有大小 + 1，超過就停（壓縮炸彈）。 */
function inflateCapped(compressed: Uint8Array, expected: number): Uint8Array {
  let raw: Uint8Array
  try {
    // chunkSize 比上限多 1：只配一塊輸出緩衝、最後不用再拼接。
    // 不能剛好等於上限——那樣炸彈會先把第一塊填滿、Node 再配第二塊繼續解，才發現超過，峰值變兩倍
    raw = inflateSync(compressed, { maxOutputLength: expected + 1, chunkSize: Math.max(64, expected + 2) })
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'ERR_BUFFER_TOO_LARGE') fail('CORRUPT', '解壓後的資料超過應有大小（可能是壓縮炸彈）')
    if (code === 'Z_BUF_ERROR') fail('TRUNCATED', '壓縮資料不完整，檔案被截斷了')
    if (err instanceof RangeError) fail('TOO_LARGE', '圖太大，配置不了記憶體')
    fail('CORRUPT', `壓縮資料壞了（${code ?? '未知錯誤'}）`)
  }
  if (raw.length > expected) fail('CORRUPT', '解壓後的資料比應有的多')
  if (raw.length < expected) fail('CORRUPT', '解壓後的資料不足，影像不完整')
  return raw
}

/** 就地還原五種 filter。stride = 1 + rowBytes；bpp = 一個完整像素的位元組數（至少 1）。 */
function unfilter(raw: Uint8Array, height: number, rowBytes: number, bpp: number): void {
  const stride = rowBytes + 1
  for (let y = 0; y < height; y++) {
    const ft = raw[y * stride]
    const p = y * stride + 1
    const up = p - stride
    const hasUp = y > 0
    switch (ft) {
      case 0:
        break
      case 1: // Sub
        for (let i = bpp; i < rowBytes; i++) raw[p + i] = (raw[p + i] + raw[p + i - bpp]) & 0xff
        break
      case 2: // Up
        if (hasUp) for (let i = 0; i < rowBytes; i++) raw[p + i] = (raw[p + i] + raw[up + i]) & 0xff
        break
      case 3: // Average：用整數算，a+b 可以到 510，不能先截成 byte
        for (let i = 0; i < rowBytes; i++) {
          const a = i >= bpp ? raw[p + i - bpp] : 0
          const b = hasUp ? raw[up + i] : 0
          raw[p + i] = (raw[p + i] + ((a + b) >> 1)) & 0xff
        }
        break
      case 4: // Paeth：照規格，平手時先 a、再 b、最後 c
        for (let i = 0; i < rowBytes; i++) {
          const a = i >= bpp ? raw[p + i - bpp] : 0
          const b = hasUp ? raw[up + i] : 0
          const c = hasUp && i >= bpp ? raw[up + i - bpp] : 0
          const pv = a + b - c
          const pa = pv > a ? pv - a : a - pv
          const pb = pv > b ? pv - b : b - pv
          const pc = pv > c ? pv - c : c - pv
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          raw[p + i] = (raw[p + i] + pred) & 0xff
        }
        break
      default:
        fail('CORRUPT', `第 ${y} 列的 filter type ${ft} 不存在`)
    }
  }
}

/** 亮度（×1000）疊白底後四捨五入：a=255 時等於 (Y1000 + 500) / 1000 取整。 */
function blend(y1000: number, alpha: number): number {
  return ((y1000 * alpha + 255000 * (255 - alpha) + 127500) / 255000) | 0
}

function luma1000(r: number, g: number, b: number): number {
  return 299 * r + 587 * g + 114 * b
}

/** 樣本值（≤ 8 位元）→ 灰階的查表；-1 代表不合法（調色盤索引超出範圍）。 */
function lookupTable(h: Header, plte: Uint8Array | null, trns: Uint8Array | null): Int16Array {
  const size = 1 << h.bitDepth
  const table = new Int16Array(size).fill(-1)
  if (h.colorType === 3) {
    if (plte === null) fail('CORRUPT', '調色盤圖缺少 PLTE')
    const entries = Math.min(plte.length / 3, size)
    for (let i = 0; i < entries; i++) {
      const alpha = trns !== null && i < trns.length ? trns[i] : 255
      table[i] = blend(luma1000(plte[3 * i], plte[3 * i + 1], plte[3 * i + 2]), alpha)
    }
    return table
  }
  // 灰階 1／2／4／8 位元
  const maxv = size - 1
  const t = trns !== null && trns.length === 2 ? readU16(trns, 0) : -1
  for (let s = 0; s < size; s++) table[s] = s === t ? 255 : (s * 255) / maxv
  return table
}

function toGray(raw: Uint8Array, h: Header, plte: Uint8Array | null, trns: Uint8Array | null, rowBytes: number): Uint8Array {
  const { width, height, bitDepth: bd, colorType: ct } = h
  let out: Uint8Array
  try {
    out = new Uint8Array(width * height)
  } catch {
    fail('TOO_LARGE', '圖太大，配置不了灰階輸出的記憶體')
  }
  const stride = rowBytes + 1
  let o = 0

  if ((ct === 0 && bd <= 8) || ct === 3) {
    const table = lookupTable(h, plte, trns)
    const mask = (1 << bd) - 1
    for (let y = 0; y < height; y++) {
      const p = y * stride + 1
      for (let x = 0; x < width; x++) {
        let s: number
        if (bd === 8) s = raw[p + x]
        else {
          const bit = x * bd
          s = (raw[p + (bit >> 3)] >> (8 - bd - (bit & 7))) & mask
        }
        const v = table[s]
        if (v < 0) fail('CORRUPT', `調色盤索引 ${s} 超出調色盤範圍`)
        out[o++] = v
      }
    }
    return out
  }

  const wide = bd === 16
  const sb = wide ? 2 : 1 // 每個樣本幾個 byte；高位元組在前
  const ch = CHANNELS[ct]
  const pixelBytes = ch * sb

  if (ct === 0) {
    // 16 位元灰階：tRNS 用完整 16 位元比對，輸出取高位元組
    const t = trns !== null && trns.length === 2 ? readU16(trns, 0) : -1
    for (let y = 0; y < height; y++) {
      const p = y * stride + 1
      for (let x = 0; x < width; x++) {
        const i = p + x * 2
        out[o++] = readU16(raw, i) === t ? 255 : raw[i]
      }
    }
    return out
  }

  if (ct === 2) {
    let tr = -1
    let tg = -1
    let tb = -1
    if (trns !== null && trns.length === 6) {
      tr = readU16(trns, 0)
      tg = readU16(trns, 2)
      tb = readU16(trns, 4)
    }
    for (let y = 0; y < height; y++) {
      const p = y * stride + 1
      for (let x = 0; x < width; x++) {
        const i = p + x * pixelBytes
        const r = raw[i]
        const g = raw[i + sb]
        const b = raw[i + 2 * sb]
        if (tr >= 0) {
          const fr = wide ? readU16(raw, i) : r
          const fg = wide ? readU16(raw, i + 2) : g
          const fb = wide ? readU16(raw, i + 4) : b
          if (fr === tr && fg === tg && fb === tb) {
            out[o++] = 255
            continue
          }
        }
        out[o++] = ((luma1000(r, g, b) + 500) / 1000) | 0
      }
    }
    return out
  }

  if (ct === 4) {
    for (let y = 0; y < height; y++) {
      const p = y * stride + 1
      for (let x = 0; x < width; x++) {
        const i = p + x * pixelBytes
        out[o++] = blend(1000 * raw[i], raw[i + sb])
      }
    }
    return out
  }

  // ct === 6
  for (let y = 0; y < height; y++) {
    const p = y * stride + 1
    for (let x = 0; x < width; x++) {
      const i = p + x * pixelBytes
      out[o++] = blend(luma1000(raw[i], raw[i + sb], raw[i + 2 * sb]), raw[i + 3 * sb])
    }
  }
  return out
}

/**
 * 解 PNG 成灰階。所有錯誤都是 PngError（帶 code）。
 * 支援 color type 0／2／3／4／6、規格允許的 bit depth 1／2／4／8／16、五種 filter、tRNS。
 */
export function decodePngGray(buf: Buffer | Uint8Array, opts?: { maxPixels?: number }): PngGray {
  const maxPixels = resolveMaxPixels(opts)
  const { buf: bytes, header: h, next } = readHeader(buf)
  // 解壓之前就擋掉太大的圖（連後面的 chunk 都還沒讀）
  if (h.width * h.height > maxPixels) {
    fail('TOO_LARGE', `圖太大：${h.width}×${h.height} 超過上限 ${maxPixels} 像素`)
  }
  validateHeader(h)
  const { idat, plte, trns } = collectChunks(bytes, next)
  if (h.colorType === 3 && plte === null) fail('CORRUPT', '調色盤圖缺少 PLTE')

  const bitsPerPixel = CHANNELS[h.colorType] * h.bitDepth
  const rowBytes = Math.ceil((h.width * bitsPerPixel) / 8)
  const expected = h.height * (rowBytes + 1)
  const raw = inflateCapped(joinIdat(bytes, idat), expected)
  unfilter(raw, h.height, rowBytes, Math.max(1, bitsPerPixel >> 3))
  const gray = toGray(raw, h, plte, trns, rowBytes)
  return { width: h.width, height: h.height, gray }
}
