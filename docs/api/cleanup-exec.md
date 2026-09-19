# B 交付：清理計畫、隔離、復原與清空

本次只實作 B 模組。D 需將下列函式接到 `cleanup-routes.ts`、server 與 CLI；目前既有寫入 routes / CLI 仍回未實作。C 可使用回傳的 plan 與 quarantine DTO。

## 先跑測試

需要 Node 24，零外部依賴，不用 npm install。在 repo 根目錄：

```bash
node --test test/cleanup-plans.test.mjs test/cleanup-exec.test.mjs test/cleanup-undo.test.mjs
node --test test/*.test.mjs
```

測試透過 A 的 `scanDownloads` 產生候選，檔案與 SQLite 都放在暫存資料夾。包含真正子行程在 rename 後中斷、DB 寫入失敗、權限錯誤、EXDEV、同名復原、略過、重試、symlink/hardlink、隔離檔被替換、七天與二次確認。

## D 串接範例

```ts
import { createPlan, getPlan, dismissPlan } from '../../core/cleanup-plans.ts'
import { applyPlan, undoPlan, listQuarantine, DEFAULT_QUARANTINE } from '../../core/cleanup-exec.ts'
import { prepareEmptyQuarantine, emptyQuarantine } from '../../core/cleanup-quarantine.ts'

// db 由既有 core/db.ts open() 提供；opts 只能由後端設定產生。
const opts = {
  roots: config.cleanup.roots, // 清理專用的根目錄，預設只有 Downloads（不是截圖功能的 watch）
  quarantine: DEFAULT_QUARANTINE,
  maxBytes: config.maxBytes,
  readonly: config.readonly,
}

// POST /cleanup/plans
// requestId：每次「建立計畫」產生一次，網路重送沿用同一值。
const plan = createPlan(db, { candidateIds: body.candidateIds, requestId: body.requestId })

// POST /cleanup/plans/:id/apply —— 必須在使用者確認後呼叫。
const applied = applyPlan(db, plan.id, { ...opts, skippedIds: body.skippedIds })

// POST /cleanup/plans/:id/undo
const restored = undoPlan(db, plan.id, opts)

// POST /cleanup/plans/:id/dismiss
dismissPlan(db, plan.id)

// GET /cleanup/quarantine
const contents = listQuarantine(db)

// POST /cleanup/quarantine/empty（第一次：只預覽，不刪除）
const preview = prepareEmptyQuarantine(db, opts)
// 回 { token, expiresAt, itemCount, bytes, message }，C 顯示第二次確認。

// POST 同一路徑（第二次：必須帶 preview.token 與 confirmed: true）
const emptied = emptyQuarantine(db, { ...opts, token: body.token, confirmed: body.confirmed })
// 回 { deletedCount, deletedBytes, errors: [{ seq, error }] }
```

上面是各 route 的獨立範例，不是啟動時依序執行的程式。**不可把 HTTP body 展開到 opts**：使用者不能從 API 指定任意路徑、大小上限或覆寫 readonly。

### 選取與重送

- `candidateIds` 省略：採 A 的 `DEFAULT_CHECK_MIN`，預設只選中、高信心；空陣列是沒有選任何檔案，不是全部。
- 明確帶 candidate ids 可以選入低信心，但仍不能繞過路徑、大小、敏感檔案等保護。
- （第二輪 R2-8）HTTP route 建計畫走 `cleanup-routes.ts` 的 `createPlanForRoots`：截圖資料夾（`cleanup.screenshotsDir`）底下只收截圖類的候選，其他的 id 回 `STALE_CANDIDATE`。直接呼叫 `createPlan` 不會替你篩這一層，見 `docs/api/README.md` 的清單一節。
- 一個檔案的所有理由會放進同一份計畫；`itemCount` 與 `bytes` 不會重複計算。`skippedIds` 是 **candidate id**；略過其中一個理由就略過整個檔案。
- `requestId` 讓建立計畫重送回同一 plan；相同 requestId 指定不同候選回 `CONFLICT`。D 的 HTTP route 應要求這個欄位（或從 Idempotency-Key header 提供）。
- apply 開始後，略過決定會固定；接著做（還沒跑完的 proposed）可以省略 skippedIds 或帶相同選取。已完成、已復原、已取消的 plan 不會再搬檔。
- （2026-09-19 稽核第二輪 R2-3）**跑完過一次的 plan 再 apply 原樣回傳**：applied、partial、error 都一樣，不重試任何一項、不會再搬檔（以前 partial/error 會重試失敗的那幾個；使用者用別份計畫搬走又放回之後，遲到的重送會把它再搬一次）。只有還沒跑完的 proposed（包括做到一半中斷、已經有 journal 的）會接著做。停在 proposed／partial／error 而且有 restore journal 的（開始 undo 過）再 apply 回 `CONFLICT`，只能繼續 undo；applied 與 restored 一律原樣回傳。失敗的檔要重試，就重新掃描、建立新 plan。
- （2026-09-19 稽核 RC4 之後）**計畫是一次性的**：只有 `proposed` 的計畫會佔住檔案，partial/error 的計畫不再擋新計畫，重試＝建新計畫。還沒開始的計畫可以用 `releasePlan` 放棄（計畫作廢、候選不動）；`dismissPlan` 則是使用者拒絕這些檔。做到一半中斷的 proposed 計畫不能放棄（`releasePlan` 回 `CONFLICT`），只能接著 apply 做完，或 undo 把已經在隔離區的放回原位（還沒搬的不動）。
- dismiss 只接受未開始執行的 plan；已搬動的計畫請 undo。
- 清空 token 五分鐘有效，綁定當次預覽的 journal entries。重送同一 token 回原結果；失敗項目要重新預覽、再次確認後重試。

