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
 *   2. 不准有任何**會影響結果**的記憶體狀態。token 跟 port 每次處理訊息時現讀 storage。
 *      唯一的例外是 provenMark（下面「不變量 11」那一段）：它只是一份快取，
 *      掉了就重驗一次，不會少擋任何東西。
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
 *                                            先驗 token：存的 token 過期回 BAD_TOKEN、server 沒開回
 *                                            OFFLINE／TIMEOUT，這兩種都不開分頁
 *
 *   失敗一律回 { ok: false, error: '代碼', message: '給人看的中文' }
 *   代碼有：NO_TOKEN、BAD_TOKEN、TOKEN_UNUSABLE、NOT_CONTEXTBOX、UNPROVEN、
 *           OFFLINE、TIMEOUT、FORBIDDEN、BAD_REQUEST、NOT_FOUND、NOT_SENSITIVE、
 *           HTTP_xxx、INTERNAL
 *
 * ── 不變量 11：還不知道對方是誰，不可以先把鑰匙送過去（稽核第三輪 R3-7）──
 *
 * port 不是我們的財產。多使用者的機器上，別的帳號只要在 pet 之前 bind
 * 127.0.0.1:7391，這裡的每一個帶 token 的請求就等於把鑰匙交給他 —— 那把鑰匙可以
 * 建計畫、搬檔、清空隔離區。以前這裡只要 token 非空就直接加 header（R3-7 實測：
 * 冒牌什麼都不用做，plan／reveal／open-home 三條都把完整 token 送過去，
 * open-home 還會再開一個 ?k=<token> 的分頁）。
 *
 * 現在跟 CLI 的 `petUp` 做同一件事：**送出任何帶 token 的請求之前**，先帶一個每次都
 * 不同的 nonce 問**免 token** 的 /health，對方要回 proof ＝
 * HMAC-SHA256(token, `${port}:${nonce}`)。算得出來的只有手上有這把鑰匙的那一個。
 * proof 不洩漏 token（HMAC 反推不回 key），所以問的時候不帶 token 是安全的。
 * 埠號綁在訊息裡：不然佔住 A 埠的冒牌可以把 nonce 轉給 B 埠上的真 pet，再把 proof
 * 原封不動交回來。比對用固定時間。
 *
 * 落實的方式是「只有 planFor 會把 token 交給 call()，而 planFor 一定先 verifyPort」——
 * 多一個帶 token 的呼叫端就繞過去了，所以 test/audit-0919-r3ext.test.mjs 會數。
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
/** 「去補」時存的 token 被 server 拒絕。這句話會顯示在網頁那一側，不可以帶 token 本身。 */
const HOME_KEY_EXPIRED =
  '鑰匙過期了。擴充套件存的鑰匙跟 ContextBox 現在的對不上（server 可能換過鑰匙）。'
  + '手填頁請從寵物重新打開，或跑 node cli.mjs open；擴充套件也要到設定頁重新貼上 ~/.contextbox/token 的內容，才填得了表單。'

const fail = (error, message) => ({ ok: false, error, message })

// ── 不變量 11：先證明，再交鑰匙 ────────────────────────────────

/** 驗過的結果快取多久。worker 閒置約 30 秒就被收掉，所以這份快取活不過一次休眠 —— 那正好。 */
const PROVEN_MS = 30_000
/**
 * 上一次驗過的 { port, token, at }。**這是唯一的記憶體狀態，而且掉了沒關係**：
 * 掉了就是重驗一次（一個免 token 的 /health），不會少擋任何東西。
 */
let provenMark = null

/** 這份「驗過了」還能用嗎。綁 port＋token；時鐘往回跳（校時、休眠）一律當成過期。 */
function stillProven(mark, port, token, now) {
  if (!mark || !token) return false
  return mark.port === port && mark.token === token && now >= mark.at && now - mark.at < PROVEN_MS
}

/** 16 bytes 的 hex（32 個字）。格式要跟 core/server.ts 的 NONCE 一樣，不然對方不回 proof。 */
function newNonce() {
  const b = crypto.getRandomValues(new Uint8Array(16))
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('')
}

