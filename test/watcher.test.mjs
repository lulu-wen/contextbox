/**
 * 監看的測試。
 *
 * 這一支最容易寫成「睡一秒再看看」的爛測試，所以大部分案例都是**自己驅動**：
 * 手動呼叫 poll() 與 tick()，時間由我們控制。只有最後一個案例用真的 fs.watch。
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, renameSync,
         symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { createWatcher, walk } from '../core/watcher.ts'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const SETTLE = 60

/**
 * 落地判定要「夠久沒變」**而且**「至少量到兩次一樣」，所以要 tick 兩次。
 * 第二個條件是為了少一點誤判：只靠時間的話，寫檔的人停頓一下就會被當成寫完。
 */
const settle = async w => { await sleep(SETTLE + 20); w.tick(); w.tick() }

let root, watchDir
before(() => {
  root = mkdtempSync(join(tmpdir(), 'cb-watch-'))
  watchDir = join(root, 'Downloads')
  mkdirSync(watchDir, { recursive: true })
})
after(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  // 每個案例自己一個乾淨的資料夾
  rmSync(watchDir, { recursive: true, force: true })
  mkdirSync(watchDir, { recursive: true })
})

/** 做一個不會自己跑的 watcher，時間由測試控制 */
function mk(extra = {}) {
  const fired = []
  const problems = []
  let seeded = 0
  const w = createWatcher({
    roots: [watchDir],
    maxBytes: 1024 * 1024,
    settleMs: SETTLE,
    tickMs: 10,
    pollMs: 0,                       // 不要自己輪詢
    onFile: v => fired.push(basename(v.real)),
    onProblem: m => problems.push(m),
    onSeed: n => { seeded = n },
    ...extra,
  })
  return { w, fired, problems, seen: () => seeded }
}

const put = (name, content = 'hello') => {
  const p = join(watchDir, name)
  writeFileSync(p, content)
  return p
}

describe('等它寫完', () => {
  test('剛落地的檔案不會馬上送出去', async () => {
    const { w, fired } = mk()
    put('a.png')
    w.poll()
    assert.equal(w.pendingCount(), 1, '應該進待定區')
    w.tick()
    assert.deepEqual(fired, [], '時間還沒到，不該送出')

    await settle(w)
    assert.deepEqual(fired, ['a.png'])
    assert.equal(w.pendingCount(), 0)
  })

  test('還在長大的檔案，計時要重來', async () => {
    const { w, fired } = mk()
    const p = put('b.png', 'x')
    w.poll()

    await sleep(SETTLE + 20)
    appendFileSync(p, 'more')          // 又寫了一塊
    w.tick()
    assert.deepEqual(fired, [], '大小變了，要重新等')

    w.tick()
    assert.deepEqual(fired, [], '重新等的時間還沒到')

    await settle(w)
    assert.deepEqual(fired, ['b.png'], '這次真的寫完了')
  })

  test('等的期間被搬走就算了', async () => {
    const { w, fired } = mk()
    const p = put('c.png')
    w.poll()
    renameSync(p, join(root, 'moved.png'))
    await settle(w)
    assert.deepEqual(fired, [])
    assert.equal(w.pendingCount(), 0)
  })

  test('同一個檔案只送一次', async () => {
    const { w, fired } = mk()
    put('d.png')
    w.poll(); w.poll(); w.poll()
    await settle(w)
    w.poll(); w.tick()
    assert.deepEqual(fired, ['d.png'])
  })
})

describe('半成品', () => {
  test('.crdownload 不進待定區，改成正式副檔名之後才算', async () => {
    const { w, fired } = mk()
    const part = put('e.png.crdownload')
    w.poll()
    assert.equal(w.pendingCount(), 0, '還在下載，不該碰它')

    renameSync(part, join(watchDir, 'e.png'))
    w.poll()
    assert.equal(w.pendingCount(), 1)
    await settle(w)
    assert.deepEqual(fired, ['e.png'])
  })

  test('不收的副檔名連待定區都不進', () => {
    const { w } = mk()
    put('f.exe'); put('g.docx'); put('h')
    w.poll()
    assert.equal(w.pendingCount(), 0)
  })
})

