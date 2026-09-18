import { FAKE_HOME } from './helpers/isolate-home.mjs'
/**
 * 2026-09-19 稽核第二波：CLI（cli.mjs）。
 *
 * 期望值照 ~/contextbox-稽核-20260919.md 寫死，**先寫測試、再改 cli.mjs**：
 *   RC2（pet 那半）、RC12(2)、RC13、RC14（CLI）、RC15（CLI）、RC16（CLI）、RC17(3)，
 *   以及 CONFLICT 只看 proposed、scan／pet 印出 onProblem、doctor 分開算「讀不到」與「太大」。
 *
 * 每一條都在自己的暫存資料夾跑：假的 HOME、設定檔、資料庫、隔離區、token，
 * 子行程一律帶 HOME 與 CONTEXTBOX_QUARANTINE。pet 一律 port 0，不碰 7391。
 * 會打開瀏覽器的指令一律換成測試自己的記錄腳本（CONTEXTBOX_OPENER）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, realpathSync, existsSync,
  readFileSync, chmodSync, renameSync,
} from 'node:fs'
import { spawnSync, spawn } from 'node:child_process'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { open } from '../core/db.ts'
import { scanDownloads } from '../core/cleanup-scanner.ts'
import { createPlan } from '../core/cleanup-plans.ts'
import { applyPlan } from '../core/cleanup-exec.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(REPO, 'cli.mjs')
const DAY = 86400_000
const sleep = ms => new Promise(r => setTimeout(r, ms))

assert.ok(FAKE_HOME, '前提：測試行程的家目錄已經換掉')

/**
 * 一個完全隔離的 CLI 環境。HOME 就是這個暫存資料夾，所以 cleanup.roots 的預設
 * （~/Downloads）落在沙盒裡。
 */
function sandbox(t, { files = {}, config = {} } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cb-cli0919-')))
  const dl = join(home, 'Downloads')
  mkdirSync(dl)
  const p = {
    cfg: join(home, 'config.json'), db: join(home, 'data.db'), q: join(home, 'q'),
    token: join(home, 'token'), opened: join(home, 'opened.txt'), opener: join(home, 'opener.sh'),
  }
  // 「打開瀏覽器」換成記錄腳本：把收到的網址寫進 opened.txt
  writeFileSync(p.opener, '#!/bin/sh\nprintf \'%s\' "$1" > "$CB_OPENED"\n')
  chmodSync(p.opener, 0o755)
  let cfg = {
    watch: [dl], filed: join(home, 'Filed'),
    model: { baseUrl: '', name: '', keyEnv: 'CONTEXTBOX_MODEL_KEY' },
    readonly: false, pdfPages: 3, maxBytes: 20971520, ...config,
  }
  const writeCfg = (extra = {}) => { cfg = { ...cfg, ...extra }; writeFileSync(p.cfg, JSON.stringify(cfg)) }
  writeCfg()
  const put = (name, days = 60, content = 'x ' + name, dir = dl) => {
    mkdirSync(dir, { recursive: true })
    const f = join(dir, name)
    writeFileSync(f, content)
    const at = new Date(Date.now() - days * DAY)
    utimesSync(f, at, at)
    return f
  }
  for (const [n, d] of Object.entries(files)) put(n, d)
  const env = (extra = {}) => ({
    ...process.env,
    HOME: home, USERPROFILE: home,
    CONTEXTBOX_CONFIG: p.cfg, CONTEXTBOX_DB: p.db, CONTEXTBOX_QUARANTINE: p.q,
    CONTEXTBOX_TOKEN_PATH: p.token,
    CONTEXTBOX_OPENER: p.opener, CB_OPENED: p.opened,
    ...extra,
  })
  const run = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: env(extra), timeout: 60_000 })
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '' }
  }
  const dbs = []
  /** 測試自己的連線（用核心的 open，會建表） */
  const db = () => { const d = open(p.db); dbs.push(d); return d }
  const locked = []
  t.after(() => {
    for (const d of dbs) { try { d.close() } catch { /* 已經關了 */ } }
    for (const f of locked) { try { chmodSync(f, 0o755) } catch { /* 已經沒了 */ } }
    rmSync(home, { recursive: true, force: true })
  })
  /** chmod 000，測試結束會改回來才刪 */
  const lock = f => { chmodSync(f, 0o000); locked.push(f) }
  return { home, dl, p, put, run, env, db, writeCfg, lock }
}

/** 清單上印的編號：`[xxxx] ✔ name` → { name: code } */
function codes(out) {
  const m = {}
  for (const x of out.matchAll(/\[([0-9a-f-]{4,})\] [✔☐] (.+)$/gm)) m[x[2].trim()] = x[1]
  return m
}

const meta = (s, k) => {
  if (!existsSync(s.p.db)) return null
  const d = new DatabaseSync(s.p.db, { readOnly: true })
  try { d.exec('PRAGMA busy_timeout = 5000'); return d.prepare('SELECT v FROM meta WHERE k=?').get(k)?.v ?? null }
  finally { d.close() }
}
const count = (s, sql, ...a) => {
  const d = new DatabaseSync(s.p.db, { readOnly: true })
  try { d.exec('PRAGMA busy_timeout = 5000'); return d.prepare(sql).get(...a).n }
  finally { d.close() }
}
const planIdOf = out => /計畫 ([0-9a-f-]{36})/.exec(out)?.[1]

// ═══ RC15 ・ 清理一律用 cleanup.roots ═════════════════════════

