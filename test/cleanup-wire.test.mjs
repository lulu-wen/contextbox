/**
 * D 把 B 的執行層接進 route 與 CLI。
 *
 * 這些測試在實作**之前**寫，期望值來自 `~/contextbox-預想-20260915-接線.md`
 * 的表格，不是從實作抄的。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { statSync, existsSync, writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync, utimesSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { fixture } from './helpers/cleanup.mjs'
import { cleanupRoutes, healthSnapshot, statusFor, petState, HTTP_FOR_CODE } from '../core/cleanup-routes.ts'
import { createPlan } from '../core/cleanup-plans.ts'
import { applyPlan } from '../core/cleanup-exec.ts'
import { scanDownloads } from '../core/cleanup-scanner.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 打一次 route，回 { code, body }。 */
function call(f, method, path, body = {}, extra = {}) {
  let got = null
  const handled = cleanupRoutes({
    db: f.db, roots: f.opts.roots, quarantine: f.opts.quarantine,
    maxBytes: f.opts.maxBytes, readonly: false,
    url: new URL('http://x' + path), method, body,
    send: (code, payload) => { got = { code, body: payload } },
    scan: f.scan,
    ...extra,
  })
  return { handled, ...got }
}

// ═══ A ・ CleanupError → HTTP ════════════════════════════════

