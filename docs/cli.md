# CLI 指令

**D 的交付。** 這是**介面契約**，不是說明書 —— 先定死長什麼樣，實作與右鍵選單、每晚 smoke 才對得上。
2026-09-19 照稽核 RC13 的行為改寫（上一版寫了幾個實作沒有的東西，也漏了幾個實作有的）。

---

## 全部指令

```bash
node cli.mjs doctor                          # 現在什麼狀況：設定檔、資料庫、清理資料夾、隔離區各在哪
node cli.mjs pet                             # 啟動 server 與清理監看，印出帶鑰匙（?k=）的網址
node cli.mjs open                            # 用瀏覽器打開寵物與清理面板（網址帶好鑰匙）

node cli.mjs cleanup scan                    # 手動掃一次清理資料夾（預設只有 Downloads）
node cli.mjs cleanup list                    # 看清理候選
node cli.mjs cleanup apply                   # 用清單上打 ✔ 的建一份計畫並套用
node cli.mjs cleanup apply --skip <編號>,…   #   同上，但跳過這幾個 ✔ 的
node cli.mjs cleanup apply --also <編號>,…   #   同上，另外加上這幾個 ☐ 的
node cli.mjs cleanup apply <plan-id>         # 套用（或重送）某一份計畫
node cli.mjs cleanup undo [plan-id]          # 復原；不給 id ＝ 最近一份還能復原的
node cli.mjs cleanup release <plan-id>       # 放棄一份還沒開始的計畫，檔案不動
node cli.mjs cleanup quarantine              # 看隔離區
node cli.mjs cleanup quarantine --empty      # 預覽清空（要滿七天），印出確認用的 token
node cli.mjs cleanup quarantine --empty --yes <token>   # 真的清空預覽裡的那些

node cli.mjs watch                           # 常駐監看（截圖功能，既有）
```

`cleanup dismiss` **還沒有**：印「這個指令還沒有」，離開碼 1。

**編號**是 `cleanup list` 每一列最前面方括號裡的 4 碼（例如 `[e2dc]`）。
`--skip`／`--also` 收逗號分隔的多個編號；有任何一個對不上清單上的列 → 離開碼 1，一個都不搬。

### 清理範圍

清理只看設定檔的 `cleanup.roots`，**預設只有 Downloads**（Windows 先看 OneDrive 的那一個）。
`watch` 是截圖功能的監看資料夾，跟清理無關 —— macOS 的 `watch` 預設含桌面，清理絕對不可以跟著它走（稽核 RC15）。
`cleanup.screenshots: true` 才會把截圖資料夾加進清理範圍。

### 環境變數

| 變數 | 用途 |
|---|---|
| `CONTEXTBOX_CONFIG` | 設定檔路徑（預設 `~/.contextbox/config.json`） |
| `CONTEXTBOX_DB` | 資料庫路徑（預設 `~/.contextbox/data.db`） |
| `CONTEXTBOX_QUARANTINE` | 隔離區路徑（預設 `~/.contextbox/quarantine`） |
| `CONTEXTBOX_TOKEN_PATH` | 鑰匙檔路徑（預設 `~/.contextbox/token`） |
| `CONTEXTBOX_READONLY=1` | 唯讀模式：只說會做什麼，不建計畫、不搬、不刪 |

`test/smoke-cleanup.md` 用這幾個把整份 smoke 關在沙盒裡；測試 spawn CLI 時也一定要給假的 `HOME`。

---

## 離開碼是契約

**右鍵選單與腳本靠離開碼判斷成敗**，畫面上印 ✓ 卻回非零，Windows 會跳錯誤視窗。

| 碼 | 意思 |
|---|---|
| 0 | 成功，**包含「沒有東西要清」** |
| 1 | 使用者輸入錯（沒有這個 plan、參數看不懂） |
| 2 | 後端錯（資料庫打不開、另一個清理動作正在跑、有計畫卡著） |
| 3 | **有檔案沒搬成功**（含一個都沒成功） |

判準：**2 ＝ 這個動作根本沒執行；3 ＝ 執行了但沒有全部成功。**
呼叫端據此決定要不要自動重試 —— 2 通常重試會過，3 要人去看那幾個檔。

逐一對照：

