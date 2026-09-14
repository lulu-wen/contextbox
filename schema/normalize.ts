/**
 * ContextBox — 值的正規化
 *
 * 抽取層拿到模型的輸出後，一定要先過這裡才寫進事實庫。
 * 存的是正規格式，顯示的時候再轉回人看的格式。
 *
 * 全形的處理分兩套，不要混用（混用過一次，代價是電話被安靜截短）：
 *   toHalfWidth   人看的欄位（姓名、地址、備註）—— 只折英數與空白，
 *                 全形標點是內容的一部分，折掉就等於改了原文。
 *   foldFullWidth 機器格式（電話、日期、email、網址）—— 整塊全形 ASCII 都折掉，
 *                 這些格式裡的「＋＠．／：－」只可能是輸入法留下的殘渣。
 *
 * 共同鐵則：折完之後一定要量長度／比格式。折半形只是把字救回來，
 * 「量得出來不對就回 null」才是防止靜默截短的那道線。
 */

/** 台灣國碼。只有這個國碼才套台灣的長度規則，別國的號碼不能拿台灣的尺去量。 */
const TW_CC = '886'

/**
 * 民國年 → 西元。
 * 台灣的畢業證書、身分證、政府表單全部是民國年，模型常常照抄。
 * 「115年6月」→ 2026-06　　「民國 89 年 3 月 15 日」→ 2000-03-15
 */
export function rocToAD(raw: string): string | null {
  // 用新的區域變數，不要回頭蓋掉參數 raw：函式中段以後 raw 就不是呼叫端傳進來的東西了，
  // 之後有人在下面加一行 log(raw) 會印出跟輸入不一樣的字，追 bug 會被誤導。
  //
  // 折全形的理由：下面的 (?<!\d) 只認 [0-9]，全形數字擋不住，
  // 「２024年6月」會被切成「024年」→ 1935-06，一樣是安靜地弄壞資料。
  // 這裡用 foldFullWidth 而不是 toHalfWidth，是因為日期分隔符也可能是全形（２０１８／９）。
  const s = foldFullWidth(raw)
  // (?<!\d) 很重要：沒有它的話，「2024年」會被切成「024年」當成民國 24 年，
  // 變成 1935 年。這個 bug 會安靜地把每一個西元日期弄壞。
  const m = s.match(/(?:民國\s*)?(?<!\d)(\d{1,3})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?/)
  if (!m) return null
  const roc = parseInt(m[1], 10)
  if (roc < 1 || roc > 200) return null      // 民國年只可能在這個範圍
  return isoOrNull(String(roc + 1911), m[2], m[3])
}

/** 各種日期寫法 → YYYY-MM-DD 或 YYYY-MM。看不懂就回 null，不要猜。 */
export function toDate(raw: string): string | null {
  // 折全形＋收空白。理由同 rocToAD：全形數字不折，(?<!\d) 與 \d{4} 都會比錯。
  const s = foldFullWidth(raw)

  // 已經是正規格式的也要走 isoOrNull：範圍檢查只裝在「要轉換」那一條路上的話，
  // 「2026-13-45」照樣原樣存進去 —— 防線只裝一條路等於沒裝。
  const iso = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/)
  if (iso) return isoOrNull(iso[1], iso[2], iso[3])

  // 先試西元四位數，再試民國。順序反了的話「2024年6月」會被民國分支搶走。
  const ad = s.match(/(?<!\d)(\d{4})\s*[年\/\-.]\s*(\d{1,2})(?:\s*[月\/\-.]\s*(\d{1,2}))?/)
  if (ad) return isoOrNull(ad[1], ad[2], ad[3])

  // 已經折過全形了，rocToAD 會再折一次；foldFullWidth 是冪等的，折兩次跟折一次一樣。
  return rocToAD(s)
}

/**
 * 組出 YYYY-MM 或 YYYY-MM-DD，月份／日超出範圍就回 null。
 * 西元、民國、已經正規化的三條路共用同一份檢查，才不會只有其中一條擋得住「13 月」。
 * 這裡只擋明顯不可能的數字（月 1-12、日 1-31），不查每個月幾天 ——
 * 那要看閏年，不是這一層的事；但「2018-13」這種一定是抽錯了，不該寫進事實庫。
 */
function isoOrNull(year: string, month: string, day?: string): string | null {
  const mon = parseInt(month, 10)
  if (!(mon >= 1 && mon <= 12)) return null
  const mo = String(mon).padStart(2, '0')
  if (day === undefined) return `${year}-${mo}`
  const d = parseInt(day, 10)
  if (!(d >= 1 && d <= 31)) return null
  return `${year}-${mo}-${String(d).padStart(2, '0')}`
}

/**
 * 台灣電話 → E.164。0912-345-678 / 0912345678 / +886912345678 → +886912345678
 *
 * 兩件事一定要一起做，少做任何一件都會安靜地存進半截號碼：
 *
 *  1. 先折全形。舊版直接 raw.replace(/[^\d+]/g, '')，而 \d 只涵蓋 [0-9]，
 *     全形數字會被當成雜訊刪掉：「0912-345-６７８」→「0912345」→ +886912345。
 *     號碼短了三碼、一個錯都不丟，打出去是別人家的電話。
 *     「＋886…」的全形加號也一樣，被刪掉就變成「沒有國碼」。
 *
 *  2. 折完還要量長度。刪雜訊這個動作天生看不出「刪掉的是不是真的數字」，
 *     長度是唯一還量得出來的訊號。長度不對就回 null，讓上層丟錯去問人。
 *     寧可要人重打一次，也不要存半截號碼。
 *
 * cc 是「沒寫國碼時當成哪一國」。目前每一個呼叫端都用預設的 886，
 * 所以非台灣那幾條路現在跑不到；留著是因為長度規則本來就只有台灣的量得準，
 * 換了國碼就只能退回 E.164 本身的上下限 —— 這件事要寫在這裡，
 * 而不是讓後來的人以為那幾條路也有在驗長度。
 */
