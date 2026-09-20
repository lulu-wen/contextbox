/**
 * 面板裡改設定 —— `~/.contextbox/config.json` 的第一條**寫入**路徑（2026-09-20）。
 *
 * ── 為什麼這一支要自己一個檔、而且要這麼小心 ──────────────────
 *
 * `core/config.ts` 的 `normalize()` 是一個**寬容的讀取器**：壞掉的 `filed` 換成預設值
 * 並附一句話、壞掉的 `cleanup.roots` 整條丟掉，一律不丟例外。那對「讀一份被手改過的
 * 檔」是對的 —— 設定檔改壞了不該讓整個服務起不來。
 *
 * 但那套寬容**不可以繼承到寫入**。使用者在面板上按「儲存」，面板說「已儲存」，
 * 檔案裡卻是 normalize 換過的另一個值 —— 那是要好幾天後才會發現的錯。
 * 所以這裡：`normalize()` 只用來**驗**，永遠不用來**寫**。
 *
 * 另外兩條寫在這一支裡的判斷：
 *
 *   · `model.baseUrl` 一改就是「把我的檔案送去別台主機」，`readonly` 一關就是
 *     「可以搬我的檔了」。所以能改的只有白名單五欄（見 EDITABLE），白名單以外的鍵
 *     **回 400，不是安靜忽略** —— 安靜忽略等於面板騙人。
 *   · 金鑰永遠不出這條 HTTP。只回 `keyEnv` 的名字與 `keySet`，而且任何要回給呼叫端
 *     的句子都先過 scrub()：2026-09-20 早上 doctor 真的把使用者貼進 `keyEnv` 的金鑰
 *     整串印出去過（見 config.ts 裡那一段），同一個坑不要再踩第二次。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync, lstatSync, readlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, basename, resolve, relative, isAbsolute, sep } from 'node:path'
import { normalize, defaults, type Config } from './config.ts'

/** 環境變數。測試會換掉整份，所以不直接讀 process.env。 */
export type Env = Record<string, string | undefined>

/** server 知道、但設定檔裡沒有的東西（隔離區是 server 自己算的）。 */
export type SettingsExtras = { quarantine?: string }

export type SettingsView = {
  /** 設定檔位置，家目錄底下的縮成 `~/…`（不變量 8 護的是免 token 的 /health，不是這一頁）。 */
  path: string
  /** 這一版面板可以改的五欄，就是 EDITABLE 那五條。 */
  editable: {
    readonly: boolean
    model: { baseUrl: string; name: string; keyEnv: string }
    cleanup: { screenshots: boolean }
  }
  /** `env[keyEnv]` 有沒有東西。**永遠不回金鑰本身。** */
  keySet: boolean
  /** 這一版只顯示、不給改的欄位（路徑類要自己一輪：掃描範圍指到哪裡是另一種風險）。 */
  shown: {
    watch: string[]
    filed: string
    cleanupRoots: string[]
    quarantine: string
    pdfPages: number
    maxBytes: number
  }
  /** normalize() 對**現在這份檔案**的意見。跟 doctor 看到的是同一批句子。 */
  problems: string[]
  /** 改了立刻生效的欄位。 */
  live: string[]
  /** 改了要重開寵物才生效的欄位。 */
  restart: string[]
}

export type PatchOk = {
  ok: true
  settings: SettingsView
  /** 這次 patch 碰到、而且要重開才生效的欄位。 */
  restartNeeded: string[]
  /** 寫完之後的設定，給 server 通知寵物用（onSettingsSaved）。 */
  config: Config
}

export type PatchFail = {
  ok: false
  code: 'BAD_SETTING' | 'WRITE_FAILED'
  error: string
  /** 欄位路徑 → 為什麼不收。BAD_SETTING 一定有，WRITE_FAILED 沒有。 */
  fields?: Record<string, string>
}

export type PatchResult = PatchOk | PatchFail

