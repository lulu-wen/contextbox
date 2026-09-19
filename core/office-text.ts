/**
 * 讀純文字檔、Word（.docx）、PowerPoint（.pptx）的文字。
 *
 * 零外部依賴：zip 只讀 central directory，自己找 local header；XML 用自己寫的線性掃描器，
 * 不用任何 XML 解析器，也不用會回溯爆炸的正規式。
 *
 * 輸入一律當成不可信：任何輸入都只會「回傳文字」或「丟 ExtractError」，
 * 不會卡住、不會無限迴圈、不會照著檔案宣稱的大小去配置記憶體。
 *
 * 預算（上限）用完時：已經讀到的字照樣回傳，標 truncated: true；一個字都沒讀到才丟錯（TOO_LARGE，巢狀太深是 CORRUPT）。
 * 例外是 readZip 本身：它不回傳文字，超過上限一律丟錯。
 */
import { crc32, inflateRawSync } from 'node:zlib'

export type ExtractErrorCode = 'CORRUPT' | 'TOO_LARGE' | 'UNSUPPORTED' | 'ENCRYPTED' | 'EMPTY'

export class ExtractError extends Error {
  code: ExtractErrorCode
  constructor(code: ExtractErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ExtractError'
    this.code = code
  }
}

/** zip 的預設上限：entry 數、單檔解壓後大小、同一個 zip 解壓總量。 */
export const ZIP_LIMITS = Object.freeze({
  maxEntries: 5000,
  maxEntryBytes: 50 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
})

/** 輸出的文字上限（以字＝Unicode code point 計）。 */
export const DEFAULT_MAX_CHARS = 20_000
/** pptx 預設最多讀幾張投影片。 */
export const DEFAULT_MAX_SLIDES = 1000

const HARD_MAX_CHARS = 5_000_000
const MAX_XML_DEPTH = 1024
/** 結尾標籤對不上時，最多往下找幾層。限制它才不會被「大量對不上的結尾標籤」拖成平方時間。 */
const CLOSE_SEARCH_DEPTH = 16

// 解析時的記憶體上限。單檔 50 MB 只擋得住「解壓出來的量」，擋不住「解析時的放大」：
// 幾 MB 的 rels 塞一百萬筆 Relationship，每筆變成 Map 裡的物件，記憶體就是檔案的一兩百倍，
// heap 不夠時整個 Node 行程直接 OOM（try/catch 接不住）。所以凡是「每遇到一個 X 就留一份」的地方都要有上限，
// 而且要照「實際產生的字串總長度」算，不能只數筆數：一筆很短的 Target 接上很長的資料夾名稱，產生的字串就很長。

/** 一個 rels 檔最多讀幾筆 Relationship（之後的不讀）。zip 最多 5000 個 part，留一倍給外部連結與指不到的關聯。 */
const MAX_RELATIONSHIPS = ZIP_LIMITS.maxEntries * 2
/** sldIdLst 最多讀幾個 sldId（之後的不讀）。每張投影片都是 zip 裡的一個 part，超過 zip 的 entry 上限一定是重複或指不到的。 */
const MAX_SLIDE_IDS = ZIP_LIMITS.maxEntries
/** 一個標籤最多看前幾個屬性（含寫壞的）。我們要讀的 Relationship、sldId、vanish 都只有幾個屬性。 */
const MAX_ATTRS = 64
/**
 * Relationship 的 Target 最長幾個字元。zip 檔名最長 65,535 byte，百分比編碼最多變 3 倍；
 * 再長就不可能指到 zip 裡的任何 part，直接當成指不到，不去切路徑（切路徑會變成幾百萬個小字串）。
 */
const MAX_TARGET_CHARS = 3 * 0xffff
/**
 * 解 Target 的字數總預算（每個 rels 檔各自算）。每解一筆就扣「來源資料夾＋Target」的長度：
 * 這就是解出來的路徑字串有多長，切段、轉小寫的工作量也跟它成正比。
 * 正常簡報 5,000 張投影片 × 路徑 30 字左右只用到 15 萬；惡意檔（很長的資料夾＋幾千筆關聯）在這裡停下。
 */
const MAX_RESOLVE_CHARS = 1 << 22
/**
 * Relationship 的 Id 最長幾個字元，超過的當成沒有這筆（sldId 也就對不到它）。真的 Id 是 rId12 這種幾個字的東西。
 * 限制它是因為 V8 對超過 16,383 字的字串不算完整雜湊（只看長度）：拿這種字串當 Map 的鍵，
 * 同樣長度的全部擠在一起、每次查都要逐字比，3,000 筆就要十秒。
 */
const MAX_REL_ID_CHARS = 255
/**
 * zip 裡的檔名最長幾 byte，超過的 entry 當成不存在（不列出來）。理由同上：檔名是 Map 的鍵，
 * 5,000 個 17,000 字的檔名光是建 Map 就要十幾秒。16,383 byte 解碼後最多 16,383 字，雜湊正常。
 */
const MAX_ENTRY_NAME_BYTES = 16_383
/** 解實體時每累積這麼多段就先接起來，片段陣列才不會跟著實體數量長到幾千萬格。 */
const ENTITY_FLUSH_PARTS = 4096

export type ZipOptions = { maxEntries?: number; maxEntryBytes?: number; maxTotalBytes?: number }

// ---------------------------------------------------------------------
// 共用小工具
// ---------------------------------------------------------------------

function toBuffer(input: unknown): Buffer {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  throw new ExtractError('UNSUPPORTED', '輸入必須是 Buffer 或 Uint8Array')
}

function requireNonEmpty(buf: Buffer): void {
  if (buf.length === 0) throw new ExtractError('EMPTY', '檔案是空的（0 byte）')
}

/** 把非 ExtractError 的意外錯誤包成 CORRUPT，保證呼叫端只會看到 ExtractError。 */
function guard<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof ExtractError) throw err
    throw new ExtractError('CORRUPT', `無法解析：${(err as Error)?.message ?? String(err)}`, { cause: err })
  }
}

function limitOption(value: unknown, fallback: number, hardMax: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) return fallback
  if (!Number.isFinite(value)) return hardMax
  return Math.min(Math.floor(value), hardMax)
}

const hasNonWhitespace = (s: string): boolean => /\S/.test(s)

/**
 * 從 s 開頭數 room 個 code point。
 * 放得下整個 s 就回傳 { end: -1, taken: s 的 code point 數 }；放不下回傳切點 end（不會切在代理對中間）。
 */
function takeCodePoints(s: string, room: number): { end: number; taken: number } {
  let taken = 0
  let i = 0
  const n = s.length
  while (i < n) {
    if (taken === room) return { end: i, taken }
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
      const d = s.charCodeAt(i + 1)
      i += d >= 0xdc00 && d <= 0xdfff ? 2 : 1
    } else {
      i += 1
    }
    taken++
  }
  return { end: -1, taken }
}

// ---------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const SIG_ZIP64_EOCD = 0x06064b50
const EOCD_LEN = 22
const CENTRAL_LEN = 46
const LOCAL_LEN = 30
const EOCD_SIG_BYTES = Buffer.from([0x50, 0x4b, 0x05, 0x06])

const FLAG_ENCRYPTED = 0x0001
const FLAG_STRONG_ENCRYPTION = 0x0040
const FLAG_UTF8 = 0x0800
const FLAG_MASKED_HEADERS = 0x2000
const METHOD_STORED = 0
const METHOD_DEFLATE = 8
const METHOD_AES = 99

/** 從檔尾往回找 EOCD（最多往回 22 + 65535 byte）。找不到回傳 -1。 */
function findEocd(buf: Buffer): number {
  if (buf.length < EOCD_LEN) return -1
  const minPos = Math.max(0, buf.length - EOCD_LEN - 0xffff)
  let pos = buf.length - EOCD_LEN
  while (pos >= minPos) {
    const at = buf.lastIndexOf(EOCD_SIG_BYTES, pos)
    if (at < minPos) return -1
    const commentLen = buf.readUInt16LE(at + 20)
    if (at + EOCD_LEN + commentLen <= buf.length) return at
    pos = at - 1
  }
  return -1
}

/** EOCD（傳統結尾記錄）的欄位。 */
type EocdFields = { disk: number; cdDisk: number; countDisk: number; count: number; cdSize: number; cdOffset: number }

/** 傳統欄位被填成 0xFFFF／0xFFFFFFFF：真正的值只寫在 ZIP64 記錄裡，用傳統欄位讀不完整。 */
const needsZip64 = (e: EocdFields): boolean =>
  e.count === 0xffff || e.countDisk === 0xffff || e.cdSize === 0xffffffff || e.cdOffset === 0xffffffff

