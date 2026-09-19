import './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * P1 ・ 掃描時把看得懂的檔的內容讀出來（接線）。
 *
 * 期望值照 ~/contextbox-預想-20260919-P1接線.md 的「預期行為」十條寫死，一條一個 describe。
 * 上游三個純模組（office-text／pdf-text／untitled）自己的測試在別的檔案，這裡只看**接線**：
 * 誰該被讀、讀壞了會怎樣、存成什麼樣子、第二次掃描還會不會再讀一次。
 *
 * 惡意輸入分兩種來源：
 *   1. 真的惡意 PDF（pdf-text.test.mjs 的產生器搬過來）—— 走真的 worker，證明整條路真的擋得住。
 *   2. test/helpers/text-worker-bad.mjs —— 「卡住」「吃記憶體」這兩件事很難用真的檔穩定重現，
 *      用一個照檔名決定要不要出事的 worker，其他檔照真的邏輯讀。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync,
  utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { open } from '../core/db.ts'
import { MAX_TEXT_BATCH, MAX_WORKER_DEATHS, scanDownloads } from '../core/cleanup-scanner.ts'
import { MAX_FILE_TEXTS, fileTextByPath, fileTextOf } from '../core/file-texts.ts'
import {
  FILE_TIMEOUT_MS, READ_MAX_CHARS, STORE_MAX_CHARS, TEXT_EXTS, TEXT_REASON, WORKER_HEAP_MB,
  closeTextReader, createTextReader, kindOfExt, textReader,
} from '../core/read-text.ts'
import { runTextJob } from '../core/read-text-job.ts'
import { healthSnapshot } from '../core/cleanup-routes.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIX = join(REPO, 'test', 'fixtures')
const BAD_WORKER = new URL('./helpers/text-worker-bad.mjs', import.meta.url)
const DAY = 86400_000
const MB = 1024 * 1024
/** 預設用設定檔的預設值（20 MB），預期行為第 2 條就是照這個數字寫的。 */
const MAX_BYTES = 20 * MB

/**
 * 一個沙盒：假的 Downloads ＋ 自己的資料庫。檔案的時間往回撥 40 天
 * （掃描器對十分鐘內還在變動的檔不分類，撥老一點才是一般情況）。
 */
