import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * P3 ・ 改名的三條 route（`GET /rename/suggestions`、`POST /rename/apply`、`POST /rename/undo`）。
 *
 * 期望值抄自 `~/contextbox-預想-20260919-P3改名.md` 的「介面」與「預期行為」12：
 *
 * | 段落 | 可能的錯 | 另一種解讀 | 成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | 要不要 token | 跟 /health 一樣免 token | 三條都要 | 不帶 token／帶 | 401／200 |
 * | 回應裡的路徑 | 帶 path 方便前端 | 只有檔名 | 任何一條 | 一個絕對路徑都沒有 |
 * | 沒帶 items | 當成「全部」 | 看不懂 | `{}`／`{ items: [⋯] }` | 400 BAD_BODY，一個檔都沒動 |
 * | 拼錯的欄位 | 當成沒帶 | 看不懂 | `{ itemIDs: [⋯] }` | 400 BAD_BODY |
 * | 用錯方法 | 404 | 405 | GET /rename/apply | 405，帶 Allow |
 * | /health | 多講了改名的事 | 不變 | 免 token 的 /health | 欄位跟以前一樣 |
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as server from '../core/server.ts'
import { sandbox, OS_DEADLOCK, DS_MIDTERM } from './helpers/rename.mjs'

const TOKEN = 'rename-wire-token'
const HIGH = { course: '作業系統', topic: '死結', suggestedName: '作業系統_死結', evidence: '四個必要條件', confidence: 'high' }

async function serve(t, s, extra = {}) {
  const S = server.start({
    port: 0, db: s.dbPath, token: TOKEN, roots: [s.downloads], quarantine: s.scope.quarantine,
    maxBytes: 20 * 1024 * 1024, readonly: false, ...extra,
  })
  const port = await S.ready
  t.after(() => globalThis.__cbStopPage?.(); S.server.closeAllConnections(); S.server.close(); S.server.unref(); try { S.facts?.db?.close() } catch { /* 已經關了 */ })
  const raw = async (method, path, { body, token = TOKEN } = {}) => {
    const headers = {
      ...(token ? { 'x-contextbox-token': token } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    }
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body })
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not answer with JSON */ }
    return { status: r.status, json, text, headers: r.headers }
  }
  const api = (method, path, body) => raw(method, path, { body: body === undefined ? undefined : JSON.stringify(body) })
  return { port, raw, api }
}

function fixture(t) {
  const s = sandbox(t, { '未命名文件 (3).txt': OS_DEADLOCK, 'IMG_2041.txt': DS_MIDTERM })
  s.seed('未命名文件 (3).txt', HIGH)
  s.seed('IMG_2041.txt', { ...HIGH, course: '資料結構', topic: '期中考範圍', suggestedName: '資料結構_期中考範圍' })
  return s
}

describe('GET /rename/suggestions', () => {
  test('要 token', async t => {
    const s = fixture(t)
    const { raw } = await serve(t, s)
    const r = await raw('GET', '/rename/suggestions', { token: '' })
    assert.equal(r.status, 401)
  })

  test('列得出建議，而且**沒有絕對路徑**', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const r = await api('GET', '/rename/suggestions')
    assert.equal(r.status, 200)
    assert.equal(r.json.items.length, 2)
    const names = r.json.items.map(i => i.name).sort()
    assert.deepEqual(names, ['IMG_2041.txt', '未命名文件 (3).txt'])
    for (const i of r.json.items) {
      assert.ok(i.suggested.endsWith('.txt'))
      assert.equal(typeof i.seeded, 'boolean')
      assert.ok(!('path' in i) && !('dir' in i), '回應不可以帶路徑')
    }
    assert.ok(!r.text.includes(s.downloads), r.text)
    assert.ok(!r.text.includes(FAKE_HOME), r.text)
  })

  test('limit 不合法回 400', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    for (const bad of ['0', '-1', 'abc', '1001', '1.5']) {
      const r = await api('GET', `/rename/suggestions?limit=${bad}`)
      assert.equal(r.status, 400, bad)
      assert.equal(r.json.code, 'BAD_BODY')
    }
    assert.equal((await api('GET', '/rename/suggestions?limit=1')).json.items.length, 1)
  })

  test('用錯方法回 405，帶 Allow', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const r = await api('POST', '/rename/suggestions', {})
    assert.equal(r.status, 405)
    assert.equal(r.json.code, 'BAD_METHOD')
    assert.equal(r.headers.get('allow'), 'GET')
  })
})

