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
| 重送 | 重送拿到同樣的結果，不會做第二次。`apply` 跑完一次之後（`applied`／`partial`／`error`）重送原樣回傳，不重試任何一項、不會再搬（第二輪 R2-3；以前 `partial`／`error` 會重試失敗的那幾個），那一次的回應帶 `noop: true`，UI 不可以顯示成剛清完；還沒跑完的 `proposed`（包括做到一半中斷的）重送是接著做完，做過的不會再做一次。`undo` 重送不會把放回的再搬一次，沒放回的會再試。`dismiss`、`release`、清空確認（同一個 token）重送拿到同樣的結果。建計畫靠 `requestId`（見下） |
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
| 409 | `CONFLICT` | 勾的檔已經在一份**還沒套用**的計畫裡（回應帶 `blockingPlan`；它的 `started` 是 true 時只能繼續或放回，不能放棄）；已經開始的計畫再 dismiss／release；**已經有復原紀錄**（開始放回過任何一個檔，不管放回成功沒有）的 `proposed`／`partial`／`error` 計畫再 apply，例如復原停在 `partial` 的。沒有復原紀錄的**不算**：跑完過的 `partial`／`error` 再 apply 回 200、原樣回傳（`status` 不變、不重試任何一項、不會再搬），包括復原時還沒開始放回就出錯的 `error`（例如隔離區的檔被改過、第一個檔就 `CHANGED`），檔還在隔離區。`applied`（包括復原到一半中斷、還沒寫下結果的）與全部放回的 `restored` 再 apply 也回 200、原樣回傳，不會再搬 | 把 `blockingPlan` 給使用者看：`started` 是 false，讓他選「繼續那份」或「放棄那份」；`started` 是 true，讓他選「繼續那份」或「放回已經搬走的」（`undo`）。**不可以自動套用** |
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
| 500 | `CROSS_DEVICE` | 歸檔時「整理好的」資料夾在另一顆碟（`EXDEV`）。**不會**用複製＋刪除頂替，那等於刪檔；只出現在逐項結果的 `why` | 告訴使用者把 `filed` 設在同一顆碟 |
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
| `POST /rename/apply` | `items`（`[{ itemId, to }]`） |
| `POST /rename/undo` | `ids`、`last` |
| `POST /file/apply` | `items`（`[{ itemId, course, kind }]`） |
| `POST /file/undo` | `ids`、`last` |
| `DELETE /learned` | `ids`、`all` |

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
「使用者什麼時候清理過」）、`lastErrorKind` 是 `null`、`lastOkByKind` 底下五個時間（`lastOkByKind.scan`、
`lastOkByKind.apply`、`lastOkByKind.undo`、`lastOkByKind.empty`、`lastOkByKind.model`）都是 `null`、`scanProblems` 是空陣列、
`quarantine.canEmptyAt` 與 `quarantine.oldestMtimeAt` 也是 `null`（同一個理由：
`canEmptyAt` 減七天就是清理的時間）。`quarantine.canEmptyNow` 是布林、不帶時間，兩份都照給。
兩份的**欄位一模一樣**，只有值被遮住 —— UI 用哪一份都不會拿到 `undefined`。
**後端壞掉時也一樣**：資料庫或事實庫讀不到，照樣回完整的欄位，`ok` 與 `db.ok` 是 false、數字退回 0。
寵物要比那些時間，走要 token 的 `GET /pet/state`。

