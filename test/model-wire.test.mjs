import './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * P2「讓模型看懂內容」的**預期行為十二條**（~/contextbox-預想-20260919-P2看懂.md 最後一節），
 * 一條一條變成測試。**全部打假的本機模型伺服器，一次都不打真的模型、也不讀真的金鑰。**
 *
 * 這一支是「整條線」的測試：真的掃描 → 真的資料庫 → 真的佇列 → 假的模型 →
 * 真的候選清單／連拍組／doctor。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { open as openDb } from '../core/db.ts'
import { scanDownloads } from '../core/cleanup-scanner.ts'
import { encodeGrayPng } from '../core/png-write.ts'
import {
  burstGroupsView, errorStillActive, healthSnapshot, listCandidates, recordCleanupError,
} from '../core/cleanup-routes.ts'
import { thinkRound, pendingItems, payloadFor } from '../core/model-queue.ts'
import {
  modelStats, modelViewForItem, modelSkipOf, opinionOf, putModelView, viewKey,
} from '../core/model-store.ts'
import { PROMPT_VERSION, imagePayload, textPayload } from '../core/model.ts'
import { SECRET_WHY } from '../core/model-guard.ts'
import { modelOpinionLines } from '../core/assets/cleanup-real-state.js'
import { GOOD_VIEW, completion, startFakeModel } from './helpers/fake-model.mjs'

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const CLI = join(REPO, 'cli.mjs')
const KEY_ENV = 'CONTEXTBOX_MODEL_KEY'
/** 測試用的假金鑰。真的金鑰只在 ~/.contextbox/env，這裡永遠不碰。 */
const FAKE_KEY = 'fake-key-for-tests-0123456789'
const DAY = 86400_000

/** 一份看得出是哪一堂課的講義（長度過得了 30 個字的門檻）。 */
const OS_CH6 = '作業系統 第 6 章 死結\n\n四個必要條件：互斥、持有並等待、不可搶奪、循環等待。銀行家演算法、資源配置圖。\n'

/** 一張像截圖的灰階 PNG。 */
const shot = (w = 320, h = 180, fill = 200) => encodeGrayPng(w, h, new Uint8Array(w * h).fill(fill))

/**
 * 沙盒：一個假的 Downloads、一個真的資料庫，掃過一次。
 * **全部在暫存資料夾裡，不碰真的家目錄、不碰真的 ~/.contextbox。**
 */
function sandbox(t, files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-model-')))
  const downloads = join(dir, 'Downloads')
  mkdirSync(downloads)
  const dbPath = join(dir, 'data.db')
  const db = openDb(dbPath)
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  const put = (name, content, days = 40) => {
    const p = join(downloads, name)
    writeFileSync(p, content)
    const at = new Date(Date.now() - days * DAY)
    utimesSync(p, at, at)
    return p
  }
  for (const [name, content] of Object.entries(files ?? {})) put(name, content)
  const opts = { roots: [downloads], quarantine: join(dir, 'quarantine'), maxBytes: 8 << 20 }
  const scan = () => scanDownloads({ db, ...opts })
  scan()
  const idOf = name => db.prepare('SELECT id FROM file_items WHERE name=?').get(name)?.id ?? null
  return { dir, downloads, db, dbPath, opts, put, scan, idOf }
}

/** 一份 Config（只有模型與清理那一段有意義）。 */
const cfg = (roots, baseUrl, name = 'fake-model') => ({
  watch: [], filed: join(roots[0], '..', 'Filed'), readonly: false, pdfPages: 3, maxBytes: 8 << 20,
  cleanup: { roots, screenshots: false, screenshotsDir: null },
  model: { baseUrl, name, keyEnv: KEY_ENV },
})

function withKey(t, value) {
  const before = process.env[KEY_ENV]
  if (value === null) delete process.env[KEY_ENV]
  else process.env[KEY_ENV] = value
  t.after(() => { if (before === undefined) delete process.env[KEY_ENV]; else process.env[KEY_ENV] = before })
}

/** 抓 console 的輸出（第 11 條：送出去的內容不可以出現在 log 裡）。 */
function captureConsole(t) {
  const lines = []
  const keep = { log: console.log, error: console.error, warn: console.warn }
  for (const k of Object.keys(keep)) console[k] = (...a) => lines.push(a.map(String).join(' '))
  t.after(() => { for (const k of Object.keys(keep)) console[k] = keep[k] })
  return lines
}

/** 一個一定連不上的網址（起一台再關掉，那個 port 就沒人在聽了）。 */
async function deadUrl(t) {
  const fake = await startFakeModel(t)
  await fake.close()
  return fake.baseUrl
}

/** 跑一輪，順手把 lastError 記成 model 那一種（CLI 與 pet 做的是同一件事）。 */
const round = (s, config, extra = {}) => thinkRound({
  db: s.db, config, roots: config.cleanup.roots,
  onError: msg => recordCleanupError(s.db, new Error(msg), 'model'),
  ...extra,
})

// ═══ 1 ・ 沒設定模型 ══════════════════════════════════════════

