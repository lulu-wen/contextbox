/**
 * `NODE_OPTIONS=--import=<這支>` 用的 preload：把 `cleanup scan` 子行程的掃描放慢（第二輪 R2-12，稽查 B 的發現）。
 *
 * 第三波 C2 的兩條測試（開機掃描進行中 /health 照樣馬上回、同時間最多一個掃描子行程）要「量的時候掃描還沒做完」。
 * 以前靠的是 1000 個檔在 ext4 上要掃十幾秒（每一列提交都 fsync）—— TMPDIR 在 tmpfs 的機器上 0.3 秒就掃完，
 * 兩條必紅，是環境造成的假紅。這支讓掃描的每一次 lstat 都先同步睡 CB_SLOW_SCAN_MS 毫秒（預設 10），
 * 掃多久由測試決定，不看碟快不快。
 *
 * **只動 `cleanup scan` 這種行程**：同一份 NODE_OPTIONS 也會傳給 pet 本身，pet 不可以跟著變慢。
 * scanner 是 `import { lstatSync } from 'node:fs'`，所以換掉之後要 syncBuiltinESMExports，它拿到的才是換過的那一支。
 * 用 Atomics.wait 睡：跟真的慢碟一樣卡住整條執行緒，不是讓出事件迴圈。
 */
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const [sub, action] = process.argv.slice(2)
if (sub === 'cleanup' && action === 'scan') {
  const ms = Number(process.env.CB_SLOW_SCAN_MS) || 10
  const cell = new Int32Array(new SharedArrayBuffer(4))
  const lstat = fs.lstatSync
  fs.lstatSync = function (...a) {
    Atomics.wait(cell, 0, 0, ms)
    return lstat.apply(this, a)
  }
  syncBuiltinESMExports()
}
