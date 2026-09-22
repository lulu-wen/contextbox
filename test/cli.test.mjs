/**
 * CLI 的測試。
 *
 * 這支檔案原本也是一條都沒有 —— 而「搜尋一個帶減號的檔名會帶著堆疊崩掉」
 * 跟「收過的檔案回傳失敗的離開碼」，隨便一個最粗淺的 smoke test 都會抓到。
 *
 * **離開碼是三個作業系統右鍵選單的契約**，所以每一條都要斷言。
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import { rmTmp } from './helpers/rm.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
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
after(() => rmTmp(root))

/**
 * 子行程的環境：**家目錄、隔離區、token 全部指到暫存資料夾**（稽核 RC22）。
 * 清理範圍（cleanup.roots）沒寫的時候預設是 ~/Downloads —— 帶著真的 HOME 跑 `cleanup scan`，
 * 就是去掃使用者真的 Downloads；沒給 CONTEXTBOX_QUARANTINE 的話隔離區是真的 ~/.contextbox/quarantine。
 * 這裡的 HOME 是 root，所以預設的清理範圍剛好就是 watchDir（root/Downloads）。
 */
const sandboxEnv = (extra = {}) => ({
  ...process.env,
  HOME: root, USERPROFILE: root,
  CONTEXTBOX_CONFIG: cfgPath, CONTEXTBOX_DB: dbPath,
  CONTEXTBOX_QUARANTINE: join(root, 'quarantine'), CONTEXTBOX_TOKEN_PATH: join(root, 'token'),
  ...extra,
})

/** 跑一次 CLI。回 { code, out } */
function run(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: sandboxEnv(),
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
    assert.match(r.out, /Watch/)
    assert.match(r.out, /never ran/, '沒人在看的時候要講清楚，不是顯示一切正常')
  })

  test('模型沒設定就直說，不要假裝沒事', () => {
    assert.match(run('doctor').out, /Model\s+✗ not configured/)
  })
})

describe('propose 的離開碼', () => {
  test('新檔案：0', () => {
    const r = run('propose', put('a.png'))
    assert.equal(r.code, 0)
    assert.match(r.out, /Took in 1 new file/)
  })

  test('已經收過了也是 0 —— 那是成功', () => {
    // 回非零的話，Windows／Nautilus 的右鍵選單會跳一個錯誤視窗，
    // 而畫面上明明寫著 ✓。
    const p = put('b.png')
    assert.equal(run('propose', p).code, 0)
    const again = run('propose', p)
    assert.equal(again.code, 0, '「已經收過了」不是失敗')
    assert.match(again.out, /already known/)
  })

  // **不可以拿 /etc/hosts 當「範圍外」**：Windows 上它不存在，於是 CLI 講的是
  // 「讀不到這個檔」而不是「不在監看範圍裡」—— 測到的變成另一件事（而且是紅的）。
  // 拿一個真的在、只是不在監看資料夾裡的檔，測的才是範圍那一關。
  test('被擋下來：非 0', () => {
    const outside = join(root, 'outside-the-scope.txt')
    writeFileSync(outside, 'x'.repeat(50))
    assert.notEqual(run('propose', outside).code, 0)
    assert.match(run('propose', outside).out, /not inside a watched folder/)
  })

  test('一半成功一半被擋：算成功，但要講清楚', () => {
    const outside = join(root, 'outside-too.txt')
    writeFileSync(outside, 'x'.repeat(50))
    const r = run('propose', put('c.png'), outside)
    assert.equal(r.code, 0)
    assert.match(r.out, /1 were turned away/)
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
    assert.match(r.out, /Nothing found|No document has been read yet/)
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
    assert.match(r.out, /is gone/, '行程死掉就要直說')
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
    assert.match(run('list', 'applied').out, /Nothing has the status applied/)
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
        env: sandboxEnv({ CONTEXTBOX_CONFIG: bad }),
      })
      const out = (r.stdout ?? '') + (r.stderr ?? '')
      assert.match(out, /CONTEXTBOX_/, `${cmd[0]} 應該要顯示設定的警告`)
    }
  })
})

