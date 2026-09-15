/**
 * D 的唯讀層測試。
 *
 * **這些測試是在實作之前寫的**，每一條都對應
 * ~/contextbox-預想-20260915.md 裡 Step 1 表格的一列。
 * 預期答案在寫實作之前就定死了，不是照著實作抄出來的。
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open } from '../core/db.ts'
import { scanDownloads } from '../core/cleanup-scanner.ts'
import { listCandidates, healthSnapshot, DEFAULT_CHECK_MIN, KIND_CONFIDENCE } from '../core/cleanup-routes.ts'

const DAY = 24 * 60 * 60 * 1000

let root, dl, db

before(() => { root = mkdtempSync(join(tmpdir(), 'cb-routes-')) })
after(() => rmSync(root, { recursive: true, force: true }))

let n = 0
beforeEach(() => {
  dl = join(root, 'case' + n++, 'Downloads')
  mkdirSync(dl, { recursive: true })
  db = open(':memory:')
})

/**
 * 放一個檔，並把 mtime 調到 N 天前。
 *
 * **內容預設要不一樣。** 第一版讓每個檔都是 'x'，結果它們互為重複檔，
 * duplicate(98) 蓋掉所有其他規則，三條測試莫名其妙紅掉。
 */
function put(name, { days = 0, content = null, dir = null } = {}) {
  content = content === null ? `獨一無二的內容：${name}` : content
  const d = dir ? join(dl, dir) : dl
  mkdirSync(d, { recursive: true })
  const p = join(d, name)
  writeFileSync(p, content)
  const t = (Date.now() - days * DAY) / 1000
  utimesSync(p, t, t)
  return p
}

/** 跑一次 A 的 scanner，然後回傳我們組出來的清單 */
function scanAndList(opts = {}) {
  scanDownloads({ db, roots: [dl], maxBytes: 20 * 1024 * 1024, minStableMs: 0, ...opts })
  return listCandidates(db, { roots: [dl] })
}

const byName = (r, name) => r.candidates.find(c => c.name === name)

// ── A1：預設勾選的門檻 ───────────────────────────────────────
describe('A1 預設勾選的門檻', () => {
  test('中信心也要預設勾 —— 不然 spec 第 0 節那句「點同意就乾淨」不成立', () => {
    // demo 主線明寫 .zip 與安裝包都在「點一次同意就清掉」的範圍裡
    put('素材包.zip', { days: 60 })          // archive 65
    put('NodeSetup.msi', { days: 30 })       // installer 70
    const r = scanAndList()

    assert.equal(byName(r, '素材包.zip').defaultChecked, true, 'archive(65) 要預設勾')
    assert.equal(byName(r, 'NodeSetup.msi').defaultChecked, true, 'installer(70) 要預設勾')
  })

  test('低信心不勾', () => {
    put('很舊的東西.bin', { days: 200 })                        // old-download 35
    put('Screenshot 2026-01-02 141203.png', { days: 120 })     // screenshot-noise 35
    const r = scanAndList()

    assert.equal(byName(r, '很舊的東西.bin').defaultChecked, false)
    assert.equal(byName(r, 'Screenshot 2026-01-02 141203.png').defaultChecked, false)
  })

  test('高信心當然勾', () => {
    put('半個檔.iso.crdownload', { days: 3 })   // partial 95
    put('空的.log', { days: 3, content: '' })   // empty 95
    const r = scanAndList()

    assert.equal(byName(r, '半個檔.iso.crdownload').defaultChecked, true)
    assert.equal(byName(r, '空的.log').defaultChecked, true)
  })

  test('門檻落在 35 與 65 之間，兩邊各有餘裕', () => {
    // 之後調規則的信心值時，這條會擋住意外翻邊
    assert.ok(DEFAULT_CHECK_MIN > 35, '不可以把低信心也勾起來')
    assert.ok(DEFAULT_CHECK_MIN <= 65, '不可以把中信心排除掉')
  })
})

