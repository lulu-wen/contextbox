/**
 * CLI 的測試。
 *
 * 這支檔案原本也是一條都沒有 —— 而「搜尋一個帶減號的檔名會帶著堆疊崩掉」
 * 跟「收過的檔案回傳失敗的離開碼」，隨便一個最粗淺的 smoke test 都會抓到。
 *
 * **離開碼是三個作業系統右鍵選單的契約**，所以每一條都要斷言。
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import * as sqlite from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(REPO, 'cli.mjs')

let root, watchDir, cfgPath, dbPath

before(() => {
  root = mkdtempSync(join(tmpdir(), 'cb-cli-'))
  watchDir = join(root, 'Downloads')
  mkdirSync(watchDir, { recursive: true })
  cfgPath = join(root, 'config.json')
  dbPath = join(root, 'data.db')
  writeFileSync(cfgPath, JSON.stringify({
    watch: [watchDir],
    filed: join(root, 'Filed'),
    // 故意不設模型：doctor 才不會真的去打網路
    model: { baseUrl: '', name: '', keyEnv: 'CONTEXTBOX_MODEL_KEY' },
    readonly: false, pdfPages: 3, maxBytes: 20971520,
  }))
})
after(() => rmSync(root, { recursive: true, force: true }))

/** 跑一次 CLI。回 { code, out } */
function run(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CONTEXTBOX_CONFIG: cfgPath, CONTEXTBOX_DB: dbPath },
  })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

/** ESM 裡沒有 require，包一層讓上面的測試讀得順 */
const requireSqlite = () => sqlite

const put = (name, content = 'hello') => {
  const p = join(watchDir, name)
  writeFileSync(p, content)
  return p
}

describe('doctor', () => {
  test('跑得起來，而且講得出監看有沒有在跑', () => {
    const r = run('doctor')
    assert.equal(r.code, 0)
    assert.match(r.out, /監看/)
    assert.match(r.out, /從來沒跑過/, '沒人在看的時候要講清楚，不是顯示一切正常')
  })

  test('模型沒設定就直說，不要假裝沒事', () => {
    assert.match(run('doctor').out, /模型\s+✗ 還沒設定/)
  })
})

describe('propose 的離開碼', () => {
  test('新檔案：0', () => {
    const r = run('propose', put('a.png'))
    assert.equal(r.code, 0)
    assert.match(r.out, /收了 1 個新檔案/)
  })

  test('已經收過了也是 0 —— 那是成功', () => {
    // 回非零的話，Windows／Nautilus 的右鍵選單會跳一個錯誤視窗，
    // 而畫面上明明寫著 ✓。
    const p = put('b.png')
    assert.equal(run('propose', p).code, 0)
    const again = run('propose', p)
    assert.equal(again.code, 0, '「已經收過了」不是失敗')
    assert.match(again.out, /之前就收過/)
  })

  test('被擋下來：非 0', () => {
    assert.notEqual(run('propose', '/etc/hosts').code, 0)
    assert.match(run('propose', '/etc/hosts').out, /不在監看資料夾裡/)
  })

  test('一半成功一半被擋：算成功，但要講清楚', () => {
    const r = run('propose', put('c.png'), '/etc/hosts')
    assert.equal(r.code, 0)
    assert.match(r.out, /1 個被擋下/)
  })

  test('沒給路徑：非 0', () => {
    assert.notEqual(run('propose').code, 0)
  })
})

describe('search 不可以崩', () => {
  test('這些字元都很常見，一個都不准噴堆疊', () => {
    // 「搜一個檔名」是這個工具最自然的用法，而檔名幾乎一定有點或減號。
    for (const q of ['invoice-2026', '2026/09', 'shot.png', 'a"b', '*', 'a(b',
                     'NEAR(', '發票 OR', 'C++', '價格 $100']) {
      const r = run('search', q)
      assert.equal(r.code, 0, `search ${q} 崩了：${r.out}`)
      assert.ok(!/ERR_SQLITE|at file:/.test(r.out), `search ${q} 噴了堆疊：${r.out}`)
    }
  })

  test('兩個字的中文也要有答案，不可以靜靜回找不到就算了', () => {
    // trigram 索引至少要三個字元。中文的詞大多是兩個字
    // （發票、收據、學費），所以短詞要走另一條路。
    const r = run('search', '發票')
    assert.equal(r.code, 0)
    assert.match(r.out, /找不到|還沒被看懂/)
  })

  test('沒給字詞：非 0', () => {
    assert.notEqual(run('search').code, 0)
  })
})

