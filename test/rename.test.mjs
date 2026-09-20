import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * P3 ・ 替沒取名的檔改名（可復原）—— 核心那一半。
 *
 * 期望值抄自 `~/contextbox-預想-20260919-P3改名.md`（Step 1 的表與「預期行為」十二條），
 * **在實作之前寫死**。實作過程中改測試的寫法可以，改期望值不行。
 *
 * | 段落 | 可能的錯誤 | 另一種合理解讀 | 能分辨兩者的例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | 誰可以被提議 | 所有檔 | 沒取名的 | `未命名文件 (3).txt`／`作業系統_第5章_行程排程.txt` | 只有 untitled／generic |
 * | 信心低的 | 照樣提議 | 不提議 | 「看不出來」（低）／高 | 不提議，清單上也不列 |
 * | 建議的名字 | 直接用 | 過一層清理 | `作業系統_死結`／`../../etc/passwd` | 過一層清理 |
 * | 副檔名 | 用模型的 | 保留原本的 | `未命名文件 (3).txt` ＋ 模型說 `作業系統_死結` | `作業系統_死結.txt` |
 * | 同名 | 覆蓋 | 加序號 | 目標已經有同名檔 | `-2`，從 2 開始到 99 |
 * | 只差大小寫 | 當成不同檔 | 當成同一個 | `A.txt` → `a.txt` | 當成同名，加序號 |
 * | 當機在 rename 前後 | 沒紀錄 | 先 started 再改 | 改到一半被砍 | 看檔案實際在哪：新名字在＝done |
 * | 復原時原名被佔 | 覆蓋 | 加序號 | 改完使用者又建了一個同名檔 | 加序號，而且講清楚放回來的叫什麼 |
 * | 一次改幾個 | 全部 | 有上限 | 一次勾 150 個 | 做前 100 個，講「還有 50 個」 |
 * | 改名之後掃描 | 新的檔 | 同一個檔 | 改完馬上重掃 | 同一列：path 與 name 更新 |
 * | 改名之後 naming | 還是 untitled | 重算 | 改成 `作業系統_死結.txt` | 重算成 named，不再提議 |
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, linkSync,
  utimesSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  applyRenames, cleanName, confidentEnough, freeName, listRenames, NAME_MAX_CODEPOINTS, originalExt,
  recoverInterruptedRenames, RENAME_BATCH_MAX, renameSuggestions, suggestedFileName, SUFFIX_MAX,
  undoRenames, whyNotRenamable,
} from '../core/rename.ts'
import { createPlan } from '../core/cleanup-plans.ts'
import { sandbox, DAY, OS_DEADLOCK, DS_MIDTERM, OS_SCHEDULING } from './helpers/rename.mjs'

const HIGH = { course: '作業系統', topic: '死結', suggestedName: '作業系統_死結', evidence: '四個必要條件', confidence: 'high' }

/** 一個只有「未命名文件 (3).txt」的沙盒，模型已經給了高信心的建議。 */
function one(t, name = '未命名文件 (3).txt', view = HIGH, content = OS_DEADLOCK) {
  const s = sandbox(t, { [name]: content })
  s.seed(name, view)
  return { ...s, name, itemId: s.idOf(name) }
}

// ═══ 名字清理 ・ 這一層是安全關鍵 ═══════════════════════════════

