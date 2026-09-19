import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { constants as zlibConstants, deflateRawSync, deflateSync } from 'node:zlib'
import { PDF_LIMITS, PdfError, pdfText } from '../core/pdf-text.ts'

// ───────────────────────── 工具 ─────────────────────────

const FIX = new URL('./fixtures/pdf-text/', import.meta.url)
const fixture = name => readFileSync(new URL(name, FIX))
const golden = name => readFileSync(new URL(name, FIX), 'utf8')
/** 去掉所有空白（含換行、換頁、全形空白），用來跟 pdftotext 的標準答案比。 */
const squash = s => s.replace(/[\s　]+/gu, '')
const latin1 = s => Buffer.from(s, 'latin1')

/** 斷言丟出 PdfError 且 code 正確。 */
function throwsCode(fn, code) {
  assert.throws(fn, err => {
    assert.ok(err instanceof PdfError, `應該是 PdfError，實際是 ${err?.constructor?.name}：${err?.message}`)
    assert.equal(err.code, code, `錯誤碼應該是 ${code}，實際是 ${err.code}：${err.message}`)
    return true
  })
}

/** 結果形狀要對。 */
function assertShape(r) {
  assert.equal(typeof r.text, 'string')
  assert.ok(Number.isInteger(r.pages) && r.pages >= 0)
  assert.equal(typeof r.hasTextLayer, 'boolean')
  assert.equal(typeof r.truncated, 'boolean')
  if (!r.hasTextLayer) assert.equal(r.text, '')
}

/** 串流物件本體。dict 不含 /Length（這裡補上）。 */
function stream(dict, data, { flate = false } = {}) {
  let d = Buffer.isBuffer(data) ? data : latin1(data)
  if (flate) d = deflateSync(d)
  return Buffer.concat([
    latin1(`<< ${dict} /Length ${d.length}${flate ? ' /Filter /FlateDecode' : ''} >>\nstream\n`),
    d,
    latin1('\nendstream'),
  ])
}

/**
 * 手工組 PDF。objs 依陣列順序寫進檔案（物件編號可以任意、可以重複）。
 * xref：要不要寫 xref 表；trailer：要不要寫 trailer。
 */
function buildPdf(objs, { root = 1, xref = true, trailer = true, trailerExtra = '', header = '%PDF-1.7' } = {}) {
  const parts = [latin1(`${header}\n%\xe2\xe3\xcf\xd3\n`)]
  let off = parts[0].length
  const offsets = new Map()
  for (const [num, body] of objs) {
    const head = latin1(`${num} 0 obj\n`)
    const b = Buffer.isBuffer(body) ? body : latin1(body)
    const tail = latin1('\nendobj\n')
    offsets.set(num, off)
    parts.push(head, b, tail)
    off += head.length + b.length + tail.length
  }
  const size = Math.max(0, ...offsets.keys()) + 1
  let tail = ''
  if (xref) {
    tail += `xref\n0 ${size}\n0000000000 65535 f \n`
    for (let i = 1; i < size; i++) {
      const o = offsets.get(i)
      tail += o === undefined ? '0000000000 65535 f \n' : `${String(o).padStart(10, '0')} 00000 n \n`
    }
  }
  if (trailer) tail += `trailer\n<< /Size ${size} /Root ${root} 0 R ${trailerExtra}>>\n`
  tail += `startxref\n${xref ? off : 0}\n%%EOF\n`
  parts.push(latin1(tail))
  return Buffer.concat(parts)
}

/** 物件串流：objs 是 [[編號, 本體字串]]。pack：把本文壓成 Flate 的方式（預設 deflateSync）。 */
function objStm(num, objs, pack = null) {
  let header = ''
  let off = 0
  const bodies = []
  for (const [n, body] of objs) {
    header += `${n} ${off} `
    const b = `${body}\n`
    bodies.push(b)
    off += Buffer.byteLength(b, 'latin1')
  }
  const dict = `/Type /ObjStm /N ${objs.length} /First ${header.length}`
  const text = header + bodies.join('')
  if (pack) return [num, rawStream(`${dict} /Filter /FlateDecode`, pack(latin1(text)))]
  return [num, stream(dict, text, { flate: true })]
}

// 每個字寬 500（千分之一 em），位置好算
const W500 = `/FirstChar 0 /LastChar 255 /Widths [${Array(256).fill(500).join(' ')}]`
const FONT = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding ${W500} >>`

/** 一頁、內容串流 4、字型 F1 = 物件 5（可以換）。 */
function onePage(content, { fontObjs = [[5, FONT]], extraRes = '', extraObjs = [], flate = false, trailerExtra = '' } = {}) {
  return buildPdf([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> ${extraRes} >> /Contents 4 0 R >>`],
    [4, stream('', content, { flate })],
    ...fontObjs,
    ...extraObjs,
  ], { trailerExtra })
}

/** n 頁，每頁一行 `Page i`，Resources 從 Pages 繼承。 */
function pagesDoc(n) {
  const objs = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [3, FONT],
  ]
  const kids = []
  for (let i = 1; i <= n; i++) {
    kids.push(`${100 + 2 * i} 0 R`)
    objs.push([100 + 2 * i, `<< /Type /Page /Parent 2 0 R /Contents ${101 + 2 * i} 0 R >>`])
    objs.push([101 + 2 * i, stream('', `BT /F1 12 Tf 72 700 Td (Page ${i}) Tj ET`)])
  }
  objs.push([2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} /Resources << /Font << /F1 3 0 R >> >> >>`])
  return buildPdf(objs)
}

/** ToUnicode CMap 本文。 */
function cmap(body, codespace = '<0000> <FFFF>') {
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    codespace,
    'endcodespacerange',
    body,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n')
}

/** Type0 字型：5 = Type0、6 = CIDFont、7 = ToUnicode（可省略）。 */
function type0(toUnicode, encoding = '/Identity-H') {
  return [
    [5, `<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+Test /Encoding ${encoding} /DescendantFonts [6 0 R]${toUnicode ? ' /ToUnicode 7 0 R' : ''} >>`],
    [6, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+Test /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /CIDToGIDMap /Identity >>'],
    ...(toUnicode ? [[7, stream('', toUnicode, { flate: true })]] : []),
  ]
}

/** 量時間：fn 要在 ms 內跑完。 */
function within(ms, fn) {
  const t0 = performance.now()
  const out = fn()
  const took = performance.now() - t0
  assert.ok(took < ms, `花了 ${took.toFixed(0)} ms，超過 ${ms} ms`)
  return out
}

/**
 * 在子行程裡跑 pdfText：量 pdfText 本身花的時間與子行程的記憶體峰值（maxRSS，含 V8 heap 外面的）。
 * PDF 從 stdin 傳進去，不寫暫存檔。子行程 heap 上限 1 GB、整體 20 秒就砍掉，
 * 所以沒修好的版本會很快變紅，不會拖垮整台機器。
 *
 * 記憶體峰值用 /proc/self/status 的 VmHWM（這個行程 exec 之後自己的 RSS 峰值）。
 * Linux 的 getrusage（process.resourceUsage().maxRSS）在 exec 時會帶進父行程當時的 RSS：
 * 測試行程自己佔了 300 MB 時，子行程什麼都沒做也量到 300 MB（實測），門檻就變成在量測試行程。
 * 沒有 /proc（macOS、Windows）才退回 maxRSS。
 */
const MODULE_URL = new URL('../core/pdf-text.ts', import.meta.url).href
const CHILD = `
import { readFileSync } from 'node:fs'
const { pdfText, PdfError } = await import(process.env.PDF_TEXT_MODULE)
const peakRssMB = () => {
  try {
    const m = /VmHWM:\\s*(\\d+) kB/.exec(readFileSync('/proc/self/status', 'utf8'))
    if (m) return Number(m[1]) / 1024
  } catch {}
  return process.resourceUsage().maxRSS / 1024
}
const buf = readFileSync(0)
const opts = JSON.parse(process.env.PDF_TEXT_OPTS) ?? undefined
const t0 = performance.now()
let out
try {
  const r = pdfText(buf, opts)
  out = { ok: true, text: r.text, pages: r.pages, hasTextLayer: r.hasTextLayer, truncated: r.truncated, glyphs: r.glyphs, unmappedGlyphs: r.unmappedGlyphs, unmappedRatio: r.unmappedRatio }
} catch (err) {
  out = { ok: false, pdfError: err instanceof PdfError, code: err?.code, message: String(err?.message) }
}
out.ms = performance.now() - t0
out.maxRssMB = peakRssMB()
process.stdout.write(JSON.stringify(out))
`
function runIsolated(buf, opts, heapMB = 1024) {
  const r = spawnSync(process.execPath, [`--max-old-space-size=${heapMB}`, '--input-type=module', '-e', CHILD], {
    input: buf,
    env: { ...process.env, PDF_TEXT_MODULE: MODULE_URL, PDF_TEXT_OPTS: JSON.stringify(opts ?? null) },
    timeout: 20000,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  })
  assert.ok(!r.error, `子行程沒有跑完（${r.error?.code ?? r.error}）：超過 20 秒被砍掉`)
  assert.equal(r.status, 0, `子行程異常結束（status ${r.status}、signal ${r.signal}）：${String(r.stderr).slice(-600)}`)
  return JSON.parse(r.stdout)
}

/** 惡意輸入要在這個時間內結束（pdfText 本身，不含子行程啟動） */
const LIMIT_MS = 2000
/**
 * 子行程的記憶體峰值（maxRSS，含 V8 heap 外面的）上限。含 Node 本身與載入 .ts（約 85 MB）、
 * 輸入（檔案本身加上它的 latin1 字串，約 2 倍檔案大小）。預算的一個單位最多約 1 byte 留著的資料，
 * 但 V8 的 heap 會先長大才回收，所以把預算用完的檔 maxRSS 會到 450 MB 左右（見 PDF_LIMITS.maxWork）：
 * 那種測試另外設門檻，並用較低的 heap 上限跑，量的是留著的資料有沒有超過。
 */
const LIMIT_RSS_MB = 400

/** 子行程跑一次：時間、記憶體都要在上限內；回傳結果。heapMB：子行程的 heap 上限 */
function runBounded(buf, opts, rssLimitMB = LIMIT_RSS_MB, heapMB = 1024) {
  const out = runIsolated(buf, opts, heapMB)
  assert.ok(out.ms < LIMIT_MS, `pdfText 花了 ${out.ms.toFixed(0)} ms，超過 ${LIMIT_MS} ms`)
  assert.ok(out.maxRssMB < rssLimitMB, `記憶體峰值 ${out.maxRssMB.toFixed(0)} MB，超過 ${rssLimitMB} MB`)
  if (!out.ok) assert.ok(out.pdfError, `只能丟 PdfError，實際是：${out.message}`)
  return out
}

/** 子行程跑一次，而且要丟 TOO_LARGE。 */
function tooLarge(buf, opts, rssLimitMB) {
  const out = runBounded(buf, opts, rssLimitMB)
  assert.equal(out.ok, false, `應該丟 TOO_LARGE，實際回了結果（truncated ${out.truncated}）`)
  assert.equal(out.code, 'TOO_LARGE', `錯誤碼應該是 TOO_LARGE，實際是 ${out.code}：${out.message}`)
  return out
}

const hex = (n, width) => n.toString(16).toUpperCase().padStart(width, '0')

/** 一頁、很多個字型（/F0…）：fontBody(i) 是第 i 個字型的本體，內容串流每個字型畫一次 draw。 */
function manyFonts(n, fontBody, draw, sharedObjs = []) {
  const objs = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    ...sharedObjs,
  ]
  const fonts = []
  const content = ['BT 72 700 Td']
  for (let i = 0; i < n; i++) {
    fonts.push(`/F${i} ${1000 + i} 0 R`)
    objs.push([1000 + i, fontBody(i)])
    content.push(`/F${i} 12 Tf ${draw} Tj`)
  }
  content.push('ET')
  objs.push([3, `<< /Type /Page /Parent 2 0 R /Resources << /Font << ${fonts.join(' ')} >> >> /Contents 4 0 R >>`])
  objs.push([4, stream('', content.join('\n'), { flate: true })])
  return buildPdf(objs)
}

const CID_FONT = '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>'

/** Type0 字型（編碼用內嵌的 CMap 串流 9，沒有 ToUnicode），內容是一個很長的字串。 */
function codespaceDoc(ranges, textBytes) {
  const enc = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n${ranges.length} begincodespacerange\n${ranges.join('\n')}\nendcodespacerange\nendcmap end end`
  return buildPdf([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'],
    [4, stream('', Buffer.concat([latin1('BT /F1 12 Tf 72 700 Td ('), Buffer.alloc(textBytes, 0x41), latin1(') Tj ET')]), { flate: true })],
    [5, '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding 9 0 R /DescendantFonts [6 0 R] >>'],
    [6, CID_FONT],
    [9, stream('/Type /CMap /CMapName /Z', enc)],
  ])
}

/**
 * 一頁、/Contents 是 [9 0 R 100 0 R 101 0 R …]：9 畫 Hello，後面 n 段都是 partBody（不同的物件、同樣的本體）。
 * partBody 是完整的串流物件本體（含字典）。
 */
