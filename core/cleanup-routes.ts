/**
 * 清理功能的唯讀層：組清單、組健康狀態、掛 HTTP route。
 *
 * ── 這一支為什麼存在 ─────────────────────────────────────────
 *
 * A 的 scanner 把候選寫進 `cleanup_candidates`，一筆規則一列。
 * 但**使用者看的是「這個檔要不要清」，不是「這條規則要不要套用」** ——
 * 一個 90 天沒動的 zip 同時命中 archive 與 old-download，在 UI 上出現兩次就是 bug。
 *
 * 所以這一層做三件事：
 *   1. 以**檔案**為單位聚合，理由全部留著
 *   2. 決定**預設勾不勾**（見 DEFAULT_CHECK_MIN）
 *   3. **把絕對路徑擋在後端** —— 回給 UI 的東西裡不可以有完整路徑
 *
 * CLI 與 HTTP route 都呼叫 `listCandidates()`。
 * **只有一個地方決定 defaultChecked**，不准有第二份。
 */
import { statSync, readdirSync, existsSync } from 'node:fs'
import { basename, dirname, relative, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { classifyByRules, duplicateDraft } from './cleanup-rules.ts'

/**
 * 信心到多少才預設打勾。
 *
 * **這個數字是規格的洞，不是隨便訂的。** spec 第 5 節的表只明說
 * 「低信心，預設不勾」，中信心那兩格（installer 70、archive 65）沒講勾不勾。
 *
 * 決定性的證據在 spec 第 0 節的 demo 主線：把 `.zip`、重複檔、空檔、
 * **安裝包**丟進 Downloads，「使用者點同意，Downloads 變乾淨」。
 * archive 與 installer 都在那句話的範圍裡，所以中信心也要勾。
 *
 * 實際的信心值是 35（低）與 65（中）兩群，中間沒有東西。取 50，
 * 兩邊各留 15 的餘裕 —— 以後調規則的信心值才不會意外翻邊。
 *
 * 誤刪的風險不是靠「預設不勾」擋的，是靠：先隔離不刪除、七天、
 * 逐項可取消、一鍵復原。
 */
export const DEFAULT_CHECK_MIN = 50

/**
 * 每一種 kind 的信心值，**從 cleanup-rules.ts 真的跑一次取出來**，不抄第二份。
 * 抄的話兩邊會慢慢漂開，而這個數字直接決定要不要幫使用者勾。
 */
export const KIND_CONFIDENCE: Record<string, number> = (() => {
  const out: Record<string, number> = { duplicate: duplicateDraft(2).confidence }
  const day = 24 * 60 * 60 * 1000
  const now = Date.now()
  const probes = [
    { name: 'a.crdownload', ext: '.crdownload', bytes: 10, days: 3 },
    { name: 'a.log', ext: '.log', bytes: 0, days: 3 },
    { name: 'a.tmp', ext: '.tmp', bytes: 10, days: 10 },
    { name: 'a.msi', ext: '.msi', bytes: 10, days: 30 },
    { name: 'a.zip', ext: '.zip', bytes: 10, days: 60 },
    { name: 'a.bin', ext: '.bin', bytes: 10, days: 200 },
    { name: 'Screenshot x.png', ext: '.png', bytes: 10, days: 120 },
  ]
  for (const p of probes) {
    for (const d of classifyByRules({
      path: '/tmp/' + p.name, name: p.name, ext: p.ext,
      bytes: p.bytes, mtimeMs: now - p.days * day, nowMs: now,
    })) {
      out[d.kind] = d.confidence
    }
  }
  return out
})()

export type CandidateReason = {
  kind: string
  confidence: number
  reason: string
  evidence: string
}

/** 一個**檔案**一列。UI 與 CLI 看到的都是這個。 */
export type CandidateRow = {
  itemId: string
  name: string
  /** 監看資料夾的顯示名（最後一段），不是完整路徑 */
  folder: string
  /** 相對於監看資料夾的子目錄。root 底下就是空字串 */
  subdir: string
  bytes: number
  mtime: string
  /** 信心最高的那一條 */
  kind: string
  confidence: number
  defaultChecked: boolean
  /** 這個檔的全部 candidate id。建 plan 要整包送，不然 B 會漏處理 */
  candidateIds: string[]
  /** 依信心由高到低 */
  reasons: CandidateReason[]
}

export type NeedsHumanRow = {
  itemId: string
  name: string
  folder: string
  bytes: number
  why: string
}

export type CandidateList = {
  total: number
  bytes: number
  generatedAt: string
  candidates: CandidateRow[]
  needsHuman: NeedsHumanRow[]
}

type ItemRow = {
  id: string; path: string; name: string; bytes: number
  mtime: string; status: string; error: string | null
}
type CandRow = {
  id: string; item_id: string; kind: string
  confidence: number; reason: string; evidence: string
}

/**
 * 把絕對路徑拆成 UI 看得懂、但洩漏不出去的兩段。
 *
 * spec 第 6 節：「不把本機路徑洩漏給 UI」。
 * 但只給檔名的話，`2026/09/report.pdf` 跟 `report.pdf` 使用者分不出來，
 * 所以給**相對於監看資料夾**的子目錄。
 */
export function displayPath(path: string, roots: string[]): { folder: string; subdir: string } {
  for (const root of roots) {
    const rel = relative(root, path)
    if (rel && !rel.startsWith('..') && !rel.includes(':')) {
      const dir = dirname(rel)
      return { folder: basename(root), subdir: dir === '.' ? '' : dir }
    }
  }
  // 比不到 root（設定改過、檔案被搬走）—— 只給檔名，寧可少講也不要洩漏
  return { folder: '', subdir: '' }
}

/**
 * duplicate 的 evidence 要**指名留著的是哪一份**。
 *
 * A 產出的是「同一個 sha256 還有 N 份檔案存在」，數字對但使用者無法確認安全 ——
 * 他沒辦法知道「我還留著一份」。這裡把留下來的那個檔名補進去。
 */
function enrichDuplicate(db: DatabaseSync, item: ItemRow, evidence: string): string {
  const sha = (db.prepare(`SELECT sha256 FROM file_items WHERE id=?`).get(item.id) as { sha256: string | null })?.sha256
  if (!sha) return evidence
  const keep = db.prepare(
    `SELECT name FROM file_items
     WHERE sha256=? AND status NOT IN ('quarantined','missing','error')
     ORDER BY first_seen_at, path LIMIT 1`
  ).get(sha) as { name: string } | undefined
  if (!keep || keep.name === item.name) return evidence
  return `${evidence}，會留著「${keep.name}」`
}

export type ListOptions = {
  /** 監看資料夾。用來把絕對路徑換成顯示用的 folder/subdir */
  roots: string[]
  limit?: number
}

/**
 * 清理候選，以**檔案**為單位。
 * HTTP route 與 CLI 都用這一支 —— 不准有第二份組裝邏輯。
 */
export function listCandidates(db: DatabaseSync, opts: ListOptions): CandidateList {
  const limit = opts.limit ?? 500

  const cands = db.prepare(
    `SELECT c.id, c.item_id, c.kind, c.confidence, c.reason, c.evidence
     FROM cleanup_candidates c
     JOIN file_items i ON i.id = c.item_id
     WHERE c.status='proposed' AND i.status NOT IN ('quarantined','missing')
     ORDER BY c.confidence DESC, c.id`
  ).all() as CandRow[]

  const byItem = new Map<string, CandRow[]>()
  for (const c of cands) {
    const list = byItem.get(c.item_id)
    if (list) list.push(c)
    else byItem.set(c.item_id, [c])
  }

  const rows: CandidateRow[] = []
  let bytes = 0
  for (const [itemId, list] of byItem) {
    const item = db.prepare(
      `SELECT id, path, name, bytes, mtime, status, error FROM file_items WHERE id=?`
    ).get(itemId) as ItemRow | undefined
    if (!item) continue

    // 已經照 confidence DESC 抓出來了，第一筆就是最高的
    const reasons: CandidateReason[] = list.map(c => ({
      kind: c.kind,
      confidence: c.confidence,
      reason: c.reason,
      evidence: c.kind === 'duplicate' ? enrichDuplicate(db, item, c.evidence) : c.evidence,
    }))
    const top = reasons[0]
    const { folder, subdir } = displayPath(item.path, opts.roots)

    rows.push({
      itemId, name: item.name, folder, subdir,
      bytes: item.bytes, mtime: item.mtime,
      kind: top.kind,
      confidence: top.confidence,
      // 一個檔一個決定，用**最高**信心那條。
      //
      // 為什麼是 max 不是 min：每一條規則都是「這是垃圾」的獨立證據，
      // 多命中一條是證據變多不是變少。取 min 的話，加規則會讓系統變得
      // 更不敢清 —— 200 天的 zip 反而比 40 天的難清掉，那很荒謬。
      //
      // **陷阱**：將來要加「使用者釘選」「最近開過」這種「絕對不要動」的規則，
      // **必須做成否決旗標，不可以做成一條低信心候選** —— max 會把它蓋掉。
      defaultChecked: top.confidence >= DEFAULT_CHECK_MIN,
      candidateIds: list.map(c => c.id),
      reasons,
    })
    bytes += item.bytes
    if (rows.length >= limit) break
  }

  // 讀不到的檔案要讓使用者知道，但**不可以把路徑帶出去**
  const broken = db.prepare(
    `SELECT id, path, name, bytes, mtime, status, error FROM file_items
     WHERE status='error' ORDER BY last_seen_at DESC LIMIT 50`
  ).all() as ItemRow[]

  return {
    total: rows.length,
    bytes,
    generatedAt: new Date().toISOString(),
    candidates: rows,
    needsHuman: broken.map(b => ({
      itemId: b.id,
      name: b.name,
      folder: displayPath(b.path, opts.roots).folder,
      bytes: b.bytes,
      why: b.error ?? '讀不到這個檔案',
    })),
  }
}

// ── health ───────────────────────────────────────────────────

export type HealthOptions = {
  roots: string[]
  quarantine: string
  version?: string
}

const getMeta = (db: DatabaseSync, k: string): string | null =>
  ((db.prepare(`SELECT v FROM meta WHERE k=?`).get(k) as { v: string } | undefined)?.v) ?? null

/** 那個 pid 還活著嗎。心跳只證明「它上次寫的時候還活著」。 */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true }
  catch (e: any) { return e?.code === 'EPERM' }
}

