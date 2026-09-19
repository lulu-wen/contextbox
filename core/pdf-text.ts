/**
 * 讀 PDF 的文字層（零依賴，只用 node:zlib 與 TextDecoder）。
 *
 * 做法：
 * - 不靠 xref：直接掃整個檔案找 `N G obj`（後出現的覆蓋先出現的，對應增量更新），
 *   串流資料區段會跳過，避免把串流內容誤認成物件或 trailer。
 * - 物件串流（/ObjStm）：直接物件找不到時，才解開所有物件串流建索引。
 * - 頁面順序照 /Root /Pages /Kids 深度優先；走過的節點跳過（頁面樹有迴圈也不會卡住）。
 *   找不到頁面樹時，退回用檔案裡出現的 /Type /Page 順序。
 * - 字：/ToUnicode 優先；沒有對到的字碼，簡單字型照 /Encoding（含 /Differences），
 *   Type0 字型照具名 CMap（UCS2、UTF16、Big5 等）；都解不出來就不輸出（不亂猜）。
 * - 換行：字的基線偏離目前這行超過字高一半（等於 y 座標改變）、或 T* ' " 就換行；
 *   y 座標有算上 cm（CTM）。同一行裡的字照書寫方向的座標排序（閱讀順序，
 *   跟 pdftotext 一樣），段與段之間有明顯空隙（超過 0.2 個字寬）就補一個空白。
 * - 頁與頁之間用 \f 分隔。/Contents 是陣列時，各段接起來當一條串流（段的交界算空白，字串可以跨段）。
 *
 * 安全：
 * - 一次呼叫只有一個全域工作預算（PDF_LIMITS.maxWork，見 Budget、COST）。任何迴圈每做一步都扣：
 *   讀過的 byte 與值、每呼叫一次解碼器的固定成本（照實測校準）、解碼器吃進去與嘗試解出的每個 byte
 *   （含出錯、被 predictor 丟掉、超過上限的）、運算子、字形、CMap 與字寬表的每一筆（含重複蓋掉的）、
 *   頁面樹的每一步與記下的每個節點…
 *   重複的工每次都扣；快取的東西第一次建的時候扣，連它佔的記憶體一起算（含 V8 heap 外的：
 *   解碼的結果不留住比它大的緩衝區，見 exactCopy）。
 * - 另外有結構上的上限：輸入大小、物件數、單一串流解壓與解壓總量（照嘗試解出的量算）、
 *   巢狀深度、參照跳轉次數、Form XObject 深度、q/Q 堆疊深度。
 * - 超出上限時回已經讀到的部分（truncated: true）：內容串流有自己的額度（maxContentWork，含它的解碼），
 *   頁面樹有自己的額度（maxTreeWork，數不完就用根節點的 /Count）；解壓超過上限時留下上限以內的開頭。
 *   只有一個字都沒讀到才丟錯：解壓超過上限（疑似壓縮炸彈）丟 CORRUPT，其他丟 TOO_LARGE。
 * - 壞掉但讀得出來的照讀（跟 poppler 一樣）：檔案被截斷（最後一個物件後面沒有 %%EOF）時讀得到的照回、
 *   標 truncated；zlib 的 Adler-32 檢查碼錯不管；長度 0 的串流是空的內容。
 * - 另外回報解不出 Unicode 的字形有多少（glyphs、unmappedGlyphs、unmappedRatio）：字看起來正常、
 *   其實少了一大半的檔（例如 Ghostscript 重轉、字型沒有 ToUnicode）靠這個分辨。
 */
import { constants as zlibConstants, inflateRawSync } from 'node:zlib'

// ───────────────────────── 錯誤 ─────────────────────────

export type PdfErrorCode = 'NOT_PDF' | 'ENCRYPTED' | 'CORRUPT' | 'TOO_LARGE' | 'UNSUPPORTED' | 'BAD_OPTION'

export class PdfError extends Error {
  code: PdfErrorCode
  constructor(code: PdfErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PdfError'
    this.code = code
  }
}

/** 單一物件的語法錯誤：在物件層級吃掉（該物件當成 null），不影響其他物件。 */
class PdfSyntaxError extends PdfError {
  constructor(message: string) {
    super('CORRUPT', message)
    this.name = 'PdfSyntaxError'
  }
}

// ───────────────────────── 上限 ─────────────────────────

export const PDF_LIMITS = Object.freeze({
  /** 輸入檔案大小上限 */
  maxInputBytes: 256 * 1024 * 1024,
  /** 物件數上限（直接物件的 `N G obj` 加上物件串流裡的物件） */
  maxObjects: 500_000,
  /** 單一串流解壓後的上限 */
  maxStreamBytes: 16 * 1024 * 1024,
  /** 一次呼叫裡所有解壓輸出的總量上限 */
  maxTotalDecodedBytes: 64 * 1024 * 1024,
  /** 陣列、字典的巢狀深度；更深的整段略過（不遞迴） */
  maxNesting: 64,
  /** 一個陣列或字典最多保留幾個元素 */
  maxItems: 1_000_000,
  /** 參照連續跳轉（1 0 R → 2 0 R → …）的上限 */
  maxRefHops: 32,
  /** 解析物件時巢狀解析其他物件（例如 /Length 參照）的深度上限 */
  maxResolveDepth: 32,
  /** Form XObject 巢狀深度 */
  maxFormDepth: 8,
  /** q/Q 堆疊深度 */
  maxGraphicsStack: 64,
  /**
   * 一次呼叫的全域工作預算（單位見 COST）。任何迴圈每做一步都從這裡扣，扣完丟 TOO_LARGE。
   * 以下都是開發機上的實測。
   *
   * 時間：單位的定義是「不超過約 1 ns 的計算」，實際跑起來比較慢。第一輪到第五輪驗證的惡意檔
   * （很多個小串流、每個掛 8 層濾鏡、很肥的字典、壓縮炸彈…）把預算用完要 0.06～0.75 秒，
   * 最慢的是一頁 40 萬段沒有濾鏡的小串流（28 MB 的檔，單獨跑 0.6 秒，機器忙的時候 0.75 秒）。
   * 一般的 PDF 讀前 3 頁用 0.01～2%（LibreOffice、cairo、reportlab、Ghostscript 產的講義與系統內建的 PDF）；
   * 向量圖很多的一頁表單約 13%；93 頁的手冊全部讀完約 10%。
   *
   * 記憶體（heap 上限 256 MB 跑）：
   * - 預算用完時留著的資料（強制 GC 之後量，heap 加上 heap 外的 ArrayBuffer）每個單位 0.1～0.95 byte，
   *   最多約 180 MB（40 萬段那個檔）。解碼的結果不會留住比它大的緩衝區（exactCopy），
   *   很多個小 Flate 串流時也不會每個佔一塊 zlib 的 16 KB 輸出區塊。
   * - 行程的記憶體峰值（maxRSS）另外含：Node 本身與載入 .ts（約 85 MB）、輸入（檔案本身與它的 latin1 字串，
   *   都在 heap 外，合計約檔案大小的 2 倍）、V8 還沒回收的空間。把預算用完的惡意檔 maxRSS 115～465 MB
   *   （不設 heap 上限時 heap 長得比較大，最高約 490 MB），最高的也是 40 萬段那個檔；
   *   35 萬段小 Flate 串流（27 MB）約 360 MB、25 萬段各 8 層 Flate（36 MB）約 305 MB（第四輪是 1.35 GB、2.7 GB）。
   * - heap 上限：40 萬段那個檔要 200 MB 以上（160 MB 會 OOM）；Flate 的那兩個 128 MB 就夠。
   *   接進掃描器時 worker 的 heap 上限（resourceLimits.maxOldGenerationSizeMb）不要低於 256 MB，
   *   而且 heap 外的部分（輸入約檔案大小的 2 倍、解碼的結果）不受這個上限管，整個行程要另外留。
   */
  maxWork: 200_000_000,
  /**
   * 其中內容串流（頁面與 Form 的 byte、運算子、字形、行與段）最多用這麼多；用完就停下來、
   * 回已經讀到的部分（truncated），不丟錯：很大的正常頁面（工程圖、地圖）還是讀得到前面的字。
   */
  maxContentWork: 150_000_000,
  /**
   * 找頁面、數頁數（走頁面樹，或找不到頁面樹時掃 /Type /Page）最多用這麼多；用完就停：
   * 已經找到的頁照讀，頁數用根節點的 /Count，truncated。reportlab 產的頁面大約數得到 1.4 萬頁。
   */
  maxTreeWork: 50_000_000,
})

/**
 * 每一步扣多少工作單位。一個單位不超過開發機上約 1 ns 的計算，也不超過約 1 byte 會留在記憶體裡的資料
 * （例如 CMap 的一筆、一個字型、一行字、解析好快取起來的物件、解碼的結果）；兩者都有的照大的算。
 * 數字偏保守：寧可早一點停。實測把預算用完時，每用掉 1 個單位留著的資料 0.1～0.95 byte
 * （強制 GC 之後量，含 heap 外的 ArrayBuffer；最高的是 40 萬段沒有濾鏡的小串流）。
 * 這是留著的資料，不是行程的記憶體峰值：峰值另外見 PDF_LIMITS.maxWork。
 */
const COST = Object.freeze({
  /** 讀過的每個 byte（解析物件、CMap、內容串流；同一段重複讀就重複算） */
  byte: 4,
  /** 讀出來的每個值（數字、名稱、字串、陣列與字典裡的每個元素與鍵…） */
  token: 40,
  /**
   * 比較佔記憶體的值另外多算幾個值（實測：一個小的 Uint8Array 約 230 byte、名稱約 64 byte、
   * 陣列本身約 100 byte、字典的 Map 約 220 byte；解析好的物件會快取起來）
   */
  stringTokens: 5,
  nameTokens: 1,
  arrayTokens: 3,
  dictTokens: 6,
  /**
   * 解碼器吃進去的每個 byte、嘗試解出的每個 byte（含出錯前解出的、被 predictor 丟掉的、超過上限的），
   * 以及 predictor 處理的每個 byte
   */
  decoded: 1,
  /** 其他迴圈的一步：頁面樹、物件串流索引、/Differences、/Widths、/Contents、比對到的 regex… */
  step: 20,
  /** 頁面樹記下的一個節點、堆疊的一層、留下來的一頁（時間加上佔的記憶體） */
  node: 100,
  /** 內容串流的一個運算子 */
  op: 60,
  /** 一個字形：codespace 查表、Unicode 對照、分行、可能新增的一筆字碼快取 */
  glyph: 250,
  /** 輸出或對照表裡的每個 UTF-16 字元 */
  char: 4,
  /** 對照表（CMap、CID 字寬）新增或覆寫的一筆：時間加上它佔的記憶體 */
  entry: 200,
  /** 收字時新開的一行或一段（留到這頁結束才排序、組字） */
  item: 1000,
  /** 建一個字型、執行一次 Form XObject 的固定成本 */
  object: 5000,
  /** 複製一張 256 格的編碼表（套 /Differences） */
  table: 4096,
  /**
   * 每呼叫一次解碼器的固定成本（解碼之前先扣，串流是空的也扣）：建解碼器、配置輸出、包結果、快取。
   * 吃進去與解出的 byte 另外照 decoded 扣。照實測校準（開發機，2～6 萬段、每段 8 層濾鏡、
   * 每層只有幾十 byte，跟沒有濾鏡的同樣檔案比，多出來的時間除以呼叫次數）：
   * Flate 每次 2.4～2.9 µs、LZW 1.1～1.2 µs、A85 0.95～1.1 µs、RL 0.8～0.9 µs、AHx 0.8～1.2 µs；
   * 解出來的結果留到這次呼叫結束，每段約多佔 400 byte（heap 加上 heap 外）。時間比記憶體大，照時間算、取整數往上。
   * 沒算這一筆的時候，很多個小串流、每個掛 8 層濾鏡的檔要跑 6～107 秒（第四輪驗證）。
   */
  flateCall: 3000,
  lzwCall: 1500,
  /** AHx、A85、RL，以及 predictor */
  filterCall: 1200,
})

/**
 * 一頁的 /Contents 分很多段時，收段收到內容額度只剩這麼多就停，留給讀字
 * （大約 5000 個字形，或 500 KB 的內容串流）
 */
const PART_RESERVE = 2_000_000

/**
 * 一次 pdfText 呼叫的全域工作預算。
 * - 任何迴圈每做一步都扣（見 COST）。重複的工（同一個串流被參照很多次、Form 被呼叫很多次、
 *   bfrange 重複蓋同一段字碼、很多字型共用同一個大表）每次都扣；快取起來的東西在第一次建的時候扣，
 *   連它佔的記憶體一起算。
 * - spend：扣完（left 低於 floor）就丟 TOO_LARGE（不管是誰扣完的）。floor 平常是 0；
 *   頁面樹走訪時暫時調高，當成它自己的額度（見 PdfDoc.withTreeAllowance）。
 * - trySpend：內容串流用，一樣從總預算扣。內容串流自己的額度（maxContentWork）或總預算不夠了就不扣、
 *   回 false，呼叫端停下來回部分結果。
 */
class Budget {
  left: number
  contentLeft: number
  floor: number
  constructor(total: number, content: number) {
    this.left = total
    this.contentLeft = content
    this.floor = 0
  }

  /** 還能用多少（頁面樹的額度期間是額度剩下的） */
  avail(): number {
    return Math.max(0, this.left - this.floor)
  }

  /** 內容串流還能用多少 */
  contentAvail(): number {
    return Math.max(0, Math.min(this.contentLeft, this.left - this.floor))
  }

  spend(n: number): void {
    this.left -= n
    if (this.left < this.floor) throw new PdfError('TOO_LARGE', `處理量超過上限（${PDF_LIMITS.maxWork} 個工作單位）`)
  }

  trySpend(n: number): boolean {
    if (n > this.contentAvail()) return false
    this.contentLeft -= n
    this.left -= n
    return true
  }

  /** 已經從總預算扣掉的工（內容串流的解碼）也算進內容額度：額度不夠了回 false */
  chargeContent(n: number): boolean {
    this.contentLeft -= n
    if (this.contentLeft >= 0) return true
    this.contentLeft = 0
    return false
  }

  /** 內容串流讀一個值讀到額度用完才停下來：讀掉的就是剩下的額度，照扣（不丟錯） */
  exhaustContent(): void {
    const n = this.contentAvail()
    this.contentLeft -= n
    this.left -= n
  }
}

const DEFAULT_MAX_PAGES = 3
const DEFAULT_MAX_CHARS = 50_000

export type PdfTextOptions = { maxPages?: number; maxChars?: number }
export type PdfTextResult = {
  /** 前 maxPages 頁的文字；頁與頁之間用 \f 分隔。沒有文字層時是空字串。 */
  text: string
  /** 整份文件的頁數（照頁面樹數出來的） */
  pages: number
  /** 讀到的頁裡至少有一個非空白字 */
  hasTextLayer: boolean
  /**
   * 還有沒讀的頁、字數超過 maxChars、碰到處理上限而沒讀完、頁面樹太大沒數完（pages 是 /Count）、
   * 或檔案被截斷（最後一個物件後面沒有 %%EOF，例如下載到一半）
   */
  truncated: boolean
  /** 讀到的頁裡畫了幾個字形（含解不出來的） */
  glyphs: number
  /** 其中解不出 Unicode 的字形數（沒有 ToUnicode、編碼不認得、只對到控制字元） */
  unmappedGlyphs: number
  /** unmappedGlyphs / glyphs（沒有字形時是 0）：比例高表示字看起來正常、其實少了一部分 */
  unmappedRatio: number
}

// ───────────────────────── PDF 值 ─────────────────────────

class PName {
  name: string
  constructor(name: string) {
    this.name = name
  }
}

class PRef {
  num: number
  gen: number
  constructor(num: number, gen: number) {
    this.num = num
    this.gen = gen
  }
}

class PDict {
  map: Map<string, PVal>
  constructor() {
    this.map = new Map()
  }
  get(key: string): PVal {
    const v = this.map.get(key)
    return v === undefined ? null : v
  }
}

