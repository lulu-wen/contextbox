import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * P4 ・ 歸檔的三條 route（`GET /file/suggestions`、`POST /file/apply`、`POST /file/undo`）。
 *
 * 期望值抄自 `~/contextbox-預想-20260919-P4歸檔.md` 的「介面」與「預期行為」12：
 *
 * | 段落 | 可能的錯 | 另一種解讀 | 成對例子 | 認定的答案 |
 * |---|---|---|---|---|
 * | 要不要 token | 跟 /health 一樣免 token | 三條都要 | 不帶 token／帶 | 401／200 |
 * | 回應裡的路徑 | 帶完整路徑方便前端 | 只有相對於 filed 的那一段 | 任何一條 | 一個絕對路徑都沒有 |
 * | 沒帶 items | 當成「全部」 | 看不懂 | `{}`／`{ items: [⋯] }` | 400 BAD_BODY，一個檔都沒動 |
 * | 拼錯的欄位 | 當成沒帶 | 看不懂 | `{ itemIDs: [⋯] }` | 400 BAD_BODY |
 * | 用錯方法 | 404 | 405 | GET /file/apply | 405，帶 Allow |
 * | /health | 多講了歸檔的事 | 不變 | 免 token 的 /health | 欄位跟以前一樣 |
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import * as server from '../core/server.ts'
import { COURSES_DIR } from '../core/filing.ts'
import { sandbox, OS_DEADLOCK, DS_MIDTERM } from './helpers/rename.mjs'

const TOKEN = 'filing-wire-token'
const HIGH = { course: '作業系統', topic: '死結', kind: 'Notes', suggestedName: '作業系統_死結', evidence: '四個必要條件', confidence: 'high' }

async function serve(t, s, extra = {}) {
  const S = server.start({
    port: 0, db: s.dbPath, token: TOKEN, roots: [s.downloads], quarantine: s.scope.quarantine,
    filed: s.filed, maxBytes: 20 * 1024 * 1024, readonly: false, ...extra,
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
  s.seed('IMG_2041.txt', { ...HIGH, course: '資料結構', topic: '期中考範圍', kind: 'Exam' })
  return s
}

describe('GET /file/suggestions', () => {
  test('要 token', async t => {
    const s = fixture(t)
    const { raw } = await serve(t, s)
    assert.equal((await raw('GET', '/file/suggestions', { token: '' })).status, 401)
  })

  test('列得出建議，而且**沒有絕對路徑**（只有相對於 filed 的那一段）', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const r = await api('GET', '/file/suggestions')
    assert.equal(r.status, 200)
    assert.equal(r.json.items.length, 2)
    const folders = r.json.items.map(i => i.toFolder).sort()
    assert.deepEqual(folders, ['Courses/作業系統/Notes', 'Courses/資料結構/Exam'])
    for (const i of r.json.items) {
      assert.equal(typeof i.seeded, 'boolean')
      assert.ok(!('path' in i) && !('dir' in i) && !('toDir' in i), '回應不可以帶路徑')
    }
    assert.ok(!r.text.includes(s.downloads), r.text)
    assert.ok(!r.text.includes(s.filed), r.text)
    assert.ok(!r.text.includes(FAKE_HOME), r.text)
  })

  test('limit 不合法回 400', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    for (const bad of ['0', '-1', 'abc', '1001', '1.5']) {
      const r = await api('GET', `/file/suggestions?limit=${bad}`)
      assert.equal(r.status, 400, bad)
      assert.equal(r.json.code, 'BAD_BODY')
    }
    assert.equal((await api('GET', '/file/suggestions?limit=1')).json.items.length, 1)
  })

  test('用錯方法回 405，帶 Allow', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const r = await api('POST', '/file/suggestions', {})
    assert.equal(r.status, 405)
    assert.equal(r.json.code, 'BAD_METHOD')
    assert.equal(r.headers.get('allow'), 'GET')
  })

  test('沒設定 filed → 500 BAD_CONFIG（不猜一個位置去搬使用者的檔）', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s, { filed: '' })
    const r = await api('GET', '/file/suggestions')
    assert.equal(r.status, 500)
    assert.equal(r.json.code, 'BAD_CONFIG')
  })

  test('**整個沒傳 filed 也不猜**：不會偷偷搬到家目錄底下的 Documents/Filed', async t => {
    // 稽核（2026-09-20）：start() 全部參數都給了（所以不讀設定檔）、就是沒給 filed 的時候，
    // 以前會退回 join(homedir(),'Documents','Filed') —— 那是沒人講過的位置。
    const s = fixture(t)
    const { api } = await serve(t, s, { filed: undefined })
    assert.equal((await api('GET', '/file/suggestions')).json.code, 'BAD_CONFIG')
    const apply = await api('POST', '/file/apply', { items: [{ itemId: s.idOf('未命名文件 (3).txt') }] })
    assert.equal(apply.status, 500)
    assert.equal(apply.json.code, 'BAD_CONFIG')
    assert.equal(existsSync(join(FAKE_HOME, 'Documents', 'Filed')), false, '一個資料夾都不可以在家目錄底下長出來')
    assert.equal(existsSync(join(s.downloads, '未命名文件 (3).txt')), true)
  })
})

