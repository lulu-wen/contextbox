import './helpers/isolate-home.mjs'   // 一定要第一個 import
/**
 * 面板裡改設定（2026-09-20）。
 *
 * 使用者的話：「我們要讓 client 可以在 panel 裡面輸入 config 的相關參數，像是 read only 或是 model 等等」。
 * 期望值抄自 `~/contextbox-預想-20260920-設定面板.md` 那張表，**先寫測試再實作**，
 * 這一檔守的是面板那一側（後端那一側在別的檔）：
 *
 * | 段落 | 認定的答案（面板這一側） |
 * |---|---|
 * | 存到一半的壞值 | 400 → 那一句話貼在**出問題的那一欄旁邊**，使用者打的字一個都不動 |
 * | 沒改到的欄位 | **只送改過的那幾欄**。整份送出去的話，另一個面板剛改好的欄位會被舊值蓋回去 |
 * | GET 設定 | 只有 `keyEnv` 的名字與 `keySet`。**金鑰本身永遠不上畫面** |
 * | `keyEnv` 被填成金鑰本人 | 不回顯。錯誤訊息只說「要的是環境變數的名字」 |
 * | 唯讀模式下能不能改設定 | 可以 —— 關不掉的開關是陷阱 |
 * | 改完生不生效 | 逐欄講實話（`restartNeeded`），不一律說「已生效」 |
 * | 可以改哪些欄位 | 白名單五欄。路徑類（watch／filed／roots）這一版只顯示不給改 |
 * | 路徑要不要給 UI 看 | 要，縮成 `~/…`，而且講得出是在哪個檔裡改 |
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountPanel, typeInto, toggle } from './helpers/panel-dom.mjs'
import { hideKeys, envVarName, settingsSaveMessage } from '../core/assets/cleanup-real-state.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
/** 按 D 的示範清單走頁面的 fetch（不是 window.api），給它真的那一份。 */
const demoFetch = async url => String(url).includes('demo-candidates.json')
  ? new Response(readFileSync(join(REPO, 'core/assets/demo-candidates.json')), { status: 200 })
  : new Response('not found', { status: 404 })

/** 這一檔到處在用的那把「假金鑰」。它一個字元都不可以出現在 DOM 裡。 */
const FAKE_KEY = 'sk-live-9f3aQxR7ZtLm42PdV8bKcY6w'

const candidate = (over = {}) => ({
  itemId: 'it-1', name: '很久沒動.zip', bytes: 2048, confidence: 80, folder: 'Downloads',
  reasons: [{ reason: '90 天沒有打開過', evidence: 'mtime' }], candidateIds: ['c-1'], ...over,
})

/** 後端 `GET /settings` 的回應（契約那一份）。每次都給一份新的，測試之間不會互相汙染。 */
const SETTINGS = (over = {}) => ({
  path: '~/.contextbox/config.json',
  editable: {
    readonly: false,
    model: { baseUrl: 'http://127.0.0.1:8000/v1', name: 'Qwen3-VL-8B', keyEnv: 'CONTEXTBOX_MODEL_KEY' },
    cleanup: { screenshots: false },
  },
  keySet: true,
  shown: {
    watch: ['~/Pictures/Screenshots', '~/Downloads'],
    filed: '~/Documents/Filed',
    cleanupRoots: ['~/Downloads'],
    quarantine: '~/.contextbox/quarantine',
    pdfPages: 3,
    maxBytes: 20 * 1024 * 1024,
  },
  problems: [],
  live: ['readonly', 'model.baseUrl', 'model.name', 'model.keyEnv'],
  restart: ['cleanup.screenshots'],
  ...over,
})

/** ui.html 的 api() 在錯誤上掛的東西：status、code、以及整包回應本體（data）。 */
function fail({ status = 400, code = 'BAD_SETTING', error = 'Bad setting.', fields = null }) {
  const e = new Error(error)
  e.status = status
  e.code = code
  e.data = fields ? { error, code, fields } : { error, code }
  throw e
}

/** 假後端照 patch 改一份新的設定回去（跟真的一樣：只動 patch 的鍵）。 */
const applyPatch = (base, patch) => ({
  ...base,
  editable: {
    readonly: 'readonly' in patch ? patch.readonly : base.editable.readonly,
    model: { ...base.editable.model, ...(patch.model ?? {}) },
    cleanup: { ...base.editable.cleanup, ...(patch.cleanup ?? {}) },
  },
})

