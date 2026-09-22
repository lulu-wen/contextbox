import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
import { rmTmp } from './helpers/rm.mjs'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
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
// 暫存資料夾也要收（稽核 RC22：以前每跑一次就在暫存資料夾留一個 cb-*）
after(() => { globalThis.__cbStopPage?.(); S.server.closeAllConnections(); S.server.close(); S.server.unref(); rmTmp(dir) })

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
  const r = await call('/assets/quaso_v10.glb', { token: null, origin: null })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'model/gltf-binary')
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 4).toString(), 'glTF')
  const head = await call('/assets/quaso_v10.glb', { method: 'HEAD', token: null, origin: null })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  
  // （grep 全 repo 只有這一行寫過它）。之後真的加了這個檔，連同 PET_ASSETS 一起加回來。
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
  assert.equal((await call('/assets/quaso_v10.glb', { origin: 'https://evil.example.com' })).status, 403)
  assert.equal((await call('/assets/quaso_v10.glb', { method: 'POST' })).status, 405)
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
  assert.match((await r.json()).error, /cannot read the fact store directly/)
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
  assert.match((await r.json()).error, /not one of the allowed values/)
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

/**
 * 從**原始碼的路由表**列出每一條 (method, 路徑)。不手寫清單。
 *
 * 2026-09-19 稽核 RC21：上一版手寫十條，漏了 GET /cleanup/plans（計畫列表），
 * 後來加的 POST …/release 也不在上面 —— 那兩條不驗 token 的話測試照樣綠。
 * 真實來源是 core/cleanup-routes.ts 的 KNOWN 與 core/server.ts 的 OWN_ROUTES。
 * 表的寫法變了、這裡看不懂的時候**要紅**，不可以安靜地少驗幾條。
 */
