// 本機模式：接真的清理路由，會真的搬動 Downloads 裡的檔案。
//
// 介面刻意跟 cleanup-demo-state.js 的 createDemo 一樣（candidates／selected／
// canUndo／bytes／select／apply／undo），讓面板的渲染兩個模式共用。
// 差別是 apply／undo 是 async，而且回傳的是**後端說的結果**，不是前端推算的。
//
// api 由呼叫端注入（瀏覽器是 window.api，測試是打真 server 的 fetch），
// 錯誤要帶 .code 與 .status —— 分不出錯誤種類的話，下面三種處置就沒辦法分開。

export function createReal(api, { uuid = () => crypto.randomUUID() } = {}) {
  let candidates = [], needsHuman = [], selected = new Set(), loaded = false
  // 目前這一次清理的請求。**同一份勾選重送時沿用同一個 requestId**，
  // 後端靠它認出「這是同一次」而回傳同一份計畫，不會多建一份、也不會多搬一次。
  let request = null           // { requestId, candidateIds, planId?, uncertain }
  // 別人留下、還佔著檔案的計畫。找到時要先給使用者看，**不可以自動套用** ——
  // 那份的內容可能跟現在的勾選不一樣。
  let pendingPlan = null       // { id, items }
  let lastPlan = null          // { id, undoable }

  const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) })
  const sameIds = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

  async function load() {
    const r = await api('/cleanup/candidates?limit=1000')
    const before = new Set(candidates.map(c => c.itemId))
    const wanted = selected
    candidates = r.candidates ?? []
    needsHuman = r.needsHuman ?? []
    // 第一次載入用預設勾選。之後重載：**還在的那些保留使用者的選擇**
    // （使用者對它們的意圖沒變），新出現的才用預設。
    selected = new Set(candidates
      .filter(c => loaded && before.has(c.itemId) ? wanted.has(c.itemId) : c.defaultChecked)
      .map(c => c.itemId))
    loaded = true
  }

  // 有一份計畫可能已經建在後端、而且還沒套用完：勾選要鎖住。
  // 改了勾選就會換新的 requestId → 撞上自己剛建的那份 → CONFLICT。
  const isLocked = () => Boolean(pendingPlan) || Boolean(request?.uncertain)

  function outcomeOf(plan) {
    const failed = plan.items.filter(i => i.outcome === 'failed')
      .map(i => ({ itemId: i.itemId, name: i.name, why: i.why }))
    return {
      status: plan.status,
      planId: plan.id,
      moved: plan.quarantinedCount,
      failed,
      bytesFreed: plan.quarantinedBytes,
      undoable: plan.undoable,
    }
  }

  async function applyPlanId(planId) {
    const plan = await post(`/cleanup/plans/${encodeURIComponent(planId)}/apply`)
    lastPlan = { id: plan.id, undoable: plan.undoable }
    request = null
    pendingPlan = null
    await load()
    return outcomeOf(plan)
  }

  return {
    load,
    get candidates() { return candidates },
    get needsHuman() { return needsHuman },
    get selected() { return selected },
    get locked() { return isLocked() },
    get pendingPlan() { return pendingPlan },
    get canUndo() { return Boolean(lastPlan?.undoable) },
    get bytes() { return candidates.filter(c => selected.has(c.itemId)).reduce((n, c) => n + c.bytes, 0) },

    select(id, checked) {
      if (isLocked()) return
      if (!candidates.some(c => c.itemId === id)) return
      if (checked) selected.add(id)
      else selected.delete(id)
      request = null
    },

    async apply() {
      // 使用者看過上次那份、按了「繼續上次那份」
      if (pendingPlan) return applyPlanId(pendingPlan.id)

      // **結果不明的時候，原封不動沿用上一次的請求。**
      // 不可以用「現在的勾選」重算再比：重新打開面板會 load()，已經搬走的檔
      // 從清單消失、勾選跟著變，一比就不同 → 換掉 requestId、丟掉 planId ——
      // 使用者看到「請至少選擇一個檔案」，卻不知道檔案其實已經搬走了。
      if (!request?.uncertain) {
        // **送勾了的那些，而且每個檔的每一條理由都要送。**
        // 不可以「不帶 id 讓後端拿預設勾的，再用 skippedIds 扣掉」——
        // 那樣使用者主動勾起來的低信心檔根本不在計畫裡，勾了卻沒搬。
        const candidateIds = candidates.filter(c => selected.has(c.itemId))
          .flatMap(c => c.candidateIds).sort()
        if (!candidateIds.length) throw new Error('請至少選擇一個檔案。')
        if (!request || !sameIds(request.candidateIds, candidateIds)) {
          request = { requestId: uuid(), candidateIds, planId: null, uncertain: false }
        }
      }
      const { candidateIds } = request

      if (!request.planId) {
        let plan
        try {
          // 送出之後、拿到回應之前，後端可能已經建好了 —— 先當成不確定
          request.uncertain = true
          plan = await post('/cleanup/plans', { candidateIds, requestId: request.requestId })
        } catch (e) {
          // 伺服器有回應（有 status）＝ 確定沒建成。沒有 status ＝ 網路斷了，不確定。
          if (e.status) request.uncertain = false

          if (e.code === 'STALE_CANDIDATE') {
            // **清單變了就一個都不搬**，重載給使用者再看一眼。不自動重試。
            request = null
            await load()
            return { status: 'stale' }
          }
          if (e.code === 'CONFLICT') {
            // 有別的計畫佔著這些檔（上次關掉頁面留下的、或 CLI 建的）。
            // 找出來給使用者看，讓他選擇接續 —— 不可以自動套用。
            request = null
            const pending = await api('/cleanup/plans?pending=1&limit=1')
            const op = pending.operations?.[0]
            if (op) {
              pendingPlan = { id: op.id, items: op.items }
              return { status: 'pending-plan', plan: pendingPlan }
            }
          }
          if (e.status) request = null
          throw e
        }
        request.planId = plan.id
      }

      try {
        return await applyPlanId(request.planId)
      } catch (e) {
        // 計畫已經建好了。不管 apply 有沒有回應，都要沿用同一份重試 ——
        // 所以維持鎖住，只能「再試一次」。
        request.uncertain = true
        throw e
      }
    },

    async undo() {
      if (!lastPlan) throw new Error('目前沒有可以復原的清理。')
      const plan = await post(`/cleanup/plans/${encodeURIComponent(lastPlan.id)}/undo`)
      lastPlan = { id: plan.id, undoable: plan.undoable }
      // **從後端重載，不要自己把檔加回清單。** 復原過的檔 A 的規則不會再提議
      // （你復原過就代表想留著），前端加回去的話，勾它會撞 STALE。
      await load()
      return {
        status: plan.status,
        planId: plan.id,
        restored: plan.restoredCount,
        // 原位置被佔時放回來的那份會改名。要講出來，不然使用者以為「放回原位」
        renamed: plan.items.filter(i => i.outcome === 'restored' && i.restoredAs)
          .map(i => ({ name: i.name, restoredAs: i.restoredAs })),
        failed: plan.items.filter(i => i.outcome === 'moved').map(i => ({ name: i.name })),
      }
    },
  }
}

