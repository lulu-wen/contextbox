/**
 * 把「讀一個檔的文字」關進一個 worker thread：記憶體有上限、每個檔有時間上限，
 * worker 死掉只代表「這個檔看不懂」，不可以拖垮掃描。
 *
 * 為什麼要有這一層：解析的是**不可信的輸入**（任何人都能讓你下載一個惡意 PDF）。
 * 上游的 office-text.ts 與 pdf-text.ts 本身已經會擋（工作量與結構都有上限），
 * 但擋不住兩件事：V8 的 heap 真的被吃光（try/catch 接不住，整個行程會走），
 * 以及「剛好在上限內、但要跑很久」的檔。掃描是同步的，卡住就等於寵物不動了。
 *
 * ── 做法（**掃描全程同步**，主執行緒的 event loop 不會轉）─────────────────
 * - 一個常駐的 worker，結果走 SharedArrayBuffer，主執行緒用 `Atomics.wait` 等它。
 *   `postMessage` 只是把訊息丟進 worker 的佇列，不需要呼叫端的 event loop 轉；
 *   worker 算完把 JSON 寫進共用記憶體，再 `Atomics.notify`。
 *   所以連「第一次用、worker 還沒開起來」都可以在同一次同步呼叫裡完成（實測冷開約 0.2 秒）。
 * - **每個檔 5 秒**（`Atomics.wait` 的時間上限是硬的：主執行緒最多被一個檔擋 5 秒）。
 *   逾時就把這個 worker `terminate()` 掉，下一個檔用新的。
 * - **worker 重複使用**：正常的檔一個接一個丟給同一個 worker，只有死掉才重開。
 *   連續死幾次由呼叫端決定要不要放棄（掃描器是 3 次，見 MAX_WORKER_DEATHS）。
 * - worker 的 heap 上限 256 MB。**不可以再低**：pdf-text.ts 檔頭實測，合法但很大的 PDF
 *   要 200 MB 以上，160 MB 會 OOM。
 *
 * ── 已知限制 ──────────────────────────────────────────────────────────
 * - **heap 外的記憶體 resourceLimits 管不到**（輸入本身約檔案大小 ×2）。
 *   所以**讀檔之前要先擋大小**，那件事在呼叫端（掃描器用設定的 maxBytes，預設 20 MB）。
 * - worker 因為 OOM 死掉時，主執行緒只看得到「等不到回應」：`ERR_WORKER_OUT_OF_MEMORY`
 *   要等 event loop 轉才收得到，而我們正卡在 `Atomics.wait` 裡（實測確認）。
 *   所以那種檔的 reason 是「逾時」，不是「記憶體不足」；「記憶體不足」只有 worker
 *   自己接得住的配置失敗（RangeError）才會出現。兩者對呼叫端的意思一樣：這個檔讀不到。
 * - 這一層**只讀不寫**：worker 用 O_RDONLY 開檔，不會動到檔案的內容或時間。
 */
import { Worker } from 'node:worker_threads'

export type TextKind = 'text' | 'docx' | 'pptx' | 'pdf'

/**
 * `file_texts.reason` 的合法值。這幾個字直接就是要給人看的說法，不需要再翻一次
 * （面板與 CLI 只會講「N 個檔看不懂」，逐檔的原因是查資料庫時看的）。
 */
export const TEXT_REASON = Object.freeze({
  /** 解析不出來：不是這個格式、壞掉、加密、看不懂的編碼 */
  unreadable: 'unreadable',
  /** 檔案超過上限，根本沒讀 */
  tooLarge: 'too large',
  /** 5 秒還沒讀完，或 worker 中途死掉 */
  timeout: 'timed out',
  /** worker 自己接到的配置失敗 */
  outOfMemory: 'out of memory',
})

export type TextReason = 'unreadable' | 'too large' | 'timed out' | 'out of memory'

