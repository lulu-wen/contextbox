export type PetState =
  | 'idle'
  | 'found'
  | 'thinking'
  | 'cleaning'
  | 'restoring'
  | 'happy'
  | 'worried'

export type PetStateListener = (state: PetState) => void

export function getPetMessage(state: string, data: {
  candidates?: { reason?: string; kind?: string; reasons?: { kind?: string }[] }[];
  candidateCount?: number;
  lastAction?: string | null; freedBytes?: number; restoredCount?: number; errorMessage?: string;
} = {}) {
  const { candidates = [], candidateCount = candidates.length, lastAction = null, freedBytes = 0, restoredCount = 0, errorMessage = '' } = data
  function formatBytes(bytes: number) {
    const units = ['B', 'KB', 'MB', 'GB']
    let value = Math.max(0, bytes), index = 0
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index++ }
    return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`
  }
  switch (state) {
    case 'idle': return '我會幫你留意 Downloads 裡有沒有可以整理的檔案！'
    case 'thinking': return '正在查看檔案，請稍等一下……'
    case 'found': {
      if (!candidates.length) return `找到 ${candidateCount} 個可能可以清理的檔案！點清理看看吧。`
      const labels: Record<string, string> = { duplicate: '重複檔案', partial: '未完成下載', empty: '空檔案',
        installer: '安裝檔', archive: '壓縮檔', 'old-download': '久未使用的下載檔案', 'screenshot-noise': '可能不需要的截圖' }
      const counts: Record<string, number> = {}
      for (const item of candidates) {
        const kind = [item.reason, item.kind, ...(item.reasons ?? []).map(r => r.kind)].find(k => k && Object.hasOwn(labels, k))
        if (kind) counts[kind] = (counts[kind] ?? 0) + 1
      }
      const parts = Object.keys(labels).filter(k => counts[k]).map(k => `${counts[k]} 個${labels[k]}`)
      const total = candidateCount || candidates.length
      const batchCount = candidates.length
      if (total > batchCount) {
        return `這次先處理其中 ${batchCount} 個。${parts.length ? `包含${parts.join('、')}。` : ''}`
      }
      return `找到 ${total} 個可能可以清理的檔案！${parts.length ? `包含${parts.join('、')}。` : ''}`
    }
    case 'cleaning': return candidates.length ? `正在幫你整理 ${candidates.length} 個檔案……` : '正在幫你整理檔案……'
    case 'restoring': return '正在幫你復原檔案……'
    case 'happy':
      if (lastAction === 'cleaning') return freedBytes > 0
        ? `清理完成！已將 ${formatBytes(freedBytes)} 的檔案移入隔離區 ✨` : '清理完成！檔案已經移到隔離區 ✨'
      if (lastAction === 'restoring') return restoredCount > 0
        ? `復原完成！已經幫你復原 ${restoredCount} 個檔案 ✨` : '復原完成！✨'
      return '完成了！✨'
    case 'worried': return errorMessage ? `好像遇到了一點問題：${errorMessage}` : '好像遇到了一點問題，請稍後再試一次。'
    default: return ''
  }
}

export function createPetState(initial: PetState = 'idle') {
  let state: PetState = initial
  let transient: PetState | null = null
  const listeners = new Set<PetStateListener>()

  function emit() {
    const current = transient ?? state
    for (const listener of listeners) listener(current)
  }

  return {
    get state(): PetState {
      return transient ?? state
    },

    /**
     * 後端的持久狀態。
     * thinking / cleaning / restoring / happy 播放期間，
     * health polling 不應把動畫蓋掉。
     */
    setBase(next: PetState) {
      state = next
      if (!transient) emit()
    },

    /**
     * 前端操作期間的暫時狀態。
     */
    setTransient(next: PetState) {
      transient = next
      emit()
    },

    clearTransient() {
      transient = null
      emit()
    },

    subscribe(listener: PetStateListener) {
      listeners.add(listener)
      listener(transient ?? state)

      return () => listeners.delete(listener)
    },
  }
}
