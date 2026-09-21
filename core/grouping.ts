/**
 * 讓 agent 自己總結分類（P7，2026-09-21）。規格：docs/grouping-spec.md
 *
 * 使用者的話：
 *
 * > rename 或 file 的清單應該還要根據 agent 自己讀到的所有檔案去做總結說可以歸類成哪些。
 * > 而不是因為 rule 裡面只有要歸類 course 就其他都不幫忙分類？
 *
 * 現在的 `file` 只認得 `Courses/<課名>/<kind>`，課名說不出來就整個檔放棄
 * （filing.ts：`if (!course) continue`）。實機上那是 84/88 的檔。
 *
 * 這一支負責**分組那一半的純邏輯**：把描述整理成摘要行送出去、把模型回的分組洗乾淨。
 * 模型呼叫與資料庫在別的地方，這裡一個 I/O 都沒有 —— 規格裡那幾條不變量才測得動。
 */

import { cleanField } from './model.ts'

/** 一批最多幾行摘要。1164 個檔塞不進一次 prompt。 */
export const GROUP_BATCH = 120

/** 最多提議幾組。太多組等於沒分類。 */
export const MAX_GROUPS = 12

/** 殘料少於這個數就不提議 —— 三個檔分成兩組是雜訊，不是幫忙。 */
export const MIN_RESIDUE = 20

/** 分類名稱最多幾個碼位。它會變成磁碟上的資料夾名。 */
export const GROUP_NAME_MAX = 40

/** 一句理由最多幾個字。 */
export const GROUP_WHY_MAX = 160

/** 分組要看的一列：一個檔的摘要。**沒有內容原文**，只有模型自己產生的短字串。 */
export type DigestRow = {
  itemId: string
  name: string
  kind: string
  whatItIs: string
  subject: string
}

/** 模型提議的一組。 */
export type ProposedGroup = {
  name: string
  why: string
  itemIds: string[]
}

/**
 * 摘要行 → 送出去的那段文字。
 *
 * **只送模型自己產生的描述，不送檔案原文。** evidence 與 file_texts 的內容一個字都不進來：
 * 逐檔那條路送過一次是必要的（不看內容答不出來），分組只需要「模型怎麼描述它」。
 * 而且量大 40 倍 —— 沒有理由把整批原文再送一次。
 *
 * 檔名是不可信的輸入（別人決定的），一律 cleanField 之後才進 prompt。
 * 行號是**這一批裡的序號**，模型用它指回來，所以不必讓它看到 itemId（那是我們的內部 id）。
 */
export function digestText(rows: readonly DigestRow[]): string {
  return rows.map((r, i) =>
    `${i + 1}. ${cleanField(r.name, 120)} | ${cleanField(r.kind, 40)}`
    + ` | ${cleanField(r.whatItIs, 120)} | ${cleanField(r.subject, 120)}`
  ).join('\n')
}

/** 分批。最後一批可能不滿。 */
export function batches<T>(rows: readonly T[], size = GROUP_BATCH): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

/**
 * 分類名稱 → 安全的資料夾名。用不了回空字串（＝這一組丟掉）。
 *
 * 跟 rename.ts 的 cleanCourse 同一條規矩：模型回 `../../etc` 只會變成 `etc`，
 * 跳不出 filed 那棵樹。這裡**不能**直接 import cleanCourse —— 那一支還會擋
 * 「Unknown」那幾個字（它在認課名），而分組的名字叫 "Unknown documents" 是合理的。
 */