function fakeApi(opts) {
  opts.calls ??= []
  opts.settings ??= SETTINGS()
  return async (path, init = {}) => {
    const method = init?.method ?? 'GET'
    opts.calls.push({ path, method, body: init?.body ?? null })
    const candidates = opts.candidates ?? []
    if (path === '/health') {
      return {
        ok: true, version: 'test', pendingCandidates: candidates.length, needsHumanCount: 0,
        watcher: { ok: true, watching: ['Downloads'], watchingCount: 1, rootsMissing: 0, why: null },
        scanProblems: [],
      }
    }
    if (path === '/pet/state') return { state: 'idle', message: '', burst: { groups: 0, newGroups: 0 } }
    if (path.startsWith('/cleanup/candidates')) {
      return { candidates, needsHuman: [], total: candidates.length, needsHumanTotal: 0 }
    }
    if (path.startsWith('/cleanup/plans?')) return { total: 0, offset: 0, limit: 20, operations: [] }
    if (path === '/cleanup/bursts') return { groups: [] }
    if (path.startsWith('/rename/suggestions')) return { items: opts.renames ?? [] }
    if (path.startsWith('/file/suggestions')) return { items: [] }
    if (path.startsWith('/learned')) return { items: [], evicted: { count: 0, at: null } }
    if (path === '/settings' && method === 'GET') {
      if (opts.getError) fail(opts.getError)
      return opts.settings
    }
    if (path === '/settings' && method === 'PATCH') {
      if (opts.hold) await opts.hold
      if (opts.patchError) fail(opts.patchError)
      opts.settings = applyPatch(opts.settings, JSON.parse(init.body))
      return { saved: true, settings: opts.settings, restartNeeded: opts.restartNeeded ?? [] }
    }
    const e = new Error('假後端不認得 ' + path)
    e.status = 404
    throw e
  }
}

async function open(t, opts = {}) {
  const ui = await mountPanel(t, { api: fakeApi(opts), fetch: demoFetch })
  await ui.click('quaso-cleanup-alert')
  return ui
}

async function selectSection(ui, label) {
  const select = ui.$('cleanup-tabs')
  const option = tabNamed(ui, label)
  assert.ok(option && !option.disabled, `Section unavailable: ${label}`)
  select.value = option.value
  await select.onchange()
}
const tabs = ui => ui.$('cleanup-tabs').all('OPTION')
const tabNamed = (ui, text) => tabs(ui).find(b => b.textContent.startsWith(text))

async function openSettings(t, opts = {}) {
  const ui = await open(t, opts)
  await selectSection(ui, 'Settings')
  return ui
}

const box = ui => ui.$('cleanup-settings')
const field = (ui, name) => box(ui).all('INPUT').find(i => i.dataset.field === name)
const fieldError = (ui, name) => box(ui).byClass('cleanup-field-error').find(p => p.dataset.field === name)
const patches = opts => opts.calls.filter(c => c.path === '/settings' && c.method === 'PATCH')

// ═══ 純函式 ═══════════════════════════════════════════════════

describe('不回顯金鑰的那幾條規則', () => {
  test('hideKeys：有金鑰前綴的一長串換成 [hidden]，正常的句子一個字都不動', () => {
    assert.equal(hideKeys('you wrote ' + FAKE_KEY), 'you wrote [hidden]')
    assert.equal(hideKeys('hf_QwErTy0123456789abcdefGH'), '[hidden]')
    assert.equal(hideKeys('CONTEXTBOX_MODEL_KEY is empty'), 'CONTEXTBOX_MODEL_KEY is empty')
    assert.equal(hideKeys('~/Documents/Filed'), '~/Documents/Filed')
  })

  test('hideKeys：32 個字元以上、大小寫混用又帶數字的一整串也換掉（沒有前綴的那種）', () => {
    assert.equal(hideKeys('AbC123defGHI456jklMNO789pqrSTU012vwx'), '[hidden]')
    // 人取的名字不長這樣：全大寫、或沒有數字的長字串照樣留著
    assert.equal(hideKeys('CONTEXTBOX_MODEL_KEY_FOR_THE_SPARK_BOX'), 'CONTEXTBOX_MODEL_KEY_FOR_THE_SPARK_BOX')
  })

  test('envVarName：是變數名字才回，其他一律 null（那一格就空著）', () => {
    assert.equal(envVarName('CONTEXTBOX_MODEL_KEY'), 'CONTEXTBOX_MODEL_KEY')
    assert.equal(envVarName('  CONTEXTBOX_MODEL_KEY  '), 'CONTEXTBOX_MODEL_KEY')
    assert.equal(envVarName(FAKE_KEY), null)
    assert.equal(envVarName('hf_QwErTy0123456789abcdefGH'), null)
    assert.equal(envVarName(''), null)
    assert.equal(envVarName(null), null)
  })

  test('settingsSaveMessage：逐欄講實話，不一律說「已生效」', () => {
    assert.equal(settingsSaveMessage(['readonly']), 'Saved: read-only mode. It is in effect now.')
    assert.match(settingsSaveMessage(['cleanup.screenshots'], ['cleanup.screenshots']),
      /Restart the pet before including screenshots in cleanup takes effect/)
    // 畫面上永遠不出現設定檔的欄位路徑：使用者沒看過那個檔
    assert.ok(!/cleanup\.screenshots/.test(settingsSaveMessage(['cleanup.screenshots'], ['cleanup.screenshots'])))
  })
})

