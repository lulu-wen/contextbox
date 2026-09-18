# API 範例

這個資料夾的每一個 `.json` 都是**真的 server 回的**，不是手寫的。
C 可以直接拿去當 mock，後端改了什麼，範例跟著改。

## 範例怎麼來、怎麼更新

```bash
node tools/gen-api-examples.mjs       # 重產 docs/api/*.json
```

產生器在暫存資料夾裡起一個真的 server（port 0、假的家目錄，**不碰你的 `~/.contextbox` 與 Downloads**），
放一批垃圾檔，走一輪典型操作（掃描 → 看清單 → 建計畫 → 撞衝突 → 套用 → 搬到一半壞掉 → 復原 →
拒絕與放棄 → 清空隔離區），每一種錯誤也真的觸發一次，把回應原封不動寫下來。
回應裡萬一出現路徑，一律換成 `/home/alice`。

`test/repo.test.mjs` 會再跑一次產生器，比對每一份的**欄位集合**（值不比，id 與時間每次都不同）：

- 後端改了回應的形狀、沒有重產 → 紅
- docs/api 裡多了產生器沒寫的 `.json`（過期的手寫範例）→ 紅

改了回應就重跑上面那一行，把 docs/api 一起 commit。
以前的範例是手寫的，實作改了範例沒跟著改：`/health` 的欄位改了名、文件寫的「重送 apply 回 409」
從來不存在（重送是冪等的，回 200）、兩張錯誤表互相矛盾（稽核 RC20）。

把 docs/api 當靜態檔端出來（網址的 `/` 換成 `-` 就是檔名，例如 `/pet/state` → `pet-state.json`；
計畫的各種動作看下面的「檔案清單」挑檔）：

```bash
node -e "import('node:http').then(h=>h.createServer((q,s)=>{const f='docs/api/'+new URL(q.url,'http://x').pathname.slice(1).replaceAll('/','-')+'.json';import('node:fs').then(fs=>{try{s.setHeader('content-type','application/json');s.end(fs.readFileSync(f))}catch{s.statusCode=404;s.end('{}')}})}).listen(7392,()=>console.log('mock on 7392')))"
```

## 通用規則

**全部走既有本機 server 的防線**，不另外做一套。

| | |
|---|---|
| 位址 | 只綁 `127.0.0.1`。Host 不是 `127.0.0.1:<port>` 或 `localhost:<port>` 一律 403 |
| 認證 | header `x-contextbox-token`。只有 `GET /health` 不用 |
| 頁面 | `GET /` 要帶 `?k=<token>`（`node cli.mjs open` 與 server 印出來的網址都帶好了）；沒帶回 401 純文字，**不含 token** |
| 來源 | Origin 只放行：沒有 Origin、`chrome-extension://…`、server 自己；其他 403 |
| body | 一定是 JSON 物件。空的 body 等於 `{}`；看不懂（壞掉的 JSON、`null`、陣列、字串、form 格式）→ 400 `BAD_BODY`，**不會被當成「什麼都沒帶」**；**帶了這條路徑不認得的欄位**（拼錯的 `candidateID`、`skippedIDs`、snake_case 的 `candidate_ids`）也是 400 `BAD_BODY`，什麼都不做（各路徑收哪些欄位見下面「各路徑收的 body」）；超過 1 MB → 413 `BODY_TOO_LARGE` |
| 方法 | 認得的路徑用錯方法 → 405 `BAD_METHOD`，帶 `Allow` header |
| 重送 | `apply`、`undo`、`dismiss`、`release`、清空確認（同一個 token）重送都拿到同樣的結果，不會做第二次。建計畫靠 `requestId`（見下） |
| 時間 | 一律 ISO 8601，UTC |
| 大小 | 一律 bytes，整數 |

## 錯誤

格式沿用既有 server 的 `{ error: 字串 }`，多一個 `code` 給程式判斷。人看 `error`，程式分支看 `code`。
401 與「來源不對」的 403 沒有 `code`。每一種真的長什麼樣，看 `errors.json`。

```json
{ "error": "另一個清理動作正在進行，請稍後重試。", "code": "BUSY" }
```

**這是唯一一張錯誤表**，跟 `core/cleanup-routes.ts` 的 `HTTP_FOR_CODE`（加上 server 自己送的幾個）一模一樣 ——
`test/repo.test.mjs` 會從原始碼列舉每一個 code 來比，多一個少一個都會紅。

