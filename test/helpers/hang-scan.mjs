/**
 * `NODE_OPTIONS=--import=<這支>` 用的 preload：讓 `cleanup scan` 子行程**永遠卡住**（第二輪 R2-10，稽查 C 的 f6b）。
 *
 * 模擬清理範圍在斷線的網路碟上：readdir／lstat 卡在 D state，行程不結束、也不出錯。
 * 以前 pet 的背景重掃沒有逾時，碰到這種子行程就安靜地停止重掃，lastError 也不記。
 *
 * 卡的位置在 cli.mjs 開始跑之前（preload 裡），所以卡住的子行程**什麼都沒做**：
 * 沒有收尾中斷的搬移、沒有掃描、沒有寫資料庫 —— 測試看得出哪些事是 pet 自己做的。
 * 有給 CB_HANG_LOG 的話，先把自己的 pid 寫進去一行，測試用它數「起過幾個子行程」。
 *
 * **只動 `cleanup scan` 這種行程**：同一份 NODE_OPTIONS 也會傳給 pet 本身。
 * 用 Atomics.wait 卡住整條執行緒（跟卡在系統呼叫裡一樣），SIGKILL 照樣砍得掉。
 */
import { appendFileSync } from 'node:fs'

const [sub, action] = process.argv.slice(2)
if (sub === 'cleanup' && action === 'scan') {
  if (process.env.CB_HANG_LOG) appendFileSync(process.env.CB_HANG_LOG, `${process.pid}\n`)
  const cell = new Int32Array(new SharedArrayBuffer(4))
  for (;;) Atomics.wait(cell, 0, 0)
}