export function cleanGroupName(raw: unknown): string {
  let s = cleanField(String(raw ?? ''), GROUP_NAME_MAX * 4)
  // 路徑分隔符號與 .. 一律拆掉：名字只能是一段，不能是一條路徑
  s = s.split('/').join(' ').split('\\').join(' ').replace(/\.\.+/g, ' ')
  // Windows 不收的字元
  s = s.replace(/[<>:"|?*]/g, ' ').replace(/\s+/g, ' ').trim()
  // 前後的點與空白（Windows 會安靜地吃掉結尾的點）
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  if (!s) return ''
  s = [...s].slice(0, GROUP_NAME_MAX).join('').replace(/[.\s]+$/, '')
  if (!s) return ''
  // Windows 保留名稱
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) return ''
  return s
}

/**
 * 模型回的分組 → 可以用的提議。
 *
 * `rows` 是這一批送出去的摘要行（序號 1 起算），`raw` 是模型回的東西。
 * 守的性質（規格第 3 節）：
 *
 * - 名字洗完是空的 → 整組丟掉
 * - **一個檔最多只能出現在一組裡** —— 重複的留第一組。不然它會被兩條路各搬一次
 * - 指到不存在的序號 → 忽略那一個，不是丟掉整組
 * - 一個成員都不剩 → 整組丟掉
 */
export function normalizeGroups(raw: unknown, rows: readonly DigestRow[]): ProposedGroup[] {
  const list = Array.isArray(raw) ? raw : []
  const taken = new Set<string>()
  const out: ProposedGroup[] = []
  for (const g of list) {
    const name = cleanGroupName((g as any)?.name)
    if (!name) continue
    const why = cleanField(String((g as any)?.why ?? ''), GROUP_WHY_MAX)
    const members = Array.isArray((g as any)?.members) ? (g as any).members : []
    const itemIds: string[] = []
    for (const m of members) {
      const n = Number(m)
      if (!Number.isInteger(n) || n < 1 || n > rows.length) continue
      const id = rows[n - 1].itemId
      if (taken.has(id)) continue
      taken.add(id)
      itemIds.push(id)
    }
    if (!itemIds.length) continue
    out.push({ name, why, itemIds })
  }
  return out
}

/**
 * 同名的組合併（跨批會撞到：每一批各自回「Research papers」）。
 * 名字比對折過大小寫與空白，**留第一次出現的寫法**。
 */
export function mergeGroups(groups: readonly ProposedGroup[]): ProposedGroup[] {
  const key = (s: string) => s.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase()
  const byKey = new Map<string, ProposedGroup>()
  for (const g of groups) {
    const k = key(g.name)
    const hit = byKey.get(k)
    if (!hit) { byKey.set(k, { name: g.name, why: g.why, itemIds: [...g.itemIds] }); continue }
    for (const id of g.itemIds) if (!hit.itemIds.includes(id)) hit.itemIds.push(id)
    if (!hit.why && g.why) hit.why = g.why
  }
  return [...byKey.values()]
}

/**
 * 組數上限。超過就留檔案數最多的前 `MAX_GROUPS` 組，其餘**退回「沒分到」**。
 *
 * 回傳被砍掉的那些組的成員（呼叫端要把它們算進「沒分到」的數字裡）——
 * **不可以安靜消失**：畫面上加起來的數字要等於總數（規格第 11、12 條）。
 */
export function capGroups(
  groups: readonly ProposedGroup[], max = MAX_GROUPS,
): { kept: ProposedGroup[]; droppedItemIds: string[] } {
  if (groups.length <= max) return { kept: [...groups], droppedItemIds: [] }
  const sorted = [...groups].sort((a, b) =>
    b.itemIds.length - a.itemIds.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const kept = sorted.slice(0, max)
  const droppedItemIds: string[] = []
  for (const g of sorted.slice(max)) droppedItemIds.push(...g.itemIds)
  return { kept, droppedItemIds }
}

/** 分組那一次要的回答格式。自由文字欄位一律有上限（2026-09-21 的教訓）。 */
export function groupFormat(): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'contextbox_groups',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['groups'],
        properties: {
          groups: {
            type: 'array',
            maxItems: MAX_GROUPS,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'why', 'members'],
              properties: {
                name: { type: 'string', maxLength: GROUP_NAME_MAX, description: 'A short folder name' },
                why: { type: 'string', maxLength: GROUP_WHY_MAX, description: 'One line: what belongs here' },
                members: {
                  type: 'array',
                  items: { type: 'integer' },
                  description: 'The line numbers from the list that belong in this group',
                },
              },
            },
          },
        },
      },
    },
  }
}

export const GROUP_SYSTEM =
  'You are given a list of documents someone has in their Downloads folder. '
  + 'Each line is: number. filename | kind | what it is | what it is about. '
  + 'Propose a small number of folders that these documents naturally fall into, '
  + 'based only on what the list actually shows. '
  + 'Do not invent groups for documents that are not there, and do not force every document into a group — '
  + 'leave out the ones that do not clearly belong anywhere. '
  + 'Answer in English.'

export const GROUP_USER =
  'name: a short folder name, in English, no path separators. '
  + 'why: one line saying what belongs in it. '
  + 'members: the line numbers that belong in it. '
  + 'Prefer a few meaningful groups over many tiny ones. Every number may appear in at most one group.'

/** 送出去的 messages。匯出給測試看得到真的送了什麼。 */
export function groupMessages(rows: readonly DigestRow[]): unknown[] {
  return [
    { role: 'system', content: GROUP_SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: GROUP_USER },
        { type: 'text', text: digestText(rows) },
      ],
    },
  ]
}

// ── centroid：對「不重複的說法」分群，不是對檔案分群 ────────────────
//
// 使用者（2026-09-21）：
//   > 像是 centroid 的感覺一樣，看那些檔案都比較靠近哪一個點? 以那個點來做分類之類的
//   > 所以應該是要根據 whatItIs 來看要如何衍生出新的分類
//
// 1164 個檔 → 取 distinct whatItIs → 一兩百種說法 → **一次呼叫**收斂成 ~8 個資料夾。
// 「點」是從資料自己長出來的，不是預先寫死的。而且因為對象是說法不是檔案，
// 1164 個檔跟 100 個檔成本一樣，都是一次呼叫。

