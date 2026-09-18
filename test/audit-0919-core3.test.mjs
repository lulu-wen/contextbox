import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * 2026-09-19 稽核第三波（core 小修 K1–K5）：一條預期行為一個釘子。
 *
 * **期望值在修之前就寫死**（先紅，再修到綠）。覺得期望值錯了就寫進回報，不要動它。
 * 稽核紀錄沒寫死、由修法推出來的，測試名稱標「（推論）」。
 *
 * ── Step 1：容易錯的地方（build-round）────────────────────────────
 *
 * | 項目 | 可能的錯 | 另一種解讀 | 分辨用的成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | K1 可以清空 | 只看七天 | 復原中斷也算可以清 | 滿七天：復原停在 started／沒有復原 | false／true |
 * | K1 可以清空 | 任何 restore 列都排除 | failed 也算「還在復原」 | 滿七天：復原 failed／started | 跟清空一致：true／false（推論） |
 * | K1 可以清空 | 三個地方各算各的 | 只要自己說得通 | 同一組狀態：listQuarantine／quarantineItems／清空預覽 | 三者一致 |
 * | K2 保留者 | 整段拿掉 originalPath 的檢查 | 保留者不搬，放哪都行 | Downloads/desktop.ini／Downloads/.ssh/x | 可以當保留者／不可以 |
 * | K2 保留者 | 只擋 . 開頭的資料夾 | 金鑰資料夾不算 | Downloads/credentials/x、Downloads/Tokens/x | 不可以當保留者 |
 * | K3 家目錄 | 只換清理根目錄 | 家目錄不是根目錄就不管 | 家目錄底下的 Desktop 路徑／根目錄底下的路徑 | ~/Desktop/…／Downloads/… |
 * | K4 註解 | 說是 recordItemErrors 寫的 | route 在套用後補記 | db.ts 的註解 | 指名 applyPlan 的 markFailure |
 * | K5 重複檔 | skipStaleDuplicates 看全庫 | 過時的就該作廢 | roots 換成 Desktop 掃／Downloads 掃 | Downloads 的候選不動／照常判斷 |
 * | K5 重複檔 | 用 resolve(root) 比前綴 | 原樣就夠 | 根目錄是捷徑（/var → /private/var 同一回事） | 不再是重複檔的照樣改 skipped |
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { open } from '../core/db.ts'
import * as scanner from '../core/cleanup-scanner.ts'
import * as exec from '../core/cleanup-exec.ts'
import * as plans from '../core/cleanup-plans.ts'
import * as quarantine from '../core/cleanup-quarantine.ts'
import * as routes from '../core/cleanup-routes.ts'
import { CLEANUP_RULE_VERSION } from '../core/cleanup-rules.ts'
import { fixture } from './helpers/cleanup.mjs'

const DAY = 86400_000
const MIN = 60_000

function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-core3-')))
  const dl = join(dir, 'Downloads')
  const desk = join(dir, 'Desktop')
  mkdirSync(dl)
  mkdirSync(desk)
  const db = open(join(dir, 'data.db'))
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  const put = (root, rel, content, days = 20) => {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
    const at = new Date(Date.now() - days * DAY)
    utimesSync(p, at, at)
    return p
  }
  const opts = { roots: [dl], quarantine: join(dir, 'quarantine'), maxBytes: 1024 * 1024 }
  const scan = roots => scanner.scanDownloads({ db, roots, maxBytes: opts.maxBytes })
  /** 某個檔上的 duplicate 候選狀態（沒有就是 undefined） */
  const dupStatus = path => db.prepare(
    `SELECT c.status FROM cleanup_candidates c JOIN file_items i ON i.id=c.item_id
     WHERE i.path=? AND c.kind='duplicate' AND c.rule_version=?`
  ).get(realpathSync(path), CLEANUP_RULE_VERSION)?.status
  const itemStatus = path => db.prepare('SELECT status FROM file_items WHERE path=?').get(realpathSync(path))?.status
  return { dir, dl, desk, db, opts, put, scan, dupStatus, itemStatus }
}