| 情況 | 離開碼 |
|---|---|
| 全部成功；沒有東西要清（Downloads 很乾淨）；唯讀試跑 | 0 |
| `cleanup apply <已經套用過的計畫>`：冪等，印同樣的結果，不會搬第二次 | 0 |
| `cleanup apply <已經復原過的計畫>`：印「這份已經復原過了」，**不印一排 ✘** | 0 |
| 預設清理超過 1000 個檔：這次先清 1000 個，講清楚「剩下 N 個下次再清」 | 0 |
| 沒有這個 plan id（**唯讀模式的 `apply <不存在的 id>` 也是**） | 1 |
| `--skip`／`--also` 的編號對不上；參數看不懂；不認得的子指令 | 1 |
| `cleanup undo` 不給 id，但沒有任何還能復原的計畫 | 1 |
| `quarantine --empty --yes` 沒給 token、或 token 不對 | 1 |
| `cleanup dismiss`（還沒有這個指令） | 1 |
| 另一個清理動作正在跑；資料庫打不開 | 2 |
| 勾的檔被一份還沒套用的計畫佔著（見下面「卡住的計畫」） | 2 |
| 有檔案沒搬成（`failed`），或搬到一半中斷（`unknown`） | 3 |

---

## 畫面長什麼樣

### `cleanup list`

```
有 7 個可以清掉的東西，大概 126 B

  [4d1d] ✔ smoke-report.pdf
             34 B  duplicate  Downloads
         · 同內容的重複檔案（同一個 sha256 還有 1 份檔案存在，會留著「smoke-report (1).pdf」）

  [e2dc] ✔ smoke-assets.zip
             19 B  archive  Downloads
         · 舊壓縮檔通常是一次性下載（.zip 壓縮檔，而且 60 天沒有變動）

  [c136] ☐ smoke-old.bin
             22 B  old-download  Downloads
         · 很久沒有動過的下載檔（200 天沒有變動，且副檔名 .bin 不在保護清單）

☐ 的預設不清。cleanup apply 會清掉打勾的 5 個。
  要多清 ☐ 的：cleanup apply --also c136
  要跳過 ✔ 的：cleanup apply --skip e2dc

另外 1 個需要你自己看一眼：
  備份.tar　65 KB　—— 檔案太大，這個工具不處理，要不要留請自己決定。
```

- **每一列都要有 reason 與 evidence。** 沒有原因就不該出現在清單裡（spec §6）。
- 頁尾「會清掉打勾的 N 個」用後端的 `defaultCheckedCount`，是**全部**打勾的，不是畫面上列出來的那幾個。
- 受保護的檔（`.ini`、`.lnk`、`.pem`…）與太大、算不出指紋的檔**不會**是候選；太大的列在「需要你自己看一眼」。
- 檔名裡的控制字元與換行一律換成「·」再印 —— 檔名是不可信的輸入，不可以讓它偽造一行畫面（稽核 RC14）。

### `cleanup apply`

```
計畫 56b024f0-9138-4fec-a37c-af7269b2edfe
  ✔ smoke-report.pdf　34 B
  ✔ smoke-assets.zip　19 B
  ✘ 素材包.zip　19 B　—— 這個檔案十分鐘內還在變動，先不搬。等一下再試一次。

搬進隔離區 2 個，53 B。
後悔的話：node cli.mjs cleanup undo 56b024f0-9138-4fec-a37c-af7269b2edfe

⚠ 上面 ✘ 的沒搬成。原檔都還在原位，沒有任何東西被刪除。
```

逐項結果**照後端的 `outcome` 全部種類印**，不自己推算：

| `outcome` | 印成 |
|---|---|
| `moved` | `✔ 檔名` |
| `skipped` | `－ 檔名`（你略過了） |
| `failed` | `✘ 檔名 —— 原因` |
| `restored` | `↩ 檔名`，註明「已經放回」 |
| `purged` | 檔名，註明「已清空」 |
| `pending` | 檔名，註明「還沒做」 |
| `cancelled` | 檔名，註明「已放棄」 |
| `unknown` | 檔名，註明「狀態不明」與原因（搬到一半中斷，檔案可能已經在隔離區） |

- 有 ✘ 或「狀態不明」的時候**離開碼是 3**，已經搬成功的**仍然可以 undo**。
- 「原檔都還在原位」**只在每一個沒成功的都是 `failed` 時才說**。有 `unknown` 的話不可以這樣說 ——
  檔案可能已經在隔離區，改成請使用者再跑一次 `cleanup apply <plan-id>` 把它接完（稽核 RC17）。