function quarantineStats(dir: string): { items: number; bytes: number; oldestAt: string | null } {
  if (!existsSync(dir)) return { items: 0, bytes: 0, oldestAt: null }
  let items = 0, bytes = 0, oldest: number | null = null
  const walk = (d: string, depth: number) => {
    if (depth > 4) return
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = d + sep + e.name
      if (e.isDirectory()) { walk(p, depth + 1); continue }
      if (!e.isFile()) continue
      try {
        const st = statSync(p)
        items++; bytes += st.size
        if (oldest === null || st.mtimeMs < oldest) oldest = st.mtimeMs
      } catch { /* 剛好不見了就算了 */ }
    }
  }
  walk(dir, 0)
  return { items, bytes, oldestAt: oldest === null ? null : new Date(oldest).toISOString() }
}

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000

/** 後端到底有沒有在運作。**這裡也不可以有絕對路徑。** */
export function healthSnapshot(db: DatabaseSync, opts: HealthOptions) {
  const beat = getMeta(db, 'cleanup_watch_heartbeat')
  const pid = Number(getMeta(db, 'cleanup_watch_pid'))
  const running = Boolean(beat) && alive(pid)
  const fresh = Boolean(beat) && (Date.now() - Date.parse(beat!)) < 5 * 60_000

  const q = quarantineStats(opts.quarantine)
  const canEmptyAt = q.oldestAt ? new Date(Date.parse(q.oldestAt) + SEVEN_DAYS).toISOString() : null

  const pending = (db.prepare(
    `SELECT count(DISTINCT c.item_id) n FROM cleanup_candidates c
     JOIN file_items i ON i.id = c.item_id
     WHERE c.status='proposed' AND i.status NOT IN ('quarantined','missing')`
  ).get() as { n: number }).n

  const errors = (db.prepare(
    `SELECT count(*) n FROM file_items WHERE status='error'`
  ).get() as { n: number }).n

  return {
    ok: true,
    version: opts.version ?? '0.1.0',
    db: { ok: true },
    watcher: {
      ok: running && fresh,
      lastHeartbeatAt: beat,
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      // 只給顯示名，不給完整路徑
      watching: opts.roots.map(r => basename(r)),
      why: !beat ? '從來沒跑過'
        : !running ? '那個行程已經不在了'
        : !fresh ? '行程還在，但心跳停了超過五分鐘'
        : null,
    },
    quarantine: {
      items: q.items, bytes: q.bytes,
      oldestAt: q.oldestAt, canEmptyAt,
      canEmptyNow: Boolean(canEmptyAt) && Date.parse(canEmptyAt!) <= Date.now(),
    },
    pendingCandidates: pending,
    needsHuman: errors,
    lastError: getMeta(db, 'cleanup_last_error'),
  }
}

