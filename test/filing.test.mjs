import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * P4 ・ 把同一堂課的檔歸成結構化資料夾（可復原）—— 核心那一半。
 *
 * 期望值抄自 `~/contextbox-預想-20260919-P4歸檔.md`（Step 1 的表與「預期行為」十二條），
 * **在實作之前寫死**。實作過程中改測試的寫法可以，改期望值不行。
 *
 * | 段落 | 可能的錯誤 | 另一種合理解讀 | 能分辨兩者的例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | 目標路徑 | `<filed>/<課名>/` | 三層 | 作業系統的第 5 章講義 | `<filed>/課程/<課名>/<類型>/`，主題不進路徑 |
 * | 課名怎麼洗 | 直接用模型的 | 過一層清理 | `作業系統`／`../../etc` | 過 P3 的 cleanName，上限 40 字 |
 * | 課名只差空白／全形 | 兩堂課 | 同一堂 | `作業系統 `／`ＯＳ` 與 `OS` | 同一堂：NFKC＋去空白＋小寫比對 |
 * | 已經有那個資料夾 | 再建一個 | 用既有的 | `課程/作業系統/` 已存在 | 用既有的（含只差大小寫） |
 * | 目標同名 | 覆蓋 | 加序號 | 已經有 `作業系統_死結.txt` | 加序號 |
 * | 跨磁碟 | rename 就好 | 處理 EXDEV | filed 在另一顆碟 | 這一項失敗，不硬搬（複製＋刪除＝刪檔） |
 * | 一次搬幾個 | 全部 | 有上限 | 一次勾 150 個 | 前 100 個，剩下的講「還有 N 個」 |
 * | 搬完之後掃描 | 新的檔 | 同一個檔 | 搬完重掃 | 同一列：path 更新 |
 * | 復原 | 留在原地 | 搬回去 | 使用者按復原 | 搬回原本的資料夾；原位被佔就加序號 |
 * | 目標樹被人動過 | 硬搬 | 檢查 | `課程` 被換成捷徑 | checkedPath 擋掉，這一項失敗 |
 * | 空資料夾 | 收掉 | 留著 | 搬完原本的資料夾空了 | 留著（只搬不刪） |
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs, {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync,
  utimesSync, writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  applyFilings, cleanCourse, courseKey, COURSES_DIR, COURSE_MAX_CODEPOINTS, FILING_BATCH_MAX,
  filingSuggestions, folderOf, kindFolder, listFilings, OTHER_KIND, recoverInterruptedFilings,
  undoFilings, whyNotFilable,
} from '../core/filing.ts'
import { listCandidates } from '../core/cleanup-routes.ts'
import { createPlan } from '../core/cleanup-plans.ts'
import { scanDownloads } from '../core/cleanup-scanner.ts'
import { sandbox, OS_DEADLOCK, DS_MIDTERM, OS_SCHEDULING } from './helpers/rename.mjs'

/** demo 沙盒（`tools/demo-setup.mjs --seed-model`）那三筆答案，一字不改。 */
const SEEDED = {
  '作業系統_第5章_行程排程.txt': {
    course: '作業系統', topic: '行程排程', kind: 'Homework',
    suggestedName: '作業系統_行程排程', evidence: '作業系統 第 5 章 行程排程 一、排班準則', confidence: 'high',
  },
  '未命名文件 (3).txt': {
    course: '作業系統', topic: '死結', kind: 'Notes',
    suggestedName: '作業系統_死結', evidence: '死結的四個必要條件', confidence: 'high',
  },
  'IMG_2041.txt': {
    course: '資料結構', topic: '期中考範圍', kind: 'Exam',
    suggestedName: '資料結構_期中考範圍', evidence: '資料結構 期中考範圍 第一部分', confidence: 'high',
  },
}

/** demo 沙盒的三個課程檔（跟 tools/demo-setup.mjs 的內容一樣）。 */
function three(t) {
  const s = sandbox(t, {
    '作業系統_第5章_行程排程.txt': OS_SCHEDULING,
    '未命名文件 (3).txt': OS_DEADLOCK,
    'IMG_2041.txt': DS_MIDTERM,
  })
  for (const [name, view] of Object.entries(SEEDED)) s.seed(name, { ...view, seeded: true })
  return s
}

/** 一個檔的沙盒（模型看得出是作業系統的筆記）。 */
function one(t, name = '未命名文件 (3).txt', view = SEEDED['未命名文件 (3).txt']) {
  const s = sandbox(t, { [name]: OS_DEADLOCK })
  s.seed(name, view)
  return { ...s, name, itemId: s.idOf(name) }
}

const suggest = s => filingSuggestions(s.db, s.fileScope).items
const byName = (items, name) => items.find(i => i.name === name)

// ═══ 課名與類型 ・ 這一層是安全關鍵 ═══════════════════════════

describe('課名怎麼洗', () => {
  test('路徑穿越：洗完是一個普通的資料夾名，跳不出 filed', () => {
    assert.equal(cleanCourse('../../etc'), 'etc')
    assert.equal(cleanCourse('/etc/shadow'), 'etcshadow')
    for (const bad of ['../../etc', '..\\..\\Windows', 'a/b\\c', '/']) {
      const out = cleanCourse(bad)
      assert.ok(!out.includes('/') && !out.includes('\\'), `${bad} 洗完還有分隔符：${out}`)
      assert.ok(!out.startsWith('.'), `${bad} 洗完還是點開頭：${out}`)
    }
  })

  test('空的、只有點與空白、Windows 保留名稱 → 不提議（回空字串）', () => {
    for (const bad of ['', '   ', '...', '/', '../..', 'CON', 'con', 'nul', null, undefined, 42]) {
      assert.equal(cleanCourse(bad), '', JSON.stringify(bad))
    }
  })

  test('「看不出來」不是一堂課', () => {
    assert.equal(cleanCourse('Unknown'), '')
    assert.equal(cleanCourse('Unknown '), '', '前後空白折掉之後也一樣')
  })

  test(`上限 ${COURSE_MAX_CODEPOINTS} 個字，而且按碼位切`, () => {
    assert.equal([...cleanCourse('中'.repeat(100))].length, COURSE_MAX_CODEPOINTS)
    // 代理對不可以被切成一半（切壞會變成 U+FFFD）
    const out = cleanCourse('🙂'.repeat(100))
    assert.equal([...out].length, COURSE_MAX_CODEPOINTS)
    assert.ok(!out.includes('\uFFFD'), out)
  })

  test('比對鍵：NFKC ＋ 去空白 ＋ 小寫 —— 三種寫法是同一堂課', () => {
    assert.equal(courseKey('ＯＳ'), courseKey('OS'))
    assert.equal(courseKey('作業系統 '), courseKey(' 作業系統'))
    assert.equal(courseKey('os'), courseKey('OS'))
    assert.notEqual(courseKey('作業系統'), courseKey('資料結構'))
  })
})

describe('類型資料夾', () => {
  test('只收 P2 的固定選項', () => {
    for (const k of ['Lecture', 'Homework', 'Exam', 'Notes', 'Code', 'Report', 'Form', 'Chat', 'Other']) {
      assert.equal(kindFolder(k), k)
    }
  })

  test('認不得的、空的、模型自己發明的一律進「其他」', () => {
    for (const k of ['', null, undefined, '../../etc', '我自己編的類型', 42]) {
      assert.equal(kindFolder(k), OTHER_KIND, JSON.stringify(k))
    }
  })
})

