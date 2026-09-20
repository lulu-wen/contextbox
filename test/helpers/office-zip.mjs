// 測試用：手工組 zip／docx／pptx。只給 test/office-text.test.mjs 用。
// 刻意把每個欄位都攤開，方便做「宣稱的大小跟實際不一樣」這類惡意檔。
import { crc32, deflateRawSync } from 'node:zlib'

const u16 = (buf, v, at) => buf.writeUInt16LE(v & 0xffff, at)
const u32 = (buf, v, at) => buf.writeUInt32LE(v >>> 0, at)

/**
 * entries 的每一個元素可以有這些欄位：
 *   name、data、method（0 或 8，預設 8）、raw（直接給壓縮後的位元組）、flags；
 *   crc、compSize、uncompSize（central directory 宣稱的值，預設照實）；
 *   local: { crc, comp, uncomp }（local header 宣稱的值，預設跟 central 一樣）；
 *   dataDescriptor（布林）、localExtra、centralExtra、localOffset、diskStart、noLocal（不寫 local header）。
 * opts 可以有：eocd: { disk, cdDisk, countDisk, count, cdSize, cdOffset }、comment、zip64: { count, cdSize, cdOffset }。
 */
export function buildZip(entries, opts = {}) {
  const chunks = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const data = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : (e.data ?? Buffer.alloc(0))
    const method = e.method ?? 8
    const comp = e.raw ?? (method === 8 ? deflateRawSync(data) : data)
    const crc = e.crc ?? crc32(data)
    const compSize = e.compSize ?? comp.length
    const uncompSize = e.uncompSize ?? data.length
    let flags = e.flags ?? 0
    if (e.dataDescriptor) flags |= 8
    const localExtra = e.localExtra ?? Buffer.alloc(0)
    const centralExtra = e.centralExtra ?? Buffer.alloc(0)
    const ls = e.local ?? (e.dataDescriptor ? { crc: 0, comp: 0, uncomp: 0 } : { crc, comp: compSize, uncomp: uncompSize })

    const lh = Buffer.alloc(30)
    u32(lh, 0x04034b50, 0)
    u16(lh, 20, 4)
    u16(lh, flags, 6)
    u16(lh, method, 8)
    u16(lh, 0, 10)
    u16(lh, 0x5321, 12)
    u32(lh, ls.crc, 14)
    u32(lh, ls.comp, 18)
    u32(lh, ls.uncomp, 22)
    u16(lh, name.length, 26)
    u16(lh, localExtra.length, 28)
    const localOffset = e.localOffset ?? offset
    const parts = [lh, name, localExtra, comp]
    if (e.dataDescriptor) {
      const dd = Buffer.alloc(16)
      u32(dd, 0x08074b50, 0)
      u32(dd, crc, 4)
      u32(dd, comp.length, 8)
      u32(dd, data.length, 12)
      parts.push(dd)
    }
    if (!e.noLocal) {
      for (const p of parts) {
        chunks.push(p)
        offset += p.length
      }
    }

    const ch = Buffer.alloc(46)
    u32(ch, 0x02014b50, 0)
    u16(ch, 0x031e, 4)
    u16(ch, 20, 6)
    u16(ch, flags, 8)
    u16(ch, method, 10)
    u16(ch, 0, 12)
    u16(ch, 0x5321, 14)
    u32(ch, crc, 16)
    u32(ch, compSize, 20)
    u32(ch, uncompSize, 24)
    u16(ch, name.length, 28)
    u16(ch, centralExtra.length, 30)
    u16(ch, 0, 32)
    u16(ch, e.diskStart ?? 0, 34)
    u16(ch, 0, 36)
    u32(ch, 0, 38)
    u32(ch, localOffset, 42)
    centrals.push(ch, name, centralExtra)
  }
  const cd = Buffer.concat(centrals)
  const cdOffset = offset
  chunks.push(cd)
  offset += cd.length

  const ev = { disk: 0, cdDisk: 0, countDisk: entries.length, count: entries.length, cdSize: cd.length, cdOffset, ...(opts.eocd ?? {}) }
  if (opts.eocd && opts.eocd.count !== undefined && opts.eocd.countDisk === undefined) ev.countDisk = opts.eocd.count

  if (opts.zip64) {
    const z = { count: entries.length, cdSize: cd.length, cdOffset, ...opts.zip64 }
    const rec = Buffer.alloc(56)
    u32(rec, 0x06064b50, 0)
    rec.writeBigUInt64LE(44n, 4)
    u16(rec, 0x032d, 12)
    u16(rec, 45, 14)
    u32(rec, 0, 16)
    u32(rec, 0, 20)
    rec.writeBigUInt64LE(BigInt(z.count), 24)
    rec.writeBigUInt64LE(BigInt(z.count), 32)
    rec.writeBigUInt64LE(BigInt(z.cdSize), 40)
    rec.writeBigUInt64LE(BigInt(z.cdOffset), 48)
    const loc = Buffer.alloc(20)
    u32(loc, 0x07064b50, 0)
    u32(loc, 0, 4)
    loc.writeBigUInt64LE(BigInt(offset), 8)
    u32(loc, 1, 16)
    chunks.push(rec, loc)
    offset += rec.length + loc.length
  }

  const comment = Buffer.from(opts.comment ?? '', 'utf8')
  const eocd = Buffer.alloc(22)
  u32(eocd, 0x06054b50, 0)
  u16(eocd, ev.disk, 4)
  u16(eocd, ev.cdDisk, 6)
  u16(eocd, ev.countDisk, 8)
  u16(eocd, ev.count, 10)
  u32(eocd, ev.cdSize, 12)
  u32(eocd, ev.cdOffset, 16)
  u16(eocd, comment.length, 20)
  chunks.push(eocd, comment)
  return Buffer.concat(chunks)
}

