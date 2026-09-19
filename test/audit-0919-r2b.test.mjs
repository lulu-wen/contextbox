import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * 2026-09-19 稽核第二輪第二階段之後的收尾：驗證員留下的四條 minor／nit。
 *
 * ── Step 1（build-round）──────────────────────────────────────────
 *
 * | 段落 | 可能的錯 | 另一種解讀 | 成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | 已經開始復原的計畫 | 跟「搬到一半」一樣給「繼續」 | 只給「接著放回」 | 有 restore 紀錄／只有 quarantine 紀錄 | restoring true、提示不講「繼續」／照舊兩條路 |
 * | 面板按「繼續」 | 送出去讓後端回 409 | 面板自己擋 | restoring 的那份／一般中斷的那份 | 不送、講出口／照送 |
 * | doctor 的中斷計畫 | 一律說「0 個已經在隔離區」 | 沒搬走就照實說 | 只有 skip 紀錄／有檔在隔離區 | 「一個檔都還沒搬走」／「N 個已經在隔離區」 |
 * | 每個指令前的收尾 | 一律拿清理鎖 | 沒事就不要拿 | 乾淨的資料庫／有一列停在 started | 不碰鎖／會去拿（拿不到就警告） |
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { applyPlan } from '../core/cleanup-exec.ts'
import { blockingPlanFor, listPlans, withOutcomes } from '../core/cleanup-routes.ts'
import { getPlan } from '../core/cleanup-plans.ts'
import { pendingPlanMessage, createReal } from '../core/assets/cleanup-real-state.js'
import { fixture } from './helpers/cleanup.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs')
assert.ok(FAKE_HOME, '前提：測試行程的家目錄已經換掉')

/**
 * 一份「復原做到一半中斷」的計畫：套用完之後，手動寫一列停在 started 的 restore 紀錄
 * （就是 undo 跑到一半被殺的樣子），計畫退回 proposed —— 這時 apply 一定回 409。
 */
function restoreInterrupted(t) {
  const f = fixture(t)
  const p = f.plan()
  applyPlan(f.db, p.id, f.opts)
  const q = f.db.prepare(
    `SELECT seq, item_id, from_path, to_path FROM cleanup_journal WHERE plan_id=? AND op='quarantine' LIMIT 1`
  ).get(p.id)
  f.db.prepare(`INSERT INTO cleanup_journal (ts, plan_id, item_id, op, from_path, to_path, sha256, status)
                VALUES (?,?,?,'restore',?,?,NULL,'started')`)
    .run(new Date().toISOString(), p.id, q.item_id, q.to_path, q.from_path)
  f.db.prepare(`UPDATE cleanup_plans SET status='proposed' WHERE id=?`).run(p.id)
  return { ...f, planId: p.id }
}

