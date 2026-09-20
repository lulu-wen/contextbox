/**
 * 「讀一個檔的文字」這件事本身 —— 不碰 worker、不碰共用記憶體，所以測試可以直接呼叫它。
 * 跑在 worker 裡的那一層在 core/read-text-worker.ts。
 *
 * 規矩：
 * - **什麼都不可以往外丟**。任何例外都要變成一個「讀不懂」的答案 ——
 *   例外飛出去 worker 就死了，而「死掉」那條路要留給真的死掉（呼叫端要等滿 5 秒才知道）。
 * - **只讀不寫**：O_RDONLY ＋ O_NOFOLLOW 開檔，開完 fstat 再驗一次身分
 *   （掃描到現在檔案被換掉的話回 `{ changed: true }`，那一輪什麼都不記）。
 * - 純文字檔只讀開頭：`textHeadBytes()` 說要幾個 byte 就讀幾個，一個 20 MB 的 csv
 *   只會讀 80 KB，結果跟整個檔讀進來一模一樣（見 decodeText 的 partial）。
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { ExtractError, decodeText, docxText, pptxText, textHeadBytes } from './office-text.ts'
import { PdfError, pdfText } from './pdf-text.ts'
import { TEXT_REASON, type TextKind } from './read-text.ts'

const NOFOLLOW = constants.O_NOFOLLOW ?? 0

/** 一個工作：要讀哪個檔、讀多少、掃描時看到的身分。 */
export type TextJob = {
  path: string
  kind: TextKind
  /** 叫上游模組最多讀幾個字 */
  maxChars: number
  /** 回傳最多留幾個字（超過就截斷並標 truncated） */
  keep: number
  dev: number
  ino: number
  size: number
  mtimeMs: number
}

/** 答案。`changed` 與 `ok` 是互斥的兩種形狀，`ok: false` 帶 reason。 */
export type TextJobResult =
  | { changed: true }
  | { ok: false; reason: string }
  | {
      ok: true
      text: string
      chars: number
      truncated: boolean
      hasText: boolean
      pages: number | null
      unmapped: number | null
    }

/** 讀檔：身分對不上回 null（呼叫端當成 changed）。純文字只讀開頭。 */
function readBytes(job: TextJob): { buf: Buffer; sliced: boolean } | null {
  let fd: number
  try { fd = openSync(job.path, constants.O_RDONLY | NOFOLLOW) } catch { return null }
  try {
    const st = fstatSync(fd)
    // 跟 cleanup-scanner.ts 的 sha256Of 同一組條件：掃描看到的那個檔，現在還是同一個嗎
    if (!st.isFile()
        || (!st.ino && !job.ino)
        || st.dev !== job.dev
        || st.ino !== job.ino
        || st.size !== job.size
        || st.mtimeMs !== job.mtimeMs) return null
    const want = job.kind === 'text'
      ? Math.min(st.size, textHeadBytes(job.maxChars))
      : st.size
    const buf = Buffer.allocUnsafe(want)
    let off = 0
    while (off < want) {
      const n = readSync(fd, buf, off, want - off, off)
      if (n <= 0) break
      off += n
    }
    return { buf: off === want ? buf : buf.subarray(0, off), sliced: want < st.size }
  } finally {
    closeSync(fd)
  }
}

type Extracted = {
  text: string
  truncated: boolean
  pages: number | null
  unmapped: number | null
  /** PDF 自己說得出有沒有文字層；其他格式看有沒有非空白字。 */
  hasText: boolean | null
}

