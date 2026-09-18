/**
 * 本機 server —— 擴充套件與手填頁面唯一的對話對象。
 *
 * 安全前提：這支 server 手上有你全部的個人資料，而**任何一個網頁都能
 * fetch('http://127.0.0.1:7391/...')**。所以三道鎖：
 *   1. 只綁 127.0.0.1，外面連不進來
 *   2. 一定要帶 token。token 存在 ~/.contextbox/token
 *   3. 來源白名單。只放行三種 Origin：
 *        - 空的（本機 CLI；瀏覽器直接開網址時也不帶 Origin）
 *        - chrome-extension://…（擴充套件）
 *        - server 自己這一個 port 的 loopback 位址（手填頁面自己發的請求）
 *      其他一律 403 —— 網頁、sandbox iframe（它的 Origin 是字串 null）、
 *      大小寫變形的 HTTPS，全部包含在內。
 *
 * 為什麼鎖 3 要用白名單不用黑名單：手填頁面（GET /）會把 token 直接印在
 * 回傳的 HTML 裡，所以那一條路徑不可能再檢查 token，鎖 3 是它唯一的守門員。
 * 黑名單放得過去的東西（Origin: null、HTTPS://…）就等於放行去讀 token。
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { open, DEFAULT_DB } from './db.ts'
import { Facts } from './facts.ts'
import { FACT_KEYS, SCHEMA_VERSION, fillModeOf } from '../schema/factKeys.ts'
import { cleanupRoutes, healthSnapshot } from './cleanup-routes.ts'
import { scanDownloads } from './cleanup-scanner.ts'
import { load as loadConfig } from './config.ts'
import { join } from 'node:path'
import { initDemoHistory, demoHistoryRoutes } from './cleanup-demo-history.ts'

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

/** 手填頁面。跟這支放在同一個資料夾，每次請求才讀，改完不用重開 server。 */
const UI_PATH = new URL('./ui.html', import.meta.url)

// 只提供明列的公開素材，不將 URL 拼成本機檔案路徑。
const PET_ASSETS = new Map([
  ['/assets/quaso_v8.glb', ['assets/quaso_v8.glb', 'model/gltf-binary']],
  ['/assets/pet-viewer.js', ['assets/pet-viewer.js', 'text/javascript; charset=utf-8']],
  ['/assets/cleanup-demo.js', ['assets/cleanup-demo.js', 'text/javascript; charset=utf-8']],
  ['/assets/cleanup-demo-state.js', ['assets/cleanup-demo-state.js', 'text/javascript; charset=utf-8']],
  ['/assets/cleanup-real-state.js', ['assets/cleanup-real-state.js', 'text/javascript; charset=utf-8']],
  ['/assets/demo-candidates.json', ['assets/demo-candidates.json', 'application/json; charset=utf-8']],
  ...['three.module.js', 'three.core.js', 'GLTFLoader.js', 'BufferGeometryUtils.js'].map(name =>
    [`/assets/vendor/${name}`, [`assets/vendor/${name}`, 'text/javascript; charset=utf-8']]),
] as [string, [string, string]][])

/**
 * 把 token 直接塞進頁面，使用者就不用自己去複製那一串。
 * JSON.stringify 會連引號一起產生合法的 JS 字面值，再把 < 換成跳脫寫法，
 * 這樣就算 token 裡有奇怪的字元也跳不出 <script>。
 */
function uiHtml(token: string): string {
  return readFileSync(UI_PATH, 'utf8')
    .replaceAll('__TOKEN__', JSON.stringify(token).replace(/</g, '\\u003c'))
}

