import './helpers/isolate-home.mjs'   // 一定要第一個 import
import { rmTmp } from './helpers/rm.mjs'
/**
 * 「在檔案總管裡指給我看」（2026-09-22）。規格見 core/reveal-routes.ts 的檔頭。
 *
 * 這是這個專案裡**第二支會叫作業系統做事的程式**，所以測的重點不是「開得起來嗎」，
 * 而是**開不起來的那幾種一定要擋住**：
 *
 *   · 路徑永遠不從呼叫端來（送 path 進去要被當成「看不懂」）
 *   · 只開得了我們自己管的那幾棵樹，而且**先解捷徑再比**
 *   · 捷徑本身不跟、不是檔案不開、檔不在了要講人話
 *
 * **成功那一條刻意不測**：它會真的開一個檔案總管視窗。
 * 會開的那一行只有一行（spawn），值錢的是上面那幾關。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open as openDb } from '../core/db.ts'
import { WINDOWS_REVEAL_PS, revealCommand, revealFallback, revealable, revealRoutes } from '../core/reveal-routes.ts'

const DAY = 86400_000

function sandbox(t, files = []) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-reveal-')))
  const downloads = join(dir, 'Downloads')
  const outside = join(dir, 'Elsewhere')
  mkdirSync(downloads)
  mkdirSync(outside)
  const db = openDb(join(dir, 'data.db'))
  t.after(() => { db.close(); rmTmp(dir) })
  const at = new Date(Date.now() - DAY).toISOString()
  const add = (id, path, name) => {
    writeFileSync(path, 'x'.repeat(200))
    db.prepare(
      `INSERT INTO file_items (id, path, name, ext, bytes, status, first_seen_at, last_seen_at, mtime)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(id, path, name, '.txt', 200, 'candidate', at, at, at)
  }
  for (const [id, name] of files) add(id, join(downloads, name), name)
  return { dir, downloads, outside, db, add }
}

/** 直接呼叫 route，不起 server。回 { code, body }。 */
function call(s, body, over = {}) {
  let out = null
  const handled = revealRoutes({
    db: s.db,
    roots: [s.downloads],
    quarantine: join(s.dir, 'quarantine'),
    url: new URL('http://127.0.0.1/reveal'),
    method: 'POST',
    body,
    send: (code, payload) => { out = { code, body: payload } },
    scan: () => { throw new Error('reveal does not scan') },
    ...over,
  })
  return { handled, ...out }
}

// ═══ 純函式 ═══════════════════════════════════════════════════

