/**
 * 寫進事實庫之前的把關。
 * 三件事：key 認不認得、值合不合法、敏感度是多少（從註冊表拿，不信呼叫端）。
 */
import { defOf, fillModeOf, type FactKeyDef, type Sensitivity } from '../schema/factKeys.ts'
import { toDate, toE164, toHalfWidth } from '../schema/normalize.ts'

export class ValidationError extends Error {}

/** education[0].school → { keyDef: 'education[].school', idx: 0 } */
export function parseKey(key: string) {
  const m = key.match(/\[(\d+)\]/)
  return { keyDef: key.replace(/\[\d+\]/g, '[]'), idx: m ? Number(m[1]) : null }
}

/** 回傳正規化過的值。看不懂就丟錯，不要猜。 */
export function normalizeValue(def: FactKeyDef, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === '') {
    throw new ValidationError(`${def.key}：值是空的`)
  }
  const s = typeof raw === 'string' ? raw.trim() : raw

  switch (def.type) {
    case 'date': {
      const d = toDate(String(s))
      if (!d || d.length !== 10) throw new ValidationError(`${def.key}：看不懂的日期「${s}」`)
      return d
    }
    case 'month': {
      const d = toDate(String(s))
      if (!d) throw new ValidationError(`${def.key}：看不懂的年月「${s}」`)
      return d.slice(0, 7)
    }
    case 'tel': {
      const t = toE164(String(s))
      if (!t) throw new ValidationError(`${def.key}：看不懂的電話「${s}」`)
      return t
    }
    case 'email': {
      const e = String(s).toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new ValidationError(`${def.key}：不是 email「${s}」`)
      return e
    }
    case 'url': {
      try { return new URL(String(s)).toString() }
      catch { throw new ValidationError(`${def.key}：不是網址「${s}」`) }
    }
    case 'enum': {
      const v = String(s)
      if (!def.enum?.includes(v)) {
        throw new ValidationError(`${def.key}：「${v}」不在允許的值裡（${def.enum?.join('、')}）`)
      }
      return v
    }
    case 'number': {
      const n = Number(s)
      if (!Number.isFinite(n)) throw new ValidationError(`${def.key}：不是數字「${s}」`)
      return n
    }
    case 'boolean':
      return Boolean(s)
    case 'text':
      return String(s)                 // 長文不要壓縮換行
    default:
      return toHalfWidth(String(s))    // 全形轉半形，去多餘空白
  }
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