function sandbox(t, files = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-p1-')))
  const dl = join(dir, 'Downloads')
  mkdirSync(dl)
  const db = open(join(dir, 'data.db'))
  const readers = []
  t.after(() => {
    for (const r of readers) r.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const put = (name, content, days = 40) => {
    const p = join(dl, name)
    writeFileSync(p, content)
    const at = new Date(Date.now() - days * DAY)
    utimesSync(p, at, at)
    return p
  }
  const copy = (name, from, days = 40) => {
    const p = join(dl, name)
    copyFileSync(from, p)
    const at = new Date(Date.now() - days * DAY)
    utimesSync(p, at, at)
    return p
  }
  for (const [name, content] of Object.entries(files)) put(name, content)
  const problems = []
  const scan = (extra = {}) => {
    problems.length = 0
    return scanDownloads({ db, roots: [dl], maxBytes: MAX_BYTES, onProblem: m => problems.push(m), ...extra })
  }
  /** 會數「真的丟給 worker 幾次」的 reader。 */
  const counted = (opts = {}) => {
    const base = createTextReader(opts)
    readers.push(base)
    let n = 0
    return {
      read: req => { n++; return base.read(req) },
      deaths: () => base.deaths(),
      close: () => base.close(),
      count: () => n,
    }
  }
  const textOf = name => fileTextByPath(db, join(dl, name))
  const itemOf = name => db.prepare('SELECT * FROM file_items WHERE path=?').get(join(dl, name))
  return { dir, dl, db, put, copy, scan, problems, counted, textOf, itemOf }
}

const ms = () => Number(process.hrtime.bigint()) / 1e6
function timed(fn) {
  const t0 = ms()
  const out = fn()
  return { out, took: ms() - t0 }
}

// ═══ 1 ・ demo 沙盒的三份講義 ════════════════════════════════

describe('1 ・ 三份講義：內容讀得到，取名的判斷存三級', () => {
  // 檔名與內容跟 tools/demo-setup.mjs 建出來的那三份一模一樣
  const LECTURES = {
    '作業系統_第5章_行程排程.txt': '作業系統 第 5 章 行程排程\n\nFCFS、SJF、Round Robin 的比較與計算題。\n',
    '未命名文件 (3).txt': '作業系統 第 6 章 死結\n\n四個必要條件、銀行家演算法。\n',
    'IMG_2041.txt': '資料結構 期中考範圍\n\n堆疊、佇列、樹、圖的走訪。\n',
  }

  test('三份都讀得到內容，naming 是 named／untitled／untitled', t => {
    const s = sandbox(t, LECTURES)
    s.scan()
    const want = [
      ['作業系統_第5章_行程排程.txt', 'named', '行程排程'],
      ['未命名文件 (3).txt', 'untitled', '死結'],
      ['IMG_2041.txt', 'untitled', '期中考範圍'],
    ]
    for (const [name, naming, snippet] of want) {
      const row = s.textOf(name)
      assert.ok(row, `${name} 沒有讀到內容`)
      assert.equal(row.kind, 'text')
      assert.equal(row.reason, null, `${name} 不該有讀不懂的原因`)
      assert.equal(row.has_text, 1)
      assert.ok(row.text.includes(snippet), `${name} 的內容對不上：${row.text}`)
      assert.equal(row.chars, [...row.text].length)
      assert.equal(row.truncated, 0)
      assert.equal(s.itemOf(name).naming, naming, `${name} 的 naming`)
      assert.ok(s.itemOf(name).naming_why, `${name} 要有理由`)
    }
  })

  test('理由是人話，而且是 untitled.ts 講的那一個', t => {
    const s = sandbox(t, LECTURES)
    s.scan()
    assert.match(s.itemOf('未命名文件 (3).txt').naming_why, /未命名/)
    assert.match(s.itemOf('IMG_2041.txt').naming_why, /相機/)
    assert.match(s.itemOf('作業系統_第5章_行程排程.txt').naming_why, /內容/)
  })

  test('**每一個檔**都有 naming，不是只有讀得懂內容的那些', t => {
    const s = sandbox(t, { ...LECTURES, 'setup.exe': 'MZ installer', 'IMG_2041.png': 'not a real png' })
    s.scan()
    for (const name of ['setup.exe', 'IMG_2041.png']) {
      const item = s.itemOf(name)
      assert.ok(['untitled', 'generic', 'named'].includes(item.naming), `${name} 的 naming 是 ${item.naming}`)
      assert.ok(item.naming_why)
    }
    assert.equal(s.itemOf('IMG_2041.png').naming, 'untitled')
    // 不在清單裡的副檔名連內容都不讀
    assert.equal(s.textOf('setup.exe'), null)
    assert.equal(s.textOf('IMG_2041.png'), null)
  })
})

// ═══ 2 ・ 太大的檔不讀 ════════════════════════════════════════

describe('2 ・ 超過上限的檔：不讀，reason 是「太大」', () => {
  test('21 MB 的 .txt：reason 太大、沒有內容，其他檔照樣讀得到', t => {
    const s = sandbox(t, { '講義.txt': '作業系統 第 5 章\n' })
    // 21 MB > 預設上限 20 MB
    s.put('超大.txt', Buffer.alloc(21 * MB, 0x61))
    s.scan()
    const big = s.textOf('超大.txt')
    assert.ok(big, '太大的檔也要記一列，不然每一輪都會再試一次')
    assert.equal(big.reason, TEXT_REASON.tooLarge)
    assert.equal(big.text, null)
    assert.equal(big.chars, 0)
    assert.equal(big.has_text, 0)
    assert.equal(s.textOf('講義.txt').reason, null)
  })

  test('太大的檔下一輪不再試（size／mtime 沒變）', t => {
    const s = sandbox(t)
    s.put('超大.txt', Buffer.alloc(21 * MB, 0x61))
    const r1 = s.counted()
    s.scan({ textReader: r1 })
    const r2 = s.counted()
    s.scan({ textReader: r2 })
    assert.equal(r1.count(), 0, '太大的檔根本不該送進 worker')
    assert.equal(r2.count(), 0)
  })

  test('上限是設定值：maxBytes 調小，本來讀得到的檔就變成「太大」', t => {
    const s = sandbox(t, { '講義.txt': '作業系統 第 5 章 行程排程\n' })
    s.scan({ maxBytes: 8 })
    assert.equal(s.textOf('講義.txt').reason, TEXT_REASON.tooLarge)
  })
})

// ═══ 3 ・ 惡意檔不可以拖垮掃描 ═══════════════════════════════

/**
 * 真的惡意 PDF：`bfrange` 重複蓋同一段字碼 5 萬次。map 大小不變，工卻一直在做 ——
 * pdf-text.test.mjs 的產生器搬過來的。上游會在預算用完時丟 TOO_LARGE。
 */
function bfrangeBomb() {
  const cm = '1 begincodespacerange <0000> <FFFF> endcodespacerange\n'
    + ('100 beginbfrange\n' + '<0000> <FFFF> <0041>\n'.repeat(100) + 'endbfrange\n').repeat(500)
  const content = 'BT /F1 12 Tf 72 700 Td <00410042> Tj ET'
  const objs = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'],
    [4, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`],
    [5, '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>'],
    [6, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>'],
    [7, `<< /Length ${cm.length} >>\nstream\n${cm}\nendstream`],
  ]
  const body = objs.map(([n, b]) => `${n} 0 obj\n${b}\nendobj\n`).join('')
  return Buffer.from(`%PDF-1.7\n${body}trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`, 'latin1')
}

describe('3 ・ 惡意檔：掃描照常完成，其他檔照樣讀得到', () => {
  test('真的惡意 PDF（走真的 worker）：記一個原因，掃描完成，旁邊的講義讀得到', t => {
    const s = sandbox(t, { '講義.txt': '作業系統 第 5 章 行程排程\n' })
    s.put('惡意.pdf', bfrangeBomb())
    const { out, took } = timed(() => s.scan())
    assert.equal(out.scanned, 2)
    const bad = s.textOf('惡意.pdf')
    assert.equal(bad.text, null)
    assert.ok(Object.values(TEXT_REASON).includes(bad.reason), `reason 是 ${bad.reason}`)
    assert.match(s.textOf('講義.txt').text, /行程排程/)
    // 一個檔最多 5 秒，這裡上游自己就擋下來了，不該接近那個數字
    assert.ok(took < 3 * FILE_TIMEOUT_MS, `掃描花了 ${took.toFixed(0)} ms`)
  })

  test('worker 卡住：那個檔 reason 是「逾時」，掃描照常完成，其他檔照樣讀得到', t => {
    const s = sandbox(t, {
      '卡住.pdf': bfrangeBomb(),
      '講義.txt': '作業系統 第 5 章 行程排程\n',
      '筆記.md': '# 死結\n四個必要條件\n',
    })
    // 逾時上限調小只是為了測試跑得快：走的是同一條路（Atomics.wait 等不到 → terminate → 重開）
    const reader = s.counted({ entry: BAD_WORKER, timeoutMs: 400 })
    const r = s.scan({ textReader: reader })
    assert.equal(r.scanned, 3, '掃描要照常完成')
    assert.equal(s.textOf('卡住.pdf').reason, TEXT_REASON.timeout)
    assert.equal(s.textOf('卡住.pdf').text, null)
    assert.match(s.textOf('講義.txt').text, /行程排程/)
    assert.match(s.textOf('筆記.md').text, /死結/)
    assert.equal(reader.deaths(), 0, '後面有讀成功，連續死掉的次數要歸零')
  })

  test('worker 真的 OOM 死掉：一樣只是「這個檔讀不到」', t => {
    const s = sandbox(t, {
      '吃記憶體.pdf': bfrangeBomb(),
      '講義.txt': '作業系統 第 5 章 行程排程\n',
    })
    const reader = s.counted({ entry: BAD_WORKER, timeoutMs: 3000 })
    const r = s.scan({ textReader: reader })
    assert.equal(r.scanned, 2)
    // heap 真的被吃光時，主執行緒只看得到「等不到回應」（見 read-text.ts 的已知限制）
    assert.equal(s.textOf('吃記憶體.pdf').reason, TEXT_REASON.timeout)
    assert.match(s.textOf('講義.txt').text, /行程排程/)
  })

  test('worker 亂回東西（不是 JSON）：當成它壞了，換一個，不是把垃圾存進資料庫', t => {
    const s = sandbox(t, { '亂回.txt': '一些字', '講義.txt': '作業系統 第 5 章\n' })
    const reader = s.counted({ entry: BAD_WORKER, timeoutMs: 1000 })
    s.scan({ textReader: reader })
    assert.equal(s.textOf('亂回.txt').reason, TEXT_REASON.timeout)
    assert.equal(s.textOf('亂回.txt').text, null)
    assert.match(s.textOf('講義.txt').text, /第 5 章/)
  })

  test('worker 自己接到配置失敗：reason 是「記憶體不足」', t => {
    const s = sandbox(t, { '記憶體不足.pdf': bfrangeBomb(), '講義.txt': '作業系統\n' })
    const reader = s.counted({ entry: BAD_WORKER, timeoutMs: 2000 })
    s.scan({ textReader: reader })
    assert.equal(s.textOf('記憶體不足.pdf').reason, TEXT_REASON.outOfMemory)
    // 接得住的失敗不算 worker 死掉：不用重開
    assert.equal(reader.deaths(), 0)
  })

  test('讀不懂的檔只報一條總結，不逐檔洗版，而且不帶路徑', t => {
    const s = sandbox(t)
    for (let i = 0; i < 4; i++) s.put(`壞的-${i}.pdf`, Buffer.from('%PDF-1.7\n這不是真的 PDF\n'))
    s.scan()
    const about = s.problems.filter(m => m.includes('看不懂'))
    assert.equal(about.length, 1, `problems：${JSON.stringify(s.problems)}`)
    assert.match(about[0], /4 個/)
    assert.ok(!about[0].includes(s.dl), '不可以帶資料夾的完整路徑')
    assert.ok(!about[0].includes('壞的-0.pdf'), '不逐檔洗版')
  })
})

// ═══ 4 ・ 掃兩次，第二次不重讀 ═══════════════════════════════

describe('4 ・ 有快取就跳過', () => {
  test('20 份 PDF 講義：第二次一個都不再送進 worker，而且明顯比第一次快', t => {
    const s = sandbox(t)
    const src = join(FIX, 'pdf-text', 'lecture.pdf')
    for (let i = 0; i < 20; i++) s.copy(`講義-${i}.pdf`, src)
    const r1 = s.counted()
    const first = timed(() => s.scan({ textReader: r1 }))
    const r2 = s.counted()
    const second = timed(() => s.scan({ textReader: r2 }))
    assert.equal(r1.count(), 20, '第一次要真的讀 20 份')
    assert.equal(r2.count(), 0, '第二次一份都不該再讀')
    assert.ok(second.took < first.took * 0.9,
      `第二次 ${second.took.toFixed(0)} ms 沒有明顯比第一次 ${first.took.toFixed(0)} ms 短`)
  })

  test('第二次掃描不會改寫已經存好的那一列（at 不變）', t => {
    const s = sandbox(t, { '講義.txt': '作業系統 第 5 章\n' })
    s.scan()
    const before = s.textOf('講義.txt')
    s.scan({ now: new Date(Date.now() + 60_000) })
    assert.deepEqual(s.textOf('講義.txt'), before)
  })

  test('沒有文件類檔案的資料夾：一個 worker 都不開', t => {
    const s = sandbox(t, { 'a.zip': 'zip', 'b.exe': 'exe', 'c.png': 'png' })
    const reader = s.counted()
    const r = s.scan({ textReader: reader })
    assert.equal(r.scanned, 3)
    assert.equal(reader.count(), 0)
    assert.equal(r.textsPending, 0)
  })
})

// ═══ 5 ・ 內容改了要重讀 ═════════════════════════════════════

describe('5 ・ size 或 mtime 變了就重讀', () => {
  test('改掉內容（size 變了）→ 重讀', t => {
    const s = sandbox(t, { '講義.txt': '作業系統 第 5 章 行程排程\n' })
    s.scan()
    assert.match(s.textOf('講義.txt').text, /行程排程/)
    s.put('講義.txt', '資料結構 第 3 章 二元搜尋樹　（換了內容，長度也不一樣）\n')
    const reader = s.counted()
    s.scan({ textReader: reader })
    assert.equal(reader.count(), 1)
    assert.match(s.textOf('講義.txt').text, /二元搜尋樹/)
  })

  test('大小一樣、只有 mtime 變了 → 也要重讀', t => {
    const s = sandbox(t, { '講義.txt': 'AAAAAAAAAA' })
    s.scan()
    s.put('講義.txt', 'BBBBBBBBBB', 39)
    assert.equal(statSync(join(s.dl, '講義.txt')).size, 10)
    const reader = s.counted()
    s.scan({ textReader: reader })
    assert.equal(reader.count(), 1, 'mtime 不一樣就要重讀（跟長相指紋同一個規矩）')
    assert.equal(s.textOf('講義.txt').text, 'BBBBBBBBBB')
  })

  test('讀內容不可以動到檔案（只讀不寫）', t => {
    const s = sandbox(t, { '講義.txt': '作業系統 第 5 章\n' })
    const p = join(s.dl, '講義.txt')
    const before = statSync(p)
    const bytes = readFileSync(p)
    s.scan()
    const after = statSync(p)
    assert.equal(after.mtimeMs, before.mtimeMs)
    assert.equal(after.size, before.size)
    assert.deepEqual(readFileSync(p), bytes)
  })
})

// ═══ 6 ・ 掃描版 PDF ═════════════════════════════════════════

describe('6 ・ 沒有文字層不算錯', () => {
  test('掃描版 PDF：has_text 0、text 是空的、沒有 reason', t => {
    const s = sandbox(t)
    s.copy('掃描件.pdf', join(FIX, 'pdf-text', 'scan.pdf'))
    s.scan()
    const row = s.textOf('掃描件.pdf')
    assert.equal(row.reason, null, '沒有文字層不是讀不懂')
    assert.equal(row.has_text, 0)
    assert.equal(row.text, '')
    assert.equal(row.chars, 0)
    assert.ok(row.pages >= 1, 'PDF 要記得出頁數')
    assert.equal(s.problems.filter(m => m.includes('看不懂')).length, 0)
  })

  test('有文字層的 PDF：has_text 1、pages 與 unmapped 都有值', t => {
    const s = sandbox(t)
    s.copy('講義.pdf', join(FIX, 'pdf-text', 'lecture.pdf'))
    s.scan()
    const row = s.textOf('講義.pdf')
    assert.equal(row.kind, 'pdf')
    assert.equal(row.has_text, 1)
    assert.ok(row.pages >= 1)
    assert.equal(typeof row.unmapped, 'number')
    assert.ok(row.unmapped >= 0 && row.unmapped <= 1)
  })

  test('空的 .txt：沒有文字層，也不算讀不懂', t => {
    const s = sandbox(t)
    s.put('空的.txt', Buffer.alloc(0))
    s.scan()
    const row = s.textOf('空的.txt')
    assert.equal(row.reason, null)
    assert.equal(row.has_text, 0)
    assert.equal(row.text, '')
  })
})

// ═══ 7 ・ 讀不懂的不再重試 ═══════════════════════════════════

describe('7 ・ 讀不懂記下來，下一輪不再試', () => {
  test('壞掉的 PDF：第一輪送進 worker，第二輪完全不送', t => {
    const s = sandbox(t, { '壞的.pdf': '%PDF-1.7\n這不是真的 PDF\n' })
    const r1 = s.counted()
    s.scan({ textReader: r1 })
    assert.equal(r1.count(), 1)
    assert.ok(s.textOf('壞的.pdf').reason)
    const r2 = s.counted()
    s.scan({ textReader: r2 })
    assert.equal(r2.count(), 0, '同一個壞檔不可以每一輪都再解析一次')
  })

  test('壞檔改過之後（size 變了）還是要再試一次', t => {
    const s = sandbox(t, { '壞的.pdf': '%PDF-1.7\n這不是真的 PDF\n' })
    s.scan()
    assert.ok(s.textOf('壞的.pdf').reason)
    s.copy('壞的.pdf', join(FIX, 'pdf-text', 'lecture.pdf'))
    const reader = s.counted()
    s.scan({ textReader: reader })
    assert.equal(reader.count(), 1)
    assert.equal(s.textOf('壞的.pdf').reason, null)
    assert.equal(s.textOf('壞的.pdf').has_text, 1)
  })
})

// ═══ 8 ・ 一批最多 60 個 ═════════════════════════════════════

describe('8 ・ 一批最多 MAX_TEXT_BATCH 個，scan 講得出還剩幾個', () => {
  test('65 個 .txt：第一輪讀 60、回 5；第二輪讀 5、回 0', t => {
    const s = sandbox(t)
    const n = MAX_TEXT_BATCH + 5
    for (let i = 0; i < n; i++) s.put(`講義-${String(i).padStart(3, '0')}.txt`, `第 ${i} 章 作業系統\n`)
    const r1 = s.counted()
    const first = s.scan({ textReader: r1 })
    assert.equal(r1.count(), MAX_TEXT_BATCH)
    assert.equal(first.textsPending, 5)
    const r2 = s.counted()
    const second = s.scan({ textReader: r2 })
    assert.equal(r2.count(), 5)
    assert.equal(second.textsPending, 0)
    const done = s.db.prepare('SELECT count(*) n FROM file_texts').get().n
    assert.equal(done, n)
  })

  test('都讀完的時候 textsPending 是 0', t => {
    const s = sandbox(t, { '講義.txt': '作業系統\n' })
    assert.equal(s.scan().textsPending, 0)
  })
})

// ═══ 9 ・ 不可以有絕對路徑、/health 不可以多東西 ══════════════

describe('9 ・ 回給畫面的東西', () => {
  test('scan 的回傳只有數字，problems 不帶完整路徑', t => {
    const s = sandbox(t, { '講義.txt': '作業系統 第 5 章\n', '壞的.pdf': 'not a pdf at all' })
    const r = s.scan()
    assert.deepEqual(Object.keys(r).sort(),
      ['candidates', 'errors', 'imagesPending', 'scanned', 'skipped', 'textsPending', 'truncated'])
    for (const v of Object.values(r)) assert.ok(typeof v === 'number' || typeof v === 'boolean')
    for (const m of s.problems) {
      assert.ok(!m.includes(s.dl), `problem 帶了路徑：${m}`)
      assert.ok(!m.includes(s.dir), `problem 帶了路徑：${m}`)
    }
  })

  test('免 token 的 /health 不會多出檔名或內容', t => {
    const s = sandbox(t, { '作業系統_第5章_行程排程.txt': '作業系統 第 5 章 行程排程　FCFS\n' })
    s.scan()
    const opts = { roots: [s.dl], quarantine: join(s.dir, 'q'), maxBytes: MAX_BYTES }
    const lean = JSON.stringify(healthSnapshot(s.db, { ...opts, full: false }))
    assert.ok(!lean.includes('作業系統'), '免 token 那份出現了檔名或內容')
    assert.ok(!lean.includes('行程排程'))
    assert.ok(!lean.includes(s.dl))
    // 帶 token 的那份也只講資料夾，不講我們讀到的字
    const full = JSON.stringify(healthSnapshot(s.db, { ...opts, full: true }))
    assert.ok(!full.includes('FCFS'), '帶 token 的 /health 也不該有檔案內容')
  })
})

// ═══ 10 ・ worker 連續死 3 次 ════════════════════════════════

describe('10 ・ worker 連續死 MAX_WORKER_DEATHS 次就放棄這一輪', () => {
  test('全部都卡住：前 3 個記逾時，剩下的留到下一輪，掃描照常完成、記一條 problem', t => {
    const s = sandbox(t)
    const n = MAX_WORKER_DEATHS + 4
    for (let i = 0; i < n; i++) s.put(`卡住-${i}.txt`, `第 ${i} 份\n`)
    const reader = s.counted({ entry: BAD_WORKER, timeoutMs: 200 })
    const r = s.scan({ textReader: reader })
    assert.equal(r.scanned, n, '掃描要照常完成')
    assert.equal(reader.count(), MAX_WORKER_DEATHS, `只該試 ${MAX_WORKER_DEATHS} 次`)
    assert.equal(s.db.prepare('SELECT count(*) n FROM file_texts').get().n, MAX_WORKER_DEATHS)
    assert.equal(r.textsPending, n - MAX_WORKER_DEATHS, '剩下的要算進「還剩幾個沒讀」')
    const gaveUp = s.problems.filter(m => m.includes('連續失敗'))
    assert.equal(gaveUp.length, 1, `problems：${JSON.stringify(s.problems)}`)
    assert.ok(!gaveUp[0].includes(s.dl))
  })

  test('放棄只影響這一輪：下一輪換一個好的 worker 就讀得到', t => {
    const s = sandbox(t)
    for (let i = 0; i < MAX_WORKER_DEATHS + 2; i++) s.put(`卡住-${i}.txt`, `第 ${i} 份\n`)
    s.scan({ textReader: s.counted({ entry: BAD_WORKER, timeoutMs: 200 }) })
    // 換成正常的 worker：沒記過的那幾個讀得到（卡住過的已經記了逾時，不再重試）
    const good = s.counted()
    const r = s.scan({ textReader: good })
    assert.equal(good.count(), 2)
    assert.equal(r.textsPending, 0)
  })

  test('中間讀成功一次，連續就歸零（不是累計）', t => {
    const s = sandbox(t)
    // 檔名排序決定掃描順序：卡一次 → 好一個 → 卡一次 → 好一個 → 卡一次
    const order = ['1-卡住.txt', '2-好.txt', '3-卡住.txt', '4-好.txt', '5-卡住.txt', '6-好.txt']
    for (const n of order) s.put(n, '一些字\n')
    const reader = s.counted({ entry: BAD_WORKER, timeoutMs: 200 })
    const r = s.scan({ textReader: reader })
    assert.equal(reader.count(), order.length, '連續次數歸零的話，六個檔都要試到')
    assert.equal(r.textsPending, 0)
    assert.equal(s.problems.filter(m => m.includes('連續失敗')).length, 0)
    for (const n of ['2-好.txt', '4-好.txt', '6-好.txt']) assert.equal(s.textOf(n).reason, null)
    for (const n of ['1-卡住.txt', '3-卡住.txt', '5-卡住.txt']) assert.equal(s.textOf(n).reason, TEXT_REASON.timeout)
  })
})

// ═══ 存的形狀：截斷、種類、上限 ═══════════════════════════════

describe('存起來的樣子', () => {
  test('超過 4000 字：截斷、標 truncated、chars 記原本讀到幾個字', t => {
    const s = sandbox(t)
    // 一個字一行，總共 6000 個字（遠超過存的上限、但沒超過讀的上限）
    const body = Array.from({ length: 3000 }, (_, i) => `第${i}行`).join('\n')
    s.put('長講義.txt', body)
    s.scan()
    const row = s.textOf('長講義.txt')
    assert.equal(row.truncated, 1)
    assert.equal([...row.text].length, STORE_MAX_CHARS)
    assert.ok(row.chars > STORE_MAX_CHARS, `chars 是 ${row.chars}`)
    assert.ok(row.chars <= READ_MAX_CHARS)
    assert.ok(body.startsWith(row.text), '截斷要從頭留')
  })

  test('剛好 4000 字：不標 truncated', t => {
    const s = sandbox(t)
    s.put('剛好.txt', 'A'.repeat(STORE_MAX_CHARS))
    s.scan()
    const row = s.textOf('剛好.txt')
    assert.equal(row.chars, STORE_MAX_CHARS)
    assert.equal(row.truncated, 0)
    assert.equal(row.text.length, STORE_MAX_CHARS)
  })

  test('截斷不會切在代理對中間（emoji 照樣是完整的字）', t => {
    const s = sandbox(t)
    s.put('表情.txt', '🙂'.repeat(STORE_MAX_CHARS + 100))
    s.scan()
    const row = s.textOf('表情.txt')
    assert.equal([...row.text].length, STORE_MAX_CHARS)
    // 完整的 emoji 結尾本來就是低代理；不可以出現的是**落單的高代理**
    assert.ok(!/[\ud800-\udbff]$/.test(row.text), '結尾不可以是半個代理對')
    assert.equal(row.text, '🙂'.repeat(STORE_MAX_CHARS))
  })

  test('Word 與 PowerPoint 的 kind 與內容', t => {
    const s = sandbox(t)
    s.copy('課程筆記.docx', join(FIX, 'office-text', 'course-notes.docx'))
    s.copy('投影片.pptx', join(FIX, 'office-text', 'lecture.pptx'))
    s.scan()
    const docx = s.textOf('課程筆記.docx')
    assert.equal(docx.kind, 'docx')
    assert.equal(docx.reason, null)
    assert.equal(docx.has_text, 1)
    assert.ok(docx.chars > 0)
    const pptx = s.textOf('投影片.pptx')
    assert.equal(pptx.kind, 'pptx')
    assert.equal(pptx.reason, null)
    assert.equal(pptx.has_text, 1)
    assert.equal(pptx.pages, null, 'pages 照 DDL 只給 PDF')
  })

  test('加密的 .docx：讀不懂，不是整輪失敗', t => {
    const s = sandbox(t, { '講義.txt': '作業系統\n' })
    s.copy('加密.docx', join(FIX, 'office-text', 'encrypted.docx'))
    const r = s.scan()
    assert.equal(r.scanned, 2)
    assert.equal(s.textOf('加密.docx').reason, TEXT_REASON.unreadable)
    assert.equal(s.textOf('講義.txt').reason, null)
  })

  test('Big5 的 .csv 讀得對（編碼判斷是上游的事，這裡只確認接線有接上）', t => {
    const s = sandbox(t)
    s.copy('銷售.csv', join(FIX, 'office-text', 'big5-sales.csv'))
    s.scan()
    const row = s.textOf('銷售.csv')
    assert.equal(row.kind, 'text')
    assert.equal(row.reason, null)
    const expected = readFileSync(join(FIX, 'office-text', 'big5-sales.expected.txt'), 'utf8')
    assert.ok(expected.startsWith(row.text) || row.text.startsWith(expected.slice(0, 50)),
      `讀到的字對不上：${row.text.slice(0, 60)}`)
  })

  test('只讀這六類副檔名，大小寫不管', t => {
    assert.deepEqual([...TEXT_EXTS].sort(), ['.csv', '.docx', '.md', '.pdf', '.pptx', '.txt'])
    assert.equal(kindOfExt('.PDF'), 'pdf')
    assert.equal(kindOfExt('.md'), 'text')
    for (const ext of ['.zip', '.png', '.exe', '.json', '.doc', '.ppt', '.rtf', '']) {
      assert.equal(kindOfExt(ext), null, ext)
    }
  })

  test('大寫副檔名的檔照樣讀得到', t => {
    const s = sandbox(t, { '講義.TXT': '作業系統 第 5 章\n' })
    s.scan()
    assert.match(s.textOf('講義.TXT').text, /第 5 章/)
  })
})

// ═══ worker 的設定 ═══════════════════════════════════════════

describe('worker 的上限', () => {
  test('heap 上限不低於 256 MB（pdf-text 的合法輸入要得到這麼多）', () => {
    assert.ok(WORKER_HEAP_MB >= 256)
  })

  test('每個檔 5 秒', () => {
    assert.equal(FILE_TIMEOUT_MS, 5000)
  })

  test('heapMb 傳更小的數字也拉不下來', t => {
    const r = createTextReader({ heapMb: 16 })
    t.after(() => r.close())
    const got = r.read({ path: join(FIX, 'pdf-text', 'lecture.pdf'), kind: 'pdf', dev: 0, ino: 0, size: 0, mtimeMs: 0 })
    // 身分對不上（故意的），重點是它活著回答了
    assert.equal(got.status, 'changed')
  })

  test('主執行緒被一個卡住的檔擋住的時間，不超過設定的上限', t => {
    const r = createTextReader({ entry: BAD_WORKER, timeoutMs: 300 })
    t.after(() => r.close())
    const { out, took } = timed(() => r.read({
      path: '/不存在/卡住.pdf', kind: 'pdf', dev: 1, ino: 1, size: 1, mtimeMs: 1,
    }))
    assert.equal(out.status, 'dead')
    assert.equal(out.reason, TEXT_REASON.timeout)
    // 冷開 worker 約 0.2 秒，放寬到 4 倍；重點是「有上限」不是「剛剛好」
    assert.ok(took < 300 * 4 + 2000, `擋了 ${took.toFixed(0)} ms`)
  })

  test('整個行程共用的那一個：拿得到、收得掉、收掉之後再拿是新的', t => {
    t.after(() => closeTextReader())
    const a = textReader()
    assert.equal(textReader(), a, '同一個行程要共用同一個')
    const got = a.read({ path: join(FIX, 'pdf-text', 'lecture.pdf'), kind: 'pdf', dev: 0, ino: 0, size: 0, mtimeMs: 0 })
    assert.equal(got.status, 'changed')
    closeTextReader()
    assert.notEqual(textReader(), a)
  })

  test('worker 根本開不起來：回「這個檔讀不到」，不是把例外丟給掃描', t => {
    // new Worker() 有一整排會**同步**丟錯的理由（進入點型別不對、execArgv 不合、開不出 thread）。
    // 丟出去的話，一個檔就會讓整輪掃描失敗。
    const r = createTextReader({ entry: 123, timeoutMs: 200 })
    t.after(() => r.close())
    const got = r.read({ path: '/不存在/a.txt', kind: 'text', dev: 1, ino: 1, size: 1, mtimeMs: 1 })
    assert.equal(got.status, 'dead')
    assert.equal(r.deaths(), 1)
  })

  test('掃描中 worker 開不起來，掃描照常完成；**那幾個檔不記成讀不到**（下一輪要重試）', t => {
    const s = sandbox(t, { '講義.txt': '作業系統 第 5 章\n', '筆記.md': '# 死結\n' })
    const reader = s.counted({ entry: 123, timeoutMs: 200 })
    const r = s.scan({ textReader: reader })
    assert.equal(r.scanned, 2)
    // **改過的答案**：開不起來是環境的事（thread 開不出來、Node 旗標不合），不是這個檔讀不懂。
    // 以前記成「逾時」，那幾個檔就永久停在讀不到、再也不會重試（P1 驗證員）。
    assert.equal(s.textOf('講義.txt'), null, '不可以把環境問題記在檔上')
    // 換一個好的 reader 再掃一次：照樣讀得到
    const again = s.scan()
    assert.equal(again.scanned, 2)
    assert.match(s.textOf('講義.txt').text, /行程排程|第 5 章/)
  })

  test('父行程用 `node --input-type=module -e` 跑也讀得到（worker 不繼承那個旗標）', t => {
    // worker 會繼承 execArgv。--input-type 對「進入點是一個檔」的 worker 是致命的：
    // 它一開起來就死，呼叫端只看得到「等不到回應」—— 每個檔白等 5 秒，而且沒有任何錯誤訊息。
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-argv-')))
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'cb-argv-home-')))
    t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) })
    const dl = join(dir, 'Downloads')
    mkdirSync(dl)
    writeFileSync(join(dl, '講義.txt'), '作業系統 第 5 章 行程排程\n')
    const script = `
      import { open } from ${JSON.stringify(join(REPO, 'core/db.ts'))}
      import { scanDownloads } from ${JSON.stringify(join(REPO, 'core/cleanup-scanner.ts'))}
      import { fileTextByPath } from ${JSON.stringify(join(REPO, 'core/file-texts.ts'))}
      const db = open(${JSON.stringify(join(dir, 'data.db'))})
      scanDownloads({ db, roots: [${JSON.stringify(dl)}], maxBytes: ${MAX_BYTES}, minStableMs: 0 })
      console.log(JSON.stringify(fileTextByPath(db, ${JSON.stringify(join(dl, '講義.txt'))})))
    `
    const env = { ...process.env, HOME: home, USERPROFILE: home }
    for (const k of ['CONTEXTBOX_CONFIG', 'CONTEXTBOX_DB', 'CONTEXTBOX_QUARANTINE', 'CONTEXTBOX_TOKEN_PATH']) delete env[k]
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script],
      { encoding: 'utf8', env, timeout: 60_000 })
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
    const row = JSON.parse(r.stdout.trim().split('\n').pop())
    assert.equal(row.reason, null, `worker 在 --input-type 底下沒活下來：${JSON.stringify(row)}`)
    assert.match(row.text, /行程排程/)
  })

  test('worker 死掉之後會重開，不是從此不能用', t => {
    const r = createTextReader({ entry: BAD_WORKER, timeoutMs: 300 })
    t.after(() => r.close())
    const dead = r.read({ path: '/不存在/卡住.pdf', kind: 'pdf', dev: 1, ino: 1, size: 1, mtimeMs: 1 })
    assert.equal(dead.status, 'dead')
    assert.equal(r.deaths(), 1)
    const again = r.read({ path: '/不存在/一般.pdf', kind: 'pdf', dev: 1, ino: 1, size: 1, mtimeMs: 1 })
    assert.equal(again.status, 'changed', '新的 worker 要接得上')
    assert.equal(r.deaths(), 0)
  })
})

// ═══ 讀檔本身（不經過 worker） ═══════════════════════════════

describe('runTextJob（worker 裡跑的那一段，直接呼叫）', () => {
  function job(t, name, content, over = {}) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-job-')))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const p = join(dir, name)
    writeFileSync(p, content)
    const st = statSync(p)
    return {
      path: p, kind: 'text', maxChars: READ_MAX_CHARS, keep: STORE_MAX_CHARS,
      dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ...over,
    }
  }

  test('身分對不上（掃描到現在被換掉了）→ changed，什麼都不回', t => {
    const j = job(t, 'a.txt', '一些字')
    assert.deepEqual(runTextJob({ ...j, size: j.size + 1 }), { changed: true })
    assert.deepEqual(runTextJob({ ...j, mtimeMs: j.mtimeMs + 1000 }), { changed: true })
  })

  test('檔不見了 → changed（不是丟錯）', t => {
    const j = job(t, 'a.txt', '一些字')
    assert.deepEqual(runTextJob({ ...j, path: j.path + '.不存在' }), { changed: true })
  })

  test('目錄、不是一般檔 → changed', t => {
    const j = job(t, 'a.txt', '一些字')
    assert.deepEqual(runTextJob({ ...j, path: dirname(j.path) }), { changed: true })
    // **身分完全對得上的目錄**：只有「是不是一般檔」這一項擋得住它。
    // 上一版沒有這個例子，把 st.isFile() 拿掉照樣綠（突變測試抓到的）。
    const dir = dirname(j.path)
    const st = statSync(dir)
    assert.deepEqual(runTextJob({
      ...j, path: dir, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs,
    }), { changed: true })
  })

  test('保證不丟例外：kind 亂給、參數是垃圾都只會回一個答案', t => {
    const j = job(t, 'a.txt', '一些字')
    for (const bad of [{ kind: '???' }, { maxChars: -1 }, { keep: -1 }, { keep: 0 }]) {
      const got = runTextJob({ ...j, ...bad })
      assert.ok(got && (got.ok === true || got.ok === false || got.changed === true), JSON.stringify(bad))
    }
    assert.ok(runTextJob({}))
    assert.ok(runTextJob(null))
  })

  test('純文字檔只讀開頭：20 MB 的 .csv 也回得來，而且標 truncated', t => {
    const j = job(t, 'big.csv', Buffer.from('資料,欄位\n'.repeat(1_200_000)))
    assert.ok(j.size > 10 * MB, `檔案只有 ${j.size} byte`)
    const { took, out } = timed(() => runTextJob(j))
    assert.equal(out.ok, true)
    assert.equal(out.truncated, true)
    assert.equal([...out.text].length, STORE_MAX_CHARS)
    assert.ok(took < 2000, `讀了 ${took.toFixed(0)} ms —— 應該只讀開頭那幾十 KB`)
  })
})

// ═══ 資料庫：新表、遷移、收掉舊資料 ═══════════════════════════

describe('資料庫', () => {
  test('file_texts 的欄位就是預想表的 DDL', t => {
    const s = sandbox(t)
    const cols = s.db.prepare('PRAGMA table_info(file_texts)').all().map(c => c.name)
    assert.deepEqual(cols,
      ['item_id', 'kind', 'text', 'chars', 'truncated', 'has_text', 'pages', 'unmapped', 'reason', 'size', 'mtime', 'at'])
  })

  test('打錯的 kind 進不去（合法值寫在資料庫裡，不是只寫在型別註解裡）', t => {
    const s = sandbox(t, { '講義.txt': '作業系統\n' })
    s.scan()
    const id = s.itemOf('講義.txt').id
    assert.throws(() => s.db.prepare(
      `INSERT INTO file_texts (item_id,kind,chars,truncated,has_text,size,mtime,at)
       VALUES (?,?,?,?,?,?,?,?)`).run(id + '-x', '打錯的kind', 0, 0, 0, 0, 't', 't'))
  })

  test('naming 打錯也進不去', t => {
    const s = sandbox(t)
    assert.throws(() => s.db.prepare(
      `INSERT INTO file_items (id,path,name,ext,bytes,mtime,first_seen_at,last_seen_at,status,naming)
       VALUES (?,?,?,?,?,?,?,?,?,?)`).run('x', '/p/x', 'x', '.x', 0, 't', 't', 't', 'new', '打錯的'))
  })

  test('**舊的資料庫升級不可以壞**：沒有 naming 欄位的 file_items 補得上，舊的列還在', t => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-mig-')))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'old.db')
    // P1 之前的 file_items（沒有 naming／naming_why），塞一列進去
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE file_items (
      id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, ext TEXT NOT NULL,
      bytes INTEGER NOT NULL, sha256 TEXT, mtime TEXT NOT NULL, first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL, status TEXT NOT NULL, error TEXT)`)
    old.prepare(`INSERT INTO file_items (id,path,name,ext,bytes,mtime,first_seen_at,last_seen_at,status)
                 VALUES (?,?,?,?,?,?,?,?,?)`).run('old-1', '/舊/報告.pdf', '報告.pdf', '.pdf', 7, 't', 't', 't', 'kept')
    old.close()

    const db = open(path)
    t.after(() => db.close())
    const cols = db.prepare('PRAGMA table_info(file_items)').all().map(c => c.name)
    assert.ok(cols.includes('naming') && cols.includes('naming_why'), `欄位：${cols.join(',')}`)
    const row = db.prepare('SELECT * FROM file_items WHERE id=?').get('old-1')
    assert.equal(row.name, '報告.pdf', '舊的列不可以不見')
    assert.equal(row.naming, null, '舊的列補上來就是 NULL，下一次掃到它才會填')
    // file_texts 是新表，升級之後要在
    assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_texts'`).get())
  })

  test('升級跑兩次也不會壞（同一個資料庫再 open 一次）', t => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-mig2-')))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'twice.db')
    const a = open(path)
    a.close()
    const b = open(path)
    t.after(() => b.close())
    assert.equal(b.prepare('PRAGMA table_info(file_items)').all().filter(c => c.name === 'naming').length, 1)
  })

  test('檔案被搬進隔離區、或不見了，存的內容跟著收掉', t => {
    const s = sandbox(t, { '講義.txt': '作業系統 第 5 章\n' })
    s.scan()
    const id = s.itemOf('講義.txt').id
    assert.ok(fileTextOf(s.db, id))
    s.db.prepare(`UPDATE file_items SET status='quarantined' WHERE id=?`).run(id)
    s.scan()
    assert.equal(fileTextOf(s.db, id), null, '不在原位的檔不用一直留著它的內容')
  })

  test('留幾列有上限', () => {
    assert.ok(MAX_FILE_TEXTS >= 1000 && MAX_FILE_TEXTS <= 20000)
  })
})

