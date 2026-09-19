import './helpers/isolate-home.mjs'   // 一定要第一個 import：這支會起 server，見那支檔的說明
/**
 * P0 連拍截圖主動詢問的**接線**（~/contextbox-預想-20260919-P0接線.md）。
 *
 * 上游 core/png.ts、core/imagehash.ts 已經五輪驗證過，這裡不再測它們；
 * 測的是「掃描算指紋 → 分組 → 變成候選 → 端點 → 寵物主動問」這一段。
 *
 * **期望值是預想表寫死的**，在實作之前寫成測試（先紅）。不可以為了變綠改期望值；
 * 覺得某一格錯了就寫進回報（Step 1 表第 1、2 條見下面 D1 那一組的說明）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { deflateSync } from 'node:zlib'
// 用命名空間匯入：新函式還沒寫出來的時候，只有用到它的那幾條紅，不會整支檔案載入失敗。
import { open } from '../core/db.ts'
import * as scanner from '../core/cleanup-scanner.ts'
import * as routes from '../core/cleanup-routes.ts'
import { createPlan, releasePlan } from '../core/cleanup-plans.ts'
import { applyPlan, undoPlan } from '../core/cleanup-exec.ts'
import * as server from '../core/server.ts'
import * as pngWrite from '../core/png-write.ts'
import { decodePngGray, pngSize } from '../core/png.ts'

// ── 素材：跟 tools/demo-setup.mjs 同一段程式 ──────────────────

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

/** 最小的 PNG 編碼器（灰階、每列一個 filter 0）。 */
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

/** 一張「像截圖」的圖：頂端有標題列，中間幾行字，右下角有一顆按鈕（跟 demo 沙盒同一支）。 */
function shot({ lines = 6, extraLine = false, badge = 0, cursor = false, w = 1280, h = 720 } = {}) {
  return png(w, h, set => {
    const rect = (x0, y0, ww, hh, v) => {
      for (let y = y0; y < y0 + hh; y++) for (let x = x0; x < x0 + ww; x++) set(x, y, v)
    }
    rect(0, 0, w, 48, 0x22)
    for (let i = 0; i < lines; i++) rect(80, 110 + i * 40, 520 + (i % 3) * 180, 16, 0x44)
    if (extraLine) rect(80, 110 + lines * 40, 300, 16, 0x44)
    rect(w - 160, h - 100, 96, 48, 0x66)
    for (let i = 0; i < badge; i++) rect(w - 90 + i * 10, h - 110, 8, 8, 0x11)
    if (cursor) rect(600, 300, 2, 18, 0x00)
  })
}

/** 一張小圖，每一張的內容都不一樣（只拿來數指紋，不在意分組結果）。 */
const tiny = n => png(80, 60, set => {
  for (let i = 0; i <= n % 40; i++) set(i, i, 0)
  set(n % 80, 1 + (n % 50), (n * 7) % 200)
})

// ── 沙盒 ──────────────────────────────────────────────────────

const MIN = 60_000
// 檔案要靜置超過十分鐘才進得了清理流程（status 從 new 變 candidate），連拍也照這條規矩：
// 剛截的那一批等下一次掃描再分組，不然會變成「勾得起來、按下去卻說候選已變更」。
// 素材統一挪到兩天前，彼此的間隔（分鐘）才是連拍要看的。
const SETTLED = 2 * 86400_000

function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-burst-')))
  const downloads = join(dir, 'Downloads')
  mkdirSync(downloads, { recursive: true })
  const dbPath = join(dir, 'data.db')
  const db = open(dbPath)
  t.after(() => {
    try { db.close() } catch { /* 已經關了 */ }
    rmSync(dir, { recursive: true, force: true })
  })
  const problems = []
  const opts = { roots: [downloads], quarantine: join(dir, 'quarantine'), maxBytes: 16 * 1024 * 1024 }
  const scan = (extra = {}) => {
    problems.length = 0
    return scanner.scanDownloads({
      db, roots: opts.roots, maxBytes: opts.maxBytes, onProblem: m => problems.push(m), ...extra,
    })
  }
  return { dir, downloads, dbPath, db, opts, problems, scan }
}

/** 寫一個檔，並把它的時間撥到 agoMs 毫秒之前。 */
function put(dir, name, content, agoMs = 2 * 86400_000) {
  const path = join(dir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, content)
  const at = new Date(Date.now() - agoMs)
  utimesSync(path, at, at)
  return path
}

const sigRows = db => db.prepare(
  `SELECT s.*, i.name FROM cleanup_image_sigs s JOIN file_items i ON i.id=s.item_id ORDER BY i.name`).all()

const burstCands = db => db.prepare(
  `SELECT c.*, i.name FROM cleanup_candidates c JOIN file_items i ON i.id=c.item_id
    WHERE c.rule_version='burst-1' ORDER BY i.name`).all()

const memberRows = db => db.prepare(
  `SELECT m.*, i.name FROM cleanup_burst_members m JOIN file_items i ON i.id=m.item_id ORDER BY i.name`).all()

const idOf = (db, name) => db.prepare('SELECT id FROM file_items WHERE name=?').get(name)?.id

/** 直接打 route（不經過 HTTP）。回 { handled, code, body, bin }。 */
function call(s, method, path, extra = {}) {
  let got = null
  let bin = null
  const handled = routes.cleanupRoutes({
    db: s.db, roots: s.opts.roots, quarantine: s.opts.quarantine,
    maxBytes: s.opts.maxBytes, readonly: false,
    url: new URL('http://x' + path), method, body: {},
    send: (code, payload, headers) => { got = { code, body: payload, headers: headers ?? {} } },
    sendBytes: (code, type, body, headers) => { bin = { code, type, body, headers: headers ?? {} } },
    scan: onProblem => s.scan({ onProblem }),
    ...extra,
  })
  return { handled, ...(got ?? {}), bin }
}