**`?nonce=<32 個 hex>`**：帶了就多回一個 `proof` ＝ HMAC-SHA256 的 hex，key 是 token、訊息是 `<埠號>:<nonce>`，
免 token 也回（proof 反推不出 token）。埠號是 server **實際監聽**的那一個（`CONTEXTBOX_PORT=0` 的話是系統挑的那個，不是 0）。
`open` 與第二個 `pet` 用它確認那個埠上的是真的 pet，才把帶鑰匙的網址交出去：自己產生 nonce，拿**自己要連的那個埠**
用同一支函式算一次來比。**埠號綁在訊息裡**是為了擋轉送：佔住 A 埠的冒牌把 nonce 轉給 B 埠上的真 pet、
再把 proof 原封不動交回來，真 pet 算的是 B，對不上（第二輪 R2-9，CLI 那一組改的）。
**算法以 `core/server.ts` 的 `healthProof(token, port, nonce)` 為準**，不要自己重寫。
nonce 格式不對（不是剛好 32 個 hex，大小寫都收）就**沒有** `proof` 欄位，不報錯；沒帶 nonce 也沒有這個欄位。

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
| `lastErrorKind` | 那次錯是哪一種動作：`scan`／`apply`／`undo`／`empty`／`model`（P2 的背景佇列：模型連續三次叫不動），說不出來（舊資料、查詢的意外）是 `null`（帶 token 才有） |
| `lastOkByKind` | 底下的 `scan`、`apply`、`undo`、`empty`、`model` 各是那一種動作最近一次成功的時間，沒成功過是 `null`（帶 token 才有）。**寵物只在「錯之後，同一種動作還沒成功過」時擔心**：套用壞了，背景重掃成功不算數；`lastErrorKind` 是 `null` 的錯，任何一次成功（`lastOkAt`）都算 |
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
  `defaultChecked`、`vetoed`（目前永遠是 `null`）、`candidateIds`、`reasons[]`（`kind`、`confidence`、`reason`、`evidence`）、
  `model`（P2 模型對這個檔的看法：`course`、`topic`、`kind`、`suggestedName`、`evidence`、`confidence`（高／中／低）、
  `model`、`at`、`seeded`；沒接模型或還沒問到是 `null`）。**那是意見不是事實**：面板要寫「模型認為⋯⋯」，
  **不可以**因為它說了就自動打勾或改名；`seeded` 是 demo 預先塞的示範答案，畫面要標示
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
  - `started` 是 **true**（套用到一半中斷：被砍、斷電、鎖被接走，計畫還是 `proposed`，但已經有搬移紀錄 —— 多半已經有檔搬進隔離區）：
    **只能「繼續那份」（`POST …/apply`）或「放回」（`POST …/undo`），不能放棄** —— `release` 會回 409 `CONFLICT`。
    不要跟使用者說「放棄：不動任何檔案」，那時已經有檔搬走了。幾個已經在隔離區，打 `GET /cleanup/plans/:id`
    數 `outcome` 是 `moved` 的（`unknown` 的說不準在哪，分開講）。`undo` 只放回在隔離區的，還沒搬的那幾個
    不會動（之後的逐項結果是 `cancelled`）
  - 面板不只靠這個 409：**一打開就查 `GET /cleanup/plans?pending=1`**，有待處理的計畫就先提示最新的那一份，
    同樣分成沒開始（繼續／放棄）與開始過（繼續／放回）。計畫裡的檔不在清單上（被使用者刪了）時永遠撞不到
    409，只有這條找得到它
- **只有還沒套用（`proposed`）的計畫會佔住檔案。** 套用過的計畫（applied／partial／error）不再擋新計畫：
  失敗的那幾個可以直接收進下一份。重試 ＝ 新計畫

## `dismiss` 與 `release` 的差別

兩個都只收**還沒開始**的計畫（沒有任何搬移紀錄），計畫都變成 `dismissed`、逐項 `outcome` 都是 `cancelled`：

- `POST /cleanup/plans/:id/dismiss`：使用者**拒絕這些檔**。候選一起作廢，之後不再提議
- `POST /cleanup/plans/:id/release`：**放棄這份計畫，檔不動**。候選還在，下一份計畫收得進去 ——
  面板撞到卡住的計畫時的「放棄上次那份」就是這一條（**還沒開始的那種**；開始過的那份面板給的是
  「放回已經搬走的」＝ `undo`）

已經開始的計畫兩個都回 409 `CONFLICT`（要還原請用 `undo`）。已經是 `dismissed` 的再送一次回 200（冪等）。

## 每個計畫回應都帶**逐項結果**

`POST /cleanup/plans`、`GET /cleanup/plans/:id`、`…/apply`、`…/undo`、`…/dismiss`、`…/release`
的 `items[]` 每一項都多兩個欄位：

