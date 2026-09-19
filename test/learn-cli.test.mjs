import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * P5 ・ `node cli.mjs learned`／`--forget`／`--forget-all`，以及
 * `file --apply --course`、`rename --apply --to`、「退過貨的不預設做」。
 *
 * 期望值抄自 `~/contextbox-預想-20260920-P5學習.md`（介面那一節與預期行為 1、5、7、8、9、11）：
 *
 * | 段落 | 可能的錯 | 另一種解讀 | 成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | 什麼都沒學過 | 回非零 | 回 0 | 全新的沙盒 | 0，講一句「還沒學到任何東西」 |
 * | `--course OS` 後面的值 | 被當成編號 | 是課名 | `--apply a1b2 --course OS` | 課名，不是編號 |
 * | 不給編號的 `--apply` | 連退過貨的一起做 | 跳過退過貨的 | undo 過一個 | 跳過，而且講出來 |
 * | `--forget` 打錯編號 | 忘掉別的 | 什麼都不做、回 1 | `--forget zzzz` | 1，一條都沒少 |
 * | 唯讀模式要忘 | 照忘 | 不忘 | readonly: true | 非零，一條都沒少 |
 * | 表不見了 | 噴堆疊 | 講人話 | DROP TABLE preferences | 0，不噴堆疊（預期行為 9） |
 *
 * `--seed-model` 那條路徑在 docs/DEMO.md 走過一次；這裡用跟 filing-cli 同一套沙盒，不打模型。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync, utimesSync,
  realpathSync,
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
const OS_SCHEDULING = '作業系統 第 5 章 行程排程\n\n'
  + '一、排班準則：CPU 使用率、產能、周轉時間、等待時間、回應時間。\n'
  + '二、FCFS：先到先服務，會有護送效應（convoy effect）。\n'
  + '三、Round Robin：時間配額 q 的選擇；q 太大退化成 FCFS。\n'
const DS_MIDTERM = '資料結構 期中考範圍\n\n'
  + '第一部分：堆疊與佇列的實作與應用（中序轉後序、BFS 佇列）。\n'
  + '第二部分：二元搜尋樹的插入、刪除與走訪；AVL 的四種旋轉。\n'
  + '考試時間：下週三第 3、4 節。\n'

/** 一個沙盒家目錄（跟 filing-cli 同一套）：Downloads、設定、資料庫、隔離區、Filed 都在裡面。 */
function box(t, files, { readonly = false } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cb-learn-')))
  const downloads = join(home, 'Downloads')
  mkdirSync(downloads)
  t.after(() => rmSync(home, { recursive: true, force: true }))
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
          view.kind ?? '筆記', view.suggestedName ?? '', view.evidence ?? '四個必要條件',
          view.confidence ?? '高', new Date().toISOString())
      }
    } finally { db.close() }
  }
  const names = () => readdirSync(downloads).sort()
  const filedTree = () => {
    const out = []
    const walk = (at, prefix) => {
      let entries = []
      try { entries = readdirSync(at, { withFileTypes: true }) } catch { return }
      for (const e of [...entries].sort((a, b) => a.name < b.name ? -1 : 1)) {
        const rel = prefix ? prefix + '/' + e.name : e.name
        out.push(e.isDirectory() ? rel + '/' : rel)
        if (e.isDirectory()) walk(join(at, e.name), rel)
      }
    }
    walk(filed, '')
    return out
  }
  const prefs = () => {
    const db = openDb(dbPath)
    try { return db.prepare('SELECT kind, k, v, times FROM preferences ORDER BY kind, k').all().map(r => ({ ...r })) }
    finally { db.close() }
  }
  /** 清單上某個檔的編號（`[a1b2]`）。 */
  const codeOf = (out, name) => {
    const line = out.split('\n').find(l => l.includes(name) && /^\s*\[/.test(l))
    assert.ok(line, `清單上沒有 ${name}：\n${out}`)
    return /\[([0-9a-f]+)\]/.exec(line)[1]
  }
  return { home, downloads, filed, run, seed, names, filedTree, prefs, codeOf, dbPath }
}