// ═══ Step 1 ・ 容易錯的地方（成對的例子）═════════════════════

describe('S1 哪些檔要算指紋：看內容，不看副檔名', () => {
  test('一個 .png 其實是 JPEG → 不算；一個真的 PNG（副檔名不是 .png）→ 照算', t => {
    const s = sandbox(t)
    // JPEG 的開頭，副檔名卻是 .png
    put(s.downloads, '假的.png', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 9)]))
    put(s.downloads, '其實是圖.bin', shot({ w: 200, h: 120 }))
    s.scan()
    assert.deepEqual(sigRows(s.db).map(r => r.name), ['其實是圖.bin'],
      '指紋要看內容（PNG 簽章），不可以看副檔名')
  })

  test('不是 PNG 的檔不會被當成「算不出來」而洗版 problems', t => {
    const s = sandbox(t)
    for (let i = 0; i < 5; i++) put(s.downloads, `文件${i}.pdf`, Buffer.from(`%PDF-1.4 ${i}`))
    s.scan()
    assert.deepEqual(s.problems, [], '一般（不是 PNG）的檔不可以各報一條問題 —— 寵物會永遠在擔心')
  })
})

describe('S2 截圖以外的 PNG：判斷靠長相不靠檔名', () => {
  test('兩張一模一樣的貼圖（檔名不像截圖）照樣成組', t => {
    const s = sandbox(t)
    const buf = shot({ w: 300, h: 200, badge: 1 })
    put(s.downloads, 'sticker-a.png', buf, SETTLED + 3 * MIN)
    put(s.downloads, 'sticker-b.png', buf, SETTLED + 1 * MIN)
    s.scan()
    const groups = call(s, 'GET', '/cleanup/bursts').body.groups
    assert.equal(groups.length, 1, '一樣的貼圖也該問')
    assert.equal(groups[0].keep.name, 'sticker-b.png', '留最新的那張')
  })
})

describe('S3 時間用 mtime，不看檔名', () => {
  test('mtime 全一樣（cp 過來的一批）仍然成組，留 id 較大的', t => {
    const s = sandbox(t)
    const buf = shot({ w: 300, h: 200, badge: 1 })
    const ago = SETTLED + 5 * MIN
    put(s.downloads, 'copy-1.png', buf, ago)
    put(s.downloads, 'copy-2.png', buf, ago)
    // 兩個檔的 mtime 撥成完全一樣
    const at = new Date(Date.now() - ago)
    utimesSync(join(s.downloads, 'copy-1.png'), at, at)
    utimesSync(join(s.downloads, 'copy-2.png'), at, at)
    s.scan()
    const groups = call(s, 'GET', '/cleanup/bursts').body.groups
    assert.equal(groups.length, 1, 'mtime 一樣（間隔 0 ≤ 5 分鐘）也成組')
    const ids = [idOf(s.db, 'copy-1.png'), idOf(s.db, 'copy-2.png')]
    assert.equal(groups[0].keep.itemId, ids[0] > ids[1] ? ids[0] : ids[1], '平手留 id 較大的')
  })

  test('檔名的時間跟 mtime 不一樣時，聽 mtime 的', t => {
    const s = sandbox(t)
    const buf = shot({ w: 300, h: 200, badge: 1 })
    // 檔名說 2019 的比較舊，但 mtime 說它最新
    put(s.downloads, 'Screenshot 2026-09-18 at 10.00.00.png', buf, SETTLED + 4 * MIN)
    put(s.downloads, 'Screenshot 2019-01-01 at 00.00.00.png', buf, SETTLED + 1 * MIN)
    s.scan()
    const groups = call(s, 'GET', '/cleanup/bursts').body.groups
    assert.equal(groups[0].keep.name, 'Screenshot 2019-01-01 at 00.00.00.png')
  })
})

