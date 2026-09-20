/**
 * 監看資料夾 —— 東西一落地就知道。
 *
 * 這一支只做三件事，做完就把路徑交給 guard：
 *
 *   1. **等它寫完。** 瀏覽器與截圖工具都是分塊寫檔的。看到事件就馬上讀，
 *      讀到的是半個檔案：圖是花的、PDF 開不起來、大小是 0。
 *      所以看到事件先放進待定區，大小與時間連續不變才算落地。
 *   2. **開機不要一次湧入。** 你的 Downloads 裡本來就有四百個舊檔。
 *      啟動時把現有的檔案記成已見，之後才進來的才算新的。
 *   3. **fs.watch 靠不住的時候有保底。** 網路磁碟、WSL 掛載、某些同步資料夾
 *      不會發事件。所以固定每 pollMs 掃一次，慢但不會漏。
 *
 * ── 已見（seen）為什麼記的是「指紋」不是「路徑」─────────────────
 *
 * 第一版只記路徑，而且不管結果如何都記。稽查抓到這一個決定造成四個洞：
 *   - 截圖工具先建 0 byte 再寫內容 → 第一眼被 guard 判「檔案是空的」，
 *     然後**永遠**不再看它一眼。使用者只看到一行過眼即忘的訊息。
 *   - onFile 丟例外（資料庫被另一個行程鎖住）→ 同樣永久遺失。
 *   - 同名覆蓋（截圖工具重複用同名、下載錯了刪掉重下）→ 第二版進不來。
 *   - 這個集合只增不減，常駐好幾天會一直長大。
 *
 * 所以現在記的是 `路徑 → { size, mtimeMs }`，而且**只有 onFile 真的成功
 * 回來才記**。檔案內容一變，指紋就對不上，它就會被當成新的事件重新走一遍。
 * 這也順便解掉「寫到一半停超過 settleMs 被誤判成寫完」——那個誤判還是會
 * 發生（純靠時間的啟發式一定會），但**不再是永久的**：檔案繼續寫完之後
 * 指紋變了，我們會再看到它一次，帶著完整的內容。
 */