describe('被防線擋下的', () => {
  test('空檔案：出聲，但不送給下一關', async () => {
    const { w, fired, problems } = mk()
    put('i.png', '')
    w.poll()
    await settle(w)
    assert.deepEqual(fired, [])
    assert.equal(problems.length, 1)
    assert.match(problems[0], /空的/)
  })

  test('被擋下的不會每次輪詢都再吵一次', async () => {
    // 0 byte 是暫時的，所以會重試——但只有第一次跟放棄那次要出聲
    const { w, problems } = mk({ maxRetries: 99 })
    put('j.png', '')
    for (let i = 0; i < 4; i++) { w.poll(); await settle(w) }
    assert.equal(problems.length, 1, '每一輪都吵一次的話，健康列會被洗版')
  })
})

describe('開機不要湧入', () => {
  test('既有的檔案標成已見，不進收件匣', async () => {
    const { w, fired, seen } = mk()
    put('old1.png'); put('old2.png'); put('old3.png')

    w.start()
    assert.equal(seen(), 3, '三個舊檔都要回報給呼叫端')
    w.tick()
    assert.deepEqual(fired, [], '舊檔一個都不該進收件匣')

    // 之後才落地的才算新的
    put('new.png')
    w.poll()
    await settle(w)
    assert.deepEqual(fired, ['new.png'])
    w.stop()
  })

  test('不 seed 的話舊檔就會全部進來', async () => {
    const { w, fired } = mk()
    put('k1.png'); put('k2.png')
    w.start(false)
    w.poll()
    await settle(w)
    assert.equal(fired.length, 2)
    w.stop()
  })
})

describe('walk', () => {
  test('只撿看起來像的，捷徑不跟，深度有上限', () => {
    mkdirSync(join(watchDir, 'a', 'b', 'c', 'd', 'e'), { recursive: true })
    put('top.png')
    writeFileSync(join(watchDir, 'a', 'one.png'), 'x')
    writeFileSync(join(watchDir, 'a', 'b', 'c', 'd', 'e', 'deep.png'), 'x')
    put('skip.exe')
    mkdirSync(join(watchDir, '.git'), { recursive: true })
    writeFileSync(join(watchDir, '.git', 'x.png'), 'x')

    const found = walk(watchDir, 2).files.map(p => basename(p)).sort()
    assert.deepEqual(found, ['one.png', 'top.png'], '深的、不收的、.git 裡的都不該出現')
  })

  test('真的不跟捷徑，包括指回上層的那種', () => {
    // 這個案例以前只有名字寫著「捷徑不跟」，內容裡一個 symlink 都沒有。
    put('real.png')
    symlinkSync(join(watchDir, 'real.png'), join(watchDir, 'link.png'))
    mkdirSync(join(watchDir, 'sub'), { recursive: true })
    symlinkSync(watchDir, join(watchDir, 'sub', 'loop'))     // 指回上層＝無窮迴圈
    const found = walk(watchDir, 4).files.map(p => basename(p)).sort()
    assert.deepEqual(found, ['real.png'], '捷徑不該被撿，也不該走進去')
  })

  test('檔案數有上限，而且到上限要出聲', () => {
    for (let i = 0; i < 20; i++) put(`m${i}.png`)
    const r = walk(watchDir, 2, 5)
    assert.equal(r.files.length, 5)
    assert.equal(r.truncated, true, '安靜截斷的話，後面的檔案永遠掃不到')

    const { w, problems } = mk({ maxFiles: 5 })
    w.poll()
    assert.ok(problems.some(m => /超過 5 個/.test(m)), '要告訴使用者有東西沒掃到')
  })
})

