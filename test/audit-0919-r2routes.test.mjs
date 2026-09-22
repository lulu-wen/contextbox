import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * 2026-09-19 稽核第二輪（~/contextbox-稽核-20260919.md 的「根因（第二輪）」）：路由、server 與設定那一組。
 *
 * **期望值是動手之前寫死的**（build-round Step 1），先紅再修。實作中可以改寫法，不可以改期望值。
 *
 * ── Step 1 ─────────────────────────────────────────────────────────
 *
 * | 段落 | 可能的錯 | 另一種解讀 | 成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | R2-1d 孤兒 | 只扣 started／reverted | 非 done 的列都扣，不管檔有沒有內容 | failed 列的 0 byte 預留檔／同一列 to_path 上有內容 | 不算／算 |
 * | R2-1d 孤兒 | 中斷的列一律扣 | 只扣空檔 | started 列 0 byte／started 列有內容（rename 完沒寫 done） | 不算／算（那是唯一的線索） |
 * | R2-1e 逐項結果 | 跑過的計畫、沒 journal 的一律 failed「原因不明」 | 沒 journal 也沒存原因＝沒處理到 | 沒原因／有 cleanup_item_errors／有 file_items.error | cancelled／failed＋存的原因／failed＋翻過的原因 |
 * | R2-1e recordItemErrors | stored:false 時看不到存的原因，把它當 cancelled 刪掉 | 存的原因一律算 | 只有 cleanup_item_errors 的一項跑 recordItemErrors | 那一列還在、逐項還是 failed |
 * | R2-4 放回範圍 | 面板 undo 只用清理範圍 | 清理範圍 ∪ 監看資料夾 | 舊版從桌面搬走的檔按面板復原／面板套用一份含桌面檔的計畫 | 放回桌面／桌面的檔不動（OUTSIDE_ROOT） |
 * | R2-4 預設 | restoreRoots 沒給就只用 roots | roots ∪ 設定的 watch | server 自己讀設定（watch 含桌面、cleanup.roots 只有 Downloads） | 面板復原放得回桌面 |
 * | R2-5b started | blockingPlan 不講開始了沒 | 有沒有任何 journal | 建了沒套用的／套用到一半中斷的 | started false／true |
 * | R2-7 不認得的 key | 物件就收、拼錯當沒帶 | 不認得就 400 | {candidateID}、{skippedIDs}、undo／dismiss／release 帶任何 key、empty 帶 tokne／第一方送的 key | 400 BAD_BODY 而且什麼都沒做／照樣通過 |
 * | R2-8 截圖資料夾 | 截圖資料夾套全部規則 | 只收截圖類 | 桌面 120 天的 proposal.zip／桌面舊截圖 | 不列／列 |
 * | R2-8 更深的根目錄 | 桌面底下一律只收截圖 | 最深的根目錄說了算 | 桌面/清理區/old.zip（清理區自己在清理範圍）／桌面/old.zip | 列／不列 |
 * | R2-9a proof | key 與訊息對調、格式錯也回 | HMAC(key=token, msg=`${埠}:${nonce}`)、格式錯不回 | 32 hex／31、33、非 hex、沒帶 | proof＝healthProof(token,實際監聽的埠,nonce)／沒有 proof 欄位 |
 * | R2-9 綁埠（第二階段） | proof 只算 nonce，可以被轉送 | 訊息裡帶 server 實際監聽的埠 | 同一個 nonce、這個 server 的埠／別的埠 | 相等／不相等 |
 * | R2-10 種類 | 任何成功蓋掉任何錯 | 同一種動作成功才算 | 套用的錯 → 掃描成功／→ 套用成功 | 還在擔心／不擔心 |
 * | R2-10 沒種類 | 沒帶 kind 的錯永遠不清 | 舊資料（沒種類）照舊：任何成功都清 | 沒種類的錯 → 掃描成功 | 不擔心 |
 * | R2-10 全失敗 | 全部失敗也記成功 | 記成錯 | 套用每一項都失敗／只有一項失敗 | 記錯（kind apply）／記成功 |
 * | R2-11 root 正規化 | 只比原樣 | 先換回一般寫法 | \\?\C:\Users\alice、\\localhost\C$\Users\alice、/System/Volumes/Data/Users／同樣前綴底下的 Downloads | 擋／放行 |
 * | R2-11 safeWhy | 寫入端的錯一律「讀不到」 | 各自一句 | EROFS、ENOSPC、EXDEV、ELOOP、EIO／ENOENT、EACCES | 各自不同的一句／照舊 |
 * | R2-11 /health 形狀 | facts 表壞掉回第三種形狀 | 欄位齊全、ok false | DROP TABLE facts／正常 | 欄位集合一樣、ok false／ok true |
 * | R2-12c canEmptyNow | 拿掉 truncated 防線 | 沒看完就 false | 走訪沒看完、七天已過／看完了 | false／true |
 *
 *
 * ── 第二階段（第一階段驗證員的存活突變與 R2-4 的邊界）────────────────
 *
 * | 段落 | 可能的錯（突變） | 另一種解讀 | 成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | V06 需要你查看 | 截圖資料夾底下讀不到的一般檔也列 | 只列截圖 | 桌面讀不到的 proposal.zip／讀不到的舊截圖 | 不列、不算／列、算 |
 * | V07 /pet/state 徽章 | 不帶截圖資料夾 | 跟清單同一套篩選 | 給了 screenshotsDir／沒給 | pendingCount 2／3 |
 * | V08 server 自己讀設定 | 截圖資料夾一律 null | 用設定算出來的 | cleanup.screenshots true、截圖資料夾有舊 zip 與舊截圖 | 清單只有截圖與 Downloads 的、徽章 2 |
 * | V09 清空部分成功 | 有錯就記成錯 | 一個都沒刪才算錯 | 刪了 1 個、錯 1 個／刪了 0 個（已有） | 記成功、不擔心／記錯（kind empty） |
 * | V10 建計畫的意外 | 沒有種類 | 算「套用」 | POST /cleanup/plans 的意外／GET /cleanup/candidates 的同一個意外 | kind apply，掃描成功清不掉／沒種類 |
 * | V12 免 token 的 /health | 露出 lastErrorKind | 遮蔽成 null | 免 token／帶 token | null／'apply' |
 * | V22 blockingPlan.started | 只看 done 列 | 任何一列 journal | 第一項 rename 之前被砍（只有 started 列）／還沒套用（已有） | true、release 409／false |
 * | R2-4 放回範圍全被略過 | 空範圍 → 500 BAD_CONFIG「請設定清理資料夾…」 | 退回清理範圍，交給執行層逐項回報 | Downloads 暫時不在（外接碟拔掉）／插回來 | 200、error、逐項「不見了」、kind undo／restored |
 * | R2-4 對照 | 退回的範圍也是空的時候硬跑 | 真的沒設定就是 BAD_CONFIG | 清理範圍本身是空的 | 500 BAD_CONFIG |
 * | R2-4 只略過一部分 | Downloads 被略過、範圍只剩桌面 → 「不在設定的清理資料夾內」 | 照樣「不見了」（執行層先檢查上層資料夾在不在） | Downloads 拔掉、桌面還在（pet 的實際設定）／插回來 | moved、不見了／restored |
 * | R2-12a（HTTP）dismiss 撞到活著的計畫 | 500、或記成錯讓寵物擔心 | 409 CONFLICT、不記 | release A、B 用 a.zip、dismiss A／B 套用 | 409、lastError null、a b 還在清單／applied |
 *
 * 預設的決定（寫清楚，不猜）：
 * - 沒帶 kind 的 recordOk 是「通用成功」：只清沒有種類的錯（舊資料、GET 路由的意外），不清任何有種類的錯。
 * - restoreRoots 沒給、而且 server 沒有讀設定（roots／maxBytes／readonly 全給了）→ 只用 roots，不為了它去讀設定檔。
 * - 截圖資料夾本身也寫在清理範圍裡的話，照樣只收截圖類（倒向範圍小）；只有**更深**的根目錄照一般規則。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, existsSync, realpathSync, chmodSync, renameSync,
  symlinkSync, linkSync, readdirSync, readFileSync, truncateSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { open } from '../core/db.ts'
import { scanDownloads } from '../core/cleanup-scanner.ts'
import { createPlan } from '../core/cleanup-plans.ts'
import { applyPlan, undoPlan } from '../core/cleanup-exec.ts'
import { CLEANUP_RULE_VERSION } from '../core/cleanup-rules.ts'
// 命名空間匯入：新函式還沒寫出來的時候，只有用到它的那幾條紅
import * as routes from '../core/cleanup-routes.ts'
import * as server from '../core/server.ts'
import * as config from '../core/config.ts'
import { createReal } from '../core/assets/cleanup-real-state.js'
import { fixture } from './helpers/cleanup.mjs'

const DAY = 86400_000
const TOKEN = 'r2-routes-token'
const noPerm = process.platform === 'win32' || process.getuid?.() === 0

// ── 小工具 ───────────────────────────────────────────────────

function put(dir, name, { days = 60, content = null } = {}) {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, content ?? `獨一無二的內容：${name}`)
  const at = new Date(Date.now() - days * DAY)
  utimesSync(p, at, at)
  return p
}

/** 直接打 route（不經過 HTTP）。 */
function call(f, method, path, body = {}, extra = {}) {
  let got = null
  const handled = routes.cleanupRoutes({
    db: f.db, roots: f.opts.roots, quarantine: f.opts.quarantine,
    maxBytes: f.opts.maxBytes, readonly: false,
    url: new URL('http://x' + path), method, body,
    send: (code, payload, headers) => { got = { code, body: payload, headers: headers ?? {} } },
    scan: onProblem => scanDownloads({ db: f.db, ...f.opts, onProblem }),
    ...extra,
  })
  return { handled, ...got }
}

