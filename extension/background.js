/**
 * ContextBox service worker
 *
 * 這支是整個擴充套件裡唯一拿得到 token、也唯一會打本機 server 的地方。
 * content script（跑在別人的網頁上）永遠只能傳訊息進來，拿不到 token。
 *
 * 為什麼一定要繞這一圈：
 *   content script 的 fetch 會拿「它所在那一頁的來源」去做 CORS 檢查，
 *   所以它打 127.0.0.1 時帶的是 https://某網站，會被 server 的鎖 3 擋掉。
 *   service worker 的來源是 chrome-extension://，有 host_permissions 就直接放行，
 *   連 OPTIONS 預檢都不用送。也就是說，這條路不是備案，是唯一能通的路。
 *
 * service worker 會被休眠（大約閒置 30 秒），所以這支檔案有兩條硬規則：
 *   1. 最上層只准同步註冊監聽器，一行 await 都不能放在它前面，
 *      不然叫醒 worker 的那一則訊息會在監聽器裝好之前就消失。
 *   2. 不准有任何記憶體狀態。token 跟 port 每次處理訊息時現讀 storage。
 *
 * ── 訊息協定（content script 與設定頁都走這裡）──────────────────
 *
 *   送 { type: 'plan', keys: ['person.name.full', ...] }
 *   回 { ok: true, plan: [ ...每個 key 一筆指示... ] }
 *
 *   送 { type: 'reveal', key: 'identity.national_id' }
 *   回 { ok: true, key, label, sensitivity, value }
 *
 *   送 { type: 'health' }
 *   回 { ok: true, facts: 12 }
 *
 *   送 { type: 'check' }                      設定頁的「測試連線」用
 *   回 { ok: true, facts: 12, tokenSet: true, tokenOk: true }
 *
 *   送 { type: 'open-home' }                  content script 的「庫裡沒有 X · 去補」
 *   回 { ok: true }                          （這一側開一個新分頁到手填頁，網址帶 ?k=<token>）
 *
 *   失敗一律回 { ok: false, error: '代碼', message: '給人看的中文' }
 *   代碼有：NO_TOKEN、BAD_TOKEN、OFFLINE、TIMEOUT、FORBIDDEN、
 *           BAD_REQUEST、NOT_FOUND、NOT_SENSITIVE、HTTP_xxx、INTERNAL
 *
 * 敏感欄位的值不會跟著 plan 一起下來。plan 裡 action 是 'confirm-each-time'
 * 的項目只有 label、sensitivity 跟 hasValue，沒有 value；等人真的點下去，
 * content script 再送一次 { type: 'reveal' } 要那一筆。
 * 這樣就算頁面把我們的確認 UI 蓋掉或偽造，敏感值也還沒進到頁面那一側。
 */

const HOST = 'http://127.0.0.1'      // 只打這一台。match pattern 不能帶 port，所以 port 釘在程式碼裡
const DEFAULT_PORT = 7391
const TIMEOUT_MS = 3000              // server 沒開的時候不要讓 content script 一直等
const MAX_KEYS = 200                 // 一頁不該問這麼多，塞爆就是有人在試探

/** 我們認得的訊息。其他的一律不接，免得占住別人的回覆通道 */
const HANDLED = new Set(['plan', 'reveal', 'health', 'check', 'open-home'])

/**
 * token 只能是看得見的 ASCII。
 * 帶中文、空白或換行的字串塞進 header，fetch 會當場丟例外，
 * 看起來就像「連不上 server」—— 那會把人送去查完全錯的方向，所以先擋下來講清楚。
 */
const HEADER_SAFE = /^[\x21-\x7E]+$/
const TOKEN_UNUSABLE =
  'token 裡有不能用的字元（中文、空白或換行）。請重新複製一次 ~/.contextbox/token 裡那一行。'

const fail = (error, message) => ({ ok: false, error, message })

/** 每次都現讀，不快取 —— worker 隨時會被收掉 */
async function config() {
  const got = await chrome.storage.local.get({ token: '', port: DEFAULT_PORT })
  const port = Number(got.port)
  return {
    token: typeof got.token === 'string' ? got.token.trim() : '',
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT,
  }
}

/**
 * 打本機 server。回 { ok: true, data } 或 fail(...)。
 * redirect: 'error' 是防一手：萬一 port 被別的程式佔走，它不能把帶著 token
 * 的請求轉去別的地方。
 */
async function call(path, { method = 'GET', token = '', body = null, port }) {
  const base = `${HOST}:${port}`
  const url = base + path
  if (!url.startsWith(base + '/')) return fail('BAD_REQUEST', '路徑不對。')

  const headers = {}
  if (token) headers['x-contextbox-token'] = token
  if (body !== null) headers['content-type'] = 'application/json'

  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    })
  } catch (e) {
    const name = e && e.name
    if (name === 'TimeoutError' || name === 'AbortError') {
      return fail('TIMEOUT', `本機 server ${TIMEOUT_MS / 1000} 秒沒有回應。它是不是卡住了？`)
    }
    return fail('OFFLINE', `連不上 ${base}。ContextBox server 沒開，或 port 設錯了。`)
  }

  let data = {}
  try { data = await res.json() } catch { data = {} }

  if (res.status === 401) {
    return fail('BAD_TOKEN', 'token 不對。請重新複製一次 ~/.contextbox/token 的內容。')
  }
  if (res.status === 403) {
    return fail('FORBIDDEN', 'server 拒絕了這個請求（它以為這是網頁發出來的）。')
  }
  if (!res.ok) {
    const why = typeof data.error === 'string' ? data.error.slice(0, 200) : `server 回了 ${res.status}`
    return fail(`HTTP_${res.status}`, why)
  }
  return { ok: true, data }
}

