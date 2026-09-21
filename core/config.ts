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
import { DEFAULT_PROTECT_DAYS } from './cleanup-rules.ts'
import { homedir, platform } from 'node:os'
import {
  join,
  resolve,
  relative,
  sep,
  isAbsolute,
  posix,
  win32,
} from 'node:path'
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
  /**
   * 清理掃描與搬移的根目錄。預設只有 Downloads —— Windows 是 %USERPROFILE%\Downloads，
   * **不是** OneDrive\Downloads（第二輪 R2-11）：從 OneDrive 同步資料夾搬進隔離區，等於在雲端與所有裝置上刪掉。
   */
  roots: string[]
  /**
   * true 才把截圖資料夾加進清理範圍（給之後的連拍功能用）。看不懂一律當成 false。
   * **那個資料夾底下只清截圖**（見 screenshotsDir）。
   */
  screenshots: boolean
  /**
   * screenshots 開著時是截圖資料夾的真路徑，關著是 null（第二輪 R2-8）。**算出來的，不讀設定檔。**
   * 清單、徽章、預設清理、建計畫在這底下只收截圖類的候選（cleanup-routes.ts 的 SCREENSHOT_KINDS）——
   * macOS 的截圖資料夾**就是桌面**，套全部規則的話，桌面上的舊 zip、安裝檔都會被預設勾走。
   */
  screenshotsDir: string | null
  /**
   * 幾天內動過的檔一律不提議（預設 14）。
   *
   * **取代了保護副檔名清單**（2026-09-21）。以前 .pdf／.docx／.txt 永遠不會是
   * old-download 候選，但那擋掉的正是使用者最想處理的那一批（491 天沒動的 PDF
   * 從來不上清單）。改成用時間保護：最近還在用的不碰，其餘由使用者自己決定。
   *
   * 想回到以前那種保守程度就把它調大（90 天差不多等於舊行為的量）。
   */
  protectDays: number
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
  let screenshots: string, watchDownloads: string
  // **清理的 Downloads 一律是家目錄底下那一個**（第二輪 R2-11）。以前 Windows 先挑 OneDrive\Downloads：
  // 已知資料夾移轉預設不含 Downloads，那個資料夾多半是使用者自己同步的 —— 從那裡搬進隔離區，
  // 等於在雲端與所有裝置上刪掉；只存在雲端的檔，掃描算指紋時還會整個下載回來。
  // 不存在也不改挑別的：/health 的 rootsMissing 會講，使用者自己改 cleanup.roots。
  const downloads = join(home, 'Downloads')
  if (os === 'win32') {
    screenshots = pick(join(home, 'OneDrive', 'Pictures', 'Screenshots'), join(home, 'Pictures', 'Screenshots'))
    // 截圖功能的 watch 照舊：只看不搬，OneDrive 那個存在就看它
    watchDownloads = pick(join(home, 'OneDrive', 'Downloads'), downloads)
  } else if (os === 'darwin') {
    // macOS 預設截圖落在桌面，除非使用者改過 com.apple.screencapture location
    screenshots = join(home, 'Desktop')
    watchDownloads = downloads
  } else {
    screenshots = join(home, 'Pictures', 'Screenshots')
    watchDownloads = downloads
  }
  // watch 是截圖功能的（截圖 + Downloads）；清理只用 downloads，見 CleanupConfig
  return { watch: [screenshots, watchDownloads], filed: join(home, 'Documents', 'Filed'), downloads, screenshots }
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
    cleanup: { roots: [d.downloads], screenshots: false, screenshotsDir: null, protectDays: DEFAULT_PROTECT_DAYS },
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
    problems.push(`${name} is set to ${JSON.stringify(v)}, which makes no sense (it must be between ${lo} and ${hi}). Using the default ${dflt}.`)
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
  if (process.env.CONTEXTBOX_READONLY === '1') {
    // 環境變數贏過檔案。以前這裡直接 return true 而且一句話都不講 —— 2026-09-20 稽核：
    // 面板把唯讀的打勾取消、存檔成功、印「Read-only mode. It is in effect now.」，
    // 而唯讀其實還開著，下一次清理照樣什麼都不做，沒有任何一句話說得出為什麼。
    // 只有檔案**明講** false 才算衝突；沒寫、或本來就是 true，就不用囉嗦。
    if (v === false) {
      problems.push('CONTEXTBOX_READONLY=1 in the environment keeps read-only on, so the readonly setting in the config file has no effect. '
        + 'Unset that environment variable to be able to turn read-only off.')
    }
    return true
  }
  if (v === undefined || typeof v === 'boolean') return v === true
  problems.push(`readonly must be true or false (you wrote ${JSON.stringify(v)}). `
    + 'It is a safety switch, so anything unreadable counts as on.')
  return true
}

