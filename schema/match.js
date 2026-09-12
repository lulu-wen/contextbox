/**
 * 欄位比對邏輯 —— 純 JS，沒有型別，因為擴充套件的 content script 也要用同一份。
 * 只有這裡有比對邏輯。factKeys.ts 和 extension/factTable.js 都是引用這支。
 */

/** 正規化：去空白與符號、全形轉半形、轉小寫 */
export function norm(s) {
  return String(s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s:：*＊()（）\[\]【】<>《》.,、。_\-—/\\]/g, '')
    .toLowerCase()
}

/** 從註冊表建索引，回傳一組查表工具 */
export function buildIndex(table) {
  const byAuto = new Map()
  const byAlias = new Map()

  const dupes = []
  for (const d of table) {
    if (d.autocomplete) {
      // 先登記的贏。重複代表註冊表寫錯了，要吵出來，不能靜默覆蓋。
      if (byAuto.has(d.autocomplete)) {
        dupes.push(`${d.autocomplete}: ${byAuto.get(d.autocomplete).key} vs ${d.key}`)
      } else {
        byAuto.set(d.autocomplete, d)
      }
    }
    for (const a of [d.label, ...d.aliases]) {
      const n = norm(a)
      if (n && !byAlias.has(n)) byAlias.set(n, d)
    }
  }
  if (dupes.length) {
    throw new Error('註冊表有重複的 autocomplete，兩個 key 會互搶：\n  ' + dupes.join('\n  '))
  }

  // 長的別名先比，避免「說」搶走「工作說明」
  const aliasesByLength = [...byAlias.entries()].sort((a, b) => b[0].length - a[0].length)

  /** 第 1 層：input 的 autocomplete 屬性 */
  function matchByAutocomplete(token) {
    if (!token) return null
    for (const part of String(token).trim().split(/\s+/).reverse()) {
      if (byAuto.has(part)) return byAuto.get(part)
    }
    return null
  }

  /** 第 2 層：label / placeholder / name 的文字 */
  function matchByLabel(text) {
    if (!text) return null
    const n = norm(text)
    if (!n) return null
    if (byAlias.has(n)) return byAlias.get(n)
    for (const [alias, def] of aliasesByLength) {
      if (alias.length >= 2 && n.includes(alias)) return def
    }
    return null
  }

  const defOf = key => table.find(d => d.key === String(key).replace(/\[\d+\]/g, '[]')) ?? null

  /** 查不到一律當最敏感。保守失敗，不是開放失敗。 */
  const sensitivityOf = key => defOf(key)?.sensitivity ?? 'sensitive'

  const canAutofill = key => ['public', 'normal'].includes(sensitivityOf(key))

  /**
   * 對應一個欄位。這裡放的是「哪一層說了算」的政策，只有這一份。
   *
   * 標籤優先於 autocomplete，因為：
   *   - 標籤是人看的，表單作者寫得比較用心也比較精確
   *   - autocomplete 常常是複製貼上來的，而且 url / name / tel 這種通用 token
   *     在一頁有多個同類欄位時一定會撞（作品連結 vs 個人網站）
   * autocomplete 的價值在「沒有標籤」的欄位，所以當保底。
   */
  function matchField({ autocomplete, labels = [] }) {
    const byAutoHit = matchByAutocomplete(autocomplete)
    for (const text of labels) {
      const hit = matchByLabel(text)
      if (hit) {
        return {
          def: hit, layer: 2, via: text,
          conflict: byAutoHit && byAutoHit.key !== hit.key ? byAutoHit.key : null,
        }
      }
    }
    if (byAutoHit) return { def: byAutoHit, layer: 1, via: autocomplete, conflict: null }
    return { def: null, layer: 0, via: null, conflict: null }
  }

  return { matchField, matchByAutocomplete, matchByLabel, defOf, sensitivityOf, canAutofill, norm }
}