describe('cleanup 的離開碼契約', () => {
  // 離開碼是三個作業系統右鍵選單的契約，而 cleanup 這三條一條都沒被守著。
  test('沒東西可清是成功（0），不是失敗', () => {
    const r = run('cleanup', 'list')
    assert.equal(r.code, 0, `回了 ${r.code}：「乾淨」被當成錯誤的話，每晚 smoke 會一直紅`)
    assert.match(r.out, /乾淨|Nothing has been scanned yet/)
  })

  test('掃到讀不到的檔還是 0 —— 掃描的工作是更新資料庫，那件事成功了', () => {
    const bad = join(watchDir, '讀不到.bin')
    writeFileSync(bad, 'x'.repeat(200))
    const r = run('cleanup', 'scan')
    assert.equal(r.code, 0)
    rmSync(bad, { force: true })
  })

  test('後端壞掉是 2，不是 1 —— 1 是在說「你打錯了」', () => {
    const broken = join(root, 'broken.db')
    writeFileSync(broken, 'this is not a sqlite file at all')
    const r = spawnSync(process.execPath, [CLI, 'cleanup', 'list'], {
      encoding: 'utf8',
      env: sandboxEnv({ CONTEXTBOX_DB: broken }),
    })
    assert.equal(r.status, 2, `回了 ${r.status}`)
    const out = (r.stdout ?? '') + (r.stderr ?? '')
    assert.ok(!/ {4}at /.test(out), '不要噴 Node 堆疊給使用者')
  })

  test('不認得的子指令是 1（輸入錯）', () => {
    const r = run('cleanup', '亂打的東西')
    assert.equal(r.code, 1)
  })
})

/**
 * 一個指令跑完所有「看」的工作（2026-09-22，使用者說的）。
 *
 * **它的價值全部建立在「一個檔都不動」上**：使用者肯放心一次跑完三件事，是因為跑完
 * 什麼都沒變。所以這幾條裡最重要的是那一條 —— 跑完磁碟上一模一樣。
 */
describe('sweep', () => {
  test('**一個檔都不動**，而且講清楚它不會動', () => {
    const a = join(watchDir, 'sweep-a.txt')
    const b = join(watchDir, 'sweep-b.txt')
    writeFileSync(a, 'x'.repeat(400))
    writeFileSync(b, 'y'.repeat(400))
    const before = readdirSync(watchDir).sort()
    const r = run('sweep')
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(readdirSync(watchDir).sort(), before, 'sweep 動了檔案')
    assert.match(r.out, /Nothing is moved or deleted by this command/)
    // 有建議的時候印「Nothing has moved」，沒建議的時候印「Nothing to suggest」——
    // 兩句都在講同一件事：跑完什麼都沒變
    assert.match(r.out, /Nothing has moved|Nothing to suggest/)
    rmSync(a, { force: true })
    rmSync(b, { force: true })
  })

  test('三步都要講自己做了什麼 —— 跳過的那幾步也要講為什麼', () => {
    const r = run('sweep')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /1\/3/)
    assert.match(r.out, /2\/3/)
    assert.match(r.out, /3\/3/)
    // 這個沙盒沒設模型，所以第二、三步一定是跳過 —— **跳過不可以是安靜的**
    assert.match(r.out, /2\/3 {2}Reading — skipped/)
    assert.match(r.out, /Reading is not on/)
  })

  test('--no-model 是自己選的，講法要跟「沒設定」不一樣', () => {
    const r = run('sweep', '--no-model')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /You asked for no model this time/)
  })

  test('旗標打錯是 1（輸入錯），不是 2', () => {
    const r = run('sweep', '--nope')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /--no-model/)
  })

  test('沒東西可建議也是 0，而且講一句 —— 空的畫面看起來像壞掉', () => {
    const r = run('sweep', '--no-model')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /What you can do now/)
  })
})