/**
 * 有 ZIP64 定位記錄時（例如 Info-ZIP 從 stdin 壓的檔，檔案很小也會加）：
 * - ZIP64 結尾記錄宣稱的 entry 數超過上限 → TOO_LARGE；定位記錄說分成多個檔案 → UNSUPPORTED。
 * - 傳統欄位被填成 0xFFFF／0xFFFFFFFF → UNSUPPORTED（真的需要 ZIP64 才讀得完整）。
 * - 找得到 ZIP64 結尾記錄、但它的值跟傳統欄位不一樣 → CORRUPT。支援 ZIP64 的讀取器（例如 Python）會照 ZIP64 記錄讀，
 *   我們照傳統欄位讀，兩邊會讀到不同內容；這種檔一定是做出來的，不猜。
 * - 定位記錄指的地方找不到 ZIP64 結尾記錄：刻意放寬，照傳統欄位讀（見函式最後的註解）。
 * - 其他情況照傳統欄位讀。
 * 回傳 central directory 最遠能到的位置：ZIP64 結尾記錄的開頭（找不到就是定位記錄的開頭）。
 */
function checkZip64(buf: Buffer, eocd: number, e: EocdFields, maxEntries: number): number {
  const locator = eocd - 20
  if (buf.readUInt32LE(locator + 4) !== 0 || buf.readUInt32LE(locator + 16) > 1) {
    throw new ExtractError('UNSUPPORTED', '不支援分割成多個檔案的 zip')
  }
  const candidates: number[] = []
  const claimed = buf.readBigUInt64LE(locator + 8)
  if (claimed <= BigInt(locator)) candidates.push(Number(claimed))
  candidates.push(locator - 56)
  let at = -1
  for (const c of candidates) {
    if (c >= 0 && c + 56 <= locator && buf.readUInt32LE(c) === SIG_ZIP64_EOCD) {
      at = c
      break
    }
  }
  if (at >= 0) {
    const onDisk = buf.readBigUInt64LE(at + 24)
    const total = buf.readBigUInt64LE(at + 32)
    if (total > BigInt(maxEntries) || onDisk > BigInt(maxEntries)) {
      throw new ExtractError('TOO_LARGE', `zip 宣稱有 ${total} 個 entry，超過上限 ${maxEntries}`)
    }
    if (needsZip64(e)) throw new ExtractError('UNSUPPORTED', '不支援 ZIP64 格式的 zip（傳統欄位裝不下真正的值）')
    const same = buf.readUInt32LE(at + 16) === e.disk
      && buf.readUInt32LE(at + 20) === e.cdDisk
      && onDisk === BigInt(e.countDisk)
      && total === BigInt(e.count)
      && buf.readBigUInt64LE(at + 40) === BigInt(e.cdSize)
      && buf.readBigUInt64LE(at + 48) === BigInt(e.cdOffset)
    if (!same) throw new ExtractError('CORRUPT', 'ZIP64 結尾記錄跟傳統的結尾記錄不一致')
    return at
  }
  // 定位記錄指的地方沒有 ZIP64 結尾記錄：我們當作沒有 ZIP64，照傳統欄位讀。
  // 注意這跟別的工具不一樣：Python 3.12 的 zipfile 丟 BadZipFile（Zip64 end of central directory record not found），
  // unzip 6.0 也拒讀。刻意放寬的理由：
  // 1. 第三輪規格：傳統欄位讀得完整就照讀，不因為有 ZIP64 定位記錄就拒絕。
  // 2. 不會造成「兩個讀取器讀到不同內容」：Python 和 unzip 什麼都不讀，檔案裡也沒有第二套結尾記錄可以指到別的內容
  //    （真的有兩套、會讀到不同內容的「ZIP64 記錄跟傳統欄位不一致」，在上面丟 CORRUPT）。
  // 需要 ZIP64 才讀得完整（傳統欄位是 0xFFFF／0xFFFFFFFF）、分割壓縮檔，照樣拒絕。
  if (needsZip64(e)) throw new ExtractError('UNSUPPORTED', '不支援 ZIP64 格式的 zip（傳統欄位裝不下真正的值）')
  return locator
}

function decodeZipName(bytes: Buffer, flags: number): string {
  if (flags & FLAG_UTF8) return new TextDecoder('utf-8').decode(bytes)
  // 很多工具沒設 UTF-8 旗標但實際是 UTF-8；不是合法 UTF-8 就當 latin1（名字只拿來查表，不會寫到磁碟）
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return bytes.toString('latin1')
  }
}

type CentralEntry = {
  name: string
  flags: number
  method: number
  crc: number
  compSize: number
  uncompSize: number
  localOffset: number
}

type ZipContext = {
  buf: Buffer
  delta: number
  cdStart: number
  maxEntryBytes: number
  maxTotalBytes: number
  used: number
}

function extractEntry(ctx: ZipContext, e: CentralEntry): Buffer {
  const { buf } = ctx
  if (e.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_MASKED_HEADERS) || e.method === METHOD_AES) {
    throw new ExtractError('ENCRYPTED', `「${e.name}」有加密，讀不到`)
  }
  if (e.method !== METHOD_STORED && e.method !== METHOD_DEFLATE) {
    throw new ExtractError('UNSUPPORTED', `「${e.name}」用了不支援的壓縮法（${e.method}）`)
  }
  if (e.uncompSize > ctx.maxEntryBytes) {
    throw new ExtractError('TOO_LARGE', `「${e.name}」宣稱解開有 ${e.uncompSize} byte，超過單檔上限 ${ctx.maxEntryBytes}`)
  }
  if (ctx.used + e.uncompSize > ctx.maxTotalBytes) {
    throw new ExtractError('TOO_LARGE', `這個 zip 解壓總量超過上限 ${ctx.maxTotalBytes} byte`)
  }
  ctx.used += e.uncompSize

  // 大小一律用 central directory 的；local header 只拿來算資料從哪裡開始
  const lh = e.localOffset + ctx.delta
  if (lh + LOCAL_LEN > ctx.cdStart || buf.readUInt32LE(lh) !== SIG_LOCAL) {
    throw new ExtractError('CORRUPT', `「${e.name}」的 local header 不見了`)
  }
  const start = lh + LOCAL_LEN + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28)
  const end = start + e.compSize
  if (end > ctx.cdStart) throw new ExtractError('CORRUPT', `「${e.name}」的資料超出範圍（檔案可能被截斷）`)
  const raw = buf.subarray(start, end)

  let out: Buffer
  if (e.method === METHOD_STORED) {
    if (e.compSize !== e.uncompSize) throw new ExtractError('CORRUPT', `「${e.name}」未壓縮但前後大小不一樣`)
    out = Buffer.from(raw)
  } else if (e.compSize === 0 && e.uncompSize === 0) {
    // 有些工具把空檔標成 deflate 但一個位元組都不寫
    out = Buffer.alloc(0)
  } else {
    try {
      // 解出來的量不准超過宣稱的大小：zip bomb 在這裡就停下，不會真的解到 1 GB
      out = inflateRawSync(raw, { maxOutputLength: Math.max(1, e.uncompSize) })
    } catch {
      throw new ExtractError('CORRUPT', `「${e.name}」解壓失敗，或解出來比宣稱的 ${e.uncompSize} byte 大`)
    }
    if (out.length !== e.uncompSize) {
      throw new ExtractError('CORRUPT', `「${e.name}」解出來 ${out.length} byte，跟宣稱的 ${e.uncompSize} 不一樣`)
    }
  }
  if ((crc32(out) >>> 0) !== e.crc) throw new ExtractError('CORRUPT', `「${e.name}」的 CRC 對不上`)
  return out
}

/**
 * 讀 zip 的 central directory，回傳「名字 → 解壓函式」。
 *
 * - 只信 central directory 的大小與 CRC（local header 可能是 0，例如有 data descriptor 的 entry）。
 * - 單檔、總量上限在呼叫解壓函式時檢查（沒讀的大檔案不影響，例如簡報裡的影片）。
 * - 加密的 entry 會列出來，但解壓時丟 ENCRYPTED（不會悄悄跳過）。
 * - 有 ZIP64 記錄、但傳統欄位就讀得完整的照讀；真的需要 ZIP64 的、分割壓縮檔丟 UNSUPPORTED；
 *   ZIP64 記錄跟傳統欄位不一致丟 CORRUPT；entry 超過上限丟 TOO_LARGE。
 * - 資料夾 entry、檔名超過 16,383 byte 的 entry 不列。
 */