describe('RC15 CLI 的清理範圍只有 cleanup.roots', () => {
  test('macOS 預設設定：桌面上 45 天前的 zip 不在清單上、不會被搬（稽查 a11）', t => {
    const s = sandbox(t)
    const desktop = join(s.home, 'Desktop')
    // 截圖功能的 watch 含桌面（macOS 預設）；沒有寫 cleanup，清理範圍要是預設的 ~/Downloads
    s.writeCfg({ watch: [desktop, s.dl] })
    const proposal = s.put('客戶提案-最終版.zip', 45, '還在用的東西', desktop)
    s.put('舊的.zip', 60)
    assert.equal(s.run(['cleanup', 'scan']).code, 0)
    const list = s.run(['cleanup', 'list'])
    assert.doesNotMatch(list.out, /客戶提案/, `桌面上的檔出現在清單上：\n${list.out}`)
    assert.match(list.out, /舊的\.zip/, '前提：Downloads 的舊檔要列出來')
    const r = s.run(['cleanup', 'apply'])
    assert.equal(r.code, 0, r.out)
    assert.ok(existsSync(proposal), `桌面上的檔被搬走了：\n${r.out}`)
    assert.ok(!existsSync(join(s.dl, '舊的.zip')), '前提：Downloads 的舊檔要被清')
    assert.equal(count(s, `SELECT count(*) n FROM file_items WHERE path LIKE ?`, desktop + '%'), 0,
      'cleanup scan 不可以去掃桌面')
  })

  test('舊資料庫裡桌面的候選（舊版 CLI 用 watch 掃的）也不列、不搬', t => {
    const s = sandbox(t)
    const desktop = join(s.home, 'Desktop')
    s.writeCfg({ watch: [desktop, s.dl] })
    const proposal = s.put('客戶提案-最終版.zip', 45, '還在用的東西', desktop)
    const d = s.db()
    scanDownloads({ db: d, roots: [desktop, s.dl], maxBytes: 20971520 })
    assert.equal(count(s, `SELECT count(*) n FROM file_items WHERE name=?`, '客戶提案-最終版.zip'), 1, '前提')
    assert.doesNotMatch(s.run(['cleanup', 'list']).out, /客戶提案/)
    const r = s.run(['cleanup', 'apply'])
    assert.equal(r.code, 0, r.out)
    assert.ok(existsSync(proposal), `桌面上的檔被搬走了：\n${r.out}`)
  })

  test('cleanup.roots 有寫就用它，不看 watch', t => {
    const s = sandbox(t)
    const other = join(s.home, 'Other')
    s.writeCfg({ watch: [s.dl], cleanup: { roots: [other] } })
    s.put('在-watch.zip', 60)
    s.put('在-cleanup.zip', 60, 'c', other)
    s.run(['cleanup', 'scan'])
    const list = s.run(['cleanup', 'list']).out
    assert.match(list, /在-cleanup\.zip/)
    assert.doesNotMatch(list, /在-watch\.zip/)
  })
})

// ═══ RC13 ・ 離開碼與逐項結果 ═════════════════════════════════

