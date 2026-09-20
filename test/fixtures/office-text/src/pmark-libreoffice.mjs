// 開發期用：重新產生 ../pmark-libreoffice.json（修訂模式刪掉的段落標記：document.xml 的本文＋LibreOffice 的標準答案）。
// 需要 soffice（LibreOffice）與它附的 python3 uno 模組。測試執行時不跑這支，只讀它產生的 JSON。
// 用法：node test/fixtures/office-text/src/pmark-libreoffice.mjs
//
// 例子分兩種：明確的邊界例子（表格前、儲存格最後一段、表格最後一格、sdt、書籤…），以及結構化亂數
// （段落、段落標記被刪、刪除／插入的字、<w:br/>、表格〔最多兩層〕、sdt、書籤）。
// 不含 moveFrom：LibreOffice 24.2 不處理段落標記上的 moveFrom，拿它當標準答案沒有意義。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildZip, documentXml, rootRels } from '../../../helpers/office-zip.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const OUT = join(HERE, '..', 'pmark-libreoffice.json')

const D = (id, kind = 'del') => `<w:pPr><w:rPr><w:${kind} w:id="${id}" w:author="t"/></w:rPr></w:pPr>`
const r = t => `<w:r><w:t>${t}</w:t></w:r>`
const cell = inner => `<w:tc>${inner}</w:tc>`
const tbl = rows => `<w:tbl><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid>${rows}</w:tbl>`
const row = (...cells) => `<w:tr>${cells.map(cell).join('')}</w:tr>`
const bm = id => `<w:bookmarkStart w:id="${id}" w:name="bm${id}"/>`
const bmEnd = id => `<w:bookmarkEnd w:id="${id}"/>`
const sdt = inner => `<w:sdt><w:sdtContent>${inner}</w:sdtContent></w:sdt>`

const cases = {
  beforeTable: `<w:p>${D(1)}${r('表前')}</w:p>${tbl(row(`<w:p>${r('格一')}</w:p>`, `<w:p>${r('格二')}</w:p>`))}<w:p>${r('表後')}</w:p>`,
  cellEnd: `${tbl(row(`<w:p>${D(1)}${r('格一')}</w:p>`, `<w:p>${r('格二')}</w:p>`))}<w:p>${r('表後')}</w:p>`,
  lastCellThenPara: `<w:p>${r('前')}</w:p>${tbl(row(`<w:p>${r('格一')}</w:p>`, `<w:p>${D(1)}${r('格二')}</w:p>`))}<w:p>${r('表後')}</w:p>`,
  cellInner: tbl(row(`<w:p>${D(1)}${r('甲')}</w:p><w:p>${r('乙')}</w:p>`, `<w:p>${r('丙')}</w:p>`)),
  chain: `<w:p>${D(1)}${r('一')}</w:p><w:p>${D(2)}${r('二')}</w:p><w:p>${r('三')}</w:p><w:p>${r('四')}</w:p>`,
  beforeEmpty: `<w:p>${D(1)}${r('一')}</w:p><w:p/><w:p>${r('三')}</w:p>`,
  lastPara: `<w:p>${r('一')}</w:p><w:p>${D(1)}${r('末')}</w:p>`,
  bookmarkBetween: `<w:p>${D(1)}${r('一')}</w:p>${bm(5)}<w:p>${r('二')}</w:p>${bmEnd(5)}<w:p>${r('三')}</w:p>`,
  bookmarkEndBetween: `${bm(6)}<w:p>${D(1)}${r('一')}</w:p>${bmEnd(6)}<w:p>${r('二')}</w:p>`,
  beforeSdt: `<w:p>${D(1)}${r('一')}</w:p>${sdt(`<w:p>${r('二')}</w:p>`)}<w:p>${r('三')}</w:p>`,
  lastInSdt: `${sdt(`<w:p>${D(1)}${r('一')}</w:p>`)}<w:p>${r('二')}</w:p>`,
  innerSdt: sdt(`<w:p>${D(1)}${r('一')}</w:p><w:p>${r('二')}</w:p>`),
  nestedTableInCell: tbl(row(`<w:p>${D(1)}${r('外')}</w:p>${tbl(row(`<w:p>${r('內一')}</w:p>`, `<w:p>${r('內二')}</w:p>`))}<w:p/>`, `<w:p>${r('右')}</w:p>`)),
  cellLastBeforeNextRow: tbl(row(`<w:p>${r('一')}</w:p>`, `<w:p>${D(1)}${r('二')}</w:p>`) + row(`<w:p>${r('三')}</w:p>`, `<w:p>${r('四')}</w:p>`)),
  tableThenMarkedThenTable: `${tbl(row(`<w:p>${r('一')}</w:p>`, `<w:p>${r('二')}</w:p>`))}<w:p>${D(1)}${r('中')}</w:p>${tbl(row(`<w:p>${r('三')}</w:p>`, `<w:p>${r('四')}</w:p>`))}`,
  markedChainIntoTable: `<w:p>${D(1)}${r('一')}</w:p><w:p>${D(2)}${r('二')}</w:p>${tbl(row(`<w:p>${r('格')}</w:p>`, `<w:p>${r('格二')}</w:p>`))}`,
  // 儲存格裡沒有段落的表格（不合 schema）：表格照樣擋，不會跨過表格接到後面那段
  emptyCellTable: `<w:p>${D(1)}${r('一')}</w:p><w:tbl><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc/></w:tr></w:tbl><w:p>${r('二')}</w:p>`,
  wholeDeletedBeforeTable: `<w:p>${r('前')}</w:p><w:p>${D(1)}<w:del w:id="2" w:author="t"><w:r><w:delText>刪掉</w:delText></w:r></w:del></w:p>${tbl(row(`<w:p>${r('格一')}</w:p>`, `<w:p>${r('格二')}</w:p>`))}`,
}