const health = (f, full = true, extra = {}) => {
  routes.invalidateQuarantineCache()
  return routes.healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine, full, ...extra })
}
const petOf = f => call(f, 'GET', '/pet/state').body.state
const nameOf = (db, id) => db.prepare('SELECT name FROM file_items WHERE id=?').get(id).name
const outcomesByName = (db, planId) =>
  Object.fromEntries([...routes.planOutcomes(db, planId)].map(([id, o]) => [nameOf(db, id), o]))

/** 一個沙盒：Downloads、Desktop、資料庫、隔離區都在暫存資料夾。 */
function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-r2r-')))
  const downloads = join(dir, 'Downloads'), desktop = join(dir, 'Desktop')
  mkdirSync(downloads); mkdirSync(desktop)
  const dbPath = join(dir, 'data.db')
  const db = open(dbPath)
  const opts = { roots: [downloads], quarantine: join(dir, 'q'), maxBytes: 1 << 20 }
  t.after(() => {
    db.close()
    for (const d of readdirSync(dir)) { try { chmodSync(join(dir, d), 0o700) } catch { /* 沒有就算了 */ } }
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, downloads, desktop, dbPath, db, opts }
}

/** 起一個真的 server（port 0、全部路徑在暫存資料夾）。 */
async function serve(t, s, extra = {}) {
  const S = server.start({ port: 0, db: s.dbPath, token: TOKEN, roots: s.opts.roots, quarantine: s.opts.quarantine,
    maxBytes: s.opts.maxBytes, readonly: false, ...extra })
  const port = await S.ready
  t.after(() => globalThis.__cbStopPage?.(); S.server.closeAllConnections(); S.server.close(); S.server.unref())
  const raw = async (method, path, { body, token = TOKEN } = {}) => {
    const headers = { ...(token ? { 'x-contextbox-token': token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body })
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not answer with JSON */ }
    return { status: r.status, json, text }
  }
  const api = (method, path, body) => raw(method, path, { body: body === undefined ? undefined : JSON.stringify(body) })
  return { port, raw, api, S }
}

/** JSON 的欄位集合（陣列元素合併成 []），跟 repo.test 的 RC20 同一個算法 */
function fieldSet(v, at = '', out = new Set()) {
  if (Array.isArray(v)) { for (const x of v) fieldSet(x, at + '[]', out); return out }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { const p = at ? `${at}.${k}` : k; out.add(p); fieldSet(x, p, out) }
  }
  return out
}

/** 套用到第 stopAt 項（從 0 起算）就中斷：前面的搬了、計畫還是 proposed。模擬 kill -9、Ctrl+C。 */
function interruptAt(f, planId, stopAt) {
  assert.throws(() => applyPlan(f.db, planId, { ...f.opts, onProgress: i => { if (i === stopAt) throw new Error('中斷') } }))
}

// ═══ R2-1d ・ 孤兒 ═══════════════════════════════════════════

describe('R2-1d 孤兒：只有「非 done 列的 to_path 上、0 byte 的檔」不算', () => {
  /** a、b 全部搬完，再把 b 那一列改成 status，檔案照 content 擺 */
  function rowAs(t, status, content) {
    const f = fixture(t)
    const p = f.plan()
    applyPlan(f.db, p.id, f.opts)
    const b = f.db.prepare(
      `SELECT j.seq, j.to_path, j.from_path FROM cleanup_journal j JOIN file_items i ON i.id=j.item_id
        WHERE j.plan_id=? AND j.op='quarantine' AND i.name='b.zip'`).get(p.id)
    if (content === 'reserve') { renameSync(b.to_path, b.from_path); writeFileSync(b.to_path, '') }
    f.db.prepare('UPDATE cleanup_journal SET status=? WHERE seq=?').run(status, b.seq)
    return f
  }

  test('failed 列的 0 byte 預留檔 → 不算孤兒', t => {
    assert.equal(health(rowAs(t, 'failed', 'reserve')).quarantine.orphans, 0)
  })
  test('failed 列的 to_path 上有內容（rename 完才驗證失敗）→ 算孤兒', t => {
    assert.equal(health(rowAs(t, 'failed', 'moved')).quarantine.orphans, 1)
  })
  test('started 列的 0 byte 預留檔 → 不算；started 列有內容（rename 完、沒寫 done）→ 算（那是唯一的線索）', t => {
    assert.equal(health(rowAs(t, 'started', 'reserve')).quarantine.orphans, 0)
    assert.equal(health(rowAs(t, 'started', 'moved')).quarantine.orphans, 1)
  })
  test('reverted 列的 0 byte 預留檔 → 不算', t => {
    assert.equal(health(rowAs(t, 'reverted', 'reserve')).quarantine.orphans, 0)
  })

  test('真的 rename 失敗（資料夾不可寫）：每失敗一份計畫都不會多一個孤兒', { skip: noPerm && '要 chmod 擋得住' }, t => {
    const s = sandbox(t)
    const sub = join(s.downloads, 'sub')
    put(sub, 'b.zip', { days: 120 })
    put(s.downloads, 'a.zip', { days: 120 })
    const scope = { roots: s.opts.roots }
    for (let round = 0; round < 3; round++) {
      scanDownloads({ db: s.db, ...s.opts })
      const sel = routes.defaultSelection(s.db, scope)
      if (!sel.candidateIds.length) break
      const plan = routes.createPlanForRoots(s.db, scope, { candidateIds: sel.candidateIds })
      chmodSync(sub, 0o555)
      try { applyPlan(s.db, plan.id, s.opts) } finally { chmodSync(sub, 0o755) }
      const failed = s.db.prepare(`SELECT count(*) n FROM cleanup_journal WHERE status='failed'`).get().n
      assert.equal(failed, round + 1, '前提：b.zip 每一輪都失敗、留下 failed 列')
      routes.invalidateQuarantineCache()
      const h = routes.healthSnapshot(s.db, { roots: s.opts.roots, quarantine: s.opts.quarantine })
      assert.equal(h.quarantine.orphans, 0, `第 ${round + 1} 輪：失敗留下的預留空檔被算成孤兒`)
    }
  })
})

// ═══ R2-1e ・ 沒處理到的項目 ═══════════════════════════════════

describe('R2-1e 跑過的計畫裡，沒有 journal、也沒存原因的項目是 cancelled', () => {
  function interruptedThenUndone(t) {
    const f = fixture(t, { 'a.zip': 'aaaa', 'b.zip': 'bbbbbb', 'c.zip': 'cccccccc' })
    const p = f.plan()
    interruptAt(f, p.id, 1)
    const moved = f.db.prepare(`SELECT item_id FROM cleanup_journal WHERE plan_id=? AND op='quarantine'`).all(p.id)
    assert.equal(moved.length, 1, '前提：只有第一項開始過')
    const r = undoPlan(f.db, p.id, f.opts)
    assert.equal(r.status, 'restored', '前提：復原之後計畫是 restored（跑過的）')
    const untouched = f.db.prepare(
      `SELECT DISTINCT c.item_id FROM cleanup_plan_items pi JOIN cleanup_candidates c ON c.id=pi.candidate_id
        WHERE pi.plan_id=? AND c.item_id <> ?`).all(p.id, moved[0].item_id).map(r => r.item_id)
    return { ...f, planId: p.id, movedId: moved[0].item_id, untouched }
  }

  test('沒有 journal、沒存原因 → cancelled（why 是 null），不是 failed「原因不明」', t => {
    const s = interruptedThenUndone(t)
    const o = routes.planOutcomes(s.db, s.planId)
    assert.equal(o.get(s.movedId).outcome, 'restored')
    for (const id of s.untouched) {
      assert.deepEqual({ outcome: o.get(id).outcome, why: o.get(id).why }, { outcome: 'cancelled', why: null }, nameOf(s.db, id))
    }
    // route 回的也一樣
    const g = call(s, 'GET', `/cleanup/plans/${s.planId}`).body
    assert.deepEqual(g.items.filter(i => s.untouched.includes(i.itemId)).map(i => i.outcome), ['cancelled', 'cancelled'])
  })

  test('對照：有 cleanup_item_errors → failed＋存的原因；只有全域的 file_items.error → 還是 cancelled（R3-8）', t => {
    const s = interruptedThenUndone(t)
    const [x, y] = s.untouched
    s.db.prepare('INSERT INTO cleanup_item_errors (plan_id,item_id,why,at) VALUES (?,?,?,?)')
      .run(s.planId, x, '這個檔案十分鐘內還在變動，先不搬。等一下再試一次。', new Date().toISOString())
    s.db.prepare('UPDATE file_items SET error=? WHERE id=?').run(`EACCES: permission denied, open '${join(s.downloads, 'y')}'`, y)
    const o = routes.planOutcomes(s.db, s.planId)
    assert.deepEqual({ ...o.get(x) }, { outcome: 'failed', why: '這個檔案十分鐘內還在變動，先不搬。等一下再試一次。' })
    // 稽核第三輪 R3-8 改了這一半的答案：file_items.error 是**全域**的（每個檔一份），
    // 寫它的人不只這份計畫 —— 下一次掃描讀不到那個檔、另一份計畫失敗都會寫。
    // 這份計畫從來沒碰過 y（沒有 journal、也沒有 cleanup_item_errors），就是「沒處理到」。
    assert.deepEqual({ ...o.get(y) }, { outcome: 'cancelled', why: null })
  })

  test('recordItemErrors 不可以把「只有存下來的原因」那一項當成 cancelled 刪掉', t => {
    const s = interruptedThenUndone(t)
    const [x] = s.untouched
    s.db.prepare('INSERT INTO cleanup_item_errors (plan_id,item_id,why,at) VALUES (?,?,?,?)')
      .run(s.planId, x, '這個檔案十分鐘內還在變動，先不搬。等一下再試一次。', new Date().toISOString())
    routes.recordItemErrors(s.db, s.planId)
    const kept = s.db.prepare('SELECT why FROM cleanup_item_errors WHERE plan_id=? AND item_id=?').get(s.planId, x)
    assert.ok(kept, '存下來的原因被刪掉了')
    assert.equal(routes.planOutcomes(s.db, s.planId).get(x).outcome, 'failed')
  })

  test('對照：還沒跑的計畫照舊是 pending；放棄的計畫照舊是 cancelled', t => {
    const f = fixture(t)
    const p = f.plan()
    assert.deepEqual([...routes.planOutcomes(f.db, p.id).values()].map(o => o.outcome), ['pending', 'pending'])
  })
})

