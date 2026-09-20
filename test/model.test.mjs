import './helpers/isolate-home.mjs'   // 一定要第一行，見那支檔的說明
/**
 * 模型客戶端（core/model.ts）。**全部打假的本機伺服器，一次都不打真的模型。**
 *
 * 守住的幾件事：
 *   - 沒設定（沒 baseUrl／沒模型名字／沒金鑰）→ **一個請求都不發**
 *   - 真的送出去的東西：`response_format` 是 json_schema、模型名字對、authorization 帶得對
 *   - 回答的形狀**嚴格**：少一欄、多一欄、選項不對、不是 JSON —— 一律不採用
 *   - 逾時是逾時、取消是取消（兩條路分得開，取消不算模型失敗）
 *   - **錯誤訊息裡不可以有金鑰**
 *   - 圖片縮到長邊 ≤ 1344 的灰階 PNG；文字最多 2000 字
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { decodePngGray } from '../core/png.ts'
import { encodeGrayPng } from '../core/png-write.ts'
import {
  CONFIDENCES, IMAGE_MAX_SIDE, PROMPT_VERSION, TEXT_MAX_CHARS, VIEW_FIELDS, VIEW_KINDS,
  askModel, buildMessages, chatUrl, imagePayload, longEnough, modelEnabled, parseView,
  responseFormat, textPayload, whyDisabled,
} from '../core/model.ts'
import { GOOD_VIEW, completion, startFakeModel } from './helpers/fake-model.mjs'

const KEY_ENV = 'CONTEXTBOX_MODEL_KEY'
/** 測試用的假金鑰。**真的金鑰只在 ~/.contextbox/env，這裡永遠不碰。** */
const FAKE_KEY = 'fake-key-for-tests-0123456789'

/** 一份 Config（只有模型那一段有意義）。 */
const cfg = (baseUrl, name = 'fake-model') => ({
  watch: [], filed: '', readonly: false, pdfPages: 3, maxBytes: 1 << 20,
  cleanup: { roots: [], screenshots: false, screenshotsDir: null },
  model: { baseUrl, name, keyEnv: KEY_ENV },
})

/** 這一段測試期間把金鑰環境變數換掉，跑完放回去。 */
function withKey(t, value) {
  const before = process.env[KEY_ENV]
  if (value === null) delete process.env[KEY_ENV]
  else process.env[KEY_ENV] = value
  t.after(() => { if (before === undefined) delete process.env[KEY_ENV]; else process.env[KEY_ENV] = before })
}

// ═══ 開／不開 ═════════════════════════════════════════════════

describe('沒設定就完全不啟用', () => {
  test('三個都齊才算開', t => {
    withKey(t, FAKE_KEY)
    assert.equal(modelEnabled(cfg('http://127.0.0.1:1/v1')), true)
    assert.equal(modelEnabled(cfg('')), false, '沒有 baseUrl')
    assert.equal(modelEnabled(cfg('http://127.0.0.1:1/v1', '')), false, '沒有模型名字')
  })

  test('金鑰是空的也不算開', t => {
    withKey(t, '')
    assert.equal(modelEnabled(cfg('http://127.0.0.1:1/v1')), false)
    withKey(t, '   ')
    assert.equal(modelEnabled(cfg('http://127.0.0.1:1/v1')), false, '只有空白也是沒有')
  })

  test('沒開的時候講得出是哪一種沒開', t => {
    withKey(t, null)
    assert.match(whyDisabled(cfg('')), /no model configured/)
    assert.match(whyDisabled(cfg('http://127.0.0.1:1/v1')), new RegExp(KEY_ENV))
    withKey(t, FAKE_KEY)
    assert.equal(whyDisabled(cfg('http://127.0.0.1:1/v1')), null)
  })

  test('**沒設定就一個請求都不發**（假伺服器一次都沒被打到）', async t => {
    const fake = await startFakeModel(t)
    withKey(t, '')
    const r = await askModel(cfg(fake.baseUrl), { source: 'text', text: 'x'.repeat(100) })
    assert.equal(r.ok, false)
    assert.match(r.error, /not configured/)
    assert.deepEqual(fake.requests, [], '沒設定卻送出去了')
  })
})

// ═══ 回答的形狀 ═══════════════════════════════════════════════

