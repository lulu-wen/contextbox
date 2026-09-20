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
  errorSeverity?: 'warning' | 'error' | null;
  sectionCounts?: Partial<Record<'clean' | 'bursts' | 'renames' | 'filings' | 'learned', number>>;
  lastAction?: string | null; freedBytes?: number; restoredCount?: number; errorMessage?: string;
  /** 這一次有幾個**沒有**回到原位（放不回去的＋結果不明的）。>0 就不可以說「完成」。 */
  leftBehind?: number;
} = {}) {
  const {
    candidates = [], sectionCounts = {}, lastAction = null, freedBytes = 0,
    restoredCount = 0, errorMessage = '', leftBehind = 0, errorSeverity = null,
  } = data
  function formatBytes(bytes: number) {
    const units = ['B', 'KB', 'MB', 'GB']
    let value = Math.max(0, bytes), index = 0
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index++ }
    return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`
  }
  const count = (n: number, one: string, many: string = one + 's') => `${n} ${n === 1 ? one : many}`
  switch (state) {
    case 'idle': return 'I keep an eye on your download folders for files worth clearing out.'
    case 'thinking': return 'Looking through the files. One moment…'
    case 'found': {
      const labels = { clean: 'Cleanup', bursts: 'Bursts', renames: 'Suggested names', filings: 'Filing', learned: 'Learned' }
      const parts = (Object.keys(labels) as (keyof typeof labels)[])
        .filter(key => Number.isFinite(sectionCounts[key]) && (sectionCounts[key] ?? 0) > 0)
        .map(key => `${labels[key]} (${sectionCounts[key]})`)
      return parts.length ? `Ready to review: ${parts.join(', ')}. Have a look.` : 'Nothing to review right now.'
    }
    case 'cleaning': return candidates.length ? `Tidying up ${count(candidates.length, 'file')}…` : 'Tidying up your files…'
    case 'restoring': return 'Putting your files back…'
    case 'happy':
      if (lastAction === 'cleaning') return freedBytes > 0
        ? `Cleanup done. Moved ${formatBytes(freedBytes)} into quarantine ✨` : 'Cleanup done. The files are in quarantine ✨'
      if (lastAction === 'restoring') {
        // **部分放回不可以講成完成**（稽核 2026-09-20）：一個檔還卡在隔離區裡，
        // 而泡泡說「Undo done ✨」——那是在騙人。呼叫端本來就不該在這時候進 happy，
        // 這裡是第二道：真的走到了，也要把還沒回去的講出來。
        if (leftBehind > 0) {
          return `Put ${count(restoredCount, 'file')} back; ${count(leftBehind, 'file')} did not go back. The panel says why.`
        }
        return restoredCount > 0 ? `Undo done. Put ${count(restoredCount, 'file')} back ✨` : 'Undo done ✨'
      }
      return 'All done ✨'
    case 'worried':
      if (errorSeverity === 'warning') return errorMessage ? `Warning: ${errorMessage}` : 'Some files need your attention.'
      return errorMessage ? `Something is not right: ${errorMessage}` : 'Something is not right. Try again in a moment.'
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