describe('POST /file/apply', () => {
  test('真的搬過去，逐項結果**沒有絕對路徑**', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const id = s.idOf('未命名文件 (3).txt')
    const r = await api('POST', '/file/apply', { items: [{ itemId: id }] })
    assert.equal(r.status, 200)
    assert.equal(r.json.results[0].ok, true, r.text)
    assert.equal(r.json.results[0].toFolder, 'Courses/作業系統/Notes')
    assert.equal(r.json.results[0].to, '未命名文件 (3).txt')
    assert.equal(r.json.remaining, 0)
    assert.equal(existsSync(join(s.filed, COURSES_DIR, '作業系統', 'Notes', '未命名文件 (3).txt')), true)
    assert.ok(!r.text.includes(s.downloads), r.text)
    assert.ok(!r.text.includes(s.filed), r.text)
  })

  test('呼叫端可以指名 course 與 kind（面板送的就是模型那兩個）', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const id = s.idOf('未命名文件 (3).txt')
    const r = await api('POST', '/file/apply', { items: [{ itemId: id, course: '計算機組織', kind: 'Lecture' }] })
    assert.equal(r.json.results[0].toFolder, 'Courses/計算機組織/Lecture', r.text)
  })

  test('**沒帶 items 不是「全部」**，是看不懂；一個檔都不動', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const before = readdirSync(s.downloads).sort()
    for (const body of [{}, { items: null }, { items: [] }, { items: 'all' }]) {
      const r = await api('POST', '/file/apply', body)
      assert.equal(r.status, 400, JSON.stringify(body))
      assert.equal(r.json.code, 'BAD_BODY')
    }
    assert.deepEqual(readdirSync(s.downloads).sort(), before)
    assert.equal(existsSync(s.filed), false, 'filed 也不該被建出來')
  })

  test('拼錯的欄位是看不懂，不是「沒帶」', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const r = await api('POST', '/file/apply', { itemIDs: [s.idOf('未命名文件 (3).txt')] })
    assert.equal(r.status, 400)
    assert.equal(r.json.code, 'BAD_BODY')
    assert.match(r.json.error, /itemIDs/)
    assert.equal(existsSync(join(s.downloads, '未命名文件 (3).txt')), true)
  })

  test('唯讀模式回 403，一個檔都不動', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s, { readonly: true })
    const r = await api('POST', '/file/apply', { items: [{ itemId: s.idOf('未命名文件 (3).txt') }] })
    assert.equal(r.status, 403)
    assert.equal(r.json.code, 'READ_ONLY')
    assert.equal(existsSync(join(s.downloads, '未命名文件 (3).txt')), true)
  })

  test('itemId 看不懂回 400', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    for (const items of [[{ itemId: 42 }], [{ itemId: '' }], [{ itemId: 'x'.repeat(300) }], ['abc'], [null]]) {
      assert.equal((await api('POST', '/file/apply', { items })).status, 400, JSON.stringify(items))
    }
  })

  test('找不到的 itemId 是逐項結果，不是整個請求失敗', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const r = await api('POST', '/file/apply', {
      items: [{ itemId: s.idOf('未命名文件 (3).txt') }, { itemId: 'no-such-item' }],
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.results[0].ok, true)
    assert.equal(r.json.results[1].ok, false)
    assert.match(r.json.results[1].why, /Cannot find/)
  })
})

describe('POST /file/undo', () => {
  test('{ last: true } 把檔案搬回原本的資料夾', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const a = await api('POST', '/file/apply', { items: [{ itemId: s.idOf('未命名文件 (3).txt') }] })
    assert.equal(a.json.results[0].ok, true, a.text)
    const u = await api('POST', '/file/undo', { last: true })
    assert.equal(u.status, 200)
    assert.equal(u.json.results[0].ok, true, u.text)
    assert.equal(existsSync(join(s.downloads, '未命名文件 (3).txt')), true)
    assert.ok(!u.text.includes(s.downloads))
    assert.ok(!u.text.includes(s.filed))
  })

  test('原位被佔 → 講清楚放回來的叫什麼', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const a = await api('POST', '/file/apply', { items: [{ itemId: s.idOf('未命名文件 (3).txt') }] })
    writeFileSync(join(s.downloads, '未命名文件 (3).txt'), '後來才出現的檔')
    const u = await api('POST', '/file/undo', { ids: [a.json.results[0].id] })
    assert.equal(u.json.results[0].restoredAs, '未命名文件 (3)-2.txt')
    assert.match(u.json.results[0].why, /未命名文件 \(3\)-2\.txt/)
  })

  test('沒帶 ids 也沒帶 last 回 400；不認得的欄位也是 400', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    assert.equal((await api('POST', '/file/undo', {})).status, 400)
    assert.equal((await api('POST', '/file/undo', { lst: true })).status, 400)
    assert.equal((await api('POST', '/file/undo', { last: 'yes' })).status, 400)
  })

  test('找不到那幾筆回 404', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const r = await api('POST', '/file/undo', { ids: ['不存在'] })
    assert.equal(r.status, 404)
    assert.equal(r.json.code, 'NOT_FOUND')
  })
})

