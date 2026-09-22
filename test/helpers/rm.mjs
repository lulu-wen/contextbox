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

/**
 * 重試幾次、每次隔多久。**故意很小。**
 *
 * Node 的 rmSync 重試是**指數退避**（第 i 次等 retryDelay×i），12 次 × 80ms 加起來
 * 是七秒半 —— 而真正刪不掉的那些是「伺服器還開著資料庫」，等再久也不會好。
 * 結果就是每一條測試白等七秒：audit-0919-ui 的 65 條變成九分鐘，看起來像卡住
 *（2026-09-22 量出來的：make files 31ms、start 199ms、scan 108ms、**rm 7583ms**）。
 *
 * 兩次、25ms：只吸收 Windows 放手把慢半拍的那一種，其餘直接放過。
 * **真正的修法是收尾時把資料庫關掉**（見各測試的 t.after），不是在這裡等。
 */
export const RM_RETRIES = 2
export const RM_DELAY_MS = 25

export function rmTmp(path) {
  if (!path) return
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: RM_RETRIES, retryDelay: RM_DELAY_MS })
  } catch {
    // 放過。留在系統暫存資料夾裡的空殼不是測試結果。
  }
}