function partsDoc(n, partBody) {
  const objs = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents [9 0 R ${Array.from({ length: n }, (_, i) => `${100 + i} 0 R`).join(' ')}] >>`],
    [4, FONT],
    [9, stream('', 'BT /F1 12 Tf 72 700 Td (Hello) Tj ET')],
  ]
  for (let i = 0; i < n; i++) objs.push([100 + i, partBody])
  return buildPdf(objs)
}

/** 串流物件本體：data 已經編碼好，dict 放 /Filter 等（/Length 這裡補上） */
function rawStream(dict, data) {
  return Buffer.concat([latin1(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, latin1('\nendstream')])
}

/** 讓 PNG predictor 的輸出變成空的參數：一列 64 MB，比任何資料都長 */
const PRED_EMPTY = '<< /Predictor 12 /Colors 32 /BitsPerComponent 16 /Columns 1048576 >>'
const M = 1024 * 1024

/** LZW 炸彈：每一輪從 0 開始，每個新的字碼都比上一個長一個 byte（EarlyChange 1） */
function lzwBomb(rounds) {
  const out = []
  let acc = 0
  let nbits = 0
  let width = 9
  const put = code => {
    acc = acc * 2 ** width + code
    nbits += width
    while (nbits >= 8) {
      const shift = 2 ** (nbits - 8)
      const byte = Math.floor(acc / shift)
      out.push(byte)
      acc -= byte * shift
      nbits -= 8
    }
  }
  for (let r = 0; r < rounds; r++) {
    put(256)
    width = 9
    let next = 258
    put(0)
    while (next < 4096) {
      put(next)
      next++
      if (next + 1 >= 1 << width && width < 12) width++
    }
  }
  put(257)
  if (nbits > 0) out.push(acc * 2 ** (8 - nbits))
  return Buffer.from(out)
}

/** 一頁、/Contents 是幾段各自解開 sizeMB 的向量內容；第一段開頭先畫 head。 */
function bigContentsDoc(sizesMB, head) {
  const vec = '100.5 200.25 m 300.75 400.5 l S\n'
  const objs = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents [${sizesMB.map((_, i) => `${100 + i} 0 R`).join(' ')}] >>`],
    [4, FONT],
  ]
  sizesMB.forEach((mb, i) => {
    const first = i === 0 ? head : ''
    const body = first + vec.repeat(Math.floor((mb * M - first.length) / vec.length))
    objs.push([100 + i, stream('', body, { flate: true })])
  })
  return buildPdf(objs)
}

/** 跑 pdfText，只接受「正常結果」或「PdfError」。 */
function safeRun(buf, opts) {
  try {
    const r = pdfText(buf, opts)
    assertShape(r)
    return r
  } catch (err) {
    assert.ok(err instanceof PdfError, `只能丟 PdfError，實際丟了 ${err?.constructor?.name}：${err?.message}`)
    assert.equal(typeof err.code, 'string')
    return err
  }
}

// ───────────────────────── 預想表：頁面順序 ─────────────────────────

describe('pdf-text：頁面順序與頁面樹', () => {
  test('頁面物件編號倒過來：照 /Root /Pages /Kids 的順序，不照物件編號、也不照檔案位置', () => {
    const buf = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [9 0 R 8 0 R 7 0 R] /Count 3 /Resources << /Font << /F1 3 0 R >> >> >>'],
      [3, FONT],
      // 檔案裡的順序也是倒的：第三頁最先出現
      [7, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>'],
      [8, '<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>'],
      [9, '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>'],
      [4, stream('', 'BT /F1 12 Tf 72 700 Td (Page three) Tj ET')],
      [5, stream('', 'BT /F1 12 Tf 72 700 Td (Page two) Tj ET')],
      [6, stream('', 'BT /F1 12 Tf 72 700 Td (Page one) Tj ET')],
    ])
    const r = pdfText(buf)
    assert.equal(r.text, 'Page one\fPage two\fPage three')
    assert.equal(r.pages, 3)
    assert.equal(r.hasTextLayer, true)
    assert.equal(r.truncated, false)
  })

  test('頁面樹是深度優先：巢狀 Pages 的子頁排在後面兄弟之前', () => {
    const buf = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [10 0 R 20 0 R 13 0 R] /Count 4 /Resources << /Font << /F1 3 0 R >> >> >>'],
      [3, FONT],
      [20, '<< /Type /Pages /Parent 2 0 R /Kids [11 0 R 12 0 R] /Count 2 >>'],
      [10, `<< /Type /Page /Parent 2 0 R /Contents 30 0 R >>`],
      [11, `<< /Type /Page /Parent 20 0 R /Contents 31 0 R >>`],
      [12, `<< /Type /Page /Parent 20 0 R /Contents 32 0 R >>`],
      [13, `<< /Type /Page /Parent 2 0 R /Contents 33 0 R >>`],
      [30, stream('', 'BT /F1 12 Tf 72 700 Td (A) Tj ET')],
      [31, stream('', 'BT /F1 12 Tf 72 700 Td (B) Tj ET')],
      [32, stream('', 'BT /F1 12 Tf 72 700 Td (C) Tj ET')],
      [33, stream('', 'BT /F1 12 Tf 72 700 Td (D) Tj ET')],
    ])
    const r = pdfText(buf, { maxPages: 10 })
    assert.equal(r.text, 'A\fB\fC\fD')
    assert.equal(r.pages, 4)
  })

  test('/Kids 指回祖先與自己：不卡住，走過的跳過', { timeout: 5000 }, () => {
    const buf = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R 4 0 R 2 0 R] /Count 2 /Resources << /Font << /F1 9 0 R >> >> >>'],
      [3, '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>'],
      [4, '<< /Type /Pages /Parent 2 0 R /Kids [5 0 R 2 0 R 4 0 R] /Count 1 >>'],
      [5, '<< /Type /Page /Parent 4 0 R /Contents 7 0 R >>'],
      [6, stream('', 'BT /F1 12 Tf 72 700 Td (Alpha) Tj ET')],
      [7, stream('', 'BT /F1 12 Tf 72 700 Td (Beta) Tj ET')],
      [9, FONT],
    ])
    const r = within(2000, () => pdfText(buf, { maxPages: 10 }))
    assert.equal(r.text, 'Alpha\fBeta')
    assert.equal(r.pages, 2)
  })

  test('兩萬層的 Pages 鏈：不會堆疊溢位', { timeout: 10000 }, () => {
    const depth = 20000
    const objs = [
      [1, '<< /Type /Catalog /Pages 10 0 R >>'],
      [3, FONT],
      [4, stream('', 'BT /F1 12 Tf 72 700 Td (Deep) Tj ET')],
      [5, '<< /Type /Page /Contents 4 0 R /Resources << /Font << /F1 3 0 R >> >> >>'],
    ]
    for (let i = 0; i < depth; i++) {
      const kid = i === depth - 1 ? '5 0 R' : `${11 + i} 0 R`
      objs.push([10 + i, `<< /Type /Pages /Kids [${kid}] /Count 1 >>`])
    }
    const r = within(5000, () => pdfText(buildPdf(objs)))
    assert.equal(r.text, 'Deep')
    assert.equal(r.pages, 1)
  })
})

// ───────────────────────── 預想表：只讀前幾頁 ─────────────────────────

describe('pdf-text：只讀前 maxPages 頁', () => {
  test('200 頁：預設只讀前 3 頁，pages 報總頁數，truncated = true', { timeout: 10000 }, () => {
    const buf = pagesDoc(200)
    const r = pdfText(buf)
    assert.equal(r.text, 'Page 1\fPage 2\fPage 3')
    assert.equal(r.pages, 200)
    assert.equal(r.truncated, true)
  })

  test('maxPages 5 讀 5 頁；maxPages 等於總頁數就沒有截斷', () => {
    const buf = pagesDoc(6)
    assert.equal(pdfText(buf, { maxPages: 5 }).text, 'Page 1\fPage 2\fPage 3\fPage 4\fPage 5')
    const all = pdfText(buf, { maxPages: 6 })
    assert.equal(all.text.split('\f').length, 6)
    assert.equal(all.truncated, false)
  })

  test('maxChars：以字（code point）計，不切斷代理對', () => {
    const long = onePage(`BT /F1 12 Tf 72 700 Td (${'ABCDEFGHIJ'.repeat(100)}) Tj ET`)
    const r = pdfText(long, { maxChars: 50 })
    assert.equal(r.text, 'ABCDEFGHIJ'.repeat(5))
    assert.equal(r.truncated, true)

    const emoji = onePage('BT /F1 12 Tf 72 700 Td <000100010001> Tj ET', {
      fontObjs: type0(cmap('1 beginbfchar\n<0001> <D83DDE00>\nendbfchar')),
    })
    const e = pdfText(emoji, { maxChars: 2 })
    assert.equal(e.text, '😀😀')
    assert.equal(e.truncated, true)
    assert.equal(pdfText(emoji).text, '😀😀😀')
    assert.equal(pdfText(emoji).truncated, false)
  })

  test('選項不合法丟 BAD_OPTION', () => {
    const buf = onePage('BT /F1 12 Tf 72 700 Td (x) Tj ET')
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, '3']) {
      throwsCode(() => pdfText(buf, { maxPages: bad }), 'BAD_OPTION')
      throwsCode(() => pdfText(buf, { maxChars: bad }), 'BAD_OPTION')
    }
  })
})

// ───────────────────────── 預想表：ToUnicode ─────────────────────────

describe('pdf-text：ToUnicode', () => {
  test('Identity-H 2 byte 字碼：bfchar、bfrange（陣列形式與遞增形式）、UTF-16 代理對', () => {
    const toUni = cmap([
      '2 beginbfchar',
      '<0001> <4E8C>',
      '<0005> <D840DC0B>',
      'endbfchar',
      '3 beginbfrange',
      '<0010> <0013> [<8CC7> <6599> <7D50> <69CB>]',
      '<0020> <0022> <0041>',
      '<0030> <0031> <D83DDE00>',
      'endbfrange',
    ].join('\n'))
    const buf = onePage([
      'BT /F1 12 Tf 72 700 Td <001000110012001300010005> Tj',
      '0 -20 Td <002000210022> Tj',
      '0 -20 Td <00300031> Tj ET',
    ].join('\n'), { fontObjs: type0(toUni) })
    assert.equal(pdfText(buf).text, '資料結構二𠀋\nABC\n😀😁')
  })

  test('簡單字型 1 byte 的 ToUnicode（LibreOffice 的寫法）；ToUnicode 沒對到的字碼退回 /Encoding', () => {
    const toUni = cmap([
      '2 beginbfchar',
      '<01> <8CC7>',
      '<02> <6599>',
      'endbfchar',
      '1 beginbfrange',
      '<03> <04> <0061>',
      'endbfrange',
    ].join('\n'), '<00> <FF>')
    const font = `<< /Type /Font /Subtype /TrueType /BaseFont /BAAAAA+Test /Encoding /WinAnsiEncoding ${W500} /ToUnicode 6 0 R >>`
    const buf = onePage('BT /F1 12 Tf 72 700 Td <0102414203> Tj ET', {
      fontObjs: [[5, font], [6, stream('', toUni, { flate: true })]],
    })
    assert.equal(pdfText(buf).text, '資料ABa')
  })

  test('ToUnicode 對到康熙部首（⽂ U+2F42）時正規化成一般漢字', () => {
    const buf = onePage('BT /F1 12 Tf 72 700 Td <00010002> Tj ET', {
      fontObjs: type0(cmap('2 beginbfchar\n<0001> <2F42>\n<0002> <5B57>\nendbfchar')),
    })
    assert.equal(pdfText(buf).text, '文字')
  })

  test('沒有 ToUnicode 的 Type0：具名 CMap（Big5 的 ETen-B5-H、UTF-16 的 UniCNS-UTF16-H）', () => {
    const big5 = onePage('BT /F1 12 Tf 72 700 Td <4142A4A4A4E5> Tj ET', { fontObjs: type0(null, '/ETen-B5-H') })
    assert.equal(pdfText(big5).text, 'AB中文')
    const utf16 = onePage('BT /F1 12 Tf 72 700 Td <D840DC0B4E2D> Tj ET', { fontObjs: type0(null, '/UniCNS-UTF16-H') })
    assert.equal(pdfText(utf16).text, '𠀋中')
  })

  test('Identity-H 沒有 ToUnicode：解不出來就不輸出，當成沒有文字層', () => {
    const buf = onePage('BT /F1 12 Tf 72 700 Td <00010002> Tj ET', { fontObjs: type0(null) })
    const r = pdfText(buf)
    assert.equal(r.text, '')
    assert.equal(r.hasTextLayer, false)
  })

  test('直書（Identity-V）：同一欄的字不換行', () => {
    const toUni = cmap('3 beginbfchar\n<0001> <76F4>\n<0002> <66F8>\n<0003> <5B57>\nendbfchar')
    const buf = onePage('BT /F1 12 Tf 100 700 Td <000100020003> Tj ET', { fontObjs: type0(toUni, '/Identity-V') })
    assert.equal(pdfText(buf).text, '直書字')
  })
})

// ───────────────────────── 預想表：簡單字型照 /Encoding ─────────────────────────

