import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../core/server.ts'

const dir = mkdtempSync(join(tmpdir(), 'cb-'))
const TOKEN = 'test-token-abc'
let S, base

before(async () => {
  // roots／quarantine／maxBytes／readonly 全部給 —— 不給的話 /health 會去讀
  // （乾淨的機器上是建立）使用者真的 ~/.contextbox/config.json。
  mkdirSync(join(dir, 'Downloads'))
  S = start({ port: 0, db: join(dir, 'test.db'), token: TOKEN,
    roots: [join(dir, 'Downloads')], quarantine: join(dir, 'q'), maxBytes: 1e7, readonly: false })
  base = `http://127.0.0.1:${await S.ready}`
})
after(() => S.server.close())

const call = (path, { token = TOKEN, origin = 'chrome-extension://abc', ...init } = {}) =>
  fetch(base + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-contextbox-token': token } : {}),
      ...(origin ? { origin } : {}),
    },
  })

test('健康檢查不用 token', async () => {
  const r = await call('/health', { token: null })
  assert.equal(r.status, 200)
})

test('模擬操作歷史需 token，支援儲存、讀取與選取復原', async () => {
  assert.equal((await call('/demo/cleanup/history', { token: null })).status, 401)
  assert.equal((await call('/demo/cleanup/undo', { method: 'POST', token: null })).status, 401)
  assert.equal((await call('/demo/cleanup/history', { origin: 'https://evil.example.com' })).status, 403)
  const r = await call('/demo/cleanup/history', { method: 'POST', body: JSON.stringify({ requestId: 'http-1', candidateIds: ['c_7Qa'] }) })
  assert.equal(r.status, 200)
  const entry = await r.json()
  const history = await (await call('/demo/cleanup/history')).json()
  assert.equal(history.total, 1)
  assert.equal(history.operations[0].id, entry.id)
  const undone = await call('/demo/cleanup/undo', { method: 'POST', body: JSON.stringify({ operationIds: [entry.id] }) })
  assert.equal(undone.status, 200)
  assert.equal((await undone.json()).restored, 1)
  assert.equal((await call('/demo/cleanup/history?limit=0')).status, 400)
})

test('寵物公開素材可載入，模型格式正確，HEAD 不回 body', async () => {
  const r = await call('/assets/quaso_v8.glb', { token: null, origin: null })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'model/gltf-binary')
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 4).toString(), 'glTF')
  const head = await call('/assets/quaso_v8.glb', { method: 'HEAD', token: null, origin: null })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  for (const file of ['pet-viewer.js', 'pet-state.js', 'cleanup-demo.js', 'cleanup-demo-state.js', 'vendor/three.module.js', 'vendor/three.core.js', 'vendor/GLTFLoader.js', 'vendor/BufferGeometryUtils.js']) {
    const script = await call('/assets/' + file, { token: null, origin: null })
    assert.equal(script.status, 200, file)
    assert.match(script.headers.get('content-type'), /javascript/)
    await script.arrayBuffer()
  }
  const fixture = await call('/assets/demo-candidates.json', { token: null, origin: null })
  assert.equal(fixture.status, 200)
  assert.equal((await fixture.json()).candidates.length, 4)
})

test('素材路由只允許清單內檔案，維持來源與個資防線', async () => {
  for (const path of ['/assets/token', '/assets/server.ts', '/assets/%2e%2e%2fserver.ts']) {
    const r = await call(path, { token: null, origin: null })
    assert.equal(r.status, 404)
  }
  assert.equal((await call('/assets/quaso_v8.glb', { origin: 'https://evil.example.com' })).status, 403)
  assert.equal((await call('/assets/quaso_v8.glb', { method: 'POST' })).status, 405)
  assert.equal((await call('/facts', { token: null, origin: null })).status, 401)
})

test('沒帶 token 讀不到資料', async () => {
  const r = await call('/facts', { token: null })
  assert.equal(r.status, 401)
})

test('token 錯的讀不到', async () => {
  const r = await call('/facts', { token: 'wrong' })
  assert.equal(r.status, 401)
})

test('惡意網頁就算猜到 token 也讀不到', async () => {
  const r = await call('/facts', { origin: 'https://evil.example.com' })
  assert.equal(r.status, 403)
  assert.match((await r.json()).error, /網頁不能直接讀/)
})

test('擴充套件帶對 token 才進得來', async () => {
  const r = await call('/facts')
  assert.equal(r.status, 200)
})

test('端到端：手填一筆 → 問表單怎麼填 → 拿到值', async () => {
  await call('/facts', { method: 'POST',
    body: JSON.stringify({ key: 'person.name.full', value: '王小明' }) })
  await call('/facts', { method: 'POST',
    body: JSON.stringify({ key: 'work[0].salary', value: '月薪 6 萬' }) })

  const r = await call('/form/plan', { method: 'POST',
    body: JSON.stringify({ keys: ['person.name.full', 'work[].salary', 'writing.autobiography'] }) })
  const { plan } = await r.json()
  const by = Object.fromEntries(plan.map(p => [p.key, p]))

  assert.equal(by['person.name.full'].action, 'fill')
  assert.equal(by['person.name.full'].value, '王小明')
  assert.equal(by['work[].salary'].action, 'confirm-each-time', '薪資要再點一次')
  assert.equal(by['writing.autobiography'].action, 'compose')
})

