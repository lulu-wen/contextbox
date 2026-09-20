import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { getPetMessage } from '../core/pet-state.ts'

const source = readFileSync(new URL('../core/assets/cleanup-demo.js', import.meta.url), 'utf8')
const updateSource = source.match(/function updateAlert\(\) \{[\s\S]*?\n\}/)[0]
const labels = { clean: 'Cleanup', bursts: 'Bursts', renames: 'Suggested names', filings: 'Filing', learned: 'Learned' }

function alertState(counts, { acknowledged = false, running = false, problem = null } = {}) {
  const element = { setAttribute() {}, classList: { toggle() {}, add() {}, remove() {} } }
  const context = vm.createContext({
    healthChecked: true, health: { pendingCandidates: counts.clean ?? 0 }, demo: null,
    busy: false, historyBusy: false, previousCount: 0, candidatesAcknowledged: acknowledged,
    reading: { running }, $: () => element, alertButton: element,
    plural: n => String(n), currentPetProblem: () => problem,
    sectionCounts: () => counts, session: () => null,
    setPetMessageData: data => { context.messageData = data },
    setPetBaseState: state => { context.state = state }, clearPetTransientState() {},
    scanProblems: () => [], renderScanProblems() {}, renderReading() {},
  })
  vm.runInContext(updateSource + '\nupdateAlert()', context)
  return context
}

for (const [key, label] of Object.entries(labels)) {
  test(`${label} alone triggers found and supplies its count to the message`, () => {
    const result = alertState({ [key]: 2 })
    assert.equal(result.state, 'found')
    assert.equal(getPetMessage(result.state, result.messageData), `Ready to review: ${label} (2). Have a look.`)
  })
}

test('found lists all five sections without mixing their units or cleanup reasons', () => {
  assert.equal(getPetMessage('found', {
    sectionCounts: { clean: 8, bursts: 2, renames: 3, filings: 4, learned: 1 },
    candidateCount: 999, candidates: [{ reason: 'duplicate' }],
  }), 'Ready to review: Cleanup (8), Bursts (2), Suggested names (3), Filing (4), Learned (1). Have a look.')
})

test('missing, zero and invalid counts do not create suggestions', () => {
  assert.equal(getPetMessage('found'), 'Nothing to review right now.')
  assert.equal(getPetMessage('found', { sectionCounts: { clean: 0, bursts: -1, renames: NaN } }), 'Nothing to review right now.')
  const result = alertState({ clean: 0, bursts: 0, renames: 0, filings: 0, learned: 0 }, { acknowledged: true })
  assert.equal(result.state, 'idle')
  assert.equal(result.candidatesAcknowledged, false)
})

test('acknowledgement suppresses found; worried and thinking take priority', () => {
  assert.equal(alertState({ renames: 2 }, { acknowledged: true }).state, 'idle')
  assert.equal(alertState({ renames: 2 }, { running: true }).state, 'thinking')
  const result = alertState({ renames: 2 }, { running: true, problem: { message: 'Backend offline' } })
  assert.equal(result.state, 'worried')
  assert.equal(getPetMessage(result.state, result.messageData), 'Something is not right: Backend offline')
})

test('operation messages remain state-driven', () => {
  assert.equal(getPetMessage('happy', { lastAction: 'cleaning', freedBytes: 1024 }), 'Cleanup done. Moved 1.0 KB into quarantine ✨')
  assert.equal(getPetMessage('happy', { lastAction: 'restoring', restoredCount: 2 }), 'Undo done. Put 2 files back ✨')
  assert.doesNotMatch(source, /\bnotice\s*\(/)
})

test('section counts exclude needsHuman and burst members from Cleanup', () => {
  const session = { candidates: [{ itemId: 'clean' }, { itemId: 'burst' }], needsHuman: [{ itemId: 'manual' }] }
  const context = vm.createContext({
    session: () => session, isDemo: () => false, proposalItems: s => s.candidates,
    bursts: { memberIds: () => new Set(['burst']), groups: [{}] },
    renames: { items: [{}, {}] }, filings: { items: [] }, learned: { items: [{}] },
  })
  const code = source.match(/function sectionCounts\(\) \{[\s\S]*?\n\}/)[0]
  const counts = vm.runInContext(code + '\nsectionCounts()', context)
  assert.deepEqual({ ...counts }, { clean: 1, bursts: 1, renames: 2, filings: 0, learned: 1 })
})

function problemHarness() {
  const healthCode = source.match(/function systemHealthProblem\(\) \{[\s\S]*?\n\}/)[0]
  const start = source.indexOf("let acknowledgedScanProblem = ''")
  const end = source.indexOf("$('quaso-problem-ack').onclick", start)
  const context = vm.createContext({
    healthChecked: true, health: { ok: true }, problems: [],
    safeName: String, clearPetTransientState() {},
    scanProblems: () => context.problems,
    scanProblemText: problems => problems.join('; '),
    updateAlert() {},
  })
  vm.runInContext(healthCode + '\n' + source.slice(start, end), context)
  return { context, run: code => vm.runInContext(code, context) }
}

test('scan warning can be acknowledged; repeated polling does not reopen it', () => {
  const { context, run } = problemHarness()
  context.problems = ['3 files unreadable']
  assert.equal(run('currentPetProblem().severity'), 'warning')
  assert.equal(run('currentPetProblem().system'), false)
  run('acknowledgePetProblem()')
  assert.equal(run('currentPetProblem()'), null)
  assert.equal(run('currentPetProblem()'), null)
  context.problems = ['4 files unreadable']
  assert.equal(run('currentPetProblem().severity'), 'warning')
  run('acknowledgePetProblem()')
  context.problems = []
  assert.equal(run('currentPetProblem()'), null)
  context.problems = ['4 files unreadable']
  assert.equal(run('currentPetProblem().severity'), 'warning')
})

test('operation warning and error can both be acknowledged', () => {
  const { run } = problemHarness()
  for (const severity of ['warning', 'error']) {
    run(`reportOperationProblem('Undo failed', '${severity}')`)
    assert.equal(run('currentPetProblem().severity'), severity)
    run('acknowledgePetProblem()')
    assert.equal(run('currentPetProblem()'), null)
  }
})

test('system errors cannot be dismissed and take priority over operation errors', () => {
  const { context, run } = problemHarness()
  run("reportOperationProblem('Undo failed')")
  for (const health of [null, { ok: false }, { db: { ok: false } }, { watcher: { rootsMissing: 1 } }]) {
    context.health = health
    assert.equal(run('currentPetProblem().system'), true)
    assert.equal(run('currentPetProblem().severity'), 'error')
    run('acknowledgePetProblem()')
    assert.equal(run('currentPetProblem().system'), true)
  }
  context.health = { ok: true }
  assert.equal(run('currentPetProblem().type'), 'operation')
  run('acknowledgePetProblem()')
  assert.equal(run('currentPetProblem()'), null)
})

test('warning message is distinct from error message', () => {
  assert.equal(getPetMessage('worried', { errorSeverity: 'warning', errorMessage: '3 files unreadable' }), 'Warning: 3 files unreadable')
  assert.equal(getPetMessage('worried', { errorSeverity: 'error', errorMessage: 'Undo failed' }), 'Something is not right: Undo failed')
})
