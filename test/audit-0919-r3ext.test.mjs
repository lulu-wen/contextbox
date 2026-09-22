/**
 * 2026-09-19 稽核第三輪・擴充套件（R3-7）。
 *
 * R3-7：擴充套件照樣把 token 交給佔住那個埠的任何程式（違反不變量 11）。
 * CLI 已經先驗證（`petUp`：帶 nonce 問免 token 的 /health，比對 proof ＝
 * HMAC-SHA256(token, `${port}:${nonce}`)）；擴充套件這條同樣「交鑰匙」的路徑沒接上。
 *
 * 打法：用 node:vm 跑**真的** extension/background.js（一個字都沒改），
 * chrome.* 與 fetch 用假的。fetch 把每一次請求（路徑、nonce、有沒有帶 token）記下來，
 * 所以「有沒有把鑰匙交出去」是直接看得到的，不是推論的。
 * proof 的期望值用 node:crypto 的 createHmac 另外算一次 —— 跟 background.js 的
 * Web Crypto 實作互相對照，兩邊都錯成同一個樣子的機率極低。
 *
 * ── 動手前寫下的易錯點（build-round Step 1）─────────────────────────────
 *
 * | 段落 | 可能的錯誤 | 另一種合理解讀 | 能分辨兩者的例子（成對） | 認定的答案 |
 * |---|---|---|---|---|
 * | 什麼時候驗 | 只在 open-home 驗（那裡才開分頁） | 每一個帶 token 的請求之前都驗 | 冒牌 + plan／reveal／open-home 三種訊息 | 三種都不可以送出 x-contextbox-token |
 * | proof 怎麼算 | 只算 nonce | 算 `${port}:${nonce}` | 冒牌把 nonce 轉給另一個埠上的真 pet，原樣交回 proof | 拒絕（埠號綁在訊息裡，真 pet 算的是別的埠） |
 * | 沒有 proof 欄位 | 當成「舊版 pet」放行 | 一律拒絕 | 冒牌回形狀正確、沒有 proof 的 /health | 拒絕、不送 token |
 * | 比對方式 | `===`（時間會洩漏） | 固定時間、長度不同直接 false | 對的 proof／少一個字元／多一個字元／全大寫 | 只有一模一樣才 true |
 * | 快取 | 一驗永遠有效，或整個行程共用一份 | 綁 port＋token、30 秒 | 同 port 同 token 連兩次／換 port／換 token／時鐘往回跳 | 第一種只驗一次；其餘一定重驗 |
 * | 驗不過的錯誤 | 回 BAD_TOKEN（「token 不對」誤導） | 分「不是 ContextBox」與「證明不了」 | 回應形狀不像 health／形狀像但 proof 不對 | NOT_CONTEXTBOX／UNPROVEN，訊息都不含 token |
 * | 空的 plan | 照樣打一次網路 | keys 是空的就直接回，不交鑰匙 | { type:'plan', keys: [] } | 一個請求都不送 |
 * | 連不上 | 說成「不是 ContextBox」 | 照實回 OFFLINE／TIMEOUT | fetch 丟例外 | OFFLINE，不是 NOT_CONTEXTBOX |
 */
import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
import { rmTmp } from './helpers/rm.mjs'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'
import vm from 'node:vm'
import { start, healthProof } from '../core/server.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const BG = readFileSync(join(REPO, 'extension/background.js'), 'utf8')
const TOKEN = 'r3-ext-token-0123456789'
const realFetch = globalThis.fetch

/** 免 token 的 /health 回的形狀（照 core/server.ts 的 healthSnapshot＋facts） */
const HEALTH = () => ({
  ok: true,
  version: '0.1.0',
  db: { ok: true },
  watcher: { ok: true, watching: [], watchingCount: 1, rootsMissing: 0, why: null },
  quarantine: { items: 0, bytes: 0, canEmptyNow: false, orphans: 0, truncated: false },
  pendingCandidates: 0,
  needsHumanCount: 0,
  lastError: null,
  facts: 12,
})

/** 期望的 proof，用 node:crypto 另外算一次（跟 core/server.ts 的 healthProof 同一支算法） */
const proofOf = (token, port, nonce) => createHmac('sha256', token).update(`${port}:${nonce}`).digest('hex')

/**
 * 假的網路。reply(u, init) 回 { status?, body? } 或 'offline'。
 * 每一次請求都記下來：路徑、埠、nonce、**有沒有帶 x-contextbox-token**。
 */
