/**
 * 建捷徑（symlink）給測試用。**Windows 跟 POSIX 不一樣，而且差別很重要。**
 *
 * 這個專案有一整排「捷徑不跟、捷徑不搬、捷徑跳不出範圍」的測試 —— 那是它最硬的
 * 幾條安全不變量。而在 Windows 上，`symlinkSync` 預設要系統管理員權限或開發人員模式：
 *
 *   Error: EPERM: operation not permitted, symlink '…\別的地方' -> '…\Filed\Courses'
 *
 * 於是那些測試在一般的 Windows 上**一直是紅的** —— 紅到沒有人看它們了，
 * 而它們正好是最不該被忽略的那一批。
 *
 * 兩個平台的差別只有一句話：
 *
 *   · **資料夾**：Windows 有 junction，**不需要任何權限**，而且 Node 的
 *     `lstat().isSymbolicLink()` 對它回 true —— 也就是被測的程式看到的東西一模一樣。
 *     所以資料夾的捷徑在 Windows 上**照跑**，不跳過。
 *   · **檔案**：沒有 junction 這種東西，真的需要權限。這一種才跳過，
 *     而且要講清楚為什麼（跳過一條安全測試，至少要讓人看見它被跳過了）。
 */
import { symlinkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WINDOWS = process.platform === 'win32'

/**
 * 資料夾的捷徑。Windows 用 junction（免權限），其他平台用一般的 symlink。
 * **兩邊在 lstat 底下看起來都是捷徑**，所以被測的程式走的是同一條路。
 */
export function linkDir(target, path) {
  symlinkSync(target, path, WINDOWS ? 'junction' : 'dir')
}

/** 這台機器建得了檔案的捷徑嗎？（Windows 要權限或開發人員模式。）只探一次。 */
let fileLinksOk = null
export function canLinkFile() {
  if (fileLinksOk !== null) return fileLinksOk
  const dir = mkdtempSync(join(tmpdir(), 'cb-linkprobe-'))
  try {
    const real = join(dir, 'real.txt')
    writeFileSync(real, 'x')
    symlinkSync(real, join(dir, 'link.txt'), 'file')
    fileLinksOk = true
  } catch {
    fileLinksOk = false
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }) } catch { /* 放過 */ }
  }
  return fileLinksOk
}

/**
 * 檔案的捷徑。**建不起來回 false**，讓呼叫端 `t.skip` 並講出原因 ——
 * 不要讓一條安全測試因為權限而變成紅字。
 */
export function linkFile(target, path) {
  try {
    symlinkSync(target, path, 'file')
    return true
  } catch {
    return false
  }
}

/** 跳過時要講的那一句。**寫死在一個地方**，每一條跳過的理由才會一致。 */
export const NO_FILE_LINKS =
  'this machine cannot create file symlinks (Windows needs elevation or Developer Mode)'
