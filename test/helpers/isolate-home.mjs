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
 */
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const FAKE_HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cb-home-')))
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME
for (const k of ['CONTEXTBOX_CONFIG', 'CONTEXTBOX_DB', 'CONTEXTBOX_QUARANTINE', 'CONTEXTBOX_TOKEN_PATH']) {
  delete process.env[k]
}