| 欄位 | 值 |
|---|---|
| `outcome` | `pending`（還沒做）／`moved`（在隔離區）／`skipped`（你略過的）／`failed`（沒搬成）／`restored`（已放回）／`purged`（滿七天已刪除）／`unknown`（搬到一半或復原到一半中斷，說不準檔案在原位還是在隔離區；`undo` 會把在隔離區的放回原位。**不要**叫使用者再 apply 一次來接完：跑完過的計畫再 apply 原樣回傳）／`cancelled`（沒動過：計畫被放棄了；或計畫跑過，但這一項從來沒處理到 —— 例如套用中斷在前幾項、之後按了復原，後面那些就是 `cancelled`，不是「原因不明」的 `failed`） |
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

### `apply` 另外帶兩個頂層旗標（第三輪 R3-17）

`POST …/apply` 的回應除了逐項結果，還有兩個**頂層**布林。兩個講的都是「**這一次**做了什麼」，
`status` 與 `quarantinedCount` 看不出來 —— 它們講的是計畫累積到現在的樣子。

| 欄位 | 值 |
|---|---|
| `noop` | 布林。`true` ＝ **這一次一個檔都沒有動**：這份計畫先前就跑完了（`applied`／`restored`／`dismissed`，或沒有復原紀錄的 `partial`／`error`），這一次的 `apply` 只是原樣回傳。**UI 不可以把它顯示成剛清完** —— 照 `quarantinedCount` 印的話，使用者按「繼續上次那份」會看到「搬進隔離區 0 個檔案…七天內可以復原」，跟剛清完只差一個數字。其他時候是 `false` |
| `stoppedEarly` | 布林。`true` ＝ **還沒做完就停在中途**：例如清理鎖被另一個清理動作接走（`BUSY`）。已經搬好的在逐項結果裡，還沒碰到的一個都沒動。這不是「失敗」：之後再 `apply` 同一份會從停下來的地方接著做。UI 要講「停在中途、還沒做完」，不可以說成做完了。其他時候是 `false` |

`noop` 是 `true` 的時候 `quarantinedCount` 一定是 0，**反過來不成立**：每一項都真的搬失敗時
`quarantinedCount` 也是 0，但 `noop` 是 `false`（那時候要講失敗的原因）。
所以 UI 不可以自己拿 `quarantinedCount === 0` 去猜 `noop`，要看這個欄位。

### `GET /cleanup/plans` —— 計畫列表

形狀刻意跟 demo 的 `/demo/cleanup/history` 一樣（`{ total, offset, limit, operations }`），
歷史面板兩個模式共用同一段渲染。`operations[]` 每一份：
`id`、`status`、`createdAt`、`appliedAt`、`restoredAt`、`canUndo`、`restoring`、`itemCount`、`bytes`、`items`
（`items[]` 只有 `itemId`、`name`、`bytes`，**沒有** `outcome` —— 要逐項結果請打 `GET /cleanup/plans/:id`）。
由新到舊排。

| 參數 | 列哪些計畫 | `items`／`itemCount`／`bytes` 算哪些檔 |
|---|---|---|
| **不帶篩選** | **全部**：proposed、applied、partial、error、restored、dismissed 都列 | 計畫裡的**每一個**檔（含已放回、已放棄的） |
| `undoable=1` | **現在還有檔可以放回去**的：包含復原失敗過的（`partial`／`error`，沒放回的那幾個還在隔離區），與復原到一半中斷的（再按一次復原會接著放回）。已復原、已被清空的不算 | 只算還能放回去的（`outcome` 是 `moved`，或復原中斷的 `unknown`） |
| `pending=1` | **還沒套用（`proposed`）**、而且還有沒做完項目的計畫，包括做到一半中斷的。給「接續上次那份」用，面板一打開就查它。套用過的 partial／error 不列：計畫是一次性的，失敗的檔要重試就建新計畫 | 只算沒做完的（`pending`、`failed`、`unknown`）—— 已經搬進隔離區的**不在** `items` 裡。開始過沒有、幾個在隔離區，要打 `GET /cleanup/plans/:id` 看逐項結果：還沒套用的計畫裡有任何一項不是 `pending`，就當成套用開始過（面板就是這樣判斷的）。這個判斷偏保守：帶 `skippedIds` 套用、還沒碰到任何一個檔就中斷的，`skipped` 已經寫下了，後端的 `started` 卻還是 false —— 當成開始過頂多少給一個「放棄」，反過來會給出一定 409 的「放棄」 |
| `offset`、`limit` | `limit` 1～100（預設 20），`offset` 不可以是負的，錯了回 400。超過最後一頁會夾回最後一頁 | |