describe('parseView：嚴格', () => {
  const good = { ...GOOD_VIEW }

  test('正常的一筆', () => {
    const v = parseView(JSON.stringify(good))
    assert.deepEqual(v, good)
    assert.deepEqual(Object.keys(v).sort(), [...VIEW_FIELDS].sort())
  })

  test('少一欄 → null（每一欄各試一次）', () => {
    for (const f of VIEW_FIELDS) {
      const o = { ...good }
      delete o[f]
      assert.equal(parseView(JSON.stringify(o)), null, `少了 ${f} 卻收下了`)
    }
  })

  test('多一欄 → null', () => {
    assert.equal(parseView(JSON.stringify({ ...good, extra: 'x' })), null)
    assert.equal(parseView(JSON.stringify({ ...good, course2: '作業系統' })), null)
  })

  test('欄位不是字串 → null', () => {
    for (const f of VIEW_FIELDS) {
      assert.equal(parseView(JSON.stringify({ ...good, [f]: 3 })), null, `${f} 是數字卻收下了`)
      assert.equal(parseView(JSON.stringify({ ...good, [f]: null })), null, `${f} 是 null 卻收下了`)
    }
  })

  test('kind 與 confidence 只收固定選項', () => {
    for (const k of VIEW_KINDS) assert.ok(parseView(JSON.stringify({ ...good, kind: k })), `${k} 應該收`)
    for (const c of CONFIDENCES) assert.ok(parseView(JSON.stringify({ ...good, confidence: c })), `${c} 應該收`)
    assert.equal(parseView(JSON.stringify({ ...good, kind: 'lecture' })), null)
    assert.equal(parseView(JSON.stringify({ ...good, kind: '' })), null)
    assert.equal(parseView(JSON.stringify({ ...good, confidence: '高' })), null)   // 舊資料庫裡的中文值
    assert.equal(parseView(JSON.stringify({ ...good, confidence: '中等' })), null)
  })

  test('不是 JSON、不是物件 → null', () => {
    for (const raw of ['', '不是 JSON', '[]', 'null', '3', '"字串"', '{', JSON.stringify([good])]) {
      assert.equal(parseView(raw), null, `${raw} 卻收下了`)
    }
    assert.equal(parseView(null), null)
    assert.equal(parseView(undefined), null)
    assert.equal(parseView([good]), null)
  })

  test('控制字元與方向字元換掉（模型抄的是使用者的檔，那是不可信的輸入）', () => {
    const NUL = String.fromCharCode(0), RLO = String.fromCharCode(0x202e)
    const v = parseView(JSON.stringify({ ...good, evidence: '看到' + RLO + '一行' + NUL + '字' }))
    assert.ok(!new RegExp('[' + NUL + RLO + ']').test(v.evidence), v.evidence)
  })

  test('建議的檔名不可以帶路徑分隔符（P3 拿它去改名）', () => {
    const v = parseView(JSON.stringify({ ...good, suggestedName: '../../etc/passwd' }))
    assert.ok(!v.suggestedName.includes('/'), v.suggestedName)
    assert.ok(!parseView(JSON.stringify({ ...good, suggestedName: 'a\\b' })).suggestedName.includes('\\'))
  })

  test('太長的欄位截斷（不是不採用）', () => {
    const v = parseView(JSON.stringify({ ...good, evidence: '字'.repeat(5000) }))
    assert.ok(v && v.evidence.length <= 300, String(v && v.evidence.length))
  })
})

describe('response_format 就是 json_schema', () => {
  test('形狀', () => {
    const f = responseFormat()
    assert.equal(f.type, 'json_schema')
    assert.equal(f.json_schema.strict, true)
    assert.deepEqual([...f.json_schema.schema.required].sort(), [...VIEW_FIELDS].sort())
    assert.equal(f.json_schema.schema.additionalProperties, false)
    assert.deepEqual(f.json_schema.schema.properties.kind.enum, [...VIEW_KINDS])
    assert.deepEqual(f.json_schema.schema.properties.confidence.enum, [...CONFIDENCES])
  })
})

// ═══ 要送出去的東西 ═══════════════════════════════════════════

