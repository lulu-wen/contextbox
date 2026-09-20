import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { ExtractError, readZip, docxText, pptxText, decodeText, textHeadBytes } from '../core/office-text.ts'
import {
  buildZip, buildManyEntries, fakeEocd, makeDocx, documentXml, makePptx, sp, slideXml, rootRels, deflateZeros, rng,
} from './helpers/office-zip.mjs'

const FIX = fileURLToPath(new URL('./fixtures/office-text/', import.meta.url))
const fx = name => readFileSync(FIX + name)
const MB = 1024 * 1024

/** 斷言丟出 ExtractError 且 code 正確。 */
function throwsCode(fn, code) {
  assert.throws(fn, err => {
    assert.ok(err instanceof ExtractError, `應該是 ExtractError，實際是 ${err?.constructor?.name}: ${err?.message}`)
    assert.equal(err.code, code, `code 應該是 ${code}，實際是 ${err.code}：${err.message}`)
    return true
  })
}

/** 讀出 zip 裡每一個 entry（觸發解壓）。 */
function readAll(buf, opts) {
  const zip = readZip(buf, opts)
  const out = {}
  for (const [name, get] of zip) out[name] = get()
  return out
}

/** 量時間：任何輸入都不能卡住。 */
function fast(fn, ms = 3000) {
  const t = performance.now()
  let result
  let error
  try {
    result = fn()
  } catch (err) {
    error = err
  }
  const spent = performance.now() - t
  assert.ok(spent < ms, `花了 ${spent.toFixed(0)} ms，超過 ${ms} ms`)
  if (error) throw error
  return result
}

const strip = s => s.replace(/\s+/g, '').replace(/\uFEFF/g, '')

// =====================================================================
// 預想表：zip
// =====================================================================
describe('預想表 zip', () => {
  test('相信 local header 的大小 → 用 central directory：data descriptor（flag bit 3）', () => {
    // local header 的 crc／大小全是 0，真正的值在資料後面的 data descriptor 與 central directory
    const buf = buildZip([
      { name: 'a.txt', data: '第一個檔案 hello', dataDescriptor: true },
      { name: 'b.txt', data: 'stored 也要對', method: 0, dataDescriptor: true },
    ])
    const out = readAll(buf)
    assert.equal(out['a.txt'].toString('utf8'), '第一個檔案 hello')
    assert.equal(out['b.txt'].toString('utf8'), 'stored 也要對')
  })

  test('local header 宣稱錯的大小（非 0）也不理它', () => {
    const buf = buildZip([
      { name: 'a.txt', data: 'abcdefghij'.repeat(20), local: { crc: 1, comp: 3, uncomp: 5 } },
      { name: 'b.txt', data: '0123456789', method: 0, local: { crc: 1, comp: 2, uncomp: 2 } },
    ])
    const out = readAll(buf)
    assert.equal(out['a.txt'].toString(), 'abcdefghij'.repeat(20))
    assert.equal(out['b.txt'].toString(), '0123456789')
  })

  test('Info-ZIP 串流輸出做的真檔案（有 data descriptor）', () => {
    const out = readAll(fx('data-descriptor.zip'))
    assert.deepEqual(Object.keys(out), ['hello.txt'])
    assert.equal(out['hello.txt'].toString(), 'hello secret')
  })

  test('解壓不設上限 → 宣稱 1 KB、實際解開 1 GB 丟 CORRUPT', () => {
    const bomb = deflateZeros(1024, zlib)
    const buf = buildZip([{ name: 'bomb.bin', raw: bomb, uncompSize: 1024, crc: 0 }])
    const zip = readZip(buf)
    // 有上限時 1 ms 內就停；沒上限會真的解出 1 GB（這台機器約 0.6 秒、吃 1 GB 記憶體）
    fast(() => throwsCode(() => zip.get('bomb.bin')(), 'CORRUPT'), 200)
  })

  test('宣稱 1 KB、實際 10 MB 的範例檔丟 CORRUPT', () => {
    const zip = readZip(fx('bomb-declared-1k.zip'))
    fast(() => throwsCode(() => zip.get('bomb.txt')(), 'CORRUPT'))
  })

  test('宣稱很大就照做 → 宣稱 10 GB 丟 TOO_LARGE', () => {
    // 沒有 ZIP64 時單一 entry 最多只能宣稱 4 GB，所以用三個 entry 合計 10 GB
    const each = 3_333_333_334
    const buf = buildZip([
      { name: 'a.bin', data: 'x', uncompSize: each },
      { name: 'b.bin', data: 'x', uncompSize: each },
      { name: 'c.bin', data: 'x', uncompSize: each },
    ])
    fast(() => throwsCode(() => readAll(buf), 'TOO_LARGE'))
  })

  test('單檔上限 50 MB：剛好 50 MB 可以，多 1 byte 丟 TOO_LARGE', () => {
    const ok = buildZip([{ name: 'ok.bin', data: Buffer.alloc(50 * MB) }])
    assert.equal(readZip(ok).get('ok.bin')().length, 50 * MB)
    const big = buildZip([{ name: 'big.bin', data: 'x', uncompSize: 50 * MB + 1 }])
    throwsCode(() => readZip(big).get('big.bin')(), 'TOO_LARGE')
  })

  test('總和上限 100 MB：三個真的 40 MB，第三個丟 TOO_LARGE', () => {
    const data = Buffer.alloc(40 * MB)
    const raw = zlib.deflateRawSync(data)
    const crc = zlib.crc32(data)
    const buf = buildZip(['a', 'b', 'c'].map(name => ({ name, raw, crc, uncompSize: data.length })))
    const zip = readZip(buf)
    assert.equal(zip.get('a')().length, 40 * MB)
    assert.equal(zip.get('b')().length, 40 * MB)
    throwsCode(() => zip.get('c')(), 'TOO_LARGE')
  })

  test('重疊式 zip bomb：很多 entry 指向同一段資料，總和上限擋下', () => {
    const data = Buffer.alloc(30 * MB)
    const raw = zlib.deflateRawSync(data)
    const crc = zlib.crc32(data)
    const first = { name: 'f0', raw, crc, uncompSize: data.length }
    const rest = []
    for (let i = 1; i < 200; i++) rest.push({ name: `f${i}`, raw, crc, uncompSize: data.length, localOffset: 0, noLocal: true })
    const buf = buildZip([first, ...rest])
    fast(() => throwsCode(() => readAll(buf), 'TOO_LARGE'), 5000)
  })

  test('ZIP64：傳統欄位就讀得完整時照讀（第三輪規格改的；Info-ZIP 從 stdin 做的真檔案）', () => {
    // 這個檔有 ZIP64 定位記錄與 ZIP64 結尾記錄，但 central directory 與 EOCD 的傳統欄位都是真的值，跟 ZIP64 記錄一致
    const out = readAll(fx('zip64-stdin.zip'))
    assert.deepEqual(Object.keys(out), ['-'])
    assert.equal(out['-'].toString(), 'zip64 from stdin')
  })

  test('ZIP64：central directory 的大小是 0xFFFFFFFF、真值藏在 extra 欄位 → UNSUPPORTED', () => {
    const extra = Buffer.alloc(20)
    extra.writeUInt16LE(0x0001, 0)
    extra.writeUInt16LE(16, 2)
    extra.writeBigUInt64LE(5n, 4)
    extra.writeBigUInt64LE(5n, 12)
    const buf = buildZip([{ name: 'a.txt', data: 'hello', method: 0, compSize: 0xffffffff, uncompSize: 0xffffffff, centralExtra: extra }])
    throwsCode(() => readAll(buf), 'UNSUPPORTED')
  })

  test('ZIP64：EOCD 的 offset 是 0xFFFFFFFF → UNSUPPORTED', () => {
    const buf = buildZip([{ name: 'a.txt', data: 'hello' }], { eocd: { cdOffset: 0xffffffff } })
    throwsCode(() => readZip(buf), 'UNSUPPORTED')
  })

  test('加密的 entry 硬解 → 當成讀不到：entry 在，但讀它丟 ENCRYPTED', () => {
    const zip = readZip(fx('encrypted.zip'))
    assert.ok(zip.has('hello.txt'), '加密的 entry 不能被悄悄跳過')
    throwsCode(() => zip.get('hello.txt')(), 'ENCRYPTED')
  })

  test('加密：flag bit 0 的 stored entry 不能被當成明文讀出來', () => {
    const buf = buildZip([{ name: 'secret.txt', data: 'ciphertext!!', method: 0, flags: 1 }])
    throwsCode(() => readZip(buf).get('secret.txt')(), 'ENCRYPTED')
  })

  test('加密：WinZip AES（method 99）也是 ENCRYPTED', () => {
    const buf = buildZip([{ name: 'aes.txt', data: 'xxxxxxxx', method: 99, raw: Buffer.from('xxxxxxxx'), flags: 1 }])
    throwsCode(() => readZip(buf).get('aes.txt')(), 'ENCRYPTED')
  })

  test('加密：沒加密的 entry 照樣讀得到', () => {
    const buf = buildZip([
      { name: 'secret.txt', data: 'ciphertext', method: 0, flags: 1 },
      { name: 'plain.txt', data: 'plain' },
    ])
    assert.equal(readZip(buf).get('plain.txt')().toString(), 'plain')
  })

  test('entry 數量不設限 → 100 萬個 entry 丟 TOO_LARGE（真的有 100 萬筆，EOCD 只宣稱 1 筆）', () => {
    const buf = buildManyEntries(1_000_000, 1)
    fast(() => throwsCode(() => readZip(buf), 'TOO_LARGE'))
  })

  test('100 萬個 entry：EOCD 16 位元欄位繞回（1000000 & 0xFFFF = 16960）丟 TOO_LARGE', () => {
    const buf = buildManyEntries(1_000_000, 1_000_000 & 0xffff)
    fast(() => throwsCode(() => readZip(buf), 'TOO_LARGE'))
  })

  test('100 萬個 entry：只偽造 EOCD 宣稱很多，後面什麼都沒有 → TOO_LARGE', () => {
    const buf = fakeEocd({ count: 60000, cdSize: 53_000_000, cdOffset: 0 })
    fast(() => throwsCode(() => readZip(buf), 'TOO_LARGE'))
  })

  test('100 萬個 entry：ZIP64 EOCD 宣稱 1,000,000 → TOO_LARGE', () => {
    const marked = buildZip([{ name: 'a.txt', data: 'x' }], { zip64: { count: 1_000_000 }, eocd: { count: 0xffff } })
    fast(() => throwsCode(() => readZip(marked), 'TOO_LARGE'))
    // EOCD 寫 1、只有 ZIP64 記錄寫 100 萬：還是要看出來
    const hidden = buildZip([{ name: 'a.txt', data: 'x' }], { zip64: { count: 1_000_000 } })
    fast(() => throwsCode(() => readZip(hidden), 'TOO_LARGE'))
  })

  test('entry 上限 5000：剛好 5000 可以，5001 丟 TOO_LARGE', () => {
    assert.equal(readZip(buildManyEntries(5000, 5000)).size, 5000)
    throwsCode(() => readZip(buildManyEntries(5001, 5001)), 'TOO_LARGE')
  })
})

// =====================================================================
// 預想表：Word
// =====================================================================
describe('預想表 Word', () => {
  test('修訂模式刪掉的字不算，插入的字算', () => {
    const buf = makeDocx('<w:p><w:r><w:t>期中考</w:t></w:r><w:del w:id="1" w:author="a"><w:r><w:delText>舊</w:delText></w:r></w:del><w:ins w:id="2" w:author="a"><w:r><w:t>新</w:t></w:r></w:ins></w:p>')
    assert.deepEqual(docxText(buf), { text: '期中考新', truncated: false })
  })

  test('LibreOffice 做的真 docx：修訂刪除的「舊範圍刪掉了」不出現', () => {
    const { text } = docxText(fx('course-notes.docx'))
    assert.ok(!text.includes('舊範圍刪掉了'), text)
    assert.ok(text.includes('期中考範圍是第1到第5章（含習題）'), text)
  })

  test('表格裡的字算', () => {
    const buf = makeDocx('<w:tbl><w:tblPr/><w:tr><w:tc><w:p><w:r><w:t>課程</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>資料結構</w:t></w:r></w:p></w:tc></w:tr></w:tbl>')
    assert.equal(docxText(buf).text, '課程\n資料結構')
  })

  test('LibreOffice 做的真 docx：表格儲存格都在', () => {
    const { text } = docxText(fx('course-notes.docx'))
    for (const cell of ['課程', '資料結構', '授課教師', '王老師']) assert.ok(text.includes(cell), cell)
  })

  test('<w:tab/>、<w:br/> 轉成 tab／換行，段落之間換行；段落屬性裡的 tab 定位點不算', () => {
    const buf = makeDocx('<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>章節</w:t><w:tab/><w:t>頁碼</w:t><w:br/><w:t>下一行</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p>')
    assert.equal(docxText(buf).text, '章節\t頁碼\n下一行\n第二段')
  })

  test('XML 實體要解：&amp; → &，&#x8CC7; → 資', () => {
    const buf = makeDocx('<w:p><w:r><w:t>A &amp; B &#x8CC7;&#36039;料 &lt;&gt;&quot;&apos;</w:t></w:r></w:p>')
    assert.equal(docxText(buf).text, 'A & B 資資料 <>"\'')
  })

  test('實體只解一層：&amp;lt; → &lt;（不是 <）', () => {
    const buf = makeDocx('<w:p><w:r><w:t>&amp;lt; &amp;amp; &amp;#x41;</w:t></w:r></w:p>')
    assert.equal(docxText(buf).text, '&lt; &amp; &#x41;')
  })

  test('標準答案：跟 LibreOffice「接受所有修訂」後匯出的純文字一樣（去掉空白後）', () => {
    const { text, truncated } = docxText(fx('course-notes.docx'))
    assert.equal(truncated, false)
    assert.equal(strip(text), strip(fx('course-notes.expected.txt').toString('utf8')))
  })
})

// =====================================================================
// 預想表：PowerPoint
// =====================================================================
describe('預想表 PowerPoint', () => {
  test('照 sldIdLst ＋ rels 排：第 3 張拖到第 1 張，檔案還叫 slide3.xml', () => {
    const buf = makePptx([sp('S1'), sp('S2'), sp('S3')], { order: [2, 0, 1] })
    assert.deepEqual(pptxText(buf), { text: 'S3\n\nS1\n\nS2', slides: 3, truncated: false })
  })

  test('rId 的號碼也不能拿來排', () => {
    // rId4 → slide3、rId2 → slide1、rId3 → slide2；sldIdLst 寫 rId3, rId4, rId2
    const buf = makePptx([sp('一'), sp('二'), sp('三')], { sldIds: ['rId3', 'rId4', 'rId2'] })
    assert.equal(pptxText(buf).text, '二\n\n三\n\n一')
  })

  test('真簡報（LibreOffice 做、再把第 3 張拖到第 1 張）：第一張是「丙：佇列」', () => {
    const { text, slides } = pptxText(fx('lecture-reordered.pptx'))
    assert.equal(slides, 3)
    assert.ok(text.startsWith('丙：佇列'), text)
  })

  test('標準答案：跟 LibreOffice 轉 PDF 再 pdftotext 逐頁讀的結果一樣（去掉空白後、逐張比）', () => {
    const { text } = pptxText(fx('lecture-reordered.pptx'))
    const pages = fx('lecture-reordered.expected.txt').toString('utf8').split('\f').map(strip).filter(Boolean)
    const ours = text.split('\n\n').map(strip)
    assert.deepEqual(ours, pages)
  })

  test('講者備忘不算（真簡報）', () => {
    for (const name of ['lecture.pptx', 'lecture-reordered.pptx']) {
      const { text } = pptxText(fx(name))
      assert.ok(!text.includes('私人備忘'), `${name}: ${text}`)
    }
  })

  test('講者備忘不算（手工簡報）', () => {
    const buf = makePptx([sp('投影片內容')], { notes: ['這是私人評語'] })
    assert.equal(pptxText(buf).text, '投影片內容')
  })
})

