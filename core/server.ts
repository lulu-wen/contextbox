/**
 * 本機 server —— 擴充套件唯一的對話對象。
 *
 * 安全前提：這支 server 手上有你全部的個人資料，而**任何一個網頁都能
 * fetch('http://127.0.0.1:7391/...')**。所以三道鎖：
 *   1. 只綁 127.0.0.1，外面連不進來
 *   2. 一定要帶 token。token 存在 ~/.contextbox/token，第一次用貼進擴充套件
 *   3. Origin 是 http(s):// 的一律拒絕 —— 那代表請求來自網頁，不是擴充套件
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { open, DEFAULT_DB } from './db.ts'
import { Facts } from './facts.ts'

export const TOKEN_PATH = process.env.CONTEXTBOX_TOKEN_PATH
  ?? `${homedir()}/.contextbox/token`

/** 第一次跑就生一把，只有自己讀得到 */
export function loadToken(path = TOKEN_PATH): string {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, randomBytes(24).toString('base64url'), { mode: 0o600 })
    chmodSync(path, 0o600)
  }
  return readFileSync(path, 'utf8').trim()
}

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function start(opts: { port?: number; db?: string; token?: string } = {}) {
  const port = opts.port ?? 7391
  const token = opts.token ?? loadToken()
  const F = new Facts(open(opts.db ?? DEFAULT_DB))

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const origin = req.headers.origin ?? ''

    const send = (code: number, body: unknown) => {
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': origin.startsWith('chrome-extension://') ? origin : 'null',
        'access-control-allow-headers': 'content-type, x-contextbox-token',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(body))
    }

    if (req.method === 'OPTIONS') return send(204, {})

    // 鎖 3：網頁來的一律擋。擴充套件的 origin 是 chrome-extension://
    if (/^https?:\/\//.test(origin)) {
      return send(403, { error: '網頁不能直接讀事實庫' })
    }
    if (url.pathname === '/health') {
      return send(200, { ok: true, facts: F.list('confirmed').length })
    }
    // 鎖 2：其他全部要 token
    if (!sameToken(String(req.headers['x-contextbox-token'] ?? ''), token)) {
      return send(401, { error: 'token 不對。在擴充套件設定裡貼上 ~/.contextbox/token 的內容。' })
    }

    const body = req.method === 'POST'
      ? await new Promise<any>(r => {
          let s = ''
          req.on('data', c => { s += c; if (s.length > 1e6) req.destroy() })
          req.on('end', () => { try { r(JSON.parse(s || '{}')) } catch { r({}) } })
        })
      : {}

    try {
      // 擴充套件掃到一堆欄位，問這些該怎麼填
      if (url.pathname === '/form/plan' && req.method === 'POST') {
        return send(200, { plan: F.forForm(body.keys ?? []) })
      }
      if (url.pathname === '/facts' && req.method === 'GET') {
        return send(200, { facts: F.list((url.searchParams.get('status') as any) ?? 'confirmed') })
      }
      if (url.pathname === '/facts' && req.method === 'POST') {
        return send(200, { fact: F.manual(body.key, body.value) })
      }
      const m = url.pathname.match(/^\/facts\/([\w-]+)\/(confirm|reject)$/)
      if (m && req.method === 'POST') {
        return send(200, { fact: m[2] === 'confirm' ? F.confirm(m[1]) : F.reject(m[1]) })
      }
      if (url.pathname === '/undo' && req.method === 'POST') {
        return send(200, { undone: F.undoLast(body.n ?? 1) })
      }
      send(404, { error: '沒有這個路徑' })
    } catch (e: any) {
      send(400, { error: e.message })
    }
  })

  // 鎖 1：只綁 loopback
  // listen 是非同步的，address() 要等 'listening' 才有值
  const ready = new Promise<number>(resolve =>
    server.listen(port, '127.0.0.1', () => {
      const a = server.address()
      resolve(typeof a === 'object' && a ? a.port : port)
    }))
  return { server, token, port, ready, facts: F }
}

if (process.argv[1]?.endsWith('server.ts')) {
  const { ready, token } = start()
  const port = await ready
  console.log(`ContextBox 在 http://127.0.0.1:${port}`)
  console.log(`token：${token}`)
  console.log(`（也存在 ${TOKEN_PATH}，貼進擴充套件設定）`)
}