describe('A 錯誤代碼對到 HTTP 狀態碼', () => {
  test('**每一個 B 丟得出來的 code 都要有明確對應**', () => {
    // 手寫一張表就是上一輪 KIND_CONFIDENCE 的重演：B 新增一個 code，
    // 表沒更新，它靜靜變成預設值，沒有任何測試會紅。
    // 所以真實來源是**原始碼**，不是我腦中的清單。
    //
    // 2026-09-19 稽核 RC21：上一版的正規式只認單引號，檔案也是手寫的四支 ——
    // `CleanupError("NEW", …)`、`` CleanupError(`NEW`, …) ``、或寫在 cleanup-routes.ts 裡的，
    // 全部漏掉，測試照樣綠。現在三種引號都認，而且掃 core/ 底下**每一支** .ts。
    const coreDir = join(REPO, 'core')
    const src = readdirSync(coreDir).filter(f => f.endsWith('.ts'))
      .map(f => readFileSync(join(coreDir, f), 'utf8')).join('\n')
    const thrown = [...src.matchAll(/CleanupError\(\s*(['"`])([A-Z_]+)\1/g)].map(m => m[2])
    assert.ok(thrown.length >= 15, `只抓到 ${thrown.length} 個 code，正規式壞了`)
    // 三種引號都要認得（正規式自己的檢查，不靠原始碼剛好用了哪一種）
    for (const q of ["'", '"', '`']) {
      assert.deepEqual([...`new CleanupError(${q}X_Y${q}, 'z')`.matchAll(/CleanupError\(\s*(['"`])([A-Z_]+)\1/g)].map(m => m[2]), ['X_Y'],
        `正規式不認 ${q} 引號`)
    }
    const missing = [...new Set(thrown)].filter(c => !(c in HTTP_FOR_CODE))
    assert.deepEqual(missing, [], `這些 code 沒有對應，會掉到預設值：${missing.join('、')}`)
  })

  test('未知的 code 走 500，不是 400', () => {
    // 400 等於告訴 C「你打錯了」，它會改 body 重試，永遠修不好。
    // 第二輪才修過同一個 bug（後端故障回 400 + SQLite 原文）。
    assert.equal(statusFor('WEIRD_NEW_CODE_FROM_THE_FUTURE'), 500)
  })

  test('分類：哪些是使用者的錯、哪些是狀態、哪些是這台機器的錯', () => {
    assert.equal(statusFor('NOT_FOUND'), 404)
    assert.equal(statusFor('BAD_BODY'), 400)
    assert.equal(statusFor('CONFLICT'), 409)
    // 候選變了是狀態衝突，不是 body 格式錯 —— C 該重新掃描而不是改參數
    assert.equal(statusFor('STALE_CANDIDATE'), 409)
    assert.equal(statusFor('EMPTY_PLAN'), 409)
    // 權限拒絕，不是格式錯
    assert.equal(statusFor('READ_ONLY'), 403)
    // 請求完全合法，只是現在忙 —— 409 會讓 C 以為要改請求
    assert.equal(statusFor('BUSY'), 503)
    // 語意就是為「你少做了前一步」設計的
    assert.equal(statusFor('CONFIRMATION_REQUIRED'), 428)
    // 曾經有效、現在永久消失，重試同一個 token 沒有意義
    assert.equal(statusFor('CONFIRMATION_EXPIRED'), 410)
    // 這台機器設定壞了，不是 C 送錯
    assert.equal(statusFor('BAD_CONFIG'), 500)
    assert.equal(statusFor('UNSAFE_PATH'), 500)
    assert.equal(statusFor('UNSAFE_JOURNAL'), 500)
  })

  test('BUSY 要帶 Retry-After 的意思（讓 C 知道可以重試）', () => {
    assert.equal(statusFor('BUSY'), 503)
  })
})

// ═══ 路由 ═══════════════════════════════════════════════════

describe('plan 的路由', () => {
  test('建立 → 查詢 → 套用，而且回應裡沒有絕對路徑', t => {
    const f = fixture(t)
    const created = call(f, 'POST', '/cleanup/plans', {})
    assert.equal(created.code, 200)
    assert.ok(created.body.id)
    assert.equal(created.body.status, 'proposed')

    const got = call(f, 'GET', `/cleanup/plans/${created.body.id}`)
    assert.equal(got.code, 200)
    assert.equal(got.body.id, created.body.id)

    const applied = call(f, 'POST', `/cleanup/plans/${created.body.id}/apply`, {})
    assert.equal(applied.code, 200)
    assert.equal(applied.body.status, 'applied')
    assert.equal(applied.body.quarantinedCount, 2)
    assert.equal(applied.body.undoable, true)

    for (const r of [created, got, applied]) {
      const s = JSON.stringify(r.body)
      assert.ok(!s.includes(f.downloads), '回應裡有絕對路徑')
      assert.ok(!s.includes(f.opts.quarantine), '回應裡有隔離區路徑')
    }
  })

  test('乾淨的 Downloads 建 plan 回 409 EMPTY_PLAN，不是 400', t => {
    const f = fixture(t, {})
    const r = call(f, 'POST', '/cleanup/plans', {})
    assert.equal(r.code, 409)
    assert.equal(r.body.code, 'EMPTY_PLAN')
  })

  test('查不存在的 plan 回 404', t => {
    const f = fixture(t)
    const r = call(f, 'GET', '/cleanup/plans/沒這個東西')
    assert.equal(r.code, 404)
    assert.equal(r.body.code, 'NOT_FOUND')
  })

  test('唯讀模式下 apply 回 403，而且一個檔都沒動', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    const before = f.scan
    const r = call(f, 'POST', `/cleanup/plans/${p.id}/apply`, {}, { readonly: true })
    assert.equal(r.code, 403)
    assert.equal(r.body.code, 'READ_ONLY')
    assert.ok(existsSync(join(f.downloads, 'a.zip')), '唯讀模式下檔案不可以被搬走')
  })

  test('undo 把檔案放回原位', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    call(f, 'POST', `/cleanup/plans/${p.id}/apply`, {})
    assert.ok(!existsSync(join(f.downloads, 'a.zip')))
    const r = call(f, 'POST', `/cleanup/plans/${p.id}/undo`, {})
    assert.equal(r.code, 200)
    assert.ok(existsSync(join(f.downloads, 'a.zip')), '復原之後要回到原位')
  })

  test('dismiss 之後那些候選不會再出現', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    const r = call(f, 'POST', `/cleanup/plans/${p.id}/dismiss`, {})
    assert.equal(r.code, 200)
    assert.equal(r.body.status, 'dismissed')
  })

  test('已經套用的 plan 再 dismiss 回 409', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    call(f, 'POST', `/cleanup/plans/${p.id}/apply`, {})
    const r = call(f, 'POST', `/cleanup/plans/${p.id}/dismiss`, {})
    assert.equal(r.code, 409)
  })

  test('略過的候選 id 不屬於這份 plan 就回 400', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    const r = call(f, 'POST', `/cleanup/plans/${p.id}/apply`, { skippedIds: ['不是這份的'] })
    assert.equal(r.code, 400)
    assert.equal(r.body.code, 'BAD_BODY')
  })
})

// ═══ D ・ 隔離區清空的二次確認 ═══════════════════════════════

describe('D 清空隔離區', () => {
  test('沒帶 token 是預覽，phase 要說清楚自己在哪一階段', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    call(f, 'POST', `/cleanup/plans/${p.id}/apply`, {})
    const r = call(f, 'POST', '/cleanup/quarantine/empty', {})
    assert.equal(r.code, 200)
    assert.equal(r.body.phase, 'preview', '不帶 phase 的話 C 分不出自己拿到的是預覽還是結果')
    assert.ok(r.body.token)
    // 剛搬進去的還不滿七天 → 預覽是 0，但**不是錯**（預覽是唯讀動作）
    assert.equal(r.body.itemCount, 0)
  })

  test('**`{"confirmed":"false"}` 不可以被當成同意**', t => {
    // 字串 "false" 在 JS 是 truthy。這一條會真的刪掉使用者的檔。
    //
    // 2026-09-19 稽核 RC21／RC23：上一版只送了 "false"，而且隔離區裡**根本沒有滿七天的檔** ——
    // 就算被當成同意也刪不到東西，「沒帶 confirmed 就當成 true」這種突變照樣全綠。
    // 現在先把兩個檔撥到八天前（被誤判成同意就會真的刪掉），再逐一送：
    //   沒帶、false → 428（還沒確認）；帶了但不是布林 → 400（送錯）。
    // 每送一次都確認隔離區還是兩個。
    const f = fixture(t)
    const p = createPlan(f.db)
    applyPlan(f.db, p.id, f.opts)
    f.db.prepare('UPDATE cleanup_move_details SET completed_at=?')
      .run(new Date(Date.now() - 8 * 86400_000).toISOString())
    const prep = call(f, 'POST', '/cleanup/quarantine/empty', {})
    assert.equal(prep.body.itemCount, 2, '前提：預覽裡真的有兩個可以刪')
    const token = prep.body.token
    const cases = [
      ['沒帶 confirmed', { token }, 428, 'CONFIRMATION_REQUIRED'],
      ['confirmed: false', { token, confirmed: false }, 428, 'CONFIRMATION_REQUIRED'],
      ['confirmed: "false"', { token, confirmed: 'false' }, 400, 'BAD_BODY'],
      ['confirmed: "true"', { token, confirmed: 'true' }, 400, 'BAD_BODY'],
      ['confirmed: 1', { token, confirmed: 1 }, 400, 'BAD_BODY'],
      ['confirmed: null', { token, confirmed: null }, 400, 'BAD_BODY'],
      ['confirmed: [true]', { token, confirmed: [true] }, 400, 'BAD_BODY'],
      ['confirmed: {}', { token, confirmed: {} }, 400, 'BAD_BODY'],
    ]
    for (const [label, body, status, code] of cases) {
      const r = call(f, 'POST', '/cleanup/quarantine/empty', body)
      assert.equal(r.code, status, `${label} 回了 ${r.code}：${JSON.stringify(r.body)}`)
      assert.equal(r.body.code, code, label)
      assert.equal(call(f, 'GET', '/cleanup/quarantine').body.total, 2, `${label} 之後隔離區少了東西 —— 被當成同意了`)
    }
    // 對照組：同一個 token 帶布林 true 才真的刪（證明上面每一條「沒刪」是因為被擋，不是因為沒東西可刪）
    const ok = call(f, 'POST', '/cleanup/quarantine/empty', { token, confirmed: true })
    assert.equal(ok.code, 200)
    assert.equal(ok.body.deletedCount, 2)
  })

  test('沒先預覽就直接確認回 428', t => {
    const f = fixture(t)
    const r = call(f, 'POST', '/cleanup/quarantine/empty',
      { token: '亂編的', confirmed: true })
    assert.equal(r.code, 428)
  })

  test('確認之後回 phase done', t => {
    const f = fixture(t)
    const prep = call(f, 'POST', '/cleanup/quarantine/empty', {})
    const r = call(f, 'POST', '/cleanup/quarantine/empty',
      { token: prep.body.token, confirmed: true })
    assert.equal(r.code, 200)
    assert.equal(r.body.phase, 'done')
    assert.equal(r.body.deletedCount, 0)
  })

  test('GET /cleanup/quarantine 列出隔離區，沒有絕對路徑', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    call(f, 'POST', `/cleanup/plans/${p.id}/apply`, {})
    const r = call(f, 'GET', '/cleanup/quarantine')
    assert.equal(r.code, 200)
    assert.equal(r.body.items.length, 2)
    assert.ok(!JSON.stringify(r.body).includes(f.opts.quarantine))
  })
})

// ═══ C ・ 七天窗 ════════════════════════════════════════════

describe('C 七天窗改用 journal', () => {
  test('**canEmptyNow 跟 canEmptyAt 要能互推**', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    applyPlan(f.db, p.id, f.opts)
    // 互推只對帶 token 的那一份成立：免 token 的 canEmptyAt 是 null，canEmptyNow 照給（第三波之二）
    const h = healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine, full: true })
    assert.equal(h.quarantine.items, 2)
    assert.equal(
      h.quarantine.canEmptyNow,
      h.quarantine.canEmptyAt !== null && Date.parse(h.quarantine.canEmptyAt) <= Date.now(),
      '兩個欄位對不起來的話，UI 顯示的時間跟按鈕的行為會矛盾',
    )
    assert.equal(h.quarantine.canEmptyNow, false, '剛搬進去，還不滿七天')
  })

  test('canEmptyAt 取**最早**那一筆，不是最新', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    applyPlan(f.db, p.id, f.opts)
    // 把其中一筆的隔離完成時間改成六天前
    const rows = f.db.prepare(`SELECT seq FROM cleanup_journal WHERE op='quarantine' ORDER BY seq`).all()
    const sixDaysAgo = new Date(Date.now() - 6 * 86400_000).toISOString()
    f.db.prepare('UPDATE cleanup_move_details SET completed_at=? WHERE seq=?').run(sixDaysAgo, rows[0].seq)

    const h = healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine, full: true })
    const expected = new Date(Date.parse(sixDaysAgo) + 7 * 86400_000).toISOString()
    assert.equal(h.quarantine.canEmptyAt, expected,
      '取最新那筆的話，UI 會說「還要等七天」，但其實明天就有東西可以清了')
  })

  test('至少一筆滿七天就 canEmptyNow，不必全部都滿', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    applyPlan(f.db, p.id, f.opts)
    const rows = f.db.prepare(`SELECT seq FROM cleanup_journal WHERE op='quarantine' ORDER BY seq`).all()
    const eightDaysAgo = new Date(Date.now() - 8 * 86400_000).toISOString()
    f.db.prepare('UPDATE cleanup_move_details SET completed_at=? WHERE seq=?').run(eightDaysAgo, rows[0].seq)

    const h = healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine })
    assert.equal(h.quarantine.canEmptyNow, true,
      'emptyQuarantine 本來就只刪合格的那些，按下去確實會有東西被刪掉')
  })

  test('空隔離區：canEmptyAt 是 null、canEmptyNow 是 false', t => {
    const f = fixture(t)
    const h = healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine })
    assert.equal(h.quarantine.items, 0)
    assert.equal(h.quarantine.canEmptyAt, null)
    assert.equal(h.quarantine.canEmptyNow, false)
  })

  test('孤兒檔不擋住清空，但要另外報數', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    applyPlan(f.db, p.id, f.opts)
    const rows = f.db.prepare(`SELECT seq FROM cleanup_journal WHERE op='quarantine' ORDER BY seq`).all()
    f.db.prepare('UPDATE cleanup_move_details SET completed_at=? WHERE seq=?')
      .run(new Date(Date.now() - 8 * 86400_000).toISOString(), rows[0].seq)
    // 有人手動丟一個檔進隔離區
    mkdirSync(join(f.opts.quarantine, '手動'), { recursive: true })
    writeFileSync(join(f.opts.quarantine, '手動', '來路不明.bin'), 'x')

    const h = healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine })
    assert.equal(h.quarantine.orphans, 1, '不報的話 UI 會說「清空了」而它還在')
    assert.equal(h.quarantine.canEmptyNow, true, '一個孤兒不可以讓隔離區永遠清不掉')
  })

  test('**`/health` 不可以拿清理的寫鎖**', t => {
    // /health 免 token，任何網頁都可以用 <img src=...> 連發。
    // 拿寫鎖的話，一個外部網頁就能跟真正的清理動作搶鎖。
    const f = fixture(t)
    const p = createPlan(f.db)
    applyPlan(f.db, p.id, f.opts)
    // 假裝另一個行程正握著鎖。owner 要是新格式（剛拿的時間戳）：
    // 沒有時間戳的舊格式現在一律當殘留，會被接走 —— 那樣就驗不到 /health 有沒有去搶鎖。
    f.db.prepare('INSERT OR REPLACE INTO cleanup_operation_lock VALUES (1,?,?)')
      .run(process.pid, `${new Date().toISOString()} someone-else`)
    try {
      const h = healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine })
      assert.equal(h.quarantine.items, 2, '有人握著鎖，/health 還是要答得出來')
      assert.equal(h.quarantine.truncated, false, '這不是「沒看完」，是正常讀到了')
    } finally {
      f.db.prepare('DELETE FROM cleanup_operation_lock').run()
    }
  })

  test('七天的邊界：剛好到算到，差一毫秒不算', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    applyPlan(f.db, p.id, f.opts)
    const rows = f.db.prepare(`SELECT seq FROM cleanup_journal WHERE op='quarantine' ORDER BY seq`).all()
    const set = (ms) => {
      for (const r of rows) {
        f.db.prepare('UPDATE cleanup_move_details SET completed_at=? WHERE seq=?')
          .run(new Date(ms).toISOString(), r.seq)
      }
      return healthSnapshot(f.db, { roots: f.opts.roots, quarantine: f.opts.quarantine }).quarantine
    }
    const WINDOW = 7 * 86400_000
    assert.equal(set(Date.now() - WINDOW - 1000).canEmptyNow, true, '早就到了')
    assert.equal(set(Date.now() - WINDOW + 5000).canEmptyNow, false, '還差五秒')
  })
})

