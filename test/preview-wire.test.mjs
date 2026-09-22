import './helpers/isolate-home.mjs'   // 一定要第一個 import：這支會起 server，見那支檔的說明
import { rmTmp } from './helpers/rm.mjs'
/**
 * P6「看得到檔案內容」的**接線**（~/contextbox-預想-20260920-P6面板分頁與預覽.md）。
 *
 * 期望值是預想那份「預期行為」十二條，在實作之前寫死。覺得哪一格錯了要寫進回報，
 * 不可以為了變綠改期望值。
 *
 * 這一支守的是**後端那一半**（第 1～8、11 條，加上縮圖可見範圍的放寬）；
 * 面板那一半在 test/preview-panel.test.mjs，分頁在 test/ui-tabs.test.mjs。
 *
 * 為什麼這一期特別小心：`GET /cleanup/preview/:itemId` 是**第一條把檔案內容送到瀏覽器的路**。
 * 做錯就是「任意檔案讀取」。所以這裡每一條都繞著同兩件事打轉 ——
 * 內容只能來自已經抽好的那兩份，可見範圍只能是面板本來就列得出來的那些。
 */
import { test, describe } from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import assert from 'node:assert/strict'
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request } from 'node:http'
import { deflateSync } from 'node:zlib'
import { open } from '../core/db.ts'
import * as scanner from '../core/cleanup-scanner.ts'
import * as routes from '../core/cleanup-routes.ts'
import { createPlan } from '../core/cleanup-plans.ts'
import { applyPlan } from '../core/cleanup-exec.ts'
import * as server from '../core/server.ts'
import { pngSize } from '../core/png.ts'
import { STORE_MAX_CHARS } from '../core/read-text.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── 素材 ─────────────────────────────────────────────────────

const CRC = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return c ^ -1
}

/** 最小的灰階 PNG（跟 test/burst-wire.test.mjs 同一支）。 */
function png(width, height, draw) {
  const row = width + 1
  const raw = Buffer.alloc(row * height, 0xff)
  for (let y = 0; y < height; y++) raw[y * row] = 0
  const set = (x, y, v) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    raw[y * row + 1 + x] = v
  }
  draw(set)
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 一張「像截圖」的圖。`badge` 讓兩張差一點點（連拍要分得出 same／similar）。 */
const shot = ({ w = 1200, h = 700, badge = 0 } = {}) => png(w, h, set => {
  const rect = (x0, y0, ww, hh, v) => {
    for (let y = y0; y < y0 + hh; y++) for (let x = x0; x < x0 + ww; x++) set(x, y, v)
  }
  rect(0, 0, w, 48, 0x22)
  for (let i = 0; i < 6; i++) rect(80, 110 + i * 40, 520 + (i % 3) * 180, 16, 0x44)
  for (let i = 0; i < badge; i++) rect(w - 90 + i * 10, h - 110, 8, 8, 0x11)
})

const DAY = 86400_000
const MIN = 60_000
const OLD = 120 * DAY

/** 這幾個字元不可以出現在畫面上（跟 safeName／shown 同一組）。 */
const NUL = String.fromCharCode(0)
const RLO = String.fromCodePoint(0x202e)
const LS = String.fromCodePoint(0x2028)

// ── 沙盒 ─────────────────────────────────────────────────────

function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-peek-')))
  const downloads = join(dir, 'Downloads')
  mkdirSync(downloads, { recursive: true })
  const db = open(join(dir, 'data.db'))
  t.after(() => {
    try { db.close() } catch { /* 已經關了 */ }
    rmSync(dir, { recursive: true, force: true })
  })
  const opts = { roots: [downloads], quarantine: join(dir, 'quarantine'), maxBytes: 16 * 1024 * 1024 }
  const scan = () => scanner.scanDownloads({ db, roots: opts.roots, maxBytes: opts.maxBytes, onProblem: () => {} })
  return { dir, downloads, db, opts, scan }
}

/** 寫一個檔，並把時間撥到 agoMs 毫秒之前。 */
function put(dir, name, content, agoMs = OLD) {
  const path = join(dir, name)
  writeFileSync(path, content)
  const at = new Date(Date.now() - agoMs)
  utimesSync(path, at, at)
  return path
}

