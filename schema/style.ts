/**
 * ContextBox — 生成與筆調學習
 *
 * compose 類型的欄位（自傳、工作說明、求職信）不自動填，由 agent 寫。
 * 寫完讓人改，從改動裡學習——但**不是每個改動都該學**。這一支的重點就在這裡。
 */

// ──────────────────────────────────────────────────────────────
// 一、筆調
// ──────────────────────────────────────────────────────────────

/** 一次性抽出來的底：從你過去寫的 5–10 段東西 */
export type StyleCard = {
  sentenceLength: 'short' | 'medium' | 'long'
  formality: 1 | 2 | 3 | 4 | 5
  quirks: string[]        // 「習慣先講結論」「愛用破折號」
  vocabulary: string[]    // 常出現的詞
  avoid: string[]         // 從來不用的詞 —— 比常用詞更能抓到人味
  samples: string[]       // 3 段原文，生成時直接塞 prompt
  updatedAt: string
}

/**
 * 從你的修改裡長出來的規則。
 *
 * 刻意做成一條一條、看得懂、刪得掉的句子，不是一團黑箱 prompt。
 * 使用者不知道系統記住了什麼，就不會信任它，也就不會用。
 */
export type StyleRule = {
  id: string
  rule: string                 // 「不要用『賦能』『打造』『深耕』這類詞」
  scope: 'always' | 'autobiography' | 'cover_letter' | 'work_description'
  learnedFrom: {
    at: string
    before: string             // 改之前那一段
    after: string              // 改之後那一段
  }
  timesApplied: number         // 用得多的排前面
  lastConfirmedAt: string
  createdAt: string
}

/** 規則會無限累積，所以要有上限。滿了淘汰最少用、最久沒確認的。 */
export const MAX_STYLE_RULES = 30

// ──────────────────────────────────────────────────────────────
// 二、生成
// ──────────────────────────────────────────────────────────────

export type ComposeRequest = {
  key: string                  // 'writing.autobiography'
  purpose?: string             // 「應徵後端工程師」—— 同一份自傳，不同目的寫法不同
  maxLength?: number
  useFacts: string[]           // 允許用哪些事實的 id。沒給的它不准寫。
}

export type ComposeResult = {
  id: string
  key: string
  text: string
  /** 每一段用了哪些事實。跟事實卡同一個原則：你要能問「你哪來的？」 */
  paragraphs: { text: string; usedFacts: string[] }[]
  styleRulesApplied: string[]  // 這次套了哪幾條規則
  model: string
  createdAt: string
}

// ──────────────────────────────────────────────────────────────
// 三、學習 —— 這裡是整個設計的重點
// ──────────────────────────────────────────────────────────────

/**
 * 使用者改了一段文字，有三種可能。只有第三種該學。
 *
 *  fact  —— 事實錯了。「我不是 2020 進去的，是 2021」
 *           → 要回頭改**事實庫**，不是記成寫作習慣。
 *           記成習慣的話，下次它會寫出「注意使用者是 2021 進去的」這種鬼東西。
 *
 *  once  —— 這次不想這樣寫。「這份工作別提那個專案」
 *           → 不學。下次換一家公司，這個限制根本不適用。
 *
 *  style —— 真的是筆調。「不要用『賦能』」「句子太長」「不要驚嘆號」
 *           → 這個才進 StyleRule。
 */
export type EditKind = 'fact' | 'once' | 'style'

export type EditFeedback = {
  composeId: string
  paragraphIndex: number
  before: string
  after: string
  kind: EditKind
  /** kind='fact' 時，指向該修正的那筆事實 */
  factToFix?: string
  /** kind='style' 時，系統提議的規則文字，人可以自己改 */
  proposedRule?: string
}

/**
 * 分類的做法：**不要猜，用問的。**
 *
 * 自動偵測看起來很聰明，但分不出「這句話寫錯了」和「我不喜歡這種寫法」。
 * 猜錯的成本很高：規則庫被垃圾塞滿，生成品質反而越用越差。
 *
 * 所以人改完之後，給一個很輕的 modal，三個按鈕，五秒鐘：
 *
 *   你把「賦能團隊」改成「幫團隊」。
 *     [ 以後都避開這類詞 ]   [ 這次就好 ]   [ 是資料錯了 ]
 *
 * 這比任何自動偵測都準，而且使用者**知道系統記住了什麼**，才會信任它。
 * 模型只負責一件事：把改動寫成一句人看得懂的規則草稿，人可以直接改那句話。
 */
export type FeedbackPrompt = {
  before: string
  after: string
  proposedRule: string         // 模型寫的草稿，使用者可改
  options: [
    { kind: 'style'; label: '以後都這樣' },
    { kind: 'once';  label: '這次就好' },
    { kind: 'fact';  label: '是資料錯了' },
  ]
}

/** 只比對改過的段落，不做逐字 diff——散文的逐字 diff 只會是雜訊。 */
export function changedParagraphs(before: string[], after: string[]) {
  const out: { index: number; before: string; after: string }[] = []
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    const b = (before[i] ?? '').trim()
    const a = (after[i] ?? '').trim()
    if (b !== a) out.push({ index: i, before: b, after: a })
  }
  return out
}

/** 生成時，規則怎麼排進 prompt：用得多的、最近確認過的放前面 */
export function rankRules(rules: StyleRule[], scope: StyleRule['scope']) {
  return rules
    .filter(r => r.scope === 'always' || r.scope === scope)
    .sort((a, b) =>
      b.timesApplied - a.timesApplied ||
      b.lastConfirmedAt.localeCompare(a.lastConfirmedAt))
}

/** 規則滿了：淘汰最少用、最久沒確認的那一條 */
export function evict(rules: StyleRule[]): StyleRule[] {
  if (rules.length <= MAX_STYLE_RULES) return rules
  const sorted = [...rules].sort((a, b) =>
    a.timesApplied - b.timesApplied ||
    a.lastConfirmedAt.localeCompare(b.lastConfirmedAt))
  return rules.filter(r => r.id !== sorted[0].id)
}