/** 兩個作業系統、一個資料結構。 */
function three(t, opts) {
  const b = box(t, {
    '未命名文件 (3).txt': OS_DEADLOCK,
    '未命名文件 (4).txt': OS_SCHEDULING,
    'IMG_2041.txt': DS_MIDTERM,
  }, opts)
  b.seed({
    '未命名文件 (3).txt': { course: '作業系統', topic: '死結', kind: '筆記', suggestedName: '作業系統_死結' },
    '未命名文件 (4).txt': { course: '作業系統', topic: '行程排程', kind: '筆記', suggestedName: '作業系統_排程' },
    'IMG_2041.txt': { course: '資料結構', topic: '期中考範圍', kind: '考試', suggestedName: '資料結構_期中考範圍' },
  })
  return b
}

describe('`file --apply --course`（預期行為 1）', () => {
  test('`--course OS` 後面的 OS 不可以被當成編號', t => {
    const b = three(t)
    const code = b.codeOf(b.run('file').out, '未命名文件 (3).txt')
    const r = b.run('file', '--apply', code, '--course', 'OS')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /課程\/OS\/筆記/)
    assert.ok(!r.out.includes('沒有編號'), r.out)
    assert.deepEqual(b.filedTree().filter(p => p.endsWith('.txt')), ['課程/OS/筆記/未命名文件 (3).txt'])
  })

  test('學到之後，另一個作業系統的檔的清單變成 課程/OS/，而且講「照你上次改的寫」', t => {
    const b = three(t)
    const code = b.codeOf(b.run('file').out, '未命名文件 (3).txt')
    b.run('file', '--apply', code, '--course', 'OS')
    const out = b.run('file').out
    assert.match(out, /→ 課程\/OS\/筆記\/　（照你上次改的寫）/)
    assert.match(out, /模型認為：作業系統／行程排程/, '「模型認為」那一句要用模型自己的課名')
    assert.match(out, /→ 課程\/資料結構\/考試\//, '別堂課不受影響')
  })

  test('`--kind` 也學得到（這一堂課的）', t => {
    const b = three(t)
    const code = b.codeOf(b.run('file').out, '未命名文件 (3).txt')
    assert.equal(b.run('file', '--apply', code, '--kind', '講義').code, 0)
    assert.deepEqual(b.prefs(), [{ kind: 'file_kind', k: '作業系統\n筆記', v: '講義', times: 1 }])
    assert.match(b.run('file').out, /→ 課程\/作業系統\/講義\//)
  })

  test('`--course` 後面沒接東西 → 離開碼 1，一個檔都沒動', t => {
    const b = three(t)
    const code = b.codeOf(b.run('file').out, '未命名文件 (3).txt')
    assert.equal(b.run('file', '--apply', code, '--course').code, 1)
    assert.equal(b.run('file', '--apply', code, '--course', '--kind', '講義').code, 1)
    assert.equal(b.names().length, 3)
    assert.deepEqual(b.prefs(), [])
  })

  test('`--course` 沒跟 `--apply` 一起用 → 離開碼 1', t => {
    const b = three(t)
    assert.equal(b.run('file', '--course', 'OS').code, 1)
    assert.deepEqual(b.prefs(), [])
  })

  test('照單全收（不帶 --course）什麼都不學（預期行為 2）', t => {
    const b = three(t)
    assert.equal(b.run('file', '--apply').code, 0)
    assert.deepEqual(b.prefs(), [])
  })
})

describe('`rename --apply --to`（預期行為 4）', () => {
  test('改成 OS_死結 之後，另一個檔的建議變 OS_排程', t => {
    const b = three(t)
    const code = b.codeOf(b.run('rename').out, '未命名文件 (3).txt')
    const r = b.run('rename', '--apply', code, '--to', 'OS_死結')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /→ OS_死結\.txt/)
    assert.deepEqual(b.prefs(), [{ kind: 'course', k: '作業系統', v: 'OS', times: 1 }])
    const out = b.run('rename').out
    assert.match(out, /→ OS_排程\.txt　（課名照你上次改的寫）/)
    assert.match(out, /→ 資料結構_期中考範圍\.txt/, '名字裡沒有那個課名的不受影響')
  })

  test('`--to` 一次只能指名一個檔', t => {
    const b = three(t)
    const r = b.run('rename', '--apply', '--to', 'X')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /一次只能指名一個檔/)
    assert.equal(b.names().length, 3)
  })

  test('`--to` 沒跟 `--apply` 一起用 → 離開碼 1', t => {
    const b = three(t)
    assert.equal(b.run('rename', '--to', 'X').code, 1)
  })
})

