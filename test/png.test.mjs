// core/png.ts 的測試。期望值取自「預想-20260919-內容整理P0P1」png.ts 那一節，寫死，不可改。
// 標準答案存在 test/fixtures/png/（由 gen-fixtures.py 在開發期用 PIL 產生），測試執行時不依賴 PIL。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'
import { PngError, decodePngGray, pngSize } from '../core/png.ts'

const FIX = new URL('./fixtures/png/', import.meta.url)
const fixture = name => readFileSync(new URL(name, FIX))
const expected = JSON.parse(readFileSync(new URL('expected.json', FIX), 'utf8'))

// ---------- 測試用的 PNG 組裝工具 ----------

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type, data = Buffer.alloc(0)) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(body))
  return Buffer.concat([len, body, crc])
}

function ihdr(w, h, bd, ct, { interlace = 0, compression = 0, filter = 0 } = {}) {
  const d = Buffer.alloc(13)
  d.writeUInt32BE(w, 0)
  d.writeUInt32BE(h, 4)
  d[8] = bd
  d[9] = ct
  d[10] = compression
  d[11] = filter
  d[12] = interlace
  return chunk('IHDR', d)
}

const png = (...chunks) => Buffer.concat([SIG, ...chunks])
const idat = raw => chunk('IDAT', zlib.deflateSync(Buffer.from(raw)))
const iend = () => chunk('IEND')

/** 最簡單的圖：每列 filter 0，rows 是每列的原始 bytes（不含 filter byte）。 */
function simplePng(w, h, bd, ct, rows, extra = []) {
  const raw = Buffer.concat(rows.map(r => Buffer.from([0, ...r])))
  return png(ihdr(w, h, bd, ct), ...extra, idat(raw), iend())
}

function parseChunks(buf) {
  const out = []
  let pos = 8
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    out.push({ type, data: buf.subarray(pos + 8, pos + 8 + len), start: pos, end: pos + 12 + len })
    pos += 12 + len
  }
  return out
}

const rebuild = chs => png(...chs.map(c => chunk(c.type, c.data)))

/**
 * 組一個「解開是 mb MB 的零」的 zlib 串流，不用先配置 mb MB 的記憶體：
 * 1 MB 零用 SYNC_FLUSH 壓成不帶結尾旗標、對齊 byte 的區塊，重複接 mb 次，再接結尾區塊與 adler32。
 */
function zeroBomb(mb) {
  const block = zlib.deflateRawSync(Buffer.alloc(1 << 20), { level: 9, finishFlush: zlib.constants.Z_SYNC_FLUSH })
  const n = mb * (1 << 20)
  // 全零資料的 adler32：a = 1，b = n mod 65521
  const adler = Buffer.alloc(4)
  adler.writeUInt32BE((((n % 65521) << 16) | 1) >>> 0)
  return Buffer.concat([Buffer.from([0x78, 0xda]), ...new Array(mb).fill(block), zlib.deflateRawSync(Buffer.alloc(0)), adler])
}

/**
 * 在隔離的子行程裡解一個檔，回 { code, ms, maxRSS（KB） }。
 * Linux 的 maxRSS 會繼承 fork 當下父行程的用量（exec 之後還在），所以隔一層小行程再跑，
 * 讓量到的是解碼那個行程自己的峰值，不會被測試行程本身的大小蓋掉。
 * heapMB：限制解碼行程的 V8 heap；超過會被 V8 直接殺掉（exit 134），這裡會讓 assert 失敗並附上 stderr。
 * holdBytes：當對照組用。解碼行程讀完檔、解碼之前，自己多配一塊這麼大的 buffer 並寫滿（每一頁都真的佔記憶體），
 * 解碼期間一直留著。用來確認量法看得到「多一份」，不必靠實作剛好會複製。
 */
function runIsolated(file, { heapMB, holdBytes = 0 } = {}) {
  const modUrl = new URL('../core/png.ts', import.meta.url).href
  const script = `
    import { readFileSync } from 'node:fs'
    import { decodePngGray } from ${JSON.stringify(modUrl)}
    const buf = readFileSync(process.env.PNG_FILE)
    const holdBytes = Number(process.env.HOLD_BYTES)
    const hold = holdBytes > 0 ? Buffer.alloc(holdBytes, 0xa5) : null
    const t0 = performance.now()
    let code = 'OK'
    try { decodePngGray(buf) } catch (e) { code = e.code ?? String(e) }
    const ms = performance.now() - t0
    console.log(JSON.stringify({ code, ms, maxRSS: process.resourceUsage().maxRSS, held: hold?.length ?? 0 }))
  `
  const launcher = `
    import { spawnSync } from 'node:child_process'
    const args = JSON.parse(process.env.DECODE_NODE_ARGS)
    const r = spawnSync(process.execPath, [...args, '--input-type=module', '-e', process.env.DECODE_SCRIPT], { env: process.env, encoding: 'utf8' })
    process.stdout.write(r.stdout ?? '')
    process.stderr.write(r.stderr ?? '')
    if (r.signal) process.stderr.write('解碼行程被訊號 ' + r.signal + ' 終止')
    process.exitCode = r.status ?? 1
  `
  const nodeArgs = heapMB ? [`--max-old-space-size=${heapMB}`] : []
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', launcher], {
    env: { ...process.env, PNG_FILE: file, DECODE_SCRIPT: script, DECODE_NODE_ARGS: JSON.stringify(nodeArgs), HOLD_BYTES: String(holdBytes) },
    encoding: 'utf8', timeout: 50_000,
  })
  const why = String(r.stderr).split('\n').filter(l => /FATAL|訊號|Error/.test(l)).slice(0, 3).join('／')
  assert.equal(r.status, 0, `解碼行程沒有正常結束（exit ${r.status}）：${why}`)
  return JSON.parse(r.stdout.trim().split('\n').pop())
}

function throwsPng(fn, codes, msg) {
  const list = Array.isArray(codes) ? codes : [codes]
  assert.throws(fn, err => {
    assert.ok(err instanceof PngError, `${msg ?? ''} 應該丟 PngError，實際：${err?.name}: ${err?.message}`)
    assert.ok(list.includes(err.code), `${msg ?? ''} code 應該是 ${list.join('／')}，實際是 ${err.code}（${err.message}）`)
    return true
  })
}

const gray = buf => Array.from(decodePngGray(buf).gray)
const maxDiff = (a, b) => {
  assert.equal(a.length, b.length)
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]))
  return m
}

// ---------- 預想表：每一列一個測試 ----------