describe('名字清理', () => {
  test('路徑穿越：分隔符號整個去掉，跳不出資料夾', () => {
    assert.equal(cleanName('../../etc/passwd'), 'etcpasswd')
    assert.equal(cleanName('..\\..\\Windows\\System32\\drivers'), 'WindowsSystem32drivers')
    assert.equal(cleanName('/etc/shadow'), 'etcshadow')
    // 中間的點留著（預想表只說去掉「前後」的空白與點）—— 那是一個普通的檔名，跳不出去
    assert.equal(cleanName('作業系統/../../死結'), '作業系統....死結')
    for (const bad of ['../../etc/passwd', '/etc/shadow', 'a/b\\c']) {
      const out = cleanName(bad)
      assert.ok(!out.includes('/') && !out.includes('\\'), `${bad} 洗完還有分隔符：${out}`)
      assert.ok(!out.startsWith('.'), `${bad} 洗完還是點開頭：${out}`)
    }
  })

  test('控制字元與方向字元整個去掉', () => {
    assert.equal(cleanName('a\u0000b\u001fc\u007fd'), 'abcd')
    // U+202E 會把後面的字反過來顯示：`invoice\u202Efdp.exe` 看起來是 invoiceexe.pdf
    assert.equal(cleanName('invoice\u202Efdp'), 'invoicefdp')
    assert.equal(cleanName('a\u200eb\u200fc\u2066d\u2069e'), 'abcde')
    // 換行可以在終端機上偽造一整行字
    assert.equal(cleanName('好檔案\n✔ 已經刪除全部'), '好檔案✔ 已經刪除全部')
  })

  test('Windows 不能用的字元去掉（`a.pdf:hidden` 是替代資料流）', () => {
    assert.equal(cleanName('a:b<c>d"e|f?g*h'), 'abcdefgh')
  })

  test('前後的空白與點去掉（Windows 會安靜吃掉結尾的點與空白）', () => {
    assert.equal(cleanName('  ..作業系統..  '), '作業系統')
    assert.equal(cleanName('作業系統.'), '作業系統')
    assert.equal(cleanName('.hidden'), 'hidden')
  })

  test('Windows 保留名稱不提議（洗完等於空的）', () => {
    for (const bad of ['CON', 'con', 'Con', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'lpt9']) {
      assert.equal(cleanName(bad), '', `${bad} 應該不提議`)
    }
    // 帶副檔名的保留名稱也是保留名稱（`CON.txt` 在 Windows 上一樣打不開）
    assert.equal(cleanName('CON.txt'), '')
    // 對照：不是保留名稱的照過
    assert.equal(cleanName('CONTEXT'), 'CONTEXT')
    assert.equal(cleanName('COM10'), 'COM10')
  })

  test('洗完是空的就不提議', () => {
    for (const bad of ['', '///', '...', '   ', '\u202E', '\u0000', '..\\..\\', 42, null, undefined, {}, ['a']]) {
      assert.equal(cleanName(bad), '', `${JSON.stringify(bad)} 應該不提議`)
    }
  })

  test('超長：剛好 80 個碼位，不多不少；81 個要被截到 80', () => {
    assert.equal([...cleanName('中'.repeat(NAME_MAX_CODEPOINTS))].length, NAME_MAX_CODEPOINTS)
    assert.equal([...cleanName('中'.repeat(NAME_MAX_CODEPOINTS + 1))].length, NAME_MAX_CODEPOINTS)
    assert.equal([...cleanName('a'.repeat(5000))].length, NAME_MAX_CODEPOINTS)
  })

  test('**不可以切在代理對中間**（罕用漢字、表情符號佔兩個 UTF-16 單位）', () => {
    const astral = '𠮷'   // U+20BB7，一個碼位、兩個 UTF-16 單位
    // **前面墊一個半形字**：不墊的話 80 個 UTF-16 單位剛好是 40 個完整的代理對，
    // 「按單位切」這個錯誤在這一格看不出來（突變測試抓到的洞）。
    const odd = cleanName('a' + astral.repeat(200))
    assert.doesNotMatch(odd, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, '按 UTF-16 單位切，留下了落單的高位代理')
    // 位元組上限（250）在這一格比 80 個碼位先咬到：一個 𠮷 是 4 個位元組。
    // 這裡要守的是「不可以切在代理對中間」，長度只要不超過上限就好。
    assert.ok([...odd].length <= NAME_MAX_CODEPOINTS && odd.length > 2, `${[...odd].length}`)
    assert.equal(odd, 'a' + astral.repeat([...odd].length - 1), '切出來的每一個都要是完整的字')
    const out = cleanName(astral.repeat(200))
    assert.ok(out.length > 0)
    assert.ok([...out].length <= NAME_MAX_CODEPOINTS, `切出來 ${[...out].length} 個碼位`)
    // 沒有落單的代理（切在中間的話會留下一個 \uD842 或 \uDFB7）
    assert.doesNotMatch(out, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, '留下了落單的高位代理')
    assert.doesNotMatch(out, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, '留下了落單的低位代理')
    assert.equal(out, astral.repeat([...out].length))
  })

  test('超大的輸入不處理（擋住拿超長字串吃記憶體）', () => {
    assert.equal(cleanName('a'.repeat(200_000)), '')
  })

  test('副檔名**一律沿用原本的**，模型自己帶的要去掉', () => {
    assert.equal(suggestedFileName('未命名文件 (3).txt', '作業系統_死結'), '作業系統_死結.txt')
    assert.equal(suggestedFileName('未命名文件 (3).txt', '作業系統_死結.pdf'), '作業系統_死結.txt')
    assert.equal(suggestedFileName('IMG_2041.PNG', '資料結構_期中考'), '資料結構_期中考.PNG')
    assert.equal(suggestedFileName('未命名', '作業系統_死結'), '作業系統_死結')
    assert.equal(suggestedFileName('未命名', '作業系統_死結.pdf'), '作業系統_死結')
    // 不是副檔名的點不動（「第二版」不是 1～10 個英數字）
    assert.equal(suggestedFileName('x.txt', '報告.第二版'), '報告.第二版.txt')
    // 至少要有一個字母才算副檔名（「hw3.1」的 1 不是）
    assert.equal(suggestedFileName('x.txt', 'hw3.1'), 'hw3.1.txt')
  })

  test('兩層副檔名（.tar.gz）整段留著', () => {
    assert.equal(originalExt('備份.tar.gz'), '.tar.gz')
    assert.equal(originalExt('a.txt'), '.txt')
    assert.equal(originalExt('沒有副檔名'), '')
    assert.equal(originalExt('.bashrc'), '')
    assert.equal(suggestedFileName('未命名.tar.gz', '作業系統_講義'), '作業系統_講義.tar.gz')
  })

  test('洗出來如果是受保護的檔名，不提議', () => {
    assert.equal(suggestedFileName('未命名', 'id_rsa'), '')
    // `.env` 的點開頭被剝掉就只是一個叫 env 的普通檔，不再是那個受保護的檔
    assert.equal(suggestedFileName('未命名', '.env'), 'env')
    for (const bad of ['.env', '.ssh', '..', '.']) {
      assert.ok(!suggestedFileName('x.txt', bad).startsWith('.'), bad)
    }
    assert.equal(suggestedFileName('未命名.txt', 'data.db'), 'data.txt')   // 副檔名換回 .txt 就不是那個檔
  })

  test('整個檔名不會超過檔案系統的位元組上限（表情符號一個 4 個位元組）', () => {
    const out = suggestedFileName('x.txt', '😀'.repeat(80))
    assert.ok(Buffer.byteLength(out, 'utf8') <= 255, `${Buffer.byteLength(out, 'utf8')} 個位元組`)
    assert.ok([...out].length <= NAME_MAX_CODEPOINTS + 1)
  })
})

describe('同名時加序號', () => {
  const taken = names => new Set(names.map(n => n.toLowerCase()))

  test('沒人用就原樣用', () => {
    assert.equal(freeName('作業系統_死結.txt', '.txt', taken([])), '作業系統_死結.txt')
  })

  test('被佔走就從 2 開始，序號在副檔名前面', () => {
    assert.equal(freeName('作業系統_死結.txt', '.txt', taken(['作業系統_死結.txt'])), '作業系統_死結-2.txt')
    assert.equal(freeName('作業系統_死結.txt', '.txt', taken(['作業系統_死結.txt', '作業系統_死結-2.txt'])),
      '作業系統_死結-3.txt')
  })

  test('**只差大小寫也算同名**（不分大小寫的檔案系統上會覆蓋自己）', () => {
    assert.equal(freeName('a.txt', '.txt', taken(['A.TXT'])), 'a-2.txt')
    assert.equal(freeName('Report.PDF', '.PDF', taken(['report.pdf'])), 'Report-2.PDF')
  })

  test(`到 ${SUFFIX_MAX} 都滿了就放棄這一個（回空字串）`, () => {
    const all = ['x.txt', ...Array.from({ length: SUFFIX_MAX - 1 }, (_, i) => `x-${i + 2}.txt`)]
    assert.equal(freeName('x.txt', '.txt', taken(all)), '')
    // 差一個就找得到
    assert.equal(freeName('x.txt', '.txt', taken(all.slice(0, -1))), `x-${SUFFIX_MAX}.txt`)
  })
})

// ═══ 建議清單 ═══════════════════════════════════════════════

describe('名字被佔住：磁碟與資料庫兩邊都要算', () => {
  test('**資料庫裡記著、磁碟上已經不在的路徑也算佔住**（不然最後一步會撞 UNIQUE）', t => {
    const s = one(t)
    // 資料庫裡有一列指著 作業系統_死結.txt（status 不是 missing），但磁碟上沒有那個檔
    const now = new Date().toISOString()
    s.db.prepare(`INSERT INTO file_items (id,path,name,ext,bytes,mtime,sha256,first_seen_at,last_seen_at,status)
      VALUES (?,?,?,?,?,?,NULL,?,?,'kept')`)
      .run(randomUUID(), join(s.downloads, '作業系統_死結.txt'), '作業系統_死結.txt', '.txt', 10, now, now, now)
    const r = applyRenames(s.db, [{ itemId: s.itemId, to: '作業系統_死結' }], s.scope)
    assert.equal(r.results[0].ok, true, r.results[0].why)
    assert.equal(r.results[0].to, '作業系統_死結-2.txt', '資料庫佔著的名字要讓開，不然更新那一列會撞 UNIQUE')
    assert.ok(existsSync(join(s.downloads, '作業系統_死結-2.txt')))
  })

  test('對照：那一列是 missing（檔案真的不在了）→ 不算佔住', t => {
    const s = one(t)
    const now = new Date().toISOString()
    s.db.prepare(`INSERT INTO file_items (id,path,name,ext,bytes,mtime,sha256,first_seen_at,last_seen_at,status)
      VALUES (?,?,?,?,?,?,NULL,?,?,'missing')`)
      .run(randomUUID(), join(s.downloads, '作業系統_死結.txt'), '作業系統_死結.txt', '.txt', 10, now, now, now)
    const r = applyRenames(s.db, [{ itemId: s.itemId, to: '作業系統_死結' }], s.scope)
    assert.equal(r.results[0].to, '作業系統_死結.txt', '不在了的就不要讓')
  })
})

