import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * 2026-09-19 稽核第三波的收尾：套用中斷在 rename 之前，之後按復原。
 *
 * 第三波 CLI 的驗證員照原本的重現（300 個檔，隔離區有 20 個時按 Ctrl+C）做了 7 次，
 * 7 次都剛好中斷在「預留好隔離區的空檔、還沒 rename」：journal 有一列停在 started，
 * 檔案其實還在 Downloads。以前 undoPlan 確認檔案在原位之後直接 continue，那一列永遠是
 * started，於是：
 * - 逐項結果永遠是 unknown（「狀態不明，再套用一次會接完」）—— 再套用什麼都不做
 * - CLI 的 undo 回 3、說有 1 個沒放回；面板說「還不確定放回了沒有」
 * - 隔離區預留的空檔被當成孤兒，doctor 永遠報「另有 1 個來路不明的檔」
 *
 * ── Step 1（build-round）──────────────────────────────────────────
 *
 * | 段落 | 可能的錯 | 另一種解讀 | 成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | undo 碰到 started、檔在原位 | 跳過，不動 journal | 結掉那一列 | 檔在原位／檔在隔離區（rename 完沒寫 done） | 結成 reverted、逐項 failed「還在原位，沒有搬」／照常放回、restored |
 * | CLI 離開碼 | 沒結的算「沒放回」回 3 | 本來就在原位不算 | 一個放回＋一個沒搬過／一個放回＋一個隔離區檔被改過 | 0／3 |
 * | 孤兒 | 隔離區多一個檔就是孤兒 | 中斷留下的是自己的 | 預留的空檔／手動丟進去的檔 | 不算／算 |
 * | 面板 | 復原前 unknown、復原後不是 restored 就算「沒放回」 | 沒搬過不列 | 復原後 failed／復原後還是 moved | 兩邊都不列／列成沒放回 |
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { applyPlan, undoPlan, NOT_MOVED } from '../core/cleanup-exec.ts'
import { planOutcomes, healthSnapshot as health0, invalidateQuarantineCache } from '../core/cleanup-routes.ts'
import { createRealHistory, historyUndoMessage, safeName } from '../core/assets/cleanup-real-state.js'
import { fixture } from './helpers/cleanup.mjs'

// 孤兒對帳的磁碟計數有十秒快取（route 搬完檔會清掉它）；這裡直接呼叫 exec，要自己清
const healthSnapshot = (db, opts) => { invalidateQuarantineCache(); return health0(db, opts) }

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs')
assert.ok(FAKE_HOME, '前提：測試行程的家目錄已經換掉')

/**
 * a.zip、b.zip 一份計畫，全部套用；再把 b 做成「中斷在 rename 之前」：
 * 檔案搬回原位、隔離區留一個預留的空檔、journal 那一列改回 started、計畫改回 proposed。
 * 這正是 performMove 在 reserveDestination 之後、renameSync 之前被殺掉會留下的樣子。
 */
function interrupted(t) {
  const f = fixture(t)
  const p = f.plan()
  applyPlan(f.db, p.id, f.opts)
  const b = f.db.prepare(
    `SELECT j.seq, j.item_id, j.from_path, j.to_path FROM cleanup_journal j
       JOIN file_items i ON i.id = j.item_id
      WHERE j.plan_id=? AND j.op='quarantine' AND i.name='b.zip'`
  ).get(p.id)
  renameSync(b.to_path, b.from_path)
  writeFileSync(b.to_path, '')
  f.db.prepare(`UPDATE cleanup_journal SET status='started' WHERE seq=?`).run(b.seq)
  f.db.prepare('UPDATE cleanup_move_details SET completed_at=NULL WHERE seq=?').run(b.seq)
  f.db.prepare(`UPDATE file_items SET status='candidate' WHERE id=?`).run(b.item_id)
  f.db.prepare(`UPDATE cleanup_candidates SET status='proposed' WHERE item_id=?`).run(b.item_id)
  f.db.prepare(`UPDATE cleanup_plans SET status='proposed' WHERE id=?`).run(p.id)
  const name = id => f.db.prepare('SELECT name FROM file_items WHERE id=?').get(id).name
  const outcomes = () => Object.fromEntries([...planOutcomes(f.db, p.id)].map(([id, o]) => [name(id), o]))
  return { ...f, planId: p.id, b, outcomes }
}