// ═══ 標籤 ═════════════════════════════════════════════════════

describe('「設定」那個標籤', () => {
  test('永遠在、永遠點得下去 —— 什麼都沒有的時候更要進得去', async t => {
    const ui = await open(t)   // 一個候選、一條建議都沒有
    const tab = tabNamed(ui, 'Settings')
    assert.ok(tab, '這一區不是清單，不可以因為「沒有東西」就不見')
    assert.equal(tab.disabled, false)
    assert.equal(tab.textContent, 'Settings', '沒有數字 —— 「Settings0」看起來像設定被清空了')
  })

  test('點下去只顯示設定那一區', async t => {
    const ui = await openSettings(t, { candidates: [candidate()] })
    assert.equal(ui.$('cleanup-sec-settings').hidden, false)
    assert.equal(ui.$('cleanup-sec-clean').hidden, true)
    assert.equal(ui.$('cleanup-tabs').value, tabNamed(ui, 'Settings').value)
  })

  test('全部都空的時候不會被彈到設定頁（要留在「可以清理」聽它說沒事）', async t => {
    const ui = await open(t)
    assert.equal(ui.$('cleanup-tabs').value, tabNamed(ui, 'Cleanup').value)
    assert.equal(ui.$('cleanup-sec-clean').hidden, false)
  })

  test('「儲存設定」跟著區塊走：換到別的標籤就收起來（SECTION_BUTTONS）', async t => {
    const ui = await openSettings(t, { candidates: [candidate()] })
    assert.equal(ui.$('cleanup-settings-save').hidden, false)
    assert.equal(ui.$('cleanup-apply').hidden, true, '清理那顆不屬於設定這一區')
    await selectSection(ui, 'Cleanup')
    assert.equal(ui.$('cleanup-settings-save').hidden, true)
    assert.equal(ui.$('cleanup-apply').hidden, false)
  })

  test('示範模式這一區一個字都不畫（示範不會改到自己的設定檔）', async t => {
    const ui = await open(t, { candidates: [candidate()] })
    await ui.key('d')
    await ui.click('quaso-cleanup-alert')
    assert.equal(box(ui).textContent, '')
    assert.equal(ui.$('cleanup-settings-save').hidden, true)
  })
})

// ═══ 表單 ═════════════════════════════════════════════════════