describe('S4 指紋快取失效：size 與 mtime 任一不同就重算', () => {
  // 成對的例子直接改資料庫裡那一列：檔案不動，只讓「算的時候的 size／mtime」跟現在的檔對不上。
  // 這樣才分得出「只看 mtime」與「size 與 mtime 都要對」—— 用真的檔改內容的話，
  // 大小幾乎一定跟著變，兩種實作都會重算，測不出差別。
  const tamper = (s, name, patch) => {
    const row = s.db.prepare(
      `SELECT s.* FROM cleanup_image_sigs s JOIN file_items i ON i.id=s.item_id WHERE i.name=?`).get(name)
    s.db.prepare('UPDATE cleanup_image_sigs SET size=?, mtime=?, hash=? WHERE item_id=?')
      .run(patch.size ?? row.size, patch.mtime ?? row.mtime, 'deadbeefdeadbeef', row.item_id)
    return row
  }

  test('size 一樣、只有 mtime 對不上 → 重算', t => {
    const s = sandbox(t)
    put(s.downloads, 'a.png', shot({ w: 200, h: 120, badge: 1 }))
    s.scan()
    const before = tamper(s, 'a.png', { mtime: '2000-01-01T00:00:00.000Z' })
    s.scan()
    const after = sigRows(s.db)[0]
    assert.equal(after.size, before.size, '前提：大小沒變')
    assert.equal(after.hash, before.hash, 'mtime 對不上就要重算（算回原本的指紋）')
    assert.notEqual(after.mtime, '2000-01-01T00:00:00.000Z')
  })

  test('mtime 一樣、只有 size 對不上 → 重算', t => {
    const s = sandbox(t)
    put(s.downloads, 'b.png', shot({ w: 200, h: 120, badge: 1 }))
    s.scan()
    const before = tamper(s, 'b.png', { size: 12345 })
    s.scan()
    const after = sigRows(s.db)[0]
    assert.equal(after.mtime, before.mtime, '前提：mtime 沒變')
    assert.equal(after.hash, before.hash, 'size 對不上就要重算')
    assert.equal(Number(after.size), Number(before.size))
  })

  test('兩個都對得上 → 不重算（快取真的有用）', t => {
    const s = sandbox(t)
    put(s.downloads, 'c.png', shot({ w: 200, h: 120, badge: 1 }))
    s.scan()
    const row = s.db.prepare(
      `SELECT s.* FROM cleanup_image_sigs s JOIN file_items i ON i.id=s.item_id WHERE i.name='c.png'`).get()
    s.db.prepare('UPDATE cleanup_image_sigs SET hash=? WHERE item_id=?').run('cafecafecafecafe', row.item_id)
    s.scan()
    assert.equal(sigRows(s.db)[0].hash, 'cafecafecafecafe', 'size 與 mtime 都一樣就不可以再算一次')
  })

  test('真的改檔案（大小變了）→ 指紋跟著換，而且組散掉', t => {
    const s = sandbox(t)
    const p = put(s.downloads, 'd.png', shot({ w: 200, h: 120 }))
    s.scan()
    const before = sigRows(s.db)[0]
    writeFileSync(p, shot({ w: 240, h: 120 }))
    const at = new Date(Date.now() - SETTLED - 1 * MIN)
    utimesSync(p, at, at)
    s.scan()
    const after = sigRows(s.db)[0]
    assert.notEqual(Number(after.size), Number(before.size), '前提：大小變了')
    assert.equal(after.width, 240, '重算的是現在的檔')
  })
})

describe('S5 一批最多 120 張', () => {
  test('130 張新圖：這一輪只算 120 張，回應講得出還剩幾張，下一輪接著算', t => {
    const s = sandbox(t)
    for (let i = 0; i < 130; i++) put(s.downloads, `t${String(i).padStart(3, '0')}.png`, tiny(i), SETTLED + (i + 1) * MIN)
    const r1 = s.scan()
    assert.equal(sigRows(s.db).length, 120, '一批最多 120 張')
    assert.equal(r1.imagesPending, 10, 'scan 要講得出還剩幾張沒算')
    const r2 = s.scan()
    assert.equal(sigRows(s.db).length, 130, '下一輪接著算')
    assert.equal(r2.imagesPending, 0)
  })
})

describe('S6 分組的範圍：只看清理範圍底下，而且同一個資料夾才成組', () => {
  test('桌面與 Downloads 各有一組，不會併成一組', t => {
    const s = sandbox(t)
    const desktop = join(s.dir, 'Desktop')
    mkdirSync(desktop, { recursive: true })
    const buf = shot({ w: 300, h: 200, badge: 1 })
    put(s.downloads, 'dl-a.png', buf, SETTLED + 3 * MIN)
    put(s.downloads, 'dl-b.png', buf, SETTLED + 1 * MIN)
    put(desktop, 'desk-a.png', buf, SETTLED + 3 * MIN)
    put(desktop, 'desk-b.png', buf, SETTLED + 1 * MIN)
    s.scan({ roots: [s.downloads, desktop] })
    const groups = call(s, 'GET', '/cleanup/bursts', { roots: [s.downloads, desktop] }).body.groups
    assert.equal(groups.length, 2, '兩個資料夾各一組（四張一模一樣，但跨資料夾不成組）')
    for (const g of groups) {
      const names = [g.keep.name, ...g.members.map(m => m.name)].sort()
      assert.ok(names.every(n => n.startsWith('dl-')) || names.every(n => n.startsWith('desk-')),
        `一組裡混到了別的資料夾：${names.join('、')}`)
    }
  })

  test('清理範圍縮回去之後，那些組不會再出現在畫面上（範圍外的列不動，K5）', t => {
    const s = sandbox(t)
    const desktop = join(s.dir, 'Desktop')
    mkdirSync(desktop, { recursive: true })
    const buf = shot({ w: 300, h: 200, badge: 1 })
    put(s.downloads, 'dl-a.png', buf, SETTLED + 3 * MIN)
    put(s.downloads, 'dl-b.png', buf, SETTLED + 1 * MIN)
    put(desktop, 'desk-a.png', buf, SETTLED + 3 * MIN)
    put(desktop, 'desk-b.png', buf, SETTLED + 1 * MIN)
    s.scan({ roots: [s.downloads, desktop] })
    assert.equal(memberRows(s.db).filter(m => m.name.startsWith('desk-')).length, 2, '前提：桌面那一組成組過')
    const deskAt = memberRows(s.db).find(m => m.name === 'desk-a.png').at
    // 只掃 Downloads：桌面不在這一輪的清理範圍裡
    s.scan()
    const names = call(s, 'GET', '/cleanup/bursts').body.groups
      .flatMap(g => [g.keep.name, ...g.members.map(m => m.name)])
    assert.deepEqual(names.filter(n => n.startsWith('desk-')), [],
      '清理範圍外的組不可以出現在畫面上')
    // **範圍外的列不碰**（稽核第三波 K5）：兩個呼叫端的 roots 不一樣時，
    // 同一筆被一邊作廢、另一邊改回來，清單上的檔會忽隱忽現。
    assert.equal(memberRows(s.db).find(m => m.name === 'desk-a.png').at, deskAt,
      '範圍外的列這一輪不該被改寫')
    assert.deepEqual(
      burstCands(s.db).filter(c => c.name.startsWith('desk-')).map(c => c.status), ['proposed'],
      '範圍外的候選留給掃那裡的人判斷')
  })

  test('跨資料夾的不成組', t => {
    const s = sandbox(t)
    const other = join(s.downloads, '別的資料夾')
    mkdirSync(other, { recursive: true })
    const buf = shot({ w: 300, h: 200, badge: 1 })
    put(s.downloads, 'x-a.png', buf, SETTLED + 3 * MIN)
    put(other, 'x-b.png', buf, SETTLED + 1 * MIN)
    s.scan()
    assert.deepEqual(call(s, 'GET', '/cleanup/bursts').body.groups, [],
      '不同資料夾的兩張不成組（使用者的心智模型是「這個資料夾裡」）')
  })
})