describe('退過貨的不預設做（預期行為 5）', () => {
  test('`file --undo` 之後，不給編號的 `--apply` 跳過它，而且講出來', t => {
    const b = three(t)
    const code = b.codeOf(b.run('file').out, '未命名文件 (3).txt')
    b.run('file', '--apply', code)
    b.run('file', '--undo')
    const listed = b.run('file').out
    assert.match(listed, /⟲ 你上次退過這個建議/)
    const r = b.run('file', '--apply')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /1 個你上次退過的沒有算進去/)
    const tree = b.filedTree().filter(p => p.endsWith('.txt'))
    assert.equal(tree.includes('課程/作業系統/筆記/未命名文件 (3).txt'), false, '退過貨的不可以被默默做掉')
    assert.equal(tree.length, 2)
  })

  test('指名編號還是做得到（退貨不是禁止）', t => {
    const b = three(t)
    const code = b.codeOf(b.run('file').out, '未命名文件 (3).txt')
    b.run('file', '--apply', code)
    b.run('file', '--undo')
    const again = b.codeOf(b.run('file').out, '未命名文件 (3).txt')
    const r = b.run('file', '--apply', again)
    assert.equal(r.code, 0, r.out)
    assert.ok(b.filedTree().includes('課程/作業系統/筆記/未命名文件 (3).txt'))
    // 重新做一次成功 → 那個標記消失
    assert.deepEqual(b.prefs(), [])
  })

  test('`rename --undo` 之後也一樣', t => {
    const b = three(t)
    const code = b.codeOf(b.run('rename').out, '未命名文件 (3).txt')
    b.run('rename', '--apply', code)
    b.run('rename', '--undo')
    const out = b.run('rename').out
    assert.match(out, /⟲ 你上次退過這個建議/)
    const r = b.run('rename', '--apply')
    assert.match(r.out, /1 個你上次退過的沒有算進去/)
    assert.ok(b.names().includes('未命名文件 (3).txt'), '退過貨的名字沒有被改掉')
  })
})