// ═══ R2-4 ・ 面板復原的範圍 ═══════════════════════════════════

describe('R2-4 面板（HTTP）的復原用 清理範圍 ∪ 監看資料夾；套用與清空維持只用清理範圍', () => {
  /** 舊版：清理範圍含桌面，把桌面與 Downloads 的舊壓縮檔都搬進隔離區 */
  function oldVersionMovedDesktop(t) {
    const s = sandbox(t)
    const dz = put(s.desktop, '客戶提案-最終版.zip', { days: 120 })
    const az = put(s.downloads, '舊的.zip', { days: 120 })
    const both = { ...s.opts, roots: [s.downloads, s.desktop] }
    scanDownloads({ db: s.db, ...both })
    const plan = createPlan(s.db)
    assert.equal(applyPlan(s.db, plan.id, both).status, 'applied', '前提：舊版把桌面的檔也搬走了')
    assert.ok(!existsSync(dz) && !existsSync(az))
    return { ...s, dz, az, planId: plan.id }
  }

  test('給了 restoreRoots（Downloads＋桌面）：面板復原放得回桌面', async t => {
    const s = oldVersionMovedDesktop(t)
    const srv = await serve(t, s, { restoreRoots: [s.downloads, s.desktop] })
    const r = await srv.api('POST', `/cleanup/plans/${s.planId}/undo`, {})
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.status, 'restored', JSON.stringify(r.json.items?.map(i => [i.name, i.outcome, i.why])))
    assert.ok(existsSync(s.dz), '桌面的檔要放回桌面')
    assert.ok(existsSync(s.az))
  })

  test('restoreRoots 裡有不存在的、含捷徑的資料夾：略過它們，其他的照樣放得回', async t => {
    const s = oldVersionMovedDesktop(t)
    const link = join(s.dir, 'link-to-desktop')
    symlinkSync(s.desktop, link)
    const srv = await serve(t, s, { restoreRoots: [join(s.dir, '外接碟拔掉了'), link, s.downloads, s.desktop] })
    const r = await srv.api('POST', `/cleanup/plans/${s.planId}/undo`, {})
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.status, 'restored')
    assert.ok(existsSync(s.dz))
  })

  test('放回範圍每一個都過不了檢查（外接碟拔掉）→ 退回清理範圍交給執行層：200、逐項「不見了」，不是 500 BAD_CONFIG「請設定清理資料夾」', t => {
    const f = fixture(t, { 'a.zip': 'aaaa' })
    const p = f.plan()
    assert.equal(applyPlan(f.db, p.id, f.opts).status, 'applied')
    const unplugged = f.downloads + '-拔掉了'
    renameSync(f.downloads, unplugged)
    const r = call(f, 'POST', `/cleanup/plans/${p.id}/undo`, {}, { restoreRoots: [f.downloads] })
    assert.equal(r.code, 200, JSON.stringify(r.body))
    assert.equal(r.body.status, 'error')
    assert.doesNotMatch(JSON.stringify(r.body), /Set the cleanup folders/, '叫使用者去改設定，其實只是資料夾暫時不在')
    const a = r.body.items.find(i => i.name === 'a.zip')
    assert.equal(a.outcome, 'moved', '檔還在隔離區')
    assert.match(a.why ?? '', /gone/)
    const h = health(f)
    assert.equal(h.lastErrorKind, 'undo')
    assert.doesNotMatch(h.lastError, /Set the cleanup folders/)

    // 插回來之後照樣放得回
    renameSync(unplugged, f.downloads)
    const again = call(f, 'POST', `/cleanup/plans/${p.id}/undo`, {}, { restoreRoots: [f.downloads] })
    assert.equal(again.body.status, 'restored', JSON.stringify(again.body))
    assert.equal(readFileSync(join(f.downloads, 'a.zip'), 'utf8'), 'aaaa')
  })

  /**
   * pet 的放回範圍＝清理範圍 ∪ 監看資料夾，桌面幾乎一定在：「全部被略過」在實際設定裡很少發生，
   * 常見的是**只有 Downloads 不在**。那時 Downloads 被略過、範圍只剩桌面，Downloads 的檔
   * 也要是「不見了」，不可以變成「檔案不在設定的清理資料夾內」（一樣會叫人去改設定）。
   */
  test('對照：只有一部分被略過（Downloads 拔掉、桌面還在）→ Downloads 的檔照樣逐項「不見了」，不是「不在設定的清理資料夾內」', t => {
    const f = fixture(t, { 'a.zip': 'aaaa' })
    const desktop = join(f.dir, 'Desktop')
    mkdirSync(desktop)
    const p = f.plan()
    assert.equal(applyPlan(f.db, p.id, f.opts).status, 'applied')
    const unplugged = f.downloads + '-拔掉了'
    renameSync(f.downloads, unplugged)
    const r = call(f, 'POST', `/cleanup/plans/${p.id}/undo`, {}, { restoreRoots: [f.downloads, desktop] })
    assert.equal(r.code, 200, JSON.stringify(r.body))
    const a = r.body.items.find(i => i.name === 'a.zip')
    assert.deepEqual({ outcome: a.outcome, gone: /gone/.test(a.why ?? '') }, { outcome: 'moved', gone: true }, a.why)
    assert.doesNotMatch(JSON.stringify(r.body), /not inside a configured cleanup folder|Set the cleanup folders/)
    renameSync(unplugged, f.downloads)
    assert.equal(call(f, 'POST', `/cleanup/plans/${p.id}/undo`, {}, { restoreRoots: [f.downloads, desktop] }).body.status, 'restored')
  })

  test('對照：清理範圍本身就是空的（真的沒設定）→ 照舊 500 BAD_CONFIG', t => {
    const f = fixture(t, { 'a.zip': 'aaaa' })
    const p = f.plan()
    applyPlan(f.db, p.id, f.opts)
    const r = call(f, 'POST', `/cleanup/plans/${p.id}/undo`, {}, { roots: [], restoreRoots: [join(f.dir, '不存在')] })
    assert.equal(r.code, 500, JSON.stringify(r.body))
    assert.equal(r.body.code, 'BAD_CONFIG')
  })

  test('對照：面板套用一份含桌面檔的計畫 → 桌面的檔不動（套用只用清理範圍）', async t => {
    const s = sandbox(t)
    const dz = put(s.desktop, '客戶提案-最終版.zip', { days: 120 })
    const az = put(s.downloads, '舊的.zip', { days: 120 })
    scanDownloads({ db: s.db, ...s.opts, roots: [s.downloads, s.desktop] })
    const plan = createPlan(s.db)          // B 的預設不看清理範圍：兩個都收進來
    assert.equal(plan.items.length, 2, '前提：計畫裡有桌面的檔')
    const srv = await serve(t, s, { restoreRoots: [s.downloads, s.desktop] })
    const r = await srv.api('POST', `/cleanup/plans/${plan.id}/apply`, {})
    assert.equal(r.status, 200, r.text)
    assert.ok(existsSync(dz), '桌面的檔被搬走了 —— 套用不可以用放回的範圍')
    assert.ok(!existsSync(az), '前提：Downloads 的檔有被清')
    const desk = r.json.items.find(i => i.name === '客戶提案-最終版.zip')
    assert.equal(desk.outcome, 'failed')
  })

  test('對照：沒給 restoreRoots、也沒讀設定（roots 等全給了）→ 只用 roots，不為了它去讀設定檔', async t => {
    const s = oldVersionMovedDesktop(t)
    const srv = await serve(t, s)
    const r = await srv.api('POST', `/cleanup/plans/${s.planId}/undo`, {})
    assert.equal(r.status, 200, r.text)
    assert.ok(!existsSync(s.dz), '只有 roots 的時候放不回桌面（範圍外）')
    assert.ok(!existsSync(join(FAKE_HOME, '.contextbox')), '為了放回範圍去讀（建立）了設定檔')
  })

  test('沒給 restoreRoots、server 自己讀設定：放回範圍＝cleanup.roots ∪ watch（跟 pet 開機一樣）', async t => {
    const desktop = join(FAKE_HOME, 'Desktop'), downloads = join(FAKE_HOME, 'Downloads')
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-r2r-cfg-')))
    t.after(() => {
      for (const d of [dir, desktop, downloads, join(FAKE_HOME, '.contextbox')]) rmSync(d, { recursive: true, force: true })
    })
    const dz = put(desktop, '客戶提案-最終版.zip', { days: 120 })
    const dbPath = join(dir, 'data.db'), q = join(dir, 'q')
    const db = open(dbPath)
    try {
      const both = { roots: [downloads, desktop], quarantine: q, maxBytes: 1 << 20 }
      scanDownloads({ db, ...both })
      const plan = createPlan(db)
      applyPlan(db, plan.id, both)
      assert.ok(!existsSync(dz), '前提：舊版把桌面的檔搬走了')
      mkdirSync(join(FAKE_HOME, '.contextbox'), { recursive: true })
      writeFileSync(join(FAKE_HOME, '.contextbox', 'config.json'), JSON.stringify({
        watch: [desktop, downloads], cleanup: { roots: [downloads] }, maxBytes: 1 << 20, readonly: false,
      }))
      // 刻意不給 roots／maxBytes／readonly（跟 `node core/server.ts` 一樣）；用變數傳，繞過 repo.test 的 start({ 檢查
      const opts = { port: 0, db: dbPath, token: TOKEN, quarantine: q }
      const S = server.start(opts)
      const port = await S.ready
      t.after(() => globalThis.__cbStopPage?.(); S.server.closeAllConnections(); S.server.close(); S.server.unref())
      const r = await fetch(`http://127.0.0.1:${port}/cleanup/plans/${plan.id}/undo`, {
        method: 'POST', headers: { 'x-contextbox-token': TOKEN, 'content-type': 'application/json' }, body: '{}' })
      const body = await r.json()
      assert.equal(r.status, 200, JSON.stringify(body))
      assert.ok(existsSync(dz), `面板放不回桌面：${JSON.stringify(body.items?.map(i => [i.name, i.outcome, i.why]))}`)
    } finally { db.close() }
  })
})