/**
 * 會去試著讀內容的副檔名 → 存進 `file_texts.kind` 的種類。
 *
 * **兩段**（預想表第 1 列）：副檔名決定「要不要試」，內容由模組決定「讀不讀得懂」。
 * 副檔名不在這張表裡的一律不讀 —— 圖片走 P0 的長相指紋，其他不碰。
 */
const EXT_KIND = new Map<string, TextKind>([
  ['.txt', 'text'],
  ['.md', 'text'],
  ['.csv', 'text'],
  ['.docx', 'docx'],
  ['.pptx', 'pptx'],
  ['.pdf', 'pdf'],
])

/** 副檔名（小寫、含點）對應的種類；不讀的回 null。 */
export function kindOfExt(ext: string): TextKind | null {
  return EXT_KIND.get(String(ext ?? '').toLowerCase()) ?? null
}

/** 這六類副檔名，照 EXT_KIND 列出來（測試與文件用，不要另外手寫一份）。 */
export const TEXT_EXTS: readonly string[] = Object.freeze([...EXT_KIND.keys()])

/** 存進資料庫的字數上限（以 code point 計）。P2 的提示詞裝得下。 */
export const STORE_MAX_CHARS = 4000
/**
 * 叫上游模組讀多少字。比存的多，是為了 `chars`（截斷前原本讀到幾個字）有意義；
 * 再多也沒用（四倍已經足夠分辨「剛好超過」與「超過很多」），而且每一個字都是 worker 的工。
 */
export const READ_MAX_CHARS = 20_000
/** 每個檔的時間上限。 */
export const FILE_TIMEOUT_MS = 5000
/** worker 的 heap 上限。**不要低於 256**，見檔頭。 */
export const WORKER_HEAP_MB = 256
/** 回應的共用緩衝區。4000 個字全部跳脫成 \\uXXXX 也才 24 KB，1 MB 綽綽有餘。 */
const OUT_BYTES = 1 << 20

/**
 * 共用記憶體（`Int32Array`）的格子。worker 與呼叫端共用這一份定義 ——
 * 兩邊各寫一個數字的話，改一邊就是靜靜地對不上。
 */
export const TEXT_SLOT = Object.freeze({
  /** 0 還沒回、1 回了 */
  done: 0,
  /** 回應佔幾個 byte */
  len: 1,
  /** 保留（湊三個格子） */
  spare: 2,
})

const DONE = TEXT_SLOT.done
const LEN = TEXT_SLOT.len
const SPARE = TEXT_SLOT.spare

export type TextReadRequest = {
  /** 真路徑（realpath）。 */
  path: string
  kind: TextKind
  /** 掃描時看到的身分，worker 開檔之後會再驗一次（中途被換掉就不讀）。 */
  dev: number
  ino: number
  size: number
  mtimeMs: number
}

export type TextReadResult =
  | {
      status: 'ok'
      /** 最多 STORE_MAX_CHARS 個字 */
      text: string
      /** 截斷前原本讀到幾個字 */
      chars: number
      truncated: boolean
      /** 讀到的內容裡有沒有非空白字（掃描版 PDF 是 false） */
      hasText: boolean
      /** PDF 才有 */
      pages: number | null
      /** PDF 解不出 Unicode 的字形比例，其他是 null */
      unmapped: number | null
    }
  /** 讀不懂（模組丟錯）。 */
  | { status: 'unreadable'; reason: TextReason }
  /** 逾時或 worker 死掉。呼叫端要把它算成「連續死了一次」。 */
  | { status: 'dead'; reason: TextReason; blame: 'file' | 'env' }
  /** 檔案在讀的時候被換掉了：這一輪什麼都不記，下一輪重來。 */
  | { status: 'changed' }

export type TextReader = {
  read: (req: TextReadRequest) => TextReadResult
  /** 已經連續死幾次（成功一次就歸零）。 */
  deaths: () => number
  /** 收掉現在這個 worker。之後再 read 會重開一個。 */
  close: () => void
}

