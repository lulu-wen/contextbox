/**
 * 模型客戶端 —— OpenAI 相容的 `/chat/completions`，強制 `json_schema`。
 *
 * **這是唯一一支會把使用者的內容送出這台機器的程式。** 三件事寫死在這裡：
 *
 * 1. **沒設定就完全不啟用**（modelEnabled）：沒有 baseUrl、沒有模型名字、環境變數裡沒有金鑰，
 *    就一個請求都不會發。乾淨安裝、沒有網路、金鑰打錯：功能安靜地不在，其他一切照常。
 * 2. **一個檔一個請求、一次一個**：一個壞掉不會拖垮其他九個，回答也對得上檔。併發交給
 *    core/model-queue.ts 管（模型只有一張卡）。
 * 3. **每個請求 60 秒**：逾時記一次失敗，那個檔等下一輪。
 *
 * ── 回答為什麼一定要強制格式 ─────────────────────────────────
 *
 * 模型會自信地說錯（實測：系統操作畫面被說成「考試」）。它說的東西之後會變成改名（P3）
 * 與歸檔（P4）的依據，所以**形狀**至少要是確定的：六個欄位、`kind` 與 `confidence` 是固定選項。
 * 實測（2026-09-19，一個 OpenAI 相容閘道後面的 Qwen3-VL-8B）：閘道會把 `response_format` 傳下去，
 * 模型真的照格式回；一張 320×180 的圖 6.8 秒。
 *
 * 形狀不對就**整筆不採用**（parseView 回 null）—— 少一欄、多一欄、不是 JSON 都一樣。
 * 壞資料存進去比沒有資料更糟：面板會把它當成模型的意見顯示給使用者看。
 *
 * ── 這支檔案不做的事 ─────────────────────────────────────────
 *
 * - 不決定「哪些檔要問」（core/model-queue.ts）
 * - 不決定「這個檔可不可以送」（core/model-guard.ts）
 * - 不碰資料庫（core/model-store.ts）
 * - **不把內容寫進任何 log**：console 一個字都不印，錯誤訊息裡也不放內容與金鑰
 */
import type { Config } from './config.ts'
import { modelKey } from './config.ts'
import { decodePngGray } from './png.ts'
import { resizeGray } from './imagehash.ts'
import { encodeGrayPng } from './png-write.ts'

/** 提示詞版本。**改了提示詞就要改這個字串** —— 它是快取鍵的一半，舊答案才不會被當成新提示詞的答案。 */
// v3：那段文字前面開始講檔名（2026-09-21）。課名常常只寫在檔名上，
// 不給的話 syllabus 這種檔永遠答不出課名。prompt 變了，快取就要重算。
// v4：兩個軸（2026-09-21，P7）。whatItIs 一定有、course 只在真的屬於某門課時才填。
// 以前只問「哪一堂課」，而使用者的 Downloads 大半不是課程教材 —— 答不出課名就整組欄位空掉。
export const PROMPT_VERSION = 'v4-en'

/** 每個請求最多等這麼久。 */
export const MODEL_TIMEOUT_MS = 60_000

/**
 * 圖片長邊上限。模型部署時就是照 1344 估記憶體的；灰階可以接受（省一半）。
 */
export const IMAGE_MAX_SIDE = 1344

/** 文件最多送這麼多字（P1 存了 4000，這裡再砍一半：夠判斷課程與主題，也少送一半）。 */
export const TEXT_MAX_CHARS = 2000

/** 少於這麼多字就不問（問了也只會得到「看不出來」）。 */
export const MIN_TEXT_CHARS = 30

/** 回應最多讀這麼多位元組。壞掉或惡意的閘道可以一直吐，讀爆記憶體就不是「一次失敗」了。 */
export const MAX_RESPONSE_BYTES = 1024 * 1024

/** `kind` 的固定選項。 */
export const VIEW_KINDS: readonly string[] = Object.freeze([
  'Lecture', 'Homework', 'Exam', 'Notes', 'Code', 'Report', 'Form', 'Chat', 'Other',
])