describe('建議清單', () => {
  test('預期行為 1：沒取名的在清單上，取好名字的（named）不在', t => {
    const s = sandbox(t, {
      '未命名文件 (3).txt': OS_DEADLOCK,
      'IMG_2041.txt': DS_MIDTERM,
      '作業系統_第5章_行程排程.txt': OS_SCHEDULING,
    })
    s.seed('未命名文件 (3).txt', HIGH)
    s.seed('IMG_2041.txt', { course: '資料結構', topic: '期中考範圍', suggestedName: '資料結構_期中考範圍', evidence: '考試時間', confidence: 'high' })
    s.seed('作業系統_第5章_行程排程.txt', { course: '作業系統', topic: '行程排程', suggestedName: '作業系統_行程排程', evidence: 'FCFS', confidence: 'high' })

    const names = renameSuggestions(s.db, s.scope).items.map(i => i.name)
    assert.deepEqual(names.sort(), ['IMG_2041.txt', '未命名文件 (3).txt'])
    assert.ok(!names.includes('作業系統_第5章_行程排程.txt'), 'named 的不可以被提議改名')
  })

  test('預期行為 2：信心「低」的不在清單上', t => {
    const s = one(t, '未命名文件 (3).txt', { ...HIGH, confidence: 'low' })
    assert.deepEqual(renameSuggestions(s.db, s.scope).items, [])
    assert.equal(confidentEnough('low'), false)
    assert.equal(confidentEnough(''), false, '講不出信心的一律當成不夠有把握')
    assert.equal(confidentEnough(undefined), false)
    assert.equal(confidentEnough('high'), true)
    assert.equal(confidentEnough('medium'), true)
  })

  test('信心「中」的照樣提議', t => {
    const s = one(t, '未命名文件 (3).txt', { ...HIGH, confidence: 'medium' })
    assert.equal(renameSuggestions(s.db, s.scope).items.length, 1)
  })

  test('模型還沒看過的不在清單上', t => {
    const s = sandbox(t, { '未命名文件 (3).txt': OS_DEADLOCK })
    assert.deepEqual(renameSuggestions(s.db, s.scope).items, [])
  })

  test('建議洗完是空的（模型只回了路徑）就不提議', t => {
    const s = one(t, '未命名文件 (3).txt', { ...HIGH, suggestedName: '../../' })
    assert.deepEqual(renameSuggestions(s.db, s.scope).items, [])
  })

  test('建議跟現在的名字一樣就不提議', t => {
    const s = one(t, '未命名文件 (3).txt', { ...HIGH, suggestedName: '未命名文件 (3)' })
    assert.deepEqual(renameSuggestions(s.db, s.scope).items, [])
  })

  test('預期行為 8：在一份還沒套用的清理計畫裡 → 不提議，而且講得出原因', t => {
    // 舊的壓縮檔會變成清理候選；同一個檔又是「沒取名」
    const s = sandbox(t, { '未命名文件 (3).zip': 'x'.repeat(500) }, { days: 200 })
    // .zip 讀不到文字，所以直接寫一筆看法（快取鍵對不上也沒關係：這裡測的是計畫那一條）
    const id = s.idOf('未命名文件 (3).zip')
    s.db.prepare(`INSERT INTO model_views
      (key,item_id,source,course,topic,kind,suggested_name,evidence,confidence,model,prompt_version,at,seeded)
      VALUES (?,?,'text','作業系統','死結','Notes','作業系統_死結','四個必要條件','high','假模型','v1',?,0)`)
      .run('k-' + id, id, new Date().toISOString())
    // 前提：沒有計畫的時候提議得出來
    assert.equal(renameSuggestions(s.db, s.scope).items.length, 1, '前提：本來提議得出來')

    createPlan(s.db)
    assert.deepEqual(renameSuggestions(s.db, s.scope).items, [], '在計畫裡的檔不可以被提議')
    const row = s.rowOf('未命名文件 (3).zip')
    assert.match(whyNotRenamable(s.db, row, s.scope), /cleanup plan/)
  })

  test('預期行為 9：十分鐘內還在變動的檔不提議', t => {
    const s = one(t, '未命名文件 (3).txt')
    assert.equal(renameSuggestions(s.db, s.scope).items.length, 1, '前提：撥老的時候提議得出來')
    // 把它改回「剛剛才動過」
    const now = new Date()
    utimesSync(join(s.downloads, '未命名文件 (3).txt'), now, now)
    s.db.prepare('UPDATE file_items SET mtime=? WHERE id=?').run(now.toISOString(), s.itemId)
    assert.deepEqual(renameSuggestions(s.db, s.scope).items, [])
    assert.match(whyNotRenamable(s.db, s.rowOf('未命名文件 (3).txt'), s.scope), /ten minutes/)
  })

  test('status 是 new 的不提議（還在下載）', t => {
    const s = one(t, '未命名文件 (3).txt')
    s.db.prepare(`UPDATE file_items SET status='new' WHERE id=?`).run(s.itemId)
    assert.deepEqual(renameSuggestions(s.db, s.scope).items, [])
  })

  test('隔離區裡的（quarantined）不提議', t => {
    const s = one(t, '未命名文件 (3).txt')
    s.db.prepare(`UPDATE file_items SET status='quarantined' WHERE id=?`).run(s.itemId)
    assert.deepEqual(renameSuggestions(s.db, s.scope).items, [])
  })

  test('受保護的檔名不提議（`.lnk` 是受保護的副檔名）', t => {
    const s = sandbox(t, { '未命名文件 (3).lnk': 'x'.repeat(200) })
    const row = s.rowOf('未命名文件 (3).lnk')
    assert.equal(row.naming, 'untitled', '前提：它是「沒取名」的')
    s.seedRaw('未命名文件 (3).lnk', HIGH)
    assert.deepEqual(renameSuggestions(s.db, s.scope).items, [])
    assert.match(whyNotRenamable(s.db, row, s.scope), /protected/)
  })

  test('清單上沒有絕對路徑，而且標得出來是不是示範答案', t => {
    const s = one(t, '未命名文件 (3).txt', { ...HIGH, seeded: true })
    const out = renameSuggestions(s.db, s.scope)
    assert.equal(out.items[0].seeded, true)
    assert.ok(!JSON.stringify(out).includes(s.downloads), '建議清單不可以有絕對路徑')
    assert.ok(!JSON.stringify(out).includes(s.dir))
  })
})