describe('套用中斷在 rename 之前，之後按復原', () => {
  test('前提：復原前 b 是「狀態不明」', t => {
    const s = interrupted(t)
    assert.equal(s.outcomes()['a.zip'].outcome, 'moved')
    assert.equal(s.outcomes()['b.zip'].outcome, 'unknown')
  })

  test('復原：a 放回；b 那一列結成 reverted，逐項是「還在原位，沒有搬」；計畫是 restored', t => {
    const s = interrupted(t)
    const r = undoPlan(s.db, s.planId, s.opts)
    assert.equal(r.status, 'restored')
    const o = s.outcomes()
    assert.equal(o['a.zip'].outcome, 'restored')
    assert.deepEqual({ outcome: o['b.zip'].outcome, why: o['b.zip'].why }, { outcome: 'failed', why: NOT_MOVED })
    const row = s.db.prepare('SELECT status FROM cleanup_journal WHERE seq=?').get(s.b.seq)
    assert.equal(row.status, 'reverted')
    assert.ok(existsSync(s.b.from_path), 'b 還在原位')
    // 再按一次復原：冪等，不會把結掉的那一列又弄回來
    undoPlan(s.db, s.planId, s.opts)
    assert.equal(s.outcomes()['b.zip'].outcome, 'failed')
  })

  test('對照：檔案其實在隔離區（rename 完、沒寫 done）→ 照常放回，不可以被結成 reverted', t => {
    const s = interrupted(t)
    // 把 b 放到隔離區（蓋掉預留的空檔），模擬 rename 已經做完
    renameSync(s.b.from_path, s.b.to_path)
    undoPlan(s.db, s.planId, s.opts)
    assert.equal(s.outcomes()['b.zip'].outcome, 'restored')
    assert.ok(existsSync(s.b.from_path))
  })

  test('孤兒：預留的空檔不算；手動丟進隔離區的檔照算', t => {
    const s = interrupted(t)
    const h0 = healthSnapshot(s.db, { roots: s.opts.roots, quarantine: s.opts.quarantine })
    assert.equal(h0.quarantine.orphans, 0, '復原前：started 那一列的空檔是自己的')
    undoPlan(s.db, s.planId, s.opts)
    const h1 = healthSnapshot(s.db, { roots: s.opts.roots, quarantine: s.opts.quarantine })
    assert.equal(h1.quarantine.orphans, 0, '復原後：reverted 那一列的空檔也是自己的')
    mkdirSync(join(s.opts.quarantine, '手動'), { recursive: true })
    writeFileSync(join(s.opts.quarantine, '手動', '來路不明.bin'), 'x')
    const h2 = healthSnapshot(s.db, { roots: s.opts.roots, quarantine: s.opts.quarantine })
    assert.equal(h2.quarantine.orphans, 1)
  })

  describe('CLI 的 cleanup undo', () => {
    function cli(t, s) {
      const cfg = join(s.dir, 'config.json')
      writeFileSync(cfg, JSON.stringify({
        watch: [s.downloads], filed: join(s.dir, 'Filed'),
        model: { baseUrl: '', name: '', keyEnv: 'CONTEXTBOX_MODEL_KEY' },
        readonly: false, pdfPages: 3, maxBytes: 20971520, cleanup: { roots: [s.downloads] },
      }))
      const env = {
        ...process.env, HOME: s.dir, USERPROFILE: s.dir,
        CONTEXTBOX_CONFIG: cfg, CONTEXTBOX_DB: s.dbPath,
        CONTEXTBOX_QUARANTINE: s.opts.quarantine, CONTEXTBOX_TOKEN_PATH: join(s.dir, 'token'),
      }
      return args => {
        const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 60_000 })
        return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
      }
    }

    test('一個放回＋一個沒搬過 → 回 0，沒搬過的印「當初就沒有搬走」，沒有「狀態不明」', t => {
      const s = interrupted(t)
      const r = cli(t, s)(['cleanup', 'undo', s.planId])
      assert.equal(r.code, 0, r.out)
      assert.match(r.out, /Put 1 file back/)
      assert.match(r.out, /b\.zip.*never moved in the first place/)
      assert.doesNotMatch(r.out, /state unknown|not put back/)
      assert.equal(healthSnapshot(s.db, { roots: s.opts.roots, quarantine: s.opts.quarantine }).quarantine.orphans, 0)
    })

    test('對照：一個放回＋一個隔離區的檔被改過 → 回 3', t => {
      const s = interrupted(t)
      const a = s.db.prepare(
        `SELECT j.to_path FROM cleanup_journal j JOIN file_items i ON i.id=j.item_id
          WHERE j.plan_id=? AND j.op='quarantine' AND i.name='a.zip'`
      ).get(s.planId)
      chmodSync(a.to_path, 0o644)
      writeFileSync(a.to_path, 'tampered')
      const r = cli(t, s)(['cleanup', 'undo', s.planId])
      assert.equal(r.code, 3, r.out)
    })
  })
})