export function toE164(raw: string, cc: string = TW_CC): string | null {
  const folded = foldFullWidth(raw)
  // 開頭的 + 才是國碼記號；中間的 + 只可能是雜訊（「分機+123」），不給它意義。
  const hasPlus = folded.startsWith('+')
  const digits = folded.replace(/\D/g, '')
  if (!digits) return null

  if (hasPlus) {
    // 這裡比的是 TW_CC 而不是參數 cc：「+886 開頭」本身就是台灣號碼，
    // 跟呼叫端預設哪一國無關。寫成 cc === TW_CC && … 的話，
    // 只要有人傳了別的 cc，+886 的號碼就繞過台灣的長度檢查 —— 防線又只裝一條路。
    if (digits.startsWith(TW_CC)) return twE164(digits.slice(TW_CC.length))
    // 外國號碼原樣留著：別國的長度規則我們不知道，只能做 E.164 本身的上下限。
    return intlE164(digits)
  }
  // 本地寫法：0 開頭。去掉 0 之後就跟 +886 後面那一段是同一個東西，
  // 所以一定要走同一個檢查函式 —— 兩條路各寫一份檢查，遲早只修到其中一條。
  if (digits.startsWith('0')) {
    return cc === TW_CC ? twE164(digits.slice(1)) : intlE164(cc + digits.slice(1))
  }
  // 沒有 + 但帶國碼：886912345678
  if (digits.startsWith(cc)) {
    return cc === TW_CC ? twE164(digits.slice(cc.length)) : intlE164(digits)
  }
  return null
}

/**
 * 台灣本地碼（去掉開頭 0 或 +886 之後那一段）→ E.164，長度不對就 null。
 *   行動：9 開頭、共 9 碼    0912345678 → 912345678
 *   市話：共 8-9 碼          0227208889 → 227208889、089123456 → 89123456
 * 只量總長度，不拆區碼：區碼 1-2 碼、用戶號碼 6-8 碼，切法本身是猜的，
 * 猜錯就會把好號碼擋掉；總長度是不用猜也量得出來的那一個。
 * 兩種寫法（0 開頭與 +886）都經過這裡，防線才不會只裝在其中一條路上。
 */
function twE164(national: string): string | null {
  const ok = national.startsWith('9')
    ? national.length === 9
    : national.length === 8 || national.length === 9
  return ok ? `+${TW_CC}${national}` : null
}

/**
 * 非台灣號碼：只檢查 E.164 自己的上下限（含國碼最多 15 碼，最短的國家也要 7 碼）。
 * 這是理智檢查不是驗證 —— 量不出來的部分不裝懂，但「明顯是被截短的」要擋下來。
 */
function intlE164(digits: string): string | null {
  return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null
}

/** 顯示用：+886912345678 → 0912-345-678 */
export const phoneForDisplay = (e164: string) => {
  // 這裡不折全形：進來的是事實庫裡已經正規化過的 E.164，
  // 不是使用者剛打的字。要是真的塞了全形進來，比不中就原樣回去，不會生出半截號碼。
  const m = e164.match(/^\+886(9\d{2})(\d{3})(\d{3})$/)
  return m ? `0${m[1]}-${m[2]}-${m[3]}` : e164
}

/**
 * 地址：有些表單給你一格，有些分成縣市／區／路。
 * 所以整串和拆開的都要存，不要二選一。
 */
export function splitAddress(full: string) {
  // 先折全形再拆。郵遞區號的 \d{3,5} 只認半形，「１０６台北市…」不折的話
  // 不只 postalCode 拿不到，連 (.{2,3}[市縣]) 都會比不中 —— 四段全變 null，
  // 表單只剩一整串可以填。這裡用 toHalfWidth 而不是 foldFullWidth：
  // 地址是人看的內容，全形標點（「羅斯福路四段１號（２樓）」的全形括號、
  // 「台北市，大安區」的全形逗號）折掉就是改了原文，所以只折英數。
  const s = toHalfWidth(full)
  const m = s.match(/^(\d{3,5})?\s*(.{2,3}[市縣])(.{1,4}[區鄉鎮市])?(.*)$/)
  return {
    full: s,
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

/**
 * 機器格式專用的折半形：整塊全形 ASCII（U+FF01–U+FF5E）一次折回去，再收白空白。
 *
 * 為什麼要跟 toHalfWidth 分成兩個：
 *   toHalfWidth 只折英數，刻意不動全形標點 —— 姓名、地址、備註裡的「，。‧」是內容，
 *   折掉就是竄改原文。但電話、日期、email、網址是機器格式，
 *   裡面的「＋＠．／：－」只可能是輸入法留下的殘渣：
 *   ＋886… 不折會被當成沒有國碼，ｈｔｔｐｓ：／／ 不折根本 parse 不動。
 *
 * 折的是 ASCII 對應區，中文（年、月、日、民國）不在 U+FF01–U+FF5E 裡，動不到。
 * 冪等：折過的字串再折一次結果一樣，所以可以放心重複呼叫。
 */
export const foldFullWidth = (s: string) =>
  s.replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))  // ！ 到 ～
   .replace(/\u3000/g, ' ')                                                          // 全形空格
   .replace(/\s+/g, ' ')
   .trim()