describe('表單從 GET /settings 填起來', () => {
  test('五個可改的欄位都照後端說的填，不是寫死的預設', async t => {
    const ui = await openSettings(t)
    assert.equal(field(ui, 'readonly').checked, false)
    assert.equal(field(ui, 'model.baseUrl').value, 'http://127.0.0.1:8000/v1')
    assert.equal(field(ui, 'model.name').value, 'Qwen3-VL-8B')
    assert.equal(field(ui, 'model.keyEnv').value, 'CONTEXTBOX_MODEL_KEY')
    assert.equal(field(ui, 'cleanup.screenshots').checked, false)
  })

  test('唯讀本來就開著的話，那一格是勾起來的', async t => {
    const ui = await openSettings(t, { settings: SETTINGS({
      editable: {
        readonly: true,
        model: { baseUrl: '', name: '', keyEnv: 'CONTEXTBOX_MODEL_KEY' },
        cleanup: { screenshots: true },
      },
    }) })
    assert.equal(field(ui, 'readonly').checked, true)
    assert.equal(field(ui, 'cleanup.screenshots').checked, true)
    assert.equal(field(ui, 'model.baseUrl').value, '')
  })

  test('唯讀那一格講的是**它會做什麼**，不是設定檔裡那個鍵叫什麼', async t => {
    const ui = await openSettings(t)
    const text = box(ui).textContent
    assert.match(text, /Read-only — ContextBox looks and suggests but never moves a file/)
    assert.ok(!/\breadonly\b/.test(text), '畫面上不要出現欄位名：' + text)
  })

  test('改端點的警告在**按儲存之前**就看得到', async t => {
    // 這一欄一改就是「把我的檔案送去另一台主機」。等按下去才講就太晚了
    const ui = await openSettings(t)
    assert.match(box(ui).textContent, /the contents of your files get sent to/)
  })

  test('路徑那幾個只顯示、不給改，而且講得出是在哪個檔裡改', async t => {
    const ui = await openSettings(t)
    const text = box(ui).textContent
    assert.match(text, /~\/Pictures\/Screenshots/)
    assert.match(text, /~\/Documents\/Filed/)
    assert.match(text, /~\/\.contextbox\/quarantine/)
    assert.match(text, /edited in the config file itself: ~\/\.contextbox\/config\.json/)
    for (const name of ['watch', 'filed', 'cleanup.roots', 'quarantine', 'pdfPages', 'maxBytes']) {
      assert.equal(field(ui, name), undefined, `${name} 這一版不給改`)
    }
  })

  test('設定檔本來就有的毛病照實講出來（normalize 說了什麼就說什麼）', async t => {
    const ui = await openSettings(t, { settings: SETTINGS({
      problems: ['filed must be an absolute path; using ~/Documents/Filed instead.'],
    }) })
    assert.match(box(ui).textContent, /filed must be an absolute path/)
  })

  test('舊版後端沒有這條路由 → 講一句話，面板照常打得開，也不給按儲存', async t => {
    const ui = await openSettings(t, { getError: { status: 404, error: 'Not found' } })
    assert.match(box(ui).textContent, /older build/)
    assert.equal(ui.$('cleanup-settings-save').hidden, true, '存不了就不要給按')
  })
})

// ═══ 金鑰 ═════════════════════════════════════════════════════

describe('金鑰一個字元都不上畫面', () => {
  test('keySet 真：講「在哪個變數裡找到了」', async t => {
    const ui = await openSettings(t)
    assert.match(box(ui).textContent, /Key found in CONTEXTBOX_MODEL_KEY/)
  })

  test('keySet 假：講「那個變數是空的」', async t => {
    const ui = await openSettings(t, { settings: SETTINGS({ keySet: false }) })
    assert.match(box(ui).textContent, /CONTEXTBOX_MODEL_KEY is empty/)
    assert.ok(!/Key found in/.test(box(ui).textContent))
  })

  test('那一欄講清楚要的是**變數的名字**，不是金鑰', async t => {
    const ui = await openSettings(t)
    assert.match(box(ui).textContent, /NAME of an environment variable/)
    assert.match(box(ui).textContent, /never type or paste a key into this box/)
  })

  test('後端硬塞金鑰也上不了畫面：keyEnv 是金鑰、外加一個 key 欄位、problems 裡也有一份', async t => {
    // 2026-09-20 早上 doctor 真的把使用者貼進 keyEnv 的金鑰印出來了。
    // 面板不靠「後端不該回」過日子：回了也畫不出來。
    const ui = await openSettings(t, { settings: SETTINGS({
      editable: {
        readonly: false,
        model: { baseUrl: 'http://127.0.0.1:8000/v1', name: 'Qwen3-VL-8B', keyEnv: FAKE_KEY },
        cleanup: { screenshots: false },
      },
      key: FAKE_KEY,
      modelKey: FAKE_KEY,
      problems: ['model.keyEnv looks like a key: ' + FAKE_KEY],
    }) })
    const everything = box(ui).textContent
      + box(ui).all('INPUT').map(i => String(i.value)).join(' ')
    assert.ok(!everything.includes(FAKE_KEY), everything)
    assert.equal(field(ui, 'model.keyEnv').value, '', '不像變數名字的東西一個字都不回顯')
    assert.match(everything, /\[hidden\]/, '被擋下來這件事要看得出來，不是靜靜地不見')
  })
})

// ═══ 儲存 ═════════════════════════════════════════════════════

