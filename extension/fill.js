/**
 * ContextBox —— 真的把值填進欄位的那一層
 *
 * ── 整個填入流程只有這一條路 ──────────────────────────────────
 *
 *   網頁              content.js               background.js        本機 server
 *   ────              ──────────               ─────────────        ──────────
 *   表單欄位 ─掃描─▶  labelCandidates
 *                     CB.matchField
 *                     CBFill.maybeVisible ← 確定看不見的在這裡就被丟掉；
 *                          │                「現在量不出來」的（第一屏底下）留著
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
  //
  // 每一次我們送事件出去，頁面的處理函式就有機會改 DOM（蓋一層遮罩上來也行），
  // 所以送完就把遮擋候選清單作廢。不作廢的話，下一格拿到的是舊清單，
  // 「沒有東西蓋住」就變成一句沒有根據的話。
  const fireInput = el => {
    const r = el.dispatchEvent(new InputEvent('input', {
      bubbles: true, composed: true, inputType: 'insertText', data: String(el.value ?? ''),
    }))
    bustCover()
    return r
  }
  const fireChange = el => {
    const r = el.dispatchEvent(new Event('change', { bubbles: true }))
    bustCover()
    return r
  }
  /** radio／checkbox 只能用 click()（React 聽的是 click），一樣會讓頁面有機會改 DOM。 */
  const clickIt = el => { el.click(); bustCover() }

  // ── 二、看得見嗎 ────────────────────────────────────────────
  //
  // 威脅模型報告講得很直白：看不見的欄位一律不填。
  // 只排掉 type=hidden 完全不夠——移到畫面外的、opacity:0 的、2px 見方的、
  // 被另一個元素整個蓋住的，長相都很正常。
  //
  // 結論分三種，不要混成一個 ok：
  //   ok:true                     每一道都過，而且真的量得出來
  //   ok:false  measurable:true   確定看不見（藏起來、被裁掉、被蓋住、太小）
  //   ok:false  measurable:false  現在量不出來（整格都在視窗外，遮擋打不到）
  //
  // 為什麼一定要分這三種：長表單第一屏底下全是正常欄位。
  // 把「量不出來」當成「看不見」，掃描階段就整批丟掉，人根本不知道我們認得它們；
  // 反過來當成「看得見」就是 fail-open。所以掃描階段用 maybeVisible()，
  // 真的要動手填的那一刻用 isVisible()（嚴格：量不出來就不算過）。

  /** 我們自己畫到頁面上的節點。頁面偽造不了 Set 成員資格。 */
  const OURS = new Set()
  const claim = n => { OURS.add(n); return n }
  const unclaim = n => OURS.delete(n)

  const num = (v, dflt) => { const n = parseFloat(v); return Number.isFinite(n) ? n : dflt }

  /** 往上一層。穿得過 shadow DOM 的邊界，不然 shadow 裡的欄位只走到 shadow root 就停了。 */
  function up(n) {
    if (!n) return null
    if (n.parentElement) return n.parentElement
    const root = n.getRootNode && n.getRootNode()
    return (root && root.host) || null
  }

  /**
   * 先問瀏覽器。Chrome 自己算得出來的（display:none、visibility、opacity:0、
   * content-visibility 的 skipped content——收合的 details 在新版 Chrome 就是
   * ::details-content 的 content-visibility:hidden，祖先鏈上完全看不出來）
   * 一律以它為準，我們只補它不管的那幾樣：遮擋、尺寸、裁切、視窗外。
   * 舊版 Chrome 的參數名是 checkOpacity／checkVisibilityCSS，兩套都給，多的會被忽略。
   */
  const CHECK_OPTS = {
    opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true,
    checkOpacity: true, checkVisibilityCSS: true,
  }
  const notRendered = el =>
    typeof el.checkVisibility === 'function' && el.checkVisibility(CHECK_OPTS) === false

  // ── 裁切：clip-path 與老牌的 clip ───────────────────────────
  //
  // 把元素裁成空區域是 visually-hidden／sr-only 最常見的配方。
  // 不要用字串比對去猜：inset(50%)、inset(100%)、polygon(0 0,0 0,0 0)、circle(0)
  // 長得完全不一樣，列舉永遠列不完，漏一個就是放行。
  // 這裡把值解析成數字，拿元素自己的尺寸算剩下的面積。
  // 算不出來的（calc()、path()、url()）一律不擋——在視窗內還有命中測試兜底，
  // 在這裡亂擋會誤殺正常欄位。

  /** <length-percentage> → px。算不出來回 NaN，讓呼叫端知道「不確定」。 */
  function lenPx(token, base) {
    const t = String(token == null ? '' : token).trim()
    if (/^[-+]?(\d+\.?\d*|\.\d+)%$/.test(t)) return parseFloat(t) / 100 * base
    if (/^[-+]?(\d+\.?\d*|\.\d+)px$/.test(t)) return parseFloat(t)
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return parseFloat(t)   // 純 0 可以沒有單位
    return NaN
  }

  /** 逗號切開，但括號裡的逗號不算（calc(1px + 2px, …) 之類） */
  function splitTop(s) {
    const out = []
    let depth = 0, cur = ''
    for (const ch of String(s)) {
      if (ch === '(') depth++
      else if (ch === ')') depth--
      if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else cur += ch
    }
    out.push(cur)
    return out
  }

  /** clip-path 有沒有把這個尺寸的元素裁成空的。 */
  function clipsAway(value, rect) {
    const v = String(value || '').trim()
    if (!v || v === 'none') return false
    const m = /^([a-zA-Z-]+)\(([\s\S]*)\)$/.exec(v)
    if (!m) return false
    const fn = m[1].toLowerCase()
    const W = rect.width, H = rect.height
    if (fn === 'inset') {
      const body = m[2].split(/\bround\b/i)[0].trim()
      const p = body.split(/\s+/).filter(Boolean)
      if (!p.length) return false
      const top = lenPx(p[0], H)
      const right = lenPx(p.length > 1 ? p[1] : p[0], W)
      const bottom = lenPx(p.length > 2 ? p[2] : p[0], H)
      const left = lenPx(p.length > 3 ? p[3] : (p.length > 1 ? p[1] : p[0]), W)
      if (![top, right, bottom, left].every(Number.isFinite)) return false
      return (W - left - right) <= 0 || (H - top - bottom) <= 0
    }
    if (fn === 'circle' || fn === 'ellipse') {
      const at = m[2].split(/\bat\b/i)[0].trim()
      if (!at) return false
      const p = at.split(/\s+/).filter(Boolean)
      // 圓的百分比半徑是對「參考方框的對角線」算的，不過我們只在乎它是不是 0
      const diag = Math.sqrt((W * W + H * H) / 2)
      const radii = fn === 'circle'
        ? [lenPx(p[0], diag)]
        : [lenPx(p[0], W), lenPx(p[1], H)]
      return radii.some(r => Number.isFinite(r) && r <= 0)
    }
    if (fn === 'polygon') {
      const pts = []
      for (const part of splitTop(m[2])) {
        const p = part.trim().split(/\s+/).filter(Boolean)
        if (p.length < 2) continue                     // nonzero／evenodd 那個關鍵字
        const x = lenPx(p[0], W), y = lenPx(p[1], H)
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false
        pts.push([x, y])
      }
      if (pts.length < 3) return pts.length > 0        // 少於三個點圍不出面積
      let a = 0
      for (let i = 0; i < pts.length; i++) {
        const q = pts[i], r = pts[(i + 1) % pts.length]
        a += q[0] * r[1] - r[0] * q[1]
      }
      return Math.abs(a / 2) < 1                       // 一平方像素以下等於沒有
    }
    return false                                       // path()、url()、看不懂的都不擋
  }

  /** 老牌的 clip:rect(0,0,0,0)（十年前的 sr-only 就是這一招）。 */
  function clipRectAway(value) {
    const v = String(value || '').trim()
    const m = /^rect\(([^)]*)\)$/i.exec(v)
    if (!m) return false
    const p = splitTop(m[1]).map(s => s.trim())
    const q = (p.length === 1 ? p[0].split(/\s+/) : p).map(s => s.trim())
    if (q.length < 4) return false
    const n = q.map(s => s === 'auto' ? NaN : lenPx(s, 0))
    if (!n.every(Number.isFinite)) return false        // 有 auto 就不是裁成空的
    return (n[1] - n[3]) <= 0 || (n[2] - n[0]) <= 0    // rect(top, right, bottom, left)
  }

  /** 收合的 details 裡，只有第一個 summary 還看得見。 */
  function firstSummary(d) {
    for (const c of d.children) if (tagOf(c) === 'summary') return c
    return null
  }

  // ── 遮擋 ───────────────────────────────────────────────────
  //
  // 兩道都要，因為兩道量的是不同的東西：
  //   幾何：畫面上有沒有東西壓在上面。遮罩掛 pointer-events:none 也躲不掉。
  //   命中：這個點打下去接到的是不是自己。clip-path 裁空、祖先 ::after 蓋住、
  //         欄位自己 pointer-events:none，都會讓命中落到別人身上。
  // 只有命中測試的話，一片完全不透明、但 pointer-events:none 的遮罩就直接穿過去——
  // 人什麼都看不到，值卻填進去了。只有幾何的話，偽元素跟裁切又量不到。

  /** 這個背景色蓋不蓋得住底下的東西。0 = 完全透明。看不懂的格式當作不透明。 */
  function alphaOf(color) {
    const s = String(color || '').trim().toLowerCase()
    if (!s || s === 'transparent' || s === 'none') return 0
    const m = /^[a-z]*\(([^()]*)\)$/.exec(s)
    if (!m) return 1                                   // white、#fff 這種一定不透明
    const inner = m[1]
    const parts = inner.split(/[,\s/]+/).filter(Boolean)
    const slash = inner.indexOf('/') >= 0
    // rgb(0,0,0) 沒有 alpha；rgba(0,0,0,.5) 第四個是；color(srgb 0 0 0 / .5) 在斜線後面
    const tok = slash ? parts[parts.length - 1]
      : (parts.length === 4 && !/^[a-z]/.test(parts[0]) ? parts[3] : null)
    if (tok == null) return 1
    const a = tok.endsWith('%') ? parseFloat(tok) / 100 : parseFloat(tok)
    return Number.isFinite(a) ? a : 1
  }

  /** outer 在合成樹上包不包含 inner（穿過 shadow 邊界）。 */
  function containsComposed(outer, inner) {
    if (!outer || !inner) return false
    for (let x = inner; x;) {
      if (x === outer || (outer.contains && outer.contains(x))) return true
      const root = x.getRootNode && x.getRootNode()
      x = (root && root.host) || null
    }
    return false
  }

  // 遮擋候選清單：整頁掃一次不便宜，但同一個 task 裡頁面的程式跑不起來，
  // DOM 不會自己變，所以掃描 30 格只要掃一次。
  // 只要我們自己送出事件（頁面就有機會改 DOM），快取立刻作廢——
  // 拿過期的清單去說「沒有東西蓋住」，就是另一種 fail-open。
  let coverCache = null
  const bustCover = () => { coverCache = null }
  const WALK_BUDGET = 50000

  function coverCandidates(doc) {
    if (coverCache && coverCache.doc === doc) return coverCache
    const win = (doc && doc.defaultView) || globalThis
    const out = { doc, list: [], complete: true }
    let budget = WALK_BUDGET
    const walk = root => {
      let all
      try { all = root.querySelectorAll('*') } catch { return }
      for (const n of all) {
        if (budget-- <= 0) { out.complete = false; return }
        if (n.shadowRoot) walk(n.shadowRoot)
        if (OURS.has(n)) continue                      // 我們自己畫的標記不算遮擋
        const s = win.getComputedStyle(n)
        if (!s || s.display === 'none' || s.visibility !== 'visible') continue
        const own = num(s.opacity, 1)
        if (own <= 0) continue
        const solid = alphaOf(s.backgroundColor) * own >= 0.5
          || (s.backgroundImage && s.backgroundImage !== 'none')
        if (!solid) continue
        if (typeof n.checkVisibility === 'function' && !n.checkVisibility(CHECK_OPTS)) continue
        const r = n.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) continue
        out.list.push({ el: n, rect: r, pos: s.position, z: parseInt(s.zIndex, 10) })
      }
    }
    walk(doc)
    coverCache = out
    if (typeof queueMicrotask === 'function') queueMicrotask(bustCover)
    return out
  }

  /** n 會不會畫在 el 上面。算不準的時候一律當「會」（fail closed）。 */
  function paintsAbove(el, n, c) {
    if (c.pos === 'fixed') return true
    if (c.pos !== 'static' && Number.isFinite(c.z) && c.z > 0) return true
    const rel = el.compareDocumentPosition(n)
    if (rel & 1) return true                           // 不同棵樹，比不出先後
    return !!(rel & 4)                                 // 文件順序在後面的畫在上面
  }

  /**
   * 有沒有東西壓在 (px, py) 這個點上。
   * 回 { el, complete }：complete:false 代表這一頁大到沒掃完，不敢說「沒有」。
   */
  function coverOf(el, px, py, inView) {
    const cand = coverCandidates(el.ownerDocument)
    for (const c of cand.list) {
      const n = c.el
      if (n === el) continue
      if (containsComposed(el, n)) continue             // 自己的小孩畫在自己上面是正常的
      if (containsComposed(n, el)) continue             // 祖先的背景畫在自己下面
      // position:fixed／sticky 的矩形只對「現在這一屏」有意義。
      // 元素整格都在視窗外的時候拿來比是錯的，會冤枉人。
      if (!inView && (c.pos === 'fixed' || c.pos === 'sticky')) continue
      const r = c.rect
      if (px < r.left || px > r.right || py < r.top || py > r.bottom) continue
      if (!paintsAbove(el, n, c)) continue
      return { el: n, complete: cand.complete }
    }
    return { el: null, complete: cand.complete }
  }

  /**
   * 命中測試。元素在 open shadow DOM 裡的時候，document.elementFromPoint 回的是 host，
   * 分不出「打到欄位」跟「打到同一個 shadow tree 裡蓋住它的東西」，
   * 所以要往裡面再打一次，拿到真正最上面的那一個。
   */
  function deepHit(doc, x, y) {
    let h = null
    try { h = doc.elementFromPoint(x, y) } catch { return null }
    for (let i = 0; h && h.shadowRoot && i < 20; i++) {
      let inner = null
      try { inner = h.shadowRoot.elementFromPoint(x, y) } catch { break }
      if (!inner || inner === h) break
      h = inner
    }
    return h
  }

  /**
   * 為什麼要 detail 版：面板要能告訴人「這一格為什麼沒填」，
   * 只回 true／false 的話那句話寫不出來。
   * measurable 的意思見這一節開頭。
   */
  function visibilityOf(el) {
    const no = why => ({ ok: false, why, measurable: true })
    const dunno = why => ({ ok: false, why, measurable: false })
    if (!el || el.nodeType !== 1) return no('不是一個元素')
    if (!el.isConnected) return no('已經不在頁面上')
    if (NEVER.has(typeOf(el))) return no('這種欄位我們永遠不碰')
    if (el.hidden) return no('掛了 hidden 屬性')

    const win = (el.ownerDocument && el.ownerDocument.defaultView) || globalThis
    if (!win.getComputedStyle) return no('這裡沒有辦法算樣式')

    // 從自己往上走完整條祖先鏈。任何一層藏起來，底下的就都看不見。
    // 自己走一遍不是因為不信任 checkVisibility，是因為它只回一個 false，
    // 講不出原因；面板要寫得出「這一格為什麼沒填」。
    let opacity = 1
    for (let n = el, child = null; n && n.nodeType === 1;) {
      const s = win.getComputedStyle(n)
      if (!s) break
      if (s.display === 'none') return no('被 display:none 藏起來')
      if (s.visibility === 'hidden' || s.visibility === 'collapse') return no('被 visibility 藏起來')
      if (s.contentVisibility === 'hidden') return no('被 content-visibility 藏起來')
      if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') return no('標了 aria-hidden')
      if (s.clipPath && s.clipPath !== 'none'
        && clipsAway(s.clipPath, n.getBoundingClientRect())) return no('被 clip-path 裁掉')
      if (s.clip && s.clip !== 'auto' && clipRectAway(s.clip)) return no('被 clip 裁掉')
      if (/opacity\(\s*0(\.0+)?\s*\)/.test(s.filter || '')) return no('被 filter 弄成透明')
      // inert：畫面上看得到，但它整塊都不接命中測試，下面那道「打到的是不是自己」
      // 會變成永遠打到祖先。在這裡就講清楚是 inert，不要讓它變成一句
      // 「被別的東西蓋住了」——那是在講一件沒發生的事。
      // （所以 canFill／optionUsable 就不必再檢查一次 inert，那會是死碼。）
      if (n.inert === true) return no('在 inert（停用）區塊裡')
      // 收合的 details：新版 Chrome 把內容藏在 ::details-content 這個偽元素上，
      // 祖先鏈的 computed style 一點痕跡都看不到，只能自己認。
      // 第一個 <summary> 是那顆可以點的標題，它自己還是看得見的。
      if (tagOf(n) === 'details' && n.open === false && child && child !== firstSummary(n))
        return no('在收合的 details 裡')
      opacity *= num(s.opacity, 1)
      if (opacity < 0.3) return no('幾乎是透明的')
      child = n
      n = up(n)
    }

    // 自己走完還過得去的，再讓瀏覽器複查一次。它算的是真正的算繪結果，
    // 比我們沿著祖先鏈猜準（例如 content-visibility 的 skipped content）。
    if (notRendered(el)) return no('瀏覽器說這一格根本沒有被畫出來')

    if (String(win.getComputedStyle(el).webkitTextSecurity || 'none') !== 'none')
      return no('文字被遮成圓點，等於密碼欄')

    const rect = el.getBoundingClientRect()
    // radio 與 checkbox 本來就小（原生大約 13px），門檻要分開訂
    const small = typeOf(el) === 'radio' || typeOf(el) === 'checkbox'
    const minW = small ? 8 : 20, minH = small ? 8 : 10
    if (rect.width < minW || rect.height < minH) return no('小到看不見')

    // 被捲到畫面外不算看不見（長表單本來就要捲），但被移到文件左上角外面就算。
    const left = rect.left + win.scrollX, top = rect.top + win.scrollY
    if (left + rect.width <= 0 || top + rect.height <= 0) return no('被移到畫面外')
    // 注意：不要寫 `left >= docEl.scrollWidth`。被藏到 left:99999px 的元素
    // 自己就會把 documentElement 的 scrollWidth 撐大，那個條件永遠不成立，是死碼。
    // 那一類擋得住它的是下面的遮擋檢查跟 isVisible() 的嚴格門檻。

    // 祖先鏈上只要有一層是 overflow:hidden/clip（使用者捲不到），
    // 元素就必須跟那一層有實際重疊，否則等於被裁掉看不見。
    for (let a = up(el); a; a = up(a)) {
      const as = win.getComputedStyle(a)
      if (!as) break
      const clipped = /^(hidden|clip)$/.test(as.overflowX) || /^(hidden|clip)$/.test(as.overflowY)
      if (!clipped) continue
      const ar = a.getBoundingClientRect()
      const overlap = rect.right > ar.left && rect.left < ar.right
        && rect.bottom > ar.top && rect.top < ar.bottom
      if (!overlap) return no('被祖先的 overflow 裁掉了')
    }

    // 要下手的那個點：矩形跟視窗的交集中心。
    // 交集是空的（整格都在視窗外）就只剩幾何那一道，命中測試打不到。
    const ix1 = Math.max(rect.left, 0), iy1 = Math.max(rect.top, 0)
    const ix2 = Math.min(rect.right, win.innerWidth), iy2 = Math.min(rect.bottom, win.innerHeight)
    const inView = ix2 > ix1 && iy2 > iy1
    const px = inView ? (ix1 + ix2) / 2 : rect.left + rect.width / 2
    const py = inView ? (iy1 + iy2) / 2 : rect.top + rect.height / 2

    // 遮擋（一）幾何：不管對方 pointer-events 是什麼，視窗外也算得出來
    const cover = coverOf(el, px, py, inView)
    if (cover.el) return no('被別的東西蓋住了')

    if (!inView) {
      return dunno(cover.complete
        ? '在視窗外，量不出有沒有被蓋住'
        : '在視窗外，而且這一頁大到沒掃完')
    }

    // 遮擋（二）命中測試：中心點打下去，接到的是不是自己
    const hit = deepHit(el.ownerDocument, px, py)
    if (!hit) return no('這個點打不到任何東西')
    // 用我們自己記下來的節點集合判斷，不要用 DOM 屬性——
    // [data-cb] 頁面自己也寫得出來，等於把這道檢查的開關交給攻擊者。
    //
    // 也不要用 hit.contains(el)：命中落到欄位的任何一層祖先都算過關的話，
    // clip-path 裁空、祖先用 ::after 蓋住、欄位自己 pointer-events:none——
    // 這三種命中都會落在祖先身上，整道檢查就全開了。
    // 祖先接到命中，代表欄位自己沒接到，那就是被裁掉或被蓋住，要 fail closed。
    const same = hit === el || el.contains(hit)
      || (hit.shadowRoot && hit.shadowRoot.contains(el))
    if (!OURS.has(hit) && !same) {
      // 一律 fail closed，但原因要分得出來：pointer-events:none 的欄位
      // 本來就不接命中（computed 值已經含祖先繼承的結果），
      // 那時候說「被別的東西蓋住了」是在講一件沒發生的事。
      const pe = String(win.getComputedStyle(el).pointerEvents || 'auto')
      return no(pe === 'none'
        ? '設了 pointer-events:none，打不到它，不敢說它看得見'
        : '被別的東西蓋住了')
    }
    // 走到這裡代表命中測試打得到自己。就算候選清單沒掃完（太大的頁面），
    // 「這個點打下去接到的是欄位本人」本身就是夠硬的證據，可以算過。
    return { ok: true, why: null, measurable: true }
  }

  /** 真的要動手填之前用這一支。量不出來就不算過。 */
  const isVisible = el => visibilityOf(el).ok === true

  /**
   * 掃描階段用這一支：確定看不見回 false，現在量不出來回 true。
   * 為什麼不能用 isVisible() 掃：第一屏底下的欄位全都是「量不出來」，
   * 用 isVisible() 掃等於把整張長表單丟掉，人會以為我們什麼都沒認出來。
   */
  const maybeVisible = el => {
    const v = visibilityOf(el)
    return v.ok === true || v.measurable === false
  }

  /**
   * 中心點現在真的在視窗裡嗎。
   * 批次填入只碰視窗內的；其餘的等人捲過去、按那一格自己的按鈕，那時候再驗一次。
   */
  function inViewport(el) {
    if (!el || !el.getBoundingClientRect) return false
    const w = (el.ownerDocument && el.ownerDocument.defaultView) || globalThis
    const r = el.getBoundingClientRect()
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2
    return cx >= 0 && cy >= 0 && cx <= w.innerWidth && cy <= w.innerHeight
  }

  /** 看得見，而且真的填得進去。disabled 的欄位送出時根本不會被帶走。 */
  function canFill(el) {
    const v = visibilityOf(el)
    if (!v.ok) return { ok: false, why: v.why, measurable: v.measurable }
    if (el.disabled) return { ok: false, why: '欄位被鎖住', measurable: true }
    // inert 不在這裡檢查：visibilityOf 走祖先鏈的時候就擋掉了。
    // 在這裡再寫一次的話，那一行永遠不會執行到，是看起來有防護的死碼。
    return { ok: true, why: null, measurable: true }
  }

  /**
   * radio／checkbox 群組裡，被點到的那一格自己也要過關。
   * 回 null 代表可以點，回字串就是不能點的原因。
   * 為什麼要獨立一支：radio 跟 checkbox 兩條路都要用，
   * 只修其中一條的話，另一條就是那個沒人看的洞。
   */
  function optionUsable(t) {
    if (!t) return '不在頁面上'
    if (t.disabled) return '被鎖住'
    const v = visibilityOf(t)     // 看得見嗎、在不在 inert 裡、被不被蓋住，都在這一支
    return v.ok ? null : v.why
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

  /**
   * 同一組（同一個 name）的 radio 或 checkbox。
   *
   * 範圍一定要限制住：用 ownerDocument 整頁抓，會跨表單抓到別人家同名的欄位
   * （「性別」這種 name 一頁裡出現兩次很正常），而且 shadow DOM 裡的群組
   * 從外面根本抓不到自己那一組。
   * 所以先用 el.form 當範圍，沒有 form 就用 getRootNode()（在 shadow 裡就是
   * 那個 shadow root），抓完再用 form 擁有者過濾一次——
   * HTML 規格說了，一組的定義就是「同一個 form 擁有者＋同一個 name」。
   */
  function nameGroup(el, type) {
    if (!el.name) return [el]
    const q = root => {
      if (!root || !root.querySelectorAll) return []
      try {
        return [...root.querySelectorAll(
          `input[type=${type}][name="${CSS.escape(el.name)}"]`)]
      } catch { return [] }
    }
    const mine = o => o.form === el.form
    let list = q(el.form || el.getRootNode()).filter(mine)
    // form="表單id" 可以把欄位掛到表單標籤外面去，那時候 el.form 裡找不到自己。
    // 找不到自己就退回整棵樹再用 form 擁有者過濾。
    if (!list.includes(el)) list = q(el.getRootNode()).filter(mine)
    return list.includes(el) ? list : [el]
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
    const group = nameGroup(el, 'radio')
    const hit = pickOption(
      group.map(r => ({ text: String(controlLabel(r)).trim(), value: r.value, disabled: r.disabled, el: r })),
      want)
    if (!hit.ok) return { ok: false, why: hit.why, choices: group.map(r => String(controlLabel(r)).trim()) }
    const target = hit.option.el
    const bad = optionUsable(target)          // 被點的那一格自己要看得見、沒鎖、沒被 inert 停用
    if (bad) return { ok: false, why: `這個選項${bad}` }
    if (!target.checked) clickIt(target)      // 已經對了就別點，免得多發一輪事件
    return target.checked
      ? { ok: true, via: hit.via, shown: String(controlLabel(target)).trim(), why: null }
      : { ok: false, why: '點了但沒有被選起來' }
  }

  /**
   * 「是／否／有／無」這一類開關值。回 true、false，或 null（不是開關）。
   * 獨立出來是因為兩個地方都要問同一個問題：
   * fillCheckbox 要知道該不該打勾，setValueDetail 要知道該不該進群組比對。
   */
  function switchIntent(want) {
    if (want === true || want === 1) return true
    if (want === false || want === 0) return false
    const s = String(want)
    if (/^(是|要|有|true|yes|y|on|1)$/i.test(s)) return true
    if (/^(否|不|沒有|無|false|no|n|off|0)$/i.test(s)) return false
    return null
  }

  /** 只有真的是開關的值才走這裡。判斷不出來就交還給人，絕對不要靜靜取消勾選。 */
  function fillCheckbox(el, want) {
    if (el.disabled) return { ok: false, why: '這個選項被鎖住' }
    const desired = switchIntent(want)
    if (desired === null) {
      // 「全職」這種 enum 值掉進來的話，過去會被當成「取消勾選」，
      // 把使用者自己勾好的那一格弄掉，還回報填好了。
      return { ok: false, why: '這一格是打勾欄，但庫裡的值不是「是／否」' }
    }
    if (el.checked !== desired) clickIt(el)   // click() 是翻轉，所以先比對現況
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
      //
      // 但「是／否／有／無」這種開關值一定要先攔下來，不能讓它進群組比對：
      // pickOption 最後一層是「選項文字包含我們的值」，標籤裡只要出現那個字就算中
      //（「是否同意」同時包含「是」跟「否」），於是「否」會跟「是」做出一模一樣的事
      // ——兩個都打勾——而 fillCheckbox 對這一整類值變成永遠走不到的死碼。
      if (switchIntent(value) === null && value != null) {
        const group = el.name ? nameGroup(el, 'checkbox') : [el]
        // pickOption 回的是 { ok, via, option }，沒中的時候回的也是物件。
        // 所以要看 hit.ok，而且元素在 hit.option.el —— 兩個都寫錯過，
        // 結果是每次都丟 TypeError，checkbox 一格都填不了。
        const hit = pickOption(
          group.map(o => ({ el: o, text: controlLabel(o), value: o.value, disabled: o.disabled })),
          value)
        if (hit.ok) {
          const t = hit.option.el
          // 跟 fillRadio 同一套把關。少了這三道，頁面只要在群組裡塞一格
          // 看不見（或被鎖住、被 inert 停用）的 checkbox，再讓它的標籤比中，
          // 我們就會替使用者勾一格他完全看不到的東西。
          const bad = optionUsable(t)
          if (bad) return { ok: false, why: `這個選項${bad}` }
          if (!t.checked) clickIt(t)
          return t.checked
            ? { ok: true, via: hit.via, shown: String(controlLabel(t)).trim(), why: null }
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
   * 頁面在自己的地盤上終究防不死，但至少：擋掉這段期間頁面自己發動的 submit、
   * 放行使用者自己按的那一次、量得出自己有沒有被消音，然後把這三件事都講出來。
   */
  let guard = null
  const LINGER_MS = 8000        // 填完之後守衛還要多留這麼久（頁面會把送出延後一拍）
  const GESTURE_MS = 800        // 真人手勢到 submit 之間，合理的間隔
  const ACTIVATION_MS = 5000    // Chrome 的 transient activation 大約撐五秒

  let lastPageGesture = 0       // 最後一次打在「頁面自己」的真人手勢
  let lastOurGesture = 0        // 最後一次打在「我們自己畫的按鈕」的真人手勢
  let lastGestureTarget = null
  let gestureWatched = false
  const nowMs = () => Date.now()

  /** 這個事件是不是打在我們自己畫的東西上（面板、標記、那顆按鈕）。 */
  function fromUs(e) {
    if (OURS.has(e.target)) return true
    const path = (e.composedPath && e.composedPath()) || []
    for (const n of path) if (OURS.has(n)) return true
    return false
  }

  /**
   * 記下真人手勢。為什麼要自己記一份：
   * submit 事件的 isTrusted 對 form.requestSubmit() 也是 true，光看事件分不出
   * 「人按的」跟「頁面自己觸發的」。分得出來的只有「剛剛有沒有人真的動手，
   * 而且動在頁面上，不是動在我們的面板上」。
   * 我們自己那顆按鈕的點擊要分開記——不然使用者一按「填入」，
   * 接下來八秒內頁面自己送出都會被當成他按的，守衛等於沒裝。
   */
  function watchGestures() {
    if (gestureWatched || typeof window === 'undefined') return
    gestureWatched = true
    const mark = e => {
      if (!e.isTrusted) return
      if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return
      if (fromUs(e)) { lastOurGesture = nowMs(); return }
      lastPageGesture = nowMs()
      lastGestureTarget = e.target || null
    }
    for (const t of ['pointerdown', 'mousedown', 'click', 'keydown'])
      window.addEventListener(t, mark, { capture: true, passive: true })
  }

  /** 這一次的 submit 是不是使用者自己按的。 */
  function userDriven(state, form) {
    const t = nowMs()
    // 剛剛有真人動在頁面上，而且比他點我們按鈕那一下更晚 → 是他自己要送出。
    // 再加一道：那一下要打在這張表單裡（或打在任何表單外面，例如自己畫的送出鈕），
    // 免得他只是點了頁面上別的東西，就被別張表單借去當通行證。
    if (lastPageGesture > lastOurGesture && t - lastPageGesture <= GESTURE_MS) {
      const g = lastGestureTarget
      const inForm = g && form && (containsComposed(form, g) || g.form === form)
      // 表單外面也可能有一顆送出鈕（自己畫樣式的很常見），那也算數；
      // 但只認按鈕類的。放寬成「任何不在表單裡的東西」的話，
      // 使用者在頁面上隨便點一下，頁面就有八百毫秒可以偷送出——
      // 那等於把整道守衛的鑰匙交給對方。
      const btn = g && g.closest
        && g.closest('button, input[type=submit], input[type=image], [role=button], a[href]')
      const outsideBtn = btn && !btn.closest('form') && !btn.form
      if (!form || inForm || outsideBtn) return true
    }
    // 看不到手勢的時候（頁面擋得掉我們的監聽器）還有第二個線索：瀏覽器說現在
    // 有 transient activation。但我們自己那顆按鈕的點擊也會產生 activation，
    // 所以只有在「自己那一下早就過期」之後這個線索才算數，
    // 不然等於填完之後那五秒全部自動放行——那就是把防線關掉。
    const act = typeof navigator !== 'undefined' && navigator.userActivation
    if (act && act.isActive === true
      && t - state.armedAt > ACTIVATION_MS
      && t - lastOurGesture > ACTIVATION_MS) return true
    return false
  }

  /**
   * 自我探針：裝完監聽器之後，確認自己真的收得到 submit。
   *
   * 為什麼需要：捕獲階段的路徑是 window → document → form，而網頁永遠比
   * 擴充套件早註冊。頁面只要寫一行
   *   window.addEventListener('submit', e => e.stopImmediatePropagation(), true)
   * 我們的守衛就永遠收不到事件，blocked 停在 0，面板還會很有自信地說「沒事」。
   * 那是典型的 fail-open：量不出來卻當成安全。
   *
   * 探針一定要掛在文件上才有意義：detached 的節點沒有 window → document 這一段
   * 路徑，在那裡測到的「收不到」是假的，會反過來每次都說自己瞎了。
   * 所以掛上去、發一次 cancelable 的合成 submit、立刻拿掉。
   * （合成的 submit 事件不會真的送出表單——送出是表單送出演算法做的事，
   *   不是這個事件的預設動作——而且我們自己還會 preventDefault。）
   */
  function selfProbe(doc, seen) {
    let f = null
    try {
      const host = doc.documentElement || doc.body
      if (!host) return null
      f = doc.createElement('form')
      f.setAttribute('data-cb', '1')
      claim(f)
      f.style.cssText = 'position:fixed;left:-9999px;top:0;width:0;height:0;'
        + 'opacity:0;pointer-events:none'
      host.appendChild(f)
      seen(f)
      const Ev = typeof SubmitEvent === 'function' ? SubmitEvent : Event
      f.dispatchEvent(new Ev('submit', { bubbles: true, cancelable: true }))
    } catch { /* 發不出去就當作收不到，blind 會留著 */ }
    if (f) { try { f.remove() } catch { /* 拿不掉也不能中斷 */ } unclaim(f) }
    return null
  }

  function install() {
    const doc = document
    const w = doc.defaultView || globalThis
    const state = {
      blocked: 0, navigated: false, blind: true, depth: 0, hooks: [],
      armedAt: nowMs(), done: false,
    }
    let probeForm = null
    const handled = new WeakSet()          // 兩個監聽器，同一個事件只算一次

    const stop = e => {
      if (handled.has(e)) return
      handled.add(e)
      // 自我探針那一發：只用來確認「我們收得到」，不算攔截
      if (probeForm && e.target === probeForm) {
        state.blind = false
        e.preventDefault(); e.stopImmediatePropagation()
        return
      }
      if (userDriven(state, e.target)) {
        // 使用者自己按的送出：放行，而且立刻收手，不要再擋後面的。
        // 填完的八秒內把人自己按的送出吃掉、按鈕沒反應、面板一句話都不說，
        // 是這整支檔案最糟的失敗方式——面板上還寫著「沒問題再自己按送出」。
        state.teardown()
        return
      }
      e.preventDefault(); e.stopImmediatePropagation()
      state.blocked++
      const info = {
        why: '這一頁自己想送出表單，不是你按的',
        form: e.target || null,
        submitter: e.submitter || null,
        blind: state.blind,
        sinceArm: nowMs() - state.armedAt,
      }
      // 一定要用回呼講出去。blocked 雖然是活的 getter，但呼叫端只在 await
      // 回來那一瞬間讀一次，八秒的防線有七點九八秒是啞的。
      for (const h of state.hooks.slice()) {
        try { h(state.blocked, info) } catch { /* 回呼自己爆炸不能拖垮守衛 */ }
      }
    }
    const onLeave = e => { state.navigated = true; e.preventDefault(); e.returnValue = '' }

    // 兩個節點都裝：頁面在 window 上消音，document 這一個還活著；
    // 反過來也一樣。防線只裝在其中一條路徑上，就只要拆一條就沒了。
    w.addEventListener('submit', stop, true)
    doc.addEventListener('submit', stop, true)
    w.addEventListener('beforeunload', onLeave, true)

    state.teardown = () => {
      if (state.done) return
      state.done = true
      state.depth = 0
      w.removeEventListener('submit', stop, true)
      doc.removeEventListener('submit', stop, true)
      w.removeEventListener('beforeunload', onLeave, true)
      if (guard === state) guard = null
    }
    selfProbe(doc, f => { probeForm = f })
    probeForm = null
    return state
  }

  /**
   * 開始守衛。回傳一個 disarm()，呼叫之後才拆掉。
   * opts.onBlocked(count, info) —— 每攔到一次就呼叫一次，linger 期間攔到的也算。
   *
   * **它攔得到什麼、攔不到什麼，要講清楚：**
   *   攔得到：走 submit 事件的送出（按 submit 鈕、在欄位裡按 Enter、
   *           程式呼叫 requestSubmit）——前提是我們收得到那個事件。
   *   攔不到：HTMLFormElement.prototype.submit() —— 依規格它根本不發 submit 事件；
   *           頁面直接用 fetch／XHR 把值送走；
   *           以及頁面先一步在 window 上把 submit 事件消音的情形
   *           （那一種我們量得出來，會把 state.blind 標起來，讓面板講實話）。
   * isolated world 蓋不到頁面的 prototype，所以這一層在頁面的地盤上防不死。
   * 我們能做的是：攔掉攔得到的、偵測導航、量出自己是不是被消音、然後誠實地說。
   */
  function arm(opts) {
    const o = opts || {}
    const hook = typeof o.onBlocked === 'function' ? o.onBlocked : null
    watchGestures()
    if (!guard) guard = install()
    const state = guard
    state.depth++
    if (hook) state.hooks.push(hook)
    let released = false
    return function disarm() {
      if (released) return state
      released = true
      if (hook) {
        const i = state.hooks.indexOf(hook)
        if (i >= 0) state.hooks.splice(i, 1)
      }
      if (--state.depth > 0) return state
      state.teardown()
      return state
    }
  }

  /**
   * 包住一次填入。守衛不會在 fn 一結束就拆掉——頁面只要把送出延後一拍
   * （setTimeout、rAF、MutationObserver）就繞過去了，而且那時候欄位都填滿了。
   * 所以多留 LINGER_MS，期間攔到的一樣算進去，也一樣會呼叫 onBlocked。
   *
   * 回 { value, blocked, navigated, blind }。
   * blind:true 代表自我探針收不到自己發的事件——頁面把我們的防線關掉了，
   * 這時候 blocked 是 0 不代表沒事，代表我們什麼都看不到。
   */
  async function guardSubmits(fn, opts) {
    const disarm = arm(opts)
    const state = guard
    let value
    try { value = await fn() } finally {
      setTimeout(disarm, LINGER_MS)
    }
    return {
      value,
      get blocked() { return state.blocked },
      get navigated() { return state.navigated },
      get blind() { return state.blind },
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
      if (s.kind === 'checked') { if (s.el.checked !== s.before) { clickIt(s.el); n++ } }
      else if (s.el.value !== s.before) { if (fillText(s.el, s.before).ok) n++ }
    }
    return n
  }

  globalThis.CBFill = {
    // 任務要求的三支
    setValue, formatFor, isVisible,
    // 掃描階段用這一支：確定看不見才回 false
    maybeVisible,
    // 要寫得出「為什麼沒填」就需要的 detail 版
    setValueDetail, formatForDetail, visibilityOf, canFill,
    // 還原
    snapshot, restore,
    // 中文輸入中的欄位不要動
    watchComposition, isComposing,
    // 純函式，好單獨測
    nativeSetter, setNativeValue, fireInput, fireChange,
    pickOption, firstAllowed, matchesPattern, guardSubmits, arm, inViewport, claim, unclaim, isOurs: n => OURS.has(n),
    dateCandidates, rocParts, sepOf, phoneCandidates, twParts, numberForField,
    halfWidth, norm, valueTypeOf, clipsAway, clipRectAway, alphaOf, switchIntent,
  }
})()
