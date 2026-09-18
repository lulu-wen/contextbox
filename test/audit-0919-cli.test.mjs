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
  readFileSync, chmodSync, renameSync, readdirSync,
} from 'node:fs'
import { spawnSync, spawn } from 'node:child_process'
import { request, createServer as httpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { open } from '../core/db.ts'
import { scanDownloads } from '../core/cleanup-scanner.ts'
import { createPlan } from '../core/cleanup-plans.ts'
import { applyPlan } from '../core/cleanup-exec.ts'
import { listCandidates, TOO_LARGE_WHY } from '../core/cleanup-routes.ts'

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
  /**
   * 這個沙盒裡起的 pet，**刪沙盒之前先收掉**。t.after 照登記的順序跑，而沙盒比 pet 先登記 ——
   * 不先收的話 pet 還活著，它的背景重掃子行程會在刪掉的沙盒裡重新建出設定檔與資料庫（第三波 C2 之後看得到）。
   */
  const stops = []
  t.after(async () => {
    for (const stop of stops.splice(0)) await stop()
    for (const d of dbs) { try { d.close() } catch { /* 已經關了 */ } }
    for (const f of locked) { try { chmodSync(f, 0o755) } catch { /* 已經沒了 */ } }
    rmSync(home, { recursive: true, force: true })
  })
  /** chmod 000，測試結束會改回來才刪 */
  const lock = f => { chmodSync(f, 0o000); locked.push(f) }
  return { home, dl, p, put, run, env, db, writeCfg, lock, stops }
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
  s.stops.push(stop)
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
    // 開機掃描在背景的子行程跑（第三波 C2），等它講完再看清單
    await pet.until(/開機掃描：掃了/)
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
    await pet.until(/開機掃描：掃了/)
    assert.match(pet.out(), /⚠[^\n]*打不開/, pet.out())
  })

  // 第三波之二：port 被佔的時候先問那個埠上是不是真的 pet（跟 open 同一個判斷），**是才印網址**。
  // 上一版不問就印帶鑰匙的網址、回 0 —— 佔著那個埠的是陌生程式的話，鑰匙就等於交給它了。
  test('port 被陌生程式佔著（只收連線、不回話）：不印帶鑰匙的網址，離開碼 2', async t => {
    const s = sandbox(t)
    const busy = createServer()
    await new Promise(r => busy.listen(0, '127.0.0.1', r))
    t.after(() => busy.close())
    const port = busy.address().port
    const pet = startPet(t, s, { CONTEXTBOX_PORT: String(port) })
    const code = await pet.exited
    assert.equal(code, 2, pet.out())
    assert.doesNotMatch(pet.out(), /\?k=/, `把帶鑰匙的網址印給了佔著 port 的陌生程式：\n${pet.out()}`)
    assert.doesNotMatch(pet.out(), /已經有一個/, pet.out())
    assert.match(pet.out(), /CONTEXTBOX_PORT/, '要講怎麼換一個埠')
  })

  test('對照：port 被真的 pet 佔著：講「已經有一個在跑」，網址帶 k 而且是那個 port，離開碼 0', async t => {
    const s = sandbox(t)
    const first = startPet(t, s)
    const port = (await first.until(/127\.0\.0\.1:(\d+)\/\?k=/))[1]
    await first.until(/按 Ctrl\+C/)
    const second = startPet(t, s, { CONTEXTBOX_PORT: port })
    const code = await second.exited
    const token = readFileSync(s.p.token, 'utf8').trim()
    assert.equal(code, 0, second.out())
    assert.match(second.out(), /已經有一個/, second.out())
    assert.ok(second.out().includes(`http://127.0.0.1:${port}/?k=${encodeURIComponent(token)}`), second.out())
    assert.equal(first.child.exitCode, null, '第一個 pet 不受影響')
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

// ═══════════════════════════════════════════════════════════════
// 2026-09-19 稽核第三波（CLI）：C1–C7。
// 期望值照 build-round 的預想表寫死，**先寫測試、再改 cli.mjs**。
// ═══════════════════════════════════════════════════════════════

/** 讀一列（唯讀連線，不跟 CLI 搶鎖） */
const one = (s, sql, ...a) => {
  const d = new DatabaseSync(s.p.db, { readOnly: true })
  try { d.exec('PRAGMA busy_timeout = 5000'); return d.prepare(sql).get(...a) }
  finally { d.close() }
}

/** 非同步跑一次 CLI。測試行程自己起了假的 server 的時候要用這個 —— spawnSync 會把事件迴圈卡住，假的 server 回不了話。 */
function runAsync(s, args, extra = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { env: s.env(extra) })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.once('close', code => resolve({ code, out: stdout + stderr, stdout }))
  })
}

/**
 * 套用做到一半中斷：處理到第 stopAt 項時丟例外。跟 Ctrl+C 一樣，applyPlan 沒機會寫最後的狀態 ——
 * 計畫停在 proposed，前面幾項已經在隔離區，journal 也寫了。skipFirst：第一項是使用者略過的。
 */