// ═══ 真的改名 ═══════════════════════════════════════════════

describe('改名', () => {
  test('預期行為 3：檔案真的改了名，file_items 還是同一列，naming 變成 named', t => {
    const s = one(t)
    const before = s.rowOf('未命名文件 (3).txt')
    const r = applyRenames(s.db, [{ itemId: s.itemId, to: '作業系統_死結' }], s.scope)

    assert.equal(r.results.length, 1)
    assert.equal(r.results[0].ok, true, r.results[0].why)
    assert.equal(r.results[0].from, '未命名文件 (3).txt')
    assert.equal(r.results[0].to, '作業系統_死結.txt')
    assert.equal(existsSync(join(s.downloads, '作業系統_死結.txt')), true)
    assert.equal(existsSync(join(s.downloads, '未命名文件 (3).txt')), false)
    assert.equal(readFileSync(join(s.downloads, '作業系統_死結.txt'), 'utf8'), OS_DEADLOCK)

    // **同一列**：id 不變、path 與 name 跟上、不可以變成兩列
    const after = s.rowOf('作業系統_死結.txt')
    assert.equal(after.id, before.id)
    assert.equal(after.name, '作業系統_死結.txt')
    assert.equal(after.naming, 'named')
    assert.equal(s.db.prepare('SELECT count(*) n FROM file_items').get().n, 1)

    // 改完就不再提議
    assert.deepEqual(renameSuggestions(s.db, s.scope).items, [])
  })

  test('改完馬上重掃：還是**同一列**，不會變成兩列（指紋與模型看法不用重算）', t => {
    const s = one(t)
    const before = s.rowOf('未命名文件 (3).txt')
    applyRenames(s.db, [{ itemId: s.itemId, to: '作業系統_死結' }], s.scope)
    s.scan()
    assert.equal(s.db.prepare('SELECT count(*) n FROM file_items').get().n, 1, '重掃之後變成兩列了')
    const after = s.rowOf('作業系統_死結.txt')
    assert.equal(after.id, before.id)
    assert.equal(after.status !== 'missing', true, `重掃把它標成 ${after.status}`)
    // 模型的看法跟著同一個 item 走，不用重問
    assert.equal(s.db.prepare('SELECT count(*) n FROM model_views WHERE item_id=?').get(before.id).n, 1)
  })

  test('不給 to 就用模型的建議', t => {
    const s = one(t)
    const r = applyRenames(s.db, [{ itemId: s.itemId }], s.scope)
    assert.equal(r.results[0].to, '作業系統_死結.txt')
    assert.equal(s.db.prepare('SELECT source FROM renames').get().source, 'model')
  })

  test('使用者自己打的名字記成 manual，而且一樣要洗過', t => {
    const s = one(t)
    const r = applyRenames(s.db, [{ itemId: s.itemId, to: '../我自己取的' }], s.scope)
    assert.equal(r.results[0].to, '我自己取的.txt')
    assert.equal(s.db.prepare('SELECT source FROM renames').get().source, 'manual')
  })

  test('預期行為 5：目標已經存在 → 加 -2，而且**沒有覆蓋**任何檔', t => {
    const s = one(t)
    const occupied = join(s.downloads, '作業系統_死結.txt')
    writeFileSync(occupied, '本來就在這裡的檔')
    const r = applyRenames(s.db, [{ itemId: s.itemId, to: '作業系統_死結' }], s.scope)

    assert.equal(r.results[0].ok, true, r.results[0].why)
    assert.equal(r.results[0].to, '作業系統_死結-2.txt')
    assert.equal(readFileSync(occupied, 'utf8'), '本來就在這裡的檔', '既有的檔被覆蓋了')
    assert.equal(readFileSync(join(s.downloads, '作業系統_死結-2.txt'), 'utf8'), OS_DEADLOCK)
  })

  test('只差大小寫的同名也加序號（別的檔）', t => {
    const s = one(t)
    // 目標只差大小寫（.TXT／.txt）：在不分大小寫的檔案系統上這是同一個檔
    writeFileSync(join(s.downloads, '作業系統_死結.TXT'), '本來就在這裡的檔')
    const r = applyRenames(s.db, [{ itemId: s.itemId, to: '作業系統_死結' }], s.scope)
    assert.equal(r.results[0].ok, true, r.results[0].why)
    assert.equal(r.results[0].to, '作業系統_死結-2.txt')
    assert.equal(readFileSync(join(s.downloads, '作業系統_死結.TXT'), 'utf8'), '本來就在這裡的檔')
  })

  test('只差大小寫的同名也加序號（**就是自己**：直接 rename 會覆蓋自己）', t => {
    const s = one(t, 'IMG_2041.txt', { ...HIGH, suggestedName: 'img_2041' }, DS_MIDTERM)
    const r = applyRenames(s.db, [{ itemId: s.itemId, to: 'img_2041' }], s.scope)
    assert.equal(r.results[0].ok, true, r.results[0].why)
    assert.equal(r.results[0].to, 'img_2041-2.txt')
    assert.equal(readFileSync(join(s.downloads, 'img_2041-2.txt'), 'utf8'), DS_MIDTERM)
    assert.equal(existsSync(join(s.downloads, 'IMG_2041.txt')), false)
  })

  test('預期行為 6：惡意的建議**絕對不會**寫到別的資料夾', t => {
    const s = one(t)
    const outside = join(s.dir, 'passwd')
    for (const to of ['../../etc/passwd', '..\\..\\Windows\\System32\\x', '/etc/shadow']) {
      const fresh = one(t, '未命名文件 (3).txt', HIGH)
      const r = applyRenames(fresh.db, [{ itemId: fresh.itemId, to }], fresh.scope)
      const got = r.results[0]
      if (got.ok) {
        assert.ok(!got.to.includes('/') && !got.to.includes('\\'), `${to} → ${got.to}`)
        assert.equal(existsSync(join(fresh.downloads, got.to)), true, '改出來的檔要在同一個資料夾裡')
      }
      // 不管成不成功，資料夾外面都不可以多出東西
      assert.deepEqual(readdirSync(fresh.dir).sort(), ['Downloads', 'data.db', 'data.db-shm', 'data.db-wal'].filter(
        f => existsSync(join(fresh.dir, f))).sort())
    }
    assert.equal(existsSync(outside), false)
    assert.equal(existsSync('/etc/passwd.contextbox-test'), false)
  })

  test('控制字元、保留名稱、超長的建議：洗乾淨或不做，不會炸掉', t => {
    for (const to of ['CON', '\u202E', '   ', '中'.repeat(500), 'a\u0000b']) {
      const s = one(t)
      const r = applyRenames(s.db, [{ itemId: s.itemId, to }], s.scope)
      const got = r.results[0]
      if (got.ok) {
        assert.ok([...got.to].length <= NAME_MAX_CODEPOINTS + 4, got.to)
        assert.doesNotMatch(got.to, /[\u0000-\u001f\u202e]/)
        assert.equal(existsSync(join(s.downloads, got.to)), true)
      } else {
        assert.match(got.why, /name|suggest/)
        assert.equal(existsSync(join(s.downloads, '未命名文件 (3).txt')), true, '沒改成就要留在原地')
      }
    }
  })

  test('預期行為 8：在清理計畫裡的檔不改，而且講得出原因', t => {
    const s = sandbox(t, { '未命名文件 (3).zip': 'x'.repeat(500) }, { days: 200 })
    const id = s.idOf('未命名文件 (3).zip')
    s.db.prepare(`INSERT INTO model_views
      (key,item_id,source,course,topic,kind,suggested_name,evidence,confidence,model,prompt_version,at,seeded)
      VALUES (?,?,'text','作業系統','死結','Notes','作業系統_死結','證據','high','假模型','v1',?,0)`)
      .run('k-' + id, id, new Date().toISOString())
    createPlan(s.db)
    const r = applyRenames(s.db, [{ itemId: id, to: '作業系統_死結' }], s.scope)
    assert.equal(r.results[0].ok, false)
    assert.match(r.results[0].why, /cleanup plan/)
    assert.equal(existsSync(join(s.downloads, '未命名文件 (3).zip')), true)
  })

  test('預期行為 9：十分鐘內還在變動的檔不改', t => {
    const s = one(t)
    const now = new Date()
    utimesSync(join(s.downloads, '未命名文件 (3).txt'), now, now)
    const r = applyRenames(s.db, [{ itemId: s.itemId, to: '作業系統_死結' }], s.scope)
    assert.equal(r.results[0].ok, false)
    assert.match(r.results[0].why, /ten minutes/)
    assert.equal(existsSync(join(s.downloads, '未命名文件 (3).txt')), true)
  })

  test(`預期行為 10：一次勾 150 個 → 做前 ${RENAME_BATCH_MAX} 個，剩下的講得出來`, t => {
    const files = {}
    for (let i = 0; i < 150; i++) files[`未命名文件 (${i}).txt`] = OS_DEADLOCK + `\n第 ${i} 份\n`
    const s = sandbox(t, files)
    const items = []
    for (let i = 0; i < 150; i++) {
      s.seedRaw(`未命名文件 (${i}).txt`, { ...HIGH, suggestedName: `作業系統_死結_${i}` })
      items.push({ itemId: s.idOf(`未命名文件 (${i}).txt`), to: `作業系統_死結_${i}` })
    }
    const r = applyRenames(s.db, items, s.scope)
    assert.equal(r.results.length, RENAME_BATCH_MAX)
    assert.equal(r.remaining, 150 - RENAME_BATCH_MAX)
    assert.equal(r.results.filter(x => x.ok).length, RENAME_BATCH_MAX, JSON.stringify(r.results.find(x => !x.ok)))
    // 後面 50 個一個都沒動
    assert.equal(existsSync(join(s.downloads, '未命名文件 (149).txt')), true)
  })

  test('同一個檔在同一次送兩次，只做一次', t => {
    const s = one(t)
    const r = applyRenames(s.db, [{ itemId: s.itemId, to: 'a' }, { itemId: s.itemId, to: 'b' }], s.scope)
    assert.equal(r.results.length, 1)
    assert.equal(r.results[0].to, 'a.txt')
  })

  test('唯讀模式一個檔都不改', t => {
    const s = one(t)
    assert.throws(() => applyRenames(s.db, [{ itemId: s.itemId }], { ...s.scope, readonly: true }), /ead-only/)
    assert.equal(existsSync(join(s.downloads, '未命名文件 (3).txt')), true)
  })

  test('沒指名就是 BAD_BODY，**沒有「全部」這種捷徑**', t => {
    const s = one(t)
    for (const bad of [undefined, null, [], 'all', {}]) {
      assert.throws(() => applyRenames(s.db, bad, s.scope), /要指名|items/)
    }
    assert.equal(existsSync(join(s.downloads, '未命名文件 (3).txt')), true)
  })

  test('**硬鏈結**不碰（掃描之後才被連過去的）', t => {
    const s = one(t)
    // 掃描的時候它是一般檔；之後別人把它硬鏈結出去（`ln 未命名文件 ~/.ssh/x` 的反方向）
    linkSync(join(s.downloads, '未命名文件 (3).txt'), join(s.dir, '另一個名字'))
    const r = applyRenames(s.db, [{ itemId: s.itemId, to: '作業系統_死結' }], s.scope)
    assert.equal(r.results[0].ok, false, '被硬鏈結的檔不可以改名')
    assert.match(r.results[0].why, /hard-link/)
    assert.equal(existsSync(join(s.downloads, '未命名文件 (3).txt')), true)
  })

  test('**捷徑**不碰（掃描之後被換成 symlink）', t => {
    const s = one(t)
    const real = join(s.dir, 'secret.txt')
    writeFileSync(real, '機密'.repeat(50))
    const at = new Date(Date.now() - 30 * DAY)
    utimesSync(real, at, at)
    // 原本那個檔被換成一個指向別處的捷徑（TOCTOU）
    renameSync(join(s.downloads, '未命名文件 (3).txt'), join(s.dir, 'moved.txt'))
    symlinkSync(real, join(s.downloads, '未命名文件 (3).txt'))
    const r = applyRenames(s.db, [{ itemId: s.itemId, to: '作業系統_死結' }], s.scope)
    assert.equal(r.results[0].ok, false, '捷徑不可以被改名')
    assert.match(r.results[0].why, /symlink/)
    assert.equal(existsSync(real), true)
    assert.equal(existsSync(join(s.downloads, '作業系統_死結.txt')), false)
  })

  test('預期行為 12：逐項結果裡沒有絕對路徑', t => {
    const s = one(t)
    const r = applyRenames(s.db, [{ itemId: s.itemId }, { itemId: 'no-such-item' }], s.scope)
    const text = JSON.stringify(r)
    assert.ok(!text.includes(s.downloads), text)
    assert.ok(!text.includes(s.dir), text)
    assert.ok(!text.includes(FAKE_HOME), text)
    // 但資料庫裡**要**留著 dir（收尾要靠它）
    assert.equal(s.db.prepare('SELECT dir FROM renames').get().dir, s.downloads)
  })
})

