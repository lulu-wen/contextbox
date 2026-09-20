import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行：這支起 server、spawn cli.mjs，家目錄要先換掉
/**
 * 2026-09-19 稽核第二輪第二階段：CLI 與 pet（cli.mjs）接上第一階段的核心
 * （~/contextbox-稽核-20260919.md 的「根因（第二輪）」R2-1、R2-4、R2-5、R2-8、R2-9、R2-10、R2-11）。
 *
 * **期望值是動手之前寫死的**（build-round Step 1），先紅再修。實作中可以改寫法，不可以改期望值。
 *
 * ── Step 0 分級 ───────────────────────────────────────────────────
 * 高風險：收尾接線（部分失敗、併發：錯了檔案對使用者來說就是不見了）、離開碼（右鍵選單與腳本的契約）、
 * pet 的身分（權限邊界：鑰匙交給誰）、背景掃描逾時（併發，錯了會安靜地停止重掃）。
 * 低風險：doctor 的新段落、docs/cli.md（錯了馬上看得見）—— 只做輕量版。
 *
 * ── Step 1 ─────────────────────────────────────────────────────────
 *
 * | 段落 | 可能的錯 | 另一種解讀 | 成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | R2-1a 收尾接線 | 只在 apply／undo 前收尾 | 每個讀或動清理狀態的指令前都收尾 | rename 之後被砍，接著直接 quarantine／doctor／undo（不給 id）／rename 之前被砍 | 列出 1 個、數得到並列出那份計畫、找得到並放回（0）／隔離區是空的、undo 回 1、那一列結成 reverted |
 * | R2-1a BUSY | 鎖被佔就讓指令失敗（2） | 略過這一次收尾，指令照跑 | 別的行程拿著清理鎖時跑 list／quarantine／doctor | 0，照常印，不印錯 |
 * | R2-5 自動放棄 | 所有 proposed 都放棄；或看錯時間方向 | 只放棄超過 60 分鐘、而且沒有任何 journal 的 | 61 分鐘前沒開始的／59 分鐘前沒開始的／61 分鐘前開始過的 | dismissed＋release 標記／proposed／proposed |
 * | R2-1a pet | 只靠背景掃描子行程收尾 | pet 自己在開機與每一輪重掃之前收尾 | 子行程卡住（什麼都沒做）時，開機前就中斷的／pet 跑著時才中斷的 | 兩列都結成 done |
 * | R2-4 pet 的放回範圍 | pet 只給 server 清理範圍 | 清理範圍 ∪ watch | 舊版從桌面搬走的檔，桌面在 watch 裡／桌面不在 watch 也不在清理範圍 | 面板復原放回桌面／放不回（moved），範圍沒有擴大 |
 * | R2-8 截圖資料夾 | CLI 與 pet 不帶 screenshotsDir，截圖資料夾套全部規則 | 只收截圖類 | 截圖資料夾裡 120 天的 proposal.zip／Downloads 裡 120 天的 proposal2.zip／截圖資料夾裡的舊截圖 | 不列、不搬／列／列 |
 * | R2-10 種類 | CLI 記沒種類的成功，任何成功都清掉任何錯 | 同一種動作成功才清 | 面板掃描出錯 → CLI 掃描成功／套用出錯 → CLI 掃描成功 | 寵物不擔心、doctor 說不會再擔心／寵物擔心、doctor 說還在擔心 |
 * | R2-10 全失敗 | 每一項都失敗也記成功 | 記成 apply 種類的錯 | 兩個檔都失敗／一個失敗一個成功 | lastError kind apply、沒有 apply 的成功／有 apply 的成功、沒有錯 |
 * | R2-10 掃描問題 | 只印 stderr | 存起來（不帶完整路徑），doctor 印 | 有打不開的資料夾（--json 也一樣）／下一次沒問題 | 存了、doctor 印／清掉、doctor 不印 |
 * | R2-1 undo 離開碼 | 看計畫 status 是 partial 就 3 | 只看逐項：moved／purged／unknown 才算沒放回 | C-exp2（失敗的那一項原檔後來被刪）、核心回 partial 但沒有任何一項留在隔離區／隔離區的檔被改過 | 0／3 |
 * | R2-1 apply 離開碼 | 看計畫 status | 看逐項（failed／unknown／cancelled／pending 才算沒做成） | 計畫是 partial 但逐項全搬了／有幾項沒處理到（cancelled） | 0／3 |
 * | cancelled 說法 | 「已放棄，沒有動過」 | 沒處理、本來就在原位 | 放棄的計畫裡的檔 | 「沒有處理（…中途停了或放棄了），本來就在原位」 |
 * | R2-5 doctor | 列出所有 proposed | 只列有 journal 的 proposed | 做到一半中斷的／還沒開始的 | 列 id、幾個已經在隔離區、undo 與 apply 兩條路／不列 |
 * | R2-11 OneDrive | 只看 win32 | 路徑裡有 OneDrive 那一層就講 | 清理範圍 ~/OneDrive/Downloads／~/Downloads | 提醒「搬進隔離區等於雲端刪除」／不提醒 |
 * | R2-9 身分 | 看形狀與 pid | 驗 HMAC(token, `${埠}:${nonce}`) | 冒牌只回形狀（pid 活著，C-e5）／直接跑 server.ts（沒有 pid，C-e9） | 2 不交鑰匙／0 打開 |
 * | R2-9 綁埠 | proof 只算 nonce | 連埠號一起算 | 冒牌把 nonce 轉給另一個埠的真 pet／直接問那個真 pet | 2／0 |
 * | R2-9 down | 照印帶鑰匙的網址 | 不印 | pet 沒在跑 | 2，不印 ?k=，不開瀏覽器 |
 * | R2-9 撞 port | 只印網址 | 印網址也打開瀏覽器 | 撞到自己的 pet／撞到冒牌 | 0 而且打開／2 不打開 |
 * | R2-10 逾時 | 沒有逾時，卡住就再也不重掃 | 逾時殺掉、記 scan 的錯、下一輪照常 | 子行程卡住超過逾時／掃描在逾時內做完 | 記「背景掃描逾時」、有新的子行程、舊的被殺／沒有逾時的錯 |
 *
 * 接手之後補的幾列。唯讀試跑、自動放棄之後 apply 這兩列是先看到紅燈才改程式；doctor 的總數那一列是先改了程式，
 * 再用突變（把改動還原）確認測試會紅；undo 離開碼、OneDrive 的名字兩列程式本來就對，只是沒有測試釘住（突變存活）。
 *
 * | 段落 | 可能的錯 | 另一種解讀 | 成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | R2-1a 每一個入口 | 只有幾個入口收尾（其他靠前一個指令順便收） | 每一個入口自己收 | 被砍之後第一個跑 scan／list／cleanup／apply／undo／release／quarantine／doctor | 每一個跑完那一列都是 done |
 * | R2-10 掃描問題的總數 | doctor 把核心收過的 50 條當成 50 個 | 最後一條「還有 N 條沒有列出來。」要算回去 | 60 個硬鏈結檔（60 條）／1 個打不開的資料夾（1 條） | 存 49＋「還有 11 條」、doctor 說 60 個、列 10 個、另外 50 個／doctor 說 1 個 |
 * | R2-3 唯讀試跑 | 唯讀照舊把 failed 算成「會清掉」 | 套用過的計畫再套用原樣回傳，會清掉 0 個 | partial 的計畫／還沒套用的 2 個檔的計畫 | 會清掉 0 個＋「不會重試」／會清掉 2 個 |
 * | R2-5 自動放棄之後 apply <id> | 照舊說「已經放棄了」（使用者會以為自己按錯） | 講出可能是超過一小時自動放棄的 | 61 分鐘的／59 分鐘的 | 0、講自動放棄、檔不動／照常套用、檔搬走 |
 * | R2-1 undo 離開碼 | 只把還在隔離區的（moved）算沒放回 | 已經清空、狀態不明也算 | a 放回、b 狀態不明、c 已清空／C-exp2 全放回 | 3、「有 2 個沒放回」／0 |
 * | R2-11 OneDrive 的名字 | 只認剛好叫 OneDrive；或環境變數只比字串前綴 | 「OneDrive - 公司」「OneDrive-Personal」都算；環境變數要比到資料夾分隔 | OneDrive - Contoso、OneDrive-Personal、OneDriveCommercial 底下／OneDriveTemp、Sync/Workshop（前綴是 Sync/Work） | 出聲／不出聲 |
 *
 * 預設的決定（寫清楚，不猜）：
 * - 收尾（recoverInterrupted、releaseStalePlans）碰到 BUSY 安靜略過；其他錯印一行警告，指令照跑。
 * - pet 交給 server 的放回範圍是「清理範圍 ∪ watch」整份清單，不先過濾：server 每次復原都會逐一 checkedPath
 *   （跟 undoRoots 同一個規則），pet 開著的時候才插上的外接碟也放得回去。
 * - OneDrive 的提醒不分作業系統：路徑裡有一層叫 OneDrive（OneDrive、OneDrive - 公司、OneDrive-Personal），
 *   或在 OneDrive／OneDriveConsumer／OneDriveCommercial 環境變數指的資料夾底下。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, realpathSync, existsSync,
  readFileSync, chmodSync, symlinkSync, linkSync,
} from 'node:fs'
import { spawnSync, spawn } from 'node:child_process'
import { createServer as httpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { open } from '../core/db.ts'
import { scanDownloads } from '../core/cleanup-scanner.ts'
import { createPlan } from '../core/cleanup-plans.ts'
import { applyPlan } from '../core/cleanup-exec.ts'
import { initCleanup } from '../core/cleanup-journal.ts'
import * as routes from '../core/cleanup-routes.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(REPO, 'cli.mjs')
const CRASH = join(REPO, 'test', 'helpers', 'r2-crash-child.mjs')
const HANG = pathToFileURL(join(REPO, 'test', 'helpers', 'hang-scan.mjs')).href
const DAY = 86400_000
const MAX = 20971520
const sleep = ms => new Promise(r => setTimeout(r, ms))
const noPerm = process.platform === 'win32' || process.getuid?.() === 0
const NO_SH = process.platform === 'win32' && 'opener 用的是 sh 腳本'

assert.ok(FAKE_HOME, '前提：測試行程的家目錄已經換掉')

// ── 沙盒 ─────────────────────────────────────────────────────

/** 一個完全隔離的 CLI 環境：HOME 就是暫存資料夾，cleanup.roots 的預設（~/Downloads）落在沙盒裡。 */
function sandbox(t, { files = {}, config = {} } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cb-r2cli-')))
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
    readonly: false, pdfPages: 3, maxBytes: MAX, ...config,
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
    CONTEXTBOX_TOKEN_PATH: p.token, CONTEXTBOX_PORT: '0',
    CONTEXTBOX_OPENER: p.opener, CB_OPENED: p.opened,
    ...extra,
  })
  const run = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: env(extra), timeout: 60_000 })
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '' }
  }
  const dbs = []
  const db = () => { const d = open(p.db); dbs.push(d); return d }
  const locked = []
  // 這個沙盒裡起的 pet 與 server，刪沙盒之前先收掉（不然背景重掃會在刪掉的沙盒裡重建資料庫）
  const stops = []
  t.after(async () => {
    for (const stop of stops.splice(0)) await stop()
    for (const d of dbs) { try { d.close() } catch { /* 已經關了 */ } }
    for (const f of locked) { try { chmodSync(f, 0o755) } catch { /* 已經沒了 */ } }
    rmSync(home, { recursive: true, force: true })
  })
  const lock = (f, mode = 0o000) => { chmodSync(f, mode); locked.push(f) }
  return { home, dl, p, put, run, env, db, writeCfg, lock, stops }
}