describe('RC13 CLI 自己解讀結果、離開碼違約', () => {
  test('唯讀模式 apply 不存在的計畫 → 1', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    s.run(['cleanup', 'scan'])
    const r = s.run(['cleanup', 'apply', 'no-such-plan'], { CONTEXTBOX_READONLY: '1' })
    assert.equal(r.code, 1, r.out)
    assert.doesNotMatch(r.out, /會清掉 0 個/)
  })

  test('--skip <編號>：那一個不清，其他照清，離開碼 0', t => {
    const s = sandbox(t, { files: { 'a.zip': 60, 'b.zip': 60 } })
    s.run(['cleanup', 'scan'])
    const c = codes(s.run(['cleanup', 'list']).out)
    assert.ok(c['a.zip'] && c['b.zip'], '前提：清單上有編號')
    assert.equal(c['a.zip'].length, 4, '編號是 4 碼')
    const r = s.run(['cleanup', 'apply', '--skip', c['a.zip']])
    assert.equal(r.code, 0, r.out)
    assert.ok(existsSync(join(s.dl, 'a.zip')), `--skip 的被搬走了：\n${r.out}`)
    assert.ok(!existsSync(join(s.dl, 'b.zip')), 'b.zip 要照清')
    assert.match(r.out, /a\.zip[^\n]*略過/, '要講出略過了哪一個')
  })

  test('--also <編號>：把 ☐ 的一起清', t => {
    const s = sandbox(t, { files: { 'a.zip': 60, 'Screenshot 2026-06-02 141203.png': 90 } })
    s.run(['cleanup', 'scan'])
    const list = s.run(['cleanup', 'list']).out
    assert.match(list, /☐ Screenshot/, '前提：截圖是 ☐')
    const c = codes(list)
    const r = s.run(['cleanup', 'apply', '--also', c['Screenshot 2026-06-02 141203.png']])
    assert.equal(r.code, 0, r.out)
    assert.ok(!existsSync(join(s.dl, 'Screenshot 2026-06-02 141203.png')), `--also 的沒被清：\n${r.out}`)
    assert.ok(!existsSync(join(s.dl, 'a.zip')), '打勾的照清')
  })

  test('--skip／--also 可以用逗號一次給好幾個', t => {
    const s = sandbox(t, { files: { 'a.zip': 60, 'b.zip': 60, 'c.zip': 60 } })
    s.run(['cleanup', 'scan'])
    const c = codes(s.run(['cleanup', 'list']).out)
    const r = s.run(['cleanup', 'apply', '--skip', `${c['a.zip']},${c['b.zip']}`])
    assert.equal(r.code, 0, r.out)
    assert.ok(existsSync(join(s.dl, 'a.zip')) && existsSync(join(s.dl, 'b.zip')), r.out)
    assert.ok(!existsSync(join(s.dl, 'c.zip')))
  })

  test('--skip 清單上沒有的編號 → 1，而且什麼都沒動、沒有建計畫', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    s.run(['cleanup', 'scan'])
    for (const args of [['--skip', 'zzzz'], ['--also', 'zzzz'], ['--skip'], ['--nope']]) {
      const r = s.run(['cleanup', 'apply', ...args])
      assert.equal(r.code, 1, `${args.join(' ')}：\n${r.out}`)
    }
    assert.ok(existsSync(join(s.dl, 'a.zip')))
    assert.equal(count(s, 'SELECT count(*) n FROM cleanup_plans'), 0)
  })

  test('唯讀試跑的 --skip 跟真的跑清一樣多（稽查 h9 C2）', t => {
    const s = sandbox(t, { files: { 'a.zip': 60, 'b.zip': 60 } })
    s.run(['cleanup', 'scan'])
    const c = codes(s.run(['cleanup', 'list']).out)
    const dry = s.run(['cleanup', 'apply', '--skip', c['a.zip']], { CONTEXTBOX_READONLY: '1' })
    assert.equal(dry.code, 0, dry.out)
    assert.match(dry.out, /會清掉 1 個檔案/, dry.out)
    assert.equal(count(s, 'SELECT count(*) n FROM cleanup_plans'), 0, '唯讀試跑不建計畫')
    const real = s.run(['cleanup', 'apply', '--skip', c['a.zip']])
    assert.match(real.out, /搬進隔離區 1 個/, real.out)
  })

  test('4 碼撞在一起時清單印長一點，短的編號要回 1', t => {
    const s = sandbox(t, { files: { 'a.zip': 60, 'b.zip': 60 } })
    s.run(['cleanup', 'scan'])
    // 兩個檔的 id 改成前 4 碼一樣（UUID 前 4 碼在上千個檔裡本來就會撞）
    const d = new DatabaseSync(s.p.db, { enableForeignKeyConstraints: false })
    for (const [name, id] of [['a.zip', 'abcd1111-0000-4000-8000-000000000001'], ['b.zip', 'abcd2222-0000-4000-8000-000000000002']]) {
      const old = d.prepare('SELECT id FROM file_items WHERE name=?').get(name).id
      d.prepare('UPDATE file_items SET id=? WHERE id=?').run(id, old)
      d.prepare('UPDATE cleanup_candidates SET item_id=? WHERE item_id=?').run(id, old)
    }
    d.close()
    const c = codes(s.run(['cleanup', 'list']).out)
    assert.equal(c['a.zip'], 'abcd1', '撞在一起就多印一碼，直到分得開')
    assert.equal(c['b.zip'], 'abcd2')
    const amb = s.run(['cleanup', 'apply', '--skip', 'abcd'])
    assert.equal(amb.code, 1, amb.out)
    assert.match(amb.out, /abcd1/, '要列出分得開的編號')
    const ok = s.run(['cleanup', 'apply', '--skip', 'abcd1'])
    assert.equal(ok.code, 0, ok.out)
    assert.ok(existsSync(join(s.dl, 'a.zip')) && !existsSync(join(s.dl, 'b.zip')), ok.out)
  })

  test('undo 不給 id → 最近一份可復原的計畫', t => {
    const s = sandbox(t, { files: { 'a.zip': 60, 'b.zip': 60 } })
    s.run(['cleanup', 'scan'])
    const c = codes(s.run(['cleanup', 'list']).out)
    const first = s.run(['cleanup', 'apply', '--skip', c['b.zip']])       // 先清 a
    const second = s.run(['cleanup', 'apply'])                          // 再清 b
    const p2 = planIdOf(second.out)
    assert.ok(planIdOf(first.out) && p2, `${first.out}\n${second.out}`)
    const r = s.run(['cleanup', 'undo'])
    assert.equal(r.code, 0, r.out)
    assert.ok(r.out.includes(p2), `要講出復原的是哪一份：\n${r.out}`)
    assert.ok(existsSync(join(s.dl, 'b.zip')), '最近那一份（b）要放回來')
    assert.ok(!existsSync(join(s.dl, 'a.zip')), '更早那一份（a）不動')
  })

  test('undo 不給 id、也沒有可以復原的 → 1', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    s.run(['cleanup', 'scan'])
    const r = s.run(['cleanup', 'undo'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /沒有可以復原/)
  })

  test('undo 一份還沒套用的計畫 → 1，不可以把它標成已復原', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    s.run(['cleanup', 'scan'])
    const p = createPlan(s.db())
    const r = s.run(['cleanup', 'undo', p.id])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /cleanup release/)
    assert.equal(count(s, `SELECT count(*) n FROM cleanup_plans WHERE status='proposed'`), 1)
  })

  test('quarantine --empty --yes：沒給確認碼或確認碼錯 → 1，而且不再產生新的預覽', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    s.run(['cleanup', 'scan'])
    s.run(['cleanup', 'apply'])
    const d = s.db()
    d.prepare('UPDATE cleanup_move_details SET completed_at=?').run(new Date(Date.now() - 8 * DAY).toISOString())
    const previews = () => count(s, 'SELECT count(*) n FROM cleanup_empty_requests')
    const before = previews()
    const r1 = s.run(['cleanup', 'quarantine', '--empty', '--yes'])
    assert.equal(r1.code, 1, r1.out)
    const r2 = s.run(['cleanup', 'quarantine', '--empty', '--yes', 'typo-token'])
    assert.equal(r2.code, 1, r2.out)
    assert.equal(previews(), before, '帶 --yes 的時候不可以再產生新的預覽')
    assert.equal(count(s, `SELECT count(*) n FROM cleanup_purges WHERE status='done'`), 0, '什麼都不可以刪')
  })

  test('quarantine --empty 預覽 → --yes <確認碼> 直接確認那一個', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    s.run(['cleanup', 'scan'])
    s.run(['cleanup', 'apply'])
    const d = s.db()
    d.prepare('UPDATE cleanup_move_details SET completed_at=?').run(new Date(Date.now() - 8 * DAY).toISOString())
    const prev = s.run(['cleanup', 'quarantine', '--empty'])
    assert.equal(prev.code, 0, prev.out)
    const token = /--yes (\S+)/.exec(prev.out)?.[1]
    assert.ok(token, prev.out)
    assert.equal(count(s, 'SELECT count(*) n FROM cleanup_empty_requests'), 1)
    const okBefore = meta(s, 'cleanup_last_ok')
    const r = s.run(['cleanup', 'quarantine', '--empty', '--yes', token])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /刪掉 1 個/, r.out)
    assert.equal(count(s, 'SELECT count(*) n FROM cleanup_empty_requests'), 1, '確認不可以再產生新的預覽')
    assert.ok(meta(s, 'cleanup_last_ok') > (okBefore ?? ''), '清空成功要記 lastOk')
  })

  test('apply 已經復原過的計畫 → 說「已經復原過了」、0，不印一排 ✘', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    s.run(['cleanup', 'scan'])
    const id = planIdOf(s.run(['cleanup', 'apply']).out)
    assert.equal(s.run(['cleanup', 'undo', id]).code, 0)
    const r = s.run(['cleanup', 'apply', id])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /已經復原過/)
    assert.doesNotMatch(r.out, /✘/)
  })

  test('cleanup dismiss → 1「這個指令還沒有」', t => {
    const s = sandbox(t)
    const r = s.run(['cleanup', 'dismiss'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /這個指令還沒有/)
  })

  test('逐項結果照 outcome 全部種類印：已清空、已放棄、還沒做', t => {
    const s = sandbox(t, { files: { 'a.zip': 60, 'b.zip': 60 } })
    s.run(['cleanup', 'scan'])
    const d = s.db()
    const c = codes(s.run(['cleanup', 'list']).out)
    // 已清空（purged）
    const id = planIdOf(s.run(['cleanup', 'apply', '--skip', c['b.zip']]).out)
    d.prepare('UPDATE cleanup_move_details SET completed_at=?').run(new Date(Date.now() - 8 * DAY).toISOString())
    const token = /--yes (\S+)/.exec(s.run(['cleanup', 'quarantine', '--empty']).out)?.[1]
    assert.equal(s.run(['cleanup', 'quarantine', '--empty', '--yes', token]).code, 0)
    const purged = s.run(['cleanup', 'apply', id])
    assert.match(purged.out, /a\.zip[^\n]*已清空/, purged.out)
    // 還沒做（pending）：唯讀模式看一份還沒套用的計畫
    const p = createPlan(d)
    const pending = s.run(['cleanup', 'apply', p.id], { CONTEXTBOX_READONLY: '1' })
    assert.equal(pending.code, 0, pending.out)
    assert.match(pending.out, /b\.zip[^\n]*還沒做/, pending.out)
    // 已放棄（cancelled）
    assert.equal(s.run(['cleanup', 'release', p.id]).code, 0)
    const cancelled = s.run(['cleanup', 'apply', p.id])
    assert.equal(cancelled.code, 0, cancelled.out)
    assert.match(cancelled.out, /已經放棄/)
    assert.match(cancelled.out, /b\.zip[^\n]*已放棄/, cancelled.out)
  })
})

