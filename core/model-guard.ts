/**
 * 送去模型之前的最後一道關 —— **這一層錯了，使用者的金鑰就離開這台機器了，而且收不回來。**
 *
 * 兩層（預想表第 39 列）：
 *   1. **名字**命中清單（.env、id_rsa、*.key、*.pem、credentials、token、secret、password、錢包⋯⋯）→ 不送
 *   2. **內容**命中高風險樣式（BEGIN PRIVATE KEY、AKIA…、ghp_…、sk-…、身分證字號、信用卡號）→ 不送
 * 另外加一條這個專案自己的保險：內容裡出現**這台機器設定的模型金鑰**就不送（見 screen 的 key）。
 *
 * ── 兩層的分工（為什麼不合成一層）────────────────────────────
 *
 * 預想表舉的那一對就是分工：`id_rsa` 靠**名字**擋（它的內容是 base64，沒有任何一條內容樣式命中得了）；
 * 而 `作業系統_第5章.txt` 裡剛好寫到「password」這個字**要照送** —— 一份講密碼學的講義提到
 * 「password」是正常的，那不是秘密。所以「password」只在**名字**的清單裡，不在內容的樣式裡；
 * 內容那一層只收**真的長得像憑證**的東西。
 *
 * ── 每一條都倒向「不送」────────────────────────────────────
 *
 * 誤擋一份講義的代價是：那個檔不會有模型的意見，使用者自己命名（本來就是預設行為）。
 * 誤送一把金鑰的代價是：金鑰外流。兩邊不對稱，所以看不懂的時候一律不送：
 * - 身分證字號**不驗檢查碼**：驗了就會放過「格式對、檢查碼錯」的那些，而那正是最像身分證的字串
 * - 信用卡號**驗 Luhn**：真的卡號一定過 Luhn（不會漏），純用長度會把 16 位的訂單編號也擋掉
 * - 名字是**子字串**比對，不是完整檔名比對：`我的password備份.txt` 也要擋
 *
 * 這一層**不看路徑、不看資料夾**，只看檔名與內容：路徑會帶使用者名稱，而回報用的字串
 * （model_skips.why）會出現在面板與 doctor 上。
 */

/** 擋下來的時候記的那句話。**一定含「看起來像機密」**（預想的預期行為第 3、4 條照這句對）。 */
export const SECRET_WHY = 'looks like a secret, so it was not sent'

/** 文件太短，問了也答不出來（不是機密，另一句）。 */
export const TOO_SHORT_WHY = 'too little content to make sense of, so it was not sent'

/** 問過幾次都問不到答案。 */
export const UNANSWERED_WHY = 'the model gave no usable answer after several tries, so it is skipped for now'

/** 準備不出可以送的東西（解不開的 PNG、組不出內容）。 */
export const UNUSABLE_WHY = 'this file cannot be shaped into something askable, so it was not sent'

/**
 * 副檔名一律不送。憑證與公鑰（.crt／.cer／.pub）其實不是秘密，但它們出現的地方
 * 旁邊就是私鑰，而擋掉它們沒有任何損失 —— 一張憑證看不出是哪一堂課。
 */
export const SECRET_EXTS: readonly string[] = Object.freeze([
  '.key', '.pem', '.pfx', '.p12', '.p8', '.jks', '.keystore', '.kdbx', '.kdb', '.agilekeychain',
  '.keychain', '.ovpn', '.asc', '.gpg', '.pgp', '.ppk', '.crt', '.cer', '.der', '.pub',
  '.wallet', '.jwk', '.p7b', '.pkcs12',
])

/**
 * 名字裡出現這些字就不送（英文比對前先轉小寫，中文原樣）。
 *
 * 這個清單寧可長一點：多擋幾個看起來像機密的檔，代價只是那幾個檔沒有模型的意見。
 */
export const SECRET_WORDS: readonly string[] = Object.freeze([
  // 英文
  'password', 'passwd', 'passphrase', 'secret', 'credential', 'token', 'apikey', 'api_key', 'api-key',
  'privatekey', 'private_key', 'private-key', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  'ssh_key', 'sshkey', 'keystore', 'keyring', 'keychain', 'htpasswd', 'netrc', 'npmrc', 'pypirc',
  'git-credentials', 'authorized_keys', 'known_hosts', 'service-account', 'serviceaccount',
  'client_secret', 'clientsecret', 'recovery-code', 'recovery_code', 'mnemonic', 'seed-phrase',
  'seed_phrase', 'seedphrase', 'bitwarden', '1password', 'lastpass', 'keepass', 'dotenv',
  'wallet', 'authinfo', 'kubeconfig', 'shadow',
  // 瀏覽器與密碼管理員匯出的預設檔名（驗證員抓到的漏網：Firefox 是 logins.csv）
  'logins', 'passwords', 'chrome-passwords', 'vault_export', 'keychain',
  // 中文
  '密碼', '金鑰', '私鑰', '憑證', '錢包', '助記詞', '復原碼', '備份金鑰', '機密', '帳密',
])

