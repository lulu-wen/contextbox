function getQuaso() {
  return document.getElementById('quaso')
}

const VALID_STATES = new Set([
  'idle',
  'found',
  'thinking',
  'cleaning',
  'restoring',
  'happy',
  'worried',
])

let baseState = 'idle'
let transientState = null
let transientTimer = null
let messageData = {}
export function getPetMessageData() { return messageData }
export function setPetMessageData(data) {
  messageData = { ...messageData, ...data }
  // 跟 renderState() 一樣要守：測試那份假 DOM 不一定有 dispatchEvent
  if (typeof document !== 'undefined'
    && typeof document.dispatchEvent === 'function'
    && typeof CustomEvent === 'function') {
    document.dispatchEvent(new CustomEvent('quaso:messagechange'))
  }
}

function currentState() {
  return transientState ?? baseState
}

function renderState() {
  const quaso = getQuaso()
  if (!quaso) return

  const state = currentState()

  if (quaso.dataset.petState === state) return

  quaso.dataset.petState = state

  // **worried 的時候不要把按鈕鎖起來。** 隊友原本的版本會把三顆都 disabled，
  // 但「掃描出問題」也算 worried —— 那正是使用者要打開面板看清楚的時候，
  // 鎖起來就變成死路（連歷史面板也打不開）。灰掉當提示就夠了。

  if (
    typeof document !== 'undefined' &&
    typeof document.dispatchEvent === 'function' &&
    typeof CustomEvent === 'function'
  ) {
    document.dispatchEvent(new CustomEvent('quaso:statechange', {
      detail: { state }
    }))
  }
}

export function setPetBaseState(state) {
  if (!VALID_STATES.has(state)) {
    console.warn(`Unknown pet state: ${state}`)
    return
  }

  baseState = state
  renderState()
}

export function setPetTransientState(state) {
  if (!VALID_STATES.has(state)) {
    console.warn(`Unknown pet state: ${state}`)
    return
  }

  if (transientTimer) {
    clearTimeout(transientTimer)
    transientTimer = null
  }

  transientState = state
  renderState()
}

export function clearPetTransientState() {
  if (transientTimer) {
    clearTimeout(transientTimer)
    transientTimer = null
  }

  transientState = null
  renderState()
}

export function flashPetState(state, duration = 1800) {
  setPetTransientState(state)

  transientTimer = setTimeout(() => {
    transientTimer = null
    transientState = null
    renderState()
  }, duration)
}

export function getPetState() {
  return currentState()
}
