/**
 * 「在檔案總管裡指給我看」（2026-09-22）—— `POST /reveal`。
 *
 * 使用者：「我希望有一個功能是點選該檔案後可以幫忙跳轉到對應的檔案總管位置，
 *            不管是 file group clean 還是其他功能的，只要有檔案出現的話」
 *
 * 起因是更早的那一件事：他按了 File，畫面寫「→ Scholarship applications/」，
 * 然後在檔案總管裡找不到 —— 它其實好好地在 `Documents\Filed` 底下。
 * 面板**從來不給絕對路徑**（不變量 8），所以「它到底在哪」這件事只能由後端自己去開。
 *
 * ── 這一支為什麼可以存在，而且只能長這樣 ──────────────────
 *
 * 它是這個專案裡**第二支會叫作業系統做事的程式**（另一支是 cli.mjs 開瀏覽器）。
 * 所以三條線畫死：
 *
 * 1. **路徑永遠不從呼叫端來。** 送進來的是 itemId，路徑由這支自己去資料庫查。
 *    面板連自己在開哪一條路徑都不知道 —— 那正是它不該知道的東西。
 * 2. **只開得了我們自己管的那幾棵樹**：清理範圍、監看資料夾、`filed`、隔離區。
 *    不在裡面就拒絕，而且**先解捷徑再比**（一個指到 C:\ 的 symlink 不可以變成後門）。
 * 3. **不執行那個檔。** Windows 走 Shell COM 把檔在現有的視窗裡選起來（選，不是開），
 *    macOS 是 `open -R`（同上），Linux 沒有通用的 reveal，所以開它的**父資料夾**。
 *    引數一律用陣列交給 spawn，**不經過 shell** —— 檔名裡的 `&`、引號、`%`
 *    在這裡只是字元，不是語法。
 *
 * 唯讀模式照開：這一支一個位元組都不動。
 */
import { spawn } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { under } from './guard.ts'
import { statusFor, type RouteCtx } from './cleanup-routes.ts'

/** 認得的路徑與方法。已知的路徑用錯方法回 405，不是 404（RC24）。 */
const KNOWN: [RegExp, string[]][] = [
  [/^\/reveal$/, ['POST']],
]

const INTERNAL = 'Could not open the file manager. Nothing was changed.'

function fail(
  send: RouteCtx['send'], code: number, message: string, why: string,
  headers?: Record<string, string>,
): void {
  send(code, { error: message, code: why }, headers)
}

const listOf = (v: string[] | (() => string[]) | undefined): string[] =>
  (typeof v === 'function' ? v() : v) ?? []
const oneOf = (v: string | null | (() => string | null) | undefined): string =>
  String((typeof v === 'function' ? v() : v) ?? '')

/**
 * 這個路徑在不在我們管得到的樹底下。
 *
 * **先 realpath 再比**：`Downloads\shortcut` 指到 `C:\Windows` 的話，
 * 字串比對會過，真的開出去的卻是系統資料夾。
 */
export function revealable(path: string, roots: readonly string[]): boolean {
  let real: string
  try { real = realpathSync(resolve(path)) } catch { return false }
  for (const root of roots) {
    if (!root) continue
    let base: string
    try { base = realpathSync(resolve(root)) } catch { continue }
    if (real === base || under(base, real)) return true
  }
  return false
}

/**
 * Windows 專用的那一段 PowerShell。
 *
 * **為什麼不是直接 `explorer /select,`**：那個每按一次就開一個新視窗（實機：使用者按三次
 * 就有三個），而且新視窗多半出現在其他視窗後面，看起來像沒反應。
 * 這段先去問 Shell 有沒有已經開著的檔案總管視窗：
 *   ① 已經停在目標資料夾的那一個 → 直接在裡面把檔選起來
 *   ② 沒有的話，拿最後一個檔案總管視窗**導航過去**（使用者要的「用現有的視窗跳轉」）
 *   ③ 一個都沒有 → 這時候才開新的
 *
 * **路徑走環境變數，不拼進腳本**。檔名是不可信的輸入，拼字串就是一條注入路徑；
 * `$env:` 讀出來永遠是一個值，不是語法。
 *
 * macOS 不需要這一套：`open -R` 本來就用 Finder 現有的視窗。
 */
