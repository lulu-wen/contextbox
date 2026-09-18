/**
 * 設定 —— ~/.contextbox/config.json
 *
 * 三個原則：
 *   1. 沒有設定檔也要能跑。第一次啟動會照這台機器的樣子寫一份出來。
 *   2. **金鑰不進設定檔。** 只從環境變數讀。
 *   3. 路徑一律在這裡就展開成絕對路徑並解析捷徑。後面的程式碼
 *      看到的 watch／filed 都已經是真路徑，guard 才有辦法只比對一次。
 *
 * ── 為什麼設定檔的每一個欄位都要驗 ─────────────────────────────
 *
 * 這個檔案是「給人手改、會被備份、會被貼到聊天室」的東西。稽查指出：
 * 它雖然不放金鑰，但它可以指定**去讀哪一個環境變數**，也可以指定
 * **要把金鑰送去哪一台主機**。把 `keyEnv` 換成 `AWS_SECRET_ACCESS_KEY`、
 * `baseUrl` 換成攻擊者的網址，使用者跑一次看起來人畜無害的 `doctor`，
 * 憑證就以 Bearer 送出去了，畫面上還顯示「金鑰 ✓ 讀到了」。
 *
 * 所以 `keyEnv` 只准 CONTEXTBOX_ 開頭；`baseUrl` 的 https 打哪裡都行，
 * 明文 http 只准打自己內網的位址（見 isPrivateHost）——判準不是「有沒有加密」，
 * 是「會不會離開你的網路」。家裡的叢集用明文本來就是常態。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, resolve, isAbsolute, posix, win32 } from 'node:path'
import { under, DENY_DIRS } from './guard.ts'

export type ModelConfig = {
  baseUrl: string
  name: string
  keyEnv: string
}

/**
 * 清理（搬進隔離區）的範圍。**跟截圖功能的 watch 分開。**
 *
 * 稽查抓到（C-B1）：清理原本沿用 watch，而 macOS 的 watch 預設含**桌面**、
 * Windows／Linux 含截圖資料夾 —— 45 天前放在桌面上的客戶提案 zip 會被當成垃圾搬走。
 * spec 明寫清理只碰 Downloads。
 */
export type CleanupConfig = {
  /** 清理掃描與搬移的根目錄。預設只有 Downloads（Windows 會先看 OneDrive 那一個）。 */
  roots: string[]
  /** true 才把截圖資料夾加進清理範圍（給之後的連拍功能用）。看不懂一律當成 false。 */
  screenshots: boolean
}

export type Config = {
  watch: string[]
  filed: string
  model: ModelConfig
  readonly: boolean
  pdfPages: number
  maxBytes: number
  cleanup: CleanupConfig
}

/** 算預設路徑用的「這台機器」。測試可以換成別的作業系統與家目錄。 */
export type SysInfo = { os?: string; home?: string }

export const CONFIG_PATH = process.env.CONTEXTBOX_CONFIG
  ?? join(homedir(), '.contextbox', 'config.json')

/** 金鑰只能放在這種名字的環境變數裡 */
const KEY_ENV_OK = /^CONTEXTBOX_[A-Z0-9_]+$/

/**
 * 這台機器的截圖與下載慣例落在哪。
 *
 * Windows 要多考慮 OneDrive：Win11 綁 Microsoft 帳號時「已知資料夾移轉」
 * 預設是開的，真正的路徑會變成 %USERPROFILE%\OneDrive\Pictures\Screenshots。
 * 所以兩個都列，取實際存在的那一個。
 */