export type TextReaderOptions = {
  /** 每個檔的時間上限，預設 FILE_TIMEOUT_MS。 */
  timeoutMs?: number
  /**
   * worker 的進入點。**只有測試會換掉** —— 要重現「卡住」「OOM」「亂回東西」
   * 得有一個故意壞掉的 worker。
   */
  entry?: URL | string
  /** heap 上限，預設也是下限 WORKER_HEAP_MB。 */
  heapMb?: number
}

const DEFAULT_ENTRY = new URL('./read-text-worker.ts', import.meta.url)

/** `node -e`／`node --input-type=module -e` 這種「程式碼直接寫在命令列上」的旗標。 */
const EVAL_FLAGS = /^(?:--input-type(?:=|$)|--eval$|-e$|--print$|-p$)/

/**
 * 給 worker 的 node 旗標，**平常不給**（undefined ＝ 讓 Node 自己繼承並過濾）。
 *
 * 兩個相反的坑，所以只能這樣寫：
 * 1. worker 預設繼承父行程的 execArgv。父行程是 `node -e` 的話，`--input-type`／`-e`
 *    會被一起繼承 —— 但 worker 的進入點是一個檔，那些旗標讓它一開起來就死，
 *    呼叫端只看得到「等不到回應」（每個檔白等 5 秒，完全沒有錯誤訊息）。
 * 2. 反過來，**只要明著傳 execArgv，Node 就會逐個檢查**，而 `process.execArgv` 裡
 *    常常有它自己不接受的旗標（`node --test` 底下實測有 `--v8-pool-size`、`--tls-cipher-list`…
 *    二十幾個），照傳會直接丟 ERR_WORKER_INVALID_EXEC_ARGV。
 *
 * 所以：只有真的踩到第 1 種情況時才明著傳，而且傳空的（worker 不需要任何旗標；
 * 舊版 Node 才需要的 --experimental-strip-types 在那種情境下也用不到，因為那是 Node 24 起的預設）。
 */
const WORKER_ARGV: string[] | undefined =
  process.execArgv.some(a => EVAL_FLAGS.test(a)) ? [] : undefined

function toReason(v: unknown): TextReason {
  for (const r of Object.values(TEXT_REASON)) if (v === r) return r as TextReason
  return TEXT_REASON.unreadable as TextReason
}

/**
 * 開一個讀文字的 worker（第一次真的要讀的時候才開）。
 *
 * 呼叫端拿到的 `read` 是**同步**的：丟一個檔進去，等一個答案，最多 `timeoutMs`。
 */
