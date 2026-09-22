import './helpers/isolate-home.mjs'   // 一定要第一個 import
/**
 * 開發模式的自動重新整理（`CONTEXTBOX_DEV=1`）。
 *
 * 使用者 2026-09-22：「能不能在 code 有更動的時候，直接前端刷新就可以更動? 用一個熱重載?」
 *
 * 先講清楚本來就成立的事：**前端從來就不用重開 server** —— 每個素材請求都重讀檔案，
 * 而且一律 `cache-control: no-store`，所以改完按 F5 就會拿到新的。
 * 這一支測的是「連 F5 都不用按」那一層，以及它**不可以**做的兩件事：
 *
 *   · 平常（沒有 CONTEXTBOX_DEV）一個字都不多回 —— 面板在使用者清到一半自己重新整理，
 *     會把勾選與正在進行的動作洗掉
 *   · `core/*.ts` 改了不可以假裝熱重載：Node 已經把那些模組載進記憶體，換了檔也不生效。
 *     只能誠實講一句「重開 pet」
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../core/server.ts'
import { rmTmp } from './helpers/rm.mjs'

const TOKEN = 'dev-reload-token'

/** 起一台 server，回一個問 /health 的函式。`dev` 決定要不要開發模式。 */
async function serve(t, { dev }) {
  const before = process.env.CONTEXTBOX_DEV
  if (dev) process.env.CONTEXTBOX_DEV = '1'
  else delete process.env.CONTEXTBOX_DEV
  // DEV 是在模組載入時讀的，所以每一種模式要一份自己的模組
  const mod = await import('../core/server.ts?dev=' + (dev ? '1' : '0'))
  if (before === undefined) delete process.env.CONTEXTBOX_DEV
  else process.env.CONTEXTBOX_DEV = before

  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-devreload-')))
  const dl = join(dir, 'Downloads')
  mkdirSync(dl)
  writeFileSync(join(dl, 'a.txt'), 'x'.repeat(200))
  const S = mod.start({
    port: 0, db: join(dir, 'data.db'), token: TOKEN, roots: [dl],
    quarantine: join(dir, 'q'), maxBytes: 1 << 20, readonly: false,
  })
  const port = await S.ready
  t.after(() => {
    S.server.closeAllConnections(); S.server.close(); S.server.unref()
    try { S.facts?.db?.close() } catch { /* 已經關了 */ }
    rmTmp(dir)
  })
  const health = async () => {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-contextbox-token': TOKEN } })
    return r.json()
  }
  return { health, dir }
}

describe('開發模式的素材版本', () => {
  // **預設不可以有任何行為改變。** 面板會照這個欄位自己重新整理，
  // 而一般使用者清到一半被重新整理，等於勾選白做。
  test('沒有 CONTEXTBOX_DEV → /health 一個 dev 欄位都沒有', async t => {
    const s = await serve(t, { dev: false })
    const h = await s.health()
    assert.equal(h.dev, undefined, JSON.stringify(h.dev))
    assert.equal(h.ok, true)
  })

  test('CONTEXTBOX_DEV=1 → 有 dev.assets 與 dev.serverStale', async t => {
    const s = await serve(t, { dev: true })
    const h = await s.health()
    assert.equal(typeof h.dev?.assets, 'string')
    assert.ok(h.dev.assets.length > 0)
    assert.equal(h.dev.serverStale, false, '剛開機不可能是舊的')
  })

  // 面板就是靠這個數字變了才重新整理。不變的話它會一直重新整理（或永遠不重新整理）。
  test('**素材沒動，版本號就不可以變**', async t => {
    const s = await serve(t, { dev: true })
    const a = (await s.health()).dev.assets
    const b = (await s.health()).dev.assets
    assert.equal(a, b)
  })

  test('**改了送到瀏覽器的檔，版本號就要變**', async t => {
    const s = await serve(t, { dev: true })
    const before = (await s.health()).dev.assets
    // 面板自己那一支。時間往後撥，不改內容 —— 這裡測的是「看得見改動」，不是內容。
    const at = new Date(Date.now() + 5000)
    utimesSync(new URL('../core/assets/cleanup-demo.js', import.meta.url), at, at)
    const after = (await s.health()).dev.assets
    assert.notEqual(after, before)
  })

  // **前端救不了這一種**：Node 已經把 core/*.ts 載進記憶體了。
  test('改了 core 的 .ts → serverStale 變 true（那是「重開 pet」，不是重新整理）', async t => {
    const s = await serve(t, { dev: true })
    assert.equal((await s.health()).dev.serverStale, false)
    const at = new Date(Date.now() + 5000)
    utimesSync(new URL('../core/filing.ts', import.meta.url), at, at)
    assert.equal((await s.health()).dev.serverStale, true)
  })
})