// 歷史面板的轉接器：把 C 的 demo 歷史介面（historyApi）接到真的路由。
// 回應形狀跟 /demo/cleanup/history 與 /demo/cleanup/undo 一樣，
// C 的 renderHistory 兩個模式共用。
export function createRealHistory(api) {
  const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) })
  return async function history(path, body) {
    if (path.startsWith('history') && body === undefined) {
      const q = new URLSearchParams(path.split('?')[1] ?? '')
      q.set('undoable', '1')
      return api('/cleanup/plans?' + q.toString())
    }
    if (path === 'undo') {
      const ids = [...new Set(body?.operationIds ?? [])]
      let restored = 0, restoredFiles = 0, alreadyRestored = 0
      const restoredItems = [], renamed = []
      for (const id of ids) {
        // **先看復原前還有哪些在隔離區。** undo 是冪等的：已經復原過的再送一次，
        // 後端回的計畫長得一模一樣（項目都是 restored）—— 只看回應的話，
        // 重送會被算成「又放回來一次」。
        const before = await api(`/cleanup/plans/${encodeURIComponent(id)}`)
        const inQuarantine = new Set(before.items.filter(i => i.outcome === 'moved').map(i => i.itemId))
        if (!inQuarantine.size) continue
        const plan = await post(`/cleanup/plans/${encodeURIComponent(id)}/undo`)
        const back = plan.items.filter(i => inQuarantine.has(i.itemId) && i.outcome === 'restored')
        for (const i of back) if (i.restoredAs) renamed.push({ name: i.name, restoredAs: i.restoredAs })
        if (back.length) {
          restored++
          restoredFiles += back.length
          restoredItems.push(...back.map(i => ({ itemId: i.itemId, name: i.name, bytes: i.bytes })))
        }
      }
      alreadyRestored = ids.length - restored
      return { restored, restoredFiles, restoredItems, alreadyRestored, operationIds: ids, renamed }
    }
    throw new Error('本機模式不支援這個歷史操作：' + path)
  }
}