export function createTextReader(opts: TextReaderOptions = {}): TextReader {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && (opts.timeoutMs as number) > 0
    ? Math.floor(opts.timeoutMs as number)
    : FILE_TIMEOUT_MS
  const entry = opts.entry ?? DEFAULT_ENTRY
  const heapMb = Math.max(WORKER_HEAP_MB, Math.floor(Number(opts.heapMb) || 0))

  let worker: Worker | null = null
  let ctl: Int32Array | null = null
  let out: Uint8Array | null = null
  let deaths = 0

  function spawn(): void {
    // 每一個 worker 用自己的一組共用記憶體：上一個被 terminate 掉之後如果還寫了什麼，
    // 寫的是它自己那一塊，不會汙染下一個 worker 的答案。
    const ctlSab = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT)
    const outSab = new SharedArrayBuffer(OUT_BYTES)
    ctl = new Int32Array(ctlSab)
    out = new Uint8Array(outSab)
    const w = new Worker(entry, {
      workerData: { ctl: ctlSab, out: outSab },
      resourceLimits: { maxOldGenerationSizeMb: heapMb },
      ...(WORKER_ARGV ? { execArgv: WORKER_ARGV } : {}),
    })
    // 閒著的 worker 不可以綁住行程：CLI 掃完就該結束
    w.unref()
    // 沒有人聽的 'error' 會變成沒接住的例外，把整個行程帶走。
    // 「死掉了」這件事主執行緒是靠「等不到回應」發現的，這裡只負責不要炸掉。
    w.on('error', () => { /* 等不到回應就知道了 */ })
    worker = w
  }

  function drop(): void {
    const w = worker
    worker = null
    ctl = null
    out = null
    if (!w) return
    // terminate 是非同步的，但我們不等它：這一塊共用記憶體已經丟掉了
    try { w.terminate().catch(() => { /* 已經死了 */ }) } catch { /* 已經死了 */ }
  }

  /**
   * `blame: 'file'` ＝ 這個檔把 worker 弄死了（卡住、吃爆記憶體、回垃圾）—— 記在那個檔上，
   * 下一輪不用再試一次。`blame: 'env'` ＝ 根本開不起來（thread 開不出來、Node 旗標不合），
   * 跟這個檔無關：**不可以**記在它身上，不然環境一時不對就把幾個好檔永久標成讀不到（P1 驗證員）。
   */
  function died(reason: TextReason, blame: 'file' | 'env' = 'file'): TextReadResult {
    drop()
    deaths++
    return { status: 'dead', reason, blame }
  }

  function read(req: TextReadRequest): TextReadResult {
    if (!worker) {
      // 開不起來（thread 開不出來、旗標不合）也只是「這個檔讀不到」，不可以把整輪掃描帶走
      try { spawn() } catch { return died(TEXT_REASON.timeout as TextReason, 'env') }
    }
    const c = ctl as Int32Array
    const o = out as Uint8Array
    Atomics.store(c, DONE, 0)
    Atomics.store(c, LEN, 0)
    Atomics.store(c, SPARE, 0)
    try {
      worker?.postMessage({
        path: req.path,
        kind: req.kind,
        maxChars: READ_MAX_CHARS,
        keep: STORE_MAX_CHARS,
        dev: req.dev,
        ino: req.ino,
        size: req.size,
        mtimeMs: req.mtimeMs,
      })
    } catch {
      // worker 已經不在了（上一次死掉還沒收乾淨）：跟這個檔無關
      return died(TEXT_REASON.timeout as TextReason, 'env')
    }
    // 'not-equal' 表示還沒等就已經有答案了，跟 'ok' 一樣
    const got = Atomics.wait(c, DONE, 0, timeoutMs)
    if (got === 'timed-out') return died(TEXT_REASON.timeout as TextReason)

    const n = Atomics.load(c, LEN)
    let msg: any
    try {
      if (n <= 0 || n > o.length) throw new Error('the response length makes no sense')
      msg = JSON.parse(Buffer.from(o.buffer as ArrayBufferLike, 0, n).toString('utf8'))
    } catch {
      // worker 回了看不懂的東西：當它壞了，換一個
      return died(TEXT_REASON.timeout as TextReason)
    }
    deaths = 0
    if (msg?.changed === true) return { status: 'changed' }
    if (msg?.ok !== true) return { status: 'unreadable', reason: toReason(msg?.reason) }
    const text = typeof msg.text === 'string' ? msg.text : ''
    return {
      status: 'ok',
      text,
      chars: Number.isFinite(msg.chars) ? Math.max(0, Math.floor(msg.chars)) : 0,
      truncated: msg.truncated === true,
      hasText: msg.hasText === true,
      pages: Number.isFinite(msg.pages) ? Math.floor(msg.pages) : null,
      unmapped: Number.isFinite(msg.unmapped) ? Number(msg.unmapped) : null,
    }
  }

  return { read, deaths: () => deaths, close: drop }
}

// ── 整個行程共用的那一個 ─────────────────────────────────────

let shared: TextReader | null = null

/** 整個行程共用的讀文字 worker。第一次真的要讀的時候才會開。 */
export function textReader(): TextReader {
  if (!shared) shared = createTextReader()
  return shared
}

/** 收掉共用的那一個（測試與收工用；平常不用叫，worker 是 unref 的）。 */
export function closeTextReader(): void {
  shared?.close()
  shared = null
}