describe('面板的歷史復原：搬到一半中斷、其實沒搬過的，不算「沒放回」', () => {
  /** 假的 api：GET 計畫回 before，POST undo 回 after */
  const fakeApi = (before, after) => async (path, init) => {
    if (init?.method === 'POST') return after
    if (path.startsWith('/cleanup/plans/')) return before
    throw new Error('沒有預期的呼叫：' + path)
  }
  const item = (itemId, name, outcome, why = null) => ({ itemId, name, bytes: 1, outcome, why })

  test('復原前 b 是 unknown、復原後是 failed（沒搬過）→ 只講 a 放回，b 不列', async () => {
    const h = createRealHistory(fakeApi(
      { id: 'p1', items: [item('a', 'a.zip', 'moved'), item('b', 'b.zip', 'unknown')] },
      { id: 'p1', items: [item('a', 'a.zip', 'restored'), item('b', 'b.zip', 'failed', NOT_MOVED)] },
    ))
    const r = await h('undo', { operationIds: ['p1'] })
    assert.equal(r.restoredFiles, 1)
    assert.deepEqual(r.notRestored, [])
    assert.deepEqual(r.unconfirmed, [])
  })

  test('對照：復原前 a 是 moved、復原後還是 moved → 列成沒放回', async () => {
    const h = createRealHistory(fakeApi(
      { id: 'p1', items: [item('a', 'a.zip', 'moved')] },
      { id: 'p1', items: [item('a', 'a.zip', 'moved', '隔離區檔案已變更，無法安全復原。')] },
    ))
    const r = await h('undo', { operationIds: ['p1'] })
    assert.deepEqual(r.notRestored.map(x => x.name), ['a.zip'])
  })

  test('對照：復原前 moved、復原後變 failed／skipped → 還是列成沒放回（只有復原前 unknown 的才可以不列）', async () => {
    for (const after of ['failed', 'skipped']) {
      const h = createRealHistory(fakeApi(
        { id: 'p1', items: [item('a', 'a.zip', 'moved')] },
        { id: 'p1', items: [item('a', 'a.zip', after, 'x')] },
      ))
      const r = await h('undo', { operationIds: ['p1'] })
      assert.deepEqual(r.notRestored.map(x => x.name), ['a.zip'], after)
    }
  })

  test('只有「還不確定」加「先前已復原」：第一行不可以是「另有…」', () => {
    const { text } = historyUndoMessage({
      restored: 0, restoredFiles: 0, alreadyRestored: 1, notRestored: [], unconfirmed: [{ name: 'a.zip', why: 'w' }],
    })
    assert.doesNotMatch(text.split('\n')[0], /^Another/)
    assert.match(text, /The 1 you ticked had already been undone/)
  })
})

// ═══ 第三波之二的驗證員在範圍外發現的（已實測） ═══════════════════════

describe('cleanup.roots 裡有一個資料夾不見了（外接碟拔掉）', () => {
  // 以前 originalPath 用 roots.some(root => under(checkedPath(root), …))：排在前面的根目錄
  // 不存在時 checkedPath 丟 ENOENT，每一個檔都失敗，訊息說「檔案或資料夾不見了」—— 檔案明明在。
  test('不見的那個排在前面：Downloads 的檔照搬', t => {
    const f = fixture(t)
    const external = join(f.dir, 'External')
    const p = f.plan()
    const r = applyPlan(f.db, p.id, { ...f.opts, roots: [external, ...f.opts.roots] })
    assert.equal(r.status, 'applied')
    assert.equal(r.quarantinedCount, 2)
  })

  test('對照：清理範圍只剩不見的那個 → 一個都不搬（範圍外），不可以因為略過就放寬', t => {
    const f = fixture(t)
    const p = f.plan()
    const r = applyPlan(f.db, p.id, { ...f.opts, roots: [join(f.dir, 'External')] })
    assert.equal(r.quarantinedCount, 0)
    assert.ok(existsSync(join(f.downloads, 'a.zip')) && existsSync(join(f.downloads, 'b.zip')))
  })

  test('對照：根目錄是捷徑的照樣不算（fail closed）', t => {
    const f = fixture(t)
    const link = join(f.dir, 'DL-link')
    try { symlinkSync(f.downloads, link) } catch { t.skip('這台不能建捷徑'); return }
    const p = f.plan()
    const r = applyPlan(f.db, p.id, { ...f.opts, roots: [link] })
    assert.equal(r.quarantinedCount, 0)
  })
})

describe('還沒開始的計畫送 undo', () => {
  // 以前 undoPlan 照樣跑完、把計畫標成 restored，逐項變成「沒有搬動，原因不明」
  test('沒有任何 journal 的 proposed 計畫 → CONFLICT，計畫還是 proposed、檔案不動', t => {
    const f = fixture(t)
    const p = f.plan()
    assert.throws(() => undoPlan(f.db, p.id, f.opts), e => e.code === 'CONFLICT')
    assert.equal(f.db.prepare('SELECT status FROM cleanup_plans WHERE id=?').get(p.id).status, 'proposed')
    assert.ok(existsSync(join(f.downloads, 'a.zip')))
  })

  test('對照：做到一半中斷的 proposed 計畫（有 journal）→ 照常放回', t => {
    const s = interrupted(t)
    assert.equal(undoPlan(s.db, s.planId, s.opts).status, 'restored')
  })
})

describe('面板的 safeName 也換掉方向控制字元', () => {
  test('每一段範圍的頭尾都換成「·」，一般中文與 emoji 原樣', () => {
    for (const c of ['\u061c', '\u200e', '\u200f', '\u202a', '\u202e', '\u2066', '\u2069', '\u2028', '\u2029', '\u0007', '\u009f']) {
      assert.equal(safeName(`a${c}b`), 'a·b', JSON.stringify(c))
    }
    assert.equal(safeName('期中報告📄.pdf'), '期中報告📄.pdf')
    assert.equal(safeName('invoice\u202efdp.exe'), 'invoice·fdp.exe')
  })
})