/** 這幾個名字本身就是秘密（沒有副檔名、也不含上面任何一個字）。 */
const SECRET_NAMES: readonly string[] = Object.freeze([
  '.env', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'credentials', 'secring.gpg', 'shadow',
])

/**
 * 名字這一層。命中回一句人話（為什麼），沒命中回 null。
 *
 * **只收檔名**（basename）。呼叫端不要把路徑丟進來 —— 資料夾名會帶使用者名稱，
 * 而且「我的秘密資料夾/講義.pdf」該不該擋是另一個問題，這一層不回答。
 */
export function secretByName(name: string): string | null {
  const raw = String(name ?? '')
  if (!raw) return null
  // 全形與相容字元先正規化：ｐａｓｓｗｏｒｄ.txt 不可以因為換一種寫法就溜過去
  let s = raw
  try { s = raw.normalize('NFKC') } catch { /* 正規化失敗就用原字串 */ }
  s = s.toLowerCase()
  if (SECRET_NAMES.includes(s)) return `the file is named ${SECRET_NAMES.find(n => n === s)}`
  // .env、.env.local、prod.env 都算
  if (s === '.env' || s.startsWith('.env.') || s.endsWith('.env')) return 'the file is an environment file (.env)'
  for (const ext of SECRET_EXTS) if (s.endsWith(ext)) return `the extension is ${ext}`
  for (const w of SECRET_WORDS) {
    if (!s.includes(w)) continue
    // **真正的文件格式放行弱關鍵字**：一份叫「tokenizer作業.pdf」或「帳號與密碼章節.pptx」的講義
    // 被擋掉，使用者只會覺得這個功能壞了（P2 驗證員）。這幾種格式不是拿來放密碼的，
    // 而且內容那一層照樣會擋（真的有金鑰、有帳密表就不會送）。
    // .txt／.csv／.md／沒有副檔名的**不放行**：密碼就是放在那種檔裡。
    if (WEAK_WORDS.has(w) && DOC_EXTS.some(ext => s.endsWith(ext))) continue
    return `the name contains “${w}”`
  }
  return null
}

/** 這幾個字單獨出現在**文件格式**的檔名裡，多半是在講它，不是它本身。 */
const WEAK_WORDS = new Set([
  'token', 'password', 'passwd', 'secret', 'credential', 'credentials', 'auth',
  '密碼', '金鑰', '憑證', '機密', '帳密',
])
/** 真正的文件格式（講義、投影片、報告）。純文字與表格不在裡面：密碼就是放在那種檔裡。 */
const DOC_EXTS = ['.pdf', '.docx', '.pptx', '.doc', '.ppt'] as const

/** Luhn 檢查（信用卡號都過得了，所以用它不會漏掉真的卡號）。 */
function luhnOk(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (d < 0 || d > 9) return false
    if (double) { d *= 2; if (d > 9) d -= 9 }
    sum += d
    double = !double
  }
  return digits.length > 0 && sum % 10 === 0
}

/** 內容裡有沒有信用卡號（13～19 位、可以用空白或減號分組、過 Luhn）。 */
function hasCardNumber(text: string): boolean {
  const re = /(?<![0-9])(?:[0-9][ -]?){12,18}[0-9](?![0-9])/g
  for (const m of text.matchAll(re)) {
    const digits = m[0].replace(/[ -]/g, '')
    if (digits.length >= 13 && digits.length <= 19 && luhnOk(digits)) return true
  }
  return false
}

/**
 * 內容的高風險樣式。每一條都是「看到就幾乎確定是憑證」的東西 ——
 * 一般的字（password、密碼、帳號）**不在這裡**，那是名字那一層的事。
 */