function interruptedPlan(t, { files = 5, stopAt = 3, skipFirst = false } = {}) {
  const names = Array.from({ length: files }, (_, i) => `f${i}.zip`)
  const s = sandbox(t, { files: Object.fromEntries(names.map(n => [n, 60])) })
  s.run(['cleanup', 'scan'])
  const d = s.db()
  const p = createPlan(d)
  const opts = {
    roots: [s.dl], quarantine: s.p.q, maxBytes: 20971520,
    onProgress: i => { if (i === stopAt) throw new Error('模擬中斷') },
  }
  if (skipFirst) opts.skippedIds = p.items[0].candidateIds
  assert.throws(() => applyPlan(d, p.id, opts), /模擬中斷/)
  assert.equal(one(s, 'SELECT status FROM cleanup_plans WHERE id=?', p.id).status, 'proposed', '前提：計畫停在 proposed')
  assert.ok(count(s, 'SELECT count(*) n FROM cleanup_journal WHERE plan_id=?', p.id) > 0, '前提：已經有 journal')
  const moved = p.items.slice(0, stopAt).filter((_, i) => !(skipFirst && i === 0)).map(i => i.name)
  return { s, d, p, names, moved }
}

describe('C1 做到一半中斷的計畫：undo 與 release 不可以互相推來推去', () => {
  test('中斷的計畫：undo 把已經搬的放回來（0）；release 回 1 並指出 undo／apply', t => {
    const { s, p, names, moved } = interruptedPlan(t)
    assert.equal(moved.length, 3)
    for (const n of moved) assert.ok(!existsSync(join(s.dl, n)), `前提：${n} 已經在隔離區`)
    const rel = s.run(['cleanup', 'release', p.id])
    assert.equal(rel.code, 1, rel.out)
    assert.ok(rel.out.includes(`cleanup undo ${p.id}`), `release 被拒要講得出下一步：\n${rel.out}`)
    assert.ok(rel.out.includes(`cleanup apply ${p.id}`), rel.out)
    assert.match(rel.out, /放回原位的檔之後不會再被自動提議（除非出現新的理由）/, '選 undo 之前要知道放回來的之後不會再被提議')
    const r = s.run(['cleanup', 'undo', p.id])
    assert.equal(r.code, 0, r.out)
    assert.doesNotMatch(r.out, /還沒套用/)
    assert.match(r.out, /放回原位 3 個檔案/, r.out)
    for (const n of names) assert.ok(existsSync(join(s.dl, n)), `${n} 沒有回到原位：\n${r.out}`)
    // 放回之後就不再擋：清得動沒搬過的那 2 個。放回來的 3 個候選是 restored（核心的 markMoved），
    // **重掃也不會再被提議**：upsertCandidate 碰到同一個檔、同一種理由的 restored 候選，狀態原樣留著，
    // 只有出現新的理由（新的 kind 或新的規則版本）才會多一列 proposed。
    //（預想表原本寫「搬進隔離區 5 個」，那是把「不再擋」跟「又是候選」混在一起了）
    assert.equal(s.run(['cleanup', 'scan']).code, 0)
    const again = s.run(['cleanup', 'apply'])
    assert.equal(again.code, 0, again.out)
    assert.match(again.out, /搬進隔離區 2 個/, `放回來的檔重掃之後又被清了一次：\n${again.out}`)
    for (const n of moved) assert.ok(existsSync(join(s.dl, n)), `${n} 放回來之後又被自動清掉了`)
  })

  test('對照：原位置被佔、改名放回的那份是新的檔，重掃之後照規則重新評估', t => {
    // 上面那句「放回原位的檔之後不會再被自動提議」只講放回原位的。改名成 .restored 的那份路徑不一樣，
    // 在資料庫裡是另一個檔：內容跟原位置那份一樣的話，就以重複檔的身分被提議（預設打勾）。
    const s = sandbox(t, { files: { 'a.zip': 60, 'b.zip': 60 } })
    s.run(['cleanup', 'scan'])
    const id = planIdOf(s.run(['cleanup', 'apply']).out)
    assert.ok(id && !existsSync(join(s.dl, 'b.zip')), '前提')
    s.put('b.zip', 60, 'x b.zip')                        // 同名、同內容的檔又出現在原位置
    const u = s.run(['cleanup', 'undo', id])
    assert.equal(u.code, 0, u.out)
    assert.ok(existsSync(join(s.dl, 'b.zip.restored')), `前提：改名放回：\n${u.out}`)
    assert.equal(s.run(['cleanup', 'scan']).code, 0)
    const list = s.run(['cleanup', 'list']).out
    assert.match(list, /✔ b\.zip\.restored/, `改名放回的那份沒有被重新評估：\n${list}`)
    assert.doesNotMatch(list, /\] [✔☐] a\.zip$/m, `放回原位的 a.zip 又被提議了：\n${list}`)
  })

  test('沒開始的計畫剛好相反：undo 回 1 並建議 release，release 回 0', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    s.run(['cleanup', 'scan'])
    const p = createPlan(s.db())
    const u = s.run(['cleanup', 'undo', p.id])
    assert.equal(u.code, 1, u.out)
    assert.ok(u.out.includes(`cleanup release ${p.id}`), u.out)
    assert.equal(s.run(['cleanup', 'release', p.id]).code, 0)
  })

  test('只寫了「略過」的 journal 也算開始了（跟 releasePlan 同一個判斷）：undo 0、release 1', t => {
    const { s, p, names } = interruptedPlan(t, { files: 2, stopAt: 1, skipFirst: true })
    assert.equal(count(s, `SELECT count(*) n FROM cleanup_journal WHERE plan_id=? AND op<>'skip'`, p.id), 0, '前提：只有 skip')
    assert.equal(s.run(['cleanup', 'release', p.id]).code, 1)
    const r = s.run(['cleanup', 'undo', p.id])
    assert.equal(r.code, 0, r.out)
    for (const n of names) assert.ok(existsSync(join(s.dl, n)))
  })

  test('中斷的計畫裡有一個隔離檔被改過：其他放回、那一個講原因，離開碼 3', t => {
    const { s, p, moved } = interruptedPlan(t)
    const victim = p.items[0]
    writeFileSync(join(s.p.q, p.id, victim.itemId, 'content'), '隔離區裡的檔被改過')
    const r = s.run(['cleanup', 'undo', p.id])
    assert.equal(r.code, 3, r.out)
    assert.ok(new RegExp(`✘ ${victim.name.replace('.', '\\.')}[^\\n]*沒放回`).test(r.out), r.out)
    for (const n of moved.filter(n => n !== victim.name)) assert.ok(existsSync(join(s.dl, n)), n)
  })

  test('CONFLICT 被中斷的計畫擋住：建議 undo 與 apply 那一份，不建議 release', t => {
    const { s, p } = interruptedPlan(t)
    const r = s.run(['cleanup', 'apply'])
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes(`cleanup undo ${p.id}`), r.out)
    assert.ok(r.out.includes(`cleanup apply ${p.id}`), r.out)
    assert.doesNotMatch(r.out, /cleanup release/, '已經開始的計畫不能 release，叫人去跑只會再被拒絕一次')
  })

  test('照建議把它做完：apply <id> 接著搬剩下的，離開碼 0', t => {
    const { s, p, names } = interruptedPlan(t)
    const r = s.run(['cleanup', 'apply', p.id])
    assert.equal(r.code, 0, r.out)
    for (const n of names) assert.ok(!existsSync(join(s.dl, n)), n)
  })

  test('重現：300 個檔 apply 到一半按 Ctrl+C —— release 1、apply 撞 CONFLICT 建議 undo、undo 全部放回',
    { skip: process.platform === 'win32' && 'Windows 沒有 SIGINT' }, async t => {
      const s = sandbox(t)
      const names = []
      for (let i = 0; i < 300; i++) { const n = `f${String(i).padStart(3, '0')}.zip`; s.put(n, 60); names.push(n) }
      // 掃描在測試行程裡用一個交易做完（這條測的不是掃描）
      const d = s.db()
      d.exec('BEGIN')
      scanDownloads({ db: d, roots: [s.dl], maxBytes: 20971520 })
      d.exec('COMMIT')
      const child = spawn(process.execPath, [CLI, 'cleanup', 'apply'], { env: s.env() })
      let out = ''
      child.stdout.on('data', x => { out += x })
      child.stderr.on('data', x => { out += x })
      const exited = new Promise(r => child.once('exit', (code, sig) => r({ code, sig })))
      const inQuarantine = () => {
        let n = 0
        try {
          for (const p of readdirSync(s.p.q)) for (const i of readdirSync(join(s.p.q, p))) if (existsSync(join(s.p.q, p, i, 'content'))) n++
        } catch { /* 隔離區還沒建 */ }
        return n
      }
      const t0 = Date.now()
      while (inQuarantine() < 20 && child.exitCode === null && Date.now() - t0 < 60_000) await sleep(5)
      child.kill('SIGINT')
      const ex = await exited
      assert.equal(ex.sig, 'SIGINT', `前提：是被 Ctrl+C 中斷的，不是自己跑完：\n${out.slice(-400)}`)
      const id = one(s, `SELECT id FROM cleanup_plans WHERE status='proposed'`)?.id
      assert.ok(id, '前提：計畫停在 proposed')
      const started = count(s, `SELECT count(*) n FROM cleanup_journal WHERE plan_id=? AND status='started'`, id)

      const rel = s.run(['cleanup', 'release', id])
      assert.equal(rel.code, 1, rel.out)
      const conflict = s.run(['cleanup', 'apply'])
      assert.equal(conflict.code, 1, conflict.out)
      assert.ok(conflict.out.includes(`cleanup undo ${id}`), conflict.out)
      assert.doesNotMatch(conflict.out, /cleanup release/)
      const r = s.run(['cleanup', 'undo', id])
      assert.doesNotMatch(r.out, /還沒套用/)
      // 中斷在 rename 之前（journal 停在 started、檔案還在原位）的那一項，核心的逐項結果仍是「狀態不明」→ 3
      if (!started) assert.equal(r.code, 0, r.out)
      else assert.ok([0, 3].includes(r.code), r.out)
      for (const n of names) assert.ok(existsSync(join(s.dl, n)), `${n} 沒有回到原位：\n${r.out.slice(-600)}`)
    })
})

