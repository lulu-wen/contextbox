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
 * 回傳的 HTML 裡，所以那一條路徑不能用 header 驗 token（瀏覽器直接開網址不會帶）。
 * 黑名單放得過去的東西（Origin: null、HTTPS://…）就等於放行去讀 token。
 *
 * 鎖 3 擋得住網頁，擋不住**本機其他行程** —— 它們不帶 Origin，跟瀏覽器直接開網址
 * 長得一樣。這個 PR 之後 token 能搬檔、能刪檔，所以 GET / 另外要帶 `?k=<token>`
 * （server 印出來的網址、`node cli.mjs open` 會帶好），沒帶就 401（稽核 RC16）。
 */
import { createServer, type IncomingMessage } from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
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

/**
 * 第一次跑就生一把，只有自己讀得到。
 *
 * **檔案是空的（或只有空白）也要重新產生並寫回去。** 空字串不是一把鑰匙：
 * 上一版讀到 '' 就照用，而 '' 跟「沒帶 header」比對起來是相等的 ——
 * 同機任何行程不帶 token 就能搬檔、刪檔、拿到手填頁面（稽核第一波驗證）。
 */
export function loadToken(path = TOKEN_PATH): string {
  const existing = existsSync(path) ? readFileSync(path, 'utf8').trim() : ''
  if (existing) return existing
  mkdirSync(dirname(path), { recursive: true })
  const fresh = randomBytes(24).toString('base64url')
  writeFileSync(path, fresh, { mode: 0o600 })
  // writeFileSync 的 mode 只在「建立」時生效；覆寫一個 0644 的空檔要自己改回來
  chmodSync(path, 0o600)
  return fresh
}

/**
 * 常數時間比對 token。**空字串一律不算對** —— 就算兩邊都是空的。
 * token 不應該是空的（loadToken 會重新產生），這是第二道防線。
 */
export const sameToken = (a: string, b: string): boolean => {
  if (!a || !b) return false
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * `/health?nonce=<32 個 hex>` 回的 proof：HMAC-SHA256，key 是 token、訊息是 `${port}:${nonce}`，hex（第二輪 R2-9）。
 *
 * `open` 與第二個 `pet` 要確定那個埠上的真的是自己的 pet，才把帶鑰匙的網址交出去。
 * 形狀可以模仿、pid 會被重用（稽核 C-e5）；**算得出 proof 的只有手上有 token 的那一個**。
 * proof 不洩漏 token（HMAC 反推不回 key），所以免 token 的 /health 也回 —— 問的一方還不知道對方是誰，
 * 不可以先把 token 送過去。呼叫端自己產生 nonce（每次不同），拿同一支算一次來比。
 *
 * **埠號綁在訊息裡**：server 用自己**實際監聽**的埠，呼叫端用自己**要連**的那個埠。
 * 只算 nonce 的話，佔住 A 埠的冒牌可以把 nonce 轉給 B 埠上的真 pet，再把 proof 原封不動交回來（轉送攻擊）；
 * 綁了埠號，真 pet 算的是 B，呼叫端要的是 A，對不上。
 */
export function healthProof(token: string, port: number, nonce: string): string {
  return createHmac('sha256', token).update(`${port}:${nonce}`).digest('hex')
}

/** nonce 的格式：剛好 32 個 hex（16 bytes）。不對就不回 proof，也不報錯。 */
const NONCE = /^[0-9a-f]{32}$/i

/**
 * 資料庫整個不能用時，拿來組 /health 的替身：每一次查詢都丟例外。
 * healthSnapshot 每一段都包了 safe()，拿它算出來的就是「欄位齊全、ok 是 false」的那一份 ——
 * 不另外手寫第三種形狀（稽核 B-r5：以前 catch 路徑回 { ok, db, why }，CLI 把它判成「不是 ContextBox」）。
 */
const DEAD_DB = { prepare() { throw new Error('資料庫不能用') } } as unknown as DatabaseSync

/** 任何一段丟例外都退回預設值。泛型用函式宣告，箭頭會被當成 JSX。 */
function safe<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}

/**
 * 寵物與清理面板的網址，**帶鑰匙**（`?k=`）。server 自己印的、CLI 印的都要用這一支 ——
 * 不帶 k 的網址打開是 401。頁面載入後會用 history.replaceState 把 k 從網址列拿掉。
 */