/**
 * **可以改的欄位，就這五條。**
 *
 * 路徑類（`watch`、`filed`、`cleanup.roots`）這一版只顯示不給改 —— 那是另一種風險
 * （掃描與搬移的範圍指到哪裡），值得自己一輪。`pdfPages`、`maxBytes` 同理：
 * 面板上多一個輸入框很便宜，但每一欄都要有自己的界內／界外測試。
 */
export const EDITABLE = ['readonly', 'model.baseUrl', 'model.name', 'model.keyEnv', 'cleanup.screenshots'] as const

/**
 * 改了**立刻**生效的欄位。
 *
 * `readonly` 與 `model.*` 是 route 每次請求現查的（server.ts 把它們包成 thunk），
 * 所以檔案一換就是新的值。其餘欄位在 `start()` 當下就算好了（清理範圍、歸檔資料夾、
 * 大小上限），改完要重開寵物 —— **逐欄講實話**，不要一律說「已生效」或一律說「要重開」。
 */
const LIVE: string[] = ['readonly', 'model.baseUrl', 'model.name', 'model.keyEnv']

/** live ∪ restart 剛好等於 EDITABLE：面板每一欄都要說得出它什麼時候生效，一欄都不可以漏。 */
const RESTART: string[] = EDITABLE.filter(f => !LIVE.includes(f))

/**
 * 字串那三欄的長度上限。
 *
 * 型別對就照收的話，一個貼歪的剪貼簿（整份文件、一整段 base64）就變成一份好幾 MB 的
 * `config.json`，而那份檔案每一次啟動、每一次 doctor、每一次開面板都要重讀一遍。
 * 512 對這三欄都很寬鬆：環境變數名、模型名、`https://host:port/path` 都用不到一半。
 */
const MAX_LEN = 512

/**
 * 每一欄收什麼型別。normalize 對型別是寬容的，寫入不繼承那份寬容。
 *
 * **字串那三欄靠的就是這一關**：`model.name: 123` normalize 會靜靜換成空字串而且
 * **一句話都不講** —— 下面那套「值變了 + 多一句意見」的判法看不到它，
 * 於是 `123` 會原封不動被寫進設定檔。布林那兩欄 normalize 會出聲（所以那邊是雙保險），
 * 但訊息在這裡講得比較清楚，而且不回放使用者寫的值。
 */
const LEAF_TYPE: Record<string, 'boolean' | 'string'> = {
  readonly: 'boolean',
  'model.baseUrl': 'string',
  'model.name': 'string',
  'model.keyEnv': 'string',
  'cleanup.screenshots': 'boolean',
}

/** 白名單裡有子欄位的那幾組。patch 裡的 `model` 一定要是物件。 */
const GROUPS = ['model', 'cleanup']

/**
 * 可能是金鑰的東西，至少要有幾個字元才值得遮。
 *
 * 太短的一律不遮：不然 `The model URL abc could not be read` 這種正常訊息會被吃掉，
 * 而 8 個字元以下的東西也不會是任何一家的金鑰。
 */
const SECRET_MIN = 8

const isObj = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** 家目錄底下的絕對路徑縮成 `~/…`；其他原樣（使用者自己把設定檔放在 /srv 就照實講）。 */
export function tilde(p: string): string {
  const s = String(p ?? '')
  if (!s) return s
  const home = resolve(homedir())
  const abs = resolve(s)
  if (abs === home) return '~'
  const rel = relative(home, abs)
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return abs
  return '~' + sep + rel
}

/**
 * 要回給呼叫端的句子，先把「可能是金鑰的值」換掉。
 *
 * 只比**完全一樣的子字串**，不做模糊比對：`http://8.8.8.8/v1` 被拒時 normalize 印的是
 * `The model URL http://8.8.8.8 is not safe`（只有 protocol + hostname），對不上原字串，
 * 所以那句有用的話留得下來；使用者把金鑰貼進 `baseUrl` 時 normalize 印的是整串原字串，
 * 對得上，就換成 [not shown]。
 */