describe('第 1 條 ・ 沒設定模型：一切照常，一個請求都不送', () => {
  test('thinkRound 直接回「沒開」，假伺服器一次都沒被打到', async t => {
    const s = sandbox(t, { '作業系統_第6章.txt': OS_CH6 })
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    // baseUrl 是空的（乾淨安裝）
    const r = await round(s, cfg([s.downloads], ''))
    assert.equal(r.enabled, false)
    assert.deepEqual([r.total, r.asked, r.cached, r.skipped, r.failed], [0, 0, 0, 0, 0])
    assert.deepEqual(fake.requests, [], '沒設定卻送出去了')
  })

  test('掃描、清理候選、連拍組全部照常（model 欄位是 null）', t => {
    const s = sandbox(t, { 'a.zip': 'x'.repeat(100), '作業系統_第6章.txt': OS_CH6 })
    const list = listCandidates(s.db, { roots: [s.downloads] })
    assert.ok(list.candidates.length > 0, '前提：有候選')
    for (const c of list.candidates) assert.equal(c.model, null, '沒接模型卻有看法')
    assert.deepEqual(burstGroupsView(s.db, [s.downloads]), [])
    assert.equal(healthSnapshot(s.db, { roots: [s.downloads], quarantine: s.opts.quarantine }).pendingCandidates >= 0, true)
  })

  test('doctor 講一句「沒設定模型」', async t => {
    const s = sandbox(t, { '作業系統_第6章.txt': OS_CH6 })
    const r = await runCli(s, ['doctor'], { [KEY_ENV]: '' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /看懂內容\s+✗ 沒設定模型/)
  })

  test('CLI 的 think 也不做事，而且離開碼是 0（那不是錯，是還沒接）', async t => {
    const s = sandbox(t, { '作業系統_第6章.txt': OS_CH6 })
    const r = await runCli(s, ['think'], { [KEY_ENV]: '' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /看懂內容還沒開/)
    assert.match(r.stdout, /掃描、清理、面板照常/)
  })
})

/**
 * 在沙盒裡跑一次 CLI。**子行程拿到的是沙盒的假 HOME，不是你真的家目錄。**
 *
 * **一定要用非同步的 spawn**：假的模型伺服器跑在這個測試行程裡，spawnSync 會把
 * event loop 整個卡住 —— 子行程送過來的請求永遠不會被回應，然後等滿 60 秒。
 */
function runCli(s, argv, env = {}, modelCfg = null) {
  const home = join(s.dir, 'home')
  mkdirSync(home, { recursive: true })
  const cfgPath = join(s.dir, 'config.json')
  writeFileSync(cfgPath, JSON.stringify({
    watch: [s.downloads], filed: join(home, 'Filed'),
    model: modelCfg ?? { baseUrl: '', name: '', keyEnv: KEY_ENV },
    readonly: false, pdfPages: 3, maxBytes: 8 << 20,
    cleanup: { roots: [s.downloads], screenshots: false },
  }, null, 2))
  const child = spawn(process.execPath, [CLI, ...argv], {
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      CONTEXTBOX_CONFIG: cfgPath, CONTEXTBOX_DB: s.dbPath,
      CONTEXTBOX_QUARANTINE: s.opts.quarantine, CONTEXTBOX_TOKEN_PATH: join(s.dir, 'token'),
      CONTEXTBOX_PORT: '0', ...env,
    },
  })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8'); child.stdout.on('data', d => { stdout += d })
  child.stderr.setEncoding('utf8'); child.stderr.on('data', d => { stderr += d })
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已經結束了 */ } }, 60_000)
    child.once('error', e => { clearTimeout(timer); fail(e) })
    child.once('close', status => { clearTimeout(timer); ok({ status, stdout, stderr }) })
  })
}

// ═══ 2 ・ 設定了但叫不動 ══════════════════════════════════════

describe('第 2 條 ・ 叫不動：連續三次失敗就停，lastError 的 kind 是 model，掃描與清理照常', () => {
  test('三次失敗就停，lastError 記成 model、寵物還在擔心', async t => {
    const s = sandbox(t, {
      'os1.txt': OS_CH6, 'os2.txt': OS_CH6 + '一', 'os3.txt': OS_CH6 + '二',
      'os4.txt': OS_CH6 + '三', 'os5.txt': OS_CH6 + '四',
    })
    withKey(t, FAKE_KEY)
    const url = await deadUrl(t)
    const r = await round(s, cfg([s.downloads], url))
    assert.equal(r.enabled, true)
    assert.equal(r.failed, 3, '連續失敗三次就要停，不可以把五個檔全部燒完')
    assert.ok(r.stopped, '要講得出這一輪為什麼停')
    const h = healthSnapshot(s.db, { roots: [s.downloads], quarantine: s.opts.quarantine, full: true })
    assert.equal(h.lastErrorKind, 'model')
    assert.equal(errorStillActive(h), true, '寵物要為它擔心')
  })

  test('掃描與清理照常（模型壞掉不影響本來就會做的事）', async t => {
    const s = sandbox(t, { 'os1.txt': OS_CH6, 'a.zip': 'x'.repeat(200), 'b.zip': 'x'.repeat(200) })
    withKey(t, FAKE_KEY)
    await round(s, cfg([s.downloads], await deadUrl(t)))
    assert.ok(s.scan().scanned > 0)
    assert.ok(listCandidates(s.db, { roots: [s.downloads] }).candidates.length > 0)
  })

  test('**模型掛掉一陣子不可以把檔永久燒掉**：修好之後照樣問得到', async t => {
    // 閘道掛三十分鐘（pet 每 10 分鐘一輪＝三、四輪）以前會把排在最前面的幾個檔標成
    // 「問了幾次都問不到」，之後連改內容都救不回來（P2 驗證員）。
    // 連不上、逾時、5xx 是 transport，不算這個檔答不出來。
    const s = sandbox(t, { 'os1.txt': OS_CH6 })
    withKey(t, FAKE_KEY)
    const dead = cfg([s.downloads], await deadUrl(t))
    for (let i = 0; i < 4; i++) await round(s, dead)
    const fake = await startFakeModel(t)
    const r = await round(s, cfg([s.downloads], fake.baseUrl))
    assert.equal(r.asked, 1, `修好之後要照樣問：${JSON.stringify(r)}`)
    assert.equal(r.skipped, 0, '不可以被標成「問不到」')
  })

  test('對照：模型有回應、但答案一直不能用 → 問三次之後就不再問它', async t => {
    const s = sandbox(t, { 'os1.txt': OS_CH6 })
    withKey(t, FAKE_KEY)
    // 每次都回 200，但內容不是合法的答案（模型真的答不出來）
    // handler 回 true 代表「我自己回應了」，不回 true 的話預設分支會再寫一次
    const fake = await startFakeModel(t, ({ send }) => { send(200, completion('不是 JSON 的東西')); return true })
    const bad = cfg([s.downloads], fake.baseUrl)
    for (let i = 0; i < 3; i++) await round(s, bad)
    const r = await round(s, bad)
    assert.equal(r.asked, 0, '答不出來的檔問三次就夠了')
    assert.equal(r.skipped, 1)
  })

  test('掃描成功不會把模型的錯蓋掉（分種類記的用意）', async t => {
    const s = sandbox(t, { 'os1.txt': OS_CH6, 'os2.txt': OS_CH6 + '一', 'os3.txt': OS_CH6 + '二' })
    withKey(t, FAKE_KEY)
    await round(s, cfg([s.downloads], await deadUrl(t)))
    const { recordOk } = await import('../core/cleanup-routes.ts')
    recordOk(s.db, 'scan')
    const h = healthSnapshot(s.db, { roots: [s.downloads], quarantine: s.opts.quarantine, full: true })
    assert.equal(errorStillActive(h), true, '掃描成功不算模型好了')
  })
})