// ═══ 復原 ═══════════════════════════════════════════════════

describe('復原', () => {
  test('預期行為 4：undo 之後名字變回去，那一列是 reverted', t => {
    const s = one(t)
    const a = applyRenames(s.db, [{ itemId: s.itemId, to: '作業系統_死結' }], s.scope)
    const id = a.results[0].id
    assert.equal(s.db.prepare('SELECT status FROM renames WHERE id=?').get(id).status, 'done')

    const u = undoRenames(s.db, { ids: [id] }, s.scope)
    assert.equal(u.results[0].ok, true, u.results[0].why)
    assert.equal(u.results[0].to, '未命名文件 (3).txt')
    assert.equal(u.results[0].restoredAs, null)
    assert.equal(existsSync(join(s.downloads, '未命名文件 (3).txt')), true)
    assert.equal(existsSync(join(s.downloads, '作業系統_死結.txt')), false)
    assert.equal(s.db.prepare('SELECT status FROM renames WHERE id=?').get(id).status, 'reverted')
    assert.ok(s.db.prepare('SELECT undone_at FROM renames WHERE id=?').get(id).undone_at)

    // file_items 跟著回去，而且又變回「沒取名」，所以清單上又看得到
    assert.equal(s.rowOf('未命名文件 (3).txt').naming, 'untitled')
    assert.equal(renameSuggestions(s.db, s.scope).items.length, 1)
  })

  test('預期行為 11：原名被佔走 → 加序號，而且**講清楚放回來的叫什麼**', t => {
    const s = one(t)
    const a = applyRenames(s.db, [{ itemId: s.itemId, to: '作業系統_死結' }], s.scope)
    // 使用者改完之後又自己建了一個同名檔
    writeFileSync(join(s.downloads, '未命名文件 (3).txt'), '後來才出現的檔')

    const u = undoRenames(s.db, { ids: [a.results[0].id] }, s.scope)
    assert.equal(u.results[0].ok, true, u.results[0].why)
    assert.equal(u.results[0].restoredAs, '未命名文件 (3)-2.txt')
    assert.match(u.results[0].why, /未命名文件 \(3\)-2\.txt/)
    assert.equal(readFileSync(join(s.downloads, '未命名文件 (3).txt'), 'utf8'), '後來才出現的檔', '覆蓋了別人的檔')
    assert.equal(readFileSync(join(s.downloads, '未命名文件 (3)-2.txt'), 'utf8'), OS_DEADLOCK)
  })

  test('{ last: true } 復原最近那一次（同一批一起回去）', t => {
    const s = sandbox(t, { '未命名文件 (1).txt': OS_DEADLOCK, '未命名文件 (2).txt': DS_MIDTERM })
    s.seed('未命名文件 (1).txt', { ...HIGH, suggestedName: '甲' })
    s.seed('未命名文件 (2).txt', { ...HIGH, suggestedName: '乙' })
    const first = applyRenames(s.db, [{ itemId: s.idOf('未命名文件 (1).txt') }], s.scope)
    assert.equal(first.results[0].ok, true, first.results[0].why)
    const second = applyRenames(s.db, [{ itemId: s.idOf('未命名文件 (2).txt') }], s.scope)
    assert.equal(second.results[0].ok, true, second.results[0].why)

    const u = undoRenames(s.db, { last: true }, s.scope)
    assert.equal(u.results.length, 1)
    assert.equal(u.results[0].to, '未命名文件 (2).txt')
    // 前一次不動
    assert.equal(existsSync(join(s.downloads, '甲.txt')), true)
  })

  test('沒有東西可以復原就講清楚', t => {
    const s = one(t)
    assert.throws(() => undoRenames(s.db, { last: true }, s.scope), /There is no rename to undo/)
    assert.throws(() => undoRenames(s.db, { ids: ['不存在'] }, s.scope), /Cannot find/)
    assert.throws(() => undoRenames(s.db, {}, s.scope), /Name the ids/)
  })

  test('復原兩次不會出事（第二次說「本來就已經復原過了」）', t => {
    const s = one(t)
    const a = applyRenames(s.db, [{ itemId: s.itemId }], s.scope)
    undoRenames(s.db, { ids: [a.results[0].id] }, s.scope)
    const again = undoRenames(s.db, { ids: [a.results[0].id] }, s.scope)
    assert.equal(again.results[0].ok, true)
    assert.match(again.results[0].why, /had already been undone/)
    assert.equal(existsSync(join(s.downloads, '未命名文件 (3).txt')), true)
  })

  test('唯讀模式不復原', t => {
    const s = one(t)
    const a = applyRenames(s.db, [{ itemId: s.itemId }], s.scope)
    assert.throws(() => undoRenames(s.db, { ids: [a.results[0].id] }, { ...s.scope, readonly: true }), /ead-only/)
    assert.equal(existsSync(join(s.downloads, '作業系統_死結.txt')), true)
  })

  test('復原的結果裡沒有絕對路徑', t => {
    const s = one(t)
    const a = applyRenames(s.db, [{ itemId: s.itemId }], s.scope)
    const u = undoRenames(s.db, { ids: [a.results[0].id] }, s.scope)
    assert.ok(!JSON.stringify(u).includes(s.downloads))
  })
})