/** 直接呼叫 route（跟 test/burst-wire.test.mjs 的 call 同一支）。 */
function call(s, method, path, extra = {}) {
  let got = null, bin = null
  const handled = routes.cleanupRoutes({
    db: s.db, roots: s.opts.roots, quarantine: s.opts.quarantine,
    maxBytes: s.opts.maxBytes, readonly: false,
    url: new URL('http://x' + path), method, body: {},
    send: (code, payload, headers) => { got = { code, body: payload, headers: headers ?? {} } },
    sendBytes: (code, type, body, headers) => { bin = { code, type, body, headers: headers ?? {} } },
    scan: () => s.scan(),
    ...extra,
  })
  return { handled, ...(got ?? {}), bin }
}

const idOf = (db, name) => db.prepare('SELECT id FROM file_items WHERE name=?').get(name)?.id
const peek = (s, id, extra) => call(s, 'GET', `/cleanup/preview/${encodeURIComponent(id)}`, extra)

// ═══ 預期行為 1 ・ 文字看得到 ════════════════════════════════

describe('P6-1 文字檔點「看內容」看得到裡面那幾行', () => {
  test('**內容照 file_texts 給，一行都沒少**；kind 是 text，而且回應裡沒有路徑', t => {
    const s = sandbox(t)
    const body = '一、排班準則\n二、先來先服務\n三、最短工作優先\n'
    put(s.downloads, '作業系統_第5章_行程排程.csv', body)
    s.scan()
    const id = idOf(s.db, '作業系統_第5章_行程排程.csv')
    const r = peek(s, id)
    assert.equal(r.code, 200, JSON.stringify(r.body))
    assert.equal(r.body.kind, 'text')
    assert.ok(r.body.text.includes('一、排班準則'), JSON.stringify(r.body.text))
    assert.ok(r.body.text.includes('三、最短工作優先'), JSON.stringify(r.body.text))
    assert.equal(r.body.truncated, false)
    assert.equal(r.body.name, '作業系統_第5章_行程排程.csv')
    assert.equal(r.body.ext, '.csv')
    assert.equal(r.body.bytes, Buffer.byteLength(body))
    assert.ok(r.body.why, '要講為什麼被列出來')
    // 回應裡不可以有任何一段真的路徑
    const raw = JSON.stringify(r.body)
    assert.ok(!raw.includes(s.downloads) && !raw.includes(s.dir), raw)
    assert.ok(!('path' in r.body) && !('folder' in r.body) && !('subdir' in r.body), raw)
  })

  test('**換行留著**：內容洗過控制字元，但不可以把整份講義擠成一行', t => {
    const s = sandbox(t)
    put(s.downloads, '講義.csv', 'A\nB\nC\n')
    s.scan()
    const r = peek(s, idOf(s.db, '講義.csv'))
    assert.equal(r.body.text.split('\n').filter(Boolean).join('|'), 'A|B|C')
  })
})

// ═══ 預期行為 2 ・ 圖看得到（縮圖，不是原圖）═══════════════════