// ═══ 3、4 ・ 像機密的不送 ═════════════════════════════════════

describe('第 3、4 條 ・ 像機密的檔不送，而且講得出為什麼', () => {
  test('名字像機密的（server.key、憑證備份.pem、我的password備份.txt）：不送，model_skips 有一句「看起來像機密」', async t => {
    const pk = '-----BEGIN OPENSSH PRIVATE KEY-----\n' + 'b3BlbnNzaC1rZXktdjEAAAAA\n'.repeat(8)
    const names = ['server.key', '憑證備份.pem', '我的password備份.txt']
    const s = sandbox(t, Object.fromEntries(names.map(n => [n, pk])))
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    const r = await round(s, cfg([s.downloads], fake.baseUrl))
    assert.equal(r.asked, 0)
    assert.equal(r.skipped, names.length)
    assert.deepEqual(fake.requests, [], '**金鑰被送出去了**')
    for (const n of names) {
      const skip = modelSkipOf(s.db, s.idOf(n))
      assert.ok(skip, `${n}：model_skips 沒有這一列`)
      assert.equal(skip.why, SECRET_WHY)
      assert.match(skip.why, /看起來像機密/)
    }
  })

  test('**沒有副檔名的 id_rsa 與 .env 連掃描都不收**（比「沒送」更早一步擋住）', t => {
    // core/guard.ts 的 DENY_FILES 與「隱藏檔」規則：掃描器一開始就不收它們，
    // 所以它們連 file_items 都沒有一列 —— 預想的預期行為第 3 條說 model_skips 會有一句，
    // 實際上更早就擋住了（見 notDone 的說明）。這裡把「更早擋住」釘死。
    const s = sandbox(t, {
      id_rsa: 'x'.repeat(300), 'id_rsa.pem': 'x'.repeat(300), '.env': 'y'.repeat(300), 'note.txt': OS_CH6,
    })
    const names = s.db.prepare('SELECT name FROM file_items').all().map(x => x.name)
    assert.deepEqual(names.sort(), ['note.txt'], `掃描收了它們：${names.join('、')}`)
    for (const n of ['id_rsa', 'id_rsa.pem', '.env']) assert.equal(s.idOf(n), null, `${n} 被掃描收進來了`)
  })

  test('內容含 -----BEGIN PRIVATE KEY----- 的 .txt：不送，同上', async t => {
    const body = '我的備份\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n'
    const s = sandbox(t, { '筆記.txt': body })
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    const r = await round(s, cfg([s.downloads], fake.baseUrl))
    assert.equal(r.asked, 0)
    assert.deepEqual(fake.requests, [], '**私鑰被送出去了**')
    assert.match(modelSkipOf(s.db, s.idOf('筆記.txt')).why, /看起來像機密/)
  })

  test('一整批混著：只有乾淨的那幾個出得去，而且送出去的內容裡沒有任何一段秘密', async t => {
    const secrets = {
      'ssh-備份.pem': 'PRIVATEKEYBODY-' + 'a'.repeat(200),
      'prod.env': 'CONTEXTBOX_MODEL_KEY=sk-aaaaaaaaaaaaaaaaaaaaaaaa\n' + 'x'.repeat(100),
      'aws-筆記.txt': '出貨流程備忘：AKIAIOSFODNN7EXAMPLE 這一把要換掉，' + '記得通知後端。'.repeat(8),
      '公司信用卡.txt': '公司卡 4111 1111 1111 1111，' + '報帳前先登記。'.repeat(8),
      'server.pem': 'x'.repeat(300),
    }
    const s = sandbox(t, { ...secrets, '作業系統_第6章.txt': OS_CH6 })
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    const r = await round(s, cfg([s.downloads], fake.baseUrl))
    assert.equal(r.asked, 1, '只有那份講義該被問')
    assert.equal(fake.requests.length, 1)
    const wire = fake.requests.map(q => q.raw).join('\n')
    for (const needle of ['PRIVATEKEYBODY', 'sk-aaaaaaaaaaaaaaaaaaaaaaaa', 'AKIAIOSFODNN7EXAMPLE', '4111 1111 1111 1111']) {
      assert.ok(!wire.includes(needle), `**${needle} 被送出去了**`)
    }
    for (const name of Object.keys(secrets)) {
      const id = s.idOf(name)
      assert.ok(id, `前提：掃描有收到 ${name}`)
      assert.match(modelSkipOf(s.db, id)?.why ?? '', /看起來像機密/, `${name} 沒有記下為什麼沒送`)
    }
  })

  test('像機密的檔不會有看法（面板上也不會出現）', async t => {
    const s = sandbox(t, { 'server.key': 'x'.repeat(300) })
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    await round(s, cfg([s.downloads], fake.baseUrl))
    assert.equal(modelViewForItem(s.db, s.idOf('server.key')), null)
  })
})

// ═══ 5 ・ 真的問到答案 ════════════════════════════════════════