describe('A1b 新增 kind 不可以靜悄悄變成預設勾', () => {
  test('每一種 kind 的預設勾選狀態都要被列舉過一次', () => {
    // 獨立重推點出的缺口：以後有人加一條新規則給 55 分，
    // 它會安靜地變成預設勾，沒有人審過。這條測試會逼他做決定。
    const EXPECTED = {
      duplicate: true, partial: true, empty: true, temp: true,
      installer: true, archive: true,
      'old-download': false, 'screenshot-noise': false,
    }
    const seen = new Set()
    for (const [kind, want] of Object.entries(EXPECTED)) {
      const conf = KIND_CONFIDENCE[kind]
      assert.ok(conf !== undefined, `${kind} 在 cleanup-rules.ts 裡找不到信心值`)
      assert.equal(conf >= DEFAULT_CHECK_MIN, want,
        `${kind}（${conf}）的預設勾選狀態跟規格對不上`)
      seen.add(kind)
    }
    for (const kind of Object.keys(KIND_CONFIDENCE)) {
      assert.ok(seen.has(kind),
        `cleanup-rules.ts 多了一個 kind「${kind}」，但沒有人決定過它要不要預設勾。` +
        '請在這條測試的 EXPECTED 裡補上，並在 spec 第 5 節的表補一列。')
    }
  })
})

// ── A2：一個檔命中多條規則 ───────────────────────────────────
describe('A2 一個檔命中多條規則', () => {
  test('回一列，不是兩列', () => {
    // 90 天沒動的 zip 同時是 archive(65) 與 old-download(35)
    put('又舊又是壓縮檔.zip', { days: 200 })
    const r = scanAndList()

    const hits = r.candidates.filter(c => c.name === '又舊又是壓縮檔.zip')
    assert.equal(hits.length, 1, '同一個檔在 UI 上出現兩次就是 bug')
    assert.ok(hits[0].reasons.length >= 2, '兩條規則的理由都要留著')
  })

  test('勾選用最高信心那條決定', () => {
    put('又舊又是壓縮檔.zip', { days: 200 })
    const c = byName(scanAndList(), '又舊又是壓縮檔.zip')

    assert.equal(c.confidence, 65, 'archive(65) 比 old-download(35) 高')
    assert.equal(c.defaultChecked, true)
    assert.equal(c.reasons[0].confidence, 65, 'reasons 要由高到低排')
  })

  test('建 plan 要送這個檔的全部 candidate id', () => {
    put('又舊又是壓縮檔.zip', { days: 200 })
    const c = byName(scanAndList(), '又舊又是壓縮檔.zip')

    assert.ok(Array.isArray(c.candidateIds))
    assert.equal(c.candidateIds.length, c.reasons.length,
      '聚合成一列之後，底下每一筆 candidate 都要送得出去，不然 B 會漏處理')
  })
})

// ── A3：duplicate 要說留哪一份 ───────────────────────────────
describe('A3 duplicate 要說留哪一份', () => {
  test('evidence 指名留著的那一份，不能只說「還有 N 份」', () => {
    // 使用者沒辦法確認「我還留著一份」的話，這張卡就不敢勾
    put('report.pdf', { days: 5, content: '一模一樣的內容' })
    put('report (1).pdf', { days: 5, content: '一模一樣的內容' })
    const r = scanAndList()

    const dup = r.candidates.find(c => c.kind === 'duplicate')
    assert.ok(dup, '要有一筆 duplicate')

    // **不斷言留的是哪一個檔名。** A 是照 path 字典序決定留誰，
    // 所以 `report (1).pdf` 反而會贏過 `report.pdf`（'(' < '.'）。
    // 那是 UX 上的瑕疵，已經回報給 A，但不是這一層能修的。
    // 這裡要守住的性質是：**使用者看得出還有一份活著、而且是哪一份。**
    const survivor = ['report.pdf', 'report (1).pdf'].find(n => n !== dup.name)
    assert.match(dup.reasons[0].evidence, new RegExp(survivor.replace(/[()]/g, '\\$&')),
      'evidence 要指名留著的是哪一個檔，不然使用者不敢勾')
    assert.match(dup.reasons[0].evidence, /會留著/)
  })

  test('留著的那一份不會自己也變成候選', () => {
    put('report.pdf', { days: 5, content: '一樣' })
    put('report (1).pdf', { days: 5, content: '一樣' })
    const r = scanAndList()

    assert.equal(r.candidates.filter(c => c.kind === 'duplicate').length, 1,
      '兩份都變候選的話，全勾會把兩份都清掉 —— 那是資料遺失')
  })
})