export function readZip(buf: Buffer, opts?: ZipOptions): Map<string, () => Buffer> {
  return guard(() => {
    const b = toBuffer(buf)
    requireNonEmpty(b)
    const o = opts ?? {}
    const maxEntries = limitOption(o.maxEntries, ZIP_LIMITS.maxEntries, 1_000_000)
    const maxEntryBytes = limitOption(o.maxEntryBytes, ZIP_LIMITS.maxEntryBytes, 1024 * 1024 * 1024)
    const maxTotalBytes = limitOption(o.maxTotalBytes, ZIP_LIMITS.maxTotalBytes, 4 * 1024 * 1024 * 1024)

    const eocd = findEocd(b)
    if (eocd < 0) throw new ExtractError('CORRUPT', '找不到 zip 的結尾記錄：不是 zip，或檔案被截斷')
    const fields: EocdFields = {
      disk: b.readUInt16LE(eocd + 4),
      cdDisk: b.readUInt16LE(eocd + 6),
      countDisk: b.readUInt16LE(eocd + 8),
      count: b.readUInt16LE(eocd + 10),
      cdSize: b.readUInt32LE(eocd + 12),
      cdOffset: b.readUInt32LE(eocd + 16),
    }
    const { disk, cdDisk, countDisk, count, cdSize, cdOffset } = fields
    // central directory 最遠能到哪裡：有 ZIP64 記錄時是 ZIP64 結尾記錄的開頭，否則是 EOCD
    let cdLimit = eocd
    if (eocd >= 20 && b.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR) cdLimit = checkZip64(b, eocd, fields, maxEntries)

    if (count > maxEntries || countDisk > maxEntries) {
      throw new ExtractError('TOO_LARGE', `zip 宣稱有 ${count} 個 entry，超過上限 ${maxEntries}`)
    }
    if (needsZip64(fields)) throw new ExtractError('UNSUPPORTED', '不支援 ZIP64 格式的 zip')
    if (disk !== 0 || cdDisk !== 0 || countDisk !== count) {
      throw new ExtractError('UNSUPPORTED', '不支援分割成多個檔案的 zip')
    }

    const claimedEnd = cdOffset + cdSize
    if (claimedEnd > cdLimit) throw new ExtractError('CORRUPT', 'central directory 超出檔案範圍（檔案可能被截斷）')
    // 前面接了別的資料（例如自解壓檔）時，所有 offset 都少算了那段長度
    let delta = 0
    if (cdSize > 0) {
      const gap = cdLimit - claimedEnd
      if (gap > 0 && cdSize >= 4 && b.readUInt32LE(cdOffset + gap) === SIG_CENTRAL) delta = gap
      else if (cdSize >= 4 && b.readUInt32LE(cdOffset) === SIG_CENTRAL) delta = 0
      else throw new ExtractError('CORRUPT', '找不到 central directory')
    }
    const cdStart = cdOffset + delta
    const cdEnd = cdStart + cdSize

    const ctx: ZipContext = { buf: b, delta, cdStart, maxEntryBytes, maxTotalBytes, used: 0 }
    const out = new Map<string, () => Buffer>()
    let p = cdStart
    let seen = 0
    while (p < cdEnd) {
      seen++
      if (seen > maxEntries) throw new ExtractError('TOO_LARGE', `zip 的 entry 超過上限 ${maxEntries}`)
      if (p + CENTRAL_LEN > cdEnd || b.readUInt32LE(p) !== SIG_CENTRAL) {
        throw new ExtractError('CORRUPT', 'central directory 的記錄壞掉了')
      }
      const flags = b.readUInt16LE(p + 8)
      const method = b.readUInt16LE(p + 10)
      const crc = b.readUInt32LE(p + 16)
      const compSize = b.readUInt32LE(p + 20)
      const uncompSize = b.readUInt32LE(p + 24)
      const nameLen = b.readUInt16LE(p + 28)
      const extraLen = b.readUInt16LE(p + 30)
      const commentLen = b.readUInt16LE(p + 32)
      const diskStart = b.readUInt16LE(p + 34)
      const localOffset = b.readUInt32LE(p + 42)
      const next = p + CENTRAL_LEN + nameLen + extraLen + commentLen
      if (next > cdEnd) throw new ExtractError('CORRUPT', 'central directory 的記錄超出範圍')
      if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff || diskStart === 0xffff) {
        throw new ExtractError('UNSUPPORTED', '不支援 ZIP64 格式的 zip')
      }
      if (diskStart !== 0) throw new ExtractError('UNSUPPORTED', '不支援分割成多個檔案的 zip')
      if (nameLen > MAX_ENTRY_NAME_BYTES) {
        // 不可能是 Office 的 part，也不去解碼：當成不存在
        p = next
        continue
      }
      const name = decodeZipName(b.subarray(p + CENTRAL_LEN, p + CENTRAL_LEN + nameLen), flags)
      p = next
      if (name.endsWith('/') && uncompSize === 0) continue
      if (out.has(name)) throw new ExtractError('CORRUPT', `zip 裡有兩個同名的「${name}」`)
      const entry: CentralEntry = { name, flags, method, crc, compSize, uncompSize, localOffset }
      out.set(name, () => guard(() => extractEntry(ctx, entry)))
    }
    if (seen !== count) throw new ExtractError('CORRUPT', `zip 宣稱有 ${count} 個 entry，實際有 ${seen} 個`)
    return out
  })
}

// ---------------------------------------------------------------------
// XML：線性掃描器
// ---------------------------------------------------------------------

type XmlHandler = {
  stop: boolean
  open(local: string, xml: string, attrStart: number, attrEnd: number): void
  close(local: string): void
  text(raw: string, cdata: boolean): void
}

const isXmlSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d

/** 標籤名稱 [start, end) 裡最後一個冒號之後的部分（不看前綴，因為前綴不一定是 w:／a:）。 */
function localNameOf(xml: string, start: number, end: number): string {
  let colon = -1
  for (let i = start; i < end; i++) if (xml.charCodeAt(i) === 0x3a) colon = i
  return xml.slice(colon < 0 ? start : colon + 1, end)
}

/** 跳過 <!DOCTYPE …>：看引號與 [ ] 內部子集，但完全不處理裡面的實體定義。回傳 > 之後的位置。 */
function skipDeclaration(xml: string, i: number): number {
  const n = xml.length
  let depth = 0
  let quote = 0
  for (; i < n; i++) {
    const c = xml.charCodeAt(i)
    if (quote) {
      if (c === quote) quote = 0
    } else if (c === 0x22 || c === 0x27) {
      quote = c
    } else if (c === 0x5b) {
      depth++
    } else if (c === 0x5d) {
      if (depth > 0) depth--
    } else if (c === 0x3e && depth === 0) {
      return i + 1
    }
  }
  return n
}

/** 掃一遍 XML，每個位置最多看常數次：總時間跟輸入長度成正比。 */
function scanXml(xml: string, h: XmlHandler): void {
  const n = xml.length
  let i = 0
  while (i < n && !h.stop) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) {
      h.text(xml.slice(i), false)
      return
    }
    if (lt > i) {
      h.text(xml.slice(i, lt), false)
      if (h.stop) return
    }
    const c = xml.charCodeAt(lt + 1)
    if (c === 0x21) {
      if (xml.startsWith('!--', lt + 1)) {
        const e = xml.indexOf('-->', lt + 4)
        if (e < 0) return
        i = e + 3
      } else if (xml.startsWith('![CDATA[', lt + 1)) {
        const e = xml.indexOf(']]>', lt + 9)
        if (e < 0) return
        h.text(xml.slice(lt + 9, e), true)
        i = e + 3
      } else {
        i = skipDeclaration(xml, lt + 2)
      }
      continue
    }
    if (c === 0x3f) {
      const e = xml.indexOf('?>', lt + 2)
      if (e < 0) return
      i = e + 2
      continue
    }
    if (c === 0x2f) {
      const e = xml.indexOf('>', lt + 2)
      if (e < 0) return
      let nameEnd = lt + 2
      while (nameEnd < e && !isXmlSpace(xml.charCodeAt(nameEnd))) nameEnd++
      h.close(localNameOf(xml, lt + 2, nameEnd))
      i = e + 1
      continue
    }
    // 開始標籤：找結尾的 >，引號裡的 > 不算
    let j = lt + 1
    let quote = 0
    while (j < n) {
      const ch = xml.charCodeAt(j)
      if (quote) {
        if (ch === quote) quote = 0
      } else if (ch === 0x22 || ch === 0x27) {
        quote = ch
      } else if (ch === 0x3e) {
        break
      }
      j++
    }
    if (j >= n) return
    const selfClosing = xml.charCodeAt(j - 1) === 0x2f && j - 1 > lt
    const tagEnd = selfClosing ? j - 1 : j
    let nameEnd = lt + 1
    while (nameEnd < tagEnd && !isXmlSpace(xml.charCodeAt(nameEnd))) nameEnd++
    const local = localNameOf(xml, lt + 1, nameEnd)
    h.open(local, xml, nameEnd, tagEnd)
    if (selfClosing && !h.stop) h.close(local)
    i = j + 1
  }
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const REPLACEMENT = String.fromCharCode(0xfffd)

const isEntityChar = (c: number): boolean =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x23

