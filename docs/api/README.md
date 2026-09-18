# API 範例

**D 的第一天交付。** 這個資料夾的每一個 `.json` 都是**真實回應的樣子**，
C 可以直接拿去當 mock，不用等後端寫好。

```bash
# C 開發時這樣用：把 docs/api 當靜態檔端出來
node -e "import('node:http').then(h=>h.createServer((q,s)=>{const f='docs/api'+q.url.replace(/\?.*/,'')+'.json';import('node:fs').then(fs=>{try{s.setHeader('content-type','application/json');s.end(fs.readFileSync(f))}catch{s.statusCode=404;s.end('{}')}})}).listen(7392,()=>console.log('mock on 7392')))"
```

## 通用規則

**全部走既有本機 server 的防線**：只綁 `127.0.0.1`、要帶 token、Origin 白名單。
不用另外做一套。

| | |
|---|---|
| 認證 | header `x-contextbox-token`（既有機制） |
| body 上限 | 1MB，超過直接 413 |
| 所有 POST | **idempotent**。同一個 plan 重送 apply 不會搬第二次 |
| 時間 | 一律 ISO 8601，UTC |
| 大小 | 一律 bytes，整數 |

## 錯誤格式

沿用既有 server 的 `{ error: 字串 }`，**多一個 `code` 給程式判斷**。
人看的話讀 `error`，程式分支看 `code`。

```json
{ "error": "這個 plan 已經套用過了，不會再搬一次。", "code": "PLAN_ALREADY_APPLIED" }
```

| HTTP | code | 什麼時候 |
|---|---|---|
| 400 | `BAD_BODY` | JSON 壞掉、缺必填欄位 |
| 401 | `BAD_TOKEN` | token 不對 |
| 403 | `FORBIDDEN` | Origin 不在白名單 |
| 404 | `NOT_FOUND` | plan／candidate／item 不存在 |
| 409 | `PLAN_ALREADY_APPLIED` | 重送 apply |
| 409 | `QUARANTINE_TOO_YOUNG` | 還沒滿七天就要清空 |
| 409 | `CONFIRM_REQUIRED` | 清空隔離區沒帶確認字串 |
| 413 | `BODY_TOO_LARGE` | body 超過 1MB |
| 500 | `INTERNAL` | 其他 |

> **404 與 500 不可以把本機路徑放進 `error`。** 那條訊息會出現在 UI 上。

## 路徑怎麼給 UI

**不給絕對路徑。** UI 需要的是「使用者認得出這是哪個檔」，不是完整路徑。

```json
{ "name": "report (1).pdf", "folder": "Downloads", "subdir": "2026/09" }
```

要讓使用者在檔案總管打開的話，走一個獨立的 `POST /cleanup/reveal { itemId }`，
由後端自己組路徑 —— **路徑永遠不離開後端**。

## 檔案清單

| 檔案 | 對應 route |
|---|---|
| `health.json` | `GET /health`　**不帶 token** |
| `health-with-token.json` | `GET /health`　帶 token |
| `cleanup-scan.json` | `POST /cleanup/scan` |
| `cleanup-candidates.json` | `GET /cleanup/candidates` |
| `cleanup-plans-create.json` | `POST /cleanup/plans` |
| `cleanup-plans-apply.json` | `POST /cleanup/plans/:id/apply` |
| `cleanup-plans-apply-partial.json` | 同上，**搬到一半壞掉** |
| `cleanup-plans-undo.json` | `POST /cleanup/plans/:id/undo` |
| `cleanup-plans-list.json` | `GET /cleanup/plans?undoable=1`　歷史面板用 |
| `cleanup-quarantine.json` | `GET /cleanup/quarantine` |
| `cleanup-quarantine-empty-preview.json` | `POST /cleanup/quarantine/empty`　**第一次（預覽）** |
| `pet-state.json` | `GET /pet/state` |
| `errors.json` | 每一種錯誤長什麼樣 |

### 每個計畫回應都帶**逐項結果**

`POST /cleanup/plans`、`GET /cleanup/plans/:id`、`…/apply`、`…/undo`、`…/dismiss`
的 `items[]` 每一項都多兩個欄位：

| 欄位 | 值 |
|---|---|
| `outcome` | `pending`（還沒做）／`moved`（在隔離區）／`skipped`（你略過的）／`failed`（沒搬成）／`restored`（已放回）／`purged`（滿七天已刪除） |
| `why` | 只有 `failed` 有。人話、**不帶路徑** |
| `restoredAs` | 只有 `restored` 而且**被改名**的才有。放回來時原位置已被佔，實際的檔名（例如 `a.zip.restored`） |