export function osDefaults(os: string = platform(), home: string = homedir()):
  { watch: string[]; filed: string; downloads: string; screenshots: string } {
  const pick = (...candidates: string[]) => candidates.find(existsSync) ?? candidates[0]
  let screenshots: string, downloads: string
  if (os === 'win32') {
    screenshots = pick(join(home, 'OneDrive', 'Pictures', 'Screenshots'), join(home, 'Pictures', 'Screenshots'))
    downloads = pick(join(home, 'OneDrive', 'Downloads'), join(home, 'Downloads'))
  } else if (os === 'darwin') {
    // macOS 預設截圖落在桌面，除非使用者改過 com.apple.screencapture location
    screenshots = join(home, 'Desktop')
    downloads = join(home, 'Downloads')
  } else {
    screenshots = join(home, 'Pictures', 'Screenshots')
    downloads = join(home, 'Downloads')
  }
  // watch 是截圖功能的（截圖 + Downloads）；清理只用 downloads，見 CleanupConfig
  return { watch: [screenshots, downloads], filed: join(home, 'Documents', 'Filed'), downloads, screenshots }
}

export function defaults(sys: SysInfo = {}): Config {
  const d = osDefaults(sys.os, sys.home)
  return {
    watch: d.watch,
    filed: d.filed,
    model: { baseUrl: '', name: '', keyEnv: 'CONTEXTBOX_MODEL_KEY' },
    readonly: false,
    pdfPages: 3,
    maxBytes: 20 * 1024 * 1024,
    cleanup: { roots: [d.downloads], screenshots: false },
  }
}

/** ~ 開頭展開成家目錄。Windows 的 %USERPROFILE% 也一起收。 */
export function expand(p: string): string {
  let s = String(p ?? '').trim()
  if (!s) return s
  if (s === '~') s = homedir()
  else if (s.startsWith('~/') || s.startsWith('~\\')) s = join(homedir(), s.slice(2))
  // 用函式型替換：家目錄裡有 $& 的話，字串型替換會把它當成特殊語法展開
  s = s.replace(/%USERPROFILE%/gi, () => homedir())
  return isAbsolute(s) ? resolve(s) : resolve(homedir(), s)
}

/**
 * 解析成真路徑。資料夾不存在就回展開後的絕對路徑（不要在這裡建資料夾——
 * 使用者可能只是設定檔裡留了一個之後才會用的路徑）。
 */