class PStream {
  dict: PDict
  raw: Buffer
  constructor(dict: PDict, raw: Buffer) {
    this.dict = dict
    this.raw = raw
  }
}

/** 內容串流、CMap 裡的運算子／關鍵字 */
class POp {
  op: string
  constructor(op: string) {
    this.op = op
  }
}

type PVal = null | boolean | number | Uint8Array | PName | PRef | PDict | PStream | POp | PVal[]

/** 讀到檔尾 */
const EOF = Symbol('EOF')
/** 多出來的分隔符號（孤立的 ] > ) { }） */
const STRAY = Symbol('STRAY')

function nameOf(v: PVal): string {
  return v instanceof PName ? v.name : ''
}

function isNum(v: PVal): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

// ───────────────────────── 詞法 ─────────────────────────

const WS = new Uint8Array(256)
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1
const DELIM = new Uint8Array(256)
for (const ch of '()<>[]{}/%') DELIM[ch.charCodeAt(0)] = 1

/** 名稱最多留幾個字 */
const MAX_NAME = 256

function isRegular(c: number): boolean {
  return WS[c] === 0 && DELIM[c] === 0
}

function hexVal(c: number): number {
  if (c >= 48 && c <= 57) return c - 48
  if (c >= 65 && c <= 70) return c - 55
  if (c >= 97 && c <= 102) return c - 87
  return -1
}

/** ByteSink 滿了（超過上限）：解碼器接住，回已經解出的部分（見 collect） */
class SinkFull extends Error {}
const SINK_FULL = new SinkFull('解碼輸出到了上限')

/** 可以長大的位元組緩衝區；超過上限丟 SINK_FULL，已經放進去的留著 */
class ByteSink {
  buf: Uint8Array
  len: number
  limit: number
  constructor(initial: number, limit: number) {
    this.buf = new Uint8Array(Math.max(16, Math.min(initial, limit)))
    this.len = 0
    this.limit = limit
  }
  ensure(extra: number): void {
    const need = this.len + extra
    if (need > this.limit) throw SINK_FULL
    if (need <= this.buf.length) return
    let cap = this.buf.length * 2
    while (cap < need) cap *= 2
    const next = new Uint8Array(Math.min(cap, this.limit))
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }
  push(b: number): void {
    if (this.len === this.buf.length) this.ensure(1)
    else if (this.len >= this.limit) throw SINK_FULL
    this.buf[this.len++] = b
  }
  /**
   * 解碼器的結果（會快取到這次呼叫結束）：緩衝區比結果大超過一倍（每次長一倍、開頭照輸入大小估）時
   * 換成剛好大小的複本，留著的記憶體不會比扣的預算多
   */
  result(): Buffer {
    if (this.buf.length > 2 * this.len) return exactCopy(this.buf.subarray(0, this.len))
    return Buffer.from(this.buf.buffer, this.buf.byteOffset, this.len)
  }
  /** 字串值用：只要能用索引讀，比包成 Buffer 快很多 */
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.len)
  }
}

/**
 * 讀值讀到一半預算就不夠了（Lexer.allow 給的額度）。code 是 TOO_LARGE；
 * 內容串流自己的 Lexer 丟的會被接住，當成「讀到這裡為止」。
 */
class OutOfBudget extends PdfError {
  lexer: Lexer
  constructor(lexer: Lexer) {
    super('TOO_LARGE', `處理量超過上限（${PDF_LIMITS.maxWork} 個工作單位）`)
    this.name = 'OutOfBudget'
    this.lexer = lexer
  }
}

class Lexer {
  d: Buffer
  pos: number
  end: number
  /** 讀了幾個值（含陣列、字典裡的元素與鍵，佔記憶體的值多算幾個）：呼叫端照這個扣預算 */
  count: number
  /**
   * 讀值的額度（單位同預算，見 allow）：從 allowPos、allowCount 起讀過的 byte 與值（算法同 cost）
   * 超過 allowUnits 就丟 OutOfBudget。呼叫端照剩下的預算設：一個很大的陣列、字典
   * 在讀的途中就停下來，不會先整個建出來才發現預算不夠。byte 也算：只數值的話，
   * 值很短的時候（例如一串 0）實際扣的會比額度多兩成，吃掉呼叫端要留下來的額度。
   */
  allowUnits: number
  allowPos: number
  allowCount: number
  /**
   * /Contents 各段接起來之後，段與段的交界（依位置排序）：交界算空白，名稱、數字、關鍵字、註解
   * 都在交界結束；字串（( ) 與 < >）不受影響，可以跨段。null＝只有一段。
   */
  breaks: number[] | null
  constructor(d: Buffer, pos = 0, end = d.length) {
    this.d = d
    this.pos = pos
    this.end = Math.min(end, d.length)
    this.count = 0
    this.allowUnits = Number.POSITIVE_INFINITY
    this.allowPos = pos
    this.allowCount = 0
    this.breaks = null
  }

  /** 從 p 開始的詞最多讀到哪裡（不含）：下一個段的交界，或結尾 */
  stopAfter(p: number): number {
    const b = this.breaks
    if (b === null) return this.end
    let lo = 0
    let hi = b.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (b[mid] <= p) lo = mid + 1
      else hi = mid
    }
    return lo < b.length ? Math.min(b[lo], this.end) : this.end
  }

  /** 從現在起最多還能讀多少（單位同預算）：讀過的 byte 與值超過就丟 OutOfBudget */
  allow(units: number): void {
    this.allowUnits = Math.max(0, units)
    this.allowPos = this.pos
    this.allowCount = this.count
  }

  /** 讀過的超過 allow 給的額度了嗎（一個值讀完才檢查：最多超出一個值） */
  overAllowance(): boolean {
    return (this.pos - this.allowPos) * COST.byte + (this.count - this.allowCount) * COST.token > this.allowUnits
  }

  /** 從 fromPos 讀到現在、讀了 fromCount 之後的值，要扣多少預算 */
  cost(fromPos: number, fromCount: number): number {
    return Math.max(0, this.pos - fromPos) * COST.byte + (this.count - fromCount) * COST.token
  }

  skipWs(): void {
    const d = this.d
    let p = this.pos
    const end = this.end
    while (p < end) {
      const c = d[p]
      if (WS[c]) p++
      else if (c === 37) {
        // % 註解到行尾（或段的交界）
        const stop = this.breaks === null ? end : this.stopAfter(p)
        while (p < stop && d[p] !== 10 && d[p] !== 13) p++
      } else break
    }
    this.pos = p
  }

  /** 目前位置是不是這個關鍵字（後面接非一般字元） */
  isKeyword(kw: string): boolean {
    const d = this.d
    const p = this.pos
    if (p + kw.length > this.end) return false
    for (let i = 0; i < kw.length; i++) if (d[p + i] !== kw.charCodeAt(i)) return false
    const after = p + kw.length
    return after >= this.end || !isRegular(d[after])
  }

  readName(): string {
    // 目前在 '/'。名稱最多留 MAX_NAME 個字（規格的實作上限是 127 byte）：
    // 後面用名稱查表、比對的地方（字型、編碼、字形名）每次的成本都有上限
    const d = this.d
    let p = this.pos + 1
    const end = this.stopAfter(this.pos)
    let out = ''
    let start = p
    while (p < end && isRegular(d[p])) {
      if (d[p] === 35 && p + 2 < end && hexVal(d[p + 1]) >= 0 && hexVal(d[p + 2]) >= 0) {
        if (out.length < MAX_NAME) out += d.latin1Slice(start, p) + String.fromCharCode(hexVal(d[p + 1]) * 16 + hexVal(d[p + 2]))
        p += 3
        start = p
        continue
      }
      p++
    }
    if (out.length < MAX_NAME) out += d.latin1Slice(start, Math.min(p, start + MAX_NAME))
    this.pos = p
    return out.length > MAX_NAME ? out.slice(0, MAX_NAME) : out
  }

  readNumber(): number {
    const d = this.d
    let p = this.pos
    const end = this.stopAfter(p)
    let neg = false
    while (p < end && (d[p] === 43 || d[p] === 45)) {
      if (d[p] === 45) neg = true
      p++
    }
    let v = 0
    while (p < end && d[p] >= 48 && d[p] <= 57) v = v * 10 + (d[p++] - 48)
    if (p < end && d[p] === 46) {
      p++
      let scale = 0.1
      while (p < end && d[p] >= 48 && d[p] <= 57) {
        v += (d[p++] - 48) * scale
        scale /= 10
      }
    }
    // 其餘黏在一起的 + - . 數字當成垃圾吃掉
    while (p < end && (d[p] === 43 || d[p] === 45 || d[p] === 46 || (d[p] >= 48 && d[p] <= 57))) p++
    if (p === this.pos) p++
    this.pos = p
    if (!Number.isFinite(v)) return 0
    return neg ? -v : v
  }

  readKeyword(): string {
    const d = this.d
    const start = this.pos
    let p = start
    const end = this.stopAfter(start)
    while (p < end && isRegular(d[p])) p++
    if (p === start) p++
    this.pos = p
    return d.latin1Slice(start, p)
  }

  readLiteral(): Uint8Array {
    // 目前在 '('。常見的情況（沒有反斜線）：先找到結尾，一次配置剛好的大小
    const d = this.d
    const end = this.end
    const start = this.pos + 1
    let q = start
    let open = 1
    while (q < end) {
      const c = d[q]
      if (c === 92) break
      if (c === 40) open++
      else if (c === 41 && --open === 0) break
      q++
    }
    if (q >= end || d[q] === 41) {
      const out = new Uint8Array(q - start)
      if (out.length > 64) out.set(d.subarray(start, q))
      else for (let k = 0; k < out.length; k++) out[k] = d[start + k]
      this.pos = q < end ? q + 1 : end
      return out
    }
    let p = start
    const out = new ByteSink(64, Number.MAX_SAFE_INTEGER)
    let depth = 1
    while (p < end) {
      const c = d[p++]
      if (c === 40) {
        depth++
        out.push(c)
      } else if (c === 41) {
        depth--
        if (depth === 0) break
        out.push(c)
      } else if (c === 92) {
        if (p >= end) break
        const e = d[p++]
        switch (e) {
          case 110: out.push(10); break
          case 114: out.push(13); break
          case 116: out.push(9); break
          case 98: out.push(8); break
          case 102: out.push(12); break
          case 13:
            if (p < end && d[p] === 10) p++
            break
          case 10:
            break
          default:
            if (e >= 48 && e <= 55) {
              let v = e - 48
              for (let k = 0; k < 2 && p < end && d[p] >= 48 && d[p] <= 55; k++) v = v * 8 + (d[p++] - 48)
              out.push(v & 0xff)
            } else out.push(e)
        }
      } else out.push(c)
    }
    this.pos = p
    return out.bytes()
  }

  readHex(): Uint8Array {
    // 目前在 '<'。先數有幾個十六進位數字，一次配置剛好的大小（字串值很多，少一次配置差很多）
    const d = this.d
    const end = this.end
    const start = this.pos + 1
    let p = start
    let digits = 0
    while (p < end) {
      const c = d[p++]
      if (c === 62) break
      if (hexVal(c) >= 0) digits++
    }
    this.pos = p
    const out = new Uint8Array((digits + 1) >> 1)
    let n = 0
    let hi = -1
    for (let q = start; q < p; q++) {
      const v = hexVal(d[q])
      if (v < 0) continue
      if (hi < 0) hi = v
      else {
        out[n++] = hi * 16 + v
        hi = -1
      }
    }
    if (hi >= 0) out[n] = hi * 16
    return out
  }

  /**
   * 巢狀太深：不遞迴，用計數器把整段 [ … ] 或 << … >> 吃掉。
   * 沒有收尾就丟語法錯誤。
   */
  skipNested(): void {
    const d = this.d
    const end = this.end
    let depth = 0
    while (this.pos < end) {
      const c = d[this.pos]
      if (c === 40) {
        this.readLiteral()
        continue
      }
      if (c === 37) {
        this.skipWs()
        continue
      }
      if (c === 91) {
        depth++
        this.pos++
      } else if (c === 93) {
        depth--
        this.pos++
      } else if (c === 60) {
        if (d[this.pos + 1] === 60) {
          depth++
          this.pos += 2
        } else {
          this.readHex()
          continue
        }
      } else if (c === 62 && d[this.pos + 1] === 62) {
        depth--
        this.pos += 2
      } else this.pos++
      if (depth <= 0) return
    }
    throw new PdfSyntaxError('巢狀結構太深而且沒有收尾')
  }
}

// ───────────────────────── 語法 ─────────────────────────

/**
 * 讀一個值。refs = true 時（一般物件）會把 `N G R` 讀成參照；
 * 內容串流與 CMap 用 refs = false。關鍵字回傳 POp（true/false/null 除外）。
 */
function parseValue(lx: Lexer, depth: number, refs: boolean): PVal | typeof EOF | typeof STRAY {
  lx.count++
  if (lx.overAllowance()) throw new OutOfBudget(lx)
  lx.skipWs()
  if (lx.pos >= lx.end) return EOF
  const d = lx.d
  const c = d[lx.pos]
  switch (c) {
    case 47:
      lx.count += COST.nameTokens
      return new PName(lx.readName())
    case 40:
      lx.count += COST.stringTokens
      return lx.readLiteral()
    case 60:
      if (d[lx.pos + 1] === 60) return parseDict(lx, depth, refs)
      lx.count += COST.stringTokens
      return lx.readHex()
    case 91:
      return parseArray(lx, depth, refs)
    case 41:
    case 62:
    case 93:
    case 123:
    case 125:
      lx.pos++
      return STRAY
  }
  if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
    const start = lx.pos
    const n = lx.readNumber()
    if (refs && Number.isInteger(n) && n >= 0 && d[start] >= 48 && d[start] <= 57) return tryRef(lx, n)
    return n
  }
  const kw = lx.readKeyword()
  if (kw === 'true') return true
  if (kw === 'false') return false
  if (kw === 'null') return null
  return new POp(kw)
}

/** 數字後面如果是 `G R` 就是參照，否則退回原位。 */
function tryRef(lx: Lexer, num: number): PVal {
  const save = lx.pos
  const d = lx.d
  lx.skipWs()
  let p = lx.pos
  const genStart = p
  let gen = 0
  while (p < lx.end && d[p] >= 48 && d[p] <= 57 && p - genStart < 10) gen = gen * 10 + (d[p++] - 48)
  if (p > genStart && p < lx.end && WS[d[p]]) {
    lx.pos = p
    lx.skipWs()
    if (lx.pos < lx.end && d[lx.pos] === 82 && (lx.pos + 1 >= lx.end || !isRegular(d[lx.pos + 1]))) {
      lx.pos++
      return new PRef(num, gen)
    }
  }
  lx.pos = save
  return num
}

/** 物件本體裡出現這些關鍵字，表示結構壞了（例如字典沒收尾就到了 endobj） */
const STRUCTURE_KEYWORDS = new Set(['endobj', 'obj', 'stream', 'endstream', 'xref', 'trailer', 'startxref'])

function parseArray(lx: Lexer, depth: number, refs: boolean): PVal {
  if (depth >= PDF_LIMITS.maxNesting) {
    lx.skipNested()
    return null
  }
  lx.count += COST.arrayTokens
  lx.pos++
  const out: PVal[] = []
  for (;;) {
    lx.skipWs()
    if (lx.pos >= lx.end) {
      if (refs) throw new PdfSyntaxError('陣列沒有收尾')
      return out
    }
    if (lx.d[lx.pos] === 93) {
      lx.pos++
      return out
    }
    const v = parseValue(lx, depth + 1, refs)
    if (v === EOF) return out
    if (v === STRAY) continue
    if (v instanceof POp) {
      if (refs && STRUCTURE_KEYWORDS.has(v.op)) throw new PdfSyntaxError(`陣列裡出現 ${v.op}`)
      if (!refs && out.length < PDF_LIMITS.maxItems) out.push(v)
      continue
    }
    if (out.length < PDF_LIMITS.maxItems) out.push(v)
  }
}