describe('revealCommand：每個平台各自的寫法，而且不經過 shell', () => {
  const B = String.fromCharCode(92)

  // 使用者 2026-09-22：「應該只有我按下 open 的第一次要跳出檔案總管，
  //                      第二次應該要用現有的視窗跳轉即可」
  test('**Windows 走 Shell COM 重用視窗**，不是每次開一個新的', () => {
    const cmd = revealCommand('C:' + B + 'a b' + B + 'x.txt', 'win32')
    assert.equal(cmd.bin, 'powershell.exe')
    assert.ok(cmd.argv.includes('-NoProfile'))
    assert.ok(WINDOWS_REVEAL_PS.includes('Shell.Application'), '沒有去問現有的視窗')
    assert.ok(WINDOWS_REVEAL_PS.includes('Navigate2'), '找不到同資料夾時要導航現有視窗')
    assert.ok(WINDOWS_REVEAL_PS.includes('SelectItem'), '要把那個檔選起來')
    assert.ok(WINDOWS_REVEAL_PS.includes('Start-Process explorer.exe'), '一個視窗都沒有時才開新的')
  })

  // 檔名是不可信的輸入。拼進腳本就是一條注入路徑。
  test('**路徑走環境變數，一個字都不拼進 PowerShell 腳本**', () => {
    const nasty = 'C:' + B + "a'; Remove-Item C:" + B + '*; #' + B + 'x.txt'
    const cmd = revealCommand(nasty, 'win32')
    assert.deepEqual(cmd.env, { CONTEXTBOX_REVEAL_TARGET: nasty })
    assert.ok(!cmd.argv.join(' ').includes('Remove-Item'), '使用者的檔名跑進腳本裡了')
    assert.ok(WINDOWS_REVEAL_PS.includes('$env:CONTEXTBOX_REVEAL_TARGET'))
  })

  // PowerShell 的跳脫字元是反引號，不是反斜線 —— 用反斜線跳脫會把字串切斷
  test('腳本裡那段 C# 用單引號包，沒有反斜線跳脫', () => {
    assert.ok(!WINDOWS_REVEAL_PS.includes(B + '"'), '反斜線跳脫在 PowerShell 裡會斷掉字串')
    assert.ok(WINDOWS_REVEAL_PS.includes('Add-Type'))
  })

  test('沒有 PowerShell 的退路還是開得了（一定是新視窗，但有總比沒有好）', () => {
    const back = revealFallback('C:' + B + 'a.txt', 'win32')
    assert.equal(back.bin, 'explorer.exe')
    assert.deepEqual(back.argv, ['/select,C:' + B + 'a.txt'])
    assert.equal(revealFallback('/a.txt', 'darwin'), null, '只有 Windows 需要退路')
  })

  // 使用者 2026-09-22：「也要確認實作的部分 mac 的系統也是可以運行的」
  test('macOS 是 open -R —— **Finder 本來就用現有的視窗**，不必特別處理', () => {
    assert.deepEqual(revealCommand('/a b/x&y.txt', 'darwin'), { bin: 'open', argv: ['-R', '/a b/x&y.txt'] })
  })

  test('Linux 沒有通用的 reveal → 開**父資料夾**，不是那個檔', () => {
    const cmd = revealCommand('/a b/x.txt', 'linux')
    assert.equal(cmd.bin, 'xdg-open')
    assert.deepEqual(cmd.argv, ['/a b'], '開檔案本身等於執行它')
  })

  test('**檔名裡的殼層字元只是字元**：引數是陣列，一個都沒被拼進命令列', () => {
    const nasty = '/tmp/a & b; rm -rf $(echo x)/`id`.txt'
    for (const platform of ['darwin', 'linux']) {
      const cmd = revealCommand(nasty, platform)
      assert.ok(cmd.argv.every(x => typeof x === 'string'))
      assert.equal(cmd.env, undefined, '非 Windows 不需要環境變數')
    }
  })
})
describe('revealable：只認我們自己管的那幾棵樹', () => {
  test('在範圍裡 → true；在範圍外 → false', t => {
    const s = sandbox(t)
    const inside = join(s.downloads, 'a.txt')
    const outside = join(s.outside, 'b.txt')
    writeFileSync(inside, 'x')
    writeFileSync(outside, 'x')
    assert.equal(revealable(inside, [s.downloads]), true)
    assert.equal(revealable(outside, [s.downloads]), false)
  })

  test('根目錄不存在就跳過它，不會整個丟例外', t => {
    const s = sandbox(t)
    const inside = join(s.downloads, 'a.txt')
    writeFileSync(inside, 'x')
    assert.equal(revealable(inside, [join(s.dir, 'gone'), s.downloads]), true)
    assert.equal(revealable(inside, []), false)
  })

  // **先解捷徑再比**：字串比對會被一個捷徑整個繞過去
  test('範圍裡的捷徑指到外面 → 還是 false', t => {
    const s = sandbox(t)
    const real = join(s.outside, 'secret.txt')
    writeFileSync(real, 'x')
    const link = join(s.downloads, 'looks-local.txt')
    try { symlinkSync(real, link, 'file') }
    catch { t.skip('這台機器不給建捷徑（Windows 要權限）'); return }
    assert.equal(revealable(link, [s.downloads]), false, '解過捷徑之後它不在範圍裡')
  })
})

// ═══ route ═══════════════════════════════════════════════════

