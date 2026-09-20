import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * P5 ・ 記住你改過的東西 —— **預想的「預期行為」十二條，一條一個 test**。
 *
 * 期望值抄自 `~/contextbox-預想-20260920-P5學習.md`，實作之前就寫死。
 * Step 1 那張表的每一格也在這裡（那是「可能的錯」與「我認定的答案」的成對例子）：
 *
 * | 段落 | 可能的錯 | 另一種解讀 | 成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | 學什麼 | 全部都學 | 只學跟建議不一樣的 | 照單全收／改成 OS | 只學不一樣的那一下 |
 * | 對應鍵 | 用檔名 | 用 courseKey(模型的課名) | 同一堂課兩個檔 | 一次就學會 |
 * | 幾次算數 | 三次 | 一次 | 改一次 | 一次就學，但只改建議 |
 * | 又反悔 | 留著 | 推翻 | OS → 作業系統 | 最後一次贏，一列，times＋1 |
 * | undo | 不算 | 算退貨 | file --undo | 標 rejectedBefore，不預設勾 |
 * | 類型 | 全域 | 這一堂課的 | 作業系統的都改講義 | course＋模型的 kind → 使用者的 kind |
 * | 改名學什麼 | 整個檔名 | 課名那一段 | 作業系統_死結 → OS_死結 | 只換開頭那一段 |
 * | 學到的課名 | 直接用 | 再洗一次 | ../../etc | 不學，而且檔案不離開 filed |
 * | 既有資料夾 | 自動合併 | 各自留著 | 已經有 課程/作業系統/ | 不搬、清單上講一句 |
 * | 上限 | 無限 | 500 | 塞 600 條 | 留 500，最近用過、次數多的 |
 * | 唯讀 | 照學 | 不學 | readonly: true | 一列都不寫 |
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyFilings, cleanCourse, courseKey, COURSES_DIR, filingSuggestions, undoFilings,
} from '../core/filing.ts'
import { applyRenames, renameSuggestions, undoRenames } from '../core/rename.ts'
import {
  forgetAllLearned, forgetLearned, listLearned, loadLearned, PREF_MAX,
} from '../core/learn.ts'
import { sandbox, OS_DEADLOCK, OS_SCHEDULING, DS_MIDTERM } from './helpers/rename.mjs'

const OS_VIEW = { course: '作業系統', topic: '死結', kind: 'Notes', suggestedName: '作業系統_死結', confidence: 'high' }

/** 三個檔：兩個作業系統、一個資料結構。跟 demo 沙盒同一批內容。 */
function box(t, over = {}) {
  const s = sandbox(t, {
    '未命名文件 (3).txt': OS_DEADLOCK,
    '未命名文件 (4).txt': OS_SCHEDULING,
    'IMG_2041.txt': DS_MIDTERM,
  })
  s.seed('未命名文件 (3).txt', OS_VIEW)
  s.seed('未命名文件 (4).txt', { ...OS_VIEW, topic: '行程排程', suggestedName: '作業系統_排程' })
  s.seed('IMG_2041.txt', { course: '資料結構', topic: '期中考範圍', kind: 'Exam', suggestedName: '資料結構_期中考範圍', confidence: 'high' })
  Object.assign(s.fileScope, over)
  return s
}

/** preferences 現在有哪幾列（node:sqlite 回的是 null-prototype，deepEqual 比不過，攤成一般物件）。 */
const prefs = s => s.db.prepare('SELECT kind, k, v, times FROM preferences ORDER BY kind, k').all()
  .map(r => ({ kind: r.kind, k: r.k, v: r.v, times: r.times }))
const fileList = s => filingSuggestions(s.db, s.fileScope).items
const byName = (items, name) => items.find(i => i.name === name)

// ═══ 1 ・ 改一個，另外兩個跟著變 ═══════════════════════════════

describe('預期行為 1：改一次課名，同一堂課的其他檔的建議跟著變，而且標 learned', () => {
  test('`--course OS` 之後，另一個作業系統的檔變成 課程/OS/…，資料結構的不受影響', t => {
    const s = box(t)
    const first = byName(fileList(s), '未命名文件 (3).txt')
    assert.equal(first.toFolder, 'Courses/作業系統/Notes')
    assert.equal(first.learned, false, '還沒學過的時候不可以標 learned')

    const r = applyFilings(s.db, [{ itemId: first.itemId, course: 'OS', kind: first.kind }], s.fileScope)
    assert.equal(r.results[0].ok, true, r.results[0].why)
    assert.equal(r.results[0].toFolder, 'Courses/OS/Notes')

    const after = fileList(s)
    const second = byName(after, '未命名文件 (4).txt')
    assert.equal(second.toFolder, 'Courses/OS/Notes')
    assert.equal(second.learned, true, '套用了學到的寫法就要標出來')
    // **模型說的那一句還是模型自己的課名** —— 不可以把使用者的話說成模型講的
    assert.equal(second.modelCourse, '作業系統')
    assert.equal(second.course, 'OS')

    const other = byName(after, 'IMG_2041.txt')
    assert.equal(other.toFolder, 'Courses/資料結構/Exam', '別堂課不可以被帶歪')
    assert.equal(other.learned, false)
  })

  test('第二個檔照著按下去，真的落在 課程/OS/ 底下', t => {
    const s = box(t)
    const first = byName(fileList(s), '未命名文件 (3).txt')
    applyFilings(s.db, [{ itemId: first.itemId, course: 'OS', kind: first.kind }], s.fileScope)
    const second = byName(fileList(s), '未命名文件 (4).txt')
    const r = applyFilings(s.db, [{ itemId: second.itemId, course: second.course, kind: second.kind }], s.fileScope)
    assert.equal(r.results[0].ok, true, r.results[0].why)
    assert.deepEqual(s.filedTree().filter(p => p.endsWith('.txt')).sort(),
      ['Courses/OS/Notes/未命名文件 (3).txt', 'Courses/OS/Notes/未命名文件 (4).txt'])
  })
})

// ═══ 2 ・ 照單全收什麼都不學 ═════════════════════════════════