| HTTP | code | 什麼時候 | 呼叫端該做什麼 |
|---|---|---|---|
| 400 | `BAD_BODY` | body 看不懂；帶了這條路徑不認得的欄位（`candidateID`、`skippedIDs`…）；欄位型別不對（`candidateIds: null`、`confirmed: "true"`）；計畫 id 的 `%xx` 壞掉；分頁參數不對；略過清單有不屬於這份計畫的 id | 改請求再送 |
| 401 | （沒有） | token 不對或沒帶 | 重新拿 token |
| 403 | `READ_ONLY` | 唯讀模式：不建計畫、不搬檔 | 告訴使用者，不要重試 |
| 403 | （沒有） | Origin 不在白名單、Host 不對、`GET /` 被 fetch 或 iframe 拿 | 不要重試 |
| 404 | `NOT_FOUND` | 那份計畫不存在 | 重新拿清單 |
| 405 | `BAD_METHOD` | 認得的路徑用錯方法 | 看 `Allow` header |
| 409 | `CONFLICT` | 勾的檔已經在一份**還沒套用**的計畫裡（回應帶 `blockingPlan`；它的 `started` 是 true 時只能繼續或放回，不能放棄）；已經開始的計畫再 dismiss／release；**已經有復原紀錄**（開始放回過任何一個檔，不管放回成功沒有）的計畫再 apply，例如復原停在 `partial` 的。復原時還沒開始放回就出錯的**不算**：例如隔離區的檔被改過、第一個檔就 `CHANGED` 而停在 `error` 的，再 apply 回 200、狀態變成 `applied`，檔還在隔離區、不會再搬。全部放回的 `restored` 再 apply 也回 200、原樣回傳，不會再搬 | 把 `blockingPlan` 給使用者看，讓他選「繼續那份」或「放棄那份」，**不可以自動套用** |
| 409 | `STALE_CANDIDATE` | 送來的 id 不在目前的清單上（清單變了、太大、不在清理範圍） | 一個都不搬；重新載入清單給使用者再看一眼 |
| 409 | `EMPTY_PLAN` | 沒有勾任何東西（`candidateIds: []`），或預設清理沒東西可清 | 不是錯：Downloads 很乾淨 |
| 409 | `TOO_FRESH` | 檔案十分鐘內還在變動（多半只出現在逐項結果的 `why`） | 等一下再試 |
| 409 | `TOO_RECENT` | 隔離還沒滿七天（多半只出現在清空的逐項結果） | 看 `canEmptyAt` |
| 410 | `CONFIRMATION_EXPIRED` | 清空的預覽 token 過期（五分鐘） | 重新預覽 |
| 413 | `BODY_TOO_LARGE` | body 超過 1 MB | 送少一點 |
| 428 | `CONFIRMATION_REQUIRED` | 清空時沒帶 `confirmed`、帶的是 `false`、或 token 不是預覽發的 | 先打一次不帶 token 的預覽 |
| 500 | `BAD_CONFIG` | 清理資料夾或大小上限沒設好 | 顯示「後端出狀況」，不要自動重試 |
| 500 | `UNSAFE_PATH` | 隔離區或檔案的路徑不安全（捷徑、硬鏈結、不是資料夾） | 同上 |
| 500 | `UNSAFE_JOURNAL` | 搬移紀錄對不上 | 同上 |
| 500 | `UNSAFE_FILE` | 清空時檔案太大或認不出身分 | 同上 |
| 500 | `CHANGED` | 檔案在建計畫之後變了（多半只出現在逐項結果） | 重新掃描、建新計畫 |
| 500 | `MISSING` | 隔離區的檔案不見了（多半只出現在逐項結果） | 請使用者看一眼 |
| 500 | `PURGED` | 已經清空，無法復原（多半只出現在逐項結果） | 告訴使用者 |
| 500 | `PROTECTED` | 受保護的檔案（多半只出現在逐項結果） | 請使用者自己處理 |
| 500 | `OUTSIDE_ROOT` | 檔案不在清理範圍裡（多半只出現在逐項結果） | 重新掃描 |
| 500 | `NO_DUPLICATE` | 重複檔找不到會留下的那一份（多半只出現在逐項結果） | 重新掃描 |
| 500 | `VERIFY_FAILED` | 搬移後驗證沒過（多半只出現在逐項結果） | 保留隔離區，重試 |
| 500 | `INTERNAL` | 其他意外。訊息是「後端出錯了，這一步可能沒有完成。請關掉面板，再從寵物或 `node cli.mjs open` 重新打開，看目前的狀態。」 | 請使用者關掉面板，再從寵物或 `node cli.mjs open` 重新打開，看目前的狀態；不要自動重試 |
| 501 | `NOT_IMPLEMENTED` | `/cleanup/…`、`/pet/…` 底下還沒做的路徑（例如 `/cleanup/reveal`） | 不要重試 |
| 503 | `BUSY` | 另一個清理動作正在跑（別的行程拿著鎖） | 照 `Retry-After` header（秒，現在是 2）等一下重試 |