/** 讀一列（唯讀連線，不跟 CLI 搶鎖） */
const one = (s, sql, ...a) => {
  const d = new DatabaseSync(s.p.db, { readOnly: true })
  try { d.exec('PRAGMA busy_timeout = 5000'); return d.prepare(sql).get(...a) }
  finally { d.close() }
}
const meta = (s, k) => existsSync(s.p.db) ? one(s, 'SELECT v FROM meta WHERE k=?', k)?.v ?? null : null
const planIdOf = out => /Plan ([0-9a-f-]{36})/.exec(out)?.[1]

/** 某個檔（照檔名）的候選 id */
const candIds = (d, name) => d.prepare(
  `SELECT c.id FROM cleanup_candidates c JOIN file_items i ON i.id=c.item_id WHERE i.name=? AND c.status='proposed'`,
).all(name).map(r => r.id)

/** pet 跑著的時候，建計畫可能剛好撞到 pet 收尾拿著鎖（BUSY）：重試幾次 */
async function retryBusy(fn) {
  for (let i = 0; ; i++) {
    try { return fn() } catch (e) { if (e?.code !== 'BUSY' || i > 20) throw e }
    await sleep(50)
  }
}

/**
 * 用 test/helpers/r2-crash-child.mjs 套用一份計畫，在 point（before-rename／after-rename）那一刻 SIGKILL。
 * 剛好撞到 pet 收尾拿著鎖（BUSY）的話重來。
 */
async function crash(s, planId, point) {
  const opts = JSON.stringify({ roots: [s.dl], quarantine: s.p.q, maxBytes: MAX })
  for (let i = 0; i < 20; i++) {
    const r = spawnSync(process.execPath, [CRASH, s.p.db, opts, 'apply', planId, point],
      { encoding: 'utf8', env: s.env(), timeout: 30_000 })
    if (r.signal === 'SIGKILL') return
    assert.match(r.stderr, /BUSY|Another cleanup action/, `前提：子行程在 ${point} 被砍：\n${r.stdout}${r.stderr}`)
    await sleep(50)
  }
  assert.fail('前提：一直拿不到清理鎖')
}

/** 等到 cond() 成立（或逾時就失敗） */
async function until(cond, why, ms = 15_000) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) assert.fail(why())
    await sleep(40)
  }
}

/** 非同步跑一次 CLI（測試行程自己起了 server 的時候要用這個，spawnSync 會卡住事件迴圈） */
function runAsync(s, args, extra = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { env: s.env(extra) })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.once('close', code => resolve({ code, out: stdout + stderr, stdout }))
  })
}

function startPet(t, s, extra = {}) {
  const child = spawn(process.execPath, [CLI, 'pet'], { env: s.env(extra) })
  let out = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { out += d })
  const exited = new Promise(r => child.once('exit', code => r(code)))
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await exited
  }
  s.stops.push(stop)
  const wait = async (re, ms = 15_000) => {
    const t0 = Date.now()
    while (!re.test(out)) {
      if (child.exitCode !== null) throw new Error(`pet 結束了（${child.exitCode}）：\n${out}`)
      if (Date.now() - t0 > ms) throw new Error(`等不到 ${re}：\n${out}`)
      await sleep(30)
    }
    return re.exec(out)
  }
  /** 起好了：回實際的 port */
  const ready = async () => {
    const m = await wait(/127\.0\.0\.1:(\d+)\/\?k=/)
    await wait(/Ctrl\+C to stop/)
    return Number(m[1])
  }
  return { child, wait, ready, out: () => out, stop, exited }
}

/** 帶 token 打 API（不帶 Origin） */
async function api(port, token, method, path, body) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'x-contextbox-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not answer with JSON */ }
  return { status: r.status, json, text }
}

/** 寵物現在的狀態（跟 /pet/state 同一支 petState，拿帶 token 的完整版） */
function petNow(s) {
  const d = s.db()
  routes.invalidateQuarantineCache()
  const h = routes.healthSnapshot(d, { roots: [s.dl], quarantine: s.p.q, full: true })
  return routes.petState(h, { proposedPlans: 0, activeQuarantine: 0 }).state
}

const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