// ── C2 ────────────────────────────────────────────────────────

/** 某個行程還活著的子行程（Linux：讀 /proc）。殭屍不算。 */
function childrenOf(pid) {
  const out = []
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    let stat
    try { stat = readFileSync(`/proc/${d}/stat`, 'utf8') } catch { continue }
    const [state, ppid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    if (Number(ppid) === pid && state !== 'Z') out.push(Number(d))
  }
  return out
}
/** 這個 pid 還在跑嗎（不存在、殭屍都算不在） */
const running = pid => {
  let stat
  try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8') } catch { return false }
  return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z'
}

/** GET /health 花了多久。timeout 內沒回就是 Infinity。 */
function healthMs(port, timeout = 5000) {
  const t0 = Date.now()
  return new Promise(resolve => {
    const req = request({ host: '127.0.0.1', port, path: '/health', timeout }, res => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - t0 }))
    })
    req.on('timeout', () => { req.destroy(); resolve({ status: null, ms: Infinity }) })
    req.on('error', () => resolve({ status: null, ms: Infinity }))
    req.end()
  })
}

const LINUX_ONLY = process.platform !== 'linux' && '讀 /proc 數子行程'

describe('C2 pet 的全量掃描在子行程跑，不卡住 server', () => {
  test('cleanup scan --json（pet 的背景重掃用的）：stdout 只有一行 JSON，problem 照樣講', t => {
    const s = sandbox(t, { files: { 'a.zip': 60, 'b.zip': 60 } })
    const sub = join(s.dl, '鎖住的')
    s.put('c.zip', 60, 'c', sub)
    s.lock(sub)
    const r = s.run(['cleanup', 'scan', '--json'])
    assert.equal(r.code, 0, r.out)
    const lines = r.stdout.trim().split('\n')
    assert.equal(lines.length, 1, `stdout 要只有一行：\n${r.stdout}`)
    const j = JSON.parse(lines[0])
    assert.equal(j.ok, true)
    assert.equal(j.scanned, 2)
    assert.equal(j.files, 2)
    assert.match(r.out, /⚠[^\n]*打不開/, 'problem 要印到 stderr')
    assert.ok(meta(s, 'cleanup_last_ok'), '掃描成功要記 lastOk')
  })

  test('Downloads 1000 個檔：開機掃描進行中 /health 1 秒內回；掃完候選數正確', async t => {
    const s = sandbox(t)
    for (let i = 0; i < 1000; i++) s.put(`f${String(i).padStart(4, '0')}.zip`, 60)
    const pet = startPet(t, s)
    const port = Number((await pet.until(/127\.0\.0\.1:(\d+)\/\?k=/))[1])
    const finished = () => /開機掃描：掃了/.test(pet.out())
    const during = []
    let midway = false
    const t0 = Date.now()
    while (!finished() && Date.now() - t0 < 120_000) {
      const startedDuring = !finished()
      const h = await healthMs(port)
      if (startedDuring) during.push(h.ms)
      const n = count(s, 'SELECT count(*) n FROM file_items')
      if (n > 0 && n < 1000 && !finished()) midway = true
      await sleep(150)
    }
    assert.ok(during.length > 0, pet.out())
    assert.ok(Math.max(...during) < 1000, `掃描進行中 /health 要 1 秒內回：${during.join('、')} ms`)
    assert.ok(during.length >= 3 && midway, `前提：真的在掃描進行中量到（${during.length} 次）`)
    const m = await pet.until(/開機掃描：掃了 (\d+) 個檔案，(\d+) 個可以清/, 120_000)
    assert.deepEqual([m[1], m[2]], ['1000', '1000'], pet.out())
    const h = await http(port, 'GET', '/health')
    assert.equal(h.json.pendingCandidates, 1000)
  })

  test('同時間最多一個掃描子行程；pet 結束時把它一起收掉', { skip: LINUX_ONLY }, async t => {
    const s = sandbox(t)
    // 一千個檔要掃十幾秒：pet 結束之後子行程如果沒被收掉，下面那 3 秒裡它一定還在跑
    //（300 個檔的話它可能剛好自己掃完，沒收掉也看不出來 —— 突變測試抓到的洞）
    for (let i = 0; i < 1000; i++) s.put(`f${String(i).padStart(4, '0')}.zip`, 60)
    const pet = startPet(t, s, { CONTEXTBOX_RESCAN_MS: '100' })
    await pet.until(/按 Ctrl\+C/)
    let most = 0
    const seen = new Set()
    const t0 = Date.now()
    while (Date.now() - t0 < 2500) {
      const kids = childrenOf(pet.child.pid)
      for (const k of kids) seen.add(k)
      most = Math.max(most, kids.length)
      await sleep(25)
    }
    assert.ok(seen.size >= 1, '前提：看得到掃描子行程')
    assert.equal(most, 1, `同時有 ${most} 個掃描子行程`)
    const kids = childrenOf(pet.child.pid)
    assert.equal(kids.length, 1, '前提：一千個檔還在掃')
    assert.doesNotMatch(pet.out(), /開機掃描：掃了/, '前提：開機掃描還沒掃完')
    await pet.stop()
    const t1 = Date.now()
    while (kids.some(running) && Date.now() - t1 < 3000) await sleep(25)
    assert.ok(!kids.some(running), 'pet 結束了，掃描子行程還在跑')
  })

  test('掃描子行程被砍掉：記 lastError、pet 還活著、下一輪照掃', { skip: LINUX_ONLY }, async t => {
    const s = sandbox(t)
    for (let i = 0; i < 300; i++) s.put(`f${String(i).padStart(3, '0')}.zip`, 60)
    const pet = startPet(t, s, { CONTEXTBOX_RESCAN_MS: '1000' })
    const port = Number((await pet.until(/127\.0\.0\.1:(\d+)\/\?k=/))[1])
    await pet.until(/按 Ctrl\+C/)
    let first = []
    const t0 = Date.now()
    while (!(first = childrenOf(pet.child.pid)).length && Date.now() - t0 < 5000) await sleep(20)
    assert.equal(first.length, 1, '前提：開機掃描的子行程')
    assert.equal(meta(s, 'cleanup_last_error'), null, '前提')
    process.kill(first[0], 'SIGKILL')
    const t1 = Date.now()
    while (!meta(s, 'cleanup_last_error') && Date.now() - t1 < 5000) await sleep(50)
    assert.match(meta(s, 'cleanup_last_error') ?? '', /重掃/, `子行程被砍掉要記 lastError：\n${pet.out()}`)
    assert.equal(pet.child.exitCode, null, 'pet 不可以跟著掛掉')
    assert.equal((await http(port, 'GET', '/health')).status, 200)
    let next = []
    const t2 = Date.now()
    while (!(next = childrenOf(pet.child.pid).filter(k => k !== first[0])).length && Date.now() - t2 < 5000) await sleep(20)
    assert.equal(next.length, 1, '下一輪重掃沒有開始')
  })
})

