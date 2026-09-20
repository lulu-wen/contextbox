/**
 * 「把上一次沒做完的事收乾淨」—— **一次收全部三種**。
 *
 * 為什麼要有這一支（稽核 2026-09-20，A-2）：
 * 改名、歸檔各自在自己的 apply／undo 裡收自己那一種，誰都不收別人的。於是這條路走得通：
 *
 *   1. 改名做到一半被砍（renames 那一列停在 started，檔案其實已經改好了）
 *   2. pet 的 watcher 做了一次單檔掃描 —— 新名字被收成另一列，舊那列標成不見了
 *   3. 使用者在面板按「整理」→ /file/apply **只收歸檔**，所以那筆改名還停在 started，
 *      而檔案被搬到 filed 底下
 *   4. 下一次任何指令收尾時，改名那一列的新舊兩個名字在原資料夾都找不到 → 判 failed、
 *      寫「請人工確認」
 *
 * 結果：那個檔好好地躺在 filed 底下，但「它本來叫什麼」只剩資料庫裡那一列 failed，
 * 而 CLI 與面板都只列 done —— 使用者看不到，也復原不回原本的名字。
 *
 * 所以**動檔案的入口一律先把三種都收一次**。收尾本身很便宜（沒有 started 的列就是一次 SELECT），
 * 而且每一個 UPDATE 都有 `AND status='started'` 守著，重複收不會蓋掉任何東西。
 *
 * 這一支**故意放在 rename.ts 與 filing.ts 外面**：那兩支互相 import 會繞成環，
 * 而呼叫端（route 與 cli.mjs）本來就兩邊都認得。
 */
import type { DatabaseSync } from 'node:sqlite'
import { recoverInterruptedRenames } from './rename.ts'
import { recoverInterruptedFilings } from './filing.ts'

/**
 * 收改名與歸檔（清理那一種有自己的 recoverInterrupted，由 cli.mjs 的 settleCleanupState 帶）。
 * **不丟例外**：收尾失敗不可以讓使用者的動作做不成 —— 那兩支自己會把原因寫進 error 欄。
 */
export function settleMoves(db: DatabaseSync): void {
  try { recoverInterruptedRenames(db) } catch { /* 收不掉的原因它自己會寫進 renames.error */ }
  try { recoverInterruptedFilings(db) } catch { /* 同上 */ }
}
