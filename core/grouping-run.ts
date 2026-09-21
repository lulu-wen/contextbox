/**
 * 分類那一次真的跑起來（P7，2026-09-21）—— core/grouping.ts 的**另一半**。
 *
 * `core/grouping.ts` 是純邏輯：洗名字、收斂、上限、送什麼。**它不碰網路也不碰資料庫。**
 * 這一支負責那三件會有副作用的事：
 *
 * 1. **問一次**（一次，不是一檔一次）：對象是「不重複的說法」，所以 1164 個檔跟 100 個檔同價。
 * 2. **寫對照表**：整份取代，一個交易。重新分類不會累積出兩份互相矛盾的。
 * 3. **一個檔都不動。** 提議不是動作（規格第 8 條）—— 搬檔走既有的 filing.ts。
 *
 * 模型在這裡**碰不到路徑**：它回的是資料夾名稱，洗過（cleanGroupName）才進資料庫，
 * 之後要組成路徑還會在 filing.ts 的 targetGroupDir 再洗一次、再確認在 filed 底下。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from './config.ts'
import { chatJson, escapeRawControlChars, modelEnabled, whyDisabled, type AskOptions } from './model.ts'
import {
  MAX_GROUPS, batches, capPhraseGroups, groupFormat, mergePhraseGroups, normalizePhraseGroups,
  phraseKey, phraseMessages, type PhraseGroup,
} from './grouping.ts'
import { groupCandidates, type FilingScope } from './filing.ts'

/**
 * 一次最多送這麼多種說法。
 *
 * distinctPhrases 是照出現次數排的，所以砍掉的是**長尾**：那些只有一兩個檔在用的怪說法
 * 本來就該落在「沒對到」。砍掉的要算進 unmatched，**不可以安靜消失**（規格第 6 條）。
 */
export const PHRASE_ASK_MAX = 200

/**
 * 一批問這麼多種說法。
 *
 * **原本想一次問完，實機打臉了**（2026-09-21，Qwen3-VL-8B）：177 種說法一次送進去，
 * 171 秒之後回來的答案在 max_tokens 被切成半截；把上限拉到 4000 就變成 307 秒、閘道
 * 直接斷線。而且沒被切掉的那部分也不能看 —— 模型把 18 到 120 號連號的一整段倒進
 * 同一個「Technical Reports」，那不是分類，那是切蛋糕。
 *
 * 40 個一批：42 秒回來，名字是 Lab reports／Exams／Scholarship applications 這種
 * 真的像資料夾的名字。**分批不是為了省錢，是因為分批的答案才是對的。**
 */
export const PHRASE_BATCH = 40

/** 一批的回答：最多十幾組、每組一串序號。40 行進來的話 1200 綽綽有餘。 */
export const GROUP_MAX_TOKENS = 1200

/**
 * 一批等這麼久。
 *
 * 逐檔的 60 秒是**一個檔**的預算：逾時就換下一個，那個檔下一輪再問。分類的一批逾時
 * 等於這一批的說法全部沒有去處，代價大得多，所以給得寬一點（實機一批 42 秒）。
 */
export const GROUP_TIMEOUT_MS = 120_000

/** 對照表裡的一組，讀回來給人看的樣子。 */
export type GroupMapRow = {
  folder: string
  why: string
  /** 對到這個資料夾的說法（已折鍵，小寫）。 */
  phrases: string[]
  at: string
}

/** 跑一次的結果。 */
export type GroupRun = {
  ok: boolean
  /** 失敗的原因（模型沒設定、連不上、答案形狀不對⋯）。成功就是 null。 */
  error: string | null
  /** 收斂出來的分類。**已經寫進資料庫了**（ok 的時候）。 */
  groups: PhraseGroup[]
  /** 問出去的那些說法。 */
  phrases: { phrase: string; count: number }[]
  /** 沒對到任何資料夾的說法（含超過 PHRASE_ASK_MAX 被砍掉的長尾）。 */
  unmatched: string[]
  /** 走分類那條路的檔案數。 */
  files: number
  /** 其中連「這是什麼文件」都說不出來的。 */
  speechless: number
  /** 真的問出去了幾批。 */
  asked: number
  ms: number
}

/** 一批做完會回報一次，給 CLI 印進度用（一批四十秒，不講話會像當掉）。 */
export type GroupProgress = {
  batch: number; batches: number
  /** 這一批問了幾種說法。 */
  phrases: number
  /** 到目前為止一共有幾個資料夾。 */
  folders: number
  /** 這一批失敗的話，失敗的原因。 */
  error?: string
}

/**
 * 模型回的字串 → 那個陣列。
 *
 * 跟 parseView 同一個策略：**只修跳脫，不補括號、不發明欄位。**
 * 引文裡一個裸 TAB 就讓 JSON.parse 失敗（2026-09-21 的教訓），那個要救；
 * 但形狀不對就是形狀不對，不猜。
 */
export function parseGroupAnswer(raw: unknown): unknown[] {
  const s = String(raw ?? '')
  if (!s.trim()) return []
  let body: any
  try { body = JSON.parse(s) }
  catch {
    try { body = JSON.parse(escapeRawControlChars(s)) } catch { return [] }
  }
  return Array.isArray(body?.groups) ? body.groups : []
}

/**
 * 「說法 → 資料夾」的對照表，**整份取代**。
 *
 * 一個交易：要嘛整份換好，要嘛一個字都沒動。半份換好的對照表會讓同一批檔
 * 一半照新分類、一半照舊分類 —— 那是使用者看得到的自相矛盾。
 */