/** 信心三級。數字沒有校準過，別假裝精確。 */
export const CONFIDENCES: readonly string[] = Object.freeze(['high', 'medium', 'low'])

/**
 * 回答的欄位。**不多不少** —— parseView 照這個比。
 *
 * `whatItIs`／`subject` 是 2026-09-21 加的（P7）。以前只問「屬於哪一堂課」，
 * 而 course 與 topic 綁在同一個問題上 —— 答不出課名就整組欄位一起空掉：
 *
 *   Peng-Ju_Wen_CV_1.docx → course=Unknown topic=Unknown kind=Other confidence=high
 *
 * 內容明明讀到了（evidence 是真的引文），只是被問錯問題。使用者的 Downloads 裡
 * 大半是 CV、自傳、推薦書、表單、法規、論文、規格書，它們**本來就不屬於任何一堂課**。
 * 實機量過：202 筆答案裡 186 筆 course=Unknown，其中 145 筆連 topic 都是 Unknown。
 *
 * 所以改成兩個軸：`whatItIs` **一定有**（這是什麼文件），`course` 只在真的屬於
 * 某門課或專案時才填。`course=Unknown` 不再是失敗，只是「這不是課程教材」。
 */
export const VIEW_FIELDS: readonly string[] = Object.freeze([
  'course', 'topic', 'kind', 'suggestedName', 'whatItIs', 'subject', 'evidence', 'confidence',
])

/** 每個欄位存進資料庫之前的長度上限（字）。 */
const FIELD_MAX = 300

export type ModelView = {
  course: string
  topic: string
  kind: string
  suggestedName: string
  /** 這是什麼文件，模型自己的話（resume／lab handout／feasibility study）。**一定有。** */
  whatItIs: string
  /** 關於什麼，幾個字。 */
  subject: string
  evidence: string
  confidence: string
}

export type ModelSource = 'image' | 'text'

/**
 * **答案的語言是固定的，檔案的語言不是。**（稽核 2026-09-20）
 *
 * 使用者的檔案可能是任何語言（這個作品就是在台灣寫的，講義多半是中文），但 `course` 與 `kind`
 * 會**變成磁碟上的資料夾名**，而 `Unknown` 這個字是「看不出來就不提議」那條防線的字面值。
 * 不講死的話：中文講義會讓模型回「作業系統」，路徑長成 `Courses/作業系統/Lecture`；
 * 更糟的是它會回「未知」「看不出來」—— cleanCourse 只認字面 `Unknown`，於是真的長出一個
 * `Courses/未知/` 資料夾。所以 prompt 要同時講兩件事：讀得懂任何語言、但用英文回答。
 *
 * `evidence` 是例外：它是**從檔案裡引用的原文**，原文是什麼語言就是什麼語言 ——
 * 翻譯過的引用不算證據。
 */
export const SYSTEM_PROMPT =
  'You sort files. Look at the screenshot or document excerpt the user gives you and say what it is. '
  + 'Answer only from what you can see. '
  + '**Most files are not coursework**: resumes, application forms, contracts, research papers, '
  + 'specifications, receipts, photos. whatItIs is always required — say plainly what kind of document '
  + 'it is, in your own words. course is only for material that clearly belongs to a named course or '
  + 'project; write the exact word Unknown for course when it does not belong to one. '
  + 'That is normal and expected, not a failure, so keep your confidence high when you are sure what the '
  + 'document is even though it has no course. '
  + 'The file may be in any language; read it in whatever language it is written in. '
  + 'Always answer in English, even when the file is not, and use the exact word Unknown rather than a '
  + 'translation of it. Do not guess and do not invent course names.'

