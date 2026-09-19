import { FAKE_HOME } from './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * P3 ・ 名字清理與序號的**性質**，加上一份慢的參考實作當對照組。
 *
 * ── 為什麼有這一支 ────────────────────────────────────────────
 *
 * build-round 的 Step 3 要拿一個**乾淨上下文的第二個腦袋**重推一次。這一輪跑的時候手上沒有
 * 可以指派的 agent，所以換成 Step 4 的做法：照**預想檔的文字**另外寫一份慢的參考實作
 * （逐字元的迴圈，**一條正規式都不用**），再用結構化隨機輸入跟正式實作逐一對照。
 *
 * 這樣抓得到的是這一段最可能出錯的那一類：正規式的字元範圍寫錯、代理對被切斷、
 * 清理的順序顛倒。抓不到的是「我對規格的理解本來就錯了」—— 那一類靠預想檔裡寫死的成對例子
 * （test/rename.test.mjs）守著。
 *
 * ── 性質（對**任何**輸入都要成立）───────────────────────────
 *
 *   1. 洗出來的名字裡沒有路徑分隔符號、控制字元、方向字元、Windows 不能用的字元
 *   2. 不以點或空白開頭或結尾（Windows 會安靜吃掉結尾的點）
 *   3. 不是 Windows 保留名稱
 *   4. 不超過 80 個碼位，而且沒有落單的代理（不可以切在代理對中間）
 *   5. 冪等：洗過的再洗一次還是自己
 *   6. 副檔名一律是原本那一個
 *   7. 序號：挑出來的名字一定不在「已經被佔走」那一組裡（不分大小寫），而且副檔名不變
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanName, freeName, NAME_MAX_CODEPOINTS, originalExt, suggestedFileName, SUFFIX_MAX,
} from '../core/rename.ts'

// ═══ 慢的參考實作（照預想檔的文字寫，不看正式實作）═════════════

const SEPARATORS = ['/', '\\']
const WIN_ILLEGAL = [':', '<', '>', '"', '|', '?', '*']
const RESERVED_WORDS = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 10 }, (_, i) => 'com' + i),
  ...Array.from({ length: 10 }, (_, i) => 'lpt' + i),
])

/** 這個碼位是控制字元或方向字元嗎（逐一列，不用範圍）。 */
function isControlOrBidi(cp) {
  if (cp <= 0x1f) return true
  if (cp >= 0x7f && cp <= 0x9f) return true
  if (cp === 0x061c) return true
  if (cp === 0x200e || cp === 0x200f) return true
  if (cp >= 0x2028 && cp <= 0x202e) return true
  if (cp >= 0x2066 && cp <= 0x2069) return true
  return false
}

/** 空白（\s 認得的那些；這裡只列得到的幾類，剩下用 trim 判）。 */
const isSpace = ch => ch !== '' && ch.trim() === ''

/** 前後的空白與點去掉。 */
function trimEdges(points) {
  let a = 0, b = points.length
  while (a < b && (points[a] === '.' || isSpace(points[a]))) a++
  while (b > a && (points[b - 1] === '.' || isSpace(points[b - 1]))) b--
  return points.slice(a, b)
}

/** 最後那一段是不是「模型自己帶的副檔名」：1～10 個英數字，而且至少一個字母。 */
function ownExtCut(s) {
  const dot = s.lastIndexOf('.')
  if (dot <= 0) return -1
  const ext = s.slice(dot + 1)
  if (ext.length < 1 || ext.length > 10) return -1
  let letter = false
  for (const ch of ext) {
    const ok = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')
    if (!ok) return -1
    if (!(ch >= '0' && ch <= '9')) letter = true
  }
  return letter ? dot : -1
}

/** 參考實作：慢、笨、逐字元，但每一步都直接對得上預想檔的一句話。 */
function slowClean(suggested, ext = '') {
  if (typeof suggested !== 'string' || suggested === '') return ''
  if (suggested.length > 100_000) return ''
  let points = [...suggested].slice(0, 4096).join('').normalize('NFC')
  // 一個一個看：分隔符號、控制字元與方向字元、Windows 不能用的字元都丟掉
  const kept = []
  for (const ch of points) {
    if (SEPARATORS.includes(ch)) continue
    if (WIN_ILLEGAL.includes(ch)) continue
    if (isControlOrBidi(ch.codePointAt(0))) continue
    kept.push(ch)
  }
  // 連在一起的空白收成一個半形空白
  const squeezed = []
  for (const ch of kept) {
    if (isSpace(ch)) {
      if (squeezed.length && squeezed[squeezed.length - 1] === ' ') continue
      squeezed.push(' ')
    } else squeezed.push(ch)
  }
  let s = trimEdges(squeezed).join('')
  const cut = ownExtCut(s)
  if (cut > 0) s = trimEdges([...s.slice(0, cut)]).join('')
  if (s === '') return ''
  if (RESERVED_WORDS.has(s.toLowerCase())) return ''
  // 上限 80 個碼位；整個檔名不可以超過 250 個位元組
  let cp = [...s].slice(0, NAME_MAX_CODEPOINTS)
  while (cp.length && Buffer.byteLength(cp.join('') + ext, 'utf8') > 250) cp.pop()
  s = trimEdges(cp).join('')
  if (s === '' || RESERVED_WORDS.has(s.toLowerCase())) return ''
  return s
}