describe('文字最多 2000 字、圖片長邊最多 1344', () => {
  test('textPayload 砍到 2000 個 code point', () => {
    assert.equal([...textPayload('字'.repeat(5000))].length, TEXT_MAX_CHARS)
    assert.equal(textPayload('短'), '短')
    // 不會切在代理對中間
    assert.equal([...textPayload('🙂'.repeat(3000))].length, TEXT_MAX_CHARS)
  })

  test('longEnough：30 個字以下不問', () => {
    assert.equal(longEnough('字'.repeat(29)), false)
    assert.equal(longEnough('字'.repeat(30)), true)
    assert.equal(longEnough('   ' + '字'.repeat(30) + '  '), true)
    assert.equal(longEnough(null), false)
  })

  test('imagePayload：大圖縮到長邊 1344，出來還是解得開的灰階 PNG', () => {
    const w = 2688, h = 1344
    const src = encodeGrayPng(w, h, new Uint8Array(w * h).fill(120))
    const out = imagePayload(src)
    assert.equal(out.width, IMAGE_MAX_SIDE)
    assert.equal(out.height, Math.round(h * IMAGE_MAX_SIDE / w))
    const back = decodePngGray(out.bytes)
    assert.equal(back.width, IMAGE_MAX_SIDE)
    assert.ok(out.bytes.length < src.length, '縮完要比原圖小')
  })

  test('imagePayload：已經夠小的也重新編一次（不夾帶原圖的中繼資料）', () => {
    const src = encodeGrayPng(10, 8, new Uint8Array(80).fill(9))
    const out = imagePayload(src)
    assert.deepEqual([out.width, out.height], [10, 8])
    assert.equal(decodePngGray(out.bytes).width, 10)
  })

  test('buildMessages：文字帶提示詞、圖片走 data:image/png;base64', () => {
    const t = buildMessages({ source: 'text', text: '作業系統 死結' })
    assert.equal(t[0].role, 'system')
    assert.match(JSON.stringify(t[1]), /作業系統 死結/)
    assert.match(JSON.stringify(t[1]), /suggestedName/)
    const i = buildMessages({ source: 'image', png: Buffer.from([1, 2, 3]) })
    assert.equal(i[1].content[0].type, 'image_url')
    assert.match(i[1].content[0].image_url.url, /^data:image\/png;base64,/)
  })

  test('chatUrl：baseUrl 尾巴的斜線不會變成兩條', () => {
    assert.equal(chatUrl('http://a/v1'), 'http://a/v1/chat/completions')
    assert.equal(chatUrl('http://a/v1/'), 'http://a/v1/chat/completions')
    assert.equal(chatUrl('http://a/v1///'), 'http://a/v1/chat/completions')
  })
})

// ═══ 真的送一次（打假的伺服器） ═══════════════════════════════

