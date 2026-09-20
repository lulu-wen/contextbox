/**
 * 把這個測試行程的家目錄換成一個空的暫存資料夾。
 *
 * **一定要是測試檔的第一個 import。** core/config.ts 在「模組載入時」就用
 * HOME 與 CONTEXTBOX_CONFIG 算出設定檔路徑 —— 等測試跑起來才設環境變數已經太晚了。
 * ESM 依 import 順序求值，所以放第一行就能搶在 config.ts 之前。
 *
 * 為什麼需要：server 在沒給 roots 的時候會延後去讀設定檔，而 /health 會觸發它。
 * 2026-09-18 實測，server.test.mjs 在一台乾淨的機器上跑完會**建立**
 * ~/.contextbox/config.json；在開發機上則會**讀**使用者真的設定檔。
 *
 * **行程結束時把這個暫存資料夾刪掉**（稽核 RC22）。以前不刪，每跑一次全套就在
 * 暫存資料夾留下十幾個 cb-home-*，裡面可能有測試建的資料庫與隔離區。
 * 正常結束、process.exit、沒接住的例外都會觸發 'exit'；被 SIGINT／SIGTERM 砍掉
 * （測試逾時被 runner 收掉、Ctrl+C）不會，所以另外接這兩個訊號：收拾完再用同一個訊號結束，
 * 不吞掉訊號、不假裝正常結束。
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const FAKE_HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cb-home-')))
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME
// CONTEXTBOX_TOKEN 也要清掉：開發者自己設了一把的話，測試會全部共用它，
// 「每個測試各自一把鑰匙」那條線就不成立了。
for (const k of ['CONTEXTBOX_CONFIG', 'CONTEXTBOX_DB', 'CONTEXTBOX_QUARANTINE', 'CONTEXTBOX_TOKEN_PATH', 'CONTEXTBOX_TOKEN']) {
  delete process.env[k]
}

function cleanup() {
  // 只刪自己建的那一個。刪不掉（Windows 上檔案還開著）就算了 —— 不可以讓收尾本身讓測試失敗。
  try { rmSync(FAKE_HOME, { recursive: true, force: true, maxRetries: 3 }) } catch { /* 留給系統清 */ }
}
process.once('exit', cleanup)
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    cleanup()
    // 用同一個訊號結束：父行程看得到「被砍掉」，而不是一個假的正常結束
    process.kill(process.pid, sig)
  })
}