`undoable=1` 與 `pending=1` 同時帶的話，以 `undoable` 為準。
`canUndo` 在三種篩法裡的意思都一樣：這份計畫現在還有沒有檔可以放回去（在隔離區，或復原到一半中斷）。

`restoring` 是「這份**有任何復原紀錄**」（開始放回過任何一個檔，不管那一個放回成功沒有）—— 它不是「復原做到一半」的意思，**全部放回完的（`status` 是 `restored`）也是 true**。它一個人決定不了 `apply` 會不會被擋，要跟 `status` 一起看：還沒收尾的 `proposed`／`partial`／`error` 而且 `restoring` 是 true → `apply` 回 409 `CONFLICT`（出口是繼續 `undo`）；`applied`／`restored`／`dismissed` → 不管 `restoring` 是什麼，`apply` 都回 200、原樣回傳、一個檔都不動。**「接著放回」那顆按鈕要看 `canUndo`，不是看 `restoring`**：全部放回完的那一筆 `restoring` 是 true 而 `canUndo` 是 false，按下去什麼都不會發生（`docs/api/cleanup-plans-list.json` 裡就有這一筆）。第一方面板只在 `proposed` 的計畫上讀 `restoring`，所以剛好沒踩到。`GET /cleanup/plans/:id` 與 409 的 `blockingPlan` 也帶同一個欄位。

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

`reading` 是「它現在在讀檔案嗎、還剩幾個」（P2 的背景佇列）：

```json
"reading": { "running": true, "pending": 128 }
```

- `running`：現在有一輪正在跑。看的是 pet 寫的那一列，**而且要夠新**（15 分鐘）——
  pet 被砍掉會留下一列假的。
- `pending`：還沒被讀過的檔數，上限 500（畫面寫「500+」）。
- 面板拿它畫「Reading your files… N still to go」，寵物也靠它進 `thinking`。
  舊版後端沒有這一段，面板當成「沒在讀、沒有待讀」，那一行就不顯示。

### `burst` —— 連拍截圖要不要**主動**問（P0）

多一段 `burst: { groups, newGroups }`：`groups` 是現在一共幾組連拍，
`newGroups` 是其中**還沒主動問過**的有幾組（後端把問過的組 id 記在 `meta` 的 `burst_asked`）。

- **`newGroups > 0` 才主動彈。** 舊的組還列在連拍區裡，只是寵物不再跳出來問（Step 1 表「主動詢問的時機」）
- 組 id ＝ 留下那張的 item id ＋ 成員 id 排序後的雜湊：**成員變了就是新的一組**，會再問一次
- 第一方頁面另外自己守一層：`newGroups` **沒有比上一次大就不彈**。後端萬一沒把問過的記下來
  （一直回同一個數字），不守的話寵物會每五秒問一次同一批
- 舊版後端沒有這一段（`burst` 是 `undefined`）：頁面當成沒有新的組，不彈也不報錯

## `GET /cleanup/bursts` —— 連拍組（要 token）

```json
{ "groups": [ { "id": "…", "level": "similar",
  "keep":    { "itemId": "…", "name": "螢幕擷取 3.png", "bytes": 512000, "thumb": "/cleanup/thumb/…" },
  "members": [ { "itemId": "…", "name": "螢幕擷取 1.png", "bytes": 511000, "level": "similar",
                 "thumb": "/cleanup/thumb/…", "boxes": [ { "x": 0.25, "y": 0.5, "w": 0.1, "h": 0.2 } ] } ] } ] }
```

| 欄位 | 意思 |
|---|---|
| `id` | 這一組的 id（留下那張的 item id ＋ 成員 id 排序後的雜湊）。成員變了就是另一組 |
| `level` | 整組的等級：`same`（逐位元組看不出差別）或 `similar`（有看得見的變化）。`different` 不成組 |
| `keep` | **留下的那張**（mtime 最大；平手取 id 較大的）。它**永遠不會**是候選，也不會出現在 `members` 裡 |
| `members[]` | 被提議清掉的那幾張。每一張有自己的 `level`：同一組裡可能有 `same` 也有 `similar` |
| `members[].boxes` | 差異處的外框，**0–1 的相對座標**（`x`／`y` 是左上角，`w`／`h` 是寬高）。模組算出來的是原圖座標，接線層換算過。`same` 的是空陣列 |
| `thumb` | 縮圖的相對路徑，一定是 `/cleanup/thumb/<itemId>`（不帶查詢字串）。頁面只認這個樣子，別的一律改回來 |

