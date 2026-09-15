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