export function start(opts: {
  port?: number; db?: string; token?: string; roots?: string[]; quarantine?: string
  /** 給了就不讀設定檔。測試一定要給 —— 不然一次 apply 就會去讀（甚至建立）使用者真的設定檔。 */
  maxBytes?: number; readonly?: boolean
} = {}) {
  const port = opts.port ?? 7391
  const token = opts.token ?? loadToken()
  const F = new Facts(open(opts.db ?? DEFAULT_DB))
  initDemoHistory(F.db)

  // 清理那條線要看哪些資料夾、隔離區放哪。
  //
  // **呼叫端沒給就不要自己去讀使用者的設定檔。** 稽查抓到：
  // `start({ db: ':memory:' })` 這種明顯是測試的呼叫，cleanupRoots 還是綁到
  // 使用者真的 Downloads，/health 會走訪使用者真的隔離區，而
  // POST /cleanup/scan 那條線已經接好了 —— 任何人加一條測試就會對
  // 真的 Downloads 做一次含 sha256 的全量掃描。而且 loadConfig() 會
  // 在沒有設定檔的機器上「建立」一個，測試因此有副作用。
  //
  // 所以：只有兩個都沒給的時候才讀設定，而且是**延後到真的用到才讀**。
  let cfgCache: ReturnType<typeof loadConfig> | null = null
  const cfg = () => (cfgCache ??= loadConfig()).config
  const cleanupRoots = opts.roots ?? null
  const roots = () => cleanupRoots ?? cfg().watch
  const QUARANTINE = opts.quarantine
    ?? process.env.CONTEXTBOX_QUARANTINE
    ?? join(homedir(), '.contextbox', 'quarantine')

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const origin = req.headers.origin ?? ''

    // 只有 server 自己那一個 port 算自己人。
    // 不能寫死 opts.port —— 測試用 listen(0)，真正的 port 要跟 server 要。
    const boundPort = () => {
      const a = server.address()
      return typeof a === 'object' && a ? a.port : port
    }
    const isSelf = (o: string) => {
      const p = boundPort()
      return o === `http://127.0.0.1:${p}` || o === `http://localhost:${p}`
    }
    const allowed = origin === ''
      || origin.startsWith('chrome-extension://')
      || isSelf(origin)

    /**
     * 鎖 0：Host header 必須是我們自己。
     *
     * 只看 Origin 擋不住 DNS rebinding：攻擊者把 evil.com 解析到 127.0.0.1，
     * 使用者開 http://evil.com:7391/ 時，那一頁就跟我們「同源」——
     * 同源的導覽與 GET 本來就不帶 Origin，所以前面那一關會放行，
     * 接著他讀得到 HTML 裡的 token，再把整個事實庫撈走。
     * Host 一定是網址列上那個 authority，所以擋這裡就擋掉了，
     * 而且不影響任何正常用法。
     */
    const host = String(req.headers.host ?? '').toLowerCase()
    const okHost = host === `127.0.0.1:${boundPort()}` || host === `localhost:${boundPort()}`
    if (!okHost) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({
        error: '只接受 127.0.0.1 或 localhost 這兩個名字。別的網域指到這台也不行。',
      }))
    }

    const baseHeaders = () => {
      const h: Record<string, string> = {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        vary: 'Origin',
      }
      // 只有放行的來源才給 CORS header。不合格的一個都不給——
      // 以前一律回 access-control-allow-origin: null，那剛好對得上
      // sandbox iframe 的來源，等於幫忙開門。
      if (origin && allowed) {
        h['access-control-allow-origin'] = origin
        h['access-control-allow-headers'] = 'content-type, x-contextbox-token'
        h['access-control-allow-methods'] = 'GET, POST, OPTIONS'
      }
      return h
    }

    const send = (code: number, body: unknown) => {
      res.writeHead(code, { ...baseHeaders(), 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }

    // 鎖 3：先擋來源，預檢也要過這一關
    if (!allowed) {
      return send(403, { error: '網頁不能直接讀事實庫' })
    }
    if (req.method === 'OPTIONS') return send(204, {})

    if (url.pathname.startsWith('/assets/')) {
      const asset = PET_ASSETS.get(url.pathname)
      if (!asset) return send(404, { error: '找不到素材' })
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: '素材只供讀取' })
      try {
        const data = readFileSync(new URL(asset[0], import.meta.url))
        res.writeHead(200, { ...baseHeaders(), 'content-type': asset[1],
          'content-length': data.length, 'x-content-type-options': 'nosniff',
          'cross-origin-resource-policy': 'same-origin' })
        res.end(req.method === 'HEAD' ? undefined : data)
      } catch { send(404, { error: '找不到素材' }) }
      return
    }

    // 手填頁面。它自己帶 token，所以這一條不能要求 token。
    if (url.pathname === '/' && req.method === 'GET') {
      // 瀏覽器直接開網址是 document；網頁用 fetch 或 iframe 來拿的一律不給
      const dest = String(req.headers['sec-fetch-dest'] ?? '')
      if (dest && dest !== 'document') {
        return send(403, { error: '這一頁只能用瀏覽器直接開' })
      }
      let html: string
      try { html = uiHtml(token) }
      catch { return send(500, { error: '找不到 core/ui.html' }) }
      res.writeHead(200, {
        ...baseHeaders(),
        'content-type': 'text/html; charset=utf-8',
        // 這一頁只准跟自己講話：token 印在裡面，連 img 都不准往外連
        'content-security-policy':
          "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; "
          + "connect-src 'self' blob:; img-src data: blob:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      })
      res.end(html)
      return
    }

    if (url.pathname === '/health') {
      if (req.method !== 'GET') return send(405, { error: '這個路徑只收 GET', code: 'BAD_METHOD' })
      // **這條在 token 檢查之前，所以它是唯一沒有錯誤處理的路徑。**
      // 不包起來的話，healthSnapshot 丟例外會變成 unhandled error ——
      // 整個行程死掉、離開碼 1、client 的連線永遠掛著。
      // 一個要在系統匣待整天的常駐程式，不可以這樣死。
      //
      // 而且健康檢查失敗**本身就是健康狀態**，不該回 500。
      const hasToken = sameToken(String(req.headers['x-contextbox-token'] ?? ''), token)
      try {
        return send(200, {
          ...healthSnapshot(F.db, { roots: roots, quarantine: QUARANTINE, full: hasToken }),
          // facts 是純計數，沒有路徑也沒有名字，跟 pendingCandidates 同級。
          // 把它移到 token 後面會打壞 extension/background.js —— 它不帶 token
          // 讀 r.data.facts，會靜靜變成永遠 0。
          facts: F.list('confirmed').length,
        })
      } catch (e: any) {
        console.error('[contextbox] /health 自我檢查失敗：', (e && e.message) || e)
        return send(200, { ok: false, db: { ok: false }, why: '後端自我檢查失敗' })
      }
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
      if (demoHistoryRoutes(F.db, url, req.method ?? 'GET', body, send)) return
      // 清理那條線的 route。認得就處理完回 true，不認得回 false 讓下面接手。
      if (cleanupRoutes({
        // **這些都要是 thunk。** 上一版 `maxBytes: cfg().maxBytes` 是每個請求
        // 立刻求值，連 /facts 這種跟清理無關的路徑都會去讀（甚至建立）
        // 使用者的設定檔 —— 延後讀取的修正等於沒做。
        db: F.db, roots, quarantine: QUARANTINE,
        // 會動檔案的 route 才需要這兩個，一樣用 thunk —— 唯讀的路徑不該去碰設定檔。
        maxBytes: () => opts.maxBytes ?? cfg().maxBytes,
        readonly: () => opts.readonly ?? cfg().readonly,
        url, method: req.method ?? 'GET', body, send,
        scan: () => scanDownloads({ db: F.db, roots: roots(), maxBytes: opts.maxBytes ?? cfg().maxBytes }),
      })) return

      // key 註冊表。手填頁面靠這個長出 75 個欄位，不用自己抄一份。
      if (url.pathname === '/schema' && req.method === 'GET') {
        return send(200, {
          version: SCHEMA_VERSION,
          keys: FACT_KEYS.map(d => ({ ...d, fill: fillModeOf(d) })),
        })
      }
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
  // listen 失敗（port 被佔）要讓 await ready 拿到例外。
  // 不掛 'error' 監聽器的話 Node 會丟 unhandled 'error' event，
  // 使用者第二次開 pet 看到的是一坨堆疊而不是「已經有一個在跑了」。
  const ready = new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const a = server.address()
      resolve(typeof a === 'object' && a ? a.port : port)
    })
  })
  return { server, token, port, ready, facts: F }
}

if (process.argv[1]?.endsWith('server.ts')) {
  const { ready, token } = start()
  const port = await ready
  console.log(`ContextBox 在 http://127.0.0.1:${port}`)
  console.log(`手填頁面：http://127.0.0.1:${port}/　（token 已經幫你帶好，直接開就能用）`)
  console.log(`token：${token}`)
  console.log(`（也存在 ${TOKEN_PATH}，貼進擴充套件設定）`)
}