function scrub(text: string, secrets: string[]): string {
  let out = String(text ?? '')
  for (const s of secrets) if (s.length >= SECRET_MIN) out = out.split(s).join('[not shown]')
  return out
}

/**
 * 一份設定檔裡「可能是金鑰」的值：model 那兩欄是使用者最容易貼錯的地方。
 *
 * **normalize 印出來的形狀跟使用者打的不一定一樣，每一種都要收**（2026-09-20 稽核）：
 *   · normalize 的 model 那一段是先 `.trim()` 再把值印進句子的，而從瀏覽器輸入框貼過來的
 *     東西前後幾乎一定帶空白 —— 實測同一把假金鑰只差兩個空白，一個被遮，另一個原封不動
 *     出現在 GET /settings 與 400 的回應裡。
 *   · URL 解析器會把主機名**轉小寫**，而 checkBaseUrl 的「這個位址不安全」那一句印的是
 *     protocol + hostname，所以 `http://<金鑰>` 這個形狀還要收小寫版（小寫的金鑰一樣能用）。
 *
 * 長的先換：兩個候選有包含關係時先換掉短的，會在句子裡留下長的那一串的尾巴。
 */
function secretsOf(raw: unknown): string[] {
  const m = isObj(raw) && isObj(raw.model) ? raw.model : {}
  const out: string[] = []
  const add = (s: unknown) => {
    if (typeof s === 'string' && s.length >= SECRET_MIN && !out.includes(s)) out.push(s)
  }
  for (const v of [m.baseUrl, m.keyEnv]) {
    if (typeof v !== 'string') continue
    for (const s of [v, v.trim(), v.trim().toLowerCase()]) add(s)
    // **句子裡出現的不一定是整串。** checkBaseUrl 的「這個主機不安全」那一句印的是
    // `protocol//hostname`（config.ts），而 URL 解析會把主機名轉小寫 —— 把金鑰貼進
    // 端點欄位、寫成 `http://<金鑰>/v1` 的時候，登記整串比對不到那個片段，
    // 小寫過的金鑰就這樣出去了（2026-09-20 修完稽核之後自己實測抓到的）。
    // 所以每一種會被印出來的切法都要登記，scrub 由長到短替換。
    let u = null
    try { u = new URL(v.trim()) } catch { u = null }
    if (u) {
      for (const s of [`${u.protocol}//${u.hostname}`, u.hostname, u.username, u.password]) {
        add(s)
        if (typeof s === 'string') add(s.toLowerCase())
      }
    }
  }
  return out.sort((a, b) => b.length - a.length)
}

/** 訊息裡的家目錄縮成 `~`（normalize 的句子帶完整路徑，例如 `Watched folder /home/…`）。 */
function homeless(text: string): string {
  const home = resolve(homedir())
  return home && home !== sep ? String(text).split(home).join('~') : String(text)
}

/** 回給呼叫端之前，每一句都要過這兩關。 */
const say = (text: string, secrets: string[]): string => scrub(homeless(text), secrets)

function valueAt(o: unknown, path: string): unknown {
  let cur: unknown = o
  for (const k of path.split('.')) {
    if (!isObj(cur)) return undefined
    cur = cur[k]
  }
  return cur
}

/**
 * 讀設定檔的**原文**。
 *
 * 跟 `load()` 不一樣的兩點：檔案不在時**不寫檔**（讀一頁設定不可以順手建檔），
 * JSON 壞掉時回 `broken` 而不是退回預設 —— 上層要靠它決定「這份檔不能動」。
 */
