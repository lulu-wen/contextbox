import { existsSync, lstatSync, watch } from 'node:fs'
import { basename, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { cleanupWalk, scanDownloads, type CleanupScanResult } from './cleanup-scanner.ts'

export type CleanupWatcherOptions = {
  db: DatabaseSync
  roots: string[]
  maxBytes: number
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
type Pending = Fingerprint & { since: number; stable: number }

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
    try {
      const st = lstatSync(path)
      if (!st.isFile() || st.isSymbolicLink()) return null
      return { size: st.size, mtimeMs: st.mtimeMs }
    } catch {
      return null
    }
  }

  function remember(path: string, fp: Fingerprint) {
    seen.set(path, fp)
  }

  function notice(path: string) {
    if (stopped) return
    const fp = fingerprint(path)
    if (!fp) return
    const old = seen.get(path)
    if (old && old.size === fp.size && old.mtimeMs === fp.mtimeMs) return
    const waiting = pending.get(path)
    if (waiting && waiting.size === fp.size && waiting.mtimeMs === fp.mtimeMs) return
    pending.set(path, { ...fp, since: Date.now(), stable: 0 })
  }

  function tick() {
    if (stopped || !pending.size) return
    const now = Date.now()
    for (const [path, prev] of [...pending]) {
      const fp = fingerprint(path)
      if (!fp) { pending.delete(path); seen.delete(path); continue }
      if (fp.size !== prev.size || fp.mtimeMs !== prev.mtimeMs) {
        pending.set(path, { ...fp, since: now, stable: 0 })
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
          maxDepth,
          maxFiles,
          paths: [path],
          onProblem: opts.onProblem,
        })
        remember(path, fp)
        if (opts.onScan) opts.onScan(result)
      } catch (e: any) {
        problem(`掃描 ${basename(path)} 時出錯：${e?.message ?? e}，等一下會再試一次。`)
      }
    }
  }

  function poll() {
    if (stopped) return
    for (const root of opts.roots) {
      if (!existsSync(root)) { problem(`監看資料夾不存在：${root}`); continue }
      const r = cleanupWalk(root, maxDepth, maxFiles)
      if (r.truncated) problem(`${root} 裡的檔案超過 ${maxFiles} 個，只掃前面一部分。`)
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
      if (!existsSync(root)) { problem(`監看資料夾不存在：${root}`); continue }
      try {
        const w = watch(root, { recursive: true }, (_event, filename) => {
          if (filename) notice(join(root, String(filename)))
        })
        w.on('error', e => problem(`監看 ${root} 出錯：${e.message}，改用輪詢補掃。`))
        watchers.push(w)
      } catch (e: any) {
        problem(`${root} 不支援即時監看（${e.message}），改用輪詢補掃。`)
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