export function uiUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?k=${encodeURIComponent(token)}`
}

/** POST body 的上限。超過回 413，不是直接斷線（斷線的話呼叫端分不出是網路還是自己送太多）。 */
const MAX_BODY = 1_000_000
/** 超過上限之後還願意讀掉（丟棄）多少，讀完才回 413；再多就真的斷線。 */
const MAX_DRAIN = 16 * MAX_BODY

/**
 * 讀 POST body。回 { tooLarge } 或 { text }；連線中途斷掉（或送太多被我們切斷）就 reject。
 *
 * 超過上限之後**繼續讀、但丟掉**，讀完才回 413 —— 一邊還在送就回應並關連線的話，
 * 呼叫端多半收到的是 ECONNRESET 而不是 413，又回到「分不出原因」。
 */
function readBody(req: IncomingMessage): Promise<{ tooLarge: true } | { tooLarge: false; text: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0, ended = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size <= MAX_BODY) chunks.push(c)
      else if (size > MAX_DRAIN) req.destroy()
    })
    req.on('end', () => {
      ended = true
      resolve(size > MAX_BODY ? { tooLarge: true } : { tooLarge: false, text: Buffer.concat(chunks).toString('utf8') })
    })
    req.on('close', () => { if (!ended) reject(new Error('連線在送完之前就斷了')) })
    req.on('error', reject)
  })
}

/**
 * server 自己（不是清理那條線）的路徑與方法。已知的路徑用錯方法回 405（RC24）。
 * 清理與寵物的路徑在 cleanup-routes.ts 的 KNOWN。
 */
const OWN_ROUTES: [RegExp, string[]][] = [
  [/^\/schema$/, ['GET']],
  [/^\/form\/plan$/, ['POST']],
  [/^\/facts$/, ['GET', 'POST']],
  [/^\/facts\/[\w-]+\/(?:confirm|reject)$/, ['POST']],
  [/^\/undo$/, ['POST']],
]

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
  ['/assets/pet-state.js', ['assets/pet-state.js', 'text/javascript; charset=utf-8']],
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
  /**
   * 復原（放回原位）用的範圍（第二輪 R2-4）。有給就用它；沒給就用 roots ∪ 設定的 watch ——
   * **但只在 server 自己讀了設定的時候**（roots／maxBytes／readonly 有一個沒給）。全部給了的呼叫端
   * （pet、測試）不為了它去讀設定檔：pet 要自己傳（cli.mjs 的 undoRoots()）。
   */
  restoreRoots?: string[]
  /** 截圖資料夾（config 的 cleanup.screenshotsDir）。沒給：roots 也沒給就用設定的，否則是 null。 */
  screenshotsDir?: string | null
} = {}) {
  const port = opts.port ?? 7391
  // 給了空的（或只有空白的）token 等於沒給：不可以用空 token 跑起來
  const token = opts.token && opts.token.trim() ? opts.token : loadToken()
  const F = new Facts(open(opts.db ?? DEFAULT_DB))
  initDemoHistory(F.db)

  // 清理那條線要看哪些資料夾、隔離區放哪。
  //
  // **呼叫端全部給了就不要去讀使用者的設定檔。** 稽查抓到：
  // `start({ db: ':memory:' })` 這種明顯是測試的呼叫，cleanupRoots 還是綁到
  // 使用者真的 Downloads，/health 會走訪使用者真的隔離區。測試一律全部給
  // （而且 test/helpers/isolate-home.mjs 把家目錄換掉了）。
  //
  // **有任何一個沒給，就在啟動的時候讀，不要延後到請求進來才讀**（稽核 RC16、C-M4）。
  // 延後讀的話，第一個觸發它的常常是免 token 的 /health —— 任何網頁用 <img src> 就能打 ——
  // 而 loadConfig() 在沒有設定檔的機器上會「建立」一個：一個外部請求讓我們寫檔。
  const needCfg = opts.roots === undefined || opts.maxBytes === undefined || opts.readonly === undefined
  const loaded = needCfg ? loadConfig() : null
  const cfg = () => loaded!.config
  // 清理只看 cleanup.roots（預設只有 Downloads），**不是**截圖功能的 watch（RC15）
  const cleanupRoots = opts.roots ?? cfg().cleanup.roots
  const roots = () => cleanupRoots
  // 放回原位的範圍：清理範圍 ∪ 截圖的 watch（R2-4）。RC15 之前舊版用 watch 清過，桌面的檔可能還在隔離區。
  // 不存在、含捷徑的資料夾由 route 在每次復原時略過（checkedPath），這裡只列。
  const restoreRootList = opts.restoreRoots
    ?? (loaded ? [...new Set([...cleanupRoots, ...cfg().watch])] : cleanupRoots)
  // 截圖資料夾只收截圖類（R2-8）。roots 是呼叫端給的，就只認呼叫端給的截圖資料夾
  const screenshotsDir = opts.screenshotsDir !== undefined ? opts.screenshotsDir
    : opts.roots === undefined ? cfg().cleanup.screenshotsDir : null
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

    const send = (code: number, body: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(code, { ...baseHeaders(), 'content-type': 'application/json; charset=utf-8', ...extra })
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
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(405, { error: '素材只供讀取。', code: 'BAD_METHOD' }, { allow: 'GET, HEAD' })
      }
      try {
        const data = readFileSync(new URL(asset[0], import.meta.url))
        res.writeHead(200, { ...baseHeaders(), 'content-type': asset[1],
          'content-length': data.length, 'x-content-type-options': 'nosniff',
          'cross-origin-resource-policy': 'same-origin' })
        res.end(req.method === 'HEAD' ? undefined : data)
      } catch { send(404, { error: '找不到素材' }) }
      return
    }

    // 手填頁面。瀏覽器直接開網址不會帶 header，所以這一條用網址上的 ?k= 驗 token。
    if (url.pathname === '/' && req.method === 'GET') {
      // 瀏覽器直接開網址是 document；網頁用 fetch 或 iframe 來拿的一律不給
      const dest = String(req.headers['sec-fetch-dest'] ?? '')
      if (dest && dest !== 'document') {
        return send(403, { error: '這一頁只能用瀏覽器直接開' })
      }
      // **沒帶對的 k 不給頁面** —— 頁面裡印著 token，而本機任何行程都能不帶 Origin 來拿（RC16）。
      // 回純文字：這是給人在瀏覽器分頁裡看的。
      if (!sameToken(url.searchParams.get('k') ?? '', token)) {
        res.writeHead(401, { ...baseHeaders(), 'content-type': 'text/plain; charset=utf-8' })
        return res.end('這個網址少了鑰匙。請用 `node cli.mjs open` 或 server 啟動時印出來的網址打開。\n')
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
      if (req.method !== 'GET') return send(405, { error: '這個路徑只收 GET。', code: 'BAD_METHOD' }, { allow: 'GET' })
      // **這條在 token 檢查之前，所以它是唯一沒有錯誤處理的路徑。**
      // 不包起來的話，healthSnapshot 丟例外會變成 unhandled error ——
      // 整個行程死掉、離開碼 1、client 的連線永遠掛著。
      // 一個要在系統匣待整天的常駐程式，不可以這樣死。
      //
      // 而且健康檢查失敗**本身就是健康狀態**，不該回 500。
      const hasToken = sameToken(String(req.headers['x-contextbox-token'] ?? ''), token)
      // proof：帶了格式正確的 nonce 才回（R2-9a）。免 token 也回 —— proof 不洩漏 token。
      // 埠號用自己實際監聽的那一個（listen(0) 的話不是 opts.port），綁住它才擋得掉轉送
      const nonce = url.searchParams.get('nonce')
      const proof = nonce !== null && NONCE.test(nonce) ? { proof: healthProof(token, boundPort(), nonce) } : {}
      const hopts = { roots, screenshotsDir, quarantine: QUARANTINE, full: hasToken }
      let snap
      try { snap = healthSnapshot(F.db, hopts) }
      catch (e: any) {
        console.error('[contextbox] /health 自我檢查失敗：', (e && e.message) || e)
        // **回應形狀永遠跟正常時一樣**（R2-11）：拿不能用的資料庫再算一次，每一段都退回預設值
        snap = healthSnapshot(DEAD_DB, { ...hopts, roots: [] })
      }
      // facts 是純計數，沒有路徑也沒有名字，跟 pendingCandidates 同級。
      // 把它移到 token 後面會打壞 extension/background.js —— 它不帶 token
      // 讀 r.data.facts，會靜靜變成永遠 0。
      // **一樣包起來**：facts 表壞掉時以前整個掉進 catch，回第三種形狀（稽核 B-r5）。
      // 讀不到就是 0，而且後端不算好的（ok false）—— 事實庫是這台後端的另一半。
      const facts = safe(() => F.list('confirmed').length, null)
      return send(200, {
        ...snap,
        ok: snap.ok && facts !== null,
        db: { ...snap.db, ok: snap.db.ok && facts !== null },
        facts: facts ?? 0,
        ...proof,
      })
    }
    // 鎖 2：其他全部要 token
    if (!sameToken(String(req.headers['x-contextbox-token'] ?? ''), token)) {
      return send(401, { error: 'token 不對。在擴充套件設定裡貼上 ~/.contextbox/token 的內容。' })
    }

    // 已知的路徑用錯方法回 405，不是掉到 404（RC24）
    const own = OWN_ROUTES.find(([re]) => re.test(url.pathname))
    if (own && !own[1].includes(req.method ?? '')) {
      return send(405, { error: `這個路徑只收 ${own[1].join('、')}。`, code: 'BAD_METHOD' }, { allow: own[1].join(', ') })
    }

    // **看不懂的 body 回 400，不可以當成 {}**（RC6）。
    // 上一版解析失敗就給 {}，而 POST /cleanup/plans 的 {} 是「清單上打 ✔ 的全部」——
    // 使用者只勾一個，client 送出的 JSON 多一個逗號，就變成全部清掉。
    // 空的 body 才是「什麼都沒帶」。body 必須是物件（null、陣列、字串都是看不懂）。
    let body: any = {}
    if (req.method === 'POST') {
      let got
      try { got = await readBody(req) }
      catch { return }   // 連線自己斷了，沒有人在等回應
      if (got.tooLarge) {
        return send(413, { error: '送來的資料太大（上限 1 MB）。', code: 'BODY_TOO_LARGE' }, { connection: 'close' })
      }
      if (got.text.trim()) {
        try { body = JSON.parse(got.text) }
        catch { return send(400, { error: '看不懂送來的資料。', code: 'BAD_BODY' }) }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return send(400, { error: '看不懂送來的資料。', code: 'BAD_BODY' })
        }
      }
    }

    try {
      if (demoHistoryRoutes(F.db, url, req.method ?? 'GET', body, send)) return
      // 清理那條線的 route。認得就處理完回 true，不認得回 false 讓下面接手。
      if (cleanupRoutes({
        // **這些都要是 thunk。** 上一版 `maxBytes: cfg().maxBytes` 是每個請求
        // 立刻求值，連 /facts 這種跟清理無關的路徑都會去讀（甚至建立）
        // 使用者的設定檔 —— 延後讀取的修正等於沒做。
        db: F.db, roots, quarantine: QUARANTINE,
        // 復原用放回的範圍（R2-4）；截圖資料夾只收截圖類（R2-8）
        restoreRoots: () => restoreRootList, screenshotsDir: () => screenshotsDir,
        // 會動檔案的 route 才需要這兩個，一樣用 thunk —— 唯讀的路徑不該去碰設定檔。
        maxBytes: () => opts.maxBytes ?? cfg().maxBytes,
        readonly: () => opts.readonly ?? cfg().readonly,
        url, method: req.method ?? 'GET', body, send,
        // onProblem 一定要傳：保險絲與讀不到的檔只經由它報，回應的 problems 就是這些
        scan: onProblem => scanDownloads({ db: F.db, roots: roots(), maxBytes: opts.maxBytes ?? cfg().maxBytes, onProblem }),
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
  // 網址帶鑰匙（?k=）。不帶的網址打開是 401。
  console.log(`手填頁面：${uiUrl(port, token)}　（鑰匙已經幫你帶好，直接開就能用）`)
  console.log(`token：${token}`)
  console.log(`（也存在 ${TOKEN_PATH}，貼進擴充套件設定）`)
}