// ═══ E ・ 寵物狀態 ══════════════════════════════════════════

describe('E 寵物狀態的優先序', () => {
  const st = (over) => petState({
    ok: true, db: { ok: true }, watcher: { ok: false }, pendingCandidates: 0,
    lastError: null, ...over,
  }, { proposedPlans: 0, activeQuarantine: 0 })

  test('後端壞了的時候不可以顯示「找到 7 個可以清」', () => {
    const s = petState({ ok: false, db: { ok: false }, watcher: { ok: true },
      pendingCandidates: 7, lastError: null }, { proposedPlans: 0, activeQuarantine: 0 })
    assert.equal(s.state, 'worried', '壞掉的時候報喜是在騙人')
  })

  test('有 plan 在等確認時，又掃到新檔也不可以蓋掉待辦', () => {
    const s = petState({ ok: true, db: { ok: true }, watcher: { ok: true },
      pendingCandidates: 9, lastError: null }, { proposedPlans: 1, activeQuarantine: 0 })
    assert.equal(s.state, 'waiting', 'found 蓋掉 waiting 的話，使用者永遠看不到「請確認」')
  })

  test('五個查得到的狀態各走一次', () => {
    assert.equal(st({ db: { ok: false } }).state, 'worried')
    assert.equal(st({ lastError: '出過事' }).state, 'worried')
    assert.equal(st({ pendingCandidates: 3, watcher: { ok: true } }).state, 'found')
    assert.equal(st({ watcher: { ok: true } }).state, 'watching')
    assert.equal(st({}).state, 'idle')
  })

  test('**undoable 是旗標不是 state** —— 當 state 會卡住七天', () => {
    const s = petState({ ok: true, db: { ok: true }, watcher: { ok: true },
      pendingCandidates: 4, lastError: null }, { proposedPlans: 0, activeQuarantine: 2 })
    assert.equal(s.state, 'found', '清完三天後還卡在 undoable 的話，寵物一週不會動')
    assert.equal(s.undoable, true)
    assert.equal(s.quarantinedCount, 2)
  })

  test('thinking／cleaning／happy 後端查不出來，不可以出現在回應裡', () => {
    // 掃描與 apply 都是同步 request，回應送出時它們已經結束了。
    // 那三個是前端在等 response 時自己播的動畫。
    const seen = new Set()
    for (const over of [{}, { db: { ok: false } }, { watcher: { ok: true } },
                        { pendingCandidates: 5, watcher: { ok: true } }]) {
      seen.add(st(over).state)
    }
    for (const bad of ['thinking', 'cleaning', 'happy']) {
      assert.ok(!seen.has(bad), `${bad} 不該由後端回報`)
    }
  })

  test('/pet/state 有一句人話，而且沒有路徑', t => {
    const f = fixture(t)
    const r = call(f, 'GET', '/pet/state')
    assert.equal(r.code, 200)
    assert.ok(typeof r.body.message === 'string' && r.body.message.length > 0)
    assert.ok(!JSON.stringify(r.body).includes(f.downloads))
  })
})