/**
 * 敏感欄位的值不下放到頁面那一側。
 * 只留 label 跟 sensitivity，讓 content script 畫得出「按一下才會填」的提示。
 */
function stripSensitive(plan) {
  if (!Array.isArray(plan)) return []
  return plan.map(item => {
    if (!item || typeof item !== 'object' || item.action !== 'confirm-each-time') return item
    const { value, ...rest } = item
    return { ...rest, hasValue: value !== undefined && value !== null && value !== '', needsReveal: true }
  })
}

/** 問 server 一組 key 該怎麼填 */
async function planFor(keys, token, port, origin) {
  return call('/form/plan', { method: 'POST', token, port, body: { keys, origin: origin ?? null } })
}

async function handle(msg, sender) {
  const { token, port } = await config()
  const origin = sender && sender.origin ? sender.origin : null

  if (msg.type === 'health' || msg.type === 'check') {
    const r = await call('/health', { port })
    if (!r.ok) return r
    const facts = Number(r.data.facts) || 0
    if (msg.type === 'health') return { ok: true, facts, port }

    // 「測試連線」要連 token 一起驗。/health 不用 token，光看它會誤判成一切正常。
    // 拿空的 keys 問一次 /form/plan 是最便宜的驗法：token 對回 200，不對回 401。
    if (!token) return { ok: true, facts, tokenSet: false, tokenOk: false }
    if (!HEADER_SAFE.test(token)) {
      return { ok: true, facts, tokenSet: true, tokenOk: false, message: TOKEN_UNUSABLE }
    }
    const probe = await planFor([], token, port, null)
    if (!probe.ok && probe.error !== 'BAD_TOKEN') return probe
    return { ok: true, facts, tokenSet: true, tokenOk: probe.ok === true }
  }

  // 以下都要 token
  if (!token) {
    return fail('NO_TOKEN', '還沒設定 token。請打開 ContextBox 的設定頁，貼上 ~/.contextbox/token 的內容。')
  }
  if (!HEADER_SAFE.test(token)) return fail('TOKEN_UNUSABLE', TOKEN_UNUSABLE)

  if (msg.type === 'open-home') {
    // 手填頁要帶鑰匙（?k=）才打得開（稽核 RC16）。網址**只在這一側組**、直接開分頁：
    // 不回給 content script —— 它跑在別人的網頁裡，交給它的東西網頁都讀得到。
    await chrome.tabs.create({ url: `${HOST}:${port}/?k=${encodeURIComponent(token)}` })
    return { ok: true }
  }

  if (msg.type === 'plan') {
    if (!Array.isArray(msg.keys)) return fail('BAD_REQUEST', 'keys 要是一個字串陣列。')
    const keys = [...new Set(msg.keys.filter(k => typeof k === 'string' && k))].slice(0, MAX_KEYS)
    if (keys.length === 0) return { ok: true, plan: [] }
    const r = await planFor(keys, token, port, origin)
    if (!r.ok) return r
    return { ok: true, plan: stripSensitive(r.data.plan) }
  }

  if (msg.type === 'reveal') {
    const key = typeof msg.key === 'string' ? msg.key.trim() : ''
    if (!key) return fail('BAD_REQUEST', 'reveal 要給一個 key。')
    const r = await planFor([key], token, port, origin)
    if (!r.ok) return r
    const item = Array.isArray(r.data.plan) ? r.data.plan.find(i => i && i.key === key) : null
    if (!item || item.action === 'unknown') return fail('NOT_FOUND', `不認得這個 key：${key}`)
    if (item.action === 'missing') return fail('NOT_FOUND', `事實庫裡還沒有「${item.label ?? key}」。`)
    if (item.action !== 'confirm-each-time') {
      return fail('NOT_SENSITIVE', 'reveal 只給敏感欄位用，一般欄位請走 plan。')
    }
    // 敏感的 key 就算庫裡沒東西也會回 confirm-each-time（這樣網頁問不出「你有沒有」），
    // 所以真的要拿值的時候得自己再看一次有沒有值。
    if (item.value === undefined || item.value === null || item.value === '') {
      return fail('NOT_FOUND', `事實庫裡還沒有「${item.label ?? key}」。`)
    }
    return { ok: true, key, label: item.label, sensitivity: item.sensitivity, value: item.value }
  }

  return fail('BAD_REQUEST', `不認得這種訊息：${String(msg.type).slice(0, 40)}`)
}

// ── 最上層只准有這些 ──────────────────────────────────────────
// 監聽器一定要同步註冊。寫成 (async () => { await 什麼; addListener(...) })()
// 的話，把 worker 叫醒的那一則訊息會掉，症狀是「第一次點沒反應、第二次才有」。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg && typeof msg === 'object' ? msg.type : null
  if (!HANDLED.has(type)) {
    // 明明是我們家的訊息（cb- 開頭）卻不認得 —— 那是兩邊協定對不上，
    // 一定要出聲。靜靜 return 會把通道關掉，症狀是「沒反應」，查半天查不到。
    if (typeof type === 'string' && type.startsWith('cb-')) {
      sendResponse(fail('BAD_REQUEST',
        `擴充套件內部協定對不上（${type}）。請到 chrome://extensions 重新載入 ContextBox。`))
      return true
    }
    return                                // 不是我們的訊息，讓別的監聽器去回
  }
  handle(msg, sender).then(
    sendResponse,
    e => sendResponse(fail('INTERNAL', String((e && e.message) || e))),
  )
  return true                              // 通道留著，等 promise 回來
})

// 第一次安裝就把設定頁打開，不然使用者不知道要去哪貼 token
chrome.runtime.onInstalled.addListener(d => {
  if (d.reason === 'install') chrome.runtime.openOptionsPage()
})