// ═══ R2-5b ・ blockingPlan.started ═══════════════════════════

describe('R2-5b blockingPlan 帶 started：這份計畫有沒有任何搬移紀錄', () => {
  test('建了、還沒套用 → started false', t => {
    const f = fixture(t)
    const list = routes.listCandidates(f.db, { roots: f.opts.roots })
    const ids = list.candidates.find(c => c.name === 'a.zip').candidateIds
    createPlan(f.db, { candidateIds: ids })
    const r = call(f, 'POST', '/cleanup/plans', { candidateIds: ids })
    assert.equal(r.code, 409)
    assert.equal(r.body.blockingPlan.started, false)
    assert.equal(routes.blockingPlanFor(f.db, ids).started, false)
  })

  test('套用到一半中斷 → started true；這時 release 回 409、apply 接得完', t => {
    const f = fixture(t)
    const p = f.plan()
    interruptAt(f, p.id, 1)
    const list = routes.listCandidates(f.db, { roots: f.opts.roots })
    const left = list.candidates.map(c => c.candidateIds).flat()
    assert.ok(left.length, '前提：沒搬到的那個還在清單上')
    const r = call(f, 'POST', '/cleanup/plans', { candidateIds: left })
    assert.equal(r.code, 409)
    assert.equal(r.body.blockingPlan.id, p.id)
    assert.equal(r.body.blockingPlan.started, true)
    assert.equal(call(f, 'POST', `/cleanup/plans/${p.id}/release`, {}).code, 409, 'started 的計畫不能放棄')
    assert.equal(call(f, 'POST', `/cleanup/plans/${p.id}/apply`, {}).body.status, 'applied', '繼續那份接得完')
  })

  test('第一項在 rename 之前被砍（journal 只有一列 started、沒有任何 done）→ started 還是 true（突變 V22）', t => {
    const f = fixture(t)
    const p = f.plan()
    const child = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'r2-crash-child.mjs')
    const r0 = spawnSync(process.execPath, [child, f.dbPath, JSON.stringify(f.opts), 'apply', p.id, 'before-rename'], {
      encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: f.dir, USERPROFILE: f.dir },
    })
    assert.equal(r0.signal, 'SIGKILL', `前提：子行程要在 rename 之前被砍掉：${r0.stdout}${r0.stderr}`)
    assert.deepEqual(f.db.prepare('SELECT status FROM cleanup_journal WHERE plan_id=?').all(p.id).map(r => r.status), ['started'])
    const ids = routes.listCandidates(f.db, { roots: f.opts.roots }).candidates.flatMap(c => c.candidateIds)
    assert.ok(ids.length, '前提：兩個檔都還在清單上')
    const r = call(f, 'POST', '/cleanup/plans', { candidateIds: ids })
    assert.equal(r.code, 409)
    assert.equal(r.body.blockingPlan.id, p.id)
    assert.equal(r.body.blockingPlan.started, true, '只有 started 列也是開始了：面板不可以給「放棄上次那份」')
    assert.equal(call(f, 'POST', `/cleanup/plans/${p.id}/release`, {}).code, 409)
  })
})

// ═══ R2-12a（HTTP）・ 拒絕一份放棄過的計畫，撞到還活著的計畫 ═══════════

describe('R2-12a（HTTP）dismiss 一份 release 過的計畫、它的檔在另一份還沒套用的計畫裡', () => {
  test('409 CONFLICT、不記成錯、寵物不擔心；那份照常套用（驗證員 T9 的 HTTP 版）', t => {
    const f = fixture(t)
    const A = call(f, 'POST', '/cleanup/plans', {}).body
    assert.equal(A.items.length, 2, '前提：A 有 a、b')
    assert.equal(call(f, 'POST', `/cleanup/plans/${A.id}/release`, {}).code, 200)
    const ids = routes.listCandidates(f.db, { roots: f.opts.roots }).candidates.find(c => c.name === 'a.zip').candidateIds
    const B = call(f, 'POST', '/cleanup/plans', { candidateIds: ids }).body
    const r = call(f, 'POST', `/cleanup/plans/${A.id}/dismiss`, {})
    assert.deepEqual({ code: r.code, err: r.body.code }, { code: 409, err: 'CONFLICT' }, JSON.stringify(r.body))
    assert.match(r.body.error, /another plan that was never applied/)
    assert.equal(health(f).lastError, null, '狀態衝突不是意外，不記')
    assert.notEqual(petOf(f), 'worried')
    assert.deepEqual(routes.listCandidates(f.db, { roots: f.opts.roots }).candidates.map(c => c.name).sort(), ['a.zip', 'b.zip'],
      '什麼都沒拒絕成：a、b 都還在清單上')
    assert.equal(call(f, 'POST', `/cleanup/plans/${B.id}/apply`, {}).body.status, 'applied')
  })
})

// ═══ R2-7 ・ 不認得的 body key ═══════════════════════════════

describe('R2-7 不認得的 body key 回 400 BAD_BODY，而且什麼都沒做', () => {
  async function world(t) {
    const s = sandbox(t)
    for (const n of ['a.zip', 'b.zip', 'c.zip']) put(s.downloads, n, { days: 60 })
    const srv = await serve(t, s)
    assert.equal((await srv.api('POST', '/cleanup/scan', {})).status, 200)
    const list = (await srv.api('GET', '/cleanup/candidates')).json
    const ids = n => list.candidates.find(c => c.name === n).candidateIds
    const planCount = () => s.db.prepare('SELECT count(*) n FROM cleanup_plans').get().n
    return { ...s, ...srv, ids, planCount }
  }

  test('POST /cleanup/plans {candidateID} → 400，0 份計畫；{candidateIds, requestId} → 200 只有 a', async t => {
    const w = await world(t)
    const bad = await w.api('POST', '/cleanup/plans', { candidateID: w.ids('a.zip'), requestId: 'r-1' })
    assert.equal(bad.status, 400, bad.text)
    assert.equal(bad.json.code, 'BAD_BODY')
    assert.equal(w.planCount(), 0, '拼錯的 key 被當成「什麼都沒帶」→ 預設全勾')
    const snake = await w.api('POST', '/cleanup/plans', { candidate_ids: w.ids('a.zip') })
    assert.equal(snake.status, 400)
    const ok = await w.api('POST', '/cleanup/plans', { candidateIds: w.ids('a.zip'), requestId: 'r-2' })
    assert.equal(ok.status, 200, ok.text)
    assert.deepEqual(ok.json.items.map(i => i.name), ['a.zip'])
  })

  test('apply {skippedIDs} → 400，一個都沒搬；{skippedIds} → 200，略過的留著', async t => {
    const w = await world(t)
    const plan = (await w.api('POST', '/cleanup/plans', { candidateIds: [...w.ids('a.zip'), ...w.ids('b.zip')] })).json
    const bad = await w.api('POST', `/cleanup/plans/${plan.id}/apply`, { skippedIDs: w.ids('b.zip') })
    assert.equal(bad.status, 400, bad.text)
    assert.equal(bad.json.code, 'BAD_BODY')
    assert.deepEqual(readdirSync(w.downloads).sort(), ['a.zip', 'b.zip', 'c.zip'], '400 之前就搬了檔')
    const ok = await w.api('POST', `/cleanup/plans/${plan.id}/apply`, { skippedIds: w.ids('b.zip') })
    assert.equal(ok.status, 200, ok.text)
    assert.ok(existsSync(join(w.downloads, 'b.zip')), '略過的要留著')
    assert.ok(!existsSync(join(w.downloads, 'a.zip')))
  })

  test('undo、dismiss、release 不認任何 key（空物件可以）', async t => {
    const w = await world(t)
    const p1 = (await w.api('POST', '/cleanup/plans', { candidateIds: w.ids('a.zip') })).json
    assert.equal((await w.api('POST', `/cleanup/plans/${p1.id}/apply`, {})).status, 200)
    const badUndo = await w.api('POST', `/cleanup/plans/${p1.id}/undo`, { force: true })
    assert.equal(badUndo.status, 400, badUndo.text)
    assert.ok(!existsSync(join(w.downloads, 'a.zip')), '400 之前就放回了')
    assert.equal((await w.api('POST', `/cleanup/plans/${p1.id}/undo`, {})).status, 200)

    const p2 = (await w.api('POST', '/cleanup/plans', { candidateIds: w.ids('b.zip') })).json
    for (const [action, body] of [['dismiss', { reason: 'x' }], ['release', { keep: true }]]) {
      const r = await w.api('POST', `/cleanup/plans/${p2.id}/${action}`, body)
      assert.equal(r.status, 400, `${action} ${r.text}`)
      assert.equal(r.json.code, 'BAD_BODY')
    }
    const still = s => s.db.prepare('SELECT status FROM cleanup_plans WHERE id=?').get(p2.id).status
    assert.equal(still(w), 'proposed', '400 之前就作廢了')
    assert.equal((await w.api('POST', `/cleanup/plans/${p2.id}/release`, {})).status, 200)
    assert.equal((await w.raw('POST', `/cleanup/plans/${p2.id}/dismiss`)).status, 200, '沒帶 body 也可以')
  })

  test('清空隔離區只認 token、confirmed', async t => {
    const w = await world(t)
    const bad = await w.api('POST', '/cleanup/quarantine/empty', { tokne: 'x', confirmed: true })
    assert.equal(bad.status, 400, bad.text)
    assert.equal(bad.json.code, 'BAD_BODY')
    const preview = await w.api('POST', '/cleanup/quarantine/empty', {})
    assert.equal(preview.status, 200)
    assert.equal((await w.api('POST', '/cleanup/quarantine/empty', { token: preview.json.token, confirmed: false })).status, 428)
    assert.equal((await w.api('POST', '/cleanup/quarantine/empty', { token: preview.json.token, confirmed: true })).status, 200)
  })

  test('第一方的面板（createReal）送的 key 照樣通過：清理、復原、放棄上次那份', async t => {
    const w = await world(t)
    const api = async (path, init = {}) => {
      const r = await fetch(`http://127.0.0.1:${w.port}${path}`, {
        ...init, headers: { 'content-type': 'application/json', 'x-contextbox-token': TOKEN } })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) { const e = new Error(data.error); e.code = data.code; e.status = r.status; e.data = data; throw e }
      return data
    }
    const real = createReal(api)
    await real.load()
    const c = real.candidates.find(x => x.name === 'c.zip')
    real.select(c.itemId, false)                     // c 留著，最後拿來試「放棄上次那份」
    const applied = await real.apply()
    assert.equal(applied.status, 'applied', JSON.stringify(applied))
    assert.equal(w.planCount(), 1)
    const undone = await real.undo()
    assert.equal(undone.status, 'restored', JSON.stringify(undone))
    // 放棄上次那份：另一份還沒套用的計畫佔著 c.zip
    assert.equal((await w.api('POST', '/cleanup/plans', { candidateIds: c.candidateIds })).status, 200)
    await real.load()
    real.select(c.itemId, true)
    const blocked = await real.apply()
    assert.equal(blocked.status, 'pending-plan', JSON.stringify(blocked))
    const released = await real.release()
    assert.equal(released.status, 'released', JSON.stringify(released))
  })
})