export const USER_PROMPT =
  'Answer in the fixed format, in English. '
  + 'whatItIs: a short noun phrase for the kind of document this is, in your own words — for example '
  + '"resume", "lab handout", "scholarship application form", "research paper", "API design spec", '
  + '"meeting notes". No file extension, no date. '
  + 'subject: what it is about, in a few words. '
  + 'course: the named course or project it belongs to, or Unknown. '
  + 'topic: the topic within that course, or Unknown. '
  + 'suggestedName is <Course or project>_<Topic> when there is a course, otherwise just <Subject>, '
  + 'with no extension and no date, in English. '
  + 'confidence: how sure you are about whatItIs. '
  + 'evidence must quote words you actually saw in the image or the text — '
  + 'quote them in their original language, do not translate them.'

/** 強制回答格式（vLLM 的 xgrammar 會照這個壓）。 */
export function responseFormat(): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'contextbox_file_view',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [...VIEW_FIELDS],
        properties: {
          course: { type: 'string', description: 'Which course or project. Write Unknown if you cannot tell.' },
          topic: { type: 'string', description: 'What the topic is' },
          kind: { type: 'string', enum: [...VIEW_KINDS] },
          suggestedName: { type: 'string', description: '<Course or project>_<Topic>, with no extension and no date' },
          // **一定要給上限**（2026-09-21 使用者實機回報）。
          //
          // 沒有上限的字串欄位等於邀請模型把整份文件倒進來。實機上這三個檔
          // （Ameba平台總架構.pptx／3／4，投影片匯出的架構圖，滿滿的短標籤、沒有句子）
          // 每一次都長這樣：前四欄乖乖答完（course/topic 都是 Unknown，它確實看不出來），
          // 然後 evidence 一路吐原文到 max_tokens，`confidence` 永遠沒出現 ——
          // JSON 沒收尾 → parseView 整筆丟掉 → 算一次失敗 → 下一輪再問 → 一模一樣。
          // 使用者的 model_calls 裡 7 次 answer 失敗全部是這三個檔，每次燒 50 秒。
          //
          // 上限就用 FIELD_MAX：**parseView 本來就把 evidence 截到 FIELD_MAX**，
          // 超過的部分我們一個字都沒留過。差別只在於現在是模型不要產生它，
          // 而不是產生完了再由我們丟掉、順便把整筆答案賠進去。
          whatItIs: {
            type: 'string',
            maxLength: FIELD_MAX,
            description: 'What kind of document this is, in your own words. Always required.',
          },
          subject: {
            type: 'string',
            maxLength: FIELD_MAX,
            description: 'What it is about, in a few words',
          },
          evidence: {
            type: 'string',
            maxLength: FIELD_MAX,
            description: 'A short quote of words you actually saw in the image or the text',
          },
          confidence: { type: 'string', enum: [...CONFIDENCES] },
        },
      },
    },
  }
}

/**
 * 模型這條線開了嗎。**三個都要有**：網址、模型名字、金鑰。
 *
 * 金鑰也算在內（預想的不變量 1：「沒有網路、叫不動、金鑰錯：功能安靜地不啟用」）——
 * 沒有金鑰就打過去，閘道只會回 401，而使用者看到的是一排失敗紀錄，不是「還沒設定」。
 */
export function modelEnabled(config: Config): boolean {
  return Boolean(config?.model?.baseUrl && config?.model?.name && modelKey(config))
}

/** 沒開的時候，doctor 要講的那句話。 */
export function whyDisabled(config: Config): string | null {
  if (!config?.model?.baseUrl || !config?.model?.name) return 'no model configured, so reading is off'
  if (!modelKey(config)) return `the environment variable ${config.model.keyEnv} is empty, so reading is off`
  return null
}

/**
 * 看起來像絕對路徑的東西。**回給畫面的東西不可以有絕對路徑**（預想的不變量 6），
 * 而模型引用的是使用者檔案裡的字 —— 一份講義裡寫著 `/home/你的名字/Downloads/…` 是很平常的事，
 * 它會原封不動被引進 `evidence` 裡，然後出現在面板上。
 *
 * 只認**真的路徑開頭**（三種作業系統的根目錄、家目錄縮寫、磁碟機代號），
 * 不用「有斜線就算」那種寫法 —— 那會把 `2026/09/19` 這種日期也吃掉。
 */
