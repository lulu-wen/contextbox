/**
 * 「文件有沒有真的講到這個欄位」用的三支小工具。
 *
 * 本來只長在 test/repo.test.mjs 裡面（第三波 D5）。2026-09-20 加設定那條線的文件守門時
 * 需要同一套判斷 —— 複製一份的話，兩邊的「算有講到」遲早會各自漂走，
 * 而這三支的每一條規則都是被假綠咬過才加上去的（見各自的說明）。所以搬到這裡共用。
 *
 * 只有測試在用。自我測試在 test/repo.test.mjs，跟原本那幾條放在一起。
 */

/**
 * 一份 JSON 的**欄位集合**：每一個 key 的路徑。陣列的元素合併成 `[]`。值不管。
 * 例：`{ a: { b: 1 }, items: [{ x: 1 }, { y: 2 }] }` → a、a.b、items、items[].x、items[].y
 */
export function fieldSet(v, at = '', out = new Set()) {
  if (Array.isArray(v)) { for (const x of v) fieldSet(x, at + '[]', out); return out }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { const p = at ? `${at}.${k}` : k; out.add(p); fieldSet(x, p, out) }
  }
  return out
}

/**
 * markdown 的一節：從 `heading` 開頭的那一行，切到下一個**同級或更高一級**的標題為止。
 * 程式碼區塊裡的 `# 註解` 不算標題。找不到回空字串。
 *
 * 第三波 D5：上一版只切起點（`md.slice(md.indexOf(…))`），會一路吃到檔尾 ——
 * 後面幾節講到的欄位都被當成「這一節有講」。
 */
export function sectionOf(md, heading) {
  const level = /^#+/.exec(heading)?.[0].length ?? 0
  const lines = md.split('\n')
  let start = -1, fence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { fence = !fence; continue }
    if (fence) continue
    const h = /^(#+)\s/.exec(lines[i])
    if (!h) continue
    if (start < 0) { if (lines[i].startsWith(heading)) start = i; continue }
    if (h[1].length <= level) return lines.slice(start, i).join('\n')
  }
  return start < 0 ? '' : lines.slice(start).join('\n')
}

/**
 * 一份回應的欄位裡，`section` 沒講到的（第三波 D5）。算「有講到」的只有三種：
 *   - 完整路徑用反引號寫出來：`quarantine.canEmptyAt`
 *   - 父欄位＋子欄位出現在同一行：「`quarantine` 底下的 `total`」
 *   - 物件欄位（`watcher`）：它底下任何一個有講到就算
 * 上一版只要 README **任何地方**出現 `total`、`items` 就算有講 —— `quarantine.total`
 * 這種新欄位會被候選清單那一節的 `total` 蓋過去。
 */
export function undocumentedFields(section, body) {
  const paths = [...fieldSet(body)].map(p => p.replaceAll('[]', ''))
  const lines = section.split('\n')
  const tick = s => '`' + s + '`'
  const documented = p => {
    if (section.includes(tick(p))) return true
    if (paths.some(q => q.startsWith(p + '.') && documented(q))) return true
    const cut = p.lastIndexOf('.')
    if (cut < 0) return false
    const parent = tick(p.slice(0, cut)), child = tick(p.slice(cut + 1))
    return lines.some(l => l.includes(parent) && l.includes(child))
  }
  return [...new Set(paths)].filter(p => !documented(p))
}
