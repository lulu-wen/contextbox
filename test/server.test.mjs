import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../core/server.ts'

const dir = mkdtempSync(join(tmpdir(), 'cb-'))
const TOKEN = 'test-token-abc'
let S, base

before(async () => {
  S = start({ port: 0, db: join(dir, 'test.db'), token: TOKEN })
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