function entityValue(body: string): string | null {
  const named = NAMED_ENTITIES[body]
  if (named !== undefined && Object.hasOwn(NAMED_ENTITIES, body)) return named
  if (body.charCodeAt(0) !== 0x23) return null
  let cp: number
  if (body.charCodeAt(1) === 0x78 || body.charCodeAt(1) === 0x58) {
    const digits = body.slice(2)
    if (digits.length === 0) return null
    for (let i = 0; i < digits.length; i++) {
      const c = digits.charCodeAt(i)
      const hex = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)
      if (!hex) return null
    }
    cp = parseInt(digits, 16)
  } else {
    const digits = body.slice(1)
    if (digits.length === 0) return null
    for (let i = 0; i < digits.length; i++) {
      const c = digits.charCodeAt(i)
      if (c < 0x30 || c > 0x39) return null
    }
    cp = parseInt(digits, 10)
  }
  if (!(cp > 0) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return REPLACEMENT
  return String.fromCodePoint(cp)
}

/**
 * 解 &amp; &lt; &gt; &quot; &apos; &#NNN; &#xHH;。只解一層；不認得的（含 DTD 自訂實體）原樣保留。
 * 記憶體只跟輸出一樣大：片段每累積 ENTITY_FLUSH_PARTS 段就先接成一塊（一個 <w:t> 裡塞幾百萬個 &amp; 也不會放大）。
 */
function decodeEntities(s: string): string {
  let amp = s.indexOf('&')
  if (amp < 0) return s
  const chunks: string[] = []
  let parts: string[] = []
  let last = 0
  while (amp >= 0) {
    // 往後最多看 34 個字元找分號，而且只接受實體名稱允許的字元：遇到別的立刻放棄，不會回頭重掃
    const limit = Math.min(s.length, amp + 34)
    let k = amp + 1
    while (k < limit && isEntityChar(s.charCodeAt(k))) k++
    if (k < limit && s.charCodeAt(k) === 0x3b && k > amp + 1) {
      const rep = entityValue(s.slice(amp + 1, k))
      if (rep !== null) {
        parts.push(s.slice(last, amp), rep)
        last = k + 1
        if (parts.length >= ENTITY_FLUSH_PARTS) {
          chunks.push(parts.join(''))
          parts = []
        }
      }
    }
    amp = s.indexOf('&', amp + 1)
  }
  parts.push(s.slice(last))
  if (chunks.length === 0) return parts.join('')
  chunks.push(parts.join(''))
  return chunks.join('')
}

/**
 * 只解析一個標籤的屬性區間 [start, end)，時間跟區間長度成正比。
 * 只看前 MAX_ATTRS 個屬性（含寫壞的），之後的一律不看：一個標籤塞幾百萬個屬性也不會變成幾百萬格的 Map。
 */
function parseAttrs(xml: string, start: number, end: number): Map<string, string> {
  const out = new Map<string, string>()
  let i = start
  let tokens = 0
  while (i < end) {
    while (i < end && isXmlSpace(xml.charCodeAt(i))) i++
    if (i >= end) break
    if (++tokens > MAX_ATTRS) break
    const nameStart = i
    while (i < end) {
      const c = xml.charCodeAt(i)
      if (c === 0x3d || c === 0x2f || isXmlSpace(c)) break
      i++
    }
    const name = xml.slice(nameStart, i)
    while (i < end && isXmlSpace(xml.charCodeAt(i))) i++
    if (i >= end || xml.charCodeAt(i) !== 0x3d) {
      i++
      continue
    }
    i++
    while (i < end && isXmlSpace(xml.charCodeAt(i))) i++
    const q = xml.charCodeAt(i)
    if (q !== 0x22 && q !== 0x27) {
      i++
      continue
    }
    let v = i + 1
    while (v < end && xml.charCodeAt(v) !== q) v++
    if (v >= end) break
    if (name && !out.has(name)) out.set(name, decodeEntities(xml.slice(i + 1, v)))
    i = v + 1
  }
  return out
}

/** 巢狀超過 MAX_XML_DEPTH 層：掃描停在這裡（前面讀到的字照樣回傳，一個字都沒有才丟這個錯）。 */
const tooDeep = (): ExtractError => new ExtractError('CORRUPT', `XML 巢狀超過 ${MAX_XML_DEPTH} 層`)

/** 元素堆疊：限制深度；結尾標籤對不上時最多往下找 CLOSE_SEARCH_DEPTH 層，找不到就忽略。 */
class ElementStack {
  names: string[] = []
  marks: boolean[] = []
  onPop: (name: string, marked: boolean) => void

  constructor(onPop: (name: string, marked: boolean) => void) {
    this.onPop = onPop
  }

  /** 超過 MAX_XML_DEPTH 層就不放、回傳 false，呼叫端要停止掃描。 */
  push(name: string): boolean {
    if (this.names.length >= MAX_XML_DEPTH) return false
    this.names.push(name)
    this.marks.push(false)
    return true
  }

  at(fromTop: number): string | undefined {
    return this.names[this.names.length - 1 - fromTop]
  }

  close(name: string): void {
    const n = this.names.length
    const floor = Math.max(0, n - CLOSE_SEARCH_DEPTH)
    for (let i = n - 1; i >= floor; i--) {
      if (this.names[i] === name) {
        while (this.names.length > i) {
          const popped = this.names.pop() as string
          const marked = this.marks.pop() as boolean
          this.onPop(popped, marked)
        }
        return
      }
    }
  }
}

/**
 * 輸出累積器：以 code point 計字數；換行先記著，後面真的有字才寫出去（所以開頭、結尾不會有換行）。
 * 超過上限時只在「丟掉的部分有非空白字元」才標 truncated，並停止掃描。
 */
class TextSink {
  maxChars: number
  parts: string[] = []
  count = 0
  pending = 0
  truncated = false
  stop = false

  constructor(maxChars: number) {
    this.maxChars = maxChars
  }

  /** 記一個換行；連續換行最多 cap 個。 */
  newline(cap: number): void {
    if (this.pending < cap) this.pending++
  }

  /** 至少要 n 個換行（投影片之間）。 */
  breakAtLeast(n: number): void {
    if (this.pending < n) this.pending = n
  }

  push(s: string): void {
    if (this.stop || s.length === 0) return
    if (this.count > 0 && this.pending > 0) {
      if (this.count + this.pending >= this.maxChars) {
        if (hasNonWhitespace(s)) this.cut()
        return
      }
      this.parts.push('\n'.repeat(this.pending))
      this.count += this.pending
    }
    this.pending = 0
    const room = this.maxChars - this.count
    const { end, taken } = takeCodePoints(s, room)
    if (end < 0) {
      this.parts.push(s)
      this.count += taken
      return
    }
    this.parts.push(s.slice(0, end))
    this.count += taken
    if (hasNonWhitespace(s.slice(end))) this.cut()
  }

  cut(): void {
    this.truncated = true
    this.stop = true
  }

  done(): string {
    return this.parts.join('')
  }
}

// ---------------------------------------------------------------------
// OOXML 共用：zip 裡的 part、relationships
// ---------------------------------------------------------------------

/**
 * 一筆 Relationship。target 是原始的 Target（只解了 XML 實體），用到時才解成 zip 裡的路徑；
 * part 是解過的結果（zip 裡的 part 名稱，或 null＝指不到），每筆最多解一次。
 */
type Rel = { kind: 'main' | 'slide' | 'other'; target: string; external: boolean; part?: string | null }
/** 讀 rels 檔的結果。cut：超過 MAX_RELATIONSHIPS 筆，後面的沒讀。 */
type Rels = { map: Map<string, Rel>; cut: boolean }

/** OOXML 的 part 名稱不分大小寫：先精確找，找不到再不分大小寫找。 */
class Package {
  zip: Map<string, () => Buffer>
  lower: Map<string, string> | null = null

  constructor(zip: Map<string, () => Buffer>) {
    this.zip = zip
  }

  find(path: string): string | null {
    if (this.zip.has(path)) return path
    if (!this.lower) {
      this.lower = new Map()
      for (const k of this.zip.keys()) {
        const low = k.toLowerCase()
        if (!this.lower.has(low)) this.lower.set(low, k)
      }
    }
    return this.lower.get(path.toLowerCase()) ?? null
  }

  readXml(path: string): string {
    const get = this.zip.get(path)
    if (!get) throw new ExtractError('CORRUPT', `找不到「${path}」`)
    return bytesToXmlString(get())
  }
}

function bytesToXmlString(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le', { ignoreBOM: true }).decode(bytes.subarray(2))
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be', { ignoreBOM: true }).decode(bytes.subarray(2))
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(3))
  }
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
}

const dirOf = (part: string): string => {
  const slash = part.lastIndexOf('/')
  return slash < 0 ? '' : part.slice(0, slash)
}