describe('P6-2 截圖點「看內容」看得到縮圖', () => {
  test('**kind 是 image、image 指到既有的縮圖端點**，而且那條端點真的給得出圖（長邊 ≤ 480）', t => {
    const s = sandbox(t)
    put(s.downloads, 'Screenshot 2026-05-01 10.00.00.png', shot())
    s.scan()
    const id = idOf(s.db, 'Screenshot 2026-05-01 10.00.00.png')
    const r = peek(s, id)
    assert.equal(r.code, 200, JSON.stringify(r.body))
    assert.equal(r.body.kind, 'image')
    assert.equal(r.body.image, `/cleanup/thumb/${encodeURIComponent(id)}`)
    assert.equal(r.body.text, null)
    // **不是原圖**：長邊 ≤ THUMB_MAX_SIDE，而且比原檔小很多
    const got = call(s, 'GET', r.body.image)
    assert.equal(got.bin?.code, 200, JSON.stringify(got.body))
    const size = pngSize(got.bin.body)
    assert.ok(Math.max(size.width, size.height) <= routes.THUMB_MAX_SIDE, `${size.width}x${size.height}`)
    assert.ok(got.bin.body.length < r.body.bytes, '送的是縮圖不是原圖')
  })

  test('**縮圖的可見範圍跟著放寬了**：這張根本不在任何連拍組裡，以前一律 404', t => {
    const s = sandbox(t)
    put(s.downloads, 'Screenshot 孤單的一張.png', shot())
    s.scan()
    const id = idOf(s.db, 'Screenshot 孤單的一張.png')
    assert.deepEqual(call(s, 'GET', '/cleanup/bursts').body.groups, [], '前提：它不在任何一組裡')
    assert.equal(call(s, 'GET', `/cleanup/thumb/${encodeURIComponent(id)}`).bin?.code, 200)
  })

  test('**不是圖的檔一行都不讀進來**：縮圖端點對 zip／exe 要一行 SQL 就回 404（稽核 2026-09-20）', t => {
    // 可見範圍放寬之後，「面板看得到的檔」包含壓縮檔與安裝檔 —— 以前它們連可見範圍
    // 那一關都過不了，放寬之後會被整個 readFileSync 進記憶體（上限 64 MB）才在解碼失敗。
    // 掃描時算過長相指紋的才有 cleanup_image_sigs 那一列，那就是「解得開的 PNG」。
    const s = sandbox(t)
    put(s.downloads, '大備份.zip', Buffer.alloc(3 * 1024 * 1024, 7))
    s.scan()
    const id = idOf(s.db, '大備份.zip')
    assert.equal(peek(s, id).code, 200, '前提：面板看得到它（預覽拿得到後設資料）')
    assert.equal(s.db.prepare('SELECT count(*) n FROM cleanup_image_sigs WHERE item_id=?').get(id).n, 0,
      '前提：它沒有長相指紋（不是圖）')

    // 直接看它有沒有去開檔 —— 記憶體量不準（GC 會把它吃掉），開檔次數是確定的
    let opened = 0
    const realOpen = fs.openSync
    t.mock.method(fs, 'openSync', (...args) => { opened++; return realOpen(...args) })
    syncBuiltinESMExports()
    let r
    try { r = routes.burstThumbPng(s.db, { roots: [s.downloads], quarantine: s.quarantine }, id) }
    finally { t.mock.restoreAll(); syncBuiltinESMExports() }
    assert.equal(r, null, '不是圖就不給縮圖')
    assert.equal(opened, 0, '不是圖的檔連開都不可以開（那是 64 MB 的上限，會整個讀進記憶體）')
  })

  test('連拍組裡的那幾張照樣看得到（放寬不可以把原本看得到的弄不見）', t => {
    const s = sandbox(t)
    put(s.downloads, 'burst-a.png', shot({ badge: 1 }), OLD + 3 * MIN)
    put(s.downloads, 'burst-b.png', shot({ badge: 1 }), OLD + 1 * MIN)
    s.scan()
    const groups = call(s, 'GET', '/cleanup/bursts').body.groups
    assert.ok(groups.length === 1, JSON.stringify(groups))
    for (const one of [groups[0].keep, ...groups[0].members]) {
      assert.equal(call(s, 'GET', one.thumb).bin?.code, 200, one.name)
      assert.equal(peek(s, one.itemId).code, 200, one.name)
    }
  })
})

// ═══ 預期行為 3 ・ 沒有內容的檔給後設資料 ══════════════════════

describe('P6-3 看不到內容的檔照樣給大小、最後修改、為什麼被列出來', () => {
  test('**.exe 不是 404**：kind 是 none，但大小／時間／why 都在', t => {
    const s = sandbox(t)
    const path = put(s.downloads, 'Node-v24-安裝檔.exe', Buffer.alloc(4096, 7))
    s.scan()
    const r = peek(s, idOf(s.db, 'Node-v24-安裝檔.exe'))
    assert.equal(r.code, 200, JSON.stringify(r.body))
    assert.equal(r.body.kind, 'none')
    assert.equal(r.body.text, null)
    assert.equal(r.body.image, null)
    assert.equal(r.body.bytes, 4096)
    assert.equal(r.body.ext, '.exe')
    assert.ok(Date.parse(r.body.mtime) > 0, r.body.mtime)
    assert.match(r.body.why, /installer/, r.body.why)
    assert.ok(!JSON.stringify(r.body).includes(path))
  })
})

