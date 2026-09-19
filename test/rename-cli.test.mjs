import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * P3 ・ `node cli.mjs rename`／`--apply`／`--undo`。
 *
 * 期望值抄自 `~/contextbox-預想-20260919-P3改名.md`（介面那一節與預期行為 1）：
 *
 * | 段落 | 可能的錯 | 另一種解讀 | 成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | 沒有東西可以改 | 回非零 | 回 0 | 空的 Downloads | 0（那不是失敗，是很乾淨） |
 * | `rename` 自己 | 順手改掉 | 只列 | 只打 `rename` | 檔名一個都沒變 |
 * | 打錯編號 | 照改別的 | 什麼都不做、回 1 | `--apply zzzz` | 1，檔名沒變 |
 * | 唯讀模式 | 照改 | 不改 | readonly: true | 非零，檔名沒變 |
 * | 離開碼 | 一律 0 | 照 docs/cli.md | 部分失敗 | 3 |
 *
 * 預期行為 1 用 `tools/demo-setup.mjs --seed-model` 的沙盒跑：那支會把**真的模型跑出來的答案**
 * 寫進快取，所以不需要模型叢集。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync, utimesSync, realpathSync, renameSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { open as openDb } from '../core/db.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(REPO, 'cli.mjs')
const OS_DEADLOCK = '作業系統 第 6 章 死結\n\n'
  + '死結的四個必要條件：互斥、持有並等待、不可搶奪、環狀等待。\n'
  + '處理方式：預防、避免（銀行家演算法）、偵測與恢復、鴕鳥策略。\n'
  + '小考範圍到這裡，記得練習資源配置圖判斷有沒有環。\n'
const DS_MIDTERM = '資料結構 期中考範圍\n\n'
  + '第一部分：堆疊與佇列的實作與應用（中序轉後序、BFS 佇列）。\n'
  + '第二部分：二元搜尋樹的插入、刪除與走訪；AVL 的四種旋轉。\n'
  + '考試時間：下週三第 3、4 節。\n'

/** 一個沙盒家目錄：Downloads 裡幾個往回撥過時間的檔，設定、資料庫、隔離區都在裡面。 */
function box(t, files, { readonly = false } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cb-rncli-')))
  const downloads = join(home, 'Downloads')
  mkdirSync(downloads)
  t.after(() => rmSync(home, { recursive: true, force: true }))
  for (const [name, content] of Object.entries(files)) {
    const p = join(downloads, name)
    writeFileSync(p, content)
    const at = new Date(Date.now() - 30 * 86400_000)
    utimesSync(p, at, at)
  }
  const cfgPath = join(home, 'config.json')
  const dbPath = join(home, 'data.db')
  writeFileSync(cfgPath, JSON.stringify({
    watch: [downloads], filed: join(home, 'Filed'),
    model: { baseUrl: '', name: '', keyEnv: 'CONTEXTBOX_MODEL_KEY' },
    readonly, pdfPages: 3, maxBytes: 20971520,
    cleanup: { roots: [downloads], screenshots: false },
  }))
  const env = {
    ...process.env,
    HOME: home, USERPROFILE: home,
    CONTEXTBOX_CONFIG: cfgPath, CONTEXTBOX_DB: dbPath,
    CONTEXTBOX_QUARANTINE: join(home, 'quarantine'), CONTEXTBOX_TOKEN_PATH: join(home, 'token'),
    CONTEXTBOX_PORT: '0',
  }
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 120_000 })
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
  }
  /** 掃一次，然後直接寫「模型的看法」（不打模型）。 */
  const seed = views => {
    run('cleanup', 'scan')
    const db = openDb(dbPath)
    try {
      for (const [name, view] of Object.entries(views)) {
        const item = db.prepare('SELECT id FROM file_items WHERE path=?').get(join(downloads, name))
        assert.ok(item, `掃描沒收到 ${name}`)
        db.prepare(`INSERT INTO model_views
          (key,item_id,source,course,topic,kind,suggested_name,evidence,confidence,model,prompt_version,at,seeded)
          VALUES (?,?,'text',?,?,'筆記',?,?,?,'假模型','v1',?,0)`).run(
          'seed-' + item.id, item.id, view.course ?? '作業系統', view.topic ?? '死結',
          view.suggestedName, view.evidence ?? '四個必要條件', view.confidence ?? '高',
          new Date().toISOString())
      }
    } finally { db.close() }
  }
  const names = () => readdirSync(downloads).sort()
  return { home, downloads, run, seed, names, dbPath }
}