// ═══ CONFLICT ・ 只有 proposed 會擋 ═══════════════════════════

describe('CONFLICT：擋住的那份、兩個選項、離開碼 1', () => {
  test('印出擋住的計畫與檔名，給 apply 與 release 兩個選項，不給 undo', t => {
    const s = sandbox(t, { files: { 'a.zip': 60, 'b.zip': 60 } })
    s.run(['cleanup', 'scan'])
    const p = createPlan(s.db())     // 面板建了一份、還沒套用
    const r = s.run(['cleanup', 'apply'])
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes(p.id), r.out)
    assert.match(r.out, /a\.zip/)
    assert.ok(r.out.includes(`cleanup apply ${p.id}`), r.out)
    assert.ok(r.out.includes(`cleanup release ${p.id}`), r.out)
    assert.doesNotMatch(r.out, /cleanup undo/, '「不清了」不可以叫人去 undo：那會把清掉的檔放回來')
  })

  test('cleanup release：放棄那一份，不動檔案、候選還在，接著就清得動', t => {
    const s = sandbox(t, { files: { 'a.zip': 60, 'b.zip': 60 } })
    s.run(['cleanup', 'scan'])
    const p = createPlan(s.db())
    const r = s.run(['cleanup', 'release', p.id])
    assert.equal(r.code, 0, r.out)
    assert.equal(count(s, 'SELECT count(*) n FROM cleanup_plans WHERE id=? AND status=?', p.id, 'dismissed'), 1)
    assert.ok(existsSync(join(s.dl, 'a.zip')) && existsSync(join(s.dl, 'b.zip')), '放棄不可以動檔案')
    const after = s.run(['cleanup', 'apply'])
    assert.equal(after.code, 0, after.out)
    assert.match(after.out, /搬進隔離區 2 個/, after.out)
  })

  test('release：沒給 id、不存在、已經套用的 → 1', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    s.run(['cleanup', 'scan'])
    assert.equal(s.run(['cleanup', 'release']).code, 1)
    assert.equal(s.run(['cleanup', 'release', 'no-such-plan']).code, 1)
    const id = planIdOf(s.run(['cleanup', 'apply']).out)
    const r = s.run(['cleanup', 'release', id])
    assert.equal(r.code, 1, r.out)
    assert.ok(!existsSync(join(s.dl, 'a.zip')), '已經搬走的不可以因為 release 被放回來')
  })

  test('partial 的計畫不擋，也不可以被當成「擋住的那份」（驗證者 v7）', t => {
    const s = sandbox(t, { files: { 'a.zip': 60, 'b.zip': 60, 'c.zip': 60 } })
    s.run(['cleanup', 'scan'])
    const d = s.db()
    const ids = name => d.prepare(`SELECT c.id FROM cleanup_candidates c JOIN file_items i ON i.id=c.item_id
      WHERE i.name=? AND c.status='proposed'`).all(name).map(r => r.id)
    const pA = createPlan(d, { candidateIds: ids('a.zip') })                  // 面板建的，proposed
    const pB = createPlan(d, { candidateIds: [...ids('b.zip'), ...ids('c.zip')] })
    const cAt = join(s.dl, 'c.zip')
    renameSync(cAt, cAt + '.away')
    applyPlan(d, pB.id, { roots: [s.dl], quarantine: s.p.q, maxBytes: 20971520 })   // b 搬了、c 失敗 → partial
    renameSync(cAt + '.away', cAt)
    assert.equal(d.prepare('SELECT status FROM cleanup_plans WHERE id=?').get(pB.id).status, 'partial', '前提')
    s.run(['cleanup', 'scan'])
    const r = s.run(['cleanup', 'apply'])
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes(pA.id), `擋住的是 proposed 的 pA：\n${r.out}`)
    assert.ok(!r.out.includes(pB.id), `partial 的 pB 不擋：\n${r.out}`)
  })

  test('CLI 連跑三晚：每晚正常清新的檔，不回 2（稽查 h2c）', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    s.put('desktop.ini', 60, '')
    const nights = []
    for (let n = 0; n < 3; n++) {
      s.put(`night${n}.zip`, 60)
      s.run(['cleanup', 'scan'])
      const r = s.run(['cleanup', 'apply'])
      nights.push(r.code)
      assert.ok(!existsSync(join(s.dl, `night${n}.zip`)), `第 ${n + 1} 晚的新檔沒清：\n${r.out}`)
    }
    assert.deepEqual(nights, [0, 0, 0])
    assert.ok(existsSync(join(s.dl, 'desktop.ini')), 'desktop.ini 不可以被搬')
  })
})

