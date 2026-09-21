/**
 * 「這到底是什麼文件？」—— 開放式的第二個問題（P7，2026-09-21）。
 *
 * ── 為什麼要有這一支 ────────────────────────────────────────
 *
 * 逐檔那條路（model.ts）問的是「**屬於哪一堂課**」，而且把 course 與 topic 綁在同一個問題上。
 * 答不出課名的時候，整組欄位一起空掉：
 *
 *   Peng-Ju_Wen_CV_1.docx
 *     course = "Unknown"   topic = "Unknown"   kind = Other   confidence = high
 *     evidence = "AI-RAN LLM Platform 2026"        ← 內容明明讀到了
 *
 * 實機 88 筆答案裡，殘料 84 筆，**其中只有 8 筆有 topic**。使用者的 Downloads 裡大半是
 * 表單、公文、論文、CV、規格書 —— 它們不屬於任何一堂課，所以那條路對它們永遠答不出東西，
 * 而原因不是看不懂。
 *
 * 這一支換一個問法：**不預設任何分類，請模型用自己的話講這是什麼。** 實測（使用者自己的
 * 端點與模型）12 個殘料檔裡 11 個拿到準確答案：
 *
 *   Peng-Ju_Wen_CV_1.docx          → resume — computer science student with AI and LLM agent experience
 *   Lab Report (1).pdf             → lab report — servo sweep experiment
 *   team19_assignment3_report2.docx→ team report — comparison of EXPLAIN implementation
 *   cuBB-GB10-可行性評估.pptx       → feasibility assessment — running Aerial cuBB on GB10
 *
 * ── 為什麼不直接改原本的 prompt ─────────────────────────────
 *
 * 因為那樣會換 `PROMPT_VERSION`，把使用者已經累積的快取整批作廢，而且真的是課程教材的檔
 * 本來就答得好好的，沒有理由重問。這一支走**自己的快取命名空間**（`DESCRIBE_VERSION`），
 * 兩條路各記各的，互不影響。
 */

import { cleanField, CONFIDENCES, MAX_RESPONSE_BYTES, MODEL_TIMEOUT_MS, modelEnabled, textPayload } from './model.ts'
import type { Config } from './config.ts'

/**
 * 這個問題的版本。**跟 PROMPT_VERSION 是兩回事**，各自獨立改版：
 * 改這裡只會讓 describe 的答案重問，逐檔那條路的快取一列都不動。
 */
export const DESCRIBE_VERSION = 'd1-en'

/** 一個欄位最多留幾個字。跟 model.ts 的 FIELD_MAX 同一個數量級，講一句話夠了。 */
export const DESCRIBE_FIELD_MAX = 120

export const DESCRIBE_FIELDS: readonly string[] = Object.freeze(['whatItIs', 'subject', 'confidence'])

export type Described = {
  /** 這是什麼文件，用模型自己的話（resume／lab handout／scholarship form⋯⋯） */
  whatItIs: string
  /** 關於什麼 */
  subject: string
  confidence: string
}

/**
 * **不要硬塞進任何分類。** 這正是跟 model.ts 那條路最大的差別 ——
 * 那邊有一個固定的 `kind` enum，這邊沒有，分類是讓模型自己長出來的。
 *
 * 「用英文回答」要講死：使用者的檔多半是中文，不講的話會回中文，
 * 而這些字之後要拿去做跨批合併與資料夾名（跟 model.ts 同一個理由）。
 */
export const DESCRIBE_SYSTEM =
  'You look at an excerpt from a file and say plainly what kind of document it is. '
  + 'Answer only from what you can actually see. Do not force it into any category, and do not invent. '
  + 'The file may be in any language; read it in whatever language it is written in, '
  + 'but always answer in English, even when the file is not. '
  + 'If you genuinely cannot tell, say so in whatItIs and set confidence to low.'

export const DESCRIBE_USER =
  'whatItIs: a short noun phrase for the kind of document this is, in your own words — '
  + 'for example "resume", "lab handout", "scholarship application form", "research paper", '
  + '"API design spec", "meeting notes". No file extension, no date. '
  + 'subject: what it is about, in a few words.'

/**
 * 回答的格式。
 *
 * **每一個自由文字欄位都有 maxLength** —— 2026-09-21 的教訓：model.ts 的 `evidence`
 * 沒有上限，模型就把整份文件倒進去，JSON 撐爆沒收尾，整筆答案賠掉，而且那三個檔
 * 每一輪都重問、每次燒 50 秒。沒有上限的字串欄位等於邀請它這樣做。
 */
export function describeFormat(): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'contextbox_describe',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [...DESCRIBE_FIELDS],
        properties: {
          whatItIs: {
            type: 'string',
            maxLength: DESCRIBE_FIELD_MAX,
            description: 'What kind of document this is, in your own words',
          },
          subject: {
            type: 'string',
            maxLength: DESCRIBE_FIELD_MAX,
            description: 'What it is about, in a few words',
          },
          confidence: { type: 'string', enum: [...CONFIDENCES] },
        },
      },
    },
  }
}

/** 送出去的 messages。匯出給測試看得到真的送了什麼。 */
export function describeMessages(text: string): unknown[] {
  return [
    { role: 'system', content: DESCRIBE_SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: DESCRIBE_USER },
        { type: 'text', text: textPayload(text) },
      ],
    },
  ]
}

/**
 * 模型回的東西 → 一筆描述，或 null（不採用）。
 *
 * 跟 parseView 同樣**嚴格**：剛好那三個欄位、都是字串、confidence 在固定選項裡。
 * 少一欄、多一欄、不是 JSON —— 一律 null，不存半筆。
 */
export function parseDescribe(raw: unknown): Described | null {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw) } catch { return null }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (Object.keys(o).length !== DESCRIBE_FIELDS.length) return null
  for (const f of DESCRIBE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(o, f)) return null
    if (typeof o[f] !== 'string') return null
  }
  const confidence = String(o.confidence).trim()
  if (!CONFIDENCES.includes(confidence)) return null
  const whatItIs = cleanField(String(o.whatItIs), DESCRIBE_FIELD_MAX)
  const subject = cleanField(String(o.subject), DESCRIBE_FIELD_MAX)
  // 講不出「這是什麼」就等於沒有答案 —— 空字串不值得存，也不值得拿去分組
  if (!whatItIs) return null
  return { whatItIs, subject, confidence }
}

/**
 * 「模型真的看不出來」的各種講法。**這些不算答案**：分組的時候它們毫無資訊量，
 * 而且會把一堆不相干的檔黏成一個叫「unknown」的大組。
 *
 * 跟 rename.ts 的 UNKNOWN_COURSES 是不同的清單 —— 那邊在認課名，這邊在認「一句推辭」。
 */
const NO_IDEA = [
  'unknown', 'unclear', 'not sure', 'cannot tell', "can't tell", 'n/a', 'na', 'none',
  'unidentified', 'unrecognizable', 'unknown document', 'unknown file',
  '看不出來', '未知', '不知道',
]

/** 這筆描述有沒有實際資訊。沒有的話這個檔就當成「分不了」，不進分組。 */
export function describeIsUseful(d: Described | null): boolean {
  if (!d) return false
  const key = d.whatItIs.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase()
  if (!key) return false
  return !NO_IDEA.includes(key)
}

/** 模型是不是連不上／沒設定。跟逐檔那條路同一個判斷，不另外發明。 */
export function describeEnabled(config: Config): boolean {
  return modelEnabled(config)
}

export { MAX_RESPONSE_BYTES, MODEL_TIMEOUT_MS }