// ── A4：保護副檔名怎麼跟信心互動 ─────────────────────────────
describe('A4 保護副檔名', () => {
  test('保護副檔名 + 高信心 → 勾（0 byte 的 .txt 沒有東西可以失去）', () => {
    put('新增文字文件.txt', { days: 3, content: '' })
    assert.equal(byName(scanAndList(), '新增文字文件.txt').defaultChecked, true)
  })

  test('保護副檔名 + 低信心 → 不勾', () => {
    put('很舊的合約.pdf', { days: 200 })
    const c = byName(scanAndList(), '很舊的合約.pdf')
    // spec：老檔規則本來就排除保護副檔名，所以這個檔要嘛不出現、要嘛不勾
    if (c) assert.equal(c.defaultChecked, false)
  })
})

// ── A5：spec 表上沒有的 kind ─────────────────────────────────
describe('A5 spec 表上沒有 temp 這個 kind', () => {
  test('不會讓回應壞掉，而且當高信心處理', () => {
    put('暫存.tmp', { days: 10 })   // temp 規則要 days >= 7
    const c = byName(scanAndList(), '暫存.tmp')
    assert.ok(c, 'temp 也要出現在清單裡')
    assert.equal(c.defaultChecked, true, 'temp 的信心是 85')
  })
})