// ═══ RC12(2) ・ 一次最多 1000 個 ═════════════════════════════

describe('RC12 預設清理一次最多 1000 個', () => {
  test('1003 個：清單說 1003、試跑說 1000＋剩 3、真的清 1000＋剩 3、離開碼 0；再跑一次清掉剩下的', t => {
    const s = sandbox(t)
    for (let i = 0; i < 1003; i++) s.put(`f${String(i).padStart(4, '0')}.zip`, 60)
    // 掃描在測試行程裡用一個交易做完（CLI 的 scan 逐列提交，一千個檔要二十秒；這條測的不是掃描）
    const d = s.db()
    d.exec('BEGIN')
    scanDownloads({ db: d, roots: [s.dl], maxBytes: 20971520 })
    d.exec('COMMIT')
    const list = s.run(['cleanup', 'list'])
    assert.match(list.out, /打勾的 1003 個/, '清單頁尾要算全部，不是只算列出來的 500 個')
    const dry = s.run(['cleanup', 'apply'], { CONTEXTBOX_READONLY: '1' })
    assert.equal(dry.code, 0, dry.out)
    assert.match(dry.out, /會清掉 1000 個檔案/, dry.out.slice(0, 400))
    assert.match(dry.out, /剩下 3 個下次再清/)
    const real = s.run(['cleanup', 'apply'])
    assert.equal(real.code, 0, real.out.slice(-600))
    assert.match(real.out, /搬進隔離區 1000 個/)
    assert.match(real.out, /剩下 3 個下次再清/)
    const again = s.run(['cleanup', 'apply'])
    assert.equal(again.code, 0, again.out)
    assert.match(again.out, /搬進隔離區 3 個/)
    assert.doesNotMatch(again.out, /下次再清/)
  })
})

// ═══ RC14 ・ 檔名裡的控制字元 ═════════════════════════════════

describe('RC14 CLI 印的檔名不可以帶控制字元', () => {
  test('ESC、C1、換行都換成「·」，不能偽造一行結果', t => {
    const s = sandbox(t)
    const evil = 'x\u001b[31mRED\u009b\n  ✔ 偽造.zip'
    s.put(evil, 60)
    assert.equal(s.run(['cleanup', 'scan']).code, 0)
    const outs = []
    const list = s.run(['cleanup', 'list']); outs.push(list.out)
    const c = codes(list.out)
    assert.ok(Object.keys(c).some(k => k.includes('x·[31mRED··  ✔ 偽造.zip')), `清單上的名字：\n${list.out}`)
    const applied = s.run(['cleanup', 'apply']); outs.push(applied.out)
    assert.equal(applied.code, 0, applied.out)
    outs.push(s.run(['cleanup', 'quarantine']).out)
    outs.push(s.run(['cleanup', 'undo']).out)
    for (const o of outs) {
      assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(o), `印出了控制字元：${JSON.stringify(o)}`)
      assert.doesNotMatch(o, /^\s*✔ 偽造/m, `檔名裡的換行偽造了一行：\n${o}`)
    }
    assert.ok(existsSync(join(s.dl, evil)), '前提：復原成功')
  })
})

// ═══ RC17(3) ・ 「原檔都還在原位」只在全部是 failed 時才說 ═══════

