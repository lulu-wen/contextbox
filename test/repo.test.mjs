/**
 * repo 層級的規則。
 *
 * 這一支守的是兩條寫在文件裡、但以前沒有任何東西在檢查的規則。
 * 「規則寫在註解裡」等於沒有規則。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

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

test('docs/api 的範例不可以有真實絕對路徑', () => {
  // 這些檔是從真的程式輸出產生的，產生腳本跑在誰的機器上就會帶誰的家目錄。
  // C 會把它們當 mock 端出來，也會進 git 歷史。
  const dir = join(REPO, 'docs', 'api')
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const s = readFileSync(join(dir, f), 'utf8')
    for (const bad of [/\/home\/(?!alice\b)[a-z0-9_-]+/i, /\/Users\/(?!alice\b)[a-z0-9_-]+/i,
                       /C:\\Users\\(?!Alice\b)/i, /\/tmp\/claude/, /\/var\/folders\//]) {
      assert.ok(!bad.test(s), `${f} 裡有真實路徑：${s.match(bad)?.[0]}`)
    }
  }
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