// ── C3 ────────────────────────────────────────────────────────

describe('C3 open 只把帶鑰匙的網址交給真的 pet', () => {
  /** 在 port 0 起一個什麼都回 200 的假 /health。 */
  async function fakeHealth(t, body) {
    const srv = httpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
    await new Promise(r => srv.listen(0, '127.0.0.1', r))
    t.after(() => { srv.closeAllConnections(); return new Promise(r => srv.close(r)) })
    return srv.address().port
  }
  /** 免 token 的 /health 真的長這樣（產生器從真的 server 寫出來的範例） */
  const SHAPE = JSON.parse(readFileSync(join(REPO, 'docs', 'api', 'health.json'), 'utf8'))
  /** pet 記下來的 port 與 pid */
  const record = (s, port, pid) => {
    const d = s.db()
    const set = (k, v) => d.prepare(`INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(k, v)
    set('pet_port', String(port))
    set('watch_pid', String(pid))
    set('watch_heartbeat', new Date().toISOString())
  }

  test('那個 port 上是別的程式（/health 回 200 但不是 ContextBox）：不打開、不印鑰匙，離開碼 2', async t => {
    const s = sandbox(t)
    const port = await fakeHealth(t, { status: 'ok' })
    record(s, port, process.pid)
    const r = await runAsync(s, ['open'])
    assert.equal(r.code, 2, r.out)
    assert.ok(!existsSync(s.p.opened), '把帶鑰匙的網址交給了陌生程式')
    assert.doesNotMatch(r.out, /\?k=/, '不要印出帶鑰匙的網址')
    assert.match(r.out, /不是 ContextBox/)
  })

  test('形狀像 ContextBox，但記錄上的 pet 行程已經不在了：不打開，離開碼 2', async t => {
    const s = sandbox(t)
    const port = await fakeHealth(t, SHAPE)
    record(s, port, 2147483646)
    const r = await runAsync(s, ['open'])
    assert.equal(r.code, 2, r.out)
    assert.ok(!existsSync(s.p.opened), '記錄上的 pet 已經不在了，還是把網址交出去')
    assert.doesNotMatch(r.out, /\?k=/)
  })

  test('對照：形狀對、記錄上的 pid 還活著 → 打開（0）', async t => {
    const s = sandbox(t)
    const port = await fakeHealth(t, SHAPE)
    record(s, port, process.pid)
    const r = await runAsync(s, ['open'])
    assert.equal(r.code, 0, r.out)
    assert.match(readFileSync(s.p.opened, 'utf8'), new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\?k=`))
  })

  // pet 撞 port 走的是同一個判斷（第三波之二）：只有真的 pet 才印網址
  test('pet 撞 port：那個 port 上是別的程式（/health 回 200 但不是 ContextBox）→ 不印鑰匙，離開碼 2', async t => {
    const s = sandbox(t)
    const port = await fakeHealth(t, { status: 'ok' })
    const pet = startPet(t, s, { CONTEXTBOX_PORT: String(port) })
    const code = await pet.exited
    assert.equal(code, 2, pet.out())
    assert.doesNotMatch(pet.out(), /\?k=/, pet.out())
    assert.match(pet.out(), /不是 ContextBox/, pet.out())
  })

  test('pet 撞 port：形狀像 ContextBox，但記錄上的 pet 行程已經不在了 → 不印鑰匙，離開碼 2', async t => {
    const s = sandbox(t)
    const port = await fakeHealth(t, SHAPE)
    record(s, port, 2147483646)
    const pet = startPet(t, s, { CONTEXTBOX_PORT: String(port) })
    const code = await pet.exited
    assert.equal(code, 2, pet.out())
    assert.doesNotMatch(pet.out(), /\?k=/, pet.out())
    assert.match(pet.out(), /已經不在了/, pet.out())
  })

  test('pet 結束時清掉 pet_port', async t => {
    const s = sandbox(t)
    const pet = startPet(t, s)
    const port = (await pet.until(/127\.0\.0\.1:(\d+)\/\?k=/))[1]
    await pet.until(/按 Ctrl\+C/)
    assert.equal(meta(s, 'pet_port'), port, '前提：跑著的時候有記')
    await pet.stop()
    assert.equal(meta(s, 'pet_port'), null, 'pet 結束了，pet_port 還留著')
  })

  test('對照：pet_port 已經被別的 pet 改寫了 → 這個 pet 結束時不可以刪它', async t => {
    const s = sandbox(t)
    const pet = startPet(t, s)
    const port = (await pet.until(/127\.0\.0\.1:(\d+)\/\?k=/))[1]
    await pet.until(/按 Ctrl\+C/)
    assert.equal(meta(s, 'pet_port'), port, '前提')
    // 另一個 pet（開在別的 port）啟動之後，把 pet_port 改成它自己的
    const other = port === '65000' ? '65001' : '65000'
    s.db().prepare(`UPDATE meta SET v=? WHERE k='pet_port'`).run(other)
    await pet.stop()
    assert.equal(meta(s, 'pet_port'), other, '這個 pet 把別的 pet 記下的 port 刪掉了，open 會找不到那個還在跑的 pet')
  })

  test('關掉終端機（SIGHUP）也一樣清掉 pet_port', { skip: process.platform === 'win32' && '要送 SIGHUP' }, async t => {
    const s = sandbox(t)
    const pet = startPet(t, s)
    const port = (await pet.until(/127\.0\.0\.1:(\d+)\/\?k=/))[1]
    await pet.until(/按 Ctrl\+C/)
    assert.equal(meta(s, 'pet_port'), port, '前提')
    pet.child.kill('SIGHUP')
    await pet.exited
    assert.equal(meta(s, 'pet_port'), null)
  })
})

