/**
 * read-text.ts 的 worker：把訊息接起來，答案寫進共用記憶體。
 *
 * 真正做事的是 core/read-text-job.ts（純函式、保證不丟例外）。分成兩支是因為
 * 呼叫端是**同步**的：它卡在 `Atomics.wait` 裡，收不到 `postMessage`，
 * 所以答案只能走 `SharedArrayBuffer`；而那一段接線沒辦法在測試裡直接呼叫。
 */
import { parentPort, workerData } from 'node:worker_threads'
import { runTextJob, type TextJob } from './read-text-job.ts'
import { TEXT_REASON, TEXT_SLOT } from './read-text.ts'

const ctl = new Int32Array(workerData.ctl as SharedArrayBuffer)
const out = new Uint8Array(workerData.out as SharedArrayBuffer)

/** 把答案寫進共用記憶體再叫醒呼叫端。順序：先寫長度，再寫「好了」。 */
export function reply(payload: unknown): void {
  let bytes: Buffer
  try {
    bytes = Buffer.from(JSON.stringify(payload), 'utf8')
    if (bytes.length > out.length) throw new Error('回應太大')
  } catch {
    // 連答案都組不出來（字串太長、循環參照）：至少要回一個看得懂的失敗
    bytes = Buffer.from(JSON.stringify({ ok: false, reason: TEXT_REASON.unreadable }), 'utf8')
  }
  out.set(bytes, 0)
  Atomics.store(ctl, TEXT_SLOT.len, bytes.length)
  Atomics.store(ctl, TEXT_SLOT.done, 1)
  Atomics.notify(ctl, TEXT_SLOT.done)
}

parentPort?.on('message', (job: TextJob) => {
  reply(runTextJob(job))
})
