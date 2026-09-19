#!/usr/bin/env node
/**
 * 產生 docs/api/*.json —— **每一份都是真的 server 回的，不是手寫的**（稽核 RC20）。
 *
 *   node tools/gen-api-examples.mjs              寫進 docs/api/
 *   node tools/gen-api-examples.mjs --out <dir>  寫到別的資料夾（test/repo.test.mjs 用這個比對）
 *
 * 做法：在暫存資料夾裡起一個真的 server（port 0、假的家目錄），放一批垃圾檔，
 * 走一輪典型操作（掃描 → 看清單 → 建計畫 → 套用 → 復原 → 放棄 → 清空），
 * 把每個 route 的回應原封不動寫下來。回應裡如果出現暫存資料夾的路徑，一律換成 /home/alice。
 *
 * 為什麼要有這支：以前的範例是手寫的，實作改了範例沒跟著改（`/health` 的欄位改名、
 * 文件寫的「重送 apply 回 409」根本不存在、兩張互相矛盾的錯誤表）。C 拿範例當 mock，
 * 寫出來的 UI 對的是一個不存在的後端。
 *
 * test/repo.test.mjs 會跑這支（寫到暫存資料夾），比對 docs/api 裡每一份的**欄位集合**
 * 跟現在的輸出一不一樣。值不比（id、時間每次都不同），欄位多一個少一個都會紅。
 * 改了回應的形狀，就重跑一次這支，把 docs/api 一起 commit。
 *
 * **絕對不碰**真的家目錄、~/.contextbox、~/Downloads，也不佔 7391：
 * 家目錄在 import 任何 core 模組**之前**就換成暫存的（core/config.ts 在載入時就算好路徑），
 * server 的每一個路徑都明確給，port 用 0。行程結束時整個暫存資料夾刪掉。
 */
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, realpathSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request } from 'node:http'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ── 參數 ────────────────────────────────────────────────────
const argv = process.argv.slice(2)
let OUT = join(REPO, 'docs', 'api')
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out' && argv[i + 1]) { OUT = resolve(argv[++i]); continue }
  if (argv[i] === '--help' || argv[i] === '-h') {
    console.log('用法：node tools/gen-api-examples.mjs [--out <資料夾>]')
    process.exit(0)
  }
  console.error(`看不懂的參數：${argv[i]}`)
  process.exit(1)
}

// ── 假的家目錄：一定要在 import core 之前 ──────────────────────
// 家目錄就叫 <暫存>/home/alice，這樣回應裡萬一出現路徑，拿掉 <暫存> 前綴就是 /home/alice/…
const T = realpathSync(mkdtempSync(join(tmpdir(), 'cb-apigen-')))
process.on('exit', () => { try { rmSync(T, { recursive: true, force: true }) } catch { /* 刪不掉就留給系統清 */ } })
const HOME = join(T, 'home', 'alice')
const DL = join(HOME, 'Downloads')
const BOX = join(HOME, '.contextbox')
const Q = join(BOX, 'quarantine')
const DB = join(BOX, 'data.db')
mkdirSync(DL, { recursive: true })
mkdirSync(BOX, { recursive: true })
process.env.HOME = HOME
process.env.USERPROFILE = HOME
for (const k of ['CONTEXTBOX_CONFIG', 'CONTEXTBOX_DB', 'CONTEXTBOX_QUARANTINE', 'CONTEXTBOX_TOKEN_PATH', 'CONTEXTBOX_READONLY']) {
  delete process.env[k]
}

const { start } = await import('../core/server.ts')
const { META } = await import('../core/cleanup-routes.ts')
const { DatabaseSync } = await import('node:sqlite')

// 上限刻意設小，才造得出「太大、這個工具不處理」的例子
const MAX_BYTES = 64 * 1024
const TOKEN = 'example-token-not-a-real-one'
const DAY = 86400_000

