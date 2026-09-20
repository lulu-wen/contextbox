/**
 * 一個「會出事」的讀文字 worker，給測試用（createTextReader 的 entry）。
 *
 * 真的要做出「卡住五秒」「把 256 MB heap 吃光」的檔很難（上游模組自己就會擋，
 * 而且 maxBytes 先擋掉了大檔），但那兩條路正是接線層最重要的保證。
 * 所以這裡讓**檔名**決定 worker 的行為，其他檔照真的邏輯讀 ——
 * 這樣「一個惡意檔卡住，其他檔照樣讀得到」是真的一起跑出來的，不是假裝的。
 *
 *   名字裡有「卡住」      → 永遠不回答（呼叫端會逾時、terminate 掉它）
 *   名字裡有「吃記憶體」  → 一直配置到 heap 爆掉（worker 真的死掉）
 *   名字裡有「亂回」      → 往共用記憶體寫不是 JSON 的東西
 *   名字裡有「記憶體不足」→ 回一個 worker 自己接住的配置失敗
 *   其他                  → 照 core/read-text-job.ts 真的讀
 */
import { parentPort, workerData } from 'node:worker_threads'
import { runTextJob } from '../../core/read-text-job.ts'
import { TEXT_REASON, TEXT_SLOT } from '../../core/read-text.ts'

const ctl = new Int32Array(workerData.ctl)
const out = new Uint8Array(workerData.out)

function send(bytes) {
  out.set(bytes, 0)
  Atomics.store(ctl, TEXT_SLOT.len, bytes.length)
  Atomics.store(ctl, TEXT_SLOT.done, 1)
  Atomics.notify(ctl, TEXT_SLOT.done)
}

const reply = payload => send(Buffer.from(JSON.stringify(payload), 'utf8'))

parentPort?.on('message', job => {
  const name = String(job?.path ?? '')
  if (name.includes('卡住')) {
    // 空轉。terminate() 會用 V8 的中斷把它停下來，所以不會留一顆吃滿 CPU 的 thread
    for (;;) { /* 故意的 */ }
  }
  if (name.includes('吃記憶體')) {
    const keep = []
    for (;;) keep.push(new Array(200_000).fill('吃'))
  }
  if (name.includes('亂回')) {
    send(Buffer.from('這不是 JSON', 'utf8'))
    return
  }
  if (name.includes('記憶體不足')) {
    reply({ ok: false, reason: TEXT_REASON.outOfMemory })
    return
  }
  reply(runTextJob(job))
})
