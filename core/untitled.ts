/**
 * 判斷一個檔名是「沒取名（untitled）」「太籠統（generic）」還是「有意義（named）」。
 *
 * - untitled：明顯是系統、相機、瀏覽器、通訊軟體給的名字，完全不帶內容資訊
 * - generic：只有籠統的字（± 版本號、副本），拿不準，交給模型看內容再判斷
 * - named：其他。使用者自己取的名字不動
 *
 * 會安靜出錯的方向是「把有意義的名字當成沒取名」，那樣會建議使用者改掉自己取的名字。
 * 所以每一條 untitled 規則都是整串比對（^…$）、只認固定格式；拿不準的一律往 generic 或 named 倒。
 * 系統前綴後面能接的只有「時間」或一張寫死的清單（App 名、套件名、相機尾巴），不接受「任何英數字」；
 * 唯一看形狀的是 com 開頭、至少兩個點的 Android 套件名（com 不是一般的字，使用者不會這樣打）。
 *
 * 檔名是不可信的輸入。這裡的正規式都錨定在開頭，量詞之間吃的字元不重疊，
 * 回溯最多是線性的；副本字尾用手寫迴圈從尾巴往前剝，
 * 不用 `(…)+$` 這種對長字串會退化成平方時間的寫法。
 */

export type NameState = 'untitled' | 'generic' | 'named'
export type NameClass = { state: NameState; reason: string }

export class UntitledError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'UntitledError'
    this.code = code
  }
}

/**
 * 輸入長度上限（UTF-16 單位）。真的檔名最多 255 個字元，
 * 這個上限只是擋住惡意的超長字串（NFKC 最多會把字串撐大 18 倍）吃光記憶體。
 */
export const MAX_NAME_INPUT_LENGTH = 131_072

const REASON = {
  empty: '檔名是空的',
  symbols: '只有符號，沒有任何文字或數字',
  temp: 'Office 或系統自動產生的暫存檔，不是要取名的檔案，不要改名',
  untitledWord: '程式預設的「未命名」',
  windowsNew: 'Windows 右鍵新增的預設名',
  office: 'Office 等程式預設的檔名',
  screenshot: '截圖或螢幕錄影的預設名，只有時間',
  scan: '掃描器預設的檔名',
  messenger: '通訊軟體存下來的預設名',
  line: 'LINE 存下來的預設名',
  camera: '相機預設的檔名',
  recording: '錄音或會議錄影程式預設的檔名，只有時間或編號',
  browser: '瀏覽器或程式下載時的預設名',
  uuid: 'UUID，系統產生的亂碼',
  hash: '雜湊值，系統產生的亂碼',
  digits: '只有數字',
  generic: '只有籠統的字（像「報告」「final」或版本號），看不出內容',
  extWord: '去掉副檔名是系統預設名，但副檔名剛好也是英文字（像 .key、.log），可能是使用者打的字，拿不準',
  emoji: '只有表情符號，看不出內容',
  named: '有可以辨認的內容',
}

// ───────────────────────── 正規化 ─────────────────────────

/** 取最後一段（容許呼叫端傳整條路徑）→ NFKC → 空白統一 → 去掉看不見的字元 → 小寫。 */
function normalizeName(filename: string): string {
  const cut = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'))
  const base = cut >= 0 ? filename.slice(cut + 1) : filename
  return base
    .normalize('NFKC')
    // 只換「不是半形空白的空白」：NFKC 可能把字串撐大 18 倍、裡面全是半形空白，逐一換成自己很慢
    .replace(/[^\S ]/gu, ' ')
    // 零寬字元、雙向控制字元、軟連字號等（Cf）與其他控制字元（Cc）：看不見，不該影響判斷
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/ {2,}/g, ' ')
    .toLowerCase()
}

/** 檢查輸入、正規化、去掉前後空白。classifyName 與 isTempName 共用。 */
function prepare(filename: unknown): string {
  if (typeof filename !== 'string') {
    throw new UntitledError('INVALID_INPUT', '檔名必須是字串')
  }
  if (filename.length > MAX_NAME_INPUT_LENGTH) {
    throw new UntitledError('TOO_LONG', `檔名太長（超過 ${MAX_NAME_INPUT_LENGTH} 個字元），不是合法的檔名`)
  }
  // 前後空白一律去掉：「 .bashrc」要跟「.bashrc」一樣是點開頭的一般檔名，不是「只有副檔名」
  return normalizeName(filename).trim()
}

// ───────────────────────── 暫存檔 ─────────────────────────

const TEMP_PREFIXES = ['~$', '.~lock.', '._']
const TEMP_NAMES = new Set(['.ds_store', 'thumbs.db', 'ehthumbs.db', 'desktop.ini'])

/**
 * Word 開檔時的 `~$` 鎖定檔、LibreOffice 的 `.~lock.…#`、Mac 的 `._` 附屬檔。
 * 這些不是「沒取名」，是程式自己產生、自己會刪的檔；改它的名字只會出事。
 */
function isTempNormalized(name: string): boolean {
  if (TEMP_NAMES.has(name)) return true
  for (const p of TEMP_PREFIXES) if (name.startsWith(p)) return true
  return false
}