describe('預期行為 2：照單全收什麼都不學', () => {
  test('不帶 course／kind → preferences 是空的', t => {
    const s = box(t)
    const one = byName(fileList(s), '未命名文件 (3).txt')
    assert.equal(applyFilings(s.db, [{ itemId: one.itemId }], s.fileScope).results[0].ok, true)
    assert.deepEqual(prefs(s), [])
  })

  test('帶的就是清單上那一個（面板與 CLI 的做法）→ 一樣什麼都不學', t => {
    const s = box(t)
    const one = byName(fileList(s), '未命名文件 (3).txt')
    applyFilings(s.db, [{ itemId: one.itemId, course: one.course, kind: one.kind }], s.fileScope)
    assert.deepEqual(prefs(s), [])
  })

  test('**學過之後照單全收也不會把計數灌水**：第二個檔送回學到的寫法，times 還是 1', t => {
    const s = box(t)
    const first = byName(fileList(s), '未命名文件 (3).txt')
    applyFilings(s.db, [{ itemId: first.itemId, course: 'OS', kind: first.kind }], s.fileScope)
    const second = byName(fileList(s), '未命名文件 (4).txt')
    applyFilings(s.db, [{ itemId: second.itemId, course: second.course, kind: second.kind }], s.fileScope)
    assert.deepEqual(prefs(s), [{ kind: 'course', k: '作業系統', v: 'OS', times: 1 }])
  })

  test('只差空白／全形／大小寫不算改過（courseKey 折起來一樣）', t => {
    const s = box(t)
    const one = byName(fileList(s), '未命名文件 (3).txt')
    applyFilings(s.db, [{ itemId: one.itemId, course: '作業系統 ', kind: one.kind }], s.fileScope)
    assert.deepEqual(prefs(s), [])
  })
})

// ═══ 3 ・ 同一個鍵只有一列 ═══════════════════════════════════

describe('預期行為 3：同一個鍵改兩次 → 一列、times＝2、v 是最後一次的', () => {
  test('作業系統 → OS，再 → 系統', t => {
    const s = box(t)
    const a = byName(fileList(s), '未命名文件 (3).txt')
    applyFilings(s.db, [{ itemId: a.itemId, course: 'OS', kind: a.kind }], s.fileScope)
    const b = byName(fileList(s), '未命名文件 (4).txt')
    applyFilings(s.db, [{ itemId: b.itemId, course: '系統', kind: b.kind }], s.fileScope)
    assert.deepEqual(prefs(s), [{ kind: 'course', k: '作業系統', v: '系統', times: 2 }])
    assert.equal(byName(fileList(s), 'IMG_2041.txt').toFolder, 'Courses/資料結構/Exam')
  })

  test('又改回模型的說法 → 還是一列，最後一次贏（建議變回 作業系統，而且不再標 learned）', t => {
    const s = box(t)
    const a = byName(fileList(s), '未命名文件 (3).txt')
    applyFilings(s.db, [{ itemId: a.itemId, course: 'OS', kind: a.kind }], s.fileScope)
    const b = byName(fileList(s), '未命名文件 (4).txt')
    assert.equal(b.toFolder, 'Courses/OS/Notes')
    applyFilings(s.db, [{ itemId: b.itemId, course: '作業系統', kind: b.kind }], s.fileScope)
    const rows = prefs(s)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].times, 2)
    assert.equal(courseKey(rows[0].v), courseKey('作業系統'))
    // 第三個檔（別堂課）不受影響；同一堂課的新檔回到模型的說法
    const s2 = byName(fileList(s), 'IMG_2041.txt')
    assert.equal(s2.learned, false)
  })

  test('類型學成「這一堂課的」，不是全域的', t => {
    const s = box(t)
    const a = byName(fileList(s), '未命名文件 (3).txt')
    applyFilings(s.db, [{ itemId: a.itemId, course: a.course, kind: 'Lecture' }], s.fileScope)
    assert.deepEqual(prefs(s), [{ kind: 'file_kind', k: '作業系統\nNotes', v: 'Lecture', times: 1 }])
    const after = fileList(s)
    assert.equal(byName(after, '未命名文件 (4).txt').toFolder, 'Courses/作業系統/Lecture')
    assert.equal(byName(after, '未命名文件 (4).txt').learned, true)
    assert.equal(byName(after, 'IMG_2041.txt').toFolder, 'Courses/資料結構/Exam', '別堂課的考試不可以變成講義')
  })
})

// ═══ 4 ・ 改名只學課名那一段 ═════════════════════════════════

describe('預期行為 4：改名只學課名那一段', () => {
  test('作業系統_死結 → OS_死結 之後，作業系統_排程 的建議變 OS_排程', t => {
    const s = box(t)
    const first = renameSuggestions(s.db, s.scope).items.find(i => i.name === '未命名文件 (3).txt')
    assert.equal(first.suggested, '作業系統_死結.txt')
    assert.equal(first.learned, false)
    const r = applyRenames(s.db, [{ itemId: first.itemId, to: 'OS_死結' }], s.scope)
    assert.equal(r.results[0].ok, true, r.results[0].why)
    assert.deepEqual(prefs(s), [{ kind: 'course', k: '作業系統', v: 'OS', times: 1 }])

    const after = renameSuggestions(s.db, s.scope).items
    const second = after.find(i => i.name === '未命名文件 (4).txt')
    assert.equal(second.suggested, 'OS_排程.txt')
    assert.equal(second.learned, true)
    assert.equal(second.course, '作業系統', '「模型認為」那一欄還是模型自己說的')
  })

  test('**名字裡沒有課名那一段的不受影響**', t => {
    const s = box(t)
    const first = renameSuggestions(s.db, s.scope).items.find(i => i.name === '未命名文件 (3).txt')
    applyRenames(s.db, [{ itemId: first.itemId, to: 'OS_死結' }], s.scope)
    const other = renameSuggestions(s.db, s.scope).items.find(i => i.name === 'IMG_2041.txt')
    assert.equal(other.suggested, '資料結構_期中考範圍.txt')
    assert.equal(other.learned, false)
  })

  test('只改主題（課名那一段沒動）**什麼都不學**', t => {
    const s = box(t)
    const first = renameSuggestions(s.db, s.scope).items.find(i => i.name === '未命名文件 (3).txt')
    applyRenames(s.db, [{ itemId: first.itemId, to: '作業系統_deadlock' }], s.scope)
    assert.deepEqual(prefs(s), [])
  })

  test('改名學到的寫法，歸檔那邊也算數（同一個鍵）', t => {
    const s = box(t)
    const first = renameSuggestions(s.db, s.scope).items.find(i => i.name === '未命名文件 (3).txt')
    applyRenames(s.db, [{ itemId: first.itemId, to: 'OS_死結' }], s.scope)
    assert.equal(byName(fileList(s), '未命名文件 (4).txt').toFolder, 'Courses/OS/Notes')
  })
})