describe('回給畫面的那一段', () => {
  test('只有課名與類型，不管 filed 埋得多深', () => {
    assert.equal(folderOf('/home/alice/Documents/Filed/Courses/作業系統/Lecture'), 'Courses/作業系統/Lecture')
    assert.equal(folderOf('C:\\Users\\alice\\Filed\\Courses\\作業系統\\Lecture'), 'Courses/作業系統/Lecture')
    assert.equal(folderOf(''), '')
  })
})

// ═══ 預期行為 1、2 ・ 建議清單 ═══════════════════════════════

describe('預期行為 1 ・ 三個課程檔的建議', () => {
  test('兩個作業系統的檔都進 `課程/作業系統/…`，IMG_2041 進 `課程/資料結構/考試`', t => {
    const s = three(t)
    const items = suggest(s)
    assert.equal(items.length, 3, JSON.stringify(items))
    assert.equal(byName(items, '作業系統_第5章_行程排程.txt').toFolder, 'Courses/作業系統/Homework')
    assert.equal(byName(items, '未命名文件 (3).txt').toFolder, 'Courses/作業系統/Notes')
    assert.equal(byName(items, 'IMG_2041.txt').toFolder, 'Courses/資料結構/Exam')
  })

  test('**已經有名字的檔照樣列**（跟改名不一樣：取好名字跟歸不歸得了類是兩回事）', t => {
    const s = three(t)
    const row = s.rowOf('作業系統_第5章_行程排程.txt')
    assert.equal(row.naming, 'named', '前提：它是 named')
    assert.ok(byName(suggest(s), '作業系統_第5章_行程排程.txt'), 'named 的檔要在歸檔清單上')
    assert.equal(whyNotFilable(s.db, row, s.fileScope), null)
  })

  test('主題不進路徑，但看得到（畫面上要講「模型認為⋯⋯」）', t => {
    const s = three(t)
    const item = byName(suggest(s), '未命名文件 (3).txt')
    assert.equal(item.topic, '死結')
    assert.ok(!item.toFolder.includes('死結'), item.toFolder)
    assert.equal(item.seeded, true)
    assert.equal(item.confidence, 'high')
    assert.ok(item.evidence.length > 0)
  })
})

describe('預期行為 2 ・ 看不出來的不提議', () => {
  test('信心低的不在清單（截圖那種）', t => {
    const s = one(t, '未命名文件 (3).txt', { course: '作業系統', kind: 'Notes', confidence: 'low', evidence: 'x' })
    assert.deepEqual(suggest(s), [])
  })

  test('course 是「看不出來」的不在清單，就算信心是高', t => {
    const s = one(t, '未命名文件 (3).txt', { course: 'Unknown', topic: 'Unknown', kind: 'Other', confidence: 'high' })
    assert.deepEqual(suggest(s), [])
  })

  test('模型沒看過的不在清單', t => {
    const s = sandbox(t, { '未命名文件 (3).txt': OS_DEADLOCK })
    assert.deepEqual(filingSuggestions(s.db, s.fileScope).items, [])
  })

  test('課名洗完是空的（`CON`、只有點）不在清單', t => {
    for (const course of ['CON', '...', '   ']) {
      const s = one(t, '未命名文件 (3).txt', { course, kind: 'Notes', confidence: 'high' })
      assert.deepEqual(suggest(s), [], course)
    }
  })
})

// ═══ 預期行為 3 ・ 套用 ═════════════════════════════════════

describe('預期行為 3 ・ 套用之後', () => {
  test('檔案真的在 `<filed>/課程/作業系統/筆記/`，而且原位空了（沒有留一份）', t => {
    const s = one(t)
    const r = applyFilings(s.db, [{ itemId: s.itemId }], s.fileScope)
    assert.equal(r.results[0].ok, true, r.results[0].why)
    assert.equal(r.results[0].toFolder, 'Courses/作業系統/Notes')
    assert.equal(r.results[0].to, '未命名文件 (3).txt')
    const moved = join(s.filed, COURSES_DIR, '作業系統', 'Notes', '未命名文件 (3).txt')
    assert.equal(readFileSync(moved, 'utf8'), OS_DEADLOCK)
    assert.deepEqual(readdirSync(s.downloads), [], '原位不留任何東西（搬家不是複製）')
  })

  test('`file_items` 還是同一列，只是 path 更新了', t => {
    const s = one(t)
    const before = s.db.prepare('SELECT count(*) n FROM file_items').get().n
    applyFilings(s.db, [{ itemId: s.itemId }], s.fileScope)
    assert.equal(s.db.prepare('SELECT count(*) n FROM file_items').get().n, before, '不可以變成兩列')
    const row = s.db.prepare('SELECT * FROM file_items WHERE id=?').get(s.itemId)
    assert.equal(row.path, join(s.filed, COURSES_DIR, '作業系統', 'Notes', '未命名文件 (3).txt'))
    assert.equal(row.name, '未命名文件 (3).txt')
  })

  test('搬進去的**不再出現在清理候選**（filed 不在 cleanup.roots 裡）', t => {
    // 舊的壓縮檔才會變成清理候選；.zip 讀不到文字，所以直接寫一筆看法
    const s = sandbox(t, { '期末報告.zip': 'x'.repeat(500) }, { days: 200 })
    const id = s.idOf('期末報告.zip')
    s.seedRaw('期末報告.zip', { course: '作業系統', kind: 'Report', confidence: 'high' })
    const names = () => listCandidates(s.db, { roots: [s.downloads] }).candidates.map(c => c.name)
    assert.deepEqual(names(), ['期末報告.zip'], '前提：它本來是清理候選')

    assert.equal(applyFilings(s.db, [{ itemId: id }], s.fileScope).results[0].ok, true)
    assert.deepEqual(names(), [], '搬進 filed 之後就不該再被提議清理')
    // 重掃也不可以把它標成不見了（filed 不在掃描範圍裡，那一列不歸它管）
    s.scan()
    assert.equal(s.db.prepare('SELECT status FROM file_items WHERE id=?').get(id).status !== 'missing', true)
  })

  test('搬完之後就不再出現在歸檔建議上（這一期只往 filed 裡面搬）', t => {
    const s = one(t)
    applyFilings(s.db, [{ itemId: s.itemId }], s.fileScope)
    assert.deepEqual(suggest(s), [])
    const row = s.db.prepare('SELECT * FROM file_items WHERE id=?').get(s.itemId)
    assert.match(whyNotFilable(s.db, row, s.fileScope), /already in the filed folder/)
  })

  test('不刪空資料夾：原本的子資料夾空了也留著', t => {
    const s = one(t)
    const sub = join(s.downloads, '課程資料')
    mkdirSync(sub)
    const moved = join(sub, '未命名文件 (3).txt')
    renameSync(join(s.downloads, '未命名文件 (3).txt'), moved)
    s.scan()
    const id = s.db.prepare('SELECT id FROM file_items WHERE path=?').get(moved).id
    assert.equal(applyFilings(s.db, [{ itemId: id }], s.fileScope).results[0].ok, true)
    assert.equal(existsSync(sub), true, '空掉的資料夾要留著 —— 刪資料夾也是刪')
    assert.deepEqual(readdirSync(sub), [])
  })
})

// ═══ 預期行為 4 ・ 復原 ═════════════════════════════════════

