/**
 * 假的本機模型伺服器。**測試一律打這一台，絕對不打真的模型、也不讀真的金鑰。**
 *
 * 它假裝自己是 OpenAI 相容的閘道：
 *   GET  /v1/models              列一個模型（doctor 的連線檢查會打這條）
 *   POST /v1/chat/completions    回一筆 chat completion
 *
 * 每一個進來的請求都留在 `requests` 裡（含 headers 與 body 原文），測試可以檢查
 * 「到底送了什麼出去」—— 這一期最重要的一條就是**不該送的東西有沒有被送出去**。
 */
import { createServer } from 'node:http'

/** 一份格式正確的看法。 */
export const GOOD_VIEW = {
  course: '作業系統',
  topic: '死結',
  kind: 'Lecture',
  suggestedName: '作業系統_死結',
  // P7（2026-09-21）：兩個軸。whatItIs 一定有，course 只在真的屬於某門課時才填。
  whatItIs: 'lecture handout',
  subject: '死結的四個必要條件',
  evidence: '文件裡寫著「作業系統 第 6 章 死結」',
  confidence: 'high',
}

/**
 * **不屬於任何課程**的一筆（使用者的 Downloads 大半是這種）。
 * course=Unknown 不是失敗，而且 confidence 照樣是 high ——
 * 「我很確定這是一份履歷，而它不屬於任何一堂課」是一個完整的答案。
 */
export const NO_COURSE_VIEW = {
  course: 'Unknown',
  topic: 'Unknown',
  kind: 'Other',
  suggestedName: 'Computer Science student profile',
  whatItIs: 'resume',
  subject: 'Computer Science student profile',
  evidence: 'PENG-JU WEN　PROFILE',
  confidence: 'high',
}

/** 包成 chat completion 的樣子。 */
export const completion = (view) => ({
  id: 'chatcmpl-fake',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(view) }, finish_reason: 'stop' }],
})

/**
 * 起一台假的模型伺服器。
 *
 * @param t        node:test 的 TestContext（收尾時自動關掉）
 * @param handler  自己決定怎麼回：`(req, res, body) => boolean`，回 true 代表這個請求它處理完了。
 *                 不給（或回 false）就用預設：`/models` 列一個、`/chat/completions` 回 GOOD_VIEW。
 * @param opts.name 這台上面那個模型叫什麼（預設 fake-model）
 */
export async function startFakeModel(t, handler, opts = {}) {
  const name = opts.name ?? 'fake-model'
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let json = null
      try { json = raw ? JSON.parse(raw) : null } catch { /* 不是 JSON 就留原文 */ }
      const entry = { method: req.method, url: req.url, headers: req.headers, raw, json }
      requests.push(entry)
      const send = (status, body, type = 'application/json') => {
        const text = typeof body === 'string' ? body : JSON.stringify(body)
        res.writeHead(status, { 'content-type': type })
        res.end(text)
      }
      if (handler && handler({ req, res, entry, send, requests }) === true) return
      if (req.method === 'GET' && String(req.url).endsWith('/models')) {
        send(200, { object: 'list', data: [{ id: name, object: 'model' }] })
        return
      }
      if (req.method === 'POST' && String(req.url).endsWith('/chat/completions')) {
        send(200, completion(GOOD_VIEW))
        return
      }
      send(404, { error: 'no such route' })
    })
  })
  await new Promise(ok => server.listen(0, '127.0.0.1', ok))
  const port = server.address().port
  const close = () => new Promise(ok => server.close(ok))
  t.after(close)
  return { server, port, requests, close, name, baseUrl: `http://127.0.0.1:${port}/v1` }
}

/** 一份模型設定（給 core/config.ts 的 normalize 或直接組 Config 用）。 */
export const modelConfig = (baseUrl, name = 'fake-model') =>
  ({ baseUrl, name, keyEnv: 'CONTEXTBOX_MODEL_KEY' })