describe('pdf-text：沒有 ToUnicode 的簡單字型', () => {
  test('WinAnsiEncoding：0x80–0x9F 與 Latin-1', () => {
    const buf = onePage('BT /F1 12 Tf 72 700 Td (caf\\351 \\223quoted\\224 \\200 5) Tj ET')
    assert.equal(pdfText(buf).text, 'café “quoted” € 5')
  })

  test('/Differences：常見字形名、uniXXXX、uXXXXX；不認得的字形名不輸出', () => {
    const font = `<< /Type /Font /Subtype /Type1 /BaseFont /Custom ${W500} /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [65 /Aring /bullet 97 /fi /uni8CC7 /u1F600 /g123] >> >>`
    const buf = onePage('BT /F1 12 Tf 72 700 Td (ABabcdZ) Tj ET', { fontObjs: [[5, font]] })
    assert.equal(pdfText(buf).text, 'Å•ﬁ資😀Z')
  })

  test('Type1 沒寫 /Encoding：用 StandardEncoding（0x27 是 ’）', () => {
    const font = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica ${W500} >>`
    const buf = onePage("BT /F1 12 Tf 72 700 Td (It's) Tj ET", { fontObjs: [[5, font]] })
    assert.equal(pdfText(buf).text, 'It’s')
  })
})

// ───────────────────────── 文字運算子與換行 ─────────────────────────

describe('pdf-text：文字運算子與換行啟發式', () => {
  const run = content => pdfText(onePage(content)).text

  test('Td 往下：換行；同一行有空隙：補空白；TJ 小的字距調整不補空白', () => {
    assert.equal(run('BT /F1 10 Tf 72 700 Td (A) Tj 0 -12 Td (B) Tj ET'), 'A\nB')
    assert.equal(run('BT /F1 10 Tf 72 700 Td (Hello) Tj 100 0 Td (World) Tj ET'), 'Hello World')
    assert.equal(run('BT /F1 10 Tf 72 700 Td [(Hel) -20 (lo)] TJ ET'), 'Hello')
    assert.equal(run('BT /F1 10 Tf 72 700 Td [(Hello) -600 (World)] TJ ET'), 'Hello World')
  })

  test('T* 一定換行（就算 TL 是 0，y 沒變）', () => {
    assert.equal(run('BT /F1 10 Tf 72 700 Td (A) Tj T* (B) Tj ET'), 'A\nB')
  })

  test("' 與 \" 換到下一行再顯示", () => {
    assert.equal(run("BT /F1 10 Tf 14 TL 72 700 Td (L1) Tj (L2) ' 1 0 (L3) \" ET"), 'L1\nL2\nL3')
  })

  test('TD 移動並設定行距；接著 T* 換行', () => {
    assert.equal(run('BT /F1 10 Tf 72 700 Td (A) Tj 0 -14 TD (B) Tj T* (C) Tj ET'), 'A\nB\nC')
  })

  test('Tm 設定絕對位置；Tm 放大字級也算', () => {
    assert.equal(run('BT /F1 10 Tf 1 0 0 1 72 700 Tm (Top) Tj 1 0 0 1 72 600 Tm (Bottom) Tj ET'), 'Top\nBottom')
    assert.equal(run('BT /F1 1 Tf 10 0 0 10 72 700 Tm (Big) Tj 10 0 0 10 72 690 Tm (Next) Tj ET'), 'Big\nNext')
  })

  test('y 座標要算上 cm（CTM）：Tm 一樣但 cm 不同就是不同行', () => {
    const content = [
      'q 1 0 0 1 0 -100 cm BT /F1 10 Tf 72 700 Td (Low) Tj ET Q',
      'BT /F1 10 Tf 72 700 Td (High) Tj ET',
    ].join('\n')
    assert.equal(run(content), 'Low\nHigh')
  })

  test('小幅上下移動（上標，少於字高一半）不換行', () => {
    assert.equal(run('BT /F1 10 Tf 72 700 Td (x) Tj 5 3 Td (2) Tj ET'), 'x2')
  })

  test('BT 之前沒有 Tf：那段字略過，不當掉', () => {
    assert.equal(run('BT 72 700 Td (nofont) Tj ET BT /F1 10 Tf 72 680 Td (ok) Tj ET'), 'ok')
  })

  test('Form XObject 裡的字也讀；自己呼叫自己不會無限遞迴', { timeout: 5000 }, () => {
    const form = stream('/Type /XObject /Subtype /Form /BBox [0 0 200 50] /Resources << /Font << /F1 5 0 R >> /XObject << /Fm1 6 0 R >> >>',
      'BT /F1 10 Tf 0 0 Td (Loop) Tj ET /Fm1 Do')
    const buf = onePage('q 1 0 0 1 72 700 cm /Fm1 Do Q', {
      extraRes: '/XObject << /Fm1 6 0 R >>',
      extraObjs: [[6, form]],
    })
    assert.equal(within(2000, () => pdfText(buf)).text, 'Loop')
  })

  test('Form XObject 指數爆炸（每層呼叫下一層 10 次、8 層）：在時間內結束', { timeout: 10000 }, () => {
    const extra = []
    const res = []
    for (let i = 0; i < 8; i++) {
      const num = 20 + i
      res.push(`/X${i} ${num} 0 R`)
      const body = i === 7 ? 'BT /F1 10 Tf 0 0 Td (X) Tj ET' : Array(10).fill(`/X${i + 1} Do`).join(' ')
      extra.push([num, stream('/Type /XObject /Subtype /Form /BBox [0 0 10 10]', body)])
    }
    const buf = onePage('/X0 Do', { extraRes: `/XObject << ${res.join(' ')} >>`, extraObjs: extra })
    within(5000, () => safeRun(buf))
  })

  test('行內圖片（BI … ID … EI）的二進位資料要跳過', () => {
    const content = Buffer.concat([
      latin1('BT /F1 10 Tf 72 700 Td (Before) Tj ET\nBI /W 4 /H 1 /BPC 8 /CS /G ID '),
      Buffer.from([0x28, 0x29, 0x28, 0x42]), // ()(B
      latin1('\nEI\nBT /F1 10 Tf 72 680 Td (After) Tj ET'),
    ])
    assert.equal(pdfText(onePage(content)).text, 'Before\nAfter')
  })

  test('內容串流裡提到 /Encrypt 不算加密', () => {
    assert.equal(run('BT /F1 10 Tf 72 700 Td (/Encrypt 5 0 R) Tj ET'), '/Encrypt 5 0 R')
  })
})

// ───────────────────────── 預想表：掃描版、加密 ─────────────────────────

describe('pdf-text：掃描版與加密', () => {
  test('只有圖片的頁面：hasTextLayer false、text 空字串', () => {
    const img = stream('/Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8', Buffer.from([0, 255]))
    const buf = onePage('q 200 0 0 100 0 0 cm /Im1 Do Q', { extraRes: '/XObject << /Im1 6 0 R >>', extraObjs: [[6, img]] })
    const r = pdfText(buf)
    assert.deepEqual(r, { text: '', pages: 1, hasTextLayer: false, truncated: false, glyphs: 0, unmappedGlyphs: 0, unmappedRatio: 0 })
  })

  test('PIL 存的掃描版 PDF：hasTextLayer false', () => {
    const r = pdfText(fixture('scan.pdf'))
    assert.equal(r.hasTextLayer, false)
    assert.equal(r.text, '')
    assert.equal(r.pages, 1)
  })

  test('trailer 有 /Encrypt：丟 ENCRYPTED', () => {
    const buf = onePage('BT /F1 10 Tf 72 700 Td (secret) Tj ET', {
      trailerExtra: '/Encrypt 9 0 R /ID [<0123456789ABCDEF0123456789ABCDEF> <0123456789ABCDEF0123456789ABCDEF>] ',
      extraObjs: [[9, '<< /Filter /Standard /V 1 /R 2 /O (xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx) /U (xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx) /P -44 >>']],
    })
    throwsCode(() => pdfText(buf), 'ENCRYPTED')
  })

  test('xref 串流的字典有 /Encrypt（沒有傳統 trailer）：丟 ENCRYPTED', () => {
    const buf = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>'],
      [4, stream('', 'BT ET')],
      [9, '<< /Filter /Standard /V 2 /R 3 /Length 128 /O <00> /U <00> /P -3904 >>'],
      [10, stream('/Type /XRef /Size 11 /W [1 2 1] /Root 1 0 R /Encrypt 9 0 R', Buffer.alloc(8))],
    ], { xref: false, trailer: false })
    throwsCode(() => pdfText(buf), 'ENCRYPTED')
  })

  test('真的加密檔（只有擁有者密碼）：丟 ENCRYPTED', () => {
    throwsCode(() => pdfText(fixture('encrypted.pdf')), 'ENCRYPTED')
  })
})

// ───────────────────────── 預想表：物件串流、不靠 xref ─────────────────────────

describe('pdf-text：找物件（/ObjStm、不靠 xref）', () => {
  const toUni = cmap('1 beginbfrange\n<0010> <0011> [<8CC7> <6599>]\nendbfrange')

  test('字型、頁面、Catalog 都在 /ObjStm 裡，而且沒有 xref、沒有 trailer', () => {
    const buf = buildPdf([
      [4, stream('', 'BT /F1 12 Tf 72 700 Td <00100011> Tj ET', { flate: true })],
      [7, stream('', toUni, { flate: true })],
      objStm(10, [
        [1, '<< /Type /Catalog /Pages 2 0 R >>'],
        [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
        [3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'],
        [5, '<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>'],
        [6, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Test /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>'],
      ]),
    ], { xref: false, trailer: false })
    assert.equal(pdfText(buf).text, '資料')
  })

  test('xref 表的位移全錯也讀得到', () => {
    const good = onePage('BT /F1 12 Tf 72 700 Td (Hello) Tj ET')
    const s = good.toString('latin1').replace(/^\d{10} 00000 n $/gm, '0000000001 00000 n ')
    assert.equal(pdfText(latin1(s)).text, 'Hello')
  })

  test('同一個物件編號出現兩次（增量更新）：用檔案裡後面那個', () => {
    const buf = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'],
      [4, stream('', 'BT /F1 12 Tf 72 700 Td (Old) Tj ET')],
      [5, FONT],
      [4, stream('', 'BT /F1 12 Tf 72 700 Td (New) Tj ET')],
    ])
    assert.equal(pdfText(buf).text, 'New')
  })

  test('/Length 錯（太長、太短、指到不存在的物件）：靠 endstream 找結尾', () => {
    const body = 'BT /F1 12 Tf 72 700 Td (Len) Tj ET'
    for (const len of ['9999', '3', '77 0 R']) {
      const buf = buildPdf([
        [1, '<< /Type /Catalog /Pages 2 0 R >>'],
        [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
        [3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'],
        [4, latin1(`<< /Length ${len} >>\nstream\n${body}\nendstream`)],
        [5, FONT],
      ])
      assert.equal(pdfText(buf).text, 'Len', `/Length ${len}`)
    }
  })

  test('其他解碼器：ASCIIHex、ASCII85、LZW、PNG predictor、串接', () => {
    const content = 'BT /F1 12 Tf 72 700 Td (Filters) Tj ET'
    const hex = Buffer.from(content, 'latin1').toString('hex') + '>'
    const cases = [
      stream('/Filter /ASCIIHexDecode', hex),
      stream('/Filter /ASCII85Decode', ascii85(Buffer.from(content, 'latin1'))),
      stream('/Filter [/ASCII85Decode /FlateDecode]', ascii85(deflateSync(Buffer.from(content, 'latin1')))),
      stream('/Filter /LZWDecode', lzw(Buffer.from(content, 'latin1'))),
      stream('/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 5 >>', deflateSync(pngUp(Buffer.from(content.padEnd(40, ' '), 'latin1'), 5))),
    ]
    for (const c of cases) {
      const buf = buildPdf([
        [1, '<< /Type /Catalog /Pages 2 0 R >>'],
        [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
        [3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'],
        [4, c],
        [5, FONT],
      ])
      assert.equal(pdfText(buf).text, 'Filters', c.subarray(0, 60).toString('latin1'))
    }
  })

  test('需要的串流用了不支援的解碼器：丟 UNSUPPORTED', () => {
    const buf = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>'],
      [4, stream('/Filter /JBIG2Decode', 'xxxx')],
    ])
    throwsCode(() => pdfText(buf), 'UNSUPPORTED')
  })
})

// ───────────────────────── 標準答案（LibreOffice／cairo／reportlab → pdftotext） ─────────────────────────

describe('pdf-text：跟 pdftotext 的標準答案比對（去掉空白後要一樣）', () => {
  test('LibreOffice 匯出的四頁繁中講義：預設讀前 3 頁', () => {
    const r = pdfText(fixture('lecture.pdf'))
    assert.equal(squash(r.text), squash(golden('lecture.p1-3.txt')))
    assert.equal(r.pages, 4)
    assert.equal(r.hasTextLayer, true)
    assert.equal(r.truncated, true)
    assert.ok(r.text.startsWith('資料結構 第三週 二元搜尋樹'), r.text.slice(0, 40))
  })

  test('LibreOffice 匯出的講義：maxPages 10 讀完全部', () => {
    const r = pdfText(fixture('lecture.pdf'), { maxPages: 10 })
    assert.equal(squash(r.text), squash(golden('lecture.all.txt')))
    assert.equal(r.truncated, false)
    assert.equal(r.text.split('\f').length, 4)
  })

  test('LibreOffice 講義把 xref 與 trailer 整段切掉：照樣讀得到（不靠 xref）', () => {
    const buf = fixture('lecture.pdf')
    const cut = buf.lastIndexOf('xref')
    assert.ok(cut > 0)
    const r = pdfText(buf.subarray(0, cut))
    assert.equal(squash(r.text), squash(golden('lecture.p1-3.txt')))
  })

  test('cairo 的 PDF（字型字典在 /ObjStm、xref 串流、Type0 Identity-H）', () => {
    const buf = fixture('cairo.pdf')
    assert.ok(buf.includes('/ObjStm'), '範例檔應該有物件串流')
    const r = pdfText(buf)
    assert.equal(squash(r.text), squash(golden('cairo.all.txt')))
    assert.equal(r.pages, 3)
    assert.equal(r.truncated, false)
  })

  test('cairo 的 PDF 把最後的 xref 串流切掉：Catalog 從物件串流裡找', () => {
    const buf = fixture('cairo.pdf')
    const at = buf.lastIndexOf('/XRef')
    assert.ok(at > 0)
    const objStart = buf.lastIndexOf(' 0 obj', at)
    const lineStart = buf.lastIndexOf('\n', objStart)
    const r = pdfText(buf.subarray(0, lineStart + 1))
    assert.equal(squash(r.text), squash(golden('cairo.all.txt')))
  })

  test('reportlab 的 PDF（不嵌入的 CID 字型、/UniCNS-UCS2-H、沒有 ToUnicode；Helvetica 沒有 /Widths）', () => {
    const r = pdfText(fixture('reportlab.pdf'))
    assert.equal(squash(r.text), squash(golden('reportlab.all.txt')))
    assert.ok(r.text.includes('Midterm: Oct. 21, Room 204'), r.text)
  })
})

// ───────────────────────── 不是 PDF、惡意輸入 ─────────────────────────

describe('pdf-text：不是 PDF 與惡意輸入', () => {
  test('不是 PDF：丟 NOT_PDF', () => {
    throwsCode(() => pdfText(Buffer.alloc(0)), 'NOT_PDF')
    throwsCode(() => pdfText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'NOT_PDF')
    throwsCode(() => pdfText(Buffer.from('hello world')), 'NOT_PDF')
    throwsCode(() => pdfText(Buffer.concat([Buffer.alloc(2000, 0x20), Buffer.from('%PDF-1.4\n')])), 'NOT_PDF')
    throwsCode(() => pdfText('%PDF-1.4'), 'NOT_PDF')
    throwsCode(() => pdfText(null), 'NOT_PDF')
  })

  test('有檔頭但找不到任何頁面：丟 CORRUPT', () => {
    throwsCode(() => pdfText(Buffer.from('%PDF-1.7\n%%EOF\n')), 'CORRUPT')
    throwsCode(() => pdfText(Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n')), 'CORRUPT')
  })

  test('PdfError 帶 code、是 Error 子類別', () => {
    try {
      pdfText(Buffer.from('nope'))
      assert.fail('應該丟錯')
    } catch (err) {
      assert.ok(err instanceof Error)
      assert.ok(err instanceof PdfError)
      assert.equal(err.name, 'PdfError')
      assert.equal(err.code, 'NOT_PDF')
    }
  })

  test('FlateDecode bomb（單一串流解壓超過上限）：丟 CORRUPT', { timeout: 20000 }, () => {
    const bomb = deflateSync(Buffer.alloc(PDF_LIMITS.maxStreamBytes + 1024 * 1024, 0x20), { level: 9 })
    assert.ok(bomb.length < 200 * 1024)
    const buf = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>'],
      [4, stream('/Filter /FlateDecode', bomb)],
    ])
    within(10000, () => throwsCode(() => pdfText(buf), 'CORRUPT'))
  })

  test('雙層 FlateDecode bomb（解開 1 GB）：解到上限就停，記憶體峰值不會跟著長', { timeout: 20000 }, () => {
    const bomb = fixture('bomb-1g.flate2')
    assert.ok(bomb.length < 4096)
    const buf = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>'],
      [4, stream('/Filter [/FlateDecode /FlateDecode]', bomb)],
    ])
    const before = process.resourceUsage().maxRSS
    within(5000, () => throwsCode(() => pdfText(buf), 'CORRUPT'))
    const grewMB = (process.resourceUsage().maxRSS - before) / 1024
    assert.ok(grewMB < 400, `記憶體峰值多了 ${grewMB.toFixed(0)} MB，表示真的去解 1 GB 了`)
  })

  test('很多個不到上限的串流加起來超過總量：丟 CORRUPT', { timeout: 30000 }, () => {
    const each = Math.floor(PDF_LIMITS.maxStreamBytes * 0.9)
    const count = Math.ceil(PDF_LIMITS.maxTotalDecodedBytes / each) + 1
    const packed = deflateSync(Buffer.alloc(each, 0x20), { level: 9 })
    const objs = [
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    ]
    const refs = []
    for (let i = 0; i < count; i++) {
      refs.push(`${10 + i} 0 R`)
      objs.push([10 + i, stream('/Filter /FlateDecode', packed)])
    }
    objs.push([3, `<< /Type /Page /Parent 2 0 R /Contents [${refs.join(' ')}] >>`])
    within(20000, () => throwsCode(() => pdfText(buildPdf(objs)), 'CORRUPT'))
  })

  test('物件串流是 bomb：丟 CORRUPT', { timeout: 20000 }, () => {
    const bomb = deflateSync(Buffer.alloc(PDF_LIMITS.maxStreamBytes + 1024 * 1024, 0x20), { level: 9 })
    const buf = buildPdf([
      [9, stream('/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode', bomb)],
    ], { xref: false, trailer: false })
    within(10000, () => throwsCode(() => pdfText(buf), 'CORRUPT'))
  })

  test('巨大的物件數：丟 TOO_LARGE，而且很快', { timeout: 20000 }, () => {
    const n = PDF_LIMITS.maxObjects + 10
    const lines = new Array(n + 1)
    lines[0] = '%PDF-1.7'
    for (let i = 1; i <= n; i++) lines[i] = `${i} 0 obj null endobj`
    const buf = Buffer.from(lines.join('\n'), 'latin1')
    within(10000, () => throwsCode(() => pdfText(buf), 'TOO_LARGE'))
  })

  test('輸入超過大小上限：丟 TOO_LARGE', () => {
    const big = Buffer.allocUnsafe(PDF_LIMITS.maxInputBytes + 1)
    big.write('%PDF-1.7\n', 0, 'latin1')
    throwsCode(() => pdfText(big), 'TOO_LARGE')
  })

  test('深層巢狀（頁面字典裡十萬層陣列）：不會堆疊溢位，頁面照讀', { timeout: 10000 }, () => {
    const deep = '['.repeat(100000) + ']'.repeat(100000)
    const buf = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Junk ${deep} >>`],
      [4, stream('', 'BT /F1 12 Tf 72 700 Td (Hello) Tj ET')],
      [5, FONT],
    ])
    const r = within(5000, () => pdfText(buf))
    assert.equal(r.text, 'Hello')
  })

  test('深層巢狀（字典十萬層、沒有收尾）：頁面壞了就丟 CORRUPT，不會堆疊溢位', { timeout: 10000 }, () => {
    const buf = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Junk ${'<< /A '.repeat(100000)}`],
      [4, stream('', 'BT ET')],
    ])
    within(5000, () => throwsCode(() => pdfText(buf), 'CORRUPT'))
  })

  test('深層巢狀（內容串流裡十萬層陣列）：前後的字都還在', { timeout: 10000 }, () => {
    const deep = '['.repeat(100000) + ']'.repeat(100000)
    const buf = onePage(`BT /F1 10 Tf 72 700 Td (Hello) Tj ET\n${deep} pop\nBT /F1 10 Tf 72 680 Td (World) Tj ET`)
    const r = within(5000, () => pdfText(buf))
    assert.equal(r.text, 'Hello\nWorld')
  })

  test('參照鏈很長（1 0 R → 2 0 R → …）：不會卡住', { timeout: 10000 }, () => {
    const objs = [
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 100 0 R >>'],
      [5, FONT],
    ]
    for (let i = 0; i < 50000; i++) objs.push([100 + i, `${101 + i} 0 R`])
    objs.push([50100, stream('', 'BT /F1 12 Tf 72 700 Td (End) Tj ET')])
    within(5000, () => safeRun(buildPdf(objs)))
  })

  test('/Length 參照自己、字型參照自己：不會無限遞迴', { timeout: 5000 }, () => {
    const buf = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'],
      [4, latin1('<< /Length 4 0 R >>\nstream\nBT /F1 12 Tf 72 700 Td (Self) Tj ET\nendstream')],
      [5, '<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /DescendantFonts 5 0 R /ToUnicode 5 0 R >>'],
    ])
    within(2000, () => safeRun(buf))
  })

  test('截斷：LibreOffice 講義在各個位置截斷，只會回結果或丟 PdfError', { timeout: 60000 }, () => {
    const buf = fixture('lecture.pdf')
    const step = Math.ceil(buf.length / 180)
    within(30000, () => {
      for (let cut = 0; cut <= buf.length; cut += step) safeRun(buf.subarray(0, cut))
    })
  })

  test('截斷在壓縮的內容串流中間：解得出多少就回多少（前面幾行完整、順序對）', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `(Line ${i}) Tj 0 -12 Td`).join('\n')
    const full = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'],
      [5, FONT],
      [4, stream('', `BT /F1 10 Tf 72 700 Td\n${lines}\nET`, { flate: true })],
    ])
    const start = full.indexOf('stream\n') + 7
    const end = full.indexOf('\nendstream')
    const r = pdfText(full.subarray(0, start + Math.floor((end - start) / 2)))
    const got = r.text.split('\n')
    assert.ok(got.length >= 5 && got.length < 400, `讀到 ${got.length} 行`)
    got.forEach((line, i) => assert.equal(line, `Line ${i}`))
    assert.equal(r.truncated, true, '檔案被截斷，讀到的不完整')
  })

  test('截斷：cairo 的 PDF（物件串流）在各個位置截斷', { timeout: 60000 }, () => {
    const buf = fixture('cairo.pdf')
    const step = Math.ceil(buf.length / 120)
    within(30000, () => {
      for (let cut = 0; cut <= buf.length; cut += step) safeRun(buf.subarray(0, cut))
    })
  })

  test('亂改位元組（固定種子）：只會回結果或丟 PdfError', { timeout: 60000 }, () => {
    const base = fixture('lecture.pdf')
    let seed = 20260919
    const rand = () => {
      seed = (seed * 1103515245 + 12345) >>> 0
      return seed / 2 ** 32
    }
    within(40000, () => {
      for (let round = 0; round < 60; round++) {
        const buf = Buffer.from(base)
        const flips = 1 + Math.floor(rand() * 20)
        for (let i = 0; i < flips; i++) buf[Math.floor(rand() * buf.length)] = Math.floor(rand() * 256)
        safeRun(buf)
      }
    })
  })
})

// ───────────────────────── 全域工作預算（稽核找到的 repro） ─────────────────────────

describe('pdf-text：工作量與記憶體都有全域上限（子行程量時間與 maxRSS）', () => {
  test('1000 個字型各帶一個很小的 ToUnicode（每個 bfrange 展開 19.6 萬筆）：不會吃光記憶體，回預算用完前讀到的字', { timeout: 30000 }, () => {
    const cm = '1 begincodespacerange <000000> <FFFFFF> endcodespacerange\n3 beginbfrange <000000> <00FFFF> <4E00> <010000> <01FFFF> <4E00> <020000> <02FFFF> <4E00> endbfrange'
    const buf = manyFonts(1000, i => `<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode ${5000 + i} 0 R >>`, '<0041>', [
      [6, CID_FONT],
      ...Array.from({ length: 1000 }, (_, i) => [5000 + i, stream('', cm, { flate: true })]),
    ])
    assert.ok(buf.length < 600 * 1024)
    // 第三輪規格：預算用完回已經讀到的部分（第二輪是整份丟 TOO_LARGE）。
    // 預算只夠載入一部分字型：讀到的字比 1000 個少，而且 truncated
    const out = runBounded(buf)
    assert.equal(out.ok, true, `${out.code}：${out.message}`)
    assert.match(out.text, /^乁+$/u)
    assert.ok(out.text.length > 0 && out.text.length < 1000, `讀到 ${out.text.length} 個字`)
    assert.equal(out.truncated, true)
  })

  test('bfrange 重複蓋同一段字碼 5 萬次（map 大小不變，實際的工一直做）：丟 TOO_LARGE', { timeout: 30000 }, () => {
    const cm = '1 begincodespacerange <0000> <FFFF> endcodespacerange\n' + ('100 beginbfrange\n' + '<0000> <FFFF> <0041>\n'.repeat(100) + 'endbfrange\n').repeat(500)
    const buf = onePage('BT /F1 12 Tf 72 700 Td <00410042> Tj ET', { fontObjs: type0(cm) })
    assert.ok(buf.length < 8 * 1024)
    tooLarge(buf)
  })

  test('CID 字型的 /W 重複 30 萬組 [0 65535 500]（放在壓縮的 /ObjStm 裡）：丟 TOO_LARGE', { timeout: 30000 }, () => {
    const w = `[${'0 65535 500 '.repeat(300000)}]`
    const buf = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'],
      [4, stream('', 'BT /F1 12 Tf 72 700 Td <00410042> Tj ET')],
      [5, '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>'],
      [7, stream('', cmap('1 beginbfchar\n<0041> <0041>\nendbfchar'), { flate: true })],
      objStm(20, [[6, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /W ${w} >>`]]),
    ])
    assert.ok(buf.length < 16 * 1024)
    tooLarge(buf)
  })

  test('/Contents 重複參照同一個解開 15 MB 的串流 200 次：不串接、記憶體有上限，回讀到的部分（truncated）', { timeout: 30000 }, () => {
    const big = Buffer.concat([latin1('% '), Buffer.alloc(15 * 1024 * 1024, 0x78), latin1('\nBT /F1 12 Tf 72 700 Td (Rep) Tj ET\n')])
    const buf = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents [${'5 0 R '.repeat(200)}] >>`],
      [4, FONT],
      [5, stream('', big, { flate: true })],
    ])
    assert.ok(buf.length < 64 * 1024)
    const out = runBounded(buf)
    assert.equal(out.ok, true, `應該回部分結果，實際丟了 ${out.code}：${out.message}`)
    assert.equal(out.truncated, true)
    // 內容額度（含解碼的 15 MB）夠讀完兩段：解碼只算一次、沒有 predictor 就不算 predictor 的工
    assert.match(out.text, /^Rep( ?Rep)+$/)
  })

  test('3000 個字型共用一個 270 KB 的 ToUnicode：只解析一次，字都對', { timeout: 30000 }, () => {
    const lines = []
    for (let i = 0; i < 20000; i += 100) {
      lines.push('100 beginbfchar')
      for (let k = i; k < i + 100; k++) lines.push(`<${hex(k, 4)}> <${hex(0x4e00 + k, 4)}>`)
      lines.push('endbfchar')
    }
    const buf = manyFonts(3000, () => '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>', '<0001>', [
      [6, CID_FONT],
      [7, stream('', cmap(lines.join('\n')), { flate: true })],
    ])
    const out = runBounded(buf)
    assert.equal(out.ok, true, `${out.code}：${out.message}`)
    assert.equal(out.text, '丁'.repeat(3000))
    assert.equal(out.truncated, false)
  })

  test('內嵌 CMap 有 256 個對不到的 4 byte codespace range、內容是 15 MB 的字串：2 秒內結束', { timeout: 30000 }, () => {
    const buf = codespaceDoc(Array(256).fill('<41414101> <41414101>'), 15 * 1024 * 1024)
    assert.ok(buf.length < 64 * 1024)
    // 第三輪規格：內容額度用完、一個字都沒讀到 → 丟 TOO_LARGE（第二輪是回 hasTextLayer: false）
    const out = tooLarge(buf)
    assert.match(out.message, /內容串流/)
  })

  test('每個字形的成本跟 codespace range 的數量無關（1 個 vs 256 個，同樣 50 萬個字形）', { timeout: 30000 }, () => {
    const one = ['<42424242> <42424242>']
    const many = [...one, ...Array.from({ length: 255 }, (_, i) => `<414141${hex(i < 0x41 ? i : i + 1, 2)}> <414141${hex(i < 0x41 ? i : i + 1, 2)}>`)]
    const bytes = 2 * 1024 * 1024
    const a = runBounded(codespaceDoc(one, bytes))
    const b = runBounded(codespaceDoc(many, bytes))
    assert.equal(a.truncated, b.truncated)
    assert.ok(b.ms < 3 * a.ms + 100, `256 個 range 花 ${b.ms.toFixed(0)} ms，1 個 range 花 ${a.ms.toFixed(0)} ms：字形成本跟 range 數量有關`)
  })

  test('/Kids 是共用的間接陣列（每個節點都指回同一個大陣列）：丟 TOO_LARGE，堆疊不會爆', { timeout: 30000 }, () => {
    const n = 50000
    const objs = [
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids 5 0 R /Count 1 >>'],
      [5, `[${Array.from({ length: n }, (_, i) => `${100 + i} 0 R`).join(' ')}]`],
    ]
    for (let i = 0; i < n; i++) objs.push([100 + i, '<< /Type /Pages /Kids 5 0 R >>'])
    tooLarge(buildPdf(objs))
  })

  test('3000 個字型共用一個 100 萬項的 /Differences：編碼表只建一次，字都對', { timeout: 30000 }, () => {
    const buf = manyFonts(3000, () => '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding 9 0 R >>', '(B)', [
      [9, `<< /Type /Encoding /Differences [0 ${'/Z '.repeat(1000000)}] >>`],
    ])
    const out = runBounded(buf)
    assert.equal(out.ok, true, `${out.code}：${out.message}`)
    assert.equal(out.text, 'Z'.repeat(3000))
  })

  test('3000 個字型共用一個 65536 項的 /Widths：字寬表只建一次，記憶體有上限', { timeout: 30000 }, () => {
    const buf = manyFonts(3000, () => '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 0 /Widths 9 0 R >>', '(A)', [
      [9, `[${'500 '.repeat(65536)}]`],
    ])
    const out = runBounded(buf)
    assert.equal(out.ok, true, `${out.code}：${out.message}`)
    assert.equal(out.text, 'A'.repeat(3000))
  })

  test('找不到頁面樹、每個 /Type /Page 物件都是沒收尾的字串或串流：丟 TOO_LARGE，不會變成 n² 卡住', { timeout: 30000 }, () => {
    for (const body of ['<< /Type /Page /X (', '<< /Type /Page >> stream x']) {
      const objs = Array.from({ length: 100000 }, (_, i) => [10 + i, body])
      const buf = Buffer.concat([buildPdf(objs, { root: 999999 }), latin1('endstream\n')])
      tooLarge(buf)
    }
  })

  test('一個物件裡塞 540 萬個空字串（巢狀陣列繞過每個陣列 100 萬項的上限）：讀到一半預算用完就停，不會先整個建出來', { timeout: 30000 }, () => {
    const inner = `[${'() '.repeat(900000)}] `
    const buf = buildPdf([[10, `<< /Type /Page /X [${inner.repeat(6)}] >>`]], { root: 999 })
    // 預算 2 億單位、每個字串算 240 單位（實測一個小 Uint8Array 約 230 byte）：最多約 83 萬個字串、190 MB，
    // 再加上 Node 本身、輸入與 GC 的空間。沒有照記憶體扣、或讀完整個物件才扣的話，會超過 1 GB 的 heap 當掉
    tooLarge(buf, undefined, 600)
  })

  test('ToUnicode 裡有一個 100 萬項的陣列：內容串流途中載入字型時預算用完，一樣丟 TOO_LARGE（不當成內容讀到一半）', { timeout: 30000 }, () => {
    const cm = `1 begincodespacerange <0000> <FFFF> endcodespacerange\n1 beginbfrange <0000> <0001> [${'<> '.repeat(1000000)}] endbfrange`
    const buf = onePage('BT /F1 12 Tf 72 700 Td <0041> Tj ET', { fontObjs: type0(cm) })
    // 陣列讀到預算用完（約 83 萬個字串）才停，記憶體上限跟上一個測試一樣放寬
    tooLarge(buf, undefined, 600)
  })

  test('30 KB 的檔畫 150 萬行（每行一個字）：每一行都留到這頁結束，照佔的記憶體扣，峰值有上限', { timeout: 30000 }, () => {
    const buf = onePage(`BT /F1 12 Tf 72 700 Td ${'(A) Tj T* '.repeat(1500000)}ET`, { flate: true })
    assert.ok(buf.length < 64 * 1024)
    const out = runBounded(buf, { maxChars: 100000000 })
    assert.equal(out.ok, true, `${out.code}：${out.message}`)
    assert.equal(out.truncated, true)
    assert.ok(out.maxRssMB < 260, `記憶體峰值 ${out.maxRssMB.toFixed(0)} MB：新開的行沒有照記憶體扣預算`)
  })

  test('正常的 PDF 用不到預算的零頭：講義讀完全部頁、cairo、reportlab 都照樣讀得到', { timeout: 30000 }, () => {
    for (const [name, opts] of [['lecture.pdf', { maxPages: 10 }], ['cairo.pdf', undefined], ['reportlab.pdf', undefined]]) {
      const out = runBounded(fixture(name), opts)
      assert.equal(out.ok, true, `${name}：${out.code} ${out.message}`)
      assert.equal(out.truncated, false, name)
      assert.ok(out.ms < 500, `${name} 花了 ${out.ms.toFixed(0)} ms`)
    }
  })
})

// ───────────────────────── 第三輪：解壓的工作量、頁面樹的記憶體、超出預算回部分結果 ─────────────────────────

describe('pdf-text：解壓的工作量照實際做的工算（第三輪 blocker）', () => {
  // 每一段解開都接近 16 MB，但留下來的輸出是 0：預算與總解壓量要照「嘗試解出的量」算，
  // 不然幾百段就能讓解壓做好幾 GB 的工而不碰任何上限。修好之後會碰到總解壓量上限：
  // 已經讀到的 Hello 照樣回，truncated 是 true
  const expectPartial = out => {
    assert.equal(out.ok, true, `應該回已經讀到的部分，實際丟了 ${out.code}：${out.message}`)
    assert.equal(out.text, 'Hello')
    assert.equal(out.truncated, true, '解壓的工作量沒有算進總解壓量上限')
  }

  test('predictor 把每段 16 MB 的輸出縮成 0（200 段）', { timeout: 30000 }, () => {
    const packed = deflateSync(Buffer.alloc(16 * M - 1), { level: 9 })
    const buf = partsDoc(200, rawStream(`/Filter /FlateDecode /DecodeParms ${PRED_EMPTY}`, packed))
    expectPartial(runBounded(buf))
  })

  test('inflate 解到快 16 MB 才遇到壞資料（200 段）：出錯前做的工也要算', { timeout: 30000 }, () => {
    const packed = Buffer.concat([
      deflateSync(Buffer.alloc(16 * M - 64 * 1024), { level: 9, finishFlush: zlibConstants.Z_SYNC_FLUSH }),
      Buffer.from([0x07, 0xff, 0xff, 0xff]),
    ])
    const buf = partsDoc(200, rawStream('/Filter /FlateDecode', packed))
    expectPartial(runBounded(buf))
  })

  test('雙層 Flate＋predictor（1000 段、340 KB 的檔）：2 秒內結束', { timeout: 30000 }, () => {
    const inner = deflateSync(Buffer.alloc(16 * M - 1), { level: 9 })
    const outer = deflateSync(inner, { level: 9 })
    const buf = partsDoc(1000, rawStream(`/Filter [/FlateDecode /FlateDecode] /DecodeParms [null ${PRED_EMPTY}]`, outer))
    assert.ok(buf.length < 512 * 1024)
    expectPartial(runBounded(buf))
  })

  test('雙層 Flate、內層解開超過 128 MB（1000 段）：超過上限的每一次嘗試（含取前段重試）都算工', { timeout: 60000 }, () => {
    // 內層取前半、前四分之一、前八分之一再解都還超過 16 MB：四次嘗試都失敗、什麼都沒留下，
    // 但每次都做了 16 MB 的工。沒算的話每段只算到外層的 126 KB，要五百段總解壓量才會滿（做 30 GB 的工）
    const inner = deflateSync(Buffer.alloc(130 * M), { level: 9 })
    const outer = deflateSync(inner, { level: 9 })
    const buf = partsDoc(1000, rawStream('/Filter [/FlateDecode /FlateDecode]', outer))
    assert.ok(buf.length < 2 * M)
    expectPartial(runBounded(buf))
  })

  test('Flate＋LZW 炸彈＋predictor（100 段）：2 秒內結束', { timeout: 30000 }, () => {
    const packed = deflateSync(lzwBomb(2), { level: 9 })
    const buf = partsDoc(100, rawStream(`/Filter [/FlateDecode /LZWDecode] /DecodeParms [null ${PRED_EMPTY}]`, packed))
    expectPartial(runBounded(buf))
  })
})

describe('pdf-text：頁面樹走訪的記憶體有上限（第三輪 confirmed）', () => {
  test('/Kids 陣列裡的直接字典又指回同一個陣列：不會一直推進堆疊', { timeout: 30000 }, () => {
    const buf = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids 5 0 R /Count 1 >>'],
      [5, '[<< /Type /Pages /Kids 5 0 R >>]'],
    ])
    assert.ok(buf.length < 1024)
    const out = runBounded(buf, undefined, 250)
    assert.equal(out.ok, false)
    assert.equal(out.code, 'CORRUPT', `沒有任何頁面，應該是 CORRUPT：${out.code} ${out.message}`)
  })

  test('50 個直接頁面字典＋指回自己的直接 Pages 節點：每個字典只走一次', { timeout: 30000 }, () => {
    const buf = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids 5 0 R /Count 50 >>'],
      [5, `[${'<< /Type /Page >> '.repeat(50)}<< /Type /Pages /Kids 5 0 R >>]`],
    ])
    const out = runBounded(buf, undefined, 250)
    assert.equal(out.ok, true, `${out.code}：${out.message}`)
    assert.equal(out.pages, 50)
    assert.equal(out.hasTextLayer, false)
  })

  test('200 個 Pages 節點共用一個有 5 萬個直接頁面字典的陣列：記憶體有上限', { timeout: 30000 }, () => {
    const objs = [
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, `<< /Type /Pages /Kids [${Array.from({ length: 200 }, (_, i) => `${100 + i} 0 R`).join(' ')}] /Count 1 >>`],
      [5, `[${'<< /Type /Page >> '.repeat(50000)}]`],
    ]
    for (let i = 0; i < 200; i++) objs.push([100 + i, '<< /Type /Pages /Kids 5 0 R >>'])
    const buf = buildPdf(objs)
    assert.ok(buf.length < 1024 * 1024)
    const out = runBounded(buf, undefined, 300)
    assert.equal(out.ok, true, `${out.code}：${out.message}`)
    assert.equal(out.pages, 50000, '同一個頁面字典只算一次')
    assert.equal(out.truncated, true)
  })
})

describe('pdf-text：超出預算時回已經讀到的部分（第三輪規格）', () => {
  test('一頁的 /Contents 分 4 段、各解開 15 MB：回開頭的字＋truncated（不是整份 TOO_LARGE）', { timeout: 30000 }, () => {
    const out = runBounded(bigContentsDoc([15, 15, 15, 15], 'BT /F1 12 Tf 72 700 Td (BigPage) Tj ET\n'))
    assert.equal(out.ok, true, `${out.code}：${out.message}`)
    assert.equal(out.text, 'BigPage')
    assert.equal(out.truncated, true)
  })

  test('一頁 17 MB 的向量內容（超過單一串流上限）：回開頭的字＋truncated（不是整份 CORRUPT）', { timeout: 30000 }, () => {
    const out = runBounded(bigContentsDoc([17], 'BT /F1 12 Tf 72 700 Td (BigPage) Tj ET\n'))
    assert.equal(out.ok, true, `${out.code}：${out.message}`)
    assert.equal(out.text, 'BigPage')
    assert.equal(out.truncated, true)
  })

  test('前兩頁正常、第 3 頁的內容解開超過單一串流上限：前面讀到的頁照樣回（不是整份 CORRUPT）', { timeout: 30000 }, () => {
    const objs = [[1, '<< /Type /Catalog /Pages 2 0 R >>'], [3, FONT]]
    const kids = []
    for (let i = 1; i <= 3; i++) {
      kids.push(`${100 + 2 * i} 0 R`)
      objs.push([100 + 2 * i, `<< /Type /Page /Parent 2 0 R /Contents ${101 + 2 * i} 0 R >>`])
      const body = i < 3 ? `BT /F1 12 Tf 72 700 Td (Page${i}) Tj ET` : Buffer.alloc(PDF_LIMITS.maxStreamBytes + M, 0x20)
      objs.push([101 + 2 * i, stream('', body, { flate: true })])
    }
    objs.push([2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count 3 /Resources << /Font << /F1 3 0 R >> >> >>`])
    const out = runBounded(buildPdf(objs))
    assert.equal(out.ok, true, `${out.code}：${out.message}`)
    assert.ok(out.text.startsWith('Page1\fPage2'), JSON.stringify(out.text))
    assert.equal(out.truncated, true)
  })

  test('10 萬頁的正常 PDF：數頁數有自己的額度，照樣讀得到前 3 頁', { timeout: 60000 }, () => {
    const n = 100000
    const pageDict = c => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /ProcSet [/PDF /Text /ImageB /ImageC /ImageI] >> /Rotate 0 /Trans << >> /Contents ${c} 0 R >>`
    const objs = [[1, '<< /Type /Catalog /Pages 2 0 R >>'], [3, FONT], [9, stream('', 'BT /F1 12 Tf 72 700 Td (Later page) Tj ET')]]
    const kids = []
    for (let i = 1; i <= n; i++) {
      kids.push(`${100 + 2 * i} 0 R`)
      objs.push([100 + 2 * i, pageDict(i <= 3 ? 101 + 2 * i : 9)])
      if (i <= 3) objs.push([101 + 2 * i, stream('', `BT /F1 12 Tf 72 700 Td (Page ${i}) Tj ET`)])
    }
    objs.push([2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`])
    const out = runBounded(buildPdf(objs))
    assert.equal(out.ok, true, `${out.code}：${out.message}`)
    assert.equal(out.text, 'Page 1\fPage 2\fPage 3')
    assert.equal(out.pages, n)
    assert.equal(out.truncated, true)
  })

  test('/Contents 各段接起來當一條串流：跨段的字串也讀得到', () => {
    const buf = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents [10 0 R 11 0 R 12 0 R] >>'],
      [4, FONT],
      [10, stream('', 'BT /F1 12 Tf 72 700 Td (Hel')],
      [11, stream('', 'lo) Tj 0 -20 Td <576F')],
      [12, stream('', '726C64> Tj ET')],
    ])
    assert.equal(pdfText(buf).text, 'Hello\nWorld')
  })

  test('/Contents 段與段的交界算空白：前一段結尾的運算子不會跟下一段黏在一起', () => {
    const buf = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents [10 0 R 11 0 R 12 0 R] >>'],
      [4, FONT],
      // 每一段結尾都沒有空白；註解沒有換行也在段的交界結束
      [10, stream('', 'BT /F1 12 Tf 72 700 Td (A) Tj')],
      [11, stream('', 'T* (B) Tj % note')],
      [12, stream('', '(C) Tj ET')],
    ])
    assert.equal(pdfText(buf).text, 'A\nBC')
  })
})