/**
 * 把視窗叫到前面來。
 *
 * **這是使用者真正回報的那件事**：「我真的沒有看到檔案總管的 app 圖示被打開」——
 * 視窗其實開了（我從 Shell 數得出來），但 Windows 不讓背景行程搶前景，
 * 所以它出現在別的視窗後面。SetForegroundWindow 有時候會被系統擋掉，
 * 擋掉的時候工作列按鈕會閃 —— 那也是一個看得見的訊號，比完全沒動靜好。
 * 先 SW_RESTORE 是因為那個視窗可能是最小化的。
 */
const FOREGROUND_CS = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class CbFg {',
  '  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);',
  '  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);',
  '  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);',
  '  public static void Show(IntPtr h) {',
  '    if (h == IntPtr.Zero) return;',
  '    if (IsIconic(h)) ShowWindow(h, 9);',
  '    SetForegroundWindow(h);',
  '  }',
  '}',
].join(' ')

export const WINDOWS_REVEAL_PS = [
  "$ErrorActionPreference='SilentlyContinue'",
  '$t = $env:CONTEXTBOX_REVEAL_TARGET',
  'if (-not $t) { exit 1 }',
  '$d = Split-Path -Parent $t',
  // **PowerShell 的跳脫字元是反引號，不是反斜線** —— JSON.stringify 出來的 \" 在這裡會把字串切斷。
  // 那段 C# 裡沒有單引號，所以用單引號包最乾淨：裡面的雙引號原樣留著。

  '$sh = New-Object -ComObject Shell.Application',
  '$same = $null; $any = $null',
  'foreach ($w in $sh.Windows()) {',
  '  $p = $null; try { $p = $w.Document.Folder.Self.Path } catch { $p = $null }',
  '  if (-not $p) { continue }',
  '  $any = $w',
  '  if ($p -eq $d) { $same = $w; break }',
  '}',
  '$hit = if ($same) { $same } else { $any }',
  'if ($hit) {',
  '  if (-not $same) { try { $hit.Navigate2($d); Start-Sleep -Milliseconds 250 } catch {} }',
  '  try { $hit.Document.SelectItem($t, 1 + 4 + 8 + 16) } catch {}',
  '  try { $hit.Visible = $true } catch {}',
  // **Add-Type 要花半秒**（它在編譯 C#），所以只有真的有視窗要叫到前面時才做。
  // 沒有視窗那條路是 Start-Process，本來就會自己跳出來。
  "  Add-Type -TypeDefinition '" + FOREGROUND_CS + "'",
  '  try { [CbFg]::Show($hit.HWND) } catch {}',
  '  exit 0',
  '}',
  "Start-Process explorer.exe -ArgumentList ('/select,' + $t)",
].join('; ')

/** 一次要跑的東西。`env` 只有 Windows 那條用得到（路徑靠它傳，不拼進腳本）。 */
export type RevealRun = { bin: string; argv: string[]; env?: Record<string, string> }

/** 這台機器怎麼「指給我看」。 */
export function revealCommand(path: string, platform = process.platform): RevealRun {
  if (platform === 'win32') {
    return {
      bin: 'powershell.exe',
      argv: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WINDOWS_REVEAL_PS],
      env: { CONTEXTBOX_REVEAL_TARGET: path },
    }
  }
  // macOS：**已經是「用現有視窗」的行為** —— open -R 是叫 Finder 選起來，不是開新程式。
  if (platform === 'darwin') return { bin: 'open', argv: ['-R', path] }
  // Linux／其他：沒有通用的 reveal，開父資料夾。**開資料夾不會執行任何東西**，
  // 而且大部分檔案管理員遇到已經開著的資料夾會沿用同一個視窗或分頁。
  return { bin: 'xdg-open', argv: [dirname(path)] }
}

/** Windows 那條走不了（沒有 PowerShell）時的退路：原本那個一定會開新視窗的寫法。 */
export function revealFallback(path: string, platform = process.platform): RevealRun | null {
  if (platform !== 'win32') return null
  return { bin: 'explorer.exe', argv: ['/select,' + path] }
}
/**
 * `/reveal` 這一條。認得就處理完回 true，認不得回 false 讓下一個接手。
 */