/**
 * 是不是 Office 或系統自動產生的暫存檔、鎖定檔（`~$報告.docx`、`.~lock.…#`、`._…`、Thumbs.db）。
 * classifyName 對這些回 named（不建議改名），但 named 也是一般有名字的檔；
 * 要搬檔、清檔的呼叫端請用這個函式判斷要不要跳過，不要去比對中文的 reason。
 * 錯誤跟 classifyName 一樣：不是字串丟 INVALID_INPUT，太長丟 TOO_LONG。
 */
export function isTempName(filename: string): boolean {
  return isTempNormalized(prepare(filename))
}

// ───────────────────────── 副檔名 ─────────────────────────

// 常見副檔名。不在這裡的「副檔名」也會切，但切掉之後判成 untitled 的話會再用整個名字判一次
// （「Untitled.Algebra」的 Algebra 可能是使用者的字）。在這裡、但也是英文字的，見 WORD_EXT。
const KNOWN_EXT = new Set([
  // 文件
  'pdf', 'doc', 'docx', 'docm', 'dot', 'dotx', 'xls', 'xlsx', 'xlsm', 'xlsb', 'xltx', 'ppt', 'pptx', 'pptm',
  'pps', 'ppsx', 'potx', 'odt', 'ods', 'odp', 'odg', 'rtf', 'txt', 'md', 'csv', 'tsv',
  'key', 'pages', 'numbers', 'epub', 'mobi', 'azw3', 'djvu', 'xps', 'oxps', 'hwp', 'wps', 'one', 'vsdx',
  'tex', 'bib', 'html', 'htm', 'mht', 'mhtml', 'json', 'xml', 'yaml', 'yml', 'log',
  // 影像
  'jpg', 'jpeg', 'jfif', 'png', 'gif', 'heic', 'heif', 'webp', 'avif', 'bmp', 'tif', 'tiff', 'svg', 'ico',
  'psd', 'ai', 'eps', 'xcf', 'kra', 'sketch', 'fig', 'xd', 'drawio', 'excalidraw', 'xmind',
  'arw', 'cr2', 'cr3', 'nef', 'dng', 'raf', 'orf', 'rw2', 'aae',
  // 影音、字幕
  'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'wmv', 'flv', '3gp', 'mts', 'm2ts',
  'mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'opus', 'wma', 'amr', 'srt', 'vtt',
  // 壓縮、安裝檔
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'dmg', 'pkg', 'iso', 'exe', 'msi', 'apk', 'ipa',
  'deb', 'rpm', 'jar',
  // 程式與筆記本
  'ipynb', 'py', 'js', 'mjs', 'ts', 'c', 'cpp', 'h', 'java', 'go', 'rs', 'rb', 'php', 'sh', 'bat', 'ps1',
  'r', 'swift', 'kt', 'sql', 'css',
  // 下載中、暫存、備份
  'crdownload', 'part', 'partial', 'download', 'tmp', 'temp', 'bak',
  // 其他
  'ics', 'vcf', 'eml', 'msg', 'torrent', 'lnk', 'url', 'webloc',
])

// 會包在別的副檔名外面的：下載中、暫存、備份、壓縮。只有外層是這些，才去切第二層
// （「Untitled.pdf.crdownload」「IMG_2041.jpg.part」「Untitled.tar.gz」）。
// 外層是一般副檔名時不切第二層：「IMG_20260917_141203.Java.jpg」的 Java 是使用者的字，不是副檔名。
const WRAPPER_EXT = new Set(['crdownload', 'part', 'partial', 'download', 'tmp', 'temp', 'bak', 'gz', 'bz2', 'xz', 'zst'])

// 常見副檔名裡，剛好也是一般英文字或人名的。沒有副檔名的「Untitled.Java」「Scan.Log」「IMG_2041.Key」，
// 最後那段可能是使用者打的字；但「Untitled.pages」「Untitled-1.ai」也是 Pages、Illustrator 真的預設名。
// 兩種讀法都說得通、拿不準，所以不判 untitled，判 generic 交給模型（見 classifyName）。大小寫一樣不看。
// 格式縮寫（pdf、doc、zip、tar、jar、tiff、md……）不收：幾乎不會是使用者的字。
// 單一字母（c、h、r）也不收：RStudio 存的就是「Untitled.R」。
const WORD_EXT = new Set([
  'ai', 'bat', 'bib', 'deb', 'dot', 'download', 'fig', 'go', 'java', 'key', 'log', 'numbers', 'one',
  'opus', 'pages', 'part', 'partial', 'sketch', 'swift', 'temp', 'tex', 'torrent',
])

const EXT_BODY_RE = /^[a-z0-9]{1,10}$/
const HAS_LETTER_RE = /[a-z]/

/**
 * 副檔名那個點的位置；沒有副檔名回 -1。
 * 副檔名要是 1～10 個英數字、而且至少一個字母：
 * 「Screen Shot … 2.12.03 PM」最後一段是「03 PM」、「hw3.1」最後一段是「1」，都不是副檔名。
 */
function extDot(s: string): number {
  const dot = s.lastIndexOf('.')
  if (dot < 0) return -1
  const ext = s.slice(dot + 1)
  if (!EXT_BODY_RE.test(ext) || !HAS_LETTER_RE.test(ext)) return -1
  return dot
}

/**
 * 切掉的那段有多確定是副檔名：
 * - sure：常見副檔名，而且不是英文字（或根本沒切）
 * - word：常見副檔名，但剛好也是英文字（WORD_EXT）
 * - unknown：不是常見副檔名，多半是使用者的字（「Untitled.Algebra」）
 */
