import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * 2026-09-19 稽核第二波「文件與測試」那一份（RC21 假綠、RC22 測試衛生）。
 *
 * 期望值照 ~/contextbox-稽核-20260919.md 寫死：
 *   - RC21 Retry-After：503 BUSY **要真的帶** `Retry-After: 2`，只斷言 503 是假綠
 *   - RC21 重送冪等：重送不可以再寫任何東西；原位置又出現一模一樣的檔也不可以搬第二次
 *   - RC22：isolate-home 在行程結束時把自己的暫存家目錄刪掉（正常結束、exit、丟例外、SIGTERM）
 *
 * 每一條都做過突變：把修正拿掉，這裡要紅。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, existsSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { request } from 'node:http'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { start } from '../core/server.ts'
import { fixture } from './helpers/cleanup.mjs'
import { rmTmp } from './helpers/rm.mjs'
import { cleanupRoutes } from '../core/cleanup-routes.ts'
import { createPlan } from '../core/cleanup-plans.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const DAY = 86400_000

// ═══ RC21 ・ Retry-After ═════════════════════════════════════

describe('RC21 503 BUSY 要帶 Retry-After', () => {
  test('**另一個清理動作正在跑時，會拿鎖的每一條都回 503 + Retry-After: 2**', async t => {
    // 上一版的測試只斷言 statusFor('BUSY') === 503 —— header 拿掉照樣綠。
    // 這裡走真的 HTTP，看 response header。
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-busy-')))
    const dl = join(dir, 'Downloads')
    mkdirSync(dl)
    for (const n of ['a.zip', 'b.zip']) {
      writeFileSync(join(dl, n), 'content ' + n)
      const old = new Date(Date.now() - 60 * DAY)
      utimesSync(join(dl, n), old, old)
    }
    const dbPath = join(dir, 'data.db')
    const TOKEN = 'busy-token'
    const S = start({ port: 0, db: dbPath, token: TOKEN, roots: [dl], quarantine: join(dir, 'q'), maxBytes: 1 << 20, readonly: false })
    const port = await S.ready
    let db = null
    // 收尾順序：先關資料庫與 server，再刪資料夾（Windows 上開著的檔刪不掉）
    t.after(() => { db?.close(); globalThis.__cbStopPage?.(); S.server.closeAllConnections(); S.server.close(); S.server.unref(); try { S.facts?.db?.close() } catch { /* 已經關了 */ }; rmTmp(dir) })

    const call = (method, path, body) => new Promise((ok, fail) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = request({ host: '127.0.0.1', port, method, path, headers: {
        'x-contextbox-token': TOKEN, 'content-type': 'application/json',
        ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
      } }, res => {
        let s = ''
        res.on('data', c => s += c)
        res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: JSON.parse(s) }))
      })
      req.on('error', fail)
      if (payload) req.write(payload)
      req.end()
    })

    assert.equal((await call('POST', '/cleanup/scan', {})).status, 200)
    const plan = await call('POST', '/cleanup/plans', {})
    assert.equal(plan.status, 200, JSON.stringify(plan.body))

    // 假裝另一個行程握著鎖（owner 是「時間 id」，30 分鐘內算活的）
    db = new DatabaseSync(dbPath)
    db.prepare('INSERT OR REPLACE INTO cleanup_operation_lock VALUES (1,?,?)')
      .run(process.pid, `${new Date().toISOString()} ${randomUUID()}`)

    const busy = [
      ['POST', `/cleanup/plans/${plan.body.id}/apply`],
      ['POST', `/cleanup/plans/${plan.body.id}/undo`],
      ['POST', `/cleanup/plans/${plan.body.id}/dismiss`],
      ['POST', `/cleanup/plans/${plan.body.id}/release`],
      ['POST', '/cleanup/quarantine/empty'],
    ]
    for (const [method, path] of busy) {
      const r = await call(method, path, {})
      assert.equal(r.status, 503, `${method} ${path} 回了 ${r.status}：${JSON.stringify(r.body)}`)
      assert.equal(r.body.code, 'BUSY', `${method} ${path}`)
      assert.equal(r.headers['retry-after'], '2', `${method} ${path} 的 503 沒有帶 Retry-After: 2`)
    }

    // 鎖放開之後同一個請求就成功 —— 證明上面的 503 是因為鎖，不是別的
    db.prepare('DELETE FROM cleanup_operation_lock').run()
    const ok = await call('POST', `/cleanup/plans/${plan.body.id}/apply`, {})
    assert.equal(ok.status, 200)
    assert.equal(ok.headers['retry-after'], undefined, '成功的回應不該帶 Retry-After')
  })
})

// ═══ RC21 ・ 重送冪等（加強版） ═══════════════════════════════

/** 直接打 route（跟 cleanup-wire.test.mjs 同一種做法）。 */
function route(f, method, path, body = {}) {
  let got = null
  cleanupRoutes({
    db: f.db, roots: f.opts.roots, quarantine: f.opts.quarantine, maxBytes: f.opts.maxBytes, readonly: false,
    url: new URL('http://x' + path), method, body, send: (code, payload) => { got = { code, body: payload } }, scan: f.scan,
  })
  return got
}