function parseDict(lx: Lexer, depth: number, refs: boolean): PVal {
  if (depth >= PDF_LIMITS.maxNesting) {
    lx.skipNested()
    return null
  }
  lx.count += COST.dictTokens
  lx.pos += 2
  const dict = new PDict()
  const d = lx.d
  for (;;) {
    lx.skipWs()
    if (lx.pos >= lx.end) {
      if (refs) throw new PdfSyntaxError('字典沒有收尾')
      return dict
    }
    const c = d[lx.pos]
    if (c === 62 && d[lx.pos + 1] === 62) {
      lx.pos += 2
      return dict
    }
    if (c !== 47) {
      // 不是鍵：吃掉一個值，保證往前走
      const before = lx.pos
      const junk = parseValue(lx, depth + 1, refs)
      if (junk instanceof POp && refs && STRUCTURE_KEYWORDS.has(junk.op)) throw new PdfSyntaxError(`字典裡出現 ${junk.op}`)
      if (lx.pos === before) lx.pos++
      continue
    }
    // 鍵也算：鍵的字串加上 Map 的一筆
    lx.count += 1 + COST.nameTokens
    const key = lx.readName()
    lx.skipWs()
    if (lx.pos < lx.end && d[lx.pos] === 62 && d[lx.pos + 1] === 62) {
      dict.map.set(key, null)
      continue
    }
    const v = parseValue(lx, depth + 1, refs)
    if (v === EOF) {
      if (refs) throw new PdfSyntaxError('字典沒有收尾')
      return dict
    }
    if (v === STRAY) continue
    if (v instanceof POp) {
      if (refs && STRUCTURE_KEYWORDS.has(v.op)) throw new PdfSyntaxError(`字典裡出現 ${v.op}`)
      if (refs) {
        dict.map.set(key, null)
        continue
      }
    }
    if (dict.map.size < PDF_LIMITS.maxItems || dict.map.has(key)) dict.map.set(key, v)
  }
}

// ───────────────────────── 解碼器 ─────────────────────────

const BOMB = '解壓縮後超過單一串流的上限（疑似壓縮炸彈）'
const BOMB_TOTAL = '解壓縮的總量超過上限（疑似壓縮炸彈）'
const EMPTY = Buffer.alloc(0)
/** 支援的解碼器（Crypt 另外看） */
const DECODERS = new Set(['FlateDecode', 'Fl', 'LZWDecode', 'LZW', 'ASCIIHexDecode', 'AHx', 'ASCII85Decode', 'A85', 'RunLengthDecode', 'RL'])
/** 會套 predictor 的解碼器 */
const PREDICTED = new Set(['FlateDecode', 'Fl', 'LZWDecode', 'LZW'])

/** 呼叫一次這個解碼器的固定成本（見 COST.flateCall） */
function decoderCallCost(name: string): number {
  if (name === 'FlateDecode' || name === 'Fl') return COST.flateCall
  if (name === 'LZWDecode' || name === 'LZW') return COST.lzwCall
  return COST.filterCall
}

/**
 * 一個解碼器的結果。data：解出來的（碰到上限時是上限以內的開頭）；full：碰到上限、後面被截掉；
 * work：嘗試解出的 byte 數，含出錯、重試、被丟掉的輸出（預算與總解壓量照這個扣）。
 */
type Decoded = { data: Buffer; full: boolean; work: number }

/** 跑一個用 ByteSink 輸出的解碼器：滿了就停，回已經解出的部分 */
function collect(out: ByteSink, run: () => void): Decoded {
  let full = false
  try {
    run()
  } catch (err) {
    if (err !== SINK_FULL) throw err
    full = true
  }
  const data = out.result()
  return { data, full, work: data.length }
}

/** zlib 一次輸出的區塊（最大 16 KB，見 zlibChunk）：maxOutputLength 超過時最多已經多解了這麼多，照 64 KB 算 */
const ZLIB_CHUNK = 64 * 1024

/**
 * zlib 輸出區塊的大小，照輸入大小設（輸入的 4 倍，1 KB～16 KB）。Node 預設每次解壓都配一塊 16 KB，
 * 解出來的結果是那一塊的切片：很多個小串流時，每個結果都留住 16 KB，而且在 V8 heap 外面
 * （heap 上限管不到，實測 35 萬段、27 MB 的檔 maxRSS 1.35 GB）。下限 1 KB：區塊太小時要呼叫 zlib 很多次，
 * 實測 33 byte 解開 16 KB 的串流，區塊 64 byte 一次 36 µs、1 KB 一次 8.5 µs、16 KB 一次 9.5 µs。
 */
function zlibChunk(inputLength: number): number {
  return Math.max(1024, Math.min(16 * 1024, inputLength * 4))
}

/**
 * 剛好大小的複本。解碼的結果會快取到這次呼叫結束：結果只用到配置空間的一小部分時
 * （zlib 的輸出區塊、ByteSink 長一倍的緩衝區、Buffer 共用池的 8 KB），留著的記憶體會比扣的預算多很多。
 * 用 Buffer.alloc（不走共用池；64 byte 以下在 V8 heap 裡）。
 */
function exactCopy(b: Uint8Array): Buffer {
  if (b.length === 0) return EMPTY
  const c = Buffer.alloc(b.length)
  c.set(b)
  return c
}

/** 結果佔的空間比它大很多（超過一倍）就換成剛好大小的複本 */
function compact(b: Buffer): Buffer {
  return b.length === 0 ? EMPTY : b.buffer.byteLength > 2 * b.length ? exactCopy(b) : b
}
/** deflate 的最大壓縮比（zlib FAQ：1032:1）：解到一半出錯時，最多已經解出這麼多倍 */
const DEFLATE_MAX_RATIO = 1032

/** 開頭兩個 byte 是合法的 zlib 檔頭（deflate、視窗 ≤ 32K、檢查碼對、沒有預設字典） */
function zlibHeader(d: Buffer): boolean {
  return d.length >= 2 && (d[0] & 0x0f) === 8 && d[0] >> 4 <= 7 && ((d[0] << 8) | d[1]) % 31 === 0 && (d[1] & 0x20) === 0
}

/**
 * Flate 解壓，輸出不超過 limit。
 * - 一律用 raw inflate：有合法的 zlib 檔頭就跳過那 2 byte，沒有（有些檔案少了檔頭）就從頭解。
 *   結尾的 Adler-32 檢查碼不驗（raw inflate 解到 deflate 的最後一個區塊就停，後面的 byte 不看）：
 *   有些產生器會寫錯檢查碼，poppler、pdf.js 也不驗，解出來的內容照用。
 * - 長度 0（或只有檔頭）：空的內容，不是碰到上限。
 * - 解開超過上限：只取輸入的前半段（再不行前四分之一、前八分之一）再解一次，
 *   拿上限以內的開頭，很大的正常頁面開頭的字還讀得到。每次嘗試都算工（照上限算）。
 * - 解到一半出錯（壞掉的壓縮資料）：當成空的（盡力而為）；出錯前做了多少工不知道，
 *   照 deflate 的最大壓縮比悲觀地算（不超過上限）。
 * - 輸出區塊照輸入大小配（zlibChunk）；結果只用到區塊的一小部分時換成剛好大小的複本（compact）。
 */
function inflateLimited(data: Buffer, limit: number): Decoded {
  const body = zlibHeader(data) ? data.subarray(2) : data
  // 沒有東西可解：不是炸彈（下面的迴圈一次都不跑，會被當成「每次嘗試都超過上限」）
  if (body.length === 0) return { data: EMPTY, full: false, work: 0 }
  const opts = { finishFlush: zlibConstants.Z_SYNC_FLUSH, maxOutputLength: Math.max(1, limit), chunkSize: zlibChunk(body.length) }
  let work = 0
  let n = body.length
  for (let tries = 0; tries < 4 && n > 0; tries++) {
    try {
      const out = inflateRawSync(n === body.length ? body : body.subarray(0, n), opts)
      work += out.length
      return { data: compact(out), full: n < body.length, work }
    } catch (err) {
      if ((err as { code?: string })?.code !== 'ERR_BUFFER_TOO_LARGE') {
        work += Math.min(limit, n * DEFLATE_MAX_RATIO) + ZLIB_CHUNK
        return { data: EMPTY, full: n < body.length, work }
      }
      work += limit + ZLIB_CHUNK
      n = Math.floor(n / 2)
    }
  }
  return { data: EMPTY, full: true, work }
}

function asciiHexDecode(data: Buffer, limit: number): Decoded {
  const out = new ByteSink(data.length >> 1, limit)
  return collect(out, () => {
    let hi = -1
    for (let i = 0; i < data.length; i++) {
      const c = data[i]
      if (c === 62) break
      const v = hexVal(c)
      if (v < 0) continue
      if (hi < 0) hi = v
      else {
        out.push(hi * 16 + v)
        hi = -1
      }
    }
    if (hi >= 0) out.push(hi * 16)
  })
}

function ascii85Decode(data: Buffer, limit: number): Decoded {
  const out = new ByteSink(data.length, limit)
  return collect(out, () => {
    const group = [0, 0, 0, 0, 0]
    let n = 0
    let i = 0
    // 可能有 <~ 開頭
    while (i < data.length && WS[data[i]]) i++
    if (data[i] === 60 && data[i + 1] === 126) i += 2
    for (; i < data.length; i++) {
      const c = data[i]
      if (c === 126) break
      if (WS[c]) continue
      if (c === 122 && n === 0) {
        for (let k = 0; k < 4; k++) out.push(0)
        continue
      }
      if (c < 33 || c > 117) continue
      group[n++] = c - 33
      if (n === 5) {
        let v = 0
        for (let k = 0; k < 5; k++) v = v * 85 + group[k]
        out.push((v >>> 24) & 0xff)
        out.push((v >>> 16) & 0xff)
        out.push((v >>> 8) & 0xff)
        out.push(v & 0xff)
        n = 0
      }
    }
    if (n > 1) {
      for (let k = n; k < 5; k++) group[k] = 84
      let v = 0
      for (let k = 0; k < 5; k++) v = v * 85 + group[k]
      const bytes = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
      for (let k = 0; k < n - 1; k++) out.push(bytes[k])
    }
  })
}

/**
 * LZW 的字碼表，整個模組共用一份：每次呼叫都配 4 張 4096 格的表（約 45 KB）加上初始化，
 * 一次要 10～16 µs（實測），很多個小串流時比解碼本身貴得多。可以共用：解碼是同步的、不會重入；
 * 0–255 只在這裡設一次、之後不會被寫（新字碼從 258 開始）；258 以上的格子一定先寫再讀
 * （只讀比 next 小的字碼，next 每次解碼、每個清除碼都從 258 重來）。
 */
const LZW_PREFIX = new Int32Array(4096)
const LZW_SUFFIX = new Uint8Array(4096)
const LZW_FIRST = new Uint8Array(4096)
const LZW_LENS = new Int32Array(4096)
const LZW_TMP = new Uint8Array(4096)
for (let i = 0; i < 256; i++) {
  LZW_PREFIX[i] = -1
  LZW_SUFFIX[i] = i
  LZW_FIRST[i] = i
  LZW_LENS[i] = 1
}

function lzwDecode(data: Buffer, earlyChange: number, limit: number): Decoded {
  if (data.length === 0) return { data: EMPTY, full: false, work: 0 }
  const out = new ByteSink(data.length * 2, limit)
  return collect(out, () => {
    const prefix = LZW_PREFIX
    const suffix = LZW_SUFFIX
    const first = LZW_FIRST
    const lens = LZW_LENS
    const tmp = LZW_TMP
    let next = 258
    let width = 9
    let prev = -1
    let bitBuf = 0
    let bitCnt = 0
    let pos = 0
    const emit = (code: number): void => {
      const len = lens[code]
      let c = code
      for (let k = len - 1; k >= 0; k--) {
        tmp[k] = suffix[c]
        c = prefix[c]
      }
      out.ensure(len)
      for (let k = 0; k < len; k++) out.push(tmp[k])
    }
    for (;;) {
      while (bitCnt < width && pos < data.length) {
        bitBuf = ((bitBuf & 0xffffff) << 8) | data[pos++]
        bitCnt += 8
      }
      if (bitCnt < width) break
      const code = (bitBuf >>> (bitCnt - width)) & ((1 << width) - 1)
      bitCnt -= width
      if (code === 256) {
        next = 258
        width = 9
        prev = -1
        continue
      }
      if (code === 257) break
      if (prev < 0) {
        if (code > 255) break
        emit(code)
        prev = code
        continue
      }
      if (code < next) {
        emit(code)
        if (next < 4096) {
          prefix[next] = prev
          suffix[next] = first[code]
          first[next] = first[prev]
          lens[next] = lens[prev] + 1
          next++
        }
      } else if (code === next && next < 4096) {
        prefix[next] = prev
        suffix[next] = first[prev]
        first[next] = first[prev]
        lens[next] = lens[prev] + 1
        next++
        emit(code)
      } else break
      prev = code
      if (next + earlyChange >= 1 << width && width < 12) width++
    }
  })
}

function runLengthDecode(data: Buffer, limit: number): Decoded {
  const out = new ByteSink(data.length * 2, limit)
  return collect(out, () => {
    let i = 0
    while (i < data.length) {
      const len = data[i++]
      if (len === 128) break
      if (len < 128) {
        const n = Math.min(len + 1, data.length - i)
        out.ensure(n)
        for (let k = 0; k < n; k++) out.push(data[i + k])
        i += n
      } else {
        if (i >= data.length) break
        const b = data[i++]
        const n = 257 - len
        out.ensure(n)
        for (let k = 0; k < n; k++) out.push(b)
      }
    }
  })
}

function intParam(p: PDict | null, key: string, dflt: number, lo: number, hi: number): number {
  const v = p ? p.get(key) : null
  if (!isNum(v)) return dflt
  const n = Math.trunc(v)
  return n < lo || n > hi ? dflt : n
}

/** PNG（10–15）與 TIFF（2）predictor */
function unpredict(data: Buffer, p: PDict | null): Buffer {
  const predictor = intParam(p, 'Predictor', 1, 1, 15)
  if (predictor <= 1) return data
  const colors = intParam(p, 'Colors', 1, 1, 32)
  const bpc = intParam(p, 'BitsPerComponent', 8, 1, 16)
  const columns = intParam(p, 'Columns', 1, 1, 1 << 20)
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8))
  const rowLen = Math.ceil((colors * bpc * columns) / 8)
  if (predictor === 2) {
    if (bpc !== 8) return data
    const out = Buffer.from(data)
    for (let r = 0; r + rowLen <= out.length; r += rowLen) {
      for (let i = colors; i < rowLen; i++) out[r + i] = (out[r + i] + out[r + i - colors]) & 0xff
    }
    return out
  }
  if (predictor < 10) return data
  const rows = Math.floor(data.length / (rowLen + 1))
  const out = Buffer.alloc(rows * rowLen)
  let prevRow = -1
  for (let r = 0; r < rows; r++) {
    const src = r * (rowLen + 1)
    const ft = data[src]
    const dst = r * rowLen
    for (let i = 0; i < rowLen; i++) {
      const raw = data[src + 1 + i]
      const left = i >= bpp ? out[dst + i - bpp] : 0
      const up = prevRow >= 0 ? out[prevRow + i] : 0
      const ul = prevRow >= 0 && i >= bpp ? out[prevRow + i - bpp] : 0
      let v: number
      switch (ft) {
        case 1: v = raw + left; break
        case 2: v = raw + up; break
        case 3: v = raw + ((left + up) >> 1); break
        case 4: {
          const pp = left + up - ul
          const pa = Math.abs(pp - left)
          const pb = Math.abs(pp - up)
          const pc = Math.abs(pp - ul)
          v = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul)
          break
        }
        default: v = raw
      }
      out[dst + i] = v & 0xff
    }
    prevRow = dst
  }
  return out
}

// ───────────────────────── 文件：找物件 ─────────────────────────

type ObjStmData = { data: Buffer; first: number; nums: number[]; offs: number[] }
type PageRef = { dict: PDict; resources: PVal }
/**
 * 找到的頁。first：前 keep 頁（照閱讀順序）；count：數到的頁數；complete：數完了沒
 * （頁面樹的額度用完就停）；declared：根節點 /Pages 的 /Count（沒有是 -1）。
 */
