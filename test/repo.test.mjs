/**
 * repo 層級的規則。
 *
 * 這一支守的是寫在文件裡、但以前沒有任何東西在檢查的規則。
 * 「規則寫在註解裡」等於沒有規則。
 *
 * 2026-09-19 稽核第二波（文件與測試）加了：docs/api 範例跟產生器的真實輸出比欄位（RC20）、
 * README 只留一張錯誤表而且跟 HTTP_FOR_CODE 對得上、smoke 文件全程在沙盒（RC18）、
 * spawn cli.mjs 的測試一定給子行程假的 HOME（RC22）、cli.md 照 RC13 的行為寫。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { HTTP_FOR_CODE } from '../core/cleanup-routes.ts'

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

  test('/health 的每一個欄位 README 都有講到（欄位改過名，要寫清楚）', () => {
    const h = JSON.parse(readFileSync(join(REPO, 'docs', 'api', 'health-with-token.json'), 'utf8'))
    const keys = [...Object.keys(h), ...Object.keys(h.watcher).map(k => 'watcher.' + k), ...Object.keys(h.quarantine).map(k => 'quarantine.' + k)]
    // `watcher` 這種物件欄位：講到它底下任何一個（`watcher.ok`）就算有講
    const mentioned = k => md.includes('`' + k + '`') || md.includes('`' + k + '.') || md.includes('`' + k.split('.').pop() + '`')
    const missing = keys.filter(k => !mentioned(k))
    assert.deepEqual(missing, [], 'README 沒講到這些 /health 欄位')
    assert.match(md, /lastQuarantinedAt/, '舊欄位 lastQuarantinedAt 拿掉了，README 要講')
  })

  test('GET /cleanup/plans 不帶篩選時的形狀有寫清楚', () => {
    const list = JSON.parse(readFileSync(join(REPO, 'docs', 'api', 'cleanup-plans-list.json'), 'utf8'))
    const section = md.slice(md.indexOf('### `GET /cleanup/plans`'))
    assert.ok(md.includes('### `GET /cleanup/plans`'), '找不到 GET /cleanup/plans 那一段')
    assert.match(section, /不帶篩選/)
    const keys = Object.keys(list.operations[0] ?? {})
    assert.ok(keys.length >= 8, '前提：範例裡有計畫')
    const missing = keys.filter(k => !section.includes('`' + k + '`'))
    assert.deepEqual(missing, [], 'GET /cleanup/plans 那一段沒講到這些欄位')
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

describe('test/smoke-cleanup.md 全程在沙盒裡（RC18）', () => {
  const md = readFileSync(join(REPO, 'test', 'smoke-cleanup.md'), 'utf8')
  const blocks = [...md.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map(m => ({ lang: m[1], body: m[2], at: m.index }))
  const shell = blocks.filter(b => b.lang === 'bash' || b.lang === 'sh')
  const ps = blocks.filter(b => b.lang === 'powershell')
  /** 會讀寫資料的指令：CLI、server、隔離區 */
  const touches = /\bcli\.mjs\b|\bserver\.ts\b|\bcb\s+\w|CONTEXTBOX_QUARANTINE"|~\/|\$HOME\b/
  const setupOf = list => list.find(b => /CONTEXTBOX_CONFIG/.test(b.body))

  test('第一個動資料的指令之前，沙盒已經設好：CONFIG／DB／QUARANTINE 與家目錄都指到沙盒', () => {
    const setup = setupOf(shell)
    assert.ok(setup, '找不到設定沙盒的 bash 區塊')
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
    const psSetup = setupOf(ps)
    assert.ok(psSetup, '找不到 PowerShell 的沙盒區塊')
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
    const setup = setupOf(shell)
    const guard = /cb\(\)\s*\{[\s\S]*?\n\}/.exec(setup.body)?.[0] ?? ''
    assert.match(guard, /return 1/, 'cb 要在沙盒不對的時候拒絕執行')
    for (const v of ['CONTEXTBOX_CONFIG', 'CONTEXTBOX_DB', 'CONTEXTBOX_QUARANTINE', 'HOME']) {
      assert.match(guard, new RegExp(`\\$${v}" != "\\$SANDBOX/`), `cb 沒有檢查 ${v}`)
    }
    const direct = []
    for (const b of shell) {
      const body = b === setup ? b.body.replace(guard, '') : b.body
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

  test('畫面那段用同一組環境變數起 server，網址帶 ?k=', () => {
    const sec = md.slice(md.indexOf('## 6.5'), md.indexOf('\n## 7'))
    assert.ok(sec.length > 20, '找不到畫面那一段')
    assert.match(sec, /cb pet/, 'server 要透過 cb 起（同一組沙盒環境變數）')
    assert.match(sec, /\?k=/, '要講清楚網址帶 ?k=')
    assert.doesNotMatch(sec, /node core\/server\.ts/, '直接 node core/server.ts 會繞過沙盒守門')
  })
})