// ═══ 收尾（中斷之後）═══════════════════════════════════════

describe('中斷之後的收尾', () => {
  /** 做出「rename 已經做了、done 還沒寫」的狀態 —— 那正是被砍在中間的樣子。 */
  function crashAfterRename(s, to) {
    const id = randomUUID()
    s.db.prepare(
      `INSERT INTO renames (id,item_id,from_name,to_name,dir,source,status,error,at,undone_at)
       VALUES (?,?,?,?,?, 'model','started',NULL,?,NULL)`
    ).run(id, s.itemId, s.name, to, s.downloads, new Date().toISOString())
    renameSync(join(s.downloads, s.name), join(s.downloads, to))
    return id
  }

  test('預期行為 7：新名字在 → 那一列變 done，不會再改一次', t => {
    const s = one(t)
    const id = crashAfterRename(s, '作業系統_死結.txt')

    const r = recoverInterruptedRenames(s.db)
    assert.equal(r.recovered, 1)
    assert.equal(s.db.prepare('SELECT status FROM renames WHERE id=?').get(id).status, 'done')
    // file_items 也跟上了（當初沒來得及寫）
    assert.equal(s.rowOf('作業系統_死結.txt').naming, 'named')
    assert.equal(s.db.prepare('SELECT count(*) n FROM file_items').get().n, 1)
    // 不會重複改：收尾兩次結果一樣，檔名也一樣
    recoverInterruptedRenames(s.db)
    assert.deepEqual(readdirSync(s.downloads), ['作業系統_死結.txt'])
    assert.equal(s.db.prepare(`SELECT count(*) n FROM renames`).get().n, 1)
  })

  test('**被砍之後先掃過一次**：收尾照樣收得掉，而且復原得回去', t => {
    // P3 驗證員抓到的 blocker：pet 開機與每 30 分鐘都會掃，掃描會把新名字當成一個新檔收進來
    // （舊那列變 missing）。收尾如果硬改舊那列的 path，會撞 UNIQUE(file_items.path)，
    // 例外被吞掉 → 那一筆永遠停在 started，檔案已經改名了卻永遠復原不回來。
    const s = one(t)
    const id = crashAfterRename(s, '作業系統_死結.txt')
    s.scan()                       // ← 關鍵：先掃一次，新名字變成另一列
    const rows = s.db.prepare('SELECT id, name, status FROM file_items ORDER BY name').all()
    assert.equal(rows.length, 2, `前提：掃描把新名字收成第二列：${JSON.stringify(rows)}`)

    assert.equal(recoverInterruptedRenames(s.db).recovered, 1, '收尾要收得掉')
    const row = s.db.prepare('SELECT * FROM renames WHERE id=?').get(id)
    assert.equal(row.status, 'done')
    assert.equal(s.rowOf('作業系統_死結.txt').id, row.item_id, '那一筆要跟著現在有效的那一列')
    assert.equal(s.rowOf('作業系統_死結.txt').naming, 'named')

    // 復原得回去
    const u = undoRenames(s.db, { ids: [id] }, s.scope)
    assert.equal(u.results[0].ok, true, u.results[0].why)
    assert.deepEqual(readdirSync(s.downloads), ['未命名文件 (3).txt'])
  })

  test('收尾真的收不掉時要留下原因（不可以安靜地一直卡著）', t => {
    const s = one(t)
    const id = crashAfterRename(s, '作業系統_死結.txt')
    s.db.exec(`CREATE TRIGGER no_follow BEFORE UPDATE OF naming ON file_items
               BEGIN SELECT RAISE(ABORT,'擋住'); END`)
    assert.equal(recoverInterruptedRenames(s.db).recovered, 0)
    s.db.exec('DROP TRIGGER no_follow')
    const row = s.db.prepare('SELECT status, error FROM renames WHERE id=?').get(id)
    assert.equal(row.status, 'started')
    assert.match(row.error ?? '', /Tidying up failed/, '要留下線索')
    assert.equal(recoverInterruptedRenames(s.db).recovered, 1, '擋住的原因排除之後收得掉')
  })

  test('**新舊兩個名字都在 → 還是 done**（改名真的做了，只是使用者又下載了一次同名檔）', t => {
    // 突變測試抓到的洞：收尾如果先看舊名字，這一格會被判成 reverted ——
    // 改好的那個檔從此沒人追蹤，而且那一筆改名再也復原不了。
    // 我們只會挑「當時不存在」的目標，所以**新名字在＝我們的 rename 成功了**，先看它。
    const s = one(t)
    const id = crashAfterRename(s, '作業系統_死結.txt')
    writeFileSync(join(s.downloads, '未命名文件 (3).txt'), '瀏覽器又下載了一次')

    assert.equal(recoverInterruptedRenames(s.db).recovered, 1)
    assert.equal(s.db.prepare('SELECT status FROM renames WHERE id=?').get(id).status, 'done')
    assert.equal(s.rowOf('作業系統_死結.txt').id, s.itemId, 'file_items 要跟到新名字')
    // 兩個檔都還在，一個都沒被覆蓋
    assert.equal(readFileSync(join(s.downloads, '作業系統_死結.txt'), 'utf8'), OS_DEADLOCK)
    assert.equal(readFileSync(join(s.downloads, '未命名文件 (3).txt'), 'utf8'), '瀏覽器又下載了一次')
    // 而且復原得回去（原名被佔走，所以放回來的會加序號）
    const u = undoRenames(s.db, { ids: [id] }, s.scope)
    assert.equal(u.results[0].ok, true, u.results[0].why)
    assert.equal(u.results[0].restoredAs, '未命名文件 (3)-2.txt')
  })

  test('舊名字還在 → 那一列變 reverted（根本沒改到）', t => {
    const s = one(t)
    const id = randomUUID()
    s.db.prepare(
      `INSERT INTO renames (id,item_id,from_name,to_name,dir,source,status,error,at,undone_at)
       VALUES (?,?,?,?,?, 'model','started',NULL,?,NULL)`
    ).run(id, s.itemId, s.name, '作業系統_死結.txt', s.downloads, new Date().toISOString())

    assert.equal(recoverInterruptedRenames(s.db).recovered, 1)
    const row = s.db.prepare('SELECT * FROM renames WHERE id=?').get(id)
    assert.equal(row.status, 'reverted')
    assert.match(row.error, /never changed/)
    assert.equal(existsSync(join(s.downloads, '未命名文件 (3).txt')), true)
  })

  test('兩個名字都不在 → failed，留一句話，不猜', t => {
    const s = one(t)
    const id = randomUUID()
    s.db.prepare(
      `INSERT INTO renames (id,item_id,from_name,to_name,dir,source,status,error,at,undone_at)
       VALUES (?,?,'不見了.txt','也不見了.txt',?,'model','started',NULL,?,NULL)`
    ).run(id, s.itemId, s.downloads, new Date().toISOString())
    recoverInterruptedRenames(s.db)
    const row = s.db.prepare('SELECT * FROM renames WHERE id=?').get(id)
    assert.equal(row.status, 'failed')
    assert.match(row.error, /Check it yourself/)
  })

  test('還沒收尾的那個檔，清單上先不提議', t => {
    const s = one(t)
    crashAfterRename(s, '作業系統_死結.txt')
    assert.deepEqual(renameSuggestions(s.db, s.scope).items, [])
  })

  test('下一次 apply 會先收尾', t => {
    const s = one(t)
    const id = crashAfterRename(s, '作業系統_死結.txt')
    const r = applyRenames(s.db, [{ itemId: s.itemId, to: '別的名字' }], s.scope)
    assert.equal(s.db.prepare('SELECT status FROM renames WHERE id=?').get(id).status, 'done')
    // 收尾之後它已經是 named，所以不會再被改一次
    assert.equal(r.results[0].ok, false)
    assert.match(r.results[0].why, /already has a name/)
    assert.equal(existsSync(join(s.downloads, '作業系統_死結.txt')), true)
  })

  test('收尾之後復原得回去（紀錄還在）', t => {
    const s = one(t)
    const id = crashAfterRename(s, '作業系統_死結.txt')
    recoverInterruptedRenames(s.db)
    const u = undoRenames(s.db, { ids: [id] }, s.scope)
    assert.equal(u.results[0].ok, true, u.results[0].why)
    assert.equal(existsSync(join(s.downloads, '未命名文件 (3).txt')), true)
  })
})