// ── 放垃圾 ──────────────────────────────────────────────────
function put(rel, content, ageMs) {
  const p = join(DL, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
  if (ageMs) { const t = new Date(Date.now() - ageMs); utimesSync(p, t, t) }
  return p
}
const DUP = 'SMOKE 這是一份報告的內容\n'
put('報告.pdf', DUP, 2 * 3600_000)
put('報告 (1).pdf', DUP, 2 * 3600_000)
put('安裝檔.msi', 'SMOKE 假安裝檔\n', 30 * DAY)
put('素材包.zip', 'SMOKE 假壓縮檔\n', 60 * DAY)
put('空的.txt', '', 3 * DAY)
put('很舊的.bin', 'SMOKE 很舊的東西\n', 200 * DAY)
put('Screenshot 2026-01-02 141203.png', 'SMOKE 假截圖\n', 120 * DAY)
put('下載中.iso.crdownload', 'SMOKE 半個檔\n', 3 * DAY)
put(join('2026', '09', '發票.zip'), 'SMOKE 發票\n', 45 * DAY)
put('備份.tar', 'x'.repeat(MAX_BYTES + 1024), 200 * DAY)
// 剛剛才複製出來的重複檔：列得出來，但十分鐘內搬不動（TOO_FRESH）
put('照片.jpg', 'SMOKE 同一張照片\n', 0)
put('照片 (1).jpg', 'SMOKE 同一張照片\n', 0)

// ── server ─────────────────────────────────────────────────
const S = start({ port: 0, db: DB, token: TOKEN, roots: [DL], quarantine: Q, maxBytes: MAX_BYTES, readonly: false })
const port = await S.ready

/** 打一次 server。回 { status, headers, body }。body 是 JSON 就解析，不是就原樣。 */
function call(method, path, { body, token = TOKEN, headers = {}, to = port } = {}) {
  return new Promise((ok, fail) => {
    const h = { ...headers }
    if (token) h['x-contextbox-token'] = token
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    if (payload !== undefined) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(payload) }
    const req = request({ host: '127.0.0.1', port: to, method, path, headers: h }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed = text
        try { parsed = JSON.parse(text) } catch { /* 純文字 */ }
        ok({ status: res.statusCode, headers: res.headers, body: parsed })
      })
    })
    req.on('error', fail)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/** 一定要是這個狀態碼，不是的話產生器自己失敗 —— 不可以把錯的回應寫成範例。 */
async function expect(status, method, path, opts) {
  const r = await call(method, path, opts)
  if (r.status !== status) {
    throw new Error(`${method} ${path} 預期 ${status}，拿到 ${r.status}：${JSON.stringify(r.body)}`)
  }
  return r
}

const db = new DatabaseSync(DB)
const files = {}
const errors = {}
/** 錯誤範例只留呼叫端需要看的 header。 */
const KEEP_HEADERS = ['retry-after', 'allow']
function recordError(label, req, r) {
  const e = { request: req, status: r.status }
  const hs = Object.fromEntries(KEEP_HEADERS.filter(k => r.headers[k] !== undefined).map(k => [k, r.headers[k]]))
  if (Object.keys(hs).length) e.headers = hs
  e.body = r.body
  errors[label] = e
}

// ── 1 ・ 掃描與清單 ─────────────────────────────────────────
files['cleanup-scan.json'] = (await expect(200, 'POST', '/cleanup/scan', { body: {} })).body
const list = (await expect(200, 'GET', '/cleanup/candidates')).body
files['cleanup-candidates.json'] = list

const byName = name => {
  const c = list.candidates.find(x => x.name === name)
  if (!c) throw new Error(`清單上找不到 ${name}：規則或掃描器的行為變了，產生器的劇本要跟著改`)
  return c.candidateIds
}

// ── 2 ・ 建計畫、撞衝突、查詢、套用 ───────────────────────────
const planA = (await expect(200, 'POST', '/cleanup/plans', {
  body: { candidateIds: [...byName('素材包.zip'), ...byName('安裝檔.msi'), ...byName('空的.txt')], requestId: 'example-1' },
})).body
files['cleanup-plans-create.json'] = planA

recordError('撞到一份還沒套用的計畫（回擋住這次勾選的那一份）', 'POST /cleanup/plans',
  await expect(409, 'POST', '/cleanup/plans', { body: { candidateIds: byName('素材包.zip'), requestId: 'example-2' } }))