type ExtTrust = 'sure' | 'word' | 'unknown'
type Split = { stem: string; trust: ExtTrust }

function extTrust(ext: string): ExtTrust {
  if (!KNOWN_EXT.has(ext)) return 'unknown'
  return WORD_EXT.has(ext) ? 'word' : 'sure'
}

/**
 * 去掉副檔名。最多去兩層：外層是下載中、暫存、壓縮（WRAPPER_EXT），而且裡面那層是常見副檔名，才切第二層；
 * 這時「兩層副檔名」本身就是證據，確定程度看裡面那層（「Untitled.pdf.part」的 part 雖然是英文字，也是 sure）。
 */
function splitExt(name: string): Split {
  const dot = extDot(name)
  if (dot < 0) return { stem: name, trust: 'sure' }
  const outer = name.slice(dot + 1)
  const trust = extTrust(outer)
  if (dot === 0) {
    // 點開頭：只有「.pdf」這種點後面就是常見副檔名的，才算「只有副檔名、沒有名字」；
    // 「.bashrc」這種是點開頭的一般檔名
    return trust === 'unknown' ? { stem: name, trust: 'sure' } : { stem: '', trust }
  }
  const stem = name.slice(0, dot)
  if (WRAPPER_EXT.has(outer)) {
    const inner = extDot(stem)
    if (inner >= 0) {
      const innerTrust = extTrust(stem.slice(inner + 1))
      if (innerTrust !== 'unknown') return { stem: stem.slice(0, inner), trust: innerTrust }
    }
  }
  return { stem, trust }
}

// ───────────────────────── 副本字尾 ─────────────────────────

// Mac：「 copy」「 copy 2」「 拷貝」「 拷貝 2」；Windows：「 - Copy」「 - 複製」「 - 副本」；
// 瀏覽器與 Windows 的重複編號：「 (2)」「（2）」（NFKC 之後一樣）
const COPY_WORDS = ['copy', '副本', '的副本', '複製', '拷貝', '复制', '拷贝', 'コピー']
// Google 雲端硬碟：「Copy of 報告」
const COPY_PREFIX = 'copy of '

function isSep(ch: string): boolean {
  return ch === ' ' || ch === '_' || ch === '-'
}

function isDigitAt(s: string, i: number): boolean {
  const c = s.charCodeAt(i)
  return c >= 48 && c <= 57
}

/**
 * s[0, end) 的結尾如果是一個副本字尾，回傳剝掉它之後的長度；不是就回 -1。
 * 只剝字尾本身固定帶的分隔符號（「 (2)」的空白、「 - Copy」的「 - 」、「 copy」的空白），
 * 再往前多出來的分隔符號是名字原本就有的：「download_ (1)」剝完是「download_」，跟「download_」同一個判斷。
 */
function copySuffixStart(s: string, end: number): number {
  // 「(數字)」：瀏覽器與 Windows 是「 (2)」，全形括號 NFKC 之後是「(2)」
  if (end >= 3 && s[end - 1] === ')') {
    let j = end - 2
    while (j >= 0 && isDigitAt(s, j)) j--
    if (j < end - 2 && j >= 0 && s[j] === '(') return j > 0 && s[j - 1] === ' ' ? j - 1 : j
  }
  // 副本字，後面可以接「一個空白＋數字」（Mac 的「copy 2」「拷貝 2」）
  let u = end
  let t = end
  while (t > 0 && isDigitAt(s, t - 1)) t--
  if (t < end) u = t > 0 && s[t - 1] === ' ' ? t - 1 : -1
  if (u <= 0) return -1
  for (const w of COPY_WORDS) {
    const w0 = u - w.length
    // 副本字前面一定要有分隔符號：「photocopy」「IMG_2041copy」的 copy 是字的一部分
    if (w0 > 0 && s.startsWith(w, w0) && isSep(s[w0 - 1])) {
      // Windows 的「 - Copy」「 - 複製」整段是字尾；其他只剝緊鄰的那一個分隔符號
      return w0 >= 3 && s.startsWith(' - ', w0 - 3) ? w0 - 3 : w0 - 1
    }
  }
  return -1
}

/**
 * 從尾巴往前一層一層剝副本字尾（「IMG_2041 - Copy (2)」→「IMG_2041」）。
 * 每剝一層字串就變短，所以一定會停；會把整個名字剝光的那一層不剝（「(1)」保持原樣）。
 */
function stripCopySuffixes(stem: string): string {
  // 名字開頭的分隔符號：剝完只剩這些，就等於剝光了（「- 複製」保持原樣）
  let lead = 0
  while (lead < stem.length && isSep(stem[lead])) lead++
  let end = stem.length
  for (;;) {
    const cut = copySuffixStart(stem, end)
    if (cut <= lead) break
    end = cut
  }
  // 前綴「Copy of 」也一層一層剝（「Copy of Copy of …」）；一樣不剝光
  let start = 0
  while (stem.startsWith(COPY_PREFIX, start) && start + COPY_PREFIX.length < end) start += COPY_PREFIX.length
  return stem.slice(start, end)
}

// ───────────────────────── untitled 規則 ─────────────────────────

