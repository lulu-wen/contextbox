import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyByRules, duplicateDraft, isScreenshotNoiseName } from '../core/cleanup-rules.ts'

const day = 24 * 60 * 60 * 1000
const now = new Date('2026-09-13T00:00:00Z').getTime()
const ago = n => now - n * day

const kinds = rows => rows.map(r => r.kind).sort()

describe('cleanup rules', () => {
  test('半成品與空檔要等 24 小時才提議清理', () => {
    assert.deepEqual(kinds(classifyByRules({
      path: '/Downloads/a.crdownload',
      bytes: 10,
      mtimeMs: ago(0),
      nowMs: now,
    })), [])

    assert.deepEqual(kinds(classifyByRules({
      path: '/Downloads/a.crdownload',
      bytes: 10,
      mtimeMs: ago(2),
      nowMs: now,
    })), ['partial'])

    assert.deepEqual(kinds(classifyByRules({
      path: '/Downloads/empty.txt',
      bytes: 0,
      mtimeMs: ago(2),
      nowMs: now,
    })), ['empty'])
  })

  test('安裝檔、壓縮檔、舊下載檔都有可解釋 evidence', () => {
    const rows = classifyByRules({
      path: '/Downloads/tool.dmg',
      bytes: 123,
      mtimeMs: ago(100),
      nowMs: now,
    })
    assert.deepEqual(kinds(rows), ['installer', 'old-download'])
    assert.ok(rows.every(r => r.reason && r.evidence), '每一條都要能講原因')
  })

  test('舊暫存檔是 temp，但空暫存檔只算 empty', () => {
    assert.deepEqual(kinds(classifyByRules({
      path: '/Downloads/cache.tmp',
      bytes: 10,
      mtimeMs: ago(8),
      nowMs: now,
    })), ['temp'])

    assert.deepEqual(kinds(classifyByRules({
      path: '/Downloads/empty.tmp',
      bytes: 0,
      mtimeMs: ago(8),
      nowMs: now,
    })), ['empty'])
  })

  // 2026-09-21：保護副檔名清單拿掉了，改成保護「最近動過的」。
  // 使用者：「說不定使用者就是要清理，保護 2 周內資料即可」。
  // 舊的 .pdf 現在**列得出來**，但信心 35 → 不預設勾，要自己伸手勾。
  test('舊的 .pdf 列得出來，但不預設勾', () => {
    const rows = classifyByRules({
      path: '/Downloads/important.pdf',
      bytes: 123,
      mtimeMs: ago(120),
      nowMs: now,
    })
    assert.deepEqual(kinds(rows), ['old-download'])
    assert.equal(rows[0].confidence, 35, '涵蓋的檔多了一倍以上，信心更不可以升上門檻')
  })

  test('門檻以內的 .pdf 一個字都不提（這才是保護）', () => {
    assert.deepEqual(kinds(classifyByRules({
      path: '/Downloads/important.pdf',
      bytes: 123,
      mtimeMs: ago(3),
      nowMs: now,
    })), [])
  })

  test('舊截圖是低信心候選', () => {
    const rows = classifyByRules({
      path: '/Downloads/Screenshot 2026-01-01.png',
      bytes: 123,
      mtimeMs: ago(40),
      nowMs: now,
    })
    // 40 天的 .png 現在同時命中 old-download（門檻 14 天）——
    // screenshot-noise 在前面，因為 classifyByRules 的順序就是那樣，而兩條都是 35。
    assert.ok(kinds(rows).includes('screenshot-noise'), JSON.stringify(kinds(rows)))
    assert.ok(rows.every(r => r.confidence === 35), '兩條都該是低信心')
    assert.equal(isScreenshotNoiseName('截圖 2026-01-01'), true)
  })

  test('duplicate draft 說得出還有幾份', () => {
    const d = duplicateDraft(3)
    assert.equal(d.kind, 'duplicate')
    assert.match(d.evidence, /2 other files/)
  })
})

// 2026-09-21 使用者決定：
//   > 不用有保護副檔名清單? 因為說不定使用者就是要清理，保護 2 周內資料即可
// 用副檔名猜「你捨不得丟什麼」太粗糙，而且它擋掉的正是使用者最想處理的那一批
//（實機：491 天沒動的 .pdf 從來不上清單）。改成用時間保護。
describe('保護的是「最近動過」，不是副檔名', () => {
  const DAY = 24 * 60 * 60 * 1000
  const now = Date.now()
  const kinds = (name, days, protectDays) => classifyByRules({
    path: '/dl/' + name, name, bytes: 5000, mtimeMs: now - days * DAY, nowMs: now, protectDays,
  }).map(d => d.kind)

  test('**舊的 .pdf／.docx／.txt 現在提議得出來了**', () => {
    for (const n of ['paper.pdf', 'thesis.docx', 'notes.txt', 'readme.md', 'sheet.xlsx']) {
      assert.ok(kinds(n, 491).includes('old-download'), n + ' 放了 491 天還是不上清單')
    }
  })

  test('門檻以內的一律不碰（這才是保護）', () => {
    for (const d of [0, 1, 7, 13]) {
      assert.deepEqual(kinds('paper.pdf', d), [], d + ' 天的檔不可以被提議')
    }
    assert.ok(kinds('paper.pdf', 14).includes('old-download'), '滿 14 天就算舊')
  })

  test('protectDays 調得動', () => {
    assert.deepEqual(kinds('paper.pdf', 20, 90), [], 'protectDays=90 時 20 天的檔不該上清單')
    assert.ok(kinds('paper.pdf', 100, 90).includes('old-download'))
  })

  // **壞值倒向保守那一邊。** 0 等於「連今天下載的檔都提議清掉」。
  test('protectDays 壞值退回預設，不可以變成 0', () => {
    for (const bad of [0, -1, 0.5, NaN, null, undefined, 'x']) {
      assert.deepEqual(kinds('paper.pdf', 3, bad), [], '3 天的檔不可以被提議（protectDays=' + bad + '）')
    }
  })

  // macOS 的套裝文件用年齡判斷沒有意義（它們是資料夾，裡面是專案檔）
  test('套裝文件仍然保護', () => {
    for (const n of ['deck.pages', 'budget.numbers']) {
      assert.deepEqual(kinds(n, 491), [], n + ' 不該被年齡規則挑中')
    }
  })

  // old-download 的信心不可以趁機變成預設勾 —— 現在它涵蓋的檔多了一倍以上。
  test('**信心還是 35（不預設勾）**', () => {
    const d = classifyByRules({
      path: '/dl/paper.pdf', name: 'paper.pdf', bytes: 5000, mtimeMs: now - 491 * DAY, nowMs: now,
    }).find(x => x.kind === 'old-download')
    assert.equal(d.confidence, 35, '涵蓋範圍變大了，信心更不可以升上門檻')
  })
})