// ═══ K1 ・ listQuarantine 的 canEmptyNow 跟清空一致 ═══════════════════

describe('K1 exec.listQuarantine 的 canEmptyNow：復原到一半中斷的不算', () => {
  /**
   * 八個檔、一份計畫、全部套用。每一個檔各給一種狀態：
   * 復原（沒有／停在 started／failed／done）× 隔離完成（七天多一分鐘前／七天少一分鐘前）。
   * journal 的 restore 列直接寫進去 —— 這裡要的是「清單怎麼讀這些狀態」，不是復原本身。
   */
  function grid(t) {
    const restores = [null, 'started', 'failed', 'done']
    const ages = [7 * DAY + MIN, 7 * DAY - MIN]
    const cells = restores.flatMap(r => ages.map(a => ({ restore: r, age: a })))
    const files = Object.fromEntries(cells.map((_, i) => [`f${i}.zip`, `content ${i}`]))
    const f = fixture(t, files)
    const p = plans.createPlan(f.db)
    assert.equal(exec.applyPlan(f.db, p.id, f.opts).status, 'applied')
    const snaps = plans.planSnapshots(f.db, p.id)
    for (const [i, c] of cells.entries()) {
      const item = snaps.find(s => s.name === `f${i}.zip`)
      const q = f.db.prepare(`SELECT * FROM cleanup_journal WHERE plan_id=? AND item_id=? AND op='quarantine'`).get(p.id, item.id)
      f.db.prepare('UPDATE cleanup_move_details SET completed_at=? WHERE seq=?')
        .run(new Date(Date.now() - c.age).toISOString(), q.seq)
      if (c.restore) {
        f.db.prepare(`INSERT INTO cleanup_journal(ts,plan_id,item_id,op,from_path,to_path,sha256,status)
          VALUES (?,?,?,'restore',?,?,?,?)`).run(new Date().toISOString(), p.id, item.id, q.to_path, q.from_path, q.sha256, c.restore)
      }
      Object.assign(c, { name: item.name, seq: q.seq })
    }
    return { ...f, p, cells }
  }

  test('滿七天、復原停在 started → false；滿七天、沒有復原 → true（邊界的另一側）', t => {
    const g = grid(t)
    const list = exec.listQuarantine(g.db)
    const at = (restore, old) => list.find(r => r.name === g.cells.find(c => c.restore === restore && (c.age > 7 * DAY) === old).name)
    assert.equal(at('started', true).canEmptyNow, false, '復原到一半中斷的，清空不會刪，不可以說現在可以清')
    assert.equal(at(null, true).canEmptyNow, true)
    assert.equal(at('started', false).canEmptyNow, false)
    assert.equal(at(null, false).canEmptyNow, false)
    // 復原中斷的還在隔離區：照列、canEmptyAt 照算（跟 quarantineItems 一樣）
    assert.ok(at('started', true).canEmptyAt)
  })

  test('（推論）滿七天、復原 failed → true：清空只跳過 started，說法要跟它一致', t => {
    const g = grid(t)
    const list = exec.listQuarantine(g.db)
    const failedOld = list.find(r => r.name === g.cells.find(c => c.restore === 'failed' && c.age > 7 * DAY).name)
    assert.equal(failedOld.canEmptyNow, true)
  })

  test('三個地方一致：listQuarantine 與 quarantineItems 逐項相同；canEmptyNow ⇔ 在清空預覽裡', t => {
    const g = grid(t)
    const fromExec = exec.listQuarantine(g.db)
    const fromRoutes = routes.quarantineItems(g.db)
    assert.deepEqual(fromExec, fromRoutes)
    assert.equal(fromExec.length, 6, 'done 的兩個已經放回去，不列')
    const pre = quarantine.prepareEmptyQuarantine(g.db, g.opts)
    const entries = new Set(JSON.parse(
      g.db.prepare('SELECT entries FROM cleanup_empty_requests WHERE token=?').get(pre.token).entries))
    for (const r of fromExec) {
      assert.equal(r.canEmptyNow, entries.has(r.seq), `${r.name}：canEmptyNow=${r.canEmptyNow}，預覽${entries.has(r.seq) ? '有' : '沒有'}它`)
    }
    assert.equal(pre.itemCount, fromExec.filter(r => r.canEmptyNow).length)
  })
})