describe('預期行為 4 ・ 復原', () => {
  test('檔案回到原本的資料夾，那一列變 reverted', t => {
    const s = one(t)
    const a = applyFilings(s.db, [{ itemId: s.itemId }], s.fileScope)
    const u = undoFilings(s.db, { last: true }, s.fileScope)
    assert.equal(u.results[0].ok, true, u.results[0].why)
    assert.equal(u.results[0].restoredAs, null)
    assert.equal(readFileSync(join(s.downloads, '未命名文件 (3).txt'), 'utf8'), OS_DEADLOCK)
    assert.equal(s.db.prepare('SELECT status FROM filings WHERE id=?').get(a.results[0].id).status, 'reverted')
    assert.equal(s.db.prepare('SELECT path FROM file_items WHERE id=?').get(s.itemId).path,
      join(s.downloads, '未命名文件 (3).txt'))
  })

  test('`{ last: true }` 是整批一起回去', t => {
    const s = three(t)
    const items = suggest(s)
    assert.equal(applyFilings(s.db, items.map(i => ({ itemId: i.itemId })), s.fileScope)
      .results.filter(r => r.ok).length, 3)
    const u = undoFilings(s.db, { last: true }, s.fileScope)
    assert.equal(u.results.length, 3)
    assert.deepEqual(readdirSync(s.downloads).sort(),
      ['IMG_2041.txt', '作業系統_第5章_行程排程.txt', '未命名文件 (3).txt'])
  })

  test('復原兩次：第二次講「本來就已經復原過了」，不會再搬', t => {
    const s = one(t)
    const a = applyFilings(s.db, [{ itemId: s.itemId }], s.fileScope)
    undoFilings(s.db, { last: true }, s.fileScope)
    const again = undoFilings(s.db, { ids: [a.results[0].id] }, s.fileScope)
    assert.equal(again.results[0].ok, true)
    assert.match(again.results[0].why, /had already been undone/)
    assert.deepEqual(readdirSync(s.downloads), ['未命名文件 (3).txt'])
  })

  test('沒有東西可以復原 → NOT_FOUND', t => {
    const s = one(t)
    assert.throws(() => undoFilings(s.db, { last: true }, s.fileScope), e => e.code === 'NOT_FOUND')
    assert.throws(() => undoFilings(s.db, { ids: ['沒這筆'] }, s.fileScope), e => e.code === 'NOT_FOUND')
  })
})

// ═══ 預期行為 5 ・ 同一堂課只有一個資料夾 ═══════════════════

describe('預期行為 5 ・ 同一堂課只長一個資料夾', () => {
  test('三個檔、課名差在空白與全形 → `課程/` 底下只有一個資料夾', t => {
    const s = sandbox(t, { 'a.txt': OS_DEADLOCK, 'b.txt': OS_SCHEDULING, 'c.txt': DS_MIDTERM })
    s.seedRaw('a.txt', { course: '作業系統', kind: 'Lecture', confidence: 'high' })
    s.seedRaw('b.txt', { course: '作業系統 ', kind: 'Homework', confidence: 'high' })
    s.seedRaw('c.txt', { course: ' 作業系統', kind: 'Notes', confidence: 'high' })
    const r = applyFilings(s.db, ['a.txt', 'b.txt', 'c.txt'].map(n => ({ itemId: s.idOf(n) })), s.fileScope)
    assert.deepEqual(r.results.map(x => x.ok), [true, true, true], JSON.stringify(r.results))
    assert.deepEqual(readdirSync(join(s.filed, COURSES_DIR)), ['作業系統'])
    assert.deepEqual(readdirSync(join(s.filed, COURSES_DIR, '作業系統')).sort(), ['Homework', 'Lecture', 'Notes'])
  })

  test('全形／大小寫也算同一堂：`ＯＳ` 跟著既有的 `OS` 走', t => {
    const s = sandbox(t, { 'a.txt': OS_DEADLOCK, 'b.txt': OS_SCHEDULING })
    s.seedRaw('a.txt', { course: 'OS', kind: 'Lecture', confidence: 'high' })
    s.seedRaw('b.txt', { course: 'ＯＳ', kind: 'Homework', confidence: 'high' })
    // 分兩批做：第二批只看得到磁碟上已經有的那一個寫法
    assert.equal(applyFilings(s.db, [{ itemId: s.idOf('a.txt') }], s.fileScope).results[0].ok, true)
    const second = applyFilings(s.db, [{ itemId: s.idOf('b.txt') }], s.fileScope)
    assert.equal(second.results[0].ok, true, second.results[0].why)
    assert.equal(second.results[0].toFolder, 'Courses/OS/Homework', '要用第一次出現的寫法')
    assert.deepEqual(readdirSync(join(s.filed, COURSES_DIR)), ['OS'])
  })

  test('建議清單也照既有資料夾的寫法講（畫面上寫的位置＝真的落地的位置）', t => {
    const s = sandbox(t, { 'a.txt': OS_DEADLOCK })
    s.seedRaw('a.txt', { course: 'ＯＳ', kind: 'Lecture', confidence: 'high' })
    mkdirSync(join(s.filed, COURSES_DIR, 'OS'), { recursive: true })
    assert.equal(suggest(s)[0].toFolder, 'Courses/OS/Lecture')
  })
})

// ═══ 預期行為 6 ・ 不覆蓋 ═══════════════════════════════════

describe('預期行為 6 ・ 目標同名就加序號', () => {
  test('目標已經有同名檔 → `-2`，而且原本那一份沒有被覆蓋', t => {
    const s = one(t)
    const dest = join(s.filed, COURSES_DIR, '作業系統', 'Notes')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, '未命名文件 (3).txt'), '早就在那裡的檔')
    const r = applyFilings(s.db, [{ itemId: s.itemId }], s.fileScope)
    assert.equal(r.results[0].ok, true, r.results[0].why)
    assert.equal(r.results[0].to, '未命名文件 (3)-2.txt')
    assert.match(r.results[0].why, /未命名文件 \(3\)-2\.txt/, '要講清楚它叫什麼')
    assert.equal(readFileSync(join(dest, '未命名文件 (3).txt'), 'utf8'), '早就在那裡的檔')
    assert.equal(readFileSync(join(dest, '未命名文件 (3)-2.txt'), 'utf8'), OS_DEADLOCK)
  })

  test('同一批兩個同名的檔 → 第二個自己變 `-2`', t => {
    const s = sandbox(t, { 'a.txt': OS_DEADLOCK })
    const sub = join(s.downloads, '別的資料夾')
    mkdirSync(sub)
    writeFileSync(join(sub, 'a.txt'), OS_SCHEDULING)
    const old = new Date(Date.now() - 30 * 86400_000)
    utimesSync(join(sub, 'a.txt'), old, old)
    s.scan()
    for (const p of [join(s.downloads, 'a.txt'), join(sub, 'a.txt')]) {
      const id = s.db.prepare('SELECT id FROM file_items WHERE path=?').get(p).id
      s.db.prepare(`INSERT INTO model_views
        (key,item_id,source,course,topic,kind,suggested_name,evidence,confidence,model,prompt_version,at,seeded)
        VALUES (?,?,'text','作業系統','','Lecture','','證據','high','假模型','v1',?,0)`)
        .run('k-' + id, id, new Date().toISOString())
    }
    const items = suggest(s)
    assert.equal(items.length, 2)
    const r = applyFilings(s.db, items.map(i => ({ itemId: i.itemId })), s.fileScope)
    assert.deepEqual(r.results.map(x => x.ok), [true, true], JSON.stringify(r.results))
    assert.deepEqual(readdirSync(join(s.filed, COURSES_DIR, '作業系統', 'Lecture')).sort(), ['a-2.txt', 'a.txt'])
  })
})

// ═══ 預期行為 7 ・ 絕對不會離開 filed ═══════════════════════