- **沒有路徑、沒有原圖**：回給畫面的只有檔名、大小、縮圖與外框
- 成員本身就是 `GET /cleanup/candidates` 上的檔（`kind` 是 `screenshot-noise`、`rule_version` 是 `burst-1`），
  所以**清理走既有那條路**：勾好 → `POST /cleanup/plans` → `…/apply` → 可復原。
  連拍區不是第二條清理路徑，只是換一種看法
- 信心照等級：`same` 70（過門檻 50，**預設勾**）、`similar` 40（**預設不勾**）。
  面板拿到 `similar` 的成員會**再取消勾一次**，就算後端的 `defaultChecked` 給成 `true` 也不勾 ——
  這一區是寵物主動問的，寧可少勾一格
- 組散掉（使用者把其中一張改掉，剩一張）→ 那一組不再出現，候選跟著作廢（`skipped`）
- 舊版後端沒有這條（回 501 `NOT_IMPLEMENTED`）：面板當成沒有連拍組，候選清單照常列

## `GET /cleanup/thumb/:itemId` —— 縮圖（要 token）

灰階 PNG，長邊 ≤ 480。原圖不回（省記憶體，也不讓原圖外流）。

- **只給面板看得到的那些 item**，不是任意檔案的讀取端點。面板看不到 → 404 `NOT_FOUND`。
  可見範圍跟 `GET /cleanup/preview/:itemId` **是同一支判斷**（`panelReason`）：清理候選、需要你查看、
  連拍組、隔離區裡的、改名與歸檔建議。以前這裡只認「還在某一組連拍裡」，比面板窄 ——
  面板上一個普通的候選截圖點「看內容」拿不到圖
- 不帶 token → 401
- **token 只能走 header。** `<img src="/cleanup/thumb/…">` 不會帶 header，
  而把 token 放進網址等於把它寫進 DOM、歷史紀錄與使用者的截圖裡。
  頁面的做法：用帶 token 的 `api(path, { blob: true })` 取回 Blob，
  再 `URL.createObjectURL` 換成 `blob:` 網址給 `<img>`，換一批時 `revokeObjectURL` 還回去。
  頁面的 CSP 也只放行 `img-src data: blob:`，直接指過去本來就會被擋

## `GET /cleanup/preview/:itemId` —— 看內容（要 token）

面板每一列的「看內容」。**這是唯一一條會把檔案內容送到瀏覽器的路。**

```json
{ "name": "作業系統_第5章_行程排程.txt", "ext": ".txt", "bytes": 1234,
  "mtime": "2026-09-11T02:03:04.000Z", "kind": "text",
  "text": "一、排班準則……", "truncated": false,
  "image": null,
  "why": "90 天沒有打開過" }
```

| 欄位 | 意思 |
|---|---|
| `name`／`ext`／`bytes`／`mtime` | 後設資料。**沒有路徑**（沒有 `folder`、`subdir`，更沒有絕對路徑） |
| `kind` | `text`（抽到文字）／`image`（有縮圖）／`none`（兩者都沒有，只給後設資料） |
| `text` | 洗過的內容，**最多 2000 個字**；沒有就是 `null` |
| `truncated` | 還有更多沒顯示。這一次截到 2000 個字，或當初存進 `file_texts` 時（上限 4000 字）就截斷過 |
| `image` | `"/cleanup/thumb/<itemId>"` 或 `null`。**是縮圖不是原圖**，而且那條端點一樣要 token |
| `why` | 它為什麼會出現在面板上（清理理由、「需要你查看」的原因、在隔離區……） |

- **內容只從兩份已經存在的資料來**：`file_texts.text`（掃描時抽好的）與既有的
  `GET /cleanup/thumb/:itemId`。**這條路不開任何檔案**，端點也只吃 `itemId`，不收路徑、不收查詢參數。