const ABS_PATH = /(?:~|\/(?:home|Users|var|tmp|private|etc|opt|mnt|media|root|srv|usr)|[A-Za-z]:)[\\/][^\s"'，。；：）】]*/g

/** 顯示用的清洗：控制字元與方向字元換掉、絕對路徑遮掉，再砍長度。 */
/** 欄位清洗：控制字元、方向字元換成空白，絕對路徑換成 ⋯，截到 max。describe 那條路共用。 */
export function cleanField(s: string, max: number): string {
  return clean(s, max)
}

function clean(s: string, max: number): string {
  return String(s)
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(ABS_PATH, '⋯')
    .trim()
    .slice(0, max)
}

/**
 * 模型回的東西 → 一筆看法，或 null（不採用）。
 *
 * **嚴格**：要剛好是那六個欄位、每一個都是字串、`kind` 與 `confidence` 要在固定選項裡。
 * 少一欄、多一欄、不是物件、不是 JSON —— 全部回 null。
 *
 * 建議的檔名再擋一次路徑分隔符：P3 會拿它去改名，一個帶 `/` 或 `..` 的名字是另一回事。
 */
/**
 * 把字串字面量裡的**裸控制字元**跳脫掉（2026-09-21 使用者實機回報）。
 *
 * JSON 規定 U+0000–U+001F 不可以直接出現在字串裡，要寫成跳脫序列。但模型會直接吐出來 ——
 * 實機上這一筆六個欄位全都對、內容也對，只因為 evidence 裡有一個**真的 TAB**
 * （從 .docx 的表格抄來的）就整筆被丟掉：
 *
 *   {"course":"Unknown", …, "evidence":"AI-RAN LLM Platform<TAB>2026", "confidence":"high"}
 *
 * 從檔案裡抄出來的引文本來就常常帶 TAB 與換行（表格、投影片），所以這不是偶發。
 *
 * **只補跳脫，不補別的。** 不加括號、不猜缺的欄位、不改任何值 ——
 * 跳脫完照樣走同一套嚴格檢查，該退的還是退。parseView 後面的 clean() 本來就會
 * 把控制字元換成空白，所以救回來的值跟本來就寫對跳脫的那一筆一模一樣。
 *
 * 用字元掃描不用正規式：要分辨「字串裡面」與「字串外面」，而且要看得懂反斜線跳脫。
 */
export function escapeRawControlChars(s: string): string {
  const BACKSLASH = String.fromCharCode(92)
  let out = ''
  let inStr = false
  let esc = false
  for (const ch of s) {
    if (esc) { out += ch; esc = false; continue }
    if (inStr && ch === BACKSLASH) { out += ch; esc = true; continue }
    if (ch === '"') { inStr = !inStr; out += ch; continue }
    const code = ch.charCodeAt(0)
    if (inStr && code < 0x20) {
      out += BACKSLASH + 'u' + code.toString(16).padStart(4, '0')
      continue
    }
    out += ch
  }
  return out
}

export function parseView(raw: unknown): ModelView | null {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw) }
    catch {
      // 裸控制字元是唯一會補救的情況，補完照樣走下面那套嚴格檢查
      try { v = JSON.parse(escapeRawControlChars(raw)) } catch { return null }
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.length !== VIEW_FIELDS.length) return null
  for (const f of VIEW_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(o, f)) return null
    if (typeof o[f] !== 'string') return null
  }
  const kind = String(o.kind).trim()
  const confidence = String(o.confidence).trim()
  if (!VIEW_KINDS.includes(kind)) return null
  if (!CONFIDENCES.includes(confidence)) return null
  // 建議的檔名再擋一次路徑分隔符：P3 拿它去改名，一個帶 / 或 \ 的名字是另一回事
  const suggested = clean(String(o.suggestedName), FIELD_MAX).split('/').join('_').split('\\').join('_')
  return {
    course: clean(String(o.course), FIELD_MAX),
    topic: clean(String(o.topic), FIELD_MAX),
    kind,
    suggestedName: suggested,
    whatItIs: clean(String(o.whatItIs), FIELD_MAX),
    subject: clean(String(o.subject), FIELD_MAX),
    evidence: clean(String(o.evidence), FIELD_MAX),
    confidence,
  }
}