// ═══ K2 ・ 保留者只放寬檔名，不放寬資料夾 ═════════════════════════════

describe('K2 保留者可以是受保護的檔名，但不可以在隱藏資料夾或金鑰資料夾裡', () => {
  /**
   * 舊資料：Downloads/<rel> 在資料庫裡是一列 kept、比 notes.txt 早被看到（所以是保留者），
   * 磁碟上真的有一份內容相同的檔。現在的掃描器不走進 .ssh／credentials，
   * 那種列只可能是舊版留下的 —— 對帳看得到檔案還在，所以一直是「活的」。
   */
  function withKeeper(t, rel) {
    const s = sandbox(t)
    const keeper = s.put(s.dl, rel, 'same bytes')
    const mtime = new Date(Date.now() - 20 * DAY).toISOString()
    const early = new Date(Date.now() - 2 * DAY).toISOString()
    s.db.prepare(`INSERT INTO file_items (id,path,name,ext,bytes,sha256,mtime,first_seen_at,last_seen_at,status,error)
      VALUES (?,?,?,?,?,?,?,?,?,'kept',NULL)`).run(randomUUID(), realpathSync(keeper), rel.split('/').at(-1),
      '', 10, createHash('sha256').update('same bytes').digest('hex'), mtime, early, early)
    const notes = s.put(s.dl, 'notes.txt', 'same bytes')
    s.scan([s.dl])
    const c = routes.listCandidates(s.db, { roots: [s.dl] }).candidates
    assert.deepEqual(c.map(x => [x.name, x.kind]), [['notes.txt', 'duplicate']], '前提：notes.txt 被當成多出來的那份')
    const p = routes.createPlanForRoots(s.db, [s.dl], { candidateIds: c[0].candidateIds })
    return { ...s, keeper, notes, p }
  }

  test('Downloads/desktop.ini 可以當保留者：notes.txt 搬得動，desktop.ini 留著', t => {
    const s = withKeeper(t, 'desktop.ini')
    const r = exec.applyPlan(s.db, s.p.id, s.opts)
    assert.equal(r.status, 'applied', JSON.stringify([...routes.planOutcomes(s.db, s.p.id).values()]))
    assert.ok(!existsSync(s.notes))
    assert.ok(existsSync(s.keeper))
  })

  for (const rel of ['.ssh/x', 'credentials/x', 'Tokens/x', 'sub/.git/x']) {
    test(`Downloads/${rel} 不可以當保留者：notes.txt 不搬，原因是找不到會保留的那份`, t => {
      const s = withKeeper(t, rel)
      const r = exec.applyPlan(s.db, s.p.id, s.opts)
      assert.equal(r.status, 'error')
      assert.ok(existsSync(s.notes), '唯一「看得見」的一份不可以被搬走')
      assert.ok(existsSync(s.keeper))
      const why = [...routes.planOutcomes(s.db, s.p.id).values()][0].why
      assert.match(why ?? '', /找不到會保留的相同檔案/)
    })
  }
})

// ═══ K3 ・ scanProblems 把家目錄換成 ~ ═══════════════════════════════