describe('POST /rename/apply', () => {
  test('改名，逐項結果**沒有絕對路徑**', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const id = s.idOf('未命名文件 (3).txt')
    const r = await api('POST', '/rename/apply', { items: [{ itemId: id, to: '作業系統_死結' }] })
    assert.equal(r.status, 200)
    assert.equal(r.json.results[0].ok, true, r.text)
    assert.equal(r.json.results[0].to, '作業系統_死結.txt')
    assert.equal(r.json.remaining, 0)
    assert.equal(existsSync(join(s.downloads, '作業系統_死結.txt')), true)
    assert.ok(!r.text.includes(s.downloads), r.text)
  })

  test('**沒帶 items 不是「全部」**，是看不懂；一個檔都不動', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const before = readdirSync(s.downloads).sort()
    for (const body of [{}, { items: null }, { items: [] }, { items: 'all' }]) {
      const r = await api('POST', '/rename/apply', body)
      assert.equal(r.status, 400, JSON.stringify(body))
      assert.equal(r.json.code, 'BAD_BODY')
    }
    assert.deepEqual(readdirSync(s.downloads).sort(), before)
  })

  test('拼錯的欄位是看不懂，不是「沒帶」', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const r = await api('POST', '/rename/apply', { itemIDs: [s.idOf('未命名文件 (3).txt')] })
    assert.equal(r.status, 400)
    assert.equal(r.json.code, 'BAD_BODY')
    assert.match(r.json.error, /itemIDs/)
    assert.equal(existsSync(join(s.downloads, '未命名文件 (3).txt')), true)
  })

  test('唯讀模式回 403，一個檔都不動', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s, { readonly: true })
    const r = await api('POST', '/rename/apply', { items: [{ itemId: s.idOf('未命名文件 (3).txt') }] })
    assert.equal(r.status, 403)
    assert.equal(r.json.code, 'READ_ONLY')
    assert.equal(existsSync(join(s.downloads, '未命名文件 (3).txt')), true)
  })

  test('itemId 看不懂回 400', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    for (const items of [[{ itemId: 42 }], [{ itemId: '' }], [{ itemId: 'x'.repeat(300) }], ['abc'], [null]]) {
      const r = await api('POST', '/rename/apply', { items })
      assert.equal(r.status, 400, JSON.stringify(items))
    }
  })

  test('找不到的 itemId 是逐項結果，不是整個請求失敗', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const r = await api('POST', '/rename/apply', {
      items: [{ itemId: s.idOf('未命名文件 (3).txt') }, { itemId: 'no-such-item' }],
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.results.length, 2)
    assert.equal(r.json.results[0].ok, true)
    assert.equal(r.json.results[1].ok, false)
    assert.match(r.json.results[1].why, /Cannot find/)
  })
})

describe('POST /rename/undo', () => {
  test('{ last: true } 把名字改回去', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const a = await api('POST', '/rename/apply', { items: [{ itemId: s.idOf('未命名文件 (3).txt') }] })
    assert.equal(a.json.results[0].ok, true, a.text)
    const u = await api('POST', '/rename/undo', { last: true })
    assert.equal(u.status, 200)
    assert.equal(u.json.results[0].ok, true, u.text)
    assert.equal(existsSync(join(s.downloads, '未命名文件 (3).txt')), true)
    assert.ok(!u.text.includes(s.downloads))
  })

  test('原名被佔走 → 講清楚放回來的叫什麼', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const a = await api('POST', '/rename/apply', { items: [{ itemId: s.idOf('未命名文件 (3).txt') }] })
    writeFileSync(join(s.downloads, '未命名文件 (3).txt'), '後來才出現的檔')
    const u = await api('POST', '/rename/undo', { ids: [a.json.results[0].id] })
    assert.equal(u.json.results[0].restoredAs, '未命名文件 (3)-2.txt')
    assert.match(u.json.results[0].why, /未命名文件 \(3\)-2\.txt/)
  })

  test('沒帶 ids 也沒帶 last 回 400；不認得的欄位也是 400', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    assert.equal((await api('POST', '/rename/undo', {})).status, 400)
    assert.equal((await api('POST', '/rename/undo', { lst: true })).status, 400)
    assert.equal((await api('POST', '/rename/undo', { last: 'yes' })).status, 400)
  })

  test('找不到那幾筆回 404', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const r = await api('POST', '/rename/undo', { ids: ['不存在'] })
    assert.equal(r.status, 404)
    assert.equal(r.json.code, 'NOT_FOUND')
  })
})

describe('其他', () => {
  test('`/rename/` 底下認不得的路徑回 501，不是 404', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const r = await api('GET', '/rename/還沒做的東西')
    assert.equal(r.status, 501)
    assert.equal(r.json.code, 'NOT_IMPLEMENTED')
  })

  test('免 token 的 /health 不會因為改名多洩漏東西（預期行為 12）', async t => {
    const s = fixture(t)
    const { raw } = await serve(t, s)
    const before = await raw('GET', '/health', { token: '' })
    assert.equal(before.status, 200)
    assert.ok(!before.text.includes(s.downloads))
    assert.ok(!('renames' in before.json), '/health 不需要多一個改名欄位')
    assert.ok(!before.text.includes('未命名文件'), '免 token 的 /health 不可以講出檔名')
  })

  test('網頁不能直接打（來源白名單照樣擋）', async t => {
    const s = fixture(t)
    const { port } = await serve(t, s)
    const r = await fetch(`http://127.0.0.1:${port}/rename/suggestions`, {
      headers: { origin: 'https://evil.example', 'x-contextbox-token': TOKEN },
    })
    assert.equal(r.status, 403)
  })
})
