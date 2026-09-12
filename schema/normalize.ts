/**
 * ContextBox — 值的正規化
 *
 * 抽取層拿到模型的輸出後，一定要先過這裡才寫進事實庫。
 * 存的是正規格式，顯示的時候再轉回人看的格式。
 */

/**
 * 民國年 → 西元。
 * 台灣的畢業證書、身分證、政府表單全部是民國年，模型常常照抄。
 * 「115年6月」→ 2026-06　　「民國 89 年 3 月 15 日」→ 2000-03-15
 */
export function rocToAD(raw: string): string | null {
  // 全形數字要先折成半形，不然下面的 (?<!\d) 攔不住：\d 只涵蓋 [0-9]，
  // 「２024年6月」會被切成「024年」→ 1935-06，一樣是安靜地弄壞資料。
  raw = toHalfWidth(raw)
  // (?<!\d) 很重要：沒有它的話，「2024年」會被切成「024年」當成民國 24 年，
  // 變成 1935 年。這個 bug 會安靜地把每一個西元日期弄壞。
  const m = raw.match(/(?:民國\s*)?(?<!\d)(\d{1,3})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?/)
  if (!m) return null
  const roc = parseInt(m[1], 10)
  if (roc < 1 || roc > 200) return null      // 民國年只可能在這個範圍
  const y = roc + 1911
  const mo = m[2].padStart(2, '0')
  return m[3] ? `${y}-${mo}-${m[3].padStart(2, '0')}` : `${y}-${mo}`
}

/** 各種日期寫法 → YYYY-MM-DD 或 YYYY-MM。看不懂就回 null，不要猜。 */
export function toDate(raw: string): string | null {
  const s = toHalfWidth(raw).trim()      // 全形數字先折半形，理由同 rocToAD
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(s)) return s

  // 先試西元四位數，再試民國。順序反了的話「2024年6月」會被民國分支搶走。
  const ad = s.match(/(?<!\d)(\d{4})\s*[年\/\-.]\s*(\d{1,2})(?:\s*[月\/\-.]\s*(\d{1,2}))?/)
  if (ad) {
    const mo = ad[2].padStart(2, '0')
    return ad[3] ? `${ad[1]}-${mo}-${ad[3].padStart(2, '0')}` : `${ad[1]}-${mo}`
  }
  const roc = rocToAD(s)
  if (roc) return roc
  return null
}

/** 台灣手機 → E.164。0912-345-678 / 0912345678 / +886912345678 → +886912345678 */
export function toE164(raw: string, cc = '886'): string | null {
  const d = raw.replace(/[^\d+]/g, '')
  if (d.startsWith('+')) return d
  if (d.startsWith('0')) return `+${cc}${d.slice(1)}`
  if (d.startsWith(cc)) return `+${d}`
  return null
}

/** 顯示用：+886912345678 → 0912-345-678 */
export const phoneForDisplay = (e164: string) => {
  const m = e164.match(/^\+886(9\d{2})(\d{3})(\d{3})$/)
  return m ? `0${m[1]}-${m[2]}-${m[3]}` : e164
}

/**
 * 地址：有些表單給你一格，有些分成縣市／區／路。
 * 所以整串和拆開的都要存，不要二選一。
 */
export function splitAddress(full: string) {
  const m = full.match(/^(\d{3,5})?\s*(.{2,3}[市縣])(.{1,4}[區鄉鎮市])?(.*)$/)
  return {
    full: full.trim(),
    postalCode: m?.[1] ?? null,
    city: m?.[2] ?? null,
    district: m?.[3] ?? null,
    rest: m?.[4]?.trim() ?? null,
  }
}

/** 全形轉半形 ＋ 去掉多餘空白。模型從圖片抽出來的字常常是全形。 */
export const toHalfWidth = (s: string) =>
  s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
   .replace(/　/g, ' ')
   .replace(/\s+/g, ' ')
   .trim()