// ── C4 ────────────────────────────────────────────────────────

describe('C4 undo 放得回舊版搬進隔離區的桌面檔（放回不擴大清理範圍）', () => {
  /** 舊版 CLI 拿 roots 掃過、建了一份計畫但**還沒套用**（直接叫核心）。回那份計畫。 */
  function oldPlan(s, roots, ...names) {
    const d = s.db()
    scanDownloads({ db: d, roots, maxBytes: 20971520 })
    const ids = d.prepare(`SELECT c.id, i.name FROM cleanup_candidates c JOIN file_items i ON i.id=c.item_id
      WHERE c.status='proposed'`).all().filter(r => names.includes(r.name)).map(r => r.id)
    const p = createPlan(d, { candidateIds: ids })
    assert.deepEqual(p.items.map(i => i.name).sort(), [...names].sort(), '前提：計畫裡就是這幾個檔')
    return p
  }

  /** 舊版 CLI 拿 roots 清過一次（直接叫核心）。回那份計畫。 */
  function oldApply(s, roots, name) {
    const p = oldPlan(s, roots, name)
    const r = applyPlan(s.db(), p.id, { roots, quarantine: s.p.q, maxBytes: 20971520 })
    assert.equal(r.quarantinedCount, 1, '前提：舊版把它搬進隔離區了')
    return p
  }

  test('舊版 roots=[Desktop, Downloads] 搬走的桌面檔：新版 undo 放得回來（0）', t => {
    const s = sandbox(t)
    const desktop = join(s.home, 'Desktop')
    s.writeCfg({ watch: [desktop, s.dl] })
    const f = s.put('客戶提案.zip', 45, '還在用', desktop)
    const p = oldApply(s, [desktop, s.dl], '客戶提案.zip')
    assert.ok(!existsSync(f), '前提')
    const r = s.run(['cleanup', 'undo', p.id])
    assert.equal(r.code, 0, r.out)
    assert.ok(existsSync(f), `桌面的檔沒有放回來：\n${r.out}`)
  })

  test('watch 裡有不存在的資料夾：不影響放回', t => {
    const s = sandbox(t)
    const desktop = join(s.home, 'Desktop')
    s.writeCfg({ watch: [join(s.home, '不存在'), desktop, s.dl] })
    const f = s.put('客戶提案.zip', 45, '還在用', desktop)
    const p = oldApply(s, [desktop, s.dl], '客戶提案.zip')
    const r = s.run(['cleanup', 'undo', p.id])
    assert.equal(r.code, 0, r.out)
    assert.ok(existsSync(f), r.out)
  })

  test('不在 watch、也不在清理範圍的資料夾：放不回去（3），範圍沒有被擴大', t => {
    const s = sandbox(t)
    const other = join(s.home, 'Other')
    const f = s.put('x.zip', 45, 'x', other)
    const p = oldApply(s, [other, s.dl], 'x.zip')
    const r = s.run(['cleanup', 'undo', p.id])
    assert.equal(r.code, 3, r.out)
    assert.ok(!existsSync(f))
  })

  test('只在 cleanup.roots（不在 watch）的資料夾照樣放得回來', t => {
    const s = sandbox(t)
    const other = join(s.home, 'Other')
    mkdirSync(other)
    s.writeCfg({ watch: [s.dl], cleanup: { roots: [other] } })
    const f = s.put('x.zip', 45, 'x', other)
    s.run(['cleanup', 'scan'])
    const id = planIdOf(s.run(['cleanup', 'apply']).out)
    assert.ok(id && !existsSync(f), '前提')
    const r = s.run(['cleanup', 'undo', id])
    assert.equal(r.code, 0, r.out)
    assert.ok(existsSync(f), r.out)
  })

  // 第三波之二：C4 之後 CLI 有兩份範圍（execOpts 與 undoOpts），只有 undo 可以用寬的那份。
  // 上一版沒有測試守著 —— 把 runApply 的 execOpts() 換成 undoOpts()，全套照樣綠。
  test('apply 一份舊版建的、還沒套用的計畫（含桌面的檔）：只搬清理範圍裡的，桌面的留在原位，離開碼 3', t => {
    const s = sandbox(t)
    const desktop = join(s.home, 'Desktop')
    s.writeCfg({ watch: [desktop, s.dl] })            // 桌面在 watch 裡：undo 的範圍含它，apply 的不可以
    const onDesk = s.put('客戶提案.zip', 45, '還在用', desktop)
    const inDl = s.put('舊的.zip', 60)
    const p = oldPlan(s, [desktop, s.dl], '客戶提案.zip', '舊的.zip')
    const r = s.run(['cleanup', 'apply', p.id])
    assert.equal(r.code, 3, r.out)
    assert.ok(existsSync(onDesk), `apply 用了 undo 的範圍，桌面的檔被搬走了：\n${r.out}`)
    assert.match(r.out, /✘ 客戶提案\.zip/, r.out)
    // 對照：同一份計畫裡在清理範圍（Downloads）的照搬
    assert.ok(!existsSync(inDl), r.out)
    assert.match(r.out, /✔ 舊的\.zip/, r.out)
  })

  // 第三波之二：cleanup.roots 本身也要先檢查過。執行層逐一 checkedPath 每一個 root，
  // 其中一個不存在（外接碟拔掉了）就丟例外 —— 上一版只過濾 watch，C4 放回桌面的檔就整個失效。
  test('cleanup.roots 裡有一個資料夾不見了（外接碟拔掉）：舊版搬走的桌面檔照樣放回（0）', t => {
    const s = sandbox(t)
    const desktop = join(s.home, 'Desktop')
    const external = join(s.home, 'External')
    mkdirSync(external)
    s.writeCfg({ watch: [desktop, s.dl], cleanup: { roots: [s.dl, external] } })
    const f = s.put('客戶提案.zip', 45, '還在用', desktop)
    const p = oldApply(s, [desktop, s.dl], '客戶提案.zip')
    rmSync(external, { recursive: true })
    const r = s.run(['cleanup', 'undo', p.id])
    assert.equal(r.code, 0, r.out)
    assert.ok(existsSync(f), `外接碟不在，桌面的檔就放不回來：\n${r.out}`)
  })

  test('apply 還是只用清理範圍：桌面上的舊檔不會被新版搬走', t => {
    const s = sandbox(t)
    const desktop = join(s.home, 'Desktop')
    s.writeCfg({ watch: [desktop, s.dl] })
    const f = s.put('客戶提案.zip', 45, '還在用', desktop)
    scanDownloads({ db: s.db(), roots: [desktop, s.dl], maxBytes: 20971520 })
    const r = s.run(['cleanup', 'apply'])
    assert.equal(r.code, 0, r.out)
    assert.ok(existsSync(f))
  })
})