describe('pdf-text：解不出來的字形有多少（第三輪規格的訊號）', () => {
  test('一部分字解不出來：glyphs、unmappedGlyphs、unmappedRatio 照實回報', () => {
    const buf = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R /F2 7 0 R >> >> /Contents 4 0 R >>'],
      [4, stream('', 'BT /F1 12 Tf 72 700 Td (A B) Tj /F2 12 Tf <000100020003> Tj ET')],
      [5, FONT],
      [7, '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [8 0 R] >>'],
      [8, CID_FONT],
    ])
    const r = pdfText(buf)
    assert.equal(r.text, 'A B')
    assert.equal(r.hasTextLayer, true)
    assert.equal(r.glyphs, 6)
    assert.equal(r.unmappedGlyphs, 3)
    assert.equal(r.unmappedRatio, 0.5)
  })

  test('全部解得出來是 0；沒有字形也是 0（不是 NaN）', () => {
    const ok = pdfText(onePage('BT /F1 12 Tf 72 700 Td (Hello) Tj ET'))
    assert.deepEqual([ok.glyphs, ok.unmappedGlyphs, ok.unmappedRatio], [5, 0, 0])
    const empty = pdfText(onePage('0 0 m 10 10 l S'))
    assert.deepEqual([empty.glyphs, empty.unmappedGlyphs, empty.unmappedRatio], [0, 0, 0])
  })

  test('Ghostscript 重轉的中文講義（兩個字型沒有 ToUnicode）：字看起來正常，但訊號看得出少了一大半', () => {
    const gs = pdfText(fixture('ghostscript-cjk.pdf'))
    assert.equal(gs.hasTextLayer, true)
    assert.ok(gs.text.startsWith('資料結構 第三週 二元搜尋樹'), gs.text.slice(0, 40))
    assert.ok(gs.unmappedRatio > 0.3, `unmappedRatio ${gs.unmappedRatio}`)
    assert.equal(gs.unmappedRatio, gs.unmappedGlyphs / gs.glyphs)
    const lo = pdfText(fixture('lecture.pdf'))
    assert.ok(lo.glyphs > 500, `glyphs ${lo.glyphs}`)
    assert.equal(lo.unmappedGlyphs, 0, 'LibreOffice 的講義每個字都解得出來')
    for (const name of ['cairo.pdf', 'reportlab.pdf']) assert.equal(pdfText(fixture(name)).unmappedGlyphs, 0, name)
  })
})