type PageList = { first: PageRef[]; count: number; complete: boolean; declared: number }

const WSC = '[\\0\\t\\n\\f\\r ]'

class PdfDoc {
  buf: Buffer
  s: string
  /** 物件編號 → 本體起點（`obj` 之後） */
  offsets: Map<number, number>
  /** 依檔案順序的物件檔頭位置與編號（找「某個位置屬於哪個物件」用） */
  headerPos: number[]
  headerNum: number[]
  /** 串流資料區段 [start, end)，依位置排序 */
  streamStart: number[]
  streamEnd: number[]
  /** 檔案裡的物件串流編號 */
  objStmNums: number[]
  cache: Map<number, PVal>
  resolving: Set<number>
  depth: number
  objStmIndex: Map<number, { stm: number; idx: number }> | null
  objStmLoaded: Map<number, ObjStmData | null>
  decoded: WeakMap<PStream, Buffer>
  /** 所有解碼器嘗試解出的總量（含出錯、被丟掉的輸出） */
  decodedTotal: number
  budget: Budget
  /**
   * 第一個碰到的上限（解壓超過上限、處理量用完）：碰到之後已經讀到的照樣回（truncated）；
   * 一個字都沒讀到才把它丟出去
   */
  stopError: PdfError | null

  constructor(buf: Buffer, budget: Budget) {
    this.buf = buf
    this.budget = budget
    this.s = buf.latin1Slice(0, buf.length)
    this.offsets = new Map()
    this.headerPos = []
    this.headerNum = []
    this.streamStart = []
    this.streamEnd = []
    this.objStmNums = []
    this.cache = new Map()
    this.resolving = new Set()
    this.depth = 0
    this.objStmIndex = null
    this.objStmLoaded = new Map()
    this.decoded = new WeakMap()
    this.decodedTotal = 0
    this.stopError = null
  }

  /** 記下碰到的上限（只留第一個） */
  noteStop(err: PdfError): void {
    if (this.stopError === null) this.stopError = err
  }

  /** 掃整個檔案找 `N G obj` 與串流區段（不靠 xref）。 */
  scan(): void {
    const s = this.s
    // stream 關鍵字一定緊接在串流字典的 >> 後面：字串裡剛好出現「stream＋換行」（標題、註解）不算。
    // 往回看的檢查放在比對到 stream 之後，只在真的出現 stream 的地方才做。
    const re = new RegExp(`(?<![0-9])([0-9]{1,10})${WSC}+([0-9]{1,5})${WSC}+obj(?![A-Za-z0-9_])|stream(?<=>>${WSC}*stream)(?=[ \\t]*[\\r\\n])`, 'g')
    let count = 0
    let lastBody = -1
    let lastNum = -1
    let lastHadStream = true
    let m: RegExpExecArray | null
    while ((m = re.exec(s)) !== null) {
      this.budget.spend(COST.step)
      if (m[1] !== undefined) {
        if (++count > PDF_LIMITS.maxObjects) throw new PdfError('TOO_LARGE', `物件數超過上限 ${PDF_LIMITS.maxObjects}`)
        const num = Number(m[1])
        const body = m.index + m[0].length
        this.offsets.set(num, body)
        this.headerPos.push(m.index)
        this.headerNum.push(num)
        lastBody = body
        lastNum = num
        lastHadStream = false
        continue
      }
      // stream 關鍵字：資料從換行之後開始，到 endstream 為止
      let p = m.index + 6
      while (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9) p++
      if (s.charCodeAt(p) === 13) p++
      if (s.charCodeAt(p) === 10) p++
      const e = s.indexOf('endstream', p)
      const end = e < 0 ? s.length : e
      this.streamStart.push(p)
      this.streamEnd.push(end)
      if (!lastHadStream && lastBody >= 0) {
        lastHadStream = true
        if (m.index - lastBody < 8192 && s.slice(lastBody, m.index).includes('/ObjStm')) this.objStmNums.push(lastNum)
      }
      if (e < 0) break
      re.lastIndex = e + 9
    }
  }

  /**
   * 檔案被截斷了嗎（下載到一半最常見）：最後一個物件後面，檔尾的結構（startxref 加上位移，或 %%EOF）
   * 一個都沒有。串流資料裡的不算（截斷的串流一路到檔尾，裡面剛好有 %%EOF 也一樣是截斷）。
   * 截在串流裡（含 endstream 關鍵字中間）、物件中間、物件與物件之間、xref 表裡都算截斷。
   * 不算截斷的：%%EOF 後面還有填充；截在增量更新之前的 %%EOF（那是一份完整的舊版本）；
   * 內容完整、只是少了 %%EOF 或寫錯（例如 %EOF）的檔（startxref 在最後一個物件後面）。
   */
  isCut(): boolean {
    const hp = this.headerPos
    if (hp.length === 0) return false
    const last = hp[hp.length - 1]
    return !this.markAfter('%%EOF', last, () => true) && !this.markAfter('startxref', last, i => /^startxref[\0\t\n\f\r ]+[0-9]/.test(this.s.slice(i, i + 32)))
  }

  /**
   * 位置 after 之後、串流外面，有沒有符合 ok 的 word。從檔尾往前找：完整的檔第一個找到的就在串流外面。
   * 串流裡連續找到 64 個還沒找到外面的，只可能是截斷的串流裡塞了很多這個字，直接當成沒有
   * （不會被拖著一直找）。
   */
  markAfter(word: string, after: number, ok: (i: number) => boolean): boolean {
    const s = this.s
    let from = s.length
    for (let hits = 0; hits < 64; hits++) {
      const i = s.lastIndexOf(word, from)
      // i 是 -1（完全沒有）也在這裡回
      if (i <= after) return false
      this.budget.spend(COST.step)
      if (this.outsideStreams(i) && ok(i)) return true
      from = i - 1
    }
    return false
  }

