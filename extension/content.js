/**
 * ContextBox —— 頁面這一側：掃描、問、標記、依照人的點擊填入
 *
 * ── 資料流（下一個人請先看這裡）─────────────────────────────
 *
 *   ①  掃描        deepQuery() 找出頁面上所有表單欄位（含 shadow DOM）
 *                  labelCandidates() 挖出可能的標籤文字
 *                  CB.matchField()   比對出 key
 *                  CBFill.isVisible() 看不見的在這裡就丟掉
 *                       ↓
 *   ②  只送 key    keys = ['person.name.full', 'contact.email', ...]
 *                  chrome.runtime.sendMessage 交給 background.js
 *                  這一側沒有 token、沒有 fetch、不知道 server 在哪。
 *                  （content script 自己 fetch 127.0.0.1 會被 CORS 擋掉，
 *                    而且 server 的第 3 道鎖也會再擋一次。這不是備案，
 *                    是唯一的路。）
 *                       ↓
 *   ③  拿回 plan   每個 key 一則指示，action 有六種：
 *                    fill              值是確定的、不敏感 → 可以直接填
 *                    pick              庫裡有多筆 → 要人選一筆
 *                    confirm-each-time 敏感欄位 → 每次都要人再點一次
 *                    compose           長文 → 交給 agent 生成，這一版不填
 *                    missing           庫裡沒有這一筆
 *                    unknown           註冊表不認得這個 key
 *                       ↓
 *   ④  標記        每一格旁邊畫一個小標記，右下角面板統計六種各有幾格。
 *                  這時候還沒有任何值被填進頁面。
 *                       ↓
 *   ⑤  人按按鈕    「填入所有安全欄位」只填 action 是 fill 的；
 *                  pick 與 confirm-each-time 一定要按那一格自己的按鈕。
 *                  每一個處理函式第一行都檢查 event.isTrusted，
 *                  網頁用程式合成的點擊一律不算數。
 *                       ↓
 *   ⑥  填之前再驗一次  欄位還在嗎、現在還看得見嗎、標籤還是同一個 key 嗎。
 *                  掃描到填入之間有好幾百毫秒，頁面完全清醒，可以掉包。
 *                       ↓
 *   ⑦  填          CBFill.formatFor → CBFill.setValue。填完讀回來比對。
 *
 * ── 跟 background.js 的約定（只有這一種訊息）─────────────────
 *
 *   送出  { type: 'cb-plan', keys: ['person.name.full', ...] }
 *   回來  { ok: true,  plan: [ { key, action, ... }, ... ] }
 *         { ok: false, error: '看得懂的中文說明' }
 *
 *   background.js 那一側要做的事：從 chrome.storage.local 讀 token，
 *   POST http://127.0.0.1:7391/form/plan，把 server 回的 plan 原樣送回來。
 *   （為了不綁死，直接回 { plan: [...] } 或回一個陣列我們也收。）
 *
 * ── 這一支不准做的事 ────────────────────────────────────────
 *   1. 不准自動按送出。整個檔案裡不會有任何一行去碰 submit。
 *   2. 不准記住敏感欄位的確認。每一次填都要人重新點一次，
 *      沒有任何一條路徑可以走到「這個網站以後都好」。
 *   3. 不准填看不見的欄位。
 *   4. 不准持有 token。這個檔案裡不該出現 token 這個字（除了這行說明）。
 *   5. 不准把頁面給的字串塞進 innerHTML。面板全部用 createElement 組。
 */