/** HMAC-SHA256(token, `${port}:${nonce}`) 的 hex。跟 core/server.ts 的 healthProof 同一支算法。 */
async function healthProofHex(token, port, nonce) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${port}:${nonce}`))
  return [...new Uint8Array(sig)].map(x => x.toString(16).padStart(2, '0')).join('')
}

/**
 * 固定時間比對兩個 hex 字串。**空字串一律不算對**（跟 core/server.ts 的 sameToken 一樣）。
 * 長度不同直接 false：proof 的長度是固定的公開值，洩漏它沒有意義。
 */
function sameHex(a, b) {
  const x = typeof a === 'string' ? a : ''
  const y = typeof b === 'string' ? b : ''
  if (!x || !y || x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i)
  return diff === 0
}

/** 回應的形狀像不像 /health（跟 cli.mjs 的 looksLikeHealth 同一組欄位） */
const looksLikeHealth = j => Boolean(j) && typeof j === 'object'
  && typeof j.ok === 'boolean' && typeof j.db?.ok === 'boolean'
  && typeof j.watcher === 'object' && j.watcher !== null
  && typeof j.quarantine === 'object' && j.quarantine !== null
  && Number.isFinite(j.pendingCandidates)

const NOT_CONTEXTBOX_TEXT = port =>
  `127.0.0.1:${port} 上回應的不是 ContextBox。沒有把鑰匙交給它，也沒有送出任何資料。`
  + '請確認 ContextBox 有在跑，而且擴充套件設定頁裡的 port 跟它一樣。'

const UNPROVEN_TEXT = port =>
  `127.0.0.1:${port} 上回應的像 ContextBox，但它證明不了手上有你的鑰匙，所以沒有把鑰匙交給它。`
  + '兩種可能：擴充套件存的鑰匙過期了（ContextBox 換過鑰匙），或者這個 port 被別的程式佔住了。'
  + '請到設定頁重新貼上 ~/.contextbox/token 的內容；手填頁請從寵物重新打開，或跑 node cli.mjs open。'

/**
 * 拿到 /health?nonce= 的回應之後，判斷對方證明得了自己手上有這把 token 沒有。
 * 這一支不碰網路，好單獨測。過了才把 provenMark 記起來。
 */
async function provenFrom(body, port, token, nonce) {
  if (!looksLikeHealth(body)) return fail('NOT_CONTEXTBOX', NOT_CONTEXTBOX_TEXT(port))
  const want = await healthProofHex(token, port, nonce)
  if (!sameHex(body.proof, want)) return fail('UNPROVEN', UNPROVEN_TEXT(port))
  provenMark = { port, token, at: Date.now() }
  return { ok: true }
}

/**
 * 「這個 port 上的，是手上有這把 token 的 ContextBox」—— 通過才准送帶 token 的請求。
 * 問的時候**不帶 token**：還不知道對方是誰。連不上就照實回 OFFLINE／TIMEOUT，
 * 不要說成「不是 ContextBox」（那會把人送去查錯的方向）。
 */
async function verifyPort(port, token) {
  if (stillProven(provenMark, port, token, Date.now())) return { ok: true }
  const nonce = newNonce()
  const r = await call(`/health?nonce=${nonce}`, { port })
  if (!r.ok) {
    if (r.error === 'OFFLINE' || r.error === 'TIMEOUT') return r
    // /health 是免 token 的路徑，真的 ContextBox 不會回 401／403／5xx
    return fail('NOT_CONTEXTBOX', NOT_CONTEXTBOX_TEXT(port))
  }
  return provenFrom(r.data, port, token, nonce)
}

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

/**
 * 問 server 一組 key 該怎麼填。
 *
 * **這是整支檔案裡唯一會把 token 交給 call() 的地方**，所以不變量 11 的關卡就放這裡：
 * 先 verifyPort 證明對方手上有這把鑰匙，過了才送。新增第二個帶 token 的呼叫端
 * ＝ 繞過這道關卡，test/audit-0919-r3ext.test.mjs 會數出來。
 */
async function planFor(keys, token, port, origin) {
  const proven = await verifyPort(port, token)
  if (!proven.ok) return proven
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
    // （planFor 會先 verifyPort，所以「對方證明不了自己是誰」也在這裡一起講。）
    if (!token) return { ok: true, facts, tokenSet: false, tokenOk: false }
    if (!HEADER_SAFE.test(token)) {
      return { ok: true, facts, tokenSet: true, tokenOk: false, message: TOKEN_UNUSABLE }
    }
    const probe = await planFor([], token, port, null)
    // 這三種都是「連得上，但這把鑰匙在這個 port 上用不了」—— 設定頁要講原因，不是丟一個錯誤代碼
    if (!probe.ok && ['BAD_TOKEN', 'UNPROVEN', 'NOT_CONTEXTBOX'].includes(probe.error)) {
      return { ok: true, facts, tokenSet: true, tokenOk: false, message: probe.message }
    }
    if (!probe.ok) return probe
    return { ok: true, facts, tokenSet: true, tokenOk: true }
  }

  // 以下都要 token
  if (!token) {
    return fail('NO_TOKEN', '還沒設定 token。請打開 ContextBox 的設定頁，貼上 ~/.contextbox/token 的內容。')
  }
  if (!HEADER_SAFE.test(token)) return fail('TOKEN_UNUSABLE', TOKEN_UNUSABLE)

  if (msg.type === 'open-home') {
    // **先驗 token 再開分頁**（稽核第三波 U6）。存的 token 過期（server 換過鑰匙）的話，
    // 新分頁是一張 401，content script 卻說「開好了」。拿空的 keys 問一次 /form/plan
    // 是最便宜的驗法（跟設定頁的「測試連線」一樣）：對回 200，不對回 401。
    // server 沒開、沒回應也照實回，不開一個一定打不開的分頁。
    //
    // planFor 會先證明對方手上有這把鑰匙（R3-7）。證明不過就在這裡停住 ——
    // 這一條原本是最糟的一條：除了 header 裡的 token，還會再開一個 ?k=<token> 的分頁。
    const probe = await planFor([], token, port, null)
    if (!probe.ok) return probe.error === 'BAD_TOKEN' ? fail('BAD_TOKEN', HOME_KEY_EXPIRED) : probe
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