describe('search 的萬用字元', () => {
  test('**打一個 % 不可以把整個資料庫倒出來**', () => {
    // LIKE 的 % 與 _ 是萬用字元。不跳脫的話 `search %` 會把每一張截圖
    // 抄下來的字全部印在畫面上。
    // 先放一筆真的資料進去，不然這個測試不可能失敗（假綠）。
    run('propose', put('secretdoc.png', '內容'))
    const { DatabaseSync } = requireSqlite()
    const db = new DatabaseSync(dbPath)
    const id = db.prepare(`SELECT id FROM items WHERE path LIKE '%secretdoc.png'`).get().id
    db.prepare(`INSERT INTO items_fts (item_id,name,summary,text,tags) VALUES (?,?,?,?,?)`)
      .run(id, 'secretdoc.png', '這是一份機密文件', '密碼 hunter2', '[]')
    db.close()

    // 先確認那筆資料真的搜得到，這個測試才有意義
    assert.match(run('search', '機密文件').out, /secretdoc/, '先確認資料真的在裡面')

    for (const q of ['%', '_', '貓%', '%_%']) {
      const r = run('search', q)
      assert.equal(r.code, 0, `search ${q} 崩了`)
      assert.ok(!/機密文件|hunter2/.test(r.out), `search ${q} 把資料倒出來了：${r.out}`)
    }
  })
})

describe('doctor 的心跳不可以說謊', () => {
  test('那個行程已經不在了，就不可以說「還活著」', () => {
    // 心跳只證明「它上次寫的時候還活著」。被 kill -9 掉的話心跳會停在那裡，
    // 而 doctor 以前會繼續說「✓ 3 秒前還活著」說滿五分鐘。
    const { DatabaseSync } = requireSqlite()
    const db = new DatabaseSync(dbPath)
    db.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`)
    const set = (k, v) => db.prepare(
      `INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(k, v)
    set('watch_heartbeat', new Date().toISOString())
    set('watch_pid', '2147483646')          // 幾乎不可能存在的 pid
    db.close()

    const r = run('doctor')
    assert.match(r.out, /已經不在了/, '行程死掉就要直說')
    assert.ok(!/✓.*還活著/.test(r.out))
  })
})

describe('list', () => {
  test('跑得起來', () => {
    run('propose', put('d.png'))
    const r = run('list')
    assert.equal(r.code, 0)
    assert.match(r.out, /d\.png/)
  })

  test('沒有那種狀態就直說', () => {
    assert.match(run('list', 'applied').out, /沒有狀態是 applied/)
  })
})

describe('說明', () => {
  test('不給指令就印說明，離開碼 0', () => {
    const r = run()
    assert.equal(r.code, 0)
    assert.match(r.out, /node cli\.mjs doctor/)
  })

  test('不認得的指令：非 0', () => {
    assert.notEqual(run('沒有這個指令').code, 0)
  })
})

describe('設定有問題的時候每個指令都要講', () => {
  test('不是只有 doctor 看得到警告', () => {
    const bad = join(root, 'bad-config.json')
    writeFileSync(bad, JSON.stringify({
      watch: [watchDir],
      model: { keyEnv: 'AWS_SECRET_ACCESS_KEY', baseUrl: 'http://evil.example/v1', name: 'x' },
    }))
    for (const cmd of [['list'], ['search', 'x'], ['propose', put('e.png')]]) {
      const r = spawnSync(process.execPath, [CLI, ...cmd], {
        encoding: 'utf8',
        env: { ...process.env, CONTEXTBOX_CONFIG: bad, CONTEXTBOX_DB: dbPath },
      })
      const out = (r.stdout ?? '') + (r.stderr ?? '')
      assert.match(out, /CONTEXTBOX_/, `${cmd[0]} 應該要顯示設定的警告`)
    }
  })
})