function readRaw(path: string): { raw: Record<string, unknown> | null; broken: string | null } {
  if (!existsSync(path)) return { raw: null, broken: null }
  let text: string
  try { text = readFileSync(path, 'utf8') }
  catch (e: any) { return { raw: null, broken: `The config file could not be read (${e.message}).` } }
  let parsed: unknown
  // 解析錯誤的訊息**不可以帶進來**：V8 會把出錯位置前後約十個位元組的檔案原文附上
  //（`Unexpected token 's', "sk-live-9f"... is not valid JSON`）。設定檔第一行就是金鑰的
  // 時候那十個位元組就是它，而這句話 GET 與 WRITE_FAILED 兩條路都會回給呼叫端。
  // 讀檔錯誤（上面那一個 catch）講得出原因就好 —— 那是 errno 跟路徑，不是檔案內容。
  try { parsed = JSON.parse(text) }
  catch { return { raw: null, broken: 'The config file could not be read (it is not valid JSON).' } }
  if (!isObj(parsed)) return { raw: null, broken: 'The config file is not a JSON object.' }
  return { raw: parsed, broken: null }
}

/** 檔案不存在時的底稿：跟 `load()` 寫出來的那一份一模一樣（screenshotsDir 是算出來的，不進檔案）。 */
function blankFile(): Record<string, unknown> {
  const d = defaults()
  return { ...d, cleanup: { roots: d.cleanup.roots, screenshots: d.cleanup.screenshots } } as Record<string, unknown>
}

/** 從 normalize 過的設定 + 原始檔案的意見，組出要回給面板的那一份。 */
function view(path: string, raw: Record<string, unknown> | null, config: Config, problems: string[],
              env: Env, extras: SettingsExtras): SettingsView {
  const secrets = secretsOf(raw)
  const quarantine = extras.quarantine ?? env.CONTEXTBOX_QUARANTINE ?? join(homedir(), '.contextbox', 'quarantine')
  return {
    path: tilde(path),
    editable: {
      readonly: config.readonly,
      model: { baseUrl: config.model.baseUrl, name: config.model.name, keyEnv: config.model.keyEnv },
      cleanup: { screenshots: config.cleanup.screenshots },
    },
    // **只說有沒有設，不說是什麼。** 金鑰不出這台機器，也不出這條 HTTP。
    keySet: String(env[config.model.keyEnv] ?? '').trim() !== '',
    shown: {
      watch: config.watch.map(tilde),
      filed: tilde(config.filed),
      cleanupRoots: config.cleanup.roots.map(tilde),
      quarantine: tilde(quarantine),
      pdfPages: config.pdfPages,
      maxBytes: config.maxBytes,
    },
    problems: problems.map(p => say(p, secrets)),
    live: [...LIVE],
    restart: [...RESTART],
  }
}

/**
 * 現在的設定長什麼樣。**不寫檔、不建檔** —— 這是一條讀取路徑。
 *
 * 檔案不存在就照預設值顯示（面板照樣打得開，按了儲存才會真的生出一份檔，見 applyPatch）。
 */
export function readSettings(path: string, env: Env = process.env, extras: SettingsExtras = {}): SettingsView {
  const { raw, broken } = readRaw(path)
  const n = normalize(raw ?? {})
  const problems = broken ? [broken, ...n.problems] : n.problems
  return view(path, raw, n.config, problems, env, extras)
}

const notEditable = (p: string): string =>
  `${p} cannot be changed here. This page only changes ${EDITABLE.join(', ')}.`

