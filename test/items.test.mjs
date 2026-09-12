/**
 * items 的測試。
 *
 * 重點在兩件容易搞錯的事：
 *   1. 同一個檔案被看到兩次，不可以變成兩列。
 *   2. 內容換了（同名覆蓋），舊的理解一定要作廢，不然會拿舊摘要配新圖。
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { open } from '../core/db.ts'
import { Items, sha256Of, SwappedError } from '../core/items.ts'
import { admit } from '../core/guard.ts'

let root, watchDir, db, items, opts

before(() => {
  root = mkdtempSync(join(tmpdir(), 'cb-items-'))
  watchDir = join(root, 'Downloads')
  mkdirSync(watchDir, { recursive: true })
  opts = { roots: [watchDir], maxBytes: 1024 * 1024 }
})
after(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  db = open(':memory:')
  items = new Items(db)
})

/** 寫一個檔並過一次防線，拿到可以塞進 items 的東西 */
function file(name, content = 'hello') {
  const p = join(watchDir, name)
  writeFileSync(p, content)
  const v = admit(p, opts)
  assert.equal(v.ok, true, name + ' 應該過得了防線')
  return v
}

describe('收進來', () => {
  test('第一次是新的', () => {
    const { item, fresh } = items.add(file('a.png'))
    assert.equal(fresh, true)
    assert.equal(item.status, 'new')
    assert.equal(item.kind, 'image')
    assert.equal(basename(item.path), 'a.png')
    assert.equal(item.sha256.length, 64)
  })

  test('同一個檔案看兩次不會變成兩列', () => {
    const v = file('b.png')
    const first = items.add(v)
    const second = items.add(v)
    assert.equal(second.fresh, false, '內容沒變就不是新的')
    assert.equal(second.item.id, first.item.id)
    assert.equal(items.list().length, 1)
  })

  test('同名覆蓋：算新的，而且舊的理解要作廢', () => {
    const v1 = file('c.png', '第一版')
    const { item } = items.add(v1)
    db.prepare(
      `INSERT INTO understanding (item_id, model, summary, raw, created_at) VALUES (?,?,?,?,?)`
    ).run(item.id, 'test-model', '第一版的摘要', '{}', new Date().toISOString())
    db.prepare(
      `INSERT INTO items_fts (item_id, name, summary, text, tags) VALUES (?,?,?,?,?)`
    ).run(item.id, 'c.png', '第一版的摘要', '', '[]')

    const v2 = file('c.png', '第二版，完全不一樣的內容')
    const again = items.add(v2)

    assert.equal(again.fresh, true, '內容變了就是新的')
    assert.equal(again.item.id, item.id, '同一個路徑還是同一列')
    assert.notEqual(again.item.sha256, item.sha256)
    assert.equal(again.item.status, 'new', '狀態要退回去重新處理')
    assert.equal(
      db.prepare(`SELECT count(*) n FROM understanding WHERE item_id=?`).get(item.id).n, 0,
      '舊的理解一定要刪掉，不然會拿舊摘要配新圖')
    assert.equal(
      db.prepare(`SELECT count(*) n FROM items_fts WHERE item_id=?`).get(item.id).n, 0,
      '全文索引也要跟著清')
  })

  test('內容一樣但檔名不同：兩列，但認得出是同一份', () => {
    const a = items.add(file('d1.png', '一模一樣'))
    const b = items.add(file('d2.png', '一模一樣'))
    assert.notEqual(a.item.id, b.item.id, '兩個真的檔案就是兩列')
    assert.equal(a.item.sha256, b.item.sha256)

    const same = items.bySha(b.item.sha256, b.item.id)
    assert.equal(same.length, 1, '找得到另外那一份，理解可以共用')
    assert.equal(same[0].id, a.item.id)
  })
})

describe('狀態', () => {
  test('改狀態與記錯誤', () => {
    const { item } = items.add(file('e.png'))
    items.setStatus(item.id, 'error', '模型沒回話')
    const after = items.get(item.id)
    assert.equal(after.status, 'error')
    assert.equal(after.error, '模型沒回話')

    items.setStatus(item.id, 'new')
    assert.equal(items.get(item.id).error, null, '重試的時候錯誤要清掉')
  })

  test('counts 按狀態分組', () => {
    items.add(file('f1.png'))
    items.add(file('f2.png'))
    const { item } = items.add(file('f3.png'))
    items.setStatus(item.id, 'applied')
    const c = items.counts()
    assert.equal(c.new, 2)
    assert.equal(c.applied, 1)
  })

  test('沒有這筆就丟例外，不要安靜地什麼都沒做', () => {
    assert.throws(() => items.setStatus('不存在的-id', 'applied'), /沒有這筆/)
  })
})