// ═══ B ・ CLI 離開碼 ════════════════════════════════════════

describe('B CLI 離開碼', () => {
  const CLI = join(REPO, 'cli.mjs')
  /**
   * 在隔離的暫存環境跑 CLI。絕不碰真的 Downloads 或 ~/.contextbox。
   * **HOME 也要換掉**（稽核 RC22）：清理範圍（cleanup.roots）沒寫的時候預設是 ~/Downloads，
   * 子行程帶著真的 HOME 就會去掃使用者真的 Downloads。設定檔裡也明寫 cleanup.roots。
   */
  function cli(f, args, env = {}) {
    const cfg = join(f.dir, 'config.json')
    writeFileSync(cfg, JSON.stringify({
      watch: f.opts.roots, cleanup: { roots: f.opts.roots }, filed: join(f.dir, 'Filed'),
      model: { baseUrl: '', name: '', keyEnv: 'CONTEXTBOX_MODEL_KEY' },
      readonly: false, pdfPages: 3, maxBytes: f.opts.maxBytes,
    }))
    const r = spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: f.dir, USERPROFILE: f.dir, CONTEXTBOX_CONFIG: cfg, CONTEXTBOX_DB: f.dbPath,
             CONTEXTBOX_QUARANTINE: f.opts.quarantine, ...env },
    })
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
  }

  test('全部成功是 0', t => {
    const f = fixture(t)
    const r = cli(f, ['cleanup', 'apply'])
    assert.equal(r.code, 0, r.out)
  })

  test('**沒東西要清是 0**，不是 1 也不是 2', t => {
    const f = fixture(t, {})
    const r = cli(f, ['cleanup', 'apply'])
    assert.equal(r.code, 0, `回了 ${r.code}：每晚 smoke 會一直紅\n${r.out}`)
  })

  test('唯讀模式是 0 —— smoke 第 0 步就靠它確認「只說不做」', t => {
    const f = fixture(t)
    const r = cli(f, ['cleanup', 'apply'], { CONTEXTBOX_READONLY: '1' })
    assert.equal(r.code, 0, r.out)
    assert.ok(existsSync(join(f.downloads, 'a.zip')), '唯讀模式下檔案不可以被搬走')
  })

  test('undo 打錯 plan id 是 1（輸入錯）', t => {
    const f = fixture(t)
    const r = cli(f, ['cleanup', 'undo', '亂打的'])
    assert.equal(r.code, 1, r.out)
  })

  test('undo 不給 id、也沒有可以復原的計畫是 1', t => {
    // 2026-09-19 稽核 RC13：不給 id ＝ 最近一份可復原的（docs/cli.md）。這個 fixture 什麼都還沒套用，
    // 沒有東西可以復原，所以還是 1 —— 但原因從「少給 id」變成「沒有這樣的計畫」。
    const f = fixture(t)
    const r = cli(f, ['cleanup', 'undo'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /沒有可以復原/)
  })

  test('**全部失敗是 3 不是 2** —— 動作執行了，只是檔案沒搬成', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    // 把兩個檔都弄不見，apply 就會全失敗
    rmSync(join(f.downloads, 'a.zip'))
    rmSync(join(f.downloads, 'b.zip'))
    const r = cli(f, ['cleanup', 'apply', p.id])
    assert.equal(r.code, 3, `回了 ${r.code}。2 要留給「連跑都跑不起來」\n${r.out}`)
  })

  test('部分失敗是 3', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    rmSync(join(f.downloads, 'a.zip'))
    const r = cli(f, ['cleanup', 'apply', p.id])
    assert.equal(r.code, 3, r.out)
  })

  test('cleanup quarantine 列出隔離區，不印絕對路徑', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    applyPlan(f.db, p.id, f.opts)
    const r = cli(f, ['cleanup', 'quarantine'])
    assert.equal(r.code, 0, r.out)
    assert.ok(!r.out.includes(f.opts.quarantine), 'CLI 也不印隔離區絕對路徑')
    assert.match(r.out, /a\.zip/)
  })

  test('cleanup quarantine --empty 不滿七天要被擋，而且說得出還要等幾天', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    applyPlan(f.db, p.id, f.opts)
    const r = cli(f, ['cleanup', 'quarantine', '--empty'])
    assert.match(r.out, /[還剩等]/, '要講得出還要等多久')
    assert.ok(existsSync(join(f.opts.quarantine)), '隔離區還在')
  })
})