// ═══ 預期行為 4 ・ 還沒讀到的檔不現場讀 ════════════════════════

describe('P6-4 還沒讀過內容的檔：說還沒讀到，不現場觸發讀取', () => {
  test('**沒有 file_texts 的那一列 → text 是 null，而且預覽之後那一列還是不存在**', t => {
    const s = sandbox(t)
    put(s.downloads, '剛掃到.csv', '一、排班準則\n')
    s.scan()
    const id = idOf(s.db, '剛掃到.csv')
    // P1 還沒排到它的樣子：把那一列拿掉（掃描時是同一批讀完的，這裡手動造那個中間狀態）
    s.db.prepare('DELETE FROM file_texts WHERE item_id=?').run(id)
    const r = peek(s, id)
    assert.equal(r.code, 200, JSON.stringify(r.body))
    assert.equal(r.body.kind, 'none')
    assert.equal(r.body.text, null)
    const after = s.db.prepare('SELECT count(*) n FROM file_texts WHERE item_id=?').get(id).n
    assert.equal(after, 0, '預覽不可以現場去讀 —— 讀取有 worker 與逾時，那是背景的事')
  })

  test('**內容抽好之後檔案被改過（size／mtime 對不上）→ 不拿舊內容騙人**', t => {
    const s = sandbox(t)
    put(s.downloads, '改過的.csv', '舊的內容\n')
    s.scan()
    const id = idOf(s.db, '改過的.csv')
    assert.ok(s.db.prepare('SELECT text FROM file_texts WHERE item_id=?').get(id).text.includes('舊的內容'))
    // file_items 的 size 變了（檔案換過、還沒重掃）
    s.db.prepare('UPDATE file_items SET bytes = bytes + 1 WHERE id=?').run(id)
    const r = peek(s, id)
    assert.equal(r.body.text, null, '對不上就是還沒讀到，不可以顯示上一版的內容')
  })
})

// ═══ 預期行為 5 ・ 不在面板清單裡的一律 404 ═══════════════════

describe('P6-5 不在面板看得到的範圍內：404，而且訊息不透露存不存在', () => {
  test('**隨便編一個 id 與「真的存在但面板看不到」的檔，回的是一模一樣的 404**', t => {
    const s = sandbox(t)
    // .txt 在保護清單裡，一個安安靜靜的 .txt 不會變成候選 —— 它存在，但面板看不到
    put(s.downloads, '我的履歷.txt', '姓名：王小明\n')
    put(s.downloads, '舊壓縮檔.zip', Buffer.alloc(300, 1))
    s.scan()
    const hidden = idOf(s.db, '我的履歷.txt')
    assert.ok(hidden, '前提：它真的在 file_items 裡')
    assert.equal(peek(s, '舊壓縮檔.zip' && idOf(s.db, '舊壓縮檔.zip')).code, 200, '對照：候選看得到')
    const a = peek(s, hidden)
    const b = peek(s, '00000000-0000-4000-8000-000000000000')
    assert.equal(a.code, 404)
    assert.equal(b.code, 404)
    assert.deepEqual(a.body, b.body, '兩種 404 要一模一樣，不然狀態碼與訊息就是一個存在性預言機')
    assert.equal(a.body.code, 'NOT_FOUND')
    assert.ok(!JSON.stringify(a.body).includes('我的履歷'), a.body.error)
  })

  test('縮圖那一條也一樣：面板看不到的圖，縮圖端點 404', t => {
    const s = sandbox(t)
    put(s.downloads, '相簿.png', shot())
    // 保護清單外、但只有 3 天 —— 還不到 old-download 的 90 天，所以不是候選
    utimesSync(join(s.downloads, '相簿.png'), new Date(Date.now() - 3 * DAY), new Date(Date.now() - 3 * DAY))
    s.scan()
    const id = idOf(s.db, '相簿.png')
    assert.equal(call(s, 'GET', '/cleanup/candidates').body.total, 0, '前提：它不是候選')
    assert.equal(call(s, 'GET', `/cleanup/thumb/${encodeURIComponent(id)}`).code, 404)
    assert.equal(peek(s, id).code, 404)
  })

  test('壞掉的 %xx 是呼叫端送錯（400），不是後端故障；POST 是 405', t => {
    const s = sandbox(t)
    const bad = call(s, 'GET', '/cleanup/preview/%E0%A4%A')
    assert.equal(bad.code, 400)
    assert.equal(bad.body.code, 'BAD_BODY')
    const wrong = call(s, 'POST', '/cleanup/preview/abc')
    assert.equal(wrong.code, 405)
    assert.equal(wrong.body.code, 'BAD_METHOD')
  })
})