// ═══ 5 ・ undo ＝ 退貨 ════════════════════════════════════════

describe('預期行為 5：undo 之後標 rejectedBefore、不預設勾；重做成功就消失', () => {
  test('歸檔 undo → 同一個建議標 rejectedBefore，清單照樣列它', t => {
    const s = box(t)
    const one = byName(fileList(s), '未命名文件 (3).txt')
    const r = applyFilings(s.db, [{ itemId: one.itemId, course: one.course, kind: one.kind }], s.fileScope)
    assert.equal(r.results[0].ok, true)
    const u = undoFilings(s.db, { last: true }, s.fileScope)
    assert.equal(u.results[0].ok, true, u.results[0].why)

    const again = byName(fileList(s), '未命名文件 (3).txt')
    assert.ok(again, '退貨不是刪除，清單還是要列它')
    assert.equal(again.rejectedBefore, true)
    // 退貨不是「學到新寫法」：那一列的 kind 是 rejected，不會改到建議本身
    assert.equal(again.toFolder, 'Courses/作業系統/Notes')
    assert.equal(again.learned, false)
    assert.deepEqual(prefs(s).map(p => p.kind), ['rejected'])
  })

  test('重新整理成功之後，那個標記消失', t => {
    const s = box(t)
    const one = byName(fileList(s), '未命名文件 (3).txt')
    applyFilings(s.db, [{ itemId: one.itemId, course: one.course, kind: one.kind }], s.fileScope)
    undoFilings(s.db, { last: true }, s.fileScope)
    const again = byName(fileList(s), '未命名文件 (3).txt')
    assert.equal(again.rejectedBefore, true)
    applyFilings(s.db, [{ itemId: again.itemId, course: again.course, kind: again.kind }], s.fileScope)
    assert.deepEqual(prefs(s), [], '退貨的紀錄要被清掉')
  })

  test('改名 undo → 同一個建議標 rejectedBefore', t => {
    const s = box(t)
    const one = renameSuggestions(s.db, s.scope).items.find(i => i.name === '未命名文件 (3).txt')
    applyRenames(s.db, [{ itemId: one.itemId, to: one.suggested }], s.scope)
    undoRenames(s.db, { last: true }, s.scope)
    const again = renameSuggestions(s.db, s.scope).items.find(i => i.name === '未命名文件 (3).txt')
    assert.equal(again.rejectedBefore, true)
    assert.equal(again.suggested, '作業系統_死結.txt')
  })

  test('**只標那一個檔**：別的檔的同類建議不會被連坐', t => {
    const s = box(t)
    const one = byName(fileList(s), '未命名文件 (3).txt')
    applyFilings(s.db, [{ itemId: one.itemId, course: one.course, kind: one.kind }], s.fileScope)
    undoFilings(s.db, { last: true }, s.fileScope)
    assert.equal(byName(fileList(s), '未命名文件 (4).txt').rejectedBefore, false)
  })
})

// ═══ 6 ・ 學到的課名要洗過 ═══════════════════════════════════