/** 參考實作：序號。從 2 一路試到 99，第一個沒被佔走的就是它。 */
function slowFree(wanted, ext, taken) {
  const has = n => taken.has(n.toLowerCase())
  if (!has(wanted)) return wanted
  const stem = ext && wanted.endsWith(ext) ? wanted.slice(0, wanted.length - ext.length) : wanted
  for (let n = 2; n <= SUFFIX_MAX; n++) {
    const suffix = '-' + n
    let cp = [...stem].slice(0, NAME_MAX_CODEPOINTS)
    while (cp.length && Buffer.byteLength(cp.join('') + suffix + ext, 'utf8') > 250) cp.pop()
    const candidate = trimEdges(cp).join('') + suffix + ext
    if (!has(candidate)) return candidate
  }
  return ''
}

// ═══ 結構化隨機：合法但刁鑽 ═══════════════════════════════════

/** 一個可重現的偽亂數（xorshift32）。種子寫死，紅了要重現得出來。 */
function rng(seed) {
  let x = seed | 0 || 1
  return () => {
    x ^= x << 13; x |= 0
    x ^= x >>> 17
    x ^= x << 5; x |= 0
    return (x >>> 0) / 4294967296
  }
}

/** 拼名字用的零件。**刁鑽但合法**：純亂數九成落在同一條分支上，等於只跑了一次。 */
const PIECES = [
  '/', '\\', '..', '.', '  ', '\u0000', '\u001f', '\u007f', '\u202E', '\u200e', '\u2069', '\u061c',
  ':', '<', '>', '"', '|', '?', '*',
  'CON', 'con', 'nul', 'COM1', 'lpt9', 'AUX',
  '作業系統', '死結', 'etc', 'passwd', 'a', 'Z', '0', '9', '_', '-', '（', '）', '、',
  '𠮷', '😀', 'é', 'ｱ', 'ー', '・',
  '.txt', '.pdf', '.tar.gz', '.第二版',
  '中'.repeat(40), 'a'.repeat(120), '😀'.repeat(30),
  '', ' ', '\n', '\t',
]
const EXTS = ['', '.txt', '.pdf', '.PNG', '.tar.gz', '.a1b2c3d4e5']

function sample(seed) {
  const r = rng(seed)
  const pick = list => list[Math.floor(r() * list.length) % list.length]
  const n = 1 + Math.floor(r() * 6)
  let s = ''
  for (let i = 0; i < n; i++) s += pick(PIECES)
  return { name: s, ext: pick(EXTS) }
}

/** 固定要跑的種子輸入：邊界兩側、空的、極長、重複、只剩符號。 */
const SEEDS = [
  '', ' ', '.', '..', '...', '/', '//', '\\', './', '../', '../../etc/passwd', '/etc/shadow',
  'CON', 'CON.txt', 'con.', ' CON ', 'CONTEXT', 'COM10',
  '中'.repeat(NAME_MAX_CODEPOINTS - 1), '中'.repeat(NAME_MAX_CODEPOINTS), '中'.repeat(NAME_MAX_CODEPOINTS + 1),
  '𠮷'.repeat(NAME_MAX_CODEPOINTS), '😀'.repeat(NAME_MAX_CODEPOINTS + 1),
  'a'.repeat(4095), 'a'.repeat(4096), 'a'.repeat(4097),
  '作業系統_死結', '作業系統_死結.pdf', '報告.第二版', 'hw3.1', '.env', '.bashrc',
  '\u0000', '\u202E', 'invoice\u202Efdp.exe', '好檔案\n✔ 已刪除',
  'a:b', 'a<b>c', 'a|b?c*d', '  ..名字..  ',
]