/** hang-scan.mjs 記下來的卡住的子行程 */
const hungPids = log => existsSync(log)
  ? [...new Set(readFileSync(log, 'utf8').split('\n').filter(Boolean).map(Number))] : []
/**
 * 收掉卡住的子行程（pet 收掉之後才跑）。pet 該殺的它自己會殺；這裡是保險 —— pet 沒殺掉的話，
 * 它們繼承了 pet 的 stderr，測試行程的管線一直關不掉，整支測試檔會掛到逾時（突變測試抓到的）。
 */
function killHung(log) {
  for (const pid of hungPids(log)) { try { process.kill(pid, 'SIGKILL') } catch { /* 已經不在了 */ } }
}

// ═══ R2-1a／R2-5 ・ 每個清理指令之前先收尾 ══════════════════════

describe('R2-1a／R2-5 開機與每個清理指令之前先收尾（recoverInterrupted、releaseStalePlans）', () => {
  const statusOf = (s, id) => one(s, `SELECT status FROM cleanup_journal WHERE plan_id=? AND op='quarantine'`, id)?.status

  // 稽核第三輪 R3-1 改了這一條的後半：收尾把 journal 結成 done 之後，**整份都做完的計畫也要收掉** ——
  // 它不再是「做到一半中斷」，而是 applied。所以 doctor 的「中斷計畫」不該再列它（以前列著，
  // 寵物也永遠說「有 1 份清單等你確認」而面板的待確認清單是空的），但隔離區照樣列得出來、undo 照樣放得回。
  test('C-exp8：單檔計畫在 rename 之後被砍 → quarantine 列得出、計畫收成 applied（不再是中斷計畫）、undo（不給 id）放回（0）', async t => {
    const s = sandbox(t, { files: { 'only.zip': 120 } })
    assert.equal(s.run(['cleanup', 'scan']).code, 0)
    const p = createPlan(s.db())
    assert.deepEqual(p.items.map(i => i.name), ['only.zip'], '前提：單檔計畫')
    await crash(s, p.id, 'after-rename')
    assert.ok(!existsSync(join(s.dl, 'only.zip')), '前提：檔已經搬走')
    assert.equal(statusOf(s, p.id), 'started', '前提：journal 停在 started')

    const q = s.run(['cleanup', 'quarantine'])
    assert.equal(q.code, 0, q.out)
    assert.match(q.out, /Quarantine holds 1 file/, `隔離區裡的檔看不到：\n${q.out}`)
    assert.match(q.out, /only\.zip/)

    const doc = s.run(['doctor'])
    assert.equal(doc.code, 0, doc.out)
    assert.match(doc.out, /Quarantine[^\n]*\n\s+1 file/, doc.out)
    assert.equal(one(s, 'SELECT status FROM cleanup_plans WHERE id=?', p.id).status, 'applied',
      '整份都做完了，計畫不可以還停在 proposed（R3-1）')
    assert.equal(one(s, `SELECT count(*) n FROM cleanup_plans WHERE status='proposed'`).n, 0,
      '寵物不可以再說「有 1 份清單等你確認」')
    assert.doesNotMatch(doc.out, /Interrupted/, `已經做完的不是Interrupted：\n${doc.out}`)

    const u = s.run(['cleanup', 'undo'])
    assert.equal(u.code, 0, u.out)
    assert.ok(u.out.includes(p.id), u.out)
    assert.ok(existsSync(join(s.dl, 'only.zip')), `沒有放回：\n${u.out}`)
    const after = s.run(['doctor'])
    assert.match(after.out, /Quarantine[^\n]*\n\s+0 files/, after.out)
    assert.ok(!after.out.includes(p.id), `放回之後就不是中斷的計畫了：\n${after.out}`)
  })

  test('每一個入口自己收尾：被砍之後第一個跑的是哪一個清理指令（scan／list／apply／undo／release／quarantine、doctor），都先把那一列結掉', async t => {
    const ok0 = r => assert.equal(r.code, 0, r.out)
    for (const [args, check] of [
      // R3-1：單檔計畫整份做完了 → 收成 applied，不再是「中斷計畫」（隔離區照樣算得到那個檔）
      [['doctor'], r => { ok0(r); assert.match(r.out, /Quarantine[^\n]*\n\s+1 file/, r.out); assert.doesNotMatch(r.out, /Interrupted/, r.out) }],
      [['cleanup', 'quarantine'], r => { ok0(r); assert.match(r.out, /Quarantine holds 1 file/, r.out) }],
      [['cleanup', 'undo'], r => { ok0(r); assert.match(r.out, /Put 1 file back/, r.out) }],
      [['cleanup', 'scan'], ok0],
      [['cleanup', 'list'], ok0],
      [['cleanup'], ok0],
      [['cleanup', 'apply'], () => {}],               // 那個檔已經不在 Downloads：沒東西清或撞到中斷的計畫，離開碼不管
      [['cleanup', 'release', '<id>'], r => assert.match(r.out, /has started|Finish it|Put back/, r.out)],   // 收完之後是 applied，放棄不了（1）
    ]) {
      const s = sandbox(t, { files: { 'only.zip': 120 } })
      s.run(['cleanup', 'scan'])
      const p = createPlan(s.db())
      await crash(s, p.id, 'after-rename')
      assert.equal(statusOf(s, p.id), 'started', '前提')
      const r = s.run(args.map(a => a === '<id>' ? p.id : a))
      assert.equal(statusOf(s, p.id), 'done', `${args.join(' ')} 之前沒有收尾：\n${r.out}`)
      check(r)
    }
  })

  test('對照：rename 之前被砍 → 檔還在原位；收尾把那一列結成 reverted，quarantine 是空的、undo（不給 id）回 1', async t => {
    const s = sandbox(t, { files: { 'only.zip': 120 } })
    s.run(['cleanup', 'scan'])
    const p = createPlan(s.db())
    await crash(s, p.id, 'before-rename')
    assert.ok(existsSync(join(s.dl, 'only.zip')), '前提：還在原位')
    const q = s.run(['cleanup', 'quarantine'])
    assert.equal(q.code, 0, q.out)
    assert.match(q.out, /Quarantine is empty/, q.out)
    assert.equal(statusOf(s, p.id), 'reverted', '收尾：原位的指紋對得上、隔離區只有預留的空檔 → 沒搬')
    const u = s.run(['cleanup', 'undo'])
    assert.equal(u.code, 1, u.out)
    assert.match(u.out, /There is no cleanup to undo/)
    assert.ok(existsSync(join(s.dl, 'only.zip')))
  })

  test('清理鎖被別的行程拿著（BUSY）：收尾略過這一次，list／quarantine／doctor 照常（0），不印錯', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    s.run(['cleanup', 'scan'])
    const d = s.db()
    initCleanup(d)
    // 這個測試行程拿著鎖（活著、剛拿的）
    d.prepare('INSERT OR REPLACE INTO cleanup_operation_lock VALUES (1,?,?)').run(process.pid, `${new Date().toISOString()} ${randomUUID()}`)
    for (const args of [['cleanup', 'list'], ['cleanup', 'quarantine'], ['doctor']]) {
      const r = s.run(args)
      assert.equal(r.code, 0, `${args.join(' ')}：\n${r.out}`)
      assert.doesNotMatch(r.out, /tidying up|Another cleanup action is running/, `BUSY 要安靜skipped：\n${r.out}`)
    }
    assert.match(s.run(['cleanup', 'list']).out, /a\.zip/)
  })

  test('放了超過 60 分鐘、從沒開始的計畫自動放棄（候選不動）；59 分鐘的、開始過的都不動', t => {
    const s = sandbox(t, { files: { 'a.zip': 60, 'b.zip': 60, 'c.zip': 60, 'd.zip': 60 } })
    s.run(['cleanup', 'scan'])
    const d = s.db()
    const plan = (...names) => createPlan(d, { candidateIds: names.flatMap(n => candIds(d, n)) })
    const old = plan('a.zip'), young = plan('b.zip'), started = plan('c.zip', 'd.zip')
    assert.throws(() => applyPlan(d, started.id, {
      roots: [s.dl], quarantine: s.p.q, maxBytes: MAX, onProgress: i => { if (i === 1) throw new Error('模擬中斷') },
    }), /模擬中斷/)
    const ago = min => new Date(Date.now() - min * 60_000).toISOString()
    d.prepare('UPDATE cleanup_plans SET created_at=? WHERE id=?').run(ago(61), old.id)
    d.prepare('UPDATE cleanup_plans SET created_at=? WHERE id=?').run(ago(59), young.id)
    d.prepare('UPDATE cleanup_plans SET created_at=? WHERE id=?').run(ago(61), started.id)
    const r = s.run(['cleanup', 'list'])
    assert.equal(r.code, 0, r.out)
    const st = id => one(s, 'SELECT status FROM cleanup_plans WHERE id=?', id).status
    assert.equal(st(old.id), 'dismissed', '61 分鐘前、沒開始的要dropped automatically')
    assert.ok(one(s, 'SELECT 1 x FROM cleanup_plan_releases WHERE plan_id=?', old.id), '是放棄（release），不是使用者拒絕')
    assert.equal(st(young.id), 'proposed', '59 分鐘的還不到')
    assert.equal(st(started.id), 'proposed', '開始過的只能做完或放回，不能dropped automatically')
    assert.match(r.out, /a\.zip/, '放棄計畫不動候選：a.zip 還在清單上')
  })

  /**
   * 這一條本來釘的是「apply <放了 61 分鐘的計畫> 會先被自己的收尾自動放棄」——
   * **第三輪 R3-6b 判定那是 bug**（使用者指名要跑的那一份被同一個指令在前一毫秒作廢，
   * 然後回報成功 0，包裝的腳本會判定「清理完成」）。指名的那一份現在會照常套用。
   * 這裡改釘兩件事：(1) 指名的照常套用；(2) 被**別的**指令自動放棄之後再 apply，
   * 還是要講清楚「可能是超過一小時自動放棄的」（原本那句話的價值）。
   */
  test('apply <放了 61 分鐘的計畫>：指名的照常套用；被別的指令自動放棄之後再 apply 才講「自動放棄」（0、檔不動）', t => {
    const s = sandbox(t, { files: { 'a.zip': 60, 'b.zip': 60 } })
    s.run(['cleanup', 'scan'])
    const d = s.db()
    const old = createPlan(d, { candidateIds: candIds(d, 'a.zip') })
    const young = createPlan(d, { candidateIds: candIds(d, 'b.zip') })
    const ago = min => new Date(Date.now() - min * 60_000).toISOString()
    d.prepare('UPDATE cleanup_plans SET created_at=? WHERE id=?').run(ago(61), old.id)
    d.prepare('UPDATE cleanup_plans SET created_at=? WHERE id=?').run(ago(59), young.id)
    // 指名它：收尾要跳過它（R3-6b），檔真的搬走
    const r = s.run(['cleanup', 'apply', old.id])
    assert.equal(r.code, 0, r.out)
    assert.doesNotMatch(r.out, /was dropped/, `使用者指名的那一份被同一個指令的收尾作廢了：\n${r.out}`)
    assert.ok(!existsSync(join(s.dl, 'a.zip')), `指名的計畫要照常套用：\n${r.out}`)
    // 沒指名的那一份：放到超過一小時之後，任何一個清理指令的收尾都會放棄它
    d.prepare('UPDATE cleanup_plans SET created_at=? WHERE id=?').run(ago(61), young.id)
    assert.equal(s.run(['cleanup', 'list']).code, 0)
    assert.equal(one(s, 'SELECT status FROM cleanup_plans WHERE id=?', young.id).status, 'dismissed', '前提：被dropped automatically了')
    const y = s.run(['cleanup', 'apply', young.id])
    assert.equal(y.code, 0, y.out)
    assert.match(y.out, /sat unapplied for over an hour[^\n]*dropped automatically/, y.out)
    assert.ok(existsSync(join(s.dl, 'b.zip')), 'was dropped的計畫不可以搬檔')
  })

  test('pet 開機與每一輪背景重掃之前都先收尾（掃描子行程卡住、自己收不了尾也一樣）', async t => {
    const s = sandbox(t, { files: { 'a.zip': 120, 'b.zip': 120 } })
    s.run(['cleanup', 'scan'])
    const d = s.db()
    const pa = createPlan(d, { candidateIds: candIds(d, 'a.zip') })
    await crash(s, pa.id, 'after-rename')
    assert.equal(statusOf(s, pa.id), 'started', '前提')
    const log = join(s.home, 'hang.log')
    // 背景掃描的子行程一起來就卡住（preload 裡，cli.mjs 還沒開始跑）：收尾只可能是 pet 自己做的
    const pet = startPet(t, s, {
      NODE_OPTIONS: `--import=${HANG}`, CB_HANG_LOG: log,
      CONTEXTBOX_SCAN_TIMEOUT_MS: '400', CONTEXTBOX_RESCAN_MS: '300',
    })
    s.stops.push(async () => killHung(log))
    await pet.ready()
    await until(() => statusOf(s, pa.id) === 'done', () => `pet 開機沒有收尾：\n${pet.out()}`)
    const pb = await retryBusy(() => createPlan(s.db(), { candidateIds: candIds(d, 'b.zip') }))
    await crash(s, pb.id, 'after-rename')
    await until(() => statusOf(s, pb.id) === 'done', () => `背景full-rescan之前沒有收尾：\n${pet.out()}`)
    assert.ok(existsSync(log), '前提：背景掃描的子行程真的卡住過')
  })
})