**UI 不可以用「勾了幾個」去推算搬了幾個。** 要看 `quarantinedCount`
與每一項的 `outcome`。CLI 那邊踩過一次：一律印 ✔，全失敗時畫面上是一排 ✔
後面接「搬進隔離區 0 個」。

### `GET /cleanup/plans` —— 計畫列表

形狀刻意跟 demo 的 `/demo/cleanup/history` 一樣（`{ total, offset, limit, operations }`），
歷史面板兩個模式共用同一段渲染。

| 參數 | 意思 |
|---|---|
| `undoable=1` | 隔離區裡**現在**還有東西的。已復原、已被清空的都不算。`items` 只列還能放回去的 |
| `pending=1` | 還沒做完、還佔著檔案的（proposed／partial／error）。給「接續上次那份」用 |
| `offset`、`limit` | `limit` 1～100（預設 20）。超過最後一頁會夾回最後一頁 |

### 建計畫要帶**勾了的 id**，不是讓後端拿預設

`POST /cleanup/plans { candidateIds, requestId }`：

- `candidateIds` 送**勾了的那些檔的全部 id**（一個檔有兩條理由就送兩個）。
  不帶的話 ＝「清單上打 ✔ 的那些」（跟 `GET /cleanup/candidates` 的 `defaultChecked` 一模一樣，
  被否決的不算）。使用者主動勾起來的低信心檔不會在裡面 —— 所以 UI 一定要帶。
- `requestId`：**同一份勾選重送時沿用同一個**。回應在網路上丟了再按一次，
  會拿到同一份計畫，不會多建、也不會多搬。勾選改了才換新的。
- 唯讀模式直接回 403，**一份計畫都不建**（建了會卡在 proposed、永遠佔住那些檔）。
- 撞到 409 `CONFLICT` 代表有別的計畫佔著這些檔。用 `GET /cleanup/plans?pending=1`
  找出來**給使用者看**，讓他選擇接續 —— 不可以自動套用，那份的內容可能跟現在的勾選不一樣。
- 撞到 409 `STALE_CANDIDATE` 代表清單變了。**一個都不搬**，重新載入給使用者再看一眼。

### 復原的檔不會回到**這次的**清理清單

復原過的檔，**同樣的理由**不會再被提議（你復原過就代表想留著）。
UI 不要自己把檔加回清單 —— 從後端重新載入。

但**不要**跟使用者說「之後不會再被提議」，那不一定是真的：

- 之後符合**新的**理由（例如又放了 60 天，變成 old-download）會再出現
- **原位置被佔時**（清掉之後又下載了同名的檔），放回來的那份會改名成 `原檔名.restored`，
  重掃後它是那個新檔的重複檔 —— 會以 duplicate 98 分、**預設勾**的身分再出現

改名的那幾個，`items[]` 裡會有 `restoredAs`（只有檔名，不帶路徑）。UI 要講出來，
不然使用者以為「放回原位」—— 其實原位是後來那個檔。

### 清空隔離區是**一個 route、兩個階段**

`POST /cleanup/quarantine/empty` 不帶 `token` 是預覽，回 `phase: "preview"` 加一個
五分鐘內有效的 `token`；帶 `{ token, confirmed: true }` 才真的刪，回 `phase: "done"`。

`confirmed` 必須是**布林 true**。送字串 `"true"`／`"false"` 一律被拒（428）——
字串在 JS 是 truthy，而這是整個專案唯一會真的刪檔的路徑。

### 錯誤代碼怎麼分

| 狀態碼 | 意思 | C 該做什麼 |
|---|---|---|
| 400 | 請求本身有問題 | 改 body 再送 |
| 403 | 唯讀模式 | 告訴使用者，不要重試 |
| 404 | 找不到那份計畫 | 重新拿清單 |
| 409 | 狀態衝突（候選變了、已經套用過、沒東西可清） | 重新掃描或重新拿清單 |
| 410 | 二次確認過期 | 重新預覽 |
| 428 | 還沒預覽就確認 | 先打一次不帶 token 的 |
| 503 | 另一個清理動作正在跑 | 等幾秒重試 |
| 500 | 這台機器的問題 | 顯示「後端出狀況」，不要自動重試 |

**逐項失敗不是路由錯誤。** 一個檔搬不動的時候整個請求仍然回 200，
失敗的那幾個在 `error` 與 `status: "partial"` 裡 —— 一個檔失敗不該讓
另外九個檔的成功消失。

**C 請特別看 `cleanup-plans-apply-partial.json`** —— 搬到一半壞掉是**必做**的容錯
（spec §6），UI 不能只畫成功的樣子。