describe('RC17 已經搬了／搬到一半，訊息不可以說沒有', () => {
  function appliedPlan(t, { remove = [] } = {}) {
    const s = sandbox(t, { files: { 'a.zip': 60, 'b.zip': 60 } })
    s.run(['cleanup', 'scan'])
    const d = s.db()
    const p = createPlan(d)
    for (const n of remove) rmSync(join(s.dl, n))
    applyPlan(d, p.id, { roots: [s.dl], quarantine: s.p.q, maxBytes: 20971520 })
    const itemOf = name => d.prepare('SELECT id FROM file_items WHERE name=?').get(name).id
    /** 模擬搬到一半中斷：journal 停在 started */
    const interrupt = name => {
      d.prepare(`UPDATE cleanup_journal SET status='started' WHERE plan_id=? AND item_id=? AND op='quarantine'`).run(p.id, itemOf(name))
      d.prepare(`UPDATE cleanup_plans SET status='applied' WHERE id=?`).run(p.id)
    }
    return { s, d, p, interrupt }
  }

  test('失敗的全部是 failed：可以說「原檔都還在原位」', t => {
    const s = sandbox(t, { files: { 'a.zip': 60, 'b.zip': 60 } })
    s.run(['cleanup', 'scan'])
    const p = createPlan(s.db())
    rmSync(join(s.dl, 'a.zip'))
    const r = s.run(['cleanup', 'apply', p.id])
    assert.equal(r.code, 3, r.out)
    assert.match(r.out, /✘ a\.zip/)
    assert.match(r.out, /原檔都還在原位/)
    assert.doesNotMatch(r.out, /狀態不明/)
  })

  test('有 unknown：不可以說「原檔都還在原位」，要說搬到一半中斷、叫人跑 doctor', t => {
    const { s, p, interrupt } = appliedPlan(t)
    interrupt('b.zip')
    const r = s.run(['cleanup', 'apply', p.id])
    assert.equal(r.code, 3, r.out)
    assert.match(r.out, /b\.zip[^\n]*狀態不明/, r.out)
    assert.match(r.out, /搬到一半中斷，檔案可能已經在隔離區/)
    assert.match(r.out, /doctor/)
    assert.doesNotMatch(r.out, /原檔都還在原位/)
  })

  test('failed 與 unknown 混在一起：也不可以說「原檔都還在原位」', t => {
    const { s, p, interrupt } = appliedPlan(t, { remove: ['a.zip'] })
    interrupt('b.zip')
    const r = s.run(['cleanup', 'apply', p.id])
    assert.equal(r.code, 3, r.out)
    assert.match(r.out, /✘ a\.zip/)
    assert.doesNotMatch(r.out, /原檔都還在原位/)
    assert.match(r.out, /doctor/)
  })

  test('undo：沒放回來的要講原因，離開碼 3', t => {
    const { s, d, p } = appliedPlan(t)
    const b = d.prepare('SELECT id FROM file_items WHERE name=?').get('b.zip').id
    writeFileSync(join(s.p.q, p.id, b, 'content'), '隔離區裡的檔被改過')
    const r = s.run(['cleanup', 'undo', p.id])
    assert.equal(r.code, 3, r.out)
    assert.match(r.out, /↩ a\.zip/)
    assert.match(r.out, /✘ b\.zip[^\n]*沒放回/, r.out)
    assert.doesNotMatch(r.out, /↩ b\.zip/)
  })
})

// ═══ scan／apply／undo 的 onProblem 與 lastOk ═══════════════════

describe('scan 印出 problem、成功記 lastOk；apply 存失敗原因', () => {
  test('cleanup scan：打不開的資料夾要講出來，離開碼還是 0', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    const sub = join(s.dl, '鎖住的')
    s.put('b.zip', 60, 'b', sub)
    s.lock(sub)
    const r = s.run(['cleanup', 'scan'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /⚠[^\n]*打不開/, `onProblem 的訊息沒印出來：\n${r.out}`)
  })

  test('cleanup scan：大量消失的保險絲那句話要看得到', t => {
    const s = sandbox(t)
    for (let i = 0; i < 12; i++) s.put(`f${i}.zip`, 60)
    s.run(['cleanup', 'scan'])
    renameSync(s.dl, s.dl + '.away')
    mkdirSync(s.dl)
    const r = s.run(['cleanup', 'scan'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /看起來整個不見了/, r.out)
  })

  test('scan、apply、undo 成功都記 lastOk，而且一次比一次新', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    assert.equal(meta(s, 'cleanup_last_ok'), null, '前提')
    s.run(['cleanup', 'scan'])
    const t1 = meta(s, 'cleanup_last_ok')
    assert.ok(t1 && Number.isFinite(Date.parse(t1)), `scan 沒記 lastOk：${t1}`)
    const id = planIdOf(s.run(['cleanup', 'apply']).out)
    const t2 = meta(s, 'cleanup_last_ok')
    assert.ok(t2 > t1, `apply 沒記 lastOk：${t1} → ${t2}`)
    s.run(['cleanup', 'undo', id])
    const t3 = meta(s, 'cleanup_last_ok')
    assert.ok(t3 > t2, `undo 沒記 lastOk：${t2} → ${t3}`)
  })

  test('唯讀試跑不算「成功的清理」，不記 lastOk', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    s.run(['cleanup', 'scan'])
    const t1 = meta(s, 'cleanup_last_ok')
    s.run(['cleanup', 'apply'], { CONTEXTBOX_READONLY: '1' })
    assert.equal(meta(s, 'cleanup_last_ok'), t1)
  })

  test('apply 之後失敗原因要存起來（重掃之後還查得到）', t => {
    const s = sandbox(t)
    s.put('報告.pdf', 0, 'SMOKE 報告')
    s.put('報告 (1).pdf', 0, 'SMOKE 報告')
    s.run(['cleanup', 'scan'])
    const d = s.db()
    // 剛 cp 出來的重複檔：規則成立（重複檔），但還在十分鐘內 → 執行層回 TOO_FRESH
    const p = createPlan(d)
    const r = s.run(['cleanup', 'apply', p.id])
    assert.equal(r.code, 3, r.out)
    const why = d.prepare('SELECT why FROM cleanup_item_errors WHERE plan_id=?').get(p.id)?.why
    assert.match(why ?? '', /十分鐘/, `cleanup_item_errors 裡沒有存原因：${why}\n${r.out}`)
  })

  test('意外錯誤要記 lastError（人話、不帶路徑），doctor 看得到時間與原因', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    s.run(['cleanup', 'scan'])
    writeFileSync(s.p.q, '隔離區的位置被一個檔案佔住了')
    const r = s.run(['cleanup', 'apply'])
    assert.equal(r.code, 2, r.out)
    const last = meta(s, 'cleanup_last_error')
    assert.ok(last, 'lastError 沒記')
    assert.ok(!last.includes(s.home), `lastError 帶了路徑：${last}`)
    const doc = s.run(['doctor'])
    assert.equal(doc.code, 0, doc.out)
    assert.match(doc.out, /最近出錯[^\n]*只處理一般檔案/, doc.out)
    assert.match(doc.out, /最近出錯[^\n]*(秒前|分鐘前)/, '要講出時間')
  })
})