describe('中斷的改名，每個指令進來都會收尾', () => {
  /** 做出「rename 做了、done 還沒寫」的狀態。 */
  function crashed(b) {
    b.seed({ '未命名文件 (3).txt': { suggestedName: '作業系統_死結' } })
    const db = openDb(b.dbPath)
    let id
    try {
      const item = db.prepare('SELECT id FROM file_items WHERE name=?').get('未命名文件 (3).txt')
      id = 'r-' + item.id
      db.prepare(`INSERT INTO renames (id,item_id,from_name,to_name,dir,source,status,error,at,undone_at)
        VALUES (?,?,?,?,?, 'model','started',NULL,?,NULL)`)
        .run(id, item.id, '未命名文件 (3).txt', '作業系統_死結.txt', b.downloads, new Date().toISOString())
    } finally { db.close() }
    renameSync(join(b.downloads, '未命名文件 (3).txt'), join(b.downloads, '作業系統_死結.txt'))
    return id
  }
  const statusOf = (b, id) => {
    const db = openDb(b.dbPath)
    try { return db.prepare('SELECT status FROM renames WHERE id=?').get(id)?.status } finally { db.close() }
  }

  // 以前只有 rename 指令會收尾：pet 與 doctor 都不收，而 pet 開機第一件事就是掃描，
  // 掃完那一筆就再也收不了尾、也復原不回來（P3 驗證員）。
  for (const args of [['doctor'], ['cleanup', 'list'], ['cleanup', 'scan']]) {
    test(`${args.join(' ')} 進來也會把中斷的改名收掉`, t => {
      const b = box(t, { '未命名文件 (3).txt': OS_DEADLOCK })
      const id = crashed(b)
      assert.equal(b.run(...args).code, 0)
      assert.equal(statusOf(b, id), 'done', `${args.join(' ')} 沒有收尾`)
    })
  }

  test('收尾之後照樣復原得回去', t => {
    const b = box(t, { '未命名文件 (3).txt': OS_DEADLOCK })
    crashed(b)
    b.run('doctor')
    const r = b.run('rename', '--undo')
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(b.names(), ['未命名文件 (3).txt'], r.out)
  })
})