// ═══ R2-4／R2-8 ・ pet 交給 server 的範圍、CLI 帶截圖資料夾 ══════

describe('R2-4／R2-8 pet 把放回範圍與截圖資料夾交給 server；CLI 也帶截圖資料夾', () => {
  /** 舊版（RC15 之前）用 [桌面, Downloads] 當清理範圍，掃描＋套用。回那份計畫。 */
  function oldApply(s, desktop) {
    s.put('proposal.zip', 120, 'p', desktop)
    s.put('a.zip', 120)
    const d = s.db()
    scanDownloads({ db: d, roots: [desktop, s.dl], maxBytes: MAX })
    const p = createPlan(d)
    applyPlan(d, p.id, { roots: [desktop, s.dl], quarantine: s.p.q, maxBytes: MAX })
    assert.ok(!existsSync(join(desktop, 'proposal.zip')), '前提：舊版把桌面的檔搬走了')
    return p
  }

  test('C-e1（pet 的叫法）：舊版從桌面搬走的檔，面板的復原放得回桌面', async t => {
    const s = sandbox(t)
    const desktop = join(s.home, 'Desktop')
    s.writeCfg({ watch: [desktop, s.dl] })            // cleanup.roots 沒寫：預設只有 Downloads
    const p = oldApply(s, desktop)
    const pet = startPet(t, s)
    const port = await pet.ready()
    const token = readFileSync(s.p.token, 'utf8').trim()
    const r = await api(port, token, 'POST', `/cleanup/plans/${p.id}/undo`, {})
    assert.equal(r.status, 200, r.text)
    assert.ok(existsSync(join(desktop, 'proposal.zip')), `面板的復原放不回桌面：${r.text}`)
    assert.ok(existsSync(join(s.dl, 'a.zip')))
  })

  test('對照：桌面不在 watch、也不在清理範圍 → 面板放不回（範圍沒有被擴大）', async t => {
    const s = sandbox(t)
    const desktop = join(s.home, 'Desktop')
    const p = oldApply(s, desktop)                    // watch 只有 Downloads
    const pet = startPet(t, s)
    const port = await pet.ready()
    const token = readFileSync(s.p.token, 'utf8').trim()
    const r = await api(port, token, 'POST', `/cleanup/plans/${p.id}/undo`, {})
    assert.equal(r.status, 200, r.text)
    assert.ok(!existsSync(join(desktop, 'proposal.zip')), '範圍外的資料夾被放回去了')
    const item = r.json.items.find(i => i.name === 'proposal.zip')
    assert.equal(item.outcome, 'moved', r.text)
    assert.ok(existsSync(join(s.dl, 'a.zip')))
  })

  test('R2-8 截圖資料夾：CLI 的 list、apply 與 pet 的 /cleanup/candidates 都只收截圖，proposal.zip 不列不搬', async t => {
    const s = sandbox(t, { config: { cleanup: { screenshots: true } } })
    // Linux 的截圖資料夾是 ~/Pictures/Screenshots（macOS 是桌面，同一套規則）
    const shots = process.platform === 'darwin' ? join(s.home, 'Desktop') : join(s.home, 'Pictures', 'Screenshots')
    s.put('proposal.zip', 120, 'p', shots)
    s.put('Screenshot from 2026-05-01 10-00-00.png', 120, 's', shots)
    s.put('proposal2.zip', 120, 'p2')                 // 同樣的舊壓縮檔，放在 Downloads
    assert.equal(s.run(['cleanup', 'scan']).code, 0)
    const l = s.run(['cleanup', 'list'])
    assert.equal(l.code, 0, l.out)
    assert.match(l.out, /proposal2\.zip/, l.out)
    assert.match(l.out, /Screenshot from/, l.out)
    assert.doesNotMatch(l.out, /proposal\.zip/, `截圖資料夾裡的壓縮檔不可以列：\n${l.out}`)

    const pet = startPet(t, s)
    const port = await pet.ready()
    await pet.wait(/Startup scan: looked at/)
    const token = readFileSync(s.p.token, 'utf8').trim()
    const c = await api(port, token, 'GET', '/cleanup/candidates')
    assert.equal(c.status, 200, c.text)
    assert.deepEqual(c.json.candidates.map(x => x.name).sort(), ['Screenshot from 2026-05-01 10-00-00.png', 'proposal2.zip'])
    await pet.stop()

    const a = s.run(['cleanup', 'apply'])
    assert.equal(a.code, 0, a.out)
    assert.ok(existsSync(join(shots, 'proposal.zip')), `截圖資料夾裡的壓縮檔被搬走了：\n${a.out}`)
    assert.ok(!existsSync(join(s.dl, 'proposal2.zip')), a.out)
  })
})