describe('第 5 條 ・ 未命名文件 (3).txt：course 含「作業系統」、建議的名字是繁體中文', () => {
  test('問一次就有看法，存進 model_views，面板看得到', async t => {
    const s = sandbox(t, { '未命名文件 (3).txt': OS_CH6 })
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    const r = await round(s, cfg([s.downloads], fake.baseUrl))
    assert.equal(r.asked, 1, JSON.stringify(r.steps))
    const row = modelViewForItem(s.db, s.idOf('未命名文件 (3).txt'))
    assert.ok(row, '沒有存進 model_views')
    assert.match(row.course, /作業系統/)
    assert.match(row.suggested_name, /[一-鿿]/, 'suggestedName 要是繁體中文')
    assert.ok(row.confidence, 'confidence 不可以是空的')
    assert.equal(row.prompt_version, PROMPT_VERSION)
    assert.equal(row.seeded, 0)
    assert.equal(row.model, 'fake-model')
    // 帳本
    const call = s.db.prepare('SELECT * FROM model_calls').all()
    assert.equal(call.length, 1)
    assert.equal(call[0].ok, 1)
    assert.equal(call[0].source, 'text')
    assert.ok(call[0].chars_sent > 0 && call[0].bytes_sent > 0)
  })

  test('面板的卡片上是「模型認為⋯⋯」，而且沒有自動打勾', async t => {
    // 候選卡片上才有模型的看法，所以這裡用一張**會變成候選**的舊截圖
    // （.txt 在 PROTECTED_EXT 裡，永遠不會是 old-download 候選）
    const name = 'Screenshot 2026-09-18 at 10.31.02.png'
    const s = sandbox(t, { [name]: shot() })
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    await round(s, cfg([s.downloads], fake.baseUrl))
    const list = listCandidates(s.db, { roots: [s.downloads] })
    const card = list.candidates.find(c => c.name === name)
    assert.ok(card, `前提：那個檔在候選清單上（現在有 ${list.candidates.map(c => c.name).join('、')}）`)
    assert.ok(card.model, '卡片上沒有模型的看法')
    assert.equal(card.model.seeded, false)
    const lines = modelOpinionLines(card.model)
    assert.match(lines.head, /^模型認為：作業系統／死結（信心 高）$/)
    assert.match(lines.note, /證據：/)
    assert.match(lines.note, /這是模型的意見，不是事實/)
    // **不可以因為模型說了就自動勾選**（screenshot-noise 信心 35，低於預設門檻）
    assert.equal(card.defaultChecked, false, '模型說了就自動勾起來了')
  })

  test('截圖也問得到（縮到長邊 ≤ 1344 的灰階 PNG 送出去）', async t => {
    const s = sandbox(t, { 'Screenshot 2026-09-18 at 10.31.02.png': shot(2000, 1000) })
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    const r = await round(s, cfg([s.downloads], fake.baseUrl))
    assert.equal(r.asked, 1, JSON.stringify(r.steps))
    assert.equal(r.steps[0].source, 'image')
    const url = fake.requests[0].json.messages[1].content[0].image_url.url
    const png = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64')
    const { decodePngGray } = await import('../core/png.ts')
    const img = decodePngGray(png)
    assert.equal(Math.max(img.width, img.height), 1344)
    assert.equal(s.db.prepare('SELECT source FROM model_calls').get().source, 'image')
  })
})

// ═══ 6、7 ・ 快取 ═════════════════════════════════════════════

describe('第 6、7 條 ・ 同樣的內容只問一次；改過內容重問', () => {
  test('複製兩份：只送一次，兩個檔都看得到同一個看法', async t => {
    const s = sandbox(t, { '講義.txt': OS_CH6, '講義 (1).txt': OS_CH6 })
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    const r = await round(s, cfg([s.downloads], fake.baseUrl))
    assert.equal(fake.requests.length, 1, '一模一樣的內容問了兩次')
    assert.equal(r.asked, 1)
    // 兩個檔在面板上都看得到（第二份靠 sha256 一樣的兄弟找到同一筆）
    for (const name of ['講義.txt', '講義 (1).txt']) {
      assert.ok(modelViewForItem(s.db, s.idOf(name)), `${name} 看不到看法`)
    }
    assert.equal(s.db.prepare('SELECT count(*) n FROM model_views').get().n, 1)
  })

  test('內容不同、但砍到 2000 字之後一樣 → 命中快取（真的走快取那條路）', async t => {
    const head = '作業系統 第 6 章 死結。' + '這一段在砍掉之前就已經填滿前兩千個字了。'.repeat(120)
    assert.ok([...head].length > 2000, '前提：超過 2000 字')
    const s = sandbox(t, { 'a.txt': head + '尾巴一', 'b.txt': head + '尾巴二' })
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    const r = await round(s, cfg([s.downloads], fake.baseUrl))
    assert.equal(fake.requests.length, 1, '砍完一樣的內容問了兩次')
    assert.equal(r.cached, 1, '第二個要走快取')
  })

  test('改過內容：重問', async t => {
    const s = sandbox(t, { '講義.txt': OS_CH6 })
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    const config = cfg([s.downloads], fake.baseUrl)
    await round(s, config)
    assert.equal(fake.requests.length, 1)
    // 再跑一輪：沒改內容就不該再問
    await round(s, config)
    assert.equal(fake.requests.length, 1, '沒改內容卻又問了一次')
    // 改內容 → 重掃 → 重問
    s.put('講義.txt', '資料結構 期中考範圍\n\n堆疊、佇列、樹、圖的走訪與時間複雜度分析。\n', 0)
    s.scan()
    const r = await round(s, config)
    assert.equal(fake.requests.length, 2, '改過內容卻沒有重問')
    assert.equal(r.asked, 1)
    assert.equal(s.db.prepare('SELECT count(*) n FROM model_views').get().n, 2, '舊的那一筆也留著（那是別的內容的答案）')
  })
})

// ═══ 8 ・ 壞格式 ══════════════════════════════════════════════