> **404 與 500 不可以把本機路徑放進 `error`。** 那條訊息會出現在 UI 上。

**逐項失敗不是路由錯誤。** 一個檔搬不動的時候整個請求仍然回 200，
失敗的那幾個在 `items[].outcome`／`why` 與 `status: "partial"` 裡 ——
一個檔失敗不該讓另外九個檔的成功消失。上表標「多半只出現在逐項結果」的 code 就是這一類；
萬一穿到路由層，才會變成 500。

5xx 裡只有**真的意外**會記成 `/health` 的 `lastError`：`BUSY` 不算（等一下就好），4xx 也不算。
另外，回 200 但**每一項都失敗**的套用、復原、清空（計畫 `status` 是 `error`、清空一個都沒刪掉）也記成 `lastError`，
不記成功 —— 整份計畫全部 EXDEV 的時候，寵物不可以說沒事。記的時候帶種類（`lastErrorKind`），見 `GET /health`。

## 路徑怎麼給 UI

**不給絕對路徑。** UI 需要的是「使用者認得出這是哪個檔」，不是完整路徑。

```json
{ "name": "發票.zip", "folder": "Downloads", "subdir": "2026/09" }
```

「在檔案總管打開」要走一個獨立的 `POST /cleanup/reveal { itemId }`，由後端自己組路徑 ——
**路徑永遠不離開後端**。這條還沒做（回 501）。

## 各路徑收的 body

**只收下表的欄位**，多帶一個（包括拼錯的）→ 400 `BAD_BODY`，什麼都不做。
以前拼錯的 key 被當成「沒帶」：只勾一個檔、送成 `candidateID`，清掉的是清單上打 ✔ 的全部（稽核第二輪 R2-7）。

| 路徑 | 收的欄位 |
|---|---|
| `POST /cleanup/plans` | `candidateIds`、`requestId` |
| `POST /cleanup/plans/:id/apply` | `skippedIds` |
| `POST /cleanup/plans/:id/undo`、`…/dismiss`、`…/release` | 不收任何欄位（空的 body 或 `{}`） |
| `POST /cleanup/quarantine/empty` | `token`、`confirmed` |

## 檔案清單

| 檔案 | 對應 route |
|---|---|
| `health.json` | `GET /health`　**不帶 token** |
| `health-with-token.json` | `GET /health`　帶 token |
| `pet-state.json` | `GET /pet/state` |
| `cleanup-scan.json` | `POST /cleanup/scan` |
| `cleanup-candidates.json` | `GET /cleanup/candidates` |
| `cleanup-plans-create.json` | `POST /cleanup/plans` |
| `cleanup-plans-get.json` | `GET /cleanup/plans/:id` |
| `cleanup-plans-apply.json` | `POST /cleanup/plans/:id/apply` |
| `cleanup-plans-apply-partial.json` | 同上，**搬到一半壞掉**（一個搬走、一個太新、一個不見了） |
| `cleanup-plans-undo.json` | `POST /cleanup/plans/:id/undo`（其中一個原位置被佔，改名 `.restored`） |
| `cleanup-plans-dismiss.json` | `POST /cleanup/plans/:id/dismiss`　使用者拒絕這些檔 |
| `cleanup-plans-release.json` | `POST /cleanup/plans/:id/release`　放棄一份還沒開始的計畫 |
| `cleanup-plans-list.json` | `GET /cleanup/plans`　**不帶篩選** |
| `cleanup-plans-list-undoable.json` | `GET /cleanup/plans?undoable=1`　歷史面板用 |
| `cleanup-plans-list-pending.json` | `GET /cleanup/plans?pending=1` |
| `cleanup-quarantine.json` | `GET /cleanup/quarantine` |
| `cleanup-quarantine-empty-preview.json` | `POST /cleanup/quarantine/empty`　**第一次（預覽）** |
| `cleanup-quarantine-empty-done.json` | 同上，**第二次（確認）** |
| `errors.json` | 每一種錯誤長什麼樣（`request`、`status`、需要看的 header、`body`） |