/** 數 code point（不是 UTF-16 單位）。 */
function countCodePoints(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xdc00 && c <= 0xdfff) continue
    n++
  }
  return n
}

/** 切前 n 個 code point（不會切在代理對中間）。 */
export function headChars(s: string, n: number): string {
  let count = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xdc00 && c <= 0xdfff) continue
    if (count === n) return s.slice(0, i)
    count++
  }
  return s
}

/** 這份文字夠不夠問（P1 讀得到 30 個字以上）。 */
export function longEnough(text: string | null | undefined): boolean {
  return countCodePoints(String(text ?? '').trim()) >= MIN_TEXT_CHARS
}

/** 要送出去的那段文字（最多 TEXT_MAX_CHARS 個字）。 */
export function textPayload(text: string): string {
  return headChars(String(text ?? ''), TEXT_MAX_CHARS)
}

/**
 * 要送出去的那張圖：長邊縮到 ≤ IMAGE_MAX_SIDE 的**灰階 PNG**。
 *
 * 用的就是 P0 縮圖那一套（decodePngGray → resizeGray → encodeGrayPng），
 * 不另外寫一份縮圖程式碼。已經夠小的原圖也重新編一次 —— 重編出來的一定是
 * 「8 位元灰階、非交錯」，不會夾帶原圖的中繼資料（拍攝時間、位置、縮圖、註解）。
 * 那些東西在螢幕截圖裡不多，但它們會跟著圖一起離開這台機器。
 *
 * 解不開、太大就丟錯 —— 呼叫端當成「這個檔問不到」，不是伺服器故障。
 */
export function imagePayload(png: Buffer | Uint8Array): { bytes: Buffer; width: number; height: number } {
  const img = decodePngGray(png)
  const long = Math.max(img.width, img.height)
  if (long <= IMAGE_MAX_SIDE) {
    return { bytes: encodeGrayPng(img.width, img.height, img.gray), width: img.width, height: img.height }
  }
  const w = Math.max(1, Math.round(img.width * IMAGE_MAX_SIDE / long))
  const h = Math.max(1, Math.round(img.height * IMAGE_MAX_SIDE / long))
  return { bytes: encodeGrayPng(w, h, resizeGray(img, w, h)), width: w, height: h }
}

/** 一次請求的內容。文字與圖片二選一。 */
export type AskInput =
  | { source: 'text'; text: string; name?: string | null }
  | { source: 'image'; png: Buffer; name?: string | null }

export type AskOk = { ok: true; view: ModelView; ms: number; charsSent: number; bytesSent: number }
export type AskFail = {
  ok: false
  /** 給使用者看的一句話。**不含檔案內容、不含金鑰。** */
  error: string
  ms: number
  charsSent: number
  bytesSent: number
  /** 呼叫端自己把 signal 取消掉的（Ctrl+C、pet 結束）—— 這不算模型失敗，不記帳 */
  aborted: boolean
  /**
   * 這一次失敗要算在誰頭上。
   * - `answer`：模型有回應，但答案不能用（格式不對、沒有內容）→ 算這個檔的帳，問三次還這樣就別再問。
   * - `transport`：連不上、逾時、5xx、金鑰不對 → **跟這個檔無關**，不可以累積在它身上。
   *   閘道掛三十分鐘就會把排在前面的幾個檔永久燒掉（P2 驗證員）。
   */
  blame: 'answer' | 'transport'
}
export type AskResult = AskOk | AskFail

/** 組 messages。匯出給測試看得到真的送了什麼。 */