- **看得到的範圍＝面板本來就列得出來的那些**：清理候選、需要你查看、連拍組（留下的那張與成員）、
  隔離區裡的（可以復原的）、改名建議、歸檔建議。不在這些裡面 → 404 `NOT_FOUND`，
  訊息跟「這個 id 根本不存在」**一模一樣**（不讓呼叫端從狀態碼或訊息問出某個檔存不存在）。
- **不會現場觸發讀取**：還沒被讀過內容的檔 `text` 是 `null`，面板講「還沒讀到這個檔的內容」。
  讀取有 worker 與逾時，那是背景（掃描）的事。
- 抽好內容之後檔案又改過（`file_texts` 記的 size／mtime 跟現在對不上）也是 `null` ——
  寧可說還沒讀到，也不拿上一版的內容騙人。
- **不記「看過」**：預覽是唯讀的，一張表都不寫。
- 內容是**不可信的輸入**：控制字元與方向字元（U+202E…）換成「·」，**換行與 tab 留著**
  （內容本來就有行）。頁面那一端一律 `textContent`，不用任何會解析 HTML 的寫法。

## 改名（P3，三條都要 token）

**檔名是使用者的東西，而建議的名字是模型給的。** 所以：只提議、不自動改，每一次都有紀錄，
`undo` 改得回去。回應裡**只有檔名，沒有路徑**（資料夾只留在後端的 `renames` 表裡）。

### `GET /rename/suggestions`

```json
{ "items": [{ "itemId": "…", "name": "未命名文件 (3).txt", "suggested": "作業系統_死結.txt",
              "course": "作業系統", "topic": "死結", "confidence": "高",
              "evidence": "作業系統 第 6 章 死結 …", "seeded": false }] }
```

- 只列 `naming` 是 `untitled`／`generic` 的檔（`named` 是使用者自己取的名字，不碰）
- 模型信心「低」的不列（那通常是「看不出來」）
- `suggested` 是**洗過**的名字：去掉路徑分隔符號、控制字元與方向字元、前後的空白與點、
  Windows 保留名稱（CON、PRN⋯⋯），上限 80 個碼位，**副檔名一律沿用原本的**。洗完是空的就不列
- 狀態不能動的不列：`new`（十分鐘內還在變動）、在隔離區、在一份還沒套用的清理計畫裡、受保護的檔名
- `seeded` 是 demo 預先塞的示範答案，畫面要標示
- `?limit=` 是 1～1000，不合法回 400 `BAD_BODY`

### `POST /rename/apply`

`{ "items": [{ "itemId": "…", "to": "作業系統_死結" }] }` → `{ "results": […], "remaining": 0 }`

- **只接明確指名的**，沒有「全部」這種捷徑：沒帶 `items`、帶空陣列、帶 `null` 一律 400 `BAD_BODY`
- `to` 可以不給（用模型的建議）；給了也一樣走那一層清理
- 一次最多 100 個，多的不做，數字回在 `remaining`
- 逐項結果 `{ itemId, ok, from, to, why, id }`。一個檔失敗不影響其他檔，整個請求仍然 200
- 目標名字被佔走（**含只差大小寫**）→ 自動加 `-2`⋯`-99`，**不覆蓋任何檔**
- 唯讀模式 403 `READ_ONLY`；清理正在跑 503 `BUSY`（帶 `Retry-After`）

### `POST /rename/undo`

`{ "ids": ["…"] }` 或 `{ "last": true }` → `{ "results": […] }`

- `last` 是**最近那一次**（同一批 apply 一起回去）
- 逐項結果 `{ id, itemId, ok, to, restoredAs, why }`。原本的名字被別的檔佔走時，
  放回來的那一份會加序號，`restoredAs` 就是它真正的名字 —— **一定要講出來**，不然使用者找不到
- 找不到那幾筆 404 `NOT_FOUND`；兩個欄位都沒帶 400 `BAD_BODY`

## 歸檔（P4，三條都要 token）

**搬家比改名更容易讓人找不到檔**：改名還在同一個資料夾，搬家是換地方。所以：只提議、不自動搬，
每一次都有紀錄，`undo` 搬得回原本的資料夾。回應裡**只有檔名與相對於「整理好的」資料夾的那一段**
（`課程/作業系統/講義`），絕對路徑只留在後端的 `filings` 表（`from_dir`／`to_dir`）。