// ── B：路徑不外洩 ────────────────────────────────────────────
describe('B 路徑不可以外洩到 UI', () => {
  test('整包回應裡不可以出現絕對路徑', () => {
    put('a.zip', { days: 60 })
    put('b.crdownload', { days: 3 })
    put('c.tmp', { days: 10, dir: '2026/09' })
    const r = scanAndList()

    const json = JSON.stringify(r)
    assert.ok(!json.includes(dl), `回應裡出現了 watch root：${dl}`)
    assert.ok(!json.includes(root), '回應裡出現了暫存根目錄')
  })

  test('子目錄用 subdir 表示，root 底下的是空字串', () => {
    put('在根目錄.zip', { days: 60 })
    put('在子目錄.zip', { days: 60, dir: join('2026', '09') })
    const r = scanAndList()

    assert.equal(byName(r, '在根目錄.zip').subdir, '')
    assert.equal(byName(r, '在子目錄.zip').subdir.replace(/\\/g, '/'), '2026/09')
  })

  test('folder 只給最後一段，不給整條路徑', () => {
    put('x.zip', { days: 60 })
    const c = byName(scanAndList(), 'x.zip')
    assert.equal(c.folder, 'Downloads')
  })

  test('讀不到的檔案也不可以把路徑洩漏出去', () => {
    put('x.zip', { days: 60 })
    db.prepare(
      `INSERT INTO file_items (id,path,name,ext,bytes,mtime,first_seen_at,last_seen_at,status,error)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run('bad1', join(dl, 'private', '機密.pdf'), '機密.pdf', '.pdf', 100,
          new Date().toISOString(), new Date().toISOString(), new Date().toISOString(),
          'error', '權限不足')
    const r = listCandidates(db, { roots: [dl] })

    assert.ok(!JSON.stringify(r).includes(dl), '錯誤項目把路徑帶出來了')
    assert.ok(r.needsHuman.some(x => x.name === '機密.pdf'), '讀不到的檔要讓使用者知道')
  })
})

// ── 守恆性質 ─────────────────────────────────────────────────
describe('性質：守恆', () => {
  test('回的列數 == proposed 候選的相異 item 數', () => {
    put('a.zip', { days: 60 })
    put('b.crdownload', { days: 3 })
    put('又舊又是壓縮檔.zip', { days: 200 })    // 命中兩條規則
    put('c.tmp', { days: 10 })
    const r = scanAndList()

    const distinct = db.prepare(
      `SELECT count(DISTINCT item_id) n FROM cleanup_candidates WHERE status='proposed'`
    ).get().n
    assert.equal(r.candidates.length, distinct)
    assert.equal(r.total, distinct)
  })

  test('bytes 是相異檔案的大小總和，不會因為多條規則被算兩次', () => {
    put('又舊又是壓縮檔.zip', { days: 200, content: 'x'.repeat(1000) })
    const r = scanAndList()
    assert.equal(r.bytes, 1000)
  })
})

// ── health ───────────────────────────────────────────────────
describe('health', () => {
  test('沒跑過 watcher 的時候講實話', () => {
    const h = healthSnapshot(db, { roots: [dl], quarantine: join(root, 'q') })
    assert.equal(h.watcher.ok, false)
    assert.equal(h.pendingCandidates, 0)
    assert.equal(h.quarantine.items, 0)
  })

  test('待清候選數要對得上', () => {
    put('a.zip', { days: 60 })
    put('b.crdownload', { days: 3 })
    scanDownloads({ db, roots: [dl], maxBytes: 2e7, minStableMs: 0 })
    const h = healthSnapshot(db, { roots: [dl], quarantine: join(root, 'q') })
    assert.equal(h.pendingCandidates, 2)
  })

  test('health 也不可以洩漏絕對路徑', () => {
    put('a.zip', { days: 60 })
    scanDownloads({ db, roots: [dl], maxBytes: 2e7, minStableMs: 0 })
    const h = healthSnapshot(db, { roots: [dl], quarantine: join(root, 'q') })
    assert.ok(!JSON.stringify(h).includes(dl))
  })
})

// ── Step 4：結構化隨機 ───────────────────────────────────────
//
// 唯一值得寫的性質是「路徑不外洩」。純亂數沒用 —— 九成落在同一條
// 路徑上。種子要是**合法但刁鑽**的檔名。
describe('性質：路徑永遠不外洩（結構化隨機）', () => {
  test('各種刁鑽檔名都不會把絕對路徑帶出去', () => {
    const NAMES = [
      'a.zip', '素材包.zip', 'Screenshot 2026-01-02.png',
      'report (1).pdf', 'a b  c.tmp', '.hidden.zip',
      'ü-café.zip', '𠮷.zip', 'a%b.zip', 'a_b.zip',
      'x'.repeat(200) + '.zip',              // 極長
      'CON.zip', 'a.tar.gz',                 // Windows 保留名、雙副檔名
      'a..zip', '-leading.zip',
    ]
    const SUBDIRS = ['', '2026', join('2026', '09'), '很深/的/路徑', 'a b/c d']
    const AGES = [0, 1, 7, 14, 30, 31, 89, 90, 200]

    const hitKinds = new Set()
    let rows = 0

    // 每個名字配一個子目錄與年齡，覆蓋各分支
    for (let i = 0; i < NAMES.length; i++) {
      const name = NAMES[i]
      const sub = SUBDIRS[i % SUBDIRS.length]
      const days = AGES[i % AGES.length]
      try {
        put(name, { days, dir: sub || null, content: `內容-${i}` })
      } catch { continue }          // 檔名這個檔案系統不收，跳過
    }
    // 再補幾個一定會命中高信心規則的
    put('dup-a.bin', { days: 5, content: '一樣的' })
    put('dup-b.bin', { days: 5, content: '一樣的' })
    put('empty.log', { days: 3, content: '' })
    put('half.crdownload', { days: 3 })

    const r = scanAndList()
    rows = r.candidates.length
    for (const c of r.candidates) for (const x of c.reasons) hitKinds.add(x.kind)

    // ── 性質本體 ──
    const json = JSON.stringify(r)
    assert.ok(!json.includes(dl), '回應裡出現了監看資料夾的絕對路徑')
    assert.ok(!json.includes(root), '回應裡出現了暫存根目錄')
    assert.ok(!/(^|")[A-Za-z]:[\\/]/.test(json), '回應裡出現了 Windows 磁碟機路徑')
    for (const c of r.candidates) {
      assert.ok(!c.name.includes(sepOf(dl)), `name 不可以含路徑分隔符：${c.name}`)
      assert.ok(!c.subdir.startsWith('/') && !c.subdir.startsWith('\\'),
        `subdir 要是相對的：${c.subdir}`)
    }

    // ── 生成器驗收：真的走到有趣的路徑了嗎 ──
    assert.ok(rows >= 6, `只產出 ${rows} 列，生成器沒走到夠多分支`)
    for (const must of ['duplicate', 'empty', 'partial', 'archive']) {
      assert.ok(hitKinds.has(must),
        `沒有命中 ${must} —— 生成器壞了，先修生成器再看結論。命中的是：${[...hitKinds].join('、')}`)
    }
  })
})

function sepOf(p) { return p.includes('\\') ? '\\' : '/' }