// 截圖、掃描、通訊軟體的名字，前綴後面只能是「時間」：數字、分隔符號、上午下午等時間字。
// 字元類與字詞的第一個字不重疊，所以 (字詞 字元*)* 的回溯是線性的。
// 英文的時間字後面不可以緊接英文字母：「marat」不是 mar＋at、「atpm」不是 at＋pm。
// 前面不用另外檢查：時間字前面只能是數字、分隔符號、前綴，或另一個時間字（它後面已經不准接字母）；
// 前綴後面也不可以緊接英文字母（「Screenshotat」不是 Screenshot＋at）。
// 月份縮寫只給 Adobe Scan（「Adobe Scan Sep 17, 2026」）：其他截圖、掃描程式不會用月份字，
// 「Screenshot May」「Scan May 2026」的 May 可能是人名或使用者自己標的月份。
const TS_CHARS = '[0-9 ._:,\\-]'
const TS_TIME_WORDS = ['at', 'am', 'pm', '上午', '下午', '中午', '晚上', '凌晨', '早上', '於']
const TS_MONTH_WORDS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const NO_LETTER_NEXT = '(?![a-z])'
function tsRest(words: string[]): string {
  const alts = words.map(w => (/^[a-z]/.test(w) ? `${w}${NO_LETTER_NEXT}` : w)).join('|')
  return `${TS_CHARS}*(?:(?:${alts})${TS_CHARS}*)*`
}
const TS_WORD_CHAR_RE = /[^0-9 ._:,-]/

/** s 裡面有沒有至少 need 個數字（找到就停，長字串也只走一遍）。 */
function hasDigits(s: string, need: number): boolean {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 48 && c <= 57 && ++n >= need) return true
  }
  return false
}

/**
 * 截圖、掃描前綴後面那一段是不是「只有時間」。
 * 只有數字與分隔符號就算（「Scan 2」、剝掉編號後的「Screenshot」）；
 * 有時間字（at、下午、月份）的話，至少要有 4 個數字才像真的時間：「Screenshot at」「Scan May」不算。
 */
function isTimeRest(rest: string): boolean {
  return !TS_WORD_CHAR_RE.test(rest) || hasDigits(rest, 4)
}

/**
 * 通訊軟體的前綴（photo_、video_、signal-）本身就是常見的字，後面一定要是完整的日期時間（至少 8 個數字）：
 * 「photo_2026-09-17_14-12-03」是 Telegram 存的；「photo_3」「Signal-3」（訊號與系統第 3 章）不是。
 */
function isFullTimestamp(rest: string): boolean {
  return hasDigits(rest, 8)
}

/** 用帶一個捕捉群組（前綴後面那一段）的正規式比對，再檢查那一段。 */
function restMatches(re: RegExp, c: string, ok: (rest: string) => boolean): boolean {
  const m = re.exec(c)
  return m !== null && ok(m[1])
}

// 「無題」不收在這裡：在台灣比較常是詩題或作品名（李商隱〈無題〉），單獨一個交給 generic（見 LIBREOFFICE_UNTITLED_RE）
// Notion 匯出沒取名的頁面是「Untitled 」加 32 個 hex 的頁面 ID。
// gedit 的翻譯：Untitled File「無標題檔案」、Untitled Folder「未命名文件夹」、Unsaved Document %d「未儲存文件 %d」
const UNTITLED_WORD_RE = /^(?:(?:untitled|未命名|無標題|无标题)(?: ?(?:document|spreadsheet|presentation|design|diagram|drawing|form|file|folder|project|notebook|文件|文字文件|檔案|試算表|簡報|設計|表單|資料夾|文件夹|筆記本|文檔|文档|表格|演示文稿|繪圖|绘图))?|unsaved document|未儲存文件)(?:[ _-]?[0-9]{1,4}| [0-9a-f]{32})?$/

// LibreOffice 繁中版把 Untitled 翻成「無題」，新文件叫「無題 1」「無題 2」（存檔對話框預設的檔名也是這個）。
// 只認「無題＋一個空白＋1～4 位數編號」這個程式固定產生的形式；「無題」單獨一個、「無題1」「無題-1」都不是
const LIBREOFFICE_UNTITLED_RE = /^無題 [0-9]{1,4}$/

// 比對前把空白拿掉，所以「新增 Microsoft Word 文件」「新增Microsoft Word 文件」都認得
const WINDOWS_NEW = new Set([
  '新增文字文件', '新增microsoftword文件', '新增microsoftexcel工作表', '新增microsoftpowerpoint簡報',
  '新增microsoftaccess資料庫', '新增點陣圖影像', '新增rtf文件', '新增資料夾', '新增壓縮的(zipped)資料夾',
  'newtextdocument', 'newmicrosoftworddocument', 'newmicrosoftexcelworksheet',
  'newmicrosoftpowerpointpresentation', 'newmicrosoftaccessdatabase', 'newbitmapimage',
  'newrichtextdocument', 'newfolder', 'newcompressed(zipped)folder',
  '新建文本文档', '新建microsoftword文档', '新建microsoftexcel工作表', '新建microsoftpowerpoint演示文稿',
  '新建位图图像', '新建文件夹',
])
// 上面最長的一個不到 40 字；超過這個長度就不用去掉空白再查（對超長字串去空白很慢）
const WINDOWS_NEW_MAX_LENGTH = 64