### 中斷之後的收尾（2026-09-19 稽核第二輪）

套用或復原做到一半被砍（kill -9、斷電、Ctrl+C 落在 rename 與寫 done 之間）時，journal 停在 `started`，逐項結果是 `unknown`：**說不準檔案在原位還是在隔離區**。畫面上的原因不再叫人「再套用一次」—— 跑完過的 plan 再 apply 原樣回傳，接不完。

- `recoverInterrupted(db, opts)`（`cleanup-exec.ts`）：只看檔案證據改 journal，**不搬任何檔**。隔離區那份指紋相符 → done；原位那份相符、隔離區只有預留的空檔 → reverted（`NOT_MOVED`）；復原中斷、檔還在隔離區 → failed（可以再復原）；其他維持 `started`。拿清理鎖（別的行程拿著回 `BUSY`）；只改資料庫，唯讀模式也能跑；計畫的 status 不動。回 `{ recovered }`。呼叫端在讀或動清理狀態之前先跑一次（CLI 的指令、pet 開機與背景重掃）。
- `releaseStalePlans(db, olderThanMs)`（`cleanup-plans.ts`）：放棄放了超過 `olderThanMs`、**從沒開始**（沒有任何 journal）的 proposed 計畫，語意跟 `releasePlan` 一樣（候選不動）。建立時間讀不懂的不動。回放棄了幾份。
- `undoPlan` 碰到**根本不在隔離區**的項目（隔離區那個位置不存在，或只是預留的 0 byte 空檔）直接跳過、不算錯；`started` 的那種結成 reverted（原位還在是 `NOT_MOVED`，原位也不見了是 `NOT_MOVED_GONE`）。隔離區那個位置有內容、指紋又對不上 → `VERIFY_FAILED`「隔離區裡的這個檔跟當初搬進去的對不上，沒有放回；請人工檢查隔離區。」，那一列不動。做到一半中斷的 proposed 計畫 undo 之後，從來沒碰過的項目逐項是 `cancelled`。
- apply 的 rename 之後驗證沒過：原位還空著就**搬回原位**（那一項 failed，原因 `MOVED_BACK`）；搬不回去（原位已經有別的檔）就留在隔離區，journal 維持 `started`、逐項 `unknown`，留給 `recoverInterrupted` 與 undo。

### DTO 與錯誤

`getPlan/createPlan/dismissPlan` 回：

```text
id, status, itemCount, createdAt, appliedAt, error, bytes,
items: [{ itemId, name, bytes, mtime, candidateIds, skipped,
          reasons: [{ kind, confidence, reason, evidence }] }]
```

`applyPlan/undoPlan` 額外回 `quarantinedCount`、`quarantinedBytes`、`restoredCount`、`undoable`。檔案層級失敗會回 `partial/error`，錯誤文字不帶 OS 路徑；成功項目仍可復原。

`listQuarantine` 回陣列：`seq, planId, itemId, name, bytes, quarantinedAt, canEmptyAt, canEmptyNow`。`quarantinedBytes` 是 Downloads 搬出的大小；同磁碟隔離不會釋放實際磁碟空間。