describe('重送 apply 不可以搬第二次', () => {
  test('**重送是冪等的** —— 回同樣的結果，不是錯誤', t => {
    // smoke 文件原本寫「第二次回 409 + 離開碼 1」，但 B 做的是冪等重播。
    // B 是對的：CLI 逾時後被腳本重試是正常的，那不該算失敗。
    // 兩種做法都守住「不可以真的再搬一次」，但冪等對呼叫端友善得多。
    //
    // 2026-09-19 稽核 RC21：quarantinedCount 是 `SELECT DISTINCT item_id` 算的，
    // **真的再跑一次也不會超過 2** —— 「重送時忘了已經搬過、重新驗證原檔（原檔已經不在，
    // 失敗並寫下錯誤）」這種突變，上一版的斷言照樣全綠。
    // 要驗的是「第二次什麼都沒寫」：journal 的列數與內容、每個檔的 status／error、計畫狀態都不變。
    const f = fixture(t)
    const p = createPlan(f.db)
    const journal = () => f.db.prepare(
      'SELECT seq, op, status, error FROM cleanup_journal WHERE plan_id=? ORDER BY seq').all(p.id)
    const files = () => f.db.prepare('SELECT id, status, error FROM file_items ORDER BY id').all()
    const first = call(f, 'POST', `/cleanup/plans/${p.id}/apply`, {})
    assert.equal(first.code, 200)
    assert.equal(first.body.quarantinedCount, 2)
    const before = { journal: journal(), files: files() }
    assert.ok(before.journal.length >= 2, '前提：第一次套用有寫 journal')

    const second = call(f, 'POST', `/cleanup/plans/${p.id}/apply`, {})
    assert.equal(second.code, 200, '重試不該變成錯誤')
    assert.equal(second.body.quarantinedCount, 2, '不可以變成 4 —— 那代表真的搬了第二次')
    assert.equal(second.body.status, first.body.status, '重送把計畫狀態改掉了')
    assert.equal(journal().length, before.journal.length, '重送多寫了 journal —— 那代表又跑了一次搬移')
    assert.deepEqual(journal(), before.journal, '重送改了 journal')
    assert.deepEqual(files(), before.files, '重送改了 file_items 的 status／error')
    assert.deepEqual(
      second.body.items.map(i => [i.itemId, i.outcome, i.why]).sort(),
      first.body.items.map(i => [i.itemId, i.outcome, i.why]).sort(),
    )
  })

  test('CLI 重送同一份 plan 也是 0', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    applyPlan(f.db, p.id, f.opts)
    const cfg = join(f.dir, 'config.json')
    writeFileSync(cfg, JSON.stringify({
      watch: f.opts.roots, cleanup: { roots: f.opts.roots }, filed: join(f.dir, 'Filed'),
      model: { baseUrl: '', name: '', keyEnv: 'CONTEXTBOX_MODEL_KEY' },
      readonly: false, pdfPages: 3, maxBytes: f.opts.maxBytes,
    }))
    const r = spawnSync(process.execPath, [join(REPO, 'cli.mjs'), 'cleanup', 'apply', p.id], {
      encoding: 'utf8',
      env: { ...process.env, HOME: f.dir, USERPROFILE: f.dir, CONTEXTBOX_CONFIG: cfg, CONTEXTBOX_DB: f.dbPath,
             CONTEXTBOX_QUARANTINE: f.opts.quarantine },
    })
    assert.equal(r.status, 0, (r.stdout ?? '') + (r.stderr ?? ''))
  })
})