describe('預期行為 7 ・ 課名是敵意輸入', () => {
  test('模型給 `../../etc` → 洗成 `etc`，檔案還在 filed 底下', t => {
    const s = one(t, '未命名文件 (3).txt', { course: '../../etc', kind: 'Notes', confidence: 'high' })
    const item = suggest(s)[0]
    assert.equal(item.toFolder, 'Courses/etc/Notes')
    const r = applyFilings(s.db, [{ itemId: s.itemId }], s.fileScope)
    assert.equal(r.results[0].ok, true, r.results[0].why)
    const where = s.db.prepare('SELECT path FROM file_items WHERE id=?').get(s.itemId).path
    assert.ok(where.startsWith(s.filed + '/'), `跑出去了：${where}`)
    assert.equal(existsSync(join(s.filed, COURSES_DIR, 'etc', 'Notes', '未命名文件 (3).txt')), true)
  })

  test('呼叫端自己送一個路徑穿越的課名 → 一樣洗過，洗完是空的就這一項失敗', t => {
    const s = one(t)
    const bad = applyFilings(s.db, [{ itemId: s.itemId, course: '../..' }], s.fileScope)
    assert.equal(bad.results[0].ok, false)
    assert.match(bad.results[0].why, /washes out to nothing/)
    assert.equal(existsSync(join(s.downloads, '未命名文件 (3).txt')), true, '一個檔都不可以動')
    assert.equal(existsSync(s.filed), false, 'filed 也不該被建出來')
  })

  test('`課程` 被換成一個捷徑 → 這一項失敗，檔案不動', t => {
    const s = one(t)
    mkdirSync(s.filed, { recursive: true })
    mkdirSync(join(s.dir, '別的地方'))
    symlinkSync(join(s.dir, '別的地方'), join(s.filed, COURSES_DIR))
    const r = applyFilings(s.db, [{ itemId: s.itemId }], s.fileScope)
    assert.equal(r.results[0].ok, false)
    assert.match(r.results[0].why, /symlink/)
    assert.equal(existsSync(join(s.downloads, '未命名文件 (3).txt')), true)
    assert.deepEqual(readdirSync(join(s.dir, '別的地方')), [], '一個檔都不可以被搬到捷徑指過去的地方')
  })
})

// ═══ 預期行為 8 ・ 中斷之後的收尾 ═══════════════════════════

describe('預期行為 8 ・ 中斷之後的收尾', () => {
  /** 做出「rename 已經做了、done 還沒寫」的狀態 —— 那正是被砍在中間的樣子。 */
  function crashAfterMove(s, { course = '作業系統', kind = 'Notes', filed = null } = {}) {
    const root = filed ?? s.filed
    const dir = join(root, COURSES_DIR, course, kind)
    mkdirSync(dir, { recursive: true })
    const id = randomUUID()
    s.db.prepare(
      `INSERT INTO filings (id,item_id,name,from_dir,to_dir,to_name,course,kind,topic,status,error,at,undone_at)
       VALUES (?,?,?,?,?,?,?,?,'','started',NULL,?,NULL)`
    ).run(id, s.itemId, s.name, s.downloads, dir, s.name, course, kind, new Date().toISOString())
    renameSync(join(s.downloads, s.name), join(dir, s.name))
    return { id, dir }
  }

  test('新位置有 → 那一列變 done，file_items 跟上，不會再搬一次', t => {
    const s = one(t)
    const { id, dir } = crashAfterMove(s)
    assert.equal(recoverInterruptedFilings(s.db).recovered, 1)
    assert.equal(s.db.prepare('SELECT status FROM filings WHERE id=?').get(id).status, 'done')
    assert.equal(s.db.prepare('SELECT path FROM file_items WHERE id=?').get(s.itemId).path, join(dir, s.name))
    recoverInterruptedFilings(s.db)
    assert.deepEqual(readdirSync(dir), [s.name])
    assert.equal(s.db.prepare('SELECT count(*) n FROM filings').get().n, 1)
  })

  test('原位有 → 那一列變 reverted（根本沒搬到）', t => {
    const s = one(t)
    const dir = join(s.filed, COURSES_DIR, '作業系統', 'Notes')
    const id = randomUUID()
    s.db.prepare(
      `INSERT INTO filings (id,item_id,name,from_dir,to_dir,to_name,course,kind,topic,status,error,at,undone_at)
       VALUES (?,?,?,?,?,?,'作業系統','Notes','','started',NULL,?,NULL)`
    ).run(id, s.itemId, s.name, s.downloads, dir, s.name, new Date().toISOString())
    assert.equal(recoverInterruptedFilings(s.db).recovered, 1)
    const row = s.db.prepare('SELECT * FROM filings WHERE id=?').get(id)
    assert.equal(row.status, 'reverted')
    assert.match(row.error, /never left its folder/)
    assert.equal(existsSync(join(s.downloads, s.name)), true)
  })

  test('兩邊都沒有 → failed，留一句話，不猜', t => {
    const s = one(t)
    const id = randomUUID()
    s.db.prepare(
      `INSERT INTO filings (id,item_id,name,from_dir,to_dir,to_name,course,kind,topic,status,error,at,undone_at)
       VALUES (?,?,'不見了.txt',?,?,'不見了.txt','作業系統','Notes','','started',NULL,?,NULL)`
    ).run(id, s.itemId, s.downloads, join(s.filed, COURSES_DIR, '作業系統', 'Notes'), new Date().toISOString())
    recoverInterruptedFilings(s.db)
    const row = s.db.prepare('SELECT * FROM filings WHERE id=?').get(id)
    assert.equal(row.status, 'failed')
    assert.match(row.error, /Check it yourself/)
  })

  test('**被砍之後先掃過一次**：掃描把新位置收成另一列，收尾要跟著那一列走（P3 的 blocker）', t => {
    // filed 落在清理範圍底下時（使用者把 filed 設在 Downloads/Filed 就會這樣），
    // 掃描會把搬過去的檔當成一個新檔收進來，舊那列變 missing。
    // 收尾如果硬改舊那列的 path，會撞 UNIQUE(file_items.path)、例外被吞掉 ——
    // 那一筆就永遠停在 started，檔案已經搬走了卻永遠復原不回來。
    const s = one(t)
    const filed = join(s.downloads, 'Filed')
    const scope = { ...s.fileScope, filed }
    const { id, dir } = crashAfterMove(s, { filed })
    // 走訪深度預設只有 3 層，filed 埋在 Downloads 底下要挖深一點才看得到（使用者把 filed
    // 設在很淺的地方、或把 cleanup.roots 設成 Documents 就是這個形狀）
    scanDownloads({ db: s.db, roots: [s.downloads], quarantine: s.scope.quarantine, maxBytes: 20 * 1024 * 1024, maxDepth: 8 })
    const rows = s.db.prepare('SELECT id, path, status FROM file_items ORDER BY path').all()
    assert.equal(rows.length, 2, `前提：掃描把新位置收成第二列：${JSON.stringify(rows)}`)

    assert.equal(recoverInterruptedFilings(s.db).recovered, 1, '收尾要收得掉')
    const row = s.db.prepare('SELECT * FROM filings WHERE id=?').get(id)
    assert.equal(row.status, 'done')
    const live = s.db.prepare('SELECT id FROM file_items WHERE path=?').get(join(dir, s.name))
    assert.equal(row.item_id, live.id, '那一筆要跟著現在有效的那一列')

    // 而且復原得回去
    const u = undoFilings(s.db, { ids: [id] }, scope)
    assert.equal(u.results[0].ok, true, u.results[0].why)
    assert.equal(existsSync(join(s.downloads, s.name)), true)
  })

  test('**filed 不在掃描範圍裡時**：掃描把舊那列標成不見了，收尾要把它接回來', t => {
    // 這是歸檔專屬的洞：filed 在 cleanup.roots 外面，掃描走不到那棵樹 ——
    // 舊那列被標 missing 之後，再也沒有任何東西會把它接回來。
    const s = one(t)
    const { id, dir } = crashAfterMove(s)
    s.scan()
    assert.equal(s.db.prepare('SELECT status FROM file_items WHERE id=?').get(s.itemId).status, 'missing',
      '前提：掃描把它標成不見了')
    assert.equal(recoverInterruptedFilings(s.db).recovered, 1)
    const row = s.db.prepare('SELECT * FROM file_items WHERE id=?').get(s.itemId)
    assert.equal(row.path, join(dir, s.name))
    assert.notEqual(row.status, 'missing', '檔案就在我們手上，不可以繼續說它不見了')
    assert.equal(row.error, null)
    assert.equal(s.db.prepare('SELECT status FROM filings WHERE id=?').get(id).status, 'done')
  })

  test('收尾真的收不掉時要留下原因（不可以安靜地一直卡著）', t => {
    const s = one(t)
    const { id } = crashAfterMove(s)
    s.db.exec(`CREATE TRIGGER no_follow BEFORE UPDATE OF path ON file_items
               BEGIN SELECT RAISE(ABORT,'擋住'); END`)
    assert.equal(recoverInterruptedFilings(s.db).recovered, 0)
    s.db.exec('DROP TRIGGER no_follow')
    const row = s.db.prepare('SELECT status, error FROM filings WHERE id=?').get(id)
    assert.equal(row.status, 'started')
    assert.match(row.error ?? '', /Tidying up failed/, '要留下線索')
    assert.equal(recoverInterruptedFilings(s.db).recovered, 1, '擋住的原因排除之後收得掉')
  })

  test('還沒收尾的那個檔，清單上先不提議；下一次 apply 會先收尾', t => {
    const s = one(t)
    const { id } = crashAfterMove(s)
    assert.deepEqual(filingSuggestions(s.db, s.fileScope).items, [])
    const r = applyFilings(s.db, [{ itemId: s.itemId }], s.fileScope)
    assert.equal(s.db.prepare('SELECT status FROM filings WHERE id=?').get(id).status, 'done')
    assert.equal(r.results[0].ok, false, '收尾之後它已經在 filed 裡，不會再搬一次')
    assert.match(r.results[0].why, /already in the filed folder/)
  })
})

