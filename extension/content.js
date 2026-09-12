/**
 * ContextBox 欄位偵測原型
 *
 * 這一版只做一件事：掃描頁面上的表單欄位，report 我們認得出幾個。
 * 它不填任何值，也不跟任何東西連線。先證明比對這條路通不通。
 */

/** 從一個表單元素身上，照優先順序挖出所有可能的「標籤文字」 */
function labelCandidates(el) {
  const out = []
  const push = v => { if (v && String(v).trim()) out.push(String(v).trim()) }

  // 1. <label for="id">
  if (el.id) {
    const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
    push(l?.textContent)
  }
  // 2. 被 <label> 包住
  push(el.closest('label')?.textContent)
  // 3. 無障礙屬性
  push(el.getAttribute('aria-label'))
  const lb = el.getAttribute('aria-labelledby')
  if (lb) lb.split(/\s+/).forEach(id => push(document.getElementById(id)?.textContent))
  // 4. 表格：同一列的第一格
  const td = el.closest('td, dd')
  if (td) {
    push(td.previousElementSibling?.textContent)
    push(td.closest('tr')?.querySelector('th')?.textContent)
  }
  // 5. 前面那個兄弟節點的文字
  push(el.previousElementSibling?.textContent)
  // 6. radio / checkbox 群組的 legend
  push(el.closest('fieldset')?.querySelector('legend')?.textContent)
  // 7. 最後才用 placeholder 跟屬性
  push(el.placeholder)
  push(el.name)
  push(el.id)

  return [...new Set(out.map(s => s.replace(/\s+/g, ' ').slice(0, 40)))]
}

/** 掃整頁，回傳每個欄位的比對結果 */
function scan() {
  const els = [...document.querySelectorAll(
    'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=password]), select, textarea'
  )]
  const seenRadio = new Set()

  return els.flatMap(el => {
    // radio 群組只算一次
    if (el.type === 'radio') {
      if (seenRadio.has(el.name)) return []
      seenRadio.add(el.name)
    }
    const cands = labelCandidates(el)

    const { def, layer, via, conflict } = CB.matchField({
      autocomplete: el.getAttribute('autocomplete'),
      labels: cands,
    })
    return [{
      el,
      label: cands[0] ?? '(無標籤)',
      key: def?.key ?? null,
      sensitivity: def ? def.sensitivity : null,
      autofill: def ? CB.canAutofill(def.key) : false,
      layer, via, conflict,
    }]
  })
}

const COLOR = {
  1: '#2F6E4F',      // autocomplete 命中
  2: '#3B3A8C',      // 標籤命中
  0: '#A3301B',      // 沒認出來
}

/** 在每個欄位旁邊畫一個小徽章 */
function paint(results) {
  document.querySelectorAll('.cb-badge, #cb-panel').forEach(n => n.remove())

  for (const r of results) {
    const rect = r.el.getBoundingClientRect()
    if (!rect.width && !rect.height) continue
    const b = document.createElement('div')
    b.className = 'cb-badge'
    b.textContent = r.key
      ? `${r.key}${r.sensitivity === 'sensitive' ? ' 🔒' : ''}`
      : '?'
    Object.assign(b.style, {
      position: 'absolute',
      left: `${rect.right + window.scrollX + 4}px`,
      top: `${rect.top + window.scrollY}px`,
      background: COLOR[r.layer],
      color: '#fff',
      font: '11px ui-monospace, monospace',
      padding: '2px 6px',
      borderRadius: '3px',
      zIndex: 2147483647,
      pointerEvents: 'none',
      whiteSpace: 'nowrap',
      opacity: '.92',
    })
    document.body.appendChild(b)
  }

  const hit = results.filter(r => r.key).length
  const l1 = results.filter(r => r.layer === 1).length
  const l2 = results.filter(r => r.layer === 2).length
  const miss = results.filter(r => !r.key)

  const p = document.createElement('div')
  p.id = 'cb-panel'
  Object.assign(p.style, {
    position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483647,
    background: '#16161A', color: '#E9E8EE', font: '12px ui-monospace, monospace',
    padding: '14px 16px', borderRadius: '6px', maxWidth: '320px',
    maxHeight: '50vh', overflowY: 'auto', boxShadow: '0 4px 20px rgba(0,0,0,.35)',
    lineHeight: '1.6',
  })
  p.innerHTML =
    `<div style="font-weight:600;margin-bottom:6px">ContextBox 欄位偵測</div>` +
    `<div>共 <b>${results.length}</b> 個欄位，認出 <b style="color:#72C79A">${hit}</b> 個` +
    ` （${Math.round(hit / Math.max(results.length, 1) * 100)}%）</div>` +
    `<div style="color:#8B8A98">第 1 層 autocomplete：${l1}　第 2 層 標籤：${l2}</div>` +
    (miss.length
      ? `<div style="margin-top:8px;color:#EE8C74">認不出來的：</div>` +
        miss.map(m => `<div style="color:#BCBAC6">・${m.label}</div>`).join('')
      : `<div style="margin-top:8px;color:#72C79A">全部認出來了</div>`)
  document.body.appendChild(p)

  return { total: results.length, hit, l1, l2, miss: miss.map(m => m.label) }
}

function run() {
  const results = scan()
  const summary = paint(results)
  console.table(results.map(({ el, ...r }) => r))
  return summary
}

chrome.runtime?.onMessage?.addListener((msg, _s, send) => {
  if (msg === 'cb-scan') { send(run()); return true }
})

run()