// ── HTTP ─────────────────────────────────────────────────────

export type RouteCtx = {
  db: DatabaseSync
  roots: string[]
  quarantine: string
  url: URL
  method: string
  body: any
  send: (code: number, payload: unknown) => void
  /** 手動掃一次。由呼叫端注入，這一支不直接相依 scanner。 */
  scan: () => { scanned: number; candidates: number; skipped: number; errors: number; truncated: boolean }
}

/** 錯誤沿用既有 server 的 { error: 字串 }，多一個 code 給程式分支。 */
const fail = (send: RouteCtx['send'], code: number, error: string, tag: string) =>
  send(code, { error, code: tag })

/**
 * 清理相關的唯讀 route。**認得就處理並回 true，不認得回 false** 讓下一個接手。
 *
 * apply／undo／dismiss 不在這裡 —— 那些會真的動檔案，是 B 的範圍。
 */
export function cleanupRoutes(ctx: RouteCtx): boolean {
  const { url, method, send } = ctx
  const p = url.pathname

  if (p === '/cleanup/candidates' && method === 'GET') {
    const raw = url.searchParams.get('limit')
    const limit = raw === null ? undefined : Number(raw)
    if (raw !== null && (!Number.isInteger(limit) || limit! < 1 || limit! > 1000)) {
      fail(send, 400, 'limit 要是 1 到 1000 之間的整數。', 'BAD_BODY')
      return true
    }
    send(200, listCandidates(ctx.db, { roots: ctx.roots, limit }))
    return true
  }

  if (p === '/cleanup/scan' && method === 'POST') {
    try {
      const r = ctx.scan()
      send(200, { ...r, candidates: r.candidates })
    } catch (e: any) {
      // 掃描壞掉不可以把路徑吐給 UI
      fail(send, 500, '掃描的時候出錯了，這一步沒有動到任何檔案。', 'INTERNAL')
    }
    return true
  }

  // 還沒實作的（B 的範圍）要回一句人話，不是 404 —— 404 會讓 C 以為自己打錯網址
  if (/^\/cleanup\/plans(\/|$)/.test(p) || p === '/cleanup/quarantine' || p === '/pet/state') {
    fail(send, 501, '這個功能還沒做好。', 'NOT_IMPLEMENTED')
    return true
  }

  return false
}