function realOrAbs(p: string): string {
  const abs = expand(p)
  try { return realpathSync(abs) } catch { return abs }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** 數字欄位：超出合理範圍就退回預設值並出聲，不要安靜夾擠 */
function ranged(v: unknown, lo: number, hi: number, dflt: number, name: string, problems: string[]): number {
  if (v === undefined) return dflt
  if (!isNum(v) || v < lo || v > hi) {
    problems.push(`${name} 設成 ${JSON.stringify(v)} 不合理（要在 ${lo} 到 ${hi} 之間），改用預設值 ${dflt}。`)
    return dflt
  }
  return Math.floor(v)
}

/**
 * 唯讀是**安全開關**，所以型別寫錯要倒向安全那一邊。
 * 數字欄位壞掉會退回預設值並出聲，這個以前什麼都不做，
 * 而且退回的方向是「把保護關掉」—— readonly:"true" 靜靜變成 false。
 */
function readonlyOf(v: unknown, problems: string[]): boolean {
  if (process.env.CONTEXTBOX_READONLY === '1') return true
  if (v === undefined || typeof v === 'boolean') return v === true
  problems.push(`readonly 要寫 true 或 false（你寫的是 ${JSON.stringify(v)}）。`
    + '這是安全開關，看不懂的時候一律當成開著。')
  return true
}

/** 歸檔資料夾不能是家目錄本身、檔案系統根目錄，也不能踩到黑名單 */
function filedProblem(filed: string): string | null {
  const home = realOrAbs(homedir())
  if (filed === home) return '歸檔資料夾不能直接就是家目錄'
  if (resolve(filed) === resolve('/') || /^[A-Za-z]:[\\/]?$/.test(filed)) return '歸檔資料夾不能是磁碟根目錄'
  const segs = filed.split(/[\\/]+/).filter(Boolean).map(s => s.toLowerCase())
  const hit = segs.find(s => DENY_DIRS.some(bad => s === bad || s.startsWith(bad + '.')))
  return hit ? `歸檔資料夾的路徑裡有 ${hit}，那種地方不能放東西` : null
}

/**
 * 清理根目錄能不能用。回 null 代表可以，否則回原因（不帶「清理資料夾」以外的主詞）。
 *
 * 清理會**搬檔**，所以範圍要比截圖的 watch 嚴：
 * - 磁碟根目錄、家目錄本身、**家目錄的任何上一層**（/home、/Users、C:\Users）都不行 ——
 *   上一版只擋家目錄本身，寫 `/home` 就照收，清理範圍一下子擴到整個家目錄（還有別人的）。
 * - 路徑上有金鑰資料夾（.ssh、credentials…）也不行。
 * - **Windows 不分大小寫**：`c:\users`、`C:\USERS\alice` 跟 `C:\Users\Alice` 是同一個地方。
 *   macOS 預設的檔案系統也不分大小寫，一起摺。
 *
 * `sys` 給測試換作業系統與家目錄用；路徑的規則跟著 sys.os 走（win32 用反斜線與磁碟機代號）。
 */
export function cleanupRootProblem(root: string, sys: SysInfo = {}): string | null {
  const os = sys.os ?? platform()
  const P = os === 'win32' ? win32 : posix
  const fold = (x: string) => (os === 'win32' || os === 'darwin') ? x.toLowerCase() : x
  const homeRaw = sys.home ?? homedir()
  // 家目錄本身可能是捷徑（macOS 的 /var → /private/var 那一類）；只有同一個作業系統才解得開
  const homeReal = os === platform() ? realOrAbs(homeRaw) : homeRaw
  const r = fold(P.resolve(root))
  if (r === fold(P.parse(r).root)) return '清理資料夾不能是磁碟根目錄'
  for (const h of new Set([homeRaw, homeReal])) {
    const home = fold(P.resolve(h))
    if (r === home) return '清理資料夾不能直接就是家目錄'
    const rel = P.relative(r, home)
    if (rel && rel !== '..' && !rel.startsWith('..' + P.sep) && !P.isAbsolute(rel)) {
      return '清理資料夾不能是家目錄的上層（那樣會清到整個家目錄）'
    }
  }
  const segs = r.split(/[\\/]+/).filter(Boolean).map(x => x.toLowerCase())
  const hit = segs.find(x => DENY_DIRS.some(bad => x === bad || x.startsWith(bad + '.')))
  return hit ? `清理資料夾的路徑裡有 ${hit}，那種地方不能碰` : null
}

/**
 * 這個主機名字是不是「自己家裡」。
 *
 * 明文 http 的判準不是「有沒有加密」，是**會不會離開你的網路**。
 * 家裡的叢集、Tailscale 的 100.64/10、docker 網段，明文本來就是常態；
 * 明文打到網際網路上的主機才是那條會把金鑰送出去的路。
 */
export function isPrivateHost(hostname: string): boolean {
  const h = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.internal')) return true
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 127 || a === 10) return true                      // loopback、RFC1918
    if (a === 192 && b === 168) return true                     // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true            // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true           // CGNAT：Tailscale 用這一段
    if (a === 169 && b === 254) return true                     // link-local
    return false
  }
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true                 // IPv6 ULA
  if (/^fe80:/.test(h)) return true                             // IPv6 link-local
  return false
}

/**
 * 模型端點：https 到哪裡都行；明文 http 只准打自己家裡的位址。
 * 不然設定檔就變成一條「把金鑰送到任意主機」的路。
 */
function checkBaseUrl(raw: string, problems: string[]): string {
  if (!raw) return ''
  let u: URL
  try { u = new URL(raw) }
  catch { problems.push(`模型網址 ${raw} 看不懂，已經忽略。`); return '' }
  if (u.protocol === 'https:' || (u.protocol === 'http:' && isPrivateHost(u.hostname))) {
    if (u.username || u.password) {
      problems.push('模型網址裡不要放帳號密碼，已經拿掉。金鑰請放環境變數。')
      u.username = ''; u.password = ''
    }
    return u.toString().replace(/\/+$/, '')
  }
  problems.push(`模型網址 ${u.protocol}//${u.hostname} 不安全`
    + `（明文 http 只能打自己內網的位址，打外面的主機請用 https），已經忽略。`)
  return ''
}