import { watch, readdirSync, lstatSync, existsSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { admit, isTemporary, PARTIAL_EXT, EXT_MIME, DENY_DIRS, type Verdict, type AdmitOptions } from './guard.ts'

export type WatcherOptions = {
  roots: string[]
  maxBytes: number
  exclude?: string[]
  /** 大小與時間要連續多久沒變才算寫完 */
  settleMs?: number
  /** 多久檢查一次待定區 */
  tickMs?: number
  /** 保底輪詢間隔。0 代表不輪詢（測試用） */
  pollMs?: number
  /** 走訪時最多下探幾層。截圖資料夾不會很深，設淺一點省力 */
  maxDepth?: number
  /** 一次最多認得幾個檔，防止有人把 watch 指到根目錄 */
  maxFiles?: number
  /** 已見的上限。超過就把最舊的丟掉，常駐好幾天才不會一直長大 */
  maxSeen?: number
  /** 暫時性的失敗最多重試幾次（0 byte、讀不到、資料庫鎖住） */
  maxRetries?: number
  onFile: (v: Extract<Verdict, { ok: true }>) => void
  /** 開機時看到幾個既有檔案。只給數字，不要讓呼叫端以為它們過了防線 */
  onSeed?: (count: number) => void
  /** 給人看的問題，會進健康列 */
  onProblem?: (msg: string) => void
}

type Pending = { size: number; mtimeMs: number; since: number; stable: number }
type Seen = { size: number; mtimeMs: number }

/** 這個資料夾要不要走進去 */
function skipDir(name: string): boolean {
  const n = name.toLowerCase()
  // 點開頭的一律不進（.git、.cache、.ssh 全包含在內），
  // 所以下面只需要比對不是點開頭的那些。
  if (n.startsWith('.')) return true
  return DENY_DIRS.some(bad => !bad.startsWith('.') && n === bad)
}

/** 看起來像我們要收的檔嗎。便宜的預篩，真正的判斷在 guard.admit。 */
function looksLikeCandidate(path: string): boolean {
  const ext = extname(path).toLowerCase()
  if (PARTIAL_EXT.has(ext)) return false
  return Boolean(EXT_MIME[ext])
}

/** 走一遍資料夾，回傳看起來像候選的檔案路徑 */
export function walk(root: string, maxDepth = 4, maxFiles = 5000): { files: string[]; truncated: boolean } {
  const files: string[] = []
  let truncated = false
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  while (stack.length) {
    if (files.length >= maxFiles) { truncated = true; break }
    const cur = stack.pop()!
    let entries
    try { entries = readdirSync(cur.dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const p = join(cur.dir, e.name)
      // 捷徑一律不跟，連走訪都不要 —— 不然一個指回上層的捷徑就是無窮迴圈
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        if (cur.depth < maxDepth && !skipDir(e.name)) stack.push({ dir: p, depth: cur.depth + 1 })
        continue
      }
      if (e.isFile() && looksLikeCandidate(p)) {
        if (files.length >= maxFiles) { truncated = true; break }
        files.push(p)
      }
    }
  }
  return { files, truncated }
}

export function createWatcher(opts: WatcherOptions) {
  const settleMs = opts.settleMs ?? 1000
  const tickMs = opts.tickMs ?? 500
  const pollMs = opts.pollMs ?? 30_000
  const maxDepth = opts.maxDepth ?? 4
  const maxFiles = opts.maxFiles ?? 5000
  const maxSeen = opts.maxSeen ?? 20_000
  const maxRetries = opts.maxRetries ?? 5
  const admitOpts: AdmitOptions = { roots: opts.roots, maxBytes: opts.maxBytes, exclude: opts.exclude }

  /**
   * 已經處理過的東西：路徑 → 當時的指紋。
   * 指紋對不上就當成新的事件，所以同名覆蓋救得回來。
   */
  const seen = new Map<string, Seen>()
  /** 暫時失敗過幾次。成功或永久拒絕就清掉。 */
  const retries = new Map<string, number>()
  const pending = new Map<string, Pending>()
  /** 已經講過「這個資料夾太大」的 root。同一句話不要每輪都講。 */
  const warnedTruncated = new Set<string>()
  const watchers: { close: () => void }[] = []
  let tickTimer: NodeJS.Timeout | null = null
  let pollTimer: NodeJS.Timeout | null = null
  let running = false
  /** stop() 之後就徹底不動了。沒 start 過而手動驅動的不受影響。 */
  let stopped = false

  const problem = (m: string) => { if (opts.onProblem) opts.onProblem(m) }

  /**
   * 已見超過上限時的水位線：被淘汰掉的那些裡面最新的 mtime。
   * 比這個舊的檔案一律當成「早就看過了」。
   *
   * 沒有這條線的話，淘汰本身會變成一個迴圈：被擠掉的檔案還在資料夾裡，
   * 下一輪輪詢查不到指紋 → 當成新檔重送 → 又擠掉另一個。實測 8 個檔配
   * maxSeen=5，中間沒有任何檔案變動，五輪輪詢就送出 20 次，
   * 而每一次重送都會把整個檔案讀進來算指紋。
   */
  let seenFloor = 0

  /** Map 是照插入順序走的，所以砍前面的就是砍最舊的 */
  function rememberSeen(path: string, st: Seen) {
    seen.delete(path)
    seen.set(path, st)
    if (seen.size <= maxSeen) return

    // 先丟已經不在硬碟上的 —— 那些丟掉不會有任何副作用
    for (const [k] of seen) {
      if (seen.size <= maxSeen) break
      try { lstatSync(k) } catch { seen.delete(k) }
    }
    // 還是太多就丟最舊的，並把水位線推上去
    for (const [k, v] of seen) {
      if (seen.size <= maxSeen) break
      if (v.mtimeMs > seenFloor) seenFloor = v.mtimeMs
      seen.delete(k)
    }
  }

  /**
   * 看到一個可能的新檔。放進待定區，等它寫完。
   *
   * 這一支不看 running —— 它是公開的入口，右鍵選單手動送一個檔進來時，
   * 沒有人會先去 start() 一個常駐監看。要不要收是呼叫端的決定。
   */
  function notice(path: string) {
    if (stopped) return
    if (pending.has(path)) return
    if (!looksLikeCandidate(path)) return
    let st
    try { st = lstatSync(path) } catch { return }
    if (!st.isFile()) return
    // 指紋跟上次處理完的一樣 → 真的沒變，不用再看
    const before = seen.get(path)
    if (before && before.size === st.size && before.mtimeMs === st.mtimeMs) return
    // 沒有紀錄，但比水位線還舊 → 是被淘汰掉的舊檔，不是新的
    if (!before && st.mtimeMs <= seenFloor) return
    pending.set(path, { size: st.size, mtimeMs: st.mtimeMs, since: Date.now(), stable: 0 })
  }

  /** 檢查待定區。大小與時間連續不變才算寫完。 */
  function tick() {
    if (stopped || !pending.size) return
    const now = Date.now()
    for (const [path, prev] of [...pending]) {
      let st
      // 被搬走或改名了。retries 也要一起清，不然那筆會永遠留著。
      try { st = lstatSync(path) } catch { pending.delete(path); retries.delete(path); continue }
      if (!st.isFile()) { pending.delete(path); retries.delete(path); continue }

      if (st.size !== prev.size || st.mtimeMs !== prev.mtimeMs) {
        // 還在寫，把計時重新開始
        pending.set(path, { size: st.size, mtimeMs: st.mtimeMs, since: now, stable: 0 })
        continue
      }
      // 除了「夠久沒變」，還要求至少量到兩次一樣，少一點誤判
      const stable = prev.stable + 1
      if (now - prev.since < settleMs || stable < 2) {
        pending.set(path, { ...prev, stable })
        continue
      }

      pending.delete(path)
      const fingerprint: Seen = { size: st.size, mtimeMs: st.mtimeMs }
      const v = admit(path, admitOpts)

      if (!v.ok) {
        if (isTemporary(v.why)) {
          // 0 byte、讀不到 —— 這些等一下可能就好了（截圖工具先建檔再寫內容）。
          // 不記進已見，讓下一輪輪詢再看一次，但要有次數上限免得壞檔無限重試。
          const n = (retries.get(path) ?? 0) + 1
          retries.set(path, n)
          if (n >= maxRetries) {
            retries.delete(path)
            rememberSeen(path, fingerprint)
            problem(`${basename(path)}: still “${v.why}” after ${n} tries, so it is given up for now. It will be tried again if the contents change.`)
          } else if (n === 1) problem(`${basename(path)}: ${v.why} (it will be looked at again shortly)`)
          continue
        }
        // 永久拒絕（副檔名、黑名單、不在白名單）—— 記起來，不要每次輪詢都重算
        retries.delete(path)
        rememberSeen(path, fingerprint)
        problem(`${basename(path)}：${v.why}`)
        continue
      }

      try {
        opts.onFile(v)
      } catch (e: any) {
        // **記已見一定要在 onFile 成功之後。**
        // 以前記在前面，呼叫端一丟例外（例如資料庫被另一個行程鎖住），
        // 那個檔案就永遠消失了。
        const n = (retries.get(path) ?? 0) + 1
        retries.set(path, n)
        problem(`Something went wrong handling ${basename(path)}: ${(e && e.message) || e}`
          + (n >= maxRetries ? ' Too many tries, so it is given up for now.' : ' It will be tried again shortly.'))
        if (n >= maxRetries) { retries.delete(path); rememberSeen(path, fingerprint) }
        continue
      }
      retries.delete(path)
      rememberSeen(path, fingerprint)
      if (v.real !== path) rememberSeen(v.real, fingerprint)
    }
  }

  /** 保底輪詢。fs.watch 沒發事件的時候靠這個。 */
  function poll() {
    if (stopped) return
    for (const root of opts.roots) {
      if (!existsSync(root)) continue
      const { files, truncated } = walk(root, maxDepth, maxFiles)
      // 每一輪都講一次的話，常駐就是 30 秒洗一次健康列。只講第一次。
      if (truncated && !warnedTruncated.has(root)) {
        warnedTruncated.add(root)
        problem(`${root} holds more than ${maxFiles} files, so only the first ones were scanned. `
          + 'Narrow the watch scope, or the rest will never be seen.')
      }
      for (const p of files) notice(p)
    }
  }

  function start(seed = true) {
    if (running) return
    running = true
    stopped = false

    // 先掛監看再掃既有檔案 —— 反過來的話，掃描期間落地的檔案會整個漏掉
    for (const root of opts.roots) {
      if (!existsSync(root)) { problem(`The watched folder does not exist: ${root}`); continue }
      try {
        const w = watch(root, { recursive: true }, (_event, filename) => {
          if (!filename) return
          notice(join(root, String(filename)))
        })
        w.on('error', e => problem(`Watching ${root} hit an error: ${e.message}. The fallback scan every ${pollMs / 1000}s still runs.`))
        watchers.push(w)
      } catch (e: any) {
        // 某些檔案系統不支援 recursive。不是致命的——保底輪詢照樣會找到。
        problem(`${root} does not support live watching (${e.message}), so it is scanned every ${pollMs / 1000}s instead.`)
      }
    }

    // 開機時既有的檔案記成已見，不然第一次啟動會有四百張卡片。
    // 只記指紋，不讀檔內容 —— 這一步在慢碟上會卡住事件迴圈。
    let count = 0
    if (seed) {
      for (const root of opts.roots) {
        if (!existsSync(root)) continue
        for (const p of walk(root, maxDepth, maxFiles).files) {
          try {
            const st = lstatSync(p)
            rememberSeen(p, { size: st.size, mtimeMs: st.mtimeMs })
            count++
          } catch { /* 剛好不見了就算了，下一輪輪詢會處理 */ }
        }
      }
      if (opts.onSeed) opts.onSeed(count)
    }

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
    tickTimer = pollTimer = null
    pending.clear()
  }

  return {
    start, stop, tick, poll, notice,
    pendingCount: () => pending.size,
    seenCount: () => seen.size,
    /** 測試與「重新整理」用：把某個路徑從已見裡拿掉 */
    forget: (p: string) => seen.delete(p),
  }
}
