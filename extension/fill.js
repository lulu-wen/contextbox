/**
 * ContextBox —— 真的把值填進欄位的那一層
 *
 * ── 整個填入流程只有這一條路 ──────────────────────────────────
 *
 *   網頁              content.js               background.js        本機 server
 *   ────              ──────────               ─────────────        ──────────
 *   表單欄位 ─掃描─▶  labelCandidates
 *                     CB.matchField
 *                     CBFill.isVisible  ← 看不見的欄位在這裡就被丟掉，
 *                          │               不會送出去問，也不會被填
 *                          │
 *                          │  只送 key 的清單（沒有值、沒有標籤、沒有網址）
 *                          ▼
 *                     sendMessage ──────▶ 加上 token ──────▶ POST /form/plan
 *                                          的 fetch                  │
 *                          ◀──────────────  plan ────────────────────┘
 *                          │               （每個 key 一則指示）
 *                          │
 *                     人按下按鈕（event.isTrusted 一定要是 true）
 *                          │
 *                     CBFill.formatFor ← 庫裡的正規值轉成這一格要的樣子
 *                     CBFill.setValue  ← 原生 setter ＋ input／change 事件
 *                          │
 *   表單欄位 ◀─填入────────┘   值進到頁面。按送出永遠是人自己的動作。
 *
 * ── 這一支檔案的界線 ─────────────────────────────────────────
 *   只碰 DOM。不碰網路、不碰 token、不知道 server 在哪、不認得 chrome.*。
 *   所以它可以直接丟進 Node 裡測（見檔案最後的匯出）。
 *
 * ── 三件不准做的事 ───────────────────────────────────────────
 *   1. 不准送出表單。整支檔案不會出現 submit、form.submit、Enter 這些字眼。
 *   2. 不准填看不見的欄位。填之前一定要再跑一次 isVisible()。
 *   3. 不准自己決定要不要填。要不要填是 content.js 依照人的點擊決定的。
 */