  /** 這個位置不在任何串流資料裡 */
  outsideStreams(pos: number): boolean {
    const st = this.streamStart
    let lo = 0
    let hi = st.length - 1
    let idx = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (st[mid] <= pos) {
        idx = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    return idx < 0 || pos >= this.streamEnd[idx]
  }

  /** 串流外面每個符合 re 的位置呼叫 fn（re 要帶 g 旗標）；fn 回 true 就停。 */
  eachOutside(re: RegExp, fn: (m: RegExpExecArray) => boolean | void): void {
    let m: RegExpExecArray | null
    while ((m = re.exec(this.s)) !== null) {
      this.budget.spend(COST.step)
      if (this.outsideStreams(m.index) && fn(m) === true) return
    }
  }

  /** 串流外面最後 keep 個符合 re 的物件編號（由後往前）；pick 從比對結果取編號 */
  lastOutside(re: RegExp, keep: number, pick: (m: RegExpExecArray) => number): number[] {
    const ring: number[] = []
    this.eachOutside(re, m => {
      const num = pick(m)
      if (num < 0) return
      if (ring.length >= keep) ring.shift()
      ring.push(num)
    })
    return ring.reverse()
  }

  /** 這個位置屬於哪個物件（前面最近的物件檔頭） */
  enclosingNum(pos: number): number {
    const hp = this.headerPos
    let lo = 0
    let hi = hp.length - 1
    let idx = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (hp[mid] <= pos) {
        idx = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    return idx < 0 ? -1 : this.headerNum[idx]
  }

  /** trailer、xref 串流字典或任何地方有 /Encrypt → 加密 */
  checkEncryption(): void {
    const re = new RegExp(`/Encrypt(?![A-Za-z0-9_#.-])${WSC}*(?:[0-9]+${WSC}+[0-9]+${WSC}+R|<<)`, 'g')
    let found = false
    this.eachOutside(re, () => {
      found = true
      return true
    })
    if (found) throw new PdfError('ENCRYPTED', 'PDF 有加密，不讀')
  }

  get(num: number): PVal {
    const hit = this.cache.get(num)
    if (hit !== undefined) return hit
    if (this.resolving.has(num) || this.depth >= PDF_LIMITS.maxResolveDepth) return null
    this.resolving.add(num)
    this.depth++
    let v: PVal = null
    try {
      const off = this.offsets.get(num)
      v = off !== undefined ? this.parseAt(off) : this.fromObjStm(num)
    } catch (err) {
      if (!(err instanceof PdfSyntaxError)) throw err
      v = null
    } finally {
      this.resolving.delete(num)
      this.depth--
    }
    this.cache.set(num, v)
    return v
  }

  resolve(v: PVal | undefined): PVal {
    let hops = 0
    while (v instanceof PRef) {
      if (++hops > PDF_LIMITS.maxRefHops) return null
      v = this.get(v.num)
    }
    return v === undefined ? null : v
  }

  dict(v: PVal | undefined): PDict | null {
    const r = this.resolve(v)
    return r instanceof PDict ? r : r instanceof PStream ? r.dict : null
  }

  parseAt(off: number): PVal {
    const lx = new Lexer(this.buf, off)
    lx.allow(this.budget.avail())
    try {
      return this.parseBody(lx)
    } finally {
      // 讀過的都算（沒收尾的字串、找 endstream 會一路讀到檔尾）
      this.budget.spend(lx.cost(off, 0))
    }
  }

  parseBody(lx: Lexer): PVal {
    const buf = this.buf
    const v = parseValue(lx, 0, true)
    if (v === EOF || v === STRAY || v instanceof POp) return null
    if (!(v instanceof PDict)) return v
    lx.skipWs()
    if (!lx.isKeyword('stream')) return v
    let p = lx.pos + 6
    let q = p
    while (q < buf.length && (buf[q] === 32 || buf[q] === 9)) q++
    if (buf[q] === 13 || buf[q] === 10) p = q
    if (buf[p] === 13) p++
    if (buf[p] === 10) p++
    const start = p
    let end = -1
    const len = this.resolve(v.get('Length'))
    if (isNum(len) && Number.isInteger(len) && len >= 0 && start + len <= buf.length) {
      let k = start + len
      const stop = Math.min(buf.length, k + 64)
      while (k < stop && WS[buf[k]]) k++
      // 檔案截在 endstream 關鍵字中間（或剛好截在資料後面）：剩下的是 endstream 的開頭，/Length 照用
      const tail = buf.latin1Slice(k, Math.min(k + 9, buf.length))
      if (tail === 'endstream' || (k + tail.length === buf.length && 'endstream'.startsWith(tail))) end = start + len
    }
    if (end < 0) {
      const e = this.s.indexOf('endstream', start)
      end = e < 0 ? buf.length : e
      lx.pos = end
      if (end > start && buf[end - 1] === 10) end--
      if (end > start && buf[end - 1] === 13) end--
    }
    return new PStream(v, buf.subarray(start, end))
  }

  loadObjStm(num: number): ObjStmData | null {
    if (this.objStmLoaded.has(num)) return this.objStmLoaded.get(num) ?? null
    // 先記成 null（自己參照自己不會無限遞迴）；中途預算用完就拿掉，之後還能再載
    this.objStmLoaded.set(num, null)
    try {
      return this.loadObjStmData(num)
    } catch (err) {
      this.objStmLoaded.delete(num)
      throw err
    }
  }

  loadObjStmData(num: number): ObjStmData | null {
    const stm = this.get(num)
    if (!(stm instanceof PStream) || nameOf(stm.dict.get('Type')) !== 'ObjStm') return null
    const n = stm.dict.get('N')
    const first = stm.dict.get('First')
    if (!isNum(n) || !isNum(first) || n < 0 || first < 0) return null
    const data = this.decode(stm)
    if (first > data.length) return null
    const count = Math.min(Math.trunc(n), PDF_LIMITS.maxObjects)
    const lx = new Lexer(data, 0, Math.trunc(first))
    const nums: number[] = []
    const offs: number[] = []
    for (let i = 0; i < count; i++) {
      this.budget.spend(COST.step)
      lx.skipWs()
      if (lx.pos >= lx.end) break
      const a = lx.readNumber()
      lx.skipWs()
      if (lx.pos >= lx.end) break
      const b = lx.readNumber()
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) break
      nums.push(a)
      offs.push(b)
    }
    const out = { data, first: Math.trunc(first), nums, offs }
    this.objStmLoaded.set(num, out)
    return out
  }

  /** 直接物件找不到時才建物件串流索引（會解開所有物件串流）。 */
  objStms(): Map<number, { stm: number; idx: number }> {
    if (this.objStmIndex) return this.objStmIndex
    const idx = new Map<number, { stm: number; idx: number }>()
    // 建的途中（載入物件串流時解析 /Length 參照）遞迴進來，看到的是建到一半的索引
    this.objStmIndex = idx
    try {
      let total = this.headerPos.length
      for (const sn of this.objStmNums) {
        const os = this.loadObjStm(sn)
        if (!os) continue
        total += os.nums.length
        if (total > PDF_LIMITS.maxObjects) throw new PdfError('TOO_LARGE', `物件數超過上限 ${PDF_LIMITS.maxObjects}`)
        for (let i = 0; i < os.nums.length; i++) {
          this.budget.spend(COST.step)
          if (!this.offsets.has(os.nums[i])) idx.set(os.nums[i], { stm: sn, idx: i })
        }
      }
    } catch (err) {
      // 中途預算用完：不留建到一半的索引，之後還能再建
      this.objStmIndex = null
      throw err
    }
    return idx
  }

  fromObjStm(num: number): PVal {
    const loc = this.objStms().get(num)
    if (!loc) return null
    const os = this.loadObjStm(loc.stm)
    if (!os) return null
    const off = os.offs[loc.idx]
    if (off === undefined || os.first + off > os.data.length) return null
    const lx = new Lexer(os.data, os.first + off)
    lx.allow(this.budget.avail())
    let v: PVal | typeof EOF | typeof STRAY = null
    try {
      v = parseValue(lx, 0, true)
    } finally {
      this.budget.spend(lx.cost(os.first + off, 0))
    }
    if (v === EOF || v === STRAY || v instanceof POp) return null
    return v
  }

  /**
   * 解開串流（依 /Filter）。每一層都照「吃進去的 byte＋嘗試解出的 byte」扣預算與總解壓量
   * （predictor 之前的量，含出錯前解出的、重試的、超過上限的）：predictor 把輸出縮成 0、
   * 或解到一半出錯，做過的工照樣算。
   * 超過單一串流或總量的上限時不丟錯：留下上限以內的開頭，記下 CORRUPT（stopError）。
   */
  decode(stm: PStream): Buffer {
    const hit = this.decoded.get(stm)
    if (hit) return hit
    const f = this.resolve(stm.dict.get('Filter'))
    const dp = this.resolve(stm.dict.get('DecodeParms') ?? stm.dict.get('DP'))
    // 先看長度再展開：很多串流共用一個很長的 /Filter 陣列時，不會每個串流都走一遍
    if (Array.isArray(f) && f.length > 8) throw new PdfError('UNSUPPORTED', '串流的解碼器串太長')
    const filters: PVal[] = f instanceof PName ? [f] : Array.isArray(f) ? f.map(x => this.resolve(x)) : []
    // 沒有解碼器：原始資料就是結果，不另外記進快取（很多個小串流時，每個省下一筆 WeakMap）
    if (filters.length === 0) return stm.raw
    const parms: PVal[] = Array.isArray(dp) ? dp.slice(0, filters.length).map(x => this.resolve(x)) : [dp]
    // 不支援的解碼器整份丟 UNSUPPORTED（跟碰不碰到上限無關）
    for (let i = 0; i < filters.length; i++) {
      const name = nameOf(filters[i])
      const p = parms[i] instanceof PDict ? (parms[i] as PDict) : null
      if (name === 'Crypt') {
        if (nameOf(p ? p.get('Name') : null) !== 'Identity' && p !== null) throw new PdfError('UNSUPPORTED', '串流用了 Crypt 解碼器')
      } else if (!DECODERS.has(name)) throw new PdfError('UNSUPPORTED', `不支援的解碼器 /${name || '？'}`)
    }
    let data = stm.raw
    for (let i = 0; i < filters.length; i++) {
      const name = nameOf(filters[i])
      if (name === 'Crypt') continue
      const p = parms[i] instanceof PDict ? (parms[i] as PDict) : null
      const remaining = PDF_LIMITS.maxTotalDecodedBytes - this.decodedTotal
      if (remaining <= 0) {
        this.noteStop(new PdfError('CORRUPT', BOMB_TOTAL))
        data = EMPTY
        break
      }
      const limit = Math.min(PDF_LIMITS.maxStreamBytes, remaining)
      // 解碼之前先扣：這一次呼叫的固定成本（串流是空的也扣）＋吃進去的每個 byte
      this.budget.spend(decoderCallCost(name) + data.length * COST.decoded)
      let r: Decoded
      // 空的輸入每個解碼器都解出空的：不必真的去跑（固定成本照樣扣了）
      if (data.length === 0) r = { data: EMPTY, full: false, work: 0 }
      else switch (name) {
        case 'FlateDecode':
        case 'Fl':
          r = inflateLimited(data, limit)
          break
        case 'LZWDecode':
        case 'LZW':
          r = lzwDecode(data, intParam(p, 'EarlyChange', 1, 0, 1), limit)
          break
        case 'ASCIIHexDecode':
        case 'AHx':
          r = asciiHexDecode(data, limit)
          break
        case 'ASCII85Decode':
        case 'A85':
          r = ascii85Decode(data, limit)
          break
        default:
          r = runLengthDecode(data, limit)
      }
      // 嘗試解出的每個 byte（含出錯、被丟掉的）：預算與總解壓量都照這個扣
      this.decodedTotal += r.work
      this.budget.spend(r.work * COST.decoded)
      if (r.full) this.noteStop(new PdfError('CORRUPT', limit < PDF_LIMITS.maxStreamBytes ? BOMB_TOTAL : BOMB))
      data = r.data
      if (PREDICTED.has(name) && intParam(p, 'Predictor', 1, 1, 15) > 1) {
        this.budget.spend(COST.filterCall + data.length * COST.decoded)
        data = unpredict(data, p)
      }
    }
    this.decoded.set(stm, data)
    return data
  }

  isCatalog(v: PVal): v is PDict {
    return v instanceof PDict && this.dict(v.get('Pages')) !== null
  }

  /** 找 Catalog：/Root 參照（trailer 或 xref 串流）→ 直接物件的 /Type /Catalog → 物件串流。 */
  findRoot(): PDict | null {
    // 後面的 trailer 比較新（增量更新），由後往前試，最多試 100 個
    const rootRe = new RegExp(`/Root${WSC}*([0-9]{1,10})${WSC}+([0-9]{1,5})${WSC}+R(?![A-Za-z0-9_])`, 'g')
    for (const num of this.lastOutside(rootRe, 100, m => Number(m[1]))) {
      const v = this.get(num)
      if (this.isCatalog(v)) return v
    }
    const catRe = new RegExp(`/Type${WSC}*/Catalog(?![A-Za-z0-9_])`, 'g')
    for (const num of this.lastOutside(catRe, 100, m => this.enclosingNum(m.index))) {
      const v = this.get(num)
      if (this.isCatalog(v)) return v
    }
    const inStm = [...this.objStms().keys()]
    for (let i = inStm.length - 1; i >= 0; i--) {
      this.budget.spend(COST.step)
      const v = this.get(inStm[i])
      if (v instanceof PDict && nameOf(v.get('Type')) === 'Catalog' && this.isCatalog(v)) return v
    }
    return null
  }

  /**
   * 在頁面樹的額度（maxTreeWork）裡跑 fn：額度或總預算用完就停下來回 false，
   * 呼叫端用已經找到的部分。用掉的一樣從總預算扣。
   */
  withTreeAllowance(fn: () => void): boolean {
    const b = this.budget
    const saved = b.floor
    b.floor = Math.max(saved, b.left - PDF_LIMITS.maxTreeWork)
    try {
      fn()
      return true
    } catch (err) {
      if (err instanceof PdfError && err.code === 'TOO_LARGE') return false
      throw err
    } finally {
      b.floor = saved
    }
  }

  /**
   * 頁面樹深度優先，Resources 會往下繼承；走過的節點跳過（間接參照、直接字典都算：
   * 共用的 /Kids 陣列裡的直接字典是同一個物件）。
   * 堆疊放「哪個 /Kids 陣列走到第幾個」，不把整個陣列展開推進去；每一步都扣預算，
   * 記下的節點、堆疊的每一層、留下來的頁照佔的記憶體扣。只留前 keep 頁，其他只數。
   */
  pagesFromTree(root: PDict, keep: number): PageList {
    const out: PageList = { first: [], count: 0, complete: true, declared: -1 }
    const seen = new Set<PDict>()
    const stack: { kids: PVal[]; i: number; res: PVal }[] = [{ kids: [root.get('Pages')], i: 0, res: null }]
    out.complete = this.withTreeAllowance(() => {
      while (stack.length > 0) {
        this.budget.spend(COST.step)
        const top = stack[stack.length - 1]
        if (top.i >= top.kids.length) {
          stack.pop()
          continue
        }
        const d = this.resolve(top.kids[top.i++])
        if (!(d instanceof PDict) || seen.has(d)) continue
        seen.add(d)
        this.budget.spend(COST.node)
        if (stack.length === 1 && out.declared < 0) {
          const c = this.resolve(d.get('Count'))
          // 一頁至少佔幾個 byte：比檔案還大的 /Count 不可能是真的
          if (isNum(c) && Number.isInteger(c) && c >= 0 && c <= this.buf.length) out.declared = c
        }
        const type = nameOf(d.get('Type'))
        const ownRes = d.get('Resources')
        const inherited = ownRes !== null ? ownRes : top.res
        const kids = this.resolve(d.get('Kids'))
        if (type !== 'Page' && Array.isArray(kids)) {
          this.budget.spend(COST.node)
          stack.push({ kids, i: 0, res: inherited })
          continue
        }
        if (type === 'Page' || d.map.has('Contents')) {
          out.count++
          if (out.first.length < keep) {
            this.budget.spend(COST.node)
            out.first.push({ dict: d, resources: inherited })
          }
        }
      }
    })
    return out
  }

  /** 找不到頁面樹時：照檔案裡出現的 /Type /Page 順序；Resources 沿 /Parent 往上找。額度同頁面樹。 */
  pagesByScan(keep: number): PageList {
    const out: PageList = { first: [], count: 0, complete: true, declared: -1 }
    const seen = new Set<number>()
    const add = (num: number): void => {
      this.budget.spend(COST.step)
      if (seen.has(num)) return
      seen.add(num)
      this.budget.spend(COST.node)
      const v = this.get(num)
      if (!(v instanceof PDict) || nameOf(v.get('Type')) !== 'Page') return
      out.count++
      if (out.first.length < keep) {
        this.budget.spend(COST.node)
        out.first.push({ dict: v, resources: this.inheritedResources(v) })
      }
    }
    out.complete = this.withTreeAllowance(() => {
      this.eachOutside(new RegExp(`/Type${WSC}*/Page(?![A-Za-z0-9_])`, 'g'), m => {
        const num = this.enclosingNum(m.index)
        if (num >= 0) add(num)
      })
      for (const num of this.objStms().keys()) add(num)
    })
    return out
  }

  inheritedResources(page: PDict): PVal {
    let node: PDict | null = page
    const seen = new Set<PDict>()
    for (let i = 0; node && i < PDF_LIMITS.maxRefHops && !seen.has(node); i++) {
      seen.add(node)
      const r = node.get('Resources')
      if (r !== null) return r
      node = this.dict(node.get('Parent'))
    }
    return null
  }

  /**
   * 前 keep 頁與頁數。頁面樹（或掃描）的額度用完、沒數完時，頁數用根節點的 /Count
   * （比數到的多才用）。頁面樹找不到任何頁（壞掉、或額度在找到頁之前就用完）就退回掃描。
   */
  pages(keep: number): PageList {
    const root = this.findRoot()
    let treeComplete = true
    if (root) {
      const t = this.pagesFromTree(root, keep)
      if (t.count > 0) {
        if (!t.complete && t.declared > t.count) t.count = t.declared
        return t
      }
      treeComplete = t.complete
    }
    const s = this.pagesByScan(keep)
    s.complete = s.complete && treeComplete
    return s
  }
}

// ───────────────────────── 字形名 → Unicode（Adobe Glyph List 常用子集） ─────────────────────────

const AGL = new Map<string, string>()
{
  const ascii = 'space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at'.split(' ')
  ascii.forEach((n, i) => AGL.set(n, String.fromCharCode(0x20 + i)))
  for (let i = 0; i < 26; i++) {
    AGL.set(String.fromCharCode(65 + i), String.fromCharCode(65 + i))
    AGL.set(String.fromCharCode(97 + i), String.fromCharCode(97 + i))
  }
  'bracketleft backslash bracketright asciicircum underscore grave'.split(' ').forEach((n, i) => AGL.set(n, String.fromCharCode(0x5b + i)))
  'braceleft bar braceright asciitilde'.split(' ').forEach((n, i) => AGL.set(n, String.fromCharCode(0x7b + i)))
  const latin1 = 'exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot sfthyphen registered macron degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis'.split(' ')
  latin1.forEach((n, i) => AGL.set(n, String.fromCharCode(0xa1 + i)))
  const extra = [
    'Euro 20AC quotesinglbase 201A florin 0192 quotedblbase 201E ellipsis 2026 dagger 2020 daggerdbl 2021 circumflex 02C6',
    'perthousand 2030 Scaron 0160 guilsinglleft 2039 OE 0152 Zcaron 017D quoteleft 2018 quoteright 2019 quotedblleft 201C',
    'quotedblright 201D bullet 2022 endash 2013 emdash 2014 tilde 02DC trademark 2122 scaron 0161 guilsinglright 203A oe 0153',
    'zcaron 017E Ydieresis 0178 fi FB01 fl FB02 ff FB00 ffi FB03 ffl FB04 dotlessi 0131 dotlessj 0237 Lslash 0141 lslash 0142',
    'fraction 2044 breve 02D8 dotaccent 02D9 ring 02DA hungarumlaut 02DD ogonek 02DB caron 02C7 minus 2212 nbspace 00A0',
    'nonbreakingspace 00A0 notequal 2260 infinity 221E lessequal 2264 greaterequal 2265 partialdiff 2202 summation 2211',
    'product 220F integral 222B radical 221A approxequal 2248 Delta 2206 Omega 2126 lozenge 25CA apple F8FF middot 00B7',
    'figuredash 2012 quotereversed 201B onedotenleader 2024 twodotenleader 2025 arrowleft 2190 arrowup 2191 arrowright 2192',
    'arrowdown 2193 arrowboth 2194 arrowupdn 2195 arrowdblleft 21D0 arrowdblright 21D2 arrowdblboth 21D4 element 2208',
    'notelement 2209 intersection 2229 union 222A propersubset 2282 propersuperset 2283 reflexsubset 2286 reflexsuperset 2287',
    'therefore 2234 similar 223C congruent 2245 equivalence 2261 universal 2200 existential 2203 emptyset 2205 gradient 2207',
    'logicaland 2227 logicalor 2228 perpendicular 22A5 dotmath 22C5 angle 2220 angleleft 2329 angleright 232A club 2663',
    'diamond 2666 heart 2665 spade 2660 checkmark 2713 circle 25CB filledbox 25A0 triagup 25B2 triagdn 25BC triagrt 25BA',
    'triaglf 25C4 openbullet 25E6 Alpha 0391 Beta 0392 Gamma 0393 Deltagreek 0394 Epsilon 0395 Zeta 0396 Eta 0397 Theta 0398',
    'Iota 0399 Kappa 039A Lambda 039B Mu 039C Nu 039D Xi 039E Omicron 039F Pi 03A0 Rho 03A1 Sigma 03A3 Tau 03A4 Upsilon 03A5',
    'Phi 03A6 Chi 03A7 Psi 03A8 Omegagreek 03A9 alpha 03B1 beta 03B2 gamma 03B3 delta 03B4 epsilon 03B5 zeta 03B6 eta 03B7',
    'theta 03B8 iota 03B9 kappa 03BA lambda 03BB mugreek 03BC nu 03BD xi 03BE omicron 03BF pi 03C0 rho 03C1 sigma1 03C2',
    'sigma 03C3 tau 03C4 upsilon 03C5 phi 03C6 chi 03C7 psi 03C8 omega 03C9 theta1 03D1 phi1 03D5 omega1 03D6 Upsilon1 03D2',
    'Amacron 0100 amacron 0101 Abreve 0102 abreve 0103 Aogonek 0104 aogonek 0105 Cacute 0106 cacute 0107 Ccaron 010C',
    'ccaron 010D Dcaron 010E dcaron 010F Dcroat 0110 dcroat 0111 Emacron 0112 emacron 0113 Edotaccent 0116 edotaccent 0117',
    'Eogonek 0118 eogonek 0119 Ecaron 011A ecaron 011B Gbreve 011E gbreve 011F Gcommaaccent 0122 gcommaaccent 0123',
    'Imacron 012A imacron 012B Iogonek 012E iogonek 012F Idotaccent 0130 Kcommaaccent 0136 kcommaaccent 0137 Lacute 0139',
    'lacute 013A Lcommaaccent 013B lcommaaccent 013C Lcaron 013D lcaron 013E Nacute 0143 nacute 0144 Ncommaaccent 0145',
    'ncommaaccent 0146 Ncaron 0147 ncaron 0148 Omacron 014C omacron 014D Ohungarumlaut 0150 ohungarumlaut 0151 Racute 0154',
    'racute 0155 Rcommaaccent 0156 rcommaaccent 0157 Rcaron 0158 rcaron 0159 Sacute 015A sacute 015B Scedilla 015E',
    'scedilla 015F Scommaaccent 0218 scommaaccent 0219 Tcommaaccent 0162 tcommaaccent 0163 Tcaron 0164 tcaron 0165',
    'Umacron 016A umacron 016B Uring 016E uring 016F Uhungarumlaut 0170 uhungarumlaut 0171 Uogonek 0172 uogonek 0173',
    'Zacute 0179 zacute 017A Zdotaccent 017B zdotaccent 017C',
  ].join(' ').split(' ')
  for (let i = 0; i + 1 < extra.length; i += 2) AGL.set(extra[i], String.fromCharCode(parseInt(extra[i + 1], 16)))
  // 西里爾字母（afii 名稱）
  for (let i = 0; i < 33; i++) {
    const upper = i < 6 ? 0x410 + i : i === 6 ? 0x401 : 0x410 + i - 1
    const lower = i < 6 ? 0x430 + i : i === 6 ? 0x451 : 0x430 + i - 1
    AGL.set(`afii${10017 + i}`, String.fromCharCode(upper))
    AGL.set(`afii${10065 + i}`, String.fromCharCode(lower))
  }
}

function glyphOne(n: string): string {
  const hit = AGL.get(n)
  if (hit !== undefined) return hit
  let m = /^uni((?:[0-9A-F]{4})+)$/.exec(n)
  if (m) {
    let out = ''
    for (let i = 0; i < m[1].length; i += 4) {
      const u = parseInt(m[1].slice(i, i + 4), 16)
      if (u >= 0xd800 && u <= 0xdfff) return ''
      out += String.fromCharCode(u)
    }
    return out
  }
  m = /^u([0-9A-F]{4,6})$/.exec(n)
  if (m) {
    const cp = parseInt(m[1], 16)
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return ''
    return String.fromCodePoint(cp)
  }
  return ''
}

/** 字形名 → Unicode；不認得就回空字串（不猜）。 */
function glyphToUnicode(name: string): string {
  if (!name) return ''
  const dot = name.indexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  if (base.includes('_')) {
    const parts = base.split('_').map(glyphOne)
    return parts.every(p => p !== '') ? parts.join('') : ''
  }
  return glyphOne(base)
}

// ───────────────────────── 簡單字型的編碼表 ─────────────────────────

type Encoding = string[]

function decodeTable(label: string): Encoding | null {
  let dec: TextDecoder
  try {
    dec = new TextDecoder(label)
  } catch {
    return null
  }
  const out: Encoding = new Array(256).fill('')
  for (let c = 0x20; c < 256; c++) out[c] = dec.decode(Uint8Array.of(c))
  return out
}

const WIN_ANSI: Encoding = (() => {
  const t = decodeTable('windows-1252') ?? new Array(256).fill('').map((_, c) => (c >= 0x20 ? String.fromCharCode(c) : ''))
  t[0xa0] = ' '
  t[0xad] = '-'
  return t
})()

const STANDARD: Encoding = (() => {
  const t: Encoding = new Array(256).fill('')
  for (let c = 0x20; c < 0x7f; c++) t[c] = String.fromCharCode(c)
  t[0x27] = '’'
  t[0x60] = '‘'
  const upper = 'A1 exclamdown A2 cent A3 sterling A4 fraction A5 yen A6 florin A7 section A8 currency A9 quotesingle AA quotedblleft AB guillemotleft AC guilsinglleft AD guilsinglright AE fi AF fl B1 endash B2 dagger B3 daggerdbl B4 periodcentered B6 paragraph B7 bullet B8 quotesinglbase B9 quotedblbase BA quotedblright BB guillemotright BC ellipsis BD perthousand BF questiondown C1 grave C2 acute C3 circumflex C4 tilde C5 macron C6 breve C7 dotaccent C8 dieresis CA ring CB cedilla CD hungarumlaut CE ogonek CF caron D0 emdash E1 AE E3 ordfeminine E8 Lslash E9 Oslash EA OE EB ordmasculine F1 ae F5 dotlessi F8 lslash F9 oslash FA oe FB germandbls'.split(' ')
  for (let i = 0; i + 1 < upper.length; i += 2) t[parseInt(upper[i], 16)] = glyphToUnicode(upper[i + 1])
  return t
})()

let macRoman: Encoding | null | undefined
function namedEncoding(name: string): Encoding | null {
  switch (name) {
    case 'WinAnsiEncoding':
    case 'PDFDocEncoding':
      return WIN_ANSI
    case 'StandardEncoding':
      return STANDARD
    case 'MacRomanEncoding':
      if (macRoman === undefined) macRoman = decodeTable('macintosh')
      return macRoman ?? WIN_ANSI
    default:
      return null
  }
}

// ───────────────────────── CMap（ToUnicode 與內嵌編碼） ─────────────────────────

type CodeRange = { len: number; lo: number[]; hi: number[] }
type CMapData = { map: Map<number, string>; lens: Set<number>; ranges: CodeRange[]; usecmap: string; wmode: number }

const LEN_KEY = 4294967296

function bytesToCode(b: Uint8Array, start: number, len: number): number {
  let v = 0
  for (let i = 0; i < len; i++) v = v * 256 + b[start + i]
  return v
}

function utf16be(b: Uint8Array): string {
  if (b.length === 1) return String.fromCharCode(b[0])
  let s = ''
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1])
  return s
}