/** 歸檔資料夾不能是家目錄本身、檔案系統根目錄，也不能踩到黑名單 */
function filedProblem(filed: string): string | null {
  const home = realOrAbs(homedir())
  if (filed === home) return 'the filed folder cannot be the home directory itself'
  if (resolve(filed) === resolve('/') || /^[A-Za-z]:[\\/]?$/.test(filed)) return 'the filed folder cannot be a disk root'
  const segs = filed.split(/[\\/]+/).filter(Boolean).map(s => s.toLowerCase())
  const hit = segs.find(s => DENY_DIRS.some(bad => s === bad || s.startsWith(bad + '.')))
  return hit ? `the filed folder's path contains ${hit}, and nothing may be put in a place like that` : null
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
  const homeRaw = canonicalPath(sys.home ?? homedir(), os)
  // 家目錄本身可能是捷徑（macOS 的 /var → /private/var 那一類）；只有同一個作業系統才解得開
  const homeReal = os === platform() ? realOrAbs(homeRaw) : homeRaw
  // **先換回一般寫法再比**（第二輪 R2-11）：\\?\C:\Users\alice、\\localhost\C$\Users\alice、
  // macOS 的 /System/Volumes/Data/Users/alice 都是家目錄，以前全部放行（稽核 C-e11）
  const r = fold(P.resolve(canonicalPath(root, os)))
  if (r === fold(P.parse(r).root)) return 'a cleanup folder cannot be a disk root'
  for (const h of new Set([homeRaw, homeReal])) {
    const home = fold(P.resolve(h))
    if (r === home) return 'a cleanup folder cannot be the home directory itself'
    const rel = P.relative(r, home)
    if (rel && rel !== '..' && !rel.startsWith('..' + P.sep) && !P.isAbsolute(rel)) {
      return 'a cleanup folder cannot sit above the home directory — that would clean the whole home directory'
    }
  }
  const segs = r.split(/[\\/]+/).filter(Boolean).map(x => x.toLowerCase())
  const hit = segs.find(x => DENY_DIRS.some(bad => x === bad || x.startsWith(bad + '.')))
  return hit ? `a cleanup folder's path contains ${hit}, and a place like that is never touched` : null
}

/**
 * 同一個地方的別種寫法，換回一般寫法（只用來**比對**，存下來的還是使用者寫的那樣）。
 *
 * - Windows：`\\?\` 與 `\\.\` 前綴拿掉（`\\?\UNC\host\share` → `\\host\share`）；
 *   本機的系統分享 `\\localhost\C$\…`、`\\127.0.0.1\C$\…` 換回 `C:\…`
 * - macOS：`/System/Volumes/Data` 開頭的拿掉（firmlink，不是捷徑，realpath 換不掉）
 * 別台機器的分享（`\\server\share`）不動 —— 那不是這台的家目錄。
 */
