export type PetState =
  | 'idle'
  | 'found'
  | 'thinking'
  | 'cleaning'
  | 'restoring'
  | 'happy'
  | 'worried'

export type PetStateListener = (state: PetState) => void

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