/**
 * 資料庫的測試。
 *
 * 重點是**第一次使用**：Windows 右鍵一次選 8 個檔，就是 8 個行程
 * 同時開一個還不存在的資料庫。這件事以前會炸掉 11/12。
 */
import { test, describe, before, after } from 'node:test'
import { rmTmp } from './helpers/rm.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, chmodSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { open } from '../core/db.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
let root
before(() => { root = mkdtempSync(join(tmpdir(), 'cb-db-')) })
after(() => rmTmp(root))

let n = 0
const tmp = () => { const d = join(root, 'c' + n++); mkdirSync(d, { recursive: true }); return d }

describe('同時被很多個行程打開', () => {
  test('全新的資料庫，12 個一起開，不可以有人被鎖在外面', async () => {
    // busy_timeout 一定要是第一個 pragma。設在 journal_mode = WAL 後面的話
    // 等於沒設 —— WAL 自己就要拿鎖，實測 12 個裡只有 1 個活下來。
    const dbPath = join(tmp(), 'race.db')
    const script = join(root, 'open.mjs')
    writeFileSync(script,
      `import { open } from ${JSON.stringify(join(REPO, 'core/db.ts'))}\n`
      + `open(process.argv[2])\n`)

    const runs = Array.from({ length: 12 }, () => new Promise(resolve => {
      const p = spawn(process.execPath, ['--experimental-strip-types', script, dbPath],
        { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      p.stderr.on('data', d => { err += d })
      p.on('close', code => resolve({ code, err }))
    }))
    const rs = await Promise.all(runs)
    const failed = rs.filter(r => r.code !== 0)
    assert.equal(failed.length, 0,
      `${failed.length}/12 被鎖在外面：${failed[0]?.err.split('\n').find(l => /Error/.test(l)) ?? ''}`)
  })

  test('busy_timeout 真的設進去了', () => {
    const db = open(join(tmp(), 'x.db'))
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 15000)
  })
})

describe('權限', () => {
  test('自己建的資料夾鎖起來，資料庫檔案 0600', () => {
    const dir = join(tmp(), 'mine')
    const p = join(dir, 'data.db')
    open(p)
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(statSync(p).mode & 0o777, 0o600)
  })

  test('**別人的資料夾不可以動**', () => {
    // 以前是無條件 chmod(dirname(path), 0o700)，所以 CONTEXTBOX_DB 指到哪，
    // 哪個資料夾就被改成只有自己讀得到 —— 連裡面別人的檔案一起鎖住，還不出聲。
    const shared = join(tmp(), 'shared')
    mkdirSync(shared, { recursive: true })
    chmodSync(shared, 0o755)
    writeFileSync(join(shared, '別人的檔案.txt'), 'x')

    open(join(shared, 'cb.db'))
    assert.equal(statSync(shared).mode & 0o777, 0o755, '不是我們建的資料夾就不要碰它的權限')
  })
})

describe('合法值寫在資料庫裡，不是只寫在型別註解裡', () => {
  test('打錯的 kind 與 status 進不去', () => {
    const db = open(':memory:')
    const ins = (kind, status) => db.prepare(
      `INSERT INTO items (id,path,sha256,kind,mime,bytes,mtime,seen_at,status)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(String(Math.random()), '/p' + Math.random(), 's', kind, 'm', 1, 't', 't', status)

    assert.throws(() => ins('打錯的kind', 'new'))
    assert.throws(() => ins('image', '打錯的狀態'))
    ins('image', 'new')            // 正常的要進得去
  })
})
