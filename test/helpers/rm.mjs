/**
 * 收尾時刪掉暫存資料夾。**刪不掉不算測試失敗。**
 *
 * Windows 上這件事會失敗，而且跟被測的程式無關：
 *
 *   Error: EPERM, Permission denied: \\?\C:\Users\…\AppData\Local\Temp\cb-mig-66EFvp
 *       at rmSync (node:fs:1282:18)
 *       at TestContext.<anonymous> (…)
 *
 * 行程已經 `db.close()` 了、子行程也已經結束了，但作業系統還沒真的把把手放掉
 * （防毒軟體、索引服務、或只是慢半拍）。`t.after` 丟例外會被 node:test 記成
 * **那一條測試紅了** —— 於是一條斷言全過的測試，因為刪不掉一個暫存資料夾而失敗。
 *
 * 那是假紅字，而假紅字比沒有測試更糟：它會訓練人忽略紅色。
 *
 * 所以這裡：先用 Node 自己的重試（EPERM／EBUSY／ENOTEMPTY 都會重試），
 * 還是刪不掉就**安靜放過** —— 那是系統暫存資料夾，留著一個空殼不會壞任何事，
 * 而且下次開機就清掉了。
 *
 * **只給收尾用。** 測試過程中要驗證「刪掉之後會怎樣」的那些 rmSync 不可以換成這一支：
 * 那時候刪不掉是真的要知道的事。
 */
import { rmSync } from 'node:fs'

/** 重試幾次、每次隔多久。加起來約一秒 —— 夠 Windows 放掉把手，也不會拖慢整套測試。 */
export const RM_RETRIES = 12
export const RM_DELAY_MS = 80

export function rmTmp(path) {
  if (!path) return
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: RM_RETRIES, retryDelay: RM_DELAY_MS })
  } catch {
    // 放過。留在系統暫存資料夾裡的空殼不是測試結果。
  }
}