// ═══ R2-10 ・ 成功與錯誤分種類 ════════════════════════════════

describe('R2-10 成功與錯誤分種類；doctor 跟寵物講同一句話', () => {
  test('面板掃描出錯一次、CLI 掃描成功 → 寵物不擔心，doctor 也說不會再為它擔心', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    routes.recordCleanupError(s.db(), new Error('模擬：面板掃描的時候出錯了'), 'scan')
    assert.equal(petNow(s), 'worried', '前提')
    assert.equal(s.run(['cleanup', 'scan']).code, 0)
    assert.notEqual(petNow(s), 'worried', 'CLI 的掃描成功要記成「掃描」的成功')
    const doc = s.run(['doctor'])
    assert.match(doc.out, /has stopped worrying/, doc.out)
    assert.doesNotMatch(doc.out, /is still worried/, doc.out)
  })

  test('對照（C-e6）：套用壞掉（隔離區是捷徑）、CLI 掃描成功 → 寵物還在擔心，doctor 也說還在擔心', { skip: process.platform === 'win32' && '要 symlink' }, t => {
    const s = sandbox(t, { files: { 'a.zip': 120 } })
    mkdirSync(join(s.home, 'elsewhere'))
    symlinkSync(join(s.home, 'elsewhere'), s.p.q)
    s.run(['cleanup', 'scan'])
    const a = s.run(['cleanup', 'apply'])
    assert.equal(a.code, 2, a.out)
    assert.match(meta(s, 'cleanup_last_error_kind') ?? '', / apply$/, '套用的錯要記成 apply 種類')
    assert.equal(s.run(['cleanup', 'scan']).code, 0)
    assert.equal(petNow(s), 'worried', '掃描成功不可以蓋掉一直壞著的套用')
    const doc = s.run(['doctor'])
    assert.match(doc.out, /is still worried/, doc.out)
    assert.doesNotMatch(doc.out, /has stopped worrying/, doc.out)
  })

  test('每一項都失敗的套用記成 apply 的錯，不記套用成功；有一項成功就記成功', t => {
    for (const [gone, expectError] of [[['a.zip', 'b.zip'], true], [['a.zip'], false]]) {
      const s = sandbox(t, { files: { 'a.zip': 60, 'b.zip': 60 } })
      s.run(['cleanup', 'scan'])
      const p = createPlan(s.db())
      for (const n of gone) rmSync(join(s.dl, n))
      const r = s.run(['cleanup', 'apply', p.id])
      assert.equal(r.code, 3, r.out)
      if (expectError) {
        assert.match(meta(s, 'cleanup_last_error') ?? '', /This cleanup moved nothing/, r.out)
        assert.match(meta(s, 'cleanup_last_error_kind') ?? '', / apply$/)
        assert.equal(meta(s, 'cleanup_last_ok_apply'), null, '全部失敗不是成功')
      } else {
        assert.equal(meta(s, 'cleanup_last_error'), null, r.out)
        assert.ok(meta(s, 'cleanup_last_ok_apply'), '有搬成的就是成功')
      }
    }
  })

  test('每一種動作成功記自己的種類：scan、apply、undo、empty', t => {
    const s = sandbox(t, { files: { 'a.zip': 60, 'b.zip': 60 } })
    s.run(['cleanup', 'scan'])
    assert.ok(meta(s, 'cleanup_last_ok_scan'), 'scan')
    const codes = {}
    for (const x of s.run(['cleanup', 'list']).out.matchAll(/\[([0-9a-f-]{4,})\] [✔☐] (.+)$/gm)) codes[x[2].trim()] = x[1]
    const first = planIdOf(s.run(['cleanup', 'apply', '--skip', codes['b.zip']]).out)
    assert.ok(first && meta(s, 'cleanup_last_ok_apply'), 'apply')
    const second = planIdOf(s.run(['cleanup', 'apply']).out)
    assert.ok(second)
    assert.equal(s.run(['cleanup', 'undo', second]).code, 0)
    assert.ok(meta(s, 'cleanup_last_ok_undo'), 'undo')
    s.db().prepare('UPDATE cleanup_move_details SET completed_at=?').run(new Date(Date.now() - 8 * DAY).toISOString())
    const token = /--yes (\S+)/.exec(s.run(['cleanup', 'quarantine', '--empty']).out)?.[1]
    assert.ok(token, '前提：有確認碼')
    assert.equal(s.run(['cleanup', 'quarantine', '--empty', '--yes', token]).code, 0)
    assert.ok(meta(s, 'cleanup_last_ok_empty'), 'empty')
  })

  // 打不開的資料夾不管幾個都併成一條，要湊出 60 條各自不同的問題，用 60 個硬鏈結檔（掃描逐檔回報「硬鏈結檔案不清理」）
  test('掃描回報的問題跟 POST /cleanup/scan 同一套整理：超過 50 條收成「還有 N 條」；doctor 講的總數是 60', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    const elsewhere = join(s.home, 'links')
    mkdirSync(elsewhere)
    for (let i = 0; i < 60; i++) {
      const name = `h${String(i).padStart(2, '0')}.zip`
      linkSync(s.put(name, 60, 'h' + i), join(elsewhere, name))
    }
    assert.equal(s.run(['cleanup', 'scan', '--json']).code, 0)
    const probs = JSON.parse(meta(s, 'cleanup_scan_problems') ?? 'null')
    assert.equal(probs?.length, 50, JSON.stringify(probs))
    assert.match(probs[48], /hard-link/, JSON.stringify(probs))
    assert.equal(probs[49], '11 more are not listed.', '超過的要講出還有幾條，不可以默默截掉')
    const doc = s.run(['doctor'])
    assert.match(doc.out, /The last scan reported 60 problems/, doc.out)
    assert.equal((doc.out.match(/^ {10}⚠ h\d\d\.zip/gm) ?? []).length, 10, doc.out)
    assert.match(doc.out, /…and 50 more/, doc.out)
  })

  test('掃描回報的問題存起來（不帶完整路徑），doctor 印出來；pet 的背景重掃（--json）也存；下一次沒問題就清掉', { skip: noPerm && '要 chmod' }, t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    const sub = join(s.dl, '鎖住的')
    s.put('b.zip', 60, 'b', sub)
    s.lock(sub)
    assert.equal(s.run(['cleanup', 'scan', '--json']).code, 0)
    const probs = JSON.parse(meta(s, 'cleanup_scan_problems') ?? 'null')
    assert.ok(Array.isArray(probs) && probs.some(x => /ould not be open/.test(x)), `沒存：${JSON.stringify(probs)}`)
    assert.ok(!JSON.stringify(probs).includes(s.home), `帶了完整路徑：${JSON.stringify(probs)}`)
    const doc = s.run(['doctor'])
    assert.match(doc.out, /Scan issues[^\n]*\n[^\n]*ould not be open/, doc.out)
    chmodSync(sub, 0o755)
    assert.equal(s.run(['cleanup', 'scan']).code, 0)
    assert.deepEqual(JSON.parse(meta(s, 'cleanup_scan_problems')), [])
    assert.doesNotMatch(s.run(['doctor']).out, /Scan issues/)
  })
})