// Document 不帶數字也算（表上「Document (3).pdf」是 untitled，瀏覽器也常存成 document.pdf）；
// Book／Presentation／簡報／活頁簿 要帶數字才是 Office 預設名，單獨一個字只算籠統。
// 數字一定要緊接著：Office 自己產生的是「Document1」「Book1」。
// 「Document 2」「download 2」「image 2」「file 2」（中間有空白）不認：這幾個是一般英文字，
// 「image 2」很可能是「第 2 張圖」，跟 lecture 3 一樣是使用者自己打的編號。
// 相對地，「Untitled 2」「Scan 2」「New Recording 3」「IMG_1234 2」有認，因為前面那段本身就是程式固定產生的
// （TextEdit、影像擷取、語音備忘錄自己就會這樣編號；相機名後面接撞名編號也還是只有編號）。
const OFFICE_RE = /^(?:(?:document|文件|文档)[0-9]{0,4}|(?:book|presentation|publication|drawing|database|活頁簿|簡報|工作簿|演示文稿)[0-9]{1,4})$/

// Windows 7 剪取工具存成 Capture.PNG；Snipaste 存成 Snipaste_2026-09-19_14-12-03。
// gnome-shell 的中文翻譯也在這裡：zh_TW「螢幕快照 %s」「螢幕錄影 %d %t」、zh_CN「截图 %s」「录屏 %d %t」，
// 撞名在時間後面加「-1」，還是只有時間
const SCREENSHOT_RE = new RegExp(
  `^(?:screenshot|screen shot|screen recording|螢幕擷取畫面|螢幕截圖|螢幕快照|螢幕錄影|螢幕錄製|截圖|截图|截屏|屏幕截图|屏幕快照|屏幕录制|录屏|スクリーンショット|capture|snipaste)${NO_LETTER_NEXT}(${tsRest(TS_TIME_WORDS)})$`,
)

// GNOME：gnome-screenshot 存成「Screenshot from 2026-09-19 14-12-03」（撞名是「… - 2」），
// gnome-shell 存成「Screenshot From …」「Screencast From …」（撞名是「…-1」）；
// 舊版 gnome-shell 的螢幕錄影用 12 小時制：「Screencast from 07-17-2013 10:00:46 PM」，所以最後可以接 am／pm。
// gnome-screenshot 的中文翻譯把時間放前面：
// zh_TW「2026-09-19 14-12-03 的螢幕擷圖」（撞名「… 的螢幕擷圖 - 2」）、zh_CN「2026-09-19 14-12-03屏幕截图」。
// GNOME 的預設名一定帶完整的日期時間，所以後面至少要 8 個數字：「Screenshot from」「Screenshot from 1」不算。
const GNOME_SCREENSHOT_RE = /^(?:(?:screenshot|screencast) from( [0-9 ._:-]*(?:[ap]m)?)|([0-9 ._:-]+)的?(?:螢幕擷圖|屏幕截图)(?: - [0-9]{1,3})?)$/

function isGnomeScreenshot(c: string): boolean {
  const m = GNOME_SCREENSHOT_RE.exec(c)
  return m !== null && isFullTimestamp(m[1] ?? m[2])
}

// Android：Screenshot_20260917-141203_Chrome、小米 Screenshot_2026-09-17-14-12-03-123_com.android.chrome。
// 最後那段是系統加的 App 名。只認下面三種，其他一律當成使用者自己加的字
// （「_midterm」「_hw3」「_bug.report」「_me.and.mom」「_us.history」都是 named）：
// - 寫死的常見 App 顯示名（Samsung 用顯示名）
// - com 開頭的套件名：至少兩個點（三段），每段都是英文字母開頭的英數字、不是 Java 保留字
// - 寫死的套件名：只有一個點的（com.whatsapp），以及 com 以外開頭的（jp.naver.line.android……）
// com 以外的開頭（me、us、co、de、tv、io、app、net、org、jp、tw……）本身就是英文字或常見縮寫，
// 「me.and.mom」「org.chart.draft」「jp.trip.day1」跟真的套件名長得一樣、分不出來，所以只認清單。
const ANDROID_APP_LABELS = new Set([
  'chrome', 'samsung internet', 'firefox', 'edge', 'line', 'instagram', 'facebook', 'messenger', 'whatsapp',
  'telegram', 'discord', 'wechat', 'kakaotalk', 'youtube', 'tiktok', 'threads', 'twitter', 'x', 'reddit',
  'snapchat', 'pinterest', 'linkedin', 'gmail', 'outlook', 'google', 'maps', 'google maps', 'photos',
  'google photos', 'gallery', 'camera', 'settings', 'one ui home', 'messages', 'phone', 'contacts', 'calendar',
  'clock', 'my files', 'drive', 'classroom', 'teams', 'zoom', 'slack', 'spotify', 'netflix', 'dcard', 'shopee',
])
const KNOWN_PACKAGES = new Set([
  'com.whatsapp', 'com.discord', 'com.pinterest', 'com.tinder', 'com.duolingo',
  'jp.naver.line.android', 'org.telegram.messenger', 'org.mozilla.firefox', 'org.thoughtcrime.securesms',
  'org.wikipedia', 'org.videolan.vlc', 'tv.twitch.android.app', 'tv.danmaku.bili', 'us.zoom.videomeetings',
  'cn.wps.moffice_eng',
])
// Java 的保留字與字面值不能當套件名的一段（「com.new.final」不是套件名）
const JAVA_KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue',
  'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if',
  'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private',
  'protected', 'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this',
  'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null',
])
// Android 規定套件名每一段都要以英文字母開頭。底線雖然合法，形狀判斷不收：
// 使用者最常用底線把自己的字接在系統名後面（「…_com.android.chrome_midterm」），
// 真的套件名很少用底線（Java 的命名慣例），真的帶底線的放進 KNOWN_PACKAGES（cn.wps.moffice_eng）
const PACKAGE_SEGMENT_RE = /^[a-z][a-z0-9]{0,39}$/
const MAX_PACKAGE_SEGMENTS = 8