// ═══ 預期行為 9 ・ 跨磁碟 ═══════════════════════════════════

describe('預期行為 9 ・ filed 在另一顆碟', () => {
  test('rename 回 EXDEV → 這一項失敗並講原因，其他項照做，而且**沒有複製＋刪除**', t => {
    const s = three(t)
    const items = suggest(s)
    const real = fs.renameSync
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (String(from).endsWith('IMG_2041.txt')) throw Object.assign(new Error('private path'), { code: 'EXDEV' })
      return real(from, to)
    })
    syncBuiltinESMExports()
    let r
    try { r = applyFilings(s.db, items.map(i => ({ itemId: i.itemId })), s.fileScope) }
    finally { t.mock.restoreAll(); syncBuiltinESMExports() }

    const bad = r.results.find(x => x.name === 'IMG_2041.txt')
    assert.equal(bad.ok, false)
    assert.match(bad.why, /another disk/)
    assert.ok(!bad.why.includes(s.filed), '訊息不可以帶絕對路徑')
    assert.equal(r.results.filter(x => x.ok).length, 2, '其他項要照做')
    // 原檔還在原位，而且**沒有**在 filed 底下多出一份（複製＋刪除會變成刪檔）
    assert.equal(readFileSync(join(s.downloads, 'IMG_2041.txt'), 'utf8'), DS_MIDTERM)
    assert.equal(existsSync(join(s.filed, COURSES_DIR, '資料結構', 'Exam', 'IMG_2041.txt')), false)
    // 那一筆紀錄是 failed，錯在哪寫下來了
    const row = s.db.prepare(`SELECT * FROM filings WHERE status='failed'`).get()
    assert.match(row.error, /another disk/)
  })
})

// ═══ 預期行為 10 ・ 一次最多 100 個 ═════════════════════════

describe(`預期行為 10 ・ 一次勾 150 個 → 做前 ${FILING_BATCH_MAX} 個`, () => {
  test('剩下的講得出來', t => {
    const files = {}
    for (let i = 0; i < 150; i++) files[`講義 (${i}).txt`] = OS_DEADLOCK + `\n第 ${i} 份\n`
    const s = sandbox(t, files)
    for (let i = 0; i < 150; i++) s.seedRaw(`講義 (${i}).txt`, { course: '作業系統', kind: 'Lecture', confidence: 'high' })
    const items = filingSuggestions(s.db, s.fileScope).items
    assert.equal(items.length, 150)
    const r = applyFilings(s.db, items.map(i => ({ itemId: i.itemId })), s.fileScope)
    assert.equal(r.results.length, FILING_BATCH_MAX)
    assert.equal(r.remaining, 150 - FILING_BATCH_MAX)
    assert.equal(r.results.every(x => x.ok), true)
    assert.equal(readdirSync(join(s.filed, COURSES_DIR, '作業系統', 'Lecture')).length, FILING_BATCH_MAX)
    assert.equal(readdirSync(s.downloads).length, 150 - FILING_BATCH_MAX)
  })
})

// ═══ 預期行為 11 ・ 復原的邊界 ═════════════════════════════