;(function () {
  // 同一頁只留一份。被注入第二次的話直接不做事——不然會有兩個面板、
  // 兩組標記、兩個訊息監聽器，而且舊的那一份還活著，清不掉。
  // 使用者可能連按兩次圖示。已經載入過就只重掃一次，不要再裝一組監聽器。
  if (globalThis.__contextboxRunning) {
    if (globalThis.__contextboxRescan) globalThis.__contextboxRescan()
    return
  }
  globalThis.__contextboxRunning = true

  if (typeof CB === 'undefined' || !CB.matchField) {
    console.warn('[ContextBox] factTable.js 沒有載入，這一頁不做事')
    return
  }
  const HAS_FILL = typeof CBFill !== 'undefined' && CBFill.setValue
  if (!HAS_FILL) console.warn('[ContextBox] fill.js 沒有載入，只會標記不會填')

  /** 庫裡沒有的事實去哪裡補。server.ts 的 GET / 就是手填頁面。 */
  // port 使用者改得動（設定頁），所以跟 background 要，不要寫死。
  let HOME = 'http://127.0.0.1:7391/'

  // ── 顏色 ────────────────────────────────────────────────────
  const C = {
    bg: '#16161A', fg: '#E9E8EE', dim: '#8B8A98', line: '#2E2D36',
    ok: '#2F6E4F', okFg: '#72C79A',
    pick: '#3B3A8C', lock: '#8A5A12', compose: '#4A3A6B',
    miss: '#A3301B', warn: '#EE8C74',
  }

  // ── DOM 小工具：頁面給的字一律走 textContent，絕不進 innerHTML ──
  function E(tag, style, text) {
    const n = document.createElement(tag)
    n.setAttribute('data-cb', '1')          // 只為了掃描時跳過自己
    if (HAS_FILL) CBFill.claim(n)            // 遮擋檢查認的是這個；屬性頁面偽造得出來
    if (style) Object.assign(n.style, style)
    if (text !== undefined && text !== null) n.textContent = String(text)
    return n
  }
  const cut = (s, n) => { const t = String(s); return t.length > n ? t.slice(0, n) + '…' : t }

  // ── 一、標籤文字：只採信看得見的那一部分 ────────────────────
  //
  // 攻擊長這樣：<label>姓名<span style="font-size:0">身分證字號</span></label>
  // 畫面上只看得到「姓名」，textContent 卻是「姓名身分證字號」，
  // 而比對政策是「長的別名先比、包含就算中」，所以身分證字號會贏。
  //
  // 但「整個標籤都藏起來」是合法的無障礙寫法（sr-only），很常見，不能一起殺。
  // 所以規則是：一個標籤裡如果有一部分看得見、一部分藏起來，只採信看得見的，
  // 並且把這個標籤標成 masked；整個都藏起來的照原樣採用。

  // getComputedStyle 回的是活的物件，樣式變了它自己會跟著變，
  // 所以這一份快取只是省掉重複查詢，不會拿到過期的值。
  const styleCache = new WeakMap()
  function css(el) {
    let s = styleCache.get(el)
    if (!s) { s = getComputedStyle(el); styleCache.set(el, s) }
    return s
  }

  /** 這一段文字在標籤裡看得見嗎（只看到標籤自己為止，不往上看整頁）*/
  function textShown(from, root) {
    for (let n = from; n && n.nodeType === 1; n = n.parentElement) {
      const s = css(n)
      if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false
      if (parseFloat(s.opacity || '1') < 0.1) return false
      if (parseFloat(s.fontSize || '16') < 6) return false
      if (/inset\(\s*(100|[1-9]\d\d)%|circle\(\s*0/.test(s.clipPath || '')) return false
      if (parseFloat(s.textIndent || '0') < -999) return false
      if (n !== root) {
        const r = n.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) return false            // 0 尺寸的容器
        if (r.right + window.scrollX <= 0) return false          // 被丟到畫面外
      }
      if (n === root) break
    }
    return true
  }

  /** 回 { text, masked }。masked 代表這個標籤裡有藏起來的字。 */
  function labelTextOf(root) {
    if (!root) return { text: '', masked: false }
    let shown = '', hidden = ''
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent
      if (!t || !t.trim()) continue
      if (textShown(n.parentElement, root)) shown += t
      else hidden += t
    }
    // 整個標籤都是藏的 → 無障礙標籤，照用，不算可疑
    if (!shown.trim()) return { text: hidden, masked: false }
    return { text: shown, masked: hidden.trim().length > 0 }
  }

  /** 從一個表單元素身上，照優先順序挖出所有可能的「標籤文字」 */
  function labelCandidates(el) {
    const out = []
    let masked = false
    const pushNode = node => { if (node) { const r = labelTextOf(node); masked = masked || r.masked; push(r.text) } }
    const push = v => { if (v && String(v).trim()) out.push(String(v).trim()) }

    // 1. <label for="id">
    if (el.id) {
      try { pushNode(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) } catch { /* id 太怪就算了 */ }
    }
    // 2. 被 <label> 包住
    pushNode(el.closest('label'))
    // 3. 無障礙屬性
    push(el.getAttribute('aria-label'))
    const lb = el.getAttribute('aria-labelledby')
    if (lb) lb.split(/\s+/).forEach(id => pushNode(document.getElementById(id)))
    // 4. 表格：同一列的第一格
    const td = el.closest('td, dd')
    if (td) {
      pushNode(td.previousElementSibling)
      pushNode(td.closest('tr')?.querySelector('th'))
    }
    // 5. 前面那個兄弟節點的文字
    pushNode(el.previousElementSibling)
    // 6. radio／checkbox 群組的 legend
    pushNode(el.closest('fieldset')?.querySelector('legend'))
    // 7. 最後才用 placeholder 跟屬性
    push(el.placeholder)
    push(el.name)
    push(el.id)

    return {
      texts: [...new Set(out.map(s => s.replace(/\s+/g, ' ').slice(0, 40)))],
      masked,
    }
  }

  // ── 二、敏感欄位的額外把關 ──────────────────────────────────
  //
  // 比對政策是「只要標籤包含這條別名就算中」，所以在標籤裡多塞一條比較長的
  // 敏感別名就搶得走。實測 16 個敏感 key 的 63 條別名裡有 52 條，
  // 接在「姓名」後面就能把一個看起來是姓名的欄位導成那個敏感 key。
  //
  // 做法：把真正命中的那一段別名從標籤裡挖掉，看剩下的字還像不像別的 key。
  //   「身分證字號（必填）」→ 挖掉後剩「必填」→ 沒有別的 key → 放行
  //   「姓名身分證字號」    → 挖掉後剩「姓名」→ 還像 person.name.full → 擋下
  // 括號裡的字是欄位名的補充說明（「緊急聯絡電話（手機）」），不是第二個欄位名，
  // 所以先拿掉再檢查，免得誤傷。

  const ALIASES = (() => {
    const out = []
    if (typeof FACT_KEYS === 'undefined') return out
    for (const d of FACT_KEYS) {
      for (const a of [d.label, ...(d.aliases || [])]) {
        const n = CB.norm(a)
        if (n.length >= 2) out.push({ n, key: d.key })
      }
    }
    return out
  })()

  const stripParens = t => String(t).replace(/[（(【\[].*?[)）】\]]/g, ' ')

  /** 這個 def 在這段文字裡真正命中的那一條別名（最長的那條）*/
  function winningAlias(def, text) {
    const n = CB.norm(text)
    let best = ''
    for (const a of [def.label, ...(def.aliases || [])]) {
      const na = CB.norm(a)
      if (na.length >= 2 && n.includes(na) && na.length > best.length) best = na
    }
    return best
  }

  /** 挖掉命中的那一段之後，剩下的字還像哪些別的 key */
  function leftoverKeys(def, rawText) {
    const text = stripParens(rawText)
    const win = winningAlias(def, text)
    if (!win) return []
    const rest = CB.norm(text).split(win).join('')   // 挖掉，留一個跨不過去的分隔
    const out = new Set()
    for (const a of ALIASES) if (a.key !== def.key && rest.includes(a.n)) out.add(a.key)
    return [...out]
  }

  const isSensitive = def => def.sensitivity === 'sensitive' || def.sensitivity === 'secret'

  /**
   * 比對一個欄位，並且套上「寧可不填」的幾條政策。
   * 回 { def, layer, via, conflict, needsClick, dropped }
   *   dropped   認出來了但我們決定不承認（寫明原因，只進 console 不進頁面）
   *   needsClick 認出來了，但要人點一下才填，不進「填入所有安全欄位」
   */
  function matchOf(el) {
    const { texts, masked } = labelCandidates(el)
    const m = CB.matchField({ autocomplete: el.getAttribute('autocomplete'), labels: texts })
    const r = { ...m, label: texts[0] ?? '(無標籤)', masked, needsClick: false, dropped: null }
    if (!m.def) return r

    if (isSensitive(m.def)) {
      // 敏感欄位：標籤裡有藏字就不承認。看不見的字不能當授權依據。
      if (masked) { r.dropped = '這一格的標籤裡有藏起來的字'; r.def = null; return r }
      // 敏感欄位：標籤同時像兩個 key 就不承認
      if (m.layer === 2) {
        const left = leftoverKeys(m.def, m.via)
        if (left.length) { r.dropped = `這一格的標籤同時像 ${left.join('、')}`; r.def = null; return r }
      }
      // 敏感欄位：標籤跟 autocomplete 打架就不承認
      if (m.conflict) { r.dropped = `標籤說 ${m.def.key}，autocomplete 說 ${m.conflict}`; r.def = null; return r }
    } else if (m.conflict) {
      // 不敏感但兩邊說法不同：填，但要人點一下
      r.needsClick = true
    }
    return r
  }

  // ── 三、掃描 ────────────────────────────────────────────────

  const SELECTOR = 'input:not([type=hidden]):not([type=submit]):not([type=button])'
    + ':not([type=reset]):not([type=image]):not([type=password])'
    + ', select, textarea, [contenteditable=""], [contenteditable="true"]'

  /** 穿透 shadow DOM 的走訪。closed 的進不去，那是設計如此。 */
  function deepQuery(root, out) {
    out = out || []
    for (const el of root.querySelectorAll('*')) {
      if (el.matches(SELECTOR)) out.push(el)
      if (el.shadowRoot) deepQuery(el.shadowRoot, out)
    }
    return out
  }

  function scan() {
    const seenRadio = new Map()             // 範圍（form 或 document）→ 已經看過的 name
    const fields = []
    let hiddenSkipped = 0

    for (const el of deepQuery(document)) {
      if (el.closest('[data-cb]')) continue          // 不要掃到我們自己畫的東西

      // 看不見的一律不算。不送去問、不標記、不填。
      // 這一關要排在 radio 去重前面，不然整組的代表會被一個藏起來的選項佔走。
      if (HAS_FILL && !CBFill.isVisible(el)) { hiddenSkipped++; continue }

      // 同一組 radio 只算一格
      if (el.type === 'radio' && el.name) {
        const scope = el.form || el.getRootNode()
        let names = seenRadio.get(scope)
        if (!names) seenRadio.set(scope, names = new Set())
        if (names.has(el.name)) continue
        names.add(el.name)
      }

      const m = matchOf(el)
      fields.push({
        el,
        label: m.label,
        key: m.def ? m.def.key : null,
        defLabel: m.def ? m.def.label : null,       // 給人看的永遠是我們自己的名字
        sensitivity: m.def ? m.def.sensitivity : null,
        layer: m.layer, via: m.via, conflict: m.conflict,
        needsClick: m.needsClick, dropped: m.dropped,
        plan: null, state: null,
      })
    }
    return { fields, hiddenSkipped }
  }

  // ── 四、問 background 要 plan ───────────────────────────────
  //
  // service worker 會睡。睡著的時候第一則訊息會把它叫醒，但偶爾回覆會在
  // 通道關掉之後才到，呼叫端拿到 undefined，真正的錯誤在 lastError。
  // 所以一律走這一支，遇到就重送一次（第二次它已經醒著，幾乎都會成功）。

  function ask(msg) {
    return new Promise(resolve => {
      let tries = 0
      const go = () => {
        tries++
        try {
          chrome.runtime.sendMessage(msg, r => {
            const err = chrome.runtime.lastError
            if (err) {
              if (tries < 2) return setTimeout(go, 150)
              return resolve({ ok: false, error: '背景程式沒有回應：' + err.message })
            }
            resolve(r === undefined ? { ok: false, error: '背景程式沒有回覆內容' } : r)
          })
        } catch (e) {
          resolve({ ok: false, error: '送不出去：' + (e && e.message ? e.message : e) })
        }
      }
      go()
    })
  }

  // 開場先問一次 health，順便把使用者設定的 port 拿回來
  ask({ type: 'health' }).then(r => { if (r && r.port) HOME = `http://127.0.0.1:${r.port}/` })
    .catch(() => {})

  /** 回來的東西可能有好幾種包法，都收。 */
  function planOf(r) {
    if (Array.isArray(r)) return { plan: r }
    if (r && Array.isArray(r.plan)) return { plan: r.plan }
    if (r && r.result && Array.isArray(r.result.plan)) return { plan: r.result.plan }
    return { error: (r && (r.error || r.message)) || '背景程式沒有給我 plan' }
  }

  // ── 五、畫面 ────────────────────────────────────────────────

  let marks = []          // { field, node }
  let panel = null
  let statusLine = null
  let shots = []          // 填之前的快照，給「全部還原」用
  const secretValues = new Map()   // 敏感值只放在這裡，不進 DOM、不進 field 物件

  function clearPaint() {
    for (const m of marks) m.node.remove()
    marks = []
    if (panel) { panel.remove(); panel = null }
  }

  function place(node, el) {
    const r = el.getBoundingClientRect()
    node.style.left = `${r.right + window.scrollX + 4}px`
    node.style.top = `${r.top + window.scrollY}px`
  }

  const MARK_BASE = {
    position: 'absolute', zIndex: '2147483646',
    font: '11px ui-monospace, SFMono-Regular, monospace',
    padding: '2px 6px', borderRadius: '3px', color: '#fff',
    whiteSpace: 'nowrap', maxWidth: '260px', overflow: 'hidden',
    textOverflow: 'ellipsis', opacity: '.94', lineHeight: '1.5',
  }

  function markNode(field) {
    const p = field.plan
    const action = field.state === 'filled' ? 'filled' : (p ? p.action : 'unknown')

    if (action === 'unknown' || (!p && field.key === null)) return null

    // 已經填好了：說清楚值是哪裡來的
    if (action === 'filled') {
      const n = E('div', { ...MARK_BASE, background: C.ok, pointerEvents: 'none' },
        `已填 · 來自 ${cut(field.filledFrom || '事實庫', 20)}`)
      if (field.filledNote) n.title = field.filledNote
      return n
    }

    if (action === 'fill') {
      if (field.needsClick) return button(field, '⚠ 兩邊說法不同，點了才填', C.pick,
        e => doFill(e, field, p.value, p.source))
      const n = E('div', { ...MARK_BASE, background: C.ok, pointerEvents: 'none' },
        `可填 · ${cut(field.defLabel || p.label || p.key, 14)}`)
      n.title = '按右下角的「填入所有安全欄位」'
      return n
    }
    if (action === 'pick') {
      return button(field, `選一筆（${(p.options || []).length}）▾`, C.pick,
        e => openMenu(e, field))
    }
    if (action === 'confirm-each-time') {
      // 敏感欄位：不自動填，不顯示值，每一次都要人再點一次
      return button(field, `🔒 ${cut(field.defLabel || p.label || p.key, 12)}：點一下才填`, C.lock,
        e => doSensitive(e, field))
    }
    if (action === 'compose') {
      const n = E('div', { ...MARK_BASE, background: C.compose, pointerEvents: 'none' },
        '這一欄要生成（這一版不填）')
      return n
    }
    if (action === 'missing') {
      const n = E('a', {
        ...MARK_BASE, background: C.miss, textDecoration: 'none',
        cursor: 'pointer', pointerEvents: 'auto',
      }, `庫裡沒有 ${cut(field.defLabel || p.label || p.key, 10)} · 去補`)
      n.href = HOME
      n.target = '_blank'
      n.rel = 'noreferrer noopener'
      return n
    }
    return null
  }

  function button(field, text, bg, onClick) {
    const b = E('button', {
      ...MARK_BASE, background: bg, border: '0', cursor: 'pointer',
      pointerEvents: 'auto', font: '11px ui-monospace, SFMono-Regular, monospace',
    }, text)
    b.type = 'button'                       // 不寫的話按鈕在 form 裡預設會送出表單
    b.addEventListener('click', e => {
      // 網頁可以用 el.click() 或 dispatchEvent 假造一次點擊，使用者根本沒動手。
      // 唯一可靠的分辨方式就是這一行。
      if (!e.isTrusted) return
      e.preventDefault()
      e.stopPropagation()
      // onClick 現在可能是 async。不接的話 rejection 會靜靜消失。
      Promise.resolve(onClick(e)).catch(err =>
        console.warn('[ContextBox] 動作出錯：', err))
    })
    return b
  }

  function paintMarks(fields) {
    for (const m of marks) m.node.remove()
    marks = []
    for (const f of fields) {
      const node = markNode(f)
      if (!node) continue
      place(node, f.el)
      document.body.appendChild(node)
      marks.push({ field: f, node })
    }
  }

  function repaintOne(field) {
    const m = marks.find(x => x.field === field)
    const node = markNode(field)
    if (m) {
      m.node.remove()
      if (!node) { marks = marks.filter(x => x !== m); return }
      place(node, field.el)
      document.body.appendChild(node)
      m.node = node
    } else if (node) {
      place(node, field.el)
      document.body.appendChild(node)
      marks.push({ field, node })
    }
  }

  // ── 六、面板 ────────────────────────────────────────────────

  function countOf(fields) {
    const c = { fill: 0, pick: 0, 'confirm-each-time': 0, compose: 0, missing: 0, unknown: 0, filled: 0 }
    for (const f of fields) {
      if (f.state === 'filled') { c.filled++; continue }
      const a = f.plan ? f.plan.action : (f.key ? null : 'unknown')
      if (a && a in c) c[a]++
    }
    return c
  }

  let collapsed = false
  function paintPanel(fields, note) {
    if (panel) panel.remove()
    const c = countOf(fields)
    const recognised = fields.filter(f => f.key).length

    panel = E('div', {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647',
      background: C.bg, color: C.fg, font: '12px ui-monospace, SFMono-Regular, monospace',
      padding: '14px 16px', borderRadius: '8px', width: '300px',
      maxHeight: '70vh', overflowY: 'auto', boxShadow: '0 4px 24px rgba(0,0,0,.45)',
      lineHeight: '1.7', textAlign: 'left',
    })

    // 面板是 300px 寬、蓋在最上層的。表單只要置中，欄位右邊的徽章就會被它蓋住，
    // 點下去完全沒反應——不是報錯，是點擊被面板吃掉。所以一定要能收起來。
    const head = E('div', { display: 'flex', justifyContent: 'space-between',
      alignItems: 'center', gap: '8px', marginBottom: '2px' })
    head.appendChild(E('div', { fontWeight: '600' }, 'ContextBox'))
    const fold = E('button', {
      background: 'transparent', border: `1px solid ${C.line}`, color: C.dim,
      borderRadius: '4px', cursor: 'pointer', padding: '1px 7px',
      font: '11px ui-monospace, monospace', pointerEvents: 'auto',
    }, collapsed ? '展開' : '收起')
    fold.type = 'button'
    fold.addEventListener('click', e => {
      if (!e.isTrusted) return
      e.preventDefault(); e.stopPropagation()
      collapsed = !collapsed
      paintPanel(fields, note)
    })
    head.appendChild(fold)
    panel.appendChild(head)

    if (collapsed) {
      panel.appendChild(E('div', { color: C.dim },
        `認出 ${recognised} 格。收起來的時候不會擋到欄位旁邊的按鈕。`))
      document.body.appendChild(panel)
      return
    }

    panel.appendChild(E('div', { color: C.dim, marginBottom: '8px' },
      `這一頁 ${fields.length} 格，認出 ${recognised} 格`))

    const row = (label, n, color) => {
      if (!n) return
      const d = E('div', { display: 'flex', justifyContent: 'space-between', gap: '8px' })
      d.appendChild(E('span', { color }, label))
      d.appendChild(E('span', { color: C.fg }, `${n} 格`))
      panel.appendChild(d)
    }
    row('已經填好', c.filled, C.okFg)
    row('可以直接填', c.fill, C.okFg)
    row('庫裡有多筆，要你選', c.pick, '#9C9BE8')
    row('敏感，每次都要你點', c['confirm-each-time'], '#D9A85C')
    row('要生成（這一版不填）', c.compose, '#B8A3E0')
    row('庫裡沒有', c.missing, C.warn)
    row('認不出來', c.unknown, C.dim)

    // 鐵則，寫在人看得到的地方
    panel.appendChild(E('div', {
      marginTop: '10px', paddingTop: '8px', borderTop: `1px solid ${C.line}`,
      color: C.okFg, fontWeight: '600',
    }, '我不會幫你按送出'))
    panel.appendChild(E('div', { color: C.dim, marginBottom: '10px' },
      '我只把值填進格子裡，按送出永遠是你自己的動作。\n'
      + '填的時候我也會擋下這一頁大部分的自動送出，但擋不死——'
      + '值一旦填進格子，這一頁的程式立刻讀得到，不用等你按送出。'))

    const bar = E('div', { display: 'flex', gap: '8px', flexWrap: 'wrap' })
    const mkBtn = (text, bg, fn) => {
      const b = E('button', {
        background: bg, color: '#fff', border: '0', borderRadius: '5px',
        padding: '7px 10px', cursor: 'pointer', flex: '1 1 auto',
        font: '12px ui-monospace, SFMono-Regular, monospace',
      }, text)
      b.type = 'button'
      b.addEventListener('click', e => { if (!e.isTrusted) return; e.preventDefault(); fn(e) })
      return b
    }
    const safe = fields.filter(f => f.plan && f.plan.action === 'fill' && !f.needsClick && f.state !== 'filled')
    if (safe.length) bar.appendChild(mkBtn(`填入所有安全欄位（${safe.length}）`, C.ok, e => fillSafe(e, fields)))
    if (shots.length) bar.appendChild(mkBtn('全部還原', '#4A3A3A', e => undoAll(e, fields)))
    if (bar.children.length) panel.appendChild(bar)

    statusLine = E('div', { color: C.dim, marginTop: '8px', whiteSpace: 'pre-wrap' },
      note || (c.fill || c.pick || c['confirm-each-time']
        ? '敏感欄位跟要選的欄位，請按那一格旁邊的按鈕。'
        : ''))
    panel.appendChild(statusLine)

    // 只有最上層才畫面板。之後 manifest 打開 all_frames 的話，
    // 每個 iframe 都畫一個會很吵。
    if (window.top === window) document.body.appendChild(panel)
  }

  function say(text) {
    if (statusLine) statusLine.textContent = text
  }

  // ── 七、填入 ────────────────────────────────────────────────

  /**
   * 掃描到填入之間隔了好幾百毫秒，頁面完全清醒，可以把欄位掉包、
   * 把標籤換掉、把它藏起來。所以填之前每一格都重驗一次。
   */
  function verify(field) {
    if (!field.el.isConnected) return '這一格已經不在頁面上了'
    if (HAS_FILL) {
      const v = CBFill.visibilityOf(field.el)
      if (!v.ok) return `這一格現在${v.why}`
    }
    const now = matchOf(field.el)
    const nowKey = now.def ? now.def.key : null
    if (nowKey !== field.key) return '這一格的標籤在你決定之後被改掉了'
    return null
  }

  /** 真正動手的地方。回 { ok, why } */
  function applyValue(field, value) {
    if (!HAS_FILL) return { ok: false, why: 'fill.js 沒有載入' }
    const bad = verify(field)
    if (bad) return { ok: false, why: bad }

    const fmt = CBFill.formatForDetail(field.el, field.key, value, field.label)
    if (fmt.value === null) return { ok: false, why: fmt.why }

    shots = shots.concat(CBFill.snapshot([field.el]))
    const r = CBFill.setValueDetail(field.el, fmt.value)
    if (!r.ok) {
      shots.pop()
      return { ok: false, why: r.why, choices: r.choices }
    }
    field.state = 'filled'
    field.filledNote = [
      fmt.guessed, fmt.warn,
      r.realValue ? `這個網站實際會收到：${r.realValue}` : null,
    ].filter(Boolean).join('；') || null
    return { ok: true, note: field.filledNote }
  }

  async function doFill(e, field, value, source) {
    if (e && !e.isTrusted) return
    // 三條填入路徑（批次、選一筆、敏感）都要走同一道守衛。
    // 以前只有批次有，等於最該保護的那兩條反而沒防線。
    const g = await CBFill.guardSubmits(() => {
      try { return applyValue(field, value) }
      catch (err) { return { ok: false, why: '填的時候出錯：' + ((err && err.message) || err) } }
    })
    const r = g.value
    field.filledFrom = source || '事實庫'
    repaintOne(field)
    say((r.ok
      ? `填好了：${field.defLabel}${r.note ? '（' + r.note + '）' : ''}`
      : `${field.defLabel} 沒填成功：${r.why}`)
      + (g.blocked ? `　⚠ 這一頁想趁機送出表單，被我攔下 ${g.blocked} 次。` : ''))
    refreshPanel()
  }

  /**
   * 敏感欄位。每一次都要人重新點一次，不留任何「這個網站以後都好」的狀態——
   * 填完就把值丟掉，下一次要填得再點一次。
   */
  /**
   * 敏感欄位：值永遠不提早下到頁面這一側。
   * 人按下去（而且是真的人按的）之後才臨時跟 background 要一次，填完立刻丟掉。
   */
  const inFlight = new WeakSet()
  async function doSensitive(e, field) {
    const p = field.plan
    if (!e.isTrusted) return                      // 頁面用 el.click() 假造的點擊，一律不理

    // 取值要一整個網路來回（實測 40～90ms）。這段期間按鈕還在原位，
    // 使用者很自然的連點，第二下就打到頁面藏在底下的東西。所以先鎖住。
    if (inFlight.has(field)) return
    inFlight.add(field)
    const btn = e.currentTarget
    if (btn && 'disabled' in btn) btn.disabled = true
    try {
      await doSensitiveInner(e, field, p)
    } finally {
      inFlight.delete(field)
      if (btn && 'disabled' in btn) btn.disabled = false
    }
  }

  async function doSensitiveInner(e, field, p) {

    const bad = verify(field)
    if (bad) { say(`${field.defLabel} 沒填：${bad}`); return }

    say(`正在取出 ${field.defLabel}…`)
    const res = await ask({ type: 'reveal', key: field.key })
    if (!res || res.ok !== true) {
      say(`${field.defLabel} 沒填：${(res && (res.message || res.error)) || '拿不到值'}`)
      return
    }
    // 拿到值之後再驗一次：從按下去到值回來之間，頁面可能把欄位換掉了
    const bad2 = verify(field)
    if (bad2) { say(`${field.defLabel} 沒填：${bad2}`); return }

    const g = await CBFill.guardSubmits(() => {
      try { return applyValue(field, res.value) }
      catch (err) { return { ok: false, why: '填的時候出錯：' + ((err && err.message) || err) } }
    })
    const r = g.value
    if (g.blocked) say(`⚠ 這一頁想趁機送出表單，被我攔下 ${g.blocked} 次。`)
    field.filledFrom = (p && p.source) || '事實庫'
    repaintOne(field)
    say(r.ok
      ? `填好了：${field.defLabel}。這是敏感資料，填進去這一頁的程式就讀得到，不用等你按送出。`
      : `${field.defLabel} 沒填成功：${r.why}`)
    refreshPanel()
  }

  let openedMenu = null
  function closeMenu() { if (openedMenu) { openedMenu.remove(); openedMenu = null } }

  function openMenu(e, field) {
    closeMenu()
    const p = field.plan
    const menu = E('div', {
      position: 'absolute', zIndex: '2147483647', background: C.bg, color: C.fg,
      border: `1px solid ${C.line}`, borderRadius: '6px', padding: '6px',
      font: '12px ui-monospace, SFMono-Regular, monospace', maxWidth: '320px',
      boxShadow: '0 4px 20px rgba(0,0,0,.45)', textAlign: 'left',
    })
    menu.appendChild(E('div', { color: C.dim, padding: '2px 6px 6px' },
      `${field.defLabel}：庫裡有 ${(p.options || []).length} 筆`))
    for (const o of p.options || []) {
      const b = E('button', {
        display: 'block', width: '100%', textAlign: 'left', background: 'transparent',
        color: C.fg, border: '0', borderRadius: '4px', padding: '5px 6px', cursor: 'pointer',
        font: '12px ui-monospace, SFMono-Regular, monospace',
      }, cut(o.value, 40) + (o.source ? `　（${cut(o.source, 14)}）` : ''))
      b.type = 'button'
      b.addEventListener('mouseenter', () => { b.style.background = '#26252C' })
      b.addEventListener('mouseleave', () => { b.style.background = 'transparent' })
      b.addEventListener('click', ev => {
        if (!ev.isTrusted) return
        ev.preventDefault()
        closeMenu()
        doFill(ev, field, o.value, o.source)
      })
      menu.appendChild(b)
    }
    const cancel = E('button', {
      display: 'block', width: '100%', textAlign: 'left', background: 'transparent',
      color: C.dim, border: '0', padding: '5px 6px', cursor: 'pointer',
      font: '12px ui-monospace, SFMono-Regular, monospace',
    }, '不要填這一格')
    cancel.type = 'button'
    cancel.addEventListener('click', ev => { if (ev.isTrusted) { ev.preventDefault(); closeMenu() } })
    menu.appendChild(cancel)

    const r = field.el.getBoundingClientRect()
    menu.style.left = `${r.left + window.scrollX}px`
    menu.style.top = `${r.bottom + window.scrollY + 4}px`
    document.body.appendChild(menu)
    openedMenu = menu
  }

  async function fillSafe(e, fields) {
    if (!e.isTrusted) return                    // 頁面假造的點擊不算數
    // 只碰現在真的看得到的欄位。可見性檢查對視窗外的一律回「量不出來」，
    // 硬填就等於 fail-open。捲到的時候按那一格自己的按鈕即可。
    const all = fields.filter(f =>
      f.plan && f.plan.action === 'fill' && !f.needsClick && f.state !== 'filled')
    const targets = all.filter(f => CBFill.inViewport(f.el))
    const offscreen = all.length - targets.length
    let ok = 0
    const failed = []

    // 填入會發出 input／change／click，頁面可以在那裡呼叫 form.submit()。
    // 我們說「永遠不會幫你按送出」，那這段期間就要真的把 submit 擋下來。
    const guarded = await CBFill.guardSubmits(() => {
      for (const f of targets) {
        // 一格丟例外只該毀那一格，不要毀整批
        let r
        try { r = applyValue(f, f.plan.value) }
        catch (e) { r = { ok: false, why: '填的時候出錯：' + ((e && e.message) || e) } }
        if (r.ok) { ok++; f.filledFrom = f.plan.source || '事實庫' }
        else failed.push(`${f.defLabel}：${r.why}`)
        repaintOne(f)
      }
    })

    const guessed = fields.filter(f => f.state === 'filled' && f.filledNote).length
    paintPanel(fields,
      `填好 ${ok} 格` +
      (guessed ? `，其中 ${guessed} 格有推算或提醒（把滑鼠移到標記上看）` : '') +
      (offscreen ? `\n另外 ${offscreen} 格在視窗外沒填。捲過去再按那一格旁邊的按鈕。` : '') +
      (failed.length ? `\n沒填成功 ${failed.length} 格：\n・${failed.join('\n・')}` : '') +
      (guarded.blocked
        ? `\n\n⚠ 這一頁試著在你按送出之前就自己送出表單 ${guarded.blocked} 次，我攔下來了。`
          + '這不是正常行為，這一頁要小心。'
        : '') +
      '\n檢查一下，沒問題再自己按送出。')
  }

  function undoAll(e, fields) {
    const n = CBFill.restore(shots.slice().reverse())
    shots = []
    for (const f of fields) { f.state = null; f.filledNote = null; f.filledFrom = null }
    paintMarks(fields)
    paintPanel(fields, `還原了 ${n} 格。敏感欄位要重新掃描才能再填一次。`)
  }

  /** 面板重畫，但把剛剛那句狀態訊息留著 */
  function refreshPanel() {
    const note = statusLine ? statusLine.textContent : ''
    paintPanel(lastFields, note)
  }

  // ── 八、跑起來 ──────────────────────────────────────────────

  let lastFields = []
  let lastSummary = { total: 0, hit: 0 }

  async function run() {
    closeMenu()
    if (HAS_FILL) CBFill.watchComposition(document)
    const { fields, hiddenSkipped } = scan()
    lastFields = fields
    shots = []
    secretValues.clear()

    const dropped = fields.filter(f => f.dropped)
    if (dropped.length) {
      // 只進 console，不寫進頁面——不要告訴攻擊者他哪一招被擋了
      console.warn('[ContextBox] 這幾格認出來了但我決定不填：',
        dropped.map(f => ({ 標籤: f.label, 原因: f.dropped })))
    }

    const recognised = fields.filter(f => f.key)
    lastSummary = {
      total: fields.length, hit: recognised.length,
      hidden: hiddenSkipped, dropped: dropped.length,
    }

    clearPaint()
    if (!recognised.length) {
      paintMarks(fields)
      paintPanel(fields, hiddenSkipped ? `另外跳過 ${hiddenSkipped} 個看不見的欄位。` : '')
      return lastSummary
    }

    paintPanel(fields, '正在問事實庫這些欄位怎麼填…')

    // 只送 key，不送標籤、不送值、不送網址
    const keys = [...new Set(recognised.map(f => f.key))]
    const res = await ask({ type: 'plan', keys })
    const { plan, error } = planOf(res)

    if (error) {
      paintMarks(fields)
      paintPanel(fields, `問不到事實庫：${error}\n`
        + '先確認本機的 ContextBox 有在跑，然後在擴充套件的設定頁貼上鑰匙。')
      return lastSummary
    }

    // 敏感值根本不會出現在 plan 裡 —— background 已經拿掉了，只留 needsReveal。
    // 值要等人真的點下去，才臨時去要一次，用完就丟。
    const byKey = new Map(plan.map(p => [p.key, p]))
    for (const f of fields) {
      f.plan = f.key ? (byKey.get(f.key) || { key: f.key, action: 'unknown' }) : null
    }
    secretValues.clear()

    paintMarks(fields)
    paintPanel(fields, hiddenSkipped ? `另外跳過 ${hiddenSkipped} 個看不見的欄位。` : '')
    return lastSummary
  }

  // 同時只跑一次掃描。popup 連按兩下、或載入時剛好又收到訊息，
  // 兩次交錯跑會互相蓋掉對方畫的標記。
  let running = null
  function runOnce() {
    if (!running) running = run().finally(() => { running = null })
    return running
  }

  // 版面變了標記就會跑掉，重新對位一次
  let rePos = null
  window.addEventListener('resize', () => {
    clearTimeout(rePos)
    rePos = setTimeout(() => {
      for (const m of marks) if (m.field.el.isConnected) place(m.node, m.field.el)
    }, 150)
  })
  document.addEventListener('click', e => {
    if (openedMenu && !openedMenu.contains(e.target)) closeMenu()
  }, true)

  if (typeof chrome !== 'undefined') {
    chrome.runtime?.onMessage?.addListener((msg, _sender, send) => {
      const type = typeof msg === 'string' ? msg : (msg && msg.type)
      if (type === 'cb-scan' || type === 'cb-rescan') {
        runOnce().then(send, err => send({ total: 0, hit: 0, error: String((err && err.message) || err) }))
        return true                         // 非同步回覆，通道要留著
      }
      return undefined
    })
  }

  globalThis.__contextboxRescan = () =>
    runOnce().catch(e => console.warn('[ContextBox] 掃描出錯：', e))

  // **不自動跑。**
  //
  // 以前是每一頁載入就掃描並在頁面上畫標記，標記文字寫著哪些 key 庫裡有東西——
  // 那等於把「你存了哪些個資」漏給每一個你造訪的網站，而且你一下都沒點過。
  //
  // 現在要人點工具列圖示、按「掃描這一頁」，popup.js 才用 activeTab 把這支注入。
  // 注入完緊接著會收到一則 cb-scan，由上面那個 onMessage 處理。
})()