describe('紀錄', () => {
  test('listRenames 看得到最近幾筆，而且不回 dir', t => {
    const s = one(t)
    applyRenames(s.db, [{ itemId: s.itemId }], s.scope)
    const rows = listRenames(s.db)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].from, '未命名文件 (3).txt')
    assert.equal(rows[0].to, '作業系統_死結.txt')
    assert.equal(rows[0].status, 'done')
    assert.ok(!('dir' in rows[0]), '紀錄列表不可以帶資料夾')
    assert.ok(!JSON.stringify(rows).includes(s.downloads))
  })
})

// ═══ 最後一輪稽核補的（2026-09-20）═══════════════════════════

describe('稽核 ・ 復原也是改名，一樣要看清理計畫（2026-09-20）', () => {
  test('改完名之後那個檔被排進一份計畫 → undo 要拒絕，訊息跟 apply 那邊一樣', t => {
    // 200 天沒動的壓縮檔：改完名之後重掃就會變成清理候選
    const s = sandbox(t, { '未命名文件 (3).zip': 'x'.repeat(500) }, { days: 200 })
    const itemId = s.idOf('未命名文件 (3).zip')
    s.db.prepare(`INSERT INTO model_views
      (key,item_id,source,course,topic,kind,suggested_name,evidence,confidence,model,prompt_version,at,seeded)
      VALUES (?,?,'text','作業系統','死結','Notes','作業系統_死結','四個必要條件','high','假模型','v1',?,0)`)
      .run('k-' + itemId, itemId, new Date().toISOString())

    const r = applyRenames(s.db, [{ itemId, to: '作業系統_死結.zip' }], s.scope)
    assert.equal(r.results[0].ok, true, r.results[0].why)
    s.scan()                       // 重掃：它現在是「作業系統_死結.zip」，而且是舊檔
    createPlan(s.db)               // 使用者按了「準備清理」，計畫還沒套用

    const back = undoRenames(s.db, { ids: [r.results[0].id] }, s.scope)
    assert.equal(back.results[0].ok, false, '復原也是改名，計畫的快照會對不上')
    assert.match(back.results[0].why, /cleanup plan/)
    assert.equal(existsSync(join(s.downloads, '作業系統_死結.zip')), true, '檔案不可以被動')
    assert.equal(s.db.prepare('SELECT status FROM renames WHERE id=?').get(r.results[0].id).status, 'done',
      '紀錄要留著 —— 計畫處理完之後還復原得回去')
  })
})