describe('預期行為 11 ・ 復原時原位被佔、原資料夾不見了', () => {
  test('原位已經有同名的檔 → 加序號，而且講清楚放回來的叫什麼', t => {
    const s = one(t)
    const a = applyFilings(s.db, [{ itemId: s.itemId }], s.fileScope)
    writeFileSync(join(s.downloads, '未命名文件 (3).txt'), '後來又下載了一次')
    const u = undoFilings(s.db, { ids: [a.results[0].id] }, s.fileScope)
    assert.equal(u.results[0].ok, true, u.results[0].why)
    assert.equal(u.results[0].restoredAs, '未命名文件 (3)-2.txt')
    assert.match(u.results[0].why, /未命名文件 \(3\)-2\.txt/)
    assert.equal(readFileSync(join(s.downloads, '未命名文件 (3).txt'), 'utf8'), '後來又下載了一次')
    assert.equal(readFileSync(join(s.downloads, '未命名文件 (3)-2.txt'), 'utf8'), OS_DEADLOCK)
  })

  test('原本的資料夾不見了 → 在清理範圍內建回來', t => {
    const s = one(t)
    const sub = join(s.downloads, '課程資料')
    mkdirSync(sub)
    renameSync(join(s.downloads, '未命名文件 (3).txt'), join(sub, '未命名文件 (3).txt'))
    s.scan()
    const id = s.db.prepare('SELECT id FROM file_items WHERE path=?').get(join(sub, '未命名文件 (3).txt')).id
    const a = applyFilings(s.db, [{ itemId: id }], s.fileScope)
    assert.equal(a.results[0].ok, true, a.results[0].why)
    rmSync(sub, { recursive: true })
    assert.equal(existsSync(sub), false, '前提：原本的資料夾不見了')

    const u = undoFilings(s.db, { last: true }, s.fileScope)
    assert.equal(u.results[0].ok, true, u.results[0].why)
    assert.equal(readFileSync(join(sub, '未命名文件 (3).txt'), 'utf8'), OS_DEADLOCK)
  })

  test('原本的資料夾在清理範圍**外**：還在就照搬回去（從桌面搬進來的那種）', t => {
    const s = one(t)
    const desktop = join(s.dir, 'Desktop')
    mkdirSync(desktop)
    renameSync(join(s.downloads, '未命名文件 (3).txt'), join(desktop, '未命名文件 (3).txt'))
    const old = new Date(Date.now() - 30 * 86400_000)
    utimesSync(join(desktop, '未命名文件 (3).txt'), old, old)
    // 桌面這一輪也在清理範圍裡（舊版就是這樣清的），搬完之後才把它拿掉
    const wide = { ...s.fileScope, roots: [s.downloads, desktop] }
    s.db.prepare('UPDATE file_items SET path=?, name=? WHERE id=?')
      .run(join(desktop, '未命名文件 (3).txt'), '未命名文件 (3).txt', s.itemId)
    const a = applyFilings(s.db, [{ itemId: s.itemId }], wide)
    assert.equal(a.results[0].ok, true, a.results[0].why)

    // 現在桌面不在清理範圍裡了 —— 放回原位不算擴大範圍
    const u = undoFilings(s.db, { last: true }, s.fileScope)
    assert.equal(u.results[0].ok, true, u.results[0].why)
    assert.equal(readFileSync(join(desktop, '未命名文件 (3).txt'), 'utf8'), OS_DEADLOCK)
  })

  test('原本的資料夾不見了、又在清理範圍外 → 不幫你建，講清楚', t => {
    const s = one(t)
    const desktop = join(s.dir, 'Desktop')
    mkdirSync(desktop)
    renameSync(join(s.downloads, '未命名文件 (3).txt'), join(desktop, '未命名文件 (3).txt'))
    const old = new Date(Date.now() - 30 * 86400_000)
    utimesSync(join(desktop, '未命名文件 (3).txt'), old, old)
    s.db.prepare('UPDATE file_items SET path=?, name=? WHERE id=?')
      .run(join(desktop, '未命名文件 (3).txt'), '未命名文件 (3).txt', s.itemId)
    const wide = { ...s.fileScope, roots: [s.downloads, desktop] }
    assert.equal(applyFilings(s.db, [{ itemId: s.itemId }], wide).results[0].ok, true)
    rmSync(desktop, { recursive: true })

    const u = undoFilings(s.db, { last: true }, s.fileScope)
    assert.equal(u.results[0].ok, false)
    assert.match(u.results[0].why, /not under a configured cleanup folder/)
    assert.equal(existsSync(desktop), false, '不可以偷偷建回來')
    // 檔案還在 filed 裡，沒有不見
    assert.equal(existsSync(join(s.filed, COURSES_DIR, '作業系統', 'Notes', '未命名文件 (3).txt')), true)
  })
})

// ═══ 預期行為 12 ・ 不外流路徑 ═════════════════════════════

describe('預期行為 12 ・ 回給呼叫端的沒有絕對路徑', () => {
  test('建議、逐項結果、復原、listFilings 通通不帶 from_dir／to_dir', t => {
    const s = three(t)
    const leaks = text => {
      assert.ok(!text.includes(s.downloads), `洩漏了 Downloads：${text}`)
      assert.ok(!text.includes(s.filed), `洩漏了 filed：${text}`)
      assert.ok(!text.includes(s.dir), `洩漏了沙盒路徑：${text}`)
      assert.ok(!text.includes(FAKE_HOME), `洩漏了家目錄：${text}`)
    }
    const items = filingSuggestions(s.db, s.fileScope).items
    leaks(JSON.stringify(items))
    const r = applyFilings(s.db, items.map(i => ({ itemId: i.itemId })), s.fileScope)
    leaks(JSON.stringify(r))
    leaks(JSON.stringify(listFilings(s.db)))
    leaks(JSON.stringify(undoFilings(s.db, { last: true }, s.fileScope)))
    // 資料庫裡**要**留著真路徑（那是唯一一份「它本來住在哪」）
    const row = s.db.prepare('SELECT from_dir, to_dir FROM filings LIMIT 1').get()
    assert.equal(row.from_dir, s.downloads)
    assert.ok(row.to_dir.startsWith(s.filed))
  })

  test('失敗的逐項結果也不帶路徑', t => {
    const s = one(t)
    s.db.prepare(`UPDATE file_items SET status='new' WHERE id=?`).run(s.itemId)
    const r = applyFilings(s.db, [{ itemId: s.itemId }], s.fileScope)
    assert.equal(r.results[0].ok, false)
    assert.ok(!JSON.stringify(r).includes(s.dir), JSON.stringify(r))
  })
})

// ═══ 擋門 ・ 跟改名同一批（不變量 5） ══════════════════════

describe('不搬的那幾種（跟改名同一批，但不看 naming）', () => {
  test('十分鐘內還在變動的不提議、也不搬', t => {
    const s = one(t)
    const now = new Date()
    utimesSync(join(s.downloads, s.name), now, now)
    s.db.prepare('UPDATE file_items SET mtime=? WHERE id=?').run(now.toISOString(), s.itemId)
    assert.deepEqual(suggest(s), [])
    assert.match(whyNotFilable(s.db, s.rowOf(s.name), s.fileScope), /ten minutes/)
    const r = applyFilings(s.db, [{ itemId: s.itemId }], s.fileScope)
    assert.equal(r.results[0].ok, false)
    assert.equal(existsSync(join(s.downloads, s.name)), true)
  })

  test('在一份還沒套用的清理計畫裡 → 不提議，而且講得出原因', t => {
    const s = sandbox(t, { '期末報告.zip': 'x'.repeat(500) }, { days: 200 })
    s.seedRaw('期末報告.zip', { course: '作業系統', kind: 'Report', confidence: 'high' })
    assert.equal(suggest(s).length, 1, '前提：本來提議得出來')
    createPlan(s.db)
    assert.deepEqual(suggest(s), [])
    assert.match(whyNotFilable(s.db, s.rowOf('期末報告.zip'), s.fileScope), /cleanup plan/)
  })

  test('捷徑與硬鏈結不搬', t => {
    const s = one(t)
    const real = join(s.dir, '真的檔')
    renameSync(join(s.downloads, s.name), real)
    symlinkSync(real, join(s.downloads, s.name))
    const r = applyFilings(s.db, [{ itemId: s.itemId }], s.fileScope)
    assert.equal(r.results[0].ok, false)
    assert.match(r.results[0].why, /symlink|ordinary file/)
    assert.equal(existsSync(real), true)
  })

  test('唯讀模式：整個請求被擋下來，一個檔都不動', t => {
    const s = one(t)
    assert.throws(() => applyFilings(s.db, [{ itemId: s.itemId }], { ...s.fileScope, readonly: true }),
      e => e.code === 'READ_ONLY')
    assert.throws(() => undoFilings(s.db, { last: true }, { ...s.fileScope, readonly: true }),
      e => e.code === 'READ_ONLY')
    assert.equal(existsSync(join(s.downloads, s.name)), true)
  })

  test('**沒有「全部」這種捷徑**：沒帶 items、空陣列、看不懂的一律 BAD_BODY，一個檔都不動', t => {
    const s = one(t)
    for (const bad of [undefined, null, [], 'all', [{ }], [{ itemId: 42 }], [{ itemId: s.itemId, kind: 5 }]]) {
      assert.throws(() => applyFilings(s.db, bad, s.fileScope), e => e.code === 'BAD_BODY', JSON.stringify(bad))
    }
    assert.equal(existsSync(join(s.downloads, s.name)), true)
  })

  test('同一個檔送兩次只做一次', t => {
    const s = one(t)
    const r = applyFilings(s.db, [{ itemId: s.itemId }, { itemId: s.itemId }], s.fileScope)
    assert.equal(r.results.length, 1)
    assert.equal(s.db.prepare('SELECT count(*) n FROM filings').get().n, 1)
  })

  test('找不到的 itemId 是逐項結果，不是整個請求失敗', t => {
    const s = one(t)
    const r = applyFilings(s.db, [{ itemId: s.itemId }, { itemId: '沒這個檔' }], s.fileScope)
    assert.equal(r.results.length, 2)
    assert.equal(r.results[0].ok, true, r.results[0].why)
    assert.equal(r.results[1].ok, false)
    assert.match(r.results[1].why, /Cannot find/)
  })
})