function relsPathOf(part: string): string {
  const dir = dirOf(part)
  const base = part.slice(dir.length ? dir.length + 1 : 0)
  return `${dir ? `${dir}/` : ''}_rels/${base}.rels`
}

/** 把 rels 的 Target 解成 zip 裡的路徑（相對於來源 part 的資料夾；/ 開頭是從根目錄算）。 */
function resolveTarget(baseDir: string, target: string): string {
  let t = target
  try {
    t = decodeURIComponent(t)
  } catch {
    // 不是合法的百分比編碼就照原樣
  }
  const hash = t.indexOf('#')
  if (hash >= 0) t = t.slice(0, hash)
  const joined = t.startsWith('/') ? t.slice(1) : (baseDir ? `${baseDir}/${t}` : t)
  const out: string[] = []
  for (const seg of joined.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

function relKind(type: string): Rel['kind'] {
  if (type.endsWith('/officeDocument')) return 'main'
  if (type.endsWith('/slide')) return 'slide'
  return 'other'
}

/**
 * 讀 rels 檔，只留 Id、種類、原始 Target（不在這裡解路徑：路徑要接上來源資料夾，資料夾很長時每筆都是一份長字串）。
 * 最多讀 MAX_RELATIONSHIPS 筆，之後的不讀（cut）；Id 超過 MAX_REL_ID_CHARS 字的當成沒有；同一個 Id 只算第一筆。
 */
function parseRels(xml: string): Rels {
  const map = new Map<string, Rel>()
  let count = 0
  let cut = false
  const h: XmlHandler = {
    stop: false,
    open(local, src, a, b) {
      if (local !== 'Relationship') return
      if (++count > MAX_RELATIONSHIPS) {
        cut = true
        h.stop = true
        return
      }
      const attrs = parseAttrs(src, a, b)
      const id = attrs.get('Id')
      const target = attrs.get('Target')
      if (!id || id.length > MAX_REL_ID_CHARS || target === undefined || map.has(id)) return
      const external = (attrs.get('TargetMode') ?? '').toLowerCase() === 'external'
      const kind = relKind(attrs.get('Type') ?? '')
      // 用不到的關聯不留 Target
      map.set(id, { kind, target: kind === 'other' || external ? '' : target, external })
    },
    close() {},
    text() {},
  }
  scanXml(xml, h)
  return { map, cut }
}

/**
 * 把 Relationship 解成 zip 裡的 part 名稱，有字數總預算（MAX_RESOLVE_CHARS）。
 * 只有真的用到的關聯才解（officeDocument、sldIdLst 指到的），同一筆最多解一次。
 */
class TargetResolver {
  pkg: Package
  baseDir: string
  left = MAX_RESOLVE_CHARS
  exhausted = false

  constructor(pkg: Package, baseDir: string) {
    this.pkg = pkg
    this.baseDir = baseDir
  }

  /** 回傳 part 名稱、null（指不到）；預算用完回傳 undefined，之後每次都是 undefined。 */
  resolve(rel: Rel): string | null | undefined {
    if (rel.part !== undefined) return rel.part
    if (this.exhausted) return undefined
    // 太長的 Target 不可能指到任何 part：不解、不扣預算
    if (rel.target.length > MAX_TARGET_CHARS) return (rel.part = null)
    const cost = this.baseDir.length + rel.target.length
    if (cost > this.left) {
      this.exhausted = true
      return undefined
    }
    this.left -= cost
    const path = resolveTarget(this.baseDir, rel.target)
    // OPC 的 part 名稱不會是空的：解出空字串（空的 Target、只有 ../）一律當成指不到
    return (rel.part = path ? this.pkg.find(path) : null)
  }
}

/** 預算用完（清單太長、要解的路徑太多）：有讀到字就回傳並標 truncated，一個字都沒有才丟這個錯。 */
const overBudget = (what: string): ExtractError => new ExtractError('TOO_LARGE', `${what}超過上限，沒有讀完`)

/**
 * 從 _rels/.rels 找主文件（officeDocument）；沒有就用預設位置。
 * incomplete：rels 沒讀完（筆數或解路徑的預算用完）而且在讀到的部分裡沒找到主文件，預設位置不一定是真的主文件。
 */
function findMainPart(pkg: Package, fallback: string): { part: string | null; incomplete: boolean } {
  const rootRels = pkg.find('_rels/.rels')
  let incomplete = false
  if (rootRels) {
    const { map, cut } = parseRels(pkg.readXml(rootRels))
    const resolver = new TargetResolver(pkg, '')
    for (const rel of map.values()) {
      if (rel.external || rel.kind !== 'main') continue
      const part = resolver.resolve(rel)
      if (part === undefined) break
      if (part) return { part, incomplete: false }
    }
    incomplete = cut || resolver.exhausted
  }
  return { part: pkg.find(fallback), incomplete }
}

const OLE_SIGNATURE = Buffer.from('d0cf11e0a1b11ae1', 'hex')
const ENCRYPTED_PACKAGE = Buffer.from('EncryptedPackage', 'utf16le')

/** Office 的密碼保護檔其實是 OLE 容器（裡面有 EncryptedPackage）；舊版 .doc／.ppt 也是 OLE。 */
function rejectOle(buf: Buffer): void {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(OLE_SIGNATURE)) return
  if (buf.indexOf(ENCRYPTED_PACKAGE) >= 0) throw new ExtractError('ENCRYPTED', '這份 Office 文件有密碼保護')
  throw new ExtractError('UNSUPPORTED', '這是舊版 Office 格式（.doc／.ppt），不支援')
}

function openPackage(buf: unknown): Package {
  const b = toBuffer(buf)
  requireNonEmpty(b)
  rejectOle(b)
  return new Package(readZip(b))
}

// ---------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------

function isFalseValue(v: string | undefined): boolean {
  if (v === undefined) return false
  const s = v.trim().toLowerCase()
  return s === '0' || s === 'false' || s === 'off'
}

/**
 * 段落的容器：本文、表格儲存格、文字方塊。段落標記被刪掉的段落只跟「同一個容器裡的下一段」接起來；
 * 容器結束（儲存格最後一段、本文最後一段）或下一個區塊是表格時照樣換行，跟 LibreOffice「接受所有修訂」一樣。
 * <w:sdt>、<w:customXml> 這類包裝、書籤等標記不算容器，也不擋接段。
 */
const isParagraphContainer = (local: string): boolean => local === 'body' || local === 'tc' || local === 'txbxContent'

/** 掃 document.xml，把看得到的字寫進 sink；回傳根元素的名字，以及掃描是不是因為巢狀太深而停下（limit）。 */
function scanWordDocument(xml: string, sink: TextSink): { root: string | null; limit: ExtractError | null } {
  let root: string | null = null
  let limit: ExtractError | null = null
  let inText = 0
  let skip = 0 // 在 <w:del>、<w:moveFrom>、<mc:Fallback> 裡面
  let hiddenRuns = 0 // 堆疊上有幾個設了 <w:vanish/> 的 run
  const visible = (): boolean => skip === 0 && hiddenRuns === 0

  // 開著的段落容器在堆疊上的位置（最裡面的在最後）；沒有容器時用 -1
  const containers: number[] = []
  const container = (): number => (containers.length ? containers[containers.length - 1] : -1)
  // 段落標記被刪掉的段落剛結束：記下它所在的容器，等下一個區塊決定要接起來還是換行（null＝沒有）
  let joinIn: number | null = null
  const breakJoin = (): void => {
    if (joinIn !== null) {
      sink.newline(2)
      joinIn = null
    }
  }

  // 堆疊上的標記（marks）：run 上的代表「這個 run 隱藏」；段落上的代表「段落標記被修訂刪掉，跟下一段接成一段」
  const stack = new ElementStack((name, marked) => {
    const at = stack.names.length // 被彈出的元素原本在堆疊上的位置
    if (containers.length && containers[containers.length - 1] === at) {
      containers.pop()
      if (joinIn === at) breakJoin() // 容器結束：這段是容器裡最後一段，不跟容器外的東西接
    }
    if (name === 't') inText--
    else if (name === 'del' || name === 'moveFrom' || name === 'Fallback') skip--
    else if (name === 'p') {
      if (skip === 0) {
        if (marked) joinIn = container()
        else sink.newline(2)
      }
    } else if (name === 'r' && marked) hiddenRuns--
  })

  const h: XmlHandler = {
    stop: false,
    open(local, src, a, b) {
      if (root === null) {
        root = local
        if (local !== 'document') {
          h.stop = true
          return
        }
      }
      const parent = stack.at(0)
      const grand = stack.at(1)
      if (joinIn !== null) {
        // 下一個區塊：同一個容器裡的段落就接起來；表格就換行
        if (local === 'p' && joinIn === container()) joinIn = null
        else if (local === 'p' || local === 'tbl') breakJoin()
      }
      if (!stack.push(local)) {
        limit = tooDeep()
        h.stop = true
        return
      }
      if (isParagraphContainer(local)) containers.push(stack.names.length - 1)
      switch (local) {
        case 't':
          inText++
          break
        case 'del':
        case 'moveFrom':
          // <w:p><w:pPr><w:rPr><w:del/>：段落標記被刪掉（或移走），接受修訂後這段跟下一段接在一起
          if (parent === 'rPr' && grand === 'pPr' && stack.at(3) === 'p') stack.marks[stack.names.length - 4] = true
          skip++
          break
        case 'Fallback':
          skip++
          break
        case 'txbxContent':
          // 文字方塊的字自成一段，不黏在錨點前面的字上（方塊裡的段落結束時也會換行）
          if (visible()) sink.newline(2)
          break
        case 'tab':
        case 'ptab':
          if (parent === 'r' && visible()) sink.push('\t')
          break
        case 'br':
        case 'cr':
          if (parent === 'r' && visible()) sink.newline(2)
          break
        case 'noBreakHyphen':
          if (parent === 'r' && visible()) sink.push('-')
          break
        case 'vanish': {
          // 只有 run 自己的 <w:rPr><w:vanish/> 才算隱藏；段落標記（pPr/rPr）的不算
          if (parent !== 'rPr' || grand !== 'r') break
          if (isFalseValue(parseAttrs(src, a, b).get('w:val'))) break
          const runIndex = stack.names.length - 3
          if (!stack.marks[runIndex]) {
            stack.marks[runIndex] = true
            hiddenRuns++
          }
          break
        }
      }
      if (sink.stop) h.stop = true
    },
    close(local) {
      stack.close(local)
    },
    text(raw, cdata) {
      if (inText > 0 && visible()) {
        sink.push(cdata ? raw : decodeEntities(raw))
        if (sink.stop) h.stop = true
      }
    },
  }
  scanXml(xml, h)
  return { root, limit }
}

/**
 * 讀 .docx 看得到的文字：段落之間換行、<w:tab/> 轉 tab、<w:br/> 轉換行、表格儲存格照算、文字方塊的字自成一段。
 * 不算：修訂模式刪掉的字（w:del／w:delText）、移走的原位置（w:moveFrom）、隱藏文字（w:vanish）、
 * 功能變數代碼（w:instrText）、相容用的重複內容（mc:Fallback）。
 * 修訂模式刪掉（或移走）的段落標記：這段跟同一個容器（本文、同一格、同一個文字方塊）裡的下一段接成一段；
 * 容器的最後一段、下一個區塊是表格時照樣換行（跟 LibreOffice「接受所有修訂」後一樣）。
 * 只讀主文件本文（不含頁首頁尾、註腳、註解）。
 * 預算用完（_rels/.rels 超過 10,000 筆而且主文件不在前面、巢狀超過 1,024 層）：讀到的字照樣回傳並標 truncated；
 * 一個字都沒讀到才丟錯（TOO_LARGE；巢狀太深是 CORRUPT）。
 */
export function docxText(buf: Buffer, opts?: { maxChars?: number }): { text: string; truncated: boolean } {
  return guard(() => {
    const maxChars = limitOption(opts?.maxChars, DEFAULT_MAX_CHARS, HARD_MAX_CHARS)
    const pkg = openPackage(buf)
    const main = findMainPart(pkg, 'word/document.xml')
    if (!main.part) {
      if (main.incomplete) throw overBudget('_rels/.rels 的關聯（找不到 Word 的主文件）')
      throw new ExtractError('CORRUPT', '找不到 Word 的主文件（word/document.xml）')
    }
    const sink = new TextSink(maxChars)
    const { root, limit } = scanWordDocument(pkg.readXml(main.part), sink)
    if (root === null) throw new ExtractError('CORRUPT', 'Word 主文件是空的或不是 XML')
    if (root !== 'document') throw new ExtractError('UNSUPPORTED', `這不是 Word 文件（主文件是 <${root}>）`)
    const shortfall = limit ?? (main.incomplete ? overBudget('_rels/.rels 的關聯') : null)
    const text = sink.done()
    if (shortfall && !hasNonWhitespace(text)) throw shortfall
    return { text, truncated: sink.truncated || shortfall !== null }
  })
}

// ---------------------------------------------------------------------
// PowerPoint
// ---------------------------------------------------------------------

/**
 * 掃 presentation.xml：依序把 sldIdLst 裡每一個 sldId 的關聯 id 交給 onSlide（回傳 false 就停止）。
 * 回傳根元素名字；limit 是掃描為什麼沒掃完：sldId 超過 MAX_SLIDE_IDS 個（之後的不讀）或巢狀太深。
 */
function scanPresentation(xml: string, onSlide: (relId: string) => boolean): { root: string | null; limit: ExtractError | null } {
  let root: string | null = null
  let limit: ExtractError | null = null
  let inList = 0
  let slideIds = 0
  const stack = new ElementStack(name => {
    if (name === 'sldIdLst') inList--
  })
  const h: XmlHandler = {
    stop: false,
    open(local, src, a, b) {
      if (root === null) {
        root = local
        if (local !== 'presentation') {
          h.stop = true
          return
        }
      }
      if (!stack.push(local)) {
        limit = tooDeep()
        h.stop = true
        return
      }
      if (local === 'sldIdLst') inList++
      else if (local === 'sldId' && inList > 0) {
        if (++slideIds > MAX_SLIDE_IDS) {
          limit = overBudget(`投影片清單（sldIdLst，上限 ${MAX_SLIDE_IDS} 張）`)
          h.stop = true
          return
        }
        const attrs = parseAttrs(src, a, b)
        let rid = attrs.get('r:id')
        if (rid === undefined) {
          for (const [k, v] of attrs) {
            if (k.endsWith(':id') && !k.startsWith('xml')) {
              rid = v
              break
            }
          }
        }
        if (rid && !onSlide(rid)) h.stop = true
      }
    },
    close(local) {
      stack.close(local)
    },
    text() {},
  }
  scanXml(xml, h)
  return { root, limit }
}

/**
 * 掃一張投影片：<a:t> 是字、<a:p> 結束換行、<a:br/> 換行、<mc:Fallback> 不算。
 * 回傳 null；巢狀太深時停在那裡，回傳那個錯（前面的字已經寫進 sink）。
 */
function scanSlide(xml: string, sink: TextSink): ExtractError | null {
  let limit: ExtractError | null = null
  let inText = 0
  let skip = 0
  const stack = new ElementStack(name => {
    if (name === 't') inText--
    else if (name === 'Fallback') skip--
    else if (name === 'p' && skip === 0) sink.newline(1)
  })
  const h: XmlHandler = {
    stop: false,
    open(local) {
      if (!stack.push(local)) {
        limit = tooDeep()
        h.stop = true
        return
      }
      if (local === 't') inText++
      else if (local === 'Fallback') skip++
      else if (local === 'br' && skip === 0) sink.newline(1)
    },
    close(local) {
      stack.close(local)
    },
    text(raw, cdata) {
      if (inText > 0 && skip === 0) {
        sink.push(cdata ? raw : decodeEntities(raw))
        if (sink.stop) h.stop = true
      }
    },
  }
  scanXml(xml, h)
  return limit
}

/**
 * 讀 .pptx 投影片上的文字。
 * - 順序照 presentation.xml 的 sldIdLst ＋ rels（使用者看到的順序），不照檔名編號。
 * - 投影片之間空一行；同一張投影片裡段落只換一行（空段落不留）。
 * - 講者備忘不算。
 * - slides 是找到的投影片張數（不受 maxSlides 影響）；沒讀完或字數超過上限都標 truncated。
 * - 預算用完時讀到的字照樣回傳並標 truncated（這時 slides 只算到停下來的地方）：sldIdLst 超過 5,000 個 sldId、
 *   rels 超過 10,000 筆而且用到的關聯不在前面、解路徑的字數超過預算、某一張投影片超過 zip 的單檔或總量上限（跳過那張）、
 *   巢狀超過 1,024 層（那一張停在那裡）。一個字都沒讀到才丟錯（TOO_LARGE；巢狀太深是 CORRUPT）。
 */
export function pptxText(
  buf: Buffer,
  opts?: { maxChars?: number; maxSlides?: number },
): { text: string; slides: number; truncated: boolean } {
  return guard(() => {
    const maxChars = limitOption(opts?.maxChars, DEFAULT_MAX_CHARS, HARD_MAX_CHARS)
    const maxSlides = limitOption(opts?.maxSlides, DEFAULT_MAX_SLIDES, ZIP_LIMITS.maxEntries)
    const pkg = openPackage(buf)
    const main = findMainPart(pkg, 'ppt/presentation.xml')
    if (!main.part) {
      if (main.incomplete) throw overBudget('_rels/.rels 的關聯（找不到 PowerPoint 的主檔）')
      throw new ExtractError('CORRUPT', '找不到 PowerPoint 的主檔（ppt/presentation.xml）')
    }
    // 第一個用完的預算（沒有就是 null）
    let shortfall: ExtractError | null = main.incomplete ? overBudget('_rels/.rels 的關聯') : null
    const note = (err: ExtractError): void => {
      if (shortfall === null) shortfall = err
    }

    const relsPath = pkg.find(relsPathOf(main.part))
    const rels: Rels = relsPath ? parseRels(pkg.readXml(relsPath)) : { map: new Map(), cut: false }
    const resolver = new TargetResolver(pkg, dirOf(main.part))
    const slideParts: string[] = []
    const seen = new Set<string>()
    const pres = scanPresentation(pkg.readXml(main.part), relId => {
      const rel = rels.map.get(relId)
      if (!rel) {
        // rels 沒讀完：這筆可能在沒讀的那一段裡
        if (rels.cut) note(overBudget(`投影片的關聯（rels，上限 ${MAX_RELATIONSHIPS} 筆）`))
        return true
      }
      if (rel.external || rel.kind !== 'slide') return true
      const part = resolver.resolve(rel)
      if (part === undefined) {
        note(overBudget('要解的投影片路徑'))
        return false
      }
      if (part && !seen.has(part)) {
        seen.add(part)
        slideParts.push(part)
      }
      return true
    })
    if (pres.root === null) throw new ExtractError('CORRUPT', 'PowerPoint 主檔是空的或不是 XML')
    if (pres.root !== 'presentation') throw new ExtractError('UNSUPPORTED', `這不是 PowerPoint 簡報（主檔是 <${pres.root}>）`)
    if (pres.limit) note(pres.limit)

    const sink = new TextSink(maxChars)
    const n = Math.min(slideParts.length, maxSlides)
    for (let i = 0; i < n && !sink.stop; i++) {
      let xml: string
      try {
        xml = pkg.readXml(slideParts[i])
      } catch (err) {
        // 這張超過 zip 的單檔或總量上限：跳過，後面的照讀
        if (err instanceof ExtractError && err.code === 'TOO_LARGE') {
          note(err)
          continue
        }
        throw err
      }
      sink.breakAtLeast(2)
      const limit = scanSlide(xml, sink)
      if (limit) note(limit)
    }
    const text = sink.done()
    if (shortfall && !hasNonWhitespace(text)) throw shortfall
    return {
      text,
      slides: slideParts.length,
      truncated: sink.truncated || shortfall !== null || slideParts.length > maxSlides,
    }
  })
}

// ---------------------------------------------------------------------
// 純文字
// ---------------------------------------------------------------------

/**
 * Big5 的嚴格解碼（fatal：有任何解不開的位元組就放棄）。
 * 結尾不完整的雙位元組字只在「是我們自己切的（sliced）」時容忍，並丟掉那個尾巴。
 * 不因為「前面已經有中文」就容忍：Big5 的「前導＋ASCII 尾碼」太容易湊巧成立（例如 latin1 的 résumé）。
 */
function decodeBig5Strict(bytes: Buffer, sliced: boolean): string | null {
  const decoder = new TextDecoder('big5', { fatal: true, ignoreBOM: true })
  let text: string
  try {
    text = decoder.decode(bytes, { stream: true })
  } catch {
    return null
  }
  try {
    decoder.decode()
    return text
  } catch {
    return sliced ? text : null
  }
}

/** UTF-8 容忍的壞序列：每 UTF8_BYTES_PER_BAD byte 最多一個（第三輪規格：一個壞 byte 就整份變亂碼，比幾個 U+FFFD 糟得多）。 */
const UTF8_BYTES_PER_BAD = 1000
const UTF8_REPLACEMENT_BYTES = Buffer.from([0xef, 0xbf, 0xbd])

function countCodeUnit(s: string, unit: number): number {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === unit) n++
  return n
}

