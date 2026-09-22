import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * P5 ・ `GET /learned` 與 `DELETE /learned`，還有建議那兩條多出來的欄位。
 *
 * 期望值抄自 `~/contextbox-預想-20260920-P5學習.md` 的「介面」與預期行為 11：
 *
 * | 段落 | 可能的錯 | 另一種解讀 | 成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | 要不要 token | 跟 /health 一樣免 token | 兩條都要 | 不帶 token／帶 | 401／200 |
 * | 回應裡的路徑 | 帶路徑方便前端 | 一個都沒有 | 任何一條 | 沒有絕對路徑、沒有檔案內容 |
 * | DELETE 沒帶欄位 | 當成「全部忘掉」 | 看不懂 | `{}` | 400 BAD_BODY，一條都沒少 |
 * | 拼錯的欄位 | 當成沒帶 | 看不懂 | `{ IDs: [...] }` | 400 BAD_BODY |
 * | 用錯方法 | 404 | 405 | POST /learned | 405，Allow: GET, DELETE |
 * | 唯讀模式的 DELETE | 照刪 | 不刪 | readonly: true | 403 READ_ONLY，一條都沒少 |
 * | 建議清單 | 只多 learned | 多 learned 與 rejectedBefore | 任何一項 | 兩個欄位都在，型別是 boolean |
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import * as server from '../core/server.ts'
import { sandbox, OS_DEADLOCK, OS_SCHEDULING, DS_MIDTERM } from './helpers/rename.mjs'

const TOKEN = 'learn-wire-token'
const OS_VIEW = { course: '作業系統', topic: '死結', kind: 'Notes', suggestedName: '作業系統_死結', confidence: 'high' }

async function serve(t, s, extra = {}) {
  const S = server.start({
    port: 0, db: s.dbPath, token: TOKEN, roots: [s.downloads], quarantine: s.scope.quarantine,
    filed: s.filed, maxBytes: 20 * 1024 * 1024, readonly: false, ...extra,
  })
  const port = await S.ready
  t.after(() => globalThis.__cbStopPage?.(); S.server.closeAllConnections(); S.server.close(); S.server.unref())
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
  const s = sandbox(t, {
    '未命名文件 (3).txt': OS_DEADLOCK,
    '未命名文件 (4).txt': OS_SCHEDULING,
    'IMG_2041.txt': DS_MIDTERM,
  })
  s.seed('未命名文件 (3).txt', OS_VIEW)
  s.seed('未命名文件 (4).txt', { ...OS_VIEW, topic: '行程排程', suggestedName: '作業系統_排程' })
  s.seed('IMG_2041.txt', { course: '資料結構', topic: '期中考範圍', kind: 'Exam', suggestedName: '資料結構_期中考範圍', confidence: 'high' })
  return s
}

/** 走一次「改成 OS」，回那一條偏好的 id。 */
async function teach(api) {
  const list = await api('GET', '/file/suggestions')
  const one = list.json.items.find(i => i.name === '未命名文件 (3).txt')
  const r = await api('POST', '/file/apply', { items: [{ itemId: one.itemId, course: 'OS', kind: one.kind }] })
  assert.equal(r.json.results[0].ok, true, r.text)
  return r
}