// ═══ R2-8 ・ 截圖資料夾只清截圖 ════════════════════════════════

describe('R2-8 截圖資料夾（cleanup.screenshotsDir）底下只收截圖類的候選', () => {
  test('設定：開啟時 screenshotsDir 是那個資料夾的真路徑，關閉或看不懂時 null', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'cb-r2r-mac-')))
    try {
      mkdirSync(join(home, 'Desktop'))
      const sys = { os: 'darwin', home }
      assert.equal(config.normalize({}, sys).config.cleanup.screenshotsDir, null)
      const on = config.normalize({ cleanup: { screenshots: true } }, sys).config.cleanup
      assert.equal(on.screenshotsDir, join(home, 'Desktop'), 'macOS 的截圖資料夾就是桌面')
      assert.ok(on.roots.includes(on.screenshotsDir))
      assert.equal(config.normalize({ cleanup: { screenshots: 'yes' } }, sys).config.cleanup.screenshotsDir, null)
      assert.equal(config.defaults(sys).cleanup.screenshotsDir, null)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  test('第一次跑寫出來的設定檔不帶 screenshotsDir（那是算出來的，不是讓人寫的）', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'cb-r2r-cfgfile-')))
    try {
      const r = config.load(join(d, 'config.json'))
      assert.equal(r.created, true)
      const file = JSON.parse(readFileSync(join(d, 'config.json'), 'utf8'))
      assert.ok(!('screenshotsDir' in file.cleanup), JSON.stringify(file.cleanup))
      assert.equal(r.config.cleanup.screenshotsDir, null)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  /** 舊的清理範圍：Downloads＋桌面，桌面是截圖資料夾 */
  function desk(t) {
    const s = sandbox(t)
    put(s.desktop, 'proposal.zip', { days: 120 })
    put(s.desktop, 'Screenshot 2026-01-02 141203.png', { days: 120 })
    put(s.downloads, 'a.zip', { days: 120 })
    const roots = [s.downloads, s.desktop]
    scanDownloads({ db: s.db, ...s.opts, roots })
    return { ...s, roots, scope: { roots, screenshotsDir: s.desktop } }
  }
  const names = l => l.candidates.map(c => c.name).sort()

  test('桌面 120 天前的 proposal.zip → 不列；桌面上 Screenshot 開頭的舊截圖 → 列（只帶截圖那一條理由）', t => {
    const s = desk(t)
    const l = routes.listCandidates(s.db, { roots: s.roots, screenshotsDir: s.desktop })
    assert.deepEqual(names(l), ['Screenshot 2026-01-02 141203.png', 'a.zip'])
    const shot = l.candidates.find(c => c.name.startsWith('Screenshot'))
    assert.deepEqual(shot.reasons.map(r => r.kind), ['screenshot-noise'], '截圖資料夾底下的其他規則（old-download）不收')
    assert.equal(shot.candidateIds.length, 1)
    // 對照：沒有 screenshotsDir（例如使用者自己把桌面寫進 cleanup.roots）照一般規則
    assert.deepEqual(names(routes.listCandidates(s.db, { roots: s.roots })), ['Screenshot 2026-01-02 141203.png', 'a.zip', 'proposal.zip'])
  })

  test('徽章、預設清理、建計畫都用同一套篩選', t => {
    const s = desk(t)
    assert.equal(health(s, false, { roots: s.roots, screenshotsDir: s.desktop }).pendingCandidates, 2)
    assert.equal(health(s, false, { roots: s.roots }).pendingCandidates, 3, '對照')
    const sel = routes.defaultSelection(s.db, s.scope)
    const planned = routes.createPlanForRoots(s.db, s.scope, { candidateIds: sel.candidateIds })
    assert.deepEqual(planned.items.map(i => i.name), ['a.zip'], 'proposal.zip（archive 65）不可以被預設勾進去')
    const pz = s.db.prepare(`SELECT c.id FROM cleanup_candidates c JOIN file_items i ON i.id=c.item_id
                              WHERE i.name='proposal.zip' AND c.status='proposed'`).all().map(r => r.id)
    assert.throws(() => routes.createPlanForRoots(s.db, s.scope, { candidateIds: pz }), { code: 'STALE_CANDIDATE' })
    const shotOld = s.db.prepare(`SELECT c.id FROM cleanup_candidates c JOIN file_items i ON i.id=c.item_id
                                   WHERE i.name LIKE 'Screenshot%' AND c.kind='old-download'`).all().map(r => r.id)
    assert.ok(shotOld.length, '前提：截圖也命中了 old-download')
    assert.throws(() => routes.createPlanForRoots(s.db, s.scope, { candidateIds: shotOld }), { code: 'STALE_CANDIDATE' })
  })

  test('比截圖資料夾更深、自己寫在清理範圍裡的資料夾照一般規則（最深的根目錄說了算）', t => {
    const s = desk(t)
    const zone = join(s.desktop, '清理區')
    put(zone, 'old.zip', { days: 120 })
    const roots = [s.downloads, zone, s.desktop]
    scanDownloads({ db: s.db, ...s.opts, roots })
    const l = routes.listCandidates(s.db, { roots, screenshotsDir: s.desktop })
    assert.ok(l.candidates.some(c => c.name === 'old.zip'), '清理區是使用者自己寫的清理範圍')
    assert.ok(!l.candidates.some(c => c.name === 'proposal.zip'), '桌面本身還是只收截圖')
  })

  test('HTTP：server 給了 screenshotsDir，清單、徽章、預設清理都不碰 proposal.zip', async t => {
    const s = desk(t)
    const srv = await serve(t, { ...s, opts: { ...s.opts, roots: s.roots } }, { screenshotsDir: s.desktop })
    const l = (await srv.api('GET', '/cleanup/candidates')).json
    assert.deepEqual(names(l), ['Screenshot 2026-01-02 141203.png', 'a.zip'])
    assert.equal((await srv.raw('GET', '/health', { token: null })).json.pendingCandidates, 2)
    const plan = (await srv.api('POST', '/cleanup/plans', {})).json
    assert.deepEqual(plan.items.map(i => i.name), ['a.zip'])
    await srv.api('POST', `/cleanup/plans/${plan.id}/apply`, {})
    assert.ok(existsSync(join(s.desktop, 'proposal.zip')), '桌面的 proposal.zip 被搬走了')
  })

  test('需要你查看：截圖資料夾底下讀不到的一般檔不列、不算；讀不到的舊截圖照列（突變 V06）', t => {
    const s = desk(t)
    s.db.prepare(`UPDATE file_items SET error=? WHERE name IN ('proposal.zip', 'Screenshot 2026-01-02 141203.png')`)
      .run(`EACCES: permission denied, open '${join(s.desktop, 'x')}'`)
    const withShots = routes.listCandidates(s.db, { roots: s.roots, screenshotsDir: s.desktop })
    assert.deepEqual(withShots.needsHuman.map(n => n.name), ['Screenshot 2026-01-02 141203.png'])
    assert.equal(withShots.needsHumanTotal, 1)
    assert.equal(health(s, false, { roots: s.roots, screenshotsDir: s.desktop }).needsHumanCount, 1, '徽章跟清單同一套')
    // 對照：沒有截圖資料夾（桌面是使用者自己寫的清理範圍）→ 兩個都列
    assert.deepEqual(routes.listCandidates(s.db, { roots: s.roots }).needsHuman.map(n => n.name).sort(),
      ['Screenshot 2026-01-02 141203.png', 'proposal.zip'])
    assert.equal(health(s, false, { roots: s.roots }).needsHumanCount, 2)
  })

  test('/pet/state 的徽章也只收截圖類：給了 screenshotsDir 是 2、沒給是 3（突變 V07）', t => {
    const s = desk(t)
    const pet = extra => call({ ...s, opts: { ...s.opts, roots: s.roots } }, 'GET', '/pet/state', {}, extra).body
    assert.equal(pet({ screenshotsDir: s.desktop }).pendingCount, 2)
    assert.equal(pet({}).pendingCount, 3)
  })

  test('server 自己讀設定（cleanup.screenshots 開著）→ 截圖資料夾用設定算出來的：清單與徽章都不碰那裡的舊 zip（突變 V08）', async t => {
    const downloads = join(FAKE_HOME, 'Downloads')
    const shots = config.osDefaults().screenshots
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-r2r-shots-')))
    t.after(() => {
      for (const d of [dir, downloads, shots, join(FAKE_HOME, '.contextbox')]) rmSync(d, { recursive: true, force: true })
    })
    put(downloads, 'a.zip', { days: 120 })
    put(shots, 'proposal.zip', { days: 120 })
    put(shots, 'Screenshot 2026-01-02 141203.png', { days: 120 })
    mkdirSync(join(FAKE_HOME, '.contextbox'), { recursive: true })
    writeFileSync(join(FAKE_HOME, '.contextbox', 'config.json'), JSON.stringify({
      watch: [shots, downloads], cleanup: { roots: [downloads], screenshots: true }, maxBytes: 1 << 20, readonly: false,
    }))
    // 刻意不給 roots／maxBytes／readonly（跟 `node core/server.ts` 一樣）；用變數傳，繞過 repo.test 的 start({ 檢查
    const opts = { port: 0, db: join(dir, 'data.db'), token: TOKEN, quarantine: join(dir, 'q') }
    const S = server.start(opts)
    const port = await S.ready
    t.after(() => globalThis.__cbStopPage?.(); S.server.closeAllConnections(); S.server.close(); S.server.unref())
    const get = async (path, method = 'GET') => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, {
        method, headers: { 'x-contextbox-token': TOKEN, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined })
      return r.json()
    }
    await get('/cleanup/scan', 'POST')
    const names = (await get('/cleanup/candidates')).candidates.map(c => c.name).sort()
    assert.deepEqual(names, ['Screenshot 2026-01-02 141203.png', 'a.zip'], '截圖資料夾裡的 proposal.zip 被列出來了')
    assert.equal((await get('/health')).pendingCandidates, 2)
  })

  test('性質（結構化隨機）：徽章＝清單總數；截圖資料夾底下列出來的只有截圖類；列出來的都建得了計畫', t => {
    const s = sandbox(t)
    const zone = join(s.desktop, 'zone')
    const kinds = [['archive', 65], ['installer', 70], ['old-download', 35], ['screenshot-noise', 35], ['duplicate', 98]]
    // mulberry32：固定種子、可重現（線性同餘的低位元週期太短，會讓三條路徑都走不到）
    let seed = 20260919
    const rnd = n => {
      seed = (seed + 0x6D2B79F5) | 0
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
      return ((x ^ (x >>> 14)) >>> 0) % n
    }
    const now = new Date().toISOString()
    const where = [s.downloads, s.desktop, zone, join(s.dir, 'elsewhere')]
    const hits = { shotOnlyListed: 0, shotDropped: 0, zoneListed: 0 }
    for (let i = 0; i < 160; i++) {
      const dir = where[rnd(where.length)]
      const id = randomUUID()
      s.db.prepare(`INSERT INTO file_items (id,path,name,ext,bytes,sha256,mtime,first_seen_at,last_seen_at,status,error)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, join(dir, `f${i}.bin`), `f${i}.bin`, '.bin', 10 + i, 'sha' + i, now, now, now, 'candidate', null)
      const picked = new Set(Array.from({ length: 1 + rnd(3) }, () => rnd(kinds.length)))
      for (const k of picked) {
        s.db.prepare(`INSERT INTO cleanup_candidates (id,item_id,kind,rule_version,confidence,reason,evidence,status,created_at)
                      VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(randomUUID(), id, kinds[k][0], CLEANUP_RULE_VERSION, kinds[k][1], '理由', '證據', 'proposed', now)
      }
    }
    const scope = { roots: [s.downloads, zone, s.desktop], screenshotsDir: s.desktop }
    const l = routes.listCandidates(s.db, { ...scope, limit: 1000 })
    const h = routes.healthSnapshot(s.db, { roots: scope.roots, screenshotsDir: s.desktop, quarantine: s.opts.quarantine })
    assert.equal(h.pendingCandidates, l.totalAvailable, '徽章跟清單對不上')
    const pathOf = id => s.db.prepare('SELECT path FROM file_items WHERE id=?').get(id).path
    for (const c of l.candidates) {
      const p = pathOf(c.itemId)
      assert.ok(!p.startsWith(join(s.dir, 'elsewhere')), '範圍外的檔被列出來')
      if (p.startsWith(s.desktop + sep) && !p.startsWith(zone + sep)) {
        assert.deepEqual(c.reasons.map(r => r.kind), ['screenshot-noise'], `${c.name} 在截圖資料夾，卻帶了別的理由`)
        hits.shotOnlyListed++
      }
      if (p.startsWith(zone + sep)) hits.zoneListed++
    }
    hits.shotDropped = s.db.prepare(`SELECT count(DISTINCT i.id) n FROM file_items i JOIN cleanup_candidates c ON c.item_id=i.id
      WHERE i.path LIKE ? AND i.path NOT LIKE ? AND NOT EXISTS (SELECT 1 FROM cleanup_candidates x WHERE x.item_id=i.id AND x.kind='screenshot-noise')`)
      .get(s.desktop + sep + '%', zone + sep + '%').n
    const all = l.candidates.flatMap(c => c.candidateIds)
    const plan = routes.createPlanForRoots(s.db, scope, { candidateIds: all })
    assert.equal(new Set(plan.items.map(i => i.itemId)).size, l.totalAvailable)
    // 生成器驗收：三條有趣的路徑都要真的走到
    assert.ok(hits.shotOnlyListed > 3 && hits.shotDropped > 3 && hits.zoneListed > 3, JSON.stringify(hits))
  })
})