describe('RC21 重送 apply 不可以搬第二次', () => {
  test('**原位置又出現一模一樣的檔（內容、大小、時間都一樣），重送也不可以把它搬走**', t => {
    // 這是「搬第二次」唯一可能發生的情況：快照驗證只看大小、時間、sha256，
    // 一份一模一樣的新檔會通過驗證。重送如果忘了「已經搬過」，就會把使用者新下載的那份也搬走。
    // quarantinedCount 是 DISTINCT 算的，這時候它還是 2 —— 所以要看檔案本身與 journal。
    const f = fixture(t)
    const p = createPlan(f.db)
    const first = route(f, 'POST', `/cleanup/plans/${p.id}/apply`)
    assert.equal(first.code, 200)
    assert.equal(first.body.quarantinedCount, 2)
    assert.ok(!existsSync(join(f.downloads, 'a.zip')), '前提：第一次真的搬走了')

    writeFileSync(join(f.downloads, 'a.zip'), 'archive a')   // fixture 的原內容
    utimesSync(join(f.downloads, 'a.zip'), f.old, f.old)
    const journal = () => f.db.prepare('SELECT seq, op, status FROM cleanup_journal ORDER BY seq').all()
    const inQuarantine = () => {
      const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : [e.name])
      return walk(f.opts.quarantine).length
    }
    const before = { journal: journal(), q: inQuarantine() }

    const second = route(f, 'POST', `/cleanup/plans/${p.id}/apply`)
    assert.equal(second.code, 200)
    assert.ok(existsSync(join(f.downloads, 'a.zip')), '使用者新下載的 a.zip 被重送搬走了')
    assert.deepEqual(journal(), before.journal, '重送寫了新的 journal')
    assert.equal(inQuarantine(), before.q, '隔離區多了東西')
    assert.equal(second.body.status, first.body.status)
  })
})

// ═══ RC22 ・ isolate-home 收拾自己 ═══════════════════════════

describe('RC22 isolate-home 在行程結束時刪掉暫存家目錄', () => {
  const helper = pathToFileURL(join(REPO, 'test', 'helpers', 'isolate-home.mjs')).href
  /** 子行程：import isolate-home、在假家目錄裡寫一點東西、印出路徑，再照 tail 結束。 */
  const script = (tail) => [
    `import { FAKE_HOME } from ${JSON.stringify(helper)}`,
    `import { mkdirSync, writeFileSync, existsSync } from 'node:fs'`,
    `import { join } from 'node:path'`,
    `mkdirSync(join(FAKE_HOME, '.contextbox', 'quarantine'), { recursive: true })`,
    `writeFileSync(join(FAKE_HOME, '.contextbox', 'quarantine', 'x.bin'), 'x')`,
    `console.log(JSON.stringify({ home: FAKE_HOME, existed: existsSync(FAKE_HOME) }))`,
    tail,
  ].join('\n')
  const env = () => ({ ...process.env, HOME: FAKE_HOME, USERPROFILE: FAKE_HOME })
  const check = (stdout) => {
    const info = JSON.parse(stdout.split('\n')[0])
    assert.equal(info.existed, true, '前提：跑的時候暫存家目錄在')
    assert.ok(basename(info.home).startsWith('cb-home-'), `前提：印出來的是 isolate-home 建的資料夾：${info.home}`)
    assert.ok(info.home !== FAKE_HOME, '前提：子行程有自己的一個')
    return info.home
  }

  for (const [label, tail, expectCode] of [
    ['正常結束', '', 0],
    ['process.exit(3)', 'process.exit(3)', 3],
    ['丟出沒接住的例外', "throw new Error('測試故意丟的')", 1],
  ]) {
    test(`**${label}** 之後暫存家目錄不在了`, () => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script(tail)], { encoding: 'utf8', env: env() })
      assert.equal(r.status, expectCode, r.stderr)
      const home = check(r.stdout)
      assert.ok(!existsSync(home), `${label} 之後 ${home} 還在 —— 每跑一次測試就在暫存資料夾留一個`)
    })
  }

  test('**被 SIGTERM 砍掉**（測試逾時被 runner 收掉）之後也要清', { skip: process.platform === 'win32' && 'Windows 沒有 SIGTERM' }, async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script('setInterval(() => {}, 1000)')], { env: env() })
    let out = ''
    const first = new Promise(ok => child.stdout.on('data', c => { out += c; if (out.includes('\n')) ok() }))
    const closed = new Promise(ok => child.on('close', (code, signal) => ok({ code, signal })))
    await first
    const home = check(out)
    child.kill('SIGTERM')
    const end = await closed
    assert.equal(end.signal, 'SIGTERM', '收拾完之後還是要用 SIGTERM 結束（不可以吞掉訊號、假裝正常結束）')
    assert.ok(!existsSync(home), `被 SIGTERM 之後 ${home} 還在`)
  })
})