describe('名字清理的性質', () => {
  const all = [...SEEDS.map(name => ({ name, ext: '' })), ...Array.from({ length: 600 }, (_, i) => sample(i + 1))]

  test('對照組：跟慢的參考實作一模一樣', () => {
    const diffs = []
    for (const { name, ext } of all) {
      const got = cleanName(name, ext)
      const want = slowClean(name, ext)
      if (got !== want) diffs.push({ name, ext, got, want })
    }
    assert.deepEqual(diffs.slice(0, 5), [], `${diffs.length} 個對不上`)
  })

  test('性質 1–4：洗出來的名字一定是安全的', () => {
    for (const { name, ext } of all) {
      const out = cleanName(name, ext)
      if (out === '') continue
      assert.ok(!out.includes('/') && !out.includes('\\'), `分隔符：${JSON.stringify(out)}`)
      for (const ch of out) {
        const cp = ch.codePointAt(0)
        assert.ok(!isControlOrBidi(cp), `控制／方向字元：${JSON.stringify(out)}`)
        assert.ok(!WIN_ILLEGAL.includes(ch), `Windows 不能用的字元：${JSON.stringify(out)}`)
      }
      assert.ok(!/^[\s.]/u.test(out) && !/[\s.]$/u.test(out), `前後有點或空白：${JSON.stringify(out)}`)
      assert.ok(!RESERVED_WORDS.has(out.toLowerCase()), `保留名稱：${out}`)
      assert.ok([...out].length <= NAME_MAX_CODEPOINTS, `太長：${[...out].length}`)
      assert.doesNotMatch(out, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, `落單的高位代理：${JSON.stringify(out)}`)
      assert.doesNotMatch(out, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, `落單的低位代理：${JSON.stringify(out)}`)
    }
  })

  test('性質 5：冪等（洗過的再洗一次還是自己）', () => {
    for (const { name, ext } of all) {
      const once = cleanName(name, ext)
      if (once === '') continue
      assert.equal(cleanName(once, ext), once, `不冪等：${JSON.stringify(name)} → ${JSON.stringify(once)}`)
    }
  })

  test('性質 6：副檔名一律是原本那一個', () => {
    const originals = ['x.txt', 'IMG_2041.PNG', '未命名', '備份.tar.gz', '未命名文件 (3).txt']
    for (const original of originals) {
      const ext = originalExt(original)
      for (const { name } of all) {
        const full = suggestedFileName(original, name)
        if (full === '') continue
        assert.ok(full.endsWith(ext), `${JSON.stringify(name)} → ${full}，原本是 ${ext}`)
        assert.ok(Buffer.byteLength(full, 'utf8') <= 255, `${full} 有 ${Buffer.byteLength(full, 'utf8')} 個位元組`)
      }
    }
  })

  test('生成器驗收：每一條有趣的路徑都真的走到了', () => {
    const hit = { empty: 0, reserved: 0, truncated: 0, extStripped: 0, separators: 0, astral: 0 }
    for (const { name, ext } of all) {
      const out = cleanName(name, ext)
      if (out === '') hit.empty++
      if (RESERVED_WORDS.has(String(name).trim().toLowerCase())) hit.reserved++
      if ([...out].length === NAME_MAX_CODEPOINTS) hit.truncated++
      if (ownExtCut(name) > 0) hit.extStripped++
      if (name.includes('/') || name.includes('\\')) hit.separators++
      if (/[\uD800-\uDBFF]/.test(name)) hit.astral++
    }
    for (const [k, n] of Object.entries(hit)) {
      assert.ok(n >= 5, `生成器沒有走到「${k}」（只有 ${n} 次）—— 先修生成器`)
    }
  })
})

describe('序號的性質', () => {
  /** 被佔走的名字：從一個底名長出 0～120 個變體（含只差大小寫的）。 */
  function takenSet(base, ext, howMany, mixCase) {
    const out = new Set()
    if (howMany > 0) out.add((mixCase ? base.toUpperCase() : base) + ext)
    for (let n = 2; n < howMany + 1; n++) out.add(`${base}-${n}${ext}`.toLowerCase())
    return new Set([...out].map(x => x.toLowerCase()))
  }

  test('對照組：跟慢的參考實作一模一樣', () => {
    const diffs = []
    for (const ext of ['', '.txt', '.tar.gz']) {
      for (const base of ['x', '作業系統_死結', '中'.repeat(79), '😀'.repeat(60)]) {
        for (const howMany of [0, 1, 2, 3, 50, 98, 99, 100]) {
          for (const mixCase of [false, true]) {
            const taken = takenSet(base, ext, howMany, mixCase)
            const got = freeName(base + ext, ext, taken)
            const want = slowFree(base + ext, ext, taken)
            if (got !== want) diffs.push({ base: base.slice(0, 8), ext, howMany, mixCase, got, want })
          }
        }
      }
    }
    assert.deepEqual(diffs.slice(0, 5), [], `${diffs.length} 個對不上`)
  })

  test('性質 7：挑出來的名字**一定不在**被佔走那一組裡（不分大小寫），副檔名不變', () => {
    for (const ext of ['', '.txt', '.TXT', '.tar.gz']) {
      for (const base of ['x', 'A', '作業系統_死結', '中'.repeat(79)]) {
        for (const howMany of [0, 1, 2, 7, 98, 99]) {
          const taken = takenSet(base, ext, howMany, howMany % 2 === 0)
          const out = freeName(base + ext, ext, taken)
          if (out === '') continue
          assert.ok(!taken.has(out.toLowerCase()), `${out} 已經被佔走了`)
          if (ext) assert.ok(out.endsWith(ext), `${out} 的副檔名變了`)
          assert.ok(Buffer.byteLength(out, 'utf8') <= 255, out)
        }
      }
    }
  })

  test('性質：被佔走的愈多，序號只會往後，不會往前', () => {
    let previous = 0
    for (let howMany = 1; howMany <= 20; howMany++) {
      const out = freeName('x.txt', '.txt', takenSet('x', '.txt', howMany, false))
      const n = Number(/-(\d+)\.txt$/.exec(out)?.[1] ?? 0)
      assert.ok(n > previous, `${howMany} 個被佔走時挑到 ${out}，上一次是 -${previous}`)
      previous = n
    }
  })
})
