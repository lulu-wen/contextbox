// 測試用：在「heap 被限制」的子行程裡讀一份解析時會放大記憶體的惡意檔，把結果印成一行 JSON。
// 只給 test/office-text.test.mjs 用。
// 用法：node --max-old-space-size=<MB> office-mem-probe.mjs <種類> <XML 大小（MB）>
//
// 惡意檔本身都在單檔上限（50 MB）以內，壓縮後只有幾十 KB 到幾 MB。
// 修好之前，這些檔案解析時會吃掉 XML 大小的 10～20 倍記憶體，heap 不夠就整個行程 OOM（signal 6），
// try/catch 接不住；修好之後，記憶體只跟 XML 本身差不多大，結果是 TOO_LARGE 或正常回傳。
// pptx-long-basedir 這幾種（第三輪）不看 XML 大小：檔案只有幾百 KB，放大來自「每筆關聯都接上很長的資料夾名稱」。
import { docxText, pptxText } from '../../core/office-text.ts'
import { buildZip, documentXml, rootRels } from './office-zip.mjs'

const [kind, sizeArg] = process.argv.slice(2)
const MB = 1024 * 1024
const budget = Number(sizeArg) * MB
const REL_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide'
const REL_OFFICE_DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

/** 直接寫進 Buffer（不在 JS heap 上堆字串），免得產生測試檔本身就把 heap 用完。 */
function fill(prefix, unit, suffix) {
  const buf = Buffer.alloc(budget + 64 * 1024)
  let at = buf.write(prefix)
  for (let i = 0; at < budget; i++) at += buf.write(unit(i), at)
  at += buf.write(suffix, at)
  return buf.subarray(0, at)
}

const docx = rels => buildZip([
  { name: '_rels/.rels', data: rels },
  { name: 'word/document.xml', data: documentXml('<w:p><w:r><w:t>hello</w:t></w:r></w:p>') },
])
const docxBody = doc => buildZip([
  { name: '_rels/.rels', data: rootRels('word/document.xml') },
  { name: 'word/document.xml', data: doc },
])
const pptx = (presRels, slide = '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree/></p:cSld></p:sld>') => buildZip([
  { name: '_rels/.rels', data: rootRels('ppt/presentation.xml') },
  { name: 'ppt/presentation.xml', data: '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="rId2"/></p:sldIdLst></p:presentation>' },
  { name: 'ppt/_rels/presentation.xml.rels', data: presRels },
  { name: 'ppt/slides/slide1.xml', data: slide },
])
const MAIN_REL = `<Relationship Id="main" Type="${REL_OFFICE_DOC}" Target="word/document.xml"/>`

/**
 * 主檔放在很長的資料夾（dir）裡：presentation.xml.rels 有 9,999 筆 Target 很短的投影片關聯，sldIdLst 只用第一筆。
 * 檔案只有幾百 KB，但每筆關聯的路徑都是「dir／Target」：一次全部解開就是 9,999 份 dir。
 */
const longBaseDir = dir => {
  const main = `${dir}/presentation.xml`
  const rels = ['<Relationships>']
  for (let i = 0; i < 9999; i++) rels.push(`<Relationship Id="r${i}" Type="/slide" Target="s${i}"/>`)
  rels.push('</Relationships>')
  return buildZip([
    { name: '_rels/.rels', data: rootRels(main) },
    { name: main, data: '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="r0"/></p:sldIdLst></p:presentation>' },
    { name: `${dir}/_rels/presentation.xml.rels`, data: rels.join('') },
    { name: `${dir}/s0`, data: '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>hello</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>' },
  ])
}

const KINDS = {
  // _rels/.rels 塞滿不重複 Id 的 Relationship
  'rels-count': () => docxText(docx(fill('<Relationships>', i => `<Relationship Id="${i.toString(36)}" Target="${i.toString(36)}"/>`, `${MAIN_REL}</Relationships>`))),
  // presentation.xml.rels 塞滿投影片關聯（Type 只要結尾是 /slide 就算投影片，寫短一點塞得更多）
  'pptx-rels-count': () => pptxText(pptx(fill('<Relationships>', i => `<Relationship Id="r${i.toString(36)}" Type="/slide" Target="s${i.toString(36)}"/>`, `<Relationship Id="rId2" Type="${REL_SLIDE}" Target="slides/slide1.xml"/></Relationships>`))),
  // 一筆 Relationship 的 Target 長到幾十 MB（a/b/a/b/…：切路徑時會變成幾百萬個小字串）
  'rel-target': () => docxText(docx(fill('<Relationships><Relationship Id="x" Type="t" Target="', () => 'ab/', `"/>${MAIN_REL}</Relationships>`))),
  // 一個 Relationship 標籤上有幾百萬個屬性
  'rel-attrs': () => docxText(docx(fill(`<Relationships><Relationship Id="main" Type="${REL_OFFICE_DOC}" Target="word/document.xml"`, i => ` a${i.toString(36)}=""`, '/></Relationships>'))),
  // 一個 <w:vanish> 標籤上有幾百萬個屬性
  'vanish-attrs': () => docxText(docxBody(fill(`<w:document xmlns:w="${W_NS}"><w:body><w:p><w:r><w:rPr><w:vanish`, i => ` a${i.toString(36)}=""`, '/></w:rPr><w:t>x</w:t></w:r></w:p></w:body></w:document>'))),
  // 一個 <w:t> 裡有幾百萬個 &amp;
  'text-entities': () => docxText(docxBody(fill(`<w:document xmlns:w="${W_NS}"><w:body><w:p><w:r><w:t>`, () => '&amp;', '</w:t></w:r></w:p></w:body></w:document>'))),
  // 投影片的 <a:t> 裡有幾百萬個 &amp;
  'slide-entities': () => pptxText(pptx(
    `<Relationships><Relationship Id="rId2" Type="${REL_SLIDE}" Target="slides/slide1.xml"/></Relationships>`,
    fill('<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>', () => '&amp;', '</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'),
  )),
  // 下面三種不看 XML 大小的參數，檔案大小固定（幾百 KB）。
  // 資料夾名稱 16,000 字：9,999 份就是 160 MB
  'pptx-long-basedir': () => pptxText(longBaseDir('a'.repeat(16_000))),
  // 同樣長度、寫成 a/a/a/…：每筆還要切成 8,000 段
  'pptx-long-basedir-slashes': () => pptxText(longBaseDir('a/'.repeat(8_000).slice(0, -1))),
  // 第二輪驗證者的原始檔：資料夾名稱 65,000 字（9,999 份是 650 MB）
  'pptx-long-basedir-65000': () => pptxText(longBaseDir('a'.repeat(65_000))),
}

const run = KINDS[kind]
if (!run) throw new Error(`不認得的種類：${kind}`)
const started = performance.now()
let result
try {
  const r = run()
  result = { ok: true, chars: r.text.length, truncated: r.truncated }
} catch (err) {
  result = { ok: false, name: err?.name, code: err?.code, message: String(err?.message).slice(0, 200) }
}
result.ms = Math.round(performance.now() - started)
process.stdout.write(`${JSON.stringify(result)}\n`)