// ═══ 稽核補的：驗證員抓到的三個洞（2026-09-20）═══════════════

describe('稽核 ・ 寫入順序與收尾', () => {
  test('**先寫 started 再動檔案**：INSERT 之後被砍，那一列是 started 而且收得掉', t => {
    const s = one(t)
    // 真的砍掉行程太難抓那個視窗，改成在 INSERT filings 之後立刻丟例外 ——
    // 對後面的程式碼來說跟「被砍在這裡」是同一件事（檔案還沒動、done 還沒寫）。
    let thrown = false
    const db = new Proxy(s.db, {
      get(target, prop) {
        const v = Reflect.get(target, prop)
        if (prop !== 'prepare') return typeof v === 'function' ? v.bind(target) : v
        return sql => {
          const stmt = target.prepare(sql)
          if (!/INSERT INTO filings/.test(sql)) return stmt
          return new Proxy(stmt, {
            get(st, p) {
              const f = Reflect.get(st, p)
              if (p !== 'run') return typeof f === 'function' ? f.bind(st) : f
              return (...args) => { const r = st.run(...args); thrown = true; throw new Error('假裝在這裡被砍了') }
            },
          })
        }
      },
    })
    assert.throws(() => applyFilings(db, [{ itemId: s.itemId }], s.fileScope), /被砍/)
    assert.equal(thrown, true, '前提：真的走到 INSERT filings 那一行')

    const row = s.db.prepare('SELECT * FROM filings').get()
    assert.equal(row.status, 'started', '檔案還沒動的時候那一列一定要是 started，收尾才看得到它')
    assert.equal(existsSync(join(s.downloads, s.name)), true, '檔案還在原位')

    // 收尾：原位有檔 → reverted（如果剛剛寫的是 done，收尾根本不會看這一列）
    assert.equal(recoverInterruptedFilings(s.db).recovered, 1)
    const after = s.db.prepare('SELECT * FROM filings').get()
    assert.equal(after.status, 'reverted')
    assert.equal(existsSync(join(s.downloads, s.name)), true)
    // 收完之後照樣歸得了檔
    const r = applyFilings(s.db, [{ itemId: s.itemId }], s.fileScope)
    assert.equal(r.results[0].ok, true, r.results[0].why)
  })

  test('復原時原位已經有一列 missing：舊那列要收掉，不可以在 filed 底下留幽靈', t => {
    const s = one(t)
    const applied = applyFilings(s.db, [{ itemId: s.itemId }], s.fileScope)
    assert.equal(applied.results[0].ok, true, applied.results[0].why)
    const filingId = applied.results[0].id

    // 使用者又放了一個同名的檔進 Downloads → 掃描收成第二列 → 自己刪掉 → 再掃一次變 missing
    s.put(s.name, OS_DEADLOCK)   // 用 30 天前的 mtime，不然它是「還在變動」的新檔
    s.scan()
    const second = s.idOf(s.name)
    assert.notEqual(second, s.itemId, '前提：掃描收成另一列')
    rmSync(join(s.downloads, s.name))
    s.scan()
    assert.equal(s.db.prepare('SELECT status FROM file_items WHERE id=?').get(second).status, 'missing')

    const undone = undoFilings(s.db, { ids: [filingId] }, s.fileScope)
    assert.equal(undone.results[0].ok, true, undone.results[0].why)
    assert.equal(undone.results[0].restoredAs, null, '原位那一列是 missing，不算佔住名字')
    assert.equal(existsSync(join(s.downloads, s.name)), true)

    // 舊那一列（現在指著 filed 底下一個已經不存在的檔）不可以還是 kept ——
    // filed 不在掃描範圍裡，沒有人會來收它，留著會讓下一次歸檔被無故加 -2
    const ghost = s.db.prepare('SELECT * FROM file_items WHERE id=?').get(s.itemId)
    assert.equal(ghost.status, 'missing', `幽靈列：${ghost.path}`)
    assert.equal(s.db.prepare('SELECT item_id FROM filings WHERE id=?').get(filingId).item_id, second,
      '紀錄要指到活著的那一列')

    // 再歸檔一次：目標資料夾是空的，落地的名字就要是原名
    const again = applyFilings(s.db, [{ itemId: second }], s.fileScope)
    assert.equal(again.results[0].ok, true, again.results[0].why)
    assert.equal(again.results[0].to, s.name, '磁碟上沒有同名檔，不可以加序號')
    assert.deepEqual(readdirSync(join(s.filed, COURSES_DIR, '作業系統', 'Notes')), [s.name])
  })

  test('內容一樣的兄弟檔：模型只看過其中一個，另一個照樣有建議', t => {
    // filingSuggestions 為了不讓成本跟總檔數成正比，在 SQL 裡先縮小了範圍。
    // 那個條件必須是 modelViewForItem 的**超集合** —— 它除了直接對 item_id，
    // 還會找 sha256 一樣的兄弟（同樣的內容，同樣的看法）。漏掉那一條就會少列檔。
    const s = sandbox(t, { '未命名文件 (3).txt': OS_DEADLOCK, '未命名文件 (4).txt': OS_DEADLOCK })
    s.seed('未命名文件 (3).txt', SEEDED['未命名文件 (3).txt'])
    const names = suggest(s).map(i => i.name).sort()
    assert.deepEqual(names, ['未命名文件 (3).txt', '未命名文件 (4).txt'])
  })

  test('filings 表讀不到的時候不提議（不是崩掉，也不是照樣提議）', t => {
    const s = three(t)
    assert.equal(suggest(s).length, 3)
    s.db.exec('DROP TABLE filings')
    assert.deepEqual(suggest(s), [], '查不到有沒有沒收尾的紀錄時，倒向「先不動」')
  })

  test('課名截到 40 字之後要重洗：不可以留下結尾的點（Windows 會安靜吃掉）', () => {
    const out = cleanCourse('X'.repeat(38) + '..' + 'medium'.repeat(10))
    assert.equal(out, 'X'.repeat(38))
    assert.ok(!out.endsWith('.'), out)
  })
})