// ═══ P1 驗證員抓到的三條（合併時修）═══════════════════════════════

describe('驗證員抓到的', () => {
  test('純二進位垃圾不算「有文字」，也不會被存下來當成內容', t => {
    const s = sandbox(t)
    // 一個 .txt，內容全是 NUL 與控制字元（把二進位檔改成 .txt 的情況）
    s.put('假的.txt', Buffer.from(Array.from({ length: 4000 }, (_, i) => i % 7 === 0 ? 0 : 1)))
    s.put('真的.txt', '作業系統 第 5 章 行程排程\n')
    s.scan()
    const fake = s.textOf('假的.txt')
    assert.equal(fake.has_text, 0, '全是控制字元不算有文字（不然 P2 會拿垃圾去問模型）')
    const real = s.textOf('真的.txt')
    assert.equal(real.has_text, 1)
    assert.match(real.text, /行程排程/)
  })

  test('對照：中文、emoji、tab 與換行都算有文字', t => {
    const s = sandbox(t)
    s.put('正常.txt', '第一行\t有 tab\n第二行 📄 有 emoji\n')
    s.scan()
    assert.equal(s.textOf('正常.txt').has_text, 1)
  })

  test('watcher 的單檔掃描不讀內容（那條路跑在 pet 的主執行緒上）', t => {
    const s = sandbox(t, { '講義.txt': '作業系統 第 5 章\n' })
    const reader = s.counted()
    const one = s.scan({ paths: [join(s.dl, '講義.txt')], textReader: reader })
    assert.equal(one.scanned, 1, '前提：單檔模式真的掃到了')
    assert.equal(reader.count(), 0, '單檔模式不可以叫 worker：一個惡意檔會讓面板卡住')
    assert.equal(s.textOf('講義.txt'), null)
    // 完整掃描才讀
    s.scan({ textReader: reader })
    assert.equal(reader.count(), 1)
    assert.match(s.textOf('講義.txt').text, /第 5 章/)
  })

  test('一批最多 60 個，剩下的下一輪（**把常數改大就會紅**）', t => {
    // 既有的那條測試用常數自己算張數，所以把 60 改成 600 照樣綠（P1 驗證員）。
    // 這裡把數字寫死：上限是產品決定（一批約 2 秒），不是「程式現在寫什麼就是什麼」。
    assert.equal(MAX_TEXT_BATCH, 60, '一批的上限是 60：改這個數字要連這條測試一起改')
    const s = sandbox(t)
    for (let i = 0; i < MAX_TEXT_BATCH + 5; i++) s.put(`doc-${String(i).padStart(3, '0')}.txt`, `第 ${i} 份講義\n`)
    const reader = s.counted()
    const first = s.scan({ textReader: reader })
    assert.equal(reader.count(), MAX_TEXT_BATCH, `一批只讀 ${MAX_TEXT_BATCH} 個`)
    assert.equal(first.textsPending, 5, '剩下的要講出來')
    const second = s.scan({ textReader: reader })
    assert.equal(reader.count(), MAX_TEXT_BATCH + 5, '下一輪接著讀')
    assert.equal(second.textsPending, 0)
  })
})