function canonicalPath(p: string, os: string): string {
  let s = String(p ?? '')
  if (os === 'win32') {
    s = s.replace(/\//g, '\\')
    s = s.replace(/^\\\\[?.]\\UNC\\/i, '\\\\')
    s = s.replace(/^\\\\[?.]\\(?=[A-Za-z]:)/, '')
    const share = /^\\\\(?:localhost|127\.0\.0\.1)\\([A-Za-z])\$(?=\\|$)/i.exec(s)
    if (share) s = `${share[1]}:${s.slice(share[0].length) || '\\'}`
  } else if (os === 'darwin') {
    s = s.replace(/^\/System\/Volumes\/Data(?=\/|$)/i, '') || '/'
  }
  return s
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
  catch {
    // **不回放值**（2026-09-20 稽核）：這一格跟 keyEnv 一樣容易被讀成「把金鑰放這裡」，
    // 而讀不懂的時候這裡原本印的是使用者打的**整串原文** —— 那句話會進 doctor 的終端機輸出、
    // 進面板 400 的 fields、進他截的圖。keyEnv 那一欄在下面 100 行早就只講規則了，這裡跟上。
    // 下游 settings.ts 的 scrub() 是第二層，不是第一層。
    problems.push('The model URL could not be read, so it was ignored. It has not been printed here in case it is a key; '
      + 'model.baseUrl takes an address like https://api.example.com/v1.')
    return ''
  }
  if (u.protocol === 'https:' || (u.protocol === 'http:' && isPrivateHost(u.hostname))) {
    if (u.username || u.password) {
      problems.push('Do not put a username and password in the model URL; they were removed. Put the key in an environment variable.')
      u.username = ''; u.password = ''
    }
    return u.toString().replace(/\/+$/, '')
  }
  problems.push(`The model URL ${u.protocol}//${u.hostname} is not safe`
    + ` (plain http only works for addresses on your own network; use https for anything outside), so it was ignored.`)
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
    ? o.watch
        .filter(x => typeof x === 'string' && x.trim())
        .map(x => expand(x as string))
    : []

  if (!watch.length) {
    if (o.watch !== undefined) {
      problems.push("The watch setting could not be read, so this machine's default folders are used.")
    }
    watch = d.watch.map(expand)
  }

  // config.watch 保留使用者看到的絕對路徑寫法；
  // realpath 只用來判斷兩條路徑實際上是不是同一個地方。
  const seenWatch = new Set<string>()
  watch = watch.filter(w => {
    const real = realOrAbs(w)
    if (seenWatch.has(real)) return false
    seenWatch.add(real)
    return true
  })
  // watch 也要套同一套檢查。以前只有 filed 擋家目錄與根目錄，
  // normalize({ watch: ['/'] }) 是原封不動收下、零警告的。
  for (const w of watch) {
    const wp = filedProblem(w)
    if (wp) problems.push(`Watched folder ${w}: ${wp.replace('the filed folder', 'a watched folder')}. Narrow it down.`)
  }

  let filed = typeof o.filed === 'string' && o.filed.trim() ? realOrAbs(o.filed) : realOrAbs(d.filed)
  const fp = filedProblem(filed)
  if (fp) { problems.push(`${fp}; using the default ${d.filed} instead.`); filed = realOrAbs(d.filed) }

  // filed 落在 watch 底下：**不要動 watch。**
  // 以前這裡把整個 watch root 移除，結果設 filed=~/Downloads/Filed（很自然的設法）
  // 就會讓 ~/Downloads 整個不看了，而訊息說的是另一回事。
  // admit() 本來就有 exclude，重掃迴圈本來就擋住了。
  const realWatch = watch.map(w => ({
    display: w,
    real: realOrAbs(w),
  }))

  // filed 本身可能還不存在。
  // 若它位於某個 watch 底下，就用該 watch 的 realpath + 相對路徑組出
  // 同一套表示法，避免 macOS /var 與 /private/var 混用。
  let realFiled = realOrAbs(filed)

  for (const { display, real } of realWatch) {
    const rel = relative(resolve(display), resolve(filed))
    const inside =
      rel === '' ||
      (rel !== '..' &&
        !rel.startsWith('..' + sep) &&
        !isAbsolute(rel))

    if (inside) {
      realFiled = resolve(real, rel)
      break
    }
  }

  if (realWatch.some(({ real }) => realFiled === real || under(real, realFiled))) {
    problems.push(`The filed folder ${filed} sits inside a watched folder. It was excluded automatically, so files moved there are not picked up again.`)
  }

  // 反過來：watch 落在 filed 底下 —— 那個 root 會被 exclude 整個吃掉，等於白看
  const swallowed = realWatch
    .filter(({ real }) => real === realFiled || under(realFiled, real))
    .map(({ display }) => display)
  if (swallowed.length) {
    problems.push(`Watched folders ${swallowed.join(', ')} sit inside the filed folder, so they get excluded entirely and nothing is watched. Keep them apart.`)
  }

  const m = (o.model && typeof o.model === 'object') ? o.model as Record<string, unknown> : {}
  let keyEnv = typeof m.keyEnv === 'string' ? m.keyEnv.trim() : ''
  if (keyEnv && !KEY_ENV_OK.test(keyEnv)) {
    // **不可以把使用者寫的東西印回去**（2026-09-20，真的發生了）：
    // `keyEnv` 要的是「環境變數的名字」，但這一欄非常容易被讀成「把金鑰放這裡」——
    // 使用者真的貼了金鑰進去，而我們在警告裡把它整串印出來，於是那把金鑰進了終端機、
    // 進了截圖、進了他複製貼上的每一個地方。**這裡永遠只講規則，不回放值。**
    const looksLikeAKey = keyEnv.length > 24 || /[^A-Za-z0-9_]/.test(keyEnv)
    problems.push(looksLikeAKey
      ? `model.keyEnv must be the NAME of an environment variable (something starting with CONTEXTBOX_), not the key itself. `
        + `What you wrote looks like a key — it has not been printed here. `
        + `Put the name in the config file and the key in the environment, then rotate that key: it has been sitting in a plain file. `
        + `Using ${d.model.keyEnv} for now.`
      : `The key's environment variable must start with CONTEXTBOX_; using ${d.model.keyEnv} instead.`)
    keyEnv = ''
  }
  const model: ModelConfig = {
    baseUrl: checkBaseUrl(typeof m.baseUrl === 'string' ? m.baseUrl.trim() : '', problems),
    name: typeof m.name === 'string' ? m.name.trim() : '',
    keyEnv: keyEnv || d.model.keyEnv,
  }

  const cleanup = cleanupOf(o.cleanup, d.cleanup.roots, shots, problems, sys)
  // filed 落在**清理範圍**底下：跟上面那一條對稱，但後果不一樣 ——
  // 清理掃得到 filed，所以歸檔搬進去的檔過一陣子又會被列成清理候選
  // （「整理好的東西不再被提議清理」就不成立了）。一樣不動 roots，只出聲。
  const swallowsFiled = cleanup.roots.filter(r => filed === r || under(r, filed))
  if (swallowsFiled.length) {
    problems.push(`The filed folder ${filed} sits inside the cleanup folders ${swallowsFiled.join(', ')}, so filed files eventually show up as cleanup candidates again. Better to put it outside the cleanup scope.`)
  }

  return {
    config: {
      watch, filed, model,
      readonly: readonlyOf(o.readonly, problems),
      pdfPages: ranged(o.pdfPages, 1, 10, d.pdfPages, 'pdfPages', problems),
      maxBytes: ranged(o.maxBytes, 1024, 200 * 1024 * 1024, d.maxBytes, 'maxBytes', problems),
      cleanup,
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
    else problems.push('The cleanup setting could not be read, so the cleanup scope falls back to the default (Downloads only).')
  }

  // 幾天內動過的不碰。**壞值倒向保守那一邊**（退回預設 14，不可以變成 0）——
  // 0 等於「連今天下載的檔都提議清掉」，那是打錯一個字就會擴大範圍的方向。
  let protectDays = DEFAULT_PROTECT_DAYS
  if (c.protectDays !== undefined) {
    const n = Number(c.protectDays)
    if (Number.isFinite(n) && Number.isInteger(n) && n >= 1 && n <= 3650) protectDays = n
    else problems.push(`cleanup.protectDays must be a whole number of days between 1 and 3650 `
      + `(you wrote ${JSON.stringify(c.protectDays)}), so it falls back to ${DEFAULT_PROTECT_DAYS}.`)
  }

  let screenshots = false
  if (c.screenshots !== undefined) {
    if (typeof c.screenshots === 'boolean') screenshots = c.screenshots
    else problems.push(`cleanup.screenshots must be true or false (you wrote ${JSON.stringify(c.screenshots)}). `
      + 'Anything unreadable counts as off, so only Downloads is cleaned.')
  }

  let roots: string[]
  if (c.roots === undefined) roots = fallback()
  else {
    roots = Array.isArray(c.roots)
      ? c.roots.filter(x => typeof x === 'string' && x.trim()).map(x => realOrAbs(x as string))
      : []
    roots = roots.filter(r => {
      const p = cleanupRootProblem(r, sys)
      if (p) problems.push(`Cleanup folder ${r}: ${p}. It was taken out of the cleanup scope.`)
      return !p
    })
    if (!roots.length) {
      problems.push('cleanup.roots could not be read, or none of it is usable, so the cleanup scope falls back to the default (Downloads only).')
      roots = fallback()
    }
  }
  // 截圖資料夾加進清理範圍，**但那底下只清截圖**（screenshotsDir，第二輪 R2-8）
  const shots = screenshots ? realOrAbs(screenshotsDir) : null
  if (shots) roots.push(shots)
  return { roots: [...new Set(roots)], screenshots, screenshotsDir: shots, protectDays }
}

export type Loaded = { config: Config; problems: string[]; path: string; created: boolean }

/** 讀設定。沒有檔案就寫一份預設的出來，並如實回報有沒有寫成功。 */
export function load(path: string = CONFIG_PATH): Loaded {
  let raw: unknown = {}
  const problems: string[] = []
  let created = false

  if (existsSync(path)) {
    try { raw = JSON.parse(readFileSync(path, 'utf8')) }
    catch (e: any) {
      // 解析錯誤的訊息會附上出錯位置前後約十個位元組的**檔案原文**
      //（`Unexpected token 's', "sk-live-9f"... is not valid JSON`）。設定檔第一行就是金鑰的
      // 時候 —— 貼錯地方、或者存成了 .env 的樣子 —— 那十個位元組就是它，而這些句子
      // doctor／think／watch 都會整段印到終端機上。讀檔錯誤（權限、裝置）講得出原因就好，
      // 那不是檔案內容。
      const why = e instanceof SyntaxError ? 'it is not valid JSON' : e.message
      problems.push(`The config file could not be read (${why}), so defaults are used this time. The file was not overwritten.`)
    }
  } else {
    try {
      mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
      // screenshotsDir 是算出來的（看 screenshots 開關），不寫進檔案 —— 寫了使用者會以為改它有用
      const d = defaults()
      const file = { ...d, cleanup: { roots: d.cleanup.roots, screenshots: d.cleanup.screenshots, protectDays: d.cleanup.protectDays } }
      writeFileSync(path, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 })
      created = true
    } catch (e: any) {
      // 以前這裡安靜吞掉，結果 doctor 會謊報「剛剛幫你建了一份」
      problems.push(`The config file could not be written (${e.message}), so defaults are used this time and your settings are not saved.`)
    }
  }
  const n = normalize(raw)
  return { config: n.config, problems: [...problems, ...n.problems], path, created }
}

/** 模型金鑰。沒設就是空字串 —— 呼叫端要自己判斷這代表「還沒接模型」。 */
export const modelKey = (c: Config): string => String(process.env[c.model.keyEnv] ?? '').trim()

/** 模型這條線準備好了嗎 */
export const modelReady = (c: Config): boolean => Boolean(c.model.baseUrl && c.model.name)