// ═══ R2-9a ・ /health 的 proof ═════════════════════════════════

// 第二階段（CLI 那一組）：proof 綁埠號 —— 訊息是 `${埠}:${nonce}`，擋冒牌把 nonce 轉給另一個埠上的真 pet。
describe('R2-9a /health?nonce=<32 hex> 回 proof＝HMAC-SHA256(token, `${實際監聽的埠}:${nonce}`)', () => {
  test('healthProof 是 HMAC-SHA256，key 是 token、訊息是「埠:nonce」', () => {
    // 對照組用 node:crypto 自己算（獨立的 oracle）；key 與訊息對調、少了埠號都要對不上
    const n = 'a'.repeat(32)
    const want = createHmac('sha256', TOKEN).update(`7391:${n}`).digest('hex')
    assert.equal(server.healthProof(TOKEN, 7391, n), want)
    assert.notEqual(want, createHmac('sha256', `7391:${n}`).update(TOKEN).digest('hex'), '前提：key 與訊息對調會不一樣')
    assert.notEqual(server.healthProof(TOKEN, 7391, n), createHmac('sha256', TOKEN).update(n).digest('hex'), '埠號沒算進去')
    assert.notEqual(server.healthProof(TOKEN, 7391, n), server.healthProof(TOKEN, 7392, n), '不同的埠要算出不同的 proof')
  })

  test('帶對的 nonce：免 token 與帶 token 都回 proof，而且用的是 server 實際監聽的埠', async t => {
    const s = sandbox(t)
    const srv = await serve(t, s)          // port 0：實際的埠是系統挑的
    for (const nonce of ['0123456789abcdef0123456789abcdef', 'ABCDEF0123456789ABCDEF0123456789']) {
      for (const token of [null, TOKEN]) {
        const r = await srv.raw('GET', `/health?nonce=${nonce}`, { token })
        assert.equal(r.status, 200)
        assert.equal(r.json.proof, server.healthProof(TOKEN, srv.port, nonce), `${nonce} token=${Boolean(token)}`)
        assert.notEqual(r.json.proof, server.healthProof(TOKEN, 0, nonce), '要用實際監聽的埠，不是呼叫端給的 0')
        assert.notEqual(r.json.proof, server.healthProof(TOKEN, srv.port + 1, nonce))
      }
    }
  })

  test('不帶 nonce 沒有 proof 欄位；nonce 格式不對也沒有（不報錯）', async t => {
    const s = sandbox(t)
    const srv = await serve(t, s)
    const plain = await srv.raw('GET', '/health', { token: null })
    assert.ok(!('proof' in plain.json))
    for (const nonce of ['a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32), '', '%20'.repeat(32)]) {
      const r = await srv.raw('GET', `/health?nonce=${nonce}`, { token: null })
      assert.equal(r.status, 200)
      assert.ok(!('proof' in r.json), `nonce=${nonce} 不該回 proof`)
      assert.deepEqual([...fieldSet(r.json)].sort(), [...fieldSet(plain.json)].sort(), '形狀要跟不帶 nonce 一樣')
    }
  })
})

// ═══ R2-10 ・ 成功與錯誤分種類 ═════════════════════════════════

describe('R2-10 寵物只在「同一種動作」之後成功過才不擔心', () => {
  test('套用的錯 → 掃描成功 → 還在擔心；→ 套用成功 → 不擔心', t => {
    const f = fixture(t)
    routes.recordCleanupError(f.db, new Error('boom'), 'apply')
    assert.equal(petOf(f), 'worried')
    routes.recordOk(f.db, 'scan')
    assert.equal(petOf(f), 'worried', '背景重掃成功蓋掉了套用的錯')
    const h = health(f)
    assert.equal(h.lastErrorKind, 'apply')
    assert.equal(h.lastOkByKind.apply, null)
    assert.equal(typeof h.lastOkByKind.scan, 'string')
    routes.recordOk(f.db, 'apply')
    assert.notEqual(petOf(f), 'worried')
  })

  test('沒有種類的錯（舊資料、GET 路由的意外）：任何一種成功都清掉', t => {
    const f = fixture(t)
    routes.recordCleanupError(f.db, new Error('boom'))
    assert.equal(health(f).lastErrorKind, null)
    routes.recordOk(f.db, 'scan')
    assert.notEqual(petOf(f), 'worried')
  })

  test('沒帶 kind 的 recordOk（通用成功）照樣寫 lastOkAt，但不清有種類的錯', t => {
    const f = fixture(t)
    routes.recordCleanupError(f.db, new Error('boom'), 'undo')
    routes.recordOk(f.db)
    const h = health(f)
    assert.ok(Date.parse(h.lastOkAt) > Date.parse(h.lastErrorAt), 'lastOkAt 照寫')
    assert.equal(petOf(f), 'worried')
  })

  test('只有舊版寫的 lastError（沒有種類那一列）：當成沒有種類', t => {
    const f = fixture(t)
    routes.recordCleanupError(f.db, new Error('first'), 'apply')
    // 舊版的 CLI 只寫 lastError，不寫種類：種類那一列的時間對不上，就不算
    f.db.prepare('UPDATE meta SET v=? WHERE k=?').run(`${new Date(Date.now() + 5000).toISOString()} 舊版記的錯`, routes.META.lastError)
    assert.equal(health(f).lastErrorKind, null)
  })

  test('e6：隔離區是捷徑，套用 500；接著掃描成功 → 寵物還在擔心；修好之後套用成功 → 不擔心', t => {
    const f = fixture(t)
    const elsewhere = join(f.dir, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, f.opts.quarantine)
    const p = call(f, 'POST', '/cleanup/plans', {}).body
    const bad = call(f, 'POST', `/cleanup/plans/${p.id}/apply`, {})
    assert.equal(bad.code, 500)
    assert.equal(health(f).lastErrorKind, 'apply')
    assert.equal(call(f, 'POST', '/cleanup/scan', {}).code, 200)
    assert.equal(petOf(f), 'worried', '一次成功的掃描就讓寵物不擔心，套用照樣壞')
    rmSync(f.opts.quarantine)
    assert.equal(call(f, 'POST', `/cleanup/plans/${p.id}/apply`, {}).body.status, 'applied')
    assert.notEqual(petOf(f), 'worried')
  })

  test('套用每一項都失敗（status error）→ 記成套用的錯、不記成功；只失敗一項（partial）→ 記成功', t => {
    const f = fixture(t)
    const p = call(f, 'POST', '/cleanup/plans', {}).body
    for (const n of ['a.zip', 'b.zip']) writeFileSync(join(f.downloads, n), '改過了')
    const r = call(f, 'POST', `/cleanup/plans/${p.id}/apply`, {})
    assert.equal(r.code, 200)
    assert.equal(r.body.status, 'error', '前提：每一項都失敗')
    const h = health(f)
    assert.equal(h.lastErrorKind, 'apply')
    assert.ok(h.lastError, '全失敗要記成錯')
    assert.ok(!/[\\/]/.test(h.lastError), h.lastError)
    assert.equal(h.lastOkByKind.apply, null, '全失敗不可以記成成功')
    assert.equal(petOf(f), 'worried')

    const g = fixture(t)
    const q = call(g, 'POST', '/cleanup/plans', {}).body
    writeFileSync(join(g.downloads, 'a.zip'), '改過了')
    assert.equal(call(g, 'POST', `/cleanup/plans/${q.id}/apply`, {}).body.status, 'partial')
    const h2 = health(g)
    assert.equal(h2.lastError, null)
    assert.equal(typeof h2.lastOkByKind.apply, 'string')
  })

  test('復原每一項都失敗 → 記成復原的錯（kind undo）', t => {
    const f = fixture(t)
    const p = call(f, 'POST', '/cleanup/plans', {}).body
    assert.equal(call(f, 'POST', `/cleanup/plans/${p.id}/apply`, {}).body.status, 'applied')
    for (const j of f.db.prepare(`SELECT to_path FROM cleanup_journal WHERE plan_id=? AND op='quarantine'`).all(p.id)) {
      writeFileSync(j.to_path, '隔離區的檔被改過')
    }
    const r = call(f, 'POST', `/cleanup/plans/${p.id}/undo`, {})
    assert.equal(r.body.status, 'error', '前提：每一項都放不回')
    assert.equal(health(f).lastErrorKind, 'undo')
    assert.equal(health(f).lastOkByKind.undo, null)
  })

  test('清空一個都沒刪掉（每一項都出錯）→ 記成清空的錯（kind empty）', t => {
    const f = fixture(t)
    const p = call(f, 'POST', '/cleanup/plans', {}).body
    call(f, 'POST', `/cleanup/plans/${p.id}/apply`, {})
    f.db.prepare('UPDATE cleanup_move_details SET completed_at=?').run(new Date(Date.now() - 8 * DAY).toISOString())
    // **真的錯**用硬鏈結替換（攻擊）：內容被改過在第三輪改成「放到一邊」，不再算錯
    const other = join(f.dir, 'elsewhere.bin')
    writeFileSync(other, 'x')
    for (const j of f.db.prepare(`SELECT to_path FROM cleanup_journal WHERE plan_id=? AND op='quarantine'`).all(p.id)) {
      rmSync(j.to_path)
      linkSync(other, j.to_path)
    }
    const preview = call(f, 'POST', '/cleanup/quarantine/empty', {}).body
    assert.equal(preview.itemCount, 2)
    const done = call(f, 'POST', '/cleanup/quarantine/empty', { token: preview.token, confirmed: true }).body
    assert.equal(done.deletedCount, 0, '前提：一個都沒刪')
    assert.equal(done.errors.length, 2, '前提：兩個都是真的錯')
    assert.equal(health(f).lastErrorKind, 'empty')
  })

  test('清空刪掉一些、也有錯（部分成功）→ 記成功、不記錯，寵物不擔心（突變 V09）', t => {
    const f = fixture(t)
    const p = call(f, 'POST', '/cleanup/plans', {}).body
    call(f, 'POST', `/cleanup/plans/${p.id}/apply`, {})
    f.db.prepare('UPDATE cleanup_move_details SET completed_at=?').run(new Date(Date.now() - 8 * DAY).toISOString())
    const [first] = f.db.prepare(`SELECT to_path FROM cleanup_journal WHERE plan_id=? AND op='quarantine' ORDER BY seq`).all(p.id)
    const other = join(f.dir, 'elsewhere.bin')
    writeFileSync(other, 'x')
    rmSync(first.to_path)
    linkSync(other, first.to_path)   // 真的錯（硬鏈結替換）；內容被改過現在是 setAside
    const preview = call(f, 'POST', '/cleanup/quarantine/empty', {}).body
    assert.equal(preview.itemCount, 2)
    const done = call(f, 'POST', '/cleanup/quarantine/empty', { token: preview.token, confirmed: true }).body
    assert.deepEqual({ deleted: done.deletedCount, errors: done.errors.length }, { deleted: 1, errors: 1 }, '前提：刪了一個、錯了一個')
    const h = health(f)
    assert.equal(h.lastError, null, '有刪掉的清空不算失敗')
    assert.equal(h.lastErrorKind, null)
    assert.equal(typeof h.lastOkByKind.empty, 'string')
    assert.notEqual(petOf(f), 'worried')
  })

  test('建計畫時的意外記成「套用」那一種，掃描成功清不掉；GET 路由的同一個意外沒有種類（突變 V10）', t => {
    const boom = () => { throw new Error('設定讀不到') }
    const f = fixture(t)
    assert.equal(call(f, 'POST', '/cleanup/plans', {}, { roots: boom }).code, 500)
    assert.equal(health(f).lastErrorKind, 'apply')
    routes.recordOk(f.db, 'scan')
    assert.equal(petOf(f), 'worried', '建計畫壞了，掃描成功不代表清得了')

    const g = fixture(t)
    assert.equal(call(g, 'GET', '/cleanup/candidates', undefined, { roots: boom }).code, 500)
    assert.ok(health(g).lastError, '前提：意外有記下來')
    assert.equal(health(g).lastErrorKind, null)
    routes.recordOk(g.db, 'scan')
    assert.notEqual(petOf(g), 'worried')
  })

  test('免 token 的 /health：lastErrorKind 是 null；帶 token 的才看得到種類（突變 V12）', async t => {
    const s = sandbox(t)
    routes.recordCleanupError(s.db, new Error('boom'), 'apply')
    assert.equal(health(s, false).lastErrorKind, null)
    assert.equal(health(s, true).lastErrorKind, 'apply')
    const srv = await serve(t, s)
    const anon = (await srv.raw('GET', '/health', { token: null })).json
    assert.ok('lastErrorKind' in anon, '欄位要在（形狀一致），只是值遮掉')
    assert.equal(anon.lastErrorKind, null)
    assert.equal((await srv.raw('GET', '/health')).json.lastErrorKind, 'apply')
  })

  test('掃描回報的問題存起來：帶 token 的 /health 有 scanProblems（去路徑、換掉控制字元、最多 50 條），免 token 的是空陣列', t => {
    const f = fixture(t)
    const evil = `invoice\u202Efdp.exe\n搬進隔離區 0 個：硬鏈結檔案不清理`
    const scan = onProblem => {
      onProblem(evil)
      onProblem(`資料夾 ${join(f.downloads, 'sub')} 打不開`)
      for (let i = 0; i < 120; i++) onProblem(`第 ${i} 個檔讀不到`)
      return f.scan()
    }
    assert.equal(call(f, 'POST', '/cleanup/scan', {}, { scan }).code, 200)
    const full = health(f)
    assert.ok(Array.isArray(full.scanProblems))
    assert.ok(full.scanProblems.length > 0 && full.scanProblems.length <= 50, String(full.scanProblems.length))
    const all = full.scanProblems.join('\n')
    assert.ok(!all.includes('\u202E') && !full.scanProblems.some(p => p.includes('\n')), JSON.stringify(full.scanProblems[0]))
    assert.ok(!all.includes(f.dir), '帶了完整路徑')
    assert.deepEqual(health(f, false).scanProblems, [], '免 token 不回內容')
    // 下一次掃描沒問題 → 清空
    assert.equal(call(f, 'POST', '/cleanup/scan', {}).code, 200)
    assert.deepEqual(health(f).scanProblems, [])
  })

  test('recordScanProblems 是匯出的（CLI 的背景重掃也要記），存的時候再保險一次', t => {
    const f = fixture(t)
    routes.recordScanProblems(f.db, ['a\u0007b', ...Array.from({ length: 70 }, (_, i) => `問題 ${i}`)])
    const got = health(f).scanProblems
    assert.equal(got.length, 50)
    assert.equal(got[0], 'a·b')
  })
})

// ═══ R2-11 ・ 防呆 ═══════════════════════════════════════════

describe('R2-11 防呆', () => {
  test('Windows 預設清理範圍是 %USERPROFILE%\\Downloads，不是 OneDrive\\Downloads（兩個都在也一樣）', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'cb-r2r-win-')))
    try {
      mkdirSync(join(home, 'OneDrive', 'Downloads'), { recursive: true })
      const onlyOneDrive = config.normalize({}, { os: 'win32', home }).config
      assert.deepEqual(onlyOneDrive.cleanup.roots, [join(home, 'Downloads')], '只有 OneDrive 那個存在時也不可以預設它')
      mkdirSync(join(home, 'Downloads'))
      const both = config.normalize({}, { os: 'win32', home }).config
      assert.deepEqual(both.cleanup.roots, [join(home, 'Downloads')])
      assert.deepEqual(config.defaults({ os: 'win32', home }).cleanup.roots, [join(home, 'Downloads')])
      assert.ok(both.watch.some(w => w.includes('OneDrive')), '截圖功能的 watch 預設不動')
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  test('cleanupRootProblem 先正規化再比：\\\\?\\、\\\\.\\、本機分享、macOS 的 /System/Volumes/Data', () => {
    const win = { os: 'win32', home: 'C:\\Users\\alice' }
    const mac = { os: 'darwin', home: '/Users/alice' }
    const bad = [
      ['\\\\?\\C:\\Users\\alice', win], ['\\\\.\\C:\\Users\\alice', win], ['\\\\?\\C:\\Users', win],
      ['\\\\localhost\\C$\\Users\\alice', win], ['\\\\LOCALHOST\\c$\\users', win], ['\\\\127.0.0.1\\C$\\Users\\alice\\', win],
      ['\\\\?\\UNC\\localhost\\C$\\Users\\alice', win], ['\\\\localhost\\C$', win],
      ['/System/Volumes/Data/Users/alice', mac], ['/System/Volumes/Data/Users', mac], ['/System/Volumes/Data', mac],
      ['/system/volumes/data/users/alice', mac],
    ]
    for (const [r, sys] of bad) assert.ok(config.cleanupRootProblem(r, sys), `${r} 應該被擋`)
    const good = [
      ['\\\\?\\C:\\Users\\alice\\Downloads', win], ['\\\\localhost\\C$\\Users\\alice\\Downloads', win],
      ['\\\\server\\share\\alice', win], ['C:\\Users2', win],
      ['/System/Volumes/Data/Users/alice/Downloads', mac], ['/System/Volumes/DataX/Users/alice', mac],
    ]
    for (const [r, sys] of good) assert.equal(config.cleanupRootProblem(r, sys), null, `${r} 應該放行`)
  })

  test('scanProblems 的輸出換掉控制字元與方向字元；正常的中文、emoji 原樣', () => {
    const out = routes.scanProblems([`invoice\u202Efdp.exe\n搬進隔離區 0 個：硬鏈結檔案不清理`, '照片📷.png：讀不到'], [])
    assert.ok(!out[0].includes('\u202E') && !out[0].includes('\n'), JSON.stringify(out[0]))
    assert.equal(out[1], '照片📷.png：讀不到')
  })

  test('e10：檔名帶 U+202E 與換行的硬鏈結，POST /cleanup/scan 的 problems 換掉了', async t => {
    const s = sandbox(t)
    const evil = join(s.downloads, 'invoice\u202Efdp.exe\n搬進隔離區 0 個')
    writeFileSync(evil, 'x')
    linkSync(evil, join(s.downloads, 'other-link'))
    const srv = await serve(t, s)
    const r = await srv.api('POST', '/cleanup/scan', {})
    assert.equal(r.status, 200)
    assert.ok(r.json.problems.length, '前提：硬鏈結有被報出來')
    assert.ok(!r.json.problems.some(p => p.includes('\u202E') || p.includes('\n')), JSON.stringify(r.json.problems))
  })

  test('safeWhy：寫入端的錯各自一句人話，不是「讀不到這個檔案」', () => {
    const raw = {
      EROFS: "EROFS: read-only file system, mkdir '/home/u/.contextbox/quarantine'",
      ENOSPC: "ENOSPC: no space left on device, open '/home/u/.contextbox/quarantine/p/i/content'",
      EXDEV: "EXDEV: cross-device link not permitted, rename '/a' -> '/b'",
      ELOOP: "ELOOP: too many symbolic links encountered, open '/home/u/Downloads/x'",
      EIO: "EIO: i/o error, read '/home/u/Downloads/x'",
    }
    const want = { EROFS: /read-only/, ENOSPC: /full/, EXDEV: /different disk/, ELOOP: /symlink/, EIO: /read or write|hardware|disk/ }
    const got = {}
    for (const [code, s] of Object.entries(raw)) {
      got[code] = routes.safeWhy(s)
      assert.notEqual(got[code], 'cannot read this file', code)
      assert.match(got[code], want[code], `${code}：${got[code]}`)
      assert.ok(!/[\\/]/.test(got[code]), got[code])
    }
    assert.equal(new Set(Object.values(got)).size, 5, '五種錯要五句話')
    assert.match(routes.safeWhy(raw.ENOSPC), /quarantine/, '滿的多半是隔離區所在的磁碟')
    // 對照：舊的照舊
    assert.equal(routes.safeWhy("ENOENT: no such file or directory, open '/x/y'"), 'this file is no longer there')
    assert.equal(routes.safeWhy("EACCES: permission denied, open '/x/y'"), 'no permission to read this file')
    assert.equal(routes.safeWhy('EWHATEVER: something /x'), 'cannot read this file')
  })

  test('/health：facts 表壞掉時，形狀跟正常時一模一樣（欄位齊全），ok 是 false', async t => {
    const s = sandbox(t)
    const srv = await serve(t, s)
    const normal = (await srv.raw('GET', '/health', { token: null })).json
    const normalFull = (await srv.raw('GET', '/health')).json
    assert.equal(normal.ok, true)
    const d = new DatabaseSync(s.dbPath)
    try { d.exec('DROP TABLE facts') } finally { d.close() }
    for (const [token, base] of [[null, normal], [TOKEN, normalFull]]) {
      const r = await srv.raw('GET', '/health', { token })
      assert.equal(r.status, 200)
      assert.deepEqual([...fieldSet(r.json)].sort(), [...fieldSet(base)].sort(), '壞掉時回了第三種形狀')
      assert.equal(r.json.ok, false, 'facts 表讀不到，後端不是好的')
      assert.equal(r.json.facts, 0)
    }
  })

  test('/health 最後那道 catch 的前提：資料庫整個不能用，healthSnapshot 也不丟、欄位齊全', t => {
    // server.ts 的 catch 拿一個「每次查詢都丟例外」的資料庫再算一次；這裡釘住那樣算得出完整形狀
    const f = fixture(t)
    const dead = { prepare() { throw new Error('資料庫不能用') } }
    for (const full of [false, true]) {
      const good = routes.healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine, full })
      const bad = routes.healthSnapshot(dead, { roots: [], quarantine: f.opts.quarantine, full })
      assert.deepEqual([...fieldSet(bad)].sort(), [...fieldSet(good)].sort())
      assert.equal(bad.ok, false)
    }
  })
})