function countBytes(buf: Buffer, needle: Buffer): number {
  let n = 0
  for (let at = buf.indexOf(needle); at >= 0; at = buf.indexOf(needle, at + needle.length)) n++
  return n
}

/**
 * 用 UTF-8 解，壞的序列換成 U+FFFD；回傳解出來的字、壞序列的個數（bad）和合法多位元組序列的個數（good）。
 * 要不要用 UTF-8 由 detectEncoding 決定。
 * 壞序列的數法跟 WHATWG 解碼器一樣（每個壞序列變一個 U+FFFD），檔案裡本來就寫著的 U+FFFD（EF BF BD）不算壞。
 * good 是解出來的真的非 ASCII 字：一個合法的 2～4 byte 序列算一個（emoji 也是一個），檔案裡本來就寫著的 U+FFFD 也算。
 * 結尾不完整的多位元組字（例如只讀了檔案開頭、切在字中間）在兩種情況下丟掉、不算壞：
 * 是我們自己切的（sliced）；或前面已經解出至少一個真的非 ASCII 字（good > 0）。
 * 其他情況它算一個壞序列，留下一個 U+FFFD。
 */
function decodeUtf8(bytes: Buffer, sliced: boolean): { text: string; bad: number; good: number } {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  let text = decoder.decode(bytes, { stream: true })
  const tail = decoder.decode()
  let nonAscii = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    // 4 byte 的字在 JS 字串裡是一對代理，只數前面那個
    if (c > 0x7f && (c < 0xdc00 || c > 0xdfff)) nonAscii++
  }
  let bad = countCodeUnit(text, 0xfffd) - countBytes(bytes, UTF8_REPLACEMENT_BYTES)
  const good = nonAscii - bad
  if (tail && !sliced && good === 0) {
    bad++
    text += tail
  }
  return { text, bad, good }
}