// ═══ R2-1 ・ 離開碼照逐項結果 ═════════════════════════════════

describe('R2-1 離開碼照逐項結果，不看計畫的 status', () => {
  /** a.zip 在 Downloads、b.zip 在唯讀的 sub：套用時 b 搬不動（rename EACCES），a 搬進隔離區 */
  function halfFailed(t) {
    const s = sandbox(t, { files: { 'a.zip': 120 } })
    const sub = join(s.dl, 'sub')
    s.put('b.zip', 120, 'b', sub)
    s.run(['cleanup', 'scan'])
    s.lock(sub, 0o555)
    const a = s.run(['cleanup', 'apply'])
    assert.equal(a.code, 3, a.out)
    chmodSync(sub, 0o755)
    return { s, sub, id: planIdOf(a.out) }
  }

  test('C-exp2：套用失敗的那一項，原檔後來被刪 → undo 0，不說「有 0 個沒放回」', { skip: noPerm && '要 chmod' }, t => {
    const { s, sub } = halfFailed(t)
    rmSync(join(sub, 'b.zip'))
    const u = s.run(['cleanup', 'undo'])
    assert.equal(u.code, 0, u.out)
    assert.ok(existsSync(join(s.dl, 'a.zip')), u.out)
    assert.doesNotMatch(u.out, /0 were not put back/)
  })

  test('核心回 partial，但沒有任何一項留在隔離區（b 從沒搬過）→ 0，照印核心的原因', { skip: noPerm && '要 chmod' }, t => {
    const { s, id } = halfFailed(t)
    // b 在隔離區的預留空檔被寫進東西：核心照實丟 VERIFY_FAILED（那不是 b，也不能說它不在）
    const row = one(s, `SELECT j.to_path FROM cleanup_journal j JOIN file_items i ON i.id=j.item_id
      WHERE j.plan_id=? AND j.op='quarantine' AND i.name='b.zip'`, id)
    writeFileSync(row.to_path, '不是當初那個檔')
    const u = s.run(['cleanup', 'undo', id])
    assert.equal(one(s, 'SELECT status FROM cleanup_plans WHERE id=?', id).status, 'partial', `前提：核心回 partial：\n${u.out}`)
    assert.equal(u.code, 0, `放回了每一個搬走的檔，離開碼是 0：\n${u.out}`)
    assert.match(u.out, /↩ a\.zip/)
    assert.match(u.out, /does not match what was moved in/, `核心的原因要照印：\n${u.out}`)
    assert.ok(existsSync(join(s.dl, 'sub', 'b.zip')), 'b 一直在原位')
  })

  test('對照：真的有一項沒放回（隔離區的檔被改過）→ 3', t => {
    const s = sandbox(t, { files: { 'a.zip': 60, 'b.zip': 60 } })
    s.run(['cleanup', 'scan'])
    const id = planIdOf(s.run(['cleanup', 'apply']).out)
    const b = one(s, 'SELECT id FROM file_items WHERE name=?', 'b.zip').id
    writeFileSync(join(s.p.q, id, b, 'content'), '隔離區裡的檔被改過')
    const u = s.run(['cleanup', 'undo', id])
    assert.equal(u.code, 3, u.out)
    assert.match(u.out, /1 were not put back/)
  })

  test('undo：已經清空的、狀態不明的都算沒放回 → 3，數字跟行數對得上（對照組：C-exp2 那條全放回是 0）', t => {
    const s = sandbox(t, { files: { 'a.zip': 120, 'b.zip': 120, 'c.zip': 120 } })
    s.run(['cleanup', 'scan'])
    const id = planIdOf(s.run(['cleanup', 'apply']).out)
    const d = s.db()
    const row = n => d.prepare(`SELECT j.seq, j.to_path FROM cleanup_journal j JOIN file_items i ON i.id=j.item_id
      WHERE i.name=? AND j.op='quarantine' AND j.plan_id=?`).get(n, id)
    // b：搬到一半中斷而且**真的說不準** → 收尾也結不掉，unknown。
    // 稽核第三輪 R3-4 之後「隔離區有真的內容、只是指紋對不上」會被收成 done（檔確實在隔離區），
    // 所以要留下 unknown 就只剩「隔離區那個位置根本讀不出指紋」：這裡把它換成一個資料夾
    // （別的程式搞出來的），原位也沒有那個檔 —— 兩邊都給不出證據。
    const b = row('b.zip')
    d.prepare(`UPDATE cleanup_journal SET status='started' WHERE seq=?`).run(b.seq)
    rmSync(b.to_path)
    mkdirSync(b.to_path)
    // c：滿七天、清空掉了 → purged
    d.prepare('UPDATE cleanup_move_details SET completed_at=? WHERE seq=?').run(new Date(Date.now() - 8 * DAY).toISOString(), row('c.zip').seq)
    const token = /--yes (\S+)/.exec(s.run(['cleanup', 'quarantine', '--empty']).out)?.[1]
    assert.equal(s.run(['cleanup', 'quarantine', '--empty', '--yes', token]).code, 0, '前提：清空了 c')
    const u = s.run(['cleanup', 'undo', id])
    assert.equal(u.code, 3, u.out)
    assert.match(u.out, /↩ a\.zip/)
    assert.match(u.out, /c\.zip[^\n]*already emptied/, u.out)
    assert.match(u.out, /\? b\.zip[^\n]*state unknown/, u.out)
    assert.match(u.out, /2 were not put back/, u.out)
    assert.match(u.out, /unknown state, run node cli\.mjs doctor/, u.out)
  })

  test('apply：計畫的 status 是 partial 但逐項全部搬了 → 0；有幾項沒處理到（cancelled）→ 3，說還在原位', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    s.run(['cleanup', 'scan'])
    const id = planIdOf(s.run(['cleanup', 'apply']).out)
    s.db().prepare(`UPDATE cleanup_plans SET status='partial' WHERE id=?`).run(id)
    const r = s.run(['cleanup', 'apply', id])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /✔ a\.zip/)

    const s2 = sandbox(t, { files: Object.fromEntries(['f0.zip', 'f1.zip', 'f2.zip'].map(n => [n, 60])) })
    s2.run(['cleanup', 'scan'])
    const d = s2.db()
    const p = createPlan(d)
    assert.throws(() => applyPlan(d, p.id, {
      roots: [s2.dl], quarantine: s2.p.q, maxBytes: MAX, onProgress: i => { if (i === 1) throw new Error('模擬中斷') },
    }), /模擬中斷/)
    // 計畫跑過（例如鎖被接走之後別人寫了結果），後兩項從來沒碰過
    d.prepare(`UPDATE cleanup_plans SET status='partial' WHERE id=?`).run(p.id)
    const c = s2.run(['cleanup', 'apply', p.id])
    assert.equal(c.code, 3, c.out)
    assert.match(c.out, /2 files not handled this time[^\n]*still where they were/, c.out)
    assert.doesNotMatch(c.out, /reason unknown/)
  })

  test('cancelled 講實話：沒有處理（計畫中途停了或放棄了），本來就在原位', t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    s.run(['cleanup', 'scan'])
    const p = createPlan(s.db())
    assert.equal(s.run(['cleanup', 'release', p.id]).code, 0)
    const r = s.run(['cleanup', 'apply', p.id])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /a\.zip[^\n]*not handled[^\n]*never moved/, r.out)
    assert.doesNotMatch(r.out, /to quarantine/)
  })

  // 第二輪 R2-3：partial／error 的計畫再 apply 原樣回傳、不重試。唯讀試跑要講同一件事，
  // 不可以說「會清掉 1 個」（真的套用一個都不會動）
  test('唯讀模式 apply <partial 的計畫>：會清掉 0 個（再套用不重試）；對照：還沒套用的計畫照算', { skip: noPerm && '要 chmod' }, t => {
    const { s, id } = halfFailed(t)
    assert.equal(one(s, 'SELECT status FROM cleanup_plans WHERE id=?', id).status, 'partial', '前提')
    const ro = s.run(['cleanup', 'apply', id], { CONTEXTBOX_READONLY: '1' })
    assert.equal(ro.code, 0, ro.out)
    assert.match(ro.out, /would clean up 0 files/, ro.out)
    assert.match(ro.out, /does not retry/, ro.out)
    const real = s.run(['cleanup', 'apply', id])
    // 真的再套用一次也是 no-op：第三輪 R3-2b 之後不再印「搬進隔離區 1 個」（那會讓人以為剛剛真的清了），
    // 改成照實說「先前已經跑過了，這次什麼都沒做」。
    assert.match(real.out, /nothing happened this time/, `前提：真的再套用一次也沒有多搬：\n${real.out}`)
    assert.doesNotMatch(real.out, /Moved \d+ files? \(/, real.out)
    assert.ok(existsSync(join(s.dl, 'sub', 'b.zip')))

    const s2 = sandbox(t, { files: { 'c.zip': 60, 'd.zip': 60 } })
    s2.run(['cleanup', 'scan'])
    const p = createPlan(s2.db())
    const ro2 = s2.run(['cleanup', 'apply', p.id], { CONTEXTBOX_READONLY: '1' })
    assert.equal(ro2.code, 0, ro2.out)
    assert.match(ro2.out, /would clean up 2 files/, ro2.out)
  })
})