describe('按「儲存」', () => {
  test('只送改過的那幾欄 —— 沒碰的鍵一個都不送', async t => {
    const opts = {}
    const ui = await openSettings(t, opts)
    typeInto(field(ui, 'model.name'), 'Qwen3.5-27B')
    await ui.click('cleanup-settings-save')
    assert.equal(patches(opts).length, 1)
    assert.deepEqual(JSON.parse(patches(opts)[0].body), { model: { name: 'Qwen3.5-27B' } },
      '整份送出去的話，另一個面板剛改好的欄位會被這一份的舊值蓋回去')
  })

  test('改了兩欄就送兩欄，各自在自己的位置上', async t => {
    const opts = {}
    const ui = await openSettings(t, opts)
    toggle(field(ui, 'readonly'), true)
    typeInto(field(ui, 'model.baseUrl'), 'https://spark.example/v1')
    await ui.click('cleanup-settings-save')
    assert.deepEqual(JSON.parse(patches(opts)[0].body),
      { readonly: true, model: { baseUrl: 'https://spark.example/v1' } })
  })

  test('什麼都沒改就按 → 一個 PATCH 都不送，而且照實講', async t => {
    const opts = {}
    const ui = await openSettings(t, opts)
    await ui.click('cleanup-settings-save')
    assert.deepEqual(patches(opts), [])
    assert.match(box(ui).textContent, /Nothing to save/)
  })

  test('存成功之後畫面就是檔案裡那一份：再按一次不會重送', async t => {
    const opts = {}
    const ui = await openSettings(t, opts)
    typeInto(field(ui, 'model.name'), 'Qwen3.5-27B')
    await ui.click('cleanup-settings-save')
    assert.equal(field(ui, 'model.name').value, 'Qwen3.5-27B')
    await ui.click('cleanup-settings-save')
    assert.equal(patches(opts).length, 1, '存完那一份就是新的基準，不可以再送一次')
  })

  test('存完逐欄講實話：要重開寵物才算數的欄位講出來', async t => {
    const opts = { restartNeeded: ['cleanup.screenshots'] }
    const ui = await openSettings(t, opts)
    toggle(field(ui, 'cleanup.screenshots'), true)
    await ui.click('cleanup-settings-save')
    const text = box(ui).textContent
    assert.match(text, /Saved: including screenshots in cleanup\./)
    assert.match(text, /Restart the pet before including screenshots in cleanup takes effect/)
    assert.ok(!/cleanup\.screenshots/.test(text), '畫面上不要出現設定檔的欄位路徑：' + text)
  })

  test('立刻生效的欄位就說立刻生效，不要叫人白重開一次', async t => {
    const opts = { restartNeeded: [] }
    const ui = await openSettings(t, opts)
    toggle(field(ui, 'readonly'), true)
    await ui.click('cleanup-settings-save')
    assert.match(box(ui).textContent, /Saved: read-only mode\. It is in effect now\./)
    assert.ok(!/Restart the pet/.test(box(ui).textContent))
  })

  test('唯讀開著也存得下去 —— 關不掉的開關是陷阱', async t => {
    const opts = { settings: SETTINGS({
      editable: {
        readonly: true,
        model: { baseUrl: 'http://127.0.0.1:8000/v1', name: 'Qwen3-VL-8B', keyEnv: 'CONTEXTBOX_MODEL_KEY' },
        cleanup: { screenshots: false },
      },
    }) }
    const ui = await openSettings(t, opts)
    toggle(field(ui, 'readonly'), false)
    await ui.click('cleanup-settings-save')
    assert.deepEqual(JSON.parse(patches(opts)[0].body), { readonly: false })
    assert.equal(field(ui, 'readonly').checked, false)
  })

  test('送出去的那段時間按不下去 —— 連按兩下就是送兩次寫檔', async t => {
    let release
    const opts = { hold: new Promise(r => { release = r }) }
    const ui = await openSettings(t, opts)
    typeInto(field(ui, 'model.name'), 'Qwen3.5-27B')
    const saving = ui.$('cleanup-settings-save').onclick()
    assert.equal(ui.$('cleanup-settings-save').disabled, true)
    assert.match(ui.$('cleanup-settings-save').textContent, /Saving/)
    release()
    await saving
    await ui.idle()
    assert.equal(ui.$('cleanup-settings-save').disabled, false)
    assert.equal(patches(opts).length, 1)
  })
})

// ═══ 被退回來 ═════════════════════════════════════════════════