// =====================================================================
// 預想表：純文字
// =====================================================================
describe('預想表 純文字', () => {
  test('一律當 UTF-8 → 認 BOM、試 Big5：Big5 的「資料結構」', () => {
    assert.deepEqual(decodeText(fx('big5.txt')), { text: '資料結構\n第3週：堆疊與佇列\n', encoding: 'big5', truncated: false })
  })

  test('Big5 失敗還硬用 → 退回 Windows-1252：latin1 的 café', () => {
    assert.deepEqual(decodeText(fx('latin1-cafe.txt')), { text: 'café', encoding: 'windows-1252', truncated: false })
  })

  test('順序：BOM 優先（UTF-8 BOM、UTF-16LE BOM、UTF-16BE BOM）', () => {
    assert.deepEqual(decodeText(fx('utf8-bom.txt')), { text: '資料結構 UTF-8 有 BOM', encoding: 'utf-8', truncated: false })
    assert.deepEqual(decodeText(fx('utf16le-bom.txt')), { text: '資料結構 UTF-16LE', encoding: 'utf-16le', truncated: false })
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('資料', 'utf16le').swap16()])
    assert.deepEqual(decodeText(be), { text: '資料', encoding: 'utf-16be', truncated: false })
  })

  test('順序：UTF-8 完全合法就用 UTF-8（就算同一串位元組剛好也是合法的 Big5）', () => {
    const bytes = Buffer.from('主義', 'utf8')
    // 前提：這 6 個位元組當 Big5 也解得開（「銝餌儔」），沒有 U+FFFD，也沒有私用區／C1 替代字元
    assert.equal(new TextDecoder('big5', { fatal: true }).decode(bytes), '銝餌儔')
    assert.deepEqual(decodeText(bytes), { text: '主義', encoding: 'utf-8', truncated: false })
    assert.deepEqual(decodeText(fx('utf8-nobom.txt')), { text: '資料結構 UTF-8 沒有 BOM', encoding: 'utf-8', truncated: false })
  })

  test('順序：Big5 有任何 U+FFFD 就不用，改 Windows-1252', () => {
    // 0x80 在 UTF-8 是孤立的延續位元組、在 Big5 不是合法的前導位元組
    assert.deepEqual(decodeText(Buffer.from([0x41, 0x80, 0x42])), { text: 'A€B', encoding: 'windows-1252', truncated: false })
  })

  test('輸出上限 20,000 字：剛好 20,000 不標，20,001 標 truncated', () => {
    const exact = decodeText(Buffer.from('字'.repeat(20000), 'utf8'))
    assert.equal(exact.text.length, 20000)
    assert.equal(exact.truncated, false)
    const over = decodeText(Buffer.from('字'.repeat(20001), 'utf8'))
    assert.equal(over.text, '字'.repeat(20000))
    assert.equal(over.truncated, true)
  })
})

// =====================================================================
// 表外：邊界與惡意輸入
// =====================================================================
describe('ExtractError', () => {
  test('是 Error 子類別，帶 code', () => {
    const e = new ExtractError('CORRUPT', '壞掉了')
    assert.ok(e instanceof Error)
    assert.equal(e.code, 'CORRUPT')
    assert.equal(e.name, 'ExtractError')
    assert.equal(e.message, '壞掉了')
  })

  test('0 byte 的輸入一律 EMPTY', () => {
    throwsCode(() => readZip(Buffer.alloc(0)), 'EMPTY')
    throwsCode(() => docxText(Buffer.alloc(0)), 'EMPTY')
    throwsCode(() => pptxText(Buffer.alloc(0)), 'EMPTY')
    throwsCode(() => decodeText(Buffer.alloc(0)), 'EMPTY')
  })
})

describe('zip 邊界', () => {
  test('stored 與 deflate 都讀得到；資料夾 entry 不列', () => {
    const buf = buildZip([
      { name: 'dir/', data: '', method: 0 },
      { name: 'dir/a.txt', data: 'stored', method: 0 },
      { name: 'dir/b.txt', data: 'deflated '.repeat(50) },
      { name: 'empty.txt', data: '' },
    ])
    const out = readAll(buf)
    assert.deepEqual(Object.keys(out).sort(), ['dir/a.txt', 'dir/b.txt', 'empty.txt'])
    assert.equal(out['dir/a.txt'].toString(), 'stored')
    assert.equal(out['dir/b.txt'].toString(), 'deflated '.repeat(50))
    assert.equal(out['empty.txt'].length, 0)
  })

  test('local header 的 extra 長度跟 central 不一樣時，以 local 的為準找資料開頭', () => {
    const buf = buildZip([{ name: 'a.txt', data: 'hello extra', localExtra: Buffer.alloc(28, 0x55), centralExtra: Buffer.alloc(0) }])
    assert.equal(readAll(buf)['a.txt'].toString(), 'hello extra')
  })

  test('宣稱的大小比實際大也是 CORRUPT；CRC 不對也是 CORRUPT', () => {
    throwsCode(() => readAll(buildZip([{ name: 'a', data: 'hello', uncompSize: 6 }])), 'CORRUPT')
    throwsCode(() => readAll(buildZip([{ name: 'a', data: 'hello', method: 0, uncompSize: 6, compSize: 5 }])), 'CORRUPT')
    throwsCode(() => readAll(buildZip([{ name: 'a', data: 'hello', crc: 12345 }])), 'CORRUPT')
  })

  test('不支援的壓縮法（bzip2 = 12）丟 UNSUPPORTED', () => {
    throwsCode(() => readAll(buildZip([{ name: 'a', data: 'x', raw: Buffer.from('BZh9'), method: 12 }])), 'UNSUPPORTED')
  })

  test('分割壓縮檔（多個磁碟）丟 UNSUPPORTED', () => {
    throwsCode(() => readZip(buildZip([{ name: 'a', data: 'x' }], { eocd: { disk: 1, cdDisk: 1 } })), 'UNSUPPORTED')
  })

  test('同名的 entry 丟 CORRUPT', () => {
    throwsCode(() => readZip(buildZip([{ name: 'a', data: '1' }, { name: 'a', data: '2' }])), 'CORRUPT')
  })

  test('前面接了別的資料（自解壓檔），offset 沒調整也讀得到', () => {
    const buf = Buffer.concat([Buffer.alloc(1000, 0x90), buildZip([{ name: 'a.txt', data: 'after prefix' }])])
    assert.equal(readAll(buf)['a.txt'].toString(), 'after prefix')
  })

  test('有 zip 註解也找得到 EOCD；註解裡偽造的 EOCD 簽章不會讓它卡住', () => {
    const buf = buildZip([{ name: 'a.txt', data: 'with comment' }], { comment: 'PK\u0005\u0006 這是註解' })
    assert.equal(readAll(buf)['a.txt'].toString(), 'with comment')
  })

  test('空的 zip：Map 是空的', () => {
    assert.equal(readZip(buildZip([])).size, 0)
  })

  test('標成 deflate 但 0 byte 的空檔：讀成空的', () => {
    const buf = buildZip([{ name: 'empty.txt', data: '', raw: Buffer.alloc(0), crc: 0 }])
    assert.equal(readZip(buf).get('empty.txt')().length, 0)
  })

  test('opts 傳 null 或不合法的值：用預設值', () => {
    const buf = makeDocx('<w:p><w:r><w:t>預設</w:t></w:r></w:p>')
    assert.equal(docxText(buf, null).text, '預設')
    assert.equal(docxText(buf, { maxChars: -1 }).text, '預設')
    assert.equal(docxText(buf, { maxChars: Number.NaN }).text, '預設')
    assert.equal(readZip(buf, null).size, 3)
    assert.equal(decodeText(Buffer.from('abc'), null).text, 'abc')
    assert.equal(pptxText(makePptx([sp('x')]), null).text, 'x')
  })

  test('輸入不是 Buffer：丟 ExtractError，Uint8Array 可以', () => {
    throwsCode(() => readZip('not a buffer'), 'UNSUPPORTED')
    throwsCode(() => decodeText(null), 'UNSUPPORTED')
    assert.equal(decodeText(new Uint8Array([0x68, 0x69])).text, 'hi')
  })

  test('不是 zip：CORRUPT', () => {
    throwsCode(() => readZip(Buffer.from('hello world, not a zip at all')), 'CORRUPT')
    throwsCode(() => readZip(Buffer.alloc(100000, 0x50)), 'CORRUPT')
  })

  test('截斷的 zip：在每個位置截斷都丟 CORRUPT，不會卡住', () => {
    const full = fx('course-notes.docx')
    for (let len = 1; len < full.length; len += 97) {
      const cut = full.subarray(0, len)
      fast(() => throwsCode(() => docxText(cut), 'CORRUPT'), 1000)
    }
    for (const len of [full.length - 1, full.length - 21, full.length - 22, full.length - 23]) {
      fast(() => throwsCode(() => docxText(full.subarray(0, len)), 'CORRUPT'), 1000)
    }
  })

  test('central directory 還在、但中間的資料被截掉：讀 entry 時 CORRUPT', () => {
    const buf = buildZip([{ name: 'a.txt', data: 'x'.repeat(5000), method: 0 }, { name: 'b.txt', data: 'y' }])
    // 把 a.txt 的資料砍掉一半，central directory 與 EOCD 的 offset 就都對不上了
    const broken = Buffer.concat([buf.subarray(0, 2000), buf.subarray(4500)])
    assert.throws(() => readAll(broken), err => err instanceof ExtractError && err.code === 'CORRUPT')
  })

  test('opts 可以把上限調小', () => {
    const buf = buildZip([{ name: 'a', data: 'hello' }, { name: 'b', data: 'world' }])
    throwsCode(() => readZip(buf, { maxEntries: 1 }), 'TOO_LARGE')
    throwsCode(() => readZip(buf, { maxEntryBytes: 4 }).get('a')(), 'TOO_LARGE')
    const zip = readZip(buf, { maxTotalBytes: 8 })
    assert.equal(zip.get('a')().toString(), 'hello')
    throwsCode(() => zip.get('b')(), 'TOO_LARGE')
  })

  test('結構化亂數：隨機改壞 docx／pptx 的位元組，只會正常回傳或丟 ExtractError', () => {
    const rand = rng(20260919)
    const samples = [fx('course-notes.docx'), fx('lecture-reordered.pptx')]
    for (let i = 0; i < 400; i++) {
      const base = samples[i % 2]
      const buf = Buffer.from(base)
      const flips = 1 + Math.floor(rand() * 8)
      for (let k = 0; k < flips; k++) {
        const at = Math.floor(rand() * buf.length)
        buf[at] = Math.floor(rand() * 256)
      }
      const fn = i % 2 === 0 ? docxText : pptxText
      fast(() => {
        try {
          fn(buf)
        } catch (err) {
          assert.ok(err instanceof ExtractError, `第 ${i} 次：丟了 ${err?.constructor?.name}: ${err?.message}`)
          // 有 cause 代表是被最外層的保險包起來的意外錯誤（程式 bug），不是刻意判斷出來的
          assert.equal(err.cause, undefined, `第 ${i} 次：意外錯誤 ${err.cause?.stack}`)
        }
      }, 2000)
    }
  })
})