## `GET /health`

**不帶 token 也回**（擴充套件與寵物用它判斷後端活著沒），所以不帶 token 的那一份**不給任何名字、路徑或時間**：
`watcher.watching` 是空陣列、`watcher.lastHeartbeatAt` 與 `watcher.pid` 是 `null`、`lastError` 只說
「有，帶 token 才看得到」、`lastErrorAt` 與 `lastOkAt` 是 `null`（同機任何行程都讀得到，時間會洩漏
「使用者什麼時候清理過」）、`lastErrorKind` 是 `null`、`lastOkByKind` 底下四個時間（`lastOkByKind.scan`、
`lastOkByKind.apply`、`lastOkByKind.undo`、`lastOkByKind.empty`）都是 `null`、`scanProblems` 是空陣列、
`quarantine.canEmptyAt` 與 `quarantine.oldestMtimeAt` 也是 `null`（同一個理由：
`canEmptyAt` 減七天就是清理的時間）。`quarantine.canEmptyNow` 是布林、不帶時間，兩份都照給。
兩份的**欄位一模一樣**，只有值被遮住 —— UI 用哪一份都不會拿到 `undefined`。
**後端壞掉時也一樣**：資料庫或事實庫讀不到，照樣回完整的欄位，`ok` 與 `db.ok` 是 false、數字退回 0。
寵物要比那些時間，走要 token 的 `GET /pet/state`。

**`?nonce=<32 個 hex>`**：帶了就多回一個 `proof` ＝ HMAC-SHA256（key 是 token、訊息是 nonce）的 hex，
免 token 也回（proof 反推不出 token）。`open` 與第二個 `pet` 用它確認那個埠上的是真的 pet，才把帶鑰匙的網址交出去：
自己產生 nonce、自己算一次來比。算法是 `core/server.ts` 的 `healthProof(token, nonce)`。
nonce 格式不對（不是剛好 32 個 hex）就**沒有** `proof` 欄位，不報錯；沒帶 nonce 也沒有這個欄位。

| 欄位 | 意思 |
|---|---|
| `ok`、`db.ok` | 後端能不能用（資料庫問得到、事實庫讀得到）。跟 watcher 有沒有在跑無關 |
| `version` | 後端版本 |
| `watcher.ok` | pet 或 watch 正在跑、心跳五分鐘內、清理資料夾都在 |
| `watcher.lastHeartbeatAt`、`watcher.pid` | 最後一次心跳、那個行程（帶 token 才有） |
| `watcher.rootsMissing`、`watcher.watchingCount` | 清理資料夾有幾個不見了、總共幾個 |
| `watcher.watching` | 清理資料夾的顯示名（帶 token 才有） |
| `watcher.why` | `watcher.ok` 為什麼是 false，是 true 時為 `null` |
| `quarantine.items`、`quarantine.bytes` | 隔離區裡還能復原的檔 |
| `quarantine.oldestMtimeAt` | 那些檔**自己的** mtime，只拿來顯示，不要拿來算七天（帶 token 才有） |
| `quarantine.canEmptyAt` | **最早**一筆滿七天的時間（帶 token 才有） |
| `quarantine.canEmptyNow` | 現在按清空會不會真的刪到東西。帶 token 那份跟 `canEmptyAt` 互推；不帶 token 也照給 |
| `quarantine.orphans` | 隔離區裡有、搬移紀錄沒有的檔。清空**不會**動它們 |
| `quarantine.truncated` | 隔離區沒看完（讀不到、太深）。這時 `canEmptyNow` 一律 false |
| `pendingCandidates` | 清單上有幾個檔（跟 `GET /cleanup/candidates` 同一套篩選） |
| `needsHumanCount` | 「需要你查看」有幾個 |
| `lastError` | 最近一次**真的意外**，或一次**每一項都失敗**的套用／復原／清空：帶 token 是「ISO 時間 空白 人話」，不帶原文、不帶路徑 |
| `lastErrorAt`、`lastOkAt` | 最近一次錯、最近一次成功（任何一種）的時間（帶 token 才有） |
| `lastErrorKind` | 那次錯是哪一種動作：`scan`／`apply`／`undo`／`empty`，說不出來（舊資料、查詢的意外）是 `null`（帶 token 才有） |
| `lastOkByKind` | 底下的 `scan`、`apply`、`undo`、`empty` 各是那一種動作最近一次成功的時間，沒成功過是 `null`（帶 token 才有）。**寵物只在「錯之後，同一種動作還沒成功過」時擔心**：套用壞了，背景重掃成功不算數；`lastErrorKind` 是 `null` 的錯，任何一次成功（`lastOkAt`）都算 |
| `scanProblems` | 最近一次完整掃描回報的問題（保險絲、打不開的資料夾、讀不到的檔），人話、不帶路徑、控制字元換成「·」，最多 50 條；沒問題是空陣列（帶 token 才有內容） |
| `proof` | 只有帶了 `?nonce=<32 個 hex>` 才有，見上 |
| `facts` | 已確認的事實筆數（擴充套件不帶 token 讀它） |