function fakeNet(reply) {
  const seen = []
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url))
    const headers = init.headers ?? {}
    seen.push({
      path: u.pathname,
      port: Number(u.port),
      nonce: u.searchParams.get('nonce'),
      method: init.method ?? 'GET',
      token: headers['x-contextbox-token'] ?? null,
      body: init.body ?? null,
    })
    const r = await reply(u, init)
    if (r === 'offline') throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200, headers: { 'content-type': 'application/json' },
    })
  }
  return { seen, fetchImpl, tokensSent: () => seen.filter(r => r.token !== null) }
}

/** 真的 pet：算得出 proof（手上有這把 token） */
const petReply = (token, port) => u => {
  if (u.pathname === '/health') {
    const nonce = u.searchParams.get('nonce')
    const body = HEALTH()
    if (nonce && /^[0-9a-f]{32}$/i.test(nonce)) body.proof = proofOf(token, port, nonce)
    return { body }
  }
  if (u.pathname === '/form/plan') return { body: { plan: [{ key: 'person.name.full', action: 'fill', value: '王小明' }] } }
  return { status: 404, body: { error: '找不到' } }
}

/** 冒牌一號：形狀對，但完全不回 proof（就是 tmp-C/impostor.mjs 的 target=0） */
const silentImpostor = () => u => {
  if (u.pathname === '/health') return { body: HEALTH() }
  return { body: { plan: [] } }        // 它很樂意收下你的 token
}

/** 冒牌二號：把 nonce 轉給另一個埠上的真 pet，proof 原樣交回（轉送攻擊） */
const forwardingImpostor = (token, realPort) => u => {
  if (u.pathname === '/health') {
    const nonce = u.searchParams.get('nonce')
    const body = HEALTH()
    if (nonce) body.proof = proofOf(token, realPort, nonce)   // 真 pet 算的是**它自己的**埠
    return { body }
  }
  return { body: { plan: [] } }
}

/** 冒牌三號：根本不是 ContextBox（形狀就不對） */
const junkImpostor = () => () => ({ body: { hello: 'world' } })

/**
 * 跑真的 background.js。回 { send, created, exports, seen }。
 * exports 是把幾支內部函式從 vm 裡拿出來（在原始碼後面接一個運算式，
 * runInNewContext 會回它的值）—— 正式程式碼裡不用留任何測試用的掛勾。
 */
const EXPOSE = '\n;({ verifyPort, provenFrom, healthProofHex, sameHex, newNonce, stillProven, PROVEN_MS })'
function loadBg({ token = TOKEN, port = 7391, fetchImpl = realFetch, cfg = null } = {}) {
  const listeners = [], created = []
  const store = cfg ?? { token, port }
  const chrome = {
    storage: { local: { get: async d => ({ ...d, ...store }) } },
    runtime: { onMessage: { addListener: f => listeners.push(f) }, onInstalled: { addListener() {} }, openOptionsPage() {} },
    tabs: { create: async o => { created.push(o); return { id: 1 } } },
  }
  const exports = vm.runInNewContext(BG + EXPOSE, {
    chrome, fetch: fetchImpl, AbortSignal, console, URL, encodeURIComponent,
    crypto: globalThis.crypto, TextEncoder, Response,
  })
  const send = msg => new Promise(resolve => {
    const keep = listeners[0](msg, { id: 'ext', origin: 'https://jobs.example.com', tab: { id: 9 } }, resolve)
    if (keep !== true) resolve(undefined)
  })
  return { send, created, exports }
}

// ═══ R3-7 ・ 交鑰匙之前先要對方證明手上有這把鑰匙 ═══════════════════