describe('`learned`（預期行為 7）', () => {
  test('什麼都沒學過 → 離開碼 0，講一句人話', t => {
    const b = three(t)
    const r = b.run('learned')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /還沒學到任何東西/)
  })

  test('學過之後列得出來，三種各講各的', t => {
    const b = three(t)
    const code = b.codeOf(b.run('file').out, '未命名文件 (3).txt')
    b.run('file', '--apply', code, '--course', 'OS', '--kind', '講義')
    const two = b.codeOf(b.run('file').out, '未命名文件 (4).txt')
    b.run('file', '--apply', two)
    b.run('file', '--undo')

    const r = b.run('learned')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /課名　模型說「作業系統」 ・ 你要「OS」・用過 1 次/)
    assert.match(r.out, /類型　作業系統／筆記 的東西 ・ 你要「講義」・用過 1 次/)
    assert.match(r.out, /退過貨　你上次退掉了「課程\/OS\/講義」這個建議/)
    // **沒有絕對路徑、沒有檔案內容**（預期行為 11）
    for (const leak of [b.home, b.downloads, b.filed, FAKE_HOME]) assert.ok(!r.out.includes(leak), r.out)
    assert.ok(!r.out.includes('死結的四個必要條件'), r.out)
  })

  test('`--forget <編號>` 之後那一條不再影響建議', t => {
    const b = three(t)
    const code = b.codeOf(b.run('file').out, '未命名文件 (3).txt')
    b.run('file', '--apply', code, '--course', 'OS')
    assert.match(b.run('file').out, /→ 課程\/OS\/筆記\//)
    const id = /\[([0-9a-f]+)\]/.exec(b.run('learned').out)[1]
    const r = b.run('learned', '--forget', id)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /忘掉 1 條了/)
    assert.match(b.run('file').out, /→ 課程\/作業系統\/筆記\//)
    assert.deepEqual(b.prefs(), [])
  })

  test('`--forget` 打錯編號：什麼都不做，離開碼 1', t => {
    const b = three(t)
    const code = b.codeOf(b.run('file').out, '未命名文件 (3).txt')
    b.run('file', '--apply', code, '--course', 'OS')
    for (const bad of ['zzzz', 'ab', '']) {
      const r = b.run('learned', '--forget', bad)
      assert.equal(r.code, 1, `${bad}：${r.out}`)
    }
    assert.equal(b.prefs().length, 1, '一條都不可以少')
  })

  test('`--forget-all` 全清', t => {
    const b = three(t)
    const code = b.codeOf(b.run('file').out, '未命名文件 (3).txt')
    b.run('file', '--apply', code, '--course', 'OS', '--kind', '講義')
    const r = b.run('learned', '--forget-all')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /全部忘掉了（2 條）/)
    assert.deepEqual(b.prefs(), [])
    assert.match(b.run('learned').out, /還沒學到任何東西/)
  })

  test('`--forget` 與 `--forget-all` 一起用、看不懂的旗標 → 離開碼 1', t => {
    const b = three(t)
    assert.equal(b.run('learned', '--forget', 'a1b2', '--forget-all').code, 1)
    assert.equal(b.run('learned', '--all').code, 1)
  })

  test('唯讀模式：列得出來，但忘不掉（預期行為 8）', t => {
    const b = three(t)
    const code = b.codeOf(b.run('file').out, '未命名文件 (3).txt')
    b.run('file', '--apply', code, '--course', 'OS')
    // 設定改成唯讀之後再跑
    const cfg = join(b.home, 'config.json')
    const raw = JSON.parse(readFileSync(cfg, 'utf8'))
    writeFileSync(cfg, JSON.stringify({ ...raw, readonly: true }))
    assert.equal(b.run('learned').code, 0)
    const r = b.run('learned', '--forget-all')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /唯讀模式/)
    assert.equal(b.prefs().length, 1)
  })

  test('資料表不見了：列得出來、不噴堆疊（預期行為 9）', t => {
    const b = three(t)
    const db = openDb(b.dbPath)
    try { db.exec('DROP TABLE preferences') } finally { db.close() }
    const r = b.run('learned')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /還沒學到任何東西/)
    assert.ok(!/ at .*\.ts:\d+/.test(r.out), `不可以噴堆疊：\n${r.out}`)
    // 建議那兩條也照樣走得完
    assert.equal(b.run('file').code, 0)
    assert.equal(b.run('rename').code, 0)
  })

  test('`learned` 不動任何檔案', t => {
    const b = three(t)
    const before = b.names()
    b.run('learned')
    b.run('learned', '--forget-all')
    assert.deepEqual(b.names(), before)
    assert.equal(existsSync(b.filed), false)
  })

  test('說明裡有 learned', t => {
    const b = three(t)
    assert.match(b.run().out, /node cli\.mjs learned/)
  })
})
