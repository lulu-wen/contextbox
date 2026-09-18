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
- 一個檔案的所有理由會放進同一份計畫；`itemCount` 與 `bytes` 不會重複計算。`skippedIds` 是 **candidate id**；略過其中一個理由就略過整個檔案。
- `requestId` 讓建立計畫重送回同一 plan；相同 requestId 指定不同候選回 `CONFLICT`。D 的 HTTP route 應要求這個欄位（或從 Idempotency-Key header 提供）。
- apply 開始後，略過決定會固定；重試可以省略 skippedIds 或帶相同選取。已完成、已復原、已取消的 plan 不會再搬檔。
- partial/error 的 apply 可重試。開始 undo 後只能繼續 undo，不能重新 apply。若檔案已變更，先 undo 結束舊 plan，再掃描、建立新 plan。
- （2026-09-19 稽核 RC4 之後）**計畫是一次性的**：只有 `proposed` 的計畫會佔住檔案，partial/error 的計畫不再擋新計畫，重試＝建新計畫。舊的 partial 計畫仍可重跑，但檔案如果已經被新計畫搬走，那一項會安全地失敗。還沒開始的計畫可以用 `releasePlan` 放棄（計畫作廢、候選不動）；`dismissPlan` 則是使用者拒絕這些檔。
- dismiss 只接受未開始執行的 plan；已搬動的計畫請 undo。
- 清空 token 五分鐘有效，綁定當次預覽的 journal entries。重送同一 token 回原結果；失敗項目要重新預覽、再次確認後重試。

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

- 跨磁碟 rename（EXDEV）不使用 copy+delete，回可重試錯誤並保留原檔。隔離區需與來源同磁碟，或後續增加符合安全規格的跨磁碟方案。
- 目的地使用 `wx` 專屬保留檔及身分檢查，防止一般碰撞；純 Node 的 rename 無法提供跨平台的原子 no-replace。對於另一個有相同 OS 權限的行程，恰好在最後檢查與系統呼叫之間換檔／改目錄，仍存在競態；不要將此功能當作惡意本機行程的隔離機制。
- 支援行程中斷復原；未驗證斷電與檔案系統損毀復原。資料庫和隔離區應一起保留。