function routeTable() {
  const src = (f) => readFileSync(new URL(`../core/${f}`, import.meta.url), 'utf8')
  const tableOf = (text, name) => {
    const start = text.indexOf(`const ${name}`)
    assert.ok(start >= 0, `找不到路由表 ${name}`)
    const body = text.slice(start, text.indexOf('\n]\n', start))
    return [...body.matchAll(/\[\s*\/(.+?)\/\s*,\s*\[([^\]]*)\]\s*\]/g)].map(m => ({
      re: new RegExp(m[1]),
      methods: [...m[2].matchAll(/['"](\w+)['"]/g)].map(x => x[1]),
    }))
  }
  // 從正規式造出實際的路徑：[^/]+ 與 [\w-]+ 換成 abc，(?:a|b) 展開成每一個
  const examples = (re) => {
    let paths = [re.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/')
      .replace(/\[\^\/\]\+/g, 'abc').replace(/\[\\w-\]\+/g, 'abc')]
    for (;;) {
      const next = paths.flatMap(p => {
        const m = /\(\?:([^()]*)\)/.exec(p)
        return m ? m[1].split('|').map(alt => p.slice(0, m.index) + alt + p.slice(m.index + m[0].length)) : [p]
      })
      if (next.length === paths.length && next.every((p, i) => p === paths[i])) break
      paths = next
    }
    for (const p of paths) assert.ok(re.test(p), `路由表的寫法看不懂（${re.source} 造出 ${p}），更新 routeTable()`)
    return paths
  }
  const rows = [...tableOf(src('cleanup-routes.ts'), 'KNOWN'), ...tableOf(src('server.ts'), 'OWN_ROUTES')]
  return rows.flatMap(r => examples(r.re).flatMap(path => r.methods.map(method => [method, path])))
}
test('**會動檔案的 route 一律要 token**', async () => {
  // /health 是唯一免 token 的。清理那條線會搬檔、會刪檔，
  // 漏一條就等於任何網頁都能叫這台機器動使用者的檔案。
  const routes = routeTable()
  const has = (m, p) => routes.some(([mm, pp]) => mm === m && pp === p)
  // 前提：列舉真的有抓到東西，而且抓到上一版漏掉的那兩條
  assert.ok(routes.length >= 15, `只列出 ${routes.length} 條，路由表的解析壞了`)
  assert.ok(has('GET', '/cleanup/plans'), '列舉裡沒有 GET /cleanup/plans')
  assert.ok(has('POST', '/cleanup/plans/abc/release'), '列舉裡沒有 POST /cleanup/plans/:id/release')
  assert.ok(has('POST', '/cleanup/quarantine/empty'), '列舉裡沒有 POST /cleanup/quarantine/empty')
  for (const [method, path] of routes) {
    const r = await call(path, { token: null, method, body: method === 'POST' ? '{}' : undefined })
    assert.equal(r.status, 401, `${method} ${path} 沒帶 token 卻回了 ${r.status}`)
    await r.arrayBuffer()
  }
})

/** 回應裡每一個字串（含 key）。**先 JSON.parse 再比** —— JSON 文字裡的反斜線是跳脫過的，Windows 路徑用正規式在原文上比不到。 */
function strings(v, out = []) {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) v.forEach(x => strings(x, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); strings(x, out) }
  return out
}

test('免 token 的 /health 不可以有檔名或路徑', async () => {
  // 2026-09-19 稽核 RC21：上一版的正規式只找 /home/、/Users/ —— 而這支測試的暫存目錄在 /tmp，
  // 把隔離區或 Downloads 的完整路徑塞進回應，測試照樣綠。
  // 現在直接比**這支測試自己的**暫存目錄、Downloads、隔離區、假家目錄，任何一個出現都算洩漏。
  // 放一個檔、掃一次，讓 server 手上真的有檔名與路徑可以洩漏
  writeFileSync(join(dir, 'Downloads', '洩漏測試-秘密檔名.zip'), 'x')
  assert.equal((await call('/cleanup/scan', { method: 'POST', body: '{}' })).status, 200)

  const r = await call('/health', { token: null })
  const body = await r.json()
  const secrets = [...new Set([
    dir, realpathSync(dir), join(dir, 'Downloads'), join(dir, 'q'), FAKE_HOME, tmpdir(), realpathSync(tmpdir()),
    basename(dir), '洩漏測試-秘密檔名',
  ])]
  for (const s of strings(body)) {
    for (const x of secrets) assert.ok(!s.includes(x), `/health 洩漏了「${x}」：${s}`)
    assert.ok(!/\/home\/|\/Users\/|[A-Za-z]:\\/.test(s), `/health 洩漏了路徑：${s}`)
  }
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

// ── 重新整理不要 401（2026-09-20）──────────────────────────────
//
// 頁面載入之後會把網址上的 ?k= 拿掉（鑰匙不該留在網址列與截圖裡），
// 所以按一下重新整理就變成「這個網址沒有鑰匙」。帶鑰匙進來的那一次發一個 session cookie，
// 之後這個瀏覽器重新整理就進得來 —— 但那個 cookie **只開得了頁面，開不了 API**。

/** 一次 GET，cookie 自己帶。 */
const page = (path, { cookie = '', dest = 'document' } = {}) =>
  fetch(base + path, { headers: { ...(cookie ? { cookie } : {}), 'sec-fetch-dest': dest }, redirect: 'manual' })

test('帶鑰匙進來 → 發 cookie；之後不帶鑰匙也開得了（那就是重新整理）', async () => {
  const first = await page(`/?k=${encodeURIComponent(TOKEN)}`)
  assert.equal(first.status, 200)
  const setCookie = first.headers.get('set-cookie') ?? ''
  assert.match(setCookie, /cb_session=/)
  assert.match(setCookie, /HttpOnly/i, '頁面自己的 JS 不可以讀得到它')
  assert.match(setCookie, /SameSite=Strict/i, '別的網站連過來不可以帶上它')

  const id = /cb_session=([^;]+)/.exec(setCookie)[1]
  const again = await page('/', { cookie: `cb_session=${id}` })
  assert.equal(again.status, 200, '重新整理要進得來')
  assert.match(await again.text(), /<html/i)
})

test('沒有 cookie、也沒有鑰匙 → 照舊 401', async () => {
  assert.equal((await page('/')).status, 401)
  assert.equal((await page('/', { cookie: 'cb_session=made-up' })).status, 401)
})

test('**cookie 只開得了頁面，開不了 API**', async () => {
  const first = await page(`/?k=${encodeURIComponent(TOKEN)}`)
  const id = /cb_session=([^;]+)/.exec(first.headers.get('set-cookie'))[1]
  // 會動檔案的那幾條照樣要 header 裡的 token —— 不然這個 cookie 就變成 CSRF 的入口
  const r = await fetch(base + '/cleanup/candidates', { headers: { cookie: `cb_session=${id}` } })
  assert.equal(r.status, 401)
})

test('cookie 不是拿來 iframe 的：sec-fetch-dest 不是 document 一律擋', async () => {
  const first = await page(`/?k=${encodeURIComponent(TOKEN)}`)
  const id = /cb_session=([^;]+)/.exec(first.headers.get('set-cookie'))[1]
  assert.equal((await page('/', { cookie: `cb_session=${id}`, dest: 'iframe' })).status, 403)
})