/**
 * Node（ICU）的 Big5 解碼器不會把所有不合法的位元組變成 U+FFFD：0x80 變 U+0080、0xFF 與未定義的碼位變私用區字元。
 * 這些在真正的 Big5 中文裡幾乎不會出現（只有使用者造字），所以跟 U+FFFD 一樣視為「解不開」。
 * 例：Windows-1252 的彎引號 don’t（0x92 0x74）會被 ICU 解成一個私用區字元。
 */
const BIG5_NOT_REAL_TEXT = /[\u0080-\u009f\ue000-\uf8ff\ufffd]/
/** 合法的 Big5 解出來只要有非 ASCII 字，就一定是雙位元組字（單一 byte 的非 ASCII 都被 BIG5_NOT_REAL_TEXT 擋掉了）。 */
const NON_ASCII = /[^\x00-\x7f]/

/**
 * 判斷編碼固定只看檔案開頭這麼多 byte，跟 maxChars 無關（第四輪規格）：同一個檔不管 maxChars 多少，判出來的編碼都一樣。
 * 64 KB 之後才出現的非 ASCII 字不影響判斷，照開頭判出來的編碼解。
 */
const DETECT_BYTES = 64 * 1024

/** 輸出 maxChars 個字最多要解幾 byte：每個字最多 4 byte，再加 BOM，一定解得出 maxChars + 1 個字。 */
const outputBytes = (maxChars: number): number => (maxChars + 1) * 4 + 4

type Bom = { label: string; skip: number; encoding: string }

function bomOf(bytes: Buffer): Bom | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { label: 'utf-8', skip: 3, encoding: 'utf-8' }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { label: 'utf-16le', skip: 2, encoding: 'utf-16le' }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { label: 'utf-16be', skip: 2, encoding: 'utf-16be' }
  return null
}