/**
 * 那段文字前面的一句話。**有檔名就講檔名**（2026-09-21 使用者實機回報）。
 *
 * 以前只送內文，檔名從來沒進過 prompt。結果：
 *
 *   Introduction to Database Systems, 2026 Spring - Syllabus.pdf
 *     內文是一張週次表（Week／Date／Main Course Topic／Lab Topic⋯⋯），從頭到尾沒寫課名
 *     不給檔名 → Unknown / Unknown (low)
 *     給檔名   → Introduction to Database Systems / Using PostgreSQL (high)
 *
 * 課名寫在檔名上是**最常見的情況**（講義、syllabus、作業），而那正是這個工具最該認出來的一類。
 *
 * **檔名是不可信的輸入**（下載來的檔叫什麼都可以，包括一句指令）。但這不是新的風險：
 * 內文本來就一起送出去，而且同樣不可信。真正擋住它的一直是**輸出的形狀** ——
 * 回答的 schema 裡沒有路徑欄位，路徑一律由程式組、洗過、再檢查一次在不在該在的樹底下。
 * 模型再怎麼被說服也講不出一條路徑來。這裡照樣把檔名洗過（控制字元、方向字元、絕對路徑）
 * 再放進去，而且放在引號裡、明講它只是檔名。
 */
function fileHeader(name?: string | null): string {
  const shown = cleanField(String(name ?? ''), 200).split('"').join("'")
  return shown
    ? 'Here is an excerpt from a file named "' + shown + '":\n\n'
    : 'Here is an excerpt from a file:\n\n'
}