describe('第 8 條 ・ 模型回了不合格式的東西：不採用、記一次失敗、不存壞資料', () => {
  const BAD = [
    ['少一欄', () => { const o = { ...GOOD_VIEW }; delete o.evidence; return completion(o) }],
    ['多一欄', () => completion({ ...GOOD_VIEW, extra: '多的' })],
    ['不是 JSON', () => ({ choices: [{ message: { content: '我覺得這是作業系統的講義。' } }] })],
    ['選項不對', () => completion({ ...GOOD_VIEW, confidence: 'high' })],
  ]
  for (const [label, body] of BAD) {
    test(label, async t => {
      const s = sandbox(t, { '講義.txt': OS_CH6 })
      const fake = await startFakeModel(t, ({ send, req }) =>
        req.method === 'POST' ? (send(200, body()), true) : false)
      withKey(t, FAKE_KEY)
      const r = await round(s, cfg([s.downloads], fake.baseUrl))
      assert.equal(r.asked, 0)
      assert.equal(r.failed, 1)
      assert.equal(s.db.prepare('SELECT count(*) n FROM model_views').get().n, 0, '壞資料被存進去了')
      const call = s.db.prepare('SELECT ok, error FROM model_calls').get()
      assert.equal(call.ok, 0, '沒有記一次失敗')
      assert.ok(call.error, '失敗要講得出原因')
    })
  }

  test('同一個檔失敗三次之後標成「問不到」，不再排進來', async t => {
    const s = sandbox(t, { '講義.txt': OS_CH6 })
    const fake = await startFakeModel(t, ({ send, req }) =>
      req.method === 'POST' ? (send(200, completion({ ...GOOD_VIEW, extra: 1 })), true) : false)
    withKey(t, FAKE_KEY)
    const config = cfg([s.downloads], fake.baseUrl)
    for (let i = 0; i < 3; i++) await round(s, config)
    assert.equal(fake.requests.length, 3, `問了 ${fake.requests.length} 次`)
    const r = await round(s, config)
    assert.equal(fake.requests.length, 3, '第四輪不該再問')
    assert.equal(r.skipped, 1)
    assert.match(modelSkipOf(s.db, s.idOf('講義.txt')).why, /問不到|沒有給出可用/)
  })
})

// ═══ 9 ・ 併發 1、中途停 ══════════════════════════════════════

describe('第 9 條 ・ 一次排 20 個：併發 1、可以中途停而不留半筆', () => {
  const twenty = () => {
    const files = {}
    for (let i = 0; i < 20; i++) files[`講義${i}.txt`] = OS_CH6 + `（第 ${i} 份，內容不一樣）`
    return files
  }

  test('同一瞬間最多只有一個請求在飛', async t => {
    const s = sandbox(t, twenty())
    let inFlight = 0, peak = 0
    const fake = await startFakeModel(t, ({ send, req }) => {
      if (req.method !== 'POST') return false
      inFlight++
      peak = Math.max(peak, inFlight)
      setTimeout(() => { inFlight--; send(200, completion(GOOD_VIEW)) }, 5)
      return true
    })
    withKey(t, FAKE_KEY)
    const r = await round(s, cfg([s.downloads], fake.baseUrl))
    assert.equal(r.total, 20)
    assert.equal(peak, 1, `同時有 ${peak} 個請求在飛`)
  })

  test('中途停：停在哪裡就是哪裡，沒有半筆資料', async t => {
    const s = sandbox(t, twenty())
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    const ac = new AbortController()
    let done = 0
    const r = await round(s, cfg([s.downloads], fake.baseUrl), {
      signal: ac.signal,
      onProgress: () => { if (++done === 3) ac.abort() },
    })
    assert.equal(r.cancelled, true)
    assert.equal(r.asked, 3, `停之前做完 ${r.asked} 個`)
    assert.equal(fake.requests.length, 3, '停了卻還在送')
    const views = s.db.prepare('SELECT * FROM model_views').all()
    assert.equal(views.length, 3)
    for (const v of views) {
      // 每一列都是完整的一筆：六個欄位都有、來源與版本都有
      for (const k of ['course', 'topic', 'kind', 'suggested_name', 'evidence', 'confidence', 'model', 'prompt_version', 'at']) {
        assert.ok(v[k], `半筆資料：${k} 是空的`)
      }
    }
    assert.equal(s.db.prepare('SELECT count(*) n FROM model_calls').get().n, 3, '取消不可以記成一次失敗')
    assert.equal(s.db.prepare('SELECT count(*) n FROM model_calls WHERE ok=0').get().n, 0)
  })

  test('停了就真的停：剩下的檔連「為什麼沒送」都不再寫', async t => {
    // 四個檔的內容都像機密 —— 每一個都會走到「記一句跳過」那條路。
    // 迴圈頂端不看取消的話，使用者按了停，它還會把剩下三個都記一輪。
    const files = {}
    for (let i = 0; i < 4; i++) files[`備忘${i}.txt`] = `出貨備忘 ${i}：AKIAIOSFODNN7EXAMPLE 這一把要換掉，` + '記得通知後端。'.repeat(8)
    const s = sandbox(t, files)
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    const ac = new AbortController()
    const r = await round(s, cfg([s.downloads], fake.baseUrl), {
      signal: ac.signal,
      onProgress: () => ac.abort(),
    })
    assert.equal(r.cancelled, true)
    assert.equal(r.steps.length, 1, `停了之後還做了 ${r.steps.length} 個`)
    assert.equal(r.skipped, 1)
    assert.equal(s.db.prepare('SELECT count(*) n FROM model_skips').get().n, 1)
    assert.deepEqual(fake.requests, [])
  })

  test('一開始就已經取消（pet 正在收尾）：一個檔都不碰、一列都不寫', async t => {
    const s = sandbox(t, { '太短.txt': '死結', '講義.txt': OS_CH6, 'server.key': 'x'.repeat(300) })
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    const r = await round(s, cfg([s.downloads], fake.baseUrl), { signal: AbortSignal.abort() })
    assert.equal(r.cancelled, true)
    assert.deepEqual([r.total, r.asked, r.cached, r.skipped, r.failed], [0, 0, 0, 0, 0])
    assert.deepEqual(fake.requests, [])
    assert.equal(s.db.prepare('SELECT count(*) n FROM model_skips').get().n, 0, '取消了還寫了跳過')
    assert.equal(s.db.prepare('SELECT count(*) n FROM model_calls').get().n, 0)
  })

  test('一輪最多 20 個（再多的等下一輪）', async t => {
    const files = twenty()
    for (let i = 20; i < 26; i++) files[`講義${i}.txt`] = OS_CH6 + `（第 ${i} 份）`
    const s = sandbox(t, files)
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    assert.equal(pendingItems(s.db, [s.downloads], 100).length, 26)
    const r = await round(s, cfg([s.downloads], fake.baseUrl))
    assert.equal(r.total, 20)
    assert.equal(fake.requests.length, 20)
  })
})