describe('後端說這一欄不行（400 BAD_SETTING）', () => {
  const publicEndpoint = () => ({
    status: 400, code: 'BAD_SETTING',
    error: 'That endpoint would send your files somewhere else. Nothing was written.',
    fields: { 'model.baseUrl': 'http://8.8.8.8/v1 is a public address, and it is plain http on top of that.' },
  })

  test('那一句話貼在**出問題的那一欄旁邊**，不是整頁最下面', async t => {
    const ui = await openSettings(t, { patchError: publicEndpoint() })
    typeInto(field(ui, 'model.baseUrl'), 'http://8.8.8.8/v1')
    await ui.click('cleanup-settings-save')
    const err = fieldError(ui, 'model.baseUrl')
    assert.ok(err, '整頁一句「存不起來」的話，使用者不知道是哪一格打錯')
    assert.match(err.textContent, /public address/)
  })

  test('**使用者打的字還在**：打了一長串網址被清空，就不會有人想再試第二次', async t => {
    const ui = await openSettings(t, { patchError: publicEndpoint() })
    typeInto(field(ui, 'model.baseUrl'), 'http://8.8.8.8/v1')
    await ui.click('cleanup-settings-save')
    assert.equal(field(ui, 'model.baseUrl').value, 'http://8.8.8.8/v1')
  })

  test('沒出問題的那幾欄不要跟著紅', async t => {
    const ui = await openSettings(t, { patchError: publicEndpoint() })
    typeInto(field(ui, 'model.baseUrl'), 'http://8.8.8.8/v1')
    typeInto(field(ui, 'model.name'), 'Qwen3.5-27B')
    await ui.click('cleanup-settings-save')
    assert.equal(fieldError(ui, 'model.name'), undefined)
    assert.equal(field(ui, 'model.name').value, 'Qwen3.5-27B', '這一欄的字也要留著')
  })

  test('再改一次存成功 → 上一次的紅字要消失', async t => {
    const opts = { patchError: publicEndpoint() }
    const ui = await openSettings(t, opts)
    typeInto(field(ui, 'model.baseUrl'), 'http://8.8.8.8/v1')
    await ui.click('cleanup-settings-save')
    assert.ok(fieldError(ui, 'model.baseUrl'))
    opts.patchError = null
    typeInto(field(ui, 'model.baseUrl'), 'http://127.0.0.1:9000/v1')
    await ui.click('cleanup-settings-save')
    assert.equal(fieldError(ui, 'model.baseUrl'), undefined, '修好了還掛著紅字會讓人以為又失敗了')
  })

  test('使用者自己把金鑰貼進 keyEnv：退回來之後那一格換回存著的名字', async t => {
    // 這是唯一一個「使用者打的字不留」的例外 —— 留著就等於把金鑰留在畫面上（今天早上那件事）。
    // 2026-09-20 稽核 verify:contract-8 把「清空」改成「回填存著的那個名字」：
    // 清空會讓 patch() 以為使用者改了這一欄，下一次儲存就把他的變數名洗掉。
    const ui = await openSettings(t, { patchError: {
      status: 400, code: 'BAD_SETTING',
      error: 'That field wants the name of an environment variable. Nothing was written.',
      fields: { 'model.keyEnv': 'model.keyEnv must be the NAME of an environment variable (something starting with CONTEXTBOX_), not the key itself.' },
    } })
    typeInto(field(ui, 'model.keyEnv'), FAKE_KEY)
    await ui.click('cleanup-settings-save')
    assert.equal(field(ui, 'model.keyEnv').value, 'CONTEXTBOX_MODEL_KEY')
    assert.match(fieldError(ui, 'model.keyEnv').textContent, /NAME of an environment variable/)
    assert.ok(!box(ui).textContent.includes(FAKE_KEY), box(ui).textContent)
  })

  test('後端在錯誤訊息裡回了一把金鑰 → 換成 [hidden]，不原樣搬上畫面', async t => {
    const ui = await openSettings(t, { patchError: {
      status: 400, code: 'BAD_SETTING',
      error: 'Bad setting. Nothing was written.',
      fields: { 'model.keyEnv': 'you wrote ' + FAKE_KEY + ', which is a key' },
    } })
    typeInto(field(ui, 'model.keyEnv'), FAKE_KEY)
    await ui.click('cleanup-settings-save')
    assert.ok(!box(ui).textContent.includes(FAKE_KEY), box(ui).textContent)
    assert.match(fieldError(ui, 'model.keyEnv').textContent, /\[hidden\]/)
  })

  test('白名單以外的鍵被退回來（後端拒絕、不安靜忽略）→ 照實講，檔案沒動', async t => {
    const ui = await openSettings(t, { patchError: {
      status: 400, code: 'BAD_SETTING',
      error: 'cleanup.roots cannot be changed from the panel. Nothing was written.',
    } })
    typeInto(field(ui, 'model.name'), 'Qwen3.5-27B')
    await ui.click('cleanup-settings-save')
    assert.match(box(ui).textContent, /Nothing was written/)
  })

  test('寫檔失敗（500 WRITE_FAILED）→ 照實講，不要假裝存好了', async t => {
    const ui = await openSettings(t, { patchError: {
      status: 500, code: 'WRITE_FAILED',
      error: 'Could not write your config file. Nothing was changed.',
    } })
    typeInto(field(ui, 'model.name'), 'Qwen3.5-27B')
    await ui.click('cleanup-settings-save')
    assert.match(box(ui).textContent, /Could not write your config file/)
    assert.ok(!/Saved:/.test(box(ui).textContent))
    assert.equal(field(ui, 'model.name').value, 'Qwen3.5-27B')
  })
})