describe('稽核 ・ 收尾不可以蓋掉「已經成功」的紀錄', () => {
  /**
   * 真的重現那個競態：收尾先 SELECT 出 status='started' 的列，**再**一列一列 UPDATE。
   * 另一個行程（持鎖的 apply）可能在這中間把同一列 commit 成 done。
   * 這裡用 Proxy 在 SELECT 回來的那一刻把那一列改成 done —— 跟「另一個行程剛剛 commit 完」一樣。
   */
  function settleWithRaceAfterSelect(db, flip) {
    return new Proxy(db, {
      get(target, prop) {
        const v = Reflect.get(target, prop)
        if (prop !== 'prepare') return typeof v === 'function' ? v.bind(target) : v
        return sql => {
          const stmt = target.prepare(sql)
          if (!/SELECT \* FROM renames WHERE status='started'/.test(sql)) return stmt
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

  test('SELECT 之後那一列被別的行程 commit 成 done → 收尾不可以蓋掉它', t => {
    const s = one(t)
    const id = randomUUID()
    const to = '作業系統_死結.txt'
    renameSync(join(s.downloads, s.name), join(s.downloads, to))
    s.db.prepare(
      `INSERT INTO renames (id,item_id,from_name,to_name,dir,source,status,error,at,undone_at)
       VALUES (?,?,?,?,?, 'model','started',NULL,?,NULL)`
    ).run(id, s.itemId, s.name, to, s.downloads, new Date().toISOString())

    // 「另一個行程」在我們 SELECT 完之後把整筆 commit 完：renames 寫 done，
    // file_items 也跟著改名（那正是 applyRenames 在同一個交易裡做的事）
    const flip = () => {
      s.db.prepare(`UPDATE renames SET status='done' WHERE id=?`).run(id)
      s.db.prepare('UPDATE file_items SET path=?, name=?, naming=? WHERE id=?')
        .run(join(s.downloads, to), to, 'named', s.itemId)
    }
    recoverInterruptedRenames(settleWithRaceAfterSelect(s.db, flip))

    const row = s.db.prepare('SELECT * FROM renames WHERE id=?').get(id)
    assert.equal(row.status, 'done', '已經成功的那一筆不可以被收尾蓋成別的狀態')
    assert.equal(row.error, null, '也不可以留下「請人工確認」這種話')
    assert.equal(row.undone_at, null)
    // 而且復原還要做得到（被蓋成 reverted 的話 undo 會回「本來就已經復原過了」，檔案卻沒動）
    const back = undoRenames(s.db, { ids: [id] }, s.fileScope)
    assert.equal(back.results[0].ok, true, back.results[0].why)
    assert.equal(existsSync(join(s.downloads, s.name)), true)
  })

  test('原位那一種也一樣：檔案還在原名、但那一列已經被寫成 done', t => {
    const s = one(t)
    const id = randomUUID()
    s.db.prepare(
      `INSERT INTO renames (id,item_id,from_name,to_name,dir,source,status,error,at,undone_at)
       VALUES (?,?,?,?,?, 'model','started',NULL,?,NULL)`
    ).run(id, s.itemId, s.name, '作業系統_死結.txt', s.downloads, new Date().toISOString())
    const flip = () => s.db.prepare(`UPDATE renames SET status='done' WHERE id=?`).run(id)
    recoverInterruptedRenames(settleWithRaceAfterSelect(s.db, flip))
    const row = s.db.prepare('SELECT * FROM renames WHERE id=?').get(id)
    assert.equal(row.status, 'done')
    assert.equal(row.undone_at, null, '不可以寫上假的復原時間')
  })

  test('真的停在 started 的照樣收得掉（上面兩條不可以把收尾擋死）', t => {
    const s = one(t)
    const id = randomUUID()
    renameSync(join(s.downloads, s.name), join(s.downloads, '作業系統_死結.txt'))
    s.db.prepare(
      `INSERT INTO renames (id,item_id,from_name,to_name,dir,source,status,error,at,undone_at)
       VALUES (?,?,?,?,?, 'model','started',NULL,?,NULL)`
    ).run(id, s.itemId, s.name, '作業系統_死結.txt', s.downloads, new Date().toISOString())
    assert.equal(recoverInterruptedRenames(s.db).recovered, 1)
    assert.equal(s.db.prepare('SELECT status FROM renames WHERE id=?').get(id).status, 'done')
  })
})

describe('稽核 ・ 改名之後 file_items 換了一列，紀錄要跟著換', () => {
  test('目標路徑上已經有一列（missing）→ renames.item_id 指到活著的那一列，undo 放得回原名', t => {
    const s = one(t)
    const target = '作業系統_死結.txt'
    // 使用者以前有一個同名檔，被刪掉之後掃描標成 missing —— 那一列還佔著那個 path
    s.put(target, OS_DEADLOCK)
    s.scan()
    const ghostId = s.idOf(target)
    rmSync(join(s.downloads, target))
    s.scan()
    assert.equal(s.db.prepare('SELECT status FROM file_items WHERE id=?').get(ghostId).status, 'missing')

    const r = applyRenames(s.db, [{ itemId: s.itemId, to: target }], s.fileScope)
    assert.equal(r.results[0].ok, true, r.results[0].why)
    const rec = s.db.prepare('SELECT * FROM renames WHERE id=?').get(r.results[0].id)
    assert.equal(rec.item_id, ghostId, '紀錄要指到那個路徑上活著的那一列')

    const back = undoRenames(s.db, { ids: [r.results[0].id] }, s.fileScope)
    assert.equal(back.results[0].ok, true, back.results[0].why)
    assert.equal(existsSync(join(s.downloads, s.name)), true, '要放得回原名')
  })
})
