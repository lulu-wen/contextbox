import { basename, extname } from 'node:path'
import { execRefusesName } from './cleanup-journal.ts'

/**
 * 規則版本。**理由（reason／evidence）的文字換了就要換版本**（稽核 2026-09-20）：
 * 那兩段字是**存起來的**（cleanup_candidates 那一列），鍵是 (item_id, kind, rule_version)。
 * 不換版本的話，舊資料庫在下一次完整掃描之前會把存起來的中文理由跟即時產生的英文片段
 * 拼在同一句裡 —— 面板第一眼就是半中半英。換了版本，舊那幾列配不上、新的照英文重建。
 */
export const CLEANUP_RULE_VERSION = 'cleanup-rules-v2-en'

/**
 * 每一種 kind 與它的信心值。**這裡是唯一的真值來源。**
 *
 * 之前上層是用一組寫死的「探針」輸入跑一次 classifyByRules 反推這張表。
 * 那個做法在結構上抓不到它被寫來抓的那件事 —— 新規則沒有對應探針就
 * 完全不會出現，上層的「列舉所有 kind」檢查看不到自己看不到的東西。
 * 稽查實測：加一條 55 分的新規則，23 條測試全綠。
 *
 * **加新規則就要在這裡加一行**，然後 test/cleanup-routes.test.mjs
 * 會強迫你決定它要不要預設勾。
 */
export const KIND_CONFIDENCE = {
  duplicate: 98,
  // 位元組不一樣，但**抽出來的文字一個字不差**（同一份 PDF 下載兩次，metadata 不同）。
  // 45 < DEFAULT_CHECK_MIN（50）＝ **列得出來、勾得起來，但永遠不預設勾**。
  // 文字一樣不等於檔案一樣：兩份 PDF 可以文字層相同、圖片不同，所以這個判斷
  // 不足以代替 sha256。要清得由使用者自己看過再伸手勾（旁邊就有 View contents）。
  'same-text': 45,
  partial: 95,
  empty: 95,
  temp: 85,
  installer: 70,
  archive: 65,
  'old-download': 35,
  'screenshot-noise': 35,
} as const

export const CLEANUP_KINDS = Object.keys(KIND_CONFIDENCE) as (keyof typeof KIND_CONFIDENCE)[]

export type CleanupCandidateKind =
  | 'duplicate'
  | 'same-text'
  | 'installer'
  | 'archive'
  | 'temp'
  | 'empty'
  | 'old-download'
  | 'partial'
  | 'screenshot-noise'

export type CleanupRuleInput = {
  path: string
  name?: string
  ext?: string
  bytes: number
  mtimeMs: number
  nowMs?: number
  sha256?: string | null
}

export type CleanupCandidateDraft = {
  kind: CleanupCandidateKind
  confidence: number
  reason: string
  evidence: string
}

export const PARTIAL_EXT = new Set([
  '.crdownload',
  '.part',
  '.partial',
  '.download',
  '.opdownload',
  '.filepart',
])

export const TEMP_EXT = new Set([
  '.tmp',
  '.temp',
])

export const INSTALLER_EXT = new Set([
  '.dmg',
  '.pkg',
  '.msi',
  '.exe',
])

export const ARCHIVE_EXT = new Set([
  '.zip',
  '.rar',
  '.7z',
  '.tar',
  '.gz',
  '.tgz',
])

export const PROTECTED_EXT = new Set([
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
  '.key',
  '.pages',
  '.numbers',
  '.txt',
  '.md',
])

const DAY = 24 * 60 * 60 * 1000

export const ageDays = (mtimeMs: number, nowMs: number = Date.now()): number =>
  Math.max(0, Math.floor((nowMs - mtimeMs) / DAY))