function isComPackage(s: string): boolean {
  // 不另外擋長度：超長的字串切出來段數一定超過上限，split 是線性的（13 萬字元約 1～2 ms）
  if (!s.startsWith('com.')) return false
  const parts = s.split('.')
  if (parts.length < 3 || parts.length > MAX_PACKAGE_SEGMENTS) return false
  for (const p of parts) if (!PACKAGE_SEGMENT_RE.test(p) || JAVA_KEYWORDS.has(p)) return false
  return true
}

// 只認「時間＋系統加的 App 名」。沒有 App 名的（Screenshot_20260917-141203、小米的 …-14-12-03-123）
// 前綴後面只有數字與分隔符號，交給 SCREENSHOT_RE，這裡不重複
const ANDROID_SCREENSHOT_RE = /^screenshot_(?:[0-9]{8}[-_][0-9]{6}|[0-9]{4}(?:-[0-9]{2}){5}(?:-[0-9]{1,3})?)_(.+)$/

function isAndroidScreenshot(c: string): boolean {
  const m = ANDROID_SCREENSHOT_RE.exec(c)
  if (m === null) return false
  const app = m[1]
  return ANDROID_APP_LABELS.has(app) || KNOWN_PACKAGES.has(app) || isComPackage(app)
}

// Mac 的「影像擷取」會存成 Scan.jpeg、Scan 1.jpeg，所以前綴單獨出現也算
const SCAN_RE = new RegExp(
  `^(?:scanned document|scanned image|scanned|scan|掃描文件|掃描檔|掃描|扫描件|扫描|camscanner)${NO_LETTER_NEXT}(${tsRest(TS_TIME_WORDS)})$`,
)
// Adobe Scan 存成「Adobe Scan Sep 17, 2026」「Adobe Scan 17 Sep 2026」：只有它會帶月份字
const ADOBE_SCAN_RE = new RegExp(
  `^adobe scan${NO_LETTER_NEXT}(${tsRest([...TS_TIME_WORDS, ...TS_MONTH_WORDS])})$`,
)

// 通訊軟體前綴後面一定要是完整的日期時間（光是「WhatsApp」「signal」「photo_3」可能是使用者自己取的）
// WhatsApp 新版會在最後加「_8 碼 hex」。只有字母結尾的前綴要檢查後面不緊接字母（「WhatsApp Imageat」），
// photo_、signal- 這種本身以分隔符號結尾的不用
const MESSENGER_PREFIX_RE = new RegExp(
  `^(?:whatsapp (?:image|video|audio|ptt|document|sticker)${NO_LETTER_NEXT}|photo_|video_|signal-|telegram )(${tsRest(TS_TIME_WORDS)})(?:_[0-9a-f]{8})?$`,
)
const MESSENGER_OTHER_RE = /^(?:(?:img|vid|aud|ptt|doc|stk)-[0-9]{8}-wa[0-9]{3,}|fb_img_[0-9]{10,}|received_[0-9]{8,}|mmexport[0-9]{10,}|微信(?:图片|圖片)_[0-9]{8,}(?:_[0-9]{1,6})?)$/
const HAS_DIGIT_RE = /[0-9]/

// LINE：聊天室存下來的照片 S__12345678（台灣最常見）、messageImage_<毫秒>、LINE_P<日期>_<時間>。
// 「LINE_」後面至少 6 個數字才算，「Line_1」可能是「第 1 條線」。
// LINE 相簿：LINE_ALBUM_<相簿名>_<yymmdd>_<n>。相簿名是日期（預設）才算；
// 人取的相簿名（「畢業旅行」）是有意義的資訊，不算沒取名
const LINE_RE = /^(?:messageimage_[0-9]{6,}|line_album_[0-9 ._-]*|line_(?:p|movie|video|voice)?_?[0-9]{6}[0-9_]*|s__[0-9]{6,}(?:_[0-9]{1,3})?)$/

// 相機：iPhone IMG_2041／IMG_E2041、Android IMG_20260917_141203、Pixel PXL_…、
// Sony DSC01234、Nikon DSCN／DSC_、Fuji DSCF、Canon _MG_、Panasonic P1000123、GoPro、DJI；
// Mac 存檔撞名會變成「IMG_1234 2」。
// 英文尾巴（.MP、_HDR、.PORTRAIT、_BURST001）只有 Android／Pixel 會加，而且一定接在完整的日期時間後面；
// iPhone 那種短編號後面接英文字（「IMG_2041_night」「IMG_2041_cover」）是使用者加的，是 named。
// 例外是 Google 相簿匯出的「-edited」。
// Pixel 同時存 RAW 時是「PXL_….RAW-01.MP.COVER.jpg」「PXL_….RAW-02.ORIGINAL.dng」。尾巴最多 3 個。
const CAMERA_TAIL = '(?:mp|hdr|portrait|night|bokeh|cover|original|edited|raw-[0-9]{2}|burst[0-9]{0,4}|[0-9]{1,4})'
const CAMERA_RE = new RegExp(
  '^(?:' +
    `(?:img|vid|pxl|pano|mvimg|burst)[_-][0-9]{8}[_-][0-9]{6,9}(?:[_-][0-9]{1,20}){0,2}(?:[._~-]${CAMERA_TAIL}){0,3}` +
    '|(?:img|vid|pxl|pano|mvimg|burst|mov)[_-]e?[0-9]{3,}(?:[_-][0-9]{1,20}){0,3}(?:[._~-][0-9]{1,4}|-edited)?' +
    '|_?dsc[nf]?_?[0-9]{3,}|_mg_[0-9]{4,}|(?:imgp|cimg|pict|hpim|sam_|dji_)[0-9]{3,}(?:_[0-9]{1,20}){0,3}' +
    '|p[0-9]{7}|gopr[0-9]{4}|g[hxp][0-9]{6}' +
  ')(?: [0-9]{1,3})?$',
)

