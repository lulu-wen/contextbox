/**
 * 設定存檔之後，**跑著的寵物怎麼跟上**（2026-09-20，面板開始可以改設定）。
 *
 * 在這之前 cli.mjs 是 module top-level `load()` 一次，再把 `config.readonly`
 * 當成**布林值**傳進 `start()`。面板寫完檔、回一句「已儲存」，而那個寵物手上
 * 那個布林值是啟動當下那一個 —— 使用者關掉唯讀之後馬上按 Clean up，還是被擋，
 * 而畫面上沒有任何東西講「要重開才算數」。沉默地錯，正是這一輪要擋的那一種。
 *
 * 這支檔只做兩件事：
 *
 *   1. `reloadInto()` —— 重讀設定檔，**原地**蓋回同一個物件。cli.mjs 整支都拿著
 *      同一份 `config` 的參考（`config.readonly`、`thinkRound({ db, config, … })`），
 *      換成一個新物件的話它們全部看不到，跟沒改一樣。
 *
 *   2. 哪些欄位真的立刻生效（`LIVE_SETTINGS`）、哪些一定要重開（`RESTART_SETTINGS`）。
 *      規格那張表寫的是「逐欄講實話」：一律說「已生效」或一律說「要重開」都是騙人。
 *      面板 GET /settings 的 `live` 與 `restart` 就是這兩份。
 */
import { CONFIG_PATH, load } from './config.ts'
import type { Config, Loaded } from './config.ts'

/**
 * 寵物**啟動時就抓走、之後再也不重讀**的欄位。
 *
 * cli.mjs 啟動時做了這些事，每一個都是「當下那個值／那個陣列」：
 *   `CLEAN_ROOTS = config.cleanup.roots`      ← 陣列參考，`start({ roots })` 拿的也是它
 *   `SHOTS = config.cleanup.screenshotsDir`   ← 字串，複製成值
 *   `SCOPE = { roots: CLEAN_ROOTS, screenshotsDir: SHOTS }`
 *   `admitOpts = { roots: config.watch, maxBytes, exclude: [config.filed] }`
 *   `start({ maxBytes: config.maxBytes, filed: config.filed, restoreRoots: … })`
 *
 * `reloadInto()` 換的是**新的陣列與新的字串**，所以上面這些跟不上。這不是懶 ——
 * `cleanup.roots` 與 `cleanup.screenshotsDir` 是**一對**：roots 裡有截圖資料夾時，
 * 那底下只准清截圖（SCREENSHOT_KINDS，第二輪 R2-8）。只把 roots 原地改掉、
 * screenshotsDir 還是啟動時的 null，清理範圍就多了一個資料夾**而且沒有那層過濾** ——
 * macOS 的截圖資料夾就是桌面，桌面上 45 天前的客戶提案 zip 會被當成垃圾搬走。
 * 半套地跟上比完全不跟上更危險，所以這一版**整對都留到下次啟動**。
 *
 * 要讓路徑類欄位也立刻生效，得先讓 `reloadInto()` 原地改那些陣列（splice），
 * 而且 roots 與 screenshotsDir 要一起換。test/settings-live.test.mjs 有一條在守這件事：
 * 白名單一旦收進路徑類欄位，那一條就會紅。
 */
export const FROZEN_AT_STARTUP: readonly string[] = Object.freeze([
  'watch',
  'filed',
  'maxBytes',
  'cleanup.roots',
  'cleanup.screenshotsDir',
])

/**
 * 存下去**立刻**對跑著的寵物生效的欄位。
 *
 * - `readonly`：cli.mjs 改傳 getter（`readonly: () => config.readonly`），
 *   route 每個請求自己解一次（cleanup-routes.ts 的 execOptions）。
 * - `model.*`：`thinkRound({ config })` 拿的是同一個 config 物件，每一輪重讀
 *   `config.model.name`、`modelKey(config)`（那又是讀 `config.model.keyEnv` 指到的環境變數）。
 *   寵物那邊還要補一件事：計時器只有在啟動時模型設定好了才開，所以面板把模型從
 *   「沒設定」改成「設定好了」時要補開一個，不然「立即生效」只對半 —— 見 cli.mjs 的 syncThinkTimer。
 */
export const LIVE_SETTINGS: readonly string[] = Object.freeze([
  'readonly',
  'model.baseUrl',
  'model.name',
  'model.keyEnv',
])

/**
 * 存得下去，但要**下次啟動**才算數的欄位。面板要照這一份明寫出來。
 *
 * `cleanup.screenshots` 在這裡：它不是自己一欄，它會連帶算出 `cleanup.roots`
 * 與 `cleanup.screenshotsDir`（config.ts 的 cleanupOf），而那兩個正是 FROZEN_AT_STARTUP。
 */
export const RESTART_SETTINGS: readonly string[] = Object.freeze([
  'cleanup.screenshots',
])

/**
 * 面板改得動的全部欄位（規格 Step 1 最後一列的五欄）。白名單以外的鍵是 400，
 * **不是**安靜忽略 —— 那是設定那條 route 的事，這裡只放那份名單本身，
 * 讓「改得動」與「生不生效」永遠是同一份東西拆出來的兩半。
 */
export const SETTINGS_WHITELIST: readonly string[] = Object.freeze([
  ...LIVE_SETTINGS,
  ...RESTART_SETTINGS,
])

/**
 * 重讀設定檔，**原地**蓋回 `config`。回 `load()` 那一份 Loaded，但 `config` 是傳進來的那個物件。
 *
 * **只讀不寫。** 這裡不做 normalize 之後回存那種事 —— 使用者手加的欄位會不見，
 * 而 normalize 是寬容的讀取器，回存等於把它的「猜測」寫成事實。寫檔是設定那條 route 的事。
 * （唯一的例外是 `load()` 本身：檔案不在的時候它會補一份預設的出來，跟啟動時同一個行為。）
 *
 * `model` 與 `cleanup` 這兩個巢狀物件也是**原地**蓋：拿著 `config.model` 不放的呼叫端
 * 才看得到新值。陣列（`watch`、`cleanup.roots`）換的是新陣列 —— 為什麼故意如此，見 FROZEN_AT_STARTUP。
 */
export function reloadInto(config: Config, path: string = CONFIG_PATH): Loaded {
  const next = load(path)
  const { model, cleanup, ...rest } = next.config
  Object.assign(config.model, model)
  Object.assign(config.cleanup, cleanup)
  Object.assign(config, rest)
  return { config, problems: next.problems, path: next.path, created: next.created }
}