describe('GET /learned', () => {
  test('要 token', async t => {
    const { raw } = await serve(t, fixture(t))
    assert.equal((await raw('GET', '/learned', { token: '' })).status, 401)
  })

  test('什麼都沒學過就是空的（不是 404）', async t => {
    const { api } = await serve(t, fixture(t))
    const r = await api('GET', '/learned')
    assert.equal(r.status, 200)
    assert.deepEqual(r.json, { items: [], evicted: { count: 0, at: null } })
  })

  test('學過之後列得出來，欄位就是 id／kind／from／to／times／at', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    await teach(api)
    const r = await api('GET', '/learned')
    assert.equal(r.json.items.length, 1)
    assert.deepEqual(Object.keys(r.json.items[0]).sort(), ['about', 'at', 'from', 'id', 'kind', 'times', 'to'])
    assert.equal(r.json.items[0].kind, 'course')
    assert.equal(r.json.items[0].from, '作業系統')
    assert.equal(r.json.items[0].to, 'OS')
  })

  test('**回應裡沒有絕對路徑、沒有檔案內容**（預期行為 11）', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    await teach(api)
    // 再退一次貨，讓 rejected 那一種也進來
    const list = await api('GET', '/file/suggestions')
    const two = list.json.items.find(i => i.name === '未命名文件 (4).txt')
    await api('POST', '/file/apply', { items: [{ itemId: two.itemId, course: two.course, kind: two.kind }] })
    await api('POST', '/file/undo', { last: true })

    const r = await api('GET', '/learned')
    assert.ok(r.json.items.some(i => i.kind === 'rejected'))
    for (const leak of [s.downloads, s.filed, s.dir, FAKE_HOME]) {
      assert.ok(!r.text.includes(leak), `${leak} 不可以出現：${r.text}`)
    }
    assert.ok(!r.text.includes('死結的四個必要條件'), r.text)
    assert.ok(!r.text.includes(two.itemId), 'rejected 不用回 itemId')
  })

  test('用錯方法回 405，帶 Allow', async t => {
    const { api } = await serve(t, fixture(t))
    const r = await api('POST', '/learned', {})
    assert.equal(r.status, 405)
    assert.equal(r.json.code, 'BAD_METHOD')
    assert.equal(r.headers.get('allow'), 'GET, DELETE')
  })

  test('`/learned/` 底下認不得的路徑回 501，不是 404', async t => {
    const { api } = await serve(t, fixture(t))
    const r = await api('GET', '/learned/anything')
    assert.equal(r.status, 501)
    assert.equal(r.json.code, 'NOT_IMPLEMENTED')
  })

  test('唯讀模式照樣列得出來（唯讀不等於看不到）', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s, { readonly: true })
    assert.equal((await api('GET', '/learned')).status, 200)
  })
})

describe('DELETE /learned', () => {
  test('要 token', async t => {
    const { raw } = await serve(t, fixture(t))
    const r = await raw('DELETE', '/learned', { token: '', body: JSON.stringify({ all: true }) })
    assert.equal(r.status, 401)
  })

  test('指名 ids 忘掉那幾條', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    await teach(api)
    const id = (await api('GET', '/learned')).json.items[0].id
    const r = await api('DELETE', '/learned', { ids: [id] })
    assert.equal(r.status, 200)
    assert.equal(r.json.forgotten, 1)
    assert.deepEqual((await api('GET', '/learned')).json.items, [])
    // 忘掉之後建議回到模型的說法
    const after = await api('GET', '/file/suggestions')
    assert.equal(after.json.items.find(i => i.name === '未命名文件 (4).txt').toFolder, 'Courses/作業系統/Notes')
  })

  test('{ all: true } 全部忘掉', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    await teach(api)
    const r = await api('DELETE', '/learned', { all: true })
    assert.equal(r.json.forgotten, 1)
    assert.deepEqual((await api('GET', '/learned')).json.items, [])
  })

  test('**沒帶欄位不可以被當成「全部忘掉」**', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    await teach(api)
    for (const body of [{}, undefined, { all: false }, { ids: [] }]) {
      const r = await api('DELETE', '/learned', body)
      assert.equal(r.status, 400, JSON.stringify(body))
      assert.equal(r.json.code, 'BAD_BODY')
    }
    assert.equal((await api('GET', '/learned')).json.items.length, 1, '一條都不可以少')
  })

  test('拼錯的欄位是「看不懂」，不是「沒帶」', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    await teach(api)
    const r = await api('DELETE', '/learned', { IDs: ['x'] })
    assert.equal(r.status, 400)
    assert.equal(r.json.code, 'BAD_BODY')
    assert.match(r.json.error, /unknown field/)
    assert.equal((await api('GET', '/learned')).json.items.length, 1)
  })

  test('ids 與 all 一起送要講清楚（不猜）', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    await teach(api)
    const id = (await api('GET', '/learned')).json.items[0].id
    const r = await api('DELETE', '/learned', { ids: [id], all: true })
    assert.equal(r.status, 400)
    assert.equal((await api('GET', '/learned')).json.items.length, 1)
  })

  test('型別不對回 400', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    await teach(api)
    for (const body of [{ ids: 'x' }, { ids: [1] }, { ids: [''] }, { all: 'true' }]) {
      const r = await api('DELETE', '/learned', body)
      assert.equal(r.status, 400, JSON.stringify(body))
    }
    assert.equal((await api('GET', '/learned')).json.items.length, 1)
  })

  test('唯讀模式 403 READ_ONLY，一條都沒少', async t => {
    const s = fixture(t)
    // 先在唯讀關掉的 server 上學一條，再用唯讀的 server 去刪
    const on = await serve(t, s)
    await teach(on.api)
    const off = await serve(t, s, { readonly: true })
    const r = await off.api('DELETE', '/learned', { all: true })
    assert.equal(r.status, 403)
    assert.equal(r.json.code, 'READ_ONLY')
    assert.equal((await off.api('GET', '/learned')).json.items.length, 1)
  })

  test('沒有那幾個 id 不算錯（使用者要的是「它不見了」）', async t => {
    const { api } = await serve(t, fixture(t))
    const r = await api('DELETE', '/learned', { ids: ['沒有這一條'] })
    assert.equal(r.status, 200)
    assert.equal(r.json.forgotten, 0)
  })
})