// ═══ R2-5／R2-11 ・ doctor 的新段落 ═══════════════════════════

describe('R2-5／R2-11 doctor 列出做到一半中斷的計畫；清理範圍在 OneDrive 底下要出聲', () => {
  test('中斷的計畫：id、幾個已經在隔離區、undo 與 apply 兩條路；還沒開始的計畫不列在這裡', t => {
    const s = sandbox(t, { files: Object.fromEntries(['f0.zip', 'f1.zip', 'f2.zip', 'f3.zip'].map(n => [n, 60])) })
    s.run(['cleanup', 'scan'])
    const d = s.db()
    const cut = createPlan(d, { candidateIds: ['f0.zip', 'f1.zip', 'f2.zip'].flatMap(n => candIds(d, n)) })
    assert.throws(() => applyPlan(d, cut.id, {
      roots: [s.dl], quarantine: s.p.q, maxBytes: MAX, onProgress: i => { if (i === 2) throw new Error('模擬中斷') },
    }), /模擬中斷/)
    const fresh = createPlan(d, { candidateIds: candIds(d, 'f3.zip') })
    const doc = s.run(['doctor'])
    assert.equal(doc.code, 0, doc.out)
    assert.match(doc.out, /Interrupted 1 plan/, doc.out)
    assert.ok(doc.out.includes(cut.id), doc.out)
    assert.match(doc.out, /3 files, 2 already in quarantine/, doc.out)
    assert.ok(doc.out.includes(`node cli.mjs cleanup undo ${cut.id}`))
    assert.ok(doc.out.includes(`node cli.mjs cleanup apply ${cut.id}`))
    assert.ok(!doc.out.includes(fresh.id), `還沒開始的計畫不是中斷的：\n${doc.out}`)
  })

  test('清理範圍在 OneDrive 底下：doctor 提醒搬進隔離區等於雲端刪除；對照：一般的 Downloads 不提醒', t => {
    const s = sandbox(t)
    const plain = s.run(['doctor'])
    assert.doesNotMatch(plain.out, /OneDrive/, plain.out)
    const od = join(s.home, 'OneDrive', 'Downloads')
    mkdirSync(od, { recursive: true })
    s.writeCfg({ cleanup: { roots: [od] } })
    const doc = s.run(['doctor'])
    assert.equal(doc.code, 0, doc.out)
    assert.match(doc.out, /OneDrive[^\n]*quarantine[^\n]*cloud/, doc.out)
  })

  test('OneDrive 的幾種資料夾名字（公司版「OneDrive - 公司」、macOS 的 OneDrive-Personal）都要出聲；對照：OneDriveTemp 不是同步資料夾', t => {
    const s = sandbox(t)
    for (const [name, warned] of [['OneDrive - Contoso', true], ['OneDrive-Personal', true], ['OneDriveTemp', false]]) {
      const root = join(s.home, name, 'Downloads')
      mkdirSync(root, { recursive: true })
      s.writeCfg({ cleanup: { roots: [root] } })
      const doc = s.run(['doctor'], { OneDrive: '', OneDriveConsumer: '', OneDriveCommercial: '' })
      assert.equal(doc.code, 0, doc.out)
      if (warned) assert.match(doc.out, /is inside OneDrive[^\n]*cloud/, `${name}：\n${doc.out}`)
      else assert.doesNotMatch(doc.out, /is inside OneDrive/, `${name}：\n${doc.out}`)
    }
  })

  test('OneDrive 資料夾不叫 OneDrive（公司的 OneDriveCommercial 指到別的名字）：在它底下要出聲；對照：旁邊的資料夾不出聲', t => {
    const s = sandbox(t)
    const work = join(s.home, 'Sync', 'Work')
    const inside = join(work, 'Downloads'), beside = join(s.home, 'Sync', 'Workshop')
    for (const d of [inside, beside]) mkdirSync(d, { recursive: true })
    // 變數不叫 env：RC22 的檢查器會把同名的 env 當成 sandbox 的 env 助手一起檢查
    const oneDriveEnv = { OneDrive: '', OneDriveConsumer: '', OneDriveCommercial: work }
    s.writeCfg({ cleanup: { roots: [beside] } })
    assert.doesNotMatch(s.run(['doctor'], oneDriveEnv).out, /inside OneDrive/, '前綴相同但不在底下的不算')
    s.writeCfg({ cleanup: { roots: [inside] } })
    assert.match(s.run(['doctor'], oneDriveEnv).out, /is inside OneDrive[^\n]*cloud/)
  })
})

// ═══ R2-9 ・ open／pet 用證明認 pet ═══════════════════════════