export function buildMessages(input: AskInput): unknown[] {
  const user: unknown[] = input.source === 'image'
    ? [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${input.png.toString('base64')}` } },
        { type: 'text', text: USER_PROMPT },
      ]
    : [{ type: 'text', text: fileHeader(input.name) + `${input.text}\n\n${USER_PROMPT}` }]
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ]
}

/** 錯誤訊息裡絕對不可以有金鑰。網址留著（那是使用者自己設的，doctor 也印）。 */
function safeError(e: unknown, key: string): string {
  let s = String((e as any)?.message ?? e ?? '')
  if (key && key.length >= 8) s = s.split(key).join('***')
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 200) || 'reason unknown'
}

/** 把回應讀進來，超過上限就不讀了。 */
async function readCapped(res: Response, cap: number): Promise<string> {
  const body = res.body
  if (!body) return (await res.text()).slice(0, cap)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let n = 0
  for (;;) {
    const step = await reader.read()
    if (step.done) break
    const value = step.value as Uint8Array
    n += value.length
    if (n > cap) {
      try { await reader.cancel() } catch { /* 已經斷了 */ }
      throw new Error('the model\'s response is too long; not reading further')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8')
}

/** `${baseUrl}/chat/completions`，baseUrl 尾巴的斜線去掉。 */
export function chatUrl(baseUrl: string): string {
  return String(baseUrl).replace(/\/+$/, '') + '/chat/completions'
}

export type AskOptions = {
  /** 呼叫端要中途停的話給這個（Ctrl+C、pet 結束）。逾時是另一條路，這裡分得出來。 */
  signal?: AbortSignal
  /** 測試把假的伺服器接進來用（預設就是全域的 fetch）。 */
  fetchImpl?: typeof fetch
  /** 逾時（毫秒）。預設 MODEL_TIMEOUT_MS；測試會調小。 */
  timeoutMs?: number
}

/** 一次 chat/completions 的結果。**內容還沒解析** —— 怎麼讀是呼叫端的事。 */
export type ChatOk = { ok: true; content: string; ms: number }
export type ChatFail = {
  ok: false; error: string; ms: number
  aborted: boolean; blame: 'answer' | 'transport'
}
export type ChatResult = ChatOk | ChatFail

/** 一次要問的東西。 */
export type ChatRequest = {
  /**
   * 送出去的訊息。**給函式的話，會等到真的要送的那一刻才呼叫** ——
   * 組訊息本身就可能丟（壞掉的 PNG 解不開），而那要算成一次失敗、不可以變成例外。
   */
  messages: unknown[] | (() => unknown[])
  responseFormat: Record<string, unknown>
  /** 回答的 token 上限。逐檔是 600；分類那一次要塞十幾組，所以大一些。 */
  maxTokens?: number
}

/**
 * **唯一一個真的會把東西送出這台機器的函式。**
 *
 * 逐檔的看法（askModel）與分類（P7 的 group）都走這裡 —— 逾時、取消、金鑰遮蔽、
 * 回應長度上限、狀態碼的處理**只有一份**，不會有第二條路偷偷少掉一道防線。
 *
 * **保證不丟例外**：任何失敗都回 `{ ok: false, error }`。
 */
export async function chatJson(config: Config, req: ChatRequest, opts: AskOptions = {}): Promise<ChatResult> {
  const key = modelKey(config)
  const started = Date.now()
  const fail = (error: string, aborted = false, blame: 'answer' | 'transport' = 'transport'): ChatFail =>
    ({ ok: false, error, ms: Date.now() - started, aborted, blame })

  if (!modelEnabled(config)) return fail('The model is not configured')
  if (opts.signal?.aborted) return fail('Cancelled', true)

  const timeoutMs = Math.max(1, opts.timeoutMs ?? MODEL_TIMEOUT_MS)
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout
  const doFetch = opts.fetchImpl ?? fetch
  const tooSlow = () => `The model did not answer in ${Math.round(timeoutMs / 1000)}s`

  let res: Response
  try {
    res = await doFetch(chatUrl(config.model.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        accept: 'application/json',
      },
      body: JSON.stringify({
        model: config.model.name,
        messages: typeof req.messages === 'function' ? req.messages() : req.messages,
        response_format: req.responseFormat,
        temperature: 0,
        max_tokens: req.maxTokens ?? 600,
        stream: false,
      }),
      signal,
    })
  } catch (e) {
    if (opts.signal?.aborted) return fail('Cancelled', true)
    if (timeout.aborted) return fail(tooSlow())
    return fail(`Cannot reach the model (${safeError(e, key)})`)
  }

  if (res.status === 401 || res.status === 403) return fail(`The model rejected this key (${res.status})`)
  if (!res.ok) return fail(`The model returned ${res.status}`)

  let text: string
  try { text = await readCapped(res, MAX_RESPONSE_BYTES) }
  catch (e) {
    if (opts.signal?.aborted) return fail('Cancelled', true)
    if (timeout.aborted) return fail(tooSlow())
    return fail(`Could not read the model's response through (${safeError(e, key)})`)
  }

  let body: any
  try { body = JSON.parse(text) } catch { return fail('The model did not answer with JSON', false, 'answer') }
  const content = body?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) return fail('The model answered with nothing', false, 'answer')
  return { ok: true, content, ms: Date.now() - started }
}

/**
 * 問一次。**保證不丟例外** —— 任何失敗都回 `{ ok: false, error }`。
 *
 * 呼叫端要自己確定：modelEnabled 是 true、這個檔過得了 model-guard。
 */
export async function askModel(config: Config, input: AskInput, opts: AskOptions = {}): Promise<AskResult> {
  const charsSent = input.source === 'text' ? countCodePoints(input.text) : 0
  const bytesSent = input.source === 'image'
    ? input.png.length
    : Buffer.byteLength(input.text, 'utf8')

  const r = await chatJson(config, {
    messages: () => buildMessages(input),
    responseFormat: responseFormat(),
    maxTokens: 600,
  }, opts)
  if (!r.ok) return { ...r, charsSent, bytesSent }

  const view = parseView(r.content)
  // **形狀不對就整筆不採用。** 少一欄、多一欄、選項不對 —— 一律當成一次失敗，
  // 不可以把半筆資料存進去（預想的預期行為第 8 條）
  if (!view) {
    return {
      ok: false, error: 'The model answered in the wrong shape; this one is discarded',
      ms: r.ms, charsSent, bytesSent, aborted: false, blame: 'answer',
    }
  }
  return { ok: true, view, ms: r.ms, charsSent, bytesSent }
}