describe('apply 的畫面不可以說謊', () => {
  const runCli = (f, args) => {
    const cfg = join(f.dir, 'config.json')
    writeFileSync(cfg, JSON.stringify({
      watch: f.opts.roots, cleanup: { roots: f.opts.roots }, filed: join(f.dir, 'Filed'),
      model: { baseUrl: '', name: '', keyEnv: 'CONTEXTBOX_MODEL_KEY' },
      readonly: false, pdfPages: 3, maxBytes: f.opts.maxBytes,
    }))
    const r = spawnSync(process.execPath, [join(REPO, 'cli.mjs'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: f.dir, USERPROFILE: f.dir, CONTEXTBOX_CONFIG: cfg, CONTEXTBOX_DB: f.dbPath,
             CONTEXTBOX_QUARANTINE: f.opts.quarantine },
    })
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
  }

  test('**沒搬成的印 ✘ 不是 ✔**', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    rmSync(join(f.downloads, 'a.zip'))   // 讓其中一個一定失敗
    const r = runCli(f, ['cleanup', 'apply', p.id])
    assert.equal(r.code, 3, r.out)
    assert.match(r.out, /✘ a\.zip/, '失敗的那個要印 ✘ 和原因')
    assert.doesNotMatch(r.out, /原因不明/, '**一定要講得出為什麼**（spec 第 6 節）')
    assert.match(r.out, /✔ b\.zip/, '成功的那個還是 ✔')
    assert.equal((r.out.match(/✔/g) ?? []).length, 1, '不可以每一項都印 ✔')
  })

  test('全部失敗時不可以印出一排 ✔', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    rmSync(join(f.downloads, 'a.zip'))
    rmSync(join(f.downloads, 'b.zip'))
    const r = runCli(f, ['cleanup', 'apply', p.id])
    assert.equal((r.out.match(/✔/g) ?? []).length, 0,
      '一個都沒搬成，畫面上不可以有任何 ✔')
    assert.match(r.out, /搬進隔離區 0 個/)
    assert.doesNotMatch(r.out, /cleanup undo/, '沒東西可復原就不要給復原指令')
    assert.doesNotMatch(r.out, /原因不明/, '每一個 ✘ 都要講得出為什麼')
  })
})

describe('唯讀試跑不可以弄壞下一次真的跑', () => {
  const runCli = (f, args, env = {}) => {
    const cfg = join(f.dir, 'config.json')
    writeFileSync(cfg, JSON.stringify({
      watch: f.opts.roots, cleanup: { roots: f.opts.roots }, filed: join(f.dir, 'Filed'),
      model: { baseUrl: '', name: '', keyEnv: 'CONTEXTBOX_MODEL_KEY' },
      readonly: false, pdfPages: 3, maxBytes: f.opts.maxBytes,
    }))
    const r = spawnSync(process.execPath, [join(REPO, 'cli.mjs'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: f.dir, USERPROFILE: f.dir, CONTEXTBOX_CONFIG: cfg, CONTEXTBOX_DB: f.dbPath,
             CONTEXTBOX_QUARANTINE: f.opts.quarantine, ...env },
    })
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
  }

  test('**唯讀試跑之後，真的 apply 還要能跑**', t => {
    // smoke 第 0 步就是叫使用者先跑唯讀試跑。
    // 試跑留下一份 plan 佔住那些檔的話，照著文件做就會壞。
    const f = fixture(t)
    const dry = runCli(f, ['cleanup', 'apply'], { CONTEXTBOX_READONLY: '1' })
    assert.equal(dry.code, 0, dry.out)

    const plans = f.db.prepare('SELECT count(*) n FROM cleanup_plans').get().n
    assert.equal(plans, 0, '唯讀試跑不可以留下任何計畫')

    const real = runCli(f, ['cleanup', 'apply'])
    assert.equal(real.code, 0, `唯讀試跑弄壞了真的那次：\n${real.out}`)
    assert.match(real.out, /搬進隔離區 2 個/)
  })

  test('真的有 plan 卡住時，訊息要講得出怎麼往下走', t => {
    // 2026-09-19 稽核：只有還沒套用的（proposed）計畫會卡住。「不清了」改成 release
    // （放棄那一份、不動任何檔案）—— 以前給的 undo，對一份 partial 的計畫照做會把已經清掉的檔放回來。
    // 重試一百次也一樣，要換個做法才過得去，所以離開碼是 1 不是 2。
    const f = fixture(t)
    const p = createPlan(f.db)
    const r = runCli(f, ['cleanup', 'apply'])
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes(`cleanup apply ${p.id}`), '要給「接著清」的指令')
    assert.ok(r.out.includes(`cleanup release ${p.id}`), '要給「放棄那一份」的指令')
    assert.doesNotMatch(r.out, /cleanup undo /, '不可以叫人用 undo 解開卡住的計畫')
  })
})