export function writeGroupMap(db: DatabaseSync, groups: readonly PhraseGroup[], at = new Date().toISOString()): number {
  const ins = db.prepare('INSERT OR REPLACE INTO file_group_map (phrase, folder, why, at) VALUES (?,?,?,?)')
  let n = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('DELETE FROM file_group_map')
    for (const g of groups) {
      for (const p of g.phrases) {
        const key = phraseKey(p)
        if (!key) continue
        ins.run(key, g.name, g.why ?? '', at)
        n++
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 交易已經沒了 */ }
    throw e
  }
  return n
}

/** 對照表讀回來，照資料夾收在一起（涵蓋說法最多的排前面）。 */
export function readGroupMap(db: DatabaseSync): GroupMapRow[] {
  let rows: { phrase: string; folder: string; why: string | null; at: string }[] = []
  try {
    rows = db.prepare('SELECT phrase, folder, why, at FROM file_group_map ORDER BY folder, phrase').all() as typeof rows
  } catch { return [] }
  const byFolder = new Map<string, GroupMapRow>()
  for (const r of rows) {
    const hit = byFolder.get(r.folder)
    if (hit) { hit.phrases.push(r.phrase); continue }
    byFolder.set(r.folder, { folder: r.folder, why: r.why ?? '', phrases: [r.phrase], at: r.at })
  }
  return [...byFolder.values()].sort((a, b) =>
    b.phrases.length - a.phrases.length || (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0))
}

/**
 * 問一次、收斂、寫對照表。**保證不丟例外**（寫資料庫失敗除外 —— 那個要讓呼叫端知道）。
 *
 * 失敗的時候**對照表一個字都不動**：舊的分類還在，總比換成半份好。
 */
export async function runGrouping(
  db: DatabaseSync, config: Config, scope: FilingScope,
  opts: AskOptions & { onProgress?: (p: GroupProgress) => void } = {},
): Promise<GroupRun> {
  const started = Date.now()
  const { onProgress, ...ask } = opts
  const cand = groupCandidates(db, scope)
  const base = {
    groups: [] as PhraseGroup[], phrases: cand.phrases, unmatched: [] as string[],
    files: cand.files, speechless: cand.speechless, asked: 0,
  }
  const done = (ok: boolean, error: string | null, extra: Partial<GroupRun> = {}): GroupRun =>
    ({ ok, error, ...base, ...extra, ms: Date.now() - started })

  if (!modelEnabled(config)) return done(false, whyDisabled(config) ?? 'The model is not configured')
  if (!cand.phrases.length) return done(true, null, { groups: [] })

  // 長尾砍掉的算「沒對到」，不是消失（規格第 6 條）
  const asked = cand.phrases.slice(0, PHRASE_ASK_MAX)
  const tail = cand.phrases.slice(PHRASE_ASK_MAX).map(r => phraseKey(r.phrase))

  // **一批一批問**（為什麼不是一次，見 PHRASE_BATCH 的說明）。
  // 常見的說法排在前面，所以第一批取的名字最有代表性 —— 後面幾批帶著它沿用。
  const chunks = batches(asked, PHRASE_BATCH)
  const gathered: PhraseGroup[] = []
  let lastError: string | null = null
  let ok = 0
  for (const [i, chunk] of chunks.entries()) {
    const r = await chatJson(config, {
      messages: () => phraseMessages(chunk, mergePhraseGroups(gathered).map(g => g.name)),
      responseFormat: groupFormat(),
      maxTokens: GROUP_MAX_TOKENS,
      // 呼叫端給了就聽呼叫端的（測試會調小），沒給就用分類自己的預算
    }, { timeoutMs: GROUP_TIMEOUT_MS, ...ask })

    let why: string | undefined
    if (!r.ok) why = r.error
    else {
      const got = normalizePhraseGroups(parseGroupAnswer(r.content), chunk)
      if (!got.length) why = 'The model answered in the wrong shape'
      else { gathered.push(...got); ok++ }
    }
    // **一批壞掉不會拖垮其他幾批**（跟逐檔同一條規矩）：那一批的說法落在「沒對到」，繼續做下一批
    if (why) lastError = why
    onProgress?.({
      batch: i + 1, batches: chunks.length, phrases: chunk.length,
      folders: mergePhraseGroups(gathered).length, ...(why ? { error: why } : {}),
    })
    // 使用者按了 Ctrl+C 就停在這裡，已經問到的照樣算數
    if (ask.signal?.aborted) break
  }

  base.asked = ok
  if (!ok) {
    return done(false, lastError ?? 'The model answered in the wrong shape, so nothing was changed',
      { unmatched: [...tail] })
  }

  const { kept, droppedPhrases } = capPhraseGroups(mergePhraseGroups(gathered), MAX_GROUPS)

  const matched = new Set<string>()
  for (const g of kept) for (const p of g.phrases) matched.add(p)
  const unmatched = [...tail, ...droppedPhrases]
  for (const row of asked) {
    const k = phraseKey(row.phrase)
    if (k && !matched.has(k) && !unmatched.includes(k)) unmatched.push(k)
  }

  writeGroupMap(db, kept)
  // 有幾批壞掉的話還是算成功（對照表寫進去了），但要把最後一個原因帶回去給人看
  return done(true, ok === chunks.length ? null : lastError, { groups: kept, unmatched })
}