describe('Word 邊界', () => {
  test('不在 <w:del> 裡的 <w:t> 才算；<w:del> 裡就算寫成 <w:t> 也不算', () => {
    const buf = makeDocx('<w:p><w:del w:id="1"><w:r><w:t>不該出現</w:t></w:r></w:del><w:r><w:t>留下</w:t></w:r></w:p>')
    assert.equal(docxText(buf).text, '留下')
  })

  test('修訂模式的移動：只算移到的位置（moveTo），不重複', () => {
    const buf = makeDocx('<w:p><w:moveFrom w:id="1"><w:r><w:t>搬家</w:t></w:r></w:moveFrom><w:r><w:t>中間</w:t></w:r><w:moveTo w:id="2"><w:r><w:t>搬家</w:t></w:r></w:moveTo></w:p>')
    assert.equal(docxText(buf).text, '中間搬家')
  })

  test('隱藏文字（<w:vanish/>）不算；w:val="false" 照算；段落標記的 vanish 不影響字', () => {
    const buf = makeDocx('<w:p><w:pPr><w:rPr><w:vanish/></w:rPr></w:pPr><w:r><w:rPr><w:vanish/></w:rPr><w:t>隱藏</w:t></w:r><w:r><w:rPr><w:vanish w:val="false"/></w:rPr><w:t>看</w:t></w:r><w:r><w:t>得到</w:t></w:r></w:p>')
    assert.equal(docxText(buf).text, '看得到')
  })

  test('功能變數代碼（instrText）不算，顯示結果算', () => {
    const buf = makeDocx('<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "http://x" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>連結</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>')
    assert.equal(docxText(buf).text, '連結')
  })

  test('文字方塊的 mc:Fallback 不重複算', () => {
    const box = '<w:txbxContent><w:p><w:r><w:t>文字方塊</w:t></w:r></w:p></w:txbxContent>'
    const buf = makeDocx(`<w:p><w:r><w:t>前</w:t></w:r><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>${box}</w:drawing></mc:Choice><mc:Fallback><w:pict><v:textbox>${box}</v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`)
    assert.equal(docxText(buf).text.split('文字方塊').length - 1, 1)
  })

  test('xml:space、CDATA、註解、處理指令、屬性值裡的 >', () => {
    const buf = makeDocx('<w:p><!-- <w:t>註解</w:t> --><?pi <w:t>PI</w:t> ?><w:r><w:rPr><w:rFonts w:ascii="a>b"/></w:rPr><w:t>前</w:t><w:t xml:space="preserve"> 中 </w:t><w:t><![CDATA[<後>&amp;]]></w:t></w:r></w:p>')
    assert.equal(docxText(buf).text, '前 中 <後>&amp;')
  })

  test('連續空段落最多留一個空行；開頭與結尾的換行拿掉', () => {
    const buf = makeDocx('<w:p/><w:p/><w:p><w:r><w:t>一</w:t></w:r></w:p><w:p/><w:p/><w:p/><w:p><w:r><w:t>二</w:t></w:r></w:p><w:p/><w:p/>')
    assert.equal(docxText(buf).text, '一\n\n二')
  })

  test('主文件的位置照 _rels/.rels；沒有 _rels 就用 word/document.xml', () => {
    const moved = makeDocx('<w:p><w:r><w:t>在別的地方</w:t></w:r></w:p>', { docPath: 'word/document2.xml' })
    assert.equal(docxText(moved).text, '在別的地方')
    const noRels = makeDocx('<w:p><w:r><w:t>沒有 rels</w:t></w:r></w:p>', { rels: false })
    assert.equal(docxText(noRels).text, '沒有 rels')
  })

  test('沒有主文件 → CORRUPT；把 pptx 當 docx 讀 → UNSUPPORTED', () => {
    throwsCode(() => docxText(buildZip([{ name: 'a.txt', data: 'x' }])), 'CORRUPT')
    throwsCode(() => docxText(makePptx([sp('x')])), 'UNSUPPORTED')
  })

  test('整份 docx 在 zip 層加密 → ENCRYPTED', () => {
    throwsCode(() => docxText(fx('encrypted.docx')), 'ENCRYPTED')
  })

  test('Office 密碼保護的檔案（OLE 容器，裡面有 EncryptedPackage）→ ENCRYPTED；舊版 .doc → UNSUPPORTED', () => {
    const ole = Buffer.alloc(2048)
    Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(ole, 0)
    Buffer.from('EncryptedPackage', 'utf16le').copy(ole, 1024)
    throwsCode(() => docxText(ole), 'ENCRYPTED')
    throwsCode(() => pptxText(ole), 'ENCRYPTED')
    const legacy = Buffer.alloc(2048)
    Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(legacy, 0)
    Buffer.from('WordDocument', 'utf16le').copy(legacy, 1024)
    throwsCode(() => docxText(legacy), 'UNSUPPORTED')
  })

  test('maxChars：以字（code point）計，不切半個 emoji', () => {
    const buf = makeDocx('<w:p><w:r><w:t>abcde</w:t></w:r></w:p>')
    assert.deepEqual(docxText(buf, { maxChars: 5 }), { text: 'abcde', truncated: false })
    assert.deepEqual(docxText(buf, { maxChars: 3 }), { text: 'abc', truncated: true })
    const emoji = makeDocx('<w:p><w:r><w:t>😀😀😀</w:t></w:r></w:p>')
    assert.deepEqual(docxText(emoji, { maxChars: 2 }), { text: '😀😀', truncated: true })
  })

  test('預設上限 20,000 字', () => {
    const one = docxText(makeDocx(`<w:p><w:r><w:t>${'字'.repeat(25000)}</w:t></w:r></w:p>`))
    assert.equal(one.text, '字'.repeat(20000))
    assert.equal(one.truncated, true)
    // 很多段落：換行也算字數，結尾不留換行
    const para = `<w:p><w:r><w:t>${'字'.repeat(999)}</w:t></w:r></w:p>`
    const many = docxText(makeDocx(para.repeat(25)))
    assert.ok([...many.text].length <= 20000 && [...many.text].length > 19900)
    assert.ok(!many.text.endsWith('\n'))
    assert.equal(many.truncated, true)
  })

  test('billion laughs：DOCTYPE 裡定義的實體一律不展開', () => {
    let dtd = '<!DOCTYPE w:document [<!ENTITY lol "lol">'
    for (let i = 1; i < 10; i++) dtd += `<!ENTITY lol${i} "${`&lol${i - 1 || ''};`.repeat(10)}">`
    dtd += ']>'
    const xml = documentXml('<w:p><w:r><w:t>&lol9;</w:t></w:r></w:p>', dtd)
    const { text } = fast(() => docxText(makeDocx('', { xml })))
    assert.equal(text, '&lol9;')
  })

  test('不合法的數字實體不會當掉：&#0; &#xD800; &#x110000; 變成 U+FFFD；不認得的實體原樣保留', () => {
    const buf = makeDocx('<w:p><w:r><w:t>[&#0;][&#xD800;][&#x110000;][&#99999999999999999999;][&nbsp;][&#x;][&#12a;][&]</w:t></w:r></w:p>')
    assert.equal(docxText(buf).text, '[\uFFFD][\uFFFD][\uFFFD][\uFFFD][&nbsp;][&#x;][&#12a;][&]')
  })

  test('惡意 XML 不會卡住：大量 &、大量沒配對的結尾標籤、超深巢狀、沒收尾的標籤', () => {
    const amps = makeDocx(`<w:p><w:r><w:t>${'&'.repeat(2_000_000)}</w:t></w:r></w:p>`)
    assert.equal(fast(() => docxText(amps)).truncated, true)

    const closers = makeDocx('<w:x>'.repeat(900) + '</w:y>'.repeat(1_000_000) + '<w:p><w:r><w:t>還在</w:t></w:r></w:p>')
    assert.ok(fast(() => docxText(closers)).text.includes('還在'))

    const deep = makeDocx('<w:x>'.repeat(200_000) + '<w:p><w:r><w:t>深</w:t></w:r></w:p>')
    fast(() => throwsCode(() => docxText(deep), 'CORRUPT'))

    for (const tail of ['<w:p><w:r><w:t>沒收尾', '<w:p><w:r a="沒有結尾的引號', '<', '<!--', '<![CDATA[', '<?', '<!DOCTYPE [', '</']) {
      const xml = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${tail}`
      fast(() => {
        try {
          docxText(makeDocx('', { xml }))
        } catch (err) {
          assert.ok(err instanceof ExtractError, err?.message)
        }
      })
    }
  })

  test('UTF-16 的 document.xml 也讀得到', () => {
    const xml = documentXml('<w:p><w:r><w:t>十六位元</w:t></w:r></w:p>').replace('encoding="UTF-8"', 'encoding="UTF-16"')
    const data = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')])
    const buf = buildZip([
      { name: '_rels/.rels', data: '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
      { name: 'word/document.xml', data },
    ])
    assert.equal(docxText(buf).text, '十六位元')
  })
})

describe('PowerPoint 邊界', () => {
  test('投影片之間空一行；投影片內段落只換一行、空段落不留', () => {
    const buf = makePptx([sp('標題', '', '內文'), sp('第二張')])
    assert.equal(pptxText(buf).text, '標題\n內文\n\n第二張')
  })

  test('<a:br/> 是換行；表格儲存格都算', () => {
    const slide = '<p:sp><p:txBody><a:bodyPr/><a:p><a:r><a:t>上</a:t></a:r><a:br/><a:r><a:t>下</a:t></a:r></a:p></p:txBody></p:sp>'
      + '<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>格一</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>格二</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
    assert.equal(pptxText(makePptx([slide])).text, '上\n下\n格一\n格二')
  })

  test('空白投影片不佔分隔行，但 slides 照算', () => {
    const buf = makePptx([sp('一'), sp(''), sp('三')])
    assert.deepEqual(pptxText(buf), { text: '一\n\n三', slides: 3, truncated: false })
  })

  test('maxSlides：只讀前 N 張（照顯示順序），標 truncated', () => {
    const buf = makePptx([sp('S1'), sp('S2'), sp('S3')], { order: [2, 0, 1] })
    assert.deepEqual(pptxText(buf, { maxSlides: 2 }), { text: 'S3\n\nS1', slides: 3, truncated: true })
  })

  test('maxChars：跨投影片也照算', () => {
    const buf = makePptx([sp('abc'), sp('def')])
    // 分隔用的換行不會留在結尾
    assert.deepEqual(pptxText(buf, { maxChars: 4 }), { text: 'abc', slides: 2, truncated: true })
  })

  test('rels 找不到、目標檔不存在、外部連結、重複指向同一張：都跳過', () => {
    const relsExtra = '<Relationship Id="rId90" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/nope.xml"/>'
      + '<Relationship Id="rId91" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="http://evil.example/s.xml" TargetMode="External"/>'
    const buf = makePptx([sp('A'), sp('B')], { sldIds: ['rId2', 'rId404', 'rId90', 'rId91', 'rId3', 'rId2'], relsExtra })
    assert.deepEqual(pptxText(buf), { text: 'A\n\nB', slides: 2, truncated: false })
  })

  test('rels 的 Target 用絕對路徑、../ 也解得開', () => {
    const abs = makePptx([sp('絕對')], { targetPrefix: '/ppt/slides/' })
    assert.equal(pptxText(abs).text, '絕對')
    const rel = makePptx([sp('相對')], { targetPrefix: '../ppt/./slides/' })
    assert.equal(pptxText(rel).text, '相對')
  })

  test('實體要解', () => {
    assert.equal(pptxText(makePptx([sp('A &amp; B &#x8CC7;')])).text, 'A & B 資')
  })

  test('沒有 presentation.xml → CORRUPT；把 docx 當 pptx 讀 → UNSUPPORTED', () => {
    throwsCode(() => pptxText(buildZip([{ name: 'a.txt', data: 'x' }])), 'CORRUPT')
    throwsCode(() => pptxText(makeDocx('<w:p/>')), 'UNSUPPORTED')
  })

  test('mc:Fallback 不重複算', () => {
    const inner = `<mc:AlternateContent><mc:Choice Requires="p14">${sp('一次')}</mc:Choice><mc:Fallback>${sp('一次')}</mc:Fallback></mc:AlternateContent>`
    assert.equal(pptxText(makePptx([inner])).text, '一次')
  })

  test('sldIdLst 最多讀 5,000 個 sldId：剛好 5,000 讀完；5,001 回傳讀到的、標 truncated；讀不到字才丟 TOO_LARGE', () => {
    // zip 最多 5,000 個 entry，真的簡報不可能有更多投影片；超過一定是重複或指不到的 sldId
    const ok = makePptx([sp('只有一張')], { sldIds: new Array(5000).fill('rId2') })
    assert.deepEqual(pptxText(ok), { text: '只有一張', slides: 1, truncated: false })
    // 第三輪規格：預算用完回部分結果（第二輪這裡整份丟 TOO_LARGE，是退化）
    const over = makePptx([sp('只有一張')], { sldIds: new Array(5001).fill('rId2') })
    assert.deepEqual(pptxText(over), { text: '只有一張', slides: 1, truncated: true })
    const many = makePptx([sp('')], { sldIds: new Array(100_000).fill('rId2') })
    fast(() => throwsCode(() => pptxText(many), 'TOO_LARGE'))
  })
})

describe('純文字邊界', () => {
  test('UTF-8 在多位元組字中間被截斷：還是 UTF-8，丟掉不完整的尾巴', () => {
    const bytes = Buffer.from('資料結構', 'utf8')
    assert.deepEqual(decodeText(bytes.subarray(0, bytes.length - 1)), { text: '資料結', encoding: 'utf-8', truncated: false })
  })

  test('Windows-1252 的彎引號、字中間的重音字母：不會被當成 Big5', () => {
    // 0x92 0x74 在 Node 的 Big5 解碼器會變成私用區字元（不是 U+FFFD），要一樣視為解不開
    assert.deepEqual(decodeText(Buffer.from([0x64, 0x6f, 0x6e, 0x92, 0x74])), { text: 'don\u2019t', encoding: 'windows-1252', truncated: false })
    // r é s u m é：é s 會湊成一個合法的 Big5 字，但結尾的 é 不完整 → 不能因為「前面有中文」就容忍
    assert.deepEqual(decodeText(Buffer.from('résumé', 'latin1')), { text: 'résumé', encoding: 'windows-1252', truncated: false })
    // 0xFF 在 Node 的 Big5 解碼器會變成私用區字元
    assert.deepEqual(decodeText(Buffer.from([0x41, 0xff, 0x42])), { text: 'AÿB', encoding: 'windows-1252', truncated: false })
  })

  test('純 ASCII 是 UTF-8', () => {
    assert.deepEqual(decodeText(Buffer.from('hello, world\n')), { text: 'hello, world\n', encoding: 'utf-8', truncated: false })
  })

  test('只有 BOM：空字串', () => {
    assert.deepEqual(decodeText(Buffer.from([0xef, 0xbb, 0xbf])), { text: '', encoding: 'utf-8', truncated: false })
  })

  test('maxChars 以 code point 計、不切半個 emoji', () => {
    assert.deepEqual(decodeText(Buffer.from('😀😀😀'), { maxChars: 2 }), { text: '😀😀', encoding: 'utf-8', truncated: true })
  })

  test('超大輸入只看開頭，很快就回來', () => {
    const big = Buffer.alloc(64 * MB, 0x61)
    const r = fast(() => decodeText(big))
    assert.equal(r.text.length, 20000)
    assert.equal(r.truncated, true)
    assert.equal(r.encoding, 'utf-8')
  })

  test('超大的 Big5：不管切點落在字的邊界還是雙位元組字中間，都還是 Big5', () => {
    const big5 = fx('big5.txt').subarray(0, 8) // 「資料結構」8 bytes
    // 有兩個切點：判斷編碼只看開頭 65,536 byte（第四輪：固定，跟 maxChars 無關）；輸出最多解 (maxChars+1)*4+4 byte（預設 80,008）。
    // 前面墊 pad 個 'a'，後面全是 Big5：(切點 − pad) 是奇數，切點就落在一個雙位元組字的兩個 byte 中間
    const many = Buffer.concat(new Array(15000).fill(big5)) // 120,000 byte
    for (const pad of [0, 1]) {
      const buf = Buffer.concat([Buffer.alloc(pad, 0x61), many])
      for (const cut of [65_536, 80_008]) assert.equal((cut - pad) % 2 === 1, pad === 1, '前提：有沒有切在字中間')
      for (const maxChars of [undefined, 100, 40_000]) {
        const r = decodeText(buf, { maxChars })
        const n = maxChars ?? 20_000
        assert.equal(r.encoding, 'big5', `pad ${pad}，maxChars ${maxChars}`)
        assert.equal(r.truncated, true)
        assert.equal(r.text, ('a'.repeat(pad) + '資料結構'.repeat(15000)).slice(0, n))
      }
    }
  })
})

// =====================================================================
// 結構化亂數（性質測試）：隨機產生「答案已知」的輸入，比對輸出
// =====================================================================
describe('結構化亂數', () => {
  const ALPHABET = ['資', '料', '結', '構', 'a', 'Z', '0', ' ', '&', '<', '>', '"', "'", '😀', 'é', '、', '；', '#', ';']
  const escapeXml = (s, rand) => [...s].map(ch => {
    const r = rand()
    const cp = ch.codePointAt(0)
    if (ch === '&') return r < 0.5 ? '&amp;' : '&#38;'
    if (ch === '<') return r < 0.5 ? '&lt;' : '&#x3C;'
    if (ch === '>') return r < 0.3 ? '>' : '&gt;'
    if (ch === '"') return r < 0.5 ? '&quot;' : ch
    if (ch === "'") return r < 0.5 ? '&apos;' : ch
    if (r < 0.15) return `&#${cp};`
    if (r < 0.3) return `&#x${cp.toString(16)};`
    return ch
  }).join('')
  const word = (rand, min = 1, max = 8) => {
    const n = min + Math.floor(rand() * (max - min + 1))
    let s = ''
    for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)]
    return s
  }
  const visibleWord = rand => {
    let w = word(rand)
    if (!/\S/.test(w)) w += '字'
    return w
  }

  test('docx：隨機段落＋隨機實體寫法＋隨機穿插刪除／隱藏／Fallback，輸出等於看得到的字', () => {
    const rand = rng(1)
    for (let iter = 0; iter < 200; iter++) {
      const paragraphs = []
      let body = ''
      const pn = 1 + Math.floor(rand() * 6)
      for (let p = 0; p < pn; p++) {
        let visible = ''
        let xml = '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>'
        const rn = 1 + Math.floor(rand() * 5)
        for (let r = 0; r < rn; r++) {
          const w = visibleWord(rand)
          const kind = rand()
          if (kind < 0.15) {
            xml += `<w:del w:id="${r}"><w:r><w:delText>${escapeXml(word(rand), rand)}</w:delText></w:r></w:del>`
          } else if (kind < 0.25) {
            xml += `<w:r><w:rPr><w:vanish/></w:rPr><w:t>${escapeXml(word(rand), rand)}</w:t></w:r>`
          } else if (kind < 0.3) {
            xml += `<w:r><mc:AlternateContent><mc:Choice Requires="x"><w:t>${escapeXml(w, rand)}</w:t></mc:Choice><mc:Fallback><w:t>${escapeXml(word(rand), rand)}</w:t></mc:Fallback></mc:AlternateContent></w:r>`
            visible += w
          } else if (kind < 0.4) {
            xml += `<w:r><w:t xml:space="preserve">${escapeXml(w, rand)}</w:t><w:tab/></w:r>`
            visible += `${w}\t`
          } else {
            xml += `<w:ins w:id="${r}"><w:r><w:t>${escapeXml(w, rand)}</w:t></w:r></w:ins>`
            visible += w
          }
        }
        xml += '</w:p>'
        if (/\S/.test(visible)) {
          paragraphs.push(visible)
          body += xml
        }
      }
      const expected = paragraphs.join('\n')
      const { text, truncated } = docxText(makeDocx(body))
      assert.equal(text, expected, `第 ${iter} 次\n${body}`)
      assert.equal(truncated, false)
      // 任意 maxChars：輸出是完整答案的前綴、不超過上限；丟掉的部分有非空白字才標 truncated
      const cps = [...expected]
      const max = Math.floor(rand() * (cps.length + 3))
      const cut = docxText(makeDocx(body), { maxChars: max })
      assert.ok(expected.startsWith(cut.text), `第 ${iter} 次 maxChars=${max}`)
      const kept = [...cut.text].length
      assert.ok(kept <= max)
      assert.equal(cut.truncated, /\S/.test(cps.slice(kept).join('')), `第 ${iter} 次 maxChars=${max}`)
    }
  })

  test('pptx：隨機排列 sldIdLst，輸出順序一定照 sldIdLst', () => {
    const rand = rng(2)
    for (let iter = 0; iter < 100; iter++) {
      const n = 1 + Math.floor(rand() * 9)
      const labels = Array.from({ length: n }, (_, i) => `投影片${i}-${visibleWord(rand).replace(/\s/g, '')}`)
      const order = labels.map((_, i) => i)
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1))
        ;[order[i], order[j]] = [order[j], order[i]]
      }
      const buf = makePptx(labels.map(l => sp(escapeXml(l, rand))), { order, notes: labels.map(() => '備忘') })
      const { text, slides } = pptxText(buf)
      assert.equal(slides, n)
      assert.equal(text, order.map(i => labels[i]).join('\n\n'), `第 ${iter} 次 order=${order}`)
    }
  })

  test('zip：隨機 entry（stored／deflate、data descriptor、local extra 長度）讀回來一模一樣', () => {
    const rand = rng(3)
    for (let iter = 0; iter < 100; iter++) {
      const n = 1 + Math.floor(rand() * 6)
      const entries = []
      for (let i = 0; i < n; i++) {
        const len = Math.floor(rand() * 3000)
        const data = Buffer.alloc(len)
        for (let k = 0; k < len; k++) data[k] = rand() < 0.5 ? 0x61 : Math.floor(rand() * 256)
        entries.push({
          name: `dir${i}/檔案${i}.bin`,
          data,
          method: rand() < 0.5 ? 0 : 8,
          dataDescriptor: rand() < 0.5,
          localExtra: Buffer.alloc(Math.floor(rand() * 40), 7),
          centralExtra: Buffer.alloc(Math.floor(rand() * 40), 9),
        })
      }
      const out = readAll(buildZip(entries))
      assert.deepEqual(Object.keys(out), entries.map(e => e.name))
      for (const e of entries) assert.ok(out[e.name].equals(e.data), `第 ${iter} 次 ${e.name}`)
    }
  })

  test('decodeText：隨機 Unicode 字串用 UTF-8 編碼，解回來一樣；maxChars 切在 code point 邊界', () => {
    const rand = rng(4)
    const pick = () => {
      const r = rand()
      if (r < 0.4) return String.fromCodePoint(0x20 + Math.floor(rand() * 0x5f))
      if (r < 0.7) return String.fromCodePoint(0x4e00 + Math.floor(rand() * 0x5000))
      if (r < 0.85) return String.fromCodePoint(0x1f300 + Math.floor(rand() * 0x300))
      return String.fromCodePoint(0xa0 + Math.floor(rand() * 0x700))
    }
    for (let iter = 0; iter < 300; iter++) {
      const cps = Array.from({ length: 1 + Math.floor(rand() * 60) }, pick)
      const s = cps.join('')
      const max = Math.floor(rand() * 70)
      const r = decodeText(Buffer.from(s, 'utf8'), { maxChars: max })
      assert.equal(r.encoding, 'utf-8')
      assert.equal(r.text, cps.slice(0, max).join(''))
      assert.equal(r.truncated, cps.length > max)
    }
  })

  test('XML 層亂改：隨機插入／刪除 < > & " 與標籤片段，只會回傳或丟 ExtractError', () => {
    const rand = rng(5)
    const base = documentXml('<w:p><w:r><w:t>資料 &amp; 結構</w:t><w:tab/><w:br/></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>x</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:del><w:r><w:delText>d</w:delText></w:r></w:del></w:p>')
    const junk = ['<', '>', '&', '"', "'", '</w:p>', '<w:p>', '<w:t>', '</w:t>', '<!--', '-->', '<![CDATA[', ']]>', '&#x', ';', '<?', '?>', '<!DOCTYPE [', ']', '/>', '<w:r ', 'w:val="', '&amp']
    for (let iter = 0; iter < 500; iter++) {
      let xml = base
      const ops = 1 + Math.floor(rand() * 6)
      for (let k = 0; k < ops; k++) {
        const at = Math.floor(rand() * xml.length)
        if (rand() < 0.6) xml = xml.slice(0, at) + junk[Math.floor(rand() * junk.length)] + xml.slice(at)
        else xml = xml.slice(0, at) + xml.slice(at + Math.floor(rand() * 20))
      }
      fast(() => {
        try {
          const r = docxText(makeDocx('', { xml }))
          assert.equal(typeof r.text, 'string')
        } catch (err) {
          assert.ok(err instanceof ExtractError, `第 ${iter} 次：${err?.constructor?.name}: ${err?.message}`)
          assert.equal(err.cause, undefined, `第 ${iter} 次：意外錯誤 ${err.cause?.stack}`)
        }
      }, 1000)
    }
  })
})

