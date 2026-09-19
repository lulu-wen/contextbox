import { basename, extname } from 'node:path'
import { execRefusesName } from './cleanup-journal.ts'

export const CLEANUP_RULE_VERSION = 'cleanup-rules-v1'

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
      '下載中斷留下的半成品',
      `${ext} 副檔名，而且 ${days} 天沒有變動`,
    ))
  }

  if (input.bytes === 0 && days >= 1) {
    out.push(draft(
      'empty',
      95,
      '空檔案',
      `檔案大小是 0 byte，而且 ${days} 天沒有變動`,
    ))
  }

  if (input.bytes > 0 && TEMP_EXT.has(ext) && days >= 7) {
    out.push(draft(
      'temp',
      85,
      '舊暫存檔',
      `${ext} 暫存檔，而且 ${days} 天沒有變動`,
    ))
  }

  if (INSTALLER_EXT.has(ext) && days >= 14) {
    out.push(draft(
      'installer',
      70,
      '舊安裝檔通常裝完就不需要留在 Downloads',
      `${ext} 安裝檔，而且 ${days} 天沒有變動`,
    ))
  }

  if (ARCHIVE_EXT.has(ext) && days >= 30) {
    out.push(draft(
      'archive',
      65,
      '舊壓縮檔通常是一次性下載',
      `${ext} 壓縮檔，而且 ${days} 天沒有變動`,
    ))
  }

  if (!PROTECTED_EXT.has(ext) && days >= 90) {
    out.push(draft(
      'old-download',
      35,
      '很久沒有動過的下載檔',
      `${days} 天沒有變動，且副檔名 ${ext || '（沒有）'} 不在保護清單`,
    ))
  }

  if (isScreenshotNoiseName(name) && days >= 30) {
    out.push(draft(
      'screenshot-noise',
      35,
      '舊截圖常常是暫時資訊',
      `檔名是 ${name}，而且 ${days} 天沒有變動`,
    ))
  }

  return out
}

export function duplicateDraft(count: number): CleanupCandidateDraft {
  return draft(
    'duplicate',
    98,
    '同內容的重複檔案',
    `同一個 sha256 還有 ${count - 1} 份檔案存在`,
  )
}