/** 真的有 n 個 entry 的 central directory（全部指向同一個空的 local header）。n = 100 萬時大約 53 MB。 */
export function buildManyEntries(n, eocdCount) {
  const nameLen = 7
  const localName = Buffer.from('0'.repeat(nameLen))
  const lh = Buffer.alloc(30 + nameLen)
  u32(lh, 0x04034b50, 0)
  u16(lh, 10, 4)
  u16(lh, 0, 8)
  u16(lh, nameLen, 26)
  localName.copy(lh, 30)
  const recLen = 46 + nameLen
  const cd = Buffer.alloc(n * recLen)
  for (let i = 0; i < n; i++) {
    const at = i * recLen
    u32(cd, 0x02014b50, at)
    u16(cd, 0x031e, at + 4)
    u16(cd, 10, at + 6)
    u16(cd, nameLen, at + 28)
    u32(cd, 0, at + 42)
    cd.write(String(i).padStart(nameLen, '0'), at + 46, 'latin1')
  }
  const eocd = Buffer.alloc(22)
  u32(eocd, 0x06054b50, 0)
  u16(eocd, eocdCount, 8)
  u16(eocd, eocdCount, 10)
  u32(eocd, cd.length, 12)
  u32(eocd, lh.length, 16)
  return Buffer.concat([lh, cd, eocd])
}

/** 只有一個 EOCD：宣稱有 count 個 entry、central directory 有 cdSize 那麼大，但其實什麼都沒有。 */
export function fakeEocd({ count, cdSize = 0, cdOffset = 0 }) {
  const eocd = Buffer.alloc(22)
  u32(eocd, 0x06054b50, 0)
  u16(eocd, count, 8)
  u16(eocd, count, 10)
  u32(eocd, cdSize, 12)
  u32(eocd, cdOffset, 16)
  return eocd
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL_OFFICE_DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'
const REL_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide'
const REL_NOTES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide'

export function rootRels(target) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_OFFICE_DOC}" Target="${target}"/></Relationships>`
}