describe('POST /reveal 的每一道關', () => {
  test('**路徑不可以從呼叫端來**：送 path 進去是「看不懂」', t => {
    const s = sandbox(t, [['i0', 'a.txt']])
    const r = call(s, { path: 'C:/Windows' })
    assert.equal(r.code, 400)
    assert.match(r.body.error, /only takes itemId/)
  })

  test('itemId 之外多一個欄位也擋掉（拼錯的欄位不可以變成預設動作）', t => {
    const s = sandbox(t, [['i0', 'a.txt']])
    assert.equal(call(s, { itemId: 'i0', andAlso: 'x' }).code, 400)
  })

  test('itemId 不是字串、空的、太長 → 400', t => {
    const s = sandbox(t, [['i0', 'a.txt']])
    for (const bad of [null, 42, '', 'x'.repeat(201), { a: 1 }]) {
      assert.equal(call(s, { itemId: bad }).code, 400, JSON.stringify(bad))
    }
    assert.equal(call(s, null).code, 400)
    assert.equal(call(s, []).code, 400)
  })

  test('沒有這個 id → 404，講得出下一步', t => {
    const s = sandbox(t, [['i0', 'a.txt']])
    const r = call(s, { itemId: 'nope' })
    assert.equal(r.code, 404)
    assert.match(r.body.error, /no file with that id/)
  })

  test('檔已經不在了 → 409，而且講的是人話（使用者最常撞到這個）', t => {
    const s = sandbox(t, [['i0', 'a.txt']])
    rmSync(join(s.downloads, 'a.txt'))
    const r = call(s, { itemId: 'i0' })
    assert.equal(r.code, 409)
    assert.match(r.body.error, /not there any more/)
  })

  test('**範圍外的檔不開**，就算資料庫裡有它', t => {
    const s = sandbox(t, [])
    s.add('out', join(s.outside, 'b.txt'), 'b.txt')
    const r = call(s, { itemId: 'out' })
    assert.equal(r.code, 403)
    assert.match(r.body.error, /outside the folders/)
  })

  test('捷徑本身不跟', t => {
    const s = sandbox(t, [])
    const real = join(s.downloads, 'real.txt')
    writeFileSync(real, 'x')
    const link = join(s.downloads, 'link.txt')
    try { symlinkSync(real, link, 'file') }
    catch { t.skip('這台機器不給建捷徑'); return }
    s.add('lnk', link, 'link.txt')
    const r = call(s, { itemId: 'lnk' })
    assert.equal(r.code, 409)
    assert.match(r.body.error, /shortcut/)
  })

  test('是資料夾不是檔 → 409', t => {
    const s = sandbox(t, [])
    const sub = join(s.downloads, 'folder')
    mkdirSync(sub)
    s.db.prepare(
      `INSERT INTO file_items (id, path, name, ext, bytes, status, first_seen_at, last_seen_at, mtime)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run('dir', sub, 'folder', '', 0, 'candidate', '2026-01-01', '2026-01-01', '2026-01-01')
    assert.equal(call(s, { itemId: 'dir' }).code, 409)
  })

  test('GET 這條路是 405，不是 404（路徑存在，只是方法不對）', t => {
    const s = sandbox(t, [['i0', 'a.txt']])
    const r = call(s, {}, { method: 'GET' })
    assert.equal(r.code, 405)
  })

  test('別的路徑一律不接（回 false 讓下一個 route 處理）', t => {
    const s = sandbox(t, [['i0', 'a.txt']])
    let touched = false
    const handled = revealRoutes({
      db: s.db, roots: [s.downloads], quarantine: '',
      url: new URL('http://127.0.0.1/cleanup/candidates'),
      method: 'GET', body: null,
      send: () => { touched = true },
      scan: () => {},
    })
    assert.equal(handled, false)
    assert.equal(touched, false, '不認得的路徑不可以回應')
  })

  // **回去的東西沒有絕對路徑**（不變量 8）：面板不需要知道，知道了就是一條新的外洩面
  test('拒絕的訊息裡不會夾帶絕對路徑', t => {
    const s = sandbox(t, [])
    s.add('out', join(s.outside, 'b.txt'), 'b.txt')
    const r = call(s, { itemId: 'out' })
    assert.ok(!JSON.stringify(r.body).includes(s.outside), JSON.stringify(r.body))
    assert.ok(!JSON.stringify(r.body).includes('b.txt'), JSON.stringify(r.body))
  })
})