// ═══ 10 ・ 示範答案 ═══════════════════════════════════════════

describe('第 10 條 ・ --seed-model 塞的答案標「示範答案」，不會被蓋掉', () => {
  /** 照 tools/demo-setup.mjs 的做法塞一筆（文件）。 */
  function seed(s, name, view) {
    const id = s.idOf(name)
    const text = s.db.prepare('SELECT text FROM file_texts WHERE item_id=?').get(id).text
    return seedKey(s, id, viewKey(textPayload(text)), 'text', view)
  }

  /** 截圖版：快取鍵算的是「真的會送出去的那張縮圖」。 */
  function seedShot(s, name, view) {
    const id = s.idOf(name)
    const png = imagePayload(readFileSync(join(s.downloads, name))).bytes
    return seedKey(s, id, viewKey(png), 'image', view)
  }

  function seedKey(s, id, key, source, view) {
    putModelView(s.db, {
      key, item_id: id, source,
      course: view.course, topic: view.topic, kind: view.kind,
      suggested_name: view.suggestedName, evidence: view.evidence, confidence: view.confidence,
      model: '示範答案（demo-setup 預先塞的）', prompt_version: PROMPT_VERSION,
      at: new Date().toISOString(), seeded: 1,
    })
    return id
  }

  test('畫面上標「示範答案」', t => {
    // 候選卡片上才看得到，所以用一張會變成候選的舊截圖
    const name = 'Screenshot 2026-09-18 at 10.31.02.png'
    const s = sandbox(t, { [name]: shot() })
    seedShot(s, name, { ...GOOD_VIEW })
    const card = listCandidates(s.db, { roots: [s.downloads] }).candidates.find(c => c.name === name)
    assert.ok(card?.model?.seeded, '沒有標成示範答案')
    assert.match(modelOpinionLines(card.model).head, /^［示範答案］模型認為：/)
    assert.equal(card.defaultChecked, false, '示範答案不可以讓它自動打勾')
  })

  test('真的接上模型跑一輪也**不會**把示範答案蓋掉（連問都不問）', async t => {
    const s = sandbox(t, { '未命名文件 (3).txt': OS_CH6 })
    const id = seed(s, '未命名文件 (3).txt', { ...GOOD_VIEW, topic: '示範的主題' })
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    const r = await round(s, cfg([s.downloads], fake.baseUrl))
    assert.deepEqual(fake.requests, [], '已經有答案了還去問')
    assert.equal(r.total, 0)
    const row = modelViewForItem(s.db, id)
    assert.equal(row.topic, '示範的主題')
    assert.equal(row.seeded, 1)
  })

  test('改了內容（＝換了快取鍵）才會真的問一次', async t => {
    const s = sandbox(t, { '未命名文件 (3).txt': OS_CH6 })
    seed(s, '未命名文件 (3).txt', { ...GOOD_VIEW, topic: '示範的主題' })
    s.put('未命名文件 (3).txt', '資料結構 期中考範圍\n\n堆疊、佇列、樹、圖的走訪與時間複雜度。\n', 0)
    s.scan()
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    await round(s, cfg([s.downloads], fake.baseUrl))
    assert.equal(fake.requests.length, 1)
    const row = modelViewForItem(s.db, s.idOf('未命名文件 (3).txt'))
    assert.equal(row.seeded, 0, '真的問過一次之後才換成真的答案')
    assert.equal(row.topic, GOOD_VIEW.topic)
  })

  test('opinionOf 把 seeded 翻成布林（面板只看這個）', t => {
    const s = sandbox(t, { '未命名文件 (3).txt': OS_CH6 })
    const id = seed(s, '未命名文件 (3).txt', { ...GOOD_VIEW })
    assert.equal(opinionOf(modelViewForItem(s.db, id)).seeded, true)
  })

  test('tools/demo-setup.mjs --seed-model 真的塞得進去（demo 那三個檔）', t => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-demoseed-')))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const home = join(dir, 'fake-home')
    mkdirSync(home)
    const r = spawnSync(process.execPath, [join(REPO, 'tools', 'demo-setup.mjs'), '--dir', join(dir, 'box'), '--seed-model'],
      { encoding: 'utf8', timeout: 120_000, env: { ...process.env, HOME: home, USERPROFILE: home } })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /已經預先塞了 3 筆/)
    const db = openDb(join(dir, 'box', 'data.db'))
    t.after(() => db.close())
    const rows = db.prepare('SELECT course, topic, seeded FROM model_views ORDER BY course, topic').all()
    assert.deepEqual(rows.map(x => [x.course, x.topic, x.seeded]), [
      ['作業系統', '死結', 1],
      ['作業系統', '行程排程', 1],
      ['資料結構', '期中考範圍', 1],
    ])
  })
})

// ═══ 11 ・ 不外洩 ═════════════════════════════════════════════