// ═══ doctor ・ 讀不到 vs 太大 ═══════════════════════════════

describe('doctor 分開算「讀不到」與「太大」', () => {
  test('1 個太大、1 個讀不到：兩個數字分開講', t => {
    const s = sandbox(t, { config: { maxBytes: 1024 } })
    s.put('big.zip', 60, 'x'.repeat(4096))
    const locked = s.put('locked.zip', 60, 'y')
    s.lock(locked)
    s.run(['cleanup', 'scan'])
    const r = s.run(['doctor'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /1 個太大/, r.out)
    assert.match(r.out, /1 個讀不到/, r.out)
    assert.doesNotMatch(r.out, /2 個讀不到/)
  })

  test('doctor 列出清理範圍（cleanup.roots），不是只列監看資料夾', t => {
    const s = sandbox(t)
    const other = join(s.home, '清理這裡')
    mkdirSync(other)
    s.writeCfg({ cleanup: { roots: [other] } })
    const r = s.run(['doctor'])
    assert.match(r.out, /清理範圍[\s\S]*清理這裡/, r.out)
  })
})

// ═══ RC2／RC16 ・ pet 與 open ═════════════════════════════════

/** HTTP：自己控制 header（不帶 Origin）。 */
function http(port, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { /* 不是 JSON */ }
        resolve({ status: res.statusCode, text, json })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function startPet(t, s, extra = {}) {
  const child = spawn(process.execPath, [CLI, 'pet'], { env: s.env({ CONTEXTBOX_PORT: '0', ...extra }) })
  let out = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { out += d })
  const exited = new Promise(r => child.once('exit', code => r(code)))
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await exited
  }
  t.after(stop)
  const until = async (re, ms = 15_000) => {
    const t0 = Date.now()
    while (!re.test(out)) {
      if (child.exitCode !== null) throw new Error(`pet 結束了（${child.exitCode}）：\n${out}`)
      if (Date.now() - t0 > ms) throw new Error(`等不到 ${re}：\n${out}`)
      await sleep(30)
    }
    return re.exec(out)
  }
  return { child, until, out: () => out, stop, exited }
}