// ═══ 稽核 ・ 400 之後那一格被清空，下一次存把使用者的變數名洗掉 ═══

describe('稽核 verify:contract-8 ・ 被退回來之後，keyEnv 不可以變成「使用者改過」（2026-09-20）', () => {
  /**
   * 400 之後把 keyEnv 那一格清空，是為了「不要把貼進去的金鑰留在畫面上」。
   * 問題是清空之後 `edited` 跟 `data` 就不一樣了 —— `patch()` 是拿這兩份比出來的，
   * 於是**下一次按儲存會夾帶 `keyEnv: ""`**，而後端收得下空字串（會退回預設）。
   * 結果：使用者的 `CONTEXTBOX_OTHER_KEY` 從設定檔裡消失、keySet 變成 false，
   * 而面板還說「已儲存：模型名稱、金鑰環境變數。已生效」—— 一個他從來沒改過的欄位。
   */
  const pastedKey = () => ({
    status: 400, code: 'BAD_SETTING',
    error: 'That field wants the name of an environment variable. Nothing was written.',
    fields: { 'model.keyEnv': 'model.keyEnv must be the NAME of an environment variable (something starting with CONTEXTBOX_), not the key itself.' },
  })

  test('貼了金鑰被退回來 → 那一格回到**檔案裡存著的名字**，不是空白', async t => {
    const ui = await openSettings(t, {
      patchError: pastedKey(),
      settings: SETTINGS({ editable: {
        readonly: false,
        model: { baseUrl: 'http://127.0.0.1:8000/v1', name: 'Qwen3-VL-8B', keyEnv: 'CONTEXTBOX_OTHER_KEY' },
        cleanup: { screenshots: false },
      } }),
    })
    typeInto(field(ui, 'model.keyEnv'), FAKE_KEY)
    await ui.click('cleanup-settings-save')
    assert.equal(field(ui, 'model.keyEnv').value, 'CONTEXTBOX_OTHER_KEY',
      '清空等於替使用者做了一個他沒做的修改；回填存著的那個名字一樣把金鑰趕下畫面')
    assert.ok(!box(ui).textContent.includes(FAKE_KEY), box(ui).textContent)
  })

  test('退回來之後改別欄再存：patch 裡**完全沒有** keyEnv，檔案裡那個名字原封不動', async t => {
    const opts = {
      patchError: pastedKey(),
      settings: SETTINGS({ editable: {
        readonly: false,
        model: { baseUrl: 'http://127.0.0.1:8000/v1', name: 'Qwen3-VL-8B', keyEnv: 'CONTEXTBOX_OTHER_KEY' },
        cleanup: { screenshots: false },
      } }),
    }
    const ui = await openSettings(t, opts)
    typeInto(field(ui, 'model.keyEnv'), FAKE_KEY)
    await ui.click('cleanup-settings-save')

    // 使用者放棄那一格，改一欄不相干的再存一次
    opts.patchError = null
    typeInto(field(ui, 'model.name'), 'Qwen3.5-27B')
    await ui.click('cleanup-settings-save')

    const sent = JSON.parse(patches(opts).at(-1).body)
    assert.deepEqual(sent, { model: { name: 'Qwen3.5-27B' } }, '夾帶了使用者沒改的欄位')
    assert.equal(opts.settings.editable.model.keyEnv, 'CONTEXTBOX_OTHER_KEY',
      '使用者的環境變數名字被洗掉了，而他從頭到尾沒碰那一欄')
    assert.equal(box(ui).byClass('cleanup-setting-result').at(-1).textContent,
      'Saved: model name. It is in effect now.', '存好的那句話不可以把沒改的欄位算進去')
  })

  test('keyEnv 打成不是變數名的字、而 400 講的是別欄：那一格也回到存著的名字', async t => {
    const opts = { patchError: {
      status: 400, code: 'BAD_SETTING',
      error: 'Bad setting. Nothing was written.',
      fields: { 'model.baseUrl': 'That address is not safe to send your files to.' },
    } }
    const ui = await openSettings(t, opts)
    typeInto(field(ui, 'model.baseUrl'), 'http://8.8.8.8/v1')
    typeInto(field(ui, 'model.keyEnv'), 'contextbox model key')
    await ui.click('cleanup-settings-save')
    assert.equal(field(ui, 'model.keyEnv').value, 'CONTEXTBOX_MODEL_KEY')

    opts.patchError = null
    await ui.click('cleanup-settings-save')
    const sent = JSON.parse(patches(opts).at(-1).body)
    assert.ok(!('keyEnv' in (sent.model ?? {})), '打錯字被收掉之後不可以變成一筆「修改」：' + JSON.stringify(sent))
  })
})