describe('R3-7 擴充套件：送出任何帶 token 的請求之前先驗 proof', () => {
  test('healthProofHex 跟 core/server.ts 的 healthProof 算出同一個字串（Web Crypto vs node:crypto）', async () => {
    const { exports } = loadBg({})
    const cases = [
      ['r3-ext-token-0123456789', 7391, 'a'.repeat(32)],
      ['a+b/c=', 1, '0123456789abcdef0123456789abcdef'],
      ['很長的中文鑰匙也要算得出來', 65535, 'ffffffffffffffffffffffffffffffff'],
    ]
    for (const [tok, port, nonce] of cases) {
      const got = await exports.healthProofHex(tok, port, nonce)
      assert.equal(got, proofOf(tok, port, nonce), `${tok}/${port}`)
      assert.equal(got, healthProof(tok, port, nonce), 'server.ts 的 healthProof 也要一樣')
      assert.match(got, /^[0-9a-f]{64}$/)
    }
  })

  test('nonce 是 32 個 hex，而且每次都不一樣', () => {
    const { exports } = loadBg({})
    const seen = new Set()
    for (let i = 0; i < 50; i++) {
      const n = exports.newNonce()
      assert.match(n, /^[0-9a-f]{32}$/, n)
      seen.add(n)
    }
    assert.equal(seen.size, 50, 'nonce 重複了')
  })

  test('sameHex 是固定時間比對：長度不同、差一個字元、大小寫不同都是 false', () => {
    const { exports } = loadBg({})
    const a = 'abcdef0123456789'.repeat(4)
    assert.equal(exports.sameHex(a, a), true)
    assert.equal(exports.sameHex(a, a.slice(0, -1)), false, '少一個字元')
    assert.equal(exports.sameHex(a, a + '0'), false, '多一個字元')
    assert.equal(exports.sameHex(a, a.slice(0, -1) + '0'), false, '差最後一個字元')
    assert.equal(exports.sameHex('0' + a.slice(1), a), false, '差第一個字元')
    assert.equal(exports.sameHex(a.toUpperCase(), a), false, '大小寫不同不算對')
    assert.equal(exports.sameHex(undefined, a), false)
    assert.equal(exports.sameHex(null, null), false, '兩邊都沒有也不算對')
    assert.equal(exports.sameHex('', ''), false, '兩邊都是空字串也不算對')
  })

  test('**真 pet：plan 會送出 token，而且第一個請求是不帶 token 的 /health?nonce=**', async () => {
    const port = 7391
    const net = fakeNet(petReply(TOKEN, port))
    const bg = loadBg({ port, fetchImpl: net.fetchImpl })
    const r = await bg.send({ type: 'plan', keys: ['person.name.full'] })
    assert.equal(r?.ok, true, JSON.stringify(r))
    assert.equal(r.plan.length, 1)
    const [first, second] = net.seen
    assert.equal(first.path, '/health')
    assert.equal(first.token, null, '問「你是誰」的時候不可以帶 token')
    assert.match(first.nonce, /^[0-9a-f]{32}$/)
    assert.equal(second.path, '/form/plan')
    assert.equal(second.token, TOKEN, '證明過了才交鑰匙')
  })

  test('**冒牌（完全不回 proof）：plan 一個 token 都不送、回清楚的錯**', async () => {
    const net = fakeNet(silentImpostor())
    const bg = loadBg({ port: 7391, fetchImpl: net.fetchImpl })
    const r = await bg.send({ type: 'plan', keys: ['person.name.full'] })
    assert.equal(r?.ok, false, JSON.stringify(r))
    assert.equal(r.error, 'UNPROVEN', JSON.stringify(r))
    assert.deepEqual(net.tokensSent(), [], '不可以把 token 交給它')
    assert.deepEqual(net.seen.map(x => x.path), ['/health'], '驗不過就不該再送任何請求')
    assert.ok(!JSON.stringify(r).includes(TOKEN), '錯誤訊息會到網頁那一側，不可以帶 token')
    assert.match(r.message, /127\.0\.0\.1:7391/)
    assert.ok(/鑰匙/.test(r.message), r.message)
  })

  test('**冒牌（把 nonce 轉給別的埠上的真 pet）：proof 綁了埠號，照樣拒絕**', async () => {
    const REAL = 8123, FAKE = 7391
    const net = fakeNet(forwardingImpostor(TOKEN, REAL))
    const bg = loadBg({ port: FAKE, fetchImpl: net.fetchImpl })
    const r = await bg.send({ type: 'plan', keys: ['person.name.full'] })
    assert.equal(r?.ok, false, JSON.stringify(r))
    assert.equal(r.error, 'UNPROVEN')
    assert.deepEqual(net.tokensSent(), [], '轉送回來的 proof 不算證明')
  })

  test('**冒牌（形狀就不是 ContextBox）：回 NOT_CONTEXTBOX、不送 token**', async () => {
    const net = fakeNet(junkImpostor())
    const bg = loadBg({ port: 7391, fetchImpl: net.fetchImpl })
    const r = await bg.send({ type: 'plan', keys: ['person.name.full'] })
    assert.equal(r?.ok, false, JSON.stringify(r))
    assert.equal(r.error, 'NOT_CONTEXTBOX', JSON.stringify(r))
    assert.deepEqual(net.tokensSent(), [])
  })

  test('**冒牌：open-home 不開分頁、不送 token**（這條會把 ?k=<token> 直接交出去）', async () => {
    const net = fakeNet(silentImpostor())
    const bg = loadBg({ port: 7391, fetchImpl: net.fetchImpl })
    const r = await bg.send({ type: 'open-home' })
    assert.equal(r?.ok, false, JSON.stringify(r))
    assert.equal(r.error, 'UNPROVEN')
    assert.equal(bg.created.length, 0, '不可以開帶 k 的分頁')
    assert.deepEqual(net.tokensSent(), [])
  })

  test('**冒牌：reveal 不送 token**（這條要的是敏感欄位的值）', async () => {
    const net = fakeNet(silentImpostor())
    const bg = loadBg({ port: 7391, fetchImpl: net.fetchImpl })
    const r = await bg.send({ type: 'reveal', key: 'identity.national_id' })
    assert.equal(r?.ok, false, JSON.stringify(r))
    assert.equal(r.error, 'UNPROVEN')
    assert.deepEqual(net.tokensSent(), [])
  })

  test('**冒牌：設定頁的「測試連線」也不交鑰匙**（tokenOk 是 false，訊息講得出原因）', async () => {
    const net = fakeNet(silentImpostor())
    const bg = loadBg({ port: 7391, fetchImpl: net.fetchImpl })
    const r = await bg.send({ type: 'check' })
    assert.equal(r?.ok, true, JSON.stringify(r))
    assert.equal(r.tokenSet, true)
    assert.equal(r.tokenOk, false, '證明不了的時候不可以說 token 沒問題')
    assert.ok(r.message && r.message.length > 10, JSON.stringify(r))
    assert.deepEqual(net.tokensSent(), [])
  })

  test('對照：真 pet 的「測試連線」回 tokenOk: true', async () => {
    const port = 7391
    const net = fakeNet(petReply(TOKEN, port))
    const bg = loadBg({ port, fetchImpl: net.fetchImpl })
    const r = await bg.send({ type: 'check' })
    assert.equal(r?.ok, true, JSON.stringify(r))
    assert.equal(r.tokenOk, true, JSON.stringify(r))
    assert.equal(r.facts, 12)
  })

  test('連不上：回 OFFLINE（不是「不是 ContextBox」），也不送 token', async () => {
    const net = fakeNet(() => 'offline')
    const bg = loadBg({ port: 7391, fetchImpl: net.fetchImpl })
    const r = await bg.send({ type: 'plan', keys: ['person.name.full'] })
    assert.equal(r?.ok, false)
    assert.equal(r.error, 'OFFLINE', JSON.stringify(r))
    assert.deepEqual(net.tokensSent(), [])
  })

  test('keys 是空的：一個請求都不送（沒有東西要問，就不用交鑰匙）', async () => {
    const net = fakeNet(silentImpostor())
    const bg = loadBg({ port: 7391, fetchImpl: net.fetchImpl })
    const r = await bg.send({ type: 'plan', keys: [] })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.plan.length, 0)
    assert.deepEqual(net.seen, [])
  })

  test('還沒設定 token：不驗、也不送任何請求', async () => {
    const net = fakeNet(silentImpostor())
    const bg = loadBg({ token: '', port: 7391, fetchImpl: net.fetchImpl })
    const r = await bg.send({ type: 'plan', keys: ['person.name.full'] })
    assert.equal(r.error, 'NO_TOKEN')
    assert.deepEqual(net.seen, [])
  })
})