describe('node cli.mjs rename', () => {
  test('沒有東西可以改名：講一句，離開碼 0（那不是失敗）', t => {
    const b = box(t, {})
    const r = b.run('rename')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /沒有可以改名的檔/)
  })

  test('列出建議：原名、建議名、模型認為什麼、證據；**一個檔都不改**', t => {
    const b = box(t, { '未命名文件 (3).txt': OS_DEADLOCK, 'IMG_2041.txt': DS_MIDTERM })
    b.seed({
      '未命名文件 (3).txt': { suggestedName: '作業系統_死結' },
      'IMG_2041.txt': { course: '資料結構', topic: '期中考範圍', suggestedName: '資料結構_期中考範圍', evidence: '考試時間' },
    })
    const before = b.names()
    const r = b.run('rename')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /未命名文件 \(3\)\.txt/)
    assert.match(r.out, /→ 作業系統_死結\.txt/)
    assert.match(r.out, /模型認為：作業系統／死結（信心 高）/)
    assert.match(r.out, /證據：四個必要條件/)
    assert.match(r.out, /模型的意見，不是事實/)
    assert.deepEqual(b.names(), before, '`rename` 只列，不可以順手改')
    // 畫面上不可以有絕對路徑
    assert.ok(!r.out.includes(b.downloads), r.out)
  })

  test('取好名字的檔不在清單上', t => {
    const b = box(t, { '作業系統_第5章_行程排程.txt': OS_DEADLOCK })
    b.seed({ '作業系統_第5章_行程排程.txt': { suggestedName: '作業系統_行程排程' } })
    const r = b.run('rename')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /沒有可以改名的檔/)
  })

  test('--apply 真的改，--undo 改得回來', t => {
    const b = box(t, { '未命名文件 (3).txt': OS_DEADLOCK })
    b.seed({ '未命名文件 (3).txt': { suggestedName: '作業系統_死結' } })

    const a = b.run('rename', '--apply')
    assert.equal(a.code, 0, a.out)
    assert.match(a.out, /✔ 未命名文件 \(3\)\.txt → 作業系統_死結\.txt/)
    assert.deepEqual(b.names(), ['作業系統_死結.txt'])

    // 改完再列一次：清單空了，但看得到「最近改過的」
    const list = b.run('rename')
    assert.match(list.out, /最近改過的/)
    assert.match(list.out, /未命名文件 \(3\)\.txt → 作業系統_死結\.txt/)

    const u = b.run('rename', '--undo')
    assert.equal(u.code, 0, u.out)
    assert.match(u.out, /↩ 未命名文件 \(3\)\.txt/)
    assert.deepEqual(b.names(), ['未命名文件 (3).txt'])
  })

  test('--apply <編號> 只改那一個', t => {
    const b = box(t, { '未命名文件 (3).txt': OS_DEADLOCK, 'IMG_2041.txt': DS_MIDTERM })
    b.seed({
      '未命名文件 (3).txt': { suggestedName: '作業系統_死結' },
      'IMG_2041.txt': { course: '資料結構', topic: '期中考範圍', suggestedName: '資料結構_期中考範圍' },
    })
    const list = b.run('rename')
    const code = /\[(\w{4,})\] 未命名文件 \(3\)\.txt/.exec(list.out)?.[1]
    assert.ok(code, list.out)
    const a = b.run('rename', '--apply', code)
    assert.equal(a.code, 0, a.out)
    assert.deepEqual(b.names(), ['IMG_2041.txt', '作業系統_死結.txt'])
  })

  test('打錯編號：什麼都不做，離開碼 1', t => {
    const b = box(t, { '未命名文件 (3).txt': OS_DEADLOCK })
    b.seed({ '未命名文件 (3).txt': { suggestedName: '作業系統_死結' } })
    for (const bad of ['zzzz', 'ab']) {
      const r = b.run('rename', '--apply', bad)
      assert.equal(r.code, 1, r.out)
      assert.deepEqual(b.names(), ['未命名文件 (3).txt'])
    }
  })

  test('--apply 與 --undo 一起用、看不懂的旗標：離開碼 1', t => {
    const b = box(t, { '未命名文件 (3).txt': OS_DEADLOCK })
    b.seed({ '未命名文件 (3).txt': { suggestedName: '作業系統_死結' } })
    assert.equal(b.run('rename', '--apply', '--undo').code, 1)
    assert.equal(b.run('rename', '--everything').code, 1)
    assert.deepEqual(b.names(), ['未命名文件 (3).txt'])
  })

  test('唯讀模式：不改，離開碼非零', t => {
    const b = box(t, { '未命名文件 (3).txt': OS_DEADLOCK }, { readonly: true })
    b.seed({ '未命名文件 (3).txt': { suggestedName: '作業系統_死結' } })
    const r = b.run('rename', '--apply')
    assert.notEqual(r.code, 0, r.out)
    assert.match(r.out, /唯讀/)
    assert.deepEqual(b.names(), ['未命名文件 (3).txt'])
  })

  test('信心低的不列、不改', t => {
    const b = box(t, { '未命名文件 (3).txt': OS_DEADLOCK })
    b.seed({ '未命名文件 (3).txt': { suggestedName: '作業系統_死結', confidence: '低' } })
    const r = b.run('rename')
    assert.match(r.out, /沒有可以改名的檔/)
    const a = b.run('rename', '--apply')
    assert.equal(a.code, 0, a.out)
    assert.match(a.out, /沒有可以改名的檔/)
    assert.deepEqual(b.names(), ['未命名文件 (3).txt'])
  })

  test('檔名裡的控制字元與方向字元印出來要被換掉（終端機偽造）', t => {
    const b = box(t, { '未命名文件 (3).txt': OS_DEADLOCK })
    b.seed({ '未命名文件 (3).txt': { suggestedName: '作業系統_死結', evidence: '第一行\u001b[31m紅色\u202E' } })
    const r = b.run('rename')
    assert.ok(!r.out.includes('\u001b['), '原始碼的 ESC 不可以原樣印出來')
    assert.ok(!r.out.includes('\u202E'), '方向字元不可以原樣印出來')
  })

  test('說明文字裡有 rename', t => {
    const b = box(t, {})
    const r = b.run()
    assert.match(r.out, /node cli\.mjs rename/)
  })
})