test('亂填的值會被擋，而且講得出為什麼', async () => {
  const r = await call('/facts', { method: 'POST',
    body: JSON.stringify({ key: 'person.gender', value: '外星人' }) })
  assert.equal(r.status, 400)
  assert.match((await r.json()).error, /不在允許的值裡/)
})

test('復原會退回上一步', async () => {
  await call('/facts', { method: 'POST',
    body: JSON.stringify({ key: 'contact.email', value: 'a@example.com' }) })
  await call('/facts', { method: 'POST',
    body: JSON.stringify({ key: 'contact.email', value: 'b@example.com' }) })
  await call('/undo', { method: 'POST', body: JSON.stringify({ n: 2 }) })

  const { facts } = await (await call('/facts')).json()
  const email = facts.find(f => f.key === 'contact.email')
  assert.equal(email.value, 'a@example.com')
})

test('**會動檔案的 route 一律要 token**', async () => {
  // /health 是唯一免 token 的。清理那條線會搬檔、會刪檔，
  // 漏一條就等於任何網頁都能叫這台機器動使用者的檔案。
  const destructive = [
    ['POST', '/cleanup/plans'],
    ['GET', '/cleanup/plans/abc'],
    ['POST', '/cleanup/plans/abc/apply'],
    ['POST', '/cleanup/plans/abc/undo'],
    ['POST', '/cleanup/plans/abc/dismiss'],
    ['GET', '/cleanup/quarantine'],
    ['POST', '/cleanup/quarantine/empty'],
    ['POST', '/cleanup/scan'],
    ['GET', '/cleanup/candidates'],
    ['GET', '/pet/state'],
  ]
  for (const [method, path] of destructive) {
    const r = await call(path, { token: null, method, body: method === 'POST' ? '{}' : undefined })
    assert.equal(r.status, 401, `${method} ${path} 沒帶 token 卻回了 ${r.status}`)
  }
})

test('免 token 的 /health 不可以有檔名或路徑', async () => {
  const r = await call('/health', { token: null })
  const body = await r.json()
  const s = JSON.stringify(body)
  assert.ok(!/\/home\/|\/Users\/|C:\\\\/.test(s), `/health 洩漏了路徑：${s}`)
  assert.deepEqual(body.watcher.watching, [], '免 token 不給資料夾顯示名')
})

test('**素材模組 import 的每一個檔都要被端出來**', async () => {
  // 素材路由是白名單。新增一個模組、在別的模組 import 它、卻忘了登記的話，
  // 瀏覽器拿到 404，**整個 import 圖失敗** —— 不只新功能壞，連本來好好的
  // 面板（包括 demo 模式）都一起不執行。單元測試抓不到，只有開瀏覽器才看得到。
  // 2026-09-18 接真的清理時真的發生過。
  const { readdirSync, readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'core', 'assets')
  const html = readFileSync(join(assets, '..', 'ui.html'), 'utf8')
  // 起點：<script src="/assets/…"> 與 inline 裡的動態 import('/assets/…')（3D 寵物是這樣載的）
  const roots = [...html.matchAll(/(?:src="|import\(\s*['"])\/assets\/([^"']+\.js)/g)].map(m => m[1])
  assert.ok(roots.length, '從 ui.html 找不到任何 /assets/*.js，正規式壞了')
  const seen = new Set()
  const queue = [...roots]
  while (queue.length) {
    const file = queue.shift()
    if (seen.has(file)) continue
    seen.add(file)
    const r = await call('/assets/' + file, { token: null, origin: null })
    assert.equal(r.status, 200, `/assets/${file} 回了 ${r.status} —— 它被 import 了卻不在 server.ts 的 PET_ASSETS 裡`)
    const src = await r.text()
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : ''
    for (const m of src.matchAll(/(?:import|export)[^'"]*?from\s*['"](\.\/[^'"]+)['"]/g)) {
      queue.push(dir + m[1].slice(2))
    }
  }
  assert.ok(seen.has('cleanup-real-state.js'), '前提：真的清理模組有被走到')
  assert.ok(seen.has('vendor/three.core.js'), '前提：3D 寵物那條 import 鏈也有被走到')
})

test('**跑完不可以在家目錄留下任何東西**', async () => {
  // 放在最後：前面每一條都跑過了，還是乾淨的才算數
  await call('/health', { token: null })
  assert.ok(!existsSync(join(FAKE_HOME, '.contextbox')),
    '測試在家目錄建了 .contextbox —— 有路徑去讀了使用者的設定檔')
})