// =====================================================================
// 對抗式驗證（第二輪）的發現：每一條先寫成測試（修之前是紅的），再修
// =====================================================================
const REL_OFFICE_DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'
const REL_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide'

/** _rels/.rels：前面 junk 筆不相干的 Relationship，最後一筆指到主文件。 */
function rootRelsWithJunk(junk, main = 'word/document.xml') {
  const parts = ['<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">']
  for (let i = 0; i < junk; i++) parts.push(`<Relationship Id="j${i}" Type="x" Target="junk${i}.xml"/>`)
  parts.push(`<Relationship Id="main" Type="${REL_OFFICE_DOC}" Target="${main}"/></Relationships>`)
  return parts.join('')
}

const docxWithRootRels = (rels, docPath = 'word/document.xml', text = '主文件') => buildZip([
  { name: '_rels/.rels', data: rels },
  { name: docPath, data: documentXml(`<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`) },
])

describe('confirmed：解析時的記憶體放大（rels、sldIdLst、屬性、Target、實體）', () => {
  test('_rels/.rels 最多讀 10,000 筆 Relationship：主文件在第 10,000 筆照讀；在第 10,001 筆就沒讀到', () => {
    assert.deepEqual(docxText(docxWithRootRels(rootRelsWithJunk(9999))), { text: '主文件', truncated: false })
    // 主文件排第一、後面還有 10,000 筆：讀到的部分裡就有，結果完整
    const first = `<Relationships><Relationship Id="main" Type="${REL_OFFICE_DOC}" Target="word/document.xml"/>${rootRelsWithJunk(10_000).replace(/^<Relationships[^>]*>/, '')}`
    assert.deepEqual(docxText(docxWithRootRels(first)), { text: '主文件', truncated: false })
    // 第三輪規格：預算用完回部分結果。主文件那筆沒讀到，退回預設位置 word/document.xml 讀；不確定是不是真的主文件，標 truncated
    assert.deepEqual(docxText(docxWithRootRels(rootRelsWithJunk(10_000))), { text: '主文件', truncated: true })
    // 預設位置也沒有：一個字都沒讀到才丟 TOO_LARGE
    throwsCode(() => docxText(docxWithRootRels(rootRelsWithJunk(10_000, 'word/document2.xml'), 'word/document2.xml')), 'TOO_LARGE')
    // 對照：筆數沒超過、只是找不到主文件，還是 CORRUPT
    throwsCode(() => docxText(docxWithRootRels(rootRelsWithJunk(3, 'word/nope.xml'), 'word/document2.xml')), 'CORRUPT')
  })

  test('presentation.xml.rels 也最多讀 10,000 筆：用到的關聯在前面就完整；在後面就標 truncated，一張都沒有才丟 TOO_LARGE', () => {
    // makePptx 自己就有 2 筆（母片 rId1、投影片 rId2），relsExtra 接在後面
    const junk = n => Array.from({ length: n }, (_, i) => `<Relationship Id="j${i}" Type="${REL_SLIDE}" Target="slides/nope${i}.xml"/>`).join('')
    assert.deepEqual(pptxText(makePptx([sp('A')], { relsExtra: junk(9998) })), { text: 'A', slides: 1, truncated: false })
    // 10,001 筆：沒讀到的是最後一筆 junk，sldIdLst 用到的 rId2 讀到了，結果完整
    assert.deepEqual(pptxText(makePptx([sp('A')], { relsExtra: junk(9999) })), { text: 'A', slides: 1, truncated: false })
    // 第 10,001 筆剛好是 sldIdLst 用到的：可能在沒讀的那段裡，標 truncated
    const late = `${junk(9998)}<Relationship Id="late" Type="${REL_SLIDE}" Target="slides/slide2.xml"/>`
    assert.deepEqual(pptxText(makePptx([sp('A'), sp('B')], { sldIds: ['rId2', 'late'], relsExtra: late })), { text: 'A', slides: 1, truncated: true })
    throwsCode(() => pptxText(makePptx([sp('A'), sp('B')], { sldIds: ['late'], relsExtra: late })), 'TOO_LARGE')
    // 對照：筆數沒超過、只是指不到，照舊跳過、不標 truncated
    assert.deepEqual(pptxText(makePptx([sp('A')], { sldIds: ['rId2', 'rId404'] })), { text: 'A', slides: 1, truncated: false })
  })

  test('一個標籤只看前 64 個屬性：Target 排在第 64 個還算，排在第 65 個就當沒有', () => {
    const junkAttrs = n => Array.from({ length: n }, (_, i) => `a${i}="${i}"`).join(' ')
    const rels = n => `<Relationships><Relationship ${junkAttrs(n)} Id="rId1" Type="${REL_OFFICE_DOC}" Target="word/document2.xml"/></Relationships>`
    // 61 個不相干的＋Id、Type、Target：Target 是第 64 個
    assert.equal(docxText(docxWithRootRels(rels(61), 'word/document2.xml')).text, '主文件')
    // 62 個：Target 變成第 65 個，這筆 Relationship 不完整；預設位置 word/document.xml 也沒有 → CORRUPT
    throwsCode(() => docxText(docxWithRootRels(rels(62), 'word/document2.xml')), 'CORRUPT')
  })

  test('Target 超過 196,605 字元（zip 檔名最長 65,535 byte，百分比編碼最多 3 倍）一律當成指不到', () => {
    // './' 會被正規化掉，所以這兩個 Target 正規化之後都是 ppt/slides/slide1.xml
    const exact = `${'./'.repeat(98_294)}slides/slide1.xml`
    const over = `${'./'.repeat(98_294)}slides//slide1.xml`
    assert.equal(exact.length, 196_605)
    assert.equal(over.length, 196_606)
    const deck = target => makePptx([sp('投影片')], {
      sldIds: ['rIdLong'],
      relsExtra: `<Relationship Id="rIdLong" Type="${REL_SLIDE}" Target="${target}"/>`,
    })
    assert.deepEqual(pptxText(deck(exact)), { text: '投影片', slides: 1, truncated: false })
    assert.deepEqual(pptxText(deck(over)), { text: '', slides: 0, truncated: false })
  })

  test('大量實體分塊接起來：6,000 個實體（超過一塊 4,096 段）解出來一字不差', () => {
    const buf = makeDocx(`<w:p><w:r><w:t>${'x&amp;y&#x8CC7;'.repeat(3000)}z</w:t></w:r></w:p>`)
    assert.deepEqual(docxText(buf), { text: `${'x&y資'.repeat(3000)}z`, truncated: false })
    assert.equal(pptxText(makePptx([sp(`${'&lt;&gt;'.repeat(5000)}!`)])).text, `${'<>'.repeat(5000)}!`)
  })

  test('指不到的 Target（太長、空的、只有 ../）不會剛好對上 zip 裡檔名是空字串的 entry', () => {
    const blank = { name: '', data: slideXml(sp('空檔名')) }
    for (const target of [`${'./'.repeat(98_294)}slides//slide1.xml`, '', '../..']) {
      const buf = makePptx([sp('投影片')], {
        sldIds: ['rIdX'],
        relsExtra: `<Relationship Id="rIdX" Type="${REL_SLIDE}" Target="${target}"/>`,
        extra: [blank],
      })
      assert.deepEqual(pptxText(buf), { text: '', slides: 0, truncated: false }, `Target 長度 ${target.length}`)
    }
  })

  // 修之前：這些檔案（XML 48 MB、壓縮後幾十 KB 到幾 MB）解析時吃掉 XML 大小的 5～20 倍記憶體，
  // 在 heap 上限 PROBE_HEAP_MB 的子行程裡會整個 OOM（signal 6，try/catch 接不住）。
  // 修之後：記憶體只跟 XML 本身差不多，結果是 TOO_LARGE 或正常回傳。
  const PROBE = fileURLToPath(new URL('./helpers/office-mem-probe.mjs', import.meta.url))
  const PROBE_HEAP_MB = 128
  const PROBE_XML_MB = 48
  const runProbe = kind => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${PROBE_HEAP_MB}`, PROBE, kind, String(PROBE_XML_MB)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
    child.on('error', reject)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
  // 第三個欄位是時間上限（子行程裡從產生檔案到讀完，不含 Node 啟動）
  const cases = [
    // 第三輪規格：_rels/.rels 沒讀完、主文件退回預設位置讀到了，標 truncated（第二輪是整份丟 TOO_LARGE）
    ['rels-count', { ok: true, chars: 5, truncated: true }, 20_000],
    ['pptx-rels-count', { ok: false, code: 'TOO_LARGE' }, 20_000],
    ['rel-target', { ok: true, chars: 5, truncated: false }, 20_000],
    ['rel-attrs', { ok: true, chars: 5, truncated: false }, 20_000],
    ['vanish-attrs', { ok: true, chars: 0, truncated: false }, 20_000],
    ['text-entities', { ok: true, chars: 20000, truncated: true }, 20_000],
    ['slide-entities', { ok: true, chars: 20000, truncated: true }, 20_000],
    // 第二輪驗證的 confirmed：主檔放在很長的資料夾裡，9,999 筆短 Target 的關聯（檔案只有幾百 KB）。
    // 修之前每筆都接上資料夾名稱留在記憶體裡：16,000 字的資料夾是 160 MB、65,000 字是 650 MB，三種都 OOM。
    ['pptx-long-basedir', { ok: true, chars: 5, truncated: false }, 3000],
    ['pptx-long-basedir-slashes', { ok: true, chars: 5, truncated: false }, 3000],
    // 資料夾名稱 65,000 字：主檔的檔名超過 16,383 byte，zip 裡當成不存在
    ['pptx-long-basedir-65000', { ok: false, code: 'CORRUPT' }, 3000],
  ]
  describe(`heap 只有 ${PROBE_HEAP_MB} MB 的子行程讀惡意檔（XML ${PROBE_XML_MB} MB，或幾百 KB 的放大檔）：不 OOM、不卡住`, { concurrency: 4 }, () => {
    for (const [kind, expected, maxMs] of cases) {
      test(kind, async () => {
        const { code, signal, stdout, stderr } = await runProbe(kind)
        assert.equal(signal, null, `子行程被 ${signal} 殺掉：${stderr.slice(0, 400)}`)
        assert.equal(code, 0, `子行程結束碼 ${code}：${stderr.slice(0, 400)}`)
        const r = JSON.parse(stdout)
        const got = r.ok ? { ok: true, chars: r.chars, truncated: r.truncated } : { ok: false, code: r.code }
        assert.deepEqual(got, expected, stdout)
        assert.ok(r.ms < maxMs, `花了 ${r.ms} ms，超過 ${maxMs} ms`)
      })
    }
  })
})

describe('minor／nit：第二輪驗證的其他發現', () => {
  test('結尾標籤最多往下找 16 層：隔 15 層找得到，隔 16 層就當成對不上、忽略（防平方時間的規則）', () => {
    // 找得到 </w:t> 時「乙」已經在 <w:t> 外面，不算；找不到時 </w:t> 被忽略，「乙」還在 <w:t> 裡面
    const doc = wrappers => makeDocx(`<w:p><w:r><w:t>甲${'<w:x>'.repeat(wrappers)}</w:t>乙</w:r></w:p>`)
    assert.equal(docxText(doc(15)).text, '甲')
    assert.equal(docxText(doc(16)).text, '甲乙')
  })

  test('防平方時間：1,015 層＋700 萬個對不上的結尾標籤（42 MB）也很快', () => {
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    const xml = `<w:document xmlns:w="${W}"><w:body>${'<w:x>'.repeat(1015)}${'</w:y>'.repeat(7_000_000)}<w:p><w:r><w:t>還在</w:t></w:r></w:p></w:body></w:document>`
    const buf = buildZip([{ name: '_rels/.rels', data: rootRels('word/document.xml') }, { name: 'word/document.xml', data: xml, method: 0 }])
    // 有上限時這台機器約 0.4 秒；拿掉上限要 15 秒
    assert.ok(fast(() => docxText(buf), 3000).text.includes('還在'))
  })

  test('解壓一定帶上限：宣稱 1 KB 的 entry，解壓吐出來的量從不超過 1 KB（不靠計時）', () => {
    const buf = buildZip([{ name: 'bomb.bin', raw: deflateZeros(64, zlib), uncompSize: 1024, crc: 0 }])
    const real = zlib.inflateRawSync
    let calls = 0
    let largest = 0
    zlib.inflateRawSync = (input, options) => {
      calls++
      const out = real(input, options)
      largest = Math.max(largest, out.length)
      return out
    }
    syncBuiltinESMExports()
    try {
      throwsCode(() => readZip(buf).get('bomb.bin')(), 'CORRUPT')
    } finally {
      zlib.inflateRawSync = real
      syncBuiltinESMExports()
    }
    assert.ok(calls >= 1, '前提：解壓有經過 node:zlib 的 inflateRawSync')
    assert.ok(largest <= 1024, `解壓吐出了 ${largest} byte`)
  })

  test('EOCD 宣稱的 entry 數跟 central directory 實際的筆數不一樣 → CORRUPT', () => {
    throwsCode(() => readZip(buildZip([{ name: 'a', data: 'x' }], { eocd: { count: 2 } })), 'CORRUPT')
    throwsCode(() => readZip(buildZip([{ name: 'a', data: 'x' }, { name: 'b', data: 'y' }], { eocd: { count: 1 } })), 'CORRUPT')
  })

  test('sldIdLst 指到的不是投影片（例如母片）：跳過，不把母片上的字當成投影片', () => {
    const master = { name: 'ppt/slideMasters/slideMaster1.xml', data: slideXml(sp('母片上的字')) }
    const buf = makePptx([sp('投影片')], { sldIds: ['rId1', 'rId2'], extra: [master] })
    assert.deepEqual(pptxText(buf), { text: '投影片', slides: 1, truncated: false })
  })

  test('修訂模式刪掉的段落標記：同一個容器裡前後兩段接成一段（del 的部分跟 LibreOffice「接受所有修訂」一樣）', () => {
    // 結構照 LibreOffice 做的跨段刪除 docx：被刪的段落標記寫在 <w:pPr><w:rPr><w:del/></w:rPr></w:pPr>
    const cross = '<w:p><w:pPr><w:rPr><w:del w:id="3" w:author="t" w:date="2026-09-19T10:00:00Z"></w:del></w:rPr></w:pPr><w:r><w:t>跨段前</w:t></w:r><w:del w:id="2"><w:r><w:delText>尾巴乙</w:delText></w:r></w:del></w:p>'
      + '<w:p><w:del w:id="4"><w:r><w:delText>開頭丙</w:delText></w:r></w:del><w:r><w:t>跨段後</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>下一段</w:t></w:r></w:p>'
    assert.equal(docxText(makeDocx(cross)).text, '跨段前跨段後\n下一段')
    // 整段連同段落標記一起刪掉：不留空行
    const whole = '<w:p><w:r><w:t>前</w:t></w:r></w:p><w:p><w:pPr><w:rPr><w:del w:id="1"/></w:rPr></w:pPr><w:del w:id="2"><w:r><w:delText>整段刪掉</w:delText></w:r></w:del></w:p><w:p><w:r><w:t>後</w:t></w:r></w:p>'
    assert.equal(docxText(makeDocx(whole)).text, '前\n後')
    // 段落標記被移走（moveFrom）：照 Word 的意思（這裡的段落標記不在了）也接起來；段落裡的隱藏字照樣不算。
    // 注意：LibreOffice 24.2 不處理段落標記上的 moveFrom（照樣換行），所以這一種沒有拿它當標準答案
    const moved = '<w:p><w:pPr><w:rPr><w:moveFrom w:id="1"/></w:rPr></w:pPr><w:r><w:rPr><w:vanish/></w:rPr><w:t>藏</w:t></w:r><w:r><w:t>甲</w:t></w:r></w:p><w:p><w:r><w:t>乙</w:t></w:r></w:p><w:p><w:r><w:t>丙</w:t></w:r></w:p>'
    assert.equal(docxText(makeDocx(moved)).text, '甲乙\n丙')
    // 插入的段落標記、一般段落的 rPr：照常換行
    const normal = '<w:p><w:pPr><w:rPr><w:ins w:id="1"/><w:b/></w:rPr></w:pPr><w:r><w:t>一</w:t></w:r></w:p><w:p><w:r><w:t>二</w:t></w:r></w:p>'
    assert.equal(docxText(makeDocx(normal)).text, '一\n二')
  })

  test('文字方塊的字自成一段，不黏在前後的字上', () => {
    const box = '<w:txbxContent><w:p><w:r><w:t>BOXTEXT</w:t></w:r></w:p></w:txbxContent>'
    const buf = makeDocx(`<w:p><w:r><w:t>before</w:t></w:r><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>${box}</w:drawing></mc:Choice><mc:Fallback><w:pict><v:textbox>${box}</v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r><w:r><w:t>after</w:t></w:r></w:p>`)
    assert.equal(docxText(buf).text, 'before\nBOXTEXT\nafter')
  })
})

describe('decodeText：呼叫端只讀了檔案開頭（partial）', () => {
  test('textHeadBytes：decodeText 最多只看開頭這麼多 byte（預設 80,008；判斷編碼固定看 65,536，所以不會更小）', () => {
    assert.equal(textHeadBytes(), 80_008)
    // 第四輪規格：編碼判斷跟 maxChars 無關、固定看開頭 64 KB，所以 maxChars 很小也要讀 65,536 byte（第二輪是 16）
    assert.equal(textHeadBytes(2), 65_536)
    assert.equal(textHeadBytes(16_382), 65_536)
    assert.equal(textHeadBytes(16_383), 65_540)
    assert.equal(textHeadBytes(100_000), 400_008)
    assert.equal(textHeadBytes({ maxChars: 2 }), textHeadBytes(), '不合法的參數用預設值')
  })

  test('partial：Big5 切在雙位元組字中間，還是 Big5，丟掉半個字，標 truncated', () => {
    const one = fx('big5.txt') // 「資料結構\n第3週：堆疊與佇列\n」
    const three = Buffer.concat([one, one, one])
    const cut = three.subarray(0, three.length - 2) // 拿掉結尾的換行和「列」的第二個 byte
    const expected = '資料結構\n第3週：堆疊與佇列\n'.repeat(3).slice(0, -2)
    assert.deepEqual(decodeText(cut, { partial: true }), { text: expected, encoding: 'big5', truncated: true })
  })

  test('partial：UTF-8 切在字中間、前面全是 ASCII，也還是 UTF-8', () => {
    const cut = Buffer.from('abc資', 'utf8').subarray(0, 5)
    assert.deepEqual(decodeText(cut, { partial: true }), { text: 'abc', encoding: 'utf-8', truncated: true })
  })

  test('partial：超過 64 KB、maxChars 大到輸出範圍超過判斷編碼的範圍，切在字中間也一樣丟掉半個字（Big5、UTF-8）', () => {
    const big5 = Buffer.concat(new Array(9000).fill(fx('big5.txt').subarray(0, 8))) // 72,000 byte
    assert.deepEqual(decodeText(big5.subarray(0, 71_999), { partial: true, maxChars: 100_000 }),
      { text: '資料結構'.repeat(9000).slice(0, 35_999), encoding: 'big5', truncated: true })
    // 前面 70,000 byte 都是 ASCII（判斷編碼只看到 ASCII），最後是切了一半的「資」
    const u8 = Buffer.concat([Buffer.alloc(70_000, 0x61), Buffer.from('資', 'utf8').subarray(0, 2)])
    assert.deepEqual(decodeText(u8, { partial: true, maxChars: 100_000 }), { text: 'a'.repeat(70_000), encoding: 'utf-8', truncated: true })
  })

  test('partial：沒切到字也標 truncated（後面還有沒讀的部分）', () => {
    assert.deepEqual(decodeText(Buffer.from('hello'), { partial: true }), { text: 'hello', encoding: 'utf-8', truncated: true })
  })

  test('只讀開頭 textHeadBytes(maxChars) byte 再加 partial，跟傳整個檔案的結果一模一樣（隨機內容）', () => {
    const rand = rng(6)
    const big5 = fx('big5.txt')
    const units = [Buffer.from('ab '), Buffer.from('資料😀', 'utf8'), big5.subarray(0, 8), Buffer.from([0xe9]), Buffer.from('\n')]
    for (let iter = 0; iter < 200; iter++) {
      // 大部分 maxChars 很小（textHeadBytes 是判斷編碼的 65,536）；有些大到輸出範圍超過 65,536（第四輪：兩段分開解）
      const maxChars = rand() < 0.8 ? Math.floor(rand() * 40) : 16_000 + Math.floor(rand() * 14_000)
      const mix = rand() < 0.5 ? [0, 1, 4] : [0, 2, 3, 4] // 一半 UTF-8、一半 Big5／latin1
      const chunks = []
      let len = 0
      while (len <= textHeadBytes(maxChars) + 20) {
        const u = units[mix[Math.floor(rand() * mix.length)]]
        chunks.push(u)
        len += u.length
      }
      const whole = Buffer.concat(chunks)
      const head = whole.subarray(0, textHeadBytes(maxChars))
      assert.deepEqual(decodeText(head, { maxChars, partial: true }), decodeText(whole, { maxChars }), `第 ${iter} 次`)
    }
  })
})

// =====================================================================
// 第三輪：第二輪驗證的發現（先寫成測試、修之前是紅的）＋第三輪的規格決定
// =====================================================================
const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const presentationXml = (sldIds, after = '') =>
  `<p:presentation xmlns:p="${P_NS}" xmlns:r="${R_NS}"><p:sldIdLst>${sldIds.map((id, k) => `<p:sldId id="${256 + k}" r:id="${id}"/>`).join('')}</p:sldIdLst>${after}</p:presentation>`

describe('confirmed（第三輪）：解 Target 時的放大，照實際產生的字串長度算預算', () => {
  /** 主檔放在 dir 底下；presentation.xml.rels 先放 junk 筆沒用到的投影片關聯，最後一筆才是 sldIdLst 用到的。 */
  const deckInDir = (dir, junk) => {
    const main = `${dir}/presentation.xml`
    const rels = []
    for (let i = 0; i < junk; i++) rels.push(`<Relationship Id="j${i}" Type="${REL_SLIDE}" Target="s${i}"/>`)
    rels.push(`<Relationship Id="real" Type="${REL_SLIDE}" Target="slides/slide1.xml"/>`)
    return buildZip([
      { name: '_rels/.rels', data: rootRels(main) },
      { name: main, data: presentationXml(['real']) },
      { name: `${dir}/_rels/presentation.xml.rels`, data: `<Relationships>${rels.join('')}</Relationships>` },
      { name: `${dir}/slides/slide1.xml`, data: slideXml(sp('投影片')) },
    ])
  }

  test('只解真的用到的關聯：16,000 字的資料夾底下 9,999 筆沒用到的關聯，不會把預算用完', () => {
    // 全部解開要 9,999 × 16,000 字＝1.6 億字（遠超過預算 4,194,304 字）；只解 sldIdLst 用到的那一筆才讀得到
    const buf = deckInDir('d'.repeat(16_000), 9_999)
    assert.deepEqual(fast(() => pptxText(buf), 2000), { text: '投影片', slides: 1, truncated: false })
  })

  test('解路徑的字數預算 4,194,304：剛好用完照讀；多 1 個字，最後那張沒解、標 truncated；重複指到同一筆不重複扣', () => {
    const BUDGET = 4_194_304
    const base = 'ppt' // 主檔 ppt/presentation.xml 所在的資料夾
    const n = 22
    // 每解一筆扣「資料夾＋Target」的長度。Target 用 ./ 墊長（解完還是 slides/slideN.xml），多一個字就把一個 / 寫成 //
    const pad = (core, len) => {
      const extra = len - core.length
      return `${'./'.repeat(extra >> 1)}${extra & 1 ? core.replace('/', '//') : core}`
    }
    const each = Math.floor(BUDGET / n) - base.length
    const lens = new Array(n).fill(each)
    lens[n - 1] = BUDGET - (n - 1) * (base.length + each) - base.length
    assert.ok(Math.max(...lens) <= 196_605, '前提：每個 Target 都沒超過 196,605 字（超過的直接當成指不到、不扣預算）')
    const labels = Array.from({ length: n }, (_, i) => `第${i + 1}張`)
    const deck = (lastExtra, sldIds) => {
      const relsExtra = lens.map((len, i) => {
        const target = pad(`slides/slide${i + 1}.xml`, len + (i === n - 1 ? lastExtra : 0))
        return `<Relationship Id="L${i}" Type="${REL_SLIDE}" Target="${target}"/>`
      }).join('')
      return makePptx(labels.map(l => sp(l)), { sldIds, relsExtra })
    }
    const all = labels.map((_, i) => `L${i}`)
    assert.equal(lens.reduce((s, len) => s + base.length + len, 0), BUDGET, '前提：剛好用完')
    // L0、L5 重複出現：同一筆只解一次，不重複扣（重複扣的話最後一張就解不到）
    const withDupes = ['L0', 'L0', ...all.slice(1, 6), 'L5', ...all.slice(6)]
    assert.deepEqual(pptxText(deck(0, withDupes)), { text: labels.join('\n\n'), slides: n, truncated: false })
    // 最後一個 Target 多 1 個字：預算差 1 個字，最後那張不解；讀到的照樣回傳（第三輪規格）
    assert.deepEqual(pptxText(deck(1, all)), { text: labels.slice(0, -1).join('\n\n'), slides: n - 1, truncated: true })
  })

  test('Relationship 的 Id 最長 255 字：255 字照讀，256 字當成沒有這筆', () => {
    const deck = id => makePptx([sp('投影片')], { sldIds: [id], relsExtra: `<Relationship Id="${id}" Type="${REL_SLIDE}" Target="slides/slide1.xml"/>` })
    assert.deepEqual(pptxText(deck('r'.repeat(255))), { text: '投影片', slides: 1, truncated: false })
    assert.deepEqual(pptxText(deck('r'.repeat(256))), { text: '', slides: 0, truncated: false })
    const root = id => `<Relationships><Relationship Id="${id}" Type="${REL_OFFICE_DOC}" Target="word/document2.xml"/></Relationships>`
    assert.equal(docxText(docxWithRootRels(root('m'.repeat(255)), 'word/document2.xml')).text, '主文件')
    throwsCode(() => docxText(docxWithRootRels(root('m'.repeat(256)), 'word/document2.xml')), 'CORRUPT')
  })

  test('1,500 筆 17,000 字的 Id（V8 只用長度當雜湊，同長度全擠在一起）很快就讀完', () => {
    const base = 'r'.repeat(16_994)
    const ids = Array.from({ length: 1500 }, (_, i) => base + String(i).padStart(6, '0'))
    const relsExtra = ids.map(id => `<Relationship Id="${id}" Type="${REL_SLIDE}" Target="slides/slide1.xml"/>`).join('')
    const buf = makePptx([sp('投影片')], { sldIds: ['rId2', ...ids], relsExtra })
    // 修之前這台機器約 2.3 秒（3,000 筆約 10 秒）
    assert.deepEqual(fast(() => pptxText(buf), 1000), { text: '投影片', slides: 1, truncated: false })
  })

  test('zip 的檔名最長 16,383 byte：16,383 照列，16,384 當成不存在（但還是算一個 entry）', () => {
    const buf = buildZip([{ name: 'n'.repeat(16_383), data: 'a' }, { name: 'm'.repeat(16_384), data: 'b' }, { name: 'ok.txt', data: 'c' }])
    assert.deepEqual([...readZip(buf).keys()].map(k => k.length), [16_383, 6])
    throwsCode(() => readZip(buf, { maxEntries: 2 }), 'TOO_LARGE')
  })

  test('3,000 個 17,000 byte 的檔名（central directory 約 51 MB）很快就讀完', () => {
    const base = 'n'.repeat(16_994)
    const entries = [{ name: 'a.txt', data: 'x', method: 0 }]
    for (let i = 1; i < 3000; i++) entries.push({ name: base + String(i).padStart(6, '0'), data: '', method: 0, localOffset: 0, noLocal: true })
    const buf = buildZip(entries)
    // 修之前這台機器約 13 秒
    assert.deepEqual([...fast(() => readZip(buf), 2000).keys()], ['a.txt'])
  })
})

describe('第三輪規格：預算用完時回傳讀到的部分（標 truncated），一個字都沒讀到才丟錯', () => {
  test('pptx：某一張投影片超過 zip 的單檔上限（50 MB）：跳過那張，其他照讀；全部都超過才丟 TOO_LARGE', () => {
    const big = { name: 'ppt/slides/big.xml', data: 'x', uncompSize: 50 * MB + 1 }
    const relsExtra = `<Relationship Id="big" Type="${REL_SLIDE}" Target="slides/big.xml"/>`
    const buf = makePptx([sp('A'), sp('B')], { sldIds: ['rId2', 'big', 'rId3'], relsExtra, extra: [big] })
    assert.deepEqual(pptxText(buf), { text: 'A\n\nB', slides: 3, truncated: true })
    throwsCode(() => pptxText(makePptx([sp('A')], { sldIds: ['big'], relsExtra, extra: [big] })), 'TOO_LARGE')
  })

  test('docx：巢狀超過 1,024 層時停在那裡，前面讀到的字照樣回傳並標 truncated', () => {
    const buf = makeDocx(`<w:p><w:r><w:t>前面</w:t></w:r></w:p>${'<w:x>'.repeat(2000)}<w:p><w:r><w:t>後面</w:t></w:r></w:p>`)
    assert.deepEqual(docxText(buf), { text: '前面', truncated: true })
    // 一個字都沒讀到：還是 CORRUPT（「惡意 XML 不會卡住」那一條）
    throwsCode(() => docxText(makeDocx(`${'<w:x>'.repeat(2000)}<w:p><w:r><w:t>後面</w:t></w:r></w:p>`)), 'CORRUPT')
  })

  test('pptx：投影片巢狀太深只停那一張，後面的照讀；presentation.xml 巢狀太深，前面列到的投影片照讀', () => {
    const deep = `${sp('二前')}${'<p:grpSp>'.repeat(1100)}${sp('二後')}`
    assert.deepEqual(pptxText(makePptx([sp('一'), deep, sp('三')])), { text: '一\n\n二前\n\n三', slides: 3, truncated: true })
    const buf = buildZip([
      { name: '_rels/.rels', data: rootRels('ppt/presentation.xml') },
      { name: 'ppt/presentation.xml', data: presentationXml(['rId2'], `${'<p:x>'.repeat(1100)}<p:sldIdLst><p:sldId r:id="rId3"/></p:sldIdLst>`) },
      { name: 'ppt/_rels/presentation.xml.rels', data: `<Relationships><Relationship Id="rId2" Type="${REL_SLIDE}" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="${REL_SLIDE}" Target="slides/slide2.xml"/></Relationships>` },
      { name: 'ppt/slides/slide1.xml', data: slideXml(sp('第一張')) },
      { name: 'ppt/slides/slide2.xml', data: slideXml(sp('第二張')) },
    ])
    assert.deepEqual(pptxText(buf), { text: '第一張', slides: 1, truncated: true })
  })
})

describe('minor（第三輪）：刪掉的段落標記只跟同一個容器裡的下一段接', () => {
  // 標準答案：LibreOffice 24.2「接受所有修訂」後匯出的純文字（test/fixtures/office-text/src/pmark-libreoffice.mjs 產生）
  const LO = JSON.parse(fx('pmark-libreoffice.json').toString('utf8')).cases
  const byName = name => LO.find(c => c.name === name)
  // LibreOffice 每個空段落都輸出一行空行，我們最多留一個空行：去掉空行後逐行比
  const lines = s => s.replace(/\r/g, '').split('\n').filter(l => /\S/.test(l)).join('\n')

  test('第二輪驗證的三個例子：表格前一段、儲存格最後一段、表格最後一格的段落標記被刪', () => {
    assert.equal(byName('beforeTable').libreoffice, '表前\n格一\n格二\n表後\n')
    assert.equal(docxText(makeDocx(byName('beforeTable').body)).text, '表前\n格一\n格二\n表後')
    assert.equal(byName('cellEnd').libreoffice, '格一\n格二\n表後\n')
    assert.equal(docxText(makeDocx(byName('cellEnd').body)).text, '格一\n格二\n表後')
    assert.equal(byName('lastCellThenPara').libreoffice, '前\n格一\n格二\n表後\n')
    assert.equal(docxText(makeDocx(byName('lastCellThenPara').body)).text, '前\n格一\n格二\n表後')
  })

  test('同一格裡照樣接；sdt、書籤不算容器也不擋；下一個區塊是巢狀表格就換行', () => {
    const cases = {
      cellInner: '甲乙\n丙',
      bookmarkBetween: '一二\n三',
      beforeSdt: '一二\n三',
      lastInSdt: '一二',
      nestedTableInCell: '外\n內一\n內二\n\n右',
      cellLastBeforeNextRow: '一\n二\n三\n四',
      markedChainIntoTable: '一二\n格\n格二',
      // 儲存格裡沒有段落的表格：擋住它的是「下一個區塊是表格」這一條（沒有段落就沒有「換了容器」可以判斷）
      emptyCellTable: '一\n二',
    }
    for (const [name, expected] of Object.entries(cases)) {
      const c = byName(name)
      assert.equal(lines(c.libreoffice), lines(expected), `前提：${name} 的標準答案`)
      assert.equal(docxText(makeDocx(c.body)).text, expected, name)
    }
  })

  test(`跟 LibreOffice 一模一樣（${LO.length} 個：邊界例子＋結構化亂數；去掉空行後逐行比、去掉空白後逐字比）`, () => {
    assert.ok(LO.length >= 60)
    for (const c of LO) {
      const ours = docxText(makeDocx(c.body)).text
      assert.equal(lines(ours), lines(c.libreoffice), `${c.name}\n${c.body}`)
      assert.equal(strip(ours), strip(c.libreoffice), c.name)
    }
  })
})

describe('nit（第三輪）：partial 遇到有 BOM 的檔', () => {
  test('UTF-8 BOM、UTF-16LE、UTF-16BE 切在字中間：partial 丟掉半個字；不是 partial（整個檔就這樣）留一個 U+FFFD', () => {
    const u8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('資料結構', 'utf8')]).subarray(0, -1)
    assert.deepEqual(decodeText(u8, { partial: true }), { text: '資料結', encoding: 'utf-8', truncated: true })
    assert.deepEqual(decodeText(u8), { text: '資料結\uFFFD', encoding: 'utf-8', truncated: false })
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('資料😀', 'utf16le')])
    // 切在代理對中間（少 2 byte）、切在一個 code unit 中間（少 1 byte）
    assert.deepEqual(decodeText(le.subarray(0, -2), { partial: true }), { text: '資料', encoding: 'utf-16le', truncated: true })
    assert.deepEqual(decodeText(le.subarray(0, -1), { partial: true }), { text: '資料', encoding: 'utf-16le', truncated: true })
    assert.deepEqual(decodeText(le.subarray(0, -2)), { text: '資料\uFFFD', encoding: 'utf-16le', truncated: false })
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('資料😀', 'utf16le').swap16()])
    assert.deepEqual(decodeText(be.subarray(0, -2), { partial: true }), { text: '資料', encoding: 'utf-16be', truncated: true })
  })
})

describe('第三輪規格：ZIP64 在傳統欄位就讀得完整時照讀', () => {
  test('有 ZIP64 記錄、跟傳統欄位一致：照讀（前面接了自解壓程式也一樣；docx 也讀得到）', () => {
    const buf = buildZip([{ name: 'a.txt', data: 'hello' }, { name: 'b.txt', data: 'world', method: 0 }], { zip64: {} })
    assert.deepEqual(Object.fromEntries(Object.entries(readAll(buf)).map(([k, v]) => [k, v.toString()])), { 'a.txt': 'hello', 'b.txt': 'world' })
    const prefixed = Buffer.concat([Buffer.alloc(1000, 0x90), buf])
    assert.equal(readAll(prefixed)['b.txt'].toString(), 'world')
    const docx = buildZip([
      { name: '_rels/.rels', data: rootRels('word/document.xml') },
      { name: 'word/document.xml', data: documentXml('<w:p><w:r><w:t>ZIP64 的 docx</w:t></w:r></w:p>') },
    ], { zip64: {} })
    assert.deepEqual(docxText(docx), { text: 'ZIP64 的 docx', truncated: false })
  })

  test('兩套 central directory（傳統 EOCD 指一套、ZIP64 記錄指另一套）：CORRUPT，不猜', () => {
    // 第二輪驗證者做的 zip64-diff.zip：Python 照 ZIP64 記錄讀到「ZIP64!」，照傳統欄位讀是「LEGACY」
    const a = buildZip([{ name: 'x.txt', data: 'LEGACY', method: 0 }])
    const localA = a.subarray(0, 30 + 5 + 6)
    const b = buildZip([{ name: 'x.txt', data: 'ZIP64!', method: 0, localOffset: localA.length }])
    const localB = b.subarray(0, 30 + 5 + 6)
    const cdA = a.subarray(localA.length, a.length - 22)
    const cdB = b.subarray(localB.length, b.length - 22)
    const cdAOffset = localA.length + localB.length
    const cdBOffset = cdAOffset + cdA.length
    const rec = Buffer.alloc(56)
    rec.writeUInt32LE(0x06064b50, 0)
    rec.writeBigUInt64LE(44n, 4)
    rec.writeBigUInt64LE(1n, 24)
    rec.writeBigUInt64LE(1n, 32)
    rec.writeBigUInt64LE(BigInt(cdB.length), 40)
    rec.writeBigUInt64LE(BigInt(cdBOffset), 48)
    const loc = Buffer.alloc(20)
    loc.writeUInt32LE(0x07064b50, 0)
    loc.writeBigUInt64LE(BigInt(cdBOffset + cdB.length), 8)
    loc.writeUInt32LE(1, 16)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(1, 8)
    eocd.writeUInt16LE(1, 10)
    eocd.writeUInt32LE(cdA.length, 12)
    eocd.writeUInt32LE(cdAOffset, 16)
    const both = Buffer.concat([localA, localB, cdA, cdB, rec, loc, eocd])
    throwsCode(() => readZip(both), 'CORRUPT')
    // 只差一個欄位也算不一致
    for (const zip64 of [{ count: 2 }, { cdSize: 1 }, { cdOffset: 0 }]) {
      throwsCode(() => readZip(buildZip([{ name: 'a.txt', data: 'x' }], { zip64 })), 'CORRUPT')
    }
  })

  test('有 ZIP64 定位記錄、但指的地方沒有 ZIP64 結尾記錄：我們刻意放寬、照傳統欄位讀（Python 3.12 的 zipfile 與 unzip 6.0 都拒讀）；定位記錄說分成多個檔案：UNSUPPORTED', () => {
    // 放寬的理由寫在 core/office-text.ts 的 checkZip64：第三輪規格「傳統欄位讀得完整就照讀，不因為有定位記錄就拒絕」；
    // 別的工具什麼都不讀，所以不會出現「兩個讀取器讀到不同內容」的差異
    const buf = buildZip([{ name: 'a.txt', data: 'hello' }], { zip64: {} })
    const broken = Buffer.from(buf)
    broken.writeUInt32LE(0, broken.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06])))
    assert.equal(readAll(broken)['a.txt'].toString(), 'hello')
    const split = Buffer.from(buf)
    split.writeUInt32LE(2, split.length - 22 - 20 + 16)
    throwsCode(() => readZip(split), 'UNSUPPORTED')
  })

  test('傳統欄位被填成 0xFFFF／0xFFFFFFFF（真的需要 ZIP64）：有沒有 ZIP64 記錄都是 UNSUPPORTED', () => {
    throwsCode(() => readZip(buildZip([{ name: 'a.txt', data: 'x' }], { zip64: {}, eocd: { cdOffset: 0xffffffff } })), 'UNSUPPORTED')
    throwsCode(() => readZip(buildZip([{ name: 'a.txt', data: 'x' }], { zip64: {}, eocd: { cdSize: 0xffffffff } })), 'UNSUPPORTED')
    throwsCode(() => readZip(buildZip([{ name: 'a.txt', data: 'x' }], { zip64: { count: 1 }, eocd: { count: 0xffff } })), 'UNSUPPORTED')
  })
})

describe('第三輪規格：UTF-8 有零星壞 byte（每 1000 byte 最多一個）照 UTF-8 讀，壞的換成 U+FFFD', () => {
  /** total byte：前面墊 a，最後是 don＋0x92（Windows-1252 的 ’）＋t。 */
  const oneBad = total => Buffer.concat([Buffer.alloc(total - 5, 0x61), Buffer.from('don'), Buffer.from([0x92]), Buffer.from('t')])

  test('1,000 byte 裡 1 個壞 byte：UTF-8；999 byte 就超過比例，退回 Windows-1252', () => {
    assert.deepEqual(decodeText(oneBad(1000)), { text: `${'a'.repeat(995)}don\uFFFDt`, encoding: 'utf-8', truncated: false })
    assert.deepEqual(decodeText(oneBad(999)), { text: `${'a'.repeat(994)}don\u2019t`, encoding: 'windows-1252', truncated: false })
    // 2,000 byte：2 個可以、3 個不行
    const bads = (total, k) => {
      const b = Buffer.alloc(total, 0x61)
      for (let i = 0; i < k; i++) b[100 + i * 500] = 0x92
      return b
    }
    assert.equal(decodeText(bads(2000, 2)).encoding, 'utf-8')
    assert.equal(decodeText(bads(2000, 3)).encoding, 'windows-1252')
  })

  test('第二輪驗證的例子（中文 UTF-8 夾一個 0x92），檔案夠長就不再整份變亂碼', () => {
    const line = Buffer.concat([Buffer.from('資料結構期中考範圍：第一章到第五章 don', 'utf8'), Buffer.from([0x92]), Buffer.from('t 忘記\n', 'utf8')])
    const good = Buffer.from('第三週講義：堆疊與佇列的實作，下週交作業。\n'.repeat(20), 'utf8')
    const r = decodeText(Buffer.concat([line, good]))
    assert.equal(r.encoding, 'utf-8')
    assert.ok(r.text.startsWith('資料結構期中考範圍：第一章到第五章 don\uFFFDt 忘記\n第三週講義'), r.text.slice(0, 40))
  })

  test('檔案裡本來就寫著的 U+FFFD（EF BF BD）不算壞序列', () => {
    const b = Buffer.concat([Buffer.from('\uFFFD'.repeat(5), 'utf8'), oneBad(985)])
    assert.equal(b.length, 1000)
    assert.deepEqual(decodeText(b), { text: `${'\uFFFD'.repeat(5)}${'a'.repeat(980)}don\uFFFDt`, encoding: 'utf-8', truncated: false })
  })

  test('結尾不完整的字：前面沒有真的非 ASCII 字時算一個壞序列；有的話直接丟掉、不算', () => {
    const tail = total => Buffer.concat([Buffer.alloc(total - 1, 0x61), Buffer.from([0xe9])])
    assert.deepEqual(decodeText(tail(1000)), { text: `${'a'.repeat(999)}\uFFFD`, encoding: 'utf-8', truncated: false })
    assert.deepEqual(decodeText(tail(999)), { text: `${'a'.repeat(998)}é`, encoding: 'windows-1252', truncated: false })
    // 前面唯一的非 ASCII 是壞序列變成的 U+FFFD：不算「真的非 ASCII 字」，結尾照樣算一個 → 1,000 byte 裡 2 個，退回
    const badThenTail = Buffer.concat([Buffer.alloc(997, 0x61), Buffer.from([0x92, 0x61, 0xe9])])
    assert.deepEqual(decodeText(badThenTail), { text: `${'a'.repeat(997)}’aé`, encoding: 'windows-1252', truncated: false })
    // 「資」是真的中文：結尾半個「資」丟掉；中間的 0x92 是唯一的壞序列
    const mixed = Buffer.concat([Buffer.from('資', 'utf8'), Buffer.alloc(994, 0x61), Buffer.from([0x92]), Buffer.from('資', 'utf8').subarray(0, 2)])
    assert.equal(mixed.length, 1000)
    assert.deepEqual(decodeText(mixed), { text: `資${'a'.repeat(994)}\uFFFD`, encoding: 'utf-8', truncated: false })
  })

  test('已知限制（第三輪規格決定維持現狀）：latin1 的 cafés 會被判成 Big5', () => {
    // 「é s」（0xE9 0x73）剛好是合法的 Big5 字「廥」；台灣的使用情境 Big5 遠比 latin1 常見
    assert.deepEqual(decodeText(Buffer.from('cafés au lait', 'latin1')), { text: 'caf廥 au lait', encoding: 'big5', truncated: false })
  })

  test('Big5 檔不會因為這條被當成 UTF-8（每個中文字都是壞序列）', () => {
    const big5 = Buffer.concat(new Array(200).fill(fx('big5.txt')))
    const r = decodeText(big5)
    assert.equal(r.encoding, 'big5')
    assert.ok(r.text.startsWith('資料結構\n第3週：堆疊與佇列\n'))
  })

  test('只讀開頭 textHeadBytes(maxChars) byte 再加 partial，跟傳整個檔案一模一樣（UTF-8 夾零星壞 byte，隨機）', () => {
    const rand = rng(7)
    const units = [Buffer.from('ab '), Buffer.from('資料😀', 'utf8'), Buffer.from('\n'), Buffer.from([0x92]), Buffer.from([0xe8, 0xb3])]
    let utf8 = 0
    for (let iter = 0; iter < 300; iter++) {
      const maxChars = 150 + Math.floor(rand() * 500)
      const badRate = rand() < 0.5 ? 0.002 : 0.02
      const chunks = []
      let len = 0
      while (len <= textHeadBytes(maxChars) + 20) {
        const r = rand()
        const u = r < badRate ? units[3 + Math.floor(rand() * 2)] : units[Math.floor(rand() * 3)]
        chunks.push(u)
        len += u.length
      }
      const whole = Buffer.concat(chunks)
      const head = whole.subarray(0, textHeadBytes(maxChars))
      const full = decodeText(whole, { maxChars })
      assert.deepEqual(decodeText(head, { maxChars, partial: true }), full, `第 ${iter} 次`)
      if (full.encoding === 'utf-8') utf8++
    }
    assert.ok(utf8 > 30 && utf8 < 270, `兩種結果都要有：UTF-8 ${utf8} 次`)
  })
})

// =====================================================================
// 第四輪：第三輪驗證的發現＋第四輪的規格決定（先寫成測試、修之前是紅的）
// =====================================================================
describe('minor（第四輪）：大多是 ASCII 的 Big5 檔（繁中 Excel 匯出的 CSV）優先 Big5；UTF-8 容忍只用在壞 byte 不構成合法 Big5 時', () => {
  // 標準答案：test/fixtures/office-text/src/big5-csv.py 用 Python 的 cp950 編解碼器產生
  const csv = fx('big5-sales.csv')
  const expected = fx('big5-sales.expected.txt').toString('utf8')
  const ALL = { maxChars: 1_000_000 }
  const countNonAscii = s => [...s].filter(c => c.codePointAt(0) > 0x7f).length
  /** 在 bytes 的第 at byte 前面插入 extra。 */
  const insertAt = (bytes, at, extra) => Buffer.concat([bytes.subarray(0, at), Buffer.from(extra), bytes.subarray(at)])

  test('前提：範例檔 ASCII 佔 95% 以上，中文字平均每 1,000 byte 不到一個（第三輪的規則會把它當成夾零星壞 byte 的 UTF-8）', () => {
    assert.ok(csv.filter(b => b < 0x80).length / csv.length >= 0.95)
    assert.ok(countNonAscii(expected) * 1000 < csv.length)
    assert.ok(csv.length < 65_536, '整份在判斷編碼的 64 KB 裡')
    assert.ok(expected.startsWith('日期,品名,數量,單價,金額,備註\r\n2026-09-01,'))
  })

  test('Big5 的 CSV → Big5，中文正確（第三輪判成 UTF-8、表頭變 U+FFFD，是退化）', () => {
    assert.deepEqual(decodeText(csv, ALL), { text: expected, encoding: 'big5', truncated: false })
    const r = decodeText(csv)
    assert.equal(r.encoding, 'big5')
    assert.equal(r.text, expected.slice(0, 20_000))
    assert.equal(r.truncated, true)
  })

  test('同一份 CSV 加長到超過 64 KB、80 KB（判斷編碼與輸出的切點都落在檔案中間）→ 不管 maxChars 多少都是 Big5', () => {
    const body = csv.subarray(csv.indexOf(0x0a) + 1)
    const bodyText = expected.slice(expected.indexOf('\n') + 1)
    const long = Buffer.concat([csv, body, body, body])
    const longText = expected + bodyText.repeat(3)
    assert.ok(long.length > 120_000)
    for (const maxChars of [undefined, 10, 100, 50_000, 1_000_000]) {
      const r = decodeText(long, { maxChars })
      assert.equal(r.encoding, 'big5', `maxChars ${maxChars}`)
      assert.equal(r.text, longText.slice(0, maxChars ?? 20_000), `maxChars ${maxChars}`)
    }
  })

  test('成對：同一份內容存成 UTF-8、中間夾 1 個孤立的壞 byte（0x92，不構成 Big5 雙位元組字）→ UTF-8，只有那一個變 U+FFFD', () => {
    // 前提：0x92 開頭的兩個 byte 在 Node 的 Big5 解碼器是私用區字元（不算合法 Big5）
    assert.match(new TextDecoder('big5').decode(Buffer.from([0x92, 0x74])), /^[\ue000-\uf8ff]$/)
    const u8 = Buffer.from(expected, 'utf8')
    assert.deepEqual(decodeText(u8, ALL), { text: expected, encoding: 'utf-8', truncated: false })
    // 在中間某一列的備註欄寫 don’t，’ 用 Windows-1252 存成 0x92
    const at = u8.indexOf('\r\n', 20_000)
    const bad = insertAt(u8, at, [0x64, 0x6f, 0x6e, 0x92, 0x74])
    const cut = u8.subarray(0, at).toString('utf8').length
    const want = `${expected.slice(0, cut)}don\uFFFDt${expected.slice(cut)}`
    assert.deepEqual(decodeText(bad, ALL), { text: want, encoding: 'utf-8', truncated: false })
    // 壞 byte 緊接在表頭後面也一樣
    const early = insertAt(u8, u8.indexOf('\r\n'), [0x92])
    const r0 = decodeText(early, ALL)
    assert.equal(r0.encoding, 'utf-8')
    assert.ok(r0.text.startsWith('日期,品名,數量,單價,金額,備註\uFFFD\r\n'))
    // 純英文的長檔夾一個 0x80（Big5 解成 C1 控制字元）或 0xFF（私用區）：一樣是 UTF-8＋U+FFFD
    for (const stray of [0x80, 0xff]) {
      const en = insertAt(Buffer.from('Quarterly report, all figures in NTD.\n'.repeat(60)), 1000, [stray])
      const r = decodeText(en, ALL)
      assert.equal(r.encoding, 'utf-8', `0x${stray.toString(16)}`)
      assert.equal(countNonAscii(r.text), 1)
      assert.equal(r.text[1000], '\uFFFD')
    }
  })

  test('壞 byte 剛好湊成合法 Big5、檔案其他部分也都是合法 Big5（例如全是 ASCII）→ 照第四輪規則判成 Big5；有真的 UTF-8 中文就不是', () => {
    // latin1 的「é s」（0xE9 0x73）是合法的 Big5 字「廥」：跟「latin1 被判成 Big5」是同一個已知限制
    const ascii = Buffer.concat([Buffer.alloc(2000, 0x61), Buffer.from(' cafés', 'latin1')])
    assert.deepEqual(decodeText(ascii), { text: `${'a'.repeat(2000)} caf廥`, encoding: 'big5', truncated: false })
    // 其他部分有真的 UTF-8 中文：整份不是合法 Big5，照 UTF-8 讀，壞的那一個變 U+FFFD
    const zh = Buffer.concat([Buffer.from('資料結構第三週講義。\n'.repeat(80), 'utf8'), Buffer.from(' cafés', 'latin1')])
    const r = decodeText(zh)
    assert.equal(r.encoding, 'utf-8')
    assert.ok(r.text.endsWith('講義。\n caf\uFFFDs'))
  })

  test('Big5 要有雙位元組字才優先：判斷編碼的 64 KB 剛好切在孤立的 0x92 後面（Big5 只剩 ASCII）→ 照 UTF-8 讀', () => {
    const buf = Buffer.alloc(70_000, 0x61)
    buf[65_535] = 0x92
    buf[65_536] = 0x74
    const r = decodeText(buf, { maxChars: 70_000 })
    assert.equal(r.encoding, 'utf-8')
    assert.equal(r.text, `${'a'.repeat(65_535)}\uFFFDt${'a'.repeat(70_000 - 65_537)}`)
  })
})

describe('nit（第四輪）：編碼判斷跟 maxChars 無關（固定看開頭 64 KB）', () => {
  test('第三輪驗證的例子：1.2 MB 的 UTF-8 中文檔，開頭第 98 byte 插一個 0x92：maxChars 再小都是 UTF-8', () => {
    const line = '資料結構第三週講義：堆疊與佇列。\n' // 49 byte
    const lines = Math.ceil(1_200_000 / Buffer.byteLength(line))
    const good = Buffer.from(line.repeat(lines), 'utf8')
    const bad = Buffer.concat([good.subarray(0, 98), Buffer.from([0x92]), good.subarray(98)])
    const want = `${line}${line}\uFFFD${line.repeat(lines - 2)}`
    for (const maxChars of [0, 1, 10, 33, 34, 50, 100, 250, 20_000, 100_000]) {
      const r = decodeText(bad, { maxChars })
      assert.equal(r.encoding, 'utf-8', `maxChars ${maxChars}`)
      assert.equal(r.text, want.slice(0, maxChars), `maxChars ${maxChars}`)
      assert.equal(r.truncated, true)
    }
  })

  test('前面 3,000 byte 是 ASCII、後面才是 Big5：不管 maxChars 多少都是 Big5（第三輪 maxChars 小時是 UTF-8）', () => {
    const big5 = fx('big5.txt') // 「資料結構\n第3週：堆疊與佇列\n」
    const buf = Buffer.concat([Buffer.alloc(3000, 0x78), ...new Array(50).fill(big5)])
    const want = 'x'.repeat(3000) + '資料結構\n第3週：堆疊與佇列\n'.repeat(50)
    for (const maxChars of [0, 5, 100, 3001, 20_000]) {
      const r = decodeText(buf, { maxChars })
      assert.equal(r.encoding, 'big5', `maxChars ${maxChars}`)
      assert.equal(r.text, want.slice(0, maxChars), `maxChars ${maxChars}`)
    }
  })

  test('已知限制：只看開頭 64 KB，64 KB 之後才出現的 Big5 照開頭判的編碼解（變成 U+FFFD），跟 maxChars 無關', () => {
    const big5 = fx('big5.txt')
    const buf = Buffer.concat([Buffer.alloc(65_536, 0x78), big5])
    for (const maxChars of [10, 20_000, 100_000]) assert.equal(decodeText(buf, { maxChars }).encoding, 'utf-8')
    const r = decodeText(buf, { maxChars: 100_000 })
    assert.ok(r.text.startsWith(`${'x'.repeat(65_536)}\uFFFD`))
    // 少 2 byte 就有一個字落在 64 KB 裡：Big5
    assert.equal(decodeText(Buffer.concat([Buffer.alloc(65_534, 0x78), big5]), { maxChars: 10 }).encoding, 'big5')
  })

  test('隨機內容：同一個檔不管 maxChars 多少，編碼都一樣，文字是彼此的開頭', () => {
    const rand = rng(8)
    const big5 = fx('big5.txt').subarray(0, 8)
    const ascii = [Buffer.from('ab,1 '), Buffer.from('\r\n')]
    // 主體：UTF-8 中文或 Big5 中文；偶爾夾一個零星的壞 byte（0x92、湊成 Big5 的 é s、切一半的 UTF-8「資」）
    const bodies = [Buffer.from('資料😀', 'utf8'), big5]
    const strays = [Buffer.from([0x92]), Buffer.from([0xe9, 0x73]), Buffer.from([0xe8, 0xb3])]
    const pick = list => list[Math.floor(rand() * list.length)]
    const seen = new Set()
    for (let iter = 0; iter < 80; iter++) {
      const body = pick(bodies)
      const zhRate = pick([0, 0.001, 0.05, 0.5])
      const strayRate = pick([0, 0.0005, 0.005, 0.05])
      // 前面墊一段 ASCII：有時剛好把中文推到判斷編碼的 64 KB 外面
      const chunks = [Buffer.alloc(pick([0, 0, 500, 3000, 65_535, 65_536, 70_000]), 0x78)]
      let n = chunks[0].length
      const len = n + 200 + Math.floor(rand() * 90_000)
      while (n < len) {
        const r = rand()
        const u = r < strayRate ? pick(strays) : r < strayRate + zhRate ? body : pick(ascii)
        chunks.push(u)
        n += u.length
      }
      const buf = Buffer.concat(chunks)
      const results = [0, 7, 300, 20_000, 200_000].map(maxChars => ({ maxChars, ...decodeText(buf, { maxChars }) }))
      const widest = results[results.length - 1]
      seen.add(widest.encoding)
      for (const r of results) {
        assert.equal(r.encoding, widest.encoding, `第 ${iter} 次 maxChars ${r.maxChars}`)
        assert.ok(widest.text.startsWith(r.text), `第 ${iter} 次 maxChars ${r.maxChars}`)
        assert.equal([...r.text].length, Math.min(r.maxChars, [...widest.text].length), `第 ${iter} 次 maxChars ${r.maxChars}`)
      }
    }
    assert.deepEqual([...seen].sort(), ['big5', 'utf-8', 'windows-1252'], '三種結果都要出現')
  })
})

describe('nit（第四輪）：不到 1,000 byte 的 UTF-8 檔有 1 個壞 byte', () => {
  test('規則照字面：壞序列 × 1,000 ≤ 判斷編碼看的 byte 數（檔案本身，最多 64 KB）才當 UTF-8；不到 1,000 byte 時 1 個就超過', () => {
    // 第三輪驗證的例子：17 byte（UTF-8 的「資料結構」＋ don 0x92 t）。整份不是合法 Big5 → Windows-1252（中文變亂碼）
    const short = Buffer.concat([Buffer.from('資料結構don', 'utf8'), Buffer.from([0x92]), Buffer.from('t')])
    assert.equal(short.length, 17)
    const mojibake = '\u00e8\u00b3\u2021\u00e6\u2013\u2122\u00e7\u00b5\u0090\u00e6\u00a7\u2039don\u2019t'
    for (const maxChars of [undefined, 5, 1_000_000]) {
      const r = decodeText(short, { maxChars })
      assert.equal(r.encoding, 'windows-1252', `maxChars ${maxChars}`)
      assert.equal(r.text, mojibake.slice(0, maxChars ?? 20_000))
    }
    // 同樣的壞 byte，檔案補到 999 byte 還是 Windows-1252；1,000 byte 就是 UTF-8
    const padTo = total => Buffer.concat([short, Buffer.alloc(total - short.length, 0x20)])
    assert.equal(decodeText(padTo(999)).encoding, 'windows-1252')
    assert.deepEqual(decodeText(padTo(1000)), { text: `資料結構don\uFFFDt${' '.repeat(983)}`, encoding: 'utf-8', truncated: false })
    // 壞 byte 湊成合法 Big5、其他部分也是合法 Big5 → Big5（第四輪的 Big5 優先，跟檔案長短無關）
    assert.deepEqual(decodeText(Buffer.from('cafés', 'latin1')), { text: 'caf廥', encoding: 'big5', truncated: false })
    // partial（呼叫端只讀了一段）也一樣照比例算：分母是傳進來的 byte 數
    assert.equal(decodeText(short, { partial: true }).encoding, 'windows-1252')
  })
})

describe('nit（第四輪）：第三輪兩段新邏輯補測試', () => {
  test('文字方塊（txbxContent）是段落容器：方塊裡最後一段的段落標記被刪，也不黏到錨點後面的字；同一個方塊裡照樣接', () => {
    const del = '<w:pPr><w:rPr><w:del w:id="9" w:author="t" w:date="2026-09-19T10:00:00Z"/></w:rPr></w:pPr>'
    const box = paras => `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><w:txbxContent>${paras}</w:txbxContent></w:drawing></mc:Choice></mc:AlternateContent></w:r>`
    const doc = paras => makeDocx(`<w:p><w:r><w:t>前段</w:t></w:r></w:p><w:p><w:r><w:t>錨前</w:t></w:r>${box(paras)}<w:r><w:t>錨後</w:t></w:r></w:p><w:p><w:r><w:t>下一段</w:t></w:r></w:p>`)
    // 方塊最後一段的段落標記被刪：方塊結束就換行，「方二」不跟方塊外的「錨後」接
    assert.equal(docxText(doc(`<w:p><w:r><w:t>方一</w:t></w:r></w:p><w:p>${del}<w:r><w:t>方二</w:t></w:r></w:p>`)).text, '前段\n錨前\n方一\n方二\n錨後\n下一段')
    // 方塊裡第一段的段落標記被刪：跟同一個方塊裡的下一段接
    assert.equal(docxText(doc(`<w:p>${del}<w:r><w:t>方一</w:t></w:r></w:p><w:p><w:r><w:t>方二</w:t></w:r></w:p>`)).text, '前段\n錨前\n方一方二\n錨後\n下一段')
  })

  test('_rels/.rels 解路徑的字數預算（4,194,304）：剛好用完照常；多 1 個字就用完了 → 退回預設位置並標 truncated，預設位置也沒有丟 TOO_LARGE', () => {
    // 32 筆指不到的主文件關聯，每筆 Target 131,072 字：合計剛好 4,194,304（_rels/.rels 的來源資料夾是空的，不另外算）
    const rels = extra => {
      const parts = ['<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">']
      for (let i = 0; i < 32; i++) {
        const len = 131_072 + (i === 31 ? extra : 0)
        parts.push(`<Relationship Id="m${i}" Type="${REL_OFFICE_DOC}" Target="nope/${'x'.repeat(len - 5)}"/>`)
      }
      parts.push('</Relationships>')
      return parts.join('')
    }
    // 剛好用完：每一筆都解過、都指不到，rels 完整讀完 → 預設位置照讀、不標 truncated；沒有預設位置是 CORRUPT
    assert.deepEqual(docxText(docxWithRootRels(rels(0))), { text: '主文件', truncated: false })
    throwsCode(() => docxText(docxWithRootRels(rels(0), 'word/other.xml')), 'CORRUPT')
    // 多 1 個字：最後一筆沒解（它可能就是真的主文件）→ 預設位置讀到的字照回、標 truncated；沒有預設位置 → TOO_LARGE
    assert.deepEqual(docxText(docxWithRootRels(rels(1))), { text: '主文件', truncated: true })
    throwsCode(() => docxText(docxWithRootRels(rels(1), 'word/other.xml')), 'TOO_LARGE')
  })
})

// =====================================================================
// 第五輪：第四輪驗證的發現＋第五輪的規格決定（先寫成測試、修之前是紅的）
// =====================================================================
/** 獨立數一遍：用 UTF-8 解，合法的多位元組序列（good，一個字算一個）與壞序列（bad）各有幾個。 */
function utf8Counts(bytes) {
  let good = 0
  let bad = 0
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i]
    if (b < 0x80) {
      i++
      continue
    }
    // 合法的 UTF-8 多位元組：照 RFC 3629 的表（不收過長編碼、代理區、超過 U+10FFFF）
    const n = b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0
    let ok = n > 0 && i + n <= bytes.length
    for (let k = 1; ok && k < n; k++) ok = (bytes[i + k] & 0xc0) === 0x80
    if (ok && b === 0xe0) ok = bytes[i + 1] >= 0xa0
    if (ok && b === 0xed) ok = bytes[i + 1] <= 0x9f
    if (ok && b === 0xf0) ok = bytes[i + 1] >= 0x90
    if (ok && b === 0xf4) ok = bytes[i + 1] <= 0x8f
    if (ok) {
      good++
      i += n
    } else {
      // 這裡只拿來數「有沒有、大概幾個」：測試用的壞 byte 都是孤立的一個，跟 WHATWG 的數法一樣
      bad++
      i++
    }
  }
  return { good, bad }
}

/** Node 的 Big5 解碼器把整段解得開（沒有 U+FFFD、C1 控制字元、私用區）。 */
function isLegalBig5(bytes) {
  try {
    return !/[--�]/.test(new TextDecoder('big5', { fatal: true }).decode(bytes))
  } catch {
    return false
  }
}

/** 測試用的 Big5（CP950）詞：Node 只能解 Big5、不能編，用 Python 的 cp950 先算好。 */
const BIG5_WORDS = {
  急件: 'abe6a5f3',
  退貨: 'b068b366',
  含運: 'a774b942',
  贈品: 'c3d8ab7e',
  補單: 'b8c9b3e6',
  資料結構: 'b8eaaec6b5b2ba63',
  第三週: 'b2c4a454b667',
  講義: 'c1bfb871',
  期中考: 'b4c1a4a4a6d2',
  堆疊與佇列: 'b0efc57cbb50a6eea643',
}

describe('minor（第四輪驗證）＋第五輪規格：Big5 優先只用在幾乎沒有合法 UTF-8 多位元組序列的檔', () => {
  const ALL = { maxChars: 1_000_000 }
  // 法文，刻意不用 à、œ、大寫重音字母和彎引號：這些的 UTF-8 不是合法 Big5，整份就不會被當成 Big5（見同一個測試的後半）
  const fr = "Les élèves ont préparé une fête pour la fin de l'année. Le café était prêt, le gâteau aussi, et même le maître a chanté. " +
    'On a goûté une crème brûlée délicieuse près de la fenêtre. Ce fut une très belle soirée, où chacun a dansé. '
  /** 在第 at 個字前面插入 latin1 寫的 stray，回傳位元組與標準答案（每個非 ASCII 的 latin1 byte 變一個 U+FFFD）。 */
  const withStray = (text, at, stray) => {
    const bytes = Buffer.concat([Buffer.from(text.slice(0, at), 'utf8'), Buffer.from(stray, 'latin1'), Buffer.from(text.slice(at), 'utf8')])
    const want = text.slice(0, at) + stray.replace(/[^ -~]/g, '�') + text.slice(at)
    return { bytes, want }
  }

  test('法文 UTF-8 檔（很多 é、è、ê）夾一個 latin1 的 0xE9、後面接字母 → UTF-8，只壞那一個字（第四輪整份判成 Big5）', () => {
    const text = fr.repeat(6)
    const { bytes, want } = withStray(text, text.indexOf('Ce fut', 500), 'néanmoins ')
    assert.ok(bytes.length >= 1000 && bytes.length < 65_536)
    // 前提：整份剛好是合法 Big5（é、è、ê 的 UTF-8 都是 Big5 字，0xE9 0x61 也是），第四輪的規則會優先 Big5
    assert.ok(isLegalBig5(bytes))
    assert.deepEqual(utf8Counts(bytes), { good: [...text].filter(c => c.codePointAt(0) > 0x7f).length, bad: 1 })
    assert.deepEqual(decodeText(bytes, ALL), { text: want, encoding: 'utf-8', truncated: false })
    for (const maxChars of [10, 500, 20_000]) {
      const r = decodeText(bytes, { maxChars })
      assert.equal(r.encoding, 'utf-8', `maxChars ${maxChars}`)
      assert.equal(r.text, want.slice(0, maxChars))
    }
    // 有 à（C3 A0 不是合法 Big5）的法文：整份不是合法 Big5，第四輪就已經走 UTF-8 容忍，這一輪也一樣
    const withA = `${fr}Il est allé à la gare à midi, puis au café. `.repeat(5)
    const a = withStray(withA, withA.indexOf('puis', 400), 'néanmoins ')
    assert.equal(isLegalBig5(a.bytes), false)
    assert.deepEqual(decodeText(a.bytes, ALL), { text: a.want, encoding: 'utf-8', truncated: false })
  })

  test('第四輪驗證的例子：西班牙文、葡萄牙文、德文、人名 CSV，1 KB 到 27 KB（第四輪驗證用 10 份；德文 10 份不到 1,000 byte，改 12 份），夾一個 latin1 的 Pokémon → 都是 UTF-8，只壞那一個字', () => {
    const es = 'El niño comió una manzana en el jardín. La canción de mañana será más fácil, según él. ¿Qué día es hoy? ¡Qué alegría! '
    const pt = 'O menino comeu a maçã no jardim. A canção de amanhã será mais fácil, segundo ele. Não há razões para isso. '
    const de = 'Die Grösse ist schön, aber für München zu klein. ueber die Brücke gehen wir später. '
    const names = 'id,name,city\n1,José Pérez,Málaga\n2,Zoë Brontë,Köln\n3,Renée Dupré,Nîmes\n4,Björn Müller,Göteborg\n'
    let legal = 0
    for (const [lang, body] of [['es', es], ['pt', pt], ['de', de], ['names', names]]) {
      for (const reps of [12, 30, 200]) {
        const text = body.repeat(reps)
        const at = text.indexOf('. ', text.length >> 1) + 1
        const { bytes, want } = withStray(text, at, ' Pokémon')
        assert.ok(bytes.length >= 1000, '比例內（每 1,000 byte 最多一個壞序列）；更短的見下面「比例照舊」')
        if (isLegalBig5(bytes)) legal++
        const r = decodeText(bytes, ALL)
        assert.equal(r.encoding, 'utf-8', `${lang} x${reps}`)
        assert.equal(r.text, want, `${lang} x${reps}`)
      }
    }
    assert.ok(legal >= 9, `至少 9 份剛好是合法 Big5（第四輪會判成 Big5）：${legal}`)
  })

  test('成對：純 ASCII＋Big5 雙位元組字的 CSV（合法 UTF-8 多位元組比壞序列少）→ 還是 Big5', () => {
    const csv = fx('big5-sales.csv')
    const expected = fx('big5-sales.expected.txt').toString('utf8')
    const { good, bad } = utf8Counts(csv)
    assert.ok(good <= bad && bad > 0, `good ${good} bad ${bad}`)
    assert.deepEqual(decodeText(csv, ALL), { text: expected, encoding: 'big5', truncated: false })
    // 只有 ASCII 和一個湊成 Big5 的 latin1 é s（合法 UTF-8 多位元組 0 個）→ 照舊 Big5
    assert.equal(decodeText(Buffer.concat([Buffer.alloc(2000, 0x61), Buffer.from(' cafés', 'latin1')])).encoding, 'big5')
  })

  test('邊界：合法 UTF-8 多位元組字跟壞序列一樣多 → 還算「幾乎沒有」，Big5 優先；多一個 → UTF-8', () => {
    // UTF-8 的 é（C3 A9）是 Big5 的「矇」；latin1 的 é s（E9 73）是 Big5 的「廥」。整份都是合法 Big5
    const make = (goodN, badN) => Buffer.concat([
      Buffer.alloc(2000, 0x61),
      ...new Array(goodN).fill(Buffer.from(' é', 'utf8')),
      ...new Array(badN).fill(Buffer.from(' és', 'latin1')),
    ])
    const expect = (goodN, badN, encoding) => {
      const buf = make(goodN, badN)
      assert.ok(isLegalBig5(buf))
      assert.deepEqual(utf8Counts(buf), { good: goodN, bad: badN })
      const tail = encoding === 'big5' ? ' 矇'.repeat(goodN) + ' 廥'.repeat(badN) : ' é'.repeat(goodN) + ' �s'.repeat(badN)
      assert.deepEqual(decodeText(buf), { text: 'a'.repeat(2000) + tail, encoding, truncated: false }, `good ${goodN} bad ${badN}`)
    }
    expect(0, 1, 'big5')
    expect(1, 1, 'big5')
    expect(2, 1, 'utf-8')
    expect(2, 2, 'big5')
    expect(3, 2, 'utf-8')
    // 4 byte 的字只算一個（JS 字串裡是兩個代理，不能數成兩個）：UTF-8 的「𡡡」（F0 A1 A1 A1）剛好是 Big5 的「臐﹛」
    const four = Buffer.concat([Buffer.alloc(2000, 0x61), Buffer.from(' 𡡡', 'utf8'), Buffer.from(' és', 'latin1')])
    assert.ok(isLegalBig5(four))
    assert.deepEqual(utf8Counts(four), { good: 1, bad: 1 })
    assert.deepEqual(decodeText(four), { text: `${'a'.repeat(2000)} 臐﹛ 廥`, encoding: 'big5', truncated: false })
    const fourTwice = Buffer.concat([four, Buffer.from(' 𡡡', 'utf8')])
    assert.deepEqual(decodeText(fourTwice), { text: `${'a'.repeat(2000)} 𡡡 �s 𡡡`, encoding: 'utf-8', truncated: false })
    // 檔案裡本來就寫著的 U+FFFD（EF BF BD）是合法的 UTF-8 多位元組，算 good（它不算壞，見第三輪的測試）
    const lit = Buffer.concat([Buffer.alloc(2000, 0x61), Buffer.from(' ��', 'utf8'), Buffer.from(' és', 'latin1')])
    assert.ok(isLegalBig5(lit))
    assert.deepEqual(utf8Counts(lit), { good: 2, bad: 1 })
    assert.deepEqual(decodeText(lit), { text: `${'a'.repeat(2000)} �� �s`, encoding: 'utf-8', truncated: false })
  })

  test('比例照舊（每 1,000 byte 最多一個壞序列）：超過比例就退回，整份是合法 Big5 → Big5（很小的 Big5 檔因此讀對）', () => {
    // 10 byte 的 Big5「衝突的選項」：用 UTF-8 看有 3 個合法多位元組、1 個壞序列（多位元組比較多，不走 Big5 優先），
    // 但 1 個壞序列已經超過 10 byte 的比例，退回之後整份是合法 Big5 → Big5，讀對
    const tiny = Buffer.from('bdc4acf0aababfefb6b5', 'hex')
    assert.deepEqual(utf8Counts(tiny), { good: 3, bad: 1 })
    assert.deepEqual(decodeText(tiny), { text: '衝突的選項', encoding: 'big5', truncated: false })
    // 已知限制：不到 1,000 byte 的法文 UTF-8 夾一個 latin1 é → 超過比例 → 整份是合法 Big5 → Big5（第三輪起就是這樣）
    const short = withStray(fr, fr.indexOf('Ce fut'), 'néanmoins ')
    assert.ok(short.bytes.length < 1000 && isLegalBig5(short.bytes))
    assert.equal(decodeText(short.bytes).encoding, 'big5')
    // 同一段補到 1,000 byte 以上（比例內）就是 UTF-8
    const long = `${fr}${' '.repeat(1000)}`
    const padded = withStray(long, long.indexOf('Ce fut'), 'néanmoins ')
    assert.deepEqual(decodeText(padded.bytes, ALL), { text: padded.want, encoding: 'utf-8', truncated: false })
  })

  test('隨機：西歐 UTF-8（1 KB 到 60 KB）夾 1 個 latin1 壞 byte → 一定是 UTF-8、只壞那一個；ASCII 夾 3 到 8 個 Big5 詞 → 一定是 Big5', () => {
    const rand = rng(9)
    const pick = list => list[Math.floor(rand() * list.length)]
    const accented = ['élève', 'fête', 'crème', 'niño', 'jardín', 'canción', 'schön', 'für', 'Müller', 'maçã', 'Zoë', 'naïve', 'señor', 'garçon']
    const plain = ['the', 'report', 'and', 'le', 'de', 'el', 'und', '2026', 'NTD', 'item']
    const zh = Object.keys(BIG5_WORDS)
    let utf8 = 0
    let big5 = 0
    let legal = 0
    for (let iter = 0; iter < 120; iter++) {
      const size = 1000 + Math.floor(rand() * 59_000)
      if (iter % 2 === 0) {
        const words = []
        for (let n = 0; n < size;) {
          const w = rand() < 0.2 ? pick(accented) : pick(plain)
          words.push(w)
          n += Buffer.byteLength(w) + 1
        }
        const text = `${words.join(' ')}\n`
        const at = text.indexOf(' ', Math.floor(rand() * (text.length - 10))) + 1
        const { bytes, want } = withStray(text, at, pick(['és', 'èm', 'ña', 'öt', 'üs', 'ça']))
        if (isLegalBig5(bytes)) legal++
        const r = decodeText(bytes, ALL)
        assert.equal(r.encoding, 'utf-8', `第 ${iter} 次`)
        assert.equal(r.text, want, `第 ${iter} 次`)
        utf8++
      } else {
        const cells = []
        for (let n = 0; n < size;) {
          const w = pick(plain)
          cells.push(w)
          n += w.length + 1
        }
        for (let k = 3 + Math.floor(rand() * 6); k > 0; k--) cells.splice(Math.floor(rand() * cells.length), 0, pick(zh))
        const text = `${cells.join(',')}\r\n`
        const bytes = Buffer.concat(cells.map((c, i) => Buffer.concat([
          c in BIG5_WORDS ? Buffer.from(BIG5_WORDS[c], 'hex') : Buffer.from(c),
          Buffer.from(i === cells.length - 1 ? '\r\n' : ','),
        ])))
        const r = decodeText(bytes, ALL)
        assert.equal(r.encoding, 'big5', `第 ${iter} 次`)
        assert.equal(r.text, text, `第 ${iter} 次`)
        big5++
      }
    }
    assert.ok(utf8 === 60 && big5 === 60)
    assert.ok(legal > 30, `西歐 UTF-8 的檔大多剛好是合法 Big5（第四輪會判成 Big5）：${legal}`)
  })
})

describe('nit（第四輪驗證）：兩條寫進 JSDoc 的判斷規則補測試', () => {
  test('UTF-8 容忍比例的分母是判斷範圍（最多 64 KB），不是整個檔：200 KB 的檔，開頭 64 KB 有 65 個壞 byte 是 UTF-8，66 個就不是', () => {
    const make = k => {
      const b = Buffer.alloc(200_000, 0x61)
      for (let i = 0; i < k; i++) b[100 + i * 900] = 0x92
      return b
    }
    assert.ok(100 + 65 * 900 < 65_536)
    assert.equal(isLegalBig5(make(66)), false)
    // 65 × 1,000 = 65,000 ≤ 65,536；66 × 1,000 = 66,000 > 65,536（分母如果用整個檔的 200,000，兩個都會是 UTF-8）
    const ok = decodeText(make(65), { maxChars: 200_000 })
    assert.equal(ok.encoding, 'utf-8')
    assert.equal(ok.text.split('�').length - 1, 65)
    const over = decodeText(make(66), { maxChars: 200_000 })
    assert.equal(over.encoding, 'windows-1252')
    assert.equal(over.text.split('’').length - 1, 66)
    // 只讀開頭 textHeadBytes() byte 再傳 partial，跟傳整個檔案一模一樣（分母用整個檔就會不一樣）
    for (const k of [65, 66]) {
      const whole = make(k)
      for (const maxChars of [undefined, 100, 100_000]) {
        const head = whole.subarray(0, textHeadBytes(maxChars))
        assert.deepEqual(decodeText(head, { maxChars, partial: true }), decodeText(whole, { maxChars }), `k ${k} maxChars ${maxChars}`)
      }
    }
  })

  test('合法 Big5 但沒有雙位元組字（只剩切點上的半個字）、又超過 UTF-8 的比例 → Big5，不是 Windows-1252', () => {
    // 呼叫端只讀了 4 byte，切在 Big5「中」（A4 A4）的第一個 byte 後面
    assert.deepEqual(decodeText(Buffer.from([0x61, 0x62, 0x63, 0xa4]), { partial: true }), { text: 'abc', encoding: 'big5', truncated: true })
    // 不是 partial（整個檔就這樣）：結尾不完整的 Big5 字不容忍 → 整份不是合法 Big5 → Windows-1252
    assert.deepEqual(decodeText(Buffer.from([0x61, 0x62, 0x63, 0xa4])), { text: 'abc¤', encoding: 'windows-1252', truncated: false })
    // 邊界：999 byte 的 partial 還是 Big5；1,000 byte 就在 UTF-8 的比例內（孤立的 0xA4 是 1 個壞序列）→ UTF-8
    const cut = total => Buffer.concat([Buffer.alloc(total - 1, 0x61), Buffer.from([0xa4])])
    assert.deepEqual(decodeText(cut(999), { partial: true }), { text: 'a'.repeat(998), encoding: 'big5', truncated: true })
    assert.deepEqual(decodeText(cut(1000), { partial: true }), { text: `${'a'.repeat(999)}�`, encoding: 'utf-8', truncated: true })
  })
})