describe('K3 掃描的問題訊息：家目錄換成 ~', () => {
  test('家目錄底下、不在清理根目錄底下的路徑 → ~/…；清理根目錄底下的 → 資料夾名稱（不是 ~/Downloads）', () => {
    const root = join(FAKE_HOME, 'Downloads')
    const out = routes.scanProblems([
      `打不開 ${join(FAKE_HOME, 'Desktop', '報告.pdf')}`,
      `打不開 ${join(root, 'sub', 'a.zip')}`,
      `家目錄 ${FAKE_HOME} 不能掃`,
      '沒有路徑的人話',
    ], [root])
    assert.deepEqual(out, [
      `打不開 ${join('~', 'Desktop', '報告.pdf')}`,
      `打不開 ${join('Downloads', 'sub', 'a.zip')}`,
      '家目錄 ~ 不能掃',
      '沒有路徑的人話',
    ])
    for (const m of out) assert.ok(!m.includes(FAKE_HOME), `還帶著家目錄：${m}`)
  })

  test('route：POST /cleanup/scan 回的 problems 也換（清理根目錄不在家目錄底下）', t => {
    const f = fixture(t)
    let got = null
    routes.cleanupRoutes({
      db: f.db, roots: f.opts.roots, quarantine: f.opts.quarantine, maxBytes: f.opts.maxBytes, readonly: false,
      url: new URL('http://x/cleanup/scan'), method: 'POST', body: {},
      send: (code, body) => { got = { code, body } },
      scan: onProblem => {
        onProblem(`讀不到 ${join(FAKE_HOME, 'Pictures', 'x.png')}`)
        return f.scan()
      },
    })
    assert.equal(got.code, 200)
    assert.deepEqual(got.body.problems, [`讀不到 ${join('~', 'Pictures', 'x.png')}`])
  })
})

// ═══ K4 ・ db.ts 的註解說對是誰寫 cleanup_item_errors ═════════════════

describe('K4 cleanup_item_errors 的註解', () => {
  test('指名 applyPlan 的 markFailure 當下寫入，不再說是 recordItemErrors', () => {
    const src = readFileSync(new URL('../core/db.ts', import.meta.url), 'utf8').split('\n')
    const at = src.findIndex(l => l.includes('CREATE TABLE IF NOT EXISTS cleanup_item_errors'))
    assert.ok(at > 0)
    let from = at
    while (from > 0 && src[from - 1].trimStart().startsWith('--')) from--
    const comment = src.slice(from, at).join('\n')
    assert.match(comment, /markFailure/)
    assert.match(comment, /applyPlan/)
    assert.doesNotMatch(comment, /recordItemErrors/)
  })
})

// ═══ K5 ・ 重複檔的「不再成立」只看這次的 roots ═══════════════════════