files['cleanup-plans-get.json'] = (await expect(200, 'GET', `/cleanup/plans/${planA.id}`)).body
files['cleanup-plans-list-pending.json'] = (await expect(200, 'GET', '/cleanup/plans?pending=1')).body

files['cleanup-plans-apply.json'] = (await expect(200, 'POST', `/cleanup/plans/${planA.id}/apply`, { body: {} })).body
// 重送同一份：冪等，不會搬第二次（不另外存檔，只確認）
const replay = (await expect(200, 'POST', `/cleanup/plans/${planA.id}/apply`, { body: {} })).body
if (replay.quarantinedCount !== files['cleanup-plans-apply.json'].quarantinedCount) {
  throw new Error('重送 apply 的結果跟第一次不一樣')
}

recordError('已經套用的計畫再 dismiss', `POST /cleanup/plans/:id/dismiss`,
  await expect(409, 'POST', `/cleanup/plans/${planA.id}/dismiss`, { body: {} }))
recordError('已經開始的計畫不能放棄', `POST /cleanup/plans/:id/release`,
  await expect(409, 'POST', `/cleanup/plans/${planA.id}/release`, { body: {} }))

// ── 3 ・ 搬到一半壞掉：一個搬走、一個剛複製出來（太新）、一個不見了 ──────
const planB = (await expect(200, 'POST', '/cleanup/plans', {
  body: {
    candidateIds: [...byName('發票.zip'), ...list.candidates.filter(c => c.name.startsWith('照片')).flatMap(c => c.candidateIds),
      ...byName('下載中.iso.crdownload')],
    requestId: 'example-3',
  },
})).body
rmSync(join(DL, '下載中.iso.crdownload'))
files['cleanup-plans-apply-partial.json'] = (await expect(200, 'POST', `/cleanup/plans/${planB.id}/apply`, { body: {} })).body

// ── 4 ・ 這台機器的設定壞了（隔離區指到一個檔案）：500，而且記成 lastError ──
// 同一個資料庫、另一個 server。記下來的 lastError 是翻過的人話，不帶路徑；
// 之後只要有一次成功的動作（下一步的復原），寵物就不再擔心（lastOkAt 比它新）。
const planC = (await expect(200, 'POST', '/cleanup/plans', { body: { candidateIds: byName('很舊的.bin'), requestId: 'example-4' } })).body
writeFileSync(join(BOX, 'not-a-folder'), '這不是資料夾')
const BROKEN = start({ port: 0, db: DB, token: TOKEN, roots: [DL], quarantine: join(BOX, 'not-a-folder'), maxBytes: MAX_BYTES, readonly: false })
const brokenPort = await BROKEN.ready
// server 會把原文印到 console.error —— 這一次是故意的，不要嚇到跑產生器的人
const quiet = console.error
console.error = () => {}
try {
  recordError('這台機器的設定有問題（例如隔離區不是資料夾）', 'POST /cleanup/plans/:id/apply',
    await expect(500, 'POST', `/cleanup/plans/${planC.id}/apply`, { body: {}, to: brokenPort }))
} finally { console.error = quiet }
BROKEN.server.close()

// ── 5 ・ 復原，其中一個原位置已經被新檔佔了（放回來的那份改名 .restored） ──
put('素材包.zip', 'SMOKE 後來又下載了一個同名的\n', 0)
files['cleanup-plans-undo.json'] = (await expect(200, 'POST', `/cleanup/plans/${planA.id}/undo`, { body: {} })).body

// ── 6 ・ 拒絕（dismiss）與放棄（release） ─────────────────────
files['cleanup-plans-dismiss.json'] = (await expect(200, 'POST', `/cleanup/plans/${planC.id}/dismiss`, { body: {} })).body
const planD = (await expect(200, 'POST', '/cleanup/plans', {
  body: { candidateIds: byName('Screenshot 2026-01-02 141203.png'), requestId: 'example-5' },
})).body
files['cleanup-plans-release.json'] = (await expect(200, 'POST', `/cleanup/plans/${planD.id}/release`, { body: {} })).body