/**
 * 解析 CMap（ToUnicode 或內嵌的編碼 CMap）。每新增或覆寫一筆都扣預算：
 * 上限算的是實際做的工與留下來的記憶體，不是表的大小（bfrange 重複蓋同一段字碼照樣要扣）。
 */
function parseCMap(data: Buffer, budget: Budget): CMapData {
  const out: CMapData = { map: new Map(), lens: new Set(), ranges: [], usecmap: '', wmode: 0 }
  const lx = new Lexer(data)
  const ops: PVal[] = []
  let lastPos = 0
  let lastCount = 0
  const add = (src: Uint8Array, dst: string): void => {
    budget.spend(COST.entry + dst.length * COST.char)
    if (src.length < 1 || src.length > 4) return
    out.map.set(src.length * LEN_KEY + bytesToCode(src, 0, src.length), dst)
    out.lens.add(src.length)
  }
  for (;;) {
    lx.allow(budget.avail())
    const t = parseValue(lx, 0, false)
    budget.spend(lx.cost(lastPos, lastCount))
    lastPos = lx.pos
    lastCount = lx.count
    if (t === EOF) break
    if (t === STRAY) continue
    if (!(t instanceof POp)) {
      if (ops.length < 300_000) ops.push(t)
      continue
    }
    switch (t.op) {
      case 'endcodespacerange':
        for (let i = 0; i + 1 < ops.length && out.ranges.length < 256; i += 2) {
          budget.spend(COST.step)
          const a = ops[i]
          const b = ops[i + 1]
          if (a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.length >= 1 && a.length <= 4) {
            out.ranges.push({ len: a.length, lo: [...a], hi: [...b] })
          }
        }
        break
      case 'endbfchar':
        for (let i = 0; i + 1 < ops.length; i += 2) {
          const src = ops[i]
          const dst = ops[i + 1]
          if (!(src instanceof Uint8Array)) continue
          const u = dst instanceof Uint8Array ? utf16be(dst) : dst instanceof PName ? glyphToUnicode(dst.name) : null
          if (u !== null) add(src, u)
        }
        break
      case 'endbfrange':
        for (let i = 0; i + 2 < ops.length; i += 3) {
          const lo = ops[i]
          const hi = ops[i + 1]
          const dst = ops[i + 2]
          if (!(lo instanceof Uint8Array) || !(hi instanceof Uint8Array) || lo.length < 1 || lo.length > 4) continue
          const len = lo.length
          const a = bytesToCode(lo, 0, len)
          const b = hi.length === len ? bytesToCode(hi, 0, len) : a
          if (b < a) continue
          const count = Math.min(b - a + 1, 65536)
          const src = new Uint8Array(len)
          const setSrc = (code: number): void => {
            for (let k = len - 1; k >= 0; k--) {
              src[k] = code % 256
              code = Math.floor(code / 256)
            }
          }
          if (Array.isArray(dst)) {
            for (let k = 0; k < count && k < dst.length; k++) {
              const el = dst[k]
              if (!(el instanceof Uint8Array)) continue
              setSrc(a + k)
              add(src, utf16be(el))
            }
          } else if (dst instanceof Uint8Array && dst.length >= 1) {
            const units: number[] = []
            if (dst.length === 1) units.push(dst[0])
            else for (let k = 0; k + 1 < dst.length; k += 2) units.push((dst[k] << 8) | dst[k + 1])
            const last = units.length - 1
            const base = units[last]
            let prefix = ''
            for (let k = 0; k < last; k++) prefix += String.fromCharCode(units[k])
            for (let k = 0; k < count; k++) {
              if (base + k > 0xffff) break
              setSrc(a + k)
              add(src, prefix + String.fromCharCode(base + k))
            }
          } else if (dst instanceof PName) {
            setSrc(a)
            add(src, glyphToUnicode(dst.name))
          }
        }
        break
      case 'usecmap': {
        const last = ops[ops.length - 1]
        if (last instanceof PName) out.usecmap = last.name
        break
      }
      case 'def': {
        const k = ops[ops.length - 2]
        const v = ops[ops.length - 1]
        if (k instanceof PName && k.name === 'WMode' && isNum(v)) out.wmode = v
        break
      }
    }
    ops.length = 0
  }
  return out
}

// ───────────────────────── 具名 CMap（沒有 ToUnicode 時直接解字碼） ─────────────────────────

type Named = { ranges: CodeRange[]; decode: ((b: Uint8Array) => string) | null; vertical: boolean }

const R = (len: number, lo: number[], hi: number[]): CodeRange => ({ len, lo, hi })
// 具名 CMap 的 codespace 是固定的：放成常數，用同一種 CMap 的字型共用同一張查表
const TWO_BYTE = [R(2, [0, 0], [0xff, 0xff])]
const UTF16_RANGES = [R(2, [0, 0], [0xd7, 0xff]), R(4, [0xd8, 0, 0xdc, 0], [0xdb, 0xff, 0xdf, 0xff]), R(2, [0xe0, 0], [0xff, 0xff])]
const UTF8_RANGES = [R(1, [0], [0x7f]), R(2, [0xc2, 0x80], [0xdf, 0xbf]), R(3, [0xe0, 0x80, 0x80], [0xef, 0xbf, 0xbf]), R(4, [0xf0, 0x80, 0x80, 0x80], [0xf4, 0xbf, 0xbf, 0xbf])]
const UTF32_RANGES = [R(4, [0, 0, 0, 0], [0, 0x10, 0xff, 0xff])]
const BIG5_GBK_RANGES = [R(1, [0], [0x80]), R(2, [0x81, 0x40], [0xfe, 0xfe])]
const SJIS_RANGES = [R(1, [0], [0x80]), R(1, [0xa0], [0xdf]), R(2, [0x81, 0x40], [0x9f, 0xfc]), R(2, [0xe0, 0x40], [0xfc, 0xfc])]
const KSC_RANGES = [R(1, [0], [0x80]), R(2, [0x81, 0x41], [0xfe, 0xfe])]
const EUCJP_RANGES = [R(1, [0], [0x80]), R(2, [0x8e, 0xa0], [0x8e, 0xdf]), R(2, [0xa1, 0xa1], [0xfe, 0xfe])]

function textDecoder(label: string): ((b: Uint8Array) => string) | null {
  try {
    const dec = new TextDecoder(label)
    return b => dec.decode(b)
  } catch {
    return null
  }
}

function utf32(b: Uint8Array): string {
  const cp = bytesToCode(b, 0, b.length)
  return cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : ''
}

function namedCMap(name: string): Named {
  const vertical = /-V$/.test(name)
  if (/^Identity-[HV]$/.test(name)) return { ranges: TWO_BYTE, decode: null, vertical }
  if (/UCS2/.test(name)) return { ranges: TWO_BYTE, decode: utf16be, vertical }
  if (/UTF16/.test(name)) return { ranges: UTF16_RANGES, decode: utf16be, vertical }
  if (/UTF8/.test(name)) return { ranges: UTF8_RANGES, decode: textDecoder('utf-8'), vertical }
  if (/UTF32/.test(name)) return { ranges: UTF32_RANGES, decode: utf32, vertical }
  if (/B5|HKscs|HKdla|HKgccs|HKm/.test(name)) return { ranges: BIG5_GBK_RANGES, decode: textDecoder('big5'), vertical }
  if (/GB/.test(name)) return { ranges: BIG5_GBK_RANGES, decode: textDecoder('gbk'), vertical }
  if (/RKSJ/.test(name)) return { ranges: SJIS_RANGES, decode: textDecoder('shift_jis'), vertical }
  if (/KSC|UHC/.test(name)) return { ranges: KSC_RANGES, decode: textDecoder('euc-kr'), vertical }
  if (/^(EUC|Ext-EUC)-[HV]$/.test(name)) return { ranges: EUCJP_RANGES, decode: textDecoder('euc-jp'), vertical }
  return { ranges: TWO_BYTE, decode: null, vertical }
}

// ───────────────────────── codespace 查表 ─────────────────────────

/**
 * codespace 查表：每個長度、每個位置建 256 格的位元集合（第 j 個位元＝第 j 個 range 在這個位置包含這個 byte）。
 * 判斷一段字碼只要把各位置的集合 AND 起來，每個字形的成本跟 range 的數量無關。
 * 最多 256 個 range，所以一個集合最多 8 個 32 位元字；整張表最多 80 KB。
 */
class CodeMatcher {
  /** 有 range 的長度，由短到長 */
  lens: number[]
  /** 每個長度的集合要幾個 32 位元字 */
  words: number[]
  /** bits[len]：len 個位置 × 256 格 × words[len] */
  bits: (Uint32Array | null)[]
  constructor(ranges: CodeRange[], budget: Budget) {
    this.lens = []
    this.words = [0, 0, 0, 0, 0]
    this.bits = [null, null, null, null, null]
    for (let len = 1; len <= 4; len++) {
      const rs = ranges.filter(r => r.len === len)
      if (rs.length === 0) continue
      const words = (rs.length + 31) >> 5
      const bits = new Uint32Array(len * 256 * words)
      budget.spend(bits.byteLength)
      for (let j = 0; j < rs.length; j++) {
        const r = rs[j]
        for (let k = 0; k < len; k++) {
          budget.spend(COST.step)
          for (let v = r.lo[k]; v <= r.hi[k]; v++) bits[(k * 256 + v) * words + (j >> 5)] |= 1 << (j & 31)
        }
      }
      this.lens.push(len)
      this.words[len] = words
      this.bits[len] = bits
    }
  }

  /** 從 b[i] 開始、len 個 byte 的字碼在不在某個 range 裡 */
  has(b: Uint8Array, i: number, len: number): boolean {
    const bits = this.bits[len]
    if (!bits) return false
    const words = this.words[len]
    for (let w = 0; w < words; w++) {
      let acc = -1
      for (let k = 0; k < len && acc !== 0; k++) acc &= bits[(k * 256 + b[i + k]) * words + w]
      if (acc !== 0) return true
    }
    return false
  }
}

// ───────────────────────── 字型 ─────────────────────────

class FontInfo {
  simple: boolean
  vertical: boolean
  ranges: CodeRange[]
  matcher: CodeMatcher | null
  minLen: number
  toUni: CMapData | null
  enc: Encoding | null
  direct: ((b: Uint8Array) => string) | null
  directCache: Map<number, string>
  firstChar: number
  widths: number[] | null
  cidWidths: Map<number, number> | null
  defaultWidth: number
  widthScale: number
  constructor() {
    this.simple = true
    this.vertical = false
    this.ranges = []
    this.matcher = null
    this.minLen = 1
    this.toUni = null
    this.enc = null
    this.direct = null
    this.directCache = new Map()
    this.firstChar = 0
    this.widths = null
    this.cidWidths = null
    this.defaultWidth = 500
    this.widthScale = 0.001
  }

  /** 從位置 i 開始的字碼有幾個 byte：簡單字型一律 1；Type0 照 codespace（最短的那個符合的長度）。 */
  codeLen(b: Uint8Array, i: number): number {
    if (this.simple) return 1
    const m = this.matcher
    if (m) {
      for (const len of m.lens) {
        if (i + len > b.length) break
        if (m.has(b, i, len)) return len
      }
    }
    return Math.max(1, Math.min(this.minLen, b.length - i))
  }

  unicode(code: number, len: number): string {
    const tu = this.toUni
    if (tu) {
      const hit = tu.map.get(len * LEN_KEY + code)
      if (hit !== undefined) return hit
      for (const l of tu.lens) {
        if (l === len || code >= 256 ** l) continue
        const alt = tu.map.get(l * LEN_KEY + code)
        if (alt !== undefined) return alt
      }
    }
    if (this.enc) return this.enc[code] ?? ''
    if (this.direct) {
      const key = len * LEN_KEY + code
      let s = this.directCache.get(key)
      if (s === undefined) {
        const b = new Uint8Array(len)
        let c = code
        for (let k = len - 1; k >= 0; k--) {
          b[k] = c % 256
          c = Math.floor(c / 256)
        }
        s = this.direct(b)
        this.directCache.set(key, s)
      }
      return s
    }
    return ''
  }

  /** 字寬（以字級為 1 的文字空間單位） */
  width(code: number): number {
    let w: number | undefined
    if (this.widths) w = this.widths[code - this.firstChar]
    else if (this.cidWidths) w = this.cidWidths.get(code)
    if (w === undefined || !Number.isFinite(w)) w = this.defaultWidth
    return w * this.widthScale
  }
}

// ───────────────────────── 輸出文字 ─────────────────────────

/** 清掉控制字元、U+FFFD、落單的代理；康熙部首正規化成一般漢字。 */
function cleanText(u: string): string {
  let simple = true
  for (let i = 0; i < u.length; i++) {
    const c = u.charCodeAt(i)
    if (c < 0x20 || (c >= 0x7f && c < 0xa0) || (c >= 0x2e80 && c <= 0x2fdf) || (c >= 0xd800 && c <= 0xdfff) || c === 0xfffd || c === 0xfeff) {
      simple = false
      break
    }
  }
  if (simple) return u
  let out = ''
  for (const ch of u.toWellFormed()) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 9 || cp === 10 || cp === 13) out += ' '
    else if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || cp === 0xfffd || cp === 0xfeff) continue
    else if (cp >= 0x2e80 && cp <= 0x2fdf) out += ch.normalize('NFKC')
    else out += ch
  }
  return out
}