export function documentXml(body, prolog = '') {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${prolog}<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:v="urn:schemas-microsoft-com:vml"><w:body>${body}<w:sectPr/></w:body></w:document>`
}

/** 最小的 docx：[Content_Types].xml、_rels/.rels、word/document.xml。 */
export function makeDocx(body, { docPath = 'word/document.xml', rels = true, xml, extra = [], method = 8 } = {}) {
  const entries = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', method },
  ]
  if (rels) entries.push({ name: '_rels/.rels', data: rootRels(docPath), method })
  entries.push({ name: docPath, data: xml ?? documentXml(body), method })
  entries.push(...extra)
  return buildZip(entries)
}

/** 一個文字方塊，每個元素是一個段落。 */
export function sp(...paragraphs) {
  const ps = paragraphs.map(p => p === '' ? '<a:p/>' : `<a:p><a:r><a:rPr lang="zh-TW"/><a:t>${p}</a:t></a:r></a:p>`).join('')
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${ps}</p:txBody></p:sp>`
}

export function slideXml(inner) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${R_NS}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${inner}</p:spTree></p:cSld></p:sld>`
}

/**
 * 最小的 pptx。
 * slides：每張投影片 spTree 裡面的內容（字串）。檔名是 slide1.xml、slide2.xml…，rId 是 rId(i+2)。
 * order：sldIdLst 裡放哪幾張、什麼順序（以 0 起算的 slides 索引）。預設照檔名順序。
 * notes：每張投影片的講者備忘（字串或 undefined）。
 * sldIds：直接指定 sldIdLst 的 r:id 清單（覆蓋 order）。
 * relsExtra：presentation.xml.rels 額外的 Relationship。
 */
export function makePptx(slides, { order, notes = [], sldIds, relsExtra = '', presPath = 'ppt/presentation.xml', targetPrefix = 'slides/', extra = [] } = {}) {
  const entries = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: '_rels/.rels', data: rootRels(presPath) },
  ]
  const ids = sldIds ?? (order ?? slides.map((_, i) => i)).map(i => `rId${i + 2}`)
  const lst = ids.map((rid, k) => `<p:sldId id="${256 + k}" r:id="${rid}"/>`).join('')
  entries.push({
    name: presPath,
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R_NS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${lst}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
  })
  const relDir = presPath.slice(0, presPath.lastIndexOf('/'))
  const relName = `${relDir}/_rels/${presPath.slice(presPath.lastIndexOf('/') + 1)}.rels`
  const rels = slides.map((_, i) => `<Relationship Id="rId${i + 2}" Type="${REL_SLIDE}" Target="${targetPrefix}slide${i + 1}.xml"/>`).join('')
  entries.push({
    name: relName,
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${rels}${relsExtra}</Relationships>`,
  })
  slides.forEach((inner, i) => {
    entries.push({ name: `${relDir}/slides/slide${i + 1}.xml`, data: slideXml(inner) })
    if (notes[i] !== undefined) {
      entries.push({
        name: `${relDir}/slides/_rels/slide${i + 1}.xml.rels`,
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NOTES}" Target="../notesSlides/notesSlide${i + 1}.xml"/></Relationships>`,
      })
      entries.push({
        name: `${relDir}/notesSlides/notesSlide${i + 1}.xml`,
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${sp(notes[i])}</p:spTree></p:cSld></p:notes>`,
      })
    }
  })
  entries.push(...extra)
  return buildZip(entries)
}

/** 1 GB 的 0，壓縮後大約 1 MB。靠 Z_FULL_FLUSH 讓每塊獨立，重複接起來再補一個結尾區塊，不用真的配置 1 GB。 */
export function deflateZeros(megabytes, zlib) {
  const chunk = zlib.deflateRawSync(Buffer.alloc(1 << 20), { finishFlush: zlib.constants.Z_FULL_FLUSH })
  const parts = []
  for (let i = 0; i < megabytes; i++) parts.push(chunk)
  parts.push(Buffer.from([0x03, 0x00]))
  return Buffer.concat(parts)
}

/** 可重現的亂數（mulberry32）。 */
export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