export function revealRoutes(ctx: RouteCtx): boolean {
  const { url, method, send } = ctx
  const p = url.pathname
  if (p !== '/reveal') return false

  const known = KNOWN.find(([re]) => re.test(p))
  if (known && !known[1].includes(method)) {
    fail(send, 405, `This route only takes ${known[1].join(', ')}.`, 'BAD_METHOD', { allow: known[1].join(', ') })
    return true
  }

  // body 走白名單（跟改名／歸檔同一條規矩）：不認得的欄位是「看不懂」，不是「沒帶」
  const body = ctx.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail(send, 400, 'Say which file: itemId is the id of a file on one of the lists.', 'BAD_BODY')
    return true
  }
  const extra = Object.keys(body).filter(k => k !== 'itemId')
  if (extra.length) {
    fail(send, 400, `Could not make sense of the body: unknown field ${extra.slice(0, 3).join(', ')}. This route only takes itemId.`, 'BAD_BODY')
    return true
  }
  const itemId = body.itemId
  if (typeof itemId !== 'string' || !itemId || itemId.length > 200) {
    fail(send, 400, 'itemId must be a string of 1 to 200 characters.', 'BAD_BODY')
    return true
  }

  let row: { path?: unknown } | undefined
  try {
    row = ctx.db.prepare('SELECT path FROM file_items WHERE id=?').get(itemId) as typeof row
  } catch (e) {
    send(statusFor(e), { error: INTERNAL, code: 'INTERNAL' })
    return true
  }
  const path = String(row?.path ?? '')
  if (!path) {
    fail(send, 404, 'There is no file with that id any more. Close the panel and open it again.', 'NOT_FOUND')
    return true
  }

  // **捷徑不跟**（跟清理與歸檔同一條）：lstat 看的是連結本身
  let isFile: boolean
  try {
    const st = lstatSync(path)
    if (st.isSymbolicLink()) {
      fail(send, 409, 'That is a shortcut, and this does not follow shortcuts.', 'BAD_TARGET')
      return true
    }
    isFile = st.isFile()
  } catch {
    fail(send, 409, 'That file is not there any more — it may have been cleaned up, renamed or moved.', 'GONE')
    return true
  }
  if (!isFile) {
    fail(send, 409, 'That is not a file.', 'BAD_TARGET')
    return true
  }

  const roots = [
    ...listOf(ctx.roots),
    ...listOf(ctx.restoreRoots),
    oneOf(ctx.filed as string | (() => string) | undefined),
    oneOf(ctx.screenshotsDir),
    ctx.quarantine,
  ].filter(Boolean)
  if (!revealable(path, roots)) {
    fail(send, 403, 'That file is outside the folders this tool looks after, so it will not open it.', 'OUT_OF_SCOPE')
    return true
  }

  // **不經過 shell**，引數是陣列。開完就放生：它活得比這個請求久是正常的。
  const run = (cmd: RevealRun): boolean => {
    try {
      const child = spawn(cmd.bin, cmd.argv, {
        stdio: 'ignore',
        detached: process.platform !== 'win32',
        windowsHide: true,
        ...(cmd.env ? { env: { ...process.env, ...cmd.env } } : {}),
      })
      // PowerShell 不在（精簡版 Windows）就退回那個一定會開新視窗的寫法。
      // **開一個新視窗比什麼都不開好**。
      child.on('error', () => {
        const back = revealFallback(path)
        if (!back) return
        try {
          const second = spawn(back.bin, back.argv, { stdio: 'ignore', windowsHide: true })
          second.on('error', () => { /* 兩條都不行就是不行，已經回 200 了 */ })
          second.unref()
        } catch { /* 同上 */ }
      })
      child.unref()
      return true
    } catch { return false }
  }
  if (!run(revealCommand(path))) {
    fail(send, 500, INTERNAL, 'INTERNAL')
    return true
  }
  // **不回路徑**（不變量 8）：面板不需要知道，知道了就是一條新的外洩面
  send(200, { ok: true })
  return true
}
