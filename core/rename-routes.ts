/**
 * 改名那條線的 route（P3）：`GET /rename/suggestions`、`POST /rename/apply`、`POST /rename/undo`。
 *
 * 跟清理那條線同一套規矩：
 *   · **三條都要 token**（server.ts 的鎖 2 在這之前就擋掉了沒帶 token 的）。
 *   · body 走**白名單**：不認得的欄位是「看不懂」，不是「什麼都沒帶」（R2-7）——
 *     `{ itemIDs: … }` 拼錯一個字母不可以被當成「沒指定」而變成某種預設動作。
 *   · **回給畫面的東西沒有絕對路徑**（不變量 9）。`dir` 只留在資料庫裡。
 *   · 例外一律翻成人話：CleanupError 的訊息本來就是寫好的中文而且不帶路徑，其他換罐頭訊息。
 *
 * 為什麼自己一支檔而不是塞進 cleanup-routes.ts：改名不是清理（沒有計畫、沒有隔離區），
 * 而且那支已經 2000 多行。這一支只認 `/rename/`，認不得就回 false 讓下一個接手。
 */
import { CleanupError } from './cleanup-journal.ts'
import { statusFor, type RouteCtx } from './cleanup-routes.ts'
import { applyRenames, renameSuggestions, undoRenames, type RenameScope } from './rename.ts'
import { settleMoves } from './settle.ts'

/** 認得的路徑與方法。已知的路徑用錯方法回 405，不是 404（RC24）。 */
const KNOWN: [RegExp, string[]][] = [
  [/^\/rename\/suggestions$/, ['GET']],
  [/^\/rename\/apply$/, ['POST']],
  [/^\/rename\/undo$/, ['POST']],
]

/** 各路徑認得的 body key。改之前先看面板（core/assets）與 cli.mjs 送了什麼。 */
const BODY_KEYS = {
  apply: ['items'],
  undo: ['ids', 'last'],
} as const

const INTERNAL = 'Something went wrong while renaming. No file was deleted and the records are intact. Try again.'

const fail = (send: RouteCtx['send'], code: number, error: string, tag: string, headers?: Record<string, string>) =>
  send(code, { error, code: tag }, headers)

/** body 一定要是物件，而且只收白名單裡的 key（跟 cleanup-routes 的 bodyOf 同一條規矩）。 */
function bodyOf(ctx: RouteCtx, allowed: readonly string[]): Record<string, any> {
  const b = ctx.body
  if (b === undefined) return {}
  if (b === null || typeof b !== 'object' || Array.isArray(b)) {
    throw new CleanupError('BAD_BODY', 'Could not make sense of the body.')
  }
  const unknown = Object.keys(b).filter(k => !allowed.includes(k))
  if (unknown.length) {
    const shown = unknown.slice(0, 3)
      .map(k => k.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, '·').slice(0, 40))
      .join(', ')
    throw new CleanupError('BAD_BODY',
      `Could not make sense of the body: unknown field ${shown}. This route only takes ${allowed.join(', ')}.`)
  }
  return b
}

const rootsOf = (ctx: RouteCtx) => typeof ctx.roots === 'function' ? ctx.roots() : ctx.roots
const readonlyOf = (ctx: RouteCtx) => typeof ctx.readonly === 'function' ? ctx.readonly() : ctx.readonly

/** 改名要的範圍。**沒有 maxBytes** —— 改名不讀內容，檔案多大都一樣改。 */
function scopeOf(ctx: RouteCtx): RenameScope {
  return { roots: rootsOf(ctx), quarantine: ctx.quarantine, readonly: readonlyOf(ctx) === true }
}

/**
 * 改名的 route。**認得就處理並回 true，不認得回 false** 讓下一個接手。
 * 整支包起來：不包的話例外會穿到 server.ts 的 catch，那裡回 400 加原始訊息（可能帶路徑）。
 */
export function renameRoutes(ctx: RouteCtx): boolean {
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
  if (!p.startsWith('/rename/')) return false

  const known = KNOWN.find(([re]) => re.test(p))
  if (known && !known[1].includes(method)) {
    fail(send, 405, `This route only takes ${known[1].join(', ')}.`, 'BAD_METHOD', { allow: known[1].join(', ') })
    return true
  }

  if (p === '/rename/suggestions' && method === 'GET') {
    const raw = url.searchParams.get('limit')
    const limit = raw === null ? undefined : Number(raw)
    if (raw !== null && (!Number.isInteger(limit) || limit! < 1 || limit! > 1000)) {
      fail(send, 400, 'limit must be a whole number between 1 and 1000.', 'BAD_BODY')
      return true
    }
    send(200, renameSuggestions(ctx.db, scopeOf(ctx), { limit }))
    return true
  }

  if (p === '/rename/apply' && method === 'POST') {
    // **只接明確指名的**：沒有「全部」這種捷徑（不變量 1）。沒帶 items 就是 BAD_BODY。
    const body = bodyOf(ctx, BODY_KEYS.apply)
    // 動檔案之前**三種都收一次**（稽核 A-2）：改名收到一半的檔照樣歸得了檔，
    // 而歸檔搬走之後，那筆改名就再也收不掉了。
    settleMoves(ctx.db)
    send(200, applyRenames(ctx.db, body.items, scopeOf(ctx)))
    return true
  }

  if (p === '/rename/undo' && method === 'POST') {
    const body = bodyOf(ctx, BODY_KEYS.undo)
    // 動檔案之前**三種都收一次**（稽核 A-2）：改名收到一半的檔照樣歸得了檔，
    // 而歸檔搬走之後，那筆改名就再也收不掉了。
    settleMoves(ctx.db)
    send(200, undoRenames(ctx.db, { ids: body.ids, last: body.last }, scopeOf(ctx)))
    return true
  }

  // `/rename/` 底下認不得的路徑：回一句人話，不是 404（404 會讓呼叫端以為自己打錯網址）
  fail(send, 501, 'This feature is not built yet.', 'NOT_IMPLEMENTED')
  return true
}