describe('建議那兩條多出來的欄位', () => {
  test('/file/suggestions 每一項都有 learned 與 rejectedBefore', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const r = await api('GET', '/file/suggestions')
    for (const i of r.json.items) {
      assert.equal(typeof i.learned, 'boolean')
      assert.equal(typeof i.rejectedBefore, 'boolean')
      assert.equal(typeof i.alsoKnownAs, 'string')
      assert.equal(typeof i.modelCourse, 'string')
      assert.ok(!('path' in i) && !('dir' in i) && !('toDir' in i), '回應不可以帶路徑')
    }
  })

  test('/rename/suggestions 每一項都有 learned 與 rejectedBefore', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const r = await api('GET', '/rename/suggestions')
    assert.ok(r.json.items.length)
    for (const i of r.json.items) {
      assert.equal(typeof i.learned, 'boolean')
      assert.equal(typeof i.rejectedBefore, 'boolean')
    }
  })

  test('學過之後 learned 變 true，而且整條線走得完（HTTP → 真的搬）', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    await teach(api)
    const after = await api('GET', '/file/suggestions')
    const second = after.json.items.find(i => i.name === '未命名文件 (4).txt')
    assert.equal(second.learned, true)
    assert.equal(second.toFolder, 'Courses/OS/Notes')
    const moved = await api('POST', '/file/apply', { items: [{ itemId: second.itemId, course: second.course, kind: second.kind }] })
    assert.equal(moved.json.results[0].toFolder, 'Courses/OS/Notes')
    assert.deepEqual(s.filedTree().filter(p => p.endsWith('.txt')).sort(),
      ['Courses/OS/Notes/未命名文件 (3).txt', 'Courses/OS/Notes/未命名文件 (4).txt'])
  })

  test('undo 之後 rejectedBefore 變 true（清單照樣列它）', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const one = (await api('GET', '/file/suggestions')).json.items[0]
    await api('POST', '/file/apply', { items: [{ itemId: one.itemId, course: one.course, kind: one.kind }] })
    await api('POST', '/file/undo', { last: true })
    const again = (await api('GET', '/file/suggestions')).json.items.find(i => i.name === one.name)
    assert.ok(again)
    assert.equal(again.rejectedBefore, true)
  })

  test('資料表不見了：兩條建議照樣回 200（降級，不是 500）', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    s.db.exec('DROP TABLE preferences')
    assert.equal((await api('GET', '/file/suggestions')).status, 200)
    assert.equal((await api('GET', '/rename/suggestions')).status, 200)
    const r = await api('GET', '/learned')
    assert.equal(r.status, 200)
    assert.deepEqual(r.json.items, [])
  })

  test('免 token 的 /health 不會因為 P5 多講什麼', async t => {
    const s = fixture(t)
    const { raw } = await serve(t, s)
    const r = await raw('GET', '/health', { token: '' })
    assert.equal(r.status, 200)
    assert.ok(!('learned' in r.json), r.text)
    assert.ok(!('preferences' in r.json), r.text)
  })
})