頂層 `CleanupError` 的 `code` 對到哪一個 HTTP 狀態碼，**以 `docs/api/README.md` 的錯誤表為準** —— 那是唯一一張，跟 `core/cleanup-routes.ts` 的 `HTTP_FOR_CODE` 一致，`test/repo.test.mjs` 會比。（這裡原本另外寫了一份對應，跟實作不一樣：`EMPTY_PLAN` 其實是 409、`BUSY` 是 503、`CONFIRMATION_EXPIRED` 是 410、`CONFIRMATION_REQUIRED` 是 428。）設定與無法預期的錯誤回通用 500；不要把 SQLite/OS exception.message 直接送到 UI。

`planSnapshots`、`listJournal`、`activeQuarantine` 等為後端內部資料，含原始路徑，**不要直接 JSON 回給 UI**。

## 隔離與 journal 格式

```text
~/.contextbox/quarantine/
  <plan UUID>/
    <item UUID>/
      content
```

檔名不參與隔離路徑組裝。原路徑、原檔名、大小、mtime、scanner sha256 與候選理由存於 `cleanup_snapshots`；真正搬移前另算 sha256（包含 A 沒 hash 的半成品／空檔），存入 journal 與 `cleanup_move_details`，並保留 dev/ino 檔案身分與 `completed_at`。

每次搬移先提交 `cleanup_journal.status=started`，再保留目的檔名、rename，驗證後標 done。來源 hash/size/mtime 不符就拒絕。重試以目的地的 inode 與內容判斷是否已搬成功，不會只因同名檔存在就宣稱完成。

undo 優先原路徑，已被檔案、資料夾或 dangling symlink 佔用時改為 `filename.restored`、`.restored.2` 等。原本 file_items.path 保留作為來源追蹤；實際復原位置以 restore journal.to_path 為準。

新增 companion tables 由 B 模組首次使用時 `CREATE TABLE IF NOT EXISTS`，不必改 A 的 db.ts。SQLite 以短交易更新狀態；`cleanup_operation_lock` 序列化同一 DB 的 B 寫入，行程死亡後可接手。PID 仍存在時保守回 BUSY。

## 清空安全邊界

- 七天從 **搬移完成時間** 起算，與原檔 mtime 無關。中斷後才補上完成紀錄時，保守重新起算七天。
- 只處理 journal 已完成、未復原、未清空且符合當次確認的檔案；隔離區內不認得的檔案不刪。
- 刪除前重新檢查設定隔離區、完整路徑、symlink、硬鏈結、inode、大小、mtime、sha256。
- 唯一正式刪檔呼叫在 `cleanup-quarantine.ts`；`test/repo.test.mjs` 只對該檔的單一呼叫開例外，其他正式程式仍禁止刪檔。
- 永久清空另有 `cleanup_purges` write-ahead 記錄，不擴充 A 的 journal op enum；刪完但 DB 寫入失敗仍可重試。空目錄與未完成搬移留下的零位元目的地保留，不做遞迴清除。

### D 必須調整的既有整合點

1. 現有 `healthSnapshot/quarantineStats` 以實體檔案 mtime 計算 canEmptyNow，會讓剛隔離的舊 zip 顯示可清空。請改用 `listQuarantine` 的 `quarantinedAt/canEmptyAt`，計數也以此清單為準。
2. cleanup routes / CLI 的寫入占位接到上述函式；沿用 loopback、token、body 上限等既有防線。C 的 pet state 仍屬 C 工作。
3. Windows/macOS 各跑 smoke；本次實測環境為 Linux + Node 24。

## 目前限制

- 跨磁碟 rename（EXDEV）不使用 copy+delete：那一項失敗、保留原檔。計畫是一次性的（見上面 R2-3），把隔離區放到跟來源同一顆碟之後要重新掃描、建新 plan；或後續增加符合安全規格的跨磁碟方案。
- 目的地使用 `wx` 專屬保留檔及身分檢查，防止一般碰撞；純 Node 的 rename 無法提供跨平台的原子 no-replace。對於另一個有相同 OS 權限的行程，恰好在最後檢查與系統呼叫之間換檔／改目錄，仍存在競態；不要將此功能當作惡意本機行程的隔離機制。
- 支援行程中斷復原；未驗證斷電與檔案系統損毀復原。資料庫和隔離區應一起保留。