describe('RC16／RC2 pet 與 open', () => {
  test('pet 印的網址帶 ?k=<token>，每一個網址都帶；打開是 200，不帶是 401', async t => {
    const s = sandbox(t)
    const pet = startPet(t, s)
    const m = await pet.until(/http:\/\/127\.0\.0\.1:(\d+)\/\?k=([^\s　）)]+)/)
    await pet.until(/按 Ctrl\+C/)
    const token = readFileSync(s.p.token, 'utf8').trim()
    assert.equal(decodeURIComponent(m[2]), token)
    for (const u of pet.out().match(/https?:\/\/\S+/g)) {
      assert.ok(u.includes('?k='), `印出不帶鑰匙的網址（打開是 401）：${u}\n${pet.out()}`)
    }
    const port = Number(m[1])
    assert.notEqual(port, 7391, '測試不可以佔 7391')
    assert.equal((await http(port, 'GET', `/?k=${m[2]}`)).status, 200)
    assert.equal((await http(port, 'GET', '/')).status, 401)
  })

  test('pet 一啟動就全量掃描：舊檔上清單、pet 沒開時刪掉的檔下清單、記 lastOk', async t => {
    const s = sandbox(t, { files: { 'gone.zip': 60, 'stay.zip': 60 } })
    const desktop = join(s.home, 'Desktop')
    s.writeCfg({ watch: [desktop, s.dl] })            // watch 含桌面，清理範圍還是只有 Downloads
    s.put('桌面的.zip', 60, 'd', desktop)
    // 舊版 CLI 用 watch 掃過：資料庫裡已經有桌面的候選。pet 的 server 不可以把它列出來
    scanDownloads({ db: s.db(), roots: [desktop, s.dl], maxBytes: 20971520 })
    rmSync(join(s.dl, 'gone.zip'))                  // pet 沒開的時候使用者自己刪掉
    s.put('new-old.zip', 60)                          // pet 沒開的時候下載的（已經放很久）
    const before = meta(s, 'cleanup_last_ok')
    const pet = startPet(t, s)
    const m = await pet.until(/127\.0\.0\.1:(\d+)\/\?k=([^\s　）)]+)/)
    await pet.until(/按 Ctrl\+C/)
    const token = readFileSync(s.p.token, 'utf8').trim()
    const list = await http(Number(m[1]), 'GET', '/cleanup/candidates', { 'x-contextbox-token': token })
    assert.equal(list.status, 200, list.text)
    const names = list.json.candidates.map(c => c.name).sort()
    assert.deepEqual(names, ['new-old.zip', 'stay.zip'], `pet 啟動時沒有全量掃描／清到桌面：${names}`)
    assert.ok(meta(s, 'cleanup_last_ok') > (before ?? ''), 'pet 的掃描成功要記 lastOk')
    assert.match(pet.out(), /每 30 分鐘/, '要講出之後多久重掃一次')
  })

  test('pet 的即時監看也只看清理範圍：桌面上新放的檔不進資料庫', async t => {
    const s = sandbox(t)
    const desktop = join(s.home, 'Desktop')
    mkdirSync(desktop)
    s.writeCfg({ watch: [desktop, s.dl] })
    const pet = startPet(t, s)
    await pet.until(/按 Ctrl\+C/)
    s.put('桌面新放的.zip', 60, 'd', desktop)
    s.put('下載新放的.zip', 60, 'n')
    const known = name => count(s, 'SELECT count(*) n FROM file_items WHERE name=?', name)
    const t0 = Date.now()
    while (!known('下載新放的.zip') && Date.now() - t0 < 15_000) await sleep(100)
    assert.equal(known('下載新放的.zip'), 1, `前提：watcher 有在看 Downloads\n${pet.out()}`)
    await sleep(300)
    assert.equal(known('桌面新放的.zip'), 0, 'pet 的 watcher 看了桌面（用了 watch，不是 cleanup.roots）')
  })

  test('pet 之後定期重掃（這裡把 30 分鐘縮短）', async t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    const pet = startPet(t, s, { CONTEXTBOX_RESCAN_MS: '200' })
    await pet.until(/按 Ctrl\+C/)
    const seen = new Set([meta(s, 'cleanup_last_ok')])
    const t0 = Date.now()
    while (seen.size < 3 && Date.now() - t0 < 10_000) { await sleep(100); seen.add(meta(s, 'cleanup_last_ok')) }
    assert.ok(seen.size >= 3, `沒有定期重掃：${[...seen]}`)
  })

  test('pet 的全量掃描也印出 problem', async t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    const sub = join(s.dl, '鎖住的')
    s.put('b.zip', 60, 'b', sub)
    s.lock(sub)
    const pet = startPet(t, s)
    await pet.until(/按 Ctrl\+C/)
    assert.match(pet.out(), /⚠[^\n]*打不開/, pet.out())
  })

  test('port 被佔：講「已經有一個在跑」，網址帶 k 而且是那個 port', async t => {
    const s = sandbox(t)
    const busy = createServer()
    await new Promise(r => busy.listen(0, '127.0.0.1', r))
    t.after(() => busy.close())
    const port = busy.address().port
    const pet = startPet(t, s, { CONTEXTBOX_PORT: String(port) })
    const code = await pet.exited
    const token = readFileSync(s.p.token, 'utf8').trim()
    assert.match(pet.out(), /已經有一個/, pet.out())
    assert.ok(pet.out().includes(`http://127.0.0.1:${port}/?k=${encodeURIComponent(token)}`), pet.out())
    assert.equal(code, 0)
  })

  test('open：pet 在跑的時候印出帶 k 的網址，並交給系統打開', async t => {
    const s = sandbox(t)
    const pet = startPet(t, s)
    const m = await pet.until(/127\.0\.0\.1:(\d+)\/\?k=([^\s　）)]+)/)
    await pet.until(/按 Ctrl\+C/)
    const token = readFileSync(s.p.token, 'utf8').trim()
    const want = `http://127.0.0.1:${m[1]}/?k=${encodeURIComponent(token)}`
    const r = s.run(['open'])
    assert.equal(r.code, 0, r.out)
    assert.ok(r.stdout.includes(want), r.out)
    assert.equal(readFileSync(s.p.opened, 'utf8'), want, '要把網址交給系統的開啟指令')
  })

  test('open：打不開瀏覽器就只印網址，離開碼 0', async t => {
    const s = sandbox(t)
    const pet = startPet(t, s)
    await pet.until(/按 Ctrl\+C/)
    const r = s.run(['open'], { CONTEXTBOX_OPENER: join(s.home, '沒有這個程式') })
    assert.equal(r.code, 0, r.out)
    assert.match(r.stdout, /\?k=/)
    assert.match(r.out, /打不開瀏覽器/)
  })

  test('open：pet 沒在跑 → 還是印網址，講要先跑 pet，不打開瀏覽器，離開碼 2', async t => {
    const s = sandbox(t)
    // 一個剛剛還開著、現在關掉的 port：保證沒有人在聽，也不是 7391
    const tmp = createServer()
    await new Promise(r => tmp.listen(0, '127.0.0.1', r))
    const port = tmp.address().port
    await new Promise(r => tmp.close(r))
    const r = s.run(['open'], { CONTEXTBOX_PORT: String(port) })
    assert.equal(r.code, 2, r.out)
    assert.match(r.stdout, new RegExp(`127\\.0\\.0\\.1:${port}/\\?k=`))
    assert.match(r.out, /node cli\.mjs pet/)
    assert.ok(!existsSync(s.p.opened), '沒在跑就不要打開瀏覽器')
  })
})