describe('第 11 條 ・ 回給畫面的沒有絕對路徑；送出去的內容不會進 log 或 problems', () => {
  test('候選清單與連拍組裡沒有沙盒的絕對路徑', async t => {
    const s = sandbox(t, { '未命名文件 (3).txt': OS_CH6, 'a.zip': 'x'.repeat(200), 'b.zip': 'x'.repeat(200) })
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    await round(s, cfg([s.downloads], fake.baseUrl))
    const wire = JSON.stringify(listCandidates(s.db, { roots: [s.downloads] }))
      + JSON.stringify(burstGroupsView(s.db, [s.downloads]))
    assert.ok(!wire.includes(s.dir), '回給畫面的東西裡有絕對路徑')
    assert.ok(!wire.includes(tmpdir()), '回給畫面的東西裡有絕對路徑')
  })

  test('模型引用了一段絕對路徑，也不會原樣回到畫面上', async t => {
    const s = sandbox(t, { '講義.txt': OS_CH6 })
    const fake = await startFakeModel(t, ({ send, req }) => req.method === 'POST'
      ? (send(200, completion({ ...GOOD_VIEW, evidence: `看到路徑 ${join(s.downloads, '講義.txt')} 在第一行` })), true)
      : false)
    withKey(t, FAKE_KEY)
    await round(s, cfg([s.downloads], fake.baseUrl))
    const row = modelViewForItem(s.db, s.idOf('講義.txt'))
    assert.ok(!row.evidence.includes(s.downloads), `絕對路徑進了畫面：${row.evidence}`)
    assert.match(row.evidence, /⋯/)
  })

  test('送出去的內容不會出現在 log 裡（連失敗那一輪也不會）', async t => {
    const secretish = '這一行是使用者檔案裡獨一無二的字串 ZXQWVU-42'
    const s = sandbox(t, { '講義.txt': OS_CH6 + secretish })
    withKey(t, FAKE_KEY)
    const url = await deadUrl(t)
    const lines = captureConsole(t)
    await round(s, cfg([s.downloads], url))
    const all = lines.join('\n')
    assert.ok(!all.includes(secretish), `檔案內容被印出來了：${all}`)
    assert.ok(!all.includes(FAKE_KEY), '金鑰被印出來了')
  })

  test('model_calls 只記「送了多少」，不記內容', async t => {
    const secretish = 'ZXQWVU-42-獨一無二'
    const s = sandbox(t, { '講義.txt': OS_CH6 + secretish })
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    await round(s, cfg([s.downloads], fake.baseUrl))
    const row = s.db.prepare('SELECT * FROM model_calls').get()
    assert.ok(!JSON.stringify(row).includes(secretish), '帳本裡有檔案內容')
    assert.ok(!JSON.stringify(row).includes(s.dir), '帳本裡有絕對路徑')
  })
})

// ═══ 12 ・ doctor ════════════════════════════════════════════

describe('第 12 條 ・ doctor 講得出這幾件事', () => {
  test('有設定、今天送了幾次、平均幾秒、幾次失敗、幾個檔因為像機密沒送', async t => {
    const s = sandbox(t, {
      '未命名文件 (3).txt': OS_CH6,
      'server.key': 'x'.repeat(300),
      'prod.env': 'CONTEXTBOX_MODEL_KEY=sk-bbbbbbbbbbbbbbbbbbbbbbbb\n' + 'y'.repeat(120),
    })
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    await round(s, cfg([s.downloads], fake.baseUrl))
    const st = modelStats(s.db, new Date(Date.now() - DAY).toISOString())
    assert.equal(st.calls, 1)
    assert.equal(st.ok, 1)
    assert.equal(st.failed, 0)
    assert.equal(st.secretSkips, 2)
    assert.ok(st.avgMs !== null && st.avgMs >= 0)

    const r = await runCli(s, ['doctor'], { [KEY_ENV]: FAKE_KEY },
      { baseUrl: fake.baseUrl, name: 'fake-model', keyEnv: KEY_ENV })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /看懂內容\s+✓ 開著/)
    assert.match(r.stdout, /今天送了 1 次/)
    assert.match(r.stdout, /1 次有答案（平均 \d+\.\d 秒）/)
    assert.match(r.stdout, /沒有失敗/)
    assert.match(r.stdout, /2 個檔因為看起來像機密沒送/)
    assert.ok(!r.stdout.includes(FAKE_KEY), 'doctor 把金鑰印出來了')
  })

  test('沒接模型、但快取裡有示範答案：doctor 要講一聲（不然面板寫「模型認為」看起來像壞掉）', async t => {
    const s = sandbox(t, { '未命名文件 (3).txt': OS_CH6 })
    putModelView(s.db, {
      key: viewKey(textPayload(OS_CH6)), item_id: s.idOf('未命名文件 (3).txt'), source: 'text',
      course: '作業系統', topic: '死結', kind: '講義', suggested_name: '作業系統_死結',
      evidence: '看到「死結」', confidence: '高', model: '示範答案', prompt_version: PROMPT_VERSION,
      at: new Date().toISOString(), seeded: 1,
    })
    const r = await runCli(s, ['doctor'], { [KEY_ENV]: '' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /看懂內容\s+✗ 沒設定模型/)
    assert.match(r.stdout, /1 筆 demo 的示範答案/)
  })

  test('失敗過就講得出幾次失敗', async t => {
    const s = sandbox(t, { 'os1.txt': OS_CH6, 'os2.txt': OS_CH6 + '一', 'os3.txt': OS_CH6 + '二' })
    withKey(t, FAKE_KEY)
    const url = await deadUrl(t)
    await round(s, cfg([s.downloads], url))
    const r = await runCli(s, ['doctor'], { [KEY_ENV]: FAKE_KEY }, { baseUrl: url, name: 'fake-model', keyEnv: KEY_ENV })
    assert.match(r.stdout, /今天送了 3 次/)
    assert.match(r.stdout, /3 次失敗/)
    assert.match(r.stdout, /最近出錯/)
  })
})

// ═══ CLI 的 think ════════════════════════════════════════════