;(function () {
  if (globalThis.CBFill) return          // 重複注入就不要再定義一次

  // ── 小工具 ──────────────────────────────────────────────────

  /** 全形轉半形。模型從圖片抽出來的字常常是全形，表單多半只收半形。 */
  const halfWidth = s => String(s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')

  /** 比對用的正規化。有 factTable.js 就用同一份，沒有就用這個簡化版。 */
  const norm = s => (globalThis.CB && globalThis.CB.norm)
    ? globalThis.CB.norm(s)
    : halfWidth(s).replace(/[\s:：*＊()（）[\]【】<>《》.,、。_\-—/\\]/g, '').toLowerCase()

  /** 這個 key 在註冊表裡長什麼樣。沒有 factTable.js 也要能動，所以包起來。 */
  function defOf(key) {
    try { return (globalThis.CB && globalThis.CB.defOf(key)) || null } catch { return null }
  }

  const tagOf = el => String(el && el.tagName || '').toLowerCase()
  const typeOf = el => String(el && el.type || '').toLowerCase()

  /** 這幾種 type 填錯格式不會報錯，會靜默變成空字串（HTML 規格叫 value sanitization）。 */
  const SILENT_BLANK = new Set(
    ['date', 'month', 'week', 'time', 'datetime-local', 'number', 'range', 'color'])

  /** 這幾種永遠不碰。按鈕類會送出表單，密碼類不該由我們填。 */
  const NEVER = new Set(['hidden', 'submit', 'button', 'image', 'reset', 'password'])

  // ── 一、原生 setter ─────────────────────────────────────────
  //
  // React 會在元素「自己身上」蓋一層 value 的 setter。直接寫 el.value = x
  // 會走那一層，React 以為值沒變過，下一次重繪就把我們填的蓋掉。
  // 所以要沿著原型鏈往上找原生的那一支，跳過它。
  //
  // 註：網路上最多人抄的 el._valueTracker.setValue('') 在這裡是廢的——
  // 擴充套件跑在 isolated world，看不到頁面掛在節點上的自訂屬性，
  // 那一行一定是 undefined，會直接丟 TypeError。不要好心加回來。

  /** 沿原型鏈找原生 setter。要往上找，不要寫死 HTMLInputElement.prototype。 */
  function nativeSetter(el, prop) {
    let o = Object.getPrototypeOf(el)
    while (o) {
      const d = Object.getOwnPropertyDescriptor(o, prop)
      if (d && d.set) return d.set
      o = Object.getPrototypeOf(o)
    }
    return null
  }

  function setNativeValue(el, value) {
    const set = nativeSetter(el, 'value')
    if (set) set.call(el, value)
    else el.value = value                // 真的找不到才退回去
  }

  /** input 原生是 composed:true，change 是 false。照原生的來，不要兩個都設。 */
  const fireInput = el => el.dispatchEvent(new InputEvent('input', {
    bubbles: true, composed: true, inputType: 'insertText', data: String(el.value ?? ''),
  }))
  const fireChange = el => el.dispatchEvent(new Event('change', { bubbles: true }))

  // ── 二、看得見嗎 ────────────────────────────────────────────
  //
  // 威脅模型報告講得很直白：看不見的欄位一律不填。
  // 只排掉 type=hidden 完全不夠——移到畫面外的、opacity:0 的、2px 見方的、
  // 被另一個元素整個蓋住的，長相都很正常。

  const num = (v, dflt) => { const n = parseFloat(v); return Number.isFinite(n) ? n : dflt }

  /**
   * 為什麼要 detail 版：面板要能告訴人「這一格為什麼沒填」，
   * 只回 true／false 的話那句話寫不出來。
   */
  function visibilityOf(el) {
    const no = why => ({ ok: false, why })
    if (!el || el.nodeType !== 1) return no('不是一個元素')
    if (!el.isConnected) return no('已經不在頁面上')
    if (NEVER.has(typeOf(el))) return no('這種欄位我們永遠不碰')
    if (el.hidden) return no('掛了 hidden 屬性')

    const win = (el.ownerDocument && el.ownerDocument.defaultView) || globalThis
    if (!win.getComputedStyle) return no('這裡沒有辦法算樣式')

    // 從自己往上走完整條祖先鏈。任何一層藏起來，底下的就都看不見。
    let opacity = 1
    for (let n = el; n && n.nodeType === 1;) {
      const s = win.getComputedStyle(n)
      if (!s) break
      if (s.display === 'none') return no('被 display:none 藏起來')
      if (s.visibility === 'hidden' || s.visibility === 'collapse') return no('被 visibility 藏起來')
      if (s.contentVisibility === 'hidden') return no('被 content-visibility 藏起來')
      if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') return no('標了 aria-hidden')
      if (/inset\(\s*(100|[1-9]\d\d)%|circle\(\s*0/.test(s.clipPath || '')) return no('被 clip-path 裁掉')
      if (/opacity\(\s*0(\.0+)?\s*\)/.test(s.filter || '')) return no('被 filter 弄成透明')
      opacity *= num(s.opacity, 1)
      if (opacity < 0.3) return no('幾乎是透明的')

      const parent = n.parentElement
      if (parent) { n = parent; continue }
      const root = n.getRootNode && n.getRootNode()
      n = (root && root.host) || null        // 穿過 shadow DOM 的邊界
    }

    if (String(win.getComputedStyle(el).webkitTextSecurity || 'none') !== 'none')
      return no('文字被遮成圓點，等於密碼欄')

    const rect = el.getBoundingClientRect()
    // radio 與 checkbox 本來就小（原生大約 13px），門檻要分開訂
    const small = typeOf(el) === 'radio' || typeOf(el) === 'checkbox'
    const minW = small ? 8 : 20, minH = small ? 8 : 10
    if (rect.width < minW || rect.height < minH) return no('小到看不見')

    // 被捲到畫面外不算看不見（長表單本來就要捲），但被移到文件外面就算。
    // 下界與**上界**都要擋：只擋負座標的話，left:99999px 藏起來的欄位照樣被填。
    const doc0 = el.ownerDocument, docEl = doc0.documentElement
    const left = rect.left + win.scrollX, top = rect.top + win.scrollY
    if (left + rect.width <= 0 || top + rect.height <= 0) return no('被移到畫面外')
    if (left >= docEl.scrollWidth || top >= docEl.scrollHeight) return no('被丟到文件範圍外')

    // 祖先鏈上只要有一層是 overflow:hidden/clip（使用者捲不到），
    // 元素就必須跟那一層有實際重疊，否則等於被裁掉看不見。
    for (let a = el.parentElement; a; a = a.parentElement) {
      const as = win.getComputedStyle(a)
      const clipped = /^(hidden|clip)$/.test(as.overflowX) || /^(hidden|clip)$/.test(as.overflowY)
      if (!clipped) continue
      const ar = a.getBoundingClientRect()
      const overlap = rect.right > ar.left && rect.left < ar.right
        && rect.bottom > ar.top && rect.top < ar.bottom
      if (!overlap) return no('被祖先的 overflow 裁掉了')
    }

    // 最關鍵的一條：中心點打下去，接到的是不是自己。
    // 一次擋掉所有「正常欄位被另一個元素蓋住」的手法。
    // 只有在視窗範圍內才測得出來，捲到看不到的地方就跳過這一條。
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2
    if (cx >= 0 && cy >= 0 && cx <= win.innerWidth && cy <= win.innerHeight) {
      const doc = el.ownerDocument
      const hit = doc.elementFromPoint(cx, cy)
      if (!hit) return no('中心點打不到東西')
      const ours = hit.closest && hit.closest('[data-cb]')     // 蓋住的是我們自己畫的標記
      const same = hit === el || el.contains(hit) || hit.contains(el)
        || (hit.shadowRoot && hit.shadowRoot.contains(el))
      if (!ours && !same) return no('被別的東西蓋住了')
    }
    return { ok: true, why: null }
  }

  const isVisible = el => visibilityOf(el).ok === true

  /** 看得見，而且真的填得進去。disabled 的欄位送出時根本不會被帶走。 */
  function canFill(el) {
    const v = visibilityOf(el)
    if (!v.ok) return v
    if (el.disabled) return { ok: false, why: '欄位被鎖住' }
    if (el.closest && el.closest('[inert]')) return { ok: false, why: '欄位被停用' }
    return { ok: true, why: null }
  }

  // ── 三、正在打中文的那一格不要動 ────────────────────────────
  //
  // Vue 的 v-model 在注音／拼音組字中會忽略 input 事件，這時候填進去會被吃掉，
  // 而且會把人家打到一半的字洗掉。isolated world 讀不到框架的 composing 旗標，
  // 所以自己記一份。

  const composing = new WeakSet()
  let composeWatched = false
  function watchComposition(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null)
    if (!d || composeWatched) return
    composeWatched = true
    d.addEventListener('compositionstart', e => { if (e.target) composing.add(e.target) }, true)
    d.addEventListener('compositionend', e => { if (e.target) composing.delete(e.target) }, true)
  }
  const isComposing = el => composing.has(el)

  // ── 四、選項比對（select 與 radio 共用）────────────────────
  //
  // 要比文字還是比 value？兩個都比，而且有先後。實務上 value 常常是代碼
  // （M／F／5），text 才是人看的字；但也有表單 value 就是中文。
  // 撞到兩個以上就不要猜——硬填一個不對的值比空著更糟，
  // 因為使用者按送出前根本不會發現。
  //
  // 只往「選項比我們的值更長」的方向放寬（男 → 男性），不往回走。
  // 反過來（我們是「替代役畢」，表單只有「役畢」）看起來像命中，其實是
  // 把事實改小了一號，而且人不會發現。那一種一律回報對不上，交給人自己選。

  function pickOption(all, want) {
    const w = String(want), nw = norm(w)
    // 「請選擇」這種佔位選項不參加模糊比對，免得被亂選中
    const real = all.filter(o => (!o.disabled && norm(o.value) !== '') || String(o.text).trim() === w)
    const tiers = [
      ['value 一樣', all, o => o.value === w],
      ['文字一樣', all, o => String(o.text).trim() === w],
      ['value 正規化後一樣', real, o => norm(o.value) === nw],
      ['文字正規化後一樣', real, o => norm(o.text) === nw],
      ['選項文字包含我們的值', real, o => nw && norm(o.text).includes(nw)],
    ]
    for (const [via, pool, fn] of tiers) {
      const hits = pool.filter(fn)
      if (hits.length === 1) return { ok: true, via, option: hits[0] }
      if (hits.length > 1) {
        return { ok: false, why: '有好幾個選項都像，不敢替你選', via, hits: hits.map(h => h.text) }
      }
    }
    return { ok: false, why: '這張表單沒有對應的選項' }
  }

  // ── 五、格式轉換 ────────────────────────────────────────────

  /** HTML 的 pattern 是整串錨定的。新的瀏覽器用 v flag，舊的退回 u。 */
  function matchesPattern(pattern, v) {
    if (!pattern) return true
    const src = '^(?:' + pattern + ')$'
    for (const flags of ['v', 'u', '']) {
      try { return new RegExp(src, flags).test(v) } catch { /* 換下一個 flag */ }
    }
    return true                           // pattern 本身寫壞了就不要擋人
  }

  /** 從候選清單裡挑第一個這一格收得下的。沒設 maxlength 是 -1，不是 0。 */
  function firstAllowed(el, candidates) {
    const max = el && el.maxLength > 0 ? el.maxLength : Infinity
    const pat = el && el.getAttribute ? el.getAttribute('pattern') : null
    const ok = candidates.find(v => String(v).length <= max && matchesPattern(pat, String(v)))
    return ok !== undefined ? ok : candidates[0]
  }

  // 民國年 ───────────────────────────────────────────────────
  function rocParts(iso) {
    const [y, m, d] = String(iso).split('-')
    const ry = Number(y) - 1911
    if (!Number.isFinite(ry) || ry < 1) return null      // 1911 年以前就退回西元，不要生出負數年
    return { y: String(ry), y3: String(ry).padStart(3, '0'), m, d }
  }

  /**
   * 分隔符照表單自己的示範走。
   * 「年 月 日」中間有東西才是格式範本；「入學年月」只是欄位名，不算。
   */
  function sepOf(hint) {
    const h = String(hint || '')
    if (/y{2,4}\s*\/\s*m{1,2}/i.test(h) || /\d\s*\/\s*\d/.test(h)) return '/'
    if (/y{2,4}\s*-\s*m{1,2}/i.test(h) || /\d{2,4}\s*-\s*\d/.test(h)) return '-'
    if (/y{4}\s*m{2}/i.test(h)) return ''
    if (/年[\s_○◯\d]{1,4}月/.test(h) || /\d\s*年/.test(h)) return 'cjk'
    return '/'                            // 沒有線索就用台灣表單最常見的 YYYY/MM/DD
  }

  /** 把這一格自己身上的提示收集起來。只看元素自己的屬性，不去撈整頁的字。 */
  function hintOf(el, extra) {
    if (!el || !el.getAttribute) return String(extra || '')
    return [el.placeholder, el.title, el.getAttribute('aria-label'),
            el.getAttribute('pattern'), extra].filter(Boolean).join(' ')
  }

  function dateCandidates(el, iso, hint) {
    const [y, m, d] = String(iso).split('-')
    const h = hintOf(el, hint)
    const isRoc = /民國|中華民國|\bROC\b/i.test(h)
    const s = sepOf(h)
    const j = (a, b, c) => s === 'cjk'
      ? (c ? `${a}年${b}月${c}日` : `${a}年${b}月`)
      : (c ? `${a}${s}${b}${s}${c}` : `${a}${s}${b}`)

    const out = []
    const r = rocParts(iso)
    if (isRoc && r) {
      // 中文寫法人習慣不補零（89年3月），純數字格才要補滿三碼（0890315）
      const [first, second] = s === 'cjk' ? [r.y, r.y3] : [r.y3, r.y]
      out.push(j(first, m, d), j(second, m, d), d ? `${r.y3}${m}${d}` : `${r.y3}${m}`)
    }
    out.push(j(y, m, d))
    out.push(d ? String(iso) : `${y}-${m}`)
    out.push(`${y}/${m}` + (d ? `/${d}` : ''))
    out.push(d ? `${y}${m}${d}` : `${y}${m}`)
    if (!isRoc && r) out.push(j(r.y3, m, d))            // 民國當最後備胎
    return [...new Set(out)]
  }

  // 電話 ─────────────────────────────────────────────────────
  // 四碼的放前面，比對時長的要先中。
  // 089 是台東市話、0989 是手機，光看前綴分不出來，所以先判手機。
  const TW_AREA = ['0826', '0836', '037', '049', '082', '089',
                   '02', '03', '04', '05', '06', '07', '08']

  function twParts(e164) {
    if (!/^\+886\d{8,9}$/.test(String(e164))) return null   // 外國號碼不拆
    const local = '0' + String(e164).slice(4)               // +886912345678 → 0912345678
    if (/^09\d{8}$/.test(local))
      return { kind: 'mobile', local, area: local.slice(0, 4), rest: local.slice(4) }
    const area = TW_AREA.find(p => local.startsWith(p))
    return area
      ? { kind: 'landline', local, area, rest: local.slice(area.length) }
      : { kind: 'unknown', local, area: null, rest: local }
  }

  function phoneCandidates(el, e164, hint) {
    const p = twParts(e164)
    if (!p) return [String(e164), String(e164).replace(/^\+/, '00')]
    const dashed = p.kind === 'mobile'
      ? `${p.local.slice(0, 4)}-${p.local.slice(4, 7)}-${p.local.slice(7)}`
      : `${p.area}-${p.rest}`
    const h = hintOf(el, hint)
    const list = [p.local, dashed, `(${p.area})${p.rest}`, `${p.area} ${p.rest}`, String(e164)]
    if (/\d-\d|－/.test(h)) list.unshift(dashed)            // 表單自己示範了要有橫線
    if (/\+?886/.test(h)) list.unshift(String(e164))
    return [...new Set(list)]
  }

  /** type=number 只收合法的數字。「50000元」或全形數字進去會靜默變空白。 */
  function numberForField(value) {
    const s = halfWidth(String(value)).replace(/[,，\s]/g, '').replace(/[^\d.\-+eE]/g, '')
    return s !== '' && Number.isFinite(Number(s)) ? s : null
  }

  /** 這個值該當成什麼型別看待。註冊表說了算，沒有註冊表就看值長什麼樣。 */
  function valueTypeOf(key, value) {
    const def = defOf(key)
    if (def && def.type) return def.type
    if (typeof value === 'boolean') return 'boolean'
    const s = String(value)
    if (/^\+\d{7,15}$/.test(s)) return 'tel'
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'date'
    if (/^\d{4}-\d{2}$/.test(s)) return 'month'
    return 'string'
  }

  /**
   * 依照目標元素與 key，把庫裡的正規值轉成這一格要的格式。
   *
   * 回 { value, guessed, warn, why }：
   *   value    要填進去的字串。null 代表不該填——寧可空著也不要填錯。
   *   guessed  有推算成分（例如庫裡只有年月，日是補的）。面板要標出來。
   *   warn     填得進去但可能被表單擋下（例如超過 maxlength）。
   *   why      value 是 null 的時候，說明為什麼。
   */
  function formatForDetail(el, key, value, hint) {
    const none = (why) => ({ value: null, guessed: null, warn: null, why })
    const ok = (v, guessed, warn) => ({ value: v, guessed: guessed || null, warn: warn || null, why: null })
    if (value === null || value === undefined) return none('庫裡沒有值')

    const t = valueTypeOf(key, value)
    const elType = typeOf(el)
    const tag = tagOf(el)

    // 勾選類：值原封不動交給 setValue，由它自己判斷要不要打勾
    if (t === 'boolean' || elType === 'checkbox' || elType === 'radio') return ok(value)
    // 注意：非布林值碰到 checkbox 時，setValueDetail 會改走選項比對，不會當成開關
    // 下拉：交給 pickOption 去比對選項，這裡不動它
    if (tag === 'select') return ok(String(value))

    if (t === 'tel' || /^\+\d{7,15}$/.test(String(value))) {
      if (elType === 'email' || elType === 'url' || elType === 'number')
        return none('這一格不是電話欄位')
      return ok(String(firstAllowed(el, phoneCandidates(el, String(value), hint))))
    }

    if (t === 'date' || t === 'month') {
      const iso = String(value)
      const [y, m, d] = iso.split('-')
      if (!/^\d{4}-\d{2}/.test(iso)) return none('庫裡這一筆不是日期')
      if (elType === 'month') return ok(`${y}-${m}`)      // 有日就截掉，安全
      if (elType === 'date') {
        return d ? ok(iso) : ok(`${y}-${m}-01`, '庫裡只有年月，「日」是我補的')
      }
      if (elType === 'week' || elType === 'time' || elType === 'datetime-local')
        return none('不知道怎麼把日期填進這種欄位')
      if (elType === 'number') {
        const n = numberForField(y)
        return n ? ok(n, '這一格只收數字，只填了年') : none('這一格只收數字')
      }
      return ok(String(firstAllowed(el, dateCandidates(el, iso, hint))))
    }

    if (elType === 'number' || elType === 'range') {
      const n = numberForField(value)
      return n ? ok(n) : none('這一格只收數字，庫裡這一筆不是純數字')
    }

    // 填進日期／時間欄位的東西一定要是日期，不然瀏覽器會靜默清空
    if (SILENT_BLANK.has(elType)) return none('庫裡這一筆的格式跟這一格對不起來')

    const s = String(value)
    const max = el && el.maxLength > 0 ? el.maxLength : Infinity
    if (s.length > max) return ok(s, null, `比這一格的上限長 ${s.length - max} 個字，表單可能會擋`)
    return ok(s)
  }

  const formatFor = (el, key, value, hint) => formatForDetail(el, key, value, hint).value

  // ── 六、填進去 ──────────────────────────────────────────────
  //
  // 順序固定：focus → 原生 setter → input → change → blur。
  //   少了 focus  ：有些站的驗證要「碰過」才跑
  //   少了 input  ：框架完全不知道值變了，重繪就蓋回去
  //   少了 change ：連動欄位（縣市→區）不會更新，錯誤訊息不會消
  //   少了 blur   ：紅色「此欄必填」留在畫面上，人以為沒填成功
  // 最後一定要讀回來比對——有八種 type 填錯會靜默變成空字串。

  /** 有日曆／自動完成的欄位不要 focus，不然會彈出一個蓋住半頁的面板。 */
  function hasPicker(el) {
    if (!el || !el.getAttribute) return false
    if (el.readOnly) return true
    if (el.getAttribute('aria-haspopup') === 'listbox') return true
    return /picker|calendar|datepicker|flatpickr|autocomplete/i.test(
      `${el.className || ''} ${el.getAttribute('role') || ''}`)
  }

  function fillText(el, value) {
    const v = String(value)
    if (isComposing(el)) return { ok: false, why: '你正在這一格打字，先不動它' }
    if (el.value === v) return { ok: true, skipped: true, why: null }

    const picker = hasPicker(el)
    // preventScroll：一次填 30 格才不會整個畫面亂跳
    if (!picker && el.focus) el.focus({ preventScroll: true })
    setNativeValue(el, v)

    // 只有這幾種 type 動得了游標，email 與 number 呼叫會直接丟例外
    if (/^(text|search|url|tel|textarea|)$/.test(typeOf(el)) && el.setSelectionRange) {
      try { el.setSelectionRange(v.length, v.length) } catch { /* 不重要 */ }
    }
    fireInput(el)
    fireChange(el)
    if (!picker && el.blur) el.blur()      // blur() 原生就會發 blur ＋ focusout

    if (el.value === v) return { ok: true, why: null }
    if (el.value === '' && SILENT_BLANK.has(typeOf(el)))
      return { ok: false, why: '格式不合，瀏覽器把它清空了' }
    return { ok: false, why: '寫不進去', got: el.value }
  }

  function fillSelect(el, want) {
    const opts = [...el.options].map(o => ({
      text: o.text, value: o.value, disabled: o.disabled, el: o,
    }))
    const hit = pickOption(opts, want)
    if (!hit.ok) {
      // 選不到就不要退而求其次填最接近的，把選項交回去讓人自己點
      return { ok: false, why: hit.why, choices: opts.map(o => o.text) }
    }
    const target = hit.option.el
    if (el.multiple) for (const o of el.options) o.selected = (o === target)
    else setNativeValue(el, target.value)
    fireInput(el)
    fireChange(el)                         // 真人操作下拉也是 input 再 change
    if (el.value !== target.value) return { ok: false, why: '寫不進去' }
    // 使用者看到的文字跟表單真正會送出的 value 可以完全是兩回事，要說出來
    const shown = String(target.text).trim()
    const realValue = norm(target.value) !== norm(shown) ? target.value : null
    return { ok: true, via: hit.via, shown, realValue, why: null }
  }

  /** 同一組 radio 用 name 抓，不要整頁掃 */
  function radioGroup(el) {
    if (!el.name) return [el]
    const scope = el.form || el.ownerDocument
    return [...scope.querySelectorAll(
      `input[type=radio][name="${CSS.escape(el.name)}"]`)]
  }

  /** radio／checkbox 的文字：先用原生的 el.labels，比自己手挖穩 */
  function controlLabel(el) {
    const l = el.labels && el.labels[0]
    return (l && l.textContent) || (el.closest('label') || {}).textContent
      || el.getAttribute('aria-label') || el.value || ''
  }

  // React 對 radio 與 checkbox 聽的是 click，不是 change。
  // 所以這兩種一定要用 el.click()，自己指定勾選狀態再發 change 完全無效。
  // 這條路徑裡只准出現 click()，不准直接指定勾選狀態。
  function fillRadio(el, want) {
    const group = radioGroup(el)
    const hit = pickOption(
      group.map(r => ({ text: String(controlLabel(r)).trim(), value: r.value, disabled: r.disabled, el: r })),
      want)
    if (!hit.ok) return { ok: false, why: hit.why, choices: group.map(r => String(controlLabel(r)).trim()) }
    const target = hit.option.el
    if (target.disabled) return { ok: false, why: '這個選項被鎖住' }
    const v = visibilityOf(target)
    if (!v.ok) return { ok: false, why: `這個選項${v.why}` }
    if (!target.checked) target.click()    // 已經對了就別點，免得多發一輪事件
    return target.checked
      ? { ok: true, via: hit.via, shown: String(controlLabel(target)).trim(), why: null }
      : { ok: false, why: '點了但沒有被選起來' }
  }

  /** 只有真的是開關的值才走這裡。判斷不出來就交還給人，絕對不要靜靜取消勾選。 */
  function fillCheckbox(el, want) {
    if (el.disabled) return { ok: false, why: '這個選項被鎖住' }
    const s = String(want)
    const yes = want === true || want === 1 || /^(是|要|有|true|yes|y|on|1)$/i.test(s)
    const nope = want === false || want === 0 || /^(否|不|沒有|無|false|no|n|off|0)$/i.test(s)
    if (!yes && !nope) {
      // 「全職」這種 enum 值掉進來的話，過去會被當成「取消勾選」，
      // 把使用者自己勾好的那一格弄掉，還回報填好了。
      return { ok: false, why: '這一格是打勾欄，但庫裡的值不是「是／否」' }
    }
    const desired = yes
    if (el.checked !== desired) el.click()  // click() 是翻轉，所以先比對現況
    return el.checked === desired
      ? { ok: true, shown: desired ? '打勾' : '不打勾', why: null }
      : { ok: false, why: '點了但狀態沒變' }
  }

  /**
   * contenteditable 沒有 value 可以設，只能三段式退讓。
   * 這一版其實很少走到——會用 contenteditable 的欄位幾乎都是自傳、工作內容
   * 這種長文，而長文的填法是 compose，這一版不生成。
   */
  function fillEditable(el, text) {
    const doc = el.ownerDocument
    const win = doc.defaultView || globalThis
    if (!el.isContentEditable) return { ok: false, why: '不是可編輯區' }
    if (isComposing(el)) return { ok: false, why: '你正在這一格打字，先不動它' }
    if (doc.hasFocus && !doc.hasFocus())
      return { ok: false, why: '請先點一下頁面（焦點不在這一頁上）' }
    el.focus({ preventScroll: true })

    // 先全選，這樣插入等於取代
    try {
      const sel = win.getSelection()
      const range = doc.createRange()
      range.selectNodeContents(el)
      sel.removeAllRanges()
      sel.addRange(range)
    } catch { /* 選不起來就直接往下試 */ }

    // 第一招：最像真人打字，會正常發 beforeinput／input
    try { if (doc.execCommand('insertText', false, String(text))) return { ok: true, via: 'execCommand', why: null } }
    catch { /* 換下一招 */ }

    // 第二招：假裝貼上。被 preventDefault 代表編輯器接手了
    try {
      const dt = new DataTransfer()
      dt.setData('text/plain', String(text))
      const handled = !el.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt, bubbles: true, cancelable: true, composed: true,
      }))
      if (handled) return { ok: true, via: 'paste', why: null }
    } catch { /* 換下一招 */ }

    // 第三招：直接寫。只有「乾淨的 contenteditable ＋ 自己聽 input」會成功；
    // Slate、Draft 這種有自己文件模型的，下一次重繪就還原。
    el.textContent = String(text)
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, composed: true, inputType: 'insertText', data: String(text),
    }))
    return String(el.textContent).includes(String(text).slice(0, 20))
      ? { ok: true, via: 'textContent', why: null }
      : { ok: false, why: '這個編輯器不吃，請你自己貼上' }
  }

  /**
   * 把值填進元素。回 { ok, why, ... }。
   * setValue() 是它的布林版本——找不到對應的選項會回 false，不會亂填。
   */
  function setValueDetail(el, value) {
    if (!el || el.nodeType !== 1) return { ok: false, why: '沒有這個欄位' }
    const can = canFill(el)
    if (!can.ok) return { ok: false, why: can.why }

    const tag = tagOf(el), type = typeOf(el)
    if (NEVER.has(type)) return { ok: false, why: '這種欄位我們永遠不碰' }
    if (tag === 'select') return fillSelect(el, value)
    if (type === 'radio') return fillRadio(el, value)
    if (type === 'checkbox') {
      // 一組 checkbox 當多選題用（工作性質、技能）的話，值是選項文字不是開關。
      // 先試選項比對，比不中才當開關處理。
      if (typeof value !== 'boolean') {
        const group = value != null && el.name
          ? [...el.ownerDocument.querySelectorAll(
              `input[type=checkbox][name="${CSS.escape(el.name)}"]`)]
          : [el]
        const hit = pickOption(
          group.map(o => ({ el: o, text: controlLabel(o), value: o.value })), value)
        if (hit) {
          if (!hit.el.checked) hit.el.click()
          return hit.el.checked
            ? { ok: true, via: hit.via, shown: String(controlLabel(hit.el)).trim(), why: null }
            : { ok: false, why: '點了但沒有被選起來' }
        }
      }
      return fillCheckbox(el, value)
    }
    if (type === 'file') return { ok: false, why: '這一版還不填檔案欄位' }
    if (el.readOnly) return { ok: false, why: '欄位是唯讀的' }
    if (tag === 'input' || tag === 'textarea') return fillText(el, value)
    if (el.isContentEditable) return fillEditable(el, value)
    return { ok: false, why: '不知道怎麼填這種欄位' }
  }

  const setValue = (el, value) => setValueDetail(el, value).ok === true

  /**
   * 填入會發出 input／change／click，頁面可以在那些處理函式裡呼叫 form.submit()。
   * 我們說「永遠不會幫你按送出」，那就要真的擋住 —— 不只是自己不按。
   *
   * 頁面在自己的地盤上終究防不死，但至少：擋掉這段期間的 submit，
   * 並把攔了幾次回報出去，讓面板可以說「這一頁想在你按之前就送出」。
   */
  async function guardSubmits(fn) {
    const doc = document
    let blocked = 0
    const stop = e => { e.preventDefault(); e.stopImmediatePropagation(); blocked++ }
    const forms = [...doc.querySelectorAll('form')]
    for (const f of forms) f.addEventListener('submit', stop, true)
    doc.addEventListener('submit', stop, true)
    try {
      return { value: await fn(), blocked }
    } finally {
      for (const f of forms) f.removeEventListener('submit', stop, true)
      doc.removeEventListener('submit', stop, true)
    }
  }

  // ── 七、還原 ────────────────────────────────────────────────
  //
  // 跟 core 的 journal／undo 同一套哲學：動之前先存下原樣。
  // 還原也要走填入路徑，不能直接寫回去，否則框架的狀態會跟畫面對不上。

  const kindOf = el => (typeOf(el) === 'checkbox' || typeOf(el) === 'radio') ? 'checked' : 'value'

  const snapshot = els => [...els].map(el => ({
    el, kind: kindOf(el),
    before: kindOf(el) === 'checked' ? el.checked : el.value,
  }))

  function restore(shots) {
    let n = 0
    for (const s of shots) {
      if (!s.el || !s.el.isConnected) continue
      if (s.kind === 'checked') { if (s.el.checked !== s.before) { s.el.click(); n++ } }
      else if (s.el.value !== s.before) { if (fillText(s.el, s.before).ok) n++ }
    }
    return n
  }

  globalThis.CBFill = {
    // 任務要求的三支
    setValue, formatFor, isVisible,
    // 要寫得出「為什麼沒填」就需要的 detail 版
    setValueDetail, formatForDetail, visibilityOf, canFill,
    // 還原
    snapshot, restore,
    // 中文輸入中的欄位不要動
    watchComposition, isComposing,
    // 純函式，好單獨測
    nativeSetter, setNativeValue, fireInput, fireChange,
    pickOption, firstAllowed, matchesPattern, guardSubmits,
    dateCandidates, rocParts, sepOf, phoneCandidates, twParts, numberForField,
    halfWidth, norm, valueTypeOf,
  }
})()