// ═══ 預期行為 6 ・ 要 token、回應沒有絕對路徑 ══════════════════

describe('P6-6 沒帶 token 是 401；回應裡沒有絕對路徑', () => {
  test('**真的起一台 server**：不帶 token 401、帶了才拿得到，body 裡沒有沙盒路徑也沒有家目錄', async t => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-peek-srv-')))
    const downloads = join(dir, 'Downloads')
    mkdirSync(downloads, { recursive: true })
    const dbPath = join(dir, 'data.db')
    const db = open(dbPath)
    const body = '一、排班準則\n二、先來先服務\n'
    writeFileSync(join(downloads, '講義.csv'), body)
    const at = new Date(Date.now() - OLD)
    utimesSync(join(downloads, '講義.csv'), at, at)
    scanner.scanDownloads({ db, roots: [downloads], maxBytes: 16 * 1024 * 1024, onProblem: () => {} })
    const id = db.prepare('SELECT id FROM file_items WHERE name=?').get('講義.csv').id
    db.close()

    const TOKEN = 'preview-wire-token'
    const S = server.start({
      port: 0, db: dbPath, token: TOKEN, roots: [downloads],
      quarantine: join(dir, 'quarantine'), maxBytes: 16 * 1024 * 1024, readonly: false,
    })
    const port = await S.ready
    t.after(() => { globalThis.__cbStopPage?.(); S.server.closeAllConnections(); S.server.close(); S.server.unref(); try { S.facts?.db?.close() } catch { /* 已經關了 */ }; rmTmp(dir) })

    const hit = (path, token) => new Promise((resolve, reject) => {
      const headers = token ? { 'x-contextbox-token': token } : {}
      const req = request({ host: '127.0.0.1', port, method: 'GET', path, headers }, res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks)
          let json = null
          try { json = JSON.parse(raw.toString('utf8')) } catch { /* not answer with JSON */ }
          resolve({ status: res.statusCode, raw, json })
        })
      })
      req.on('error', reject)
      req.end()
    })

    const path = `/cleanup/preview/${encodeURIComponent(id)}`
    const no = await hit(path, null)
    assert.equal(no.status, 401)
    assert.ok(!no.raw.toString('utf8').includes(dir), '401 也不可以帶路徑')

    const yes = await hit(path, TOKEN)
    assert.equal(yes.status, 200, yes.raw.toString('utf8'))
    assert.ok(yes.json.text.includes('一、排班準則'), JSON.stringify(yes.json))
    const text = yes.raw.toString('utf8')
    for (const secret of [dir, downloads, process.env.HOME]) {
      assert.ok(secret && !text.includes(secret), `回應裡有路徑：${secret}`)
    }
  })
})

// ═══ 預期行為 7 ・ 內容裡的控制字元與方向字元 ══════════════════