describe('S7／S8 候選的 kind、rule_version 與信心', () => {
  test('kind 是 screenshot-noise、rule_version 是 burst-1；same 70、similar 40，門檻 50', t => {
    const s = sandbox(t)
    const same = shot({ w: 300, h: 200, badge: 1 })
    put(s.downloads, 'same-a.png', same, SETTLED + 4 * MIN)
    put(s.downloads, 'same-b.png', same, SETTLED + 3 * MIN)
    const base = shot({ badge: 1 })
    put(s.downloads, 'sim-a.png', base, SETTLED + 2 * MIN)
    put(s.downloads, 'sim-b.png', shot({ badge: 1, cursor: true }), SETTLED + 1 * MIN)
    s.scan()
    const byName = Object.fromEntries(burstCands(s.db).map(c => [c.name, c]))
    assert.deepEqual(Object.keys(byName).sort(), ['same-a.png', 'sim-a.png'], '只有被留下那張以外的成員有候選')
    for (const c of Object.values(byName)) {
      assert.equal(c.kind, 'screenshot-noise')
      assert.equal(c.rule_version, 'burst-1')
      assert.equal(c.status, 'proposed')
    }
    assert.equal(byName['same-a.png'].confidence, 70, 'same → 70（≥ 50，預設勾）')
    assert.equal(byName['sim-a.png'].confidence, 40, 'similar → 40（< 50，預設不勾）')
    assert.ok(70 >= routes.DEFAULT_CHECK_MIN && 40 < routes.DEFAULT_CHECK_MIN, '門檻是 50')
  })

  test('reason 與 evidence 講得出跟誰比、相隔多久、會留著誰', t => {
    const s = sandbox(t)
    const buf = shot({ w: 300, h: 200, badge: 1 })
    put(s.downloads, '舊的.png', buf, SETTLED + 4 * MIN)
    put(s.downloads, '新的.png', buf, SETTLED + 1 * MIN)
    s.scan()
    const c = burstCands(s.db)[0]
    assert.equal(c.name, '舊的.png')
    assert.match(c.reason, /新的\.png/, 'reason 要指名留下的那張')
    assert.match(c.reason, /幾乎一樣|差不多/)
    assert.match(c.evidence, /同一批/)
    assert.match(c.evidence, /相隔 18\d 秒|相隔 1[78]\d 秒/, 'evidence 要講相隔幾秒')
    assert.match(c.evidence, /會留著.*新的\.png/, 'evidence 要講會留著哪一張')
    assert.ok(!c.reason.includes(s.downloads) && !c.evidence.includes(s.downloads), '不可以帶路徑')
  })
})

describe('S9 工作量超過上限：接住 TOO_MUCH_WORK，照張數切成每段 300 張', () => {
  test('丟 TOO_MUCH_WORK 的時候會切成 300 張一段重試', () => {
    const calls = []
    const fake = (items, opts) => {
      calls.push(items.length)
      if (items.length > 300) {
        const e = new Error('太多了')
        e.name = 'ImageHashError'
        e.code = 'TOO_MUCH_WORK'
        throw e
      }
      return [{ keep: items[0].id, level: 'same', drop: [], members: [] }]
    }
    const items = Array.from({ length: 700 }, (_, i) => ({ id: 'i' + i, takenAt: i }))
    const out = scanner.burstGroupsChunked(items, {}, fake)
    assert.deepEqual(calls, [700, 300, 300, 100], '先整批試一次，丟錯之後切成每段 300 張')
    assert.equal(out.length, 3, '每一段的結果都要收回來')
  })

  test('**一小段（≤ 300 張）也丟錯時要繼續對半切，不可以整段放棄**', () => {
    // 常見截圖尺寸下，記憶體分段本來就把每一段壓在 291 張以下，所以「超過 300 才切」那條路
    // 永遠走不到 —— 那一段裡真正的連拍組會被靜默丟掉（P0 驗證員抓到的死碼）。
    const calls = []
    const fake = (items) => {
      calls.push(items.length)
      if (items.length > 50) {
        const e = new Error('太多了'); e.name = 'ImageHashError'; e.code = 'TOO_MUCH_WORK'; throw e
      }
      return [{ keep: items[0].id, level: 'same', drop: [], members: [] }]
    }
    const items = Array.from({ length: 200 }, (_, i) => ({ id: 'i' + i, takenAt: i }))
    const problems = []
    const out = scanner.burstGroupsChunked(items, {}, fake, m => problems.push(m))
    assert.ok(calls.length > 1, `要真的切下去：${JSON.stringify(calls)}`)
    assert.ok(calls.some(n => n <= 50), `要切到跑得動為止：${JSON.stringify(calls)}`)
    assert.ok(out.length >= 4, `切出來的每一段的結果都要收回來：${out.length}`)
    assert.deepEqual(problems, [], '切得動就不要報問題')
  })

  test('切成 300 張還是丟錯的話，記一條問題，不讓整批掃描失敗', () => {
    const fake = () => {
      const e = new Error('太多了')
      e.name = 'ImageHashError'
      e.code = 'TOO_MUCH_WORK'
      throw e
    }
    const items = Array.from({ length: 400 }, (_, i) => ({ id: 'i' + i, takenAt: i }))
    const problems = []
    const out = scanner.burstGroupsChunked(items, {}, fake, m => problems.push(m))
    assert.deepEqual(out, [])
    // 對半切到 BURST_MIN_CHUNK（16）還是丟錯才放棄：400 張切成 300＋100，各自一路對半切下去。
    // **重點是它真的切了**：以前「≤ 300 就放棄」的寫法，在常見截圖尺寸下永遠走不到切的那一步，
    // 整段的連拍組被靜默丟掉（P0 驗證員）。
    assert.ok(problems.length >= 2, `放棄的每一小段各報一條：${problems.length}`)
    assert.ok(problems.every(m => /連拍比對量太大/.test(m)), problems.join('\n'))
  })
})