describe('demo 沙盒（預期行為 1）', () => {
  test('--seed-model 的沙盒：兩個沒取名的在建議清單上，取好名字的不在', t => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-rndemo-')))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const setup = spawnSync(process.execPath,
      [join(REPO, 'tools', 'demo-setup.mjs'), '--dir', dir, '--seed-model'],
      { encoding: 'utf8', env: { ...process.env, HOME: FAKE_HOME, USERPROFILE: FAKE_HOME }, timeout: 180_000 })
    assert.equal(setup.status, 0, setup.stdout + setup.stderr)
    assert.match(setup.stdout, /已經預先塞了 3 筆/, '前提：示範答案塞進去了')

    const home = join(dir, 'home')
    const env = {
      ...process.env,
      HOME: home, USERPROFILE: home,
      CONTEXTBOX_CONFIG: join(dir, 'config.json'), CONTEXTBOX_DB: join(dir, 'data.db'),
      CONTEXTBOX_QUARANTINE: join(dir, 'quarantine'), CONTEXTBOX_TOKEN_PATH: join(dir, 'token'),
      CONTEXTBOX_PORT: '0',
    }
    const r = spawnSync(process.execPath, [CLI, 'rename'], { encoding: 'utf8', env, timeout: 120_000 })
    const out = (r.stdout ?? '') + (r.stderr ?? '')
    assert.equal(r.status, 0, out)

    assert.match(out, /未命名文件 \(3\)\.txt/)
    assert.match(out, /→ 作業系統_死結\.txt/)
    assert.match(out, /IMG_2041\.txt/)
    assert.match(out, /→ 資料結構_期中考範圍\.txt/)
    // named 的不在（它也有示範答案，但使用者自己取的名字最大）
    assert.ok(!out.includes('作業系統_第5章_行程排程.txt'), out)
    // 示範答案要標出來
    assert.match(out, /［示範答案］/)

    // 真的改一次、再改回來，檔案就在沙盒的 Downloads 裡
    const downloads = join(home, 'Downloads')
    const apply = spawnSync(process.execPath, [CLI, 'rename', '--apply'], { encoding: 'utf8', env, timeout: 120_000 })
    assert.equal(apply.status, 0, apply.stdout + apply.stderr)
    assert.equal(existsSync(join(downloads, '作業系統_死結.txt')), true)
    assert.equal(existsSync(join(downloads, '資料結構_期中考範圍.txt')), true)
    assert.equal(existsSync(join(downloads, '作業系統_第5章_行程排程.txt')), true, 'named 的不可以被動到')

    const undo = spawnSync(process.execPath, [CLI, 'rename', '--undo'], { encoding: 'utf8', env, timeout: 120_000 })
    assert.equal(undo.status, 0, undo.stdout + undo.stderr)
    assert.equal(existsSync(join(downloads, '未命名文件 (3).txt')), true)
  })
})