describe('K5 skipStaleDuplicates 只處理這次 roots 底下的候選', () => {
  function twoRoots(t) {
    const s = sandbox(t)
    const a = s.put(s.dl, 'a.pdf', 'dl bytes')
    const b = s.put(s.dl, 'b.pdf', 'dl bytes')
    const c = s.put(s.desk, 'c.txt', 'desk bytes')
    const d = s.put(s.desk, 'd.txt', 'desk bytes')
    return { ...s, a, b, c, d }
  }

  test('Downloads 與 Desktop 交替掃：兩邊的重複檔候選都一直是 proposed，不翻來翻去', t => {
    const s = twoRoots(t)
    const seen = []
    for (const roots of [[s.dl], [s.desk], [s.dl], [s.desk], [s.dl, s.desk], [s.desk], [s.dl]]) {
      s.scan(roots)
      seen.push([roots.map(r => r === s.dl ? 'dl' : 'desk').join('+'), s.dupStatus(s.b), s.dupStatus(s.d)])
    }
    assert.deepEqual(seen, [
      ['dl', 'proposed', undefined],
      ['desk', 'proposed', 'proposed'],
      ['dl', 'proposed', 'proposed'],
      ['desk', 'proposed', 'proposed'],
      ['dl+desk', 'proposed', 'proposed'],
      ['desk', 'proposed', 'proposed'],
      ['dl', 'proposed', 'proposed'],
    ])
    s.scan([s.desk])
    assert.equal(s.itemStatus(s.b), 'candidate')
    assert.equal(s.itemStatus(s.d), 'candidate')
    assert.deepEqual(routes.listCandidates(s.db, { roots: [s.dl] }).candidates.map(x => x.name), ['b.pdf'],
      '剛用 Desktop 掃過，Downloads 的清單還在')
  })

  test('邊界的另一側：不再是重複檔（b.pdf 內容變了）→ 用 Desktop 掃不動它，用 Downloads 掃才改 skipped', t => {
    const s = twoRoots(t)
    s.scan([s.dl])
    s.scan([s.desk])
    s.put(s.dl, 'b.pdf', 'dl bytes, edited')
    s.scan([s.desk])
    assert.equal(s.dupStatus(s.b), 'proposed', '這次的 roots 不含 Downloads，不是它該判斷的')
    s.scan([s.dl])
    assert.equal(s.dupStatus(s.b), 'skipped')
    assert.equal(s.itemStatus(s.b), 'kept', '沒有別的候選了就不再是 candidate')
    assert.equal(s.dupStatus(s.d), 'proposed', 'Desktop 那組不受影響')
  })

  test('（推論）保留者被刪掉：用 Desktop 掃不動 Downloads 的候選，用 Downloads 掃才改 skipped', t => {
    const s = twoRoots(t)
    s.scan([s.dl])
    rmSync(s.a)
    s.scan([s.desk])
    assert.equal(s.dupStatus(s.b), 'proposed')
    s.scan([s.dl])
    assert.equal(s.dupStatus(s.b), 'skipped')
  })

  test('根目錄是捷徑（跟 macOS 的 /var → /private/var 同一回事）：不再是重複檔的照樣改 skipped', t => {
    const s = twoRoots(t)
    const link = join(s.dir, 'dl-link')
    symlinkSync(s.dl, link, 'dir')
    s.scan([link])
    assert.equal(s.dupStatus(s.b), 'proposed')
    s.put(s.dl, 'b.pdf', 'dl bytes, edited')
    s.scan([link])
    assert.equal(s.dupStatus(s.b), 'skipped', '資料庫存的是真路徑，比對要用真路徑')
  })

  test('沒給 roots（舊的呼叫方式）→ 還是看全庫', t => {
    const s = twoRoots(t)
    s.scan([s.dl])
    s.put(s.dl, 'b.pdf', 'dl bytes, edited')
    s.db.prepare('UPDATE file_items SET sha256=? WHERE path=?')
      .run(createHash('sha256').update('dl bytes, edited').digest('hex'), realpathSync(s.b))
    scanner.addDuplicateCandidates(s.db)
    assert.equal(s.dupStatus(s.b), 'skipped')
  })

  test('性質：一次掃描不會改到 roots 外面的候選狀態（換檔、刪檔、交替 roots）', t => {
    const s = twoRoots(t)
    const snapshot = () => new Map(s.db.prepare(
      `SELECT c.id, c.status, i.path FROM cleanup_candidates c JOIN file_items i ON i.id=c.item_id`
    ).all().map(r => [r.id, { status: r.status, path: r.path }]))
    const inside = (path, roots) => roots.some(r => path.startsWith(realpathSync(r) + sep))
    s.scan([s.dl, s.desk])   // 暖身：一次性的舊資料修復在這裡跑完
    const steps = [
      [[s.desk], () => s.put(s.dl, 'b.pdf', 'dl bytes, edited')],
      [[s.desk], () => s.put(s.desk, 'e.txt', 'desk bytes')],
      [[s.dl], () => rmSync(s.c)],
      [[s.dl], () => s.put(s.dl, 'b.pdf', 'dl bytes')],
      [[s.desk], () => s.put(s.dl, 'f.pdf', 'dl bytes')],
      [[s.dl], () => rmSync(s.a)],
      [[s.desk], () => {}],
      [[s.dl], () => {}],
    ]
    let checked = 0
    for (const [roots, change] of steps) {
      change()
      const before = snapshot()
      s.scan(roots)
      for (const [id, now] of snapshot()) {
        const was = before.get(id)
        if (!was || inside(now.path, roots)) continue
        assert.equal(now.status, was.status, `掃 ${roots.map(r => basename(r))} 改到了外面的 ${basename(now.path)}`)
        checked++
      }
    }
    assert.ok(checked >= 6, `真的有比到 roots 外面的候選（${checked}）`)
  })
})