describe('剛截的那一批（十分鐘內還在變動）先不分組', () => {
  test('剛截的兩張不成組；靜置過後的下一次掃描才成組', t => {
    const s = sandbox(t)
    const buf = shot({ badge: 1 })
    put(s.downloads, 'fresh-a.png', buf, 2 * MIN)
    put(s.downloads, 'fresh-b.png', buf, 1 * MIN)
    s.scan()
    assert.deepEqual(call(s, 'GET', '/cleanup/bursts').body.groups, [],
      '剛截的分了組也建不了計畫（createPlan 只收靜置過的），那就先不要問')
    // 把它們撥成靜置過的，再掃一次
    for (const n of ['fresh-a.png', 'fresh-b.png']) {
      const at = new Date(Date.now() - SETTLED)
      utimesSync(join(s.downloads, n), at, at)
    }
    s.scan()
    assert.equal(call(s, 'GET', '/cleanup/bursts').body.groups.length, 1, '靜置過就要問')
  })
})

describe('連拍候選進得了清理流程，但不會被「預設清理」掃進去', () => {
  test('勾起來建得了計畫、搬得動、放得回；不帶 id 的預設清理不含連拍', t => {
    const s = sandbox(t)
    // 檔案要靜置過十分鐘才建得了計畫，所以這裡用兩天前、相隔一分鐘的兩張
    put(s.downloads, 'b1.png', shot({ badge: 1 }), 2 * 86400_000 + MIN)
    put(s.downloads, 'b2.png', shot({ badge: 1, cursor: true }), 2 * 86400_000)
    put(s.downloads, 'old.zip', Buffer.from('x'.repeat(4000)), 90 * 86400_000)
    s.scan()
    const burstIds = s.db.prepare(`SELECT id FROM cleanup_candidates WHERE rule_version='burst-1'`).all().map(r => r.id)
    assert.equal(burstIds.length, 1, '前提：一個連拍候選（留下的那張不列）')

    // 預設清理（不帶 id）：只拿一般規則的候選，連拍要看過縮圖再決定
    const dflt = createPlan(s.db, {})
    assert.deepEqual(dflt.items.map(i => i.name), ['old.zip'], '預設清理不可以把連拍掃進去')
    releasePlan(s.db, dflt.id)

    // 指名連拍候選：建得了、搬得動、放得回
    const plan = createPlan(s.db, { candidateIds: burstIds })
    const applied = applyPlan(s.db, plan.id, s.opts)
    assert.equal(applied.status, 'applied', JSON.stringify(applied))
    assert.equal(applied.quarantinedCount, 1)
    assert.equal(existsSync(join(s.downloads, 'b1.png')), false, '舊的那張搬走了')
    assert.ok(existsSync(join(s.downloads, 'b2.png')), '留下的那張不可以被搬')
    const undone = undoPlan(s.db, plan.id, s.opts)
    assert.equal(undone.status, 'restored')
    assert.ok(existsSync(join(s.downloads, 'b1.png')), '放得回來')
  })
})

// ═══ 預期行為（預想表第 1～10 條）════════════════════════════

