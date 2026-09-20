/**
 * 「它學到的事」那條線的 route（P5）：`GET /learned`、`DELETE /learned`。
 *
 * 跟改名（core/rename-routes.ts）與歸檔（core/filing-routes.ts）同一套規矩：
 *   · **兩條都要 token**（server.ts 的鎖 2 在這之前就擋掉了沒帶 token 的）。
 *   · body 走**白名單**：不認得的欄位是「看不懂」，不是「什麼都沒帶」——
 *     `{ IDs: … }` 拼錯一個字母不可以被當成「沒指定」而變成「全部忘掉」。
 *     這一條特別要緊：這裡的預設動作如果是「全清」，拼錯欄位就會**清光使用者的偏好**。
 *   · **回給畫面的東西沒有絕對路徑、沒有檔案內容**（預期行為 11）。
 *     `preferences` 那張表本來就只存課名、類型與「哪一個建議」的摘要。
 *   · 例外一律翻成人話。
 *
 * 為什麼自己一支檔：它不是清理、不是改名、也不是歸檔 —— 它是**橫跨那幾條線的偏好**。
 * 這一支只認 `/learned`，認不得就回 false 讓下一個接手。
 */
import { CleanupError } from './cleanup-journal.ts'
import { statusFor, type RouteCtx } from './cleanup-routes.ts'
import { shown } from './filing-routes.ts'
import { forgetAllLearned, forgetLearned, listLearned, FORGET_MAX } from './learn.ts'

/** 認得的路徑與方法。已知的路徑用錯方法回 405，不是 404（RC24）。 */
const KNOWN: [RegExp, string[]][] = [
  [/^\/learned$/, ['GET', 'DELETE']],
]

/** 這條路徑認得的 body key。改之前先看面板（core/assets）與 cli.mjs 送了什麼。 */
const BODY_KEYS = ['ids', 'all'] as const

const INTERNAL = 'Something went wrong reading or writing what it learned. No file was touched. Try again.'

const fail = (send: RouteCtx['send'], code: number, error: string, tag: string, headers?: Record<string, string>) =>
  send(code, { error, code: tag }, headers)

/** body 一定要是物件，而且只收白名單裡的 key（跟 rename-routes 的 bodyOf 同一條規矩）。 */
function bodyOf(ctx: RouteCtx, allowed: readonly string[]): Record<string, any> {
  const b = ctx.body
  if (b === undefined) return {}
  if (b === null || typeof b !== 'object' || Array.isArray(b)) {
    throw new CleanupError('BAD_BODY', 'Could not make sense of the body.')
  }
  const unknown = Object.keys(b).filter(k => !allowed.includes(k))
  if (unknown.length) {
    const bad = unknown.slice(0, 3).map(k => shown(k).slice(0, 40)).join('、')
    throw new CleanupError('BAD_BODY',
      `Could not make sense of the body: unknown field ${bad}. This route only takes ${allowed.join(', ')}.`)
  }
  return b
}

const readonlyOf = (ctx: RouteCtx) => typeof ctx.readonly === 'function' ? ctx.readonly() : ctx.readonly

/**
 * 「它學到的事」的 route。**認得就處理並回 true，不認得回 false** 讓下一個接手。
 * 整支包起來：不包的話例外會穿到 server.ts 的 catch，那裡回 400 加原始訊息（可能帶路徑）。
 */
export function learnRoutes(ctx: RouteCtx): boolean {
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
  if (p !== '/learned' && !p.startsWith('/learned/')) return false

  const known = KNOWN.find(([re]) => re.test(p))
  if (known && !known[1].includes(method)) {
    fail(send, 405, `This route only takes ${known[1].join(', ')}.`, 'BAD_METHOD', { allow: known[1].join(', ') })
    return true
  }

  if (p === '/learned' && method === 'GET') {
    send(200, listLearned(ctx.db))
    return true
  }

  if (p === '/learned' && method === 'DELETE') {
    // 唯讀模式不寫任何東西 —— 忘掉一條偏好也是寫（跟收尾、apply 同一條規矩，第三輪 R3-9）
    if (readonlyOf(ctx) === true) {
      throw new CleanupError('READ_ONLY', 'Read-only mode is on, so nothing changes — not even forgetting what it learned.')
    }
    const body = bodyOf(ctx, BODY_KEYS)
    const all = body.all
    if (all !== undefined && typeof all !== 'boolean') {
      throw new CleanupError('BAD_BODY', 'all must be true or false.')
    }
    let ids: string[] = []
    if (body.ids !== undefined) {
      if (!Array.isArray(body.ids) || body.ids.length > FORGET_MAX
        || body.ids.some((v: unknown) => typeof v !== 'string' || !v || v.length > 200)) {
        throw new CleanupError('BAD_BODY', `ids must be an array of strings, at most ${FORGET_MAX} of them.`)
      }
      ids = body.ids as string[]
    }
    // **沒指名就什麼都不做**：沒有「預設全清」這種捷徑（不變量 3 的反面 —— 忘掉是使用者的決定）
    if (!ids.length && all !== true) {
      throw new CleanupError('BAD_BODY', 'Name the ids, or send { "all": true } to forget everything.')
    }
    if (ids.length && all === true) {
      throw new CleanupError('BAD_BODY', 'ids and all cannot be sent together — say whether you mean some entries or all of them.')
    }
    send(200, { forgotten: all === true ? forgetAllLearned(ctx.db) : forgetLearned(ctx.db, ids) })
    return true
  }

  // `/learned/` 底下認不得的路徑：回一句人話，不是 404（404 會讓呼叫端以為自己打錯網址）
  fail(send, 501, 'This feature is not built yet.', 'NOT_IMPLEMENTED')
  return true
}
