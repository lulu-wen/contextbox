import { before, beforeEach, after, describe, test } from 'node:test'
import { rmTmp } from './helpers/rm.mjs'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open } from '../core/db.ts'
import { createCleanupWatcher } from '../core/cleanup-watcher.ts'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const SETTLE = 40
const day = 24 * 60 * 60 * 1000
const nowish = () => new Date(Date.now() - 40 * day)

let root, downloads, db

before(() => {
  root = mkdtempSync(join(tmpdir(), 'cb-cleanup-watch-'))
  downloads = join(root, 'Downloads')
})

after(() => rmTmp(root))

beforeEach(() => {
  rmSync(downloads, { recursive: true, force: true })
  mkdirSync(downloads, { recursive: true })
  db = open(':memory:')
})

function oldFile(name, content = 'x') {
  const p = join(downloads, name)
  writeFileSync(p, content)
  const t = nowish()
  utimesSync(p, t, t)
  return p
}

function mk(extra = {}) {
  const scans = []
  const problems = []
  let seeded = 0
  const w = createCleanupWatcher({
    db,
    roots: [downloads],
    maxBytes: 1024 * 1024,
    settleMs: SETTLE,
    tickMs: 10,
    pollMs: 0,
    onScan: r => scans.push(r),
    onSeed: n => { seeded = n },
    onProblem: m => problems.push(m),
    ...extra,
  })
  return { w, scans, problems, seeded: () => seeded }
}

async function settle(w) {
  await sleep(SETTLE + 20)
  w.tick()
  w.tick()
}

describe('cleanup watcher', () => {
  test('新檔剛出現不會馬上掃，穩定後才掃進資料庫', async () => {
    const { w, scans } = mk()
    oldFile('old.zip')
    w.poll()
    assert.equal(w.pendingCount(), 1)
    w.tick()
    assert.equal(scans.length, 0)

    await settle(w)
    assert.equal(scans.length, 1)
    assert.equal(db.prepare(`SELECT count(*) n FROM file_items`).get().n, 1)
  })

  test('還在長大的檔案要重新等待', async () => {
    const { w, scans } = mk()
    const p = oldFile('growing.zip', 'a')
    w.poll()

    await sleep(SETTLE + 20)
    appendFileSync(p, 'more')
    w.tick()
    assert.equal(scans.length, 0)

    await settle(w)
    assert.equal(scans.length, 1)
  })

  test('start seed 既有檔案，不把舊 Downloads 全部丟給 UI', async () => {
    oldFile('a.zip')
    oldFile('b.zip')
    const { w, scans, seeded } = mk()

    w.start()
    assert.equal(seeded(), 2)
    w.poll()
    await settle(w)
    assert.equal(scans.length, 0)

    oldFile('new.zip')
    w.poll()
    await settle(w)
    assert.equal(scans.length, 1)
    w.stop()
  })

  test('同名檔內容變了會重新掃，不會被舊 fingerprint 吃掉', async () => {
    const { w, scans } = mk()
    const p = oldFile('again.zip', 'first')
    w.poll()
    await settle(w)
    assert.equal(scans.length, 1)

    writeFileSync(p, 'second')
    const t = nowish()
    utimesSync(p, t, t)
    w.poll()
    await settle(w)
    assert.equal(scans.length, 2)
  })
})