describe('已經開始復原的計畫：出口只有「接著放回」', () => {
  test('核心：計畫 DTO、擋住的那份、待處理清單都帶 restoring', t => {
    const s = restoreInterrupted(t)
    assert.equal(withOutcomes(s.db, getPlan(s.db, s.planId)).restoring, true)
    const ids = s.db.prepare(
      `SELECT c.id FROM cleanup_candidates c JOIN cleanup_plan_items pi ON pi.candidate_id = c.id WHERE pi.plan_id=?`
    ).all(s.planId).map(r => r.id)
    const b = blockingPlanFor(s.db, ids)
    assert.deepEqual({ started: b.started, restoring: b.restoring }, { started: true, restoring: true })
    assert.equal(listPlans(s.db, { filter: 'pending' }).operations[0].restoring, true)
  })

  test('對照：只搬到一半、沒開始復原的那份，restoring 是 false', t => {
    const f = fixture(t)
    const p = f.plan()
    applyPlan(f.db, p.id, f.opts)
    f.db.prepare(`UPDATE cleanup_plans SET status='proposed' WHERE id=?`).run(p.id)
    assert.equal(withOutcomes(f.db, getPlan(f.db, p.id)).restoring, false)
  })

  test('面板的提示：restoring 不講「繼續上次那份」，講「接著放回」', () => {
    const items = [{ itemId: 'i1', name: 'a.zip', bytes: 1 }]
    const on = pendingPlanMessage({ id: 'p1', items, started: true, restoring: true })
    assert.match(on, /復原做到一半中斷/)
    assert.match(on, /放回已經搬走的/)
    assert.doesNotMatch(on, /繼續上次那份/)
    const off = pendingPlanMessage({ id: 'p1', items, started: true, restoring: false, moved: 1, unsure: 0 })
    assert.match(off, /繼續上次那份/)
  })

  test('面板按「繼續」：restoring 的那份自己擋下來，一個 POST 都不送', async () => {
    let posts = 0
    const api = async (path, init) => {
      if (init?.method === 'POST') { posts++; throw Object.assign(new Error('不該送'), { status: 409 }) }
      if (path.startsWith('/cleanup/plans/')) {
        return { id: 'p1', status: 'proposed', restoring: true, items: [{ itemId: 'i1', name: 'a.zip', bytes: 1, outcome: 'moved', why: null }] }
      }
      if (path.startsWith('/cleanup/plans?')) return { total: 1, operations: [{ id: 'p1' }] }
      return { candidates: [], needsHuman: [], total: 0, totalAvailable: 0, truncated: false, defaultCheckedCount: 0 }
    }
    const real = createReal(api)
    const pending = await real.checkPending()
    assert.equal(pending.restoring, true)
    await assert.rejects(real.apply(), /已經開始復原/)
    assert.equal(posts, 0, '不可以送出一定會 409 的 apply')
  })
})

