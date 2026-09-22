import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
import { rmTmp } from './helpers/rm.mjs'
/**
 * P4 ・ `node cli.mjs file`／`--apply`／`--undo`。
 *
 * 期望值抄自 `~/contextbox-預想-20260919-P4歸檔.md`（介面那一節與預期行為 1）：
 *
 * | 段落 | 可能的錯 | 另一種解讀 | 成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | 沒有東西可以整理 | 回非零 | 回 0 | 空的 Downloads | 0（那不是失敗，是很乾淨） |
 * | `file` 自己 | 順手搬掉 | 只列 | 只打 `file` | 一個檔都沒動 |
 * | 打錯編號 | 照搬別的 | 什麼都不做、回 1 | `--apply zzzz` | 1，一個檔都沒動 |
 * | 唯讀模式 | 照搬 | 不搬 | readonly: true | 非零，一個檔都沒動 |
 * | 中斷的整理 | 只有 file 收尾 | 每個指令都收 | `doctor`／`cleanup list` | 都收得掉 |
 *
 * 預期行為 1 用 `tools/demo-setup.mjs --seed-model` 的沙盒跑：那支會把**真的模型跑出來的答案**
 * 寫進快取，所以不需要模型叢集。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync, utimesSync,
  realpathSync, renameSync,
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

/** 一個沙盒家目錄：Downloads 裡幾個往回撥過時間的檔，設定、資料庫、隔離區、Filed 都在裡面。 */
function box(t, files, { readonly = false } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cb-flcli-')))
  const downloads = join(home, 'Downloads')
  mkdirSync(downloads)
  t.after(() => rmTmp(home))
  for (const [name, content] of Object.entries(files)) {
    const p = join(downloads, name)
    writeFileSync(p, content)
    const at = new Date(Date.now() - 30 * 86400_000)
    utimesSync(p, at, at)
  }
  const filed = join(home, 'Filed')
  const cfgPath = join(home, 'config.json')
  const dbPath = join(home, 'data.db')
  writeFileSync(cfgPath, JSON.stringify({
    watch: [downloads], filed,
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
          VALUES (?,?,'text',?,?,?,?,?,?,'假模型','v1',?,0)`).run(
          'seed-' + item.id, item.id, view.course ?? '作業系統', view.topic ?? '死結',
          view.kind ?? 'Notes', view.suggestedName ?? '', view.evidence ?? '四個必要條件',
          view.confidence ?? 'high', new Date().toISOString())
      }
    } finally { db.close() }
  }
  const names = () => readdirSync(downloads).sort()
  /** Filed 底下的相對路徑（排序過）。 */
  const filedTree = () => {
    const out = []
    const walk = (at, prefix) => {
      let entries = []
      try { entries = readdirSync(at, { withFileTypes: true }) } catch { return }
      for (const e of [...entries].sort((a, b) => a.name < b.name ? -1 : 1)) {
        const rel = prefix ? prefix + '/' + e.name : e.name
        if (e.isDirectory()) { out.push(rel + '/'); walk(join(at, e.name), rel) } else out.push(rel)
      }
    }
    walk(filed, '')
    return out
  }
  return { home, downloads, filed, run, seed, names, filedTree, dbPath }
}

describe('`file` 只列，不動任何檔', () => {
  test('沒有東西可以整理 → 離開碼 0（那不是失敗）', t => {
    const b = box(t, {})
    const r = b.run('file')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /can be filed/)
  })

  test('列得出建議，而且一個檔都沒動', t => {
    const b = box(t, { 'Untitled document (3).txt': OS_DEADLOCK, 'IMG_2041.txt': DS_MIDTERM })
    b.seed({
      'Untitled document (3).txt': { course: '作業系統', topic: '死結', kind: 'Notes' },
      'IMG_2041.txt': { course: '資料結構', topic: '期中考範圍', kind: 'Exam' },
    })
    const r = b.run('file')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /→ Courses\/作業系統\/Notes\//)
    assert.match(r.out, /→ Courses\/資料結構\/Exam\//)
    assert.match(r.out, /these are the model's opinions, not facts/)
    assert.deepEqual(b.names(), ['IMG_2041.txt', 'Untitled document (3).txt'])
    assert.equal(existsSync(b.filed), false, '只列的時候連 Filed 都不該被建出來')
  })

  test('打錯編號：什麼都不做，離開碼 1', t => {
    const b = box(t, { 'Untitled document (3).txt': OS_DEADLOCK })
    b.seed({ 'Untitled document (3).txt': {} })
    const r = b.run('file', '--apply', 'zzzz')
    assert.equal(r.code, 1, r.out)
    assert.deepEqual(b.names(), ['Untitled document (3).txt'])
  })

  test('看不懂的旗標、--apply 與 --undo 一起用 → 離開碼 1', t => {
    const b = box(t, { 'Untitled document (3).txt': OS_DEADLOCK })
    b.seed({ 'Untitled document (3).txt': {} })
    assert.equal(b.run('file', '--all').code, 1)
    assert.equal(b.run('file', '--apply', '--undo').code, 1)
    assert.deepEqual(b.names(), ['Untitled document (3).txt'])
  })

  test('唯讀模式：不搬，離開碼非 0', t => {
    const b = box(t, { 'Untitled document (3).txt': OS_DEADLOCK }, { readonly: true })
    b.seed({ 'Untitled document (3).txt': {} })
    const r = b.run('file', '--apply')
    assert.notEqual(r.code, 0)
    assert.match(r.out, /Read-only/)
    assert.deepEqual(b.names(), ['Untitled document (3).txt'])
  })

  test('檔名與證據裡的控制字元、方向字元印出來要被換掉（終端機偽造）', t => {
    const b = box(t, { 'Untitled document (3).txt': OS_DEADLOCK })
    b.seed({ 'Untitled document (3).txt': { evidence: '第一行\u001b[31m紅色\u202E' } })
    const r = b.run('file')
    assert.ok(!r.out.includes('\u001b['), '原始碼的 ESC 不可以原樣印出來')
    assert.ok(!r.out.includes('\u202E'), '方向字元不可以原樣印出來')
  })

  test('說明文字裡有 file', t => {
    const b = box(t, {})
    assert.match(b.run().out, /node cli\.mjs file/)
  })
})

describe('`file --apply` 與 `--undo`', () => {
  test('搬進 Filed，再搬回來', t => {
    const b = box(t, { 'Untitled document (3).txt': OS_DEADLOCK, 'IMG_2041.txt': DS_MIDTERM })
    b.seed({
      'Untitled document (3).txt': { course: '作業系統', topic: '死結', kind: 'Notes' },
      'IMG_2041.txt': { course: '資料結構', topic: '期中考範圍', kind: 'Exam' },
    })
    const a = b.run('file', '--apply')
    assert.equal(a.code, 0, a.out)
    assert.match(a.out, /Filed 2/)
    assert.deepEqual(b.filedTree(), [
      'Courses/', 'Courses/作業系統/', 'Courses/作業系統/Notes/', 'Courses/作業系統/Notes/Untitled document (3).txt',
      'Courses/資料結構/', 'Courses/資料結構/Exam/', 'Courses/資料結構/Exam/IMG_2041.txt',
    ])
    assert.deepEqual(b.names(), [])

    const u = b.run('file', '--undo')
    assert.equal(u.code, 0, u.out)
    assert.match(u.out, /Moved 2 back/)
    assert.deepEqual(b.names(), ['IMG_2041.txt', 'Untitled document (3).txt'])
    // 只搬不刪：空掉的資料夾留著
    assert.deepEqual(b.filedTree(), [
      'Courses/', 'Courses/作業系統/', 'Courses/作業系統/Notes/', 'Courses/資料結構/', 'Courses/資料結構/Exam/',
    ])
  })

  test('只挑一個編號：另一個不動', t => {
    const b = box(t, { 'Untitled document (3).txt': OS_DEADLOCK, 'IMG_2041.txt': DS_MIDTERM })
    b.seed({
      'Untitled document (3).txt': { course: '作業系統', kind: 'Notes' },
      'IMG_2041.txt': { course: '資料結構', kind: 'Exam' },
    })
    const listed = b.run('file')
    const code = /\[([0-9a-f]{4,})\] Untitled document/.exec(listed.out)?.[1]
    assert.ok(code, listed.out)
    assert.equal(b.run('file', '--apply', code).code, 0)
    assert.deepEqual(b.names(), ['IMG_2041.txt'])
  })

  test('`--undo <編號>`：只還那一筆；編號少於 4 碼、對不上都是離開碼 1', t => {
    const b = box(t, { 'Untitled document (3).txt': OS_DEADLOCK, 'IMG_2041.txt': DS_MIDTERM })
    b.seed({
      'Untitled document (3).txt': { course: '作業系統', kind: 'Notes' },
      'IMG_2041.txt': { course: '資料結構', kind: 'Exam' },
    })
    assert.equal(b.run('file', '--apply').code, 0)
    const listed = b.run('file')
    const code = /\[([0-9a-f]{4,})\] Untitled document \(3\)\.txt →/.exec(listed.out)?.[1]
    assert.ok(code, listed.out)
    assert.equal(b.run('file', '--undo', 'zz').code, 1)
    assert.equal(b.run('file', '--undo', 'zzzzzzzz').code, 1)
    assert.equal(b.run('file', '--undo', code).code, 0)
    assert.deepEqual(b.names(), ['Untitled document (3).txt'])
  })

  test('沒有可以復原的 → 講一句話，不是當機', t => {
    const b = box(t, { 'Untitled document (3).txt': OS_DEADLOCK })
    b.seed({ 'Untitled document (3).txt': {} })
    const r = b.run('file', '--undo')
    assert.notEqual(r.code, 0)
    assert.match(r.out, /There is no filing to undo/)
  })
})

describe('中斷的整理，每個指令進來都會收尾', () => {
  /** 做出「rename 做了、done 還沒寫」的狀態。 */
  function crashed(b) {
    b.seed({ 'Untitled document (3).txt': { course: '作業系統', kind: 'Notes' } })
    const dir = join(b.filed, '課程', '作業系統', 'Notes')
    mkdirSync(dir, { recursive: true })
    const db = openDb(b.dbPath)
    let id
    try {
      const item = db.prepare('SELECT id FROM file_items WHERE name=?').get('Untitled document (3).txt')
      id = 'f-' + item.id
      db.prepare(`INSERT INTO filings (id,item_id,name,from_dir,to_dir,to_name,course,kind,topic,status,error,at,undone_at)
        VALUES (?,?,?,?,?,?,'作業系統','Notes','','started',NULL,?,NULL)`)
        .run(id, item.id, 'Untitled document (3).txt', b.downloads, dir, 'Untitled document (3).txt', new Date().toISOString())
    } finally { db.close() }
    renameSync(join(b.downloads, 'Untitled document (3).txt'), join(dir, 'Untitled document (3).txt'))
    return id
  }
  const statusOf = (b, id) => {
    const db = openDb(b.dbPath)
    try { return db.prepare('SELECT status FROM filings WHERE id=?').get(id)?.status } finally { db.close() }
  }

  // 搬家比改名更嚴重：filed 不在掃描範圍裡，沒收到尾的那一筆不會有任何別的東西把它接回來。
  for (const args of [['doctor'], ['cleanup', 'list'], ['cleanup', 'scan'], ['file']]) {
    test(`${args.join(' ')} 進來也會把中斷的整理收掉`, t => {
      const b = box(t, { 'Untitled document (3).txt': OS_DEADLOCK })
      const id = crashed(b)
      assert.equal(b.run(...args).code, 0)
      assert.equal(statusOf(b, id), 'done', `${args.join(' ')} 沒有收尾`)
    })
  }

  test('收尾之後復原得回去', t => {
    const b = box(t, { 'Untitled document (3).txt': OS_DEADLOCK })
    crashed(b)
    assert.equal(b.run('doctor').code, 0)
    const u = b.run('file', '--undo')
    assert.equal(u.code, 0, u.out)
    assert.deepEqual(b.names(), ['Untitled document (3).txt'])
  })

  test('唯讀模式不收尾（第三輪 R3-9：純預覽不可以寫資料庫）', t => {
    const b = box(t, { 'Untitled document (3).txt': OS_DEADLOCK })
    const id = crashed(b)
    // 沙盒本來不是唯讀（crashed 要先掃一次），這裡才改成唯讀
    const cfg = join(b.home, 'config.json')
    const json = JSON.parse(readFileSync(cfg, 'utf8'))
    json.readonly = true
    writeFileSync(cfg, JSON.stringify(json))
    assert.equal(b.run('doctor').code, 0)
    assert.equal(statusOf(b, id), 'started', 'Read-only mode不可以動資料庫')
  })
})

describe('demo 沙盒（預期行為 1）', () => {
  test('--seed-model 的沙盒：三個課程檔都歸得了類，搬完再搬回來', t => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-fldemo-')))
    t.after(() => rmTmp(dir))
    const setup = spawnSync(process.execPath,
      [join(REPO, 'tools', 'demo-setup.mjs'), '--dir', dir, '--seed-model'],
      { encoding: 'utf8', env: { ...process.env, HOME: FAKE_HOME, USERPROFILE: FAKE_HOME }, timeout: 180_000 })
    assert.equal(setup.status, 0, setup.stdout + setup.stderr)
    assert.match(setup.stdout, /Seeded 5 model answers/, '前提：示範答案塞進去了')

    const home = join(dir, 'home')
    const env = {
      ...process.env,
      HOME: home, USERPROFILE: home,
      CONTEXTBOX_CONFIG: join(dir, 'config.json'), CONTEXTBOX_DB: join(dir, 'data.db'),
      CONTEXTBOX_QUARANTINE: join(dir, 'quarantine'), CONTEXTBOX_TOKEN_PATH: join(dir, 'token'),
      CONTEXTBOX_PORT: '0',
    }
    const cli = (...args) => {
      const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 120_000 })
      return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
    }
    const r = cli('file')
    assert.equal(r.code, 0, r.out)
    // 預期行為 1：兩個作業系統的檔都進 `課程/作業系統/…`，IMG_2041 進 `課程/資料結構/考試`
    assert.match(r.out, /operating-systems-ch5-scheduling\.txt\n\s+→ Courses\/Operating Systems\/Lecture\//)
    assert.match(r.out, /Untitled document \(3\)\.txt\n\s+→ Courses\/Operating Systems\/Notes\//)
    assert.match(r.out, /IMG_2041\.txt\n\s+→ Courses\/Data Structures\/Exam\//)
    assert.match(r.out, /\[demo answer\]/)

    const filed = join(home, 'Documents', 'Filed')
    const downloads = join(home, 'Downloads')
    assert.equal(cli('file', '--apply').code, 0)
    assert.equal(existsSync(join(filed, 'Courses', 'Operating Systems', 'Lecture', 'operating-systems-ch5-scheduling.txt')), true)
    assert.equal(existsSync(join(filed, 'Courses', 'Operating Systems', 'Notes', 'Untitled document (3).txt')), true)
    assert.equal(existsSync(join(filed, 'Courses', 'Data Structures', 'Exam', 'IMG_2041.txt')), true)
    assert.deepEqual(readdirSync(join(filed, 'Courses')).sort(), ['Data Structures', 'Operating Systems'])

    assert.equal(cli('file', '--undo').code, 0)
    assert.equal(existsSync(join(downloads, 'Untitled document (3).txt')), true)
    assert.equal(existsSync(join(downloads, 'IMG_2041.txt')), true)
    assert.equal(existsSync(join(downloads, 'operating-systems-ch5-scheduling.txt')), true)
  })
})
