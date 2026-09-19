/**
 * 歸檔那條線的 route（P4）：`GET /file/suggestions`、`POST /file/apply`、`POST /file/undo`。
 *
 * 跟改名（core/rename-routes.ts）同一套規矩：
 *   · **三條都要 token**（server.ts 的鎖 2 在這之前就擋掉了沒帶 token 的）。
 *   · body 走**白名單**：不認得的欄位是「看不懂」，不是「什麼都沒帶」——
 *     `{ itemIDs: … }` 拼錯一個字母不可以被當成「沒指定」而變成某種預設動作。
 *   · **回給畫面的東西沒有絕對路徑**（不變量 8）：只給相對於 filed 的那一段。
 *     `filings.from_dir`／`to_dir` 只留在資料庫裡。
 *   · 例外一律翻成人話：CleanupError 的訊息本來就是寫好的中文而且不帶路徑，其他換罐頭訊息。
 *
 * 為什麼自己一支檔：歸檔不是清理（沒有計畫、沒有隔離區），也不是改名（它換資料夾）。
 * 這一支只認 `/file/`，認不得就回 false 讓下一個接手。
 */
import { CleanupError } from './cleanup-journal.ts'
import { statusFor, type RouteCtx } from './cleanup-routes.ts'
import { applyFilings, filingSuggestions, undoFilings, type FilingScope } from './filing.ts'

/** 認得的路徑與方法。已知的路徑用錯方法回 405，不是 404（RC24）。 */
const KNOWN: [RegExp, string[]][] = [
  [/^\/file\/suggestions$/, ['GET']],
  [/^\/file\/apply$/, ['POST']],
  [/^\/file\/undo$/, ['POST']],
]

/** 各路徑認得的 body key。改之前先看面板（core/assets）與 cli.mjs 送了什麼。 */
const BODY_KEYS = {
  apply: ['items'],
  undo: ['ids', 'last'],
} as const

const INTERNAL = '整理的時候出錯了。檔案沒有被刪掉，紀錄還在，請重試。'

/**
 * 顯示用的過濾：控制字元與方向字元換成「·」（跟 rename-routes 同一組）。
 *
 * 匯出給 learn-routes.ts 用（P5）：**同一條規矩只留一份**。
 * 這裡刻意用碼位比大小、不用正規表示式 —— 那些字元寫進 regex 字面量裡，
 * 原始檔就會帶著真的控制字元（git 會把整支檔當二進位，見 test/repo.test.mjs）。
 */
export function shown(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    // C0／C1、U+061C、U+200E／200F、U+2028–202E、U+2066–2069：印出來會偽造一行字或把副檔名倒過來
    const bad = c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x61c
      || (c >= 0x200e && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)
    out += bad ? '·' : ch
  }
  return out
}

const fail = (send: RouteCtx['send'], code: number, error: string, tag: string, headers?: Record<string, string>) =>
  send(code, { error, code: tag }, headers)

/** body 一定要是物件，而且只收白名單裡的 key（跟 cleanup-routes 的 bodyOf 同一條規矩）。 */
function bodyOf(ctx: RouteCtx, allowed: readonly string[]): Record<string, any> {
  const b = ctx.body
  if (b === undefined) return {}
  if (b === null || typeof b !== 'object' || Array.isArray(b)) {
    throw new CleanupError('BAD_BODY', '看不懂送來的資料。')
  }
  const unknown = Object.keys(b).filter(k => !allowed.includes(k))
  if (unknown.length) {
    const bad = unknown.slice(0, 3).map(k => shown(k).slice(0, 40)).join('、')
    throw new CleanupError('BAD_BODY',
      `看不懂送來的資料：不認得的欄位 ${bad}。這個路徑只收 ${allowed.join('、')}。`)
  }
  return b
}

/** roots／filed／readonly 這些可以是值也可以是 thunk（延後讀設定），在這裡才求值。 */
const rootsOf = (ctx: RouteCtx) => typeof ctx.roots === 'function' ? ctx.roots() : ctx.roots
const filedOf = (ctx: RouteCtx) => typeof ctx.filed === 'function' ? ctx.filed() : ctx.filed
const readonlyOf = (ctx: RouteCtx) => typeof ctx.readonly === 'function' ? ctx.readonly() : ctx.readonly
const restoreRootsOf = (ctx: RouteCtx) =>
  typeof ctx.restoreRoots === 'function' ? ctx.restoreRoots() : ctx.restoreRoots

/**
 * 歸檔要的範圍。**沒有 filed 就不做事**：這一支會搬使用者的檔，
 * 不知道要搬去哪的時候猜一個位置是最糟的選擇。
 */
function scopeOf(ctx: RouteCtx): FilingScope {
  const filed = filedOf(ctx)
  if (!filed) {
    throw new CleanupError('BAD_CONFIG', '還沒設定「整理好的」資料夾（設定檔的 filed），不知道要搬去哪。')
  }
  const roots = rootsOf(ctx) ?? []
  return {
    roots,
    filed,
    restoreRoots: restoreRootsOf(ctx) ?? roots,
    quarantine: ctx.quarantine,
    readonly: readonlyOf(ctx) === true,
  }
}

/**
 * 歸檔的 route。**認得就處理並回 true，不認得回 false** 讓下一個接手。
 * 整支包起來：不包的話例外會穿到 server.ts 的 catch，那裡回 400 加原始訊息（可能帶路徑）。
 */
export function filingRoutes(ctx: RouteCtx): boolean {
  try { return route(ctx) }
  catch (e: any) {
    if (e instanceof CleanupError) {
      fail(ctx.send, statusFor(e.code), e.message, e.code,
        e.code === 'BUSY' ? { 'retry-after': '2' } : undefined)
      return true
    }
    fail(ctx.send, 500, INTERNAL, 'INTERNAL')
    return true
  }
}

function route(ctx: RouteCtx): boolean {
  const { url, method, send } = ctx
  const p = url.pathname
  if (!p.startsWith('/file/')) return false

  const known = KNOWN.find(([re]) => re.test(p))
  if (known && !known[1].includes(method)) {
    fail(send, 405, `這個路徑只收 ${known[1].join('、')}。`, 'BAD_METHOD', { allow: known[1].join(', ') })
    return true
  }

  if (p === '/file/suggestions' && method === 'GET') {
    const raw = url.searchParams.get('limit')
    const limit = raw === null ? undefined : Number(raw)
    if (raw !== null && (!Number.isInteger(limit) || limit! < 1 || limit! > 1000)) {
      fail(send, 400, 'limit 要是 1 到 1000 之間的整數。', 'BAD_BODY')
      return true
    }
    send(200, filingSuggestions(ctx.db, scopeOf(ctx), { limit }))
    return true
  }

  if (p === '/file/apply' && method === 'POST') {
    // **只接明確指名的**：沒有「全部」這種捷徑（不變量 1）。沒帶 items 就是 BAD_BODY。
    const body = bodyOf(ctx, BODY_KEYS.apply)
    send(200, applyFilings(ctx.db, body.items, scopeOf(ctx)))
    return true
  }

  if (p === '/file/undo' && method === 'POST') {
    const body = bodyOf(ctx, BODY_KEYS.undo)
    send(200, undoFilings(ctx.db, { ids: body.ids, last: body.last }, scopeOf(ctx)))
    return true
  }

  // `/file/` 底下認不得的路徑：回一句人話，不是 404（404 會讓呼叫端以為自己打錯網址）
  fail(send, 501, '這個功能還沒做好。', 'NOT_IMPLEMENTED')
  return true
}
