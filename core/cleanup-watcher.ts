import { existsSync, lstatSync, watch } from 'node:fs'
import { basename, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { cleanupWalk, isGoneError, markMissing, scanDownloads, type CleanupScanResult } from './cleanup-scanner.ts'

export type CleanupWatcherOptions = {
  db: DatabaseSync
  roots: string[]
  maxBytes: number
  /** 幾天內動過的檔一律不提議（cleanup.protectDays）。 */
  protectDays?: number
  settleMs?: number
  tickMs?: number
  pollMs?: number
  maxDepth?: number
  maxFiles?: number
  onScan?: (result: CleanupScanResult) => void
  onSeed?: (count: number) => void
  onProblem?: (msg: string) => void
}

type Fingerprint = { size: number; mtimeMs: number }
/** gone：這條路徑在等「確定不見了」，節流跟新檔一樣（settleMs＋兩個 tick）。 */
type Pending = Fingerprint & { since: number; stable: number; gone: boolean }
type Probe = { state: 'file'; fp: Fingerprint } | { state: 'gone' } | { state: 'other' }

/**
 * 看一眼這條路徑現在是什麼。
 * **只有 ENOENT／ENOTDIR 算不見了**；EACCES、EIO 這些是暫時讀不到，當成 other（不處理）。
 */
function probe(path: string): Probe {
  let st
  try { st = lstatSync(path) }
  catch (e) { return isGoneError(e) ? { state: 'gone' } : { state: 'other' } }
  if (!st.isFile() || st.isSymbolicLink()) return { state: 'other' }
  return { state: 'file', fp: { size: st.size, mtimeMs: st.mtimeMs } }
}

export function createCleanupWatcher(opts: CleanupWatcherOptions) {
  const settleMs = opts.settleMs ?? 1000
  const tickMs = opts.tickMs ?? 500
  const pollMs = opts.pollMs ?? 60_000
  const maxDepth = opts.maxDepth ?? 3
  const maxFiles = opts.maxFiles ?? 5000

  const seen = new Map<string, Fingerprint>()
  const pending = new Map<string, Pending>()
  const watchers: { close: () => void; on?: unknown }[] = []
  let tickTimer: NodeJS.Timeout | null = null
  let pollTimer: NodeJS.Timeout | null = null
  let running = false
  let stopped = false

  const problem = (msg: string) => { if (opts.onProblem) opts.onProblem(msg) }

  function fingerprint(path: string): Fingerprint | null {
    const p = probe(path)
    return p.state === 'file' ? p.fp : null
  }

  function remember(path: string, fp: Fingerprint) {
    seen.set(path, fp)
  }

  const goneEntry = (since: number): Pending => ({ size: -1, mtimeMs: -1, since, stable: 0, gone: true })

  function notice(path: string) {
    if (stopped) return
    const p = probe(path)
    if (p.state === 'other') return
    const waiting = pending.get(path)
    // **刪除事件也要處理。** 以前路徑不存在就直接 return，pet 模式（只有 watcher、
    // 沒有全量掃描）裡使用者自己刪掉的檔會永遠留在清單與徽章數字上。
    if (p.state === 'gone') {
      if (!waiting?.gone) pending.set(path, goneEntry(Date.now()))
      return
    }
    const fp = p.fp
    if (!waiting?.gone) {
      const old = seen.get(path)
      if (old && old.size === fp.size && old.mtimeMs === fp.mtimeMs) return
      if (waiting && waiting.size === fp.size && waiting.mtimeMs === fp.mtimeMs) return
    }
    pending.set(path, { ...fp, since: Date.now(), stable: 0, gone: false })
  }

  /** 確定不見了：標 missing（不動候選、避開 quarantined，見 markMissing）。 */
  function settleGone(path: string, prev: Pending, now: number) {
    pending.delete(path)
    // 同內容、同 mtime 放回來的時候不可以被「看過了」吃掉
    seen.delete(path)
    try { markMissing(opts.db, path, opts.roots) }
    catch (e: any) {
      pending.set(path, { ...prev, since: now, stable: 0 })
      problem(`Something went wrong recording that ${basename(path)} is gone: ${e?.message ?? e}. It will be tried again shortly.`)
    }
  }

  function tick() {
    if (stopped || !pending.size) return
    const now = Date.now()
    for (const [path, prev] of [...pending]) {
      const p = probe(path)
      if (p.state === 'other') { pending.delete(path); seen.delete(path); continue }
      if (p.state === 'gone') {
        if (!prev.gone) { pending.set(path, goneEntry(now)); continue }
        const stable = prev.stable + 1
        if (now - prev.since < settleMs || stable < 2) { pending.set(path, { ...prev, stable }); continue }
        settleGone(path, prev, now)
        continue
      }
      const fp = p.fp
      if (prev.gone || fp.size !== prev.size || fp.mtimeMs !== prev.mtimeMs) {
        pending.set(path, { ...fp, since: now, stable: 0, gone: false })
        continue
      }
      const stable = prev.stable + 1
      if (now - prev.since < settleMs || stable < 2) {
        pending.set(path, { ...prev, stable })
        continue
      }

      pending.delete(path)
      try {
        const result = scanDownloads({
          db: opts.db,
          roots: opts.roots,
          maxBytes: opts.maxBytes,
          protectDays: opts.protectDays,
          maxDepth,
          maxFiles,
          paths: [path],
          onProblem: opts.onProblem,
        })
        remember(path, fp)
        if (opts.onScan) opts.onScan(result)
      } catch (e: any) {
        problem(`Something went wrong scanning ${basename(path)}: ${e?.message ?? e}. It will be tried again shortly.`)
      }
    }
  }

  function poll() {
    if (stopped) return
    for (const root of opts.roots) {
      if (!existsSync(root)) { problem(`The watched folder does not exist: ${root}`); continue }
      const r = cleanupWalk(root, maxDepth, maxFiles)
      if (r.truncated) problem(`${root} holds more than ${maxFiles} files, so only the first part was scanned.`)
      for (const p of r.files) notice(p)
    }
  }

  function seed() {
    let count = 0
    for (const root of opts.roots) {
      if (!existsSync(root)) continue
      const r = cleanupWalk(root, maxDepth, maxFiles)
      for (const p of r.files) {
        const fp = fingerprint(p)
        if (!fp) continue
        remember(p, fp)
        count++
      }
    }
    if (opts.onSeed) opts.onSeed(count)
  }

  function start(seedExisting = true) {
    if (running) return
    running = true
    stopped = false

    for (const root of opts.roots) {
      if (!existsSync(root)) { problem(`The watched folder does not exist: ${root}`); continue }
      try {
        const w = watch(root, { recursive: true }, (_event, filename) => {
          if (filename) notice(join(root, String(filename)))
        })
        w.on('error', e => problem(`Watching ${root} hit an error: ${e.message}; falling back to polling.`))
        watchers.push(w)
      } catch (e: any) {
        problem(`${root} does not support live watching (${e.message}); falling back to polling.`)
      }
    }

    if (seedExisting) seed()
    tickTimer = setInterval(tick, tickMs)
    if (tickTimer.unref) tickTimer.unref()
    if (pollMs > 0) {
      pollTimer = setInterval(poll, pollMs)
      if (pollTimer.unref) pollTimer.unref()
    }
  }

  function stop() {
    running = false
    stopped = true
    for (const w of watchers) { try { w.close() } catch { /* 已經關了 */ } }
    watchers.length = 0
    if (tickTimer) clearInterval(tickTimer)
    if (pollTimer) clearInterval(pollTimer)
    tickTimer = null
    pollTimer = null
    pending.clear()
  }

  return {
    start,
    stop,
    tick,
    poll,
    notice,
    pendingCount: () => pending.size,
    seenCount: () => seen.size,
    forget: (path: string) => seen.delete(path),
  }
}
