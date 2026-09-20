/**
 * 零依賴的灰階 PNG 編碼器。**只給縮圖用**，所以只寫一種形式：
 * 8 位元灰階、非交錯、每一列的 filter 都是 0（none）。
 *
 * 為什麼不重用 tools/demo-setup.mjs 那一份：那是產生假資料的工具，不在 core 裡，
 * 也沒有輸入檢查。這一支收的是 resizeGray 出來的陣列，長度對不上就丟錯 ——
 * 寫出一張尺寸與內容對不上的圖，面板上看到的是花掉的畫面，而使用者要用它
 * 判斷「這兩張是不是同一張」。
 *
 * 大小：filter 0 每一列多一個位元組，所以未壓縮是 height × (width + 1)，
 * 長邊 480 的縮圖最多 480 × 481 ≈ 231 KB，deflate 之後通常只有幾 KB。
 */
import { deflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** PNG 的 CRC-32（跟 zlib 的 crc32 同一個多項式，這裡自己算，免得依賴回傳型別）。 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const isPosInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0

/**
 * 灰階圖 → PNG。`gray` 的長度一定要剛好是 width × height（一個位元組一個像素，0 是黑、255 是白）。
 */
export function encodeGrayPng(width: number, height: number, gray: Uint8Array): Buffer {
  if (!isPosInt(width) || !isPosInt(height)) {
    throw new Error(`寬高必須是正整數：${String(width)}×${String(height)}。`)
  }
  if (!(gray instanceof Uint8Array)) throw new Error('灰階資料必須是 Uint8Array。')
  if (gray.length !== width * height) {
    throw new Error(`灰階資料的長度 ${gray.length} 跟 ${width}×${height} 對不上。`)
  }
  const stride = width + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0   // filter: none
    // Buffer.set 一次搬一整列，不逐像素寫
    raw.set(gray.subarray(y * width, y * width + width), y * stride + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8    // 每個樣本 8 位元
  ihdr[9] = 0    // 色彩型態 0：灰階
  ihdr[10] = 0   // 壓縮方法：deflate
  ihdr[11] = 0   // filter 方法：0
  ihdr[12] = 0   // 非交錯
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