> **欄位改過名。** 舊文件的 `quarantine.lastQuarantinedAt`（最新一筆的隔離時間）拿掉了 —— 七天要從**最早**
> 那筆算，改看 `quarantine.canEmptyAt`。新增了 `quarantine.orphans`、`lastErrorAt`、`lastOkAt`、`facts`。
> 目前沒有任何使用端讀舊欄位；照 `health.json` 寫就對了。

## `GET /cleanup/candidates` —— 清單

一個**檔案**一列（一個檔有兩條理由就是一列、兩個 `candidateIds`）。

- `total`／`totalAvailable`／`truncated`：這次回了幾列、全部有幾列、有沒有被 `limit`（1～1000）砍掉
- `defaultCheckedCount`／`defaultCheckedBytes`：**全部**預設打勾的有幾個檔、多大，不受 `limit` 影響。
  「清掉打勾的 N 個」用這兩個，不要自己數 `candidates`
- 每一列：`itemId`、`name`、`folder`、`subdir`、`bytes`、`mtime`、`kind`（信心最高的那條）、`confidence`、
  `defaultChecked`、`vetoed`（目前永遠是 `null`）、`candidateIds`、`reasons[]`（`kind`、`confidence`、`reason`、`evidence`）
- `needsHuman[]`：跟清理有關、但這個工具不處理的檔（太大算不出指紋、讀的時候出錯），`why` 是人話。
  沒有命中任何規則的大檔**不列**。`needsHumanTotal`／`needsHumanTruncated` 同上

受保護的檔（`.ini`、`.lnk`、`.pem`、隱藏檔…）與清理範圍外的檔**不會**出現在清單上 ——
列出來的就要搬得動。

**截圖資料夾只清截圖。** 設定開了 `cleanup.screenshots`，截圖資料夾會加進清理範圍，但那底下**只列截圖類**
（`kind` 是 `screenshot-noise`，之後的連拍也算），壓縮檔、安裝檔、很久沒動的檔都不列，它們的 id 送來建計畫是
409 `STALE_CANDIDATE`。**macOS 的截圖資料夾就是桌面** —— 開這個開關不會把整個桌面交給清理。
比截圖資料夾更深、自己寫在 `cleanup.roots` 裡的資料夾（例如 `桌面/清理區`）照一般規則。
徽章（`pendingCandidates`）、預設清理、建計畫都是同一套篩選。

## `POST /cleanup/plans` —— 建計畫要帶**勾了的 id**

`POST /cleanup/plans { candidateIds, requestId }`：

- `candidateIds` 送**勾了的那些檔的全部 id**（一個檔有兩條理由就送兩個）。
  - **完全不帶** ＝「清單上打 ✔ 的」，一次最多 1000 個檔；回應的 `remaining` 是這次沒收進去、下次再清的檔數
  - `null`、不是陣列 → 400 `BAD_BODY`（**不會**被當成「不帶」）
  - `[]` → 409 `EMPTY_PLAN`
  - 有任何一個 id 不在目前的清單上 → 409 `STALE_CANDIDATE`，一個都不收
  - 使用者主動勾起來的低信心檔不在預設裡 —— 所以 UI 一定要帶
