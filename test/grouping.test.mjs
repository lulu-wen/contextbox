import './helpers/isolate-home.mjs'   // 一定要第一個 import
/**
 * 讓 agent 自己總結分類（P7）的純邏輯。規格：docs/grouping-spec.md
 *
 * 這裡守的是**規格第 3 節那幾條不變量**，每一條都對應使用者會踩到的一個壞結果：
 *   · 名字會變成磁碟上的資料夾 → 跳不出 filed 那棵樹
 *   · 一個檔只能進一組 → 不然它會被兩條路各搬一次
 *   · 送出去的東西不含檔案原文 → 分組不需要內容，也不該再送一次
 *   · 數字要加得起來 → 「沒分到」的不可以安靜消失
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  batches, capGroups, cleanGroupName, digestText, groupFormat, groupMessages,
  mergeGroups, normalizeGroups,
  GROUP_BATCH, GROUP_NAME_MAX, MAX_GROUPS,
  distinctPhrases, phraseDigest, phraseMessages, normalizePhraseGroups, capPhraseGroups, phraseKey,
} from '../core/grouping.ts'
import {
  describeFormat, describeIsUseful, describeMessages, parseDescribe,
  DESCRIBE_FIELD_MAX, DESCRIBE_VERSION,
} from '../core/describe.ts'
import { PROMPT_VERSION } from '../core/model.ts'
import { viewKey } from '../core/model-store.ts'

const row = (id, over = {}) => ({
  itemId: id, name: id + '.pdf', kind: 'Other',
  whatItIs: 'research paper', subject: 'edge AI offloading', ...over,
})

// ═══ describe：開放式的第二個問題 ═════════════════════════════

describe('describe 走自己的快取命名空間', () => {
  // 規格不變量 11：跑完之後現有的 model_views 一列都不該被動到。
  // 做法是快取鍵帶的是 DESCRIBE_VERSION，不是 PROMPT_VERSION。
  test('**同樣的內容，兩條路算出來的鍵不一樣**', () => {
    const payload = '一樣的內容'
    assert.notEqual(viewKey(payload, DESCRIBE_VERSION), viewKey(payload, PROMPT_VERSION))
  })

  test('DESCRIBE_VERSION 跟 PROMPT_VERSION 是兩個獨立的值', () => {
    assert.notEqual(DESCRIBE_VERSION, PROMPT_VERSION,
      '兩個版本號一樣的話，改其中一個就會把另一條路的快取一起作廢')
  })
})

describe('describe 的回答格式', () => {
  // 2026-09-21 的教訓：model.ts 的 evidence 沒有上限，模型就把整份文件倒進來，
  // JSON 撐爆沒收尾、整筆答案賠掉，而且那三個檔每一輪都重問。
  // 這一支是新的，不可以再犯同一個錯。
  test('**每一個自由文字欄位都要有 maxLength**', () => {
    const p = describeFormat().json_schema.schema.properties
    for (const f of ['whatItIs', 'subject']) {
      assert.equal(typeof p[f].maxLength, 'number', `${f} 沒有上限`)
      assert.equal(p[f].maxLength, DESCRIBE_FIELD_MAX)
    }
    assert.equal(describeFormat().json_schema.strict, true)
    assert.equal(describeFormat().json_schema.schema.additionalProperties, false)
  })

  test('嚴格解析：少一欄、多一欄、不是 JSON 一律不採用', () => {
    const good = { whatItIs: 'resume', subject: 'CS student', confidence: 'high' }
    assert.deepEqual(parseDescribe(JSON.stringify(good)), good)
    assert.equal(parseDescribe('{"whatItIs":"resume"}'), null, '少一欄')
    assert.equal(parseDescribe(JSON.stringify({ ...good, extra: 'x' })), null, '多一欄')
    assert.equal(parseDescribe('not json'), null)
    assert.equal(parseDescribe(JSON.stringify({ ...good, confidence: '超高' })), null, 'confidence 不在選項裡')
    assert.equal(parseDescribe(JSON.stringify({ ...good, whatItIs: 123 })), null, '不是字串')
  })

  test('欄位太長就截斷，截完是空的就整筆不採用', () => {
    const v = parseDescribe(JSON.stringify({
      whatItIs: 'x'.repeat(5000), subject: 'y'.repeat(5000), confidence: 'low',
    }))
    assert.equal(v.whatItIs.length, DESCRIBE_FIELD_MAX)
    assert.equal(v.subject.length, DESCRIBE_FIELD_MAX)
    assert.equal(
      parseDescribe(JSON.stringify({ whatItIs: '   ', subject: 'x', confidence: 'low' })), null,
      '講不出「這是什麼」就等於沒有答案')
  })

  // 「unknown」這種推辭不算答案 —— 進了分組只會把一堆不相干的檔
  // 黏成一個叫 unknown 的大組。
  test('**推辭不算答案**', () => {
    const d = (w) => ({ whatItIs: w, subject: '', confidence: 'low' })
    for (const w of ['Unknown', 'unknown', '  N/A  ', 'cannot tell', '看不出來', '未知']) {
      assert.equal(describeIsUseful(d(w)), false, w)
    }
    for (const w of ['resume', 'lab handout', 'scholarship application form']) {
      assert.equal(describeIsUseful(d(w)), true, w)
    }
    assert.equal(describeIsUseful(null), false)
  })

  test('送出去的東西裡有那段文字，而且有講「用英文回答」', () => {
    const msgs = describeMessages('作業系統 第 6 章 死結')
    const flat = JSON.stringify(msgs)
    assert.match(flat, /作業系統 第 6 章 死結/)
    assert.match(flat, /always answer in English/i, '不講死的話中文檔會換來中文答案')
    assert.match(flat, /Do not force it into any category/i, '這就是跟逐檔那條路最大的差別')
  })
})

// ═══ 分組：送出去的東西 ═══════════════════════════════════════

describe('分組送出去的是摘要，不是內容', () => {
  // 規格第 3 條。evidence 與 file_texts 的原文一個字都不可以進來。
  test('**摘要行不含檔案原文**', () => {
    const SECRET = '這是檔案裡的原文，不可以出現在分組那一次'
    const rows = [row('a'), row('b')]
    const text = digestText(rows)
    assert.ok(!text.includes(SECRET))
    // 摘要行只由這四個欄位組成
    assert.match(text, /1\. a\.pdf \| Other \| research paper \| edge AI offloading/)
    // DigestRow 的型別裡根本沒有 evidence／text 這種欄位可以夾帶
    assert.deepEqual(Object.keys(rows[0]).sort(), ['itemId', 'kind', 'name', 'subject', 'whatItIs'])
  })

  test('檔名是不可信的輸入：控制字元與換行要洗掉，不可以偽造一行', () => {
    const text = digestText([row('x', { name: '壞檔\n99. 假的一行 | x | x | x' })])
    assert.equal(text.split('\n').length, 1, '一個檔就是一行，檔名不可以多長出一行')
  })

  test('itemId 不送出去（那是我們的內部 id，模型用序號指回來就好）', () => {
    const id = '11129c10-cb53-4910-b928-52c87c321afb'
    const rows = [row(id, { name: 'Report.pdf' })]
    assert.ok(!digestText(rows).includes(id), '摘要行不該帶內部 id')
  })

  test('分批：一批最多 GROUP_BATCH 行', () => {
    const rows = Array.from({ length: 250 }, (_, i) => row('i' + i))
    const bs = batches(rows)
    assert.equal(bs.length, 3)
    assert.equal(bs[0].length, GROUP_BATCH)
    assert.equal(bs[2].length, 250 - GROUP_BATCH * 2)
    assert.equal(bs.flat().length, 250, '分批不可以掉東西')
  })

  test('分組的回答格式也是每欄有上限', () => {
    const items = groupFormat().json_schema.schema.properties.groups.items
    assert.equal(items.properties.name.maxLength, GROUP_NAME_MAX)
    assert.equal(typeof items.properties.why.maxLength, 'number')
    assert.equal(groupFormat().json_schema.schema.properties.groups.maxItems, MAX_GROUPS)
  })

  test('prompt 有講「不要硬把每個檔都塞進某一組」', () => {
    assert.match(JSON.stringify(groupMessages([row('a')])), /do not force every document into a group/i)
  })
})

// ═══ 分組：模型回來的東西要洗乾淨 ═════════════════════════════

describe('分類名稱會變成磁碟上的資料夾名', () => {
  // 規格第 9、15 條：模型碰不到路徑。跟 P3／P4 同一條不變量。
  test('**跳不出 filed 那棵樹**', () => {
    assert.equal(cleanGroupName('../../etc'), 'etc')
    // cleanField 在更前面就把「看起來像絕對路徑」的整段換成 ⋯，連拆都不用拆
    assert.equal(cleanGroupName('/etc/passwd'), '⋯')
    assert.equal(cleanGroupName('C:\\Windows\\System32'), '⋯')
    assert.equal(cleanGroupName('..'), '')
    for (const n of ['../../etc', '/etc/passwd', 'a/b', 'a\\b', '..']) {
      const c = cleanGroupName(n)
      assert.ok(!c.includes('/') && !c.includes('\\') && !c.includes('..'), n + ' -> ' + c)
    }
  })

  test('Windows 不收的字元與保留名稱', () => {
    assert.equal(cleanGroupName('a<b>c:d"e|f?g*h'), 'a b c d e f g h')
    for (const n of ['CON', 'con', 'PRN', 'nul', 'COM1', 'lpt9']) {
      assert.equal(cleanGroupName(n), '', n + ' 是 Windows 保留名稱')
    }
  })

  test('結尾的點要去掉（Windows 會安靜地吃掉，資料夾名就跟我們記的對不上）', () => {
    assert.equal(cleanGroupName('Research papers...'), 'Research papers')
    assert.equal(cleanGroupName('  spaced  '), 'spaced')
  })

  test('截到上限之後再洗一次（剛好截在一串點上）', () => {
    const c = cleanGroupName('a'.repeat(GROUP_NAME_MAX - 1) + '.' + 'b'.repeat(50))
    assert.ok([...c].length <= GROUP_NAME_MAX)
    assert.ok(!c.endsWith('.'))
  })

  test('洗完是空的 → 空字串（呼叫端會整組丟掉）', () => {
    for (const n of ['', '   ', '...', '///', null, undefined]) {
      assert.equal(cleanGroupName(n), '', JSON.stringify(n))
    }
  })
})

describe('normalizeGroups 守的那幾條', () => {
  const rows = [row('a'), row('b'), row('c')]

  test('正常的一筆', () => {
    const g = normalizeGroups([{ name: 'Papers', why: '論文', members: [1, 3] }], rows)
    assert.deepEqual(g, [{ name: 'Papers', why: '論文', itemIds: ['a', 'c'] }])
  })

  // 規格第 10 條。一個檔進兩組 → 它會被兩條路各搬一次。
  test('**一個檔最多只能出現在一組裡**，重複的留第一組', () => {
    const g = normalizeGroups([
      { name: 'First', why: '', members: [1, 2] },
      { name: 'Second', why: '', members: [2, 3] },
    ], rows)
    assert.deepEqual(g[0].itemIds, ['a', 'b'])
    assert.deepEqual(g[1].itemIds, ['c'], 'b 已經在第一組了')
    const all = g.flatMap(x => x.itemIds)
    assert.equal(new Set(all).size, all.length, '不可以有重複')
  })

  test('名字洗完是空的 → 整組丟掉（成員不會被吃掉，會留給後面的組）', () => {
    const g = normalizeGroups([
      { name: '...', why: '', members: [1] },
      { name: 'Real', why: '', members: [1, 2] },
    ], rows)
    assert.equal(g.length, 1)
    assert.deepEqual(g[0].itemIds, ['a', 'b'])
  })

  test('指到不存在的序號 → 忽略那一個，不是丟掉整組', () => {
    const g = normalizeGroups([{ name: 'X', why: '', members: [1, 99, 0, -1, 'x', null, 2.5] }], rows)
    assert.deepEqual(g[0].itemIds, ['a'])
  })

  test('一個成員都不剩 → 整組丟掉', () => {
    assert.deepEqual(normalizeGroups([{ name: 'Empty', why: '', members: [99] }], rows), [])
    assert.deepEqual(normalizeGroups([{ name: 'Empty', why: '', members: [] }], rows), [])
  })

  test('模型回的不是陣列／壞掉 → 空陣列，不丟例外', () => {
    for (const bad of [undefined, null, 'x', {}, [null], [{}], [{ name: 'a' }]]) {
      assert.deepEqual(normalizeGroups(bad, rows), [], JSON.stringify(bad))
    }
  })
})

describe('跨批合併與組數上限', () => {
  test('同名的組合併，留第一次出現的寫法', () => {
    const merged = mergeGroups([
      { name: 'Research Papers', why: 'a', itemIds: ['1', '2'] },
      { name: 'research  papers', why: 'b', itemIds: ['2', '3'] },
    ])
    assert.equal(merged.length, 1)
    assert.equal(merged[0].name, 'Research Papers')
    assert.deepEqual(merged[0].itemIds, ['1', '2', '3'], '合併之後不可以有重複')
  })

  // 規格第 11、12 條：沒分到的不可以安靜消失，數字要加得起來。
  test('**超過 MAX_GROUPS 就留最大的幾組，其餘退回「沒分到」**', () => {
    const groups = Array.from({ length: MAX_GROUPS + 3 }, (_, i) => ({
      name: 'G' + i, why: '', itemIds: Array.from({ length: i + 1 }, (_, j) => `i${i}-${j}`),
    }))
    const total = groups.reduce((n, g) => n + g.itemIds.length, 0)
    const { kept, droppedItemIds } = capGroups(groups)
    assert.equal(kept.length, MAX_GROUPS)
    const keptCount = kept.reduce((n, g) => n + g.itemIds.length, 0)
    assert.equal(keptCount + droppedItemIds.length, total, '數字要加得起來')
    // 留下來的是檔案數最多的那幾組
    assert.ok(kept.every(k => k.itemIds.length >= Math.max(...groups.map(g => g.itemIds.length)) - MAX_GROUPS))
  })

  test('沒超過就原樣回，沒有人被退回', () => {
    const groups = [{ name: 'A', why: '', itemIds: ['1'] }]
    assert.deepEqual(capGroups(groups), { kept: groups, droppedItemIds: [] })
  })
})

// ═══ centroid：對「不重複的說法」分群 ═════════════════════════
//
// 使用者（2026-09-21）：
//   > 像是 centroid 的感覺一樣，看那些檔案都比較靠近哪一個點? 以那個點來做分類之類的
//   > 所以應該是要根據 whatItIs 來看要如何衍生出新的分類
describe('分群的對象是說法，不是檔案', () => {
  test('折大小寫與空白，照次數排序，留第一次出現的寫法', () => {
    const d = distinctPhrases(['resume', 'Resume', ' resume ', 'lab handout', 'CV'])
    assert.equal(d.length, 3, 'resume 的三種寫法算一種')
    assert.deepEqual(d[0], { phrase: 'resume', count: 3 }, '最常見的排最前面，寫法留第一次的')
  })

  test('空的、只有空白的不算一種說法', () => {
    assert.deepEqual(distinctPhrases(['', '   ', null, undefined, 'resume']),
      [{ phrase: 'resume', count: 1 }])
  })

  // **成本跟檔案數無關，只跟說法的種數有關** —— 這是這個做法的重點。
  test('一千個檔只有三種說法 → 送出去的只有三行', () => {
    const many = Array.from({ length: 1000 }, (_, i) => ['resume', 'lab handout', 'invoice'][i % 3])
    const d = distinctPhrases(many)
    assert.equal(d.length, 3)
    assert.equal(phraseDigest(d).split(String.fromCharCode(10)).length, 3)
  })

  test('**送出去的只有說法與數量**：沒有檔名、沒有內容', () => {
    const text = phraseDigest(distinctPhrases(['resume', 'resume']))
    assert.equal(text, '1. resume (2)')
    assert.ok(!text.includes('.pdf') && !text.includes('.docx'))
  })

  // 第一次實測只講 prefer a few，模型回了 academic／professional／technical ——
  // 而 professional 裡同時有 resume、invoice、receipt。那種名字放到磁碟上等於沒有分類。
  test('prompt 要擋掉傘狀名字，也要擋掉「為了少分組而硬湊」', () => {
    const flat = JSON.stringify(phraseMessages([{ phrase: 'resume', count: 1 }]))
    assert.match(flat, /between 4 and 10 folders/i, '不給範圍會被過度執行成三組')
    assert.match(flat, /Misc/i)
    assert.match(flat, /a resume and an invoice do not belong in the same folder/i)
  })

  test('normalizePhraseGroups：一個說法只能進一組，序號壞掉就忽略', () => {
    // 同次數時照字母排，所以不要假設順序 —— 用序號自己算出期待值。
    const rows = distinctPhrases(['resume', 'CV', 'invoice'])
    assert.equal(rows.length, 3)
    const g = normalizePhraseGroups([
      { name: 'First', why: 'a', members: [1, 2] },
      { name: 'Second', why: 'b', members: [2, 3, 99, 'x', 0, -1] },
    ], rows)
    assert.equal(g[0].phrases.length, 2, '第一組拿到 1 與 2')
    assert.deepEqual(g[1].phrases, [phraseKey(rows[2].phrase)],
      '2 已經進第一組了，壞序號一律忽略，所以第二組只剩 3')
    const all = g.flatMap(x => x.phrases)
    assert.equal(new Set(all).size, all.length, '不可以有重複')
  })

  test('名字洗不出來就整組丟掉（說法留給後面的組）', () => {
    const rows = distinctPhrases(['resume', 'CV'])
    const g = normalizePhraseGroups([
      { name: '...', why: '', members: [1] },
      { name: 'Resumes', why: '', members: [1, 2] },
    ], rows)
    assert.equal(g.length, 1)
    assert.equal(g[0].phrases.length, 2)
  })

  test('組數超過上限 → 留涵蓋說法最多的，其餘算「沒對到」，數字加得起來', () => {
    const groups = Array.from({ length: MAX_GROUPS + 2 }, (_, i) => ({
      name: 'G' + i, why: '', phrases: Array.from({ length: i + 1 }, (_, j) => `p${i}-${j}`),
    }))
    const total = groups.reduce((n, g) => n + g.phrases.length, 0)
    const { kept, droppedPhrases } = capPhraseGroups(groups)
    assert.equal(kept.length, MAX_GROUPS)
    assert.equal(kept.reduce((n, g) => n + g.phrases.length, 0) + droppedPhrases.length, total)
  })

  test('模型回壞東西 → 空陣列，不丟例外', () => {
    const rows = distinctPhrases(['resume'])
    for (const bad of [undefined, null, 'x', {}, [null], [{}], [{ name: 'a' }]]) {
      assert.deepEqual(normalizePhraseGroups(bad, rows), [], JSON.stringify(bad))
    }
  })
})