describe('askModel 打假的伺服器', () => {
  test('送出去的長什麼樣：POST /chat/completions、Bearer、json_schema、模型名字', async t => {
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    const r = await askModel(cfg(fake.baseUrl, 'fake-model'), { source: 'text', text: '作業系統 死結 ' + '字'.repeat(40) })
    assert.equal(r.ok, true, r.ok ? '' : r.error)
    assert.deepEqual(r.view, GOOD_VIEW)
    assert.equal(fake.requests.length, 1)
    const req = fake.requests[0]
    assert.equal(req.method, 'POST')
    assert.match(req.url, /\/chat\/completions$/)
    assert.equal(req.headers.authorization, `Bearer ${FAKE_KEY}`)
    assert.equal(req.json.model, 'fake-model')
    assert.equal(req.json.response_format.type, 'json_schema')
    assert.equal(req.json.stream, false)
    assert.match(req.raw, /作業系統 死結/)
  })

  test('圖片真的以 base64 送出去', async t => {
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    const png = encodeGrayPng(4, 4, new Uint8Array(16).fill(3))
    const r = await askModel(cfg(fake.baseUrl), { source: 'image', png })
    assert.equal(r.ok, true)
    assert.equal(r.bytesSent, png.length)
    assert.match(fake.requests[0].json.messages[1].content[0].image_url.url, /^data:image\/png;base64,/)
  })

  test('401／403 → 講金鑰；其他狀態碼 → 講狀態碼', async t => {
    let status = 401
    const fake = await startFakeModel(t, ({ send, req }) =>
      req.method === 'POST' ? (send(status, { error: 'nope' }), true) : false)
    withKey(t, FAKE_KEY)
    assert.match((await askModel(cfg(fake.baseUrl), { source: 'text', text: 'x' })).error, /key/)
    status = 503
    assert.match((await askModel(cfg(fake.baseUrl), { source: 'text', text: 'x' })).error, /503/)
  })

  test('回的不是 JSON → 不採用', async t => {
    const fake = await startFakeModel(t, ({ send, req }) =>
      req.method === 'POST' ? (send(200, '這不是 JSON', 'text/plain'), true) : false)
    withKey(t, FAKE_KEY)
    const r = await askModel(cfg(fake.baseUrl), { source: 'text', text: 'x' })
    assert.equal(r.ok, false)
    assert.match(r.error, /not answer with JSON/)
  })

  test('回的 JSON 形狀不對 → 不採用、講得出是格式問題', async t => {
    const bad = [
      { ...GOOD_VIEW, extra: 1 },
      (() => { const o = { ...GOOD_VIEW }; delete o.topic; return o })(),
      { ...GOOD_VIEW, confidence: 'very high' },
    ]
    let i = 0
    const fake = await startFakeModel(t, ({ send, req }) =>
      req.method === 'POST' ? (send(200, completion(bad[i++])), true) : false)
    withKey(t, FAKE_KEY)
    for (let k = 0; k < bad.length; k++) {
      const r = await askModel(cfg(fake.baseUrl), { source: 'text', text: 'x' })
      assert.equal(r.ok, false, `第 ${k} 種壞形狀被收下了`)
      assert.match(r.error, /wrong shape/)
    }
  })

  test('choices 是空的、content 不是字串 → 不採用', async t => {
    const bodies = [{ choices: [] }, { choices: [{ message: { content: 3 } }] }, {}]
    let i = 0
    const fake = await startFakeModel(t, ({ send, req }) =>
      req.method === 'POST' ? (send(200, bodies[i++]), true) : false)
    withKey(t, FAKE_KEY)
    for (let k = 0; k < bodies.length; k++) {
      assert.equal((await askModel(cfg(fake.baseUrl), { source: 'text', text: 'x' })).ok, false, `第 ${k} 種`)
    }
  })

  test('逾時：60 秒（測試調成 120 毫秒）—— 記一次失敗，不丟例外', async t => {
    const fake = await startFakeModel(t, ({ req }) => req.method === 'POST')   // 永遠不回
    withKey(t, FAKE_KEY)
    const r = await askModel(cfg(fake.baseUrl), { source: 'text', text: 'x' }, { timeoutMs: 120 })
    assert.equal(r.ok, false)
    assert.equal(r.aborted, false, '逾時不是取消')
    assert.match(r.error, /did not answer in/)
  })

  test('取消：aborted 為 true（那不算模型失敗）', async t => {
    const fake = await startFakeModel(t, ({ req }) => req.method === 'POST')   // 永遠不回
    withKey(t, FAKE_KEY)
    const ac = new AbortController()
    const p = askModel(cfg(fake.baseUrl), { source: 'text', text: 'x' }, { signal: ac.signal, timeoutMs: 10_000 })
    setTimeout(() => ac.abort(), 40)
    const r = await p
    assert.equal(r.ok, false)
    assert.equal(r.aborted, true)
  })

  test('signal 一開始就 aborted → 一個請求都不發', async t => {
    const fake = await startFakeModel(t)
    withKey(t, FAKE_KEY)
    const r = await askModel(cfg(fake.baseUrl), { source: 'text', text: 'x' }, { signal: AbortSignal.abort() })
    assert.equal(r.aborted, true)
    assert.deepEqual(fake.requests, [])
  })

  test('**錯誤訊息裡不可以有金鑰**', async t => {
    withKey(t, FAKE_KEY)
    const boom = async () => { throw new Error(`connect failed with Bearer ${FAKE_KEY} to host`) }
    const r = await askModel(cfg('http://127.0.0.1:1/v1'), { source: 'text', text: 'x' }, { fetchImpl: boom })
    assert.equal(r.ok, false)
    assert.ok(!r.error.includes(FAKE_KEY), `金鑰漏進錯誤訊息了：${r.error}`)
    assert.match(r.error, /\*\*\*/)
  })

  test('回應太長 → 不讀完，當成一次失敗（不可以讀爆記憶體）', async t => {
    const fake = await startFakeModel(t, ({ res, req }) => {
      if (req.method !== 'POST') return false
      res.writeHead(200, { 'content-type': 'application/json' })
      const chunk = 'x'.repeat(64 * 1024)
      for (let i = 0; i < 40; i++) res.write(chunk)
      res.end()
      return true
    })
    withKey(t, FAKE_KEY)
    const r = await askModel(cfg(fake.baseUrl), { source: 'text', text: 'x' }, { timeoutMs: 10_000 })
    assert.equal(r.ok, false)
    assert.match(r.error, /too long|Could not read/)
  })

  test('提示詞版本是 v1（改了提示詞要一起改，不然舊答案會被當成新提示詞的）', () => {
    assert.equal(PROMPT_VERSION, 'v2-en')
  })
})