- `requestId`：**同一份勾選重送時沿用同一個**。回應在網路上丟了再按一次，拿到同一份計畫，
  不會多建、也不會多搬。勾選改了才換新的；同一個 `requestId` 配不同的勾選 → 409 `CONFLICT`
- 唯讀模式 → 403 `READ_ONLY`，**一份計畫都不建**
- 撞到 409 `CONFLICT`：回應多一個 `blockingPlan: { id, status, createdAt, started, items: [{ itemId, name, bytes }] }`，
  是**擋住這次勾選的那一份**（它的檔跟這次勾的有交集）。UI 用它，不要自己去猜是哪一份。
  - `started` 是 **false**（還沒搬過任何一個）：給使用者兩個選擇，「繼續那份」（`POST …/apply`）或「放棄那份」（`POST …/release`）
  - `started` 是 **true**（套用到一半中斷：被砍、斷電、鎖被接走，計畫還是 `proposed`，但已經有檔搬進隔離區）：
    **只能「繼續那份」（`POST …/apply`）或「放回」（`POST …/undo`），不能放棄** —— `release` 會回 409 `CONFLICT`。
    不要跟使用者說「放棄：不動任何檔案」，那時已經有檔搬走了
- **只有還沒套用（`proposed`）的計畫會佔住檔案。** 套用過的計畫（applied／partial／error）不再擋新計畫：
  失敗的那幾個可以直接收進下一份。重試 ＝ 新計畫

## `dismiss` 與 `release` 的差別

兩個都只收**還沒開始**的計畫（沒有任何搬移紀錄），計畫都變成 `dismissed`、逐項 `outcome` 都是 `cancelled`：

- `POST /cleanup/plans/:id/dismiss`：使用者**拒絕這些檔**。候選一起作廢，之後不再提議
- `POST /cleanup/plans/:id/release`：**放棄這份計畫，檔不動**。候選還在，下一份計畫收得進去 ——
  面板撞到卡住的計畫時的「放棄上次那份」就是這一條

已經開始的計畫兩個都回 409 `CONFLICT`（要還原請用 `undo`）。已經是 `dismissed` 的再送一次回 200（冪等）。

## 每個計畫回應都帶**逐項結果**

`POST /cleanup/plans`、`GET /cleanup/plans/:id`、`…/apply`、`…/undo`、`…/dismiss`、`…/release`
的 `items[]` 每一項都多兩個欄位：

| 欄位 | 值 |
|---|---|
| `outcome` | `pending`（還沒做）／`moved`（在隔離區）／`skipped`（你略過的）／`failed`（沒搬成）／`restored`（已放回）／`purged`（滿七天已刪除）／`unknown`（搬到一半中斷，檔案可能已經在隔離區）／`cancelled`（沒動過：計畫被放棄了；或計畫跑過，但這一項從來沒處理到 —— 例如套用中斷在前幾項、之後按了復原，後面那些就是 `cancelled`，不是「原因不明」的 `failed`） |
| `why` | `failed` 與 `unknown` 一定有；`moved` 在**復原失敗過**時是沒放回來的原因；其他是 `null`。人話、**不帶路徑** |
| `restoredAs` | 只有 `restored` 而且**被改名**的才有：放回來時原位置已被佔，實際的檔名（例如 `素材包.zip.restored`） |

`failed` 的原因在套用當下就存起來了，之後重新掃描也不會變成「原因不明」。

**復原（`POST …/undo`）放回的範圍比清理寬**：清理範圍 ∪ 截圖的監看資料夾（`watch`）。RC15 之前的舊版用 `watch`
清過（macOS 含桌面），那些檔要放得回原位；放回原位不會擴大清理範圍。套用與清空只用清理範圍。
不存在、路徑含捷徑的資料夾略過（跟 CLI 的 `cleanup undo` 同一個規則）。

**UI 不可以用「勾了幾個」去推算搬了幾個。** 要看 `quarantinedCount` 與每一項的 `outcome`。
CLI 那邊踩過一次：一律印 ✔，全失敗時畫面上是一排 ✔ 後面接「搬進隔離區 0 個」。

**C 請特別看 `cleanup-plans-apply-partial.json`** —— 搬到一半壞掉是**必做**的容錯（spec §6），
UI 不能只畫成功的樣子。

