const quaso = document.getElementById('quaso')

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

function currentState() {
  return transientState ?? baseState
}

function renderState() {
  const state = currentState()

  if (quaso.dataset.petState === state) return

  quaso.dataset.petState = state

  document.dispatchEvent(new CustomEvent('quaso:statechange', {
    detail: { state },
  }))
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