describe('R3-7 驗過的結果可以快取一小段時間，但換 port／換 token 一定重驗', () => {
  const healthCalls = net => net.seen.filter(r => r.path === '/health').length

  test('同一個 port＋同一把 token 連問兩次 → 只驗一次', async () => {
    const port = 7391
    const net = fakeNet(petReply(TOKEN, port))
    const bg = loadBg({ port, fetchImpl: net.fetchImpl })
    await bg.send({ type: 'plan', keys: ['a'] })
    await bg.send({ type: 'plan', keys: ['b'] })
    assert.equal(healthCalls(net), 1, '第二次不用再驗')
    assert.equal(net.seen.filter(r => r.path === '/form/plan').length, 2)
  })

  test('**同一個 worker 換一個 port 一定重驗**（新的 port 上可能是別人）', async () => {
    // 兩個 port 都用同一支假網路：7391 是真 pet、7392 是冒牌。
    // cfg 是使用者在設定頁改的那份設定 —— 同一個 worker、同一份快取。
    const cfg = { token: TOKEN, port: 7391 }
    const net = fakeNet(u => (Number(u.port) === 7391 ? petReply(TOKEN, 7391)(u) : silentImpostor()(u)))
    const bg = loadBg({ cfg, fetchImpl: net.fetchImpl })
    await bg.send({ type: 'plan', keys: ['a'] })
    assert.equal(net.tokensSent().length, 1, '前提：7391 驗過了、鑰匙交出去了')
    cfg.port = 7392
    const r = await bg.send({ type: 'plan', keys: ['a'] })
    assert.equal(r.ok, false, JSON.stringify(r))
    assert.deepEqual(net.seen.filter(x => x.port === 7392 && x.token !== null), [], '7392 上不可以交鑰匙')
    assert.ok(net.seen.some(x => x.port === 7392 && x.path === '/health'), '換 port 要重驗')
  })

  test('**同一個 worker 換一把 token 一定重驗**（使用者貼了新的鑰匙）', async () => {
    const cfg = { token: TOKEN, port: 7391 }
    const net = fakeNet(petReply(TOKEN, 7391))
    const bg = loadBg({ cfg, fetchImpl: net.fetchImpl })
    await bg.send({ type: 'plan', keys: ['a'] })
    assert.equal(net.seen.filter(x => x.path === '/health').length, 1)
    cfg.token = 'pasted-a-different-key'
    const r = await bg.send({ type: 'plan', keys: ['a'] })
    assert.equal(net.seen.filter(x => x.path === '/health').length, 2, '換 token 要重驗')
    assert.equal(r.ok, false, JSON.stringify(r))
    assert.deepEqual(net.seen.filter(x => x.token === 'pasted-a-different-key'), [], '新鑰匙驗不過就不可以送出去')
  })

  test('stillProven：綁 port＋token，30 秒，時鐘往回跳不算數', () => {
    const { exports } = loadBg({})
    assert.equal(exports.PROVEN_MS, 30_000)
    const mark = { port: 7391, token: TOKEN, at: 1_000_000 }
    assert.equal(exports.stillProven(mark, 7391, TOKEN, 1_000_000), true, '剛驗完')
    assert.equal(exports.stillProven(mark, 7391, TOKEN, 1_029_999), true, '29.999 秒還算數')
    assert.equal(exports.stillProven(mark, 7391, TOKEN, 1_030_000), false, '滿 30 秒就要重驗')
    assert.equal(exports.stillProven(mark, 7392, TOKEN, 1_000_000), false, '換 port 一定重驗')
    assert.equal(exports.stillProven(mark, 7391, TOKEN + 'x', 1_000_000), false, '換 token 一定重驗')
    assert.equal(exports.stillProven(mark, 7391, '', 1_000_000), false, '空 token 不算')
    assert.equal(exports.stillProven(mark, 7391, TOKEN, 999_999), false, '時鐘往回跳就重驗')
    assert.equal(exports.stillProven(null, 7391, TOKEN, 1_000_000), false, '還沒驗過')
  })

  test('provenFrom：proof 對才算過；少了 proof 欄位、型別不對、轉送別的埠都不算', async () => {
    const { exports } = loadBg({})
    const nonce = 'abcdef0123456789abcdef0123456789'
    const good = { ...HEALTH(), proof: proofOf(TOKEN, 7391, nonce) }
    assert.equal((await exports.provenFrom(good, 7391, TOKEN, nonce)).ok, true)
    for (const [what, body] of [
      ['沒有 proof 欄位', HEALTH()],
      ['proof 是 null', { ...HEALTH(), proof: null }],
      ['proof 是數字', { ...HEALTH(), proof: 123 }],
      ['proof 是空字串', { ...HEALTH(), proof: '' }],
      ['proof 算的是別的埠（轉送）', { ...HEALTH(), proof: proofOf(TOKEN, 8123, nonce) }],
      ['proof 算的是別的 nonce', { ...HEALTH(), proof: proofOf(TOKEN, 7391, 'f'.repeat(32)) }],
      ['proof 算的是別的 token', { ...HEALTH(), proof: proofOf('別把鑰匙', 7391, nonce) }],
    ]) {
      const r = await exports.provenFrom(body, 7391, TOKEN, nonce)
      assert.equal(r.ok, false, what)
      assert.equal(r.error, 'UNPROVEN', what)
    }
    const junk = await exports.provenFrom({ hello: 'world' }, 7391, TOKEN, nonce)
    assert.equal(junk.error, 'NOT_CONTEXTBOX', '形狀就不對 → 不是 ContextBox')
  })
})