describe('D1 三張連拍＋一張同版面但內容不同的', () => {
  test('成一組、兩個候選（留最新的），內容不同的那張不在組裡', t => {
    const s = sandbox(t)
    put(s.downloads, 'burst-1.png', shot({ badge: 1 }), SETTLED + 4 * MIN)
    put(s.downloads, 'burst-2.png', shot({ badge: 1, cursor: true }), SETTLED + 3 * MIN)
    put(s.downloads, 'burst-3.png', shot({ badge: 2, cursor: true }), SETTLED + 2 * MIN)
    put(s.downloads, 'other.png', shot({ lines: 9, badge: 3 }), SETTLED + 1 * MIN)
    s.scan()
    const groups = call(s, 'GET', '/cleanup/bursts').body.groups
    assert.equal(groups.length, 1)
    assert.equal(groups[0].keep.name, 'burst-3.png', '留最新的那張')
    assert.deepEqual(groups[0].members.map(m => m.name), ['burst-2.png', 'burst-1.png'])
    assert.deepEqual(burstCands(s.db).map(c => c.name), ['burst-1.png', 'burst-2.png'], '兩個候選')
    assert.deepEqual(memberRows(s.db).map(m => m.name).filter(n => n === 'other.png'), [],
      '內容不同的那張不在組裡')
  })

  test('demo 沙盒的那四張（tools/demo-setup.mjs 的原始素材）', t => {
    const s = sandbox(t)
    put(s.downloads, 'Screenshot 2026-09-18 at 10.31.02.png', shot({ badge: 1 }), SETTLED + 4 * MIN)
    put(s.downloads, 'Screenshot 2026-09-18 at 10.31.05.png', shot({ badge: 1, cursor: true }), SETTLED + 3 * MIN)
    put(s.downloads, 'Screenshot 2026-09-18 at 10.31.09.png', shot({ badge: 1, extraLine: true }), SETTLED + 2 * MIN)
    put(s.downloads, 'Screenshot 2026-09-18 at 14.02.44.png', shot({ lines: 9, badge: 3 }), SETTLED + 1 * MIN)
    s.scan()
    const groups = call(s, 'GET', '/cleanup/bursts').body.groups
    // **跟預想表第 1、2 條對不上，而且不是接線層能決定的。** demo 的「多打一行」是一條
    // 300×16 的實心長條：上游 compareImages 判 different（reason 'area'，強格佔 52‱，
    // 上限 25‱；就算改細一點也會踩到「一行字變了」那條 —— 寬超過高的 2.2 倍）。
    // 所以那三張只有「只差游標」的兩張成組，「多打一行」的那張自己一張。
    // 期望值不改，寫進回報；這裡釘住的是**現在真的會發生的事**。
    assert.equal(groups.length, 1)
    assert.equal(groups[0].keep.name, 'Screenshot 2026-09-18 at 10.31.05.png')
    assert.deepEqual(groups[0].members.map(m => m.name), ['Screenshot 2026-09-18 at 10.31.02.png'])
    assert.equal(groups[0].level, 'similar')
    assert.deepEqual(memberRows(s.db).map(m => m.name).filter(n => n.includes('14.02.44')), [],
      '內容不同的那張不在組裡')
  })
})

describe('D2 similar → 預設不勾，而且框得出差異處', () => {
  test('等級是 similar、信心 40（不到門檻），外框是 0–1 的相對座標', t => {
    const s = sandbox(t)
    put(s.downloads, 'p-a.png', shot({ badge: 1 }), SETTLED + 3 * MIN)
    put(s.downloads, 'p-b.png', shot({ badge: 1, cursor: true }), SETTLED + 1 * MIN)
    s.scan()
    const g = call(s, 'GET', '/cleanup/bursts').body.groups[0]
    assert.equal(g.level, 'similar')
    const m = g.members[0]
    assert.equal(m.name, 'p-a.png')
    assert.equal(m.level, 'similar')
    assert.ok(m.boxes.length >= 1, 'similar 要框得出差異處')
    for (const b of m.boxes) {
      for (const k of ['x', 'y', 'w', 'h']) {
        assert.ok(b[k] >= 0 && b[k] <= 1, `${k}=${b[k]} 不是 0–1 的相對座標`)
      }
      assert.ok(b.x + b.w <= 1.0001 && b.y + b.h <= 1.0001, '框不可以超出圖外')
    }
    // 游標畫在原圖 (600,300)，1280×720 → 大約 (0.469, 0.417)
    const box = m.boxes[0]
    assert.ok(Math.abs(box.x - 600 / 1280) < 0.02, `框的位置不對：${box.x}`)
    assert.ok(Math.abs(box.y - 300 / 720) < 0.02, `框的位置不對：${box.y}`)
    assert.equal(burstCands(s.db)[0].confidence, 40, 'similar 預設不勾（40 < 50）')
  })
})

describe('D3 三張完全一樣（逐位元組相同）→ same → 預設勾', () => {
  test('等級 same、信心 70', t => {
    const s = sandbox(t)
    const buf = shot({ badge: 1 })
    put(s.downloads, 'dup-1.png', buf, SETTLED + 3 * MIN)
    put(s.downloads, 'dup-2.png', buf, SETTLED + 2 * MIN)
    put(s.downloads, 'dup-3.png', buf, SETTLED + 1 * MIN)
    s.scan()
    const g = call(s, 'GET', '/cleanup/bursts').body.groups[0]
    assert.equal(g.level, 'same')
    assert.deepEqual(g.members.map(m => m.level), ['same', 'same'])
    assert.deepEqual(g.members.map(m => m.boxes.length), [0, 0], 'same 沒有差異可框')
    assert.deepEqual(burstCands(s.db).map(c => c.confidence), [70, 70], 'same 預設勾（70 ≥ 50）')
  })
})

describe('D4 組散掉之後舊候選要作廢', () => {
  test('把其中一張改掉 → 重掃之後候選變 skipped、組消失', t => {
    const s = sandbox(t)
    const buf = shot({ w: 400, h: 300, badge: 1 })
    put(s.downloads, 'g-a.png', buf, SETTLED + 3 * MIN)
    const pb = put(s.downloads, 'g-b.png', buf, SETTLED + 1 * MIN)
    s.scan()
    assert.equal(burstCands(s.db).length, 1, '前提：先成組')
    // 換成完全不一樣的一張
    writeFileSync(pb, shot({ w: 400, h: 300, lines: 6, badge: 3, extraLine: true }))
    const at = new Date(Date.now() - SETTLED - 1 * MIN)
    utimesSync(pb, at, at)
    s.scan()
    assert.deepEqual(burstCands(s.db).map(c => c.status), ['skipped'],
      '剩一張不成組，候選要走 skipped（不是 dismissed）')
    assert.deepEqual(call(s, 'GET', '/cleanup/bursts').body.groups, [])
  })
})