### `GET /file/suggestions`

```json
{ "items": [{ "itemId": "…", "name": "未命名文件 (3).txt", "course": "作業系統", "kind": "筆記",
              "topic": "死結", "confidence": "高", "evidence": "作業系統 第 6 章 死結 …",
              "seeded": false, "toFolder": "課程/作業系統/筆記" }] }
```

- 只列模型看得出是哪一堂課的檔：信心「低」的不列、`course` 是「看不出來」的不列
- **`naming` 不看**：已經有名字的檔照樣要歸類（取好名字跟歸不歸得了類是兩回事）
- `toFolder` 是 `課程/<課名>/<類型>`，**相對於設定檔的 `filed`**。類型是模型的 `kind`
  （講義／作業／考試／筆記／程式／報告／表單／對話／其他），認不得的一律進「其他」；
  主題不進路徑（太細會變成一堆只有一個檔的資料夾）
- 課名**過跟改名同一層清理**，上限 40 個碼位；洗完是空的就不列。
  已經有那個資料夾（含只差空白、全形、大小寫的）就照既有的寫法回
- 狀態不能動的不列：`new`（十分鐘內還在變動）、在隔離區、在一份還沒套用的清理計畫裡、
  受保護的檔名、**已經在 `filed` 底下的**
- `?limit=` 是 1～1000，不合法回 400 `BAD_BODY`
- 沒設定 `filed` → 500 `BAD_CONFIG`（不猜一個位置去搬使用者的檔）

### `POST /file/apply`

`{ "items": [{ "itemId": "…", "course": "作業系統", "kind": "筆記" }] }` → `{ "results": […], "remaining": 0 }`

- **只接明確指名的**，沒有「全部」這種捷徑：沒帶 `items`、帶空陣列、帶 `null` 一律 400 `BAD_BODY`
- `course`／`kind` 可以不給（用模型的看法）；給了也一樣走那一層清理
- 一次最多 100 個，多的不做，數字回在 `remaining`
- 逐項結果 `{ itemId, ok, name, toFolder, to, why, id }`。一個檔失敗不影響其他檔，整個請求仍然 200
- 目標資料夾已經有同名的（**含只差大小寫**）→ 自動加 `-2`⋯`-99`，**不覆蓋任何檔**；
  真正落地的名字在 `to`
- 目標資料夾會現建（`mkdir -p`），**只在 `filed` 底下**，而且整條路徑拒捷徑（不通過就這一項失敗）
- `filed` 在另一顆碟 → 那一項 `ok: false`，`why` 講原因（`CROSS_DEVICE`），其他項照做
- 唯讀模式 403 `READ_ONLY`；清理正在跑 503 `BUSY`（帶 `Retry-After`）

### `POST /file/undo`

`{ "ids": ["…"] }` 或 `{ "last": true }` → `{ "results": […] }`

- `last` 是**最近那一次**（同一批 apply 一起回去）
- 逐項結果 `{ id, itemId, ok, name, restoredAs, why }`。原本的位置已經有同名的檔時，
  放回來的那一份會加序號，`restoredAs` 就是它真正的名字 —— **一定要講出來**，不然使用者找不到
- 搬回**原本的資料夾**，就算那個資料夾不在 `cleanup.roots` 裡（那是它原本的家）。
  資料夾不見了才要在放回範圍內建回來；範圍外不建，逐項結果講原因
- 找不到那幾筆 404 `NOT_FOUND`；兩個欄位都沒帶 400 `BAD_BODY`

## 它學到的事（P5，兩條都要 token）

**只從你真的做過的動作學**：`POST /rename/apply`／`POST /file/apply` 帶的參數，以及那兩條的 `undo`。
不從掃描、不從模型、不從猜測學。學到的**只是偏好，不是權限** —— 課名照樣過 `cleanCourse`、
檔名照樣過同一層清理、路徑照樣過 `checkedPath`。**學習永遠不會自己動檔案**，它只改建議。