function countCodePoints(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0xdc00 || c > 0xdfff) n++
  }
  return n
}

/** 同一行裡連續的一段字；start/end 是沿著書寫方向的座標 */
type Chunk = { text: string; start: number; end: number }
/** 一行：基線的垂直座標 perp、書寫方向、字級 */
type Line = { chunks: Chunk[]; dirX: number; dirY: number; perp: number; size: number }

/** 一頁最多保留的行＋段數（空字形也算），超過就停 */
const MAX_PAGE_ITEMS = 500_000

/**
 * 收字：先依位置分行、行內分段，換頁時每行照書寫方向的座標排序（閱讀順序）再組字串。
 * - 基線偏離目前這行超過字高一半 → 新的一行（等於 y 座標改變）
 * - T* ' " → 強制新的一行
 * - 同一行裡段與段之間空隙超過 0.2 個字寬 → 補一個空白
 */
class Sink {
  maxChars: number
  chars: number
  items: number
  stopped: boolean
  pages: string[]
  lines: Line[]
  cur: Line | null
  chunk: Chunk | null
  forceBreak: boolean
  /** 這一頁開始收字了、還沒 endPage */
  open: boolean
  /** 畫了幾個字形、其中幾個解不出 Unicode */
  glyphs: number
  unmapped: number
  constructor(maxChars: number) {
    this.maxChars = maxChars
    this.chars = 0
    this.items = 0
    this.stopped = false
    this.pages = []
    this.lines = []
    this.cur = null
    this.chunk = null
    this.forceBreak = false
    this.open = false
    this.glyphs = 0
    this.unmapped = 0
  }

  beginPage(index: number): void {
    this.open = true
    this.lines = []
    this.cur = null
    this.chunk = null
    this.forceBreak = false
    this.items = 0
    if (index > 0) this.count(1)
  }

  count(n: number): void {
    this.chars += n
    if (this.chars > this.maxChars) this.stopped = true
  }

  item(): void {
    if (++this.items > MAX_PAGE_ITEMS) this.stopped = true
  }

  newline(): void {
    this.forceBreak = true
  }

  /** 一個字：起點 (x0,y0)、終點 (x1,y1)、書寫方向 (dx,dy)、裝置空間字級 size */
  glyph(u: string, x0: number, y0: number, x1: number, y1: number, dx: number, dy: number, size: number): void {
    const text = u ? cleanText(u) : ''
    // 解不出 Unicode（或只對到控制字元）的字形也數：上層靠這個比例判斷字是不是少了一大半
    this.glyphs++
    if (!text) this.unmapped++
    if (![x0, y0, x1, y1, dx, dy, size].every(Number.isFinite)) return
    let line = this.forceBreak ? null : this.cur
    if (line) {
      const perp = y0 * line.dirX - x0 * line.dirY
      if (Math.abs(perp - line.perp) > 0.5 * Math.max(size, line.size)) line = null
    }
    if (!line) {
      // 解不出字的字形不開新行
      if (!text) return
      const len = Math.hypot(dx, dy)
      const dirX = len > 0 ? dx / len : 1
      const dirY = len > 0 ? dy / len : 0
      line = { chunks: [], dirX, dirY, perp: y0 * dirX - x0 * dirY, size }
      this.lines.push(line)
      this.cur = line
      this.chunk = null
      this.forceBreak = false
      this.item()
      if (this.lines.length > 1) this.count(1)
    }
    const a0 = x0 * line.dirX + y0 * line.dirY
    const a1 = x1 * line.dirX + y1 * line.dirY
    const tol = Math.max(0.2 * Math.max(size, line.size), 0.01)
    const ch = this.chunk
    if (ch && a0 >= ch.end - tol && a0 - ch.end <= tol) {
      ch.text += text
      if (a1 > ch.end) ch.end = a1
    } else {
      const c = { text, start: a0, end: Math.max(a0, a1) }
      line.chunks.push(c)
      this.chunk = c
      this.item()
      if (text && line.chunks.length > 1) this.count(1)
    }
    if (text) this.count(countCodePoints(text))
  }

  endPage(): void {
    const out: string[] = []
    for (const line of this.lines) {
      const cs = line.chunks.slice().sort((a, b) => a.start - b.start)
      const tol = Math.max(0.2 * line.size, 0.01)
      let s = ''
      let prevEnd = Number.NEGATIVE_INFINITY
      for (const c of cs) {
        if (c.text) {
          if (s && c.start - prevEnd > tol && !s.endsWith(' ') && !c.text.startsWith(' ')) s += ' '
          s += c.text
        }
        if (c.end > prevEnd) prevEnd = c.end
      }
      s = s.trim()
      if (s) out.push(s)
    }
    this.pages.push(out.join('\n'))
    this.lines = []
    this.open = false
  }
}

// ───────────────────────── 內容串流 ─────────────────────────

type Matrix = [number, number, number, number, number, number]
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ]
}

type GState = {
  ctm: Matrix
  font: FontInfo | null
  size: number
  tc: number
  tw: number
  th: number
  tl: number
}

function copyState(g: GState): GState {
  return { ctm: g.ctm, font: g.font, size: g.size, tc: g.tc, tw: g.tw, th: g.th, tl: g.tl }
}

function toMatrix(v: PVal): Matrix | null {
  if (!Array.isArray(v) || v.length < 6) return null
  const m = v.slice(0, 6)
  if (!m.every(isNum)) return null
  return m as unknown as Matrix
}

class Extractor {
  doc: PdfDoc
  budget: Budget
  sink: Sink
  budgetHit: boolean
  fontByRef: Map<number, FontInfo | null>
  fontByDict: WeakMap<PDict, FontInfo | null>
  /** 解析好的 CMap（依串流）：很多字型共用同一個 ToUnicode 時只解析一次、只扣一次 */
  cmaps: WeakMap<PStream, CMapData>
  /** codespace 查表（依 range 陣列）：用同一個 CMap 的字型共用一張表 */
  matchers: WeakMap<CodeRange[], CodeMatcher>
  /** 轉好的 /Widths、/W（依陣列）：共用同一個陣列的字型只轉一次 */
  simpleWidths: WeakMap<PVal[], number[]>
  cidWidths: WeakMap<PVal[], Map<number, number>>
  /** 套上 /Differences 的編碼表（依 /Differences 陣列與基本編碼） */
  encodings: WeakMap<PVal[], Map<Encoding, Encoding>>

  constructor(doc: PdfDoc, maxChars: number) {
    this.doc = doc
    this.budget = doc.budget
    this.sink = new Sink(maxChars)
    this.budgetHit = false
    this.fontByRef = new Map()
    this.fontByDict = new WeakMap()
    this.cmaps = new WeakMap()
    this.matchers = new WeakMap()
    this.simpleWidths = new WeakMap()
    this.cidWidths = new WeakMap()
    this.encodings = new WeakMap()
  }

  get stopped(): boolean {
    return this.sink.stopped || this.budgetHit
  }

  /** 內容串流的一步：內容串流的額度用完就停下來（回已經讀到的部分） */
  tick(n: number): boolean {
    if (this.budget.trySpend(n)) return true
    this.budgetHit = true
    return false
  }

  runPage(page: PageRef): void {
    const doc = this.doc
    const res = doc.dict(page.resources)
    const contents = doc.resolve(page.dict.get('Contents'))
    const list: PVal[] = contents instanceof PStream ? [contents] : Array.isArray(contents) ? contents : []
    // /Contents 陣列的各段接起來當一條串流（規格：等於各段依序串接、中間有空白）。
    // 解碼算內容的工；接起來的長度不超過內容額度還讀得完的量，所以同一個大串流被參照很多次
    // 也只複製到額度為止。
    // 段很多（幾十萬個小串流）或某一段的物件很大時，光是收段（解析、解碼）就會用完預算：
    // 收到第一段之後，後面每一段最多只能用到內容額度剩 PART_RESERVE，留給讀已經收到的段。
    // 用到那裡就停下來（short）：不管是在兩段之間，還是解析、解碼一段的途中。
    // 不然一個字都還沒讀，整份就丟 TOO_LARGE。
    const b = this.budget
    const parts: Buffer[] = []
    let short = false
    for (const c of list) {
      if (!this.tick(COST.step)) break
      if (parts.length === 0) {
        const s = doc.resolve(c)
        if (s instanceof PStream) parts.push(this.decodeContent(s))
      } else {
        const room = b.contentAvail() - PART_RESERVE
        if (room <= 0) {
          short = true
          break
        }
        // 暫時調高 floor：這一段的解析與解碼（都從總預算扣，解碼另外算進內容額度）最多用掉 room
        const saved = b.floor
        b.floor = Math.max(saved, b.left - room)
        try {
          const s = doc.resolve(c)
          if (s instanceof PStream) parts.push(this.decodeContent(s))
        } catch (err) {
          if (!(err instanceof PdfError) || err.code !== 'TOO_LARGE') throw err
          // 丟出來的那一步超出 floor 的部分不算，留給讀字的一定有 PART_RESERVE。那一步是解碼前預扣
          // （還沒做的工），或已經做完的一步（一次解碼的輸出最多 16 MB、最後讀的一個值、找 endstream）；
          // 每次呼叫最多一次（short 之後就不再讀下一頁）
          b.left = Math.max(b.left, b.floor)
          short = true
          break
        } finally {
          b.floor = saved
        }
      }
      if (this.budgetHit) break
    }
    if (parts.length === 0) return
    const joined = joinParts(parts, Math.floor(this.budget.contentAvail() / COST.byte))
    const gs: GState = { ctm: IDENTITY, font: null, size: 0, tc: 0, tw: 0, th: 1, tl: 0 }
    this.runContent(joined.data, joined.breaks, res, gs, 0, new Set())
    // 接起來時被截掉、或後面的段沒有收：內容額度讀不完後面的部分
    if (joined.clipped || short) this.budgetHit = true
  }

  /** 解開內容串流（頁面或 Form）：解碼做的工也從內容額度扣 */
  decodeContent(s: PStream): Buffer {
    const before = this.budget.left
    const data = this.doc.decode(s)
    if (!this.budget.chargeContent(before - this.budget.left)) this.budgetHit = true
    return data
  }

  /** 收尾一頁：排序、組字也算工 */
  endPage(): void {
    this.budget.spend(this.sink.items * COST.step)
    this.sink.endPage()
  }

  lookup(res: PDict | null, category: string, name: string): PVal {
    if (!res) return null
    const cat = this.doc.dict(res.get(category))
    return cat ? cat.get(name) : null
  }