// ── 7 ・ 計畫列表的三種篩法 ─────────────────────────────────
files['cleanup-plans-list-undoable.json'] = (await expect(200, 'GET', '/cleanup/plans?undoable=1')).body
files['cleanup-plans-list.json'] = (await expect(200, 'GET', '/cleanup/plans')).body

// ── 8 ・ 隔離區：把發票.zip 的隔離時間撥回八天前，才示範得到「可以清空」 ──
db.prepare(`UPDATE cleanup_move_details SET completed_at=?
  WHERE seq IN (SELECT seq FROM cleanup_journal WHERE plan_id=? AND op='quarantine' AND status='done')`)
  .run(new Date(Date.now() - 8 * DAY).toISOString(), planB.id)
files['cleanup-quarantine.json'] = (await expect(200, 'GET', '/cleanup/quarantine')).body

// ── 9 ・ 健康檢查與寵物（模擬 pet 正在跑：寫一次心跳） ──────────
db.prepare(`INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(META.heartbeat, new Date().toISOString())
db.prepare(`INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(META.pid, String(process.pid))
files['health.json'] = (await expect(200, 'GET', '/health', { token: null })).body
files['health-with-token.json'] = (await expect(200, 'GET', '/health')).body
files['pet-state.json'] = (await expect(200, 'GET', '/pet/state')).body

// ── 10 ・ 清空隔離區：預覽 → 確認 ───────────────────────────────
const preview = (await expect(200, 'POST', '/cleanup/quarantine/empty', { body: {} })).body
files['cleanup-quarantine-empty-preview.json'] = preview
recordError('confirmed 不是布林', 'POST /cleanup/quarantine/empty',
  await expect(400, 'POST', '/cleanup/quarantine/empty', { body: { token: preview.token, confirmed: 'true' } }))
recordError('預覽過了但沒帶 confirmed', 'POST /cleanup/quarantine/empty',
  await expect(428, 'POST', '/cleanup/quarantine/empty', { body: { token: preview.token } }))
files['cleanup-quarantine-empty-done.json'] = (await expect(200, 'POST', '/cleanup/quarantine/empty', {
  body: { token: preview.token, confirmed: true },
})).body

recordError('沒先預覽就直接確認', 'POST /cleanup/quarantine/empty',
  await expect(428, 'POST', '/cleanup/quarantine/empty', { body: { token: '亂編的', confirmed: true } }))
const stale = (await expect(200, 'POST', '/cleanup/quarantine/empty', { body: {} })).body
db.prepare('UPDATE cleanup_empty_requests SET expires_at=? WHERE token=?').run(new Date(Date.now() - 1000).toISOString(), stale.token)
recordError('預覽的 token 過期了', 'POST /cleanup/quarantine/empty',
  await expect(410, 'POST', '/cleanup/quarantine/empty', { body: { token: stale.token, confirmed: true } }))

// ── 11 ・ 其他錯誤：每一種都真的觸發一次 ──────────────────────
recordError('找不到那份計畫', 'GET /cleanup/plans/:id', await expect(404, 'GET', `/cleanup/plans/${encodeURIComponent('沒有這份')}`))
recordError('計畫 id 的 %xx 壞掉', 'GET /cleanup/plans/%E0%A4%A', await expect(400, 'GET', '/cleanup/plans/%E0%A4%A'))
recordError('body 不是 JSON', 'POST /cleanup/plans', await expect(400, 'POST', '/cleanup/plans', { body: '{"candidateIds": [' }))
recordError('candidateIds 是 null（沒帶才是預設）', 'POST /cleanup/plans',
  await expect(400, 'POST', '/cleanup/plans', { body: { candidateIds: null } }))
recordError('limit 超出範圍', 'GET /cleanup/candidates?limit=0', await expect(400, 'GET', '/cleanup/candidates?limit=0'))
recordError('清單變了（id 已經不在清單上）', 'POST /cleanup/plans',
  await expect(409, 'POST', '/cleanup/plans', { body: { candidateIds: ['00000000-0000-4000-8000-000000000000'] } }))
recordError('沒有勾任何東西', 'POST /cleanup/plans', await expect(409, 'POST', '/cleanup/plans', { body: { candidateIds: [] } }))
recordError('用錯方法', 'GET /cleanup/scan', await expect(405, 'GET', '/cleanup/scan'))
recordError('還沒做的功能', 'GET /cleanup/reveal', await expect(501, 'GET', '/cleanup/reveal'))
recordError('body 超過 1 MB', 'POST /cleanup/plans',
  await expect(413, 'POST', '/cleanup/plans', { body: JSON.stringify({ requestId: 'x', pad: 'y'.repeat(1_100_000) }) }))
recordError('沒帶 token', 'GET /cleanup/candidates', await expect(401, 'GET', '/cleanup/candidates', { token: null }))
recordError('網頁來的請求', 'GET /cleanup/candidates',
  await expect(403, 'GET', '/cleanup/candidates', { headers: { origin: 'https://evil.example.com' } }))

// 另一個清理動作正在跑：假裝別的行程握著鎖（owner 是「時間 id」，30 分鐘內算活的）
db.prepare('INSERT OR REPLACE INTO cleanup_operation_lock VALUES (1,?,?)')
  .run(process.pid, `${new Date().toISOString()} 00000000-0000-4000-8000-00000000b057`)
recordError('另一個清理動作正在跑', 'POST /cleanup/plans/:id/undo',
  await expect(503, 'POST', `/cleanup/plans/${planB.id}/undo`, { body: {} }))
db.prepare('DELETE FROM cleanup_operation_lock').run()

// 唯讀模式：同一個資料庫、另一個唯讀的 server
const RO = start({ port: 0, db: DB, token: TOKEN, roots: [DL], quarantine: Q, maxBytes: MAX_BYTES, readonly: true })
const roPort = await RO.ready
recordError('唯讀模式', 'POST /cleanup/plans', await expect(403, 'POST', '/cleanup/plans', { body: {}, to: roPort }))
RO.server.close()

files['errors.json'] = errors

// ── 寫出去 ─────────────────────────────────────────────────
S.server.close()
db.close()

/** 暫存資料夾的每一種寫法都換掉：<暫存>/home/alice/… → /home/alice/… */
const PREFIXES = [...new Set([T, realpathSync(T)])].sort((a, b) => b.length - a.length)
function scrub(v) {
  if (typeof v === 'string') {
    let s = v
    for (const p of PREFIXES) {
      // Windows 的路徑分隔是 \，拿掉前綴之後一起換成 /
      s = s.split(p + sep).join('/').split(p).join('')
      if (sep === '\\') s = s.replace(/\/home\\alice[^\s"'，。）]*/g, m => m.replace(/\\/g, '/'))
    }
    return s
  }
  if (Array.isArray(v)) return v.map(scrub)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]))
  return v
}