/** patch 攤平成「葉子路徑 → 值」。回到 bad 裡的就是白名單以外的鍵（要拒絕，不是忽略）。 */
function leavesOf(patch: unknown): { leaves: Map<string, unknown>; bad: Record<string, string> } {
  const leaves = new Map<string, unknown>()
  // **`Object.create(null)`，不是 `{}`**（2026-09-20 稽核）：一般物件上
  // `bad['__proto__'] = '…'` 會走進 `__proto__` 的 setter，而那個 setter **只收物件** ——
  // 塞一個字串進去等於什麼都沒發生，`Object.keys(bad).length` 還是 0，於是
  // `{"__proto__": …}` 這個 patch 一路安靜地退化成「什麼都沒改」並回 200 saved:true。
  // `JSON.parse` 會把 `__proto__` 做成**自有屬性**，所以這條從 HTTP 真的進得來。
  const bad: Record<string, string> = Object.create(null)
  if (!isObj(patch)) {
    bad['(body)'] = 'The body must be a JSON object.'
    return { leaves, bad }
  }
  for (const [k, v] of Object.entries(patch)) {
    // JSON 生不出 undefined，但這是一支公開函式：沒帶就是沒帶，不要當成「設成 undefined」
    if (v === undefined) continue
    if (GROUPS.includes(k)) {
      if (!isObj(v)) { bad[k] = `${k} must be an object.`; continue }
      for (const [sub, sv] of Object.entries(v)) {
        if (sv === undefined) continue
        const p = `${k}.${sub}`
        if (!(EDITABLE as readonly string[]).includes(p)) { bad[p] = notEditable(p); continue }
        leaves.set(p, sv)
      }
      continue
    }
    if (!(EDITABLE as readonly string[]).includes(k)) { bad[k] = notEditable(k); continue }
    leaves.set(k, v)
  }
  return { leaves, bad }
}

/** 只把 patch 碰到的葉子疊上去，其餘的鍵（包含沒人認得的 `comment`）原樣抄回去。 */
function mergeInto(raw: Record<string, unknown>, leaves: Map<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw }
  for (const [p, v] of leaves) {
    const dot = p.indexOf('.')
    if (dot < 0) { out[p] = v; continue }
    const group = p.slice(0, dot)
    const cur = out[group]
    // 原本那一組不是物件（手改壞了）就從空的開始 —— 這次 patch 本來就要動這一組
    const next = isObj(cur) ? { ...cur } : {}
    next[p.slice(dot + 1)] = v
    out[group] = next
  }
  return out
}

/** 把某一條換成別的值的複本（不動原本那一份 —— 外面那個迴圈還在用它）。 */
function accept(leaves: Map<string, unknown>, path: string, value: unknown): Map<string, unknown> {
  const out = new Map(leaves)
  out.set(path, value)
  return out
}

/** all 比 before 多出來的句子（照數量算，同一句出現兩次算兩次）。 */
function extraProblems(all: string[], before: string[]): string[] {
  const left = [...before]
  const out: string[] = []
  for (const p of all) {
    const i = left.indexOf(p)
    if (i >= 0) left.splice(i, 1)
    else out.push(p)
  }
  return out
}

/**
 * 原子寫入：同目錄的暫存檔 + renameSync，mode 0600。
 *
 * 為什麼不直接 `writeFileSync(path, …)`：寫到一半斷電會留下半截的 config.json，
 * 下一次啟動就整個起不來。rename 在同一個檔案系統上是原子的 —— 讀到的要嘛是舊的那一份，
 * 要嘛是完整的新的那一份，沒有中間狀態。**暫存檔一定要跟正本同一個目錄**，
 * 跨檔案系統的 rename 會回 EXDEV（歸檔那條線踩過，見 CROSS_DEVICE）。
 *
 * 暫存檔名帶 pid 而且固定：這個專案的規矩是「只搬不刪」（見 guard.ts 的檔頭與
 * test/repo.test.mjs），所以 rename 失敗時留下來的那一個暫存檔不會被收掉 ——
 * 同一個行程下一次寫就把它蓋掉、再 rename 走，不會愈積愈多。
 *
 * `writeFileSync` 的 mode 只在「建立」時生效，覆寫既有的暫存檔要自己 chmod 回來
 * （跟 server.ts 的 loadToken 同一個坑）。
 */
