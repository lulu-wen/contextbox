import { before, beforeEach, after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { open } from '../core/db.ts'
import { cleanupWalk, scanDownloads, isGoneError, addSameTextCandidates } from '../core/cleanup-scanner.ts'

const day = 24 * 60 * 60 * 1000
const now = new Date('2026-09-13T00:00:00Z')

let root, downloads, db

before(() => {
  root = mkdtempSync(join(tmpdir(), 'cb-cleanup-scan-'))
  downloads = join(root, 'Downloads')
})

after(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(downloads, { recursive: true, force: true })
  mkdirSync(downloads, { recursive: true })
  db = open(':memory:')
})

function touchOld(name, content = 'x', days = 40) {
  const p = join(downloads, name)
  writeFileSync(p, content)
  const t = new Date(now.getTime() - days * day)
  utimesSync(p, t, t)
  return p
}

const scan = extra => scanDownloads({
  db,
  roots: [downloads],
  maxBytes: 1024 * 1024,
  now,
  ...extra,
})

const candidates = () => db.prepare(
  `SELECT c.kind, c.status, f.name, c.reason, c.evidence
   FROM cleanup_candidates c JOIN file_items f ON f.id=c.item_id
   ORDER BY f.name, c.kind`
).all()

describe('cleanup scanner', () => {
  test('掃到舊 zip 會建立 file_items 與 archive candidate', () => {
    touchOld('old.zip', 'zip-ish', 40)
    const r = scan()

    assert.equal(r.scanned, 1)
    const item = db.prepare(`SELECT * FROM file_items WHERE name='old.zip'`).get()
    assert.equal(item.status, 'candidate')
    assert.equal(item.sha256.length, 64)

    const rows = candidates()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind, 'archive')
    assert.match(rows[0].evidence, /40 days/)
  })

  test('同內容檔案只提議清掉後看到的那份，重掃不會長出重複卡片', () => {
    touchOld('a-keep.bin', 'same', 2)
    touchOld('b-copy.bin', 'same', 2)
    scan()
    scan()

    const rows = candidates()
    assert.deepEqual(rows.map(r => `${r.name}:${r.kind}`), ['b-copy.bin:duplicate'])
    assert.equal(
      db.prepare(`SELECT count(*) n FROM cleanup_candidates`).get().n,
      1,
      '重掃不可以一直新增同一張 candidate')
  })

  test('最近還在變動的檔案先入庫但不分類', () => {
    const p = join(downloads, 'fresh.zip')
    writeFileSync(p, 'fresh')
    utimesSync(p, now, now)

    scan()
    const item = db.prepare(`SELECT * FROM file_items WHERE name='fresh.zip'`).get()
    assert.equal(item.status, 'new')
    assert.equal(db.prepare(`SELECT count(*) n FROM cleanup_candidates`).get().n, 0)
  })

  test('空檔與下載中檔要夠舊才成為候選', () => {
    touchOld('empty.tmp', '', 2)
    touchOld('video.mp4.crdownload', 'partial', 2)
    scan()

    assert.deepEqual(candidates().map(r => r.kind).sort(), ['empty', 'partial'])
    assert.equal(
      db.prepare(`SELECT sha256 FROM file_items WHERE name='video.mp4.crdownload'`).get().sha256,
      null,
      '半成品不需要讀內容算 hash')
  })

  // 2026-09-19 稽核 RC3：規則不再成立設 skipped（條件回來時 upsert 會改回 proposed），
  // dismissed 只留給使用者真的拒絕。原本這條斷言 'dismissed'。
  test('候選條件消失時，舊 proposed candidate 會改成 skipped（不是永久 dismissed）', () => {
    const p = touchOld('maybe.tmp', '', 2)
    scan()
    assert.equal(candidates()[0].kind, 'empty')

    writeFileSync(p, 'not empty anymore')
    const t = new Date(now.getTime() - 2 * day)
    utimesSync(p, t, t)
    scan()

    assert.equal(
      db.prepare(`SELECT status FROM cleanup_candidates WHERE kind='empty'`).get().status,
      'skipped')
    assert.equal(db.prepare(`SELECT status FROM file_items WHERE name='maybe.tmp'`).get().status, 'kept')
  })

  // 2026-09-21 使用者實機回報：刪掉一個檔之後，面板頂端掛著
  // 「The last scan reported 1 problems, so some files may have been missed」。
  // 那句話是假的 —— 沒有檔被漏掉，那個檔是使用者自己刪的，而且已經正規記成 missing。
  // 不見了是**正常結局**，不是需要人看的事；真正該報的是沒權限／磁碟錯誤那一種。
  test('掃描時檔案不見了會標 missing，而且不算問題、不算錯誤', () => {
    const p = touchOld('gone.zip', 'gone', 40)
    scan()
    unlinkSync(p)

    const problems = []
    const r = scan({ paths: [p], onProblem: m => problems.push(m) })
    assert.equal(db.prepare(`SELECT status FROM file_items WHERE name='gone.zip'`).get().status, 'missing')
    assert.equal(r.errors, 0, '刪掉一個檔不是掃描錯誤')
    assert.deepEqual(problems, [], '刪掉一個檔不可以變成面板上的警告：' + problems.join('; '))
  })

  // 「不見了」現在的意思從「報一句」變成「安靜跳過」，所以 isGoneError 的邊界
  // **比以前更吃重**：把沒有權限、磁碟錯誤誤判成「不見了」，等於把真正該讓人看到的
  // 問題靜音掉，而且還會把一個其實還在的檔記成 missing。這條盯住那個邊界。
  test('只有 ENOENT／ENOTDIR 算「不見了」——其餘一律不是（現在它決定要不要靜音）', () => {
    for (const code of ['ENOENT', 'ENOTDIR']) {
      assert.equal(isGoneError({ code }), true, code)
    }
    for (const code of ['EACCES', 'EPERM', 'EIO', 'EBUSY', 'EMFILE', 'ELOOP', undefined]) {
      assert.equal(isGoneError({ code }), false, String(code))
    }
    assert.equal(isGoneError(null), false)
  })

  // 2026-09-21 使用者實機回報：「有些檔案基本上是很久沒開，命名甚至重複（有出現 (2)）
  // 應該要可以清理掉才對」。原因是兩條路都斷了 —— .pdf／.docx 在 PROTECTED_EXT 裡，
  // 90 天的 old-download 不挑它們；duplicate 又要求 sha256 完全相同，而重新下載一次的
  // PDF 位元組就不一樣了。所以補一條「抽出來的文字一模一樣」。
  describe('文字一樣但位元組不同的檔', () => {
    const LONG = '食品安全衛生管理法\n\n' + '本法所稱食品添加物，指為食品加工需要而添加於食品之物質。'.repeat(12)

    /** 把第二個檔的 file_texts 對齊第一個 —— 這就是那兩份 PDF 在資料庫裡的樣子。 */
    const alignText = () => {
      const rows = db.prepare('SELECT item_id FROM file_texts WHERE length(trim(text))>=200 ORDER BY item_id').all()
      const first = db.prepare('SELECT text FROM file_texts WHERE item_id=?').get(rows[0].item_id).text
      for (const r of rows.slice(1)) db.prepare('UPDATE file_texts SET text=? WHERE item_id=?').run(first, r.item_id)
      return rows.length
    }

    test('列得出來，**但不預設勾**，而且證據指名留的是哪一份', () => {
      touchOld('法規.txt', LONG, 100)
      touchOld('法規 (2).txt', LONG + ' ', 100)
      scan()
      assert.equal(alignText(), 2, '前提：兩個檔的文字都夠長')
      addSameTextCandidates(db, new Date().toISOString(), undefined, [downloads])

      const rows = db.prepare(
        `SELECT i.name, c.confidence, c.evidence FROM cleanup_candidates c
           JOIN file_items i ON i.id=c.item_id WHERE c.kind='same-text' AND c.status='proposed'`
      ).all()
      assert.equal(rows.length, 1, '只提議多出來的那一份，留著的那一份不可以也變候選')
      assert.equal(rows[0].name, '法規 (2).txt', '`(2)` 那一份才是多出來的')
      assert.ok(rows[0].confidence < 50, '信心必須低於預設勾的門檻，不然一鍵就清掉了')
      assert.match(rows[0].evidence, /法規\.txt/, '證據要指名留的是哪一份')
    })

    // **最危險的誤判。** 使用者的資料庫裡有 23 個檔抽出來的文字是空字串
    // （沒有文字圖層的掃描件 PDF）。照文字分組的話它們會互為「重複」——
    // 那是會刪掉真東西的誤判，而且一次 23 個。
    test('**抽不到文字的檔絕對不可以互相配對**', () => {
      touchOld('掃描件A.pdf', 'A', 100)
      touchOld('掃描件B.pdf', 'BB', 100)
      scan()
      // 兩個都沒有文字層（空字串），而且位元組不同
      for (const r of db.prepare('SELECT item_id FROM file_texts').all()) {
        db.prepare('UPDATE file_texts SET text=? WHERE item_id=?').run('', r.item_id)
      }
      addSameTextCandidates(db, new Date().toISOString(), undefined, [downloads])
      assert.equal(
        db.prepare(`SELECT count(*) c FROM cleanup_candidates WHERE kind='same-text'`).get().c, 0,
        '空文字不是「內容一樣」，是「讀不到內容」')
    })

    test('太短的文字也不算（湊巧一樣的一行字不是證據）', () => {
      touchOld('短A.txt', '收據', 100)
      touchOld('短B.txt', '收據', 100)
      scan()
      addSameTextCandidates(db, new Date().toISOString(), undefined, [downloads])
      assert.equal(
        db.prepare(`SELECT count(*) c FROM cleanup_candidates WHERE kind='same-text'`).get().c, 0)
    })

    test('位元組也一樣的那種不走這條（duplicate 已經管了，不可以兩個理由都提）', () => {
      touchOld('一樣A.txt', LONG, 100)
      touchOld('一樣B.txt', LONG, 100)
      scan()
      addSameTextCandidates(db, new Date().toISOString(), undefined, [downloads])
      const kinds = db.prepare(
        `SELECT DISTINCT kind FROM cleanup_candidates WHERE status='proposed'`).all().map(r => r.kind)
      assert.ok(kinds.includes('duplicate'), '前提：位元組一樣要被 duplicate 抓到')
      assert.ok(!kinds.includes('same-text'), '同一個檔不可以同時掛兩種重複的理由')
    })
  })

  test('walk 不跟 symlink、不進隱藏與黑名單資料夾', () => {
    touchOld('real.zip')
    mkdirSync(join(downloads, '.git'), { recursive: true })
    writeFileSync(join(downloads, '.git', 'hidden.zip'), 'x')
    mkdirSync(join(downloads, 'tokens'), { recursive: true })
    writeFileSync(join(downloads, 'tokens', 'secret.zip'), 'x')
    symlinkSync(join(downloads, 'real.zip'), join(downloads, 'link.zip'))

    const found = cleanupWalk(downloads).files.map(p => basename(p)).sort()
    assert.deepEqual(found, ['real.zip'])
  })
})