describe('CLI 的 think', () => {
  test('印得出進度與結果摘要，而且不印檔案內容', async t => {
    const s = sandbox(t, { '未命名文件 (3).txt': OS_CH6 + '獨一無二的 ZXQWVU-42', 'server.key': 'x'.repeat(300) })
    const fake = await startFakeModel(t)
    const r = await runCli(s, ['think'], { [KEY_ENV]: FAKE_KEY },
      { baseUrl: fake.baseUrl, name: 'fake-model', keyEnv: KEY_ENV })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /模型認為：作業系統／死結（信心 高）/)
    assert.match(r.stdout, /server\.key.*看起來像機密/)
    assert.match(r.stdout, /排了 2 個，問到 1 個/)
    assert.match(r.stdout, /不會因為它說了就自動改名或搬檔|不是事實/)
    assert.ok(!r.stdout.includes('ZXQWVU-42'), 'CLI 把檔案內容印出來了')
    assert.ok(!r.stdout.includes(FAKE_KEY), 'CLI 把金鑰印出來了')
  })

  test('--limit 看不懂就回 1（輸入錯）', async t => {
    const s = sandbox(t, { '講義.txt': OS_CH6 })
    const r = await runCli(s, ['think', '--limit', '0'], { [KEY_ENV]: FAKE_KEY },
      { baseUrl: 'http://127.0.0.1:9/v1', name: 'fake-model', keyEnv: KEY_ENV })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /--limit/)
  })

  test('叫不動：離開碼 2（後端錯），而且掃描照樣做得動', async t => {
    const s = sandbox(t, { 'os1.txt': OS_CH6, 'os2.txt': OS_CH6 + '一', 'os3.txt': OS_CH6 + '二' })
    const url = await deadUrl(t)
    const r = await runCli(s, ['think'], { [KEY_ENV]: FAKE_KEY }, { baseUrl: url, name: 'fake-model', keyEnv: KEY_ENV })
    assert.equal(r.status, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /連續 3 次/)
    assert.equal((await runCli(s, ['cleanup', 'scan'], {}, null)).status, 0)
  })
})

// ═══ 只搬不刪、形狀 ═══════════════════════════════════════════

describe('payloadFor 自己的把關（直接呼叫，不經過 pendingItems）', () => {
  // pendingItems 已經擋掉太短的與像機密的，但 payloadFor 是**匯出的函式**：
  // 之後 P3／P4 也會拿它去組要送的東西。它自己就要守得住，不可以靠呼叫端先篩過。
  test('說是文件、實際上太短（或根本沒有文字）→ 不送，記一句「太短」', t => {
    const s = sandbox(t, { '太短.txt': '死結', 'lab.zip': 'x'.repeat(500) })
    for (const name of ['太短.txt', 'lab.zip']) {
      const p = payloadFor(s.db, { id: s.idOf(name), name, source: 'text' }, FAKE_KEY)
      assert.equal(p.ok, false, `${name} 竟然組得出要送的東西`)
      assert.equal(p.remember, true)
      assert.match(p.why, /太短/)
    }
  })

  test('說是文件、名字像機密 → 不送，記一句「看起來像機密」', t => {
    const s = sandbox(t, { '我的password備份.txt': OS_CH6 })
    const name = '我的password備份.txt'
    const p = payloadFor(s.db, { id: s.idOf(name), name, source: 'text' }, FAKE_KEY)
    assert.equal(p.ok, false)
    assert.equal(p.why, SECRET_WHY)
  })

  test('內容裡有這台機器的模型金鑰 → 不送', t => {
    const s = sandbox(t, { '筆記.txt': OS_CH6 + '我的金鑰是 ' + FAKE_KEY })
    const p = payloadFor(s.db, { id: s.idOf('筆記.txt'), name: '筆記.txt', source: 'text' }, FAKE_KEY)
    assert.equal(p.ok, false)
    assert.equal(p.why, SECRET_WHY)
  })

  test('這個檔已經不在資料庫裡 → 不送，而且**不記**（那不是「像機密」）', t => {
    const s = sandbox(t, { '講義.txt': OS_CH6 })
    const p = payloadFor(s.db, { id: 'no-such-id', name: '講義.txt', source: 'text' }, FAKE_KEY)
    assert.equal(p.ok, false)
    assert.equal(p.remember, false)
  })
})

describe('這一期不做的事', () => {
  test('模型說了也**不會**改名、不會搬檔（檔案原封不動）', async t => {
    const s = sandbox(t, { '未命名文件 (3).txt': OS_CH6 })
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    const before = readFileSync(join(s.downloads, '未命名文件 (3).txt'), 'utf8')
    await round(s, cfg([s.downloads], fake.baseUrl))
    assert.equal(readFileSync(join(s.downloads, '未命名文件 (3).txt'), 'utf8'), before)
    const row = s.db.prepare('SELECT name, status FROM file_items WHERE name=?').get('未命名文件 (3).txt')
    assert.equal(row.name, '未命名文件 (3).txt', '檔名被改了')
    assert.ok(['new', 'candidate', 'kept'].includes(row.status))
  })

  test('只問兩種檔：有文字的文件、有指紋的 PNG。其他不問', async t => {
    const s = sandbox(t, {
      '作業系統_第6章.txt': OS_CH6,                      // 問
      'shot.png': shot(),                                // 問
      '太短.txt': '死結',                                 // 太短，不問
      'lab.zip': 'x'.repeat(500),                        // 不是文件也不是截圖，不問
      '安裝檔.exe': 'x'.repeat(500),                     // 不問
    })
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    const pend = pendingItems(s.db, [s.downloads], 50).map(p => p.name).sort()
    assert.deepEqual(pend, ['shot.png', '作業系統_第6章.txt'])
    const r = await round(s, cfg([s.downloads], fake.baseUrl))
    assert.equal(r.asked, 2)
    assert.equal(fake.requests.length, 2)
  })

  test('清理範圍外的檔不問', async t => {
    const s = sandbox(t, { '作業系統_第6章.txt': OS_CH6 })
    const other = join(s.dir, 'Other')
    mkdirSync(other)
    // 掃描器不會收範圍外的檔，這裡直接確認 pendingItems 也照範圍過濾
    assert.equal(pendingItems(s.db, [other], 50).length, 0)
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    const r = await round(s, cfg([other], fake.baseUrl))
    assert.equal(r.total, 0)
    assert.deepEqual(fake.requests, [])
  })
})
