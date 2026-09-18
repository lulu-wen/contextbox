/**
 * D 的唯讀層測試。
 *
 * **這些測試是在實作之前寫的**，每一條都對應
 * ~/contextbox-預想-20260915.md 裡 Step 1 表格的一列。
 * 預期答案在寫實作之前就定死了，不是照著實作抄出來的。
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
import { randomUUID } from 'node:crypto'
import { CLEANUP_RULE_VERSION } from '../core/cleanup-rules.ts'
import { open } from '../core/db.ts'
import { scanDownloads } from '../core/cleanup-scanner.ts'
import { applyPlan } from '../core/cleanup-exec.ts'
import { createPlan } from '../core/cleanup-plans.ts'
import { fixture } from './helpers/cleanup.mjs'

const createPlanFor = (f) => createPlan(f.db)
import { listCandidates, healthSnapshot, safeWhy, displayPath, META,
         cleanupRoutes, invalidateQuarantineCache, canEmptyNow,
         DEFAULT_CHECK_MIN, KIND_CONFIDENCE, CLEANUP_KINDS } from '../core/cleanup-routes.ts'

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
    // **真值來源是 cleanup-rules.ts 匯出的 CLEANUP_KINDS**，不是用探針反推。
    // 第一版用一組寫死的探針輸入跑分類器來湊出這張表，結果新規則沒有
    // 對應探針就完全不會出現 —— 這道防線看不到自己看不到的東西。
    // 稽查實測：加一條 55 分的新規則，23 條測試全綠。
    for (const kind of CLEANUP_KINDS) {
      assert.ok(kind in EXPECTED,
        `cleanup-rules.ts 多了一個 kind「${kind}」，但沒有人決定過它要不要預設勾。` +
        '請在這條測試的 EXPECTED 裡補上，並在 spec 第 5 節的表補一列。')
      assert.equal(KIND_CONFIDENCE[kind] >= DEFAULT_CHECK_MIN, EXPECTED[kind],
        `${kind}（${KIND_CONFIDENCE[kind]}）的預設勾選狀態跟規格對不上`)
    }
    for (const kind of Object.keys(EXPECTED)) {
      assert.ok(CLEANUP_KINDS.includes(kind),
        `EXPECTED 裡的「${kind}」在 cleanup-rules.ts 已經不存在了，請一起刪掉`)
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
    // 原本寫成 `if (c) assert...`，而 c 永遠是 undefined ——
    // 條件斷言等於一個斷言都沒跑。改成斷言真正該成立的事。
    assert.equal(byName(scanAndList(), '很舊的合約.pdf'), undefined,
      '保護副檔名不該被低信心規則挑中，連出現都不該出現')
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
    // **這條原本是假綠的。** 第一版塞的 error 是「權限不足」——
    // 那個字串本來就沒有路徑，所以斷言不可能失敗。
    // 真實的 fs 錯誤長這樣，原文裡有完整路徑。
    const realFsError = `EACCES: permission denied, open '${join(dl, 'private', '機密.pdf')}'`
    db.prepare(
      `INSERT INTO file_items (id,path,name,ext,bytes,mtime,first_seen_at,last_seen_at,status,error)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run('bad1', join(dl, 'private', '機密.pdf'), '機密.pdf', '.pdf', 100,
          new Date().toISOString(), new Date().toISOString(), new Date().toISOString(),
          'error', realFsError)
    const r = listCandidates(db, { roots: [dl] })

    assert.ok(!JSON.stringify(r).includes(dl), '錯誤項目把路徑帶出來了')
    assert.ok(r.needsHuman.some(x => x.name === '機密.pdf'), '讀不到的檔要讓使用者知道')
    assert.equal(r.needsHuman[0].why, '沒有權限讀這個檔案', '要換成人話，不是吐原文')
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

// ── 稽查抓到的四個 blocker，每個一條釘子 ────────────────────
describe('B1 隔離區的七天保護窗', () => {
  test('**剛搬進來的舊檔不可以馬上就能清空**', t => {
    // 這條原本釘的是「用 ctime 不要用 mtime」—— 那是 B 還沒做 journal 時的暫代品。
    // 機制換了，但**關切完全沒變**：mv 會保留 mtime，而這個工具的目標客群
    // 就是「很久沒動的舊檔」。用 mtime 算的話，一個 200 天沒動的 zip 一搬進來，
    // canEmptyAt 已經是過去式，七天反悔期等於不存在。
    const f = fixture(t)   // fixture 裡的檔案 mtime 是 120 天前
    const plan = createPlanFor(f)
    applyPlan(f.db, plan.id, f.opts)
    const h = healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine })
    assert.equal(h.quarantine.items, 2)
    assert.equal(h.quarantine.canEmptyNow, false, '120 天沒動的檔，搬進來的當下不可以能清')
    assert.ok(Date.parse(h.quarantine.canEmptyAt) > Date.now() + 6 * DAY,
      '七天要從**搬進隔離區**算起，不是從檔案自己的 mtime')
  })

  test('空的隔離區不算「可以清空」', () => {
    const q = join(root, 'empty-q' + n)
    mkdirSync(q, { recursive: true })
    const h = healthSnapshot(db, { roots: [dl], quarantine: q })
    assert.equal(h.quarantine.canEmptyNow, false)
  })

  test('算不出隔離時間就當不能清（fail closed）', () => {
    const h = healthSnapshot(db, { roots: [dl], quarantine: join(root, '不存在') })
    assert.equal(h.quarantine.canEmptyNow, false)
    assert.equal(h.quarantine.canEmptyAt, null)
  })
})

describe('B2 錯誤原文不可以直通到 UI', () => {
  // 2026-09-19 稽核第二波：翻譯只剩 safeWhy 一個入口（humanError 不再匯出）。
  // 原本直接測 humanError；改測 safeWhy。null 的期望值跟著改：safeWhy 沒有原因就回 null，
  // 「讀不到這個檔案」這種預設句由呼叫端自己給（needsHumanWhy、outcomesOf 都是）。
  test('每一種 fs 錯誤都換成人話，而且不含路徑', () => {
    const cases = [
      ["EACCES: permission denied, open '/home/u/Downloads/薪資單.pdf'", '沒有權限讀這個檔案'],
      ["ENOENT: no such file or directory, stat '/home/u/Downloads/x.zip'", '這個檔案已經不在了'],
      ["EBUSY: resource busy or locked, rename '/home/u/a' -> '/home/u/b'", '這個檔案正在被別的程式使用'],
      ['某個沒看過的錯誤 /home/u/secret.pdf', '讀不到這個檔案'],
    ]
    for (const [raw, want] of cases) {
      const got = safeWhy(raw)
      assert.equal(got, want)
      assert.ok(!got.includes('/'), `換完還有路徑：${got}`)
    }
    assert.equal(safeWhy(null), null)
  })
})

describe('B4 信心打平時，卡片標題要穩定', () => {
  test('同一批輸入重跑十次，kind 與 reasons 順序都一樣', () => {
    // 原本 tie-break 用 candidate id（UUID），兩條 35 分的規則
    // 每次重掃會隨機挑一個當標題，UI 上會亂跳（實測 12 次 6:6）。
    const seen = new Set()
    for (let i = 0; i < 10; i++) {
      const d = open(':memory:')
      const now = new Date().toISOString()
      // 要有 sha256：沒指紋（太大）的檔不列成候選（2026-09-19 稽核 RC4）
      d.prepare(`INSERT INTO file_items (id,path,name,ext,bytes,sha256,mtime,first_seen_at,last_seen_at,status)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('i1', '/r/Screenshot x.png', 'Screenshot x.png', '.png', 10, 'sha-i1', now, now, now, 'candidate')
      for (const k of ['old-download', 'screenshot-noise']) {
        d.prepare(`INSERT INTO cleanup_candidates (id,item_id,kind,rule_version,confidence,reason,evidence,status,created_at)
                   VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(randomUUID(), 'i1', k, CLEANUP_RULE_VERSION, 35, 'r', 'e', 'proposed', now)
      }
      const c = listCandidates(d, { roots: ['/r'] }).candidates[0]
      seen.add(c.kind + '|' + c.reasons.map(x => x.kind).join(','))
    }
    assert.equal(seen.size, 1, `重掃之間不穩定，出現了 ${seen.size} 種順序：${[...seen].join(' / ')}`)
  })
})

// ── 第二批稽查抓到的 ─────────────────────────────────────────
describe('舊版規則的候選不可以還活著', () => {
  test('**調降信心要真的生效**', () => {
    // scanner 只清當前 rule_version 的候選，舊版本的 proposed 列會永久活著。
    // 讀取層不過濾的話，max 取的是「這個檔歷史上拿過的最高分」——
    // 調降信心這個動作永遠不會有效果。
    const now = new Date().toISOString()
    // 要有 sha256：沒指紋（太大）的檔不列成候選（2026-09-19 稽核 RC4）
    db.prepare(`INSERT INTO file_items (id,path,name,ext,bytes,sha256,mtime,first_seen_at,last_seen_at,status)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run('i1', join(dl, 'a.zip'), 'a.zip', '.zip', 10, 'sha-i1', now, now, now, 'candidate')
    const ins = (id, ver, conf) => db.prepare(
      `INSERT INTO cleanup_candidates (id,item_id,kind,rule_version,confidence,reason,evidence,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`).run(id, 'i1', 'archive', ver, conf, 'r', 'e', 'proposed', now)
    ins('old', 'cleanup-rules-v0', 65)               // 舊版，高分
    ins('new', CLEANUP_RULE_VERSION, 45)             // 現行版，已經調降到門檻以下

    const c = listCandidates(db, { roots: [dl] }).candidates[0]
    assert.equal(c.confidence, 45, '要用現行版的信心，不是歷史最高分')
    assert.equal(c.defaultChecked, false, '調降到門檻以下就不該再預設勾')
    assert.equal(c.reasons.length, 1, '同一個 kind 不可以因為版本不同出現兩次')
    assert.deepEqual(c.candidateIds, ['new'], '舊版的 id 不可以被送去 apply')
  })
})

describe('讀不到的檔不可以同時出現在兩區', () => {
  test('status=error 的檔不進候選清單', () => {
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO file_items (id,path,name,ext,bytes,mtime,first_seen_at,last_seen_at,status,error)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run('i1', join(dl, 'x.zip'), 'x.zip', '.zip', 10, now, now, now, 'error', 'EACCES: denied')
    db.prepare(`INSERT INTO cleanup_candidates (id,item_id,kind,rule_version,confidence,reason,evidence,status,created_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('c1', 'i1', 'archive', CLEANUP_RULE_VERSION, 65, 'r', 'e', 'proposed', now)

    const r = listCandidates(db, { roots: [dl] })
    assert.equal(r.candidates.length, 0, '讀不到的檔不可以說「幫你勾好了」')
    assert.equal(r.needsHuman.length, 1, '要出現在「你自己看一眼」')
    assert.equal(healthSnapshot(db, { roots: [dl], quarantine: join(root, 'q') }).pendingCandidates, 0,
      '不可以被算兩次')
  })
})

describe('limit 截斷要有訊號', () => {
  test('total 是這次的，totalAvailable 是全部的', () => {
    const now = new Date().toISOString()
    for (let i = 0; i < 5; i++) {
      // 要有 sha256：沒指紋（太大）的檔不列成候選（2026-09-19 稽核 RC4）
      db.prepare(`INSERT INTO file_items (id,path,name,ext,bytes,sha256,mtime,first_seen_at,last_seen_at,status)
                  VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('i' + i, join(dl, i + '.zip'), i + '.zip', '.zip', 100, 'sha-' + i, now, now, now, 'candidate')
      db.prepare(`INSERT INTO cleanup_candidates (id,item_id,kind,rule_version,confidence,reason,evidence,status,created_at)
                  VALUES (?,?,?,?,?,?,?,?,?)`)
        .run('c' + i, 'i' + i, 'archive', CLEANUP_RULE_VERSION, 65, 'r', 'e', 'proposed', now)
    }
    const r = listCandidates(db, { roots: [dl], limit: 2 })
    assert.equal(r.total, 2)
    assert.equal(r.totalAvailable, 5, '沒有這個欄位，UI 會把 limit 當成全部')
    assert.equal(r.truncated, true)
    assert.equal(listCandidates(db, { roots: [dl] }).truncated, false)
  })
})

describe('duplicate 同名不同目錄', () => {
  test('「會留著」那句話不可以消失', () => {
    // 比 name 的話，Downloads/report.pdf 與 Downloads/2026/09/report.pdf
    // 會被當成同一個檔，那句使用者敢勾的理由整個不見。
    const now = new Date().toISOString()
    const add = (id, sub, seen) => db.prepare(
      `INSERT INTO file_items (id,path,name,ext,bytes,sha256,mtime,first_seen_at,last_seen_at,status)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(id, join(dl, sub, 'report.pdf'), 'report.pdf', '.pdf', 10, 'samesha', now, seen, now, 'candidate')
    add('keep', '.', '2026-01-01T00:00:00.000Z')
    add('dup', join('2026', '09'), '2026-02-01T00:00:00.000Z')
    db.prepare(`INSERT INTO cleanup_candidates (id,item_id,kind,rule_version,confidence,reason,evidence,status,created_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('c1', 'dup', 'duplicate', CLEANUP_RULE_VERSION, 98, 'r', '同一個 sha256 還有 1 份檔案存在', 'proposed', now)

    const e = listCandidates(db, { roots: [dl] }).candidates[0].reasons[0].evidence
    assert.match(e, /會留著/, '同名不同目錄時這句話也要在')
    assert.ok(!e.includes(dl), '補上的位置資訊不可以是絕對路徑')
  })
})

describe('displayPath 不可以誤殺合法檔名', () => {
  test('檔名裡有冒號還是看得出在哪個資料夾', () => {
    // log-2026-09-15T10:30:00.zip 是完全合法的 POSIX 檔名。
    // 冒號檢查套在整條相對路徑上的話，它在 UI 上會完全沒有位置資訊。
    assert.equal(displayPath(join(dl, 'log-2026-09-15T10:30:00.zip'), [dl]).folder, 'Downloads')
    assert.equal(displayPath(join(dl, '2026', 'a.zip'), [dl]).subdir.replace(/\\/g, '/'), '2026')
    assert.equal(displayPath('/完全不相干/x.zip', [dl]).folder, '', '不在 root 底下就什麼都不給')
  })
})

describe('health 要真的能回報不健康', () => {
  test('資料庫壞掉時要優雅降級，而且形狀要完整', () => {
    // 原本這條的名字寫「db.ok 是 false」，斷言卻是 assert.throws ——
    // 把「它會炸」寫成規格，卻掛了一個「它會降級」的名字。
    // /health 是唯一免 token 的端點，它炸掉會讓整個行程死。
    const broken = open(':memory:')
    broken.exec('DROP TABLE meta')
    const h = healthSnapshot(broken, { roots: [dl], quarantine: join(root, 'q') })

    assert.equal(h.db.ok, false)
    assert.equal(h.ok, false)
    // **形狀要完整** —— 少一半的話 UI 拿 h.watcher.ok 直接 TypeError
    assert.ok(h.watcher, 'watcher 區塊不可以不見')
    assert.ok(h.quarantine, 'quarantine 區塊不可以不見')
    assert.equal(typeof h.pendingCandidates, 'number')
  })

  test('watcher 沒跑不代表後端不能用', () => {
    // ok 只講「這台後端能不能用」。使用者剛裝好還沒開 pet，
    // 後端是好的 —— 查得到候選、資料庫是通的。
    // 把兩件事合併成一個布林，對 liveness probe 與 UI 都是錯的訊號。
    const h = healthSnapshot(db, { roots: [dl], quarantine: join(root, 'q') })
    assert.equal(h.db.ok, true)
    assert.equal(h.ok, true, 'watcher 沒跑，但後端是好的')
    assert.equal(h.watcher.ok, false, 'watcher 自己的狀態還是要如實回報')
    assert.equal(h.watcher.why, '從來沒跑過')
  })

  test('心跳的 key 兩邊要對得上', () => {
    db.prepare(`INSERT INTO meta (k,v) VALUES (?,?)`).run(META.heartbeat, new Date().toISOString())
    db.prepare(`INSERT INTO meta (k,v) VALUES (?,?)`).run(META.pid, String(process.pid))
    const h = healthSnapshot(db, { roots: [dl], quarantine: join(root, 'q') })
    assert.equal(h.watcher.ok, true, 'CLI 寫的 key 與 health 讀的 key 對不上就永遠說「沒跑過」')
    assert.equal(h.ok, true)
  })
})

describe('否決旗標', () => {
  test('**太大算不出指紋的檔不可以預設勾**', () => {
    // scanner 對超過上限的檔不算 sha256，但 archive/old-download 這些規則
    // 只看副檔名與 mtime —— 所以最大、最可能是重要備份的那批檔，
    // 會帶著 65 分被預設勾起來，而且沒有內容指紋可以驗證。
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO file_items (id,path,name,ext,bytes,sha256,mtime,first_seen_at,last_seen_at,status)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run('big', join(dl, '婚禮影片備份.zip'), '婚禮影片備份.zip', '.zip',
           8_000_000_000, null, now, now, now, 'candidate')
    db.prepare(`INSERT INTO cleanup_candidates (id,item_id,kind,rule_version,confidence,reason,evidence,status,created_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('c1', 'big', 'archive', CLEANUP_RULE_VERSION, 65, 'r', 'e', 'proposed', now)

    // 2026-09-19 稽核 RC4：只「不預設勾」不夠 —— 使用者還是勾得起來、建得了計畫，
    // 而執行層對它永遠拒收，計畫卡住、檔案被佔住。所以**不列成候選**，改列在「需要你查看」。
    const r = listCandidates(db, { roots: [dl], maxBytes: 20 * 1024 * 1024 })
    assert.equal(r.candidates.length, 0, '不可以列成候選（連 ☐ 都不行）')
    const h = r.needsHuman.find(x => x.name === '婚禮影片備份.zip')
    assert.ok(h, '要在「需要你查看」')
    assert.match(h.why, /太大/)
  })

  test('**大的**半下載檔也不可以誤殺', () => {
    // 上一版用 `bytes > maxBytes` 當判準，把大的 .crdownload 全否決了 ——
    // 而下載會中斷通常就是因為檔案大。原本這條測試用 30 bytes 的小檔、
    // 而且完全不傳 maxBytes，所以沒有任何路徑可以否決任何東西：假綠。
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO file_items (id,path,name,ext,bytes,sha256,mtime,first_seen_at,last_seen_at,status)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run('big-partial', join(dl, 'ubuntu.iso.crdownload'), 'ubuntu.iso.crdownload',
           '.crdownload', 2_500_000_000, null, now, now, now, 'candidate')
    db.prepare(`INSERT INTO cleanup_candidates (id,item_id,kind,rule_version,confidence,reason,evidence,status,created_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('cp', 'big-partial', 'partial', CLEANUP_RULE_VERSION, 95, 'r', 'e', 'proposed', now)

    const c = listCandidates(db, { roots: [dl] }).candidates[0]
    assert.equal(c.vetoed, null, '半下載檔本來就沒有指紋，那是正常的')
    assert.equal(c.defaultChecked, true)
  })

  test('否決的判準是這一列自己的事實，不是讀取時的門檻', () => {
    // 用讀取時的 maxBytes 比對的話，使用者把設定調大（合法操作、不用重掃），
    // 那個沒有指紋的 8GB 備份檔就自己恢復預設勾。
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO file_items (id,path,name,ext,bytes,sha256,mtime,first_seen_at,last_seen_at,status)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run('nb', join(dl, '備份.zip'), '備份.zip', '.zip', 8_000_000_000, null, now, now, now, 'candidate')
    db.prepare(`INSERT INTO cleanup_candidates (id,item_id,kind,rule_version,confidence,reason,evidence,status,created_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('cn', 'nb', 'archive', CLEANUP_RULE_VERSION, 65, 'r', 'e', 'proposed', now)

    // 不管呼叫端傳什麼，結論都一樣（2026-09-19 稽核 RC4 之後的結論是「不列，改列需要你查看」）
    for (const opts of [{ roots: [dl] }, { roots: [dl], limit: 10 }]) {
      const r = listCandidates(db, opts)
      assert.equal(r.candidates.length, 0)
      assert.match(r.needsHuman.find(x => x.name === '備份.zip')?.why ?? '', /太大/)
    }
  })
})

describe('免 token 的 /health 要瘦身', () => {
  test('不帶 token 拿不到資料夾顯示名與錯誤內容', () => {
    db.prepare(`INSERT INTO meta (k,v) VALUES (?,?)`).run(META.lastError, "EACCES open '/home/alice/x'")
    const lean = healthSnapshot(db, { roots: [dl], quarantine: join(root, 'q') })
    const full = healthSnapshot(db, { roots: [dl], quarantine: join(root, 'q'), full: true })

    // **形狀在兩版之間必須一致。** 換型別（string[] ↔ number）的話，
    // C 拿免 token 那版做 UI，watching.map(...) 直接 TypeError。
    // undefined 也不行 —— JSON.stringify 會整個刪掉，連「被遮蔽了」都看不出來。
    assert.ok(Array.isArray(lean.watcher.watching), 'watching 兩版都要是陣列')
    assert.deepEqual(lean.watcher.watching, [], '免 token 時是空陣列，不是數字')
    assert.ok(Array.isArray(full.watcher.watching) && full.watcher.watching.length > 0)
    assert.equal(lean.watcher.watchingCount, 1, '數量兩版都給')
    assert.equal(full.watcher.watchingCount, 1)
    assert.equal(lean.watcher.pid, null, 'null 不是 undefined')
    assert.ok('lastHeartbeatAt' in lean.watcher, '欄位要在，只是遮蔽')
    assert.ok(!JSON.stringify(lean).includes('/home/alice'), 'lastError 的內容不可以無條件送出')
    // 2026-09-19 稽核 RC5：帶 token 也**不給原文**，只給翻過的人話（原文只進 console）
    assert.ok(full.lastError, '帶 token 就給得出來')
    assert.ok(!JSON.stringify(full).includes('/home/alice'), '帶 token 也不可以有路徑')
    assert.match(full.lastError, /沒有權限/)
  })

  test('監看資料夾不存在時 watcher 不是 ok', () => {
    db.prepare(`INSERT INTO meta (k,v) VALUES (?,?)`).run(META.heartbeat, new Date().toISOString())
    db.prepare(`INSERT INTO meta (k,v) VALUES (?,?)`).run(META.pid, String(process.pid))
    const h = healthSnapshot(db, { roots: [join(root, '不存在的資料夾')], quarantine: join(root, 'q') })
    assert.equal(h.watcher.ok, false, '掃描會安靜地回 0 個檔，跟「很乾淨」長得一樣')
    assert.equal(h.watcher.why, '有監看資料夾不存在')
  })
})

describe('displayPath 的出口硬上限', () => {
  test('watch 設成根目錄時，subdir 不可以變成完整路徑', () => {
    const d = displayPath('/home/alice/Documents/2026/09/機密/x.zip', ['/'])
    assert.ok(!d.subdir.startsWith('home'), `整條路徑跑出來了：${d.subdir}`)
    assert.match(d.subdir, /^…\//, '超過上限要截斷')
  })

  test('多個 root 重疊時取最長的那個', () => {
    const d = displayPath('/home/alice/Downloads/x.zip', ['/home/alice', '/home/alice/Downloads'])
    assert.equal(d.folder, 'Downloads', '取第一個的話 folder 會變成使用者名稱')
    assert.equal(d.subdir, '')
  })
})

// ── 心跳：要驗「CLI 真的寫的」與「health 真的讀的」是同一個 key ──
describe('心跳的 key 兩支檔案要對得上（端到端）', () => {
  test('**真的跑一次 CLI**，health 要看得到它', async () => {
    // 只用 META 常數寫再用 META 常數讀，等於自己跟自己對答案 ——
    // 把常數改錯兩邊會一起錯，突變實測 0 紅。
    // 這個 bug 真的上線過（讀 cleanup_watch_heartbeat、寫 watch_heartbeat），
    // 所以要真的跑 CLI，讓它把字串寫進資料庫。
    const { spawnSync } = await import('node:child_process')
    const dir = join(root, 'beat' + n)
    const w = join(dir, 'Downloads')
    mkdirSync(w, { recursive: true })
    const cfg = join(dir, 'config.json')
    const dbPath = join(dir, 'data.db')
    writeFileSync(cfg, JSON.stringify({
      watch: [w], filed: join(dir, 'Filed'),
      model: { baseUrl: '', name: '', keyEnv: 'CONTEXTBOX_MODEL_KEY' },
      readonly: false, pdfPages: 3, maxBytes: 20971520,
    }))

    // watch 是常駐的，跑一下就殺掉 —— 它一啟動就會寫第一次心跳
    spawnSync(process.execPath, [join(REPO, 'cli.mjs'), 'watch'], {
      // HOME 也換掉：token、隔離區這些沒指定的路徑都從家目錄算，不可以落到真的 ~/.contextbox
      env: { ...process.env, HOME: dir, USERPROFILE: dir, CONTEXTBOX_CONFIG: cfg, CONTEXTBOX_DB: dbPath },
      timeout: 2500, encoding: 'utf8',
    })

    const live = open(dbPath)
    const keys = live.prepare(`SELECT k FROM meta`).all().map(r => r.k)
    assert.ok(keys.includes(META.heartbeat),
      `CLI 寫進去的 key 是 ${JSON.stringify(keys)}，health 讀的是 ${META.heartbeat}`)

    const full = healthSnapshot(live, { roots: [w], quarantine: join(dir, 'q'), full: true })
    assert.ok(full.watcher.lastHeartbeatAt, 'health 要讀得到 CLI 寫的心跳')
  })
})

// ── 第二輪點名「改回去也沒人發現」的那幾條 ──────────────────
describe('存活突變的釘子', () => {
  test('501：/cleanup/ 底下認不得的一律 501，不可以掉到 404', () => {
    const seen = []
    const ctx = (p, m = 'POST') => ({
      db, roots: [dl], quarantine: join(root, 'q'),
      url: new URL('http://x' + p), method: m, body: {},
      send: (code, payload) => seen.push({ p, code, payload }),
      scan: () => ({ scanned: 0, candidates: 0, skipped: 0, errors: 0, truncated: false }),
    })
    // 逐條列黑名單一定會漏 —— 第一版漏 apply/undo/dismiss/reveal，
    // 第二版還漏 restore/empty。所以改成白名單反過來列。
    // plans／apply／undo／dismiss／quarantine／pet 現在都實作了，不在這張表。
    // 剩下的還是要被接住 —— 404 會讓 C 以為自己打錯網址。
    for (const p of ['/cleanup/reveal', '/cleanup/restore', '/cleanup/empty',
                     '/cleanup/隨便什麼', '/pet/隨便什麼', '/cleanup/plans/x/reveal']) {
      assert.equal(cleanupRoutes(ctx(p)), true, `${p} 應該被接住`)
    }
    for (const r of seen) {
      assert.equal(r.code, 501, `${r.p} 回了 ${r.code}，不是 501`)
      assert.equal(r.payload.code, 'NOT_IMPLEMENTED')
    }
  })

  test('例外要變成 500 + code，而且寫進 lastError，不可以吐原文', () => {
    db.exec('DROP TABLE cleanup_candidates')
    let got = null
    const ok = cleanupRoutes({
      db, roots: [dl], quarantine: join(root, 'q'),
      url: new URL('http://x/cleanup/candidates'), method: 'GET', body: {},
      send: (code, payload) => { got = { code, payload } },
      scan: () => ({ scanned: 0, candidates: 0, skipped: 0, errors: 0, truncated: false }),
    })
    assert.equal(ok, true)
    assert.equal(got.code, 500, '後端故障不可以回 400 —— 那是在說「你打錯了」')
    assert.equal(got.payload.code, 'INTERNAL')
    assert.ok(!/no such table|SQLITE/i.test(got.payload.error), '不可以吐 SQLite 原文')
    // 錯誤要留下來，不然 /health 的 lastError 永遠是 null
    const kept = db.prepare(`SELECT v FROM meta WHERE k=?`).get(META.lastError)
    assert.ok(kept?.v, '錯誤吞掉的話，連續失敗十次 doctor 也會說一切正常')
  })

  test('needsHuman 要含「有 error 文字但 status 還是 candidate」的檔', () => {
    // scanner 對「太大」的檔寫 error 文字但 status 留在 candidate。
    // 只看 status='error' 的話，那批檔會完全不出現在「你自己看一眼」。
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO file_items (id,path,name,ext,bytes,mtime,first_seen_at,last_seen_at,status,error)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run('e1', join(dl, '太大.zip'), '太大.zip', '.zip', 9e9, now, now, now, 'candidate', '太大，略過')
    const r = listCandidates(db, { roots: [dl] })
    assert.equal(r.needsHumanTotal, 1)
    assert.equal(r.needsHuman[0].name, '太大.zip')
  })

  test('孤兒對帳的走訪要有快取，而且要有失效管道', () => {
    // 七天窗現在走 journal（一次 SQL），但**孤兒對帳還是得走訪磁碟**，
    // 而 /health 不需要 token —— 任何網頁都可以用 <img src=...> 連發。
    const q = join(root, 'q-cache' + n)
    mkdirSync(q, { recursive: true })
    writeFileSync(join(q, 'a.zip'), 'x')
    invalidateQuarantineCache()
    assert.equal(healthSnapshot(db, { roots: [dl], quarantine: q }).quarantine.orphans, 1)

    writeFileSync(join(q, 'b.zip'), 'y')
    assert.equal(healthSnapshot(db, { roots: [dl], quarantine: q }).quarantine.orphans, 1,
      '十秒內走快取，這是預期的')
    invalidateQuarantineCache()
    assert.equal(healthSnapshot(db, { roots: [dl], quarantine: q }).quarantine.orphans, 2,
      'B 搬完檔呼叫這個，數字要立刻更新')
  })

  test('走訪沒看完就 fail closed —— 說不出有沒有孤兒', () => {
    const q = join(root, 'q-trunc' + n)
    mkdirSync(join(q, 'deep'), { recursive: true })
    writeFileSync(join(q, 'deep', 'a.zip'), 'x')
    chmodSync(join(q, 'deep'), 0o000)
    invalidateQuarantineCache()
    try {
      const h = healthSnapshot(db, { roots: [dl], quarantine: q })
      assert.equal(h.quarantine.truncated, true, '沒看完就要說沒看完')
      assert.equal(h.quarantine.orphans, 0, '沒看完不可以猜一個孤兒數字')
    } finally { chmodSync(join(q, 'deep'), 0o700); invalidateQuarantineCache() }
  })
})