// 結構化亂數（固定種子，重跑結果一樣）
let seed = 20260919
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const ri = n => Math.floor(rand() * n)
let word = 0
const w = () => `字${++word}`
const run = () => {
  const k = ri(10)
  if (k < 5) return r(w())
  if (k < 7) return `<w:del w:id="${ri(100)}" w:author="t"><w:r><w:delText>刪${++word}</w:delText></w:r></w:del>`
  if (k < 9) return `<w:ins w:id="${ri(100)}" w:author="t"><w:r><w:t>${w()}</w:t></w:r></w:ins>`
  return `<w:r><w:t>${w()}</w:t><w:br/><w:t>${w()}</w:t></w:r>`
}
const para = () => {
  const mark = rand() < 0.35 ? D(ri(100)) : ''
  return `<w:p>${mark}${Array.from({ length: ri(4) }, run).join('')}</w:p>`
}
const between = () => (rand() < 0.15 ? bm(ri(1000)) : '')
const blocks = (n, depth) => {
  const out = []
  for (let i = 0; i < n; i++) {
    out.push(between())
    const x = rand()
    if (x < 0.2 && depth < 2 - (rand() < 0.5 ? 1 : 0)) {
      out.push(tbl(Array.from({ length: 1 + ri(2) }, () => row(blocks(1 + ri(2), depth + 1), blocks(1 + ri(2), depth + 1))).join('')))
    } else if (x < 0.27) {
      out.push(sdt(blocks(1 + ri(2), depth + 1)))
    } else {
      out.push(para())
    }
  }
  // 儲存格最後一定要是段落
  if (depth > 0) out.push(para())
  return out.join('')
}
// 只留 2,000 字以內的（fixture 才不會太大）
for (let i = 0; i < 50;) {
  const body = blocks(3 + ri(6), 0) + `<w:p>${r(w())}</w:p>`
  if (body.length <= 2000) cases[`rnd${String(i++).padStart(3, '0')}`] = body
}

// 跟測試的 makeDocx 一樣的 document.xml；[Content_Types].xml 寫完整，LibreOffice 才開得起來
const docx = body => buildZip([
  { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
  { name: '_rels/.rels', data: rootRels('word/document.xml') },
  { name: 'word/document.xml', data: documentXml(body) },
])

const tmp = mkdtempSync(join(tmpdir(), 'pmark-'))
try {
  const files = Object.entries(cases).map(([name, body]) => {
    const file = join(tmp, `${name}.docx`)
    writeFileSync(file, docx(body))
    return file
  })
  execFileSync('python3', [join(HERE, 'accept-all-changes.py'), join(tmp, 'profile'), ...files], { stdio: 'inherit' })
  const out = {
    note: '修訂模式刪掉的段落標記：body 是 document.xml 的 <w:body> 內容，libreoffice 是 LibreOffice 24.2「接受所有修訂」後匯出的 UTF-8 純文字。由 src/pmark-libreoffice.mjs 產生。',
    cases: Object.entries(cases).map(([name, body]) => ({
      name,
      body,
      libreoffice: readFileSync(join(tmp, `${name}.docx.accepted.txt`), 'utf8').replace(/^\uFEFF/, ''),
    })),
  }
  writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`)
  console.log(`寫好 ${out.cases.length} 個例子：${OUT}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