function writeAtomic(given: string, text: string): void {
  // **寫回 readRaw 剛剛讀的那一個檔**，見 followLink。暫存檔跟著正本走，
  // rename 才會留在同一個檔案系統上。
  const path = followLink(given)
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `.${basename(path)}.${process.pid}.tmp`)
  writeFileSync(tmp, text, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

/**
 * 最後一段是捷徑就跟著走到正本（多層也走）。
 *
 * `rename(2)` **不看最後一段的捷徑**，所以不先解開的話，
 * `ln -s ~/dotfiles/contextbox.json ~/.contextbox/config.json` 這種裝法會被一次儲存拆掉：
 * 讀的時候順著捷徑走（readRaw 走的是 readFileSync），寫的時候卻蓋在捷徑本身上，
 * 而面板照樣說「已儲存」。dotfiles repo 裡那一份從此停在存檔前，`git status` 乾乾淨淨，
 * 下一次 `chezmoi apply`／`dotbot` 反而把面板改過的東西**整批倒回去**（2026-09-20 稽核）。
 * 只有**檔案**是捷徑會壞；整個 `~/.contextbox` 是捷徑那一種（stow 的預設）本來就沒事 ——
 * `dirname()` 會穿過去，rename 的最後一段是真的檔案。
 *
 * 為什麼不用 `realpathSync`：它對**斷掉的**捷徑會丟例外，而那正是「dotfiles 還沒 checkout」
 * 的那一刻 —— 第一次儲存應該把正本生在 repo 裡，不是把捷徑換成一般檔。
 * `lstat` + `readlink` 兩個都不跟著走，自己走到 ENOENT 為止就對了。
 *
 * 治不了的一種：`cp -l` 硬連結進 dotfiles 的話 rename 一樣會斷開它 ——
 * 那是原子寫入本身的代價（換的是整個 inode），不是這裡能補的。
 */
function followLink(path: string): string {
  let p = path
  for (let i = 0; i < 8; i++) {                     // 上限擋住互相指來指去的捷徑
    let st
    try { st = lstatSync(p) } catch { return p }    // 不存在就照原樣（第一次建檔、斷掉的捷徑走到底）
    if (!st.isSymbolicLink()) return p
    p = resolve(dirname(p), readlinkSync(p))        // 相對的捷徑是相對**捷徑自己**那一層
  }
  return p
}

const REFUSED = 'Nothing was saved and the config file was not changed. See fields for what was wrong.'

/**
 * 套一份 patch 到設定檔上。
 *
 * 順序是：白名單 → **當下重讀檔案** → 只疊 patch 的鍵 → normalize 驗**合併後**的結果 →
 * 把每一句意見歸到欄位 → 這次碰到的欄位有意見就整份拒絕（檔案一個位元組都不動）→ 原子寫入。
 *
 * ── 「這句話是在講哪一欄」怎麼判 ────────────────────────────
 *
 * normalize 回的是自由格式的英文句子，**不可以拿字串去猜**。這裡用兩個訊號一起判，
 * 兩個都成立才算「這一欄被丟掉了」：
 *
 *   1. normalize 之後那一欄的值**跟送來的不一樣**；而且
 *   2. 把這一欄（只有這一欄）換成 **normalize 自己收下的那個值**再 normalize 一次，
 *      意見會少一句 —— 少掉的那幾句就是這一欄害的。
 *
 * 為什麼要兩個都看：
 *   · 只看 (1)：`https://api.example.com/v1/` 會被 checkBaseUrl 整理成沒有尾斜線的
 *     `https://api.example.com/v1`，主機名的大小寫也會被 URL 正規化 —— 值變了，但沒有人
 *     有意見。那是**整理**不是**丟掉**，擋下來就等於使用者永遠存不進一個合法的網址。
 *   · 只看 (2)：`cleanup.screenshots: true` 會把截圖資料夾加進清理範圍，如果 `filed`
 *     剛好在那底下，normalize 會多講一句「歸檔的檔之後又會被列成清理候選」。那句是**後果**
 *     的提醒，不是「這個 true 我不收」—— 值原樣收下了，就不該擋。那句話會照樣出現在
 *     回應的 problems 裡給使用者看。
 *
 * 另外，型別在進來的時候就先擋（LEAF_TYPE）：normalize 對型別特別寬容
 * （`readonly:"true"` 靜靜變成 true、`model.name: 123` 靜靜變成空字串、一句話都不講），
 * 那份寬容對「讀一份手改過的檔」是對的，對「存使用者剛打的字」是錯的。
 *
 * **唯讀模式不擋這條路。** 唯讀講的是「不搬你的檔」，不是「不准你關掉唯讀」——
 * 關不掉的開關是陷阱（跟 /learned 那條 READ_ONLY 不同，那條動的是使用者的資料）。
 */
export function applyPatch(path: string, patch: unknown, env: Env = process.env,
                           extras: SettingsExtras = {}): PatchResult {
  const { leaves, bad } = leavesOf(patch)

  // 型別與長度先擋。訊息裡不回放使用者寫的值 —— 那一格可能被貼進金鑰
  for (const [p, v] of leaves) {
    const want = LEAF_TYPE[p]
    if (want === 'boolean' && typeof v !== 'boolean') bad[p] = `${p} must be true or false.`
    if (want === 'string') {
      if (typeof v !== 'string') bad[p] = `${p} must be a string.`
      else if (v.length > MAX_LEN) bad[p] = `${p} is too long (the most this page accepts is ${MAX_LEN} characters).`
      // **空的 keyEnv 不是「回預設」，是把使用者的設定弄不見**（2026-09-20 稽核 verify:contract-8）。
      // config.ts:393 讀到空字串會當成沒這個鍵、換上預設的 CONTEXTBOX_MODEL_KEY —— 讀一份手改過的
      // 檔時那樣寬容是對的，存的時候不是：檔案裡留 ""、生效的卻是別的名字，正是這支檔開頭那條
      // 「面板說已儲存、檔案裡卻是另一個值」。真的發生過的路是面板 400 之後把那一格清掉，
      // 下一次儲存就夾著 `keyEnv: ""` 上來，使用者的 CONTEXTBOX_OTHER_KEY 就這樣沒了。
      else if (p === 'model.keyEnv' && v.trim() === '') {
        bad[p] = 'model.keyEnv cannot be empty. It must be the name of an environment variable starting with CONTEXTBOX_.'
      }
    }
  }
  if (Object.keys(bad).length) return { ok: false, code: 'BAD_SETTING', error: REFUSED, fields: bad }

  // **寫的當下重讀**，不是拿啟動時載進記憶體的那一份：兩個面板同時開、一個改 readonly
  // 一個改 model.name，後存的那一個不可以把前一個蓋掉。
  const { raw, broken } = readRaw(path)
  if (broken) {
    // `load()` 也是這條規矩：讀不懂的檔**不覆蓋**。這裡連合併都做不到 ——
    // 沒改到的鍵要原樣抄回去，而我們根本不知道那些鍵是什麼。
    // 這條路上每一句話都過 say()（homeless + scrub），就這一句以前沒有 —— 於是
    // 使用者的 OS 帳號名整串印在面板上，而同一頁上面兩行寫的是 `~/.contextbox/config.json`
    //（2026-09-20 稽核）。設定頁是最可能被截圖貼給別人看的一頁。
    // secrets 這裡真的沒有（raw 是 null，根本沒解析成功），所以給空陣列；homeless 照樣會跑。
    return {
      ok: false, code: 'WRITE_FAILED',
      error: say(`${broken} Nothing was changed. Fix that file, or move it aside, first.`, []),
    }
  }
  // 乾淨安裝直接開面板改 readonly：**建得出來就建**（跟 load() 同一份預設 + 這次的 patch）。
  // 這是使用者按了「儲存」，不是背景行為 —— 免 token 的 /health 走不到這裡。
  const base = raw ?? blankFile()

  const merged = mergeInto(base, leaves)
  const full = normalize(merged)
  const secrets = secretsOf(merged)

  const rejected: Record<string, string> = {}
  for (const [p, asked] of leaves) {
    if (Object.is(valueAt(full.config, p), asked)) continue          // 原樣收下
    // 基準線是「normalize 對這一欄**收下**的那個值」，不是檔案裡的舊值（2026-09-20 稽核，
    // 兩位稽核員各自獨立找到）。舊值也壞掉的時候 —— 而會來開這一頁的人有一半正是為了修它 ——
    // 兩邊生出**逐位元組一模一樣**的句子而互相抵銷，blame 變空，於是一個 normalize 明明
    // 拒絕掉的值被當成「只是被整理過」寫進檔案。normalize 有三句話完全不帶使用者的值
    //（looksLikeAKey、要 CONTEXTBOX_ 開頭、網址裡的帳號密碼），它們一碰就撞：檔案裡本來
    // 就有一把手貼的金鑰，使用者再貼一把新的進 keyEnv，**新金鑰就這樣進了 config.json**，
    // 而面板轉頭顯示 CONTEXTBOX_MODEL_KEY，沒有人知道它漏了。當初的測試只跑過「壞→好」。
    //
    // 為什麼不是「把這一欄從基準線裡**刪掉**」（另一個候選修法）：normalize 對自己的輸出
    // 是冪等的，但「沒有這個鍵」不等於「收下的值」—— `cleanup.screenshots` 不在檔案裡
    // 就是 false，刪掉它等於偷偷換掉預設值，於是檔頭「只看 (2)」那一段講的**後果提醒**
    //（歸檔資料夾之後又會被列成清理候選）會變成憑空多出來的罪名。實測：把上面第 1 個訊號
    // 的 Object.is 短路拿掉，刪鍵版當場把那一次合法的存檔擋掉，換值版照樣放行。
    // 今天靠 Object.is 擋著，但基準線本身不該有這種脆弱處。
    const clean = normalize(mergeInto(base, accept(leaves, p, valueAt(full.config, p))))
    const blame = extraProblems(full.problems, clean.problems)
    if (!blame.length) continue                                       // 只是被整理過
    rejected[p] = say(blame.join(' '), secrets)
  }
  if (Object.keys(rejected).length) return { ok: false, code: 'BAD_SETTING', error: REFUSED, fields: rejected }

  // 什麼都沒改的那一次：一樣算一次成功的儲存（面板按了儲存本來就不是錯），但**不要動檔案**。
  // 重寫一遍會把使用者自己排的版跟縮排洗掉，而且白白換掉一個 inode。
  if (!leaves.size) {
    return { ok: true, settings: readSettings(path, env, extras), restartNeeded: [], config: full.config }
  }

  try {
    writeAtomic(path, JSON.stringify(merged, null, 2) + '\n')
  } catch (e: any) {
    return {
      ok: false, code: 'WRITE_FAILED',
      error: say(`The config file could not be written (${e.message}). Nothing was changed.`, secrets),
    }
  }

  // 只列**真的變了**的欄位：送來但沒改到的也算進去的話，面板每按一次儲存就叫使用者
  // 去重開一次什麼都沒變的寵物（而重開寵物要停掉正在跑的整理）。比的是 normalize 之後的
  // 生效值，不是檔案裡的字面值 —— `"  qwen3  "` 跟 `"qwen3"` 對跑著的寵物是同一件事。
  const before = normalize(base).config

  // 寫完再讀一次：回給面板的是**檔案上真的長的樣子**，不是我們以為寫進去的樣子
  return {
    ok: true,
    settings: readSettings(path, env, extras),
    restartNeeded: [...leaves.keys()]
      .filter(p => RESTART.includes(p) && !Object.is(valueAt(before, p), valueAt(full.config, p))),
    config: full.config,
  }
}
