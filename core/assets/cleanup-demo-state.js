// 純記憶體 demo，不呼叫清理 API、不搬移檔案。
export function createDemo(data) {
  const source = structuredClone(data.candidates)
  let candidates, selected, lastPlan
  const reset = () => {
    candidates = [...source]
    selected = new Set(candidates.filter(c => c.defaultChecked).map(c => c.itemId))
    lastPlan = null
  }
  reset()
  return {
    reset,
    get candidates() { return candidates },
    get selected() { return selected },
    get canUndo() { return Boolean(lastPlan) },
    get bytes() { return candidates.filter(c => selected.has(c.itemId)).reduce((n, c) => n + c.bytes, 0) },
    select(id, checked) {
      if (!candidates.some(c => c.itemId === id)) return
      if (checked) selected.add(id)
      else selected.delete(id)
    },
    restoreItems(items) {
      const existing = new Set(candidates.map(c => c.itemId))
      const restored = new Set(items.map(i => i.itemId))
      for (const item of source) {
        if (restored.has(item.itemId) && !existing.has(item.itemId) && item.defaultChecked) selected.add(item.itemId)
      }
      candidates = source.filter(c => existing.has(c.itemId) || restored.has(c.itemId))
    },
    apply() {
      if (lastPlan) throw new Error('請先復原或重新開始示範。')
      const items = candidates.filter(c => selected.has(c.itemId))
      if (!items.length) throw new Error('請至少選擇一個檔案。')
      lastPlan = { items, selected: new Set(selected) }
      candidates = candidates.filter(c => !selected.has(c.itemId))
      selected = new Set()
      return {
        status: 'applied', quarantined: items.length, failed: 0,
        bytesFreed: items.reduce((n, c) => n + c.bytes, 0), canUndo: true,
        candidateIds: items.flatMap(c => c.candidateIds),
      }
    },
    undo() {
      if (!lastPlan) throw new Error('目前沒有可以復原的清理。')
      const restored = lastPlan.items.length
      const ids = new Set([...candidates, ...lastPlan.items].map(c => c.itemId))
      candidates = source.filter(c => ids.has(c.itemId))
      selected = lastPlan.selected
      lastPlan = null
      return { status: 'restored', restored, failed: 0 }
    },
  }
}