/**
 * 把讀進來的東西弄成一份可用的設定。壞掉的欄位一律退回預設值，
 * 不丟例外 —— 設定檔手改壞了不該讓整個服務起不來。
 * 回 { config, problems }，problems 給健康列顯示。
 */
export function normalize(raw: unknown, sys: SysInfo = {}): { config: Config; problems: string[] } {
  const d = defaults(sys)
  const shots = osDefaults(sys.os, sys.home).screenshots
  const problems: string[] = []
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}

  let watch = Array.isArray(o.watch)
    ? o.watch.filter(x => typeof x === 'string' && x.trim()).map(x => realOrAbs(x as string))
    : []
  if (!watch.length) {
    if (o.watch !== undefined) problems.push('watch 設定看不懂，改用這台機器的預設資料夾。')
    watch = d.watch.map(realOrAbs)
  }
  // 去重：同一個資料夾寫兩次會讓 watcher 送兩份一樣的事件
  watch = [...new Set(watch)]
  // watch 也要套同一套檢查。以前只有 filed 擋家目錄與根目錄，
  // normalize({ watch: ['/'] }) 是原封不動收下、零警告的。
  for (const w of watch) {
    const wp = filedProblem(w)
    if (wp) problems.push(`監看資料夾 ${w}：${wp.replace('歸檔資料夾', '監看資料夾')}。範圍請縮小一點。`)
  }

  let filed = typeof o.filed === 'string' && o.filed.trim() ? realOrAbs(o.filed) : realOrAbs(d.filed)
  const fp = filedProblem(filed)
  if (fp) { problems.push(`${fp}，改用預設的 ${d.filed}。`); filed = realOrAbs(d.filed) }

  // filed 落在 watch 底下：**不要動 watch。**
  // 以前這裡把整個 watch root 移除，結果設 filed=~/Downloads/Filed（很自然的設法）
  // 就會讓 ~/Downloads 整個不看了，而訊息說的是另一回事。
  // admit() 本來就有 exclude，重掃迴圈本來就擋住了。
  if (watch.some(w => filed === w || under(w, filed))) {
    problems.push(`歸檔資料夾 ${filed} 在監看資料夾底下。已經自動把它排除，搬過去的檔案不會被重新掃到。`)
  }
  // 反過來：watch 落在 filed 底下 —— 那個 root 會被 exclude 整個吃掉，等於白看
  const swallowed = watch.filter(w => under(filed, w) || w === filed)
  if (swallowed.length) {
    problems.push(`監看資料夾 ${swallowed.join('、')} 在歸檔資料夾底下，會被整個排除掉，等於沒在看。請把它們分開。`)
  }

  const m = (o.model && typeof o.model === 'object') ? o.model as Record<string, unknown> : {}
  let keyEnv = typeof m.keyEnv === 'string' ? m.keyEnv.trim() : ''
  if (keyEnv && !KEY_ENV_OK.test(keyEnv)) {
    problems.push(`金鑰的環境變數名稱只能是 CONTEXTBOX_ 開頭（你寫的是 ${keyEnv}），改用 ${d.model.keyEnv}。`)
    keyEnv = ''
  }
  const model: ModelConfig = {
    baseUrl: checkBaseUrl(typeof m.baseUrl === 'string' ? m.baseUrl.trim() : '', problems),
    name: typeof m.name === 'string' ? m.name.trim() : '',
    keyEnv: keyEnv || d.model.keyEnv,
  }

  return {
    config: {
      watch, filed, model,
      readonly: readonlyOf(o.readonly, problems),
      pdfPages: ranged(o.pdfPages, 1, 10, d.pdfPages, 'pdfPages', problems),
      maxBytes: ranged(o.maxBytes, 1024, 200 * 1024 * 1024, d.maxBytes, 'maxBytes', problems),
      cleanup: cleanupOf(o.cleanup, d.cleanup.roots, shots, problems, sys),
    },
    problems,
  }
}

