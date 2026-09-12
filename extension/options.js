/**
 * 設定頁。
 *
 * 這裡不自己 fetch server —— 連「測試連線」都是送訊息給背景程式代打。
 * 整個擴充套件只留一條打 server 的路，好找也好防。
 */

const DEFAULT_PORT = 7391

const $ = id => document.getElementById(id)
const els = {
  port: $('port'), token: $('token'), reveal: $('reveal'),
  save: $('save'), test: $('test'), clear: $('clear'),
  status: $('status'), healthLink: $('healthLink'),
}

function say(kind, text) {
  els.status.className = kind
  els.status.textContent = text
}

/** 貼進來的東西常常多帶一截，順手清掉 */
function cleanToken(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^token\s*[:：]\s*/i, '')
    .replace(/^["'`]|["'`]$/g, '')
    .trim()
}

function readPort() {
  const n = Number(els.port.value)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
}

function syncHealthLink(port) {
  const url = `http://127.0.0.1:${port}/health`
  els.healthLink.href = url
  els.healthLink.textContent = url
}

/**
 * 送訊息給背景程式。
 * service worker 睡著的時候，第一則訊息偶爾會在它醒來的過程中掉，
 * 所以失敗就再送一次 —— 第二次它已經醒著了。
 */
async function ask(msg) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await chrome.runtime.sendMessage(msg)
      if (r) return r
    } catch (e) {
      if (attempt === 1) throw e
    }
  }
  throw new Error('背景程式沒有回應，請再按一次。')
}

async function load() {
  const got = await chrome.storage.local.get({ token: '', port: DEFAULT_PORT })
  const port = Number(got.port)
  els.port.value = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT
  els.token.value = typeof got.token === 'string' ? got.token : ''
  syncHealthLink(els.port.value)
  if (!els.token.value) say('warn', '還沒貼 token。貼好按「儲存」，再按「測試連線」確認。')
}

/** 存起來。回傳存進去的內容，失敗回 null。 */
async function save(quiet = false) {
  const port = readPort()
  if (port === null) {
    say('bad', 'Port 要是 1 到 65535 之間的整數。')
    els.port.focus()
    return null
  }
  const token = cleanToken(els.token.value)
  els.token.value = token
  syncHealthLink(port)

  await chrome.storage.local.set({ token, port })

  if (!quiet) {
    if (!token) say('warn', '存好了，但 token 是空的 —— 沒有 token 什麼都填不了。')
    else if (!/^[A-Za-z0-9_\-=.]{16,}$/.test(token)) say('warn', '存好了，不過這串看起來不太像 token（太短或有奇怪的字元）。按「測試連線」看看。')
    else say('ok', '存好了。')
  }
  return { token, port }
}

async function test() {
  const saved = await save(true)
  if (!saved) return

  say('busy', '正在連 127.0.0.1:' + saved.port + '⋯⋯')
  let r
  try {
    r = await ask({ type: 'check' })
  } catch (e) {
    say('bad', (e && e.message) || '背景程式沒有回應。')
    return
  }

  if (!r.ok) {
    say('bad', r.message || '連不上。')
    return
  }
  const facts = `庫裡有 ${r.facts} 筆事實`
  if (!r.tokenSet) say('warn', `server 有回應，${facts}，但你還沒貼 token。`)
  else if (!r.tokenOk) say('bad', r.message || '連上了，但 token 不對 —— 請重新複製一次 ~/.contextbox/token 的內容。')
  else say('ok', `連上了，${facts}。token 也對了。`)
}

async function clearToken() {
  els.token.value = ''
  await chrome.storage.local.set({ token: '' })
  say('warn', 'token 清掉了。要再用的話得重貼一次。')
}

els.reveal.addEventListener('change', () => {
  els.token.type = els.reveal.checked ? 'text' : 'password'
})
els.port.addEventListener('input', () => {
  const p = readPort()
  if (p !== null) syncHealthLink(p)
})
els.save.addEventListener('click', () => { save() })
els.test.addEventListener('click', () => { test() })
els.clear.addEventListener('click', () => { clearToken() })
els.token.addEventListener('keydown', e => { if (e.key === 'Enter') test() })

load()