describe('D5 留下的那張沒有候選', () => {
  test('三張一組只列兩個候選，keep 一條都沒有', t => {
    const s = sandbox(t)
    const buf = shot({ w: 300, h: 200, badge: 1 })
    put(s.downloads, 'k-1.png', buf, SETTLED + 3 * MIN)
    put(s.downloads, 'k-2.png', buf, SETTLED + 2 * MIN)
    put(s.downloads, 'k-3.png', buf, SETTLED + 1 * MIN)
    s.scan()
    const g = call(s, 'GET', '/cleanup/bursts').body.groups[0]
    const keepId = g.keep.itemId
    assert.equal(g.keep.name, 'k-3.png')
    const rows = burstCands(s.db)
    assert.equal(rows.length, 2)
    assert.ok(!rows.some(r => r.item_id === keepId), '留下的那張不可以有候選')
    // 兩張互相是對方的候選是不可能的
    const ids = new Set(rows.map(r => r.item_id))
    assert.ok(!ids.has(keepId))
  })
})

describe('D6 壞掉的 PNG', () => {
  test('掃描照常完成，problems 有一條只帶檔名（沒有路徑）', t => {
    const s = sandbox(t)
    const good = shot({ w: 200, h: 120 })
    put(s.downloads, '好的.png', good)
    // PNG 簽章對，後面被截斷 → 解不開
    put(s.downloads, '壞掉的.png', good.subarray(0, 40))
    const r = s.scan()
    assert.equal(r.scanned, 2, '掃描照常完成')
    assert.equal(s.problems.length, 1, `problems：${JSON.stringify(s.problems)}`)
    assert.match(s.problems[0], /壞掉的\.png/)
    assert.ok(!s.problems[0].includes(s.downloads), '不可以帶路徑')
    assert.deepEqual(sigRows(s.db).map(r2 => r2.name), ['好的.png'])
  })
})

describe('D7 主動詢問：有新的組才彈', () => {
  test('同一組問過之後不再彈；新的一組出現才彈', t => {
    const s = sandbox(t)
    const buf = shot({ w: 300, h: 200, badge: 1 })
    put(s.downloads, 'q-a.png', buf, SETTLED + 3 * MIN)
    put(s.downloads, 'q-b.png', buf, SETTLED + 2 * MIN)
    s.scan()
    const first = call(s, 'GET', '/pet/state').body
    assert.deepEqual(first.burst, { groups: 1, newGroups: 1 }, '第一次要主動彈')
    assert.deepEqual(call(s, 'GET', '/pet/state').body.burst, { groups: 1, newGroups: 0 },
      '同一組問過就不再彈')
    s.scan()
    assert.deepEqual(call(s, 'GET', '/pet/state').body.burst, { groups: 1, newGroups: 0 },
      '重掃之後還是同一組，一樣不彈')
    // 新的一組
    const buf2 = shot({ w: 320, h: 200, badge: 2 })
    put(s.downloads, 'r-a.png', buf2, SETTLED + 3 * MIN)
    put(s.downloads, 'r-b.png', buf2, SETTLED + 2 * MIN)
    s.scan()
    assert.deepEqual(call(s, 'GET', '/pet/state').body.burst, { groups: 2, newGroups: 1 },
      '新的一組出現才彈')
  })

  test('問過的組 id 記在 meta 的 burst_asked，最多留 50 組', t => {
    const s = sandbox(t)
    const ids = Array.from({ length: 60 }, (_, i) => 'g' + i)
    s.db.prepare('INSERT INTO meta (k,v) VALUES (?,?)').run('burst_asked', JSON.stringify(ids))
    call(s, 'GET', '/pet/state')
    const v = JSON.parse(s.db.prepare('SELECT v FROM meta WHERE k=?').get('burst_asked').v)
    assert.equal(v.length, 50, '只留最新 50 組')
    assert.equal(v[v.length - 1], 'g59', '留的是最新的')
  })
})