describe('不可以弄丟檔案', () => {
  test('0 byte 被擋過之後，內容寫進去要能救回來', async () => {
    // 截圖工具常常先建一個 0 byte 的檔，一秒多之後才寫內容。
    // 第一版看到「檔案是空的」就永遠不再看它一眼。
    const { w, fired, problems } = mk()
    const p = put('shot.png', '')
    w.poll(); await settle(w)
    assert.deepEqual(fired, [], '空檔案這一刻確實不該送出去')
    assert.ok(problems.some(m => /空的/.test(m)))

    writeFileSync(p, '這次真的有內容了')
    w.poll(); await settle(w)
    assert.deepEqual(fired, ['shot.png'], '內容寫進去之後要救得回來')
  })

  test('暫時失敗重試有次數上限，不會無限吵', async () => {
    const { w, problems } = mk({ maxRetries: 3 })
    put('empty.png', '')
    for (let i = 0; i < 8; i++) { w.poll(); await settle(w) }
    assert.ok(problems.length <= 3, `試太多次了，講了 ${problems.length} 次`)
    assert.ok(problems.some(m => /放棄/.test(m)), '放棄的時候要講一聲')
  })

  test('onFile 丟例外（例如資料庫被鎖住），檔案不可以就這樣消失', async () => {
    let boom = true
    const fired = []
    const problems = []
    const w = createWatcher({
      roots: [watchDir], maxBytes: 1e6, settleMs: SETTLE, tickMs: 10, pollMs: 0,
      onFile: v => { if (boom) throw new Error('database is locked'); fired.push(basename(v.real)) },
      onProblem: m => problems.push(m),
    })
    put('important.png')
    w.poll(); await settle(w)
    assert.deepEqual(fired, [])
    assert.ok(problems.some(m => /database is locked/.test(m)))

    boom = false                                  // 鎖放掉了
    w.poll(); await settle(w)
    assert.deepEqual(fired, ['important.png'], '鎖放掉之後要救得回來')
  })

  test('同名覆蓋要再送一次', async () => {
    // Windows 的截圖編號（螢幕擷取 (1).png）在舊檔刪掉後會重複使用
    const { w, fired } = mk()
    const p = put('same.png', 'v1')
    w.poll(); await settle(w)
    assert.equal(fired.length, 1)

    writeFileSync(p, 'v2 完全不同的內容')
    w.poll(); await settle(w)
    assert.equal(fired.length, 2, '內容變了就是新的事件')
  })

  test('內容真的沒變就不要重送', async () => {
    const { w, fired } = mk()
    put('stable.png', 'v1')
    w.poll(); await settle(w)
    for (let i = 0; i < 5; i++) { w.poll(); await sleep(20); w.tick() }
    assert.equal(fired.length, 1)
  })
})

describe('stop 之後就真的停了', () => {
  test('停過的 watcher 不會再收檔', async () => {
    const { w, fired } = mk()
    w.start(false)
    w.stop()
    put('after-stop.png')
    w.poll(); await settle(w)
    assert.deepEqual(fired, [], '停過的還在動的話，Ctrl+C 之後還會寫資料庫')
    assert.equal(w.pendingCount(), 0)
  })
})

describe('已見不會無限長大', () => {
  test('超過上限就丟掉最舊的', async () => {
    const { w } = mk({ maxSeen: 5 })
    for (let i = 0; i < 12; i++) put(`big${i}.png`)
    w.poll(); await settle(w)
    assert.ok(w.seenCount() <= 5, `常駐好幾天會一直長大，現在有 ${w.seenCount()} 筆`)
  })

  test('**淘汰不可以變成週期性重送**', async () => {
    // 被擠掉的檔案還在資料夾裡，下一輪查不到指紋就會被當成新檔重送，
    // 又擠掉另一個 —— 一個永遠停不下來的迴圈。而每一次重送都會把
    // 整個檔案讀進來算指紋（使用者的 Pictures 是 OneDrive 檔案隨選）。
    const { w, fired } = mk({ maxSeen: 5 })
    for (let i = 0; i < 8; i++) put(`ev${i}.png`, 'x' + i)

    w.poll(); await settle(w)
    const first = fired.length

    // 什麼都不做，只是一直輪詢
    for (let round = 0; round < 5; round++) { w.poll(); await settle(w) }
    assert.equal(fired.length, first,
      `沒有任何檔案變動，卻多送了 ${fired.length - first} 次`)
  })

  test('淘汰之後，真的有變的檔案還是要送得出來', async () => {
    const { w, fired } = mk({ maxSeen: 3 })
    for (let i = 0; i < 6; i++) put(`ch${i}.png`, 'x' + i)
    w.poll(); await settle(w)
    const before = fired.length

    writeFileSync(join(watchDir, 'ch0.png'), '這一份真的改了，而且是現在改的')
    w.poll(); await settle(w)
    assert.equal(fired.length, before + 1, '水位線不可以把真正的變動一起擋掉')
  })
})

describe('真的 fs.watch', () => {
  test('檔案落地會自己被看到，不用等輪詢', async () => {
    const { w, fired } = mk()
    w.start()
    await sleep(50)                    // 讓 watch 掛上去
    put('live.png')

    for (let i = 0; i < 40 && !fired.length; i++) {
      await sleep(25)
      w.tick()
    }
    w.stop()
    assert.deepEqual(fired, ['live.png'], 'fs.watch 應該要有發事件（沒發的話就得靠保底輪詢）')
  })
})