/** 說法的比對鍵：折大小寫與空白。`Resume` 與 `resume ` 是同一種說法。 */
export function phraseKey(s: unknown): string {
  return String(s ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase()
}

/**
 * 一堆 whatItIs → 不重複的說法，**照出現次數多的排前面**。
 *
 * 排序是刻意的：一次塞不完的時候，先問最常見的那些 ——
 * 涵蓋的檔案數最多，而長尾的怪說法本來就該落在「沒對到」。
 */
export function distinctPhrases(values: readonly unknown[]): { phrase: string; count: number }[] {
  const seen = new Map<string, { phrase: string; count: number }>()
  for (const v of values) {
    const k = phraseKey(v)
    if (!k) continue
    const hit = seen.get(k)
    if (hit) { hit.count++; continue }
    // 留第一次出現的寫法（不折大小寫），那是給人看的
    seen.set(k, { phrase: cleanField(String(v), 120), count: 1 })
  }
  return [...seen.values()].sort((a, b) =>
    b.count - a.count || (a.phrase < b.phrase ? -1 : a.phrase > b.phrase ? 1 : 0))
}

/** 送出去的那一段：一行一個說法，帶檔案數。**沒有檔名、沒有原文。** */
export function phraseDigest(rows: readonly { phrase: string; count: number }[]): string {
  return rows.map((r, i) => `${i + 1}. ${cleanField(r.phrase, 120)} (${r.count})`).join('\n')
}

// **「少而有意義」要給範圍，不然會過度執行。** 第一次實測只講 prefer a few，
// 模型回了三組 academic／professional／technical —— 而 professional 裡同時有
// resume、invoice、receipt。那種名字放到磁碟上等於沒有分類。
export const PHRASE_SYSTEM =
  'You are given a list of short phrases describing the kinds of documents someone has, '
  + 'each with how many files use that phrase. '
  + 'Group the phrases into folders that would make sense on disk. '
  + 'Put synonyms together — "resume" and "CV" belong in one folder. '
  + 'Aim for between 4 and 10 folders. '
  + '**Name each folder after what is actually in it**, the way someone would name a real folder: '
  + '"Resumes", "Lab handouts", "Research papers", "Application forms". '
  + 'Do not use vague umbrella names like "Documents", "Misc", "Other", "Personal", '
  + '"Professional", "Academic" or "Technical" — a folder that could hold anything is not a folder. '
  + 'Do not put unrelated kinds together just to reduce the count: '
  + 'a resume and an invoice do not belong in the same folder. '
  + 'Leave out phrases that do not clearly belong anywhere. Answer in English.'

export const PHRASE_USER =
  'name: a short folder name, in English, no path separators. '
  + 'why: one line saying what belongs in it. '
  + 'members: the line numbers of the phrases that belong in it. '
  + 'Every number may appear in at most one folder.'

export function phraseMessages(rows: readonly { phrase: string; count: number }[]): unknown[] {
  return [
    { role: 'system', content: PHRASE_SYSTEM },
    { role: 'user', content: [{ type: 'text', text: PHRASE_USER }, { type: 'text', text: phraseDigest(rows) }] },
  ]
}

/** 一組分類：資料夾名 ＋ 一句理由 ＋ 對到它的那些說法（已折鍵）。 */
export type PhraseGroup = { name: string; why: string; phrases: string[] }

/**
 * 模型回的分組 → 「說法 → 資料夾」的對照表。
 *
 * 守的性質跟 normalizeGroups 一樣（名字洗不出來就整組丟掉、一個說法只能進一組、
 * 指到不存在的序號就忽略），只是對象從檔案換成說法。
 */
export function normalizePhraseGroups(
  raw: unknown, rows: readonly { phrase: string; count: number }[],
): PhraseGroup[] {
  const list = Array.isArray(raw) ? raw : []
  const taken = new Set<string>()
  const out: PhraseGroup[] = []
  for (const g of list) {
    const name = cleanGroupName((g as any)?.name)
    if (!name) continue
    const why = cleanField(String((g as any)?.why ?? ''), GROUP_WHY_MAX)
    const members = Array.isArray((g as any)?.members) ? (g as any).members : []
    const phrases: string[] = []
    for (const m of members) {
      const n = Number(m)
      if (!Number.isInteger(n) || n < 1 || n > rows.length) continue
      const k = phraseKey(rows[n - 1].phrase)
      if (!k || taken.has(k)) continue
      taken.add(k)
      phrases.push(k)
    }
    if (!phrases.length) continue
    out.push({ name, why, phrases })
  }
  return out
}

/**
 * 組數上限。超過就留**涵蓋說法最多**的前 MAX_GROUPS 組，其餘算「沒對到」。
 * 回傳被砍掉的說法（呼叫端要算進「沒對到」的數字，不可以安靜消失）。
 */
export function capPhraseGroups(
  groups: readonly PhraseGroup[], max = MAX_GROUPS,
): { kept: PhraseGroup[]; droppedPhrases: string[] } {
  if (groups.length <= max) return { kept: [...groups], droppedPhrases: [] }
  const sorted = [...groups].sort((a, b) =>
    b.phrases.length - a.phrases.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const dropped: string[] = []
  for (const g of sorted.slice(max)) dropped.push(...g.phrases)
  return { kept: sorted.slice(0, max), droppedPhrases: dropped }
}