export function isScreenshotNoiseName(name: string): boolean {
  return /^(screenshot|screen shot|截圖|螢幕擷取|螢幕快照)[\s_\-（(]*/i.test(name)
}

function extOf(input: CleanupRuleInput): string {
  return (input.ext ?? extname(input.path)).toLowerCase()
}

function nameOf(input: CleanupRuleInput): string {
  return input.name ?? basename(input.path)
}

function draft(kind: CleanupCandidateKind, confidence: number, reason: string, evidence: string): CleanupCandidateDraft {
  return { kind, confidence, reason, evidence }
}

/**
 * 純規則分類。duplicate 需要看資料庫裡的其他檔案，由 scanner 另外補。
 *
 * 這裡不碰硬碟也不碰資料庫，讓規則可以很便宜地測。每一條輸出都帶
 * reason/evidence，因為 UI 要把「為什麼覺得能丟」講給使用者聽。
 */
export function classifyByRules(input: CleanupRuleInput): CleanupCandidateDraft[] {
  const nowMs = input.nowMs ?? Date.now()
  const days = ageDays(input.mtimeMs, nowMs)
  const ext = extOf(input)
  const name = nameOf(input)
  const out: CleanupCandidateDraft[] = []

  // **執行層不收的檔一律不提議。** 名單跟執行層是同一份（見 cleanup-journal.ts）。
  // 提議了也搬不動：列得出、勾得起、建得了計畫，套用時永遠回 PROTECTED。
  if (execRefusesName(name)) return out

  if (PARTIAL_EXT.has(ext) && days >= 1) {
    out.push(draft(
      'partial',
      95,
      'A half-finished download',
      `${ext} extension, and untouched for ${days} days`,
    ))
  }

  if (input.bytes === 0 && days >= 1) {
    out.push(draft(
      'empty',
      95,
      'An empty file',
      `0 bytes, and untouched for ${days} days`,
    ))
  }

  if (input.bytes > 0 && TEMP_EXT.has(ext) && days >= 7) {
    out.push(draft(
      'temp',
      85,
      'An old temporary file',
      `${ext} temporary file, and untouched for ${days} days`,
    ))
  }

  if (INSTALLER_EXT.has(ext) && days >= 14) {
    out.push(draft(
      'installer',
      70,
      'Old installers rarely need to stay in Downloads',
      `${ext} installer, and untouched for ${days} days`,
    ))
  }

  if (ARCHIVE_EXT.has(ext) && days >= 30) {
    out.push(draft(
      'archive',
      65,
      'Old archives are usually one-off downloads',
      `${ext} archive, and untouched for ${days} days`,
    ))
  }

  if (!PROTECTED_EXT.has(ext) && days >= 90) {
    out.push(draft(
      'old-download',
      35,
      'A download nobody has touched in a long time',
      `untouched for ${days} days, and ${ext || '(no extension)'} is not on the protected list`,
    ))
  }

  if (isScreenshotNoiseName(name) && days >= 30) {
    out.push(draft(
      'screenshot-noise',
      35,
      'Old screenshots are usually throwaway',
      `Named ${name}, and untouched for ${days} days`,
    ))
  }

  return out
}

/**
 * 連拍截圖的候選版本。**跟一般規則分開**（CLEANUP_RULE_VERSION）：
 * 它不是看檔名與時間算出來的，是看長相算出來的（core/imagehash.ts），
 * 兩者的 kind 都是 screenshot-noise，靠 rule_version 分得開，UNIQUE 也不會打架。
 *
 * **兩個版本都建得了計畫**（PLANNABLE_RULE_VERSIONS）：連拍區勾起來就要搬得動，
 * 不然又是「列得出、勾得起、建不了計畫」那個坑。差別只在**誰把它列出來**：
 * 一般規則走候選清單與徽章，連拍走 GET /cleanup/bursts 與寵物的主動詢問 ——
 * 連拍不進清單是刻意的（它有自己的區塊、要看縮圖才決定），不是因為建不了計畫。
 */
export const BURST_RULE_VERSION = 'burst-1'

/**
 * **現在還算數的規則版本，全部。**
 *
 * 候選清單一定要用版本過濾（舊版的 proposed 列會永久活著，見 collect 的說明），
 * 但過濾的時候不可以只寫 CLEANUP_RULE_VERSION —— 連拍的候選帶的是 BURST_RULE_VERSION，
 * 漏掉它的話那幾個檔永遠不在清單上，而面板規定「不在清單上就不給勾」：
 * 結果是連拍區的勾選框**永遠勾不動**，整個功能在畫面上是死的
 * （2026-09-21 使用者回報「burst 還是沒辦法打勾」，實機重現）。
 *
 * 兩個版本號分開是刻意的：連拍規則要能自己改版而不作廢一般候選。
 * 以後再加第三條線，記得也加進這裡。
 */
export const CURRENT_RULE_VERSIONS: readonly string[] =
  Object.freeze([CLEANUP_RULE_VERSION, BURST_RULE_VERSION])

/** 可以進清理計畫的候選版本。 */
export const PLANNABLE_RULE_VERSIONS = [CLEANUP_RULE_VERSION, BURST_RULE_VERSION]

/**
 * 連拍候選的信心：**照等級**，不是一律 70。
 * same（全解析度上幾乎沒有任何像素變化）70 ≥ DEFAULT_CHECK_MIN（50）→ 預設勾；
 * similar（看得到的變化，面板會框出來）40 < 50 → 預設不勾。
 */
export const BURST_CONFIDENCE = { same: 70, similar: 40 } as const

/**
 * 連拍候選的理由與證據。`keepName` 是留下的那張的檔名、`gapSec` 是跟它相隔幾秒。
 * **不帶路徑**（跟其他 draft 一樣，UI 只拿得到檔名）。
 */
export function burstDraft(level: 'same' | 'similar', keepName: string, gapSec: number): CleanupCandidateDraft {
  return draft(
    'screenshot-noise',
    BURST_CONFIDENCE[level],
    level === 'same'
      ? `Almost identical to “${keepName}”`
      : `Much like “${keepName}”`,
    `Same burst, ${gapSec}s apart; “${keepName}” is the one being kept`,
  )
}

/**
 * 位元組不同、抽出來的文字一模一樣（2026-09-21 使用者實機回報）。
 *
 * `.pdf`／`.docx` 在 PROTECTED_EXT 裡，90 天的 old-download 規則不挑它們；
 * 而 duplicate 要求 sha256 完全相同，重新下載一次的 PDF 位元組就不一樣了
 *（metadata、時間戳）。兩條路都斷掉，所以「最新(第18-20題)…(1).pdf」與「(2).pdf」
 * 這種一眼就看得出重複的檔，從來不會出現在清理清單上。
 *
 * **信心 45 ＝ 不預設勾。** 文字一樣不等於檔案一樣（兩份 PDF 可以文字層相同、圖片不同），
 * 所以這條只負責「讓你看得到」，要不要清是你自己按下去的。證據指名留的是哪一份。
 */
export function sameTextDraft(keepName: string, count: number): CleanupCandidateDraft {
  const others = count - 1
  return draft(
    'same-text',
    KIND_CONFIDENCE['same-text'],
    `Reads exactly the same as “${keepName}”`,
    `${others} other file${others === 1 ? '' : 's'} ${others === 1 ? 'has' : 'have'} identical text`
      + ` but different bytes; “${keepName}” is the one being kept`,
  )
}

export function duplicateDraft(count: number): CleanupCandidateDraft {
  return draft(
    'duplicate',
    98,
    'A duplicate — same contents',
    `${count - 1} other file${count - 1 === 1 ? '' : 's'} ${count - 1 === 1 ? 'has' : 'have'} the same sha256`,
  )
}