/**
 * 清理範圍。**這是會搬檔的範圍，所以每一個看不懂的地方都倒向「範圍小」那一邊。**
 *
 * - 沒寫 → 只有 Downloads
 * - roots 裡指到磁碟根目錄、家目錄或它的上層、金鑰資料夾的 → **拿掉**並出聲（見 cleanupRootProblem）
 *   （watch 那邊只警告不拿掉，因為看不會動到檔案；這裡會搬檔，不可以照收）
 * - roots 全部不能用 → 退回 Downloads
 * - screenshots 不是布林 → 當成 false（多清一個資料夾是擴大範圍，不可以因為打錯字就開）
 */
function cleanupOf(v: unknown, dfltRoots: string[], screenshotsDir: string, problems: string[], sys: SysInfo): CleanupConfig {
  const fallback = () => dfltRoots.map(realOrAbs)
  let c: Record<string, unknown> = {}
  if (v !== undefined) {
    if (v && typeof v === 'object' && !Array.isArray(v)) c = v as Record<string, unknown>
    else problems.push('cleanup 設定看不懂，清理範圍改用預設（只有 Downloads）。')
  }

  let screenshots = false
  if (c.screenshots !== undefined) {
    if (typeof c.screenshots === 'boolean') screenshots = c.screenshots
    else problems.push(`cleanup.screenshots 要寫 true 或 false（你寫的是 ${JSON.stringify(c.screenshots)}）。`
      + '看不懂的時候一律當成關著，只清 Downloads。')
  }

  let roots: string[]
  if (c.roots === undefined) roots = fallback()
  else {
    roots = Array.isArray(c.roots)
      ? c.roots.filter(x => typeof x === 'string' && x.trim()).map(x => realOrAbs(x as string))
      : []
    roots = roots.filter(r => {
      const p = cleanupRootProblem(r, sys)
      if (p) problems.push(`清理資料夾 ${r}：${p}，已經從清理範圍拿掉。`)
      return !p
    })
    if (!roots.length) {
      problems.push('cleanup.roots 看不懂或全部不能用，清理範圍改用預設（只有 Downloads）。')
      roots = fallback()
    }
  }
  if (screenshots) roots.push(realOrAbs(screenshotsDir))
  return { roots: [...new Set(roots)], screenshots }
}

export type Loaded = { config: Config; problems: string[]; path: string; created: boolean }

/** 讀設定。沒有檔案就寫一份預設的出來，並如實回報有沒有寫成功。 */
export function load(path: string = CONFIG_PATH): Loaded {
  let raw: unknown = {}
  const problems: string[] = []
  let created = false

  if (existsSync(path)) {
    try { raw = JSON.parse(readFileSync(path, 'utf8')) }
    catch (e: any) { problems.push(`設定檔讀不懂（${e.message}），這次先用預設值，檔案沒有被覆蓋。`) }
  } else {
    try {
      mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
      writeFileSync(path, JSON.stringify(defaults(), null, 2) + '\n', { mode: 0o600 })
      created = true
    } catch (e: any) {
      // 以前這裡安靜吞掉，結果 doctor 會謊報「剛剛幫你建了一份」
      problems.push(`設定檔寫不出來（${e.message}），這次用預設值跑，你的設定不會被保存。`)
    }
  }
  const n = normalize(raw)
  return { config: n.config, problems: [...problems, ...n.problems], path, created }
}

/** 模型金鑰。沒設就是空字串 —— 呼叫端要自己判斷這代表「還沒接模型」。 */
export const modelKey = (c: Config): string => String(process.env[c.model.keyEnv] ?? '').trim()

/** 模型這條線準備好了嗎 */
export const modelReady = (c: Config): boolean => Boolean(c.model.baseUrl && c.model.name)