test('**檢查沒過的失敗也要講得出原因**（那種不會寫 journal）', t => {
  // 重複檔的「留存者」被一起選進 plan、或檔案在建 plan 之後被改掉，
  // 都會在寫 journal **之前**就被擋下 —— markFailure 只寫 file_items.error。
  // 只查 journal 的話，這種最常見的失敗印出來是一句「沒有搬動」。
  const f = fixture(t)
  const p = createPlan(f.db)
  writeFileSync(join(f.downloads, 'a.zip'), '內容被改掉了')   // 指紋對不上
  const r = spawnSync(process.execPath, [join(REPO, 'cli.mjs'), 'cleanup', 'apply', p.id], {
    encoding: 'utf8',
    env: { ...process.env, HOME: f.dir, USERPROFILE: f.dir, CONTEXTBOX_CONFIG: (() => {
      const cfg = join(f.dir, 'config.json')
      writeFileSync(cfg, JSON.stringify({
        watch: f.opts.roots, cleanup: { roots: f.opts.roots }, filed: join(f.dir, 'Filed'),
        model: { baseUrl: '', name: '', keyEnv: 'CONTEXTBOX_MODEL_KEY' },
        readonly: false, pdfPages: 3, maxBytes: f.opts.maxBytes,
      }))
      return cfg
    })(), CONTEXTBOX_DB: f.dbPath, CONTEXTBOX_QUARANTINE: f.opts.quarantine },
  })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  assert.match(out, /✘ a\.zip/, out)
  assert.doesNotMatch(out, /原因不明/, `沒講出原因：\n${out}`)
  assert.match(out, /變更|下載/, '要說得出是「檔案變了」')
})

test('undo 只列真的放回去的，數字跟行數要對得上', t => {
  const f = fixture(t, { 'a.zip': 'aaa', 'b.zip': 'bbb', 'c.zip': 'ccc' })
  const p = createPlan(f.db)
  rmSync(join(f.downloads, 'a.zip'))       // a 搬不成
  applyPlan(f.db, p.id, f.opts)
  const cfg = join(f.dir, 'config.json')
  writeFileSync(cfg, JSON.stringify({
    watch: f.opts.roots, cleanup: { roots: f.opts.roots }, filed: join(f.dir, 'Filed'),
    model: { baseUrl: '', name: '', keyEnv: 'CONTEXTBOX_MODEL_KEY' },
    readonly: false, pdfPages: 3, maxBytes: f.opts.maxBytes,
  }))
  const r = spawnSync(process.execPath, [join(REPO, 'cli.mjs'), 'cleanup', 'undo', p.id], {
    encoding: 'utf8',
    env: { ...process.env, HOME: f.dir, USERPROFILE: f.dir, CONTEXTBOX_CONFIG: cfg, CONTEXTBOX_DB: f.dbPath,
           CONTEXTBOX_QUARANTINE: f.opts.quarantine },
  })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  // 第三波起不寫資料夾名：放回的可能是舊版搬走的桌面檔（C4），不一定在 Downloads
  const n = Number(/放回原位 (\d+) 個/.exec(out)?.[1])
  const lines = (out.match(/↩/g) ?? []).length
  assert.equal(lines, n, `說放回去 ${n} 個，卻列了 ${lines} 行：\n${out}`)
  assert.doesNotMatch(out, /↩ a\.zip/, 'a.zip 根本沒被搬走，不可以說它被放回去了')
})

