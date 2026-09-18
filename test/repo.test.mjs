/**
 * repo 層級的規則。
 *
 * 這一支守的是寫在文件裡、但以前沒有任何東西在檢查的規則。
 * 「規則寫在註解裡」等於沒有規則。
 *
 * 2026-09-19 稽核第二波（文件與測試）加了：docs/api 範例跟產生器的真實輸出比欄位（RC20）、
 * README 只留一張錯誤表而且跟 HTTP_FOR_CODE 對得上、smoke 文件全程在沙盒（RC18）、
 * spawn cli.mjs 的測試一定給子行程假的 HOME（RC22）、cli.md 照 RC13 的行為寫。
 *
 * 第三波（文件與測試衛生）加了：smoke 撥時間的守門真的用 bash 跑一次（D1）、隔離區空了沒
 * 用 find -type f（D2）、zsh／PowerShell／背景 pet 的說明（D3）、README 的說法跟實際行為
 * 對得上（D4）、/health 與計畫列表的欄位檢查只在那一節裡找（D5）。
 */
import './helpers/isolate-home.mjs'   // 下面的 bash 自我測試會跑一支假的 cli.mjs，家目錄先換掉
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  readdirSync, readFileSync, statSync, mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync,
  utimesSync, realpathSync,
} from 'node:fs'
import { join, dirname, extname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { HTTP_FOR_CODE, listCandidates, listPlans, healthSnapshot, recordOk } from '../core/cleanup-routes.ts'
import { open as openDb } from '../core/db.ts'
import { scanDownloads } from '../core/cleanup-scanner.ts'
import { createPlan } from '../core/cleanup-plans.ts'
import { applyPlan, undoPlan } from '../core/cleanup-exec.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIRS = ['core', 'schema', 'extension', 'test']
const SRC_EXT = new Set(['.ts', '.mjs', '.js'])

function sources() {
  const out = []
  const walk = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (e.isFile() && SRC_EXT.has(extname(e.name))) out.push(p)
    }
  }
  for (const d of SRC_DIRS) { try { if (statSync(join(REPO, d)).isDirectory()) walk(join(REPO, d)) } catch { /* 沒有就算了 */ } }
  out.push(join(REPO, 'cli.mjs'))
  return out
}

describe('原始碼不可以是二進位', () => {
  test('每一支原始檔都要讀得到、diff 得出來', () => {
    // guard.ts 出過這件事：NUL 檢查寫成了一個真的 0x00 位元組，
    // 結果全專案最不能錯的那支檔案在 git 眼裡是 Binary file ——
    // 沒有人 review 得到它的任何一次改動，連 grep 都掃不到它。
    const bad = sources().filter(p => readFileSync(p).includes(0))
    assert.deepEqual(bad.map(p => p.replace(REPO + '/', '')), [],
      '這些檔案裡有 NUL 位元組，git 會把它們當二進位檔')
  })
})

describe('只搬不刪', () => {
  test('core 裡不可以出現刪檔的呼叫', () => {
    // 搬得回來，刪不回來。這條規則寫在 guard.ts 的檔頭，
    // 但以前沒有任何東西在守它。
    const forbidden = /\b(unlinkSync|unlink|rmSync|rm|rmdirSync|rmdir)\s*\(/
    const offenders = []
    for (const p of sources()) {
      // guard.ts 的檔頭寫的是「整個專案」，那就整個專案都要守，
      // 不是只有 core/。測試自己會用 rmSync 清暫存目錄，那不算。
      if (p.includes('/test/')) continue
      const src = readFileSync(p, 'utf8')
      src.split('\n').forEach((line, i) => {
        // 四人分工 §9 B: the sole exception is the guarded quarantine purge.
        // Behavioral boundary tests live in cleanup-undo.test.mjs.
        if (p === join(REPO, 'core', 'cleanup-quarantine.ts') && line.trim() === 'unlinkSync(path)') return
        if (forbidden.test(line)) offenders.push(`${p.replace(REPO + '/', '')}:${i + 1} ${line.trim()}`)
      })
    }
    assert.deepEqual(offenders, [], '正式程式碼不可以刪檔案')
  })
})

/** JSON 裡每一個字串（含 key）。**先 JSON.parse 再比**：JSON 文字裡的反斜線是跳脫過的。 */
function jsonStrings(v, out = []) {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) v.forEach(x => jsonStrings(x, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); jsonStrings(x, out) }
  return out
}

test('docs/api 的範例不可以有真實絕對路徑', () => {
  // 這些檔是從真的程式輸出產生的，產生腳本跑在誰的機器上就會帶誰的家目錄。
  // C 會把它們當 mock 端出來，也會進 git 歷史。
  //
  // 2026-09-19 稽核 RC21：上一版拿正規式直接比 JSON 原文。原文裡的 Windows 路徑是
  // `C:\\Users\\bob`（反斜線跳脫過），`/C:\\Users\\/` 永遠比不到 —— 塞一個真的
  // Windows 家目錄進去照樣綠。現在先 JSON.parse，再對每一個字串比。
  const dir = join(REPO, 'docs', 'api')
  const bad = [/\/home\/(?!alice\b)[a-z0-9_-]+/i, /\/Users\/(?!alice\b)[a-z0-9_-]+/i,
               /[A-Za-z]:\\Users\\(?!Alice\b)/i, /[A-Za-z]:\\(?!Users\\Alice\b)/i,
               /\/tmp\//, /\/var\/folders\//, /\/private\/var\//]
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    for (const str of jsonStrings(JSON.parse(readFileSync(join(dir, f), 'utf8')))) {
      for (const re of bad) assert.ok(!re.test(str), `${f} 裡有真實路徑：${str}`)
    }
  }
  // 正規式自己的檢查：解析過的 Windows 路徑要抓得到（不靠範例檔剛好有沒有）
  assert.ok(bad.some(re => re.test(JSON.parse('"C:\\\\Users\\\\bob\\\\Downloads"'))), '抓不到 Windows 家目錄')
})

test('不帶 token 的 health 範例不可以有資料夾名或錯誤原文', () => {
  const lean = JSON.parse(readFileSync(join(REPO, 'docs/api/health.json'), 'utf8'))
  const full = JSON.parse(readFileSync(join(REPO, 'docs/api/health-with-token.json'), 'utf8'))
  assert.deepEqual(lean.watcher.watching, [])
  assert.ok(full.watcher.watching.length > 0, '帶 token 那份要真的示範有值的樣子')
  assert.equal(lean.watcher.pid, null)
  // 兩份的欄位集合要一模一樣 —— C 拿 lean 做 UI，少一個鍵就是一個 undefined
  const keys = (o) => Object.keys(o).sort().join(',')
  assert.equal(keys(lean), keys(full))
  assert.equal(keys(lean.watcher), keys(full.watcher))
  assert.equal(keys(lean.quarantine), keys(full.quarantine))
})

test('demo 資料跟 API 形狀契約不可以共用同一個檔', () => {
  // docs/api/cleanup-candidates.json 是從真的程式輸出產生的，會隨實作重產。
  // demo 需要穩定、好看的手寫資料。兩者共用的話，每次重產契約就會弄壞 demo
  // 與它的測試 —— 2026-09-18 合併 C 的面板時真的發生過（9 條紅）。
  const readers = ['core/server.ts', 'core/cleanup-demo-history.ts', 'test/cleanup-demo.test.mjs']
  for (const f of readers) {
    const s = readFileSync(join(REPO, f), 'utf8')
    assert.ok(!/docs\/api\/cleanup-candidates\.json/.test(s),
      `${f} 又去讀 docs/api/cleanup-candidates.json 了 —— demo 要用 core/assets/demo-candidates.json`)
  }
})

test('起 server 或載入設定的測試檔，第一個 import 一定是 isolate-home', () => {
  // core/config.ts 在模組載入時就算好設定檔路徑。不先把家目錄換掉的話，
  // 測試會讀（開發機）甚至建立（乾淨的機器）使用者真的 ~/.contextbox/config.json。
  const dir = join(REPO, 'test')
  for (const f of readdirSync(dir).filter(f => f.endsWith('.test.mjs'))) {
    const src = readFileSync(join(dir, f), 'utf8')
    if (!/from\s+['"]\.\.\/core\/server\.ts['"]/.test(src)) continue
    const first = /^import\s[^\n]*$/m.exec(src)?.[0] ?? ''
    assert.match(first, /helpers\/isolate-home\.mjs/, `${f} 的第一個 import 不是 isolate-home：${first}`)
    for (const m of src.matchAll(/\bstart\(\{([^}]*)\}\)/g)) {
      assert.match(m[1], /roots/, `${f} 起 server 沒給 roots —— /health 會去讀使用者的設定檔`)
    }
  }
})

// ═══ RC20 ・ docs/api 的範例是產生器寫的 ═══════════════════════

/**
 * 一份 JSON 的**欄位集合**：每一個 key 的路徑。陣列的元素合併成 `[]`。值不管。
 * 例：`{ a: { b: 1 }, items: [{ x: 1 }, { y: 2 }] }` → a、a.b、items、items[].x、items[].y
 */
function fieldSet(v, at = '', out = new Set()) {
  if (Array.isArray(v)) { for (const x of v) fieldSet(x, at + '[]', out); return out }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { const p = at ? `${at}.${k}` : k; out.add(p); fieldSet(x, p, out) }
  }
  return out
}