describe('P6-7 內容是不可信的輸入：控制字元與方向字元洗掉', () => {
  test('**<script>、U+202E、NUL、U+2028 都不可以原樣送出**，但那幾個字還在（換成「·」不是整段丟掉）', t => {
    const s = sandbox(t)
    // NUL 太多會被 looksLikeText 判成二進位垃圾（那是 P1 的規矩），只放一個
    put(s.downloads, '惡意.csv', `<script>alert(1)</script>\nfdp${RLO}exe${NUL}\n${LS}尾巴\n`)
    s.scan()
    const r = peek(s, idOf(s.db, '惡意.csv'))
    assert.equal(r.code, 200, JSON.stringify(r.body))
    const text = r.body.text
    assert.ok(text, '前提：這個檔讀得到內容')
    for (const [label, ch] of [['NUL', NUL], ['RLO', RLO], ['行分隔', LS]]) {
      assert.ok(!text.includes(ch), `${label} 還在：${JSON.stringify(text)}`)
    }
    // 標籤本身只是字，不會變成標籤（面板一律 textContent），所以原樣留著才看得出檔案裡寫了什麼
    assert.ok(text.includes('<script>alert(1)</script>'), JSON.stringify(text))
    assert.ok(text.includes('fdp·exe·'), JSON.stringify(text))
    // 洗的是一個字換一個字，不是整行刪掉
    assert.ok(text.includes('尾巴'), JSON.stringify(text))
  })

  test('safePreviewText 本身：一個字換一個字、換行與 tab 留著、乾淨的字串原樣（結構化隨機 400 個）', () => {
    const TAB = String.fromCharCode(9)
    const pool = ['a', '報', '📄', ' ', '.', '\n', TAB, NUL, RLO, LS, String.fromCharCode(27),
      String.fromCharCode(0x7f), String.fromCharCode(0x9f), '·']
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    let dirty = 0, clean = 0
    for (let i = 0; i < 400; i++) {
      const src = Array.from({ length: Math.floor(rnd() * 14) }, () => pool[Math.floor(rnd() * pool.length)]).join('')
      const out = routes.safePreviewText(src)
      // 剩下的控制字元只准是換行與 tab
      for (const ch of out) {
        const c = ch.codePointAt(0)
        const bad = (c <= 0x1f && ch !== '\n' && ch !== TAB) || (c >= 0x7f && c <= 0x9f) || c === 0x61c
          || (c >= 0x200e && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)
        assert.ok(!bad, `${JSON.stringify(src)} → ${JSON.stringify(out)}`)
      }
      // 沒有 CR 的話長度不變（一個字換一個字）
      if (!src.includes('\r')) assert.equal([...out].length, [...src].length, JSON.stringify(src))
      const isClean = [...src].every(ch => {
        const c = ch.codePointAt(0)
        return !((c <= 0x1f && ch !== '\n' && ch !== TAB) || (c >= 0x7f && c <= 0x9f)
          || (c >= 0x200e && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || c === 0x61c)
      })
      if (isClean) { clean++; assert.equal(out, src) } else dirty++
    }
    assert.ok(dirty > 40 && clean > 20, `生成器：${dirty} / ${clean}`)
  })
})

// ═══ 預期行為 8 ・ 超過 2000 字要截斷並講「還有更多」═════════════

describe('P6-8 文字最多 2000 字', () => {
  test('**一份長講義只給前 2000 個字，truncated 是 true**', t => {
    const s = sandbox(t)
    // file_texts 本來就只留 4000 個字，所以寫一份比那更長的
    put(s.downloads, '長講義.csv', '排'.repeat(STORE_MAX_CHARS + 500) + '\n')
    s.scan()
    const r = peek(s, idOf(s.db, '長講義.csv'))
    assert.equal(r.code, 200, JSON.stringify(r.body))
    assert.equal(routes.PREVIEW_MAX_CHARS, 2000, '預想寫死 2000')
    assert.equal([...r.body.text].length, 2000)
    assert.equal(r.body.truncated, true)
  })

  test('剛好沒超過的不講「還有更多」', t => {
    const s = sandbox(t)
    put(s.downloads, '短講義.csv', '排'.repeat(1999) + '\n')
    s.scan()
    const r = peek(s, idOf(s.db, '短講義.csv'))
    assert.equal(r.body.truncated, false)
    assert.equal([...r.body.text].length, 2000, '1999 個字加一個換行')
  })

  test('**原檔超過 file_texts 的 4000 字上限，就算截到 2000 以內也要講**（不可以安靜地少給）', t => {
    const s = sandbox(t)
    put(s.downloads, '超長.csv', '排'.repeat(STORE_MAX_CHARS + 1000))
    s.scan()
    const row = s.db.prepare('SELECT truncated FROM file_texts WHERE item_id=?').get(idOf(s.db, '超長.csv'))
    assert.equal(row.truncated, 1, '前提：存進去的時候就截斷過')
    assert.equal(peek(s, idOf(s.db, '超長.csv')).body.truncated, true)
  })
})

// ═══ 預期行為 11 ・ 隔離區裡的檔也看得到 ═══════════════════════

describe('P6-11 已經清掉、還可以復原的檔也看得到內容', () => {
  test('**搬進隔離區之後 preview 照樣 200**，why 講得出它在隔離區', t => {
    const s = sandbox(t)
    put(s.downloads, '舊壓縮檔.zip', Buffer.alloc(300, 1))
    s.scan()
    const id = idOf(s.db, '舊壓縮檔.zip')
    const plan = createPlan(s.db)
    applyPlan(s.db, plan.id, { ...s.opts, readonly: false })
    assert.equal(
      s.db.prepare('SELECT status FROM file_items WHERE id=?').get(id).status, 'quarantined', '前提：真的搬走了')
    assert.equal(call(s, 'GET', '/cleanup/candidates').body.total, 0, '前提：它已經不在清理清單上')
    const r = peek(s, id)
    assert.equal(r.code, 200, JSON.stringify(r.body))
    assert.equal(r.body.name, '舊壓縮檔.zip')
    assert.match(r.body.why, /quarantine/, r.body.why)
  })
})

// ═══ 不變量 ・ 不新增「照路徑讀檔」的程式碼、不記「看過」═════════

describe('P6 不變量', () => {
  test('**預覽這一段一行開檔的程式碼都沒有**：內容只能從 file_texts 與既有的縮圖端點來', () => {
    const src = readFileSync(join(REPO, 'core/cleanup-routes.ts'), 'utf8')
    const from = src.indexOf('// ── 看得到檔案內容（P6）')
    const to = src.indexOf('export type RouteCtx = {')
    assert.ok(from > 0 && to > from, '找不到 P6 那一段，這條檢查就沒有意義了')
    // 註解裡講得出「這裡沒有 openSync」，所以只看程式碼（跟 repo.test.mjs 同一個做法）
    const section = src.slice(from, to).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    assert.ok(section.includes('function previewOf') && section.includes('function panelReason'),
      '拿掉註解之後連程式碼都不見了，這條檢查就沒有意義了')
    for (const bad of ['openSync', 'readFileSync', 'createReadStream', 'realpathSync', 'lstatSync', 'statSync']) {
      assert.ok(!section.includes(bad), `P6 那一段用了 ${bad} —— 那就是一條照路徑讀檔的新路`)
    }
    // 端點收的只有 itemId：路由本身不可以有任何 path／dir 這種查詢參數
    assert.ok(!/preview[\s\S]{0,400}searchParams/.test(src), '預覽不可以吃查詢參數')
  })

  test('**縮圖與預覽問的是同一支**：burstThumbPng 裡沒有第二份可見範圍判斷', () => {
    const src = readFileSync(join(REPO, 'core/cleanup-routes.ts'), 'utf8')
    const body = /export function burstThumbPng\([\s\S]*?\n\}/.exec(src)?.[0]
    assert.ok(body, '找不到 burstThumbPng')
    assert.ok(body.includes('panelReason('), '縮圖要問 panelReason')
    assert.ok(!body.includes('burstGroupsView('), '不可以自己再判一次「在不在組裡」')
  })

  test('**看一眼不是決定**：預覽不寫任何一張表', t => {
    const s = sandbox(t)
    put(s.downloads, '作業系統.csv', '一、排班準則\n')
    put(s.downloads, 'Screenshot 一張.png', shot())
    s.scan()
    const tables = s.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map(r => r.name)
    const snap = () => tables.map(t2 => `${t2}=${s.db.prepare(`SELECT count(*) n FROM "${t2}"`).get().n}`).join(',')
    const before = snap()
    for (const name of ['作業系統.csv', 'Screenshot 一張.png']) {
      assert.equal(peek(s, idOf(s.db, name)).code, 200, name)
    }
    assert.equal(snap(), before, '預覽多寫了一列 —— 看一眼不是決定，記了只會多一張表')
  })

  test('面板列得出來的每一種都看得到；file_items 裡其他的檔一個都看不到', t => {
    const s = sandbox(t)
    put(s.downloads, '舊壓縮檔.zip', Buffer.alloc(300, 1))          // 候選
    put(s.downloads, '太大的備份.bin', Buffer.alloc(200, 2))        // 需要你查看（maxBytes 調小）
    put(s.downloads, '我的履歷.txt', '姓名\n')                       // 面板看不到
    scanner.scanDownloads({ db: s.db, roots: s.opts.roots, maxBytes: 100, onProblem: () => {} })
    const list = call(s, 'GET', '/cleanup/candidates').body
    const shown = new Set([...list.candidates.map(c => c.itemId), ...list.needsHuman.map(h => h.itemId)])
    assert.ok(shown.size >= 2, JSON.stringify(list.needsHuman))
    for (const id of shown) assert.equal(peek(s, id).code, 200, id)
    const hidden = idOf(s.db, '我的履歷.txt')
    assert.ok(!shown.has(hidden), '前提：它不在面板上')
    assert.equal(peek(s, hidden).code, 404)
  })
})

// ═══ 文件照現況寫 ═════════════════════════════════════════════

describe('P6 文件', () => {
  test('docs/api/README.md 有這一條路徑、回應的每一個欄位、以及 404 的說法', t => {
    const md = readFileSync(join(REPO, 'docs/api/README.md'), 'utf8')
    const at = md.indexOf('## `GET /cleanup/preview/:itemId`')
    assert.ok(at > 0, 'README 沒有這一條路徑')
    const section = md.slice(at, md.indexOf('\n## ', at + 5))
    // 真的跑一次，拿實際回應的欄位去比 —— 手寫清單會腐爛
    const s = sandbox(t)
    put(s.downloads, '講義.csv', '一、排班準則\n')
    s.scan()
    const body = peek(s, idOf(s.db, '講義.csv')).body
    for (const k of Object.keys(body)) {
      assert.ok(section.includes('`' + k + '`') || section.includes('"' + k + '"'),
        `README 沒有講 ${k} 這個欄位`)
    }
    assert.match(section, /404 `NOT_FOUND`/)
    assert.match(section, /2000/, '要寫明最多幾個字')
    assert.match(section, /file_texts/, '要寫明內容從哪裡來')
    assert.ok(/不開任何檔案|不讀原始|不會照路徑/.test(section), '要寫明它不照路徑讀檔')
  })

  test('docs/api/README.md 的縮圖那一節改口了：可見範圍跟預覽同一支', () => {
    const md = readFileSync(join(REPO, 'docs/api/README.md'), 'utf8')
    const at = md.indexOf('## `GET /cleanup/thumb/:itemId`')
    const section = md.slice(at, md.indexOf('\n## ', at + 5))
    assert.ok(!/只給現在還在連拍組裡的 item/.test(section), '放寬了，舊說法要改掉')
    assert.match(section, /panelReason|同一支/, '要寫明跟預覽共用同一份判斷')
  })

  test('docs/panel.md 講了分頁與「看內容」', () => {
    const md = readFileSync(join(REPO, 'docs/panel.md'), 'utf8')
    assert.match(md, /#files/)
    assert.match(md, /#facts/)
    assert.match(md, /localStorage/)
    // 面板說明英文化（2026-09-20）：同一個性質，換成文件現在真的寫的字
    assert.match(md, /View contents/)
    assert.match(md, /no reload/)
  })

  test('docs/DEMO.md 的面板那一節帶了一句', () => {
    const md = readFileSync(join(REPO, 'docs/DEMO.md'), 'utf8')
    // DEMO 英文化（2026-09-20）：還是那一節、還是那兩件事（看內容、檔案管理那一塊）
    const at = md.indexOf('## 4. Open the pet and the panel')
    assert.ok(at > 0, 'docs/DEMO.md 找不到面板那一節')
    const section = md.slice(at, md.indexOf('\n## ', at + 5))
    assert.match(section, /View contents/)
    assert.match(section, /\*\*Files\*\*/)
  })
})