describe('R3-7 不變量 11 的守門：帶 token 的請求只准從 planFor 出去', () => {
  test('background.js 裡只有 planFor 會把 token 交給 call()', () => {
    // call(path, { token, ... }) 是唯一會加 x-contextbox-token 的地方。
    // 只要 planFor 之外還有第二個呼叫端帶 token，驗證就被繞過去了。
    // 只看呼叫（`call(` 前面不是 `function `），不看 call() 自己的宣告；註解先拿掉
    const code = BG.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const calls = [...code.matchAll(/(?<!function )\bcall\(([^\n]*)\)/g)].map(m => m[0])
    const withToken = calls.filter(s => /\btoken\b/.test(s))
    assert.equal(withToken.length, 1,
      `帶 token 的 call() 有 ${withToken.length} 處（只准 planFor 一處）：\n${withToken.join('\n')}`)
    const planFor = /async function planFor\([\s\S]*?\n\}/.exec(BG)?.[0] ?? ''
    assert.ok(planFor.includes(withToken[0]), `那一處不在 planFor 裡：\n${planFor}`)
    assert.ok(/verifyPort\(/.test(planFor), 'planFor 一定要先 verifyPort 才送出去')
    assert.ok(planFor.indexOf('verifyPort(') < planFor.indexOf(withToken[0]), 'verifyPort 要排在送出之前')
  })

  test('content.js 顯示的是人話，不是錯誤代碼', () => {
    const CONTENT = readFileSync(join(REPO, 'extension/content.js'), 'utf8')
    const planOf = /function planOf\([\s\S]*?\n {2}\}/.exec(CONTENT)?.[0] ?? ''
    assert.ok(planOf, '找不到 content.js 的 planOf()')
    assert.ok(/r\.message\s*\|\|\s*r\.error/.test(planOf),
      `planOf 先拿 r.error 的話，畫面會印出「UNPROVEN」這種代碼：\n${planOf}`)
  })
})

// ═══ 真的 server：驗證通過的那一側不可以被擋下來 ════════════════════

describe('R3-7 對照組：真的 ContextBox server 照樣通', () => {
  async function realServer(t, token = TOKEN) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-r3ext-')))
    mkdirSync(join(dir, 'Downloads'))
    const S = start({
      port: 0, db: ':memory:', token, roots: [join(dir, 'Downloads')],
      quarantine: join(dir, 'q'), maxBytes: 1024 * 1024, readonly: false,
    })
    const port = await S.ready
    t.after(() => { globalThis.__cbStopPage?.(); S.server.closeAllConnections(); S.server.close(); S.server.unref(); try { S.facts?.db?.close() } catch { /* 已經關了 */ }; rmTmp(dir) })
    return port
  }

  test('真 server：open-home 驗得過，照樣開一個帶 k 的分頁（網址打得開）', async t => {
    const port = await realServer(t)
    const bg = loadBg({ port, fetchImpl: realFetch })
    const r = await bg.send({ type: 'open-home' })
    assert.equal(r?.ok, true, JSON.stringify(r))
    assert.equal(bg.created.length, 1)
    assert.equal(bg.created[0].url, `http://127.0.0.1:${port}/?k=${encodeURIComponent(TOKEN)}`)
    const page = await realFetch(bg.created[0].url, { headers: { 'sec-fetch-dest': 'document' } })
    assert.equal(page.status, 200)
  })

  test('真 server、但擴充套件存的 token 是舊的 → 驗不過（不是 401 才發現），不開分頁、不送 token', async t => {
    const port = await realServer(t)
    const bg = loadBg({ token: 'old-token-from-last-week', port, fetchImpl: realFetch })
    const r = await bg.send({ type: 'open-home' })
    assert.equal(r?.ok, false, JSON.stringify(r))
    assert.equal(r.error, 'UNPROVEN')
    assert.equal(bg.created.length, 0)
    // 這句會顯示在網頁那一側：不可以帶 token，而且要講得出兩種可能與出路
    assert.ok(!r.message.includes('old-token-from-last-week'), r.message)
    assert.match(r.message, /鑰匙過期/)
    assert.ok(r.message.includes('node cli.mjs open'), r.message)
  })
})

void FAKE_HOME