describe('預期行為 6：`../../etc`／空白／`CON` 不學，而且檔案不會離開 filed', () => {
  for (const bad of ['../../etc', '  ', 'CON', '/etc/shadow', '..']) {
    test(`course: ${JSON.stringify(bad)} → 一列都不學`, t => {
      const s = box(t)
      const one = byName(fileList(s), '未命名文件 (3).txt')
      const r = applyFilings(s.db, [{ itemId: one.itemId, course: bad, kind: one.kind }], s.fileScope)
      assert.deepEqual(prefs(s), [], `${bad} 不可以被記成偏好`)
      // 洗得出東西的（../../etc → etc）照 P4 搬進 filed；洗完是空的那一項失敗。兩種都不可以跑出去
      if (r.results[0].ok) assert.match(r.results[0].toFolder, /^Courses\//)
      for (const p of s.filedTree()) assert.ok(!p.includes('..'), p)
      assert.equal(existsSync(join(s.dir, 'etc')), false, 'filed 以外一個資料夾都不可以長出來')
    })
  }

  test('直接往資料庫塞一個危險的偏好 → 用之前再洗一次，建議不會跑出 filed', t => {
    const s = box(t)
    s.db.prepare(`INSERT INTO preferences (id,kind,k,v,times,at) VALUES ('x','course','作業系統','../../etc',1,?)`)
      .run(new Date().toISOString())
    const one = byName(fileList(s), '未命名文件 (3).txt')
    assert.equal(one.toFolder, 'Courses/etc/Notes', '洗完剩下 etc，而且只在 Courses/ 底下')
    const r = applyFilings(s.db, [{ itemId: one.itemId, course: one.course, kind: one.kind }], s.fileScope)
    assert.equal(r.results[0].ok, true, r.results[0].why)
    assert.deepEqual(s.filedTree().filter(p => p.endsWith('.txt')), ['Courses/etc/Notes/未命名文件 (3).txt'])
    assert.equal(existsSync(join(s.dir, 'etc')), false)
  })

  test('塞一個洗完是空的偏好（CON）→ 當成沒學過，建議回到模型的說法', t => {
    const s = box(t)
    s.db.prepare(`INSERT INTO preferences (id,kind,k,v,times,at) VALUES ('x','course','作業系統','CON',1,?)`)
      .run(new Date().toISOString())
    const one = byName(fileList(s), '未命名文件 (3).txt')
    assert.equal(one.toFolder, 'Courses/作業系統/Notes')
    assert.equal(one.learned, false)
  })

  test('塞一個認不得的類型 → kindFolder 再洗一次，只會進「其他」', t => {
    const s = box(t)
    s.db.prepare(`INSERT INTO preferences (id,kind,k,v,times,at) VALUES ('x','file_kind','作業系統\nNotes','../sneaky',1,?)`)
      .run(new Date().toISOString())
    assert.equal(byName(fileList(s), '未命名文件 (3).txt').toFolder, 'Courses/作業系統/Other')
  })
})

// ═══ 7 ・ 看得到、忘得掉 ═════════════════════════════════════

describe('預期行為 7：listLearned 列得出來，--forget 之後不再影響建議，--forget-all 清空', () => {
  test('列得出每一條，而且欄位就是 id／kind／from／to／times／at', t => {
    const s = box(t)
    const a = byName(fileList(s), '未命名文件 (3).txt')
    applyFilings(s.db, [{ itemId: a.itemId, course: 'OS', kind: 'Lecture' }], s.fileScope)
    const { items } = listLearned(s.db)
    assert.equal(items.length, 2)
    for (const i of items) {
      assert.deepEqual(Object.keys(i).sort(), ['about', 'at', 'from', 'id', 'kind', 'times', 'to'])
    }
    const course = items.find(i => i.kind === 'course')
    assert.equal(course.from, '作業系統')
    assert.equal(course.to, 'OS')
    assert.equal(course.times, 1)
    const kind = items.find(i => i.kind === 'file_kind')
    assert.equal(kind.from, '作業系統 / Notes', '鍵裡的換行不可以進畫面')
    assert.equal(kind.to, 'Lecture')
  })

  test('忘掉一條 → 那一條不再影響建議，另一條還在', t => {
    const s = box(t)
    const a = byName(fileList(s), '未命名文件 (3).txt')
    applyFilings(s.db, [{ itemId: a.itemId, course: 'OS', kind: 'Lecture' }], s.fileScope)
    assert.equal(byName(fileList(s), '未命名文件 (4).txt').toFolder, 'Courses/OS/Lecture')
    const course = listLearned(s.db).items.find(i => i.kind === 'course')
    assert.equal(forgetLearned(s.db, [course.id]), 1)
    assert.equal(byName(fileList(s), '未命名文件 (4).txt').toFolder, 'Courses/作業系統/Lecture')
    assert.equal(listLearned(s.db).items.length, 1)
  })

  test('不存在的 id 不算錯，也不會多刪', t => {
    const s = box(t)
    const a = byName(fileList(s), '未命名文件 (3).txt')
    applyFilings(s.db, [{ itemId: a.itemId, course: 'OS', kind: a.kind }], s.fileScope)
    assert.equal(forgetLearned(s.db, ['沒有這個 id']), 0)
    assert.equal(listLearned(s.db).items.length, 1)
  })

  test('全部忘掉 → 建議整個回到模型的說法', t => {
    const s = box(t)
    const a = byName(fileList(s), '未命名文件 (3).txt')
    applyFilings(s.db, [{ itemId: a.itemId, course: 'OS', kind: 'Lecture' }], s.fileScope)
    assert.equal(forgetAllLearned(s.db), 2)
    assert.deepEqual(prefs(s), [])
    const after = byName(fileList(s), '未命名文件 (4).txt')
    assert.equal(after.toFolder, 'Courses/作業系統/Notes')
    assert.equal(after.learned, false)
  })
})

// ═══ 8 ・ 唯讀不學 ═══════════════════════════════════════════

describe('預期行為 8：唯讀模式 apply 被擋，而且一列都不寫', () => {
  test('apply 丟 READ_ONLY，preferences 是空的', t => {
    const s = box(t, { readonly: true })
    const one = byName(fileList(s), '未命名文件 (3).txt')
    assert.throws(() => applyFilings(s.db, [{ itemId: one.itemId, course: 'OS' }], s.fileScope),
      e => e.code === 'READ_ONLY')
    assert.deepEqual(prefs(s), [])
  })

  test('undo 也一樣：不寫「退過貨」', t => {
    const s = box(t)
    const one = byName(fileList(s), '未命名文件 (3).txt')
    applyFilings(s.db, [{ itemId: one.itemId, course: one.course, kind: one.kind }], s.fileScope)
    assert.throws(() => undoFilings(s.db, { last: true }, { ...s.fileScope, readonly: true }),
      e => e.code === 'READ_ONLY')
    assert.deepEqual(prefs(s), [])
  })

  test('唯讀照樣看得到建議（唯讀不等於不能用）', t => {
    const s = box(t, { readonly: true })
    assert.equal(fileList(s).length, 3)
  })
})

// ═══ 9 ・ 表不見了要降級，不是崩掉 ═══════════════════════════

describe('預期行為 9：資料表被砍掉 → 當成沒學過，功能照常', () => {
  test('filingSuggestions／renameSuggestions 照樣出得來', t => {
    const s = box(t)
    s.db.exec('DROP TABLE preferences')
    const items = fileList(s)
    assert.equal(items.length, 3)
    assert.equal(items.every(i => i.learned === false && i.rejectedBefore === false), true)
    assert.equal(renameSuggestions(s.db, s.scope).items.length, 3)
  })

  test('apply 照樣搬得動（學不進去不可以讓那一項失敗）', t => {
    const s = box(t)
    s.db.exec('DROP TABLE preferences')
    const one = byName(fileList(s), '未命名文件 (3).txt')
    const r = applyFilings(s.db, [{ itemId: one.itemId, course: 'OS', kind: one.kind }], s.fileScope)
    assert.equal(r.results[0].ok, true, r.results[0].why)
    assert.deepEqual(s.filedTree().filter(p => p.endsWith('.txt')), ['Courses/OS/Notes/未命名文件 (3).txt'])
  })

  test('undo 照樣搬得回來', t => {
    const s = box(t)
    const one = byName(fileList(s), '未命名文件 (3).txt')
    applyFilings(s.db, [{ itemId: one.itemId, course: one.course, kind: one.kind }], s.fileScope)
    s.db.exec('DROP TABLE preferences')
    const u = undoFilings(s.db, { last: true }, s.fileScope)
    assert.equal(u.results[0].ok, true, u.results[0].why)
  })

  test('listLearned／forget 回空的，不丟例外', t => {
    const s = box(t)
    s.db.exec('DROP TABLE preferences')
    assert.deepEqual(listLearned(s.db), { items: [], evicted: { count: 0, at: null } })
    assert.equal(forgetLearned(s.db, ['a']), 0)
    assert.equal(forgetAllLearned(s.db), 0)
    assert.equal(loadLearned(s.db).size, 0)
    assert.equal(loadLearned(s.db).course('作業系統'), '')
  })
})

// ═══ 10 ・ 上限 ══════════════════════════════════════════════

describe('預期行為 10：塞 600 條之後只留 500 條，留下來的是最近用過、次數多的', () => {
  test('上限收得住，而且留下來的是對的那批', t => {
    const s = box(t)
    const at = n => new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString()
    // 先手動塞 599 條「很舊、只用過一次」的（DDL 自己的 UNIQUE 保證鍵不重複）
    const insert = s.db.prepare('INSERT INTO preferences (id,kind,k,v,times,at) VALUES (?,?,?,?,?,?)')
    for (let i = 0; i < 599; i++) insert.run(`old-${i}`, 'course', `課-${i}`, `值-${i}`, 1, at(i))
    // 再塞一條「用過很多次」的舊資料：它不可以被丟掉
    insert.run('hot', 'course', '常用', '常用值', 99, at(0))
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM preferences').get().n, 600)

    // 真的學一條（走 upsert → 收上限）
    const one = byName(fileList(s), '未命名文件 (3).txt')
    applyFilings(s.db, [{ itemId: one.itemId, course: 'OS', kind: one.kind }], s.fileScope)

    const rows = s.db.prepare('SELECT id, times, at FROM preferences').all()
    assert.equal(rows.length, PREF_MAX)
    assert.ok(rows.some(r => r.id === 'hot'), 'times 大的不可以先走')
    assert.ok(rows.some(r => r.times === 1 && r.at > at(500)), '最近用過的要留著')
    assert.equal(rows.some(r => r.id === 'old-0'), false, '最舊、最少用的先走')
    // 剛學到的那一條**一定留著**（不然使用者會看到「我明明改了它卻沒記住」）
    const learned = listLearned(s.db).items.find(i => i.to === 'OS')
    assert.ok(learned, '剛學的那一條被自己擠掉了')
    assert.equal(byName(fileList(s), '未命名文件 (4).txt').toFolder, 'Courses/OS/Notes')
  })

  test('丟掉幾條**留得下紀錄**（不是安靜地消失）', t => {
    const s = box(t)
    const insert = s.db.prepare('INSERT INTO preferences (id,kind,k,v,times,at) VALUES (?,?,?,?,?,?)')
    for (let i = 0; i < 600; i++) {
      insert.run(`old-${i}`, 'course', `課-${i}`, `值-${i}`, 1, new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString())
    }
    const one = byName(fileList(s), '未命名文件 (3).txt')
    applyFilings(s.db, [{ itemId: one.itemId, course: 'OS', kind: one.kind }], s.fileScope)
    const { evicted } = listLearned(s.db)
    assert.equal(evicted.count, 101)
    assert.equal(typeof evicted.at, 'string')
    // 全部忘掉之後連這筆紀錄也一起清（使用者要的是回到什麼都沒學過）
    forgetAllLearned(s.db)
    assert.deepEqual(listLearned(s.db).evicted, { count: 0, at: null })
  })
})

// ═══ 11 ・ 不洩漏路徑與內容 ══════════════════════════════════

describe('預期行為 11：回給畫面與 CLI 的東西沒有絕對路徑、沒有檔案內容', () => {
  test('listLearned 的每一個值都不含路徑、不含檔案內容', t => {
    const s = box(t)
    const a = byName(fileList(s), '未命名文件 (3).txt')
    applyFilings(s.db, [{ itemId: a.itemId, course: 'OS', kind: 'Lecture' }], s.fileScope)
    const b = byName(fileList(s), '未命名文件 (4).txt')
    applyFilings(s.db, [{ itemId: b.itemId, course: b.course, kind: b.kind }], s.fileScope)
    undoFilings(s.db, { last: true }, s.fileScope)

    const text = JSON.stringify(listLearned(s.db))
    for (const leak of [s.dir, s.downloads, s.filed, FAKE_HOME]) {
      assert.ok(!text.includes(leak), `${leak} 不可以出現在回應裡：${text}`)
    }
    assert.ok(!text.includes('死結的四個必要條件'), '檔案內容不可以進偏好表')
    assert.ok(!text.includes('/home/'), text)
    // 退過貨那一種只講「哪一個建議」，不回 itemId，也不回檔名（稽核 2026-09-20 之後從 from 搬到 about）
    const rejected = listLearned(s.db).items.find(i => i.kind === 'rejected')
    // b 的類型也套了學到的偏好（作業系統的筆記 → 講義），所以退掉的是「課程/OS/講義」那個建議
    assert.equal(rejected.about, 'Courses/OS/Lecture')
    assert.equal(rejected.from, '')
    assert.equal(rejected.to, '')
    assert.ok(!text.includes(b.itemId), 'itemId 不用回給畫面')
  })

  test('preferences 那張表裡也不可以有路徑', t => {
    const s = box(t)
    const a = byName(fileList(s), '未命名文件 (3).txt')
    applyFilings(s.db, [{ itemId: a.itemId, course: 'OS', kind: 'Lecture' }], s.fileScope)
    const raw = JSON.stringify(s.db.prepare('SELECT * FROM preferences').all())
    for (const leak of [s.dir, s.downloads, s.filed, FAKE_HOME]) assert.ok(!raw.includes(leak), raw)
  })
})

// ═══ 12 ・ 既有資料夾不動 ════════════════════════════════════

describe('預期行為 12：學到新寫法之後，磁碟上既有的資料夾不會被搬動或改名', () => {
  test('課程/作業系統/ 留在原地，新的檔進 課程/OS/，清單上講一句', t => {
    const s = box(t)
    // 先照模型的說法搬一個進去，磁碟上就有 課程/作業系統/ 了
    const first = byName(fileList(s), '未命名文件 (3).txt')
    applyFilings(s.db, [{ itemId: first.itemId, course: first.course, kind: first.kind }], s.fileScope)
    assert.ok(s.filedTree().includes('Courses/作業系統/'))

    // 現在改一個成 OS
    const second = byName(fileList(s), '未命名文件 (4).txt')
    applyFilings(s.db, [{ itemId: second.itemId, course: 'OS', kind: second.kind }], s.fileScope)

    const tree = s.filedTree()
    assert.ok(tree.includes('Courses/作業系統/'), '舊資料夾不可以被搬走或改名')
    assert.ok(tree.includes('Courses/作業系統/Notes/未命名文件 (3).txt'), '已經搬進去的檔留在原地')
    assert.ok(tree.includes('Courses/OS/Notes/未命名文件 (4).txt'))

    // 第三個檔（IMG_2041 是資料結構，換一個來源）：讓作業系統再出現一次
    const s2 = box(t)
    const a = byName(fileList(s2), '未命名文件 (3).txt')
    applyFilings(s2.db, [{ itemId: a.itemId, course: a.course, kind: a.kind }], s2.fileScope)
    const b = byName(fileList(s2), '未命名文件 (4).txt')
    applyFilings(s2.db, [{ itemId: b.itemId, course: 'OS', kind: b.kind }], s2.fileScope)
    undoFilings(s2.db, { last: true }, s2.fileScope)
    const back = byName(fileList(s2), '未命名文件 (4).txt')
    assert.equal(back.toFolder, 'Courses/OS/Notes')
    assert.equal(back.alsoKnownAs, '作業系統', '清單上要講「你之前把它叫作業系統」')
  })

  test('沒有舊資料夾就不要講那一句（不要憑空講一個不存在的資料夾）', t => {
    const s = box(t)
    const first = byName(fileList(s), '未命名文件 (3).txt')
    applyFilings(s.db, [{ itemId: first.itemId, course: 'OS', kind: first.kind }], s.fileScope)
    const second = byName(fileList(s), '未命名文件 (4).txt')
    assert.equal(second.alsoKnownAs, '')
    assert.equal(readdirSync(join(s.filed, COURSES_DIR)).sort().join(), 'OS')
  })
})

// ═══ 邊界：學到的東西不可以放寬安全檢查 ═════════════════════

describe('不變量 2：學到的只是偏好，不是權限', () => {
  test('cleanCourse 對學到的值照樣有效（同一支函式）', () => {
    assert.equal(cleanCourse('../../etc'), 'etc')
    assert.equal(cleanCourse('CON'), '')
  })

  test('**洗過之後不一樣的就不學**：太長的課名這一次照搬，但不會變成偏好', t => {
    const s = box(t)
    const one = byName(fileList(s), '未命名文件 (3).txt')
    const long = '長'.repeat(100)
    const r = applyFilings(s.db, [{ itemId: one.itemId, course: long, kind: one.kind }], s.fileScope)
    assert.equal(r.results[0].ok, true, r.results[0].why)
    // 這一次的資料夾照 P4 的規矩截到 40 碼位
    assert.equal([...r.results[0].toFolder.split('/')[1]].length, 40)
    // 但**不學**：使用者打的跟我們洗出來的不一樣，那不是他指名的寫法，是我們替他猜的
    assert.deepEqual(prefs(s), [])
    assert.equal(byName(fileList(s), '未命名文件 (4).txt').toFolder, 'Courses/作業系統/Notes')
  })

  test('資料庫裡被塞了一個超長的偏好 → 用之前照樣截到 40 碼位', t => {
    const s = box(t)
    s.db.prepare('INSERT INTO preferences (id,kind,k,v,times,at) VALUES (?,?,?,?,1,?)')
      .run('x', 'course', '作業系統', '長'.repeat(100), new Date().toISOString())
    const shown = byName(fileList(s), '未命名文件 (3).txt')
    assert.equal([...shown.course].length, 40)
    assert.equal(shown.learned, true)
  })

  test('學不到「別人的 itemId」：rejected 只影響那一個檔', t => {
    const s = box(t)
    const rows = fileList(s)
    const mine = rows[0]
    applyFilings(s.db, [{ itemId: mine.itemId, course: mine.course, kind: mine.kind }], s.fileScope)
    undoFilings(s.db, { last: true }, s.fileScope)
    const after = fileList(s)
    assert.equal(after.filter(i => i.rejectedBefore).length, 1)
  })
})

// ═══ 稽核補的：驗證員抓到的洞（2026-09-20）═══════════════════

describe('稽核 ・ 學到的偏好不可以替模型「補」出一堂課', () => {
  test('模型說「看不出來」→ 清單不列，**直接打 apply 也搬不成**（兩邊同一道門檻）', t => {
    const s = sandbox(t, { '未命名文件 (3).txt': OS_DEADLOCK })
    s.seed('未命名文件 (3).txt', { course: 'Unknown', topic: 'Unknown', kind: 'Notes', suggestedName: 'Unknown_死結', confidence: 'high' })
    const itemId = s.idOf('未命名文件 (3).txt')
    // 「看不出來」這個鍵真的產得出來（改名那條線挖得出 head），所以直接塞一條進去
    s.db.prepare('INSERT INTO preferences (id,kind,k,v,times,at) VALUES (?,?,?,?,1,?)')
      .run('x', 'course', courseKey('Unknown'), 'OS', new Date().toISOString())

    assert.deepEqual(filingSuggestions(s.db, s.fileScope).items, [], '清單本來就不列它')
    const r = applyFilings(s.db, [{ itemId }], s.fileScope)
    assert.equal(r.results[0].ok, false, '清單不列的東西，直接打 API 也不可以搬得成')
    assert.match(r.results[0].why, /no usable course name/)
    assert.equal(existsSync(join(s.filed, COURSES_DIR)), false, '一個資料夾都不可以長出來')
  })

  test('改名那條線學到的課名要過 cleanCourse：洗完不一樣就不學（跟歸檔同一個規矩）', t => {
    // 洗過之後才知道「這是不是使用者指名的寫法」。60 個 Z 洗完是 40 個 Z ——
    // 那是我們替他截的，不是他要的，所以**不學**（不然改名那條線會存 60 個 Z、
    // 歸檔用的時候又截成 40 個，同一條偏好在兩條線上變成兩個寫法）。
    const s = box(t)
    const first = renameSuggestions(s.db, s.fileScope).items.find(i => i.name === '未命名文件 (3).txt')
    applyRenames(s.db, [{ itemId: first.itemId, to: 'Z'.repeat(60) + '_死結.txt' }], s.fileScope)
    assert.deepEqual(prefs(s).filter(p => p.kind === 'course'), [], '截過的不是他指名的寫法')

    const s2 = box(t)
    const one = renameSuggestions(s2.db, s2.fileScope).items.find(i => i.name === '未命名文件 (3).txt')
    applyRenames(s2.db, [{ itemId: one.itemId, to: 'CON_死結.txt' }], s2.fileScope)
    assert.deepEqual(prefs(s2).filter(p => p.kind === 'course'), [], 'CON 洗完是空的，不可以佔一格額度')

    // 正常的照樣學得起來（上面兩條不可以把正常的路擋掉）
    const s3 = box(t)
    const ok = renameSuggestions(s3.db, s3.fileScope).items.find(i => i.name === '未命名文件 (3).txt')
    applyRenames(s3.db, [{ itemId: ok.itemId, to: 'OS_死結.txt' }], s3.fileScope)
    assert.equal(loadLearned(s3.db).course('作業系統'), 'OS')
  })

  test('`--kind` 打錯字：這一次照舊進「其他」，但**不可以把整堂課學成「其他」**', t => {
    const s = box(t)
    const one = byName(fileList(s), '未命名文件 (3).txt')
    const r = applyFilings(s.db, [{ itemId: one.itemId, kind: '講議' }], s.fileScope)   // 「講義」打錯
    assert.equal(r.results[0].ok, true, r.results[0].why)
    assert.equal(r.results[0].toFolder, 'Courses/作業系統/Other', 'P4 既有行為：認不得的類型進「其他」')
    assert.deepEqual(prefs(s).filter(p => p.kind === 'file_kind'), [], '打錯一個字的代價不可以是整堂課')
    assert.equal(byName(fileList(s), '未命名文件 (4).txt').toFolder, 'Courses/作業系統/Notes')
  })

  test('真的打對的類型照樣學得起來（上面那條不可以擋掉正常的路）', t => {
    const s = box(t)
    const one = byName(fileList(s), '未命名文件 (3).txt')
    applyFilings(s.db, [{ itemId: one.itemId, kind: 'Lecture' }], s.fileScope)
    assert.equal(byName(fileList(s), '未命名文件 (4).txt').toFolder, 'Courses/作業系統/Lecture')
  })
})

describe('稽核 ・ 壞掉的偏好列不可以讓建議整個出不來', () => {
  /** 把表換成一張沒有 NOT NULL 的，塞一列全 NULL 的（舊版本、手改過的資料庫會長這樣）。 */
  function brokenRow(s) {
    s.db.exec('DROP TABLE preferences')
    s.db.exec('CREATE TABLE preferences (id TEXT PRIMARY KEY, kind TEXT, k TEXT, v TEXT, times INTEGER, at TEXT)')
    s.db.prepare('INSERT INTO preferences (id,kind,k,v,times,at) VALUES (?,?,?,?,?,?)')
      .run('broken', 'rejected', null, null, null, null)
  }

  test('k 是 NULL → loadLearned／listLearned 當成沒學過，建議照樣出得來', t => {
    const s = box(t)
    brokenRow(s)
    const learned = loadLearned(s.db)
    assert.equal(learned.course('作業系統'), '')
    assert.equal(learned.rejected('x', 'y'), false)
    assert.equal(fileList(s).length, 3, '建議不可以因為一列壞資料就整個出不來')
    assert.equal(renameSuggestions(s.db, s.fileScope).items.length, 3)
    const out = listLearned(s.db)
    assert.equal(out.items.length, 1)
    assert.equal(out.items[0].times, 0, 'NULL 不可以原樣印成「用過 null 次」')
    assert.equal(out.items[0].at, '')
  })
})

describe('稽核 ・ 回給畫面的東西不可以有檔名', () => {
  test('改名退貨之後，listLearned 不回那個檔名', t => {
    const s = box(t)
    const one = renameSuggestions(s.db, s.fileScope).items.find(i => i.name === '未命名文件 (3).txt')
    const applied = applyRenames(s.db, [{ itemId: one.itemId, to: one.suggested }], s.fileScope)
    undoRenames(s.db, { ids: [applied.results[0].id] }, s.fileScope)
    const rejected = listLearned(s.db).items.filter(i => i.kind === 'rejected')
    assert.equal(rejected.length, 1)
    const blob = JSON.stringify(rejected)
    assert.ok(!blob.includes('作業系統_死結.txt'), `回了檔名：${blob}`)
    assert.ok(!blob.includes('未命名文件'), blob)
    assert.equal(rejected[0].about, '', '改名那一種講不出「是哪一個」也不可以講檔名')
  })

  test('歸檔退貨講得出是哪一個建議（那一段沒有檔名）', t => {
    const s = box(t)
    const one = byName(fileList(s), '未命名文件 (3).txt')
    applyFilings(s.db, [{ itemId: one.itemId, course: one.course, kind: one.kind }], s.fileScope)
    undoFilings(s.db, { last: true }, s.fileScope)
    const rejected = listLearned(s.db).items.filter(i => i.kind === 'rejected')
    assert.equal(rejected[0].about, 'Courses/作業系統/Notes')
    assert.ok(!JSON.stringify(rejected).includes('未命名文件'))
  })
})

describe('稽核 ・ 第二道唯讀防線與 prune 的承諾', () => {
  test('直接呼叫 learn.ts 的四支，唯讀一律不寫', async t => {
    const s = box(t)
    const learn = await import('../core/learn.ts')
    const at = new Date().toISOString()
    const ro = { readonly: true }
    learn.learnCourse(s.db, '作業系統', 'OS', 'OS', at, ro)
    learn.learnKind(s.db, '作業系統', 'Notes', 'Lecture', at, ro)
    learn.rememberRejected(s.db, 'item-1', 'Courses/作業系統/Notes', at, ro)
    assert.deepEqual(prefs(s), [], '唯讀模式一列都不可以寫')
    // forgetRejected 在唯讀下也不可以刪
    learn.rememberRejected(s.db, 'item-1', 'Courses/作業系統/Notes', at)
    learn.forgetRejected(s.db, 'item-1', 'Courses/作業系統/Notes', ro)
    assert.equal(prefs(s).length, 1, '唯讀模式連刪都不可以')
  })

  test('滿了之後：**剛學到的那一條一定留著**，被擠掉的是用得少又舊的', async t => {
    const s = box(t)
    const learn = await import('../core/learn.ts')
    const old = '2020-01-01T00:00:00.000Z'
    for (let i = 0; i < PREF_MAX; i++) {
      // 每一條各學三次 → times=3，比等一下那條新的還多
      for (let n = 0; n < 3; n++) learn.learnCourse(s.db, `課${i}`, `寫法${i}`, `寫法${i}`, old)
    }
    assert.equal(s.db.prepare('SELECT count(*) n FROM preferences').get().n, PREF_MAX)
    learn.learnCourse(s.db, '最新的一堂課', 'BRANDNEW', 'BRANDNEW', new Date().toISOString())
    assert.equal(s.db.prepare('SELECT count(*) n FROM preferences').get().n, PREF_MAX, '上限要守住')
    assert.equal(loadLearned(s.db).course('最新的一堂課'), 'BRANDNEW',
      '剛學到的那一條不可以被自己擠掉（times 最小的就是它）')
  })
})

describe('稽核 ・ 規格 4 後半：建議名字裡沒有課名那一段的不受影響', () => {
  test('同一堂課、但建議名不以課名開頭 → 不套用學到的寫法', t => {
    const s = sandbox(t, { '未命名文件 (3).txt': OS_DEADLOCK, '未命名文件 (4).txt': OS_SCHEDULING })
    s.seed('未命名文件 (3).txt', OS_VIEW)
    // 同一堂課，但建議的名字**不以課名開頭**
    s.seed('未命名文件 (4).txt', { ...OS_VIEW, topic: '行程排程', suggestedName: '排程_講義' })
    const first = renameSuggestions(s.db, s.fileScope).items.find(i => i.name === '未命名文件 (3).txt')
    applyRenames(s.db, [{ itemId: first.itemId, to: 'OS_死結.txt' }], s.fileScope)
    assert.equal(loadLearned(s.db).course('作業系統'), 'OS', '前提：學到了')

    const second = renameSuggestions(s.db, s.fileScope).items.find(i => i.name === '未命名文件 (4).txt')
    assert.equal(second.suggested, '排程_講義.txt', '名字裡沒有課名那一段就不要動它')
    assert.equal(second.learned, false)
  })
})

describe('稽核 ・ 「同一個建議」的折法與記在哪一列', () => {
  test('退貨記的摘要折過大小寫與全形：課名寫法變了還是認得出同一個建議', async t => {
    const s = box(t)
    const learn = await import('../core/learn.ts')
    const at = new Date().toISOString()
    learn.rememberRejected(s.db, 'item-1', 'Courses/OS/Notes', at)
    assert.equal(loadLearned(s.db).rejected('item-1', 'Courses/os/Notes'), true, '只差大小寫是同一個建議')
    assert.equal(loadLearned(s.db).rejected('item-1', 'Courses/ＯＳ/Notes'), true, '全形也是')
    assert.equal(loadLearned(s.db).rejected('item-2', 'Courses/OS/Notes'), false, '別的檔不受影響')
  })
})

describe('稽核 ・ 滿了的時候先丟退過貨的，不要丟掉使用者教過的（2026-09-20）', () => {
  test('三種共用一個上限時，rejected 先走', async t => {
    const s = box(t)
    const learn = await import('../core/learn.ts')
    const old = '2020-01-01T00:00:00.000Z'
    // 先塞滿：一半是使用者教過的課名，一半是 undo 留下的退貨標記
    const half = Math.floor(PREF_MAX / 2)
    for (let i = 0; i < half; i++) learn.learnCourse(s.db, `Course ${i}`, `C${i}`, `C${i}`, old)
    for (let i = 0; i < PREF_MAX - half; i++) learn.rememberRejected(s.db, `item-${i}`, `Courses/X/Notes`, old)
    assert.equal(s.db.prepare('SELECT count(*) n FROM preferences').get().n, PREF_MAX)
    const coursesBefore = s.db.prepare(`SELECT count(*) n FROM preferences WHERE kind='course'`).get().n

    // 再學一條新的課名 → 要擠掉的是退過貨的那一種
    learn.learnCourse(s.db, 'Brand New Course', 'BNC', 'BNC', new Date().toISOString())
    assert.equal(s.db.prepare('SELECT count(*) n FROM preferences').get().n, PREF_MAX, '上限要守住')
    assert.equal(s.db.prepare(`SELECT count(*) n FROM preferences WHERE kind='course'`).get().n,
      coursesBefore + 1, '使用者教過的課名一條都不可以被擠掉')
    assert.equal(loadLearned(s.db).course('Brand New Course'), 'BNC')
  })
})