describe('CLI：doctor 與 CONFLICT 的說法', () => {
  function sandbox(t, { files = { 'a.zip': 'archive a' } } = {}) {
    const f = fixture(t, files)
    const cfg = join(f.dir, 'config.json')
    writeFileSync(cfg, JSON.stringify({
      watch: [f.downloads], filed: join(f.dir, 'Filed'),
      model: { baseUrl: '', name: '', keyEnv: 'CONTEXTBOX_MODEL_KEY' },
      readonly: false, pdfPages: 3, maxBytes: 20971520, cleanup: { roots: [f.downloads] },
    }))
    const env = {
      ...process.env, HOME: f.dir, USERPROFILE: f.dir, CONTEXTBOX_PORT: '0',
      CONTEXTBOX_CONFIG: cfg, CONTEXTBOX_DB: f.dbPath,
      CONTEXTBOX_QUARANTINE: f.opts.quarantine, CONTEXTBOX_TOKEN_PATH: join(f.dir, 'token'),
    }
    const run = (...args) => {
      const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 60_000 })
      return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
    }
    return { ...f, run }
  }

  test('已經開始復原的計畫：doctor 只給「接著放回」，不叫人 apply', t => {
    const s = sandbox(t)
    const p = s.plan()
    applyPlan(s.db, p.id, s.opts)
    const q = s.db.prepare(`SELECT item_id, from_path, to_path FROM cleanup_journal WHERE plan_id=? AND op='quarantine' LIMIT 1`).get(p.id)
    s.db.prepare(`INSERT INTO cleanup_journal (ts, plan_id, item_id, op, from_path, to_path, sha256, status)
                  VALUES (?,?,?,'restore',?,?,NULL,'started')`)
      .run(new Date().toISOString(), p.id, q.item_id, q.to_path, q.from_path)
    s.db.prepare(`UPDATE cleanup_plans SET status='proposed' WHERE id=?`).run(p.id)
    const r = s.run('doctor')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /它開始復原了，只能接著放回/)
    assert.doesNotMatch(r.out, /把它做完/)
  })

  test('撞到已經開始復原的那份：預設清理的 CONFLICT 也只給「接著放回」', t => {
    const s = sandbox(t, { files: { 'a.zip': 'archive a', 'b.zip': 'archive b' } })
    const p = s.plan()
    applyPlan(s.db, p.id, s.opts)
    const q = s.db.prepare(`SELECT item_id, from_path, to_path FROM cleanup_journal WHERE plan_id=? AND op='quarantine' LIMIT 1`).get(p.id)
    s.db.prepare(`INSERT INTO cleanup_journal (ts, plan_id, item_id, op, from_path, to_path, sha256, status)
                  VALUES (?,?,?,'restore',?,?,NULL,'started')`)
      .run(new Date().toISOString(), p.id, q.item_id, q.to_path, q.from_path)
    s.db.prepare(`UPDATE cleanup_plans SET status='proposed' WHERE id=?`).run(p.id)
    // 復原其實已經做完、只是 journal 停在 started：檔案回到原位，候選又出現在清單上
    for (const j of s.db.prepare(`SELECT from_path, to_path, item_id FROM cleanup_journal WHERE plan_id=? AND op='quarantine'`).all(p.id)) {
      if (existsSync(j.to_path) && !existsSync(j.from_path)) renameSync(j.to_path, j.from_path)
      s.db.prepare(`UPDATE file_items SET status='candidate' WHERE id=?`).run(j.item_id)
      s.db.prepare(`UPDATE cleanup_candidates SET status='proposed' WHERE item_id=?`).run(j.item_id)
    }
    // 那些檔還被這份佔著 → 預設清理會撞 CONFLICT，離開碼 1
    const r = s.run('cleanup', 'apply')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /它已經開始復原了/)
    assert.match(r.out, /cleanup undo/)
    assert.doesNotMatch(r.out, /把它做完/)
  })

  test('一個檔都沒搬走的中斷計畫：doctor 照實說，不說「0 個已經在隔離區」', t => {
    const s = sandbox(t, { files: { 'a.zip': 'archive a', 'b.zip': 'archive b' } })
    const p = s.plan()
    // 只有一列 skip（帶 skippedIds 套用、還沒碰到任何一個檔就中斷）：核心算「開始過」，但沒有檔被搬走
    const item = s.db.prepare(`SELECT c.item_id FROM cleanup_candidates c
      JOIN cleanup_plan_items pi ON pi.candidate_id = c.id WHERE pi.plan_id=? LIMIT 1`).get(p.id)
    s.db.prepare(`INSERT INTO cleanup_journal (ts, plan_id, item_id, op, from_path, to_path, sha256, status)
                  VALUES (?,?,?,'skip',NULL,NULL,NULL,'done')`)
      .run(new Date().toISOString(), p.id, item.item_id)
    const r = s.run('doctor')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /一個檔都還沒搬走/)
    assert.doesNotMatch(r.out, /0 個已經在隔離區/)
  })

  test('沒事就不要拿清理鎖：乾淨的資料庫跑 list 不碰鎖，有一列停在 started 才會去拿', t => {
    const s = sandbox(t)
    const p = s.plan()              // 順便把清理的表建出來（鎖的表是懶建的）
    // 拿鎖會寫 cleanup_operation_lock。用 trigger 讓寫入直接失敗，就看得出有沒有去拿。
    const block = () => s.db.exec(`CREATE TRIGGER no_lock BEFORE INSERT ON cleanup_operation_lock
                                   BEGIN SELECT RAISE(ABORT, '不准拿鎖'); END`)
    const unblock = () => s.db.exec('DROP TRIGGER no_lock')
    s.db.exec('DELETE FROM cleanup_operation_lock')
    block()
    const clean = s.run('cleanup', 'list')
    unblock()
    assert.equal(clean.code, 0, clean.out)
    assert.doesNotMatch(clean.out, /收尾上次中斷的清理時出錯/, '沒事的時候不可以去拿鎖')

    applyPlan(s.db, p.id, s.opts)
    s.db.prepare(`UPDATE cleanup_journal SET status='started' WHERE plan_id=?`).run(p.id)
    s.db.exec('DELETE FROM cleanup_operation_lock')
    block()
    const dirty = s.run('cleanup', 'list')
    unblock()
    assert.equal(dirty.code, 0, dirty.out)
    assert.match(dirty.out, /收尾上次中斷的清理時出錯/, '有東西要收尾就要去拿鎖')
  })
})