// ═══ R2-12c ・ canEmptyNow 的 truncated 防線 ═══════════════════════

describe('R2-12c canEmptyNow：沒看完就 false（突變 M25 要紅）', () => {
  const past = new Date(Date.now() - DAY).toISOString()
  test('純函式：truncated 而且七天已過 → false；沒 truncated → true', () => {
    assert.equal(routes.canEmptyNow({ items: 2, truncated: true, canEmptyAt: past }), false)
    assert.equal(routes.canEmptyNow({ items: 2, truncated: false, canEmptyAt: past }), true)
    assert.equal(routes.canEmptyNow({ items: 0, truncated: false, canEmptyAt: past }), false)
    assert.equal(routes.canEmptyNow({ items: 2, truncated: false, canEmptyAt: null }), false)
    assert.equal(routes.canEmptyNow({ items: 2, truncated: false, canEmptyAt: new Date(Date.now() + DAY).toISOString() }), false)
  })

  test('真的走訪沒看完（隔離區有讀不到的資料夾）：滿七天也說不能清', { skip: noPerm && '要 chmod 擋得住' }, t => {
    const f = fixture(t)
    applyPlan(f.db, f.plan().id, f.opts)
    f.db.prepare('UPDATE cleanup_move_details SET completed_at=?').run(new Date(Date.now() - 8 * DAY).toISOString())
    const locked = join(f.opts.quarantine, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o000)
    try {
      const h = health(f)
      assert.equal(h.quarantine.truncated, true, '前提：沒看完')
      assert.equal(h.quarantine.canEmptyNow, false)
    } finally { chmodSync(locked, 0o700) }
    assert.equal(health(f).quarantine.canEmptyNow, true, '對照：看完了就可以')
  })

  test('cleanup-routes.ts 的 docstring 指向真的測試，不再說「突變測試證實過」卻沒有測試', () => {
    const src = readFileSync(new URL('../core/cleanup-routes.ts', import.meta.url), 'utf8')
    const at = src.indexOf('export function canEmptyNow')
    assert.ok(at > 0, '找不到 canEmptyNow')
    // 緊貼在函式前面的那一段 /** … */（不可以一路吃到檔頭）
    const doc = src.slice(src.lastIndexOf('/**', at), at)
    assert.match(doc, /^\/\*\*[\s\S]*\*\/\s*$/, '函式前面緊貼的不是一段 docstring')
    assert.match(doc, /audit-0919-r2routes\.test\.mjs/)
    assert.doesNotMatch(doc, /突變測試證實過/)
  })
})