// 語音備忘錄：New Recording 3、新錄音 3；Zoom 本機錄影：GMT20260919-061203_Recording_1920x1080
const RECORDING_RE = /^(?:(?:new recording|新錄音|新录音)(?: [0-9]{1,4})?|gmt[0-9]{8}-[0-9]{6}(?:_recording(?:_(?:gallery|avo|as|cc))?(?:_[0-9]{3,4}x[0-9]{3,4})?)?)$/

// 「unknown」不收：可能是歌名、作品名，交給 generic
const BROWSER_RE = /^(?:download|下載|下载|file|image|images|unnamed|blob|attachment)[0-9]{0,4}$/

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// 16 個 hex 以上。沒有英文單字只用 a～f 拼到 16 個字母，所以不會誤傷
const HEX_RE = /^[0-9a-f]{16,}$/
const DIGITS_RE = /^[0-9 ._:,+()#~-]+$/

type Rule = { test: (core: string) => boolean; reason: string }

const UNTITLED_RULES: Rule[] = [
  { test: c => UNTITLED_WORD_RE.test(c) || LIBREOFFICE_UNTITLED_RE.test(c), reason: REASON.untitledWord },
  {
    test: c => c.length <= WINDOWS_NEW_MAX_LENGTH && WINDOWS_NEW.has(c.replace(/ /g, '')),
    reason: REASON.windowsNew,
  },
  { test: c => OFFICE_RE.test(c), reason: REASON.office },
  {
    // Android 放第一個：沒有 App 名的名字也會先經過它，所以它對沒有 App 名的處理有測試看得到
    test: c => isAndroidScreenshot(c) || restMatches(SCREENSHOT_RE, c, isTimeRest) || isGnomeScreenshot(c),
    reason: REASON.screenshot,
  },
  {
    test: c => restMatches(SCAN_RE, c, isTimeRest) || restMatches(ADOBE_SCAN_RE, c, isTimeRest),
    reason: REASON.scan,
  },
  {
    test: c => restMatches(MESSENGER_PREFIX_RE, c, isFullTimestamp) || MESSENGER_OTHER_RE.test(c),
    reason: REASON.messenger,
  },
  { test: c => LINE_RE.test(c), reason: REASON.line },
  { test: c => CAMERA_RE.test(c), reason: REASON.camera },
  { test: c => RECORDING_RE.test(c), reason: REASON.recording },
  { test: c => BROWSER_RE.test(c), reason: REASON.browser },
  { test: c => UUID_RE.test(c), reason: REASON.uuid },
  { test: c => DIGITS_RE.test(c) && HAS_DIGIT_RE.test(c), reason: REASON.digits },
  { test: c => HEX_RE.test(c), reason: REASON.hash },
]

// ───────────────────────── generic ─────────────────────────

// 籠統的字：類型名詞與版本、狀態的修飾字。
// 刻意不收「期中」「期末」「第 N 週」「範圍」這種可以辨認的資訊（表上「期中考範圍」是 named）。
const GENERIC_WORDS = [
  'report', 'reports', 'final', 'draft', 'drafts', 'note', 'notes', 'test', 'tests', 'lecture', 'lectures',
  'hw', 'homework', 'assignment', 'assignments', 'slide', 'slides', 'handout', 'handouts', 'summary',
  'essay', 'paper', 'exam', 'quiz', 'resume', 'cv', 'memo', 'doc', 'docs', 'document', 'file', 'image',
  'untitled', 'new', 'old', 'latest', 'revised', 'updated', 'edited', 'fixed', 'copy', 'sample',
  'example', 'template', 'temp', 'tmp', 'misc', 'stuff', 'work', 'project', 'presentation', 'book',
  'data', 'info', 'photo', 'photos', 'picture', 'pic', 'version', 'ver', 'backup', 'bak', 'todo',
  'list', 'form', 'answer', 'answers', 'solution', 'solutions', 'exercise', 'review', 'outline', 'my',
  '報告', '筆記', '講義', '作業', '草稿', '考試', '小考', '測驗', '測試', '最終版', '最終', '終版', '定稿',
  '修正版', '修改版', '新版', '舊版', '最新', '最新版', '完整版', '初稿', '簡報', '活頁簿', '資料', '檔案',
  '文件', '圖片', '照片', '相片', '心得', '範本', '範例', '備份', '副本', '複製', '拷貝', '表單', '清單',
  '履歷', '自傳', '投影片', '作品', '企劃書', '計畫書', '報告書', '說明', '筆記本', '講稿', '解答', '答案',
  '習題', '練習', '重點', '整理', '未命名', '我的', '新', '舊',
  '报告', '笔记', '讲义', '作业', '最终版', '资料', '文档', '图片',
  // 可能是作品名、也可能是沒取名，拿不準：交給模型
  'unknown', '無題',
]

// 以第一個字分組，動態規劃每一格只試少數幾個字
const GENERIC_BY_FIRST = new Map<string, string[]>()
for (const w of GENERIC_WORDS) {
  const list = GENERIC_BY_FIRST.get(w[0])
  if (list) list.push(w)
  else GENERIC_BY_FIRST.set(w[0], [w])
}

const VERSION_RE = /^(?:(?:v|ver|version|rev)\.?[0-9]{1,4}(?:\.[0-9]{1,4}){0,3}[a-z]?|第?[0-9一二三四五六七八九十]{1,3}版|版本[0-9]{1,4})$/
const TOKEN_RE = /[^ _\-,+&()[\]{}]+/g
const MAX_GENERIC_CORE_LENGTH = 256
const MAX_GENERIC_TOKENS = 8
// 中文複合詞裡的版本號（「講義第二版」）：跟 VERSION_RE 的中文部分一樣，但不錨定，從第 i 格開始比
const ZH_VERSION_STICKY_RE = /第[0-9一二三四五六七八九十]{1,3}版|版本[0-9]{1,4}/y

/** 整段字能不能完全由籠統的字（或中文版本號）拼起來（中文沒有空白分詞：「報告最終版」＝報告＋最終版）。 */
function isGenericWordRun(s: string): boolean {
  const reach = new Uint8Array(s.length + 1)
  reach[0] = 1
  for (let i = 0; i < s.length; i++) {
    if (!reach[i]) continue
    const ch = s[i]
    if (ch === '第' || ch === '版') {
      ZH_VERSION_STICKY_RE.lastIndex = i
      const m = ZH_VERSION_STICKY_RE.exec(s)
      if (m) reach[i + m[0].length] = 1
    }
    const candidates = GENERIC_BY_FIRST.get(ch)
    if (!candidates) continue
    for (const w of candidates) if (s.startsWith(w, i)) reach[i + w.length] = 1
  }
  return reach[s.length] === 1
}

/**
 * 每一段都是籠統的字或版本號才算 generic。
 * 數字不算版本號：「lecture3」「HW3」「lecture 3」都是 named（第幾講、第幾次作業是可以辨認的資訊）。
 */
function isGeneric(core: string): boolean {
  // 籠統的名字不會很長；先擋掉，動態規劃的成本就有上限
  if (core.length > MAX_GENERIC_CORE_LENGTH) return false
  let count = 0
  for (const m of core.matchAll(TOKEN_RE)) {
    const part = m[0]
    if (VERSION_RE.test(part)) {
      if (++count > MAX_GENERIC_TOKENS) return false
      continue
    }
    for (const piece of part.split('.')) {
      if (piece === '') continue
      if (++count > MAX_GENERIC_TOKENS) return false
      if (VERSION_RE.test(piece)) continue
      if (!isGenericWordRun(piece)) return false
    }
  }
  return count > 0
}

// ───────────────────────── 對外 ─────────────────────────

const SYMBOLS_ONLY_RE = /^[^\p{L}\p{N}]+$/u
const EMOJI_RE = /\p{Extended_Pictographic}/u

function result(state: NameState, reason: string): NameClass {
  return { state, reason }
}

/**
 * 判斷檔名是 untitled／generic／named。副檔名不算；比對前 NFKC、不分大小寫、去掉前後空白。
 * 傳進整條路徑的話只看最後一段。
 * 暫存鎖定檔（~$報告.docx 等）回 named、不建議改名；要跳過它們請另外用 isTempName。
 */
export function classifyName(filename: string): NameClass {
  const name = prepare(filename)
  if (isTempNormalized(name)) return result('named', REASON.temp)

  const { stem, trust } = splitExt(name)
  const byStem = classifyStem(stem.trim())
  if (byStem.state !== 'untitled' || trust === 'sure') return byStem
  // 去掉副檔名會判成 untitled，但切掉的那段不確定是副檔名：
  // 剛好是英文字的常見副檔名（「Untitled.Java」「Untitled.pages」）兩種讀法都說得通，交給模型；
  if (trust === 'word') return result('generic', REASON.extWord)
  // 不是常見副檔名（「Untitled.Algebra」「IMG_2041.Tokyo」）多半是使用者的字：不切，用整個名字判
  // （「Screenshot … 2.12.03PM」沒有副檔名，整個名字判也還是 untitled）
  return classifyStem(name)
}

function classifyStem(stem: string): NameClass {
  if (stem === '') return result('untitled', REASON.empty)

  const core = stripCopySuffixes(stem)

  if (SYMBOLS_ONLY_RE.test(core)) {
    // 表情符號一定是人打的，但看不出內容；其他符號（「____」常是編碼壞掉的中文檔名）當成沒取名
    return EMOJI_RE.test(core) ? result('generic', REASON.emoji) : result('untitled', REASON.symbols)
  }

  for (const rule of UNTITLED_RULES) {
    if (rule.test(core)) return result('untitled', rule.reason)
  }

  if (isGeneric(core)) return result('generic', REASON.generic)
  return result('named', REASON.named)
}