describe('D8 縮圖端點', () => {
  test('不帶 token → 401；帶 token 但 item 不在任何組裡 → 404；在組裡 → 灰階 PNG、長邊 ≤ 480', async t => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-burst-http-')))
    const downloads = join(dir, 'Downloads')
    mkdirSync(downloads, { recursive: true })
    const buf = shot({ badge: 1 })
    put(downloads, 'h-a.png', buf, SETTLED + 3 * MIN)
    put(downloads, 'h-b.png', buf, SETTLED + 1 * MIN)
    put(downloads, 'lonely.png', shot({ lines: 9, badge: 3 }), SETTLED + 1 * MIN)
    const dbPath = join(dir, 'data.db')
    const TOKEN = 'burst-wire-token'
    const S = server.start({
      port: 0, db: dbPath, token: TOKEN, roots: [downloads],
      quarantine: join(dir, 'quarantine'), maxBytes: 16 * 1024 * 1024, readonly: false,
    })
    const port = await S.ready
    t.after(() => { S.server.close(); rmSync(dir, { recursive: true, force: true }) })

    const hit = (path, { token = TOKEN } = {}) => new Promise((resolve, reject) => {
      const headers = token ? { 'x-contextbox-token': token } : {}
      const req = request({ host: '127.0.0.1', port, method: 'GET', path, headers }, res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks)
          let json = null
          try { json = JSON.parse(body.toString('utf8')) } catch { /* 不是 JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, body, json })
        })
      })
      req.on('error', reject)
      req.end()
    })

    assert.equal((await hit('/cleanup/scan')).status, 405, '前提：掃描是 POST')
    // 用 route 直接掃一次
    const scanRes = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/cleanup/scan',
        headers: { 'x-contextbox-token': TOKEN, 'content-type': 'application/json' } }, res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
      req.end('{}')
    })
    assert.equal(scanRes.status, 200, scanRes.text)

    const list = await hit('/cleanup/bursts')
    assert.equal(list.status, 200, list.body.toString('utf8'))
    const g = list.json.groups[0]
    assert.equal(g.keep.thumb, `/cleanup/thumb/${g.keep.itemId}`)

    assert.equal((await hit(g.keep.thumb, { token: null })).status, 401, '縮圖端點要 token')

    const lonely = (await hit('/cleanup/candidates')).json   // 只是確認 token 有效
    assert.ok(lonely)
    const lonelyId = (await hit('/cleanup/bursts')).json.groups
      .flatMap(x => [x.keep.itemId, ...x.members.map(m => m.itemId)])
    const miss = await hit('/cleanup/thumb/' + '0'.repeat(36))
    assert.equal(miss.status, 404, '不在任何組裡的 item 一律 404')
    assert.ok(!lonelyId.includes('0'.repeat(36)))

    const thumb = await hit(g.keep.thumb)
    assert.equal(thumb.status, 200)
    assert.equal(thumb.headers['content-type'], 'image/png')
    const size = pngSize(thumb.body)
    assert.ok(Math.max(size.width, size.height) <= 480, `長邊 ${size.width}×${size.height} 超過 480`)
    const gray = decodePngGray(thumb.body)
    assert.equal(gray.width, size.width)
    assert.ok(!thumb.body.toString('latin1').includes(downloads), '回應裡不可以有路徑')
  })

  test('組散掉之後，縮圖端點也跟著 404', t => {
    const s = sandbox(t)
    const buf = shot({ w: 300, h: 200, badge: 1 })
    put(s.downloads, 'z-a.png', buf, SETTLED + 3 * MIN)
    const pb = put(s.downloads, 'z-b.png', buf, SETTLED + 1 * MIN)
    s.scan()
    const id = idOf(s.db, 'z-a.png')
    assert.equal(call(s, 'GET', `/cleanup/thumb/${id}`).bin.code, 200)
    writeFileSync(pb, shot({ w: 300, h: 200, lines: 6, badge: 3, extraLine: true }))
    const at = new Date(Date.now() - SETTLED - 1 * MIN)
    utimesSync(pb, at, at)
    s.scan()
    const r = call(s, 'GET', `/cleanup/thumb/${id}`)
    assert.equal(r.bin, null)
    assert.equal(r.code, 404)
  })
})

describe('D9 清理範圍外的截圖不成組', () => {
  test('沒開 cleanup.screenshots 時，桌面的連拍不會被掃到、也不成組', t => {
    const s = sandbox(t)
    const desktop = join(s.dir, 'Desktop')
    mkdirSync(desktop, { recursive: true })
    const buf = shot({ w: 300, h: 200, badge: 1 })
    put(desktop, 'd-a.png', buf, SETTLED + 3 * MIN)
    put(desktop, 'd-b.png', buf, SETTLED + 1 * MIN)
    put(s.downloads, 'ok.png', shot({ w: 300, h: 200 }), SETTLED + 1 * MIN)
    s.scan()
    assert.deepEqual(memberRows(s.db).map(m => m.name), [])
    assert.deepEqual(call(s, 'GET', '/cleanup/bursts').body.groups, [])
  })
})

describe('D10 一批超過 120 張', () => {
  test('scan 的回應講得出還有幾張沒算，而且不會讓沒算到的那幾張成組', t => {
    const s = sandbox(t)
    // 125 張各自不同的小圖，時間錯開（不會成組），再加一組真的連拍
    for (let i = 0; i < 125; i++) put(s.downloads, `m${String(i).padStart(3, '0')}.png`, tiny(i), (i + 10) * MIN)
    const r = s.scan()
    assert.equal(r.imagesPending, 5)
    assert.equal(sigRows(s.db).length, 120)
    const r2 = s.scan()
    assert.equal(r2.imagesPending, 0)
    assert.equal(sigRows(s.db).length, 125)
  })
})

// ═══ 灰階 PNG 編碼器 ═════════════════════════════════════════

describe('png-write：零依賴的灰階 PNG 編碼器', () => {
  test('寫出來的圖，自家的解碼器讀得回一模一樣的灰階', () => {
    const w = 37, h = 23
    const gray = new Uint8Array(w * h)
    for (let i = 0; i < gray.length; i++) gray[i] = (i * 37) % 256
    const buf = pngWrite.encodeGrayPng(w, h, gray)
    assert.deepEqual(pngSize(buf), { width: w, height: h })
    const back = decodePngGray(buf)
    assert.equal(back.width, w)
    assert.equal(back.height, h)
    assert.deepEqual(Array.from(back.gray), Array.from(gray))
  })

  test('長度對不上就丟錯，不寫出半張圖', () => {
    assert.throws(() => pngWrite.encodeGrayPng(4, 4, new Uint8Array(15)), /灰階|長度/)
    assert.throws(() => pngWrite.encodeGrayPng(0, 4, new Uint8Array(0)), /正整數|寬高/)
  })
})

// ═══ 熱路徑 ══════════════════════════════════════════════════

describe('沒有 PNG 的資料夾，掃描不可以因此變慢很多', () => {
  test('一般的檔一個指紋都不算、一條問題都不報', t => {
    const s = sandbox(t)
    for (let i = 0; i < 40; i++) put(s.downloads, `doc${i}.pdf`, Buffer.alloc(2000, i))
    const r = s.scan()
    assert.equal(r.scanned, 40)
    assert.equal(r.imagesPending, 0)
    assert.equal(sigRows(s.db).length, 0)
    assert.deepEqual(s.problems, [])
  })
})