describe('docs/api 的範例跟產生器現在的輸出，欄位一模一樣（RC20）', () => {
  // 以前範例是手寫的：/health 的欄位改了名、409 PLAN_ALREADY_APPLIED 根本不存在，
  // C 照著範例寫 UI。現在範例一律由 tools/gen-api-examples.mjs 從真的 server 產生，
  // 這裡再跑一次產生器（寫到暫存資料夾），比每一份的欄位集合。
  // **改了回應的形狀，這裡就紅**：重跑 `node tools/gen-api-examples.mjs`，把 docs/api 一起 commit。
  const API = join(REPO, 'docs', 'api')
  let out, home, gen
  before(() => {
    out = mkdtempSync(join(tmpdir(), 'cb-apigen-out-'))
    home = mkdtempSync(join(tmpdir(), 'cb-apigen-home-'))
    const env = { ...process.env, HOME: home, USERPROFILE: home }
    for (const k of ['CONTEXTBOX_CONFIG', 'CONTEXTBOX_DB', 'CONTEXTBOX_QUARANTINE', 'CONTEXTBOX_TOKEN_PATH', 'CONTEXTBOX_READONLY']) delete env[k]
    gen = spawnSync(process.execPath, [join(REPO, 'tools', 'gen-api-examples.mjs'), '--out', out],
      { encoding: 'utf8', env, timeout: 120_000 })
  })
  after(() => {
    rmSync(out, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  test('產生器跑得起來，而且沒有碰它拿到的家目錄', () => {
    assert.equal(gen.status, 0, `產生器失敗：\n${gen.stdout}\n${gen.stderr}`)
    // 產生器自己換一個假家目錄；給它的這一個應該原封不動（空的）
    assert.deepEqual(readdirSync(home), [], '產生器在家目錄裡寫了東西')
  })

  test('docs/api 裡的 .json 就是產生器寫出來的那幾份，不多不少', () => {
    assert.equal(gen.status, 0, gen.stderr)
    const want = readdirSync(out).filter(f => f.endsWith('.json')).sort()
    const have = readdirSync(API).filter(f => f.endsWith('.json')).sort()
    assert.ok(want.length >= 15, `產生器只寫了 ${want.length} 份`)
    assert.deepEqual(have, want, '多出來的是過期的手寫範例；少的是還沒重跑產生器')
  })

  test('每一份範例的欄位集合跟產生器現在的輸出一樣（不比值）', () => {
    assert.equal(gen.status, 0, gen.stderr)
    const diffs = []
    for (const f of readdirSync(out).filter(f => f.endsWith('.json')).sort()) {
      if (!existsSync(join(API, f))) { diffs.push(`${f}：docs/api 裡沒有這份`); continue }
      const real = fieldSet(JSON.parse(readFileSync(join(out, f), 'utf8')))
      const doc = fieldSet(JSON.parse(readFileSync(join(API, f), 'utf8')))
      const missing = [...real].filter(k => !doc.has(k))
      const extra = [...doc].filter(k => !real.has(k))
      if (missing.length) diffs.push(`${f} 少了：${missing.join('、')}`)
      if (extra.length) diffs.push(`${f} 多了（真的輸出沒有）：${extra.join('、')}`)
    }
    assert.deepEqual(diffs, [], '範例跟真的輸出對不上。重跑 node tools/gen-api-examples.mjs')
  })

  test('欄位集合的算法本身（陣列元素合併、巢狀）', () => {
    assert.deepEqual([...fieldSet({ a: { b: 1 }, items: [{ x: 1 }, { y: { z: null } }], n: null })].sort(),
      ['a', 'a.b', 'items', 'items[].x', 'items[].y', 'items[].y.z', 'n'])
  })
})

// ═══ RC20 ・ README 只留一張錯誤表 ═══════════════════════════

/**
 * 路由層丟得出來的每一個 code 與它的狀態碼。**從原始碼列舉**，不手寫：
 * B 的 CleanupError 走 HTTP_FOR_CODE；server.ts 與 cleanup-routes.ts 自己送的
 * （BAD_METHOD、BODY_TOO_LARGE、INTERNAL、NOT_IMPLEMENTED…）從 send(…)／fail(…) 抓。
 */
function routeCodes() {
  const codes = new Map(Object.entries(HTTP_FOR_CODE))
  for (const f of ['server.ts', 'cleanup-routes.ts', 'cleanup-demo-history.ts']) {
    const src = readFileSync(join(REPO, 'core', f), 'utf8')
    const found = [
      ...src.matchAll(/send\((\d{3}),\s*\{[^}\n]*?code:\s*(['"`])([A-Z_]+)\2/g),
      ...src.matchAll(/fail\(\s*(?:ctx\.)?send,\s*(\d{3}),[^\n]*?,\s*(['"`])([A-Z_]+)\2/g),
    ]
    for (const m of found) {
      const prev = codes.get(m[3])
      assert.ok(prev === undefined || prev === Number(m[1]), `${m[3]} 在 ${f} 回 ${m[1]}，別處是 ${prev}`)
      codes.set(m[3], Number(m[1]))
    }
  }
  return codes
}

/**
 * markdown 的一節：從 `heading` 開頭的那一行，切到下一個**同級或更高一級**的標題為止。
 * 程式碼區塊裡的 `# 註解` 不算標題。找不到回空字串。
 *
 * 第三波 D5：上一版只切起點（`md.slice(md.indexOf(…))`），會一路吃到檔尾 ——
 * 後面幾節講到的欄位都被當成「這一節有講」。
 */
function sectionOf(md, heading) {
  const level = /^#+/.exec(heading)?.[0].length ?? 0
  const lines = md.split('\n')
  let start = -1, fence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { fence = !fence; continue }
    if (fence) continue
    const h = /^(#+)\s/.exec(lines[i])
    if (!h) continue
    if (start < 0) { if (lines[i].startsWith(heading)) start = i; continue }
    if (h[1].length <= level) return lines.slice(start, i).join('\n')
  }
  return start < 0 ? '' : lines.slice(start).join('\n')
}

/**
 * /health 的欄位裡，`section` 沒講到的（第三波 D5）。算「有講到」的只有三種：
 *   - 完整路徑用反引號寫出來：`quarantine.canEmptyAt`
 *   - 父欄位＋子欄位出現在同一行：「`quarantine` 底下的 `total`」
 *   - 物件欄位（`watcher`）：它底下任何一個有講到就算
 * 上一版只要 README **任何地方**出現 `total`、`items` 就算有講 —— `quarantine.total`
 * 這種新欄位會被候選清單那一節的 `total` 蓋過去。
 */
function undocumentedHealthFields(section, health) {
  const paths = [...fieldSet(health)].map(p => p.replaceAll('[]', ''))
  const lines = section.split('\n')
  const tick = s => '`' + s + '`'
  const documented = p => {
    if (section.includes(tick(p))) return true
    if (paths.some(q => q.startsWith(p + '.') && documented(q))) return true
    const cut = p.lastIndexOf('.')
    if (cut < 0) return false
    const parent = tick(p.slice(0, cut)), child = tick(p.slice(cut + 1))
    return lines.some(l => l.includes(parent) && l.includes(child))
  }
  return [...new Set(paths)].filter(p => !documented(p))
}

describe('docs/api/README.md 的錯誤表（RC20）', () => {
  const md = readFileSync(join(REPO, 'docs', 'api', 'README.md'), 'utf8')
  /** markdown 的每一張表：{ header, rows } */
  const tables = () => {
    const out = []
    const lines = md.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('|') || !/^\|\s*:?-{3}/.test(lines[i + 1] ?? '')) continue
      const cells = l => l.split('|').slice(1, -1).map(c => c.trim())
      const t = { header: cells(lines[i]), rows: [] }
      for (i += 2; i < lines.length && lines[i].startsWith('|'); i++) t.rows.push(cells(lines[i]))
      out.push(t)
    }
    return out
  }

  test('只有一張有 code 欄的表', () => {
    const withCode = tables().filter(t => t.header.some(h => /^code$/i.test(h)))
    assert.equal(withCode.length, 1, `README 裡有 ${withCode.length} 張錯誤表 —— 兩張表遲早互相矛盾（稽核 B-4）`)
  })

  test('那張表跟 HTTP_FOR_CODE（加上 server 自己送的 code）一模一樣，包含 TOO_FRESH', () => {
    const t = tables().find(t => t.header.some(h => /^code$/i.test(h)))
    assert.ok(t, '找不到錯誤表')
    const ci = t.header.findIndex(h => /^code$/i.test(h))
    const si = t.header.findIndex(h => /^HTTP$/i.test(h))
    assert.ok(si >= 0, '錯誤表要有 HTTP 欄')
    const doc = new Map()
    for (const r of t.rows) {
      const m = /^`([A-Z_]+)`$/.exec(r[ci])
      if (!m) continue   // 401／403 這種沒有 code 的列
      assert.ok(!doc.has(m[1]), `${m[1]} 在表裡出現兩次`)
      doc.set(m[1], Number(r[si]))
    }
    const real = routeCodes()
    assert.ok(real.has('TOO_FRESH') && real.has('BODY_TOO_LARGE') && real.has('BAD_METHOD'), '前提：列舉有抓到這幾個')
    const diffs = []
    for (const [code, status] of real) {
      if (!doc.has(code)) diffs.push(`表裡少了 ${code}（${status}）`)
      else if (doc.get(code) !== status) diffs.push(`${code} 表上寫 ${doc.get(code)}，實際是 ${status}`)
    }
    for (const code of doc.keys()) if (!real.has(code)) diffs.push(`表裡的 ${code} 程式裡根本沒有`)
    assert.deepEqual(diffs, [])
  })

  test('/health 的每一個欄位，/health 那一節都有講到（欄位改過名，要寫清楚）', () => {
    const h = JSON.parse(readFileSync(join(REPO, 'docs', 'api', 'health-with-token.json'), 'utf8'))
    const section = sectionOf(md, '## `GET /health`')
    assert.ok(section.length > 100, '找不到 /health 那一節')
    assert.deepEqual(undocumentedHealthFields(section, h), [], 'README 的 /health 那一節沒講到這些欄位')
    assert.match(section, /lastQuarantinedAt/, '舊欄位 lastQuarantinedAt 拿掉了，README 要講')
  })

  test('/health 欄位檢查本身：塞一個 README 沒講的新欄位要抓得到（D5）', () => {
    const h = JSON.parse(readFileSync(join(REPO, 'docs', 'api', 'health-with-token.json'), 'utf8'))
    const section = sectionOf(md, '## `GET /health`')
    // 前提：`total` 在 README 別的地方有（候選清單、計畫列表那兩節），/health 那一節沒有 ——
    // 所以只看最後一段名字、或是看整份 README 的檢查會把 quarantine.total 放過去
    assert.ok(md.includes('`total`') && !section.includes('`total`'), '前提變了：換一個 README 別處有、/health 沒有的名字')
    const extra = structuredClone(h)
    extra.quarantine.total = 3
    extra.watcher.restarts = 0
    extra.brandNew = { x: 1 }
    assert.deepEqual(undocumentedHealthFields(section, extra).sort(),
      ['brandNew', 'brandNew.x', 'quarantine.total', 'watcher.restarts'])
    // 「父欄位＋子欄位」同一行才算；分在兩行不算
    assert.deepEqual(undocumentedHealthFields('`quarantine` 底下的 `total` 是總數', { quarantine: { total: 1 } }), [])
    assert.deepEqual(undocumentedHealthFields('`quarantine` 是隔離區\n`total` 是總數', { quarantine: { total: 1 } }),
      ['quarantine.total'])
  })

  test('GET /cleanup/plans 不帶篩選時的形狀，在那一節裡寫清楚', () => {
    const list = JSON.parse(readFileSync(join(REPO, 'docs', 'api', 'cleanup-plans-list.json'), 'utf8'))
    const section = sectionOf(md, '### `GET /cleanup/plans`')
    assert.ok(section.length > 100, '找不到 GET /cleanup/plans 那一段')
    assert.match(section, /不帶篩選/)
    const keys = Object.keys(list.operations[0] ?? {})
    assert.ok(keys.length >= 8, '前提：範例裡有計畫')
    const missing = keys.filter(k => !section.includes('`' + k + '`'))
    assert.deepEqual(missing, [], 'GET /cleanup/plans 那一段沒講到這些欄位')
  })

  test('一節切到下一個同級標題為止，不吃到檔尾（D5）', () => {
    const section = sectionOf(md, '### `GET /cleanup/plans`')
    // `token` 只在後面「清空隔離區」那一節講。上一版切到檔尾，它就被算成「計畫列表有講」
    assert.ok(md.slice(md.indexOf('### `GET /cleanup/plans`')).includes('`token`'), '前提變了：換一個後面幾節才有的欄位')
    assert.ok(!section.includes('`token`'), '計畫列表那一節吃到了後面幾節')
    assert.ok(!section.includes('### 復原的檔'), '沒有停在下一個 ### 標題')
    // 同級停、更高一級也停；程式碼區塊裡的 # 不算標題
    const doc = '## A\na\n### B\nb\n```bash\n# 註解\n## 也是註解\n```\nb2\n### C\nc\n## D\nd'
    assert.equal(sectionOf(doc, '### B'), '### B\nb\n```bash\n# 註解\n## 也是註解\n```\nb2')
    assert.equal(sectionOf(doc, '### C'), '### C\nc')
    assert.equal(sectionOf(doc, '## A'), '## A\na\n### B\nb\n```bash\n# 註解\n## 也是註解\n```\nb2\n### C\nc')
    assert.equal(sectionOf(doc, '## 沒有這節'), '')
  })

  // ── 第三波 D4：README 的說法不可以比實際寬，也不可以過時 ──

  test('.restored 會以 duplicate 再出現，只在內容一模一樣的時候（D4）', () => {
    const sec = sectionOf(md, '### 復原的檔不會回到')
    assert.ok(sec.length > 50, '找不到「復原的檔不會回到這次的清理清單」那一節')
    const bullet = sec.split('\n- ').find(b => /\.restored/.test(b) && /duplicate/.test(b)) ?? ''
    assert.ok(bullet, '那一節沒有講 .restored 以 duplicate 再出現')
    assert.match(bullet, /內容一模一樣/, '只有後來那個檔跟放回來的內容一模一樣，才會是 duplicate')
    assert.match(bullet, /內容不同/, '要講內容不同的時候不會以 duplicate 出現')
  })

  test('undoable=1 列得出復原失敗、復原中斷的計畫（D4）', () => {
    const sec = sectionOf(md, '### `GET /cleanup/plans`')
    const row = tables().flatMap(t => t.rows).find(r => r[0] === '`undoable=1`')
    assert.ok(row, '計畫列表的表裡沒有 undoable=1 那一列')
    const text = row.join(' ')
    assert.doesNotMatch(text, /復原到一半的都不算/, '部分復原失敗、復原中斷的計畫照樣列（canUndo true）')
    assert.match(text, /復原失敗/)
    assert.match(text, /中斷/)
    assert.match(text, /已復原/)
    assert.match(text, /清空/)
    assert.ok(sec.includes(row[0]), '前提：那一列在計畫列表那一節裡')
  })

  test('pending=1 只列還沒套用（proposed）的計畫，套用過的 partial／error 不算（D4）', () => {
    const row = tables().flatMap(t => t.rows).find(r => r[0] === '`pending=1`')
    assert.ok(row, '計畫列表的表裡沒有 pending=1 那一列')
    assert.doesNotMatch(row[1], /proposed／partial／error/, '套用過的 partial／error 不列：計畫是一次性的，重試＝新計畫')
    assert.match(row[1], /`proposed`/)
  })

  test('409 CONFLICT 那一列：全部放回的計畫再 apply 是 200，不是 409（D4）', () => {
    const t = tables().find(t => t.header.some(h => /^code$/i.test(h)))
    const row = t.rows.find(r => r.includes('`CONFLICT`')) ?? []
    const when = row[t.header.findIndex(h => /什麼時候/.test(h))] ?? ''
    assert.ok(when, '找不到 CONFLICT 那一列')
    assert.doesNotMatch(when, /已經開始復原的計畫再 apply/, '「已經開始復原的計畫再 apply」太寬：全部放回的回 200')
    assert.match(when, /`partial`／`error`/, '要講清楚是停在 partial／error 的那種')
    assert.match(when, /`restored`[^；|]*200|200[^；|]*`restored`/, '要講全部放回的再 apply 回 200、status restored')
  })

  test('不帶 token 的 /health 被遮掉的每一個欄位，遮蔽清單都有寫（D4）', () => {
    const lean = JSON.parse(readFileSync(join(REPO, 'docs', 'api', 'health.json'), 'utf8'))
    const full = JSON.parse(readFileSync(join(REPO, 'docs', 'api', 'health-with-token.json'), 'utf8'))
    // 被遮掉的 ＝ 兩份範例值不一樣的葉子欄位（同一次產生，沒遮的值一定一樣）
    const leaf = (o, at = '') => Object.entries(o).flatMap(([k, v]) =>
      v && typeof v === 'object' && !Array.isArray(v) ? leaf(v, at + k + '.') : [[at + k, v]])
    const fullMap = new Map(leaf(full))
    const masked = leaf(lean).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(fullMap.get(k))).map(([k]) => k)
    assert.ok(masked.includes('lastErrorAt') && masked.includes('lastOkAt'), `前提：範例示範了這兩個被遮掉（${masked.join('、')}）`)
    // 遮蔽清單 ＝ /health 那一節、表格之前那一段
    const section = sectionOf(md, '## `GET /health`')
    const intro = section.slice(0, section.indexOf('\n|'))
    const missing = masked.filter(k => !intro.includes('`' + k + '`'))
    assert.deepEqual(missing, [], '不帶 token 時被遮掉、但遮蔽清單沒寫的欄位')
  })
})

// ═══ 第三波 D4 ・ README 講的行為，實際跑一次 ════════════════════

describe('docs/api/README.md 講的行為真的是這樣（第三波 D4）', () => {
  // README 的說法改寫過（見上面那幾條）；這裡從另一頭釘住：行為改了，這裡紅，README 要跟著改。
  // 直接呼叫 core 的函式，跟 route 用的是同一支。
  const DAY = 86400_000
  let dir, dl, q, db, opts
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-readme-')))
    dl = join(dir, 'Downloads'); q = join(dir, 'quarantine')
    mkdirSync(dl)
    db = openDb(join(dir, 'data.db'))
    opts = { roots: [dl], quarantine: q, maxBytes: 1 << 20 }
  })
  after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  const put = (name, content, days) => {
    const p = join(dl, name)
    writeFileSync(p, content)
    const t = new Date(Date.now() - days * DAY)
    utimesSync(p, t, t)
  }
  const rows = () => listCandidates(db, { roots: [dl], limit: 1000 }).candidates
  const planOf = names => {
    scanDownloads({ db, ...opts })
    const ids = rows().filter(c => names.includes(c.name)).flatMap(c => c.candidateIds)
    assert.ok(ids.length, `前提：${names.join('、')} 在清單上`)
    return createPlan(db, { candidateIds: ids, requestId: 'readme-' + names.join() }).id
  }

  test('.restored：內容一模一樣 → duplicate 98 預設勾；內容不同 → 不列', () => {
    put('same.zip', 'SAME', 60)
    put('diff.zip', 'OLD', 60)
    const id = planOf(['same.zip', 'diff.zip'])
    assert.equal(applyPlan(db, id, opts).status, 'applied')
    put('same.zip', 'SAME', 0)     // 後來又下載了一模一樣的
    put('diff.zip', 'NEW', 0)      // 後來又下載了同名、內容不同的
    const undone = undoPlan(db, id, opts)
    assert.deepEqual(undone.items.map(i => i.name).sort(), ['diff.zip', 'same.zip'])
    scanDownloads({ db, ...opts })
    const back = rows().filter(c => /\.restored$/.test(c.name)).map(c => [c.name, c.kind, c.confidence, c.defaultChecked])
    assert.deepEqual(back, [['same.zip.restored', 'duplicate', 98, true]])
  })

  test('undoable=1：復原失敗過的計畫照樣列（canUndo true）；全部放回的不列', () => {
    put('p1.zip', 'P ONE', 60)
    put('p2.zip', 'P TWO', 60)
    const id = planOf(['p1.zip', 'p2.zip'])
    assert.equal(applyPlan(db, id, opts).quarantinedCount, 2)
    const item = readdirSync(join(q, id))[0]
    writeFileSync(join(q, id, item, 'content'), 'TAMPERED')   // 隔離區那一份被改過 → 復原失敗
    const undone = undoPlan(db, id, opts)
    assert.equal(undone.status, 'partial')
    const listed = listPlans(db, { filter: 'undoable' }).operations
    const mine = listed.find(o => o.id === id)
    assert.ok(mine, '復原失敗過的計畫要列在 undoable=1')
    assert.equal(mine.canUndo, true)
    assert.equal(mine.items.length, 1, '只列還在隔離區的那一個')
    // 上一條全部放回的那一份不列
    assert.ok(listed.every(o => o.status !== 'restored'), '全部放回的計畫不該在 undoable=1')
  })

  test('pending=1：套用到一半失敗的（partial）不列，還沒套用的（proposed）才列', () => {
    put('ok.zip', 'OK', 60)
    put('fresh.zip', 'FRESH', 60)
    put('later.zip', 'LATER', 60)
    const partial = planOf(['ok.zip', 'fresh.zip'])
    put('fresh.zip', 'FRESH', 0)   // 十分鐘內動過 → 這一個 TOO_FRESH
    assert.equal(applyPlan(db, partial, opts).status, 'partial')
    const proposed = planOf(['later.zip'])
    const listed = listPlans(db, { filter: 'pending' }).operations.map(o => o.id)
    assert.ok(listed.includes(proposed), '還沒套用的要列')
    assert.ok(!listed.includes(partial), '套用過的 partial 不列 —— 失敗的檔要重試就建新計畫')
  })

  test('apply：全部放回的回 restored（不丟錯）；復原停在 partial 的丟 CONFLICT', () => {
    // 開始復原過的（journal 裡有 restore）；套用到一半失敗、沒復原過的 partial 不算
    const plans = db.prepare(`SELECT id, status FROM cleanup_plans p WHERE status IN ('restored','partial')
      AND EXISTS (SELECT 1 FROM cleanup_journal j WHERE j.plan_id = p.id AND j.op = 'restore')`).all()
    const restored = plans.find(p => p.status === 'restored'), partial = plans.find(p => p.status === 'partial')
    assert.ok(restored && partial, '前提：上面幾條留下一份全部放回的、一份復原停在 partial 的')
    assert.equal(applyPlan(db, restored.id, opts).status, 'restored')
    assert.throws(() => applyPlan(db, partial.id, opts), e => e.code === 'CONFLICT')
  })

  test('/health 不帶 token：lastErrorAt／lastOkAt 是 null，欄位還在', () => {
    recordOk(db)
    const h = o => healthSnapshot(db, { roots: [dl], quarantine: q, ...o })
    const lean = h({ full: false }), full = h({ full: true })
    assert.ok('lastErrorAt' in lean && 'lastOkAt' in lean, '欄位要在（形狀一致）')
    assert.equal(lean.lastOkAt, null)
    assert.equal(lean.lastErrorAt, null)
    assert.equal(typeof full.lastOkAt, 'string', '帶 token 才看得到')
  })
})

describe('文件裡不可以再出現不存在的 code（RC20）', () => {
  test('docs 底下的 .md 沒有 PLAN_ALREADY_APPLIED 這類過時的 code', () => {
    // 這幾個都在舊文件裡出現過，程式從來沒有丟過
    const stale = ['PLAN_ALREADY_APPLIED', 'QUARANTINE_TOO_YOUNG', 'CONFIRM_REQUIRED', 'SCAN_IN_PROGRESS']
    const hits = []
    const walk = d => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(md|json)$/.test(e.name)) {
          const s = readFileSync(p, 'utf8')
          for (const c of stale) if (new RegExp(`\\b${c}\\b`).test(s)) hits.push(`${p.replace(REPO + '/', '')}：${c}`)
        }
      }
    }
    walk(join(REPO, 'docs'))
    assert.deepEqual(hits, [])
  })
})

// ═══ RC13 ・ docs/cli.md 照實際行為寫 ══════════════════════════

describe('docs/cli.md（RC13）', () => {
  const md = readFileSync(join(REPO, 'docs', 'cli.md'), 'utf8')

  test('RC13 的每一個指令都有寫', () => {
    for (const [what, re] of [
      ['cleanup release <plan-id>', /cleanup release <plan-id>/],
      ['open', /node cli\.mjs open\b/],
      ['--skip <編號>', /--skip <編號/],
      ['--also <編號>', /--also <編號/],
      ['undo 不給 id', /cleanup undo \[plan-id\]/],
      ['quarantine --empty --yes <token>', /--empty --yes <token>/],
    ]) assert.match(md, re, `cli.md 沒寫 ${what}`)
  })

  test('逐項結果的每一種 outcome 都有寫怎麼印', () => {
    for (const o of ['moved', 'skipped', 'failed', 'restored', 'purged', 'pending', 'cancelled', 'unknown']) {
      assert.match(md, new RegExp('`' + o + '`'), `cli.md 沒寫 ${o} 怎麼印`)
    }
  })

  test('沒有過時的「重送回 409」', () => {
    assert.doesNotMatch(md, /\b409\b/, '重送已套用的計畫是冪等的（離開碼 0），不是 409')
  })

  // ── 2026-09-19 第三波（C8）：上一輪驗證員把「不清了」的範例改回 undo，這一段照樣全綠 —— 沒牙齒。

  test('「不清了」的建議是 release，不可以是 undo', () => {
    // 建議 ＝ 帶指令的那一行（解釋「不清了」是什麼的說明文字不算）
    const lines = md.split('\n').filter(l => /不清了/.test(l) && /\bcleanup [a-z]+/.test(l))
    assert.ok(lines.length, 'cli.md 找不到「不清了」那一條建議')
    for (const l of lines) {
      assert.match(l, /cleanup release/, `「不清了」要叫人 release：${l}`)
      assert.doesNotMatch(l, /cleanup undo/, `「不清了」不可以叫人 undo（會把已經清掉的檔放回來）：${l}`)
    }
  })

  test('卡住的計畫（CONFLICT）離開碼是 1，不是 2', () => {
    const rows = md.split('\n').filter(l => l.startsWith('|') && /佔著/.test(l))
    assert.ok(rows.length, '離開碼對照表沒有「被計畫佔著」那一列')
    for (const r of rows) assert.match(r, /\|\s*1\s*\|\s*$/, `CONFLICT 重試一百次也一樣，是 1：${r}`)
    const sec = md.split(/^### /m).find(x => x.startsWith('卡住的計畫'))
    assert.ok(sec, 'cli.md 沒有「卡住的計畫」那一節')
    assert.match(sec, /離開碼 1/)
    assert.doesNotMatch(sec, /離開碼 2/)
  })

  test('做到一半中斷的計畫：寫了 undo 放回、apply 做完，而且寫明 release 不行', () => {
    const sec = md.split(/^### /m).find(x => x.startsWith('卡住的計畫')) ?? ''
    assert.match(sec, /中斷/, '沒寫做到一半中斷的計畫怎麼辦')
    assert.match(sec, /cleanup undo 5c1e…/, '中斷的計畫要叫人 undo 把已經搬的放回來')
    assert.match(sec, /release[^\n]*不行|不能[^\n]*release/, '要寫明中斷的計畫不能 release')
  })

  test('編號是「至少 4 碼、撞號會延長」', () => {
    assert.match(md, /至少 4 碼/)
    assert.match(md, /撞[^\n]*(延長|多印)/)
  })

  test('unknown 的建議跟 CLI 真的印的一樣', () => {
    const said = '搬到一半中斷，檔案可能已經在隔離區，執行 node cli.mjs doctor 檢查'
    assert.ok(readFileSync(join(REPO, 'cli.mjs'), 'utf8').includes(said), '前提：CLI 印的是這一句')
    assert.ok(md.includes(said), 'cli.md 寫的建議跟 CLI 印的不一樣')
  })

  test('open 在 pet 沒跑的時候回 2', () => {
    assert.match(md, /pet 沒在跑[^\n]*離開碼 2/)
  })

  test('環境變數表有 pet／open 用的那三個', () => {
    for (const v of ['CONTEXTBOX_PORT', 'CONTEXTBOX_RESCAN_MS', 'CONTEXTBOX_OPENER']) {
      assert.match(md, new RegExp('^\\| `' + v + '`', 'm'), `環境變數表沒有 ${v}`)
    }
  })
})

// ═══ RC22 ・ spawn cli.mjs 的測試要給子行程假的 HOME ═══════════

/** 從 `(` 開始抓到對應的 `)`，跳過字串。回整段文字。 */
function callSpan(src, open) {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return src.slice(open, i + 1)
  }
  return src.slice(open)
}

/**
 * 一支測試檔裡每一個 spawn cli.mjs 的呼叫，子行程拿不拿得到假的 HOME。
 * 拿得到的兩種寫法：
 *   1. env 裡明寫 `HOME:`
 *   2. 這支檔的第一個 import 是 isolate-home（process.env.HOME 已經是假的），
 *      而且 env 沒給、或是從 `...process.env` 展開（繼承那個假的）
 * 回不合格的行號。
 */
function spawnsWithoutFakeHome(src) {
  // 路徑前面可以有東西：'../cli.mjs'、new URL('../cli.mjs', import.meta.url)
  const aliases = [...src.matchAll(/(?:const|let|var)\s+(\w+)\s*=[^\n;]*['"`][^'"`\n]*cli\.mjs['"`]/g)].map(m => m[1])
  const refersCli = span => /cli\.mjs/.test(span) || aliases.some(a => new RegExp(`\\b${a}\\b`).test(span))
  const first = /^import\s[^\n]*$/m.exec(src)?.[0] ?? ''
  const isolated = /helpers\/isolate-home\.mjs/.test(first)
  const bad = []
  for (const m of src.matchAll(/\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec|fork)\s*\(/g)) {
    const span = callSpan(src, m.index + m[0].length - 1)
    if (!refersCli(span)) continue
    // `env: env(extra)`、`env: s.env({...})`：env 是 helper 做的，要看 helper 本身。
    // 同名的定義有好幾個就每一個都要合格；找不到定義就當不合格。
    const helper = /\benv\s*:\s*(?:\w+\.)?(\w+)\s*\(/.exec(span)?.[1]
    const bodies = helper ? helperBodies(src, helper) : [span]
    // `HOME: process.env.HOME` 不算：沒 import isolate-home 的話那就是真的家目錄
    const ok = body => /\bHOME\s*:(?!\s*process\.env\.HOME\b)/.test(body) ||
      (isolated && (!helper && !/\benv\s*:/.test(body) || /\.\.\.process\.env\b/.test(body)))
    if (!bodies.length || !bodies.every(ok)) bad.push(src.slice(0, m.index).split('\n').length)
  }
  return bad
}

/** `const NAME = (…) => ({…})`、`const NAME = (…) => {…}`、`function NAME(…) {…}` 的本體 */
function helperBodies(src, name) {
  const out = []
  for (const m of src.matchAll(new RegExp(`(?:(?:const|let|var)\\s+${name}\\s*=|function\\s+${name}\\s*\\()`, 'g'))) {
    let i = m.index + m[0].length
    if (m[0].startsWith('function')) i = src.indexOf('{', callSpan(src, i - 1).length + i - 1)
    else {
      const arrow = src.indexOf('=>', i)
      if (arrow < 0) continue
      for (i = arrow + 2; /\s/.test(src[i]); i++);
    }
    out.push(src[i] === '(' ? callSpan(src, i) : braceSpan(src, i))
  }
  return out
}

function braceSpan(src, open) {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++
      continue
    }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return src.slice(open, i + 1)
  }
  return src.slice(open)
}

describe('spawn cli.mjs 的測試，子行程一定拿到假的 HOME（RC22）', () => {
  test('檢查器本身：抓得到沒給的、放得過有給的', () => {
    const CLI_SPAWN = "const CLI = join(REPO, 'cli.mjs')\nspawnSync(process.execPath, [CLI, 'x'], { env: { ...process.env, CONTEXTBOX_DB: db } })"
    assert.deepEqual(spawnsWithoutFakeHome("import { test } from 'node:test'\n" + CLI_SPAWN), [3])
    assert.deepEqual(spawnsWithoutFakeHome("import './helpers/isolate-home.mjs'\n" + CLI_SPAWN), [])
    assert.deepEqual(spawnsWithoutFakeHome("import { test } from 'node:test'\n" +
      "spawnSync(process.execPath, [join(REPO, 'cli.mjs')], { env: { ...process.env, HOME: fake } })"), [])
    // isolate-home 有 import，但 env 沒有從 process.env 展開 —— 子行程拿不到 HOME，os.homedir() 會回真的
    assert.deepEqual(spawnsWithoutFakeHome("import './helpers/isolate-home.mjs'\n" +
      "spawnSync(process.execPath, ['cli.mjs'], { env: { PATH: process.env.PATH } })"), [2])
    // env 是 helper 做的：helper 有 HOME 就過，沒有就抓（含 s.env(...) 這種方法呼叫）
    const H = "const CLI = join(REPO, 'cli.mjs')\n"
    assert.deepEqual(spawnsWithoutFakeHome("import { test } from 'node:test'\n" + H +
      "const env = (x = {}) => ({ ...process.env, HOME: fake, ...x })\nspawnSync(process.execPath, [CLI], { env: env({}) })"), [])
    assert.deepEqual(spawnsWithoutFakeHome("import { test } from 'node:test'\n" + H +
      "const env = (x = {}) => ({ ...process.env, CONTEXTBOX_DB: db, ...x })\nspawnSync(process.execPath, [CLI], { env: env({}) })"), [4])
    assert.deepEqual(spawnsWithoutFakeHome("import { test } from 'node:test'\n" + H +
      "function env(x) {\n  return { ...process.env, HOME: fake, ...x }\n}\nspawn(process.execPath, [CLI], { env: s.env({ A: '1' }) })"), [])
    assert.deepEqual(spawnsWithoutFakeHome("import { test } from 'node:test'\n" + H +
      "spawn(process.execPath, [CLI], { env: s.nowhere({ HOME_X: '1' }) })"), [3])
    // 反方向：這幾種以前抓不到
    assert.deepEqual(spawnsWithoutFakeHome("import { test } from 'node:test'\n" +
      "const CLI = new URL('../cli.mjs', import.meta.url)\nspawnSync(process.execPath, [CLI], { env: { ...process.env } })"), [3])
    assert.deepEqual(spawnsWithoutFakeHome("import { test } from 'node:test'\nexecSync('node cli.mjs scan')"), [2])
    assert.deepEqual(spawnsWithoutFakeHome("import { test } from 'node:test'\n" +
      "spawnSync(process.execPath, ['cli.mjs'], { env: { ...process.env, HOME: process.env.HOME } })"), [2])
    // isolate-home 在，helper 從 process.env 展開也算
    assert.deepEqual(spawnsWithoutFakeHome("import './helpers/isolate-home.mjs'\n" + H +
      "const env = () => ({ ...process.env, CONTEXTBOX_DB: db })\nspawnSync(process.execPath, [CLI], { env: env() })"), [])
    // 不是 spawn cli.mjs 的不管
    assert.deepEqual(spawnsWithoutFakeHome("import { test } from 'node:test'\nspawnSync(process.execPath, ['-e', 'x'])"), [])
  })

  const dir = join(REPO, 'test')
  // 這支檔自己不算：上面的檢查器測試把「spawn cli.mjs」寫在字串裡當範例
  const files = readdirSync(dir).filter(f => f.endsWith('.test.mjs') && f !== 'repo.test.mjs')
    .filter(f => /\b(?:spawnSync|spawn|execFileSync|execFile|fork)\s*\(/.test(readFileSync(join(dir, f), 'utf8'))
              && /cli\.mjs/.test(readFileSync(join(dir, f), 'utf8')))
  for (const f of files) {
    test(`${f}`, () => {
      const bad = spawnsWithoutFakeHome(readFileSync(join(dir, f), 'utf8'))
      assert.deepEqual(bad, [], `${f} 第 ${bad.join('、')} 行 spawn cli.mjs 沒有給子行程假的 HOME —— CLI 會讀寫你真的 ~/.contextbox`)
    })
  }
})

// ═══ RC18 ・ smoke 文件全程在沙盒 ════════════════════════════

/**
 * 會**直接**寫資料的指令：改資料庫、改檔案時間、刪檔。這些不經過 CLI、不走 cb，
 * 所以每一行都要自己站在守門後面（第三波 D1）。
 */
const DIRECT_WRITE = /\btouch\b|utimes|\.Last(?:Write|Access)Time\s*=|DatabaseSync|\bsqlite3\b|\b(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO|DROP\s+TABLE)\b|\brm\s+-\w*[rf]|\bRemove-Item\b/

/** 拿掉註解（行首或空白後面的 #）。這份文件的字串裡沒有 #。 */
const uncomment = line => line.replace(/(^|\s)#.*$/, '$1')

/** 守門的三種寫法：函式本體的第一行、`if … then … fi`、單行的 `sandbox_ok && …`（bash 與 PowerShell 各一套） */
const GUARD_FIRST = /^(?:sandbox_ok \|\| return 1|if \(-not \(sandbox_ok\)\) \{ return \})$/
const GUARD_IF = /^if (?:sandbox_ok\b|\[ -n "\$SANDBOX" \])[^\n]*;\s*then$/
const GUARD_LINE = /^(?:sandbox_ok && |if \(sandbox_ok\) \{)/

/**
 * 一個區塊裡**沒有**站在守門後面、卻會直接寫資料的行。
 * 這裡只看寫法；守門本身擋不擋得住，下面用 bash 真的跑一次。
 */
function unguardedWrites(body) {
  const lines = body.split('\n')
  const bad = []
  for (let i = 0; i < lines.length; i++) {
    const code = uncomment(lines[i]).trim()
    // 函式定義：本體第一行是守門，整個本體都算守住
    if (/^(?:function\s+[\w-]+\b.*|[\w-]+\(\))\s*\{$/.test(code)) {
      const end = lines.findIndex((l, j) => j > i && /^\}\s*$/.test(l))
      const first = lines.slice(i + 1, end).map(l => uncomment(l).trim()).find(Boolean) ?? ''
      if (end > i && GUARD_FIRST.test(first)) { i = end; continue }
    }
    if (GUARD_IF.test(code)) {
      const end = lines.findIndex((l, j) => j > i && l.trim() === 'fi')
      if (end > i) { i = end; continue }
    }
    if (GUARD_LINE.test(code)) continue
    if (DIRECT_WRITE.test(code)) bad.push(lines[i].trim())
  }
  return bad
}

/** 區塊裡 `name() {` 到行首 `}` 的整段定義；PowerShell 是 `function name … {` */
const shellFn = (body, name) => new RegExp(`^${name}\\(\\)\\s*\\{\\n[\\s\\S]*?^\\}`, 'm').exec(body)?.[0] ?? ''
const psFn = (body, name) => new RegExp(`^function ${name}\\b[^\\n]*\\{\\n[\\s\\S]*?^\\}`, 'm').exec(body)?.[0] ?? ''

/** smoke 的 bash 區塊是給 macOS／Linux 的；Windows 上 $SANDBOX/home 這種接法本來就對不上 */
const NO_BASH = process.platform === 'win32' ? 'smoke 的 bash 區塊是給 macOS／Linux 的'
  : spawnSync('bash', ['-c', 'exit 0']).status === 0 ? false : '這台沒有 bash'

/** 跑一段 bash。環境變數只給 PATH（前面接上這個 node）與指定的 —— 不繼承任何家目錄。 */
function bash(script, env, cwd) {
  return spawnSync('bash', ['--noprofile', '--norc', '-c', script], {
    cwd, encoding: 'utf8', timeout: 30_000,
    env: { PATH: dirname(process.execPath) + delimiter + process.env.PATH, ...env },
  })
}

/**
 * 一個假的使用者：`real` 是他真的家目錄（有資料庫、有 Downloads），`sb` 是 smoke 的沙盒。
 * `good` ＝ 第 0 步設好之後的環境變數；`realEnv` ＝ 一個沒設沙盒的分頁。
 */
function smokeWorld() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cb-smoke-guard-')))
  const sb = join(root, 'sb'), real = join(root, 'real')
  for (const d of [join(sb, 'home', 'Downloads'), join(sb, 'home', 'Downloads-old'), sb + '-other', join(real, '.contextbox'), join(real, 'Downloads')]) {
    mkdirSync(d, { recursive: true })
  }
  const box = join(real, '.contextbox')
  return {
    root, sb, real,
    good: {
      SANDBOX: sb, HOME: join(sb, 'home'), CONTEXTBOX_CONFIG: join(sb, 'config.json'), CONTEXTBOX_DB: join(sb, 'data.db'),
      CONTEXTBOX_QUARANTINE: join(sb, 'quarantine'), CONTEXTBOX_TOKEN_PATH: join(sb, 'token'),
    },
    realEnv: {
      HOME: real, CONTEXTBOX_CONFIG: join(box, 'config.json'), CONTEXTBOX_DB: join(box, 'data.db'),
      CONTEXTBOX_QUARANTINE: join(box, 'quarantine'), CONTEXTBOX_TOKEN_PATH: join(box, 'token'),
    },
    done: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** 這台有沒有 PowerShell（Windows 一定有 powershell；別的平台要自己裝 pwsh） */
const PS = ['pwsh', 'powershell'].find(bin =>
  spawnSync(bin, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 60_000 }).status === 0)

function powershell(script, env, dir) {
  const file = join(dir, `run-${Math.random().toString(36).slice(2)}.ps1`)
  // BOM：Windows PowerShell 5 讀沒有 BOM 的腳本會用系統編碼，中文就壞了
  writeFileSync(file, '\uFEFF' + script)
  const base = { ...process.env }   // isolate-home 已經把家目錄換成假的
  for (const k of ['SANDBOX', 'CONTEXTBOX_CONFIG', 'CONTEXTBOX_DB', 'CONTEXTBOX_QUARANTINE', 'CONTEXTBOX_TOKEN_PATH']) delete base[k]
  return spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
    { encoding: 'utf8', timeout: 60_000, env: { ...base, ...env } })
}

describe('test/smoke-cleanup.md 全程在沙盒裡（RC18）', () => {
  const md = readFileSync(join(REPO, 'test', 'smoke-cleanup.md'), 'utf8')
  // 列表裡縮排的區塊（6.5 的第 6 點）也算
  const blocks = [...md.matchAll(/^[ \t]*```(\w*)\n([\s\S]*?)^[ \t]*```/gm)].map(m => ({ lang: m[1], body: m[2], at: m.index }))
  const shell = blocks.filter(b => b.lang === 'bash' || b.lang === 'sh')
  const ps = blocks.filter(b => b.lang === 'powershell')
  /** 會讀寫資料的指令：CLI、server、隔離區 */
  const touches = /\bcli\.mjs\b|\bserver\.ts\b|\bcb\s+\w|CONTEXTBOX_QUARANTINE"|~\/|\$HOME\b/
  const setupOf = list => list.find(b => /CONTEXTBOX_CONFIG/.test(b.body))
  const setup = setupOf(shell) ?? { body: '', at: -1 }
  const psSetup = setupOf(ps) ?? { body: '', at: -1 }

  test('第一個動資料的指令之前，沙盒已經設好：CONFIG／DB／QUARANTINE 與家目錄都指到沙盒', () => {
    assert.ok(setup.at >= 0, '找不到設定沙盒的 bash 區塊')
    for (const v of ['CONTEXTBOX_CONFIG', 'CONTEXTBOX_DB', 'CONTEXTBOX_QUARANTINE', 'CONTEXTBOX_TOKEN_PATH', 'HOME']) {
      assert.match(setup.body, new RegExp(`export ${v}="\\$SANDBOX/`), `沙盒區塊沒有把 ${v} 指到 $SANDBOX`)
    }
    assert.match(setup.body, /export SANDBOX="\$\(mktemp -d\)"/, '沙盒要是一個新的暫存資料夾')
    // 設定檔的清理範圍要是沙盒（cleanup.roots），而且截圖資料夾不加進來
    assert.match(setup.body, /"cleanup":\s*\{\s*"roots":\s*\["\$HOME\/Downloads"\]/, 'cleanup.roots 沒指到沙盒')
    assert.match(setup.body, /"screenshots":\s*false/)
    const firstUse = shell.find(b => b !== setup && touches.test(b.body))
    assert.ok(firstUse && firstUse.at > setup.at, '有指令在沙盒設好之前就動了資料')
    // PowerShell 也一樣
    assert.ok(psSetup.at >= 0, '找不到 PowerShell 的沙盒區塊')
    assert.match(psSetup.body, /\$env:USERPROFILE = Join-Path \$env:SANDBOX/)
    for (const v of ['CONTEXTBOX_CONFIG', 'CONTEXTBOX_DB', 'CONTEXTBOX_QUARANTINE']) {
      assert.match(psSetup.body, new RegExp(`\\$env:${v} = "\\$env:SANDBOX\\\\`), `PowerShell 沒有把 ${v} 指到沙盒`)
    }
    for (const b of ps) if (b !== psSetup) assert.ok(b.at > psSetup.at, 'PowerShell 有指令在沙盒設好之前')
    // PowerShell 的 ~ 是分頁開啟時的家目錄，不跟著 $env:USERPROFILE 走 —— 寫 ~ 就會進到真的 Downloads
    for (const b of ps) {
      for (const line of b.body.split('\n')) {
        assert.ok(!/(^|[\s"'(])~[\\/]/.test(line.replace(/#.*$/, '')), `PowerShell 用了 ~（會是真的家目錄）：${line.trim()}`)
      }
    }
  })

  test('每一個 CLI 指令都走 cb（沙盒守門），不直接 node cli.mjs', () => {
    const guard = shellFn(setup.body, 'sandbox_ok')
    assert.match(guard, /return 1/, '守門要在沙盒不對的時候回 1')
    assert.match(guard, /\[ -z "\$SANDBOX" \]/, '守門要先擋 SANDBOX 是空的')
    for (const v of ['CONTEXTBOX_CONFIG', 'CONTEXTBOX_DB', 'CONTEXTBOX_QUARANTINE', 'CONTEXTBOX_TOKEN_PATH', 'HOME']) {
      assert.match(guard, new RegExp(`\\$${v}" != "\\$SANDBOX/`), `守門沒有檢查 ${v}`)
    }
    const cb = shellFn(setup.body, 'cb')
    assert.match(cb, /^cb\(\)\s*\{\n\s*sandbox_ok \|\| return 1\n/, 'cb 第一件事是守門')
    const direct = []
    for (const b of shell) {
      const body = b === setup ? b.body.replace(cb, '') : b.body
      for (const line of body.split('\n')) {
        if (/\bnode\b[^\n]*(?:cli\.mjs|server\.ts)/.test(line)) direct.push(line.trim())
      }
    }
    assert.deepEqual(direct, [], '這些指令繞過了沙盒守門')
  })

  test('會清檔、刪檔的每一步都在沙盒裡：apply／--empty 只透過 cb', () => {
    const risky = []
    for (const b of [...shell, ...ps]) {
      for (const line of b.body.split('\n')) {
        if (/cleanup\s+(?:apply|undo)|--empty/.test(line) && !/^\s*(?:CONTEXTBOX_READONLY=1\s+)?cb\s/.test(line)) risky.push(line.trim())
      }
    }
    assert.deepEqual(risky, [])
  })

  // ── 第三波 D1：不經過 cb、直接寫資料的那幾行 ──

  test('會直接改資料庫、改檔案時間、刪檔的每一行都站在守門後面（D1）', () => {
    const bad = [...shell, ...ps].flatMap(b => unguardedWrites(b.body))
    assert.deepEqual(bad, [], '這些行不經過 cb，要自己守門（sandbox_ok）')
  })

  test('守門寫法的檢查本身：舊版的 case、裸的 touch、直接設 LastWriteTime 都抓得到（D1）', () => {
    // 舊版第 6 步：SANDBOX 是空字串時樣式變成 "/"*，任何絕對路徑都放行
    const oldStep6 = 'case "$CONTEXTBOX_DB" in\n  "$SANDBOX"/*) node -e \'new DatabaseSync(p).prepare("UPDATE t SET a = 1")\' ;;\n  *) echo no ;;\nesac'
    assert.equal(unguardedWrites(oldStep6).length, 1)
    assert.equal(unguardedWrites("touch -d '3 days ago' a.zip").length, 1)
    assert.equal(unguardedWrites('(Get-Item a.zip).LastWriteTime = (Get-Date).AddDays(-3)').length, 1)
    assert.equal(unguardedWrites('rm -rf "$SANDBOX"').length, 1)
    assert.equal(unguardedWrites('sandbox_touch() {\n  node -e \'utimesSync(f, t, t)\'\n}').length, 1, '函式沒有先守門')
    // 放得過的寫法
    assert.deepEqual(unguardedWrites('if sandbox_ok && [ "$CONTEXTBOX_DB" = "$SANDBOX/data.db" ]; then\n  node -e \'new DatabaseSync(p)\'\nfi'), [])
    assert.deepEqual(unguardedWrites('sandbox_touch() {\n  sandbox_ok || return 1\n  node -e \'utimesSync(f, t, t)\'\n}'), [])
    assert.deepEqual(unguardedWrites('function sandbox_touch([string]$d) {\n  if (-not (sandbox_ok)) { return }\n  $f.LastWriteTime = $t\n}'), [])
    assert.deepEqual(unguardedWrites('sandbox_ok && rm -rf "$SANDBOX"'), [])
    assert.deepEqual(unguardedWrites('if (sandbox_ok) { Remove-Item -Recurse -Force $env:SANDBOX }'), [])
  })

  test('第 6 步撥隔離時間：沙盒不對就不撥，SANDBOX 是空字串也一樣（真的用 bash 跑，D1）', { skip: NO_BASH }, t => {
    const w = smokeWorld()
    t.after(w.done)
    const at = md.indexOf('## 6 ・')
    const block = shell.find(b => b.at > at && /DatabaseSync/.test(b.body))?.body ?? ''
    const guarded = /^if [^\n]*then\n[\s\S]*?^fi$/m.exec(block)?.[0]
    assert.ok(guarded, '第 6 步撥時間要包在 if … fi 裡')
    const script = shellFn(setup.body, 'sandbox_ok') + '\n' + guarded

    const mkdb = path => {
      const d = new DatabaseSync(path)
      d.exec('CREATE TABLE cleanup_move_details (seq INTEGER PRIMARY KEY, completed_at TEXT)')
      d.prepare('INSERT INTO cleanup_move_details VALUES (1, ?)').run(new Date().toISOString())
      d.close()
      return path
    }
    const age = path => {
      const d = new DatabaseSync(path)
      const r = d.prepare('SELECT completed_at FROM cleanup_move_details').get()
      d.close()
      return Date.now() - Date.parse(r.completed_at)
    }
    const realDb = mkdb(w.realEnv.CONTEXTBOX_DB)
    const sbDb = mkdb(w.good.CONTEXTBOX_DB)
    const otherDb = mkdb(join(w.sb + '-other', 'data.db'))
    const untouched = () => [realDb, sbDb, otherDb].every(p => age(p) < 60_000)

    for (const [why, env] of [
      ['SANDBOX 是空字串（舊版的樣式變成 "/"*，任何絕對路徑都放行）', { ...w.realEnv, SANDBOX: '' }],
      ['SANDBOX 沒設（沒跑第 0 步的分頁）', w.realEnv],
      ['沙盒設好了，CONTEXTBOX_DB 卻指到真的', { ...w.good, CONTEXTBOX_DB: realDb }],
      ['前綴陷阱：$SANDBOX-other/data.db', { ...w.good, CONTEXTBOX_DB: otherDb }],
      ['用 .. 繞出沙盒', { ...w.good, CONTEXTBOX_DB: w.sb + '/../real/.contextbox/data.db' }],
    ]) {
      const r = bash(script, env)
      assert.ok(untouched(), `${why}：不可以撥（${r.stdout}${r.stderr}）`)
    }
    // 對照組：沙盒對 —— 真的撥成八天前，別的資料庫不動（不然上面全部「沒撥」也可能只是那段壞了）
    const r = bash(script, w.good)
    assert.equal(r.status, 0, r.stderr)
    assert.ok(Math.abs(age(sbDb) - 8 * 86400_000) < 300_000, `沙盒的資料庫要撥成八天前（${r.stderr}）`)
    assert.ok(age(realDb) < 60_000 && age(otherDb) < 60_000)
  })

  test('sandbox_touch 只撥沙盒 Downloads 裡的檔（真的用 bash 跑，D1）', { skip: NO_BASH }, t => {
    const w = smokeWorld()
    t.after(w.done)
    const fns = shellFn(setup.body, 'sandbox_ok') + '\n' + shellFn(setup.body, 'sandbox_touch')
    assert.match(fns, /^sandbox_touch\(\)/m, '第 0 步要定義 sandbox_touch')
    const dl = join(w.good.HOME, 'Downloads')
    const realFile = join(w.real, 'Downloads', 'mine.zip')
    const sibling = join(w.good.HOME, 'Downloads-old', 'keep.zip')   // 名字開頭一樣、但不在 Downloads 裡
    for (const p of [realFile, sibling, join(dl, 'a.zip'), join(dl, 'b.zip')]) writeFileSync(p, 'x')
    const ageMs = p => Date.now() - statSync(p).mtimeMs
    const untouched = () => [realFile, sibling, join(dl, 'a.zip')].every(p => ageMs(p) < 60_000)

    for (const [why, env, cmd, cwd] of [
      ['SANDBOX 是空字串', { ...w.realEnv, SANDBOX: '' }, `sandbox_touch -d '3 days ago' "$HOME/Downloads/mine.zip"`, w.real],
      ['沙盒設好了，檔案在真的 Downloads', w.good, `sandbox_touch -d '3 days ago' '${realFile}'`, dl],
      ['用 .. 繞出沙盒的 Downloads', w.good, `sandbox_touch -d '3 days ago' ../../../real/Downloads/mine.zip`, dl],
      ['前綴陷阱：Downloads-old 不是 Downloads', w.good, `sandbox_touch -d '3 days ago' ~/Downloads-old/keep.zip`, dl],
      ['一次給兩個、其中一個在外面：一個都不撥', w.good, `sandbox_touch -d '3 days ago' a.zip '${realFile}'`, dl],
      ['看不懂的時間', w.good, `sandbox_touch -d 'yesterday' a.zip`, dl],
      ['沒有 -d', w.good, 'sandbox_touch a.zip', dl],
    ]) {
      const r = bash(fns + '\n' + cmd, env, cwd)
      assert.notEqual(r.status, 0, `${why}：要回非零`)
      assert.ok(untouched(), `${why}：不可以撥`)
    }
    // 對照組：沙盒對、檔在沙盒的 Downloads（相對路徑與 ~ 開頭的都要能用）
    const r = bash(fns + `\nsandbox_touch -d '3 days ago' a.zip && sandbox_touch -d '2 hours ago' ~/Downloads/b.zip`, w.good, dl)
    assert.equal(r.status, 0, r.stderr)
    assert.ok(Math.abs(ageMs(join(dl, 'a.zip')) - 3 * 86400_000) < 300_000, '3 days ago 要撥成三天前')
    assert.ok(Math.abs(ageMs(join(dl, 'b.zip')) - 2 * 3600_000) < 300_000, '2 hours ago 要撥成兩小時前')
    assert.ok(ageMs(realFile) < 60_000)
  })

  test('cb：沙盒不對就不跑 CLI；對的話參數與前綴的環境變數都交給 CLI（真的用 bash 跑，D1／D3）', { skip: NO_BASH }, t => {
    const w = smokeWorld()
    t.after(w.done)
    // 一支假的 cli.mjs：只記下自己被叫到、拿到什麼
    const repo = join(w.root, 'repo'), mark = join(w.root, 'ran.json')
    mkdirSync(repo)
    writeFileSync(join(repo, 'cli.mjs'), `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(mark)}, JSON.stringify({ argv: process.argv.slice(2), port: process.env.CONTEXTBOX_PORT ?? null }))\n`)
    const ran = () => {
      if (!existsSync(mark)) return null
      const v = JSON.parse(readFileSync(mark, 'utf8'))
      rmSync(mark)
      return v
    }
    const fns = shellFn(setup.body, 'sandbox_ok') + '\n' + shellFn(setup.body, 'cb')
    for (const [why, env] of [
      ['SANDBOX 是空字串', { ...w.realEnv, SANDBOX: '' }],
      ['HOME 是真的', { ...w.good, HOME: w.real }],
      ['資料庫是真的', { ...w.good, CONTEXTBOX_DB: w.realEnv.CONTEXTBOX_DB }],
    ]) {
      const r = bash(fns + '\ncb doctor', { ...env, REPO: repo })
      assert.notEqual(r.status, 0, `${why}：要回非零`)
      assert.equal(ran(), null, `${why}：cb 不可以跑 CLI`)
    }
    assert.equal(bash(fns + '\ncb doctor', { ...w.good, REPO: repo }).status, 0)
    assert.deepEqual(ran(), { argv: ['doctor'], port: null })
    // 6.5 的那一行：CONTEXTBOX_PORT=0 只給這一次的 pet，背景跑也拿得到
    const pet = /^CONTEXTBOX_PORT=0 cb pet &.*$/m.exec(sectionOf(md, '## 6.5 ・'))?.[0]
    assert.ok(pet, '6.5 要用 CONTEXTBOX_PORT=0 cb pet &')
    assert.equal(bash(fns + '\n' + pet + '\nwait', { ...w.good, REPO: repo }).status, 0)
    assert.deepEqual(ran(), { argv: ['pet'], port: '0' })
  })

  test('PowerShell 的區塊語法都讀得懂；sandbox_touch 沙盒不對就不撥（D1）', { skip: !PS && '這台沒有 PowerShell' }, t => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-smoke-ps-')))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const q = s => `'${s.replaceAll("'", "''")}'`
    for (const [i, b] of ps.entries()) {
      const f = join(dir, `block${i}.ps1`)
      writeFileSync(f, '\uFEFF' + b.body)
      const r = powershell(`$t = $null; $e = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(${q(f)}, [ref]$t, [ref]$e)
$e | ForEach-Object { $_.Message }
exit $e.Count`, {}, dir)
      assert.equal(r.status, 0, `PowerShell 第 ${i + 1} 個區塊讀不懂：${r.stdout}${r.stderr}`)
    }
    const fns = psFn(psSetup.body, 'sandbox_ok') + '\n' + psFn(psSetup.body, 'sandbox_touch')
    assert.match(fns, /^function sandbox_touch\b/m, 'PowerShell 的第 0 步要定義 sandbox_touch')
    // 跟文件一樣用 \ 接（Windows 是正常路徑；Linux／macOS 上 PowerShell 也把 \ 當分隔）
    const sb = join(dir, 'sb'), home = sb + '\\home'
    const dl = join(sb, 'home', 'Downloads'), outside = join(dir, 'mine.zip')
    mkdirSync(dl, { recursive: true })
    const good = {
      SANDBOX: sb, USERPROFILE: home, CONTEXTBOX_CONFIG: sb + '\\config.json', CONTEXTBOX_DB: sb + '\\data.db',
      CONTEXTBOX_QUARANTINE: sb + '\\quarantine', CONTEXTBOX_TOKEN_PATH: sb + '\\token',
    }
    const f = join(dl, 'a.zip')
    for (const p of [f, outside]) writeFileSync(p, 'x')
    const ageMs = p => Date.now() - statSync(p).mtimeMs
    const run = (cmd, env) => powershell(`${fns}\nSet-Location -LiteralPath ${q(dl)}\n${cmd}`, env, dir)
    for (const [why, cmd, env] of [
      ['SANDBOX 是空字串', "sandbox_touch -d '3 days ago' a.zip", { ...good, SANDBOX: '' }],
      ['一次給兩個、其中一個在外面：一個都不撥', `sandbox_touch -d '3 days ago' a.zip ${q(outside)}`, good],
    ]) {
      const r = run(cmd, env)
      assert.ok(ageMs(f) < 60_000 && ageMs(outside) < 60_000, `${why}：不可以撥（${r.stdout}${r.stderr}）`)
    }
    const r = run("sandbox_touch -d '3 days ago' a.zip", good)
    assert.ok(Math.abs(ageMs(f) - 3 * 86400_000) < 300_000, `對照組：沙盒對要真的撥（${r.stdout}${r.stderr}）`)
  })

  // ── 第三波 D2、D3 ──

  test('隔離區空了沒，用 find -type f 看：復原之後留下的空資料夾不算（D2）', { skip: NO_BASH }, t => {
    for (const b of shell) {
      for (const l of b.body.split('\n')) {
        assert.doesNotMatch(uncomment(l), /\bls\s+-\w*R/, `ls -R 連空資料夾都會印，永遠「有東西」：${l.trim()}`)
      }
    }
    for (const h of ['## 4 ・', '## 7 ・']) {
      assert.match(sectionOf(md, h), /find "\$CONTEXTBOX_QUARANTINE" -type f/, `${h} 要用 find -type f 看隔離區空了沒`)
    }
    assert.equal((sectionOf(md, '## 5 ・').match(/find "\$CONTEXTBOX_QUARANTINE" -type f \| wc -l/g) ?? []).length, 2,
      '第 5 步重送前後各數一次隔離區的檔案')
    // 真的跑第 7 步那一行：只剩空資料夾 → 沒有輸出；有一個檔 → 印出來
    const line = sectionOf(md, '## 7 ・').split('\n').find(l => /"\$CONTEXTBOX_QUARANTINE"/.test(l)) ?? ''
    const qdir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-smoke-q-')))
    t.after(() => rmSync(qdir, { recursive: true, force: true }))
    mkdirSync(join(qdir, 'plan-1', 'item-1'), { recursive: true })
    assert.equal(bash(line, { CONTEXTBOX_QUARANTINE: qdir }).stdout.trim(), '', `只剩空資料夾要沒有輸出：${line.trim()}`)
    writeFileSync(join(qdir, 'plan-1', 'item-1', 'content'), 'x')
    assert.notEqual(bash(line, { CONTEXTBOX_QUARANTINE: qdir }).stdout.trim(), '', '還有檔案要印出來')
  })

  test('zsh：先單獨開 interactivecomments，再貼沙盒那一大段（D3）', () => {
    const zsh = shell.find(b => /setopt interactivecomments/.test(b.body))
    assert.ok(zsh, '第 0 步要有 setopt interactivecomments（zsh 預設把行尾的 # 當參數）')
    // 跟沙盒那一段一起貼的話，zsh 會把整段一起讀完才執行 —— 同一次貼上的行尾註解還是不認
    assert.equal(zsh.body.trim(), '[ -n "$ZSH_VERSION" ] && setopt interactivecomments', '這一行要自己一個區塊')
    assert.ok(zsh.at < setup.at, '要在沙盒那一段之前')
    assert.ok(shell.every(b => b.at >= zsh.at), '它之前不可以有別的 shell 區塊')
  })

  test('PowerShell 跑不了第 4–6 步，要講清楚；那幾步也沒有 PowerShell 區塊（D3）', () => {
    assert.match(sectionOf(md, '## 0 ・'), /PowerShell 跑不了第 4–6 步/)
    for (const h of ['## 4 ・', '## 5 ・', '## 6 ・', '## 6.5 ・']) {
      assert.doesNotMatch(sectionOf(md, h), /```powershell/, `${h} 有 PowerShell 區塊，跟「跑不了」矛盾`)
    }
    // 以前寫「之後各步的 bash 指令在 PowerShell 裡一樣打 cb …」：第 3 步的
    // `CONTEXTBOX_READONLY=1 cb …` 與 `$?` 在 PowerShell 都不是那樣
    assert.doesNotMatch(md, /之後各步的 bash 指令在 PowerShell 裡一樣打/)
    assert.match(sectionOf(md, '## 0 ・'), /\$LASTEXITCODE/, '要講 PowerShell 看離開碼用 $LASTEXITCODE')
  })

  test('過時的描述拿掉了：沒有「回 409」', () => {
    assert.doesNotMatch(md, /\b409\b/)
  })

  test('同名衝突用一個新檔做（復原過的檔不會再被提議）', () => {
    const sec = md.slice(md.indexOf('### 同名衝突'), md.indexOf('\n## 5'))
    assert.ok(sec.length > 20, '找不到同名衝突那一段')
    const code = [...sec.matchAll(/```bash\n([\s\S]*?)```/g)].map(m => m[1]).join('\n')
    const step1 = /```bash\ncd ~\/Downloads\n([\s\S]*?)```/.exec(md)?.[1] ?? ''
    const oldNames = [...step1.matchAll(/>\s*'?(smoke-[^\s']+)/g)].map(m => m[1])
    const created = [...code.matchAll(/>\s*~\/Downloads\/(smoke-[^\s']+)/g)].map(m => m[1])
    assert.ok(created.length, '同名衝突那一段沒有建新檔')
    assert.ok(created.every(n => !oldNames.includes(n)), `同名衝突用了第 1 步的檔：${created.join('、')}（復原過的不會再被提議）`)
    const scan = code.indexOf('cb cleanup scan'), apply = code.indexOf('cb cleanup apply')
    assert.ok(scan >= 0 && apply > scan, '新檔要先掃描，才會出現在清單上')
    assert.match(code, /touch -d/, '新檔要往回撥時間，不然十分鐘內搬不動')
  })

  test('畫面那段用同一組環境變數起 server，網址帶 ?k=，不去搶平常那一個的 port（D3）', () => {
    const sec = sectionOf(md, '## 6.5 ・')
    assert.ok(sec.length > 20, '找不到畫面那一段')
    assert.match(sec, /^CONTEXTBOX_PORT=0 cb pet &/m, 'server 要透過 cb 起（同一組沙盒環境變數），port 給 0')
    assert.match(sec, /\?k=/, '要講清楚網址帶 ?k=')
    assert.doesNotMatch(sec, /node core\/server\.ts/, '直接 node core/server.ts 會繞過沙盒守門')
    assert.doesNotMatch(sec, /關掉你平常/, '不要叫使用者關掉平常的 pet —— port 0 不會跟它撞')
    assert.doesNotMatch(sec, /已經有一個 ContextBox 在跑了/, 'port 0 不會撞 port，那段說明過時了')
    // export 的話之後的 cb open 也拿到 0，就找不到沙盒的 pet 了
    assert.doesNotMatch(md, /export CONTEXTBOX_PORT/, 'CONTEXTBOX_PORT 只給 pet 那一行')
  })
})