### `GET /cleanup/plans` —— 計畫列表

形狀刻意跟 demo 的 `/demo/cleanup/history` 一樣（`{ total, offset, limit, operations }`），
歷史面板兩個模式共用同一段渲染。`operations[]` 每一份：
`id`、`status`、`createdAt`、`appliedAt`、`restoredAt`、`canUndo`、`itemCount`、`bytes`、`items`
（`items[]` 只有 `itemId`、`name`、`bytes`，**沒有** `outcome` —— 要逐項結果請打 `GET /cleanup/plans/:id`）。
由新到舊排。

| 參數 | 列哪些計畫 | `items`／`itemCount`／`bytes` 算哪些檔 |
|---|---|---|
| **不帶篩選** | **全部**：proposed、applied、partial、error、restored、dismissed 都列 | 計畫裡的**每一個**檔（含已放回、已放棄的） |
| `undoable=1` | **現在還有檔可以放回去**的：包含復原失敗過的（`partial`／`error`，沒放回的那幾個還在隔離區），與復原到一半中斷的（再按一次復原會接完）。已復原、已被清空的不算 | 只算還能放回去的（`outcome` 是 `moved`，或復原中斷的 `unknown`） |
| `pending=1` | **還沒套用（`proposed`）**、而且還有沒做完項目的計畫。給「接續上次那份」用。套用過的 partial／error 不列：計畫是一次性的，失敗的檔要重試就建新計畫 | 只算沒做完的（`pending`、`failed`、`unknown`） |
| `offset`、`limit` | `limit` 1～100（預設 20），`offset` 不可以是負的，錯了回 400。超過最後一頁會夾回最後一頁 | |

`undoable=1` 與 `pending=1` 同時帶的話，以 `undoable` 為準。
`canUndo` 在三種篩法裡的意思都一樣：這份計畫現在還有沒有檔可以放回去（在隔離區，或復原到一半中斷）。

### 復原的檔不會回到**這次的**清理清單

復原過的檔，**同樣的理由**不會再被提議（你復原過就代表想留著）。
UI 不要自己把檔加回清單 —— 從後端重新載入。

但**不要**跟使用者說「之後不會再被提議」，那不一定是真的：

- 之後符合**新的**理由（例如又放了 60 天，變成 old-download）會再出現
- **原位置被佔時**（清掉之後又下載了同名的檔），放回來的那份會改名成 `原檔名.restored`。
  副檔名變成 `.restored`，看副檔名的規則（archive、installer…）不會再命中。重掃之後：
  - 後來那個檔跟放回來的**內容一模一樣** → `.restored` 是它的重複檔，會以 duplicate 98 分、**預設勾**的身分再出現
  - **內容不同** → 不會以 duplicate 出現。它自己符合別的規則才會列（例如 90 天沒動過 → old-download 35 分，
    預設不勾），不然根本不列

改名的那幾個，`items[]` 裡會有 `restoredAs`（只有檔名，不帶路徑）。UI 要講出來，
不然使用者以為「放回原位」—— 其實原位是後來那個檔。

### 清空隔離區是**一個 route、兩個階段**

`POST /cleanup/quarantine/empty` 不帶 `token` 是預覽，回 `phase: "preview"` 加一個
五分鐘內有效的 `token`，**不刪任何東西**；帶 `{ token, confirmed: true }` 才真的刪，回 `phase: "done"`。

`confirmed` 必須是**布林 `true`**：

- 沒帶、或 `false` → 428 `CONFIRMATION_REQUIRED`（還沒確認）
- 帶了但不是布林（字串 `"true"`／`"false"`、數字、`null`）→ 400 `BAD_BODY`（送錯了）——
  字串在 JS 是 truthy，而這是整個專案唯一會真的刪檔的路徑
- token 過期 → 410 `CONFIRMATION_EXPIRED`；同一個 token 重送回原本的結果，不會刪第二次

## `GET /pet/state`

`state` 是 `worried`／`waiting`／`found`／`watching`／`idle` 其中一個（第一個成立的贏），
`message` 是一句人話，`pendingCount`、`quarantinedCount`、`undoable` 是數字與旗標。
`undoable` 是旗標不是 state —— 當 state 會卡住七天。`thinking`／`cleaning`／`happy` 是前端在等回應時
自己播的動畫，後端不回。