// ═══ 稽核 ・ 背景輪詢不可以把正在打字的那一格抽掉 ═════════════

describe('稽核 ・ 五秒一次的輪詢重畫，設定區要讓開（2026-09-20）', () => {
  /**
   * `refreshSuggestions()`（五秒一輪）發現連拍／改名／歸檔／學到的那四區變了就叫 `render()`，
   * 而 `render()` 一路叫到 `renderSettings()`，那一支開頭就是 `box.replaceChildren()` ——
   * 使用者正在打的那個輸入框整個被換成一個新的。
   *
   * 字本身不會不見（重畫是從 `edited` 出來的，oninput 每一鍵都寫進去了），
   * 掉的是**焦點、游標位置、選取範圍、以及注音打到一半還沒上屏的字**：
   * 一個正在慢慢敲 `http://127.0.0.1:8000/v1` 的人，每五秒就被踢出輸入框一次。
   */
  const suggestion = () => [{
    itemId: 'it-1', name: '未命名文件 (3).txt', suggested: '作業系統_死結.txt',
    folder: 'Downloads', confidence: 'high', evidence: '文件裡寫著「作業系統 第 6 章 死結」',
  }]

  test('別區有新東西而輪詢重畫時，正在打字的那一格不可以被換掉', async t => {
    const opts = {}
    const ui = await openSettings(t, opts)
    const input = field(ui, 'model.baseUrl')
    typeInto(input, 'http://127.0.0.1:80')
    input.focus()
    assert.equal(ui.doc.activeElement, input, '前提：游標在這一格裡')

    // 背景那一輪問完模型，「建議的名字」多了一筆 —— 這正是 refreshSuggestions 重畫的理由
    opts.renames = suggestion()
    await ui.poll()

    assert.equal(field(ui, 'model.baseUrl'), input, '正在打字的輸入框被整個換掉了（游標會跳走）')
    assert.equal(ui.doc.activeElement, input, '焦點掉了')
    assert.equal(input.value, 'http://127.0.0.1:80')
    // 讓開的只有設定那一區，別區照樣跟上
    assert.match(ui.$('cleanup-renames').textContent, /作業系統_死結/)
  })

  test('游標不在設定區裡的時候照常重畫 —— 不然存好那句話貼不上去', async t => {
    const opts = {}
    const ui = await openSettings(t, opts)
    typeInto(field(ui, 'model.name'), 'Qwen3.5-27B')
    ui.doc.body.focus()
    opts.renames = suggestion()
    await ui.poll()
    // 重畫過（元素換新了），而且打到一半的字還在（畫的是 edited）
    assert.equal(field(ui, 'model.name').value, 'Qwen3.5-27B')
    await ui.click('cleanup-settings-save')
    assert.match(box(ui).textContent, /Saved: model name/)
  })

  test('存檔那一刻照樣重畫（那時焦點在「儲存」按鈕上，不在框裡）', async t => {
    const opts = { patchError: {
      status: 400, code: 'BAD_SETTING',
      error: 'That address is not safe to send your files to. Nothing was written.',
      fields: { 'model.baseUrl': 'That address is not safe to send your files to.' },
    } }
    const ui = await openSettings(t, opts)
    const input = field(ui, 'model.baseUrl')
    typeInto(input, 'http://8.8.8.8/v1')
    input.focus()
    ui.$('cleanup-settings-save').focus()
    await ui.click('cleanup-settings-save')
    assert.ok(fieldError(ui, 'model.baseUrl'), '按下儲存之後那一句話一定要貼得上去')
  })
})