describe('預想表 png.ts', () => {
  test('灰階四捨五入：純綠 (0,255,0) → 150；純紅 (255,0,0) → 76', () => {
    assert.deepEqual(gray(simplePng(1, 1, 8, 2, [[0, 255, 0]])), [150])
    assert.deepEqual(gray(simplePng(1, 1, 8, 2, [[255, 0, 0]])), [76])
    assert.deepEqual(gray(fixture('one-pixel-green.png')), [150])
    // 同一條公式：(299R+587G+114B+500)/1000 取整
    assert.deepEqual(gray(simplePng(3, 1, 8, 2, [[0, 0, 255, 255, 255, 255, 1, 2, 3]])), [29, 255, 2])
  })

  test('透明度疊白底：(0,0,0,α=0) → 255；(0,0,0,α=255) → 0', () => {
    assert.deepEqual(gray(simplePng(1, 1, 8, 6, [[0, 0, 0, 0]])), [255])
    assert.deepEqual(gray(simplePng(1, 1, 8, 6, [[0, 0, 0, 255]])), [0])
    // 灰階＋alpha 同一個規則
    assert.deepEqual(gray(simplePng(2, 1, 8, 4, [[0, 0, 0, 255]])), [255, 0])
    // 半透明黑疊白：255 × (255−128)/255 = 127
    assert.deepEqual(gray(simplePng(1, 1, 8, 6, [[0, 0, 0, 128]])), [127])
  })

  test('16 位元取高位元組：0x80FF → 128', () => {
    assert.deepEqual(gray(simplePng(1, 1, 16, 0, [[0x80, 0xff]])), [128])
    assert.deepEqual(gray(simplePng(1, 1, 16, 2, [[0x80, 0xff, 0x80, 0xff, 0x80, 0xff]])), [128])
    // 0x80FF 除以 257 四捨五入也是 128、分辨不出來；補能分辨的值：
    // 0xFF00：高位元組 255，÷257 = 254.0；0x01FF：高位元組 1，÷257 ≈ 1.99；0x8000：高位元組 128，÷257 ≈ 127.5
    assert.deepEqual(gray(simplePng(3, 1, 16, 0, [[0xff, 0x00, 0x01, 0xff, 0x80, 0x00]])), [255, 1, 128])
  })

  test('調色盤套用 tRNS：索引 0 = 黑、tRNS[0]=0 → 255', () => {
    const plte = chunk('PLTE', Buffer.from([0, 0, 0]))
    const trns = chunk('tRNS', Buffer.from([0]))
    assert.deepEqual(gray(simplePng(1, 1, 8, 3, [[0]], [plte, trns])), [255])
    // 同一張圖沒有 tRNS → 黑色 0
    assert.deepEqual(gray(simplePng(1, 1, 8, 3, [[0]], [plte])), [0])
    // fixture：索引 0 黑且透明、索引 1 黑且不透明
    assert.deepEqual(gray(fixture('ct3-d1-trns-black.png')), [255, 0, 255, 0, 0, 255, 0, 255])
  })

  test('交錯式（Adam7）→ 丟 INTERLACED', () => {
    for (const { file, width, height } of expected.interlaced) {
      const buf = fixture(file)
      throwsPng(() => decodePngGray(buf), 'INTERLACED', file)
      // 尺寸還是讀得出來
      assert.deepEqual(pngSize(buf), { width, height })
    }
  })

  test('截斷：IDAT 只有一半 → TRUNCATED 或 CORRUPT，絕不回半張圖', () => {
    const buf = fixture('chromium-1280x860.png')
    // （a）檔案直接砍一半
    throwsPng(() => decodePngGray(buf.subarray(0, buf.length >> 1)), 'TRUNCATED')
    // （b）chunk 結構完整、CRC 正確，但 zlib 資料只有一半
    const chs = parseChunks(buf)
    const all = Buffer.concat(chs.filter(c => c.type === 'IDAT').map(c => c.data))
    const half = all.subarray(0, all.length >> 1)
    const rebuilt = png(chunk('IHDR', chs[0].data), chunk('IDAT', half), iend())
    throwsPng(() => decodePngGray(rebuilt), ['TRUNCATED', 'CORRUPT'])
    // （c）zlib 串流本身完整，但解開只有一半的列
    const small = fixture('ct2-d8.png')
    const sc = parseChunks(small)
    const raw = zlib.inflateSync(Buffer.concat(sc.filter(c => c.type === 'IDAT').map(c => c.data)))
    const halfRows = png(chunk('IHDR', sc[0].data), idat(raw.subarray(0, raw.length >> 1)), iend())
    throwsPng(() => decodePngGray(halfRows), ['TRUNCATED', 'CORRUPT'])
  })

  test('截斷：任何前綴都丟錯，沒有一個會回傳結果', () => {
    for (const name of ['ct0-d1.png', 'ct3-d4-trns.png', 'ct6-d8-split-idat.png']) {
      const buf = fixture(name)
      assert.ok(decodePngGray(buf).gray.length > 0)
      for (let n = 0; n < buf.length; n++) {
        throwsPng(() => decodePngGray(buf.subarray(0, n)), ['TRUNCATED', 'CORRUPT', 'NOT_PNG'], `${name} 前 ${n} bytes`)
      }
    }
  })

  test('解壓設上限：小 IDAT 解開很大 → CORRUPT', () => {
    // 炸彈串流本身是合法的 zlib（用小一點的版本完整解開驗證）
    const small = zlib.inflateSync(zeroBomb(3))
    assert.equal(small.length, 3 << 20)
    assert.ok(small.every(v => v === 0))
    // 16×16 灰階應有 16×17 = 272 bytes；塞 64 MB 的零
    const bomb = png(ihdr(16, 16, 8, 0), chunk('IDAT', zeroBomb(64)), iend())
    assert.ok(bomb.length < 100_000, `炸彈檔 ${bomb.length} bytes`)
    throwsPng(() => decodePngGray(bomb), 'CORRUPT')
    // 上限 = 應有大小 + 1：多 1 byte 也要擋
    const exactPlus1 = png(ihdr(16, 16, 8, 0), idat(Buffer.alloc(273)), iend())
    throwsPng(() => decodePngGray(exactPlus1), 'CORRUPT')
    // 剛好應有大小 → 正常
    assert.equal(decodePngGray(png(ihdr(16, 16, 8, 0), idat(Buffer.alloc(272)), iend())).gray.length, 256)
  })

  test('解壓設上限：炸彈不會真的解開（子行程量最大記憶體）', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'png-bomb-'))
    try {
      const bombFile = join(dir, 'bomb.png')
      const okFile = join(dir, 'ok.png')
      writeFileSync(bombFile, png(ihdr(16, 16, 8, 0), chunk('IDAT', zeroBomb(256)), iend()))
      writeFileSync(okFile, fixture('ct0-d8.png'))
      const run = file => runIsolated(file)
      const base = run(okFile)
      const bomb = run(bombFile)
      assert.equal(base.code, 'OK')
      assert.equal(bomb.code, 'CORRUPT')
      // maxRSS 單位是 KB。沒設上限會多吃 256 MB 以上；有上限應該跟正常小圖差不多
      const extraMB = (bomb.maxRSS - base.maxRSS) / 1024
      assert.ok(extraMB < 48, `炸彈多吃了 ${extraMB.toFixed(1)} MB，解壓沒有設上限`)
      // 宣稱 8000×5000 灰階（應有 40 MB）的炸彈：最多只能多用「一份」應有大小，不能是兩份
      const bomb40File = join(dir, 'bomb40.png')
      writeFileSync(bomb40File, png(ihdr(8000, 5000, 8, 0), chunk('IDAT', zeroBomb(256)), iend()))
      const bomb40 = run(bomb40File)
      assert.equal(bomb40.code, 'CORRUPT')
      const extra40MB = (bomb40.maxRSS - base.maxRSS) / 1024
      assert.ok(extra40MB < 60, `應有 40 MB 的炸彈多吃了 ${extra40MB.toFixed(1)} MB（超過一份應有大小）`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('先檢查尺寸再解壓：宣稱 100000×100000 → TOO_LARGE（解壓之前）', () => {
    // IDAT 是垃圾：如果先解壓就會變成 CORRUPT，而不是 TOO_LARGE
    const garbage = chunk('IDAT', Buffer.from('this is not zlib at all'))
    throwsPng(() => decodePngGray(png(ihdr(100000, 100000, 8, 2), garbage, iend())), 'TOO_LARGE')
    // 只有 IHDR、後面什麼都沒有：也是 TOO_LARGE（沒讀到後面就拒絕）
    throwsPng(() => decodePngGray(png(ihdr(100000, 100000, 8, 6))), 'TOO_LARGE')
    // pngSize 只回報尺寸，不判斷太大
    assert.deepEqual(pngSize(png(ihdr(100000, 100000, 8, 2), garbage, iend())), { width: 100000, height: 100000 })
  })

  test('預設上限 4000 萬像素；maxPixels 可調，邊界含等於', () => {
    const garbage = chunk('IDAT', Buffer.from('not zlib'))
    // 剛好 4000 萬：通過尺寸檢查，接著因為垃圾資料而 CORRUPT
    throwsPng(() => decodePngGray(png(ihdr(40_000_000, 1, 8, 0), garbage, iend())), 'CORRUPT')
    throwsPng(() => decodePngGray(png(ihdr(8000, 5000, 8, 0), garbage, iend())), 'CORRUPT')
    // 多 1 像素：TOO_LARGE
    throwsPng(() => decodePngGray(png(ihdr(40_000_001, 1, 8, 0), garbage, iend())), 'TOO_LARGE')
    const ok = simplePng(10, 10, 8, 0, Array.from({ length: 10 }, () => new Array(10).fill(7)))
    assert.equal(decodePngGray(ok, { maxPixels: 100 }).gray.length, 100)
    throwsPng(() => decodePngGray(ok, { maxPixels: 99 }), 'TOO_LARGE')
  })

  test('不認得的關鍵 chunk → UNSUPPORTED；不認得的輔助 chunk 略過', () => {
    const base = simplePng(2, 1, 8, 0, [[10, 20]])
    const chs = parseChunks(base)
    const withCritical = rebuild([chs[0], { type: 'ZZZZ', data: Buffer.from('x') }, ...chs.slice(1)])
    throwsPng(() => decodePngGray(withCritical), 'UNSUPPORTED')
    // IDAT 之後才出現也一樣
    const late = rebuild([...chs.slice(0, 2), { type: 'QUUX', data: Buffer.alloc(0) }, chs[2]])
    throwsPng(() => decodePngGray(late), 'UNSUPPORTED')
    // Apple 的 CgBI（第一個 chunk 就不是 IHDR）
    throwsPng(() => decodePngGray(rebuild([{ type: 'CgBI', data: Buffer.alloc(4) }, ...chs])), 'UNSUPPORTED')
    // 小寫開頭 = 輔助 chunk，略過
    const withAncillary = rebuild([chs[0], { type: 'zzZz', data: Buffer.from('hello') }, { type: 'tEXt', data: Buffer.from('k\0v') }, ...chs.slice(1)])
    assert.deepEqual(gray(withAncillary), [10, 20])
  })

  test('驗 CRC：改一個 byte → CORRUPT', () => {
    const buf = fixture('ct6-d8-split-idat.png')
    const chs = parseChunks(buf)
    const targets = ['IHDR', 'tEXt', 'IDAT', 'IEND']
    for (const t of targets) {
      const c = chs.find(x => x.type === t)
      // 改 CRC 本身
      const a = Buffer.from(buf)
      a[c.end - 1] ^= 0x01
      throwsPng(() => decodePngGray(a), 'CORRUPT', `${t} 的 CRC`)
      // 改資料（CRC 不變）
      if (c.data.length > 0) {
        const b = Buffer.from(buf)
        b[c.start + 8] ^= 0x40
        throwsPng(() => decodePngGray(b), 'CORRUPT', `${t} 的資料`)
      }
    }
    // pngSize 也驗 IHDR 的 CRC
    const bad = Buffer.from(buf)
    bad[chs[0].end - 1] ^= 0x01
    throwsPng(() => pngSize(bad), 'CORRUPT')
  })

  test('簽章不對 → NOT_PNG（JPEG 當 PNG）', () => {
    const jpg = fixture('not-png.jpg')
    assert.equal(jpg[0], 0xff)
    assert.equal(jpg[1], 0xd8)
    throwsPng(() => decodePngGray(jpg), 'NOT_PNG')
    throwsPng(() => pngSize(jpg), 'NOT_PNG')
    throwsPng(() => decodePngGray(Buffer.from('GIF89a......')), 'NOT_PNG')
    throwsPng(() => decodePngGray(Buffer.alloc(0)), 'NOT_PNG')
    throwsPng(() => decodePngGray(Buffer.from('hello world, definitely not a png file')), 'NOT_PNG')
    // 簽章只差最後一個 byte（例如被當文字檔轉換過行尾）
    const b = Buffer.from(fixture('ct0-d8.png'))
    b[7] = 0x0d
    throwsPng(() => decodePngGray(b), 'NOT_PNG')
  })

  test('Paeth 平手時照規格：先 a、再 b、最後 c', () => {
    // 情況 A：pa == pc < pb → 規格選 a。c=10、b=12、a=6：p=8，pa=2、pb=4、pc=2 → 6（錯的順序會給 10）
    // 第二列第 1 個像素：a=0、b=10、c=0 → Paeth 選 b=10，原始值 6 → 殘差 (6−10)&255 = 252
    const rawA = Buffer.from([0, 10, 12, 4, 252, 0])
    assert.deepEqual(gray(png(ihdr(2, 2, 8, 0), idat(rawA), iend())), [10, 12, 6, 6])
    // 情況 B：pb == pc < pa → 規格選 b。c=10、b=6、a=12：p=8，pa=4、pb=2、pc=2 → 6（錯的順序會給 10）
    const rawB = Buffer.from([0, 10, 6, 4, 2, 0])
    assert.deepEqual(gray(png(ihdr(2, 2, 8, 0), idat(rawB), iend())), [10, 6, 12, 6])
    // 情況 C：不可以用 byte 溢位算 p。c=10、b=100、a=200：p=290，pa=90、pb=190、pc=280 → 200
    // （如果 p 被截成 290&255=34，會選到 c=10）
    const rawC = Buffer.from([0, 10, 100, 4, 190, 0])
    assert.deepEqual(gray(png(ihdr(2, 2, 8, 0), idat(rawC), iend())), [10, 100, 200, 200])
  })
})

// ---------- 標準答案：PIL 對照、規格公式對照 ----------

describe('標準答案', () => {
  test('真實截圖（headless Chromium）：跟 PIL convert(L) 每像素差 ≤ 1、跟規格公式完全相同', () => {
    for (const s of expected.screenshots) {
      const buf = fixture(s.file)
      const t0 = performance.now()
      const out = decodePngGray(buf)
      const ms = performance.now() - t0
      assert.equal(out.width, s.width)
      assert.equal(out.height, s.height)
      assert.ok(out.gray instanceof Uint8Array)
      const pil = zlib.gunzipSync(fixture(s.pilGrayGz))
      assert.ok(maxDiff(out.gray, pil) <= 1, `${s.file} 跟 PIL 差超過 1`)
      assert.equal(createHash('sha256').update(out.gray).digest('hex'), s.refSha256, `${s.file} 跟規格公式不同`)
      assert.ok(ms < 2000, `${s.file} 解了 ${ms.toFixed(0)} ms`)
    }
  })

  test('各 color type／bit depth／filter／tRNS：跟規格公式完全相同、跟 PIL 差 ≤ 1', () => {
    const combos = new Set()
    for (const e of expected.generated) {
      const out = decodePngGray(fixture(e.file))
      assert.equal(out.width, e.width, e.file)
      assert.equal(out.height, e.height, e.file)
      const ref = Buffer.from(e.ref, 'base64')
      assert.deepEqual(Array.from(out.gray), Array.from(ref), `${e.file}（${e.note}）跟規格公式不同`)
      if (e.pil) assert.ok(maxDiff(out.gray, Buffer.from(e.pil, 'base64')) <= 1, `${e.file} 跟 PIL 差超過 1`)
      combos.add(`${e.colorType}/${e.bitDepth}`)
    }
    // 規格允許的 15 種組合全部都有
    assert.equal(combos.size, 15)
  })

  test('PIL 自己編碼的圖：跟 PIL 差 ≤ 1', () => {
    for (const e of expected.pilEncoded) {
      const out = decodePngGray(fixture(e.file))
      assert.equal(out.width, e.width, e.file)
      assert.equal(out.height, e.height, e.file)
      assert.ok(maxDiff(out.gray, zlib.inflateSync(Buffer.from(e.pil, 'base64'))) <= 1, `${e.file} 跟 PIL 差超過 1`)
    }
  })

  test('16 位元 tRNS 用完整 16 位元比對（PIL 在這兩張跟規格不一致，所以只比規格公式）', () => {
    // 灰階 16：0x1234 透明；0x12FF、0x1200 高位元組同為 0x12 但不透明
    assert.deepEqual(gray(simplePng(3, 1, 16, 0, [[0x12, 0x34, 0x12, 0xff, 0x12, 0x00]], [chunk('tRNS', Buffer.from([0x12, 0x34]))])), [255, 0x12, 0x12])
    // RGB 16：只差一個低位元組就不透明
    const trns = chunk('tRNS', Buffer.from([0x0a, 0x00, 0x14, 0x00, 0x1e, 0x00]))
    assert.deepEqual(gray(simplePng(2, 1, 16, 2, [[0x0a, 0x00, 0x14, 0x00, 0x1e, 0x00, 0x0a, 0x01, 0x14, 0x00, 0x1e, 0x00]], [trns])), [255, 18])
    // 灰階 2 位元：tRNS 值是原始樣本值（2），不是放大後的 170
    assert.deepEqual(gray(simplePng(4, 1, 2, 0, [[0b00011011]], [chunk('tRNS', Buffer.from([0, 2]))])), [0, 85, 255, 255])
  })
})

// ---------- 其他結構錯誤與 API 行為 ----------

describe('結構與 API', () => {
  test('pngSize 只讀 IHDR：不解壓、截在 IHDR 之後也行', () => {
    assert.deepEqual(pngSize(fixture('chromium-1280x860.png')), { width: 1280, height: 860 })
    assert.deepEqual(pngSize(fixture('chromium-1280x720.png')), { width: 1280, height: 720 })
    const headerOnly = png(ihdr(123, 45, 8, 2))
    assert.deepEqual(pngSize(headerOnly), { width: 123, height: 45 })
    throwsPng(() => pngSize(headerOnly.subarray(0, 20)), 'TRUNCATED')
    throwsPng(() => pngSize(Buffer.alloc(0)), 'NOT_PNG')
    throwsPng(() => pngSize(png(chunk('tEXt', Buffer.from('a\0b')), ihdr(1, 1, 8, 0))), 'CORRUPT')
    throwsPng(() => pngSize(png(ihdr(0, 5, 8, 0))), 'CORRUPT')
  })

  test('不修改輸入，輸出是 Uint8Array、長度 = 寬 × 高', () => {
    const buf = fixture('ct6-d16.png')
    const before = createHash('sha256').update(buf).digest('hex')
    const out = decodePngGray(buf)
    assert.equal(createHash('sha256').update(buf).digest('hex'), before)
    assert.ok(out.gray instanceof Uint8Array)
    assert.equal(out.gray.length, out.width * out.height)
    // 也收一般的 Uint8Array
    assert.deepEqual(decodePngGray(new Uint8Array(buf)).gray, out.gray)
  })

  test('IHDR 欄位錯誤', () => {
    const one = Buffer.from([0, 0])
    throwsPng(() => decodePngGray(png(ihdr(1, 1, 4, 2), idat(one), iend())), 'CORRUPT', 'RGB 不能是 4 位元')
    throwsPng(() => decodePngGray(png(ihdr(1, 1, 8, 5), idat(one), iend())), 'CORRUPT', 'color type 5 不存在')
    throwsPng(() => decodePngGray(png(ihdr(1, 1, 16, 3), idat(one), iend())), 'CORRUPT', '調色盤不能是 16 位元')
    throwsPng(() => decodePngGray(png(ihdr(0, 1, 8, 0), idat(one), iend())), 'CORRUPT', '寬度 0')
    throwsPng(() => decodePngGray(png(ihdr(0x80000000, 1, 8, 0), idat(one), iend())), 'CORRUPT', '寬度超過 2^31−1')
    throwsPng(() => decodePngGray(png(ihdr(1, 1, 8, 0, { compression: 1 }), idat(one), iend())), 'UNSUPPORTED')
    throwsPng(() => decodePngGray(png(ihdr(1, 1, 8, 0, { filter: 64 }), idat(one), iend())), 'UNSUPPORTED')
    throwsPng(() => decodePngGray(png(ihdr(1, 1, 8, 0, { interlace: 2 }), idat(one), iend())), 'UNSUPPORTED')
    // IHDR 長度不是 13
    throwsPng(() => decodePngGray(png(chunk('IHDR', Buffer.alloc(12)), idat(one), iend())), 'CORRUPT')
  })

  test('chunk 順序與必要 chunk', () => {
    const one = [[5]]
    const ok = simplePng(1, 1, 8, 0, one)
    const chs = parseChunks(ok)
    // 沒有 IEND → TRUNCATED
    throwsPng(() => decodePngGray(ok.subarray(0, chs[2].start)), 'TRUNCATED')
    // IHDR 不是第一個
    throwsPng(() => decodePngGray(rebuild([chs[1], chs[0], chs[2]])), 'CORRUPT')
    // 兩個 IHDR
    throwsPng(() => decodePngGray(rebuild([chs[0], chs[0], chs[1], chs[2]])), 'CORRUPT')
    // 沒有 IDAT
    throwsPng(() => decodePngGray(rebuild([chs[0], chs[2]])), 'CORRUPT')
    // IDAT 不連續
    const raw = Buffer.from([0, 5])
    const z = zlib.deflateSync(raw)
    const split = png(chunk('IHDR', chs[0].data),
      chunk('IDAT', z.subarray(0, 3)), chunk('tEXt', Buffer.from('a\0b')), chunk('IDAT', z.subarray(3)), iend())
    throwsPng(() => decodePngGray(split), 'CORRUPT')
    // 完整的串流都在第一段、夾在中間之後只剩一段空的 IDAT：照接也解得出來，所以一定要在結構這一層擋
    const splitEmpty = png(chunk('IHDR', chs[0].data),
      chunk('IDAT', z), chunk('tEXt', Buffer.from('a\0b')), chunk('IDAT', Buffer.alloc(0)), iend())
    throwsPng(() => decodePngGray(splitEmpty), 'CORRUPT', 'IDAT 不連續（後段是空的）')
    // 連續的多個 IDAT（含零長度）沒問題
    const okSplit = png(chunk('IHDR', chs[0].data), chunk('IDAT', z.subarray(0, 3)), chunk('IDAT', Buffer.alloc(0)), chunk('IDAT', z.subarray(3)), iend())
    assert.deepEqual(gray(okSplit), [5])
    // IEND 之後的垃圾不理
    assert.deepEqual(gray(Buffer.concat([ok, Buffer.from('trailing junk')])), [5])
    // chunk 長度超過 2^31−1
    const huge = Buffer.from(ok)
    huge.writeUInt32BE(0x80000000, chs[1].start)
    throwsPng(() => decodePngGray(huge), 'CORRUPT')
    // chunk 名稱不是英文字母
    throwsPng(() => decodePngGray(rebuild([chs[0], { type: 'ID@T', data: Buffer.alloc(0) }, chs[1], chs[2]])), 'CORRUPT')
  })

  test('調色盤：缺 PLTE、索引超出範圍、PLTE 長度錯', () => {
    throwsPng(() => decodePngGray(simplePng(1, 1, 8, 3, [[0]])), 'CORRUPT', '缺 PLTE')
    const plte2 = chunk('PLTE', Buffer.from([1, 2, 3, 4, 5, 6]))
    throwsPng(() => decodePngGray(simplePng(1, 1, 8, 3, [[2]], [plte2])), 'CORRUPT', '索引 2 超出 2 色調色盤')
    assert.deepEqual(gray(simplePng(2, 1, 8, 3, [[0, 1]], [plte2])), [2, 5])
    throwsPng(() => decodePngGray(simplePng(1, 1, 8, 3, [[0]], [chunk('PLTE', Buffer.from([1, 2]))])), 'CORRUPT', 'PLTE 長度不是 3 的倍數')
    throwsPng(() => decodePngGray(simplePng(1, 1, 8, 3, [[0]], [chunk('PLTE', Buffer.alloc(0))])), 'CORRUPT', 'PLTE 空的')
    // tRNS 比調色盤長：多的忽略
    const trnsLong = chunk('tRNS', Buffer.from([0, 255, 0, 0]))
    assert.deepEqual(gray(simplePng(2, 1, 8, 3, [[0, 1]], [plte2, trnsLong])), [255, 5])
  })

  test('filter type 超過 4 → CORRUPT', () => {
    throwsPng(() => decodePngGray(png(ihdr(1, 1, 8, 0), idat([5, 1]), iend())), 'CORRUPT')
  })

  test('maxPixels 不合法 → PngError（不能默默變成沒上限）', () => {
    const ok = simplePng(1, 1, 8, 0, [[1]])
    for (const bad of [NaN, -1, 0, Infinity, '100', null]) {
      throwsPng(() => decodePngGray(ok, { maxPixels: bad }), 'BAD_OPTION', `maxPixels=${String(bad)}`)
    }
    assert.deepEqual(decodePngGray(ok, {}).gray, new Uint8Array([1]))
    assert.deepEqual(decodePngGray(ok, { maxPixels: undefined }).gray, new Uint8Array([1]))
  })

  test('非 Buffer 輸入 → NOT_PNG', () => {
    for (const bad of [null, undefined, 'x', 42, {}, [0x89, 0x50]]) {
      throwsPng(() => decodePngGray(bad), 'NOT_PNG', String(bad))
      throwsPng(() => pngSize(bad), 'NOT_PNG', String(bad))
    }
  })

  test('IEND 有資料 → CORRUPT', () => {
    const ok = simplePng(1, 1, 8, 0, [[5]])
    const chs = parseChunks(ok)
    assert.deepEqual(gray(ok), [5])
    throwsPng(() => decodePngGray(rebuild([chs[0], chs[1], { type: 'IEND', data: Buffer.from('x') }])), 'CORRUPT')
  })

  test('PLTE 出現兩次、出現在 IDAT 之後 → CORRUPT', () => {
    const plte = chunk('PLTE', Buffer.from([0, 0, 0]))
    const pix = idat([0, 0])
    // 對照：PLTE 一次、在 IDAT 之前 → 正常
    assert.deepEqual(gray(png(ihdr(1, 1, 8, 3), plte, pix, iend())), [0])
    throwsPng(() => decodePngGray(png(ihdr(1, 1, 8, 3), plte, plte, pix, iend())), 'CORRUPT', 'PLTE 兩次')
    throwsPng(() => decodePngGray(png(ihdr(1, 1, 8, 3), pix, plte, iend())), 'CORRUPT', '調色盤圖的 PLTE 在 IDAT 之後')
    // RGB 圖的建議調色盤也一樣要在 IDAT 之前
    throwsPng(() => decodePngGray(png(ihdr(1, 1, 8, 2), idat([0, 1, 2, 3]), plte, iend())), 'CORRUPT', 'RGB 圖的 PLTE 在 IDAT 之後')
  })

  test('PLTE 最多 256 色：768 bytes 可以、771 bytes → CORRUPT', () => {
    const pal = n => chunk('PLTE', Buffer.from(Array.from({ length: n * 3 }, (_, i) => (i % 3 === 1 ? 255 : 0))))
    assert.deepEqual(gray(png(ihdr(1, 1, 8, 3), pal(256), idat([0, 255]), iend())), [150])
    throwsPng(() => decodePngGray(png(ihdr(1, 1, 8, 3), pal(257), idat([0, 0]), iend())), 'CORRUPT', 'PLTE 257 色')
  })

  test('IDAT 之後才出現的 tRNS、重複的 tRNS 都忽略', () => {
    const plte = chunk('PLTE', Buffer.from([0, 0, 0]))
    const clear = chunk('tRNS', Buffer.from([0]))
    const opaque = chunk('tRNS', Buffer.from([255]))
    const pix = idat([0, 0])
    // 對照：IDAT 之前的 tRNS 有效 → 透明疊白 255
    assert.deepEqual(gray(png(ihdr(1, 1, 8, 3), plte, clear, pix, iend())), [255])
    // IDAT 之後的 tRNS 不理 → 黑色 0
    assert.deepEqual(gray(png(ihdr(1, 1, 8, 3), plte, pix, clear, iend())), [0])
    // 重複的 tRNS：第一個有效
    assert.deepEqual(gray(png(ihdr(1, 1, 8, 3), plte, opaque, clear, pix, iend())), [0])
    assert.deepEqual(gray(png(ihdr(1, 1, 8, 3), plte, clear, opaque, pix, iend())), [255])
  })

  test('高度 0 → CORRUPT（decodePngGray 與 pngSize 都是）', () => {
    throwsPng(() => decodePngGray(png(ihdr(1, 0, 8, 0), idat([]), iend())), 'CORRUPT', '高度 0')
    throwsPng(() => pngSize(png(ihdr(5, 0, 8, 0))), 'CORRUPT', 'pngSize 高度 0')
  })

  test('chunk 結構完整、zlib 串流被截斷 → TRUNCATED（不是 CORRUPT）', () => {
    const raw = Buffer.from(Array.from({ length: 16 * 17 }, (_, i) => (i % 17 === 0 ? 0 : (i * 7) & 255)))
    const z = zlib.deflateSync(raw)
    assert.deepEqual(gray(png(ihdr(16, 16, 8, 0), chunk('IDAT', z), iend())).length, 256)
    for (const cut of [2, z.length >> 1, z.length - 1]) {
      throwsPng(() => decodePngGray(png(ihdr(16, 16, 8, 0), chunk('IDAT', z.subarray(0, cut)), iend())), 'TRUNCATED', `zlib 只留前 ${cut} bytes`)
    }
  })

  test('PngError 帶 name 與 code', () => {
    try {
      decodePngGray(Buffer.from('nope'))
      assert.fail('應該丟錯')
    } catch (e) {
      assert.ok(e instanceof Error)
      assert.ok(e instanceof PngError)
      assert.equal(e.name, 'PngError')
      assert.equal(typeof e.code, 'string')
      assert.ok(/[一-鿿]/.test(e.message), '錯誤訊息用中文')
    }
  })
})

// ---------- 惡意輸入：大量 chunk ----------

describe('惡意輸入：大量 chunk', () => {
  // 每個零長度 IDAT 都是同樣的 12 bytes：長度 0、'IDAT'、CRC 35AF061E
  const EMPTY_IDAT = chunk('IDAT')
  const emptyIdats = n => Buffer.alloc(n * 12, EMPTY_IDAT)

  test('90 萬個零長度 IDAT：解得出來，而且不會吃光記憶體（子行程限 heap 64 MB，不能被 V8 OOM 殺掉）', { timeout: 60_000 }, () => {
    assert.equal(EMPTY_IDAT.toString('hex'), '000000004944415435af061e')
    const dir = mkdtempSync(join(tmpdir(), 'png-chunks-'))
    try {
      const okFile = join(dir, 'ok.png')
      const manyFile = join(dir, 'many-empty-idat.png')
      writeFileSync(okFile, fixture('ct0-d8.png'))
      // 1×1 灰階：IHDR、90 萬個零長度 IDAT、真正的 IDAT、IEND。檔案約 10.8 MB
      const many = png(ihdr(1, 1, 8, 0), emptyIdats(900_000), idat([0, 5]), iend())
      writeFileSync(manyFile, many)
      const base = runIsolated(okFile, { heapMB: 64 })
      const r = runIsolated(manyFile, { heapMB: 64 })
      assert.equal(r.code, 'OK')
      // 檔案本身約 10.8 MB 要讀進記憶體；每個 chunk 都留一個物件的話會多吃 200 MB 以上
      const extraMB = (r.maxRSS - base.maxRSS) / 1024
      assert.ok(extraMB < 48, `90 萬個零長度 IDAT 多吃了 ${extraMB.toFixed(1)} MB`)
      assert.ok(r.ms < 5000, `90 萬個零長度 IDAT 解了 ${r.ms.toFixed(0)} ms`)
      assert.deepEqual(gray(many), [5])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('1 byte 一段的 IDAT：結果跟一整段一樣，記憶體不會變成檔案大小的好幾倍', { timeout: 60_000 }, () => {
    const rnd = mulberry32(42)
    const w = 1024
    const h = 512
    const pixels = Uint8Array.from({ length: w * h }, () => Math.floor(rnd() * 256))
    const raw = Buffer.alloc(h * (w + 1))
    for (let y = 0; y < h; y++) raw.set(pixels.subarray(y * w, (y + 1) * w), y * (w + 1) + 1)
    // 不壓縮（level 0）讓串流夠長：約 525 KB，切成約 52 萬個 1 byte 的 IDAT，檔案約 6.8 MB
    const z = zlib.deflateSync(raw, { level: 0 })
    const pieces = []
    for (let i = 0; i < z.length; i++) pieces.push(chunk('IDAT', z.subarray(i, i + 1)))
    // 52 萬段不能用展開參數傳進 png()（會超過呼叫堆疊），直接接成陣列
    const oneByte = Buffer.concat([SIG, ihdr(w, h, 8, 0), ...pieces, iend()])
    const whole = png(ihdr(w, h, 8, 0), chunk('IDAT', z), iend())
    assert.deepEqual(decodePngGray(oneByte).gray, pixels)
    assert.deepEqual(decodePngGray(whole).gray, pixels)
    const dir = mkdtempSync(join(tmpdir(), 'png-chunks-'))
    try {
      const wholeFile = join(dir, 'whole.png')
      const oneByteFile = join(dir, 'one-byte-idat.png')
      writeFileSync(wholeFile, whole)
      writeFileSync(oneByteFile, oneByte)
      const base = runIsolated(wholeFile, { heapMB: 64 })
      const r = runIsolated(oneByteFile, { heapMB: 64 })
      assert.equal(base.code, 'OK')
      assert.equal(r.code, 'OK')
      // 兩個檔解出來的資料一樣大，差別只在檔案多 6 MB 左右、多一份約 0.5 MB 的壓縮資料副本
      const extraMB = (r.maxRSS - base.maxRSS) / 1024
      assert.ok(extraMB < 32, `1 byte 一段的 IDAT 多吃了 ${extraMB.toFixed(1)} MB`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('只有一段 IDAT 就直接用輸入，不另外複製壓縮資料（對照組：解碼行程自己多配一份同大小的 buffer）', { timeout: 60_000 }, () => {
    // 1×1 灰階，但 IDAT 有 48 MB：前面是 960 萬個空的 stored 區塊（每個 5 bytes：00、0000、FFFF），
    // 後面才是真正的資料。解開只有 2 bytes，所以解碼時的記憶體幾乎只有輸入本身；多複製一份就會再多 48 MB
    const raw = Buffer.from([0, 5])
    const emptyStored = Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff])
    const adler = zlib.deflateSync(raw).subarray(-4) // 正常 zlib 串流最後 4 bytes 就是 adler32
    const z = Buffer.concat([Buffer.from([0x78, 0x01]), Buffer.alloc(9_600_000 * 5, emptyStored), zlib.deflateRawSync(raw), adler])
    assert.deepEqual(zlib.inflateSync(z), raw)
    const half = z.length >> 1
    const one = png(ihdr(1, 1, 8, 0), chunk('IDAT', z), iend())
    // 同一串資料切成兩段：只驗解得對，不管它用多少記憶體（接起來、逐段串流都可以）
    const two = png(ihdr(1, 1, 8, 0), chunk('IDAT', z.subarray(0, half)), chunk('IDAT', z.subarray(half)), iend())
    assert.deepEqual(gray(one), [5])
    assert.deepEqual(gray(two), [5])
    const dir = mkdtempSync(join(tmpdir(), 'png-chunks-'))
    try {
      const okFile = join(dir, 'ok.png')
      const oneFile = join(dir, 'one-idat.png')
      writeFileSync(okFile, fixture('ct0-d8.png'))
      writeFileSync(oneFile, one)
      const base = runIsolated(okFile)
      const r1 = runIsolated(oneFile)
      // 對照組：解同一個單段檔，但解碼行程自己先多配一份跟壓縮資料一樣大的 buffer 並寫滿，
      // 模擬「實作多複製了一份」。不靠實作在任何情況下一定會複製
      const ctl = runIsolated(oneFile, { holdBytes: z.length })
      assert.equal(r1.code, 'OK')
      assert.equal(ctl.code, 'OK')
      assert.equal(ctl.held, z.length)
      // maxRSS 單位是 KB，這裡都換成 MiB。壓縮資料約 45.8 MiB
      const zMiB = z.length / 2 ** 20
      const limit = zMiB * 1.5
      const extra1 = (r1.maxRSS - base.maxRSS) / 1024
      const extraCtl = (ctl.maxRSS - base.maxRSS) / 1024
      // 單段：只有讀進來的輸入（約 zMiB）。多一份副本會變成約 2 × zMiB
      assert.ok(extra1 < limit,
        `單段 IDAT 多吃了 ${extra1.toFixed(1)} MiB（輸入約 ${zMiB.toFixed(1)} MiB），多出一份壓縮資料的副本`)
      // 對照組一定要超過同一個門檻：證明多一份副本時，上面那條量得出來、會紅
      assert.ok(extraCtl > limit,
        `對照組多配了一份 ${zMiB.toFixed(1)} MiB，卻只量到多 ${extraCtl.toFixed(1)} MiB，門檻 ${limit.toFixed(1)} MiB 抓不到一份副本`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('一個檔最多 100 萬個 chunk（含 IHDR、IEND）：剛好 100 萬可以，多 1 個 → TOO_LARGE', { timeout: 60_000 }, () => {
    const LIMIT = 1_000_000
    // IHDR ＋（LIMIT − 3）個零長度 IDAT ＋ 真正的 IDAT ＋ IEND ＝ LIMIT 個
    const atLimit = png(ihdr(1, 1, 8, 0), emptyIdats(LIMIT - 3), idat([0, 5]), iend())
    assert.deepEqual(gray(atLimit), [5])
    const over = png(ihdr(1, 1, 8, 0), emptyIdats(LIMIT - 2), idat([0, 5]), iend())
    throwsPng(() => decodePngGray(over), 'TOO_LARGE', `${LIMIT + 1} 個 chunk`)
    // 輔助 chunk 一樣算：100 萬個空的 tEXt
    const textChunk = chunk('tEXt')
    const texts = png(ihdr(1, 1, 8, 0), Buffer.alloc(LIMIT * 12, textChunk), idat([0, 5]), iend())
    throwsPng(() => decodePngGray(texts), 'TOO_LARGE', '100 萬個 tEXt')
    // 讀到第 LIMIT + 1 個 chunk 就停：它（IEND）就算被截斷，也是 TOO_LARGE
    throwsPng(() => decodePngGray(over.subarray(0, over.length - 6)), 'TOO_LARGE', '超過上限、IEND 又被截斷')
  })
})

// ---------- 結構化隨機 ----------

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 照規格寫的 filter 編碼器與灰階公式（測試用，跟實作分開寫）
function paethPredict(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function encodeRows(rows, bpp, filters) {
  const out = []
  let prev = null
  rows.forEach((row, y) => {
    const ft = filters[y]
    const line = [ft]
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= bpp ? prev[i - bpp] : 0
      const pred = [0, a, b, (a + b) >> 1, paethPredict(a, b, c)][ft]
      line.push((row[i] - pred) & 255)
    }
    out.push(...line)
    prev = row
  })
  return Buffer.from(out)
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
const COMBOS = [[0, 1], [0, 2], [0, 4], [0, 8], [0, 16], [2, 8], [2, 16], [3, 1], [3, 2], [3, 4], [3, 8], [4, 8], [4, 16], [6, 8], [6, 16]]

describe('結構化隨機', () => {
  test('隨機尺寸／組合／filter：同樣的像素不管用哪種 filter 編碼，解出來都跟規格公式一樣', () => {
    const rnd = mulberry32(20260919)
    const ri = n => Math.floor(rnd() * n)
    for (let iter = 0; iter < 400; iter++) {
      const [ct, bd] = COMBOS[ri(COMBOS.length)]
      const w = 1 + ri(24)
      const h = 1 + ri(12)
      const ch = CHANNELS[ct]
      const maxv = (1 << bd) - 1
      const pixels = Array.from({ length: h }, () => Array.from({ length: w }, () => Array.from({ length: ch }, () => ri(maxv + 1))))
      let plte = null
      if (ct === 3) {
        const n = maxv + 1
        plte = Array.from({ length: n }, () => [ri(256), ri(256), ri(256)])
      }
      // 打包成 bytes
      const rows = pixels.map(line => {
        if (bd >= 8) {
          const out = []
          for (const px of line) for (const s of px) bd === 8 ? out.push(s) : out.push(s >> 8, s & 255)
          return out
        }
        const out = new Array(Math.ceil((w * bd) / 8)).fill(0)
        line.forEach(([s], x) => {
          const bit = x * bd
          out[bit >> 3] |= s << (8 - bd - (bit & 7))
        })
        return out
      })
      const bpp = Math.max(1, (ch * bd) >> 3)
      const filters = rows.map(() => ri(5))
      const extra = plte ? [chunk('PLTE', Buffer.from(plte.flat()))] : []
      const buf = png(ihdr(w, h, bd, ct), ...extra, idat(encodeRows(rows, bpp, filters)), iend())
      // 規格公式
      const to8 = s => (bd === 16 ? s >> 8 : bd === 8 ? s : (s * 255) / maxv)
      const expect = []
      for (const line of pixels) {
        for (const px of line) {
          let y1000
          let a = 255
          if (ct === 0) y1000 = 1000 * to8(px[0])
          else if (ct === 2) y1000 = 299 * to8(px[0]) + 587 * to8(px[1]) + 114 * to8(px[2])
          else if (ct === 3) {
            const [r, g, b] = plte[px[0]]
            y1000 = 299 * r + 587 * g + 114 * b
          } else if (ct === 4) {
            y1000 = 1000 * to8(px[0])
            a = to8(px[1])
          } else {
            y1000 = 299 * to8(px[0]) + 587 * to8(px[1]) + 114 * to8(px[2])
            a = to8(px[3])
          }
          expect.push(Math.floor((y1000 * a + 255000 * (255 - a) + 127500) / 255000))
        }
      }
      const out = decodePngGray(buf)
      assert.equal(out.width, w)
      assert.equal(out.height, h)
      assert.deepEqual(Array.from(out.gray), expect, `ct=${ct} bd=${bd} ${w}×${h} filters=${filters}`)
    }
  })

  test('隨機破壞 bytes（含重算 CRC 讓它走得更深）：只會回正常結果或丟 PngError', { timeout: 60_000 }, () => {
    const rnd = mulberry32(7)
    const ri = n => Math.floor(rnd() * n)
    const names = ['ct0-d1.png', 'ct2-d16.png', 'ct3-d4-trns.png', 'ct4-d8.png', 'ct6-d8-split-idat.png', 'paeth-ct6-d16.png', 'pil-p16.png']
    const bufs = names.map(fixture)
    const t0 = performance.now()
    let ok = 0
    let errs = 0
    for (let iter = 0; iter < 3000; iter++) {
      const b = Buffer.from(bufs[ri(bufs.length)])
      const flips = 1 + ri(4)
      for (let k = 0; k < flips; k++) {
        const pos = ri(b.length)
        b[pos] = rnd() < 0.5 ? b[pos] ^ (1 << ri(8)) : ri(256)
      }
      let input = b
      if (rnd() < 0.7) {
        // 重算每個 chunk 的 CRC（只在結構還能走的時候）
        try {
          const chs = parseChunks(b)
          if (chs.length > 0 && chs.every(c => c.data.length === b.readUInt32BE(c.start))) {
            input = Buffer.concat([b.subarray(0, 8), ...chs.map(c => chunk(c.type, Buffer.from(c.data)))])
          }
        } catch {}
      }
      try {
        const out = decodePngGray(input, { maxPixels: 1_000_000 })
        assert.equal(out.gray.length, out.width * out.height)
        ok++
      } catch (e) {
        assert.ok(e instanceof PngError, `非 PngError：${e?.name}: ${e?.message}`)
        errs++
      }
    }
    const ms = performance.now() - t0
    assert.ok(ok > 0 && errs > 0, `ok=${ok} errs=${errs}`)
    assert.ok(ms < 30_000, `3000 次花了 ${ms.toFixed(0)} ms`)
  })

  test('破壞解壓後的資料與 IHDR 欄位（重新壓縮、重算 CRC）：只會回正常結果或丟 PngError', { timeout: 60_000 }, () => {
    // 上一個測試大多停在 zlib 的校驗碼；這裡讓壞資料真的走進 filter 還原與灰階轉換
    const rnd = mulberry32(99)
    const ri = n => Math.floor(rnd() * n)
    const names = ['ct0-d1.png', 'ct0-d16.png', 'ct2-d16.png', 'ct3-d2.png', 'ct3-d4-trns.png', 'ct3-d8-trns.png', 'ct4-d16.png', 'ct6-d8.png', 'paeth-ct6-d16.png', 'pil-p16.png']
    const parsed = names.map(n => {
      const chs = parseChunks(fixture(n))
      return {
        ihdr: Buffer.from(chs[0].data),
        before: chs.filter(c => c.type !== 'IHDR' && c.type !== 'IDAT' && c.type !== 'IEND'),
        raw: zlib.inflateSync(Buffer.concat(chs.filter(c => c.type === 'IDAT').map(c => c.data))),
      }
    })
    const seen = new Map()
    for (let iter = 0; iter < 2000; iter++) {
      const f = parsed[ri(parsed.length)]
      const head = Buffer.from(f.ihdr)
      let raw = Buffer.from(f.raw)
      const mode = ri(4)
      if (mode === 0 || mode === 3) {
        for (let k = 1 + ri(6); k > 0; k--) raw[ri(raw.length)] = ri(256)
      }
      if (mode === 1) {
        // 動 IHDR：寬、高、bit depth、color type、交錯
        const field = ri(5)
        if (field === 0) head.writeUInt32BE(1 + ri(64), 0)
        if (field === 1) head.writeUInt32BE(1 + ri(64), 4)
        if (field === 2) head[8] = [1, 2, 4, 8, 16, 3, 0][ri(7)]
        if (field === 3) head[9] = [0, 2, 3, 4, 6, 1, 7][ri(7)]
        if (field === 4) head[12] = ri(3)
      }
      if (mode === 2) {
        // 資料長度 ±（多或少幾 byte）
        const delta = ri(9) - 4
        raw = delta >= 0 ? Buffer.concat([raw, Buffer.alloc(delta, 1)]) : raw.subarray(0, Math.max(0, raw.length + delta))
      }
      const input = png(chunk('IHDR', head), ...f.before.map(c => chunk(c.type, Buffer.from(c.data))), idat(raw), iend())
      let key
      try {
        const out = decodePngGray(input)
        assert.equal(out.gray.length, out.width * out.height)
        key = 'OK'
      } catch (e) {
        assert.ok(e instanceof PngError, `非 PngError：${e?.name}: ${e?.message}`)
        key = e.code
      }
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    // 真的有走到深處：正常結果與 CORRUPT（filter type／調色盤索引）都要出現
    assert.ok(seen.get('OK') > 100, JSON.stringify([...seen]))
    assert.ok(seen.get('CORRUPT') > 100, JSON.stringify([...seen]))
  })
})