- 一個都沒搬成的時候不印任何 ✔、不給復原指令。
- 預設清理一次最多 1000 個檔，超過的這次先不收，最後一行講「剩下 N 個下次再清」，離開碼 0。
- 唯讀模式（`CONTEXTBOX_READONLY=1`）：印「唯讀模式：會清掉 N 個檔案」與清單，**不建計畫、不搬**，離開碼 0。

### `cleanup undo`

```
放回 Downloads 2 個檔案。
  ↩ smoke-report.pdf
  ↩ 素材包.zip　→ 原位置已經有同名檔案，放回來的這份叫 素材包.zip.restored（沒有覆蓋任何檔案）
```

- 只列**真的放回去**的；數字跟 ↩ 的行數一定對得上。
- 有沒放回來的（隔離區的檔被改過、已經清空…），另外列「沒放回：檔名 —— 原因」，離開碼 3。
  訊息分三種：全部放回、部分放回、一個都沒放回 —— **一個都沒放回時不可以說「都放回來了」**（稽核 RC9）。
- **不要講「之後不會再被提議」。** 原位置被佔時放回來的那份改名成 `.restored`，重掃後會以重複檔的身分被預設勾起來。
- 不給 id：復原最近一份還能復原（隔離區裡還有它的檔）的計畫。一份都沒有 → 離開碼 1。

### 卡住的計畫

建計畫時勾的檔被一份**還沒套用**的計畫佔著（只有 `proposed` 的計畫會佔住檔案；套用過的不會），印出那一份，給兩條路：

```
這個檔案已有待處理的清理計畫。

那份計畫是 5c1e…。
  接著清：node cli.mjs cleanup apply 5c1e…
  不清了：node cli.mjs cleanup release 5c1e…
```

「不清了」是 **`release`**（放棄那份計畫，檔案不動），**不是 `undo`** —— 對一份已經搬過的計畫按 undo
會把檔案放回去。離開碼 2。

### `cleanup quarantine --empty`

```
這些檔案已隔離七天。再次確認後會永久刪除，無法復原。
會永久刪除 1 個檔案，25 B。
確定的話跑：node cli.mjs cleanup quarantine --empty --yes c3544f10-4440-4112-b17a-86955bcbd879
```

- 沒有滿七天的：印「還沒有滿七天的檔案。最早的那個還要等 N 天。」，離開碼 0。
- **二次確認要人真的再打一次。** 這是整個專案唯一會刪檔的路徑。
- 帶 `--yes <token>` 的那一次**不再產生新的預覽**，直接確認那一個 token。
  沒給 token、token 不對或過期（五分鐘）→ 離開碼 1，什麼都不刪。

### `doctor`（在既有的輸出上加的幾段）

```
設定檔    /home/alice/.contextbox/config.json
資料庫    /home/alice/.contextbox/data.db
清理資料夾
  ✓  /home/alice/Downloads
隔離區    /home/alice/.contextbox/quarantine
          12 個檔案，458 MB，最早的那個可以清空了
待清候選  6 個
```

### `pet` 與 `open`

`pet` 啟動 server（port 7391）與清理監看，印出**帶鑰匙**的網址 `http://127.0.0.1:7391/?k=…`。
不帶 `?k=` 的網址打開是 401（本機其他程式拿不到鑰匙，稽核 RC16）。已經有一個在跑的時候，
說「已經有一個 ContextBox 在跑了」，並印出同一個帶鑰匙的網址。

`open` 用預設瀏覽器打開那個帶鑰匙的網址。頁面載入後會把 `k` 從網址列拿掉。

---

## 給 A／B 的約定

**1. `--skip`／`--also` 收的是清單上印的編號，不是檔名。** 檔名會重複，編號不會；
編號對不上就整個不做（離開碼 1），不可以猜。

**2. `cleanup apply` 不給 plan-id 的話，行為是「用清單上打 ✔ 的建一個新計畫再套用」**，
不是「套用最近那個計畫」。要重送既有計畫請明確給 id ——
重送已套用的計畫是**冪等**的：印同樣的結果、離開碼 0，不會搬第二次（CLI 逾時後被腳本重試是正常的）。

**3. 計畫是一次性的。** 套用過的計畫（全部成功、部分失敗、全部失敗）不再佔住檔案；
失敗的那幾個下一次 `cleanup apply` 會收進新的計畫。重試 ＝ 新計畫。