回應裡**沒有路徑、沒有檔名、沒有檔案內容**：後端那張表只存「模型說 A、你改成 B」這種對應與計數。
（退過貨的那一種在資料庫裡記的是「哪一個建議」，改名的摘要就是建議過的檔名 ——
所以那一種**一個字都不回給畫面**，要忘掉它用 `id` 就夠了。）

### `GET /learned`

```json
{ "items": [{ "id": "…", "kind": "course", "from": "作業系統", "to": "OS",
              "times": 2, "at": "2026-09-20T01:00:00.000Z", "about": "" }],
  "evicted": { "count": 0, "at": null } }
```

- `kind` 是三種之一：
  - `course` —— 這一堂課你怎麼稱呼它。`from` 是模型講的課名（折過：全形、空白、大小寫都折掉），
    `to` 是你要的寫法
  - `file_kind` —— **這一堂課的**這一種東西你叫它什麼。`from` 是「課名／模型的類型」，
    `to` 是你要的類型。**不是全域的**：作業系統的東西都改成「講義」，不會把資料結構一起帶歪
  - `rejected` —— 你退過的那一個建議。`from` 與 `to` 都是空字串，**不回 itemId**。
    「是哪一個建議」在 `about`：歸檔那一種是 `課程/<課名>/<類型>`（沒有檔名，講得出來），
    **改名那一種是空字串** —— 那個摘要是真的檔名，而這一條 route 不回檔名
- `times` 是同一個鍵被改過幾次。**照單全收不算**（那不是新資訊，記了只會灌水）
- `evicted` 是「記太多、被丟掉幾條」。上限 500 條，滿了丟掉最舊、最少用的（`times` 小、`at` 舊的先走）。
  丟掉不是安靜的：這個數字就是紀錄
- 什麼都沒學過回 `{ "items": [], "evicted": { "count": 0, "at": null } }`，不是 404
- **資料表不見了（舊的資料庫、被人砍掉）也回 200 的空清單** —— 當成「什麼都沒學過」，不是 500

### `DELETE /learned`

`{ "ids": ["…"] }` 或 `{ "all": true }` → `{ "forgotten": 2 }`

- **沒帶任何欄位不可以被當成「全部忘掉」**：`{}`、`{ "ids": [] }`、`{ "all": false }` 一律
  400 `BAD_BODY`，一條都不會少。拼錯的欄位（`IDs`）也是 400
- `ids` 與 `all` 一起送 → 400（講清楚是哪幾條，還是全部）
- `ids` 裡不存在的 id 不算錯，`forgotten` 就是真的刪掉幾條
- `all: true` 連「丟掉過幾條」那筆紀錄一起清 —— 使用者要的是回到什麼都沒學過
- 唯讀模式 403 `READ_ONLY`：忘掉一條偏好也是寫，跟收尾、`apply` 同一條規矩
- 一次最多 1000 個 id

### 建議那兩條多出來的欄位

`GET /rename/suggestions` 與 `GET /file/suggestions` 的每一項多兩個：

| 欄位 | 意思 |
|---|---|
| `learned` | 這一項套用了你以前改過的寫法。改名是「課名那一段」換掉了，歸檔是課名或類型換掉了 |
| `rejectedBefore` | 你上次把這個建議退回去了。**照樣列**，但畫面與 CLI 都**不預設勾**；指名它還是做得到 |

歸檔那一條另外多兩個（畫面需要，才不會把使用者的話說成模型講的）：

| 欄位 | 意思 |
|---|---|
| `modelCourse` | **模型自己說的課名**（洗過）。跟 `course` 不一樣時，`course` 是你上次改的寫法。畫面上「模型認為：⋯⋯」要用這一個 |
| `alsoKnownAs` | 學到新寫法之前，這堂課在磁碟上的資料夾叫什麼；沒有就是空字串。**那個資料夾不會被搬動或改名**（只搬不刪的延伸），新的檔進新資料夾，清單上要講這一句 |

`POST /rename/apply` 的 `to`、`POST /file/apply` 的 `course`／`kind` 不給的時候，
用的是**套過偏好之後的建議**（跟 `suggestions` 回的一樣），不是模型的原話。
給了而且跟建議不一樣 → 那一下會被記住（成功搬動／改名之後才記）。
`undo` 成功 → 那個建議記成「退過貨」；同一個建議重新做一次成功 → 那個標記消失。