describe('R2-9 open／pet 用 /health 的 proof 認 pet（綁埠號），不看 pid', () => {
  /** 冒牌：只回一個形狀像免 token /health 的 JSON，記下收到的網址 */
  async function fake(t, handler) {
    const got = []
    const srv = httpServer(async (req, res) => {
      got.push(req.url)
      const body = handler ? await handler(req) : JSON.parse(readFileSync(join(REPO, 'docs', 'api', 'health.json'), 'utf8'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
    await new Promise(r => srv.listen(0, '127.0.0.1', r))
    t.after(() => { srv.closeAllConnections(); return new Promise(r => srv.close(r)) })
    return { port: srv.address().port, got }
  }
  const record = (s, port, pid) => {
    const d = s.db()
    const set = (k, v) => d.prepare(`INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(k, v)
    set('pet_port', String(port))
    set('watch_pid', String(pid))
    set('watch_heartbeat', new Date().toISOString())
  }

  test('C-e5：冒牌只回形狀像 /health 的 JSON（記錄上的 pid 還活著）→ open 不交鑰匙（2）', async t => {
    const s = sandbox(t)
    const f = await fake(t)
    record(s, f.port, process.pid)
    const r = await runAsync(s, ['open'], { CONTEXTBOX_PORT: String(f.port) })
    assert.equal(r.code, 2, r.out)
    assert.ok(!existsSync(s.p.opened), '把帶鑰匙的網址交給了冒牌')
    assert.doesNotMatch(r.out, /\?k=/)
    assert.ok(!f.got.some(u => /[?&]k=/.test(u)), `冒牌收到鑰匙：${f.got}`)
  })

  test('C-e9：直接跑 server.ts 的 start({port:0})（沒有 META.pid）→ open 驗證通過（0）', { skip: NO_SH }, async t => {
    const s = sandbox(t)
    const srvFile = join(s.home, 'srv.mjs')
    writeFileSync(srvFile, `import { start } from ${JSON.stringify(pathToFileURL(join(REPO, 'core', 'server.ts')).href)}\n`
      + 'const { ready } = start({ port: 0 })\nprocess.stdout.write("TEST_PORT=" + (await ready) + "\\n")\n')
    const child = spawn(process.execPath, [srvFile], { env: s.env() })
    s.stops.push(async () => { if (child.exitCode === null) { child.kill(); await new Promise(r => child.once('exit', r)) } })
    let out = '', err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    await until(() => {
      assert.equal(child.exitCode, null, `server 提前結束：${out}\n${err}`)
      return /^TEST_PORT=\d+\r?\n/m.test(out)
    }, () => `server 沒起來：${out}\n${err}`)
    const port = /^TEST_PORT=(\d+)\r?\n/m.exec(out)[1]
    assert.equal(meta(s, 'watch_pid'), null, '前提：沒有 META.pid')
    const r = await runAsync(s, ['open'], { CONTEXTBOX_PORT: port })
    assert.equal(r.code, 0, r.out)
    const token = readFileSync(s.p.token, 'utf8').trim()
    assert.equal(readFileSync(s.p.opened, 'utf8'), `http://127.0.0.1:${port}/?k=${encodeURIComponent(token)}`)
  })

  test('轉送攻擊：冒牌把 nonce 轉給另一個埠上的真 pet → open 與 pet 都不交鑰匙（2）；對照：直接問真 pet → 0', { skip: NO_SH }, async t => {
    const s = sandbox(t)
    const pet = startPet(t, s)
    const real = await pet.ready()
    const relay = await fake(t, async req => (await fetch(`http://127.0.0.1:${real}${req.url}`)).json())
    const r = await runAsync(s, ['open'], { CONTEXTBOX_PORT: String(relay.port) })
    assert.equal(r.code, 2, r.out)
    assert.ok(!existsSync(s.p.opened), '轉送的冒牌拿到了鑰匙')
    assert.doesNotMatch(r.out, /\?k=/)
    assert.ok(relay.got.some(u => /nonce=/.test(u)), `前提：open 真的帶 nonce 問了：${relay.got}`)
    const second = await runAsync(s, ['pet'], { CONTEXTBOX_PORT: String(relay.port) })
    assert.equal(second.code, 2, second.out)
    assert.doesNotMatch(second.out, /\?k=/, second.out)
    assert.ok(!relay.got.some(u => /[?&]k=/.test(u)), `冒牌收到鑰匙：${relay.got}`)

    const ok = await runAsync(s, ['open'], { CONTEXTBOX_PORT: String(real) })
    assert.equal(ok.code, 0, ok.out)
  })

  test('pet 沒在跑（down）：不印帶鑰匙的網址、不開瀏覽器（2）', async t => {
    const s = sandbox(t)
    const tmp = createServer()
    await new Promise(r => tmp.listen(0, '127.0.0.1', r))
    const port = tmp.address().port
    await new Promise(r => tmp.close(r))
    const r = s.run(['open'], { CONTEXTBOX_PORT: String(port) })
    assert.equal(r.code, 2, r.out)
    assert.doesNotMatch(r.out, /\?k=/, `pet 沒在跑還印帶鑰匙的網址：\n${r.out}`)
    assert.match(r.out, /node cli\.mjs pet/)
    assert.ok(!existsSync(s.p.opened))
  })

  test('C-e7：pet 撞 port、那裡是自己的 pet → 印網址而且打開瀏覽器（0）；對照：撞到冒牌 → 不開（2）', { skip: NO_SH }, async t => {
    const s = sandbox(t)
    const first = startPet(t, s)
    const port = await first.ready()
    const second = await runAsync(s, ['pet'], { CONTEXTBOX_PORT: String(port) })
    assert.equal(second.code, 0, second.out)
    const token = readFileSync(s.p.token, 'utf8').trim()
    const url = `http://127.0.0.1:${port}/?k=${encodeURIComponent(token)}`
    assert.ok(second.stdout.includes(url), second.out)
    assert.equal(readFileSync(s.p.opened, 'utf8'), url, '第二次點捷徑要把面板打開（Windows 上視窗一閃就沒了）')

    rmSync(s.p.opened)
    const f = await fake(t)
    const third = await runAsync(s, ['pet'], { CONTEXTBOX_PORT: String(f.port) })
    assert.equal(third.code, 2, third.out)
    assert.ok(!existsSync(s.p.opened))
  })
})

// ═══ R2-10 ・ 背景掃描逾時 ═══════════════════════════════════

describe('R2-10 pet 的背景掃描子行程有逾時', () => {
  test('子行程卡住（preload 讓 cleanup scan 永遠不回）：逾時殺掉、記 scan 種類的 lastError、下一輪有新的子行程', async t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    const log = join(s.home, 'hang.log')
    const pet = startPet(t, s, {
      NODE_OPTIONS: `--import=${HANG}`, CB_HANG_LOG: log,
      CONTEXTBOX_SCAN_TIMEOUT_MS: '400', CONTEXTBOX_RESCAN_MS: '300',
    })
    s.stops.push(async () => killHung(log))
    await pet.ready()
    const pids = () => hungPids(log)
    // lastError 與它的種類是兩次寫入（核心的 writeLastError），剛好在中間讀的話種類還沒寫：兩個都等到
    await until(() => /timed out/.test(meta(s, 'cleanup_last_error') ?? '') && / scan$/.test(meta(s, 'cleanup_last_error_kind') ?? ''),
      () => `逾時沒有記成掃描種類的 lastError（${meta(s, 'cleanup_last_error')}／${meta(s, 'cleanup_last_error_kind')}）：\n${pet.out()}`, 10_000)
    assert.match(meta(s, 'cleanup_last_error'), /Background scan timed out/)
    await until(() => pids().length >= 2, () => `下一輪沒有新的子行程：${pids()}\n${pet.out()}`, 10_000)
    const [firstPid] = pids()
    await until(() => !alive(firstPid), () => `逾時的子行程沒被殺掉：${firstPid}`, 5_000)
    assert.equal(pet.child.exitCode, null, 'pet 不可以跟著掛掉')
    assert.match(pet.out(), /timed out|without finishing/, '要講出來')
  })

  test('對照：掃描在逾時內做完 → 沒有逾時的錯', async t => {
    const s = sandbox(t, { files: { 'a.zip': 60 } })
    const pet = startPet(t, s, { CONTEXTBOX_SCAN_TIMEOUT_MS: '20000' })
    await pet.ready()
    await pet.wait(/Startup scan: looked at/)
    assert.equal(meta(s, 'cleanup_last_error'), null, pet.out())
  })
})