describe('搬走之後', () => {
  test('路徑要更新，全文索引裡的檔名也要跟著換', () => {
    const { item } = items.add(file('g.png'))
    db.prepare(
      `INSERT INTO items_fts (item_id, name, summary, text, tags) VALUES (?,?,?,?,?)`
    ).run(item.id, 'g.png', '摘要', '', '[]')

    const dest = join(root, 'Filed', '獎學金', '台大獎學金.png')
    items.setPath(item.id, dest)

    assert.equal(items.get(item.id).path, dest)
    assert.equal(
      db.prepare(`SELECT name FROM items_fts WHERE item_id=?`).get(item.id).name,
      '台大獎學金.png',
      '改名之後用舊名字就搜不到了')
    assert.equal(items.get(item.id).sha256.length, 64, '內容沒變，指紋不該動')
  })
})

describe('檔案在檢查之後被換掉', () => {
  test('admit 說 ok 之後換成捷徑，算指紋的時候要擋下來', () => {
    // guard 檢查的是「那一瞬間的那個 inode」，但真正被讀、被雜湊、
    // 被記進資料庫的是之後才重新解析的路徑。中間那個窗口是可以攻擊的。
    const secret = join(root, 'id_ed25519')
    writeFileSync(secret, 'PRIVATE KEY MATERIAL')
    const p = join(watchDir, 'h1.png')
    writeFileSync(p, '一張正常的截圖')
    const v = admit(p, opts)
    assert.equal(v.ok, true)

    unlinkSync(p)
    symlinkSync(secret, p)                 // 換成指向私鑰的捷徑
    assert.throws(() => items.add(v), SwappedError, '換掉了就不可以收')
    assert.equal(items.list().length, 0, '一列都不該進資料庫')
  })

  test('內容在中間被改掉也要擋', () => {
    const p = join(watchDir, 'h2.png')
    writeFileSync(p, '原本的內容')
    const v = admit(p, opts)
    writeFileSync(p, '被換成完全不同的內容了')
    assert.throws(() => items.add(v), SwappedError)
  })

  test('沒有人動手腳的話要正常收', () => {
    const v = file('h3.png')
    assert.equal(items.add(v).fresh, true)
  })
})

describe('內容變了，舊的提案不算數', () => {
  test('還沒執行的提案要作廢', () => {
    // 舊提案裡的「搬到哪、改什麼名字」是照舊內容算的。
    // 留著的話下一期按同意就會把新內容搬到舊提案的位置。
    const { item } = items.add(file('p1.png', '第一版'))
    db.prepare(
      `INSERT INTO plans (id,item_id,proposal,ops,status,created_at) VALUES (?,?,?,?,?,?)`
    ).run('plan-1', item.id, '{}', '[]', 'proposed', new Date().toISOString())

    items.add(file('p1.png', '第二版，完全不同'))
    assert.equal(
      db.prepare(`SELECT status FROM plans WHERE id='plan-1'`).get().status, 'dismissed')
  })
})

describe('搬到已經有東西的位置', () => {
  test('不覆蓋別人的那一列，而且錯誤講得出是哪一種', () => {
    const a = items.add(file('q1.png', 'aaa')).item
    const b = items.add(file('q2.png', 'bbb')).item
    assert.throws(() => items.setPath(a.id, b.path), /不覆蓋/)
    assert.equal(items.get(a.id).path, a.path, '失敗就不該動到原本的路徑')
  })

  test('沒有這筆就講清楚', () => {
    assert.throws(() => items.setPath('不存在的-id', '/x/y.png'), /沒有這筆/)
  })
})

describe('指紋', () => {
  test('同內容同指紋、不同內容不同指紋', () => {
    const a = join(watchDir, 'j1.bin'); writeFileSync(a, 'AAA')
    const b = join(watchDir, 'j2.bin'); writeFileSync(b, 'AAA')
    const c = join(watchDir, 'j3.bin'); writeFileSync(c, 'BBB')
    assert.equal(sha256Of(a), sha256Of(b))
    assert.notEqual(sha256Of(a), sha256Of(c))
  })
})