// ───────────────────────── 第四輪 ─────────────────────────

describe('pdf-text：長度 0 的 Flate 串流不是壓縮炸彈（第四輪 confirmed）', () => {
  /** 長度 0、有 /FlateDecode 的串流物件本體（dict 放其他鍵） */
  const emptyFlate = (dict = '') => stream(`${dict} /Filter /FlateDecode`, '')
  /** 一頁；/Contents 是 contents（直接寫進頁面字典），extraObjs 另外加 */
  const page = (contents, extraObjs) => buildPdf([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents ${contents} >>`],
    [5, FONT],
    ...extraObjs,
  ])
  const NOTHING = { text: '', pages: 1, hasTextLayer: false, truncated: false, glyphs: 0, unmappedGlyphs: 0, unmappedRatio: 0 }

  test('空白頁的內容是長度 0 的 Flate：當成空的內容（沒有文字層、truncated false），不丟 CORRUPT', () => {
    assert.deepEqual(pdfText(page('4 0 R', [[4, emptyFlate()]])), NOTHING)
    // 串接時前一層解出空的、有 predictor、只有 zlib 檔頭：一樣是空的內容
    const variants = [
      ['/Filter [/FlateDecode /FlateDecode]', ''],
      ['/Filter [/ASCIIHexDecode /FlateDecode]', '>'],
      ['/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 4 >>', ''],
      ['/Filter /FlateDecode', '\x78\x9c'],
    ]
    for (const [dict, data] of variants) assert.deepEqual(pdfText(page('4 0 R', [[4, stream(dict, data)]])), NOTHING, dict)
  })

  test('空白封面（長度 0 的 Flate）加兩頁有字：三頁都讀到，truncated false', () => {
    const objs = [[1, '<< /Type /Catalog /Pages 2 0 R >>'], [3, FONT]]
    const kids = []
    for (let i = 1; i <= 3; i++) {
      kids.push(`${100 + 2 * i} 0 R`)
      objs.push([100 + 2 * i, `<< /Type /Page /Parent 2 0 R /Contents ${101 + 2 * i} 0 R >>`])
      objs.push([101 + 2 * i, i === 1 ? emptyFlate() : stream('', `BT /F1 12 Tf 72 700 Td (Page ${i}) Tj ET`, { flate: true })])
    }
    objs.push([2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count 3 /Resources << /Font << /F1 3 0 R >> >> >>`])
    const r = pdfText(buildPdf(objs))
    assert.equal(r.text, '\fPage 2\fPage 3')
    assert.equal(r.pages, 3)
    assert.equal(r.truncated, false)
  })

  test('/Contents 陣列裡有一段、Form XObject、ToUnicode 是長度 0 的 Flate：字照讀，truncated false', () => {
    const buf = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Fm1 7 0 R >> >> /Contents [4 0 R 6 0 R] >>'],
      [4, stream('', 'q /Fm1 Do Q BT /F1 12 Tf 72 700 Td (Hello) Tj ET', { flate: true })],
      // 字型有 ToUnicode，但它是空的：退回 /Encoding
      [5, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding ${W500} /ToUnicode 8 0 R >>`],
      [6, emptyFlate()],
      [7, emptyFlate('/Type /XObject /Subtype /Form /BBox [0 0 10 10]')],
      [8, emptyFlate()],
    ])
    const r = pdfText(buf)
    assert.equal(r.text, 'Hello')
    assert.equal(r.truncated, false)
  })

  test('成對：真的壓縮炸彈照舊擋（空白頁丟 CORRUPT；前面有字回字＋truncated）', { timeout: 20000 }, () => {
    const bomb = rawStream('/Filter /FlateDecode', deflateSync(Buffer.alloc(PDF_LIMITS.maxStreamBytes + M, 0x20), { level: 9 }))
    within(10000, () => throwsCode(() => pdfText(page('4 0 R', [[4, bomb]])), 'CORRUPT'))
    const r = within(10000, () => pdfText(page('[4 0 R 6 0 R]', [[4, stream('', 'BT /F1 12 Tf 72 700 Td (Hello) Tj ET')], [6, bomb]])))
    assert.equal(r.text, 'Hello')
    assert.equal(r.truncated, true)
    // 取前段重試也都超過上限、什麼都沒留下的炸彈（內層解開 1 GB）：解出來是空的，一樣是炸彈
    const empty = rawStream('/Filter [/FlateDecode /FlateDecode]', fixture('bomb-1g.flate2'))
    within(10000, () => throwsCode(() => pdfText(page('4 0 R', [[4, empty]])), 'CORRUPT'))
  })
})

describe('pdf-text：檔案被截斷（第四輪 minor）', () => {
  /** 兩頁；檔案裡最後一個物件是第 2 頁的內容串流（後面接 xref、trailer、%%EOF） */
  function twoPages(second = 'BT /F1 12 Tf 72 700 Td (Page two) Tj ET', { flate = true } = {}) {
    return buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /Resources << /Font << /F1 5 0 R >> >> >>'],
      [5, FONT],
      [3, '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>'],
      [4, '<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>'],
      [6, stream('', 'BT /F1 12 Tf 72 700 Td (Page one) Tj ET', { flate: true })],
      [7, stream('', second, { flate })],
    ])
  }

  test('截在最後一個 endstream 關鍵字中間（每一個位置）：回兩頁的字＋truncated，不丟 CORRUPT', () => {
    const full = twoPages()
    const at = full.lastIndexOf('endstream')
    for (let k = 0; k < 9; k++) {
      const r = pdfText(full.subarray(0, at + k))
      assert.equal(r.text, 'Page one\fPage two', `截在 endstream 的第 ${k} 個 byte`)
      assert.equal(r.pages, 2)
      assert.equal(r.truncated, true, `截在 endstream 的第 ${k} 個 byte：檔案不完整要標 truncated`)
    }
  })

  test('endstream 前面沒有換行、檔案截在 endstream 中間：資料照 /Length 取，最後的 Tj 不會跟截掉的關鍵字黏在一起', () => {
    const body = 'BT /F1 12 Tf 72 700 Td (Page two) Tj'
    const full = twoPages()
    const at = full.lastIndexOf('7 0 obj')
    const own = Buffer.concat([full.subarray(0, at), latin1(`7 0 obj\n<< /Length ${body.length} >>\nstream\n${body}endstream\nendobj\n`)])
    for (let k = 1; k < 9; k++) {
      const r = pdfText(own.subarray(0, own.lastIndexOf('endstream') + k))
      assert.equal(r.text, 'Page one\fPage two', `截在 endstream 的第 ${k} 個 byte`)
      assert.equal(r.truncated, true)
    }
  })

  test('截在串流資料中間、物件中間、物件與物件之間、xref 裡：回讀到的＋truncated', () => {
    const full = twoPages()
    const s = full.toString('latin1')
    const cuts = {
      串流資料中間: s.lastIndexOf('>>\nstream\n') + 15,
      物件字典中間: s.indexOf('7 0 obj') + 12,
      物件與物件之間: s.indexOf('7 0 obj'),
      xref裡: s.indexOf('xref') + 20,
    }
    for (const [where, cut] of Object.entries(cuts)) {
      const r = pdfText(full.subarray(0, cut))
      assert.ok(r.text.startsWith('Page one'), `${where}：${JSON.stringify(r.text)}`)
      assert.equal(r.truncated, true, where)
    }
  })

  test('對照：完整的檔 truncated false；%%EOF 後面還有填充（cups 的 PDF 那樣）也是 false', () => {
    const full = twoPages()
    assert.equal(pdfText(full).truncated, false)
    const padded = Buffer.concat([full, latin1('\n'), Buffer.alloc(300, 0x20), Buffer.alloc(16, 0)])
    const r = pdfText(padded)
    assert.equal(r.text, 'Page one\fPage two')
    assert.equal(r.truncated, false)
  })

  test('截斷的串流資料裡剛好有 %%EOF（內容串流的註解，1 個或 200 個）：還是算截斷', () => {
    for (const n of [1, 200]) {
      const full = twoPages(`BT /F1 12 Tf 72 700 Td (Page two) Tj ET\n${'%%EOF\n'.repeat(n)}`, { flate: false })
      const r = pdfText(full.subarray(0, full.lastIndexOf('endstream') + 4))
      assert.equal(r.text, 'Page one\fPage two')
      assert.equal(r.truncated, true, `${n} 個 %%EOF`)
    }
  })
})

describe('pdf-text：zlib 的 Adler-32 檢查碼錯（第四輪 minor）：照 poppler，解出來的內容照用', () => {
  /** 正常的 zlib 串流，只把最後一個檢查碼 byte 翻掉 */
  const badAdler = data => {
    const z = Buffer.from(deflateSync(data))
    z[z.length - 1] ^= 0xff
    return z
  }

  test('內容串流的 Adler-32 錯：字照讀', () => {
    const buf = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'],
      [4, rawStream('/Filter /FlateDecode', badAdler(latin1('BT /F1 12 Tf 72 700 Td (Bad adler text) Tj ET')))],
      [5, FONT],
    ])
    const r = pdfText(buf)
    assert.equal(r.text, 'Bad adler text')
    assert.equal(r.truncated, false)
  })

  test('物件串流與 ToUnicode 的 Adler-32 錯：物件找得到、中文解得出來', () => {
    const toUni = cmap('1 beginbfrange\n<0010> <0011> [<8CC7> <6599>]\nendbfrange')
    const buf = buildPdf([
      [4, rawStream('/Filter /FlateDecode', badAdler(latin1('BT /F1 12 Tf 72 700 Td <00100011> Tj ET')))],
      [7, rawStream('/Filter /FlateDecode', badAdler(latin1(toUni)))],
      objStm(10, [
        [1, '<< /Type /Catalog /Pages 2 0 R >>'],
        [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
        [3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'],
        [5, '<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>'],
        [6, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Test /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>'],
      ], badAdler),
    ], { xref: false, trailer: false })
    assert.equal(pdfText(buf).text, '資料')
  })

  test('成對：Adler-32 錯的壓縮炸彈照樣擋（CORRUPT）', { timeout: 20000 }, () => {
    const bomb = badAdler(Buffer.alloc(PDF_LIMITS.maxStreamBytes + M, 0x20))
    const buf = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>'],
      [4, rawStream('/Filter /FlateDecode', bomb)],
    ])
    within(10000, () => throwsCode(() => pdfText(buf), 'CORRUPT'))
  })
})

describe('pdf-text：很多個不同的小內容串流（第四輪 nit）', () => {
  /** 一頁，/Contents 是 n 個不同的串流物件，每個畫一個 B（直接組字串，不走 buildPdf：比較快） */
  function manyPartsDoc(n) {
    const out = ['%PDF-1.7\n']
    const obj = (num, body) => out.push(`${num} 0 obj\n${body}\nendobj\n`)
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
    const refs = Array.from({ length: n }, (_, i) => `${10 + i} 0 R`).join(' ')
    obj(3, `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents [9 0 R ${refs}] >>`)
    obj(4, FONT)
    obj(9, stream('', 'BT /F1 12 Tf 72 700 Td').toString('latin1'))
    for (let i = 0; i < n; i++) obj(10 + i, '<< /Length 7 >>\nstream\n(B) Tj \nendstream')
    out.push(`trailer\n<< /Size ${10 + n} /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`)
    return latin1(out.join(''))
  }

  test('40 萬段（28 MB 的檔）：解析段就會用完預算，要留額度讀字（回開頭的字＋truncated，不是 TOO_LARGE）；heap 上限 256 MB 也跑得完', { timeout: 60000 }, () => {
    const buf = manyPartsDoc(400_000)
    // 預算用完時留著的資料約 1 byte／單位，heap 上限（接進掃描器時 worker 的建議下限）256 MB 要夠；
    // maxRSS 另外含 V8 還沒回收的空間，門檻照實測（約 450 MB）放寬
    const out = runBounded(buf, undefined, 600, 256)
    assert.equal(out.ok, true, `應該回已經讀到的部分，實際丟了 ${out.code}：${out.message}`)
    assert.ok(/^B{1000,}$/.test(out.text), `讀到 ${out.text.length} 個字：${out.text.slice(0, 20)}`)
    assert.equal(out.truncated, true)
  })
})

// ───────────────────────── 第五輪 ─────────────────────────

/**
 * 一頁、/Contents 是 [9 0 R 10 0 R 11 0 R …]：9 畫 Hello（沒有 ET，後面的段接著畫在同一行），
 * 後面 n 段都是 body（完整的物件本體，latin1 字串；不同的物件、同樣的本體）。extra：其他物件 [編號, 本體]。
 * 直接組字串，不走 buildPdf（幾十萬個物件時快很多）。
 */
function leanPartsDoc(n, body, extra = []) {
  const out = ['%PDF-1.7\n']
  const obj = (num, b) => out.push(`${num} 0 obj\n${b}\nendobj\n`)
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  const refs = Array.from({ length: n }, (_, i) => `${10 + i} 0 R`).join(' ')
  obj(3, `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents [9 0 R ${refs}] >>`)
  obj(4, FONT)
  for (const [num, b] of extra) obj(num, b)
  obj(9, stream('', 'BT /F1 12 Tf 72 700 Td (Hello) Tj').toString('latin1'))
  for (let i = 0; i < n; i++) obj(10 + i, body)
  out.push(`trailer\n<< /Size ${10 + n} /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`)
  return latin1(out.join(''))
}

/** 串流物件本體（latin1 字串）：data 已經編碼好 */
const leanStream = (dict, data) => `<< ${dict} /Length ${data.length} >>\nstream\n${data.toString('latin1')}\nendstream`

/** data 用 Flate 壓 k 次（每次都有 zlib 檔頭） */
function deflateTimes(data, k) {
  let d = Buffer.from(data)
  for (let i = 0; i < k; i++) d = deflateSync(d)
  return d
}

/**
 * 子行程的記憶體峰值（maxRSS，含 V8 heap 外面的 ArrayBuffer 與 zlib 的輸出區塊）門檻：很多個小串流、
 * 把預算用完的檔，heap 上限 256 MB。這一節的檔實測 115～375 MB（最高的是 35 萬個小 Flate 串流）；
 * 沒修好的版本（Node 預設的 16 KB 輸出區塊、每次解碼沒有固定成本）是 0.68～2.7 GB。
 */
const LIMIT_RSS_MANY_MB = 450

describe('pdf-text：每呼叫一次解碼器的固定成本算進預算（第五輪 blocker）', () => {
  test('5 萬個空的小串流、每個掛 8 層 /LZW（/Filter 指到同一個陣列）：2 秒內結束，回部分結果', { timeout: 60000 }, () => {
    const buf = leanPartsDoc(50000, '<< /Filter 5 0 R >>\nstream\nendstream', [[5, `[${'/LZW '.repeat(8)}]`]])
    const out = runBounded(buf, undefined, LIMIT_RSS_MANY_MB, 256)
    assert.equal(out.ok, true, `應該回已經讀到的部分，實際丟了 ${out.code}：${out.message}`)
    assert.equal(out.text, 'Hello')
    // 解析 5 萬段只要約 3000 萬單位；40 萬次 LZW 的固定成本才會把預算用完
    assert.equal(out.truncated, true, '每一層解碼的固定成本沒有算進預算')
  })

  test('3 萬段、每段 8 層 Flate（每層都有東西可解）：24 萬次解壓的固定成本把預算用完，回部分結果', { timeout: 60000 }, () => {
    const buf = leanPartsDoc(30000, leanStream('/Filter 5 0 R', deflateTimes(latin1(' '), 8)), [[5, `[${'/Fl '.repeat(8)}]`]])
    const out = runBounded(buf, undefined, LIMIT_RSS_MANY_MB, 256)
    assert.equal(out.ok, true, `${out.code}：${out.message}`)
    assert.equal(out.text, 'Hello')
    assert.equal(out.truncated, true, '每一層解碼的固定成本沒有算進預算')
  })

  test('對照：同樣 3 萬段、沒有濾鏡：預算夠，全部讀完（truncated false）', { timeout: 60000 }, () => {
    const out = runBounded(leanPartsDoc(30000, leanStream('', latin1(' '))), undefined, LIMIT_RSS_MANY_MB, 256)
    assert.equal(out.ok, true, `${out.code}：${out.message}`)
    assert.equal(out.text, 'Hello')
    assert.equal(out.truncated, false)
  })

  test('其他解碼器（AHx、A85、RL、LZW）一層套一層、2 萬段：2 秒內結束', { timeout: 60000 }, () => {
    const one = latin1('(B) Tj ')
    // [編碼器, 層數]：AHx 每層變兩倍長，只套 4 層
    const layers = {
      AHx: [d => latin1(`${d.toString('hex')}>`), 4],
      A85: [d => latin1(ascii85(d)), 8],
      RL: [d => Buffer.concat([Buffer.from([d.length - 1]), d, Buffer.from([128])]), 8],
      LZW: [d => lzw(d), 8],
    }
    for (const [name, [enc, k]] of Object.entries(layers)) {
      let d = one
      for (let i = 0; i < k; i++) d = enc(d)
      const out = runBounded(leanPartsDoc(20000, leanStream('/Filter 5 0 R', d), [[5, `[${`/${name} `.repeat(k)}]`]]), undefined, LIMIT_RSS_MANY_MB, 256)
      assert.equal(out.ok, true, `${name}：${out.code} ${out.message}`)
      assert.ok(out.text.startsWith('HelloB'), `${name}：${out.text.slice(0, 20)}`)
      // 實測 110～170 ms。LZW 每次呼叫都重新配字碼表的話要 1.0～1.2 秒（固定成本 1500 單位對不上實際的 12 µs）
      assert.ok(out.ms < 700, `${name}：花了 ${out.ms.toFixed(0)} ms，每次呼叫的實際成本比固定成本貴很多`)
    }
  })
})

describe('pdf-text：很多個小 Flate 串流的記憶體在 heap 外面（第五輪 confirmed，用 maxRSS 量）', () => {
  test('35 萬個小 Flate 串流（27 MB 的檔）：解出的結果不佔 zlib 的 16 KB 輸出區塊', { timeout: 60000 }, () => {
    const packed = deflateRawSync(latin1('(B) Tj '))
    const buf = leanPartsDoc(350000, leanStream('/Filter /Fl', packed))
    const out = runBounded(buf, undefined, LIMIT_RSS_MANY_MB, 256)
    assert.equal(out.ok, true, `${out.code}：${out.message}`)
    assert.ok(/^HelloB{1000,}$/.test(out.text), `讀到 ${out.text.length} 個字：${out.text.slice(0, 20)}`)
    assert.equal(out.truncated, true)
  })

  test('6 萬個小 Flate 串流（4.7 MB 的檔）：每個結果不留住 zlib 的輸出區塊（檔小，看得出 heap 外多出來的）', { timeout: 60000 }, () => {
    // 實測 maxRSS 220～240 MB；輸出區塊用 Node 預設的 16 KB、結果不複製的話 350～375 MB
    //（每解一次的固定成本還在時也一樣：約 4 萬個結果各留住一塊）
    const buf = leanPartsDoc(60000, leanStream('/Filter /Fl', deflateRawSync(latin1('(B) Tj '))))
    const out = runBounded(buf, undefined, 300, 256)
    assert.equal(out.ok, true, `${out.code}：${out.message}`)
    assert.ok(/^HelloB{1000,}$/.test(out.text), `讀到 ${out.text.length} 個字：${out.text.slice(0, 20)}`)
  })

  test('LZW、RL 一開頭就是結束碼（照輸入大小配的緩衝區，解出 0 byte）：結果不留住那塊緩衝區', { timeout: 60000 }, () => {
    // 3000 段、每段 [/Fl /LZW] 或 [/Fl /RL]：Flate 解出 32 KB，後面那層一開始就結束。
    // 實測 maxRSS 135～165 MB；結果留住 64 KB 的緩衝區的話 210～230 MB
    const lzwEod = Buffer.alloc(32 * 1024)
    lzwEod[0] = 0x80 // 第一個 9 bit 字碼是 257（結束）
    lzwEod[1] = 0x80
    const rlEod = Buffer.alloc(32 * 1024)
    rlEod[0] = 128 // 第一個 byte 就是結束
    for (const [name, data] of [['LZW', lzwEod], ['RL', rlEod]]) {
      const out = runBounded(leanPartsDoc(3000, leanStream(`/Filter [/Fl /${name}]`, deflateSync(data, { level: 9 }))), undefined, 190, 256)
      assert.equal(out.ok, true, `${name}：${out.code} ${out.message}`)
      assert.equal(out.text, 'Hello', name)
    }
  })

  test('25 萬段、每段 8 層 Flate（36 MB 的檔）：2 秒內結束，記憶體有上限', { timeout: 60000 }, () => {
    const buf = leanPartsDoc(250000, leanStream('/Filter 5 0 R', deflateTimes(latin1(' '), 8)), [[5, `[${'/Fl '.repeat(8)}]`]])
    const out = runBounded(buf, undefined, LIMIT_RSS_MANY_MB, 256)
    assert.equal(out.ok, true, `${out.code}：${out.message}`)
    assert.equal(out.text, 'Hello')
    assert.equal(out.truncated, true)
  })
})

describe('pdf-text：收 /Contents 的段時預算用完，回已經收到的段（第五輪 minor）', () => {
  test('第 2 段的字典塞了 600 萬個 0（解析到一半預算就用完）：回第 1 段的字＋truncated，不是整份 TOO_LARGE', { timeout: 60000 }, () => {
    const buf = buildPdf([
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents [6 0 R 7 0 R] >>'],
      [4, FONT],
      [6, stream('', 'BT /F1 12 Tf 72 700 Td (Hello part one) Tj ET')],
      [7, `<< /Junk [${'0 '.repeat(6_000_000)}] /Length 5 >>\nstream\n(X)Tj\nendstream`],
    ])
    const out = runBounded(buf)
    assert.equal(out.ok, true, `應該回已經讀到的部分，實際丟了 ${out.code}：${out.message}`)
    assert.equal(out.text, 'Hello part one')
    assert.equal(out.truncated, true, '第 2 段沒有讀到，要標 truncated')
  })

  test('收段收到剩下的額度不多時，下一段的字典有一個 10 MB 的字串（一個值就超出很多）：保留的額度還在，回收到的段', { timeout: 60000 }, () => {
    // 前 17 段各約 1000 萬單位（20 萬個 0）；第 18 段的一個字串就是 4000 萬單位，比那時剩下的多
    const fat = leanStream(`/Junk [${'0 '.repeat(200_000)}]`, latin1('(B) Tj '))
    const huge = leanStream(`/Junk (${'x'.repeat(10 * M)})`, latin1('(Z) Tj '))
    const out = ['%PDF-1.7\n']
    const obj = (num, b) => out.push(`${num} 0 obj\n${b}\nendobj\n`)
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
    const parts = Array.from({ length: 19 }, (_, i) => `${10 + i} 0 R`).join(' ')
    obj(3, `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents [9 0 R ${parts}] >>`)
    obj(4, FONT)
    obj(9, stream('', 'BT /F1 12 Tf 72 700 Td (Hello) Tj').toString('latin1'))
    for (let i = 0; i < 17; i++) obj(10 + i, fat)
    obj(27, huge)
    obj(28, fat)
    out.push('trailer\n<< /Root 1 0 R >>\n%%EOF\n')
    const r = runBounded(latin1(out.join('')))
    assert.equal(r.ok, true, `應該回已經讀到的部分，實際丟了 ${r.code}：${r.message}`)
    assert.ok(/^HelloB+$/.test(r.text), `讀到 ${r.text.length} 個字：${r.text.slice(0, 30)}`)
    assert.equal(r.truncated, true)
  })

  test('每一段的字典都很肥：收到只剩保留的額度就停，收到的段讀得完也要標 truncated（後面還有段沒收）', { timeout: 60000 }, () => {
    const body = leanStream(`/Junk [${'0 '.repeat(50_000)}]`, latin1('(B) Tj '))
    const out = runBounded(leanPartsDoc(200, body))
    assert.equal(out.ok, true, `${out.code}：${out.message}`)
    // 每段約 240 萬單位：收到 60 段左右就停，讀字只用掉保留額度的零頭
    assert.ok(/^HelloB{10,150}$/.test(out.text), `讀到 ${out.text.length} 個字：${out.text.slice(0, 20)}`)
    assert.equal(out.truncated, true, '後面的段沒有收，要標 truncated')
  })
})

describe('pdf-text：檔案被截斷的判斷（第五輪 nit）', () => {
  const base = () => buildPdf([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'],
    [4, stream('', 'BT /F1 12 Tf 72 700 Td (Old text) Tj ET', { flate: true })],
    [5, FONT],
  ])
  /** 增量更新：把物件 4 換成 New text、加一個 /Info，後面接 xref、trailer、startxref、%%EOF */
  const update = () => {
    const obj4 = Buffer.concat([latin1('4 0 obj\n'), stream('', 'BT /F1 12 Tf 72 700 Td (New text) Tj ET', { flate: true }), latin1('\nendobj\n')])
    const obj6 = latin1('6 0 obj\n<< /Title (Updated) >>\nendobj\n')
    return { objs: Buffer.concat([obj4, obj6]), tail: latin1('xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n999\n%%EOF\n') }
  }

  test('增量更新截在新加的物件後面（舊版的 %%EOF、startxref 都在前面）：truncated true', () => {
    const { objs } = update()
    const r = pdfText(Buffer.concat([base(), objs]))
    assert.equal(r.text, 'New text')
    assert.equal(r.truncated, true, '%%EOF 要在最後一個物件後面才算完整')
  })

  test('完整、只是沒有 %%EOF（或寫成 %EOF）：truncated false', () => {
    const full = base()
    const s = full.toString('latin1')
    const noEof = latin1(s.slice(0, s.lastIndexOf('%%EOF')))
    for (const [name, buf] of [['沒有 %%EOF', noEof], ['寫成 %EOF', Buffer.concat([noEof, latin1('%EOF\n')])]]) {
      const r = pdfText(buf)
      assert.equal(r.text, 'Old text', name)
      assert.equal(r.truncated, false, `${name}：內容完整就不是截斷`)
    }
    // 增量更新完整、只是最後少了 %%EOF：一樣不是截斷
    const { objs, tail } = update()
    const t = tail.toString('latin1')
    const r = pdfText(Buffer.concat([full, objs, latin1(t.slice(0, t.lastIndexOf('%%EOF')))]))
    assert.equal(r.text, 'New text')
    assert.equal(r.truncated, false)
  })

  test('對照：增量更新完整是 false；截在新加的 xref 裡（還沒有 startxref）是 true', () => {
    const { objs, tail } = update()
    const full = base()
    assert.equal(pdfText(Buffer.concat([full, objs, tail])).truncated, false)
    const cut = pdfText(Buffer.concat([full, objs, tail.subarray(0, 20)]))
    assert.equal(cut.text, 'New text')
    assert.equal(cut.truncated, true)
  })
})

// ───────────────────────── 其他稽核發現 ─────────────────────────

describe('pdf-text：其他稽核發現', () => {
  test('字級是負的（或水平縮放是負的）：字照前進方向排，不會倒過來', { timeout: 2000 }, () => {
    assert.equal(pdfText(onePage('BT /F1 -12 Tf 72 700 Td (Neg) Tj (Size) Tj ET')).text, 'NegSize')
    assert.equal(pdfText(onePage('BT /F1 12 Tf -100 Tz 300 700 Td (Hello) Tj ET')).text, 'Hello')
    assert.equal(pdfText(onePage('BT /F1 -12 Tf 72 700 Td (Hello) Tj 0 -20 Td (World) Tj ET')).text, 'Hello\nWorld')
  })

  test('字串裡剛好有 stream 加換行（標題、註解）：後面的物件照樣找得到', { timeout: 2000 }, () => {
    for (const title of ['(Watch the live stream\ntomorrow)', '(video stream\r\nclip)']) {
      const buf = buildPdf([
        [1, '<< /Type /Catalog /Pages 2 0 R >>'],
        [9, `<< /Title ${title} >>`],
        [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
        [3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'],
        [4, stream('', 'BT /F1 12 Tf 72 700 Td (Visible text) Tj ET')],
        [5, FONT],
      ], { trailerExtra: '/Info 9 0 R ' })
      assert.equal(pdfText(buf).text, 'Visible text', JSON.stringify(title))
    }
  })

  test('Form XObject 巢狀深度上限是 8 層：更深的不執行', { timeout: 2000 }, () => {
    // 期望值寫死，不從 PDF_LIMITS 算：上限被改掉時這個測試要變紅
    const depth = 12
    const res = []
    const extra = []
    for (let k = 0; k < depth; k++) {
      res.push(`/X${k} ${20 + k} 0 R`)
      extra.push([20 + k, stream('/Type /XObject /Subtype /Form /BBox [0 0 600 800]', `BT /F1 10 Tf 72 ${700 - 12 * k} Td (L${k}) Tj ET /X${k + 1} Do`)])
    }
    const buf = onePage('/X0 Do', { extraRes: `/XObject << ${res.join(' ')} >>`, extraObjs: extra })
    assert.equal(pdfText(buf).text, 'L0\nL1\nL2\nL3\nL4\nL5\nL6\nL7')
  })
})

// ───────────────────────── 穩定性：系統內建 PDF ─────────────────────────

const CUPS = '/usr/share/cups/data'
const cupsFiles = existsSync(CUPS) ? readdirSync(CUPS).filter(f => f.endsWith('.pdf')).sort() : []

describe('pdf-text：/usr/share/cups/data 的系統 PDF 全部跑一次', () => {
  test('不當掉、不卡住、合理時間內結束', { skip: cupsFiles.length === 0 ? '這台沒有 /usr/share/cups/data' : false, timeout: 60000 }, () => {
    for (const f of cupsFiles) {
      const buf = readFileSync(join(CUPS, f))
      within(5000, () => safeRun(buf, { maxPages: 50 }))
    }
  })
})

// ───────────────────────── 測試用的編碼器 ─────────────────────────

function ascii85(buf) {
  let out = ''
  for (let i = 0; i < buf.length; i += 4) {
    const chunk = buf.subarray(i, i + 4)
    const n = chunk.length
    const b = Buffer.alloc(4)
    chunk.copy(b)
    let v = b.readUInt32BE(0)
    if (v === 0 && n === 4) {
      out += 'z'
      continue
    }
    const digits = []
    for (let k = 0; k < 5; k++) {
      digits.unshift(String.fromCharCode(33 + (v % 85)))
      v = Math.floor(v / 85)
    }
    out += digits.slice(0, n + 1).join('')
  }
  return `${out}~>`
}

/** PDF 的 LZW（EarlyChange 1）。 */
function lzw(buf) {
  const bits = []
  let width = 9
  const put = code => {
    for (let k = width - 1; k >= 0; k--) bits.push((code >> k) & 1)
  }
  let dict = new Map()
  let next = 258
  const reset = () => {
    dict = new Map()
    for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i)
    next = 258
    width = 9
  }
  reset()
  put(256)
  let w = ''
  for (const byte of buf) {
    const c = String.fromCharCode(byte)
    if (dict.has(w + c)) {
      w += c
      continue
    }
    put(dict.get(w))
    dict.set(w + c, next++)
    if (next + 1 > 1 << width && width < 12) width++
    w = c
  }
  if (w) put(dict.get(w))
  put(257)
  while (bits.length % 8) bits.push(0)
  const out = Buffer.alloc(bits.length / 8)
  for (let i = 0; i < out.length; i++) {
    let v = 0
    for (let k = 0; k < 8; k++) v = (v << 1) | bits[i * 8 + k]
    out[i] = v
  }
  return out
}

/** PNG predictor 的 Up 濾波（每列前面一個濾波位元組 2）。 */
function pngUp(raw, columns) {
  const rows = raw.length / columns
  const out = Buffer.alloc(rows * (columns + 1))
  for (let r = 0; r < rows; r++) {
    out[r * (columns + 1)] = 2
    for (let c = 0; c < columns; c++) {
      const cur = raw[r * columns + c]
      const up = r > 0 ? raw[(r - 1) * columns + c] : 0
      out[r * (columns + 1) + 1 + c] = (cur - up) & 0xff
    }
  }
  return out
}