  runContent(data: Buffer, breaks: number[] | null, res: PDict | null, start: GState, formDepth: number, formStack: Set<number>): void {
    const operands: PVal[] = []
    let gs = copyState(start)
    const stack: GState[] = []
    let overflowQ = 0
    let tm: Matrix = IDENTITY
    let tlm: Matrix = IDENTITY
    const sink = this.sink

    const translate = (tx: number, ty: number): void => {
      tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tx * tlm[0] + ty * tlm[2] + tlm[4], tx * tlm[1] + ty * tlm[3] + tlm[5]]
      tm = tlm
    }
    const nextLine = (): void => {
      translate(0, -gs.tl)
      sink.newline()
    }
    const show = (s: PVal): void => {
      if (!(s instanceof Uint8Array) || !gs.font) return
      const f = gs.font
      for (let i = 0; i < s.length; ) {
        const len = f.codeLen(s, i)
        const code = bytesToCode(s, i, len)
        i += len
        const u = f.unicode(code, len)
        if (!this.tick(COST.glyph + u.length * COST.char)) return
        const m = mul(tm, gs.ctm)
        const size = Math.abs(gs.size) * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))
        const spacing = gs.tc + (len === 1 && code === 32 ? gs.tw : 0)
        const items = sink.items
        if (!f.vertical) {
          const tx = (f.width(code) * gs.size + spacing) * gs.th
          // 字級或水平縮放是負的：字往反方向前進，書寫方向也跟著反過來（不然整段會倒序）
          const dir = gs.size * gs.th < 0 ? -1 : 1
          sink.glyph(u, m[4], m[5], tx * m[0] + m[4], tx * m[1] + m[5], dir * m[0], dir * m[1], size)
          tm = [tm[0], tm[1], tm[2], tm[3], tx * tm[0] + tm[4], tx * tm[1] + tm[5]]
        } else {
          const ty = -1 * gs.size + spacing * -1
          const dir = gs.size < 0 ? -1 : 1
          sink.glyph(u, m[4], m[5], ty * m[2] + m[4], ty * m[3] + m[5], -dir * m[2], -dir * m[3], size)
          tm = [tm[0], tm[1], tm[2], tm[3], ty * tm[2] + tm[4], ty * tm[3] + tm[5]]
        }
        // 新開的行、段會留到這頁結束：照佔的記憶體扣
        if (sink.items > items && !this.tick((sink.items - items) * COST.item)) return
        if (sink.stopped) return
      }
    }

    if (this.stopped) return
    const lx = new Lexer(data)
    lx.breaks = breaks
    let lastPos = 0
    let lastCount = 0
    try {
      while (!this.stopped) {
        // 這一個值最多讀到內容串流剩下的額度：很大的陣列讀到一半就停，不會先整個建出來
        lx.allow(this.budget.contentAvail())
        const t = parseValue(lx, 0, false)
        // 讀過的 byte 與值（含上一個運算子跳過的行內圖片）、加上運算子本身
        const cost = lx.cost(lastPos, lastCount) + (t instanceof POp ? COST.op : 0)
        lastPos = lx.pos
        lastCount = lx.count
        if (!this.tick(cost)) break
        if (t === EOF) break
        if (t === STRAY) continue
        if (!(t instanceof POp)) {
          if (operands.length < 1024) operands.push(t)
          continue
        }
        const op = t.op
        const n = operands.length
        const num = (i: number): number => {
          const v = operands[n - i]
          return isNum(v) ? v : Number.NaN
        }
        switch (op) {
          case 'q':
            if (stack.length < PDF_LIMITS.maxGraphicsStack) stack.push(copyState(gs))
            else overflowQ++
            break
          case 'Q':
            if (overflowQ > 0) overflowQ--
            else if (stack.length > 0) gs = stack.pop()!
            break
          case 'cm': {
            const m = toMatrix(operands.slice(-6))
            if (m) gs.ctm = mul(m, gs.ctm)
            break
          }
          case 'BT':
            tm = IDENTITY
            tlm = IDENTITY
            break
          case 'Tf': {
            const size = num(1)
            const name = operands[n - 2]
            if (name instanceof PName) gs.font = this.loadFont(this.lookup(res, 'Font', name.name))
            if (Number.isFinite(size)) gs.size = size
            break
          }
          case 'Tc':
            if (Number.isFinite(num(1))) gs.tc = num(1)
            break
          case 'Tw':
            if (Number.isFinite(num(1))) gs.tw = num(1)
            break
          case 'Tz':
            if (Number.isFinite(num(1))) gs.th = num(1) / 100
            break
          case 'TL':
            if (Number.isFinite(num(1))) gs.tl = num(1)
            break
          case 'Td':
          case 'TD': {
            const tx = num(2)
            const ty = num(1)
            if (Number.isFinite(tx) && Number.isFinite(ty)) {
              if (op === 'TD') gs.tl = -ty
              translate(tx, ty)
            }
            break
          }
          case 'Tm': {
            const m = toMatrix(operands.slice(-6))
            if (m) {
              tlm = m
              tm = m
            }
            break
          }
          case 'T*':
            nextLine()
            break
          case 'Tj':
            show(operands[n - 1])
            break
          case "'":
            nextLine()
            show(operands[n - 1])
            break
          case '"':
            if (Number.isFinite(num(3))) gs.tw = num(3)
            if (Number.isFinite(num(2))) gs.tc = num(2)
            nextLine()
            show(operands[n - 1])
            break
          case 'TJ': {
            const arr = operands[n - 1]
            if (!Array.isArray(arr)) break
            for (const el of arr) {
              if (el instanceof Uint8Array) show(el)
              else if (isNum(el)) {
                const d = (-el / 1000) * gs.size
                if (gs.font?.vertical) tm = [tm[0], tm[1], tm[2], tm[3], d * tm[2] + tm[4], d * tm[3] + tm[5]]
                else {
                  const tx = d * gs.th
                  tm = [tm[0], tm[1], tm[2], tm[3], tx * tm[0] + tm[4], tx * tm[1] + tm[5]]
                }
              }
              if (this.stopped) break
            }
            break
          }
          case 'Do': {
            const name = operands[n - 1]
            if (name instanceof PName) this.runForm(this.lookup(res, 'XObject', name.name), res, gs, formDepth, formStack)
            break
          }
          case 'BI':
            skipInlineImage(lx)
            break
        }
        operands.length = 0
      }
    } catch (err) {
      // 只接這一段內容串流自己讀到額度用完的情況；載入字型、CMap 時預算不夠照樣丟 TOO_LARGE
      //（pdfText 接住，回已經讀到的部分）
      if (!(err instanceof OutOfBudget) || err.lexer !== lx) throw err
      this.budget.exhaustContent()
      this.budgetHit = true
    }
  }

  runForm(ref: PVal, parentRes: PDict | null, gs: GState, depth: number, stack: Set<number>): void {
    if (depth >= PDF_LIMITS.maxFormDepth) return
    const num = ref instanceof PRef ? ref.num : -1
    if (num >= 0 && stack.has(num)) return
    const stm = this.doc.resolve(ref)
    if (!(stm instanceof PStream) || nameOf(stm.dict.get('Subtype')) !== 'Form') return
    // 每執行一次都扣（Form 的內容每次都重讀，也照讀過的 byte 扣）
    if (!this.tick(COST.object)) return
    const data = this.decodeContent(stm)
    const own = this.doc.dict(stm.dict.get('Resources'))
    const matrix = toMatrix(this.doc.resolve(stm.dict.get('Matrix'))) ?? IDENTITY
    const inner = copyState(gs)
    inner.ctm = mul(matrix, gs.ctm)
    if (num >= 0) stack.add(num)
    try {
      this.runContent(data, null, own ?? parentRes, inner, depth + 1, stack)
    } finally {
      if (num >= 0) stack.delete(num)
    }
  }

  loadFont(ref: PVal): FontInfo | null {
    if (ref instanceof PRef) {
      if (this.fontByRef.has(ref.num)) return this.fontByRef.get(ref.num) ?? null
      this.fontByRef.set(ref.num, null)
      const f = this.buildFont(this.doc.resolve(ref))
      this.fontByRef.set(ref.num, f)
      return f
    }
    if (!(ref instanceof PDict)) return null
    if (this.fontByDict.has(ref)) return this.fontByDict.get(ref) ?? null
    const f = this.buildFont(ref)
    this.fontByDict.set(ref, f)
    return f
  }

  /** 讀 CMap 串流（ToUnicode 或 Type0 內嵌的編碼 CMap）；同一個串流只解析一次 */
  loadCMap(v: PVal): CMapData | null {
    const s = this.doc.resolve(v)
    if (!(s instanceof PStream)) return null
    let cm = this.cmaps.get(s)
    if (!cm) {
      cm = parseCMap(this.doc.decode(s), this.budget)
      this.cmaps.set(s, cm)
    }
    return cm
  }

  matcherFor(ranges: CodeRange[]): CodeMatcher {
    let m = this.matchers.get(ranges)
    if (!m) {
      m = new CodeMatcher(ranges, this.budget)
      this.matchers.set(ranges, m)
    }
    return m
  }

  /** 簡單字型的 /Widths 轉成數字陣列（最多 65536 個）；同一個陣列只轉一次 */
  simpleWidthsFor(arr: PVal[]): number[] {
    let out = this.simpleWidths.get(arr)
    if (!out) {
      const n = Math.min(arr.length, 65536)
      out = new Array(n)
      for (let i = 0; i < n; i++) {
        this.budget.spend(COST.step)
        const r = this.doc.resolve(arr[i])
        out[i] = isNum(r) ? r : Number.NaN
      }
      this.simpleWidths.set(arr, out)
    }
    return out
  }

  cidWidthsFor(arr: PVal[]): Map<number, number> {
    let out = this.cidWidths.get(arr)
    if (!out) {
      out = parseCidWidths(this.doc, arr)
      this.cidWidths.set(arr, out)
    }
    return out
  }

  /** 基本編碼套上 /Differences；同一個 /Differences 陣列（配同一個基本編碼）只建一次 */
  withDifferences(base: Encoding, diffs: PVal[]): Encoding {
    let byBase = this.encodings.get(diffs)
    if (!byBase) {
      byBase = new Map()
      this.encodings.set(diffs, byBase)
    }
    let table = byBase.get(base)
    if (!table) {
      this.budget.spend(COST.table)
      table = base.slice()
      let code = 0
      for (const d of diffs) {
        this.budget.spend(COST.step)
        const x = this.doc.resolve(d)
        if (isNum(x)) code = Math.trunc(x)
        else if (x instanceof PName) {
          if (code >= 0 && code < 256) table[code] = glyphToUnicode(x.name)
          code++
        }
      }
      byBase.set(base, table)
    }
    return table
  }

  buildFont(v: PVal): FontInfo | null {
    const doc = this.doc
    if (!(v instanceof PDict)) return null
    this.budget.spend(COST.object)
    const f = new FontInfo()
    const subtype = nameOf(v.get('Subtype'))
    f.toUni = this.loadCMap(v.get('ToUnicode'))
    if (subtype === 'Type0') {
      f.simple = false
      const enc = doc.resolve(v.get('Encoding'))
      let named: Named = namedCMap('Identity-H')
      if (enc instanceof PName) named = namedCMap(enc.name)
      else if (enc instanceof PStream) {
        const cm = this.loadCMap(enc)
        const base = namedCMap(cm?.usecmap || 'Identity-H')
        const ranges = cm && cm.ranges.length > 0 ? cm.ranges : base.ranges
        named = { ranges, decode: base.decode, vertical: cm?.wmode === 1 || nameOf(enc.dict.get('WMode')) === '1' || enc.dict.get('WMode') === 1 }
      }
      f.ranges = named.ranges
      f.direct = named.decode
      f.vertical = named.vertical
      if (f.ranges.length === 0 && f.toUni && f.toUni.ranges.length > 0) f.ranges = f.toUni.ranges
      f.minLen = f.ranges.length > 0 ? Math.min(...f.ranges.map(r => r.len)) : 2
      f.matcher = this.matcherFor(f.ranges)
      const kids = doc.resolve(v.get('DescendantFonts'))
      const desc = Array.isArray(kids) ? doc.dict(kids[0]) : null
      f.defaultWidth = 1000
      if (desc) {
        const dw = doc.resolve(desc.get('DW'))
        if (isNum(dw)) f.defaultWidth = dw
        const w = doc.resolve(desc.get('W'))
        if (Array.isArray(w)) f.cidWidths = this.cidWidthsFor(w)
      }
      return f
    }
    // 簡單字型
    let base: Encoding = subtype === 'TrueType' ? WIN_ANSI : STANDARD
    const enc = doc.resolve(v.get('Encoding'))
    let diffs: PVal = null
    if (enc instanceof PName) base = namedEncoding(enc.name) ?? base
    else if (enc instanceof PDict) {
      const be = doc.resolve(enc.get('BaseEncoding'))
      if (be instanceof PName) base = namedEncoding(be.name) ?? base
      diffs = doc.resolve(enc.get('Differences'))
    }
    // 沒有 /Differences 就直接用共用的編碼表，不複製
    f.enc = Array.isArray(diffs) ? this.withDifferences(base, diffs) : base
    const fc = doc.resolve(v.get('FirstChar'))
    const widths = doc.resolve(v.get('Widths'))
    if (Array.isArray(widths)) {
      f.firstChar = isNum(fc) ? Math.trunc(fc) : 0
      f.widths = this.simpleWidthsFor(widths)
    }
    const fd = doc.dict(v.get('FontDescriptor'))
    const mw = fd ? doc.resolve(fd.get('MissingWidth')) : null
    const baseFont = nameOf(v.get('BaseFont')).replace(/^[A-Z]{6}\+/, '')
    f.defaultWidth = isNum(mw) && mw > 0 ? mw : /Courier/i.test(baseFont) ? 600 : 500
    if (subtype === 'Type3') {
      const fm = toMatrix(doc.resolve(v.get('FontMatrix')))
      if (fm && fm[0] !== 0) f.widthScale = Math.abs(fm[0])
    }
    return f
  }
}

/** CID 的最大值（規格的實作上限）；/W 裡超過的 CID 不會用到 */
const MAX_CID = 65535

/**
 * CID 字型的 /W。每一筆（含重複蓋掉的）都扣預算：
 * 上限算的是實際做的工，不是表裡有幾個不同的 CID（重複的鍵一樣要扣）。
 */
function parseCidWidths(doc: PdfDoc, w: PVal[]): Map<number, number> {
  const budget = doc.budget
  const out = new Map<number, number>()
  let i = 0
  while (i < w.length) {
    budget.spend(COST.step)
    const first = doc.resolve(w[i])
    const second = doc.resolve(w[i + 1])
    if (!isNum(first)) {
      i++
      continue
    }
    if (Array.isArray(second)) {
      for (let k = 0; k < second.length && first + k <= MAX_CID; k++) {
        budget.spend(COST.entry)
        const x = doc.resolve(second[k])
        if (isNum(x) && first + k >= 0) out.set(first + k, x)
      }
      i += 2
      continue
    }
    const width = doc.resolve(w[i + 2])
    if (isNum(second) && isNum(width) && second >= first) {
      const last = Math.min(second, MAX_CID)
      for (let c = Math.max(first, 0); c <= last; c++) {
        budget.spend(COST.entry)
        out.set(c, width)
      }
    }
    i += 3
  }
  return out
}

/**
 * 把 /Contents 的各段接成一條，最多 maxBytes 個 byte（超過的截掉，clipped）。
 * 不另外插空白：交界記在 breaks，Lexer 把交界當成空白（名稱、數字、運算子、註解在交界結束），
 * 字串可以跨段（有些產生器把字串切在兩段之間，poppler 也照讀）。
 */
function joinParts(parts: Buffer[], maxBytes: number): { data: Buffer; breaks: number[] | null; clipped: boolean } {
  if (parts.length === 1 && parts[0].length <= maxBytes) return { data: parts[0], breaks: null, clipped: false }
  const pieces: Buffer[] = []
  const breaks: number[] = []
  let total = 0
  let clipped = false
  for (const p of parts) {
    if (total > 0) breaks.push(total)
    const take = Math.min(p.length, Math.max(0, maxBytes - total))
    if (take > 0) pieces.push(take < p.length ? p.subarray(0, take) : p)
    total += take
    if (take < p.length) {
      clipped = true
      break
    }
  }
  const data = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, total)
  return { data, breaks: breaks.length > 0 ? breaks : null, clipped }
}

/** 行內圖片：讀到 ID 之後，二進位資料要跳到 EI 為止。 */
function skipInlineImage(lx: Lexer): void {
  for (let guard = 0; guard < 10_000; guard++) {
    const t = parseValue(lx, 0, false)
    if (t === EOF) return
    if (t instanceof POp && t.op === 'ID') break
  }
  const d = lx.d
  let p = lx.pos + 1
  while (p + 1 < lx.end) {
    const i = d.indexOf('EI', p, 'latin1')
    if (i < 0 || i + 1 >= lx.end) break
    const before = i === 0 || WS[d[i - 1]] === 1
    const after = i + 2 >= lx.end || WS[d[i + 2]] === 1
    if (before && after) {
      lx.pos = i + 2
      return
    }
    p = i + 1
  }
  lx.pos = lx.end
}

// ───────────────────────── 對外 API ─────────────────────────

function checkOption(v: unknown, dflt: number, name: string): number {
  if (v === undefined) return dflt
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new PdfError('BAD_OPTION', `選項 ${name} 必須是正整數`)
  return v
}

function sliceCodePoints(s: string, n: number): string {
  let count = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xdc00 && c <= 0xdfff) continue
    if (count === n) return s.slice(0, i)
    count++
  }
  return s
}

/**
 * 讀 PDF 的文字層。
 * @param buf PDF 檔案內容
 * @param opts maxPages：最多讀幾頁（預設 3）；maxChars：最多回幾個字（預設 50000，以 code point 計）
 */
export function pdfText(buf: Buffer, opts?: PdfTextOptions): PdfTextResult {
  if (!(buf instanceof Uint8Array)) throw new PdfError('NOT_PDF', '輸入不是 Buffer')
  if (opts !== undefined && (opts === null || typeof opts !== 'object')) throw new PdfError('BAD_OPTION', '選項必須是物件')
  const maxPages = checkOption(opts?.maxPages, DEFAULT_MAX_PAGES, 'maxPages')
  const maxChars = checkOption(opts?.maxChars, DEFAULT_MAX_CHARS, 'maxChars')
  if (buf.length > PDF_LIMITS.maxInputBytes) throw new PdfError('TOO_LARGE', `檔案超過 ${PDF_LIMITS.maxInputBytes} bytes`)
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  if (data.subarray(0, 1024).indexOf('%PDF-', 0, 'latin1') < 0) throw new PdfError('NOT_PDF', '開頭找不到 %PDF-，不是 PDF')
  try {
    const doc = new PdfDoc(data, new Budget(PDF_LIMITS.maxWork, PDF_LIMITS.maxContentWork))
    doc.scan()
    doc.checkEncryption()
    const cut = doc.isCut()
    const list = doc.pages(maxPages)
    if (list.first.length === 0) {
      if (!list.complete) throw new PdfError('TOO_LARGE', '頁面樹太大，還沒找到任何頁面處理額度就用完了')
      throw doc.stopError ?? new PdfError('CORRUPT', '找不到任何頁面')
    }
    // 額度在找齊要讀的頁之前就用完：讀到的不完整
    if (!list.complete && list.first.length < maxPages) doc.noteStop(new PdfError('TOO_LARGE', '頁面樹太大，沒有找齊要讀的頁'))
    const ex = new Extractor(doc, maxChars)
    let done = 0
    try {
      for (const page of list.first) {
        ex.sink.beginPage(done)
        ex.runPage(page)
        ex.endPage()
        done++
        if (ex.stopped) break
      }
    } catch (err) {
      // 處理量用完（載入字型、CMap、Form 的途中）：已經讀到的字照樣回，這一頁收到一半的也留著
      if (!(err instanceof PdfError) || err.code !== 'TOO_LARGE') throw err
      doc.noteStop(new PdfError('TOO_LARGE', err.message))
      if (ex.sink.open) ex.sink.endPage()
    }
    if (ex.budgetHit) doc.noteStop(new PdfError('TOO_LARGE', `內容串流的處理量超過上限（${PDF_LIMITS.maxContentWork} 個工作單位）`))
    let text = ex.sink.pages.join('\f')
    const hasTextLayer = /\S/u.test(text)
    // 碰到上限、一個字都沒讀到：丟碰到的那個上限（壓縮炸彈是 CORRUPT，其他是 TOO_LARGE）
    if (!hasTextLayer && doc.stopError) throw doc.stopError
    let truncated = list.count > maxPages || !list.complete || ex.stopped || done < list.first.length || doc.stopError !== null || cut
    if (countCodePoints(text) > maxChars) {
      text = sliceCodePoints(text, maxChars)
      truncated = true
    }
    if (!hasTextLayer) text = ''
    const glyphs = ex.sink.glyphs
    const unmappedGlyphs = ex.sink.unmapped
    return { text, pages: list.count, hasTextLayer, truncated, glyphs, unmappedGlyphs, unmappedRatio: glyphs > 0 ? unmappedGlyphs / glyphs : 0 }
  } catch (err) {
    if (err instanceof PdfError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new PdfError('CORRUPT', `PDF 解析失敗：${msg}`, { cause: err })
  }
}