// ── C5 ────────────────────────────────────────────────────────

describe('C5 檔名裡的換行類字元與 bidi 控制字元、編號至少 4 碼', () => {
  test('U+2028、U+202E（RLO）、U+2066 一律換成「·」；一般的中文與 emoji 原樣', t => {
    const s = sandbox(t)
    for (const n of ['a\u2028✔ 偽造.zip', 'invoice\u202Efdp.exe', 'b\u2066c\u2069.zip', '報告 🎉.zip']) s.put(n, 60)
    assert.equal(s.run(['cleanup', 'scan']).code, 0)
    const list = s.run(['cleanup', 'list'])
    const applied = s.run(['cleanup', 'apply'])
    assert.equal(applied.code, 0, applied.out)
    const undone = s.run(['cleanup', 'undo'])
    for (const o of [list.out, applied.out, undone.out]) {
      assert.ok(!/[\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/.test(o), `印出了換行類或 bidi 控制字元：${JSON.stringify(o)}`)
    }
    assert.match(list.out, /invoice·fdp\.exe/, list.out)
    assert.match(list.out, /a·✔ 偽造\.zip/, list.out)
    assert.match(list.out, /b·c·\.zip/, list.out)
    assert.match(list.out, /報告 🎉\.zip/, '一般的中文與 emoji 不可以被換掉')
  })

  // shown() 的字元範圍**每一段都要有字元踩到**（第三波之二）：上一版只放了 U+2028、U+202E、U+2066／2069，
  // 把 U+061C、U+200E、U+202A 這幾個從範圍裡拿掉，測試照樣全綠。
  test('Bidi_Control 每一段都換：U+061C、U+200E、U+200F、U+202A–202E、U+2066–2069，還有 U+2029', t => {
    const s = sandbox(t)
    const BIDI = ['\u061c', '\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',
      '\u2066', '\u2067', '\u2068', '\u2069', '\u2029']
    // 每個字元一個檔：少換任何一個，那個檔名就原樣印出來
    const names = BIDI.map((c, i) => `x${i}${c}y.zip`)
    for (const n of names) s.put(n, 60)
    assert.equal(s.run(['cleanup', 'scan']).code, 0)
    const list = s.run(['cleanup', 'list'])
    for (const [i, c] of BIDI.entries()) {
      const hex = c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
      assert.ok(!list.out.includes(c), `U+${hex} 原樣印出來了：${JSON.stringify(list.out)}`)
      assert.ok(list.out.includes(`x${i}·y.zip`), `U+${hex} 沒有換成「·」：\n${list.out}`)
    }
  })

  test('編號只打 3 碼：就算剛好只對到一個也回 1（至少 4 碼）；打 4 碼照常', t => {
    const s = sandbox(t, { files: { 'a.zip': 60, 'b.zip': 60 } })
    s.run(['cleanup', 'scan'])
    // id 改成固定的：3 碼 abc 剛好只對到 a.zip
    const d = new DatabaseSync(s.p.db, { enableForeignKeyConstraints: false })
    for (const [name, id] of [['a.zip', 'abc0ffee-0000-4000-8000-000000000001'], ['b.zip', 'ffff0000-0000-4000-8000-000000000002']]) {
      const old = d.prepare('SELECT id FROM file_items WHERE name=?').get(name).id
      d.prepare('UPDATE file_items SET id=? WHERE id=?').run(id, old)
      d.prepare('UPDATE cleanup_candidates SET item_id=? WHERE item_id=?').run(id, old)
    }
    d.close()
    const three = s.run(['cleanup', 'apply', '--skip', 'abc'])
    assert.equal(three.code, 1, three.out)
    assert.match(three.out, /至少 4 碼/)
    assert.ok(existsSync(join(s.dl, 'a.zip')) && existsSync(join(s.dl, 'b.zip')), '什麼都不可以動')
    assert.equal(count(s, 'SELECT count(*) n FROM cleanup_plans'), 0)
    const four = s.run(['cleanup', 'apply', '--skip', 'abc0'])
    assert.equal(four.code, 0, four.out)
    assert.ok(existsSync(join(s.dl, 'a.zip')) && !existsSync(join(s.dl, 'b.zip')), four.out)
  })
})

// ── C6 ────────────────────────────────────────────────────────

describe('C6 唯讀模式也要驗確認碼', () => {
  const RO = { CONTEXTBOX_READONLY: '1' }
  /** 隔離區有一個滿七天的檔，而且已經預覽過（拿到確認碼）。 */
  function previewed(t) {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    s.run(['cleanup', 'scan'])
    s.run(['cleanup', 'apply'])
    s.db().prepare('UPDATE cleanup_move_details SET completed_at=?').run(new Date(Date.now() - 8 * DAY).toISOString())
    const token = /--yes (\S+)/.exec(s.run(['cleanup', 'quarantine', '--empty']).out)?.[1]
    assert.ok(token, '前提：拿到確認碼')
    const kept = () => count(s, `SELECT count(*) n FROM cleanup_purges WHERE status='done'`) === 0
    return { s, token, kept }
  }

  test('確認碼錯 → 1；確認碼對 → 0；兩次都不刪', t => {
    const { s, token, kept } = previewed(t)
    const bad = s.run(['cleanup', 'quarantine', '--empty', '--yes', 'typo-token'], RO)
    assert.equal(bad.code, 1, bad.out)
    assert.match(bad.out, /cleanup quarantine --empty/, '要講怎麼重新預覽')
    const good = s.run(['cleanup', 'quarantine', '--empty', '--yes', token], RO)
    assert.equal(good.code, 0, good.out)
    assert.match(good.out, /唯讀模式/)
    assert.ok(kept(), '唯讀模式刪了檔')
  })

  test('過期的確認碼 → 1', t => {
    const { s, token, kept } = previewed(t)
    s.db().prepare('UPDATE cleanup_empty_requests SET expires_at=?').run(new Date(Date.now() - 1000).toISOString())
    const r = s.run(['cleanup', 'quarantine', '--empty', '--yes', token], RO)
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /過期/)
    assert.ok(kept())
  })

  // 判準是「跟真的清空一樣」：核心的 emptyQuarantine 對已經確認過的確認碼是**重送原本的結果**
  //（先看有沒有結果、才看過期），不是無效。唯讀模式回 1 的話，同一個指令拿掉唯讀是 0，試跑就不準了。
  test('已經確認用過的確認碼：跟真的清空一樣算重送 → 唯讀也是 0，過期了也一樣', t => {
    const { s, token } = previewed(t)
    const real = s.run(['cleanup', 'quarantine', '--empty', '--yes', token])
    assert.equal(real.code, 0, real.out)
    assert.match(real.out, /刪掉 1 個/, '前提：真的清空用掉了這個確認碼')
    // 對照：不是唯讀的時候，同一個確認碼再送一次是重送（核心回原本的結果）
    const replay = s.run(['cleanup', 'quarantine', '--empty', '--yes', token])
    assert.equal(replay.code, 0, replay.out)
    const ro = s.run(['cleanup', 'quarantine', '--empty', '--yes', token], RO)
    assert.equal(ro.code, 0, `用過的確認碼在唯讀模式被當成無效：\n${ro.out}`)
    assert.match(ro.out, /唯讀模式/)
    s.db().prepare('UPDATE cleanup_empty_requests SET expires_at=?').run(new Date(Date.now() - 1000).toISOString())
    const replayExpired = s.run(['cleanup', 'quarantine', '--empty', '--yes', token])
    assert.equal(replayExpired.code, 0, `前提：核心對用過的確認碼先重送、不看過期：\n${replayExpired.out}`)
    const roExpired = s.run(['cleanup', 'quarantine', '--empty', '--yes', token], RO)
    assert.equal(roExpired.code, 0, `用過的確認碼過期之後，唯讀模式說過期：\n${roExpired.out}`)
  })
})