export const SECRET_PATTERNS: readonly (readonly [string, RegExp])[] = Object.freeze([
  ['a private key header', /-----BEGIN[A-Z0-9 ]{0,40}PRIVATE KEY-----/] as const,
  ['a PGP private key header', /-----BEGIN PGP PRIVATE KEY BLOCK-----/] as const,
  ['an OpenSSH private key header', /-----BEGIN OPENSSH PRIVATE KEY-----/] as const,
  ['a certificate header', /-----BEGIN CERTIFICATE-----/] as const,
  ['an AWS key id', /(?<![A-Z0-9])(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}(?![0-9A-Z])/] as const,
  ['an AWS secret key field', /aws_secret_access_key\s*[:=]/i] as const,
  ['GitHub token', /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{16,}/] as const,
  ['GitHub token', /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}/] as const,
  ['a key starting with sk-', /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/] as const,
  ['Slack token', /(?<![A-Za-z0-9_-])xox[abprs]-[A-Za-z0-9-]{8,}/] as const,
  ['a Google API key', /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/] as const,
  ['a Bearer authorization header', /authorization\s*[:=]\s*["']?bearer\s+[A-Za-z0-9._~+/=-]{16,}/i] as const,
  // 身分證字號：**不驗檢查碼**（驗了就會放過「格式對、檢查碼錯」的那些）
  ['a national ID number', /(?<![A-Za-z0-9])[A-Za-z][12][0-9]{8}(?![0-9A-Za-z])/] as const,
  // ── 下面這幾條是 P2 驗證員抓到的漏網（Downloads 裡最值錢的東西就是這些）──
  ['a Stripe key', /(?<![A-Za-z0-9_-])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/] as const,
  ['a connection string with a password', /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|ftp|ssh):\/\/[^\s:@/]+:[^\s@/]{3,}@/i] as const,
  ['JWT', /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/] as const,
  ['Kubernetes Secret', /kind:\s*Secret\b/] as const,
  ['a .pgpass line', /^[^\s:]+:\d{1,5}:[^\s:]*:[^\s:]+:\S+$/m] as const,
  // 收尾的引號要吃掉："private_key": ⋯ 這種 JSON 寫法最常見
  ['a private key field', /(?:^|[\s,{"'])(?:private_key|privatekey|client_secret|api[_-]?secret)["']?\s*[:=]/i] as const,
])

/**
 * **一張帳密表**（瀏覽器匯出的密碼、自己整理的帳號清單）。
 *
 * 驗證員實測：Firefox 匯出的 `logins.csv` 名字不在關鍵字清單裡、內容也沒有任何一條樣式命中，
 * 結果整份帳密被送去問模型。這是 Downloads 裡最值錢的東西，不可以只靠「檔名有沒有 password」。
 *
 * 判斷：**同一行**同時出現「使用者名稱類」與「密碼類」的欄位名（CSV 標頭、JSON 鍵、YAML 鍵都算），
 * 而且下面真的有資料列。單獨一個「password:」欄位由上面的樣式管，這裡管的是**表格**。
 */
export function looksLikeCredentialTable(text: string): boolean {
  const head = String(text ?? '').slice(0, 4000)
  // 中文沒有單字邊界，所以中英文分開比（\b 對「帳號」永遠不成立）
  const user = /\b(?:username|user_name|user|account|login|email)\b|帳號|使用者|電子郵件|信箱/i
  const pass = /\b(?:password|passwd|pwd|secret|passphrase)\b|密碼|通行碼|口令/i
  for (const line of head.split(/\r?\n/, 40)) {
    if (line.length > 400) continue
    if (!user.test(line) || !pass.test(line)) continue
    // 欄位名同一行出現：要像表格（有分隔符號）才算，免得一句「請輸入帳號與密碼」就擋掉講義
    if (/[,;\t|]/.test(line) || /["']?\s*:\s*["']?/.test(line)) return true
  }
  return false
}

/**
 * 內容這一層。命中回一句人話（為什麼），沒命中回 null。
 *
 * 看的是**我們手上的整份文字**（P1 存了最多 4000 字），不是即將送出的那 2000 字 ——
 * 第 3000 個字才出現的私鑰一樣要擋掉整個檔。
 */
export function secretByContent(text: string): string | null {
  const s = String(text ?? '')
  if (!s) return null
  for (const [label, re] of SECRET_PATTERNS) if (re.test(s)) return `the contents hold ${label}`
  if (hasCardNumber(s)) return 'the contents hold a credit card number'
  if (looksLikeCredentialTable(s)) return 'the contents look like a table of usernames and passwords'
  return null
}

export type Screened = {
  /** true 才可以送出去 */
  send: boolean
  /** 擋下來的時候給使用者看的那句話（含「看起來像機密」），送得出去是 null */
  why: string | null
  /** 擋下來的理由（給測試與 log 用的短標籤），送得出去是 null。**不含檔案內容** */
  rule: string | null
}

const PASS: Screened = Object.freeze({ send: true, why: null, rule: null })

/**
 * 一個檔可不可以送去模型。
 *
 * @param name 檔名（basename），一定要給
 * @param text 文件的文字；圖片沒有文字就不給（圖片只過名字那一層）
 * @param key  這台機器設定的模型金鑰。**內容裡出現它就不送** —— 使用者把 `~/.contextbox/env`
 *             另存成 `筆記.txt` 這種事真的會發生，而那一份會被原封不動送回發金鑰的那台機器。
 *             太短的字串不比（免得一個兩三個字的金鑰把所有檔都擋掉）。
 */
export function screen(input: { name: string; text?: string | null; key?: string | null }): Screened {
  const byName = secretByName(input.name)
  if (byName) return { send: false, why: SECRET_WHY, rule: byName }
  const text = input.text == null ? '' : String(input.text)
  if (text) {
    const key = String(input.key ?? '')
    if (key.length >= 8 && text.includes(key)) {
      return { send: false, why: SECRET_WHY, rule: "the contents hold this machine's model key" }
    }
    const byContent = secretByContent(text)
    if (byContent) return { send: false, why: SECRET_WHY, rule: byContent }
  }
  return PASS
}