/** 每一個字串（含 key）。比對要在 JSON.parse 之後的字串上做 —— JSON 文字裡 Windows 的反斜線是跳脫過的。 */
const strings = (v, out = []) => {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) v.forEach(x => strings(x, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); strings(x, out) }
  return out
}

// 先全部檢查完才寫：換完還看得到暫存資料夾或這台機器的暫存根目錄，就是有路徑沒被換掉 —— 一份都不寫
const clean = Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([name, body]) => [name, scrub(body)])
const roots = [...PREFIXES, tmpdir(), realpathSync(tmpdir())]
const leftovers = clean.filter(([, body]) => strings(body).some(x => roots.some(r => x.includes(r)))).map(([name]) => name)
if (leftovers.length) {
  console.error(`這些範例裡還有暫存資料夾的路徑，沒有換乾淨，一份都沒寫：${leftovers.join('、')}`)
  process.exit(2)
}
mkdirSync(OUT, { recursive: true })
for (const [name, body] of clean) writeFileSync(join(OUT, name), JSON.stringify(body, null, 2) + '\n')
// docs/api 裡有、但這一輪沒產生的 .json 就是過期的範例
const stale_ = existsSync(OUT) ? readdirSync(OUT).filter(f => f.endsWith('.json') && !(f in files)) : []
if (stale_.length) console.warn(`⚠ ${OUT} 裡這些範例不是產生器寫的，應該刪掉：${stale_.join('、')}`)
console.log(`寫了 ${Object.keys(files).length} 份範例到 ${OUT}`)
process.exit(0)