// ── C7 ────────────────────────────────────────────────────────

describe('C7 需要人看的超過 50 個：「太大」與「讀不到」照全部分開算', () => {
  // 兩種的數量**故意不一樣**（第三波之二）：上一版兩個都是 30，tooLarge／unreadable 對調了也全綠
  test('40 個太大＋20 個讀不到：doctor 各講各的數字；核心的計數加起來等於總數', t => {
    const s = sandbox(t, { config: { maxBytes: 1024 } })
    for (let i = 0; i < 40; i++) s.put(`big${i}.zip`, 60, 'x'.repeat(4096))
    for (let i = 0; i < 20; i++) s.lock(s.put(`locked${i}.zip`, 60, 'y'))
    assert.equal(s.run(['cleanup', 'scan']).code, 0)
    const l = listCandidates(s.db(), { roots: [s.dl], limit: 0 })
    assert.equal(l.needsHumanTotal, 60, '前提')
    assert.equal(l.needsHuman.length, 50, '前提：陣列只回前 50 個')
    assert.deepEqual(l.needsHumanCounts, { tooLarge: 40, unreadable: 20 })
    assert.equal(l.needsHuman.filter(x => x.why === TOO_LARGE_WHY).length
      + l.needsHuman.filter(x => x.why !== TOO_LARGE_WHY).length, 50)
    const r = s.run(['doctor'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /(?<!\d)20 個讀不到或搬不動/, r.out)
    assert.match(r.out, /(?<!\d)40 個太大/, r.out)
    assert.doesNotMatch(r.out, /(?<!\d)40 個讀不到|(?<!\d)20 個太大/, `兩個數字對調了：\n${r.out}`)
    assert.doesNotMatch(r.out, /沒有列出來/, '全部都分開算了，不該再有「沒有列出來」的')
  })
})
