/**
 * 寫進事實庫之前的把關。
 * 三件事：key 認不認得、值合不合法、敏感度是多少（從註冊表拿，不信呼叫端）。
 */
import { defOf, fillModeOf, type FactKeyDef, type Sensitivity } from '../schema/factKeys.ts'
import { toDate, toE164, toHalfWidth, foldFullWidth } from '../schema/normalize.ts'

export class ValidationError extends Error {}

/** education[0].school → { keyDef: 'education[].school', idx: 0 } */
export function parseKey(key: string) {
  const m = key.match(/\[(\d+)\]/)
  return { keyDef: key.replace(/\[\d+\]/g, '[]'), idx: m ? Number(m[1]) : null }
}

/**
 * 回傳正規化過的值。看不懂就丟錯，不要猜。
 *
 * 每一個分支都要自己回答一個問題：「這裡收到的字有沒有可能是全形？」
 * 答案永遠是「有」—— 值可能是模型從截圖抽出來的，也可能是人用注音打的全形。
 * 所以每一條會看字面的路都要先折半形再判斷，而且折法要挑對：
 *   foldFullWidth  機器格式（日期／電話／email／網址）：整塊全形 ASCII 都折，
 *                  因為 ＠．／：＋ 在這些格式裡不可能是內容。
 *   toHalfWidth    人看的字（enum、number、一般字串）：只折英數，留住全形標點。
 * 兩條例外，都是故意的：
 *   text     不折 —— 折了會把換行壓成一個空格，把一篇自傳弄成一行。
 *   boolean  不看字面 —— 它只看有沒有值（下面那條自己有註解講這件事的代價）。
 */
export function normalizeValue(def: FactKeyDef, raw: unknown): unknown {
  if (raw === null || raw === undefined) {
    throw new ValidationError(`${def.key}：值是空的`)
  }
  const s = typeof raw === 'string' ? raw.trim() : raw
  // 空字串要在 trim 之後才判得準：全形空格「　」跟一串半形空白 trim 完都是空的，
  // 只比 raw === '' 的話它們會整個漏過去 —— 走到 number 分支變成 Number('') = 0，
  // 走到預設分支變成空字串。兩種都是「其實沒有值」被安靜存成「有值」。
  if (s === '') {
    throw new ValidationError(`${def.key}：值是空的`)
  }

  switch (def.type) {
    case 'date': {
      const d = toDate(String(s))            // toDate 內部已折全形（foldFullWidth）
      if (!d || d.length !== 10) throw new ValidationError(`${def.key}：看不懂的日期「${s}」`)
      return d
    }
    case 'month': {
      const d = toDate(String(s))            // 同上
      if (!d) throw new ValidationError(`${def.key}：看不懂的年月「${s}」`)
      return d.slice(0, 7)
    }
    case 'tel': {
      // toE164 內部折全形＋量長度，量不出來會回 null。這裡照樣丟錯 ——
      // 電話這一條的規矩是「寧可要人重打，也不要存半截號碼」。
      const t = toE164(String(s))
      if (!t) throw new ValidationError(`${def.key}：看不懂的電話「${s}」`)
      return t
    }
    case 'email': {
      // 用 foldFullWidth 不用 toHalfWidth：toHalfWidth 折不掉全形的「＠」「．」，
      // 「ｗａｎｇ＠ｅｘａｍｐｌｅ．ｃｏｍ」折完還是比不中下面的格式，整筆被擋掉。
      // email 裡的 @ 和 . 不可能是「內容」，一律折成半形才是它的正規格式。
      const e = foldFullWidth(String(s)).toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new ValidationError(`${def.key}：不是 email「${s}」`)
      return e
    }
    case 'url': {
      // 先拿原字串試。為什麼不一開始就折全形：網址的 path/query 裡的全形字
      // 有可能是真的內容（URL 會把它 percent-encode 起來），先折就等於安靜換了一個網址。
      const original = String(s)
      const parsed = tryURL(original)
      if (parsed) return parsed
      // 原字串 parse 不動，才輪到「這大概是全形打出來的」這個假設：
      // ｈｔｔｐｓ：／／ｅｘａｍｐｌｅ．ｃｏｍ 折完就是一個正常網址。
      const folded = tryURL(foldFullWidth(original))
      if (folded) return folded
      throw new ValidationError(`${def.key}：不是網址「${s}」`)
    }
    case 'enum': {
      // 折英數就好，不折標點：enum 的值是人寫在註冊表裡的中文（「役畢」「可遠端」），
      // 但值本身若含英數（未來可能有「B1」「Level 2」這種），全形版要比得中。
      const v = toHalfWidth(String(s))
      if (!def.enum?.includes(v)) {
        throw new ValidationError(`${def.key}：「${v}」不在允許的值裡（${def.enum?.join('、')}）`)
      }
      return v
    }
    case 'number': {
      // Number('１２３') 是 NaN —— 不折的話，全形數字一律變成「不是數字」被擋掉。
      // 注意 raw 也可能本來就是 number，那就不要拿它去跑字串處理。
      const n = typeof s === 'string' ? Number(toHalfWidth(s)) : Number(s)
      if (!Number.isFinite(n)) throw new ValidationError(`${def.key}：不是數字「${s}」`)
      return n
    }
    case 'boolean':
      // 「有值就是 true」。raw 本來就是 boolean 的時候沒問題，
      // 但字串的 'false'、'否'、'0' 也一律變成 true —— 這是 truthy 判斷天生的坑，
      // 不是量過之後的結論。哪天要收字串型的是／否，這裡就得明確比對兩邊的字面值，
      // 不能繼續靠 Boolean()。（這一輪的範圍只到折全形，所以先原樣留著。）
      return Boolean(s)
    case 'text':
      // 這一條刻意不折全形：toHalfWidth 會把 \n 併進 \s+ 壓成一個空格，
      // 自傳、工作說明整篇會被壓成一行。長文的排版本身就是內容。
      return String(s)
    default:
      return toHalfWidth(String(s))    // 全形轉半形，去多餘空白
  }
}