describe('剛動過的檔不搬 —— 但要說實話', () => {
  test('**什麼都沒改的新檔不可以被說成「已變更」**', t => {
    // 一個剛 cp 出來的重複檔會撞到十分鐘的靜置窗。
    // 訊息如果是「檔案已變更，請重新掃描」，那是在說謊：什麼都沒變，
    // 而且使用者照做（重新掃描）也沒用 —— 重掃之後它還是一樣新。
    const f = fixture(t, {})
    writeFileSync(join(f.downloads, '報告.pdf'), 'SMOKE 報告')
    writeFileSync(join(f.downloads, '報告 (1).pdf'), 'SMOKE 報告')

    // 掃描時刻明確放到檔案 mtime 之後，避免檔案系統的次毫秒 mtime
    // 比 Date.now() 稍晚，造成 minStableMs: 0 仍被誤判為 recent。
    scanDownloads({
      db: f.db,
      ...f.opts,
      minStableMs: 0,
      now: new Date(Date.now() + 1000),
    })

    const p = createPlan(f.db)
    const r = call(f, 'POST', `/cleanup/plans/${p.id}/apply`, {})

    assert.equal(r.code, 200, '逐項失敗不是路由錯誤')
    assert.equal(r.body.quarantinedCount, 0)

    const why = f.db
      .prepare('SELECT error FROM file_items WHERE error IS NOT NULL')
      .get().error

    assert.doesNotMatch(
      why,
      /已變更/,
      `什麼都沒改卻說已變更：${why}`
    )

    assert.match(
      why,
      /十分鐘|等一下/,
      `要說得出真正的原因與該怎麼辦：${why}`
    )
  })

  test('撥回兩小時之後就搬得動 —— 確認擋的只是「太新」', t => {
    const f = fixture(t, {})
    for (const n of ['報告.pdf', '報告 (1).pdf']) {
      writeFileSync(join(f.downloads, n), 'SMOKE 報告')
      const old = (Date.now() - 2 * 3600_000) / 1000
      utimesSync(join(f.downloads, n), old, old)
    }
    f.scan()
    const p = createPlan(f.db)
    const r = call(f, 'POST', `/cleanup/plans/${p.id}/apply`, {})
    assert.equal(r.body.status, 'applied', JSON.stringify(r.body))
    assert.equal(r.body.quarantinedCount, 1, '重複的那一份要被搬走')
    assert.ok(existsSync(join(f.downloads, '報告 (1).pdf'))
           || existsSync(join(f.downloads, '報告.pdf')), '**一定要留下一份**')
  })

  test('TOO_FRESH 對到 409 —— 等一下重試會成功，不是 500', () => {
    assert.equal(statusFor('TOO_FRESH'), 409)
  })

  test('smoke 文件裡每個垃圾檔都要往回撥時間', () => {
    // 十分鐘的靜置窗會讓任何剛建立的檔搬不動。
    // 文件漏了 touch 的話，照著做的人會在第 3 步撞牆，而且錯不在程式。
    const md = readFileSync(join(REPO, 'test/smoke-cleanup.md'), 'utf8')
    const bash = /```bash\ncd ~\/Downloads\n([\s\S]*?)```/.exec(md)?.[1] ?? ''
    assert.ok(bash, '找不到 smoke 的建檔區塊')
    // 抓出每個被建立的垃圾檔（smoke-* 與截圖），確認後面有 touch
    const created = [...bash.matchAll(/^(?:printf|:)[^>]*>\s*'?([^\s']+(?:\s[^']*)?)'?$/gm)]
      .map(m => m[1].trim()).filter(n => n.startsWith('smoke-') || n.startsWith('Screenshot'))
    const touched = bash.slice(0, bash.indexOf('### 順便放三個'))
    for (const name of created) {
      // 那三個「不可以被碰」的本來就該是新的，不在這個區塊裡
      assert.ok(touched.includes(`touch -d`) && new RegExp(`touch -d[^\\n]*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(touched),
        `${name} 沒有 touch -d，照著做會搬不動`)
    }
  })
})

describe('獨立重推抓到的（CLI）', () => {
  const runCli = (f, args, env = {}, maxBytes = f.opts.maxBytes) => {
    const cfg = join(f.dir, 'config.json')
    writeFileSync(cfg, JSON.stringify({
      watch: f.opts.roots, cleanup: { roots: f.opts.roots }, filed: join(f.dir, 'Filed'),
      model: { baseUrl: '', name: '', keyEnv: 'CONTEXTBOX_MODEL_KEY' },
      readonly: false, pdfPages: 3, maxBytes,
    }))
    const r = spawnSync(process.execPath, [join(REPO, 'cli.mjs'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: f.dir, USERPROFILE: f.dir, CONTEXTBOX_CONFIG: cfg, CONTEXTBOX_DB: f.dbPath,
             CONTEXTBOX_QUARANTINE: f.opts.quarantine, ...env },
    })
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
  }

  test('**CLI 的 cleanup apply 只清 cleanup list 上打 ✔ 的**', t => {
    const f = fixture(t, { 'a.zip': 'aaa', 'big.zip': 'x'.repeat(2 * 1024 * 1024) })
    f.db.prepare(`UPDATE file_items SET sha256=NULL WHERE name='big.zip'`).run()   // 太大、沒有指紋 → 否決
    // **上限要調大**：掃描時的上限小（所以沒有指紋、被否決），但現在的上限夠大 ——
    // 使用者調大設定是合法操作。上限沒調大的話，它會被收進計畫、只是搬移時因為
    // 太大而失敗，測試就會因為錯的理由通過（第一版就是這樣）。
    const r = runCli(f, ['cleanup', 'apply'], {}, 50 * 1024 * 1024)
    assert.ok(existsSync(join(f.downloads, 'big.zip')), `清單上是 ☐ 的 big.zip 被搬走了：\n${r.out}`)
    assert.ok(!existsSync(join(f.downloads, 'a.zip')))
  })

  test('唯讀模式帶 plan id，要講得出那份計畫有幾個', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    const r = runCli(f, ['cleanup', 'apply', p.id], { CONTEXTBOX_READONLY: '1' })
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /會清掉 2 個/, `印成：\n${r.out}`)
  })

  test('復原訊息不可以說「之後不會再被提議」—— 那不一定是真的', t => {
    const f = fixture(t)
    const p = createPlan(f.db)
    applyPlan(f.db, p.id, f.opts)
    writeFileSync(join(f.downloads, 'a.zip'), '後來又下載了一個同名的')
    const r = runCli(f, ['cleanup', 'undo', p.id])
    assert.doesNotMatch(r.out, /不會再被提議/, '放回來的那份改名後會以重複檔的身分再被提議')
    assert.match(r.out, /a\.zip\.restored/, '改了名要講出來')
  })
})