/**
 * 判斷沒有 BOM 的檔的編碼。head 是檔案開頭（最多 DETECT_BYTES byte）；sliced：head 後面還有東西，結尾的半個字不算壞。
 * 回傳編碼，以及 head 用這個編碼解出來的字。順序（第四輪規格，第五輪加上 2 的第二個條件）：
 * 1. UTF-8 完全合法（沒有壞序列）→ UTF-8。同一串位元組剛好也是合法 Big5 時（例如「主義」）也是 UTF-8。
 * 2. 整段是合法 Big5（沒有 BIG5_NOT_REAL_TEXT）而且有雙位元組字，而且用 UTF-8 看「幾乎沒有合法的多位元組序列」
 *    （合法多位元組序列的個數 ≤ 壞序列的個數）→ Big5。
 *    大多是 ASCII、只零星夾中文的 Big5 檔（例如繁中 Excel 匯出的 CSV）：每個中文字在 UTF-8 都是壞序列，
 *    但加起來不到每 1000 byte 一個，所以這一步要排在 UTF-8 的容忍前面，不然中文會全部變成 U+FFFD。
 *    第二個條件（第五輪規格）：西歐文字的 UTF-8 小寫重音字母（C3 A1～BF，例如 é ñ ö）剛好都是合法的 Big5 字，
 *    這種檔只要夾 1 個 latin1 的壞 byte（例如 é 後面接字母，也湊成 Big5 字），整份就是合法 Big5。
 *    真的 Big5 檔用 UTF-8 看，湊巧合法的多位元組序列遠比壞序列少（實測密集中文最多 0.39 倍、CSV 最多 0.5 倍）；
 *    有很多合法多位元組序列（重音字母、UTF-8 中文）的檔，零星的壞 byte 交給第 3 步。
 * 3. UTF-8 壞序列 × 1000 ≤ head 的 byte 數 → UTF-8，壞的換成 U+FFFD。
 *    分母是 head 的長度（整個檔，最多 64 KB；不是整個檔的長度）：不到 1000 byte 的檔，1 個壞序列就超過比例，不走這一步。
 * 4. 整段是合法 Big5 → Big5。會走到這裡的：沒有雙位元組字（只有切點上的半個字被丟掉），
 *    或合法 UTF-8 多位元組比壞序列多、但壞序列超過第 3 步的比例（例如 10 byte 的 Big5「衝突的選項」）。
 * 5. Windows-1252。
 */
function detectEncoding(head: Buffer, sliced: boolean): { text: string; encoding: string } {
  const utf8 = decodeUtf8(head, sliced)
  if (utf8.bad === 0) return { text: utf8.text, encoding: 'utf-8' }
  const strict = decodeBig5Strict(head, sliced)
  const big5 = strict !== null && !BIG5_NOT_REAL_TEXT.test(strict) ? strict : null
  if (big5 !== null && NON_ASCII.test(big5) && utf8.good <= utf8.bad) return { text: big5, encoding: 'big5' }
  if (utf8.bad * UTF8_BYTES_PER_BAD <= head.length) return { text: utf8.text, encoding: 'utf-8' }
  if (big5 !== null) return { text: big5, encoding: 'big5' }
  return { text: new TextDecoder('windows-1252').decode(head), encoding: 'windows-1252' }
}

/** 用已經判斷好的編碼解（不再判斷）：解不開的地方換成 U+FFFD（Big5 可能是私用區字元）。 */
function decodeAs(encoding: string, bytes: Buffer, sliced: boolean): string {
  if (encoding === 'utf-8') return decodeUtf8(bytes, sliced).text
  if (encoding === 'big5') return new TextDecoder('big5', { ignoreBOM: true }).decode(bytes, { stream: sliced })
  return new TextDecoder('windows-1252').decode(bytes)
}

/**
 * decodeText 最多只看檔案開頭這麼多 byte：判斷編碼固定看的 65,536 byte，和輸出 maxChars 個字要解的
 * (maxChars + 1) × 4 + 4 byte，取大的（預設 80,008）。
 * 呼叫端為了省 I/O 只讀檔案開頭時，至少讀這麼多，並傳 partial: true。
 */
export function textHeadBytes(maxChars?: number): number {
  return Math.max(DETECT_BYTES, outputBytes(limitOption(maxChars, DEFAULT_MAX_CHARS, HARD_MAX_CHARS)))
}

/**
 * 解純文字檔（.txt／.md／.csv）。編碼判斷順序：
 * BOM → UTF-8（完全合法）→ Big5（整段合法、有雙位元組字，而且用 UTF-8 看合法多位元組序列不比壞序列多）
 * → UTF-8（壞序列不超過每 1000 byte 一個，壞的換成 U+FFFD）→ Big5（整段合法）→ Windows-1252。細節見 detectEncoding。
 * 判斷編碼固定只看開頭 64 KB（跟 maxChars 無關）；輸出最多解開頭 (maxChars + 1) × 4 + 4 byte，超大檔案也不會整個解碼。
 *
 * - 不到 1000 byte 的檔有 1 個 UTF-8 壞序列：照規格字面已經超過比例，不當 UTF-8。整份是合法 Big5 就是 Big5，
 *   否則是 Windows-1252（例如 UTF-8 的「資料結構」後面接 don 0x92 t，共 17 byte，中文會變成 Windows-1252 亂碼）。
 * - opts.partial：buf 只是檔案的開頭、後面還有（呼叫端自己只讀了一段）。結尾被切斷的半個字會丟掉、不影響編碼判斷，
 *   truncated 一律為 true。沒傳的話，結尾不完整的字會被當成壞序列（UTF-8 前面已有真的非 ASCII 字時例外，直接丟掉），
 *   Big5 檔就會退回其他編碼。只讀開頭 textHeadBytes(maxChars) byte 再傳 partial，結果跟傳整個檔案一模一樣。
 *   UTF-8 壞序列的比例照傳進來的 byte 數算（最多 64 KB）。
 * - 已知限制：latin1／Windows-1252 的檔常被判成 Big5（例如 cafés 的「é s」剛好是合法的 Big5 字「廥」）。
 *   台灣的使用情境 Big5 遠比 latin1 常見，第三輪規格決定維持現狀。同樣地，UTF-8 檔裡的壞 byte 剛好跟下一個 byte
 *   湊成合法 Big5、其他部分也剛好都是合法 Big5，而且合法的 UTF-8 多位元組字不比壞序列多（例如全是 ASCII，
 *   或只有 1 個 é）時，會判成 Big5。有很多重音字母或 UTF-8 中文的檔（第五輪規格）照 UTF-8 讀，只壞那幾個字。
 * - 已知限制（第五輪）：大多是 ASCII、只夾一兩個中文詞的 Big5 檔，偶爾有詞的位元組用 UTF-8 看湊巧有好幾個合法序列
 *   （例如「衝突的選項」：3 個合法、1 個壞），合法的比壞的多就不走 Big5 優先；檔案又夠長、壞序列在比例內時，
 *   會照 UTF-8 讀，那個詞變成怪字和 U+FFFD。實測英文夾 1 個 Big5 詞約 0.6%、2 個詞約 0.1%、3 個以上 0。
 * - 不到 1000 byte 的西歐 UTF-8 檔夾 1 個壞 byte：比例（每 1000 byte 一個）沒變，照樣超過；整份剛好是合法 Big5 時
 *   是 Big5（跟第三輪一樣）。同一條規則讓很小的 Big5 檔（例如只有「衝突的選項」）讀對。
 * - 已知限制：Big5 檔裡只要有一個解不開的字（例如使用者造字，ICU 解成私用區），整份就不算合法 Big5，
 *   又回到 UTF-8 容忍或 Windows-1252，中文會壞掉（跟第三輪一樣）。
 * - 已知限制：開頭 64 KB 都是 ASCII、後面才出現中文的檔，照開頭判成 UTF-8；後面的 Big5 字會變成 U+FFFD。
 * - truncated：檔案的字比 maxChars 多（空白也算字，跟預想表「超過 20,000 字標 truncated」一致）。
 *   docxText／pptxText 的換行是我們自己加的分隔，所以那兩個只在丟掉非空白字時才標。
 */
export function decodeText(
  buf: Buffer,
  opts?: { maxChars?: number; partial?: boolean },
): { text: string; encoding: string; truncated: boolean } {
  return guard(() => {
    const b = toBuffer(buf)
    requireNonEmpty(b)
    const maxChars = limitOption(opts?.maxChars, DEFAULT_MAX_CHARS, HARD_MAX_CHARS)
    const partial = opts?.partial === true
    // 輸出的範圍：開頭 outLimit byte；outSliced：範圍後面還有東西（結尾的半個字丟掉，truncated 為 true）
    const outLimit = outputBytes(maxChars)
    const outSliced = partial || b.length > outLimit
    const out = b.length > outLimit ? b.subarray(0, outLimit) : b
    let text: string
    let encoding: string
    let sliced: boolean
    const bom = bomOf(b)
    if (bom) {
      text = new TextDecoder(bom.label, { ignoreBOM: true }).decode(out.subarray(bom.skip), { stream: outSliced })
      encoding = bom.encoding
      sliced = outSliced
    } else {
      const headSliced = partial || b.length > DETECT_BYTES
      const detected = detectEncoding(b.length > DETECT_BYTES ? b.subarray(0, DETECT_BYTES) : b, headSliced)
      encoding = detected.encoding
      if (b.length <= DETECT_BYTES || outLimit <= DETECT_BYTES) {
        // 判斷編碼時解出來的字已經涵蓋輸出的範圍（就是整個輸入，或至少有 maxChars + 1 個字）
        text = detected.text
        sliced = headSliced
      } else {
        text = decodeAs(encoding, out, outSliced)
        sliced = outSliced
      }
    }
    const { end } = takeCodePoints(text, maxChars)
    if (end < 0) return { text, encoding, truncated: sliced }
    return { text: text.slice(0, end), encoding, truncated: true }
  })
}