function extract(job: TextJob, got: { buf: Buffer; sliced: boolean }): Extracted {
  if (job.kind === 'text') {
    const r = decodeText(got.buf, { maxChars: job.maxChars, partial: got.sliced })
    return { text: r.text, truncated: r.truncated, pages: null, unmapped: null, hasText: null }
  }
  if (job.kind === 'docx') {
    const r = docxText(got.buf, { maxChars: job.maxChars })
    return { text: r.text, truncated: r.truncated, pages: null, unmapped: null, hasText: null }
  }
  if (job.kind === 'pptx') {
    // **pages 照 DDL 只給 PDF**：投影片張數是另一件事，硬塞進來會讓那一欄的意思變成兩種。
    // 之後 P2 真的要用再開一欄。
    const r = pptxText(got.buf, { maxChars: job.maxChars })
    return { text: r.text, truncated: r.truncated, pages: null, unmapped: null, hasText: null }
  }
  // maxPages 用 pdf-text 的預設（前 3 頁）：P2 只需要看得出這是什麼文件
  const r = pdfText(got.buf, { maxChars: job.maxChars })
  return {
    text: r.text,
    truncated: r.truncated,
    pages: r.pages,
    unmapped: r.unmappedRatio,
    hasText: r.hasTextLayer,
  }
}

/** 讀不懂的原因。上游的 TOO_LARGE 是「這個檔的處理量超過上限」，對使用者就是「太大」。 */
export function reasonOf(err: unknown): string {
  if (err instanceof ExtractError || err instanceof PdfError) {
    return err.code === 'TOO_LARGE' ? TEXT_REASON.tooLarge : TEXT_REASON.unreadable
  }
  // 配置失敗（字串太長、緩衝區配不出來）。真的把 heap 吃光是接不住的，那條路是呼叫端的逾時。
  if (err instanceof RangeError) return TEXT_REASON.outOfMemory
  return TEXT_REASON.unreadable
}

/** 數 code point（不是 UTF-16 單位）。 */
function countCodePoints(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xdc00 && c <= 0xdfff) continue
    n++
  }
  return n
}

/** 切前 n 個 code point（不會切在代理對中間）。 */
function head(s: string, n: number): string {
  let count = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xdc00 && c <= 0xdfff) continue
    if (count === n) return s.slice(0, i)
    count++
  }
  return s
}

/**
 * 這串字看起來是給人看的嗎？NUL 與 C0 控制字元（不含 \t\n\r）佔超過 2% 就不算。
 * 純二進位檔被當成 .txt 時，讀出來的東西沒有意義，存了只會讓 P2 拿垃圾去問模型。
 */
export function looksLikeText(s: string): boolean {
  if (!/\S/.test(s)) return false
  const look = s.slice(0, 4096)
  let bad = 0
  for (const ch of look) {
    const c = ch.codePointAt(0)!
    if (c === 0 || (c < 0x20 && c !== 9 && c !== 10 && c !== 13) || c === 0x7f) bad++
  }
  return bad / Math.max(1, [...look].length) <= 0.02
}

/** 讀一個檔。**保證不丟例外。** */
export function runTextJob(job: TextJob): TextJobResult {
  try {
    const got = readBytes(job)
    if (got === null) return { changed: true }
    if (got.buf.length === 0) {
      // 讀到的時候是空的：當成沒有文字層，不是錯
      return { ok: true, text: '', chars: 0, truncated: false, hasText: false, pages: null, unmapped: null }
    }
    let e: Extracted
    try { e = extract(job, got) }
    catch (err) { return { ok: false, reason: reasonOf(err) } }
    const chars = countCodePoints(e.text)
    const text = chars > job.keep ? head(e.text, job.keep) : e.text
    return {
      ok: true,
      text,
      chars,
      truncated: e.truncated || chars > job.keep,
      // **純二進位垃圾不算有文字**：一個 .txt 裡全是 NUL 與控制字元時，/\S/ 會成立，
      // 結果一堆亂碼被存起來、之後還會被送去問模型（P1 驗證員）。
      hasText: e.hasText === null ? looksLikeText(e.text) : e.hasText,
      pages: e.pages,
      unmapped: e.unmapped,
    }
  } catch (err) {
    return { ok: false, reason: reasonOf(err) }
  }
}