/** parse 得動就回正規化後的網址，parse 不動回 null（讓呼叫端決定要不要再試一次） */
function tryURL(s: string): string | null {
  try { return new URL(s).toString() }
  catch { return null }
}

/** 算到期日。expiry 是 key 的屬性，不是資料的屬性。 */
export function expiryFor(def: FactKeyDef, now: Date, explicit?: string | null): string | null {
  switch (def.expiry) {
    case 'never': return null
    case 'explicit': return explicit ?? null
    case 'months:6': return addMonths(now, 6)
    case 'months:12': return addMonths(now, 12)
  }
}

const addMonths = (d: Date, n: number) => {
  const x = new Date(d)
  x.setMonth(x.getMonth() + n)
  return x.toISOString()
}

/** 一次把關完：認 key、正規化值、決定敏感度與到期日 */
export function vet(key: string, raw: unknown, now: Date, explicitExpiry?: string | null) {
  const { keyDef, idx } = parseKey(key)
  const def = defOf(keyDef)
  if (!def) throw new ValidationError(`不認得的 key：${key}`)
  if (def.repeatable && idx === null) throw new ValidationError(`${key} 是可重複欄位，要帶序號，例如 ${keyDef.replace('[]', '[0]')}`)
  if (!def.repeatable && idx !== null) throw new ValidationError(`${key} 不是可重複欄位，不該帶序號`)
  if (def.sensitivity === 'secret') throw new ValidationError(`${key} 是 secret 級，這個系統不存這種東西`)

  return {
    def, keyDef, idx,
    value: normalizeValue(def, raw),
    sensitivity: def.sensitivity as Sensitivity,
    fill: fillModeOf(def),
    expiresAt: expiryFor(def, now, explicitExpiry),
  }
}