describe('稽核 ・ 收尾不可以蓋掉「已經成功」的整理紀錄（2026-09-20）', () => {
  /** 在收尾的 SELECT 與 UPDATE 之間插手：另一個行程剛把同一列 commit 成 done。 */
  function settleWithRaceAfterSelect(db, flip) {
    return new Proxy(db, {
      get(target, prop) {
        const v = Reflect.get(target, prop)
        if (prop !== 'prepare') return typeof v === 'function' ? v.bind(target) : v
        return sql => {
          const stmt = target.prepare(sql)
          if (!/SELECT \* FROM filings WHERE status='started'/.test(sql)) return stmt
          return new Proxy(stmt, {
            get(st, p) {
              const f = Reflect.get(st, p)
              if (p !== 'all') return typeof f === 'function' ? f.bind(st) : f
              return (...args) => { const rows = st.all(...args); flip(); return rows }
            },
          })
        }
      },
    })
  }

  test('SELECT 之後那一列被別的行程 commit 成 done → 收尾不動它，復原照樣做得到', t => {
    const s = one(t)
    const dir = join(s.filed, COURSES_DIR, '作業系統', 'Notes')
    mkdirSync(dir, { recursive: true })
    const id = randomUUID()
    s.db.prepare(
      `INSERT INTO filings (id,item_id,name,from_dir,to_dir,to_name,course,kind,topic,status,error,at,undone_at)
       VALUES (?,?,?,?,?,?,'作業系統','Notes','','started',NULL,?,NULL)`
    ).run(id, s.itemId, s.name, s.downloads, dir, s.name, new Date().toISOString())
    renameSync(join(s.downloads, s.name), join(dir, s.name))

    const flip = () => {
      s.db.prepare(`UPDATE filings SET status='done' WHERE id=?`).run(id)
      s.db.prepare('UPDATE file_items SET path=? WHERE id=?').run(join(dir, s.name), s.itemId)
    }
    recoverInterruptedFilings(settleWithRaceAfterSelect(s.db, flip))

    const row = s.db.prepare('SELECT * FROM filings WHERE id=?').get(id)
    assert.equal(row.status, 'done', '已經搬好的那一筆不可以被蓋成 failed／reverted')
    assert.equal(row.error, null)
    assert.equal(row.undone_at, null)
    const back = undoFilings(s.db, { ids: [id] }, s.fileScope)
    assert.equal(back.results[0].ok, true, back.results[0].why)
    assert.equal(existsSync(join(s.downloads, s.name)), true, '要搬得回原本的資料夾')
  })

  test('**最難看的那一種**：收尾兩次 lstat 之間檔案剛好被搬走 → 不可以把成功的那一筆寫成「請人工確認」', t => {
    // 收尾先看新位置、再看原位。renameSync 是原子的，但**兩次 lstat 之間**可以插進一整個 apply：
    // 第一次看的時候還沒搬（新位置沒有），第二次看的時候已經搬走了（原位也沒有）——
    // 於是它判「兩邊都找不到、請人工確認」。那一筆其實搬得好好的。
    const s = one(t)
    const dir = join(s.filed, COURSES_DIR, '作業系統', 'Notes')
    mkdirSync(dir, { recursive: true })
    const id = randomUUID()
    s.db.prepare(
      `INSERT INTO filings (id,item_id,name,from_dir,to_dir,to_name,course,kind,topic,status,error,at,undone_at)
       VALUES (?,?,?,?,?,?,'作業系統','Notes','','started',NULL,?,NULL)`
    ).run(id, s.itemId, s.name, s.downloads, dir, s.name, new Date().toISOString())

    // 在第一次 lstat（看新位置，還沒搬 → 不存在）之後，讓「另一個行程」把檔案搬走並 commit 成 done
    const real = fs.lstatSync
    let seen = 0
    t.mock.method(fs, 'lstatSync', (...args) => {
      const out = (() => { try { return real(...args) } catch (e) { throw e } })
      if (seen === 0 && String(args[0]) === join(dir, s.name)) {
        seen = 1
        try { return real(...args) } catch (e) {
          renameSync(join(s.downloads, s.name), join(dir, s.name))
          s.db.prepare(`UPDATE filings SET status='done' WHERE id=?`).run(id)
          s.db.prepare('UPDATE file_items SET path=? WHERE id=?').run(join(dir, s.name), s.itemId)
          throw e
        }
      }
      return out()
    })
    syncBuiltinESMExports()
    try { recoverInterruptedFilings(s.db) }
    finally { t.mock.restoreAll(); syncBuiltinESMExports() }

    const row = s.db.prepare('SELECT * FROM filings WHERE id=?').get(id)
    assert.equal(row.status, 'done', '搬成功的不可以被寫成 failed')
    assert.ok(!row.error, `不可以留下「請人工確認」：${row.error}`)
    assert.equal(existsSync(join(dir, s.name)), true)
    const back = undoFilings(s.db, { ids: [id] }, s.fileScope)
    assert.equal(back.results[0].ok, true, back.results[0].why)
  })

  test('另一種順序：apply 在收尾 SELECT 之後才 commit（檔案已經在新位置）', t => {
    const s = one(t)
    const dir = join(s.filed, COURSES_DIR, '作業系統', 'Notes')
    mkdirSync(dir, { recursive: true })
    const id = randomUUID()
    s.db.prepare(
      `INSERT INTO filings (id,item_id,name,from_dir,to_dir,to_name,course,kind,topic,status,error,at,undone_at)
       VALUES (?,?,?,?,?,?,'作業系統','Notes','','started',NULL,?,NULL)`
    ).run(id, s.itemId, s.name, s.downloads, dir, s.name, new Date().toISOString())

    // 「另一個行程」在收尾 SELECT 完之後把檔案搬走並 commit 成 done
    const flip = () => {
      renameSync(join(s.downloads, s.name), join(dir, s.name))
      s.db.prepare(`UPDATE filings SET status='done' WHERE id=?`).run(id)
      s.db.prepare('UPDATE file_items SET path=? WHERE id=?').run(join(dir, s.name), s.itemId)
    }
    recoverInterruptedFilings(settleWithRaceAfterSelect(s.db, flip))

    const row = s.db.prepare('SELECT * FROM filings WHERE id=?').get(id)
    assert.equal(row.status, 'done', '搬成功的不可以被寫成 failed')
    assert.ok(!row.error, `不可以留下「請人工確認」：${row.error}`)
    const back = undoFilings(s.db, { ids: [id] }, s.fileScope)
    assert.equal(back.results[0].ok, true, back.results[0].why)
  })
})

describe('稽核 ・ 英文化之後「說不出來」的各種寫法都要擋（2026-09-20）', () => {
  test('模型沒照 prompt 用英文回答時，不可以長出 Courses/未知/ 這種資料夾', () => {
    for (const said of ['Unknown', 'unknown', 'ＵＮＫＮＯＷＮ', ' Unknown ', '看不出來', '未知', '不知道',
      'unclear', 'not sure', 'none', 'N/A', 'null']) {
      assert.equal(cleanCourse(said), '', `「${said}」不是一堂課`)
    }
  })

  test('真的課名不可以被這條擋掉', () => {
    for (const real of ['Operating Systems', '作業系統', 'Unknown Pleasures', 'Nonlinear Optics', 'Nanotech']) {
      assert.notEqual(cleanCourse(real), '', real)
    }
  })

  test('提示詞講死了「檔案可以是任何語言，但用英文回答」', async () => {
    const { SYSTEM_PROMPT, USER_PROMPT } = await import('../core/model.ts')
    const both = SYSTEM_PROMPT + '\n' + USER_PROMPT
    assert.match(both, /any language/i, '要講「檔案可能是任何語言」—— 不然中文講義會被跳過')
    assert.match(both, /in English/i, '要講「用英文回答」—— course 會變成磁碟上的資料夾名')
    assert.match(both, /exact word Unknown/i, '要講死 Unknown 那個字，不可以是它的翻譯')
    assert.match(both, /original language|do not translate/i, '證據是原文引用，翻譯過的不算證據')
  })
})