describe('其他', () => {
  test('`/file/` 底下認不得的路徑回 501，不是 404', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const r = await api('GET', '/file/還沒做的東西')
    assert.equal(r.status, 501)
    assert.equal(r.json.code, 'NOT_IMPLEMENTED')
  })

  test('免 token 的 /health 不會因為歸檔多洩漏東西（預期行為 12）', async t => {
    const s = fixture(t)
    const { raw } = await serve(t, s)
    const before = await raw('GET', '/health', { token: '' })
    assert.equal(before.status, 200)
    assert.ok(!before.text.includes(s.downloads))
    assert.ok(!before.text.includes(s.filed), '/health 不可以講出歸檔資料夾在哪')
    assert.ok(!('filings' in before.json), '/health 不需要多一個歸檔欄位')
    assert.ok(!before.text.includes('未命名文件'), '免 token 的 /health 不可以講出檔名')
  })

  test('網頁不能直接打（來源白名單照樣擋）', async t => {
    const s = fixture(t)
    const { port } = await serve(t, s)
    const r = await fetch(`http://127.0.0.1:${port}/file/suggestions`, {
      headers: { origin: 'https://evil.example', 'x-contextbox-token': TOKEN },
    })
    assert.equal(r.status, 403)
  })

  test('改名與歸檔互不干擾：先改名再歸檔，兩邊的紀錄各自復原得回去（不變量 9）', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const id = s.idOf('未命名文件 (3).txt')
    const renamed = await api('POST', '/rename/apply', { items: [{ itemId: id, to: '作業系統_死結' }] })
    assert.equal(renamed.json.results[0].ok, true, renamed.text)
    const filed = await api('POST', '/file/apply', { items: [{ itemId: id }] })
    assert.equal(filed.json.results[0].ok, true, filed.text)
    const there = join(s.filed, COURSES_DIR, '作業系統', 'Notes', '作業系統_死結.txt')
    assert.equal(existsSync(there), true)

    // 先復原歸檔（檔案回到 Downloads，名字還是改過的）
    assert.equal((await api('POST', '/file/undo', { last: true })).json.results[0].ok, true)
    assert.equal(existsSync(join(s.downloads, '作業系統_死結.txt')), true)
    // 再復原改名（名字回去）
    assert.equal((await api('POST', '/rename/undo', { last: true })).json.results[0].ok, true)
    assert.deepEqual(readdirSync(s.downloads).sort(), ['IMG_2041.txt', '未命名文件 (3).txt'])
  })

  test('目標資料夾建在 filed 底下，而且不會有東西跑到 filed 外面', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    await api('POST', '/file/apply', { items: [{ itemId: s.idOf('未命名文件 (3).txt'), course: '../../壞人' }] })
    assert.deepEqual(readdirSync(join(s.filed, COURSES_DIR)), ['壞人'])
    assert.equal(existsSync(join(s.dir, '壞人')), false)
    mkdirSync(join(s.dir, '不該被碰的'), { recursive: true })
    assert.deepEqual(readdirSync(join(s.dir, '不該被碰的')), [])
  })
})

describe('稽核 A-2 ・ 動檔案的入口要把三種都收一次（2026-09-20）', () => {
  test('改名停在 started 的檔被歸檔 → 那筆改名不可以從此收不掉', async t => {
    const s = fixture(t)
    const { api } = await serve(t, s)
    const name = '未命名文件 (3).txt'
    const itemId = s.idOf(name)

    // 做出「改名做到一半被砍」：renames 停在 started，檔案其實已經改好了
    const renameId = randomUUID()
    s.db.prepare(
      `INSERT INTO renames (id,item_id,from_name,to_name,dir,source,status,error,at,undone_at)
       VALUES (?,?,?,?,?, 'model','started',NULL,?,NULL)`
    ).run(renameId, itemId, name, 'Operating Systems_Deadlock.txt', s.downloads, new Date().toISOString())
    renameSync(join(s.downloads, name), join(s.downloads, 'Operating Systems_Deadlock.txt'))

    // 使用者在面板按「整理」。**這一下必須順手把那筆改名收成 done** ——
    // 不收的話檔案被搬去 filed，之後改名收尾在原資料夾兩個名字都找不到，判 failed（「請人工確認」），
    // 而「它本來叫什麼」就只剩資料庫裡那一列，CLI 與面板都看不到。
    const r = await api('POST', '/file/apply', { items: [{ itemId }] })
    assert.equal(r.status, 200, JSON.stringify(r.json))

    const row = s.db.prepare('SELECT * FROM renames WHERE id=?').get(renameId)
    assert.equal(row.status, 'done', `那筆改名要被收成 done，實際是 ${row.status}／${row.error}`)
  })
})
